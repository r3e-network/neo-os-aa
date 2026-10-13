const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function buildFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-aa-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'sdk/js');
  await fs.mkdir(path.join(sdk, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(sdk, 'src/nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'shared'));
  await fs.copyFile(path.join(__dirname, '../scripts/build-package.mjs'), path.join(sdk, 'scripts/build-package.mjs'));
  await fs.writeFile(path.join(root, 'LICENSE'), 'license fixture');
  await fs.writeFile(path.join(sdk, 'src/nested/module.js'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(sdk, 'src/index.js'), "module.exports = { value: require('./nested/module') };\n");
  await fs.writeFile(path.join(sdk, 'src/index.d.ts'), 'export declare const value: number;\n');
  await fs.writeFile(path.join(root, 'shared/core.mjs'), 'export const value = 1;\n');
  const run = () => spawnSync(process.execPath, [path.join(sdk, 'scripts/build-package.mjs')], {
    cwd: os.tmpdir(), encoding: 'utf8', timeout: 10_000,
  });
  return { root, sdk, run };
}

test('package build copies module bytes from any cwd and excludes non-module files', async (t) => {
  const { sdk, run } = await buildFixture(t);
  await fs.writeFile(path.join(sdk, 'src/.env'), 'not for publication');
  await fs.writeFile(path.join(sdk, 'src/nested/report.json'), '{}');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(sdk, 'dist/sdk/js/src/nested/module.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(await fs.readFile(path.join(sdk, 'dist/sdk/js/src/index.d.ts'), 'utf8'), 'export declare const value: number;\n');
  assert.equal(await fs.readFile(path.join(sdk, 'dist/shared/core.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(await fs.readFile(path.join(sdk, 'dist/LICENSE'), 'utf8'), 'license fixture');
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { value } from ${JSON.stringify(require('node:url').pathToFileURL(path.join(sdk, 'dist/index.mjs')).href)};
    if (value !== 1) throw new Error('incorrect ESM export');
  `], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  await assert.rejects(fs.access(path.join(sdk, 'dist/sdk/js/src/.env')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(sdk, 'dist/sdk/js/src/nested/report.json')), { code: 'ENOENT' });
});

test('package build fails when canonical shared sources are absent', async (t) => {
  const { root, run } = await buildFixture(t);
  await fs.rm(path.join(root, 'shared'), { recursive: true });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
});

for (const target of ['module', 'directory']) {
  test(`package build refuses a symbolic-link source ${target}`, async (t) => {
    const { root, sdk, run } = await buildFixture(t);
    if (target === 'module') {
      await fs.symlink(path.join(root, 'LICENSE'), path.join(sdk, 'src/external.js'));
    } else {
      await fs.rename(path.join(root, 'shared'), path.join(root, 'external'));
      await fs.symlink(path.join(root, 'external'), path.join(root, 'shared'), 'dir');
    }
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symbolic link/);
  });
}
