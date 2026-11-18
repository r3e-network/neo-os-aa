import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// F-19 regression tests: binding a deployed module (verifier or paymaster) to
// the active SA core must distinguish the first bind from a rebind — only the
// initial setAuthorizedCore is valid (audit fix M-7); a rebind must refuse with
// the timelocked remediation instead of broadcasting a doomed transaction.

const require = createRequire(import.meta.url);
const { MAINNET_MAGIC, ESCAPE_TIMELOCK, bindAuthorizedCoreToActiveCore } = require('./deploy_mainnet_market_paymaster.js');

const ACTIVE_CORE = '11'.repeat(20);
const OTHER_CORE = 'c3d4'.repeat(10);

/** Stack item as the RPC returns an authorizedCore Hash160 (wire bytes, base64). */
function authorizedCoreStack(displayHex) {
  const wire = displayHex.match(/.{2}/g).reverse().join('');
  return { stack: [{ type: 'ByteString', value: Buffer.from(wire, 'hex').toString('base64') }] };
}

const BIND_TXID = `0x${'ab'.repeat(32)}`;

async function bindWith({ stack }) {
  const broadcasts = [];
  const transactions = {};
  const result = await bindAuthorizedCoreToActiveCore({
    invokeCtx: { client: {}, account: { scriptHash: 'ef'.repeat(20) }, networkMagic: MAINNET_MAGIC, rpcUrl: 'https://example.invalid' },
    client: {},
    moduleLabel: 'Paymaster',
    contractHash: `0x${'99'.repeat(20)}`,
    activeCoreHash: `0x${ACTIVE_CORE}`,
    transactions,
    txKey: 'setAuthorizedCoreTx',
    invokeReadFn: async () => stack,
    invokePersistedFn: async (request) => {
      broadcasts.push(request);
      return { txid: BIND_TXID, appLog: {} };
    },
  });
  return { result, broadcasts, transactions };
}

test('the script is pinned to Neo mainnet and the protocol minimum escape timelock', () => {
  assert.equal(MAINNET_MAGIC, 860833102);
  assert.equal(ESCAPE_TIMELOCK, 604800);
});

test('an unset core is a first bind: the one valid setAuthorizedCore is sent', async () => {
  const { result, broadcasts, transactions } = await bindWith({ stack: authorizedCoreStack('00'.repeat(20)) });
  assert.equal(result.binding, 'first-bind');
  assert.equal(result.txid, BIND_TXID);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].operation, 'setAuthorizedCore');
  assert.equal(String(broadcasts[0].params[0].value), ACTIVE_CORE);
  assert.equal(transactions.setAuthorizedCoreTx, BIND_TXID);
});

test('a module already bound to the active core is left alone', async () => {
  const { result, broadcasts, transactions } = await bindWith({ stack: authorizedCoreStack(ACTIVE_CORE) });
  assert.equal(result.binding, 'already-bound');
  assert.equal(result.txid, null);
  assert.equal(broadcasts.length, 0);
  assert.deepEqual(transactions, {});
});

test('a rebind refuses with the timelocked remediation instead of broadcasting', async () => {
  const { broadcasts } = await bindWith({ stack: authorizedCoreStack(OTHER_CORE) }).then(
    () => { throw new Error('rebind must reject'); },
    (error) => {
      assert.match(error.message, /Paymaster 0x99+ is already bound to SA core 0xc3d4c3d4/);
      assert.match(error.message, /proposeAuthorizedCore/);
      assert.match(error.message, /confirmAuthorizedCore/);
      return { broadcasts: [] };
    },
  );
  assert.equal(broadcasts.length, 0);
});
