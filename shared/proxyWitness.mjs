import { createHash } from 'node:crypto';

function hash160(value, name) {
  const hex = String(value || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex) || /^0+$/.test(hex)) throw new Error(`${name} must be a nonzero Hash160`);
  return hex;
}

function reverse(hex) { return Buffer.from(hex, 'hex').reverse().toString('hex'); }

/** Exact UnifiedSmartWallet.GetProxyScriptHash preimage. Inputs use display byte order. */
function createProxyVerificationScript({ coreHash, accountId }) {
  return `0c14${reverse(hash160(accountId, 'accountId'))}11c01f0c067665726966790c14${reverse(hash160(coreHash, 'coreHash'))}41627d5b52`;
}

/**
 * Prepare the second signer/witness of a single account-bound execute transaction.
 * The caller must read scopeTarget (and preferably expectedProxyHash) from the same
 * core/RPC being used to submit. This helper does not prove the UserOperation's
 * signature: the core validates it atomically before any target call. The separate
 * fee payer must sign the complete transaction after all signers have been added.
 */
function createProxyWitness({ coreHash, accountId, targetContract, scopeTarget, feePayer, expectedProxyHash }) {
  const core = hash160(coreHash, 'coreHash');
  const target = hash160(targetContract, 'targetContract');
  const scope = hash160(scopeTarget, 'scopeTarget');
  const payer = hash160(feePayer, 'feePayer');
  if (scope !== target || scope === core) throw new Error('Proxy scope target does not match the transfer target');
  const verificationScript = createProxyVerificationScript({ coreHash: core, accountId });
  const proxyHash = createHash('ripemd160').update(createHash('sha256').update(Buffer.from(verificationScript, 'hex')).digest()).digest().reverse().toString('hex');
  if (expectedProxyHash !== undefined && hash160(expectedProxyHash, 'expectedProxyHash') !== proxyHash) throw new Error('Proxy script hash differs from the core');
  if (payer === proxyHash) throw new Error('Proxy cannot be the fee payer');
  return {
    signer: { account: proxyHash, scopes: 'WitnessRules', rules: [{ action: 'Allow', condition: { type: 'Or', expressions: [
      { type: 'CalledByContract', hash: core }, { type: 'CalledByContract', hash: target },
    ] } }] },
    witness: { invocationScript: '', verificationScript },
  };
}

export { createProxyVerificationScript, createProxyWitness };
