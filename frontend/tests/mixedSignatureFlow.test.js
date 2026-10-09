import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CORE_HASH, executeUserOpInvocation } from './fixtures/aaChainFixtures.js';
import { EC } from '../src/config/errorCodes.js';

import {
  appendSignatureEntries,
  buildTransactionDraftExport,
  summarizeSignerProgress,
} from '../src/features/operations/signatures.js';
import {
  buildDraftApprovalTypedData,
  buildDraftExportBundle,
  buildRelayBroadcastRequest,
  buildRelayPayloadOptions,
  buildStagedTransactionBody,
  executeBroadcast,
  resolveRelayPayloadMode,
} from '../src/features/operations/execution.js';

test('Neo and EVM signatures can attach to the same immutable draft', () => {
  const signatures = appendSignatureEntries([], {
    signerId: 'neo:alice',
    kind: 'neo',
    signatureHex: '0xAA',
  });
  const next = appendSignatureEntries(signatures, {
    signerId: 'evm:bob',
    kind: 'evm',
    signatureHex: '0xBB',
  });

  assert.equal(signatures.length, 1);
  assert.equal(next.length, 2);
  assert.equal(next[0].signatureHex, 'aa');
  assert.equal(next[1].signatureHex, 'bb');
});

test('signature entries preserve metadata for later relay/export use', () => {
  const entries = appendSignatureEntries([], {
    signerId: 'evm:bob',
    kind: 'evm',
    signatureHex: '0xBB',
    publicKey: `04${'11'.repeat(64)}`,
    metadata: { nonce: '3', deadline: 1710000000 },
  });

  assert.equal(entries[0].publicKey, `04${'11'.repeat(64)}`);
  assert.equal(entries[0].metadata.nonce, '3');
});

test('signer progress tracks satisfied and pending signers', () => {
  const progress = summarizeSignerProgress(
    [
      { id: 'neo:alice', kind: 'neo' },
      { id: 'evm:bob', kind: 'evm' },
    ],
    [{ signerId: 'neo:alice', kind: 'neo', signatureHex: 'aa' }]
  );

  assert.equal(progress.requiredCount, 2);
  assert.equal(progress.signatureCount, 1);
  assert.equal(progress.satisfied.length, 1);
  assert.equal(progress.pending.length, 1);
  assert.equal(progress.isComplete, false);
});

test('transaction draft export includes body, signatures, and share metadata', () => {
  const exported = buildTransactionDraftExport({
    account: { accountIdHex: 'aa' },
    operationBody: { method: 'transfer' },
    transactionBody: { txHex: 'deadbeef' },
    signerRequirements: [{ id: 'neo:alice', kind: 'neo' }],
    signatures: [{ signerId: 'neo:alice', kind: 'neo', signatureHex: 'aa' }],
    share: { draftId: 'draft-1' },
    broadcast: { mode: 'relay' },
  });

  assert.equal(exported.transactionBody.txHex, 'deadbeef');
  assert.equal(exported.signatures.length, 1);
  assert.equal(exported.share.draftId, 'draft-1');
  assert.equal(exported.broadcast.mode, 'relay');
});

