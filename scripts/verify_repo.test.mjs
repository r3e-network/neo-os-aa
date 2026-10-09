import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function dispatch(t, args = [], failMatch = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-verify-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'contracts', 'frontend', 'sdk/js', 'commands']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.copyFileSync(new URL('./verify_repo.sh', import.meta.url), path.join(root, 'scripts/verify_repo.sh'));
  fs.writeFileSync(path.join(root, 'scripts/dotnet_env.sh'), 'export NCCS_BIN=/test/compiler\n');
  const trace = path.join(root, 'commands.log');
  const stub = '#!/bin/bash\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$VERIFY_TRACE"\nif [[ -n "$VERIFY_FAIL_MATCH" && "$*" == *"$VERIFY_FAIL_MATCH"* ]]; then exit 41; fi\n';
  for (const command of ['node', 'python3', 'dotnet', 'npm']) {
    fs.writeFileSync(path.join(root, 'commands', command), stub, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(root, 'contracts/compile.sh'), '#!/bin/bash\nprintf "compile-public\\n" >> "$VERIFY_TRACE"\n');
  const result = spawnSync('bash', [path.join(root, 'scripts/verify_repo.sh'), ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(root, 'commands')}:${process.env.PATH}`,
      VERIFY_TRACE: trace, VERIFY_FAIL_MATCH: failMatch,
      NEOOS_NATIVE_EPOCH_RECEIPT: path.join(root, 'native.json'),
      NEOOS_REQUIRE_FORMAL: '0', NEOOS_REQUIRE_NEOEXPRESS: '0', NEOOS_REQUIRE_SERVICES_ARTIFACTS: '0' },
  });
  return { ...result, trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '' };
}

test('ordinary is the default and never selects native package or runtime gates', (t) => {
  const result = dispatch(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /node scripts\/check_neo_platform_packages.mjs\n/);
  assert.match(result.trace, /compile-public/);
  assert.match(result.trace, /dotnet test neo-abstract-account.sln/);
  assert.match(result.trace, /npm run test:ordinary:browser/);
  assert.match(result.trace, /npm run test:operator-recovery:browser/);
  assert.doesNotMatch(result.trace, /--include-native|native_epoch_probe|test_native_|test:native:browser/);
});

test('native contract validation selects its required guards and epoch probe', (t) => {
  const result = dispatch(t, ['--profile', 'native', '--contracts-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /check_neo_platform_packages.mjs --include-native/);
  assert.match(result.trace, /validate-native-smartaccount-profile.py/);
  assert.match(result.trace, /test_native_profile_ci.py/);
  assert.match(result.trace, /native_epoch_probe.py --compiler \/test\/compiler/);
  assert.doesNotMatch(result.trace, /compile-public|dotnet test neo-abstract-account.sln|npm /);
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
  const ordinary = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const native = fs.readFileSync(new URL('../.github/workflows/native-profile.yml', import.meta.url), 'utf8');
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
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
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
