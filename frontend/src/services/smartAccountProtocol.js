/**
 * Neo Smart Account v4.1 protocol vocabulary for the frontend.
 *
 * The contracts decide the grammar (contracts/native/SmartAccount/*.cs); this
 * module is the one place the frontend spells it, so a screen never hand-rolls
 * an action array or invents an RPC method name. Every builder below mirrors a
 * documented in-VM layout:
 *
 * - registration:      createAccount(accountId, custody, salt, actions[])
 * - batch:             createAccounts(accountIds[], custody, salts[])
 * - configuration:     applyConfigurationActions(accountId, actions[])
 * - module actions:    every action is a positional array whose first element
 *                      is an ACTION_* code (spec §9 / SmartAccountModuleProtocol.cs).
 *
 * v4.1 keeps exactly five configuration action codes: install (1), remove (2),
 * configure (3), setBuiltinAuthorization (5) and setRequiredValidator (7). Codes
 * 4, 6, 8, 9 and 10 are retired: hook order is the HookOrchestratorModule's
 * state, the recovery policy is the RecoveryModule's, message subjects are the
 * SigningModule's and migration is not a core action. A retired code is refused
 * here instead of being encoded and rejected on chain.
 *
 * Read descriptors decode the documented v4.1 array layouts (getAccount is nine
 * fields, getModules is a three-field page and getModule is fifteen fields).
 * Anything else is refused rather than guessed: a screen that cannot prove a
 * layout must not render it as fact.
 */

import { EC } from '../config/errorCodes.js';
import { sanitizeHex } from '../utils/hex.js';
import {
  decodeStackByteStringHex,
  decodeStackHash160,
  hash160Param,
} from '../utils/stack.js';

/** Module type codes the core accepts at installation (SmartAccountModuleProtocol.cs). */
export const MODULE_TYPE = Object.freeze({ validator: 1, hook: 4, recovery: 5 });
export const MODULE_TYPE_NAME = Object.freeze({
  1: 'validator',
  4: 'hook',
  5: 'recovery',
});

/** Configuration action codes (SmartAccount.Models.cs, spec §9). */
export const ACTION = Object.freeze({
  installModule: 1,
  uninstallModule: 2,
  configureModule: 3,
  setBuiltinAuthorization: 5,
  setRequiredValidator: 7,
});

/** Codes 4, 6, 8, 9 and 10 no longer dispatch; keep them named for refusals. */
export const RETIRED_ACTION_CODES = Object.freeze([4, 6, 8, 9, 10]);

