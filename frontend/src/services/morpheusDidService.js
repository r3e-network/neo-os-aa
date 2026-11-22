import { RUNTIME_CONFIG } from '@/config/runtimeConfig';
import { EC } from '../config/errorCodes.js';
import { notificationService } from '@/services/notificationService';
import { invokeReadFunction, getScriptHashFromAddress } from '@/utils/neo';
import { sanitizeHex } from '@/utils/hex';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout.js';
import { encryptJsonWithMorpheusOracleKey } from '@/utils/morpheusEncryption';
import { walletService, getSmartAccountHash } from '@/services/walletService';
import { buildDelegatedIdentityParamsHex, formatDelegatedIdentityTicket, normalizeDelegatedIdentityProvider } from '@/services/delegatedIdentityService.js';
import { connectedDidProfile } from '@/utils/did';
import { decodeStackHash160 } from '@/utils/stack';
import { createAccountIdentityReader } from './saIdentityReadService.js';
import {
  decodeAccountDescriptor,
  decodeHookOrder,
  decodeModuleDescriptor,
  decodeModulePage,
  decodePendingConfiguration,
} from './smartAccountProtocol.js';
import { buildSaActionId, requireSaSigningText, toNeoInternalHex } from './saTicketService.js';

function trim(value) {
  return String(value || '').trim();
}

function toHash160Param(value) {
  return {
    type: 'Hash160',
    value: `0x${sanitizeHex(value || '')}`,
  };
}

function toStringParam(value) {
  return {
    type: 'String',
    value: String(value ?? ''),
  };
}

function toIntegerParam(value) {
  return {
    type: 'Integer',
    value: String(value ?? '0'),
  };
}

function normalizeScriptHash(value) {
  const raw = trim(value);
  if (!raw) return '';
  if (/^[Nn]/.test(raw)) {
    return sanitizeHex(getScriptHashFromAddress(raw));
  }
  return sanitizeHex(raw);
}

function requireNonZeroHash160(value, fieldName) {
  const normalized = normalizeScriptHash(value);
  if (!/^[0-9a-f]{40}$/.test(normalized) || normalized === '00'.repeat(20)) {
    throw new Error(`${fieldName} must be a non-zero 20-byte Hash160`);
  }
  return normalized;
}

function toRequiredNeoInternalHex(value, fieldName) {
  return toNeoInternalHex(requireNonZeroHash160(value, fieldName));
}

function decodeBase64ToBytes(value) {
  if (!value) return new Uint8Array();
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(value, 'base64'));
  }
  const binary = globalThis.atob ? globalThis.atob(value) : '';
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeBase64ToHex(value) {
  return Array.from(decodeBase64ToBytes(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeStackText(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'String') return typeof item.value === 'string' ? item.value : '';
  if (item.type !== 'ByteString') return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64ToBytes(item.value || ''));
  } catch (e) {
    if (import.meta.env.DEV) console.error('[morpheusDidService] UTF-8 stack decode failed:', e?.message);
    return '';
  }
}

function decodeStackItem(item) {
  if (!item || typeof item !== 'object') return null;
  switch (item.type) {
    case 'Integer':
      return String(item.value ?? '0');
    case 'Boolean':
      return Boolean(item.value);
    case 'Hash160':
      return trim(item.value || '');
    case 'ByteString': {
      const hex = decodeBase64ToHex(item.value || '');
      if (!hex) return '';
      if (hex.length === 40 || hex.length === 64) return `0x${hex}`;
      try {
        if (typeof Buffer !== 'undefined') {
          return Buffer.from(item.value || '', 'base64').toString('utf8');
        }
      } catch (e) {
        if (import.meta.env.DEV) console.error('[morpheusDidService] Buffer decode failed:', e?.message);
      }
      return `0x${hex}`;
    }
    case 'Array':
    case 'Struct':
      return Array.isArray(item.value) ? item.value.map((entry) => decodeStackItem(entry)) : [];
    default:
      return item.value ?? null;
  }
}

