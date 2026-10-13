import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddressFromScriptHash } from '../src/utils/neo.js';
import { validateRegistrationOwner, decodePendingUpdate, buildGovernanceAction, assertGovernanceReviewCurrent, readGovernanceSnapshot } from '../src/features/studio/governance.js';
const owner = '11'.repeat(20), accountId = '22'.repeat(20), verifier = '33'.repeat(20), hook = '44'.repeat(20);
const pending = { module: '55'.repeat(20), params: '03abcd', initiatedAt: 1000, matureAt: 86401000 };
const base = () => ({ accountId, backupOwner: owner, verifier, hook, escapeTimelock: 604800, escapeTriggeredAt: 0, escapeActive: false, marketEscrow: false, chain: { height: 10, hash: 'aa'.repeat(32), time: pending.matureAt }, pendingVerifier: { exists: true, full: true, ...pending }, pendingHook: { exists: false, full: true } });
test('registration requires the connected Neo witness, preserving Neo address/hash equivalence', () => {
  assert.equal(validateRegistrationOwner(getAddressFromScriptHash(owner), `0x${owner}`), '');
  assert.equal(validateRegistrationOwner(`0x${owner}`, getAddressFromScriptHash(owner)), '');
  assert.equal(validateRegistrationOwner('0x' + '99'.repeat(20), owner), 'owner-mismatch');
  assert.equal(validateRegistrationOwner('N' + 'x'.repeat(33), owner), 'owner-invalid');
  assert.equal(validateRegistrationOwner('00'.repeat(20), owner), 'owner-invalid');
});
test('pending update decoder preserves full target and initialization bytes and rejects malformed time', () => {
  const item = { type: 'Array', value: [{ type: 'ByteString', value: Buffer.from(pending.module, 'hex').reverse().toString('base64') }, { type: 'ByteString', value: Buffer.from(pending.params, 'hex').toString('base64') }, { type: 'Integer', value: '1000' }, { type: 'Integer', value: '86401000' }] };
  assert.deepEqual(decodePendingUpdate(item), { exists: true, full: true, ...pending });
  assert.deepEqual(decodePendingUpdate({ type: 'Any', value: null }), { exists: false, full: true });
  assert.throws(() => decodePendingUpdate({ ...item, value: [...item.value.slice(0, 3), { type: 'Integer', value: '-1' }] }), /pending/);
});
test('confirm uses real ABI only once mature and exact reviewed pending is still present', () => {
  const snapshot = base();
  const review = buildGovernanceAction(snapshot, 'confirmVerifierUpdate');
  assert.deepEqual(review.args, [{ type: 'Hash160', value: accountId }]);
  assert.throws(() => buildGovernanceAction({ ...snapshot, chain: { ...snapshot.chain, time: pending.matureAt - 1 } }, 'confirmVerifierUpdate'), /timelock/);
  assert.throws(() => assertGovernanceReviewCurrent(review, { ...snapshot, pendingVerifier: { ...snapshot.pendingVerifier, params: '02ffff' } }, owner), /changed/);
  assert.throws(() => assertGovernanceReviewCurrent(review, { ...snapshot, accountId: '66'.repeat(20) }, owner), /changed/);
  assert.throws(() => assertGovernanceReviewCurrent(review, snapshot, '77'.repeat(20)), /backup owner/);
  assert.doesNotThrow(() => assertGovernanceReviewCurrent(review, { ...snapshot, chain: { ...snapshot.chain, time: pending.matureAt + 10 } }, owner));
});
test('old deployments expose limited cancellation but cannot confirm an unknown target', () => {
  const snapshot = base(); snapshot.pendingVerifier = { exists: true, full: false, matureAt: pending.matureAt };
  assert.throws(() => buildGovernanceAction(snapshot, 'confirmVerifierUpdate'), /complete pending/);
  assert.equal(buildGovernanceAction(snapshot, 'cancelVerifierUpdate').operation, 'cancelVerifierUpdate');
  assert.throws(() => buildGovernanceAction({ ...snapshot, pendingVerifier: { exists: false, full: false } }, 'cancelVerifierUpdate'), /pending/);
});
test('recovery binds replacement parameters, explicit backup-owner mode and chain maturity', () => {
  const snapshot = { ...base(), escapeActive: true, escapeTriggeredAt: 1000, chain: { time: 604801000 } };
  const review = buildGovernanceAction(snapshot, 'finalizeEscape', { mode: 'verifier', verifier: '66'.repeat(20), params: '0x02abcd' });
  assert.deepEqual(review.args.slice(1), [{ type: 'Hash160', value: '66'.repeat(20) }, { type: 'ByteArray', value: '0x02abcd' }]);
  assert.throws(() => buildGovernanceAction(snapshot, 'finalizeEscape', { mode: 'verifier', verifier, params: '' }), /parameters/);
  assert.throws(() => buildGovernanceAction(snapshot, 'finalizeEscape', { mode: 'verifier', verifier, params: 'zz' }), /parameters/);
  const fallback = buildGovernanceAction(snapshot, 'finalizeEscape', { mode: 'backup-owner' });
  assert.equal(fallback.args[1].value, '00'.repeat(20));
  assert.equal(fallback.args[2].value, '0x');
  assert.throws(() => buildGovernanceAction({ ...snapshot, chain: { time: 604800999 } }, 'finalizeEscape', { mode: 'backup-owner' }), /timelock/);
});
test('snapshot reading detects old ABI and refuses inconsistent block snapshots', async () => {
  const clock = { height: 10, hash: 'aa'.repeat(32), time: pending.matureAt };
  const reads = [];
  const read = async (method) => { reads.push(method); const hashes = { getVerifier: verifier, getHook: hook, getBackupOwner: owner }; return { state: 'HALT', stack: [hashes[method] ? { type: 'Hash160', value: hashes[method] } : method === 'getEscapeTimelock' ? { type: 'Integer', value: '604800' } : method.endsWith('Time') ? { type: 'Integer', value: method.includes('Verifier') ? String(pending.matureAt) : '0' } : method === 'getEscapeTriggeredAt' ? { type: 'Integer', value: '0' } : { type: 'Boolean', value: method === 'hasPendingVerifierUpdate' }] }; };
  const snapshot = await readGovernanceSnapshot({ accountId, read, readClock: async () => clock, fullPendingRoles: [] });
  assert.equal(snapshot.pendingVerifier.full, false);
  assert.equal(snapshot.pendingVerifier.matureAt, pending.matureAt);
  assert.equal(reads.includes('getPendingVerifierUpdate'), false);
  let calls = 0;
  await assert.rejects(() => readGovernanceSnapshot({ accountId, read, readClock: async () => ({ ...clock, height: calls++ }) }), /block changed/);
});
