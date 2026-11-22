/**
 * Neo Smart Account v4 protocol vocabulary for the frontend.
 *
 * The contracts decide the grammar (contracts/native/SmartAccount/*.cs); this
 * module is the one place the frontend spells it, so a screen never hand-rolls
 * an action array or invents an RPC method name. Every builder below mirrors a
 * documented in-VM layout:
 *
 * - account identity:  computeAccountIdentity(custody, salt)
 * - registration:      createAccount(accountId, custody, salt, recoveryTimelockMs, actions[])
 * - configuration:     proposeConfiguration(accountId, actions[], readSet[]) -> intentId,
 *                      confirmConfiguration(accountId, intentId, actions[]),
 *                      cancelConfiguration(accountId, intentId)
 * - module actions:    every action is a positional array whose first element
 *                      is an ACTION_* code (spec §9 / SmartAccountModuleProtocol.cs).
 *
 * Read descriptors decode the documented array layouts (getAccount,
 * getModules, getModule, getHookOrder, getPendingConfiguration,
 * getRecoveryStatus). Anything else is refused rather than guessed: a screen
 * that cannot prove a layout must not render it as fact.
 */

import { EC } from '../config/errorCodes.js';
import { sanitizeHex } from '../utils/hex.js';
import {
  decodeStackByteStringHex,
  decodeStackHash160,
  hash160Param,
} from '../utils/stack.js';

/**
 * Module type codes and their on-chain names (SmartAccount.ModuleProtocol.cs:
 * ModuleTypeCodeValidator = 1, ModuleTypeCodeHook = 4; only these two are
 * accepted by the core, so only they are ever encoded into an action).
 * The name map also names a 2-labelled descriptor as a hook: 2 is a legacy
 * alias, not a valid v4 installation code. The label predates the ERC-7579
 * numbering this frontend once wrote, and a live descriptor must never render
 * as 'unknown' just because it was read back from old state. Never encode 2
 * into an action or an installation request.
 */
export const MODULE_TYPE = Object.freeze({ validator: 1, hook: 4 });
/** @deprecated 2 is a legacy display-only alias; install with MODULE_TYPE. */
export const MODULE_TYPE_LEGACY_HOOK = 2;
export const MODULE_TYPE_NAME = Object.freeze({ 1: 'validator', 2: 'hook', 4: 'hook', 5: 'recovery' });

/** Configuration action codes (SmartAccount.Models.cs, spec §9). */
export const ACTION = Object.freeze({
  installModule: 1,
  uninstallModule: 2,
  configureModule: 3,
  setHookOrder: 4,
  setDefaultPolicy: 5,
  rebindModuleCode: 6,
  setThresholdPolicy: 7,
  setRecoveryPolicy: 8,
  setMessageSubjects: 9,
  migrateAccount: 10,
});

/** Account status codes returned by getAccount[1]. */
export const ACCOUNT_STATUS = Object.freeze({
  0: 'active',
  1: 'frozen',
  2: 'migrationRequired',
});

/** Called by every builder so a UI failure names the field, never the array. */
function fail(code) {
  throw new Error(code);
}

function integerValue(value, label = 'value') {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) fail(`Invalid ${label}`);
  return { type: 'Integer', value: text };
}

function boolValue(value) {
  return { type: 'Boolean', value: Boolean(value) };
}

function hashValue(value) {
  try {
    return { type: 'Hash160', value: hash160Param(value) };
  } catch (_) {
    return fail(EC.addressValidationFailed);
  }
}

function bytesValue(hex) {
  const normalized = sanitizeHex(hex || '');
  if (!/^(?:[0-9a-f]{2})*$/i.test(normalized)) fail(EC.invalidHexLength);
  return { type: 'ByteArray', value: `0x${normalized}` };
}

function hashArray(values = []) {
  return { type: 'Array', value: values.map(hashValue) };
}

function integerArray(values = []) {
  return { type: 'Array', value: values.map((value) => integerValue(value, 'module id')) };
}

function moduleTypeCode(moduleType) {
  const code = typeof moduleType === 'number'
    ? moduleType
    : MODULE_TYPE[String(moduleType || '').toLowerCase()];
  if (code !== MODULE_TYPE.validator && code !== MODULE_TYPE.hook) {
    fail('Unknown module type: expected validator or hook');
  }
  return code;
}

