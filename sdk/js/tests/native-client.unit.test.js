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
  NATIVE_PROFILE_PARAMETER_DIGEST,
  NATIVE_SMART_ACCOUNT_CONTRACT: CORE,
} = require("../src/native");
const coreManifest = require("../../../tests/fixtures/native-smartaccount.manifest.json");
const { validateNativeInvocationResult } = require("../../../shared/nativeSmartAccountClient.mjs");

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
    moduleId: 1,
    // The chain time the current block header publishes.
    time: 1700000000000,
  };
  const answer = (method, args, value, contract = CORE) =>
    responses.set(c.dynamicCall(contract, method, args, 5), value);
  const reset = () => {
    responses.clear();
    answer("getProtocolInfo", [], A([I(state.protocolVersion)]));
    answer("getAccountImplementationId", [], TEXT(state.implementation));
    if (state.account) answer("getAccount", [ARG_HASH(ACCOUNT)], state.account);
    if (state.module) answer("getModule", [ARG_HASH(ACCOUNT), I(state.moduleId)], state.module);
  };
  reset();
  const rpcClient = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "getversion") return { protocol: { network: state.magic } };
      if (method === "getcontractstate")
        return { id: state.id, hash: state.hash, manifest: state.abi };
      if (method === "getblockcount") return 10;
      if (method === "getblockheader") return { time: state.time };
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
    /** The 9-field v4.1 account descriptor as an N3 node returns it. */
    setAccount({
      status = 0,
      custody = CUSTODY,
      epoch = 7,
      configurationNonce = 11,
      requiredValidatorId = 3,
      controlRevision = 5,
      exists = true,
    } = {}) {
      state.account = A([
        BOOL(exists),
        I(status),
        H(custody),
        I(epoch),
        I(configurationNonce),
        BOOL(true),
        BOOL(true),
        I(requiredValidatorId),
        I(controlRevision),
      ]);
      reset();
    },
    /** The 15-field v4.1 module descriptor, including the three v4.1 flags. */
    setModule({
      moduleId = 1,
      credentialGeneration = 4,
      eligible = true,
      contract = MODULE_CONTRACT,
      nefSha256 = "aa".repeat(32),
      profileSha256 = "bb".repeat(32),
      compositeLayer = false,
      governance = false,
      hookPlanner = false,
    } = {}) {
      state.module = A([
        I(moduleId),
        I(1),
        H(contract),
        I(7),
        I(2),
        BYTES(nefSha256),
        BYTES(profileSha256),
        I(9),
        I(credentialGeneration),
        BOOL(true),
        BOOL(true),
        BOOL(eligible),
        BOOL(compositeLayer),
        BOOL(governance),
        BOOL(hookPlanner),
      ]);
      state.moduleId = moduleId;
      reset();
    },
  };
}

