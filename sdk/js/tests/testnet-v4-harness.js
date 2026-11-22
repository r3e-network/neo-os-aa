/**
 * v4 testnet harness shared by the operator scripts in this directory.
 *
 * These scripts are runbooks, not gates: they deploy the v4 core and the
 * modules it installs, then drive real transactions on a testnet. They are not
 * run by `npm test` and are not run in the migration phase, because the v4 core
 * is not deployed yet.
 *
 * Everything protocol-shaped comes from the SDK: the 13-field operation, the
 * §4.3 digest, the EIP-712 signing payload, the configuration intent plans and
 * the review/sign/broadcast lifecycle. This module only adds what a runbook
 * needs on top:
 *
 * - a WIF-backed wallet input for `prepareTransaction` (the SDK verifies every
 *   signature it exports, so a wallet is an account, its verification script
 *   and a P-256 signer — never a placeholder);
 * - artifact loading from `contracts/bin/public` (including `validators/` and
 *   `hooks/`), deployment and module authorization;
 * - module install actions with the profile digest the core re-checks against
 *   the module's own `getModuleProfile()` bytes;
 * - raw chain reads for module state, which the SDK client does not decode.
 *
 * Deployment naming is part of the protocol, not a convenience. `deployCore`
 * puts the kernel on chain under its canonical manifest name, because the SDK
 * client only adopts a contract whose manifest is named `SmartAccount`; and
 * `deployModule` does the same for each module, because the core compares the
 * profile's `contractName` with the deployed manifest name (§7.3) and rejects
 * anything else with `SA_MODULE_CODE_BINDING_MISMATCH`. A run tag would rename
 * the manifest and break both checks, so only non-module contracts (paymaster,
 * address market, test probes) are deployed with a per-run suffix.
 *
 * A v3 registration installed a verifier and a hook in one call with setters
 * applied later. v4 has no such call: an account is created with custody and
 * salt, and modules are installed either atomically in that same transaction
 * (`actions`) or through the 24-hour configuration intent. A runbook that
 * needs a live chain within one run therefore installs at creation, and keeps
 * the intent path for scenarios that explicitly exercise maturity.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { rpc, sc, wallet, experimental, tx, u } = require("@cityofzion/neon-js");
const { ethers } = require("ethers");

const {
  NativeSmartAccountClient,
  codec,
  buildUserOperationTypedData,
} = require("../src/index");
const { extractDeployedContractHash } = require("../src/deployLog");
const { resolveTestnetRpcUrl } = require("./testnet-rpc");

const VALIDATOR_MODULE_TYPE = "validator";
const HOOK_MODULE_TYPE = "hook";
/** `ActionInstallModule` / `ActionConfigureModule` of the core action grammar. */
const ACTION_INSTALL_MODULE = "1";
const ACTION_CONFIGURE_MODULE = "3";
const ACTION_SET_HOOK_ORDER = "4";
const ACTION_THRESHOLD_POLICY = "7";
const REGISTRATION_RECOVERY_TIMELOCK_MS = 7 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function repoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function reportDirectory() {
  return path.join(repoRoot(), "docs", "reports");
}

function sanitizeHex(value = "") {
  return String(value || "").replace(/^0x/i, "").toLowerCase();
}

