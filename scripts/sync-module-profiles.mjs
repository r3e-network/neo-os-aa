#!/usr/bin/env node
/**
 * Sync the canonical module capability profile (docs/SA-MODULE-PROTOCOL.md §12)
 * into every plugin contract.
 *
 * Source of truth: `<Module>.profile.json` next to `<Module>.cs` under
 * contracts/plugins/{validators,hooks,recovery}. The core hashes the exact bytes
 * returned by `getModuleProfile()` and compares them with the profile digest
 * recorded at install, so the string embedded in the contract must be the
 * canonical encoding: UTF-8, keys sorted, no whitespace, no trailing newline.
 *
 * Usage:
 *   node scripts/sync-module-profiles.mjs          rewrite contracts + profiles
 *   node scripts/sync-module-profiles.mjs --check  fail when anything is stale
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIRS = [
  "contracts/plugins/validators",
  "contracts/plugins/hooks",
  "contracts/plugins/recovery",
];

const CHECK = process.argv.includes("--check");
const LIFECYCLE = ["onInstall", "onUninstall", "configure"];
const CAPABILITY_KEYS = ["compositeLayer", "instanceIsolation", "messageCapability", "thresholdMemberEligible"];
const TOP_KEYS = ["profileVersion", "moduleType", "contractName", "capabilities", "lifecycle", "callbacks"];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  assert(typeof value === "string" || typeof value === "boolean" || Number.isInteger(value),
    `Unsupported JSON value in profile: ${JSON.stringify(value)}`);
  return JSON.stringify(value);
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function validateProfile(name, profile) {
  assert(profile !== null && typeof profile === "object" && !Array.isArray(profile), `${name}: profile must be an object`);
  assert(sameMembers(Object.keys(profile), TOP_KEYS), `${name}: unexpected top-level keys ${Object.keys(profile).join(",")}`);
  assert(profile.profileVersion === 1, `${name}: profileVersion must be 1`);
  assert(profile.moduleType === "validator" || profile.moduleType === "hook", `${name}: invalid moduleType`);
  assert(profile.contractName === name, `${name}: contractName must equal the file name`);
  assert(Array.isArray(profile.lifecycle) && sameMembers(profile.lifecycle, LIFECYCLE)
    && profile.lifecycle.length === LIFECYCLE.length, `${name}: lifecycle must be [onInstall,onUninstall,configure]`);

  const capabilities = profile.capabilities;
  assert(capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities),
    `${name}: capabilities must be an object`);
  assert(sameMembers(Object.keys(capabilities), CAPABILITY_KEYS),
    `${name}: capabilities must declare exactly ${CAPABILITY_KEYS.join(",")}`);
  for (const key of ["instanceIsolation", "messageCapability", "thresholdMemberEligible"]) {
    assert(typeof capabilities[key] === "boolean", `${name}: capabilities.${key} must be a boolean`);
  }
  assert(Number.isInteger(capabilities.compositeLayer)
    && capabilities.compositeLayer >= 0 && capabilities.compositeLayer <= 1,
    `${name}: capabilities.compositeLayer must be 0 or 1`);

  const callbacks = profile.callbacks;
  assert(Array.isArray(callbacks) && callbacks.length > 0, `${name}: callbacks must be a nonempty array`);
  if (profile.moduleType === "hook") {
    assert(!capabilities.messageCapability && !capabilities.thresholdMemberEligible,
      `${name}: hooks may not claim message or threshold capabilities`);
    assert(sameMembers(callbacks, ["preCheck", "postCheck"]) && callbacks.length === 2,
      `${name}: hook callbacks must be [preCheck,postCheck]`);
  } else {
    const required = ["validateUserOp", "onUserOpComplete"];
    if (capabilities.messageCapability) required.push("isValidSignature");
    assert(sameMembers(callbacks, required) && callbacks.length === required.length,
      `${name}: validator callbacks must be [${required.join(",")}]`);
  }
}

function requiredMethods(profile) {
  const methods = ["getModuleProfile", "onInstall", "onUninstall", "configure"];
  if (profile.moduleType === "hook") {
    methods.push("preCheck", "postCheck");
  } else {
    methods.push("validateUserOp", "onUserOpComplete");
    if (profile.capabilities.messageCapability) methods.push("isValidSignature");
  }
  return methods;
}

/** nccs emits the C# method name with a lower-cased first character. */
function manifestName(csharpName) {
  return csharpName.charAt(0).toLowerCase() + csharpName.slice(1);
}

function assertSourceSurface(name, source, profile) {
  const declared = new Set();
  const methodPattern = /public\s+static\s+[A-Za-z_][A-Za-z0-9_<>\[\],.? ]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;
  while ((match = methodPattern.exec(source)) !== null) declared.add(manifestName(match[1]));
  for (const method of requiredMethods(profile)) {
    assert(declared.has(method), `${name}: contract does not declare ${method}()`);
  }
}

function pluginFiles() {
  const found = [];
  for (const dir of PLUGIN_DIRS) {
    const absolute = join(ROOT, dir);
    for (const entry of readdirSync(absolute)) {
      if (!entry.endsWith(".profile.json")) continue;
      const profilePath = join(absolute, entry);
      if (!statSync(profilePath).isFile()) continue;
      const name = basename(entry, ".profile.json");
      found.push({ name, dir: absolute, profilePath, contractPath: join(absolute, `${name}.cs`) });
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

const PROFILE_LITERAL = /private const string ModuleProfileJson = "((?:[^"\\]|\\.)*)";/;

function main() {
  const stale = [];
  const errors = [];
  const modules = pluginFiles();
  assert(modules.length > 0, "No module profiles found");

  for (const module of modules) {
    const { name, profilePath, contractPath } = module;
    try {
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      validateProfile(name, profile);
      const canonical = canonicalJson(profile);

      let source;
      try {
        source = readFileSync(contractPath, "utf8");
      } catch {
        fail(`${name}: missing contract source ${contractPath}`);
      }
      assertSourceSurface(name, source, profile);

      const literal = PROFILE_LITERAL.exec(source);
      assert(literal !== null, `${name}: ModuleProfileJson constant missing`);
      const expectedLiteral = canonical.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

      const profileBytes = readFileSync(profilePath, "utf8");
      const profileCanonical = profileBytes === canonical;
      const contractCanonical = literal[1] === expectedLiteral;

      if (!profileCanonical || !contractCanonical) {
        stale.push(name);
        if (!CHECK) {
          if (!profileCanonical) writeFileSync(profilePath, canonical, "utf8");
          if (!contractCanonical) {
            writeFileSync(contractPath, source.replace(PROFILE_LITERAL,
              `private const string ModuleProfileJson = "${expectedLiteral}";`), "utf8");
          }
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const message of errors) console.error(`ERROR ${message}`);
  for (const name of stale) {
    if (CHECK) console.error(`STALE ${name}`);
    else console.log(`UPDATED ${name}`);
  }
  if (errors.length === 0 && stale.length === 0) console.log(`OK ${modules.length} module profiles canonical`);
  if (errors.length > 0 || (CHECK && stale.length > 0)) process.exit(1);
}

main();
