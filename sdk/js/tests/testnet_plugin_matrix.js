#!/usr/bin/env node
/**
 * v4 plugin matrix runbook: one scenario per deployed module.
 *
 * The v3 script of this name exercised every plugin through registration
 * fields, `callVerifier` and `callHook`. Protocol v4 deleted all three: a
 * module is an instance with an allocated id, its configuration is an
 * `onInstall`/`configure` callback, hook composition is the core-owned
 * `hookOrder` and a threshold is a core-owned policy naming member ids. The
 * matrix therefore keeps the same coverage — every validator, every hook, plus
 * the modules that exist only to be refused — and proves it on the v4 surface:
 *
 * validators
 *   p256                 standalone secp256r1 key, foreign key refused
 *   web3auth             EIP-712 typed data over the §4.3 digest
 *   tee                  `keyId ‖ r‖s` DTO bound to the enclave key
 *   session-key          grant-scoped transfer, spending cap, grant dies with
 *                        the credential generation
 *   multisig             a member key that only ever signs under a policy, and
 *                        the member digest the client and the module share
 *   subscription         merchant-witnessed pull, one charge per period
 *   neowitness           Neo N3 witness quorum over the transaction
 *   delegated-identity   identity commitment + per-action nullifier
 *   zkemail              disabled: the install action itself is refused
 * hooks
 *   daily-limit          per-token meter refuses an over-limit transfer
 *   whitelist-hook       target allowlist refuses everything else
 *   token-restricted     the restricted token is refused by effect
 *   neodid-hook          a required credential without a registry is refused
 *   multihook            retired: the install action itself is refused
 * composition
 *   threshold            a 2-of-2 policy over two instances, and the refusals
 *                        that make membership meaningful
 *   abi-negatives        modules without a bindable profile never install, and
 *                        a validator profile cannot be installed as a hook
 *
 * Each scenario installs its own accounts on one core, so a failure names the
 * module rather than the last screen of output. `SA_MATRIX_SCENARIOS` narrows
 * the run to a comma-separated subset (the report file is named after it).
 *
 * Runbooks are not gates: `npm test` does not run this, and the v4 core is not
 * deployed to a public testnet yet. It is exercised against a chain that
 * already carries the artifacts built by `bash contracts/compile.sh`, and the
 * mock token (`PolicyExecutionProbe`) is used wherever a scenario needs NEP-17
 * value movement without real GAS.
 *
 * Usage:
 *   TEST_WIF=Kx... node tests/testnet_plugin_matrix.js
 *   TEST_WIF=Kx... SA_MATRIX_SCENARIOS=session-key,subscription node tests/testnet_plugin_matrix.js
 */

const crypto = require("crypto");
const { CONST, wallet } = require("@cityofzion/neon-js");
const { ethers } = require("ethers");

const h = require("./testnet-v4-harness");