function normalizeHash(value = "") {
  const hex = sanitizeHex(value);
  return hex ? `0x${hex}` : "";
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validationRunId() {
  return (
    process.env.SA_VALIDATION_RUN_ID ||
    `${Date.now().toString(36)}-${process.pid.toString(36)}-${crypto.randomBytes(3).toString("hex")}`
  ).toLowerCase();
}

function logSection(title) {
  console.log(`\n== ${title} ==`);
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

function isRetryableRpcError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /socket hang up|ECONNRESET|ETIMEDOUT|fetch failed|network error|EAI_AGAIN|ECONNREFUSED|EADDRNOTAVAIL|socket disconnected|TLS connection|premature close|invalid response body/i.test(
    message,
  );
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

/**
 * Resolve the endpoint, the paying wallet and the network magic once. The SDK
 * client is built per deployed core, because its contract hash is its identity.
 */
async function connect({ env = process.env, wif = env.TEST_WIF, rpcUrl } = {}) {
  if (!wif) throw new Error("TEST_WIF is required.");
  const url = rpcUrl || (await resolveTestnetRpcUrl({ env }));
  const account = new wallet.Account(wif);
  const rpcClient = new rpc.RPCClient(url);
  const version = await withRpcRetry("rpc.getversion", () => rpcClient.getVersion());
  const networkMagic = Number(version.protocol.network);
  // One run id names both the report and the deployment tag, so a rerun can
  // reuse the non-module contracts it already deployed.
  const runId = validationRunId();
  return {
    rpcUrl: url,
    account,
    rpc: rpcClient,
    networkMagic,
    runId,
    deploymentTag: env.SA_VALIDATION_DEPLOY_TAG || `sa-v4-${runId}`,
  };
}

/** The SDK client for the native kernel deployed by this harness. */
function clientFor(chain, coreHash) {
  return new NativeSmartAccountClient({
    rpcUrl: chain.rpcUrl,
    networkMagic: chain.networkMagic,
    contractHash: coreHash,
  });
}

/**
 * A wallet as `prepareTransaction` takes it: the account, its verification
 * script and a signer over the review's sign data (sha256, P-256, r||s).
 */
function walletInput(account) {
  if (!account || !account.scriptHash) throw new Error("a wallet account is required");
  if (!account.contract || !account.contract.script) {
    throw new Error("the wallet must expose its verification script; a bare script hash cannot sign");
  }
  return {
    account: account.scriptHash,
    verificationScript: Buffer.from(account.contract.script, "base64").toString("hex"),
    sign: (signData) => wallet.sign(signData, account.privateKey),
  };
}

function capsFromEnv(env = process.env) {
  return {
    maxSystemFee: env.SA_MAX_SYSTEM_FEE || "50000000",
    maxNetworkFee: env.SA_MAX_NETWORK_FEE || "5000000",
    maxTotalFee: env.SA_MAX_TOTAL_FEE || "55000000",
  };
}

// ---------------------------------------------------------------------------
// Artifacts and deployment
// ---------------------------------------------------------------------------

/** `name` may carry a subdirectory: `SmartAccount`, `validators/Web3AuthValidator`. */
function artifactPaths(name) {
  const base = path.join(repoRoot(), "contracts", "bin", "public", name);
  return { nef: `${base}.nef`, manifest: `${base}.manifest.json` };
}

function loadArtifact(name, uniqueSuffix) {
  const paths = artifactPaths(name);
  const nef = sc.NEF.fromBuffer(fs.readFileSync(paths.nef));
  const manifestJson = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
  if (uniqueSuffix) manifestJson.name = `${manifestJson.name}-${uniqueSuffix}`;
  return { nef, manifest: sc.ContractManifest.fromJson(manifestJson), name: manifestJson.name };
}

/** The canonical profile bytes a module publishes, read from its own file. */
function profileDigestOf(name) {
  const file = path.join(repoRoot(), "contracts", "plugins", ...String(name).split("/"));
  const jsonPath = file.endsWith(".profile.json") ? file : `${file}.profile.json`;
  return sha256(fs.readFileSync(jsonPath));
}

/** The digest of the bytes the deployed module actually answers with. */
async function moduleProfileDigest(chain, moduleHash) {
  const result = await invokeRead(chain, moduleHash, "getModuleProfile", []);
  const item = result?.stack?.[0];
  if (!item || item.type !== "ByteString") {
    throw new Error(`${normalizeHash(moduleHash)} does not expose a getModuleProfile string`);
  }
  return sha256(Buffer.from(item.value || "", "base64"));
}

function buildConfig(chain) {
  return {
    account: chain.account,
    networkMagic: chain.networkMagic,
    rpcAddress: chain.rpcUrl,
    blocksTillExpiry: 200,
  };
}

async function waitForAppLog(chain, txid, label, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const appLog = await chain.rpc.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch (_) {
      // The transaction is not in a block yet.
    }
    await sleep(3000);
  }
  throw new Error(`${label}: timed out waiting for the application log of ${txid}`);
}

function executionOf(appLog, label) {
  const execution = appLog?.executions?.[0];
  if (!execution) throw new Error(`${label}: missing execution log`);
  return execution;
}

function assertHalt(appLog, label) {
  const execution = executionOf(appLog, label);
  const vmState = String(execution.vmstate || execution.state || "");
  if (!vmState.includes("HALT")) {
    throw new Error(`${label}: VM did not HALT (${vmState}) ${execution.exception || ""}`.trim());
  }
  return execution;
}

function assertFault(appLog, label) {
  const execution = executionOf(appLog, label);
  const vmState = String(execution.vmstate || execution.state || "");
  if (!vmState.includes("FAULT")) {
    throw new Error(`${label}: expected a FAULT, got ${vmState}`.trim());
  }
  return execution;
}

/** Whether `hash` already carries a deployed contract, and therefore a manifest. */
async function contractDeployed(chain, hash) {
  try {
    const state = await withRpcRetry(`contractstate ${hash}`, () => chain.rpc.getContractState(sanitizeHex(hash)));
    return Boolean(state?.manifest);
  } catch (_) {
    return false;
  }
}

/**
 * The manifest suffix a deployment gets.
 *
 * `uniqueSuffix` defaults to the run tag, which renames the manifest so two
 * runs never collide on a chain that keeps old deployments. An empty string
 * keeps the artifact's canonical manifest name, which is what the kernel
 * requires: the client refuses a core whose manifest is not named
 * `SmartAccount`, and a v4 module publishes its own `contractName` in the
 * profile the core compares against that name (§7.3).
 */
function deploymentSuffix(chain, name, uniqueSuffix) {
  if (uniqueSuffix !== undefined) return uniqueSuffix;
  return `${chain.deploymentTag}-${name.replace(/\//g, "-")}`;
}

/**
 * Deploy one artifact.
 *
 * A canonical deployment is reused when the predicted hash is already on
 * chain, so a rerun does not try to deploy the same (nef, name) pair twice.
 */
async function deployContract(chain, name, uniqueSuffix) {
  const suffix = deploymentSuffix(chain, name, uniqueSuffix);
  const { nef, manifest } = loadArtifact(name, suffix);
  const predictedHash = normalizeHash(
    experimental.getContractHash(u.HexString.fromHex(chain.account.scriptHash), nef.checksum, manifest.name),
  );
  if (suffix === "" && (await contractDeployed(chain, predictedHash))) {
    return { txid: null, hash: sanitizeHex(predictedHash), manifestName: manifest.name, reused: true };
  }
  const txid = await withRpcRetry(`deploy ${name}`, () =>
    experimental.deployContract(nef, manifest, buildConfig(chain)),
  );
  const appLog = await waitForAppLog(chain, txid, `deploy ${name}`);
  assertHalt(appLog, `deploy ${name}`);
  const deployedHash = extractDeployedContractHash(appLog) || predictedHash;
  return { txid, hash: sanitizeHex(deployedHash), manifestName: manifest.name, reused: false };
}

/** The kernel, under the canonical name its own client insists on. */
async function deployCore(chain) {
  return deployContract(chain, "SmartAccount", "");
}

// ---------------------------------------------------------------------------
// Direct invocations (service contracts, module authorization)
// ---------------------------------------------------------------------------

function hash160Param(value) {
  return sc.ContractParam.hash160(sanitizeHex(value));
}

function byteArrayParam(hexValue) {
  return sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(hexValue), true));
}