test('buildStagedTransactionBody refuses an account without a V3 id instead of wrapping through a V1/V2 envelope', () => {
  // CU-209: this used to stage a V1/V2 invocation naming an entrypoint no deployed contract
  // exports. The V3 guard now refuses the input that produced it.
  assert.throws(
    () => buildStagedTransactionBody({
      aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
      account: {
        accountIdHex: '56e5bbd0603bdf01699c047b2397ee0e',
        accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a',
      },
      operationBody: {
        kind: 'invoke',
        targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
        method: 'balanceOf',
        args: [{ type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' }],
      },
      signerAddress: 'NdzSignerAddress',
    }),
    (error) => error?.message === EC.v3AccountRequired,
  );
});

test('buildStagedTransactionBody prefers executeUserOp when accountIdHash is present', () => {
  const before = Date.now();
  const body = buildStagedTransactionBody({
    aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    account: {
      accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
      accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a',
    },
    operationBody: {
      kind: 'invoke',
      targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
      method: 'balanceOf',
      args: [{ type: 'Hash160', value: '0x13ef519c362973f9a34648a9eac5b71250b2a80a' }],
    },
    signerAddress: 'NdzSignerAddress',
  });

  assert.equal(body.clientInvocation.operation, 'executeUserOp');
  assert.equal(body.v3Invocation.operation, 'executeUserOp');
  assert.equal(body.accountIdHash, 'f951cd3eb5196dacde99b339c5dcca37ac38cc22');
  assert.equal(Object.hasOwn(body, 'legacyInvocation'), false);
  const deadline = Number(body.v3Invocation.args[1].value[4].value);
  assert.ok(deadline >= before + 3_599_000, 'V3 fallback deadline should use Runtime.Time milliseconds');
  assert.ok(deadline <= Date.now() + 3_601_000, 'V3 fallback deadline should be one hour from now');
});

test('buildStagedTransactionBody labels the network from the active morpheus network', () => {
  const baseArgs = {
    aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
    account: {
      accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
      accountAddressScriptHash: '13ef519c362973f9a34648a9eac5b71250b2a80a',
    },
    operationBody: {
      kind: 'invoke',
      targetContract: 'd2a4cff31913016155e38e474a2c06d08be276cf',
      method: 'balanceOf',
      args: [],
    },
    signerAddress: 'NdzSignerAddress',
  };

  assert.equal(
    buildStagedTransactionBody({ ...baseArgs, morpheusNetwork: 'mainnet' }).network,
    'neo-n3-mainnet',
  );
  assert.equal(
    buildStagedTransactionBody({ ...baseArgs, morpheusNetwork: 'testnet' }).network,
    'neo-n3-testnet',
  );
  // An explicit network label wins over the morpheus network heuristic.
  assert.equal(
    buildStagedTransactionBody({ ...baseArgs, network: 'neo-n3-privatenet', morpheusNetwork: 'mainnet' }).network,
    'neo-n3-privatenet',
  );
});

test('buildDraftApprovalTypedData binds the domain chainId to the active network magic', () => {
  const draftRecord = {
    draft_id: 'draft-1',
    share_slug: 'share-1',
    account: { accountIdHex: 'aa11', accountAddressScriptHash: 'bb22' },
    transaction_body: { txHex: 'deadbeef', method: 'transfer' },
    broadcast_mode: 'relay',
  };

  // Explicit chain id is honoured for both mainnet and testnet magics.
  assert.equal(buildDraftApprovalTypedData({ draftRecord, chainId: 860833102 }).domain.chainId, 860833102);
  assert.equal(buildDraftApprovalTypedData({ draftRecord, chainId: 894710606 }).domain.chainId, 894710606);
  // The implicit default tracks RUNTIME_CONFIG.networkMagic (mainnet by default).
  assert.equal(buildDraftApprovalTypedData({ draftRecord }).domain.chainId, 860833102);
});

test('buildDraftApprovalTypedData creates an EVM-friendly approval payload from an immutable draft', () => {
  const typedData = buildDraftApprovalTypedData({
    draftRecord: {
      draft_id: 'draft-1',
      share_slug: 'share-1',
      account: { accountIdHex: 'aa11', accountAddressScriptHash: 'bb22' },
      transaction_body: { txHex: 'deadbeef', method: 'transfer' },
      signer_requirements: [{ id: 'evm:bob', kind: 'evm' }],
      broadcast_mode: 'relay',
    },
  });

  assert.equal(typedData.domain.name, 'Neo Abstract Account Workspace');
  assert.equal(typedData.domain.version, '1');
  assert.equal(typedData.message.shareSlug, 'share-1');
  assert.match(typedData.message.payloadDigest, /^0x[0-9a-f]{64}$/i);
  assert.equal(typedData.types.DraftApproval[0].name, 'draftId');
});

test('broadcast helpers route client broadcasts through the wallet and relay broadcasts through the relay endpoint', async () => {
  const calls = [];
  const wallet = {
    async invoke(input) {
      calls.push({ kind: 'invoke', input });
      return { txid: '0xabc' };
    },
    async relayTransaction(input) {
      calls.push({ kind: 'relay', input });
      return { txid: '0xdef' };
    },
  };

  const clientResult = await executeBroadcast({
    mode: 'client',
    signerAddress: 'NdzSignerAddress',
    transactionBody: {
      clientInvocation: executeUserOpInvocation({ target: CORE_HASH, method: 'transfer', args: [] }),
    },
    walletService: wallet,
    relayEndpoint: '/api/relay-transaction',
  });

  const relayResult = await executeBroadcast({
    mode: 'relay',
    morpheusNetwork: 'testnet',
    transactionBody: {
      rawTransaction: '0xDEADBEEF',
    },
    walletService: wallet,
    relayEndpoint: '/api/relay-transaction',
  });

  assert.equal(clientResult.txid, '0xabc');
  assert.equal(relayResult.txid, '0xdef');
  assert.deepEqual(calls[0], {
    kind: 'invoke',
    input: {
      ...executeUserOpInvocation({ target: CORE_HASH, method: 'transfer', args: [] }),
      signers: [{ account: 'NdzSignerAddress', scopes: 1 }],
    },
  });
  assert.deepEqual(calls[1], {
    kind: 'relay',
    input: {
      relayEndpoint: '/api/relay-transaction',
      relayPayloadMode: 'raw',
      morpheus_network: 'testnet',
      rawTransaction: 'deadbeef',
    },
  });
});

test('executeBroadcast relay submit can use meta invocation carried by collected signatures', async () => {
  const calls = [];
  const wallet = {
    async relayTransaction(input) {
      calls.push(input);
      return { txid: '0xrelay' };
    },
  };

  const result = await executeBroadcast({
    mode: 'relay',
    relayPayloadMode: 'meta',
    relayRawEnabled: false,
    morpheusNetwork: 'testnet',
    transactionBody: {},
    signatures: [{
      signerId: 'evm:bob',
      kind: 'evm',
      metadata: {
        metaInvocation: executeUserOpInvocation(),
      },
    }],
    walletService: wallet,
    relayEndpoint: '/api/relay-transaction',
  });

  assert.equal(result.txid, '0xrelay');
  assert.deepEqual(calls[0], {
    relayEndpoint: '/api/relay-transaction',
    relayPayloadMode: 'meta',
    morpheus_network: 'testnet',
    metaInvocation: executeUserOpInvocation(),
  });
});

test('export bundle adds public and collaborator URLs without mutating the draft body', () => {
  const bundle = buildDraftExportBundle({
    draftRecord: {
      draft_id: 'draft-1',
      share_slug: 'share-1',
      collaboration_slug: 'collab-1',
      transaction_body: { txHex: 'deadbeef' },
    },
    origin: 'https://example.org',
  });

  assert.equal(bundle.share_url, 'https://example.org/tx/share-1');
  assert.equal(bundle.collaboration_url, 'https://example.org/tx/share-1?access=collab-1');
  assert.equal(bundle.transaction_body.txHex, 'deadbeef');
});

test('buildRelayPayloadOptions exposes raw mode only when raw relay forwarding is enabled', () => {
  const enabled = buildRelayPayloadOptions({
    runtime: { relayRawEnabled: true },
    transactionBody: { rawTransaction: '0xdeadbeef' },
    signatures: [{
      kind: 'evm',
      metadata: { metaInvocation: executeUserOpInvocation() },
    }],
  });
  const disabled = buildRelayPayloadOptions({
    runtime: { relayRawEnabled: false },
    transactionBody: { rawTransaction: '0xdeadbeef' },
    signatures: [{
      kind: 'evm',
      metadata: { metaInvocation: executeUserOpInvocation() },
    }],
  });

  assert.deepEqual(enabled, ['best', 'raw', 'meta']);
  assert.deepEqual(disabled, ['meta']);
  assert.equal(resolveRelayPayloadMode({ relayPayloadMode: 'best', availableModes: enabled }), 'raw');
  assert.equal(resolveRelayPayloadMode({ relayPayloadMode: 'meta', availableModes: enabled }), 'meta');
});

test('buildRelayBroadcastRequest uses stored meta invocations when raw transaction bytes are absent', () => {
  const request = buildRelayBroadcastRequest({
    relayEndpoint: '/api/relay-transaction',
    morpheusNetwork: 'testnet',
    relayPayloadMode: 'meta',
    transactionBody: {},
    signatures: [{
      signerId: 'evm:bob',
      kind: 'evm',
      metadata: { metaInvocation: executeUserOpInvocation() },
    }],
  });

  assert.deepEqual(request, {
    relayEndpoint: '/api/relay-transaction',
    relayPayloadMode: 'meta',
    morpheus_network: 'testnet',
    metaInvocation: executeUserOpInvocation(),
  });
});


test('buildRelayBroadcastRequest rejects raw relay when raw forwarding is disabled', () => {
  assert.throws(
    () => buildRelayBroadcastRequest({
      relayEndpoint: '/api/relay-transaction',
      relayRawEnabled: false,
      transactionBody: { rawTransaction: '0xdeadbeef' },
    }),
    /raw relay forwarding is not enabled/i,
  );
});

test('buildRelayBroadcastRequest honors explicit meta selection when raw and meta payloads both exist', () => {
  const request = buildRelayBroadcastRequest({
    relayEndpoint: '/api/relay-transaction',
    morpheusNetwork: 'testnet',
    relayPayloadMode: 'meta',
    transactionBody: { rawTransaction: '0xdeadbeef' },
    signatures: [{
      signerId: 'evm:bob',
      kind: 'evm',
      metadata: { metaInvocation: executeUserOpInvocation() },
    }],
  });

  assert.deepEqual(request, {
    relayEndpoint: '/api/relay-transaction',
    relayPayloadMode: 'meta',
    morpheus_network: 'testnet',
    metaInvocation: executeUserOpInvocation(),
  });
});

test('buildRelayBroadcastRequest forwards paymaster metadata when present', () => {
  const request = buildRelayBroadcastRequest({
    relayEndpoint: '/api/relay-transaction',
    morpheusNetwork: 'testnet',
    relayPayloadMode: 'meta',
    transactionBody: {
      paymaster: {
        account_id: 'aa-test',
        zerc20Proof: {
          public_inputs: { recipient: '0x' + '11'.repeat(20) },
        },
      },
    },
    signatures: [{
      signerId: 'evm:bob',
      kind: 'evm',
      metadata: {
        metaInvocation: executeUserOpInvocation(),
      },
    }],
  });

  assert.deepEqual(request, {
    relayEndpoint: '/api/relay-transaction',
    relayPayloadMode: 'meta',
    morpheus_network: 'testnet',
    metaInvocation: executeUserOpInvocation(),
    paymaster: {
      account_id: 'aa-test',
      zerc20Proof: {
        public_inputs: { recipient: '0x' + '11'.repeat(20) },
      },
    },
  });
});

test('buildRelayBroadcastRequest rejects missing signed raw transactions', () => {
  assert.throws(
    () => buildRelayBroadcastRequest({ relayEndpoint: '/api/relay-transaction', transactionBody: {} }),
    /signed raw transaction|meta invocation/i,
  );
});

test('wallet service exposes EVM connect and sign helpers', () => {
  const source = fs.readFileSync(path.resolve('src/services/walletService.js'), 'utf8');
  assert.match(source, /connectEvm/);
  assert.match(source, /signTypedDataWithEvm/);
  assert.match(source, /getAvailableWalletModes/);
  assert.match(source, /relayTransaction/);
});

// --- CU-06: a relay verdict of ok:false is not a submission ---------------------------------------------------
// The route answers a refused broadcast (a simulated transfer that returned false, a VM fault in the preview)
// with HTTP 200, ok:false and no txid. Reporting that as "Relay Submission Sent" is the silent no-op.

function metaSignature() {
  return [{
    signerId: 'evm:bob',
    kind: 'evm',
    metadata: {
      metaInvocation: executeUserOpInvocation(),
    },
  }];
}

const relaySubmit = (walletService) => executeBroadcast({
  mode: 'relay',
  relayPayloadMode: 'meta',
  relayRawEnabled: false,
  morpheusNetwork: 'testnet',
  transactionBody: {},
  signatures: metaSignature(),
  walletService,
  relayEndpoint: '/api/relay-transaction',
});

test('CU-06: executeBroadcast rejects a relay answer that says ok:false and carries the route reason', async () => {
  const refusal = {
    simulate: true,
    ok: false,
    code: 'relay_transfer_returned_false',
    vmState: 'HALT',
    operation: 'executeUserOp',
    exception: 'A token transfer returned false, so no tokens moved; the nonce and the fee are still spent.',
  };
  await assert.rejects(
    () => relaySubmit({ async relayTransaction() { return refusal; } }),
    (error) => /transfer returned false/i.test(error.message),
  );

  const fault = { simulate: true, ok: false, code: 'relay_simulation_fault', vmState: 'FAULT', exception: 'Invalid sequence for channel' };
  await assert.rejects(
    () => relaySubmit({ async relayTransaction() { return fault; } }),
    (error) => /Invalid sequence for channel/.test(error.message),
  );

  await assert.rejects(
    () => relaySubmit({ async relayTransaction() { return { ok: false }; } }),
    (error) => typeof error.message === 'string' && error.message.length > 0,
    'a bare ok:false still fails, with a stable fallback message',
  );
});

test('CU-06: executeBroadcast keeps returning successful relay bodies untouched', async () => {
  const sent = { txid: '0xdef', systemFee: '88628280', networkFee: '1369520', invocation: { operation: 'executeUserOp' } };
  assert.deepEqual(await relaySubmit({ async relayTransaction() { return sent; } }), sent);

  const rawSent = { txid: '0xabc', result: { hash: '0xabc' } };
  assert.deepEqual(await relaySubmit({ async relayTransaction() { return rawSent; } }), rawSent);
});