const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const SALT_BYTES = 20;
const ONE_HOUR_MS = 60 * 60 * 1000;
const SELECTED_SCENARIOS = new Set(
  String(process.env.SA_MATRIX_SCENARIOS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

let checks = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
  console.log(`  ok: ${message}`);
}

function shouldRunScenario(name) {
  return SELECTED_SCENARIOS.size === 0 || SELECTED_SCENARIOS.has(name);
}

function saltHex() {
  return crypto.randomBytes(SALT_BYTES).toString("hex");
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** A 32-byte digest over arbitrary text, so a scenario reads as what it means. */
function digestOf(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** A VM ByteString as hex: stack items arrive base64-encoded. */
function stackHex(item) {
  return Buffer.from(item?.value || "", "base64").toString("hex");
}

/** The 20-byte storage order of a UInt160, which is what an operation arg carries. */
function storageOrder(displayHex) {
  return h.sanitizeHex(displayHex).match(/../g).reverse().join("");
}

// ---------------------------------------------------------------------------
// Deployments: one instance per module, shared by the scenarios that need it
// ---------------------------------------------------------------------------

const deployed = {};

async function moduleNamed(chain, core, name) {
  if (!deployed[name]) {
    // Canonical manifest name: the core compares the profile's own
    // `contractName` with the deployed manifest name (§7.3).
    deployed[name] = await h.deployModule(chain, core.hash, name);
  }
  return deployed[name];
}

/** The adversarial NEP-17 token: arbitrary balances, arbitrary results. */
async function probeToken(chain) {
  if (!deployed.probe) {
    deployed.probe = await h.deployContract(chain, "PolicyExecutionProbe", `${chain.deploymentTag}-probe-token`);
  }
  return deployed.probe;
}

async function fundProbeToken(chain, token, address, amount) {
  await h.invokePersisted(chain, token.hash, "setBalance", [
    h.hash160Param(address),
    h.integerParam(String(amount)),
  ]);
}

// ---------------------------------------------------------------------------
// Operations: one 13-field envelope per call, nonce read from the channel
// ---------------------------------------------------------------------------

function nonceRouting(descriptor, validatorId = "0", credentialGeneration = "1") {
  return {
    validatorId,
    credentialGeneration,
    authorityEpoch: descriptor.authorityEpoch,
    nonceSubkey: "00".repeat(32),
  };
}

/**
 * A routed operation whose nonce and configuration nonce come from the account
 * the core reports, so a scenario never guesses either counter.
 */
async function routedOperation(sdk, accountId, {
  validatorId = "0",
  credentialGeneration = "1",
  descriptor,
  targetContract = GAS_HASH,
  method = "symbol",
  args = [],
  signature = "",
} = {}) {
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
    configurationNonce: state.configurationNonce,
    nonceSubkey: routing.nonceSubkey,
    signature,
  });
}

/** Broadcast one execution whose transaction carries extra witnesses. */
async function executeWithWitnesses(chain, sdk, { accountId, operation: op, authorizers = [], label }) {
  return h.sendPlan(chain, sdk, {
    ...h.executionPlan(sdk, { accountId, operation: op }),
    authorizers,
    label: label || `executeUserOp(${op.method})`,
  });
}

function refusalSpec(sdk, { accountId, operation: op, authorizers = [] }) {
  return { ...h.executionPlan(sdk, { accountId, operation: op }), authorizers };
}

// ---------------------------------------------------------------------------
// Signatures: one helper per validator family, each documented by its spec §5 DTO
// ---------------------------------------------------------------------------

/** A 64-byte `r‖s` over the core operation digest (standalone route). */
function sign64(chain, coreHash, { accountId, operation: op, key, moduleId }) {
  const digest = h.operationDigest(chain, coreHash, accountId, op);
  return {
    ...op,
    validatorId: String(moduleId),
    signature: wallet.sign(digest, key.privateKey),
  };
}

/** `keyId(32) ‖ r‖s(64)`, where `keyId = SHA256(compressedKey)`. */
function signTee(chain, coreHash, { accountId, operation: op, key, moduleId }) {
  const digest = h.operationDigest(chain, coreHash, accountId, op);
  const keyId = crypto.createHash("sha256").update(Buffer.from(key.publicKey, "hex")).digest("hex");
  return {
    ...op,
    validatorId: String(moduleId),
    signature: `${keyId}${wallet.sign(digest, key.privateKey)}`,
  };
}

/** `grantDigest(32) ‖ r‖s(64)`: the grant the instance holds, then the key's signature. */
function signSessionKey(chain, coreHash, { accountId, operation: op, key, moduleId, grantDigestHex }) {
  const digest = h.operationDigest(chain, coreHash, accountId, op);
  return {
    ...op,
    validatorId: String(moduleId),
    signature: `${grantDigestHex}${wallet.sign(digest, key.privateKey)}`,
  };
}

/** `0x01 ‖ U8(providerLength) ‖ provider ‖ master(32) ‖ action(32) ‖ r‖s(64)`. */
function signDelegated({ signingDigestHex, key, provider, masterNullifierHex, actionNullifierHex }) {
  const providerHex = Buffer.from(provider, "utf8").toString("hex");
  const providerBytes = providerHex.length / 2;
  if (providerBytes < 1 || providerBytes > 255) throw new Error(`provider ${provider} does not fit a U8 length prefix`);
  const prefix = providerBytes.toString(16).padStart(2, "0");
  const signature = wallet.sign(signingDigestHex, key.privateKey);
  return `01${prefix}${providerHex}${masterNullifierHex}${actionNullifierHex}${signature}`;
}

// ---------------------------------------------------------------------------
// Scenario context shared by every case
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.TEST_WIF && !process.env.NEO_TESTNET_WIF) {
    console.error("TEST_WIF or NEO_TESTNET_WIF is required.");
    process.exit(1);
  }

  const chain = await h.connect();
  const results = {
    env: {
      rpc: chain.rpcUrl,
      networkMagic: chain.networkMagic,
      runId: chain.runId,
      address: chain.account.address,
      scriptHash: h.normalizeHash(chain.account.scriptHash),
      selectedScenarios: Array.from(SELECTED_SCENARIOS),
    },
    deployments: {},
    matrix: {},
  };

  console.log(JSON.stringify(results.env, null, 2));

  h.logSection("Deploy core");
  const core = await h.deployCore(chain);
  const sdk = h.clientFor(chain, core.hash);
  const protocol = await sdk.getProtocolInfo();
  assert(protocol.protocolVersion === "4", `core reports protocol ${protocol.protocolVersion}`);
  results.deployments.core = { hash: h.normalizeHash(core.hash), txid: core.txid };
  console.log(JSON.stringify(results.deployments.core, null, 2));

  const context = { chain, core, sdk, results, custody: chain.account };
  const scenarios = [
    ["p256", scenarioP256],
    ["web3auth", scenarioWeb3Auth],
    ["tee", scenarioTee],
    ["session-key", scenarioSessionKey],
    ["multisig", scenarioMultiSig],
    ["subscription", scenarioSubscription],
    ["neowitness", scenarioNeoWitness],
    ["delegated-identity", scenarioDelegatedIdentity],
    ["zkemail", scenarioZKEmail],
    ["daily-limit", scenarioDailyLimit],
    ["whitelist-hook", scenarioWhitelistHook],
    ["token-restricted", scenarioTokenRestricted],
    ["neodid-hook", scenarioNeoDidHook],
    ["multihook", scenarioMultiHook],
    ["threshold", scenarioThreshold],
    ["abi-negatives", scenarioAbiNegatives],
  ];

  const failures = [];
  for (const [name, run] of scenarios) {
    if (!shouldRunScenario(name)) continue;
    h.logSection(name);
    try {
      results.matrix[name] = { status: "passed", ...(await run(context)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.matrix[name] = { status: "failed", error: message };
      failures.push(`${name}: ${message}`);
      console.error(`  FAILED ${name}: ${message}`);
      if (error instanceof Error && error.stack) console.error(error.stack);
    }
  }

  results.deployments.modules = Object.fromEntries(
    Object.entries(deployed).map(([name, contract]) => [name, h.normalizeHash(contract.hash)]),
  );
  results.checks = checks;
  results.failures = failures;

  const reportName = SELECTED_SCENARIOS.size
    ? `sa-testnet-plugin-matrix.${Array.from(SELECTED_SCENARIOS).join("_")}.json`
    : "sa-testnet-plugin-matrix.latest.json";
  const reportPath = await h.writeReport(reportName, results);

  h.logSection("Summary");
  console.log(JSON.stringify({
    reportPath,
    checks,
    scenarios: Object.fromEntries(
      Object.entries(results.matrix).map(([name, item]) => [name, item.status]),
    ),
    failures,
  }, null, 2));

  if (failures.length > 0) {
    throw new Error(`${failures.length} scenario(s) failed: ${failures.join("; ")}`);
  }
}

/** A key and its hex public key, the shape every P-256 validator installs. */
function p256Key() {
  const account = new wallet.Account();
  return { account, publicKeyHex: h.sanitizeHex(account.publicKey) };
}

/** A fresh validator-routed account, plus the ids a scenario needs. */
async function validatorAccount(chain, sdk, actions, label) {
  const created = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions,
  });
  const state = await sdk.getAccount(created.accountId);
  const validatorIds = (await h.moduleIds(sdk, created.accountId, h.VALIDATOR_MODULE_TYPE)).moduleIds;
  assert(validatorIds.length >= 1, `${label}: expected a validator instance, got ${validatorIds.length}`);
  return { accountId: created.accountId, state, validatorId: validatorIds[0], txid: created.txid };
}

async function installValidator(chain, moduleHash, publicKeyHex, command = "setPublicKey") {
  return h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash,
    initData: [h.codec.stringValue(command), h.codec.byteStringValue(publicKeyHex)],
  });
}

/**
 * The capability flags the core recorded come from the module's own canonical
 * profile, never from the installer, so reading them back proves the deployed
 * profile and the core's record agree.
 */
async function assertCapabilities(sdk, accountId, moduleId, expected, label) {
  const record = await h.moduleState(sdk, accountId, moduleId);
  assert(
    record.instanceIsolation === expected.instanceIsolation,
    `${label}: instanceIsolation is ${record.instanceIsolation}`,
  );
  assert(
    record.thresholdMemberEligible === expected.thresholdMemberEligible,
    `${label}: thresholdMemberEligible is ${record.thresholdMemberEligible}`,
  );
  assert(
    record.messageCapability === Boolean(expected.messageCapability),
    `${label}: messageCapability is ${record.messageCapability}`,
  );
  return record;
}

// ---------------------------------------------------------------------------
// p256: the baseline standalone validator
// ---------------------------------------------------------------------------

async function scenarioP256({ chain, core, sdk }) {
  const p256 = await moduleNamed(chain, core, "validators/P256Validator");
  const { account, publicKeyHex } = p256Key();
  const rogue = p256Key();
  const routed = await validatorAccount(chain, sdk, [await installValidator(chain, p256.hash, publicKeyHex)], "p256");
  assert(routed.state.defaultOperationAuthorization === false, "the first validator install turns the built-in route off");
  const record = await assertCapabilities(sdk, routed.accountId, routed.validatorId, {
    instanceIsolation: false,
    thresholdMemberEligible: true,
    messageCapability: false,
  }, "p256");
  assert(record.credentialGeneration === "1", `a fresh instance starts at generation ${record.credentialGeneration}`);
  const stored = stackHex(await h.readAndDecode(chain, p256.hash, "getPublicKey", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
  ]));
  assert(stored.toUpperCase() === publicKeyHex.toUpperCase(), "the instance stores the installed P-256 key");

  const op = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
  });
  const signed = sign64(chain, core.hash, {
    accountId: routed.accountId,
    operation: op,
    key: account,
    moduleId: routed.validatorId,
  });
  const preview = await h.validateOperation(chain, sdk, routed.accountId, signed);
  assert(preview.accepted === true, "the instance accepts its own key");
  const executed = await h.executeOperation(chain, sdk, { accountId: routed.accountId, operation: signed });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "GAS", "P256-routed operation executed");

  const rogueOp = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
  });
  const rogueSigned = sign64(chain, core.hash, {
    accountId: routed.accountId,
    operation: rogueOp,
    key: rogue.account,
    moduleId: routed.validatorId,
  });
  const rogueRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId: routed.accountId, operation: rogueSigned }),
    /SA_VALIDATION_REJECTED/,
    "a key the instance does not hold",
  );
  return { accountId: h.normalizeHash(routed.accountId), moduleId: routed.validatorId, txid: executed.txid, rogueRefusal };
}

