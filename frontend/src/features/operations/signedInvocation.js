/**
 * Draft signed-invocation selection for protocol v4.
 *
 * A signed v4 operation is an `executeUserOp(accountId, operation)` call whose
 * 13-field operation carries the signature in field 11. A draft may accumulate
 * several signed candidates; exactly one may be broadcast, so this module
 * resolves the candidate, refuses any second one, and re-derives every field a
 * signature record claims (domain, schema, account, core, target, method,
 * args hash, nonce, deadline, operation digest) instead of trusting it.
 */

import { Signature, verifyTypedData } from 'ethers';
import { sanitizeHex } from '../../utils/hex.js';
import { cloneImmutable } from './helpers.js';
import { buildUserOperationTypedData, toCanonicalOperationArgs } from './metaTx.js';

const NETWORK_MAGIC = { mainnet: '860833102', testnet: '894710606' };
const fail = (detail) => { throw new Error(`Draft signed invocation mismatch: ${detail}`); };
const networkName = (value) => String(value || '').trim().toLowerCase().replace(/^neo-n3-/, '');

/** Operation field indices (`docs/SA-MODULE-PROTOCOL.md` §4.1). */
const OP_VERSION = 0;
const OP_TARGET = 1;
const OP_METHOD = 2;
const OP_ARGS = 3;
const OP_NONCE = 4;
const OP_NONCE_SUBKEY = 5;
const OP_DEADLINE = 6;
const OP_VALIDATOR_ID = 7;
const OP_CREDENTIAL_GENERATION = 8;
const OP_AUTHORITY_EPOCH = 9;
const OP_CONFIGURATION_NONCE = 10;
const OP_SIGNATURE = 11;
const OP_HOOK_PROOFS = 12;
const OPERATION_FIELDS = 13;
const PROTOCOL_VERSION = 4;

// The deployed core execution surface (contracts/bin/public/SmartAccount.manifest.json), shared by
// this selector and by the client broadcast builder so the two cannot disagree about what the
// account core exports.
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

/** A v4 hash field is a ByteString of the stored (little-endian) bytes. */
function hashOf(item) {
  if (!item || typeof item.value !== 'string') fail('invalid hash field');
  const raw = sanitizeHex(item.value);
  if (raw.length !== 40) fail('invalid hash field length');
  return raw.match(/../g).reverse().join('');
}