function integerParam(value) {
  return sc.ContractParam.integer(typeof value === "bigint" ? value.toString() : value);
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

/** The runtime-typed slot a native transfer takes as its `data` payload. */
function anyParam(value = null) {
  return sc.ContractParam.any(value);
}

function makeSigner(scriptHash) {
  return { account: sanitizeHex(scriptHash), scopes: tx.WitnessScope.CalledByEntry };
}

/** A witness scoped to the contracts it must reach, never the whole chain. */
function makeCustomContractSigner(scriptHash, allowedContracts = []) {
  const contracts = allowedContracts.map((hash) => normalizeHash(hash));
  return contracts.length
    ? {
        account: sanitizeHex(scriptHash),
        scopes: tx.WitnessScope.CustomContracts,
        allowedContracts: contracts,
      }
    : makeSigner(scriptHash);
}

async function invokeRead(chain, contractHash, operation, params = [], signers = undefined) {
  return withRpcRetry(`${sanitizeHex(contractHash)}.${operation}`, () =>
    chain.rpc.invokeFunction(sanitizeHex(contractHash), operation, params, signers),
  );
}

async function readAndDecode(chain, contractHash, operation, params = [], signers = undefined) {
  const result = await invokeRead(chain, contractHash, operation, params, signers);
  const state = String(result?.state || "");
  if (state.includes("FAULT")) throw new Error(`${operation} fault: ${result.exception || "VM fault"}`);
  return result?.stack?.[0];
}

/**
 * A direct service call signed by `account` (default: the runbook wallet).
 *
 * Some runbook steps are signed by a different party — a buyer settling its
 * own listing, a module admin, a custody witness for a core service call — so
 * the paying and signing account is explicit rather than assumed.
 */
async function testInvoke(chain, contractHash, operation, params = [], signers = undefined, { account = chain.account } = {}) {
  const contract = new experimental.SmartContract(sanitizeHex(contractHash), { ...buildConfig(chain), account });
  return withRpcRetry(`${sanitizeHex(contractHash)}.${operation}.testinvoke`, () =>
    contract.testInvoke(operation, params, signers),
  );
}

async function invokePersisted(chain, contractHash, operation, params = [], signers = undefined, { account = chain.account } = {}) {
  const contract = new experimental.SmartContract(sanitizeHex(contractHash), { ...buildConfig(chain), account });
  const txid = await withRpcRetry(`${sanitizeHex(contractHash)}.${operation}.invoke`, () =>
    contract.invoke(operation, params, signers),
  );
  const appLog = await waitForAppLog(chain, txid, operation);
  return { txid, appLog, execution: assertHalt(appLog, operation) };
}

/**
 * v4 modules are still authorized to one core (`setAuthorizedCore`), so the
 * deployment step of a runbook is unchanged; what changed is how the core
 * learns about the module (an install action, not a registration field).
 *
 * The runbook's wallet deployed the module, so it holds the module admin role
 * and is the caller here; `setAuthorizedCore` requires exactly that caller.
 * A module answers `authorizedCore()` once it has been authorized, so a rerun
 * against a module already bound to this core spends nothing.
 */
async function authorizeModule(chain, coreHash, moduleHash) {
  const current = await readAndDecode(chain, moduleHash, "authorizedCore", []);
  if (normalizeHash(decodeHash160(current)) === normalizeHash(coreHash)) {
    return { skipped: true };
  }
  return invokePersisted(chain, moduleHash, "setAuthorizedCore", [hash160Param(coreHash)], [
    makeCustomContractSigner(chain.account.scriptHash, [moduleHash]),
  ]);
}

/** Deploy a module under its canonical name and authorize this core. */
async function deployModule(chain, coreHash, name) {
  const module = await deployContract(chain, name, "");
  await authorizeModule(chain, coreHash, module.hash);
  return module;
}

// ---------------------------------------------------------------------------
// v4 plans: review, sign, broadcast
// ---------------------------------------------------------------------------

/**
 * Prepare, sign and broadcast one plan through the SDK lifecycle.
 *
 * `recipe` is the call that rebuilt the plan; `prepareTransaction` replays it
 * and refuses a plan whose bytes the recipe does not reproduce, so a review
 * always names its own construction.
 */
async function sendPlan(chain, sdk, { plan, recipe, feePayer = chain.account, authorizers = [], systemFee, caps = capsFromEnv(), label }) {
  const prepared = await sdk.prepareTransaction(plan, {
    feePayer: walletInput(feePayer),
    authorizers: authorizers.map(walletInput),
    recipe,
    ...caps,
    ...(systemFee === undefined ? {} : { systemFee }),
  });
  const signed = await sdk.signTransaction(prepared);
  await sdk.broadcastTransaction(signed);
  const appLog = await waitForAppLog(chain, signed.txid, label || plan.method);
  return { txid: signed.txid, appLog, signed, prepared, review: prepared.review };
}

/**
 * Prove a refusal without spending a fee: `prepareTransaction` simulates the
 * plan with the witnesses the core will see, and throws on a non-HALT answer.
 * The pattern is matched against that answer, so a runbook asserts the reason
 * rather than the fact that something failed.
 */
async function expectRefusal(chain, sdk, spec, pattern, label) {
  try {
    await sendPlan(chain, sdk, spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`${label}: refused for another reason than ${pattern}: ${message}`);
    }
    return message;
  }
  throw new Error(`${label}: the plan was accepted`);
}

