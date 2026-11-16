#!/usr/bin/env node

// Compiles the plugin templates under contracts/templates/ into a throwaway
// directory and asserts their manifests still satisfy the exact ABI the AA core
// requires at bind time (AssertV3Verifier / AssertV3Hook in
// contracts/SmartAccount.Accounts.cs). The templates are the documented starting
// point for third-party plugins; if the shared plugin layer
// (contracts/verifiers/Verifier*.cs, contracts/hooks/HookAuthority.cs) or the core
// binding gate ever drifts, this gate fails before a developer copies a broken
// skeleton.
//
// Usage: node scripts/check_plugin_templates.mjs
// Requires: the pinned nccs on PATH or NCCS_BIN (same toolchain as
// contracts/compile.sh), and NuGet access for the pinned framework package.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nccs = process.env.NCCS_BIN || path.join(os.homedir(), ".dotnet", "tools", "nccs");

// Mirror of the core's bind-time ABI gate: SmartAccount.Accounts.cs
// AssertV3Verifier / AssertV3Hook. Signature format: "ParamType,...->ReturnType";
// safe:true additionally requires the [Safe] (read-only) flag.
const CORE_BINDING_ABI = {
  verifier: [
    { name: "supportsV3", sig: "->Boolean", safe: true },
    { name: "validateSignature", sig: "Hash160,Any->Boolean" },
    { name: "postExecute", sig: "Hash160,Any,Any->Void" },
    { name: "clearAccount", sig: "Hash160->Void" },
  ],
  hook: [
    { name: "supportsV3", sig: "->Boolean", safe: true },
    { name: "preExecute", sig: "Hash160,Array->Void" },
    { name: "postExecute", sig: "Hash160,Array,Any->Void" },
    { name: "clearAccount", sig: "Hash160->Void" },
  ],
};

const TEMPLATES = [
  {
    kind: "verifier",
    project: path.join(rootDir, "contracts", "templates", "verifier", "VerifierTemplate.csproj"),
    manifest: "VerifierTemplate.manifest.json",
    // The template must ride on the shared plugin layer, not a private copy.
    source: path.join(rootDir, "contracts", "templates", "verifier", "VerifierTemplate.cs"),
    sharedLayer: ["VerifierAuthority.", "VerifierPayload.", "SignerDomain."],
  },
  {
    kind: "hook",
    project: path.join(rootDir, "contracts", "templates", "hook", "HookTemplate.csproj"),
    manifest: "HookTemplate.manifest.json",
    source: path.join(rootDir, "contracts", "templates", "hook", "HookTemplate.cs"),
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
  return methods.length;
}

function assertSharedLayer(template) {
  const source = fs.readFileSync(template.source, "utf8");
  for (const token of template.sharedLayer) {
    if (!source.includes(token)) {
      throw new Error(`${path.basename(template.source)}: no longer uses the shared plugin layer (${token}*) — the template must teach the shared authority/payload helpers, not a private copy`);
    }
  }
}

function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aa-plugin-templates-"));
  try {
    for (const template of TEMPLATES) {
      execFileSync(nccs, [template.project, "-o", scratch], { stdio: ["ignore", "pipe", "inherit"] });
      assertTemplateAbi(path.join(scratch, template.manifest), template.kind);
      assertSharedLayer(template);
      console.log(`[plugin templates] ${template.kind}: compiles, core-binding ABI intact, shared layer in use`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log("[plugin templates] PASS");
}

main();
