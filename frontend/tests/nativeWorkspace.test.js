import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createNativeWorkspace,
  actionBlockReason,
  nativeCodec,
  nativeAddress,
  nativeGasLimit,
  buildRecoveryDescriptor,
  readRecoveryDescriptor,
  nativeWalletNetwork,
  createNativeRpc,
  rebuildNativeReview,
  validateNativeReceipt,
  describeConfigurationAction,
  installModuleAction,
  uninstallModuleAction,
  configureModuleAction,
  rebindModuleCodeAction,
  setHookOrderAction,
  setDefaultPolicyAction,
  setThresholdPolicyAction,
  setRecoveryPolicyAction,
  NATIVE_ACTIONS,
  NATIVE_ACTION_CODES,
  NATIVE_MODULE_LIMITS,
  NATIVE_MODULE_TYPES,
  NATIVE_PROXY_CALL_FLAGS,
  NATIVE_SMART_ACCOUNT_CONTRACT,
  NATIVE_STATUS_NAMES,
  NATIVE_THRESHOLD_LIMITS,
  CONFIGURATION_INTENT_EXPIRY_MS,
  MAX_ACTIONS_PER_INTENT,
  MAX_ACTIVE_INTENTS,
  MAX_OPERATIONS_PER_ENVELOPE,
  MODULE_CHANGE_DELAY_MS,
  RECOVERY_TIMELOCK_MAX_MS,
  RECOVERY_TIMELOCK_MIN_MS,
} from "../src/features/native/nativeWorkspace.js";
import { createNativeClientClass } from "../src/shared/nativeSmartAccountClient.mjs";
import {
  createNativeRpcFixture,
  nativeTestCustody,
  nativeTestIdentity,
  nativeTestRecovery,
  nativeTestSalt,
} from "./fixtures/nativeRpcFixture.js";

const custody = nativeTestCustody,
  recovery = nativeTestRecovery,
  salt = nativeTestSalt,
  stranger = "66".repeat(20);
const profile = {
  contract: NATIVE_SMART_ACCOUNT_CONTRACT,
  networkMagic: 123,
  protocolVersion: 4,
  implementationId: "NativeSmartAccount/v4",
};
const Client = createNativeClientClass(nativeCodec, {
  callFlags: NATIVE_PROXY_CALL_FLAGS,
});
const I = (value) => ({ type: "Integer", value: String(value) });
const B = (hex) => ({ type: "ByteString", value: hex });
const A = (value) => ({ type: "Array", value });
const BOOL = (value) => ({ type: "Boolean", value });

/** A real browser client over the v4 fixture: nothing here is stubbed but the node. */
async function connected({ registered = false, mutate } = {}) {
  const rpc = createNativeRpcFixture();
  rpc.state.registered = registered;
  if (mutate) mutate(rpc.state);
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  const workspace = createNativeWorkspace({ makeClient: () => client });
  await workspace.connect({});
  return { rpc, client, workspace };
}

