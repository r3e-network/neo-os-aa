import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PATHS,
  compilerProblems,
  failureMessage,
  listProjects,
  lockFileFor,
  lockFileProblems,
  parseManifest,
  pinConsistencyProblems,
  readOptionalPinnedVersion,
  readPinnedVersion,
  restoreFailures,
  restoredPackageProblems,
} from "./check_neo_platform_packages.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const manifest = parseManifest(read(PATHS.manifest));
const projects = listProjects(repoRoot);

// Captured from `dotnet restore --force` of contracts/UnifiedSmartWallet.csproj against a lock file
// that was edited by hand (2026-10-04, paths shortened).
const STALE_LOCK_RESTORE = `
  Determining projects to restore...
/w/contracts/UnifiedSmartWallet.csproj : error NU1004: The package reference Neo.SmartContract.Framework version has changed from [3.10.0, ) to [3.10.1, ).The packages lock file is inconsistent with the project dependencies so restore can't be run in locked mode. Disable the RestoreLockedMode MSBuild property or pass an explicit --force-evaluate option to run restore to update the lock file.
  Failed to restore /w/contracts/UnifiedSmartWallet.csproj (in 72 ms).
`;

const FORGED_LOCK_RESTORE = `
  Determining projects to restore...
/w/contracts/UnifiedSmartWallet.csproj : error NU1403: Package content hash validation failed for Neo.SmartContract.Framework.3.10.1. The package is different than the last restore.
/w/contracts/UnifiedSmartWallet.csproj : error NU1403: 
  Failed to restore /w/contracts/UnifiedSmartWallet.csproj (in 487 ms).
`;

// Captured from `dotnet restore` of a project that pins a version nuget.org does not have.
const MISSING_VERSION_RESTORE = `
  Determining projects to restore...
/w/contracts/UnifiedSmartWallet.csproj : error NU1102: Unable to find package Neo.SmartContract.Framework with version (>= 3.10.2-CI00384)
/w/contracts/UnifiedSmartWallet.csproj : error NU1102:   - Found 35 version(s) in nuget.org [ Nearest version: 3.10.1 ]
  Failed to restore /w/contracts/UnifiedSmartWallet.csproj (in 5.54 sec).
`;

function locksFromRepository() {
  return projects.map((project) => {
    const file = lockFileFor(project, projects);
    const absolute = path.join(repoRoot, file);
    return { project, file, lock: fs.existsSync(absolute) ? JSON.parse(fs.readFileSync(absolute, "utf8")) : null };
  });
}

function librariesFromManifest(overrides = {}) {
  const libraries = {};
  for (const pkg of manifest.packages) libraries[`${pkg.id}/${pkg.version}`] = { sha512: pkg.sha512, type: "package" };
  return { ...libraries, ...overrides };
}

test("the pin in Directory.Build.props and the audited manifest agree, and no project declares another", () => {
  const propsVersion = readPinnedVersion(read(PATHS.props), PATHS.props);
  const testsVersion = readOptionalPinnedVersion(read(PATHS.testsProject), PATHS.testsProject);
  assert.equal(testsVersion, null, "the tests project takes the pin from Directory.Build.props");
  assert.deepEqual(pinConsistencyProblems({ propsVersion, testsVersion, manifest }), []);
  for (const project of projects.filter((candidate) => candidate !== PATHS.testsProject)) {
    assert.equal(readOptionalPinnedVersion(read(project), project), null, `${project} must not declare its own pin`);
  }
});

test("the pinned framework is a published release, not a pre-release build", () => {
  const propsVersion = readPinnedVersion(read(PATHS.props), PATHS.props);
  assert.match(propsVersion, /^\d+\.\d+\.\d+$/, "a pre-release or CI build number would not be on nuget.org");
  assert.match(manifest.compiler.version, /^\d+\.\d+\.\d+$/);
});

