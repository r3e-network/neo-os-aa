#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const oracleRootCandidates = [
  path.resolve(repoRoot, '..', 'neo-os-services'),
  path.resolve(repoRoot, '..', '..', 'neo-os', 'neo-os-services'),
];
const defaultOracleRoot = oracleRootCandidates.find((candidate) => fs.existsSync(candidate))
  || oracleRootCandidates[0];
const oracleRoot = process.env.MORPHEUS_ORACLE_ROOT
  ? path.resolve(process.env.MORPHEUS_ORACLE_ROOT)
  : defaultOracleRoot;

// The canonical confidential-envelope implementation lives in the oracle
// workspace. AA keeps only a generated browser artifact plus a thin adapter;
// the generated source is refreshed and byte-checked by this script.
const CANONICAL_ENVELOPE_RELATIVE_PATH = 'packages/shared/src/confidential-envelope.js';
const CANONICAL_ENVELOPE_SHA256 =
  '6071fcbe03f66281c9504a200a2505e12896c69ca2df305bb81c3ac91bf8ab5d';
const LOCAL_GENERATED_ENVELOPE_RELATIVE_PATH =
  'frontend/src/utils/morpheusConfidentialEnvelope.generated.js';

async function loadOracleModule(moduleName, exportName) {
  const modulePath = path.join(oracleRoot, 'scripts', moduleName);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Missing canonical module: ${modulePath}`);
  }

  const module = await import(pathToFileURL(modulePath).href);
  const loader = module[exportName];
  if (typeof loader !== 'function') {
    throw new Error(`Missing export ${exportName} in ${modulePath}`);
  }

  return loader({ oracleRoot });
}

// Dry-run mode (--dry-run flag or SYNC_DRY_RUN=1): verify parity and report
// what the regenerated exports would change without writing any files. Use it
// whenever the oracle workspace may be mid-change.
const DRY_RUN = process.argv.includes('--dry-run') || process.env.SYNC_DRY_RUN === '1';

function writeGeneratedJs(targetPath, exportName, value, commentLine) {
  const body = [
    '/* eslint-disable */',
    commentLine,
    '// Do not edit manually; re-export from the Morpheus canonical oracle workspace.',
    '',
    `export const ${exportName} = ${JSON.stringify(value, null, 2)};`,
    '',
  ].join('\n');

  if (!DRY_RUN) {
    fs.writeFileSync(targetPath, body, 'utf8');
    return;
  }

  const relativeTarget = path.relative(repoRoot, targetPath);
  const previous = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
  if (previous === null) {
    console.log(`[dry-run] would create ${relativeTarget} (${body.length} bytes)`);
    return;
  }
  if (previous === body) {
    console.log(`[dry-run] unchanged: ${relativeTarget}`);
    return;
  }

  const previousLines = previous.split('\n');
  const nextLines = body.split('\n');
  const changed = [];
  for (let i = 0; i < Math.max(previousLines.length, nextLines.length); i += 1) {
    if (previousLines[i] !== nextLines[i]) {
      changed.push(`  line ${i + 1}:\n    - ${previousLines[i] ?? '<missing>'}\n    + ${nextLines[i] ?? '<missing>'}`);
    }
  }
  console.log(`[dry-run] would update ${relativeTarget}: ${changed.length} line(s) differ`);
  for (const line of changed.slice(0, 40)) {
    console.log(line);
  }
  if (changed.length > 40) {
    console.log(`  … and ${changed.length - 40} more differing line(s)`);
  }
}

function writeGeneratedSource(targetPath, source, sourceSha256, commentLine) {
  const body = [
    '// GENERATED from neo-os-services/packages/shared/src/confidential-envelope.js.',
    `// Source sha256: ${sourceSha256}. Re-run scripts/sync_morpheus_registry.mjs after a reviewed canonical change.`,
    `// ${commentLine}`,
    '',
    source,
  ].join('\n');

  if (!DRY_RUN) {
    fs.writeFileSync(targetPath, body, 'utf8');
    return;
  }

  const relativeTarget = path.relative(repoRoot, targetPath);
  const previous = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
  if (previous === null) {
    console.log(`[dry-run] would create ${relativeTarget} (${body.length} bytes)`);
    return;
  }
  if (previous === body) {
    console.log(`[dry-run] unchanged: ${relativeTarget}`);
    return;
  }
  console.log(`[dry-run] would update ${relativeTarget}`);
}

async function assertConfidentialEnvelopeParity() {
  const canonicalPath = path.join(oracleRoot, CANONICAL_ENVELOPE_RELATIVE_PATH);
  if (!fs.existsSync(canonicalPath)) {
    throw new Error(`Missing canonical module: ${canonicalPath}`);
  }

  const canonicalSource = fs.readFileSync(canonicalPath, 'utf8');
  const canonicalSha256 = createHash('sha256').update(canonicalSource).digest('hex');
  if (canonicalSha256 !== CANONICAL_ENVELOPE_SHA256) {
    throw new Error(
      [
        `Canonical confidential envelope drift detected: ${canonicalPath}`,
        `expected sha256 ${CANONICAL_ENVELOPE_SHA256}`,
        `actual   sha256 ${canonicalSha256}`,
        `Re-verify the generated browser artifact ${LOCAL_GENERATED_ENVELOPE_RELATIVE_PATH},`,
        'run `node --test tests/morpheus-envelope-roundtrip.unit.test.js` in sdk/js,',
        'then update CANONICAL_ENVELOPE_SHA256 in this script.',
      ].join('\n')
    );
  }

  writeGeneratedSource(
    path.join(repoRoot, LOCAL_GENERATED_ENVELOPE_RELATIVE_PATH),
    canonicalSource,
    canonicalSha256,
    'Do not edit manually; import this module through morpheusEncryption.js.',
  );

  if (!DRY_RUN) {
    const generatedPath = path.join(repoRoot, LOCAL_GENERATED_ENVELOPE_RELATIVE_PATH);
    const generatedSource = fs.readFileSync(generatedPath, 'utf8');
    if (!generatedSource.includes(`Source sha256: ${canonicalSha256}.`)
      || !generatedSource.endsWith(canonicalSource)) {
      throw new Error(
        `Generated envelope ${LOCAL_GENERATED_ENVELOPE_RELATIVE_PATH} does not match ${CANONICAL_ENVELOPE_RELATIVE_PATH}`
      );
    }
  }
}

async function main() {
  await assertConfidentialEnvelopeParity();

  const registry = await loadOracleModule('lib-public-network-registry.mjs', 'loadPublicNetworkRegistry');
  const catalog = await loadOracleModule('lib-public-runtime-catalog.mjs', 'loadPublicRuntimeCatalog');

  writeGeneratedJs(
    path.join(repoRoot, 'frontend/src/config/generatedMorpheusRegistry.js'),
    'MORPHEUS_PUBLIC_REGISTRY',
    registry,
    '// Generated from neo-os-services/scripts/export-public-network-registry.mjs.'
  );

  writeGeneratedJs(
    path.join(repoRoot, 'frontend/src/config/generatedMorpheusRuntimeCatalog.js'),
    'MORPHEUS_PUBLIC_RUNTIME_CATALOG',
    catalog,
    '// Generated from neo-os-services/scripts/export-public-runtime-catalog.mjs.'
  );

  console.log(DRY_RUN
    ? `[dry-run] Verified Morpheus generated config against ${oracleRoot} (no files written)`
    : `Synced Morpheus generated config from ${oracleRoot}`);
  console.log('Confidential envelope parity verified against the canonical oracle module');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
