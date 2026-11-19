/**
 * The v4 native client: strict discovery, one descriptor decoder, one plan shape.
 *
 * The client is shared by both kernels (`shared/nativeSmartAccountClient.mjs`),
 * and the two constants that differ are identity, not configuration: the script
 * hash that answers and the CallFlags the proxy verification script pushes.
 * Everything a caller branches on — the ABI gate, the account descriptor, the
 * module descriptor, the nonce channel, the plan bytes — is pinned here against
 * a fake RPC, so a change that still "works" against a sloppy node is caught.
 *
 * The fake RPC answers in wire form (stack items, base64 bytes) exactly as an
 * N3 node does, and every assertion below is about what the client accepted or
 * refused, never about a call the client was not supposed to make.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NativeSmartAccountClient,
  nativeCodec: c,
  NATIVE_SMART_ACCOUNT_CONTRACT: CORE,
} = require("../src/native");
const { NATIVE_REQUIRED_ABI, NATIVE_REQUIRED_EVENTS } = require("../src/native/client");

const NETWORK = 12345;
const ACCOUNT = "11".repeat(20);
const CUSTODY = "22".repeat(20);
const RECOVERY = "33".repeat(20);
const MODULE_CONTRACT = "44".repeat(20);
const ZERO = "0".repeat(40);
const ZERO_SUBKEY = "00".repeat(32);

const I = (value) => ({ type: "Integer", value: String(value) });
/**
 * Stack values are wire form: a ByteString is base64 of the raw bytes a hash is
 * stored in. Call arguments are codec form: a ByteString is hex, and a hash is
 * the stored byte order of its display form. Both are spelled out so a fixture
 * cannot accidentally key a response on a different script than the client sends.
 */
const H = (displayHex) => ({
  type: "ByteString",
  value: Buffer.from(displayHex, "hex").reverse().toString("base64"),
});
const BYTES = (hex) => ({ type: "ByteString", value: Buffer.from(hex, "hex").toString("base64") });
const TEXT = (text) => BYTES(Buffer.from(text, "utf8").toString("hex"));
const A = (value) => ({ type: "Array", value });
const BOOL = (value) => ({ type: "Boolean", value });
const ARG_HASH = (displayHex) => ({
  type: "ByteString",
  value: Buffer.from(displayHex, "hex").reverse().toString("hex"),
});
const ARG_BYTES = (hex) => ({ type: "ByteString", value: hex });

/** The ABI a v4 kernel must publish, built from the client's own gate. */
function manifest() {
  return {
    name: "SmartAccount",
    abi: {
      methods: Object.entries(NATIVE_REQUIRED_ABI).map(([name, [types, returntype, safe, names]]) => ({
        name,
        parameters: names.map((parameter, index) => ({ name: parameter, type: types[index] })),
        returntype,
        safe,
      })),
      events: NATIVE_REQUIRED_EVENTS.map((name) => ({ name, parameters: [] })),
    },
  };
}

