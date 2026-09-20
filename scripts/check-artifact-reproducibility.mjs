#!/usr/bin/env node

// Reproducibility gate for the artifacts every deploy/upgrade script reads
// (contracts/bin/v3). It copies the working-tree sources into a scratch
// directory, replays the exact compile.sh command sequence there, and compares
// the result byte-for-byte with the checked-in release directory.
//
// contracts/build is tracked in git and is deliberately not treated as build
// output: its UnifiedSmartWalletV3.nef is byte-identical to the deployed mainnet
// core, so it is retained as a provenance anchor and reported separately.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(repoRoot, "contracts", "bin", "v3");
const trackedDir = path.join(repoRoot, "contracts", "build");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const SKIP_DIRS = /(^|\/)(bin|obj|build)$/;

/** Recursively lists nef/manifest files relative to a directory. */
export function listArtifacts(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(nef|manifest\.json)$/.test(entry.name)) found.push(path.relative(dir, full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found.sort();
}

export function compareTrees(expectedDir, actualDir) {
  const names = [...new Set([...listArtifacts(expectedDir), ...listArtifacts(actualDir)])];
  return names.map((file) => {
    const expectedPath = path.join(expectedDir, file);
    const actualPath = path.join(actualDir, file);
    const expected = fs.existsSync(expectedPath) ? fs.readFileSync(expectedPath) : null;
    const actual = fs.existsSync(actualPath) ? fs.readFileSync(actualPath) : null;
    return {
      artifact: file,
      expected_sha256: expected ? sha256(expected) : null,
      actual_sha256: actual ? sha256(actual) : null,
      match: Boolean(expected && actual) && sha256(expected) === sha256(actual),
    };
  });
}

function prepareScratch() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aa-repro-"));
  fs.cpSync(path.join(repoRoot, "contracts"), path.join(scratch, "contracts"), {
    recursive: true,
    filter: (source) => !SKIP_DIRS.test(source),
  });
  fs.mkdirSync(path.join(scratch, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "scripts", "dotnet_env.sh"),
    path.join(scratch, "scripts", "dotnet_env.sh"),
  );
  return scratch;
}

/** Replays contracts/compile.sh against the scratch copy. */
export function compileScratch(scratch) {
  const verifiers = ["Web3AuthVerifier", "TEEVerifier", "SessionKeyVerifier", "WebAuthnVerifier",
    "ZKEmailVerifier", "ZkLoginVerifier", "MultiSigVerifier", "SubscriptionVerifier", "NeoNativeVerifier"];
  const hooks = ["DailyLimitHook", "NeoDIDCredentialHook", "WhitelistHook", "MultiHook", "TokenRestrictedHook"];
  const steps = [
    '"$NCCS_BIN" UnifiedSmartWallet.csproj -o bin/v3',
    "cd verifiers",
    `for project in ${verifiers.join(" ")}; do "$NCCS_BIN" ./$project.csproj -o ../bin/v3/verifiers; done`,
    "cd ../hooks",
    `for project in ${hooks.join(" ")}; do "$NCCS_BIN" ./$project.csproj -o ../bin/v3/hooks; done`,
    "cd ../mocks",
    '"$NCCS_BIN" ./MockVerifierCore.csproj -o ../bin/v3',
    '"$NCCS_BIN" ./MockTransferTarget.csproj -o ../bin/v3',
    '"$NCCS_BIN" ./PlatformRegistrarMock.csproj -o ../bin/v3',
    '"$NCCS_BIN" ./MarkerOnlyModule.csproj -o ../bin/v3',
    '"$NCCS_BIN" ./WrongLifecycleAbiModule.csproj -o ../bin/v3',
    '"$NCCS_BIN" ./WrongHookLifecycleAbiModule.csproj -o ../bin/v3',
    "cd ../market",
    '"$NCCS_BIN" ./AAAddressMarket.csproj -o ../bin/v3',
    "cd ../recovery",
    '"$NCCS_BIN" ./MorpheusSocialRecoveryVerifier.csproj -o ../bin/v3',
  ];
  const script = ["set -euo pipefail", `cd ${JSON.stringify(scratch)}`, "source scripts/dotnet_env.sh",
    "cd contracts", ...steps].join("\n");
  try {
    execFileSync("bash", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = error?.stderr ? Buffer.from(error.stderr).toString("utf8").trim() : "";
    throw new Error(`scratch compile failed: ${stderr || error.message}`);
  }
  return path.join(scratch, "contracts", "bin", "v3");
}

async function main() {
  const json = process.argv.includes("--json");
  const scratch = prepareScratch();
  try {
    const freshDir = compileScratch(scratch);
    const rows = compareTrees(freshDir, releaseDir);
    const drifted = rows.filter((row) => !row.match && row.expected_sha256 && row.actual_sha256);
    const missing = rows.filter((row) => !row.expected_sha256 || !row.actual_sha256);
    const anchor = compareTrees(freshDir, path.join(trackedDir, "..", "build"))
      .filter((row) => row.artifact === "UnifiedSmartWalletV3.nef")
      .map((row) => ({ ...row, provenance: "tracked contracts/build; deployed-mainnet bytecode anchor" }));
    // The comparison above only ever looked at one file, so drift in the rest of the
    // tracked release tree was invisible: 23 same-relative-path files differed while
    // this gate reported success. Report the whole tree now. It is not folded into
    // `release_matches_fresh_build` because UnifiedSmartWalletV3 is deliberately pinned
    // to the deployed mainnet bytecode and that exception has to be decided first.
    const trackedRows = compareTrees(freshDir, path.join(trackedDir, "..", "build"));
    const trackedDrift = trackedRows
      .filter((row) => !row.match && row.expected_sha256 && row.actual_sha256)
      .map((row) => row.artifact)
      .sort();
    const report = {
      generated_at: new Date().toISOString(),
      release_dir: path.relative(repoRoot, releaseDir),
      artifacts_compared: rows.length,
      release_matches_fresh_build: drifted.length === 0 && missing.length === 0,
      drifted: drifted.map((row) => row.artifact),
      missing: missing.map((row) => row.artifact),
      tracked_anchor: anchor,
      tracked_tree_drift: trackedDrift,
      tracked_tree_note:
        "Files under contracts/build whose bytes differ from a fresh build. Reported, " +
        "not failing: UnifiedSmartWalletV3 is intentionally pinned to the deployed " +
        "mainnet bytecode and that exception must be decided before this becomes a gate.",
      chain_writes_performed: false,
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`artifacts compared: ${report.artifacts_compared}`);
      console.log(`release matches fresh build: ${report.release_matches_fresh_build ? "YES" : "NO"}`);
      if (report.drifted.length) console.log(`drifted: ${report.drifted.join(", ")}`);
      if (report.missing.length) console.log(`missing: ${report.missing.join(", ")}`);
      for (const row of report.tracked_anchor) {
        console.log(`tracked anchor ${row.artifact}: ${row.match ? "matches source" : "differs from source (expected; provenance anchor)"}`);
      }
    }
    if (!report.release_matches_fresh_build) process.exitCode = 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
