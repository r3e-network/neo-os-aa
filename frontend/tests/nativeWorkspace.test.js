import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createNativeWorkspace,
  actionBlockReason,
  hasRequiredValidator,
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
  durationText,
  installModuleAction,
  parseModuleInstallData,
  uninstallModuleAction,
  configureModuleAction,
  setBuiltinAuthorizationAction,
  setRequiredValidatorAction,
  NATIVE_ACTIONS,
  NATIVE_ACTION_CODES,
  RETIRED_ACTION_CODES,
  NATIVE_GOVERNANCE_UNFREEZE_ACTION,
  NATIVE_MODULE_LIMITS,
  NATIVE_MODULE_TYPES,
  NATIVE_PROXY_CALL_FLAGS,
  NATIVE_SMART_ACCOUNT_CONTRACT,
  NATIVE_STATUS_NAMES,
  MAX_ACTIONS_PER_INTENT,
  RECOVERY_TIMELOCK_MAX_MS,
  RECOVERY_TIMELOCK_MIN_MS,
} from "../src/features/native/nativeWorkspace.js";
import { createNativeClientClass } from "../src/shared/nativeSmartAccountClient.mjs";
import {
  createNativeRpcFixture,
  nativeTestCustody,
  nativeTestIdentity,
  nativeTestRecovery,
  nativeTestRecoverySeat,
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
  implementationId: "NativeSmartAccount",
};
const Client = createNativeClientClass(nativeCodec, {
  callFlags: NATIVE_PROXY_CALL_FLAGS,
});
const I = (value) => ({ type: "Integer", value: String(value) });
const B = (hex) => ({ type: "ByteString", value: hex });
const A = (value) => ({ type: "Array", value });
const BOOL = (value) => ({ type: "Boolean", value });

/** A real browser client over the v4 fixture: nothing here is stubbed but the node. */
async function connected({ registered = false, mutate, translate } = {}) {
  const rpc = createNativeRpcFixture();
  rpc.state.registered = registered;
  if (mutate) mutate(rpc.state);
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  const workspace = createNativeWorkspace({ makeClient: () => client, translate });
  await workspace.connect({});
  return { rpc, client, workspace };
}

test("the workspace exports the v4.1 surface and no retired encoder", async () => {
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
    // The core has no configuration intent, so no intent window is exported.
    "MODULE_CHANGE_DELAY_MS",
    "CONFIGURATION_INTENT_EXPIRY_MS",
    "MAX_ACTIVE_INTENTS",
    // v4.1 retires codes 4, 6, 8 and 9, so their encoders are gone: a retired
    // concept must fail at the call site instead of producing a dead action.
    "rebindModuleCodeAction",
    "setHookOrderAction",
    "setThresholdPolicyAction",
    "setDefaultPolicyAction",
    "setRecoveryPolicyAction",
    "setMessageSubjectsAction",
    "NATIVE_THRESHOLD_LIMITS",
  ])
    assert.equal(removed in module, false, `${removed} must not survive the v4.1 port`);
  assert.deepEqual(NATIVE_ACTION_CODES, {
    installModule: 1,
    uninstallModule: 2,
    configureModule: 3,
    setBuiltinAuthorization: 5,
    setRequiredValidator: 7,
  });
  assert.deepEqual(
    Object.values(NATIVE_ACTION_CODES).sort((a, b) => a - b),
    [1, 2, 3, 5, 7],
    "exactly five configuration action codes are live",
  );
  assert.deepEqual(RETIRED_ACTION_CODES, [4, 6, 8, 9, 10]);
  assert.deepEqual(NATIVE_STATUS_NAMES, ["Active", "Frozen"]);
  assert.equal(NATIVE_PROXY_CALL_FLAGS, 5, "the native proxy calls verify read-only");
  assert.deepEqual(NATIVE_ACTIONS.map((entry) => entry.value), [
    "freezeAccount",
    "unfreezeAccount",
    "beginRecovery",
    "cancelRecovery",
    "executeRecovery",
  ]);
  assert.deepEqual(
    NATIVE_ACTIONS.filter((entry) => entry.address),
    [],
    "v4.1 has no native recovery-policy administration",
  );
});

