import { RUNTIME_CONFIG } from '@/config/runtimeConfig';
import { EC } from '../config/errorCodes.js';
import { notificationService } from '@/services/notificationService';
import { invokeReadFunction, getScriptHashFromAddress } from '@/utils/neo';
import { sanitizeHex } from '@/utils/hex';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout.js';
import { encryptJsonWithMorpheusOracleKey } from '@/utils/morpheusEncryption';
import { walletService, getAbstractAccountHash } from '@/services/walletService';
import { buildZkLoginVerifierParamsHex, formatZkLoginTicket, normalizeZkLoginProvider } from '@/services/zkLoginVerifierService.js';
import { connectedDidProfile } from '@/utils/did';
import { createAccountIdentityReader } from './aaIdentityReadService.js';

function trim(value) {
  return String(value || '').trim();
}

function toHash160Param(value) {
  return {
    type: 'Hash160',
    value: `0x${sanitizeHex(value || '')}`,
  };
}

function toByteArrayParam(value) {
  return {
    type: 'ByteArray',
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

function decodeBase64ToHex(value) {
  if (!value) return '';
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64').toString('hex').toLowerCase();
  }
  const binary = globalThis.atob ? globalThis.atob(value) : '';
  return Array.from(binary, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
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

async function readVerifierMethod({ rpcUrl, verifierHash, operation, args = [] } = {}) {
  const result = await invokeReadFunction(rpcUrl, sanitizeHex(verifierHash), operation, args);
  if (result?.state === 'FAULT') {
    const err = new Error(EC.rpcFault);
    err.rpcDetail = result?.exception || null;
    throw err;
  }
  return decodeStackItem(result?.stack?.[0]);
}

async function readAccountMethod({ rpcUrl, aaContractHash, operation, args = [] } = {}) {
  const result = await invokeReadFunction(rpcUrl, sanitizeHex(aaContractHash), operation, args);
  if (result?.state === 'FAULT') {
    const err = new Error(EC.rpcFault);
    err.rpcDetail = result?.exception || null;
    throw err;
  }
  return decodeStackItem(result?.stack?.[0]);
}

export async function fetchAccountMaintenanceState({ rpcUrl, aaContractHash, accountIdHex } = {}) {
  const normalizedAaHash = sanitizeHex(aaContractHash);
  const accountIdParam = toHash160Param(accountIdHex);
  const [
    hasPendingVerifierUpdate,
    pendingVerifierUpdateTime,
    hasPendingHookUpdate,
    pendingHookUpdateTime,
    pendingVerifierCall,
    pendingHookCall,
  ] = await Promise.all([
    readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'hasPendingVerifierUpdate', args: [accountIdParam] }).catch(() => false),
    readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'getPendingVerifierUpdateTime', args: [accountIdParam] }).catch(() => '0'),
    readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'hasPendingHookUpdate', args: [accountIdParam] }).catch(() => false),
    readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'getPendingHookUpdateTime', args: [accountIdParam] }).catch(() => '0'),
    Promise.all([
      readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'hasPendingVerifierCall', args: [accountIdParam] }).catch(() => false),
      readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'getPendingVerifierCallTime', args: [accountIdParam] }).catch(() => '0'),
      readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'getPendingVerifierCallModule', args: [accountIdParam] }).catch(() => ''),
      readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'getPendingVerifierCallHash', args: [accountIdParam] }).catch(() => ''),
    ]),
    Promise.all([
      readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'hasPendingHookCall', args: [accountIdParam] }).catch(() => false),
      readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'getPendingHookCallTime', args: [accountIdParam] }).catch(() => '0'),
      readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'getPendingHookCallModule', args: [accountIdParam] }).catch(() => ''),
      readAccountMethod({ rpcUrl, aaContractHash: normalizedAaHash, operation: 'getPendingHookCallHash', args: [accountIdParam] }).catch(() => ''),
    ]),
  ]);

  const [hasVerifierCall, verifierCallTime, verifierCallModule, verifierCallHash] = pendingVerifierCall;
  const [hasHookCall, hookCallTime, hookCallModule, hookCallHash] = pendingHookCall;

  return {
    pendingVerifierUpdate: {
      active: Boolean(hasPendingVerifierUpdate),
      executeAfter: String(pendingVerifierUpdateTime || '0'),
    },
    pendingHookUpdate: {
      active: Boolean(hasPendingHookUpdate),
      executeAfter: String(pendingHookUpdateTime || '0'),
    },
    pendingVerifierCall: {
      active: Boolean(hasVerifierCall),
      executeAfter: String(verifierCallTime || '0'),
      moduleHash: trim(verifierCallModule || ''),
      callHash: trim(verifierCallHash || ''),
    },
    pendingHookCall: {
      active: Boolean(hasHookCall),
      executeAfter: String(hookCallTime || '0'),
      moduleHash: trim(hookCallModule || ''),
      callHash: trim(hookCallHash || ''),
    },
  };
}

