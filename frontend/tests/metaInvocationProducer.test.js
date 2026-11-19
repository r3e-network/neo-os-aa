// CU-209 gate: the client may not build, stage or select an invocation naming an entrypoint the
// built Smart Account ABI does not export.
//
// The oracle is the built manifest itself (contracts/bin/public/SmartAccount.manifest.json), never a
// hand-written list. Two halves:
//   1. an inventory of every exported function on the client's execution surface, so a new producer
//      cannot be added without appearing here;
//   2. the builders themselves run against that inventory with the manifest as the only list.
// A legacy V1/V2/V3 envelope may still be DECODED by the client (a relay-shaped answer or a
// historical draft has to stay readable); it may not be PRODUCED.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as metaTx from '../src/features/operations/metaTx.js';
import * as execution from '../src/features/operations/execution.js';
import * as signedInvocation from '../src/features/operations/signedInvocation.js';
import { EC } from '../src/config/errorCodes.js';

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// contracts/build/ holds the artefacts already deployed; the v4 client targets the build output.
const MANIFEST_PATH = path.resolve(FRONTEND_ROOT, '..', 'contracts', 'bin', 'public', 'SmartAccount.manifest.json');
const CLIENT_SURFACE = { metaTx, execution, signedInvocation };

// The exported functions of the three client modules that can carry an invocation between them.
// Pinned as a census, not as an allowlist: a function added here is a new producer to justify, and
// the built-ABI assertion below is what decides whether its output is legal.
const CLIENT_SURFACE_FUNCTIONS = {
  metaTx: [
    'assertAccountExists', 'buildExecuteUserOpInvocation', 'buildExecuteUserOpsInvocation',
    'buildUserOperation', 'buildUserOperationTypedData', 'composeOperationNonce', 'computeArgsHash',
    'computeOperationDigest', 'decodeAccountDescriptorStack', 'decodeByteStringStackHex',
    'decodeHash160Stack', 'decodeIntegerStack', 'decodeModuleDescriptorStack',
    'decodeValidationPreviewStack', 'fetchAccountDescriptor', 'fetchInstalledModuleIds',
    'fetchModuleDescriptor', 'fetchNonce', 'fetchOperationRoute', 'fetchValidationPreview',
    'recoverPublicKeyFromTypedDataSignature', 'toCanonicalOperationArgs', 'toCompactEcdsaSignature',
  ],
  execution: [
    'buildClientBroadcastRequest', 'buildClientProxyWitnessTransaction', 'buildDraftApprovalTypedData',
    'buildDraftExportBundle', 'buildRelayBroadcastRequest', 'buildRelayPayloadOptions',
    'buildStagedTransactionBody', 'executeBroadcast', 'resolveRelayPayloadMode',
  ],
  signedInvocation: ['DEPLOYED_ENTRYPOINTS', 'isDeployedEntrypoint', 'selectSignedInvocation'],
};

const SA_HASH = '5be915aea3ce85e4752d522632f0a9520e377aaf';
const ACCOUNT_ID_HASH = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const ACCOUNT_ADDRESS_SCRIPT_HASH = '13ef519c362973f9a34648a9eac5b71250b2a80a';
const TARGET = 'd2a4cff31913016155e38e474a2c06d08be276cf';
const NONCE_SUBKEY = '00'.repeat(32);

function readBuiltAbi() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const methods = Array.isArray(manifest?.abi?.methods) ? manifest.abi.methods : [];
  const names = methods.map((method) => String(method?.name || ''));
  return { manifest, methods, names };
}

/** The entrypoints that execute user operations: an account id followed by an operation payload. */
function userOperationSurface(methods) {
  return methods
    .filter((method) => /^execute(?:UserOp|UserOps|SponsoredUserOp|SponsoredUserOps)$/.test(String(method?.name || '')))
    .map((method) => String(method.name))
    .sort();
}

/** A legacy-shaped invocation: hash160 account, target, method, args, then the V1/V2 tail. */
function legacyShapedInvocation(operation) {
  return {
    scriptHash: SA_HASH,
    operation,
    args: [
      { type: 'Hash160', value: `0x${ACCOUNT_ADDRESS_SCRIPT_HASH}` },
      { type: 'Hash160', value: `0x${TARGET}` },
      { type: 'String', value: 'transfer' },
      { type: 'Array', value: [] },
      { type: 'Array', value: [] },
      { type: 'ByteArray', value: '0x' },
      { type: 'Integer', value: '0' },
      { type: 'Integer', value: '0' },
      { type: 'Array', value: [] },
    ],
  };
}

function stagedBody() {
  return execution.buildStagedTransactionBody({
    saContractHash: SA_HASH,
    account: { accountIdHash: ACCOUNT_ID_HASH, accountAddressScriptHash: ACCOUNT_ADDRESS_SCRIPT_HASH },
    operationBody: { kind: 'invoke', targetContract: TARGET, method: 'transfer', args: [] },
    signerAddress: 'NdzSignerAddress',
    morpheusNetwork: 'testnet',
  });
}

