import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import {
  V3_USER_OP_CHAIN_ID,
  prepareV3UserOpContext,
  signUserOpWithEvm,
} from '../src/features/operations/useUserOpSigning.js';
import { EC } from '../src/config/errorCodes.js';

const SA_CONTRACT_HASH = '49c095ce04d38642e39155f5481615c58227a498';
const ACCOUNT_ID_HASH = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const VERIFIER_HASH = '5be915aea3ce85e4752d522632f0a9520e377aaf';
const ARGS_HASH = 'ab'.repeat(32);

function makeDeps({ verifierHash = VERIFIER_HASH } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      computeArgsHash: async (params) => {
        calls.push(['computeArgsHash', params]);
        return ARGS_HASH;
      },
      fetchV3Verifier: async (params) => {
        calls.push(['fetchV3Verifier', params]);
        return verifierHash;
      },
      fetchV3Nonce: async (params) => {
        calls.push(['fetchV3Nonce', params]);
        return 7n;
      },
    },
  };
}

test('prepareV3UserOpContext fails fast with the caller error code when the account id is missing', async () => {
  const { calls, deps } = makeDeps();
  await assert.rejects(
    () => prepareV3UserOpContext({
      rpcUrl: 'https://rpc.example',
      saContractHash: SA_CONTRACT_HASH,
      accountIdHash: '',
      operationBody: { args: [] },
      missingAccountError: EC.v3AccountRequired,
      deps,
    }),
    new RegExp(EC.v3AccountRequired),
  );
  assert.equal(calls.length, 0, 'no chain reads happen for a missing account');
});

test('prepareV3UserOpContext surfaces the caller error code when no verifier is bound', async () => {
  const { deps } = makeDeps({ verifierHash: '' });
  await assert.rejects(
    () => prepareV3UserOpContext({
      rpcUrl: 'https://rpc.example',
      saContractHash: SA_CONTRACT_HASH,
      accountIdHash: ACCOUNT_ID_HASH,
      operationBody: { args: [] },
      missingVerifierError: EC.noVerifierPlugin,
      deps,
    }),
    new RegExp(EC.noVerifierPlugin),
  );
});

test('prepareV3UserOpContext reads args hash, verifier, and channel-0 nonce', async () => {
  const { calls, deps } = makeDeps();
  const before = Date.now();
  const context = await prepareV3UserOpContext({
    rpcUrl: 'https://rpc.example',
    saContractHash: SA_CONTRACT_HASH,
    accountIdHash: ACCOUNT_ID_HASH,
    operationBody: { args: [{ type: 'Integer', value: '1' }] },
    deps,
  });

  assert.equal(context.argsHashHex, ARGS_HASH);
  assert.equal(context.verifierHash, VERIFIER_HASH);
  assert.equal(context.nonce, 7n);
  assert.ok(context.deadline >= before + 60 * 60 * 1000 - 1000);

  assert.deepEqual(calls.map(([name]) => name), [
    'computeArgsHash',
    'fetchV3Verifier',
    'fetchV3Nonce',
  ]);
  assert.deepEqual(calls[0][1].args, [{ type: 'Integer', value: '1' }]);
  assert.equal(calls[2][1].channel, 0n);
});