/**
 * The four v4 plans, each with the recipe that rebuilds it. A review is only
 * as trustworthy as the recipe that reproduces its script, so a runbook never
 * has one without the other.
 */
function registrationPlan(sdk, input) {
  return { plan: sdk.buildCreateAccountScript(input), recipe: { method: "buildCreateAccountScript", input } };
}

function executionPlan(sdk, { accountId, operations }) {
  const input = { accountId, operations: Array.isArray(operations) ? operations : [operations] };
  return { plan: sdk.buildExecutionScript(input), recipe: { method: "buildExecutionScript", input } };
}

function configurationPlan(sdk, input) {
  return { plan: sdk.buildConfigurationScript(input), recipe: { method: "buildConfigurationScript", input } };
}

function accountActionPlan(sdk, input) {
  return { plan: sdk.buildAccountActionScript(input), recipe: { method: "buildAccountActionScript", input } };
}

/**
 * Register a v4 account. Custody plus salt derive the id, so the caller cannot
 * register an id it did not commit to, and the custody witness is the only
 * authority the core asks for.
 *
 * `actions` are raw action arrays (§6): the atomic install path, subject to
 * the same validation as a confirmed intent.
 */
async function createAccount(chain, sdk, { custody = chain.account, salt, recoveryTimelockMs = REGISTRATION_RECOVERY_TIMELOCK_MS, actions = [], feePayer = chain.account, systemFee, caps } = {}) {
  const identity = sdk.deriveIdentity({ custodyAddress: custody.scriptHash, salt });
  const input = {
    custodyAddress: custody.scriptHash,
    salt,
    recoveryTimelockMs,
    actions,
  };
  const spec = registrationPlan(sdk, input);
  if (spec.plan.accountId !== identity.accountId) {
    throw new Error("createAccount plan does not address the identity its inputs derive");
  }
  const result = await sendPlan(chain, sdk, {
    ...spec,
    feePayer,
    authorizers: [custody],
    systemFee,
    caps,
    label: "createAccount",
  });
  return { ...result, accountId: identity.accountId, accountAddress: identity.accountAddress };
}

