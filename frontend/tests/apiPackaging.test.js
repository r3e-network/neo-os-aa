import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const frontendRoot = fileURLToPath(new URL('..', import.meta.url));

test('frontend-only APIs load and relay with declared production dependencies', { timeout: 30_000 }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aa-frontend-api-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const isolated = path.join(temporary, 'frontend');
  await fs.mkdir(isolated);
  for (const entry of ['api', 'src', 'package.json']) {
    await fs.cp(path.join(frontendRoot, entry), path.join(isolated, entry), { recursive: true });
  }
  const manifest = JSON.parse(await fs.readFile(path.join(isolated, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies)) {
    const target = path.join(isolated, 'node_modules', dependency);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Only declared production dependencies are visible to copied application
    // code; no NODE_PATH, sibling SDK checkout or dev-only root links exist.
    await fs.symlink(path.join(frontendRoot, 'node_modules', dependency), target, 'dir');
  }
  await fs.copyFile(new URL('./fixtures/frontendOnlyApiProbe.mjs', import.meta.url), path.join(isolated, 'probe.mjs'));
  const result = spawnSync(process.execPath, ['probe.mjs'], {
    cwd: isolated, env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
