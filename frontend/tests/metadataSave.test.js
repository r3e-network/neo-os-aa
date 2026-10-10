import test from 'node:test';
import assert from 'node:assert/strict';
import { captureMetadataSaveIntent, metadataIntentMatchesCurrent, metadataMirrorPayload } from '../src/features/studio/metadataSave.js';

const base = () => captureMetadataSaveIntent({
  accountAddress: `  ${'22'.repeat(20)} `,
  accountIdHash: 'AA'.repeat(20),
  backupOwner: '11'.repeat(20),
  wallet: 'Nbackup-owner',
  rpcUrl: 'https://fixture.test/rpc',
  coreHash: 'CC'.repeat(20),
  metadataUri: ' https://fixture.test/original.json ',
  description: ' original description ',
  logoUrl: ' https://fixture.test/original.png ',
  idToken: 'token-original',
  epoch: 4,
  walletContext: 2,
});

test('metadata intent freezes canonical fields and builds the matching mirror payload', () => {
  const intent = base();
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(intent.metadataUri, 'https://fixture.test/original.json');
  assert.equal(intent.accountIdHash, 'aa'.repeat(20));
  assert.deepEqual(metadataMirrorPayload(intent), {
    accountIdHash: 'aa'.repeat(20),
    description: 'original description',
    logoUrl: 'https://fixture.test/original.png',
    metadataUri: 'https://fixture.test/original.json',
    idToken: 'token-original',
  });
});

test('metadata intent rejects account, context, form, or identity changes after signing starts', () => {
  const intent = base();
  const current = {
    accountAddress: intent.accountAddress,
    accountIdHash: intent.accountIdHash,
    backupOwner: intent.backupOwner,
    wallet: intent.wallet,
    rpcUrl: intent.rpcUrl,
    coreHash: intent.coreHash,
    metadataUri: intent.metadataUri,
    description: intent.description,
    logoUrl: intent.logoUrl,
    idToken: intent.idToken,
    epoch: intent.epoch,
    walletContext: intent.walletContext,
  };
  assert.equal(metadataIntentMatchesCurrent(intent, current), true);
  for (const field of ['accountAddress', 'backupOwner', 'wallet', 'rpcUrl', 'coreHash', 'metadataUri', 'description', 'logoUrl', 'idToken', 'walletContext']) {
    assert.equal(metadataIntentMatchesCurrent(intent, { ...current, [field]: `${current[field]}-changed` }), false, field);
  }
  assert.equal(metadataIntentMatchesCurrent(intent, { ...current, epoch: intent.epoch + 1 }), false);
});