function operation({ signatureHex = 'ab'.repeat(64) } = {}) {
  return {
    targetContract: TARGET,
    method: 'transfer',
    args: [],
    nonce: '1',
    nonceSubkey: NONCE_SUBKEY,
    deadline: '1710001234',
    validatorId: '2',
    credentialGeneration: '1',
    authorityEpoch: '0',
    configurationNonce: '0',
    signature: signatureHex,
    hookProofs: [],
  };
}

test('the built manifest names the v4 core and its user-operation surface', () => {
  const { manifest, methods, names } = readBuiltAbi();

  assert.equal(manifest.name, 'SmartAccount', 'the built manifest must be the v4 core, not the deployed V3 artefact');
  assert.deepEqual(
    userOperationSurface(methods),
    ['executeSponsoredUserOp', 'executeSponsoredUserOps', 'executeUserOp', 'executeUserOps'],
    'the built ABI execution surface changed; every other assertion in this file reads it as the oracle',
  );
  for (const dead of ['executeUnified', 'executeUnifiedByAddress']) {
    assert.equal(names.includes(dead), false, `${dead} must not be exported by the built ABI`);
  }
  // executeRecovery takes an account id alone: it is a recovery flow, not a user-operation entrypoint.
  const recovery = methods.find((method) => method.name === 'executeRecovery');
  assert.ok(recovery, 'executeRecovery is part of the v4 surface and must stay visible to this census');
  assert.equal(recovery.parameters.length, 1);
});

test('every exported binding on the client execution surface is the inventoried census', () => {
  for (const [moduleName, expected] of Object.entries(CLIENT_SURFACE_FUNCTIONS)) {
    const actual = Object.keys(CLIENT_SURFACE[moduleName])
      .filter((name) => ['function', 'object'].includes(typeof CLIENT_SURFACE[moduleName][name]))
      .sort();
    assert.deepEqual(
      actual,
      expected.slice().sort(),
      `${moduleName} changed its executable surface: a new binding must be added to the census and pass the built-ABI assertion`,
    );
  }
});

test('the client execution-surface list is exactly the built ABI execution surface', () => {
  const { methods } = readBuiltAbi();
  const entrypoints = userOperationSurface(methods);

  assert.ok(
    Array.isArray(signedInvocation.DEPLOYED_ENTRYPOINTS),
    'the client must export the entrypoint list its selector and submission path decide on, so it can be held to the built ABI',
  );
  assert.deepEqual(
    signedInvocation.DEPLOYED_ENTRYPOINTS.slice().sort(),
    entrypoints,
    'the client list drifted from the built ABI: derive it from contracts/bin/public/SmartAccount.manifest.json',
  );
  for (const name of entrypoints) {
    assert.equal(signedInvocation.isDeployedEntrypoint(name), true, `${name} must be accepted`);
  }
  for (const dead of ['executeUnified', 'executeUnifiedByAddress', 'executeRecovery']) {
    assert.equal(signedInvocation.isDeployedEntrypoint(dead), false, `${dead} must be refused`);
  }
});

test('the invocation builders emit only entrypoints the built ABI exports', () => {
  const entrypoints = userOperationSurface(readBuiltAbi().methods);
  const built = [];

  const single = metaTx.buildExecuteUserOpInvocation({ saContractHash: SA_HASH, accountId: ACCOUNT_ID_HASH, operation: operation() });
  built.push(['metaTx.buildExecuteUserOpInvocation', single]);

  const batch = metaTx.buildExecuteUserOpsInvocation({ saContractHash: SA_HASH, accountId: ACCOUNT_ID_HASH, operations: [operation()] });
  built.push(['metaTx.buildExecuteUserOpsInvocation', batch]);

  const body = stagedBody();
  const unsigned = execution.buildClientBroadcastRequest({
    signerAddress: 'NdzSignerAddress',
    transactionBody: { ...body, metaInvocation: single },
    morpheusNetwork: 'testnet',
  });
  built.push(['execution.buildClientBroadcastRequest', unsigned]);

  // A legacy-shaped envelope handed to the wallet path must be refused, never forwarded as-is.
  for (const name of ['executeUnified', 'executeUnifiedByAddress']) {
    assert.throws(
      () => execution.buildClientBroadcastRequest({
        signerAddress: 'NdzSignerAddress',
        transactionBody: { clientInvocation: legacyShapedInvocation(name) },
      }),
      (error) => error?.message === EC.clientInvocationMissing,
      `unexpected refusal for ${name}`,
    );
  }

  for (const [label, invocation] of built) {
    assert.ok(invocation && typeof invocation.operation === 'string', `${label} produced no invocation`);
    assert.equal(
      entrypoints.includes(invocation.operation),
      true,
      `${label} built an invocation naming ${invocation.operation}, which the built ABI does not export`,
    );
  }

  // The single-operation envelope is one account id and one 13-field operation (§4.1).
  assert.equal(single.args[0].type, 'ByteString');
  assert.equal(single.args[1].type, 'Array');
  assert.equal(single.args[1].value.length, 13);
  assert.equal(batch.args[1].type, 'Array');
  assert.equal(batch.args[1].value.length, 1);
});

