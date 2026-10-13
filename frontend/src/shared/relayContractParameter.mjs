// Relay DTOs carry ByteArray as hex; Neo RPC JSON carries base64. Keep the
// boundary explicit instead of using a permissive ContractParam.fromJson.
export const MAX_RELAY_PARAMETER_DEPTH = 8;
const TYPE_NAMES = { 0: 'Any', 16: 'Boolean', 17: 'Integer', 18: 'ByteArray', 19: 'String',
  20: 'Hash160', 21: 'Hash256', 22: 'PublicKey', 32: 'Array', 34: 'Map' };
const fail = (message) => { throw new Error(`Contract parameter: ${message}`); };
const isHex = (value) => typeof value === 'string' && /^(?:[0-9a-f]{2})*$/i.test(value);
const stripHex = (value) => typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : value;

// Neo maps compare VM primitives. All byte-like parameter types share the
// ByteString key domain; hashes enter the VM in little-endian display order.
function mapKeyIdentity(key) {
  if (key.type === 'Boolean' || key.type === 'Integer') return `${key.type}:${key.value}`;
  let bytes = key.value;
  if (key.type === 'String') bytes = Array.from(new TextEncoder().encode(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  else if (key.type === 'ByteArray') bytes = bytes.slice(2);
  else if (key.type === 'Hash160' || key.type === 'Hash256') bytes = bytes.match(/../g).reverse().join('');
  return `ByteString:${bytes}`;
}

function base64Hex(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('invalid canonical base64 bytes');
  const binary = globalThis.atob(value);
  if (globalThis.btoa(binary) !== value) fail('invalid canonical base64 bytes');
  return Array.from(binary, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

/**
 * Produce a detached, strictly typed relay DTO. byteEncoding='hex' preserves the
 * established relay convention. 'mixed' is the SDK input boundary: 0x hex or
 * unambiguous canonical RPC base64. Numeric Neon instances carry RPC JSON bytes.
 */
export function normalizeRelayContractParameter(parameter, { depth = 0, byteEncoding = 'hex', allowClasses = false } = {}) {
  if (depth > MAX_RELAY_PARAMETER_DEPTH) fail(`nesting exceeds maximum depth of ${MAX_RELAY_PARAMETER_DEPTH}`);
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) fail('typed contract parameter required');
  let { type, value } = parameter;
  let encoding = byteEncoding;
  if (typeof type === 'number' && allowClasses) {
    const exportJson = parameter.toJson ?? parameter.toJSON;
    if (Object.getPrototypeOf(parameter) === Object.prototype || typeof exportJson !== 'function' || !TYPE_NAMES[type]) fail('unsupported ContractParam instance');
    type = TYPE_NAMES[type];
    // Recurse into containers before export so cycles/deep instances are bounded.
    if (type !== 'Array' && type !== 'Map') {
      const exported = exportJson.call(parameter);
      if (exported?.type !== type) fail('ContractParam export type mismatch');
      value = exported.value;
      encoding = 'base64';
    }
  }
  const recurse = (item) => normalizeRelayContractParameter(item, { depth: depth + 1, byteEncoding, allowClasses });
  switch (type) {
    case 'Any':
      if (value !== null && value !== undefined) fail('Any only supports null');
      return { type, value: null };
    case 'Boolean':
      if (typeof value !== 'boolean') fail('Boolean requires a boolean');
      break;
    case 'Integer': {
      if (!(typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value)
        || typeof value === 'string' && /^-?[0-9]+$/.test(value))) fail('Integer requires an exact integer');
      const integer = BigInt(value);
      if (integer < -(1n << 255n) || integer >= (1n << 255n)) fail('Integer exceeds signed VM 256-bit range');
      value = integer.toString();
      break;
    }
    case 'String':
      if (typeof value !== 'string') fail('String requires text');
      break;
    case 'ByteArray': {
      if (typeof value !== 'string') fail('ByteArray requires encoded bytes');
      let hex;
      if (encoding === 'base64') hex = base64Hex(value);
      else if (encoding === 'hex' || /^0x/i.test(value) || value === '') {
        hex = stripHex(value);
        if (!isHex(hex)) fail('ByteArray requires even-length hex');
      } else {
        if (isHex(value)) fail('ambiguous ByteArray: prefix hex with 0x or pass a ContractParam instance');
        hex = base64Hex(value);
      }
      value = `0x${hex}`;
      break;
    }
    case 'Hash160':
    case 'Hash256':
    case 'PublicKey': {
      value = stripHex(value);
      const size = type === 'Hash160' ? 40 : type === 'Hash256' ? 64 : 66;
      if (!isHex(value) || value.length !== size || type === 'PublicKey' && !/^0[23]/.test(value)) fail(`invalid ${type}`);
      break;
    }
    case 'Struct':
    case 'Array':
      if (!Array.isArray(value)) fail('Array requires an array');
      return { type: 'Array', value: Array.from(value, recurse) };
    case 'Map': {
      const keys = new Set();
      if (!Array.isArray(value)) fail('Map requires ordered entries');
      return { type, value: Array.from(value, (entry) => {
        if (!entry || typeof entry !== 'object' || !('key' in entry) || !('value' in entry)) fail('invalid Map entry');
        const key = recurse(entry.key);
        if (['Any', 'Array', 'Map'].includes(key.type)) fail('Map keys require non-null primitive parameters');
        const identity = mapKeyIdentity(key);
        if (keys.has(identity)) fail('duplicate Map key');
        keys.add(identity);
        return { key, value: recurse(entry.value) };
      }) };
    }
    default:
      fail(`unsupported type ${String(type)}`);
  }
  return { type, value };
}