function getDidProfile() {
  return connectedDidProfile.value || null;
}

function buildNeoDidSubject(profile = getDidProfile()) {
  if (!profile?.provider || !profile?.idToken) return null;
  return {
    provider: profile.provider,
    provider_uid: profile.providerUid || '',
    id_token: profile.idToken,
    metadata: {
      email: profile.email || undefined,
      phone: profile.phone || undefined,
      linked_accounts: profile.linkedAccounts || [],
      aggregate_verifier: profile.aggregateVerifier || undefined,
    },
  };
}

export const fetchAccountIdentity = createAccountIdentityReader(invokeReadFunction);

async function readModuleMethod({ rpcUrl, moduleHash, operation, args = [] } = {}) {
  const result = await invokeReadFunction(rpcUrl, sanitizeHex(moduleHash), operation, args);
  if (result?.state === 'FAULT') {
    const err = new Error(EC.rpcFault);
    err.rpcDetail = result?.exception || null;
    throw err;
  }
  if (operation === 'getNetwork' || operation === 'getAccountIdText') {
    return decodeStackText(result?.stack?.[0]);
  }
  if (operation === 'getSAContract' || operation === 'getAccountAddress' || operation === 'getRecoveryService') {
    return decodeStackHash160(result?.stack?.[0]);
  }
  if (operation === 'getActiveSession') {
    const item = result?.stack?.[0];
    const decoded = decodeStackItem(item);
    if (Array.isArray(decoded) && item?.value?.[0]) decoded[0] = decodeStackHash160(item.value[0]);
    return decoded;
  }
  return decodeStackItem(result?.stack?.[0]);
}

/** Raw safe-entry item, for the decoders that need the stack shape. */
async function readAccountItem({ rpcUrl, saContractHash, operation, args = [] } = {}) {
  const result = await invokeReadFunction(rpcUrl, sanitizeHex(saContractHash), operation, args);
  if (result?.state !== 'HALT') {
    const err = new Error(EC.rpcFault);
    err.rpcDetail = result?.exception || null;
    throw err;
  }
  return result.stack?.[0];
}

const MODULE_PAGE_SIZE = 32;
const ZERO_HASH160 = '0'.repeat(40);

/**
 * Pending configuration intents (§10). Every configuration change is one
 * 24-hour intent, so the UI shows maturity and expiry instead of a verifier or
 * hook timelock that no longer exists.
 */
export async function fetchPendingConfigurationState({ rpcUrl, saContractHash, accountIdHex } = {}) {
  const core = sanitizeHex(saContractHash);
  const accountIdParam = toHash160Param(accountIdHex);
  const idItem = await readAccountItem({
    rpcUrl,
    saContractHash: core,
    operation: 'getPendingConfigurationIntentIds',
    args: [accountIdParam],
  }).catch(() => null);
  const intentIds = Array.isArray(idItem?.value)
    ? idItem.value.map((entry) => Number(entry?.value ?? 0)).filter((id) => id > 0)
    : [];
  const intents = [];
  for (const intentId of intentIds) {
    const item = await readAccountItem({
      rpcUrl,
      saContractHash: core,
      operation: 'getPendingConfiguration',
      args: [accountIdParam, toIntegerParam(intentId)],
    }).catch(() => null);
    const record = item ? decodePendingConfiguration(item) : null;
    if (record) intents.push({ ...record, actionCount: record.actions.length });
  }
  return { intentIds, intents };
}

/**
 * The recovery service an installed validator delegates to. Only the
 * `ActionSessionValidator` stores one; every other validator returns zero, so
 * the first non-zero answer names the service the DID console may read.
 */