function utf8Of(item) {
  if (!item || typeof item.value !== 'string') fail('invalid text field');
  const hex = sanitizeHex(item.value);
  const bytes = Uint8Array.from(hex.match(/../g) || [], (pair) => Number.parseInt(pair, 16));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads one v4 `executeUserOp` invocation. Returns null for any other entrypoint
 * so the caller can refuse it by name rather than by accident.
 */
function operationFields(invocation) {
  if (invocation?.operation !== 'executeUserOp') return null;
  const [account, operation] = invocation.args || [];
  const fields = ['Struct', 'Array'].includes(operation?.type) ? operation.value : null;
  if (!Array.isArray(invocation.args) || invocation.args.length !== 2 || account?.type !== 'ByteString'
    || !Array.isArray(fields) || fields.length !== OPERATION_FIELDS) fail('invalid executeUserOp layout');
  if (String(fields[OP_VERSION]?.value) !== String(PROTOCOL_VERSION)) fail('unsupported operation version');
  if (fields[OP_TARGET]?.type !== 'ByteString' || fields[OP_METHOD]?.type !== 'ByteString'
    || fields[OP_ARGS]?.type !== 'Array' || fields[OP_NONCE_SUBKEY]?.type !== 'ByteString'
    || fields[OP_SIGNATURE]?.type !== 'ByteString' || fields[OP_HOOK_PROOFS]?.type !== 'Array') {
    fail('invalid operation field types');
  }
  const result = {
    core: sanitizeHex(invocation.scriptHash),
    account: hashOf(account),
    target: hashOf(fields[OP_TARGET]),
    method: utf8Of(fields[OP_METHOD]),
    args: fields[OP_ARGS].value,
    nonce: String(fields[OP_NONCE].value),
    nonceSubkey: sanitizeHex(fields[OP_NONCE_SUBKEY].value),
    deadline: String(fields[OP_DEADLINE].value),
    validatorId: String(fields[OP_VALIDATOR_ID].value),
    credentialGeneration: String(fields[OP_CREDENTIAL_GENERATION].value),
    authorityEpoch: String(fields[OP_AUTHORITY_EPOCH].value),
    configurationNonce: String(fields[OP_CONFIGURATION_NONCE].value),
    signature: sanitizeHex(fields[OP_SIGNATURE].value),
    hookProofs: fields[OP_HOOK_PROOFS].value,
  };
  if (![result.core, result.account, result.target].every((value) => /^[0-9a-f]{40}$/.test(value))
    || typeof result.method !== 'string' || !result.method
    || !/^\d+$/.test(result.nonce) || !/^\d+$/.test(result.deadline)
    || !/^(?:[0-9a-f]{2})*$/.test(result.signature)) fail('invalid executeUserOp fields');
  return result;
}

function intent(invocation) {
  const fields = operationFields(invocation);
  if (fields) {
    return {
      core: fields.core,
      account: fields.account,
      target: fields.target,
      method: fields.method,
      args: fields.args,
      validatorId: fields.validatorId,
    };
  }
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
  if (metadata.validatorId != null && String(metadata.validatorId) !== fields.validatorId) fail('signature validator');
  const data = metadata.typedData;
  if (!data) return; // Non-EVM verifiers carry opaque proofs; on-chain verification remains authoritative.
  const message = data.message || {};
  const expected = buildUserOperationTypedData({
    chainId: data.domain?.chainId,
    verifyingContract: data.domain?.verifyingContract,
    accountId: fields.account,
    coreContractHash: fields.core,
    validatorId: fields.validatorId,
    targetContract: fields.target,
    method: fields.method,
    argsHashHex: message.argsHash,
    nonce: fields.nonce,
    deadline: fields.deadline,
    operationDigest: message.operationDigest,
  });
  if (!equal(data.domain, expected.domain) || !equal(data.types, expected.types)) fail('typed domain/schema');
  for (const [key, actual] of [['accountId', fields.account], ['coreContract', fields.core], ['targetContract', fields.target]]) {
    if (sanitizeHex(message[key]) !== actual) fail(`typed ${key}`);
  }
  for (const key of ['method', 'nonce', 'deadline']) {
    if (String(message[key]) !== fields[key]) fail(`typed ${key}`);
  }
  if (String(message.validatorId) !== fields.validatorId) fail('typed validator');
  if (expectedMagic && String(data.domain?.chainId) !== String(expectedMagic)) fail('typed network');
  if (metadata.verifierHash && sanitizeHex(metadata.verifierHash) !== sanitizeHex(data.domain?.verifyingContract)) fail('typed verifier');
  for (const digest of [metadata.operationDigest, record.payloadDigest].filter(Boolean)) {
    if (sanitizeHex(digest) !== sanitizeHex(message.operationDigest)) fail('typed operation digest');
  }
  for (const argsHash of [metadata.argsHashHex, message.argsHash].filter(Boolean)) {
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
 * Resolve ONE complete invocation. Signature records are not threshold children:
 * the draft format has no authenticated member ordering, so merging different
 * proofs would silently submit a different authorization.
 */
export function selectSignedInvocation({ transactionBody = {}, signatures = [], morpheusNetwork = '', networkMagic } = {}) {
  const expectedNetwork = networkName(morpheusNetwork || transactionBody.network);
  const stagedNetwork = networkName(transactionBody.network);
  if (stagedNetwork && expectedNetwork && stagedNetwork !== expectedNetwork) fail('draft network');
  const expectedMagic = networkMagic || NETWORK_MAGIC[expectedNetwork];
  // The staged intent is the operation body, not an unsigned envelope: v4 settings
  // (validator instance, generations, epochs) only exist once a route was read.
  const staged = transactionBody.operationBody;
  const anchors = [transactionBody.clientInvocation, transactionBody.v4Invocation].filter(Boolean);
  const candidates = [];
  for (const invocation of anchors) {
    const fields = operationFields(invocation);
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
    if (!isDeployedEntrypoint(invocation.operation)) fail('unsupported SA wrapper');
    const fields = operationFields(invocation);
    if (fields && !fields.signature) fail('signed UserOperation has no signature');
    const anchor = anchors.find((item) => item.operation === invocation.operation);
    if (anchors.length && !anchor) fail('wrapper operation');
    for (const item of anchors.filter((item) => item.operation === invocation.operation)) {
      if (!equal(intent(item), intent(invocation))) fail('staged account, target, or operation body');
    }
    if (fields && transactionBody.accountIdHash && sanitizeHex(transactionBody.accountIdHash) !== fields.account) fail('body account');
    // A signed envelope must be anchored to something the operator staged. A record that arrives on
    // its own would let a collaborator attach an operation the draft never showed.
    if (fields && !staged && !anchors.length) fail('staged operation anchor');
    if (fields && staged) {
      if (sanitizeHex(staged.targetContract) !== fields.target) fail('staged target');
      if (String(staged.method || '') !== fields.method) fail('staged method');
      // The operator approved builder-shaped arguments; the envelope carries the
      // canonical VM form of the same values.
      if (!equal(toCanonicalOperationArgs(staged.args || []), fields.args)) fail('staged arguments');
    }
    if (record) checkRecord(record, invocation, fields, expectedMagic, expectedNetwork);
    const clean = { scriptHash: invocation.scriptHash, operation: invocation.operation, args: invocation.args };
    if (selected && !equal({ ...selected, scriptHash: sanitizeHex(selected.scriptHash) }, { ...clean, scriptHash: sanitizeHex(clean.scriptHash) })) {
      throw new Error('Multiple signed invocations conflict; signature aggregation is unsupported for this draft. Create one validator-compatible proof before broadcasting.');
    }
    selected = clean;
  }
  return selected ? cloneImmutable(selected) : null;
}
