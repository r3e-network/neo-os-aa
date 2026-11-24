// A standard build must produce the exact governance code and ABI that can
// submit the protected native configuration actions.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: check_standard_governance_artifacts.mjs <module output directory>");
const profile = JSON.parse(readFileSync(new URL("../docs/proposals/smartaccount-native-profile-parameters.json", import.meta.url), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
for (const [name, field] of [["GovernanceModule", "governance"], ["RecoveryModule", "recovery"], ["MultiSigValidator", "member"]]) {
  const nef = readFileSync(join(dir, name + ".nef"));
  const manifest = readFileSync(join(dir, name + ".manifest.json"), "utf8").trim();
  if (sha256(nef) !== profile[field + "NefSha256"]) throw new Error(name + " NEF differs from the native profile");
  if (sha256(manifest) !== profile[field + "ManifestSha256"]) throw new Error(name + " manifest differs from the native profile");
}
console.log("Standard governance, recovery and threshold member artifacts match the native profile.");