export async function resolveRecoveryService({ rpcUrl, saContractHash, accountIdHex } = {}) {
  const core = sanitizeHex(saContractHash);
  const accountIdParam = toHash160Param(accountIdHex);
  const page = decodeModulePage(await readAccountItem({
    rpcUrl,
    saContractHash: core,
    operation: 'getModules',
    args: [accountIdParam, toStringParam('validator'), toIntegerParam(0), toIntegerParam(MODULE_PAGE_SIZE)],
  }));
  for (const moduleId of page.ids) {
    const item = await readAccountItem({
      rpcUrl,
      saContractHash: core,
      operation: 'getModule',
      args: [accountIdParam, toIntegerParam(moduleId)],
    }).catch(() => null);
    const descriptor = item ? decodeModuleDescriptor(item) : null;
    if (!descriptor?.contractHash) continue;
    const service = await readModuleMethod({
      rpcUrl,
      moduleHash: descriptor.contractHash,
      operation: 'getRecoveryService',
      args: [accountIdParam, toIntegerParam(moduleId)],
    }).catch(() => '');
    const normalizedService = sanitizeHex(service);
    if (normalizedService && normalizedService !== ZERO_HASH160) {
      return { moduleId, moduleHash: descriptor.contractHash, recoveryServiceHash: normalizedService };
    }
  }
  return { moduleId: 0, moduleHash: '', recoveryServiceHash: '' };
}

/**
 * Reads the account control record, the installed module set, the pending
 * configuration intents and the recovery service state the DID console renders
 * (§9, §10, §12.2).
 *
 * v4 has no single verifier slot: the recovery console resolves the service the
 * installed `ActionSessionValidator` instance delegates to
 * (`getRecoveryService`) and reads that service. Pending configuration lives in
 * core intents, so the console never polls a retired verifier or hook timelock.
 */
export async function fetchAccountRecoveryState({ rpcUrl, saContractHash, accountIdHex } = {}) {
  const core = sanitizeHex(saContractHash);
  const accountIdParam = toHash160Param(accountIdHex);
  const [controlItem, validatorPage, hookPage, hookOrderItem, pendingConfiguration] = await Promise.all([
    readAccountItem({ rpcUrl, saContractHash: core, operation: 'getAccount', args: [accountIdParam] }),
    readAccountItem({
      rpcUrl,
      saContractHash: core,
      operation: 'getModules',
      args: [accountIdParam, toStringParam('validator'), toIntegerParam(0), toIntegerParam(MODULE_PAGE_SIZE)],
    }).catch(() => null),
    readAccountItem({
      rpcUrl,
      saContractHash: core,
      operation: 'getModules',
      args: [accountIdParam, toStringParam('hook'), toIntegerParam(0), toIntegerParam(MODULE_PAGE_SIZE)],
    }).catch(() => null),
    readAccountItem({ rpcUrl, saContractHash: core, operation: 'getHookOrder', args: [accountIdParam] }).catch(() => null),
    fetchPendingConfigurationState({ rpcUrl, saContractHash: core, accountIdHex })
      .catch(() => ({ intentIds: [], intents: [] })),
  ]);
  const control = decodeAccountDescriptor(controlItem);
  const validatorIds = validatorPage ? decodeModulePage(validatorPage).ids : [];
  const hookIds = hookPage ? decodeModulePage(hookPage).ids : [];
  const hookOrder = hookOrderItem ? decodeHookOrder(hookOrderItem) : { hookIds: [], revision: 0 };
  const { recoveryServiceHash, moduleId, moduleHash } = await resolveRecoveryService({
    rpcUrl, saContractHash: core, accountIdHex,
  });
  const recovery = recoveryServiceHash
    ? await readRecoveryServiceState({ rpcUrl, recoveryServiceHash, accountIdHex })
    : null;
  return {
    accountIdHex: sanitizeHex(accountIdHex),
    control,
    validatorIds,
    hookIds,
    hookOrder,
    pendingConfiguration,
    recoveryServiceHash,
    recoveryModuleId: moduleId,
    recoveryModuleHash: moduleHash,
    ...(recovery || {}),
  };
}

/**
 * The recovery service keeps the same safe query surface it had as a plugin, so
 * only the target changes: the service address resolved from the installed
 * `ActionSessionValidator`, never a fixed verifier slot.
 */
