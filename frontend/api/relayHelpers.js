import { normalizeRelayContractParameter } from '../src/shared/relayContractParameter.mjs';
import { sanitizeHex } from '../src/utils/hex.js';

export const ALLOWED_RELAY_META_OPERATIONS = [
  'executeUnified',
  'executeUnifiedByAddress',
  'executeUserOp',
  'executeUserOps',
  'executeSponsoredUserOp',
  'executeSponsoredUserOps',
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function isValidMetaInvocation(input = {}) {
  return Boolean(
    input
    && typeof input === 'object'
    && sanitizeHex(input.scriptHash || '').length === 40
    && String(input.operation || '').trim()
    && Array.isArray(input.args)
  );
}

export function sanitizeMetaInvocationForRelay(input = {}, { aaContractHash = '' } = {}) {
  if (!isValidMetaInvocation(input)) return null;

  const scriptHash = sanitizeHex(input.scriptHash || '');
  const allowedHash = sanitizeHex(aaContractHash || '');
  const operation = String(input.operation || '').trim();

  if (allowedHash && scriptHash !== allowedHash) return null;
  if (!ALLOWED_RELAY_META_OPERATIONS.includes(operation)) return null;

  return {
    scriptHash,
    operation,
    args: asArray(input.args).map((item) => item && typeof item === 'object'
      ? JSON.parse(JSON.stringify(item))
      : item),
  };
}

export function normalizeRelayPayload(body = {}) {
  const rawTransaction = typeof body?.rawTransaction === 'string'
    ? body.rawTransaction
    : typeof body?.raw_transaction === 'string'
      ? body.raw_transaction
      : '';

  if (rawTransaction) {
    return {
      mode: 'raw',
      rawTransaction: sanitizeHex(rawTransaction),
    };
  }

  const metaInvocation = body?.metaInvocation || body?.meta_invocation || null;
  if (isValidMetaInvocation(metaInvocation)) {
    return {
      mode: 'meta',
      metaInvocation,
    };
  }

  return {
    mode: 'invalid',
    rawTransaction: '',
    metaInvocation: null,
  };
}

export function convertContractParamFromJson(param, { sc, u } = {}, depth = 0) {
  const normalized = normalizeRelayContractParameter(param, { depth });
  function convert(parameter) {
    switch (parameter.type) {
      case 'Hash160': return sc.ContractParam.hash160(parameter.value);
      case 'Hash256': return sc.ContractParam.hash256(parameter.value);
      case 'PublicKey': return sc.ContractParam.publicKey(parameter.value);
      case 'String': return sc.ContractParam.string(parameter.value);
      case 'Integer': return sc.ContractParam.integer(parameter.value);
      case 'ByteArray': return sc.ContractParam.byteArray(u.HexString.fromHex(parameter.value.slice(2), true));
      case 'Array': return sc.ContractParam.array(...parameter.value.map(convert));
      // Neo core CreateMap emits pairs in reverse order; Neon emits its list
      // forwards. Reverse a detached list so PACKMAP preserves RPC insertion order.
      case 'Map': return sc.ContractParam.map(...[...parameter.value].reverse().map((entry) => ({ key: convert(entry.key), value: convert(entry.value) })));
      case 'Any': return sc.ContractParam.any(null);
      case 'Boolean': return sc.ContractParam.boolean(parameter.value);
      default: throw new Error('Unsupported relay parameter');
    }
  }
  return convert(normalized);
}
