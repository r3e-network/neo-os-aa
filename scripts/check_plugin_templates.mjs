#!/usr/bin/env node

// Compiles the plugin templates under contracts/plugins/templates/ into a throwaway
// directory and asserts their manifests satisfy the current module NEP the SA core
// requires at bind time and that
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nccs = process.env.NCCS_BIN || path.join(os.homedir(), ".dotnet", "tools", "nccs");

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
function checkCompiledProfile(template, scratch) {
  const source = fs.readFileSync(template.source, "utf8");
  const match = /private const string ModuleProfileJson =\s*("(?:[^"\\]|\\.)*");/s.exec(source);
  if (!match) throw new Error(`${template.contractName}: missing profile literal`);
  const raw = JSON.parse(match[1]);
  const profile = JSON.parse(raw);
  if (profile.moduleType !== template.kind || profile.contractName !== template.contractName) {
    throw new Error(`${template.contractName}: template identity differs from profile`);
  }
  const file = path.join(scratch, template.contractName + ".profile.json");
  fs.writeFileSync(file, raw);
  execFileSync("python3", [path.join(rootDir, "scripts/check_module_neps.py"),
    "--profile", file, "--manifest", path.join(scratch, template.manifest),
    "--nef", path.join(scratch, template.contractName + ".nef")], { stdio: "inherit" });
}

function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sa-plugin-templates-"));
  try {
    for (const template of TEMPLATES) {
      execFileSync(nccs, [template.project, "-o", scratch], { stdio: ["ignore", "pipe", "inherit"] });
      assertSharedLayer(template);
      checkCompiledProfile(template, scratch);
      console.log(`[plugin templates] ${template.kind}: compiled NEP interface and deployed profile verified, shared layer in use`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log("[plugin templates] PASS");
}

main();
