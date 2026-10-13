import test from 'node:test';
import assert from 'node:assert/strict';

import { EC } from '../src/config/errorCodes.js';

// The policy module is the object under test. On the base it does not exist yet; the import is
// dynamic so each test below reports that as its own failure instead of taking the file down.
let scopes = null;
let scopeLoadError = null;
try {
  scopes = await import('../src/features/operations/walletSigningScope.js');
} catch (error) {
  scopeLoadError = error;
}

function loaded() {
  assert.ok(scopes, `walletSigningScope.js must load: ${scopeLoadError && scopeLoadError.message}`);
  return scopes;
}

const CORE = 'd2a4cff31913016155e38e474a2c06d08be276cf';
const TARGET = 'ef4073a0f2b305a38ec4050e4d3d28bc40ea63f5';
const VERIFIER = 'ab'.repeat(20);
const ZERO = '0'.repeat(40);

test('a verifier-checked owner is asked for the custom-contracts scope over exactly the contracts the transaction calls', () => {
  const { resolveWalletSigningScope, SIGNING_SCOPE_BITS } = loaded();
  const decision = resolveWalletSigningScope({
    verifierHash: VERIFIER,
    contractsCalled: [CORE, TARGET],
  });
  assert.equal(decision.verifierChecked, true);
  assert.equal(decision.scope, 'CustomContracts');
  assert.equal(decision.bits, SIGNING_SCOPE_BITS.CustomContracts);
  // Least privilege: exactly the contracts this transaction calls, nothing added.
  assert.deepEqual(decision.allowedContracts, [CORE, TARGET]);
});

test('Global is taken only when the caller asks for it by name', () => {
  const { resolveWalletSigningScope, SIGNING_SCOPE_BITS } = loaded();
  const byName = resolveWalletSigningScope({
    verifierHash: VERIFIER,
    requestedScope: 'Global',
    contractsCalled: [CORE, TARGET],
  });
  assert.equal(byName.scope, 'Global');
  assert.equal(byName.bits, SIGNING_SCOPE_BITS.Global);
  assert.equal(byName.allowedContracts, undefined);

  // The default for a verifier-checked owner is never the broadest scope a wallet can grant.
  const byDefault = resolveWalletSigningScope({
    verifierHash: VERIFIER,
    contractsCalled: [CORE, TARGET],
  });
  assert.notEqual(byDefault.scope, 'Global');
  assert.notEqual(byDefault.bits, SIGNING_SCOPE_BITS.Global);
});

test('a CalledByEntry request for a verifier-checked owner is refused', () => {
  const { resolveWalletSigningScope } = loaded();
  // The owner signature is checked inside the verifier, in a nested call, where a CalledByEntry
  // witness is refused. Asking for it would hand the user a transaction the node cannot accept.
  assert.throws(
    () => resolveWalletSigningScope({
      verifierHash: VERIFIER,
      requestedScope: 'CalledByEntry',
      contractsCalled: [CORE, TARGET],
    }),
    (error) => error.message === EC.walletScopeOwnerRequiresCustomScope,
  );
});

test('a custom-contracts allowlist that omits a called contract is refused', () => {
  const { resolveWalletSigningScope } = loaded();
  assert.throws(
    () => resolveWalletSigningScope({
      verifierHash: VERIFIER,
      requestedScope: 'CustomContracts',
      contractsCalled: [CORE, TARGET],
      allowedContracts: [CORE],
    }),
    (error) => {
      assert.equal(error.message, EC.walletScopeAllowlistIncomplete);
      assert.deepEqual(error.missingContracts, [TARGET]);
      return true;
    },
  );
});

test('an account with no verifier keeps the default CalledByEntry scope', () => {
  const { resolveWalletSigningScope, SIGNING_SCOPE_BITS } = loaded();
  for (const verifierHash of ['', ZERO, null, undefined]) {
    const decision = resolveWalletSigningScope({
      verifierHash,
      contractsCalled: [CORE, TARGET],
    });
    assert.equal(decision.verifierChecked, false);
    assert.equal(decision.scope, 'CalledByEntry');
    assert.equal(decision.bits, SIGNING_SCOPE_BITS.CalledByEntry);
    assert.equal(decision.allowedContracts, undefined);
  }
});

test('the allowlist is deduplicated and bounded by the protocol limit', () => {
  const { resolveWalletSigningScope, MAX_CUSTOM_CONTRACTS } = loaded();
  const duplicated = resolveWalletSigningScope({
    verifierHash: VERIFIER,
    requestedScope: 'CustomContracts',
    contractsCalled: [CORE, TARGET, CORE, TARGET],
  });
  assert.deepEqual(duplicated.allowedContracts, [CORE, TARGET]);

  const tooMany = Array.from({ length: MAX_CUSTOM_CONTRACTS + 1 }, (_, index) => index.toString(16).padStart(40, '0'));
  assert.throws(
    () => resolveWalletSigningScope({
      verifierHash: VERIFIER,
      requestedScope: 'CustomContracts',
      contractsCalled: tooMany,
    }),
    (error) => error.message === EC.walletScopeAllowlistTooLarge,
  );

  assert.throws(
    () => resolveWalletSigningScope({
      verifierHash: VERIFIER,
      requestedScope: 'CustomContracts',
      contractsCalled: [],
    }),
    (error) => error.message === EC.walletScopeAllowlistEmpty,
  );
});
