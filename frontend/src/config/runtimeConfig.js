import { MORPHEUS_PUBLIC_REGISTRY } from './generatedMorpheusRegistry.js';
import { MORPHEUS_PUBLIC_RUNTIME_CATALOG } from './generatedMorpheusRuntimeCatalog.js';
import { sanitizeHex } from '../utils/hex.js';

export { sanitizeHex };

function stripHexPrefix(value) {
  return String(value || '').replace(/^0x/i, '');
}

function stripNetworkSuffix(value) {
  return String(value || '').replace(/\/(mainnet|testnet)\/?$/i, '');
}

const MAINNET_REGISTRY = MORPHEUS_PUBLIC_REGISTRY.mainnet;
const TESTNET_REGISTRY = MORPHEUS_PUBLIC_REGISTRY.testnet;
const MORPHEUS_WORKFLOW_IDS = MORPHEUS_PUBLIC_RUNTIME_CATALOG.workflows.map((workflow) => workflow.id);
const MORPHEUS_RUNTIME_TOPOLOGY = MORPHEUS_PUBLIC_RUNTIME_CATALOG.topology;
const MORPHEUS_RISK_ACTIONS = [...(MORPHEUS_PUBLIC_RUNTIME_CATALOG.risk?.actions || [])];
const MORPHEUS_AUTOMATION_TRIGGER_KINDS = [...(MORPHEUS_PUBLIC_RUNTIME_CATALOG.automation?.triggerKinds || [])];

export const DEFAULT_MORPHEUS_ENVELOPE_VERSION = MORPHEUS_PUBLIC_RUNTIME_CATALOG.envelope.version;
export const DEFAULT_MORPHEUS_WORKFLOW_IDS = [...MORPHEUS_WORKFLOW_IDS];
export const DEFAULT_MORPHEUS_TOPOLOGY = { ...MORPHEUS_RUNTIME_TOPOLOGY };
export const DEFAULT_MORPHEUS_RISK_ACTIONS = [...MORPHEUS_RISK_ACTIONS];
export const DEFAULT_MORPHEUS_AUTOMATION_TRIGGER_KINDS = [...MORPHEUS_AUTOMATION_TRIGGER_KINDS];

// Neo N3 network magic per network. The V3 UserOperation verifier bakes this
// value into the EIP-712 domain chainId it checks on-chain, so signing must use
// the magic of the *connected* network rather than a single hardcoded constant.
export const DEFAULT_NETWORK_MAGIC = MAINNET_REGISTRY.networkMagic;
export const DEFAULT_NETWORK_MAGIC_TESTNET = TESTNET_REGISTRY.networkMagic;

