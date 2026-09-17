import { Signature, SigningKey, TypedDataEncoder, keccak256 } from 'ethers';
import { EC } from '../../config/errorCodes.js';
import { sanitizeHex } from '../../utils/hex.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import {
  createMetaTxBuilders,
  decodeByteStringStackHex,
  decodeHash160Stack,
  decodeIntegerStack,
  decodeValidationPreviewStack,
} from '../../shared/metaTxCore.mjs';

// EIP-712 typed-data builders come from the shared core (single source of
// truth with the SDK, see shared/metaTxCore.mjs). The core carries the SDK's
// validation guards, so a missing nonce/deadline or a malformed args hash now
// throws instead of being silently embedded in the signed message. The shared
// decodeHash160Stack also reverses ByteString stack items to big-endian
// display hex, so fetchV3Verifier feeds the EIP-712 verifyingContract in the
// same convention the SDK and the verifier contracts use.
const { buildMetaTransactionTypedData, buildV3UserOperationTypedData } = createMetaTxBuilders({
  keccak256,
});

export {
  buildMetaTransactionTypedData,
  buildV3UserOperationTypedData,
  decodeByteStringStackHex,
  decodeHash160Stack,
  decodeIntegerStack,
  decodeValidationPreviewStack,
};

async function invokeRead({ rpcUrl, scriptHash, operation, args = [], fetchImpl } = {}) {
  const response = await fetchWithTimeout(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'invokefunction',
      params: [scriptHash, operation, args],
    }),
  }, { fetchImpl });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(EC.rpcRequestFailed);
    err.rpcDetail = text || `HTTP ${response.status}`;
    throw err;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_parseError) {
    const err = new Error(EC.rpcRequestFailed);
    err.rpcDetail = 'invalid JSON response';
    throw err;
  }

  if (payload.error) {
    const err = new Error(EC.rpcRequestFailed);
    err.rpcDetail = payload.error.message || null;
    throw err;
  }
  return payload.result;
}

export async function computeArgsHash({ rpcUrl, aaContractHash, args = [], fetchImpl } = {}) {
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(aaContractHash),
    operation: 'computeArgsHash',
    args: [{ type: 'Array', value: args }],
    fetchImpl,
  });

  if (result?.state === 'FAULT') {
    const err = new Error(EC.metaTxArgsHashFailed);
    err.rpcDetail = result.exception;
    throw err;
  }

  const decoded = decodeByteStringStackHex(result?.stack?.[0]);
  if (!decoded) {
    throw new Error(EC.metaTxArgsHashFailed);
  }
  return decoded;
}

export async function fetchV3Nonce({
  rpcUrl,
  aaContractHash,
  accountIdHash,
  channel = 0n,
  fetchImpl,
} = {}) {
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(aaContractHash),
    operation: 'getNonce',
    args: [
      { type: 'Hash160', value: `0x${sanitizeHex(accountIdHash)}` },
      { type: 'Integer', value: String(channel) },
    ],
    fetchImpl,
  });

  if (result?.state === 'FAULT') {
    const err = new Error(EC.metaTxNonceFailed);
    err.rpcDetail = result.exception;
    throw err;
  }

  return decodeIntegerStack(result?.stack?.[0]);
}

export async function fetchNonceForAddress({
  rpcUrl,
  aaContractHash,
  accountAddressScriptHash,
  evmSignerAddress,
  fetchImpl,
} = {}) {
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(aaContractHash),
    operation: 'getNonceForAccount',
    args: [
      { type: 'Hash160', value: `0x${sanitizeHex(accountAddressScriptHash)}` },
      { type: 'String', value: String(evmSignerAddress || '') },
    ],
    fetchImpl,
  });

  if (result?.state === 'FAULT') {
    const err = new Error(EC.metaTxNonceFailed);
    err.rpcDetail = result.exception;
    throw err;
  }

  return decodeIntegerStack(result?.stack?.[0]);
}

export async function fetchV3Verifier({
  rpcUrl,
  aaContractHash,
  accountIdHash,
  fetchImpl,
} = {}) {
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(aaContractHash),
    operation: 'getVerifier',
    args: [
      { type: 'Hash160', value: `0x${sanitizeHex(accountIdHash)}` },
    ],
    fetchImpl,
  });

  if (result?.state === 'FAULT') {
    const err = new Error(EC.metaTxVerifierFailed);
    err.rpcDetail = result.exception;
    throw err;
  }

  return decodeHash160Stack(result?.stack?.[0]);
}

