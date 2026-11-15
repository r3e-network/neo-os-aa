#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
// npm is a .cmd shim on Windows and Node blocks spawning .cmd without a shell
// (CVE-2024-27980). Prefer the real npm-cli.js next to the shim (standard
// Node layout), which runs under the current node binary with no shell at all.
function resolveNpmCli() {
  if (process.platform !== 'win32') return null;
  try {
    const probe = spawnSync('where', ['npm'], { encoding: 'utf8' });
    const shim = probe.stdout.split(/\r?\n/).find((line) => line.trim().endsWith('npm.cmd'));
    if (!shim) return null;
    const cli = path.join(path.dirname(shim.trim()), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}
const npmCli = resolveNpmCli();
const audit = npmCli
  ? spawnSync(process.execPath, [npmCli, 'audit', ...(all ? [] : ['--omit=dev']), '--json'], {
    cwd: frontendDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Fallback: fixed literal argument list, safe to pass through the shell.
  : spawnSync('npm', ['audit', ...(all ? [] : ['--omit=dev']), '--json'], {
    cwd: frontendDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
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