// ---------------------------------------------------------------------------
// web3auth: EIP-712 typed data over the §4.3 digest
// ---------------------------------------------------------------------------

async function scenarioWeb3Auth({ chain, core, sdk }) {
  const web3Auth = await moduleNamed(chain, core, "validators/Web3AuthValidator");
  const signer = ethers.Wallet.createRandom();
  const rogueSigner = ethers.Wallet.createRandom();
  const publicKeyHex = h.sanitizeHex(signer.signingKey.compressedPublicKey);
  const routed = await validatorAccount(chain, sdk, [await installValidator(chain, web3Auth.hash, publicKeyHex)], "web3auth");
  // This is the one module that publishes `isValidSignature`, so the core must
  // record the message capability it read from that module's profile.
  await assertCapabilities(sdk, routed.accountId, routed.validatorId, {
    instanceIsolation: false,
    thresholdMemberEligible: true,
    messageCapability: true,
  }, "web3auth");
  const stored = stackHex(await h.readAndDecode(chain, web3Auth.hash, "getPublicKey", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
  ]));
  assert(stored.toUpperCase() === publicKeyHex.toUpperCase(), "the instance stores the installed secp256k1 key");

  const op = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
  });
  const argsHashHex = await h.operationArgsHash(chain, core.hash, op.args);
  const typed = h.web3AuthTypedData(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId: routed.accountId,
    operation: op,
    argsHashHex,
  });
  const localDigest = ethers.TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
  const signed = await h.signOperationForWeb3Auth(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId: routed.accountId,
    operation: op,
    argsHashHex,
    signer,
  });
  // The validator's own payload is the only authority on the encoding: the
  // chain hashes those 66 bytes with Keccak-256, so keccak(payload) must be
  // the EIP-712 digest the wallet signed.
  const payload = stackHex(await h.readAndDecode(chain, web3Auth.hash, "getSigningPayload", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
    h.byteArrayParam(h.operationDigest(chain, core.hash, routed.accountId, op)),
    h.operationParam(op),
  ]));
  assert(payload.length === 66 * 2, `the signing payload is ${payload.length / 2} bytes, expected 66`);
  assert(ethers.keccak256(`0x${payload}`) === localDigest, "the EIP-712 digest is keccak256 of the validator payload");
  const executed = await h.executeOperation(chain, sdk, { accountId: routed.accountId, operation: signed });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "GAS", "Web3Auth-routed operation executed");

  const rogueOp = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
  });
  const rogueArgsHash = await h.operationArgsHash(chain, core.hash, rogueOp.args);
  const rogueSigned = await h.signOperationForWeb3Auth(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId: routed.accountId,
    operation: rogueOp,
    argsHashHex: rogueArgsHash,
    signer: rogueSigner,
  });
  const rogueRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId: routed.accountId, operation: rogueSigned }),
    /SA_VALIDATION_REJECTED/,
    "a secp256k1 key the validator does not hold",
  );
  return {
    accountId: h.normalizeHash(routed.accountId),
    validatorId: routed.validatorId,
    typedDataDigest: localDigest,
    txid: executed.txid,
    rogueRefusal,
  };
}

// ---------------------------------------------------------------------------
// tee: the enclave-key DTO, bound to SHA256(compressedKey)
// ---------------------------------------------------------------------------

async function scenarioTee({ chain, core, sdk }) {
  const tee = await moduleNamed(chain, core, "validators/TeeKeyValidator");
  const { account, publicKeyHex } = p256Key();
  const foreign = p256Key();
  const routed = await validatorAccount(chain, sdk, [await installValidator(chain, tee.hash, publicKeyHex)], "tee");
  const record = await assertCapabilities(sdk, routed.accountId, routed.validatorId, {
    instanceIsolation: false,
    thresholdMemberEligible: true,
  }, "tee");
  const keyId = stackHex(await h.readAndDecode(chain, tee.hash, "getKeyId", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
  ]));
  assert(
    keyId === crypto.createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex"),
    "the instance publishes SHA256 of its configured key as the key id",
  );

  const op = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
  });
  const signed = signTee(chain, core.hash, {
    accountId: routed.accountId,
    operation: op,
    key: account,
    moduleId: routed.validatorId,
  });
  const preview = await h.validateOperation(chain, sdk, routed.accountId, signed);
  assert(preview.accepted === true, "the instance accepts keyId ‖ r‖s from its key");
  const executed = await h.executeOperation(chain, sdk, { accountId: routed.accountId, operation: signed });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "GAS", "TeeKey-routed operation executed");

  // A valid signature under a foreign key, prefixed with THIS instance's key id:
  // the keyId check must reject it before the signature is even examined.
  const spoofOp = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
  });
  const spoofDigest = h.operationDigest(chain, core.hash, routed.accountId, spoofOp);
  const spoofed = {
    ...spoofOp,
    validatorId: String(routed.validatorId),
    signature: `${keyId}${wallet.sign(spoofDigest, foreign.account.privateKey)}`,
  };
  const spoofRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId: routed.accountId, operation: spoofed }),
    /SA_VALIDATION_REJECTED/,
    "a signature that does not belong to the configured key",
  );
  return {
    accountId: h.normalizeHash(routed.accountId),
    validatorId: routed.validatorId,
    keyId,
    credentialGeneration: record.credentialGeneration,
    txid: executed.txid,
    spoofRefusal,
  };
}

// ---------------------------------------------------------------------------
// session-key: grant scope, spending cap, and death by credential generation
// ---------------------------------------------------------------------------

