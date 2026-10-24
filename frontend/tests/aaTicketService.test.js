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
