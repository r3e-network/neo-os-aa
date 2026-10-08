#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAuditReport } from './lib/frontend-audit-policy.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendDir = path.join(rootDir, 'frontend');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--all')) {
  console.error('[frontend audit] Usage: check_frontend_audit_allowlist.mjs [--all]');
  process.exit(1);
}
const all = args[0] === '--all';
const audit = spawnSync('npm', ['audit', ...(all ? [] : ['--omit=dev']), '--json'], {
  cwd: frontendDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  if (audit.error || ![0, 1].includes(audit.status)) {
    throw new Error(`npm audit did not complete successfully: ${audit.error?.message || audit.stderr || audit.status}`);
  }
  const report = JSON.parse(audit.stdout);
  const result = validateAuditReport(report);
  if (result.packageCount === 0) {
    console.log(`[frontend audit] Clean: 0 ${all ? 'total' : 'production'} vulnerabilities reported.`);
  } else {
    console.log(`[frontend audit] Reviewed low-only advisory: ${result.advisories.join(', ')} (${result.packageCount} ${all ? 'total' : 'production'} affected packages).`);
    console.log('[frontend audit] Known upstream risk remains; this is not a zero-vulnerability result.');
  }
} catch (error) {
  console.error(`[frontend audit] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