async function readRecoveryServiceState({ rpcUrl, recoveryServiceHash, accountIdHex } = {}) {
  const normalizedService = sanitizeHex(recoveryServiceHash);
  const accountIdParam = toHash160Param(accountIdHex);
  const [
    owner,
    morpheusOracle,
    network,
    saContract,
    accountIdText,
    accountAddress,
    recoveryNonce,
    sessionNonce,
    threshold,
    timelock,
    pendingRecovery,
    activeSession,
    actionProtocolVersion,
    actionAuthorizationEpoch,
    actionSessionAuthorized,
  ] = await Promise.all([
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getOwner', args: [accountIdParam] }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getMorpheusOracle', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getMorpheusOracle failed:', error?.message); return ''; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getNetwork', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getNetwork failed:', error?.message); return ''; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getSAContract', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getSAContract failed:', error?.message); return ''; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getAccountIdText', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getAccountIdText failed:', error?.message); return ''; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getAccountAddress', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getAccountAddress failed:', error?.message); return ''; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getRecoveryNonce', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getRecoveryNonce failed:', error?.message); return '0'; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getSessionNonce', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getSessionNonce failed:', error?.message); return '0'; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getThreshold', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getThreshold failed:', error?.message); return '0'; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getTimelock', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getTimelock failed:', error?.message); return '0'; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getPendingRecovery', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getPendingRecovery failed:', error?.message); return []; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getActiveSession', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getActiveSession failed:', error?.message); return []; }),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getActionProtocolVersion', args: [] }).catch(() => '0'),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'getActionAuthorizationEpoch', args: [accountIdParam] }).catch(() => '0'),
    readModuleMethod({ rpcUrl, moduleHash: normalizedService, operation: 'isActionSessionAuthorized', args: [accountIdParam] }).catch(() => false),
  ]);

  return {
    recoveryServiceHash: normalizedService,
    owner,
    morpheusOracle,
    network,
    saContract,
    accountIdText,
    accountAddress,
    recoveryNonce,
    sessionNonce,
    threshold,
    timelock,
    pendingRecovery: Array.isArray(pendingRecovery) ? {
      newOwner: pendingRecovery[0] || '',
      recoveryNonce: pendingRecovery[1] || '0',
      approvedCount: pendingRecovery[2] || '0',
      initiatedAt: pendingRecovery[3] || '0',
      executableAt: pendingRecovery[4] || '0',
      active: Boolean(pendingRecovery[5]),
    } : null,
    actionProtocolVersion,
    actionAuthorizationEpoch,
    actionSessionAuthorized: actionSessionAuthorized === true,
    activeSession: Array.isArray(activeSession) ? {
      executor: activeSession[0] || '',
      actionId: activeSession[1] || '',
      actionNullifier: activeSession[2] || '',
      expiresAt: activeSession[3] || '0',
      active: Boolean(activeSession[4]),
    } : null,
  };
}

async function fetchOraclePublicKey() {
  const response = await fetchWithTimeout(
    `${RUNTIME_CONFIG.morpheusOracleKeyEndpoint}?${new URLSearchParams({ morpheus_network: RUNTIME_CONFIG.morpheusNetwork }).toString()}`,
    {
      method: 'GET',
      headers: { accept: 'application/json' },
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.public_key) {
    const err = new Error(EC.oracleKeyLoadFailed);
    err.rpcDetail = body?.error || null;
    throw err;
  }
  return body;
}

async function callNeoDid(action, payload = {}) {
  const normalizedAction = trim(action).toLowerCase();
  const method = normalizedAction === 'resolve' ? 'GET' : 'POST';
  const requestPayload = {
    morpheus_network: RUNTIME_CONFIG.morpheusNetwork,
    ...payload,
  };
  const url = method === 'GET'
    ? `${RUNTIME_CONFIG.morpheusNeoDidEndpoint}?${new URLSearchParams(
        Object.entries({ action: normalizedAction, ...requestPayload }).filter(([, value]) => value != null && value !== '')
      ).toString()}`
    : RUNTIME_CONFIG.morpheusNeoDidEndpoint;
  const response = await fetchWithTimeout(url, method === 'GET'
    ? { method, headers: { accept: 'application/json' } }
    : {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: normalizedAction, ...requestPayload }),
      });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) {
    const err = new Error(EC.morpheusDidRequestFailed);
    err.rpcDetail = body?.error || body?.message || null;
    throw err;
  }
  return body;
}

