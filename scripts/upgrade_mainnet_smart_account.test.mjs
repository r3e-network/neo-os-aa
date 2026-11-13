import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const script = require("./upgrade_mainnet_smart_account.js");
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
  const { nef } = loadArtifact("SmartAccountV3");
  const artifact = script.candidateArtifact();
  const rpcScript = Buffer.from(nef.script, "hex").toString("base64");
  assert.deepEqual(artifact.script, Buffer.from(rpcScript, "base64"));
  assert.equal(artifact.script.length * 2, nef.script.length);
});

test("mainnet candidate removes the instant admin transfer surface", () => {
  const artifact = script.candidateArtifact();
  assert.equal(script.REMOVED_METHODS.includes("transferAdmin"), true);
  assert.equal(artifact.methodCount > 0, true);
  // The ordinary source candidate remains release-gated until deployment
  // review publishes a new manifest and updates the digest pin. Phase 1b
  // extracted the platform services, so the candidate now also carries the
  // market/registrar delegation surface (finalizeEscape is overloaded, so the
  // raw entry count is one above the unique method-name count).
  assert.equal(artifact.methodCount, 108);
  const manifest = JSON.parse(artifact.manifestText);
  for (const name of ['callVerifierChild', 'callHookChild']) {
    const childConfiguration = manifest.abi.methods.find((method) => method.name === name);
    assert.equal(childConfiguration.safe, false);
    assert.deepEqual(childConfiguration.parameters.map((parameter) => parameter.type),
      ['Hash160', 'Hash160', 'String', 'Array']);
  }
  for (const [name, arity] of Object.entries({
    setVerifierDependencies: 2,
    clearVerifierDependencies: 1,
    setHookDependencies: 2,
    clearHookDependencies: 1,
  })) {
    const method = manifest.abi.methods.find((candidate) => candidate.name === name);
    assert.equal(method.safe, false);
    assert.equal(method.parameters.length, arity);
    assert.equal(method.parameters[0].type, 'Hash160');
  }
  for (const [name, safe, returntype] of [
    ['finalizeEscapeToOwner', false, 'Void'], ['isOwnerOnlyRecovery', true, 'Boolean'],
  ]) {
    const method = manifest.abi.methods.find((entry) => entry.name === name);
    assert.equal(method.safe, safe);
    assert.equal(method.returntype, returntype);
    assert.deepEqual(method.parameters.map((parameter) => parameter.type), ['Hash160']);
  }
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
  const source = fs.readFileSync(new URL("./upgrade_mainnet_smart_account.js", import.meta.url), "utf8");
  assert.match(source, /--execute/);
  assert.match(source, /CONFIRM_AA_MAINNET_UPDATE/);
  assert.match(source, /AA_MAINNET_UPDATE_WIF/);
  assert.doesNotMatch(source, /Kx2Bey|L[1-9A-HJ-NP-Za-km-z]{50,}/);
});
