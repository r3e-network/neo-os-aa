#!/usr/bin/env node

// Fail-fast gate for the pinned Neo platform packages (audit finding R-11 / N-DEP-1).
//
// Every contract project takes Neo.SmartContract.Framework, and the contract tests take
// Neo.SmartContract.Testing, at the version NeoSmartContractFrameworkVersion pins in
// Directory.Build.props. Both are published on nuget.org, which nuget.config makes the only
// package source. The gate stops a build whose packages are not exactly the audited ones:
//
//   * the props pin, the tests project and contracts/neo-platform-packages.json must agree;
//   * every project in the selected profile must have a committed lock file (packages.lock.json, or
//     packages.ProjectName.lock.json where a directory holds several projects) whose Neo packages
//     are the audited versions with the audited content hashes;
//   * the tests project, which also builds the AA core, must restore in locked mode, and every
//     Neo package it restored must have the audited SHA-512 (a Neo package that is not listed in
//     the manifest is refused too);
//   * with --compiler-only, the installed nccs must be the pinned compiler package, byte for byte.
//
// Public/platform gates exclude the separately built native profile. --include-native
// also checks six native modules, both test-only epoch probes, and two hosts
// that reference a validated source runtime instead of Neo NuGet assemblies.
// Usage: node scripts/check_neo_platform_packages.mjs [--compiler-only | --include-native]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
  props: "Directory.Build.props",
  nugetConfig: "nuget.config",
  testsProject: "tests/AbstractAccount.Contracts.Tests/AbstractAccount.Contracts.Tests.csproj",
  contractsDir: "contracts",
  nativeProbeProject: "tests/NativeEpochProbe/NativeEpochProbe.csproj",
  nativeProbeContractProject: "tests/NativeEpochProbe/contracts/NativeEpochCore.csproj",
  nativeRuntimeProbeProject: "tests/NativeModuleProbe/NativeModuleProbe.csproj",
  nativeMultiSigProbeProject: "tests/NativeMultiSigProbe/NativeMultiSigProbe.csproj",
  coreAssets: "contracts/obj/project.assets.json",
  testsAssets: "tests/AbstractAccount.Contracts.Tests/obj/project.assets.json",
  manifest: "contracts/neo-platform-packages.json",
  doc: "docs/AA-REPRODUCIBLE-BUILD.md",
};

const NEO_OWNED = /^Neo(\.|$)/i;

/** Reads the default NeoSmartContractFrameworkVersion declared in an MSBuild file. */
export function readPinnedVersion(xml, file) {
  const match = /<NeoSmartContractFrameworkVersion\b[^>]*>\s*([^<\s]+)\s*<\/NeoSmartContractFrameworkVersion>/.exec(xml);
  if (!match) throw new Error(`${file} does not declare NeoSmartContractFrameworkVersion`);
  return match[1];
}

/** Like readPinnedVersion, but a file that declares no pin (it inherits the props) yields null. */
export function readOptionalPinnedVersion(xml, file) {
  try {
    return readPinnedVersion(xml, file);
  } catch {
    return null;
  }
}

function assertDigests(entry, file) {
  for (const field of ["id", "version", "sha512", "sha256"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      throw new Error(`${file}: every package needs a non-empty ${field}`);
    }
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512)) throw new Error(`${file}: ${entry.id} sha512 must be base64 SHA-512`);
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`${file}: ${entry.id} sha256 must be lowercase hex SHA-256`);
}

/** Validates the manifest shape and returns it. */
export function parseManifest(text, file = PATHS.manifest) {
  const manifest = JSON.parse(text);
  if (typeof manifest.frameworkVersion !== "string" || !Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error(`${file} must declare frameworkVersion and a non-empty packages list`);
  }
  const seen = new Set();
  for (const entry of manifest.packages) {
    assertDigests(entry, file);
    const key = entry.id.toLowerCase();
    if (seen.has(key)) throw new Error(`${file}: ${entry.id} is listed twice`);
    seen.add(key);
  }
  if (manifest.compiler !== undefined) {
    assertDigests(manifest.compiler, `${file} compiler`);
    if (typeof manifest.compiler.tool !== "string" || manifest.compiler.tool.length === 0) {
      throw new Error(`${file}: the compiler entry needs the name of its tool command`);
    }
  }
  return manifest;
}

