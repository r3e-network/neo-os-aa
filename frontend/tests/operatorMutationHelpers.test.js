import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeOperatorMutationPayload,
  importOperatorPrivateKey,
  importOperatorPublicKey,
  signOperatorMutationPayload,
  verifyOperatorMutationSignature,
  operatorPublicKeysMatch,
} from '../api/operatorMutationHelpers.js';

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
}

test('canonicalizeOperatorMutationPayload sorts object keys deterministically', () => {
  const a = canonicalizeOperatorMutationPayload({ b: 2, a: 1, nested: { y: 2, x: 1 } });
  const b = canonicalizeOperatorMutationPayload({ nested: { x: 1, y: 2 }, a: 1, b: 2 });

  assert.equal(a, b);
});

test('operator mutation signatures verify against the stored public key', async () => {
  const keyPair = await generateKeyPair();
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

  const privateKey = await importOperatorPrivateKey(privateJwk);
  const publicKey = await importOperatorPublicKey(publicJwk);
  const payload = canonicalizeOperatorMutationPayload({
    shareSlug: 'share-1',
    mutation: 'setStatus',
    payload: { status: 'broadcasted' },
    counter: 0,
  });

  const signature = await signOperatorMutationPayload(payload, privateKey);
  const verified = await verifyOperatorMutationSignature(payload, signature, publicKey);
  const tampered = await verifyOperatorMutationSignature(`${payload}!`, signature, publicKey);

  assert.equal(verified, true);
  assert.equal(tampered, false);
});

test('pinned-key comparison tolerates JSONB property order but rejects other keys and private material', async () => {
  const first = await generateKeyPair(); const second = await generateKeyPair();
  const publicJwk = await crypto.subtle.exportKey('jwk', first.publicKey);
  const reordered = Object.fromEntries(Object.entries(publicJwk).reverse());
  assert.equal(operatorPublicKeysMatch(publicJwk, reordered), true);
  assert.equal(operatorPublicKeysMatch(publicJwk, await crypto.subtle.exportKey('jwk', second.publicKey)), false);
  assert.equal(operatorPublicKeysMatch(publicJwk, await crypto.subtle.exportKey('jwk', first.privateKey)), false);
  assert.equal(operatorPublicKeysMatch(publicJwk, null), false);
});
