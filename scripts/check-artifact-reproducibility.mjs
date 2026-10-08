#!/usr/bin/env node

// Reproducibility gate for the artifacts every deploy/upgrade script reads
// (contracts/bin/v3) and the isolated private core (contracts/bin/platform).
// Replays compile.sh itself in a scratch directory and compares each profile
// byte-for-byte with the generated local artifact directory.
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
// The restore policy every contract project is built under. Without them the scratch copy would
// compile against whatever package source and framework version the machine happens to resolve.
export const RESTORE_POLICY_FILES = ["Directory.Build.props", "nuget.config"];
export const ARTIFACT_PROFILES = ["v3", "platform"];
const RECIPE_SUPPORT_FILES = ["scripts/dotnet_env.sh", "scripts/check_neo_platform_packages.mjs"];

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

/** Lists the source and project inputs copied into the reproducibility scratch tree. */
export function listSourceInputs(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && ["bin", "obj", "build"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(cs|csproj|props|targets)$/.test(entry.name)
        || /^packages(?:\.[\w.-]+)?\.lock\.json$/.test(entry.name)
        || ["compile.sh", "neo-platform-packages.json", "profiles.json"].includes(entry.name)) {
        found.push(path.relative(dir, full));
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found.sort();
}

export function sourceSnapshot(dir, root = dir) {
  return Object.fromEntries(listSourceInputs(dir).map((relative) => {
    const full = path.join(dir, relative);
    return [path.relative(root, full).replaceAll(path.sep, "/"), sha256(fs.readFileSync(full))];
  }));
}

/** Hash the copied sources and restore inputs, including native module sources.
 * This inventory records their bytes; public/platform replay does not compile native modules. */
export function buildInputSnapshot(root = repoRoot) {
  const inputs = sourceSnapshot(path.join(root, "contracts"), root);
  for (const file of [...RESTORE_POLICY_FILES, ...RECIPE_SUPPORT_FILES]) {
    inputs[file] = sha256(fs.readFileSync(path.join(root, file)));
  }
  return Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b, "en")));
}

function compileSteps() {
  return ["bash contracts/compile.sh"];
}

function compilerVersion() {
  const compiler = process.env.NCCS_BIN || path.join(os.homedir(), ".dotnet", "tools", "nccs");
  let dotnetRoot = process.env.DOTNET_ROOT;
  if (!dotnetRoot) {
    try {
      const runtimes = execFileSync("dotnet", ["--list-runtimes"], { encoding: "utf8" });
      const match = runtimes.match(/\[(.+?)\/shared\//);
      if (match) dotnetRoot = match[1];
    } catch {
      // The compile replay remains authoritative if metadata probing is unavailable.
    }
  }
  try {
    const output = execFileSync(compiler, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, ...(dotnetRoot ? { DOTNET_ROOT: dotnetRoot } : {}) },
    }).trim();
    return output.split(/\r?\n/).find((line) => line.trim()) || "unknown";
  } catch {
    return "unavailable";
  }
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

export function artifactCertificateHashes(rows) {
  const hashes = (field) => Object.fromEntries(rows
    .filter((row) => row[field])
    .map((row) => [row.artifact, row[field]]));
  return {
    fresh_artifact_sha256: hashes("expected_sha256"),
    release_artifact_sha256: hashes("actual_sha256"),
  };
}

/** A profile must contain the core pair; two absent trees cannot constitute proof. */
export function compareProfiles(expectedBin, actualBin) {
  return Object.fromEntries(ARTIFACT_PROFILES.map((profile) => {
    const rows = compareTrees(path.join(expectedBin, profile), path.join(actualBin, profile));
    const required = ["UnifiedSmartWalletV3.nef", "UnifiedSmartWalletV3.manifest.json"];
    const requiredCorePresent = required.every((name) => rows.some((row) =>
      row.artifact === name && row.expected_sha256 && row.actual_sha256));
    return [profile, {
      artifact_dir: `contracts/bin/${profile}`,
      artifacts_compared: rows.length,
      required_core_present: requiredCorePresent,
      matches_fresh_build: requiredCorePresent && rows.every((row) => row.match),
      drifted: rows.filter((row) => !row.match && row.expected_sha256 && row.actual_sha256).map((row) => row.artifact),
      missing: rows.filter((row) => !row.expected_sha256 || !row.actual_sha256).map((row) => row.artifact),
      artifacts: rows,
    }];
  }));
}

/** Copies the sources, lock files and restore policy that determine the artifacts into a new scratch directory. */
export function prepareScratch() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aa-repro-"));
  fs.cpSync(path.join(repoRoot, "contracts"), path.join(scratch, "contracts"), {
    recursive: true,
    filter: (source) => !SKIP_DIRS.test(source),
  });
  for (const file of RESTORE_POLICY_FILES) fs.copyFileSync(path.join(repoRoot, file), path.join(scratch, file));
  fs.mkdirSync(path.join(scratch, "scripts"), { recursive: true });
  for (const file of ["dotnet_env.sh", "check_neo_platform_packages.mjs"]) {
    fs.copyFileSync(path.join(repoRoot, "scripts", file), path.join(scratch, "scripts", file));
  }
  return scratch;
}

