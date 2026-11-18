#!/usr/bin/env node

// Regenerates, or checks, SA's copies of the Morpheus public registry, runtime
// catalog and confidential envelope from the canonical neo-os-services exports.
//
//   node scripts/sync_morpheus_registry.mjs             write the generated files
//   node scripts/sync_morpheus_registry.mjs --dry-run   compare only; exit 1 on any difference
//   node scripts/sync_morpheus_registry.mjs --check     same as --dry-run
//
// SYNC_DRY_RUN=1 also selects the compare-only mode. The neo-os-services
// checkout comes from MORPHEUS_ORACLE_ROOT, else from a sibling ../neo-os-services.
// A missing checkout, an unexpected canonical envelope hash, or (in compare-only
// mode) any difference exits 1. The shared logic lives in
// scripts/lib/morpheus-canonical-sync.mjs, which frontend/tests/morpheusCanonicalSync.test.js
// uses for the same comparison.

import {
  REPO_ROOT,
  resolveOracleRoot,
  syncGeneratedFiles,
} from './lib/morpheus-canonical-sync.mjs';

const USAGE = [
  'Usage: node scripts/sync_morpheus_registry.mjs [--dry-run | --check]',
  '',
  '  (no flag)   regenerate the Morpheus files under frontend/src from neo-os-services',
  '  --dry-run   compare only; write nothing and exit 1 if any generated file differs',
  '  --check     alias of --dry-run',
  '',
  'Environment: MORPHEUS_ORACLE_ROOT=<neo-os-services checkout>, SYNC_DRY_RUN=1 (compare only).',
].join('\n');

const MAX_REPORTED_LEAVES = 40;

function parseArgs(argv) {
  let dryRun = process.env.SYNC_DRY_RUN === '1';
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '--check') {
      dryRun = true;
    } else if (arg === '-h' || arg === '--help') {
      return { help: true, dryRun };
    } else {
      // An unrecognised flag (for example a misspelt --dry-run) must never fall
      // through to the writing mode.
      throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return { help: false, dryRun };
}

function formatLeaf(value) {
  return value === undefined ? '<absent>' : value;
}

function reportResult(result, dryRun) {
  const prefix = dryRun ? '[dry-run] ' : '';
  if (result.status === 'unchanged') {
    console.log(`${prefix}unchanged: ${result.relativePath}`);
    return;
  }
  if (result.status === 'missing') {
    console.log(`${prefix}missing: ${result.relativePath}`);
    return;
  }

  const verb = result.status === 'written' ? 'updated' : 'differs';
  const detail = result.leafDiffs
    ? `${result.leafDiffs.length} value path(s) differ`
    : result.parseError
      ? `committed file does not load: ${result.parseError}`
      : `first differing line ${result.firstDifferingLine}`;
  console.log(`${prefix}${verb}: ${result.relativePath} (${detail})`);
  if (result.leafDiffs && result.leafDiffs.length === 0) {
    console.log('    values are equal; the header or formatting differs');
  }
  for (const diff of (result.leafDiffs ?? []).slice(0, MAX_REPORTED_LEAVES)) {
    console.log(`    ${diff.path}: ${formatLeaf(diff.previous)} -> ${formatLeaf(diff.next)}`);
  }
  if ((result.leafDiffs?.length ?? 0) > MAX_REPORTED_LEAVES) {
    console.log(`    ... and ${result.leafDiffs.length - MAX_REPORTED_LEAVES} more`);
  }
}

async function main() {
  const { help, dryRun } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }

  const { oracleRoot } = resolveOracleRoot();
  const results = await syncGeneratedFiles({ oracleRoot, repoRoot: REPO_ROOT, dryRun });
  for (const result of results) {
    reportResult(result, dryRun);
  }

  const stale = results.filter((result) => result.status !== 'unchanged');
  if (dryRun) {
    if (stale.length > 0) {
      console.error(
        `[dry-run] ${stale.length} of ${results.length} generated file(s) differ from ${oracleRoot}; ` +
          'review the canonical change, then run scripts/sync_morpheus_registry.mjs without --dry-run.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`[dry-run] ${results.length} generated file(s) match ${oracleRoot} (no files written)`);
    return;
  }
  console.log(`Synced ${stale.length} of ${results.length} generated file(s) from ${oracleRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