test("discovery reads one profile and answers every later read from it", async () => {
  const f = fixture();
  const profile = await f.client.discover();
  // The profile is the protocol identity: ABI version plus the atomic
  // configuration parameter fingerprint the core published.
  assert.deepEqual(profile, {
    contract: CORE,
    networkMagic: NETWORK,
    protocolVersion: 4,
    profileParameterDigest: NATIVE_PROFILE_PARAMETER_DIGEST,
    implementationId: "NativeSmartAccount",
  });
  assert.equal(f.client.profile, profile);
  assert.deepEqual(await f.client.getProtocolInfo(), {
    protocolVersion: "4",
    profileParameterDigest: NATIVE_PROFILE_PARAMETER_DIGEST,
  });
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
      "00".repeat(32)), /protocol version is incompatible/],
    ["absent parameter binding", (f) => delete f.state.abi.extra, /protocol version is incompatible/],
    ["wrong parameter ABI", (f) => (f.state.abi.extra.smartAccount.abiVersion = 2), /protocol version is incompatible/],
    ["manifest name", (f) => (f.state.abi.name = "SmartAccountV3"), /not available/],
    [
      "missing method",
      (f) => (f.state.abi.abi.methods = f.state.abi.abi.methods.filter((method) => method.name !== "getModules")),
      /method getModules is missing/,
    ],
    [
      "missing native account address",
      (f) =>
        (f.state.abi.abi.methods = f.state.abi.abi.methods.filter(
          (method) => method.name !== "getAccountAddress",
        )),
      /method getAccountAddress is missing/,
    ],
    ["missing event", (f) => (f.state.abi.abi.events = []), /event AccountRegistered is missing/],
    [
      "parameter type",
      (f) => f.patchMethod("getModule", { parameters: [{ name: "accountId", type: "Integer" }, { name: "moduleId", type: "Integer" }] }),
      /method getModule is missing/,
    ],
    ["safe flag", (f) => f.patchMethod("getModule", { safe: false }), /method getModule is missing/],
    ["unknown wire tag", (f) => (f.state.protocolVersion = 255), /protocol version is incompatible/],
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
  // One extra method is a different interface: the v4.1 surface is frozen at 26.
  f.state.abi.abi.methods.push({ ...f.state.abi.abi.methods[0], name: "foreignMethod" });
  f.reset();
  await assert.rejects(f.client.discover(), /expected 26 methods, found 27/);
  assert.equal(f.client.profile, null);
  await assert.rejects(f.client.getAccount(ACCOUNT), /expected 26 methods, found 27/);
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
    await assert.rejects(() => f.client.discover(), /method executeUserOp is missing or has a different signature/, type);
  }

  // The account id is never substitutable either.
  const accountId = fixture();
  accountId.patchMethod("executeUserOp", {
    parameters: [{ name: "accountId", type: "ByteArray" }, { name: "operation", type: "Array" }],
  });
  await assert.rejects(() => accountId.client.discover(), /method executeUserOp is missing or has a different signature/);
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

test("recovery scripts target the installed seat, never the native core", () => {
  const f = fixture();
  const recipient = "71".repeat(20);
  // beginRecovery carries the account and the wallet that becomes custody;
  // cancel and execute read the pending record themselves, so they take the
  // account id alone.
  assert.equal(
    f.client.buildRecoveryScript({ accountId: ACCOUNT, targetContract: RECOVERY, action: "beginRecovery", newCustody: recipient }),
    c.dynamicCall(RECOVERY, "beginRecovery", [c.hashValue(ACCOUNT), c.hashValue(recipient)]),
  );
  assert.equal(
    f.client.buildRecoveryScript({ accountId: ACCOUNT, targetContract: RECOVERY, action: "beginRecovery" }),
    c.dynamicCall(RECOVERY, "beginRecovery", [c.hashValue(ACCOUNT), c.hashValue(ZERO)]),
  );
  for (const action of ["cancelRecovery", "executeRecovery"])
    assert.equal(
      f.client.buildRecoveryScript({ accountId: ACCOUNT, targetContract: RECOVERY, action, newCustody: recipient }),
      c.dynamicCall(RECOVERY, action, [c.hashValue(ACCOUNT)]),
    );
  // There is no native recovery method: only the three module entry points exist.
  for (const retired of ["setRecoveryPolicy", "getRecoveryPolicySnapshot", "executeRecoveryCore"])
    assert.throws(() => f.client.buildRecoveryScript({ accountId: ACCOUNT, targetContract: RECOVERY, action: retired }), /unsupported recovery operation/);
  // The core has no recovery entry: a target that names it, in any spelling, is
  // refused before a script exists, including on the receipt-restoration path.
  for (const action of ["beginRecovery", "cancelRecovery", "executeRecovery"]) {
    for (const target of [CORE, "0x" + CORE, CORE.toUpperCase()])
      assert.throws(
        () => f.client.buildRecoveryScript({ accountId: ACCOUNT, targetContract: target, action, newCustody: recipient }),
        /a recovery call cannot target the core/,
      );
  }
});

