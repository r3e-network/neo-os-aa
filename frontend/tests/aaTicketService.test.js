import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildAaActionId, toNeoInternalHex } from '../src/services/aaTicketService.js';

const vector = {
  network: 'neo3-testnet',
  aaContractInternal: toNeoInternalHex('0x000102030405060708090a0b0c0d0e0f10111213'),
  accountIdRawInternal: toNeoInternalHex('0x1415161718191a1b1c1d1e1f2021222324252627'),
  executorInternal: toNeoInternalHex('0x28292a2b2c2d2e2f303132333435363738393a3b'),
  sessionNonce: '7',
  expiresAt: '1735689600000',
};

test('toNeoInternalHex reverses the complete display hash', () => {
  assert.equal(
    toNeoInternalHex('0x000102030405060708090a0b0c0d0e0f10111213'),
    '0x131211100f0e0d0c0b0a09080706050403020100',
  );
  assert.throws(() => toNeoInternalHex('shared-text'), /20-byte hash160/);
});

test('buildAaActionId hashes raw account fields with the chain separators', async () => {
  const fields = [
    Buffer.from(vector.network),
    Buffer.from(vector.aaContractInternal.slice(2), 'hex'),
    Buffer.from(vector.accountIdRawInternal.slice(2), 'hex'),
    Buffer.from(vector.executorInternal.slice(2), 'hex'),
    Buffer.from(vector.sessionNonce),
    Buffer.from(vector.expiresAt),
  ];
  const expected = createHash('sha256').update(Buffer.concat(fields.flatMap((field, index) => index ? [Buffer.from([0x1f]), field] : [field]))).digest('hex');

  assert.equal(await buildAaActionId(vector), `aa_proxy:${expected}`);
  assert.notEqual(await buildAaActionId({ ...vector, accountIdRawInternal: toNeoInternalHex(`0x${'44'.repeat(20)}`) }), `aa_proxy:${expected}`);
});

test('buildAaActionId rejects missing or non-hash160 account fields', async () => {
  await assert.rejects(buildAaActionId({ ...vector, accountIdRawInternal: 'shared-text' }), /20-byte hash160/);
  await assert.rejects(buildAaActionId({ ...vector, aaContractInternal: undefined }), /20-byte hash160/);
});

function rawActionId(input) {
  const fields = [
    Buffer.from(input.network, 'utf8'),
    Buffer.from(input.aaContractInternal.replace(/^0x/i, ''), 'hex'),
    Buffer.from(input.accountIdRawInternal.replace(/^0x/i, ''), 'hex'),
    Buffer.from(input.executorInternal.replace(/^0x/i, ''), 'hex'),
    Buffer.from(String(input.sessionNonce ?? '0')),
    Buffer.from(String(input.expiresAt)),
  ];
  const material = Buffer.concat(fields.flatMap((field, index) => index ? [Buffer.from([0x1f]), field] : [field]));
  return `aa_proxy:${createHash('sha256').update(material).digest('hex')}`;
}

test('F3 action-ID witnesses preserve opaque stored network bytes', async () => {
  const witness = {
    aaContractInternal: '01'.repeat(20),
    accountIdRawInternal: '23'.repeat(20),
    executorInternal: '45'.repeat(20),
    sessionNonce: '0',
    expiresAt: '1800000000000',
  };
  for (const network of ['neo3-testnet', 'neo3-testnet ', ' neo3-testnet', ' neo3-testnet ', '\tneo3-testnet\n', ' e\u0301 ']) {
    const input = { ...witness, network };
    assert.equal(await buildAaActionId(input), rawActionId(input), JSON.stringify(network));
  }
});

test('F3 action-ID accepts original 255-byte UTF-8 fields and retains the omitted-network default', async () => {
  for (const network of ['n', 'n'.repeat(255), ` ${'n'.repeat(253)} `, '界'.repeat(85), `${'😀'.repeat(63)}abc`]) {
    assert.ok(Buffer.byteLength(network) <= 255);
    const input = { ...vector, network };
    assert.equal(await buildAaActionId(input), rawActionId(input));
  }
  const { network, ...withoutNetwork } = vector;
  assert.equal(await buildAaActionId(withoutNetwork), rawActionId({ ...vector, network: 'neo_n3' }));
});

test('F3 action-ID rejects blank nonstring and oversized network without a fallback identity', async () => {
  const invalid = ['', ' ', '\t\n', null, false, 0, 7, {}, [], 'n'.repeat(256), ` ${'n'.repeat(254)} `, '界'.repeat(86), '😀'.repeat(64)];
  for (const network of invalid) {
    await assert.rejects(buildAaActionId({ ...vector, network }), /network (is required|must be at most 255 UTF-8 bytes)/, JSON.stringify(network));
  }
});