/** One 13-field operation, with field 11 left for the validator's signature. */
function operation({
  targetContract,
  method,
  args = [],
  nonce = "0",
  nonceSubkey = "00".repeat(32),
  deadline = String(Date.now() + 60 * 60 * 1000),
  validatorId = "0",
  credentialGeneration = "1",
  authorityEpoch = "0",
  configurationNonce = "0",
  signature = "",
} = {}) {
  return {
    targetContract,
    method,
    args,
    nonce: String(nonce),
    nonceSubkey,
    deadline: String(deadline),
    validatorId: String(validatorId),
    credentialGeneration: String(credentialGeneration),
    authorityEpoch: String(authorityEpoch),
    configurationNonce: String(configurationNonce),
    signature,
    hookProofs: [],
  };
}

async function executeOperation(chain, sdk, { accountId, operation: op, feePayer = chain.account, systemFee, caps, label } = {}) {
  return sendPlan(chain, sdk, {
    ...executionPlan(sdk, { accountId, operations: [op] }),
    feePayer,
    systemFee,
    caps,
    label: label || `executeUserOp(${op.method})`,
  });
}

/** Read-only preview of whether the account would accept this operation. */
async function validateOperation(chain, sdk, accountId, op) {
  return sdk.validateUserOp(accountId, op);
}