/** Account status codes returned by getAccount[1]. */
export const ACCOUNT_STATUS = Object.freeze({
  0: 'active',
  1: 'frozen',
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

function moduleTypeCode(moduleType) {
  const code = typeof moduleType === 'number'
    ? moduleType
    : MODULE_TYPE[String(moduleType || '').toLowerCase()];
  if (!Object.values(MODULE_TYPE).includes(code)) {
    fail('Unknown module type: expected validator (1), hook (4) or recovery (5)');
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

/** [5, defaultOperationAuthorization, defaultMessageAuthorization] */
export function setBuiltinAuthorizationAction({
  operationAuthorization = true,
  messageAuthorization = true,
} = {}) {
  return {
    type: 'Array',
    value: [
      integerValue(ACTION.setBuiltinAuthorization),
      boolValue(operationAuthorization),
      boolValue(messageAuthorization),
    ],
  };
}

/**
 * [7, validatorId, required] — the one module instance the core refuses to
 * operate without. Governance-only on chain, so the delay belongs to the
 * governance module, never to this builder.
 */
export function setRequiredValidatorAction({ validatorId = 0, required = true } = {}) {
  const id = Number(validatorId);
  if (!Number.isSafeInteger(id) || id < 0) fail('Invalid required validator id');
  if (typeof required !== 'boolean') fail('`required` must be a boolean');
  if (required && id === 0) fail('A required validator needs a nonzero module id');
  if (!required && id !== 0) fail('Clearing the required validator takes validator id 0');
  return {
    type: 'Array',
    value: [integerValue(ACTION.setRequiredValidator), integerValue(id), boolValue(required)],
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
 * identity the salt commits to, so a mismatch cannot be smuggled in. Exactly
 * four arguments — the native recovery-timelock argument is gone.
 */
export function planCreateAccount({ accountId, custodyAddress, salt, actions = [] }) {
  return plan('createAccount', [
    hashValue(accountId),
    hashValue(custodyAddress),
    bytesValue(salt),
    { type: 'Array', value: actions },
  ]);
}

/** Batch form: createAccounts(accountIds[], custody, salts[]). */
export function planCreateAccounts({ accountIds = [], custodyAddress, salts = [] }) {
  if (accountIds.length !== salts.length || accountIds.length < 1) {
    fail('createAccounts needs one account id per salt');
  }
  return plan('createAccounts', [
    hashArray(accountIds),
    hashValue(custodyAddress),
    { type: 'Array', value: salts.map((salt) => bytesValue(salt)) },
  ]);
}

/**
 * applyConfigurationActions(accountId, actions[1..16]). The core dispatches the
 * whole batch in one frame, so a caller cannot half-apply a configuration.
 */
export function planConfiguration({ accountId, actions = [] }) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16) {
    fail('A configuration batch needs 1 to 16 actions');
  }
  return plan('applyConfigurationActions', [
    hashValue(accountId),
    { type: 'Array', value: actions },
  ]);
}

/** Custody-authorised immediate account calls published by the v4.1 core. */
export function planAccountAction(method, accountId, args = []) {
  const supported = new Set([
    'freezeAccount',
    'unfreezeAccount',
    'revokeModuleCredentials',
    'resetAccount',
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
 * getAccount -> the nine-field v4.1 control descriptor:
 * [exists, status, custody, authorityEpoch, configurationNonce,
 *  defaultOperationAuthorization, defaultMessageAuthorization,
 *  requiredValidatorId, controlRevision].
 *
 * The core carries no recovery authority, timelock, hook order or escrow flag;
 * those are module state. `governanceDelayMs` is therefore reported as absent
 * rather than invented as a native promise, and the configuration nonce is the
 * revision a screen must re-read after a batch.
 */
export function decodeAccountDescriptor(item) {
  const fields = requireArray(item, 'the account descriptor');
  if (fields.length !== 9) fail('Cannot decode the account descriptor');
  return {
    exists: stackBool(fields[0]),
    status: ACCOUNT_STATUS[Number(stackInt(fields[1]))] || 'unknown',
    custody: decodeStackHash160(fields[2]),
    authorityEpoch: stackInt(fields[3]),
    configurationNonce: stackInt(fields[4]),
    defaultOperationAuthorization: stackBool(fields[5]),
    defaultMessageAuthorization: stackBool(fields[6]),
    requiredValidatorId: stackInt(fields[7]),
    controlRevision: stackInt(fields[8]),
    governanceDelayMs: null,
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
 * getModule -> 15-field instance descriptor, or [] when the id is not
 * installed: [moduleId, moduleType, contractHash, contractId, updateCounter,
 * nefSha256, profileSha256, moduleRevision, credentialGeneration,
 * instanceIsolation, messageCapability, thresholdMemberEligible,
 * compositeLayer, governance, hookPlanner].
 */
export function decodeModuleDescriptor(item) {
  const fields = requireArray(item, 'the module descriptor');
  if (fields.length === 0) return null;
  if (fields.length !== 15) fail('Cannot decode the module descriptor');
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
    compositeLayer: stackBool(fields[12]),
    governance: stackBool(fields[13]),
    hookPlanner: stackBool(fields[14]),
  };
}

/**
 * RecoveryModule.getRecoveryPolicySnapshot(accountId) -> [] when no policy is
 * configured, else [guardians[], threshold, timelockMs, authority, revision,
 * digest]. The recovery delay is the module's policy, not a native promise.
 */
export function decodeRecoveryPolicySnapshot(item) {
  const fields = requireArray(item, 'the recovery policy snapshot');
  if (fields.length === 0) return null;
  if (fields.length !== 6) fail('Cannot decode the recovery policy snapshot');
  return {
    guardians: requireArray(fields[0], 'the recovery guardians').map(decodeStackHash160),
    threshold: Number(stackInt(fields[1])),
    timelockMs: stackInt(fields[2]),
    authority: decodeStackHash160(fields[3]),
    revision: stackInt(fields[4]),
    digest: decodeStackByteStringHex(fields[5]),
  };
}

/** Encoders the screens share when a plan needs a raw value. */
export { integerValue, hashValue, bytesValue };