test("kernel limits track the contract source and the recovery delay lives in the module", () => {
  const read = (path) =>
    readFileSync(new URL("../../" + path, import.meta.url), "utf8");
  const moduleProtocol = read(
    "contracts/native/SmartAccount/SmartAccountModuleProtocol.cs",
  );
  const recoveryModule = read("contracts/modules/RecoveryModule/RecoveryModule.cs");

  const governance = read(
    "contracts/modules/GovernanceModule/GovernanceModule.cs",
  );
  const constant = (source, name, type = "int") => {
    const match = new RegExp(`${type} ${name} = ([0-9_]+);`).exec(source);
    assert.ok(match, `${name} must stay an explicit constant`);
    return Number(match[1].replaceAll("_", ""));
  };
  assert.equal(
    MAX_ACTIONS_PER_INTENT,
    constant(moduleProtocol, "MaxActionsPerRegistration"),
  );
  // v4.1 executes exactly one operation per transaction, so the kernel no longer
  // publishes a per-envelope operation cap: there is no workspace constant for
  // one, and no source constant to track.
  assert.equal(moduleProtocol.includes("MaxOperationsPerEnvelope"), false);
  assert.deepEqual(NATIVE_MODULE_LIMITS, {
    validator: constant(moduleProtocol, "MaxValidatorModuleInstances"),
    hook: constant(moduleProtocol, "MaxHookModuleInstances"),
    recovery: constant(moduleProtocol, "MaxRecoveryModuleInstances"),
  });
  assert.deepEqual(NATIVE_MODULE_TYPES, {
    validator: constant(moduleProtocol, "ModuleTypeCodeValidator"),
    hook: constant(moduleProtocol, "ModuleTypeCodeHook"),
    recovery: constant(moduleProtocol, "ModuleTypeCodeRecovery"),
  });
  // The recovery timelock is the RecoveryModule's policy domain now; the
  // workspace only records it in the offline descriptor. A native threshold
  // policy and a native recovery timelock no longer exist.
  assert.match(
    recoveryModule,
    /RecoveryTimelockMinMs = 7L \* 24 \* 60 \* 60 \* 1000;/,
  );
  assert.match(
    recoveryModule,
    /RecoveryTimelockMaxMs = 90L \* 24 \* 60 \* 60 \* 1000;/,
  );
  assert.equal(RECOVERY_TIMELOCK_MIN_MS, 7 * 86_400_000);
  assert.equal(RECOVERY_TIMELOCK_MAX_MS, 90 * 86_400_000);
  assert.equal(moduleProtocol.includes("MaxThresholdPolicyMembers"), false);
  // The 24-hour proposal window is the governance module's constant. It is
  // asserted where it lives instead of being promised by the kernel workspace.
  assert.match(
    governance,
    /MaturityMs = 24L \* 60 \* 60 \* 1000;/,
  );
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
  assert.deepEqual(
    setBuiltinAuthorizationAction({ operationAuthorization: false, messageAuthorization: true }),
    A([I(5), BOOL(false), BOOL(true)]),
  );
  assert.deepEqual(setRequiredValidatorAction({ validatorId: 2 }), A([
    I(7),
    I(2),
    BOOL(true),
  ]));
  assert.deepEqual(
    setRequiredValidatorAction({ validatorId: 0, required: false }),
    A([I(7), I(0), BOOL(false)]),
  );
  assert.throws(() => setRequiredValidatorAction({ validatorId: 0 }), /nonzero/);
  assert.throws(
    () => setRequiredValidatorAction({ validatorId: 3, required: false }),
    /validator id 0/,
  );
});

test("named module install input preserves command, address, integer and hook-order wire types", () => {
  const target = "0102030405060708090a0b0c0d0e0f1011121314";
  assert.deepEqual(parseModuleInstallData(" "), []);
  assert.deepEqual(parseModuleInstallData(JSON.stringify(["allowTarget", { type: "Hash160", value: target }])),
    [nativeCodec.stringValue("allowTarget"), nativeCodec.hashValue(target)]);
  assert.deepEqual(parseModuleInstallData("[[2,5],false]"), [A([I(2), I(5)]), BOOL(false)]);
  assert.deepEqual(parseModuleInstallData('[{"type":"Integer","value":"9007199254740993"}]'), [I("9007199254740993")]);
  for (const text of ["[9007199254740993]", "not JSON", "{}", '[{"type":"Hash160","value":"00"}]'])
    assert.throws(() => parseModuleInstallData(text));
});

test("configuration actions reject unreachable and malformed inputs", () => {
  const digest = "ab".repeat(32);
  const invalid = [
    () => installModuleAction({ moduleType: 2, contractHash: custody, profileDigest: digest }),
    () => installModuleAction({ moduleType: "validator", contractHash: "00".repeat(20), profileDigest: digest }),
    () => installModuleAction({ moduleType: "validator", contractHash: custody, profileDigest: "ab" }),
    () => installModuleAction({ moduleType: "validator", contractHash: custody, profileDigest: digest, initData: Array(65).fill(I(1)) }),
    () => uninstallModuleAction({ moduleId: -1 }),
    () => uninstallModuleAction({ moduleId: 0 }),
    () => configureModuleAction({ moduleId: 0 }),
    () => setRequiredValidatorAction({ validatorId: 0 }),
    () => setRequiredValidatorAction({ validatorId: 3, required: "yes" }),
    () => setRequiredValidatorAction({ validatorId: 3, required: false }),
    () => setRequiredValidatorAction({ validatorId: -1 }),
  ];
  for (const build of invalid) assert.throws(build);
});

