import { EC } from '../config/errorCodes.js';
import { RUNTIME_CONFIG } from '../config/runtimeConfig.js';
import { sanitizeHex } from '../utils/hex.js';
import { getScriptHashFromAddress } from '../utils/neo.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';

// The wallet discovers its abstract accounts from the NeoOS read API instead of
// scanning the address market over a hard-coded public host. The host comes from
// the AA discovery runtime setting (VITE_AA_N3INDEX_API_BASE_URL, or an explicit
// VITE_N3INDEX_API_BASE_URL), which has no compiled-in default: without it every
// entry point below refuses before building a URL, so an unconfigured local stack
// can never fall back to the public production read API. The network and the AA
// core contract come from runtime configuration the same way, with no rebuild.
//
// Wire contract (docs/api/aa-accounts.md in neo-os-fura): both routes require
// contract_hash, because an event name describes a payload shape and not the
// identity of the contract that emitted it.

export const AA_ACCOUNTS_PATH_SUFFIX = '/aa/accounts';

const HASH_HEX_LENGTH = 40;

function trimTrailingSlash(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function normalizeAANetwork(network = RUNTIME_CONFIG.n3IndexNetwork) {
  return String(network || '').trim().toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
}

function validationError() {
  return new Error(EC.addressValidationFailed);
}

// normalizeHash returns the lowercase 0x display-order hash, or throws when the
// value is not one. An N3 address is accepted only where the caller says so.
function normalizeHash(value, { allowAddress = false } = {}) {
  const raw = String(value || '').trim();
  if (allowAddress && raw.length === 34 && raw.startsWith('N')) {
    try {
      const scriptHash = sanitizeHex(getScriptHashFromAddress(raw));
      if (scriptHash.length === HASH_HEX_LENGTH) return `0x${scriptHash}`;
    } catch (error) {
      // Fall through to the shared validation error below; a malformed address
      // must not become an account query.
    }
    throw validationError();
  }
  const hex = sanitizeHex(raw);
  if (hex.length !== HASH_HEX_LENGTH || !/^[0-9a-f]+$/.test(hex)) throw validationError();
  return `0x${hex}`;
}

export function normalizeAAOwner(owner) {
  return normalizeHash(owner, { allowAddress: true });
}

export function normalizeAAAccountId(accountId) {
  return normalizeHash(accountId);
}

export function normalizeAAContractHash(contractHash) {
  return normalizeHash(contractHash);
}

export function isAAReadApiConfigured({
  baseUrl = RUNTIME_CONFIG.aaReadApiBaseUrl,
  contractHash = RUNTIME_CONFIG.abstractAccountHash,
} = {}) {
  try {
    return trimTrailingSlash(baseUrl).length > 0 && normalizeAAContractHash(contractHash).length > 0;
  } catch (error) {
    return false;
  }
}

// assertAAReadApiBaseUrl is the discovery path's fail-closed gate: with no
// explicit read API base URL there is no host to guess, so the call is refused
// before a URL is built or a transport is touched.
function assertAAReadApiBaseUrl(baseUrl) {
  if (!trimTrailingSlash(baseUrl)) throw new Error(EC.rpcRequestFailed);
}

function buildReadApiUrl(path, baseUrl) {
  assertAAReadApiBaseUrl(baseUrl);
  const normalizedBase = trimTrailingSlash(baseUrl);
  return `${normalizedBase}${path.startsWith('/') ? path : `/${path}`}`;
}

export function buildAAAccountsByOwnerPath({
  network = RUNTIME_CONFIG.n3IndexNetwork,
  owner,
  contractHash = RUNTIME_CONFIG.abstractAccountHash,
} = {}) {
  const path = `/indexer/v1/networks/${normalizeAANetwork(network)}${AA_ACCOUNTS_PATH_SUFFIX}`;
  const query = new URLSearchParams({
    owner: normalizeAAOwner(owner),
    contract_hash: normalizeAAContractHash(contractHash),
  });
  return `${path}?${query.toString()}`;
}

export function buildAAAccountByIdPath({
  network = RUNTIME_CONFIG.n3IndexNetwork,
  accountId,
  contractHash = RUNTIME_CONFIG.abstractAccountHash,
} = {}) {
  const path = `/indexer/v1/networks/${normalizeAANetwork(network)}${AA_ACCOUNTS_PATH_SUFFIX}/${normalizeAAAccountId(accountId)}`;
  const query = new URLSearchParams({ contract_hash: normalizeAAContractHash(contractHash) });
  return `${path}?${query.toString()}`;
}

function optionalHash(value) {
  try {
    return normalizeHash(value);
  } catch (error) {
    return '';
  }
}

// normalizeAAAccountRow maps one read-API record to the wallet's shape, or
// returns null when the row carries no usable account id.
export function normalizeAAAccountRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  let accountIdHash = '';
  try {
    accountIdHash = normalizeAAAccountId(row.account_id);
  } catch (error) {
    return null;
  }
  const blockIndex = Number(row.registry_block_index);
  const timeMs = Number(row.registry_time_ms);
  return {
    accountIdHash,
    backupOwner: optionalHash(row.backup_owner),
    verifier: optionalHash(row.verifier),
    hookId: optionalHash(row.hook_id),
    registryBlockIndex: Number.isFinite(blockIndex) && blockIndex > 0 ? blockIndex : 0,
    registryTxHash: typeof row.registry_tx_hash === 'string' ? row.registry_tx_hash : '',
    registryTimeMs: Number.isFinite(timeMs) && timeMs > 0 ? timeMs : 0,
  };
}

