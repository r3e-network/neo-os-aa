#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  neon,
  sanitizeHex,
  normalizeHash,
  stackHash160,
  buildConfig,
  predictContractHash,
  hash160Param,
  withRpcRetry,
  waitForAppLog,
  assertVmState,
  invokePersisted,
  extractDeployedContractHash,
} = require('./lib/deploy-helpers');

const { rpc, sc, wallet, experimental } = neon;
const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_ROOT = path.join(ROOT, 'contracts', 'build');
const REPORT_ROOT = path.join(ROOT, 'docs', 'reports');

const NETWORKS = {
  testnet: {
    magic: 894710606,
    rpcUrl: 'https://api.n3index.dev/testnet',
    coreHash: '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
    confirmation: 'CONFIRM_TESTNET_LATEST_AA_VERIFIERS',
    wifNames: ['AA_TESTNET_DEPLOY_WIF', 'NEO_TESTNET_WIF', 'TEST_SMOKE_ADMIN_WIF'],
  },
  mainnet: {
    magic: 860833102,
    rpcUrl: 'https://api.n3index.dev/mainnet',
    coreHash: '0x0268a387913b250166ddec032b03332690a1ef78',
    confirmation: 'CONFIRM_MAINNET_LATEST_AA_VERIFIERS',
    wifNames: ['AA_MAINNET_DEPLOY_WIF', 'NEO_MAINNET_WIF', 'MINIAPP_MAINNET_DEPLOY_WIF'],
  },
};

const MODULES = {
  session: {
    artifact: 'SessionKeyVerifier',
    version: '2.0.0',
    requiredMethods: [
      'version',
      'supportsV3',
      'authorizedCore',
      'setAuthorizedCore',
      'setSessionKey',
      'clearSessionKey',
      'getSessionKey',
      'getSessionKeyMetadata',
      'getSpentAmount',
      'getPayload',
      'validateSignature',
      'postExecute',
    ],
  },
  recovery: {
    artifact: 'SocialRecoveryVerifier',
    version: '2.0.0',
    requiredMethods: [
      'supportsV3',
      'authorizedCore',
      'setAuthorizedCore',
      'setupRecovery',
      'getOwner',
      'cancelRecovery',
      'finalizeRecovery',
      'validateSignature',
      'postExecute',
    ],
  },
};

function loadEnvFile(filePath) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`AA_ENV_FILE not found: ${resolved}`);
  for (const line of fs.readFileSync(resolved, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = new Set(argv);
  const network = argv.find((value) => value.startsWith('--network='))?.split('=')[1] || '';
  if (!NETWORKS[network]) throw new Error('Use --network=testnet or --network=mainnet');
  const requested = (argv.find((value) => value.startsWith('--modules='))?.split('=')[1] || 'session,recovery')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0 || requested.some((name) => !MODULES[name])) {
    throw new Error('Only --modules=session,recovery is supported');
  }
  return { network, requested: [...new Set(requested)], planOnly: args.has('--plan') };
}

function resolveWif(config) {
  for (const name of config.wifNames) {
    if (process.env[name]) return process.env[name];
  }
  throw new Error(`${config.wifNames.join(', ')} is required`);
}

function loadArtifact(moduleConfig) {
  const nefPath = path.join(ARTIFACT_ROOT, `${moduleConfig.artifact}.nef`);
  const manifestPath = path.join(ARTIFACT_ROOT, `${moduleConfig.artifact}.manifest.json`);
  const nef = sc.NEF.fromBuffer(fs.readFileSync(nefPath));
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifestJson.name !== moduleConfig.artifact) {
    throw new Error(`${moduleConfig.artifact} manifest name mismatch`);
  }
  const methods = manifestJson.abi?.methods?.map((method) => method.name) || [];
  const missing = moduleConfig.requiredMethods.filter((method) => !methods.includes(method));
  if (missing.length) throw new Error(`${moduleConfig.artifact} artifact is missing: ${missing.join(', ')}`);
  if (moduleConfig.version && manifestJson.extra?.Version !== moduleConfig.version) {
    throw new Error(`${moduleConfig.artifact} must be version ${moduleConfig.version}`);
  }
  if (moduleConfig.artifact === 'SocialRecoveryVerifier') {
    const accountMethods = manifestJson.abi?.methods?.filter((method) =>
      ['setupRecovery', 'getOwner', 'cancelRecovery', 'finalizeRecovery'].includes(method.name));
    if (accountMethods?.some((method) => method.parameters?.[0]?.type !== 'Hash160')) {
      throw new Error('SocialRecoveryVerifier account IDs must use the Hash160 ABI');
    }
  }
  return {
    nef,
    manifest: sc.ContractManifest.fromJson(manifestJson),
    manifestJson,
    methods,
  };
}

async function contractState(client, contractHash) {
  try {
    return await withRpcRetry(`getContractState ${contractHash}`, () =>
      client.getContractState(sanitizeHex(contractHash)));
  } catch (error) {
    if (/unknown contract|contract not found|key not found/i.test(String(error?.message || error))) return null;
    throw error;
  }
}

function stackBoolean(item) {
  return item?.value === true || item?.value === 1 || item?.value === '1' || item?.value === 'true';
}

function stackString(item) {
  if (item?.type === 'ByteString' || item?.type === 'Buffer') {
    return Buffer.from(String(item.value || ''), 'base64').toString('utf8');
  }
  return String(item?.value || '');
}

async function invokeRead(client, hash, operation) {
  const result = await withRpcRetry(`${operation}.read`, () =>
    client.invokeFunction(sanitizeHex(hash), operation, []));
  if (/FAULT/i.test(String(result?.state || ''))) {
    throw new Error(`${operation} FAULT: ${result?.exception || 'unknown error'}`);
  }
  return result?.stack?.[0];
}

