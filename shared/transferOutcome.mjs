/**
 * Transfer outcome rules for the Neo N3 Abstract Account stack.
 *
 * Why this exists. The account core hands the result of the call it executes back untouched, and the transaction
 * still HALTs when that result is a refusal. A NEP-17 or NEP-11 `transfer` answers `false` when the move did not
 * happen (the witness of `from` is missing, the balance is too low); the account then burns its nonce and the fee
 * for nothing. Recorded on the deployed core (AA-03 case a, AA-09 cases 8 and 9): GAS.transfer out of the account's
 * proxy address, carried by executeUserOp with only the owner's or the relay's witness, HALTs with result false and
 * moves no GAS; the relay route still broadcast it.
 *
 * One module for the three places that must never disagree about that verdict:
 * - the relay route (frontend/api/relay-transaction.js) judges the simulated stack before it signs or broadcasts;
 * - the wallet judges the relay's answer (relayPreflight.js) and the application log of a sent transaction
 *   (studio/txConfirmation.js), and refuses to build the operation when the source is the account proxy (presets.js);
 * - the SDK refuses the same operation in simulateUserOperation and exports these helpers for apps.
 *
 * Scope on purpose: only a method named `transfer` and only a Boolean `false`. `false` is the normal result of
 * other calls (arming a timelocked change returns false), and a result that is not a Boolean says nothing here.
 *
 * Dependency-free, like metaTxCore.mjs. frontend/src/shared/transferOutcome.mjs is a byte-identical copy (the
 * Vercel project root is frontend/); frontend/tests/transferOutcomeShared.test.js fails when they drift.
 */

export const TRANSFER_METHOD = 'transfer';
export const TRANSFER_RETURNED_FALSE = 'transfer_returned_false';
export const TRANSFER_RETURNED_FALSE_MESSAGE = 'A token transfer returned false, so no tokens moved; the nonce and the fee are still spent.';

const USER_OP_ENTRY_POINTS = ['executeUserOp', 'executeSponsoredUserOp'];
const USER_OP_BATCH_ENTRY_POINTS = ['executeUserOps', 'executeSponsoredUserOps'];
const LEGACY_ENTRY_POINTS = ['executeUnified', 'executeUnifiedByAddress'];
const USER_OP_METHOD_FIELD = 1; // UserOperation(target, method, args, nonce, deadline, signature)
const LEGACY_METHOD_ARG = 2; // executeUnified*(account, target, method, args, ...)
const EVENT_METHOD_FIELD = 2; // UserOpExecuted(accountId, targetContract, method, nonce)
const HASH160_PATTERN = /^[0-9a-f]{40}$/;

/** The NEP method name, exactly: Neo method lookup is case-sensitive. */
export function isTransferMethod(method) {
  return typeof method === 'string' && method === TRANSFER_METHOD;
}

/** True for a Boolean stack item that is false; any other item says nothing about a transfer. */
export function isFalseBooleanItem(item) {
  if (!item || typeof item !== 'object' || item.type !== 'Boolean') return false;
  const { value } = item;
  return value === false || value === 0 || value === 'false' || value === 'False' || value === '0';
}

function normalizeHash(value) {
  return String(value ?? '').replace(/^0x/i, '').toLowerCase();
}

/**
 * A transfer whose source is the account's own proxy address. The token checks that address as a witness; an
 * owner or relay signature does not provide it, so the call returns false (recorded: AA-03 case a).
 *
 * @param {{ method: string, from: string, proxy: string }} operation hashes as 40 hex characters, 0x optional
 */
export function isProxySourcedTransfer({ method, from, proxy } = {}) {
  if (!isTransferMethod(method)) return false;
  const source = normalizeHash(from);
  return HASH160_PATTERN.test(source) && source === normalizeHash(proxy);
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes);
}

function textFromHex(value) {
  const hex = normalizeHash(value);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return '';
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytesToText(bytes);
}

