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
import { smartAccountCodec } from '../../services/smartAccountCodec.js';
import {
  computeArgsHash,
  decodeHash160Stack,
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
    draftRecord.share_slug || draftRecord.draft_id || 'smart-account-workspace'
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

/**
 * The staged intent of a draft: the operation body only. A v4 envelope cannot be
 * staged before signing — its validator instance, credential generation,
 * authority epoch and configuration nonce come from the account's current chain
 * state — so the anchor is the intent the operator approved, and every signed
 * envelope is compared against it.
 */
function normalizeOperationBody(operationBody = null) {
  if (!operationBody) return null;
  const targetContract = sanitizeHex(operationBody.targetContract || '');
  const method = String(operationBody.method || '').trim();
  if (!targetContract || !method) return null;
  return cloneImmutable({
    targetContract,
    method,
    args: Array.isArray(operationBody.args) ? operationBody.args : [],
    kind: operationBody.kind || 'invoke',
    requiresProxyWitness: Boolean(operationBody?.metadata?.requiresProxyWitness),
  });
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
  saContractHash = '',
  account = {},
  operationBody = null,
  signerAddress = '',
  rawTransaction = '',
  notes = '',
  network = '',
  morpheusNetwork = RUNTIME_CONFIG.morpheusNetwork,
  createdAt = new Date().toISOString(),
} = {}) {
  // A staged body carries the approved intent or nothing. Building an unsigned envelope here would
  // mean guessing the validator instance and the account's current epochs, and a guessed envelope is
  // exactly what the selector must not accept.
  const stagedOperation = normalizeOperationBody(operationBody);
  if (!stagedOperation) {
    throw new Error(EC.operationBodyRequired);
  }
  // A v4 operation is authorized for exactly one account: the account id is what the route read
  // and the signed envelope are matched against, so a body without one has no subject.
  const accountId = sanitizeHex(account?.accountIdHash || '');
  if (!/^[0-9a-f]{40}$/.test(accountId)) {
    throw new Error(EC.accountRequired);
  }

  return cloneImmutable({
    version: 1,
    network: resolveNetworkLabel(network, morpheusNetwork),
    accountAddressScriptHash: account.accountAddressScriptHash || '',
    accountIdHash: accountId,
    kind: operationBody?.kind || 'invoke',
    requiresProxyWitness: Boolean(operationBody?.metadata?.requiresProxyWitness),
    signerAddress: sanitizeHex(signerAddress || ''),
    operationBody: stagedOperation,
    rawTransaction: sanitizeHex(rawTransaction || ''),
    notes: String(notes || '').trim(),
    createdAt,
  });
}

