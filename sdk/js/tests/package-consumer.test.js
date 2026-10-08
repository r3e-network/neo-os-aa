const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const sdkRoot = path.resolve(__dirname, '..');

function run(command, args, cwd) {
  const env = { ...process.env };
  // A consumer must not find SDK dependencies through the developer's shell.
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function npm(args, cwd) {
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], cwd)
    : run('npm', args, cwd);
}

async function filesBelow(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `no package symlinks: ${file}`);
    if (entry.isDirectory()) files.push(...await filesBelow(file));
    else files.push(file);
  }
  return files.sort();
}

test('the real npm tarball is a self-contained, reproducible production package', { timeout: 300_000 }, async (t) => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neo-aa-package-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const packDirectory = path.join(temporary, 'pack');
  const consumer = path.join(temporary, 'consumer');
  await fs.mkdir(packDirectory);
  await fs.mkdir(consumer);

  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', packDirectory], sdkRoot));
  const tarball = path.join(packDirectory, packed.filename);
  const firstBytes = await fs.readFile(tarball);
  await fs.mkdir(path.join(sdkRoot, 'dist'), { recursive: true });
  await fs.writeFile(path.join(sdkRoot, 'dist', 'obsolete-package-output.js'), 'throw new Error("stale output");\n');
  const [repacked] = JSON.parse(npm(['pack', '--json', '--pack-destination', packDirectory], sdkRoot));
  assert.equal(repacked.integrity, packed.integrity);
  assert.deepEqual(await fs.readFile(tarball), firstBytes, 'repeated prepack produces identical bytes');
  await assert.rejects(fs.access(path.join(sdkRoot, 'dist', 'obsolete-package-output.js')), { code: 'ENOENT' });

  await fs.writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'sdk-consumer', private: true }));
  npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer);

  await t.test('CommonJS and ESM consumers execute the shared runtime graph without workspace access', () => {
    const exportedNames = JSON.parse(run(process.execPath, ['--input-type=commonjs', '-e', `
      const assert = require('node:assert/strict');
      const sdk = require('neo-abstract-account');
      const client = new sdk.AbstractAccountClient('http://127.0.0.1:9', '11'.repeat(20));
      const accountId = client.deriveRegistrationAccountIdHash({ backupOwnerAddress: '22'.repeat(20) });
      assert.match(accountId, /^[0-9a-f]{40}$/);
      assert.equal(client.deriveVirtualAccount(accountId).accountIdHash, accountId);
      const data = sdk.buildV3UserOperationTypedData({
        chainId: 894710606, verifyingContract: '33'.repeat(20), accountIdHash: accountId,
        coreContractHash: '11'.repeat(20), targetContract: '44'.repeat(20),
        method: 'balanceOf', argsHashHex: '55'.repeat(32), nonce: 0, deadline: 2000000000000,
      });
      assert.equal(data.message.nonce, '0');
      assert.deepEqual(sdk.findFailedTransferInInvocation({
        invocation: { operation: 'executeUnified', args: [{}, {}, { type: 'String', value: 'transfer' }] },
        stack: [{ type: 'Boolean', value: false }],
      }), [0]);
      assert.equal(typeof sdk.simulateUserOperation, 'function');
      const native = new sdk.NativeSmartAccountClient({rpcUrl:'http://127.0.0.1:9',networkMagic:12345});
      assert.equal(sdk.NATIVE_ABI_VERSION,2);
      assert.equal(native.deriveIdentity({custodyAddress:'22'.repeat(20),salt:'33'.repeat(32)}).accountId.length,40);
      assert.equal(sdk.nativeCodec.composeNonce(3n,5n),(3n<<64n)|5n);
      for (const [key, value] of Object.entries(sdk)) assert.notEqual(value, undefined, key);
      process.stdout.write(JSON.stringify(Object.keys(sdk).sort()));
    `], consumer));
    assert.deepEqual(exportedNames, Object.keys(require('../src/index')).sort(), 'every source export reaches consumers');
    run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import sdk from 'neo-abstract-account';
      import * as namedExports from 'neo-abstract-account';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      assert.deepEqual(Object.keys(sdk).sort(), Object.keys(require('neo-abstract-account')).sort());
      assert.equal(typeof sdk.AbstractAccountClient, 'function');
      for (const key of Object.keys(sdk)) assert.equal(namedExports[key], sdk[key], key);
    `], consumer);
  });

  const packageRoot = path.join(consumer, 'node_modules', packed.name);
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  await t.test('all exported paths and relative module imports stay inside the installed package', async () => {
    const inside = (file) => {
      const relative = path.relative(packageRoot, file);
      assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), file);
    };
    for (const [entry, conditions] of Object.entries(manifest.exports)) {
      const specifier = entry === '.' ? packed.name : `${packed.name}/${entry.slice(2)}`;
      run(process.execPath, ['-e', `require(${JSON.stringify(specifier)})`], consumer);
      run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)})`], consumer);
      for (const file of Object.values(conditions)) {
        inside(path.resolve(packageRoot, file));
        await fs.access(path.resolve(packageRoot, file));
      }
    }
    const files = await filesBelow(packageRoot);
    for (const [sourceRoot, installedRoot] of [
      [path.join(sdkRoot, 'src'), path.join(packageRoot, 'dist/sdk/js/src')],
      [path.resolve(sdkRoot, '../../shared'), path.join(packageRoot, 'dist/shared')],
    ]) {
      for (const sourceFile of await filesBelow(sourceRoot)) {
        if (!/\.(?:js|mjs|d\.ts)$/.test(sourceFile)) continue;
        assert.deepEqual(
          await fs.readFile(path.join(installedRoot, path.relative(sourceRoot, sourceFile))),
          await fs.readFile(sourceFile),
          `canonical source bytes preserved: ${sourceFile}`,
        );
      }
    }
    for (const file of files) {
      if (!/\.(?:js|mjs|cjs)$/.test(file)) continue;
      const source = await fs.readFile(file, 'utf8');
      const requires = [...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
      const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)];
      for (const [, specifier] of [...requires, ...imports]) {
        if (!specifier.startsWith('.')) continue;
        const resolved = createRequire(file).resolve(specifier);
        inside(resolved);
        await fs.access(resolved);
      }
    }
    for (const forbidden of ['@cityofzion/neon-js', 'typescript']) {
      await assert.rejects(fs.access(path.join(consumer, 'node_modules', forbidden)), { code: 'ENOENT' });
    }
    for (const file of packed.files) {
      assert.ok(!/(^|\/)(?:node_modules|tests|contracts|reports|\.env[^/]*)(\/|$)/.test(file.path), file.path);
    }
  });

  await t.test('TypeScript resolves shipped declarations with no repository path aliases', async () => {
    await fs.copyFile(path.join(__dirname, 'types', 'consumer.ts'), path.join(consumer, 'consumer.cts'));
    await fs.copyFile(path.join(__dirname, 'types', 'consumer.ts'), path.join(consumer, 'consumer.mts'));
    await fs.writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2020', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
        noEmit: true, skipLibCheck: false, types: [],
      },
      files: ['consumer.cts', 'consumer.mts'],
    }));
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.json'], consumer);
  });
});