test("configuration actions describe themselves and keep retired codes retired", () => {
  assert.equal(
    describeConfigurationAction(
      installModuleAction({ moduleType: "hook", contractHash: "ab".repeat(20), profileDigest: "cc".repeat(32) }),
    ),
    "Install hook module abababab…",
  );
  assert.equal(describeConfigurationAction(uninstallModuleAction({ moduleId: 7 })), "Uninstall module 7");
  assert.equal(describeConfigurationAction(configureModuleAction({ moduleId: 8 })), "Reconfigure module 8");
  assert.equal(
    describeConfigurationAction(setBuiltinAuthorizationAction({ operationAuthorization: false, messageAuthorization: true })),
    "Built-in route: operations off, messages on",
  );
  assert.equal(
    describeConfigurationAction(setRequiredValidatorAction({ validatorId: 4 })),
    "Require validator module 4 (governance delay)",
  );
  assert.equal(
    describeConfigurationAction(setRequiredValidatorAction({ validatorId: 0, required: false })),
    "Clear the required validator (governance delay)",
  );
  for (const code of RETIRED_ACTION_CODES)
    assert.equal(
      describeConfigurationAction(A([I(code)])),
      `Retired action ${code}`,
      "a retired code must be named as retired, not rendered as a live action",
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
    [(state) => (state.protocolVersion = 3), /protocol version is incompatible/i],
    [(state) => (state.implementationId = "DifferentSmartAccount"), /implementation id/i],
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
    (abi) => (abi.methods = abi.methods.filter((method) => method.name !== "installModule")),
    (abi) => (abi.methods = abi.methods.filter((method) => method.name !== "getNonce")),
    (abi) => delete abi.events,
    (abi) => (abi.events = abi.events.filter((event) => event.name !== "ModuleInstalled")),
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
    // Both the presence gate ("native ABI <label> missing or malformed") and the
    // v4.1 surface gate ("native contract ABI is incompatible ...") name the ABI.
    await assert.rejects(() => workspace.connect({}), /ABI/);
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

test("account overview reads native balances; a separate request reads the module roster", async () => {
  const moduleHash = "77".repeat(20);
  const f = await connected({
    registered: true,
    mutate: (state) => {
      state.modules = [
        {
          moduleId: 1,
          moduleType: 1,
          contractHash: moduleHash,
          messageCapability: true,
          // Reviewed fixture: a freshly registered account starts its installed
          // validator at CredentialGeneration 1. The fixture never invents it.
          credentialGeneration: "1",
        },
        {
          moduleId: 2,
          moduleType: 4,
          contractHash: "88".repeat(20),
          // Hooks carry no credential namespace, so the chain reports 0.
          credentialGeneration: "0",
        },
      ];
    },
  });
  const snapshot = await f.workspace.load(nativeTestIdentity.accountId);
  assert.equal(snapshot.account.accountId, nativeTestIdentity.accountId);
  assert.equal(snapshot.account.accountAddress, nativeTestIdentity.accountAddress);
  assert.equal(snapshot.account.statusName, "Active");
  assert.equal(snapshot.account.custodyAddress, custody);
  // v4.1 keeps the recovery policy in the module, so a seat-less account has no
  // native recovery state and the overview says so instead of inventing one.
  assert.equal(snapshot.account.requiredValidatorId, "0");
  assert.equal(snapshot.account.controlRevision, "1");
  assert.equal(snapshot.account.recoverySeat, null);
  assert.equal(snapshot.account.governanceDelayMs, null);
  assert.equal(snapshot.account.configurationNonce, "0");
  assert.deepEqual(snapshot.balances, { NEO: "17", GAS: "200000001" });
  assert.ok(!Object.hasOwn(snapshot, "modules"));
  const modules = await f.workspace.loadModules(snapshot.account.accountId, snapshot.account.configurationNonce);
  assert.deepEqual(modules.validators.map((m) => m.moduleId), ["1"]);
  assert.equal(modules.validators[0].credentialGeneration, "1");
  assert.deepEqual(modules.hooks.map((m) => m.moduleId), ["2"]);
  assert.equal(snapshot.chainTime, f.rpc.state.time);
  assert.equal(snapshot.account.pendingRecovery, null);
});

test("overview RPC count does not grow with validators and hooks; an unreadable balance is not zero", async () => {
  const counts = [];
  for (const count of [0, 32]) {
    const f = await connected({ registered: true, mutate: state => {
      state.modules = Array.from({ length: count }, (_, i) => ({ moduleId: i + 1, moduleType: 1, credentialGeneration: 1, contractHash: "44".repeat(20) }));
      state.neoBalance = null; state.gasBalance = "0";
    } });
    f.rpc.state.calls.length = 0;
    const snapshot = await f.workspace.load(nativeTestIdentity.accountId);
    assert.deepEqual(snapshot.balances, { NEO: null, GAS: "0" });
    counts.push(f.rpc.state.calls.length);
  }
  assert.equal(counts[0], counts[1], "the overview reads the record, not the roster");
});

test("module details reject configuration changes before and during enumeration", async () => {
  const f = await connected({ registered: true });
  await assert.rejects(f.workspace.loadModules(nativeTestIdentity.accountId, "4"), /configuration changed/);
  const getAccount = f.client.getAccount.bind(f.client);
  f.client.getAccount = async id => ({ ...await getAccount(id), configurationNonce: "5" });
  await assert.rejects(f.workspace.loadModules(nativeTestIdentity.accountId, "0"), /configuration changed/);
});

test("the governance module publishes the configuration window and its pending intents", async () => {
  const governanceHash = "55".repeat(20);
  const f = await connected({ registered: true, mutate: state => {
    state.modules = [
      { moduleId: 1, moduleType: 1, credentialGeneration: 1, contractHash: "44".repeat(20) },
      { moduleId: 2, moduleType: 1, credentialGeneration: 1, contractHash: governanceHash, governance: true },
    ];
    state.governanceDelayMs = "86400000";
    // The module publishes the kind as its UTF-8 string, never a tag.
    state.pendingConfigIntents = [{
      intentId: 7, kind: "configure", proposedAt: 1000, matureAt: 87400000, expiresAt: 604801000,
      configurationNonce: 0, actionCount: 2, digest: "ab".repeat(32),
    }];
  } });
  const roster = await f.workspace.loadModules(nativeTestIdentity.accountId, "0");
  assert.equal(roster.validators.length, 2);
  assert.equal(roster.governanceCheckFailed, false);
  assert.equal(roster.governance.supported, true);
  assert.equal(roster.governance.governanceDelayMs, "86400000");
  assert.deepEqual(roster.governance.intentIds, ["7"]);
  assert.equal(roster.governance.intents.length, 1);
  assert.equal(roster.governance.intents[0].kind, "configure");
  assert.equal(roster.governance.intents[0].matureAt, "87400000");
  assert.equal(roster.governance.intents[0].expiresAt, "604801000");
  assert.equal(roster.governance.intents[0].actionCount, 2);
  assert.equal(roster.governance.intents[0].digest, "ab".repeat(32));

  // The same account without a governance instance reports absence, not a
  // native delay: the core publishes no configuration window at all.
  const plain = await connected({ registered: true, mutate: state => {
    state.modules = [{ moduleId: 1, moduleType: 1, credentialGeneration: 1, contractHash: "44".repeat(20) }];
  } });
  const bare = await plain.workspace.loadModules(nativeTestIdentity.accountId, "0");
  assert.equal(bare.governance, null);
  assert.equal(bare.governanceCheckFailed, false);
  const overview = await plain.workspace.load(nativeTestIdentity.accountId);
  assert.equal(overview.account.governanceDelayMs, null);
  assert.deepEqual(overview.account.pendingConfiguration.intents, []);
});

test("the transfer draft uses the funding proxy and exact units, and binds the node nonce, route and network", async () => {
  const f = await connected({ registered: true });
  const input = { accountId: nativeTestIdentity.accountId, recipient: stranger, symbol: "GAS", amount: "0.00000001" };
  const draft = await f.workspace.transferDraft(input);
  assert.deepEqual(draft.operation.args, [nativeCodec.hashValue(nativeTestIdentity.accountAddress),
    nativeCodec.hashValue(stranger), I(1), { type: "Null" }]);
  assert.equal(draft.operation.configurationNonce, "0");
  assert.equal(draft.operation.credentialGeneration, await f.client.resolveCredentialGeneration(input.accountId, 0));
  assert.notEqual(draft.operation.nonce, "1");
  assert.equal(draft.operation.deadline, String(f.rpc.state.time + 900000));
  assert.equal(draft.digest, nativeCodec.operationDigest({ accountId: input.accountId, networkMagic: 123, coreContractHash: NATIVE_SMART_ACCOUNT_CONTRACT }, draft.operation));
  for (const [symbol, amount] of [["NEO", "0.1"], ["GAS", "0.000000001"], ["GAS", "0"]])
    await assert.rejects(f.workspace.transferDraft({ ...input, symbol, amount }));
  f.rpc.state.status = 1;
  await assert.rejects(f.workspace.transferDraft(input), /active account/);
});
test("discovery must complete before a review and invalidation discards every review", async () => {
  const rpc = createNativeRpcFixture();
  const workspace = createNativeWorkspace({
    makeClient: () => new Client({ rpcClient: rpc, networkMagic: 123 }),
  });
  await assert.rejects(
    () => workspace.registration({ custodyAddress: custody, salt }),
    /discovery/i,
  );
  await workspace.connect({});
  const review = await workspace.registration({
    custodyAddress: custody,
    salt,
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
  assert.equal(sent.request.args.length, 4);
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
    actions,
  });
  assert.equal(review.plan.kind, "registration");
  assert.deepEqual(review.requiredAuthorities, [custody]);
  assert.deepEqual(review.signers, [
    { account: "0x" + custody, scopes: "CalledByEntry" },
  ]);
  assert.deepEqual(review.request.args[3], A(actions));
  assert.equal(review.request.args.length, 4, "createAccount is exactly (accountId, custody, salt, actions)");
  const exact = await workspace.registration({
    custodyAddress: custody,
    salt,
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
  });
  rpc.state.magic = 456;
  await assert.rejects(() => workspace.submit(review), /network magic mismatch/);
  assert.equal(workspace.profile, null);
});

test("a recovery policy rotation is a governed module configure action, never a core method", async () => {
  const f = await connected({ registered: true, mutate: state => {
    state.recovery = recovery;
    state.timelock = String(90 * 86400000);
    state.modules = [nativeTestRecoverySeat];
  } });
  const accountId = nativeTestIdentity.accountId;
  // v4.1 retired the core recovery-policy action (8): the policy is the
  // RecoveryModule's own state and a rotation is a configure (3) against the
  // seat, gated by the governance module's maturity window.
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId, action: "setRecoveryPolicy" }),
    /supported account action/i,
  );
  const snapshot = await f.workspace.load(accountId);
  assert.equal(snapshot.account.governanceDelayMs, null);
  assert.equal(snapshot.account.recoverySeat.supported, true);
  assert.equal(snapshot.account.recoverySeat.policy.authority, recovery);
  assert.equal(snapshot.account.recoverySeat.policy.timelockMs, String(90 * 86400000));
  const rotate = configureModuleAction({
    moduleId: nativeTestRecoverySeat.moduleId,
    configData: [I(90 * 86400000)],
  });
  assert.equal(rotate.value[0].value, String(NATIVE_ACTION_CODES.configureModule));
  assert.match(describeConfigurationAction(rotate), /Reconfigure module 17/);
  assert.equal(RETIRED_ACTION_CODES.includes(8), true);
});

