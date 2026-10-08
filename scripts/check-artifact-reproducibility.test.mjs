import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import * as reproducibility from "./check-artifact-reproducibility.mjs";

import { RESTORE_POLICY_FILES, compareProfiles, compareTrees, compileScratch, listArtifacts, listSourceInputs, sourceSnapshot, prepareScratch } from "./check-artifact-reproducibility.mjs";

function scratchTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-repro-test-"));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return dir;
}

test("identical trees match and nested plugin artifacts are compared", () => {
  const expected = scratchTree({ "Core.nef": "a", "verifiers/SessionKeyVerifier.nef": "b" });
  const actual = scratchTree({ "Core.nef": "a", "verifiers/SessionKeyVerifier.nef": "b" });
  const rows = compareTrees(expected, actual);
  assert.deepEqual(rows.map((row) => row.artifact).sort(), ["Core.nef", "verifiers/SessionKeyVerifier.nef"]);
  assert.ok(rows.every((row) => row.match));
});

test("drifted and missing artifacts are reported as mismatches", () => {
  const expected = scratchTree({ "Core.nef": "a", "Hooks.nef": "b" });
  const actual = scratchTree({ "Core.nef": "changed" });
  const rows = compareTrees(expected, actual);
  const byName = Object.fromEntries(rows.map((row) => [row.artifact, row]));
  assert.equal(byName["Core.nef"].match, false);
  assert.equal(byName["Hooks.nef"].match, false);
  assert.equal(byName["Hooks.nef"].expected_sha256 !== null, true);
  assert.equal(byName["Hooks.nef"].actual_sha256, null);
});

test("listing ignores non-artifact files and missing directories", () => {
  const tree = scratchTree({ "Core.nef": "a", "Core.manifest.json": "{}", "README.md": "x" });
  assert.deepEqual(listArtifacts(tree), ["Core.manifest.json", "Core.nef"]);
  assert.deepEqual(listArtifacts(path.join(tree, "absent")), []);
});

test("public success cannot hide private profile drift or omission", () => {
  const files = {
    "v3/UnifiedSmartWalletV3.nef": "public",
    "v3/UnifiedSmartWalletV3.manifest.json": "{}",
    "platform/UnifiedSmartWalletV3.nef": "private",
    "platform/UnifiedSmartWalletV3.manifest.json": "{}",
  };
  const expected = scratchTree(files);
  const actual = scratchTree({ ...files, "platform/UnifiedSmartWalletV3.nef": "drift" });
  let profiles = compareProfiles(expected, actual);
  assert.equal(profiles.v3.matches_fresh_build, true);
  assert.equal(profiles.platform.matches_fresh_build, false);
  fs.rmSync(path.join(actual, "platform"), { recursive: true });
  profiles = compareProfiles(expected, actual);
  assert.equal(profiles.platform.matches_fresh_build, false);
  assert.deepEqual(profiles.platform.missing, ["UnifiedSmartWalletV3.manifest.json", "UnifiedSmartWalletV3.nef"]);
});

test("two absent or empty profile directories never establish reproducibility", () => {
  const empty = scratchTree({});
  for (const profile of Object.values(compareProfiles(empty, empty))) {
    assert.equal(profile.matches_fresh_build, false);
    assert.equal(profile.required_core_present, false);
  }
});

test("identical profile trees pass and unexpected artifacts fail", () => {
  const files = Object.fromEntries(["v3", "platform"].flatMap((profile) => [
    [`${profile}/UnifiedSmartWalletV3.nef`, profile],
    [`${profile}/UnifiedSmartWalletV3.manifest.json`, "{}"],
  ]));
  const expected = scratchTree(files);
  const actual = scratchTree(files);
  assert.ok(Object.values(compareProfiles(expected, actual)).every((profile) => profile.matches_fresh_build));
  fs.writeFileSync(path.join(actual, "platform", "stale.nef"), "extra");
  assert.equal(compareProfiles(expected, actual).platform.matches_fresh_build, false);
});

