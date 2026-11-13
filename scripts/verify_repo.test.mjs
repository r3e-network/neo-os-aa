import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Workflow files are text whose committed form is LF; a Windows core.autocrlf=true
// checkout materialises CRLF worktree bytes for the same content. The multi-line
// regexes below measure the LF form, so normalize at read time - a no-op on an
// LF checkout.
const readWorkflow = (url) => fs.readFileSync(url, 'utf8').replace(/\r\n?/g, '\n');

function dispatch(t, args = [], failMatch = '', envOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-verify-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'contracts', 'frontend', 'sdk/js', 'commands', 'docs/reports']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.copyFileSync(new URL('./verify_repo.sh', import.meta.url), path.join(root, 'scripts/verify_repo.sh'));
  fs.writeFileSync(path.join(root, 'scripts/dotnet_env.sh'), 'export NCCS_BIN=/test/compiler\n');
  const trace = path.join(root, 'commands.log');
  const stub = '#!/bin/bash\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$VERIFY_TRACE"\nif [[ "$*" == *"tests/localchain/run.py"* ]]; then printf "selected-NEOXP %s\\n" "$NEOXP" >> "$VERIFY_TRACE"; fi\nif [[ -n "$VERIFY_FAIL_MATCH" && "$*" == *"$VERIFY_FAIL_MATCH"* ]]; then exit 41; fi\n';
  for (const command of ['node', 'python3', 'dotnet', 'npm']) {
    fs.writeFileSync(path.join(root, 'commands', command), stub, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(root, 'contracts/compile.sh'), '#!/bin/bash\nprintf "compile-public\\n" >> "$VERIFY_TRACE"\n');
  // This is a command-dispatch fixture, not a checkout of the real dependencies.
  // Start from a small environment instead of inheriting release-mode paths,
  // BASH_ENV or tool configuration from the gate that is running these tests.
  // Report redirections still execute in bash, so ROOT_DIR, HOME and TMPDIR must
  // all resolve inside the fixture even though node/python/dotnet/npm are stubs.
  const result = spawnSync('bash', [path.join(root, 'scripts/verify_repo.sh'), ...args], {
    cwd: root, encoding: 'utf8',
    env: { PATH: `${path.join(root, 'commands')}:${process.env.PATH}`, HOME: root, TMPDIR: root,
      LANG: 'C',
      VERIFY_TRACE: trace, VERIFY_FAIL_MATCH: failMatch,
      NEOOS_NATIVE_EPOCH_RECEIPT: path.join(root, 'native.json'),
      NEOOS_SERVICES_CONTRACT_BUILD: path.join(root, 'missing-services/contracts/build'),
      MORPHEUS_ORACLE_ROOT: path.join(root, 'missing-services'),
      NEOOS_NEOXP: path.join(root, 'published-neoxp'),
      NEOXP: path.join(root, 'published-neoxp'),
      NEOOS_REQUIRE_FORMAL: '0', NEOOS_REQUIRE_NEOEXPRESS: '0', NEOOS_REQUIRE_SERVICES_ARTIFACTS: '0', NEOOS_REQUIRE_COMPLETE: '0',
      ...envOverrides },
  });
  return { ...result, root, reportDir: path.join(root, 'docs/reports'),
    trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '' };
}

test('ordinary is the default and never selects native package or runtime gates', (t) => {
  const result = dispatch(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /node scripts\/check_neo_platform_packages.mjs\n/);
  assert.match(result.trace, /compile-public/);
  assert.match(result.trace, /dotnet test SmartAccount.sln/);
  assert.match(result.trace, /npm run test:ordinary:browser/);
  assert.match(result.trace, /npm run test:operator-recovery:browser/);
  assert.doesNotMatch(result.trace, /--include-native|native_epoch_probe|test_native_|test:native:browser/);
});

test('ordinary success is explicitly PARTIAL when optional gates are NOT RUN', (t) => {
  const result = dispatch(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cross-repo gate: NeoDIDRegistry integration proof NOT RUN/);
  assert.match(result.stdout, /formal gate: NOT RUN/);
  assert.match(result.stdout, /neoexpress gate: NOT RUN/);
  assert.match(result.stdout, /status=PARTIAL; notRun=cross-repo,formal,neoexpress/);
  assert.doesNotMatch(result.stdout, /status=PASS/);
});

