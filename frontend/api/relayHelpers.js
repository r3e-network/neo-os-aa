import { normalizeRelayContractParameter } from '../src/shared/relayContractParameter.mjs';
import { sanitizeHex } from '../src/utils/hex.js';
import { ALLOWED_RELAY_META_OPERATIONS } from './relayOperations.generated.js';

// Re-exported so callers and tests keep one name for "what the relay may submit"; the value is
// owned by the generated module above.
export { ALLOWED_RELAY_META_OPERATIONS };

// The relay signs and pays for a meta invocation from the operator WIF, so it accepts only the
// execution surface the deployed Abstract Account core actually exports. The generated list is
// derived from contracts/build/UnifiedSmartWalletV3.manifest.json by
// scripts/generate-relay-operations.mjs; it is not hand-maintained, so it cannot name an entrypoint
// the deployment does not have. CU-203: it used to name `executeUnified` and
// `executeUnifiedByAddress`, which no deployed manifest and no contract source defines, so such a
// request passed this check and died later inside simulation behind an error that hid the cause.
const OPERATION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

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

/**
 * Why `sanitizeMetaInvocationForRelay` refused an invocation, or null when it did not refuse.
 * The relay reports this verbatim, so a request naming an operation the deployed core does not
 * export is refused for that reason instead of failing later in simulation.
 */
export function resolveRelayMetaInvocationRefusal(input = {}, { aaContractHash = '' } = {}) {
  if (sanitizeMetaInvocationForRelay(input, { aaContractHash })) return null;
  if (!isValidMetaInvocation(input)) {
    return 'invalid relay meta invocation: a 40-hex scriptHash, an operation and an args array are required';
  }

  const scriptHash = sanitizeHex(input.scriptHash || '');
  const allowedHash = sanitizeHex(aaContractHash || '');
  if (allowedHash && scriptHash !== allowedHash) {
    return 'scriptHash is not the configured Abstract Account contract';
  }

  const operation = String(input.operation || '').trim();
  if (!OPERATION_NAME_PATTERN.test(operation)) {
    return `unsupported relay operation name: ${operation.slice(0, 64)}`;
  }
  if (!ALLOWED_RELAY_META_OPERATIONS.includes(operation)) {
    return `unsupported relay operation: ${operation} is not in the deployed Abstract Account ABI`;
  }
  return 'relay meta invocation refused';
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