export const DEFAULT_ABSTRACT_ACCOUNT_HASH = stripHexPrefix(MAINNET_REGISTRY.contracts.aaCore);
export const DEFAULT_ABSTRACT_ACCOUNT_HASH_TESTNET = stripHexPrefix(TESTNET_REGISTRY.contracts.aaCore);
export const DEFAULT_AA_ADDRESS_MARKET_HASH = stripHexPrefix(MAINNET_REGISTRY.contracts.aaAddressMarket);
export const DEFAULT_AA_ADDRESS_MARKET_HASH_TESTNET = stripHexPrefix(TESTNET_REGISTRY.contracts.aaAddressMarket);
export const DEFAULT_AA_PAYMASTER_HASH = stripHexPrefix(MAINNET_REGISTRY.contracts.aaPaymaster);
export const DEFAULT_AA_PAYMASTER_HASH_TESTNET = stripHexPrefix(TESTNET_REGISTRY.contracts.aaPaymaster);
export const DEFAULT_RPC_URL = MAINNET_REGISTRY.rpcUrl;
export const DEFAULT_RPC_URL_TESTNET = TESTNET_REGISTRY.rpcUrl;
export const DEFAULT_RELAY_ENDPOINT = '/api/relay-transaction';
export const DEFAULT_EXPLORER_BASE_URL = 'https://neotube.io/tx/';
// Matrix NameService is network-scoped; each hash comes from the reviewed
// Morpheus registry, never from the other network's fallback.
export const DEFAULT_MATRIX_CONTRACT_HASH = stripHexPrefix(MAINNET_REGISTRY.contracts.matrixNameService || '');
export const DEFAULT_MATRIX_CONTRACT_HASH_TESTNET = stripHexPrefix(TESTNET_REGISTRY.contracts.matrixNameService || '');
export const DEFAULT_N3INDEX_API_BASE_URL = 'https://api.n3index.dev';
export const DEFAULT_N3INDEX_NETWORK = 'mainnet';
export const DEFAULT_NEO_NNS_CONTRACT_HASH = '50ac1c37690cc2cfc594472833cf57505d5f46de';
export const DEFAULT_WEB3AUTH_NETWORK = 'sapphire_mainnet';
export const DEFAULT_WEB3AUTH_CHAIN_NAMESPACE = 'eip155';
export const DEFAULT_WEB3AUTH_CHAIN_ID = '0x1';
export const DEFAULT_WEB3AUTH_RPC_TARGET = 'https://rpc.ankr.com/eth';
export const DEFAULT_WEB3AUTH_PROJECT_NAME = 'DID.Morpheus';
export const DEFAULT_DID_PROVIDER = 'web3auth';
export const DEFAULT_ABSTRACT_ACCOUNT_DOMAIN = MAINNET_REGISTRY.domains.aa;
export const DEFAULT_NEODID_DOMAIN = MAINNET_REGISTRY.domains.neodid;
export const DEFAULT_MORPHEUS_EDGE_BASE_URL = stripNetworkSuffix(MAINNET_REGISTRY.morpheus.edgeUrl);
export const DEFAULT_MORPHEUS_CONTROL_PLANE_BASE_URL = MAINNET_REGISTRY.morpheus.controlPlaneBaseUrl;
export const DEFAULT_MORPHEUS_API_BASE_URL = MAINNET_REGISTRY.morpheus.publicApiUrl;
export const DEFAULT_MORPHEUS_API_BASE_URL_TESTNET = TESTNET_REGISTRY.morpheus.publicApiUrl;
export const DEFAULT_MORPHEUS_ORACLE_CVM_ID = MAINNET_REGISTRY.morpheus.oracleCvmId;
export const DEFAULT_MORPHEUS_ORACLE_CVM_NAME = MAINNET_REGISTRY.morpheus.oracleCvmName;
export const DEFAULT_MORPHEUS_ORACLE_ATTESTATION_EXPLORER_URL =
  MAINNET_REGISTRY.morpheus.oracleAttestationExplorerUrl;
export const DEFAULT_MORPHEUS_DATAFEED_CVM_ID = TESTNET_REGISTRY.morpheus.datafeedCvmId;
export const DEFAULT_MORPHEUS_DATAFEED_CVM_NAME = TESTNET_REGISTRY.morpheus.datafeedCvmName;
export const DEFAULT_MORPHEUS_DATAFEED_ATTESTATION_EXPLORER_URL =
  TESTNET_REGISTRY.morpheus.datafeedAttestationExplorerUrl;
export const DEFAULT_MORPHEUS_NEODID_SERVICE_DID = MAINNET_REGISTRY.morpheus.neoDidServiceDid;

export const MORPHEUS_NETWORK_DEFAULTS = {
  mainnet: {
    abstractAccountHash: DEFAULT_ABSTRACT_ACCOUNT_HASH,
    abstractAccountDomain: MAINNET_REGISTRY.domains.aa,
    addressMarketHash: DEFAULT_AA_ADDRESS_MARKET_HASH,
    paymasterHash: DEFAULT_AA_PAYMASTER_HASH,
    rpcUrl: MAINNET_REGISTRY.rpcUrl,
    networkMagic: DEFAULT_NETWORK_MAGIC,
    n3IndexNetwork: 'mainnet',
    neoDidDomain: MAINNET_REGISTRY.domains.neodid,
    morpheusApiBaseUrl: MAINNET_REGISTRY.morpheus.publicApiUrl,
  },
  testnet: {
    abstractAccountHash: DEFAULT_ABSTRACT_ACCOUNT_HASH_TESTNET,
    abstractAccountDomain: TESTNET_REGISTRY.domains.aa,
    addressMarketHash: DEFAULT_AA_ADDRESS_MARKET_HASH_TESTNET,
    paymasterHash: DEFAULT_AA_PAYMASTER_HASH_TESTNET,
    rpcUrl: TESTNET_REGISTRY.rpcUrl,
    networkMagic: DEFAULT_NETWORK_MAGIC_TESTNET,
    n3IndexNetwork: 'testnet',
    neoDidDomain: TESTNET_REGISTRY.domains.neodid,
    morpheusApiBaseUrl: TESTNET_REGISTRY.morpheus.publicApiUrl,
  },
};

