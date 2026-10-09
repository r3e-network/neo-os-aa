// CU-209 gate: the client may not build, stage or select an invocation naming an entrypoint the
// deployed Abstract Account ABI does not export.
//
// The oracle is the deployed manifest itself (contracts/build/UnifiedSmartWalletV3.manifest.json),
// never a hand-written list. Two halves:
//   1. an inventory of every exported function on the client's execution surface, so a new producer
//      cannot be added without appearing here;
//   2. the builders themselves run against that inventory with the manifest as the only list.
// A legacy V1/V2 envelope may still be DECODED by the client (a relay-shaped answer or a historical
// draft has to stay readable); it may not be PRODUCED. The mutant for this file is recorded in the
// slice evidence: with `buildExecuteUnifiedByAddressInvocation` re-added to the execution path, the
// deployed-ABI assertion below fails and names the operation.
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
const MANIFEST_PATH = path.resolve(FRONTEND_ROOT, '..', 'contracts', 'build', 'UnifiedSmartWalletV3.manifest.json');
const CLIENT_SURFACE = { metaTx, execution, signedInvocation };

// The exported functions of the three client modules that can carry an invocation between them.
// Pinned as a census, not as an allowlist: a function added here is a new producer to justify, and
// the deployed-ABI assertion below is what decides whether its output is legal.
const CLIENT_SURFACE_FUNCTIONS = {
  metaTx: [
    'assertV3AccountExists', 'buildExecuteUserOpInvocation', 'buildMetaTransactionTypedData',
    'buildV3UserOperationTypedData', 'computeArgsHash', 'decodeByteStringStackHex',
    'decodeHash160Stack', 'decodeIntegerStack', 'decodeValidationPreviewStack',
    'fetchNonceForAddress', 'fetchV3Nonce', 'fetchV3ValidationPreview', 'fetchV3Verifier',
    'recoverPublicKeyFromTypedDataSignature', 'toCompactEcdsaSignature',
  ],
  execution: [
    'buildClientBroadcastRequest', 'buildDraftApprovalTypedData', 'buildDraftExportBundle',
    'buildRelayBroadcastRequest', 'buildRelayPayloadOptions', 'buildStagedTransactionBody',
    'executeBroadcast', 'resolveRelayPayloadMode',
  ],
  signedInvocation: ['DEPLOYED_ENTRYPOINTS', 'isDeployedEntrypoint', 'selectSignedInvocation'],
};

const AA_HASH = '5be915aea3ce85e4752d522632f0a9520e377aaf';
const ACCOUNT_ID_HASH = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const ACCOUNT_ADDRESS_SCRIPT_HASH = '13ef519c362973f9a34648a9eac5b71250b2a80a';

function readDeployedAbi() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const methods = Array.isArray(manifest?.abi?.methods)
    ? manifest.abi.methods.map((method) => String(method?.name || ''))
    : [];
  return { manifest, methods, entrypoints: methods.filter((name) => name.startsWith('execute')) };
}

