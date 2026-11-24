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
const coreManifest = require("../../../tests/fixtures/native-smartaccount.manifest.json");

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

/** The manifest emitted by the activated local native build. */
function manifest() {
  return structuredClone(coreManifest);
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
    implementation: "NativeSmartAccount",
    account: null,
    module: null,
  };
  const answer = (method, args, value, contract = CORE) =>
    responses.set(c.dynamicCall(contract, method, args, 5), value);
  const reset = () => {
    responses.clear();
    answer("getProtocolInfo", [], A([I(state.protocolVersion)]));
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
    /** The account descriptor as an N3 node returns it (15 fields). */
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
    implementationId: "NativeSmartAccount",
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
    ["incorrect parameter fingerprint", (f) => (f.state.abi.extra.smartAccount.profileParameterDigest =
      "00".repeat(32)), /profile parameters/],
    ["absent parameter binding", (f) => delete f.state.abi.extra, /profile parameters/],
    ["wrong parameter ABI", (f) => (f.state.abi.extra.smartAccount.abiVersion = 2), /profile parameters/],
    ["manifest name", (f) => (f.state.abi.name = "SmartAccountV3"), /not available/],
    [
      "missing method",
      (f) => (f.state.abi.abi.methods = f.state.abi.abi.methods.filter((method) => method.name !== "getModules")),
      /ABI mismatch: getModules/,
    ],
    [
      "missing native account address",
      (f) =>
        (f.state.abi.abi.methods = f.state.abi.abi.methods.filter(
          (method) => method.name !== "getAccountAddress",
        )),
      /ABI mismatch: getAccountAddress/,
    ],
    ["missing event", (f) => (f.state.abi.abi.events = []), /event mismatch: AccountRegistered/],
    [
      "parameter type",
      (f) => f.patchMethod("getModule", { parameters: [{ name: "accountId", type: "Integer" }, { name: "moduleId", type: "Integer" }] }),
      /ABI mismatch: getModule/,
    ],
    ["safe flag", (f) => f.patchMethod("getModule", { safe: false }), /ABI mismatch: getModule/],
    ["unknown wire tag", (f) => (f.state.protocolVersion = 255), /current SmartAccount protocol/],
    ["implementation id", (f) => (f.state.implementation = "DifferentSmartAccount"), /implementation id/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const f = fixture();
    mutate(f);
    f.reset();
    await assert.rejects(() => f.client.discover(), pattern, label);
    assert.equal(f.client.profile, null, `${label} must not leave a profile`);
  }
});

test("rediscovery clears prior approval when the node exposes a different interface", async () => {
  const f = fixture();
  await f.client.discover();
  f.state.abi.abi.methods.push({ ...f.state.abi.abi.methods[0], name: "foreignMethod" });
  f.reset();
  await assert.rejects(f.client.discover(), /unexpected native ABI method/);
  assert.equal(f.client.profile, null);
  await assert.rejects(f.client.getAccount(ACCOUNT), /unexpected native ABI method/);
});

test("the operation parameter is Array, never a substituted type", async () => {
  // The shared codec always serializes the 13-field operation as an Array, so
  // the declaration must be exactly Array. `Any` was the custom kernel
  // compiler's inference: there is no kernel left that declares it, and a type
  // the client never sends is a mismatch, not a tolerance.
  for (const type of ["Any", "ByteArray", "Integer"]) {
    const f = fixture();
    f.patchMethod("executeUserOp", {
      parameters: [{ name: "accountId", type: "Hash160" }, { name: "operation", type }],
    });
    await assert.rejects(() => f.client.discover(), /ABI mismatch: executeUserOp/, type);
  }

  // The account id is never substitutable either.
  const accountId = fixture();
  accountId.patchMethod("executeUserOp", {
    parameters: [{ name: "accountId", type: "ByteArray" }, { name: "operation", type: "Array" }],
  });
  await assert.rejects(() => accountId.client.discover(), /ABI mismatch: executeUserOp/);
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
  assert.throws(() => c.accountAddress(ACCOUNT, { coreContractHash: CORE, callFlags: 15 }), /ReadOnly/);
  assert.throws(() => f.client.deriveIdentity({ custodyAddress: ZERO, salt }), /custody/);
});

