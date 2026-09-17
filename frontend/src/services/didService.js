import '@/polyfills/buffer.js';
import { connectedDidProfile, setConnectedDidProfile } from '@/utils/did';
import { RUNTIME_CONFIG } from '@/config/runtimeConfig';
import { EC } from '../config/errorCodes.js';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout.js';
import { authenticateVerifiedDid } from './verifiedDidProfile.js';

const DID_STORAGE_KEY = 'aa_connected_did_profile';

function trim(value) {
  return String(value || '').trim();
}

async function verifyDidProfile(idToken) {
  const endpoint = trim(RUNTIME_CONFIG.didVerificationEndpoint);
  if (!endpoint || !trim(idToken)) return null;
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    const err = new Error(EC.didRequestFailed);
    err.rpcDetail = payload?.error || payload?.message || null;
    throw err;
  }
  return payload;
}

export class DidService {
  constructor({ config = RUNTIME_CONFIG, loadModal = () => import('@web3auth/modal'), verifyProfile = verifyDidProfile } = {}) {
    this.config = config;
    this.loadModal = loadModal;
    this.verifyProfile = verifyProfile;
    this.generation = 0;
    this.clientPromise = null;
    this.disconnectPromise = null;
    this.web3auth = null;
    this.bootstrap();
  }

  get isConfigured() {
    return Boolean(trim(this.config.web3AuthClientId));
  }

  get isConnected() {
    return Boolean(connectedDidProfile.value?.did);
  }

  get profile() {
    return connectedDidProfile.value;
  }

  bootstrap() {
    if (typeof window === 'undefined') return;
    try {
      // Cached metadata is not a verified session. Require SDK authentication.
      window.localStorage.removeItem(DID_STORAGE_KEY);
      setConnectedDidProfile(null);
    } catch (e) {
      if (import.meta.env.DEV) console.error('[didService] bootstrap localStorage parse failed:', e?.message);
      setConnectedDidProfile(null);
    }
  }

  persist(profile) {
    setConnectedDidProfile(profile);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(DID_STORAGE_KEY);
    } catch { /* Storage access must not prevent in-memory logout. */ }
  }

  async ensureClient() {
    if (!this.isConfigured || typeof window === 'undefined') return null;
    if (this.web3auth) return this.web3auth;
    if (!this.clientPromise) {
      this.clientPromise = this.initializeClient().finally(() => { this.clientPromise = null; });
    }
    return this.clientPromise;
  }

  async initializeClient() {
    const modal = await this.loadModal();
    const config = this.config;
    const chainNamespace = modal.CHAIN_NAMESPACES?.EIP155 || config.web3AuthChainNamespace || 'eip155';
    const network = modal.WEB3AUTH_NETWORK?.[config.web3AuthNetwork] || config.web3AuthNetwork;
    const loginMethods = {};

    if (config.web3AuthEmailLoginEnabled) {
      loginMethods.email_passwordless = { name: 'Email' };
    }
    if (config.web3AuthSmsLoginEnabled) {
      loginMethods.sms_passwordless = { name: 'SMS' };
    }

    const options = {
      clientId: config.web3AuthClientId,
      web3AuthNetwork: network,
      chainConfig: {
        chainNamespace,
        chainId: config.web3AuthChainId,
        rpcTarget: config.web3AuthRpcTarget,
      },
      modalConfig: {},
      uiConfig: {
        appName: config.web3AuthProjectName || 'DID.Morpheus',
        mode: 'dark',
        loginMethods,
      },
    };

    if (trim(config.web3AuthRedirectUrl)) {
      options.redirectUrl = config.web3AuthRedirectUrl;
    }

    const client = new modal.Web3Auth(options);
    await client.init();
    this.web3auth = client;
    return this.web3auth;
  }

  assertCurrent(generation) {
    if (generation !== this.generation || this.disconnectPromise) throw new Error('did_session_changed');
  }

  async refreshProfile(generation = ++this.generation) {
    this.assertCurrent(generation);
    const client = await this.ensureClient();
    this.assertCurrent(generation);
    if (!client) return null;

    let userInfo = null;
    try {
      userInfo = await client.getUserInfo();
    } catch (e) {
      if (import.meta.env.DEV) console.error('[didService] getUserInfo failed:', e?.message);
      userInfo = null;
    }
    try {
      this.assertCurrent(generation);
      const profile = await authenticateVerifiedDid(client, this.verifyProfile);
      this.assertCurrent(generation);
      this.persist({ ...profile, rawUserInfo: userInfo || {} });
      return this.profile;
    } catch (error) {
      if (generation === this.generation) this.persist(null);
      throw error;
    }
  }

  async connect({ loginProvider } = {}) {
    if (this.disconnectPromise) throw new Error('did_session_changed');
    const generation = ++this.generation;
    const client = await this.ensureClient();
    this.assertCurrent(generation);
    if (!client) {
      throw new Error(EC.web3AuthDidNotConfigured);
    }

    if (loginProvider && typeof client.connectTo === 'function') {
      const modal = await this.loadModal();
      this.assertCurrent(generation);
      const connector = modal.WALLET_CONNECTORS?.AUTH || 'auth';
      await client.connectTo(connector, { loginProvider });
    } else {
      await client.connect();
    }

    this.assertCurrent(generation);
    const profile = await this.refreshProfile(generation);
    if (!profile?.did) {
      throw new Error(EC.web3AuthNoDidDerived);
    }
    return profile;
  }

  async disconnect() {
    if (this.disconnectPromise) return this.disconnectPromise;
    ++this.generation;
    this.persist(null);
    this.disconnectPromise = (async () => {
      const client = this.web3auth || await this.clientPromise?.catch(() => null);
      if (typeof client?.logout === 'function') await client.logout();
    })().finally(() => {
      ++this.generation;
      this.persist(null);
      this.disconnectPromise = null;
    });
    return this.disconnectPromise;
  }

  buildNeoDidSubject() {
    const profile = this.profile;
    if (!profile?.provider || !profile?.idToken) return null;
    return {
      provider: profile.provider,
      provider_uid: profile.providerUid || '',
      id_token: profile.idToken,
      metadata: {
        email: profile.email || undefined,
        phone: profile.phone || undefined,
        linked_accounts: profile.linkedAccounts,
        aggregate_verifier: profile.aggregateVerifier || undefined,
      },
    };
  }
}

export const didService = new DidService();
