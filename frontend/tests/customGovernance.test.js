// The v4 configuration surface of the studio: one consistent snapshot read, the
// blockers that decide whether an intent can be proposed, the review record a
// confirmation is bound to, and the maturity clock a pending intent is read
// against. Every fixture value below is a documented in-VM layout, so a decoder
// that guesses instead of reading fails here.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertConfigurationReviewCurrent,
  captureConfigurationReview,
  configurationBlockers,
  custodyActionBlockers,
  custodyIssues,
  intentStatus,
  readAccountConfiguration,
  readChainClock,
} from '../src/features/studio/governance.js';

const accountId = '22'.repeat(19) + '23';
const custody = '11'.repeat(19) + '12';
const otherWallet = '99'.repeat(19) + '98';
const zero = '00'.repeat(20);
const recoveryAuthority = '33'.repeat(19) + '34';
const validatorA = '44'.repeat(19) + '45';
const validatorB = '55'.repeat(19) + '56';
const hook = '66'.repeat(19) + '67';
const newCustody = '77'.repeat(19) + '78';
const ZERO = '0'.repeat(40);
const DAY = 86_400_000;

const int = (value) => ({ type: 'Integer', value: String(value) });
const bool = (value) => ({ type: 'Boolean', value });
const bytes = (hex) => ({ type: 'ByteString', value: Buffer.from(hex, 'hex').toString('base64') });
// UInt160 arrives as the stored little-endian bytes of the display hash.
const h160 = (hex) => bytes(Buffer.from(hex, 'hex').reverse().toString('hex'));

const descriptor = ({ exists = true, status = 0, recoveryPending = false, matureAt = 0 } = {}) => ({
  type: 'Array',
  value: [
    bool(exists), int(status), h160(custody), h160(recoveryAuthority),
    int(3), int(7), int(60 * DAY), bool(true), bool(false), bool(false),
    int(2), int(9), bool(recoveryPending), int(matureAt), bool(false), bool(false),
  ],
});
const modulePage = (ids = [], nextCursor = 0) => ({
  type: 'Array',
  value: [{ type: 'Array', value: ids.map(int) }, int(nextCursor), int(7)],
});
const moduleDescriptor = (moduleId, moduleType, contractHash) => ({
  type: 'Array',
  value: [
    int(moduleId), int(moduleType), h160(contractHash), int(moduleId * 10), int(1),
    bytes('aa'.repeat(32)), bytes('bb'.repeat(32)), int(1), int(4),
    bool(moduleType === 1), bool(false), bool(true),
  ],
});
const hookOrderItem = (ids = []) => ({ type: 'Array', value: [{ type: 'Array', value: ids.map(int) }, int(2)] });
const pendingIntent = (intentId, matureAt) => ({
  type: 'Array',
  value: [
    bool(true), int(intentId), int(matureAt - DAY), int(matureAt), int(matureAt + 7 * DAY),
    int(3), bytes('cc'.repeat(32)), { type: 'Array', value: [] },
  ],
});
const recoveryItem = (initiatedAt, matureAt) => ({
  type: 'Array',
  value: [bool(true), int(initiatedAt), int(matureAt), int(2), h160(newCustody)],
});

function stubChain({ matureAt = 2_000_000_000_000, validatorPages = { 0: [['1', '2'], '5'], 5: [[], '0'] }, hookIds = ['3'], intentIds = [] } = {}) {
  const calls = [];
  const clock = { height: 10, hash: 'aa'.repeat(32), time: matureAt };
  const read = async (method, args) => {
    calls.push([method, args]);
    const response = (item) => ({ state: 'HALT', stack: [item] });
    if (method === 'getAccount') return response(descriptor());
    if (method === 'getModules') {
      const [type, cursor] = [args[1].value, args[2].value];
      if (type === 'validator') {
        const page = validatorPages[cursor] || [[], '0'];
        return response(modulePage(page[0], Number(page[1])));
      }
      return response(modulePage(cursor === '0' ? hookIds : [], 0));
    }
    if (method === 'getModule') {
      const id = Number(args[1].value);
      return response(moduleDescriptor(id, id === 3 ? 2 : 1, id === 1 ? validatorA : id === 2 ? validatorB : hook));
    }
    if (method === 'getHookOrder') return response(hookOrderItem(hookIds));
    if (method === 'getPendingConfigurationIntentIds') {
      return response({ type: 'Array', value: intentIds.map(int) });
    }
    if (method === 'getPendingConfiguration') return response(pendingIntent(Number(args[1].value), matureAt));
    if (method === 'getRecoveryStatus') return response({ type: 'Array', value: [] });
    throw new Error(`Unexpected read: ${method}`);
  };
  return { calls, clock, read, readClock: async () => ({ ...clock }) };
}

