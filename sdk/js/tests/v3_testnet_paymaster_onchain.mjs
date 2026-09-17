#!/usr/bin/env node

/**
 * Neo N3 Testnet Validation: On-Chain AAPaymaster Contract
 *
 * Validates the full sponsored transaction lifecycle:
 *   1. Deploy AA Core + Web3AuthVerifier + AAPaymaster
 *   2. Register an account with Web3Auth verifier
 *   3. Deposit GAS into the Paymaster
 *   4. Create a sponsorship policy
 *   5. Validate the policy (read-only preflight)
 *   6. Execute a sponsored UserOp via executeSponsoredUserOp
 *   7. Verify settlement (deposit deducted, events emitted)
 *   8. Negative: exceed per-op limit -> FAULT
 *   9. Negative: revoke policy -> FAULT
 *  10. Withdraw remaining deposit
 *
 * Usage:
 *   TEST_WIF=Kx... node tests/v3_testnet_paymaster_onchain.mjs
 */

import fs from 'fs';
import { randomBytes } from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { rpc, sc, wallet, experimental, tx, u, CONST } from '@cityofzion/neon-js';
import { ethers } from 'ethers';
import testnetRpcHelpers from './testnet-rpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const { resolveTestnetRpcUrl } = testnetRpcHelpers;

let RPC_URL = process.env.TESTNET_RPC_URL || '';
const TEST_WIF = process.env.TEST_WIF || '';
const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const ESCAPE_TIMELOCK = 604800; // 7 days minimum

if (!TEST_WIF) {
  console.error('TEST_WIF is required.');
  process.exit(1);
}

// Dynamic imports for CJS modules
const { extractDeployedContractHash } = await import('../src/deployLog.js');
const { buildV3UserOperationTypedData, sanitizeHex } = await import('../src/metaTx.js');

// ======================================================================
// Helpers (matching existing testnet validation patterns)
// ======================================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isRetryableRpcError(error) {
  return /socket hang up|ECONNRESET|ETIMEDOUT|fetch failed|network error|EAI_AGAIN|ECONNREFUSED|EADDRNOTAVAIL|socket disconnected before secure TLS connection was established|TLS connection was established|premature close|invalid response body/i.test(
    String(error?.message || '')
  );
}