test('the signed-invocation selector accepts only entrypoints the built ABI exports', () => {
  const entrypoints = userOperationSurface(readBuiltAbi().methods);

  // A single-operation envelope (executeUserOp) and a batch envelope (executeUserOps) are both
  // selectable and both name a built entrypoint. The single operation is matched field by field
  // against the staged intent; a batch is anchored by the body that staged it.
  const envelopes = {
    executeUserOp: {
      invocation: metaTx.buildExecuteUserOpInvocation({ saContractHash: SA_HASH, accountId: ACCOUNT_ID_HASH, operation: operation() }),
      transactionBody: { ...stagedBody(), operationBody: { targetContract: TARGET, method: 'transfer', args: [] } },
    },
    executeUserOps: {
      invocation: metaTx.buildExecuteUserOpsInvocation({ saContractHash: SA_HASH, accountId: ACCOUNT_ID_HASH, operations: [operation()] }),
      transactionBody: {
        network: 'neo-n3-testnet',
        accountIdHash: ACCOUNT_ID_HASH,
        v4Invocation: metaTx.buildExecuteUserOpsInvocation({ saContractHash: SA_HASH, accountId: ACCOUNT_ID_HASH, operations: [operation()] }),
      },
    },
  };
  for (const [name, { invocation, transactionBody }] of Object.entries(envelopes)) {
    assert.equal(entrypoints.includes(name), true, `${name} must be a built entrypoint for this test to mean anything`);
    const selected = signedInvocation.selectSignedInvocation({
      transactionBody: { ...transactionBody, network: 'neo-n3-testnet', accountIdHash: ACCOUNT_ID_HASH },
      signatures: [{ signerId: 'evm:alice', kind: 'evm', metadata: { metaInvocation: invocation } }],
      morpheusNetwork: 'testnet',
    });
    assert.equal(selected?.operation, name, `${name} is a built entrypoint and must stay selectable`);
  }

  // A dead-name envelope must never come back as the selected invocation: it is refused outright.
  for (const dead of ['executeUnified', 'executeUnifiedByAddress']) {
    assert.equal(entrypoints.includes(dead), false, `${dead} must not be a built entrypoint for this test to mean anything`);
    const attempts = [
      { transactionBody: { network: 'neo-n3-testnet', clientInvocation: legacyShapedInvocation(dead) }, signatures: [] },
      {
        transactionBody: { network: 'neo-n3-testnet' },
        signatures: [{ signerId: 'evm:alice', kind: 'evm', metadata: { metaInvocation: legacyShapedInvocation(dead) } }],
      },
    ];
    for (const attempt of attempts) {
      let selected = null;
      try {
        selected = signedInvocation.selectSignedInvocation({ ...attempt, morpheusNetwork: 'testnet' });
      } catch (error) {
        assert.match(error.message, /unsupported SA wrapper/, `${dead} was refused for the wrong reason: ${error.message}`);
      }
      assert.equal(selected, null, `${dead} is not a built entrypoint and must not be selected`);
    }
  }
});

test('staging a body without a v4 account id fails instead of producing an anonymous draft', () => {
  assert.throws(
    () => execution.buildStagedTransactionBody({
      saContractHash: SA_HASH,
      account: { accountAddressScriptHash: ACCOUNT_ADDRESS_SCRIPT_HASH },
      operationBody: { kind: 'invoke', targetContract: TARGET, method: 'transfer', args: [] },
      signerAddress: 'NdzSignerAddress',
    }),
    (error) => error?.message === EC.accountRequired,
    'a staged body without an account id has no subject to authorize',
  );
});

test('a staged body keeps the approved intent and no invocation a caller could fall back to', () => {
  const body = stagedBody();

  for (const field of ['clientInvocation', 'v3Invocation', 'legacyInvocation', 'metaInvocation', 'metaInvocations']) {
    assert.equal(Object.hasOwn(body, field), false, `the staged body must not carry a ${field} field`);
  }
  assert.equal(body.accountIdHash, ACCOUNT_ID_HASH);
  assert.deepEqual(body.operationBody, { targetContract: TARGET, method: 'transfer', args: [], kind: 'invoke', requiresProxyWitness: false });
});

test('a legacy-shaped client invocation cannot be turned into a client broadcast request', () => {
  for (const clientInvocation of ['executeUnified', 'executeUnifiedByAddress'].map(legacyShapedInvocation)) {
    let broadcast = null;
    assert.throws(
      () => { broadcast = execution.buildClientBroadcastRequest({ signerAddress: 'NdzSignerAddress', transactionBody: { clientInvocation } }); },
      (error) => /unsupported SA wrapper|^EC_client_invocation_missing$/.test(error?.message || ''),
      'unexpected refusal',
    );
    assert.equal(broadcast, null, `a legacy envelope (${clientInvocation.operation}) must never become a wallet request`);
  }
});