async function readApiJSON(url, { fetchImpl, timeoutMs } = {}) {
  let response;
  try {
    response = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      { fetchImpl, timeoutMs },
    );
  } catch (error) {
    const failure = new Error(EC.rpcRequestFailed);
    failure.cause = error;
    throw failure;
  }
  if (!response || response.ok !== true) {
    const failure = new Error(EC.rpcRequestFailed);
    failure.status = Number(response?.status) || 0;
    throw failure;
  }
  try {
    return await response.json();
  } catch (error) {
    const failure = new Error(EC.rpcRequestFailed);
    failure.cause = error;
    throw failure;
  }
}

export async function fetchAAAccountsByOwner({
  owner,
  baseUrl = RUNTIME_CONFIG.aaReadApiBaseUrl,
  network = RUNTIME_CONFIG.n3IndexNetwork,
  contractHash = RUNTIME_CONFIG.abstractAccountHash,
  fetchImpl,
  timeoutMs,
} = {}) {
  const url = buildReadApiUrl(buildAAAccountsByOwnerPath({ network, owner, contractHash }), baseUrl);
  const payload = await readApiJSON(url, { fetchImpl, timeoutMs });
  const rows = payload?.data;
  if (!Array.isArray(rows)) throw new Error(EC.rpcRequestFailed);
  const accounts = rows.map(normalizeAAAccountRow).filter(Boolean);
  if (rows.length > 0 && accounts.length === 0) {
    // Every row was unusable: the wire shape is not the one this module reads,
    // so an empty list would be a false "you own no accounts".
    throw new Error(EC.rpcRequestFailed);
  }
  return accounts;
}

export async function fetchAAAccountById({
  accountId,
  baseUrl = RUNTIME_CONFIG.aaReadApiBaseUrl,
  network = RUNTIME_CONFIG.n3IndexNetwork,
  contractHash = RUNTIME_CONFIG.abstractAccountHash,
  fetchImpl,
  timeoutMs,
} = {}) {
  const url = buildReadApiUrl(buildAAAccountByIdPath({ network, accountId, contractHash }), baseUrl);
  const payload = await readApiJSON(url, { fetchImpl, timeoutMs });
  const account = normalizeAAAccountRow(payload?.data);
  if (!account) throw new Error(EC.rpcRequestFailed);
  return account;
}

// discoverAAAccountsForWallet is the panel-facing call: the connected wallet
// address is the backup owner the AA core recorded at registration. The address
// is refused first, then the read API setting, so neither an empty address nor a
// missing configuration ever reaches a host.
export async function discoverAAAccountsForWallet({
  address,
  baseUrl = RUNTIME_CONFIG.aaReadApiBaseUrl,
  network = RUNTIME_CONFIG.n3IndexNetwork,
  contractHash = RUNTIME_CONFIG.abstractAccountHash,
  fetchImpl,
  timeoutMs,
} = {}) {
  if (!String(address || '').trim()) throw new Error(EC.addressValidationFailed);
  assertAAReadApiBaseUrl(baseUrl);
  return fetchAAAccountsByOwner({ owner: address, baseUrl, network, contractHash, fetchImpl, timeoutMs });
}
