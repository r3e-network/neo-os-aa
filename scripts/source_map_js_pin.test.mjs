// CU-187: the frontend production audit gate
// (scripts/check_frontend_audit_allowlist.mjs) fails on any high or critical
// advisory, and it holds source-map-js outside its accepted upstream baseline.
// Pinning the transitive copy is the only permitted fix: no suppression and no
// audit exception. GHSA-68fv-2mgg-jv7q affects 1.0.0 - 1.2.1; 1.2.2 is the fix.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FRONTEND = path.join(REPO_ROOT, 'frontend');

const ADVISORY = {
  ghsa: 'GHSA-68fv-2mgg-jv7q',
  name: 'source-map-js',
  severity: 'high',
  patched: '1.2.2',
};

// Mirrors the audit gate's own severity comparison: a copy is a violation when it
// resolves below the patched release of an advisory at or above the high level.
function advisoryViolations(lock, { name, patched }) {
  return Object.entries(lock.packages || {})
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .filter(([, meta]) => !isPatched(meta?.version, patched))
    .map(([key, meta]) => ({ key, version: meta?.version }));
}

function isPatched(version, patched) {
  // Require canonical stable releases; prereleases do not establish a patch floor.
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (typeof version !== 'string' || !stable.test(version)) return false;
  const parse = (value) => value.split('.').map(BigInt);
  const [major, minor, patch] = parse(version);
  const [wantMajor, wantMinor, wantPatch] = parse(patched);
  if (major !== wantMajor) return major > wantMajor;
  if (minor !== wantMinor) return minor > wantMinor;
  return patch >= wantPatch;
}

test('the patch floor accepts only canonical stable versions at or above the fix', () => {
  for (const version of [
    '1.2.1', '1.2.2-rc.0', '1.3.0-beta.1', '2.0.0-rc.0',
    '1.2.2garbage', '1.2', '1.2.2.0', '01.2.2', '', null, undefined,
  ]) {
    assert.equal(isPatched(version, ADVISORY.patched), false, `${version} must be rejected`);
  }
  for (const version of ['1.2.2', '1.2.3', '1.3.0', '2.0.0']) {
    assert.equal(isPatched(version, ADVISORY.patched), true, `${version} must be accepted`);
  }
});

test('source-map-js stays pinned to the patched transitive release', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8'));
  assert.equal(
    manifest.overrides?.['source-map-js'],
    ADVISORY.patched,
    'frontend/package.json must pin source-map-js to the patched release',
  );
});

test('the source-map-js advisory rejects a vulnerable copy at any lockfile path', () => {
  for (const key of [
    'node_modules/source-map-js',
    'node_modules/postcss/node_modules/source-map-js',
    'node_modules/@vue/compiler-sfc/node_modules/source-map-js',
  ]) {
    const lock = { packages: { [key]: { version: '1.2.1' } } };
    assert.equal(
      advisoryViolations(lock, ADVISORY).length,
      1,
      `a 1.2.1 copy at ${key} must be reported as a violation`,
    );
    lock.packages[key].version = ADVISORY.patched;
    assert.deepEqual(
      advisoryViolations(lock, ADVISORY),
      [],
      `a ${ADVISORY.patched} copy at ${key} must be accepted`,
    );
  }
});

test('the committed frontend lockfile holds no vulnerable source-map-js copy', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package-lock.json'), 'utf8'));
  const keys = Object.keys(lock.packages || {}).filter(
    (key) => key === 'node_modules/source-map-js' || key.endsWith('/node_modules/source-map-js'),
  );
  assert.ok(keys.length > 0, 'source-map-js must still be present in the production tree');
  assert.deepEqual(
    advisoryViolations(lock, ADVISORY),
    [],
    'every committed source-map-js copy must be at the patched release or later',
  );
});
