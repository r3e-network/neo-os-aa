/**
 * The v4 testnet harness, as far as a unit test can hold it.
 *
 * The runbooks only run against a live testnet, so `npm test` cannot execute
 * them. What it can pin is the part of the harness that is a protocol decision
 * rather than a transaction: the deployment naming the core and the client
 * enforce, the 13-field operation the SDK encodes, the install-action grammar,
 * the plan/recipe pairing a review depends on, and the profile digests the
 * core re-hashes when it binds a module.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./testnet-v4-harness');
const sdkIndex = require('../src/index');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const hash160 = (byte) => `0x${byte.repeat(20)}`;
const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Every module profile the build ships, by its `plugins/`-relative name. */
function profileNames() {
  const names = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'obj' || entry.name === 'bin') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.profile.json')) {
        names.push({
          name: path.basename(entry.name, '.profile.json'),
          relative: path.relative(path.join(repoRoot, 'contracts', 'plugins'), full).split(path.sep).join('/'),
          file: full,
        });
      }
    }
  };
  walk(path.join(repoRoot, 'contracts', 'plugins'));
  return names;
}

test('deployment naming keeps canonical names for the kernel and its modules', () => {
  const chain = { deploymentTag: 'sa-v4-run1' };

  // The client only adopts a core whose manifest is named `SmartAccount`, and a
  // module publishes the `contractName` the core compares with the manifest
  // name (§7.3), so both must deploy without a suffix.
  assert.equal(h.deploymentSuffix(chain, 'SmartAccount', ''), '');
  assert.equal(h.deploymentSuffix(chain, 'validators/P256Validator', ''), '');

  // The default is still a per-run tag, which is what non-module contracts use.
  assert.equal(h.deploymentSuffix(chain, 'SmartAccount', undefined), 'sa-v4-run1-SmartAccount');
  assert.equal(
    h.deploymentSuffix(chain, 'validators/P256Validator', undefined),
    'sa-v4-run1-validators-P256Validator',
    'a nested artifact name must not put a directory into the manifest name',
  );
  assert.equal(h.deploymentSuffix(chain, 'SAPaymaster', 'tag-a'), 'tag-a', 'an explicit suffix is used verbatim');
});

test('artifact paths resolve under contracts/bin/public, nested names included', () => {
  const nested = h.artifactPaths('validators/P256Validator');
  assert.equal(nested.nef, path.join(repoRoot, 'contracts', 'bin', 'public', 'validators', 'P256Validator.nef'));
  assert.equal(
    nested.manifest,
    path.join(repoRoot, 'contracts', 'bin', 'public', 'validators', 'P256Validator.manifest.json'),
  );
  const core = h.artifactPaths('SmartAccount');
  assert.equal(core.nef, path.join(repoRoot, 'contracts', 'bin', 'public', 'SmartAccount.nef'));
});

test('a module profile declares the name its artifact is deployed under', () => {
  const profiles = profileNames();
  assert.ok(profiles.length >= 12, `expected every shipped module profile, found ${profiles.length}`);

  for (const profile of profiles) {
    const json = JSON.parse(fs.readFileSync(profile.file, 'utf8'));
    assert.equal(
      json.contractName,
      profile.name,
      `${profile.relative} must name the contract it deploys as`,
    );
    assert.ok(json.moduleType === 'validator' || json.moduleType === 'hook', `${profile.relative} moduleType`);
    assert.equal(h.profileDigestOf(profile.relative), sha256Hex(fs.readFileSync(profile.file)));

    // When a build is present, the manifest the deploy would send carries the
    // same name the profile commits to; a rename would break the binding.
    const manifestPath = path.join(
      repoRoot,
      'contracts',
      'bin',
      'public',
      path.dirname(profile.relative),
      `${profile.name}.manifest.json`,
    );
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.name, json.contractName, `${profile.relative} manifest name`);
    }
  }
});

test('a profile digest accepts its file name with or without the extension', () => {
  const expected = sha256Hex(
    fs.readFileSync(path.join(repoRoot, 'contracts', 'plugins', 'validators', 'P256Validator.profile.json')),
  );
  assert.equal(h.profileDigestOf('validators/P256Validator'), expected);
  assert.equal(h.profileDigestOf('validators/P256Validator.profile.json'), expected);
  assert.match(h.profileDigestOf('validators/P256Validator'), /^[0-9a-f]{64}$/);
});

