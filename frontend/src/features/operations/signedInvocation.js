import { Signature, verifyTypedData } from 'ethers';
import { sanitizeHex } from '../../utils/hex.js';
import { cloneImmutable } from './helpers.js';
import { buildV3UserOperationTypedData } from './metaTx.js';

const NETWORK_MAGIC = { mainnet: '860833102', testnet: '894710606' };
const fail = (detail) => { throw new Error(`Draft signed invocation mismatch: ${detail}`); };
const networkName = (value) => String(value || '').trim().toLowerCase().replace(/^neo-n3-/, '');

// The deployed V3 execution surface (contracts/build/UnifiedSmartWalletV3.manifest.json), shared by
// this selector and by the client broadcast builder so the two cannot disagree about what the
// account core exports. A V1/V2 wrapper is not in it: the client no longer builds one and no
// deployed contract exports the name.
export const DEPLOYED_ENTRYPOINTS = [
  'executeUserOp',
  'executeUserOps',
  'executeSponsoredUserOp',
  'executeSponsoredUserOps',
];

export function isDeployedEntrypoint(operation) {
  return DEPLOYED_ENTRYPOINTS.includes(operation);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  if (['Hash160', 'Hash256', 'ByteArray', 'PublicKey'].includes(value.type)) {
    return { type: value.type, value: sanitizeHex(value.value) };
  }
  if (value.type === 'Integer') return { type: 'Integer', value: String(BigInt(value.value)) };
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function v3Fields(invocation) {
  if (invocation?.operation !== 'executeUserOp') return null;
  const [account, operation] = invocation.args || [];
  const fields = operation?.value;
  if (!Array.isArray(invocation.args) || invocation.args.length !== 2 || account?.type !== 'Hash160'
    || !['Struct', 'Array'].includes(operation?.type) || !Array.isArray(fields) || fields.length !== 6
    || fields[0]?.type !== 'Hash160' || fields[1]?.type !== 'String' || fields[2]?.type !== 'Array'
    || fields[3]?.type !== 'Integer' || fields[4]?.type !== 'Integer' || fields[5]?.type !== 'ByteArray'
    || !Array.isArray(fields[2].value)) fail('invalid executeUserOp layout');
  const result = {
    core: sanitizeHex(invocation.scriptHash), account: sanitizeHex(account.value),
    target: sanitizeHex(fields[0].value), method: fields[1].value, args: fields[2].value,
    nonce: String(fields[3].value), deadline: String(fields[4].value), signature: sanitizeHex(fields[5].value),
  };
  if (![result.core, result.account, result.target].every((value) => /^[0-9a-f]{40}$/.test(value))
    || typeof result.method !== 'string' || !result.method
    || !/^\d+$/.test(result.nonce) || !/^\d+$/.test(result.deadline)
    || !/^(?:[0-9a-f]{2})*$/.test(result.signature)) fail('invalid executeUserOp fields');
  return result;
}

function intent(invocation) {
  const fields = v3Fields(invocation);
  if (fields) return { core: fields.core, account: fields.account, target: fields.target, method: fields.method, args: fields.args };
  // No V1/V2 decoder: a legacy envelope is refused by selectSignedInvocation's wrapper list, and
  // reading its call layout here would keep the dead entrypoint names in the client for no caller.
  return { scriptHash: sanitizeHex(invocation?.scriptHash), operation: invocation?.operation, args: invocation?.args };
}

function checkRecord(record, invocation, fields, expectedMagic, expectedNetwork) {
  const metadata = record?.metadata || {};
  if (metadata.network && expectedNetwork && networkName(metadata.network) !== expectedNetwork) fail('signature network');
  if (!fields) return;
  if (record.signatureHex && sanitizeHex(record.signatureHex) !== fields.signature) fail('signature bytes');
  for (const key of ['nonce', 'deadline']) {
    if (metadata[key] != null && String(metadata[key]) !== fields[key]) fail(`signature ${key}`);
  }
  const data = metadata.typedData;
  if (!data) return; // Non-EVM verifiers carry opaque proofs; on-chain verification remains authoritative.
  const message = data.message || {};
  const expected = buildV3UserOperationTypedData({ chainId: data.domain?.chainId, verifyingContract: data.domain?.verifyingContract,
    accountIdHash: fields.account, coreContractHash: fields.core, targetContract: fields.target, method: fields.method,
    argsHashHex: message.argsHash, nonce: fields.nonce, deadline: fields.deadline });
  if (!equal(data.domain, expected.domain) || !equal(data.types, expected.types)) fail('typed domain/schema');
  for (const [key, actual] of [['accountId', fields.account], ['coreContract', fields.core], ['targetContract', fields.target]]) {
    if (sanitizeHex(message[key]) !== actual) fail(`typed ${key}`);
  }
  for (const key of ['method', 'nonce', 'deadline']) {
    if (String(message[key]) !== fields[key]) fail(`typed ${key}`);
  }
  if (expectedMagic && String(data.domain?.chainId) !== String(expectedMagic)) fail('typed network');
  if (metadata.verifierHash && sanitizeHex(metadata.verifierHash) !== sanitizeHex(data.domain?.verifyingContract)) fail('typed verifier');
  for (const argsHash of [metadata.argsHashHex, record.payloadDigest].filter(Boolean)) {
    if (sanitizeHex(argsHash) !== sanitizeHex(message.argsHash)) fail('typed arguments hash');
  }
  if (metadata.signatureFullHex) {
    try {
      const signature = Signature.from(metadata.signatureFullHex);
      if (`${sanitizeHex(signature.r)}${sanitizeHex(signature.s)}` !== fields.signature) fail('full signature bytes');
      const recovered = verifyTypedData(data.domain, data.types, data.message, metadata.signatureFullHex);
      if (/^(0x)?[0-9a-f]{40}$/i.test(record.signerId || '') && sanitizeHex(recovered) !== sanitizeHex(record.signerId)) fail('EVM signer');
    } catch (error) {
      fail(`EVM signature verification (${error.message})`);
    }
  }
}

/**
 * Resolve ONE complete invocation. Signature records are not MultiSig children:
 * the draft format has no authenticated child ordering/encoding, so merging
 * different proofs would silently submit a different authorization.
 */
export function selectSignedInvocation({ transactionBody = {}, signatures = [], morpheusNetwork = '', networkMagic } = {}) {
  const expectedNetwork = networkName(morpheusNetwork || transactionBody.network);
  const stagedNetwork = networkName(transactionBody.network);
  if (stagedNetwork && expectedNetwork && stagedNetwork !== expectedNetwork) fail('draft network');
  const expectedMagic = networkMagic || NETWORK_MAGIC[expectedNetwork];
  const anchors = [transactionBody.v3Invocation, transactionBody.clientInvocation].filter(Boolean);
  const candidates = [];
  for (const invocation of anchors) {
    const fields = v3Fields(invocation);
    if (fields?.signature) candidates.push({ invocation });
  }
  for (const invocation of [transactionBody.metaInvocation, ...(transactionBody.metaInvocations || []), ...(transactionBody.meta_invocations || [])].filter(Boolean)) {
    candidates.push({ invocation });
  }
  for (const record of Array.isArray(signatures) ? signatures : []) {
    if (record?.metadata?.metaInvocation) candidates.push({ invocation: record.metadata.metaInvocation, record });
  }
  let selected = null;
  for (const { invocation, record } of candidates) {
    if (!invocation?.scriptHash || !invocation?.operation || !Array.isArray(invocation.args)) fail('invalid invocation');
    // An envelope the deployed core does not export is refused here; the client broadcast builder
    // applies the same predicate to whatever the selector returns.
    if (!isDeployedEntrypoint(invocation.operation)) fail('unsupported AA wrapper');
    const fields = v3Fields(invocation);
    if (fields && !fields.signature) fail('signed UserOperation has no signature');
    const anchor = anchors.find((item) => item.operation === invocation.operation);
    if (anchors.length && !anchor) fail('wrapper operation');
    for (const item of anchors.filter((item) => item.operation === invocation.operation)) {
      if (!equal(intent(item), intent(invocation))) fail('staged account, target, or operation body');
    }
    if (fields && transactionBody.accountIdHash && sanitizeHex(transactionBody.accountIdHash) !== fields.account) fail('body account');
    if (record) checkRecord(record, invocation, fields, expectedMagic, expectedNetwork);
    const clean = { scriptHash: invocation.scriptHash, operation: invocation.operation, args: invocation.args };
    if (selected && !equal({ ...selected, scriptHash: sanitizeHex(selected.scriptHash) }, { ...clean, scriptHash: sanitizeHex(clean.scriptHash) })) {
      throw new Error('Multiple signed invocations conflict; signature aggregation is unsupported for this draft. Create one verifier-compatible proof before broadcasting.');
    }
    selected = clean;
  }
  return selected ? cloneImmutable(selected) : null;
}
