// Pins the ignore rules that keep secrets, dependencies, build output and tool
// state out of commits. The 2026-09-27 ".gitignore" standardization anchored
// several directory patterns to the root and narrowed ".env*" to ".env" and
// ".env.*", which silently un-ignored .envrc, .env-backup, sdk/js/dist/,
// frontend/.next/ and nested tool state, and started matching the tracked
// .codegraph/.gitignore. These tests fail on any such regression.
//
// The test runs in two environments and says which one it is in:
//
//   * a git work tree, where "git check-ignore --no-index" evaluates the root
//     and nested .gitignore files exactly as "git add" would, including for
//     paths that do not exist yet, and "git ls-files" names the tracked files;
//   * a clean "git archive" export, which carries no ".git" directory and no
//     index, so git cannot answer anything. The review service mandates that
//     export, so the ignore questions are answered there by reading the
//     .gitignore files directly (scripts/lib/gitignore-rules.mjs), and the one
//     question that needs the index is skipped with the environment named in
//     the skip reason. Nothing is skipped silently and no assertion is dropped:
//     in a work tree the git answers are the ones asserted, and the reader is
//     additionally held to them over every path in the tree by the test
//     "the ignore rules read the same in this tree and in git".

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadIgnoreRules } from "./lib/gitignore-rules.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// AA stays on GitHub-hosted runners, including default-branch pushes and manual
// runs. Require a literal runner: visibility, event, ref, fork and repository
// variables must never be able to redirect this public repository's scanner.
function assertHostedGitleaks(workflow) {
  const sections = workflow.split(/^jobs:\s*\n/m);
  assert.equal(sections.length, 2, "Gitleaks must have one jobs mapping");
  assert.deepEqual(
    sections[1].match(/^ {2}\S[^\r\n]*$/gm),
    ["  scan:"],
    "new Gitleaks jobs need an explicit hosted-runner policy review",
  );
  assert.deepEqual(
    workflow.match(/^\s*runs-on[^\r\n]*$/gm)?.map((line) => line.trim()),
    ["runs-on: ubuntu-latest"],
    "Gitleaks must use the fixed GitHub-hosted ubuntu-latest runner",
  );
  assert.match(sections[1], /^ {4}runs-on: ubuntu-latest$/m, "the runner belongs to scan");
}

test("Gitleaks stays hosted for every event and repository context", () => {
  assertHostedGitleaks(fs.readFileSync(path.join(repoRoot, ".github/workflows/gitleaks.yml"), "utf8"));
});

test("the Gitleaks policy rejects conditional and self-hosted routing", async (t) => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/gitleaks.yml"), "utf8");
  const hosted = workflow.replace(/^ {4}runs-on:[^\r\n]*$/m, "    runs-on: ubuntu-latest");
  assertHostedGitleaks(hosted);
  const routes = {
    "isolated label": "neoos-isolated-linux",
    "self-hosted label": "self-hosted",
    "self-hosted labels array": "[self-hosted, linux, x64]",
    "runner group": "\n      group: neoos-isolated-linux",
    "manual dispatch": "${{ github.event_name == 'workflow_dispatch' && 'neoos-isolated-linux' || 'ubuntu-latest' }}",
    "default branch push": "${{ github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && 'neoos-isolated-linux' || 'ubuntu-latest' }}",
    "public visibility": "${{ github.event.repository.private == false && 'neoos-isolated-linux' || 'ubuntu-latest' }}",
    "private visibility": "${{ github.event.repository.private && 'neoos-isolated-linux' || 'ubuntu-latest' }}",
    "same-repository PR": "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && 'self-hosted' || 'ubuntu-latest' }}",
    "fork PR": "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository && 'self-hosted' || 'ubuntu-latest' }}",
    "repository variable": "${{ vars.RUNNER || 'ubuntu-latest' }}",
    "duplicate runner": "ubuntu-latest\n    runs-on: self-hosted",
    "missing runner": "",
  };
  for (const [name, route] of Object.entries(routes)) {
    await t.test(name, () => {
      const mutant = hosted.replace("    runs-on: ubuntu-latest", `    runs-on: ${route}`);
      assert.throws(() => assertHostedGitleaks(mutant), assert.AssertionError);
    });
  }
  await t.test("additional reusable job", () => {
    assert.throws(
      () => assertHostedGitleaks(`${hosted}\n  other:\n    uses: ./.github/workflows/ci.yml\n`),
      assert.AssertionError,
    );
  });
});

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

// The export carries no .git directory, so a git that answers "fatal: not a
// git repository" is the signal that git-based answers are unavailable, not a
// failure of the tree under test.
const hasGitDirectory = fs.existsSync(path.join(repoRoot, ".git"));

