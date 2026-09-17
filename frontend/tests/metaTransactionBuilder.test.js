import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';

import {
  buildExecuteUnifiedByAddressInvocation,
  buildExecuteUserOpInvocation,
  buildMetaTransactionTypedData,
  buildV3UserOperationTypedData,
  computeArgsHash,
  fetchV3ValidationPreview,
  fetchNonceForAddress,
  fetchV3Verifier,
  fetchV3Nonce,
  recoverPublicKeyFromTypedDataSignature,
  toCompactEcdsaSignature,
} from '../src/features/operations/metaTx.js';

test('buildMetaTransactionTypedData matches the contract field layout', () => {
  const params = {
    chainId: 894710606,
    verifyingContract: '49c095ce04d38642e39155f5481615c58227a498',
    accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a',
    targetContract: '49c095ce04d38642e39155f5481615c58227a498',
    method: 'getNonceForAccount',
    argsHashHex: 'ab'.repeat(32),
    nonce: 7,
    deadline: 1710000000,
  };

  const payload = buildMetaTransactionTypedData(params);

  assert.deepEqual(payload, {
    domain: {
      name: 'Neo N3 Abstract Account',
      version: '1',
      chainId: params.chainId,
      verifyingContract: `0x${params.verifyingContract}`,
    },
    types: {
      MetaTransaction: [
        { name: 'accountAddress', type: 'address' },
        { name: 'targetContract', type: 'address' },
        { name: 'methodHash', type: 'bytes32' },
        { name: 'argsHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: {
      accountAddress: `0x${params.accountAddressScriptHash}`,
      targetContract: `0x${params.targetContract}`,
      methodHash: keccak256(toUtf8Bytes(params.method)),
      argsHash: `0x${params.argsHashHex}`,
      nonce: String(params.nonce),
      deadline: String(params.deadline),
    },
  });
});

test('computeArgsHash invokes the contract helper and decodes the returned bytestring', async () => {
  const calls = [];
  const argsHashHex = 'cd'.repeat(32);
  const fetchImpl = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return {
      ok: true,
      async json() {
        return {
          result: {
            state: 'HALT',
            stack: [
              {
                type: 'ByteString',
                value: Buffer.from(argsHashHex, 'hex').toString('base64'),
              },
            ],
          },
        };
      },
    };
  };

  const result = await computeArgsHash({
    rpcUrl: 'https://rpc.example.org',
    aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    args: [{ type: 'String', value: 'hello' }],
    fetchImpl,
  });

  assert.equal(result, argsHashHex);
  assert.equal(calls[0][0], 'https://rpc.example.org');
  assert.equal(calls[0][1].method, 'invokefunction');
  assert.equal(calls[0][1].params[1], 'computeArgsHash');
  assert.deepEqual(calls[0][1].params[2], [{ type: 'Array', value: [{ type: 'String', value: 'hello' }] }]);
});

test('fetchNonceForAddress reads the current meta-tx nonce for an address signer pair', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        result: {
          state: 'HALT',
          stack: [{ type: 'Integer', value: '3' }],
        },
      };
    },
  });

  const nonce = await fetchNonceForAddress({
    rpcUrl: 'https://rpc.example.org',
    aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a',
    evmSignerAddress: '0x49c095ce04d38642e39155f5481615c58227a498',
    fetchImpl,
  });

  assert.equal(nonce, 3n);
});

test('buildExecuteUnifiedByAddressInvocation builds contract-aligned args for relay or export', () => {
  const invocation = buildExecuteUnifiedByAddressInvocation({
    aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a',
    evmPublicKeyHex: `04${'11'.repeat(64)}`,
    targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
    method: 'balanceOf',
    methodArgs: [{ type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' }],
    argsHashHex: 'ab'.repeat(32),
    nonce: 4n,
    deadline: 1710001234,
    signatureHex: '12'.repeat(64),
  });

  assert.equal(invocation.scriptHash, '5be915aea3ce85e4752d522632f0a9520e377aaf');
  assert.equal(invocation.operation, 'executeUnifiedByAddress');
  assert.deepEqual(invocation.args, [
    { type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' },
    { type: 'Hash160', value: '0xd2a4cff31913016155e38e474a2c06d08be276cf' },
    { type: 'String', value: 'balanceOf' },
    { type: 'Array', value: [{ type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' }] },
    { type: 'Array', value: [{ type: 'ByteArray', value: `0x04${'11'.repeat(64)}` }] },
    { type: 'ByteArray', value: `0x${'ab'.repeat(32)}` },
    { type: 'Integer', value: '4' },
    { type: 'Integer', value: '1710001234' },
    { type: 'Array', value: [{ type: 'ByteArray', value: `0x${'12'.repeat(64)}` }] },
  ]);
});

test('buildV3UserOperationTypedData matches the V3 verifier field layout', () => {
  const payload = buildV3UserOperationTypedData({
    chainId: 894710606,
    verifyingContract: '49c095ce04d38642e39155f5481615c58227a498',
    accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
    coreContractHash: 'dbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
    targetContract: '49c095ce04d38642e39155f5481615c58227a498',
    method: 'balanceOf',
    argsHashHex: 'ab'.repeat(32),
    nonce: 7,
    deadline: 1710000000,
  });

  assert.deepEqual(payload, {
    domain: {
      name: 'Neo N3 Abstract Account',
      version: '1',
      chainId: 894710606,
      verifyingContract: '0x49c095ce04d38642e39155f5481615c58227a498',
    },
    types: {
      UserOperation: [
        { name: 'accountId', type: 'bytes20' },
        { name: 'coreContract', type: 'bytes20' },
        { name: 'targetContract', type: 'address' },
        { name: 'method', type: 'string' },
        { name: 'argsHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: {
      accountId: '0xf951cd3eb5196dacde99b339c5dcca37ac38cc22',
      coreContract: '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
      targetContract: '0x49c095ce04d38642e39155f5481615c58227a498',
      method: 'balanceOf',
      argsHash: `0x${'ab'.repeat(32)}`,
      nonce: '7',
      deadline: '1710000000',
    },
  });
});

test('fetchV3Nonce reads the current V3 channel nonce', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        result: {
          state: 'HALT',
          stack: [{ type: 'Integer', value: '9' }],
        },
      };
    },
  });

  const nonce = await fetchV3Nonce({
    rpcUrl: 'https://rpc.example.org',
    aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
    channel: 0n,
    fetchImpl,
  });

  assert.equal(nonce, 9n);
});

test('fetchV3Verifier reads the bound verifier for a V3 account id', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        result: {
          state: 'HALT',
          stack: [{ type: 'Hash160', value: '0x49c095ce04d38642e39155f5481615c58227a498' }],
        },
      };
    },
  });

  const verifierHash = await fetchV3Verifier({
    rpcUrl: 'https://rpc.example.org',
    aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
    fetchImpl,
  });

  assert.equal(verifierHash, '49c095ce04d38642e39155f5481615c58227a498');
});

