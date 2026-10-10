import { hash160Param, decodeStackHash160, decodeStackByteStringHex } from './helpers.js';

const ZERO = '00'.repeat(20);
const HASH = /^[0-9a-f]{40}$/;
function normalizeHash(value) {
  const result = hash160Param(value).toLowerCase();
  if (!HASH.test(result)) throw new Error('Invalid Neo script hash.');
  return result;
}
export function validateRegistrationOwner(owner, wallet) {
  try {
    const hash = normalizeHash(owner);
    if (hash === ZERO) return 'owner-invalid';
    if (!wallet) return 'wallet-required';
    return hash === normalizeHash(wallet) ? '' : 'owner-mismatch';
  } catch (_) { return 'owner-invalid'; }
}
function integer(item, label) {
  if (item?.type !== 'Integer' || !/^\d+$/.test(String(item.value))) throw new Error(`Invalid ${label}.`);
  const value = Number(item.value);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}
function boolean(item) {
  if (item?.type !== 'Boolean' || typeof item.value !== 'boolean') throw new Error('Invalid account Boolean state.');
  return item.value;
}
function stackHash(item) {
  const hash = decodeStackHash160(item).toLowerCase();
  if (!HASH.test(hash)) throw new Error('Invalid account script hash.');
  return hash;
}
export function decodePendingUpdate(item) {
  if (item?.type === 'Any' && item.value == null) return { exists: false, full: true };
  if (item?.type !== 'Array' || !Array.isArray(item.value) || item.value.length !== 4) throw new Error('Invalid pending update.');
  const [moduleItem, paramsItem, started, mature] = item.value;
  if (paramsItem?.type !== 'ByteString' || typeof paramsItem.value !== 'string') throw new Error('Invalid pending parameters.');
  const module = stackHash(moduleItem);
  const params = decodeStackByteStringHex(paramsItem);
  if (btoa(String.fromCharCode(...Uint8Array.from(params.match(/../g) || [], (pair) => parseInt(pair, 16)))) !== paramsItem.value) throw new Error('Invalid pending parameters.');
  const initiatedAt = integer(started, 'pending initiation time'), matureAt = integer(mature, 'pending maturity time');
  if (matureAt !== initiatedAt + 86400000) throw new Error('Invalid pending timelock.');
  return { exists: true, full: true, module, params, initiatedAt, matureAt };
}
export function supportedPendingRoles(contractState) {
  const methods = contractState?.manifest?.abi?.methods;
  if (!Array.isArray(methods)) throw new Error('Cannot verify the ordinary contract ABI.');
  return ['verifier', 'hook'].filter((role) => methods.some((method) =>
    method.name === `getPending${role === 'verifier' ? 'Verifier' : 'Hook'}Update`
    && method.safe === true && method.parameters?.length === 1 && method.parameters[0].type === 'Hash160'));
}
export async function readChainClock(send) {
  const count = await send('getblockcount', []);
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Invalid node block count.');
  const header = await send('getblockheader', [count - 1, true]);
  if (!header || header.index !== count - 1 || !Number.isSafeInteger(header.time) || header.time <= 0 || !/^(0x)?[0-9a-fA-F]{64}$/.test(header.hash || '')) throw new Error('Invalid node block timestamp.');
  return { height: header.index, hash: header.hash.toLowerCase(), time: header.time };
}
export async function readGovernanceSnapshot({ accountId, read, readClock, fullPendingRoles = [] }) {
  accountId = normalizeHash(accountId);
  const before = await readClock();
  const readItem = async (method) => {
    const response = await read(method, [{ type: 'Hash160', value: accountId }]);
    if (String(response?.state).toUpperCase() !== 'HALT' || response.stack?.length !== 1) throw new Error(`Cannot read ${method}.`);
    return response.stack[0];
  };
  const pending = async (role) => {
    const label = role === 'verifier' ? 'Verifier' : 'Hook';
    if (fullPendingRoles.includes(role)) return decodePendingUpdate(await readItem(`getPending${label}Update`));
    const [exists, time] = await Promise.all([readItem(`hasPending${label}Update`), readItem(`getPending${label}UpdateTime`)]);
    const present = boolean(exists), matureAt = integer(time, 'pending maturity time');
    if (present !== (matureAt > 0)) throw new Error('Inconsistent pending update. Refresh state.');
    return present ? { exists: true, full: false, matureAt } : { exists: false, full: false };
  };
  const [verifier, hook, backupOwner, delay, triggered, active, escrow, pendingVerifier, pendingHook] = await Promise.all([
    readItem('getVerifier').then(stackHash), readItem('getHook').then(stackHash), readItem('getBackupOwner').then(stackHash),
    readItem('getEscapeTimelock').then((item) => integer(item, 'escape timelock')),
    readItem('getEscapeTriggeredAt').then((item) => integer(item, 'escape initiation time')),
    readItem('isEscapeActive').then(boolean), readItem('isMarketEscrowActive').then(boolean), pending('verifier'), pending('hook'),
  ]);
  const chain = await readClock();
  if (before.height !== chain.height || before.hash !== chain.hash) throw new Error('Node block changed while reading. Refresh state.');
  if (backupOwner === ZERO || active !== (triggered > 0)) throw new Error('Invalid account recovery state.');
  return { accountId, verifier, hook, backupOwner, escapeTimelock: delay, escapeTriggeredAt: triggered, escapeActive: active, marketEscrow: escrow, pendingVerifier, pendingHook, chain };
}
function paramsHex(value, allowEmpty = true) {
  const hex = String(value || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(hex) || (!allowEmpty && !hex)) throw new Error('Provide valid verifier initialization parameters.');
  return hex;
}
function snapshotIdentity(snapshot) {
  const { chain, loadedAt, ...state } = snapshot;
  return state;
}
export function buildGovernanceAction(snapshot, operation, options = {}) {
  if (!snapshot?.chain || !snapshot.accountId) throw new Error('Load current governance state first.');
  const args = [{ type: 'Hash160', value: snapshot.accountId }];
  const match = /^(confirm|cancel)(Verifier|Hook)Update$/.exec(operation);
  if (match) {
    const pending = snapshot[`pending${match[2]}`];
    if (!pending?.exists) throw new Error('No pending update. Refresh state.');
    if (match[1] === 'confirm') {
      if (!pending.full) throw new Error('The deployment cannot provide complete pending details; confirmation is unavailable.');
      if (snapshot.chain.time < pending.matureAt) throw new Error('The plugin timelock is not mature. Refresh node state after the deadline.');
    }
  } else if (operation === 'initiateEscape') {
    if (snapshot.escapeActive) throw new Error('Recovery is already active.');
  } else if (operation === 'finalizeEscape') {
    if (!snapshot.escapeActive) throw new Error('Recovery has not been initiated.');
    if (snapshot.chain.time < snapshot.escapeTriggeredAt + snapshot.escapeTimelock * 1000) throw new Error('The recovery timelock is not mature. Refresh node state after the deadline.');
    if (options.mode === 'backup-owner') args.push({ type: 'Hash160', value: ZERO }, { type: 'ByteArray', value: '0x' });
    else if (options.mode === 'verifier') {
      const verifier = normalizeHash(options.verifier);
      if (verifier === ZERO) throw new Error('Choose backup-owner mode to remove the verifier.');
      args.push({ type: 'Hash160', value: verifier }, { type: 'ByteArray', value: `0x${paramsHex(options.params, options.allowEmptyParams === true)}` });
    } else throw new Error('Choose a recovery authorization mode.');
  } else if (operation === 'updateVerifier' || operation === 'updateHook') {
    const role = operation === 'updateVerifier' ? 'Verifier' : 'Hook';
    if (snapshot[`pending${role}`].exists) throw new Error('Cancel or confirm the pending update first.');
    args.push({ type: 'Hash160', value: options.module ? normalizeHash(options.module) : ZERO });
    if (role === 'Verifier') args.push({ type: 'ByteArray', value: `0x${paramsHex(options.params)}` });
  } else throw new Error('Unsupported governance operation.');
  if (!operation.startsWith('cancel') && snapshot.marketEscrow) throw new Error('This account is in market escrow.');
  return JSON.parse(JSON.stringify({ operation, args, snapshot: snapshotIdentity(snapshot), options }));
}
export function assertGovernanceReviewCurrent(review, snapshot, wallet) {
  if (normalizeHash(wallet) !== snapshot.backupOwner) throw new Error('Connect the configured Neo backup owner.');
  if (JSON.stringify(snapshotIdentity(snapshot)) !== JSON.stringify(review.snapshot)) throw new Error('Governance state changed. Refresh and review again.');
  const current = buildGovernanceAction(snapshot, review.operation, review.options);
  if (JSON.stringify(current.args) !== JSON.stringify(review.args)) throw new Error('Governance request changed. Review again.');
}
