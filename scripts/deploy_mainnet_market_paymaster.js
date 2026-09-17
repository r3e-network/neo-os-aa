#!/usr/bin/env node

/**
 * Deploy and smoke-test the production AAAddressMarket/AAPaymaster contracts on
 * Neo N3 mainnet.
 *
 * This script is intentionally mainnet-only and refuses to broadcast unless
 * CONFIRM_MAINNET_AA_DEPLOY=1 is set. It never prints private key material.
 *
 * Shared deploy plumbing lives in scripts/lib/deploy-helpers.js; its
 * invokePersisted helper aborts with "<operation> preview FAULT" before
 * broadcasting whenever the testInvoke preview FAULTs.
 */

const fs = require('fs');
const path = require('path');

const {
  neon,
  requireWorkspacePackage,
  sanitizeHex,
  extractDeployedContractHash,
  withRpcRetry,
  loadArtifact,
  normalizeHash,
  stackHash160,
  buildConfig,
  predictContractHash,
  hash160Param,
  integerParam,
  stringParam,
  byteArrayParam,
  arrayParam,
  makeSigner,
  waitForAppLog,
  assertVmState,
  invokePersisted,
} = require('./lib/deploy-helpers');

const { rpc, sc, wallet, experimental, CONST } = neon;
const { ethers } = requireWorkspacePackage('ethers');

const { AbstractAccountClient } = require('../sdk/js/src/index');
const { buildV3UserOperationTypedData } = require('../sdk/js/src/metaTx');

const MAINNET_MAGIC = 860833102;
const DEFAULT_RPC_URL = 'https://api.n3index.dev/mainnet';
const DEFAULT_CORE_HASH = '0x0268a387913b250166ddec032b03332690a1ef78';
const DEFAULT_WEB3AUTH_VERIFIER_HASH = '0xf5c452cd4ba29dcdc47026383568c0d8b38d9272';
const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const ZERO_HASH160 = '0000000000000000000000000000000000000000';
const ESCAPE_TIMELOCK = 7 * 24 * 60 * 60;
const RESULTS_FILE = path.resolve(__dirname, '..', 'mainnet-aa-deployment-results.json');

const args = new Set(process.argv.slice(2));
const planOnly = args.has('--plan');
const deployCore = args.has('--deploy-core') || args.has('--deploy-all');
const deployMarket = args.has('--deploy-market') || args.has('--deploy-all');
const deployPaymaster = args.has('--deploy-paymaster') || args.has('--deploy-all');
const smokePaymaster = args.has('--smoke-paymaster');
const deployModules = [
  ...(process.env.AA_MAINNET_DEPLOY_MODULES || '').split(/[,\s]+/),
  args.has('--deploy-web3auth') ? 'Web3AuthVerifier' : '',
  args.has('--deploy-session-key') ? 'SessionKeyVerifier' : '',
].map((item) => item.trim()).filter(Boolean);

function loadEnvFile(filePath) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`AA_ENV_FILE not found: ${resolved}`);
  const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function requireBroadcastConfirmation() {
  if (planOnly) return;
  if (process.env.CONFIRM_MAINNET_AA_DEPLOY !== '1') {
    throw new Error('Refusing to broadcast without CONFIRM_MAINNET_AA_DEPLOY=1');
  }
}

function resolveWif() {
  if (process.env.AA_MAINNET_DEPLOY_WIF) return process.env.AA_MAINNET_DEPLOY_WIF;
  if (process.env.NEO_MAINNET_WIF) return process.env.NEO_MAINNET_WIF;
  if (process.env.MARKET_DEPLOY_WIF) return process.env.MARKET_DEPLOY_WIF;
  if (process.env.ALLOW_RELAY_WIF_FOR_MAINNET_DEPLOY === '1' && process.env.AA_RELAY_WIF) {
    return process.env.AA_RELAY_WIF;
  }
  return '';
}

function userOpParam({ targetContract, method, args = [], nonce = 0n, deadline = 0n, signatureHex = '' }) {
  return arrayParam(
    hash160Param(targetContract),
    stringParam(method),
    arrayParam(...args),
    integerParam(nonce),
    integerParam(deadline),
    byteArrayParam(signatureHex),
  );
}

function compactSignature(signature) {
  const parsed = ethers.Signature.from(signature);
  return `${sanitizeHex(parsed.r)}${sanitizeHex(parsed.s)}`;
}

