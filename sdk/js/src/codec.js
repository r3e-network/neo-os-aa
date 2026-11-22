/**
 * The v4 protocol codec, bound to Node's hash primitives.
 *
 * One instance is shared by every entry point (the native client, the operation
 * builder and the threshold tools) so that the bytes a
 * signature covers and the bytes the chain recomputes can never come from two
 * implementations that drifted apart.
 */

const crypto = require('node:crypto');
const { createProtocolCodec } = require('../../../shared/nativeSmartAccount.mjs');

/** sha256(hex) -> 32-byte hex digest. */
const sha256 = (hex) =>
  crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

/**
 * hash160(hex) -> ripemd160(sha256(bytes)) as 40 hex characters.
 *
 * This is the digest in natural order, exactly what `neon-js` `u.hash160`
 * returns and what `shared/registrationAccountId.mjs` expects. The v4 codec
 * reverses it where the wire needs raw UInt160 storage order (script bytes)
 * and leaves it alone where the protocol defines the display form as the
 * digest itself (account identity, §16.1).
 */
const hash160 = (hex) =>
  crypto
    .createHash('ripemd160')
    .update(crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest())
    .digest('hex');

const codec = createProtocolCodec({ sha256, hash160 });

module.exports = { codec, sha256, hash160 };
