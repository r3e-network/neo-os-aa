import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ABSTRACT_ACCOUNT_HASH,
  DEFAULT_ABSTRACT_ACCOUNT_HASH_TESTNET,
  DEFAULT_DID_PROVIDER,
  DEFAULT_EXPLORER_BASE_URL,
  DEFAULT_MATRIX_CONTRACT_HASH,
  DEFAULT_MATRIX_CONTRACT_HASH_TESTNET,
  DEFAULT_MORPHEUS_API_BASE_URL,
  DEFAULT_MORPHEUS_API_BASE_URL_TESTNET,
  DEFAULT_MORPHEUS_ENVELOPE_VERSION,
  DEFAULT_MORPHEUS_WORKFLOW_IDS,
  DEFAULT_MORPHEUS_TOPOLOGY,
  DEFAULT_MORPHEUS_RISK_ACTIONS,
  DEFAULT_MORPHEUS_AUTOMATION_TRIGGER_KINDS,
  DEFAULT_MORPHEUS_DATAFEED_ATTESTATION_EXPLORER_URL,
  DEFAULT_MORPHEUS_DATAFEED_CVM_ID,
  DEFAULT_MORPHEUS_DATAFEED_CVM_NAME,
  DEFAULT_MORPHEUS_ORACLE_ATTESTATION_EXPLORER_URL,
  DEFAULT_MORPHEUS_ORACLE_CVM_ID,
  DEFAULT_MORPHEUS_ORACLE_CVM_NAME,
  DEFAULT_N3INDEX_API_BASE_URL,
  DEFAULT_RPC_URL,
  DEFAULT_RPC_URL_TESTNET,
  DEFAULT_WEB3AUTH_CHAIN_ID,
  DEFAULT_WEB3AUTH_CHAIN_NAMESPACE,
  DEFAULT_WEB3AUTH_NETWORK,
  DEFAULT_WEB3AUTH_PROJECT_NAME,
  DEFAULT_WEB3AUTH_RPC_TARGET,
  MORPHEUS_NETWORK_DEFAULTS,
  getRuntimeConfig,
  resolveRuntimeNetwork,
  resolveAbstractAccountHash,
  resolveNetworkMagic,
  resolveOptionalHash,
  resolveRpcUrl,
  sanitizeHex
} from '../src/config/runtimeConfig.js';

test('sanitizeHex removes prefix and lowercases input', () => {
  assert.equal(sanitizeHex('0xABCD'), 'abcd');
  assert.equal(sanitizeHex('abcd'), 'abcd');
});

test('resolveAbstractAccountHash accepts valid 40-byte hex values', () => {
  assert.equal(
    resolveAbstractAccountHash('0x49C095CE04D38642E39155F5481615C58227A498'),
    '49c095ce04d38642e39155f5481615c58227a498'
  );
});

test('resolveAbstractAccountHash falls back for invalid values', () => {
  assert.equal(resolveAbstractAccountHash('bad-value'), DEFAULT_ABSTRACT_ACCOUNT_HASH);
});

test('default abstract account hash tracks the hardened verified deployment', () => {
  assert.equal(DEFAULT_ABSTRACT_ACCOUNT_HASH, '0268a387913b250166ddec032b03332690a1ef78');
});

test('testnet abstract account hash tracks the published V3 testnet deployment', () => {
  assert.equal(DEFAULT_ABSTRACT_ACCOUNT_HASH_TESTNET, 'dbf38e7b2117186bf7a5e17ead702322c0c5b6f2');
});

test('resolveRpcUrl preserves explicit values and defaults otherwise', () => {
  assert.equal(resolveRpcUrl('https://example.com/rpc'), 'https://example.com/rpc');
  assert.equal(resolveRpcUrl(''), DEFAULT_RPC_URL);
});

test('resolveOptionalHash preserves valid hashes and rejects invalid values', () => {
  assert.equal(resolveOptionalHash('0x49C095CE04D38642E39155F5481615C58227A498'), '49c095ce04d38642e39155f5481615c58227a498');
  assert.equal(resolveOptionalHash('bad-value'), '');
});

