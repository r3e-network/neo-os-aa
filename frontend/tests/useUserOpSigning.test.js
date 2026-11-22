import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import {
  DEFAULT_USER_OP_CHAIN_ID,
  prepareUserOpRoute,
  signUserOpWithEvm,
} from '../src/features/operations/useUserOpSigning.js';
import {
  buildUserOperation,
  computeOperationDigest,
} from '../src/features/operations/metaTx.js';
import { EC } from '../src/config/errorCodes.js';

const SA_CONTRACT_HASH = '49c095ce04d38642e39155f5481615c58227a498';
const ACCOUNT_ID_HASH = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const VERIFIER_HASH = '5be915aea3ce85e4752d522632f0a9520e377aaf';
const ARGS_HASH = 'ab'.repeat(32);

function makeRoute(overrides = {}) {
  return {
    account: { exists: true, authorityEpoch: '3', configurationNonce: '5' },
    module: { moduleId: '2', contractHash: VERIFIER_HASH, credentialGeneration: '1' },
    validatorId: '2',
    credentialGeneration: '1',
    verifyingContract: VERIFIER_HASH,
    authorityEpoch: '3',
    configurationNonce: '5',
    ...overrides,
  };
}

function makeDeps({ route = makeRoute() } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      fetchOperationRoute: async (params) => {
        calls.push(['fetchOperationRoute', params]);
        return route;
      },
      computeArgsHash: async (params) => {
        calls.push(['computeArgsHash', params]);
        return ARGS_HASH;
      },
      fetchNonce: async (params) => {
        calls.push(['fetchNonce', params]);
        return 7n;
      },
    },
  };
}

test('prepareUserOpRoute fails fast with the caller error code when the account id is missing', async () => {
  const { calls, deps } = makeDeps();
  await assert.rejects(
    () => prepareUserOpRoute({
      rpcUrl: 'https://rpc.example',
      saContractHash: SA_CONTRACT_HASH,
      accountId: '',
      operationBody: { args: [] },
      missingAccountError: EC.accountRequired,
      deps,
    }),
    new RegExp(EC.accountRequired),
  );
  assert.equal(calls.length, 0, 'no chain reads happen for a missing account');
});

test('prepareUserOpRoute reads the route, args hash, and the validator namespace nonce', async () => {
  const { calls, deps } = makeDeps();
  const before = Date.now();
  const context = await prepareUserOpRoute({
    rpcUrl: 'https://rpc.example',
    saContractHash: SA_CONTRACT_HASH,
    accountId: ACCOUNT_ID_HASH,
    operationBody: {
      targetContract: SA_CONTRACT_HASH,
      method: 'balanceOf',
      args: [{ type: 'Integer', value: '1' }],
    },
    networkMagic: 894710606,
    deps,
  });

  assert.equal(context.argsHashHex, ARGS_HASH);
  assert.equal(context.route.validatorId, '2');
  assert.equal(context.chainId, 894710606);
  assert.ok(context.deadline >= before + 60 * 60 * 1000 - 1000);
  assert.equal(context.nonceSubkey, '00'.repeat(32), 'the default namespace subkey is 32 zero bytes');

  assert.deepEqual(calls.map(([name]) => name), [
    'fetchOperationRoute',
    'computeArgsHash',
    'fetchNonce',
  ]);
  assert.deepEqual(calls[1][1].args, [{ type: 'Integer', value: '1' }]);
  assert.equal(calls[2][1].validatorId, '2', 'the nonce sequence belongs to the routed instance');
  assert.equal(calls[2][1].nonceSubkey, '00'.repeat(32));

  // The unsigned envelope carries the control values the §4.3 domain binds.
  assert.equal(context.operation.validatorId, '2');
  assert.equal(context.operation.credentialGeneration, '1');
  assert.equal(context.operation.authorityEpoch, '3');
  assert.equal(context.operation.configurationNonce, '5');
  assert.equal(context.operation.signature, '', 'routing alone never signs');
});

test('prepareUserOpRoute digests the unsigned envelope exactly as the core will', async () => {
  const { deps } = makeDeps();
  const context = await prepareUserOpRoute({
    rpcUrl: 'https://rpc.example',
    saContractHash: SA_CONTRACT_HASH,
    accountId: ACCOUNT_ID_HASH,
    operationBody: { targetContract: SA_CONTRACT_HASH, method: 'balanceOf', args: [] },
    networkMagic: 894710606,
    deps,
  });

  const expected = computeOperationDigest({
    networkMagic: 894710606,
    coreContractHash: SA_CONTRACT_HASH,
    accountId: ACCOUNT_ID_HASH,
    operation: context.operation,
  });
  assert.equal(context.operationDigest, expected);
  assert.match(context.operationDigest, /^[0-9a-f]{64}$/);
});

