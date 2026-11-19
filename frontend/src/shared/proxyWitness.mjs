/**
 * Proxy-witness transactions for the Neo N3 Smart Account v4 stack.
 *
 * The proxy verification script (`PUSHDATA1 accountId; PUSH1 PACK PUSH<flags>;
 * CALL core.verify`) carries no secret: the witness has an empty invocation
 * script and nothing to sign. The chain accepts it only because the script
 * calls `core.verify(accountId)`, which in the Verification trigger requires
 * the whole transaction to be a single `executeUserOp` / `executeUserOps` call
 * on that core for that account (contracts/custom/SmartAccount.VerifyContext.cs,
 * F-1). The proxy witness therefore has exactly one safe construction and it
 * lives here, so the SDK, the relay route and the wallet frontend cannot each
 * grow their own:
 *
 * - the transaction script is one shaped v4 call — nothing else;
 * - every operation inside it is a 13-field envelope;
 * - the proxy signer's rule is exactly one Allow/CalledByContract(core);
 * - the proxy is never the fee payer.
 *
 * The v3 verify-scope target and the Or(core, target) witness rule are gone:
 * the operation's own 13-field target is the only authorized target, and it is
 * covered by the validator/built-in signature inside executeUserOp.
 *
 * The proxy address itself is never hashed here. It is derived by the caller —
 * from the core (`getProxyScriptHash`) or from the SDK codec — and passed in,
 * so this module has no crypto dependency and cannot disagree with the chain.
 *
 * Nothing on this path takes a signer, witness or rule from request metadata.
 */

import { encodeDynamicCall, hashValue } from './nativeSmartAccount.mjs';

const OPERATION_FIELDS = 13;
const ACCOUNT_ENTRYPOINTS = ['executeUserOp', 'executeUserOps'];
const FEE_PAYER_SCOPES = ['None', 'CalledByEntry', 'CustomContracts', 'Global'];
const MAX_CUSTOM_CONTRACTS = 16;
/** Custom kernel pushes CallFlags.All; the native kernel's address needs 5. */
const DEFAULT_CALL_FLAGS = 15;

function hash160(value, name) {
  const hex = String(value || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex) || /^0+$/.test(hex)) {
    throw new Error(`${name} must be a nonzero Hash160`);
  }
  return hex;
}

function reverse(hex) {
  const pairs = hex.match(/../g) || [];
  return pairs.reverse().join('');
}

/**
 * The fixed proxy verification script, byte-identical to the kernel's
 * GetProxyScriptHash preimage. Inputs use display byte order; `callFlags`
 * defaults to 15 (CallFlags.All, custom kernel) and the native kernel passes 5
 * (CallFlags.ReadOnly).
 */
function createProxyVerificationScript({ coreHash, accountId, callFlags = DEFAULT_CALL_FLAGS }) {
  if (!Number.isInteger(callFlags) || callFlags < -1 || callFlags > 16) {
    throw new Error('proxy call flags must be -1..16');
  }
  const flags = (callFlags + 16).toString(16).padStart(2, '0');
  return `0c14${reverse(hash160(accountId, 'accountId'))}11c0${flags}0c067665726966790c14${reverse(hash160(coreHash, 'coreHash'))}41627d5b52`;
}

/**
 * Prepare the second signer/witness of a single account-bound execution
 * transaction. `proxyHash` is the account address derived by the core or the
 * SDK codec (`accountAddress(accountId)`); it is required, never guessed.
 */
function createProxyWitness({
  coreHash,
  accountId,
  proxyHash,
  feePayer,
  expectedProxyHash,
  callFlags = DEFAULT_CALL_FLAGS,
}) {
  const core = hash160(coreHash, 'coreHash');
  const payer = hash160(feePayer, 'feePayer');
  const proxy = hash160(proxyHash, 'proxyHash');
  if (expectedProxyHash !== undefined && hash160(expectedProxyHash, 'expectedProxyHash') !== proxy) {
    throw new Error('Proxy script hash differs from the core');
  }
  if (payer === proxy) throw new Error('Proxy cannot be the fee payer');
  const verificationScript = createProxyVerificationScript({ coreHash: core, accountId, callFlags });
  return {
    signer: {
      account: proxy,
      scopes: 'WitnessRules',
      rules: [{ action: 'Allow', condition: { type: 'CalledByContract', hash: core } }],
    },
    witness: { invocationScript: '', verificationScript },
  };
}