test("the manifest lists the framework, the test engine, their Neo closure and the compiler", () => {
  const ids = manifest.packages.map((pkg) => pkg.id).sort();
  assert.deepEqual(ids, [
    "Neo",
    "Neo.Cryptography.BLS12_381",
    "Neo.Disassembler.CSharp",
    "Neo.Extensions",
    "Neo.IO",
    "Neo.Json",
    "Neo.SmartContract.Framework",
    "Neo.SmartContract.Testing",
    "Neo.VM",
  ]);
  assert.equal(manifest.compiler.id, "Neo.Compiler.CSharp");
  assert.equal(manifest.compiler.tool, "nccs");
  for (const pkg of [...manifest.packages, manifest.compiler]) assert.equal(pkg.availableOn, "nuget.org");
});

test("pin drift between the props file, the tests project and the manifest is reported", () => {
  const problems = pinConsistencyProblems({ propsVersion: "3.10.2", testsVersion: "3.10.1", manifest });
  assert.equal(problems.length, 4);
  assert.match(problems[0], /AbstractAccount\.Contracts\.Tests\.csproj pins 3\.10\.1 but Directory\.Build\.props pins 3\.10\.2/);
  assert.match(problems[1], /neo-platform-packages\.json records 3\.10\.1 but Directory\.Build\.props pins 3\.10\.2/);
  assert.match(problems[2], /lists Neo\.SmartContract\.Framework 3\.10\.1, expected 3\.10\.2/);
  assert.match(problems[3], /lists Neo\.SmartContract\.Testing 3\.10\.1, expected 3\.10\.2/);
});

test("a manifest without the compiler is reported", () => {
  const { compiler: _compiler, ...withoutCompiler } = manifest;
  const problems = pinConsistencyProblems({ propsVersion: manifest.frameworkVersion, manifest: withoutCompiler });
  assert.deepEqual(problems, [`${PATHS.manifest} does not record the pinned compiler`]);
});

test("every project that restores Neo packages has a committed lock file that agrees with the audit", () => {
  assert.equal(projects.length, 26, "25 contract projects and the tests project");
  const locks = locksFromRepository();
  assert.deepEqual(lockFileProblems(locks, manifest), []);
  assert.ok(locks.every(({ lock }) => lock !== null));
});

test("projects that share a directory get their own lock file, the others use packages.lock.json", () => {
  const files = projects.map((project) => lockFileFor(project, projects));
  assert.equal(new Set(files).size, projects.length, "no two projects may share a lock file");
  assert.equal(lockFileFor("contracts/UnifiedSmartWallet.csproj", projects), "contracts/packages.lock.json");
  assert.equal(lockFileFor(PATHS.testsProject, projects), "tests/AbstractAccount.Contracts.Tests/packages.lock.json");
  assert.equal(lockFileFor("contracts/hooks/MultiHook.csproj", projects), "contracts/hooks/packages.MultiHook.lock.json");
  assert.equal(lockFileFor("contracts/verifiers/ZkLoginVerifier.csproj", projects), "contracts/verifiers/packages.ZkLoginVerifier.lock.json");
});

test("a missing lock file, a different version and different bytes in a lock file are reported", () => {
  const framework = manifest.packages.find((pkg) => pkg.id === "Neo.SmartContract.Framework");
  const lockWith = (entry) => ({ version: 1, dependencies: { "net10.0": { "Neo.SmartContract.Framework": entry } } });
  const good = { type: "Direct", requested: `[${framework.version}, )`, resolved: framework.version, contentHash: framework.sha512 };
  const project = "contracts/market/AAAddressMarket.csproj";
  const file = "contracts/market/packages.lock.json";
  assert.deepEqual(lockFileProblems([{ project, file, lock: lockWith(good) }], manifest), []);
  assert.deepEqual(lockFileProblems([{ project, file, lock: null }], manifest), [
    `${file} is missing; every project that restores Neo packages commits its lock file`,
  ]);
  const older = lockFileProblems([{ project, file, lock: lockWith({ ...good, resolved: "3.10.0" }) }], manifest);
  assert.deepEqual(older, [`${file} locks Neo.SmartContract.Framework 3.10.0, audited ${framework.version}`]);
  const forged = lockFileProblems([{ project, file, lock: lockWith({ ...good, contentHash: `${"A".repeat(86)}==` }) }], manifest);
  assert.equal(forged.length, 1);
  assert.match(forged[0], /locks Neo\.SmartContract\.Framework 3\.10\.1 with content hash A+==, audited /);
});