test("recovery plans distinguish a new recipient from a retained authority", async () => {
  const f = fixture();
  f.setAccount();
  const input = { accountId: ACCOUNT, recoveryTimelockMs: "604800000" };
  const retained = await f.client.buildRecoveryPolicyPlan({ ...input, recoveryAuthority: RECOVERY });
  assert.deepEqual(retained.signers, [CUSTODY]);
  const recipient = "71".repeat(20);
  const changed = await f.client.buildRecoveryPolicyPlan({ ...input, recoveryAuthority: recipient });
  assert.deepEqual(changed.signers, [CUSTODY, recipient]);
  assert.notEqual(changed.script, retained.script);
  await assert.rejects(() => f.client.buildRecoveryPolicyPlan({ ...input, recoveryAuthority: ZERO }));
});

test("batch reviews preserve action order and each change of recovery authority", async () => {
  const f = fixture();
  f.setAccount();
  const next = "81".repeat(20);
  const recovery = (recoveryAuthority) => ({ method: "setRecoveryPolicy", recoveryAuthority, recoveryTimelockMs: "604800000" });
  const input = { accountId: ACCOUNT, actions: [
    recovery(RECOVERY), recovery(next), recovery(next), recovery(RECOVERY),
    { method: "removeModule", moduleId: 3 }, { method: "setBuiltinAuthorization",
      defaultOperationAuthorization: true, defaultMessageAuthorization: false }] };
  const pending = f.client.buildConfigurationBatchPlan(input);
  input.actions[1].recoveryAuthority = CUSTODY;
  const plan = await pending;
  assert.deepEqual(plan.signers, [CUSTODY, next, RECOVERY]);
  const row = (hash) => A([I(8), ARG_HASH(hash), I(604800000), BOOL(false)]);
  assert.equal(plan.script, c.dynamicCall(CORE, "applyConfigurationActions", [ARG_HASH(ACCOUNT),
    A([row(RECOVERY), row(next), row(next), row(RECOVERY), A([I(2), I(3), A([])]), A([I(5), BOOL(true), BOOL(false)])])]));
  f.client.prepare(plan);
  f.setAccount({ configurationNonce: 12 });
  await assert.rejects(f.client.revalidatePlan(plan), /configuration changed/);
  await assert.rejects(f.client.buildConfigurationBatchPlan(input), /invalid recovery authority/);
  assert.throws(() => f.client.buildAccountActionScript({ accountId: ACCOUNT, method: "applyConfigurationActions" }), /buildConfigurationBatchPlan/);
  assert.throws(() => f.client.buildConfigurationBatchScript({ accountId: ACCOUNT, actions: [] }), /1 to 16/);
  assert.throws(() => f.client.buildConfigurationBatchScript({ accountId: ACCOUNT, actions: [ { method: "freezeAccount" } ] }), /unsupported/);
  const many = Array.from({length: 16}, (_, i) => recovery((128 + i).toString(16).repeat(20)));
  await assert.rejects(f.client.buildConfigurationBatchPlan({accountId: ACCOUNT, actions: many}), /more than 16 transaction signers/);
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
    ["invalid epoch gap", { epoch: 13, configurationNonce: 11 }, /invalid authority epoch/],
    ["zero epoch", { epoch: 0 }, /invalid authority epoch/],
    ["undefined status", { status: 2 }, /unknown account status/],
    ["zero custody", { custody: ZERO }, /invalid custody identity/],
    ["custody is the core", { custody: CORE }, /invalid custody identity/],
    ["recovery equals custody", { recovery: CUSTODY }, /invalid recovery identity/],
    ["status", { status: 7 }, /unknown account status/],
  ]) {
    const g = fixture();
    g.setAccount(patch);
    await assert.rejects(() => g.client.getAccount(ACCOUNT), pattern, label);
  }

  const fresh = fixture();
  fresh.setAccount({ epoch: 1, configurationNonce: 0 });
  assert.equal((await fresh.client.getAccount(ACCOUNT)).authorityEpoch, "1");
  const missing = fixture();
  missing.setAccount({ exists: false, custody: ZERO, recovery: ZERO });
  assert.equal(await missing.client.getAccount(ACCOUNT), null);
});