test('signUserOpWithEvm returns a contract-aligned signature record and invocation', async () => {
  const signer = Wallet.createRandom();
  const { deps } = makeDeps();
  const operationBody = {
    targetContract: SA_CONTRACT_HASH,
    method: 'balanceOf',
    args: [{ type: 'Hash160', value: `0x${ACCOUNT_ID_HASH}` }],
  };

  const result = await signUserOpWithEvm({
    rpcUrl: 'https://rpc.example',
    saContractHash: SA_CONTRACT_HASH,
    accountIdHash: ACCOUNT_ID_HASH,
    operationBody,
    signerId: signer.address.toLowerCase(),
    signTypedData: (typedData) =>
      signer.signTypedData(typedData.domain, typedData.types, typedData.message),
    deps,
  });

  // Typed data binds the verifier and the shared testnet chain id.
  assert.equal(result.typedData.domain.chainId, V3_USER_OP_CHAIN_ID);
  assert.match(
    String(result.typedData.domain.verifyingContract).toLowerCase(),
    new RegExp(VERIFIER_HASH),
  );

  const record = result.signatureRecord;
  assert.equal(record.kind, 'evm');
  assert.equal(record.signerId, signer.address.toLowerCase());
  assert.equal(record.signatureHex.length, 128, 'compact r||s without recovery byte');
  assert.equal(record.payloadDigest, ARGS_HASH);
  assert.equal(record.publicKey.toLowerCase(), signer.signingKey.publicKey.toLowerCase());
  assert.equal(record.metadata.verifierHash, VERIFIER_HASH);
  assert.equal(record.metadata.nonce, '7');
  assert.equal(record.metadata.deadline, String(result.deadline));
  assert.equal(record.metadata.signatureFullHex.length, 132);
  assert.ok(record.createdAt);

  // The broadcast path reads the executeUserOp invocation from metadata.
  assert.equal(record.metadata.metaInvocation, result.metaInvocation);
  assert.equal(result.metaInvocation.operation, 'executeUserOp');
});

test('signUserOpWithEvm binds the EIP-712 domain chainId to the active network magic', async () => {
  const operationBody = {
    targetContract: SA_CONTRACT_HASH,
    method: 'balanceOf',
    args: [{ type: 'Hash160', value: `0x${ACCOUNT_ID_HASH}` }],
  };

  // The on-chain V3 verifier checks the domain chainId against the network magic
  // of the connected network, so signing on each network must use its own magic.
  const MAINNET_MAGIC = 860833102;
  const TESTNET_MAGIC = 894710606;

  for (const chainId of [MAINNET_MAGIC, TESTNET_MAGIC]) {
    const signer = Wallet.createRandom();
    const { deps } = makeDeps();
    const result = await signUserOpWithEvm({
      rpcUrl: 'https://rpc.example',
      saContractHash: SA_CONTRACT_HASH,
      accountIdHash: ACCOUNT_ID_HASH,
      operationBody,
      signerId: signer.address.toLowerCase(),
      chainId,
      signTypedData: (typedData) =>
        signer.signTypedData(typedData.domain, typedData.types, typedData.message),
      deps,
    });

    assert.equal(
      result.typedData.domain.chainId,
      chainId,
      `signed domain chainId must equal the active network magic (${chainId})`,
    );
    assert.equal(result.signatureRecord.metadata.typedData.domain.chainId, chainId);
  }
});

test('signUserOpWithEvm falls back to the legacy testnet chain id when none is supplied', async () => {
  const signer = Wallet.createRandom();
  const { deps } = makeDeps();
  const result = await signUserOpWithEvm({
    rpcUrl: 'https://rpc.example',
    saContractHash: SA_CONTRACT_HASH,
    accountIdHash: ACCOUNT_ID_HASH,
    operationBody: { targetContract: SA_CONTRACT_HASH, method: 'balanceOf', args: [] },
    signerId: signer.address.toLowerCase(),
    signTypedData: (typedData) =>
      signer.signTypedData(typedData.domain, typedData.types, typedData.message),
    deps,
  });

  assert.equal(result.typedData.domain.chainId, V3_USER_OP_CHAIN_ID);
});

test('signUserOpWithEvm rejects when no signer is supplied', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => signUserOpWithEvm({
      rpcUrl: 'https://rpc.example',
      saContractHash: SA_CONTRACT_HASH,
      accountIdHash: ACCOUNT_ID_HASH,
      operationBody: {},
      signerId: '0xabc',
      signTypedData: null,
      deps,
    }),
    new RegExp(EC.evmProviderMissing),
  );
});