test("the workspace exports the v4 surface and no v3 alias", async () => {
  const module = await import("../src/features/native/nativeWorkspace.js");
  for (const removed of [
    "NATIVE_PROFILE_PARAMETER_DIGEST",
    "createNativeCodec",
    "buildRegistration",
    "buildAction",
    "prepareOperation",
    "inspectPolicy",
    "activatePolicy",
    "buildSessionArguments",
    "buildMultiSigArguments",
    "NATIVE_MULTISIG_LIMITS",
    "NATIVE_VERIFIER_ACTIONS",
  ])
    assert.equal(removed in module, false, `${removed} must not survive the v4 port`);
  assert.deepEqual(NATIVE_ACTION_CODES, {
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
  assert.deepEqual(NATIVE_STATUS_NAMES, ["Active", "Frozen", "MigrationRequired"]);
  assert.equal(NATIVE_PROXY_CALL_FLAGS, 5, "the native proxy calls verify read-only");
  assert.deepEqual(NATIVE_ACTIONS.map((entry) => entry.value), [
    "freezeAccount",
    "unfreezeAccount",
    "beginRecovery",
    "executeRecovery",
    "cancelRecovery",
  ]);
  assert.deepEqual(
    NATIVE_ACTIONS.filter((entry) => entry.address).map((entry) => entry.value),
    ["beginRecovery"],
  );
});

test("configuration limits and delays track the contract source", () => {
  const source = readFileSync(
    new URL(
      "../../contracts/native/SmartAccount/SmartAccountModuleProtocol.cs",
      import.meta.url,
    ),
    "utf8",
  );
  const constant = (name, type = "int") => {
    const match = new RegExp(`${type} ${name} = ([0-9_]+);`).exec(source);
    assert.ok(match, `${name} must stay an explicit constant`);
    return Number(match[1].replaceAll("_", ""));
  };
  assert.equal(MODULE_CHANGE_DELAY_MS, constant("ModuleChangeDelayMs", "ulong"));
  assert.equal(
    CONFIGURATION_INTENT_EXPIRY_MS,
    constant("ConfigurationIntentExpiryMs", "ulong"),
  );
  assert.equal(
    RECOVERY_TIMELOCK_MIN_MS,
    constant("RecoveryTimelockMinMs", "ulong"),
  );
  assert.equal(
    RECOVERY_TIMELOCK_MAX_MS,
    constant("RecoveryTimelockMaxMs", "ulong"),
  );
  assert.equal(
    MODULE_CHANGE_DELAY_MS,
    86_400_000,
    "a configuration intent matures after 24 hours",
  );
  assert.equal(CONFIGURATION_INTENT_EXPIRY_MS, 604_800_000, "matureAt + 7 days");
  assert.equal(RECOVERY_TIMELOCK_MIN_MS, 7 * 86_400_000);
  assert.equal(RECOVERY_TIMELOCK_MAX_MS, 90 * 86_400_000);
  assert.equal(MAX_ACTIONS_PER_INTENT, constant("MaxActionsPerConfigurationIntent"));
  assert.equal(MAX_ACTIVE_INTENTS, constant("MaxActiveConfigurationIntents"));
  assert.equal(MAX_OPERATIONS_PER_ENVELOPE, constant("MaxOperationsPerEnvelope"));
  assert.deepEqual(NATIVE_MODULE_LIMITS, {
    validator: constant("MaxValidatorModuleInstances"),
    hook: constant("MaxHookModuleInstances"),
  });
  assert.deepEqual(NATIVE_MODULE_TYPES, {
    validator: constant("ModuleTypeCodeValidator"),
    hook: constant("ModuleTypeCodeHook"),
  });
  assert.deepEqual(NATIVE_THRESHOLD_LIMITS, {
    maxMembers: constant("MaxThresholdPolicyMembers"),
    minValue: constant("MinThresholdPolicyValue"),
    maxValue: constant("MaxThresholdPolicyValue"),
  });
});

test("configuration actions serialize to the positional Arrays the core dispatches", () => {
  const moduleHash = "77".repeat(20),
    digest = "ab".repeat(32);
  assert.deepEqual(
    installModuleAction({
      moduleType: "validator",
      contractHash: moduleHash,
      profileDigest: digest,
      initData: [I(1)],
    }),
    A([
      I(1),
      I(1),
      nativeCodec.hashValue(moduleHash),
      B(digest),
      A([I(1)]),
    ]),
  );
  assert.deepEqual(uninstallModuleAction({ moduleId: 3 }), A([I(2), I(3), A([])]));
  assert.deepEqual(configureModuleAction({ moduleId: 4 }), A([I(3), I(4), A([])]));
  assert.deepEqual(rebindModuleCodeAction({ moduleId: 5, profileDigest: digest }), A([
    I(6),
    I(5),
    B(digest),
  ]));
  assert.deepEqual(setHookOrderAction({ hookIds: [2, 3] }), A([
    I(4),
    A([I(2), I(3)]),
  ]));
  assert.deepEqual(
    setDefaultPolicyAction({ operationAuthorization: false, messageAuthorization: true }),
    A([I(5), BOOL(false), BOOL(true)]),
  );
  assert.deepEqual(
    setThresholdPolicyAction({ policyId: 2, threshold: 2, memberIds: [1, 2] }),
    A([I(7), I(2), I(2), A([I(1), I(2)]), BOOL(true)]),
  );
  assert.deepEqual(
    setThresholdPolicyAction({ threshold: 1, memberIds: [], active: false }),
    A([I(7), I(0), I(1), A([]), BOOL(false)]),
  );
  assert.deepEqual(
    setRecoveryPolicyAction({
      recoveryAuthority: recovery,
      recoveryTimelockMs: String(RECOVERY_TIMELOCK_MIN_MS),
      ownerOnlyRecovery: true,
    }),
    A([I(8), nativeCodec.hashValue(recovery), I(RECOVERY_TIMELOCK_MIN_MS), BOOL(true)]),
  );
});

test("configuration actions reject unreachable, duplicate and out-of-range inputs", () => {
  const digest = "ab".repeat(32);
  const invalid = [
    () => installModuleAction({ moduleType: 2, contractHash: custody, profileDigest: digest }),
    () => installModuleAction({ moduleType: "validator", contractHash: "00".repeat(20), profileDigest: digest }),
    () => installModuleAction({ moduleType: "validator", contractHash: custody, profileDigest: "ab" }),
    () => installModuleAction({ moduleType: "validator", contractHash: custody, profileDigest: digest, initData: Array(65).fill(I(1)) }),
    () => uninstallModuleAction({ moduleId: -1 }),
    () => setHookOrderAction({ hookIds: [1, 1] }),
    () => setHookOrderAction({ hookIds: Array(NATIVE_MODULE_LIMITS.hook + 1).fill(0).map((_, index) => index + 1) }),
    () => setThresholdPolicyAction({ threshold: 0, memberIds: [1] }),
    () => setThresholdPolicyAction({ threshold: 11, memberIds: [1] }),
    () => setThresholdPolicyAction({ threshold: 3, memberIds: [1, 2] }),
    () => setThresholdPolicyAction({ threshold: 1, memberIds: [] }),
    () => setThresholdPolicyAction({ threshold: 1, memberIds: [1, 1] }),
    () => setThresholdPolicyAction({ threshold: 1, memberIds: Array(11).fill(0).map((_, index) => index + 1) }),
    () => setThresholdPolicyAction({ threshold: 1, memberIds: [1], active: false }),
    () => setRecoveryPolicyAction({ recoveryTimelockMs: "0" }),
    () => setRecoveryPolicyAction({ recoveryTimelockMs: String(RECOVERY_TIMELOCK_MAX_MS + 1) }),
  ];
  for (const build of invalid) assert.throws(build);
});

test("pending intents describe themselves without inventing a module", () => {
  assert.equal(
    describeConfigurationAction(
      installModuleAction({ moduleType: "hook", contractHash: "ab".repeat(20), profileDigest: "cc".repeat(32) }),
    ),
    "Install hook module abababab…",
  );
  assert.equal(describeConfigurationAction(uninstallModuleAction({ moduleId: 7 })), "Uninstall module 7");
  assert.equal(describeConfigurationAction(configureModuleAction({ moduleId: 8 })), "Reconfigure module 8");
  assert.equal(describeConfigurationAction(setHookOrderAction({ hookIds: [3, 4] })), "Set hook order [3 → 4]");
  assert.equal(
    describeConfigurationAction(setDefaultPolicyAction({ operationAuthorization: false, messageAuthorization: true })),
    "Built-in route: operations off, messages on",
  );
  assert.match(
    describeConfigurationAction(setThresholdPolicyAction({ threshold: 2, memberIds: [1, 2, 3] })),
    /^Threshold policy 0: 2-of-3$/,
  );
  assert.match(
    describeConfigurationAction(setRecoveryPolicyAction({ recoveryAuthority: recovery, recoveryTimelockMs: String(RECOVERY_TIMELOCK_MIN_MS) })),
    /7-day timelock$/,
  );
  assert.equal(describeConfigurationAction(A([I(99)])), "Action 99");
  assert.equal(describeConfigurationAction({ type: "Integer", value: "1" }), "Unrecognized action");
});

test("recovery descriptor is public, roundtrips and rejects identity or network substitution", () => {
  const descriptor = buildRecoveryDescriptor({
    custodyAddress: custody,
    salt,
    networkMagic: 123,
    contract: NATIVE_SMART_ACCOUNT_CONTRACT,
    recoveryTimelockMs: String(RECOVERY_TIMELOCK_MIN_MS),
  });
  assert.equal(descriptor.format, "neo-native-account-descriptor");
  assert.equal(descriptor.version, 2);
  assert.equal(descriptor.protocolVersion, 4);
  assert.equal(descriptor.callFlags, NATIVE_PROXY_CALL_FLAGS);
  assert.equal(descriptor.accountId, nativeTestIdentity.accountId);
  assert.equal(descriptor.accountAddress, nativeTestIdentity.accountAddress);
  assert.equal(
    readRecoveryDescriptor(JSON.stringify(descriptor), profile).accountId,
    nativeTestIdentity.accountId,
  );
  for (const patch of [
    { accountId: "44".repeat(20) },
    { accountAddress: "44".repeat(20) },
    { networkMagic: 456 },
    { protocolVersion: 3 },
    { version: 1 },
    { callFlags: 15 },
    { salt: "ff" },
    { custodyAddress: "00".repeat(20) },
  ])
    assert.throws(() =>
      readRecoveryDescriptor(JSON.stringify({ ...descriptor, ...patch }), profile),
    );
  assert.throws(() =>
    readRecoveryDescriptor(
      JSON.stringify(descriptor),
      { ...profile, networkMagic: 456 },
    ),
  );
  assert.throws(() =>
    readRecoveryDescriptor(JSON.stringify(descriptor), { ...profile, contract: "aa".repeat(20) }),
  );
  assert.equal(JSON.stringify(descriptor).includes("private"), false);
  assert.throws(() => readRecoveryDescriptor("x".repeat(20000), profile));
  assert.throws(() =>
    buildRecoveryDescriptor({
      custodyAddress: custody,
      salt,
      networkMagic: 123,
      contract: NATIVE_SMART_ACCOUNT_CONTRACT,
      recoveryTimelockMs: "1",
    }),
  );
});

test("addresses, GAS limits and wallet network stay exact", () => {
  assert.equal(nativeAddress("0x" + custody), custody);
  assert.equal(nativeAddress(custody.toUpperCase()), custody.toUpperCase().toLowerCase());
  assert.throws(() => nativeAddress("0x123"));
  assert.throws(() => nativeAddress("00".repeat(20)));
  assert.throws(() => nativeAddress(NATIVE_SMART_ACCOUNT_CONTRACT));
  assert.equal(nativeAddress("00".repeat(20), { zero: true }), "00".repeat(20));

  assert.equal(nativeGasLimit("0.00000001"), "1");
  assert.equal(nativeGasLimit("1.23456789"), "123456789");
  assert.equal(nativeGasLimit("0"), "0");
  for (const invalid of ["", "1e2", "-1", "0.000000001", "01", "Infinity", "92233720369"])
    assert.throws(() => nativeGasLimit(invalid), /fee|GAS/);

  assert.equal(nativeWalletNetwork({ magic: 123 }), 123);
  assert.equal(nativeWalletNetwork({ networkMagic: "123" }), 123);
  assert.equal(nativeWalletNetwork({ defaultNetwork: "TestNet" }), 894710606);
  assert.throws(() => nativeWalletNetwork({ networks: [123] }));
  assert.throws(() => nativeWalletNetwork(1.5));
});

test("RPC rejects embedded credentials and never echoes a remote payload", async () => {
  assert.throws(() => createNativeRpc("https://user:secret@example.com"), /credentials/i);
  assert.throws(() => createNativeRpc("http://localhost:1/?key=1"), /query/i);
  assert.throws(() => createNativeRpc("ftp://localhost:1"), /HTTP/i);
  const rpc = createNativeRpc("http://localhost:1234", {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ error: { message: "secret" }, id: 1 }),
    }),
  });
  await assert.rejects(
    () => rpc.send("getversion", []),
    (error) => !error.message.includes("secret"),
  );
});