async function buildEncryptedSubjectPatch(extra = {}) {
  const profile = getDidProfile();
  const subject = buildNeoDidSubject(profile);
  if (!subject?.provider || !subject?.id_token) {
    throw new Error(EC.web3AuthTokenRequired);
  }
  const oracleKey = await fetchOraclePublicKey();
  const confidentialPatch = {
    id_token: subject.id_token,
    provider_uid: subject.provider_uid || undefined,
    ...extra,
  };
  const encrypted_params = await encryptJsonWithMorpheusOracleKey(
    oracleKey.public_key,
    JSON.stringify(confidentialPatch),
  );
  return {
    provider: subject.provider,
    encrypted_params,
    provider_uid: subject.provider_uid || undefined,
  };
}

class MorpheusDidService {
  async bindDid({ vaultAccount, claimType = 'Web3Auth_PrimaryIdentity', claimValue = 'verified', metadata = {} } = {}) {
    const profile = getDidProfile();
    const subjectPatch = await buildEncryptedSubjectPatch({
      linked_accounts: profile?.linkedAccounts || [],
      email: profile?.email || undefined,
      phone: profile?.phone || undefined,
    });
    if (!subjectPatch?.provider || !subjectPatch?.encrypted_params) {
      throw new Error(EC.walletNotConnected);
    }
    const response = await callNeoDid('bind', {
      vault_account: `0x${normalizeScriptHash(vaultAccount)}`,
      provider: subjectPatch.provider,
      claim_type: claimType,
      claim_value: claimValue,
      encrypted_params: subjectPatch.encrypted_params,
      metadata: {
        provider_uid_hint: subjectPatch.provider_uid || undefined,
        identity_root: profile?.identityRoot || profile?.providerUid || undefined,
        service_did: profile?.serviceDid || RUNTIME_CONFIG.morpheusNeoDidServiceDid,
        ...metadata,
      },
    });
    return {
      ...response,
      zklogin_verifier_params_hex: buildDelegatedIdentityParamsHex({
        publicKey: response.public_key,
        provider: response.provider || subjectPatch.provider,
        masterNullifier: response.master_nullifier,
      }),
    };
  }

  async resolveDid({ did = RUNTIME_CONFIG.morpheusNeoDidServiceDid, format = '' } = {}) {
    return callNeoDid('resolve', {
      did,
      format: trim(format),
    });
  }

  async previewRecoveryTicket({ network, saContract, verifierContract, accountId, accountIdText, accountIdRaw, accountAddress, newOwner, recoveryNonce, expiresAt } = {}) {
    const networkText = requireSaSigningText(network, 'network');
    const accountText = requireSaSigningText(accountIdText, 'accountIdText');
    const core = toRequiredNeoInternalHex(saContract, 'saContract');
    const recoveryVerifier = toRequiredNeoInternalHex(verifierContract, 'verifierContract');
    const account = toRequiredNeoInternalHex(accountIdRaw, 'accountIdRaw');
    const accountAddressInternal = toRequiredNeoInternalHex(accountAddress, 'accountAddress');
    const newOwnerInternal = toRequiredNeoInternalHex(newOwner, 'newOwner');
    const profile = getDidProfile();
    const subjectPatch = await buildEncryptedSubjectPatch({
      linked_accounts: profile?.linkedAccounts || [],
      email: profile?.email || undefined,
      phone: profile?.phone || undefined,
    });
    return callNeoDid('recovery-ticket', {
      ...subjectPatch,
      network: networkText,
      sa_contract: core,
      verifier_contract: recoveryVerifier,
      account_id_raw: account,
      account_id: accountText,
      account_address: accountAddressInternal,
      new_owner: newOwnerInternal,
      recovery_nonce: String(recoveryNonce ?? '0'),
      expires_at: String(expiresAt),
      callback_encoding: 'neo_n3_recovery_v3',
    });
  }

