const SERVICE = "d9421d07adf206e9dc4be746a02e8e087fa61741";
export const NATIVE_PROFILE_PARAMETER_DIGEST =
  "a55dfe56356cdb9f51d9139f7f6e617c8bf4bcaa3211fd69a53dc980d477c03e";
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
export const NATIVE_REQUIRED_ABI = {
  verify: [["Hash160"], "Boolean", true],
  getVersion: [[], "Integer", true],
  getAccount: [["Hash160"], "Any", true],
  getAccountAddress: [["Hash160"], "Hash160", true],
  getAuthorityEpoch: [["Hash160"], "Integer", true],
  getNonce: [["Hash160", "Integer"], "Integer", true],
  getAuthorizationDomain: [["Hash160"], "ByteArray", true],
  getOperationDigest: [["Hash160", "Array"], "ByteArray", true],
  getPendingModuleCall: [["Hash160", "String"], "Any", true],
  getModuleDependencies: [["Hash160", "String"], "Array", true],
  registerAccount: [
    ["Hash160", "ByteArray", "Hash160", "Hash160", "Hash160"],
    "Hash160",
    false,
  ],
  executeUserOp: [["Hash160", "Array", "Integer", "Integer"], "Any", false],
  executeUserOps: [["Hash160", "Array", "Integer", "Integer"], "Array", false],
  callVerifier: [["Hash160", "String", "Array"], "Any", false],
  callHook: [["Hash160", "String", "Array"], "Any", false],
  callVerifierChild: [["Hash160", "Hash160", "String", "Array"], "Any", false],
  callHookChild: [["Hash160", "Hash160", "String", "Array"], "Any", false],
  cancelModuleCall: [["Hash160", "String"], "Void", false],
};
for (const prefix of ["Verifier", "Hook", "RecoveryAddress"]) {
  NATIVE_REQUIRED_ABI["propose" + prefix] = [
    ["Hash160", "Hash160"],
    "Void",
    false,
  ];
  for (const verb of ["activate", "cancel"])
    NATIVE_REQUIRED_ABI[verb + prefix] = [["Hash160"], "Void", false];
}
NATIVE_REQUIRED_ABI.proposeRecovery = [["Hash160", "Hash160"], "Void", false];
for (const method of [
  "executeRecovery",
  "cancelRecovery",
  "freeze",
  "unfreeze",
])
  NATIVE_REQUIRED_ABI[method] = [["Hash160"], "Void", false];