test('fetchV3ValidationPreview reads the structured validation preview for a user operation', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return {
      ok: true,
      async json() {
        return {
          result: {
            state: 'HALT',
            stack: [{
              type: 'Array',
              value: [
                { type: 'Boolean', value: true },
                { type: 'Boolean', value: true },
                { type: 'Boolean', value: false },
                { type: 'Hash160', value: '0x0000000000000000000000000000000000000000' },
                { type: 'Hash160', value: '0x2222222222222222222222222222222222222222' },
              ],
            }],
          },
        };
      },
    };
  };

  const preview = await fetchV3ValidationPreview({
    rpcUrl: 'https://rpc.example.org',
    aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
    targetContract: '49c095ce04d38642e39155f5481615c58227a498',
    method: 'transfer',
    args: [{ type: 'String', value: 'ok' }],
    nonce: 9n,
    deadline: 1710001234,
    fetchImpl,
  });

  assert.deepEqual(preview, {
    deadlineValid: true,
    nonceAcceptable: true,
    hasVerifier: false,
    verifier: '0000000000000000000000000000000000000000',
    hook: '2222222222222222222222222222222222222222',
  });
  assert.equal(calls[0][1].params[1], 'previewUserOpValidation');
});

test('buildExecuteUserOpInvocation builds V3 struct args', () => {
  const invocation = buildExecuteUserOpInvocation({
    aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
    targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
    method: 'balanceOf',
    methodArgs: [{ type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' }],
    nonce: 4n,
    deadline: 1710001234,
    signatureHex: '12'.repeat(64),
  });

  assert.equal(invocation.scriptHash, '5be915aea3ce85e4752d522632f0a9520e377aaf');
  assert.equal(invocation.operation, 'executeUserOp');
  assert.deepEqual(invocation.args, [
    { type: 'Hash160', value: '0xf951cd3eb5196dacde99b339c5dcca37ac38cc22' },
    {
      type: 'Struct',
      value: [
        { type: 'Hash160', value: '0xd2a4cff31913016155e38e474a2c06d08be276cf' },
        { type: 'String', value: 'balanceOf' },
        { type: 'Array', value: [{ type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' }] },
        { type: 'Integer', value: '4' },
        { type: 'Integer', value: '1710001234' },
        { type: 'ByteArray', value: `0x${'12'.repeat(64)}` },
      ],
    },
  ]);
});

test('toCompactEcdsaSignature drops the recovery byte for V3 contract submission', async () => {
  const signer = Wallet.createRandom();
  const typedData = buildV3UserOperationTypedData({
    chainId: 894710606,
    verifyingContract: '49c095ce04d38642e39155f5481615c58227a498',
    accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
    coreContractHash: 'dbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
    targetContract: '49c095ce04d38642e39155f5481615c58227a498',
    method: 'balanceOf',
    argsHashHex: 'ab'.repeat(32),
    nonce: 7,
    deadline: 1710000000,
  });
  const signature = await signer.signTypedData(typedData.domain, typedData.types, typedData.message);
  const compact = toCompactEcdsaSignature(signature);

  assert.equal(compact.length, 128);
  assert.equal(compact, `${signature.slice(2, 66)}${signature.slice(66, 130)}`);
});

test('recoverPublicKeyFromTypedDataSignature returns the uncompressed signer key', async () => {
  const wallet = Wallet.createRandom();
  const typedData = buildMetaTransactionTypedData({
    chainId: 894710606,
    verifyingContract: '49c095ce04d38642e39155f5481615c58227a498',
    accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a',
    targetContract: '49c095ce04d38642e39155f5481615c58227a498',
    method: 'getNonceForAccount',
    argsHashHex: 'ab'.repeat(32),
    nonce: 7,
    deadline: 1710000000,
  });
  const signature = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);

  const publicKey = recoverPublicKeyFromTypedDataSignature({
    typedData,
    signature,
  });

  assert.equal(publicKey.toLowerCase(), wallet.signingKey.publicKey.toLowerCase());
});
