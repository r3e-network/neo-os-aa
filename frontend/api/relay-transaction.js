import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DEFAULT_ABSTRACT_ACCOUNT_HASH, DEFAULT_ABSTRACT_ACCOUNT_HASH_TESTNET, resolveAbstractAccountHash, resolveOptionalBoolean } from '../src/config/runtimeConfig.js';
import { sanitizeHex } from '../src/utils/hex.js';
import { TRANSFER_RETURNED_FALSE_MESSAGE, findFailedTransferInInvocation } from '../src/shared/transferOutcome.mjs';
import { convertContractParamFromJson, normalizeRelayPayload, sanitizeMetaInvocationForRelay } from './relayHelpers.js';
import { attachRequestId, beginDurableRequest, completeDurableRequest, failDurableRequest } from './requestDurability.js';
import { checkRateLimit, resolveClientIp, resolveRateLimitFailure, sanitizeError } from './rateLimiter.js';
import { resolveMorpheusOracleCvmId, resolveMorpheusPaymasterEndpoint, resolveMorpheusRuntimeToken, resolveNetwork } from './morpheus-base.js';
import { apiFetch } from './outboundFetch.js';

const RAW_TRANSACTION_PATTERN = /^(0x)?[0-9a-fA-F]+$/;
const MAX_RAW_TRANSACTION_LENGTH = 200000;
// Stable code of the verdict "the simulated token transfer returned false" (see transferRefusal below).
const RELAY_TRANSFER_RETURNED_FALSE_CODE = 'relay_transfer_returned_false';

function getSdkRequire() {
  return createRequire(new URL('../../sdk/js/package.json', import.meta.url));
}

async function getNetworkMagic(rpcClient, rpc) {
  const version = typeof rpcClient?.getVersion === 'function'
    ? await rpcClient.getVersion()
    : await rpcClient.execute(new rpc.Query({ method: 'getversion' }));
  const magic = version?.protocol?.network;
  if (!magic) {
    throw new Error('Missing network magic');
  }
  return magic;
}

