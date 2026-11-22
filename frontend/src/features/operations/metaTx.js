/**
 * v4 operation plumbing for the wallet frontend.
 *
 * One v4 operation is a 13-field Array and the core — not the client — decides
 * what a signature covers: §4.3 binds the operation to the network, core,
 * account, validator instance, credential generation, authority epoch and
 * configuration nonce. This module therefore only reads the values the domain
 * needs, builds the codec operation, and exposes the typed data a secp256k1
 * validator signs. There is no client-side digest the chain would have to
 * agree with: the digest comes from the shared codec, and `validateUserOp`
 * returns the same value for comparison before submission.
 *
 * The v3 surfaces (MetaTransaction struct, 7-field UserOperation, `getVerifier`,
 * `getBackupOwner`, `getNonceForAccount`, `previewUserOpValidation`) are gone
 * from the deployed ABI and are not produced here.
 */

import { Signature, SigningKey, TypedDataEncoder, keccak256 } from 'ethers';
import { EC } from '../../config/errorCodes.js';
import { sanitizeHex } from '../../utils/hex.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import { toMultiSigRpcParameter } from '../../shared/multiSigCore.mjs';
import {
  createMetaTxBuilders,
  decodeByteStringStackHex,
  decodeHash160Stack,
  decodeIntegerStack,
  decodeValidationPreviewStack,
  decodeAccountDescriptorStack,
  decodeModuleDescriptorStack,
} from '../../shared/metaTxCore.mjs';
import { smartAccountCodec } from '../../services/smartAccountCodec.js';

// EIP-712 typed data comes from the shared core (single source of truth with
// the SDK): domain "Neo Smart Account"/"4", verifying contract = the validator
// module, and the core's §4.3 digest as a signed field.
const { buildUserOperationTypedData } = createMetaTxBuilders({ keccak256 });

export {
  buildUserOperationTypedData,
  decodeByteStringStackHex,
  decodeHash160Stack,
  decodeIntegerStack,
  decodeValidationPreviewStack,
  decodeAccountDescriptorStack,
  decodeModuleDescriptorStack,
};

/** §6 nonce subkey: the protocol fixes it at 32 bytes; the default names the main sequence. */
export const DEFAULT_NONCE_SUBKEY = '00'.repeat(32);

