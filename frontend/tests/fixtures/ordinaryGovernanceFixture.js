import assert from 'node:assert/strict';

export const ordinaryOwner = '11'.repeat(19) + '12';
export const ordinaryOtherOwner = '99'.repeat(19) + '98';
export const ordinaryAccountId = '22'.repeat(19) + '23';
export const ordinaryOtherAccountId = 'aa'.repeat(19) + 'ab';
export const ordinaryCore = 'cc'.repeat(19) + 'cd';
export const ordinaryRpcUrl = 'https://ordinary.fixture.test/rpc';
export const ordinaryMagic = 123;
export const ordinaryZero = '00'.repeat(20);
const integer = (value) => ({ type: 'Integer', value: String(value) });
const boolean = (value) => ({ type: 'Boolean', value });
const bytes = (hex) => ({ type: 'ByteString', value: Buffer.from(hex, 'hex').toString('base64') });
const hash = (hex) => bytes(Buffer.from(hex, 'hex').reverse().toString('hex'));
const none = () => ({ type: 'Any', value: null });

export function createOrdinaryGovernanceFixture() {
  const matureAt = 1900000000000;
  const pending = (role) => ({
    module: (role === 'verifier' ? '55'.repeat(19) + '56' : '77'.repeat(19) + '78'),
    params: role === 'verifier' ? '03abcd' : '',
    initiatedAt: matureAt - 86400000,
    matureAt,
  });
  const state = {
    time: matureAt - 1,
    height: 10,
    fullPendingRoles: ['verifier', 'hook'],
    verifier: '33'.repeat(19) + '34',
    hook: '44'.repeat(19) + '45',
    backupOwner: ordinaryOwner,
    escapeTimelock: 604800,
    escapeTriggeredAt: 0,
    escapeActive: false,
    marketEscrow: false,
    pendingVerifier: pending('verifier'),
    pendingHook: pending('hook'),
    calls: [],
    walletRequests: [],
    failures: [],
    unexpectedRequests: [],
  };
  function contractState() {
    return { hash: '0x' + ordinaryCore, manifest: { name: 'UnifiedSmartWalletV3', abi: { methods: state.fullPendingRoles.map((role) => ({
      name: `getPending${role === 'verifier' ? 'Verifier' : 'Hook'}Update`,
      parameters: [{ name: 'accountId', type: 'Hash160' }],
      returntype: 'Any', safe: true,
    })) } } };
  }
  function pendingItem(value) {
    return value ? { type: 'Array', value: [hash(value.module), bytes(value.params), integer(value.initiatedAt), integer(value.matureAt)] } : none();
  }
  async function send(method, params = []) {
    state.calls.push({ method, params: structuredClone(params) });
    assert.notEqual(method, 'sendrawtransaction', 'browser fixture must never broadcast a raw transaction');
    if (method === 'getversion') return { protocol: { network: ordinaryMagic } };
    if (method === 'getcontractstate') return contractState();
    if (method === 'getblockcount') return state.height + 1;
    if (method === 'getblockheader') {
      assert.equal(params[0], state.height);
      return { index: state.height, hash: '0x' + state.height.toString(16).padStart(64, '0'), time: state.time };
    }
    if (method === 'getapplicationlog') return { txid: params[0], executions: [{ trigger: 'Application', vmstate: 'HALT', stack: [], notifications: [] }] };
    assert.equal(method, 'invokefunction', `Unstubbed fixture RPC: ${method}`);
    const operation = params[1];
    assert.equal(String(params[0]).replace(/^0x/, '').toLowerCase(), ordinaryCore);
    assert.equal(params[2]?.length, 1);
    assert.equal(params[2][0].type, 'Hash160');
    assert.equal(String(params[2][0].value).replace(/^0x/, '').toLowerCase(), ordinaryAccountId);
    const values = {
      getVerifier: () => hash(state.verifier), getHook: () => hash(state.hook), getBackupOwner: () => hash(state.backupOwner),
      getEscapeTimelock: () => integer(state.escapeTimelock), getEscapeTriggeredAt: () => integer(state.escapeTriggeredAt),
      isEscapeActive: () => boolean(state.escapeActive), isMarketEscrowActive: () => boolean(state.marketEscrow),
      getPendingVerifierUpdate: () => pendingItem(state.pendingVerifier), getPendingHookUpdate: () => pendingItem(state.pendingHook),
      hasPendingVerifierUpdate: () => boolean(!!state.pendingVerifier), hasPendingHookUpdate: () => boolean(!!state.pendingHook),
      getPendingVerifierUpdateTime: () => integer(state.pendingVerifier?.matureAt || 0), getPendingHookUpdateTime: () => integer(state.pendingHook?.matureAt || 0),
    };
    assert.equal(typeof values[operation], 'function', `Unstubbed account method: ${operation}`);
    return { state: 'HALT', gasconsumed: '100000', stack: [values[operation]()] };
  }
  function invoke(request) {
    state.walletRequests.push(structuredClone(request));
    const match = /^(confirm|cancel)(Verifier|Hook)Update$/.exec(request.operation);
    if (match) {
      const key = `pending${match[2]}`;
      if (match[1] === 'confirm' && state[key]) state[match[2].toLowerCase()] = state[key].module;
      state[key] = null;
    } else if (request.operation === 'initiateEscape') {
      state.escapeActive = true;
      state.escapeTriggeredAt = state.time;
    } else if (request.operation === 'finalizeEscape') {
      state.escapeActive = false;
      state.escapeTriggeredAt = 0;
      state.verifier = request.args[1].value.replace(/^0x/, '');
    }
    return { txid: '0x' + state.walletRequests.length.toString(16).padStart(64, '0') };
  }
  async function route(requestRoute, localOrigin) {
    const request = requestRoute.request();
    const url = new URL(request.url());
    let body;
    try { body = request.postDataJSON(); } catch (_) { /* Non-JSON assets are handled below. */ }
    if (body?.jsonrpc === '2.0' && typeof body.method === 'string') {
      try {
        const result = await send(body.method, body.params);
        return requestRoute.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
      } catch (error) {
        state.failures.push(error.message);
        return requestRoute.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: error.message } }) });
      }
    }
    if (url.origin === localOrigin && url.pathname === '/api/account-metadata' && request.method() === 'POST' && ['get', 'getBatch'].includes(body?.action)) {
      return requestRoute.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, metadata: null, map: {} }) });
    }
    if (url.origin === localOrigin && request.method() === 'GET') return requestRoute.continue();
    // Local application POSTs are deliberately blocked unless they are the
    // explicitly stubbed metadata reads above.
    if (url.origin === localOrigin && request.method() === 'POST') return requestRoute.abort('blockedbyclient');
    // Keep remote font/style fetches deterministic without allowing arbitrary
    // third-party network traffic during this fixture-driven browser test.
    if (['font', 'stylesheet'].includes(request.resourceType())) {
      return requestRoute.fulfill({ status: 200, contentType: request.resourceType() === 'font' ? 'font/woff2' : 'text/css', body: '' });
    }
    state.unexpectedRequests.push({ url: request.url(), method: request.method() });
    return requestRoute.abort('blockedbyclient');
  }
  return { state, matureAt, pending, send, invoke, route };
}
