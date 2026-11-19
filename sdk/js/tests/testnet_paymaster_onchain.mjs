#!/usr/bin/env node

/**
 * v4 on-chain paymaster runbook (SAPaymaster).
 *
 * v3 registered an account with a verifier in one call and signed a six-field
 * operation whose nonce was read per account. Protocol v4 has neither: an
 * account is created from custody plus salt with modules installed by action,
 * every operation carries thirteen fields, and its nonce names the channel the
 * validator routes on. This runbook proves the same sponsored ground on the v4
 * surface:
 *
 *   1. deploy the v4 core, the Web3AuthValidator module and SAPaymaster, and
 *      bind both module and paymaster to the core they serve;
 *   2. create an account that installs the Web3AuthValidator atomically (which
 *      also turns the built-in custody route off);
 *   3. deposit GAS into the paymaster and create an account-scoped policy;
 *   4. preflight the policy through the read-only `validatePaymasterOp`;
 *   5. execute a sponsored operation through `executeSponsoredUserOp`, where
 *      the validator route signs the §5 EIP-712 payload and settlement is
 *      capped to the gas the relay actually paid;
 *   6. execute a two-operation sponsored batch through
 *      `executeSponsoredUserOps`, where the settlement covers the envelope once;
 *   7. refuse an over-limit and a wrong-target request at preflight, revoke the
 *      policy, and prove that a persisted sponsored execution is then rejected
 *      on chain without consuming its nonce;
 *   8. withdraw the remaining deposit.
 *
 * This is a runbook, not a gate: `npm test` does not run it, and the v4 core is
 * not deployed to a public testnet yet. It is written against the artifacts
 * `bash contracts/compile.sh` produces in `contracts/bin/public`.
 *
 * Usage:
 *   TEST_WIF=Kx... node tests/testnet_paymaster_onchain.mjs
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const crypto = require("node:crypto");
const { CONST } = require("@cityofzion/neon-js");
const { ethers } = require("ethers");
const h = require("./testnet-v4-harness.js");

const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const NEO_HASH = CONST.NATIVE_CONTRACT_HASH.NeoToken;
const SALT_BYTES = 20;
const ONE_GAS = 100000000n;

let checks = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
  console.log(`  ok: ${message}`);
}

function saltHex() {
  return crypto.randomBytes(SALT_BYTES).toString("hex");
}

/** The channel a validator-routed operation spends. */
function routingFor(state, validatorId, credentialGeneration) {
  return {
    validatorId: String(validatorId),
    credentialGeneration: String(credentialGeneration),
    authorityEpoch: state.authorityEpoch,
    nonceSubkey: "00".repeat(32),
  };
}

/**
 * One sponsored `symbol` read of GAS, signed for the account's Web3Auth
 * validator. The typed data binds the operation digest, so every field of the
 * thirteen — including the channel nonce — is covered before the core routes it.
 */
async function signedSymbolOperation(chain, coreHash, { validatorHash, accountId, state, record, signer, nonce }) {
  const op = h.operation({
    targetContract: GAS_HASH,
    method: "symbol",
    nonce,
    validatorId: record.id,
    credentialGeneration: record.credentialGeneration,
    authorityEpoch: state.authorityEpoch,
  });
  const argsHashHex = await h.operationArgsHash(chain, coreHash, op.args);
  return h.signOperationForWeb3Auth(chain, coreHash, {
    validatorHash,
    accountId,
    operation: op,
    argsHashHex,
    signer,
  });
}

async function sponsorDeposit(chain, paymasterHash, sponsor) {
  const item = await h.readAndDecode(chain, paymasterHash, "getSponsorDeposit", [h.hash160Param(sponsor)]);
  return BigInt(h.decodeInteger(item));
}

async function spendingCounters(chain, paymasterHash, sponsor, accountId) {
  const daily = await h.readAndDecode(chain, paymasterHash, "getDailySpent", [
    h.hash160Param(sponsor),
    h.hash160Param(accountId),
  ]);
  const total = await h.readAndDecode(chain, paymasterHash, "getTotalSpent", [
    h.hash160Param(sponsor),
    h.hash160Param(accountId),
  ]);
  return { daily: BigInt(h.decodeInteger(daily)), total: BigInt(h.decodeInteger(total)) };
}

