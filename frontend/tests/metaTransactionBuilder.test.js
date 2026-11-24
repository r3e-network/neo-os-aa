import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import {
  assertAccountExists,
  buildExecuteUserOpInvocation,
  buildUserOperation,
  buildUserOperationTypedData,
  computeArgsHash,
  computeOperationDigest,
  fetchNonce,
  fetchOperationRoute,
  recoverPublicKeyFromTypedDataSignature,
  toCanonicalOperationArgs,
  toCompactEcdsaSignature,
} from '../src/features/operations/metaTx.js';
import { EC } from '../src/config/errorCodes.js';

const CORE = '49c095ce04d38642e39155f5481615c58227a498';
const ACCOUNT = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const VALIDATOR = '5be915aea3ce85e4752d522632f0a9520e377aaf';
const ARGS_HASH = 'ab'.repeat(32);
const DIGEST = 'cd'.repeat(32);

function typedDataParams(overrides = {}) {
  return {
    chainId: 894710606,
    verifyingContract: VALIDATOR,
    accountId: ACCOUNT,
    coreContractHash: CORE,
    validatorId: '2',
    targetContract: CORE,
    method: 'balanceOf',
    argsHashHex: ARGS_HASH,
    nonce: 7,
    deadline: 1710000000,
    operationDigest: DIGEST,
    ...overrides,
  };
}

function jsonResponse(result) {
  return {
    ok: true,
    async json() {
      return { result };
    },
  };
}

test('buildUserOperationTypedData matches the v4 validator field layout', () => {
  const params = typedDataParams();
  const payload = buildUserOperationTypedData(params);

  assert.deepEqual(payload, {
    domain: {
      name: 'Neo Smart Account',
      version: '4',
      chainId: params.chainId,
      verifyingContract: `0x${params.verifyingContract}`,
    },
    types: {
      UserOperation: [
        { name: 'accountId', type: 'bytes20' },
        { name: 'coreContract', type: 'bytes20' },
        { name: 'validatorId', type: 'uint64' },
        { name: 'targetContract', type: 'address' },
        { name: 'method', type: 'string' },
        { name: 'argsHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'operationDigest', type: 'bytes32' },
      ],
    },
    message: {
      accountId: `0x${params.accountId}`,
      coreContract: `0x${params.coreContractHash}`,
      validatorId: '2',
      targetContract: `0x${params.targetContract}`,
      method: params.method,
      argsHash: `0x${params.argsHashHex}`,
      nonce: String(params.nonce),
      deadline: String(params.deadline),
      operationDigest: `0x${params.operationDigest}`,
    },
  });
});

test('buildUserOperationTypedData refuses a missing operation digest', () => {
  assert.throws(
    () => buildUserOperationTypedData(typedDataParams({ operationDigest: '' })),
    (error) => error?.code === 'METATX_OPERATION_DIGEST_INVALID',
  );
});

test('computeArgsHash invokes the contract helper and decodes the returned bytestring', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return jsonResponse({
      state: 'HALT',
      stack: [{ type: 'ByteString', value: Buffer.from(ARGS_HASH, 'hex').toString('base64') }],
    });
  };

  const result = await computeArgsHash({
    rpcUrl: 'https://rpc.example.org',
    saContractHash: CORE,
    args: [{ type: 'String', value: 'hello' }],
    fetchImpl,
  });

  assert.equal(result, ARGS_HASH);
  assert.equal(calls[0][0], 'https://rpc.example.org');
  assert.equal(calls[0][1].method, 'invokefunction');
  assert.equal(calls[0][1].params[1], 'computeArgsHash');
  assert.deepEqual(calls[0][1].params[2], [{ type: 'Array', value: [{ type: 'String', value: 'hello' }] }]);
});

test('fetchNonce reads getNonce for the routed validator instance and namespace', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return jsonResponse({ state: 'HALT', stack: [{ type: 'Integer', value: '3' }] });
  };

  const nonce = await fetchNonce({
    rpcUrl: 'https://rpc.example.org',
    saContractHash: CORE,
    accountId: ACCOUNT,
    validatorId: '2',
    nonceSubkey: '00'.repeat(32),
    fetchImpl,
  });

  assert.equal(nonce, 3n);
  assert.equal(calls[0].params[1], 'getNonce');
  assert.deepEqual(calls[0].params[2], [
    { type: 'Hash160', value: `0x${ACCOUNT}` },
    { type: 'Integer', value: '2' },
    { type: 'ByteArray', value: Buffer.alloc(32).toString('base64') },
  ]);
});