test('the harness leaves the signature to the validator and encodes 13 fields', () => {
  const op = h.operation({ targetContract: hash160('ab'), method: 'symbol', nonce: 7 });
  assert.deepEqual(Object.keys(op), [
    'targetContract',
    'method',
    'args',
    'nonce',
    'nonceSubkey',
    'deadline',
    'validatorId',
    'credentialGeneration',
    'authorityEpoch',
    'configurationNonce',
    'signature',
    'hookProofs',
  ]);
  assert.equal(op.nonce, '7');
  assert.equal(op.nonceSubkey, '00'.repeat(32));
  assert.equal(op.validatorId, '0');
  assert.equal(op.credentialGeneration, '1');
  assert.equal(op.authorityEpoch, '0');
  assert.equal(op.configurationNonce, '0');
  assert.equal(op.signature, '', 'an unsigned operation carries no signature');
  assert.deepEqual(op.hookProofs, []);
  assert.ok(Number(op.deadline) > Date.now(), 'the default deadline is in the future');

  assert.equal(h.codec, sdkIndex.codec, 'the harness must re-export the SDK codec, not its own');

  // The codec is the protocol's: an empty signature never reaches the chain.
  assert.throws(() => h.codec.operationValue(op), /signature must contain 1\.\.8192 bytes/);

  const encoded = h.codec.operationValue({ ...op, signature: '00' });
  assert.equal(encoded.type, 'Array');
  assert.equal(encoded.value.length, 13);
  assert.equal(String(encoded.value[0].value), '4', 'field 0 is the protocol version');
  assert.deepEqual(encoded.value.map((parameter) => parameter.type), [
    'Integer',
    'ByteString',
    'ByteString',
    'Array',
    'Integer',
    'ByteString',
    'Integer',
    'Integer',
    'Integer',
    'Integer',
    'Integer',
    'ByteString',
    'Array',
  ]);
});

test('the install action matches the core action grammar', () => {
  assert.deepEqual(
    [h.ACTION_INSTALL_MODULE, h.ACTION_CONFIGURE_MODULE, h.ACTION_SET_HOOK_ORDER, h.ACTION_THRESHOLD_POLICY],
    ['1', '3', '4', '7'],
  );
  assert.equal(h.REGISTRATION_RECOVERY_TIMELOCK_MS, 7 * 24 * 60 * 60 * 1000);

  const action = h.installAction({
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: hash160('11'),
    profileDigest: '22'.repeat(32),
  });
  assert.equal(action.type, 'Array');
  assert.equal(action.value.length, 5);
  assert.equal(action.value[0].value, h.ACTION_INSTALL_MODULE);
  assert.equal(action.value[1].value, '1', 'a validator declares module type 1');
  assert.equal(action.value[2].value, '11'.repeat(20));
  assert.equal(action.value[3].value, '22'.repeat(32));
  assert.deepEqual(action.value[4].value, [], 'no initData is an empty array, not an omission');

  const hook = h.installAction({
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: hash160('33'),
    profileDigest: '44'.repeat(32),
  });
  assert.equal(hook.value[1].value, '2', 'a hook declares module type 2');

  const numeric = h.installAction({ moduleType: 1, moduleHash: hash160('55'), profileDigest: '66'.repeat(32) });
  assert.equal(numeric.value[1].value, '1', 'a numeric validator type is accepted');

  const withInit = h.installAction({
    moduleType: 1,
    moduleHash: hash160('55'),
    profileDigest: '66'.repeat(32),
    initData: [{ type: 'Integer', value: '5' }],
  });
  assert.equal(withInit.value[4].value.length, 1);
});

