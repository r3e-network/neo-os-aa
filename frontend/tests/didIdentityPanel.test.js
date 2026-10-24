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
}) {
  const props = reactive({ aaContractHash: core, accountIdPrefill: accountA, accountAddressScriptHash: '', neoWalletAddress: '', recoveryVerifierPrefill: '', recoveryNewOwnerPrefill, recoveryExpiryPrefill: '', autoPreviewRecovery: false });
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
    RUNTIME_CONFIG: { rpcUrl: 'http://127.0.0.1:10332' },
    translateError: (message) => message,
  };
  const sfc = fs.readFileSync(new URL('../src/features/operations/components/DidIdentityPanel.vue', import.meta.url), 'utf8');
  const source = sfc.match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import\s+[\s\S]*?\s+from\s+["'][^"']+["'];\s*$/gm, '')
    .replaceAll('import.meta.env.DEV', 'false');
  const setup = new Function(...Object.keys(bindings), `${source}\nreturn { resolvedAccountId, recoveryVerifierHash, recoveryNewOwner, proxyVerifierHash, proxyExecutor, verifierState, maintenanceState, canPreviewRecovery, canPreviewProxy, canInvokeRecovery, canInvokeProxy, previewRecoveryAction, previewProxyAction, refreshVerifierStateAction };`);
  return { props, errors, state: scope.run(() => setup(...Object.values(bindings))), stop: () => scope.stop() };
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
    network: 'neo3-testnet',
    aaContract: core,
    accountIdText: 'shared-account-text',
    accountAddress,
    recoveryNonce: '0',
    sessionNonce: '0',
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