function canonicalArgument(item) {
  if (!item || typeof item !== 'object') throw new Error(EC.metaTxArgsHashFailed);
  const { type, value } = item;
  switch (type) {
    case 'Null':
      return { type: 'Null' };
    case 'Boolean':
      return { type: 'Boolean', value: Boolean(value) };
    case 'Integer':
      return { type: 'Integer', value: String(value) };
    case 'ByteString':
      return { type: 'ByteString', value: sanitizeHex(value) };
    case 'ByteArray':
      return { type: 'ByteString', value: sanitizeHex(value) };
    case 'Signature':
    case 'PublicKey':
      return { type: 'ByteString', value: sanitizeHex(value) };
    case 'Hash160':
    case 'Hash256': {
      const raw = sanitizeHex(value);
      // A hash RPC parameter is display order; the VM stores the bytes reversed.
      return { type: 'ByteString', value: raw.match(/../g).reverse().join('') };
    }
    case 'String':
      return {
        type: 'ByteString',
        value: Array.from(new TextEncoder().encode(String(value)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      };
    case 'Array':
    case 'Struct':
      if (!Array.isArray(value)) throw new Error(EC.metaTxArgsHashFailed);
      return { type: 'Array', value: value.map(canonicalArgument) };
    default:
      throw new Error(EC.metaTxArgsHashFailed);
  }
}

/**
 * The operation argument set in the one shape the codec and the core agree on.
 *
 * Builder screens collect Neo RPC parameters (`Hash160` display order,
 * `ByteArray`, `String`), while §4.1 defines operation arguments as Null,
 * Boolean, Integer, ByteString or Array. This converts between the two: hashes
 * reverse into stored order, text becomes UTF-8 bytes, and everything else is
 * validated by the codec when the envelope is built.
 */
export function toCanonicalOperationArgs(args = []) {
  if (!Array.isArray(args)) throw new Error(EC.metaTxArgsHashFailed);
  return args.map(canonicalArgument);
}

/**
 * A v4 operation built from the codec, ready to be signed in field 11.
 *
 * `credentialGeneration` has no default on purpose. The routing generation is a
 * chain fact -- the built-in validator's is the account's 0x57 SubjectRevision
 * and an installed validator's is its CredentialGeneration -- so a factory that
 * substituted 1 would hand out a digest the core rejects as
 * ErrorCredentialStale as soon as the revision has advanced. Callers that have
 * a route in hand (see `fetchOperationRoute`) already carry the right value.
 */
export function buildUserOperation({
  targetContract = '',
  method = '',
  args = [],
  nonce = 0n,
  nonceSubkey = DEFAULT_NONCE_SUBKEY,
  deadline = 0,
  validatorId = 0,
  credentialGeneration,
  authorityEpoch = 0,
  configurationNonce = 0,
  signature = '',
  hookProofs = [],
} = {}) {
  if (credentialGeneration === undefined || credentialGeneration === null) {
    throw new Error(EC.credentialGenerationRequired);
  }
  return {
    targetContract: sanitizeHex(targetContract),
    method: String(method || ''),
    args: toCanonicalOperationArgs(args),
    nonce: String(nonce),
    nonceSubkey: sanitizeHex(nonceSubkey) || DEFAULT_NONCE_SUBKEY,
    deadline: String(deadline),
    validatorId: String(validatorId),
    credentialGeneration: String(credentialGeneration),
    authorityEpoch: String(authorityEpoch),
    configurationNonce: String(configurationNonce),
    signature: sanitizeHex(signature),
    hookProofs: Array.isArray(hookProofs) ? hookProofs : [],
  };
}

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
      params: [scriptHash, operation, args.map(toMultiSigRpcParameter)],
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

function requireHash160(value, errorCode) {
  const clean = sanitizeHex(value);
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(errorCode);
  return clean;
}

export async function computeArgsHash({ rpcUrl, saContractHash, args = [], fetchImpl } = {}) {
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(saContractHash),
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

/**
 * Reads the account control record. The operation's authority epoch and
 * configuration nonce are taken from here, never guessed: a stale value is
 * refused on-chain, so reading them first turns that into a clear error.
 */
export async function fetchAccountDescriptor({ rpcUrl, saContractHash, accountId, fetchImpl } = {}) {
  const account = requireHash160(accountId, EC.accountIdRequired);
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(saContractHash),
    operation: 'getAccount',
    args: [{ type: 'Hash160', value: `0x${account}` }],
    fetchImpl,
  });

  if (result?.state === 'FAULT') {
    const err = new Error(EC.metaTxAccountFailed);
    err.rpcDetail = result.exception;
    throw err;
  }

  const descriptor = decodeAccountDescriptorStack(result?.stack?.[0]);
  if (!descriptor) {
    const err = new Error(EC.metaTxAccountFailed);
    err.rpcDetail = 'account not registered';
    throw err;
  }
  return descriptor;
}

/** Reads one installed module's descriptor (12 fields, `SA-MODULE-PROTOCOL.md` §9). */
export async function fetchModuleDescriptor({
  rpcUrl,
  saContractHash,
  accountId,
  moduleId,
  fetchImpl,
} = {}) {
  const account = requireHash160(accountId, EC.accountIdRequired);
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(saContractHash),
    operation: 'getModule',
    args: [
      { type: 'Hash160', value: `0x${account}` },
      { type: 'Integer', value: String(moduleId) },
    ],
    fetchImpl,
  });

  if (result?.state === 'FAULT') {
    const err = new Error(EC.metaTxModuleFailed);
    err.rpcDetail = result.exception;
    throw err;
  }

  const descriptor = decodeModuleDescriptorStack(result?.stack?.[0]);
  if (!descriptor) {
    const err = new Error(EC.metaTxModuleFailed);
    err.rpcDetail = 'module instance not found';
    throw err;
  }
  return descriptor;
}

/** Module type ids used by `getModules`: 1 = validator, 4 = hook (ERC-7579). */
const MODULE_TYPE_IDS = Object.freeze({ validator: 1, hook: 4 });

/**
 * Lists the account's installed modules of one type. `getModules` pages by
 * cursor and returns `[ids, nextCursor, configurationNonce]`.
 */
