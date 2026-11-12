import test from 'node:test';
import assert from 'node:assert/strict';
import { SigningKey } from 'ethers';

import {
  publicKeyBytes,
  signDigestCompactBytes,
  signDigestBytes,
  signPayloadBytes,
} from '../scripts/web3auth-signer.mjs';

const PRIVATE_KEY_ONE = `0x${'00'.repeat(31)}01`;
const VECTOR_PAYLOAD = new TextEncoder().encode('neo-smartaccount-web3auth-vector');

test('secp256k1 private scalar one produces the canonical uncompressed public key', () => {
  const publicKey = Buffer.from(publicKeyBytes(PRIVATE_KEY_ONE)).toString('hex');
  assert.equal(
    publicKey,
    '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
      + '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
  );
});

test('Web3Auth payload signing hashes with keccak256 and emits raw r || s', () => {
  const signature = signPayloadBytes(PRIVATE_KEY_ONE, VECTOR_PAYLOAD);
  assert.equal(signature.length, 64);
  assert.equal(
    Buffer.from(signature).toString('hex'),
    '2e19a1f06294d75f776b185d328023bc71fd9c3d7793d09c3135710d04c1dd6f'
      + '1a1a5582396c0aee23f0c38a5f5bd615a88ddab35851ef6c1b1ff8a8fa7f04d5',
  );

  const recovered = SigningKey.recoverPublicKey(
    '0x87743b5f0f7c48ad7f113e7db785011b9b1691f192ad08a8fdb02521d2bd62c6',
    `0x${Buffer.from(signature).toString('hex')}${'1b'}`,
  );
  assert.equal(recovered, new SigningKey(PRIVATE_KEY_ONE).publicKey);
});

test('the helper rejects non-key inputs instead of silently signing', () => {
  assert.throws(() => publicKeyBytes({}), /SigningKey or a 32-byte private-key hex string/);
  assert.throws(() => signPayloadBytes({}, VECTOR_PAYLOAD), /SigningKey or a 32-byte private-key hex string/);
});

test('ERC-1271 signatures use recoverable r || s || v without rehashing the digest', () => {
  const digest = Buffer.from('87743b5f0f7c48ad7f113e7db785011b9b1691f192ad08a8fdb02521d2bd62c6', 'hex');
  const signature = signDigestBytes(PRIVATE_KEY_ONE, digest);
  assert.equal(signature.length, 65);
  assert.equal(
    SigningKey.recoverPublicKey(`0x${digest.toString('hex')}`, `0x${Buffer.from(signature).toString('hex')}`),
    new SigningKey(PRIVATE_KEY_ONE).publicKey,
  );
});

test('ERC-1271 compact signatures use EIP-2098 yParityAndS encoding', () => {
  const digest = Buffer.from('87743b5f0f7c48ad7f113e7db785011b9b1691f192ad08a8fdb02521d2bd62c6', 'hex');
  const signature = signDigestCompactBytes(PRIVATE_KEY_ONE, digest);
  assert.equal(signature.length, 64);
  assert.equal(
    SigningKey.recoverPublicKey(`0x${digest.toString('hex')}`, `0x${Buffer.from(signature).toString('hex')}`),
    new SigningKey(PRIVATE_KEY_ONE).publicKey,
  );
});