function loadRelayInvocationContext({ rpcUrl, relayWif }) {
  const sdkRequire = getSdkRequire();
  const { rpc, tx, wallet, sc, u } = sdkRequire('@cityofzion/neon-js');
  const rpcClient = new rpc.RPCClient(rpcUrl);
  const account = new wallet.Account(relayWif);
  return { rpc, tx, wallet, sc, u, rpcClient, account };
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHash(value) {
  const hex = sanitizeHex(value || '');
  return /^[0-9a-f]{40}$/.test(hex) ? `0x${hex}` : '';
}

// L2: stack-trace/raw-error leakage is a server security switch — it must read server-only
// env. VITE_* vars are inlined into the client build, so VITE_AA_RELAY_INCLUDE_RAW_ERRORS is
// deliberately no longer honored here.
export function shouldIncludeRawRelayErrors() {
  return resolveOptionalBoolean(process.env.AA_RELAY_INCLUDE_RAW_ERRORS, false);
}

function shouldAllowUnsponsoredRelay() {
  return resolveOptionalBoolean(process.env.AA_RELAY_ALLOW_UNSPONSORED, false);
}

function resolvePositiveBigIntEnv(name) {
  const raw = trimString(process.env[name] || '');
  if (!raw) return null;
  let parsed;
  try {
    parsed = BigInt(raw);
  } catch {
    return null;
  }
  return parsed > 0n ? parsed : null;
}

function resolveMaxSystemFee() {
  return resolvePositiveBigIntEnv('AA_RELAY_MAX_SYSTEM_FEE');
}

function resolveMaxNetworkFee() {
  return resolvePositiveBigIntEnv('AA_RELAY_MAX_NETWORK_FEE');
}

function resolveMaxTotalFee() {
  return resolvePositiveBigIntEnv('AA_RELAY_MAX_TOTAL_FEE');
}

// A sponsored relay must never default to unbounded spend from its WIF. The
// operator has to bound the per-op cost via at least one of: a systemFee cap,
// a networkFee cap, or a combined total-fee cap.
//
// NOTE (deferred): these env-driven ceilings + the off-chain approval binding
// are pragmatic hardening. The durable fix is to reroute sponsored broadcasts
// through an on-chain executeSponsored budget so the relay is reimbursed (or
// pre-funded) from a contract-enforced allowance rather than spending its own
// WIF on every op. That rerouting is intentionally out of scope here.
function hasConfiguredFeeCeiling() {
  return Boolean(resolveMaxSystemFee() || resolveMaxNetworkFee() || resolveMaxTotalFee());
}

function toBigIntOrNull(value) {
  if (value == null) return null;
  try {
    if (typeof value === 'bigint') return value;
    const text = trimString(typeof value === 'number' ? String(value) : value);
    if (!text || !/^-?\d+$/.test(text)) return null;
    return BigInt(text);
  } catch {
    return null;
  }
}

// Enforce every configured spend ceiling against a concrete systemFee +
// networkFee pair before the funded transaction is signed/broadcast. Throws a
// descriptive error on the first breach so the relay fails closed. Caps are
// read from the environment; `approvedMaxFee` is the per-op ceiling carried by
// a paymaster approval (if any).
export function enforceRelayFeePolicy({ operation = 'relay', systemFee, networkFee, approvedMaxFee } = {}) {
  const maxSystemFee = resolveMaxSystemFee();
  const maxNetworkFee = resolveMaxNetworkFee();
  const maxTotalFee = resolveMaxTotalFee();
  const approvedMax = toBigIntOrNull(approvedMaxFee);

  const systemFeeBig = toBigIntOrNull(systemFee);
  if (maxSystemFee != null && (systemFeeBig == null || systemFeeBig > maxSystemFee)) {
    throw new Error(`${operation} systemFee ${systemFee} exceeds AA_RELAY_MAX_SYSTEM_FEE ${maxSystemFee.toString()}`);
  }

  const networkFeeBig = toBigIntOrNull(networkFee);
  if (maxNetworkFee != null && (networkFeeBig == null || networkFeeBig > maxNetworkFee)) {
    throw new Error(`${operation} networkFee ${networkFee} exceeds AA_RELAY_MAX_NETWORK_FEE ${maxNetworkFee.toString()}`);
  }

  if (maxTotalFee != null || approvedMax != null) {
    if (systemFeeBig == null || networkFeeBig == null) {
      throw new Error(`${operation} total fee could not be determined for the configured fee ceiling`);
    }
    const totalFeeBig = systemFeeBig + networkFeeBig;
    if (maxTotalFee != null && totalFeeBig > maxTotalFee) {
      throw new Error(`${operation} total fee ${totalFeeBig.toString()} exceeds AA_RELAY_MAX_TOTAL_FEE ${maxTotalFee.toString()}`);
    }
    if (approvedMax != null && totalFeeBig > approvedMax) {
      throw new Error(`${operation} total fee ${totalFeeBig.toString()} exceeds paymaster-approved maximum ${approvedMax.toString()}`);
    }
  }

  return {
    systemFee: systemFeeBig != null ? systemFeeBig.toString() : String(systemFee),
    networkFee: networkFeeBig != null ? networkFeeBig.toString() : String(networkFee),
  };
}

// Extract a sponsored/approved maximum fee (in GAS fractions) from a paymaster
// approval payload, tolerating the field-name variants the service may emit.
function resolveApprovalMaxFee(approval) {
  if (!approval || typeof approval !== 'object') return null;
  const candidates = [
    approval.approved_max_fee,
    approval.approvedMaxFee,
    approval.max_fee,
    approval.maxFee,
    approval.sponsored_max_fee,
    approval.sponsoredMaxFee,
    approval.approved_amount,
    approval.approvedAmount,
    approval.max_total_fee,
    approval.maxTotalFee,
  ];
  for (const candidate of candidates) {
    const parsed = toBigIntOrNull(candidate);
    if (parsed != null && parsed > 0n) return parsed;
  }
  return null;
}

function sha256Hex(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
}

function relayFingerprint({ payload = {}, normalized = {}, simulate = false, paymaster = null } = {}) {
  return {
    mode: normalized.mode || '',
    rawTransaction: normalized.rawTransaction || '',
    metaInvocation: normalized.metaInvocation || null,
    simulate: Boolean(simulate),
    paymaster: paymaster || null,
    relayPayloadMode: payload?.relayPayloadMode || '',
  };
}

function sendJson(res, statusCode, payload, requestId) {
  if (requestId) {
    res.setHeader?.('X-Request-Id', requestId);
  }
  res.status(statusCode).json(attachRequestId(payload, requestId));
}

function resolveRelayEnv(network, key) {
  const upper = network === 'testnet' ? 'TESTNET' : 'MAINNET';
  return trimString(
    process.env[`AA_RELAY_${upper}_${key}`]
      || process.env[`AA_RELAY_${key}`]
      || ''
  );
}

function resolveRelayNetwork({ req = {}, requestPayload = {}, paymaster = null } = {}) {
  const payload = requestPayload && typeof requestPayload === 'object' ? requestPayload : {};
  const paymasterConfig = paymaster && typeof paymaster === 'object' ? paymaster : {};
  return resolveNetwork({
    query: {
      ...(req?.query || {}),
      morpheus_network:
        payload?.morpheus_network
        || paymasterConfig?.morpheus_network
        || paymasterConfig?.network
        || req?.query?.morpheus_network,
    },
    body: {
      ...(req?.body || {}),
      morpheus_network:
        payload?.morpheus_network
        || paymasterConfig?.morpheus_network
        || paymasterConfig?.network
        || req?.body?.morpheus_network,
    },
    headers: req?.headers || {},
  });
}

function resolveAllowedAaContractHash(network) {
  const defaultHash = network === 'testnet'
    ? DEFAULT_ABSTRACT_ACCOUNT_HASH_TESTNET
    : DEFAULT_ABSTRACT_ACCOUNT_HASH;
  // L2: the relay allowlist is a server security boundary — it gates which contract the
  // operator WIF will fund invocations against. Only server env or the compiled canonical
  // default may set it; the VITE_* client-build fallbacks are deliberately removed.
  return resolveAbstractAccountHash(
    resolveRelayEnv(network, 'ALLOWED_HASH')
      || defaultHash,
    defaultHash,
  );
}

export function resolveRelayExecutionConfig({ req = {}, requestPayload = {}, paymaster = null } = {}) {
  const network = resolveRelayNetwork({ req, requestPayload, paymaster });
  return {
    network,
    rpcUrl: trimString(
      resolveRelayEnv(network, 'RPC_URL')
        || process.env.VITE_AA_RELAY_RPC_URL
        || process.env.VITE_NEO_RPC_URL
        || ''
    ),
    relayWif: trimString(resolveRelayEnv(network, 'WIF') || ''),
    allowedAaContractHash: resolveAllowedAaContractHash(network),
    // L2: raw-forward enable is a server security switch — server-only env, no VITE_ fallback.
    allowRawRelayForwarding: resolveOptionalBoolean(
      resolveRelayEnv(network, 'ALLOW_RAW_FORWARD'),
      false,
    ),
  };
}

function hasExplicitPaymasterConfig(network) {
  const upper = network === 'testnet' ? 'TESTNET' : 'MAINNET';
  // Only an operator-set endpoint/token/app id counts as "configured". The
  // public registry fallback URL must not silently enable unsponsored signing.
  return Boolean(
    trimString(process.env[`MORPHEUS_PAYMASTER_${upper}_ENDPOINT`])
      || trimString(process.env.MORPHEUS_PAYMASTER_ENDPOINT)
      || trimString(process.env.AA_PAYMASTER_ENDPOINT)
      || trimString(process.env[`MORPHEUS_PAYMASTER_${upper}_API_TOKEN`])
      || trimString(process.env.MORPHEUS_PAYMASTER_API_TOKEN)
      || trimString(process.env.AA_PAYMASTER_API_TOKEN)
      || trimString(process.env[`MORPHEUS_${upper}_PAYMASTER_APP_ID`])
      || trimString(process.env.MORPHEUS_PAYMASTER_APP_ID),
  );
}

function resolvePaymasterConfig(network) {
  const endpoint = trimString(resolveMorpheusPaymasterEndpoint(network));
  const apiToken = trimString(
    process.env[`MORPHEUS_PAYMASTER_${network === 'testnet' ? 'TESTNET' : 'MAINNET'}_API_TOKEN`]
      || process.env.MORPHEUS_PAYMASTER_API_TOKEN
      || process.env.AA_PAYMASTER_API_TOKEN
      || resolveMorpheusRuntimeToken(network)
      || ''
  );
  return {
    network,
    endpoint,
    apiToken,
    appId: trimString(resolveMorpheusOracleCvmId(network)),
    enabled: Boolean(endpoint) && hasExplicitPaymasterConfig(network),
  };
}

function paramValue(param) {
  return trimString(param?.value || '');
}

function deriveUserOpFields(userOpParam) {
  const fields = userOpParam?.type === 'Struct' && Array.isArray(userOpParam?.value)
    ? userOpParam.value
    : [];
  return {
    downstreamTarget: fields[0]?.value ? normalizeHash(fields[0].value) : '',
    downstreamMethod: paramValue(fields[1]),
  };
}

function derivePaymasterInvocationFields(metaInvocation) {
  const args = Array.isArray(metaInvocation?.args) ? metaInvocation.args : [];
  const operation = trimString(metaInvocation?.operation || '');
  // Sponsored ops share the same leading arg layout as their non-sponsored
  // counterparts (accountId, op|ops, paymaster, sponsor, reimbursementAmount),
  // so the downstream target/method are derived identically. The on-chain
  // budget (CapReimbursement / MaxPerOp / DailyBudget) is enforced by the
  // contract itself; this off-chain derivation only feeds an optional paymaster
  // authorization request and the relay's own fee-cap policy.
  if (operation === 'executeUserOp' || operation === 'executeSponsoredUserOp') {
    const userOp = deriveUserOpFields(args[1]);
    return {
      accountId: args[0]?.value ? normalizeHash(args[0].value) : '',
      downstreamTarget: userOp.downstreamTarget,
      downstreamMethod: userOp.downstreamMethod,
    };
  }
  if (operation === 'executeUserOps' || operation === 'executeSponsoredUserOps') {
    const userOps = args[1]?.type === 'Array' && Array.isArray(args[1]?.value)
      ? args[1].value.map(deriveUserOpFields)
      : [];
    const first = userOps[0] || {};
    const isHomogeneous = userOps.length > 0
      && first.downstreamTarget
      && first.downstreamMethod
      && userOps.every((item) => item.downstreamTarget === first.downstreamTarget && item.downstreamMethod === first.downstreamMethod);
    return {
      accountId: args[0]?.value ? normalizeHash(args[0].value) : '',
      downstreamTarget: isHomogeneous ? first.downstreamTarget : '',
      downstreamMethod: isHomogeneous ? first.downstreamMethod : '',
      batchSize: userOps.length,
    };
  }
  if (operation === 'executeUnified' || operation === 'executeUnifiedByAddress') {
    return {
      accountId: args[0]?.value ? normalizeHash(args[0].value) : '',
      downstreamTarget: args[1]?.value ? normalizeHash(args[1].value) : '',
      downstreamMethod: paramValue(args[2]),
    };
  }
  return {
    accountId: '',
    downstreamTarget: '',
    downstreamMethod: '',
  };
}

export function buildPaymasterRequest({ metaInvocation, paymaster = {}, estimatedGasUnits = 0, network }) {
  const { accountId, downstreamTarget, downstreamMethod, batchSize = 0 } = derivePaymasterInvocationFields(metaInvocation);
  if (!accountId || !downstreamTarget || !downstreamMethod) {
    throw new Error('Paymaster authorization requires a supported account-bound operation with downstream target and method.');
  }

  const request = {
    network,
    target_chain: 'neo_n3',
    account_id: accountId,
    dapp_id: trimString(paymaster.dapp_id || paymaster.dappId || ''),
    target_contract: `0x${sanitizeHex(metaInvocation?.scriptHash || '')}`,
    method: trimString(metaInvocation?.operation || ''),
    userop_target_contract: downstreamTarget,
    userop_method: downstreamMethod,
    estimated_gas_units: Number(paymaster.estimated_gas_units || paymaster.estimatedGasUnits || estimatedGasUnits || 0),
    operation_hash: `0x${sha256Hex(metaInvocation)}`,
  };
  if (batchSize > 0) request.userop_batch_size = batchSize;
  return request;
}

async function maybeAuthorizePaymaster({ metaInvocation, paymaster = null, estimatedGasUnits = 0, network = 'mainnet' }) {
  const config = resolvePaymasterConfig(network);
  if (!config.enabled) {
    // Fail closed: with no paymaster the relay would sign and broadcast while
    // paying an uncapped systemFee from its own WIF. Only permit unsponsored
    // relays when an operator explicitly opts in.
    if (shouldAllowUnsponsoredRelay()) return null;
    return { approved: false, reason: 'paymaster_not_configured' };
  }

  const requestBody = buildPaymasterRequest({
    metaInvocation,
    paymaster: paymaster && typeof paymaster === 'object' ? paymaster : {},
    estimatedGasUnits,
    network: config.network,
  });

  const headers = { 'content-type': 'application/json' };
  if (config.apiToken) {
    headers.authorization = `Bearer ${config.apiToken}`;
  }

  const response = await apiFetch(config.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Paymaster authorization failed.');
  }

  return verifyPaymasterApproval(payload, requestBody.operation_hash);
}

// Bind an off-chain paymaster approval to the exact operation it sponsors
// before it can authorize a broadcast. The relay must not sign unless the
// approval is (a) positively approved (approved === true, not merely
// !== false) and (b) echoes the same operation_hash that was sent. The
// approved spend ceiling (if any) is surfaced so the signing step can enforce
// systemFee + networkFee <= approvedMax. An explicit denial passes through so
// callers can short-circuit with paymaster_denied.
export function verifyPaymasterApproval(payload, expectedOperationHash) {
  if (payload && payload.approved === false) {
    return payload;
  }
  if (!payload || payload.approved !== true) {
    throw new Error('Paymaster authorization was not positively approved.');
  }
  const expected = trimString(expectedOperationHash || '');
  const echoedHash = trimString(payload.operation_hash || payload.operationHash || '');
  if (!expected || !echoedHash || echoedHash.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Paymaster approval operation_hash does not match the relayed operation.');
  }

  const approvedMaxFee = resolveApprovalMaxFee(payload);
  return {
    ...payload,
    operation_hash: expected,
    approvedMaxFee: approvedMaxFee != null ? approvedMaxFee.toString() : undefined,
  };
}

function buildInvocationScript({ invocation, sc, u }) {
  const args = invocation.args.map((param) => convertContractParamFromJson(param, { sc, u }));
  return sc.createScript({
    scriptHash: invocation.scriptHash,
    operation: invocation.operation,
    args,
  });
}

function decodeHash160Stack(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'Hash160' && item.value) return sanitizeHex(item.value);
  if (item.type === 'ByteString' && item.value) return sanitizeHex(Buffer.from(item.value, 'base64').toString('hex'));
  return '';
}

