import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';

const core = '11'.repeat(20);
const accountA = '22'.repeat(20);
const accountB = '33'.repeat(20);
const verifierA = '44'.repeat(20);
const verifierB = '55'.repeat(20);
const pending = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { await nextTick(); await new Promise((resolve) => setImmediate(resolve)); await nextTick(); };

// Execute the component's actual setup and Vue watchers. DOM layout is outside
// these tests; identity changes and out-of-order RPC responses are the boundary.
function createPanel({
  identityReader,
  maintenanceReader = async () => ({}),
  stateReader = async () => ({}),
  didService = {},
  connected = false,
  recoveryNewOwnerPrefill = '',
  recoveryVerifierPrefill = '',
  reactiveRuntime = true,
}) {
  const props = reactive({ aaContractHash: core, accountIdPrefill: accountA, accountAddressScriptHash: '', neoWalletAddress: '', recoveryVerifierPrefill, recoveryNewOwnerPrefill, recoveryExpiryPrefill: '', autoPreviewRecovery: false });
  const runtime = { rpcUrl: 'http://127.0.0.1:10332' };
  const runtimeConfig = reactiveRuntime ? reactive(runtime) : runtime;
  const errors = [];
  const scope = effectScope();
  const bindings = {
    computed, ref, watch, defineProps: () => props, defineEmits: () => () => {},
    useI18n: () => ({ t: (key, fallback) => fallback || key }),
    useToast: () => ({ error: (message) => errors.push(message), success: () => {} }),
    useClipboard: () => ({ copiedKey: ref(''), markCopied: () => {}, copyText: async () => true }),
    useDidConnection: () => ({ isConfigured: ref(connected), isConnected: ref(connected), didProfile: ref(null), connectDid: async () => {}, disconnectDid: () => {} }),
    morpheusDidService: didService, notificationService: {},
    fetchAccountIdentity: identityReader,
    fetchAccountMaintenanceState: maintenanceReader,
    fetchUnifiedVerifierState: stateReader,
    getAbstractAccountHash: () => core,
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
  const setup = new Function(...Object.keys(bindings), `${source}\nreturn { resolvedAccountId, recoveryVerifierHash, recoveryNewOwner, proxyVerifierHash, proxyExecutor, verifierState, proxyVerifierState: typeof proxyVerifierState === 'undefined' ? verifierState : proxyVerifierState, maintenanceState, canPreviewRecovery, canPreviewProxy, canInvokeRecovery, canInvokeProxy, previewRecoveryAction, previewProxyAction, refreshVerifierStateAction, actionMasterNullifier, manageActionIdentity, reauthorizeActionSession };`);
  return { props, runtimeConfig, errors, state: scope.run(() => setup(...Object.values(bindings))), stop: () => scope.stop() };
}

test('identity panel accepts only the newest account context after out-of-order reads', async () => {
  const a = pending();
  const b = pending();
  const calls = [];
  const panel = createPanel({ identityReader: (options) => { calls.push(options); return options.accountIdHex === accountA ? a.promise : b.promise; } });
  try {
    panel.props.accountIdPrefill = accountB;
    await flush();
    b.resolve({ accountIdHex: accountB, verifierHash: verifierB });
    await flush();
    a.resolve({ accountIdHex: accountA, verifierHash: verifierA });
    await flush();
    assert.equal(panel.state.resolvedAccountId.value, accountB);
    assert.equal(panel.state.recoveryVerifierHash.value, verifierB);
    assert.equal(panel.state.proxyVerifierHash.value, verifierB);
    assert.deepEqual(calls.map((call) => call.accountIdHex), [accountA, accountB]);
  } finally { panel.stop(); }
});

test('switching core clears identity and stale verifier state even if an old read succeeds', async () => {
  const stateRead = pending();
  const panel = createPanel({
    identityReader: async ({ aaContractHash }) => {
      if (aaContractHash !== core) throw new Error('unknown account on this core');
      return { accountIdHex: accountA, verifierHash: verifierA };
    },
    stateReader: () => stateRead.promise,
  });
  try {
    await flush();
    panel.props.aaContractHash = '99'.repeat(20);
    await flush();
    stateRead.resolve({ owner: 'old owner' });
    await flush();
    assert.equal(panel.state.resolvedAccountId.value, '');
    assert.equal(panel.state.recoveryVerifierHash.value, '');
    assert.equal(panel.state.proxyVerifierHash.value, '');
    assert.equal(panel.state.verifierState.value, null);
    assert.equal(panel.state.maintenanceState.value, null);
    assert.equal(panel.errors.at(-1), 'unknown account on this core');
  } finally { panel.stop(); }
});

test('manual refresh cannot restore state after account context is removed', async () => {
  const manualRead = pending();
  let stateCalls = 0;
  const panel = createPanel({
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierA }),
    stateReader: async () => ++stateCalls === 1 ? { owner: 'current owner' } : manualRead.promise,
  });
  try {
    await flush();
    const refresh = panel.state.refreshVerifierStateAction();
    await flush();
    panel.props.accountIdPrefill = '';
    await flush();
    manualRead.resolve({ owner: 'old owner' });
    await refresh;
    await flush();
    assert.equal(panel.state.resolvedAccountId.value, '');
    assert.equal(panel.state.verifierState.value, null);
    assert.equal(panel.state.maintenanceState.value, null);
  } finally { panel.stop(); }
});

