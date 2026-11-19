/**
 * Account configuration reads and review checks for the v4 protocol.
 *
 * v4 has no verifier slot, no hook slot and no escape latch to read: an account
 * carries a control record (custody, recovery authority, timelock, nonces),
 * a set of installed module instances, a core-owned hook order, and pending
 * configuration intents that mature rather than take effect on proposal. This
 * module reads exactly those and refuses to describe anything it cannot decode.
 *
 * Writes live in smartAccountProtocol.js (action grammar) and
 * useStudioController.js (which intent the operator chose); nothing here builds
 * a transaction.
 */

import { decodeStackInteger, hash160Param } from './helpers.js';
import {
  decodeAccountDescriptor,
  decodeHookOrder,
  decodeModuleDescriptor,
  decodeModulePage,
  decodePendingConfiguration,
  decodeRecoveryStatus,
} from '../../services/smartAccountProtocol.js';

const MODULE_PAGE_LIMIT = '32';

function hashItem(value) {
  return { type: 'Hash160', value: hash160Param(value) };
}

function intItem(value) {
  return { type: 'Integer', value: String(value) };
}

/**
 * True when the connected wallet is the account's custody. The distinction
 * decides whether a configuration intent can be proposed at all: custody is
 * the witness-bearing controller, not a display preference.
 */
export function custodyIssues(custody, wallet) {
  let authority;
  try {
    authority = hash160Param(custody);
  } catch (_) {
    return 'custody-invalid';
  }
  if (/^0+$/.test(authority)) return 'custody-invalid';
  if (!wallet) return 'wallet-required';
  try {
    return hash160Param(wallet) === authority ? '' : 'custody-mismatch';
  } catch (_) {
    return 'custody-mismatch';
  }
}

export async function readChainClock(send) {
  const count = await send('getblockcount', []);
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Invalid node block count.');
  const header = await send('getblockheader', [count - 1, true]);
  if (!header
    || header.index !== count - 1
    || !Number.isSafeInteger(header.time)
    || header.time <= 0
    || !/^(0x)?[0-9a-fA-F]{64}$/.test(header.hash || '')) {
    throw new Error('Invalid node block timestamp.');
  }
  return { height: header.index, hash: header.hash.toLowerCase(), time: header.time };
}

/**
 * One consistent read of an account's v4 configuration. The chain clock is
 * sampled before and after so a snapshot never mixes two blocks — a maturity
 * decision made on mixed state is exactly the kind of review error this guard
 * exists to prevent.
 */
export async function readAccountConfiguration({ accountId, read, readClock }) {
  const normalized = hash160Param(accountId);
  const before = await readClock();

  const readItem = async (method, args) => {
    const response = await read(method, args);
    if (String(response?.state).toUpperCase() !== 'HALT' || response.stack?.length !== 1) {
      throw new Error(`Cannot read ${method}.`);
    }
    return response.stack[0];
  };

  const account = decodeAccountDescriptor(await readItem('getAccount', [hashItem(normalized)]));

  const modules = [];
  const pages = [];
  for (const moduleType of ['validator', 'hook']) {
    let cursor = '0';
    for (;;) {
      const page = decodeModulePage(await readItem('getModules', [
        hashItem(normalized),
        { type: 'String', value: moduleType },
        intItem(cursor),
        intItem(MODULE_PAGE_LIMIT),
      ]));
      pages.push({ moduleType, ...page });
      for (const moduleId of page.ids) {
        const descriptor = decodeModuleDescriptor(await readItem('getModule', [
          hashItem(normalized),
          intItem(moduleId),
        ]));
        if (descriptor) modules.push(descriptor);
      }
      if (page.ids.length === 0 || page.nextCursor === '0') break;
      cursor = page.nextCursor;
    }
  }

  const hookOrder = decodeHookOrder(await readItem('getHookOrder', [hashItem(normalized)]));

  const intentIdsItem = await readItem('getPendingConfigurationIntentIds', [hashItem(normalized)]);
  const intentIds = intentIdsItem?.type === 'Array' && Array.isArray(intentIdsItem.value)
    ? intentIdsItem.value.map((item) => String(decodeStackInteger(item)))
    : [];

  const pending = [];
  for (const intentId of intentIds) {
    const decoded = decodePendingConfiguration(await readItem('getPendingConfiguration', [
      hashItem(normalized),
      intItem(intentId),
    ]));
    if (decoded) pending.push(decoded);
  }

  const recovery = decodeRecoveryStatus(await readItem('getRecoveryStatus', [hashItem(normalized)]));

  const chain = await readClock();
  if (before.height !== chain.height || before.hash !== chain.hash) {
    throw new Error('Node block changed while reading. Refresh state.');
  }
  if (account.exists && /^0+$/.test(account.custody)) {
    throw new Error('Invalid account custody state.');
  }

  return {
    accountId: normalized,
    account,
    modules,
    pages,
    hookOrder,
    recovery,
    intentIds,
    pending,
    chain,
  };
}

