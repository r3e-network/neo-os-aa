/**
 * SA module protocol v4 native-kernel client (docs/SA-MODULE-PROTOCOL.md §9).
 *
 * The ABI table below is the compiled v4 surface of
 * `contracts/native/SmartAccount/*` — the same names, parameters and return
 * types the native core exposes. Old `registerAccount` / `callVerifier` /
 * `callHook` / `*Child` / `proposeVerifier` surfaces are gone in v4 and are
 * deliberately absent here: a removed method must fail at discovery, never be
 * silently re-mapped.
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
export function parseNativeRpcFees(result, requireMinimum = false) {
  const gas = parseNativeRpcFee(result?.gasconsumed, "gasconsumed");
  const minimum =
    result?.minimumrequiredfee === undefined
      ? null
      : parseNativeRpcFee(result.minimumrequiredfee, "minimumrequiredfee");
  if (requireMinimum && minimum === null)
    error("minimumrequiredfee fee is required");
  if (minimum !== null && minimum < gas)
    error("minimumrequiredfee fee is below gasconsumed");
  return {
    gasConsumed: gas.toString(),
    minimumRequiredFee: minimum?.toString() ?? null,
  };
}

// SHA-256 of the domain-prefixed, canonical v4 parameters (including the batch action set).
export const NATIVE_PROFILE_PARAMETER_DIGEST = "0cab62cf2a69b5682bf0d976406ddce15d7afbd67db4c1bc4e4950cf180a6dd0";

// Exact NEF built from the standard recovery seat with the repository compiler.
export const NATIVE_STANDARD_RECOVERY_NEF_SHA256 = "8306ab8e1c5f0b13aafef2a25a9f02e0b587e5a07ad10cfb1e128a4c353d018e";

export const NATIVE_REQUIRED_ABI = {
  verify: requiredMethod(account, "Boolean", true),
  getAccountImplementationId: requiredMethod([], "String", true),
  getMessageSubjects: requiredMethod(account, "Array", true),
  getThresholdPolicy: requiredMethod([...account, ["policyId", "Integer"]], "Array", true),
  isValidSignature: requiredMethod([...account, ["hash", "ByteArray"], ["signatureEnvelope", "Array"]], "ByteArray", true),
  getProtocolInfo: requiredMethod([], "Array", true),
  getAccount: requiredMethod(account, "Array", true),
  createAccount: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["custody", "Hash160"],
      ["salt", "ByteArray"],
      ["recoveryTimelockMs", "Integer"],
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
      ["recoveryTimelockMs", "Integer"],
    ],
    "Void",
    false,
  ),
  applyConfigurationActions: requiredMethod([...account, ["actions", "Array"]], "Void", false),
  freezeAccount: accountAction,
  // The core holds no thaw timelock: leaving Frozen is immediate, and any
  // delay a deployment wants is the policy of a user-space governance module.
  unfreezeAccount: accountAction,
  // The two module-administration entry points of the minimal core. Both are
  // custody-or-installed-validator authorized and both answer from the core
  // registry, so nothing above them pins a module profile digest.
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
  // The four restricted landing entries (spec §7.1/§7.5/§12.5): three
  // configuration writes of the administration family — the recovery policy,
  // the built-in authorization switches and the credential-generation bump —
  // plus the recovery seat's exclusive reset. They carry no module data —
  // they land decisions the caller (the custody, an installed validator, or
  // the account's recovery seat) already made, and the core re-verifies the
  // authority and the domains itself.
  setRecoveryPolicy: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["recoveryAuthority", "Hash160"],
      ["recoveryTimelockMs", "Integer"],
      ["ownerOnlyRecovery", "Boolean"],
    ],
    "Void",
    false,
  ),
  // The two built-in switches change only through this write (or the
  // recovery reset); the core's last-route guard refuses to close the
  // operation switch while no validator instance is installed.
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
  executeUserOp: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["operation", "Array"],
    ],
    "Any",
    false,
  ),
  executeUserOps: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["operations", "Array"],
    ],
    "Array",
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
// The core emits registration, freeze/unfreeze,
// operation execution, the module instance lifecycle, nonce channels and the
// four landing-path transitions (credential revocation, the recovery-policy
// write, the built-in authorization switches, the recovery reset).
// Intent, message and hook-order transitions are user-space module concerns
// and are deliberately absent.
export const NATIVE_REQUIRED_EVENTS = Object.freeze([
  "AccountRegistered",
  "AccountFrozen",
  "AccountUnfrozen",
  "UserOpExecuted",
  "ModuleInstalled",
  "ModuleRemoved",
  "ModuleInstanceInstalled",
  "ModuleInstanceRemoved",
  "ModuleInstanceConfigured",
  "ModuleCredentialsRevoked",
  "RecoveryPolicySet",
  "BuiltinAuthorizationSet",
  "MessageSubjectUpdated",
  "ThresholdPolicySet",
  "AccountReset",
  "NonceChannelOpened",
  "NonceChannelExhausted",
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

// Core returns one snapshotted Any for executeUserOp, or one exact Array of
// those results for executeUserOps. RPC truncation is not execution evidence.
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
    } else if (item.type !== "Any") {
      error("void account method must return the VM null item");
    }
    return [];
  }
  const operations = plan.operations;
  const results = plan.batch ? stack[0].value : stack;
  if (
    plan.batch &&
    (stack[0].type !== "Array" || results.length !== operations.length)
  )
    error("batch result must be an exact Array matching the operation count");
  return operations.flatMap((operation, index) =>
    operation.method === "transfer" &&
    !(results[index]?.type === "Boolean" && results[index].value === true)
      ? [index]
      : [],
  );
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
  function recoveryPolicyFields({ recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery = false }) {
    const recipient = codec.hex(recoveryAuthority, 20);
    const delay = codec.unsigned(recoveryTimelockMs, 64, "recovery timelock");
    if (delay < 604800000n || delay > 7776000000n || ownerOnlyRecovery !== false)
      error("invalid recovery policy: ownerOnlyRecovery is reserved and must be false");
    return { recipient, fields: [H(recipient), I(delay), { type: "Boolean", value: ownerOnlyRecovery }] };
  }
  function configurationBatch(coreHash, { accountId, actions }) {
    const id = codec.hex(accountId, 20);
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16)
      error("configuration batch must contain 1 to 16 actions");
    const bool = (value) => {
      if (typeof value !== "boolean") error("configuration switch must be boolean");
      return { type: "Boolean", value };
    };
    const data = (values = []) => {
      if (!Array.isArray(values) || values.length > 64) error("invalid module data");
      return A(values.map((value) => codec.canonicalValue(value)));
    };
    // Copy the reviewed operands before the RPC yields. Never read a caller's mutable action
    // twice to build the script and determine which addresses must consent.
    const recipients = [];
    const operands = Array.from(actions, (step) => {
      switch (step?.method) {
        case "installModule": {
          if (![1, 4, 5].includes(step.moduleType)) error("unsupported module type");
          const contract = codec.hex(step.moduleContractHash, 20);
          if (contract === ZERO) error("invalid module address");
          return A([I(1), I(step.moduleType), H(contract),
            codec.byteStringValue(codec.hex(step.profileDigest, 32)), data(step.initData)]);
        }
        case "removeModule": {
          const moduleId = codec.unsigned(step.moduleId, 64, "module ID");
          if (moduleId === 0n) error("invalid module ID");
          return A([I(2), I(moduleId), data(step.deInitData)]);
        }
        case "setBuiltinAuthorization":
          return A([I(5), bool(step.defaultOperationAuthorization), bool(step.defaultMessageAuthorization)]);
        case "setRecoveryPolicy": {
          const { recipient, fields } = recoveryPolicyFields(step);
          recipients.push(recipient);
          return A([I(8), ...fields]);
        }
        default: return error("unsupported configuration batch action");
      }
    });
    const script = codec.dynamicCall(coreHash, "applyConfigurationActions", [H(id), A(operands)]);
    return { id, script, recipients };
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
  // some descriptors and as an Integer in others; both are the same id.
  const moduleId = (v, label) => {
    if (typeof v === "bigint") return codec.unsigned(v, 64, label).toString();
    const raw = bytes(v, 8, label);
    return BigInt("0x" + toHex(raw)).toString();
  };
  const accountDescriptor = (item, accountId, coreHash, coreFlags) => {
    if (item === null) return null;
    const a = array(item, 15, "account");
    const exists = a[0];
    if (typeof exists !== "boolean") error("malformed account existence flag");
    if (!exists) {
      if (a[2].length !== 20 || a[3].length !== 20) error("malformed account");
      return null;
    }
    const custody = hash(a[2]);
    const recovery = hash(a[3]);
    const address = proxyOf(codec.hex(accountId, 20), coreHash, coreFlags);
    if (custody === ZERO || custody === coreHash || custody === address)
      error("invalid custody identity");
    if (recovery !== ZERO && [custody, address, coreHash].includes(recovery))
      error("invalid recovery identity");
    const status = Number(uint(a[1], 8, "account status"));
    if (![0, 1].includes(status)) error("unknown account status");
    const authorityEpoch = uint(a[4], 64, "authority epoch");
    const configurationNonce = uint(a[5], 64, "configuration nonce");
    // Registration starts at epoch 1 and configuration nonce 0.
    if (authorityEpoch === "0" || BigInt(authorityEpoch) > BigInt(configurationNonce) + 1n)
      error("invalid authority epoch for configuration nonce");
    return freeze({
      accountId: codec.hex(accountId, 20),
      accountAddress: address,
      exists: true,
      status,
      statusName: ["Active", "Frozen"][status],
      custodyAddress: custody,
      recoveryAuthority: recovery,
      authorityEpoch,
      configurationNonce,
      recoveryTimelockMs: uint(a[6], 64, "recovery timelock"),
      defaultOperationAuthorization: a[7],
      defaultMessageAuthorization: a[8],
      ownerOnlyRecovery: a[9],
      hookOrderRevision: uint(a[10], 64, "hook order revision"),
      controlRevision: uint(a[11], 64, "control revision"),
      recoveryPending: a[12],
      recoveryMatureAt: uint(a[13], 64, "recovery maturity"),
      marketEscrowActive: a[14],
    });
  };
  const moduleDescriptor = (item, coreHash) => {
    const a = array(item, undefined, "module");
    if (a.length === 0) return null;
    if (a.length !== 12) error("malformed module descriptor");
    const contractHash = hash(a[2]);
    if (contractHash === ZERO || contractHash === coreHash)
      error("invalid module contract");
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
      instanceIsolation: a[9],
      messageCapability: a[10],
      thresholdMemberEligible: a[11],
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
      const declaredProfile = state.manifest.extra?.smartAccount;
      if (declaredProfile?.abiVersion !== PROTOCOL_VERSION ||
          declaredProfile.profileParameterDigest !== NATIVE_PROFILE_PARAMETER_DIGEST)
        error("native profile parameters do not match the current protocol");
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
        if (matches.length !== 1) error(`native ABI mismatch: ${name}`);
      }
      if (methods.length !== Object.keys(requiredAbi).length) error("unexpected native ABI method");
      const eventNames = new Set(events.map((event) => event.name));
      for (const name of NATIVE_REQUIRED_EVENTS)
        if (!eventNames.has(name)) error(`native ABI event mismatch: ${name}`);
      if (events.length !== NATIVE_REQUIRED_EVENTS.length) error("unexpected native ABI event");
      const [protocolVersion] = array(
        await this._read("getProtocolInfo"),
        1,
        "protocol info",
      );
      if (uint(protocolVersion, 64, "protocol version") !== String(PROTOCOL_VERSION))
        error("native contract is not running the current SmartAccount protocol");
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
      });
    }

    async getModules(accountId, moduleType, { cursor = 0, limit = 32 } = {}) {
      await this._ready();
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

    async getThresholdPolicy(accountId, policyId = 0) {
      await this._ready();
      const row = array(await this._read("getThresholdPolicy", [
        H(accountId), I(codec.unsigned(policyId, 64, "policy id")),
      ]), undefined, "threshold policy");
      if (!row.length) return null;
      const lookup = codec.unsigned(policyId, 64, "policy id");
      if (row.length !== (lookup === 0n ? 5 : 4) || typeof row[2] !== "boolean") error("malformed threshold policy");
      const required = lookup === 0n ? uint(row[4], 64, "required policy id") : lookup.toString();
      if (required === "0" || (lookup === 0n && !row[2])) error("malformed threshold policy");
      const members = array(row[1], undefined, "policy members").map(v => uint(v, 64, "member id"));
      const threshold = Number(uint(row[0], 8, "threshold"));
      const generation = uint(row[3], 64, "policy generation");
      if (generation === "0" || members.includes("0") || new Set(members).size !== members.length ||
          (row[2] ? threshold < 1 || threshold > members.length || members.length > 10 : threshold !== 0 || members.length !== 0))
        error("malformed threshold policy");
      return freeze({ policyId: required, threshold, memberIds: members, active: row[2], credentialGeneration: generation });
    }

    async getMessageSubjects(accountId) {
      await this._ready();
      const row = array(await this._read("getMessageSubjects", [H(accountId)]), undefined, "message subjects");
      if (!row.length) return null;
      if (row.length !== 3) error("malformed message subjects");
      const subjects = array(row[0], undefined, "subjects").map(v => {
        const raw = bytes(v, undefined, "script identity");
        if (raw.length !== 20 && raw.length !== 32) error("invalid script identity width");
        return toHex(raw);
      });
      const threshold = Number(uint(row[1], 8, "threshold"));
      const subjectRevision = uint(row[2], 64, "subject revision");
      if (subjectRevision === "0" || threshold < 1 || threshold > subjects.length || subjects.length > 16 ||
          new Set(subjects).size !== subjects.length) error("malformed message subjects");
      return freeze({ subjects, threshold, subjectRevision });
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

    /** Native v4 uses generation 1 for custody and the installed instance's
     * current generation for validator routes (ResolveCredentialGeneration). */
    async resolveCredentialGeneration(accountId, validatorId = 0) {
      await this._ready();
      const id = codec.unsigned(validatorId, 64, "validator id");
      if (id === 0n) {
        if (!await this.getAccount(accountId)) error("account is not registered");
        return "1";
      }
      const module = await this.getModule(accountId, id);
      if (module?.moduleType === 1) return module.credentialGeneration;
      if (!module) {
        const policy = await this.getThresholdPolicy(accountId, id);
        if (policy?.active) return policy.credentialGeneration;
      }
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
      // generation 1, installed validator → its CredentialGeneration), so it is the authority for the channel and this
      // client never supplies a default. A caller that passes a generation gets
      // a cross-check: a mismatch means the caller's view is stale, which the
      // operation would hit as ErrorCredentialStale, so it is refused here.
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

    /// §10 registration: the account id is derived from custody+salt, so the
    /// caller cannot register an id it did not commit to.
    buildCreateAccountScript({ custodyAddress, salt, recoveryTimelockMs = 0, actions = [] }) {
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
          I(codec.unsigned(recoveryTimelockMs, 64, "recovery timelock")),
          codec.canonicalValue({ type: "Array", value: actions }),
        ]),
      });
    }

    buildExecutionScript({ accountId, operations }) {
      if (!Array.isArray(operations) || !operations.length)
        error("execution requires at least one operation");
      const identity = codec.hex(accountId, 20);
      const address = this.proxyAddress(identity);
      const script = codec.buildExecutionScript(identity, operations, {
        networkMagic: this.networkMagic,
        coreContractHash: this.contractHash,
        accountId: identity,
      });
      return freeze({
        kind: "execution",
        method: operations.length === 1 ? "executeUserOp" : "executeUserOps",
        accountId: identity,
        accountAddress: address,
        proxyCallFlags: this.callFlags,
        batch: operations.length !== 1,
        operations,
        signers: [address],
        script,
      });
    }

    async getRecoverySeat(accountId) {
      const id = codec.hex(accountId, 20);
      const page = await this.getModules(id, "recovery");
      if (!page.moduleIds.length) return null;
      if (page.moduleIds.length !== 1 || page.nextCursor !== "0") error("invalid recovery roster");
      const seat = await this.getModule(id, page.moduleIds[0]);
      if (!seat || seat.moduleType !== 5 || seat.moduleId !== page.moduleIds[0]) error("invalid recovery seat");
      // A third-party seat can have different operations and a different record layout.
      if (seat.profileSha256 !== "9e3aa360fd7b9bc1d04d368140639e44985a07045f338a3036df3e0859e536e6") return freeze({ seat, supported: false });
      if (seat.nefSha256 !== NATIVE_STANDARD_RECOVERY_NEF_SHA256) return freeze({ seat, supported: false });
      const live = await this._send("getcontractstate", ["0x" + seat.contractHash]);
      if (codec.hex(live?.hash, 20) !== seat.contractHash || String(live.id) !== seat.contractId ||
          String(live.updatecounter) !== seat.updateCounter) return freeze({ seat, supported: false });
      const core = hash(await this._readModule(seat.contractHash, "authorizedCore", []));
      if (core !== this.contractHash) return freeze({ seat, supported: false });
      const result = array(await this._readModule(seat.contractHash, "getRecoveryStatus", [H(id)]), undefined, "recovery record");
      if (!result.length) return freeze({ seat, supported: true, pending: null });
      if (result.length !== 7) error("invalid recovery record");
      const status = uint(result[4], 8, "recovery status");
      if (!["1","2"].includes(status)) error("unknown recovery status");
      const pending = status === "1" ? {
        nonce: uint(result[0], 64, "recovery nonce"), custody: hash(result[1]),
        initiatedAt: uint(result[2], 64, "recovery start"), matureAt: uint(result[3], 64, "recovery maturity"),
        newCustody: hash(result[5]), authorityEpochAtInit: uint(result[6], 64, "recovery epoch")
      } : null;
      return freeze({ seat, supported: true, pending });
    }

    async buildRecoveryModulePlan({ accountId, action, authority, newCustody }) {
      const id = codec.hex(accountId, 20);
      const state = await this.getAccount(id);
      if (!state || state.recoveryAuthority === ZERO) error("recovery is not configured");
      const route = await this.getRecoverySeat(id);
      if (!route?.supported) error("no supported recovery seat installed");
      if (!["beginRecovery", "cancelRecovery", "executeRecovery"].includes(action)) error("unsupported recovery operation");
      const { seat, pending } = route;
      const signers = [];
      const args = [H(id)];
      let method = action;
      if (action !== "executeRecovery") {
        const actor = codec.hex(authority, 20);
        if (![state.custodyAddress, state.recoveryAuthority].includes(actor))
          error("Only custody or the recovery authority can start or cancel recovery.");
        signers.push(actor);
      }
      if (action === "beginRecovery") {
        if (pending) error("a recovery is already pending");
        const recipient = codec.hex(newCustody ?? ZERO, 20);
        if ([state.accountAddress, this.contractHash].includes(recipient)) error("invalid new custody");
        if (recipient !== ZERO && !signers.includes(recipient)) signers.push(recipient);
        args.push(H(recipient));
      } else {
        if (!pending) error("no pending recovery");
        if (action === "executeRecovery") {
          if (pending.authorityEpochAtInit !== state.authorityEpoch) error("pending recovery epoch is stale");
          const count = await this._send("getblockcount", []);
          if (!Number.isSafeInteger(count) || count < 1) error("invalid block height");
          const header = await this._send("getblockheader", [count - 1, true]);
          if (!Number.isSafeInteger(header?.time) || header.time < 0 || BigInt(header.time) < BigInt(pending.matureAt))
            error("the recovery timelock has not matured");
        }
        method = action === "cancelRecovery" ? "cancelReviewedRecovery" : "executeReviewedRecovery";
        args.push(I(pending.nonce), I(state.configurationNonce));
      }
      return freeze({ kind: "recovery", method, action, accountId: id, accountAddress: state.accountAddress,
        targetContract: seat.contractHash, moduleId: seat.moduleId, nefSha256: seat.nefSha256,
        configurationNonce: state.configurationNonce, pending, signers, args,
        newCustody: action === "beginRecovery" ? codec.hex(newCustody ?? ZERO, 20) : null,
        script: codec.dynamicCall(seat.contractHash, method, args) });
    }

    buildRecoveryPolicyScript(input) {
      return codec.dynamicCall(this.contractHash, "setRecoveryPolicy",
        [H(codec.hex(input.accountId, 20)), ...recoveryPolicyFields(input).fields]);
    }

    async buildRecoveryPolicyPlan(input) {
      const id = codec.hex(input.accountId, 20);
      const { recipient, fields } = recoveryPolicyFields(input);
      const state = await this.getAccount(id);
      if (!state || state.status !== 0) error("account is not active");
      if ([ZERO, state.custodyAddress, this.contractHash, state.accountAddress].includes(recipient))
        error("invalid recovery authority");
      const signers = recipient === state.recoveryAuthority ? [state.custodyAddress] : [state.custodyAddress, recipient];
      return freeze({
        kind: "account", method: "setRecoveryPolicy", accountId: id, accountAddress: state.accountAddress,
        recoveryAuthority: recipient, configurationNonce: state.configurationNonce, signers,
        script: codec.dynamicCall(this.contractHash, "setRecoveryPolicy",
          [H(id), ...fields]),
      });
    }

    /** Canonical bytes for audit and historical receipts, independent of current account state. */
    buildConfigurationBatchScript(input) {
      return configurationBatch(this.contractHash, input).script;
    }

    /** Direct custody administration. Resolve all recipient witnesses from one account read. */
    async buildConfigurationBatchPlan(input) {
      const { id, script, recipients } = configurationBatch(this.contractHash, input);
      const state = await this.getAccount(id);
      if (!state || state.status !== 0) error("account is not active");
      const signers = new Set([state.custodyAddress]);
      let current = state.recoveryAuthority;
      for (const recipient of recipients) {
        if ([ZERO, state.custodyAddress, this.contractHash, state.accountAddress].includes(recipient))
          error("invalid recovery authority");
        if (current !== recipient) signers.add(recipient);
        current = recipient;
      }
      if (signers.size > 16) error("configuration batch requires more than 16 transaction signers");
      return freeze({ kind: "account", method: "applyConfigurationActions", accountId: id,
        accountAddress: state.accountAddress, configurationNonce: state.configurationNonce, signers: [...signers], script });
    }

    buildAccountActionScript({ method, accountId, args = [] }) {
      if (method === "setRecoveryPolicy") error("use buildRecoveryPolicyPlan to resolve the required signers");
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

    /**
     * Simulate a prepared plan. A failed simulation is reported, not thrown:
     * the review must be able to show why the plan is unusable.
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
      const fees = halted
        ? parseNativeRpcFees(result)
        : { gasConsumed: null, minimumRequiredFee: null };
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
      if (plan.method === "setRecoveryPolicy" || plan.method === "applyConfigurationActions") {
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