/** Returns human-readable problems when the pins and the audited manifest disagree. */
export function pinConsistencyProblems({ propsVersion, testsVersion = null, manifest }) {
  const problems = [];
  if (JSON.stringify(manifest.sourceRuntimeProbeProjects)
    !== JSON.stringify([PATHS.nativeRuntimeProbeProject, PATHS.nativeMultiSigProbeProject])) {
    problems.push(`${PATHS.manifest} source runtime probe project inventory is missing or changed`);
  }
  if (testsVersion !== null && testsVersion !== propsVersion) {
    problems.push(`${PATHS.testsProject} pins ${testsVersion} but ${PATHS.props} pins ${propsVersion}`);
  }
  if (manifest.frameworkVersion !== propsVersion) {
    problems.push(`${PATHS.manifest} records ${manifest.frameworkVersion} but ${PATHS.props} pins ${propsVersion}`);
  }
  for (const id of ["Neo.SmartContract.Framework", "Neo.SmartContract.Testing"]) {
    const entry = manifest.packages.find((pkg) => pkg.id === id);
    if (!entry) problems.push(`${PATHS.manifest} does not list ${id}`);
    else if (entry.version !== propsVersion) problems.push(`${PATHS.manifest} lists ${id} ${entry.version}, expected ${propsVersion}`);
  }
  if (!manifest.compiler) problems.push(`${PATHS.manifest} does not record the pinned compiler`);
  return problems;
}

/** Lists projects in the selected build scope, relative to the repository root. */
export function listProjects(root = repoRoot, { includeNative = false } = {}) {
  const found = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === "bin" || entry.name === "obj" || entry.name === "node_modules") continue;
      const child = `${relative}/${entry.name}`;
      if (!includeNative && child === "contracts/native") continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".csproj")) found.push(child);
    }
  };
  walk(PATHS.contractsDir);
  return [...found.sort(), PATHS.testsProject, ...(includeNative
    ? [PATHS.nativeProbeProject, PATHS.nativeProbeContractProject,
      PATHS.nativeRuntimeProbeProject, PATHS.nativeMultiSigProbeProject]
    : [])];
}

/**
 * The lock file that belongs to a project file. A directory that holds several projects
 * (contracts/hooks, contracts/verifiers, contracts/mocks) would share one packages.lock.json, so its
 * projects use packages.ProjectName.lock.json, as Directory.Build.props configures.
 */
export function lockFileFor(project, projects) {
  const directory = path.posix.dirname(project);
  const siblings = projects.filter((other) => path.posix.dirname(other) === directory);
  const name = siblings.length > 1 ? `packages.${path.posix.basename(project, ".csproj")}.lock.json` : "packages.lock.json";
  return path.posix.join(directory, name);
}

function lockedDependencies(lock) {
  const entries = [];
  for (const [framework, dependencies] of Object.entries(lock?.dependencies ?? {})) {
    for (const [id, info] of Object.entries(dependencies)) entries.push({ framework, id, ...info });
  }
  return entries;
}

/**
 * Compares the committed lock files with the audited manifest. `locks` lists every project with the
 * path of its lock file and the parsed content, or null when the file is missing.
 */