test('the operation route takes its generation from the chain, and follows an advance', async () => {
  // The route is the only place a client learns the routing generation. It must
  // come from the module descriptor (§9 field 8), never from a literal: the
  // test advances the instance's generation between two reads and checks the
  // route follows, so a re-introduced default of 1 fails here.
  const bs = (hex) => ({ type: 'ByteString', value: Buffer.from(hex, 'hex').toString('base64') });
  const routeFor = async (generation) => {
    const fetchImpl = async (_url, options) => {
      const { params } = JSON.parse(options.body);
      if (params[1] === 'getAccount') {
        return jsonResponse({
          state: 'HALT',
          stack: [
            {
              type: 'Array',
              value: [
                { type: 'Boolean', value: true },
                { type: 'Integer', value: '0' },
                bs('11'.repeat(20)),
                bs('00'.repeat(20)),
                { type: 'Integer', value: '4' },
                { type: 'Integer', value: '9' },
                { type: 'Integer', value: '0' },
                { type: 'Boolean', value: true },
                { type: 'Boolean', value: false },
                { type: 'Boolean', value: false },
                { type: 'Integer', value: '0' },
                { type: 'Integer', value: '1' },
                { type: 'Boolean', value: false },
                { type: 'Integer', value: '0' },
                { type: 'Boolean', value: false },
              ],
            },
          ],
        });
      }
      if (params[1] === 'getModules') {
        return jsonResponse({
          state: 'HALT',
          stack: [{ type: 'Array', value: [{ type: 'Integer', value: '2' }] }, { type: 'Integer', value: '0' }],
        });
      }
      if (params[1] === 'getModule') {
        return jsonResponse({
          state: 'HALT',
          stack: [
            {
              type: 'Array',
              value: [
                { type: 'Integer', value: '2' },
                { type: 'Integer', value: '1' },
                // Stored order: decodeHash160Stack reverses into the display form.
                bs(VALIDATOR.match(/../g).reverse().join('')),
                { type: 'Integer', value: '7' },
                { type: 'Integer', value: '1' },
                bs('aa'.repeat(32)),
                bs('bb'.repeat(32)),
                { type: 'Integer', value: '1' },
                { type: 'Integer', value: String(generation) },
                { type: 'Boolean', value: false },
                { type: 'Boolean', value: true },
                { type: 'Boolean', value: true },
              ],
            },
          ],
        });
      }
      throw Error(`unexpected read ${params[1]}`);
    };
    return fetchOperationRoute({
      rpcUrl: 'https://rpc.example.org',
      saContractHash: CORE,
      accountId: ACCOUNT,
      fetchImpl,
    });
  };

  const fresh = await routeFor(1);
  assert.equal(fresh.validatorId, '2');
  assert.equal(fresh.credentialGeneration, '1');
  assert.equal(fresh.authorityEpoch, '4');
  assert.equal(fresh.configurationNonce, '9');
  assert.equal(fresh.verifyingContract, VALIDATOR);

  const advanced = await routeFor(2);
  assert.equal(advanced.credentialGeneration, '2');

  // The advanced route builds a different §4.3 digest, which is why a stale 1
  // is a real failure and not a cosmetic difference.
  const context = { networkMagic: 894710606, coreContractHash: CORE, accountId: ACCOUNT };
  const digestOf = (route) =>
    computeOperationDigest({
      ...context,
      operation: buildUserOperation({
        targetContract: CORE,
        method: 'balanceOf',
        args: [],
        nonce: '1',
        deadline: '2',
        validatorId: route.validatorId,
        credentialGeneration: route.credentialGeneration,
        authorityEpoch: route.authorityEpoch,
        configurationNonce: route.configurationNonce,
      }),
    });
  assert.notEqual(digestOf(fresh), digestOf(advanced));
  // And building the advanced route's operation with the old generation is
  // refused, so a stale generation cannot be signed by accident.
  assert.throws(
    () =>
      buildUserOperation({
        targetContract: CORE,
        method: 'balanceOf',
        args: [],
        nonce: '1',
        deadline: '2',
        validatorId: advanced.validatorId,
        credentialGeneration: undefined,
      }),
    (error) => error.message === EC.credentialGenerationRequired,
  );
});

