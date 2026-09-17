// Cross-package gate for the shared meta-tx core (shared/metaTxCore.mjs):
// the frontend and the CJS SDK must produce byte-identical EIP-712 digests
// for the same user operation, and both must decode real-node Hash160
// ByteStrings to big-endian display hex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TypedDataEncoder } from 'ethers';

import {
  buildMetaTransactionTypedData,
  buildV3UserOperationTypedData,
  decodeHash160Stack,
  fetchV3Verifier,
} from '../src/features/operations/metaTx.js';

const require = createRequire(import.meta.url);
const sdkMetaTx = require('../../sdk/js/src/metaTx.js');
const { createUserOpBuilder } = require('../../sdk/js/src/UserOpBuilder.js');

const USER_OP = {
  chainId: 894710606,
  accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
  verifierHash: 'b4107cb2cb4bace0ebe15bc4842890734abe133a',
  coreContractHash: 'dbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
  masterHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
  accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a',
  targetContract: '49c095ce04d38642e39155f5481615c58227a498',
  method: 'transfer',
  argsHashHex: 'ab'.repeat(32),
  nonce: 7,
  deadline: 1700000000000,
};

function hashTypedData(typedData) {
  return TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
}

test('frontend, SDK, and UserOpBuilder produce byte-identical V3 EIP-712 digests', () => {
  const frontendTypedData = buildV3UserOperationTypedData({
    chainId: USER_OP.chainId,
    verifyingContract: USER_OP.verifierHash,
    accountIdHash: USER_OP.accountIdHash,
    coreContractHash: USER_OP.coreContractHash,
    targetContract: USER_OP.targetContract,
    method: USER_OP.method,
    argsHashHex: USER_OP.argsHashHex,
    nonce: USER_OP.nonce,
    deadline: USER_OP.deadline,
  });
  const sdkTypedData = sdkMetaTx.buildV3UserOperationTypedData({
    chainId: USER_OP.chainId,
    verifyingContract: USER_OP.verifierHash,
    accountIdHash: USER_OP.accountIdHash,
    coreContractHash: USER_OP.coreContractHash,
    targetContract: USER_OP.targetContract,
    method: USER_OP.method,
    argsHashHex: USER_OP.argsHashHex,
    nonce: USER_OP.nonce,
    deadline: USER_OP.deadline,
  });
  const builderTypedData = createUserOpBuilder()
    .setAccountId(USER_OP.accountIdHash)
    .setTarget(USER_OP.targetContract)
    .setMethod(USER_OP.method)
    .setVerifier(USER_OP.verifierHash)
    .setCoreContract(USER_OP.coreContractHash)
    .setChainId(USER_OP.chainId)
    .setNonce(USER_OP.nonce)
    .setDeadline(USER_OP.deadline)
    .buildEIP712(USER_OP.argsHashHex);

  assert.deepEqual(frontendTypedData, sdkTypedData);
  assert.equal(hashTypedData(frontendTypedData), hashTypedData(sdkTypedData),
    'frontend and SDK must sign the same V3 digest');
  assert.equal(hashTypedData(frontendTypedData), hashTypedData(builderTypedData),
    'UserOpBuilder.buildEIP712 must sign the same V3 digest');
});

test('frontend, SDK, and UserOpBuilder produce byte-identical legacy EIP-712 digests', () => {
  const params = {
    chainId: USER_OP.chainId,
    verifyingContract: USER_OP.masterHash,
    accountAddressScriptHash: USER_OP.accountAddressScriptHash,
    targetContract: USER_OP.targetContract,
    method: USER_OP.method,
    argsHashHex: USER_OP.argsHashHex,
    nonce: USER_OP.nonce,
    deadline: USER_OP.deadline,
  };

  const frontendTypedData = buildMetaTransactionTypedData(params);
  const sdkTypedData = sdkMetaTx.buildMetaTransactionTypedData(params);
  const builderTypedData = createUserOpBuilder()
    .setAccountAddressScriptHash(USER_OP.accountAddressScriptHash)
    .setTarget(USER_OP.targetContract)
    .setMethod(USER_OP.method)
    .setChainId(USER_OP.chainId)
    .setNonce(USER_OP.nonce)
    .setDeadline(USER_OP.deadline)
    .buildLegacyEIP712(USER_OP.argsHashHex, USER_OP.masterHash);

  assert.deepEqual(frontendTypedData, sdkTypedData);
  assert.equal(hashTypedData(frontendTypedData), hashTypedData(sdkTypedData),
    'frontend and SDK must sign the same legacy digest');
  assert.equal(hashTypedData(frontendTypedData), hashTypedData(builderTypedData),
    'UserOpBuilder.buildLegacyEIP712 must sign the same legacy digest');
  assert.equal(frontendTypedData.domain.verifyingContract, `0x${USER_OP.masterHash}`,
    'legacy flow verifies against the master contract');
});