test('custody is the witness-bearing authority, so a zero or mismatched wallet is a named blocker', () => {
  assert.equal(custodyIssues(custody, custody), '');
  assert.equal(custodyIssues(`0x${custody.toUpperCase()}`, custody), '');
  assert.equal(custodyIssues(zero, custody), 'custody-invalid');
  assert.equal(custodyIssues('not-a-hash', custody), 'custody-invalid');
  assert.equal(custodyIssues(custody, ''), 'wallet-required');
  assert.equal(custodyIssues(custody, otherWallet), 'custody-mismatch');
  assert.equal(custodyIssues(custody, 'not-a-hash'), 'custody-mismatch');
});

test('the chain clock is the only clock, and a malformed header is refused', async () => {
  const header = { index: 9, hash: '0x' + 'ab'.repeat(32), time: 1_700_000_000 };
  assert.deepEqual(await readChainClock(async (method) => (method === 'getblockcount' ? 10 : header)), {
    height: 9, hash: '0x' + 'ab'.repeat(32), time: 1_700_000_000,
  });
  for (const broken of [
    async () => 0,
    async () => 'ten',
    async (method) => (method === 'getblockcount' ? 10 : { ...header, index: 8 }),
    async (method) => (method === 'getblockcount' ? 10 : { ...header, time: 0 }),
    async (method) => (method === 'getblockcount' ? 10 : { ...header, hash: 'zz' }),
    async (method) => (method === 'getblockcount' ? 10 : null),
  ]) {
    await assert.rejects(readChainClock(broken));
  }
});

test('one snapshot read decodes the control record, paged modules, hook order, intents and recovery', async () => {
  const chain = stubChain({ intentIds: ['2'] });
  const snapshot = await readAccountConfiguration({ accountId, read: chain.read, readClock: chain.readClock });

  assert.equal(snapshot.accountId, accountId);
  assert.equal(snapshot.account.exists, true);
  assert.equal(snapshot.account.status, 'active');
  assert.equal(snapshot.account.custody, custody);
  assert.equal(snapshot.account.recoveryAuthority, recoveryAuthority);
  assert.equal(snapshot.account.authorityEpoch, '3');
  assert.equal(snapshot.account.configurationNonce, '7');
  assert.equal(snapshot.account.recoveryTimelockMs, String(60 * DAY));
  assert.equal(snapshot.account.defaultOperationAuthorization, true);
  assert.equal(snapshot.account.defaultMessageAuthorization, false);
  assert.deepEqual(snapshot.account, { ...snapshot.account });

  assert.deepEqual(snapshot.modules.map((module) => [module.moduleId, module.moduleType, module.contractHash]), [
    ['1', 'validator', validatorA],
    ['2', 'validator', validatorB],
    ['3', 'hook', hook],
  ]);
  // The validator page is exhausted by nextCursor, and both module types are read.
  assert.deepEqual(snapshot.pages.map((page) => [page.moduleType, page.ids, page.nextCursor]), [
    ['validator', ['1', '2'], '5'],
    ['validator', [], '0'],
    ['hook', ['3'], '0'],
  ]);
  assert.deepEqual(snapshot.hookOrder, { hookIds: ['3'], revision: '2' });
  assert.deepEqual(snapshot.intentIds, ['2']);
  assert.equal(snapshot.pending.length, 1);
  assert.equal(snapshot.pending[0].intentId, '2');
  assert.equal(snapshot.pending[0].expiresAt, String(2_000_000_000_000 + 7 * DAY));
  assert.equal(snapshot.pending[0].authorityEpoch, '3');
  assert.equal(snapshot.recovery, null);
  assert.deepEqual(snapshot.chain, chain.clock);

  assert.deepEqual(chain.calls.map((call) => call[0]), [
    'getAccount',
    'getModules', 'getModule', 'getModule', 'getModules',
    'getModules', 'getModule',
    'getHookOrder', 'getPendingConfigurationIntentIds', 'getPendingConfiguration', 'getRecoveryStatus',
  ]);
  // The module page asks for the documented type string, cursor and limit.
  const firstPage = chain.calls[1][1];
  assert.deepEqual(firstPage.slice(1), [
    { type: 'String', value: 'validator' },
    { type: 'Integer', value: '0' },
    { type: 'Integer', value: '32' },
  ]);
  assert.deepEqual(chain.calls[2][1][1], { type: 'Integer', value: '1' });
});