  async previewActionTicket({ saContract, verifierContract, accountId, accountIdText, accountIdRaw, executor, sessionNonce = 0, authorizationEpoch, expiresAt, network } = {}) {
    const networkText = requireSaSigningText(network, 'network');
    const accountText = requireSaSigningText(accountIdText, 'accountIdText');
    const core = toRequiredNeoInternalHex(saContract, 'saContract');
    const actionVerifier = toRequiredNeoInternalHex(verifierContract, 'verifierContract');
    const account = toRequiredNeoInternalHex(accountIdRaw, 'accountIdRaw');
    const disposable = toRequiredNeoInternalHex(executor, 'executor');
    const epoch = String(authorizationEpoch ?? '');
    if (!/^[1-9][0-9]*$/.test(epoch)) throw new Error('Current action authorization epoch required');
    const actionId = await buildSaActionId({ network: networkText, saContractInternal: core, accountIdRawInternal: account, executorInternal: disposable, sessionNonce, expiresAt });
    const profile = getDidProfile();
    const subjectPatch = await buildEncryptedSubjectPatch({
      linked_accounts: profile?.linkedAccounts || [],
    });
    return callNeoDid('action-ticket', {
      ...subjectPatch,
      network: networkText,
      sa_contract: core,
      verifier_contract: actionVerifier,
      account_id_raw: account,
      account_id: accountText,
      disposable_account: disposable,
      action_id: actionId,
      expires_at: String(expiresAt),
      session_nonce: String(sessionNonce),
      authorization_epoch: epoch,
      callback_encoding: 'neo_n3_action_v4',
    });
  }

  async previewZkLoginTicket({
    verifierContract,
    accountIdHash,
    targetContract,
    method,
    argsHashHex,
    nonce,
    deadline,
    provider = 'web3auth',
  } = {}) {
    const profile = getDidProfile();
    const subjectPatch = await buildEncryptedSubjectPatch({
      linked_accounts: profile?.linkedAccounts || [],
      email: profile?.email || undefined,
      phone: profile?.phone || undefined,
    });
    const response = await callNeoDid('zklogin-ticket', {
      ...subjectPatch,
      network: 'neo_n3',
      verifier_contract: `0x${sanitizeHex(verifierContract)}`,
      account_id_hash: `0x${sanitizeHex(accountIdHash)}`,
      target_contract: `0x${sanitizeHex(targetContract)}`,
      method: trim(method),
      args_hash: `0x${sanitizeHex(argsHashHex)}`,
      nonce: String(nonce ?? '0'),
      deadline: String(deadline ?? '0'),
      provider: normalizeDelegatedIdentityProvider(provider),
    });
    const ticket = formatDelegatedIdentityTicket(response);
    return {
      ...response,
      verifier_params_hex: ticket.delegatedIdentityParamsHex,
      proof_hex: ticket.proofHex,
      ticket,
    };
  }

  async invokeRecoveryRequest({ verifierHash, accountIdHex, newOwner, expiresAt, provider = 'web3auth' } = {}) {
    const profile = getDidProfile();
    const subjectPatch = await buildEncryptedSubjectPatch({
      linked_accounts: profile?.linkedAccounts || [],
      email: profile?.email || undefined,
      phone: profile?.phone || undefined,
    });
    const params = [
      toHash160Param(accountIdHex),
      toStringParam(provider),
      toHash160Param(normalizeScriptHash(newOwner)),
      toStringParam(String(expiresAt)),
      toStringParam(subjectPatch.encrypted_params),
    ];
    const result = await walletService.invoke({
      scriptHash: sanitizeHex(verifierHash),
      operation: 'requestRecoveryTicket',
      args: params,
    });

    const notificationPayload = {
      sa_contract: getSmartAccountHash(),
      verifier: sanitizeHex(verifierHash),
      account_id: accountIdHex,
      new_owner: normalizeScriptHash(newOwner),
      expires_at: expiresAt,
    };
    if (profile?.email && notificationService.canEmail) {
      await notificationService.sendRecoveryEmail({
        did: profile.did,
        email: profile.email,
        payload: notificationPayload,
      }).catch((err) => { if (import.meta.env.DEV) console.error('[morpheusDidService] recovery email failed:', err?.message); });
    }
    if (profile?.phone && notificationService.canSms) {
      await notificationService.sendRecoverySms({
        did: profile.did,
        phone: profile.phone,
        payload: notificationPayload,
      }).catch((err) => { if (import.meta.env.DEV) console.error('[morpheusDidService] recovery sms failed:', err?.message); });
    }
    return result;
  }

