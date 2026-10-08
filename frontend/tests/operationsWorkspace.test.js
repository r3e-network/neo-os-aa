import test from 'node:test';
import assert from 'node:assert/strict';
import { executeUserOpInvocation } from './fixtures/aaChainFixtures.js';

import { createOperationsWorkspace } from '../src/features/operations/useOperationsWorkspace.js';
import { buildRelayPayloadOptions } from '../src/features/operations/execution.js';

test('workspace holds AA identity, operation body, signers, signatures, and share metadata', () => {
  const workspace = createOperationsWorkspace();

  workspace.loadAbstractAccount({
    accountAddressScriptHash: 'bb22',
  });
  workspace.setOperationBody({ kind: 'invoke', targetContract: 'cc33', method: 'transfer', args: ['x'] });
  workspace.setTransactionBody({ txHex: 'deadbeef' });
  workspace.setSignerRequirements([
    { id: 'neo:alice', kind: 'neo' },
    { id: 'evm:bob', kind: 'evm' },
  ]);
  workspace.appendSignature({ signerId: 'neo:alice', kind: 'neo', signatureHex: '11' });
  workspace.markPersisted({
    draftId: 'draft-1',
    shareSlug: 'share-1',
    collaborationSlug: 'collab-1',
    operatorSlug: 'operator-1',
    canWrite: true,
    canOperate: true,
    accessScope: 'operate',
  });

  assert.equal('accountIdHex' in workspace.account.value, false);
  assert.equal(workspace.account.value.accountAddressScriptHash, 'bb22');
  assert.equal(workspace.operationBody.value.method, 'transfer');
  assert.equal(workspace.transactionBody.value.txHex, 'deadbeef');
  assert.equal(workspace.signerRequirements.value.length, 2);
  assert.equal(workspace.signatures.value.length, 1);
  assert.equal(workspace.share.value.draftId, 'draft-1');
  assert.equal(workspace.share.value.collaborationSlug, 'collab-1');
  assert.equal(workspace.share.value.operatorSlug, 'operator-1');
  assert.equal(workspace.share.value.canWrite, true);
  assert.equal(workspace.share.value.canOperate, true);
  assert.equal(workspace.share.value.accessScope, 'operate');
  assert.equal(workspace.isDraftImmutable.value, true);
});

test('workspace derives signer and bound-address forms from an AA draft', () => {
  const workspace = createOperationsWorkspace();

  workspace.loadAbstractAccount({
    accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
    accountAddressScriptHash: '11223344',
  });
  assert.equal(workspace.account.value.accountIdHash, 'f951cd3eb5196dacde99b339c5dcca37ac38cc22');
  assert.equal(workspace.account.value.accountSignerScriptHash, '44332211');

  workspace.loadAbstractAccount({
    accountSignerScriptHash: 'aabbccdd',
  });
  assert.equal(workspace.account.value.accountAddressScriptHash, 'ddccbbaa');
});

test('broadcast mode switches between client and relay without mutating draft body', () => {
  const workspace = createOperationsWorkspace();

  workspace.setOperationBody({ kind: 'invoke', targetContract: 'cc33', method: 'balanceOf', args: ['x'] });
  workspace.setTransactionBody({ txHex: 'bead' });
  const before = JSON.stringify(workspace.transactionBody.value);

  workspace.setBroadcastMode('relay');
  assert.equal(workspace.broadcast.value.mode, 'relay');
  assert.equal(JSON.stringify(workspace.transactionBody.value), before);

  workspace.setBroadcastMode('client');
  assert.equal(workspace.broadcast.value.mode, 'client');
  assert.equal(JSON.stringify(workspace.transactionBody.value), before);
});

test('immutable drafts reject transaction-body mutation after persistence', () => {
  const workspace = createOperationsWorkspace();
  workspace.setTransactionBody({ txHex: 'bead' });
  workspace.markPersisted({ draftId: 'draft-1', shareSlug: 'share-1' });

  assert.throws(
    () => workspace.setTransactionBody({ txHex: 'cafe' }),
    /immutable draft/
  );
});

test('signing a persisted draft appends the signature without mutating the immutable body', () => {
  const workspace = createOperationsWorkspace();
  workspace.setOperationBody({ kind: 'invoke', targetContract: 'cc33', method: 'transfer', args: [] });
  workspace.setTransactionBody({ txHex: '' });
  workspace.markPersisted({ draftId: 'draft-1', shareSlug: 'share-1' });
  assert.equal(workspace.isDraftImmutable.value, true);

  const metaInvocation = executeUserOpInvocation();

  // The signing flows skip setTransactionBody on persisted drafts and store
  // the invocation in the signature metadata instead — the relay path reads
  // it from there.
  workspace.appendSignature({
    signerId: 'evm:0xabc',
    kind: 'evm',
    signatureHex: '11'.repeat(64),
    metadata: { metaInvocation },
  });

  assert.equal(workspace.signatures.value.length, 1);
  assert.deepEqual(workspace.signatures.value[0].metadata.metaInvocation, metaInvocation);
  assert.deepEqual(
    buildRelayPayloadOptions({
      transactionBody: workspace.transactionBody.value,
      signatures: workspace.signatures.value,
    }),
    ['meta'],
  );
});

test('persisted workspace share paths use separate public, collaborator, and operator routes', () => {
  const workspace = createOperationsWorkspace();
  workspace.markPersisted({
    draftId: 'draft-1',
    shareSlug: 'share-1',
    collaborationSlug: 'collab-1',
    operatorSlug: 'operator-1',
    canWrite: true,
    canOperate: true,
    accessScope: 'operate',
  });

  assert.equal(workspace.share.value.sharePath, '/tx/share-1');
  assert.equal(workspace.share.value.collaborationPath, '/tx/share-1?access=collab-1');
  assert.equal(workspace.share.value.operatorPath, '/tx/share-1?access=operator-1');
});
