#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpc, sc, wallet, experimental, tx, u, CONST } = require('@cityofzion/neon-js');
const { ethers } = require('ethers');

const { extractDeployedContractHash } = require('../src/deployLog');
const { AbstractAccountClient } = require('../src/index');
const { buildV3UserOperationTypedData, sanitizeHex } = require('../src/metaTx');
const { resolveTestnetRpcUrl } = require('./testnet-rpc');

let RPC_URL = process.env.TESTNET_RPC_URL || '';
const TEST_WIF = process.env.TEST_WIF || '';

if (!TEST_WIF) {
  console.error('TEST_WIF is required.');
  process.exit(1);
}

const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
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
  if (!hex) return '';
  return `0x${hex}`;
}

function buildConfig(account, networkMagic) {
  return {
    account,
    networkMagic,
    rpcAddress: RPC_URL,
    blocksTillExpiry: 200,
  };
}

function stackItemToText(item) {
  if (!item) return '';
  if (item.type === 'Integer') return String(item.value || '0');
  if (item.type === 'Boolean') return String(item.value);
  if (item.type === 'Hash160') return normalizeHash(item.value);
  if (item.type === 'ByteString') {
    const hex = Buffer.from(item.value || '', 'base64').toString('hex');
    if (!hex) return '';
    const utf8 = Buffer.from(hex, 'hex').toString('utf8');
    return /^[\x20-\x7E]+$/.test(utf8) ? utf8 : `0x${hex}`;
  }
  return JSON.stringify(item);
}

async function waitForAppLog(client, txid, label, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const appLog = await client.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch (_) {
      // still waiting for confirmation
    }
    await sleep(3000);
  }
  throw new Error(`${label}: timed out waiting for application log for ${txid}`);
}

function assertHalt(appLog, label) {
  const execution = appLog?.executions?.[0];
  if (!execution) throw new Error(`${label}: missing execution log`);
  const vmState = String(execution.vmstate || execution.state || '');
  if (!vmState.includes('HALT')) {
    throw new Error(`${label}: VM did not HALT (${vmState}) ${execution.exception || ''}`.trim());
  }
  return execution;
}

function makeSigner(scriptHash) {
  return {
    account: scriptHash,
    scopes: tx.WitnessScope.CalledByEntry,
  };
}

function hash160Param(value) {
  return sc.ContractParam.hash160(sanitizeHex(value));
}

function byteArrayParam(hexValue) {
  return sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(hexValue), true));
}

function integerParam(value) {
  if (typeof value === 'bigint') {
    return sc.ContractParam.integer(value.toString());
  }
  return sc.ContractParam.integer(value);
}

function boolParam(value) {
  return sc.ContractParam.boolean(Boolean(value));
}

function stringParam(value) {
  return sc.ContractParam.string(String(value));
}

function arrayParam(values = []) {
  return sc.ContractParam.array(...values);
}

function emptyByteArrayParam() {
  return sc.ContractParam.byteArray(u.HexString.fromHex('', true));
}

function userOpParam({ targetContract, method, args = [], nonce = 0n, deadline = 0n, signatureHex = '' }) {
  return arrayParam([
    hash160Param(targetContract),
    stringParam(method),
    arrayParam(args),
    integerParam(nonce),
    integerParam(deadline),
    byteArrayParam(signatureHex),
  ]);
}

