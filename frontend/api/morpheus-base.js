import { MORPHEUS_PUBLIC_REGISTRY } from '../src/config/generatedMorpheusRegistry.js';
import { MORPHEUS_PUBLIC_RUNTIME_CATALOG } from '../src/config/generatedMorpheusRuntimeCatalog.js';
import { envFlagEnabled, isProductionDeployment } from './deploymentEnv.js';

function trim(value) {
  return String(value || '').trim();
}

export function normalizeNetwork(value) {
  return trim(value).toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
}

// AA-08: which network pays for a relay (which operator WIF signs, mainnet vs testnet) is a
// server-side operator decision, not a client choice — otherwise an anonymous caller can
// pass `morpheus_network` to make the MAINNET operator fund their testnet relay (or vice
// versa). Client-supplied selection (query/body/header) is therefore IGNORED unless the
// operator explicitly opts in via SA_RELAY_ALLOW_CLIENT_NETWORK=1, and that override is
// itself ignored in production (fail closed — default safe, explicit dev opt-in, production
// ignores the override, mirroring the morpheus sandbox guard).
function allowsClientNetworkSelection() {
  if (isProductionDeployment()) return false;
  return envFlagEnabled(process.env.SA_RELAY_ALLOW_CLIENT_NETWORK || '');
}

export function resolveNetwork(req) {
  const serverNetwork = normalizeNetwork(
    process.env.MORPHEUS_NETWORK
      || process.env.VITE_SA_NETWORK
      || process.env.VITE_MORPHEUS_NETWORK
  );
  if (!allowsClientNetworkSelection()) return serverNetwork;
  return normalizeNetwork(
    req.query?.morpheus_network
      || req.body?.morpheus_network
      || req.headers?.['x-morpheus-network']
      || serverNetwork
  );
}

function normalizeUrl(value) {
  return trim(value).replace(/\/$/, '');
}

function isNetworkScopedHost(hostname) {
  const host = trim(hostname).toLowerCase();
  return host === 'oracle.meshmini.app';
}

function isGatewayHost(hostname) {
  const host = trim(hostname).toLowerCase();
  return host === 'edge.meshmini.app'
    || host === 'control.meshmini.app'
    || host.endsWith('.workers.dev');
}

function normalizeBaseCandidate(baseUrl, network) {
  const normalized = normalizeUrl(baseUrl);
  if (!normalized) return '';
  if (/\/(mainnet|testnet)$/.test(normalized)) return normalized;

  try {
    const parsed = new URL(normalized);
    if (isNetworkScopedHost(parsed.hostname)) return normalized;
    if (isGatewayHost(parsed.hostname)) return `${normalized}/${network}`;
    return normalized;
  } catch {
    return normalized;
  }
}

function getRegistryRuntimeDefaults(network) {
  return MORPHEUS_PUBLIC_REGISTRY[normalizeNetwork(network)].morpheus;
}

function resolveWorkflowRoute(workflowId) {
  const workflow = MORPHEUS_PUBLIC_RUNTIME_CATALOG.workflows.find((item) => item.id === trim(workflowId));
  return trim(workflow?.route || '');
}

export function resolveMorpheusWorkflowIds() {
  return MORPHEUS_PUBLIC_RUNTIME_CATALOG.workflows.map((item) => item.id);
}

export function resolveMorpheusRuntimeBase(req, networkOverride = '') {
  // AA-08: req-driven resolution is gated server-side (see resolveNetwork). Internal callers
  // that already resolved the network from server-side state pass it explicitly via
  // networkOverride instead of smuggling it through a synthetic client query.
  const network = trim(networkOverride) ? normalizeNetwork(networkOverride) : resolveNetwork(req);
  const upper = network === 'testnet' ? 'TESTNET' : 'MAINNET';
  const registryDefaults = getRegistryRuntimeDefaults(network);
  const candidates = [
    process.env[`MORPHEUS_${upper}_RUNTIME_URL`],
    process.env.MORPHEUS_RUNTIME_URL,
    process.env[`MORPHEUS_${upper}_API_BASE_URL`],
    process.env.MORPHEUS_API_BASE_URL,
    process.env[`MORPHEUS_${upper}_EDGE_BASE_URL`],
    process.env.MORPHEUS_EDGE_BASE_URL,
    registryDefaults.publicApiUrl,
    registryDefaults.edgeUrl,
  ];

  for (const candidate of candidates) {
    const resolved = normalizeBaseCandidate(candidate, network);
    if (resolved) return resolved;
  }
  return '';
}

export function resolveMorpheusPaymasterEndpoint(networkInput) {
  const network = normalizeNetwork(networkInput);
  const upper = network === 'testnet' ? 'TESTNET' : 'MAINNET';
  const explicit = normalizeUrl(
    process.env[`MORPHEUS_PAYMASTER_${upper}_ENDPOINT`]
      || process.env.MORPHEUS_PAYMASTER_ENDPOINT
      || process.env.SA_PAYMASTER_ENDPOINT
      || ''
  );
  if (explicit) return explicit;
  const base = resolveMorpheusRuntimeBase({}, network);
  const paymasterRoute = resolveWorkflowRoute('paymaster.authorize') || '/paymaster/authorize';
  return base ? `${base}${paymasterRoute}` : '';
}

export function resolveMorpheusOracleCvmId(networkInput) {
  const network = normalizeNetwork(networkInput);
  const upper = network === 'testnet' ? 'TESTNET' : 'MAINNET';
  return trim(
    process.env[`MORPHEUS_${upper}_PAYMASTER_APP_ID`]
      || process.env[`MORPHEUS_${upper}_ORACLE_CVM_ID`]
      || process.env.MORPHEUS_PAYMASTER_APP_ID
      || process.env.MORPHEUS_ORACLE_CVM_ID
      || MORPHEUS_PUBLIC_RUNTIME_CATALOG.networks?.[network]?.morpheus?.oracleCvmId
      || ''
  );
}

export function resolveMorpheusRuntimeToken(networkInput) {
  const network = normalizeNetwork(networkInput);
  const upper = network === 'testnet' ? 'TESTNET' : 'MAINNET';
  return trim(
    process.env[`MORPHEUS_${upper}_RUNTIME_TOKEN`]
      || process.env.MORPHEUS_RUNTIME_TOKEN
      || ''
  );
}