test("a lock file must lock the framework, the tests lock must lock the test engine, and no unlisted Neo package may appear", () => {
  const framework = manifest.packages.find((pkg) => pkg.id === "Neo.SmartContract.Framework");
  const empty = { version: 1, dependencies: { "net10.0": {} } };
  assert.deepEqual(lockFileProblems([{ project: "contracts/market/AAAddressMarket.csproj", file: "m.lock.json", lock: empty }], manifest), [
    "m.lock.json does not lock Neo.SmartContract.Framework",
  ]);
  const frameworkOnly = {
    version: 1,
    dependencies: {
      "net10.0": {
        "Neo.SmartContract.Framework": { type: "Direct", resolved: framework.version, contentHash: framework.sha512 },
      },
    },
  };
  assert.deepEqual(lockFileProblems([{ project: PATHS.testsProject, file: "t.lock.json", lock: frameworkOnly }], manifest), [
    "t.lock.json does not lock Neo.SmartContract.Testing",
  ]);
  const extra = structuredClone(frameworkOnly);
  extra.dependencies["net10.0"]["Neo.Plugins.Example"] = { type: "Transitive", resolved: "1.0.0", contentHash: "x" };
  assert.deepEqual(lockFileProblems([{ project: "contracts/market/AAAddressMarket.csproj", file: "m.lock.json", lock: extra }], manifest), [
    `m.lock.json locks Neo.Plugins.Example 1.0.0, which is not in ${PATHS.manifest}`,
  ]);
});

test("locked-mode failures are recognised and explained", () => {
  assert.deepEqual(
    restoreFailures(STALE_LOCK_RESTORE).map((failure) => failure.code),
    ["NU1004"],
  );
  assert.match(restoreFailures(STALE_LOCK_RESTORE)[0].cause, /packages\.lock\.json/);
  assert.match(restoreFailures(STALE_LOCK_RESTORE)[0].message, /Neo\.SmartContract\.Framework version has changed from \[3\.10\.0, \) to \[3\.10\.1, \)/);
  assert.deepEqual(
    restoreFailures(FORGED_LOCK_RESTORE).map((failure) => failure.code),
    ["NU1403"],
  );
  assert.match(restoreFailures(FORGED_LOCK_RESTORE)[0].cause, /bytes differ/);
});

test("a pin that is not on the package source is recognised", () => {
  const failures = restoreFailures(MISSING_VERSION_RESTORE);
  assert.deepEqual(failures.map((failure) => failure.code), ["NU1102", "NU1102"]);
  assert.match(failures[0].message, /Unable to find package Neo\.SmartContract\.Framework with version \(>= 3\.10\.2-CI00384\)/);
});

test("restore output with no NuGet error is not blamed on packages", () => {
  assert.deepEqual(restoreFailures("  Determining projects to restore...\n  Restored /w/t.csproj (in 1 sec).\n"), []);
  assert.deepEqual(restoreFailures("/w/t.csproj : error CS1002: ; expected"), []);
});

test("the failure message names the framework version, every pinned package, the compiler and the way to bump", () => {
  const message = failureMessage(manifest, "dotnet restore failed:", ["NU1004: example"]);
  assert.match(message, /framework 3\.10\.1/);
  assert.match(message, /How to bump/);
  assert.ok(message.includes(PATHS.doc));
  for (const pkg of manifest.packages) assert.ok(message.includes(`${pkg.id} ${pkg.version}`), `${pkg.id} missing from message`);
  assert.ok(message.includes("Neo.Compiler.CSharp 3.9.1 (nccs)"));
});

