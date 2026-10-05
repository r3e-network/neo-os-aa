import { getAddress, id, keccak256, toUtf8Bytes } from 'ethers';
import { sanitizeHex } from '../../utils/hex.js';
import { cloneImmutable } from './helpers.js';
import { buildDraftCollaborationUrl, buildDraftShareUrl } from './shareLinks.js';
import { EC } from '../../config/errorCodes.js';
import { RUNTIME_CONFIG } from '../../config/runtimeConfig.js';
import {
  buildExecuteUnifiedByAddressInvocation,
  buildExecuteUserOpInvocation as buildV3ExecuteUserOpInvocation,
} from './metaTx.js';

function buildPayloadDigest(draftRecord = {}) {
  return id(JSON.stringify({
    account: draftRecord.account || {},
    transactionBody: draftRecord.transaction_body || {},
    signerRequirements: draftRecord.signer_requirements || [],
    broadcastMode: draftRecord.broadcast_mode || 'client',
  }));
}

function buildVerifyingContract(draftRecord = {}) {
  const seed = keccak256(toUtf8Bytes(
    draftRecord.share_slug || draftRecord.draft_id || 'neo-abstract-account-workspace'
  ));
  return getAddress(`0x${seed.slice(-40)}`);
}

function toHash160Param(value) {
  return {
    type: 'Hash160',
    value: `0x${sanitizeHex(value || '')}`,
  };
}

function toArrayParam(args = []) {
  return {
    type: 'Array',
    value: cloneImmutable(args),
  };
}

function buildV3UserOperationParam({ operationBody = null, nonce = '0', deadline = '0', signatureHex = '0x' } = {}) {
  const targetContract = sanitizeHex(operationBody?.targetContract || '');
  const method = String(operationBody?.method || '').trim();
  const args = Array.isArray(operationBody?.args) ? cloneImmutable(operationBody.args) : [];

  if (!targetContract || !method) {
    return null;
  }

  return {
    type: 'Struct',
    value: [
      toHash160Param(targetContract),
      { type: 'String', value: method },
      toArrayParam(args),
      { type: 'Integer', value: String(nonce) },
      { type: 'Integer', value: String(deadline) },
      { type: 'ByteArray', value: `0x${sanitizeHex(signatureHex || '')}` },
    ],
  };
}

function buildExecuteUserOpInvocation({ aaContractHash = '', account = {}, operationBody = null, signerAddress = '', nonce = '0', deadline = '' } = {}) {
  const invocation = buildV3ExecuteUserOpInvocation({
    aaContractHash,
    accountIdHash: account.accountIdHash || '',
    targetContract: operationBody?.targetContract,
    method: operationBody?.method,
    methodArgs: Array.isArray(operationBody?.args) ? operationBody.args : [],
    nonce,
    deadline: String(deadline || Date.now() + 3600_000),
    signatureHex: '',
  });
  if (!invocation) return null;
  return {
    ...invocation,
    signers: signerAddress ? [{ account: signerAddress, scopes: 1 }] : [],
  };
}

function selectMetaInvocation(transactionBody = {}, signatures = []) {
  const v3Signature = transactionBody?.v3Invocation?.args?.[1]?.value?.[5]?.value;
  if (transactionBody?.v3Invocation && typeof v3Signature === 'string' && sanitizeHex(v3Signature).length > 0) {
    return cloneImmutable(transactionBody.v3Invocation);
  }
  if (transactionBody?.metaInvocation) {
    return cloneImmutable(transactionBody.metaInvocation);
  }
  if (Array.isArray(transactionBody?.metaInvocations) && transactionBody.metaInvocations.length > 0) {
    return cloneImmutable(transactionBody.metaInvocations[0]);
  }
  if (Array.isArray(transactionBody?.meta_invocations) && transactionBody.meta_invocations.length > 0) {
    return cloneImmutable(transactionBody.meta_invocations[0]);
  }
  const clientV3Signature = transactionBody?.clientInvocation?.args?.[1]?.value?.[5]?.value;
  if (
    transactionBody?.clientInvocation
    && transactionBody?.clientInvocation?.operation === 'executeUserOp'
    && typeof clientV3Signature === 'string'
    && sanitizeHex(clientV3Signature).length > 0
  ) {
    return cloneImmutable(transactionBody.clientInvocation);
  }

  const entry = Array.isArray(signatures)
    ? signatures.find((item) => item?.metadata?.metaInvocation)
    : null;
  return entry?.metadata?.metaInvocation ? cloneImmutable(entry.metadata.metaInvocation) : null;
}

