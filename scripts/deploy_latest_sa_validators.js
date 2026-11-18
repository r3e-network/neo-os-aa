#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');

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
  artifactPaths,
} = require('./lib/deploy-helpers');

const { rpc, sc, wallet, experimental } = neon;
const ROOT = path.resolve(__dirname, '..');
const REPORT_ROOT = path.join(ROOT, 'docs', 'reports');

const NETWORKS = {
  testnet: {
    magic: 894710606,
    rpcUrl: 'https://api.n3index.dev/testnet',
    coreHash: '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
    confirmation: 'CONFIRM_TESTNET_LATEST_SA_VALIDATORS',
    wifNames: ['SA_TESTNET_DEPLOY_WIF', 'NEO_TESTNET_WIF', 'TEST_SMOKE_ADMIN_WIF'],
  },
  mainnet: {
    magic: 860833102,
    rpcUrl: 'https://api.n3index.dev/mainnet',
    coreHash: '0x0268a387913b250166ddec032b03332690a1ef78',
    confirmation: 'CONFIRM_MAINNET_LATEST_SA_VALIDATORS',
    wifNames: ['SA_MAINNET_DEPLOY_WIF', 'NEO_MAINNET_WIF', 'MINIAPP_MAINNET_DEPLOY_WIF'],
  },
};

// Protocol v4 modules are validators bound by their canonical profile, not by a
// version marker: `getModuleProfile` returns the exact bytes whose SHA-256 the core
// configuration action commits to, and the callbacks are getModuleProfile /
// onInstall / configure / onUninstall / validateUserOp / onUserOpComplete
// (docs/SA-MODULE-PROTOCOL.md §9/§12).
const MODULE_CALLBACKS = [
  'getModuleProfile',
  'onInstall',
  'configure',
  'onUninstall',
  'validateUserOp',
  'onUserOpComplete',
];

const MODULES = {
  session: {
    artifact: 'SessionKeyValidator',
    publicArtifact: 'validators/SessionKeyValidator',
    moduleType: 'validator',
    requiredMethods: [
      ...MODULE_CALLBACKS,
      'authorizedCore',
      'setAuthorizedCore',
      'getSessionKey',
      'getSessionKeyMetadata',
      'getSpentAmount',
      'getGrantDigest',
      'getSignerDomains',
    ],
  },
  recovery: {
    artifact: 'ActionSessionValidator',
    publicArtifact: 'ActionSessionValidator',
    moduleType: 'validator',
    requiredMethods: [
      ...MODULE_CALLBACKS,
      'authorizedCore',
      'setAuthorizedCore',
      'getRecoveryService',
      'getRecoveryAuthority',
      'getSignerDomains',
    ],
  },
  service: {
    artifact: 'SocialRecoveryService',
    publicArtifact: 'SocialRecoveryService',
    version: '4.0.0',
    requiredMethods: [
      'version',
      'authorizedCore',
      'setAuthorizedCore',
      'setupRecovery',
      'getOwner',
      'cancelRecovery',
      'finalizeRecovery',
    ],
  },
};

function loadEnvFile(filePath) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`SA_ENV_FILE not found: ${resolved}`);
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
    throw new Error('Only --modules=session,recovery,service is supported');
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
  const { nef: nefPath, manifest: manifestPath } = artifactPaths(moduleConfig.publicArtifact);
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
  if (moduleConfig.artifact === 'SocialRecoveryService') {
    const accountMethods = manifestJson.abi?.methods?.filter((method) =>
      ['setupRecovery', 'getOwner', 'cancelRecovery', 'finalizeRecovery'].includes(method.name));
    if (accountMethods?.some((method) => method.parameters?.[0]?.type !== 'Hash160')) {
      throw new Error('SocialRecoveryService account IDs must use the Hash160 ABI');
    }
  }
  return {
    nef,
    manifest: sc.ContractManifest.fromJson(manifestJson),
    manifestJson,
    methods,
  };
}

function assertArtifactParity(state, artifact) {
  if (Number(state.nef?.checksum) !== Number(artifact.nef.checksum)) {
    throw new Error(`${artifact.manifestJson.name} on-chain checksum does not match the selected public artifact`);
  }
  const script = Buffer.from(state.nef?.script || '', 'base64');
  if (!script.equals(Buffer.from(artifact.nef.script, 'hex'))) {
    throw new Error(`${artifact.manifestJson.name} on-chain script does not match the selected public artifact`);
  }
  if (!isDeepStrictEqual(state.manifest, artifact.manifestJson)) {
    throw new Error(`${artifact.manifestJson.name} on-chain manifest does not match the selected public artifact`);
  }
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

/// Validates the bytes the module returns from getModuleProfile against the canonical
/// shape the core enforces at bind time (spec §12), and returns their digest.
function assertModuleProfile(moduleConfig, profileJson) {
  let profile;
  try {
    profile = JSON.parse(profileJson);
  } catch {
    throw new Error(`${moduleConfig.artifact} getModuleProfile did not return JSON`);
  }
  if (profile.profileVersion !== 1) {
    throw new Error(`${moduleConfig.artifact} profileVersion ${profile.profileVersion} is not 1`);
  }
  if (profile.moduleType !== moduleConfig.moduleType) {
    throw new Error(`${moduleConfig.artifact} profile moduleType ${profile.moduleType} is not ${moduleConfig.moduleType}`);
  }
  if (profile.contractName !== moduleConfig.artifact) {
    throw new Error(`${moduleConfig.artifact} profile contractName ${profile.contractName} does not match`);
  }
  const canonical = JSON.stringify(sortKeysDeep(profile));
  if (profileJson !== canonical) {
    throw new Error(`${moduleConfig.artifact} getModuleProfile bytes are not canonical`);
  }
  return { profile, profileSha256: `0x${crypto.createHash('sha256').update(profileJson, 'utf8').digest('hex')}` };
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = sortKeysDeep(value[key]);
        return sorted;
      }, {});
  }
  return value;
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
  assertArtifactParity(state, artifact);
  const liveMethods = state.manifest?.abi?.methods?.map((method) => method.name) || [];
  const missing = moduleConfig.requiredMethods.filter((method) => !liveMethods.includes(method));
  if (missing.length) throw new Error(`${moduleConfig.artifact} live ABI is missing: ${missing.join(', ')}`);
  let profile = null;
  let profileSha256 = null;
  if (moduleConfig.moduleType) {
    ({ profile, profileSha256 } = assertModuleProfile(
      moduleConfig,
      stackString(await invokeRead(client, predictedHash, 'getModuleProfile')),
    ));
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
    moduleType: profile?.moduleType || null,
    profileSha256,
    authorizedCore: currentCore,
    version: moduleConfig.version || null,
  };
}

async function main() {
  loadEnvFile(process.env.SA_ENV_FILE);
  const { network, requested, planOnly } = parseArgs(process.argv.slice(2));
  const networkConfig = { ...NETWORKS[network] };
  networkConfig.rpcUrl = process.env[`NEO_${network.toUpperCase()}_RPC_URL`] || networkConfig.rpcUrl;
  networkConfig.coreHash = normalizeHash(
    process.env[`SA_${network.toUpperCase()}_CORE_HASH`] || networkConfig.coreHash,
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
    throw new Error(`SA core is not deployed: ${networkConfig.coreHash}`);
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
    const reportPath = path.join(REPORT_ROOT, `${network}-latest-sa-validators.json`);
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
  assertArtifactParity,
  assertModuleProfile,
  parseArgs,
  stackBoolean,
  stackString,
};
