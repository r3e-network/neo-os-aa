#!/usr/bin/env node
/**
 * v4 verification runbook: one account per protocol surface, every assertion
 * read back from the deployed kernel.
 *
 * The v3 script of this name deployed the core plus six verifier/hook plugins
 * and mutated them through registration fields, `callVerifier` and `callHook`.
 * Protocol v4 deleted all three: a module is an instance with an allocated id,
 * its configuration is an `onInstall`/`configure` callback, and a threshold is
 * a core-owned policy that names member ids. This runbook keeps the same
 * ground and proves it on the v4 surface:
 *
 * 1. built-in route: custody signs the §4.3 digest with the §8 envelope, the
 *    operation executes, its nonce channel advances, and a replay is refused;
 * 2. P256Validator: a standalone validator instance accepts exactly the key
 *    installed into it and refuses a foreign key;
 * 3. DailyLimitHook: a configured per-token limit is read back from the hook
 *    and an over-limit `transfer` is refused before dispatch;
 * 4. hook composition and configuration intent: hooks install into the core
 *    hook order, a reorder is only proposed (24h maturity), an early confirm
 *    is refused, and cancel leaves the order untouched;
 * 5. recovery: begin records maturity, an early execute is refused, cancel
 *    clears the record;
 * 6. threshold policy: a 2-of-2 policy over two validator instances executes
 *    with the member-list signature, and a single member, a stale generation,
 *    an independently routed member and a duplicate-member policy are refused;
 * 7. Web3AuthValidator: the typed data the SDK builds hashes to the exact
 *    66-byte payload the deployed validator verifies, and only the installed
 *    secp256k1 key authorizes the operation.
 *
 * Runbooks are not gates. Nothing here runs in `npm test`, and the v4 core is
 * not on a public testnet yet, so this is exercised only against a chain that
 * already carries the artifacts built by `bash contracts/compile.sh`.
 */

const crypto = require("crypto");
const { CONST, wallet } = require("@cityofzion/neon-js");
const { ethers } = require("ethers");

const h = require("./testnet-v4-harness");

const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const DAILY_LIMIT = 10_000;
const OVER_LIMIT = 20_000;
const SALT_BYTES = 20;

let checks = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
  console.log(`  ok: ${message}`);
}

function saltHex() {
  return crypto.randomBytes(SALT_BYTES).toString("hex");
}

function nonceRouting(descriptor, validatorId = "0", credentialGeneration = "1") {
  return {
    validatorId,
    credentialGeneration,
    authorityEpoch: descriptor.authorityEpoch,
    nonceSubkey: "00".repeat(32),
  };
}

/** A 13-field operation whose nonce comes from the channel the core reports. */
async function routedOperation(sdk, accountId, { validatorId = "0", credentialGeneration = "1", descriptor, targetContract = GAS_HASH, method = "symbol", args = [] }) {
  const state = descriptor || (await sdk.getAccount(accountId));
  const routing = nonceRouting(state, validatorId, credentialGeneration);
  const nonce = await h.nextNonce(sdk, accountId, routing);
  return h.operation({
    targetContract,
    method,
    args,
    nonce,
    validatorId,
    credentialGeneration: routing.credentialGeneration,
    authorityEpoch: routing.authorityEpoch,
    nonceSubkey: routing.nonceSubkey,
  });
}

/** A standalone P-256 validator route: field 11 is the raw 64-byte r‖s. */
function signWithP256(chain, coreHash, { accountId, operation: op, key, moduleId }) {
  const digest = h.operationDigest(chain, coreHash, accountId, op);
  return {
    ...op,
    validatorId: String(moduleId),
    signature: wallet.sign(digest, key.privateKey),
  };
}

/** The 66-byte typed-data payload is a VM ByteString; compare it as bytes. */
function stackBytesHex(item) {
  return Buffer.from(item?.value || "", "base64").toString("hex");
}

/** A canonical operation value as the RPC parameter the core's reads take. */
function operationParam(op) {
  return h.operationParam(op);
}

