import { BrowserProvider } from 'ethers';
import { connectedAccount, setConnectedAccount } from '../utils/wallet.js';
import { RUNTIME_CONFIG } from '../config/runtimeConfig.js';
import { EC } from '../config/errorCodes.js';
import { getScriptHashFromAddress } from '../utils/neo.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';

export function getAbstractAccountHash() {
  return RUNTIME_CONFIG.abstractAccountHash;
}

const MAINNET_MAGIC = 860833102;
const TESTNET_MAGIC = 894710606;

export const SESSION_STATES = {
  DISCONNECTED: 'disconnected',
  PENDING: 'pending',
  VERIFIED: 'verified',
};

// Single persistence key for the wallet session. The value is a JSON envelope
// ({ address, hash, provider }) so account metadata survives reloads; legacy
// plain-address strings written by earlier versions are still accepted.
export const SESSION_STORAGE_KEY = 'aa_connected_account';
const LEGACY_SESSION_FLAG_KEY = 'aa_wallet_connected';

const ACCOUNT_CHANGED_EVENTS = [
  'NEOLine.NEO.EVENT.ACCOUNT_CHANGED',
  'Neo.DapiProvider.ACCOUNT_CHANGED',
];
const NETWORK_CHANGED_EVENTS = [
  'NEOLine.NEO.EVENT.NETWORK_CHANGED',
  'Neo.DapiProvider.NETWORK_CHANGED',
];

function getSessionStorage() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function parsePersistedSession(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.address) {
      return {
        address: String(parsed.address).trim(),
        hash: String(parsed.hash || '').trim(),
        provider: String(parsed.provider || '').trim(),
      };
    }
  } catch (_error) {
    /* legacy plain-address payload */
  }
  const address = String(raw).trim();
  return address && !address.startsWith('{') ? { address, hash: '', provider: '' } : null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object';
}

function hasNep21Metadata(provider) {
  const version = String(provider?.dapiVersion ?? '').trim();
  const compatibility = Array.isArray(provider?.compatibility)
    ? provider.compatibility.some((entry) => String(entry).toUpperCase() === 'NEP-21')
    : false;
  return compatibility || version === '1.0' || version.startsWith('1.0.');
}

function hasUsableNep21Capability(provider) {
  return (
    typeof provider?.invoke === 'function'
    || typeof provider?.call === 'function'
    || typeof provider?.send === 'function'
    || typeof provider?.signMessage === 'function'
    || typeof provider?.authenticate === 'function'
    || typeof provider?.getBalance === 'function'
  );
}

function isNep21Provider(value) {
  return (
    isObject(value)
    && typeof value.getAccounts === 'function'
    && (hasNep21Metadata(value) || hasUsableNep21Capability(value))
  );
}

function registryCandidates(registry) {
  if (!registry || typeof registry !== 'object') return [];
  return Object.entries(registry).map(([key, provider]) => ({ key, provider }));
}

function getAuthenticationDomain() {
  if (typeof window === 'undefined') return 'localhost';
  return window.location.host || window.location.hostname || 'localhost';
}

function createNonce() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function normalizeNep21Account(account) {
  if (!isObject(account)) return null;
  const nested = isObject(account.account) ? account.account : {};
  const address = String(
    account.address
    || account.Address
    || nested.address
    || nested.Address
    || account.hash
    || account.Hash
    || nested.hash
    || ''
  ).trim();
  const hash = String(
    account.hash
    || account.Hash
    || account.scriptHash
    || account.scripthash
    || nested.hash
    || nested.scriptHash
    || ''
  ).trim();
  return address || hash ? { address: address || hash, hash } : null;
}

function normalizeTxResult(result) {
  if (typeof result === 'string') return { txid: result };
  if (result && typeof result === 'object') {
    const txid = String(result.txid || result.tx || result.hash || '');
    return txid ? { ...result, txid } : result;
  }
  return {};
}