function fixture() {
  const calls = [];
  const responses = new Map();
  const state = {
    magic: NETWORK,
    id: -13,
    hash: "0x" + CORE,
    abi: manifest(),
    protocolVersion: 4,
    implementation: "NativeSmartAccount/v4",
    account: null,
    module: null,
  };
  const answer = (method, args, value, contract = CORE) =>
    responses.set(c.dynamicCall(contract, method, args, 5), value);
  const reset = () => {
    responses.clear();
    answer("getProtocolInfo", [], A([I(state.protocolVersion), BOOL(false)]));
    answer("getAccountImplementationId", [], TEXT(state.implementation));
    if (state.account) answer("getAccount", [ARG_HASH(ACCOUNT)], state.account);
    if (state.module) answer("getModule", [ARG_HASH(ACCOUNT), I(1)], state.module);
  };
  reset();
  const rpcClient = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "getversion") return { protocol: { network: state.magic } };
      if (method === "getcontractstate")
        return { id: state.id, hash: state.hash, manifest: state.abi };
      const script = Buffer.from(params[0], "base64").toString("hex");
      if (responses.has(script))
        return { state: "HALT", stack: [responses.get(script)], gasconsumed: "10" };
      return { state: "FAULT", stack: [], exception: `unregistered script ${script}` };
    },
  };
  const client = new NativeSmartAccountClient({ rpcClient, networkMagic: NETWORK });
  return {
    client,
    calls,
    state,
    answer,
    reset,
    /** Replace one method descriptor in the published manifest. */
    patchMethod(name, patch) {
      state.abi.abi.methods = state.abi.abi.methods.map((method) =>
        method.name === name ? { ...method, ...patch } : method,
      );
    },
    /** The account descriptor as an N3 node returns it (16 fields). */
    setAccount({
      status = 0,
      custody = CUSTODY,
      recovery = RECOVERY,
      epoch = 7,
      configurationNonce = 11,
      exists = true,
    } = {}) {
      state.account = A([
        BOOL(exists),
        I(status),
        H(custody),
        H(recovery),
        I(epoch),
        I(configurationNonce),
        I(0),
        BOOL(true),
        BOOL(true),
        BOOL(false),
        I(3),
        I(5),
        BOOL(false),
        I(0),
        BOOL(false),
        A([]),
      ]);
      reset();
    },
    setModule({ moduleId = 1, credentialGeneration = 4, eligible = true, contract = MODULE_CONTRACT } = {}) {
      state.module = A([
        I(moduleId),
        I(1),
        H(contract),
        I(7),
        I(2),
        BYTES("aa".repeat(32)),
        BYTES("bb".repeat(32)),
        I(9),
        I(credentialGeneration),
        BOOL(true),
        BOOL(true),
        BOOL(eligible),
      ]);
      reset();
    },
  };
}

test("discovery reads one profile and answers every later read from it", async () => {
  const f = fixture();
  const profile = await f.client.discover();
  assert.deepEqual(profile, {
    contract: CORE,
    networkMagic: NETWORK,
    protocolVersion: 4,
    implementationId: "NativeSmartAccount/v4",
  });
  assert.equal(f.client.profile, profile);
  // Concurrent readers share one in-flight discovery, while an explicit call
  // re-verifies the identity: the ABI is cheap to read and never cached past a
  // caller that asked for it again.
  f.client.profile = null;
  await Promise.all([f.client.discover(), f.client.discover(), f.client.discover()]);
  assert.equal(f.calls.filter((call) => call.method === "getcontractstate").length, 2);
  await f.client.discover();
  assert.equal(f.calls.filter((call) => call.method === "getversion").length, 3);
});

