import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// URL.pathname keeps the POSIX leading slash ("/D:/Git/..."); on Windows
// path.resolve then doubles the drive ("D:\D:\Git\..."). fileURLToPath is the
// portable conversion.
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Native is the only implementation profile the build still ships, so this
// suite reads contracts/native and no other contract source tree. Nothing in
// the default build, test or verification path may require a retired tree to exist.
const profileDirectory = 'contracts/native';

function readProfile() {
  const profilePath = path.join(repoRoot, profileDirectory, 'profile.json');
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

test('the native profile is the shipped implementation profile and tracks native-v4', () => {
  const native = readProfile();

  assert.equal(native.data.id, 'native-smart-account');
  assert.equal(native.data.verification.profile, 'native');
  // The profile metadata and the published parameter set must describe the same
  // protocol, so a stale profile cannot describe an older ABI than the one the
  // modules are built against.
  assert.equal(native.data.version, 4, 'the native profile version follows the native-v4 parameter set');
  assert.equal(native.data.protocolVersion, 4);
  assert.equal(native.data.protocolParameters, 'docs/proposals/smartaccount-native-profile-parameters.json');

  const parameters = JSON.parse(fs.readFileSync(path.join(repoRoot, native.data.protocolParameters), 'utf8'));
  assert.equal(parameters.profileVersion, native.data.version);
  assert.equal(parameters.abiVersion, native.data.protocolVersion);
  assert.equal(parameters.contractName, 'SmartAccount');
});

test('every root, entrypoint and artifact root the native profile names exists', () => {
  const profile = readProfile();
  for (const field of ['canonicalSourceRoots', 'excludedSourceRoots', 'compatibilityPaths', 'entrypoints', 'artifactRoots']) {
    assertLocalPaths(profile, field);
  }
  if (profile.data.protocolEvidence) assertLocalPaths(profile, 'protocolEvidence');
});

test('the native profile excludes only client-side roots, never a contract source tree', () => {
  const native = readProfile().data;

  for (const excluded of native.excludedSourceRoots) {
    assert.ok(
      !excluded.startsWith('contracts/'),
      `native profile excludes a contract source root: ${excluded}`,
    );
  }
  for (const root of native.canonicalSourceRoots) {
    assert.match(root, /native/i, `native root is not clearly native: ${root}`);
  }
  for (const excluded of native.excludedSourceRoots) {
    assert.doesNotMatch(excluded, /contracts\/native|native-profile/i, `native profile excludes a native root: ${excluded}`);
  }
});

test('the native build and test entrypoints are native-only', () => {
  const native = readProfile().data;
  const solution = fs.readFileSync(path.join(repoRoot, 'SmartAccount.sln'), 'utf8').replace(/\r\n?/g, '\n');

  // SmartAccount.sln is the independent native build entry: the overlay core, the
  // native unit tests and every SMARTACCOUNT_NATIVE module must be in it, and no
  // custom project may be.
  for (const project of [
    'contracts\\native\\Neo.csproj',
    'tests\\SmartAccount.Native.Tests\\SmartAccount.Tests.csproj',
    'contracts\\plugins\\native-profile\\SessionKeyValidator.Native.csproj',
  ]) {
    assert.ok(solution.includes(project), `SmartAccount.sln does not include ${project}`);
  }
  assert.doesNotMatch(solution, /contracts\\custom\\/, 'SmartAccount.sln still references the retired custom tree');
  assert.doesNotMatch(solution, /SmartAccount\.Contracts\.Tests/, 'SmartAccount.sln still references the custom contract tests');

  for (const entrypoint of ['SmartAccount.sln', 'tests/SmartAccount.Native.Tests/SmartAccount.Tests.csproj']) {
    assert.ok(native.entrypoints.includes(entrypoint), `the native profile does not name ${entrypoint}`);
  }
});

test('the native profile keeps its open gates and unverified status', () => {
  const native = readProfile().data;

  assert.ok(native.externalBoundaries.length >= 2, 'native external boundary must be documented');
  assert.match(native.externalBoundaries.join('\n'), /SmartAccount/);
  assert.equal(native.implementationVerified, false);
  // The cross-proxy authority gate was closed in the local candidate and
  // replaced by an independent readback requirement; see
  // `localAuthorityAdmission` in the native profile.
  assert.ok(native.openGates.includes('CURRENT-PROFILE-ARTIFACT-READBACK'));
  assert.ok(native.openGates.includes('EXTERNAL-PROTOCOL-ACCEPTANCE'));
  assert.ok(native.openGates.includes('PUBLIC-HARDFORK-ACTIVATION'));
});

test('the native implementation README entrypoint stays discoverable', () => {
  const directory = path.join(repoRoot, profileDirectory);
  const readme = fs.readFileSync(path.join(directory, 'README.md'), 'utf8');
  const profile = JSON.parse(fs.readFileSync(path.join(directory, 'profile.json'), 'utf8'));
  assert.match(readme, /profile\.json/);
  assert.match(readme, new RegExp(profile.verification.profile));
});