async function main() {
  const chain = await h.connect();
  const custody = h.normalizeHash(chain.account.scriptHash);

  console.log(JSON.stringify({
    rpc: chain.rpcUrl,
    networkMagic: chain.networkMagic,
    runId: chain.runId,
    address: chain.account.address,
    scriptHash: custody,
  }, null, 2));

  // -------------------------------------------------------------------------
  // Deployment: one core, two validators, two hooks.
  // -------------------------------------------------------------------------

  h.logSection("Deploy Contracts");
  const core = await h.deployCore(chain);
  const p256 = await h.deployModule(chain, core.hash, "validators/P256Validator");
  const multiSig = await h.deployModule(chain, core.hash, "validators/MultiSigValidator");
  const web3Auth = await h.deployModule(chain, core.hash, "validators/Web3AuthValidator");
  const whitelist = await h.deployModule(chain, core.hash, "hooks/WhitelistHook");
  const dailyLimit = await h.deployModule(chain, core.hash, "hooks/DailyLimitHook");
  console.log(JSON.stringify({ core, p256, multiSig, web3Auth, whitelist, dailyLimit }, null, 2));

  const sdk = h.clientFor(chain, core.hash);
  const protocol = await sdk.getProtocolInfo();
  assert(protocol.protocolVersion === "4", `core reports protocol ${protocol.protocolVersion}`);

  // -------------------------------------------------------------------------
  // 1. Built-in route: custody signs the operation digest.
  // -------------------------------------------------------------------------

  h.logSection("1. Built-In Route");
  const builtInAccount = await h.createAccount(chain, sdk, { custody: chain.account, salt: saltHex() });
  const builtInId = builtInAccount.accountId;
  const builtInState = await sdk.getAccount(builtInId);
  assert(builtInState.defaultOperationAuthorization === true, "a custody-only account keeps the built-in route");
  assert(
    BigInt(builtInState.recoveryTimelockMs) >= 7n * 24n * 3600n * 1000n,
    `recovery timelock ${builtInState.recoveryTimelockMs} is below the protocol minimum`,
  );

  const builtInOp = await routedOperation(sdk, builtInId, { descriptor: builtInState });
  const signedBuiltInOp = h.signOperationWithCustody(chain, core.hash, { accountId: builtInId, operation: builtInOp });
  // The client re-reads getOperationDigest and refuses a chain/offline mismatch.
  const builtInDigest = await sdk.getOperationDigest(builtInId, signedBuiltInOp);
  assert(builtInDigest === h.operationDigest(chain, core.hash, builtInId, signedBuiltInOp), "core digest equals the offline codec digest");
  const builtInPreview = await h.validateOperation(chain, sdk, builtInId, signedBuiltInOp);
  assert(builtInPreview.accepted === true, "the core accepts the custody signature");
  const builtInExec = await h.executeOperation(chain, sdk, { accountId: builtInId, operation: signedBuiltInOp });
  const builtInResult = h.stackText(builtInExec.appLog.executions[0].stack[0]);
  assert(builtInResult === "GAS", `built-in route returned ${builtInResult}`);
  const builtInNonce = await sdk.getNonce(builtInId, nonceRouting(builtInState));
  assert(BigInt(builtInNonce.sequence) === 1n, `nonce sequence advanced to ${builtInNonce.sequence}`);

  const replayRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: builtInId, operations: [signedBuiltInOp] }),
    /SA_NONCE_INVALID|nonce/i,
    "replay of a consumed operation",
  );
  console.log(JSON.stringify({ accountId: h.normalizeHash(builtInId), txid: builtInExec.txid, operationDigest: builtInDigest, replayRefusal }, null, 2));

  // -------------------------------------------------------------------------
  // 2. P256Validator: one instance, one key.
  // -------------------------------------------------------------------------

  h.logSection("2. P256Validator");
  const p256Key = new wallet.Account();
  const rogueP256Key = new wallet.Account();
  const p256Install = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: p256.hash,
    initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(p256Key.publicKey)],
  });
  const p256Account = await h.createAccount(chain, sdk, { custody: chain.account, salt: saltHex(), actions: [p256Install] });
  const p256Id = p256Account.accountId;
  const p256State = await sdk.getAccount(p256Id);
  assert(p256State.defaultOperationAuthorization === false, "the first validator install turns the built-in route off");
  const p256Ids = await h.moduleIds(sdk, p256Id, h.VALIDATOR_MODULE_TYPE);
  assert(p256Ids.moduleIds.length === 1, `expected one validator instance, got ${p256Ids.moduleIds.length}`);
  const p256ModuleId = p256Ids.moduleIds[0];
  const p256Record = await h.moduleState(sdk, p256Id, p256ModuleId);
  assert(p256Record.credentialGeneration === "1", `a fresh instance starts at credential generation ${p256Record.credentialGeneration}`);
  // The descriptor's profile digest is the SHA-256 of the bytes the module
  // answers with, in hash order: independent proof the chain and the client
  // agree on digest byte order.
  const p256Profile = await h.moduleProfileDigest(chain, p256.hash);
  assert(p256Record.profileSha256 === p256Profile, `module profile digest ${p256Record.profileSha256} != ${p256Profile}`);
  const storedP256Key = stackBytesHex(await h.readAndDecode(chain, p256.hash, "getPublicKey", [
    h.hash160Param(p256Id),
    h.integerParam(p256ModuleId),
  ]));
  assert(storedP256Key.toUpperCase() === p256Key.publicKey.toUpperCase(), "the instance stores the installed P-256 key");

  const builtInAfterValidator = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, {
      accountId: p256Id,
      operations: [h.signOperationWithCustody(chain, core.hash, {
        accountId: p256Id,
        operation: await routedOperation(sdk, p256Id, { descriptor: p256State }),
      })],
    }),
    /SA_MODULE_NOT_ROUTABLE/,
    "custody signature on an account whose built-in route is off",
  );

  const p256Op = await routedOperation(sdk, p256Id, { validatorId: p256ModuleId, descriptor: p256State });
  const signedP256Op = signWithP256(chain, core.hash, { accountId: p256Id, operation: p256Op, key: p256Key, moduleId: p256ModuleId });
  const p256Preview = await h.validateOperation(chain, sdk, p256Id, signedP256Op);
  assert(p256Preview.accepted === true, "the instance accepts its own key");
  assert(p256Preview.operationDigest === h.operationDigest(chain, core.hash, p256Id, signedP256Op), "preview digest equals the offline codec digest");
  const p256Exec = await h.executeOperation(chain, sdk, { accountId: p256Id, operation: signedP256Op });
  assert(h.stackText(p256Exec.appLog.executions[0].stack[0]) === "GAS", "P256-routed operation executed");

  const rogueP256Op = await routedOperation(sdk, p256Id, { validatorId: p256ModuleId, descriptor: p256State });
  const signedRogueP256 = signWithP256(chain, core.hash, { accountId: p256Id, operation: rogueP256Op, key: rogueP256Key, moduleId: p256ModuleId });
  const rogueP256Refusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: p256Id, operations: [signedRogueP256] }),
    /SA_VALIDATION_REJECTED/,
    "a key the instance does not hold",
  );
  console.log(JSON.stringify({
    accountId: h.normalizeHash(p256Id),
    moduleId: p256ModuleId,
    profileSha256: p256Record.profileSha256,
    txid: p256Exec.txid,
    builtInAfterValidator,
    rogueP256Refusal,
  }, null, 2));

  // -------------------------------------------------------------------------
  // 3. DailyLimitHook: the meter refuses an over-limit transfer.
  // -------------------------------------------------------------------------

  h.logSection("3. DailyLimitHook");
  const limitedKey = new wallet.Account();
  const validatorInstall = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: p256.hash,
    initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(limitedKey.publicKey)],
  });
  const limitInstall = await h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: dailyLimit.hash,
    initData: [
      h.codec.stringValue("setDailyLimit"),
      h.codec.hashValue(GAS_HASH),
      h.codec.integerValue(String(DAILY_LIMIT)),
      h.codec.canonicalValue({ type: "Boolean", value: false }),
    ],
  });
  const limitAccount = await h.createAccount(chain, sdk, { custody: chain.account, salt: saltHex(), actions: [validatorInstall, limitInstall] });
  const limitId = limitAccount.accountId;
  const limitState = await sdk.getAccount(limitId);
  const limitValidatorId = (await h.moduleIds(sdk, limitId, h.VALIDATOR_MODULE_TYPE)).moduleIds[0];
  const limitHookIds = await h.moduleIds(sdk, limitId, h.HOOK_MODULE_TYPE);
  assert(limitHookIds.moduleIds.length === 1, `expected one hook instance, got ${limitHookIds.moduleIds.length}`);
  const limitHookId = limitHookIds.moduleIds[0];
  const limitRecord = await h.moduleState(sdk, limitId, limitValidatorId);
  const dailyLimitRead = h.decodeInteger(await h.readAndDecode(chain, dailyLimit.hash, "getDailyLimit", [
    h.hash160Param(limitId),
    h.integerParam(limitHookId),
    h.hash160Param(GAS_HASH),
  ]));
  const rollingRead = h.stackText(await h.readAndDecode(chain, dailyLimit.hash, "isRollingWindow", [
    h.hash160Param(limitId),
    h.integerParam(limitHookId),
    h.hash160Param(GAS_HASH),
  ]));
  assert(dailyLimitRead === String(DAILY_LIMIT), `daily limit reads back as ${dailyLimitRead}`);
  assert(rollingRead === "false", `rolling window reads back as ${rollingRead}`);

  // The account's assets leave from the proxy address, and the hook meters a
  // `transfer` whose source is that address (§9). The refusal is a fail-fast
  // pre-check, so no balance is needed to observe it.
  const proxyHash = await sdk.getProxyScriptHash(limitId);
  const recipient = new wallet.Account().scriptHash;
  const overLimitOp = await routedOperation(sdk, limitId, {
    validatorId: limitValidatorId,
    descriptor: limitState,
    targetContract: GAS_HASH,
    method: "transfer",
    args: [
      // A UInt160 argument is the 20-byte storage order, so the display
      // address goes through the codec's reverse-on-encode helper.
      h.codec.hashValue(proxyHash),
      h.codec.hashValue(h.sanitizeHex(recipient)),
      h.codec.integerValue(String(OVER_LIMIT)),
      h.codec.canonicalValue({ type: "Null" }),
    ],
  });
  const signedOverLimit = signWithP256(chain, core.hash, { accountId: limitId, operation: overLimitOp, key: limitedKey, moduleId: limitValidatorId });
  const nonceBeforeLimit = (await sdk.getNonce(limitId, nonceRouting(limitState, limitValidatorId))).sequence;
  const overLimitRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: limitId, operations: [signedOverLimit] }),
    /Daily limit exceeded/,
    "a transfer above the configured daily limit",
  );
  const nonceAfterLimit = (await sdk.getNonce(limitId, nonceRouting(limitState, limitValidatorId))).sequence;
  assert(nonceBeforeLimit === nonceAfterLimit, `the refused transfer left the nonce at ${nonceAfterLimit}`);
  console.log(JSON.stringify({
    accountId: h.normalizeHash(limitId),
    validatorId: limitValidatorId,
    hookId: limitHookId,
    dailyLimit: dailyLimitRead,
    rollingWindow: rollingRead,
    overLimitRefusal,
  }, null, 2));

  // -------------------------------------------------------------------------
  // 4. Hook order: a reorder is a configuration intent (24h maturity).
  // -------------------------------------------------------------------------

  h.logSection("4. Hook Order Intent");
  const orderWhitelist = await h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: whitelist.hash,
    initData: [h.codec.stringValue("allowTarget"), h.codec.hashValue(GAS_HASH)],
  });
  const orderLimit = await h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: dailyLimit.hash,
    initData: [
      h.codec.stringValue("setDailyLimit"),
      h.codec.hashValue(GAS_HASH),
      h.codec.integerValue(String(DAILY_LIMIT)),
      h.codec.canonicalValue({ type: "Boolean", value: false }),
    ],
  });
  const orderKey = new wallet.Account();
  const orderValidator = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: p256.hash,
    initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(orderKey.publicKey)],
  });
  const orderAccount = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions: [orderWhitelist, orderLimit, orderValidator],
  });
  const orderId = orderAccount.accountId;
  const orderState = await sdk.getAccount(orderId);
  const orderHooks = (await h.moduleIds(sdk, orderId, h.HOOK_MODULE_TYPE)).moduleIds;
  assert(orderHooks.length === 2, `expected two installed hooks, got ${orderHooks.length}`);
  const initialOrder = await sdk.getHookOrder(orderId);
  assert(
    initialOrder.hookIds.join(",") === orderHooks.join(","),
    `install order ${initialOrder.hookIds.join(",")} differs from the hook ids ${orderHooks.join(",")}`,
  );
  const reversed = [...orderHooks].reverse();
  const reorder = h.hookOrderAction(reversed);
  await h.proposeConfiguration(chain, sdk, { accountId: orderId, actions: [reorder] });
  const intentIds = await sdk.getPendingConfigurationIntentIds(orderId);
  assert(intentIds.length === 1, `expected one pending intent, got ${intentIds.length}`);
  const intent = await sdk.getPendingConfiguration(orderId, intentIds[0]);
  assert(intent.authorityEpoch === orderState.authorityEpoch, "the intent recorded the current authority epoch");
  assert(BigInt(intent.matureAt) > BigInt(Date.now()), `intent maturity ${intent.matureAt} is not in the future`);
  const earlyConfirmRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.configurationPlan(sdk, { kind: "confirm", accountId: orderId, intentId: intentIds[0], actions: [reorder] }),
    /SA_INTENT_IMMATURE/,
    "confirming a configuration intent before its maturity",
  );
  await h.cancelConfiguration(chain, sdk, { accountId: orderId, intentId: intentIds[0] });
  const afterCancelIds = await sdk.getPendingConfigurationIntentIds(orderId);
  assert(afterCancelIds.length === 0, `cancel left ${afterCancelIds.length} pending intents`);
  const orderAfterCancel = await sdk.getHookOrder(orderId);
  assert(orderAfterCancel.hookIds.join(",") === orderHooks.join(","), "cancel changed the hook order");
  console.log(JSON.stringify({
    accountId: h.normalizeHash(orderId),
    hookIds: orderHooks,
    hookOrderRevision: orderAfterCancel.revision,
    intentId: intentIds[0],
    matureAt: intent.matureAt,
    earlyConfirmRefusal,
  }, null, 2));

  // -------------------------------------------------------------------------
  // 5. Recovery: begin, early execute refused, cancel.
  // -------------------------------------------------------------------------

  h.logSection("5. Recovery");
  const recoveryAccount = await h.createAccount(chain, sdk, { custody: chain.account, salt: saltHex() });
  const recoveryId = recoveryAccount.accountId;
  const newCustody = new wallet.Account();
  const begin = await h.accountAction(chain, sdk, {
    accountId: recoveryId,
    method: "beginRecovery",
    args: [h.hash160Param(newCustody.scriptHash)],
    authorizers: [chain.account, newCustody],
  });
  const recoveryState = await sdk.getAccount(recoveryId);
  const recoveryStatus = await sdk.getRecoveryStatus(recoveryId);
  assert(recoveryState.recoveryPending === true, "beginRecovery marked the account");
  assert(recoveryStatus?.pending === true, "getRecoveryStatus reports the record");
  assert(BigInt(recoveryStatus.matureAt) > BigInt(Date.now()), `recovery maturity ${recoveryStatus.matureAt} is not in the future`);
  const earlyExecuteRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.accountActionPlan(sdk, { method: "executeRecovery", accountId: recoveryId, args: [] }),
    /SA_RECOVERY_LOCKED|locked/i,
    "executeRecovery before maturity",
  );
  await h.accountAction(chain, sdk, {
    accountId: recoveryId,
    method: "cancelRecovery",
    args: [],
    authorizers: [chain.account],
  });
  const cancelled = await sdk.getRecoveryStatus(recoveryId);
  assert(!cancelled || cancelled.pending === false, "cancelRecovery cleared the record");
  console.log(JSON.stringify({
    accountId: h.normalizeHash(recoveryId),
    newCustody: newCustody.address,
    beginTxid: begin.txid,
    matureAt: recoveryStatus.matureAt,
    earlyExecuteRefusal,
  }, null, 2));

  // -------------------------------------------------------------------------
  // 6. Threshold policy: a 2-of-2 over two validator instances.
  // -------------------------------------------------------------------------

  h.logSection("6. Threshold Policy");
  const memberA = new wallet.Account();
  const memberB = new wallet.Account();
  const installA = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: multiSig.hash,
    initData: [h.codec.stringValue("setMemberKey"), h.codec.byteStringValue(memberA.publicKey)],
  });
  const installB = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: p256.hash,
    initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(memberB.publicKey)],
  });
  // policyId 0 asks the core to allocate from the same monotonic id space the
  // installs just used: members are 1 and 2, so the policy is 3. A brand-new
  // policy is written once, which sets its credential generation to 1.
  const policy = h.thresholdPolicyAction({ policyId: "0", threshold: "2", members: ["1", "2"] });
  const thresholdAccount = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions: [installA, installB, policy],
  });
  const thresholdId = thresholdAccount.accountId;
  const thresholdState = await sdk.getAccount(thresholdId);
  const thresholdValidators = (await h.moduleIds(sdk, thresholdId, h.VALIDATOR_MODULE_TYPE)).moduleIds;
  assert(thresholdValidators.join(",") === "1,2", `validator ids are ${thresholdValidators.join(",")}, expected 1,2`);
  const policyId = "3";
  const policyGeneration = "1";

  // A member is never independently routable.
  const memberRouteOp = await routedOperation(sdk, thresholdId, { validatorId: "1", descriptor: thresholdState });
  const memberRouteRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: thresholdId, operations: [signWithP256(chain, core.hash, { accountId: thresholdId, operation: memberRouteOp, key: memberA, moduleId: "1" })] }),
    /SA_MODULE_NOT_ROUTABLE/,
    "routing an active-policy member as a standalone validator",
  );

  // A stale policy generation is refused before any signature is examined.
  const staleOp = await routedOperation(sdk, thresholdId, { validatorId: policyId, credentialGeneration: "2", descriptor: thresholdState });
  const staleDigest = h.operationDigest(chain, core.hash, thresholdId, staleOp);
  const staleSigned = {
    ...staleOp,
    signature: h.codec.thresholdSignature([
      { moduleId: "1", signature: wallet.sign(staleDigest, memberA.privateKey) },
      { moduleId: "2", signature: wallet.sign(staleDigest, memberB.privateKey) },
    ]),
  };
  const staleGenerationRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: thresholdId, operations: [staleSigned] }),
    /SA_CREDENTIAL_STALE/,
    "a policy generation that is not the current one",
  );

  const thresholdOp = await routedOperation(sdk, thresholdId, { validatorId: policyId, credentialGeneration: policyGeneration, descriptor: thresholdState });
  const thresholdDigest = await sdk.getOperationDigest(thresholdId, { ...thresholdOp, signature: "00" });
  assert(thresholdDigest === h.operationDigest(chain, core.hash, thresholdId, thresholdOp), "threshold operation digest agrees offline");
  const memberDigestA = h.codec.thresholdMemberDigest(thresholdDigest, "1", "1");
  const memberDigestB = h.codec.thresholdMemberDigest(thresholdDigest, "2", "1");
  // The member instance itself derives the digest it will verify (§5).
  const chainMemberDigestA = stackBytesHex(await h.readAndDecode(chain, multiSig.hash, "getMemberDigest", [
    h.hash160Param(thresholdId),
    h.integerParam("1"),
    h.byteArrayParam(thresholdDigest),
  ]));
  assert(chainMemberDigestA === memberDigestA, "the member derives the offline §5 member digest");
  const signedThreshold = {
    ...thresholdOp,
    signature: h.codec.thresholdSignature([
      { moduleId: "1", signature: wallet.sign(memberDigestA, memberA.privateKey) },
      { moduleId: "2", signature: wallet.sign(memberDigestB, memberB.privateKey) },
    ]),
  };
  const thresholdPreview = await h.validateOperation(chain, sdk, thresholdId, signedThreshold);
  // The read-only endpoint never orchestrates policy members, but it still
  // reports the digest the operation is bound to.
  assert(thresholdPreview.accepted === false, "the read-only preview does not orchestrate policy members");
  assert(thresholdPreview.operationDigest === thresholdDigest, "the preview reports the threshold operation digest");
  const thresholdExec = await h.executeOperation(chain, sdk, { accountId: thresholdId, operation: signedThreshold });
  assert(h.stackText(thresholdExec.appLog.executions[0].stack[0]) === "GAS", "2-of-2 policy executed");

  const singleOp = await routedOperation(sdk, thresholdId, { validatorId: policyId, credentialGeneration: policyGeneration, descriptor: thresholdState });
  const singleDigest = h.operationDigest(chain, core.hash, thresholdId, singleOp);
  const singleSigned = {
    ...singleOp,
    signature: h.codec.thresholdSignature([
      { moduleId: "1", signature: wallet.sign(h.codec.thresholdMemberDigest(singleDigest, "1", "1"), memberA.privateKey) },
    ]),
  };
  const belowThresholdRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: thresholdId, operations: [singleSigned] }),
    /SA_VALIDATION_REJECTED/,
    "one approval against a 2-of-2 threshold",
  );

  // A policy that names the same member twice is rejected at creation.
  const duplicatePolicy = h.thresholdPolicyAction({ policyId: "0", threshold: "1", members: ["1", "1"] });
  const duplicateSalt = saltHex();
  const duplicateActions = [
    await h.installActionFor(chain, {
      moduleType: h.VALIDATOR_MODULE_TYPE,
      moduleHash: multiSig.hash,
      initData: [h.codec.stringValue("setMemberKey"), h.codec.byteStringValue(memberA.publicKey)],
    }),
    await h.installActionFor(chain, {
      moduleType: h.VALIDATOR_MODULE_TYPE,
      moduleHash: p256.hash,
      initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(memberB.publicKey)],
    }),
    duplicatePolicy,
  ];
  const duplicateRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.registrationPlan(sdk, {
      custodyAddress: chain.account.scriptHash,
      salt: duplicateSalt,
      recoveryTimelockMs: h.REGISTRATION_RECOVERY_TIMELOCK_MS,
      actions: duplicateActions,
    }),
    /SA_OPERATION_MALFORMED/,
    "a threshold policy that repeats a member id",
  );
  console.log(JSON.stringify({
    accountId: h.normalizeHash(thresholdId),
    validatorIds: thresholdValidators,
    policyId,
    policyGeneration,
    memberDigest: { local: memberDigestA, chain: chainMemberDigestA },
    txid: thresholdExec.txid,
    memberRouteRefusal,
    staleGenerationRefusal,
    belowThresholdRefusal,
    duplicateRefusal,
  }, null, 2));

  // -------------------------------------------------------------------------
  // 7. Web3AuthValidator: the SDK's typed data is the validator's payload.
  // -------------------------------------------------------------------------

  h.logSection("7. Web3Auth Validator");
  const evmSigner = ethers.Wallet.createRandom();
  const rogueSigner = ethers.Wallet.createRandom();
  const evmPubKey = h.sanitizeHex(evmSigner.signingKey.compressedPublicKey);
  const web3Install = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: web3Auth.hash,
    initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(evmPubKey)],
  });
  const web3Account = await h.createAccount(chain, sdk, { custody: chain.account, salt: saltHex(), actions: [web3Install] });
  const web3Id = web3Account.accountId;
  const web3State = await sdk.getAccount(web3Id);
  const web3ValidatorId = (await h.moduleIds(sdk, web3Id, h.VALIDATOR_MODULE_TYPE)).moduleIds[0];
  const web3Record = await h.moduleState(sdk, web3Id, web3ValidatorId);
  const storedEvmKey = stackBytesHex(await h.readAndDecode(chain, web3Auth.hash, "getPublicKey", [
    h.hash160Param(web3Id),
    h.integerParam(web3ValidatorId),
  ]));
  assert(storedEvmKey.toUpperCase() === evmPubKey.toUpperCase(), "the instance stores the installed secp256k1 key");

  const web3Op = await routedOperation(sdk, web3Id, { validatorId: web3ValidatorId, descriptor: web3State });
  const argsHash = await h.operationArgsHash(chain, core.hash, web3Op.args);
  const typed = h.web3AuthTypedData(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId: web3Id,
    operation: web3Op,
    argsHashHex: argsHash,
  });
  const localTypedDigest = ethers.TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
  const signedWeb3Op = await h.signOperationForWeb3Auth(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId: web3Id,
    operation: web3Op,
    argsHashHex: argsHash,
    signer: evmSigner,
  });
  // The validator's own 0x1901‖domain‖struct preimage is the only authority on
  // the payload encoding: hashing it must reproduce the EIP-712 digest ethers
  // signed, or the SDK's typed-data builder has drifted from the contract.
  const payloadItem = await h.readAndDecode(chain, web3Auth.hash, "getSigningPayload", [
    h.hash160Param(web3Id),
    h.integerParam(web3ValidatorId),
    h.byteArrayParam(h.operationDigest(chain, core.hash, web3Id, web3Op)),
    operationParam(web3Op),
  ]);
  const chainPayload = stackBytesHex(payloadItem);
  assert(chainPayload.length === 132, `the validator payload is ${chainPayload.length / 2} bytes, expected 66`);
  assert(ethers.keccak256(`0x${chainPayload}`) === localTypedDigest, "the EIP-712 digest equals keccak256 of the validator payload");

  const web3Preview = await h.validateOperation(chain, sdk, web3Id, signedWeb3Op);
  assert(web3Preview.accepted === true, "the validator accepts the typed-data signature");
  const web3Exec = await h.executeOperation(chain, sdk, { accountId: web3Id, operation: signedWeb3Op });
  assert(h.stackText(web3Exec.appLog.executions[0].stack[0]) === "GAS", "Web3Auth-routed operation executed");

  const rogueWeb3Op = await routedOperation(sdk, web3Id, { validatorId: web3ValidatorId, descriptor: web3State });
  const rogueArgsHash = await h.operationArgsHash(chain, core.hash, rogueWeb3Op.args);
  const signedRogueWeb3 = await h.signOperationForWeb3Auth(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId: web3Id,
    operation: rogueWeb3Op,
    argsHashHex: rogueArgsHash,
    signer: rogueSigner,
  });
  const rogueWeb3Refusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: web3Id, operations: [signedRogueWeb3] }),
    /SA_VALIDATION_REJECTED/,
    "a secp256k1 key the validator does not hold",
  );
  console.log(JSON.stringify({
    accountId: h.normalizeHash(web3Id),
    validatorId: web3ValidatorId,
    credentialGeneration: web3Record.credentialGeneration,
    typedDataDigest: localTypedDigest,
    txid: web3Exec.txid,
    rogueWeb3Refusal,
  }, null, 2));

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  h.logSection("Summary");
  console.log(JSON.stringify({
    address: chain.account.address,
    coreHash: h.normalizeHash(core.hash),
    modules: {
      p256: h.normalizeHash(p256.hash),
      multiSig: h.normalizeHash(multiSig.hash),
      web3Auth: h.normalizeHash(web3Auth.hash),
      whitelist: h.normalizeHash(whitelist.hash),
      dailyLimit: h.normalizeHash(dailyLimit.hash),
    },
    accounts: {
      builtIn: h.normalizeHash(builtInId),
      p256: h.normalizeHash(p256Id),
      dailyLimit: h.normalizeHash(limitId),
      hookOrder: h.normalizeHash(orderId),
      recovery: h.normalizeHash(recoveryId),
      threshold: h.normalizeHash(thresholdId),
      web3Auth: h.normalizeHash(web3Id),
    },
    checks,
    txids: {
      builtIn: builtInExec.txid,
      p256: p256Exec.txid,
      threshold: thresholdExec.txid,
      web3Auth: web3Exec.txid,
      recoveryBegin: begin.txid,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
