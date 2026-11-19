#!/usr/bin/env node
/**
 * v4 testnet smoke runbook.
 *
 * The v3 smoke exercised one registration call that installed a verifier and a
 * hook in place and then mutated both through timelocked requests. Protocol v4
 * has no registration fields: an account is created from custody plus salt, and
 * modules enter through the action grammar — atomically at creation or through
 * the 24-hour configuration intent. This runbook therefore proves the same
 * ground on the v4 surface:
 *
 * 1. built-in route: a custody-only account signs the §4.3 operation digest
 *    with its custody key (§8 envelope), the target executes, and the nonce
 *    channel advances; replaying the same signed operation is refused;
 * 2. hook gating: a WhitelistHook installed at creation allows the configured
 *    target and refuses every other target before dispatch;
 * 3. validator routing: a Web3AuthValidator installed at creation turns the
 *    built-in route off (there is no custody fallback any more) and only its
 *    own secp256k1 signature over the EIP-712 payload authorizes an operation;
 * 4. recovery: beginRecovery records maturity, an early executeRecovery is
 *    refused, and cancelRecovery clears the record.
 *
 * Runbooks are not gates. They are not executed by `npm test`, and the v4 core
 * is not deployed to a public testnet yet, so this script is exercised only
 * against a local chain that already carries the v4 artifacts built by
 * `bash contracts/compile.sh`.
 */

const crypto = require("crypto");
const { CONST, wallet } = require("@cityofzion/neon-js");
const { ethers } = require("ethers");

const h = require("./testnet-v4-harness");

const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const NEO_HASH = CONST.NATIVE_CONTRACT_HASH.NeoToken;
const ZERO_HASH160 = "0".repeat(40);
const SALT_BYTES = 20;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function saltHex() {
  return crypto.randomBytes(SALT_BYTES).toString("hex");
}

function nonceRouting(descriptor, validatorId = "0") {
  return {
    validatorId,
    credentialGeneration: "1",
    authorityEpoch: descriptor.authorityEpoch,
    nonceSubkey: "00".repeat(32),
  };
}

/**
 * Reads a native token's symbol through the account. The operation is the v4
 * shape: 13 fields, a packed channel nonce and a validator-addressed
 * signature, so a HALT here proves the whole envelope, not just dispatch.
 */
async function tokenSymbol(chain, sdk, accountId, { validatorId = "0" } = {}) {
  const descriptor = await sdk.getAccount(accountId);
  const routing = nonceRouting(descriptor, validatorId);
  const nonce = await h.nextNonce(sdk, accountId, routing);
  return h.operation({
    targetContract: GAS_HASH,
    method: "symbol",
    nonce,
    validatorId,
    credentialGeneration: routing.credentialGeneration,
    authorityEpoch: routing.authorityEpoch,
    nonceSubkey: routing.nonceSubkey,
  });
}

