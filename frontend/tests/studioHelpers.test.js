import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { decodeStackHash160, decodeStackHashArray, hash160Param, parseRecentTransactions } from '../src/features/studio/helpers.js';

const controllerPath = path.resolve('src/features/studio/useStudioController.js');
const governancePath = path.resolve('src/features/studio/governance.js');
const panelPath = path.resolve('src/features/studio/components/ManageGovernancePanel.vue');
const protocolPath = path.resolve('src/services/smartAccountProtocol.js');
// The current ABI is the v4 build. contracts/build holds the deployed v3
// artifacts and is a historical record, so it must never answer "what does the
// core export now?" — a missing build has to fail loudly instead.
const manifestPath = path.resolve('../contracts/bin/public/SmartAccount.manifest.json');

// Display form (big-endian) of a UInt160 and its node wire form: RPC result
// stacks return UInt160 values as ByteString of the internal little-endian
// bytes, i.e. the byte-reversed display hash, base64-encoded.
const DISPLAY_HASH = '49c095ce04d38642e39155f5481615c58227a498';
const LITTLE_ENDIAN_BASE64 = Buffer.from(DISPLAY_HASH, 'hex').reverse().toString('base64');

test('decodeStackHash160 reverses little-endian ByteString stack items to display form', () => {
  const decoded = decodeStackHash160({ type: 'ByteString', value: LITTLE_ENDIAN_BASE64 });

  assert.equal(decoded, DISPLAY_HASH);
});

test('decodeStackHash160 round-trips through hash160Param without flipping bytes', () => {
  const decoded = decodeStackHash160({ type: 'ByteString', value: LITTLE_ENDIAN_BASE64 });

  // The studio prefixes decoded hashes with 0x and feeds them back into the
  // update operations via hash160Param; the round-trip must be identity.
  assert.equal(hash160Param(`0x${decoded}`), DISPLAY_HASH);
});

test('decodeStackHash160 keeps Hash160-typed items and rejects empty values', () => {
  assert.equal(decodeStackHash160({ type: 'Hash160', value: `0x${DISPLAY_HASH}` }), DISPLAY_HASH);
  assert.equal(decodeStackHash160({ type: 'ByteString', value: '' }), '');
  assert.equal(decodeStackHash160(null), '');
});

test('decodeStackHashArray decodes each little-endian entry to display form', () => {
  const decoded = decodeStackHashArray({
    type: 'Array',
    value: [{ type: 'ByteString', value: LITTLE_ENDIAN_BASE64 }],
  });

  assert.deepEqual(decoded, [DISPLAY_HASH]);
});