test("freeze is a custody call on the core; a thaw is the governance module's two-step intent", async () => {
  const f = await connected({ registered: true });
  const account = nativeTestIdentity.accountId;
  const seat = "55".repeat(20);
  const governanceSeat = { moduleId: 9, moduleType: 1, credentialGeneration: 1, contractHash: seat, governance: true };
  const thaw = (extra = {}) => f.workspace.lifecycle({ accountId: account, action: "unfreezeAccount", ...extra });
  const I11 = A([A([I(NATIVE_GOVERNANCE_UNFREEZE_ACTION)])]);

  const freeze = await f.workspace.lifecycle({ accountId: account, action: "freezeAccount" });
  assert.deepEqual(freeze.requiredAuthorities, [custody]);
  assert.equal(freeze.submission, "wallet-invoke");
  assert.equal(freeze.plan.kind, "account");
  assert.equal(freeze.plan.method, "freezeAccount");
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "freezeAccount", feePayer: stranger }),
    /custody wallet can sign/i,
  );
  await assert.rejects(() => thaw(), /not frozen/i);

  f.rpc.state.status = 1;
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "freezeAccount" }),
    /already frozen/i,
  );
  // The core admits a thaw only from the bound governance module, so without
  // one the workspace refuses instead of building the failing core call.
  await assert.rejects(() => thaw(), /no supported governance module/i);
  const unbound = await connected({ registered: true, mutate: (state) => {
    state.status = 1;
    state.modules = [governanceSeat];
  } });
  unbound.rpc.setInvocationResult(
    nativeCodec.dynamicCall(seat, "authorizedCore", [], 5),
    { type: "ByteString", value: Buffer.from(stranger, "hex").reverse().toString("base64") },
  );
  await assert.rejects(
    () => unbound.workspace.lifecycle({ accountId: account, action: "unfreezeAccount" }),
    /no supported governance module/i,
  );

  f.rpc.state.modules.push(governanceSeat);
  f.rpc.state.time = 1700000000000;
  const proposeScript = nativeCodec.dynamicCall(seat, "unfreezeAccount", [nativeCodec.hashValue(account)]);
  await assert.rejects(() => thaw(), /positive intent id/);
  f.rpc.setInvocationResult(proposeScript, I(1));
  const propose = await thaw();
  assert.equal(propose.submission, "native-sdk", "the exact module script is signed");
  assert.equal(propose.request, null);
  assert.equal(propose.plan.kind, "governance");
  assert.equal(propose.plan.method, "unfreezeAccount");
  assert.equal(propose.plan.targetContract, seat);
  assert.equal(propose.plan.moduleId, "9");
  assert.equal(propose.plan.intentId, null);
  assert.equal(propose.plan.governanceDelayMs, "86400000");
  assert.equal(propose.plan.script, proposeScript);
  assert.notEqual(propose.plan.script, nativeCodec.dynamicCall(NATIVE_SMART_ACCOUNT_CONTRACT, "unfreezeAccount", [nativeCodec.hashValue(account)]));
  assert.deepEqual(propose.requiredAuthorities, [custody]);
  assert.deepEqual(propose.signers, [
    { account: "0x" + custody, scopes: "CustomContracts", allowedcontracts: ["0x" + seat] },
  ]);
  assert.deepEqual(propose.recipe, { method: "buildGovernanceModulePlan", input: { accountId: account, action: "unfreezeAccount" } });
  assert.match(propose.description, /confirmed by custody after the module's delay \(1 day\)/);
  // No intent exists yet: the earliest confirmation is the chain time plus the
  // module's delay, offered as an estimate only.
  assert.equal(propose.estimatedConfirmAt, 1700000000000 + 86400000);
  assert.equal(propose.intentKind, undefined);
  assert.deepEqual(await rebuildNativeReview(f.client, await f.workspace.exportReview(propose)), propose.plan);
  // A refused re-review revokes the earlier review rather than keeping it.
  await assert.rejects(() => thaw({ authority: stranger }), /custody wallet can sign/i);
  assert.equal(f.workspace.review, null);
  // Another wallet may pay; it never stands in for custody.
  const paid = await thaw({ feePayer: stranger });
  assert.deepEqual(paid.requiredAuthorities, [custody]);
  assert.deepEqual(paid.signers, [
    { account: "0x" + stranger, scopes: "None" },
    { account: "0x" + custody, scopes: "CustomContracts", allowedcontracts: ["0x" + seat] },
  ]);

  // The pending unfreeze intent decides the step: custody confirms it on the
  // module once the 24-hour delay has matured, repeating the action bytes.
  f.rpc.state.pendingConfigIntents.push({
    intentId: 1, kind: "unfreeze", proposedAt: f.rpc.state.time - 3600000,
    matureAt: f.rpc.state.time + 60000, expiresAt: f.rpc.state.time + 60000 * 60 * 24 * 7, actionCount: 1,
  });
  await assert.rejects(() => thaw(), /has not matured.*#1/i);
  f.rpc.state.pendingConfigIntents[0].matureAt = f.rpc.state.time;
  const confirm = await thaw();
  assert.equal(confirm.plan.kind, "governance");
  assert.equal(confirm.plan.method, "confirmConfiguration");
  assert.equal(confirm.plan.intentId, "1");
  assert.equal(confirm.plan.pending.kind, "unfreeze");
  assert.equal(confirm.plan.script, nativeCodec.dynamicCall(seat, "confirmConfiguration", [nativeCodec.hashValue(account), I(1), I11]));
  assert.equal(confirm.intentId, "1");
  assert.deepEqual(confirm.intentActions, [NATIVE_GOVERNANCE_UNFREEZE_ACTION]);
  assert.equal(confirm.intentKind, "unfreeze");
  // The confirmation step carries no estimate: the module's maturity is exact.
  assert.equal(confirm.estimatedConfirmAt, undefined);
  assert.deepEqual(confirm.requiredAuthorities, [custody]);
  assert.deepEqual(confirm.recipe, { method: "buildGovernanceModulePlan", input: { accountId: account, action: "confirmConfiguration", intentId: "1" } });
  assert.match(confirm.description, /Confirm unfreeze intent #1/);
  assert.deepEqual(await rebuildNativeReview(f.client, await f.workspace.exportReview(confirm)), confirm.plan);

  const stale = async (patch, expected) => {
    const intent = f.rpc.state.pendingConfigIntents[0];
    const prior = { ...intent };
    Object.assign(intent, patch);
    await assert.rejects(() => thaw(), expected);
    f.rpc.state.pendingConfigIntents[0] = prior;
  };
  await stale({ configurationNonce: 1 }, /configuration nonce is stale/);
  await stale({ authorityEpoch: 2 }, /epoch is stale/);
  await stale({ expiresAt: f.rpc.state.time - 1 }, /expired/);
  await stale({ actionCount: 2 }, /not the single unfreeze action/);
  f.rpc.state.pendingConfigIntents[0].configurationNonce = 1;
  await assert.rejects(() => f.client.revalidatePlan(confirm.plan), /stale|changed/);
  // A stale confirmation recipe names the intent it reviewed.
  await assert.rejects(
    () => f.client.buildGovernanceModulePlan({ accountId: account, action: "confirmConfiguration", intentId: "2" }),
    /intent changed/,
  );
  // Only a configure intent pending: the unfreeze is still a proposal.
  f.rpc.state.pendingConfigIntents = [{ intentId: 5, kind: "configure", matureAt: 1, actionCount: 2 }];
  assert.equal((await thaw()).plan.method, "unfreezeAccount");
});

test("durationText gives the module and recovery delays one wording", () => {
  assert.equal(durationText("86400000"), "1 day");
  assert.equal(durationText(7 * 86400000), "7 days");
  assert.equal(durationText(90000000), "25 hours");
  assert.equal(durationText(3600000), "1 hour");
  assert.equal(durationText(5400000), "1.5 hours");
  assert.equal(durationText("unknown"), "unknown ms");
  const zh = (_en, text) => text;
  assert.equal(durationText("86400000", zh), "1 天");
  assert.equal(durationText(7200000, zh), "2 小时");
});

test("the freeze and thaw read in Chinese through the workspace translator", async () => {
  const seat = "66".repeat(20);
  const account = nativeTestIdentity.accountId;
  const zh = (en, text) => text;
  const f = await connected({ registered: true, translate: zh, mutate: (state) => {
    state.status = 1;
    state.time = 1700000000000;
    state.modules.push({ moduleId: 9, moduleType: 1, credentialGeneration: 1, contractHash: seat, governance: true });
  } });
  f.rpc.setInvocationResult(
    nativeCodec.dynamicCall(seat, "unfreezeAccount", [nativeCodec.hashValue(account)]),
    I(1),
  );
  assert.equal(actionBlockReason({ status: 1, statusName: "Frozen" }, "freezeAccount", zh), "账户已冻结。");
  assert.equal(actionBlockReason({ status: 0, statusName: "Active" }, "unfreezeAccount", zh), "账户未冻结。");
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId: account, action: "freezeAccount" }),
    /账户已冻结。/,
  );
  const propose = await f.workspace.lifecycle({ accountId: account, action: "unfreezeAccount" });
  assert.equal(
    propose.description,
    "在治理模块上发起解冻提案。由托管方签名；意图需经过模块等待时间（1 天）后，由托管方确认。",
  );
  assert.equal(propose.estimatedConfirmAt, 1700000000000 + 86400000);
  // Without a governance module the refusal is Chinese too.
  const bare = await connected({ registered: true, translate: zh, mutate: (state) => { state.status = 1; } });
  await assert.rejects(
    () => bare.workspace.lifecycle({ accountId: account, action: "unfreezeAccount" }),
    /未安装受支持的治理模块，托管方无法单独解冻该账户。/,
  );
});

