import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import {
  TRANSFER_RETURNED_FALSE,
  TRANSFER_RETURNED_FALSE_MESSAGE,
  findFailedTransferInExecution,
} from '../../shared/transferOutcome.mjs';

// Confirmation lifecycle states for a relayed/broadcast transaction. These are
// the values stored on a recent-transaction entry and surfaced to the user.
export const TX_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
});

// Bounded polling defaults: a Neo N3 block lands roughly every 15s, so the
// application log is usually available within a couple of blocks. We poll with
// a short initial interval and exponential backoff, capped, and give up after a
// total budget so a never-confirming tx degrades to 'pending' rather than a
// false success.
export const DEFAULT_CONFIRMATION_POLL = Object.freeze({
  initialDelayMs: 2000,
  maxDelayMs: 8000,
  backoffFactor: 1.5,
  timeoutMs: 90000,
  requestTimeoutMs: 12000,
});

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTxidForRpc(txid) {
  const trimmed = String(txid || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed : `0x${trimmed}`;
}

/**
 * Extract the VM execution state from a getapplicationlog result. Neo returns
 * `{ executions: [{ vmstate: 'HALT' | 'FAULT', exception }] }`; older nodes use
 * `{ vmstate }` directly. Returns a normalized uppercase state or '' when the
 * log is not yet available / unparseable.
 */
export function extractVmState(applicationLog) {
  if (!applicationLog || typeof applicationLog !== 'object') return '';
  const executions = Array.isArray(applicationLog.executions) ? applicationLog.executions : null;
  const source = executions && executions.length > 0 ? executions[0] : applicationLog;
  const state = source?.vmstate ?? source?.vmState ?? source?.VMState ?? '';
  return String(state || '').trim().toUpperCase();
}

export function extractVmException(applicationLog) {
  if (!applicationLog || typeof applicationLog !== 'object') return '';
  const executions = Array.isArray(applicationLog.executions) ? applicationLog.executions : null;
  const source = executions && executions.length > 0 ? executions[0] : applicationLog;
  return String(source?.exception ?? source?.Exception ?? '').trim();
}

/**
 * True when the HALTed execution carries a token transfer that returned false: the account core hands that
 * result back untouched, so the transaction HALTs, burns its nonce and its fee, and moves nothing (recorded on
 * the deployed core, AA-03 case a). Only a method named `transfer` and only a Boolean false count: `false` is
 * the normal result of other calls (arming a timelocked change). The operations are read from the log's
 * UserOpExecuted notifications, so no caller has to remember to say what it sent.
 */
export function hasFailedTransfer(applicationLog) {
  if (!applicationLog || typeof applicationLog !== 'object') return false;
  const executions = Array.isArray(applicationLog.executions) ? applicationLog.executions : null;
  const source = executions && executions.length > 0 ? executions[0] : applicationLog;
  return findFailedTransferInExecution(source).length > 0;
}

/**
 * Fetch the application log for a txid over JSON-RPC. Returns the result object,
 * or null when the node does not (yet) have the log. A node that has not indexed
 * the transaction responds with a JSON-RPC error ("Unknown transaction"); that
 * is treated as "not available yet" (null) rather than a hard failure so the
 * caller keeps polling.
 */
export async function fetchApplicationLog(
  rpcUrl,
  txid,
  { fetchImpl, timeoutMs = DEFAULT_CONFIRMATION_POLL.requestTimeoutMs } = {},
) {
  const normalizedTxid = normalizeTxidForRpc(txid);
  if (!normalizedTxid) return null;

  let response;
  try {
    response = await fetchWithTimeout(
      rpcUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getapplicationlog',
          params: [normalizedTxid],
        }),
      },
      { fetchImpl, timeoutMs },
    );
  } catch (_networkError) {
    // Transient network/timeout error: treat as "not available yet" so polling
    // continues until the overall budget is exhausted.
    return null;
  }

  if (!response.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch (_parseError) {
    return null;
  }

  // JSON-RPC error (e.g. transaction not yet known to the node) -> keep waiting.
  if (payload?.error) return null;
  return payload?.result ?? null;
}

/**
 * Poll getapplicationlog until the transaction reaches a terminal VM state
 * (HALT -> confirmed, FAULT -> failed) or the time budget is exhausted
 * (-> pending). A HALT whose token transfer returned false is failed too:
 * nothing moved although the VM finished. Never throws: a stuck or
 * unreachable node degrades to { status: 'pending' } so the UI never shows a
 * false success.
 *
 * Returns { status, vmState, exception }, plus `code` when the failure is a
 * transfer that returned false rather than a VM fault.
 */
export async function waitForTransactionConfirmation(
  rpcUrl,
  txid,
  {
    fetchImpl,
    sleep = defaultSleep,
    now = () => Date.now(),
    initialDelayMs = DEFAULT_CONFIRMATION_POLL.initialDelayMs,
    maxDelayMs = DEFAULT_CONFIRMATION_POLL.maxDelayMs,
    backoffFactor = DEFAULT_CONFIRMATION_POLL.backoffFactor,
    timeoutMs = DEFAULT_CONFIRMATION_POLL.timeoutMs,
    requestTimeoutMs = DEFAULT_CONFIRMATION_POLL.requestTimeoutMs,
  } = {},
) {
  const normalizedTxid = normalizeTxidForRpc(txid);
  if (!normalizedTxid || !rpcUrl) {
    return { status: TX_STATUS.PENDING, vmState: '', exception: '' };
  }

  const deadline = now() + timeoutMs;
  let delay = Math.max(0, initialDelayMs);

  // First wait one interval before the initial poll: the node needs at least a
  // block to index a freshly broadcast transaction.
  while (now() < deadline) {
    await sleep(delay);

    const log = await fetchApplicationLog(rpcUrl, normalizedTxid, {
      fetchImpl,
      timeoutMs: requestTimeoutMs,
    });
    const vmState = extractVmState(log);
    if (vmState === 'HALT') {
      if (hasFailedTransfer(log)) {
        return {
          status: TX_STATUS.FAILED,
          vmState,
          exception: TRANSFER_RETURNED_FALSE_MESSAGE,
          code: TRANSFER_RETURNED_FALSE,
        };
      }
      return { status: TX_STATUS.CONFIRMED, vmState, exception: '' };
    }
    if (vmState === 'FAULT') {
      return { status: TX_STATUS.FAILED, vmState, exception: extractVmException(log) };
    }

    delay = Math.min(maxDelayMs, Math.max(initialDelayMs, Math.round(delay * backoffFactor)));
  }

  return { status: TX_STATUS.PENDING, vmState: '', exception: '' };
}