function decodeValidationPreviewStack(item) {
  const values = item?.type === 'Array' && Array.isArray(item.value) ? item.value : [];
  return {
    deadlineValid: values?.[0]?.value === true || values?.[0]?.value === 1 || values?.[0]?.value === '1',
    nonceAcceptable: values?.[1]?.value === true || values?.[1]?.value === 1 || values?.[1]?.value === '1',
    hasVerifier: values?.[2]?.value === true || values?.[2]?.value === 1 || values?.[2]?.value === '1',
    verifier: decodeHash160Stack(values?.[3]),
    hook: decodeHash160Stack(values?.[4]),
  };
}

async function fetchValidationPreview({ rpcUrl, invocation }) {
  if (invocation?.operation !== 'executeUserOp') return null;
  if (!Array.isArray(invocation?.args) || invocation.args.length < 2) return null;

  const response = await apiFetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'invokefunction',
      params: [
        invocation.scriptHash,
        'previewUserOpValidation',
        [invocation.args[0], invocation.args[1]],
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload?.error || payload?.result?.state === 'FAULT') return null;
  return decodeValidationPreviewStack(payload?.result?.stack?.[0]);
}

function resolveInvocationSigners({ account, tx }) {
  return [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }];
}

// A token transfer that returns false HALTs, so the VM state alone calls it a success; but nothing moved and the
// transaction would still burn the account's nonce and the relay's fee (recorded on the deployed core, AA-09 cases
// 8 and 9: a session-signed GAS transfer out of the account's proxy address, where the relay is the only signer
// and the proxy is no witness). The route has no way to add the proxy witness, so it refuses what it simulated.
// Only a transfer operation with a Boolean false result is judged (src/shared/transferOutcome.mjs): false is the
// normal result of other calls, and a result that is not a Boolean says nothing. Returns the refusal body, or
// null when nothing is wrong.
function transferRefusal({ invocation, simulation, validationPreview }) {
  const stack = simulation?.stack || [];
  const failedOperations = findFailedTransferInInvocation({ invocation, stack });
  if (failedOperations.length === 0) return null;
  return {
    simulate: true,
    ok: false,
    code: RELAY_TRANSFER_RETURNED_FALSE_CODE,
    vmState: String(simulation?.state || 'HALT').toUpperCase(),
    exception: TRANSFER_RETURNED_FALSE_MESSAGE,
    operation: invocation.operation,
    gasConsumed: simulation?.gasconsumed || '0',
    stack,
    failedOperations,
    validationPreview,
  };
}