async function main() {
  const chain = await h.connect();
  const address = chain.account.address;
  const custody = h.normalizeHash(chain.account.scriptHash);

  console.log(JSON.stringify({
    rpc: chain.rpcUrl,
    networkMagic: chain.networkMagic,
    runId: chain.runId,
    address,
    scriptHash: custody,
  }, null, 2));

  // -------------------------------------------------------------------------
  // Deployment: the core plus the two modules this runbook installs.
  // -------------------------------------------------------------------------

  h.logSection("Deploy Contracts");
  const core = await h.deployCore(chain);
  const web3Auth = await h.deployModule(chain, core.hash, "validators/Web3AuthValidator");
  const whitelist = await h.deployModule(chain, core.hash, "hooks/WhitelistHook");
  // v4 modules still bind to exactly one core; the difference from v3 is that
  // `deployModule` authorizes that binding and the core then learns the module
  // through an install action, not a registration field.
  console.log(JSON.stringify({ core, web3Auth, whitelist }, null, 2));

  const sdk = h.clientFor(chain, core.hash);
  const protocol = await sdk.getProtocolInfo();
  assert(protocol.protocolVersion === "4", `core reports protocol ${protocol.protocolVersion}, expected 4`);
  console.log(JSON.stringify({ protocol }, null, 2));

  // -------------------------------------------------------------------------
  // Scenario 1: custody-only account on the built-in route.
  // -------------------------------------------------------------------------

  h.logSection("Register Custody Account");
  const custodyAccount = await h.createAccount(chain, sdk, { custody: chain.account, salt: saltHex() });
  const custodyId = custodyAccount.accountId;
  const custodyState = await sdk.getAccount(custodyId);
  assert(String(custodyState.custodyAddress).toLowerCase().endsWith(h.sanitizeHex(custody)), "custody address did not bind to the registering wallet");
  assert(custodyState.defaultOperationAuthorization === true, "a fresh account must start with the built-in route enabled");
  assert(custodyState.recoveryPending === false, "a fresh account must not carry a pending recovery");
  console.log(JSON.stringify({
    txid: custodyAccount.txid,
    accountId: h.normalizeHash(custodyId),
    virtualAddress: custodyAccount.accountAddress,
    custody: custodyState.custodyAddress,
    recoveryTimelockMs: custodyState.recoveryTimelockMs,
    defaultOperationAuthorization: custodyState.defaultOperationAuthorization,
  }, null, 2));

  h.logSection("Built-In Route Operation");
  const builtInOp = await tokenSymbol(chain, sdk, custodyId);
  const signedBuiltInOp = h.signOperationWithCustody(chain, core.hash, {
    accountId: custodyId,
    operation: builtInOp,
  });
  // The preview and the execution must agree on the digest the custody key signed.
  const preview = await h.validateOperation(chain, sdk, custodyId, signedBuiltInOp);
  assert(preview.accepted === true, "the core rejected the custody-built signature");
  assert(
    preview.operationDigest === h.operationDigest(chain, core.hash, custodyId, signedBuiltInOp),
    "the core digest disagrees with the local v4 codec",
  );
  // Whatever the operation returns must be the GAS symbol, read as UTF-8.
  const builtInExec = await h.executeOperation(chain, sdk, { accountId: custodyId, operation: signedBuiltInOp });
  const builtInResult = h.stackText(builtInExec.appLog.executions[0].stack[0]);
  assert(builtInResult === "GAS", `built-in route returned ${builtInResult}, expected GAS`);
  const afterBuiltIn = await sdk.getNonce(custodyId, nonceRouting(custodyState));
  assert(BigInt(afterBuiltIn.sequence) === 1n, `nonce sequence should be 1 after one operation, got ${afterBuiltIn.sequence}`);
  console.log(JSON.stringify({
    txid: builtInExec.txid,
    result: builtInResult,
    operationDigest: preview.operationDigest,
    nonceChannel: afterBuiltIn.channel,
    nonceSequence: afterBuiltIn.sequence,
  }, null, 2));

  h.logSection("Nonce Replay Refused");
  const replayRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: custodyId, operations: [signedBuiltInOp] }),
    /SA_NONCE_INVALID|nonce/i,
    "replay of the consumed operation",
  );
  console.log(JSON.stringify({ replayRefusal }, null, 2));

  // -------------------------------------------------------------------------
  // Scenario 2: WhitelistHook installed at creation.
  // -------------------------------------------------------------------------

  h.logSection("Register Hook-Gated Account");
  const hookInstall = await h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: whitelist.hash,
    // onInstall takes the same ["allowTarget", target] command the v3 hook
    // applied through a timelocked maintenance request.
    initData: [h.codec.stringValue("allowTarget"), h.codec.hashValue(GAS_HASH)],
  });
  const hookAccount = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions: [hookInstall],
  });
  const hookId = hookAccount.accountId;
  const hookState = await sdk.getAccount(hookId);
  const hookModules = await h.moduleIds(sdk, hookId, h.HOOK_MODULE_TYPE);
  assert(hookModules.moduleIds.length === 1, `expected one installed hook, got ${hookModules.moduleIds.length}`);
  assert(hookState.defaultOperationAuthorization === true, "a hook alone must not disable the built-in route");
  const hookModuleId = hookModules.moduleIds[0];
  const hookRecord = await h.moduleState(sdk, hookId, hookModuleId);
  console.log(JSON.stringify({
    txid: hookAccount.txid,
    accountId: h.normalizeHash(hookId),
    hookModuleId,
    hookContract: hookRecord.contractHash,
    credentialGeneration: hookRecord.credentialGeneration,
    configurationNonce: hookModules.configurationNonce,
  }, null, 2));

  h.logSection("Hook Gate Allows The Configured Target");
  const allowedOp = await tokenSymbol(chain, sdk, hookId);
  const signedAllowedOp = h.signOperationWithCustody(chain, core.hash, { accountId: hookId, operation: allowedOp });
  const allowedExec = await h.executeOperation(chain, sdk, { accountId: hookId, operation: signedAllowedOp });
  const allowedResult = h.stackText(allowedExec.appLog.executions[0].stack[0]);
  assert(allowedResult === "GAS", `allowlisted target returned ${allowedResult}, expected GAS`);
  console.log(JSON.stringify({ txid: allowedExec.txid, result: allowedResult }, null, 2));

  h.logSection("Hook Gate Refuses Another Target");
  const hookStateAfter = await sdk.getAccount(hookId);
  const deniedNonce = await h.nextNonce(sdk, hookId, nonceRouting(hookStateAfter));
  const deniedOp = h.operation({
    targetContract: NEO_HASH,
    method: "symbol",
    nonce: deniedNonce,
    authorityEpoch: hookStateAfter.authorityEpoch,
  });
  const signedDeniedOp = h.signOperationWithCustody(chain, core.hash, { accountId: hookId, operation: deniedOp });
  const nonceBeforeDenial = await sdk.getNonce(hookId, nonceRouting(hookStateAfter));
  const hookRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: hookId, operations: [signedDeniedOp] }),
    /not in whitelist|SA_HOOK_REJECTED/i,
    "operation against a non-allowlisted target",
  );
  // The refused operation must not have consumed its nonce: a preflight refusal
  // is a simulation, so the channel still reports the same sequence.
  const nonceAfterDenial = await sdk.getNonce(hookId, nonceRouting(hookStateAfter));
  assert(
    nonceAfterDenial.sequence === nonceBeforeDenial.sequence,
    `refused operation moved the nonce ${nonceBeforeDenial.sequence} -> ${nonceAfterDenial.sequence}`,
  );
  console.log(JSON.stringify({
    hookRefusal,
    nonceSequence: nonceAfterDenial.sequence,
  }, null, 2));

  // -------------------------------------------------------------------------
  // Scenario 3: Web3AuthValidator installed at creation.
  // -------------------------------------------------------------------------

  h.logSection("Register Web3Auth Account");
  const evmSigner = ethers.Wallet.createRandom();
  const rogueSigner = ethers.Wallet.createRandom();
  // The validator stores the 33-byte compressed form; ethers hands both forms.
  const evmPubKey = h.sanitizeHex(evmSigner.signingKey.compressedPublicKey);
  const validatorInstall = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: web3Auth.hash,
    initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(evmPubKey)],
  });
  const web3AuthAccount = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions: [validatorInstall],
  });
  const web3AuthId = web3AuthAccount.accountId;
  const web3AuthState = await sdk.getAccount(web3AuthId);
  const validatorModules = await h.moduleIds(sdk, web3AuthId, h.VALIDATOR_MODULE_TYPE);
  assert(validatorModules.moduleIds.length === 1, `expected one installed validator, got ${validatorModules.moduleIds.length}`);
  // §3.5: the first validator install turns the built-in route off. There is
  // no implicit custody fallback, so the custody key alone can no longer move
  // this account — recovery is the only custody-only path left.
  assert(web3AuthState.defaultOperationAuthorization === false, "installing a validator must disable the built-in route");
  const validatorId = validatorModules.moduleIds[0];
  const validatorRecord = await h.moduleState(sdk, web3AuthId, validatorId);
  const installedKey = await h.readAndDecode(chain, web3Auth.hash, "getPublicKey", [
    h.hash160Param(web3AuthId),
    h.integerParam(validatorId),
  ]);
  assert(
    Buffer.from(installedKey.value || "", "base64").toString("hex").toUpperCase() === evmPubKey.toUpperCase(),
    "the validator did not store the compressed key of the configured signer",
  );
  console.log(JSON.stringify({
    txid: web3AuthAccount.txid,
    accountId: h.normalizeHash(web3AuthId),
    validatorId,
    validatorContract: validatorRecord.contractHash,
    credentialGeneration: validatorRecord.credentialGeneration,
    defaultOperationAuthorization: web3AuthState.defaultOperationAuthorization,
    storedPublicKey: Buffer.from(installedKey.value || "", "base64").toString("hex"),
  }, null, 2));

  h.logSection("Built-In Route Disabled");
  const legacyOp = await tokenSymbol(chain, sdk, web3AuthId);
  const signedLegacyOp = h.signOperationWithCustody(chain, core.hash, { accountId: web3AuthId, operation: legacyOp });
  const legacyRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: web3AuthId, operations: [signedLegacyOp] }),
    /SA_MODULE_NOT_ROUTABLE/,
    "custody-signed operation on an account whose built-in route is off",
  );
  console.log(JSON.stringify({ legacyRefusal }, null, 2));

  h.logSection("Web3Auth Validator Operation");
  const web3AuthNonce = await h.nextNonce(sdk, web3AuthId, nonceRouting(web3AuthState, validatorId));
  const validatorOp = h.operation({
    targetContract: GAS_HASH,
    method: "symbol",
    nonce: web3AuthNonce,
    validatorId,
    credentialGeneration: validatorRecord.credentialGeneration,
    authorityEpoch: web3AuthState.authorityEpoch,
  });
  const argsHash = await h.operationArgsHash(chain, core.hash, validatorOp.args);
  const signedValidatorOp = await h.signOperationForWeb3Auth(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId: web3AuthId,
    operation: validatorOp,
    argsHashHex: argsHash,
    signer: evmSigner,
  });
  const validatorPreview = await h.validateOperation(chain, sdk, web3AuthId, signedValidatorOp);
  assert(validatorPreview.accepted === true, "the validator rejected a valid EIP-712 signature");
  const validatorExec = await h.executeOperation(chain, sdk, { accountId: web3AuthId, operation: signedValidatorOp });
  const validatorResult = h.stackText(validatorExec.appLog.executions[0].stack[0]);
  assert(validatorResult === "GAS", `validator route returned ${validatorResult}, expected GAS`);
  console.log(JSON.stringify({
    txid: validatorExec.txid,
    result: validatorResult,
    operationDigest: validatorPreview.operationDigest,
    signatureBytes: signedValidatorOp.signature.length / 2,
  }, null, 2));

  h.logSection("Foreign Key Refused");
  const rogueNonce = await h.nextNonce(sdk, web3AuthId, nonceRouting(web3AuthState, validatorId));
  const rogueOp = h.operation({
    targetContract: GAS_HASH,
    method: "symbol",
    nonce: rogueNonce,
    validatorId,
    credentialGeneration: validatorRecord.credentialGeneration,
    authorityEpoch: web3AuthState.authorityEpoch,
  });
  const rogueArgsHash = await h.operationArgsHash(chain, core.hash, rogueOp.args);
  const signedRogueOp = await h.signOperationForWeb3Auth(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId: web3AuthId,
    operation: rogueOp,
    argsHashHex: rogueArgsHash,
    signer: rogueSigner,
  });
  const rogueRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId: web3AuthId, operations: [signedRogueOp] }),
    /SA_VALIDATION_REJECTED|validator rejected/i,
    "operation signed by a key the validator does not hold",
  );
  console.log(JSON.stringify({ rogueRefusal }, null, 2));

  // -------------------------------------------------------------------------
  // Scenario 4: core recovery.
  // -------------------------------------------------------------------------

  h.logSection("Recovery Flow");
  const recoveryAccount = await h.createAccount(chain, sdk, { custody: chain.account, salt: saltHex() });
  const recoveryId = recoveryAccount.accountId;
  const newCustody = new wallet.Account();
  const beginRecovery = await h.accountAction(chain, sdk, {
    accountId: recoveryId,
    method: "beginRecovery",
    args: [h.hash160Param(newCustody.scriptHash)],
    // A non-zero new custody is itself a signer of the request (§7).
    authorizers: [chain.account, newCustody],
  });
  const recoveryState = await sdk.getAccount(recoveryId);
  const recoveryStatus = await sdk.getRecoveryStatus(recoveryId);
  assert(recoveryState.recoveryPending === true, "beginRecovery did not mark the account");
  assert(recoveryStatus && recoveryStatus.pending === true, "getRecoveryStatus did not report the pending recovery");
  assert(
    BigInt(recoveryStatus.matureAt) > BigInt(Date.now()),
    `recovery should be immature, matureAt=${recoveryStatus.matureAt}`,
  );
  const earlyRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.accountActionPlan(sdk, { method: "executeRecovery", accountId: recoveryId, args: [] }),
    /SA_RECOVERY_LOCKED|SA_RECOVERY_PENDING|locked/i,
    "recovery executed before its maturity",
  );
  const cancelRecovery = await h.accountAction(chain, sdk, {
    accountId: recoveryId,
    method: "cancelRecovery",
    args: [],
    authorizers: [chain.account],
  });
  const afterCancel = await sdk.getRecoveryStatus(recoveryId);
  assert(!afterCancel || afterCancel.pending === false, "cancelRecovery left the record pending");
  console.log(JSON.stringify({
    accountId: h.normalizeHash(recoveryId),
    beginTxid: beginRecovery.txid,
    newCustody: newCustody.address,
    matureAt: recoveryStatus.matureAt,
    initiatedAt: recoveryStatus.initiatedAt,
    earlyRefusal,
    cancelTxid: cancelRecovery.txid,
    afterCancel,
  }, null, 2));

  // -------------------------------------------------------------------------
  // Summary — the last JSON object is what the validation suite reads.
  // -------------------------------------------------------------------------

  h.logSection("Summary");
  console.log(JSON.stringify({
    address,
    coreHash: h.normalizeHash(core.hash),
    web3AuthHash: h.normalizeHash(web3Auth.hash),
    whitelistHash: h.normalizeHash(whitelist.hash),
    accountId: h.normalizeHash(custodyId),
    virtualAddress: custodyAccount.accountAddress,
    custodyAccountId: h.normalizeHash(custodyId),
    hookAccountId: h.normalizeHash(hookId),
    web3AuthAccountId: h.normalizeHash(web3AuthId),
    recoveryAccountId: h.normalizeHash(recoveryId),
    txids: {
      createAccount: custodyAccount.txid,
      builtInExecute: builtInExec.txid,
      hookAccountCreate: hookAccount.txid,
      hookAllowedExecute: allowedExec.txid,
      web3AuthAccountCreate: web3AuthAccount.txid,
      validatorExecute: validatorExec.txid,
      beginRecovery: beginRecovery.txid,
      cancelRecovery: cancelRecovery.txid,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
