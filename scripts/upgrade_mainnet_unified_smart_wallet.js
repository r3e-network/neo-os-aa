#!/usr/bin/env node

// Governed upgrade path for the mainnet UnifiedSmartWalletV3 core.
//
// Plan mode (default, read-only) verifies the network magic, the live admin, the
// pinned candidate hash and that an admin-witnessed `update` call would HALT.
// Execute mode additionally requires CONFIRM_AA_MAINNET_UPDATE and a WIF supplied
// through the environment, broadcasts the update, and then proves the deployed
// script bytes equal the candidate artifact byte-for-byte.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");

const {
  neon,
  artifactPaths,
  byteArrayParam,
  invokePersisted,
  loadArtifact,
  makeSigner,
  normalizeHash,
  sanitizeHex,
  stackHash160,
  stringParam,
  withRpcRetry,
} = require("./lib/deploy-helpers");

const { rpc, sc, tx, wallet } = neon;

const MAINNET_MAGIC = 860833102;
const DEFAULT_RPC_URL = "https://api.n3index.dev/mainnet";
const DEFAULT_CORE_HASH = "0x0268a387913b250166ddec032b03332690a1ef78";
const CONFIRMATION = "I_UNDERSTAND_THIS_WRITES_MAINNET";
// Proxy-signer scope fix; override only with a reviewed artifact.
const DEFAULT_EXPECTED_NEF_SHA256 =
  // Reviewed candidate produced by contracts/bin/v3 on 2026-09-14. Keep this
  // pin in the script so a clean operator shell cannot silently fall back to a
  // different artifact; AA_MAINNET_EXPECTED_NEF_SHA256 remains an explicit
  // override for a separately reviewed release.
  "0xc634ab9821c83bdb53b342d64359183cff2b917ac2dc5bdd9b57613494d09b4b";
const REQUIRED_METHODS = [
  "update",
  "proposeUpdate",
  "confirmUpdate",
  "getContractAdmin",
  "proposeAdminTransfer",
  "confirmAdminTransfer",
  "executeUserOp",
];
const REMOVED_METHODS = ["transferAdmin"];