test("a thaw is two governance-module calls signed by custody, never a core thaw", async () => {
  const f = fixture();
  const GOVERNANCE = "55".repeat(20);
  const [ID, CONFIRM] = [c.dynamicCall(GOVERNANCE, "unfreezeAccount", [c.hashValue(ACCOUNT)]),
    c.dynamicCall(GOVERNANCE, "confirmConfiguration", [c.hashValue(ACCOUNT), I(4), A([A([I(11)])])])];
  /** The governance module's answers: its window, its queue, its bound core. */
  const setGovernanceSeat = ({ intents = [], delay = 86400000, core = CORE } = {}) => {
    f.answer("getModules", [ARG_HASH(ACCOUNT), c.stringValue("validator"), I(0), I(32)],
      A([A([I(3)]), I(0), I(11)]));
    f.answer("authorizedCore", [], H(core), GOVERNANCE);
    f.answer("configurationMaturity", [], I(delay), GOVERNANCE);
    f.answer("getPendingConfigurationIntentIds", [ARG_HASH(ACCOUNT)],
      A(intents.map((intent) => I(intent.intentId))), GOVERNANCE);
    for (const intent of intents)
      f.answer("getPendingConfiguration", [ARG_HASH(ACCOUNT), I(intent.intentId)], A([
        I(intent.intentId), TEXT(intent.kind), I(intent.proposedAt), I(intent.matureAt), I(intent.expiresAt),
        I(intent.epoch), I(intent.nonce), BYTES("ab".repeat(32)), I(intent.actionCount),
      ]), GOVERNANCE);
  };
  f.setAccount({ status: 1 });
  f.setModule({ moduleId: 3, governance: true, contract: GOVERNANCE });
  setGovernanceSeat();

  // Propose: GovernanceModule.UnfreezeAccount(accountId) -> intentId.
  const propose = await f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "unfreezeAccount" });
  assert.equal(propose.kind, "governance");
  assert.equal(propose.method, "unfreezeAccount");
  assert.equal(propose.targetContract, GOVERNANCE);
  assert.equal(propose.moduleId, "3");
  assert.equal(propose.intentId, null);
  assert.equal(propose.pending, null);
  assert.equal(propose.governanceDelayMs, "86400000");
  assert.equal(propose.configurationNonce, "11");
  // Both module entries check the custody witness alone (RequireCustody).
  assert.deepEqual(propose.signers, [CUSTODY]);
  assert.equal(propose.script, ID);
  assert.notEqual(propose.script, c.dynamicCall(CORE, "unfreezeAccount", [c.hashValue(ACCOUNT)]));
  // The proposal must return the intent id it allocated.
  assert.throws(() => validateNativeInvocationResult(propose, [{ type: "Any", value: null }]), /positive intent id/);
  assert.throws(() => validateNativeInvocationResult(propose, [I(0)]), /positive intent id/);
  assert.deepEqual(validateNativeInvocationResult(propose, [I(4)]), []);

  // Confirm: ConfirmConfiguration(accountId, intentId, [[11]]).
  assert.equal(
    f.client.buildGovernanceScript({ accountId: ACCOUNT, targetContract: GOVERNANCE, action: "confirmConfiguration", intentId: "4" }),
    CONFIRM,
  );
  for (const action of ["proposeConfiguration", "cancelConfiguration", "freezeAccount", "unfreeze"])
    assert.throws(() => f.client.buildGovernanceScript({ accountId: ACCOUNT, targetContract: GOVERNANCE, action }),
      /unsupported governance operation/);
  await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "cancelConfiguration" }),
    /unsupported governance operation/);
  // The core has no governance entry: a target that names it is refused, in any spelling.
  for (const action of ["unfreezeAccount", "confirmConfiguration"])
    for (const target of [CORE, "0x" + CORE, CORE.toUpperCase()])
      assert.throws(() => f.client.buildGovernanceScript({ accountId: ACCOUNT, targetContract: target, action, intentId: "4" }),
        /a governance call cannot target the core/);
  // Nothing pending: there is no confirmation to build.
  await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "confirmConfiguration", intentId: "4" }),
    /no pending unfreeze intent/);

  const time = f.state.time;
  const pending = { intentId: 4, kind: "unfreeze", proposedAt: time - 3600000, matureAt: time - 1000,
    expiresAt: time + 1000, epoch: 7, nonce: 11, actionCount: 1 };
  setGovernanceSeat({ intents: [pending] });
  await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "unfreezeAccount" }),
    /an unfreeze intent is already pending/);
  await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "confirmConfiguration", intentId: "5" }),
    /intent changed/);
  const confirm = await f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "confirmConfiguration", intentId: 4 });
  assert.equal(confirm.method, "confirmConfiguration");
  assert.equal(confirm.intentId, "4");
  assert.equal(confirm.pending.kind, "unfreeze");
  assert.deepEqual(confirm.signers, [CUSTODY]);
  assert.equal(confirm.script, CONFIRM);
  // The confirmation returns void.
  assert.deepEqual(validateNativeInvocationResult(confirm, [{ type: "Any", value: null }]), []);
  assert.throws(() => validateNativeInvocationResult(confirm, [I(1)]), /VM null item/);
  // A recheck that reads a different intent or account is refused.
  f.client.prepare(confirm);
  assert.equal(await f.client.revalidatePlan(confirm), true);
  setGovernanceSeat({ intents: [{ ...pending, proposedAt: time - 7200000 }] });
  await assert.rejects(() => f.client.revalidatePlan(confirm), /changed/);

  // Every module gate is mirrored before a script is signed.
  for (const [patch, pattern] of [
    [{ matureAt: time + 1 }, /has not matured/],
    [{ expiresAt: time - 1 }, /expired/],
    [{ epoch: 8 }, /epoch is stale/],
    [{ nonce: 12 }, /configuration nonce is stale/],
    [{ actionCount: 2 }, /not the single unfreeze action/],
    [{ kind: "configure" }, /no pending unfreeze intent/],
    [{ kind: "rotation" }, /unknown governance intent kind/],
  ]) {
    setGovernanceSeat({ intents: [{ ...pending, ...patch }] });
    await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "confirmConfiguration", intentId: 4 }),
      pattern, JSON.stringify(patch));
  }
  setGovernanceSeat({ intents: [pending, { ...pending, intentId: 5 }] });
  await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "confirmConfiguration", intentId: 4 }),
    /more than one unfreeze intent is pending/);

  // No supported governance instance, an instance bound to another core, or an
  // account that is not frozen: nothing is built.
  setGovernanceSeat({ core: "66".repeat(20) });
  await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "unfreezeAccount" }),
    /no supported governance module installed/);
  assert.deepEqual(await f.client.getGovernanceSeat(ACCOUNT),
    { seat: await f.client.getModule(ACCOUNT, 3), supported: false, governanceDelayMs: null, intentIds: [], intents: [] });
  setGovernanceSeat();
  f.setModule({ moduleId: 3, governance: false, contract: GOVERNANCE });
  setGovernanceSeat();
  await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "unfreezeAccount" }),
    /no supported governance module installed/);
  assert.deepEqual(await f.client.getGovernanceSeat(ACCOUNT),
    { seat: null, supported: false, governanceDelayMs: null, intentIds: [], intents: [] }, "a plain validator is not governance");
  f.setModule({ moduleId: 3, governance: true, contract: GOVERNANCE });
  setGovernanceSeat();
  f.setAccount({ status: 0 });
  setGovernanceSeat();
  await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "unfreezeAccount" }),
    /account is not frozen/);
  f.setAccount({ exists: false });
  setGovernanceSeat();
  await assert.rejects(() => f.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "unfreezeAccount" }),
    /account is not registered/);
});

