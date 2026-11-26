/**
 * SmartAccount v4.1 native-kernel client (docs/SA-SPEC.zh-CN.md §9).
 *
 * The ABI table below is the compiled v4.1 surface of
 * `contracts/native/SmartAccount/*` — the same 26 methods, parameter names,
 * return types and CallFlags the native core exposes, and it is checked against
 * the frozen IDL (`docs/proposals/smartaccount-v4.1.idl.json`) by
 * `scripts/check_smartaccount_v41_idl.py`.
 *
 * Removed v4.0 surfaces (`isValidSignature`, `setRecoveryPolicy`,
 * `getMessageSubjects`, `getThresholdPolicy`, the native recovery timelock
 * argument, the retired configuration action codes 4/6/8/9/10 and the
 * `executeUserOps` batch entry) are deliberately absent: discovering an ABI
 * that still exposes them must fail with an explicit
 * protocol-version-incompatible error, never be silently re-mapped onto a
 * different method or argument list.
 *
 * Every read validates the exact stack shape; every action builds one script
 * and hands it to the injected RPC transport. No ambient state, no coercion.
 */
import {
  NATIVE_SMART_ACCOUNT_CONTRACT,
  PROTOCOL_VERSION,
  NONCE_SUBKEY_BYTES,
} from "./nativeSmartAccount.mjs";

export {
  createProtocolCodec,
  NATIVE_SMART_ACCOUNT_CONTRACT,
  NATIVE_ABI_VERSION,
  PROTOCOL_VERSION,
} from "./nativeSmartAccount.mjs";

const ZERO = "00".repeat(20);
// ModuleProtocol.ActionUnfreeze: the single-action governance intent that thaws
// a frozen account. It must travel alone and the confirmation must repeat the
// exact bytes, so the confirm argument is rebuilt here, never taken as input.
const GOVERNANCE_UNFREEZE_ACTION = 11;
// GovernanceModule.UnfreezeAccount proposes the intent; ConfirmConfiguration lands it.
const GOVERNANCE_ACTIONS = ["unfreezeAccount", "confirmConfiguration"];
const error = (message) => {
  throw new Error(`Native SmartAccount: ${message}`);
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const I = (value) => ({ type: "Integer", value: String(value) });
const A = (value) => ({ type: "Array", value });
const parameters = (entries) => entries.map(([name, type]) => ({ name, type }));
const requiredMethod = (entries, returntype, safe) => [
  entries.map(([, type]) => type),
  returntype,
  safe,
  entries.map(([name]) => name),
];
const account = [["accountId", "Hash160"]];
const accountAction = requiredMethod(account, "Void", false);

// RPC monetary values use exact datoshi strings, never JSON numbers or GAS
// decimals.
export function parseNativeRpcFee(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) >= 1n << 63n
  )
    error(`${label} fee must be a canonical nonnegative Int64 decimal string`);
  return BigInt(value);
}
// Plain Neo: a transaction's declared system fee is its only gas limit and the
// node burns the whole declared amount, so the only value a simulation quotes
// is the gas its script consumed. There is no per-call budget and therefore no
// budget-derived minimum fee to add to it.
export function parseNativeRpcFees(result) {
  const gas = parseNativeRpcFee(result?.gasconsumed, "gasconsumed");
  return { gasConsumed: gas.toString() };
}

// SHA-256 of the domain-prefixed, canonical v4.1 parameters (including the
// configuration action set). `docs/proposals/validate-native-smartaccount-profile.py`
// recomputes this value from `smartaccount-native-profile-parameters.json` and
// fails if the core, this client or its frontend mirror disagree.
export const NATIVE_PROFILE_PARAMETER_DIGEST = "f9692d8cf7d74333b37142525de479f5742b1442aaf8baff64d883c4d16002f1";

// The standard recovery seat is a module: the NEF hash pins the reviewed build
// and the manifest hash pins the published ABI. A seat that answers a
// different pair is not the reviewed seat, so it is reported unsupported
// instead of being driven through an unknown interface.
export const NATIVE_STANDARD_RECOVERY_NEF_SHA256 = "70e94cd8d1aa55411ed7612ba3d50ec7262714c5f133aa5dbb8cc9782a285870";
export const NATIVE_STANDARD_RECOVERY_MANIFEST_SHA256 = "d3fa41dacde80d555637815fcb902ccd70a8292342ccfa81be048eed19f1f9f5";
// SHA-256 of the seat's getModuleProfile() text, as the core publishes it in
// the module descriptor (field 6).
export const NATIVE_STANDARD_RECOVERY_PROFILE_SHA256 = "64e4a614163968e6306083058044c6fad3c1c0c6a6e938737485f3325b9f13e3";

// Exactly the frozen v4.1 native surface: 26 methods including
// getAccountAddress, which lives in NATIVE_ACCOUNT_ADDRESS_ABI below.
export const NATIVE_REQUIRED_ABI = {
  verify: requiredMethod(account, "Boolean", true),
  getAccountImplementationId: requiredMethod([], "String", true),
  getProtocolInfo: requiredMethod([], "Array", true),
  getAccount: requiredMethod(account, "Array", true),
  // Registration takes (accountId, custody, salt, actions): the recovery
  // timelock moved into the recovery module's own policy, so the native
  // entry no longer carries it.
  createAccount: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["custody", "Hash160"],
      ["salt", "ByteArray"],
      ["actions", "Array"],
    ],
    "Void",
    false,
  ),
  createAccounts: requiredMethod(
    [
      ["accountIds", "Array"],
      ["custody", "Hash160"],
      ["salts", "Array"],
    ],
    "Void",
    false,
  ),
  applyConfigurationActions: requiredMethod([...account, ["actions", "Array"]], "Void", false),
  configureModule: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["moduleId", "Integer"],
      ["data", "Array"],
    ],
    "Void",
    false,
  ),
  freezeAccount: accountAction,
  // The core holds no thaw timelock: leaving Frozen is immediate, and any
  // delay a deployment wants is the policy of a user-space governance module.
  unfreezeAccount: accountAction,
  // Both module-administration entry points are custody-or-installed-validator
  // authorized and answer from the core registry, so nothing above them pins a
  // module profile digest.
  installModule: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["moduleType", "Integer"],
      ["moduleContractHash", "Hash160"],
      ["initData", "Array"],
    ],
    "Integer",
    false,
  ),
  removeModule: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["moduleId", "Integer"],
      ["deInitData", "Array"],
    ],
    "Void",
    false,
  ),
  // The two built-in switches change only through this write (or the recovery
  // reset); the core's last-route guard refuses to close the operation switch
  // while no validator instance is installed.
  setBuiltinAuthorization: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["defaultOperationAuthorization", "Boolean"],
      ["defaultMessageAuthorization", "Boolean"],
    ],
    "Void",
    false,
  ),
  revokeModuleCredentials: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["moduleId", "Integer"],
    ],
    "Void",
    false,
  ),
  // The recovery seat's exclusive landing: the core re-checks that the caller
  // is the installed, code-bound seat and removes every module instance in the
  // same frame.
  resetAccount: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["newCustody", "Hash160"],
    ],
    "Void",
    false,
  ),
  getNonce: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["validatorId", "Integer"],
      ["nonceSubkey", "ByteArray"],
    ],
    "Integer",
    true,
  ),
  getNonceSequence: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["channel", "Integer"],
    ],
    "Integer",
    true,
  ),
  getOperationDigest: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["operation", "Array"],
    ],
    "ByteArray",
    true,
  ),
  validateUserOp: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["operation", "Array"],
    ],
    "Array",
    true,
  ),
  // Threshold members are module instances now, so the core exposes a
  // member-level check instead of a native threshold policy read.
  validateMember: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["memberId", "Integer"],
      ["operationDigest", "ByteArray"],
      ["operation", "Array"],
    ],
    "Boolean",
    true,
  ),
  executeUserOp: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["operation", "Array"],
    ],
    "Any",
    false,
  ),
  getModules: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["moduleType", "String"],
      ["cursor", "Integer"],
      ["limit", "Integer"],
    ],
    "Array",
    true,
  ),
  getModule: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["moduleId", "Integer"],
    ],
    "Array",
    true,
  ),
  isModuleInstalled: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["moduleType", "String"],
      ["moduleHash", "Hash160"],
      ["additionalContext", "ByteArray"],
    ],
    "Boolean",
    true,
  ),
  getAuthorizedModuleId: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["phase", "Integer"],
    ],
    "Integer",
    true,
  ),
};
freeze(NATIVE_REQUIRED_ABI);