test("discovery gates network magic, kernel identity, protocol version and implementation id", async () => {
  for (const [change, expected] of [
    [(state) => (state.magic = 456), /network magic/i],
    [(state) => (state.nativeId = 1), /not available/i],
    [(state) => (state.protocolVersion = 3), /v4 protocol/i],
    [(state) => (state.implementationId = "NativeSmartAccount/v3"), /implementation id/i],
  ]) {
    const rpc = createNativeRpcFixture();
    change(rpc.state);
    const workspace = createNativeWorkspace({
      makeClient: () => new Client({ rpcClient: rpc, networkMagic: 123 }),
    });
    await assert.rejects(() => workspace.connect({}), expected);
    assert.equal(workspace.profile, null);
  }
});

test("discovery requires every v4 method and lifecycle event before any script runs", async () => {
  for (const change of [
    (abi) => (abi.methods = abi.methods.filter((method) => method.name !== "proposeConfiguration")),
    (abi) => (abi.methods = abi.methods.filter((method) => method.name !== "getHookOrder")),
    (abi) => delete abi.events,
    (abi) => (abi.events = abi.events.filter((event) => event.name !== "ConfigurationIntentExpired")),
  ]) {
    const rpc = createNativeRpcFixture();
    const send = rpc.send;
    rpc.send = async (method, params) => {
      const response = await send(method, params);
      if (method === "getcontractstate") change(response.manifest.abi);
      return response;
    };
    const workspace = createNativeWorkspace({
      makeClient: () => new Client({ rpcClient: rpc, networkMagic: 123 }),
    });
    await assert.rejects(() => workspace.connect({}), /native ABI/);
    assert.equal(workspace.profile, null);
    assert.equal(
      rpc.state.calls.some((call) => call.method === "invokescript"),
      false,
    );
  }
});

test("a malformed account record is refused before the workspace shows it", async () => {
  const f = await connected({
    registered: true,
    // Custody equal to the core is how a forged record would try to make the
    // kernel answer for its own account; the descriptor must refuse it.
    mutate: (state) => (state.custody = NATIVE_SMART_ACCOUNT_CONTRACT),
  });
  await assert.rejects(
    () => f.workspace.load(nativeTestIdentity.accountId),
    /identity/i,
  );
});

test("load reads the account, modules, hook order and pending intents from the core", async () => {
  const moduleHash = "77".repeat(20);
  const f = await connected({
    registered: true,
    mutate: (state) => {
      state.modules = [
        { moduleId: 1, moduleType: 1, contractHash: moduleHash, messageCapability: true },
        { moduleId: 2, moduleType: 4, contractHash: "88".repeat(20) },
      ];
      state.hookOrder = [2];
      state.hookRevision = 3;
      state.recovery = recovery;
    },
  });
  const snapshot = await f.workspace.load(nativeTestIdentity.accountId);
  assert.equal(snapshot.account.accountId, nativeTestIdentity.accountId);
  assert.equal(snapshot.account.accountAddress, nativeTestIdentity.accountAddress);
  assert.equal(snapshot.account.statusName, "Active");
  assert.equal(snapshot.account.custodyAddress, custody);
  assert.equal(snapshot.account.recoveryAuthority, recovery);
  assert.equal(snapshot.account.recoveryTimelockMs, String(RECOVERY_TIMELOCK_MIN_MS));
  assert.equal(snapshot.protocol.protocolVersion, "4");
  assert.equal(snapshot.protocol.migrationModeOpen, false);
  assert.deepEqual(snapshot.modules.validators.map((m) => m.moduleId), ["1"]);
  assert.equal(snapshot.modules.validators[0].moduleTypeName, "validator");
  assert.deepEqual(snapshot.modules.hooks.map((m) => m.moduleId), ["2"]);
  assert.deepEqual(snapshot.hookOrder, { hookIds: ["2"], revision: "3" });
  assert.deepEqual(snapshot.pending, []);
  assert.equal(snapshot.chainTime, f.rpc.state.time);
  assert.equal(snapshot.account.pendingRecovery, null);
});

