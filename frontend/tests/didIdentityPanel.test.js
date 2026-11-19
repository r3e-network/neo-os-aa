import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';

const core = '11'.repeat(20);
const accountA = '22'.repeat(20);
const accountB = '33'.repeat(20);
const serviceA = '44'.repeat(20);
const serviceB = '55'.repeat(20);
const pending = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { await nextTick(); await new Promise((resolve) => setImmediate(resolve)); await nextTick(); };

// v4 reads one on-chain snapshot per account: the control record, the installed
// module set, the pending configuration intents and the recovery service those
// validators delegate to. Recovery and private-session views share it.
const recoverySnapshot = (overrides = {}) => ({
  recoveryServiceHash: `0x${serviceA}`,
  network: 'neo3-testnet',
  saContract: core,
  accountIdText: 'shared-account-text',
  accountAddress: '66'.repeat(20),
  recoveryNonce: '0',
  sessionNonce: '0',
  actionProtocolVersion: '4',
  actionAuthorizationEpoch: '2',
  control: { exists: true, status: 'Active', custody: accountA },
  validatorIds: ['1'],
  hookIds: [],
  hookOrder: { hookIds: [], revision: '0' },
  pendingConfiguration: { intentIds: [], intents: [] },
  ...overrides,
});

// Execute the component's actual setup and Vue watchers. DOM layout is outside
// these tests; identity changes and out-of-order RPC responses are the boundary.
function createPanel({
  identityReader,
  stateReader = async () => ({}),
  didService = {},
  connected = false,
  recoveryNewOwnerPrefill = '',
  reactiveRuntime = true,
}) {
  const props = reactive({ saContractHash: core, accountIdPrefill: accountA, accountAddressScriptHash: '', neoWalletAddress: '', recoveryNewOwnerPrefill, recoveryExpiryPrefill: '', autoPreviewRecovery: false });
  const runtime = { rpcUrl: 'http://127.0.0.1:10332' };
  const runtimeConfig = reactiveRuntime ? reactive(runtime) : runtime;
  const errors = [];
  const scope = effectScope();
  const bindings = {
    computed, ref, watch, defineProps: () => props, defineEmits: () => () => {},
    useI18n: () => ({
      t: (key, fallback, params) => String(fallback || key).replace(/\{(\w+)\}/g, (match, name) => (
        params && params[name] !== undefined ? String(params[name]) : match
      )),
    }),
    useToast: () => ({ error: (message) => errors.push(message), success: () => {} }),
    useClipboard: () => ({ copiedKey: ref(''), markCopied: () => {}, copyText: async () => true }),
    useDidConnection: () => ({ isConfigured: ref(connected), isConnected: ref(connected), didProfile: ref(null), connectDid: async () => {}, disconnectDid: () => {} }),
    morpheusDidService: didService, notificationService: {},
    fetchAccountIdentity: identityReader,
    fetchAccountRecoveryState: stateReader,
    getSmartAccountHash: () => core,
    getScriptHashFromAddress: () => { throw new Error('not an address'); },
    sanitizeHex: (value) => String(value || '').replace(/^0x/i, '').toLowerCase(),
    RUNTIME_CONFIG: runtimeConfig,
    Date: class extends Date { static now() { return 1799999100000; } },
    translateError: (message) => message,
  };
  const sfc = fs.readFileSync(new URL('../src/features/operations/components/DidIdentityPanel.vue', import.meta.url), 'utf8');
  const source = sfc.match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import\s+[\s\S]*?\s+from\s+["'][^"']+["'];\s*$/gm, '')
    .replaceAll('import.meta.env.DEV', 'false');
  const setup = new Function(...Object.keys(bindings), `${source}
return { resolvedAccountId, recoveryState, recoveryStateContext, recoveryServiceHash, proxyServiceHash, configIntentItems, canPreviewRecovery, canPreviewProxy, canInvokeRecovery, canInvokeProxy, previewRecoveryAction, previewProxyAction, refreshRecoveryStateAction, actionMasterNullifier, proxyExecutor, recoveryNewOwner, manageActionIdentity, reauthorizeActionSession };`);
  return { props, runtimeConfig, errors, state: scope.run(() => setup(...Object.values(bindings))), stop: () => scope.stop() };
}