// §9 asks the core for the asset-holding script hash of an account as
// `getAccountAddress`. That name is native-only, so it is pinned here rather
// than in the shared gate; the names every entry point shares live above.
export const NATIVE_ACCOUNT_ADDRESS_ABI = {
  getAccountAddress: requiredMethod(account, "Hash160", true),
};
freeze(NATIVE_ACCOUNT_ADDRESS_ABI);

// Presence-only event gate: the client never decodes these payloads, so the
// parameter names are not pinned (renaming a parameter is not an ABI break for
// a byte-positional event), while a missing lifecycle event still fails.
// The core emits registration, freeze/unfreeze, operation execution, the module
// instance lifecycle, nonce channels and the three remaining landing-path
// transitions (credential revocation, the built-in authorization switches, the
// recovery reset) plus the required-validator selection. Intent, message,
// hook-order and recovery-policy transitions are user-space module concerns and
// are deliberately absent.
export const NATIVE_REQUIRED_EVENTS = Object.freeze([
  "AccountRegistered",
  "ModuleInstalled",
  "ModuleRemoved",
  "UserOpExecuted",
  "ModuleInstanceInstalled",
  "ModuleInstanceRemoved",
  "NonceChannelOpened",
  "NonceChannelExhausted",
  "AccountFrozen",
  "AccountUnfrozen",
  "ModuleCredentialsRevoked",
  "AccountReset",
  "BuiltinAuthorizationSet",
  "ModuleInstanceConfigured",
  "RequiredValidatorSet",
]);

// The native core declares a serialized operation as `Array`, which is exactly
// what the client builds, so a parameter type must match the gate exactly.
function declaredType(expected, actual) {
  return actual === expected;
}
function matchesParameters(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every(
      (parameter, index) =>
        actual[index]?.name === parameter.name &&
        declaredType(parameter.type, actual[index]?.type),
    )
  );
}
function descriptors(value, label) {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.name !== "string",
    )
  )
    error(`native ABI ${label} missing or malformed`);
  return value;
}

// executeUserOp returns one snapshotted Any: there is no batch result array in
// v4.1, so the single result is the whole verdict. RPC truncation is not
// execution evidence.
export function validateNativeInvocationResult(plan, stack) {
  if (!Array.isArray(stack)) error("malformed RPC result stack");
  if (plan.kind === "execution" && stack.length !== 1)
    error("execution result stack must contain exactly one item");
  const pending = [...stack];
  const compounds = new WeakSet();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || Array.isArray(item))
      error("malformed RPC result stack item");
    const value = item.value;
    switch (item.type) {
      case "Any":
        if (value !== null && value !== undefined)
          error("malformed null result");
        break;
      case "Boolean":
        if (typeof value !== "boolean") error("malformed Boolean result");
        break;
      case "Integer": {
        if (
          typeof value !== "string" ||
          value.length > 78 ||
          !/^(?:0|-?[1-9][0-9]*)$/.test(value)
        )
          error("malformed Integer result");
        const integer = BigInt(value);
        if (integer < -(1n << 255n) || integer >= 1n << 255n)
          error("Integer result exceeds VM range");
        break;
      }
      case "ByteString":
      case "Buffer":
        if (
          typeof value !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            value,
          ) ||
          btoa(atob(value)) !== value
        )
          error("malformed byte result");
        break;
      case "Array":
      case "Struct":
      case "Map":
        if (!Array.isArray(value) || compounds.has(item))
          error("malformed compound result");
        compounds.add(item);
        if (item.type === "Map") {
          for (const entry of value) {
            if (
              !entry ||
              !["Boolean", "Integer", "ByteString"].includes(entry.key?.type)
            )
              error("malformed Map result key");
            pending.push(entry.key, entry.value);
          }
        } else pending.push(...value);
        break;
      default:
        error(`unsupported RPC result stack type ${item.type}`);
    }
  }
  if (plan.kind !== "execution") {
    if (stack.length !== 1) error("account method result stack must contain exactly one item");
    const item = stack[0];
    if (plan.kind === "account" && plan.method === "installModule") {
      if (item.type !== "Integer" || BigInt(item.value) < 1n || BigInt(item.value) >= 0xffffffffffffffffn)
        error("installModule must return an allocated module ID");
    } else if (plan.kind === "recovery" && plan.method === "beginRecovery") {
      if (item.type !== "Integer" || BigInt(item.value) < 1n)
        error("beginRecovery must return a positive nonce");
    } else if (plan.kind === "governance" && plan.method === "unfreezeAccount") {
      if (item.type !== "Integer" || BigInt(item.value) < 1n)
        error("the governance unfreeze proposal must return a positive intent id");
    } else if (item.type !== "Any") {
      error("void account method must return the VM null item");
    }
    return [];
  }
  const operation = plan.operation;
  if (!operation || typeof operation !== "object" || typeof operation.method !== "string")
    error("execution plan must carry exactly one operation");
  return operation.method === "transfer" &&
    !(stack[0].type === "Boolean" && stack[0].value === true)
    ? [0]
    : [];
}

export function validateNativeApplicationExecution(plan, execution) {
  if (execution?.vmstate !== "HALT")
    error(`No successful Application result: ${execution?.vmstate ?? "unknown"}`);
  if (execution.exception != null)
    error("Application reported both HALT and an exception");
  return validateNativeInvocationResult(plan, execution.stack);
}

// The implementation id is the one identity the ABI cannot express, so the
// launch pins it: a core that answers a different id is not the build this
// client was reviewed against, even at the same script hash.
const IMPLEMENTATION_ID = "NativeSmartAccount";