test('frontend ships a runtime env example for browser and server routes', () => {
  const examplePath = fileURLToPath(new URL('../.env.example', import.meta.url));
  assert.equal(fs.existsSync(examplePath), true, 'expected frontend/.env.example to exist');

  const example = fs.readFileSync(examplePath, 'utf8');
  assert.match(example, /VITE_AA_RPC_URL=/);
  assert.match(example, /VITE_SUPABASE_URL=/);
  assert.match(example, /VITE_SUPABASE_ANON_KEY=/);
  assert.match(example, /VITE_AA_RELAY_URL=/);
  assert.match(example, /VITE_AA_RELAY_META_ENABLED=/);
  assert.match(example, /VITE_AA_MATRIX_CONTRACT_HASH=/);
  assert.match(example, /VITE_AA_MARKET_HASH=/);
  assert.match(example, /VITE_AA_PAYMASTER_HASH=/);
  assert.match(example, /VITE_WEB3AUTH_CLIENT_ID=/);
  assert.match(example, /VITE_WEB3AUTH_PROJECT_NAME=/);
  assert.match(example, /VITE_WEB3AUTH_NETWORK=/);
  assert.match(example, /VITE_NEODID_PROVIDER=/);
  assert.match(example, /VITE_DID_VERIFICATION_ENDPOINT=/);
  assert.match(example, /VITE_DID_NOTIFICATION_ENDPOINT=/);
  assert.match(example, /VITE_MORPHEUS_NEODID_ENDPOINT=/);
  assert.match(example, /VITE_MORPHEUS_ORACLE_KEY_ENDPOINT=/);
  assert.match(example, /AA_RELAY_RPC_URL=/);
  assert.match(example, /AA_RELAY_WIF=/);
  assert.match(example, /AA_RELAY_ALLOWED_HASH=/);
  assert.match(example, /AA_RELAY_ALLOW_RAW_FORWARD=/);
  assert.match(example, /SUPABASE_SERVICE_ROLE_KEY=/);
  assert.match(example, /DID_EMAIL_WEBHOOK_URL=/);
  assert.match(example, /DID_SMS_WEBHOOK_URL=/);
  assert.match(example, /MORPHEUS_API_BASE_URL=/);
  assert.match(example, /MORPHEUS_RUNTIME_URL=/);
  assert.match(example, /VITE_MORPHEUS_RUNTIME_URL=/);
  assert.match(example, /server-only/i);
});

