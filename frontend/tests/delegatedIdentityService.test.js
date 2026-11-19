import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDelegatedIdentityProofHex,
  buildDelegatedIdentityParamsHex,
  formatDelegatedIdentityTicket,
} from '../src/services/delegatedIdentityService.js';

test('buildDelegatedIdentityParamsHex encodes version public key provider and master nullifier', () => {
  const paramsHex = buildDelegatedIdentityParamsHex({
    publicKey: `02${'11'.repeat(32)}`,
    provider: 'web3auth',
    masterNullifier: `0x${'22'.repeat(32)}`,
  });

  assert.equal(paramsHex.startsWith('01'), true);
  assert.equal(paramsHex.slice(2, 4), '21');
  assert.match(paramsHex, /7765623361757468/i);
  assert.equal(paramsHex.endsWith('22'.repeat(32)), true);
});

test('buildDelegatedIdentityProofHex encodes version provider nullifiers and signature', () => {
  const proofHex = buildDelegatedIdentityProofHex({
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

test('delegated identity provider bound is measured in UTF-8 bytes', () => {
  assert.throws(
    () => buildDelegatedIdentityParamsHex({
      publicKey: `02${'11'.repeat(32)}`,
      provider: 'é'.repeat(128),
      masterNullifier: `0x${'22'.repeat(32)}`,
    }),
    /1 and 255 bytes/,
  );
});

test('formatDelegatedIdentityTicket derives validator params and proof blobs from Morpheus response fields', () => {
  const formatted = formatDelegatedIdentityTicket({
    provider: 'web3auth',
    public_key: `02${'11'.repeat(32)}`,
    master_nullifier: `0x${'22'.repeat(32)}`,
    action_nullifier: `0x${'33'.repeat(32)}`,
    signature: `0x${'44'.repeat(64)}`,
  });

  assert.equal(formatted.provider, 'web3auth');
  assert.equal(formatted.delegatedIdentityParamsHex.startsWith('01'), true);
  assert.equal(formatted.proofHex.startsWith('01'), true);
  assert.equal(formatted.delegatedIdentityParamsHex.endsWith('22'.repeat(32)), true);
  assert.equal(formatted.proofHex.includes('33'.repeat(32)), true);
  assert.equal(formatted.proofHex.endsWith('44'.repeat(64)), true);
});