export function createNativeClientClass(codec, {
  // Defaults for one kernel build. They are identity, not configuration: the
  // native core always answers at its fixed hash, so this is only overridden by
  // a test or a local chain harness that registers the core elsewhere.
  contractHash = NATIVE_SMART_ACCOUNT_CONTRACT,
  // The native core's proxy script calls verify(accountId) with
  // CallFlags.ReadOnly (PUSH5). The flag is never inferred from the codec
  // default: the proxy address must be the one the submitting core derives
  // (spec §16.1).
  callFlags = 5,
} = {}) {
  const DEFAULT_CONTRACT = codec.hex(contractHash, 20);
  const DEFAULT_CALL_FLAGS = codec.unsigned(callFlags, 8, "proxy call flags");
  const proxyOf = (accountId, coreHash, coreFlags) =>
    codec.accountAddress(accountId, {
      coreContractHash: coreHash,
      callFlags: coreFlags,
    });
  const H = codec.hashValue;
  /// RecoveryModule timelock domain (RecoveryModule.cs / the standard seat's
  /// policy), used only to validate a policy an operator asks the module to
  /// store. The native core no longer persists a timelock.
  const RECOVERY_TIMELOCK_MIN_MS = 604800000n;
  const RECOVERY_TIMELOCK_MAX_MS = 7776000000n;
  const recoveryTimelock = (value) => {
    const delay = codec.unsigned(value, 64, "recovery timelock");
    if (delay < RECOVERY_TIMELOCK_MIN_MS || delay > RECOVERY_TIMELOCK_MAX_MS)
      error("recovery timelock must be 7 to 90 days in milliseconds");
    return delay;
  };
  // §8: message verification is a module entry, not a native one. The name is
  // held here so the native ABI guard does not mistake it for a core method.
  const MESSAGE_VERIFY_METHOD = "isValidSignature";
  const MODULE_TYPES = Object.freeze({ validator: 1, hook: 4, recovery: 5 });
  const moduleTypeCode = (value) => {
    if (typeof value === "string") {
      if (!Object.hasOwn(MODULE_TYPES, value)) error("unsupported module type");
      return MODULE_TYPES[value];
    }
    const code = Number(codec.unsigned(value, 8, "module type"));
    if (![1, 4, 5].includes(code)) error("unsupported module type");
    return code;
  };
  // The module operands of ApplyModuleActionAsync, shared by the configuration
  // batch and by the registration actions so both paths emit the same Arrays:
  //   install   [1, moduleType, contractHash, profileDigest, initData[]]
  //   uninstall [2, moduleId, deInitData[]]
  //   configure [3, moduleId, data[]]
  //   authorize [5, defaultOperationAuthorization, defaultMessageAuthorization]
  //   required  [7, validatorId, required]
  // Codes 4, 6, 8, 9 and 10 are retired in v4.1 and are rejected here.
  const moduleData = (values = []) => {
    if (!Array.isArray(values) || values.length > 64) error("invalid module data");
    return A(values.map((value) => codec.canonicalValue(value)));
  };
  const installOperand = (moduleType, moduleContractHash, profileDigest, initData) => {
    const type = moduleTypeCode(moduleType);
    const contract = codec.hex(moduleContractHash, 20);
    if (contract === ZERO) error("invalid module address");
    return A([I(1), I(type), H(contract),
      codec.byteStringValue(codec.hex(profileDigest, 32)), moduleData(initData)]);
  };
  const uninstallOperand = (moduleId, deInitData) => {
    const id = codec.unsigned(moduleId, 64, "module ID");
    if (id === 0n) error("invalid module ID");
    return A([I(2), I(id), moduleData(deInitData)]);
  };
  const configureOperand = (moduleId, data) => {
    const id = codec.unsigned(moduleId, 64, "module ID");
    if (id === 0n) error("invalid module ID");
    return A([I(3), I(id), moduleData(data)]);
  };
  const bool = (value, label) => {
    if (typeof value !== "boolean") error(`${label} must be boolean`);
    return { type: "Boolean", value };
  };
  /// §10 registration actions: v4.1 CreateAccountCoreAsync admits install (1)
  /// only, each a typed VM Array, and the kernel checks every entry before
  /// writing anything. The fields are re-encoded through the configuration
  /// encoders, so a malformed action fails here instead of as
  /// SA_OPERATION_MALFORMED on chain.
  function registrationActions(actions) {
    if (!Array.isArray(actions) || actions.length > 16)
      error("registration accepts at most 16 actions");
    const field = (action, index, type, label) => {
      if (action[index]?.type !== type)
        error(`registration action field ${index} (${label}) must be a typed VM ${type}`);
      return action[index].value;
    };
    const unsignedField = (action, index, label) =>
      codec.unsigned(field(action, index, "Integer", label), 64, label);
    return actions.map((action) => {
      if (action?.type !== "Array" || !Array.isArray(action.value))
        error("registration actions must be typed VM Arrays");
      const fields = action.value;
      switch (unsignedField(fields, 0, "action code")) {
        case 1n:
          if (fields.length !== 5)
            error("install action must hold [1, moduleType, contractHash, profileDigest, initData]");
          return installOperand(
            Number(unsignedField(fields, 1, "module type")),
            field(fields, 2, "ByteString", "module address"),
            field(fields, 3, "ByteString", "profile digest"),
            field(fields, 4, "Array", "init data"));
        default:
          return error(
            "v4.1 registration only admits install (1) actions; uninstall, configure, authorize and required-validator actions are administered afterwards",
          );
      }
    });
  }
  function configurationBatch(coreHash, { accountId, actions }) {
    const id = codec.hex(accountId, 20);
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16)
      error("configuration batch must contain 1 to 16 actions");
    const operands = Array.from(actions, (step) => {
      switch (step?.method) {
        case "installModule":
          return installOperand(step.moduleType, step.moduleContractHash, step.profileDigest, step.initData);
        case "removeModule":
          return uninstallOperand(step.moduleId, step.deInitData);
        case "configureModule":
          return configureOperand(step.moduleId, step.data);
        case "setBuiltinAuthorization":
          return A([I(5), bool(step.defaultOperationAuthorization, "operation authorization"),
            bool(step.defaultMessageAuthorization, "message authorization")]);
        case "setRequiredValidator": {
          const validatorId = codec.unsigned(step.validatorId ?? 0, 64, "required validator id");
          return A([I(7), I(validatorId), bool(step.required !== false, "required flag")]);
        }
        default:
          return error(
            "unsupported configuration action: v4.1 acts with install, remove, configure, setBuiltinAuthorization and setRequiredValidator (1, 2, 3, 5, 7) only",
          );
      }
    });
    const script = codec.dynamicCall(coreHash, "applyConfigurationActions", [H(id), A(operands)]);
    return { id, script };
  }

  const base64ToBytes = (text) =>
    Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  const bytesToBase64 = (value) => {
    let text = "";
    for (const byte of value) text += String.fromCharCode(byte);
    return btoa(text);
  };
  const toHex = (value) => codec.bytesToHex(value);
  function decode(item) {
    if (!item || typeof item !== "object")
      return error("malformed RPC stack item");
    if (item.type === "Any" && item.value == null) return null;
    if (item.type === "Integer") {
      if (typeof item.value !== "string")
        error("RPC Integer must be decimal text");
      return codec.integer(item.value);
    }
    if (item.type === "Boolean" && typeof item.value === "boolean")
      return item.value;
    if (item.type === "ByteString") {
      if (
        typeof item.value !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          item.value,
        )
      )
        error("malformed RPC base64 bytes");
      return base64ToBytes(item.value);
    }
    if (
      (item.type === "Array" || item.type === "Struct") &&
      Array.isArray(item.value)
    )
      return { type: item.type, value: item.value.map(decode) };
    return error(`unsupported RPC stack type ${item.type}`);
  }
  const array = (v, n, label) => {
    if (
      !v ||
      v.type !== "Array" ||
      !Array.isArray(v.value) ||
      (n !== undefined && v.value.length !== n)
    )
      error(`malformed ${label} Array`);
    return v.value;
  };
  const bytes = (v, n, label) => {
    if (!(v instanceof Uint8Array) || (n !== undefined && v.length !== n))
      error(`malformed ${label} bytes`);
    return v;
  };
  // UInt160 fields are stored little-endian, so a display address is the
  // reversed word. A SHA-256 record or query result is a ByteString and keeps
  // the order the hash function produced: reversing it would make every
  // chain/offline comparison disagree.
  const hash = (v, n = 20) =>
    toHex(new Uint8Array(bytes(v, n, "hash")).reverse());
  const digest = (v, n = 32) => toHex(bytes(v, n, "digest"));
  const uint = (v, bits, label) => {
    if (typeof v !== "bigint") error(`malformed ${label} Integer`);
    return codec.unsigned(v, bits, label).toString();
  };
  // The native kernel serializes a moduleId as its 8-byte big-endian word in
  // GetModule and as an Integer elsewhere; both are the same id.
  const moduleId = (v, label) => {
    if (typeof v === "bigint") return codec.unsigned(v, 64, label).toString();
    const raw = bytes(v, 8, label);
    return BigInt("0x" + toHex(raw)).toString();
  };
  /// GetAccount (SmartAccount.cs §9) answers exactly nine fields:
  /// [exists, status, custody, authorityEpoch, configurationNonce,
  ///  defaultOperationAuthorization, defaultMessageAuthorization,
  ///  requiredValidatorId, controlRevision].
  const accountDescriptor = (item, accountId, coreHash, coreFlags) => {
    if (item === null) return null;
    const a = array(item, 9, "account");
    const exists = a[0];
    if (typeof exists !== "boolean") error("malformed account existence flag");
    if (!exists) {
      if (a[2].length !== 20) error("malformed account");
      return null;
    }
    const custody = hash(a[2]);
    const address = proxyOf(codec.hex(accountId, 20), coreHash, coreFlags);
    if (custody === ZERO || custody === coreHash || custody === address)
      error("invalid custody identity");
    const status = Number(uint(a[1], 8, "account status"));
    if (![0, 1].includes(status)) error("unknown account status");
    const authorityEpoch = uint(a[3], 64, "authority epoch");
    const configurationNonce = uint(a[4], 64, "configuration nonce");
    // Registration starts at epoch 1 and configuration nonce 0.
    if (authorityEpoch === "0" || BigInt(authorityEpoch) > BigInt(configurationNonce) + 1n)
      error("invalid authority epoch for configuration nonce");
    const bool = (value, label) => {
      if (typeof value !== "boolean") error(`malformed ${label} flag`);
      return value;
    };
    return freeze({
      accountId: codec.hex(accountId, 20),
      accountAddress: address,
      exists: true,
      status,
      statusName: ["Active", "Frozen"][status],
      custodyAddress: custody,
      authorityEpoch,
      configurationNonce,
      defaultOperationAuthorization: bool(a[5], "operation authorization"),
      defaultMessageAuthorization: bool(a[6], "message authorization"),
      requiredValidatorId: uint(a[7], 64, "required validator id"),
      controlRevision: uint(a[8], 64, "control revision"),
    });
  };
  /// GetModule (SmartAccount.Modules.cs) answers exactly fifteen fields; the
  /// last three are the v4.1 composite-layer / governance / hook-planner flags
  /// that let a client classify an instance without trusting a profile string.
  const moduleDescriptor = (item, coreHash) => {
    const a = array(item, undefined, "module");
    if (a.length === 0) return null;
    if (a.length !== 15) error("malformed module descriptor");
    const contractHash = hash(a[2]);
    if (contractHash === ZERO || contractHash === coreHash)
      error("invalid module contract");
    const flag = (value, label) => {
      if (typeof value !== "boolean") error(`malformed module ${label} flag`);
      return value;
    };
    return freeze({
      moduleId: moduleId(a[0], "module id"),
      moduleType: Number(a[1]),
      contractHash,
      contractId: uint(a[3], 64, "contract id"),
      updateCounter: uint(a[4], 64, "update counter"),
      nefSha256: digest(a[5]),
      profileSha256: digest(a[6]),
      moduleRevision: uint(a[7], 64, "module revision"),
      credentialGeneration: uint(a[8], 64, "credential generation"),
      instanceIsolation: flag(a[9], "instance isolation"),
      messageCapability: flag(a[10], "message capability"),
      thresholdMemberEligible: flag(a[11], "threshold member eligible"),
      compositeLayer: flag(a[12], "composite layer"),
      governance: flag(a[13], "governance"),
      hookPlanner: flag(a[14], "hook planner"),
    });
  };

  return class NativeSmartAccountClient {
    constructor({ rpcUrl, rpcClient, networkMagic, contractHash, callFlags } = {}) {
      this.rpc = rpcClient;
      if (typeof this.rpc?.send !== "function")
        error("RPC transport must expose send(method,params)");
      const core = codec.hex(contractHash ?? DEFAULT_CONTRACT, 20);
      const flags = codec.unsigned(
        callFlags ?? DEFAULT_CALL_FLAGS,
        8,
        "proxy call flags",
      );
      if (flags !== 5n) error("proxy call flags must be ReadOnly (5)");
      Object.defineProperties(this, {
        networkMagic: {
          value: Number(
            codec.unsigned(networkMagic, 32, "expected network magic"),
          ),
          enumerable: true,
        },
        // Both values are part of the account address preimage.
        contractHash: { value: core, enumerable: true },
        callFlags: { value: Number(flags), enumerable: true },
      });
      this.profile = null;
      this._plans = new WeakSet();
    }

    /** The account proxy for this core and call-flag combination (§16.1). */
    proxyAddress(accountId) {
      return proxyOf(codec.hex(accountId, 20), this.contractHash, this.callFlags);
    }

    async _send(method, params) {
      return this.rpc.send(method, params);
    }

    async invokeScript(script, signers = []) {
      const result = await this._send("invokescript", [
        bytesToBase64(codec.bytes(script)),
        signers,
      ]);
      if (result?.state !== "HALT" || result.exception != null || !Array.isArray(result.stack))
        error(
          `script failed: ${result?.exception ?? result?.state ?? "invalid RPC result"}`,
        );
      return result;
    }

    async _read(method, args = [], contract) {
      const target = contract === undefined ? this.contractHash : contract;
      const script = codec.dynamicCall(target, method, args, 5);
      const result = await this.invokeScript(script);
      if (result.stack.length !== 1)
        error(`${method} must return exactly one stack item`);
      return decode(result.stack[0]);
    }

    async _readModule(contract, method, args) {
      if (codec.hex(contract, 20) === this.contractHash) error("a module read cannot target the core");
      return this._read(method, args, contract);
    }

    async discover() {
      if (this._discovery) return this._discovery;
      this.profile = null;
      const request = this._discover();
      this._discovery = request;
      try {
        return await request;
      } finally {
        if (this._discovery === request) this._discovery = null;
      }
    }

    async _discover() {
      const [version, state] = await Promise.all([
        this._send("getversion", []),
        this._send("getcontractstate", ["0x" + this.contractHash]),
      ]);
      if (version?.protocol?.network !== this.networkMagic)
        error("RPC network magic mismatch");
      if (
        !Number.isSafeInteger(state?.id) ||
        state.id >= 0 ||
        codec.hex(state?.hash, 20) !== this.contractHash ||
        state?.manifest?.name !== "SmartAccount"
      )
        error("SmartAccount contract is not available");
      // The profile is the protocol identity: a different ABI version or a
      // different parameter digest is a different protocol, reported as such
      // rather than degraded onto a best-effort subset of the surface.
      const declaredProfile = state.manifest.extra?.smartAccount;
      if (declaredProfile?.abiVersion !== PROTOCOL_VERSION ||
          declaredProfile.profileParameterDigest !== NATIVE_PROFILE_PARAMETER_DIGEST)
        error(
          "native contract protocol version is incompatible with this client: the chain exposes SmartAccount ABI version " +
            `${declaredProfile?.abiVersion ?? "unknown"} with profile ${
              declaredProfile?.profileParameterDigest ?? "unknown"
            }, this client speaks version ${PROTOCOL_VERSION} with profile ${NATIVE_PROFILE_PARAMETER_DIGEST}`,
        );
      const methods = descriptors(state.manifest.abi?.methods, "methods");
      const events = descriptors(state.manifest.abi?.events, "events");
      // A native contract registers with a negative id; the address query is
      // part of its surface, so the gate requires it too.
      const requiredAbi = { ...NATIVE_REQUIRED_ABI, ...NATIVE_ACCOUNT_ADDRESS_ABI };
      for (const [name, [types, returntype, safe, names]] of Object.entries(
        requiredAbi,
      )) {
        const matches = methods
          .filter((method) => method.name === name)
          .filter(
            (method) =>
              method.returntype === returntype &&
              method.safe === safe &&
              matchesParameters(
                method.parameters,
                parameters(types.map((type, index) => [names[index], type])),
              ),
          );
        if (matches.length !== 1)
          error(
            `native contract ABI is incompatible with the v4.1 surface: method ${name} is missing or has a different signature`,
          );
      }
      if (methods.length !== Object.keys(requiredAbi).length)
        error(
          `native contract ABI is incompatible with the v4.1 surface: expected ${Object.keys(requiredAbi).length} methods, found ${methods.length}`,
        );
      const eventNames = new Set(events.map((event) => event.name));
      for (const name of NATIVE_REQUIRED_EVENTS)
        if (!eventNames.has(name))
          error(`native contract ABI is incompatible with the v4.1 surface: event ${name} is missing`);
      if (events.length !== NATIVE_REQUIRED_EVENTS.length)
        error(
          `native contract ABI is incompatible with the v4.1 surface: expected ${NATIVE_REQUIRED_EVENTS.length} events, found ${events.length}`,
        );
      const [protocolVersion] = array(
        await this._read("getProtocolInfo"),
        1,
        "protocol info",
      );
      if (uint(protocolVersion, 64, "protocol version") !== String(PROTOCOL_VERSION))
        error("native contract protocol version is incompatible with this client");
      // The RPC returns a string as UTF8 bytes; `decode` keeps them as bytes so
      // a hash and a text are never confused. Decode here, once.
      const reported = new TextDecoder().decode(
        bytes(await this._read("getAccountImplementationId"), undefined, "implementation id"),
      );
      if (reported !== IMPLEMENTATION_ID)
        error(
          `native contract reports implementation id ${JSON.stringify(reported)}, expected ${JSON.stringify(IMPLEMENTATION_ID)}`,
        );
      const implementationId = reported;
      this.profile = freeze({
        contract: this.contractHash,
        networkMagic: this.networkMagic,
        protocolVersion: PROTOCOL_VERSION,
        profileParameterDigest: NATIVE_PROFILE_PARAMETER_DIGEST,
        implementationId,
      });
      return this.profile;
    }

    async _ready() {
      if (!this.profile) await this.discover();
    }

    deriveIdentity({ custodyAddress, salt }) {
      return codec.deriveIdentity({
        custodyAddress,
        salt,
        coreContractHash: this.contractHash,
        callFlags: this.callFlags,
      });
    }

    async getAccount(accountId) {
      await this._ready();
      return accountDescriptor(
        await this._read("getAccount", [H(accountId)]),
        accountId,
        this.contractHash,
        this.callFlags,
      );
    }

    /**
     * The script hash that holds an account's assets (§9). The kernel derives
     * it from the same fixed proxy verification script this client builds, so
     * the answer has to equal the locally derived address: a difference means
     * the core hash or the call flags are not the ones this core answers with.
     */
    async getAccountAddress(accountId) {
      await this._ready();
      const id = codec.hex(accountId, 20);
      const address = hash(await this._read("getAccountAddress", [H(id)]));
      if (address === ZERO) error("account id has no proxy address");
      const derived = proxyOf(id, this.contractHash, this.callFlags);
      if (address !== derived)
        error("core account address disagrees with the derived proxy address");
      return address;
    }

    async getProtocolInfo() {
      await this._ready();
      const info = array(await this._read("getProtocolInfo"), 1, "protocol info");
      return freeze({
        protocolVersion: uint(info[0], 64, "protocol version"),
        profileParameterDigest: NATIVE_PROFILE_PARAMETER_DIGEST,
      });
    }

    async getModules(accountId, moduleType, { cursor = 0, limit = 32 } = {}) {
      await this._ready();
      moduleTypeCode(moduleType);
      const page = array(
        await this._read("getModules", [
          H(accountId),
          codec.stringValue(moduleType),
          I(codec.unsigned(cursor, 64, "cursor")),
          I(codec.unsigned(limit, 8, "limit")),
        ]),
        3,
        "module page",
      );
      const ids = array(page[0], undefined, "module ids").map((id) =>
        uint(id, 64, "module id"),
      );
      return freeze({
        moduleIds: ids,
        nextCursor: uint(page[1], 64, "next cursor"),
        configurationNonce: uint(page[2], 64, "configuration nonce"),
      });
    }

    async getModule(accountId, moduleId_) {
      await this._ready();
      return moduleDescriptor(
        await this._read("getModule", [
          H(accountId),
          I(codec.unsigned(moduleId_, 64, "module id")),
        ]),
        this.contractHash,
      );
    }

    async isModuleInstalled(
      accountId,
      moduleType,
      moduleHash,
      additionalContext = "",
    ) {
      await this._ready();
      const reply = await this._read("isModuleInstalled", [
        H(accountId),
        codec.stringValue(moduleType),
        H(moduleHash),
        { type: "ByteString", value: codec.hex(additionalContext) },
      ]);
      if (typeof reply !== "boolean") error("malformed installed flag");
      return reply;
    }

    deriveNonceRouting(accountId, routing) {
      return codec.deriveNonceChannel(
        {
          networkMagic: this.networkMagic,
          coreContractHash: this.contractHash,
          accountId: codec.hex(accountId, 20),
        },
        routing,
      );
    }

    /** v4.1 uses generation 1 for custody and the installed instance's
     * current generation for every module route (validator and threshold
     * member alike); there is no native threshold record to consult. */
    async resolveCredentialGeneration(accountId, validatorId = 0) {
      await this._ready();
      const id = codec.unsigned(validatorId, 64, "validator id");
      if (id === 0n) {
        if (!await this.getAccount(accountId)) error("account is not registered");
        return "1";
      }
      const module = await this.getModule(accountId, id);
      if (module) return module.credentialGeneration;
      error("validator is not installed: " + id);
    }

    async getNonce(accountId, { authorityEpoch, validatorId = 0, credentialGeneration, nonceSubkey }) {
      if ((authorityEpoch === undefined) !== (credentialGeneration === undefined))
        error("nonce cross-check requires both credential generation and authority epoch");
      const derived = credentialGeneration === undefined ? undefined : this.deriveNonceRouting(accountId, {
        authorityEpoch, validatorId, credentialGeneration, nonceSubkey,
      });
      await this._ready();
      codec.hex(nonceSubkey, NONCE_SUBKEY_BYTES);
      const packed = await this._read("getNonce", [
        H(accountId),
        I(codec.unsigned(validatorId, 64, "validator id")),
        { type: "ByteString", value: codec.hex(nonceSubkey) },
      ]);
      if (typeof packed !== "bigint" || packed < 0n || packed >= 1n << 255n)
        error("malformed packed nonce");
      // The kernel resolves the routing generation internally (§6: built-in →
      // generation 1, installed module → its CredentialGeneration), so it is the
      // authority for the channel and this client never supplies a default. A
      // caller that passes a generation gets a cross-check: a mismatch means
      // the caller's view is stale, which the operation would hit as
      // ErrorCredentialStale, so it is refused here.
      const channel = (packed >> 64n).toString();
      if (derived !== undefined) {
        if (packed >> 64n !== BigInt(derived))
          error(
            "nonce channel does not match the derived namespace: the supplied " +
              "credential generation or authority epoch is stale",
          );
      }
      return freeze({
        packed: packed.toString(),
        channel,
        sequence: (packed & ((1n << 64n) - 1n)).toString(),
      });
    }

    async getNonceSequence(accountId, channel) {
      await this._ready();
      const sequence = await this._read("getNonceSequence", [
        H(accountId),
        I(codec.unsigned(channel, 191, "nonce channel")),
      ]);
      if (typeof sequence !== "bigint" || sequence < 0n || sequence > 1n << 64n)
        error("invalid nonce cursor");
      return sequence.toString();
    }

    async getOperationDigest(accountId, operation) {
      await this._ready();
      const chainDigest = digest(
        await this._read("getOperationDigest", [H(accountId), codec.operationValue(operation)]),
      );
      const local = codec.operationDigest(
        {
          networkMagic: this.networkMagic,
          coreContractHash: this.contractHash,
          accountId: codec.hex(accountId, 20),
        },
        operation,
      );
      if (chainDigest !== local) error("core digest disagrees with the local SmartAccount codec");
      return chainDigest;
    }

    async validateUserOp(accountId, operation) {
      await this._ready();
      // The preview answers [accepted, operationDigest]: the digest is the
      // §4.3 value the core computed for these exact fields, so a caller can
      // compare it with its own codec before signing.
      const reply = array(
        await this._read("validateUserOp", [H(accountId), codec.operationValue(operation)]),
        2,
        "validation result",
      );
      if (typeof reply[0] !== "boolean") error("malformed validation result");
      return freeze({
        accepted: reply[0],
        operationDigest: digest(reply[1]),
      });
    }

    /// §5 member validation: the core answers whether the module instance is
    /// an eligible active member for this exact operation digest. A threshold
    /// quorum is a user-space module policy; the core only answers per member.
    async validateMember(accountId, memberId, operationDigest, operation) {
      await this._ready();
      const reply = await this._read("validateMember", [
        H(accountId),
        I(codec.unsigned(memberId, 64, "member module id")),
        { type: "ByteString", value: codec.hex(operationDigest, 32) },
        codec.operationValue(operation),
      ]);
      if (typeof reply !== "boolean") error("malformed member validation result");
      return reply;
    }

    /// §10 registration: the account id is derived from custody+salt, so the
    /// caller cannot register an id it did not commit to.
    ///
    /// `actions`: at most 16 typed VM Arrays, install (1) only
    /// (`registrationActions`); the kernel checks every entry's shape before it
    /// writes anything, and this builder refuses the same inputs up front.
    /// The v4.1 signature is exactly (accountId, custody, salt, actions): the
    /// native recovery timelock argument is gone.
    buildCreateAccountScript({ custodyAddress, salt, actions = [] }) {
      const identity = this.deriveIdentity({ custodyAddress, salt });
      return freeze({
        kind: "registration",
        method: "createAccount",
        accountId: identity.accountId,
        accountAddress: identity.accountAddress,
        custodyAddress: codec.hex(custodyAddress, 20),
        verificationScript: identity.verificationScript,
        signers: [identity.accountAddress],
        script: codec.dynamicCall(this.contractHash, "createAccount", [
          H(identity.accountId),
          H(custodyAddress),
          { type: "ByteString", value: codec.hex(salt) },
          A(registrationActions(actions)),
        ]),
      });
    }

    /// Batch registration (CreateAccounts): 1..64 ids, one custody and the
    /// matching salts; the kernel recomputes every identity and refuses a
    /// mismatch, so this builder derives them locally first.
    buildCreateAccountsScript({ custodyAddress, salts }) {
      if (!Array.isArray(salts) || salts.length < 1 || salts.length > 64)
        error("batch registration accepts 1 to 64 salts");
      const saltHex = salts.map((salt) => codec.hex(salt));
      const identities = saltHex.map((salt) => this.deriveIdentity({ custodyAddress, salt }));
      const script = codec.dynamicCall(this.contractHash, "createAccounts", [
        A(identities.map((entry) => H(entry.accountId))),
        H(custodyAddress),
        A(saltHex.map((salt) => ({ type: "ByteString", value: salt }))),
      ]);
      return freeze({
        kind: "registration",
        method: "createAccounts",
        accountId: identities[0].accountId,
        accountAddress: identities[0].accountAddress,
        custodyAddress: codec.hex(custodyAddress, 20),
        accountIds: identities.map((entry) => entry.accountId),
        accountAddresses: identities.map((entry) => entry.accountAddress),
        signers: [identities[0].accountAddress],
        script,
      });
    }

    /// One transaction executes exactly one complete 13-field operation. The
    /// retired batch entry has no replacement: an Array (even of length one) is
    /// refused as protocol-incompatible instead of being split into several
    /// transactions, and the operation is passed through whole so its digest,
    /// including hookProofs, is the one the core recomputes.
    buildExecutionScript({ accountId, operation, operations }) {
      if (Array.isArray(operation) || operations !== undefined)
        error(
          "protocol-incompatible: executeUserOps is retired in v4.1; buildExecutionScript takes one complete 13-field operation",
        );
      if (!operation || typeof operation !== "object")
        error("execution requires one complete 13-field operation");
      const identity = codec.hex(accountId, 20);
      const address = this.proxyAddress(identity);
      const script = codec.buildExecutionScript(identity, operation, {
        networkMagic: this.networkMagic,
        coreContractHash: this.contractHash,
        accountId: identity,
      });
      return freeze({
        kind: "execution",
        method: "executeUserOp",
        accountId: identity,
        accountAddress: address,
        proxyCallFlags: this.callFlags,
        operation,
        signers: [address],
        script,
      });
    }

    /// The recovery seat is a user-space module: no native recovery method is
    /// called. The reviewed standard seat is identified by its module profile
    /// digest, its NEF hash and the live contract identity, and its policy and
    /// request record are read from the module itself.
    async getRecoverySeat(accountId) {
      const id = codec.hex(accountId, 20);
      const page = await this.getModules(id, "recovery");
      if (!page.moduleIds.length) return null;
      if (page.moduleIds.length !== 1 || page.nextCursor !== "0") error("invalid recovery roster");
      const seat = await this.getModule(id, page.moduleIds[0]);
      if (!seat || seat.moduleType !== 5 || seat.moduleId !== page.moduleIds[0]) error("invalid recovery seat");
      // A third-party seat can have different operations and a different record layout.
      if (seat.profileSha256 !== NATIVE_STANDARD_RECOVERY_PROFILE_SHA256) return freeze({ seat, supported: false });
      if (seat.nefSha256 !== NATIVE_STANDARD_RECOVERY_NEF_SHA256) return freeze({ seat, supported: false });
      const live = await this._send("getcontractstate", ["0x" + seat.contractHash]);
      if (codec.hex(live?.hash, 20) !== seat.contractHash || String(live.id) !== seat.contractId ||
          String(live.updatecounter) !== seat.updateCounter) return freeze({ seat, supported: false });
      const core = hash(await this._readModule(seat.contractHash, "authorizedCore", []));
      if (core !== this.contractHash) return freeze({ seat, supported: false });
      const policy = array(
        await this._readModule(seat.contractHash, "getRecoveryPolicySnapshot", [H(id)]),
        undefined,
        "recovery policy",
      );
      const snapshot = policy.length === 0 ? null : freeze({
        guardians: array(policy[0], undefined, "recovery guardians").map((guardian) => hash(guardian)),
        threshold: Number(uint(policy[1], 8, "recovery threshold")),
        timelockMs: uint(policy[2], 64, "recovery timelock"),
        authority: hash(policy[3]),
        revision: uint(policy[4], 64, "recovery policy revision"),
        digest: digest(policy[5]),
      });
      if (snapshot && (snapshot.threshold < 1 || snapshot.threshold > snapshot.guardians.length))
        error("invalid recovery policy threshold");
      const result = array(
        await this._readModule(seat.contractHash, "getRecoveryStatus", [H(id)]),
        undefined,
        "recovery record",
      );
      let pending = null;
      if (result.length) {
        if (result.length !== 12) error("invalid recovery record");
        const status = uint(result[4], 8, "recovery status");
        if (!["0", "1", "2"].includes(status)) error("unknown recovery status");
        if (status === "1") pending = freeze({
          nonce: uint(result[0], 64, "recovery nonce"),
          initiator: hash(result[1]),
          startedAt: uint(result[2], 64, "recovery start"),
          executableAt: uint(result[3], 64, "recovery maturity"),
          status: 1,
          newCustody: hash(result[5]),
          authorityEpochAtInit: uint(result[6], 64, "recovery epoch"),
          configurationNonceAtInit: uint(result[7], 64, "recovery configuration nonce"),
          policyDigest: digest(result[8]),
          policyRevision: uint(result[9], 64, "recovery policy revision"),
        });
      }
      return freeze({ seat, supported: true, policy: snapshot, pending });
    }

    /// Governance is a *validator* instance that publishes the governance flag
    /// (moduleType 1, governance capability true). The configuration window and
    /// the pending intent set are the module's state: v4.1 has no native delay
    /// and no native intent queue, so nothing here reads the core for them.
    async getGovernanceSeat(accountId) {
      const id = codec.hex(accountId, 20);
      const page = await this.getModules(id, "validator");
      if (page.nextCursor !== "0") error("validator roster is paginated; refresh the module page first");
      const seats = [];
      for (const moduleId_ of page.moduleIds) {
        const module = await this.getModule(id, moduleId_);
        if (module?.governance) seats.push(module);
      }
      if (seats.length > 1) error("an account publishes at most one governance module");
      if (!seats.length)
        return freeze({ seat: null, supported: false, governanceDelayMs: null, intentIds: [], intents: [] });
      return this.readGovernanceSeat(seats[0], id);
    }

    /// The governance reads for an already-resolved descriptor. The roster is
    /// enumerated once by the caller, so a module tab does not re-read every
    /// validator descriptor to find the governance instance.
    async readGovernanceSeat(seat, accountId) {
      const id = codec.hex(accountId, 20);
      if (!seat?.governance)
        return freeze({ seat: seat ?? null, supported: false, governanceDelayMs: null, intentIds: [], intents: [] });
      // A governance instance answers for this core only; an unbound or
      // re-pointed instance is reported unsupported, never trusted.
      const core = hash(await this._readModule(seat.contractHash, "authorizedCore", []));
      if (core !== this.contractHash)
        return freeze({ seat, supported: false, governanceDelayMs: null, intentIds: [], intents: [] });
      const governanceDelayMs = uint(
        await this._readModule(seat.contractHash, "configurationMaturity", []), 64, "governance delay");
      const intentIds = array(
        await this._readModule(seat.contractHash, "getPendingConfigurationIntentIds", [H(id)]),
        undefined,
        "governance intent ids",
      ).map((item) => uint(item, 64, "governance intent id"));
      const intents = [];
      for (const intentId of intentIds) {
        const view = array(
          await this._readModule(seat.contractHash, "getPendingConfiguration", [H(id), I(intentId)]),
          undefined,
          "governance intent",
        );
        if (!view.length) continue;
        // getPendingConfiguration -> [id, kind, proposedAt, matureAt, expiresAt,
        // authorityEpoch, configurationNonce, digest, actionCount]. The kind is
        // the module's UTF-8 string ("configure" or "unfreeze"), not a number.
        if (view.length !== 9) error("invalid governance intent view");
        if (!(view[1] instanceof Uint8Array)) error("malformed intent kind");
        const kind = new TextDecoder().decode(view[1]);
        if (kind !== "configure" && kind !== "unfreeze") error("unknown governance intent kind");
        intents.push(freeze({
          intentId: uint(view[0], 64, "intent id"),
          kind,
          proposedAt: uint(view[2], 64, "intent proposedAt"),
          matureAt: uint(view[3], 64, "intent matureAt"),
          expiresAt: uint(view[4], 64, "intent expiresAt"),
          authorityEpoch: uint(view[5], 64, "intent authority epoch"),
          configurationNonce: uint(view[6], 64, "intent configuration nonce"),
          digest: digest(view[7]),
          actionCount: Number(uint(view[8], 8, "intent action count")),
        }));
      }
      return freeze({ seat, supported: true, governanceDelayMs, intentIds, intents });
    }

    /// The recovery seat's call, built from the reviewed target alone. Receipt
    /// restoration uses this: a request may already have executed, so nothing
    /// here may read account or seat state.
    buildRecoveryScript({ accountId, targetContract, action, newCustody }) {
      if (!["beginRecovery", "cancelRecovery", "executeRecovery"].includes(action))
        error("unsupported recovery operation");
      const id = codec.hex(accountId, 20);
      const target = codec.hex(targetContract, 20);
      if (target === this.contractHash) error("a recovery call cannot target the core");
      const args = [H(id)];
      if (action === "beginRecovery") args.push(H(codec.hex(newCustody ?? ZERO, 20)));
      return codec.dynamicCall(target, action, args);
    }

    async buildRecoveryModulePlan({ accountId, action, authority, newCustody }) {
      const id = codec.hex(accountId, 20);
      const state = await this.getAccount(id);
      if (!state) error("account is not registered");
      const route = await this.getRecoverySeat(id);
      if (!route?.supported) error("no supported recovery seat installed");
      if (!["beginRecovery", "cancelRecovery", "executeRecovery"].includes(action)) error("unsupported recovery operation");
      const { seat, policy, pending } = route;
      if (!policy) error("the recovery seat has no policy snapshot");
      const signers = [];
      // v4.1 module entry points take the account id alone; the module reads
      // its own record, so no nonce or configuration nonce is supplied.
      const args = [H(id)];
      if (action !== "executeRecovery") {
        const actor = codec.hex(authority ?? state.custodyAddress, 20);
        if (actor !== state.custodyAddress && actor !== policy.authority &&
            !policy.guardians.includes(actor))
          error("Only custody, the recovery authority or a guardian can start or cancel recovery.");
        signers.push(actor);
      }
      if (action === "beginRecovery") {
        if (pending) error("a recovery is already pending");
        const recipient = codec.hex(newCustody ?? ZERO, 20);
        if ([state.accountAddress, this.contractHash, seat.contractHash].includes(recipient))
          error("invalid new custody");
        if (recipient !== ZERO && !signers.includes(recipient)) signers.push(recipient);
        args.push(H(recipient));
      } else if (!pending) {
        error("no pending recovery");
      } else if (action === "executeRecovery") {
        if (pending.authorityEpochAtInit !== state.authorityEpoch) error("pending recovery epoch is stale");
        if (pending.configurationNonceAtInit !== state.configurationNonce)
          error("pending recovery configuration nonce is stale");
        const count = await this._send("getblockcount", []);
        if (!Number.isSafeInteger(count) || count < 1) error("invalid block height");
        const header = await this._send("getblockheader", [count - 1, true]);
        if (!Number.isSafeInteger(header?.time) || header.time < 0 || BigInt(header.time) < BigInt(pending.executableAt))
          error("the recovery timelock has not matured");
      }
      return freeze({ kind: "recovery", method: action, action, accountId: id, accountAddress: state.accountAddress,
        targetContract: seat.contractHash, moduleId: seat.moduleId, nefSha256: seat.nefSha256,
        governanceDelayMs: null, configurationNonce: state.configurationNonce, policy, pending, signers, args,
        newCustody: action === "beginRecovery" ? codec.hex(newCustody ?? ZERO, 20) : null,
        script: this.buildRecoveryScript({ accountId: id, targetContract: seat.contractHash, action, newCustody }) });
    }

    /// The governance seat's thaw call, built from the reviewed target alone.
    /// Receipt restoration uses this: a request may already have executed, so
    /// nothing here may read account or seat state.
    buildGovernanceScript({ accountId, targetContract, action, intentId }) {
      if (!GOVERNANCE_ACTIONS.includes(action)) error("unsupported governance operation");
      const id = codec.hex(accountId, 20);
      const target = codec.hex(targetContract, 20);
      if (target === this.contractHash) error("a governance call cannot target the core");
      const args = [H(id)];
      if (action === "confirmConfiguration")
        args.push(
          I(codec.unsigned(intentId, 64, "governance intent id")),
          // ConfirmConfiguration(accountId, intentId, actions) repeats the
          // proposal byte for byte: one action holding the bare code [11].
          A([A([I(GOVERNANCE_UNFREEZE_ACTION)])]),
        );
      return codec.dynamicCall(target, action, args);
    }

    /// One thaw, two custody-signed calls to the installed governance module.
    /// `unfreezeAccount` proposes the single-action intent; `confirmConfiguration`
    /// lands it once the module's delay has matured. The core's own
    /// `unfreezeAccount` admits only the bound governance module as its caller
    /// (SmartAccount.UnfreezeAccount), so no custody-signed core call can thaw.
    async buildGovernanceModulePlan({ accountId, action, intentId }) {
      const id = codec.hex(accountId, 20);
      if (!GOVERNANCE_ACTIONS.includes(action)) error("unsupported governance operation");
      const state = await this.getAccount(id);
      if (!state) error("account is not registered");
      const route = await this.getGovernanceSeat(id);
      if (!route?.supported) error("no supported governance module installed");
      const { seat, governanceDelayMs, intents } = route;
      const pending = intents.filter((intent) => intent.kind === "unfreeze");
      if (pending.length > 1) error("more than one unfreeze intent is pending");
      // Both module entries check the account's custody witness
      // (GovernanceModule.RequireCustody); no guardian or roster takes part.
      const signers = [state.custodyAddress];
      if (state.status !== 1) error("account is not frozen");
      let record = null;
      if (action === "unfreezeAccount") {
        if (pending.length) error("an unfreeze intent is already pending");
      } else {
        [record] = pending;
        if (!record) error("no pending unfreeze intent");
        if (record.actionCount !== 1) error("the pending unfreeze intent is not the single unfreeze action");
        if (String(record.intentId) !== String(codec.unsigned(intentId, 64, "governance intent id")))
          error("the pending unfreeze intent changed; review again");
        if (record.authorityEpoch !== state.authorityEpoch) error("pending unfreeze intent epoch is stale");
        if (record.configurationNonce !== state.configurationNonce)
          error("pending unfreeze intent configuration nonce is stale");
        // The module compares Runtime.Time with matureAt and expiresAt. The
        // header of the current block is the chain time a sent transaction lands after.
        const count = await this._send("getblockcount", []);
        if (!Number.isSafeInteger(count) || count < 1) error("invalid block height");
        const header = await this._send("getblockheader", [count - 1, true]);
        if (!Number.isSafeInteger(header?.time) || header.time < 0) error("invalid block time");
        if (BigInt(header.time) < BigInt(record.matureAt)) error("the governance delay has not matured");
        if (BigInt(header.time) > BigInt(record.expiresAt)) error("the pending unfreeze intent expired");
      }
      return freeze({ kind: "governance", method: action, action, accountId: id, accountAddress: state.accountAddress,
        targetContract: seat.contractHash, moduleId: seat.moduleId, nefSha256: seat.nefSha256,
        governanceDelayMs, configurationNonce: state.configurationNonce,
        intentId: record ? record.intentId : null, pending: record, signers,
        script: this.buildGovernanceScript({ accountId: id, targetContract: seat.contractHash, action,
          intentId: record?.intentId }) });
    }

    /// Canonical bytes for audit and historical receipts, independent of current account state.
    buildConfigurationBatchScript(input) {
      return configurationBatch(this.contractHash, input).script;
    }

    /** Direct custody administration. The kernel admits install/remove/
     * configure/setBuiltinAuthorization/setRequiredValidator (1, 2, 3, 5, 7);
     * actions 3 and 7 are governance-only on chain and are reported as such by
     * the caller, not silently dropped. */
    async buildConfigurationBatchPlan(input) {
      const { id, script } = configurationBatch(this.contractHash, input);
      const state = await this.getAccount(id);
      if (!state || state.status !== 0) error("account is not active");
      return freeze({ kind: "account", method: "applyConfigurationActions", accountId: id,
        accountAddress: state.accountAddress, configurationNonce: state.configurationNonce,
        governanceDelayMs: null, signers: [state.custodyAddress], script });
    }

    buildAccountActionScript({ method, accountId, args = [] }) {
      if (method === "applyConfigurationActions") error("use buildConfigurationBatchPlan to resolve the required signers");
      if (!Object.hasOwn(NATIVE_REQUIRED_ABI, method) || NATIVE_REQUIRED_ABI[method][2]) error(`unknown account action ${method}`);
      const id = codec.hex(accountId, 20);
      return freeze({
        kind: "account",
        method,
        accountId: id,
        accountAddress: this.proxyAddress(id),
        signers: [this.proxyAddress(id)],
        script: codec.dynamicCall(this.contractHash, method, [H(id), ...args]),
      });
    }

    /// §8 message signing is a module responsibility: the built-in native
    /// isValidSignature is retired. The client resolves an installed message
    /// -capable module instance (a SigningModule) and reads its public
    /// `isValidSignature` entry; it never routes message verification through
    /// the native core.
    async resolveMessageModule(accountId) {
      const id = codec.hex(accountId, 20);
      const page = await this.getModules(id, "validator");
      if (page.nextCursor !== "0") error("validator roster is paginated; refresh the module page first");
      for (const moduleId_ of page.moduleIds) {
        const module = await this.getModule(id, moduleId_);
        if (module?.messageCapability && module.instanceIsolation) return module;
      }
      return null;
    }

    buildMessageVerificationScript({ module, accountId, originalSender, validatorId, generation, hash: digestHex, pairs }) {
      if (!module?.contractHash || !module.messageCapability)
        error("an active message-capable module instance is required");
      if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 16)
        error("message verification requires 1 to 16 signature pairs");
      // SigningModule.IsValidSignature takes one flat object[] of alternating
      // script/signature ByteStrings (it walks the array with `i += 2`), so the
      // [script, signature] pairs are flattened here, never nested.
      const signaturePairs = [];
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2) error("signature pair must be [script, signature]");
        signaturePairs.push({ type: "ByteString", value: codec.hex(pair[0]) });
        signaturePairs.push({ type: "ByteString", value: codec.hex(pair[1]) });
      }
      return codec.dynamicCall(module.contractHash, MESSAGE_VERIFY_METHOD, [
        H(codec.hex(accountId, 20)),
        H(originalSender),
        I(codec.unsigned(validatorId, 64, "validator id")),
        I(codec.unsigned(generation, 64, "credential generation")),
        { type: "ByteString", value: codec.hex(digestHex, 32) },
        A(signaturePairs),
      ], 5);
    }

    async verifyMessage(input) {
      await this._ready();
      const module = input?.module ?? await this.resolveMessageModule(input.accountId);
      if (!module) error("no active message-capable signing module is installed on this account");
      const script = this.buildMessageVerificationScript({ ...input, module });
      const result = await this.invokeScript(script);
      if (result.stack.length !== 1) error("isValidSignature must return exactly one stack item");
      const accepted = decode(result.stack[0]);
      if (typeof accepted !== "boolean") error("malformed message signature result");
      return freeze({ accepted, moduleId: module.moduleId, contractHash: module.contractHash });
    }

    /**
     * Simulate a prepared plan. A failed simulation is reported, not thrown:
     * the review must be able to show why the plan is unusable. A HALT quotes
     * the gas the script consumed; that value is the system fee the transaction
     * declares.
     */
    async simulate(plan, signers = []) {
      if (!this._plans.has(plan)) error("unprepared plan");
      const result = await this._send("invokescript", [
        bytesToBase64(codec.bytes(plan.script)),
        signers,
      ]);
      if (result?.state === "HALT" && (result.exception != null || !Array.isArray(result.stack)))
        error("HALT simulation has an exception or a missing result stack");
      const halted = result?.state === "HALT";
      const fees = halted ? parseNativeRpcFees(result) : { gasConsumed: null };
      return freeze({
        state: result?.state ?? null,
        exception: result?.exception ?? null,
        stack: Array.isArray(result?.stack) ? result.stack : [],
        incompleteTransfers: halted
          ? validateNativeInvocationResult(plan, result.stack)
          : [],
        ...fees,
      });
    }

    async execute(plan, signers = []) {
      if (!this._plans.has(plan)) error("unprepared plan");
      const result = await this.invokeScript(plan.script, signers);
      // A HALT with a refused transfer is not an execution: the run moved
      // nothing and still spent the nonce and the fee. Reporting it as a
      // result would let a caller read OP_003 as success.
      const incomplete = validateNativeInvocationResult(plan, result.stack);
      if (incomplete.length)
        error(
          `a token transfer returned false at operation ${incomplete.join(", ")}; no tokens moved`,
        );
      return result;
    }

    prepare(plan) {
      if (!plan || typeof plan.script !== "string" || !Array.isArray(plan.signers))
        error("malformed plan");
      this._plans.add(plan);
      return plan;
    }

    async revalidatePlan(plan) {
      if (!this._plans.has(plan)) error("unprepared plan");
      if (plan.kind === "recovery") {
        const current = await this.buildRecoveryModulePlan({ accountId: plan.accountId, action: plan.action,
          authority: plan.signers[0], newCustody: plan.newCustody });
        if (JSON.stringify(current) !== JSON.stringify(plan)) error("recovery record or authority changed; review again");
        return true;
      }
      if (plan.kind === "governance") {
        const current = await this.buildGovernanceModulePlan({ accountId: plan.accountId, action: plan.action,
          intentId: plan.intentId });
        if (JSON.stringify(current) !== JSON.stringify(plan)) error("governance intent or account changed; review again");
        return true;
      }
      if (plan.method === "applyConfigurationActions") {
        const state = await this.getAccount(plan.accountId);
        if (!state || state.status !== 0 || state.configurationNonce !== plan.configurationNonce)
          error("account configuration changed; review the required signers again");
        return true;
      }
      if (plan.kind !== "execution") return true;
      const state = await this.getAccount(plan.accountId);
      if (!state || state.status !== 0)
        error("account is not active");
      return true;
    }
  };
}
