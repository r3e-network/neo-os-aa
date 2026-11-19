import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInputSnapshot, RESTORE_POLICY_FILES, RECIPE_SUPPORT_FILES } from './check-artifact-reproducibility.mjs';
import { verifyCustomRuntimeProvenance } from './check-custom-runtime-provenance.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const fixtureCode = `import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]) / 'tests/localchain'))
import test_source_gate as t
c=t.SourceReceiptGateTest();c.setUp()
print(json.dumps({'receipt':c.receipt(t.source_build.PROFILE_SYSCALL_ABSENT),'names':list(t.source_build.REQUIRED_ARTIFACTS)}))`;

function fixture(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-provenance-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const oracle = spawnSync('python3', ['-c', fixtureCode, root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(oracle.status, 0, oracle.stderr);
  const { receipt, names } = JSON.parse(oracle.stdout);
  const releaseRoot = path.join(repoRoot, 'contracts/bin/public');
  const write = (relative, bytes) => {
    const target = path.join(repoRoot, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  };
  // The fixture mirrors the recipe's own declared inputs, so growing the recipe
  // (a new build script, a new source root) cannot leave the harness behind.
  for (const file of [...RESTORE_POLICY_FILES, ...RECIPE_SUPPORT_FILES]) write(file, 'fixture source');
  write('contracts/Core.cs', 'fixture source');
  write('tests/mocks/MockContract.cs', 'fixture source');
  const body = Buffer.concat([Buffer.from('NEF3'), Buffer.alloc(64), Buffer.alloc(5), Buffer.from([1, 0x40])]);
  const nef = Buffer.concat([body, createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4)]);
  const checksum = nef.readUInt32LE(nef.length - 4);
  const artifacts = [], readback = [], hashes = {};
  for (const [index, name] of names.entries()) {
    const manifest = { name, abi: { methods: [], events: [] }, extra: { fixture: true } };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestCanonicalSha256 = sha256(Buffer.from(JSON.stringify(canonical(manifest))));
    write(`contracts/bin/public/${name}.nef`, nef); write(`contracts/bin/public/${name}.manifest.json`, manifestBytes);
    hashes[`public/${name}.nef`] = sha256(nef); hashes[`public/${name}.manifest.json`] = sha256(manifestBytes);
    receipt.contracts[name] ??= `0x${String(index).repeat(40)}`;
    artifacts.push({ contractName: name, relativeNefPath: `${name}.nef`, relativeManifestPath: `${name}.manifest.json`,
      nefSha256: sha256(nef), manifestSha256: sha256(manifestBytes), manifestCanonicalSha256, nefScriptSha256: sha256(Buffer.from([0x40])), nefChecksum: checksum, manifest });
    readback.push({ contractName: name, contractHash: receipt.contracts[name], nef: { script: 'QA==', checksum }, manifest,
      nefScriptSha256: sha256(Buffer.from([0x40])), nefChecksum: checksum, manifestCanonicalSha256,
      nefScriptByteEquality: true, nefChecksumEquality: true, manifestSemanticEquality: true });
  }
  for (const suffix of ['nef', 'manifest.json']) {
    const bytes = fs.readFileSync(path.join(releaseRoot, `SmartAccount.${suffix}`));
    write(`contracts/bin/platform/SmartAccount.${suffix}`, bytes);
    hashes[`platform/SmartAccount.${suffix}`] = sha256(bytes);
  }
  receipt.source.coreSha256 = sha256(nef);
  receipt.sourceArtifactRuntime = { ...receipt.sourceArtifactRuntime,
    schema: 'neoos-sa-custom-source-artifact-runtime/v1', publicNetwork: false, scope: '8 deployed artifacts only', artifacts, readback };
  receipt.gateFailures = [];
  const sources = buildInputSnapshot(repoRoot);
  const repro = { release_matches_fresh_build: true, drifted: [], missing: [], artifacts_compared: Object.keys(hashes).length,
    profiles: { public: { matches_fresh_build: true, required_core_present: true, artifacts_compared: names.length * 2 },
      platform: { matches_fresh_build: true, required_core_present: true, artifacts_compared: 2 } },
    certificate: { schema: 'neoos-sa-source-to-artifact-certificate/v1', source_root: 'repository', source_files: sources,
      source_snapshot_sha256: sha256(Buffer.from(JSON.stringify(sources))), byte_equal_release: true,
      fresh_artifact_sha256: { ...hashes }, release_artifact_sha256: { ...hashes } } };
  return { repro, receipt, repoRoot, releaseRoot };
}

test('joins rebuild, source inputs and exactly the source suite deployment/readback set', (t) => {
  const report = verifyCustomRuntimeProvenance(fixture(t));
  assert.equal(report.status, 'PASS'); assert.equal(report.runtimeArtifactsChecked, 8);
  assert.equal(report.fullModuleProvenanceVerified, false);
});

test('source changes, build drift, wrong profile and incomplete scenario evidence fail closed', (t) => {
  const changes = [
    (f) => fs.appendFileSync(path.join(f.repoRoot, 'contracts/Core.cs'), 'drift'),
    (f) => fs.appendFileSync(path.join(f.releaseRoot, 'SmartAccount.nef'), 'drift'),
    (f) => { f.receipt.profile = 'platform-syscall-present'; },
    (f) => { f.receipt.source.coreSha256 = 'a'.repeat(64); },
    (f) => { f.receipt.results.pop(); },
    (f) => { f.receipt.records[0].ok = false; },
    (f) => { f.repro.certificate.byte_equal_release = false; },
  ];
  for (const change of changes) { const f = fixture(t); change(f); assert.throws(() => verifyCustomRuntimeProvenance(f)); }
});

test('artifact and RPC mutations cannot hide behind producer equality flags', (t) => {
  const changes = [
    (r) => { r.sourceArtifactRuntime.artifacts.pop(); },
    (r) => { r.sourceArtifactRuntime.artifacts[0].manifestSha256 = 'a'.repeat(64); },
    (r) => { r.sourceArtifactRuntime.readback[0].nef.script = 'QQ=='; },
    (r) => { r.sourceArtifactRuntime.readback[0].nef.checksum++; },
    (r) => { r.sourceArtifactRuntime.readback[0].manifest.name = 'Other'; },
    (r) => { r.sourceArtifactRuntime.readback[0].contractHash = `0x${'a'.repeat(40)}`; },
    (r) => { r.sourceArtifactRuntime.publicNetwork = true; },
  ];
  for (const change of changes) { const f = fixture(t); change(f.receipt); assert.throws(() => verifyCustomRuntimeProvenance(f)); }
});
