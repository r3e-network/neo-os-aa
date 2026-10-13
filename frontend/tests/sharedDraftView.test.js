import test from 'node:test';
import assert from 'node:assert/strict';

import { executeUserOpInvocation } from './fixtures/aaChainFixtures.js';
import {
  buildCollectedSignatureCards,
  buildOperationSnapshotItems,
  buildSignerChecklistItems,
} from '../src/features/operations/sharedDraftView.js';

test('buildOperationSnapshotItems summarizes operation fields and available payloads', () => {
  const items = buildOperationSnapshotItems({
    draft: {
      operation_body: {
        targetContract: '0xabc123',
        method: 'transfer',
        args: [{ type: 'Hash160' }, { type: 'Integer' }],
      },
      transaction_body: {
        rawTransaction: 'aa',
        // A deployed V3 invocation, signed: this is what the client stages now, and what the
        // payload summary has to report as a relay-ready invocation.
        clientInvocation: executeUserOpInvocation({ nonce: 1 }),
      },
    },
    relayReadiness: {
      label: 'Relay Payload Ready',
      detail: 'Signed raw transaction is staged; run relay preflight first.',
      runtime: { relayRawEnabled: true },
    },
  });

  assert.deepEqual(items.map((item) => item.label), [
    'Target Contract',
    'Method',
    'Arguments',
    'Relay State',
    'Payloads',
  ]);
  assert.equal(items[0].value, '0xabc123');
  assert.equal(items[1].value, 'transfer');
  assert.equal(items[2].value, '2 argument(s)');
  assert.equal(items[3].value, 'Relay Payload Ready');
  assert.equal(items[4].value, 'Raw Tx + UserOperation Invocation');
});

test('buildSignerChecklistItems marks required signers and surfaces extras', () => {
  const items = buildSignerChecklistItems({
    signerRequirements: [
      { id: 'neo-alice', kind: 'neo' },
      { id: '0xevm', kind: 'evm' },
    ],
    signatures: [
      { signerId: 'neo-alice', kind: 'neo', signatureHex: '11' },
      { signerId: 'neo-bob', kind: 'neo', signatureHex: '22' },
    ],
  });

  assert.deepEqual(items.map((item) => item.status), ['Collected', 'Pending', 'Collected']);
  assert.deepEqual(items.map((item) => item.kind), ['neo', 'evm', 'neo']);
  assert.match(items[0].detail, /Signature attached/i);
  assert.match(items[1].detail, /Awaiting signature/i);
  assert.match(items[2].detail, /Additional collected signer/i);
});

test('buildCollectedSignatureCards formats signer labels previews and metadata badges', () => {
  const items = buildCollectedSignatureCards([
    {
      signerId: '0xabc',
      kind: 'evm',
      signatureHex: 'abcdef1234567890',
      createdAt: '2026-03-09T10:00:00.000Z',
      metadata: { typedData: {}, metaInvocation: {} },
    },
  ]);

  assert.equal(items[0].label, 'EVM · 0xabc');
  assert.equal(items[0].signaturePreview, 'abcdef12…34567890');
  assert.equal(items[0].createdLabel, '2026-03-09');
  assert.equal(items[0].badges.join(', '), 'Typed Data, Relay Invocation');
});