test('complete ordinary verification fails closed at the first unavailable gate', (t) => {
  const result = dispatch(t, ['--contracts-only'], '', { NEOOS_REQUIRE_COMPLETE: '1' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /required complete gate unavailable: cross-repo/);
  assert.doesNotMatch(result.trace, /dotnet test smart-account\.sln/);
});

test('ordinary NeoExpress selects public source acceptance and its bounded evidence join', (t) => {
  const result = dispatch(t, ['--profile', 'ordinary', '--contracts-only', '--neoexpress'], '', { NEOOS_NEOXP: '/fixture/published-neoxp' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /check-artifact-reproducibility\.mjs --json/);
  assert.match(result.trace, /python3 tests\/localchain\/run\.py --variant source --source-dir .*contracts\/bin\/v3 --receipt/);
  assert.match(result.trace, /selected-NEOXP \/fixture\/published-neoxp/);
  assert.match(result.trace, /check-ordinary-runtime-provenance\.mjs --repro .* --receipt/);
  assert.doesNotMatch(result.trace, /python3 scripts\/neoexpress_validate\.py|node scripts\/verify-private-artifact-provenance\.mjs/);
  assert.match(result.stdout, /eight deployed modules/);
  assert.match(result.stdout, /unselected PLATFORM matrix: NOT RUN/);
  assert.match(result.stdout, /notRun=cross-repo,formal\./);
});

test('stubbed NeoExpress report redirections stay in the temporary checkout', (t) => {
  const repoReports = new URL('../docs/reports/', import.meta.url);
  const snapshot = () => Object.fromEntries(fs.readdirSync(repoReports).sort().map((name) => {
    const stat = fs.statSync(new URL(name, repoReports));
    return [name, { size: stat.size, mtimeMs: stat.mtimeMs }];
  }));
  const before = snapshot();
  const result = dispatch(t, ['--contracts-only', '--neoexpress']);
  assert.equal(result.status, 0, result.stderr);
  const reports = fs.readdirSync(result.reportDir).sort();
  assert.equal(reports.length, 2, 'only the two shell-redirected stub reports exist');
  assert.match(reports[0], /^aa-artifact-reproducibility-\d{8}\.json$/);
  assert.match(reports[1], /^aa-ordinary-runtime-provenance-\d{8}\.json$/);
  assert.ok(reports.every((name) => fs.statSync(path.join(result.reportDir, name)).size === 0));
  // The trace is the log of what the stubs were invoked with. Git Bash (MSYS) renders
  // the Windows reportDir argument in its POSIX form (/tmp/<fixture>/docs/reports) when
  // the fixture lives under the Windows temp directory, so the assertion anchors on the
  // checkout-unique fixture segment with either separator instead of the drive-prefixed
  // spelling; the snapshot check below is what proves the real reports directory was
  // untouched.
  assert.match(result.trace, /account-verify-dispatch-[^/\\]*[\\/]docs[\\/]reports/);
  assert.deepEqual(snapshot(), before, 'real repository reports must not be created or overwritten');
});

test('source-chain and provenance failures stop before a success status', (t) => {
  for (const command of ['tests/localchain/run.py', 'check-ordinary-runtime-provenance.mjs']) {
    const result = dispatch(t, ['--contracts-only', '--neoexpress'], command);
    assert.equal(result.status, 41);
    assert.doesNotMatch(result.stdout, /status=PASS|status=PARTIAL/);
    if (command === 'tests/localchain/run.py') assert.doesNotMatch(result.trace, /node scripts\/check-ordinary-runtime-provenance/);
  }
});

test('all profile retains public source routing and the runner NEOXP fallback', (t) => {
  const result = dispatch(t, ['--profile', 'all', '--contracts-only', '--neoexpress'], '', {
    NEOOS_NEOXP: '', NEOXP: '/fixture/fallback-neoxp',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /native_epoch_probe.py/);
  assert.match(result.trace, /tests\/localchain\/run.py --variant source/);
  assert.match(result.trace, /selected-NEOXP \/fixture\/fallback-neoxp/);
  assert.doesNotMatch(result.trace, /python3 scripts\/neoexpress_validate.py/);
  assert.doesNotMatch(result.stdout, /notRun=[^\n]*full-module/);
});

test('native contract validation selects its required guards and epoch probe', (t) => {
  const result = dispatch(t, ['--profile', 'native', '--contracts-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /check_neo_platform_packages.mjs --include-native/);
  assert.match(result.trace, /node --test scripts\/implementation_profiles.test.mjs/);
  assert.match(result.trace, /validate-native-smartaccount-profile.py/);
  assert.match(result.trace, /test_native_profile_ci.py/);
  assert.match(result.trace, /native_epoch_probe.py --compiler \/test\/compiler/);
  assert.doesNotMatch(result.trace, /compile-public|dotnet test SmartAccount.sln|npm /);
});

test('all combines both profiles and native probe failure stops the selected gate', (t) => {
  const result = dispatch(t, ['--profile=all', '--contracts-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /compile-public/);
  assert.match(result.trace, /native_epoch_probe.py/);
  const failed = dispatch(t, ['--profile=all', '--contracts-only'], 'native_epoch_probe.py');
  assert.equal(failed.status, 41);
  assert.doesNotMatch(failed.stdout, /completed successfully/);
});

test('ordinary package failure blocks the build and invalid selections fail closed', (t) => {
  const failed = dispatch(t, ['--profile', 'ordinary', '--contracts-only'], 'check_neo_platform_packages.mjs');
  assert.equal(failed.status, 41);
  assert.doesNotMatch(failed.trace, /compile-public|dotnet test/);
  for (const args of [['--profile', 'unknown'], ['--profile'], ['--profile', 'native', '--neoexpress']]) {
    const result = dispatch(t, args);
    assert.notEqual(result.status, 0);
    assert.equal(result.trace, '');
  }
});

test('CI explicitly keeps ordinary and native validation in their respective jobs', () => {
  const ordinary = readWorkflow(new URL('../.github/workflows/ci.yml', import.meta.url));
  const native = readWorkflow(new URL('../.github/workflows/native-profile.yml', import.meta.url));
  assert.match(ordinary, /run: \.\/scripts\/verify_repo.sh --profile ordinary/);
  assert.match(native, /\.\/scripts\/verify_repo.sh --profile native --contracts-only/);
  assert.match(native, /python3 scripts\/native_profile_ci.py/);
  assert.match(native, /'scripts\/verify_repo\*'/);
});


test('frontend profile dispatch preserves native browser checks without a native runtime', (t) => {
  const result = dispatch(t, ['--profile', 'native', '--frontend-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /npm run test:native:browser/);
  assert.doesNotMatch(result.trace, /node scripts|python3 |dotnet |test:e2e:browser:built|test:operator-recovery:browser/);
  const all = dispatch(t, ['--profile', 'all', '--frontend-only']);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.trace, /npm run test:e2e:browser:built/);
  assert.equal((all.trace.match(/npm run test:native:browser/g) || []).length, 1);
});

test('every pull request retains an independent native browser gate without repeating the frontend suite', () => {
  const ci = readWorkflow(new URL('../.github/workflows/ci.yml', import.meta.url));
  const triggers = ci.slice(ci.indexOf('on:'), ci.indexOf('permissions:'));
  assert.match(triggers, /\n  push:/);
  assert.match(triggers, /\n  pull_request:/);
  assert.doesNotMatch(triggers, /\bpaths(?:-ignore)?:/, 'native UI, shared, SDK and frontend test changes must all trigger this gate');
  const browser = /- name: Verify native account browser fixtures\n        working-directory: frontend\n        run: npm run test:native:browser/;
  assert.match(ci, browser);
  const at = ci.search(browser);
  assert.ok(ci.indexOf('run: npm run test:e2e:install') < at);
  assert.ok(at < ci.indexOf('run: ./scripts/verify_repo.sh --profile ordinary'), 'browser fixtures do not depend on the contract/runtime gate completing');
  assert.equal((ci.match(/run: npm run test:native:browser/g) || []).length, 1);
  assert.equal((ci.match(/run: \.\/scripts\/verify_repo.sh/g) || []).length, 1, 'reuse the ordinary frontend unit and build checks');
});

test('native VM workflow triggers every native source family', () => {
  const workflow = readWorkflow(new URL('../.github/workflows/native-profile.yml', import.meta.url));
  const triggers = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('workflow_dispatch:'));
  for (const pattern of [
    'implementations/native/**',
    'shared/native*.mjs',
    'frontend/src/features/native/**',
    'frontend/src/shared/native*.mjs',
    'frontend/tests/native*',
    'frontend/tests/fixtures/native*',
    'sdk/js/src/native/**',
    'sdk/js/src/native*',
    'sdk/js/tests/native*',
    'sdk/js/tests/fixtures/native-*',
  ]) {
    const exactPathEntries = triggers.split('\n').filter((line) => line.trim() === `- '${pattern}'`);
    assert.equal(exactPathEntries.length, 2,
      `${pattern} must trigger both push and pull_request`);
  }
});