test("discovery must complete before a review and invalidation discards every review", async () => {
  const rpc = createNativeRpcFixture();
  const workspace = createNativeWorkspace({
    makeClient: () => new Client({ rpcClient: rpc, networkMagic: 123 }),
  });
  await assert.rejects(
    () => workspace.registration({ custodyAddress: custody, salt, recoveryTimelockDays: 7 }),
    /discovery/i,
  );
  await workspace.connect({});
  const review = await workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryTimelockDays: 7,
  });
  workspace.invalidate();
  await assert.rejects(() => workspace.submit(review), /stale/i);
});

test("wallet handoff checks live network and actor and keeps a bounded scope", async () => {
  let called = 0;
  const rpc = createNativeRpcFixture();
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  const wallet = {
    account: async () => custody,
    network: async () => 123,
    invoke: async (request) => {
      called++;
      return { txid: "aa".repeat(32), request };
    },
  };
  const workspace = createNativeWorkspace({ makeClient: () => client, wallet });
  await workspace.connect({});
  const review = await workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryTimelockDays: 7,
  });
  assert.equal(review.submission, "wallet-invoke");
  assert.equal(review.walletSupported, true);

  wallet.network = async () => 456;
  await assert.rejects(() => workspace.submit(review), /network/i);
  assert.equal(called, 0);
  wallet.network = async () => 123;
  wallet.account = async () => stranger;
  await assert.rejects(() => workspace.submit(review), /authority|actor/i);
  assert.equal(called, 0);

  wallet.account = async () => custody;
  const sent = await workspace.submit(review);
  assert.equal(sent.request.operation, "createAccount");
  assert.deepEqual(sent.request.signers, [
    { account: "0x" + custody, scopes: "CalledByEntry" },
  ]);
  assert.equal(sent.request.args.length, 5);
  assert.equal(called, 1);
});

test("registration with an initial install carries the exact action Array", async () => {
  const actions = [
    installModuleAction({
      moduleType: "validator",
      contractHash: "77".repeat(20),
      profileDigest: "ab".repeat(32),
    }),
  ];
  const rpc = createNativeRpcFixture();
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  const workspace = createNativeWorkspace({
    makeClient: () => client,
    wallet: {
      account: async () => custody,
      network: async () => 123,
      invoke: async (request) => ({ request }),
    },
  });
  await workspace.connect({});
  const review = await workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryTimelockDays: 7,
    actions,
  });
  assert.equal(review.plan.kind, "registration");
  assert.deepEqual(review.requiredAuthorities, [custody]);
  assert.deepEqual(review.signers, [
    { account: "0x" + custody, scopes: "CalledByEntry" },
  ]);
  assert.deepEqual(review.request.args[4], A(actions));
  const exact = await workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryTimelockDays: 7,
    actions,
    submission: "native-sdk",
  });
  assert.deepEqual(exact.signers, [
    { account: "0x" + custody, scopes: "CustomContracts", allowedcontracts: ["0x" + NATIVE_SMART_ACCOUNT_CONTRACT] },
  ]);
  assert.equal(exact.walletSupported, false);
});

test("an already registered account id is refused before simulation", async () => {
  const f = await connected({ registered: true });
  await assert.rejects(
    () =>
      f.workspace.registration({
        custodyAddress: custody,
        salt,
        recoveryTimelockDays: 7,
      }),
    /already registered/i,
  );
});

test("unsuccessful simulation never reaches the wallet", async () => {
  const rpc = createNativeRpcFixture();
  const send = rpc.send;
  rpc.send = async (method, params) => {
    const response = await send(method, params);
    if (method === "invokescript" && params[0] && response.stack?.[0]?.type === "Any")
      return { ...response, state: "FAULT", exception: "denied" };
    return response;
  };
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  let called = 0;
  const workspace = createNativeWorkspace({
    makeClient: () => client,
    wallet: { account: async () => custody, network: async () => 123, invoke: async () => called++ },
  });
  await workspace.connect({});
  const review = await workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryTimelockDays: 7,
  });
  assert.match(review.simulationError, /simulation/i);
  await assert.rejects(() => workspace.submit(review), /simulation/i);
  assert.equal(called, 0);
});

test("editing inputs during simulation prevents a stale review from reappearing", async () => {
  const rpc = createNativeRpcFixture();
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  const workspace = createNativeWorkspace({ makeClient: () => client });
  await workspace.connect({});
  let release;
  client.simulate = () => new Promise((resolve) => (release = resolve));
  const pending = workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryTimelockDays: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  workspace.clearReview();
  release({ state: "HALT", incompleteTransfers: [] });
  await assert.rejects(() => pending, /inputs changed/);
  assert.equal(workspace.review, null);
});

test("in-flight discovery of an old endpoint cannot replace a newer connection", async () => {
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  let id = 0;
  const workspace = createNativeWorkspace({
    makeClient: () => ({
      discover: () =>
        ++id === 1 ? slow : Promise.resolve({ ...profile, networkMagic: 456 }),
    }),
  });
  const old = workspace.connect({ rpcUrl: "http://localhost:1234", networkMagic: 123 });
  await workspace.connect({ rpcUrl: "http://localhost:4567", networkMagic: 456 });
  release(profile);
  await assert.rejects(() => old, /stale/i);
  assert.equal(workspace.profile.networkMagic, 456);
});

test("a lost profile attestation during a later recheck revokes the verified state", async () => {
  const rpc = createNativeRpcFixture();
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  const workspace = createNativeWorkspace({
    makeClient: () => client,
    wallet: {
      account: async () => custody,
      network: async () => 123,
      invoke: () => assert.fail("the wallet must not be called"),
    },
  });
  await workspace.connect({});
  const review = await workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryTimelockDays: 7,
  });
  rpc.state.magic = 456;
  await assert.rejects(() => workspace.submit(review), /network magic mismatch/);
  assert.equal(workspace.profile, null);
});

test("account actions are custody or recovery gated and recovery is permissionless once mature", async () => {
  const f = await connected({
    registered: true,
    mutate: (state) => {
      state.recovery = recovery;
    },
  });
  const account = nativeTestIdentity.accountId;

  const freeze = await f.workspace.lifecycle({ accountId: account, action: "freezeAccount" });
  assert.deepEqual(freeze.requiredAuthorities, [custody]);
  assert.equal(freeze.submission, "wallet-invoke");
  assert.equal(freeze.plan.method, "freezeAccount");
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "freezeAccount", feePayer: stranger }),
    /custody wallet can sign/i,
  );
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "unfreezeAccount" }),
    /not frozen/i,
  );

  const begin = await f.workspace.lifecycle({
    accountId: account,
    action: "beginRecovery",
    newCustody: "99".repeat(20),
  });
  assert.deepEqual(begin.requiredAuthorities, [custody, "99".repeat(20)]);
  assert.equal(begin.submission, "native-sdk");
  assert.equal(begin.walletSupported, false);
  assert.deepEqual(begin.signers.map((signer) => signer.account), [
    "0x" + custody,
    "0x" + "99".repeat(20),
  ]);

  f.rpc.state.status = 1;
  assert.match(
    actionBlockReason({ statusName: "Frozen", pendingRecovery: null }, "freezeAccount", 1),
    /already frozen/,
  );
  const unfreeze = await f.workspace.lifecycle({ accountId: account, action: "unfreezeAccount" });
  assert.deepEqual(unfreeze.requiredAuthorities, [custody]);
});

