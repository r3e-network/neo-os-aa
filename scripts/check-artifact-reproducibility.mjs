#!/usr/bin/env node

// Helper library for the retired custom-artifact reproducibility certificate
// (contracts/bin/public and contracts/bin/platform, both built by the deleted
// contracts/compile.sh). The comparison, snapshot and scratch helpers stay
// exported because the archived-receipt joiner
// (scripts/verify-private-artifact-provenance.mjs) and their unit tests still
// use them.
//
// The CLI itself is retired: replaying a recipe the repository no longer
// contains would fabricate evidence. Native rebuild evidence now comes from
// scripts/build_native_modules.py, scripts/native_epoch_probe.py and the
// scripts/neoexpress_native_*_validate.py suites.
//
// contracts/build is tracked in git and is deliberately not treated as build
// output: its SmartAccount.nef is byte-identical to the deployed mainnet
// core, so it is retained as a provenance anchor and reported separately.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
// Source inputs are TEXT, and the certificate they go into must hold the same digests on an LF
// checkout and on a Windows core.autocrlf=true checkout, which materialises CRLF worktree bytes
// for the same committed content. Hash the LF-normalised form (a no-op on an LF checkout), so the
// certificate is portable and the "candidate source drift" consumers can hash the same way.
// Compiled artifacts (.nef/.manifest.json under bin/) are binary evidence and keep raw-byte hashing.
const sha256Text = (file) => sha256(Buffer.from(fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n"), "utf8"));
// fs.cpSync hands the filter native separators ("...\contracts\bin" on Windows),
// so normalize before matching or the build-output exclusion silently never fires.
const SKIP_DIRS = /(^|\/)(bin|obj|build)$/;
const isSkippedDirectory = (source) => SKIP_DIRS.test(source.replaceAll(path.sep, "/"));
// The restore policy every contract project is built under. Without them the scratch copy would
// compile against whatever package source and framework version the machine happens to resolve.
export const RESTORE_POLICY_FILES = ["Directory.Build.props", "nuget.config"];
export const ARTIFACT_PROFILES = ["public", "platform"];
// Every script compile.sh runs, not only the compiler pin check: the module
// profile gate (sync-module-profiles.mjs) is part of the v4 recipe, and a
// scratch copy without it compiles nothing at all.
export const RECIPE_SUPPORT_FILES = ["scripts/dotnet_env.sh", "scripts/check_neo_platform_packages.mjs",
  "scripts/sync-module-profiles.mjs"];
// Every tree compile.sh reads: the contracts, and the mock contracts that live with the tests.
export const SOURCE_ROOTS = ["contracts", "tests/mocks"];

/** Recursively lists nef/manifest files relative to a directory.
 * Keys are normalized to '/' so the certificate is identical on Windows and Linux
 * (path.relative yields '\' separators on Windows); consumers match with '/'-shaped
 * literals, and a path-separator byte difference is not an artifact difference. */
export function listArtifacts(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(nef|manifest\.json)$/.test(entry.name))
        found.push(path.relative(dir, full).replaceAll(path.sep, "/"));
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
    return [path.relative(root, full).replaceAll(path.sep, "/"), sha256Text(full)];
  }));
}

/** Hash the copied sources and restore inputs, including native module sources.
 * This inventory records their bytes; public/platform replay does not compile native modules. */
export function buildInputSnapshot(root = repoRoot) {
  const inputs = Object.assign({}, ...SOURCE_ROOTS.map((dir) => sourceSnapshot(path.join(root, dir), root)));
  for (const file of [...RESTORE_POLICY_FILES, ...RECIPE_SUPPORT_FILES]) {
    inputs[file] = sha256Text(path.join(root, file));
  }
  return Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b, "en")));
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
    const required = ["SmartAccount.nef", "SmartAccount.manifest.json"];
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sa-repro-"));
  for (const dir of SOURCE_ROOTS) {
    fs.cpSync(path.join(repoRoot, dir), path.join(scratch, dir), {
      recursive: true,
      filter: (source) => !isSkippedDirectory(source),
    });
  }
  for (const file of RESTORE_POLICY_FILES) fs.copyFileSync(path.join(repoRoot, file), path.join(scratch, file));
  fs.mkdirSync(path.join(scratch, "scripts"), { recursive: true });
  for (const file of RECIPE_SUPPORT_FILES) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(scratch, file));
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
  // contracts/compile.sh and the custom artifact profiles it produced were
  // retired with the custom track. Exit before touching the tree: the archived
  // receipts under docs/reports keep their recorded digests, and new native
  // rebuild evidence is produced by the native lanes named above.
  console.error(
    "check-artifact-reproducibility: the custom artifact replay is retired "
    + "(contracts/compile.sh was deleted with the custom track). Use "
    + "scripts/build_native_modules.py, scripts/native_epoch_probe.py and the "
    + "scripts/neoexpress_native_*_validate.py suites for native rebuild "
    + "evidence; archived receipts under docs/reports stay as recorded.",
  );
  process.exitCode = 2;
}

// argv[1] arrives in native form; the template-literal file:// URL mis-parses
// paths containing spaces or '%' (no percent-encoding). pathToFileURL is exact.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