async function deployModule({ client, account, config, moduleName, moduleConfig, artifact, planOnly }) {
  const predictedHash = predictContractHash(account, artifact.nef.checksum, artifact.manifestJson.name);
  let state = await contractState(client, predictedHash);
  let deploymentTx = null;
  let status = state ? 'already_deployed' : 'planned';

  if (!planOnly && !state) {
    const txid = await withRpcRetry(`deploy ${moduleConfig.artifact}`, () =>
      experimental.deployContract(
        artifact.nef,
        artifact.manifest,
        buildConfig(account, config.magic, config.rpcUrl),
      ));
    const log = await waitForAppLog(client, txid, `deploy ${moduleConfig.artifact}`);
    assertVmState(log, `deploy ${moduleConfig.artifact}`, 'HALT');
    const actualHash = normalizeHash(extractDeployedContractHash(log) || predictedHash);
    if (actualHash !== predictedHash) {
      throw new Error(`${moduleConfig.artifact} deployed hash ${actualHash} did not match ${predictedHash}`);
    }
    deploymentTx = txid;
    status = 'deployed';
    state = await contractState(client, predictedHash);
  }

  if (planOnly) {
    return { module: moduleName, hash: predictedHash, status, deploymentTx, bindingTx: null };
  }
  if (!state) throw new Error(`${moduleConfig.artifact} was not found after deployment`);
  if (Number(state.nef?.checksum) !== Number(artifact.nef.checksum)) {
    throw new Error(`${moduleConfig.artifact} on-chain checksum does not match the latest artifact`);
  }
  const liveMethods = state.manifest?.abi?.methods?.map((method) => method.name) || [];
  const missing = moduleConfig.requiredMethods.filter((method) => !liveMethods.includes(method));
  if (missing.length) throw new Error(`${moduleConfig.artifact} live ABI is missing: ${missing.join(', ')}`);
  if (!stackBoolean(await invokeRead(client, predictedHash, 'supportsV3'))) {
    throw new Error(`${moduleConfig.artifact} supportsV3 did not return true`);
  }
  if (moduleConfig.version) {
    const version = stackString(await invokeRead(client, predictedHash, 'version'));
    if (version !== moduleConfig.version) {
      throw new Error(`${moduleConfig.artifact} live version ${version} did not match ${moduleConfig.version}`);
    }
  }

  let currentCore = stackHash160(await invokeRead(client, predictedHash, 'authorizedCore'));
  let bindingTx = null;
  if (currentCore === '0x0000000000000000000000000000000000000000') {
    const bind = await invokePersisted({
      client,
      account,
      networkMagic: config.magic,
      rpcUrl: config.rpcUrl,
      contractHash: predictedHash,
      operation: 'setAuthorizedCore',
      params: [hash160Param(config.coreHash)],
    });
    bindingTx = bind.txid;
    currentCore = stackHash160(await invokeRead(client, predictedHash, 'authorizedCore'));
  }
  if (currentCore !== config.coreHash) {
    throw new Error(`${moduleConfig.artifact} is bound to ${currentCore}, expected ${config.coreHash}`);
  }

  return {
    module: moduleName,
    artifact: moduleConfig.artifact,
    hash: predictedHash,
    status,
    deploymentTx,
    bindingTx,
    checksum: Number(artifact.nef.checksum),
    methodCount: liveMethods.length,
    supportsV3: true,
    authorizedCore: currentCore,
    version: moduleConfig.version || null,
  };
}

async function main() {
  loadEnvFile(process.env.AA_ENV_FILE);
  const { network, requested, planOnly } = parseArgs(process.argv.slice(2));
  const networkConfig = { ...NETWORKS[network] };
  networkConfig.rpcUrl = process.env[`NEO_${network.toUpperCase()}_RPC_URL`] || networkConfig.rpcUrl;
  networkConfig.coreHash = normalizeHash(
    process.env[`AA_${network.toUpperCase()}_CORE_HASH`] || networkConfig.coreHash,
  );
  if (!planOnly && process.env[networkConfig.confirmation] !== '1') {
    throw new Error(`Refusing to broadcast without ${networkConfig.confirmation}=1`);
  }

  const account = new wallet.Account(resolveWif(networkConfig));
  const client = new rpc.RPCClient(networkConfig.rpcUrl);
  const version = await withRpcRetry('getVersion', () => client.getVersion());
  const magic = Number(version?.protocol?.network);
  if (magic !== networkConfig.magic) {
    throw new Error(`RPC network magic mismatch: expected ${networkConfig.magic}, got ${magic}`);
  }
  if (!(await contractState(client, networkConfig.coreHash))) {
    throw new Error(`AA core is not deployed: ${networkConfig.coreHash}`);
  }

  const deployments = [];
  for (const moduleName of requested) {
    const moduleConfig = MODULES[moduleName];
    const artifact = loadArtifact(moduleConfig);
    deployments.push(await deployModule({
      client,
      account,
      config: networkConfig,
      moduleName,
      moduleConfig,
      artifact,
      planOnly,
    }));
  }

  const report = {
    network,
    networkMagic: magic,
    rpcUrl: networkConfig.rpcUrl,
    coreHash: networkConfig.coreHash,
    deployer: account.address,
    planOnly,
    deployments,
    generatedAt: new Date().toISOString(),
  };
  if (!planOnly) {
    const reportPath = path.join(REPORT_ROOT, `${network}-latest-aa-verifiers.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    report.reportPath = reportPath;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  NETWORKS,
  MODULES,
  loadArtifact,
  parseArgs,
  stackBoolean,
  stackString,
};