async function contractExists(client, hash) {
  try {
    await withRpcRetry(`getContractState ${hash}`, () => client.getContractState(sanitizeHex(hash)));
    return true;
  } catch (error) {
    if (/unknown contract|contract not found/i.test(String(error?.message || error))) {
      return false;
    }
    // Anything else (HTTP failures, parse errors, exhausted retries) is an
    // RPC failure, not evidence the contract is missing — surface it so the
    // operator sees the real root cause instead of a wrong deployment state.
    throw error;
  }
}

async function deployContract(client, account, networkMagic, rpcUrl, baseName) {
  const suffix = String(process.env.AA_DEPLOY_SUFFIX || '').trim();
  const { nef, manifest, manifestName } = loadArtifact(baseName, suffix);
  const predictedHash = predictContractHash(account, nef.checksum, manifestName);
  const alreadyDeployed = await contractExists(client, predictedHash);
  if (planOnly || alreadyDeployed) {
    return {
      baseName,
      manifestName,
      hash: predictedHash,
      txid: null,
      status: alreadyDeployed ? 'already_deployed' : 'planned',
    };
  }

  console.log(`Deploying ${baseName}: predicted=${predictedHash}`);
  let txid;
  try {
    txid = await withRpcRetry(`deploy ${baseName}`, () =>
      experimental.deployContract(nef, manifest, buildConfig(account, networkMagic, rpcUrl)));
  } catch (error) {
    const match = String(error?.message || error).match(/Contract Already Exists:\s*(0x[0-9a-f]{40})/i);
    if (match) {
      const existingHash = normalizeHash(match[1]);
      console.log(`  ${baseName} already exists=${existingHash}`);
      return { baseName, manifestName, hash: existingHash, txid: null, status: 'already_deployed' };
    }
    throw error;
  }
  console.log(`  ${baseName} tx=${txid}`);
  const appLog = await waitForAppLog(client, txid, `deploy ${baseName}`);
  assertVmState(appLog, `deploy ${baseName}`, 'HALT');
  const deployedHash = normalizeHash(extractDeployedContractHash(appLog) || predictedHash);
  console.log(`  ${baseName} deployed=${deployedHash}`);
  return { baseName, manifestName, hash: deployedHash, txid, status: 'deployed' };
}

async function invokeRead(client, contractHash, operation, params = [], signers) {
  return withRpcRetry(`${operation}.read`, () =>
    client.invokeFunction(sanitizeHex(contractHash), operation, params, signers));
}

function stackBoolean(item) {
  return item?.value === true || item?.value === 1 || item?.value === '1' || item?.value === 'true';
}

async function readGasBalance(rpcUrl, address) {
  const payload = await withRpcRetry(`getnep17balances ${address}`, async () => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getnep17balances', params: [address] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`getnep17balances returned HTTP ${response.status}`);
    }
    return response.json();
  });
  const rows = payload?.result?.balance || [];
  const gas = rows.find((item) => sanitizeHex(item.assethash) === sanitizeHex(GAS_HASH));
  return gas?.amount || '0';
}

function writeResults(results) {
  const previous = fs.existsSync(RESULTS_FILE)
    ? JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'))
    : {};
  fs.writeFileSync(RESULTS_FILE, `${JSON.stringify({ ...previous, ...results }, null, 2)}\n`);
}

