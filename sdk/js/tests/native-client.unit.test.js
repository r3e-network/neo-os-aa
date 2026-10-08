const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NativeSmartAccountClient,
  nativeCodec: c,
  NATIVE_PROFILE_PARAMETER_DIGEST: D,
  NATIVE_ACCOUNT_SERVICE: CORE,
} = require("../src/native");
const { NATIVE_REQUIRED_ABI } = require("../src/native/client");
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
        ([name, [params, returntype, safe]]) => ({
          name,
          parameters: params.map((type) => ({ type })),
          returntype,
          safe,
        }),
      ),
    },
  };
  const response = new Map();
  const add = (method, args, value) =>
    response.set(c.dynamicCall(CORE, method, args, 5), value);
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
            extra: { smartAccount: { configurationMethods: ["setLimit"] } },
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
      result = { state: "HALT", stack, minimumrequiredfee: "100" };
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