test("restored packages with the audited bytes pass", () => {
  assert.deepEqual(restoredPackageProblems(librariesFromManifest(), manifest), []);
});

test("a feed serving different bytes under the pinned version is refused", () => {
  const framework = manifest.packages.find((pkg) => pkg.id === "Neo.SmartContract.Framework");
  const forged = `${"A".repeat(86)}==`;
  const problems = restoredPackageProblems(
    librariesFromManifest({ [`${framework.id}/${framework.version}`]: { sha512: forged, type: "package" } }),
    manifest,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Neo\.SmartContract\.Framework 3\.10\.1 sha512 is A+==, audited /);
});

test("a different version of a pinned package, or a stale manifest entry, is refused", () => {
  const libraries = librariesFromManifest();
  delete libraries["Neo/3.10.1"];
  libraries["Neo/3.10.0"] = { sha512: `${"B".repeat(86)}==`, type: "package" };
  delete libraries["Neo.VM/3.10.1"];
  const problems = restoredPackageProblems(libraries, manifest);
  assert.deepEqual(problems, [
    "Neo restored as Neo/3.10.0, not the audited 3.10.1",
    "Neo.VM 3.10.1 is not in the restore graph; the manifest is stale",
  ]);
});

test("a Neo package that is restored but not audited is refused, other packages are not", () => {
  const libraries = librariesFromManifest({
    "Neo.Plugins.Example/1.0.0": { sha512: "x", type: "package" },
    "Newtonsoft.Json/13.0.3": { sha512: "y", type: "package" },
    "Neo.Project/1.0.0": { sha512: "z", type: "project" },
  });
  assert.deepEqual(restoredPackageProblems(libraries, manifest), [`Neo.Plugins.Example/1.0.0 was restored but is not in ${PATHS.manifest}`]);
});

test("the installed compiler must be the pinned package", () => {
  const compiler = manifest.compiler;
  const good = { versionOutput: `${compiler.version}+abcdef\n`, nupkgSha256: compiler.sha256, contentHash: compiler.sha512 };
  assert.deepEqual(compilerProblems(good, compiler), []);
  assert.deepEqual(compilerProblems({ ...good, versionOutput: "3.10.1+abcdef" }, compiler), ["nccs reports version 3.10.1, pinned 3.9.1"]);
  assert.deepEqual(compilerProblems({ ...good, versionOutput: "" }, compiler), ["nccs reports version (nothing), pinned 3.9.1"]);
  const forgedPackage = compilerProblems({ ...good, nupkgSha256: "0".repeat(64) }, compiler);
  assert.equal(forgedPackage.length, 1);
  assert.match(forgedPackage[0], /package has sha256 0+, audited /);
  const forgedHash = compilerProblems({ ...good, contentHash: `${"C".repeat(86)}==` }, compiler);
  assert.equal(forgedHash.length, 1);
  assert.match(forgedHash[0], /content hash C+==, audited /);
  assert.equal(compilerProblems({ ...good, nupkgSha256: null, contentHash: null }, compiler).length, 2);
});

test("nuget.config makes nuget.org the only package source and maps every package to it", () => {
  const config = read(PATHS.nugetConfig);
  assert.match(config, /<packageSources>\s*(<!--[\s\S]*?-->\s*)?<clear \/>/, "inherited sources must be cleared");
  assert.deepEqual([...config.matchAll(/<add key="([^"]+)" value="([^"]+)"/g)].map((match) => [match[1], match[2]]), [
    ["nuget.org", "https://api.nuget.org/v3/index.json"],
  ]);
  assert.match(
    config,
    /<packageSourceMapping>\s*<clear \/>\s*<packageSource key="nuget\.org">\s*<package pattern="\*" \/>/,
    "inherited mappings must be cleared before nuget.org is mapped",
  );
});