async function simulateMetaInvocation({ rpcUrl, relayWif, invocation }) {
  const { rpc, tx, sc, u, rpcClient, account } = loadRelayInvocationContext({ rpcUrl, relayWif });
  const signers = resolveInvocationSigners({ account, tx });
  const script = buildInvocationScript({ invocation, sc, u });
  const validationPreview = await fetchValidationPreview({ rpcUrl, invocation });

  const simulation = await rpcClient.invokeScript(u.HexString.fromHex(script), signers);
  if (simulation?.state === 'FAULT') {
    return {
      simulate: true,
      ok: false,
      code: 'relay_simulation_fault',
      vmState: 'FAULT',
      exception: simulation.exception || 'VM fault',
      operation: invocation.operation,
      gasConsumed: simulation?.gasconsumed || '0',
      validationPreview,
    };
  }

  const refusal = transferRefusal({ invocation, simulation, validationPreview });
  if (refusal) return refusal;

  return {
    simulate: true,
    ok: true,
    vmState: String(simulation?.state || 'HALT').toUpperCase(),
    gasConsumed: simulation?.gasconsumed || '0',
    operation: invocation.operation,
    stack: simulation?.stack || [],
    validationPreview,
  };
}

async function relayMetaInvocation({ rpcUrl, relayWif, invocation, feePolicy = {} }) {
  const { rpc, tx, sc, u, rpcClient, account } = loadRelayInvocationContext({ rpcUrl, relayWif });
  const magic = await getNetworkMagic(rpcClient, rpc);
  const signers = resolveInvocationSigners({ account, tx });
  const script = buildInvocationScript({ invocation, sc, u });

  const simulation = await rpcClient.invokeScript(u.HexString.fromHex(script), signers);
  if (simulation?.state === 'FAULT') {
    throw new Error(`${invocation.operation} simulation fault: ${simulation.exception || 'VM fault'}`);
  }

  // The simulation that prices the transaction is judged too: the preview ran earlier and the chain may have moved.
  // Nothing is priced, signed or broadcast for a transfer that returned false.
  const refusal = transferRefusal({ invocation, simulation });
  if (refusal) return { refusal };

  const systemFee = simulation?.gasconsumed || '1000000';
  // The relay pays systemFee from its own WIF, so cap it before doing any more
  // work and fail closed on an unparseable/over-cap value.
  const maxSystemFee = resolveMaxSystemFee();
  const systemFeeBig = toBigIntOrNull(systemFee);
  if (maxSystemFee != null && (systemFeeBig == null || systemFeeBig > maxSystemFee)) {
    throw new Error(`${invocation.operation} systemFee ${systemFee} exceeds AA_RELAY_MAX_SYSTEM_FEE ${maxSystemFee.toString()}`);
  }

  const validUntilBlock = (await rpcClient.getBlockCount()) + 1000;
  const basePayload = {
    signers,
    validUntilBlock,
    script,
    systemFee,
  };

  let transaction = new tx.Transaction(basePayload);
  transaction.sign(account, magic);
  const networkFee = await rpcClient.calculateNetworkFee(transaction);

  // networkFee (calculateNetworkFee) is otherwise unbounded; enforce the
  // systemFee/networkFee/total caps plus any per-op ceiling carried by the
  // paymaster approval BEFORE the funded transaction is re-signed and broadcast.
  enforceRelayFeePolicy({
    operation: invocation.operation,
    systemFee,
    networkFee: networkFee?.toString?.() ?? networkFee,
    approvedMaxFee: feePolicy?.approvedMaxFee,
  });

  transaction = new tx.Transaction({
    ...basePayload,
    networkFee,
  });
  transaction.sign(account, magic);

  const txid = await rpcClient.sendRawTransaction(transaction);
  return {
    txid,
    networkFee: networkFee?.toString?.() || String(networkFee),
    systemFee: systemFee || '0',
    invocation: {
      scriptHash: invocation.scriptHash,
      operation: invocation.operation,
    },
  };
}