test("configuration batches keep their action order and refuse retired codes", async () => {
  const f = fixture();
  f.setAccount();
  const next = "81".repeat(20);
  const profileDigest = "cd".repeat(32);
  const actions = [
    { method: "installModule", moduleType: 1, moduleContractHash: next, profileDigest, initData: [I(1)] },
    { method: "removeModule", moduleId: 3 },
    { method: "configureModule", moduleId: 4, data: [I(2)] },
    { method: "setBuiltinAuthorization", defaultOperationAuthorization: true, defaultMessageAuthorization: false },
    { method: "setRequiredValidator", validatorId: 3, required: true },
  ];
  const expected = c.dynamicCall(CORE, "applyConfigurationActions", [ARG_HASH(ACCOUNT), A([
    A([I(1), I(1), c.hashValue(next), ARG_BYTES(profileDigest), A([I(1)])]),
    A([I(2), I(3), A([])]),
    A([I(3), I(4), A([I(2)])]),
    A([I(5), BOOL(true), BOOL(false)]),
    A([I(7), I(3), BOOL(true)]),
  ])]);
  const plan = await f.client.buildConfigurationBatchPlan({ accountId: ACCOUNT, actions });
  assert.equal(plan.method, "applyConfigurationActions");
  assert.deepEqual(plan.signers, [CUSTODY]);
  assert.equal(plan.configurationNonce, "11");
  assert.equal(plan.governanceDelayMs, null);
  assert.equal(plan.script, expected);
  // The bytes are the reviewed input alone, so a receipt can be rebuilt after
  // the account has moved on; the plan itself is refused once it has.
  assert.equal(f.client.buildConfigurationBatchScript({ accountId: ACCOUNT, actions }), expected);
  f.client.prepare(plan);
  f.setAccount({ configurationNonce: 12 });
  await assert.rejects(f.client.revalidatePlan(plan), /configuration changed/);
  assert.throws(() => f.client.buildAccountActionScript({ accountId: ACCOUNT, method: "applyConfigurationActions" }), /buildConfigurationBatchPlan/);
  assert.throws(() => f.client.buildConfigurationBatchScript({ accountId: ACCOUNT, actions: [] }), /1 to 16/);
  for (const retired of ["freezeAccount", "setRecoveryPolicy", "setHookPolicy", "revokeModuleCredentials"])
    assert.throws(() => f.client.buildConfigurationBatchScript({ accountId: ACCOUNT, actions: [{ method: retired }] }), /unsupported configuration action/, retired);
  await assert.rejects(f.client.buildConfigurationBatchPlan({ accountId: ACCOUNT, actions: [
    { method: "installModule", moduleType: 2, moduleContractHash: next, profileDigest }] }), /module type/);
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
  assert.equal(account.authorityEpoch, "7");
  assert.equal(account.configurationNonce, "11");
  assert.equal(account.defaultOperationAuthorization, true);
  assert.equal(account.defaultMessageAuthorization, true);
  assert.equal(account.requiredValidatorId, "3");
  assert.equal(account.controlRevision, "5");
  assert.equal(Object.isFrozen(account), true);
  // Nine fields are the whole v4.1 descriptor; the v4.0 recovery authority,
  // hook-order revision and escrow flag are not part of it.
  assert.deepEqual(Object.keys(account).sort(), [
    "accountAddress", "accountId", "authorityEpoch", "configurationNonce",
    "controlRevision", "custodyAddress", "defaultMessageAuthorization",
    "defaultOperationAuthorization", "exists", "requiredValidatorId", "status",
    "statusName",
  ]);

  for (const [label, patch, pattern] of [
    ["invalid epoch gap", { epoch: 13, configurationNonce: 11 }, /invalid authority epoch/],
    ["zero epoch", { epoch: 0 }, /invalid authority epoch/],
    ["undefined status", { status: 2 }, /unknown account status/],
    ["zero custody", { custody: ZERO }, /invalid custody identity/],
    ["custody is the core", { custody: CORE }, /invalid custody identity/],
    ["custody is the proxy", { custody: f.client.proxyAddress(ACCOUNT) }, /invalid custody identity/],
  ]) {
    const g = fixture();
    g.setAccount(patch);
    await assert.rejects(() => g.client.getAccount(ACCOUNT), pattern, label);
  }

  const fresh = fixture();
  fresh.setAccount({ epoch: 1, configurationNonce: 0 });
  assert.equal((await fresh.client.getAccount(ACCOUNT)).authorityEpoch, "1");
  const missing = fixture();
  missing.setAccount({ exists: false, custody: ZERO });
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
  const operation = {
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
  };
  const single = f.client.buildExecutionScript({ accountId: ACCOUNT, operation });
  assert.equal(single.method, "executeUserOp");
  assert.deepEqual(single.operation, operation, "the plan carries the whole 13-field operation");
  assert.equal(single.proxyCallFlags, 5);
  assert.deepEqual(single.signers, [f.client.proxyAddress(ACCOUNT)]);
  assert.equal(single.script, c.buildExecutionScript(ACCOUNT, operation, {
    networkMagic: NETWORK,
    coreContractHash: CORE,
    accountId: ACCOUNT,
  }));

  // The retired batch entry has no plan: a list is refused, never split.
  assert.throws(
    () => f.client.buildExecutionScript({ accountId: ACCOUNT, operations: [operation] }),
    /protocol-incompatible: executeUserOps is retired in v4.1/,
  );
  assert.throws(
    () => f.client.buildExecutionScript({ accountId: ACCOUNT, operation: [operation, operation] }),
    /protocol-incompatible: executeUserOps is retired in v4.1/,
  );
  assert.throws(() => f.client.buildExecutionScript({ accountId: ACCOUNT }), /one complete 13-field operation/);

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
      A([]),
    ]),
  );
});