export function buildDraftApprovalTypedData({ draftRecord, chainId = RUNTIME_CONFIG.networkMagic } = {}) {
  const payloadDigest = buildPayloadDigest(draftRecord);

  return {
    domain: {
      name: 'Neo Smart Account Workspace',
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

function decodeHash160Item(item) {
  if (item?.type === 'Hash160' && item.value) return sanitizeHex(item.value);
  if (item?.type === 'ByteString' && item.value) {
    const raw = sanitizeHex(item.value);
    return raw ? raw.match(/../g).reverse().join('') : '';
  }
  return '';
}

function decodeTextItem(item) {
  if (item?.type !== 'ByteString' || typeof item.value !== 'string') return '';
  const bytes = Uint8Array.from(sanitizeHex(item.value).match(/../g) || [], (pair) => Number.parseInt(pair, 16));
  return new TextDecoder().decode(bytes);
}

/** One v4 operation's transfer shape: target is field 1, method 2, args 3. */
function operationCalls(operation) {
  const fields = ['Struct', 'Array'].includes(operation?.type) ? operation.value : null;
  if (!Array.isArray(fields) || fields.length !== 13) return [];
  return [{ method: decodeTextItem(fields[2]), args: fields[3]?.value || [] }];
}

function proxySourcedCalls(transactionBody, invocation) {
  const proxy = transactionBody?.accountAddressScriptHash;
  const args = invocation?.args || [];
  let calls = [{ method: invocation?.operation, args }];
  if (invocation?.operation === 'executeUserOp') {
    calls = operationCalls(args[1]);
  } else if (invocation?.operation === 'executeUserOps') {
    calls = (args[1]?.value || []).flatMap((operation) => operationCalls(operation));
  }
  return calls.filter((call) => isProxySourcedTransfer({
    method: call.method,
    from: decodeHash160Item(call.args?.[0]),
    proxy,
  }));
}

function proxyWitnessRequired(transactionBody, invocation) {
  return Boolean(transactionBody?.requiresProxyWitness) || proxySourcedCalls(transactionBody, invocation).length > 0;
}

function decodeHash160StackHex(item) {
  // An RPC stack item carries a ByteString as base64 in the stored byte order; the shared decoder
  // reverses it into display hex. Invocation arguments use hex instead and are read with
  // decodeHash160Item above.
  return decodeHash160Stack(item);
}

/**
 * The one chain value a proxy-witness transaction needs: the address the core
 * derives for the account. The v3 scope target and verifier reads are gone — a
 * v4 operation's own target is the only authorized target, and the custody
 * witness is checked inside the core (a nested call), which is why the wallet is
 * asked for a contract scope rather than CalledByEntry.
 */
async function readProxyScopeStateWith({ rpcUrl, coreHash, accountId, fetchImpl }) {
  const read = async (operation) => {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
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
    proxyHash: await read('getProxyScriptHash'),
    // The core checks the custody witness for every route (it dispatches to the
    // validator module, a nested call), so the scope decision treats the core as
    // the contract that checks the owner.
    verifierHash: coreHash,
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
  const target = invocation || cloneImmutable(transactionBody?.metaInvocation || {});
  if (!target?.scriptHash || !target?.operation) throw new Error(EC.clientInvocationMissing);
  const args = target.args || [];
  if (args[0]?.type !== 'ByteString') throw new Error(EC.clientInvocationMissing);
  const accountId = decodeHash160Item(args[0]);
  if (!accountId) throw new Error(EC.clientInvocationMissing);
  const coreHash = sanitizeHex(target.scriptHash);
  // The proxy address is derived here, from the same preimage the core hashes, so the request is
  // pinned to a value the client computed rather than to whatever the RPC answers; a read that
  // disagrees is refused by the builder instead of producing a witness for another address.
  const derivedProxy = smartAccountCodec.accountAddress(accountId, { coreContractHash: coreHash });
  // The operation's own target is authorized by the validator signature, but the wallet's witness
  // scope must still cover every contract the script calls: the core and that target.
  const operationTarget = decodeHash160Item(args[1]?.value?.[1]) || decodeHash160Item(transactionBody?.operationBody?.targetContract);
  // One chain read serves both the transaction and the scope decision: the resolver asks for the
  // account state once and the same answer is reused below, so a proxy change between two reads
  // cannot produce a request and a transaction that disagree.
  let chainState = null;
  const built = await resolveProxyWitnessTransaction({
    coreHash,
    accountId,
    invocation: target,
    proxyHash: derivedProxy,
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
    contractsCalled: [coreHash, operationTarget].filter(Boolean),
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
  const invocation = signed || cloneImmutable(transactionBody?.metaInvocation || {});
  // Only the staged body may prescribe witnesses; collaborator metadata cannot.
  if (signed && transactionBody?.operationBody?.signers) {
    invocation.signers = cloneImmutable(transactionBody.operationBody.signers);
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
    || cloneImmutable(transactionBody?.metaInvocation || {});
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
    const hash = await (deps.computeArgsHash || computeArgsHash)({ rpcUrl: walletService.rpcUrl, saContractHash: request.scriptHash, args: request.args[1].value[3].value });
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
