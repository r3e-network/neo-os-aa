import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as provenance from "./verify-private-artifact-provenance.mjs";

import {
  LOCAL_ARTIFACTS,
  parseNefScript,
  selectLatestDatedReport,
  verifyProvenance,
} from "./verify-private-artifact-provenance.mjs";

function withChecksum(body) {
  const checksum = createHash("sha256")
    .update(createHash("sha256").update(body).digest())
    .digest()
    .subarray(0, 4);
  return Buffer.concat([body, checksum]);
}

function varBytes(bytes) {
  const length = bytes.length < 0xfd ? Buffer.from([bytes.length])
    : Buffer.from([0xfd, bytes.length & 0xff, bytes.length >> 8]);
  return Buffer.concat([length, bytes]);
}

function syntheticToken(method = Buffer.from("transfer"), hasReturn = 1, flags = 15) {
  return Buffer.concat([Buffer.alloc(20), varBytes(method), Buffer.from([3, 0, hasReturn, flags])]);
}

function syntheticNef(script, { source = Buffer.alloc(0), tokens = [] } = {}) {
  // NEF3: magic, compiler, source, reserved byte, method table, reserved
  // bytes, script length, script, and the little-endian checksum.
  const body = Buffer.concat([
    Buffer.from("NEF3"),
    Buffer.alloc(64),
    varBytes(source),
    Buffer.from([0, tokens.length]),
    ...tokens,
    Buffer.alloc(2),
    varBytes(script),
  ]);
  return withChecksum(body);
}

test("the provenance map covers the 24 repository artifacts", () => {
  assert.equal(Object.keys(LOCAL_ARTIFACTS).length, 24);
  assert.ok(LOCAL_ARTIFACTS.Web3AuthVerifier.endsWith("Web3AuthVerifier.nef"));
  assert.ok(LOCAL_ARTIFACTS.MultiHook.endsWith("MultiHook.nef"));
});

test("default report selection excludes stale and explicitly ineligible receipts", () => {
  const selected = selectLatestDatedReport([
    "aa-neoexpress-validation-20261004-final.json",
    "aa-neoexpress-validation-20261005-unmatched-runner.json",
    "aa-neoexpress-validation-20261005.json",
    "aa-neoexpress-validation-20261003.json",
  ], "aa-neoexpress-validation");
  assert.equal(selected, "aa-neoexpress-validation-20261005.json");
  assert.throws(
    () => selectLatestDatedReport(["aa-neoexpress-validation-20261005-unmatched-runner.json"], "aa-neoexpress-validation"),
    /no dated aa-neoexpress-validation report found/,
  );
});

test("NEF3 parser returns the script and validates its checksum", () => {
  const nef = syntheticNef(Buffer.from([0x11, 0x40]));
  assert.deepEqual(parseNefScript(nef), Buffer.from([0x11, 0x40]));

  const corrupted = Buffer.from(nef);
  corrupted[corrupted.length - 1] ^= 0xff;
  assert.throws(() => parseNefScript(corrupted), /checksum mismatch/);
});

test("NEF3 parser fails closed on a truncated script", () => {
  const nef = syntheticNef(Buffer.from([0x11, 0x40]));
  assert.throws(() => parseNefScript(nef.subarray(0, nef.length - 5)), /truncated|checksum/);
});

test("NEF3 parser supports canonical long script lengths and method tokens", () => {
  const script = Buffer.alloc(256, 0x40);
  assert.deepEqual(parseNefScript(syntheticNef(script, {
    source: Buffer.alloc(256, 0x61), tokens: [syntheticToken()],
  })), script);
});

test("NEF3 parser compares magic bytes without ASCII high-bit masking", () => {
  const body = syntheticNef(Buffer.from([0x40])).subarray(0, -4);
  for (let index = 0; index < 4; index++) body[index] |= 0x80;
  assert.throws(() => parseNefScript(withChecksum(body)), /NEF3/);
});

for (const offset of [69, 71, 72]) {
  test(`NEF3 parser rejects nonzero reserved byte ${offset} with a valid checksum`, () => {
    const body = syntheticNef(Buffer.from([0x40])).subarray(0, -4);
    body[offset] = 1;
    assert.throws(() => parseNefScript(withChecksum(body)), /reserved/);
  });
}

test("NEF3 parser rejects bytes between the script and a recomputed checksum", () => {
  const body = syntheticNef(Buffer.from([0x40])).subarray(0, -4);
  assert.throws(() => parseNefScript(withChecksum(Buffer.concat([body, Buffer.from([0x40])]))), /trailing|framing/);
});

test("NEF3 parser rejects an empty script even with a valid checksum", () => {
  assert.throws(() => parseNefScript(syntheticNef(Buffer.alloc(0))), /empty/);
});

test("NEF3 parser bounds every field before the checksum", () => {
  const body = syntheticNef(Buffer.from([0x40]), { tokens: [syntheticToken()] }).subarray(0, -4);
  for (let length = 4; length < body.length; length++) {
    assert.throws(() => parseNefScript(withChecksum(body.subarray(0, length))), /truncated|NEF/, `length ${length}`);
  }
});