export function buildRelayPayloadOptions({ runtime = null, transactionBody = {}, signatures = [] } = {}) {
  const options = [];
  const allowRawRelay = runtime == null ? true : Boolean(runtime?.relayRawEnabled);
  const rawTransaction = sanitizeHex(
    transactionBody?.rawTransaction || transactionBody?.raw_transaction || transactionBody?.txHex || ''
  );
  const metaInvocation = selectMetaInvocation(transactionBody, signatures);

  if (rawTransaction && allowRawRelay) options.push('raw');
  if (metaInvocation) options.push('meta');
  if (options.length > 1) {
    return ['best', ...options];
  }
  return options;
}

export function resolveRelayPayloadMode({ relayPayloadMode = 'best', availableModes = [] } = {}) {
  if (!Array.isArray(availableModes) || availableModes.length === 0) {
    return 'none';
  }

  if (relayPayloadMode && relayPayloadMode !== 'best' && availableModes.includes(relayPayloadMode)) {
    return relayPayloadMode;
  }

  if (availableModes.includes('raw')) return 'raw';
  if (availableModes.includes('meta')) return 'meta';
  return availableModes[0];
}

function resolveNetworkLabel(network, morpheusNetwork) {
  const explicit = String(network || '').trim();
  if (explicit) return explicit;
  const normalized = String(morpheusNetwork || RUNTIME_CONFIG.morpheusNetwork || '').trim().toLowerCase();
  return normalized === 'testnet' ? 'neo-n3-testnet' : 'neo-n3-mainnet';
}

export function buildStagedTransactionBody({
  aaContractHash = '',
  account = {},
  operationBody = null,
  signerAddress = '',
  rawTransaction = '',
  notes = '',
  network = '',
  morpheusNetwork = RUNTIME_CONFIG.morpheusNetwork,
  createdAt = new Date().toISOString(),
} = {}) {
  const legacyInvocationBase = buildExecuteUnifiedByAddressInvocation({
    aaContractHash,
    accountAddressScriptHash: account.accountAddressScriptHash || '',
    targetContract: operationBody?.targetContract,
    method: operationBody?.method,
    methodArgs: Array.isArray(operationBody?.args) ? operationBody.args : [],
    argsHashHex: '',
    nonce: '0',
    deadline: '0',
    signatureHex: '',
  });
  const legacyInvocation = legacyInvocationBase
    ? {
        ...legacyInvocationBase,
        signers: signerAddress ? [{ account: signerAddress, scopes: 1 }] : [],
      }
    : null;
  const v3Invocation = buildExecuteUserOpInvocation({
    aaContractHash,
    account,
    operationBody,
    signerAddress,
  });
  const clientInvocation = v3Invocation || legacyInvocation;
  if (!clientInvocation) {
    throw new Error(EC.v3AccountRequired);
  }

  return cloneImmutable({
    version: 1,
    network: resolveNetworkLabel(network, morpheusNetwork),
    accountAddressScriptHash: account.accountAddressScriptHash || '',
    accountIdHash: account.accountIdHash || '',
    kind: operationBody?.kind || 'invoke',
    clientInvocation,
    v3Invocation,
    legacyInvocation,
    rawTransaction: sanitizeHex(rawTransaction || ''),
    notes: String(notes || '').trim(),
    createdAt,
  });
}

export function buildDraftApprovalTypedData({ draftRecord, chainId = RUNTIME_CONFIG.networkMagic } = {}) {
  const payloadDigest = buildPayloadDigest(draftRecord);

  return {
    domain: {
      name: 'Neo Abstract Account Workspace',
      version: '1',
      chainId,
      verifyingContract: buildVerifyingContract(draftRecord),
    },
    types: {
      DraftApproval: [
        { name: 'draftId', type: 'string' },
        { name: 'shareSlug', type: 'string' },
        { name: 'accountAddress', type: 'string' },
        { name: 'payloadDigest', type: 'bytes32' },
        { name: 'broadcastMode', type: 'string' },
      ],
    },
    message: {
      draftId: draftRecord?.draft_id || 'local-draft',
      shareSlug: draftRecord?.share_slug || 'local-share',
      accountAddress: draftRecord?.account?.accountAddressScriptHash || '',
      payloadDigest,
      broadcastMode: draftRecord?.broadcast_mode || 'client',
    },
  };
}

export function buildClientBroadcastRequest({ signerAddress = '', transactionBody = {} } = {}) {
  const invocation = cloneImmutable(transactionBody?.clientInvocation || {});
  if (!invocation.scriptHash || !invocation.operation) {
    throw new Error(EC.clientInvocationMissing);
  }

  if (!Array.isArray(invocation.signers) || invocation.signers.length === 0) {
    if (!signerAddress) {
      throw new Error(EC.signerRequired);
    }
    invocation.signers = [{ account: signerAddress, scopes: 1 }];
  }

  return invocation;
}