export async function fetchUnifiedVerifierState({ rpcUrl, verifierHash, accountIdHex } = {}) {
  const normalizedVerifier = sanitizeHex(verifierHash);
  const accountIdParam = toByteArrayParam(accountIdHex);
  const [
    owner,
    morpheusOracle,
    recoveryNonce,
    sessionNonce,
    threshold,
    timelock,
    pendingRecovery,
    activeSession,
  ] = await Promise.all([
    readVerifierMethod({ rpcUrl, verifierHash: normalizedVerifier, operation: 'getOwner', args: [accountIdParam] }),
    readVerifierMethod({ rpcUrl, verifierHash: normalizedVerifier, operation: 'getMorpheusOracle', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getMorpheusOracle failed:', error?.message); return ''; }),
    readVerifierMethod({ rpcUrl, verifierHash: normalizedVerifier, operation: 'getRecoveryNonce', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getRecoveryNonce failed:', error?.message); return '0'; }),
    readVerifierMethod({ rpcUrl, verifierHash: normalizedVerifier, operation: 'getSessionNonce', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getSessionNonce failed:', error?.message); return '0'; }),
    readVerifierMethod({ rpcUrl, verifierHash: normalizedVerifier, operation: 'getThreshold', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getThreshold failed:', error?.message); return '0'; }),
    readVerifierMethod({ rpcUrl, verifierHash: normalizedVerifier, operation: 'getTimelock', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getTimelock failed:', error?.message); return '0'; }),
    readVerifierMethod({ rpcUrl, verifierHash: normalizedVerifier, operation: 'getPendingRecovery', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getPendingRecovery failed:', error?.message); return []; }),
    readVerifierMethod({ rpcUrl, verifierHash: normalizedVerifier, operation: 'getActiveSession', args: [accountIdParam] }).catch((error) => { if (import.meta.env.DEV) console.error('[morpheusDidService] getActiveSession failed:', error?.message); return []; }),
  ]);

  return {
    verifierHash: `0x${normalizedVerifier}`,
    owner,
    morpheusOracle,
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
      zklogin_verifier_params_hex: buildZkLoginVerifierParamsHex({
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

  async previewRecoveryTicket({ aaContract, verifierContract, accountId, newOwner, recoveryNonce, expiresAt } = {}) {
    const profile = getDidProfile();
    const subjectPatch = await buildEncryptedSubjectPatch({
      linked_accounts: profile?.linkedAccounts || [],
      email: profile?.email || undefined,
      phone: profile?.phone || undefined,
    });
    return callNeoDid('recovery-ticket', {
      ...subjectPatch,
      network: 'neo_n3',
      aa_contract: `0x${sanitizeHex(aaContract || getAbstractAccountHash())}`,
      verifier_contract: `0x${sanitizeHex(verifierContract)}`,
      account_id: trim(accountId),
      new_owner: `0x${normalizeScriptHash(newOwner)}`,
      recovery_nonce: String(recoveryNonce ?? '0'),
      expires_at: String(expiresAt),
    });
  }

  async previewActionTicket({ executor, actionId } = {}) {
    const profile = getDidProfile();
    const subjectPatch = await buildEncryptedSubjectPatch({
      linked_accounts: profile?.linkedAccounts || [],
    });
    return callNeoDid('action-ticket', {
      ...subjectPatch,
      disposable_account: `0x${normalizeScriptHash(executor)}`,
      action_id: trim(actionId),
      callback_encoding: 'neo_n3_action_v3',
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
      provider: normalizeZkLoginProvider(provider),
    });
    const ticket = formatZkLoginTicket(response);
    return {
      ...response,
      verifier_params_hex: ticket.verifierParamsHex,
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
      toByteArrayParam(accountIdHex),
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
      aa_contract: getAbstractAccountHash(),
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
        toByteArrayParam(accountIdHex),
        toStringParam(provider),
        toHash160Param(normalizeScriptHash(executor)),
        toIntegerParam(expiresAt),
        toStringParam(subjectPatch.encrypted_params),
      ],
    });
  }

  async finalizeRecovery({ verifierHash, accountIdHex } = {}) {
    return walletService.invoke({
      scriptHash: sanitizeHex(verifierHash),
      operation: 'finalizeRecovery',
      args: [
        toByteArrayParam(accountIdHex),
      ],
    });
  }

  async cancelRecovery({ verifierHash, accountIdHex } = {}) {
    return walletService.invoke({
      scriptHash: sanitizeHex(verifierHash),
      operation: 'cancelRecovery',
      args: [
        toByteArrayParam(accountIdHex),
      ],
    });
  }

  async revokeProxySession({ verifierHash, accountIdHex } = {}) {
    return walletService.invoke({
      scriptHash: sanitizeHex(verifierHash),
      operation: 'revokeActionSession',
      args: [
        toByteArrayParam(accountIdHex),
      ],
    });
  }
}

export const morpheusDidService = new MorpheusDidService();
