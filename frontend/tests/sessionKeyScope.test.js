import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeSessionKeyScope,
  normalizeHash,
  NATIVE_ASSETS,
} from '../src/features/studio/sessionKeyScope.js';

const GAS = 'd2a4cff31913016155e38e474a2c06d08be276cf';
const NEO = 'ef4073a0f2b305a38ec4050e4d3d28bc40ea63f5';
const SOME_DAPP = '1111111111111111111111111111111111111111';

// v4 configure data is the command first: the core forwards it to the module's Configure, which
// dispatches on args[0]. The rest of the list is the setSessionKey operands.
function args({ target = SOME_DAPP, method = '*', limit } = {}) {
  const list = [
    { type: 'String', value: 'setSessionKey' },
    { type: 'ByteArray', value: '0xdeadbeef' },
    { type: 'Hash160', value: `0x${target}` },
    { type: 'String', value: method },
    { type: 'Integer', value: '1735689600' },
  ];
  if (limit !== undefined) list.push({ type: 'Integer', value: String(limit) });
  return list;
}

test('wildcard ("*") session key is flagged value-uncapped', () => {
  const scope = analyzeSessionKeyScope(args({ method: '*' }));
  assert.equal(scope.applies, true);
  assert.equal(scope.uncapped, true);
  assert.equal(scope.nativeAsset, null);
});

test('transfer session key with a positive limit is capped (no warning)', () => {
  const scope = analyzeSessionKeyScope(args({ method: 'transfer', limit: 1000 }));
  assert.equal(scope.applies, true);
  assert.equal(scope.uncapped, false);
});

test('transfer session key with a zero limit is value-uncapped', () => {
  const scope = analyzeSessionKeyScope(args({ method: 'transfer', limit: 0 }));
  assert.equal(scope.uncapped, true);
});

test('transfer session key with no limit arg is value-uncapped', () => {
  const scope = analyzeSessionKeyScope(args({ method: 'transfer' }));
  assert.equal(scope.uncapped, true);
});

test('non-transfer method is value-uncapped even with a positive limit', () => {
  // The contract rejects this config at SetSessionKey, but the UI must still warn rather than
  // imply the limit is honored for a non-transfer method.
  const scope = analyzeSessionKeyScope(args({ method: 'burn', limit: 1000 }));
  assert.equal(scope.uncapped, true);
});

test('wildcard on a native GAS target is detected as native', () => {
  const scope = analyzeSessionKeyScope(args({ target: GAS, method: '*' }));
  assert.equal(scope.uncapped, true);
  assert.equal(scope.nativeAsset, 'GAS');
});

test('uncapped key on a native NEO target is detected as native', () => {
  const scope = analyzeSessionKeyScope(args({ target: NEO, method: 'transfer' }));
  assert.equal(scope.uncapped, true);
  assert.equal(scope.nativeAsset, 'NEO');
});

test('a plain-JSON setSessionKey list is read the same way as typed operands', () => {
  const capped = analyzeSessionKeyScope(['setSessionKey', '0x02deadbeef', `0x${GAS}`, 'transfer', 1735689600, 100]);
  assert.equal(capped.applies, true);
  assert.equal(capped.uncapped, false);
  assert.equal(capped.nativeAsset, 'GAS');
});

test('non-setSessionKey-shaped args do not apply', () => {
  assert.equal(analyzeSessionKeyScope([]).applies, false);
  assert.equal(analyzeSessionKeyScope(null).applies, false);
  assert.equal(analyzeSessionKeyScope([{ value: 'x' }]).applies, false);
  assert.equal(analyzeSessionKeyScope([{ type: 'String', value: 'clearSessionKey' }]).applies, false);
  assert.equal(analyzeSessionKeyScope(['clearSessionKey']).applies, false);
});

test('normalizeHash strips 0x and lowercases', () => {
  assert.equal(normalizeHash(`0x${GAS.toUpperCase()}`), GAS);
  assert.equal(NATIVE_ASSETS[GAS], 'GAS');
  assert.equal(NATIVE_ASSETS[NEO], 'NEO');
});