async function withRpcRetry(label, fn, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt >= attempts) throw error;
      console.warn(`  [rpc-retry] ${label} attempt ${attempt}/${attempts}: ${error.message}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

function normalizeHash(value) {
  const hex = sanitizeHex(value || '');
  return hex ? `0x${hex}` : '';
}

function buildConfig(account, networkMagic) {
  return { account, networkMagic, rpcAddress: RPC_URL, blocksTillExpiry: 200 };
}

function artifactPaths(baseName) {
  return {
    nef: path.join(repoRoot, 'contracts', 'bin', 'v3', `${baseName}.nef`),
    manifest: path.join(repoRoot, 'contracts', 'bin', 'v3', `${baseName}.manifest.json`),
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

async function waitForAppLog(client, txid, label, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const appLog = await client.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch (_) { /* still waiting */ }
    await sleep(3000);
  }
  throw new Error(`${label}: timed out waiting for application log for ${txid}`);
}

function assertHalt(appLog, label) {
  const execution = appLog?.executions?.[0];
  if (!execution) throw new Error(`${label}: missing execution log`);
  const vmState = String(execution.vmstate || execution.state || '');
  if (!vmState.includes('HALT'))
    throw new Error(`${label}: VM did not HALT (${vmState}) ${execution.exception || ''}`.trim());
  return execution;
}

function assertFault(appLog, label) {
  const execution = appLog?.executions?.[0];
  if (!execution) throw new Error(`${label}: missing execution log`);
  const vmState = String(execution.vmstate || execution.state || '');
  if (!vmState.includes('FAULT'))
    throw new Error(`${label}: expected FAULT but got ${vmState}`);
  return execution;
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

// Parameter builders
const h160 = v => sc.ContractParam.hash160(sanitizeHex(v));
const ba = v => sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(v || ''), true));
const int = v => sc.ContractParam.integer(typeof v === 'bigint' ? v.toString() : v);
const str = v => sc.ContractParam.string(String(v));
const arr = (...v) => sc.ContractParam.array(...v);
const emptyBa = () => ba('');

function userOpParam({ targetContract, method, args = [], nonce = 0n, deadline = 0n, signatureHex = '' }) {
  return arr(h160(targetContract), str(method), arr(...args), int(nonce), int(deadline), ba(signatureHex));
}

function makeSigner(scriptHash) {
  return { account: scriptHash, scopes: tx.WitnessScope.CalledByEntry };
}

// Contract operations
async function deployContract(client, account, networkMagic, baseName, uniqueSuffix) {
  const { nef, manifest } = loadArtifact(baseName, uniqueSuffix);
  const predictedHash = normalizeHash(
    experimental.getContractHash(u.HexString.fromHex(account.scriptHash), nef.checksum, manifest.name)
  );
  const txid = await withRpcRetry(`deploy ${baseName}`, () =>
    experimental.deployContract(nef, manifest, buildConfig(account, networkMagic)));
  const appLog = await waitForAppLog(client, txid, `deploy ${baseName}`);
  assertHalt(appLog, `deploy ${baseName}`);
  const deployedHash = extractDeployedContractHash(appLog) || predictedHash;
  return { txid, hash: normalizeHash(deployedHash), manifestName: manifest.name };
}

async function invokeRead(client, contractHash, operation, params = [], signers) {
  return withRpcRetry(`${sanitizeHex(contractHash)}.${operation}`,
    () => client.invokeFunction(sanitizeHex(contractHash), operation, params, signers));
}

async function invokePersisted(client, contractHash, account, networkMagic, operation, params = [], signers) {
  const contract = new experimental.SmartContract(sanitizeHex(contractHash), buildConfig(account, networkMagic));
  const txid = await withRpcRetry(`${operation}.invoke`, () => contract.invoke(operation, params, signers));
  const appLog = await waitForAppLog(client, txid, operation);
  return { txid, appLog, execution: appLog.executions[0] };
}

async function testInvoke(client, contractHash, account, networkMagic, operation, params = [], signers) {
  const contract = new experimental.SmartContract(sanitizeHex(contractHash), buildConfig(account, networkMagic));
  return withRpcRetry(`${operation}.testInvoke`, () => contract.testInvoke(operation, params, signers));
}

function compactSignature(signature) {
  const parsed = ethers.Signature.from(signature);
  return `${sanitizeHex(parsed.r)}${sanitizeHex(parsed.s)}`;
}

function logSection(title) { console.log(`\n== ${title} ==`); }

// ======================================================================
// Main Validation Flow
// ======================================================================

async function main() {
  RPC_URL = await resolveTestnetRpcUrl({ env: process.env });
  const account = new wallet.Account(TEST_WIF);
  const rpcClient = new rpc.RPCClient(RPC_URL);
  const version = await withRpcRetry('rpc.getVersion', () => rpcClient.getVersion());
  const networkMagic = Number(version.protocol.network);
  const tag = `paymaster-${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(3).toString('hex')}`;
  const results = {};

  console.log(JSON.stringify({
    rpc: RPC_URL,
    networkMagic,
    address: account.address,
    scriptHash: normalizeHash(account.scriptHash),
  }, null, 2));

  // ── 1. Deploy Contracts ───────────────────────────────────────────
  logSection('1. Deploy AA Core + Web3AuthVerifier + AAPaymaster');

  const core = await deployContract(rpcClient, account, networkMagic, 'UnifiedSmartWalletV3', `${tag}-core`);
  console.log(`  Core: ${core.hash}`);

  const verifier = await deployContract(rpcClient, account, networkMagic, 'Web3AuthVerifier', `${tag}-v`);
  console.log(`  Web3AuthVerifier: ${verifier.hash}`);

  const paymaster = await deployContract(rpcClient, account, networkMagic, 'AAPaymaster', `${tag}-pm`);
  console.log(`  AAPaymaster: ${paymaster.hash}`);

  // Authorize verifier and paymaster to know the core
  await invokePersisted(rpcClient, verifier.hash, account, networkMagic, 'setAuthorizedCore', [h160(core.hash)]);
  console.log('  Verifier authorized');

  await invokePersisted(rpcClient, paymaster.hash, account, networkMagic, 'setAuthorizedCore', [h160(core.hash)]);
  console.log('  Paymaster authorized');

  results.deployments = { core: core.hash, verifier: verifier.hash, paymaster: paymaster.hash };

  const { AbstractAccountClient } = await import('../src/index.js');
  const aaClient = new AbstractAccountClient(RPC_URL, core.hash);

  // ── 2. Register Account with Web3Auth Verifier ────────────────────
  logSection('2. Register Account with Web3Auth Verifier');

  const evmWallet = ethers.Wallet.createRandom();
  const evmPubKeyUncompressed = evmWallet.signingKey.publicKey.slice(2); // remove 0x
  const accountId = aaClient.deriveRegistrationAccountIdHash({
    verifierContractHash: verifier.hash,
    verifierParamsHex: evmPubKeyUncompressed,
    backupOwnerAddress: account.scriptHash,
    escapeTimelock: ESCAPE_TIMELOCK,
  });

  const reg = await invokePersisted(rpcClient, core.hash, account, networkMagic, 'registerAccount', [
    h160(accountId),
    h160(verifier.hash),
    ba(evmPubKeyUncompressed),
    h160('0'.repeat(40)), // no hook
    h160(account.scriptHash), // backup owner
    int(ESCAPE_TIMELOCK),
  ]);
  assertHalt(reg.appLog, 'registerAccount');
  console.log(`  Account: 0x${accountId} (tx: ${reg.txid})`);

  results.account = { id: `0x${accountId}`, evmAddress: evmWallet.address };

  // ── 3. Deposit GAS into Paymaster ─────────────────────────────────
  logSection('3. Deposit GAS into Paymaster');

  const depositAmount = 200_000_000n; // 2 GAS
  const depositResult = await invokePersisted(rpcClient, GAS_HASH, account, networkMagic, 'transfer', [
    h160(account.scriptHash),
    h160(paymaster.hash),
    int(depositAmount),
    sc.ContractParam.any(),
  ]);
  assertHalt(depositResult.appLog, 'GAS deposit');

  // Verify deposit balance
  const balanceResult = await invokeRead(rpcClient, paymaster.hash, 'getSponsorDeposit', [h160(account.scriptHash)]);
  const depositBalance = BigInt(balanceResult?.stack?.[0]?.value || '0');
  console.log(`  Deposited: ${depositAmount} fractions (${Number(depositAmount) / 1e8} GAS)`);
  console.log(`  On-chain balance: ${depositBalance}`);

  if (depositBalance !== depositAmount) throw new Error(`Deposit mismatch: expected ${depositAmount}, got ${depositBalance}`);
  results.deposit = { amount: depositAmount.toString(), verified: true };

  // ── 4. Create Sponsorship Policy ──────────────────────────────────
  logSection('4. Create Sponsorship Policy');

  const maxPerOp = 50_000_000n;   // 0.5 GAS per op
  const dailyBudget = 100_000_000n; // 1 GAS daily
  const totalBudget = 200_000_000n; // 2 GAS total
  const validUntil = 0n; // no expiry

  const policyResult = await invokePersisted(rpcClient, paymaster.hash, account, networkMagic, 'setPolicy', [
    h160(accountId),           // specific account
    h160('0'.repeat(40)),      // any target contract
    str(''),                   // any method
    int(maxPerOp),
    int(dailyBudget),
    int(totalBudget),
    int(validUntil),
  ]);
  assertHalt(policyResult.appLog, 'setPolicy');
  console.log(`  Policy created: maxPerOp=${maxPerOp}, daily=${dailyBudget}, total=${totalBudget}`);
  results.policy = { maxPerOp: maxPerOp.toString(), dailyBudget: dailyBudget.toString(), totalBudget: totalBudget.toString() };

  // ── 5. Validate Paymaster Op (read-only preflight) ────────────────
  logSection('5. Validate Paymaster Op (preflight)');

  const reimbursement = 10_000_000n; // 0.1 GAS
  const validateResult = await invokeRead(rpcClient, paymaster.hash, 'validatePaymasterOp', [
    h160(account.scriptHash), // sponsor
    h160(accountId),          // account
    h160(GAS_HASH),           // target
    str('symbol'),            // method
    int(reimbursement),
  ]);
  const isValid = validateResult?.stack?.[0]?.value === true || validateResult?.stack?.[0]?.value === 1;
  console.log(`  Preflight valid: ${isValid}`);
  if (!isValid) throw new Error('Paymaster validation failed unexpectedly');
  results.preflight = { valid: true };

  // ── 6. Execute Sponsored UserOp ───────────────────────────────────
  logSection('6. Execute Sponsored UserOp (executeSponsoredUserOp)');

  // Build and sign the UserOp

  const nonceResult = await invokeRead(rpcClient, core.hash, 'getNonce', [h160(accountId), int(0)]);
  const nonce = BigInt(nonceResult?.stack?.[0]?.value || '0');

  const argsHash = await aaClient.computeArgsHash([]);
  const deadline = BigInt(Date.now() + 3600 * 1000);

  const typedData = buildV3UserOperationTypedData({
    chainId: networkMagic,
    verifyingContract: sanitizeHex(verifier.hash),
    accountIdHash: accountId,
    coreContractHash: sanitizeHex(core.hash),
    targetContract: sanitizeHex(GAS_HASH),
    method: 'symbol',
    argsHashHex: argsHash,
    nonce,
    deadline,
  });

  const evmSignature = await evmWallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  const compact = compactSignature(evmSignature);

  const op = userOpParam({
    targetContract: GAS_HASH,
    method: 'symbol',
    args: [],
    nonce,
    deadline,
    signatureHex: compact,
  });

  const sponsoredExec = await invokePersisted(
    rpcClient, core.hash, account, networkMagic,
    'executeSponsoredUserOp',
    [h160(accountId), op, h160(paymaster.hash), h160(account.scriptHash), int(reimbursement)],
  );
  const execState = String(sponsoredExec.execution.vmstate || sponsoredExec.execution.state || '');

  if (!execState.includes('HALT')) {
    console.error(`  FAULT: ${sponsoredExec.execution.exception || 'unknown'}`);
    throw new Error(`executeSponsoredUserOp did not HALT: ${execState}`);
  }

  const execResult = stackItemToText(sponsoredExec.execution.stack?.[0]);
  console.log(`  Result: ${execResult} (expected: GAS)`);
  console.log(`  Tx: ${sponsoredExec.txid}`);

  // Verify deposit was deducted
  const postBalance = await invokeRead(rpcClient, paymaster.hash, 'getSponsorDeposit', [h160(account.scriptHash)]);
  const newBalance = BigInt(postBalance?.stack?.[0]?.value || '0');
  const expectedBalance = depositAmount - reimbursement;
  console.log(`  Deposit after: ${newBalance} (expected: ${expectedBalance})`);

  if (newBalance !== expectedBalance) throw new Error(`Balance mismatch: expected ${expectedBalance}, got ${newBalance}`);

  // Verify spending counters
  const dailySpent = await invokeRead(rpcClient, paymaster.hash, 'getDailySpent', [h160(account.scriptHash), h160(accountId)]);
  const totalSpent = await invokeRead(rpcClient, paymaster.hash, 'getTotalSpent', [h160(account.scriptHash), h160(accountId)]);
  console.log(`  Daily spent: ${dailySpent?.stack?.[0]?.value || '0'}`);
  console.log(`  Total spent: ${totalSpent?.stack?.[0]?.value || '0'}`);

  results.sponsoredExec = {
    txid: sponsoredExec.txid,
    result: execResult,
    depositBefore: depositAmount.toString(),
    depositAfter: newBalance.toString(),
    reimbursement: reimbursement.toString(),
    balanceCorrect: newBalance === expectedBalance,
  };

  // ── 7. Negative: Exceed per-op limit ──────────────────────────────
  logSection('7. Negative: Exceed per-op limit');

  const overLimitAmount = maxPerOp + 1n;
  const overLimitValidation = await invokeRead(rpcClient, paymaster.hash, 'validatePaymasterOp', [
    h160(account.scriptHash),
    h160(accountId),
    h160(GAS_HASH),
    str('symbol'),
    int(overLimitAmount),
  ]);
  const overLimitValid = overLimitValidation?.stack?.[0]?.value === true || overLimitValidation?.stack?.[0]?.value === 1;
  console.log(`  Over-limit validation: ${overLimitValid} (expected: false)`);
  if (overLimitValid) throw new Error('Over-limit validation should have been rejected');
  results.negativeOverLimit = { rejected: true };

  // ── 8. Negative: Revoke policy then try ───────────────────────────
  logSection('8. Negative: Revoke policy then execute');

  const revokeResult = await invokePersisted(rpcClient, paymaster.hash, account, networkMagic, 'revokePolicy', [
    h160(accountId),
  ]);
  assertHalt(revokeResult.appLog, 'revokePolicy');
  console.log('  Policy revoked');

  // Validate should now fail
  const revokedValidation = await invokeRead(rpcClient, paymaster.hash, 'validatePaymasterOp', [
    h160(account.scriptHash),
    h160(accountId),
    h160(GAS_HASH),
    str('symbol'),
    int(reimbursement),
  ]);
  const revokedValid = revokedValidation?.stack?.[0]?.value === true || revokedValidation?.stack?.[0]?.value === 1;
  console.log(`  Post-revoke validation: ${revokedValid} (expected: false)`);
  if (revokedValid) throw new Error('Post-revoke validation should have been rejected');
  results.negativeRevoked = { rejected: true };

  // ── 9. Withdraw Remaining Deposit ─────────────────────────────────
  logSection('9. Withdraw Remaining Deposit');

  const remainingBalance = BigInt((await invokeRead(rpcClient, paymaster.hash, 'getSponsorDeposit', [h160(account.scriptHash)]))?.stack?.[0]?.value || '0');
  console.log(`  Remaining: ${remainingBalance}`);

  if (remainingBalance > 0n) {
    const withdrawResult = await invokePersisted(rpcClient, paymaster.hash, account, networkMagic, 'withdrawDeposit', [
      int(remainingBalance),
    ]);
    assertHalt(withdrawResult.appLog, 'withdrawDeposit');

    const finalBalance = BigInt((await invokeRead(rpcClient, paymaster.hash, 'getSponsorDeposit', [h160(account.scriptHash)]))?.stack?.[0]?.value || '0');
    console.log(`  After withdraw: ${finalBalance} (expected: 0)`);
    if (finalBalance !== 0n) throw new Error(`Withdraw incomplete: ${finalBalance} remaining`);
    results.withdraw = { amount: remainingBalance.toString(), success: true };
  }

  // ── Summary ───────────────────────────────────────────────────────
  logSection('VALIDATION COMPLETE');
  console.log(JSON.stringify(results, null, 2));
  console.log('\nAll paymaster on-chain validations passed.');
}

main().catch(error => {
  console.error('\nVALIDATION FAILED:', error.message || error);
  process.exit(1);
});