export function lockFileProblems(locks, manifest) {
  const problems = [];
  const audited = new Map(manifest.packages.map((pkg) => [pkg.id.toLowerCase(), pkg]));
  for (const { project, file, lock } of locks) {
    if (lock === null) {
      problems.push(`${file} is missing; every project that restores Neo packages commits its lock file`);
      continue;
    }
    const entries = lockedDependencies(lock);
    if ([PATHS.nativeRuntimeProbeProject, PATHS.nativeMultiSigProbeProject].includes(project)) {
      if (lock.version !== 1 || Object.keys(lock.dependencies ?? {}).length !== 1
        || !Object.hasOwn(lock.dependencies ?? {}, "net10.0") || entries.length !== 0) {
        problems.push(`${file} must lock an empty net10.0 NuGet graph; Neo assemblies come from the validated source runtime`);
      }
      continue;
    }
    const names = new Set(entries.map((entry) => entry.id.toLowerCase()));
    const required = project === PATHS.nativeProbeProject
      ? ["Neo.SmartContract.Testing"]
      : ["Neo.SmartContract.Framework"];
    if (project === PATHS.testsProject) required.push("Neo.SmartContract.Testing");
    for (const id of required) {
      if (!names.has(id.toLowerCase())) problems.push(`${file} does not lock ${id}`);
    }
    for (const entry of entries) {
      const pkg = audited.get(entry.id.toLowerCase());
      if (!pkg) {
        if (NEO_OWNED.test(entry.id)) problems.push(`${file} locks ${entry.id} ${entry.resolved}, which is not in ${PATHS.manifest}`);
      } else if (entry.resolved !== pkg.version) {
        problems.push(`${file} locks ${entry.id} ${entry.resolved}, audited ${pkg.version}`);
      } else if (entry.contentHash !== pkg.sha512) {
        problems.push(`${file} locks ${entry.id} ${entry.resolved} with content hash ${entry.contentHash}, audited ${pkg.sha512}`);
      }
    }
  }
  return problems;
}

/**
 * Extracts what NuGet reported when `dotnet restore` failed (run with DOTNET_CLI_UI_LANGUAGE=en):
 * a lock file that no longer matches the project (NU1004), a package whose bytes differ from the
 * lock (NU1403), a package that could not be found (NU1101, NU1102, NU1103) or a source that could
 * not be reached (NU1301).
 */
export function restoreFailures(restoreOutput) {
  const causes = {
    NU1004: "the restore graph no longer matches packages.lock.json (locked mode refuses to update it)",
    NU1403: "a package's bytes differ from the content hash in packages.lock.json",
    NU1101: "a package does not exist on the package source",
    NU1102: "a pinned package version does not exist on the package source",
    NU1103: "only a pre-release of a package exists on the package source",
    NU1301: "the package source could not be reached",
  };
  const found = new Map();
  for (const line of restoreOutput.split("\n")) {
    const match = /error (NU1004|NU1403|NU1101|NU1102|NU1103|NU1301)\b:?\s*(.*)$/.exec(line);
    if (!match) continue;
    const message = match[2].replace(/\s*\[[^\]]*\.csproj\]\s*$/, "").trim();
    if (message.length === 0) continue;
    found.set(`${match[1]} ${message}`, { code: match[1], cause: causes[match[1]], message });
  }
  return [...found.values()];
}

/** Compares the libraries NuGet restored against the audited manifest. */
export function restoredPackageProblems(libraries, manifest) {
  const keys = Object.keys(libraries);
  const problems = [];
  for (const pkg of manifest.packages) {
    const wanted = `${pkg.id}/${pkg.version}`.toLowerCase();
    const key = keys.find((candidate) => candidate.toLowerCase() === wanted);
    const restored = key ? libraries[key] : undefined;
    if (!restored) {
      const other = keys.filter((candidate) => candidate.toLowerCase().startsWith(`${pkg.id.toLowerCase()}/`));
      problems.push(
        other.length > 0
          ? `${pkg.id} restored as ${other.join(", ")}, not the audited ${pkg.version}`
          : `${pkg.id} ${pkg.version} is not in the restore graph; the manifest is stale`,
      );
    } else if (restored.sha512 !== pkg.sha512) {
      problems.push(`${pkg.id} ${pkg.version} sha512 is ${restored.sha512}, audited ${pkg.sha512}`);
    }
  }
  const listed = new Set(manifest.packages.map((pkg) => pkg.id.toLowerCase()));
  for (const key of keys) {
    const id = key.slice(0, key.lastIndexOf("/"));
    if (libraries[key].type === "package" && NEO_OWNED.test(id) && !listed.has(id.toLowerCase())) {
      problems.push(`${key} was restored but is not in ${PATHS.manifest}`);
    }
  }
  return problems;
}

/**
 * Compares the installed compiler with the pinned one: the version it reports, the SHA-256 of the
 * package `dotnet tool install` kept, and the NuGet content hash recorded for that install.
 */
