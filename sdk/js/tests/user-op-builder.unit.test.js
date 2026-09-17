const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createUserOpBuilder, UserOperationBuilder } = require('../src/UserOpBuilder');
const {
  buildMetaTransactionTypedData,
  buildV3UserOperationTypedData,
} = require('../src/metaTx');

const CHAIN_ID = 894710606;
const ACCOUNT_ID_HASH = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const VERIFIER_HASH = 'b4107cb2cb4bace0ebe15bc4842890734abe133a';
const CORE_CONTRACT_HASH = 'dbf38e7b2117186bf7a5e17ead702322c0c5b6f2';
const MASTER_HASH = '5be915aea3ce85e4752d522632f0a9520e377aaf';
const TARGET_CONTRACT = '49c095ce04d38642e39155f5481615c58227a498';
const ARGS_HASH = 'ab'.repeat(32);
const DEADLINE = 1700000000000;

function v3Builder() {
  return createUserOpBuilder()
    .setAccountId(ACCOUNT_ID_HASH)
    .setTarget(TARGET_CONTRACT)
    .setMethod('transfer')
    .setVerifier(VERIFIER_HASH)
    .setCoreContract(CORE_CONTRACT_HASH)
    .setChainId(CHAIN_ID)
    .setNonce(7)
    .setDeadline(DEADLINE);
}

test('buildEIP712 delegates to the shared V3 typed-data builder', () => {
  const builderTypedData = v3Builder().buildEIP712(ARGS_HASH);
  const sharedTypedData = buildV3UserOperationTypedData({
    chainId: String(CHAIN_ID),
    verifyingContract: VERIFIER_HASH,
    accountIdHash: ACCOUNT_ID_HASH,
    coreContractHash: CORE_CONTRACT_HASH,
    targetContract: TARGET_CONTRACT,
    method: 'transfer',
    argsHashHex: ARGS_HASH,
    nonce: 7,
    deadline: DEADLINE,
  });

  assert.deepEqual(builderTypedData, sharedTypedData);
  assert.equal(
    ethers.TypedDataEncoder.hash(builderTypedData.domain, builderTypedData.types, builderTypedData.message),
    ethers.TypedDataEncoder.hash(sharedTypedData.domain, sharedTypedData.types, sharedTypedData.message),
    'builder and shared metaTx builder must produce byte-identical EIP-712 digests',
  );
});

test('buildLegacyEIP712 uses the explicit master contract as verifyingContract', () => {
  const builder = createUserOpBuilder()
    .setAccountAddressScriptHash('13ef519c362973f9a34648a9eac5b71250b2a80a')
    .setTarget(TARGET_CONTRACT)
    .setMethod('transfer')
    .setVerifier(VERIFIER_HASH)
    .setCoreContract(CORE_CONTRACT_HASH)
    .setChainId(CHAIN_ID)
    .setNonce(3)
    .setDeadline(DEADLINE);

  const typedData = builder.buildLegacyEIP712(ARGS_HASH, MASTER_HASH);

  // Regression: the legacy flow verifies against the MASTER contract; the
  // builder previously embedded this.verifierHash (or '0x' when unset).
  assert.equal(typedData.domain.verifyingContract, `0x${MASTER_HASH}`);
  assert.notEqual(typedData.domain.verifyingContract, `0x${VERIFIER_HASH}`);

  const sharedTypedData = buildMetaTransactionTypedData({
    chainId: String(CHAIN_ID),
    verifyingContract: MASTER_HASH,
    accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a',
    targetContract: TARGET_CONTRACT,
    method: 'transfer',
    argsHashHex: ARGS_HASH,
    nonce: 3,
    deadline: DEADLINE,
  });
  assert.deepEqual(typedData, sharedTypedData);
  assert.equal(
    ethers.TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message),
    ethers.TypedDataEncoder.hash(sharedTypedData.domain, sharedTypedData.types, sharedTypedData.message),
  );
});

test('buildLegacyEIP712 rejects a missing or invalid explicit verifyingContract', () => {
  const builder = createUserOpBuilder()
    .setAccountAddressScriptHash('13ef519c362973f9a34648a9eac5b71250b2a80a')
    .setTarget(TARGET_CONTRACT)
    .setMethod('transfer')
    .setChainId(CHAIN_ID)
    .setNonce(3)
    .setDeadline(DEADLINE);

  assert.throws(() => builder.buildLegacyEIP712(ARGS_HASH), { code: 'SDK_011' });
  assert.throws(() => builder.buildLegacyEIP712(ARGS_HASH, 'not-a-hash'), { code: 'SDK_004' });
});

test('clone copies the cached args hash', () => {
  const builder = v3Builder().setArgsHash(ARGS_HASH);
  const cloned = builder.clone();

  assert.equal(cloned.toJSON().argsHash, ARGS_HASH);

  // The clone must be able to build typed data without re-setting the hash.
  const original = builder.buildEIP712();
  const fromClone = cloned.buildEIP712();
  assert.deepEqual(fromClone, original);
});

test('autoNonce awaits asynchronous nonce fetchers', async () => {
  const builder = await v3Builder().autoNonce(async () => 42);

  assert.ok(builder instanceof UserOperationBuilder, 'await autoNonce must resolve to the builder');
  assert.equal(builder.nonce, 42);
  assert.equal(builder.buildEIP712(ARGS_HASH).message.nonce, '42');
});

test('autoNonce keeps synchronous fetchers and the default chainable', () => {
  const withFetcher = v3Builder().autoNonce(() => 9);
  assert.ok(withFetcher instanceof UserOperationBuilder);
  assert.equal(withFetcher.nonce, 9);

  const withDefault = v3Builder().autoNonce();
  assert.ok(withDefault instanceof UserOperationBuilder);
  assert.equal(withDefault.nonce, 0);
});