test('signUserOpWithEvm returns a v4 signature record and executeUserOp invocation', async () => {
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
    accountId: ACCOUNT_ID_HASH,
    operationBody,
    signerId: signer.address.toLowerCase(),
    networkMagic: 894710606,
    signTypedData: (typedData) =>
      signer.signTypedData(typedData.domain, typedData.types, typedData.message),
    deps,
  });

  // The typed data is the v4 validator domain: name "Neo Smart Account", version "4".
  assert.equal(result.typedData.domain.name, 'Neo Smart Account');
  assert.equal(result.typedData.domain.version, '4');
  assert.equal(result.typedData.domain.chainId, 894710606);
  assert.match(
    String(result.typedData.domain.verifyingContract).toLowerCase(),
    new RegExp(VERIFIER_HASH),
  );
  assert.equal(
    result.typedData.message.operationDigest.replace(/^0x/, ''),
    result.operationDigest,
    'the signed digest is the §4.3 digest of this envelope',
  );

  const record = result.signatureRecord;
  assert.equal(record.kind, 'evm');
  assert.equal(record.signerId, signer.address.toLowerCase());
  assert.equal(record.signatureHex.length, 128, 'compact r||s without recovery byte');
  assert.equal(record.payloadDigest, result.operationDigest);
  assert.equal(record.publicKey.toLowerCase(), signer.signingKey.publicKey.toLowerCase());
  assert.equal(record.metadata.verifierHash, VERIFIER_HASH);
  assert.equal(record.metadata.validatorId, '2');
  assert.equal(record.metadata.nonce, String(result.nonce));
  assert.equal(record.metadata.deadline, String(result.deadline));
  assert.equal(record.metadata.signatureFullHex.length, 132);
  assert.ok(record.createdAt);

  // The signed envelope keeps the routed control values and carries the signature.
  assert.equal(result.operation.signature, record.signatureHex);
  assert.equal(result.operation.validatorId, '2');

  // The broadcast path reads the executeUserOp invocation from metadata.
  assert.equal(record.metadata.metaInvocation, result.metaInvocation);
  assert.equal(result.metaInvocation.operation, 'executeUserOp');
  assert.equal(result.metaInvocation.args.length, 2);
});

test('signUserOpWithEvm binds the EIP-712 domain chainId to the active network magic', async () => {
  const operationBody = {
    targetContract: SA_CONTRACT_HASH,
    method: 'balanceOf',
    args: [{ type: 'Hash160', value: `0x${ACCOUNT_ID_HASH}` }],
  };

  // The validator rebuilds the domain from its own protocol settings, so signing
  // on each network must use that network's magic.
  const MAINNET_MAGIC = 860833102;
  const TESTNET_MAGIC = 894710606;

  for (const chainId of [MAINNET_MAGIC, TESTNET_MAGIC]) {
    const signer = Wallet.createRandom();
    const { deps } = makeDeps();
    const result = await signUserOpWithEvm({
      rpcUrl: 'https://rpc.example',
      saContractHash: SA_CONTRACT_HASH,
      accountId: ACCOUNT_ID_HASH,
      operationBody,
      signerId: signer.address.toLowerCase(),
      networkMagic: chainId,
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

test('signUserOpWithEvm falls back to the testnet magic when none is supplied', async () => {
  const signer = Wallet.createRandom();
  const { deps } = makeDeps();
  const result = await signUserOpWithEvm({
    rpcUrl: 'https://rpc.example',
    saContractHash: SA_CONTRACT_HASH,
    accountId: ACCOUNT_ID_HASH,
    operationBody: { targetContract: SA_CONTRACT_HASH, method: 'balanceOf', args: [] },
    signerId: signer.address.toLowerCase(),
    signTypedData: (typedData) =>
      signer.signTypedData(typedData.domain, typedData.types, typedData.message),
    deps,
  });

  assert.equal(DEFAULT_USER_OP_CHAIN_ID, 894710606);
  assert.equal(result.typedData.domain.chainId, DEFAULT_USER_OP_CHAIN_ID);
});

test('a different signed envelope yields a different operation digest', async () => {
  const first = buildUserOperation({
    targetContract: SA_CONTRACT_HASH,
    method: 'balanceOf',
    args: [],
    nonce: '1',
    deadline: '2',
    validatorId: '2',
    // Reviewed fixture: the installed validator's published generation.
    credentialGeneration: '1',
  });
  const second = { ...first, method: 'transfer' };

  const context = { networkMagic: 894710606, coreContractHash: SA_CONTRACT_HASH, accountId: ACCOUNT_ID_HASH };
  assert.notEqual(
    computeOperationDigest({ ...context, operation: first }),
    computeOperationDigest({ ...context, operation: second }),
    'the digest must bind the operation body',
  );
});

test('signUserOpWithEvm rejects when no signer is supplied', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => signUserOpWithEvm({
      rpcUrl: 'https://rpc.example',
      saContractHash: SA_CONTRACT_HASH,
      accountId: ACCOUNT_ID_HASH,
      operationBody: {},
      signerId: '0xabc',
      signTypedData: null,
      deps,
    }),
    new RegExp(EC.evmProviderMissing),
  );
});