test('fetchNonce refuses a missing account id before any chain read', async () => {
  let reads = 0;
  await assert.rejects(
    () => fetchNonce({
      rpcUrl: 'https://rpc.example.org',
      saContractHash: CORE,
      accountId: '',
      validatorId: '2',
      fetchImpl: async () => { reads += 1; return jsonResponse({ state: 'HALT', stack: [] }); },
    }),
    new RegExp(EC.accountIdRequired),
  );
  assert.equal(reads, 0);
});

test('assertAccountExists returns the 15-field control descriptor', async () => {
  const descriptor = [
    { type: 'Boolean', value: true },
    { type: 'Integer', value: '0' },
    { type: 'ByteString', value: Buffer.from('11'.repeat(20), 'hex').toString('base64') },
    { type: 'ByteString', value: Buffer.from('11'.repeat(20), 'hex').toString('base64') },
    { type: 'Integer', value: '4' },
    { type: 'Integer', value: '9' },
    { type: 'Integer', value: '0' },
    { type: 'Boolean', value: true },
    { type: 'Boolean', value: false },
    { type: 'Boolean', value: false },
    { type: 'Integer', value: '0' },
    { type: 'Integer', value: '1' },
    { type: 'Boolean', value: false },
    { type: 'Integer', value: '0' },
    { type: 'Boolean', value: false },
  ];
  const fetchImpl = async () => jsonResponse({ state: 'HALT', stack: [{ type: 'Array', value: descriptor }] });

  const account = await assertAccountExists({
    rpcUrl: 'https://rpc.example.org',
    saContractHash: CORE,
    accountId: ACCOUNT,
    fetchImpl,
  });

  assert.equal(account.exists, true);
  assert.equal(account.statusName, 'Active');
  assert.equal(account.authorityEpoch, '4');
  assert.equal(account.configurationNonce, '9');
  assert.equal(account.custody, '11'.repeat(20));
});

test('buildExecuteUserOpInvocation wraps the 13-field operation and the account id', () => {
  const operation = buildUserOperation({
    targetContract: CORE,
    method: 'transfer',
    args: [{ type: 'Hash160', value: `0x${ACCOUNT}` }, { type: 'Integer', value: '1' }],
    nonce: '7',
    deadline: '1710000000',
    validatorId: '2',
    credentialGeneration: '1',
    authorityEpoch: '4',
    configurationNonce: '9',
    signature: 'ab'.repeat(64),
  });

  const invocation = buildExecuteUserOpInvocation({ saContractHash: CORE, accountId: ACCOUNT, operation });

  assert.equal(invocation.scriptHash, CORE);
  assert.equal(invocation.operation, 'executeUserOp');
  assert.equal(invocation.args[0].type, 'ByteString');
  // The account id argument is stored byte order, not display order.
  assert.equal(invocation.args[0].value, ACCOUNT.match(/../g).reverse().join(''));
  assert.equal(invocation.args[1].type, 'Array');
  assert.equal(invocation.args[1].value.length, 13);
  assert.equal(invocation.args[1].value[0].value, '4', 'protocol version');
  assert.equal(invocation.args[1].value[7].value, '2', 'validator id');
  assert.equal(invocation.args[1].value[11].value, 'ab'.repeat(64), 'signature');
});

test('buildExecuteUserOpInvocation refuses an incomplete envelope', () => {
  assert.equal(buildExecuteUserOpInvocation({ saContractHash: CORE, accountId: ACCOUNT, operation: null }), null);
  assert.equal(buildExecuteUserOpInvocation({ saContractHash: 'xyz', accountId: ACCOUNT, operation: {} }), null);
});

