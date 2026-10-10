const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NativeSmartAccountClient,
  nativeCodec: c,
  NATIVE_PROFILE_PARAMETER_DIGEST: D,
  NATIVE_ACCOUNT_SERVICE: CORE,
} = require("../src/native");
const {
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
} = require("../src/native/client");
const h = "11".repeat(20),
  custody = "22".repeat(20),
  recovery = "33".repeat(20),
  target = "44".repeat(20),
  verifier = "55".repeat(20);
const I = (v) => ({ type: "Integer", value: String(v) }),
  B = (v) => ({
    type: "ByteString",
    value: Buffer.from(v, "hex").toString("base64"),
  }),
  H = (v) => B(Buffer.from(v, "hex").reverse().toString("hex")),
  A = (value) => ({ type: "Array", value }),
  N = { type: "Any", value: null };
const state = (epoch = 7, config = 11) =>
  A([
    I(2),
    H(h),
    H(c.accountAddress(h)),
    H(custody),
    H(recovery),
    A([H(verifier), B("aa".repeat(32))]),
    N,
    I(0),
    I(config),
    N,
    N,
    N,
    N,
    I(epoch),
  ]);
function fixture() {
  const calls = [];
  let record = state(),
    magic = 12345,
    epoch = 7,
    config = 11,
    nonce = 0n;
  const manifest = {
    name: "AccountManagement",
    extra: { smartAccount: { abiVersion: 2, profileParameterDigest: D } },
    abi: {
      methods: Object.entries(NATIVE_REQUIRED_ABI).map(
        ([name, [params, returntype, safe, names]]) => ({
          name,
          parameters: params.map((type, index) => ({
            name: names[index],
            type,
          })),
          returntype,
          safe,
        }),
      ),
      events: Object.entries(NATIVE_REQUIRED_EVENTS).map(
        ([name, parameters]) => ({
          name,
          parameters: structuredClone(parameters),
        }),
      ),
    },
  };
  const response = new Map();
  const add = (method, args, value, contract = CORE) =>
    response.set(c.dynamicCall(contract, method, args, 5), value);
  const context = () => ({
    accountId: h,
    networkMagic: magic,
    authorityEpoch: String(epoch),
    configurationNonce: String(config),
  });
  const rpcClient = {
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === "getversion") return { protocol: { network: magic } };
      if (method === "getcontractstate")
        return { id: -13, hash: "0x" + CORE, manifest };
      const script = Buffer.from(params[0], "base64").toString("hex");
      add("getVersion", [], I(2));
      add("getAccount", [c.hashValue(h)], record);
      add("getAuthorityEpoch", [c.hashValue(h)], I(epoch));
      add(
        "getAuthorizationDomain",
        [c.hashValue(h)],
        B(c.authorizationDomain(context())),
      );
      add("getNonce", [c.hashValue(h), I(0)], I(nonce));
      add("getNonce", [c.hashValue(h), I(3)], I(nonce));
      if (response.has(script))
        return {
          state: "HALT",
          stack: [response.get(script)],
          gasconsumed: "10",
        };
      return {
        state: "FAULT",
        stack: [],
        exception: "unregistered mock script",
      };
    },
  };
  return {
    client: new NativeSmartAccountClient({ rpcClient, networkMagic: 12345 }),
    calls,
    manifest,
    add,
    context,
    setState: (e, n) => {
      epoch = e;
      config = n;
      record = state(e, n);
    },
    setNonce: (n) => {
      nonce = n;
    },
    setMagic: (n) => {
      magic = n;
    },
  };
}
async function prepare(f, overrides = {}) {
  const input = {
    accountId: h,
    targetContract: target,
    method: "transfer",
    args: [{ type: "Struct", value: [{ type: "Integer", value: "9" }] }],
    deadline: "9999999999999",
    ...overrides,
  };
  const op = {
    ...input,
    nonce: c.composeNonce(input.channel ?? 0, 0).toString(),
    signature: "",
  };
  f.add(
    "getOperationDigest",
    [c.hashValue(h), c.operationValue(op, true)],
    B(c.operationDigest(f.context(), op)),
  );
  return f.client.prepareOperation(input);
}
test("strict native discovery refuses wrong network, ABI, profile, native identity", async () => {
  for (const change of [
    (f) => f.setMagic(5),
    (f) => (f.manifest.extra.smartAccount.abiVersion = 1),
    (f) =>
      (f.manifest.extra.smartAccount.profileParameterDigest = "00".repeat(32)),
    (f) => (f.manifest.abi.methods[0].safe = false),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(() => f.client.discover());
  }
  const f = fixture();
  assert.equal((await f.client.discover()).abiVersion, 2);
});
test("native discovery requires the canonical P256 helper ABI without invoking it", async () => {
  const name = "canonicalP256PublicKey";
  const valid = {
    name,
    parameters: [{ name: "publicKey", type: "ByteArray" }],
    returntype: "ByteArray",
    safe: true,
  };
  for (const entry of [
    null,
    { ...valid, safe: false },
    { ...valid, returntype: "Any" },
    { ...valid, parameters: [{ name: "publicKey", type: "String" }] },
  ]) {
    const f = fixture();
    f.manifest.abi.methods = f.manifest.abi.methods.filter(
      (m) => m.name !== name,
    );
    if (entry) f.manifest.abi.methods.push(entry);
    await assert.rejects(() => f.client.discover(), /ABI/);
  }
  const f = fixture();
  f.manifest.abi.methods = f.manifest.abi.methods.filter(
    (m) => m.name !== name,
  );
  f.manifest.abi.methods.push(valid);
  await f.client.discover();
  assert.equal(
    f.calls.some(
      (call) =>
        call.method === "invokescript" &&
        Buffer.from(call.params[0], "base64").includes(Buffer.from(name)),
    ),
    false,
  );
});
test("native discovery rejects missing, ambiguous and malformed required methods before activation queries", async () => {
  for (const name of Object.keys(NATIVE_REQUIRED_ABI)) {
    const changes = [
      [
        "missing",
        (methods, entry) => methods.splice(methods.indexOf(entry), 1),
      ],
      ["duplicate", (methods, entry) => methods.push(structuredClone(entry))],
      [
        "overload",
        (methods, entry) =>
          methods.push({
            ...entry,
            parameters: [
              ...entry.parameters,
              { name: "unexpected", type: "Any" },
            ],
          }),
      ],
      ["parameter collection", (_, entry) => (entry.parameters = null)],
      [
        "return",
        (_, entry) =>
          (entry.returntype = entry.returntype === "Any" ? "Void" : "Any"),
      ],
      ["safe", (_, entry) => (entry.safe = String(entry.safe))],
    ];
    if (NATIVE_REQUIRED_ABI[name][0].length)
      changes.push(
        ["parameter name", (_, entry) => delete entry.parameters[0].name],
        ["parameter type", (_, entry) => (entry.parameters[0].type = "Any")],
        ["null parameter", (_, entry) => (entry.parameters[0] = null)],
      );
    if (NATIVE_REQUIRED_ABI[name][0].length > 1)
      changes.push([
        "parameter order",
        (_, entry) =>
          ([entry.parameters[0], entry.parameters[1]] = [
            entry.parameters[1],
            entry.parameters[0],
          ]),
      ]);
    for (const [label, change] of changes) {
      const f = fixture();
      change(
        f.manifest.abi.methods,
        f.manifest.abi.methods.find((method) => method.name === name),
      );
      await assert.rejects(
        () => f.client.discover(),
        /native ABI/,
        `${name}: ${label}`,
      );
      assert.equal(f.client.profile, null);
      assert.equal(
        f.calls.some((call) => call.method === "invokescript"),
        false,
      );
    }
  }
});
test("native discovery requires every event with unique names and ordered named parameter types", async () => {
  for (const name of Object.keys(NATIVE_REQUIRED_EVENTS)) {
    const changes = [
      ["missing", (events, entry) => events.splice(events.indexOf(entry), 1)],
      ["duplicate", (events, entry) => events.push(structuredClone(entry))],
      ["parameter collection", (_, entry) => (entry.parameters = {})],
      ["parameter name", (_, entry) => delete entry.parameters[0].name],
      [
        "parameter type",
        (_, entry) => (entry.parameters[0].type = "ByteArray"),
      ],
      ["null parameter", (_, entry) => (entry.parameters[0] = null)],
    ];
    if (NATIVE_REQUIRED_EVENTS[name].length > 1)
      changes.push([
        "parameter order",
        (_, entry) =>
          ([entry.parameters[0], entry.parameters[1]] = [
            entry.parameters[1],
            entry.parameters[0],
          ]),
      ]);
    for (const [label, change] of changes) {
      const f = fixture();
      change(
        f.manifest.abi.events,
        f.manifest.abi.events.find((event) => event.name === name),
      );
      await assert.rejects(
        () => f.client.discover(),
        /native ABI event/,
        `${name}: ${label}`,
      );
      assert.equal(f.client.profile, null);
      assert.equal(
        f.calls.some((call) => call.method === "invokescript"),
        false,
      );
    }
  }
});
test("native discovery rejects malformed descriptor collections and accepts manifest ordering changes", async () => {
  for (const collection of ["methods", "events"]) {
    for (const value of [undefined, null, {}, [null], [[]], [{ name: 1 }]]) {
      const f = fixture();
      f.manifest.abi[collection] = value;
      await assert.rejects(() => f.client.discover(), /native ABI/);
    }
  }
  const f = fixture();
  f.manifest.abi.methods.reverse();
  f.manifest.abi.events.reverse();
  assert.equal((await f.client.discover()).abiVersion, 2);
});
test("native state is exact14 fields with epoch and independently checked address", async () => {
  const f = fixture();
  const state = await f.client.getAccount(h);
  assert.equal(state.authorityEpoch, "7");
  assert.equal(state.configurationNonce, "11");
  assert.equal(state.accountAddress, c.accountAddress(h));
  assert.ok(Object.isFrozen(state));
});
test("native reads use exact invokescript transport preserving nested Struct and sign only current context", async () => {
  const f = fixture(),
    p = await prepare(f, { channel: 3 });
  assert.equal(p.channel, "3");
  assert.equal(p.operation.nonce, (3n << 64n).toString());
  assert.ok(p.preimage.startsWith(c.authorizationDomain(f.context())));
  assert.equal(p.operation.args[0].type, "Struct");
  assert.ok(f.calls.every((x) => x.method !== "invokefunction"));
  assert.ok(
    f.calls
      .filter((x) => x.method === "invokescript")
      .some((x) =>
        Buffer.from(x.params[0], "base64").toString("hex").includes("bf"),
      ),
  );
  assert.equal(await f.client.revalidate(p), true);
  f.setState(8, 12);
  await assert.rejects(() => f.client.revalidate(p), /changed/);
});
test("native tampered prepared values, stale nonce and chain digest disagree fail closed", async () => {
  const f = fixture(),
    p = await prepare(f);
  assert.throws(
    () =>
      f.client.attachSignature(
        { ...p, operation: { ...p.operation, method: "other" } },
        "aa",
      ),
    /modified/,
  );
  f.setNonce(1n);
  await assert.rejects(() => f.client.revalidate(p), /stale/);
  const g = fixture();
  const good = await prepare(g);
  g.add(
    "getOperationDigest",
    [c.hashValue(h), c.operationValue(good.operation, true)],
    B("00".repeat(32)),
  );
  await assert.rejects(
    () =>
      g.client.prepareOperation({
        accountId: h,
        targetContract: target,
        method: "transfer",
        args: good.operation.args,
        deadline: good.operation.deadline,
      }),
    /digest mismatch/,
  );
});
test("execution plan binds canonical script, distinct proxy, exact target scopes", async () => {
  const f = fixture(),
    p = f.client.attachSignature(await prepare(f), "aa");
  const plan = f.client.buildExecution([p]);
  assert.equal(
    plan.script,
    c.buildExecutionScript(h, [p.operation], p.context),
  );
  assert.equal(plan.proxySigner.account, "0x" + c.accountAddress(h));
  assert.deepEqual(plan.proxySigner.allowedcontracts, ["0x" + target]);
  assert.equal(plan.proxySigner.scopes, "CustomContracts");
  assert.equal(plan.proxyWitness.invocation, "");
});
test("native registration uses identityVersion1 and five exact arguments", () => {
  const f = fixture(),
    salt = "77".repeat(32),
    plan = f.client.buildRegistration({
      custodyAddress: custody,
      salt,
      recoveryAddress: recovery,
    });
  assert.equal(
    plan.script,
    c.dynamicCall(CORE, "registerAccount", [
      c.hashValue(custody),
      { type: "ByteString", value: salt },
      c.hashValue("00".repeat(20)),
      c.hashValue("00".repeat(20)),
      c.hashValue(recovery),
    ]),
  );
  assert.deepEqual(plan.requiredAuthorities, [custody]);
  assert.throws(
    () =>
      f.client.buildRegistration({
        custodyAddress: custody,
        salt,
        recoveryAddress: custody,
      }),
    /independent/,
  );
});
test("lifecycle plans distinguish custody, guardian, joint and permissionless recovery", async () => {
  const f = fixture();
  assert.deepEqual(
    (await f.client.buildAction({ accountId: h, action: "freeze" }))
      .requiredAuthorities,
    [recovery],
  );
  assert.deepEqual(
    (await f.client.buildAction({ accountId: h, action: "unfreeze" }))
      .requiredAuthorities,
    [custody, recovery],
  );
  assert.deepEqual(
    (await f.client.buildAction({ accountId: h, action: "executeRecovery" }))
      .requiredAuthorities,
    [],
  );
  await assert.rejects(
    () =>
      f.client.buildAction({ accountId: h, action: "setVerifierDependencies" }),
    /unsupported/,
  );
});
for (const action of [
  "activateVerifier",
  "activateHook",
  "activateRecoveryAddress",
]) {
  test(`matured ${action} plans require no custody signature`, async () => {
    const f = fixture();
    const plan = await f.client.buildAction({ accountId: h, action });
    assert.deepEqual(plan.requiredAuthorities, []);
  });
}

function setCancellationIntent(f, amount = 7, proposedAt = 1, extraArguments = []) {
  const binding = A([H(verifier), B("aa".repeat(32))]);
  f.add(
    "getPendingModuleCall",
    [c.hashValue(h), c.stringValue("verifier")],
    A([
      I(1),
      H(h),
      I(0),
      binding,
      binding,
      B(Buffer.from("setLimit").toString("hex")),
      A([H(h), I(amount), ...extraArguments]),
      I(proposedAt),
      I(proposedAt + 86400000),
      I(11),
    ]),
  );
}

test("module cancellation plans require a role and an existing intent", async () => {
  const f = fixture();
  await assert.rejects(
    () => f.client.buildAction({ accountId: h, action: "cancelModuleCall" }),
    /module role/,
  );
  f.add("getPendingModuleCall", [c.hashValue(h), c.stringValue("verifier")], N);
  await assert.rejects(
    () => f.client.buildAction({
      accountId: h,
      action: "cancelModuleCall",
      role: "verifier",
    }),
    /no pending module call/,
  );
});

test("module cancellation plans retain the role and complete pending intent", async () => {
  const f = fixture();
  setCancellationIntent(f);
  const pending = await f.client.getPendingModuleCall(h, "verifier");
  const plan = await f.client.buildAction({
    accountId: h,
    action: "cancelModuleCall",
    role: "verifier",
  });
  assert.deepEqual(
    { role: plan.role, pending: plan.pending },
    { role: "verifier", pending },
  );
  assert.equal(Object.isFrozen(plan.pending), true);
  assert.equal(Object.isFrozen(plan.pending.invokedArguments.value), true);
  assert.equal(plan.requiresExactScript, true);
  const binding = {
    type: "Array",
    value: [c.hashValue(verifier), { type: "ByteString", value: "aa".repeat(32) }],
  };
  const expected = c.serializeValue({
    type: "Array",
    value: [
      I(1), c.hashValue(h), I(0), binding, structuredClone(binding),
      c.stringValue("setLimit"),
      { type: "Array", value: [c.hashValue(h), I(7)] },
      I(1), I(86400001), I(11),
    ],
  });
  assert.equal(plan.pendingCallBytes, expected);
  const args = [c.hashValue(h), c.stringValue("verifier")];
  const read = c.dynamicCall(CORE, "getPendingModuleCall", args, 5);
  const serialize =
    "11c010" + c.encodeValue(c.stringValue("serialize")) +
    c.encodeValue(c.hashValue("acce6fd80d44e1796aa0c2c625e9e4e0ce39efc0")) +
    "41627d5b52";
  const cancel = c.dynamicCall(CORE, "cancelModuleCall", args);
  assert.equal(
    plan.script,
    read + serialize + c.encodeValue({ type: "ByteString", value: expected }) +
      "9739" + cancel,
  );
  assert.notEqual(plan.script, cancel);
});

test("module cancellation guard preserves canonical VM argument types and depth", async () => {
  const values = [
    I(1), B("01"), { type: "Boolean", value: true }, N,
    A([I(1)]), { type: "Struct", value: [I(1)] },
  ];
  const encodings = new Set();
  for (const value of values) {
    const f = fixture();
    setCancellationIntent(f, 7, 1, [value]);
    const plan = await f.client.buildAction({
      accountId: h, action: "cancelModuleCall", role: "verifier",
    });
    assert.equal(plan.requiresExactScript, true);
    encodings.add(plan.pendingCallBytes);
  }
  assert.equal(encodings.size, values.length);
  let nested = I(1);
  for (let depth = 0; depth < 8; depth++) nested = A([nested]);
  const f = fixture();
  setCancellationIntent(f, 7, 1, [nested]);
  const plan = await f.client.buildAction({
    accountId: h, action: "cancelModuleCall", role: "verifier",
  });
  assert.ok(plan.pendingCallBytes);
  setCancellationIntent(f, 7, 1, [A([nested])]);
  await assert.rejects(
    () => f.client.buildAction({
      accountId: h, action: "cancelModuleCall", role: "verifier",
    }),
    /depth/,
  );
});

test("module cancellation guard treats an identical pending record as the same content", async () => {
  const f = fixture();
  setCancellationIntent(f);
  const before = await f.client.buildAction({
    accountId: h, action: "cancelModuleCall", role: "verifier",
  });
  setCancellationIntent(f);
  const after = await f.client.buildAction({
    accountId: h, action: "cancelModuleCall", role: "verifier",
  });
  assert.equal(before.pendingCallBytes, after.pendingCallBytes);
  assert.equal(before.script, after.script);
  assert.equal(await f.client.revalidatePlan(before), true);
});

test("module cancellation rejects a replacement intent with an unchanged account record", async () => {
  const f = fixture();
  setCancellationIntent(f);
  const before = await f.client.getAccount(h);
  const plan = await f.client.buildAction({
    accountId: h,
    action: "cancelModuleCall",
    role: "verifier",
  });
  assert.equal(await f.client.revalidatePlan(plan), true);
  setCancellationIntent(f, 99, 2);
  assert.deepEqual(await f.client.getAccount(h), before);
  await assert.rejects(() => f.client.revalidatePlan(plan), /phase changed/);
});
test("gasconsumed alone never declares automatic system fee available", async () => {
  const f = fixture();
  const plan = { script: c.dynamicCall(CORE, "getVersion", [], 5) };
  const result = await f.client.simulate(plan);
  assert.equal(result.gasConsumed, "10");
  assert.equal(result.minimumRequiredFee, null);
  assert.equal(result.automaticSystemFeeAvailable, false);
});

test("batch preparation and validation keep independent two-dimensional cursors", async () => {
  const f = fixture();
  const inputs = [
    {
      targetContract: target,
      method: "ping",
      args: [],
      deadline: "9999999999999",
      channel: 3,
    },
    {
      targetContract: target,
      method: "ping",
      args: [],
      deadline: "9999999999999",
      channel: 0,
    },
    {
      targetContract: target,
      method: "ping",
      args: [],
      deadline: "9999999999999",
      channel: 3,
    },
  ];
  for (const [index, input] of inputs.entries()) {
    const operation = {
      ...input,
      nonce: c.composeNonce(input.channel, index === 2 ? 1 : 0).toString(),
      signature: "",
    };
    f.add(
      "getOperationDigest",
      [c.hashValue(h), c.operationValue(operation, true)],
      B(c.operationDigest(f.context(), operation)),
    );
  }
  const prepared = await f.client.prepareOperations({
    accountId: h,
    operations: inputs,
  });
  assert.deepEqual(
    prepared.map((p) => p.operation.nonce),
    [(3n << 64n).toString(), "0", ((3n << 64n) + 1n).toString()],
  );
  const plan = f.client.buildExecution(prepared);
  assert.equal(plan.batch, true);
  assert.equal(await f.client.revalidateExecution(plan), true);
  assert.throws(
    () => f.client.buildExecution([prepared[0], prepared[0]]),
    /progression/,
  );
  f.setNonce(1n);
  await assert.rejects(() => f.client.revalidateExecution(plan), /stale/);
});

test("malformed account epochs refuse while raw domain vectors remain independent", async () => {
  const f = fixture();
  f.setState(12, 11);
  await assert.rejects(() => f.client.getAccount(h), /epoch exceeds/);
});

test("client network and profile pins cannot be switched after identity derivation", () => {
  const f = fixture(),
    identity = f.client.deriveIdentity({
      custodyAddress: custody,
      salt: "77".repeat(32),
    });
  f.client.networkMagic = 999;
  f.client.profileParameterDigest = "00".repeat(32);
  assert.equal(f.client.networkMagic, 12345);
  assert.equal(f.client.profileParameterDigest, D);
  assert.deepEqual(
    f.client.deriveIdentity({ custodyAddress: custody, salt: "77".repeat(32) }),
    identity,
  );
});
test("module configuration prepends account only in core and rejects a changed proposal phase", async () => {
  const f = fixture(),
    send = f.client.rpc.send;
  f.client.rpc.send = async (method, params) =>
    method === "getcontractstate" && params[0] === "0x" + verifier
      ? {
          manifest: {
            extra: {
              smartAccount: {
                abiVersion: 2,
                profileDigest: D,
                compositeVerifier: false,
                configurationMethods: ["setLimit"],
              },
            },
            abi: {
              methods: [
                {
                  name: "setLimit",
                  safe: false,
                  parameters: [{ type: "Hash160" }, { type: "Integer" }],
                },
              ],
            },
          },
        }
      : send(method, params);
  f.add("supportsComposition", [], { type: "Boolean", value: false }, verifier);
  f.add("getPendingModuleCall", [c.hashValue(h), c.stringValue("verifier")], N);
  const plan = await f.client.buildModuleCall({
    accountId: h,
    role: "verifier",
    method: "setLimit",
    args: [{ type: "Integer", value: "7" }],
  });
  assert.equal(
    plan.script,
    c.dynamicCall(CORE, "callVerifier", [
      c.hashValue(h),
      c.stringValue("setLimit"),
      { type: "Array", value: [{ type: "Integer", value: "7" }] },
    ]),
  );
  assert.equal(await f.client.revalidatePlan(plan), true);
  const binding = A([H(verifier), B("aa".repeat(32))]);
  f.add(
    "getPendingModuleCall",
    [c.hashValue(h), c.stringValue("verifier")],
    A([
      I(1),
      H(h),
      I(0),
      binding,
      binding,
      B(Buffer.from("setLimit").toString("hex")),
      A([H(h), I(7)]),
      I(1),
      I(86400001),
      I(11),
    ]),
  );
  await assert.rejects(() => f.client.revalidatePlan(plan), /phase changed/);
  const fresh = await f.client.buildModuleCall({
    accountId: h,
    role: "verifier",
    method: "setLimit",
    args: [{ type: "Integer", value: "7" }],
  });
  assert.equal(fresh.pending.method, "setLimit");
  assert.equal(fresh.pending.invokedArguments.type, "Array");
  assert.equal(await f.client.revalidatePlan(fresh), true);
});

async function simulationFixture(batch = false) {
  const f = fixture();
  const prepared = await prepare(f);
  const plan = await f.client.buildExecution([prepared]);
  const simulatedPlan = batch
    ? {
        ...plan,
        batch: true,
        preparedOperations: [prepared, { operation: { method: "ping" } }],
      }
    : plan;
  const send = f.client.rpc.send;
  let result;
  f.client.rpc.send = (method, params) =>
    method === "invokescript" &&
    params[0] === Buffer.from(plan.script, "hex").toString("base64")
      ? result
      : send(method, params);
  return {
    ...f,
    plan: simulatedPlan,
    setResult: (stack) => {
      result = { state: "HALT", stack, gasconsumed: "10", minimumrequiredfee: "100" };
    },
  };
}
test("native simulation rejects missing/malformed stack and exact batch shape mismatches", async () => {
  const f = await simulationFixture();
  for (const stack of [
    undefined,
    null,
    {},
    [],
    [N, N],
    [{ type: "Boolean", value: "true" }],
    [{ type: "Integer", value: "1x" }],
    [{ type: "ByteString", value: "??" }],
    [{ type: "Array", value: null }],
  ]) {
    f.setResult(stack);
    await assert.rejects(() => f.client.simulate(f.plan), /stack|result/i);
  }
  const batch = await simulationFixture(true);
  for (const stack of [
    [N],
    [A([])],
    [A([N])],
    [{ type: "Struct", value: [N, N] }],
    [A([N, { type: "InteropInterface" }])],
  ]) {
    batch.setResult(stack);
    await assert.rejects(
      () => batch.client.simulate(batch.plan),
      /stack|result/i,
    );
  }
});
test("native simulation requires strictly true transfer results but preserves arbitrary target return values", async () => {
  const f = await simulationFixture();
  for (const item of [{ type: "Boolean", value: false }, I(1), N, A([])]) {
    f.setResult([item]);
    const r = await f.client.simulate(f.plan);
    assert.deepEqual(r.failedTransfers, [0]);
    assert.equal(r.automaticSystemFeeAvailable, false);
  }
  const batch = await simulationFixture(true);
  const result = A([
    { type: "Boolean", value: true },
    { type: "Boolean", value: false },
  ]);
  batch.setResult([result]);
  assert.deepEqual(
    (await batch.client.simulate(batch.plan)).failedTransfers,
    [],
  );
  const arbitrary = {
    ...f.plan,
    preparedOperations: [{ operation: { method: "ping" } }],
  };
  for (const item of [
    N,
    I(1),
    { type: "Boolean", value: false },
    {
      type: "Map",
      value: [{ key: I(1), value: { type: "Buffer", value: "AA==" } }],
    },
  ]) {
    f.setResult([item]);
    assert.deepEqual((await f.client.simulate(arbitrary)).failedTransfers, []);
  }
});

test("composite validation and post-execution callbacks are never configuration methods", async () => {
  const f = fixture();
  for (const method of [
    "validateCompositeSignature",
    "postExecuteComposite",
    "validateSignatureForPostExecute",
  ]) {
    await assert.rejects(
      () =>
        f.client.buildModuleCall({ accountId: h, role: "verifier", method }),
      /invalid module configuration call/,
    );
  }
});

test("module configuration requires the exact service profile and typed composition marker", async () => {
  for (const change of [
    (m) => delete m.abiVersion,
    (m) => (m.abiVersion = 1),
    (m) => (m.abiVersion = "2"),
    (m) => delete m.profileDigest,
    (m) => (m.profileDigest = "00".repeat(32)),
    (m) => delete m.compositeVerifier,
    (m) => (m.compositeVerifier = 0),
    (m) => (m.compositeVerifier = true),
  ]) {
    const f = fixture(),
      send = f.client.rpc.send;
    const metadata = {
      abiVersion: 2,
      profileDigest: D,
      compositeVerifier: false,
      configurationMethods: ["setLimit"],
    };
    change(metadata);
    f.client.rpc.send = (method, params) =>
      method === "getcontractstate" && params[0] === "0x" + verifier
        ? {
            manifest: {
              extra: { smartAccount: metadata },
              abi: {
                methods: [
                  {
                    name: "setLimit",
                    safe: false,
                    parameters: [{ type: "Hash160" }, { type: "Integer" }],
                  },
                ],
              },
            },
          }
        : send(method, params);
    f.add(
      "supportsComposition",
      [],
      { type: "Boolean", value: false },
      verifier,
    );
    f.add(
      "getPendingModuleCall",
      [c.hashValue(h), c.stringValue("verifier")],
      N,
    );
    await assert.rejects(
      () =>
        f.client.buildModuleCall({
          accountId: h,
          role: "verifier",
          method: "setLimit",
          args: [I(7)],
        }),
      /module profile|composition/i,
    );
  }
});

test("native verifier dependency readback enforces the profile three-child cleanup and active limits", async () => {
  for (const [cleanupCount, activeCount] of [
    [4, 0],
    [3, 4],
  ]) {
    const f = fixture();
    const children = Array.from({ length: 4 }, (_, index) =>
      (index + 6).toString().repeat(40),
    );
    f.add(
      "getModuleDependencies",
      [c.hashValue(h), c.stringValue("verifier")],
      A([
        A([H(verifier), B("aa".repeat(32))]),
        A(
          children
            .slice(0, cleanupCount)
            .map((child) => A([H(child), B("ab".repeat(32))])),
        ),
        A(children.slice(0, activeCount).map(H)),
      ]),
    );
    await assert.rejects(
      () => f.client.getModuleDependencies(h, "verifier"),
      /three|limit|bound/,
    );
  }
});

function multiSigConfigurationFixture() {
  const f = fixture(),
    send = f.client.rpc.send;
  const manifest = {
    name: "MultiSigVerifier",
    extra: {
      SmartAccountProfile: "native-v2",
      smartAccount: {
        abiVersion: 2,
        profileDigest: D,
        compositeVerifier: true,
        configurationMethods: ["setConfig"],
      },
    },
    abi: {
      methods: [
        {
          name: "setConfig",
          safe: false,
          parameters: ["Hash160", "Array", "Integer"].map((type) => ({ type })),
        },
      ],
    },
  };
  f.client.rpc.send = (method, params) =>
    method === "getcontractstate" && params[0] === "0x" + verifier
      ? { manifest }
      : send(method, params);
  f.add("supportsComposition", [], { type: "Boolean", value: true }, verifier);
  f.add("getPendingModuleCall", [c.hashValue(h), c.stringValue("verifier")], N);
  return {
    ...f,
    moduleManifest: manifest,
    build: (args) =>
      f.client.buildModuleCall({
        accountId: h,
        role: "verifier",
        method: "setConfig",
        args,
      }),
  };
}

test("official native MultiSig configuration rejects doomed roster and threshold shapes before staging", async () => {
  const children = ["67", "78", "89", "9a"].map((x) => x.repeat(20));
  const roster = (list) => ({ type: "Array", value: list.map(c.hashValue) });
  for (const args of [
    [roster([]), I(1)],
    [roster(children), I(2)],
    [roster(children.slice(0, 3)), I(3)],
    [roster(children.slice(0, 1)), I(2)],
    [roster(children.slice(0, 2)), I(0)],
    [roster(children.slice(0, 2)), { type: "Boolean", value: true }],
    [roster([children[0], children[0]]), I(1)],
    [roster(["00".repeat(20)]), I(1)],
    [roster([verifier]), I(1)],
    [roster([CORE]), I(1)],
    [{ type: "Struct", value: children.slice(0, 2).map(c.hashValue) }, I(1)],
    [{ type: "Array", value: [I(1)] }, I(1)],
    [
      {
        type: "Array",
        value: [{ type: "ByteString", value: "67".repeat(19) }],
      },
      I(1),
    ],
  ]) {
    const f = multiSigConfigurationFixture();
    await assert.rejects(() => f.build(args), /native MultiSig/i);
    assert.equal(
      f.calls.some(
        (call) =>
          call.method === "invokescript" &&
          Buffer.from(call.params[0], "base64").toString("hex") ===
            c.dynamicCall(
              CORE,
              "getPendingModuleCall",
              [c.hashValue(h), c.stringValue("verifier")],
              5,
            ),
      ),
      false,
    );
  }
});

test("official native MultiSig configuration preserves a valid 3-of-roster 2-threshold order", async () => {
  const f = multiSigConfigurationFixture();
  const args = [
    {
      type: "Array",
      value: ["89", "67", "78"].map((x) => c.hashValue(x.repeat(20))),
    },
    I(2),
  ];
  const plan = await f.build(args);
  assert.equal(
    plan.script,
    c.dynamicCall(CORE, "callVerifier", [
      c.hashValue(h),
      c.stringValue("setConfig"),
      { type: "Array", value: args },
    ]),
  );
});

test("MultiSig convenience is bound to the declared official native profile, not a generic setConfig name", async () => {
  for (const mutate of [
    (m) => (m.name = "ThirdPartyVerifier"),
    (m) => delete m.extra.SmartAccountProfile,
    (m) => (m.abi.methods[0].parameters[1].type = "Any"),
  ]) {
    const f = multiSigConfigurationFixture();
    mutate(f.moduleManifest);
    // Generic configuration capabilities keep their own semantics; core still validates them.
    assert.equal((await f.build([I(123), I(456)])).kind, "configuration");
  }
  const f = multiSigConfigurationFixture();
  f.moduleManifest.extra.smartAccount.profileDigest = "00".repeat(32);
  await assert.rejects(() => f.build([I(123), I(456)]), /module profile/);
});

for (const invalid of [
  {gasconsumed:"10", minimumrequiredfee:"9"},
  ...[10, null, "", "01", "-1", "1.5", "0x10", "9223372036854775808"].flatMap(value => [
    {gasconsumed:value, minimumrequiredfee:"100"}, {gasconsumed:"10", minimumrequiredfee:value},
  ]),
]) {
  test(`simulation refuses invalid RPC fee fields ${JSON.stringify(invalid)}`, async () => {
    const f = fixture();
    await f.client.discover();
    const send = f.client.rpc.send;
    f.client.rpc.send = (method, params) => method === "invokescript" && params[0] === "q80="
      ? {state:"HALT", stack:[I(1)], ...invalid} : send(method, params);
    await assert.rejects(f.client.simulate({kind:"lifecycle", script:"abcd"}), /fee|gasconsumed/);
  });
}

test("module configuration resolves same-name overloads by full argument count", async () => {
  const f = fixture(), send = f.client.rpc.send;
  const one = {name:"setLimit",safe:false,parameters:[{type:"Hash160"},{type:"Integer"}]};
  const two = {...one,parameters:[...one.parameters,{type:"Integer"}]};
  let methods = [one, two];
  f.client.rpc.send = (method, params) => method === "getcontractstate" && params[0] === "0x" + verifier
    ? {manifest:{extra:{smartAccount:{abiVersion:2,profileDigest:D,compositeVerifier:false,configurationMethods:["setLimit"]}},abi:{methods}}}
    : send(method, params);
  f.add("supportsComposition",[],{type:"Boolean",value:false},verifier);
  f.add("getPendingModuleCall",[c.hashValue(h),c.stringValue("verifier")],N);
  const input = {accountId:h,role:"verifier",method:"setLimit"};
  for (const args of [[I(7)],[I(7),I(8)]]) {
    const plan = await f.client.buildModuleCall({...input,args});
    assert.equal(plan.script,c.dynamicCall(CORE,"callVerifier",[c.hashValue(h),c.stringValue("setLimit"),A(args)]));
  }
  for (const args of [[],[I(7),I(8),I(9)]])
    await assert.rejects(f.client.buildModuleCall({...input,args}),/capability/);
  for (const invalid of [[one,one,two],[{...one,safe:true},two],[{...one,parameters:[{type:"Integer"},{type:"Integer"}]},two]]) {
    methods = invalid;
    await assert.rejects(f.client.buildModuleCall({...input,args:[I(7)]}),/capability/);
  }
});

test("RPC fees accept zero, exact Int64 maximum and absent minimum without inventing admission", () => {
  const {parseNativeRpcFees} = require("../src/native/client");
  for (const value of ["0","10","9223372036854775807"]) {
    assert.deepEqual(parseNativeRpcFees({gasconsumed:value,minimumrequiredfee:value}),{gasConsumed:value,minimumRequiredFee:value});
  }
  assert.deepEqual(parseNativeRpcFees({gasconsumed:"10"}),{gasConsumed:"10",minimumRequiredFee:null});
  assert.throws(()=>parseNativeRpcFees({gasconsumed:"10"},true),/minimumrequiredfee/);
  assert.throws(()=>parseNativeRpcFees({minimumrequiredfee:"10"}),/gasconsumed/);
});