async function scenarioSessionKey({ chain, core, sdk }) {
  const session = await moduleNamed(chain, core, "validators/SessionKeyValidator");
  const token = await probeToken(chain);
  const { account, publicKeyHex } = p256Key();
  const salt = saltHex();
  const validUntil = String(Date.now() + ONE_HOUR_MS);
  const spendingLimit = 1000;
  const grant = h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: session.hash,
    initData: [
      h.codec.stringValue("setSessionKey"),
      h.codec.byteStringValue(publicKeyHex),
      h.codec.hashValue(token.hash),
      h.codec.stringValue("transfer"),
      h.codec.integerValue(validUntil),
      h.codec.integerValue(String(spendingLimit)),
      h.codec.stringValue("matrix session key"),
    ],
  });
  const created = await h.createAccount(chain, sdk, { custody: chain.account, salt, actions: [await grant] });
  const accountId = created.accountId;
  const state = await sdk.getAccount(accountId);
  const validatorId = (await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE)).moduleIds[0];
  const record = await assertCapabilities(sdk, accountId, validatorId, {
    instanceIsolation: true,
    thresholdMemberEligible: false,
  }, "session-key");

  const storedGrant = await h.readAndDecode(chain, session.hash, "getSessionKey", [
    h.hash160Param(accountId),
    h.integerParam(validatorId),
  ]);
  assert(storedGrant?.value?.length === 7, `the grant is ${storedGrant?.value?.length} fields, expected 7`);
  const grantDigestHex = stackHex(await h.readAndDecode(chain, session.hash, "getGrantDigest", [
    h.hash160Param(accountId),
    h.integerParam(validatorId),
  ]));
  assert(grantDigestHex.length === 64, `the grant digest is ${grantDigestHex.length / 2} bytes, expected 32`);
  assert(
    h.decodeInteger(storedGrant.value[4]) === String(spendingLimit),
    `the grant caps spending at ${h.decodeInteger(storedGrant.value[4])}`,
  );

  const proxyHash = await sdk.getProxyScriptHash(accountId);
  await fundProbeToken(chain, token, proxyHash, 10_000);
  const recipient = storageOrder(new wallet.Account().scriptHash);

  const transferOp = async () => {
    const fresh = await sdk.getAccount(accountId);
    return routedOperation(sdk, accountId, {
      validatorId,
      credentialGeneration: record.credentialGeneration,
      descriptor: fresh,
      targetContract: token.hash,
      method: "transfer",
      args: [
        h.codec.hashValue(proxyHash),
        { type: "ByteString", value: recipient },
        h.codec.integerValue("400"),
        {
          type: "Array",
          value: [h.codec.integerValue("400"), { type: "Boolean", value: true }],
        },
      ],
    });
  };

  const first = signSessionKey(chain, core.hash, {
    accountId,
    operation: await transferOp(),
    key: account,
    moduleId: validatorId,
    grantDigestHex,
  });
  const firstExec = await h.executeOperation(chain, sdk, { accountId, operation: first });
  assert(h.stackText(firstExec.appLog.executions[0].stack[0]) === "true", "the grant executed its scoped transfer");
  const spentAfterFirst = h.decodeInteger(await h.readAndDecode(chain, session.hash, "getSpentAmount", [
    h.hash160Param(accountId),
    h.integerParam(validatorId),
  ]));
  assert(spentAfterFirst === "400", `completion booked the spend: ${spentAfterFirst}`);

  const second = signSessionKey(chain, core.hash, {
    accountId,
    operation: await transferOp(),
    key: account,
    moduleId: validatorId,
    grantDigestHex,
  });
  await h.executeOperation(chain, sdk, { accountId, operation: second });
  const spentAfterSecond = h.decodeInteger(await h.readAndDecode(chain, session.hash, "getSpentAmount", [
    h.hash160Param(accountId),
    h.integerParam(validatorId),
  ]));
  assert(spentAfterSecond === "800", `the second transfer booked cumulative spend ${spentAfterSecond}`);

  const overCap = signSessionKey(chain, core.hash, {
    accountId,
    operation: await transferOp(),
    key: account,
    moduleId: validatorId,
    grantDigestHex,
  });
  const capRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId, operation: overCap }),
    /SA_VALIDATION_REJECTED/,
    "a transfer that would exceed the grant's spending cap",
  );

  // Outside the grant's scope: the same key, a method the grant never named.
  const outOfScopeOp = await routedOperation(sdk, accountId, {
    validatorId,
    credentialGeneration: record.credentialGeneration,
    targetContract: token.hash,
    method: "balanceOf",
    args: [h.codec.hashValue(proxyHash)],
  });
  const outOfScope = signSessionKey(chain, core.hash, {
    accountId,
    operation: outOfScopeOp,
    key: account,
    moduleId: validatorId,
    grantDigestHex,
  });
  const scopeRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId, operation: outOfScope }),
    /SA_VALIDATION_REJECTED/,
    "a method outside the grant's scope",
  );

  // revokeCredentials bumps the instance generation; the stored grant was
  // issued under generation 1 and must stop validating immediately.
  await h.accountAction(chain, sdk, {
    accountId,
    method: "revokeCredentials",
    args: [h.integerParam(validatorId)],
    authorizers: [chain.account],
  });
  const revokedState = await sdk.getAccount(accountId);
  const revokedRecord = await h.moduleState(sdk, accountId, validatorId);
  assert(revokedRecord.credentialGeneration === "2", `revocation bumped the generation to ${revokedRecord.credentialGeneration}`);
  const afterRevoke = signSessionKey(chain, core.hash, {
    accountId,
    operation: await routedOperation(sdk, accountId, {
      validatorId,
      credentialGeneration: revokedRecord.credentialGeneration,
      descriptor: revokedState,
      targetContract: token.hash,
      method: "transfer",
      args: [
        h.codec.hashValue(proxyHash),
        { type: "ByteString", value: recipient },
        h.codec.integerValue("1"),
        { type: "Array", value: [h.codec.integerValue("1"), { type: "Boolean", value: true }] },
      ],
    }),
    key: account,
    moduleId: validatorId,
    grantDigestHex,
  });
  const revokeRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId, operation: afterRevoke }),
    /SA_VALIDATION_REJECTED/,
    "the grant after its credential generation was revoked",
  );
  return {
    accountId: h.normalizeHash(accountId),
    validatorId,
    grantDigest: grantDigestHex,
    spent: spentAfterSecond,
    txid: firstExec.txid,
    capRefusal,
    scopeRefusal,
    revokeRefusal,
  };
}

// ---------------------------------------------------------------------------
// multisig: a member key that only ever signs as a policy member
// ---------------------------------------------------------------------------

async function scenarioMultiSig({ chain, core, sdk }) {
  const multiSig = await moduleNamed(chain, core, "validators/MultiSigValidator");
  const member = p256Key();
  const routed = await validatorAccount(chain, sdk, [
    await installValidator(chain, multiSig.hash, member.publicKeyHex, "setMemberKey"),
  ], "multisig");
  // `instanceIsolation` is what tells the core this instance may not share a
  // credential with another instance of the same module.
  await assertCapabilities(sdk, routed.accountId, routed.validatorId, {
    instanceIsolation: true,
    thresholdMemberEligible: true,
    messageCapability: false,
  }, "multisig");
  const stored = stackHex(await h.readAndDecode(chain, multiSig.hash, "getMemberKey", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
  ]));
  assert(stored.toUpperCase() === member.publicKeyHex.toUpperCase(), "the instance stores the installed member key");

  // The member digest is the threshold-domain hash the contract computes; the
  // client owns the same encoding, so the two must agree byte for byte.
  const op = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
  });
  const operationDigestHex = h.operationDigest(chain, core.hash, routed.accountId, op);
  const chainMemberDigest = stackHex(await h.readAndDecode(chain, multiSig.hash, "getMemberDigest", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
    h.byteArrayParam(operationDigestHex),
  ]));
  assert(
    chainMemberDigest === h.codec.thresholdMemberDigest(operationDigestHex, routed.validatorId, "1"),
    "the contract's member digest equals the client's threshold encoding",
  );

  // This module is a policy member or nothing: routed to itself it approves
  // no operation, which is what keeps a bare MultiSig instance from becoming
  // an unthrottled single-key route.
  const standalone = sign64(chain, core.hash, {
    accountId: routed.accountId,
    operation: op,
    key: member.account,
    moduleId: routed.validatorId,
  });
  const standaloneRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId: routed.accountId, operation: standalone }),
    /SA_VALIDATION_REJECTED/,
    "a MultiSig instance routed as the standalone validator",
  );
  return {
    accountId: h.normalizeHash(routed.accountId),
    validatorId: routed.validatorId,
    memberDigest: chainMemberDigest,
    standaloneRefusal,
  };
}