function operationFields(op, name) {
  const fields = ['Struct', 'Array'].includes(op?.type) ? op.value : null;
  if (!Array.isArray(fields) || fields.length !== OPERATION_FIELDS) {
    throw new Error(`${name} must be a ${OPERATION_FIELDS}-field user operation`);
  }
  return fields;
}

/**
 * The one application call the proxy witness may authorize:
 * core.executeUserOp(accountId, op) or core.executeUserOps(accountId, ops),
 * exactly two arguments, nothing else in the script. Any other entrypoint, a
 * second call, another core or another account is refused here rather than
 * left for the node's verifier to reject.
 */
function buildExecuteUserOpScript({ coreHash, accountId, invocation, callFlags = DEFAULT_CALL_FLAGS }) {
  const core = hash160(coreHash, 'coreHash');
  const account = hash160(accountId, 'accountId');
  if (!invocation || typeof invocation !== 'object') throw new Error('invocation required');
  const operation = String(invocation.operation || '');
  if (!ACCOUNT_ENTRYPOINTS.includes(operation)) {
    throw new Error(`proxy witness requires an executeUserOp or executeUserOps invocation, not ${operation || 'nothing'}`);
  }
  if (hash160(invocation.scriptHash, 'invocation.scriptHash') !== core) {
    throw new Error('invocation names a different core');
  }
  const args = invocation.args;
  if (!Array.isArray(args) || args.length !== 2) throw new Error(`${operation} takes exactly two arguments`);
  // The v4 codec carries a hash as a ByteString of the stored byte order; the
  // display-hex Hash160 spelling of v3 is accepted for comparison only, and the
  // script is always emitted from the canonical value, so a witness can never
  // authorize a script that differs from the one the client sends.
  const accountArgument = hashValue(account);
  if (!namesAccount(args[0], accountArgument)) {
    throw new Error(`${operation} does not name this account`);
  }
  const batch = operation === 'executeUserOps';
  const ops = batch ? (args[1]?.type === 'Array' ? args[1].value : null) : [args[1]];
  if (!Array.isArray(ops) || ops.length === 0) throw new Error(`${operation} requires at least one user operation`);
  ops.forEach((op, index) => operationFields(op, `user operation ${index}`));
  return encodeDynamicCall(
    core,
    operation,
    [accountArgument, batch ? { type: 'Array', value: ops } : ops[0]],
    callFlags,
  );
}

/** True when an invocation argument is this account, in either spelling. */
function namesAccount(argument, canonical) {
  if (!argument || typeof argument !== 'object') return false;
  try {
    // A ByteString argument already carries the stored byte order; the v3
    // display-hex Hash160 spelling is reversed into it for comparison only.
    if (argument.type === 'ByteString') return String(argument.value).toLowerCase() === canonical.value;
    if (argument.type === 'Hash160') return hashValue(hash160(argument.value, 'accountId argument')).value === canonical.value;
  } catch {
    return false;
  }
  return false;
}

function feePayerSigner({ feePayer, feePayerScope, feePayerAllowedContracts }) {
  const payer = hash160(feePayer, 'feePayer');
  const scope = String(feePayerScope ?? 'CalledByEntry');
  if (!FEE_PAYER_SCOPES.includes(scope)) {
    throw new Error(`fee payer scope ${scope} is not expressible for a proxy-witness transaction`);
  }
  if (scope !== 'CustomContracts') {
    if (feePayerAllowedContracts !== undefined && feePayerAllowedContracts.length) {
      throw new Error('fee payer allowlist is only meaningful with the CustomContracts scope');
    }
    return { account: payer, scopes: scope };
  }
  const allowed = Array.isArray(feePayerAllowedContracts) ? feePayerAllowedContracts : [];
  if (!allowed.length) throw new Error('CustomContracts scope requires a nonempty allowlist');
  if (allowed.length > MAX_CUSTOM_CONTRACTS) {
    throw new Error('CustomContracts allowlist exceeds the protocol limit');
  }
  return {
    account: payer,
    scopes: scope,
    allowedContracts: allowed.map((h) => hash160(h, 'allowed contract')),
  };
}