test("registration admits only the install shape the core validates", () => {
  const f = fixture();
  const salt = "ab".repeat(32);
  const profileDigest = "cd".repeat(32);
  const id = c.hashValue(
    c.deriveIdentity({ custodyAddress: CUSTODY, salt, coreContractHash: CORE, callFlags: 5 }).accountId);
  const build = (actions) => f.client.buildCreateAccountScript({ custodyAddress: CUSTODY, salt, actions }).script;
  const createAccount = (actions) =>
    c.dynamicCall(CORE, "createAccount", [id, c.hashValue(CUSTODY), ARG_BYTES(salt), A(actions)]);
  const install = (moduleType, contract = MODULE_CONTRACT, profile = profileDigest, initData = [I(1)]) =>
    A([I(1), I(moduleType), c.hashValue(contract), ARG_BYTES(profile), A(initData)]);

  // v4.1 registration installs modules only: validator (1), hook (4) and
  // recovery (5). Every later addition is an applyConfigurationActions batch.
  const mixed = [install(1), install(4), install(5),
    install(1, MODULE_CONTRACT, profileDigest, Array.from({ length: 64 }, () => I(1)))];
  assert.equal(build(mixed), createAccount(mixed));
  assert.equal(build([]), createAccount([]));
  // The per-registration cap is inclusive (MaxActionsPerRegistration).
  const sixteen = Array.from({ length: 16 }, () => install(1));
  assert.equal(build(sixteen), createAccount(sixteen));

  // Every other action code is refused before signing: uninstall (2),
  // configure (3), authorize (5), required validator (7), and the retired
  // codes 4, 6, 8, 9 and 10 have no registration operand at all.
  for (const [label, actions] of [
    ["17 actions", Array.from({ length: 17 }, () => install(1))],
    ["not a list", "actions"],
    ["Struct action", { type: "Struct", value: [I(1), I(1), c.hashValue(MODULE_CONTRACT), ARG_BYTES(profileDigest), A([])] }],
    ["untyped action", [[1, 1, MODULE_CONTRACT, profileDigest, []]]],
    ["empty action", A([])],
    ["non-integer code", A([{ type: "ByteString", value: "01" }])],
    ["negative code", A([I(-1)])],
    ["uninstall (2)", A([I(2), I(3), A([])])],
    ["configure (3)", A([I(3), I(1), A([])])],
    ["authorize (5)", A([I(5), BOOL(false), BOOL(true)])],
    ["required validator (7)", A([I(7), I(3), BOOL(true)])],
    ["retired recovery policy (8)", A([I(8), c.hashValue(RECOVERY), I(604800000), BOOL(false)])],
    ["retired hook policy (9)", A([I(9), A([])])],
    ["retired code 4", A([I(4), I(1)])],
    ["retired code 6", A([I(6), I(1)])],
    ["retired code 10", A([I(10), I(1)])],
    ["install arity 4", A([I(1), I(1), c.hashValue(MODULE_CONTRACT), ARG_BYTES(profileDigest)])],
    ["install arity 6", A([I(1), I(1), c.hashValue(MODULE_CONTRACT), ARG_BYTES(profileDigest), A([]), I(0)])],
    ["install type 0", install(0)],
    ["install type 2 (retired)", install(2)],
    ["install type 3", install(3)],
    ["install type 6", install(6)],
    ["install type not an Integer", A([I(1), { type: "ByteString", value: "01" }, c.hashValue(MODULE_CONTRACT), ARG_BYTES(profileDigest), A([])])],
    ["zero module address", install(1, ZERO)],
    ["19-byte module address", A([I(1), I(1), ARG_BYTES("44".repeat(19)), ARG_BYTES(profileDigest), A([])])],
    ["module address type", A([I(1), I(1), I(5), ARG_BYTES(profileDigest), A([])])],
    ["31-byte digest", install(1, MODULE_CONTRACT, "cd".repeat(31))],
    ["33-byte digest", install(1, MODULE_CONTRACT, "cd".repeat(33))],
    ["digest type", A([I(1), I(1), c.hashValue(MODULE_CONTRACT), I(5), A([])])],
    ["null initData", A([I(1), I(1), c.hashValue(MODULE_CONTRACT), ARG_BYTES(profileDigest), { type: "Null" }])],
    ["65 initData entries", install(1, MODULE_CONTRACT, profileDigest, Array(65).fill(I(1)))],
    ["Struct initData member", install(1, MODULE_CONTRACT, profileDigest, [{ type: "Struct", value: [I(1)] }])],
    ["untyped initData member", install(1, MODULE_CONTRACT, profileDigest, [1])],
  ])
    assert.throws(() => build(actions), `actions: ${label}`);

  // The operands are re-encoded copies: the script is byte-identical to the
  // canonical form even when the caller spelled a hex field with a prefix or
  // uppercase.
  const loose = A([I("1"), I(1), { type: "ByteString", value: "0x" + MODULE_CONTRACT.toUpperCase() },
    { type: "ByteString", value: profileDigest.toUpperCase() }, A([{ type: "Integer", value: "1" }])]);
  assert.equal(build([loose]), createAccount([install(1)]));
});

