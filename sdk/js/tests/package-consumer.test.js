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
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neo-sa-package-')));
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
      const sdk = require('@r3e-network/neo-smart-account');
      const client = new sdk.NativeSmartAccountClient({ rpcUrl: 'http://127.0.0.1:9', networkMagic: 894710606, contractHash: '11'.repeat(20) });
      const identity = client.deriveIdentity({ custodyAddress: '22'.repeat(20), salt: '33'.repeat(32) });
      assert.match(identity.accountId, /^[0-9a-f]{40}$/);
      assert.equal(client.proxyAddress(identity.accountId).length, 40);
      // A v4 registration is a plan the same client prepares and signs.
      const registration = client.buildCreateAccountScript({ custodyAddress: '22'.repeat(20), salt: '33'.repeat(32), recoveryTimelockMs: 604800000 });
      assert.equal(registration.kind, 'registration');
      assert.equal(client.prepare(registration), registration);
      const operation = {
        targetContract: '44'.repeat(20), method: 'transfer', args: [], nonce: '1',
        nonceSubkey: '00'.repeat(32), deadline: '2000000000000', validatorId: '0',
        credentialGeneration: '1', authorityEpoch: '0', configurationNonce: '0', signature: 'ab'.repeat(64),
      };
      const plan = client.buildExecutionScript({ accountId: identity.accountId, operation });
      assert.equal(plan.method, 'executeUserOp');
      assert.equal(plan.operation.targetContract, '44'.repeat(20));
      // The 13-field operation is the operand the transfer rules read back.
      assert.deepEqual(sdk.findFailedTransferInInvocation({
        invocation: { operation: 'executeUserOp', args: [{ type: 'ByteString', value: 'aa'.repeat(20) }, sdk.codec.operationValue(operation)] },
        stack: [{ type: 'Boolean', value: false }],
      }), [0]);
      assert.equal(typeof sdk.simulateUserOperation, 'function');
      const native = new sdk.NativeSmartAccountClient({rpcUrl:'http://127.0.0.1:9',networkMagic:12345});
      assert.equal(sdk.NATIVE_ABI_VERSION,4);
      assert.equal(native.deriveIdentity({custodyAddress:'22'.repeat(20),salt:'33'.repeat(32)}).accountId.length,40);
      assert.equal(sdk.nativeCodec.composeNonce(3n,5n),(3n<<64n)|5n);
      for (const [key, value] of Object.entries(sdk)) assert.notEqual(value, undefined, key);
      process.stdout.write(JSON.stringify(Object.keys(sdk).sort()));
    `], consumer));
    assert.deepEqual(exportedNames, Object.keys(require('../src/index')).sort(), 'every source export reaches consumers');
    run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import sdk from '@r3e-network/neo-smart-account';
      import * as namedExports from '@r3e-network/neo-smart-account';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      assert.deepEqual(Object.keys(sdk).sort(), Object.keys(require('@r3e-network/neo-smart-account')).sort());
      assert.equal(typeof sdk.NativeSmartAccountClient, 'function');
      for (const key of Object.keys(sdk)) assert.equal(namedExports[key], sdk[key], key);
    `], consumer);
  });

  await t.test('installed package builds v4 plans, session-key commands and member digests offline', () => {
    run(process.execPath, ['--input-type=commonjs', '-e', `
      const assert = require('node:assert/strict');
      const { NativeSmartAccountClient, codec, thresholdTools, buildSessionKeyInstallCommand } = require('@r3e-network/neo-smart-account');
      const client = new NativeSmartAccountClient({ rpcUrl: 'http://127.0.0.1:9', networkMagic: 894710606, contractHash: '11'.repeat(20) });
      const accountId = '22'.repeat(20);
      const operation = {
        targetContract: '44'.repeat(20), method: 'transfer', args: [], nonce: '1',
        nonceSubkey: '00'.repeat(32), deadline: '2000000000000', validatorId: '0',
        credentialGeneration: '1', authorityEpoch: '0', configurationNonce: '0', signature: 'ab'.repeat(64),
      };
      // The operation digest is the §4.3 preimage hashed: stable, and 32 bytes.
      const context = { networkMagic: 894710606, coreContractHash: '11'.repeat(20), accountId };
      const digest = codec.operationDigest(context, operation);
      assert.match(digest, /^[0-9a-f]{64}$/);
      assert.equal(digest, codec.operationDigest(context, operation));
      assert.equal(thresholdTools.memberDigest(digest, '1', '1').length, 64);
      // A session-key command is operation operands, not a registration blob.
      const command = buildSessionKeyInstallCommand({ publicKeyHex: '02' + '22'.repeat(32), targetContract: '33'.repeat(20), method: 'transfer', validUntilMs: '1900000000000', spendingLimitDatoshi: '1000' });
      assert.equal(command.length, 7);
      for (const entry of command) assert.ok(['ByteString', 'Integer'].includes(entry.type), entry.type);
      const step = { method: 'installModule', moduleType: 1, moduleContractHash: '33'.repeat(20),
        profileDigest: '55'.repeat(32), initData: command };
      const script = client.buildConfigurationBatchScript({ accountId, actions: [step] });
      const expected = codec.dynamicCall(context.coreContractHash, 'applyConfigurationActions', [
        codec.hashValue(accountId), { type: 'Array', value: [{ type: 'Array', value: [
          codec.integerValue(1), codec.integerValue(1), codec.hashValue(step.moduleContractHash),
          codec.byteStringValue(step.profileDigest), { type: 'Array', value: command }
        ] }] }
      ]);
      assert.equal(script, expected);
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
    const typescriptManifestPath = require.resolve('typescript/package.json');
    const typescriptManifest = JSON.parse(await fs.readFile(typescriptManifestPath, 'utf8'));
    const tsc = path.resolve(path.dirname(typescriptManifestPath), typescriptManifest.bin.tsc);
    run(process.execPath, [tsc, '--project', 'tsconfig.json'], consumer);
  });
});