test("NEF3 parser rejects noncanonical and oversized length prefixes", () => {
  const body = syntheticNef(Buffer.from([0x40])).subarray(0, -4);
  for (const prefix of [[0xfd, 1, 0], [0xfe, 1, 0, 0, 0], [0xff, 1, 0, 0, 0, 0, 0, 0, 0],
    [0xff, 255, 255, 255, 255, 255, 255, 255, 255]]) {
    const malformed = Buffer.concat([body.subarray(0, 73), Buffer.from(prefix), Buffer.from([0x40])]);
    assert.throws(() => parseNefScript(withChecksum(malformed)), /length|canonical|truncated/);
  }
});

for (const [name, options, expected] of [
  ["oversized source", { source: Buffer.alloc(257, 0x61) }, /length/],
  ["invalid source UTF-8", { source: Buffer.from([0xff]) }, /UTF-8/],
  ["too many tokens", { tokens: Array.from({ length: 129 }, () => syntheticToken()) }, /length/],
  ["oversized method", { tokens: [syntheticToken(Buffer.alloc(33, 0x61))] }, /length/],
  ["invalid method UTF-8", { tokens: [syntheticToken(Buffer.from([0xff]))] }, /UTF-8/],
  ["private method", { tokens: [syntheticToken(Buffer.from("_initialize"))] }, /method/],
  ["noncanonical boolean", { tokens: [syntheticToken(Buffer.from("m"), 2)] }, /boolean/],
  ["invalid call flags", { tokens: [syntheticToken(Buffer.from("m"), 1, 16)] }, /flags/],
]) {
  test(`NEF3 parser rejects ${name} with a valid checksum`, () => {
    assert.throws(() => parseNefScript(syntheticNef(Buffer.from([0x40]), options)), expected);
  });
}

test("NEF3 parser rejects invalid compiler UTF-8 and nonzero padding", () => {
  for (const offset of [4, 5]) {
    const body = syntheticNef(Buffer.from([0x40])).subarray(0, -4);
    body[offset] = 0xff;
    assert.throws(() => parseNefScript(withChecksum(body)), /compiler|UTF-8/);
  }
});

test("provenance join rejects a stale source certificate before deployment checks", () => {
  const repro = {
    release_matches_fresh_build: true,
    certificate: {
      schema: "neoos-aa-source-to-artifact-certificate/v1",
      source_snapshot_sha256: "0".repeat(64),
      source_files: {},
    },
  };
  assert.throws(
    () => verifyProvenance({ repro, receipt: {} }),
    /current contract source inputs differ from the reproducibility certificate/,
  );
});

function certificateFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-certificate-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { "Core.nef": "nef", "Core.manifest.json": "{}" };
  const hashes = {};
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), contents);
    hashes[name] = createHash("sha256").update(contents).digest("hex");
  }
  return { root, repro: {
    release_matches_fresh_build: true,
    artifacts_compared: 2, drifted: [], missing: [],
    certificate: {
      byte_equal_release: true,
      fresh_artifact_sha256: { ...hashes },
      release_artifact_sha256: { ...hashes },
    },
  } };
}

test("release certificate compares every fresh/release NEF and manifest to disk", (t) => {
  const { root, repro } = certificateFixture(t);
  assert.equal(provenance.verifyReleaseCertificate(repro, root), 2);
});

for (const [name, mutate] of Object.entries({
  "false certificate verdict": (r) => { r.certificate.byte_equal_release = false; },
  "contradictory drift list": (r) => { r.drifted = ["Core.nef"]; },
  "contradictory missing list": (r) => { r.missing = ["Core.nef"]; },
  "wrong artifact count": (r) => { r.artifacts_compared = 1; },
  "missing fresh manifest": (r) => { delete r.certificate.fresh_artifact_sha256["Core.manifest.json"]; },
  "missing release manifest": (r) => { delete r.certificate.release_artifact_sha256["Core.manifest.json"]; },
  "different fresh bytes": (r) => { r.certificate.fresh_artifact_sha256["Core.nef"] = "0".repeat(64); },
  "matching maps but different disk bytes": (r) => {
    r.certificate.fresh_artifact_sha256["Core.manifest.json"] = "0".repeat(64);
    r.certificate.release_artifact_sha256["Core.manifest.json"] = "0".repeat(64);
  },
  "additional release output": (r, root) => { fs.writeFileSync(path.join(root, "Extra.nef"), "extra"); },
  "deleted local output": (r, root) => { fs.unlinkSync(path.join(root, "Core.nef")); },
})) {
  test(`release certificate rejects ${name}`, (t) => {
    const { root, repro } = certificateFixture(t);
    mutate(repro, root);
    assert.throws(() => provenance.verifyReleaseCertificate(repro, root), /rebuild certificate/);
  });
}