export async function fetchV3ValidationPreview({
  rpcUrl,
  aaContractHash,
  accountIdHash,
  targetContract,
  method,
  args = [],
  nonce = 0n,
  deadline = 0,
  fetchImpl,
} = {}) {
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(aaContractHash),
    operation: 'previewUserOpValidation',
    args: [
      { type: 'Hash160', value: `0x${sanitizeHex(accountIdHash)}` },
      {
        type: 'Struct',
        value: [
          { type: 'Hash160', value: `0x${sanitizeHex(targetContract)}` },
          { type: 'String', value: String(method || '') },
          { type: 'Array', value: args },
          { type: 'Integer', value: String(nonce) },
          { type: 'Integer', value: String(deadline) },
          { type: 'ByteArray', value: '0x' },
        ],
      },
    ],
    fetchImpl,
  });

  if (result?.state === 'FAULT') {
    const err = new Error(EC.metaTxVerifierFailed);
    err.rpcDetail = result.exception;
    throw err;
  }

  return decodeValidationPreviewStack(result?.stack?.[0]);
}

export async function assertV3AccountExists({
  rpcUrl,
  aaContractHash,
  accountIdHash,
  fetchImpl,
} = {}) {
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(aaContractHash),
    operation: 'getBackupOwner',
    args: [
      { type: 'Hash160', value: `0x${sanitizeHex(accountIdHash)}` },
    ],
    fetchImpl,
  });

  if (result?.state === 'FAULT') {
    const err = new Error(EC.metaTxBackupOwnerFailed);
    err.rpcDetail = result.exception;
    throw err;
  }

  return decodeHash160Stack(result?.stack?.[0]);
}

export function buildExecuteUserOpInvocation({
  aaContractHash,
  accountIdHash,
  targetContract,
  method,
  methodArgs = [],
  nonce,
  deadline,
  signatureHex = '',
} = {}) {
  const normalizedContractHash = sanitizeHex(aaContractHash);
  const normalizedAccountIdHash = sanitizeHex(accountIdHash);
  const normalizedTargetContract = sanitizeHex(targetContract);
  const normalizedMethod = String(method || '').trim();
  if (!normalizedContractHash || !normalizedAccountIdHash || !normalizedTargetContract || !normalizedMethod) {
    return null;
  }
  return {
    scriptHash: normalizedContractHash,
    operation: 'executeUserOp',
    args: [
      { type: 'Hash160', value: `0x${normalizedAccountIdHash}` },
      {
        type: 'Struct',
        value: [
          { type: 'Hash160', value: `0x${normalizedTargetContract}` },
          { type: 'String', value: normalizedMethod },
          { type: 'Array', value: methodArgs },
          { type: 'Integer', value: String(nonce) },
          { type: 'Integer', value: String(deadline) },
          { type: 'ByteArray', value: `0x${sanitizeHex(signatureHex)}` },
        ],
      },
    ],
  };
}

export function buildExecuteUnifiedByAddressInvocation({
  aaContractHash,
  accountAddressScriptHash,
  evmPublicKeyHex = '',
  targetContract,
  method,
  methodArgs = [],
  argsHashHex = '',
  nonce = 0n,
  deadline = 0n,
  signatureHex = '',
} = {}) {
  return {
    scriptHash: sanitizeHex(aaContractHash),
    operation: 'executeUnifiedByAddress',
    args: [
      { type: 'Hash160', value: `0x${sanitizeHex(accountAddressScriptHash)}` },
      { type: 'Hash160', value: `0x${sanitizeHex(targetContract)}` },
      { type: 'String', value: String(method || '') },
      { type: 'Array', value: methodArgs },
      { type: 'Array', value: sanitizeHex(evmPublicKeyHex) ? [{ type: 'ByteArray', value: `0x${sanitizeHex(evmPublicKeyHex)}` }] : [] },
      { type: 'ByteArray', value: `0x${sanitizeHex(argsHashHex)}` },
      { type: 'Integer', value: String(nonce) },
      { type: 'Integer', value: String(deadline) },
      { type: 'Array', value: sanitizeHex(signatureHex) ? [{ type: 'ByteArray', value: `0x${sanitizeHex(signatureHex)}` }] : [] },
    ],
  };
}

export function toCompactEcdsaSignature(signature) {
  const parsed = Signature.from(signature);
  return `${sanitizeHex(parsed.r)}${sanitizeHex(parsed.s)}`;
}

export function recoverPublicKeyFromTypedDataSignature({ typedData, signature } = {}) {
  const digest = TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
  return SigningKey.recoverPublicKey(digest, signature);
}