export function compilerProblems({ versionOutput, nupkgSha256, contentHash }, compiler) {
  const problems = [];
  const version = versionOutput.trim().split("+")[0];
  if (version !== compiler.version) {
    problems.push(`${compiler.tool} reports version ${version || "(nothing)"}, pinned ${compiler.version}`);
  }
  if (nupkgSha256 === null) {
    problems.push(`the installed ${compiler.id} package could not be read, so the compiler bytes are unverified`);
  } else if (nupkgSha256 !== compiler.sha256) {
    problems.push(`the installed ${compiler.id} package has sha256 ${nupkgSha256}, audited ${compiler.sha256}`);
  }
  if (contentHash === null) {
    problems.push(`the NuGet content hash of the installed ${compiler.id} package could not be read`);
  } else if (contentHash !== compiler.sha512) {
    problems.push(`the installed ${compiler.id} package has content hash ${contentHash}, audited ${compiler.sha512}`);
  }
  return problems;
}

/** One line per pinned package, for messages that must name what the build is pinned to. */
export function pinnedSummary(manifest) {
  const lines = manifest.packages.map((pkg) => `     - ${pkg.id} ${pkg.version}`);
  if (manifest.compiler) lines.push(`     - ${manifest.compiler.id} ${manifest.compiler.version} (${manifest.compiler.tool})`);
  return lines.join("\n");
}

export function failureMessage(manifest, headline, details) {
  return [
    `${headline}`,
    "",
    ...details.map((detail) => `  - ${detail}`),
    "",
    "This build is pinned to (framework " + manifest.frameworkVersion + ", every package from nuget.org):",
    pinnedSummary(manifest),
    "",
    `The pins live in ${PATHS.props}, ${PATHS.manifest} and the packages.lock.json next to each project.`,
    `To change one deliberately, follow \"How to bump\" in ${PATHS.doc}; do not silence this gate.`,
  ].join("\n");
}

function readAssetsLibraries(relativePath) {
  const file = path.join(repoRoot, relativePath);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")).libraries ?? {};
}

