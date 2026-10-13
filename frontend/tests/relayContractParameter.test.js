import test from 'node:test';
import assert from 'node:assert/strict';
import { sc, u } from '@cityofzion/neon-js';
import { convertContractParamFromJson } from '../api/relayHelpers.js';

const script = (parameter) => new sc.ScriptBuilder().emitContractParam(parameter).str;

test('relay keeps the established hex byte convention and preserves non-symmetric bytes', () => {
  for (const value of ['00aabbff', '0x00aabbff']) {
    assert.equal(script(convertContractParamFromJson({ type: 'ByteArray', value }, { sc, u })), '0c0400aabbff');
  }
  assert.throws(() => convertContractParamFromJson({ type: 'ByteArray', value: 'qrs=' }, { sc, u }), /even-length hex/);
});

test('relay Boolean false and Any null emit distinct VM instructions', () => {
  assert.equal(script(convertContractParamFromJson({ type: 'Boolean', value: false }, { sc, u })), '09');
  assert.equal(script(convertContractParamFromJson({ type: 'Any' }, { sc, u })), '0b');
  for (const value of [0, 1, 'false', 'true']) assert.throws(() => convertContractParamFromJson({ type: 'Boolean', value }, { sc, u }), /boolean/);
});

test('relay rejects unknown and malformed nested types before emitting any script', () => {
  const invalid = [null, 'raw', { type: 'Unknown', value: 'aa' }, { type: 'Any', value: 'aa' },
    { type: 'Hash256', value: 'aa' }, { type: 'Array', value: ['raw'] },
    { type: 'Integer', value: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'Map', value: [{ key: { type: 'Array', value: [] }, value: { type: 'Any' } }] }];
  for (const param of invalid) assert.throws(() => convertContractParamFromJson(param, { sc, u }), /Contract parameter/);
});

test('relay allows depth eight, rejects depth nine, and bounds cyclic arrays', () => {
  let boundary = { type: 'ByteArray', value: '0xaabb' };
  for (let index = 0; index < 8; index += 1) boundary = { type: 'Array', value: [boundary] };
  assert.doesNotThrow(() => convertContractParamFromJson(boundary, { sc, u }));
  assert.throws(() => convertContractParamFromJson({ type: 'Array', value: [boundary] }, { sc, u }), /maximum depth of 8/);
  const cyclic = { type: 'Array', value: [] }; cyclic.value.push(cyclic);
  assert.throws(() => convertContractParamFromJson(cyclic, { sc, u }), /maximum depth of 8/);
});

// These opcode vectors follow Neo core CreateMap (reverse input enumeration,
// push value then key, PACKMAP), not Neon's emitMap implementation.
test('relay multi-entry and nested Map scripts match core RPC insertion order', () => {
  const entry = (key, value) => ({ key: { type: 'String', value: key }, value });
  const integer = (value) => ({ type: 'Integer', value: String(value) });
  const simple = { type: 'Map', value: [entry('a', integer(1)), entry('b', integer(2))] };
  const nested = { type: 'Map', value: [entry('a', { type: 'Map', value: [entry('x', integer(1)), entry('y', integer(2))] }), entry('b', integer(3))] };
  for (const [input, coreVector] of [[simple, '120c0162110c016112be'], [nested, '130c0162120c0179110c017812be0c016112be']]) {
    const original = JSON.stringify(input);
    assert.equal(script(convertContractParamFromJson(input, { sc, u })), coreVector);
    assert.equal(JSON.stringify(input), original, 'the input order remains immutable');
  }
});

test('relay refuses duplicate Map keys including cross-type ByteString aliases', () => {
  const bytes = (value) => ({ type: 'ByteArray', value });
  const pairs = [
    [{ type: 'String', value: 'same' }, { type: 'String', value: 'same' }],
    [{ type: 'Integer', value: '01' }, { type: 'Integer', value: 1 }],
    [{ type: 'String', value: 'a' }, bytes('0x61')],
    [{ type: 'Hash160', value: '1234567890abcdef1234567890abcdef12345678' }, bytes('0x78563412efcdab9078563412efcdab9078563412')],
    [{ type: 'Hash256', value: '01'.repeat(32) }, bytes(`0x${'01'.repeat(32)}`)],
    [{ type: 'PublicKey', value: `02${'11'.repeat(32)}` }, bytes(`0x02${'11'.repeat(32)}`)],
  ];
  for (const keys of pairs) {
    const map = { type: 'Map', value: keys.map((key) => ({ key, value: { type: 'Integer', value: '1' } })) };
    assert.throws(() => convertContractParamFromJson(map, { sc, u }), /duplicate Map key/);
  }
});

test('relay keeps Boolean true and Integer one as distinct legal VM Map keys', () => {
  const map = { type: 'Map', value: [
    { key: { type: 'Boolean', value: true }, value: { type: 'Integer', value: '10' } },
    { key: { type: 'Integer', value: '1' }, value: { type: 'Integer', value: '11' } },
  ] };
  assert.equal(script(convertContractParamFromJson(map, { sc, u })), '1b111a0812be');
});
