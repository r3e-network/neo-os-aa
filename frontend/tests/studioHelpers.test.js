import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { decodeStackHash160, decodeStackHashArray, hash160Param, parseRecentTransactions } from '../src/features/studio/helpers.js';

const controllerPath = path.resolve('src/features/studio/useStudioController.js');
const manifestPath = path.resolve('../contracts/build/UnifiedSmartWalletV3.manifest.json');

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

test('every studio contract operation exists in the UnifiedSmartWalletV3 ABI', () => {
  const source = fs.readFileSync(controllerPath, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const abiMethods = new Set(manifest.abi.methods.map((method) => method.name));

  const operations = new Set();
  for (const match of source.matchAll(/invokeReadOperation\(\s*'([^']+)'/g)) {
    operations.add(match[1]);
  }
  for (const match of source.matchAll(/invokeOperation\(\s*'[^']*',\s*'([^']+)'/g)) {
    operations.add(match[1]);
  }

  assert.ok(operations.size >= 10, `expected studio operations to be discovered, got ${operations.size}`);
  for (const operation of operations) {
    assert.ok(
      abiMethods.has(operation),
      `studio operation '${operation}' is missing from the contract ABI (method lookup is case-sensitive)`,
    );
  }
  // Regression: the metadata save flow used the phantom 'SetMetadataUri'.
  assert.ok(operations.has('setMetadataUri'));
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
