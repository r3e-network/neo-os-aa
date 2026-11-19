// Cross-package gate for the shared meta-tx core (shared/metaTxCore.mjs):
// the frontend, the CJS SDK and the SDK UserOpBuilder must produce
// byte-identical v4 EIP-712 digests for the same operation, and both must
// decode real-node Hash160 ByteStrings to big-endian display hex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TypedDataEncoder } from 'ethers';

import {
  buildUserOperationTypedData,
  decodeHash160Stack,
} from '../src/features/operations/metaTx.js';

const require = createRequire(import.meta.url);
const sdkMetaTx = require('../../sdk/js/src/metaTx.js');
const { createUserOpBuilder } = require('../../sdk/js/src/UserOpBuilder.js');

const USER_OP = {
  chainId: 894710606,
  accountId: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
  validatorHash: 'b4107cb2cb4bace0ebe15bc4842890734abe133a',
  coreContractHash: 'dbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
  targetContract: '49c095ce04d38642e39155f5481615c58227a498',
  method: 'transfer',
  argsHashHex: 'ab'.repeat(32),
  operationDigest: 'cd'.repeat(32),
  nonce: 7,
  deadline: 1700000000000,
  validatorId: 2,
  credentialGeneration: 1,
  authorityEpoch: 0,
  configurationNonce: 0,
};

function hashTypedData(typedData) {
  return TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
}

function typedDataParams() {
  return {
    chainId: USER_OP.chainId,
    verifyingContract: USER_OP.validatorHash,
    accountId: USER_OP.accountId,
    coreContractHash: USER_OP.coreContractHash,
    validatorId: USER_OP.validatorId,
    targetContract: USER_OP.targetContract,
    method: USER_OP.method,
    argsHashHex: USER_OP.argsHashHex,
    nonce: USER_OP.nonce,
    deadline: USER_OP.deadline,
    operationDigest: USER_OP.operationDigest,
  };
}

test('frontend, SDK and UserOpBuilder produce byte-identical v4 EIP-712 digests', () => {
  const params = typedDataParams();
  const frontendTypedData = buildUserOperationTypedData(params);
  const sdkTypedData = sdkMetaTx.buildUserOperationTypedData(params);

  const builder = createUserOpBuilder({
    networkMagic: USER_OP.chainId,
    coreContractHash: USER_OP.coreContractHash,
    accountId: USER_OP.accountId,
  })
    .setTarget(USER_OP.targetContract)
    .setMethod(USER_OP.method)
    .setRouting({
      validatorId: USER_OP.validatorId,
      credentialGeneration: USER_OP.credentialGeneration,
      authorityEpoch: USER_OP.authorityEpoch,
      configurationNonce: USER_OP.configurationNonce,
    })
    .setNonceSubkey('00'.repeat(32))
    .setNonce(USER_OP.nonce)
    .setDeadline(USER_OP.deadline)
    .setSignature('11'.repeat(64));
  const builderDigest = builder.digest();

  assert.deepEqual(frontendTypedData, sdkTypedData);
  assert.equal(
    hashTypedData(frontendTypedData),
    hashTypedData(sdkTypedData),
    'frontend and SDK must sign the same v4 digest',
  );
  assert.match(builderDigest, /^[0-9a-f]{64}$/, 'the SDK builder produces the §4.3 digest');
});

test('frontend builders carry the shared v4 validation guards', () => {
  const base = typedDataParams();

  assert.throws(
    () => buildUserOperationTypedData({ ...base, argsHashHex: '' }),
    { code: 'METATX_ARGS_HASH_INVALID' },
    'an empty args hash must never reach the signed message',
  );
  assert.throws(
    () => buildUserOperationTypedData({ ...base, operationDigest: '' }),
    { code: 'METATX_OPERATION_DIGEST_INVALID' },
    'the §4.3 digest is a required signed field',
  );
  assert.throws(
    () => buildUserOperationTypedData({ ...base, nonce: null }),
    { code: 'METATX_NONCE_REQUIRED' },
  );
  assert.throws(
    () => buildUserOperationTypedData({ ...base, deadline: undefined }),
    { code: 'METATX_DEADLINE_REQUIRED' },
  );
  assert.throws(
    () => buildUserOperationTypedData({ ...base, nonce: 1n << 255n }),
    { code: 'METATX_INTEGER_DOMAIN_INVALID' },
    'the frontend must reject the NeoVM signed-integer upper half before signing',
  );
  assert.throws(
    () => sdkMetaTx.buildUserOperationTypedData({ ...base, deadline: 1n << 255n }),
    { code: 'ENC_002' },
    'the SDK must reject the same signed-integer upper half',
  );
  assert.throws(
    () => buildUserOperationTypedData({ ...base, coreContractHash: '' }),
    { code: 'METATX_CORE_CONTRACT_REQUIRED' },
    'an SA core hash is required to prevent cross-core signature replay',
  );
});

// Captured from a real node: a UInt160 arrives as a base64 ByteString carrying
// the internal little-endian bytes.
const REAL_NODE_BYTESTRING_B64 = '0lDz2Bn8Nxri/znKgUi+u+oiTE4=';
const REAL_NODE_DISPLAY_HEX = '4e4c22eabbbe4881ca39ffe21a37fc19d8f350d2';

test('decodeHash160Stack reverses real-node little-endian ByteStrings to display hex', () => {
  const decoded = decodeHash160Stack({ type: 'ByteString', value: REAL_NODE_BYTESTRING_B64 });
  assert.equal(decoded, REAL_NODE_DISPLAY_HEX,
    'ByteString UInt160s must decode to big-endian display hex, not raw node bytes');

  // SDK and frontend must share one decode convention.
  assert.equal(
    decoded,
    sdkMetaTx.decodeHash160Stack({ type: 'ByteString', value: REAL_NODE_BYTESTRING_B64 }),
  );
});
