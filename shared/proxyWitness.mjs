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
  const payer = hash160(feePayer, 'feePayer');
  const scope = requireScopeTarget(scopeTarget);
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

// ---------------------------------------------------------------------------------------
// CU-39: the proxy-witness transaction builder.
//
// The proxy verification witness is not a signature: anyone who knows the account id and the
// core can assemble it, and the node accepts it because the script calls core.verify(accountId).
// It therefore has exactly one safe construction, and it lives here so the SDK, the relay route
// and the wallet frontend cannot each grow their own. Nothing on this path takes a signer, a
// witness, a rule or a scope target from request metadata.
// ---------------------------------------------------------------------------------------

/** Thrown when the account has no verify-scope target: no proxy-witness transaction exists. */
const PROXY_SCOPE_TARGET_REQUIRED = 'Proxy scope target is not configured for this account';
const ACCOUNT_ENTRYPOINTS = ['executeUserOp', 'executeUserOps'];
const FEE_PAYER_SCOPES = ['None', 'CalledByEntry', 'CustomContracts', 'Global'];
const MAX_CUSTOM_CONTRACTS = 16;

function requireScopeTarget(scopeTarget) {
  const value = String(scopeTarget ?? '').replace(/^0x/i, '').toLowerCase();
  if (!value || !/^[0-9a-f]{40}$/.test(value) || /^0+$/.test(value)) {
    const error = new Error(PROXY_SCOPE_TARGET_REQUIRED);
    error.code = 'proxy_scope_target_required';
    throw error;
  }
  return value;
}

function le(value, size) {
  let n = BigInt(value);
  const bits = BigInt(size * 8);
  if (n >= 1n << bits || n < -(1n << (bits - 1n))) throw new Error('proxy script integer overflow');
  if (n < 0n) n += 1n << bits;
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out.toString('hex');
}