// ---------------------------------------------------------------------------
// subscription: a merchant-witnessed pull, once per billing period
// ---------------------------------------------------------------------------

async function scenarioSubscription({ chain, core, sdk }) {
  const subscription = await moduleNamed(chain, core, "validators/SubscriptionValidator");
  const token = await probeToken(chain);
  const merchant = new wallet.Account();
  const subIdHex = Buffer.from("matrix-sub-1", "utf8").toString("hex");
  const amount = 500;
  const periodSeconds = 3600;
  const install = h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: subscription.hash,
    initData: [
      h.codec.stringValue("createSubscription"),
      h.codec.byteStringValue(subIdHex),
      h.codec.hashValue(merchant.scriptHash),
      h.codec.hashValue(token.hash),
      h.codec.integerValue(String(amount)),
      h.codec.integerValue(String(periodSeconds)),
    ],
  });
  const created = await h.createAccount(chain, sdk, { custody: chain.account, salt: saltHex(), actions: [await install] });
  const accountId = created.accountId;
  const validatorId = (await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE)).moduleIds[0];
  const record = await assertCapabilities(sdk, accountId, validatorId, {
    instanceIsolation: false,
    thresholdMemberEligible: false,
  }, "subscription");

  const stored = await h.readAndDecode(chain, subscription.hash, "getSubscription", [
    h.hash160Param(accountId),
    h.integerParam(validatorId),
    h.byteArrayParam(subIdHex),
  ]);
  assert(stored?.value?.length === 6, `the subscription record is ${stored?.value?.length} fields, expected 6`);
  assert(h.decodeInteger(stored.value[2]) === String(amount), `the subscription charges ${h.decodeInteger(stored.value[2])}`);
  assert(h.decodeInteger(stored.value[3]) === String(periodSeconds), `the billing period is ${h.decodeInteger(stored.value[3])}s`);
  assert(
    stackHex(stored.value[0]) === storageOrder(merchant.scriptHash),
    "the subscription names the merchant that may collect",
  );

  const proxyHash = await sdk.getProxyScriptHash(accountId);
  await fundProbeToken(chain, token, proxyHash, 10_000);

  const pullOperation = async () => {
    const fresh = await sdk.getAccount(accountId);
    return routedOperation(sdk, accountId, {
      validatorId,
      credentialGeneration: record.credentialGeneration,
      descriptor: fresh,
      targetContract: token.hash,
      method: "transfer",
      args: [
        h.codec.hashValue(proxyHash),
        h.codec.hashValue(merchant.scriptHash),
        h.codec.integerValue(String(amount)),
        {
          type: "Array",
          value: [h.codec.integerValue(String(amount)), { type: "Boolean", value: true }],
        },
      ],
      // The subscription id is the signature field: it names the record, not a proof.
      signature: subIdHex,
    });
  };

  const pull = await pullOperation();
  const pulled = await executeWithWitnesses(chain, sdk, {
    accountId,
    operation: pull,
    authorizers: [merchant],
  });
  assert(h.stackText(pulled.appLog.executions[0].stack[0]) === "true", "the merchant-witnessed pull transferred");
  const bookedPeriod = h.decodeInteger(await h.readAndDecode(chain, subscription.hash, "getLastChargedPeriod", [
    h.hash160Param(accountId),
    h.integerParam(validatorId),
    h.byteArrayParam(subIdHex),
  ]));
  assert(BigInt(bookedPeriod) > 0n, `completion booked billing period ${bookedPeriod}`);

  const secondPull = await pullOperation();
  const repeatRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId, operation: secondPull, authorizers: [merchant] }),
    /SA_VALIDATION_REJECTED/,
    "a second pull inside the same billing period",
  );

  // Without the merchant's witness the pull is unauthorized: the subId in the
  // signature field is public and must never be sufficient on its own.
  const unwitnessed = await pullOperation();
  const witnessRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId, operation: unwitnessed }),
    /SA_VALIDATION_REJECTED/,
    "a pull whose merchant did not witness the transaction",
  );
  return {
    accountId: h.normalizeHash(accountId),
    validatorId,
    subId: `0x${subIdHex}`,
    merchant: merchant.address,
    bookedPeriod,
    txid: pulled.txid,
    repeatRefusal,
    witnessRefusal,
  };
}

// ---------------------------------------------------------------------------
// neowitness: the quorum is the transaction's witness set
// ---------------------------------------------------------------------------

async function scenarioNeoWitness({ chain, core, sdk }) {
  const neoWitness = await moduleNamed(chain, core, "validators/NeoWitnessValidator");
  const second = new wallet.Account();
  const quorumInstall = h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: neoWitness.hash,
    initData: [
      h.codec.stringValue("setSigners"),
      {
        type: "Array",
        value: [h.codec.hashValue(chain.account.scriptHash), h.codec.hashValue(second.scriptHash)],
      },
      h.codec.integerValue("2"),
    ],
  });
  const routed = await validatorAccount(chain, sdk, [await quorumInstall], "neowitness");
  const threshold = h.decodeInteger(await h.readAndDecode(chain, neoWitness.hash, "getThreshold", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
  ]));
  assert(threshold === "2", `the instance requires ${threshold} of 2 witnesses`);

  // Field 11 is not interpreted by this validator, but the envelope still
  // requires a non-empty signature slot.
  const op = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
    signature: "00",
  });
  const executed = await executeWithWitnesses(chain, sdk, {
    accountId: routed.accountId,
    operation: op,
    authorizers: [second],
  });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "GAS", "both witnesses carried the operation");

  // A second account whose quorum names two keys that are not the fee payer:
  // one witness is not enough.
  const third = new wallet.Account();
  const strictInstall = h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: neoWitness.hash,
    initData: [
      h.codec.stringValue("setSigners"),
      {
        type: "Array",
        value: [h.codec.hashValue(second.scriptHash), h.codec.hashValue(third.scriptHash)],
      },
      h.codec.integerValue("2"),
    ],
  });
  const strict = await validatorAccount(chain, sdk, [await strictInstall], "neowitness-strict");
  const shortOp = await routedOperation(sdk, strict.accountId, {
    validatorId: strict.validatorId,
    descriptor: strict.state,
    signature: "00",
  });
  const quorumRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId: strict.accountId, operation: shortOp, authorizers: [second] }),
    /SA_VALIDATION_REJECTED/,
    "one witness against a 2-of-2 quorum",
  );
  return {
    accountId: h.normalizeHash(routed.accountId),
    validatorId: routed.validatorId,
    threshold,
    txid: executed.txid,
    quorumRefusal,
  };
}

// ---------------------------------------------------------------------------
// delegated-identity: identity commitment plus a per-action nullifier
// ---------------------------------------------------------------------------