test("the scratch copy carries the sources, the lock files and the restore policy, and none of the build output", () => {
  const scratch = prepareScratch();
  try {
    for (const file of RESTORE_POLICY_FILES) assert.ok(fs.existsSync(path.join(scratch, file)), `${file} is missing from the scratch copy`);
    assert.ok(fs.existsSync(path.join(scratch, "contracts", "UnifiedSmartWallet.Execution.cs")));
    assert.ok(fs.existsSync(path.join(scratch, "contracts", "packages.lock.json")));
    assert.ok(fs.existsSync(path.join(scratch, "contracts", "verifiers", "packages.SessionKeyVerifier.lock.json")));
    assert.ok(fs.existsSync(path.join(scratch, "scripts", "dotnet_env.sh")));
    assert.ok(fs.existsSync(path.join(scratch, "scripts", "check_neo_platform_packages.mjs")));
    assert.equal(fs.readFileSync(path.join(scratch, "contracts", "compile.sh"), "utf8"), fs.readFileSync(new URL("../contracts/compile.sh", import.meta.url), "utf8"));
    for (const output of ["bin", "obj", "build"]) assert.ok(!fs.existsSync(path.join(scratch, "contracts", output)), `contracts/${output} must not be copied`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("artifact certificate labels expected fresh bytes and actual release bytes correctly", () => {
  const expected = scratchTree({ "Core.nef": "fresh" });
  const actual = scratchTree({ "Core.nef": "release" });
  const rows = compareTrees(expected, actual);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const certificate = reproducibility.artifactCertificateHashes(rows);
  assert.equal(certificate.fresh_artifact_sha256["Core.nef"], hash("fresh"));
  assert.equal(certificate.release_artifact_sha256["Core.nef"], hash("release"));
});


test("source snapshot excludes generated trees and uses repository-relative names", () => {
  const expected = scratchTree({
    "contracts/Core.cs": "source",
    "contracts/Core.csproj": "project",
    "contracts/Directory.Build.props": "props",
    "contracts/bin/Core.nef": "generated",
    "contracts/obj/Core.cs": "generated",
    "contracts/build/Core.nef": "historical",
    "contracts/README.md": "not a compiler input",
  });
  const root = path.join(expected, "contracts");
  const inputs = listSourceInputs(root);
  assert.deepEqual(inputs, ["Core.cs", "Core.csproj", "Directory.Build.props"]);
  const snapshot = sourceSnapshot(root, expected);
  assert.deepEqual(Object.keys(snapshot), ["contracts/Core.cs", "contracts/Core.csproj", "contracts/Directory.Build.props"]);
  assert.equal(Object.values(snapshot).every((value) => /^[0-9a-f]{64}$/.test(value)), true);
});

 test("repository entrypoint runs reproducibility regression tests", () => {
  const script = fs.readFileSync(new URL("./verify_repo.sh", import.meta.url), "utf8");
  assert.match(script, /node --test[^]*scripts\/check-artifact-reproducibility\.test\.mjs/);
});


test("certificate inputs include root restore policy, locks, native sources, and the actual recipe", () => {
  const expected = scratchTree({
    "contracts/native/NativeAuthority.cs": "native",
    "contracts/native/profiles.json": "{}",
    "contracts/native/packages.Verifier.Native.lock.json": "{}",
    "contracts/neo-platform-packages.json": "{}",
    "contracts/compile.sh": "recipe",
    "Directory.Build.props": "props", "nuget.config": "feed",
    "scripts/dotnet_env.sh": "environment", "scripts/check_neo_platform_packages.mjs": "pins",
  });
  try {
    const snapshot = reproducibility.buildInputSnapshot(expected);
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "Directory.Build.props", "contracts/compile.sh", "contracts/native/NativeAuthority.cs",
      "contracts/native/packages.Verifier.Native.lock.json", "contracts/native/profiles.json",
      "contracts/neo-platform-packages.json", "nuget.config", "scripts/check_neo_platform_packages.mjs", "scripts/dotnet_env.sh",
    ]);
    fs.writeFileSync(path.join(expected, "nuget.config"), "different feed");
    assert.notDeepEqual(reproducibility.buildInputSnapshot(expected), snapshot);
  } finally { fs.rmSync(expected, { recursive: true, force: true }); }
});

test("scratch compilation executes the canonical recipe from paths containing spaces", () => {
  const scratch = scratchTree({ "contracts/compile.sh": 'set -eu\nmkdir -p "$(dirname "$0")/bin/platform"\nprintf canonical > "$(dirname "$0")/bin/platform/probe"\n' });
  const spaced = scratch + " with space"; fs.renameSync(scratch, spaced);
  try {
    const output = compileScratch(spaced);
    assert.equal(output, path.join(spaced, "contracts/bin"));
    assert.equal(fs.readFileSync(path.join(output, "platform/probe"), "utf8"), "canonical");
  } finally { fs.rmSync(spaced, { recursive: true, force: true }); }
});
