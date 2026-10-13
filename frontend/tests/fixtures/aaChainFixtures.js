// Builders that turn the recorded AA chain steps (aa-chain-records-20261005.json, an extract of the
// deployed-bytes run of the 2026-10-05 assessment on published neoxp 3.10.1.18) into the JSON the Neo RPC
// returns for them.
//
// Recorded in the extract: step text, call, signers, VM outcome, GAS consumed, event names, decoded result
// and txid. Derived here, never recorded: the RPC envelope ({ state, gasconsumed, stack }) and the
// notification states (UInt160 values as little-endian ByteStrings), built from the operation the harness
// sent for those steps (GAS.transfer through executeUserOp).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const chain = JSON.parse(
  fs.readFileSync(path.join(here, 'aa-chain-records-20261005.json'), 'utf8'),
);

export const GAS_HASH = 'd2a4cff31913016155e38e474a2c06d08be276cf';
export const CORE_HASH = chain.contracts.UnifiedSmartWalletV3.replace(/^0x/, '');
export const MOCK_TARGET_HASH = chain.contracts.MockTransferTarget.replace(/^0x/, '');
// Well-known sample hashes of the repository's own tests (accountId, its proxy address, a buyer).
export const ACCOUNT_ID = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
export const PROXY_HASH = '13ef519c362973f9a34648a9eac5b71250b2a80a';
export const BUYER_HASH = '49c095ce04d38642e39155f5481615c58227a498';

export const records = chain.records;
export const relayRoute = chain.relayRoute;

export const boolItem = (value) => ({ type: 'Boolean', value });
export const integerItem = (value) => ({ type: 'Integer', value: String(value) });

function reverseHex(hex) {
  return hex.match(/.{2}/g).reverse().join('');
}

/** A UInt160 as the node returns it inside notification state: ByteString of the little-endian bytes. */
export function byteStringHash(displayHex) {
  return { type: 'ByteString', value: Buffer.from(reverseHex(displayHex), 'hex').toString('base64') };
}

export function byteStringText(text) {
  return { type: 'ByteString', value: Buffer.from(text, 'utf8').toString('base64') };
}

export function userOpExecutedNotification({ method = 'transfer', target = GAS_HASH, nonce = 0 } = {}) {
  return {
    contract: `0x${CORE_HASH}`,
    eventname: 'UserOpExecuted',
    state: {
      type: 'Array',
      value: [byteStringHash(ACCOUNT_ID), byteStringHash(target), byteStringText(method), integerItem(nonce)],
    },
  };
}

export function transferNotification() {
  return {
    contract: `0x${GAS_HASH}`,
    eventname: 'Transfer',
    state: {
      type: 'Array',
      value: [byteStringHash(PROXY_HASH), byteStringHash(BUYER_HASH), integerItem(100000000)],
    },
  };
}

function notificationFor(eventName, op) {
  if (eventName === 'UserOpExecuted') return userOpExecutedNotification(op);
  if (eventName === 'Transfer') return transferNotification();
  return { contract: `0x${CORE_HASH}`, eventname: eventName, state: { type: 'Array', value: [] } };
}

/** What `invokescript` answers for a recorded step: state, GAS and the decoded result as the stack head. */
export function invokeScriptResult(record, { stack } = {}) {
  return {
    script: 'AAAA',
    state: record.outcome || record.simulation,
    gasconsumed: String(record.gas),
    exception: null,
    stack: stack || [boolItem(record.result)],
  };
}

/** What `getapplicationlog` answers for a recorded step (one Application execution). */
export function applicationLog(record, { op = {}, stack, notifications } = {}) {
  return {
    txid: record.txid,
    executions: [
      {
        trigger: 'Application',
        vmstate: record.outcome,
        exception: null,
        gasconsumed: String(record.gas),
        stack: stack || [boolItem(record.result)],
        notifications: notifications || record.events.map((eventName) => notificationFor(eventName, op)),
      },
    ],
  };
}

/** A user-operation meta invocation as the wallet and the relay route carry it. */
export function userOpParam({ target = GAS_HASH, method = 'transfer', args = [], nonce = 0 } = {}) {
  return {
    type: 'Struct',
    value: [
      { type: 'Hash160', value: `0x${target}` },
      { type: 'String', value: method },
      { type: 'Array', value: args },
      { type: 'Integer', value: String(nonce) },
      { type: 'Integer', value: '9999999999999' },
      { type: 'ByteArray', value: `0x${'11'.repeat(64)}` },
    ],
  };
}

export const gasTransferArgs = ({ from = PROXY_HASH, to = BUYER_HASH, amount = '100000000' } = {}) => [
  { type: 'Hash160', value: `0x${from}` },
  { type: 'Hash160', value: `0x${to}` },
  { type: 'Integer', value: amount },
  { type: 'ByteArray', value: '0x' },
];

export function executeUserOpInvocation(opOptions = {}) {
  return {
    scriptHash: CORE_HASH,
    operation: 'executeUserOp',
    args: [{ type: 'Hash160', value: `0x${ACCOUNT_ID}` }, userOpParam(opOptions)],
  };
}

export function executeUserOpsInvocation(ops = []) {
  return {
    scriptHash: CORE_HASH,
    operation: 'executeUserOps',
    args: [
      { type: 'Hash160', value: `0x${ACCOUNT_ID}` },
      { type: 'Array', value: ops.map((op) => userOpParam(op)) },
    ],
  };
}