test('identity panel accepts only the newest account context after out-of-order reads', async () => {
  const a = pending();
  const b = pending();
  const calls = [];
  const panel = createPanel({
    identityReader: ({ accountIdHex }) => { calls.push(accountIdHex); return accountIdHex === accountA ? a.promise : b.promise; },
    stateReader: async ({ accountIdHex }) => recoverySnapshot({ accountIdHex, recoveryServiceHash: accountIdHex === accountA ? `0x${serviceA}` : `0x${serviceB}` }),
  });
  try {
    panel.props.accountIdPrefill = accountB;
    await flush();
    b.resolve({ accountIdHex: accountB });
    await flush();
    a.resolve({ accountIdHex: accountA });
    await flush();
    assert.equal(panel.state.resolvedAccountId.value, accountB);
    assert.equal(panel.state.recoveryServiceHash.value, serviceB);
    assert.equal(panel.state.proxyServiceHash.value, serviceB);
    assert.deepEqual(calls, [accountA, accountB]);
  } finally { panel.stop(); }
});

test('switching core clears identity and recovery state even if an old read succeeds', async () => {
  const stateRead = pending();
  const panel = createPanel({
    identityReader: async ({ saContractHash }) => {
      if (saContractHash !== core) throw new Error('unknown account on this core');
      return { accountIdHex: accountA };
    },
    stateReader: () => stateRead.promise,
  });
  try {
    await flush();
    panel.props.saContractHash = '99'.repeat(20);
    await flush();
    stateRead.resolve(recoverySnapshot());
    await flush();
    assert.equal(panel.state.resolvedAccountId.value, '');
    assert.equal(panel.state.recoveryServiceHash.value, '');
    assert.equal(panel.state.proxyServiceHash.value, '');
    assert.equal(panel.state.recoveryState.value, null);
    assert.deepEqual(panel.state.configIntentItems.value, []);
    assert.equal(panel.errors.at(-1), 'unknown account on this core');
  } finally { panel.stop(); }
});

test('manual refresh cannot restore state after account context is removed', async () => {
  const manualRead = pending();
  let stateCalls = 0;
  const panel = createPanel({
    identityReader: async () => ({ accountIdHex: accountA }),
    stateReader: async () => ++stateCalls === 1 ? recoverySnapshot() : manualRead.promise,
  });
  try {
    await flush();
    const refresh = panel.state.refreshRecoveryStateAction();
    await flush();
    panel.props.accountIdPrefill = '';
    await flush();
    manualRead.resolve(recoverySnapshot({ sessionNonce: '7' }));
    await refresh;
    await flush();
    assert.equal(panel.state.resolvedAccountId.value, '');
    assert.equal(panel.state.recoveryState.value, null);
  } finally { panel.stop(); }
});