test("discovery refuses every identity that is not this kernel build", async () => {
  const cases = [
    ["network magic", (f) => (f.state.magic = 5), /network magic/],
    ["native id sign", (f) => (f.state.id = 13), /not available/],
    ["reported hash", (f) => (f.state.hash = "0x" + "55".repeat(20)), /not available/],
    ["manifest name", (f) => (f.state.abi.name = "SmartAccountV3"), /not available/],
    [
      "missing method",
      (f) => (f.state.abi.abi.methods = f.state.abi.abi.methods.filter((method) => method.name !== "getModules")),
      /ABI mismatch: getModules/,
    ],
    ["missing event", (f) => (f.state.abi.abi.events = []), /event mismatch: AccountRegistered/],
    [
      "parameter type",
      (f) => f.patchMethod("getModule", { parameters: [{ name: "accountId", type: "Integer" }, { name: "moduleId", type: "Integer" }] }),
      /ABI mismatch: getModule/,
    ],
    ["safe flag", (f) => f.patchMethod("getModule", { safe: false }), /ABI mismatch: getModule/],
    ["protocol version", (f) => (f.state.protocolVersion = 3), /v4 protocol/],
    ["implementation id", (f) => (f.state.implementation = "NativeSmartAccount/v3"), /implementation id/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const f = fixture();
    mutate(f);
    f.reset();
    await assert.rejects(() => f.client.discover(), pattern, label);
    assert.equal(f.client.profile, null, `${label} must not leave a profile`);
  }
});

test("the operation parameter tolerance is one-way: Array may read as Any, nothing else", async () => {
  // The custom kernel's compiler infers `Any` for `object operation`; the native
  // kernel declares `Array`. Both receive the serialized Array the client
  // builds, so that one substitution is accepted (see declaredType).
  const tolerant = fixture();
  tolerant.patchMethod("executeUserOp", {
    parameters: [{ name: "accountId", type: "Hash160" }, { name: "operation", type: "Any" }],
  });
  await assert.doesNotReject(() => tolerant.client.discover());

  // The account id is never substitutable, and neither is the operation itself.
  const accountId = fixture();
  accountId.patchMethod("executeUserOp", {
    parameters: [{ name: "accountId", type: "ByteArray" }, { name: "operation", type: "Array" }],
  });
  await assert.rejects(() => accountId.client.discover(), /ABI mismatch: executeUserOp/);

  const operationType = fixture();
  operationType.patchMethod("executeUserOp", {
    parameters: [{ name: "accountId", type: "Hash160" }, { name: "operation", type: "Integer" }],
  });
  await assert.rejects(() => operationType.client.discover(), /ABI mismatch: executeUserOp/);
});

test("identity derivation is custody plus salt, at this kernel's call flags", async () => {
  const f = fixture();
  const salt = "ab".repeat(32);
  const identity = f.client.deriveIdentity({ custodyAddress: CUSTODY, salt });
  assert.deepEqual(identity, c.deriveIdentity({
    custodyAddress: CUSTODY,
    salt,
    coreContractHash: CORE,
    callFlags: 5,
  }));
  assert.equal(f.client.proxyAddress(ACCOUNT), c.accountAddress(ACCOUNT, { coreContractHash: CORE, callFlags: 5 }));
  // The same account id at CallFlags.All is a different proxy: the flags are in
  // the verification script the address hashes.
  assert.notEqual(
    f.client.proxyAddress(ACCOUNT),
    c.accountAddress(ACCOUNT, { coreContractHash: CORE, callFlags: 15 }),
  );
  assert.throws(() => f.client.deriveIdentity({ custodyAddress: ZERO, salt }), /custody/);
});

test("the account descriptor is decoded exactly and refuses impossible state", async () => {
  const f = fixture();
  f.setAccount();
  const account = await f.client.getAccount(ACCOUNT);
  assert.equal(account.accountId, ACCOUNT);
  assert.equal(account.accountAddress, f.client.proxyAddress(ACCOUNT));
  assert.equal(account.status, 0);
  assert.equal(account.statusName, "Active");
  assert.equal(account.custodyAddress, CUSTODY);
  assert.equal(account.recoveryAuthority, RECOVERY);
  assert.equal(account.authorityEpoch, "7");
  assert.equal(account.configurationNonce, "11");
  assert.equal(account.hookOrderRevision, "3");
  assert.equal(account.controlRevision, "5");
  assert.equal(account.marketEscrowActive, false);
  assert.equal(Object.isFrozen(account), true);

  for (const [label, patch, pattern] of [
    ["epoch ahead of the configuration nonce", { epoch: 12, configurationNonce: 11 }, /authority epoch exceeds/],
    ["zero custody", { custody: ZERO }, /invalid custody identity/],
    ["custody is the core", { custody: CORE }, /invalid custody identity/],
    ["recovery equals custody", { recovery: CUSTODY }, /invalid recovery identity/],
    ["status", { status: 7 }, /unknown account status/],
  ]) {
    const g = fixture();
    g.setAccount(patch);
    await assert.rejects(() => g.client.getAccount(ACCOUNT), pattern, label);
  }

  const missing = fixture();
  missing.setAccount({ exists: false, custody: ZERO, recovery: ZERO });
  assert.equal(await missing.client.getAccount(ACCOUNT), null);
});

test("the module descriptor is decoded exactly and refuses a core or zero contract", async () => {
  const f = fixture();
  f.setModule();
  const module = await f.client.getModule(ACCOUNT, 1);
  assert.equal(module.moduleId, "1");
  assert.equal(module.moduleType, 1);
  assert.equal(module.contractHash, MODULE_CONTRACT);
  assert.equal(module.credentialGeneration, "4");
  assert.equal(module.thresholdMemberEligible, true);
  assert.equal(module.instanceIsolation, true);
  assert.equal(module.messageCapability, true);

  for (const contract of [ZERO, CORE]) {
    const g = fixture();
    g.setModule({ contract });
    await assert.rejects(() => g.client.getModule(ACCOUNT, 1), /invalid module contract/);
  }
  const empty = fixture();
  empty.state.module = A([]);
  empty.reset();
  assert.equal(await empty.client.getModule(ACCOUNT, 1), null);
});

test("the nonce is read as a packed channel cursor and checked against the derived namespace", async () => {
  const f = fixture();
  const routing = f.client.deriveNonceRouting(ACCOUNT, {
    authorityEpoch: 7,
    validatorId: 2,
    credentialGeneration: 4,
    nonceSubkey: ZERO_SUBKEY,
  });
  assert.equal(
    routing,
    c.deriveNonceChannel(
      { networkMagic: NETWORK, coreContractHash: CORE, accountId: ACCOUNT, authorityEpoch: 7 },
      { validatorId: 2, credentialGeneration: 4, nonceSubkey: ZERO_SUBKEY },
    ),
  );
  const packed = (BigInt(routing) << 64n) | 9n;
  f.answer("getNonce", [ARG_HASH(ACCOUNT), I(2), ARG_BYTES(ZERO_SUBKEY)], I(packed));
  const nonce = await f.client.getNonce(ACCOUNT, {
    authorityEpoch: 7,
    validatorId: 2,
    credentialGeneration: 4,
    nonceSubkey: ZERO_SUBKEY,
  });
  assert.deepEqual(nonce, { packed: packed.toString(), channel: routing, sequence: "9" });

  // A node answering a cursor from another channel is refused, not trusted.
  const g = fixture();
  g.answer("getNonce", [ARG_HASH(ACCOUNT), I(2), ARG_BYTES(ZERO_SUBKEY)], I((BigInt(routing) + 1n) << 64n));
  await assert.rejects(
    () => g.client.getNonce(ACCOUNT, { authorityEpoch: 7, validatorId: 2, credentialGeneration: 4, nonceSubkey: ZERO_SUBKEY }),
    /nonce channel does not match/,
  );
  await assert.rejects(
    () => g.client.getNonce(ACCOUNT, { authorityEpoch: 7, validatorId: 2, credentialGeneration: 4, nonceSubkey: "00" }),
    /invalid hex/,
  );
});

test("the operation digest is compared with the local codec, and drift is refused", async () => {
  const operation = {
    version: 4,
    targetContract: CUSTODY,
    method: "transfer",
    args: [],
    nonce: "0",
    nonceSubkey: ZERO_SUBKEY,
    deadline: "9999999999999",
    validatorId: "1",
    credentialGeneration: "1",
    authorityEpoch: "1",
    configurationNonce: "1",
    signature: "01".repeat(64),
    hookProofs: [],
  };
  const local = c.operationDigest(
    { networkMagic: NETWORK, coreContractHash: CORE, accountId: ACCOUNT },
    operation,
  );
  const f = fixture();
  // A digest query returns the SHA-256 ByteString in hash order; only UInt160
  // identity fields are little-endian and reversed for display.
  f.answer("getOperationDigest", [ARG_HASH(ACCOUNT), c.operationValue(operation)], BYTES(local));
  assert.equal(await f.client.getOperationDigest(ACCOUNT, operation), local);

  const g = fixture();
  g.answer("getOperationDigest", [ARG_HASH(ACCOUNT), c.operationValue(operation)], BYTES("00".repeat(32)));
  await assert.rejects(() => g.client.getOperationDigest(ACCOUNT, operation), /disagrees/);
});

test("plans are the exact scripts the core answers, one shape per kind", async () => {
  const f = fixture();
  const operations = [
    {
      version: 4,
      targetContract: CUSTODY,
      method: "transfer",
      args: [ARG_HASH(CUSTODY)],
      nonce: "1",
      nonceSubkey: ZERO_SUBKEY,
      deadline: "9999999999999",
      validatorId: "0",
      credentialGeneration: "0",
      authorityEpoch: "1",
      configurationNonce: "1",
      signature: "01".repeat(64),
      hookProofs: [],
    },
  ];
  const single = f.client.buildExecutionScript({ accountId: ACCOUNT, operations });
  assert.equal(single.method, "executeUserOp");
  assert.equal(single.batch, false);
  assert.equal(single.proxyCallFlags, 5);
  assert.deepEqual(single.signers, [f.client.proxyAddress(ACCOUNT)]);
  assert.equal(single.script, c.buildExecutionScript(ACCOUNT, operations, {
    networkMagic: NETWORK,
    coreContractHash: CORE,
    accountId: ACCOUNT,
  }));

  const batch = f.client.buildExecutionScript({ accountId: ACCOUNT, operations: [...operations, operations[0]] });
  assert.equal(batch.method, "executeUserOps");
  assert.equal(batch.batch, true);
  assert.throws(() => f.client.buildExecutionScript({ accountId: ACCOUNT, operations: [] }), /at least one operation/);

  const propose = f.client.buildConfigurationScript({ kind: "propose", accountId: ACCOUNT, actions: [], readSet: [] });
  const confirm = f.client.buildConfigurationScript({ kind: "confirm", accountId: ACCOUNT, intentId: 3, actions: [] });
  const cancel = f.client.buildConfigurationScript({ kind: "cancel", accountId: ACCOUNT, intentId: 3 });
  assert.deepEqual([propose.method, confirm.method, cancel.method], [
    "proposeConfiguration",
    "confirmConfiguration",
    "cancelConfiguration",
  ]);
  assert.throws(() => f.client.buildConfigurationScript({ kind: "expire", accountId: ACCOUNT }), /unknown configuration intent/);

  const frozen = f.client.buildAccountActionScript({ method: "freezeAccount", accountId: ACCOUNT });
  assert.equal(frozen.script, c.dynamicCall(CORE, "freezeAccount", [c.hashValue(ACCOUNT)]));
  assert.throws(() => f.client.buildAccountActionScript({ method: "setAdmin", accountId: ACCOUNT }), /unknown account action/);
});

test("registration derives the id it registers and refuses a caller-supplied one", async () => {
  const f = fixture();
  const salt = "ab".repeat(32);
  const plan = f.client.buildCreateAccountScript({ custodyAddress: CUSTODY, salt });
  assert.equal(plan.kind, "registration");
  assert.equal(plan.accountId, c.deriveIdentity({ custodyAddress: CUSTODY, salt, coreContractHash: CORE, callFlags: 5 }).accountId);
  assert.equal(plan.accountAddress, f.client.proxyAddress(plan.accountId));
  assert.deepEqual(plan.signers, [plan.accountAddress]);
  // The registration script is the core call the plan names, with the id it
  // derived — not an id the caller supplied.
  assert.equal(
    plan.script,
    c.dynamicCall(CORE, "createAccount", [
      c.hashValue(plan.accountId),
      c.hashValue(CUSTODY),
      ARG_BYTES(salt),
      I(0),
      A([]),
    ]),
  );
});

test("execution only runs a plan this client prepared", async () => {
  const f = fixture();
  const plan = { kind: "account", method: "freezeAccount", accountId: ACCOUNT, signers: [], script: "00" };
  await assert.rejects(() => f.client.execute(plan), /unprepared plan/);
  assert.equal(f.client.prepare(plan), plan);
  await assert.rejects(() => f.client.execute({ ...plan }), /unprepared plan/);
  assert.throws(() => f.client.prepare({ script: "00" }), /malformed plan/);
});
