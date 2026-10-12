import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

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
  assert.equal(native.data.id, 'native-account-management');
  assert.notEqual(ordinary.data.id, native.data.id);
  assert.equal(ordinary.data.verification.profile, 'ordinary');
  assert.equal(native.data.verification.profile, 'native');

  for (const profile of [ordinary, native]) {
    assertLocalPaths(profile, 'canonicalSourceRoots');
    assertLocalPaths(profile, 'excludedSourceRoots');
    assertLocalPaths(profile, 'compatibilityPaths');
    assertLocalPaths(profile, 'entrypoints');
    assertLocalPaths(profile, 'artifactRoots');
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
  assert.match(native.data.externalBoundaries.join('\n'), /AccountManagement/);
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
