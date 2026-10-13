import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  OPERATION_PRESETS,
  buildOperationFromPreset,
  buildPresetSummary,
} from '../src/features/operations/presets.js';
import * as presets from '../src/features/operations/presets.js';
import { EC, translateError } from '../src/config/errorCodes.js';
import { getAddressFromScriptHash } from '../src/utils/neo.js';
import {
  BUYER_HASH,
  GAS_HASH,
  PROXY_HASH,
} from './fixtures/aaChainFixtures.js';

test('preset registry exposes invoke, NEP-17 transfer, and multisig draft templates', () => {
  assert.deepEqual(
    OPERATION_PRESETS.map((item) => item.id),
    ['invoke', 'nep17Transfer', 'multisigDraft']
  );
});

test('NEP-17 transfer preset builds transfer args for a source that is not the account proxy', () => {
  const operation = buildOperationFromPreset({
    preset: 'nep17Transfer',
    account: { accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a' },
    transfer: {
      from: '0x7d1d0bbfc9a2e2c0b2e7a1e4a8c5d2f6b1a3c4d5',
      tokenScriptHash: '0xd2a4cff31913016155e38e474a2c06d08be276cf',
      recipient: '0x49c095ce04d38642e39155f5481615c58227a498',
      amount: '100000000',
      data: '{"note":"ops"}',
    },
  });

  assert.equal(operation.kind, 'transfer');
  assert.equal(operation.targetContract, 'd2a4cff31913016155e38e474a2c06d08be276cf');
  assert.equal(operation.method, 'transfer');
  assert.deepEqual(operation.args, [
    { type: 'Hash160', value: '0x7d1d0bbfc9a2e2c0b2e7a1e4a8c5d2f6b1a3c4d5' },
    { type: 'Hash160', value: '0x49c095ce04d38642e39155f5481615c58227a498' },
    { type: 'Integer', value: '100000000' },
    { type: 'Any', value: { note: 'ops' } },
  ]);
});

test('multisig preset keeps contract call data and marks the draft as multisig-oriented', () => {
  const operation = buildOperationFromPreset({
    preset: 'multisigDraft',
    invoke: {
      targetContract: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
      method: 'executeUnifiedByAddress',
      argsText: '[{"type":"String","value":"hello"}]',
    },
    multisig: {
      title: 'Treasury payout',
      description: 'Needs two signers before relay',
    },
  });

  assert.equal(operation.kind, 'multisig');
  assert.equal(operation.method, 'executeUnifiedByAddress');
  assert.equal(operation.metadata.title, 'Treasury payout');
  assert.equal(operation.metadata.description, 'Needs two signers before relay');
  assert.equal(operation.metadata.requiresAdditionalSigners, true);
});

test('preset summaries produce a compact user-facing description', () => {
  const summary = buildPresetSummary({
    kind: 'transfer',
    method: 'transfer',
    targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
    args: [
      { type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' },
      { type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' },
      { type: 'Integer', value: '100000000' },
    ],
  });

  assert.match(summary.title, /NEP-17 Transfer/i);
  assert.match(summary.detail, /100000000/);
});

// --- CU-06: a transfer out of the account proxy cannot move anything through these clients -------------------
// Recorded on the deployed core (AA-03 case a): GAS.transfer(proxy -> buyer) submitted with the owner's witness
// HALTs, returns false, moves no GAS and still consumes the nonce and the fee. The preset composes exactly that
// call, so it is refused before an operation exists.

function proxyTransferInput(overrides = {}) {
  return {
    preset: 'nep17Transfer',
    account: { accountAddressScriptHash: PROXY_HASH },
    transfer: {
      tokenScriptHash: `0x${GAS_HASH}`,
      recipient: `0x${BUYER_HASH}`,
      amount: '100000000',
      data: '',
      ...(overrides.transfer || {}),
    },
    ...(overrides.top || {}),
  };
}

test('CU-06: the NEP-17 preset refuses a transfer out of the account proxy with a typed error', () => {
  assert.throws(
    () => buildOperationFromPreset(proxyTransferInput()),
    (error) => {
      assert.equal(presets.isOperationPresetRefusal(error), true);
      assert.equal(error.name, 'OperationPresetRefusedError');
      assert.equal(error.code, EC.presetProxyTransferRefused);
      assert.equal(error.message, EC.presetProxyTransferRefused, 'the message is the machine-readable code, like every EC error');
      assert.deepEqual(error.details, {
        preset: 'nep17Transfer',
        from: PROXY_HASH,
        token: GAS_HASH,
      });
      return true;
    },
  );
});

test('CU-06: the refusal holds for an explicit source written as 0x, upper case or an N address', () => {
  const sources = [
    `0x${PROXY_HASH}`,
    PROXY_HASH.toUpperCase(),
    `0x${PROXY_HASH.toUpperCase()}`,
    getAddressFromScriptHash(PROXY_HASH),
  ];
  for (const from of sources) {
    assert.throws(
      () => buildOperationFromPreset(proxyTransferInput({ transfer: { from } })),
      (error) => presets.isOperationPresetRefusal(error) && error.details.from === PROXY_HASH,
      `source ${from} is the proxy and must be refused`,
    );
  }
});

test('CU-06: the refusal is for any token, a complete form is not needed to know it', () => {
  assert.throws(
    () => buildOperationFromPreset(proxyTransferInput({ transfer: { tokenScriptHash: '', recipient: '', amount: '' } })),
    (error) => presets.isOperationPresetRefusal(error),
  );
  assert.throws(
    () => buildOperationFromPreset(proxyTransferInput({ transfer: { tokenScriptHash: '0x1234567890123456789012345678901234567890' } })),
    (error) => presets.isOperationPresetRefusal(error) && error.details.token === '1234567890123456789012345678901234567890',
  );
});

test('CU-06: positive controls, nothing else is refused', () => {
  // A source that is not the proxy still builds (owner-witness shapes keep working).
  const other = buildOperationFromPreset(proxyTransferInput({ transfer: { from: `0x${BUYER_HASH}` } }));
  assert.equal(other.kind, 'transfer');
  assert.equal(other.args[0].value, `0x${BUYER_HASH}`);

  // No account loaded: there is no proxy to compare with, so nothing is refused here (staging needs an account anyway).
  const noAccount = buildOperationFromPreset(proxyTransferInput({ top: { account: {} } }));
  assert.equal(noAccount.kind, 'transfer');

  // The other presets never refuse, whatever they carry.
  const invoke = buildOperationFromPreset({
    preset: 'invoke',
    account: { accountAddressScriptHash: PROXY_HASH },
    invoke: { targetContract: `0x${GAS_HASH}`, method: 'transfer', argsText: '[]' },
  });
  assert.equal(invoke.kind, 'invoke');
  const multisig = buildOperationFromPreset({
    preset: 'multisigDraft',
    account: { accountAddressScriptHash: PROXY_HASH },
    invoke: { targetContract: `0x${GAS_HASH}`, method: 'transfer', argsText: '[]' },
  });
  assert.equal(multisig.kind, 'multisig');
});

test('CU-06: the refusal code maps to a translated message and has no raw fallback in the UI', () => {
  const messages = [];
  const t = (key, fallback) => {
    messages.push(key);
    return `[${key}]`;
  };
  assert.equal(translateError(EC.presetProxyTransferRefused, t), '[operations.presetProxyTransferRefused]');
  assert.deepEqual(messages, ['operations.presetProxyTransferRefused']);
});

test('CU-06: tryBuildOperationFromPreset answers a refusal as a result and rethrows real errors', () => {
  const refused = presets.tryBuildOperationFromPreset(proxyTransferInput());
  assert.equal(refused.operation, null);
  assert.equal(presets.isOperationPresetRefusal(refused.refusal), true);
  assert.equal(refused.refusal.code, EC.presetProxyTransferRefused);

  const built = presets.tryBuildOperationFromPreset(proxyTransferInput({ transfer: { from: `0x${BUYER_HASH}` } }));
  assert.equal(built.refusal, null);
  assert.equal(built.operation.kind, 'transfer');

  assert.throws(
    () => presets.tryBuildOperationFromPreset(proxyTransferInput({ top: { account: null } })),
    TypeError,
    'an error that is not a refusal is a bug and must not be swallowed',
  );
});

test('CU-06: the workspace shows the refusal in the composer and refuses to stage it', () => {
  const source = fs.readFileSync(
    path.resolve('src/features/operations/components/HomeOperationsWorkspace.vue'),
    'utf8',
  );
  assert.match(source, /tryBuildOperationFromPreset/);
  assert.doesNotMatch(source, /\bbuildOperationFromPreset\b/, 'the workspace must not call the throwing builder from a computed');
  assert.match(source, /translateError\(presetBuild\.value\.refusal\.message, t\)/);
  assert.match(source, /presetRefusal\.value\s*\?\s*\{\s*title: t\("operations\.presetRefusedTitle"/);
  assert.match(source, /function stageOperation\(\) \{\s*if \(presetRefusal\.value\) \{\s*toast\.error\(presetRefusal\.value\);\s*return;\s*\}/);
});