export function buildRelayBroadcastRequest({ relayEndpoint = '', relayPayloadMode = 'best', relayRawEnabled = true, transactionBody = {}, signatures = [], morpheusNetwork = RUNTIME_CONFIG.morpheusNetwork } = {}) {
  if (!relayEndpoint) {
    throw new Error(EC.relayEndpointMissing);
  }

  const normalizedMorpheusNetwork = String(morpheusNetwork || '').trim().toLowerCase();
  const relayNetwork = normalizedMorpheusNetwork === 'testnet'
    ? 'testnet'
    : normalizedMorpheusNetwork === 'mainnet'
      ? 'mainnet'
      : '';
  const rawTransaction = sanitizeHex(
    transactionBody?.rawTransaction || transactionBody?.raw_transaction || transactionBody?.txHex || ''
  );
  const paymaster = transactionBody?.paymaster && typeof transactionBody.paymaster === 'object'
    ? cloneImmutable(transactionBody.paymaster)
    : transactionBody?.paymasterRequest && typeof transactionBody.paymasterRequest === 'object'
      ? cloneImmutable(transactionBody.paymasterRequest)
      : null;
  const metaInvocation = selectMetaInvocation(transactionBody, signatures);
  if (rawTransaction && !relayRawEnabled && relayPayloadMode !== 'meta') {
    throw new Error(`${EC.rawRelayDisabled}: raw relay forwarding is not enabled`);
  }
  const availableModes = buildRelayPayloadOptions({ runtime: { relayRawEnabled }, transactionBody, signatures });
  const resolvedMode = resolveRelayPayloadMode({ relayPayloadMode, availableModes });

  if (resolvedMode === 'raw' && rawTransaction) {
    if (!relayRawEnabled) {
      throw new Error(`${EC.rawRelayDisabled}: raw relay forwarding is not enabled`);
    }
    return {
      relayEndpoint,
      relayPayloadMode: 'raw',
      ...(relayNetwork ? { morpheus_network: relayNetwork } : {}),
      rawTransaction,
      ...(paymaster ? { paymaster } : {}),
    };
  }

  if (resolvedMode === 'meta' && metaInvocation) {
    return {
      relayEndpoint,
      relayPayloadMode: 'meta',
      ...(relayNetwork ? { morpheus_network: relayNetwork } : {}),
      metaInvocation,
      ...(paymaster ? { paymaster } : {}),
    };
  }

  throw new Error(`${EC.signedTxMissing}: signed raw transaction or meta invocation is required`);
}

export async function executeBroadcast({
  mode = 'client',
  signerAddress = '',
  relayPayloadMode = 'best',
  relayRawEnabled = true,
  morpheusNetwork = RUNTIME_CONFIG.morpheusNetwork,
  transactionBody = {},
  signatures = [],
  walletService,
  relayEndpoint = '',
} = {}) {
  if (!walletService) {
    throw new Error(EC.walletServiceMissing);
  }

  if (mode === 'relay') {
    const response = await walletService.relayTransaction(
      buildRelayBroadcastRequest({ relayEndpoint, relayPayloadMode, relayRawEnabled, transactionBody, signatures, morpheusNetwork })
    );
    // The relay answers a broadcast it refused (a VM fault in its preview, a token transfer that returned false)
    // with HTTP 200, ok:false and no txid. That is not a submission: callers must not report it as sent.
    if (response?.ok === false) {
      throw new Error(String(response.exception || response.message || EC.operationFailed));
    }
    return response;
  }

  return walletService.invoke(
    buildClientBroadcastRequest({ signerAddress, transactionBody })
  );
}

export function buildDraftExportBundle({ draftRecord = {}, origin = '' } = {}) {
  const bundle = cloneImmutable(draftRecord);
  const metaInvocations = Array.isArray(bundle?.signatures)
    ? bundle.signatures
        .map((item) => item?.metadata?.metaInvocation)
        .filter(Boolean)
    : [];

  return {
    ...bundle,
    meta_invocations: metaInvocations,
    share_url: origin && draftRecord?.share_slug
      ? buildDraftShareUrl(origin, draftRecord.share_slug)
      : '',
    collaboration_url: origin && draftRecord?.share_slug && draftRecord?.collaboration_slug
      ? buildDraftCollaborationUrl(origin, draftRecord.share_slug, draftRecord.collaboration_slug)
      : '',
    operator_url: origin && draftRecord?.share_slug && draftRecord?.operator_slug
      ? buildDraftCollaborationUrl(origin, draftRecord.share_slug, draftRecord.operator_slug)
      : '',
  };
}