test("recovery may be started or cancelled by custody or the recovery authority only", async () => {
  const now = Date.now();
  const f = await connected({
    registered: true,
    mutate: (state) => {
      state.recovery = recovery;
      state.pendingRecovery = {
        newCustody: stranger,
        initiatedAt: now - 1000,
        matureAt: now + 60_000,
      };
    },
  });
  const account = nativeTestIdentity.accountId;
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "beginRecovery", newCustody: "99".repeat(20) }),
    /already pending/i,
  );
  const cancel = await f.workspace.lifecycle({ accountId: account, action: "cancelRecovery" });
  assert.deepEqual(cancel.requiredAuthorities, [custody]);
  const byRecovery = await f.workspace.lifecycle({
    accountId: account,
    action: "cancelRecovery",
    feePayer: recovery,
  });
  assert.deepEqual(byRecovery.requiredAuthorities, [recovery]);
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "cancelRecovery", feePayer: stranger }),
    /recovery authority/i,
  );
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "executeRecovery" }),
    /not matured/i,
  );

  f.rpc.state.pendingRecovery = null;
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "executeRecovery" }),
    /no custody recovery is pending/i,
  );
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "cancelRecovery" }),
    /no custody recovery is pending/i,
  );
});

test("a mature recovery is executable by any fee payer with no authority scope", async () => {
  const now = Date.now();
  const f = await connected({
    registered: true,
    mutate: (state) => {
      state.recovery = recovery;
      state.pendingRecovery = {
        newCustody: stranger,
        initiatedAt: now - 8 * 86_400_000,
        matureAt: now - 1000,
      };
    },
  });
  const review = await f.workspace.lifecycle({
    accountId: nativeTestIdentity.accountId,
    action: "executeRecovery",
    feePayer: "77".repeat(20),
  });
  assert.deepEqual(review.requiredAuthorities, []);
  assert.deepEqual(review.signers, [{ account: "0x" + "77".repeat(20), scopes: "CalledByEntry" }]);
  assert.equal(review.walletSupported, true);
  await assert.rejects(
    () =>
      f.workspace.lifecycle({
        accountId: nativeTestIdentity.accountId,
        action: "executeRecovery",
        feePayer: nativeTestIdentity.accountAddress,
      }),
    /separate Neo wallet/i,
  );
});

test("begin recovery refuses the current custody, the proxy and the core as the new custody", async () => {
  const f = await connected({ registered: true });
  for (const [newCustody, expected] of [
    [custody, /different Neo account/i],
    [nativeTestIdentity.accountAddress, /different Neo account/i],
    [NATIVE_SMART_ACCOUNT_CONTRACT, /nonzero Neo authority/i],
  ])
    await assert.rejects(
      () =>
        f.workspace.lifecycle({
          accountId: nativeTestIdentity.accountId,
          action: "beginRecovery",
          newCustody,
        }),
      expected,
    );
});

test("actionBlockReason reads the live state instead of a device clock", () => {
  const active = { statusName: "Active", pendingRecovery: null };
  const frozen = { ...active, statusName: "Frozen" };
  const migration = { ...active, statusName: "MigrationRequired" };
  const pending = { ...active, pendingRecovery: { matureAt: "2000" } };
  assert.equal(actionBlockReason(active, "freezeAccount", 1000), "");
  assert.match(actionBlockReason(frozen, "freezeAccount", 1000), /already frozen/);
  assert.match(actionBlockReason(active, "unfreezeAccount", 1000), /not frozen/);
  assert.match(actionBlockReason(pending, "beginRecovery", 1000), /already pending/);
  assert.equal(actionBlockReason(pending, "cancelRecovery", 1000), "");
  assert.match(actionBlockReason(pending, "executeRecovery", 1000), /not matured/);
  assert.match(actionBlockReason(active, "executeRecovery", 1000), /No custody recovery/);
  assert.equal(actionBlockReason(pending, "executeRecovery", 2000), "");
  assert.match(actionBlockReason(migration, "freezeAccount", 1000), /migration/i);
  assert.match(actionBlockReason(null, "freezeAccount", 1000), /Load an account/);
});

test("a configuration proposal is one atomic intent and never a wallet invoke", async () => {
  const f = await connected({ registered: true });
  const account = nativeTestIdentity.accountId;
  const actions = [setDefaultPolicyAction({ operationAuthorization: false, messageAuthorization: true })];
  const propose = await f.workspace.configuration({ kind: "propose", accountId: account, actions });
  assert.equal(propose.plan.method, "proposeConfiguration");
  assert.deepEqual(propose.requiredAuthorities, [custody]);
  assert.equal(propose.submission, "native-sdk");
  assert.equal(propose.walletSupported, false);
  assert.equal(propose.request, null);
  assert.match(propose.description, /24 hours/);
  await assert.rejects(() => f.workspace.submit(propose), /exact-script/);

  for (const invalid of [
    { kind: "propose", accountId: account, actions: [] },
    { kind: "propose", accountId: account, actions: Array(MAX_ACTIONS_PER_INTENT + 1).fill(actions[0]) },
  ])
    await assert.rejects(() => f.workspace.configuration(invalid), /1 to 16 actions/);

  f.rpc.state.status = 1;
  await assert.rejects(
    () => f.workspace.configuration({ kind: "propose", accountId: account, actions }),
    /frozen/i,
  );
  f.rpc.state.status = 2;
  await assert.rejects(
    () => f.workspace.configuration({ kind: "propose", accountId: account, actions }),
    /migration/i,
  );
});

function pendingIntent(fixture, overrides = {}) {
  const now = fixture.rpc.state.time;
  return {
    intentId: 3,
    proposedAt: now - 86_400_000,
    matureAt: now - 1000,
    expiresAt: now + 86_400_000,
    authorityEpoch: 0,
    actionDigest: { type: "ByteString", value: Buffer.from("ab".repeat(32), "hex").toString("base64") },
    actions: [setDefaultPolicyAction({ operationAuthorization: true, messageAuthorization: true })],
    ...overrides,
  };
}

