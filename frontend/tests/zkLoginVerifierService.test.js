import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildZkLoginProofHex,
  buildZkLoginVerifierParamsHex,
  formatZkLoginTicket,
} from '../src/services/zkLoginVerifierService.js';

test('buildZkLoginVerifierParamsHex encodes version public key provider and master nullifier', () => {
  const paramsHex = buildZkLoginVerifierParamsHex({
    publicKey: `02${'11'.repeat(32)}`,
    provider: 'web3auth',
    masterNullifier: `0x${'22'.repeat(32)}`,
  });

  assert.equal(paramsHex.startsWith('01'), true);
  assert.equal(paramsHex.slice(2, 4), '21');
  assert.match(paramsHex, /7765623361757468/i);
  assert.equal(paramsHex.endsWith('22'.repeat(32)), true);
});

test('buildZkLoginProofHex encodes version provider nullifiers and signature', () => {
  const proofHex = buildZkLoginProofHex({
    provider: 'web3auth',
    masterNullifier: `0x${'22'.repeat(32)}`,
    actionNullifier: `0x${'33'.repeat(32)}`,
    signature: `0x${'44'.repeat(64)}`,
  });

  assert.equal(proofHex.startsWith('01'), true);
  assert.match(proofHex, /7765623361757468/i);
  assert.equal(proofHex.includes('22'.repeat(32)), true);
  assert.equal(proofHex.includes('33'.repeat(32)), true);
  assert.equal(proofHex.endsWith('44'.repeat(64)), true);
});

test('zkLogin provider bound is measured in UTF-8 bytes', () => {
  assert.throws(
    () => buildZkLoginVerifierParamsHex({
      publicKey: `02${'11'.repeat(32)}`,
      provider: 'é'.repeat(128),
      masterNullifier: `0x${'22'.repeat(32)}`,
    }),
    /1 and 255 bytes/,
  );
});

test('formatZkLoginTicket derives verifier params and proof blobs from Morpheus response fields', () => {
  const formatted = formatZkLoginTicket({
    provider: 'web3auth',
    public_key: `02${'11'.repeat(32)}`,
    master_nullifier: `0x${'22'.repeat(32)}`,
    action_nullifier: `0x${'33'.repeat(32)}`,
    signature: `0x${'44'.repeat(64)}`,
  });

  assert.equal(formatted.provider, 'web3auth');
  assert.equal(formatted.verifierParamsHex.startsWith('01'), true);
  assert.equal(formatted.proofHex.startsWith('01'), true);
  assert.equal(formatted.verifierParamsHex.endsWith('22'.repeat(32)), true);
  assert.equal(formatted.proofHex.includes('33'.repeat(32)), true);
  assert.equal(formatted.proofHex.endsWith('44'.repeat(64)), true);
});
