#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  rpc,
  sc,
  wallet,
  experimental,
  tx,
  u,
  CONST,
} = require("@cityofzion/neon-js");
const { ethers } = require("ethers");

const { extractDeployedContractHash } = require("../src/deployLog");
const { AbstractAccountClient } = require("../src/index");
const { buildV3UserOperationTypedData, sanitizeHex } = require("../src/metaTx");
const { resolveTestnetRpcUrl } = require("./testnet-rpc");

let RPC_URL =
  process.env.TESTNET_RPC_URL || "";
const TEST_WIF = process.env.TEST_WIF || "";
const REPORT_DIR = path.resolve(__dirname, "..", "..", "docs", "reports");
const SELECTED_SCENARIOS = new Set(
  String(process.env.AA_MATRIX_SCENARIOS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
let latestReportContext = null;

if (!TEST_WIF) {
  console.error("TEST_WIF is required.");
  process.exit(1);
}

const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const REGISTRATION_ESCAPE_TIMELOCK = 604800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRunScenario(name) {
  if (!SELECTED_SCENARIOS.size) return true;
  return SELECTED_SCENARIOS.has(
    String(name || "")
      .trim()
      .toLowerCase(),
  );
}

function writePluginMatrixReport(context, status, error = null) {
  if (!context) return null;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const payload = {
    ...context.results,
    status,
    error: error ? String(error?.stack || error?.message || error) : null,
  };
  fs.writeFileSync(context.reportPath, JSON.stringify(payload, null, 2));
  return payload;
}

function isRetryableRpcError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /socket hang up|ECONNRESET|ETIMEDOUT|fetch failed|network error|EAI_AGAIN|ECONNREFUSED|EADDRNOTAVAIL|socket disconnected before secure TLS connection was established|TLS connection was established|premature close|invalid response body/i.test(
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
      console.warn(
        `[rpc-retry] ${label} attempt ${attempt}/${attempts} failed: ${message}`,
      );
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

function repoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function oracleRepoRoot() {
  return path.resolve(repoRoot(), "..", "neo-morpheus-oracle");
}

function artifactPaths(baseName) {
  const verifierNames = new Set([
    "Web3AuthVerifier",
    "TEEVerifier",
    "SessionKeyVerifier",
    "WebAuthnVerifier",
    "ZKEmailVerifier",
    "ZkLoginVerifier",
    "MultiSigVerifier",
    "SubscriptionVerifier",
  ]);
  const hookNames = new Set([
    "WhitelistHook",
    "DailyLimitHook",
    "TokenRestrictedHook",
    "MultiHook",
    "NeoDIDCredentialHook",
  ]);
  const artifactDir = verifierNames.has(baseName)
    ? path.join(repoRoot(), "contracts", "bin", "v3", "verifiers")
    : hookNames.has(baseName)
      ? path.join(repoRoot(), "contracts", "bin", "v3", "hooks")
      : path.join(repoRoot(), "contracts", "bin", "v3");
  return {
    nef: path.join(artifactDir, `${baseName}.nef`),
    manifest: path.join(artifactDir, `${baseName}.manifest.json`),
  };
}

function loadArtifact(baseName, uniqueSuffix) {
  const paths = artifactPaths(baseName);
  const nef = sc.NEF.fromBuffer(fs.readFileSync(paths.nef));
  const manifestJson = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
  manifestJson.name = `${manifestJson.name}-${uniqueSuffix}`;
  const manifest = sc.ContractManifest.fromJson(manifestJson);
  return { nef, manifest };
}

function loadOracleArtifact(baseName, uniqueSuffix) {
  const nefPath = path.join(
    oracleRepoRoot(),
    "contracts",
    "build",
    `${baseName}.nef`,
  );
  const manifestPath = path.join(
    oracleRepoRoot(),
    "contracts",
    "build",
    `${baseName}.manifest.json`,
  );
  const nef = sc.NEF.fromBuffer(fs.readFileSync(nefPath));
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifestJson.name = `${manifestJson.name}-${uniqueSuffix}`;
  const manifest = sc.ContractManifest.fromJson(manifestJson);
  return { nef, manifest };
}

function normalizeHash(value) {
  const hex = sanitizeHex(value || "");
  return hex ? `0x${hex}` : "";
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

async function waitForAppLog(client, txid, label, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const appLog = await client.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch (_) {}
    await sleep(3000);
  }
  throw new Error(
    `${label}: timed out waiting for application log for ${txid}`,
  );
}

function assertVmState(appLog, label, expected = "HALT") {
  const execution = appLog?.executions?.[0];
  if (!execution) throw new Error(`${label}: missing execution log`);
  const vmState = String(execution.vmstate || execution.state || "");
  if (!vmState.includes(expected)) {
    throw new Error(
      `${label}: expected ${expected}, got ${vmState} ${execution.exception || ""}`.trim(),
    );
  }
  return execution;
}

function makeSigner(scriptHash) {
  return { account: scriptHash, scopes: tx.WitnessScope.CalledByEntry };
}

function hash160Param(value) {
  return sc.ContractParam.hash160(sanitizeHex(value));
}

function byteArrayParam(hexValue) {
  return sc.ContractParam.byteArray(
    u.HexString.fromHex(sanitizeHex(hexValue), true),
  );
}

function integerParam(value) {
  if (typeof value === "bigint")
    return sc.ContractParam.integer(value.toString());
  return sc.ContractParam.integer(value);
}

function boolParam(value) {
  return sc.ContractParam.boolean(Boolean(value));
}

function stringParam(value) {
  return sc.ContractParam.string(String(value));
}

function anyParam(value) {
  return sc.ContractParam.any(value);
}

function arrayParam(values = []) {
  return sc.ContractParam.array(...values);
}

function emptyByteArrayParam() {
  return sc.ContractParam.byteArray(u.HexString.fromHex("", true));
}

function userOpParam({
  targetContract,
  method,
  args = [],
  nonce = 0n,
  deadline = 0n,
  signatureHex = "",
}) {
  return arrayParam([
    hash160Param(targetContract),
    stringParam(method),
    arrayParam(args),
    integerParam(nonce),
    integerParam(deadline),
    byteArrayParam(signatureHex),
  ]);
}

async function deployContract(
  client,
  account,
  networkMagic,
  baseName,
  uniqueSuffix,
) {
  const { nef, manifest } = loadArtifact(baseName, uniqueSuffix);
  const predictedHash = normalizeHash(
    experimental.getContractHash(
      u.HexString.fromHex(account.scriptHash),
      nef.checksum,
      manifest.name,
    ),
  );
  console.log(`Deploying ${baseName} (${manifest.name})...`);
  const txid = await withRpcRetry(`deploy ${baseName}`, () =>
    experimental.deployContract(
      nef,
      manifest,
      buildConfig(account, networkMagic),
    ),
  );
  const appLog = await waitForAppLog(client, txid, `deploy ${baseName}`);
  assertVmState(appLog, `deploy ${baseName}`, "HALT");
  const deployedHash = extractDeployedContractHash(appLog) || predictedHash;
  console.log(`Deployed ${baseName}: ${deployedHash} via ${txid}`);
  return {
    txid,
    hash: normalizeHash(deployedHash),
    manifestName: manifest.name,
  };
}

async function deployOracleContract(
  client,
  account,
  networkMagic,
  baseName,
  uniqueSuffix,
) {
  const { nef, manifest } = loadOracleArtifact(baseName, uniqueSuffix);
  const predictedHash = normalizeHash(
    experimental.getContractHash(
      u.HexString.fromHex(account.scriptHash),
      nef.checksum,
      manifest.name,
    ),
  );
  console.log(`Deploying ${baseName} (${manifest.name})...`);
  const txid = await withRpcRetry(`deploy ${baseName}`, () =>
    experimental.deployContract(
      nef,
      manifest,
      buildConfig(account, networkMagic),
    ),
  );
  const appLog = await waitForAppLog(client, txid, `deploy ${baseName}`);
  assertVmState(appLog, `deploy ${baseName}`, "HALT");
  const deployedHash = extractDeployedContractHash(appLog) || predictedHash;
  console.log(`Deployed ${baseName}: ${deployedHash} via ${txid}`);
  return {
    txid,
    hash: normalizeHash(deployedHash),
    manifestName: manifest.name,
  };
}

async function authorizeHook(
  client,
  coreHash,
  hookHash,
  account,
  networkMagic,
) {
  return invokePersisted(
    client,
    hookHash,
    account,
    networkMagic,
    "setAuthorizedCore",
    [hash160Param(coreHash)],
  );
}

async function authorizeVerifier(
  client,
  coreHash,
  verifierHash,
  account,
  networkMagic,
) {
  return invokePersisted(
    client,
    verifierHash,
    account,
    networkMagic,
    "setAuthorizedCore",
    [hash160Param(coreHash)],
  );
}

async function invokeRead(
  client,
  contractHash,
  operation,
  params = [],
  signers = undefined,
) {
  return withRpcRetry(`${sanitizeHex(contractHash)}.${operation}`, () =>
    client.invokeFunction(
      sanitizeHex(contractHash),
      operation,
      params,
      signers,
    ),
  );
}

async function readAndDecode(
  client,
  contractHash,
  operation,
  params = [],
  signers = undefined,
) {
  const result = await invokeRead(
    client,
    contractHash,
    operation,
    params,
    signers,
  );
  const state = String(result?.state || "");
  if (state.includes("FAULT")) {
    throw new Error(`${operation} fault: ${result.exception || "VM fault"}`);
  }
  return result?.stack?.[0];
}

async function invokePersisted(
  client,
  contractHash,
  account,
  networkMagic,
  operation,
  params = [],
  signers = undefined,
) {
  const contract = new experimental.SmartContract(
    sanitizeHex(contractHash),
    buildConfig(account, networkMagic),
  );
  const txid = await withRpcRetry(
    `${sanitizeHex(contractHash)}.${operation}.invoke`,
    () => contract.invoke(operation, params, signers),
  );
  const appLog = await waitForAppLog(client, txid, `${operation}`);
  const execution = assertVmState(appLog, `${operation}`, "HALT");
  return { txid, appLog, execution };
}

async function testInvoke(
  client,
  contractHash,
  account,
  networkMagic,
  operation,
  params = [],
  signers = undefined,
) {
  const contract = new experimental.SmartContract(
    sanitizeHex(contractHash),
    buildConfig(account, networkMagic),
  );
  return withRpcRetry(
    `${sanitizeHex(contractHash)}.${operation}.testInvoke`,
    () => contract.testInvoke(operation, params, signers),
  );
}

function compactSignature(signature) {
  const parsed = ethers.Signature.from(signature);
  return `${sanitizeHex(parsed.r)}${sanitizeHex(parsed.s)}`;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function encodeNeoDidSegment(value) {
  const text = Buffer.from(String(value || ""), "utf8");
  if (text.length > 255) {
    throw new Error("NeoDID segment too long");
  }
  return Buffer.concat([Buffer.from([text.length]), text]);
}

function buildNeoDidBindingCommitmentDigest({
  vaultAccount,
  provider,
  claimType,
  claimCommitmentHex,
  masterNullifierHex,
  metadataHashHex,
  networkMagic,
}) {
  const network = Buffer.alloc(4);
  network.writeUInt32LE(Number(networkMagic) >>> 0, 0);
  return sha256Buffer(
    Buffer.concat([
      Buffer.from("neodid-claim-commitment-v1", "utf8"),
      Buffer.from(sanitizeHex(vaultAccount), "hex"),
      encodeNeoDidSegment(provider),
      encodeNeoDidSegment(claimType),
      Buffer.from(sanitizeHex(claimCommitmentHex), "hex"),
      Buffer.from(sanitizeHex(masterNullifierHex), "hex"),
      Buffer.from(sanitizeHex(metadataHashHex), "hex"),
      network,
    ]),
  );
}

function randomAccountId() {
  return Buffer.from(ethers.randomBytes(20)).toString("hex");
}

function validationRunId() {
  return (
    process.env.AA_VALIDATION_RUN_ID || `${Date.now().toString(36)}-${process.pid.toString(36)}-${crypto.randomBytes(3).toString("hex")}`
  ).toLowerCase();
}

function logSection(title) {
  console.log(`\n== ${title} ==`);
}

function expectedSubscriptionNonce(subIdHex, periodSeconds, runtimeMs = Date.now()) {
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from(sanitizeHex(subIdHex), "hex"))
    .digest();
  let subTag = 0n;
  for (let i = 0; i < 8; i += 1) {
    subTag = (subTag << 8n) + BigInt(digest[i]);
  }
  const currentPeriod = BigInt(Math.floor(runtimeMs / Number(periodSeconds)));
  return 1_000_000_000_000_000_000n + (subTag << 32n) + currentPeriod;
}

async function getLatestBlockTimeMs(rpcClient) {
  try {
    const latestHeight =
      Number(
        await withRpcRetry("rpc.getBlockCount", () =>
          rpcClient.getBlockCount(),
        ),
      ) - 1;
    const block = await withRpcRetry("rpc.getBlock", () =>
      rpcClient.getBlock(latestHeight, 1),
    );
    const raw = Number(block?.time ?? block?.timestamp ?? 0);
    if (Number.isFinite(raw) && raw > 0) return raw;
  } catch {
    // fall back to local wall clock if the RPC helper is unavailable
  }
  return Date.now();
}

function assertFaultResult(result, label, pattern) {
  const state = String(result?.state || "");
  if (!state.includes("FAULT")) {
    throw new Error(`${label}: expected FAULT, got ${state}`);
  }
  if (pattern && !pattern.test(String(result?.exception || ""))) {
    throw new Error(
      `${label}: unexpected exception ${result?.exception || ""}`,
    );
  }
  return { state, exception: result?.exception || "" };
}

async function initiatePendingVerifierCall(
  rpcClient,
  core,
  account,
  networkMagic,
  accountId,
  method,
  args,
) {
  const request = await invokePersisted(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    "callVerifier",
    [hash160Param(accountId), stringParam(method), arrayParam(args)],
  );
  const confirmationPreview = await testInvoke(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    "callVerifier",
    [hash160Param(accountId), stringParam(method), arrayParam(args)],
    [makeSigner(account.scriptHash)],
  );
  return {
    requestTxid: request.txid,
    requestResult: stackItemToText(request.execution.stack?.[0]),
    pending: assertFaultResult(
      confirmationPreview,
      `callVerifier.${method}.pending`,
      /Timelock not elapsed/,
    ),
  };
}

async function initiatePendingHookCall(
  rpcClient,
  core,
  account,
  networkMagic,
  accountId,
  method,
  args,
) {
  const request = await invokePersisted(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    "callHook",
    [hash160Param(accountId), stringParam(method), arrayParam(args)],
  );
  const confirmationPreview = await testInvoke(
    rpcClient,
    core.hash,
    account,
    networkMagic,
    "callHook",
    [hash160Param(accountId), stringParam(method), arrayParam(args)],
    [makeSigner(account.scriptHash)],
  );
  return {
    requestTxid: request.txid,
    requestResult: stackItemToText(request.execution.stack?.[0]),
    pending: assertFaultResult(
      confirmationPreview,
      `callHook.${method}.pending`,
      /Timelock not elapsed/,
    ),
  };
}

async function main() {
  RPC_URL = await resolveTestnetRpcUrl({ env: process.env });
  const account = new wallet.Account(TEST_WIF);
  const rpcClient = new rpc.RPCClient(RPC_URL);
  const version = await withRpcRetry("rpc.getVersion", () =>
    rpcClient.getVersion(),
  );
  const networkMagic = Number(version.protocol.network);
  const deploymentTag =
    process.env.AA_VALIDATION_DEPLOY_TAG ||
    `validation-plugin-matrix-${validationRunId()}`;
  const results = {
    env: {
      rpc: RPC_URL,
      networkMagic,
      address: account.address,
      scriptHash: normalizeHash(account.scriptHash),
      selectedScenarios: Array.from(SELECTED_SCENARIOS),
    },
    deployments: {},
    matrix: {},
  };
  const reportFileName = SELECTED_SCENARIOS.size
    ? `v3-testnet-plugin-matrix.${Array.from(SELECTED_SCENARIOS).join("_")}.json`
    : "v3-testnet-plugin-matrix.latest.json";
  const reportPath = path.join(REPORT_DIR, reportFileName);
  latestReportContext = { results, reportPath };

  console.log(JSON.stringify(results.env, null, 2));

  const runDirectConfig = shouldRunScenario("direct-config");
  const runWeb3Auth = shouldRunScenario("web3auth");
  const runTee = shouldRunScenario("tee");
  const runWebAuthn = shouldRunScenario("webauthn");
  const runSessionKey = shouldRunScenario("session-key");
  const runMultiSig = shouldRunScenario("multisig");
  const runSubscription = shouldRunScenario("subscription");
  const runZkEmail = shouldRunScenario("zkemail");
  const runWhitelistHook = shouldRunScenario("whitelist-hook");
  const runDailyLimit = shouldRunScenario("daily-limit");
  const runTokenRestricted = shouldRunScenario("token-restricted");
  const runMultiHook = shouldRunScenario("multihook");
  const runNeoDidHook = shouldRunScenario("neodid-hook");

  const needWeb3AuthA = runDirectConfig || runWeb3Auth;
  const needWeb3AuthB = runWeb3Auth;
  const needTeeVerifier = runTee;
  const needWebAuthnVerifier = runWebAuthn;
  const needSessionKeyVerifier = runSessionKey;
  const needMultiSigVerifier = runMultiSig;
  const needSubscriptionVerifier = runSubscription;
  const needZkEmailVerifier = runZkEmail;
  const needWhitelistHook = runDirectConfig || runWhitelistHook || runMultiHook;
  const needDailyLimitHook = runDailyLimit;
  const needTokenRestrictedHook = runTokenRestricted || runMultiHook;
  const needMultiHook = runMultiHook;
  const needNeoDidHook = runNeoDidHook;
  const needNeoDidRegistry = runNeoDidHook;
  const needMockTarget =
    runDirectConfig ||
    runWeb3Auth ||
    runTee ||
    runWebAuthn ||
    runSessionKey ||
    runMultiSig ||
    runSubscription ||
    runZkEmail ||
    runWhitelistHook ||
    runDailyLimit ||
    runTokenRestricted ||
    runMultiHook ||
    runNeoDidHook;

  logSection("Deploy Contracts");
  const core = await deployContract(
    rpcClient,
    account,
    networkMagic,
    "UnifiedSmartWalletV3",
    `${deploymentTag}-core`,
  );
  const web3AuthA = needWeb3AuthA
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "Web3AuthVerifier",
        `${deploymentTag}-web3auth-a`,
      )
    : null;
  const web3AuthB = needWeb3AuthB
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "Web3AuthVerifier",
        `${deploymentTag}-web3auth-b`,
      )
    : null;
  const teeVerifier = needTeeVerifier
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "TEEVerifier",
        `${deploymentTag}-tee`,
      )
    : null;
  const webAuthnVerifier = needWebAuthnVerifier
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "WebAuthnVerifier",
        `${deploymentTag}-webauthn`,
      )
    : null;
  const sessionKeyVerifier = needSessionKeyVerifier
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "SessionKeyVerifier",
        `${deploymentTag}-session-key`,
      )
    : null;
  const multiSigVerifier = needMultiSigVerifier
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "MultiSigVerifier",
        `${deploymentTag}-multisig`,
      )
    : null;
  const subscriptionVerifier = needSubscriptionVerifier
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "SubscriptionVerifier",
        `${deploymentTag}-subscription`,
      )
    : null;
  const zkEmailVerifier = needZkEmailVerifier
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "ZKEmailVerifier",
        `${deploymentTag}-zkemail`,
      )
    : null;
  const whitelistHook = needWhitelistHook
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "WhitelistHook",
        `${deploymentTag}-whitelist`,
      )
    : null;
  const dailyLimitHook = needDailyLimitHook
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "DailyLimitHook",
        `${deploymentTag}-daily-limit`,
      )
    : null;
  const tokenRestrictedHook = needTokenRestrictedHook
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "TokenRestrictedHook",
        `${deploymentTag}-token-restricted`,
      )
    : null;
  const multiHook = needMultiHook
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "MultiHook",
        `${deploymentTag}-multi-hook`,
      )
    : null;
  const neoDidHook = needNeoDidHook
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "NeoDIDCredentialHook",
        `${deploymentTag}-neodid-hook`,
      )
    : null;
  const neoDidRegistry = needNeoDidRegistry
    ? await deployOracleContract(
        rpcClient,
        account,
        networkMagic,
        "NeoDIDRegistry",
        `${deploymentTag}-neodid-registry`,
      )
    : null;
  const mockTarget = needMockTarget
    ? await deployContract(
        rpcClient,
        account,
        networkMagic,
        "MockTransferTarget",
        `${deploymentTag}-mock-target`,
      )
    : null;

  if (web3AuthA)
    await authorizeVerifier(
      rpcClient,
      core.hash,
      web3AuthA.hash,
      account,
      networkMagic,
    );
  if (web3AuthB)
    await authorizeVerifier(
      rpcClient,
      core.hash,
      web3AuthB.hash,
      account,
      networkMagic,
    );
  if (teeVerifier)
    await authorizeVerifier(
      rpcClient,
      core.hash,
      teeVerifier.hash,
      account,
      networkMagic,
    );
  if (webAuthnVerifier)
    await authorizeVerifier(
      rpcClient,
      core.hash,
      webAuthnVerifier.hash,
      account,
      networkMagic,
    );
  if (sessionKeyVerifier)
    await authorizeVerifier(
      rpcClient,
      core.hash,
      sessionKeyVerifier.hash,
      account,
      networkMagic,
    );
  if (multiSigVerifier)
    await authorizeVerifier(
      rpcClient,
      core.hash,
      multiSigVerifier.hash,
      account,
      networkMagic,
    );
  if (subscriptionVerifier)
    await authorizeVerifier(
      rpcClient,
      core.hash,
      subscriptionVerifier.hash,
      account,
      networkMagic,
    );
  if (zkEmailVerifier)
    await authorizeVerifier(
      rpcClient,
      core.hash,
      zkEmailVerifier.hash,
      account,
      networkMagic,
    );

  if (whitelistHook)
    await authorizeHook(
      rpcClient,
      core.hash,
      whitelistHook.hash,
      account,
      networkMagic,
    );
  if (dailyLimitHook)
    await authorizeHook(
      rpcClient,
      core.hash,
      dailyLimitHook.hash,
      account,
      networkMagic,
    );
  if (tokenRestrictedHook)
    await authorizeHook(
      rpcClient,
      core.hash,
      tokenRestrictedHook.hash,
      account,
      networkMagic,
    );
  if (multiHook)
    await authorizeHook(
      rpcClient,
      core.hash,
      multiHook.hash,
      account,
      networkMagic,
    );
  if (neoDidHook)
    await authorizeHook(
      rpcClient,
      core.hash,
      neoDidHook.hash,
      account,
      networkMagic,
    );

  Object.assign(results.deployments, {
    core,
    web3AuthA,
    web3AuthB,
    teeVerifier,
    webAuthnVerifier,
    sessionKeyVerifier,
    multiSigVerifier,
    subscriptionVerifier,
    zkEmailVerifier,
    whitelistHook,
    dailyLimitHook,
    tokenRestrictedHook,
    multiHook,
    neoDidHook,
    neoDidRegistry,
    mockTarget,
  });
  console.log(JSON.stringify(results.deployments, null, 2));

  if (neoDidRegistry) {
    await invokePersisted(
      rpcClient,
      neoDidRegistry.hash,
      account,
      networkMagic,
      "setVerifier",
      [sc.ContractParam.publicKey(account.publicKey)],
    );
  }

  const aaClient = new AbstractAccountClient(RPC_URL, core.hash);

  async function registerAccount(label, options = {}) {
    const initialVerifier = normalizeHash(options.verifier || "0".repeat(40));
    const initialVerifierParams = sanitizeHex(options.verifierParams || "");
    const registrationSalt = !initialVerifierParams && initialVerifier === "0x0000000000000000000000000000000000000000"
      ? crypto.createHash("sha256").update(`plugin-matrix:${label}`).digest("hex").slice(0, 64)
      : "";
    const effectiveVerifierParams = initialVerifierParams || registrationSalt;
    const initialHook = normalizeHash(options.hook || "0".repeat(40));
    const accountId = aaClient.deriveRegistrationAccountIdHash({
      verifierContractHash: initialVerifier,
      verifierParamsHex: effectiveVerifierParams,
      hookContractHash: initialHook,
      backupOwnerAddress: account.scriptHash,
      escapeTimelock: REGISTRATION_ESCAPE_TIMELOCK,
    });
    const virtual = aaClient.deriveVirtualAccount(accountId);
    const register = await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "registerAccount",
      [
        hash160Param(accountId),
        hash160Param(sanitizeHex(initialVerifier || "0".repeat(40))),
        effectiveVerifierParams
          ? byteArrayParam(effectiveVerifierParams)
          : emptyByteArrayParam(),
        hash160Param(sanitizeHex(initialHook || "0".repeat(40))),
        hash160Param(account.scriptHash),
        integerParam(REGISTRATION_ESCAPE_TIMELOCK),
      ],
    );
    return {
      label,
      accountId,
      virtualAddress: virtual.address,
      virtualScriptHash: virtual.scriptHash,
      registerTxid: register.txid,
    };
  }

  async function getNonce(accountId) {
    const stack = await readAndDecode(rpcClient, core.hash, "getNonce", [
      hash160Param(accountId),
      integerParam(0),
    ]);
    return BigInt(stack.value || "0");
  }

  async function computeArgsHash(args) {
    const stack = await readAndDecode(rpcClient, core.hash, "computeArgsHash", [
      arrayParam(args),
    ]);
    return Buffer.from(stack.value || "", "base64").toString("hex");
  }

  async function directFault(contractHash, operation, params, pattern) {
    const result = await testInvoke(
      rpcClient,
      contractHash,
      account,
      networkMagic,
      operation,
      params,
      [makeSigner(account.scriptHash)],
    );
    return assertFaultResult(
      result,
      `${sanitizeHex(contractHash)}.${operation}`,
      pattern,
    );
  }

  if (SELECTED_SCENARIOS.size) {
    if (shouldRunScenario("daily-limit")) {
      logSection("Daily Limit Hook");
      {
        console.log("[daily-limit] registerAccount:start");
        const scenario = await registerAccount("daily-limit");
        console.log(
          "[daily-limit] registerAccount:done",
          normalizeHash(scenario.accountId),
        );
        console.log("[daily-limit] updateHook:start");
        await invokePersisted(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "updateHook",
          [hash160Param(scenario.accountId), hash160Param(dailyLimitHook.hash)],
        );
        console.log("[daily-limit] updateHook:done");
        console.log("[daily-limit] setDailyLimit:start");
        const pendingConfig = await initiatePendingHookCall(
          rpcClient,
          core,
          account,
          networkMagic,
          scenario.accountId,
          "setDailyLimit",
          [
            hash160Param(scenario.accountId),
            hash160Param(mockTarget.hash),
            integerParam(100),
            boolParam(false),
          ],
        );
        console.log("[daily-limit] setDailyLimit:done");
        console.log("[daily-limit] exec1:start");
        const exec1 = await invokePersisted(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "executeUserOp",
          [
            hash160Param(scenario.accountId),
            userOpParam({
              targetContract: mockTarget.hash,
              method: "transfer",
              args: [
                hash160Param(scenario.accountId),
                hash160Param(account.scriptHash),
                integerParam(40),
                stringParam("one"),
              ],
              nonce: 0n,
              deadline: BigInt(Date.now() + 60 * 60 * 1000),
              signatureHex: "",
            }),
          ],
        );
        console.log("[daily-limit] exec1:done", exec1.txid);
        console.log("[daily-limit] overflow:start");
        const overflow = await testInvoke(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "executeUserOp",
          [
            hash160Param(scenario.accountId),
            userOpParam({
              targetContract: mockTarget.hash,
              method: "transfer",
              args: [
                hash160Param(scenario.accountId),
                hash160Param(account.scriptHash),
                integerParam(61),
                stringParam("two"),
              ],
              nonce: 1n,
              deadline: BigInt(Date.now() + 60 * 60 * 1000),
              signatureHex: "",
            }),
          ],
          [makeSigner(account.scriptHash)],
        );
        console.log(
          "[daily-limit] overflow:done",
          overflow?.state || "unknown",
        );
        console.log("[daily-limit] wrongSource:start");
        const wrongSource = await testInvoke(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "executeUserOp",
          [
            hash160Param(scenario.accountId),
            userOpParam({
              targetContract: mockTarget.hash,
              method: "transfer",
              args: [
                hash160Param(account.scriptHash),
                hash160Param(account.scriptHash),
                integerParam(1),
                stringParam("bad-source"),
              ],
              nonce: 1n,
              deadline: BigInt(Date.now() + 60 * 60 * 1000),
              signatureHex: "",
            }),
          ],
          [makeSigner(account.scriptHash)],
        );
        console.log(
          "[daily-limit] wrongSource:done",
          wrongSource?.state || "unknown",
        );
        results.matrix.dailyLimitHook = {
          accountId: normalizeHash(scenario.accountId),
          maintenance: pendingConfig,
          txid: exec1.txid,
          result: String(exec1.execution.stack?.[0]?.value ?? ""),
          note:
            "The hook installs immediately, but the configured ceiling is deferred behind the maintenance timelock; same-session transfers still use the unconfigured default path.",
        };
        console.log(JSON.stringify(results.matrix.dailyLimitHook, null, 2));
      }
    }

    if (shouldRunScenario("multihook")) {
      logSection("MultiHook");
      {
        console.log("[multihook] registerAccount:start");
        const scenario = await registerAccount("multihook", {
          hook: multiHook.hash,
        });
        console.log(
          "[multihook] registerAccount:done",
          normalizeHash(scenario.accountId),
        );
        console.log("[multihook] setHooks:start");
        const pendingConfig = await initiatePendingHookCall(
          rpcClient,
          core,
          account,
          networkMagic,
          scenario.accountId,
          "setHooks",
          [
            hash160Param(scenario.accountId),
            arrayParam([
              hash160Param(whitelistHook.hash),
              hash160Param(tokenRestrictedHook.hash),
            ]),
          ],
        );
        console.log("[multihook] setHooks:done", pendingConfig.requestTxid);
        const storedHooks = await readAndDecode(
          rpcClient,
          multiHook.hash,
          "getHooks",
          [hash160Param(scenario.accountId)],
        );
        console.log("[multihook] getHooks:done");
        console.log("[multihook] blocked:start");
        const blocked = await testInvoke(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "executeUserOp",
          [
            hash160Param(scenario.accountId),
            userOpParam({
              targetContract: mockTarget.hash,
              method: "symbol",
              args: [],
              nonce: 0n,
              deadline: BigInt(Date.now() + 60 * 60 * 1000),
              signatureHex: "",
            }),
          ],
          [makeSigner(account.scriptHash)],
        );
        console.log("[multihook] blocked:done", blocked?.state || "unknown");
        console.log("[multihook] duplicateHooks:start");
        const duplicateHooks = await testInvoke(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "callHook",
          [
            hash160Param(scenario.accountId),
            stringParam("setHooks"),
            arrayParam([
              hash160Param(scenario.accountId),
              arrayParam([
                hash160Param(whitelistHook.hash),
                hash160Param(whitelistHook.hash),
              ]),
            ]),
          ],
          [makeSigner(account.scriptHash)],
        );
        console.log(
          "[multihook] duplicateHooks:done",
          duplicateHooks?.state || "unknown",
        );
        console.log("[multihook] selfHook:start");
        const selfHook = await testInvoke(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "callHook",
          [
            hash160Param(scenario.accountId),
            stringParam("setHooks"),
            arrayParam([
              hash160Param(scenario.accountId),
              arrayParam([hash160Param(multiHook.hash)]),
            ]),
          ],
          [makeSigner(account.scriptHash)],
        );
        console.log("[multihook] selfHook:done", selfHook?.state || "unknown");
        console.log("[multihook] tooManyHooks:start");
        const tooManyHooks = await testInvoke(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "callHook",
          [
            hash160Param(scenario.accountId),
            stringParam("setHooks"),
            arrayParam([
              hash160Param(scenario.accountId),
              arrayParam([
                hash160Param(whitelistHook.hash),
                hash160Param(tokenRestrictedHook.hash),
                hash160Param(whitelistHook.hash),
                hash160Param(tokenRestrictedHook.hash),
                hash160Param(whitelistHook.hash),
                hash160Param(tokenRestrictedHook.hash),
                hash160Param(whitelistHook.hash),
                hash160Param(tokenRestrictedHook.hash),
                hash160Param(mockTarget.hash),
              ]),
            ]),
          ],
          [makeSigner(account.scriptHash)],
        );
        console.log(
          "[multihook] tooManyHooks:done",
          tooManyHooks?.state || "unknown",
        );
        results.matrix.multiHook = {
          accountId: normalizeHash(scenario.accountId),
          maintenance: pendingConfig,
          hookCount: Array.isArray(storedHooks?.value)
            ? storedHooks.value.length
            : 0,
          unconfiguredExecutionState: String(blocked?.state || ""),
          duplicateHooks: { state: String(duplicateHooks?.state || ""), exception: duplicateHooks?.exception || "" },
          selfHook: { state: String(selfHook?.state || ""), exception: selfHook?.exception || "" },
          tooManyHooks: { state: String(tooManyHooks?.state || ""), exception: tooManyHooks?.exception || "" },
          note:
            "MultiHook composition is deferred behind the maintenance timelock; stored hook sets remain unchanged in the same live session.",
        };
        console.log(JSON.stringify(results.matrix.multiHook, null, 2));
      }
    }

    if (shouldRunScenario("neodid-hook")) {
      logSection("NeoDID Credential Hook");
      {
        console.log("[neodid-hook] registerAccount:start");
        const scenario = await registerAccount("neodid-hook");
        console.log(
          "[neodid-hook] registerAccount:done",
          normalizeHash(scenario.accountId),
        );
        console.log("[neodid-hook] updateHook:start");
        await invokePersisted(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "updateHook",
          [hash160Param(scenario.accountId), hash160Param(neoDidHook.hash)],
        );
        console.log("[neodid-hook] updateHook:done");
        console.log("[neodid-hook] setRegistry:start");
        await invokePersisted(
          rpcClient,
          neoDidHook.hash,
          account,
          networkMagic,
          "setRegistry",
          [hash160Param(neoDidRegistry.hash)],
        );
        console.log("[neodid-hook] setRegistry:done");
        console.log("[neodid-hook] requireCredential:start");
        const pendingConfig = await initiatePendingHookCall(
          rpcClient,
          core,
          account,
          networkMagic,
          scenario.accountId,
          "requireCredentialCommitmentForContract",
          [
            hash160Param(scenario.accountId),
            hash160Param(mockTarget.hash),
            stringParam("github"),
            stringParam("Github_VerifiedUser"),
            byteArrayParam("0x" + "11".repeat(32)),
          ],
        );
        console.log("[neodid-hook] requireCredential:done");
        console.log("[neodid-hook] missing:start");
        const missing = await testInvoke(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "executeUserOp",
          [
            hash160Param(scenario.accountId),
            userOpParam({
              targetContract: mockTarget.hash,
              method: "symbol",
              args: [],
              nonce: 0n,
              deadline: BigInt(Date.now() + 60 * 60 * 1000),
              signatureHex: "",
            }),
          ],
          [makeSigner(account.scriptHash)],
        );
        const masterNullifier = sanitizeHex(
          crypto.randomBytes(32).toString("hex"),
        );
        const metadataHash = sanitizeHex(
          crypto.randomBytes(32).toString("hex"),
        );
        const claimCommitment = Buffer.alloc(32, 0x11);
        const bindingDigest = buildNeoDidBindingCommitmentDigest({
          vaultAccount: scenario.accountId,
          provider: "github",
          claimType: "Github_VerifiedUser",
          claimCommitmentHex: claimCommitment.toString("hex"),
          masterNullifierHex: masterNullifier,
          metadataHashHex: metadataHash,
          networkMagic,
        });
        const bindingSignature = wallet.sign(
          bindingDigest.toString("hex"),
          account.privateKey,
        );
        await invokePersisted(
          rpcClient,
          neoDidRegistry.hash,
          account,
          networkMagic,
          "registerBindingCommitment",
          [
            hash160Param(scenario.accountId),
            stringParam("github"),
            stringParam("Github_VerifiedUser"),
            byteArrayParam(claimCommitment.toString("hex")),
            byteArrayParam(masterNullifier),
            byteArrayParam(metadataHash),
            byteArrayParam(bindingSignature),
          ],
        );
        const success = await invokePersisted(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "executeUserOp",
          [
            hash160Param(scenario.accountId),
            userOpParam({
              targetContract: mockTarget.hash,
              method: "symbol",
              args: [],
              nonce: 0n,
              deadline: BigInt(Date.now() + 60 * 60 * 1000),
              signatureHex: "",
            }),
          ],
        );
        await invokePersisted(
          rpcClient,
          neoDidRegistry.hash,
          account,
          networkMagic,
          "revokeBinding",
          [
            hash160Param(scenario.accountId),
            stringParam("github"),
            stringParam("Github_VerifiedUser"),
          ],
        );
        const revoked = await testInvoke(
          rpcClient,
          core.hash,
          account,
          networkMagic,
          "executeUserOp",
          [
            hash160Param(scenario.accountId),
            userOpParam({
              targetContract: mockTarget.hash,
              method: "symbol",
              args: [],
              nonce: 1n,
              deadline: BigInt(Date.now() + 60 * 60 * 1000),
              signatureHex: "",
            }),
          ],
          [makeSigner(account.scriptHash)],
        );
        results.matrix.neoDidCredentialHook = {
          accountId: normalizeHash(scenario.accountId),
          registry: normalizeHash(neoDidRegistry.hash),
          maintenance: pendingConfig,
          txid: success.txid,
          result: stackItemToText(success.execution.stack?.[0]),
          missing: { state: String(missing?.state || ""), exception: missing?.exception || "" },
          revoked: { state: String(revoked?.state || ""), exception: revoked?.exception || "" },
          note:
            "Credential requirement activation is deferred behind the hook maintenance timelock; registry binding and revocation still execute live.",
        };
        console.log(
          JSON.stringify(results.matrix.neoDidCredentialHook, null, 2),
        );
      }
    }

    writePluginMatrixReport(latestReportContext, "passed");
    logSection("Report");
    console.log(reportPath);
    console.log(
      JSON.stringify(
        {
          reportPath,
          core: core.hash,
          mockTarget: mockTarget.hash,
          scenarios: Object.keys(results.matrix),
        },
        null,
        2,
      ),
    );
    return;
  }

  logSection("Direct Config Attack Surface");
  results.matrix.directConfigGuards = {
    whitelistDirectSet: await directFault(
      whitelistHook.hash,
      "setWhitelist",
      [
        hash160Param(randomAccountId()),
        hash160Param(mockTarget.hash),
        boolParam(true),
      ],
      /(Unauthorized|not found|Called Contract Does Not Exist)/,
    ),
    web3AuthDirectSet: await directFault(
      web3AuthA.hash,
      "setPublicKey",
      [
        hash160Param(randomAccountId()),
        byteArrayParam(
          sanitizeHex(ethers.Wallet.createRandom().signingKey.publicKey),
        ),
      ],
      /(Unauthorized|not found|Called Contract Does Not Exist)/,
    ),
  };
  console.log(JSON.stringify(results.matrix.directConfigGuards, null, 2));

  logSection("Web3Auth Verifier");
  {
    const scenario = await registerAccount("web3auth");
    const signer = ethers.Wallet.createRandom();
    const pubKey = sanitizeHex(signer.signingKey.publicKey);
    await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "updateVerifier",
      [
        hash160Param(scenario.accountId),
        hash160Param(web3AuthA.hash),
        byteArrayParam(pubKey),
      ],
    );

    const nonce = await getNonce(scenario.accountId);
    const argsHash = await computeArgsHash([]);
    const deadline = Date.now() + 60 * 60 * 1000;
    const typedData = buildV3UserOperationTypedData({
      chainId: networkMagic,
      verifyingContract: sanitizeHex(web3AuthA.hash),
      accountIdHash: scenario.accountId,
      coreContractHash: sanitizeHex(core.hash),
      targetContract: mockTarget.hash,
      method: "symbol",
      argsHashHex: argsHash,
      nonce,
      deadline,
    });
    const signature = compactSignature(
      await signer.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message,
      ),
    );
    const success = await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce,
          deadline: BigInt(deadline),
          signatureHex: signature,
        }),
      ],
    );

    const tampered = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "balanceOf",
          args: [hash160Param(account.scriptHash)],
          nonce: nonce + 1n,
          deadline: BigInt(deadline),
          signatureHex: signature,
        }),
      ],
    );
    const replay = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce,
          deadline: BigInt(deadline),
          signatureHex: signature,
        }),
      ],
    );

    results.matrix.web3Auth = {
      accountId: normalizeHash(scenario.accountId),
      txid: success.txid,
      result: stackItemToText(success.execution.stack?.[0]),
      tampered: assertFaultResult(
        tampered,
        "web3auth.tampered",
        /Verifier rejected signature/,
      ),
      replay: assertFaultResult(
        replay,
        "web3auth.replay",
        /Invalid sequence for channel|Salt already used/,
      ),
    };
    console.log(JSON.stringify(results.matrix.web3Auth, null, 2));
  }

  async function runP256VerifierScenario(
    name,
    verifierHash,
    verifierKeyHex = "",
  ) {
    const scenario = await registerAccount(name);
    await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "updateVerifier",
      [
        hash160Param(scenario.accountId),
        hash160Param(verifierHash),
        byteArrayParam(verifierKeyHex || account.publicKey),
      ],
    );
    const nonce = await getNonce(scenario.accountId);
    const deadline = Date.now() + 60 * 60 * 1000;
    const args = [];
    const payloadStack = await readAndDecode(
      rpcClient,
      verifierHash,
      "getPayload",
      [
        hash160Param(scenario.accountId),
        hash160Param(mockTarget.hash),
        stringParam("symbol"),
        arrayParam(args),
        integerParam(nonce),
        integerParam(deadline),
      ],
    );
    const payload = Buffer.from(payloadStack.value || "", "base64");
    const signature = wallet.sign(payload.toString("hex"), account.privateKey);
    const success = await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args,
          nonce,
          deadline: BigInt(deadline),
          signatureHex: signature,
        }),
      ],
    );
    const tampered = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "transfer",
          args: [],
          nonce: nonce + 1n,
          deadline: BigInt(deadline),
          signatureHex: signature,
        }),
      ],
    );
    return {
      accountId: normalizeHash(scenario.accountId),
      txid: success.txid,
      result: stackItemToText(success.execution.stack?.[0]),
      tampered: assertFaultResult(
        tampered,
        `${name}.tampered`,
        /Verifier rejected signature|Method not permitted|Target contract not permitted|Invalid signature/,
      ),
      raw: scenario,
    };
  }

  logSection("TEE Verifier");
  {
    const tee = await runP256VerifierScenario("tee", teeVerifier.hash);
    results.matrix.teeVerifier = {
      accountId: tee.accountId,
      txid: tee.txid,
      result: tee.result,
      tampered: tee.tampered,
    };
    console.log(JSON.stringify(results.matrix.teeVerifier, null, 2));
  }

  logSection("WebAuthn Verifier");
  {
    const webauthn = await runP256VerifierScenario(
      "webauthn",
      webAuthnVerifier.hash,
    );
    results.matrix.webAuthnVerifier = {
      accountId: webauthn.accountId,
      txid: webauthn.txid,
      result: webauthn.result,
      tampered: webauthn.tampered,
    };
    console.log(JSON.stringify(results.matrix.webAuthnVerifier, null, 2));
  }

  logSection("Session Key Verifier");
  {
    const scenario = await registerAccount("session-key", {
      verifier: sessionKeyVerifier.hash,
    });
    const validUntil = 2_000_000_000_000n;
    const pendingConfig = await initiatePendingVerifierCall(
      rpcClient,
      core,
      account,
      networkMagic,
      scenario.accountId,
      "setSessionKey",
      [
        hash160Param(scenario.accountId),
        byteArrayParam(account.publicKey),
        hash160Param(mockTarget.hash),
        stringParam("symbol"),
        integerParam(validUntil),
        integerParam(0),
        stringParam("session-key"),
      ],
    );
    const nonce = await getNonce(scenario.accountId);
    const deadline = Date.now() + 60 * 60 * 1000;
    const payloadStack = await readAndDecode(
      rpcClient,
      sessionKeyVerifier.hash,
      "getPayload",
      [
        hash160Param(scenario.accountId),
        hash160Param(mockTarget.hash),
        stringParam("symbol"),
        arrayParam([]),
        integerParam(nonce),
        integerParam(deadline),
      ],
    );
    const payload = Buffer.from(payloadStack.value || "", "base64");
    const signature = wallet.sign(payload.toString("hex"), account.privateKey);
    const activationBlocked = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce,
          deadline: BigInt(deadline),
          signatureHex: signature,
        }),
      ],
    );

    results.matrix.sessionKeyVerifier = {
      accountId: normalizeHash(scenario.accountId),
      maintenance: pendingConfig,
      activationBlocked: assertFaultResult(
        activationBlocked,
        "session.activationBlocked",
        /No session key active/,
      ),
      note:
        "Session key activation is timelocked and cannot become active in the same live session.",
    };
    console.log(JSON.stringify(results.matrix.sessionKeyVerifier, null, 2));
  }

  logSection("MultiSig Verifier");
  {
    const scenario = await registerAccount("multisig", {
      verifier: multiSigVerifier.hash,
    });
    const pendingConfig = await initiatePendingVerifierCall(
      rpcClient,
      core,
      account,
      networkMagic,
      scenario.accountId,
      "setConfig",
      [
        hash160Param(scenario.accountId),
        arrayParam([
          hash160Param(web3AuthA.hash),
          hash160Param(web3AuthB.hash),
        ]),
        integerParam(2),
      ],
    );
    const inactive = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce: 0n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: Buffer.from(JSON.stringify(["", ""]), "utf8").toString("hex"),
        }),
      ],
    );

    results.matrix.multiSigVerifier = {
      accountId: normalizeHash(scenario.accountId),
      maintenance: pendingConfig,
      inactive: assertFaultResult(
        inactive,
        "multisig.inactive",
        /No MultiSig config|Verifier rejected signature/,
      ),
      note: "MultiSig child verifier configuration is timelocked and cannot become active in the same live session.",
    };
    console.log(JSON.stringify(results.matrix.multiSigVerifier, null, 2));
  }

  logSection("Subscription Verifier");
  {
    const scenario = await registerAccount("subscription", {
      verifier: subscriptionVerifier.hash,
    });
    const subId = Buffer.from(ethers.randomBytes(8)).toString("hex");
    const periodSeconds = 3600n;
    const pendingConfig = await initiatePendingVerifierCall(
      rpcClient,
      core,
      account,
      networkMagic,
      scenario.accountId,
      "createSubscription",
      [
        hash160Param(scenario.accountId),
        byteArrayParam(subId),
        hash160Param(account.scriptHash),
        hash160Param(mockTarget.hash),
        integerParam(100),
        integerParam(periodSeconds),
      ],
    );

    const chainNowMs = await getLatestBlockTimeMs(rpcClient);
    const inactive = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "transfer",
          args: [
            hash160Param(scenario.virtualScriptHash),
            hash160Param(account.scriptHash),
            integerParam(50),
            stringParam("sub"),
          ],
          nonce: expectedSubscriptionNonce(subId, periodSeconds, chainNowMs),
          deadline: BigInt(chainNowMs + 60 * 60 * 1000),
          signatureHex: subId,
        }),
      ],
    );

    results.matrix.subscriptionVerifier = {
      accountId: normalizeHash(scenario.accountId),
      maintenance: pendingConfig,
      inactive: assertFaultResult(
        inactive,
        "subscription.inactive",
        /Subscription not found/,
      ),
      note: "Subscription creation is timelocked and cannot become active in the same live session.",
    };
    console.log(JSON.stringify(results.matrix.subscriptionVerifier, null, 2));
  }

  logSection("ZKEmail Verifier");
  {
    const scenario = await registerAccount("zkemail", {
      verifier: zkEmailVerifier.hash,
    });
    const pendingConfig = await initiatePendingVerifierCall(
      rpcClient,
      core,
      account,
      networkMagic,
      scenario.accountId,
      "setDKIMRegistry",
      [hash160Param(scenario.accountId), byteArrayParam("aa")],
    );

    const inactive = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce: 0n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "ff",
        }),
      ],
    );

    results.matrix.zkEmailVerifier = {
      accountId: normalizeHash(scenario.accountId),
      maintenance: pendingConfig,
      inactive: assertFaultResult(
        inactive,
        "zkemail.inactive",
        /No DKIM configured/,
      ),
      note: "DKIM registry configuration is timelocked; same-session live runs cannot reach the disabled-proof branch.",
    };
    console.log(JSON.stringify(results.matrix.zkEmailVerifier, null, 2));
  }

  logSection("Whitelist Hook");
  {
    const scenario = await registerAccount("whitelist-hook");
    await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "updateHook",
      [hash160Param(scenario.accountId), hash160Param(whitelistHook.hash)],
    );
    const denied = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce: 0n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "",
        }),
      ],
      [makeSigner(account.scriptHash)],
    );
    const pendingConfig = await initiatePendingHookCall(
      rpcClient,
      core,
      account,
      networkMagic,
      scenario.accountId,
      "setWhitelist",
      [
        hash160Param(scenario.accountId),
        hash160Param(mockTarget.hash),
        boolParam(true),
      ],
    );
    const stillBlocked = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce: 0n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "",
        }),
      ],
    );
    results.matrix.whitelistHook = {
      accountId: normalizeHash(scenario.accountId),
      maintenance: pendingConfig,
      denied: assertFaultResult(
        denied,
        "whitelist.denied",
        /Target contract not in whitelist/,
      ),
      stillBlocked: assertFaultResult(
        stillBlocked,
        "whitelist.stillBlocked",
        /Target contract not in whitelist|Native witness failed/,
      ),
      note: "Whitelist activation is timelocked; same-session execution remains blocked.",
    };
    console.log(JSON.stringify(results.matrix.whitelistHook, null, 2));
  }

  logSection("Daily Limit Hook");
  {
    const scenario = await registerAccount("daily-limit");
    await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "updateHook",
      [hash160Param(scenario.accountId), hash160Param(dailyLimitHook.hash)],
    );
    const pendingConfig = await initiatePendingHookCall(
      rpcClient,
      core,
      account,
      networkMagic,
      scenario.accountId,
      "setDailyLimit",
      [
        hash160Param(scenario.accountId),
        hash160Param(mockTarget.hash),
        integerParam(100),
        boolParam(false),
      ],
    );
    const exec1 = await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "transfer",
          args: [
            hash160Param(scenario.accountId),
            hash160Param(account.scriptHash),
            integerParam(40),
            stringParam("one"),
          ],
          nonce: 0n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "",
        }),
      ],
    );
    results.matrix.dailyLimitHook = {
      accountId: normalizeHash(scenario.accountId),
      maintenance: pendingConfig,
      txid: exec1.txid,
      result: String(exec1.execution.stack?.[0]?.value ?? ""),
      note: "The hook installs immediately, but the configured ceiling is deferred behind the maintenance timelock; same-session transfers still use the unconfigured default path.",
    };
    console.log(JSON.stringify(results.matrix.dailyLimitHook, null, 2));
  }

  logSection("Token Restricted Hook");
  {
    const scenario = await registerAccount("token-restricted");
    await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "updateHook",
      [
        hash160Param(scenario.accountId),
        hash160Param(tokenRestrictedHook.hash),
      ],
    );
    const pendingConfig = await initiatePendingHookCall(
      rpcClient,
      core,
      account,
      networkMagic,
      scenario.accountId,
      "setRestrictedToken",
      [
        hash160Param(scenario.accountId),
        hash160Param(GAS_HASH),
        boolParam(true),
      ],
    );
    const success = await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce: 0n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "",
        }),
      ],
    );
    const restricted = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: GAS_HASH,
          method: "symbol",
          args: [],
          nonce: 1n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "",
        }),
      ],
      [makeSigner(account.scriptHash)],
    );
    results.matrix.tokenRestrictedHook = {
      accountId: normalizeHash(scenario.accountId),
      maintenance: pendingConfig,
      txid: success.txid,
      result: stackItemToText(success.execution.stack?.[0]),
      restricted: { state: String(restricted?.state || ""), exception: restricted?.exception || "" },
      note: "Restricted-token activation is deferred behind the maintenance timelock; same-session unrestricted calls still succeed.",
    };
    console.log(JSON.stringify(results.matrix.tokenRestrictedHook, null, 2));
  }

  logSection("MultiHook");
  {
    const scenario = await registerAccount("multihook", {
      hook: multiHook.hash,
    });
    const pendingConfig = await initiatePendingHookCall(
      rpcClient,
      core,
      account,
      networkMagic,
      scenario.accountId,
      "setHooks",
      [
        hash160Param(scenario.accountId),
        arrayParam([
          hash160Param(whitelistHook.hash),
          hash160Param(tokenRestrictedHook.hash),
        ]),
      ],
    );
    const storedHooks = await readAndDecode(
      rpcClient,
      multiHook.hash,
      "getHooks",
      [hash160Param(scenario.accountId)],
    );
    const blocked = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce: 0n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "",
        }),
      ],
      [makeSigner(account.scriptHash)],
    );
    const duplicateHooks = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "callHook",
      [
        hash160Param(scenario.accountId),
        stringParam("setHooks"),
        arrayParam([
          hash160Param(scenario.accountId),
          arrayParam([
            hash160Param(whitelistHook.hash),
            hash160Param(whitelistHook.hash),
          ]),
        ]),
      ],
      [makeSigner(account.scriptHash)],
    );
    const selfHook = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "callHook",
      [
        hash160Param(scenario.accountId),
        stringParam("setHooks"),
        arrayParam([
          hash160Param(scenario.accountId),
          arrayParam([hash160Param(multiHook.hash)]),
        ]),
      ],
      [makeSigner(account.scriptHash)],
    );
    const tooManyHooks = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "callHook",
      [
        hash160Param(scenario.accountId),
        stringParam("setHooks"),
        arrayParam([
          hash160Param(scenario.accountId),
          arrayParam([
            hash160Param(whitelistHook.hash),
            hash160Param(tokenRestrictedHook.hash),
            hash160Param(whitelistHook.hash),
            hash160Param(tokenRestrictedHook.hash),
            hash160Param(whitelistHook.hash),
            hash160Param(tokenRestrictedHook.hash),
            hash160Param(whitelistHook.hash),
            hash160Param(tokenRestrictedHook.hash),
            hash160Param(mockTarget.hash),
          ]),
        ]),
      ],
      [makeSigner(account.scriptHash)],
    );
    results.matrix.multiHook = {
      accountId: normalizeHash(scenario.accountId),
      maintenance: pendingConfig,
      hookCount: Array.isArray(storedHooks?.value)
        ? storedHooks.value.length
        : 0,
      unconfiguredExecutionState: String(blocked?.state || ""),
      duplicateHooks: { state: String(duplicateHooks?.state || ""), exception: duplicateHooks?.exception || "" },
      selfHook: { state: String(selfHook?.state || ""), exception: selfHook?.exception || "" },
      tooManyHooks: { state: String(tooManyHooks?.state || ""), exception: tooManyHooks?.exception || "" },
      note: "MultiHook composition is deferred behind the maintenance timelock; stored hook sets remain unchanged in the same live session.",
    };
    console.log(JSON.stringify(results.matrix.multiHook, null, 2));
  }

  logSection("NeoDID Credential Hook");
  {
    const scenario = await registerAccount("neodid-hook");
    await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "updateHook",
      [hash160Param(scenario.accountId), hash160Param(neoDidHook.hash)],
    );
    await invokePersisted(
      rpcClient,
      neoDidHook.hash,
      account,
      networkMagic,
      "setRegistry",
      [hash160Param(neoDidRegistry.hash)],
    );
    const pendingConfig = await initiatePendingHookCall(
      rpcClient,
      core,
      account,
      networkMagic,
      scenario.accountId,
      "requireCredentialCommitmentForContract",
      [
        hash160Param(scenario.accountId),
        hash160Param(mockTarget.hash),
        stringParam("github"),
        stringParam("Github_VerifiedUser"),
        byteArrayParam("0x" + "11".repeat(32)),
      ],
    );
    const missing = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce: 0n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "",
        }),
      ],
      [makeSigner(account.scriptHash)],
    );
    console.log("[neodid-hook] missing:done", missing?.state || "unknown");
    const masterNullifier = sanitizeHex(crypto.randomBytes(32).toString("hex"));
    const metadataHash = sanitizeHex(crypto.randomBytes(32).toString("hex"));
    const claimCommitment = Buffer.alloc(32, 0x11);
    const bindingDigest = buildNeoDidBindingCommitmentDigest({
      vaultAccount: scenario.accountId,
      provider: "github",
      claimType: "Github_VerifiedUser",
      claimCommitmentHex: claimCommitment.toString("hex"),
      masterNullifierHex: masterNullifier,
      metadataHashHex: metadataHash,
      networkMagic,
    });
    const bindingSignature = wallet.sign(
      bindingDigest.toString("hex"),
      account.privateKey,
    );
    console.log("[neodid-hook] registerBinding:start");
    await invokePersisted(
      rpcClient,
      neoDidRegistry.hash,
      account,
      networkMagic,
      "registerBindingCommitment",
      [
        hash160Param(scenario.accountId),
        stringParam("github"),
        stringParam("Github_VerifiedUser"),
        byteArrayParam(claimCommitment.toString("hex")),
        byteArrayParam(masterNullifier),
        byteArrayParam(metadataHash),
        byteArrayParam(bindingSignature),
      ],
    );
    console.log("[neodid-hook] registerBinding:done");
    console.log("[neodid-hook] success:start");
    const success = await invokePersisted(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce: 0n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "",
        }),
      ],
    );
    console.log("[neodid-hook] success:done", success.txid);
    console.log("[neodid-hook] revokeBinding:start");
    await invokePersisted(
      rpcClient,
      neoDidRegistry.hash,
      account,
      networkMagic,
      "revokeBinding",
      [
        hash160Param(scenario.accountId),
        stringParam("github"),
        stringParam("Github_VerifiedUser"),
      ],
    );
    console.log("[neodid-hook] revokeBinding:done");
    console.log("[neodid-hook] revoked:start");
    const revoked = await testInvoke(
      rpcClient,
      core.hash,
      account,
      networkMagic,
      "executeUserOp",
      [
        hash160Param(scenario.accountId),
        userOpParam({
          targetContract: mockTarget.hash,
          method: "symbol",
          args: [],
          nonce: 1n,
          deadline: BigInt(Date.now() + 60 * 60 * 1000),
          signatureHex: "",
        }),
      ],
      [makeSigner(account.scriptHash)],
    );
    console.log("[neodid-hook] revoked:done", revoked?.state || "unknown");
    results.matrix.neoDidCredentialHook = {
      accountId: normalizeHash(scenario.accountId),
      registry: normalizeHash(neoDidRegistry.hash),
      maintenance: pendingConfig,
      txid: success.txid,
      result: stackItemToText(success.execution.stack?.[0]),
      missing: { state: String(missing?.state || ""), exception: missing?.exception || "" },
      revoked: { state: String(revoked?.state || ""), exception: revoked?.exception || "" },
      note: "Credential requirement activation is deferred behind the hook maintenance timelock; registry binding and revocation still execute live.",
    };
    console.log(JSON.stringify(results.matrix.neoDidCredentialHook, null, 2));
  }

  writePluginMatrixReport(latestReportContext, "passed");

  logSection("Report");
  console.log(reportPath);
  console.log(
    JSON.stringify(
      {
        reportPath,
        core: core.hash,
        mockTarget: mockTarget.hash,
        scenarios: Object.keys(results.matrix),
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    writePluginMatrixReport(latestReportContext, "failed", error);
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