// ---------------------------------------------------------------------------
// Module actions (§6) and module state
// ---------------------------------------------------------------------------

function installAction({ moduleType, moduleHash, profileDigest, initData = [] }) {
  const type = moduleType === VALIDATOR_MODULE_TYPE || moduleType === 1 ? "1" : "2";
  return {
    type: "Array",
    value: [
      codec.integerValue(ACTION_INSTALL_MODULE),
      codec.integerValue(type),
      codec.hashValue(moduleHash),
      { type: "ByteString", value: codec.hex(profileDigest, 32) },
      { type: "Array", value: initData },
    ],
  };
}

function configureAction(moduleId, configData) {
  return {
    type: "Array",
    value: [
      codec.integerValue(ACTION_CONFIGURE_MODULE),
      codec.integerValue(codec.unsigned(moduleId, 64, "module id")),
      { type: "Array", value: configData },
    ],
  };
}

function hookOrderAction(moduleIds) {
  return {
    type: "Array",
    value: [
      codec.integerValue(ACTION_SET_HOOK_ORDER),
      { type: "Array", value: moduleIds.map((id) => codec.integerValue(codec.unsigned(id, 64, "hook id"))) },
    ],
  };
}

function thresholdPolicyAction({ policyId = "1", threshold = "1", members = [], active = true }) {
  return {
    type: "Array",
    value: [
      codec.integerValue(ACTION_THRESHOLD_POLICY),
      codec.integerValue(codec.unsigned(policyId, 64, "policy id")),
      codec.integerValue(codec.unsigned(threshold, 8, "threshold")),
      { type: "Array", value: members.map((id) => codec.integerValue(codec.unsigned(id, 64, "member id"))) },
      { type: "Boolean", value: Boolean(active) },
    ],
  };
}

/** An install action whose digest is read from the deployed module itself. */
async function installActionFor(chain, { moduleType, moduleHash, initData = [] }) {
  return installAction({
    moduleType,
    moduleHash,
    profileDigest: await moduleProfileDigest(chain, moduleHash),
    initData,
  });
}

async function proposeConfiguration(chain, sdk, { accountId, actions, readSet = [], feePayer = chain.account, authorizers = [chain.account], systemFee, caps }) {
  if (!actions.length) throw new Error("a configuration intent needs at least one action");
  return sendPlan(chain, sdk, {
    ...configurationPlan(sdk, { kind: "propose", accountId, actions, readSet }),
    feePayer,
    authorizers,
    systemFee,
    caps,
    label: "proposeConfiguration",
  });
}

async function confirmConfiguration(chain, sdk, { accountId, intentId, actions, feePayer = chain.account, authorizers = [chain.account], systemFee, caps }) {
  return sendPlan(chain, sdk, {
    ...configurationPlan(sdk, { kind: "confirm", accountId, intentId, actions }),
    feePayer,
    authorizers,
    systemFee,
    caps,
    label: "confirmConfiguration",
  });
}

async function cancelConfiguration(chain, sdk, { accountId, intentId, feePayer = chain.account, authorizers = [chain.account], systemFee, caps }) {
  return sendPlan(chain, sdk, {
    ...configurationPlan(sdk, { kind: "cancel", accountId, intentId }),
    feePayer,
    authorizers,
    systemFee,
    caps,
    label: "cancelConfiguration",
  });
}

async function accountAction(chain, sdk, { accountId, method, args = [], feePayer = chain.account, authorizers = [], systemFee, caps }) {
  return sendPlan(chain, sdk, {
    ...accountActionPlan(sdk, { method, accountId, args }),
    feePayer,
    authorizers,
    systemFee,
    caps,
    label: method,
  });
}

/** Module instance as the core reports it, or null when it is not installed. */
async function moduleState(sdk, accountId, moduleId) {
  return sdk.getModule(accountId, moduleId);
}

async function moduleIds(sdk, accountId, moduleType) {
  return sdk.getModules(accountId, moduleType);
}