test("execution only runs a plan this client prepared", async () => {
  const f = fixture();
  const plan = { kind: "account", method: "freezeAccount", accountId: ACCOUNT, signers: [], script: "00" };
  await assert.rejects(() => f.client.execute(plan), /unprepared plan/);
  assert.equal(f.client.prepare(plan), plan);
  await assert.rejects(() => f.client.execute({ ...plan }), /unprepared plan/);
  assert.throws(() => f.client.prepare({ script: "00" }), /malformed plan/);
});

test("credential generations and member validation come from the instance, not a native policy", async () => {
  const f = fixture();
  f.setAccount();
  // Custody is generation 1 on every account; a module route reports the
  // generation the installed instance currently advertises.
  assert.equal(await f.client.resolveCredentialGeneration(ACCOUNT, 0), "1");
  assert.equal(await f.client.resolveCredentialGeneration(ACCOUNT), "1");
  f.setModule({ moduleId: 9, credentialGeneration: 7 });
  assert.equal(await f.client.resolveCredentialGeneration(ACCOUNT, 9), "7");

  const absent = fixture();
  absent.setAccount();
  absent.answer("getModule", [ARG_HASH(ACCOUNT), I(9)], A([]));
  await assert.rejects(absent.client.resolveCredentialGeneration(ACCOUNT, 9), /validator is not installed/);
  const unregistered = fixture();
  unregistered.setAccount({ exists: false, custody: ZERO });
  await assert.rejects(unregistered.client.resolveCredentialGeneration(ACCOUNT, 0), /account is not registered/);

  // §5 member validation is one boolean per instance for one operation digest;
  // a threshold quorum is a user-space policy and is never read from the core.
  const operationDigest = "ef".repeat(32);
  const operation = {
    version: 4, targetContract: CUSTODY, method: "transfer", args: [], nonce: "0",
    nonceSubkey: ZERO_SUBKEY, deadline: "9999999999999", validatorId: "2",
    credentialGeneration: "1", authorityEpoch: "1", configurationNonce: "1",
    signature: "01".repeat(64), hookProofs: [],
  };
  const params = [ARG_HASH(ACCOUNT), I(4), ARG_BYTES(operationDigest), c.operationValue(operation)];
  const member = fixture();
  member.answer("validateMember", params, BOOL(true));
  assert.equal(await member.client.validateMember(ACCOUNT, 4, operationDigest, operation), true);
  member.answer("validateMember", params, BOOL(false));
  assert.equal(await member.client.validateMember(ACCOUNT, 4, operationDigest, operation), false);
  member.answer("validateMember", params, I(1));
  await assert.rejects(member.client.validateMember(ACCOUNT, 4, operationDigest, operation), /malformed member validation result/);
  await assert.rejects(member.client.validateMember(ACCOUNT, -1, operationDigest, operation));
  await assert.rejects(member.client.validateMember(ACCOUNT, 4, "ef", operation), /hex/);
});