test("the recovery lifecycle stays a module concern and is never planned against the core", async () => {
  const f = await connected({
    registered: true,
    mutate: (state) => {
      state.recovery = recovery;
      state.pendingRecovery = { newCustody: stranger, matureAt: Date.now() + 60_000 };
    },
  });
  const account = nativeTestIdentity.accountId;
  assert.equal((await f.workspace.load(account)).account.pendingRecovery, null);
  for (const action of ["beginRecovery", "executeRecovery", "cancelRecovery"])
    await assert.rejects(() => f.workspace.lifecycle({ accountId: account, action }), /no supported recovery module/i);
  f.rpc.state.modules.push({ ...nativeTestRecoverySeat, nefSha256: "00".repeat(32) });
  assert.equal((await f.client.getRecoverySeat(account)).supported, false, "a self-declared profile is not code identity");
  f.rpc.state.modules[0] = { ...nativeTestRecoverySeat, liveUpdateCounter: 2 };
  assert.equal((await f.client.getRecoverySeat(account)).supported, false, "an upgraded deployment requires a new binding");
  f.rpc.state.modules[0] = nativeTestRecoverySeat;
  const state = await f.workspace.load(account);
  assert.equal(state.account.pendingRecovery.newCustody, stranger);
  const cancel = await f.workspace.lifecycle({ accountId: account, action: "cancelRecovery", feePayer: stranger, authority: recovery });
  assert.equal(cancel.plan.targetContract, nativeTestRecoverySeat.contractHash);
  assert.equal(cancel.submission, "native-sdk");
  assert.deepEqual(cancel.signers[1].allowedcontracts, ["0x" + nativeTestRecoverySeat.contractHash]);
  assert.deepEqual(await rebuildNativeReview(f.client, await f.workspace.exportReview(cancel)), cancel.plan);
  f.rpc.state.pendingRecovery.nonce = 2;
  await assert.rejects(() => f.client.revalidatePlan(cancel.plan), /changed/);
  f.rpc.state.pendingRecovery = null;
  const beginScript = nativeCodec.dynamicCall(nativeTestRecoverySeat.contractHash, "beginRecovery",
    [nativeCodec.hashValue(account), nativeCodec.hashValue(stranger)]);
  f.rpc.setInvocationResult(beginScript, I(0));
  await assert.rejects(f.workspace.lifecycle({ accountId: account, action: "beginRecovery", newCustody: stranger }), /positive nonce/);
  f.rpc.setInvocationResult(beginScript, I(2));
  const begin = await f.workspace.lifecycle({ accountId: account, action: "beginRecovery", newCustody: stranger });
  assert.deepEqual(begin.requiredAuthorities, [custody, stranger]);
  assert.equal(begin.plan.targetContract, nativeTestRecoverySeat.contractHash);

});

