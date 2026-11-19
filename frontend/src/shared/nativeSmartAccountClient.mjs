/**
 * SA module protocol v4 native-kernel client (docs/SA-MODULE-PROTOCOL.md §9).
 *
 * The ABI table below is the compiled v4 surface of
 * `contracts/native/SmartAccount/*` — the same names, parameters and return
 * types the custom kernel exposes. Old `registerAccount` / `callVerifier` /
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

export const NATIVE_REQUIRED_ABI = {
  verify: requiredMethod(account, "Boolean", true),
  getAccountImplementationId: requiredMethod([], "String", true),
  getProtocolInfo: requiredMethod([], "Array", true),
  getAccount: requiredMethod(account, "Array", true),
  getRecoveryStatus: requiredMethod(account, "Array", true),
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
  freezeAccount: accountAction,
  unfreezeAccount: accountAction,
  beginRecovery: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["newCustody", "Hash160"],
    ],
    "Void",
    false,
  ),
  cancelRecovery: accountAction,
  executeRecovery: accountAction,
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
  isValidSignature: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["hash", "ByteArray"],
      ["signatureEnvelope", "Array"],
    ],
    "ByteArray",
    true,
  ),
  proposeConfiguration: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["actions", "Array"],
      ["readSet", "Array"],
    ],
    "Integer",
    false,
  ),
  confirmConfiguration: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["intentId", "Integer"],
      ["actions", "Array"],
    ],
    "Void",
    false,
  ),
  cancelConfiguration: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["intentId", "Integer"],
    ],
    "Void",
    false,
  ),
  getPendingConfiguration: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["intentId", "Integer"],
    ],
    "Array",
    true,
  ),
  getPendingConfigurationIntentIds: requiredMethod(account, "Array", true),
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
  getHookOrder: requiredMethod(account, "Array", true),
  getAuthorizedModuleId: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["phase", "Integer"],
    ],
    "Integer",
    true,
  ),
  revokeCredentials: requiredMethod(
    [
      ["accountId", "Hash160"],
      ["moduleId", "Integer"],
    ],
    "Void",
    false,
  ),
  supportsModuleType: requiredMethod([["moduleType", "String"]], "Boolean", true),
  supportsExecutionMode: requiredMethod([["mode", "String"]], "Boolean", true),
};
freeze(NATIVE_REQUIRED_ABI);

// Presence-only event gate: the client never decodes these payloads, so the
// parameter names are not pinned (renaming a parameter is not an ABI break for
// a byte-positional event), while a missing lifecycle event still fails.
export const NATIVE_REQUIRED_EVENTS = Object.freeze([
  "AccountRegistered",
  "AccountFrozen",
  "AccountUnfrozen",
  "UserOpExecuted",
  "ModuleInstalled",
  "ModuleRemoved",
  "ModuleUpdateInitiated",
  "ModuleUpdateConfirmed",
  "ModuleUpdateCancelled",
  "RecoveryInitiated",
  "RecoveryCancelled",
  "RecoveryExecuted",
  "ConfigurationIntentProposed",
  "ConfigurationIntentConfirmed",
  "ConfigurationIntentCancelled",
  "ConfigurationIntentExpired",
]);

// The native kernel declares a serialized operation as `Array`; the custom
// kernel's compiler infers `Any` for its `object operation` parameter. Both
// accept exactly the serialized Array the client builds, so the gate pins the
// value the client sends instead of the compiler's parameter inference. Nothing
// else is interchangeable: every other declared type must match exactly.
function declaredType(expected, actual) {
  return actual === expected || (expected === "Array" && actual === "Any");
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
// index.js gates the custom-only surface the same way; one rule, one module.
export { declaredType };
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
  if (plan.kind !== "execution") return [];
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

export function createNativeClientClass(codec, {
  // Defaults for one kernel build. They are identity, not configuration: the
  // native kernel always answers at a fixed hash, while a custom kernel can be
  // deployed at any hash, so its client passes both values to the constructor
  // and every derivation (proxy address, plan scripts, ABI gate, artifacts)
  // follows the instance rather than the class.
  contractHash = NATIVE_SMART_ACCOUNT_CONTRACT,
  // The native kernel's proxy script calls verify(accountId) with
  // CallFlags.ReadOnly (PUSH5); the custom kernel pushes CallFlags.All
  // (PUSH15). The flag is never inferred from the codec default: the proxy
  // address must be the one the submitting kernel derives (spec §16.1).
  callFlags = 5,
  // A native contract has a negative id; a deployed custom kernel has a
  // positive one. The ABI gate is the same either way.
  nativeCore = true,
  // `getAccountImplementationId` is the one identity the ABI cannot express, so
  // the launch pins it: a kernel that answers a different id is not the build
  // this client was reviewed against, even at the same script hash.
  implementationId = "NativeSmartAccount/v4",
} = {}) {
  const DEFAULT_CONTRACT = codec.hex(contractHash, 20);
  const DEFAULT_CALL_FLAGS = codec.unsigned(callFlags, 8, "proxy call flags");
  const NATIVE_CORE = nativeCore;
  const IMPLEMENTATION_ID = String(implementationId);
  const proxyOf = (accountId, coreHash, coreFlags) =>
    codec.accountAddress(accountId, {
      coreContractHash: coreHash,
      callFlags: coreFlags,
    });
  const H = codec.hashValue;
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
  // A pending intent's actions travel back verbatim into `confirmConfiguration`,
  // so they are returned in the canonical VM value form the script builder
  // accepts (decimal Integer text, hex ByteString, nested Array). The decode
  // above keeps bytes as bytes for hashing; an action is data, not a hash.
  const vmValue = (v) => {
    if (v === null || v === undefined) return { type: "Null" };
    if (typeof v === "boolean") return { type: "Boolean", value: v };
    if (typeof v === "bigint") return { type: "Integer", value: v.toString() };
    if (v instanceof Uint8Array) return { type: "ByteString", value: toHex(v) };
    if (v?.type === "Array" || v?.type === "Struct")
      return { type: "Array", value: array(v, undefined, "action value").map(vmValue) };
    return error("malformed intent action value");
  };
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
    const a = array(item, 16, "account");
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
    const status = Number(a[1]);
    if (![0, 1, 2].includes(status)) error("unknown account status");
    const authorityEpoch = uint(a[4], 64, "authority epoch");
    const configurationNonce = uint(a[5], 64, "configuration nonce");
    if (BigInt(authorityEpoch) > BigInt(configurationNonce))
      error("authority epoch exceeds configuration nonce");
    return freeze({
      accountId: codec.hex(accountId, 20),
      accountAddress: address,
      exists: true,
      status,
      statusName: ["Active", "Frozen", "MigrationRequired"][status],
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
      legacyRow: a[15],
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
      if (flags > 15n) error("proxy call flags must fit CallFlags");
      Object.defineProperties(this, {
        networkMagic: {
          value: Number(
            codec.unsigned(networkMagic, 32, "expected network magic"),
          ),
          enumerable: true,
        },
        // The two kernels differ in exactly two constants: which script hash
        // answers and which call flags the proxy verification script pushes.
        // Both are identity, not configuration, so they are read-only.
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
      if (result?.state !== "HALT" || !Array.isArray(result.stack))
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

    async discover() {
      if (this._discovery) return this._discovery;
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
        (NATIVE_CORE ? state.id >= 0 : state.id < 0) ||
        codec.hex(state?.hash, 20) !== this.contractHash ||
        state?.manifest?.name !== "SmartAccount"
      )
        error("SmartAccount contract is not available");
      const methods = descriptors(state.manifest.abi?.methods, "methods");
      const events = descriptors(state.manifest.abi?.events, "events");
      for (const [name, [types, returntype, safe, names]] of Object.entries(
        NATIVE_REQUIRED_ABI,
      )) {
        // The custom kernel keeps a v3 `getNonce(accountId, channel)` overload
        // next to the v4 routing signature. The gate requires the exact v4
        // signature to exist once; the client never calls an older overload.
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
      const eventNames = new Set(events.map((event) => event.name));
      for (const name of NATIVE_REQUIRED_EVENTS)
        if (!eventNames.has(name)) error(`native ABI event mismatch: ${name}`);
      const [protocolVersion, migrationOpen] = array(
        await this._read("getProtocolInfo"),
        2,
        "protocol info",
      );
      if (uint(protocolVersion, 64, "protocol version") !== String(PROTOCOL_VERSION) || typeof migrationOpen !== "boolean")
        error("native contract is not running the v4 protocol");
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

    async getProtocolInfo() {
      await this._ready();
      const info = array(await this._read("getProtocolInfo"), 2, "protocol info");
      return freeze({
        protocolVersion: uint(info[0], 64, "protocol version"),
        migrationModeOpen: info[1],
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

    async getHookOrder(accountId) {
      await this._ready();
      const [ids, revision] = array(
        await this._read("getHookOrder", [H(accountId)]),
        2,
        "hook order",
      );
      return freeze({
        hookIds: array(ids, undefined, "hook ids").map((id) =>
          uint(id, 64, "hook id"),
        ),
        revision: uint(revision, 64, "hook order revision"),
      });
    }

    deriveNonceRouting(accountId, routing) {
      return codec.deriveNonceChannel(
        {
          networkMagic: this.networkMagic,
          coreContractHash: this.contractHash,
          accountId: codec.hex(accountId, 20),
          authorityEpoch: routing.authorityEpoch,
        },
        routing,
      );
    }

    async getNonce(accountId, { authorityEpoch, validatorId = 0, credentialGeneration = 1, nonceSubkey }) {
      await this._ready();
      codec.hex(nonceSubkey, NONCE_SUBKEY_BYTES);
      const packed = await this._read("getNonce", [
        H(accountId),
        I(codec.unsigned(validatorId, 64, "validator id")),
        { type: "ByteString", value: codec.hex(nonceSubkey) },
      ]);
      if (typeof packed !== "bigint" || packed < 0n || packed >= 1n << 255n)
        error("malformed packed nonce");
      const channel = this.deriveNonceRouting(accountId, {
        authorityEpoch,
        validatorId,
        credentialGeneration,
        nonceSubkey,
      });
      if (packed >> 64n !== BigInt(channel))
        error("nonce channel does not match the derived namespace");
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
      if (chainDigest !== local) error("core digest disagrees with the local v4 codec");
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

    async isValidSignature(accountId, hash_, envelope) {
      await this._ready();
      const reply = await this._read("isValidSignature", [
        H(accountId),
        { type: "ByteString", value: codec.hex(hash_, 32) },
        codec.canonicalValue({ type: "Array", value: envelope }),
      ]);
      const magic = toHex(bytes(reply, 4, "signature magic"));
      return freeze({ valid: magic === "1626ba7e", magic });
    }

    async getRecoveryStatus(accountId) {
      await this._ready();
      const reply = array(
        await this._read("getRecoveryStatus", [H(accountId)]),
        undefined,
        "recovery status",
      );
      if (reply.length === 0) return null;
      if (reply.length !== 5) error("malformed recovery status");
      return freeze({
        pending: reply[0],
        initiatedAt: uint(reply[1], 64, "initiated time"),
        matureAt: uint(reply[2], 64, "maturity"),
        authorityEpochAtInit: uint(reply[3], 64, "authority epoch"),
        newCustody: hash(reply[4]),
      });
    }

    async getPendingConfiguration(accountId, intentId) {
      await this._ready();
      const reply = array(
        await this._read("getPendingConfiguration", [
          H(accountId),
          I(codec.unsigned(intentId, 64, "intent id")),
        ]),
        undefined,
        "pending intent",
      );
      if (reply.length === 0) return null;
      if (reply.length !== 8) error("malformed pending intent");
      return freeze({
        exists: reply[0],
        intentId: uint(reply[1], 64, "intent id"),
        proposedAt: uint(reply[2], 64, "proposed time"),
        matureAt: uint(reply[3], 64, "maturity"),
        expiresAt: uint(reply[4], 64, "expiry"),
        authorityEpoch: uint(reply[5], 64, "authority epoch"),
        actionDigest: digest(reply[6]),
        actions: array(reply[7], undefined, "intent actions").map(vmValue),
      });
    }

    async getPendingConfigurationIntentIds(accountId) {
      await this._ready();
      return array(
        await this._read("getPendingConfigurationIntentIds", [H(accountId)]),
        undefined,
        "intent ids",
      ).map((id) => uint(id, 64, "intent id"));
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

    buildConfigurationScript({ kind, accountId, intentId, actions = [], readSet = [] }) {
      const id = codec.hex(accountId, 20);
      const method = {
        propose: "proposeConfiguration",
        confirm: "confirmConfiguration",
        cancel: "cancelConfiguration",
      }[kind];
      if (!method) error(`unknown configuration intent kind ${kind}`);
      const args =
        kind === "propose"
          ? [
              H(id),
              codec.canonicalValue({ type: "Array", value: actions }),
              codec.canonicalValue({ type: "Array", value: readSet }),
            ]
          : kind === "confirm"
            ? [
                H(id),
                I(codec.unsigned(intentId, 64, "intent id")),
                codec.canonicalValue({ type: "Array", value: actions }),
              ]
            : [H(id), I(codec.unsigned(intentId, 64, "intent id"))];
      return freeze({
        kind: "configuration",
        method,
        accountId: id,
        accountAddress: this.proxyAddress(id),
        signers: [this.proxyAddress(id)],
        script: codec.dynamicCall(this.contractHash, method, args),
      });
    }

    buildAccountActionScript({ method, accountId, args = [] }) {
      if (!NATIVE_REQUIRED_ABI[method]) error(`unknown account action ${method}`);
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
      const halted = result?.state === "HALT" && Array.isArray(result.stack);
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
      if (plan.kind !== "execution") return true;
      const state = await this.getAccount(plan.accountId);
      if (!state || state.status !== 0)
        error("account is not active");
      return true;
    }
  };
}
