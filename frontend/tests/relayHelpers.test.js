import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  ALLOWED_RELAY_META_OPERATIONS,
  convertContractParamFromJson,
  normalizeRelayPayload,
  resolveRelayMetaInvocationRefusal,
  sanitizeMetaInvocationForRelay,
} from '../api/relayHelpers.js';

// CU-203: the relay allowlist is a security boundary that used to be typed by hand, so it kept
// naming entrypoints the deployed core does not export. It is now generated from the artifact that
// is actually deployed, and these tests read that artifact directly as their oracle.
const DEPLOYED_MANIFEST = path.resolve('..', 'contracts', 'build', 'UnifiedSmartWalletV3.manifest.json');
const GENERATED_OPERATIONS_FILE = path.resolve('api', 'relayOperations.generated.js');
const GENERATOR_SCRIPT = path.resolve('..', 'scripts', 'generate-relay-operations.mjs');

function deployedAbiMethods() {
  const manifest = JSON.parse(fs.readFileSync(DEPLOYED_MANIFEST, 'utf8'));
  return (manifest?.abi?.methods || []).map((method) => method?.name).filter(Boolean);
}

test('the relay payload allowlist is exactly the deployed core ABI execution surface', () => {
  const methods = deployedAbiMethods();
  const executionSurface = methods.filter((name) => name.startsWith('execute'));
  assert.ok(
    executionSurface.length > 0,
    `the deployed manifest at ${DEPLOYED_MANIFEST} exports no execute* method, so this test cannot decide anything`,
  );
  assert.deepEqual(
    [...ALLOWED_RELAY_META_OPERATIONS].sort(),
    [...executionSurface].sort(),
    'the relay payload allowlist drifted from the deployed core ABI',
  );
  for (const removed of ['executeUnified', 'executeUnifiedByAddress']) {
    assert.equal(
      methods.includes(removed),
      false,
      `the deployed core ABI now exports ${removed}; re-derive the allowlist instead of hand-editing it`,
    );
    assert.equal(
      ALLOWED_RELAY_META_OPERATIONS.includes(removed),
      false,
      `${removed} is not in the deployed core ABI and must not be relayable`,
    );
  }
});

test('the generated relay operations module is reproducible from the deployed manifest', () => {
  const generated = fs.readFileSync(GENERATED_OPERATIONS_FILE, 'utf8');
  const result = spawnSync(process.execPath, [GENERATOR_SCRIPT], {
    cwd: path.resolve('..'),
    encoding: 'utf8',
    env: { ...process.env, NEOOS_RELAY_OPERATIONS_STDOUT: '1' },
  });
  assert.equal(result.status, 0, `the generator failed against the deployed manifest: ${result.stderr}`);
  assert.equal(
    generated,
    result.stdout,
    'frontend/api/relayOperations.generated.js is not what the deployed manifest generates; run scripts/generate-relay-operations.mjs',
  );
});

test('an unreadable deployed manifest fails the generator closed instead of allowing every operation', () => {
  const missing = path.join('contracts', 'build', 'this-manifest-does-not-exist.manifest.json');
  const result = spawnSync(process.execPath, [GENERATOR_SCRIPT], {
    cwd: path.resolve('..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NEOOS_RELAY_OPERATIONS_MANIFEST: missing,
      NEOOS_RELAY_OPERATIONS_STDOUT: '1',
    },
  });
  assert.notEqual(result.status, 0, 'an unreadable manifest must be a failure, never an empty allowlist');
  assert.match(result.stderr, /deployed manifest/i, 'the failure must name the manifest as the cause');
  assert.doesNotMatch(
    result.stdout,
    /ALLOWED_RELAY_META_OPERATIONS/,
    'a failed generation must not emit an allowlist',
  );
  // The shipped module is what the relay reads at runtime; a failed generation leaves it alone.
  assert.deepEqual(
    [...ALLOWED_RELAY_META_OPERATIONS].sort(),
    [...deployedAbiMethods().filter((name) => name.startsWith('execute'))].sort(),
    'after a failed generation the shipped allowlist still refuses everything the core does not export',
  );
});