async function scenarioDelegatedIdentity({ chain, core, sdk }) {
  const delegated = await moduleNamed(chain, core, "validators/DelegatedIdentityValidator");
  const { account, publicKeyHex } = p256Key();
  const provider = "google";
  const masterNullifierHex = digestOf("matrix-master-nullifier");
  const actionNullifierHex = digestOf("matrix-action-1");
  const install = h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: delegated.hash,
    initData: [
      h.codec.stringValue("setConfig"),
      h.codec.byteStringValue(publicKeyHex),
      h.codec.stringValue(provider),
      h.codec.byteStringValue(masterNullifierHex),
    ],
  });
  const routed = await validatorAccount(chain, sdk, [await install], "delegated-identity");
  const storedProvider = h.stackText(await h.readAndDecode(chain, delegated.hash, "getProvider", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
  ]));
  assert(storedProvider === provider, `the instance requires provider ${storedProvider}`);
  assert(
    stackHex(await h.readAndDecode(chain, delegated.hash, "getMasterNullifier", [
      h.hash160Param(routed.accountId),
      h.integerParam(routed.validatorId),
    ])) === masterNullifierHex,
    "the instance pins the master nullifier",
  );

  const op = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
  });
  const operationDigestHex = h.operationDigest(chain, core.hash, routed.accountId, op);
  // The instance derives the digest the delegated signer must sign, so the
  // proof is built from the chain's answer rather than a local re-implementation.
  const signingDigestHex = stackHex(await h.readAndDecode(chain, delegated.hash, "getSigningDigest", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
    h.byteArrayParam(operationDigestHex),
    h.byteArrayParam(actionNullifierHex),
  ]));
  assert(signingDigestHex.length === 64, `the delegated signing digest is ${signingDigestHex.length / 2} bytes`);
  const proof = signDelegated({
    signingDigestHex,
    key: account,
    provider,
    masterNullifierHex,
    actionNullifierHex,
  });
  assert(
    proof.length / 2 === 2 + provider.length + 32 + 32 + 64,
    `the proof is ${proof.length / 2} bytes, expected ${2 + provider.length + 32 + 32 + 64}`,
  );
  const signed = { ...op, validatorId: String(routed.validatorId), signature: proof };
  const preview = await h.validateOperation(chain, sdk, routed.accountId, signed);
  assert(preview.accepted === true, "the instance accepts a proof carrying its own identity commitment");
  const executed = await h.executeOperation(chain, sdk, { accountId: routed.accountId, operation: signed });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "GAS", "delegated-identity-routed operation executed");

  // A proof that presents a different master nullifier fails the commitment
  // comparison even though the signature over its own preimage is valid.
  const foreignOp = await routedOperation(sdk, routed.accountId, {
    validatorId: routed.validatorId,
    descriptor: routed.state,
  });
  const foreignDigest = h.operationDigest(chain, core.hash, routed.accountId, foreignOp);
  const foreignSigningDigest = stackHex(await h.readAndDecode(chain, delegated.hash, "getSigningDigest", [
    h.hash160Param(routed.accountId),
    h.integerParam(routed.validatorId),
    h.byteArrayParam(foreignDigest),
    h.byteArrayParam(digestOf("matrix-action-2")),
  ]));
  const foreign = {
    ...foreignOp,
    validatorId: String(routed.validatorId),
    signature: signDelegated({
      signingDigestHex: foreignSigningDigest,
      key: account,
      provider,
      masterNullifierHex: digestOf("another-master-nullifier"),
      actionNullifierHex: digestOf("matrix-action-2"),
    }),
  };
  const commitmentRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId: routed.accountId, operation: foreign }),
    /SA_VALIDATION_REJECTED/,
    "a proof presenting a master nullifier the instance does not hold",
  );
  return {
    accountId: h.normalizeHash(routed.accountId),
    validatorId: routed.validatorId,
    provider,
    txid: executed.txid,
    commitmentRefusal,
  };
}

// ---------------------------------------------------------------------------
// zkemail: the module refuses to be installed at all
// ---------------------------------------------------------------------------

async function scenarioZKEmail({ chain, core, sdk }) {
  const zkEmail = await moduleNamed(chain, core, "validators/ZKEmailVerifier");
  const install = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: zkEmail.hash,
  });
  const salt = saltHex();
  const refusal = await h.expectRefusal(
    chain,
    sdk,
    {
      ...h.registrationPlan(sdk, {
        custodyAddress: chain.account.scriptHash,
        salt,
        recoveryTimelockMs: h.REGISTRATION_RECOVERY_TIMELOCK_MS,
        actions: [install],
      }),
      authorizers: [chain.account],
    },
    /ZKEmailVerifier disabled/,
    "installing the disabled zkEmail validator",
  );
  return { module: h.normalizeHash(zkEmail.hash), installRefusal: refusal };
}

// ---------------------------------------------------------------------------
// daily-limit: a per-token meter over realized outflow
// ---------------------------------------------------------------------------

async function scenarioDailyLimit({ chain, core, sdk }) {
  const p256 = await moduleNamed(chain, core, "validators/P256Validator");
  const dailyLimit = await moduleNamed(chain, core, "hooks/DailyLimitHook");
  const token = await probeToken(chain);
  const { account, publicKeyHex } = p256Key();
  const limit = 1000;
  const validatorInstall = await installValidator(chain, p256.hash, publicKeyHex);
  const limitInstall = h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: dailyLimit.hash,
    initData: [
      h.codec.stringValue("setDailyLimit"),
      h.codec.hashValue(token.hash),
      h.codec.integerValue(String(limit)),
      h.codec.canonicalValue({ type: "Boolean", value: false }),
    ],
  });
  const created = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions: [validatorInstall, await limitInstall],
  });
  const accountId = created.accountId;
  const validatorId = (await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE)).moduleIds[0];
  const hookId = (await h.moduleIds(sdk, accountId, h.HOOK_MODULE_TYPE)).moduleIds[0];
  const storedLimit = h.decodeInteger(await h.readAndDecode(chain, dailyLimit.hash, "getDailyLimit", [
    h.hash160Param(accountId),
    h.integerParam(hookId),
    h.hash160Param(token.hash),
  ]));
  assert(storedLimit === String(limit), `the hook meters ${storedLimit} per token`);

  const proxyHash = await sdk.getProxyScriptHash(accountId);
  await fundProbeToken(chain, token, proxyHash, 10_000);
  const recipient = storageOrder(new wallet.Account().scriptHash);
  const transferOp = async (amount) => {
    const fresh = await sdk.getAccount(accountId);
    return routedOperation(sdk, accountId, {
      validatorId,
      credentialGeneration: "1",
      descriptor: fresh,
      targetContract: token.hash,
      method: "transfer",
      args: [
        h.codec.hashValue(proxyHash),
        { type: "ByteString", value: recipient },
        h.codec.integerValue(String(amount)),
        {
          type: "Array",
          value: [h.codec.integerValue(String(amount)), { type: "Boolean", value: true }],
        },
      ],
    });
  };

  const overLimit = sign64(chain, core.hash, {
    accountId,
    operation: await transferOp(limit + 1),
    key: account,
    moduleId: validatorId,
  });
  const overLimitRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId, operation: overLimit }),
    /Daily limit exceeded/,
    "a transfer above the configured daily limit",
  );

  const allowed = sign64(chain, core.hash, {
    accountId,
    operation: await transferOp(500),
    key: account,
    moduleId: validatorId,
  });
  const executed = await h.executeOperation(chain, sdk, { accountId, operation: allowed });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "true", "a transfer inside the limit executed");
  return {
    accountId: h.normalizeHash(accountId),
    validatorId,
    hookId,
    limit: storedLimit,
    txid: executed.txid,
    overLimitRefusal,
  };
}