test('a pending recovery is decoded with its new custody, and an unknown intent id adds no card', async () => {
  const chain = stubChain({ intentIds: [] });
  const read = async (method, args) => {
    if (method === 'getRecoveryStatus') return { state: 'HALT', stack: [recoveryItem(1_900_000_000_000, 1_900_000_600_000)] };
    if (method === 'getPendingConfiguration') return { state: 'HALT', stack: [{ type: 'Array', value: [] }] };
    return chain.read(method, args);
  };
  const snapshot = await readAccountConfiguration({ accountId, read, readClock: chain.readClock });
  assert.deepEqual(snapshot.recovery, {
    initiatedAt: '1900000000000',
    matureAt: '1900000600000',
    authorityEpochAtInit: '2',
    newCustody,
  });
  assert.deepEqual(snapshot.pending, []);

  const withIds = stubChain({ intentIds: ['4'] });
  const stale = await readAccountConfiguration({
    accountId,
    read: async (method, args) => (method === 'getPendingConfiguration'
      ? { state: 'HALT', stack: [{ type: 'Array', value: [] }] }
      : withIds.read(method, args)),
    readClock: withIds.readClock,
  });
  // An id the core no longer reports a pending record for is dropped, not guessed.
  assert.deepEqual(stale.pending, []);
  assert.deepEqual(stale.intentIds, ['4']);
});

test('a snapshot never mixes two blocks and refuses an invalid custody state', async () => {
  const chain = stubChain();
  let calls = 0;
  await assert.rejects(
    readAccountConfiguration({
      accountId,
      read: chain.read,
      readClock: async () => ({ ...chain.clock, height: calls++, hash: String(calls).padStart(64, '0') }),
    }),
    /block changed/,
  );
  const zeroCustody = stubChain();
  await assert.rejects(
    readAccountConfiguration({
      accountId,
      read: async (method, args) => (method === 'getAccount'
        ? { state: 'HALT', stack: [{ type: 'Array', value: [...descriptor().value.slice(0, 2), h160(zero), ...descriptor().value.slice(3)] }] }
        : zeroCustody.read(method, args)),
      readClock: zeroCustody.readClock,
    }),
    /Invalid account custody/,
  );
  await assert.rejects(
    readAccountConfiguration({
      accountId,
      read: async () => ({ state: 'FAULT', exception: 'method missing', stack: [] }),
      readClock: chain.readClock,
    }),
    /Cannot read getAccount/,
  );
});

test('configuration blockers name the first reason a proposal cannot be made', () => {
  const base = {
    account: { exists: true, status: 'active', marketEscrowActive: false },
    pending: [],
  };
  assert.equal(configurationBlockers(base, [{}]), '');
  assert.equal(configurationBlockers({ ...base, account: { ...base.account, exists: false } }, [{}]), 'account-missing');
  assert.equal(configurationBlockers({ ...base, account: { ...base.account, status: 'frozen' } }, [{}]), 'account-frozen');
  assert.equal(configurationBlockers({ ...base, account: { ...base.account, status: 'migrationRequired' } }, [{}]), 'migration-required');
  assert.equal(configurationBlockers({ ...base, account: { ...base.account, marketEscrowActive: true } }, [{}]), 'market-escrow');
  assert.equal(configurationBlockers(base, []), 'no-actions');
  // v4 allows one live intent per account, so a pending one blocks a second.
  assert.equal(configurationBlockers({ ...base, pending: [{ intentId: '1' }] }, [{}]), 'pending-intent');
  assert.equal(configurationBlockers(null, [{}]), 'account-missing');
});