test('recovery and action previews require valid text, network, core, and non-zero account address', async () => {
  const recoveryCalls = [];
  const actionCalls = [];
  const accountAddress = '66'.repeat(20);
  const newOwner = '77'.repeat(20);
  const validState = {
    verifierHash: `0x${verifierA}`,
    network: 'neo3-testnet',
    aaContract: core,
    accountIdText: 'shared-account-text',
    accountAddress,
    recoveryNonce: '0',
    sessionNonce: '0',
    actionProtocolVersion: '4', actionAuthorizationEpoch: '2',
  };
  const panel = createPanel({
    connected: true,
    recoveryNewOwnerPrefill: newOwner,
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierA }),
    stateReader: async () => validState,
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
    assert.equal(recoveryCalls[0].network, 'neo3-testnet');
    assert.equal(recoveryCalls[0].accountIdText, 'shared-account-text');
    assert.equal(recoveryCalls[0].accountIdRaw, accountA);
    assert.equal(recoveryCalls[0].accountAddress, accountAddress);
    assert.equal(actionCalls[0].network, 'neo3-testnet');
    assert.equal(actionCalls[0].accountIdText, 'shared-account-text');
    assert.equal(actionCalls[0].accountIdRaw, accountA);

    for (const [field, value] of [
      ['network', ''],
      ['accountIdText', ''],
      ['aaContract', '00'.repeat(20)],
      ['accountAddress', undefined],
      ['accountAddress', '00'.repeat(20)],
    ]) {
      panel.state.verifierState.value = { ...validState, [field]: value };
      panel.state.proxyVerifierState.value = { ...validState, [field]: value };
      await flush();
      assert.equal(panel.state.canPreviewRecovery.value, false, `${field} must disable recovery preview`);
      assert.equal(panel.state.canPreviewProxy.value, false, `${field} must disable action preview`);
      assert.ok(panel.state.canInvokeRecovery.value, 'preview context must not change the invoke-only guard');
      assert.ok(panel.state.canInvokeProxy.value, 'preview context must not change the invoke-only guard');
    }
    assert.equal(recoveryCalls.length, 1);
    assert.equal(actionCalls.length, 1);
  } finally { panel.stop(); }
});

const configuredState = (verifier, sessionNonce = '0', extra = {}) => ({
  verifierHash: `0x${verifier}`,
  network: 'neo3-testnet', aaContract: core, accountIdText: `account-${verifier.slice(0, 2)}`,
  accountAddress: '66'.repeat(20), recoveryNonce: '0', sessionNonce, actionProtocolVersion: '4', actionAuthorizationEpoch: '2', ...extra,
});