test("the account address read is the derived proxy, and any other answer is refused", async () => {
  const f = fixture();
  const address = f.client.proxyAddress(ACCOUNT);
  f.answer("getAccountAddress", [ARG_HASH(ACCOUNT)], H(address));
  assert.equal(await f.client.getAccountAddress(ACCOUNT), address);

  // The core derives the address from the same verification script this client
  // builds; an answer for another account (or another kernel's call flags)
  // means the deployment is not the one the client gated against.
  const other = fixture();
  other.answer("getAccountAddress", [ARG_HASH(ACCOUNT)], H("99".repeat(20)));
  await assert.rejects(
    () => other.client.getAccountAddress(ACCOUNT),
    /derived proxy address/,
  );

  // A zero answer is not an address, and no answer is an RPC failure rather
  // than a silently accepted zero.
  const zero = fixture();
  zero.answer("getAccountAddress", [ARG_HASH(ACCOUNT)], H(ZERO));
  await assert.rejects(() => zero.client.getAccountAddress(ACCOUNT), /no proxy address/);
  await assert.rejects(
    () => fixture().client.getAccountAddress(ACCOUNT),
    /script failed|unregistered script/,
  );
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
      { networkMagic: NETWORK, coreContractHash: CORE, accountId: ACCOUNT },
      { authorityEpoch: 7, validatorId: 2, credentialGeneration: 4, nonceSubkey: ZERO_SUBKEY },
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

  for (const partial of [{ credentialGeneration: 4 }, { authorityEpoch: 7 }]) {
    await assert.rejects(() => f.client.getNonce(ACCOUNT, { ...partial, validatorId: 2, nonceSubkey: ZERO_SUBKEY }),
      /requires both/);
  }
  // The kernel resolves the generation itself, so a caller without one is not
  // given a guessed default: only the channel the contract returned is used.
  const h = fixture();
  h.answer("getNonce", [ARG_HASH(ACCOUNT), I(2), ARG_BYTES(ZERO_SUBKEY)], I(packed));
  assert.deepEqual(
    await h.client.getNonce(ACCOUNT, { validatorId: 2, nonceSubkey: ZERO_SUBKEY }),
    { packed: packed.toString(), channel: routing, sequence: "9" },
  );
  // A caller whose generation has since advanced is refused, not silently
  // moved to the next channel: this is the ErrorCredentialStale case.
  const advanced = (BigInt(
    c.deriveNonceChannel(
      { networkMagic: NETWORK, coreContractHash: CORE, accountId: ACCOUNT },
      { authorityEpoch: 7, validatorId: 2, credentialGeneration: 5, nonceSubkey: ZERO_SUBKEY },
    ),
  ) << 64n) | 3n;
  const k = fixture();
  k.answer("getNonce", [ARG_HASH(ACCOUNT), I(2), ARG_BYTES(ZERO_SUBKEY)], I(advanced));
  await assert.rejects(
    () => k.client.getNonce(ACCOUNT, { authorityEpoch: 7, validatorId: 2, credentialGeneration: 4, nonceSubkey: ZERO_SUBKEY }),
    /credential generation or authority epoch is stale/,
  );
  assert.equal(
    (await k.client.getNonce(ACCOUNT, { authorityEpoch: 7, validatorId: 2, credentialGeneration: 5, nonceSubkey: ZERO_SUBKEY })).sequence,
    "3",
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
      credentialGeneration: "1",
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

  // Module administration is an account action: the core takes the module type,
  // the contract hash and the initData, and hands back the module id it
  // allocated. Nothing above the core assigns ids.
  const install = f.client.buildAccountActionScript({
    method: "installModule",
    accountId: ACCOUNT,
    args: [I(1), ARG_HASH(MODULE_CONTRACT), A([])],
  });
  assert.equal(install.kind, "account");
  assert.equal(install.script, c.dynamicCall(CORE, "installModule", [
    c.hashValue(ACCOUNT),
    I(1),
    c.hashValue(MODULE_CONTRACT),
    A([]),
  ]));
  const remove = f.client.buildAccountActionScript({
    method: "removeModule",
    accountId: ACCOUNT,
    args: [I(3), A([])],
  });
  assert.equal(remove.script, c.dynamicCall(CORE, "removeModule", [c.hashValue(ACCOUNT), I(3), A([])]));

  const frozen = f.client.buildAccountActionScript({ method: "freezeAccount", accountId: ACCOUNT });
  assert.equal(frozen.script, c.dynamicCall(CORE, "freezeAccount", [c.hashValue(ACCOUNT)]));
  assert.throws(() => f.client.buildAccountActionScript({ method: "setAdmin", accountId: ACCOUNT }), /unknown account action/);
  // Module workflows and read-only verification are not account writes.
  for (const retired of ["beginRecovery", "executeRecovery", "proposeConfiguration", "isValidSignature"])
    assert.throws(() => f.client.buildAccountActionScript({ method: retired, accountId: ACCOUNT }), /unknown account action/);
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

test("policy reads distinguish an active route, an inactive policy and a missing record", async () => {
  const f = fixture();
  const params = [ARG_HASH(ACCOUNT), I(9)];
  f.answer("getModule", params, A([]));
  f.answer("getThresholdPolicy", params, A([I(1), A([I(4)]), BOOL(true), I(7)]));
  assert.deepEqual(await f.client.getThresholdPolicy(ACCOUNT, 9), {
    policyId: "9",
    threshold: 1, memberIds: ["4"], active: true, credentialGeneration: "7",
  });
  assert.equal(await f.client.resolveCredentialGeneration(ACCOUNT, 9), "7");
  f.answer("getThresholdPolicy", params, A([I(0), A([]), BOOL(false), I(8)]));
  await assert.rejects(f.client.resolveCredentialGeneration(ACCOUNT, 9), /not installed/);
  f.answer("getThresholdPolicy", params, A([]));
  assert.equal(await f.client.getThresholdPolicy(ACCOUNT, 9), null);
  f.answer("getThresholdPolicy", params, A([I(2), A([I(4), I(4)]), BOOL(true), I(8)]));
  await assert.rejects(f.client.getThresholdPolicy(ACCOUNT, 9), /malformed threshold policy/);
});

test("discover the mandatory spending policy without knowing its ID", async () => {
  const f = fixture();
  const params = [ARG_HASH(ACCOUNT), I(0)];
  const read = () => f.client.getThresholdPolicy(ACCOUNT);
  f.answer("getThresholdPolicy", params, A([]));
  assert.equal(await read(), null);
  f.answer("getThresholdPolicy", params, A([I(2), A([I(4), I(5)]), BOOL(true), I(1), I(6)]));
  assert.deepEqual(await read(), {
    policyId: "6", threshold: 2, memberIds: ["4", "5"], active: true, credentialGeneration: "1",
  });
  for (const row of [
    [I(0), A([]), BOOL(false), I(1), I(6)],
    [I(2), A([I(4), I(5)]), BOOL(true), I(1), I(0)],
    [I(2), A([I(4), I(5)]), BOOL(true), I(1)],
  ]) {
    f.answer("getThresholdPolicy", params, A(row));
    await assert.rejects(read(), /malformed threshold policy/);
  }
});

test("message subject reads preserve both raw script-hash widths and the revision", async () => {
  const f = fixture();
  const ids = ["0123".repeat(10), "1234".repeat(16)];
  const reply = (subjects, threshold, revision) =>
    f.answer("getMessageSubjects", [ARG_HASH(ACCOUNT)], A([A(subjects.map(BYTES)), I(threshold), I(revision)]));
  reply(ids, 2, 13);
  assert.deepEqual(await f.client.getMessageSubjects(ACCOUNT), { subjects: ids, threshold: 2, subjectRevision: "13" });
  reply([ids[0], ids[0]], 1, 13);
  await assert.rejects(f.client.getMessageSubjects(ACCOUNT), /malformed message subjects/);
  reply(["02".repeat(33)], 1, 13);
  await assert.rejects(f.client.getMessageSubjects(ACCOUNT), /script identity width/);
});