test('toCanonicalOperationArgs converts builder parameters to the §4.1 value set', () => {
  const args = toCanonicalOperationArgs([
    { type: 'Hash160', value: `0x${ACCOUNT}` },
    { type: 'ByteArray', value: '0x0102' },
    { type: 'String', value: 'hi' },
    { type: 'Integer', value: 5 },
    { type: 'Array', value: [{ type: 'Boolean', value: true }] },
  ]);

  assert.deepEqual(args, [
    { type: 'ByteString', value: ACCOUNT.match(/../g).reverse().join('') },
    { type: 'ByteString', value: '0102' },
    { type: 'ByteString', value: '6869' },
    { type: 'Integer', value: '5' },
    { type: 'Array', value: [{ type: 'Boolean', value: true }] },
  ]);
});

test('toCanonicalOperationArgs is idempotent for already-canonical arguments', () => {
  const canonical = [{ type: 'ByteString', value: '0102' }, { type: 'Integer', value: '5' }];
  assert.deepEqual(toCanonicalOperationArgs(canonical), canonical);
});

test('buildUserOperation stores the canonical argument form', () => {
  const operation = buildUserOperation({
    targetContract: CORE,
    method: 'balanceOf',
    args: [{ type: 'Hash160', value: `0x${ACCOUNT}` }],
    nonce: '1',
    deadline: '2',
    credentialGeneration: '1',
  });

  assert.deepEqual(operation.args, [
    { type: 'ByteString', value: ACCOUNT.match(/../g).reverse().join('') },
  ]);
  assert.equal(operation.nonceSubkey, '00'.repeat(32));
});

test('buildUserOperation refuses an operation without a credential generation', () => {
  // The generation is a chain fact (SubjectRevision for the built-in route,
  // CredentialGeneration for an installed validator), so the factory has no
  // default to fall back on: a missing one is reported instead of becoming 1.
  assert.throws(
    () =>
      buildUserOperation({
        targetContract: CORE,
        method: 'balanceOf',
        args: [],
        nonce: '1',
        deadline: '2',
      }),
    (error) => error.message === EC.credentialGenerationRequired,
  );
  // A null placeholder (the workspace skeleton uses one when the built-in
  // route's revision has not been read yet) is refused the same way.
  assert.throws(
    () =>
      buildUserOperation({
        targetContract: CORE,
        method: 'balanceOf',
        args: [],
        nonce: '1',
        deadline: '2',
        credentialGeneration: null,
      }),
    (error) => error.message === EC.credentialGenerationRequired,
  );
  // An explicit generation is carried verbatim, including the built-in 0/1.
  for (const generation of ['0', '1', 7]) {
    assert.equal(
      buildUserOperation({
        targetContract: CORE,
        method: 'balanceOf',
        args: [],
        nonce: '1',
        deadline: '2',
        credentialGeneration: generation,
      }).credentialGeneration,
      String(generation),
    );
  }
});

test('the v3 builders are gone from the client transaction builders', async () => {
  // The deployed SmartAccount ABI exposes executeUserOp(s) and the v4 operation,
  // so no MetaTransaction/UserOperation-v3 builder may survive here.
  const metaTx = await import('../src/features/operations/metaTx.js');
  for (const symbol of [
    'buildMetaTransactionTypedData',
    'buildV3UserOperationTypedData',
    'fetchV3Verifier',
    'fetchV3Nonce',
    'fetchV3ValidationPreview',
    'fetchNonceForAddress',
    'buildExecuteUnifiedByAddressInvocation',
  ]) {
    assert.equal(Object.hasOwn(metaTx, symbol), false, `${symbol} must not exist`);
  }
});

test('toCompactEcdsaSignature drops the recovery byte for contract submission', async () => {
  const signer = Wallet.createRandom();
  const typedData = buildUserOperationTypedData(typedDataParams());
  const signature = await signer.signTypedData(typedData.domain, typedData.types, typedData.message);
  const compact = toCompactEcdsaSignature(signature);

  assert.equal(compact.length, 128);
  assert.equal(compact, `${signature.slice(2, 66)}${signature.slice(66, 130)}`);
});

test('recoverPublicKeyFromTypedDataSignature returns the uncompressed signer key', async () => {
  const wallet = Wallet.createRandom();
  const typedData = buildUserOperationTypedData(typedDataParams());
  const signature = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);

  const publicKey = recoverPublicKeyFromTypedDataSignature({ typedData, signature });

  assert.equal(publicKey.toLowerCase(), wallet.signingKey.publicKey.toLowerCase());
});