test('proxy preview uses B context and nonce independently of recovery verifier A', async () => {
  const recoveryCalls = [], actionCalls = [], reads = [];
  const panel = createPanel({
    connected: true, recoveryVerifierPrefill: verifierA, recoveryNewOwnerPrefill: '77'.repeat(20),
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierB }),
    stateReader: async options => {
      reads.push(options);
      return configuredState(options.verifierHash, options.verifierHash === verifierB ? '7' : '0');
    },
    didService: {
      previewRecoveryTicket: async input => { recoveryCalls.push(input); return {}; },
      previewActionTicket: async input => { actionCalls.push(input); return {}; },
    },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    assert.equal(panel.state.canPreviewRecovery.value, true);
    assert.equal(panel.state.canPreviewProxy.value, true);
    await panel.state.previewRecoveryAction(); await panel.state.previewProxyAction();
    assert.equal(actionCalls[0].verifierContract, verifierB);
    assert.equal(actionCalls[0].sessionNonce, '7');
    assert.equal(actionCalls[0].expiresAt, 1800000000000);
    assert.equal(actionCalls[0].network, 'neo3-testnet');
    assert.equal(actionCalls[0].aaContract, core);
    assert.equal(actionCalls[0].accountIdRaw, accountA);
    assert.equal(actionCalls[0].executor, '88'.repeat(20));
    assert.ok(reads.some(read => read.verifierHash === verifierB), 'B must be read');
    assert.equal(actionCalls[0].accountIdText, 'account-55');
    assert.equal(recoveryCalls[0].verifierContract, verifierA);
    assert.equal(recoveryCalls[0].accountIdText, 'account-44');
    assert.equal(panel.state.verifierState.value.sessionNonce, '0');
  } finally { panel.stop(); }
});

test('changing only proxy verifier invalidates immediately and refetches without clearing recovery', async () => {
  const next = pending(), actionCalls = [], reads = [];
  const panel = createPanel({
    connected: true, recoveryNewOwnerPrefill: '77'.repeat(20),
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierA }),
    stateReader: async options => {
      reads.push(options);
      return options.verifierHash === verifierB ? next.promise : configuredState(verifierA);
    },
    didService: { previewActionTicket: async input => { actionCalls.push(input); return {}; } },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    assert.equal(panel.state.canPreviewProxy.value, true);
    panel.state.proxyVerifierHash.value = verifierB;
    assert.equal(panel.state.canPreviewProxy.value, false, 'old state cannot be admitted before watcher flush');
    await panel.state.previewProxyAction(); assert.equal(actionCalls.length, 0);
    await flush();
    assert.equal(panel.state.canPreviewRecovery.value, true);
    assert.equal(panel.state.verifierState.value.verifierHash, `0x${verifierA}`);
    assert.equal(reads.at(-1).verifierHash, verifierB);
    next.resolve(configuredState(verifierB, '7')); await flush();
    assert.equal(panel.state.canPreviewProxy.value, true);
    await panel.state.previewProxyAction();
    assert.equal(actionCalls[0].sessionNonce, '7');
  } finally { panel.stop(); }
});

test('valid proxy B remains available when recovery A has no stored context', async () => {
  const calls = [];
  const panel = createPanel({
    connected: true, recoveryVerifierPrefill: verifierA, recoveryNewOwnerPrefill: '77'.repeat(20),
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierB }),
    stateReader: async ({ verifierHash }) => verifierHash === verifierB ? configuredState(verifierB, '7') : null,
    didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    assert.equal(panel.state.canPreviewRecovery.value, false);
    assert.equal(panel.state.canPreviewProxy.value, true);
    await panel.state.previewProxyAction();
    assert.equal(calls[0].sessionNonce, '7');
    assert.equal(calls[0].verifierContract, verifierB);
  } finally { panel.stop(); }
});