test("confirmation enforces maturity, expiry and the authority epoch of the intent", async () => {
  const f = await connected({ registered: true });
  const account = nativeTestIdentity.accountId;
  const now = f.rpc.state.time;
  f.rpc.state.intents = { 3: pendingIntent(f) };

  f.rpc.state.intents = { 3: pendingIntent(f, { matureAt: now + 1000 }) };
  await assert.rejects(
    () => f.workspace.configuration({ kind: "confirm", accountId: account, intentId: "3" }),
    /not matured/i,
  );
  f.rpc.state.intents = { 3: pendingIntent(f, { matureAt: now - 1000, expiresAt: now - 1 }) };
  await assert.rejects(
    () => f.workspace.configuration({ kind: "confirm", accountId: account, intentId: "3" }),
    /expired/i,
  );
  f.rpc.state.intents = { 3: pendingIntent(f, { authorityEpoch: 5 }) };
  await assert.rejects(
    () => f.workspace.configuration({ kind: "confirm", accountId: account, intentId: "3" }),
    /earlier authority epoch/i,
  );

  f.rpc.state.intents = { 3: pendingIntent(f) };
  const confirm = await f.workspace.configuration({ kind: "confirm", accountId: account, intentId: "3" });
  assert.equal(confirm.plan.method, "confirmConfiguration");
  assert.deepEqual(confirm.requiredAuthorities, [custody]);
  assert.equal(confirm.submission, "native-sdk");
  assert.equal(confirm.intentId, "3");
  assert.deepEqual(confirm.intentActions, pendingIntent(f).actions);
  const exported = await f.workspace.exportReview(confirm);
  assert.deepEqual(exported.recipe.input.actions, pendingIntent(f).actions);

  await assert.rejects(
    () => f.workspace.configuration({ kind: "confirm", accountId: account, intentId: "9" }),
    /not pending/i,
  );
});

test("a live intent needs custody to cancel, an expired one needs nobody", async () => {
  const f = await connected({ registered: true });
  const account = nativeTestIdentity.accountId;
  const now = f.rpc.state.time;

  f.rpc.state.intents = { 3: pendingIntent(f) };
  const live = await f.workspace.configuration({ kind: "cancel", accountId: account, intentId: "3" });
  assert.deepEqual(live.requiredAuthorities, [custody]);
  assert.equal(live.plan.method, "cancelConfiguration");

  f.rpc.state.intents = { 3: pendingIntent(f, { matureAt: now - 1, expiresAt: now - 1 }) };
  const expired = await f.workspace.configuration({
    kind: "cancel",
    accountId: account,
    intentId: "3",
  });
  assert.deepEqual(expired.requiredAuthorities, []);
  assert.deepEqual(expired.signers, [{ account: "0x" + custody, scopes: "None" }]);
  assert.equal(expired.submission, "native-sdk", "exact script survives a permissionless cancel");
  assert.match(expired.description, /expired intent can be cleaned by anyone/i);
});

test("a changed pending intent is refused before it can be confirmed or exported", async () => {
  const f = await connected({ registered: true });
  const account = nativeTestIdentity.accountId;
  f.rpc.state.intents = { 3: pendingIntent(f) };
  const inspected = await f.workspace.inspectConfiguration({ accountId: account });
  assert.equal(inspected.intents.length, 1);
  assert.equal(inspected.intents[0].mature, true);
  assert.equal(inspected.intents[0].expired, false);
  assert.deepEqual(inspected.intents[0].descriptions, ["Built-in route: operations on, messages on"]);

  const review = await f.workspace.configuration({
    kind: "confirm",
    accountId: account,
    intentId: "3",
    expectedIntent: inspected.intents[0],
  });
  const exported = await f.workspace.exportReview(review);
  assert.equal(exported.recipe.method, "buildConfigurationScript");
  assert.equal(exported.recipe.input.intentId, "3");
  assert.deepEqual(await rebuildNativeReview(f.client, exported), review.plan);

  f.rpc.state.intents = {
    3: pendingIntent(f, {
      actions: [setDefaultPolicyAction({ operationAuthorization: false, messageAuthorization: false })],
    }),
  };
  await assert.rejects(() => f.workspace.exportReview(review), /changed/i);
  await assert.rejects(() => rebuildNativeReview(f.client, exported), /changed/i);
  await assert.rejects(
    () =>
      f.workspace.configuration({
        kind: "confirm",
        accountId: account,
        intentId: "3",
        expectedIntent: inspected.intents[0],
      }),
    /pending intent changed/i,
  );
});

test("inspection refuses to publish a stale pending card", async () => {
  const f = await connected({ registered: true, mutate: (state) => (state.intents = {}) });
  let finish;
  const gate = new Promise((resolve) => (finish = resolve));
  f.client.getPendingConfigurationIntentIds = async () => {
    await gate;
    return [];
  };
  const inspection = f.workspace.inspectConfiguration({ accountId: nativeTestIdentity.accountId });
  f.workspace.clearReview();
  finish();
  await assert.rejects(() => inspection, /inputs changed/i);
});

test("an execution review carries the canonical proxy signer and refuses wallet handoff", async () => {
  const f = await connected({ registered: true });
  const account = nativeTestIdentity.accountId;
  const operation = {
    targetContract: "99".repeat(20),
    method: "ping",
    args: [],
    nonce: "1",
    nonceSubkey: "ab".repeat(32),
    deadline: String(f.rpc.state.time + 60_000),
    validatorId: "0",
    credentialGeneration: "1",
    authorityEpoch: "0",
    configurationNonce: "0",
    signature: "cd".repeat(64),
    hookProofs: [],
  };
  const payer = "77".repeat(20);
  const review = await f.workspace.operation({
    accountId: account,
    operations: [operation],
    feePayer: payer,
  });
  assert.equal(review.plan.kind, "execution");
  assert.equal(review.plan.method, "executeUserOp");
  assert.equal(review.plan.batch, false);
  assert.equal(review.plan.proxyCallFlags, NATIVE_PROXY_CALL_FLAGS);
  assert.equal(review.plan.accountAddress, nativeTestIdentity.accountAddress);
  assert.deepEqual(review.requiredAuthorities, []);
  assert.equal(review.signers.length, 2);
  assert.deepEqual(review.signers[0], { account: "0x" + payer, scopes: "None" });
  assert.deepEqual(review.signers[1], {
    account: "0x" + nativeTestIdentity.accountAddress,
    scopes: "WitnessRules",
    rules: [
      { action: "Allow", condition: { type: "CalledByContract", hash: NATIVE_SMART_ACCOUNT_CONTRACT } },
    ],
  });
  assert.equal(review.walletSupported, false);
  await assert.rejects(() => f.workspace.submit(review), /exact-script/);

  assert.equal(typeof review.simulation.state, "string");
  assert.equal(f.rpc.state.calls.some(({ method }) => method === "sendrawtransaction"), false);

  const exported = await f.workspace.exportReview(review);
  assert.equal(exported.recipe.method, "buildExecutionScript");
  assert.deepEqual(await rebuildNativeReview(f.client, exported), review.plan);

  for (const [change, expected] of [
    [(copy) => (copy.feePayer = nativeTestIdentity.accountAddress), /separate Neo wallet/i],
    [(copy) => (copy.plan.operations = []), /changed|malformed/i],
    [(copy) => (copy.signers[1].rules[0].condition.hash = "aa".repeat(20)), /signer|proxy|scope/i],
    [(copy) => copy.signers.reverse(), /signer|proxy|payer/i],
  ]) {
    const copy = structuredClone(exported);
    change(copy);
    await assert.rejects(() => rebuildNativeReview(f.client, copy), expected);
  }
});