/**
 * Why a configuration intent cannot be proposed right now. Order matters: the
 * first blocker is the one the screen explains.
 */
export function configurationBlockers(snapshot, actions) {
  if (!snapshot?.account?.exists) return 'account-missing';
  if (snapshot.account.status === 'frozen') return 'account-frozen';
  if (snapshot.account.status === 'migrationRequired') return 'migration-required';
  if (snapshot.account.marketEscrowActive) return 'market-escrow';
  if (Array.isArray(actions) && actions.length === 0) return 'no-actions';
  if (Array.isArray(snapshot.pending) && snapshot.pending.length > 0) return 'pending-intent';
  return '';
}

/** Why a custody action (freeze, recovery, revoke) cannot run right now. */
export function custodyActionBlockers(snapshot, action) {
  if (!snapshot?.account?.exists) return 'account-missing';
  if (snapshot.account.marketEscrowActive && action !== 'cancelRecovery') return 'market-escrow';
  if (action === 'beginRecovery') {
    if (snapshot.account.ownerOnlyRecovery) return 'owner-only-recovery';
    if (snapshot.recovery) return 'recovery-active';
  }
  if (action === 'executeRecovery') {
    if (!snapshot.recovery) return 'recovery-missing';
    if (snapshot.chain.time < Number(snapshot.recovery.matureAt)) return 'recovery-immature';
  }
  if (action === 'cancelRecovery' && !snapshot.recovery) return 'recovery-missing';
  return '';
}

/** The part of a snapshot a review is bound to (everything but the clock). */
function snapshotIdentity(snapshot) {
  const { chain, loadedAt, ...state } = snapshot;
  return state;
}

/**
 * Builds the review record a confirmation step shows. `actions` are already
 * encoded by smartAccountProtocol.js, so the digest the operator reads is the
 * digest the chain will execute.
 */
export function captureConfigurationReview(snapshot, actions) {
  const blocker = configurationBlockers(snapshot, actions);
  if (blocker) throw new Error(`Cannot propose this configuration: ${blocker}`);
  return {
    accountId: snapshot.accountId,
    actions: JSON.parse(JSON.stringify(actions)),
    snapshot: snapshotIdentity(snapshot),
  };
}

/**
 * A review is only still valid if custody still matches, the account state is
 * unchanged, and the action list is byte-identical. A matured intent is a new
 * execution of an already-reviewed action list, so it is checked the same way.
 */
export function assertConfigurationReviewCurrent(review, snapshot, wallet, currentActions = review.actions) {
  if (custodyIssues(snapshot?.account?.custody, wallet)) {
    throw new Error('Connect the account custody wallet.');
  }
  if (snapshot?.accountId !== review.accountId) {
    throw new Error('Account changed. Load and review again.');
  }
  if (JSON.stringify(snapshotIdentity(snapshot)) !== JSON.stringify(review.snapshot)) {
    throw new Error('Account configuration changed. Refresh and review again.');
  }
  if (JSON.stringify(currentActions) !== JSON.stringify(review.actions)) {
    throw new Error('The configuration request changed. Review again.');
  }
}

/** True when a pending intent has matured (or expired) at the sampled clock. */
export function intentStatus(intent, nowMs) {
  const matureAt = Number(intent?.matureAt || 0);
  const expiresAt = Number(intent?.expiresAt || 0);
  if (!intent) return 'missing';
  if (expiresAt > 0 && expiresAt <= nowMs) return 'expired';
  if (matureAt > nowMs) return 'maturing';
  return 'mature';
}