export function resolveRuntimeNetwork(env = import.meta.env ?? {}) {
  const normalized = String(
    env.VITE_AA_NETWORK
      || env.VITE_MORPHEUS_NETWORK
      || env.VITE_N3INDEX_NETWORK
      || DEFAULT_N3INDEX_NETWORK
  ).trim().toLowerCase();
  return normalized === 'testnet' ? 'testnet' : 'mainnet';
}

export function resolveNetworkMagic(value, fallback = DEFAULT_NETWORK_MAGIC) {
  const normalized = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

export function resolveAbstractAccountHash(value, fallback = DEFAULT_ABSTRACT_ACCOUNT_HASH) {
  const normalized = sanitizeHex(value);
  if (!/^[0-9a-f]{40}$/.test(normalized)) return fallback;
  return normalized;
}

export function resolveRpcUrl(value, fallback = DEFAULT_RPC_URL) {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

export function resolveOptionalUrl(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

export function resolveOptionalToken(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

export function resolveOptionalHash(value, fallback = '') {
  const normalized = sanitizeHex(value);
  if (!normalized) return fallback;
  if (!/^[0-9a-f]{40}$/.test(normalized)) return fallback;
  return normalized;
}

export function resolveOptionalNetwork(value, fallback = DEFAULT_N3INDEX_NETWORK) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'mainnet' || normalized === 'testnet') return normalized;
  return fallback;
}

export function resolveOptionalBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

export function getRuntimeConfig(env = import.meta.env ?? {}) {
  const runtimeNetwork = resolveRuntimeNetwork(env);
  const networkDefaults = MORPHEUS_NETWORK_DEFAULTS[runtimeNetwork];
  return {
    morpheusNetwork: runtimeNetwork,
    abstractAccountHash: resolveAbstractAccountHash(
      env.VITE_AA_HASH || env.VITE_ABSTRACT_ACCOUNT_HASH,
      networkDefaults.abstractAccountHash
    ),
    abstractAccountDomain: resolveOptionalUrl(
      env.VITE_AA_DOMAIN || env.VITE_ABSTRACT_ACCOUNT_DOMAIN,
      networkDefaults.abstractAccountDomain
    ),
    rpcUrl: resolveRpcUrl(
      env.VITE_AA_RPC_URL || env.VITE_NEO_RPC_URL,
      networkDefaults.rpcUrl
    ),
    networkMagic: resolveNetworkMagic(
      env.VITE_AA_NETWORK_MAGIC || env.VITE_NEO_NETWORK_MAGIC,
      networkDefaults.networkMagic
    ),
    supabaseUrl: resolveOptionalUrl(
      env.VITE_SUPABASE_URL || env.VITE_SUPABASE_PROJECT_URL
    ),
    supabaseAnonKey: resolveOptionalToken(
      env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY
    ),
    relayEndpoint: resolveOptionalUrl(
      env.VITE_AA_RELAY_URL || env.VITE_RELAY_ENDPOINT,
      DEFAULT_RELAY_ENDPOINT
    ),
    relayRpcUrl: resolveOptionalUrl(
      env.VITE_AA_RELAY_RPC_URL || env.VITE_NEO_RPC_URL || env.VITE_AA_RPC_URL,
      networkDefaults.rpcUrl
    ),
    relayMetaEnabled: resolveOptionalBoolean(
      env.VITE_AA_RELAY_META_ENABLED || env.VITE_RELAY_META_ENABLED,
      false
    ),
    relayRawEnabled: resolveOptionalBoolean(
      env.VITE_AA_RELAY_RAW_ENABLED || env.VITE_RELAY_RAW_ENABLED,
      false
    ),
    explorerBaseUrl: resolveOptionalUrl(
      env.VITE_AA_EXPLORER_BASE_URL || env.VITE_EXPLORER_BASE_URL,
      DEFAULT_EXPLORER_BASE_URL
    ),
    matrixContractHash: resolveOptionalHash(
      (runtimeNetwork === 'testnet' ? env.VITE_MATRIX_CONTRACT_HASH_TESTNET : env.VITE_MATRIX_CONTRACT_HASH_MAINNET)
        || env.VITE_AA_MATRIX_CONTRACT_HASH || env.VITE_MATRIX_CONTRACT_HASH,
      runtimeNetwork === 'testnet' ? DEFAULT_MATRIX_CONTRACT_HASH_TESTNET : DEFAULT_MATRIX_CONTRACT_HASH
    ),
    addressMarketHash: resolveOptionalHash(
      env.VITE_AA_MARKET_HASH || env.VITE_AA_ADDRESS_MARKET_HASH,
      networkDefaults.addressMarketHash
    ),
    paymasterHash: resolveOptionalHash(
      env.VITE_AA_PAYMASTER_HASH || env.VITE_AA_PAYMASTER_CONTRACT_HASH,
      networkDefaults.paymasterHash
    ),
    n3IndexApiBaseUrl: resolveOptionalUrl(
      env.VITE_AA_N3INDEX_API_BASE_URL || env.VITE_N3INDEX_API_BASE_URL,
      DEFAULT_N3INDEX_API_BASE_URL
    ),
    n3IndexNetwork: resolveOptionalNetwork(
      env.VITE_AA_N3INDEX_NETWORK || env.VITE_N3INDEX_NETWORK,
      networkDefaults.n3IndexNetwork
    ),
    neoNnsContractHash: resolveAbstractAccountHash(
      env.VITE_AA_NEO_NNS_CONTRACT_HASH || env.VITE_NEO_NNS_CONTRACT_HASH,
      DEFAULT_NEO_NNS_CONTRACT_HASH
    ),
    web3AuthClientId: resolveOptionalToken(
      env.VITE_WEB3AUTH_CLIENT_ID
    ),
    web3AuthProjectName: resolveOptionalUrl(
      env.VITE_WEB3AUTH_PROJECT_NAME,
      DEFAULT_WEB3AUTH_PROJECT_NAME
    ),
    web3AuthNetwork: resolveOptionalUrl(
      env.VITE_WEB3AUTH_NETWORK,
      DEFAULT_WEB3AUTH_NETWORK
    ),
    web3AuthChainNamespace: resolveOptionalUrl(
      env.VITE_WEB3AUTH_CHAIN_NAMESPACE,
      DEFAULT_WEB3AUTH_CHAIN_NAMESPACE
    ),
    web3AuthChainId: resolveOptionalUrl(
      env.VITE_WEB3AUTH_CHAIN_ID,
      DEFAULT_WEB3AUTH_CHAIN_ID
    ),
    web3AuthRpcTarget: resolveOptionalUrl(
      env.VITE_WEB3AUTH_RPC_TARGET,
      DEFAULT_WEB3AUTH_RPC_TARGET
    ),
    web3AuthRedirectUrl: resolveOptionalUrl(
      env.VITE_WEB3AUTH_REDIRECT_URL
    ),
    web3AuthEmailLoginEnabled: resolveOptionalBoolean(
      env.VITE_WEB3AUTH_EMAIL_LOGIN_ENABLED,
      true
    ),
    web3AuthSmsLoginEnabled: resolveOptionalBoolean(
      env.VITE_WEB3AUTH_SMS_LOGIN_ENABLED,
      true
    ),
    neoDidProvider: resolveOptionalUrl(
      env.VITE_NEODID_PROVIDER,
      DEFAULT_DID_PROVIDER
    ),
    neoDidDomain: resolveOptionalUrl(
      env.VITE_NEODID_DOMAIN,
      networkDefaults.neoDidDomain
    ),
    morpheusApiBaseUrl: resolveOptionalUrl(
      env[`VITE_MORPHEUS_${runtimeNetwork === 'testnet' ? 'TESTNET' : 'MAINNET'}_RUNTIME_URL`] || env.VITE_MORPHEUS_RUNTIME_URL || env.VITE_MORPHEUS_API_BASE_URL,
      networkDefaults.morpheusApiBaseUrl
    ),
    morpheusEnvelopeVersion: DEFAULT_MORPHEUS_ENVELOPE_VERSION,
    morpheusWorkflowIds: [...DEFAULT_MORPHEUS_WORKFLOW_IDS],
    morpheusTopology: { ...DEFAULT_MORPHEUS_TOPOLOGY },
    morpheusRiskPlane: DEFAULT_MORPHEUS_TOPOLOGY.riskPlane || '',
    morpheusRiskActions: [...DEFAULT_MORPHEUS_RISK_ACTIONS],
    morpheusAutomationTriggerKinds: [...DEFAULT_MORPHEUS_AUTOMATION_TRIGGER_KINDS],
    morpheusOracleCvmId: resolveOptionalUrl(
      env.VITE_MORPHEUS_ORACLE_CVM_ID,
      DEFAULT_MORPHEUS_ORACLE_CVM_ID
    ),
    morpheusOracleCvmName: resolveOptionalUrl(
      env.VITE_MORPHEUS_ORACLE_CVM_NAME,
      DEFAULT_MORPHEUS_ORACLE_CVM_NAME
    ),
    morpheusOracleAttestationExplorerUrl: resolveOptionalUrl(
      env.VITE_MORPHEUS_ORACLE_ATTESTATION_EXPLORER_URL,
      DEFAULT_MORPHEUS_ORACLE_ATTESTATION_EXPLORER_URL
    ),
    morpheusDatafeedCvmId: resolveOptionalUrl(
      env.VITE_MORPHEUS_DATAFEED_CVM_ID,
      DEFAULT_MORPHEUS_DATAFEED_CVM_ID
    ),
    morpheusDatafeedCvmName: resolveOptionalUrl(
      env.VITE_MORPHEUS_DATAFEED_CVM_NAME,
      DEFAULT_MORPHEUS_DATAFEED_CVM_NAME
    ),
    morpheusDatafeedAttestationExplorerUrl: resolveOptionalUrl(
      env.VITE_MORPHEUS_DATAFEED_ATTESTATION_EXPLORER_URL,
      DEFAULT_MORPHEUS_DATAFEED_ATTESTATION_EXPLORER_URL
    ),
    morpheusNeoDidServiceDid: resolveOptionalUrl(
      env.VITE_MORPHEUS_NEODID_SERVICE_DID,
      DEFAULT_MORPHEUS_NEODID_SERVICE_DID
    ),
    didVerificationEndpoint: resolveOptionalUrl(
      env.VITE_DID_VERIFICATION_ENDPOINT,
      '/api/did-verify'
    ),
    didNotificationEndpoint: resolveOptionalUrl(
      env.VITE_DID_NOTIFICATION_ENDPOINT,
      '/api/did-notify'
    ),
    morpheusNeoDidEndpoint: resolveOptionalUrl(
      env.VITE_MORPHEUS_NEODID_ENDPOINT,
      '/api/morpheus-neodid'
    ),
    morpheusNeoDidResolveEndpoint: resolveOptionalUrl(
      env.VITE_MORPHEUS_NEODID_RESOLVE_ENDPOINT,
      '/api/morpheus-neodid?action=resolve'
    ),
    morpheusOracleKeyEndpoint: resolveOptionalUrl(
      env.VITE_MORPHEUS_ORACLE_KEY_ENDPOINT,
      '/api/morpheus-oracle-public-key'
    ),
    didNotificationEmailEnabled: resolveOptionalBoolean(
      env.VITE_DID_NOTIFICATION_EMAIL_ENABLED,
      true
    ),
    didNotificationSmsEnabled: resolveOptionalBoolean(
      env.VITE_DID_NOTIFICATION_SMS_ENABLED,
      true
    ),
  };
}

export const RUNTIME_CONFIG = getRuntimeConfig();
