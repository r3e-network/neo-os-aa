// Pins the ignore rules that keep secrets, dependencies, build output and tool
// state out of commits. The 2026-09-27 ".gitignore" standardization anchored
// several directory patterns to the root and narrowed ".env*" to ".env" and
// ".env.*", which silently un-ignored .envrc, .env-backup, sdk/js/dist/,
// frontend/.next/ and nested tool state, and started matching the tracked
// .codegraph/.gitignore. These tests fail on any such regression.
//
// `git check-ignore --no-index` evaluates the root and nested .gitignore files
// exactly as `git add` would, including for paths that do not exist yet.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every entry stands for a class of file that must never be committed.
const MUST_BE_IGNORED = [
  // Environment files: every variant, at any depth.
  ".env",
  ".env.local",
  ".env.production",
  ".envrc",
  ".env-backup",
  ".env_prod",
  "deploy/.env_prod",
  "scripts/.envrc",
  "sdk/js/.env",
  "sdk/js/.env-backup",
  "sdk/js/.envrc",
  "frontend/.env.production.local",
  "frontend/.envrc",
  "contracts/.env.mainnet",
  "tests/.env.testnet",
  // Key material.
  "keys/deployer.pem",
  "scripts/wallet.key",
  "id_rsa",
  "backup.gpg",
  "cert.p12",
  // Dependencies at every depth.
  "node_modules/pkg/index.js",
  "frontend/node_modules/pkg/index.js",
  "sdk/js/node_modules/pkg/index.js",
  "scripts/node_modules/pkg/index.js",
  // .NET and nccs build output at every depth.
  "contracts/bin/v3/UnifiedSmartWallet.nef",
  "contracts/obj/project.assets.json",
  "contracts/verifiers/bin/sc/SessionKeyVerifier.nef",
  "tests/AbstractAccount.Contracts.Tests/bin/Release/net10.0/AbstractAccount.Contracts.Tests.dll",
  "tests/AbstractAccount.Contracts.Tests/obj/project.assets.json",
  // JavaScript build, coverage and test output at every depth.
  "dist/index.js",
  "frontend/dist/index.html",
  "sdk/js/dist/index.js",
  "coverage/lcov.info",
  "frontend/coverage/lcov.info",
  "sdk/js/coverage/lcov.info",
  "test-results/results.json",
  "frontend/test-results/.last-run.json",
  "sdk/js/test-results/results.json",
  "frontend/.next/BUILD_ID",
  "sdk/js/.turbo/cache.json",
  ".vercel/project.json",
  "frontend/.vercel/project.json",
  "sdk/js/.vercel/project.json",
  "frontend/npm-debug.log",
  "release.neopkg",
  "frontend/public/module.wasm",
  // Editor and local tool state at every depth.
  ".local/settings.local.json",
  "frontend/.local/settings.local.json",
  "sdk/js/.local/settings.local.json",
  ".serena/project.yml",
  "sdk/js/.serena/project.yml",
  ".idea/workspace.xml",
  "frontend/.idea/workspace.xml",
  ".vscode/settings.json",
  "frontend/.vscode/settings.json",
  ".worktrees/branch/README.md",
  "frontend/.worktrees/branch/README.md",
  ".omx/tmux-hook.json",
  "frontend/.omx/state.json",
  "graphify-out/graph.json",
  "docs/graphify-out/graph.json",
  ".codegraph/codegraph.db",
  "frontend/.codegraph/codegraph.db",
  ".planning/PLAN.md",
  ".workbuddy/state.json",
  ".automation-logs/run.txt",
];