test("actionBlockReason checks core status and recovery seat availability", () => {
  const active = { statusName: "Active", pendingRecovery: null };
  const frozen = { ...active, statusName: "Frozen" };
  const invalid = { ...active, statusName: "invalid" };
  assert.equal(actionBlockReason(active, "freezeAccount"), "");
  assert.match(actionBlockReason(frozen, "freezeAccount"), /already frozen/);
  assert.match(actionBlockReason(active, "unfreezeAccount"), /not frozen/);
  assert.equal(actionBlockReason(frozen, "unfreezeAccount"), "");
  assert.match(actionBlockReason(invalid, "freezeAccount"), /unrecognized/i);
  assert.match(actionBlockReason(invalid, "unfreezeAccount"), /unrecognized/i);
  assert.equal(actionBlockReason(null, "freezeAccount"), "Load an account first.");
  for (const action of ["beginRecovery", "cancelRecovery", "executeRecovery"])
    assert.match(actionBlockReason(active, action), /no supported recovery module/i);

});

test("a required validator locks custody administration until governance clears it", async () => {
  const f = await connected({ registered: true, mutate(state) {
    state.recovery = recovery;
    state.requiredValidatorId = "3";
    state.modules = [
      { moduleId: 3, moduleType: 1, contractHash: "55".repeat(20), credentialGeneration: 1, messageCapability: true },
      nativeTestRecoverySeat,
    ];
  } });
  const accountId = nativeTestIdentity.accountId;
  const account = (await f.workspace.load(accountId)).account;
  assert.equal(hasRequiredValidator(account), true);
  assert.equal(account.requiredValidator.moduleId, "3");
  assert.equal(actionBlockReason(account, "beginRecovery"), "");
  for (const action of ["freezeAccount", "unfreezeAccount"])
    await assert.rejects(
      () => f.workspace.lifecycle({ accountId, action }),
      /required validator/i,
    );
  // The core publishes no spending policy: the managed route is the required
  // validator itself, and a retired recovery-policy action is refused outright.
  await assert.rejects(
    () => f.workspace.lifecycle({ accountId, action: "setRecoveryPolicy" }),
    /supported account action/i,
  );
});