test('custody action blockers read escrow, owner-only mode and recovery maturity from chain state', () => {
  const snapshot = (overrides = {}) => {
    const { account = {}, recovery = null, ...rest } = overrides;
    return {
      account: { exists: true, marketEscrowActive: false, ownerOnlyRecovery: false, ...account },
      recovery,
      chain: { time: 1_000 },
      ...rest,
    };
  };
  assert.equal(custodyActionBlockers(snapshot(), 'freezeAccount'), '');
  assert.equal(custodyActionBlockers(snapshot({ account: { marketEscrowActive: true } }), 'freezeAccount'), 'market-escrow');
  // Cancelling a recovery is the one action still reachable under escrow.
  assert.equal(custodyActionBlockers(
    snapshot({ account: { marketEscrowActive: true }, recovery: { matureAt: '0' } }),
    'cancelRecovery',
  ), '');
  assert.equal(custodyActionBlockers(snapshot({ account: { ownerOnlyRecovery: true } }), 'beginRecovery'), 'owner-only-recovery');
  assert.equal(custodyActionBlockers(snapshot({ recovery: { matureAt: '0' } }), 'beginRecovery'), 'recovery-active');
  assert.equal(custodyActionBlockers(snapshot(), 'executeRecovery'), 'recovery-missing');
  assert.equal(custodyActionBlockers(snapshot({ recovery: { matureAt: '2000' } }), 'executeRecovery'), 'recovery-immature');
  assert.equal(custodyActionBlockers(snapshot({ recovery: { matureAt: '2000' }, chain: { time: 2_000 } }), 'executeRecovery'), '');
  assert.equal(custodyActionBlockers(snapshot(), 'cancelRecovery'), 'recovery-missing');
  assert.equal(custodyActionBlockers({ account: { exists: false } }, 'freezeAccount'), 'account-missing');
});

test('the review record copies the actions and omits the clock it must not be bound to', () => {
  const actions = [{ type: 'Array', value: [int(1)] }];
  const chain = stubChain();
  const snapshot = {
    accountId,
    account: { exists: true, status: 'active', marketEscrowActive: false },
    pending: [],
    chain: chain.clock,
    loadedAt: 123,
  };
  const review = captureConfigurationReview(snapshot, actions);
  assert.equal(review.accountId, accountId);
  assert.deepEqual(review.actions, actions);
  assert.notEqual(review.actions, actions, 'the review must own its copy of the actions');
  assert.equal('chain' in review.snapshot, false);
  assert.equal('loadedAt' in review.snapshot, false);
  actions[0].value[0].value = '9';
  assert.equal(review.actions[0].value[0].value, '1');

  assert.throws(
    () => captureConfigurationReview({ ...snapshot, pending: [{ intentId: '1' }] }, actions),
    /pending-intent/,
  );
});

test('a review stops matching on a new wallet, account, configuration or action list', () => {
  const chain = stubChain();
  const snapshot = {
    accountId,
    account: { exists: true, status: 'active', marketEscrowActive: false, custody },
    pending: [],
    chain: chain.clock,
    modules: [],
    hookOrder: { hookIds: [], revision: '0' },
    recovery: null,
    intentIds: [],
    pages: [],
  };
  const actions = [{ type: 'Array', value: [int(4), { type: 'Array', value: [] }] }];
  const review = captureConfigurationReview(snapshot, actions);

  assert.doesNotThrow(() => assertConfigurationReviewCurrent(review, snapshot, custody));
  // The clock and the load timestamp are not part of what a review is bound to.
  assert.doesNotThrow(() => assertConfigurationReviewCurrent(
    review,
    { ...snapshot, chain: { ...snapshot.chain, time: snapshot.chain.time + 5_000 }, loadedAt: 999 },
    custody,
  ));
  assert.throws(() => assertConfigurationReviewCurrent(review, snapshot, otherWallet), /custody wallet/);
  assert.throws(() => assertConfigurationReviewCurrent(review, { ...snapshot, accountId: zero }, custody), /Account changed/);
  assert.throws(
    () => assertConfigurationReviewCurrent(review, { ...snapshot, hookOrder: { hookIds: ['3'], revision: '1' } }, custody),
    /configuration changed/,
  );
  assert.throws(
    () => assertConfigurationReviewCurrent(review, snapshot, custody, [{ type: 'Array', value: [int(5)] }]),
    /request changed/,
  );
});

test('intent status is decided at the sampled chain clock, not the device clock', () => {
  const intent = { matureAt: 1_000, expiresAt: 10_000 };
  assert.equal(intentStatus(null, 0), 'missing');
  assert.equal(intentStatus(intent, 999), 'maturing');
  assert.equal(intentStatus(intent, 1_000), 'mature');
  assert.equal(intentStatus(intent, 10_000), 'expired');
  // A record without an expiry window is still bounded by its maturity.
  assert.equal(intentStatus({ matureAt: 1_000, expiresAt: 0 }, 999), 'maturing');
  assert.equal(intentStatus({ matureAt: 1_000, expiresAt: 0 }, 1_001), 'mature');
  assert.equal(intentStatus({ matureAt: 1_000 }, 5_000), 'mature');
  assert.equal(ZERO, '0'.repeat(40));
});
