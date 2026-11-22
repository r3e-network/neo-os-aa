import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('matrix domain helpers remain available while the V3 workspace rejects legacy reverse discovery', () => {
  const servicePath = path.resolve(root, 'src/services/matrixDomainService.js');
  assert.equal(fs.existsSync(servicePath), true, 'expected matrixDomainService to exist');
  const serviceSource = fs.readFileSync(servicePath, 'utf8');
  assert.match(serviceSource, /\.matrix/);
  assert.match(serviceSource, /resolveMatrixDomain/);

  const loadPanel = read('src/features/operations/components/LoadAccountPanel.vue');
  assert.match(loadPanel, /\.matrix/);

  const workspace = read('src/features/operations/components/HomeOperationsWorkspace.vue');
  assert.match(workspace, /\.matrix domain/);
  assert.match(workspace, /cannot be discovered/);
});