test("module administration is an action inside a signed script, never a core intent", async () => {
  const f = await connected({ registered: true });
  const account = nativeTestIdentity.accountId;

  // The core has no propose/confirm/cancel method: it encodes a configuration
  // change as a positional action inside the script it signs. Those encoders
  // must survive the slimming, because installModule/removeModule consume them.
  const install = installModuleAction({
    moduleType: "validator",
    contractHash: "ab".repeat(20),
    profileDigest: "cd".repeat(32),
  });
  assert.equal(install.value.length, 5, "the install action is the 5-field vector");
  assert.equal(install.value[0].value, String(NATIVE_ACTION_CODES.installModule));
  assert.match(describeConfigurationAction(install), /^Install validator module /);
  const uninstall = uninstallModuleAction({ moduleId: "7" });
  assert.equal(uninstall.value[0].value, String(NATIVE_ACTION_CODES.uninstallModule));
  assert.match(describeConfigurationAction(uninstall), /Uninstall module 7/);
  const policy = setBuiltinAuthorizationAction({
    operationAuthorization: false,
    messageAuthorization: true,
  });
  assert.match(describeConfigurationAction(policy), /operations off, messages on/);
  // Retired codes never render as a live action.
  for (const code of RETIRED_ACTION_CODES)
    assert.match(describeConfigurationAction(A([I(code)])), new RegExp(`Retired action ${code}`));

  // The core publishes no intent record, so the honest inspection is empty and
  // every intent kind must refuse instead of inventing a core script.
  const inspection = await f.workspace.inspectConfiguration({ accountId: account });
  assert.equal(inspection.accountId, account);
  assert.deepEqual(inspection.intents, []);
  for (const kind of ["propose", "confirm", "cancel"])
    await assert.rejects(
      () =>
        f.workspace.configuration({
          kind,
          accountId: account,
          intentId: "3",
          actions: [policy],
        }),
      /governance module/i,
    );
});