function workTreeError() {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    return null;
  } catch (error) {
    if (error.status === 128) return error;
    throw error;
  }
}

const workTreeFailure = hasGitDirectory ? workTreeError() : new Error("no .git directory");
const inWorkTree = workTreeFailure === null;
const ignoreReader = inWorkTree ? null : loadIgnoreRules(repoRoot);

/** Returns the subset of `paths` that the repository's ignore rules exclude. */
function ignoredPaths(paths) {
  if (inWorkTree) {
    try {
      const out = git(["check-ignore", "--no-index", "--stdin"], `${paths.join("\n")}\n`);
      return new Set(out.split("\n").filter(Boolean));
    } catch (error) {
      // Exit status 1 means "none of the paths is ignored"; anything else is a real failure.
      if (error.status === 1) return new Set();
      throw error;
    }
  }
  return ignoreReader.ignoredSet(paths);
}

/** Every path of the exported tree, files and directories, excluding ".git". */
function treePaths() {
  const found = [];
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      found.push(child);
      if (entry.isDirectory()) visit(child);
    }
  };
  visit("");
  return found;
}

test("the hygiene checks know which environment they are running in", () => {
  // This is not the work-tree claim the previous version made; it is the claim
  // the two environments can both keep. An export must really be one (no .git
  // for a git-based answer to be silently wrong about), and a checkout must
  // really have a usable work tree, because every other test here then takes
  // its answers from git rather than from the reader.
  if (inWorkTree) {
    assert.equal(hasGitDirectory, true, "a work tree is diagnosed from a .git directory");
    assert.equal(git(["rev-parse", "--is-inside-work-tree"]).trim(), "true");
  } else {
    assert.equal(hasGitDirectory, false, "the export carries no .git directory");
    assert.equal(
      fs.existsSync(path.join(repoRoot, ".gitignore")),
      true,
      "the export still carries the ignore rules the reader needs",
    );
    assert.equal(ignoreReader.files().length > 0, true, "the reader found at least one .gitignore file");
  }
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

test("no tracked file matches an ignore rule", { skip: inWorkTree ? false : "a clean git archive export has no index: git ls-files cannot name the tracked files" }, () => {
  // A tracked file that also matches .gitignore disappears from `git add -A`
  // after deletion or rename and marks a pattern that is broader than intended.
  // Only the index can answer this, so the export skips it by name rather than
  // passing on a question it did not ask.
  const tracked = git(["ls-files", "--cached", "--ignored", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(tracked, [], `tracked files matching .gitignore:\n  ${tracked.join("\n  ")}`);
});

test("the ignore rules read the same in this tree and in git", { skip: inWorkTree ? false : "a clean git archive export has no git to compare the reader against" }, () => {
  // In a work tree the reader is not trusted: every path of the tree is asked
  // of git as well, so the answers the export does use are the answers git
  // gives here. This is what keeps the export's fallback from drifting into a
  // second, quieter set of ignore rules.
  //
  // The tree's own paths are not the whole question. The two lists above name
  // classes of file that mostly do not exist here yet, and those are exactly
  // the paths the export answers from the reader alone, so they are compared
  // too. The ".vercel" entries proved the point: no path in this tree is below
  // one, and a reader that stopped propagating an ignored ancestor stayed green
  // here while the archive export answered all three of them wrongly.
  const paths = [...new Set([...treePaths(), ...MUST_BE_IGNORED, ...MUST_NOT_BE_IGNORED])];
  assert.ok(paths.length > 100, `the comparison must cover the tree, saw ${paths.length} paths`);
  const fromGit = new Set();
  const batch = 500;
  for (let index = 0; index < paths.length; index += batch) {
    for (const ignored of ignoredPaths(paths.slice(index, index + batch))) fromGit.add(ignored);
  }
  const reader = loadIgnoreRules(repoRoot);
  const disagreements = paths
    .filter((relative) => reader.isIgnored(relative, isDirectory(relative)) !== fromGit.has(relative))
    .map((relative) => `${relative}: reader ${reader.isIgnored(relative, isDirectory(relative))}, git ${fromGit.has(relative)}`);
  assert.deepEqual(disagreements, [], `the reader and git disagree:\n  ${disagreements.join("\n  ")}`);
});

function isDirectory(relative) {
  // The pinned lists name paths that do not exist yet, and a path that is not
  // there is asked about as a file, the way "git check-ignore" reads a bare
  // spelling it cannot stat.
  const absolute = path.join(repoRoot, relative);
  return fs.existsSync(absolute) && fs.statSync(absolute).isDirectory();
}

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
