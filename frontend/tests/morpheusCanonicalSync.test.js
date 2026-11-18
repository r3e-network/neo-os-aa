import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MORPHEUS_PUBLIC_REGISTRY } from '../src/config/generatedMorpheusRegistry.js';
import { MORPHEUS_PUBLIC_RUNTIME_CATALOG } from '../src/config/generatedMorpheusRuntimeCatalog.js';
import {
  CANONICAL_ENVELOPE_RELATIVE_PATH,
  CANONICAL_ENVELOPE_SHA256,
  GENERATED_FILES,
  ORACLE_ROOT_ENV,
  REPO_ROOT,
  REQUIRE_SERVICES_ENV,
  computeExpectedGeneratedFiles,
  decideCanonicalSyncGate,
} from '../../scripts/lib/morpheus-canonical-sync.mjs';

const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync_morpheus_registry.mjs');

function readGenerated(key) {
  return fs.readFileSync(path.join(REPO_ROOT, GENERATED_FILES[key]), 'utf8');
}

// --- Comparison against the canonical neo-os-services export ----------------
//
// Runs whenever a neo-os-services checkout is reachable (MORPHEUS_ORACLE_ROOT or
// a sibling ../neo-os-services), fails when it is absent in release mode
// (NEOOS_REQUIRE_SERVICES_ARTIFACTS=1), and is otherwise skipped with the reason.

const gate = decideCanonicalSyncGate();
const liveOptions = gate.mode === 'skip' ? { skip: gate.reason } : {};
let canonicalFiles;

async function loadCanonicalFiles(t) {
  if (gate.mode === 'fail') {
    assert.fail(gate.reason);
  }
  t.diagnostic(`canonical source: ${gate.oracleRoot}`);
  canonicalFiles ??= computeExpectedGeneratedFiles(gate.oracleRoot).then((entries) =>
    Object.fromEntries(entries.map((entry) => [entry.key, entry])),
  );
  return canonicalFiles;
}

const RESYNC_HINT = 'regenerate it with scripts/sync_morpheus_registry.mjs after reviewing the canonical change';

test(
  'generated Morpheus public registry stays synchronized with the canonical neo-os-services export',
  liveOptions,
  async (t) => {
    const { registry } = await loadCanonicalFiles(t);
    assert.deepEqual(MORPHEUS_PUBLIC_REGISTRY, registry.value);
    assert.equal(readGenerated('registry'), registry.body, `${GENERATED_FILES.registry}: ${RESYNC_HINT}`);
  },
);

test(
  'generated Morpheus runtime catalog stays synchronized with the canonical neo-os-services export',
  liveOptions,
  async (t) => {
    const { catalog } = await loadCanonicalFiles(t);
    assert.deepEqual(MORPHEUS_PUBLIC_RUNTIME_CATALOG, catalog.value);
    assert.equal(readGenerated('catalog'), catalog.body, `${GENERATED_FILES.catalog}: ${RESYNC_HINT}`);
  },
);

test(
  'generated confidential envelope stays byte-identical to the canonical neo-os-services module',
  liveOptions,
  async (t) => {
    const { envelope } = await loadCanonicalFiles(t);
    assert.equal(readGenerated('envelope'), envelope.body, `${GENERATED_FILES.envelope}: ${RESYNC_HINT}`);
  },
);

// --- Gate policy ---------------------------------------------------------------

function tempDirectory(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Nested so that neither sibling-lookup candidate resolves outside the temporary directory.
function tempRepoRoot(t) {
  const root = tempDirectory(t, 'sa-morpheus-gate-');
  const repoRoot = path.join(root, 'a', 'b', 'neo-os-sa');
  fs.mkdirSync(repoRoot, { recursive: true });
  return { root, repoRoot };
}

test('canonical sync gate skips an absent neo-os-services checkout outside release mode and says why', (t) => {
  const { repoRoot } = tempRepoRoot(t);
  const decision = decideCanonicalSyncGate({ env: {}, repoRoot });
  assert.equal(decision.mode, 'skip');
  assert.equal(decision.oracleRoot, path.resolve(repoRoot, '..', 'neo-os-services'));
  assert.match(decision.reason, /0 canonical comparisons executed/);
  assert.match(decision.reason, new RegExp(ORACLE_ROOT_ENV));
  assert.match(decision.reason, new RegExp(`${REQUIRE_SERVICES_ENV}=1`));
});

test('canonical sync gate fails an absent neo-os-services checkout in release mode', (t) => {
  const { repoRoot } = tempRepoRoot(t);
  const decision = decideCanonicalSyncGate({ env: { [REQUIRE_SERVICES_ENV]: '1' }, repoRoot });
  assert.equal(decision.mode, 'fail');
  assert.match(decision.reason, /0 canonical comparisons executed/);
});

test('canonical sync gate compares a sibling checkout and any explicit MORPHEUS_ORACLE_ROOT', (t) => {
  const { root, repoRoot } = tempRepoRoot(t);
  const explicit = path.join(root, 'not-created');
  assert.deepEqual(decideCanonicalSyncGate({ env: { [ORACLE_ROOT_ENV]: explicit }, repoRoot }), {
    mode: 'run',
    oracleRoot: explicit,
    reason: '',
  });

  const sibling = path.resolve(repoRoot, '..', 'neo-os-services');
  fs.mkdirSync(sibling);
  assert.deepEqual(decideCanonicalSyncGate({ env: {}, repoRoot }), { mode: 'run', oracleRoot: sibling, reason: '' });
});

// --- Sync script exit semantics, against a fixture neo-os-services tree --------

// The committed envelope is a four-line header followed by the canonical source.
function embeddedEnvelopeSource() {
  return readGenerated('envelope').split('\n').slice(4).join('\n');
}

function fixtureServices(t, { registry = MORPHEUS_PUBLIC_REGISTRY, catalog = MORPHEUS_PUBLIC_RUNTIME_CATALOG } = {}) {
  const root = tempDirectory(t, 'sa-morpheus-services-');
  const envelopePath = path.join(root, CANONICAL_ENVELOPE_RELATIVE_PATH);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.dirname(envelopePath), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'lib-public-network-registry.mjs'),
    `export function loadPublicNetworkRegistry() { return ${JSON.stringify(registry)}; }\n`,
  );
  fs.writeFileSync(
    path.join(root, 'scripts', 'lib-public-runtime-catalog.mjs'),
    `export function loadPublicRuntimeCatalog() { return ${JSON.stringify(catalog)}; }\n`,
  );
  fs.writeFileSync(envelopePath, embeddedEnvelopeSource());
  return root;
}

