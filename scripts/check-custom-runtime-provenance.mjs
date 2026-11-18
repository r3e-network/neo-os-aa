#!/usr/bin/env node
// Read-only join for the eight-module public-runtime source acceptance suite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInputSnapshot } from './check-artifact-reproducibility.mjs';
import { parseNefScript, verifyReleaseCertificate } from './verify-private-artifact-provenance.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function validateSourceOracle(receipt, releaseRoot) {
  // Reuse the runner's scenario/check/transaction oracle, including its module roster.
  // No second count threshold can drift from the authoritative acceptance gate.
  const code = `import json,sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / 'scripts/localchain'))
import sa_rpc_scenarios as suite
import source_build
r=json.load(sys.stdin)
expected=json.loads((Path(sys.argv[1]) / 'tests/localchain/expected-source.json').read_text())
failures=suite.validate_source_receipt(r,expected)
if failures: raise ValueError('Source acceptance oracle failed: ' + '; '.join(failures))
p=source_build.profile_of(Path(sys.argv[2]) / 'SmartAccount.nef')
if p['profile'] != source_build.PROFILE_SYSCALL_ABSENT: raise ValueError('Custom build contains a private bounded syscall')
if r['source']['coreSha256'] != p['coreSha256']: raise ValueError('Source receipt core differs from release NEF')
print(json.dumps(list(source_build.REQUIRED_ARTIFACTS)))`;
  const result = spawnSync('python3', ['-c', code, root, releaseRoot], {
    input: JSON.stringify(receipt), encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Source oracle failed');
  return JSON.parse(result.stdout);
}

export function verifyCustomRuntimeProvenance({ repro, receipt, repoRoot = root, releaseRoot = path.join(repoRoot, 'contracts/bin/public') }) {
  assert.equal(repro.certificate?.schema, 'neoos-sa-source-to-artifact-certificate/v1', 'Missing source certificate');
  assert.equal(repro.certificate.source_root, 'repository');
  const sources = buildInputSnapshot(repoRoot);
  assert.deepEqual(sources, repro.certificate.source_files, 'Current source inputs differ from certificate');
  assert.equal(sha256(Buffer.from(JSON.stringify(sources))), repro.certificate.source_snapshot_sha256, 'Source snapshot digest differs');
  verifyReleaseCertificate(repro, releaseRoot);
  assert.equal(receipt.variant, 'source');
  assert.equal(receipt.profile, 'platform-syscall-absent', 'Only public-profile source receipts qualify');
  assert.deepEqual(receipt.gateFailures, [], 'Recorded source acceptance gate did not pass');
  const names = validateSourceOracle(receipt, releaseRoot).sort();
  const runtime = receipt.sourceArtifactRuntime;
  assert.equal(runtime?.schema, 'neoos-sa-custom-source-artifact-runtime/v1', 'Missing source runtime artifact evidence');
  assert.equal(runtime.publicNetwork, false);
  assert.deepEqual(Object.keys(receipt.contracts).sort(), names, 'Deployment roster differs');
  for (const field of ['artifacts', 'readback']) {
    assert.ok(Array.isArray(runtime[field]));
    assert.deepEqual(runtime[field].map((row) => row.contractName).sort(), names, `${field} roster differs`);
  }
  const rows = names.map((name) => {
    const artifact = runtime.artifacts.find((row) => row.contractName === name);
    const chain = runtime.readback.find((row) => row.contractName === name);
    assert.equal(artifact.relativeNefPath, `${name}.nef`);
    assert.equal(artifact.relativeManifestPath, `${name}.manifest.json`);
    const nef = fs.readFileSync(path.join(releaseRoot, artifact.relativeNefPath));
    const manifestBytes = fs.readFileSync(path.join(releaseRoot, artifact.relativeManifestPath));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.name, name, 'Manifest identity differs');
    const script = parseNefScript(nef), checksum = nef.readUInt32LE(nef.length - 4);
    assert.equal(artifact.nefSha256, sha256(nef));
    assert.equal(artifact.manifestSha256, sha256(manifestBytes));
    assert.equal(repro.certificate.release_artifact_sha256[`public/${name}.nef`], artifact.nefSha256);
    assert.equal(repro.certificate.release_artifact_sha256[`public/${name}.manifest.json`], artifact.manifestSha256);
    assert.equal(artifact.nefScriptSha256, sha256(script));
    assert.equal(artifact.nefChecksum, checksum);
    assert.deepEqual(canonical(artifact.manifest), canonical(manifest), 'Local receipt manifest differs');
    const manifestCanonicalSha256 = sha256(Buffer.from(JSON.stringify(canonical(manifest))));
    assert.equal(artifact.manifestCanonicalSha256, manifestCanonicalSha256);
    assert.equal(chain.contractHash, receipt.contracts[name]);
    assert.match(chain.contractHash, /^0x[0-9a-f]{40}$/);
    assert.equal(chain.nef?.script, script.toString('base64'), 'RPC script bytes differ');
    assert.equal(chain.nef?.checksum, checksum, 'RPC checksum differs');
    assert.equal(chain.nefScriptSha256, sha256(script));
    assert.equal(chain.nefChecksum, checksum);
    assert.deepEqual(canonical(chain.manifest), canonical(manifest), 'RPC manifest differs');
    assert.equal(chain.manifestCanonicalSha256, manifestCanonicalSha256);
    for (const key of ['nefScriptByteEquality', 'nefChecksumEquality', 'manifestSemanticEquality']) assert.equal(chain[key], true);
    return { contractName: name, contractHash: chain.contractHash, nefSha256: artifact.nefSha256,
      manifestSha256: artifact.manifestSha256, manifestCanonicalSha256, nefScriptSha256: artifact.nefScriptSha256, nefChecksum: checksum };
  });
  return { schema: 'neoos-sa-custom-runtime-provenance/v1', status: 'PASS', sourceSnapshotSha256: repro.certificate.source_snapshot_sha256,
    publicNetworkWritesPerformed: false, runtimeArtifactsChecked: rows.length, rows,
    measuredSubset: 'source_build.REQUIRED_ARTIFACTS', fullModuleProvenanceVerified: false,
    boundary: 'Public-runtime source acceptance for the eight deployed modules; no full-module, compiler refinement or public deployment claim.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(['--repro', '--receipt', '--release-root'].includes(args[i]) && args[i + 1], 'Usage: --repro FILE --receipt FILE [--release-root DIR]');
      assert.equal(options[args[i]], undefined, 'Duplicate option');
      options[args[i]] = args[i + 1];
    }
    assert.ok(options['--repro'] && options['--receipt'], 'Reproducibility and source receipts are required');
    const load = (name) => JSON.parse(fs.readFileSync(options[name], 'utf8'));
    console.log(JSON.stringify(verifyCustomRuntimeProvenance({ repro: load('--repro'), receipt: load('--receipt'),
      ...(options['--release-root'] ? { releaseRoot: path.resolve(options['--release-root']) } : {}) }), null, 2));
  } catch (error) { console.error(`Custom runtime provenance failed: ${error.message}`); process.exitCode = 1; }
}