test('getRuntimeConfig prefers Vite overrides', () => {
  const config = getRuntimeConfig({
    VITE_AA_HASH: '0x1111111111111111111111111111111111111111',
    VITE_AA_RPC_URL: 'https://rpc.example.org'
  });

  assert.deepEqual(config, {
    morpheusNetwork: 'mainnet',
    abstractAccountHash: '1111111111111111111111111111111111111111',
    abstractAccountDomain: 'smartwallet.neo',
    rpcUrl: 'https://rpc.example.org',
    networkMagic: 860833102,
    supabaseUrl: '',
    supabaseAnonKey: '',
    relayEndpoint: '/api/relay-transaction',
    relayRpcUrl: 'https://rpc.example.org',
    relayMetaEnabled: false,
    relayRawEnabled: false,
    explorerBaseUrl: DEFAULT_EXPLORER_BASE_URL,
    matrixContractHash: DEFAULT_MATRIX_CONTRACT_HASH,
    addressMarketHash: 'ae7afe3a85ab08bfd1d4907b35ae8b80c75b3a69',
    paymasterHash: 'a0defa2bc6d7a71ba1e237149287c8ca4ff46caf',
    n3IndexApiBaseUrl: DEFAULT_N3INDEX_API_BASE_URL,
    n3IndexNetwork: 'mainnet',
    neoNnsContractHash: '50ac1c37690cc2cfc594472833cf57505d5f46de',
    web3AuthClientId: '',
    web3AuthProjectName: DEFAULT_WEB3AUTH_PROJECT_NAME,
    web3AuthNetwork: DEFAULT_WEB3AUTH_NETWORK,
    web3AuthChainNamespace: DEFAULT_WEB3AUTH_CHAIN_NAMESPACE,
    web3AuthChainId: DEFAULT_WEB3AUTH_CHAIN_ID,
    web3AuthRpcTarget: DEFAULT_WEB3AUTH_RPC_TARGET,
    web3AuthRedirectUrl: '',
    web3AuthEmailLoginEnabled: true,
    web3AuthSmsLoginEnabled: true,
    neoDidProvider: DEFAULT_DID_PROVIDER,
    neoDidDomain: 'neodid.morpheus.neo',
    morpheusApiBaseUrl: DEFAULT_MORPHEUS_API_BASE_URL,
    morpheusEnvelopeVersion: DEFAULT_MORPHEUS_ENVELOPE_VERSION,
    morpheusWorkflowIds: DEFAULT_MORPHEUS_WORKFLOW_IDS,
    morpheusTopology: DEFAULT_MORPHEUS_TOPOLOGY,
    morpheusRiskPlane: DEFAULT_MORPHEUS_TOPOLOGY.riskPlane,
    morpheusRiskActions: DEFAULT_MORPHEUS_RISK_ACTIONS,
    morpheusAutomationTriggerKinds: DEFAULT_MORPHEUS_AUTOMATION_TRIGGER_KINDS,
    morpheusOracleCvmId: DEFAULT_MORPHEUS_ORACLE_CVM_ID,
    morpheusOracleCvmName: DEFAULT_MORPHEUS_ORACLE_CVM_NAME,
    morpheusOracleAttestationExplorerUrl: DEFAULT_MORPHEUS_ORACLE_ATTESTATION_EXPLORER_URL,
    morpheusDatafeedCvmId: DEFAULT_MORPHEUS_DATAFEED_CVM_ID,
    morpheusDatafeedCvmName: DEFAULT_MORPHEUS_DATAFEED_CVM_NAME,
    morpheusDatafeedAttestationExplorerUrl: DEFAULT_MORPHEUS_DATAFEED_ATTESTATION_EXPLORER_URL,
    morpheusNeoDidServiceDid: 'did:morpheus:neo_n3:service:neodid',
    didVerificationEndpoint: '/api/did-verify',
    didNotificationEndpoint: '/api/did-notify',
    morpheusNeoDidEndpoint: '/api/morpheus-neodid',
    morpheusNeoDidResolveEndpoint: '/api/morpheus-neodid?action=resolve',
    morpheusOracleKeyEndpoint: '/api/morpheus-oracle-public-key',
    didNotificationEmailEnabled: true,
    didNotificationSmsEnabled: true,
  });
});

test('resolveRuntimeNetwork switches defaults to testnet when requested', () => {
  assert.equal(resolveRuntimeNetwork({ VITE_AA_NETWORK: 'testnet' }), 'testnet');
  assert.equal(resolveRuntimeNetwork({ VITE_MORPHEUS_NETWORK: 'testnet' }), 'testnet');
  assert.equal(resolveRuntimeNetwork({ VITE_N3INDEX_NETWORK: 'testnet' }), 'testnet');
  assert.equal(resolveRuntimeNetwork({ VITE_AA_NETWORK: 'mainnet' }), 'mainnet');
});

test('getRuntimeConfig uses testnet defaults when the selected runtime network is testnet', () => {
  const config = getRuntimeConfig({
    VITE_AA_NETWORK: 'testnet',
  });

  assert.equal(config.abstractAccountHash, DEFAULT_ABSTRACT_ACCOUNT_HASH_TESTNET);
  assert.equal(config.abstractAccountDomain, '');
  assert.equal(config.rpcUrl, DEFAULT_RPC_URL_TESTNET);
  assert.equal(config.relayRpcUrl, DEFAULT_RPC_URL_TESTNET);
  assert.equal(config.networkMagic, 894710606);
  assert.equal(config.n3IndexNetwork, 'testnet');
  assert.equal(config.neoDidDomain, '');
  assert.equal(config.morpheusNetwork, 'testnet');
  assert.equal(config.morpheusApiBaseUrl, DEFAULT_MORPHEUS_API_BASE_URL_TESTNET);
});