/** A legacy-shaped invocation: hash160 account, hash160 target, method, args, then the V1/V2 tail. */
function legacyShapedInvocation(operation) {
  return {
    scriptHash: AA_HASH,
    operation,
    args: [
      { type: 'Hash160', value: `0x${ACCOUNT_ADDRESS_SCRIPT_HASH}` },
      { type: 'Hash160', value: '0xd2a4cff31913016155e38e474a2c06d08be276cf' },
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

function stagedV3Body() {
  return execution.buildStagedTransactionBody({
    aaContractHash: AA_HASH,
    account: { accountIdHash: ACCOUNT_ID_HASH, accountAddressScriptHash: ACCOUNT_ADDRESS_SCRIPT_HASH },
    operationBody: {
      kind: 'invoke',
      targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
      method: 'transfer',
      args: [],
    },
    signerAddress: 'NdzSignerAddress',
  });
}

test('the deployed manifest is the V3 core, excludes the V1/V2 names and names its execution surface', () => {
  const { manifest, methods, entrypoints } = readDeployedAbi();

  assert.equal(manifest.name, 'UnifiedSmartWalletV3');
  assert.deepEqual(
    entrypoints.slice().sort(),
    ['executeSponsoredUserOp', 'executeSponsoredUserOps', 'executeUserOp', 'executeUserOps'],
    'the deployed ABI execution surface changed; every other assertion in this file reads it as the oracle',
  );
  for (const dead of ['executeUnified', 'executeUnifiedByAddress']) {
    assert.equal(methods.includes(dead), false, `${dead} must not be exported by the deployed ABI`);
  }
});

test('every exported binding on the client execution surface is the inventoried census', () => {
  for (const [moduleName, expected] of Object.entries(CLIENT_SURFACE_FUNCTIONS)) {
    const actual = Object.keys(CLIENT_SURFACE[moduleName])
      .filter((name) => ['function', 'object'].includes(typeof CLIENT_SURFACE[moduleName][name]))
      .sort();
    assert.deepEqual(
      actual,
      expected.slice().sort(),
      `${moduleName} changed its executable surface: a new binding must be added to the census and pass the deployed-ABI assertion`,
    );
  }
});

test('the client execution-surface list is exactly the deployed ABI execution surface', () => {
  const { entrypoints } = readDeployedAbi();

  assert.ok(
    Array.isArray(signedInvocation.DEPLOYED_ENTRYPOINTS),
    'the client must export the entrypoint list its selector and submission path decide on, so it can be held to the deployed ABI',
  );
  assert.deepEqual(
    signedInvocation.DEPLOYED_ENTRYPOINTS.slice().sort(),
    entrypoints.slice().sort(),
    'the client list drifted from the deployed ABI: derive it from contracts/build/UnifiedSmartWalletV3.manifest.json',
  );
  for (const operation of entrypoints) {
    assert.equal(signedInvocation.isDeployedEntrypoint(operation), true, `${operation} must be accepted`);
  }
  for (const dead of ['executeUnified', 'executeUnifiedByAddress']) {
    assert.equal(signedInvocation.isDeployedEntrypoint(dead), false, `${dead} must be refused`);
  }
});

test('the invocation builders emit only entrypoints the deployed ABI exports', () => {
  const { entrypoints } = readDeployedAbi();
  const built = [];

  const direct = metaTx.buildExecuteUserOpInvocation({
    aaContractHash: AA_HASH,
    accountIdHash: ACCOUNT_ID_HASH,
    targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
    method: 'transfer',
    methodArgs: [],
    nonce: 1n,
    deadline: 1710001234,
    signatureHex: '',
  });
  built.push(['metaTx.buildExecuteUserOpInvocation', direct]);

  const body = stagedV3Body();
  built.push(['execution.buildStagedTransactionBody.clientInvocation', body.clientInvocation]);
  built.push(['execution.buildStagedTransactionBody.v3Invocation', body.v3Invocation]);

  const unsigned = execution.buildClientBroadcastRequest({
    signerAddress: 'NdzSignerAddress',
    transactionBody: { ...body, v3Invocation: null, clientInvocation: body.clientInvocation },
  });
  built.push(['execution.buildClientBroadcastRequest', unsigned]);

  // The staging path with an account the V3 core cannot identify: it must refuse, and if a future
  // producer makes it return an invocation instead, that invocation is checked here too.
  try {
    built.push(['execution.buildStagedTransactionBody (no V3 account)', execution.buildStagedTransactionBody({
      aaContractHash: AA_HASH,
      account: { accountAddressScriptHash: ACCOUNT_ADDRESS_SCRIPT_HASH },
      operationBody: {
        kind: 'invoke',
        targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
        method: 'transfer',
        args: [],
      },
      signerAddress: 'NdzSignerAddress',
    }).clientInvocation]);
  } catch (error) {
    assert.equal(error?.message, EC.v3AccountRequired, `unexpected refusal: ${error.message}`);
  }

  // The wallet path fed a legacy-shaped envelope: it must refuse or submit a deployed entrypoint,
  // never forward the envelope as-is.
  for (const operation of ['executeUnified', 'executeUnifiedByAddress']) {
    try {
      built.push([`execution.buildClientBroadcastRequest (${operation})`, execution.buildClientBroadcastRequest({
        signerAddress: 'NdzSignerAddress',
        transactionBody: { clientInvocation: legacyShapedInvocation(operation) },
      })]);
    } catch (error) {
      assert.equal(error?.message, EC.clientInvocationMissing, `unexpected refusal: ${error.message}`);
    }
  }

  for (const [label, invocation] of built) {
    assert.ok(invocation && typeof invocation.operation === 'string', `${label} produced no invocation`);
    assert.equal(
      entrypoints.includes(invocation.operation),
      true,
      `${label} built an invocation naming ${invocation.operation}, which the deployed ABI does not export`,
    );
  }
});

test('the signed-invocation selector accepts only entrypoints the deployed ABI exports', () => {
  const { entrypoints } = readDeployedAbi();

  // A single-operation envelope (executeUserOp) and a batch envelope (executeUserOps), carried by a
  // signed record's metaInvocation, are both selectable and both name a deployed entrypoint.
  for (const operation of ['executeUserOp', 'executeUserOps']) {
    assert.equal(entrypoints.includes(operation), true, `${operation} must be a deployed entrypoint for this test to mean anything`);
    const invocation = { ...metaTx.buildExecuteUserOpInvocation({
      aaContractHash: AA_HASH,
      accountIdHash: ACCOUNT_ID_HASH,
      targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
      method: 'transfer',
      methodArgs: [],
      nonce: 1n,
      deadline: 1710001234,
      signatureHex: 'ab'.repeat(64),
    }), operation };
    const selected = signedInvocation.selectSignedInvocation({
      transactionBody: { network: 'neo-n3-mainnet' },
      signatures: [{ signerId: 'evm:alice', kind: 'evm', metadata: { metaInvocation: invocation } }],
    });
    assert.equal(selected?.operation, operation, `${operation} is a deployed entrypoint and must stay selectable`);
  }

  // A dead-name envelope must never come back as the selected invocation: it is refused outright
  // when it carries a signature shape the selector has to read, and never selected when it does not.
  for (const dead of ['executeUnified', 'executeUnifiedByAddress']) {
    assert.equal(entrypoints.includes(dead), false, `${dead} must not be a deployed entrypoint for this test to mean anything`);
    const attempts = [
      { transactionBody: { network: 'neo-n3-mainnet', clientInvocation: legacyShapedInvocation(dead) }, signatures: [] },
      {
        transactionBody: { network: 'neo-n3-mainnet' },
        signatures: [{ signerId: 'evm:alice', kind: 'evm', metadata: { metaInvocation: legacyShapedInvocation(dead) } }],
      },
    ];
    for (const attempt of attempts) {
      let selected = null;
      try {
        selected = signedInvocation.selectSignedInvocation(attempt);
      } catch (error) {
        assert.match(error.message, /unsupported AA wrapper/, `${dead} was refused for the wrong reason: ${error.message}`);
      }
      assert.equal(selected, null, `${dead} is not a deployed entrypoint and must not be selected`);
    }
  }
});

test('staging a body without a V3 accountIdHash fails instead of building a legacy invocation', () => {
  assert.throws(
    () => execution.buildStagedTransactionBody({
      aaContractHash: AA_HASH,
      account: { accountAddressScriptHash: ACCOUNT_ADDRESS_SCRIPT_HASH },
      operationBody: {
        kind: 'invoke',
        targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
        method: 'transfer',
        args: [],
      },
      signerAddress: 'NdzSignerAddress',
    }),
    (error) => error?.message === EC.v3AccountRequired,
    'a staged body without a V3 account id must be refused, not silently downgraded to the V1/V2 envelope',
  );
});

test('a staged body keeps no legacy invocation field for a caller to fall back to', () => {
  const body = stagedV3Body();

  assert.equal(Object.hasOwn(body, 'legacyInvocation'), false, 'the staged body must not carry a legacy invocation field');
  assert.equal(body.v3Invocation.operation, 'executeUserOp');
});

test('a legacy-shaped client invocation cannot be turned into a client broadcast request', () => {
  const legacyShapes = ['executeUnified', 'executeUnifiedByAddress'].map(legacyShapedInvocation);

  for (const clientInvocation of legacyShapes) {
    let broadcast = null;
    let refusal = null;
    try {
      broadcast = execution.buildClientBroadcastRequest({ signerAddress: 'NdzSignerAddress', transactionBody: { clientInvocation } });
    } catch (error) {
      refusal = error;
    }
    assert.equal(broadcast, null, `a legacy envelope (${clientInvocation.operation}) must never become a wallet request`);
    if (refusal) {
      assert.match(refusal.message, /unsupported AA wrapper|Invalid account execution envelope|^EC_client_invocation_missing$/, `unexpected refusal: ${refusal.message}`);
    }
  }
});