// Checked-in files that an over-broad pattern could hide.
const MUST_NOT_BE_IGNORED = [
  ".env.example",
  "frontend/.env.example",
  "sdk/js/.env.example",
  ".codegraph/.gitignore",
  "contracts/build/UnifiedSmartWalletV3.nef",
  "contracts/build/UnifiedSmartWalletV3.manifest.json",
  "contracts/UnifiedSmartWallet.csproj",
  "Directory.Build.props",
  "nuget.config",
  "contracts/packages.lock.json",
  "contracts/verifiers/packages.SessionKeyVerifier.lock.json",
  "tests/AbstractAccount.Contracts.Tests/packages.lock.json",
  "tests/AbstractAccount.Contracts.Tests/fixtures/deployed-mainnet/UnifiedSmartWalletV3.nef",
  "frontend/package.json",
  "sdk/js/package.json",
  "scripts/verify_repo.sh",
  ".github/workflows/ci.yml",
];

// A developer's global excludes file must not decide the outcome: only the
// repository's own .gitignore files travel with a clone.
function git(args, input) {
  return execFileSync("git", ["-c", "core.excludesFile=/dev/null", ...args], { cwd: repoRoot, encoding: "utf8", input });
}

/** Returns the subset of `paths` that the repository's ignore rules exclude. */
function ignoredPaths(paths) {
  try {
    const out = git(["check-ignore", "--no-index", "--stdin"], `${paths.join("\n")}\n`);
    return new Set(out.split("\n").filter(Boolean));
  } catch (error) {
    // Exit status 1 means "none of the paths is ignored"; anything else is a real failure.
    if (error.status === 1) return new Set();
    throw error;
  }
}

test("the hygiene checks run inside a git work tree", () => {
  assert.equal(git(["rev-parse", "--is-inside-work-tree"]).trim(), "true");
});

test("secrets, dependencies, build output and tool state stay ignored at every depth", () => {
  const ignored = ignoredPaths(MUST_BE_IGNORED);
  const exposed = MUST_BE_IGNORED.filter((file) => !ignored.has(file));
  assert.deepEqual(exposed, [], `these paths would be committable:\n  ${exposed.join("\n  ")}`);
});

test("checked-in examples, provenance anchors and sources are not ignored", () => {
  const ignored = ignoredPaths(MUST_NOT_BE_IGNORED);
  const hidden = MUST_NOT_BE_IGNORED.filter((file) => ignored.has(file));
  assert.deepEqual(hidden, [], `these paths are wrongly ignored:\n  ${hidden.join("\n  ")}`);
});

test("no tracked file matches an ignore rule", () => {
  // A tracked file that also matches .gitignore disappears from `git add -A`
  // after deletion or rename and marks a pattern that is broader than intended.
  const tracked = git(["ls-files", "--cached", "--ignored", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(tracked, [], `tracked files matching .gitignore:\n  ${tracked.join("\n  ")}`);
});

// SR-19: without .github/dependabot.yml the dependency graph produces no update
// PRs and the alert inventory drifts stale. Every package.json tree in the
// repository must be covered by an npm entry, and the root .NET solution by the
// nuget entry.
function packageJsonDirectories(root) {
  const found = [];
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || !entry.isDirectory()) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (fs.existsSync(path.join(root, child, "package.json"))) found.push(child);
      visit(child);
    }
  };
  visit("");
  return found.sort();
}

test("dependabot covers every npm tree and the root nuget solution", () => {
  const config = fs.readFileSync(path.join(repoRoot, ".github", "dependabot.yml"), "utf8");
  const npmDirectories = packageJsonDirectories(repoRoot);
  assert.notDeepEqual(npmDirectories, [], "the discovery itself must find this repository's npm trees");
  const missing = npmDirectories.filter((dir) => !config.includes(`directory: "/${dir}"`));
  assert.deepEqual(
    missing,
    [],
    `.github/dependabot.yml is missing npm entries for:\n  ${missing.join("\n  ")}`,
  );
  assert.match(config, /package-ecosystem: "nuget"/, "the root nuget solution must be covered");
  assert.match(config, /directory: "\/"\s*\n\s*schedule:\s*\n\s*interval: "daily"/, "the nuget entry must watch the repository root");
});