function digest32(value) {
  const hex = sanitizeHex(value || '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) fail('A module profile digest is 32 bytes of hex');
  return bytesValue(hex);
}

// ---------------------------------------------------------------------------
// Configuration actions (§9)
// ---------------------------------------------------------------------------

/** [1, type, contractHash, profileDigest32, initData[]] */
export function installModuleAction({ moduleType, moduleHash, profileDigest, initData = [] }) {
  return {
    type: 'Array',
    value: [
      integerValue(ACTION.installModule),
      integerValue(moduleTypeCode(moduleType)),
      hashValue(moduleHash),
      digest32(profileDigest),
      { type: 'Array', value: initData },
    ],
  };
}

/** [2, moduleId, deInitData[]] */
export function uninstallModuleAction(moduleId, deInitData = []) {
  return {
    type: 'Array',
    value: [
      integerValue(ACTION.uninstallModule),
      integerValue(moduleId, 'module id'),
      { type: 'Array', value: deInitData },
    ],
  };
}

/** [3, moduleId, configData[]] — the module's own configure(data) payload. */
export function configureModuleAction(moduleId, configData = []) {
  return {
    type: 'Array',
    value: [
      integerValue(ACTION.configureModule),
      integerValue(moduleId, 'module id'),
      { type: 'Array', value: configData },
    ],
  };
}

/** [4, hookIds[]] — the order hooks run in, core-owned. */
export function setHookOrderAction(hookIds = []) {
  return {
    type: 'Array',
    value: [integerValue(ACTION.setHookOrder), integerArray(hookIds)],
  };
}

/** [5, defaultOperationAuthorization, defaultMessageAuthorization] */
export function setDefaultPolicyAction({
  operationAuthorization = true,
  messageAuthorization = true,
} = {}) {
  return {
    type: 'Array',
    value: [
      integerValue(ACTION.setDefaultPolicy),
      boolValue(operationAuthorization),
      boolValue(messageAuthorization),
    ],
  };
}

/** [6, moduleId, profileDigest32] — rebind an installed instance to new code. */
export function rebindModuleCodeAction(moduleId, profileDigest) {
  return {
    type: 'Array',
    value: [
      integerValue(ACTION.rebindModuleCode),
      integerValue(moduleId, 'module id'),
      digest32(profileDigest),
    ],
  };
}

/** [7, policyId, threshold, memberIds[], active] — policyId 0 allocates a fresh id. */
export function setThresholdPolicyAction({
  policyId = 0,
  threshold,
  memberIds = [],
  active = true,
}) {
  const members = [...memberIds];
  if (active) {
    const limit = Number(threshold);
    if (!Number.isInteger(limit) || limit < 1 || limit > members.length) {
      fail('A threshold policy needs a threshold between 1 and its member count');
    }
    if (members.length < 1 || members.length > 10) {
      fail('A threshold policy needs 1 through 10 members');
    }
  } else if (members.length !== 0) {
    fail('A deactivated threshold policy carries no members');
  }
  return {
    type: 'Array',
    value: [
      integerValue(ACTION.setThresholdPolicy),
      integerValue(policyId, 'policy id'),
      integerValue(threshold, 'threshold'),
      integerArray(members),
      boolValue(active),
    ],
  };
}

/** [8, recoveryAuthority, timelockMs, ownerOnly] — ownerOnly is monotonic. */
export function setRecoveryPolicyAction({
  recoveryAuthority = '0x0000000000000000000000000000000000000000',
  timelockMs,
  ownerOnly = false,
}) {
  return {
    type: 'Array',
    value: [
      integerValue(ACTION.setRecoveryPolicy),
      hashValue(recoveryAuthority),
      integerValue(timelockMs, 'recovery timelock'),
      boolValue(ownerOnly),
    ],
  };
}

/** [9, subjects[], threshold] — subjects are 20-byte script hashes or 32-byte digests. */
export function setMessageSubjectsAction(subjects = [], threshold = 1) {
  const encoded = subjects.map((subject) => {
    const hex = sanitizeHex(subject || '');
    if (hex.length !== 40 && hex.length !== 64) {
      fail('A message subject is a 20-byte script hash or a 32-byte digest');
    }
    return bytesValue(hex);
  });
  if (encoded.length > 0 && (!Number.isInteger(Number(threshold)) || Number(threshold) < 1 || Number(threshold) > encoded.length)) {
    fail('A message-subject threshold is between 1 and the subject count');
  }
  return {
    type: 'Array',
    value: [
      integerValue(ACTION.setMessageSubjects),
      { type: 'Array', value: encoded },
      integerValue(threshold, 'subject threshold'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Plan builders (the intent a review shows and the wallet signs)
// ---------------------------------------------------------------------------

function plan(method, args, extra = {}) {
  return { operation: method, args, ...extra };
}

/**
 * Registration (§10). The account id is derived, never supplied: it is the
 * identity the salt commits to, so a mismatch cannot be smuggled in.
 */
export function planCreateAccount({
  accountId,
  custodyAddress,
  salt,
  recoveryTimelockMs = 0,
  actions = [],
}) {
  return plan('createAccount', [
    hashValue(accountId),
    hashValue(custodyAddress),
    bytesValue(salt),
    integerValue(recoveryTimelockMs, 'recovery timelock'),
    { type: 'Array', value: actions },
  ]);
}

/** Batch form: createAccounts(accountIds[], custody, salts[], recoveryTimelockMs). */
export function planCreateAccounts({ accountIds = [], custodyAddress, salts = [], recoveryTimelockMs = 0 }) {
  if (accountIds.length !== salts.length || accountIds.length < 1) {
    fail('createAccounts needs one account id per salt');
  }
  return plan('createAccounts', [
    hashArray(accountIds),
    hashValue(custodyAddress),
    { type: 'Array', value: salts.map((salt) => bytesValue(salt)) },
    integerValue(recoveryTimelockMs, 'recovery timelock'),
  ]);
}

/** proposeConfiguration(accountId, actions[], readSet[]) -> intentId */
export function planProposeConfiguration({ accountId, actions = [], readSet = [] }) {
  if (!Array.isArray(actions) || actions.length < 1) {
    fail('A configuration intent needs at least one action');
  }
  return plan('proposeConfiguration', [
    hashValue(accountId),
    { type: 'Array', value: actions },
    { type: 'Array', value: readSet },
  ]);
}

/** confirmConfiguration(accountId, intentId, actions[]) — the actions must match. */
export function planConfirmConfiguration({ accountId, intentId, actions = [] }) {
  return plan('confirmConfiguration', [
    hashValue(accountId),
    integerValue(intentId, 'intent id'),
    { type: 'Array', value: actions },
  ]);
}

/** cancelConfiguration(accountId, intentId) */
export function planCancelConfiguration({ accountId, intentId }) {
  return plan('cancelConfiguration', [
    hashValue(accountId),
    integerValue(intentId, 'intent id'),
  ]);
}

/** Custody-authorised account actions (freeze, recovery, credential revoke, metadata). */
export function planAccountAction(method, accountId, args = []) {
  const supported = new Set([
    'freezeAccount',
    'unfreezeAccount',
    'beginRecovery',
    'cancelRecovery',
    'executeRecovery',
    'revokeCredentials',
    'setMetadataUri',
  ]);
  if (!supported.has(method)) fail(`Unsupported account action: ${method}`);
  return plan(method, [hashValue(accountId), ...args]);
}

/** executeUserOp(accountId, operation) — the 13-field v4 operation. */
export function planExecuteUserOp({ accountId, operation }) {
  if (!operation || typeof operation !== 'object') fail('An operation is required');
  return plan('executeUserOp', [hashValue(accountId), operation]);
}

// ---------------------------------------------------------------------------
// Read descriptors
// ---------------------------------------------------------------------------

function stackInt(item) {
  if (item?.type === 'Integer') return String(item.value);
  if (item?.type === 'Boolean') return item.value ? '1' : '0';
  if (item?.type === 'ByteString') {
    const hex = decodeStackByteStringHex(item);
    if (!hex) return '0';
    // NeoVM serialises integer ByteStrings little-endian.
    const bigEndian = (hex.match(/../g) || []).reverse().join('');
    return BigInt(`0x${bigEndian || '0'}`).toString();
  }
  return '0';
}

function stackBool(item) {
  if (item?.type === 'Boolean') return item.value === true;
  if (item?.type === 'Integer') return Number(item.value) !== 0;
  if (item?.type === 'ByteString') {
    const hex = decodeStackByteStringHex(item);
    return hex !== '' && Number.parseInt(hex, 16) !== 0;
  }
  return false;
}

function requireArray(item, label) {
  if (item?.type !== 'Array' || !Array.isArray(item.value)) fail(`Cannot decode ${label}`);
  return item.value;
}

/**
 * getAccount -> the 16-field control descriptor:
 * [exists, status, custody, recoveryAuthority, authorityEpoch,
 *  configurationNonce, recoveryTimelockMs, defaultOperationAuthorization,
 *  defaultMessageAuthorization, ownerOnlyRecovery, hookOrderRevision,
 *  controlRevision, recoveryPending, recoveryMatureAt, marketEscrowActive,
 *  legacyRow]
 */
export function decodeAccountDescriptor(item) {
  const fields = requireArray(item, 'the account descriptor');
  if (fields.length !== 16) fail('Cannot decode the account descriptor');
  return {
    exists: stackBool(fields[0]),
    status: ACCOUNT_STATUS[Number(stackInt(fields[1]))] || 'unknown',
    custody: decodeStackHash160(fields[2]),
    recoveryAuthority: decodeStackHash160(fields[3]),
    authorityEpoch: stackInt(fields[4]),
    configurationNonce: stackInt(fields[5]),
    recoveryTimelockMs: stackInt(fields[6]),
    defaultOperationAuthorization: stackBool(fields[7]),
    defaultMessageAuthorization: stackBool(fields[8]),
    ownerOnlyRecovery: stackBool(fields[9]),
    hookOrderRevision: stackInt(fields[10]),
    controlRevision: stackInt(fields[11]),
    recoveryPending: stackBool(fields[12]),
    recoveryMatureAt: stackInt(fields[13]),
    marketEscrowActive: stackBool(fields[14]),
    legacyRow: stackBool(fields[15]),
  };
}

/**
 * getModules -> [ids[], nextCursor, configurationNonce]. nextCursor is 0 when
 * the page is exhausted; ids are never reused, so pages cannot alias.
 */
export function decodeModulePage(item) {
  const fields = requireArray(item, 'the module page');
  if (fields.length !== 3) fail('Cannot decode the module page');
  const ids = requireArray(fields[0], 'the module id page').map(stackInt);
  return {
    ids,
    nextCursor: stackInt(fields[1]),
    configurationNonce: stackInt(fields[2]),
  };
}

/**
 * getModule -> 12-field instance descriptor, or [] when the id is not
 * installed: [moduleId, moduleType, contractHash, contractId, updateCounter,
 * nefSha256, profileSha256, moduleRevision, credentialGeneration,
 * instanceIsolation, messageCapability, thresholdMemberEligible].
 */
export function decodeModuleDescriptor(item) {
  const fields = requireArray(item, 'the module descriptor');
  if (fields.length === 0) return null;
  if (fields.length !== 12) fail('Cannot decode the module descriptor');
  return {
    moduleId: stackInt(fields[0]),
    moduleType: MODULE_TYPE_NAME[Number(stackInt(fields[1]))] || 'unknown',
    contractHash: decodeStackHash160(fields[2]),
    contractId: stackInt(fields[3]),
    updateCounter: stackInt(fields[4]),
    nefSha256: decodeStackByteStringHex(fields[5]),
    profileSha256: decodeStackByteStringHex(fields[6]),
    moduleRevision: stackInt(fields[7]),
    credentialGeneration: stackInt(fields[8]),
    instanceIsolation: stackBool(fields[9]),
    messageCapability: stackBool(fields[10]),
    thresholdMemberEligible: stackBool(fields[11]),
  };
}

/** getHookOrder -> [hookIds[], revision]. */
export function decodeHookOrder(item) {
  const fields = requireArray(item, 'the hook order');
  if (fields.length !== 2) fail('Cannot decode the hook order');
  return {
    hookIds: requireArray(fields[0], 'the hook order ids').map(stackInt),
    revision: stackInt(fields[1]),
  };
}

/**
 * getPendingConfiguration -> [] when the id is unknown, else
 * [exists, intentId, proposedAt, matureAt, expiresAt, authorityEpoch,
 *  actionDigest, actions[]].
 */
export function decodePendingConfiguration(item) {
  const fields = requireArray(item, 'the pending configuration');
  if (fields.length === 0) return null;
  if (fields.length !== 8) fail('Cannot decode the pending configuration');
  return {
    intentId: stackInt(fields[1]),
    proposedAt: stackInt(fields[2]),
    matureAt: stackInt(fields[3]),
    expiresAt: stackInt(fields[4]),
    authorityEpoch: stackInt(fields[5]),
    actionDigest: decodeStackByteStringHex(fields[6]),
    actions: requireArray(fields[7], 'the pending configuration actions'),
  };
}

/**
 * getRecoveryStatus -> [] when no recovery is pending, else
 * [exists, initiatedAt, matureAt, authorityEpochAtInit, newCustody].
 */
export function decodeRecoveryStatus(item) {
  const fields = requireArray(item, 'the recovery status');
  if (fields.length === 0) return null;
  if (fields.length !== 5) fail('Cannot decode the recovery status');
  return {
    initiatedAt: stackInt(fields[1]),
    matureAt: stackInt(fields[2]),
    authorityEpochAtInit: stackInt(fields[3]),
    newCustody: decodeStackHash160(fields[4]),
  };
}

/** Encoders the screens share when a plan needs a raw value. */
export { integerValue, hashValue, bytesValue };
