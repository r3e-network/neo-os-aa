import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const script = require("./upgrade_mainnet_unified_smart_wallet.js");
const { stackHash160, loadArtifact, neon } = require("./lib/deploy-helpers.js");

test("decodes NeoVM Hash160 stack bytes in canonical script-hash order", () => {
  const canonical = "6d0656f6dd91469db1c90cc1e574380613f43738";
  const littleEndian = Buffer.from(canonical, "hex").reverse().toString("base64");
  assert.equal(
    stackHash160({ type: "ByteArray", value: littleEndian }),
    `0x${canonical}`,
  );
  assert.equal(neon.wallet.getAddressFromScriptHash(canonical), "NR3E4D8NUXh3zhbf5ZkAp3rTxWbQqNih32");
  assert.throws(
    () => stackHash160({ type: "ByteArray", value: Buffer.alloc(19).toString("base64") }),
    /Hash160 stack item/,
  );
});

test("candidate comparison decodes SDK hex into the same bytes as RPC base64", () => {
  const { nef } = loadArtifact("UnifiedSmartWalletV3");
  const artifact = script.candidateArtifact();
  const rpcScript = Buffer.from(nef.script, "hex").toString("base64");
  assert.deepEqual(artifact.script, Buffer.from(rpcScript, "base64"));
  assert.equal(artifact.script.length * 2, nef.script.length);
});

test("mainnet candidate removes the instant admin transfer surface", () => {
  const artifact = script.candidateArtifact();
  assert.equal(script.REMOVED_METHODS.includes("transferAdmin"), true);
  assert.equal(artifact.methodCount > 0, true);
  assert.equal(artifact.methodCount, 89);
});

test("mainnet candidate contains the governed upgrade surface", () => {
  const artifact = script.candidateArtifact();
  const manifest = JSON.parse(artifact.manifestText);
  const methods = new Set((manifest.abi?.methods || []).map((method) => method.name));
  for (const method of script.REQUIRED_METHODS) assert.equal(methods.has(method), true, method);
  for (const method of script.REMOVED_METHODS) assert.equal(methods.has(method), false, method);
});

test("mainnet candidate preserves every live method except the explicit removal", () => {
  const artifact = script.candidateArtifact();
  const liveMethods = new Set([
    "update",
    "getContractAdmin",
    "transferAdmin",
    "executeUserOp",
    "getNonce",
  ]);
  assert.equal(script.assertCandidatePreservesLiveSurface(liveMethods, artifact.methodNames), true);
  assert.throws(
    () => script.assertCandidatePreservesLiveSurface(new Set(["update", "legacyMethod"]), artifact.methodNames),
    /unapproved live methods: legacyMethod/,
  );
});

test("mainnet execution requires an explicit confirmation and environment WIF", () => {
  const source = fs.readFileSync(new URL("./upgrade_mainnet_unified_smart_wallet.js", import.meta.url), "utf8");
  assert.match(source, /--execute/);
  assert.match(source, /CONFIRM_AA_MAINNET_UPDATE/);
  assert.match(source, /AA_MAINNET_UPDATE_WIF/);
  assert.doesNotMatch(source, /Kx2Bey|L[1-9A-HJ-NP-Za-km-z]{50,}/);
});