function normalizeSignerScope(scope) {
  const byNumber = {
    0: 'None',
    1: 'CalledByEntry',
    16: 'CustomContracts',
    32: 'CustomGroups',
    64: 'WitnessRules',
    128: 'Global',
  };
  const byName = {
    none: 'None',
    calledbyentry: 'CalledByEntry',
    customcontracts: 'CustomContracts',
    customgroups: 'CustomGroups',
    rules: 'WitnessRules',
    witnessrules: 'WitnessRules',
    global: 'Global',
  };
  if (typeof scope === 'number' && Number.isFinite(scope)) {
    if (byNumber[scope]) return byNumber[scope];
    const parts = Object.entries(byNumber)
      .filter(([bit]) => Number(bit) !== 0 && (scope & Number(bit)) === Number(bit))
      .map(([, name]) => name);
    return parts.length ? parts.join(', ') : 'CalledByEntry';
  }
  const raw = String(scope ?? '').trim();
  if (/^\d+$/.test(raw)) return normalizeSignerScope(parseInt(raw, 10));
  if (raw.includes(',')) {
    const parts = raw
      .split(',')
      .map((part) => byName[part.trim().toLowerCase()] ?? part.trim())
      .filter(Boolean);
    return parts.length ? parts.join(', ') : 'CalledByEntry';
  }
  return byName[raw.toLowerCase()] ?? (raw || 'CalledByEntry');
}

function normalizeHash160ForDapi(value, accountHash, currentAddress) {
  const raw = String(value ?? '').trim();
  if (accountHash && currentAddress && raw === currentAddress) return accountHash;
  if (raw.startsWith('N') && raw.length === 34) {
    try {
      return `0x${getScriptHashFromAddress(raw)}`;
    } catch (_error) {
      return raw;
    }
  }
  return raw;
}

function buildNep21Invocation(entry, accountHash, currentAddress) {
  return {
    hash: entry.hash || entry.scriptHash,
    operation: entry.operation,
    args: (entry.args || []).map((arg) => (
      String(arg?.type || '').toLowerCase() === 'hash160'
        ? { ...arg, value: normalizeHash160ForDapi(arg.value, accountHash, currentAddress) }
        : arg
    )),
    ...(entry.abortOnFail != null ? { abortOnFail: entry.abortOnFail } : {}),
  };
}

function buildNep21Signers(signers, accountHash, currentAddress) {
  return signers?.map((signer) => ({
    account: accountHash && currentAddress && signer.account === currentAddress
      ? accountHash
      : signer.account,
    scopes: normalizeSignerScope(signer.scopes),
    ...(signer.allowedContracts?.length ? { allowedContracts: signer.allowedContracts } : {}),
    ...(signer.allowedGroups?.length ? { allowedGroups: signer.allowedGroups } : {}),
    ...(signer.rules?.length ? { rules: signer.rules } : {}),
  }));
}

class WalletService {
  constructor() {
    this.PROVIDERS = {
      NEO_WALLET: 'neo_wallet',
      EVM_WALLET: 'evm_wallet'
    };
    this.provider = this.PROVIDERS.NEO_WALLET;
    this.account = null;
    this.rpcUrl = RUNTIME_CONFIG.rpcUrl;
    this.sessionState = SESSION_STATES.DISCONNECTED;
    this._reconcilePromise = null;
    this._sessionListenersInstalled = false;
    this.bootstrap();
    this.installSessionListeners();
  }

  bootstrap() {
    const storage = getSessionStorage();
    if (!storage) return;
    // The session now lives under a single key; drop the legacy boolean flag
    // that useWalletConnection used to mirror alongside it.
    storage.removeItem(LEGACY_SESSION_FLAG_KEY);
    const cached = parsePersistedSession(storage.getItem(SESSION_STORAGE_KEY));
    if (!cached?.address) return;
    // Restore optimistically so the UI can render the cached address, but mark
    // the session 'pending' until reconcileSession() verifies it against the
    // provider on first mount.
    setConnectedAccount(cached.address);
    this.account = { ...cached };
    this.sessionState = SESSION_STATES.PENDING;
  }

  get isConnected() {
    return !!connectedAccount.value;
  }

  get address() {
    return connectedAccount.value || '';
  }

