import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModuleReadPresets, applyModuleReadPreset } from '../src/features/studio/modulePresets.js';

const presets = createModuleReadPresets();

function moduleSource(module) {
  const folder = module.endsWith('Hook') || module === 'MultiHook' ? 'hooks' : 'validators';
  return readFileSync(new URL(`../../contracts/plugins/${folder}/${module}.cs`, import.meta.url), 'utf8');
}

test('presets expose validator and hook reads only', () => {
  assert.deepEqual(presets.validatorReads.map(value => value.method), [
    'getModuleProfile',
    'getConfig',
    'getSessionKey',
    'getThreshold',
    'getPublicKey',
  ]);
  assert.deepEqual(presets.hookReads.map(value => value.method), [
    'getDailyLimit',
    'getRequiredProvider',
    'getRequiredClaimType',
  ]);
  assert.equal(presets.commonExamples.length, 4);
});

for (const preset of [...presets.validatorReads, ...presets.hookReads]) {
  test(`${preset.module} exposes ${preset.method} as a public module read`, () => {
    if (preset.module === 'Any validator') return;
    const source = moduleSource(preset.module);
    const declaration = preset.method.charAt(0).toUpperCase() + preset.method.slice(1);
    const signature = new RegExp(`public static [^\\n]* ${declaration}\\(UInt160 accountId, BigInteger moduleId`);
    assert.match(source, signature, `${preset.method} must be declared on ${preset.module}`);
  });
}

test('every concrete preset target also exposes getModuleProfile', () => {
  for (const preset of [...presets.validatorReads, ...presets.hookReads]) {
    if (preset.module === 'Any validator') continue;
    assert.match(moduleSource(preset.module), /public static string GetModuleProfile\(\)/);
  }
});

test('hook reads carry only extra arguments after the account and module ids', () => {
  const dailyLimit = presets.hookReads.find(value => value.method === 'getDailyLimit');
  assert.deepEqual(dailyLimit.args.map(value => value.type), ['Hash160']);
  const provider = presets.hookReads.find(value => value.method === 'getRequiredProvider');
  assert.deepEqual(provider.args.map(value => value.type), ['Hash160']);
  for (const preset of presets.validatorReads) {
    assert.deepEqual(preset.args, [], `${preset.method} takes no argument beyond the account and module ids`);
  }
});

test('applying a preset writes the method and a detached JSON copy of the args', () => {
  const form = { method: 'original', argsJson: '["original"]' };
  const dailyLimit = presets.hookReads.find(value => value.method === 'getDailyLimit');
  applyModuleReadPreset(form, dailyLimit);
  assert.equal(form.method, 'getDailyLimit');
  assert.deepEqual(JSON.parse(form.argsJson), dailyLimit.args);
  form.argsJson = JSON.stringify([{ type: 'Hash160', value: '0x01' }]);
  assert.equal(dailyLimit.args[0].value, '0x<token>', 'the preset template must not be mutated by the form');
});

test('applying a validator preset clears the previous extra arguments', () => {
  const form = { method: 'getDailyLimit', argsJson: '[{"type":"Hash160","value":"0x01"}]' };
  applyModuleReadPreset(form, presets.validatorReads[2]);
  assert.equal(form.method, 'getSessionKey');
  assert.deepEqual(JSON.parse(form.argsJson), []);
});

test('an unknown preset cannot select a read destination', () => {
  const form = { method: 'original', argsJson: '[]' };
  assert.throws(() => applyModuleReadPreset(form, { method: 42 }), /Unknown module read preset/);
  assert.throws(() => applyModuleReadPreset(form, null), /Unknown module read preset/);
  assert.deepEqual(form, { method: 'original', argsJson: '[]' });
});
