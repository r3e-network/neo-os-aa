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
  // The native build/test gate needs a pinned core checkout. Point it at a fixture one so the
  // dispatch is exercised without a real Neo build; a test that wants the NOT RUN path overrides
  // NEOOS_NATIVE_CORE_SOURCE with a directory that does not exist.
  const nativeCore = path.join(root, 'native-core');
  fs.mkdirSync(path.join(nativeCore, 'src/Neo'), { recursive: true });
  fs.mkdirSync(path.join(nativeCore, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(nativeCore, 'src/Neo/Neo.csproj'), '<Project />\n');
  fs.writeFileSync(path.join(nativeCore, 'tests/AssemblyInfo.cs'), '\n');
  fs.copyFileSync(new URL('./verify_repo.sh', import.meta.url), path.join(root, 'scripts/verify_repo.sh'));
  fs.writeFileSync(path.join(root, 'scripts/dotnet_env.sh'), 'export NCCS_BIN=nccs\n');
  const stub = '#!/bin/bash\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$VERIFY_TRACE"\nif [[ "$*" == *"tests/localchain/run.py"* ]]; then printf "selected-NEOXP %s\\n" "$NEOXP" >> "$VERIFY_TRACE"; fi\nif [[ -n "$VERIFY_FAIL_MATCH" && "$*" == *"$VERIFY_FAIL_MATCH"* ]]; then exit 41; fi\n';
  for (const command of ['node', 'python3', 'dotnet', 'npm', 'nccs']) {
    fs.writeFileSync(path.join(root, 'commands', command), stub, { mode: 0o755 });
  }
  const trace = path.join(root, 'commands.log');
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
      NEOOS_NATIVE_CORE_SOURCE: nativeCore,
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

test('native is the default and never selects the retired custom gates', (t) => {
  const result = dispatch(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /node scripts\/check_neo_platform_packages.mjs\n/);
  assert.doesNotMatch(result.trace, /--include-custom/);
  assert.match(result.trace, /dotnet build SmartAccount\.sln -c Release/);
  assert.match(result.trace, /dotnet test tests\/SmartAccount\.Native\.Tests\/SmartAccount\.Tests\.csproj/);
  assert.match(result.trace, /native_epoch_probe\.py --compiler nccs/);
  assert.match(result.trace, /npm run test:native:browser/);
  assert.doesNotMatch(result.trace, /compile-public|contracts\/custom|test:custom:browser|test:operator-recovery:browser/);
});

test('native success is explicitly PARTIAL when optional gates are NOT RUN', (t) => {
  const result = dispatch(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /formal gate: NOT RUN/);
  assert.doesNotMatch(result.stdout, /neoexpress/);
  assert.match(result.stdout, /status=PARTIAL; notRun=formal/);
  assert.doesNotMatch(result.stdout, /status=PASS/);
});

test('a missing pinned core checkout reports the native build gate NOT RUN instead of passing', (t) => {
  const missing = path.join(os.tmpdir(), 'account-verify-missing-native-core');
  const result = dispatch(t, ['--contracts-only'], '', { NEOOS_NATIVE_CORE_SOURCE: missing });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native build gate: NOT RUN/);
  assert.doesNotMatch(result.trace, /dotnet build SmartAccount\.sln|dotnet test tests\/SmartAccount\.Native\.Tests/);
  assert.match(result.stdout, /notRun=native-build/);
});

test('complete verification fails closed at the first unavailable native gate', (t) => {
  const missing = path.join(os.tmpdir(), 'account-verify-missing-native-core');
  const result = dispatch(t, ['--contracts-only'], '', {
    NEOOS_REQUIRE_COMPLETE: '1', NEOOS_NATIVE_CORE_SOURCE: missing,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /required complete gate unavailable: native-build/);
  assert.doesNotMatch(result.trace, /dotnet build SmartAccount\.sln/);
});

test('native contract validation selects its required guards, native build and epoch probe', (t) => {
  const result = dispatch(t, ['--profile', 'native', '--contracts-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /node scripts\/check_neo_platform_packages\.mjs\n/);
  assert.doesNotMatch(result.trace, /--include-custom/);
  assert.match(result.trace, /node --test scripts\/implementation_profiles\.test\.mjs/);
  assert.match(result.trace, /dotnet build SmartAccount\.sln -c Release/);
  assert.match(result.trace, /dotnet test tests\/SmartAccount\.Native\.Tests\/SmartAccount\.Tests\.csproj/);
  assert.deepEqual(result.trace.split('\n').filter(line => line.startsWith('nccs ')).map(line => line.split(' ')[1]), [
    'contracts/modules/GovernanceModule/GovernanceModule.csproj', 'contracts/modules/RecoveryModule/RecoveryModule.csproj',
    'contracts/plugins/native-profile/WhitelistHook.Native.csproj',
  ]);
  assert.match(result.trace, /node scripts\/check_standard_recovery_nef\.mjs .*RecoveryModule\.nef/);
  assert.match(result.trace, /validate-native-smartaccount-profile\.py/);
  assert.match(result.trace, /test_native_\*\.py/);
  assert.match(result.trace, /native_epoch_probe\.py --compiler nccs/);
  assert.doesNotMatch(result.trace, /compile-public|tests\/SmartAccount\.Contracts\.Tests|npm /);
});

test('a gate failure blocks the native build and invalid selections fail closed', (t) => {
  const failed = dispatch(t, ['--contracts-only'], 'check_neo_platform_packages.mjs');
  assert.equal(failed.status, 41);
  assert.doesNotMatch(failed.trace, /dotnet build|dotnet test/);
  for (const args of [['--profile', 'custom'], ['--profile', 'all'], ['--profile', 'unknown'], ['--profile'], ['--neoexpress']]) {
    const result = dispatch(t, args);
    assert.notEqual(result.status, 0);
    assert.equal(result.trace, '');
  }
});

test('CI runs the native acceptance gate and the native VM workflow still owns the pinned core', () => {
  const ci = readWorkflow(new URL('../.github/workflows/ci.yml', import.meta.url));
  const native = readWorkflow(new URL('../.github/workflows/native-profile.yml', import.meta.url));
  assert.match(ci, /run: \.\/scripts\/verify_repo\.sh --profile native/);
  assert.doesNotMatch(ci, /--profile custom/, 'the retired custom profile is never a CI acceptance path');
  assert.match(native, /\.\/scripts\/verify_repo\.sh --profile native --contracts-only/);
  assert.match(native, /python3 scripts\/native_profile_ci\.py/);
  assert.match(native, /'scripts\/verify_repo\*'/);
});


test('frontend-only dispatch keeps the native browser checks without a native runtime', (t) => {
  const result = dispatch(t, ['--profile', 'native', '--frontend-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /npm run test:native:browser/);
  assert.doesNotMatch(result.trace, /node scripts|python3 |dotnet |test:e2e:browser:built|test:operator-recovery:browser/);
  assert.doesNotMatch(result.stdout, /=== Contract Gates ===/);
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
  assert.ok(at < ci.indexOf('run: ./scripts/verify_repo.sh --profile native'), 'browser fixtures do not depend on the contract/runtime gate completing');
  assert.equal((ci.match(/run: npm run test:native:browser/g) || []).length, 1);
  assert.equal((ci.match(/run: \.\/scripts\/verify_repo.sh/g) || []).length, 1, 'one acceptance entrypoint, the native profile');
});

test('native VM workflow triggers every native source family', () => {
  const workflow = readWorkflow(new URL('../.github/workflows/native-profile.yml', import.meta.url));
  const triggers = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('workflow_dispatch:'));
  for (const pattern of [
    'contracts/native/**',
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
