import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModuleConfigurationPresets, applyModuleConfigurationPreset } from '../src/features/studio/modulePresets.js';
import { analyzeSessionKeyScope } from '../src/features/studio/sessionKeyScope.js';

const now = 1_791_504_000_000;
const presets = createModuleConfigurationPresets(undefined, now);

for (const preset of [...presets.verifierPresets, ...presets.hookPresets]) {
  test(`${preset.module} configuration template matches the shipped contract ABI`, () => {
    const manifest = JSON.parse(readFileSync(new URL(`../../contracts/build/${preset.module}.manifest.json`, import.meta.url)));
    const method = manifest.abi.methods.find(value => value.name === preset.method);
    assert.ok(method, `${preset.method} must exist on ${preset.module}`);
    assert.deepEqual(preset.args.map(value => value.type), method.parameters.map(value => value.type));
    assert.equal(method.safe, false);
  });
}

test('session template uses a capped transfer and a future millisecond deadline', () => {
  const session = presets.verifierPresets.find(value => value.module === 'SessionKeyVerifier');
  assert.equal(analyzeSessionKeyScope(session.args).uncapped, false);
  assert.equal(BigInt(session.args[4].value), BigInt(now + 7 * 86400000));
  assert.ok(BigInt(session.args[4].value) > BigInt(now + 86400000));
  assert.equal(session.args[6].type, 'String');
});

test('every example fills its explicit module role with the same displayed arguments', () => {
  for (const example of presets.commonExamples) {
    const form = { verifierMethod: 'original verifier', hookMethod: 'original hook' };
    applyModuleConfigurationPreset(form, example, now);
    assert.equal(form[`${example.role}Method`], example.method);
    const args = JSON.parse(form[`${example.role}ArgsJson`]);
    assert.deepEqual(args, JSON.parse(example.code.split('\nargs: ')[1]));
    const other = example.role === 'verifier' ? 'hook' : 'verifier';
    assert.equal(form[`${other}Method`], `original ${other}`);
    assert.equal(form[`${other}ArgsJson`], undefined);
  }
});

test('applying a session later refreshes expiry and fills only a valid selected account', () => {
  const session = presets.verifierPresets[0];
  const account = `0x${'12'.repeat(20)}`;
  const form = { accountAddress: account };
  applyModuleConfigurationPreset(form, session, now + 20 * 86400000);
  const args = JSON.parse(form.verifierArgsJson);
  assert.equal(args[0].value, account);
  assert.equal(BigInt(args[4].value), BigInt(now + 27 * 86400000));
  assert.equal(session.args[0].value, '0x<accountId>');
  assert.equal(BigInt(session.args[4].value), BigInt(now + 7 * 86400000));
  const missing = { accountAddress: 'invalid account' };
  applyModuleConfigurationPreset(missing, session, now);
  assert.equal(JSON.parse(missing.verifierArgsJson)[0].value, '0x<accountId>');
});

test('multisig template asks for verifier contract identities, not signer addresses', () => {
  const multisig = presets.verifierPresets.find(value => value.module === 'MultiSigVerifier');
  assert.equal(multisig.method, 'setConfig');
  assert.equal(multisig.args[1].value.length, Number(multisig.args[2].value));
  assert.ok(multisig.args[1].value.every(child => child.type === 'Hash160' && child.value.includes('childVerifier')));
  assert.match(multisig.description, /does not prove independent signers/);
});

test('an unknown template role cannot select a form destination', () => {
  const form = { verifierMethod: 'original' };
  assert.throws(() => applyModuleConfigurationPreset(form, { ...presets.verifierPresets[0], role: 'admin' }, now), /Unknown module role/);
  assert.deepEqual(form, { verifierMethod: 'original' });
});
