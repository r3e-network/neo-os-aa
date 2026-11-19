import {
  buildExecuteUserOpInvocation,
  buildUserOperation,
  buildUserOperationTypedData,
  composeOperationNonce,
  computeArgsHash,
  computeOperationDigest,
  fetchNonce,
  fetchOperationRoute,
  recoverPublicKeyFromTypedDataSignature,
  toCompactEcdsaSignature,
  DEFAULT_NONCE_SUBKEY,
} from './metaTx.js';
import { EC } from '../../config/errorCodes.js';

// The domain chainId is the *active* network magic: the validator rebuilds the
// domain from its own protocol settings, so a signature made for another
// network cannot verify. Callers thread the runtime magic in; the testnet value
// remains only as the fallback for a caller with no resolved network.
export const DEFAULT_USER_OP_CHAIN_ID = 894710606;

// Signatures stay valid for one hour, well inside the core's deadline window.
export const USER_OP_DEADLINE_MS = 60 * 60 * 1000;

/**
 * Resolve everything a v4 operation signature needs: the account control
 * record, the validator instance it routes to (id, credential generation and
 * verifying contract), the canonical args hash, the next nonce in that
 * instance's namespace and a fresh deadline.
 *
 * `deps` lets tests inject the chain readers.
 */
export async function prepareUserOpRoute({
  rpcUrl,
  saContractHash,
  accountId,
  operationBody = {},
  networkMagic = DEFAULT_USER_OP_CHAIN_ID,
  nonceSubkey = DEFAULT_NONCE_SUBKEY,
  deadlineMs = USER_OP_DEADLINE_MS,
  missingAccountError = EC.accountIdHashMissing,
  deps = {},
}) {
  const {
    fetchOperationRoute: fetchRouteImpl = fetchOperationRoute,
    computeArgsHash: computeArgsHashImpl = computeArgsHash,
    fetchNonce: fetchNonceImpl = fetchNonce,
  } = deps;

  if (!accountId) throw new Error(missingAccountError);

  const deadline = Date.now() + deadlineMs;
  const route = await fetchRouteImpl({ rpcUrl, saContractHash, accountId });
  const argsHashHex = await computeArgsHashImpl({
    rpcUrl,
    saContractHash,
    args: operationBody?.args || [],
  });
  const sequence = await fetchNonceImpl({
    rpcUrl,
    saContractHash,
    accountId,
    validatorId: route.validatorId,
    nonceSubkey,
  });
  const nonce = composeOperationNonce({
    // The namespace digest binds the account's current authority epoch, so the
    // channel is the one the core will recompute from its own state.
    context: {
      networkMagic,
      coreContractHash: saContractHash,
      accountId,
      authorityEpoch: route.authorityEpoch,
    },
    route,
    sequence,
    nonceSubkey,
  });

  // The unsigned operation and its §4.3 digest: the typed-data path signs it,
  // and an opaque proof (zkLogin ticket) is attached to the same envelope.
  const operation = buildUserOperation({
    targetContract: operationBody?.targetContract,
    method: operationBody?.method,
    args: operationBody?.args || [],
    nonce,
    nonceSubkey,
    deadline,
    validatorId: route.validatorId,
    credentialGeneration: route.credentialGeneration,
    authorityEpoch: route.authorityEpoch,
    configurationNonce: route.configurationNonce,
  });
  const operationDigest = computeOperationDigest({
    networkMagic,
    coreContractHash: saContractHash,
    accountId,
    operation,
  });

  return { route, argsHashHex, nonce, deadline, nonceSubkey, chainId: networkMagic, operation, operationDigest };
}

/**
 * Full EVM operation signing core shared by the operations workspace and
 * TransactionInfoView: prepare the route, build the codec operation, digest it
 * with §4.3, build the EIP-712 typed data the validator verifies, sign it, and
 * return the contract-aligned signature record plus the executeUserOp
 * invocation.
 *
 * The caller stays responsible for surface-specific concerns: connecting the
 * EVM wallet, immutable-draft guards, appending the record, and toasts.
 */
export async function signUserOpWithEvm({
  rpcUrl,
  saContractHash,
  accountId,
  operationBody = {},
  signerId,
  signTypedData,
  networkMagic = DEFAULT_USER_OP_CHAIN_ID,
  nonceSubkey = DEFAULT_NONCE_SUBKEY,
  missingAccountError,
  deadlineMs,
  deps = {},
}) {
  if (typeof signTypedData !== 'function') {
    throw new Error(EC.evmProviderMissing);
  }

  const { route, argsHashHex, nonce, deadline, chainId, operation: unsigned, operationDigest } = await prepareUserOpRoute({
    rpcUrl,
    saContractHash,
    accountId,
    operationBody,
    networkMagic,
    nonceSubkey,
    deadlineMs,
    missingAccountError,
    deps,
  });

  const typedData = buildUserOperationTypedData({
    chainId,
    verifyingContract: route.verifyingContract,
    accountId,
    coreContractHash: saContractHash,
    validatorId: route.validatorId,
    targetContract: unsigned.targetContract,
    method: unsigned.method,
    argsHashHex,
    nonce,
    deadline,
    operationDigest,
  });

  const signature = await signTypedData(typedData);
  const contractSignature = toCompactEcdsaSignature(signature);
  const publicKey = recoverPublicKeyFromTypedDataSignature({ typedData, signature });

  const operation = { ...unsigned, signature: contractSignature };
  const metaInvocation = buildExecuteUserOpInvocation({ saContractHash, accountId, operation });

  return {
    argsHashHex,
    operationDigest,
    validatorId: route.validatorId,
    verifyingContract: route.verifyingContract,
    nonce: String(nonce),
    deadline: String(deadline),
    typedData,
    operation,
    metaInvocation,
    signatureRecord: {
      signerId,
      kind: 'evm',
      signatureHex: contractSignature,
      publicKey,
      payloadDigest: operationDigest,
      metadata: {
        typedData,
        verifierHash: route.verifyingContract,
        validatorId: String(route.validatorId),
        argsHashHex,
        operationDigest,
        nonce: String(nonce),
        deadline: String(deadline),
        metaInvocation,
        signatureFullHex: signature,
      },
      createdAt: new Date().toISOString(),
    },
  };
}
