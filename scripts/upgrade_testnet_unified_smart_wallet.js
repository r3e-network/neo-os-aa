#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  neon,
  artifactPaths,
  byteArrayParam,
  hash160Param,
  invokePersisted,
  loadArtifact,
  makeSigner,
  normalizeHash,
  sanitizeHex,
  stringParam,
  withRpcRetry,
} = require("./lib/deploy-helpers");

const { rpc, sc, wallet } = neon;

const TESTNET_MAGIC = 894710606;
const DEFAULT_RPC_URL = "https://testnet1.neo.coz.io:443";
const DEFAULT_CORE_HASH = "0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2";
const CONFIRMATION = "I_UNDERSTAND_THIS_WRITES_CHAIN";
const REQUIRED_METHODS = [
  "computePlatformAccountId",
  "registerPlatformAccount",
  "rotatePlatformAccountOwner",
  "getPlatformRegistrar",
  "getPendingPlatformRegistrar",
  "getPlatformRegistrarAvailableAt",
  "proposePlatformRegistrar",
  "confirmPlatformRegistrar",
  "cancelPlatformRegistrar",
];

function candidateArtifact() {
  const { nef, manifest } = loadArtifact("UnifiedSmartWalletV3");
  const manifestPath = artifactPaths("UnifiedSmartWalletV3").manifest;
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const nefHex = nef.serialize();
  const methods = new Set((manifest.abi?.methods || []).map((method) => method.name));
  const missingMethods = REQUIRED_METHODS.filter((method) => !methods.has(method));
  if (missingMethods.length > 0) {
    throw new Error(`candidate artifact is missing registrar methods: ${missingMethods.join(", ")}`);
  }
  return {
    manifest,
    manifestText,
    manifestPath,
    nefHex,
    script: Buffer.from(nef.script, "hex"),
    nefSha256: sha256(Buffer.from(nefHex, "hex")),
    manifestSha256: sha256(Buffer.from(manifestText, "utf8")),
    methods: [...methods].sort(),
  };
}