export async function fetchInstalledModuleIds({
  rpcUrl,
  saContractHash,
  accountId,
  moduleType = 'validator',
  fetchImpl,
} = {}) {
  const account = requireHash160(accountId, EC.accountIdRequired);
  const ids = [];
  let cursor = 0;
  for (let page = 0; page < 8; page += 1) {
    const result = await invokeRead({
      rpcUrl,
      scriptHash: sanitizeHex(saContractHash),
      operation: 'getModules',
      args: [
        { type: 'Hash160', value: `0x${account}` },
        { type: 'String', value: moduleType },
        { type: 'Integer', value: String(cursor) },
        { type: 'Integer', value: '32' },
      ],
      fetchImpl,
    });
    if (result?.state === 'FAULT') {
      const err = new Error(EC.metaTxModuleFailed);
      err.rpcDetail = result.exception;
      throw err;
    }
    const page0 = result?.stack?.[0];
    const pageIds = page0?.type === 'Array' && Array.isArray(page0.value) ? page0.value : [];
    for (const item of pageIds) ids.push(decodeIntegerStack(item).toString());
    const next = result?.stack?.[1];
    const nextCursor = Number(decodeIntegerStack(next));
    if (!ids.length && !nextCursor) break;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return { ids, moduleTypeId: MODULE_TYPE_IDS[moduleType] ?? 0 };
}

/**
 * The validator instance an operation routes to: the first installed validator
 * plus the control values the §4.3 domain binds.
 */
export async function fetchOperationRoute({ rpcUrl, saContractHash, accountId, fetchImpl } = {}) {
  const account = requireHash160(accountId, EC.accountIdRequired);
  const descriptor = await fetchAccountDescriptor({ rpcUrl, saContractHash, accountId: account, fetchImpl });
  const { ids } = await fetchInstalledModuleIds({ rpcUrl, saContractHash, accountId: account, fetchImpl });
  if (!ids.length) throw new Error(EC.noValidatorConfigured);
  const module = await fetchModuleDescriptor({
    rpcUrl,
    saContractHash,
    accountId: account,
    moduleId: ids[0],
    fetchImpl,
  });
  return {
    account: descriptor,
    module,
    validatorId: module.moduleId,
    credentialGeneration: module.credentialGeneration,
    verifyingContract: module.contractHash,
    authorityEpoch: descriptor.authorityEpoch,
    configurationNonce: descriptor.configurationNonce,
  };
}

/**
 * Reads the next sequence for one validator instance's nonce namespace. The
 * channel is derived from the namespace (§6), so the subkey must be the same
 * one the operation carries.
 */
export async function fetchNonce({
  rpcUrl,
  saContractHash,
  accountId,
  validatorId,
  nonceSubkey = DEFAULT_NONCE_SUBKEY,
  fetchImpl,
} = {}) {
  const account = requireHash160(accountId, EC.accountIdRequired);
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(saContractHash),
    operation: 'getNonce',
    args: [
      { type: 'Hash160', value: `0x${account}` },
      { type: 'Integer', value: String(validatorId) },
      { type: 'ByteArray', value: `0x${sanitizeHex(nonceSubkey)}` },
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

/**
 * The account's packed operation nonce for a nonce namespace: the derived
 * channel in the high bits and the next sequence in the low bits.
 */
export function composeOperationNonce({ context, route, sequence, nonceSubkey = DEFAULT_NONCE_SUBKEY }) {
  const channel = smartAccountCodec.deriveNonceChannel(context, {
    validatorId: route.validatorId,
    credentialGeneration: route.credentialGeneration,
    nonceSubkey,
  });
  return smartAccountCodec.composeNonce(channel, sequence);
}

/** The §4.3 digest the validator signs and the chain recomputes. */
export function computeOperationDigest({ networkMagic, coreContractHash, accountId, operation }) {
  return smartAccountCodec.operationDigest(
    { networkMagic, coreContractHash, accountId },
    operation,
  );
}

/**
 * Read-only preview: full envelope validation plus real signature
 * verification. Returns `[accepted, operationDigest]`, decoded.
 */
export async function fetchValidationPreview({ rpcUrl, saContractHash, accountId, operation, fetchImpl } = {}) {
  const account = requireHash160(accountId, EC.accountIdRequired);
  const result = await invokeRead({
    rpcUrl,
    scriptHash: sanitizeHex(saContractHash),
    operation: 'validateUserOp',
    args: [
      { type: 'Hash160', value: `0x${account}` },
      smartAccountCodec.operationValue(operation),
    ],
    fetchImpl,
  });

  if (result?.state === 'FAULT') {
    const err = new Error(EC.metaTxValidationFailed);
    err.rpcDetail = result.exception;
    throw err;
  }

  return decodeValidationPreviewStack(result?.stack?.[0]);
}

/** The account must be registered before an operation can be routed to it. */
export async function assertAccountExists({ rpcUrl, saContractHash, accountId, fetchImpl } = {}) {
  return fetchAccountDescriptor({ rpcUrl, saContractHash, accountId, fetchImpl });
}

/**
 * `executeUserOp(accountId, operation)` — the account id argument is the
 * canonical stored byte order the proxy witness compares against.
 */
export function buildExecuteUserOpInvocation({ saContractHash, accountId, operation } = {}) {
  const core = sanitizeHex(saContractHash);
  const account = sanitizeHex(accountId);
  if (!/^[0-9a-f]{40}$/.test(core) || !/^[0-9a-f]{40}$/.test(account) || !operation) {
    return null;
  }
  return {
    scriptHash: core,
    operation: 'executeUserOp',
    args: [smartAccountCodec.hashValue(account), smartAccountCodec.operationValue(operation)],
  };
}

/** `executeUserOps(accountId, operations)` — one envelope, 1..32 operations. */
export function buildExecuteUserOpsInvocation({ saContractHash, accountId, operations } = {}) {
  const core = sanitizeHex(saContractHash);
  const account = sanitizeHex(accountId);
  if (!/^[0-9a-f]{40}$/.test(core) || !/^[0-9a-f]{40}$/.test(account) || !Array.isArray(operations) || !operations.length) {
    return null;
  }
  return {
    scriptHash: core,
    operation: 'executeUserOps',
    args: [
      smartAccountCodec.hashValue(account),
      { type: 'Array', value: operations.map((operation) => smartAccountCodec.operationValue(operation)) },
    ],
  };
}

/** r‖s for a P-256 / secp256k1 validator: the recovery byte is not submitted. */
export function toCompactEcdsaSignature(signature) {
  const parsed = Signature.from(signature);
  return `${sanitizeHex(parsed.r)}${sanitizeHex(parsed.s)}`;
}

export function recoverPublicKeyFromTypedDataSignature({ typedData, signature } = {}) {
  const digest = TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
  return SigningKey.recoverPublicKey(digest, signature);
}
