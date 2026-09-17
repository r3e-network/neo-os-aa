#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpc, sc, wallet, experimental, tx, u, CONST } = require('@cityofzion/neon-js');
const { ethers } = require('ethers');

const { extractDeployedContractHash } = require('../src/deployLog');
const { AbstractAccountClient } = require('../src/index');
const { sanitizeHex } = require('../src/metaTx');
const { resolveTestnetRpcUrl } = require('./testnet-rpc');

let RPC_URL = process.env.TESTNET_RPC_URL || '';
const TEST_WIF = process.env.TEST_WIF || '';

if (!TEST_WIF) {
  console.error('TEST_WIF is required.');
  process.exit(1);
}

const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const ZERO_HASH160 = '0000000000000000000000000000000000000000';
const REGISTRATION_ESCAPE_TIMELOCK = 604800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRpcError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /socket hang up|ECONNRESET|ETIMEDOUT|fetch failed|network error|EAI_AGAIN|ECONNREFUSED|EADDRNOTAVAIL|socket disconnected before secure TLS connection was established|TLS connection was established|premature close|invalid response body/i.test(message);
}

async function withRpcRetry(label, fn, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt >= attempts) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[rpc-retry] ${label} attempt ${attempt}/${attempts} failed: ${message}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function artifactPaths(baseName) {
  return {
    nef: path.join(repoRoot(), 'contracts', 'bin', 'v3', `${baseName}.nef`),
    manifest: path.join(repoRoot(), 'contracts', 'bin', 'v3', `${baseName}.manifest.json`),
  };
}

function loadArtifact(baseName, uniqueSuffix) {
  const paths = artifactPaths(baseName);
  const nef = sc.NEF.fromBuffer(fs.readFileSync(paths.nef));
  const manifestJson = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  manifestJson.name = `${manifestJson.name}-${uniqueSuffix}`;
  const manifest = sc.ContractManifest.fromJson(manifestJson);
  return { nef, manifest };
}

function normalizeHash(value) {
  const hex = sanitizeHex(value || '');
  return hex ? `0x${hex}` : '';
}

function buildConfig(account, networkMagic) {
  return {
    account,
    networkMagic,
    rpcAddress: RPC_URL,
    blocksTillExpiry: 200,
  };
}

function hash160Param(value) {
  return sc.ContractParam.hash160(sanitizeHex(value));
}

function integerParam(value) {
  return sc.ContractParam.integer(typeof value === 'bigint' ? value.toString() : String(value));
}

function stringParam(value) {
  return sc.ContractParam.string(String(value));
}

function byteArrayParam(hexValue = '') {
  return sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(hexValue), true));
}

function anyParam(value) {
  return sc.ContractParam.any(value);
}

function makeSigner(scriptHash) {
  return new tx.Signer({ account: scriptHash, scopes: tx.WitnessScope.CalledByEntry });
}

function makeCustomContractSigner(scriptHash, allowedContracts = []) {
  return new tx.Signer({
    account: scriptHash,
    scopes: tx.WitnessScope.CustomContracts,
    allowedContracts: allowedContracts.map((value) => sanitizeHex(value)),
  });
}

async function waitForAppLog(client, txid, label, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const appLog = await client.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch (_) {}
    await sleep(3000);
  }
  throw new Error(`${label}: timed out waiting for application log for ${txid}`);
}