test('recovery and action previews require text, network, core, service hash, and account address', async () => {
  const recoveryCalls = [];
  const actionCalls = [];
  const panel = createPanel({
    connected: true,
    recoveryNewOwnerPrefill: '77'.repeat(20),
    identityReader: async () => ({ accountIdHex: accountA }),
    stateReader: async () => recoverySnapshot(),
    didService: {
      previewRecoveryTicket: async (input) => { recoveryCalls.push(input); return { ok: true }; },
      previewActionTicket: async (input) => { actionCalls.push(input); return { ok: true }; },
    },
  });
  try {
    await flush();
    panel.state.proxyExecutor.value = '88'.repeat(20);
    await flush();
    assert.equal(panel.state.canPreviewRecovery.value, true);
    assert.equal(panel.state.canPreviewProxy.value, true);

    await panel.state.previewRecoveryAction();
    await panel.state.previewProxyAction();
    assert.equal(recoveryCalls.length, 1);
    assert.equal(actionCalls.length, 1);
    assert.equal(recoveryCalls[0].verifierContract, serviceA);
    assert.equal(recoveryCalls[0].network, 'neo3-testnet');
    assert.equal(recoveryCalls[0].accountIdText, 'shared-account-text');
    assert.equal(recoveryCalls[0].accountIdRaw, accountA);
    assert.equal(recoveryCalls[0].accountAddress, '66'.repeat(20));
    assert.equal(actionCalls[0].verifierContract, serviceA);
    assert.equal(actionCalls[0].accountIdText, 'shared-account-text');
    assert.equal(actionCalls[0].accountIdRaw, accountA);

    for (const [field, value] of [
      ['network', ''],
      ['accountIdText', ''],
      ['saContract', '00'.repeat(20)],
      ['accountAddress', undefined],
      ['accountAddress', '00'.repeat(20)],
      ['recoveryServiceHash', ''],
      ['recoveryServiceHash', '00'.repeat(20)],
    ]) {
      panel.state.recoveryState.value = recoverySnapshot({ [field]: value });
      await flush();
      assert.equal(panel.state.canPreviewRecovery.value, false, `${field} must disable recovery preview`);
      assert.equal(panel.state.canPreviewProxy.value, false, `${field} must disable action preview`);
    }
    assert.equal(recoveryCalls.length, 1);
    assert.equal(actionCalls.length, 1);
  } finally { panel.stop(); }
});

