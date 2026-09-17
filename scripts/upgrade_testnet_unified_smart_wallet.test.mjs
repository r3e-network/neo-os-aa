import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const script = require("./upgrade_testnet_unified_smart_wallet.js");
const { loadArtifact, neon } = require("./lib/deploy-helpers.js");

test("testnet candidate decodes NEF hex text before comparing RPC bytes", () => {
  const { nef } = loadArtifact("UnifiedSmartWalletV3");
  assert.deepEqual(script.candidateArtifact().script, Buffer.from(nef.script, "hex"));
});

test("candidate artifact exposes the complete platform registrar surface", () => {
  const artifact = script.candidateArtifact();
  assert.equal(artifact.manifest.name, "UnifiedSmartWalletV3");
  assert.deepEqual(
    script.REQUIRED_METHODS.filter((method) => !artifact.methods.includes(method)),
    [],
  );
  assert.match(artifact.nefSha256, /^0x[0-9a-f]{64}$/);
  assert.match(artifact.manifestSha256, /^0x[0-9a-f]{64}$/);
});

test("signer parsing accepts a script hash and rejects arbitrary text", () => {
  assert.equal(
    script.normalizeSignerInput(`0x${"11".repeat(20)}`),
    `0x${"11".repeat(20)}`,
  );
  assert.throws(() => script.normalizeSignerInput("not-a-signer"), /Neo address or 20-byte script hash/);
});

test("update preview recognition is fail-closed", () => {
  assert.equal(script.isHalt({ state: "HALT" }), true);
  assert.equal(script.isHalt({ state: "FAULT", exception: "Not admin" }), false);
  assert.equal(script.isHalt({}), false);
});

test("the upgrade script has explicit broadcast gates and no embedded WIF", () => {
  const source = fs.readFileSync(new URL("./upgrade_testnet_unified_smart_wallet.js", import.meta.url), "utf8");
  assert.match(source, /--execute/);
  assert.match(source, /--confirm/);
  assert.match(source, /confirmUpdate/);
  assert.match(source, /CONFIRM_AA_TESTNET_UPDATE/);
  assert.match(source, /AA_TESTNET_UPDATE_WIF/);
  assert.doesNotMatch(source, /Kx2Bey|L[1-9A-HJ-NP-Za-km-z]{50,}/);
});

test("confirmation uses the candidate contract script for post-write provenance", () => {
  const source = fs.readFileSync(new URL("./upgrade_testnet_unified_smart_wallet.js", import.meta.url), "utf8");
  assert.match(source, /post-confirm deployed NEF script does not match/);
  assert.match(source, /deployed_script_matches_candidate: true/);
});

test("timelocked proposal pins the NEF and manifest digests", () => {
  const artifact = script.candidateArtifact();
  const params = script.proposeParams(artifact);
  assert.equal(params.length, 2);
  assert.equal(params[0].type, 21);
  assert.equal(params[1].type, 21);
  const invocation = neon.sc.createScript({
    scriptHash: script.DEFAULT_CORE_HASH.slice(2), operation: "proposeUpdate", args: params,
  });
  // Verify actual VM payload, not merely the SDK's display string.
  for (const digest of [artifact.nefSha256, artifact.manifestSha256]) {
    const rawHex = digest.slice(2);
    assert.ok(invocation.includes(`0c20${rawHex}`), "PUSHDATA1 must contain the raw 32-byte SHA-256 digest");
    assert.ok(!invocation.includes(Buffer.from(rawHex, "hex").reverse().toString("hex")), "must not pin a reversed digest");
  }
});