test('a relay request naming a non-exported entrypoint is refused with the operation named', () => {
  const invocation = {
    scriptHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    operation: 'executeUnified',
    args: [{ type: 'String', value: 'ok' }],
  };
  assert.equal(
    sanitizeMetaInvocationForRelay(invocation, { aaContractHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf' }),
    null,
    'the helper must not allow an entrypoint the deployed core does not export',
  );
  assert.equal(
    resolveRelayMetaInvocationRefusal(invocation, { aaContractHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf' }),
    'unsupported relay operation: executeUnified is not in the deployed Abstract Account ABI',
  );
});

test('a relay request naming a supported entrypoint is still allowed unchanged', () => {
  const invocation = {
    scriptHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    operation: 'executeUserOp',
    args: [
      { type: 'Hash160', value: '0xf951cd3eb5196dacde99b339c5dcca37ac38cc22' },
      { type: 'Struct', value: [] },
    ],
  };
  const sanitized = sanitizeMetaInvocationForRelay(invocation, {
    aaContractHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
  });
  assert.equal(sanitized?.operation, 'executeUserOp');
  assert.equal(
    resolveRelayMetaInvocationRefusal(invocation, { aaContractHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf' }),
    null,
  );
});

test('normalizeRelayPayload prefers raw transactions when provided', () => {
  assert.deepEqual(
    normalizeRelayPayload({ rawTransaction: '0xdeadbeef' }),
    { mode: 'raw', rawTransaction: 'deadbeef' }
  );
});


test('sanitizeMetaInvocationForRelay only accepts configured AA wrapper invocations and strips caller signers', () => {
  const metaInvocation = {
    scriptHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
    operation: 'executeSponsoredUserOps',
    args: [{ type: 'String', value: 'ok' }],
    signers: [{ account: '0xattacker', scopes: 255 }],
  };

  assert.ok(ALLOWED_RELAY_META_OPERATIONS.includes('executeUserOp'));
  assert.ok(ALLOWED_RELAY_META_OPERATIONS.includes('executeUserOps'));
  assert.ok(ALLOWED_RELAY_META_OPERATIONS.includes('executeSponsoredUserOp'));
  assert.ok(ALLOWED_RELAY_META_OPERATIONS.includes('executeSponsoredUserOps'));
  assert.deepEqual(
    sanitizeMetaInvocationForRelay(metaInvocation, {
      aaContractHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
    }),
    {
      scriptHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
      operation: 'executeSponsoredUserOps',
      args: [{ type: 'String', value: 'ok' }],
    },
  );
});

test('sanitizeMetaInvocationForRelay accepts V3 executeUserOp invocations', () => {
  const metaInvocation = {
    scriptHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
    operation: 'executeUserOp',
    args: [
      { type: 'Hash160', value: '0xf951cd3eb5196dacde99b339c5dcca37ac38cc22' },
      { type: 'Struct', value: [] },
    ],
  };

  assert.deepEqual(
    sanitizeMetaInvocationForRelay(metaInvocation, {
      aaContractHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
    }),
    {
      scriptHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
      operation: 'executeUserOp',
      args: [
        { type: 'Hash160', value: '0xf951cd3eb5196dacde99b339c5dcca37ac38cc22' },
        { type: 'Struct', value: [] },
      ],
    },
  );
});

test('sanitizeMetaInvocationForRelay rejects wrong contract hashes and unsupported operations', () => {
  assert.equal(
    sanitizeMetaInvocationForRelay({
      scriptHash: '0x1111111111111111111111111111111111111111',
      operation: 'executeUserOp',
      args: [],
    }, {
      aaContractHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
    }),
    null,
  );

  assert.equal(
    sanitizeMetaInvocationForRelay({
      scriptHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
      operation: 'transfer',
      args: [],
    }, {
      aaContractHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
    }),
    null,
  );
});

test('normalizeRelayPayload accepts meta invocation payloads', () => {
  const metaInvocation = {
    scriptHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    operation: 'executeUserOp',
    args: [{ type: 'String', value: 'ok' }],
  };

  assert.deepEqual(
    normalizeRelayPayload({ metaInvocation }),
    { mode: 'meta', metaInvocation }
  );
  assert.deepEqual(
    normalizeRelayPayload({ meta_invocation: metaInvocation }),
    { mode: 'meta', metaInvocation }
  );
});

test('convertContractParamFromJson handles nested arrays and primitive contract params', () => {
  const calls = [];
  const sc = {
    ContractParam: {
      hash160(value) {
        calls.push(['hash160', value]);
        return { kind: 'hash160', value };
      },
      string(value) {
        calls.push(['string', value]);
        return { kind: 'string', value };
      },
      integer(value) {
        calls.push(['integer', value]);
        return { kind: 'integer', value };
      },
      byteArray(value) {
        calls.push(['byteArray', value]);
        return { kind: 'byteArray', value };
      },
      array(...items) {
        calls.push(['array', items]);
        return { kind: 'array', items };
      },
      any(value) {
        calls.push(['any', value]);
        return { kind: 'any', value };
      },
    },
  };
  const u = {
    HexString: {
      fromHex(value, reverse = false) {
        calls.push(['fromHex', value, reverse]);
        return `hex:${value}:${reverse}`;
      },
    },
  };

  const result = convertContractParamFromJson({
    type: 'Array',
    value: [
      { type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' },
      { type: 'String', value: 'transfer' },
      { type: 'Integer', value: '12' },
      { type: 'ByteArray', value: '0x1234' },
      { type: 'Any', value: null },
    ],
  }, { sc, u });

  assert.equal(result.kind, 'array');
  assert.equal(result.items.length, 5);
  assert.deepEqual(calls[0], ['hash160', '13ef519c362973f9a34648a9eac5b71250b2a80a']);
  assert.deepEqual(calls[1], ['string', 'transfer']);
  assert.deepEqual(calls[2], ['integer', '12']);
  assert.deepEqual(calls[3], ['fromHex', '1234', true]);
  assert.deepEqual(calls[4], ['byteArray', 'hex:1234:true']);
  assert.deepEqual(calls[5], ['any', null]);
});

test('convertContractParamFromJson treats Struct as an ordered array payload for V3 user operations', () => {
  const calls = [];
  const sc = {
    ContractParam: {
      hash160(value) {
        calls.push(['hash160', value]);
        return { kind: 'hash160', value };
      },
      string(value) {
        calls.push(['string', value]);
        return { kind: 'string', value };
      },
      integer(value) {
        calls.push(['integer', value]);
        return { kind: 'integer', value };
      },
      byteArray(value) {
        calls.push(['byteArray', value]);
        return { kind: 'byteArray', value };
      },
      array(...items) {
        calls.push(['array', items]);
        return { kind: 'array', items };
      },
      any(value) {
        calls.push(['any', value]);
        return { kind: 'any', value };
      },
      boolean(value) {
        calls.push(['boolean', value]);
        return { kind: 'boolean', value };
      },
    },
  };
  const u = {
    HexString: {
      fromHex(value, reverse = false) {
        calls.push(['fromHex', value, reverse]);
        return `hex:${value}:${reverse}`;
      },
    },
  };

  const result = convertContractParamFromJson({
    type: 'Struct',
    value: [
      { type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' },
      { type: 'String', value: 'balanceOf' },
      { type: 'Array', value: [] },
      { type: 'Integer', value: '0' },
      { type: 'Integer', value: '1710000000' },
      { type: 'ByteArray', value: '0x' },
    ],
  }, { sc, u });

  assert.equal(result.kind, 'array');
  assert.equal(result.items.length, 6);
});