async function runPaymasterSmoke({ client, account, networkMagic, rpcUrl, coreHash, verifierHash, paymasterHash }) {
  if (planOnly) return null;
  const invokeCtx = { client, account, networkMagic, rpcUrl };
  const aaClient = new AbstractAccountClient(rpcUrl, coreHash);
  const evmWallet = ethers.Wallet.createRandom();
  const verifierParamsHex = evmWallet.signingKey.publicKey.slice(2);
  const accountId = aaClient.deriveRegistrationAccountIdHash({
    verifierContractHash: verifierHash,
    verifierParamsHex,
    backupOwnerAddress: account.scriptHash,
    escapeTimelock: ESCAPE_TIMELOCK,
  });

  const register = await invokePersisted({
    ...invokeCtx,
    contractHash: coreHash,
    operation: 'registerAccount',
    params: [
      hash160Param(accountId),
      hash160Param(verifierHash),
      byteArrayParam(verifierParamsHex),
      hash160Param(ZERO_HASH160),
      hash160Param(account.scriptHash),
      integerParam(ESCAPE_TIMELOCK),
    ],
  });

  const depositAmount = BigInt(process.env.AA_MAINNET_PAYMASTER_SMOKE_DEPOSIT || '2000000');
  const reimbursement = BigInt(process.env.AA_MAINNET_PAYMASTER_SMOKE_REIMBURSEMENT || '100000');
  const deposit = await invokePersisted({
    ...invokeCtx,
    contractHash: GAS_HASH,
    operation: 'transfer',
    params: [
      hash160Param(account.scriptHash),
      hash160Param(paymasterHash),
      integerParam(depositAmount),
      sc.ContractParam.any(),
    ],
  });

  const policy = await invokePersisted({
    ...invokeCtx,
    contractHash: paymasterHash,
    operation: 'setPolicy',
    params: [
      hash160Param(accountId),
      hash160Param(GAS_HASH),
      stringParam('symbol'),
      integerParam(500000n),
      integerParam(depositAmount),
      integerParam(depositAmount),
      integerParam(0),
    ],
  });

  const valid = await invokeRead(client, paymasterHash, 'validatePaymasterOp', [
    hash160Param(account.scriptHash),
    hash160Param(accountId),
    hash160Param(GAS_HASH),
    stringParam('symbol'),
    integerParam(reimbursement),
  ]);
  if (!stackBoolean(valid?.stack?.[0])) throw new Error('Paymaster policy preflight returned false');

  const nonceResult = await invokeRead(client, coreHash, 'getNonce', [hash160Param(accountId), integerParam(0)]);
  const nonce = BigInt(nonceResult?.stack?.[0]?.value || '0');
  const argsHash = await aaClient.computeArgsHash([]);
  const deadline = BigInt(Date.now() + 60 * 60 * 1000);
  const typedData = buildV3UserOperationTypedData({
    chainId: networkMagic,
    verifyingContract: sanitizeHex(verifierHash),
    accountIdHash: accountId,
    coreContractHash: sanitizeHex(coreHash),
    targetContract: sanitizeHex(GAS_HASH),
    method: 'symbol',
    argsHashHex: argsHash,
    nonce,
    deadline,
  });
  const signature = compactSignature(await evmWallet.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const op = userOpParam({
    targetContract: GAS_HASH,
    method: 'symbol',
    args: [],
    nonce,
    deadline,
    signatureHex: signature,
  });

  const sponsored = await invokePersisted({
    ...invokeCtx,
    contractHash: coreHash,
    operation: 'executeSponsoredUserOp',
    params: [
      hash160Param(accountId),
      op,
      hash160Param(paymasterHash),
      hash160Param(account.scriptHash),
      integerParam(reimbursement),
    ],
  });

  return {
    accountId: normalizeHash(accountId),
    registerTx: register.txid,
    depositTx: deposit.txid,
    policyTx: policy.txid,
    sponsoredTx: sponsored.txid,
    depositAmount: depositAmount.toString(),
    reimbursementAmount: reimbursement.toString(),
  };
}

async function main() {
  loadEnvFile(process.env.AA_ENV_FILE);
  requireBroadcastConfirmation();

  if (!planOnly && !deployCore && !deployMarket && !deployPaymaster && deployModules.length === 0 && !smokePaymaster) {
    throw new Error('Nothing to do. Use --plan, --deploy-core, --deploy-market, --deploy-paymaster, --deploy-web3auth, --deploy-session-key, --deploy-all, or --smoke-paymaster.');
  }

  const wif = resolveWif();
  if (!wif) {
    throw new Error('AA_MAINNET_DEPLOY_WIF, NEO_MAINNET_WIF, or MARKET_DEPLOY_WIF is required. Set ALLOW_RELAY_WIF_FOR_MAINNET_DEPLOY=1 to explicitly reuse AA_RELAY_WIF.');
  }

  const rpcUrl = process.env.NEO_MAINNET_RPC_URL || process.env.MAINNET_RPC_URL || DEFAULT_RPC_URL;
  const coreHash = normalizeHash(process.env.AA_MAINNET_CORE_HASH || DEFAULT_CORE_HASH);
  const verifierHash = normalizeHash(process.env.AA_MAINNET_WEB3AUTH_VERIFIER_HASH || DEFAULT_WEB3AUTH_VERIFIER_HASH);
  const account = new wallet.Account(wif);
  const client = new rpc.RPCClient(rpcUrl);
  const version = await withRpcRetry('getVersion', () => client.getVersion());
  const networkMagic = Number(version.protocol.network);
  if (networkMagic !== MAINNET_MAGIC) {
    throw new Error(`RPC network magic mismatch: expected ${MAINNET_MAGIC}, got ${networkMagic}`);
  }
  if (!deployCore && !(await contractExists(client, coreHash))) throw new Error(`AA core not deployed: ${coreHash}`);
  if (!(await contractExists(client, verifierHash))) throw new Error(`Web3Auth verifier not deployed: ${verifierHash}`);

  const invokeCtx = { client, account, networkMagic, rpcUrl };

  const plan = {
    network: 'mainnet',
    networkMagic,
    rpcUrl,
    deployer: {
      address: account.address,
      scriptHash: normalizeHash(account.scriptHash),
      gasBalance: await readGasBalance(rpcUrl, account.address),
    },
    configuredCore: coreHash,
    web3AuthVerifier: verifierHash,
    timestamp: new Date().toISOString(),
    planOnly,
  };

  const core = (deployCore || planOnly)
    ? await deployContract(client, account, networkMagic, rpcUrl, 'UnifiedSmartWalletV3')
    : { baseName: 'UnifiedSmartWalletV3', manifestName: 'UnifiedSmartWalletV3', hash: coreHash, txid: null, status: 'configured' };
  const activeCoreHash = core.hash;

  const modules = {};
  for (const moduleName of deployModules) {
    modules[moduleName] = await deployContract(client, account, networkMagic, rpcUrl, moduleName);
  }
  const activeVerifierHash = modules.Web3AuthVerifier?.hash || verifierHash;

  const market = (deployMarket || planOnly)
    ? await deployContract(client, account, networkMagic, rpcUrl, 'AAAddressMarket')
    : process.env.AA_MAINNET_MARKET_HASH
      ? { baseName: 'AAAddressMarket', manifestName: 'AAAddressMarket', hash: normalizeHash(process.env.AA_MAINNET_MARKET_HASH), txid: null, status: 'provided' }
      : null;
  const paymaster = (deployPaymaster || planOnly)
    ? await deployContract(client, account, networkMagic, rpcUrl, 'AAPaymaster')
    : process.env.AA_MAINNET_PAYMASTER_HASH
      ? { hash: normalizeHash(process.env.AA_MAINNET_PAYMASTER_HASH), status: 'provided' }
      : null;

  const transactions = {};
  for (const [moduleName, moduleDeployment] of Object.entries(modules)) {
    if (planOnly) continue;
    const state = await client.getContractState(sanitizeHex(moduleDeployment.hash));
    const methods = state?.manifest?.abi?.methods?.map((method) => method.name) || [];
    if (!methods.includes('setAuthorizedCore')) continue;
    const authorizedCore = await invokeRead(client, moduleDeployment.hash, 'authorizedCore');
    const currentCore = stackHash160(authorizedCore?.stack?.[0]);
    if (currentCore !== activeCoreHash) {
      console.log(`Binding ${moduleName} ${moduleDeployment.hash} to AA core ${activeCoreHash}`);
      const bind = await invokePersisted({
        ...invokeCtx,
        contractHash: moduleDeployment.hash,
        operation: 'setAuthorizedCore',
        params: [hash160Param(activeCoreHash)],
      });
      transactions[`set${moduleName}AuthorizedCoreTx`] = bind.txid;
    }
  }

  if (paymaster && !planOnly) {
    const authorizedCore = await invokeRead(client, paymaster.hash, 'authorizedCore');
    const currentCore = stackHash160(authorizedCore?.stack?.[0]);
    if (currentCore !== activeCoreHash) {
      console.log(`Binding Paymaster ${paymaster.hash} to AA core ${activeCoreHash}`);
      const bind = await invokePersisted({
        ...invokeCtx,
        contractHash: paymaster.hash,
        operation: 'setAuthorizedCore',
        params: [hash160Param(activeCoreHash)],
      });
      transactions.setAuthorizedCoreTx = bind.txid;
    }
  }

  const partialResults = {
    network: 'mainnet',
    networkMagic,
    configuredCore: coreHash,
    core,
    web3AuthVerifier: activeVerifierHash,
    modules,
    market,
    paymaster,
    transactions,
    smoke: null,
    deployer: plan.deployer,
    updatedAt: plan.timestamp,
  };
  if (!planOnly) writeResults(partialResults);

  let smoke = null;
  if (smokePaymaster) {
    if (!paymaster?.hash) throw new Error('Paymaster hash required for --smoke-paymaster');
    console.log(`Running Paymaster smoke against core=${activeCoreHash}, paymaster=${paymaster.hash}`);
    smoke = await runPaymasterSmoke({
      client,
      account,
      networkMagic,
      rpcUrl,
      coreHash: activeCoreHash,
      verifierHash: activeVerifierHash,
      paymasterHash: paymaster.hash,
    });
  }

  const results = {
    network: 'mainnet',
    networkMagic,
    configuredCore: coreHash,
    core,
    web3AuthVerifier: activeVerifierHash,
    modules,
    market,
    paymaster,
    transactions,
    smoke,
    deployer: plan.deployer,
    updatedAt: plan.timestamp,
  };
  if (!planOnly) writeResults(results);

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