test('a plan always carries the recipe that rebuilds it', () => {
  const sdk = {
    buildCreateAccountScript: (input) => ({ kind: 'registration', input }),
    buildExecutionScript: (input) => ({ kind: 'execution', input }),
    buildConfigurationScript: (input) => ({ kind: 'configuration', input }),
    buildAccountActionScript: (input) => ({ kind: 'accountAction', input }),
  };

  const registration = h.registrationPlan(sdk, { custodyAddress: hash160('11'), salt: 'ab'.repeat(32), actions: [] });
  assert.equal(registration.plan.kind, 'registration');
  assert.deepEqual(registration.recipe, { method: 'buildCreateAccountScript', input: registration.plan.input });

  const single = { targetContract: hash160('ab'), method: 'symbol' };
  const execution = h.executionPlan(sdk, { accountId: hash160('22'), operations: single });
  assert.deepEqual(execution.plan.input.operations, [single], 'one operation is still a list');
  assert.deepEqual(execution.recipe, { method: 'buildExecutionScript', input: execution.plan.input });

  const many = h.executionPlan(sdk, { accountId: hash160('22'), operations: [single, single] });
  assert.equal(many.plan.input.operations.length, 2);

  const configuration = h.configurationPlan(sdk, { accountId: hash160('22'), actions: [] });
  assert.equal(configuration.recipe.method, 'buildConfigurationScript');
  assert.equal(configuration.plan.kind, 'configuration');

  const accountAction = h.accountActionPlan(sdk, { accountId: hash160('22'), method: 'cancelRecovery', args: [] });
  assert.equal(accountAction.recipe.method, 'buildAccountActionScript');
  assert.equal(accountAction.plan.kind, 'accountAction');
});

test('the fee caps default and are overridable from the environment', () => {
  assert.deepEqual(h.capsFromEnv({}), {
    maxSystemFee: '50000000',
    maxNetworkFee: '5000000',
    maxTotalFee: '55000000',
  });
  assert.deepEqual(
    h.capsFromEnv({ SA_MAX_SYSTEM_FEE: '1', SA_MAX_NETWORK_FEE: '2', SA_MAX_TOTAL_FEE: '3' }),
    { maxSystemFee: '1', maxNetworkFee: '2', maxTotalFee: '3' },
  );
});

test('a run id names one run and honours the environment', () => {
  const saved = process.env.SA_VALIDATION_RUN_ID;
  try {
    process.env.SA_VALIDATION_RUN_ID = 'Suite-A1';
    assert.equal(h.validationRunId(), 'suite-a1', 'an explicit run id is normalised, not replaced');

    delete process.env.SA_VALIDATION_RUN_ID;
    const generated = h.validationRunId();
    assert.match(generated, /^[a-z0-9-]+$/, `generated run id ${generated}`);
    assert.notEqual(h.validationRunId(), generated, 'a run id without the environment is fresh');
  } finally {
    if (saved === undefined) delete process.env.SA_VALIDATION_RUN_ID;
    else process.env.SA_VALIDATION_RUN_ID = saved;
  }
});

test('hash and stack helpers decode what the runbooks assert on', () => {
  assert.equal(h.normalizeHash('0XAB'), '0xab');
  assert.equal(h.normalizeHash(''), '');
  assert.equal(h.sanitizeHex('0xAB'), 'ab');

  const littleEndian = Buffer.from('cd'.repeat(20), 'hex').toString('base64');
  assert.equal(h.decodeHash160({ type: 'Hash160', value: hash160('cd') }), hash160('cd'));
  assert.equal(
    h.decodeHash160({ type: 'ByteString', value: littleEndian }),
    hash160('cd'),
    'a ByteString hash160 read is little-endian and must be reversed',
  );
  assert.equal(h.decodeHash160({ type: 'ByteString', value: Buffer.from('abcd').toString('base64') }), '', 'a short read is not a hash');

  assert.equal(h.stackText({ type: 'ByteString', value: Buffer.from('GAS').toString('base64') }), 'GAS');
  assert.equal(h.stackText({ type: 'Integer', value: '7' }), '7');
  assert.equal(h.stackText({ type: 'Boolean', value: true }), 'true');
  assert.equal(h.stackText(undefined), '');

  assert.equal(h.decodeInteger({ type: 'Integer', value: '42' }), '42');
  assert.equal(h.decodeInteger({ type: 'ByteString', value: Buffer.from('ff', 'hex').toString('base64') }), '255');
});

test('every runbook stage the suites run still exists on disk', () => {
  const scripts = [
    'testnet_smoke.js',
    'testnet_plugin_matrix.js',
  ];
  for (const script of scripts) {
    assert.ok(fs.existsSync(path.join(__dirname, script)), `${script} must exist for the validation suite`);
  }
  const retired = [
    'v3_testnet_smoke.js',
    'v3_testnet_plugin_matrix.js',
    'v3_testnet_market_escrow.js',
    'testnet_market_escrow.js',
    'testnet_paymaster_onchain.mjs',
    'testnet_paymaster_policy.mjs',
    'testnet_paymaster_relay.mjs',
  ];
  for (const script of retired) {
    assert.ok(!fs.existsSync(path.join(__dirname, script)), `${script} is retired and must stay gone`);
  }
});