test("module pages carry the ids, the cursor and the configuration nonce they were read at", async () => {
  const f = fixture();
  f.setAccount();
  const params = [ARG_HASH(ACCOUNT), c.stringValue("validator"), I(0), I(32)];
  f.answer("getModules", params, A([A([I(1), I(4)]), I(5), I(11)]));
  assert.deepEqual(await f.client.getModules(ACCOUNT, "validator"), {
    moduleIds: ["1", "4"], nextCursor: "5", configurationNonce: "11",
  });
  // The cursor and the page size are echoed back, so paging is deterministic.
  f.answer("getModules", [ARG_HASH(ACCOUNT), c.stringValue("validator"), I(5), I(2)], A([A([]), I(0), I(11)]));
  assert.deepEqual(await f.client.getModules(ACCOUNT, "validator", { cursor: 5, limit: 2 }), {
    moduleIds: [], nextCursor: "0", configurationNonce: "11",
  });
  // A page id is an Integer on the wire (GetModule answers the big-endian word),
  // so a byte word here is malformed rather than silently reinterpreted.
  f.answer("getModules", params, A([A([BYTES("00".repeat(8))]), I(0), I(11)]));
  await assert.rejects(f.client.getModules(ACCOUNT, "validator"), /malformed module id/);
  f.answer("getModules", params, A([A([I(1)]), I(0)]));
  await assert.rejects(f.client.getModules(ACCOUNT, "validator"), /malformed module page/);
  await assert.rejects(f.client.getModules(ACCOUNT, "threshold"), /unsupported module type/);
});

