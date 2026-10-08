import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareTrees, listArtifacts, listSourceInputs, sourceSnapshot } from "./check-artifact-reproducibility.mjs";

import * as reproducibility from "./check-artifact-reproducibility.mjs";

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

test("artifact certificate labels expected fresh bytes and actual release bytes correctly", () => {
  const expected = scratchTree({ "Core.nef": "fresh" });
  const actual = scratchTree({ "Core.nef": "release" });
  const rows = compareTrees(expected, actual);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const certificate = reproducibility.artifactCertificateHashes(rows);
  assert.equal(certificate.fresh_artifact_sha256["Core.nef"], hash("fresh"));
  assert.equal(certificate.release_artifact_sha256["Core.nef"], hash("release"));
});

test("listing ignores non-artifact files and missing directories", () => {
  const tree = scratchTree({ "Core.nef": "a", "Core.manifest.json": "{}", "README.md": "x" });
  assert.deepEqual(listArtifacts(tree), ["Core.manifest.json", "Core.nef"]);
  assert.deepEqual(listArtifacts(path.join(tree, "absent")), []);
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