/** Replays contracts/compile.sh against the scratch copy. */
export function compileScratch(scratch) {
  try {
    execFileSync("bash", [path.join(scratch, "contracts", "compile.sh")], {
      cwd: scratch, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error?.stderr ? Buffer.from(error.stderr).toString("utf8").trim() : "";
    throw new Error(`scratch compile failed: ${stderr || error.message}`);
  }
  return path.join(scratch, "contracts", "bin");
}

async function main() {
  const json = process.argv.includes("--json");
  const scratch = prepareScratch();
  try {
    const sourceInputs = buildInputSnapshot(scratch);
    const freshBin = compileScratch(scratch);
    if (JSON.stringify(sourceInputs) !== JSON.stringify(buildInputSnapshot(scratch))
      || JSON.stringify(sourceInputs) !== JSON.stringify(buildInputSnapshot(repoRoot))) {
      throw new Error("Build inputs changed during the reproducibility replay");
    }
    const freshDir = path.join(freshBin, "v3");
    const profiles = compareProfiles(freshBin, path.dirname(releaseDir));
    const rows = Object.entries(profiles).flatMap(([profile, result]) => result.artifacts.map((row) => ({
      ...row, artifact: `${profile}/${row.artifact}`,
    })));
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
    const compileRecipe = compileSteps();
    const recipeSources = Object.fromEntries(["contracts/compile.sh", ...RECIPE_SUPPORT_FILES]
      .map((file) => [file, sourceInputs[file]]));
    const profilesMatch = Object.values(profiles).every((profile) => profile.matches_fresh_build);
    const certificate = {
      schema: "neoos-aa-source-to-artifact-certificate/v1",
      source_root: "repository",
      source_files: sourceInputs,
      source_snapshot_sha256: sha256(Buffer.from(JSON.stringify(sourceInputs))),
      compiler: { tool: "nccs", version: compilerVersion() },
      compile_recipe: compileRecipe,
      compile_recipe_sources: recipeSources,
      compile_recipe_sha256: sha256(Buffer.from(JSON.stringify(recipeSources))),
      ...artifactCertificateHashes(rows),
      byte_equal_release: profilesMatch,
      semantic_scope: "Rebuild and byte comparison; not a mechanized C# to NEF or full NeoVM refinement proof",
    };
    const report = {
      schema: "neoos-aa-artifact-reproducibility/v2",
      generated_at: new Date().toISOString(),
      release_dir: path.relative(repoRoot, releaseDir),
      profiles,
      artifacts_compared: rows.length,
      release_matches_fresh_build: profilesMatch,
      drifted: drifted.map((row) => row.artifact),
      missing: missing.map((row) => row.artifact),
      tracked_anchor: anchor,
      tracked_tree_drift: trackedDrift,
      tracked_tree_note:
        "Files under contracts/build whose bytes differ from a fresh build. Reported, " +
        "not failing: UnifiedSmartWalletV3 is intentionally pinned to the deployed " +
        "mainnet bytecode and that exception must be decided before this becomes a gate.",
      certificate,
      chain_writes_performed: false,
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`artifacts compared: ${report.artifacts_compared}`);
      console.log(`release matches fresh build: ${report.release_matches_fresh_build ? "YES" : "NO"}`);
      for (const [name, profile] of Object.entries(profiles)) {
        console.log(`${name}: ${profile.matches_fresh_build ? "MATCH" : "FAIL"} (${profile.artifacts_compared} artifacts)`);
      }
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
