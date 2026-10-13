import { getAddress, id, keccak256, toUtf8Bytes } from 'ethers';
import { sanitizeHex } from '../../utils/hex.js';
import { cloneImmutable } from './helpers.js';
import { buildDraftCollaborationUrl, buildDraftShareUrl } from './shareLinks.js';
import { EC } from '../../config/errorCodes.js';
import { RUNTIME_CONFIG } from '../../config/runtimeConfig.js';
import { selectSignedInvocation, isDeployedEntrypoint } from './signedInvocation.js';
import { isProxySourcedTransfer } from '../../shared/transferOutcome.mjs';
import { buildProxyWalletSignRequest, resolveProxyWitnessTransaction } from '../../shared/proxyWitness.mjs';
import { resolveWalletSigningScope } from './walletSigningScope.js';
import {
  computeArgsHash,
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

export function buildRelayPayloadOptions({ runtime = null, transactionBody = {}, signatures = [] } = {}) {
  const options = [];
  const allowRawRelay = runtime == null ? true : Boolean(runtime?.relayRawEnabled);
  const rawTransaction = sanitizeHex(
    transactionBody?.rawTransaction || transactionBody?.raw_transaction || transactionBody?.txHex || ''
  );
  let metaInvocation = null;
  try {
    metaInvocation = selectSignedInvocation({ transactionBody, signatures, morpheusNetwork: runtime?.morpheusNetwork, networkMagic: runtime?.networkMagic });
  } catch (_) {
    return []; // Untrusted collaboration metadata must block submission, never break rendering.
  }

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
  // A staged body carries the V3 envelope or nothing. The previous V1/V2 fallback built an
  // invocation naming an entrypoint no deployed contract exports, which the relay now refuses at
  // validation; refusing here keeps the caller from staging a draft that can never be submitted.
  const v3Invocation = buildExecuteUserOpInvocation({
    aaContractHash,
    account,
    operationBody,
    signerAddress,
  });
  const clientInvocation = v3Invocation;
  if (!clientInvocation) {
    throw new Error(EC.v3AccountRequired);
  }

  return cloneImmutable({
    version: 1,
    network: resolveNetworkLabel(network, morpheusNetwork),
    accountAddressScriptHash: account.accountAddressScriptHash || '',
    accountIdHash: account.accountIdHash || '',
    kind: operationBody?.kind || 'invoke',
    requiresProxyWitness: Boolean(operationBody?.metadata?.requiresProxyWitness),
    clientInvocation,
    v3Invocation,
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

function proxySourcedCalls(transactionBody, invocation) {
  const proxy = transactionBody?.accountAddressScriptHash;
  const args = invocation?.args || [];
  // Only the deployed V3 envelopes are decoded here. A V1/V2 envelope is refused earlier, by
  // selectSignedInvocation; decoding it here as well would keep the dead names in the client for no
  // reachable caller.
  let calls = [{ method: invocation?.operation, args }];
  if (['executeUserOp', 'executeSponsoredUserOp'].includes(invocation?.operation)) {
    calls = [{ method: args[1]?.value?.[1]?.value, args: args[1]?.value?.[2]?.value }];
  } else if (['executeUserOps', 'executeSponsoredUserOps'].includes(invocation?.operation)) {
    calls = (args[1]?.value || []).map((op) => ({ method: op?.value?.[1]?.value, args: op?.value?.[2]?.value }));
  }
  return calls.filter((call) => isProxySourcedTransfer({
    method: call.method,
    from: call.args?.[0]?.type === 'Hash160' ? call.args[0].value : '',
    proxy,
  }));
}

function proxyWitnessRequired(transactionBody, invocation) {
  return Boolean(transactionBody?.requiresProxyWitness) || proxySourcedCalls(transactionBody, invocation).length > 0;
}

function decodeHash160StackHex(item) {
  if (item?.type === 'Hash160' && item.value) return sanitizeHex(item.value);
  if (item?.type === 'ByteString' && item.value) {
    const binary = globalThis.atob ? globalThis.atob(item.value) : '';
    const raw = Array.from(binary, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return raw ? Array.from(raw.match(/../g) || []).reverse().join('') : '';
  }
  return '';
}

async function readProxyScopeStateWith({ rpcUrl, coreHash, accountId, fetchImpl }) {
  const read = async (operation) => {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'invokefunction',
        params: [coreHash, operation, [{ type: 'Hash160', value: `0x${accountId}` }]],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const result = payload?.result;
    if (payload?.error || result?.state !== 'HALT') throw new Error('Proxy witness requires a successful core scope read');
    return decodeHash160StackHex(result?.stack?.[0]);
  };
  return {
    expectedProxyHash: await read('getProxyScriptHash'),
    scopeTarget: await read('getVerifyScopeTarget'),
    // Whether the owner is checked inside a verifier decides which scopes a wallet may be asked
    // for. It is read from the same core in the same call as the scope state, so the decision and
    // the transaction cannot disagree about the account.
    verifierHash: await read('getVerifier'),
  };
}

/**
 * The browser-wallet signing path for an account that moves its own assets. It is the SDK builder's
 * transaction: the shape-bound executeUserOp(s) script, the wallet's fee-payer signer in a custom
 * scope a browser wallet will accept, and the proxy verification witness the dApp attaches after the
 * wallet has signed. The scope target and the core's own proxy derivation are read from the chain;
 * neither is taken from the draft or from any other client-supplied field.
 */
export async function buildClientProxyWitnessTransaction({
  transactionBody = {},
  invocation = null,
  feePayer = '',
  rpcUrl = RUNTIME_CONFIG.rpcUrl,
  feePayerScope,
  feePayerAllowedContracts = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = invocation || cloneImmutable(transactionBody?.clientInvocation || transactionBody?.v3Invocation || {});
  if (!target?.scriptHash || !target?.operation) throw new Error(EC.clientInvocationMissing);
  const args = target.args || [];
  if (args[0]?.type !== 'Hash160') throw new Error(EC.clientInvocationMissing);
  const accountId = sanitizeHex(args[0].value);
  const coreHash = sanitizeHex(target.scriptHash);
  // One chain read serves both the transaction and the scope decision: the resolver asks for the
  // account state once and the same answer is reused below, so a verifier change between two
  // reads cannot produce a request and a transaction that disagree.
  let chainState = null;
  const built = await resolveProxyWitnessTransaction({
    coreHash,
    accountId,
    invocation: target,
    feePayer: sanitizeHex(feePayer),
    feePayerScope: 'CalledByEntry',
    readState: async (request) => {
      chainState = await readProxyScopeStateWith({ rpcUrl, coreHash, accountId: request.accountId, fetchImpl });
      return chainState;
    },
  });
  // The script reaches the core (which calls the target), so both are inside the witness scope.
  const decision = resolveWalletSigningScope({
    verifierHash: chainState && chainState.verifierHash,
    requestedScope: feePayerScope,
    contractsCalled: [coreHash, built.targetContract],
    allowedContracts: feePayerAllowedContracts || undefined,
  });
  return buildProxyWalletSignRequest({
    transaction: built,
    scope: decision.scope,
    allowedContracts: decision.allowedContracts ? [...decision.allowedContracts] : undefined,
  });
}

export function buildClientBroadcastRequest({
  signerAddress = '',
  transactionBody = {},
  signatures = [],
  morpheusNetwork = RUNTIME_CONFIG.morpheusNetwork,
  networkMagic,
  proxyWitnessTransaction = null,
} = {}) {
  const signed = selectSignedInvocation({ transactionBody, signatures, morpheusNetwork, networkMagic });
  if (signed && !transactionBody?.clientInvocation && !transactionBody?.v3Invocation) {
    throw new Error('Draft signed invocation mismatch: client submission requires a staged operation anchor');
  }
  const invocation = signed || cloneImmutable(transactionBody?.clientInvocation || {});
  // Only the staged body may prescribe witnesses; collaborator metadata cannot.
  if (signed && transactionBody?.clientInvocation?.signers) {
    invocation.signers = cloneImmutable(transactionBody.clientInvocation.signers);
  }
  if (!invocation.scriptHash || !invocation.operation) {
    throw new Error(EC.clientInvocationMissing);
  }
  // The selector refuses a wrapper the deployed ABI does not export but returns null for an
  // envelope it cannot read; without this guard the fallback above would still hand that envelope
  // to the wallet.
  if (!isDeployedEntrypoint(invocation.operation)) {
    throw new Error(EC.clientInvocationMissing);
  }

  if (!Array.isArray(invocation.signers) || invocation.signers.length === 0) {
    if (!signerAddress) {
      throw new Error(EC.signerRequired);
    }
    invocation.signers = [{ account: signerAddress, scopes: 1 }];
  }

  // An account that moves its own assets is authorized by the proxy verification witness, which the
  // SDK builder alone assembles. The request carries its script, its two signers and that witness so
  // a wallet that can sign a built transaction completes the move; without a built transaction the
  // client path must not pretend an ordinary invoke would move anything.
  if (proxyWitnessRequired(transactionBody, invocation)) {
    if (!proxyWitnessTransaction) {
      throw new Error('Account asset transfers require a proxy witness built by the SDK; call buildClientProxyWitnessTransaction before broadcasting from the client.');
    }
    invocation.script = proxyWitnessTransaction.script;
    invocation.signers = cloneImmutable([...proxyWitnessTransaction.signers]);
    invocation.proxyWitness = cloneImmutable(proxyWitnessTransaction.proxyWitness);
    // What the wallet is asked for, in both spellings: the label this workspace uses and the bit
    // mask the wallet signs against. Nothing here is taken from request metadata.
    invocation.walletSignRequest = cloneImmutable({
      scope: proxyWitnessTransaction.feePayerSigner.scopes,
      allowedContracts: proxyWitnessTransaction.feePayerSigner.allowedContracts
        ? cloneImmutable([...proxyWitnessTransaction.feePayerSigner.allowedContracts])
        : undefined,
      signers: cloneImmutable([...proxyWitnessTransaction.signers]),
    });
  }

  return invocation;
}

export function buildRelayBroadcastRequest({ relayEndpoint = '', relayPayloadMode = 'best', relayRawEnabled = true, transactionBody = {}, signatures = [], morpheusNetwork = RUNTIME_CONFIG.morpheusNetwork, networkMagic } = {}) {
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
  const metaInvocation = selectSignedInvocation({ transactionBody, signatures, morpheusNetwork, networkMagic });
  if (rawTransaction && !relayRawEnabled && relayPayloadMode !== 'meta') {
    throw new Error(`${EC.rawRelayDisabled}: raw relay forwarding is not enabled`);
  }
  const availableModes = buildRelayPayloadOptions({ runtime: { relayRawEnabled, morpheusNetwork, networkMagic }, transactionBody, signatures });
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
  networkMagic,
  deps = {},
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
      buildRelayBroadcastRequest({ relayEndpoint, relayPayloadMode, relayRawEnabled, transactionBody, signatures, morpheusNetwork, networkMagic })
    );
    // The relay answers a broadcast it refused (a VM fault in its preview, a token transfer that returned false)
    // with HTTP 200, ok:false and no txid. That is not a submission: callers must not report it as sent.
    if (response?.ok === false) {
      throw new Error(String(response.exception || response.message || EC.operationFailed));
    }
    return response;
  }

  // An account that moves its own assets is authorized by the proxy verification witness. That
  // witness is assembled by the SDK builder and attached to a transaction the wallet signs; a wallet
  // invoke API that cannot carry it would send a transfer that returns false and still burn the fee,
  // so the client path refuses rather than submit one. The built transaction is still produced and
  // returned on the error so a wallet with a real signing path can complete the move.
  let proxyWitnessTransaction = null;
  const stagedInvocation = selectSignedInvocation({ transactionBody, signatures, morpheusNetwork, networkMagic })
    || cloneImmutable(transactionBody?.clientInvocation || transactionBody?.v3Invocation || {});
  if (proxyWitnessRequired(transactionBody, stagedInvocation)) {
    proxyWitnessTransaction = await (deps.buildClientProxyWitnessTransaction || buildClientProxyWitnessTransaction)({
      transactionBody,
      invocation: stagedInvocation,
      feePayer: signerAddress,
      rpcUrl: walletService.rpcUrl,
    });
    if (walletService.supportsProxyWitness !== true) {
      const error = new Error('Account asset transfers require a proxy witness. The connected wallet cannot attach this verification script; use a relay with proxy witness support or a wallet that signs a built transaction.');
      error.proxyWitnessTransaction = proxyWitnessTransaction;
      throw error;
    }
  }

  const request = buildClientBroadcastRequest({
    signerAddress, transactionBody, signatures, morpheusNetwork, networkMagic, proxyWitnessTransaction,
  });
  const typedRecords = signatures.filter((item) => item?.metadata?.metaInvocation && item?.metadata?.typedData);
  if (request.operation === 'executeUserOp' && typedRecords.length) {
    // Metadata hashes are untrusted. Recompute the actual staged argument hash with the target core.
    const hash = await (deps.computeArgsHash || computeArgsHash)({ rpcUrl: walletService.rpcUrl, aaContractHash: request.scriptHash, args: request.args[1].value[2].value });
    if (typedRecords.some((item) => sanitizeHex(item.metadata.typedData.message?.argsHash) !== sanitizeHex(hash))) {
      throw new Error('Draft signed invocation mismatch: on-chain arguments hash');
    }
  }
  return walletService.invoke(request);
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