test("message verification runs the installed signing module, never the native core", async () => {
  const f = fixture();
  f.setModule({ moduleId: 3 });
  const roster = [ARG_HASH(ACCOUNT), c.stringValue("validator"), I(0), I(32)];
  f.answer("getModules", roster, A([A([I(3)]), I(0), I(11)]));
  const messageHash = "ab".repeat(32);
  // SigningModule.IsValidSignature takes one flat object[] that alternates
  // script and signature ByteStrings; a nested pair would fail its byte checks.
  const pair = [ARG_BYTES("21".repeat(20)), ARG_BYTES("30".repeat(64))];
  const input = { accountId: ACCOUNT, originalSender: CUSTODY, validatorId: 3, generation: 4,
    hash: messageHash, pairs: [["21".repeat(20), "30".repeat(64)]] };
  const call = [ARG_HASH(ACCOUNT), ARG_HASH(CUSTODY), I(3), I(4), ARG_BYTES(messageHash), A(pair)];
  f.answer("isValidSignature", call, BOOL(true), MODULE_CONTRACT);
  assert.deepEqual(await f.client.verifyMessage(input),
    { accepted: true, moduleId: "3", contractHash: MODULE_CONTRACT });
  // The script that ran is the module's isValidSignature entry byte for byte:
  // the retired native method is never the target, even when the core exists.
  const invoked = f.calls.filter((entry) => entry.method === "invokescript")
    .map((entry) => Buffer.from(entry.params[0], "base64").toString("hex"));
  assert.deepEqual(invoked.slice(-1), [c.dynamicCall(MODULE_CONTRACT, "isValidSignature", call, 5)]);
  assert.equal(invoked.includes(c.dynamicCall(CORE, "isValidSignature", call, 5)), false);

  // Two pairs flatten into one four-element array, never two nested arrays.
  const flatCall = [ARG_HASH(ACCOUNT), ARG_HASH(CUSTODY), I(3), I(4), ARG_BYTES(messageHash),
    A([ARG_BYTES("21".repeat(20)), ARG_BYTES("30".repeat(64)),
      ARG_BYTES("22".repeat(20)), ARG_BYTES("31".repeat(64))])];
  assert.equal(
    f.client.buildMessageVerificationScript({ accountId: ACCOUNT, originalSender: CUSTODY,
      validatorId: 3, generation: 4, hash: messageHash,
      pairs: [["21".repeat(20), "30".repeat(64)], ["22".repeat(20), "31".repeat(64)]],
      module: { moduleId: 3, contractHash: MODULE_CONTRACT, messageCapability: true } }),
    c.dynamicCall(MODULE_CONTRACT, "isValidSignature", flatCall, 5),
  );

  // Without an active message-capable instance the client refuses; it does not
  // fall back to a core method that no longer exists.
  const bare = fixture();
  bare.answer("getModules", roster, A([A([]), I(0), I(11)]));
  await assert.rejects(bare.client.verifyMessage(input), /no active message-capable signing module/);

  f.answer("isValidSignature", call, I(1), MODULE_CONTRACT);
  await assert.rejects(f.client.verifyMessage(input), /malformed message signature result/);
});