  async invokeProxySessionRequest({ verifierHash, accountIdHex, executor, expiresAt, provider = 'web3auth' } = {}) {
    const profile = getDidProfile();
    const subjectPatch = await buildEncryptedSubjectPatch({
      linked_accounts: profile?.linkedAccounts || [],
    });
    return walletService.invoke({
      scriptHash: sanitizeHex(verifierHash),
      operation: 'requestActionSession',
      args: [
        toHash160Param(accountIdHex),
        toStringParam(provider),
        toHash160Param(normalizeScriptHash(executor)),
        toIntegerParam(expiresAt),
        toStringParam(subjectPatch.encrypted_params),
      ],
    });
  }

  // Normal explicit user wallet actions. The contract checks its current
  // owner witness; a DID login or a self-reported owner does not authorize them.
  async setActionIdentity({ verifierHash, accountIdHex, masterNullifier, enabled } = {}) {
    const master = sanitizeHex(masterNullifier);
    if (!/^[0-9a-f]{64}$/.test(master) || typeof enabled !== 'boolean') throw new Error('Invalid action enrollment');
    return walletService.invoke({
      scriptHash: requireNonZeroHash160(verifierHash, 'verifierHash'), operation: 'setActionIdentity',
      args: [toHash160Param(requireNonZeroHash160(accountIdHex, 'accountId')), { type: 'ByteArray', value: master }, { type: 'Boolean', value: enabled }],
    });
  }

  async reauthorizeActiveActionSession({ verifierHash, accountIdHex, session } = {}) {
    const nullifier = sanitizeHex(session?.actionNullifier);
    if (!session?.active || !/^[0-9a-f]{64}$/.test(nullifier) || !session.actionId || !/^[0-9]+$/.test(String(session.expiresAt))) throw new Error('Invalid active session');
    return walletService.invoke({
      scriptHash: requireNonZeroHash160(verifierHash, 'verifierHash'), operation: 'reauthorizeActiveActionSession',
      args: [toHash160Param(requireNonZeroHash160(accountIdHex, 'accountId')), toHash160Param(requireNonZeroHash160(session.executor, 'executor')),
        toStringParam(session.actionId), toIntegerParam(session.expiresAt), { type: 'ByteArray', value: nullifier }],
    });
  }

  async finalizeRecovery({ verifierHash, accountIdHex } = {}) {
    return walletService.invoke({
      scriptHash: sanitizeHex(verifierHash),
      operation: 'finalizeRecovery',
      args: [
        toHash160Param(accountIdHex),
      ],
    });
  }

  async cancelRecovery({ verifierHash, accountIdHex } = {}) {
    return walletService.invoke({
      scriptHash: sanitizeHex(verifierHash),
      operation: 'cancelRecovery',
      args: [
        toHash160Param(accountIdHex),
      ],
    });
  }

  async revokeProxySession({ verifierHash, accountIdHex } = {}) {
    return walletService.invoke({
      scriptHash: sanitizeHex(verifierHash),
      operation: 'revokeActionSession',
      args: [
        toHash160Param(accountIdHex),
      ],
    });
  }
}

export const morpheusDidService = new MorpheusDidService();