function sha256(value) {
  return `0x${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function normalizeSignerInput(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("AA_TESTNET_UPDATE_SIGNER is required for a dry-run");
  if (wallet.isAddress(input)) return normalizeHash(wallet.getScriptHashFromAddress(input));
  const candidate = normalizeHash(input);
  if (!/^0x[0-9a-f]{40}$/.test(candidate)) {
    throw new Error("AA_TESTNET_UPDATE_SIGNER must be a Neo address or 20-byte script hash");
  }
  return candidate;
}

function updateParams(artifact) {
  return [byteArrayParam(artifact.nefHex), stringParam(artifact.manifestText)];
}

function proposeParams(artifact) {
  // CryptoLib.Sha256 returns raw digest bytes. Hash256 parameters are written
  // to the VM in little-endian order, so their display spelling must be the
  // reverse of the SHA-256 hex digest; otherwise the proposal can never confirm.
  const asHash256 = (digest) => sc.ContractParam.hash256(
    Buffer.from(sanitizeHex(digest), "hex").reverse().toString("hex"),
  );
  return [
    asHash256(artifact.nefSha256),
    asHash256(artifact.manifestSha256),
  ];
}

function isHalt(result) {
  return /HALT/i.test(String(result?.state || result?.vmstate || ""));
}

function stackValue(result) {
  return result?.stack?.[0]?.value ?? null;
}

async function readState(client, coreHash) {
  return withRpcRetry("getContractState UnifiedSmartWalletV3", () => client.getContractState(sanitizeHex(coreHash)));
}

function liveMethodNames(state) {
  return new Set((state?.manifest?.abi?.methods || []).map((method) => method.name));
}

function assertLiveUpdateSurface(state) {
  const methods = liveMethodNames(state);
  if (!methods.has("update")) throw new Error("live AA core does not expose update");
  return REQUIRED_METHODS.filter((method) => methods.has(method));
}

async function readNetwork(client) {
  const version = await withRpcRetry("getVersion", () => client.getVersion());
  const magic = Number(version?.protocol?.network);
  if (magic !== TESTNET_MAGIC) {
    throw new Error(`RPC network magic mismatch: expected ${TESTNET_MAGIC}, got ${magic}`);
  }
  return magic;
}

function writeReport(report) {
  const reportPath = path.resolve(
    process.env.AA_TESTNET_UPDATE_REPORT_PATH ||
      path.resolve(__dirname, "..", "docs", "reports", "testnet-unified-smart-wallet-upgrade-latest.json"),
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const propose = process.argv.includes("--propose");
  const confirm = process.argv.includes("--confirm");
  if (propose && confirm) {
    throw new Error("--propose and --confirm are mutually exclusive");
  }
  const coreHash = normalizeHash(process.env.AA_TESTNET_CORE_HASH || DEFAULT_CORE_HASH);
  const rpcUrl = process.env.AA_TESTNET_RPC_URL || process.env.NEO_TESTNET_RPC_URL || DEFAULT_RPC_URL;
  const wif = process.env.AA_TESTNET_UPDATE_WIF || process.env.NEO_TESTNET_WIF || process.env.TEST_WIF || "";
  const client = new rpc.RPCClient(rpcUrl);
  const artifact = candidateArtifact();
  const networkMagic = await readNetwork(client);
  const state = await readState(client, coreHash);
  const liveMethods = liveMethodNames(state);
  assertLiveUpdateSurface(state);
  if (propose && !liveMethods.has("proposeUpdate")) {
    throw new Error("live AA core does not expose proposeUpdate; refusing a direct legacy update");
  }
  if (confirm && !liveMethods.has("confirmUpdate")) {
    throw new Error("live AA core does not expose confirmUpdate; refusing a non-timelocked confirmation");
  }
  const signerHash = normalizeSignerInput(
    process.env.AA_TESTNET_UPDATE_SIGNER || process.env.AA_TESTNET_DRY_RUN_SIGNER,
  );
  const operation = propose ? "proposeUpdate" : confirm ? "confirmUpdate" : "update";
  const params = propose ? proposeParams(artifact) : updateParams(artifact);
  const preview = await withRpcRetry(`UnifiedSmartWalletV3.${operation} preview`, () =>
    client.invokeFunction(sanitizeHex(coreHash), operation, params, [makeSigner(signerHash)]),
  );
  if (!isHalt(preview)) {
    throw new Error(`UnifiedSmartWalletV3.${operation} preview FAULT: ${preview?.exception || "unknown error"}`);
  }

  const report = {
    network: "testnet",
    network_magic: networkMagic,
    rpc_url: rpcUrl,
    core_hash: coreHash,
    signer_hash: signerHash,
    execute_requested: execute,
    propose_requested: propose,
    operation,
    chain_writes_performed: false,
    candidate: {
      manifest_name: artifact.manifest.name,
      nef_sha256: artifact.nefSha256,
      manifest_sha256: artifact.manifestSha256,
      method_count: artifact.methods.length,
      required_registrar_methods: REQUIRED_METHODS,
    },
    live: {
      update_counter: state?.updatecounter ?? state?.updateCounter ?? null,
      nef_checksum: state?.nef?.checksum ?? null,
      method_count: liveMethods.size,
      required_registrar_methods_present: REQUIRED_METHODS.filter((method) => liveMethods.has(method)),
      missing_registrar_methods: REQUIRED_METHODS.filter((method) => !liveMethods.has(method)),
    },
    preview: {
      state: preview.state || preview.vmstate || null,
      gas_consumed: preview.gasconsumed || preview.gas_consumed || null,
    },
    next_action: propose
      ? "wait for the on-chain upgrade timelock, then execute --confirm with the exact candidate pair"
      : confirm
        ? "confirmUpdate was simulated; execute only with the matching admin witness"
      : "review candidate hashes and authorization before any execute run",
    generated_at_utc: new Date().toISOString(),
  };

  if (execute) {
    if (process.env.CONFIRM_AA_TESTNET_UPDATE !== CONFIRMATION) {
      throw new Error(`set CONFIRM_AA_TESTNET_UPDATE=${CONFIRMATION} to write chain`);
    }
    if (!wif) throw new Error("AA_TESTNET_UPDATE_WIF, NEO_TESTNET_WIF, or TEST_WIF is required for --execute");
    const account = new wallet.Account(wif);
    const actualSignerHash = normalizeHash(account.scriptHash);
    if (actualSignerHash !== signerHash) {
      throw new Error(`signer mismatch: configured ${signerHash}, WIF resolves to ${actualSignerHash}`);
    }
    writeReport(report);
    const result = await invokePersisted({
      client,
      account,
      networkMagic,
      rpcUrl,
      contractHash: coreHash,
      operation,
      params,
      onBroadcast: (txid) => {
        report.chain_writes_performed = true;
        report.transaction = { txid };
        report.broadcast_status = "submitted_awaiting_confirmation";
        writeReport(report);
      },
    });
    const postState = await readState(client, coreHash);
    const postMethods = liveMethodNames(postState);
    report.chain_writes_performed = true;
    report.transaction = { txid: result.txid };
    report.broadcast_status = "confirmed_halt";
    if (propose) {
      report.post_proposal = {
        update_counter: postState?.updatecounter ?? postState?.updateCounter ?? null,
        method_count: postMethods.size,
        proposal_recorded: true,
      };
    } else {
      const missingAfter = REQUIRED_METHODS.filter((method) => !postMethods.has(method));
      if (missingAfter.length > 0)
        throw new Error(`post-update AA core is missing registrar methods: ${missingAfter.join(", ")}`);
      const deployedScript = Buffer.from(postState?.nef?.script || "", "base64");
      const candidateScript = artifact.script;
      const deployedScriptSha256 = sha256(deployedScript);
      const candidateScriptSha256 = sha256(candidateScript);
      if (!deployedScript.equals(candidateScript)) {
        throw new Error("post-confirm deployed NEF script does not match the candidate artifact");
      }
      report.post_update = {
        update_counter: postState?.updatecounter ?? postState?.updateCounter ?? null,
        nef_checksum: postState?.nef?.checksum ?? null,
        method_count: postMethods.size,
        required_registrar_methods_present: REQUIRED_METHODS,
        ...{
          deployed_script_sha256: deployedScriptSha256,
          candidate_script_sha256: candidateScriptSha256,
          deployed_script_matches_candidate: true,
        },
      };
    }
    report.next_action = propose
      ? "verify the stored raw digests and chain timelock, then confirm the exact artifact pair after expiry"
      : "rerun the reciprocal shared-AA preflight before configuring Registry";
  }

  const reportPath = writeReport(report);
  console.log(JSON.stringify({ ...report, report_path: reportPath }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_CORE_HASH,
  REQUIRED_METHODS,
  assertLiveUpdateSurface,
  candidateArtifact,
  isHalt,
  normalizeSignerInput,
  proposeParams,
  updateParams,
};