function signedInteger(value, name) {
  if (!['bigint', 'number', 'string'].includes(typeof value)) throw new Error(`${name} requires an exact integer`);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`${name} requires an exact integer`);
  if (typeof value === 'string' && !/^-?(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} requires an exact integer`);
  const n = BigInt(value);
  if (n < -(1n << 255n) || n >= 1n << 255n) throw new Error(`${name} outside the signed VM 256-bit range`);
  return n;
}

const PUSHINT_SIZES = [1, 2, 4, 8, 16, 32];

function signedBytes(value, name) {
  const n = signedInteger(value, name);
  if (n === 0n) return '';
  for (const size of PUSHINT_SIZES) {
    const limit = 1n << BigInt(size * 8 - 1);
    if (n >= -limit && n < limit) return le(n, size);
  }
  throw new Error(`${name} is not encodable as a VM integer`);
}

// PUSHM1/PUSH0..PUSH16 cover -1..16 in one byte; every other value is PUSHINT8/16/32/64/128/256,
// whose opcode is the index of its width in PUSHINT_SIZES.
function pushInt(value, name) {
  const n = signedInteger(value, name);
  if (n >= -1n && n <= 16n) return le(n + 16n, 1);
  const body = signedBytes(n, name);
  return le(PUSHINT_SIZES.indexOf(body.length / 2), 1) + body;
}

function pushBytes(hex, name) {
  const bytes = String(hex ?? '').replace(/^0x/i, '').toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(bytes)) throw new Error(`${name} must be hex bytes`);
  const n = bytes.length / 2;
  if (n < 256) return `0c${le(n, 1)}${bytes}`;
  if (n < 65536) return `0d${le(n, 2)}${bytes}`;
  return `0e${le(n, 4)}${bytes}`;
}

function utf8Hex(text, name) {
  if (typeof text !== 'string') throw new Error(`${name} requires text`);
  return Buffer.from(text, 'utf8').toString('hex');
}

// Neo VM push encoding of one contract parameter. `Struct` and `Array` are the same wire value
// (both emit NEWARRAY), which is why the payload layer calls a struct an array.
function pushParameter(parameter, name = 'parameter') {
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) {
    throw new Error(`${name} must be a typed contract parameter`);
  }
  const { type, value } = parameter;
  switch (type) {
    case 'Null':
      return '0b';
    case 'Any':
      if (value !== null && value !== undefined) throw new Error(`${name} of type Any must be null`);
      return '0b';
    case 'Boolean':
      if (typeof value !== 'boolean') throw new Error(`${name} of type Boolean requires a boolean`);
      return value ? '08' : '09';
    case 'Integer':
      return pushInt(value, name);
    case 'String':
      return pushBytes(utf8Hex(value, name), name);
    case 'ByteArray':
      return pushBytes(value, name);
    case 'Hash160':
      return pushBytes(reverse(hash160(value, name)), name);
    case 'Array':
    case 'Struct': {
      if (!Array.isArray(value)) throw new Error(`${name} of type ${type} requires an array`);
      return [...value].reverse().map((item, index) => pushParameter(item, `${name}[${index}]`)).join('')
        + pushInt(value.length, `${name} length`) + 'c0';
    }
    default:
      throw new Error(`${name} type ${String(type)} is not expressible in a shape-bound executeUserOp script`);
  }
}

// System.Contract.Call with CallFlags.All (15): args, flags, method, contract, SYSCALL.
function dynamicCall(contract, method, args, flags = 15) {
  return pushParameter({ type: 'Array', value: args }, 'arguments')
    + pushInt(flags, 'call flags')
    + pushBytes(utf8Hex(method, 'method'), 'method')
    + pushBytes(reverse(hash160(contract, 'contract')), 'contract')
    + '41627d5b52';
}

function operationFields(op, name) {
  const fields = ['Struct', 'Array'].includes(op?.type) ? op.value : null;
  if (!Array.isArray(fields) || fields.length !== 6) throw new Error(`${name} must be a six-field user operation`);
  return fields;
}

/**
 * The one application call the proxy witness may authorize: core.executeUserOp(accountId, op) or
 * core.executeUserOps(accountId, ops), exactly two arguments, nothing else in the script.
 * Any other entrypoint, a second call, another core or another account is refused here rather than
 * left for the node's verifier to reject.
 */
function buildExecuteUserOpScript({ coreHash, accountId, invocation }) {
  const core = hash160(coreHash, 'coreHash');
  const account = hash160(accountId, 'accountId');
  if (!invocation || typeof invocation !== 'object') throw new Error('invocation required');
  const operation = String(invocation.operation || '');
  if (!ACCOUNT_ENTRYPOINTS.includes(operation)) {
    throw new Error(`proxy witness requires an executeUserOp or executeUserOps invocation, not ${operation || 'nothing'}`);
  }
  if (hash160(invocation.scriptHash, 'invocation.scriptHash') !== core) throw new Error('invocation names a different core');
  const args = invocation.args;
  if (!Array.isArray(args) || args.length !== 2) throw new Error('executeUserOp takes exactly two arguments');
  if (args[0]?.type !== 'Hash160' || hash160(args[0].value, 'accountId argument') !== account) {
    throw new Error('executeUserOp does not name this account');
  }
  const batch = operation === 'executeUserOps';
  const ops = batch ? (args[1]?.type === 'Array' ? args[1].value : null) : [args[1]];
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('executeUserOp requires at least one user operation');
  ops.forEach((op, index) => operationFields(op, `user operation ${index}`));
  return dynamicCall(core, operation, [
    { type: 'Hash160', value: account },
    batch ? { type: 'Array', value: ops } : ops[0],
  ]);
}

function feePayerSigner({ feePayer, feePayerScope, feePayerAllowedContracts }) {
  const payer = hash160(feePayer, 'feePayer');
  const scope = String(feePayerScope ?? 'CalledByEntry');
  if (!FEE_PAYER_SCOPES.includes(scope)) throw new Error(`fee payer scope ${scope} is not expressible for a proxy-witness transaction`);
  if (scope !== 'CustomContracts') {
    if (feePayerAllowedContracts !== undefined && feePayerAllowedContracts.length) {
      throw new Error('fee payer allowlist is only meaningful with the CustomContracts scope');
    }
    return { account: payer, scopes: scope };
  }
  const allowed = Array.isArray(feePayerAllowedContracts) ? feePayerAllowedContracts : [];
  if (!allowed.length) throw new Error('CustomContracts scope requires a nonempty allowlist');
  if (allowed.length > MAX_CUSTOM_CONTRACTS) throw new Error('CustomContracts allowlist exceeds the protocol limit');
  return { account: payer, scopes: scope, allowedContracts: allowed.map((h) => hash160(h, 'allowed contract')) };
}

/**
 * The complete proxy-witness account transaction: the shape-bound executeUserOp(s) script, the
 * fee-paying signer, the restricted WitnessRules proxy signer and the proxy verification witness.
 *
 * `scopeTarget` must be freshly read from the same core/RPC that will submit the transaction; this
 * builder refuses to proceed when the account has none. `expectedProxyHash`, also read from the
 * core, pins the derived proxy address to the core's own derivation.
 */
function buildProxyWitnessTransaction({
  coreHash,
  accountId,
  invocation,
  scopeTarget,
  expectedProxyHash,
  feePayer,
  feePayerScope = 'CalledByEntry',
  feePayerAllowedContracts,
} = {}) {
  const core = hash160(coreHash, 'coreHash');
  const account = hash160(accountId, 'accountId');
  const scope = requireScopeTarget(scopeTarget);
  if (scope === core) throw new Error('Proxy scope target cannot be the core contract');
  const script = buildExecuteUserOpScript({ coreHash: core, accountId: account, invocation });
  const batch = String(invocation.operation) === 'executeUserOps';
  const ops = batch ? invocation.args[1].value : [invocation.args[1]];
  const targets = new Set(ops.map((op, index) => {
    const fields = operationFields(op, `user operation ${index}`);
    if (fields[0]?.type !== 'Hash160') throw new Error(`user operation ${index} does not name a Hash160 target contract`);
    return hash160(fields[0].value, `user operation ${index} target`);
  }));
  if (targets.size !== 1) throw new Error('Proxy transfers in a batch must share the configured scope target');
  const [target] = targets;
  if (target !== scope) throw new Error('Proxy scope target does not match the transfer target');
  const proxy = createProxyWitness({
    coreHash: core, accountId: account, targetContract: target, scopeTarget: scope,
    feePayer, expectedProxyHash,
  });
  const payerSigner = feePayerSigner({ feePayer, feePayerScope, feePayerAllowedContracts });
  return Object.freeze({
    script,
    operation: String(invocation.operation),
    coreHash: core,
    accountId: account,
    scopeTarget: scope,
    targetContract: target,
    proxyHash: proxy.signer.account,
    proxySigner: proxy.signer,
    proxyWitness: proxy.witness,
    feePayerSigner: payerSigner,
    signers: Object.freeze([payerSigner, proxy.signer]),
    witness: proxy.witness,
  });
}

/**
 * The browser-wallet signing path. The wallet signs the complete transaction (script, both
 * signers, fees) as the fee payer; the proxy witness is attached afterwards by the dApp, because a
 * wallet invoke API cannot supply a verification script it did not create. Wallets that will only
 * accept a custom scope are served here: the fee payer becomes CustomContracts with an explicit
 * allowlist, or Global, while the proxy keeps its restricted WitnessRules.
 */
function buildProxyWalletSignRequest({ transaction, scope = 'CustomContracts', allowedContracts } = {}) {
  if (!transaction || typeof transaction !== 'object' || !Array.isArray(transaction.signers) || transaction.signers.length !== 2) {
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
    scopeTarget: transaction.scopeTarget,
    targetContract: transaction.targetContract,
    proxyHash: transaction.proxyHash,
    proxySigner: transaction.proxySigner,
    proxyWitness: transaction.proxyWitness,
    feePayerSigner: payerSigner,
    signers: Object.freeze([payerSigner, transaction.proxySigner]),
    witness: transaction.proxyWitness,
  });
}

/**
 * Build the transaction from the account's on-chain scope state. `readState` is the only source of
 * `scopeTarget` and `expectedProxyHash` and must read the same core/RPC that submits: neither value
 * may come from request metadata. It is injected so the relay, the wallet frontend and the local
 * chain fixture all resolve this authority through one entry point.
 */
async function resolveProxyWitnessTransaction({
  coreHash,
  accountId,
  invocation,
  feePayer,
  readState,
  feePayerScope = 'CalledByEntry',
  feePayerAllowedContracts,
} = {}) {
  const core = hash160(coreHash, 'coreHash');
  const account = hash160(accountId, 'accountId');
  if (typeof readState !== 'function') throw new Error('a scope-state reader is required');
  const state = await readState({ coreHash: core, accountId: account });
  return buildProxyWitnessTransaction({
    coreHash: core,
    accountId: account,
    invocation,
    scopeTarget: state && state.scopeTarget,
    expectedProxyHash: state && state.expectedProxyHash,
    feePayer,
    feePayerScope,
    feePayerAllowedContracts,
  });
}

export {
  PROXY_SCOPE_TARGET_REQUIRED,
  buildExecuteUserOpScript,
  buildProxyWalletSignRequest,
  buildProxyWitnessTransaction,
  createProxyVerificationScript,
  createProxyWitness,
  resolveProxyWitnessTransaction,
};
