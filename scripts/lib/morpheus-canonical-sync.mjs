// Morpheus canonical-sync core, shared by scripts/sync_morpheus_registry.mjs and
// frontend/tests/morpheusCanonicalSync.test.js so both compare the same bytes.
//
// neo-os-services is the single source of truth for the Morpheus public network
// registry, the public runtime catalog and the confidential-envelope module. SA
// keeps generated copies of all three under frontend/src. This module resolves
// the neo-os-services checkout, loads its canonical exports and renders the
// exact file contents those copies must have.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

// Explicit neo-os-services checkout. When set it is always used, so a wrong
// path fails the comparison instead of silently skipping it.
export const ORACLE_ROOT_ENV = 'MORPHEUS_ORACLE_ROOT';

// Release-grade cross-repository switch, shared with scripts/verify_repo.sh and
// the NeoDIDRegistry integration proof. Set it to 1 in an environment that must
// supply neo-os-services; a missing checkout then fails instead of skipping.
export const REQUIRE_SERVICES_ENV = 'NEOOS_REQUIRE_SERVICES_ARTIFACTS';

// The confidential envelope is pinned by content hash: a canonical change must
// be reviewed (and the SDK round-trip test re-run) before the pin moves.
export const CANONICAL_ENVELOPE_RELATIVE_PATH = 'packages/shared/src/confidential-envelope.js';
export const CANONICAL_ENVELOPE_SHA256 =
  'c93323b2696683fe355823921639a1f6495a876abf4d862ca4b6b4081e37f0a7';

const CHECKOUT_HINT = `${ORACLE_ROOT_ENV} (else a sibling ../neo-os-services) must name a neo-os-services checkout`;

export const GENERATED_FILES = Object.freeze({
  envelope: 'frontend/src/utils/morpheusConfidentialEnvelope.generated.js',
  registry: 'frontend/src/config/generatedMorpheusRegistry.js',
  catalog: 'frontend/src/config/generatedMorpheusRuntimeCatalog.js',
});

const GENERATED_EXPORTS = Object.freeze([
  {
    key: 'registry',
    exportName: 'MORPHEUS_PUBLIC_REGISTRY',
    moduleName: 'lib-public-network-registry.mjs',
    loaderName: 'loadPublicNetworkRegistry',
    cliName: 'export-public-network-registry.mjs',
  },
  {
    key: 'catalog',
    exportName: 'MORPHEUS_PUBLIC_RUNTIME_CATALOG',
    moduleName: 'lib-public-runtime-catalog.mjs',
    loaderName: 'loadPublicRuntimeCatalog',
    cliName: 'export-public-runtime-catalog.mjs',
  },
]);

export function oracleRootCandidates(repoRoot = REPO_ROOT) {
  return [
    path.resolve(repoRoot, '..', 'neo-os-services'),
    path.resolve(repoRoot, '..', '..', 'neo-os', 'neo-os-services'),
  ];
}