async function deployContract(client, account, networkMagic, baseName, uniqueSuffix) {
  const { nef, manifest } = loadArtifact(baseName, uniqueSuffix);
  const predictedHash = normalizeHash(
    experimental.getContractHash(u.HexString.fromHex(account.scriptHash), nef.checksum, manifest.name)
  );
  const txid = await withRpcRetry(`deploy ${baseName}`, () => experimental.deployContract(nef, manifest, buildConfig(account, networkMagic)));
  const appLog = await waitForAppLog(client, txid, `deploy ${baseName}`);
  assertHalt(appLog, `deploy ${baseName}`);
  const deployedHash = extractDeployedContractHash(appLog) || predictedHash;
  return { txid, hash: normalizeHash(deployedHash), manifestName: manifest.name };
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

async function invokeRead(client, contractHash, operation, params = [], signers = undefined) {
  return withRpcRetry(`${sanitizeHex(contractHash)}.${operation}`, () => client.invokeFunction(sanitizeHex(contractHash), operation, params, signers));
}

async function readAndDecode(client, contractHash, operation, params = [], signers = undefined) {
  const result = await invokeRead(client, contractHash, operation, params, signers);
  const state = String(result?.state || '');
  if (state.includes('FAULT')) {
    throw new Error(`${operation} fault: ${result.exception || 'VM fault'}`);
  }
  return result?.stack?.[0];
}

async function invokePersisted(client, contractHash, account, networkMagic, operation, params = [], signers = undefined) {
  const contract = new experimental.SmartContract(sanitizeHex(contractHash), buildConfig(account, networkMagic));
  const txid = await withRpcRetry(`${sanitizeHex(contractHash)}.${operation}.invoke`, () => contract.invoke(operation, params, signers));
  const appLog = await waitForAppLog(client, txid, `${operation}`);
  const execution = assertHalt(appLog, `${operation}`);
  return { txid, appLog, execution };
}

async function testInvoke(client, contractHash, account, networkMagic, operation, params = [], signers = undefined) {
  const contract = new experimental.SmartContract(sanitizeHex(contractHash), buildConfig(account, networkMagic));
  return withRpcRetry(`${sanitizeHex(contractHash)}.${operation}.testInvoke`, () => contract.testInvoke(operation, params, signers));
}

function compactSignature(signature) {
  const parsed = ethers.Signature.from(signature);
  return `${sanitizeHex(parsed.r)}${sanitizeHex(parsed.s)}`;
}

function randomAccountId() {
  return Buffer.from(ethers.randomBytes(20)).toString('hex');
}

function validationRunId() {
  return (process.env.AA_VALIDATION_RUN_ID || `${Date.now().toString(36)}-${process.pid.toString(36)}-${crypto.randomBytes(3).toString('hex')}`).toLowerCase();
}

function logSection(title) {
  console.log(`\n== ${title} ==`);
}

async function main() {
  RPC_URL = await resolveTestnetRpcUrl({ env: process.env });
  const account = new wallet.Account(TEST_WIF);
  const rpcClient = new rpc.RPCClient(RPC_URL);
  const version = await withRpcRetry('rpc.getVersion', () => rpcClient.getVersion());
  const networkMagic = Number(version.protocol.network);
  const deploymentTag = process.env.AA_VALIDATION_DEPLOY_TAG || `validation-smoke-${validationRunId()}`;

  console.log(JSON.stringify({
    rpc: RPC_URL,
    networkMagic,
    address: account.address,
    scriptHash: normalizeHash(account.scriptHash),
  }, null, 2));

  logSection('Deploy Contracts');
  const core = await deployContract(rpcClient, account, networkMagic, 'UnifiedSmartWalletV3', `${deploymentTag}-core`);
  const web3Auth = await deployContract(rpcClient, account, networkMagic, 'Web3AuthVerifier', `${deploymentTag}-web3auth`);
  const whitelist = await deployContract(rpcClient, account, networkMagic, 'WhitelistHook', `${deploymentTag}-whitelist`);
  await authorizeVerifier(rpcClient, core.hash, web3Auth.hash, account, networkMagic);
  await authorizeHook(rpcClient, core.hash, whitelist.hash, account, networkMagic);
  console.log(JSON.stringify({ core, web3Auth, whitelist }, null, 2));

  const aaClient = new AbstractAccountClient(RPC_URL, core.hash);
  const accountId = aaClient.deriveRegistrationAccountIdHash({
    backupOwnerAddress: account.scriptHash,
    escapeTimelock: REGISTRATION_ESCAPE_TIMELOCK,
  });
  const virtual = aaClient.deriveVirtualAccount(accountId);

  logSection('Register Native-Fallback Account');
  const registerNative = await invokePersisted(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'registerAccount',
    [
      hash160Param(accountId),
      hash160Param('0'.repeat(40)),
      emptyByteArrayParam(),
      hash160Param('0'.repeat(40)),
      hash160Param(account.scriptHash),
      integerParam(REGISTRATION_ESCAPE_TIMELOCK),
    ],
  );
  console.log(JSON.stringify({ registerNative: registerNative.txid, accountId: normalizeHash(accountId), virtualAddress: virtual.address }, null, 2));

  const nativeState = await aaClient.getAccountState(accountId);
  console.log(JSON.stringify({ nativeState }, null, 2));

  logSection('Native ExecuteUserOp');
  const nativeOp = userOpParam({
    targetContract: GAS_HASH,
    method: 'symbol',
    args: [],
    nonce: 0n,
    deadline: BigInt(Date.now() + (60 * 60 * 1000)),
    signatureHex: '',
  });
  const nativeExec = await invokePersisted(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'executeUserOp',
    [hash160Param(accountId), nativeOp],
  );
  console.log(JSON.stringify({
    nativeExec: nativeExec.txid,
    result: stackItemToText(nativeExec.execution.stack?.[0]),
  }, null, 2));

  logSection('Hook Gating');
  const hookConfigRequest = await invokePersisted(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'updateHook',
    [hash160Param(accountId), hash160Param(sanitizeHex(whitelist.hash))],
  );

  const deniedSim = await testInvoke(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'executeUserOp',
    [hash160Param(accountId), userOpParam({
      targetContract: GAS_HASH,
      method: 'symbol',
      args: [],
      nonce: 1n,
      deadline: BigInt(Date.now() + (60 * 60 * 1000)),
      signatureHex: '',
    })],
    [makeSigner(account.scriptHash)],
  );
  console.log(JSON.stringify({
    hookDeniedState: deniedSim.state,
    hookDeniedException: deniedSim.exception || '',
  }, null, 2));

  await invokePersisted(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'callHook',
    [
      hash160Param(accountId),
      stringParam('setWhitelist'),
      arrayParam([
        hash160Param(accountId),
        hash160Param(GAS_HASH),
        boolParam(true),
      ]),
    ],
  );
  console.log(JSON.stringify({
    hookConfigRequest: hookConfigRequest.txid,
    result: stackItemToText(hookConfigRequest.execution.stack?.[0]),
    note: 'callHook(setWhitelist) is timelocked on V3 and first emits a pending maintenance request rather than applying immediately.',
  }, null, 2));

  logSection('Escape Flow');
  await invokePersisted(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'initiateEscape',
    [hash160Param(accountId)],
  );
  const escapeActive = await readAndDecode(rpcClient, core.hash, 'isEscapeActive', [hash160Param(accountId)]);
  console.log(JSON.stringify({ escapeActive: stackItemToText(escapeActive) }, null, 2));
  const finalizeEscapePreview = await testInvoke(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'finalizeEscape',
    [hash160Param(accountId), hash160Param('0'.repeat(40))],
  );
  console.log(JSON.stringify({
    finalizeEscapeState: finalizeEscapePreview.state,
    finalizeEscapeException: finalizeEscapePreview.exception || '',
  }, null, 2));

  logSection('Web3Auth Verifier Registration');
  const evmSigner1 = ethers.Wallet.createRandom();
  const evmSigner2 = ethers.Wallet.createRandom();
  const pubKey1 = sanitizeHex(evmSigner1.signingKey.publicKey);
  const pubKey2 = sanitizeHex(evmSigner2.signingKey.publicKey);
  const web3AuthAccountId = aaClient.deriveRegistrationAccountIdHash({
    verifierContractHash: web3Auth.hash,
    verifierParamsHex: pubKey1,
    backupOwnerAddress: account.scriptHash,
    escapeTimelock: REGISTRATION_ESCAPE_TIMELOCK,
  });
  const web3AuthVirtual = aaClient.deriveVirtualAccount(web3AuthAccountId);

  const verifierConfigRequest = await invokePersisted(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'registerAccount',
    [
      hash160Param(web3AuthAccountId),
      hash160Param(sanitizeHex(web3Auth.hash)),
      byteArrayParam(pubKey1),
      hash160Param('0'.repeat(40)),
      hash160Param(account.scriptHash),
      integerParam(REGISTRATION_ESCAPE_TIMELOCK),
    ],
  );

  const storedVerifier = await readAndDecode(rpcClient, core.hash, 'getVerifier', [hash160Param(web3AuthAccountId)]);
  const storedPubKey = await readAndDecode(rpcClient, web3Auth.hash, 'getPublicKey', [hash160Param(web3AuthAccountId)]);
  const verifierConfigPreview = await testInvoke(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'callVerifier',
    [
      hash160Param(web3AuthAccountId),
      stringParam('setPublicKey'),
      arrayParam([
        hash160Param(web3AuthAccountId),
        byteArrayParam(pubKey2),
      ]),
    ],
  );
  console.log(JSON.stringify({
    web3AuthAccountId: normalizeHash(web3AuthAccountId),
    web3AuthVirtualAddress: web3AuthVirtual.address,
    storedVerifier: stackItemToText(storedVerifier),
    storedPubKeyBytes: stackItemToText(storedPubKey).slice(0, 18),
    verifierConfigRequest: verifierConfigRequest.txid,
    verifierConfigResult: stackItemToText(verifierConfigRequest.execution.stack?.[0]),
    verifierConfigState: verifierConfigPreview.state,
    verifierConfigException: verifierConfigPreview.exception || '',
  }, null, 2));

  logSection('Web3Auth ExecuteUserOp');
  const nonceStack = await readAndDecode(rpcClient, core.hash, 'getNonce', [hash160Param(web3AuthAccountId), integerParam(0)]);
  const nonce = BigInt(nonceStack.value || '0');
  const argsHashStack = await readAndDecode(rpcClient, core.hash, 'computeArgsHash', [arrayParam([])]);
  const argsHash = Buffer.from(argsHashStack.value || '', 'base64').toString('hex');
  const deadline = Date.now() + (60 * 60 * 1000);
  const typedData = buildV3UserOperationTypedData({
    chainId: networkMagic,
    verifyingContract: sanitizeHex(web3Auth.hash),
    accountIdHash: web3AuthAccountId,
    coreContractHash: sanitizeHex(core.hash),
    targetContract: GAS_HASH,
    method: 'symbol',
    argsHashHex: argsHash,
    nonce,
    deadline,
  });
  const signature = await evmSigner1.signTypedData(typedData.domain, typedData.types, typedData.message);
  const compact = compactSignature(signature);

  const evmExec = await invokePersisted(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    'executeUserOp',
    [hash160Param(web3AuthAccountId), userOpParam({
      targetContract: GAS_HASH,
      method: 'symbol',
      args: [],
      nonce,
      deadline: BigInt(deadline),
      signatureHex: compact,
    })],
  );

  const finalNonceStack = await readAndDecode(rpcClient, core.hash, 'getNonce', [hash160Param(web3AuthAccountId), integerParam(0)]);
  console.log(JSON.stringify({
    evmExec: evmExec.txid,
    result: stackItemToText(evmExec.execution.stack?.[0]),
    nonceBefore: nonce.toString(),
    nonceAfter: stackItemToText(finalNonceStack),
  }, null, 2));

  logSection('Summary');
  console.log(JSON.stringify({
    address: account.address,
    coreHash: core.hash,
    web3AuthHash: web3Auth.hash,
    whitelistHash: whitelist.hash,
    nativeAccountId: normalizeHash(accountId),
    nativeVirtualAddress: virtual.address,
    web3AuthAccountId: normalizeHash(web3AuthAccountId),
    web3AuthVirtualAddress: web3AuthVirtual.address,
    txids: {
      registerAccount: registerNative.txid,
      nativeExecute: nativeExec.txid,
      hookConfigRequest: hookConfigRequest.txid,
      verifierConfigRequest: verifierConfigRequest.txid,
      evmExecute: evmExec.txid,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