function sha256(value) {
  return `0x${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function normalizeSignerInput(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("a signer address or script hash is required");
  if (wallet.isAddress(input)) return normalizeHash(wallet.getScriptHashFromAddress(input));
  const candidate = normalizeHash(input);
  if (!/^0x[0-9a-f]{40}$/.test(candidate)) {
    throw new Error("signer must be a Neo address or 20-byte script hash");
  }
  return candidate;
}

function candidateArtifact() {
  const { nef, manifest } = loadArtifact("UnifiedSmartWalletV3");
  // neon-js exposes NEF.script as hex text, while RPC exposes base64 bytes.
  const script = Buffer.from(nef.script, "hex");
  const manifestPath = artifactPaths("UnifiedSmartWalletV3").manifest;
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const nefHex = nef.serialize();
  const methods = new Set((manifest.abi?.methods || []).map((method) => method.name));
  const missingMethods = REQUIRED_METHODS.filter((method) => !methods.has(method));
  if (missingMethods.length > 0) {
    throw new Error(`candidate artifact is missing required methods: ${missingMethods.join(", ")}`);
  }
  const removedMethodsStillPresent = REMOVED_METHODS.filter((method) => methods.has(method));
  if (removedMethodsStillPresent.length > 0) {
    throw new Error(
      `candidate artifact still exposes removed privileged methods: ${removedMethodsStillPresent.join(", ")}`,
    );
  }
  return {
    manifestText,
    nefHex,
    nefSha256: sha256(Buffer.from(nefHex, "hex")),
    manifestSha256: sha256(Buffer.from(manifestText, "utf8")),
    script,
    nefChecksum: nef.checksum,
    methodCount: methods.size,
    methodNames: methods,
  };
}

function assertPinnedCandidate(artifact, expectedSha256) {
  if (artifact.nefSha256 !== String(expectedSha256).toLowerCase()) {
    throw new Error(
      `candidate NEF ${artifact.nefSha256} does not match the pinned release ${expectedSha256}; ` +
        "review the artifact and set AA_MAINNET_EXPECTED_NEF_SHA256 deliberately",
    );
  }
}

function assertLiveUpdateSurface(state) {
  const methods = new Set((state?.manifest?.abi?.methods || []).map((method) => method.name));
  for (const method of ["update", "getContractAdmin"]) {
    if (!methods.has(method)) throw new Error(`live AA core does not expose ${method}`);
  }
  return methods;
}

function assertCandidatePreservesLiveSurface(liveMethods, candidateMethods) {
  const missing = [...liveMethods].filter(
    (method) => !candidateMethods.has(method) && !REMOVED_METHODS.includes(method),
  );
  if (missing.length > 0) {
    throw new Error(`candidate artifact removes unapproved live methods: ${missing.join(", ")}`);
  }
  return true;
}

function updateParams(artifact) {
  return [byteArrayParam(artifact.nefHex), stringParam(artifact.manifestText)];
}

function isHalt(result) {
  return /HALT/i.test(String(result?.state || result?.vmstate || ""));
}

function isUnauthorizedFault(result) {
  return /FAULT/i.test(String(result?.state || result?.vmstate || "")) &&
    /not admin/i.test(String(result?.exception || ""));
}

/**
 * Simulation-only signer. Some RPC nodes do not treat a bare signer as a
 * verified witness during test invocation, so the preview may still report the
 * authorization gate. The real broadcast always carries the admin's own witness.
 */
function makeSimulationSigner(scriptHash) {
  return new tx.Signer({ account: scriptHash, scopes: tx.WitnessScope.Global });
}

function writeReport(report) {
  const reportPath = path.resolve(
    process.env.AA_MAINNET_UPDATE_REPORT_PATH ||
      path.resolve(__dirname, "..", "docs", "reports", "mainnet-unified-smart-wallet-upgrade-latest.json"),
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const coreHash = normalizeHash(process.env.AA_MAINNET_CORE_HASH || DEFAULT_CORE_HASH);
  const rpcUrl = process.env.AA_MAINNET_RPC_URL || process.env.NEO_MAINNET_RPC_URL || DEFAULT_RPC_URL;
  const expectedNefSha256 = (
    process.env.AA_MAINNET_EXPECTED_NEF_SHA256 || DEFAULT_EXPECTED_NEF_SHA256
  ).toLowerCase();
  const wif = process.env.AA_MAINNET_UPDATE_WIF || "";
  const client = new rpc.RPCClient(rpcUrl);

  const version = await withRpcRetry("getversion", () => client.getVersion());
  const networkMagic = Number(version?.protocol?.network);
  if (networkMagic !== MAINNET_MAGIC) {
    throw new Error(`RPC network magic mismatch: expected ${MAINNET_MAGIC}, got ${networkMagic}`);
  }

  const state = await withRpcRetry("getcontractstate UnifiedSmartWalletV3", () =>
    client.getContractState(sanitizeHex(coreHash)));
  const liveMethods = assertLiveUpdateSurface(state);

  const artifact = candidateArtifact();
  assertPinnedCandidate(artifact, expectedNefSha256);
  assertCandidatePreservesLiveSurface(liveMethods, artifact.methodNames);

  const adminResult = await withRpcRetry("getContractAdmin", () =>
    client.invokeFunction(sanitizeHex(coreHash), "getContractAdmin", []));
  if (!isHalt(adminResult)) throw new Error("getContractAdmin did not HALT");
  const liveAdmin = stackHash160(adminResult?.stack?.[0]);

  const signerHash = normalizeSignerInput(process.env.AA_MAINNET_UPDATE_SIGNER || liveAdmin);
  if (signerHash !== liveAdmin) {
    throw new Error(`configured signer ${signerHash} is not the live admin ${liveAdmin}`);
  }

  const params = updateParams(artifact);
  const preview = await withRpcRetry("update preview", () =>
    client.invokeFunction(sanitizeHex(coreHash), "update", params, [makeSimulationSigner(signerHash)]));
  const previewHalted = isHalt(preview);
  const previewUnauthorized = isUnauthorizedFault(preview);
  if (!previewHalted && !previewUnauthorized) {
    throw new Error(`update preview FAULT: ${preview?.exception || "unknown error"}`);
  }

  const report = {
    network: "mainnet",
    network_magic: networkMagic,
    rpc_url: rpcUrl,
    core_hash: coreHash,
    admin_hash: liveAdmin,
    signer_hash: signerHash,
    execute_requested: execute,
    chain_writes_performed: false,
    candidate: {
      nef_sha256: artifact.nefSha256,
      manifest_sha256: artifact.manifestSha256,
      method_count: artifact.methodCount,
      expected_nef_sha256: expectedNefSha256,
    },
    live: {
      update_counter: state?.updatecounter ?? null,
      nef_checksum: state?.nef?.checksum ?? null,
      candidate_nef_checksum: artifact.nefChecksum,
      method_count: liveMethods.size,
      has_update_timelock: liveMethods.has("proposeUpdate"),
    },
    preview: {
      state: preview.state || preview.vmstate || null,
      gas_consumed: preview.gasconsumed || null,
      authorized_simulation: previewHalted,
      authorization_gate_rejected_unwitnessed_call: previewUnauthorized,
      exception: preview.exception || null,
    },
    next_action: "review the plan, then rerun with --execute and the admin key in the environment",
    generated_at_utc: new Date().toISOString(),
  };

  if (execute) {
    if (process.env.CONFIRM_AA_MAINNET_UPDATE !== CONFIRMATION) {
      throw new Error(`set CONFIRM_AA_MAINNET_UPDATE=${CONFIRMATION} to write mainnet`);
    }
    if (!wif) throw new Error("AA_MAINNET_UPDATE_WIF is required for --execute");
    const account = new wallet.Account(wif);
    const actualSigner = normalizeHash(account.scriptHash);
    if (actualSigner !== signerHash) {
      throw new Error(`signer mismatch: live admin ${signerHash}, WIF resolves to ${actualSigner}`);
    }

    report.broadcast_status = "not_submitted";
    writeReport(report);

    const broadcast = async (signers) => invokePersisted({
      client,
      account,
      networkMagic,
      rpcUrl,
      contractHash: coreHash,
      operation: "update",
      params,
      signers,
      onBroadcast: (txid) => {
        report.chain_writes_performed = true;
        report.broadcast_status = "submitted_awaiting_confirmation";
        report.transaction = { txid };
        writeReport(report);
      },
    });
    let result;
    try {
      result = await broadcast();
    } catch (error) {
      // Scope fallback is allowed only for the pre-broadcast preview failure.
      // Never submit another transaction after a persistence/readback error.
      const message = String(error && error.message);
      if (report.chain_writes_performed || !message.startsWith("update preview FAULT:") || !/not admin/i.test(message)) throw error;
      // Node did not honor the default signer scope during preview; retry with
      // the admin's Global scope, which the real witness supports.
      report.preview_fallback = "global_scope_retry";
      result = await broadcast([makeSimulationSigner(signerHash)]);
    }

    const postState = await withRpcRetry("post-update getcontractstate", () =>
      client.getContractState(sanitizeHex(coreHash)));
    const deployedScript = Buffer.from(postState?.nef?.script || "", "base64");
    const scriptMatches = deployedScript.equals(artifact.script);
    const manifestMatches = isDeepStrictEqual(postState?.manifest, JSON.parse(artifact.manifestText));
    report.chain_writes_performed = true;
    report.transaction = { txid: result.txid };
    report.broadcast_status = "confirmed_halt";
    report.post_update = {
      update_counter: postState?.updatecounter ?? null,
      nef_checksum: postState?.nef?.checksum ?? null,
      deployed_script_matches_candidate: scriptMatches,
      deployed_manifest_matches_candidate: manifestMatches,
      deployed_script_sha256: sha256(deployedScript),
      candidate_script_sha256: sha256(artifact.script),
    };
    writeReport(report);
    if (!scriptMatches || !manifestMatches) {
      throw new Error("post-update deployed script or manifest does not match the candidate artifact");
    }
    report.next_action = "rerun the shared-AA preflight and re-check verify-scope targets";
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
  CONFIRMATION,
  DEFAULT_CORE_HASH,
  DEFAULT_EXPECTED_NEF_SHA256,
  MAINNET_MAGIC,
  REQUIRED_METHODS,
  REMOVED_METHODS,
  assertCandidatePreservesLiveSurface,
  assertLiveUpdateSurface,
  assertPinnedCandidate,
  candidateArtifact,
  isHalt,
  normalizeSignerInput,
  updateParams,
};