export function resolveOracleRoot({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  const configured = typeof env[ORACLE_ROOT_ENV] === 'string' ? env[ORACLE_ROOT_ENV].trim() : '';
  if (configured) {
    const oracleRoot = path.resolve(configured);
    return { oracleRoot, configured: true, present: fs.existsSync(oracleRoot) };
  }
  const candidates = oracleRootCandidates(repoRoot);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return { oracleRoot: found ?? candidates[0], configured: false, present: Boolean(found) };
}

// Decides whether the canonical comparison runs, is skipped, or fails:
// - an explicit MORPHEUS_ORACLE_ROOT is always compared;
// - a sibling neo-os-services checkout is compared whenever it is present;
// - an absent checkout fails in release mode (NEOOS_REQUIRE_SERVICES_ARTIFACTS=1)
//   and is otherwise skipped with its reason, never reported as a pass.
export function decideCanonicalSyncGate({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  const { oracleRoot, configured, present } = resolveOracleRoot({ env, repoRoot });
  if (configured || present) {
    return { mode: 'run', oracleRoot, reason: '' };
  }
  const release = env[REQUIRE_SERVICES_ENV] === '1';
  const reason = [
    `neo-os-services checkout not found at ${oracleRoot}; 0 canonical comparisons executed.`,
    'The Morpheus registry, runtime catalog and confidential envelope under frontend/src are',
    'generated from neo-os-services, a sibling repository that a single-repository checkout lacks.',
    `Set ${ORACLE_ROOT_ENV} to a neo-os-services checkout to compare against it`,
    release
      ? `(${REQUIRE_SERVICES_ENV}=1 is set, so the missing checkout is a failure).`
      : `or ${REQUIRE_SERVICES_ENV}=1 to make the missing checkout a failure.`,
  ].join(' ');
  return { mode: release ? 'fail' : 'skip', oracleRoot, reason };
}

async function loadCanonicalExport(oracleRoot, moduleName, loaderName) {
  const modulePath = path.join(oracleRoot, 'scripts', moduleName);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Missing canonical module: ${modulePath}; ${CHECKOUT_HINT}`);
  }
  const module = await import(pathToFileURL(modulePath).href);
  const loader = module[loaderName];
  if (typeof loader !== 'function') {
    throw new Error(`Missing export ${loaderName} in ${modulePath}`);
  }
  return loader({ oracleRoot });
}

export function readCanonicalEnvelope(oracleRoot) {
  const canonicalPath = path.join(oracleRoot, CANONICAL_ENVELOPE_RELATIVE_PATH);
  if (!fs.existsSync(canonicalPath)) {
    throw new Error(`Missing canonical module: ${canonicalPath}; ${CHECKOUT_HINT}`);
  }
  const source = fs.readFileSync(canonicalPath, 'utf8');
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (sha256 !== CANONICAL_ENVELOPE_SHA256) {
    throw new Error(
      [
        `Canonical confidential envelope drift detected: ${canonicalPath}`,
        `expected sha256 ${CANONICAL_ENVELOPE_SHA256}`,
        `actual   sha256 ${sha256}`,
        `Re-verify the generated browser artifact ${GENERATED_FILES.envelope},`,
        'run `node --test tests/morpheus-envelope-roundtrip.unit.test.js` in sdk/js,',
        'then update CANONICAL_ENVELOPE_SHA256 in scripts/lib/morpheus-canonical-sync.mjs.',
      ].join('\n'),
    );
  }
  return { source, sha256 };
}

export function renderGeneratedExport(exportName, value, cliName) {
  return [
    '/* eslint-disable */',
    `// Generated from neo-os-services/scripts/${cliName}.`,
    '// Do not edit manually; re-export from the Morpheus canonical oracle workspace.',
    '',
    `export const ${exportName} = ${JSON.stringify(value, null, 2)};`,
    '',
  ].join('\n');
}

export function renderGeneratedEnvelope(source, sha256) {
  return [
    '// GENERATED from neo-os-services/packages/shared/src/confidential-envelope.js.',
    `// Source sha256: ${sha256}. Re-run scripts/sync_morpheus_registry.mjs after a reviewed canonical change.`,
    '// Do not edit manually; import this module through morpheusEncryption.js.',
    '',
    source,
  ].join('\n');
}

// Returns the three generated files exactly as scripts/sync_morpheus_registry.mjs
// writes them, keyed as envelope, registry and catalog. Registry and catalog
// entries also carry the canonical value and the export name.
export async function computeExpectedGeneratedFiles(oracleRoot) {
  const envelope = readCanonicalEnvelope(oracleRoot);
  const expected = [
    {
      key: 'envelope',
      relativePath: GENERATED_FILES.envelope,
      body: renderGeneratedEnvelope(envelope.source, envelope.sha256),
    },
  ];
  for (const spec of GENERATED_EXPORTS) {
    const value = await loadCanonicalExport(oracleRoot, spec.moduleName, spec.loaderName);
    expected.push({
      key: spec.key,
      relativePath: GENERATED_FILES[spec.key],
      exportName: spec.exportName,
      value,
      body: renderGeneratedExport(spec.exportName, value, spec.cliName),
    });
  }
  return expected;
}

function collectLeaves(value, prefix, leaves) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value);
    if (entries.length === 0) {
      leaves.set(prefix, JSON.stringify(value));
    }
    for (const [key, item] of entries) {
      collectLeaves(item, prefix ? `${prefix}.${key}` : key, leaves);
    }
    return leaves;
  }
  leaves.set(prefix, value === undefined ? undefined : JSON.stringify(value));
  return leaves;
}

// Lists every leaf path whose value differs between two JSON-shaped values.
export function diffLeafPaths(previous, next) {
  const before = collectLeaves(previous, '', new Map());
  const after = collectLeaves(next, '', new Map());
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((leafPath) => before.get(leafPath) !== after.get(leafPath))
    .map((leafPath) => ({ path: leafPath, previous: before.get(leafPath), next: after.get(leafPath) }));
}

async function readCommittedExport(filePath, exportName) {
  try {
    // A query string forces a fresh evaluation of a file that may change between reads.
    const module = await import(`${pathToFileURL(filePath).href}?read=${Date.now()}-${Math.random()}`);
    return { value: module[exportName] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function firstDifferingLine(previous, next) {
  const before = previous.split('\n');
  const after = next.split('\n');
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (before[index] !== after[index]) return index + 1;
  }
  return 0;
}

// Compares (dryRun) or rewrites the generated copies against the canonical
// export. Returns one entry per generated file with status 'unchanged',
// 'missing', 'differs' or 'written'. A dry run never writes.
export async function syncGeneratedFiles({ oracleRoot, repoRoot = REPO_ROOT, dryRun }) {
  const expected = await computeExpectedGeneratedFiles(oracleRoot);
  const results = [];
  for (const entry of expected) {
    const targetPath = path.join(repoRoot, entry.relativePath);
    const previous = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
    if (previous === entry.body) {
      results.push({ relativePath: entry.relativePath, status: 'unchanged' });
      continue;
    }

    const result = { relativePath: entry.relativePath, status: previous === null ? 'missing' : 'differs' };
    if (previous !== null) {
      result.firstDifferingLine = firstDifferingLine(previous, entry.body);
      if (entry.exportName) {
        const committed = await readCommittedExport(targetPath, entry.exportName);
        if (committed.error) {
          result.parseError = committed.error;
        } else {
          result.leafDiffs = diffLeafPaths(committed.value, entry.value);
        }
      }
    }

    if (!dryRun) {
      fs.writeFileSync(targetPath, entry.body, 'utf8');
      if (fs.readFileSync(targetPath, 'utf8') !== entry.body) {
        throw new Error(`Generated file ${entry.relativePath} does not match the canonical export after writing`);
      }
      result.status = 'written';
    }
    results.push(result);
  }
  return results;
}
