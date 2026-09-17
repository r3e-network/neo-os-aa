import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));

test('all UUID consumers resolve to the reviewed patched CJS/ESM-compatible version', () => {
  assert.equal(pkg.overrides.uuid, '11.1.1');
  const entries = Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/uuid'));
  assert.ok(entries.length > 0);
  for (const [name, value] of entries) assert.equal(value.version, '11.1.1', name);
});

test('UUID APIs used by upstream consumers remain available in CJS and ESM', async () => {
  for (const uuid of [require('uuid'), await import('uuid')]) {
    const id = uuid.v4();
    assert.ok(uuid.validate(id));
    assert.equal(uuid.version(id), 4);
    assert.equal(uuid.stringify(uuid.parse(id)), id);
  }
});