freeze(NATIVE_REQUIRED_ABI);
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
  const operations = plan.preparedOperations;
  const results = plan.batch ? stack[0].value : stack;
  if (
    plan.batch &&
    (stack[0].type !== "Array" || results.length !== operations.length)
  )
    error("batch result must be an exact Array matching the operation count");
  return operations.flatMap((prepared, index) =>
    prepared.operation.method === "transfer" &&
    !(results[index]?.type === "Boolean" && results[index].value === true)
      ? [index]
      : [],
  );
}
export function createNativeClientClass(codec) {
  const H = codec.hashValue,
    S = codec.stringValue;
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
  const hash = (v, n = 20) =>
    toHex(new Uint8Array(bytes(v, n, "hash")).reverse());
  const uint = (v, bits, label) => {
    if (typeof v !== "bigint") error(`malformed ${label} Integer`);
    return codec.unsigned(v, bits, label).toString();
  };
  const binding = (v) => {
    if (v === null) return null;
    const a = array(v, 2, "module binding");
    const contract = hash(a[0]);
    if (contract === ZERO || contract === SERVICE)
      error("invalid module binding");
    return { contract, codeHash: hash(a[1], 32) };
  };
  function stackValue(v) {
    if (v === null) return { type: "Null" };
    if (v instanceof Uint8Array) return { type: "ByteString", value: toHex(v) };
    if (typeof v === "bigint") return { type: "Integer", value: v.toString() };
    if (typeof v === "boolean") return { type: "Boolean", value: v };
    if (v?.type === "Array" || v?.type === "Struct")
      return { type: v.type, value: v.value.map(stackValue) };
    return error("invalid stack value");
  }
  function pending(v, kind) {
    if (v === null) return null;
    const p = array(v, kind === "module" ? 5 : 4, "pending intent");
    if (kind === "module")
      return {
        contract: hash(p[0]),
        codeHash: hash(p[1], 32),
        proposedAt: uint(p[2], 64, "proposal time"),
        matureAt: uint(p[3], 64, "maturity"),
        configurationNonce: uint(p[4], 64, "configuration nonce"),
      };
    return {
      address: hash(p[0]),
      proposedAt: uint(p[1], 64, "proposal time"),
      matureAt: uint(p[2], 64, "maturity"),
      configurationNonce: uint(p[3], 64, "configuration nonce"),
    };
  }
  function account(item, accountId) {
    if (item === null) return null;
    const a = array(item, 14, "ABI2 account");
    if (a[0] !== 2n) error("account record is not ABI2");
    const id = hash(a[1]),
      address = hash(a[2]),
      custody = hash(a[3]),
      recovery = hash(a[4]);
    if (
      id !== codec.hex(accountId, 20) ||
      address !== codec.accountAddress(id) ||
      custody === ZERO ||
      custody === SERVICE ||
      custody === address
    )
      error("account identity/address mismatch");
    if (recovery !== ZERO && [custody, address, SERVICE].includes(recovery))
      error("invalid recovery identity");
    if (a[7] !== 0n && a[7] !== 1n) error("unknown account status");
    if (typeof a[13] !== "bigint" || typeof a[8] !== "bigint" || a[13] > a[8])
      error("authority epoch exceeds configuration nonce");
    return freeze({
      version: 2,
      accountId: id,
      accountAddress: address,
      custodyAddress: custody,
      recoveryAddress: recovery,
      verifier: binding(a[5]),
      hook: binding(a[6]),
      status: a[7] === 0n ? "Active" : "Frozen",
      configurationNonce: uint(a[8], 64, "configuration nonce"),
      pendingVerifier: pending(a[9], "module"),
      pendingHook: pending(a[10], "module"),
      pendingRecoveryAddress: pending(a[11], "address"),
      pendingRecovery: pending(a[12], "recovery"),
      authorityEpoch: uint(a[13], 64, "authority epoch"),
    });
  }
  return class NativeSmartAccountClient {
    constructor({
      rpcUrl,
      rpcClient,
      networkMagic,
      profileParameterDigest = NATIVE_PROFILE_PARAMETER_DIGEST,
    } = {}) {
      this.rpc = rpcClient;
      if (typeof this.rpc?.send !== "function")
        error("RPC transport must expose send(method,params)");
      Object.defineProperties(this, {
        networkMagic: {
          value: Number(
            codec.unsigned(networkMagic, 32, "expected network magic"),
          ),
          enumerable: true,
        },
        profileParameterDigest: {
          value: codec.hex(profileParameterDigest, 32),
          enumerable: true,
        },
      });
      this.profile = null;
      this._prepared = new WeakSet();
      this._plans = new WeakSet();
    }
    async _read(method, args = [], contract = SERVICE, signers = []) {
      const script = codec.dynamicCall(contract, method, args, 5);
      const result = await this.rpc.send("invokescript", [
        bytesToBase64(codec.bytes(script)),
        signers,
      ]);
      if (
        result?.state !== "HALT" ||
        !Array.isArray(result.stack) ||
        result.stack.length !== 1
      )
        error(
          `${method} failed: ${result?.exception ?? result?.state ?? "invalid RPC result"}`,
        );
      return decode(result.stack[0]);
    }
    async discover() {
      const [version, state] = await Promise.all([
        this.rpc.send("getversion", []),
        this.rpc.send("getcontractstate", ["0x" + SERVICE]),
      ]);
      if (version?.protocol?.network !== this.networkMagic)
        error("RPC network magic mismatch");
      if (
        !Number.isSafeInteger(state?.id) ||
        state.id !== -13 ||
        codec.hex(state?.hash, 20) !== SERVICE ||
        state?.manifest?.name !== "AccountManagement"
      )
        error("native AccountManagement service is not available");
      const marker = state.manifest.extra?.smartAccount;
      if (
        marker?.abiVersion !== 2 ||
        marker?.profileParameterDigest !== this.profileParameterDigest
      )
        error("native ABI/profile parameter digest mismatch");
      const methods = state.manifest.abi?.methods;
      if (!Array.isArray(methods)) error("native ABI missing");
      for (const [name, [params, returntype, safe]] of Object.entries(
        NATIVE_REQUIRED_ABI,
      )) {
        const matches = methods.filter(
          (m) => m.name === name && m.parameters?.length === params.length,
        );
        if (
          matches.length !== 1 ||
          matches[0].returntype !== returntype ||
          matches[0].safe !== safe ||
          JSON.stringify(matches[0].parameters.map((p) => p.type)) !==
            JSON.stringify(params)
        )
          error(`native ABI mismatch: ${name}`);
      }
      if ((await this._read("getVersion")) !== 2n)
        error("native service is inactive or has wrong version");
      this.profile = freeze({
        service: SERVICE,
        networkMagic: this.networkMagic,
        abiVersion: 2,
        identityVersion: 1,
        authorizationVersion: 2,
        profileParameterDigest: this.profileParameterDigest,
      });
      return this.profile;
    }
    async _ready() {
      if (!this.profile) await this.discover();
    }
    deriveIdentity(options) {
      return codec.deriveIdentity({
        ...options,
        networkMagic: this.networkMagic,
      });
    }
    async getAccount(accountId) {
      await this._ready();
      return account(await this._read("getAccount", [H(accountId)]), accountId);
    }
    async getNonce(accountId, channel = 0n) {
      await this._ready();
      const cursor = await this._read("getNonce", [
        H(accountId),
        I(codec.unsigned(channel, 191, "nonce channel")),
      ]);
      if (typeof cursor !== "bigint" || cursor < 0n || cursor > 1n << 64n)
        error("invalid nonce cursor");
      return cursor;
    }
    async _context(accountId) {
      const state = await this.getAccount(accountId);
      if (!state) error("account is not registered");
      const context = {
        networkMagic: this.networkMagic,
        accountId: state.accountId,
        authorityEpoch: state.authorityEpoch,
        configurationNonce: state.configurationNonce,
      };
      const [epoch, domain] = await Promise.all([
        this._read("getAuthorityEpoch", [H(accountId)]),
        this._read("getAuthorizationDomain", [H(accountId)]),
      ]);
      if (
        epoch !== BigInt(state.authorityEpoch) ||
        toHex(bytes(domain, undefined, "authorization domain")) !==
          codec.authorizationDomain(context)
      )
        error("native authorization context changed or mismatched");
      return { state, context };
    }
    buildRegistration({
      custodyAddress,
      salt,
      verifier = ZERO,
      hook = ZERO,
      recoveryAddress = ZERO,
    }) {
      const identity = this.deriveIdentity({ custodyAddress, salt });
      const custody = codec.hex(custodyAddress, 20),
        recovery = codec.hex(recoveryAddress, 20);
      if (
        recovery !== ZERO &&
        [custody, identity.accountAddress, SERVICE].includes(recovery)
      )
        error("recovery authority must be independent");
      return this._plan({
        kind: "registration",
        ...identity,
        method: "registerAccount",
        requiredAuthorities: [custody],
        script: codec.dynamicCall(SERVICE, "registerAccount", [
          H(custody),
          { type: "ByteString", value: codec.hex(salt, 32) },
          H(verifier),
          H(hook),
          H(recovery),
        ]),
      });
    }
    async prepareOperation(input) {
      const { accountId, ...operation } = input;
      return (
        await this.prepareOperations({ accountId, operations: [operation] })
      )[0];
    }
    async prepareOperations({ accountId, operations }) {
      if (
        !Array.isArray(operations) ||
        !operations.length ||
        operations.length > 32
      )
        error("prepare requires 1..32 operations");
      await this.discover();
      const { state, context } = await this._context(accountId);
      if (state.status !== "Active") error("account is Frozen");
      const cursors = new Map(),
        prepared = [];
      for (const input of operations) {
        const channel = codec
          .unsigned(input.channel ?? 0n, 191, "nonce channel")
          .toString();
        if (!cursors.has(channel))
          cursors.set(channel, await this.getNonce(accountId, channel));
        const sequence = cursors.get(channel);
        if (sequence === 1n << 64n) error("nonce channel exhausted");
        cursors.set(channel, sequence + 1n);
        const operation = {
          targetContract: codec.hex(input.targetContract, 20),
          method: input.method,
          args: codec.canonicalValue(A(input.args ?? [])).value,
          nonce: codec.composeNonce(channel, sequence).toString(),
          deadline: codec.unsigned(input.deadline, 255, "deadline").toString(),
          signature: "",
        };
        const digest = codec.operationDigest(context, operation),
          remote = await this._read("getOperationDigest", [
            H(accountId),
            codec.operationValue(operation, true),
          ]);
        if (toHex(bytes(remote, 32, "operation digest")) !== digest)
          error("local/native operation digest mismatch");
        const p = freeze({
          kind: "native-operation",
          profile: this.profile,
          account: state,
          context,
          operation,
          digest,
          preimage: codec.operationPreimage(context, operation),
          channel,
          sequence: sequence.toString(),
        });
        this._prepared.add(p);
        prepared.push(p);
      }
      if (
        JSON.stringify(await this.getAccount(accountId)) !==
        JSON.stringify(state)
      )
        error("account changed during operation preparation");
      return Object.freeze(prepared);
    }
    attachSignature(prepared, signature) {
      this._assertPrepared(prepared);
      const op = { ...prepared.operation, signature: codec.hex(signature) };
      codec.operationValue(op);
      if (!prepared.account.verifier && op.signature !== "")
        error(
          "native custody witness fallback requires empty operation signature",
        );
      const signed = freeze({ ...prepared, operation: op });
      this._prepared.add(signed);
      return signed;
    }
    _assertPrepared(prepared) {
      if (
        !this._prepared.has(prepared) ||
        prepared?.kind !== "native-operation" ||
        prepared?.profile?.networkMagic !== this.networkMagic ||
        prepared.profile.service !== SERVICE ||
        prepared.profile.profileParameterDigest !==
          this.profileParameterDigest ||
        codec.operationDigest(prepared.context, prepared.operation) !==
          prepared.digest ||
        codec.operationPreimage(prepared.context, prepared.operation) !==
          prepared.preimage
      )
        error("invalid or modified prepared operation");
    }
    async revalidate(prepared) {
      this._assertPrepared(prepared);
      await this.discover();
      const { state, context } = await this._context(
        prepared.context.accountId,
      );
      if (
        JSON.stringify(state) !== JSON.stringify(prepared.account) ||
        codec.operationDigest(context, prepared.operation) !== prepared.digest
      )
        error("account authority/configuration changed; sign again");
      const { channel, sequence } = codec.splitNonce(prepared.operation.nonce);
      if ((await this.getNonce(state.accountId, channel)) !== sequence)
        error("operation nonce is stale");
      const remote = await this._read("getOperationDigest", [
        H(state.accountId),
        codec.operationValue(prepared.operation, true),
      ]);
      if (toHex(bytes(remote, 32, "operation digest")) !== prepared.digest)
        error("operation digest changed");
      return true;
    }
    async revalidateExecution(plan) {
      if (plan?.kind !== "execution") error("native execution plan required");
      const expected = this.buildExecution(plan.preparedOperations, {
        batch: plan.batch,
      });
      if (
        plan.script !== expected.script ||
        JSON.stringify(plan.proxySigner) !==
          JSON.stringify(expected.proxySigner) ||
        JSON.stringify(plan.proxyWitness) !==
          JSON.stringify(expected.proxyWitness)
      )
        error("execution plan was modified");
      await this.discover();
      const first = plan.preparedOperations[0],
        { state, context } = await this._context(first.context.accountId);
      if (
        JSON.stringify(state) !== JSON.stringify(first.account) ||
        JSON.stringify(context) !== JSON.stringify(first.context)
      )
        error("account changed before execution");
      const cursors = new Map();
      for (const p of plan.preparedOperations) {
        this._assertPrepared(p);
        const { channel, sequence } = codec.splitNonce(p.operation.nonce),
          key = channel.toString();
        if (!cursors.has(key))
          cursors.set(key, await this.getNonce(state.accountId, channel));
        if (cursors.get(key) !== sequence)
          error("operation nonce is stale or batch sequence shifted");
        cursors.set(key, sequence + 1n);
        const remote = await this._read("getOperationDigest", [
          H(state.accountId),
          codec.operationValue(p.operation, true),
        ]);
        if (toHex(bytes(remote, 32, "operation digest")) !== p.digest)
          error("operation digest changed");
      }
      return true;
    }
    buildExecution(
      preparedOperations,
      { batch = preparedOperations.length !== 1 } = {},
    ) {
      if (!Array.isArray(preparedOperations) || !preparedOperations.length)
        error("prepared operations required");
      preparedOperations.forEach((p) => this._assertPrepared(p));
      const first = preparedOperations[0];
      const expected = new Map();
      for (const p of preparedOperations) {
        if (
          JSON.stringify(p.context) !== JSON.stringify(first.context) ||
          JSON.stringify(p.account) !== JSON.stringify(first.account)
        )
          error("batch mixes account authority contexts");
        const { channel, sequence } = codec.splitNonce(p.operation.nonce),
          key = channel.toString();
        if (expected.has(key) && expected.get(key) !== sequence)
          error("batch nonce progression invalid");
        expected.set(key, sequence + 1n);
      }
      const accountId = first.context.accountId,
        targets = [
          ...new Set(preparedOperations.map((p) => p.operation.targetContract)),
        ];
      if (targets.length > 16)
        error("transaction exceeds CustomContracts target bound");
      return this._plan({
        kind: "execution",
        batch,
        accountId,
        accountAddress: first.account.accountAddress,
        preparedOperations: [...preparedOperations],
        script: codec.buildExecutionScript(
          accountId,
          preparedOperations.map((p) => p.operation),
          first.context,
          batch,
        ),
        proxyWitness: {
          invocation: "",
          verification: codec.verificationScript(accountId),
        },
        proxySigner: {
          account: "0x" + first.account.accountAddress,
          scopes: "CustomContracts",
          allowedcontracts: targets.map((h) => "0x" + h),
        },
        requiredAuthorities: first.account.verifier
          ? []
          : [first.account.custodyAddress],
      });
    }
    async getPendingModuleCall(accountId, role) {
      await this._ready();
      this._role(role);
      const value = await this._read("getPendingModuleCall", [
        H(accountId),
        S(role),
      ]);
      if (value === null) return null;
      const p = array(value, 10, "pending module call");
      if (
        p[0] !== 1n ||
        p[2] !== BigInt(role === "verifier" ? 0 : 1) ||
        hash(p[1]) !== codec.hex(accountId, 20)
      )
        error("pending call identity/role mismatch");
      const invoked = array(p[6], undefined, "pending invoked args");
      if (
        !invoked.length ||
        invoked.length > 64 ||
        hash(invoked[0]) !== codec.hex(accountId, 20) ||
        p[3] === null ||
        p[4] === null ||
        p[8] - p[7] !== 86400000n
      )
        error("malformed pending module intent");
      const invokedArguments = stackValue(p[6]);
      if (codec.serializeValue(invokedArguments).length > 8192)
        error("pending arguments exceed profile bound");
      return freeze({
        accountId: hash(p[1]),
        role,
        root: binding(p[3]),
        selected: binding(p[4]),
        method: new TextDecoder("utf-8", { fatal: true }).decode(
          bytes(p[5], undefined, "method"),
        ),
        invokedArguments,
        proposedAt: uint(p[7], 64, "proposal time"),
        matureAt: uint(p[8], 64, "maturity"),
        configurationNonce: uint(p[9], 64, "configuration nonce"),
      });
    }
    async getModuleDependencies(accountId, role) {
      await this._ready();
      this._role(role);
      const d = array(
        await this._read("getModuleDependencies", [H(accountId), S(role)]),
        3,
        "module dependencies",
      );
      return freeze({
        root: binding(d[0]),
        cleanupBindings: array(d[1], undefined, "cleanup roster").map(binding),
        activeChildren: array(d[2], undefined, "active children").map((x) =>
          hash(x),
        ),
      });
    }
    _role(role) {
      if (role !== "verifier" && role !== "hook")
        error("module role must be verifier or hook");
    }
    async buildModuleCall({ accountId, role, child, method, args = [] }) {
      await this.discover();
      this._role(role);
      const state = await this.getAccount(accountId);
      if (!state || state.status !== "Active" || state.pendingRecovery)
        error("account is unavailable for configuration");
      const root = state[role];
      if (!root) error("role has no bound module");
      const selected = child ? codec.hex(child, 20) : root.contract;
      if (
        selected === ZERO ||
        selected === SERVICE ||
        (child && selected === root.contract)
      )
        error("invalid child module");
      if (
        !Array.isArray(args) ||
        args.length > 63 ||
        method.startsWith("_") ||
        [
          "validateSignature",
          "preExecute",
          "postExecute",
          "clearAccount",
          "supportsComposition",
          "getSignerDomains",
        ].includes(method)
      )
        error("invalid module configuration call");
      const canonicalArgs = codec.canonicalValue(A(args));
      if (
        codec.serializeValue(A([H(accountId), ...canonicalArgs.value])).length >
        8192
      )
        error("module configuration args exceed profile bound");
      const deployed = await this.rpc.send("getcontractstate", [
        "0x" + selected,
      ]);
      const capabilities =
        deployed?.manifest?.extra?.smartAccount?.configurationMethods;
      const matches = deployed?.manifest?.abi?.methods?.filter(
        (m) => m.name === method,
      );
      if (
        !Array.isArray(capabilities) ||
        !capabilities.includes(method) ||
        matches?.length !== 1 ||
        matches[0].safe !== false ||
        matches[0].parameters?.length !== args.length + 1 ||
        matches[0].parameters[0]?.type !== "Hash160"
      )
        error("module has no declared account-scoped configuration capability");
      const route =
        "call" +
        (role === "verifier" ? "Verifier" : "Hook") +
        (child ? "Child" : "");
      const params = [
        H(accountId),
        ...(child ? [H(child)] : []),
        S(method),
        canonicalArgs,
      ];
      return this._plan({
        kind: "configuration",
        role,
        accountState: state,
        accountId: state.accountId,
        method: route,
        requiredAuthorities: [state.custodyAddress],
        configurationNonce: state.configurationNonce,
        script: codec.dynamicCall(SERVICE, route, params),
        pending: await this.getPendingModuleCall(accountId, role),
      });
    }
    async buildAction({ accountId, action, address, role }) {
      await this.discover();
      const state = await this.getAccount(accountId);
      if (!state) error("unknown account");
      const allowed = new Set([
        "proposeVerifier",
        "activateVerifier",
        "cancelVerifier",
        "proposeHook",
        "activateHook",
        "cancelHook",
        "proposeRecoveryAddress",
        "activateRecoveryAddress",
        "cancelRecoveryAddress",
        "proposeRecovery",
        "executeRecovery",
        "cancelRecovery",
        "freeze",
        "unfreeze",
        "cancelModuleCall",
      ]);
      if (!allowed.has(action)) error("unsupported native lifecycle action");
      let authorities = [state.custodyAddress];
      const params = [H(accountId)];
      if (action.startsWith("propose")) params.push(H(address));
      if (action === "cancelModuleCall") {
        this._role(role);
        params.push(S(role));
      }
      if (action === "proposeRecovery" || action === "freeze") {
        if (state.recoveryAddress === ZERO) error("no recovery authority");
        authorities = [state.recoveryAddress];
      }
      if (action === "executeRecovery") authorities = [];
      if (action === "unfreeze" && state.recoveryAddress !== ZERO)
        authorities = [state.custodyAddress, state.recoveryAddress];
      if (action === "cancelRecovery") authorities = []; // Either recovery, or custody strictly before maturity; caller supplies actor for simulation.
      return this._plan({
        kind: "lifecycle",
        accountState: state,
        accountId: state.accountId,
        method: action,
        requiredAuthorities: authorities,
        authorityPolicy:
          action === "cancelRecovery"
            ? "recovery-or-custody-before-maturity"
            : undefined,
        configurationNonce: state.configurationNonce,
        script: codec.dynamicCall(SERVICE, action, params),
      });
    }
    _plan(value) {
      const plan = freeze(value);
      this._plans.add(plan);
      return plan;
    }
    async revalidatePlan(plan) {
      if (!this._plans.has(plan)) error("plan must be issued by this client");
      if (plan.kind === "execution") return this.revalidateExecution(plan);
      await this.discover();
      const state = await this.getAccount(plan.accountId);
      if (plan.kind === "registration") {
        if (state) error("account already registered");
      } else if (JSON.stringify(state) !== JSON.stringify(plan.accountState))
        error("account changed before transaction signing");
      if (
        plan.kind === "configuration" &&
        JSON.stringify(
          await this.getPendingModuleCall(plan.accountId, plan.role),
        ) !== JSON.stringify(plan.pending)
      )
        error("module proposal phase changed; rebuild the plan");
      return true;
    }
    async simulate(plan, signers = []) {
      await this.discover();
      const result = await this.rpc.send("invokescript", [
        bytesToBase64(codec.bytes(plan.script)),
        signers,
      ]);
      const failedTransfers =
        result?.state === "HALT"
          ? validateNativeInvocationResult(plan, result.stack)
          : [];
      return freeze({
        failedTransfers,
        state: result?.state,
        exception: result?.exception ?? null,
        stack: result?.stack ?? [],
        gasConsumed: result?.gasconsumed ?? null,
        minimumRequiredFee: result?.minimumrequiredfee ?? null,
        automaticSystemFeeAvailable:
          result?.state === "HALT" &&
          failedTransfers.length === 0 &&
          typeof result?.minimumrequiredfee === "string",
        raw: result,
      });
    }
  };
}
