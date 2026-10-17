import { RUNTIME_CONFIG } from '../config/runtimeConfig.js';
import { EC } from '../config/errorCodes.js';
import { invokeReadFunction, getAddressFromScriptHash, getScriptHashFromAddress, reverseHex } from '../utils/neo.js';
import { sanitizeHex } from '../utils/hex.js';

export const MATRIX_SUFFIX = '.matrix';

function decodeBase64ToUtf8(value) {
  if (!value) return '';
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('utf8');
  return globalThis.atob ? globalThis.atob(value) : '';
}

export function isMatrixDomain(value = '') {
  return String(value || '').trim().toLowerCase().endsWith(MATRIX_SUFFIX);
}

export function normalizeMatrixDomain(value = '') {
  let normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (!normalized.endsWith(MATRIX_SUFFIX)) normalized += MATRIX_SUFFIX;
  return normalized;
}

async function invokeRead({ rpcUrl, scriptHash, operation, args = [], fetchImpl } = {}) {
  const result = await invokeReadFunction(rpcUrl, scriptHash, operation, args, fetchImpl);
  if (result?.state !== 'HALT') {
    const err = new Error(EC.rpcFault);
    err.rpcDetail = result?.exception || null;
    throw err;
  }
  return result;
}

export async function resolveMatrixDomain(domain, { rpcUrl = RUNTIME_CONFIG.rpcUrl, matrixContractHash = RUNTIME_CONFIG.matrixContractHash, fetchImpl } = {}) {
  const normalized = normalizeMatrixDomain(domain);
  if (!normalized) return '';
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+matrix$/.test(normalized)) {
    throw new Error(EC.matrixDomainInvalid);
  }
  if (!/^[0-9a-f]{40}$/.test(sanitizeHex(matrixContractHash))) {
    throw new Error(EC.contractNotFound);
  }
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(matrixContractHash),
    operation: 'resolve',
    args: [
      { type: 'String', value: normalized },
      { type: 'Integer', value: 16 },
    ],
    fetchImpl,
  });
  const item = result?.stack?.[0];
  if (item?.type !== 'ByteString' || !item.value) return '';
  const decoded = decodeBase64ToUtf8(item.value);
  if (!decoded || !decoded.startsWith('N') || decoded.length !== 34) return '';
  // An address-shaped TXT record is not sufficient evidence for a contract
  // target. Validate the Base58 checksum before passing it to an invocation.
  getScriptHashFromAddress(decoded);
  return decoded;
}

export function buildMatrixRegistrationInvocation(domain, ownerAddress, { matrixContractHash = RUNTIME_CONFIG.matrixContractHash } = {}) {
  const normalized = normalizeMatrixDomain(domain);
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+matrix$/.test(normalized)) throw new Error(EC.matrixDomainInvalid);
  if (!/^[0-9a-f]{40}$/.test(sanitizeHex(matrixContractHash))) throw new Error(EC.contractNotFound);
  return {
    scriptHash: sanitizeHex(matrixContractHash),
    operation: 'register',
    args: [
      { type: 'String', value: normalized },
      { type: 'Hash160', value: `0x${sanitizeHex(getScriptHashFromAddress(ownerAddress))}` },
    ],
  };
}