for (const [label, invalid] of [
  ['wrong returned verifier', { verifierHash: `0x${verifierA}` }],
  ['missing returned verifier', { verifierHash: undefined }],
  ['wrong stored AA core', { aaContract: '99'.repeat(20) }],
  ['malformed returned verifier', { verifierHash: 'Not an address' }],
  ['malformed stored AA core', { aaContract: 'Not an address' }],
]) {
  test(`proxy admission and direct preview reject ${label}`, async () => {
    const calls = [];
    const panel = createPanel({
      connected: true, recoveryVerifierPrefill: verifierA, recoveryNewOwnerPrefill: '77'.repeat(20),
      identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierB }),
      stateReader: async ({ verifierHash }) => configuredState(verifierHash, '7', verifierHash === verifierB ? invalid : {}),
      didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
    });
    try {
      await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
      assert.equal(panel.state.canPreviewRecovery.value, true);
      assert.equal(panel.state.proxyVerifierState.value, null, 'mismatched context must not be stored');
      assert.equal(panel.state.canPreviewProxy.value, false);
      await panel.state.previewProxyAction();
      assert.equal(calls.length, 0, 'direct calls must enforce provenance too');
    } finally { panel.stop(); }
  });
}

test('late proxy response cannot replace a newer target context', async () => {
  const b = pending(), c = pending(), verifierC = 'aa'.repeat(20), calls = [];
  const panel = createPanel({
    connected: true,
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierA }),
    stateReader: async ({ verifierHash }) => verifierHash === verifierB ? b.promise : verifierHash === verifierC ? c.promise : configuredState(verifierA),
    didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    panel.state.proxyVerifierHash.value = verifierB; await flush();
    panel.state.proxyVerifierHash.value = verifierC; await flush();
    c.resolve(configuredState(verifierC, '9')); await flush();
    b.resolve(configuredState(verifierB, '7')); await flush();
    assert.equal(panel.state.canPreviewProxy.value, true);
    await panel.state.previewProxyAction();
    assert.equal(calls[0].verifierContract, verifierC);
    assert.equal(calls[0].sessionNonce, '9');
    assert.equal(panel.state.verifierState.value.verifierHash, `0x${verifierA}`);
  } finally { panel.stop(); }
});

test('an older read for the same proxy target cannot overwrite a newer refresh', async () => {
  const old = pending(), fresh = pending(), calls = [];
  let bReads = 0;
  const panel = createPanel({
    connected: true,
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierA }),
    stateReader: async ({ verifierHash }) => verifierHash === verifierB ? (++bReads === 1 ? old.promise : fresh.promise) : configuredState(verifierA),
    didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    panel.state.proxyVerifierHash.value = verifierB; await flush();
    const refresh = panel.state.refreshVerifierStateAction(); await flush();
    fresh.resolve(configuredState(verifierB, '8')); await refresh; await flush();
    old.resolve(configuredState(verifierB, '7')); await flush();
    assert.equal(panel.state.canPreviewProxy.value, true);
    await panel.state.previewProxyAction();
    assert.equal(calls[0].sessionNonce, '8');
  } finally { old.resolve(configuredState(verifierB, '7')); fresh.resolve(configuredState(verifierB, '8')); panel.stop(); }
});

for (const key of ['rpc', 'core', 'account']) {
  test(`proxy context invalidates and rejects stale ${key} reads`, async () => {
    const old = pending(), fresh = pending(), calls = [], reads = [];
    let holdOld = false, holdFresh = false;
    const panel = createPanel({
      connected: true,
      identityReader: async ({ accountIdHex }) => ({ accountIdHex, verifierHash: verifierB }),
      stateReader: async options => {
        reads.push(options);
        if (holdFresh) return fresh.promise;
        if (holdOld) return old.promise;
        return configuredState(verifierB);
      },
      didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
    });
    try {
      await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
      holdOld = true;
      const refresh = panel.state.refreshVerifierStateAction(); await flush();
      holdFresh = true;
      if (key === 'rpc') panel.runtimeConfig.rpcUrl = 'http://127.0.0.1:20332';
      if (key === 'core') panel.props.aaContractHash = '99'.repeat(20);
      if (key === 'account') panel.props.accountIdPrefill = accountB;
      assert.equal(panel.state.canPreviewProxy.value, false, 'context changes must reject old admission immediately');
      await flush();
      const nextCore = key === 'core' ? '99'.repeat(20) : core;
      fresh.resolve(configuredState(verifierB, '11', { aaContract: nextCore })); await flush();
      old.resolve(configuredState(verifierB, '7')); await refresh; await flush();
      assert.equal(panel.state.canPreviewProxy.value, true);
      await panel.state.previewProxyAction();
      assert.equal(calls[0].sessionNonce, '11');
      assert.equal(calls[0].aaContract, nextCore);
      assert.equal(calls[0].accountIdRaw, key === 'account' ? accountB : accountA);
      assert.equal(reads.at(-1).rpcUrl, panel.runtimeConfig.rpcUrl);
      assert.equal(reads.at(-1).accountIdHex, key === 'account' ? accountB : accountA);
      assert.equal(reads.at(-1).verifierHash, verifierB);
    } finally { old.resolve(null); fresh.resolve(null); panel.stop(); }
  });
}

