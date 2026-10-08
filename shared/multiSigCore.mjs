import { decodeByteStringStackHex, decodeHash160Stack } from './metaTxCore.mjs';

export const MULTISIG_MAX_CHILDREN = 10;
const MAX_BUNDLE_BYTES = 65535;
const error = (message) => { throw new Error(`MultiSig: ${message}`); };
const hex = (value) => String(value || '').replace(/^0x/i, '').toLowerCase();
const copy = (value) => JSON.parse(JSON.stringify(value));
function hash160(value) {
  const normalized = hex(value);
  if (!/^[0-9a-f]{40}$/.test(normalized) || /^0+$/.test(normalized)) error('invalid contract/account hash');
  return normalized;
}
function unsigned(value) {
  if (!/^[0-9]+$/.test(String(value)) || BigInt(value) >= (1n << 256n)) error('invalid unsigned integer');
  return String(BigInt(value));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hashParam = (value) => ({ type: 'Hash160', value: `0x${hash160(value)}` });
const integerParam = (value) => ({ type: 'Integer', value: unsigned(value) });

function varInt(value) {
  if (value < 0xfd) return value.toString(16).padStart(2, '0');
  return `fd${(value & 255).toString(16).padStart(2, '0')}${(value >>> 8).toString(16).padStart(2, '0')}`;
}

/** Neo StdLib.Serialize Array of ByteString or Null slots. Empty hex is a real proof; null abstains. */
export function serializeMultiSigSignatures(signatures) {
  if (!Array.isArray(signatures) || signatures.length < 1 || signatures.length > MULTISIG_MAX_CHILDREN) error('expected 1 to 10 ordered signature slots');
  let result = `40${varInt(signatures.length)}`;
  for (const signature of signatures) {
    if (signature === null) { result += '00'; continue; }
    if (typeof signature !== 'string') error('signature slot must be hex or null');
    const bytes = hex(signature);
    if (!/^(?:[0-9a-f]{2})*$/.test(bytes) || bytes.length / 2 > MAX_BUNDLE_BYTES) error('invalid or oversized signature bytes');
    result += `28${varInt(bytes.length / 2)}${bytes}`;
    if (result.length / 2 > MAX_BUNDLE_BYTES) error('signature bundle exceeds 65535 bytes');
  }
  return result;
}

/** JSON-RPC ByteArray values are base64, while draft/SDK parameters carry hex. */
export function toMultiSigRpcParameter(parameter) {
  if (!parameter || typeof parameter !== 'object') error('invalid RPC parameter');
  if (parameter.type === 'Array' || parameter.type === 'Struct') {
    if (!Array.isArray(parameter.value)) error('invalid RPC array');
    return { type: 'Array', value: parameter.value.map(toMultiSigRpcParameter) };
  }
  if (parameter.type === 'ByteArray') {
    const bytes = hex(parameter.value);
    if (!/^(?:[0-9a-f]{2})*$/.test(bytes)) error('invalid RPC bytes');
    const binary = (bytes.match(/../g) || []).map((pair) => String.fromCharCode(parseInt(pair, 16))).join('');
    return { type: 'ByteArray', value: globalThis.btoa(binary) };
  }
  if (parameter.type === 'Map') return { type: 'Map', value: parameter.value.map((entry) => ({ key: toMultiSigRpcParameter(entry.key), value: toMultiSigRpcParameter(entry.value) })) };
  return copy(parameter);
}

function stackHead(result) {
  if (!result || result.state !== 'HALT' || !Array.isArray(result.stack) || result.stack.length !== 1) error(`RPC read failed: ${result?.exception || result?.state || 'malformed result'}`);
  return result.stack[0];
}
function bool(result) {
  const value = stackHead(result);
  return value?.type === 'Boolean' && value.value === true;
}
function configFromStack(item) {
  if (!['Array', 'Struct'].includes(item?.type) || !Array.isArray(item.value) || item.value.length !== 2) error('missing or malformed verifier config');
  const [children, threshold] = item.value;
  if (children?.type !== 'Array' || !Array.isArray(children.value) || children.value.length < 1 || children.value.length > MULTISIG_MAX_CHILDREN || threshold?.type !== 'Integer') error('malformed child config');
  return { verifiers: children.value.map((child) => hash160(decodeHash160Stack(child))), threshold: Number(threshold.value) };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Factory keeps ethers and transport dependencies inside the SDK/browser packages. */
export function createMultiSigTools({ digest, buildTypedData, compactSignature, verifyTypedData } = {}) {
  function normalizeContext(input) {
    const verifiers = input.verifiers?.map(hash160);
    const threshold = Number(input.threshold);
    const networkMagic = unsigned(input.networkMagic);
    if (BigInt(networkMagic) > 0xffffffffn) error('network magic exceeds uint32');
    const context = {
      version: 1, networkMagic, coreContractHash: hash160(input.coreContractHash), accountIdHash: hash160(input.accountIdHash),
      verifierHash: hash160(input.verifierHash), verifiers, threshold,
    };
    if (!Array.isArray(verifiers) || !verifiers.length || verifiers.length > MULTISIG_MAX_CHILDREN
      || !Number.isInteger(threshold) || threshold < 1 || threshold > verifiers.length) error('invalid child count/threshold');
    if (new Set(verifiers).size !== verifiers.length || verifiers.includes(context.verifierHash)) error('duplicate/self child verifier');
    const configDigest = digest(JSON.stringify(canonical(context)));
    if (input.configDigest && configDigest !== input.configDigest) error('pinned config was tampered');
    return { ...context, configDigest };
  }

  async function fetchMultiSigContext({ coreContractHash, accountIdHash, networkMagic, expectedVerifierHash, read }) {
    const core = hash160(coreContractHash), account = hash160(accountIdHash);
    if (typeof read !== 'function') error('RPC reader required');
    const verifierHash = hash160(decodeHash160Stack(stackHead(await read(core, 'getVerifier', [hashParam(account)]))));
    if (expectedVerifierHash && verifierHash !== hash160(expectedVerifierHash)) error('bound verifier changed');
    const authorizedCore = hash160(decodeHash160Stack(stackHead(await read(verifierHash, 'authorizedCore', []))));
    if (authorizedCore !== core) error('verifier authorized core mismatch');
    const config = configFromStack(stackHead(await read(verifierHash, 'getConfig', [hashParam(account)])));
    const context = normalizeContext({ coreContractHash: core, accountIdHash: account, networkMagic, verifierHash, ...config });
    for (const child of context.verifiers) {
      const childCore = hash160(decodeHash160Stack(stackHead(await read(child, 'authorizedCore', []))));
      if (childCore !== core) error('child authorized core mismatch');
    }
    return freeze(context);
  }

  function normalizeOperation(input, context) {
    if (!input || typeof input !== 'object') error('signed operation context required');
    const method = String(input.method || '');
    const args = input.args;
    const argsHashHex = hex(input.argsHashHex);
    if (!method || !Array.isArray(args) || !/^[0-9a-f]{64}$/.test(argsHashHex)) error('invalid operation method/arguments hash');
    const operation = {
      coreContractHash: context.coreContractHash, accountIdHash: context.accountIdHash, networkMagic: context.networkMagic,
      targetContract: hash160(input.targetContract), method, args: copy(args), argsHashHex,
      nonce: unsigned(input.nonce), deadline: unsigned(input.deadline), configDigest: context.configDigest,
    };
    for (const key of ['coreContractHash', 'accountIdHash', 'networkMagic', 'configDigest']) {
      if (input[key] !== undefined && String(input[key]) !== operation[key]) error(`operation ${key} mismatch`);
    }
    return operation;
  }

  async function prepareMultiSigOperation({ context: inputContext, operation, read }) {
    const context = normalizeContext(inputContext);
    const channel = unsigned(operation.channel ?? 0);
    if (BigInt(channel) >= (1n << 192n)) error('nonce channel exceeds uint192');
    const nonceItem = stackHead(await read(context.coreContractHash, 'getNonce', [hashParam(context.accountIdHash), integerParam(channel)]));
    if (nonceItem.type !== 'Integer' || BigInt(unsigned(nonceItem.value)) >= (1n << 64n)) error('invalid nonce sequence');
    const argsHashHex = decodeByteStringStackHex(stackHead(await read(context.coreContractHash, 'computeArgsHash', [{ type: 'Array', value: operation.args }])));
    const nonce = String((BigInt(channel) << 64n) | BigInt(nonceItem.value));
    return freeze(normalizeOperation({ ...operation, nonce, argsHashHex }, context));
  }

  function buildMultiSigChildTypedData({ context: inputContext, operation: inputOperation, childVerifierHash }) {
    const context = normalizeContext(inputContext), operation = normalizeOperation(inputOperation, context);
    const child = hash160(childVerifierHash);
    if (!context.verifiers.includes(child)) error('unknown child verifier');
    return buildTypedData({ ...operation, chainId: operation.networkMagic, verifyingContract: child });
  }

  async function fetchMultiSigChildPayload({ context: inputContext, operation: inputOperation, childVerifierHash, read }) {
    const context = normalizeContext(inputContext), operation = normalizeOperation(inputOperation, context), child = hash160(childVerifierHash);
    if (!context.verifiers.includes(child)) error('unknown child verifier');
    const payloadHex = decodeByteStringStackHex(stackHead(await read(child, 'getPayload', [hashParam(context.accountIdHash), hashParam(operation.targetContract),
      { type: 'String', value: operation.method }, { type: 'Array', value: operation.args }, integerParam(operation.nonce), integerParam(operation.deadline)])));
    if (!payloadHex || payloadHex.length / 2 > MAX_BUNDLE_BYTES) error('missing or oversized child signing payload');
    return { childVerifierHash: child, operation, payloadHex };
  }

  function buildMultiSigBundle({ context: inputContext, operation: inputOperation, childProofs }) {
    const context = normalizeContext(inputContext), operation = normalizeOperation(inputOperation, context);
    if (!Array.isArray(childProofs) || childProofs.length > MULTISIG_MAX_CHILDREN) error('invalid child proofs');
    const slots = context.verifiers.map(() => null), seen = new Set();
    for (const proof of childProofs) {
      const child = hash160(proof.childVerifierHash), index = context.verifiers.indexOf(child);
      if (index < 0 || seen.has(child)) error('unknown or duplicate child proof');
      seen.add(child);
      if (!proof.operation || ['coreContractHash', 'accountIdHash', 'networkMagic', 'configDigest'].some((key) => proof.operation[key] === undefined)) error('child signed operation context incomplete');
      if (!same(operation, normalizeOperation(proof.operation, context))) error('child signed operation mismatch');
      if (proof.kind === 'evm') {
        const expected = buildMultiSigChildTypedData({ context, operation, childVerifierHash: child });
        if (!same(proof.typedData, expected)) error('child typed data/verifier domain mismatch');
        const compact = compactSignature(proof.signatureFullHex);
        if (compact !== hex(proof.signatureHex)) error('child compact signature mismatch');
        const signer = verifyTypedData(expected.domain, expected.types, expected.message, proof.signatureFullHex);
        if (proof.signerAddress && hex(signer) !== hex(proof.signerAddress)) error('child signer mismatch');
      } else if (proof.kind !== 'opaque') {
        error('unsupported child proof kind; use explicit evm or opaque adapter');
      }
      if (typeof proof.signatureHex !== 'string') error('child signature missing');
      slots[index] = hex(proof.signatureHex);
    }
    if (seen.size < context.threshold) error('insufficient child proofs for threshold');
    const signatureHex = serializeMultiSigSignatures(slots);
    const invocation = { scriptHash: context.coreContractHash, operation: 'executeUserOp', args: [hashParam(context.accountIdHash), {
      type: 'Array', value: [hashParam(operation.targetContract), { type: 'String', value: operation.method },
        { type: 'Array', value: operation.args }, integerParam(operation.nonce), integerParam(operation.deadline), { type: 'ByteArray', value: `0x${signatureHex}` }],
    }] };
    return { signatureHex, invocation, context, operation, slots, chainValidated: false };
  }

  async function validateMultiSigBundle({ context, operation, childProofs, read, networkMagic }) {
    if (String(networkMagic) !== String(context.networkMagic)) error('network changed');
    const current = await fetchMultiSigContext({ ...context, networkMagic, expectedVerifierHash: context.verifierHash, read });
    if (current.configDigest !== context.configDigest) error('on-chain config drift');
    const prepared = await prepareMultiSigOperation({ context: current, operation: { ...operation, channel: String(BigInt(operation.nonce) >> 64n) }, read });
    if (!same(prepared, operation)) error('on-chain nonce or arguments hash drift');
    const bundle = buildMultiSigBundle({ context: current, operation, childProofs });
    // A simulation validates opaque child proofs too. It is not a reservation or a transaction receipt.
    if (!bool(await read(current.verifierHash, 'validateSignature', bundle.invocation.args))) error('on-chain child verification rejected bundle');
    const after = await fetchMultiSigContext({ ...current, networkMagic, expectedVerifierHash: current.verifierHash, read });
    if (after.configDigest !== current.configDigest) error('on-chain config drift during validation');
    return { ...bundle, chainValidated: true };
  }

  function buildMultiSigChildConfigurationInvocation({ context: inputContext, childVerifierHash, method, args }) {
    const context = normalizeContext(inputContext), child = hash160(childVerifierHash);
    if (!context.verifiers.includes(child)) error('unknown child verifier');
    if (!Array.isArray(args) || args[0]?.type !== 'Hash160' || hash160(args[0]?.value) !== context.accountIdHash) error('child configuration account mismatch');
    if (method === 'setPublicKey') {
      if (args.length !== 2 || args[1]?.type !== 'ByteArray' || !/^04[0-9a-f]{128}$/.test(hex(args[1].value))) error('invalid EVM child public key');
    } else if (method === 'setConfig') {
      if (args.length !== 3 || args[1]?.type !== 'Array' || !Array.isArray(args[1].value) || args[2]?.type !== 'Integer') error('invalid native child config');
      const signers = args[1].value.map((item) => item?.type === 'Hash160' ? hash160(item.value) : error('invalid native child signer'));
      const threshold = Number(unsigned(args[2].value));
      if (!signers.length || signers.length > MULTISIG_MAX_CHILDREN || new Set(signers).size !== signers.length || threshold < 1 || threshold > signers.length) error('invalid native child threshold/signers');
    } else error('unsupported child configuration method');
    return { scriptHash: context.coreContractHash, operation: 'callVerifierChild', args: [hashParam(context.accountIdHash), hashParam(child), { type: 'String', value: method }, { type: 'Array', value: copy(args) }] };
  }

  async function readMultiSigPendingConfiguration({ context: inputContext, read }) {
    const context = normalizeContext(inputContext), args = [hashParam(context.accountIdHash)];
    const module = decodeHash160Stack(stackHead(await read(context.coreContractHash, 'getPendingVerifierCallModule', args)));
    const callHash = decodeByteStringStackHex(stackHead(await read(context.coreContractHash, 'getPendingVerifierCallHash', args)));
    const time = stackHead(await read(context.coreContractHash, 'getPendingVerifierCallTime', args));
    if (time.type !== 'Integer') error('invalid pending configuration timestamp');
    return { moduleHash: module, callHash, initiatedAt: unsigned(time.value) };
  }

  return { fetchMultiSigContext, prepareMultiSigOperation, buildMultiSigChildTypedData, buildMultiSigBundle, fetchMultiSigChildPayload, validateMultiSigBundle, buildMultiSigChildConfigurationInvocation, readMultiSigPendingConfiguration };
}