function driftedRegistry() {
  const registry = structuredClone(MORPHEUS_PUBLIC_REGISTRY);
  registry.mainnet.domains.sa = 'drifted.example.neo';
  return registry;
}

// Snapshots the generated files and restores any that a faulty run rewrote.
function guardGeneratedFiles(t) {
  const snapshot = Object.fromEntries(Object.keys(GENERATED_FILES).map((key) => [key, readGenerated(key)]));
  t.after(() => {
    for (const [key, body] of Object.entries(snapshot)) {
      if (readGenerated(key) !== body) {
        fs.writeFileSync(path.join(REPO_ROOT, GENERATED_FILES[key]), body, 'utf8');
      }
    }
  });
  return () => Object.fromEntries(Object.keys(GENERATED_FILES).map((key) => [key, readGenerated(key)]));
}

function runSync(args, oracleRoot) {
  const env = { ...process.env, [ORACLE_ROOT_ENV]: oracleRoot };
  delete env.SYNC_DRY_RUN;
  return spawnSync(process.execPath, [SYNC_SCRIPT, ...args], { cwd: REPO_ROOT, env, encoding: 'utf8' });
}

test('the committed envelope embeds source that hashes to the pinned canonical sha256', () => {
  const digest = createHash('sha256').update(embeddedEnvelopeSource()).digest('hex');
  assert.equal(digest, CANONICAL_ENVELOPE_SHA256);
  assert.ok(readGenerated('envelope').includes(`Source sha256: ${CANONICAL_ENVELOPE_SHA256}.`));
});

test('sync --dry-run exits 0 and writes nothing when every generated file matches', (t) => {
  const current = guardGeneratedFiles(t);
  const before = current();
  const result = runSync(['--dry-run'], fixtureServices(t));
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /3 generated file\(s\) match/);
  assert.deepEqual(current(), before);
});

test('sync --dry-run and --check exit 1 on a canonical difference and write nothing', (t) => {
  const current = guardGeneratedFiles(t);
  const before = current();
  const services = fixtureServices(t, { registry: driftedRegistry() });
  for (const flag of ['--dry-run', '--check']) {
    const result = runSync([flag], services);
    assert.equal(result.status, 1, `${flag}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /generatedMorpheusRegistry\.js \(1 value path\(s\) differ\)/);
    assert.match(result.stdout, /mainnet\.domains\.sa: "[^"]+" -> "drifted\.example\.neo"/);
    assert.match(result.stderr, /1 of 3 generated file\(s\) differ/);
  }
  assert.deepEqual(current(), before);
});

test('sync exits 1 without a neo-os-services checkout and rejects unknown flags without writing', (t) => {
  const current = guardGeneratedFiles(t);
  const before = current();

  const missing = runSync(['--dry-run'], path.join(tempDirectory(t, 'sa-morpheus-absent-'), 'absent'));
  assert.equal(missing.status, 1, `${missing.stdout}${missing.stderr}`);
  assert.match(missing.stderr, /Missing canonical module: .*; MORPHEUS_ORACLE_ROOT \(else a sibling/);

  // A misspelt --dry-run must not fall through to the writing mode.
  const misspelt = runSync(['--dryrun'], fixtureServices(t, { registry: driftedRegistry() }));
  assert.equal(misspelt.status, 1, `${misspelt.stdout}${misspelt.stderr}`);
  assert.match(misspelt.stderr, /Unknown argument: --dryrun/);
  assert.deepEqual(current(), before);
});