test("execution is refused unless the account is active and the envelope is bounded", async () => {
  const operation = {
    targetContract: "99".repeat(20),
    method: "ping",
    args: [],
    nonce: "1",
    nonceSubkey: "ab".repeat(32),
    deadline: String(Date.now() + 60_000),
    validatorId: "0",
    credentialGeneration: "1",
    authorityEpoch: "0",
    configurationNonce: "0",
    signature: "cd".repeat(64),
  };
  const frozen = await connected({ registered: true, mutate: (state) => (state.status = 1) });
  await assert.rejects(
    () =>
      frozen.workspace.operation({
        accountId: nativeTestIdentity.accountId,
        operations: [operation],
      }),
    /not active/i,
  );
  const f = await connected({ registered: true });
  await assert.rejects(
    () => f.workspace.operation({ accountId: nativeTestIdentity.accountId, operations: [] }),
    /1 to 32 operations/i,
  );
  await assert.rejects(
    () =>
      f.workspace.operation({
        accountId: nativeTestIdentity.accountId,
        operations: Array(MAX_OPERATIONS_PER_ENVELOPE + 1).fill(operation),
      }),
    /1 to 32 operations/i,
  );
});

test("an exported review rebuilds from its recipe and binds plan, authority and scopes", async () => {
  const f = await connected({ registered: true });
  const account = nativeTestIdentity.accountId;
  const review = await f.workspace.lifecycle({
    accountId: account,
    action: "freezeAccount",
    submission: "native-sdk",
  });
  const exported = await f.workspace.exportReview(review);
  assert.equal(exported.format, "neo-native-reviewed-request");
  assert.equal(exported.recipe.method, "buildAccountActionScript");
  assert.equal(exported.recipe.input.method, "freezeAccount");
  assert.deepEqual(await rebuildNativeReview(f.client, exported), review.plan);

  for (const [change, expected] of [
    [(copy) => copy.plan.script = "abcd", /changed|mismatch/i],
    [(copy) => (copy.profile.implementationId = "NativeSmartAccount/v3"), /profile/i],
    [(copy) => (copy.requiredAuthorities = []), /authority/i],
    [(copy) => (copy.signers[0].scopes = "None"), /signer|scope/i],
    [(copy) => (copy.feePayer = recovery), /authority|signer|payer/i],
    [(copy) => (copy.recipe.input.accountId = "44".repeat(20)), /changed|mismatch/i],
    [(copy) => (copy.submission = "wallet-invoke"), /wallet invocation/i],
  ]) {
    const copy = structuredClone(exported);
    change(copy);
    await assert.rejects(() => rebuildNativeReview(f.client, copy), expected);
  }
});