test('empty proxy selection falls back to independently read recovery verifier context', async () => {
  const calls = [];
  const panel = createPanel({
    connected: true, recoveryVerifierPrefill: verifierA,
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierB }),
    stateReader: async ({ verifierHash }) => configuredState(verifierHash, verifierHash === verifierB ? '7' : '0'),
    didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    panel.state.proxyVerifierHash.value = ''; await flush();
    assert.equal(panel.state.canPreviewProxy.value, true);
    await panel.state.previewProxyAction();
    assert.equal(calls[0].verifierContract, verifierA);
    assert.equal(calls[0].sessionNonce, '0');
  } finally { panel.stop(); }
});

test('incomplete verifier address edits disable proxy preview without watcher errors', async () => {
  const calls = [];
  const panel = createPanel({
    connected: true,
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierA }),
    stateReader: async ({ verifierHash }) => configuredState(verifierHash),
    didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    assert.doesNotThrow(() => { panel.state.proxyVerifierHash.value = 'N'; });
    await flush();
    assert.equal(panel.state.canPreviewProxy.value, false);
    await panel.state.previewProxyAction();
    assert.equal(calls.length, 0);
    assert.deepEqual(panel.errors, []);
  } finally { panel.stop(); }
});

test('direct proxy preview rechecks plain runtime RPC provenance before service use', async () => {
  const calls = [], reads = [];
  const panel = createPanel({
    connected: true, reactiveRuntime: false,
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierA }),
    stateReader: async options => { reads.push(options); return configuredState(verifierA); },
    didService: { previewActionTicket: async input => { calls.push(input); return {}; } },
  });
  try {
    await flush(); panel.state.proxyExecutor.value = '88'.repeat(20);
    assert.equal(panel.state.canPreviewProxy.value, true);
    panel.runtimeConfig.rpcUrl = 'http://127.0.0.1:20332';
    await panel.state.previewProxyAction();
    assert.equal(calls.length, 0, 'a cached computed admission cannot authorize a different RPC context');
    await panel.state.refreshVerifierStateAction();
    assert.equal(reads.at(-1).rpcUrl, panel.runtimeConfig.rpcUrl);
    await panel.state.previewProxyAction();
    assert.equal(calls.length, 1);
  } finally { panel.stop(); }
});


test('action enrollment and legacy reauthorization require explicit user handlers and fresh proxy provenance', async () => {
  const calls = [];
  const panel = createPanel({ connected: true,
    identityReader: async () => ({ accountIdHex: accountA, verifierHash: verifierA }),
    stateReader: async () => configuredState(verifierA, '0', { activeSession: { active: true, executor: '88'.repeat(20), actionId: 'aa_proxy:fixture', expiresAt: '1800000000000', actionNullifier: '99'.repeat(32) } }),
    didService: { setActionIdentity: async p => { calls.push(['enroll', p]); return {}; }, reauthorizeActiveActionSession: async p => { calls.push(['reauthorize', p]); return {}; } },
  });
  try {
    await flush(); assert.equal(calls.length, 0);
    panel.state.actionMasterNullifier.value = 'aa'.repeat(32);
    await panel.state.manageActionIdentity(true);
    assert.equal(calls[0][1].accountIdHex, accountA); assert.equal(calls[0][1].enabled, true);
    await panel.state.reauthorizeActionSession();
    assert.equal(calls[1][1].session.executor, '88'.repeat(20));
    panel.props.aaContractHash = 'ff'.repeat(20);
    await panel.state.manageActionIdentity(true);
    assert.equal(calls.length, 2, 'plain stale context cannot submit an enrollment');
  } finally { panel.stop(); }
});
