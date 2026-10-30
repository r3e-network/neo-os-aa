const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveLocalPaymasterHandlerPath } = require('./local-paymaster-handler');

test('resolveLocalPaymasterHandlerPath honors an explicit handler path', () => {
  assert.equal(
    resolveLocalPaymasterHandlerPath({ MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH: ' /tmp/worker.js ' }),
    '/tmp/worker.js',
  );
});

test('resolveLocalPaymasterHandlerPath discovers the sibling Morpheus worker when present', () => {
  const repoRoot = '/workspace/smart-account';
  const expected = path.resolve(
    repoRoot,
    '..',
    'neo-morpheus-oracle',
    'workers',
    'phala-worker',
    'src',
    'worker.js',
  );

  assert.equal(resolveLocalPaymasterHandlerPath({}, repoRoot, (candidate) => candidate === expected), expected);
});

test('resolveLocalPaymasterHandlerPath returns empty when no local worker exists', () => {
  assert.equal(resolveLocalPaymasterHandlerPath({}, '/workspace/smart-account', () => false), '');
});