// ---------------------------------------------------------------------------
// whitelist-hook: only the allowed target is reachable
// ---------------------------------------------------------------------------

async function scenarioWhitelistHook({ chain, core, sdk }) {
  const p256 = await moduleNamed(chain, core, "validators/P256Validator");
  const whitelist = await moduleNamed(chain, core, "hooks/WhitelistHook");
  const token = await probeToken(chain);
  const { account, publicKeyHex } = p256Key();
  const allowInstall = h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: whitelist.hash,
    initData: [h.codec.stringValue("allowTarget"), h.codec.hashValue(token.hash)],
  });
  const created = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions: [await installValidator(chain, p256.hash, publicKeyHex), await allowInstall],
  });
  const accountId = created.accountId;
  const validatorId = (await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE)).moduleIds[0];
  const hookId = (await h.moduleIds(sdk, accountId, h.HOOK_MODULE_TYPE)).moduleIds[0];

  const outsideOp = await routedOperation(sdk, accountId, {
    validatorId,
    targetContract: GAS_HASH,
    method: "symbol",
  });
  const outsideRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, {
      accountId,
      operation: sign64(chain, core.hash, { accountId, operation: outsideOp, key: account, moduleId: validatorId }),
    }),
    /Target contract not in whitelist/,
    "an operation targeting a contract outside the allowlist",
  );

  const probeAddress = await sdk.getProxyScriptHash(accountId);
  const allowedOp = await routedOperation(sdk, accountId, {
    validatorId,
    targetContract: token.hash,
    method: "balanceOf",
    args: [h.codec.hashValue(probeAddress)],
  });
  const executed = await h.executeOperation(chain, sdk, {
    accountId,
    operation: sign64(chain, core.hash, { accountId, operation: allowedOp, key: account, moduleId: validatorId }),
  });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "0", "the allowed target executed");
  return {
    accountId: h.normalizeHash(accountId),
    validatorId,
    hookId,
    txid: executed.txid,
    outsideRefusal,
  };
}

// ---------------------------------------------------------------------------
// token-restricted: the restriction holds by effect, not only by target
// ---------------------------------------------------------------------------

async function scenarioTokenRestricted({ chain, core, sdk }) {
  const p256 = await moduleNamed(chain, core, "validators/P256Validator");
  const tokenRestricted = await moduleNamed(chain, core, "hooks/TokenRestrictedHook");
  const token = await probeToken(chain);
  const { account, publicKeyHex } = p256Key();
  const restrictInstall = h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: tokenRestricted.hash,
    initData: [h.codec.stringValue("restrictToken"), h.codec.hashValue(token.hash)],
  });
  const created = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions: [await installValidator(chain, p256.hash, publicKeyHex), await restrictInstall],
  });
  const accountId = created.accountId;
  const validatorId = (await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE)).moduleIds[0];
  const hookId = (await h.moduleIds(sdk, accountId, h.HOOK_MODULE_TYPE)).moduleIds[0];
  const restricted = h.stackText(await h.readAndDecode(chain, tokenRestricted.hash, "isRestricted", [
    h.hash160Param(accountId),
    h.integerParam(hookId),
    h.hash160Param(token.hash),
  ]));
  assert(restricted === "true", "the hook reports the token as restricted");

  const proxyHash = await sdk.getProxyScriptHash(accountId);
  const recipient = storageOrder(new wallet.Account().scriptHash);
  const restrictedOp = await routedOperation(sdk, accountId, {
    validatorId,
    targetContract: token.hash,
    method: "transfer",
    args: [
      h.codec.hashValue(proxyHash),
      { type: "ByteString", value: recipient },
      h.codec.integerValue("1"),
      { type: "Array", value: [h.codec.integerValue("1"), { type: "Boolean", value: true }] },
    ],
  });
  const restrictedRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, {
      accountId,
      operation: sign64(chain, core.hash, { accountId, operation: restrictedOp, key: account, moduleId: validatorId }),
    }),
    /Interaction with restricted token is forbidden/,
    "an operation targeting the restricted token",
  );

  const allowedOp = await routedOperation(sdk, accountId, {
    validatorId,
    targetContract: GAS_HASH,
    method: "symbol",
  });
  const executed = await h.executeOperation(chain, sdk, {
    accountId,
    operation: sign64(chain, core.hash, { accountId, operation: allowedOp, key: account, moduleId: validatorId }),
  });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "GAS", "an operation on another target executed");
  return {
    accountId: h.normalizeHash(accountId),
    validatorId,
    hookId,
    txid: executed.txid,
    restrictedRefusal,
  };
}

// ---------------------------------------------------------------------------
// neodid-hook: a required credential is refused without a registry
// ---------------------------------------------------------------------------

async function scenarioNeoDidHook({ chain, core, sdk }) {
  const p256 = await moduleNamed(chain, core, "validators/P256Validator");
  const neoDid = await moduleNamed(chain, core, "hooks/NeoDIDCredentialHook");
  const token = await probeToken(chain);
  const { account, publicKeyHex } = p256Key();
  const provider = "google";
  const claimType = "email";
  const claimCommitmentHex = digestOf("matrix-claim-commitment");
  const requireInstall = h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: neoDid.hash,
    initData: [
      h.codec.stringValue("requireCredential"),
      h.codec.hashValue(token.hash),
      h.codec.stringValue(provider),
      h.codec.stringValue(claimType),
      h.codec.byteStringValue(claimCommitmentHex),
    ],
  });
  const created = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions: [await installValidator(chain, p256.hash, publicKeyHex), await requireInstall],
  });
  const accountId = created.accountId;
  const validatorId = (await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE)).moduleIds[0];
  const hookId = (await h.moduleIds(sdk, accountId, h.HOOK_MODULE_TYPE)).moduleIds[0];
  const storedProvider = h.stackText(await h.readAndDecode(chain, neoDid.hash, "getRequiredProvider", [
    h.hash160Param(accountId),
    h.integerParam(hookId),
    h.hash160Param(token.hash),
  ]));
  const storedClaim = h.stackText(await h.readAndDecode(chain, neoDid.hash, "getRequiredClaimType", [
    h.hash160Param(accountId),
    h.integerParam(hookId),
    h.hash160Param(token.hash),
  ]));
  assert(storedProvider === provider && storedClaim === claimType, `the hook requires ${storedProvider}/${storedClaim}`);

  const proxyHash = await sdk.getProxyScriptHash(accountId);
  const credentialOp = async () => {
    const fresh = await sdk.getAccount(accountId);
    return routedOperation(sdk, accountId, {
      validatorId,
      credentialGeneration: "1",
      descriptor: fresh,
      targetContract: token.hash,
      method: "balanceOf",
      args: [h.codec.hashValue(proxyHash)],
    });
  };
  const noRegistryOp = await credentialOp();
  const noRegistryRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, {
      accountId,
      operation: sign64(chain, core.hash, { accountId, operation: noRegistryOp, key: account, moduleId: validatorId }),
    }),
    /NeoDID registry not configured/,
    "a credential-gated operation with no registry bound",
  );

  // The requirement is target-scoped: a target the owner never gated carries
  // no requirement, so the same key still reaches it without a credential.
  const ungatedProvider = h.stackText(await h.readAndDecode(chain, neoDid.hash, "getRequiredProvider", [
    h.hash160Param(accountId),
    h.integerParam(hookId),
    h.hash160Param(GAS_HASH),
  ]));
  assert(ungatedProvider === "", "an ungated target carries no credential requirement");

  const otherOp = await routedOperation(sdk, accountId, { validatorId, targetContract: GAS_HASH, method: "symbol" });
  const executed = await h.executeOperation(chain, sdk, {
    accountId,
    operation: sign64(chain, core.hash, { accountId, operation: otherOp, key: account, moduleId: validatorId }),
  });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "GAS", "an operation on an ungated target executed");
  return {
    accountId: h.normalizeHash(accountId),
    validatorId,
    hookId,
    provider: storedProvider,
    claimType: storedClaim,
    txid: executed.txid,
    noRegistryRefusal,
  };
}

