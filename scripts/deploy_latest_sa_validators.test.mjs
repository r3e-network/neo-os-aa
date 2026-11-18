import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  NETWORKS,
  MODULES,
  loadArtifact,
  assertArtifactParity,
  assertModuleProfile,
  parseArgs,
  stackBoolean,
  stackString,
} = require('./deploy_latest_sa_validators.js');
const { stackHash160, artifactPaths } = require('./lib/deploy-helpers.js');

test('latest validator deployment is pinned to exact Neo network magic and core', () => {
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
    assert.ok(artifact.methods.includes('authorizedCore'));
    if (config.moduleType) {
      assert.ok(artifact.methods.includes('getModuleProfile'));
      assert.ok(artifact.methods.includes('validateUserOp'));
      assert.ok(artifact.methods.includes('onUserOpComplete'));
    }
  }
});

test('Neo VM stack decoders preserve typed values', () => {
  const littleEndian = Buffer.from('f2b6c5c0222370ad7ee1a5f76b1817217b8ef3db', 'hex').toString('base64');
  assert.equal(stackHash160({ type: 'ByteString', value: littleEndian }), '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2');
  assert.equal(stackBoolean({ type: 'Boolean', value: true }), true);
  assert.equal(stackString({ type: 'ByteString', value: Buffer.from('2.0.0').toString('base64') }), '2.0.0');
});

test('validator release loads the current public build instead of historical fixtures', () => {
  for (const [moduleName, publicName] of [['session', 'validators/SessionKeyValidator'], ['recovery', 'ActionSessionValidator']]) {
    const artifact = loadArtifact(MODULES[moduleName]);
    const paths = artifactPaths(publicName);
    assert.ok(Buffer.from(artifact.nef.serialize(), 'hex').equals(fs.readFileSync(paths.nef)), `${moduleName} NEF must be the current public build`);
    assert.deepEqual(artifact.manifestJson, JSON.parse(fs.readFileSync(paths.manifest, 'utf8')));
  }
});

test('recovery service manifest, runtime version and deployment selector agree', () => {
  const source = fs.readFileSync(
    'contracts/plugins/recovery/SocialRecoveryService.Fixed.cs',
    'utf8',
  );
  const manifestVersion = source.match(/ManifestExtra\("Version", "([^"]+)"\)/)?.[1];
  const runtimeVersion = source.match(/Version\(\)\s*=>\s*"([^"]+)"/)?.[1];
  const artifact = loadArtifact(MODULES.service);
  assert.equal(manifestVersion, runtimeVersion);
  assert.equal(artifact.manifestJson.extra.Version, manifestVersion);
  assert.equal(MODULES.service.version, manifestVersion);
});

test('a missing public validator fails instead of falling back to tracked historical bytes', (t) => {
  const missing = artifactPaths('validators/SessionKeyValidator').nef;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === missing) throw Object.assign(new Error('reviewed public artifact missing'), { code: 'ENOENT' });
    return read(file, ...args);
  });
  assert.throws(() => loadArtifact(MODULES.session), /reviewed public artifact missing/);
});

test('validator release rejects private profile paths and a mismatched manifest', (t) => {
  assert.throws(() => loadArtifact({ ...MODULES.session, publicArtifact: '../platform/SessionKeyValidator' }), /public artifact name/);
  const selected = artifactPaths('validators/SessionKeyValidator').manifest;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const result = read(file, ...args);
    return file === selected ? JSON.stringify({ ...JSON.parse(result), name: 'DifferentValidator' }) : result;
  });
  assert.throws(() => loadArtifact(MODULES.session), /manifest name mismatch/);
});

test('readback requires exact script and complete manifest, not checksum or method names alone', () => {
  const artifact = loadArtifact(MODULES.session);
  const state = { nef: { checksum: artifact.nef.checksum, script: Buffer.from(artifact.nef.script, 'hex').toString('base64') }, manifest: structuredClone(artifact.manifestJson) };
  assert.doesNotThrow(() => assertArtifactParity(state, artifact));
  assert.throws(() => assertArtifactParity({ ...state, nef: { ...state.nef, script: Buffer.from('changed').toString('base64') } }, artifact), /script.*match/);
  assert.throws(() => assertArtifactParity({ ...state, manifest: { ...state.manifest, permissions: [] } }, artifact), /manifest.*match/);
});

test('module profile readback enforces the canonical v4 bytes', () => {
  const canonical = '{"callbacks":["validateUserOp","onUserOpComplete"],"capabilities":{"compositeLayer":0,"instanceIsolation":false,"messageCapability":false,"thresholdMemberEligible":false},"contractName":"SessionKeyValidator","lifecycle":["onInstall","onUninstall","configure"],"moduleType":"validator","profileVersion":1}';
  const { profile, profileSha256 } = assertModuleProfile(MODULES.session, canonical);
  assert.equal(profile.contractName, 'SessionKeyValidator');
  assert.match(profileSha256, /^0x[0-9a-f]{64}$/);
  assert.throws(() => assertModuleProfile(MODULES.session, `${canonical} `), /not canonical/);
  assert.throws(() => assertModuleProfile(MODULES.session, canonical.replace('"validator"', '"hook"')), /moduleType/);
  assert.throws(() => assertModuleProfile(MODULES.session, 'not json'), /did not return JSON/);
});