export default async function handler(req, res) {
  const requestPayload = req.body || {};
  const normalized = normalizeRelayPayload(requestPayload);
  const simulate = Boolean(requestPayload?.simulate);
  const paymasterInput = requestPayload?.paymaster && typeof requestPayload.paymaster === 'object' ? requestPayload.paymaster : null;
  const durable = await beginDurableRequest({
    req,
    routeName: 'relay_transaction',
    payload: requestPayload,
    fingerprint: relayFingerprint({ payload: requestPayload, normalized, simulate, paymaster: paymasterInput }),
  });
  const requestId = durable.context.requestId;

  if (!durable.ok) {
    if (durable.replayed) {
      return sendJson(res, durable.cached.status, durable.cached.body, requestId);
    }
    if (durable.inProgress) {
      return sendJson(res, 409, { error: 'request_in_progress' }, requestId);
    }
  }

  if (req.method !== 'POST') {
    await failDurableRequest(durable.context, { statusCode: 405, error: 'method_not_allowed', phase: 'method' });
    return sendJson(res, 405, { error: 'method_not_allowed' }, requestId);
  }

  const clientIp = resolveClientIp(req);
  const rateLimit = await checkRateLimit(clientIp);
  
  if (!rateLimit.allowed) {
    const failure = resolveRateLimitFailure(rateLimit);
    if (failure.retryAfter) res.setHeader?.('Retry-After', String(failure.retryAfter));
    await failDurableRequest(durable.context, { statusCode: failure.statusCode, error: failure.error, phase: 'rate_limit' });
    return sendJson(res, failure.statusCode, {
      error: failure.error,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
    }, requestId);
  }

  const relayConfig = resolveRelayExecutionConfig({
    req,
    requestPayload,
    paymaster: paymasterInput,
  });
  const { rpcUrl, relayWif, allowedAaContractHash, allowRawRelayForwarding } = relayConfig;
  if (!rpcUrl) {
    await failDurableRequest(durable.context, { statusCode: 501, error: 'relay_not_configured', phase: 'config' });
    return sendJson(res, 501, { error: 'relay_not_configured' }, requestId);
  }

  if (normalized.mode === 'raw') {
    if (!allowRawRelayForwarding) {
      await failDurableRequest(durable.context, { statusCode: 403, error: 'raw_relay_not_enabled', phase: 'validation' });
      return sendJson(res, 403, { error: 'raw_relay_not_enabled' }, requestId);
    }

    if (!normalized.rawTransaction) {
      await failDurableRequest(durable.context, { statusCode: 400, error: 'missing_raw_transaction', phase: 'validation' });
      return sendJson(res, 400, { error: 'missing_raw_transaction' }, requestId);
    }

    if (!RAW_TRANSACTION_PATTERN.test(normalized.rawTransaction) || normalized.rawTransaction.length > MAX_RAW_TRANSACTION_LENGTH) {
      await failDurableRequest(durable.context, { statusCode: 400, error: 'invalid_raw_transaction', phase: 'validation' });
      return sendJson(res, 400, { error: 'invalid_raw_transaction' }, requestId);
    }

    if (simulate) {
      const body = {
        simulate: true,
        ok: false,
        supported: false,
        code: 'simulation_not_supported_for_raw',
        message: 'Simulation is only available for relay-ready meta invocations.',
      };
      await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(body, requestId) });
      return sendJson(res, 200, body, requestId);
    }

    try {
      const response = await apiFetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendrawtransaction',
          params: [normalized.rawTransaction],
        }),
      });
      const payload = await response.json();
      if (payload?.error) {
        await failDurableRequest(durable.context, { statusCode: 502, error: 'relay_rpc_error', phase: 'raw_relay' });
        return sendJson(res, 502, { error: 'relay_rpc_error', details: payload.error }, requestId);
      }

      const result = payload?.result;
      const txid = typeof result === 'string'
        ? result
        : result?.hash || result?.txid || null;

      const body = { txid, result: result ?? null };
      await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(body, requestId) });
      return sendJson(res, 200, body, requestId);
    } catch (error) {
      const body = {
        error: 'relay_network_error',
        message: sanitizeError(error),
      };
      await failDurableRequest(durable.context, { statusCode: 502, error: body.error, phase: 'raw_relay' });
      return sendJson(res, 502, body, requestId);
    }
  }

  if (!requestPayload?.metaInvocation && !requestPayload?.meta_invocation) {
    await failDurableRequest(durable.context, { statusCode: 400, error: 'missing_meta_invocation', phase: 'validation' });
    return sendJson(res, 400, { error: 'missing_meta_invocation' }, requestId);
  }

  const metaInvocation = requestPayload?.metaInvocation || requestPayload?.meta_invocation;
  const sanitizedMetaInvocation = sanitizeMetaInvocationForRelay(metaInvocation, {
    aaContractHash: allowedAaContractHash,
  });
  if (!sanitizedMetaInvocation) {
    await failDurableRequest(durable.context, { statusCode: 400, error: 'relay_meta_invocation_not_allowed', phase: 'validation' });
    return sendJson(res, 400, { error: 'relay_meta_invocation_not_allowed' }, requestId);
  }

  if (!relayWif) {
    await failDurableRequest(durable.context, { statusCode: 501, error: 'relay_signer_not_configured', phase: 'config' });
    return sendJson(res, 501, { error: 'relay_signer_not_configured' }, requestId);
  }

  // Fail closed before any sign/broadcast: without a configured paymaster the
  // relay would pay an uncapped systemFee from its own WIF for an unsponsored
  // operation. Block the broadcast path unless an operator explicitly opts in.
  // (Read-only simulations carry no funds risk and still report the denial.)
  if (!simulate
    && !resolvePaymasterConfig(relayConfig.network).enabled
    && !shouldAllowUnsponsoredRelay()) {
    const body = {
      error: 'paymaster_denied',
      message: 'Paymaster denied sponsorship.',
      paymaster: { approved: false, reason: 'paymaster_not_configured' },
    };
    await failDurableRequest(durable.context, { statusCode: 402, error: 'paymaster_denied', phase: 'paymaster' });
    return sendJson(res, 402, body, requestId);
  }

  // When the relay is about to sponsor a broadcast (configured paymaster or an
  // explicit unsponsored opt-in), there must be at least one configured fee
  // ceiling so the WIF can never be drained by an unbounded systemFee +
  // networkFee. Fail closed if none is set rather than defaulting to no cap.
  if (!simulate && !hasConfiguredFeeCeiling()) {
    const body = {
      error: 'relay_fee_ceiling_not_configured',
      message: 'A relay fee ceiling (AA_RELAY_MAX_SYSTEM_FEE, AA_RELAY_MAX_NETWORK_FEE, or AA_RELAY_MAX_TOTAL_FEE) must be configured before sponsoring a broadcast.',
    };
    await failDurableRequest(durable.context, { statusCode: 400, error: body.error, phase: 'config' });
    return sendJson(res, 400, body, requestId);
  }

  let failurePhase = simulate ? 'simulation' : 'preview';
  try {
    if (simulate) {
      const result = await simulateMetaInvocation({
        rpcUrl,
        relayWif,
        invocation: sanitizedMetaInvocation,
      });
      const paymaster = await maybeAuthorizePaymaster({
        metaInvocation: sanitizedMetaInvocation,
        paymaster: paymasterInput,
        estimatedGasUnits: Number(result?.gasConsumed || 0),
        network: relayConfig.network,
      });
      if (paymaster && paymaster.approved === false) {
        const body = {
          ...result,
          ok: false,
          code: 'paymaster_denied',
          exception: paymaster.reason || 'Paymaster denied sponsorship.',
          paymaster,
        };
        await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(body, requestId) });
        return sendJson(res, 200, body, requestId);
      }
      if (paymaster) {
        const body = { ...result, paymaster };
        await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(body, requestId) });
        return sendJson(res, 200, body, requestId);
      }
      await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(result, requestId) });
      return sendJson(res, 200, result, requestId);
    }

    const preview = await simulateMetaInvocation({
      rpcUrl,
      relayWif,
      invocation: sanitizedMetaInvocation,
    });
    if (!preview.ok) {
      await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(preview, requestId) });
      return sendJson(res, 200, preview, requestId);
    }
    failurePhase = 'paymaster';
    const paymaster = await maybeAuthorizePaymaster({
      metaInvocation: sanitizedMetaInvocation,
      paymaster: paymasterInput,
      estimatedGasUnits: Number(preview?.gasConsumed || 0),
      network: relayConfig.network,
    });
    if (paymaster && paymaster.approved === false) {
      const body = {
        error: 'paymaster_denied',
        message: paymaster.reason || 'Paymaster denied sponsorship.',
        paymaster,
      };
      await failDurableRequest(durable.context, { statusCode: 402, error: 'paymaster_denied', phase: 'paymaster' });
      return sendJson(res, 402, body, requestId);
    }

    failurePhase = 'relay';
    const result = await relayMetaInvocation({
      rpcUrl,
      relayWif,
      invocation: sanitizedMetaInvocation,
      feePolicy: { approvedMaxFee: paymaster?.approvedMaxFee },
    });
    if (result.refusal) {
      await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(result.refusal, requestId) });
      return sendJson(res, 200, result.refusal, requestId);
    }
    failurePhase = 'response';
    const body = paymaster ? { ...result, paymaster } : result;
    await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(body, requestId) });
    return sendJson(res, 200, body, requestId);
  } catch (error) {
    const rawMessage = String(error?.message || error || 'Unknown error');
    const payload = {
      error: simulate
        ? 'relay_simulation_error'
        : failurePhase === 'paymaster'
          ? 'paymaster_authorization_failed'
          : 'relay_meta_invocation_failed',
      message: sanitizeError(error),
      phase: failurePhase,
    };
    if (shouldIncludeRawRelayErrors()) {
      payload.rawMessage = rawMessage;
      payload.stack = typeof error?.stack === 'string' ? error.stack : undefined;
    }
    await failDurableRequest(durable.context, { statusCode: 502, error: payload.error, phase: failurePhase });
    return sendJson(res, 502, payload, requestId);
  }
}