test("a stale inspection is refused before it can publish a card", async () => {
  const f = await connected({ registered: true });
  let finish;
  const gate = new Promise((resolve) => (finish = resolve));
  const discover = f.client.discover.bind(f.client);
  f.client.discover = async () => {
    await gate;
    return discover();
  };
  const inspection = f.workspace.inspectConfiguration({
    accountId: nativeTestIdentity.accountId,
  });
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
    authorityEpoch: "1",
    configurationNonce: "0",
    signature: "cd".repeat(64),
    hookProofs: [],
  };
  const payer = "77".repeat(20);
  const review = await f.workspace.operation({
    accountId: account,
    operation,
    feePayer: payer,
  });
  assert.equal(review.plan.kind, "execution");
  assert.equal(review.plan.method, "executeUserOp");
  assert.equal(review.plan.operation.method, "ping");
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
    // One operation is the whole plan: editing it must fail the rebuild.
    [(copy) => (copy.plan.operation = { ...copy.plan.operation, nonce: "9" }), /changed|malformed/i],
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
    authorityEpoch: "1",
    configurationNonce: "0",
    signature: "cd".repeat(64),
  };
  const frozen = await connected({ registered: true, mutate: (state) => (state.status = 1) });
  await assert.rejects(
    () =>
      frozen.workspace.operation({
        accountId: nativeTestIdentity.accountId,
        operation,
      }),
    /not active/i,
  );
  const f = await connected({ registered: true });
  // A list is the retired batch shape. It is refused as protocol-incompatible:
  // never split into trades, never shortened to its first element.
  await assert.rejects(
    () =>
      f.workspace.operation({
        accountId: nativeTestIdentity.accountId,
        operation: [operation],
      }),
    /protocol-incompatible: executeUserOps is retired in v4\.1/,
  );
  await assert.rejects(
    () =>
      f.workspace.operation({
        accountId: nativeTestIdentity.accountId,
        operations: [operation, operation],
      }),
    /protocol-incompatible: executeUserOps is retired in v4\.1/,
  );
  await assert.rejects(
    () => f.workspace.operation({ accountId: nativeTestIdentity.accountId }),
    /13-field operation/i,
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
    [(copy) => (copy.profile.implementationId = "DifferentSmartAccount"), /profile/i],
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
      method: "executeUserOp",
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
          authorityEpoch: "1",
          configurationNonce: "0",
          signature: "cd".repeat(64),
          hookProofs: [],
        }),
      ]),
      // One complete 13-field operation: the receipt judge reads exactly this.
      operation: {
        targetContract: "99".repeat(20),
        method: "transfer",
        args: [],
        nonce: "1",
        nonceSubkey: "ab".repeat(32),
        deadline: "2000",
        validatorId: "0",
        credentialGeneration: "1",
        authorityEpoch: "1",
        configurationNonce: "0",
        signature: "cd".repeat(64),
        hookProofs: [],
      },
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
    [{ log: { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", exception: "inconsistent application result", stack: [{ type: "Boolean", value: true }] }] } }, /exception/i],
    [{ log: { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", stack: [{ type: "Boolean", value: true }, { type: "Boolean", value: true }] }] } }, /exactly one/i],
    [{ log: { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", stack: [{ type: "Boolean", value: false }] }] } }, /transfer/i],
    [{ log: { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", stack: [] }] } }, /exactly one/i],
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
  const log = { txid: hash, executions: [{ trigger: "Application", vmstate: "HALT", stack: [{ type: "Any" }] }] };
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
    // The core keeps no proposal window, so the UI cannot offer one: the tab, its
    // 24-hour copy and the eight encoders for codes the core refuses are gone.
    "workspace.configuration(",
    "workspace.inspectConfiguration(",
    "MODULE_CHANGE_DELAY_MS",
    "CONFIGURATION_INTENT_EXPIRY_MS",
    "MAX_ACTIONS_PER_INTENT",
    "configureModuleAction",
    "setHookOrderAction",
    "setDefaultPolicyAction",
    "setThresholdPolicyAction",
    "setRecoveryPolicyAction",
  ])
    assert.equal(source.includes(removed), false, `${removed} must not survive in the UI`);
  // What it must offer instead: the two action codes the core still executes.
  assert.match(source, /installModuleAction\(/);
  assert.match(source, /uninstallModuleAction\(/);
});

test("the required-validator and built-in authorization actions are the only governed routes left", () => {
  assert.deepEqual(setRequiredValidatorAction({ validatorId: "5" }), A([I(7), I(5), BOOL(true)]));
  assert.deepEqual(
    setRequiredValidatorAction({ validatorId: "0", required: false }),
    A([I(7), I(0), BOOL(false)]),
  );
  assert.throws(() => setRequiredValidatorAction({ validatorId: "0" }), /nonzero module id/i);
  assert.throws(() => setRequiredValidatorAction({ validatorId: 5, required: false }), /validator id 0/i);
  assert.throws(() => setRequiredValidatorAction({ validatorId: 5, required: "yes" }), /boolean/i);
  assert.match(
    describeConfigurationAction(setRequiredValidatorAction({ validatorId: "5" })),
    /Require validator module 5 \(governance delay\)/,
  );
  assert.match(
    describeConfigurationAction(setRequiredValidatorAction({ validatorId: "0", required: false })),
    /Clear the required validator \(governance delay\)/,
  );
});