// Buffer and atob are read through globalThis on purpose (see metaTxCore.mjs): a free `Buffer` identifier would
// make bundler node-polyfill plugins inject a shim import that cannot resolve from outside the frontend package.
function textFromBase64(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (typeof globalThis.Buffer !== 'undefined') return globalThis.Buffer.from(value, 'base64').toString('utf8');
  if (typeof globalThis.atob !== 'function') return '';
  try {
    const binary = globalThis.atob(value);
    return bytesToText(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch (_malformed) {
    // A log from a node is data: malformed base64 is an unknown method, never an exception.
    return '';
  }
}

// A method name inside a request, the way the relay builds the script from it: String is text, every other
// string-valued type (ByteArray, Any, unknown) is the hex of the bytes that get pushed.
function methodFromRequestParam(param) {
  if (!param || typeof param !== 'object' || typeof param.value !== 'string') return '';
  return param.type === 'String' ? param.value : textFromHex(param.value);
}

function isContainer(param) {
  return Boolean(param) && typeof param === 'object' && (param.type === 'Struct' || param.type === 'Array') && Array.isArray(param.value);
}

function methodOfUserOp(param) {
  return isContainer(param) ? methodFromRequestParam(param.value[USER_OP_METHOD_FIELD]) : '';
}

/**
 * The operations a relay-ready meta invocation will execute: their method names in order, and whether the
 * invocation is a batch (its result is then an array with one result per operation).
 *
 * @param {{ operation?: string, args?: Array }} invocation as the wallet and the relay route carry it
 * @returns {{ methods: string[], batch: boolean }}
 */
export function extractInvocationShape(invocation) {
  const operation = invocation && typeof invocation === 'object' ? invocation.operation : '';
  const args = invocation && Array.isArray(invocation.args) ? invocation.args : [];
  if (USER_OP_ENTRY_POINTS.includes(operation)) {
    return { methods: [methodOfUserOp(args[1])], batch: false };
  }
  if (USER_OP_BATCH_ENTRY_POINTS.includes(operation)) {
    const ops = isContainer(args[1]) ? args[1].value : [];
    return { methods: ops.map(methodOfUserOp), batch: true };
  }
  if (LEGACY_ENTRY_POINTS.includes(operation)) {
    return { methods: [methodFromRequestParam(args[LEGACY_METHOD_ARG])], batch: false };
  }
  return { methods: [], batch: false };
}

/**
 * Positions of the transfer operations whose result is a Boolean false.
 *
 * `head` is the first stack item the VM returned: the operation's own result, or for a batch the array of one
 * result per operation. Results that cannot be attributed to the operations (a batch whose array is not as long
 * as the operations list, or is not an array) are judged conservatively: every false in them counts once a
 * transfer is among the operations, because a silent no-op is worse than a loud false alarm.
 *
 * @param {{ methods: string[], head?: object, batch?: boolean }} outcome
 * @returns {number[]} positions in the result array (0 for a single operation)
 */
export function findFailedTransferResults({ methods, head, batch = false } = {}) {
  const operations = Array.isArray(methods) ? methods : [];
  if (!operations.some(isTransferMethod)) return [];

  const results = batch && head && head.type === 'Array' && Array.isArray(head.value) ? head.value : [head];
  if (results.length === operations.length) {
    return operations.flatMap((method, index) => (isTransferMethod(method) && isFalseBooleanItem(results[index]) ? [index] : []));
  }
  return results.flatMap((result, index) => (isFalseBooleanItem(result) ? [index] : []));
}

/** Judge a simulated relay invocation: its meta invocation and the stack the VM returned for it. */
export function findFailedTransferInInvocation({ invocation, stack } = {}) {
  const { methods, batch } = extractInvocationShape(invocation);
  return findFailedTransferResults({ methods, batch, head: Array.isArray(stack) ? stack[0] : undefined });
}

function methodFromNotificationItem(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'ByteString') return textFromBase64(item.value);
  if (item.type === 'String') return typeof item.value === 'string' ? item.value : '';
  return '';
}

/** The methods of the user operations an execution ran, in order, read from its UserOpExecuted notifications. */
export function extractLoggedUserOpMethods(execution) {
  const notifications = execution && Array.isArray(execution.notifications) ? execution.notifications : [];
  return notifications
    .filter((notification) => notification && notification.eventname === 'UserOpExecuted')
    .map((notification) => {
      const state = notification.state;
      return state && state.type === 'Array' && Array.isArray(state.value) ? methodFromNotificationItem(state.value[EVENT_METHOD_FIELD]) : '';
    });
}

/**
 * Judge an execution of a sent transaction (one entry of getapplicationlog's `executions`). The operations come
 * from the UserOpExecuted notifications (accountId, target, method, nonce): a single result belongs to the last
 * one, because a nested operation emits its event before the outer one; an array result is a batch.
 */
export function findFailedTransferInExecution(execution) {
  const methods = extractLoggedUserOpMethods(execution);
  const head = execution && Array.isArray(execution.stack) ? execution.stack[0] : undefined;
  if (methods.length === 0) return [];
  if (head && head.type === 'Array') return findFailedTransferResults({ methods, head, batch: true });
  return findFailedTransferResults({ methods: [methods[methods.length - 1]], head, batch: false });
}
