import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RESTORE_POLICY_FILES, compareTrees, listArtifacts, prepareScratch } from "./check-artifact-reproducibility.mjs";

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

test("the scratch copy carries the sources, the lock files and the restore policy, and none of the build output", () => {
  const scratch = prepareScratch();
  try {
    for (const file of RESTORE_POLICY_FILES) assert.ok(fs.existsSync(path.join(scratch, file)), `${file} is missing from the scratch copy`);
    assert.ok(fs.existsSync(path.join(scratch, "contracts", "UnifiedSmartWallet.Execution.cs")));
    assert.ok(fs.existsSync(path.join(scratch, "contracts", "packages.lock.json")));
    assert.ok(fs.existsSync(path.join(scratch, "contracts", "verifiers", "packages.SessionKeyVerifier.lock.json")));
    assert.ok(fs.existsSync(path.join(scratch, "scripts", "dotnet_env.sh")));
    for (const output of ["bin", "obj", "build"]) assert.ok(!fs.existsSync(path.join(scratch, "contracts", output)), `contracts/${output} must not be copied`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