function report(title, message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    const encoded = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::error title=${title}::${encoded}`);
  }
  console.error(`${title}\n\n${message}`);
}

function readLock(file) {
  const absolute = path.join(repoRoot, file);
  return fs.existsSync(absolute) ? JSON.parse(fs.readFileSync(absolute, "utf8")) : null;
}

function checkPackages(manifest, { includeNative = false } = {}) {
  const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  const propsVersion = readPinnedVersion(read(PATHS.props), PATHS.props);
  const testsVersion = readOptionalPinnedVersion(read(PATHS.testsProject), PATHS.testsProject);

  const drift = pinConsistencyProblems({ propsVersion, testsVersion, manifest });
  if (!fs.existsSync(path.join(repoRoot, PATHS.nugetConfig))) drift.push(`${PATHS.nugetConfig} is missing, so nuget.org is not the pinned only source`);
  if (drift.length > 0) {
    report("Neo platform package pins disagree", failureMessage(manifest, "The pins are inconsistent:", drift));
    return 1;
  }

  const projects = listProjects(repoRoot, { includeNative });
  const locks = projects.map((project) => {
    const file = lockFileFor(project, projects);
    return { project, file, lock: readLock(file) };
  });
  const lockProblems = lockFileProblems(locks, manifest);
  if (lockProblems.length > 0) {
    report("Neo package lock files differ from the audited bytes", failureMessage(manifest, "The lock files are inconsistent with the audit:", lockProblems));
    return 1;
  }

  const restore = spawnSync("dotnet", ["restore", PATHS.testsProject, "-nologo"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: "en" },
  });
  if (restore.error) {
    report("dotnet is not available", `Could not run dotnet restore: ${restore.error.message}`);
    return 1;
  }
  const output = `${restore.stdout ?? ""}${restore.stderr ?? ""}`;
  if (restore.status !== 0) {
    const failures = restoreFailures(output);
    if (failures.length > 0) {
      report(
        "Pinned Neo packages did not restore in locked mode",
        failureMessage(manifest, "dotnet restore failed:", failures.map((f) => `${f.code}: ${f.cause}${f.message ? ` (${f.message})` : ""}`)),
      );
    } else {
      report("dotnet restore failed", output.trim().split("\n").slice(-40).join("\n"));
    }
    return 1;
  }

  if (!fs.existsSync(path.join(repoRoot, PATHS.testsAssets))) {
    report("dotnet restore produced no assets file", `${PATHS.testsAssets} is missing after a successful restore.`);
    return 1;
  }
  const libraries = { ...readAssetsLibraries(PATHS.coreAssets), ...readAssetsLibraries(PATHS.testsAssets) };
  const problems = restoredPackageProblems(libraries, manifest);
  if (problems.length > 0) {
    report("Neo platform packages differ from the audited bytes", failureMessage(manifest, "Restore produced packages that do not match the audit:", problems));
    return 1;
  }

  console.log(
    `Neo platform packages OK: ${manifest.packages.length} pinned Neo packages for framework ${propsVersion} restored in locked mode with the audited sha512; ${projects.length} lock files agree with the audit.`,
  );
  return 0;
}

/** Resolves nccs and the runtime root the same way every build script does. */
function resolveCompiler() {
  const resolved = spawnSync(
    "bash",
    ["-c", 'source scripts/dotnet_env.sh >/dev/null 2>&1 || exit 1; printf "%s\\n%s\\n" "$NCCS_BIN" "$DOTNET_ROOT"'],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (resolved.status !== 0) return null;
  const [nccs, dotnetRoot] = resolved.stdout.trim().split("\n");
  return nccs && dotnetRoot ? { nccs, dotnetRoot } : null;
}

function checkCompiler(manifest) {
  const compiler = manifest.compiler;
  const install = `dotnet tool install -g ${compiler.id.toLowerCase()} --version ${compiler.version}`;
  const resolved = resolveCompiler();
  if (!resolved) {
    report(
      "The pinned Neo compiler is not installed",
      failureMessage(manifest, `${compiler.tool} was not found; install it with:`, [install]),
    );
    return 1;
  }
  const run = spawnSync(resolved.nccs, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, DOTNET_ROOT: resolved.dotnetRoot },
  });
  const versionOutput = run.status === 0 ? (run.stdout ?? "") : "";
  // `dotnet tool install` keeps the package it installed next to the tool, with the content hash
  // NuGet computed for it. The .nupkg.sha512 file beside them is not the hash of either, so the
  // package is hashed here instead.
  const stored = path.join(
    path.dirname(resolved.nccs), ".store", compiler.id.toLowerCase(), compiler.version, compiler.id.toLowerCase(), compiler.version,
  );
  const metadata = path.join(stored, ".nupkg.metadata");
  const packages = fs.existsSync(stored) ? fs.readdirSync(stored).filter((name) => /\.nupkg$/i.test(name)) : [];
  // Every copy of the package the install left must be the audited one; none at all is unverified.
  const sha256s = packages.map((name) => createHash("sha256").update(fs.readFileSync(path.join(stored, name))).digest("hex"));
  const nupkgSha256 = sha256s.length === 0 ? null : (sha256s.find((digest) => digest !== compiler.sha256) ?? compiler.sha256);
  const contentHash = fs.existsSync(metadata) ? (JSON.parse(fs.readFileSync(metadata, "utf8")).contentHash ?? null) : null;
  const problems = compilerProblems({ versionOutput, nupkgSha256, contentHash }, compiler);
  if (problems.length > 0) {
    report(
      "The installed Neo compiler is not the pinned one",
      failureMessage(manifest, `Compiler check failed (the NEF header and code generation depend on it); reinstall with \`${install}\`:`, problems),
    );
    return 1;
  }
  console.log(`Neo compiler OK: ${compiler.tool} ${versionOutput.trim()} is the pinned ${compiler.id} ${compiler.version} package (audited bytes).`);
  return 0;
}

function main(argv) {
  const manifest = parseManifest(fs.readFileSync(path.join(repoRoot, PATHS.manifest), "utf8"));
  return argv.includes("--compiler-only") ? checkCompiler(manifest) : checkPackages(manifest, { includeNative: argv.includes("--include-native") });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