// ---------------------------------------------------------------------------
// Operation signatures
// ---------------------------------------------------------------------------

/**
 * The packed nonce for the next operation on one channel. v4 nonces are
 * `channel(191) ‖ sequence(64)`, and a runbook must read the sequence the core
 * reports rather than guess it: a reused nonce is SA_NONCE_INVALID.
 */
async function nextNonce(sdk, accountId, { validatorId = "0", credentialGeneration = "1", authorityEpoch = "0", nonceSubkey = "00".repeat(32) } = {}) {
  const channel = await sdk.getNonce(accountId, {
    authorityEpoch,
    validatorId,
    credentialGeneration,
    nonceSubkey,
  });
  return channel.packed;
}

/** `computeArgsHash` is a v4 core read: keccak256(StdLib.Serialize(args)). */
async function operationArgsHash(chain, coreHash, args = []) {
  const item = await readAndDecode(chain, coreHash, "computeArgsHash", [arrayParam(args)]);
  return Buffer.from(item?.value || "", "base64").toString("hex");
}

function operationDigest(chain, coreHash, accountId, op) {
  return codec.operationDigest(
    { networkMagic: chain.networkMagic, coreContractHash: coreHash, accountId },
    op,
  );
}

/**
 * A canonical VM value as RPC parameters.
 *
 * The codec speaks VM values (`{ type, value }` with hex ByteStrings); the RPC
 * speaks ContractParams. This is the only translation, and it never re-derives
 * the shape, so a runbook that bypasses the SDK plan still publishes exactly
 * the bytes the signature covers.
 */
function contractParamOf(value) {
  switch (value?.type) {
    case "Null":
      return anyParam(null);
    case "Boolean":
      return boolParam(value.value);
    case "Integer":
      return integerParam(value.value);
    case "ByteString":
      return byteArrayParam(value.value);
    case "Array":
    case "Struct":
      return arrayParam(value.value.map(contractParamOf));
    default:
      throw new Error(`unsupported VM type ${value?.type}`);
  }
}

/**
 * The 13-field operation as RPC parameters.
 *
 * Core entry points that take an operation (`executeUserOp`,
 * `executeSponsoredUserOp`, `validateUserOp`, ...) declare it as `object`, so a
 * caller that does not go through a plan still has to hand over the canonical
 * array — including a field-11 signature already in place.
 */
function operationParam(op) {
  return contractParamOf(codec.operationValue(op));
}

/**
 * The built-in route's signature (§8 reused in operation mode): the custody
 * script signs the §4.3 operation digest with P-256/SHA256, and field 11 is the
 * serialized envelope `[4, 0, subjectRevision, [[script, r‖s]]]`.
 *
 * `subjectRevision` is what the core compares, not the credential generation:
 * registration seeds the subject set at revision 1 (custody, threshold 1), and
 * every `setMessageSubjects` intent advances it.
 */
function signOperationWithCustody(chain, coreHash, { accountId, operation: op, signer = chain.account, subjectRevision = "1" }) {
  const digest = operationDigest(chain, coreHash, accountId, op);
  const script = Buffer.from(signer.contract.script, "base64").toString("hex");
  const signature = wallet.sign(digest, signer.privateKey);
  return {
    ...op,
    validatorId: "0",
    signature: codec.builtInSignature({
      credentialGeneration: subjectRevision,
      pairs: [{ script, signature }],
    }),
  };
}

/**
 * The Web3AuthValidator (and any secp256k1 signer) signs the §5 EIP-712 typed
 * data: the readable operation fields plus the core's §4.3 digest, so the
 * signature binds every remaining field.
 *
 * The typed data is exposed on its own because a runbook compares its EIP-712
 * hash against what the deployed validator reports; the signer wrapper below
 * only adds the compact encoding.
 */