test('frontend builders carry the SDK validation guards', () => {
  const base = {
    chainId: USER_OP.chainId,
    verifyingContract: USER_OP.verifierHash,
    accountIdHash: USER_OP.accountIdHash,
    coreContractHash: USER_OP.coreContractHash,
    targetContract: USER_OP.targetContract,
    method: USER_OP.method,
    argsHashHex: USER_OP.argsHashHex,
    nonce: USER_OP.nonce,
    deadline: USER_OP.deadline,
  };

  assert.throws(
    () => buildV3UserOperationTypedData({ ...base, argsHashHex: '' }),
    { code: 'METATX_ARGS_HASH_INVALID' },
    'an empty args hash must never reach the signed message',
  );
  assert.throws(
    () => buildV3UserOperationTypedData({ ...base, nonce: null }),
    { code: 'METATX_NONCE_REQUIRED' },
  );
  assert.throws(
    () => buildV3UserOperationTypedData({ ...base, deadline: undefined }),
    { code: 'METATX_DEADLINE_REQUIRED' },
  );
  assert.throws(
    () => buildV3UserOperationTypedData({ ...base, coreContractHash: '' }),
    { code: 'METATX_CORE_CONTRACT_REQUIRED' },
    'an AA core hash is required to prevent cross-core signature replay',
  );
  assert.throws(
    () => buildMetaTransactionTypedData({
      ...base,
      accountAddressScriptHash: USER_OP.accountAddressScriptHash,
      argsHashHex: 'abcd',
    }),
    { code: 'METATX_ARGS_HASH_INVALID' },
  );
});

// Captured from a real testnet node: getVerifier returns the UInt160 as a
// base64 ByteString carrying the internal little-endian bytes. The display
// hash of the deployed TEEVerifier is 0x4e4c22ea...d8f350d2.
const REAL_NODE_VERIFIER_BYTESTRING_B64 = '0lDz2Bn8Nxri/znKgUi+u+oiTE4=';
const REAL_NODE_VERIFIER_DISPLAY_HEX = '4e4c22eabbbe4881ca39ffe21a37fc19d8f350d2';

test('decodeHash160Stack reverses real-node little-endian ByteStrings to display hex', () => {
  const decoded = decodeHash160Stack({
    type: 'ByteString',
    value: REAL_NODE_VERIFIER_BYTESTRING_B64,
  });
  assert.equal(decoded, REAL_NODE_VERIFIER_DISPLAY_HEX,
    'ByteString UInt160s must decode to big-endian display hex, not raw node bytes');

  // SDK and frontend must share one decode convention.
  assert.equal(
    decoded,
    sdkMetaTx.decodeHash160Stack({ type: 'ByteString', value: REAL_NODE_VERIFIER_BYTESTRING_B64 }),
  );
});

test('fetchV3Verifier surfaces the big-endian display hash from real-node wire encoding', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        result: {
          state: 'HALT',
          stack: [{ type: 'ByteString', value: REAL_NODE_VERIFIER_BYTESTRING_B64 }],
        },
      };
    },
  });

  const verifierHash = await fetchV3Verifier({
    rpcUrl: 'https://rpc.example.org',
    aaContractHash: USER_OP.masterHash,
    accountIdHash: USER_OP.accountIdHash,
    fetchImpl,
  });

  assert.equal(verifierHash, REAL_NODE_VERIFIER_DISPLAY_HEX,
    'the EIP-712 verifyingContract must be fed the display-form verifier hash');
});