test("Directory.Build.props locks every restore and refuses a restore that would change a lock file", () => {
  const props = read(PATHS.props);
  assert.match(props, /<RestorePackagesWithLockFile>true<\/RestorePackagesWithLockFile>/);
  assert.match(props, /<RestoreLockedMode Condition="'\$\(RestoreLockedMode\)' == ''">true<\/RestoreLockedMode>/);
  assert.match(props, /<NuGetLockFilePath Condition="[^"]*GetFiles[^"]*&gt; 1">packages\.\$\(MSBuildProjectName\)\.lock\.json<\/NuGetLockFilePath>/);
  assert.ok(!/--/.test([...props.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1]).join("")), "XML comments cannot contain a double dash");
});

test("CI runs the hygiene tests, then the package gate, before any dependency install or build", () => {
  const ci = read(".github/workflows/ci.yml");
  const at = (needle) => {
    const index = ci.indexOf(needle);
    assert.notEqual(index, -1, `ci.yml does not contain ${needle}`);
    return index;
  };
  const gate = at("run: node scripts/check_neo_platform_packages.mjs");
  const hygiene = at("run: node --test scripts/repo_hygiene.test.mjs scripts/check_neo_platform_packages.test.mjs");
  assert.ok(at("actions/setup-dotnet@") < gate, "the gate needs the .NET SDK");
  assert.ok(at("actions/setup-node@") < hygiene, "the tests need Node");
  assert.ok(hygiene < gate, "hygiene tests must not be blocked by the package gate");
  for (const later of ["dotnet tool install -g neo.compiler.csharp", "run: npm ci", "npm run test:e2e:install", "run: ./scripts/verify_repo.sh"]) {
    assert.ok(gate < at(later), `the package gate must run before ${later}`);
  }
  assert.ok(!/known red/i.test(ci), "the gate is no longer expected to fail");
});

test("CI installs exactly the pinned compiler and names the pinned versions", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.ok(
    ci.includes(`dotnet tool install -g neo.compiler.csharp --version ${manifest.compiler.version}`),
    "the nccs install in ci.yml must match the compiler pinned in the manifest",
  );
  assert.ok(ci.includes(manifest.frameworkVersion), "the gate step must name the pinned framework version");
});

test("verify_repo.sh runs the package and compiler gates before the first contract build", () => {
  const script = read("scripts/verify_repo.sh");
  const gate = script.indexOf("node scripts/check_neo_platform_packages.mjs\n");
  const compiler = script.indexOf("node scripts/check_neo_platform_packages.mjs --compiler-only");
  assert.notEqual(gate, -1);
  assert.notEqual(compiler, -1);
  for (const first of ["dotnet build contracts/UnifiedSmartWallet.csproj", "bash contracts/compile.sh", "dotnet test neo-abstract-account.sln"]) {
    assert.ok(gate < script.indexOf(first), `the package gate must run before ${first}`);
    assert.ok(compiler < script.indexOf(first), `the compiler gate must run before ${first}`);
  }
  // Both suites belong to the contract gate's `node --test` invocation.
  const nodeTest = script.indexOf("node --test scripts/lib/deploy-helpers.test.mjs");
  const format = script.indexOf("dotnet format neo-abstract-account.sln");
  for (const suite of ["scripts/check_neo_platform_packages.test.mjs", "scripts/repo_hygiene.test.mjs"]) {
    const at = script.indexOf(suite, nodeTest);
    assert.ok(nodeTest !== -1 && at > nodeTest && at < format, `${suite} is not in the contract gate's node --test run`);
  }
});

test("compile.sh refuses to compile with an unpinned compiler", () => {
  const script = read("contracts/compile.sh");
  const gate = script.indexOf("node \"$ROOT_DIR/scripts/check_neo_platform_packages.mjs\" --compiler-only");
  assert.notEqual(gate, -1);
  assert.ok(gate < script.indexOf('"$NCCS_BIN" UnifiedSmartWallet.csproj'));
});
