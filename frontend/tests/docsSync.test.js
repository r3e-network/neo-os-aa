import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The help pages under src/assets/docs/ are generated slices of the authoritative
// docs/ books (see scripts/sync-frontend-docs.mjs). This test recomputes every
// page and fails when an on-disk copy no longer matches its source chapter, so a
// hand edit or a stale copy cannot ship: run `npm run sync:docs` to regenerate.
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(frontendRoot, "..");
const syncScript = path.join(repoRoot, "scripts", "sync-frontend-docs.mjs");
const mappingFile = fs.readFileSync(syncScript, "utf8");

test("the frontend help pages declare their generation sources in the sync mapping", () => {
  assert.ok(mappingFile.includes("const MAPPING = ["), "the sync script lost its mapping table");
  for (const target of [
    "repo-readme.md",
    "guide.md",
    "workflow.md",
    "data-flow.md",
    "architecture.md",
    "sdk-usage.md",
    "evm-integration.md",
    "mixed-multisig.md",
    "module-guide.md",
    "MORPHEUS_PRIVATE_ACTIONS.md",
    "overview.zh.md",
    "guide.zh.md",
    "workflow.zh.md",
    "data-flow.zh.md",
    "architecture.zh.md",
    "MORPHEUS_PRIVATE_ACTIONS.zh-CN.md",
  ]) {
    assert.ok(mappingFile.includes(`target: '${target}'`), `the sync mapping no longer generates ${target}`);
  }
});

test("every generated help page matches the authoritative docs/ books byte for byte", () => {
  const result = spawnSync(process.execPath, [syncScript, "--check"], { encoding: "utf8" });
  if (result.status !== 0) {
    assert.fail(
      `docs drift detected between docs/ and src/assets/docs/:\n${result.stdout}${result.stderr}`,
    );
  }
});