test('network magic follows the active runtime network', () => {
  assert.equal(getRuntimeConfig({ VITE_AA_NETWORK: 'mainnet' }).networkMagic, 860833102);
  assert.equal(getRuntimeConfig({ VITE_AA_NETWORK: 'testnet' }).networkMagic, 894710606);
  // Implicit default (no network override) resolves to mainnet, matching walletService.
  assert.equal(getRuntimeConfig({}).networkMagic, 860833102);
});

test('network magic honours an explicit override and rejects junk', () => {
  assert.equal(resolveNetworkMagic('123456789'), 123456789);
  assert.equal(getRuntimeConfig({ VITE_AA_NETWORK: 'testnet', VITE_AA_NETWORK_MAGIC: '111222333' }).networkMagic, 111222333);
  // Non-numeric / non-positive values fall back to the network default.
  assert.equal(getRuntimeConfig({ VITE_AA_NETWORK: 'testnet', VITE_AA_NETWORK_MAGIC: 'nope' }).networkMagic, 894710606);
});

test('network defaults keep mainnet and testnet anchors explicit', () => {
  assert.deepEqual(MORPHEUS_NETWORK_DEFAULTS.mainnet, {
    abstractAccountHash: '0268a387913b250166ddec032b03332690a1ef78',
    abstractAccountDomain: 'smartwallet.neo',
    addressMarketHash: 'ae7afe3a85ab08bfd1d4907b35ae8b80c75b3a69',
    paymasterHash: 'a0defa2bc6d7a71ba1e237149287c8ca4ff46caf',
    rpcUrl: 'https://api.n3index.dev/mainnet',
    networkMagic: 860833102,
    n3IndexNetwork: 'mainnet',
    neoDidDomain: 'neodid.morpheus.neo',
    morpheusApiBaseUrl: DEFAULT_MORPHEUS_API_BASE_URL,
  });
  assert.deepEqual(MORPHEUS_NETWORK_DEFAULTS.testnet, {
    abstractAccountHash: 'dbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
    abstractAccountDomain: '',
    addressMarketHash: '6b979cdd246cc6491a20000a2a822e497c92c23b',
    paymasterHash: '',
    rpcUrl: 'https://api.n3index.dev/testnet',
    networkMagic: 894710606,
    n3IndexNetwork: 'testnet',
    neoDidDomain: '',
    morpheusApiBaseUrl: DEFAULT_MORPHEUS_API_BASE_URL_TESTNET,
  });
});


test('Matrix resolver is network-scoped and testnet env cannot configure mainnet', () => {
  assert.equal(DEFAULT_MATRIX_CONTRACT_HASH, '994c3cbe0d8641b9c911452c37191de8dd9f5f4e');
  assert.equal(DEFAULT_MATRIX_CONTRACT_HASH_TESTNET, '994c3cbe0d8641b9c911452c37191de8dd9f5f4e');
  assert.equal(getRuntimeConfig({}).matrixContractHash, DEFAULT_MATRIX_CONTRACT_HASH);
  assert.equal(getRuntimeConfig({ VITE_AA_NETWORK: 'testnet' }).matrixContractHash, DEFAULT_MATRIX_CONTRACT_HASH_TESTNET);
  assert.equal(getRuntimeConfig({ VITE_MATRIX_CONTRACT_HASH_TESTNET: DEFAULT_MATRIX_CONTRACT_HASH_TESTNET }).matrixContractHash, DEFAULT_MATRIX_CONTRACT_HASH);
  assert.equal(getRuntimeConfig({ VITE_MATRIX_CONTRACT_HASH_MAINNET: '1'.repeat(40) }).matrixContractHash, '1'.repeat(40));
});

test('default n3index api base url tracks the documented public edge', () => {
  assert.equal(DEFAULT_N3INDEX_API_BASE_URL, 'https://api.n3index.dev');
});

test('production CSP allows the documented n3index browser API base', () => {
  const vercelConfigPath = fileURLToPath(new URL('../vercel.json', import.meta.url));
  const vercelConfig = JSON.parse(fs.readFileSync(vercelConfigPath, 'utf8'));
  const headers = vercelConfig.headers?.flatMap((entry) => entry.headers || []) || [];
  const csp = headers.find((header) => header.key === 'Content-Security-Policy')?.value || '';
  assert.match(csp, /connect-src[^;]*https:\/\/api\.n3index\.dev/);
});
