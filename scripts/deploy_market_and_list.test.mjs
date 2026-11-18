import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// F-18 regression tests: the market deploy script must strictly reject vanity
// IDs that conflict with the current registration protocol (unless --derive-ids
// explicitly overrides them) and must register protocol-consistent parameters.

const require = createRequire(import.meta.url);
const {
  REGISTRATION_ESCAPE_TIMELOCK,
  validateVanityAccountRows,
  findVanityRegistrationIdConflicts,
  deriveRegistrationId,
  buildRegisterAccountArgs,
  parseArgs,
  setRegistrationIdDeriver,
} = require('./deploy_market_and_list.js');
const { SmartAccountClient } = require('../sdk/js/src/index');

// ── Vanity inventory rows ────────────────────────────────────────────────────

const ROW_ACCOUNT_ID = 'a1b2'.repeat(10);
const ROW_CORE = 'c3d4'.repeat(10);
const ROW_CORE_WIRE = ROW_CORE.match(/.{2}/g).reverse().join('');

function vanityRow(overrides = {}) {
  return {
    id: 7,
    pattern: 'MIRRORAB',
    account_id_hash: ROW_ACCOUNT_ID,
    verify_script: `0c14${ROW_ACCOUNT_ID}11c01f0c067665726966790c14${ROW_CORE_WIRE}41627d5b52`,
    ...overrides,
  };
}

test('only --derive-ids is accepted as the explicit vanity-ID override', () => {
  assert.deepEqual(parseArgs([]), { deriveIds: false });
  assert.deepEqual(parseArgs(['--derive-ids']), { deriveIds: true });
  assert.throws(() => parseArgs(['--force']), /Unknown arguments: --force/);
  assert.throws(() => parseArgs(['--derive-ids', '--silent']), /Unknown arguments/);
});

test('registration uses the protocol minimum escape timelock', () => {
  assert.equal(REGISTRATION_ESCAPE_TIMELOCK, 604800);
});

test('a structurally consistent vanity row validates clean against its core', () => {
  assert.deepEqual(validateVanityAccountRows([vanityRow()], { coreHash: `0x${ROW_CORE}` }), []);
});

test('structural inventory corruption is always refused, never overridden', () => {
  const unparseable = validateVanityAccountRows([vanityRow({ verify_script: 'deadbeef' })], { coreHash: ROW_CORE });
  assert.equal(unparseable.length, 1);
  assert.equal(unparseable[0].kind, 'unparseable-script');
  assert.equal(unparseable[0].id, 7);

  const storedIdMismatch = validateVanityAccountRows([vanityRow({ account_id_hash: 'ff'.repeat(20) })], { coreHash: ROW_CORE });
  assert.equal(storedIdMismatch[0].kind, 'stored-id-mismatch');

  const coreMismatch = validateVanityAccountRows([vanityRow()], { coreHash: '99'.repeat(20) });
  assert.equal(coreMismatch[0].kind, 'core-binding-mismatch');
  assert.match(coreMismatch[0].message, /binds SA core 0xc3d4/);
});

test('registration-ID conflicts are detected through the deriver seam', (t) => {
  setRegistrationIdDeriver(null);
  t.after(() => setRegistrationIdDeriver(null));

  // Without a configured deriver the derivation refuses rather than guessing.
  assert.throws(() => deriveRegistrationId({
    registrationMaterialHex: ROW_ACCOUNT_ID,
    backupOwnerScriptHash: 'ef'.repeat(20),
  }), /deriver not configured/);

  const seen = [];
  setRegistrationIdDeriver((options) => {
    seen.push(options);
    return 'ab'.repeat(20);
  });
  const rows = [{ id: 1, pattern: 'PFX', account_id_hash: 'cd'.repeat(20) }];
  const conflicts = findVanityRegistrationIdConflicts(rows, { backupOwnerScriptHash: 'ef'.repeat(20) });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'registration-id-conflict');
  assert.equal(conflicts[0].id, 1);
  assert.equal(conflicts[0].derivedId, 'ab'.repeat(20));
  assert.match(conflicts[0].message, /conflicts with the id the current protocol derives/);
  // The seam passes the exact registration parameters the script will send.
  assert.deepEqual(seen, [{
    verifierContractHash: '',
    verifierParamsHex: 'cd'.repeat(20),
    hookContractHash: '',
    backupOwnerAddress: 'ef'.repeat(20),
    escapeTimelock: REGISTRATION_ESCAPE_TIMELOCK,
  }]);

  // A stored id that already equals the protocol-derived id is not a conflict.
  setRegistrationIdDeriver((options) => options.verifierParamsHex);
  assert.deepEqual(
    findVanityRegistrationIdConflicts(rows, { backupOwnerScriptHash: 'ef'.repeat(20) }),
    [],
  );
});

test('buildRegisterAccountArgs mirrors the SDK createAccountPayload byte-for-byte', () => {
  const saClient = new SmartAccountClient('http://127.0.0.1:1', `0x${'ab'.repeat(20)}`);
  const material = 'a7c9'.repeat(5); // non-palindromic: locks the wire byte order too
  const backupOwner = 'ef'.repeat(20);

  const derivedId = saClient.deriveRegistrationAccountIdHash({
    verifierParamsHex: material,
    backupOwnerAddress: backupOwner,
    escapeTimelock: REGISTRATION_ESCAPE_TIMELOCK,
  });
  const scriptArgs = buildRegisterAccountArgs({
    derivedId,
    registrationMaterialHex: material,
    backupOwnerScriptHash: backupOwner,
  });
  const sdkPayload = saClient.createAccountPayload({
    verifierParamsHex: material,
    backupOwnerAddress: backupOwner,
    escapeTimelock: REGISTRATION_ESCAPE_TIMELOCK,
  });

  // What the script broadcasts is exactly what the SDK would register for the
  // same owner-witness (verifier-less) account: same account id, no verifier,
  // same per-row material, no hook, same backup owner, same timelock.
  assert.equal(sdkPayload.operation, 'registerAccount');
  assert.equal(scriptArgs.length, sdkPayload.args.length);
  for (let i = 0; i < scriptArgs.length; i += 1) {
    assert.equal(scriptArgs[i].type, sdkPayload.args[i].type, `arg #${i} ContractParam type`);
    assert.equal(String(scriptArgs[i].value), String(sdkPayload.args[i].value), `arg #${i} ContractParam value`);
  }
  assert.equal(String(scriptArgs[0].value), derivedId);
  assert.equal(String(scriptArgs[1].value), '0'.repeat(40));
  assert.equal(String(scriptArgs[4].value), backupOwner);
  assert.equal(String(scriptArgs[5].value), String(REGISTRATION_ESCAPE_TIMELOCK));
});