function assertVmState(appLog, label, expected = 'HALT') {
  const execution = appLog?.executions?.[0];
  if (!execution) throw new Error(`${label}: missing execution log`);
  const vmState = String(execution.vmstate || execution.state || '');
  if (!vmState.includes(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${vmState} ${execution.exception || ''}`.trim());
  }
  return execution;
}

async function deployContract(client, account, networkMagic, baseName, uniqueSuffix) {
  const { nef, manifest } = loadArtifact(baseName, uniqueSuffix);
  const predictedHash = normalizeHash(
    experimental.getContractHash(u.HexString.fromHex(account.scriptHash), nef.checksum, manifest.name)
  );
  const txid = await withRpcRetry(`deploy ${baseName}`, () => experimental.deployContract(nef, manifest, buildConfig(account, networkMagic)));
  const appLog = await waitForAppLog(client, txid, `deploy ${baseName}`);
  assertVmState(appLog, `deploy ${baseName}`, 'HALT');
  return { txid, hash: normalizeHash(extractDeployedContractHash(appLog) || predictedHash), manifestName: manifest.name };
}

async function authorizeHook(client, coreHash, hookHash, account, networkMagic) {
  return invokePersisted(client, hookHash, account, networkMagic, 'setAuthorizedCore', [
    hash160Param(coreHash),
  ]);
}

async function authorizeVerifier(client, coreHash, verifierHash, account, networkMagic) {
  return invokePersisted(client, verifierHash, account, networkMagic, 'setAuthorizedCore', [
    hash160Param(coreHash),
  ]);
}

async function invokePersisted(client, contractHash, account, networkMagic, operation, params = [], signers = undefined) {
  const contract = new experimental.SmartContract(sanitizeHex(contractHash), buildConfig(account, networkMagic));
  const preview = await withRpcRetry(`${sanitizeHex(contractHash)}.${operation}.preview`, () => contract.testInvoke(operation, params, signers));
  const systemFeeOverride = String(preview?.state || '').includes('FAULT')
    ? u.BigInteger.fromDecimal('1', 8)
    : u.BigInteger.fromDecimal(preview.gasconsumed, 0);
  const txid = await withRpcRetry(
    `${sanitizeHex(contractHash)}.${operation}.invoke`,
    () => new experimental.SmartContract(
      sanitizeHex(contractHash),
      {
        ...buildConfig(account, networkMagic),
        systemFeeOverride,
      }
    ).invoke(operation, params, signers),
  );
  const appLog = await waitForAppLog(client, txid, operation);
  assertVmState(appLog, operation, 'HALT');
  return { txid, appLog };
}

async function invokeRead(client, contractHash, operation, params = [], signers = undefined) {
  return withRpcRetry(`${sanitizeHex(contractHash)}.${operation}`, () => client.invokeFunction(sanitizeHex(contractHash), operation, params, signers));
}

function decodeHash160(item) {
  if (!item) return '';
  if (item.type === 'Hash160') return normalizeHash(item.value);
  if (item.type === 'ByteString') return normalizeHash(u.reverseHex(Buffer.from(item.value || '', 'base64').toString('hex')));
  return '';
}

function decodeInteger(item) {
  if (!item) return '0';
  if (item.type === 'Integer') return String(item.value || '0');
  if (item.type === 'ByteString') return String(BigInt(`0x${Buffer.from(item.value || '', 'base64').toString('hex') || '0'}`));
  return '0';
}

async function invokeMultiPersisted(client, account, networkMagic, calls = [], signers = undefined) {
  const builder = new sc.ScriptBuilder();
  for (const call of calls) {
    builder.emitAppCall(sanitizeHex(call.scriptHash), call.operation, call.args || []);
  }
  const scriptHex = builder.build();
  const transaction = new tx.Transaction();
  transaction.script = u.HexString.fromHex(scriptHex);
  await experimental.txHelpers.setBlockExpiry(transaction, buildConfig(account, networkMagic), 200);
  transaction.signers = signers && signers.length > 0 ? signers : [makeSigner(account.scriptHash)];
  const preview = await withRpcRetry('rpc.invokeScript', () => client.invokeScript(scriptHex, transaction.signers)).catch(() => null);
  if (preview && !String(preview?.state || '').includes('FAULT')) {
    transaction.systemFee = u.BigInteger.fromDecimal(preview.gasconsumed, 0);
  } else {
    transaction.systemFee = u.BigInteger.fromDecimal('1', 8);
  }
  await experimental.txHelpers.addFees(transaction, buildConfig(account, networkMagic));
  transaction.sign(account, networkMagic);
  const txid = await withRpcRetry('rpc.sendRawTransaction', () => client.sendRawTransaction(transaction));
  const appLog = await waitForAppLog(client, txid, 'invokeMulti');
  assertVmState(appLog, 'invokeMulti', 'HALT');
  return { txid, appLog };
}

function randomAccountId() {
  return Buffer.from(ethers.randomBytes(20)).toString('hex');
}

function validationRunId() {
  return (process.env.AA_VALIDATION_RUN_ID || `${Date.now().toString(36)}-${process.pid.toString(36)}-${crypto.randomBytes(3).toString('hex')}`).toLowerCase();
}

async function main() {
  RPC_URL = await resolveTestnetRpcUrl({ env: process.env });
  const seller = new wallet.Account(TEST_WIF);
  const buyer = new wallet.Account();
  const client = new rpc.RPCClient(RPC_URL);
  const version = await withRpcRetry('rpc.getVersion', () => client.getVersion());
  const networkMagic = Number(version.protocol.network);
  const deploymentTag = process.env.AA_VALIDATION_DEPLOY_TAG || `validation-market-escrow-${validationRunId()}`;
  const price = 10000000n;

  console.log(JSON.stringify({
    rpc: RPC_URL,
    networkMagic,
    seller: { address: seller.address, scriptHash: normalizeHash(seller.scriptHash) },
    buyer: { address: buyer.address, scriptHash: normalizeHash(buyer.scriptHash) },
  }, null, 2));

  const core = await deployContract(client, seller, networkMagic, 'UnifiedSmartWalletV3', `${deploymentTag}-core`);
  const market = await deployContract(client, seller, networkMagic, 'AAAddressMarket', `${deploymentTag}-market`);
  const teeVerifier = await deployContract(client, seller, networkMagic, 'TEEVerifier', `${deploymentTag}-tee`);
  const whitelistHook = await deployContract(client, seller, networkMagic, 'WhitelistHook', `${deploymentTag}-whitelist`);
  await authorizeVerifier(client, core.hash, teeVerifier.hash, seller, networkMagic);
  await authorizeHook(client, core.hash, whitelistHook.hash, seller, networkMagic);

  const aaClient = new AbstractAccountClient(RPC_URL, core.hash);
  const accountId = aaClient.deriveRegistrationAccountIdHash({
    verifierContractHash: teeVerifier.hash,
    verifierParamsHex: sanitizeHex(seller.publicKey),
    hookContractHash: whitelistHook.hash,
    backupOwnerAddress: seller.scriptHash,
    escapeTimelock: REGISTRATION_ESCAPE_TIMELOCK,
  });

  await invokePersisted(client, core.hash, seller, networkMagic, 'registerAccount', [
    hash160Param(accountId),
    hash160Param(teeVerifier.hash),
    byteArrayParam(sanitizeHex(seller.publicKey)),
    hash160Param(whitelistHook.hash),
    hash160Param(seller.scriptHash),
    integerParam(REGISTRATION_ESCAPE_TIMELOCK),
  ], [makeSigner(seller.scriptHash)]);

  const hookConfigRequest = await invokePersisted(client, core.hash, seller, networkMagic, 'callHook', [
    hash160Param(accountId),
    stringParam('setWhitelist'),
    sc.ContractParam.array(
      hash160Param(accountId),
      hash160Param(GAS_HASH),
      sc.ContractParam.boolean(true),
    ),
  ], [makeSigner(seller.scriptHash)]);

  const verifierBeforeSale = await invokeRead(client, teeVerifier.hash, 'getPublicKey', [hash160Param(accountId)]);
  const hookStateBeforeSale = await invokeRead(client, whitelistHook.hash, 'isWhitelisted', [hash160Param(accountId), hash160Param(GAS_HASH)]);
  if (!Buffer.from(verifierBeforeSale?.stack?.[0]?.value || '', 'base64').length) {
    throw new Error('verifier state should exist before sale');
  }
  console.log(JSON.stringify({
    hookConfigRequest: hookConfigRequest.txid,
    hookConfigResult: hookConfigRequest.execution?.stack?.[0] || null,
    hookStateBeforeSale: hookStateBeforeSale?.stack?.[0]?.value ?? null,
    note: 'WhitelistHook configuration is timelocked on V3, so the first callHook(setWhitelist) only records a pending maintenance request.',
  }, null, 2));

  await invokePersisted(client, market.hash, seller, networkMagic, 'createListing', [
    hash160Param(core.hash),
    hash160Param(accountId),
    integerParam(price),
    stringParam('testnet escrow smoke'),
    stringParam(''),
  ], [makeCustomContractSigner(seller.scriptHash, [market.hash, core.hash])]);

  const escrowActive = await invokeRead(client, core.hash, 'isMarketEscrowActive', [hash160Param(accountId)]);
  if (escrowActive?.stack?.[0]?.value !== true) {
    throw new Error('escrow should be active after listing');
  }

  const lockedUpdate = await invokeRead(
    client,
    core.hash,
    'updateHook',
    [hash160Param(accountId), hash160Param(ZERO_HASH160)],
    [makeSigner(seller.scriptHash)]
  );
  if (!String(lockedUpdate?.state || '').includes('FAULT')) {
    throw new Error('updateHook should fault while escrow is active');
  }

  await invokePersisted(client, GAS_HASH, seller, networkMagic, 'transfer', [
    hash160Param(seller.scriptHash),
    hash160Param(buyer.scriptHash),
    integerParam(30000000n),
    anyParam(null),
  ], [makeSigner(seller.scriptHash)]);

  await invokeMultiPersisted(client, buyer, networkMagic, [
    {
      scriptHash: GAS_HASH,
      operation: 'transfer',
      args: [
        hash160Param(buyer.scriptHash),
        hash160Param(market.hash),
        integerParam(price),
        integerParam(1),
      ],
    },
    {
      scriptHash: market.hash,
      operation: 'settleListing',
      args: [
        integerParam(1),
        hash160Param(buyer.scriptHash),
        hash160Param(buyer.scriptHash),
      ],
    },
  ], [makeSigner(buyer.scriptHash)]);

  const listing = await invokeRead(client, market.hash, 'getListing', [integerParam(1)]);
  const listingArray = listing?.stack?.[0]?.value || [];
  const status = decodeInteger(listingArray[7]);
  const buyerRecorded = decodeHash160(listingArray[8]);
  const backupOwner = await invokeRead(client, core.hash, 'getBackupOwner', [hash160Param(accountId)]);
  const verifierAfterSale = await invokeRead(client, core.hash, 'getVerifier', [hash160Param(accountId)]);
  const hookAfterSale = await invokeRead(client, core.hash, 'getHook', [hash160Param(accountId)]);
  const escrowAfter = await invokeRead(client, core.hash, 'isMarketEscrowActive', [hash160Param(accountId)]);

  if (status !== '2') {
    throw new Error(`listing should be sold, got status=${status}`);
  }
  if (buyerRecorded !== normalizeHash(buyer.scriptHash)) {
    throw new Error(`listing buyer mismatch: ${buyerRecorded}`);
  }
  if (decodeHash160(backupOwner?.stack?.[0]) !== normalizeHash(buyer.scriptHash)) {
    throw new Error('backup owner did not rotate to buyer');
  }
  if (decodeHash160(verifierAfterSale?.stack?.[0]) !== normalizeHash(ZERO_HASH160)) {
    throw new Error('verifier should be cleared after sale');
  }
  if (decodeHash160(hookAfterSale?.stack?.[0]) !== normalizeHash(ZERO_HASH160)) {
    throw new Error('hook should be cleared after sale');
  }
  if (escrowAfter?.stack?.[0]?.value !== false) {
    throw new Error('escrow should be cleared after settlement');
  }

  console.log(JSON.stringify({
    core,
    market,
    teeVerifier,
    whitelistHook,
    listingId: 1,
    accountId: normalizeHash(accountId),
    buyerRecorded,
    backupOwner: decodeHash160(backupOwner?.stack?.[0]),
    verifierAfterSale: decodeHash160(verifierAfterSale?.stack?.[0]),
    hookAfterSale: decodeHash160(hookAfterSale?.stack?.[0]),
    status,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
