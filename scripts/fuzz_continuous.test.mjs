// Covers the preflight of scripts/fuzz_continuous.sh: a missing compiled .nef is
// an unprepared environment and must exit with a distinct "environment not ready"
// error (exit 2) before any dotnet test runs, never be reported as an invariant
// counterexample (verification finding FZ-18). A failing dotnet test must keep
// reporting a counterexample with exit 1. The script is exercised through a stub
// `dotnet` on PATH so no .NET restore, build or contract compilation is needed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "fuzz_continuous.sh");

// The artifacts the SourceInvariant_ suite deploys from contracts/bin/v3 (the
// directory contracts/compile.sh writes with nccs).
const REQUIRED_ARTIFACTS = [
  "UnifiedSmartWalletV3.nef",
  "UnifiedSmartWalletV3.manifest.json",
  "MockTransferTarget.nef",
  "MockTransferTarget.manifest.json",
];

const STUB_DOTNET = `#!/bin/sh
printf '%s\\n' "$*" >> "\${STUB_DOTNET_LOG}"
if [ "$1" = "test" ] && [ -n "\${STUB_DOTNET_TEST_FAILS:-}" ]; then
  exit 101
fi
exit 0
`;

function makeSandbox({ withArtifacts }) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "fuzz-continuous-test-"));
  const scriptsDir = path.join(sandbox, "scripts");
  const stubBin = path.join(sandbox, "stub-bin");
  mkdirSync(scriptsDir);
  mkdirSync(stubBin);
  copyFileSync(scriptPath, path.join(scriptsDir, "fuzz_continuous.sh"));
  if (withArtifacts) {
    const binDir = path.join(sandbox, "contracts", "bin", "v3");
    mkdirSync(binDir, { recursive: true });
    for (const name of REQUIRED_ARTIFACTS) {
      writeFileSync(path.join(binDir, name), name.endsWith(".nef") ? "NEF" : "{}");
    }
  }
  const stubDotnet = path.join(stubBin, "dotnet");
  writeFileSync(stubDotnet, STUB_DOTNET);
  chmodSync(stubDotnet, 0o755);
  return sandbox;
}

function readLog(logPath) {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

function runFuzzScript(sandbox, args, extraEnv = {}) {
  const stubBin = path.join(sandbox, "stub-bin");
  const logPath = path.join(sandbox, "dotnet-invocations.log");
  try {
    const stdout = execFileSync("bash", [path.join(sandbox, "scripts", "fuzz_continuous.sh"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubBin}${path.delimiter}${process.env.PATH}`,
        STUB_DOTNET_LOG: logPath,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("a missing compiled artifact is reported as environment-not-ready (exit 2), not as a counterexample", (t) => {
  const sandbox = makeSandbox({ withArtifacts: false });
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  // The stub is told to fail every dotnet test so a regression that reaches the
  // sweep cannot hang the runner or pass: the preflight must stop it first.
  const { status, stdout, stderr } = runFuzzScript(sandbox, ["4"], { STUB_DOTNET_TEST_FAILS: "1" });
  const output = `${stdout}\n${stderr}`;
  const logPath = path.join(sandbox, "dotnet-invocations.log");

  assert.equal(status, 2, `expected exit 2, got ${status}; output:\n${output}`);
  assert.match(output, /environment not ready/);
  assert.match(output, /contracts\/bin\/v3\/UnifiedSmartWalletV3\.nef/);
  assert.match(output, /contracts\/compile\.sh/, "must point at the remediation step");
  assert.doesNotMatch(output, /FAILURE DETECTED/);
  assert.doesNotMatch(output, /Failed seed/);
  assert.doesNotMatch(readLog(logPath), /(^|\n)test\b/, "no dotnet test may run without the artifacts");
});

test("a prepared environment proceeds to the sweep and completes with exit 0", (t) => {
  const sandbox = makeSandbox({ withArtifacts: true });
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  // HOURS=0 makes the sweep loop fall through immediately; the point is that the
  // preflight lets the script reach its normal completion.
  const { status, stdout, stderr } = runFuzzScript(sandbox, ["0"]);
  const output = `${stdout}\n${stderr}`;

  assert.equal(status, 0, `expected exit 0, got ${status}; output:\n${output}`);
  assert.match(output, /Sweep Complete/);
  assert.match(output, /ALL PASSED/);
  assert.match(readLog(path.join(sandbox, "dotnet-invocations.log")), /(^|\n)build\b/, "the solution build must still run");
});

test("a failing invariant test still reports the counterexample and exits 1", (t) => {
  const sandbox = makeSandbox({ withArtifacts: true });
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const { status, stdout, stderr } = runFuzzScript(sandbox, ["4"], { STUB_DOTNET_TEST_FAILS: "1" });
  const output = `${stdout}\n${stderr}`;

  assert.equal(status, 1, `expected exit 1, got ${status}; output:\n${output}`);
  assert.match(output, /FAILURE DETECTED/);
  assert.match(output, /Failed seed/);
  assert.match(readLog(path.join(sandbox, "dotnet-invocations.log")), /(^|\n)test\b/, "the failing step must be dotnet test");
});
