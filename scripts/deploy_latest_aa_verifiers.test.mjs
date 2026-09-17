import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  NETWORKS,
  MODULES,
  loadArtifact,
  parseArgs,
  stackBoolean,
  stackString,
} = require('./deploy_latest_aa_verifiers.js');
const { stackHash160 } = require('./lib/deploy-helpers.js');

test('latest verifier deployment is pinned to exact Neo network magic and core', () => {
  assert.equal(NETWORKS.testnet.magic, 894710606);
  assert.equal(NETWORKS.mainnet.magic, 860833102);
  assert.match(NETWORKS.testnet.coreHash, /^0x[0-9a-f]{40}$/);
  assert.match(NETWORKS.mainnet.coreHash, /^0x[0-9a-f]{40}$/);
  assert.notEqual(NETWORKS.testnet.coreHash, NETWORKS.mainnet.coreHash);
});

test('only the latest session and recovery artifacts can be selected', () => {
  assert.deepEqual(parseArgs(['--network=testnet']).requested, ['session', 'recovery']);
  assert.throws(() => parseArgs(['--network=mainnet', '--modules=legacy']), /Only/);
  for (const config of Object.values(MODULES)) {
    const artifact = loadArtifact(config);
    assert.equal(artifact.manifestJson.name, config.artifact);
    assert.ok(artifact.methods.includes('supportsV3'));
    assert.ok(artifact.methods.includes('authorizedCore'));
  }
});

test('Neo VM stack decoders preserve typed values', () => {
  const littleEndian = Buffer.from('f2b6c5c0222370ad7ee1a5f76b1817217b8ef3db', 'hex').toString('base64');
  assert.equal(stackHash160({ type: 'ByteString', value: littleEndian }), '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2');
  assert.equal(stackBoolean({ type: 'Boolean', value: true }), true);
  assert.equal(stackString({ type: 'ByteString', value: Buffer.from('2.0.0').toString('base64') }), '2.0.0');
});