async function preflight(chain, paymasterHash, sponsor, accountId, target, method, amount) {
  const item = await h.readAndDecode(chain, paymasterHash, "validatePaymasterOp", [
    h.hash160Param(sponsor),
    h.hash160Param(accountId),
    h.hash160Param(target),
    h.stringParam(method),
    h.integerParam(amount),
  ]);
  return h.stackText(item) === "true";
}

async function main() {
  if (!process.env.TEST_WIF && !process.env.NEO_TESTNET_WIF) {
    console.error("TEST_WIF or NEO_TESTNET_WIF is required.");
    process.exit(1);
  }
  const chain = await h.connect();
  const sponsor = chain.account;
  const sponsorHash = h.normalizeHash(sponsor.scriptHash);

  console.log(JSON.stringify({
    rpc: chain.rpcUrl,
    networkMagic: chain.networkMagic,
    runId: chain.runId,
    sponsorAddress: sponsor.address,
    sponsorScriptHash: sponsorHash,
  }, null, 2));

  // -------------------------------------------------------------------------
  // 1. Deploy the core, the validator module and the paymaster.
  // -------------------------------------------------------------------------

  h.logSection("1. Deploy core, Web3AuthValidator and SAPaymaster");
  const core = await h.deployCore(chain);
  const web3Auth = await h.deployModule(chain, core.hash, "validators/Web3AuthValidator");
  const paymaster = await h.deployContract(chain, "SAPaymaster", `${chain.deploymentTag}-paymaster`);
  // Both bind to exactly one core. The core learns the validator through the
  // install action (and `deployModule` wrote that binding); the paymaster is
  // trusted only because it answers with this core from `authorizedCore`, which
  // the sponsored entry point re-checks.
  await h.authorizeModule(chain, core.hash, paymaster.hash);
  console.log(JSON.stringify({ core, web3Auth, paymaster }, null, 2));

  const sdk = h.clientFor(chain, core.hash);
  const protocol = await sdk.getProtocolInfo();
  assert(protocol.protocolVersion === "4", `core reports protocol ${protocol.protocolVersion}, expected 4`);
  const boundCore = h.stackText(await h.readAndDecode(chain, paymaster.hash, "authorizedCore", []));
  assert(
    h.sanitizeHex(boundCore).toLowerCase() === h.sanitizeHex(core.hash).toLowerCase(),
    "the paymaster reports the deployed core as its authorized core",
  );

  // -------------------------------------------------------------------------
  // 2. Create the account with the validator installed at creation.
  // -------------------------------------------------------------------------

  h.logSection("2. Create account with Web3AuthValidator installed at creation");
  const evmSigner = ethers.Wallet.createRandom();
  const evmPubKey = h.sanitizeHex(evmSigner.signingKey.compressedPublicKey);
  const install = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: web3Auth.hash,
    initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(evmPubKey)],
  });
  const account = await h.createAccount(chain, sdk, {
    custody: sponsor,
    salt: saltHex(),
    actions: [install],
  });
  const accountId = account.accountId;
  const state = await sdk.getAccount(accountId);
  const validatorIds = (await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE)).moduleIds;
  assert(validatorIds.length === 1, `expected one installed validator, got ${validatorIds.length}`);
  assert(state.defaultOperationAuthorization === false, "installing a validator turns the built-in custody route off");
  const validator = {
    id: validatorIds[0],
    credentialGeneration: (await h.moduleState(sdk, accountId, validatorIds[0])).credentialGeneration,
  };
  const storedKey = Buffer.from(
    (await h.readAndDecode(chain, web3Auth.hash, "getPublicKey", [
      h.hash160Param(accountId),
      h.integerParam(validator.id),
    ])).value || "",
    "base64",
  ).toString("hex");
  assert(storedKey.toUpperCase() === evmPubKey.toUpperCase(), "the validator instance stores the installed secp256k1 key");
  console.log(JSON.stringify({
    txid: account.txid,
    accountId: h.normalizeHash(accountId),
    virtualAddress: account.accountAddress,
    validator,
    storedPublicKey: storedKey,
    configurationNonce: (await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE)).configurationNonce,
  }, null, 2));

  // -------------------------------------------------------------------------
  // 3. Deposit GAS and create the sponsorship policy.
  // -------------------------------------------------------------------------

  h.logSection("3. Deposit GAS into the paymaster");
  const depositAmount = 2n * ONE_GAS;
  const deposit = await h.invokePersisted(chain, GAS_HASH, "transfer", [
    h.hash160Param(sponsorHash),
    h.hash160Param(paymaster.hash),
    h.integerParam(depositAmount),
    h.anyParam(null),
  ]);
  let depositBalance = await sponsorDeposit(chain, paymaster.hash, sponsorHash);
  assert(depositBalance === depositAmount, `deposit reads back ${depositBalance}, expected ${depositAmount}`);
  console.log(JSON.stringify({ txid: deposit.txid, deposit: depositBalance.toString() }, null, 2));

  h.logSection("4. Create sponsorship policy");
  const maxPerOp = ONE_GAS / 2n;      // 0.5 GAS per operation
  const dailyBudget = ONE_GAS;        // 1 GAS per rolling day
  const totalBudget = 2n * ONE_GAS;   // 2 GAS lifetime
  const policy = await h.invokePersisted(chain, paymaster.hash, "setPolicy", [
    h.hash160Param(accountId),
    h.hash160Param(GAS_HASH),         // only the GAS token is sponsored
    h.stringParam("symbol"),          // and only its symbol read
    h.integerParam(maxPerOp),
    h.integerParam(dailyBudget),
    h.integerParam(totalBudget),
    h.integerParam(0),                // no expiry
  ]);
  const policyItem = await h.readAndDecode(chain, paymaster.hash, "getPolicy", [
    h.hash160Param(sponsorHash),
    h.hash160Param(accountId),
  ]);
  // The RPC renders the struct as an array: target, method, maxPerOp, daily,
  // total, validUntil.
  assert(
    policyItem?.type === "Array" && policyItem.value?.length === 6,
    `the policy reads back as six fields, got ${JSON.stringify(policyItem)}`,
  );
  console.log(JSON.stringify({
    txid: policy.txid,
    maxPerOp: maxPerOp.toString(),
    dailyBudget: dailyBudget.toString(),
    totalBudget: totalBudget.toString(),
  }, null, 2));

  // -------------------------------------------------------------------------
  // 5. Preflight: the read-only policy view the relay calls first.
  // -------------------------------------------------------------------------

  h.logSection("5. Preflight the policy");
  const reimbursement = ONE_GAS / 10n; // 0.1 GAS requested from the relay
  assert(
    await preflight(chain, paymaster.hash, sponsorHash, accountId, GAS_HASH, "symbol", reimbursement),
    "a sponsored GAS symbol read inside the policy is approved",
  );
  assert(
    !(await preflight(chain, paymaster.hash, sponsorHash, accountId, NEO_HASH, "symbol", reimbursement)),
    "a target outside the policy is refused",
  );
  assert(
    !(await preflight(chain, paymaster.hash, sponsorHash, accountId, GAS_HASH, "symbol", maxPerOp + 1n)),
    "a request above the per-operation limit is refused",
  );

  // -------------------------------------------------------------------------
  // 6. Sponsored execution (single).
  // -------------------------------------------------------------------------

  h.logSection("6. ExecuteSponsoredUserOp");
  const routing = routingFor(state, validator.id, validator.credentialGeneration);
  const singleNonce = await h.nextNonce(sdk, accountId, routing);
  const signedSingle = await signedSymbolOperation(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId,
    state,
    record: validator,
    signer: evmSigner,
    nonce: singleNonce,
  });
  const preview = await h.validateOperation(chain, sdk, accountId, signedSingle);
  assert(preview.accepted === true, "the core accepts the validator's typed-data signature");
  assert(
    preview.operationDigest === h.operationDigest(chain, core.hash, accountId, signedSingle),
    "the preview digest agrees with the local v4 codec",
  );

  const beforeSingle = depositBalance;
  const single = await h.invokePersisted(chain, core.hash, "executeSponsoredUserOp", [
    h.hash160Param(accountId),
    h.operationParam(signedSingle),
    h.hash160Param(paymaster.hash),
    h.hash160Param(sponsorHash),
    h.integerParam(reimbursement),
  ]);
  const singleResult = h.stackText(single.execution.stack[0]);
  assert(singleResult === "GAS", `the sponsored operation returned ${singleResult}, expected GAS`);

  depositBalance = await sponsorDeposit(chain, paymaster.hash, sponsorHash);
  const singleSettled = beforeSingle - depositBalance;
  // Settlement is capped to the transaction's real cost, so the relay receives
  // the smaller of the requested amount and the fees it actually paid.
  assert(singleSettled > 0n, "the sponsor deposit was charged");
  assert(singleSettled <= reimbursement, `settled ${singleSettled} must not exceed the requested ${reimbursement}`);
  const countsAfterSingle = await spendingCounters(chain, paymaster.hash, sponsorHash, accountId);
  assert(countsAfterSingle.daily === singleSettled, "the daily counter moved by exactly the settled amount");
  assert(countsAfterSingle.total === singleSettled, "the total counter moved by exactly the settled amount");
  assert(
    BigInt((await sdk.getNonce(accountId, routing)).sequence) === 1n,
    "the validator channel advanced to sequence 1",
  );
  console.log(JSON.stringify({
    txid: single.txid,
    result: singleResult,
    operationDigest: preview.operationDigest,
    requested: reimbursement.toString(),
    settled: singleSettled.toString(),
    depositAfter: depositBalance.toString(),
  }, null, 2));

  // -------------------------------------------------------------------------
  // 7. Sponsored execution (batch): one envelope, one settlement.
  // -------------------------------------------------------------------------

  h.logSection("7. ExecuteSponsoredUserOps (two-operation batch)");
  const batchStart = await h.nextNonce(sdk, accountId, routing);
  const secondNonce = (BigInt(batchStart) + 1n).toString();
  const batchFirst = await signedSymbolOperation(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId,
    state,
    record: validator,
    signer: evmSigner,
    nonce: batchStart,
  });
  const batchSecond = await signedSymbolOperation(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId,
    state,
    record: validator,
    signer: evmSigner,
    nonce: secondNonce,
  });
  const beforeBatch = depositBalance;
  const batch = await h.invokePersisted(chain, core.hash, "executeSponsoredUserOps", [
    h.hash160Param(accountId),
    h.arrayParam([h.operationParam(batchFirst), h.operationParam(batchSecond)]),
    h.hash160Param(paymaster.hash),
    h.hash160Param(sponsorHash),
    h.integerParam(reimbursement),
  ]);
  const batchResults = batch.execution.stack[0];
  assert(batchResults?.type === "Array" && batchResults.value.length === 2, "the batch returned one result per operation");
  const batchTexts = batchResults.value.map((item) => h.stackText(item));
  assert(batchTexts.every((text) => text === "GAS"), `batch results ${JSON.stringify(batchTexts)} must all be GAS`);
  depositBalance = await sponsorDeposit(chain, paymaster.hash, sponsorHash);
  const batchSettled = beforeBatch - depositBalance;
  assert(batchSettled > 0n, "the batch was settled once");
  assert(batchSettled <= reimbursement, `batch settlement ${batchSettled} must not exceed the requested ${reimbursement}`);
  const countsAfterBatch = await spendingCounters(chain, paymaster.hash, sponsorHash, accountId);
  assert(
    countsAfterBatch.total === countsAfterSingle.total + batchSettled,
    "the total counter moved by exactly the batch settlement",
  );
  assert(
    BigInt((await sdk.getNonce(accountId, routing)).sequence) === 3n,
    "the two batch operations consumed sequences 1 and 2",
  );
  console.log(JSON.stringify({
    txid: batch.txid,
    results: batchTexts,
    settled: batchSettled.toString(),
    depositAfter: depositBalance.toString(),
    totalSpent: countsAfterBatch.total.toString(),
  }, null, 2));

  // -------------------------------------------------------------------------
  // 8. Revocation is enforced on chain, atomically.
  // -------------------------------------------------------------------------

  h.logSection("8. Revoke the policy and prove the on-chain refusal");
  const revoke = await h.invokePersisted(chain, paymaster.hash, "revokePolicy", [h.hash160Param(accountId)]);
  assert(
    !(await preflight(chain, paymaster.hash, sponsorHash, accountId, GAS_HASH, "symbol", reimbursement)),
    "preflight refuses after the policy is revoked",
  );

  const refusedNonce = await h.nextNonce(sdk, accountId, routing);
  const refusedOp = await signedSymbolOperation(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId,
    state,
    record: validator,
    signer: evmSigner,
    nonce: refusedNonce,
  });
  let refusal = "";
  try {
    await h.invokePersisted(chain, core.hash, "executeSponsoredUserOp", [
      h.hash160Param(accountId),
      h.operationParam(refusedOp),
      h.hash160Param(paymaster.hash),
      h.hash160Param(sponsorHash),
      h.integerParam(reimbursement),
    ]);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  assert(/No sponsorship policy/.test(refusal), `the persisted sponsored call was refused for the policy, got: ${refusal}`);
  assert(
    BigInt((await sdk.getNonce(accountId, routing)).sequence) === 3n,
    "the refused sponsored call did not consume its nonce",
  );
  assert(
    (await sponsorDeposit(chain, paymaster.hash, sponsorHash)) === depositBalance,
    "the refused sponsored call did not move the deposit",
  );
  console.log(JSON.stringify({ revokeTxid: revoke.txid, refusal }, null, 2));

  // -------------------------------------------------------------------------
  // 9. Withdraw the remaining deposit.
  // -------------------------------------------------------------------------

  h.logSection("9. Withdraw remaining deposit");
  const remaining = depositBalance;
  if (remaining > 0n) {
    const withdraw = await h.invokePersisted(chain, paymaster.hash, "withdrawDeposit", [h.integerParam(remaining)]);
    depositBalance = await sponsorDeposit(chain, paymaster.hash, sponsorHash);
    assert(depositBalance === 0n, `deposit after withdrawal is ${depositBalance}, expected 0`);
    console.log(JSON.stringify({ txid: withdraw.txid, withdrawn: remaining.toString() }, null, 2));
  }

  // -------------------------------------------------------------------------
  // Summary — the last JSON object is what the validation suite reads.
  // -------------------------------------------------------------------------

  h.logSection("Summary");
  console.log(JSON.stringify({
    checks,
    deployments: {
      core: h.normalizeHash(core.hash),
      verifier: h.normalizeHash(web3Auth.hash),
      paymaster: h.normalizeHash(paymaster.hash),
    },
    account: {
      id: h.normalizeHash(accountId),
      virtualAddress: account.accountAddress,
      validatorId: validator.id,
      validatorGeneration: validator.credentialGeneration,
    },
    policy: {
      maxPerOp: maxPerOp.toString(),
      dailyBudget: dailyBudget.toString(),
      totalBudget: totalBudget.toString(),
    },
    sponsoredExec: {
      txid: single.txid,
      result: singleResult,
      depositBefore: (beforeSingle).toString(),
      depositAfter: (beforeSingle - singleSettled).toString(),
      reimbursement: reimbursement.toString(),
      settled: singleSettled.toString(),
      balanceCorrect: true,
    },
    sponsoredBatch: {
      txid: batch.txid,
      results: batchTexts,
      settled: batchSettled.toString(),
    },
    negativeOverLimit: { rejected: true },
    negativeRevoked: { rejected: true, onChainRefusal: refusal },
    withdraw: { amount: remaining.toString(), success: remaining > 0n },
    txids: {
      createAccount: account.txid,
      deposit: deposit.txid,
      policy: policy.txid,
      sponsored: single.txid,
      sponsoredBatch: batch.txid,
      revoke: revoke.txid,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
