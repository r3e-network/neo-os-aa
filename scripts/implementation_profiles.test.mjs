import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// URL.pathname keeps the POSIX leading slash ("/D:/Git/..."); on Windows
// path.resolve then doubles the drive ("D:\D:\Git\..."). fileURLToPath is the
// portable conversion.
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readProfile(name) {
  const profilePath = path.join(repoRoot, 'implementations', name, 'profile.json');
  assert.ok(fs.existsSync(profilePath), `missing implementation profile: ${profilePath}`);
  return {
    path: profilePath,
    data: JSON.parse(fs.readFileSync(profilePath, 'utf8')),
  };
}

function assertLocalPaths(profile, field) {
  for (const relativePath of profile.data[field] ?? []) {
    assert.equal(typeof relativePath, 'string', `${field} entries must be strings`);
    assert.ok(!path.isAbsolute(relativePath), `${field} must use repository-relative paths: ${relativePath}`);
    const resolved = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(resolved), `${profile.path} points at a missing ${field} path: ${relativePath}`);
  }
}

test('ordinary and native profiles have separate, existing entrypoints', () => {
  const ordinary = readProfile('ordinary');
  const native = readProfile('native');

  assert.equal(ordinary.data.id, 'ordinary-user-contract');
  assert.equal(native.data.id, 'native-smart-account');
  assert.notEqual(ordinary.data.id, native.data.id);
  assert.equal(ordinary.data.verification.profile, 'ordinary');
  assert.equal(native.data.verification.profile, 'native');

  for (const profile of [ordinary, native]) {
    assertLocalPaths(profile, 'canonicalSourceRoots');
    assertLocalPaths(profile, 'excludedSourceRoots');
    assertLocalPaths(profile, 'compatibilityPaths');
    assertLocalPaths(profile, 'entrypoints');
    assertLocalPaths(profile, 'artifactRoots');
    if (profile.data.protocolEvidence) assertLocalPaths(profile, 'protocolEvidence');
  }

  // A broad ordinary root may contain native files for build compatibility, but
  // every native canonical root must be explicitly excluded from that profile.
  for (const nativeRoot of native.data.canonicalSourceRoots) {
    assert.ok(
      ordinary.data.excludedSourceRoots.includes(nativeRoot),
      `ordinary profile must exclude native root: ${nativeRoot}`,
    );
  }

  // Native source roots are explicit native paths; no ordinary-only root is
  // silently promoted into the native profile.
  for (const nativeRoot of native.data.canonicalSourceRoots) {
    assert.match(nativeRoot, /native/i, `native root is not clearly native: ${nativeRoot}`);
  }
  for (const ordinaryRoot of native.data.excludedSourceRoots) {
    assert.doesNotMatch(ordinaryRoot, /native/i, `native profile excludes a native root: ${ordinaryRoot}`);
  }

  assert.ok(native.data.externalBoundaries.length >= 2, 'native external boundary must be documented');
  assert.match(native.data.externalBoundaries.join('\n'), /SmartAccount/);
  assert.equal(native.data.implementationVerified, false);
  // The cross-proxy authority gate was closed in the local candidate and
  // replaced by an independent readback requirement; see
  // `localAuthorityAdmission` in the native profile.
  assert.ok(native.data.openGates.includes('CURRENT-PROFILE-ARTIFACT-READBACK'));
  assert.ok(native.data.openGates.includes('EXTERNAL-PROTOCOL-ACCEPTANCE'));
  assert.ok(native.data.openGates.includes('PUBLIC-HARDFORK-ACTIVATION'));
});

test('ordinary artifact identity does not certify the newer source fixes or a public upgrade', () => {
  const ordinary = readProfile('ordinary').data;
  assert.equal(ordinary.implementationVerified, false);
  assert.equal(ordinary.artifactIdentityVerified, true);
  assert.equal(ordinary.status, 'public-artifact-identity-verified-upgrade-required');
  assert.equal(ordinary.protocolStatus, 'source-checks-passed-conformance-open');
  assert.match(ordinary.protocolScope, /Full protocol conformance remains open/);
  assert.deepEqual(ordinary.protocolEvidence, [
    'docs/PROTOCOL_COMPLETENESS_AUDIT.md',
    'docs/SA-SYSTEM-STATUS.md',
    'docs/SA-FORMAL-VERIFICATION.md',
  ]);
  assert.deepEqual(ordinary.releaseBoundaries, [
    'PUBLIC-CALLBACK-RESOURCE-ISOLATION',
    'PINNED-ARTIFACT-UPGRADE-REVIEW',
    'PUBLIC-DEPLOYMENT-READBACK',
  ]);
  assert.equal(ordinary.currentSourceCandidate.status, 'source-ahead-of-pinned-public-artifact');
  assert.equal(ordinary.currentSourceCandidate.releaseGate, 'required-before-public-upgrade');

  const verified = ordinary.verifiedArtifact;
  // The published mainnet deployment is an immutable on-chain fact: its manifest
  // still carries the pre-rename contract name, and the pinned sha256 below is
  // the hash of the bytes that are actually deployed. Renaming the local source
  // tree must not relabel it, so this block keeps the deployed identity until a
  // new deployment supplies its own readback evidence.
  assert.equal(verified.contractName, 'UnifiedSmartWalletV3');
  const nefPath = path.join(repoRoot, verified.path);
  const manifestPath = path.join(repoRoot, verified.manifestPath);
  assert.equal(createHash('sha256').update(fs.readFileSync(nefPath)).digest('hex'), verified.nefSha256);
  assert.equal(createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'), verified.manifestSha256);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, verified.contractName);
  assert.equal(manifest.abi.methods.length, verified.abiMethodCount);

  const evidencePath = path.join(repoRoot, verified.publicReadbackEvidence);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assert.equal(evidence.network, verified.network);
  assert.equal(evidence.coreHash, verified.coreHash);
  assert.equal(evidence.candidate.nefSha256, `0x${verified.nefSha256}`);
  assert.equal(evidence.candidate.manifestSha256, `0x${verified.manifestSha256}`);
  assert.equal(evidence.nodes.length, verified.independentRpcReadbacks);
  assert.ok(evidence.nodes.every((node) => node.networkMagic === 860833102));
  assert.ok(evidence.nodes.every((node) => node.scriptMatches === true && node.manifestMatches === true));
  assert.ok(evidence.nodes.every((node) => node.scriptSha256 === evidence.candidate.scriptSha256));
  assert.ok(evidence.nodes.every((node) => node.methods === verified.abiMethodCount));
  assert.ok(evidence.txid && evidence.blockIndex > 0 && evidence.verifiedAt);
});

test('implementation README entrypoints and profile metadata stay discoverable', () => {
  for (const name of ['ordinary', 'native']) {
    const directory = path.join(repoRoot, 'implementations', name);
    const readme = fs.readFileSync(path.join(directory, 'README.md'), 'utf8');
    const profile = JSON.parse(fs.readFileSync(path.join(directory, 'profile.json'), 'utf8'));
    assert.match(readme, /profile\.json/);
    assert.match(readme, new RegExp(profile.verification.profile));
  }
});
