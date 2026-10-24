import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildAaActionId } from '../src/services/aaTicketService.js';

const vector = {
  network: 'neo3-testnet',
  aaContract: `0x${'11'.repeat(20)}`,
  accountIdRaw: `0x${'22'.repeat(20)}`,
  executor: `0x${'33'.repeat(20)}`,
  sessionNonce: '7',
  expiresAt: '1735689600000',
};

test('buildAaActionId hashes raw account fields with the chain separators', async () => {
  const fields = [
    Buffer.from(vector.network),
    Buffer.from(vector.aaContract.slice(2), 'hex'),
    Buffer.from(vector.accountIdRaw.slice(2), 'hex'),
    Buffer.from(vector.executor.slice(2), 'hex'),
    Buffer.from(vector.sessionNonce),
    Buffer.from(vector.expiresAt),
  ];
  const expected = createHash('sha256').update(Buffer.concat(fields.flatMap((field, index) => index ? [Buffer.from([0x1f]), field] : [field]))).digest('hex');

  assert.equal(await buildAaActionId(vector), `aa_proxy:${expected}`);
  assert.notEqual(await buildAaActionId({ ...vector, accountIdRaw: `0x${'44'.repeat(20)}` }), `aa_proxy:${expected}`);
});

test('buildAaActionId rejects missing or non-hash160 account fields', async () => {
  await assert.rejects(buildAaActionId({ ...vector, accountIdRaw: 'shared-text' }), /20-byte hash160/);
  await assert.rejects(buildAaActionId({ ...vector, aaContract: undefined }), /20-byte hash160/);
});
