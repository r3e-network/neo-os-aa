#!/usr/bin/env node

// Compiles the plugin templates under contracts/plugins/templates/ into a throwaway
// directory and asserts their manifests satisfy the exact protocol v4 ABI the SA core
// requires at bind time (SmartAccount.Modules.cs: AssertModuleCallbackAbi) and that
// their canonical capability profile (spec §12) is self-consistent.
//
// The templates are the documented starting point for third-party plugins; if the
// shared plugin layer (contracts/plugins/validators/Validator*.cs,
// contracts/plugins/hooks/HookAuthority.cs) or the core binding gate ever drifts, this
// gate fails before a developer copies a broken skeleton.
//
// Usage: node scripts/check_plugin_templates.mjs
// Requires: the pinned nccs on PATH or NCCS_BIN (same toolchain as
// contracts/compile.sh), and NuGet access for the pinned framework package.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nccs = process.env.NCCS_BIN || path.join(os.homedir(), ".dotnet", "tools", "nccs");

// Mirror of the core's bind-time ABI gate: SmartAccount.Modules.cs
// AssertModuleCallbackAbi. Signature format: "ParamType,...->ReturnType";
// safe:true additionally requires the [Safe] (read-only) flag.
const CORE_BINDING_ABI = {
  validator: [
    { name: "getModuleProfile", sig: "->String", safe: true },
    { name: "onInstall", sig: "Hash160,Integer,Integer,Array->Void" },
    { name: "onUninstall", sig: "Hash160,Integer,Integer,Array->Void" },
    { name: "configure", sig: "Hash160,Integer,Integer,Array->Void" },
    { name: "validateUserOp", sig: "Hash160,ByteArray,Array->Boolean", safe: true },
    { name: "onUserOpComplete", sig: "Hash160,Array,Any->Void" },
  ],
  hook: [
    { name: "getModuleProfile", sig: "->String", safe: true },
    { name: "onInstall", sig: "Hash160,Integer,Integer,Array->Void" },
    { name: "onUninstall", sig: "Hash160,Integer,Integer,Array->Void" },
    { name: "configure", sig: "Hash160,Integer,Integer,Array->Void" },
    { name: "preCheck", sig: "Hash160,Array->ByteArray" },
    { name: "postCheck", sig: "Hash160,Array,Any,ByteArray->Void" },
  ],
};

const TEMPLATES = [
  {
    kind: "validator",
    contractName: "ValidatorTemplate",
    project: path.join(rootDir, "contracts", "plugins", "templates", "validator", "ValidatorTemplate.csproj"),
    manifest: "ValidatorTemplate.manifest.json",
    // The template must ride on the shared plugin layer, not a private copy.
    source: path.join(rootDir, "contracts", "plugins", "templates", "validator", "ValidatorTemplate.cs"),
    sharedLayer: ["ValidatorAuthority.", "ValidatorPayload.", "SignerDomain."],
  },
  {
    kind: "hook",
    contractName: "HookTemplate",
    project: path.join(rootDir, "contracts", "plugins", "templates", "hook", "HookTemplate.csproj"),
    manifest: "HookTemplate.manifest.json",
    source: path.join(rootDir, "contracts", "plugins", "templates", "hook", "HookTemplate.cs"),
    sharedLayer: ["HookAuthority."],
  },
];

function assertTemplateAbi(manifestPath, kind) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const methods = manifest?.abi?.methods;
  if (!Array.isArray(methods)) {
    throw new Error(`${manifestPath}: malformed manifest (no abi.methods)`);
  }
  for (const req of CORE_BINDING_ABI[kind]) {
    const found = methods.find((m) => m.name === req.name);
    if (!found) throw new Error(`${kind} template: missing core-binding method ${req.name}`);
    const sig = `${found.parameters.map((p) => p.type).join(",")}->${found.returntype}`;
    if (sig !== req.sig) {
      throw new Error(`${kind} template: ${req.name} signature drifted: got ${sig}, want ${req.sig}`);
    }
    if (req.safe && !found.safe) {
      throw new Error(`${kind} template: ${req.name} lost its [Safe] flag; the core requires a read-only marker`);
    }
  }
  return manifest;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSharedLayer(template) {
  const source = fs.readFileSync(template.source, "utf8");
  for (const token of template.sharedLayer) {
    if (!source.includes(token)) {
      throw new Error(`${path.basename(template.source)}: no longer uses the shared plugin layer (${token}*) — the template must teach the shared authority/payload helpers, not a private copy`);
    }
  }
}

// The profile literal is hashed into the install-time profile digest, so it must be
// canonical and must describe this exact module type and contract name (spec §12).
function assertProfile(template, manifest) {
  const source = fs.readFileSync(template.source, "utf8");
  const match = /private const string ModuleProfileJson =\s*"((?:[^"\\]|\\.)*)";/s.exec(source);
  if (!match) throw new Error(`${path.basename(template.source)}: ModuleProfileJson constant missing`);
  const literal = match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const profile = JSON.parse(literal);
  if (profile.profileVersion !== 1) throw new Error(`${template.contractName}: profileVersion must be 1`);
  if (profile.moduleType !== template.kind) {
    throw new Error(`${template.contractName}: profile moduleType ${profile.moduleType} does not match ${template.kind}`);
  }
  if (profile.contractName !== template.contractName || manifest.name !== template.contractName) {
    throw new Error(`${template.contractName}: profile/manifest contract name mismatch`);
  }
  if (literal !== canonicalJson(profile)) {
    throw new Error(`${template.contractName}: profile literal is not canonical JSON`);
  }
  if (profile.moduleType === "hook"
      && (profile.capabilities.messageCapability || profile.capabilities.thresholdMemberEligible)) {
    throw new Error(`${template.contractName}: hooks may not claim message or threshold capabilities`);
  }
  const digest = crypto.createHash("sha256").update(literal).digest("hex");
  console.log(`[plugin templates] ${template.contractName}: profile ${digest.slice(0, 16)}…`);
}

function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sa-plugin-templates-"));
  try {
    for (const template of TEMPLATES) {
      execFileSync(nccs, [template.project, "-o", scratch], { stdio: ["ignore", "pipe", "inherit"] });
      const manifest = assertTemplateAbi(path.join(scratch, template.manifest), template.kind);
      assertSharedLayer(template);
      assertProfile(template, manifest);
      console.log(`[plugin templates] ${template.kind}: compiles, v4 binding ABI intact, shared layer in use`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log("[plugin templates] PASS");
}

main();