test('every studio contract operation exists in the built v4 ABI', () => {
  assert.ok(
    fs.existsSync(manifestPath),
    `the v4 core ABI is missing at ${manifestPath}; run contracts/compile.sh before the frontend tests`,
  );
  const read = (file) => fs.readFileSync(file, 'utf8');
  const controller = read(controllerPath);
  const governance = read(governancePath);
  const protocol = read(protocolPath);
  const panel = read(panelPath);
  const source = [controller, governance, protocol, panel].join('\n');
  const abiMethods = new Set(JSON.parse(read(manifestPath)).abi.methods.map((method) => method.name));

  // Discover the operation names from the positions that actually reach the
  // chain: the protocol plan builders, the custody action literals and the
  // governance read literals.
  const operations = new Set();
  const collect = (text, pattern) => {
    for (const match of text.matchAll(pattern)) operations.add(match[1]);
  };
  collect(protocol, /return plan\('([^']+)'/g);
  collect(controller, /runCustodyAction\(\s*'([^']+)'/g);
  collect(controller, /planAccountAction\(\s*'([^']+)'/g);
  collect(governance, /readItem\('([^']+)'/g);

  assert.ok(operations.size >= 12, `expected studio operations to be discovered, got ${operations.size}`);
  for (const operation of operations) {
    assert.ok(
      abiMethods.has(operation),
      `studio operation '${operation}' is missing from the v4 ABI (method lookup is case-sensitive)`,
    );
  }

  // The v4 surface the studio claims, including the branches the regexes above
  // cannot see (a ternary picks freeze or unfreeze by account status).
  for (const operation of [
    'createAccount', 'proposeConfiguration', 'confirmConfiguration', 'cancelConfiguration',
    'executeUserOp', 'setMetadataUri', 'revokeCredentials',
    'freezeAccount', 'unfreezeAccount', 'beginRecovery', 'cancelRecovery', 'executeRecovery',
    'getAccount', 'getModules', 'getModule', 'getHookOrder',
    'getPendingConfiguration', 'getPendingConfigurationIntentIds', 'getRecoveryStatus',
  ]) {
    assert.ok(abiMethods.has(operation), `${operation} is not in the built v4 ABI`);
    assert.ok(source.includes(operation), `the studio never names ${operation}`);
  }

  // The v3 single-verifier and escape-era surface is gone from both sides. A
  // name only counts when the studio spells it as a method (a quoted literal or
  // a call), so prose and i18n keys that merely contain it do not match.
  const namesOperation = (name) => new RegExp(`["']${name}["']|\\b${name}\\(`).test(source);
  for (const retired of [
    'registerAccount', 'updateVerifier', 'confirmVerifierUpdate', 'updateHook',
    'confirmHookUpdate', 'initiateEscape', 'finalizeEscape',
    'getVerifier', 'getHook', 'getBackupOwner', 'getEscapeTimelock',
  ]) {
    assert.equal(abiMethods.has(retired), false, `${retired} must not exist in the v4 ABI`);
    assert.equal(namesOperation(retired), false, `the studio still calls the retired ${retired}`);
  }
});

test('the governance review dialog reads the v4 intent actions and the explicit recovery policy', () => {
  const source = fs.readFileSync(panelPath, 'utf8');
  // The dialog is built from the prepared configuration review, not from a
  // verifier/hook update payload.
  assert.match(source, /watch\(configurationReview/);
  assert.match(source, /review\.actions\.map/);
  assert.match(source, /review\.accountId/);
  assert.match(source, /submitConfiguration/);
  // Maturity and expiry are chain values the operator can see before signing.
  assert.match(source, /pendingIntent\.matureAt/);
  assert.match(source, /pendingIntent\.expiresAt/);
  // Recovery is a policy plus a lifecycle, and owner-only is an explicit ack.
  assert.match(source, /recoveryPolicyAuthority/);
  assert.match(source, /ownerOnlyAcknowledged/);
  assert.match(source, /executeRecovery/);
  assert.match(source, /revokeCredentials/);
  for (const retired of [
    'requestedTarget', 'newVerifier', 'recoveryMode', 'review.options.verifier',
    'review.options.module', 'submitCurrentGovernanceAction', 'prepareVerifierUpdate',
  ]) {
    assert.equal(source.includes(retired), false, `the panel still renders the retired ${retired}`);
  }
});

test('parseRecentTransactions defaults missing status to pending and preserves valid statuses', () => {
  const raw = JSON.stringify([
    { label: 'Confirmed op', txid: '0xaaa', when: '2026-06-17', status: 'confirmed' },
    { label: 'Failed op', txid: '0xbbb', when: '2026-06-17', status: 'failed', statusDetail: 'ASSERT' },
    { label: 'Legacy op', txid: '0xccc', when: '2026-06-17' },
    { label: 'Bogus status', txid: '0xddd', when: '2026-06-17', status: 'weird' },
  ]);
  const parsed = parseRecentTransactions(raw, []);

  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].status, 'confirmed');
  assert.equal(parsed[0].statusDetail, undefined);
  assert.equal(parsed[1].status, 'failed');
  assert.equal(parsed[1].statusDetail, 'ASSERT');
  // Legacy entries written before confirmation tracking default to pending.
  assert.equal(parsed[2].status, 'pending');
  // Unknown status strings are normalized to pending rather than trusted.
  assert.equal(parsed[3].status, 'pending');
});

test('parseRecentTransactions still drops entries without a txid', () => {
  const raw = JSON.stringify([{ label: 'no txid', when: '2026-06-17', status: 'confirmed' }]);
  assert.deepEqual(parseRecentTransactions(raw, []), []);
});