test("receipt validation requires a mined transaction, the reviewed script and a HALT Application log", async () => {
  const hash = "0x" + "aa".repeat(32);
  const review = {
    feePayer: custody,
    signers: [
      { account: "0x" + custody, scopes: "CustomContracts", allowedcontracts: ["0x" + NATIVE_SMART_ACCOUNT_CONTRACT] },
    ],
    plan: {
      kind: "execution",
      script: nativeCodec.dynamicCall(NATIVE_SMART_ACCOUNT_CONTRACT, "executeUserOp", [
        nativeCodec.hashValue(nativeTestIdentity.accountId),
        nativeCodec.operationValue({
          targetContract: "99".repeat(20),
          method: "transfer",
          args: [],
          nonce: "1",
          nonceSubkey: "ab".repeat(32),
          deadline: "2000",
          validatorId: "0",
          credentialGeneration: "1",
          authorityEpoch: "0",
          configurationNonce: "0",
          signature: "cd".repeat(64),
        }),
      ]),
      batch: false,
      operations: [{ method: "transfer" }],
    },
  };
  const transaction = {
    hash,
    blockhash: "0x" + "bb".repeat(32),
    script: review.plan.script,
    signers: review.signers,
  };
  assert.deepEqual(
    validateNativeReceipt(
      review,
      { ...transaction, script: Buffer.from(review.plan.script, "hex").toString("base64") },
      { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", stack: [{ type: "Boolean", value: true }] }] },
      hash,
    ),
    { txid: hash, state: "HALT" },
  );
  const base64 = Buffer.from(review.plan.script, "hex").toString("base64");
  for (const [patch, expected] of [
    [{ transaction: { ...transaction, blockhash: undefined, script: base64 } }, /mined/i],
    [{ transaction: { ...transaction, script: base64, signers: [{ ...review.signers[0], scopes: "Global" }] } }, /scope/i],
    [{ transaction: { ...transaction, script: "abcd" } }, /script/i],
    [{ log: { txid: "0x" + "cc".repeat(32), executions: [] } }, /identity/i],
    [{ log: { txid: hash, executions: [{ trigger: "Verification", vmstate: "HALT" }] } }, /Application/i],
    [{ log: { txid: hash, executions: [{ trigger: "Application", vmstate: "FAULT", stack: [] }] } }, /successful/i],
    [{ log: { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", stack: [{ type: "Boolean", value: false }] }] } }, /transfer/i],
    [{ log: { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", stack: [] }] } }, /transfer/i],
  ])
    assert.throws(
      () =>
        validateNativeReceipt(
          review,
          patch.transaction ?? { ...transaction, script: base64 },
          patch.log ?? { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", stack: [{ type: "Boolean", value: true }] }] },
          hash,
        ),
      expected,
    );
});

test("confirmation reads the mined transaction and refuses to publish it after an edit", async () => {
  const f = await connected({ registered: true });
  const review = await f.workspace.lifecycle({
    accountId: nativeTestIdentity.accountId,
    action: "freezeAccount",
  });
  const hash = "0x" + "aa".repeat(32);
  const transaction = {
    hash,
    blockhash: "0x" + "bb".repeat(32),
    script: Buffer.from(review.plan.script, "hex").toString("base64"),
    signers: review.signers,
  };
  const log = { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", stack: [] }] };
  const send = f.client.rpc.send;
  f.client.rpc.send = async (method, params) => {
    if (method === "getrawtransaction") return transaction;
    if (method === "getapplicationlog") return log;
    return send(method, params);
  };
  assert.deepEqual(await f.workspace.confirm(review, hash), { txid: hash, state: "HALT" });

  let release,
    first = true;
  f.client.rpc.send = (method, params) => {
    if (first && method === "getrawtransaction") {
      first = false;
      return new Promise((resolve) => (release = resolve));
    }
    return send(method, params);
  };
  const pending = f.workspace.confirm(review, hash);
  await new Promise((resolve) => setImmediate(resolve));
  f.workspace.clearReview();
  release(transaction);
  await assert.rejects(() => pending, /changed/i);
});

function exactTools(overrides = {}) {
  return {
    importArtifact: async (_client, review, _text, caps) =>
      Object.freeze({
        review,
        txid: "0x" + "ab".repeat(32),
        rawTransaction: "aa",
        fees: { system: "10", network: "1", total: "11" },
        caps,
        transaction: { validUntilBlock: 20 },
      }),
    preflight: async () => ({ snapshot: { height: 10 }, state: "HALT" }),
    broadcast: async (_client, _transaction, { assertCurrent }) => {
      assertCurrent();
      return { txid: "0x" + "ab".repeat(32), submitted: true };
    },
    receipt: async () => ({ confirmed: true, succeeded: true, vmState: "HALT" }),
    ...overrides,
  };
}

async function exactFixture(overrides = {}) {
  const rpc = createNativeRpcFixture();
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  const tools = exactTools(overrides);
  const workspace = createNativeWorkspace({ makeClient: () => client, transactionTools: tools });
  await workspace.connect({});
  const review = await workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryTimelockDays: 7,
    submission: "native-sdk",
  });
  return { rpc, client, tools, workspace, review };
}

const importCaps = { maxSystemFee: "100", maxNetworkFee: "100", maxTotalFee: "200" };

test("an imported transaction stays bound to the current review and fee limits", async () => {
  const f = await exactFixture();
  const imported = await f.workspace.importSigned(f.review, "{}", importCaps);
  assert.equal((await f.workspace.preflightSigned(imported)).state, "HALT");
  f.workspace.clearImported();
  await assert.rejects(() => f.workspace.broadcastSigned(imported), /stale/i);

  let finish, started;
  const importing = new Promise((resolve) => (started = resolve));
  f.tools.importArtifact = () =>
    new Promise((resolve) => {
      finish = resolve;
      started();
    });
  const pending = f.workspace.importSigned(f.review, "{}", importCaps);
  await importing;
  f.workspace.clearReview();
  finish(Object.freeze({ txid: imported.txid }));
  await assert.rejects(() => pending, /changed/i);
});

test("a changed review during the broadcast preflight never reaches submission", async () => {
  let resume;
  const gate = new Promise((resolve) => (resume = resolve));
  let sent = 0;
  const f = await exactFixture({
    broadcast: async (_client, _transaction, { assertCurrent }) => {
      await gate;
      assertCurrent();
      sent++;
    },
  });
  const imported = await f.workspace.importSigned(f.review, "{}", importCaps);
  const broadcasting = f.workspace.broadcastSigned(imported);
  f.workspace.clearReview();
  resume();
  await assert.rejects(() => broadcasting, /stale/i);
  assert.equal(sent, 0);
});

test("an uncertain submission keeps the same transaction for its receipt and cannot be retried", async () => {
  let attempts = 0;
  const f = await exactFixture({
    broadcast: async (_client, tx, { assertCurrent }) => {
      assertCurrent();
      attempts++;
      throw Object.assign(Error("timed out"), {
        submissionAttempted: true,
        txid: tx.txid,
      });
    },
  });
  const imported = await f.workspace.importSigned(f.review, "{}", importCaps);
  await assert.rejects(() => f.workspace.broadcastSigned(imported), {
    message: "timed out",
    submissionAttempted: true,
  });
  await assert.rejects(() => f.workspace.broadcastSigned(imported), /already attempted/i);
  await assert.rejects(() => f.workspace.importSigned(f.review, "{}", importCaps), /current exact-script review/i);
  assert.equal((await f.workspace.confirmSigned(imported)).succeeded, true);
  assert.equal(attempts, 1);
});

test("archived receipts survive expiry without gaining submission authority", async () => {
  let restoredChecks = 0;
  const f = await exactFixture({
    restoreForReceipt: async (_client, review) => {
      assert.equal(review.format, "neo-native-reviewed-request");
      return Object.freeze({ txid: "0x" + "ab".repeat(32), receiptOnly: true });
    },
    receipt: async () => {
      restoredChecks++;
      return { confirmed: true, succeeded: true };
    },
  });
  const restored = await f.workspace.restoreReceipt(
    '{"format":"neo-native-reviewed-request","version":1}',
    "{}",
  );
  assert.equal((await f.workspace.confirmRestoredReceipt(restored)).succeeded, true);
  await assert.rejects(() => f.workspace.preflightSigned(restored), /stale/i);
  await assert.rejects(() => f.workspace.broadcastSigned(restored), /stale/i);
  f.workspace.clearReview();
  assert.equal(
    (await f.workspace.confirmRestoredReceipt(restored)).confirmed,
    true,
    "editing new-form inputs does not invalidate a read-only archived receipt",
  );
  f.workspace.clearArchived();
  await assert.rejects(() => f.workspace.confirmRestoredReceipt(restored), /files changed/i);
  assert.equal(restoredChecks, 2);
});

test("archived receipt restoration is revoked by a network change during verification", async () => {
  let finish;
  const f = await exactFixture({
    restoreForReceipt: () => new Promise((resolve) => (finish = resolve)),
  });
  const restoring = f.workspace.restoreReceipt("{}", "{}");
  await Promise.resolve();
  f.workspace.invalidate();
  finish(Object.freeze({ receiptOnly: true }));
  await assert.rejects(() => restoring, /stale/i);
});

test("canonical native modules are shipped byte-identically to the frontend", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  for (const name of [
    "nativeSmartAccount.mjs",
    "nativeSmartAccountClient.mjs",
    "nativeTransactionArtifact.mjs",
    "nativeWalletWitness.mjs",
    "proxyWitness.mjs",
  ])
    assert.equal(
      hash(await readFile(new URL("../src/shared/" + name, import.meta.url))),
      hash(await readFile(new URL("../../shared/" + name, import.meta.url))),
      name + " must match the canonical shared source",
    );
});

test("the native workspace UI is bound to the v4 surface only", () => {
  const source = readFileSync(
    new URL("../src/features/native/NativeAccountWorkspace.vue", import.meta.url),
    "utf8",
  );
  for (const removed of [
    "buildSessionArguments",
    "buildMultiSigArguments",
    "NATIVE_MULTISIG_LIMITS",
    "inspectPolicy",
    "activatePolicy",
    "workspace.policy(",
    "pendingRecoveryAddress",
  ])
    assert.equal(source.includes(removed), false, `${removed} must not survive in the UI`);
  assert.match(source, /workspace\.configuration\(/);
  assert.match(source, /workspace\.inspectConfiguration\(/);
});