test('pending configuration intents surface maturity, expiry, and the action digest', async () => {
  const panel = createPanel({
    identityReader: async () => ({ accountIdHex: accountA }),
    stateReader: async () => recoverySnapshot({
      pendingConfiguration: {
        intentIds: ['4'],
        intents: [{
          intentId: '4', proposedAt: '1799900000000', matureAt: '1799990000000',
          expiresAt: '1800606000000', actionDigest: `0x${'ab'.repeat(32)}`, actions: [], actionCount: 2,
        }],
      },
    }),
  });
  try {
    await flush();
    const [intent] = panel.state.configIntentItems.value;
    assert.equal(intent.id, 'config-intent-4');
    assert.match(intent.title, /Configuration Intent #4/);
    assert.match(intent.description, /2 action/);
    assert.match(intent.matureAt, /1799990000000/);
    assert.match(intent.expiresAt, /1800606000000/);
    assert.equal(intent.actionDigest, `0x${'ab'.repeat(32)}`);
  } finally { panel.stop(); }
});

test('an older read for the same context cannot overwrite a newer refresh', async () => {
  const stale = pending();
  const fresh = pending();
  const calls = [];
  let reads = 0;
  const panel = createPanel({
    connected: true,
    identityReader: async () => ({ accountIdHex: accountA }),
    stateReader: async () => {
      reads += 1;
      if (reads === 1) return recoverySnapshot({ sessionNonce: '1' });
      return reads === 2 ? stale.promise : fresh.promise;
    },
    didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    const older = panel.state.refreshRecoveryStateAction(); await flush();
    const newer = panel.state.refreshRecoveryStateAction(); await flush();
    fresh.resolve(recoverySnapshot({ sessionNonce: '8' })); await newer; await flush();
    stale.resolve(recoverySnapshot({ sessionNonce: '7' })); await older; await flush();
    assert.equal(panel.state.canPreviewProxy.value, true);
    await panel.state.previewProxyAction();
    assert.equal(calls[0].sessionNonce, '8');
  } finally { stale.resolve(null); fresh.resolve(null); panel.stop(); }
});

for (const key of ['rpc', 'core', 'account']) {
  test(`a context change on ${key} invalidates and rejects stale reads`, async () => {
    const old = pending(), fresh = pending(), calls = [], reads = [];
    let holdOld = false, holdFresh = false;
    const panel = createPanel({
      connected: true,
      identityReader: async ({ accountIdHex }) => ({ accountIdHex }),
      stateReader: async options => {
        reads.push(options);
        if (holdFresh) return fresh.promise;
        if (holdOld) return old.promise;
        return recoverySnapshot();
      },
      didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
    });
    try {
      await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
      holdOld = true;
      const refresh = panel.state.refreshRecoveryStateAction(); await flush();
      holdFresh = true;
      if (key === 'rpc') panel.runtimeConfig.rpcUrl = 'http://127.0.0.1:20332';
      if (key === 'core') panel.props.saContractHash = '99'.repeat(20);
      if (key === 'account') panel.props.accountIdPrefill = accountB;
      assert.equal(panel.state.canPreviewProxy.value, false, 'context changes must reject old admission immediately');
      await flush();
      const nextCore = key === 'core' ? '99'.repeat(20) : core;
      fresh.resolve(recoverySnapshot({ saContract: nextCore, sessionNonce: '11' })); await flush();
      old.resolve(recoverySnapshot({ sessionNonce: '7' })); await refresh; await flush();
      assert.equal(panel.state.canPreviewProxy.value, true);
      await panel.state.previewProxyAction();
      assert.equal(calls[0].sessionNonce, '11');
      assert.equal(calls[0].saContract, nextCore);
      assert.equal(calls[0].accountIdRaw, key === 'account' ? accountB : accountA);
      assert.equal(reads.at(-1).rpcUrl, panel.runtimeConfig.rpcUrl);
      assert.equal(reads.at(-1).accountIdHex, key === 'account' ? accountB : accountA);
    } finally { old.resolve(null); fresh.resolve(null); panel.stop(); }
  });
}

test('direct preview rechecks plain runtime RPC provenance before service use', async () => {
  const calls = [], reads = [];
  const panel = createPanel({
    connected: true, reactiveRuntime: false,
    identityReader: async () => ({ accountIdHex: accountA }),
    stateReader: async options => { reads.push(options); return recoverySnapshot(); },
    didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    assert.equal(panel.state.canPreviewProxy.value, true);
    panel.runtimeConfig.rpcUrl = 'http://127.0.0.1:20332';
    await panel.state.previewProxyAction();
    assert.equal(calls.length, 0, 'a cached computed admission cannot authorize a different RPC context');
    await panel.state.refreshRecoveryStateAction();
    assert.equal(reads.at(-1).rpcUrl, panel.runtimeConfig.rpcUrl);
    await panel.state.previewProxyAction();
    assert.equal(calls.length, 1);
  } finally { panel.stop(); }
});

test('action enrollment and legacy reauthorization require explicit user handlers and fresh provenance', async () => {
  const calls = [];
  const panel = createPanel({
    connected: true,
    identityReader: async () => ({ accountIdHex: accountA }),
    stateReader: async () => recoverySnapshot({
      activeSession: { active: true, executor: '88'.repeat(20), actionId: 'sa_proxy:fixture', expiresAt: '1800000000000', actionNullifier: '99'.repeat(32) },
    }),
    didService: {
      setActionIdentity: async p => { calls.push(['enroll', p]); return {}; },
      reauthorizeActiveActionSession: async p => { calls.push(['reauthorize', p]); return {}; },
    },
  });
  try {
    await flush(); assert.equal(calls.length, 0);
    panel.state.actionMasterNullifier.value = 'aa'.repeat(32);
    await panel.state.manageActionIdentity(true);
    assert.equal(calls[0][1].accountIdHex, accountA); assert.equal(calls[0][1].enabled, true);
    assert.equal(calls[0][1].verifierHash, serviceA);
    await panel.state.reauthorizeActionSession();
    assert.equal(calls[1][1].session.executor, '88'.repeat(20));
    panel.props.saContractHash = 'ff'.repeat(20);
    await panel.state.manageActionIdentity(true);
    assert.equal(calls.length, 2, 'plain stale context cannot submit an enrollment');
  } finally { panel.stop(); }
});
