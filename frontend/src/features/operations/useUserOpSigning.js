import {
  buildExecuteUserOpInvocation,
  buildV3UserOperationTypedData,
  computeArgsHash,
  fetchV3Nonce,
  fetchV3Verifier,
  recoverPublicKeyFromTypedDataSignature,
  toCompactEcdsaSignature,
} from './metaTx.js';
import { EC } from '../../config/errorCodes.js';

// The V3 verifier binds UserOperation signatures to the Neo N3 network magic of
// the *connected* network: the magic is baked into the EIP-712 domain chainId
// the on-chain verifier checks, so a testnet-signed domain fails to verify on
// mainnet and vice versa. Callers thread the active network magic
// (RUNTIME_CONFIG.networkMagic / runtime.networkMagic) into `chainId`; this
// constant remains only as the legacy testnet fallback for callers that have no
// runtime network resolved yet.
export const V3_USER_OP_CHAIN_ID = 894710606;

// Signatures stay valid for one hour, matching the contract-side deadline
// window both views used before this core was extracted.
export const USER_OP_DEADLINE_MS = 60 * 60 * 1000;

/**
 * Resolve everything a V3 UserOperation signature needs from chain state:
 * the canonical args hash, the bound verifier, the current channel-0 nonce,
 * and a fresh deadline.
 *
 * Callers pass their surface-specific error codes so toasts keep their
 * existing translations. `deps` allows tests to inject the chain readers.
 */
export async function prepareV3UserOpContext({
  rpcUrl,
  aaContractHash,
  accountIdHash,
  operationBody = {},
  missingAccountError = EC.v3AccountIdHashMissing,
  missingVerifierError = EC.noVerifierConfigured,
  deadlineMs = USER_OP_DEADLINE_MS,
  deps = {},
}) {
  const {
    computeArgsHash: computeArgsHashImpl = computeArgsHash,
    fetchV3Verifier: fetchV3VerifierImpl = fetchV3Verifier,
    fetchV3Nonce: fetchV3NonceImpl = fetchV3Nonce,
  } = deps;

  if (!accountIdHash) {
    throw new Error(missingAccountError);
  }

  const deadline = Date.now() + deadlineMs;
  const argsHashHex = await computeArgsHashImpl({
    rpcUrl,
    aaContractHash,
    args: operationBody?.args || [],
  });
  const verifierHash = await fetchV3VerifierImpl({
    rpcUrl,
    aaContractHash,
    accountIdHash,
  });
  if (!verifierHash) {
    throw new Error(missingVerifierError);
  }
  const nonce = await fetchV3NonceImpl({
    rpcUrl,
    aaContractHash,
    accountIdHash,
    channel: 0n,
  });

  return { argsHashHex, verifierHash, nonce, deadline };
}

/**
 * Full EVM UserOperation signing core shared by HomeOperationsWorkspace and
 * TransactionInfoView: prepare chain context, build the V3 typed data, sign
 * it via the injected signer, and return the contract-aligned signature
 * record plus the executeUserOp invocation.
 *
 * The caller stays responsible for surface-specific concerns: connecting the
 * EVM wallet, immutable-draft guards, appending the record, and toasts.
 */
export async function signUserOpWithEvm({
  rpcUrl,
  aaContractHash,
  accountIdHash,
  operationBody = {},
  signerId,
  signTypedData,
  chainId = V3_USER_OP_CHAIN_ID,
  missingAccountError,
  missingVerifierError,
  deadlineMs,
  deps = {},
}) {
  if (typeof signTypedData !== 'function') {
    throw new Error(EC.evmProviderMissing);
  }

  const { argsHashHex, verifierHash, nonce, deadline } = await prepareV3UserOpContext({
    rpcUrl,
    aaContractHash,
    accountIdHash,
    operationBody,
    missingAccountError,
    missingVerifierError,
    deadlineMs,
    deps,
  });

  const typedData = buildV3UserOperationTypedData({
    chainId,
    verifyingContract: verifierHash,
    accountIdHash,
    coreContractHash: aaContractHash,
    targetContract: operationBody?.targetContract,
    method: operationBody?.method,
    argsHashHex,
    nonce,
    deadline,
  });

  const signature = await signTypedData(typedData);
  const contractSignature = toCompactEcdsaSignature(signature);
  const publicKey = recoverPublicKeyFromTypedDataSignature({
    typedData,
    signature,
  });

  const metaInvocation = buildExecuteUserOpInvocation({
    aaContractHash,
    accountIdHash,
    targetContract: operationBody?.targetContract,
    method: operationBody?.method,
    methodArgs: operationBody?.args || [],
    nonce,
    deadline,
    signatureHex: contractSignature,
  });

  return {
    argsHashHex,
    verifierHash,
    nonce,
    deadline,
    typedData,
    metaInvocation,
    signatureRecord: {
      signerId,
      kind: 'evm',
      signatureHex: contractSignature,
      publicKey,
      payloadDigest: argsHashHex,
      metadata: {
        typedData,
        verifierHash,
        argsHashHex,
        nonce: String(nonce),
        deadline: String(deadline),
        metaInvocation,
        signatureFullHex: signature,
      },
      createdAt: new Date().toISOString(),
    },
  };
}