function web3AuthTypedData(chain, coreHash, { validatorHash, accountId, operation: op, argsHashHex }) {
  return buildUserOperationTypedData({
    chainId: chain.networkMagic,
    verifyingContract: validatorHash,
    accountId,
    coreContractHash: coreHash,
    validatorId: op.validatorId,
    targetContract: op.targetContract,
    method: op.method,
    argsHashHex,
    nonce: op.nonce,
    deadline: op.deadline,
    operationDigest: operationDigest(chain, coreHash, accountId, op),
  });
}

async function signOperationForWeb3Auth(chain, coreHash, { validatorHash, accountId, operation: op, argsHashHex, signer }) {
  const typed = web3AuthTypedData(chain, coreHash, { validatorHash, accountId, operation: op, argsHashHex });
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);
  const parsed = ethers.Signature.from(signature);
  // The validator reads compact r‖s, not the DER an EVM wallet returns.
  return { ...op, signature: `${sanitizeHex(parsed.r)}${sanitizeHex(parsed.s)}` };
}

// ---------------------------------------------------------------------------
// Stack decoding and reports
// ---------------------------------------------------------------------------

function stackText(item) {
  if (!item) return "";
  if (item.type === "Integer") return String(item.value || "0");
  if (item.type === "Boolean") return String(item.value);
  if (item.type === "Hash160") return normalizeHash(item.value);
  if (item.type === "ByteString") {
    const hex = Buffer.from(item.value || "", "base64").toString("hex");
    if (!hex) return "";
    const utf8 = Buffer.from(hex, "hex").toString("utf8");
    return /^[\x20-\x7E]+$/.test(utf8) ? utf8 : `0x${hex}`;
  }
  return JSON.stringify(item);
}

function decodeHash160(item) {
  if (!item) return "";
  if (item.type === "Hash160") return normalizeHash(item.value);
  const bytes = Buffer.from(item.value || "", "base64");
  return bytes.length === 20 ? normalizeHash(Buffer.from(bytes).reverse().toString("hex")) : "";
}

function decodeInteger(item) {
  if (!item) return "0";
  if (item.type === "ByteString") return BigInt(`0x${Buffer.from(item.value || "", "base64").toString("hex") || "0"}`).toString();
  return String(item.value ?? "0");
}

async function writeReport(name, report) {
  await fs.promises.mkdir(reportDirectory(), { recursive: true });
  const file = path.join(reportDirectory(), name);
  await fs.promises.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

module.exports = {
  ACTION_CONFIGURE_MODULE,
  ACTION_INSTALL_MODULE,
  ACTION_SET_HOOK_ORDER,
  ACTION_THRESHOLD_POLICY,
  HOOK_MODULE_TYPE,
  REGISTRATION_RECOVERY_TIMELOCK_MS,
  VALIDATOR_MODULE_TYPE,
  accountAction,
  accountActionPlan,
  anyParam,
  arrayParam,
  artifactPaths,
  assertFault,
  assertHalt,
  authorizeModule,
  boolParam,
  buildConfig,
  byteArrayParam,
  cancelConfiguration,
  capsFromEnv,
  clientFor,
  codec,
  configurationPlan,
  confirmConfiguration,
  connect,
  createAccount,
  decodeHash160,
  decodeInteger,
  deployContract,
  deployCore,
  deployModule,
  deploymentSuffix,
  executeOperation,
  executionPlan,
  expectRefusal,
  hash160Param,
  hookOrderAction,
  installAction,
  installActionFor,
  integerParam,
  invokePersisted,
  invokeRead,
  loadArtifact,
  logSection,
  makeCustomContractSigner,
  makeSigner,
  moduleIds,
  moduleProfileDigest,
  moduleState,
  nextNonce,
  normalizeHash,
  operation,
  operationArgsHash,
  operationDigest,
  operationParam,
  profileDigestOf,
  proposeConfiguration,
  readAndDecode,
  registrationPlan,
  reportDirectory,
  sanitizeHex,
  sendPlan,
  sha256,
  signOperationForWeb3Auth,
  signOperationWithCustody,
  sleep,
  stackText,
  stringParam,
  testInvoke,
  thresholdPolicyAction,
  validateOperation,
  validationRunId,
  walletInput,
  waitForAppLog,
  web3AuthTypedData,
  withRpcRetry,
  writeReport,
};
