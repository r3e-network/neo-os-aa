#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getBytes, keccak256, Signature, SigningKey } from 'ethers';

function signingKey(value) {
  if (value instanceof SigningKey) return value;
  if (typeof value === 'string') return new SigningKey(value);
  throw new TypeError('a SigningKey or a 32-byte private-key hex string is required');
}

/**
 * Returns the 65-byte SEC1 uncompressed secp256k1 public key.
 */
export function publicKeyBytes(key) {
  const bytes = getBytes(signingKey(key).publicKey);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('unexpected secp256k1 public-key encoding');
  }
  return bytes;
}

/**
 * Signs keccak256(payload), matching Neo CryptoLib's secp256k1Keccak256 mode.
 * The returned signature is the raw 64-byte r || s form consumed by the
 * SmartAccount UserOperation verifier.
 */
export function signPayloadBytes(key, payload) {
  const message = payload instanceof Uint8Array ? payload : getBytes(payload);
  const signature = Signature.from(signingKey(key).sign(keccak256(message)));
  const r = getBytes(signature.r);
  const s = getBytes(signature.s);
  const result = new Uint8Array(64);
  result.set(r, 0);
  result.set(s, 32);
  return result;
}

/**
 * Signs a 32-byte digest directly and returns recoverable r || s || v.
 * This is the ERC-1271 message-signature form.
 */
export function signDigestBytes(key, digest) {
  const bytes = digest instanceof Uint8Array ? digest : getBytes(digest);
  if (bytes.length !== 32) throw new TypeError('digest must be exactly 32 bytes');
  return getBytes(Signature.from(signingKey(key).sign(bytes)).serialized);
}

/**
 * Signs a 32-byte digest directly and returns 64-byte EIP-2098 compact form.
 */
export function signDigestCompactBytes(key, digest) {
  const bytes = digest instanceof Uint8Array ? digest : getBytes(digest);
  if (bytes.length !== 32) throw new TypeError('digest must be exactly 32 bytes');
  return getBytes(Signature.from(signingKey(key).sign(bytes)).compactSerialized);
}

function response(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function serve() {
  const key = new SigningKey(randomBytes(32));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  lines.on('line', (line) => {
    try {
      const request = JSON.parse(line);
      if (request.op === 'publicKey') {
        response({ publicKey: key.publicKey });
        return;
      }
      if (request.op === 'sign') {
        if (typeof request.payload !== 'string') {
          throw new TypeError('payload must be base64');
        }
        const signature = signPayloadBytes(key, new Uint8Array(Buffer.from(request.payload, 'base64')));
        response({ signature: `0x${Buffer.from(signature).toString('hex')}` });
        return;
      }
      if (request.op === 'signDigest') {
        if (typeof request.digest !== 'string') {
          throw new TypeError('digest must be base64');
        }
        const signature = signDigestBytes(key, new Uint8Array(Buffer.from(request.digest, 'base64')));
        response({ signature: `0x${Buffer.from(signature).toString('hex')}` });
        return;
      }
      if (request.op === 'signDigestCompact') {
        if (typeof request.digest !== 'string') {
          throw new TypeError('digest must be base64');
        }
        const signature = signDigestCompactBytes(key, new Uint8Array(Buffer.from(request.digest, 'base64')));
        response({ signature: `0x${Buffer.from(signature).toString('hex')}` });
        return;
      }
      throw new TypeError('unsupported operation');
    } catch (error) {
      response({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] !== 'serve') {
    console.error('usage: web3auth-signer.mjs serve');
    process.exitCode = 2;
  } else {
    serve();
  }
}