// ---------------------------------------------------------------------------
// multihook: retired, so the install action is refused
// ---------------------------------------------------------------------------

async function scenarioMultiHook({ chain, core, sdk }) {
  const multiHook = await moduleNamed(chain, core, "hooks/MultiHook");
  const install = await h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: multiHook.hash,
  });
  const refusal = await h.expectRefusal(
    chain,
    sdk,
    {
      ...h.registrationPlan(sdk, {
        custodyAddress: chain.account.scriptHash,
        salt: saltHex(),
        recoveryTimelockMs: h.REGISTRATION_RECOVERY_TIMELOCK_MS,
        actions: [install],
      }),
      authorizers: [chain.account],
    },
    /MultiHook is not installable/,
    "installing the retired MultiHook",
  );
  return { module: h.normalizeHash(multiHook.hash), installRefusal: refusal };
}

// ---------------------------------------------------------------------------
// threshold: a 2-of-2 policy over two validator instances
// ---------------------------------------------------------------------------

async function scenarioThreshold({ chain, core, sdk }) {
  const p256 = await moduleNamed(chain, core, "validators/P256Validator");
  const multiSig = await moduleNamed(chain, core, "validators/MultiSigValidator");
  const memberA = p256Key();
  const memberB = p256Key();
  const installA = await installValidator(chain, multiSig.hash, memberA.publicKeyHex, "setMemberKey");
  const installB = await installValidator(chain, p256.hash, memberB.publicKeyHex);
  const policy = h.thresholdPolicyAction({ policyId: "0", threshold: "2", members: ["1", "2"] });
  const created = await h.createAccount(chain, sdk, {
    custody: chain.account,
    salt: saltHex(),
    actions: [installA, installB, policy],
  });
  const accountId = created.accountId;
  const state = await sdk.getAccount(accountId);
  const validatorIds = (await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE)).moduleIds;
  assert(validatorIds.join(",") === "1,2", `validator ids are ${validatorIds.join(",")}, expected 1,2`);
  const policyId = "3";
  const policyGeneration = "1";

  const memberRouteOp = await routedOperation(sdk, accountId, { validatorId: "1", descriptor: state });
  const memberRouteRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, {
      accountId,
      operation: sign64(chain, core.hash, { accountId, operation: memberRouteOp, key: memberA.account, moduleId: "1" }),
    }),
    /SA_MODULE_NOT_ROUTABLE/,
    "routing an active-policy member as a standalone validator",
  );

  const thresholdOp = await routedOperation(sdk, accountId, {
    validatorId: policyId,
    credentialGeneration: policyGeneration,
    descriptor: state,
  });
  const thresholdDigest = h.operationDigest(chain, core.hash, accountId, thresholdOp);
  const signedThreshold = {
    ...thresholdOp,
    signature: h.codec.thresholdSignature([
      { moduleId: "1", signature: wallet.sign(h.codec.thresholdMemberDigest(thresholdDigest, "1", "1"), memberA.account.privateKey) },
      { moduleId: "2", signature: wallet.sign(h.codec.thresholdMemberDigest(thresholdDigest, "2", "1"), memberB.account.privateKey) },
    ]),
  };
  const executed = await h.executeOperation(chain, sdk, { accountId, operation: signedThreshold });
  assert(h.stackText(executed.appLog.executions[0].stack[0]) === "GAS", "the 2-of-2 policy executed");

  const singleOp = await routedOperation(sdk, accountId, {
    validatorId: policyId,
    credentialGeneration: policyGeneration,
    descriptor: state,
  });
  const singleDigest = h.operationDigest(chain, core.hash, accountId, singleOp);
  const singleSigned = {
    ...singleOp,
    signature: h.codec.thresholdSignature([
      {
        moduleId: "1",
        signature: wallet.sign(h.codec.thresholdMemberDigest(singleDigest, "1", "1"), memberA.account.privateKey),
      },
    ]),
  };
  const belowThresholdRefusal = await h.expectRefusal(
    chain,
    sdk,
    refusalSpec(sdk, { accountId, operation: singleSigned }),
    /SA_VALIDATION_REJECTED/,
    "one approval against a 2-of-2 threshold",
  );
  return {
    accountId: h.normalizeHash(accountId),
    validatorIds,
    policyId,
    policyGeneration,
    txid: executed.txid,
    memberRouteRefusal,
    belowThresholdRefusal,
  };
}

// ---------------------------------------------------------------------------
// abi-negatives: a module whose profile or callback ABI is wrong never installs
// ---------------------------------------------------------------------------

async function scenarioAbiNegatives({ chain, core, sdk }) {
  const refusals = {};

  /**
   * Register a fresh account whose only action is a refused install.
   *
   * The refusal is produced by the kernel's own simulation before a fee is
   * spent, so the account never exists and the message names the module.
   */
  const installRefused = async (label, action, pattern) => {
    refusals[label] = await h.expectRefusal(
      chain,
      sdk,
      {
        ...h.registrationPlan(sdk, {
          custodyAddress: chain.account.scriptHash,
          salt: saltHex(),
          recoveryTimelockMs: h.REGISTRATION_RECOVERY_TIMELOCK_MS,
          actions: [action],
        }),
        authorizers: [chain.account],
      },
      pattern,
      `installing ${label}`,
    );
  };

  // The core hashes the bytes the module's own `getModuleProfile()` returns and
  // compares them with the digest the install action committed to (§7.3). Every
  // module below lacks that read, so no digest the installer can name will
  // bind — and the fault is the commitment, not a missing manifold method.
  for (const [name, moduleType] of [
    ["MarkerOnlyModule", h.VALIDATOR_MODULE_TYPE],
    ["WrongLifecycleAbiModule", h.VALIDATOR_MODULE_TYPE],
    ["WrongHookLifecycleAbiModule", h.HOOK_MODULE_TYPE],
  ]) {
    // No `authorizedCore()` either, so these are deployed and never authorized.
    deployed[name] = await h.deployContract(chain, name, "");
    await installRefused(
      name,
      h.installAction({ moduleType, moduleHash: deployed[name].hash, profileDigest: "00".repeat(32) }),
      /SA_MODULE_CODE_BINDING_MISMATCH/,
    );
  }

  // A validator's profile cannot be smuggled in under the hook type: the core
  // reads the module type out of the profile, not from the install action.
  const p256 = await moduleNamed(chain, core, "validators/P256Validator");
  await installRefused(
    "validator installed as a hook",
    await h.installActionFor(chain, { moduleType: h.HOOK_MODULE_TYPE, moduleHash: p256.hash }),
    /SA_MODULE_TYPE_UNSUPPORTED/,
  );

  return { refusals };
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
