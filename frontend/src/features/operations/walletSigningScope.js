import { EC } from '../../config/errorCodes.js';

// ---------------------------------------------------------------------------------------
// Wallet signing scopes (CU-96).
//
// An account owner is *verifier-checked* when the core records a verifier for the account: the
// owner's signature is not checked by the entry script but inside that verifier contract, in a
// nested call. A nested call leaves a CalledByEntry witness, and the verifier therefore refuses it
// (assessed for the recovery verifier; the same nesting applies to every verifier-checked owner).
// Asking a wallet for CalledByEntry for such an owner hands the user a transaction the node cannot
// accept. The two scopes that survive the nesting are CustomContracts and Global.
//
// Global is the broadest witness a wallet can grant. Nothing in this module reaches for it on its
// own: it is returned only when the caller asks for it by name. The default for a verifier-checked
// owner is CustomContracts over exactly the contracts the transaction calls.
// ---------------------------------------------------------------------------------------

/** NEP-21 / Neo WitnessScope bit mask. These are the values a wallet is asked for, not the labels. */
export const SIGNING_SCOPE_BITS = Object.freeze({
  None: 0,
  CalledByEntry: 1,
  CustomContracts: 16,
  CustomGroups: 32,
  WitnessRules: 64,
  Global: 128,
});

/** Neo's protocol limit on a CustomContracts allowlist. */
export const MAX_CUSTOM_CONTRACTS = 16;

const ZERO_HASH = '0'.repeat(40);

function normalizeHash(value, name) {
  const hex = String(value ?? '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    const error = new Error(EC.addressValidationFailed);
    error.field = name;
    throw error;
  }
  return hex;
}

/**
 * A verifier-checked owner: the core holds a nonzero verifier for the account, so the owner's
 * signature is validated inside that contract rather than at the entry script.
 */
export function isVerifierCheckedOwner(verifierHash) {
  const hex = String(verifierHash ?? '').replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{40}$/.test(hex) && hex !== ZERO_HASH;
}

function scopeBits(scope, name) {
  const bits = SIGNING_SCOPE_BITS[scope];
  if (bits === undefined) {
    const error = new Error(EC.walletScopeUnsupported);
    error.scope = scope;
    error.field = name;
    throw error;
  }
  return bits;
}

function uniqueHashes(values, name) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const hex = normalizeHash(value, name);
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

function refusal(code, message, extra) {
  const error = new Error(code || message);
  error.code = code;
  Object.assign(error, extra || {});
  return error;
}

/**
 * Decide the scope a browser wallet is asked for.
 *
 * `contractsCalled` is every contract this transaction's script reaches: for an executeUserOp
 * account move that is the core and the operation's target, because the witness is evaluated at
 * both. `allowedContracts`, when given, must cover them; when omitted the allowlist is derived
 * from them and nothing else is granted.
 *
 * Returns `{ scope, bits, allowedContracts, verifierChecked }`. Throws a typed error whose message
 * is an `EC` code so the caller can translate it.
 */
export function resolveWalletSigningScope({
  verifierHash = '',
  requestedScope,
  contractsCalled = [],
  allowedContracts,
} = {}) {
  const verifierChecked = isVerifierCheckedOwner(verifierHash);
  const called = uniqueHashes(contractsCalled, 'contractsCalled');

  const scope = requestedScope === undefined || requestedScope === null || requestedScope === ''
    ? (verifierChecked ? 'CustomContracts' : 'CalledByEntry')
    : String(requestedScope);

  if (!Object.prototype.hasOwnProperty.call(SIGNING_SCOPE_BITS, scope)) {
    throw refusal(EC.walletScopeUnsupported, EC.walletScopeUnsupported, { scope });
  }

  // A nested verifier call cannot see a CalledByEntry witness. Refuse rather than build a
  // transaction the node will reject at verification.
  if (verifierChecked && scope === 'CalledByEntry') {
    throw refusal(
      EC.walletScopeOwnerRequiresCustomScope,
      EC.walletScopeOwnerRequiresCustomScope,
      { verifierHash: normalizeHash(verifierHash, 'verifierHash'), scope },
    );
  }

  if (scope === 'CustomContracts') {
    const granted = allowedContracts === undefined ? called : uniqueHashes(allowedContracts, 'allowedContracts');
    if (granted.length === 0) {
      throw refusal(EC.walletScopeAllowlistEmpty, EC.walletScopeAllowlistEmpty, { scope });
    }
    const grantedSet = new Set(granted);
    const missing = called.filter((hash) => !grantedSet.has(hash));
    if (missing.length) {
      throw refusal(EC.walletScopeAllowlistIncomplete, EC.walletScopeAllowlistIncomplete, {
        missingContracts: missing,
        allowedContracts: granted,
      });
    }
    if (granted.length > MAX_CUSTOM_CONTRACTS) {
      throw refusal(EC.walletScopeAllowlistTooLarge, EC.walletScopeAllowlistTooLarge, {
        limit: MAX_CUSTOM_CONTRACTS,
        count: granted.length,
      });
    }
    return Object.freeze({
      scope,
      bits: scopeBits(scope),
      allowedContracts: Object.freeze(granted),
      verifierChecked,
    });
  }

  if (scope !== 'Global' && allowedContracts !== undefined && (allowedContracts || []).length) {
    // An allowlist only means something under CustomContracts; carrying one elsewhere is a
    // caller's mistake that would silently widen or drop a restriction.
    throw refusal(EC.walletScopeUnsupported, EC.walletScopeUnsupported, {
      scope,
      reason: 'allowlist is only expressible with the CustomContracts scope',
    });
  }

  return Object.freeze({
    scope,
    bits: scopeBits(scope),
    allowedContracts: undefined,
    verifierChecked,
  });
}
