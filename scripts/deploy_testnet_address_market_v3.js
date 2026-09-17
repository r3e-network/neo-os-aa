#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  neon,
  sanitizeHex,
  withRpcRetry,
  loadArtifact,
  normalizeHash,
  predictContractHash,
  hash160Param,
  makeSigner,
  invokePersisted,
  deployArtifact,
} = require('./lib/deploy-helpers');

const { experimental, rpc, wallet } = neon;

const TESTNET_MAGIC = 894710606;
const DEFAULT_RPC_URL = 'https://testnet1.neo.coz.io:443';
const DEFAULT_CORE_HASH = '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2';
const REPORT_PATH = path.resolve(
  __dirname,
  '..',
  'docs',
  'reports',
  'testnet-aa-address-market-latest.json'
);

function stackBoolean(item) {
  return item?.value === true || item?.value === 1 || item?.value === '1' || item?.value === 'true';
}

function stackHash160(item) {
  if (!item?.value) return '';
  const bytes = Buffer.from(String(item.value), 'base64');
  return bytes.length === 20 ? `0x${Buffer.from(bytes).reverse().toString('hex')}` : '';
}

function hasMethod(contractState, name, parameterCount) {
  return (contractState?.manifest?.abi?.methods || []).some(
    (method) => method.name === name && method.parameters?.length === parameterCount
  );
}

async function invokeRead(client, contractHash, operation, params = [], signers = undefined) {
  return withRpcRetry(`${operation}.read`, () =>
    client.invokeFunction(sanitizeHex(contractHash), operation, params, signers)
  );
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && process.env.CONFIRM_TESTNET_AA_MARKET_DEPLOY !== '1') {
    throw new Error('Refusing to broadcast without CONFIRM_TESTNET_AA_MARKET_DEPLOY=1');
  }
  const secret = process.env.AA_TESTNET_DEPLOY_WIF || process.env.NEO_TESTNET_WIF || '';
  if (!secret) throw new Error('AA_TESTNET_DEPLOY_WIF or NEO_TESTNET_WIF is required');

  const rpcUrl = process.env.AA_TESTNET_RPC_URL || DEFAULT_RPC_URL;
  const coreHash = normalizeHash(process.env.AA_TESTNET_CORE_HASH || DEFAULT_CORE_HASH);
  const account = new wallet.Account(secret);
  const client = new rpc.RPCClient(rpcUrl);
  const version = await withRpcRetry('getVersion', () => client.getVersion());
  const networkMagic = Number(version?.protocol?.network);
  if (networkMagic !== TESTNET_MAGIC) {
    throw new Error(`RPC network magic mismatch: expected ${TESTNET_MAGIC}, got ${networkMagic}`);
  }

  const coreState = await withRpcRetry('get core contract state', () =>
    client.getContractState(sanitizeHex(coreHash))
  );
  for (const [name, count] of [
    ['enterMarketEscrow', 3],
    ['cancelMarketEscrow', 2],
    ['settleMarketEscrow', 3],
    ['forceCancelMarketEscrow', 1],
  ]) {
    if (!hasMethod(coreState, name, count)) {
      throw new Error(`AA core ${coreHash} is missing required ${name}/${count}`);
    }
  }

  const suffix = process.env.AA_TESTNET_MARKET_DEPLOY_SUFFIX || `v3-${Date.now().toString(36)}`;
  const artifact = loadArtifact('AAAddressMarket', suffix);
  const predictedHash = predictContractHash(account, artifact.nef.checksum, artifact.manifestName);
  if (!apply) {
    console.log(JSON.stringify({
      status: 'plan',
      network: 'testnet',
      networkMagic,
      deployer: account.address,
      coreHash,
      marketHash: predictedHash,
      manifestName: artifact.manifestName,
    }, null, 2));
    return;
  }

  const deploy = await deployArtifact({
    client,
    account,
    networkMagic,
    rpcUrl,
    baseName: 'AAAddressMarket',
    uniqueSuffix: suffix,
  });
  const allowed = await invokePersisted({
    client,
    account,
    networkMagic,
    rpcUrl,
    contractHash: deploy.hash,
    operation: 'setAllowedAA',
    params: [hash160Param(coreHash), neon.sc.ContractParam.boolean(true)],
    signers: [makeSigner(account.scriptHash)],
  });

  const [marketState, adminResult, allowedResult, listingCountResult] = await Promise.all([
    withRpcRetry('get market contract state', () => client.getContractState(sanitizeHex(deploy.hash))),
    invokeRead(client, deploy.hash, 'admin'),
    invokeRead(client, deploy.hash, 'isAllowedAA', [hash160Param(coreHash)]),
    invokeRead(client, deploy.hash, 'getListingCount'),
  ]);
  const adminHash = stackHash160(adminResult?.stack?.[0]);
  const expectedAdminHash = normalizeHash(account.scriptHash);
  if (adminHash !== expectedAdminHash) {
    throw new Error(`market admin mismatch: expected ${expectedAdminHash}, got ${adminHash || '(empty)'}`);
  }
  if (!stackBoolean(allowedResult?.stack?.[0])) throw new Error('AA core allowlist readback is false');
  if (String(listingCountResult?.stack?.[0]?.value || '0') !== '0') {
    throw new Error('new AA market unexpectedly contains listings');
  }
  for (const [name, count] of [
    ['admin', 0],
    ['setAllowedAA', 2],
    ['isAllowedAA', 1],
    ['abandonListing', 2],
    ['createListing', 5],
    ['settleListing', 3],
  ]) {
    if (!hasMethod(marketState, name, count)) {
      throw new Error(`deployed market is missing required ${name}/${count}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'pass',
    network: 'testnet',
    networkMagic,
    rpcUrl,
    deployer: account.address,
    adminHash,
    coreHash,
    marketHash: deploy.hash,
    manifestName: deploy.manifestName,
    deployTx: deploy.txid,
    allowCoreTx: allowed.txid,
    listingCount: '0',
    requiredAbiVerified: true,
    coreAllowlistVerified: true,
  };
  writeReport(report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