  setConnected(address, metadata = {}) {
    setConnectedAccount(address);
    this.account = address ? { address, ...metadata } : null;
    this.sessionState = address ? SESSION_STATES.VERIFIED : SESSION_STATES.DISCONNECTED;
    const storage = getSessionStorage();
    if (!storage) return;
    if (address) {
      storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
        address,
        hash: this.account?.hash || '',
        provider: this.account?.provider || '',
      }));
    } else {
      storage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  disconnect() {
    this.setConnected('');
  }

  installSessionListeners() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (this._sessionListenersInstalled) return;
    this._sessionListenersInstalled = true;
    const onAccountChanged = (event) => this.handleAccountChanged(event?.detail);
    const onNetworkChanged = () => this.handleNetworkChanged();
    for (const eventName of ACCOUNT_CHANGED_EVENTS) {
      window.addEventListener(eventName, onAccountChanged);
    }
    for (const eventName of NETWORK_CHANGED_EVENTS) {
      window.addEventListener(eventName, onNetworkChanged);
    }
  }

  handleAccountChanged(detail) {
    if (!this.isConnected) return;
    const next = normalizeNep21Account(detail) || normalizeNep21Account(detail?.account);
    if (!next?.address || next.address === this.account?.address) return;
    this.setConnected(next.address, {
      hash: next.hash || '',
      provider: this.account?.provider || '',
    });
  }

  handleNetworkChanged() {
    if (!this.isConnected) return;
    // The cached account and its hash metadata may not be valid on the new
    // network; force a re-verification pass.
    this.sessionState = SESSION_STATES.PENDING;
    void this.reconcileSession();
  }

  /**
   * Verify a 'pending' session (restored from storage) against the wallet
   * provider without prompting the user. Single-flight: concurrent callers
   * share one reconciliation pass.
   *
   * - No provider available at all -> the session cannot be verified, clear it.
   * - NEP-21 provider available -> getAccounts() (non-interactive). An empty
   *   roster clears the session; a changed selection adopts the provider's
   *   current default account; a match re-verifies and refreshes hash metadata.
   * - Only a legacy provider lane (NeoLine/neo3Dapi) is present -> keep the
   *   cached session but leave it 'pending' (verification would prompt).
   */
  async reconcileSession(options = {}) {
    if (this.sessionState !== SESSION_STATES.PENDING) return this.sessionState;
    if (!this._reconcilePromise) {
      this._reconcilePromise = this.runSessionReconciliation(options)
        .finally(() => { this._reconcilePromise = null; });
    }
    return this._reconcilePromise;
  }

  async runSessionReconciliation({ providerTimeoutMs = 1500 } = {}) {
    const cachedAddress = this.account?.address || '';
    const candidate = await this.waitForNep21Provider(providerTimeoutMs);
    // An explicit connect()/disconnect() may have raced the provider wait.
    if (this.sessionState !== SESSION_STATES.PENDING) return this.sessionState;

    if (!candidate) {
      if (this.getConnectProvider()) {
        // A legacy provider lane exists but cannot be queried without
        // prompting; keep the cached session unverified.
        return this.sessionState;
      }
      this.disconnect();
      return this.sessionState;
    }

    const accounts = await candidate.api.getAccounts().catch(() => []);
    if (this.sessionState !== SESSION_STATES.PENDING) return this.sessionState;

    const roster = Array.isArray(accounts) ? accounts : [];
    const matching = roster
      .map((entry) => normalizeNep21Account(entry))
      .find((entry) => entry?.address && entry.address === cachedAddress);
    const fallback = normalizeNep21Account(
      roster.find((entry) => entry?.isDefault) || roster[0],
    );
    const selected = matching || fallback;
    if (!selected?.address) {
      this.disconnect();
      return this.sessionState;
    }

    this.setConnected(selected.address, {
      hash: selected.hash || (matching ? this.account?.hash || '' : ''),
      provider: candidate.name || 'NEP-21',
    });
    return this.sessionState;
  }

  getNeoLineProviderCandidates() {
    return [
      { name: 'NEOLineN3', api: window.NEOLineN3?.N3 },
      { name: 'NEOLineN3', api: window.NEOLineN3?.default?.N3 },
      { name: 'NEOLine', api: window.NEOLine?.NEO },
      { name: 'NEOLine', api: window.NEOLine?.default?.NEO },
      { name: 'NEOLine', api: window.NEOLine },
      { name: 'NEOLine', api: window.NEOLine?.default },
    ];
  }

  getNep21ProviderCandidates() {
    return [
      { name: 'NEP21Provider', api: window.NEP21Provider },
      ...registryCandidates(window.NEP21Providers).map(({ key, provider }) => ({
        name: key || provider?.name || 'NEP21Provider',
        api: provider,
      })),
      { name: 'OneGate', api: window.OneGateDapiProvider },
      { name: 'Neo.DapiProvider', api: window.Neo?.DapiProvider },
      { name: 'neoDapiProvider', api: window.neoDapiProvider },
      { name: 'neoDapi', api: window.neoDapi },
    ];
  }

  findNep21ProviderCandidate() {
    return this.getNep21ProviderCandidates().find((candidate) => isNep21Provider(candidate.api)) || null;
  }

  async waitForNep21Provider(timeoutMs = 2500) {
    const immediate = this.findNep21ProviderCandidate();
    if (immediate) return immediate;
    if (typeof window === 'undefined') return null;

    return new Promise((resolve) => {
      let settled = false;
      let timeout;
      const finish = (candidate) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        window.removeEventListener('Neo.DapiProvider.ready', onReady);
        resolve(candidate);
      };
      const onReady = (event) => {
        const detail = event?.detail;
        const provider = isNep21Provider(detail) ? detail : detail?.provider;
        if (!isNep21Provider(provider)) return;
        const name = provider.name || 'NEP21Provider';
        if (!window.NEP21Provider) window.NEP21Provider = provider;
        finish({ name, api: provider });
      };
      window.addEventListener('Neo.DapiProvider.ready', onReady);
      timeout = setTimeout(() => finish(null), timeoutMs);
      window.dispatchEvent(new CustomEvent('Neo.DapiProvider.request', { detail: { version: '1.0' } }));
    });
  }

  async resolveNep21Account(provider) {
    const accounts = await provider.getAccounts().catch(() => []);
    const selected = accounts.find((entry) => entry?.isDefault) || accounts[0];
    const normalized = normalizeNep21Account(selected);
    if (normalized?.address) return normalized;

    if (typeof provider.authenticate !== 'function') {
      throw new Error(EC.walletAddressMissing);
    }

    const authenticated = await provider.authenticate({
      action: 'Authentication',
      grant_type: 'Signature',
      allowed_algorithms: ['ECDSA-P256'],
      domain: getAuthenticationDomain(),
      networks: provider.supportedNetworks?.length
        ? provider.supportedNetworks
        : [TESTNET_MAGIC, MAINNET_MAGIC],
      nonce: createNonce(),
      timestamp: Date.now(),
    });
    const address = String(authenticated?.address || '').trim();
    if (!address) throw new Error(EC.walletAddressMissing);
    const refreshed = await provider.getAccounts().catch(() => []);
    const refreshedAccount = refreshed.find((entry) => normalizeNep21Account(entry)?.address === address) || refreshed[0];
    return { address, hash: normalizeNep21Account(refreshedAccount)?.hash || '' };
  }

  getConnectProvider() {
    const nep21 = this.findNep21ProviderCandidate();
    if (nep21) {
      return {
        name: nep21.name || nep21.api?.name || 'NEP-21',
        kind: 'nep21',
        getAccount: () => this.resolveNep21Account(nep21.api),
      };
    }

    if (window.neo3Dapi?.getAccount) {
      return {
        name: 'neo3Dapi',
        getAccount: () => window.neo3Dapi.getAccount(),
      };
    }

    for (const candidate of this.getNeoLineProviderCandidates()) {
      if (typeof candidate.api?.getAccount === 'function') {
        return {
          name: candidate.name,
          getAccount: () => candidate.api.getAccount(),
        };
      }
    }

    return null;
  }

  getBatchInvokeProvider() {
    const nep21 = this.findNep21ProviderCandidate();
    if (typeof nep21?.api?.invoke === 'function') {
      return {
        name: nep21.name || nep21.api?.name || 'NEP-21',
        kind: 'nep21',
        invokeMultiple: ({ invokeArgs = [], signers = [] } = {}) => nep21.api.invoke(
          invokeArgs.map((entry) => buildNep21Invocation(entry, this.account?.hash, this.address)),
          buildNep21Signers(signers, this.account?.hash, this.address),
        ).then(normalizeTxResult),
      };
    }

    if (window.neo3Dapi?.invokeMultiple || window.neo3Dapi?.invokeMulti) {
      return {
        name: 'neo3Dapi',
        invokeMultiple: (params) => (window.neo3Dapi.invokeMultiple || window.neo3Dapi.invokeMulti)(params),
      };
    }

    for (const candidate of this.getNeoLineProviderCandidates()) {
      if (typeof candidate.api?.invokeMultiple === 'function') {
        return {
          name: candidate.name,
          invokeMultiple: (params) => candidate.api.invokeMultiple(params),
        };
      }
      if (typeof candidate.api?.invokeMulti === 'function') {
        return {
          name: candidate.name,
          invokeMultiple: (params) => candidate.api.invokeMulti(params),
        };
      }
    }

    return null;
  }

  getInvokeProvider() {
    const nep21 = this.findNep21ProviderCandidate();
    if (typeof nep21?.api?.invoke === 'function') {
      return {
        name: nep21.name || nep21.api?.name || 'NEP-21',
        kind: 'nep21',
        invoke: (params) => nep21.api.invoke(
          [buildNep21Invocation(params, this.account?.hash, this.address)],
          buildNep21Signers(params.signers, this.account?.hash, this.address),
        ).then(normalizeTxResult),
      };
    }

    if (window.neo3Dapi?.invoke) {
      return {
        name: 'neo3Dapi',
        invoke: (params) => window.neo3Dapi.invoke(params),
      };
    }

    for (const candidate of this.getNeoLineProviderCandidates()) {
      if (typeof candidate.api?.invoke === 'function') {
        return {
          name: candidate.name,
          invoke: (params) => candidate.api.invoke(params),
        };
      }
    }

    if (window.aaWallet?.invoke) {
      return {
        name: 'aaWallet',
        invoke: (params) => window.aaWallet.invoke(params),
      };
    }

    return null;
  }

  async connect() {
    let provider = this.getConnectProvider();
    if (!provider) {
      const nep21 = await this.waitForNep21Provider();
      if (nep21) {
        provider = {
          name: nep21.name || nep21.api?.name || 'NEP-21',
          kind: 'nep21',
          getAccount: () => this.resolveNep21Account(nep21.api),
        };
      }
    }
    if (!provider) {
      throw new Error(EC.walletProviderMissing);
    }

    const result = await provider.getAccount();
    const address = result?.address || result?.account?.address || '';
    if (!address) {
      throw new Error(EC.walletAddressMissing);
    }

    this.setConnected(address, { hash: result?.hash || result?.account?.hash || '', provider: provider.name });
    return { provider: provider.name, address };
  }


  getEvmProvider() {
    return window.ethereum || null;
  }

  getAvailableWalletModes() {
    return {
      neo: Boolean(this.getConnectProvider()),
      evm: Boolean(this.getEvmProvider()),
    };
  }

  async connectEvm() {
    const provider = this.getEvmProvider();
    if (!provider) {
      throw new Error(EC.evmProviderMissing);
    }

    const browserProvider = new BrowserProvider(provider);
    await browserProvider.send('eth_requestAccounts', []);
    const signer = await browserProvider.getSigner();
    const address = await signer.getAddress();
    return { provider: 'ethereum', address };
  }

  async signTypedDataWithEvm({ domain, types, message }) {
    const provider = this.getEvmProvider();
    if (!provider) {
      throw new Error(EC.evmProviderMissing);
    }

    const browserProvider = new BrowserProvider(provider);
    await browserProvider.send('eth_requestAccounts', []);
    const signer = await browserProvider.getSigner();
    return signer.signTypedData(domain, types, message);
  }

  async relayTransaction(request = {}) {
    const { relayEndpoint, ...requestBody } = request || {};
    const response = await fetchWithTimeout(relayEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const responsePayload = await response.json().catch(() => ({}));
    if (!response.ok || responsePayload?.error) {
      const err = new Error(EC.walletRequestFailed);
      err.rpcDetail = responsePayload?.message || responsePayload?.error || `HTTP ${response.status}`;
      throw err;
    }
    return responsePayload;
  }

  async invokeMultiple({ invokeArgs = [], signers = [] } = {}) {
    if (!this.isConnected) {
      throw new Error(EC.walletNotConnected);
    }

    const provider = this.getBatchInvokeProvider();
    if (!provider) {
      throw new Error(EC.invokeMultipleUnsupported);
    }

    return provider.invokeMultiple({ invokeArgs, signers });
  }

  async invoke(params) {
    if (!this.isConnected) {
      throw new Error(EC.walletNotConnected);
    }

    const provider = this.getInvokeProvider();
    if (!provider) {
      throw new Error(EC.walletProviderMissing);
    }

    return provider.invoke(params);
  }
}

export const walletService = new WalletService();