/**
 * The complete proxy-witness account transaction: the shape-bound
 * executeUserOp(s) script, the fee-paying signer, the restricted WitnessRules
 * proxy signer and the proxy verification witness.
 *
 * `proxyHash` must be the address the submitting core derives for `accountId`.
 * `expectedProxyHash`, when supplied, is that same value read from the core and
 * pins the witness to it.
 */
function buildProxyWitnessTransaction({
  coreHash,
  accountId,
  invocation,
  proxyHash,
  expectedProxyHash,
  feePayer,
  feePayerScope = 'CalledByEntry',
  feePayerAllowedContracts,
  callFlags = DEFAULT_CALL_FLAGS,
} = {}) {
  const core = hash160(coreHash, 'coreHash');
  const account = hash160(accountId, 'accountId');
  const script = buildExecuteUserOpScript({ coreHash: core, accountId: account, invocation, callFlags });
  const proxy = createProxyWitness({
    coreHash: core,
    accountId: account,
    proxyHash,
    feePayer,
    expectedProxyHash,
    callFlags,
  });
  const payerSigner = feePayerSigner({ feePayer, feePayerScope, feePayerAllowedContracts });
  return Object.freeze({
    script,
    operation: String(invocation.operation),
    coreHash: core,
    accountId: account,
    proxyHash: proxy.signer.account,
    proxySigner: proxy.signer,
    proxyWitness: proxy.witness,
    feePayerSigner: payerSigner,
    signers: Object.freeze([payerSigner, proxy.signer]),
    witness: proxy.witness,
  });
}

/**
 * The browser-wallet signing path. The wallet signs the complete transaction
 * (script, both signers, fees) as the fee payer; the proxy witness is attached
 * afterwards by the dApp, because a wallet invoke API cannot supply a
 * verification script it did not create. Wallets that will only accept a
 * custom scope are served here: the fee payer becomes CustomContracts with an
 * explicit allowlist, or Global, while the proxy keeps its restricted
 * WitnessRules.
 */
function buildProxyWalletSignRequest({ transaction, scope = 'CustomContracts', allowedContracts } = {}) {
  if (
    !transaction ||
    typeof transaction !== 'object' ||
    !Array.isArray(transaction.signers) ||
    transaction.signers.length !== 2
  ) {
    throw new Error('a built proxy-witness transaction is required');
  }
  const payerSigner = feePayerSigner({
    feePayer: transaction.signers[0].account,
    feePayerScope: scope,
    feePayerAllowedContracts: allowedContracts,
  });
  return Object.freeze({
    script: transaction.script,
    operation: transaction.operation,
    coreHash: transaction.coreHash,
    accountId: transaction.accountId,
    proxyHash: transaction.proxyHash,
    proxySigner: transaction.proxySigner,
    proxyWitness: transaction.proxyWitness,
    feePayerSigner: payerSigner,
    signers: Object.freeze([payerSigner, transaction.proxySigner]),
    witness: transaction.proxyWitness,
  });
}

/**
 * Build the transaction with the proxy address read from the core. `readState`
 * is the only source of the proxy address and must read the same core/RPC that
 * submits; it is injected so the relay, the wallet frontend and the local chain
 * fixture all resolve this authority through one entry point. A `proxyHash` may
 * be supplied by a caller that already derived it, in which case it must match
 * what the core answers or the transaction is refused.
 */
async function resolveProxyWitnessTransaction({
  coreHash,
  accountId,
  invocation,
  proxyHash,
  feePayer,
  readState,
  feePayerScope = 'CalledByEntry',
  feePayerAllowedContracts,
  callFlags = DEFAULT_CALL_FLAGS,
} = {}) {
  const core = hash160(coreHash, 'coreHash');
  const account = hash160(accountId, 'accountId');
  if (typeof readState !== 'function') throw new Error('a proxy-state reader is required');
  const state = await readState({ coreHash: core, accountId: account });
  const readProxyHash = state && state.proxyHash;
  return buildProxyWitnessTransaction({
    coreHash: core,
    accountId: account,
    invocation,
    proxyHash: proxyHash || readProxyHash,
    expectedProxyHash: readProxyHash,
    feePayer,
    feePayerScope,
    feePayerAllowedContracts,
    callFlags,
  });
}

export {
  DEFAULT_CALL_FLAGS,
  buildExecuteUserOpScript,
  buildProxyWalletSignRequest,
  buildProxyWitnessTransaction,
  createProxyVerificationScript,
  createProxyWitness,
  resolveProxyWitnessTransaction,
};
