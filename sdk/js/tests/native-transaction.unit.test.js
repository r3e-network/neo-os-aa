const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const {
  NativeSmartAccountClient,
  nativeCodec: c,
  NATIVE_PROFILE_PARAMETER_DIGEST: PROFILE,
  NATIVE_ACCOUNT_SERVICE: CORE,
} = require("../src/native");
const {
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
} = require("../src/native/client");
const { createNativeTransactionTools } = require("../src/native/transaction");
function signer() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }),
    jwk = publicKey.export({ format: "jwk" }),
    x = Buffer.from(jwk.x, "base64url"),
    y = Buffer.from(jwk.y, "base64url"),
    compressed = Buffer.concat([Buffer.from([2 + (y[31] & 1)]), x]);
  const verificationScript = "0c21" + compressed.toString("hex") + "4156e7b327";
  const account = Buffer.from(
    crypto
      .createHash("ripemd160")
      .update(
        crypto
          .createHash("sha256")
          .update(Buffer.from(verificationScript, "hex"))
          .digest(),
      )
      .digest(),
  )
    .reverse()
    .toString("hex");
  return {
    account,
    verificationScript,
    sign: async (hex) =>
      crypto
        .sign("sha256", Buffer.from(hex, "hex"), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        })
        .toString("hex"),
  };
}
function fixture() {
  const tool = createNativeTransactionTools(c),
    payer = signer(),
    custody = signer(),
    accountId = "11".repeat(20),
    target = "22".repeat(20),
    op = {
      targetContract: target,
      method: "ping",
      args: [],
      nonce: 0,
      deadline: 9999999999999,
      signature: "aa",
    };
  const plan = {
    kind: "execution",
    preparedOperations: [{ operation: op }],
    batch: false,
    accountId,
    accountAddress: c.accountAddress(accountId),
    script: c.buildExecutionScript(accountId, [op], {
      authorityEpoch: 0,
      configurationNonce: 0,
    }),
    proxySigner: {
      account: "0x" + c.accountAddress(accountId),
      scopes: "CustomContracts",
      allowedcontracts: ["0x" + target],
    },
    proxyWitness: {
      invocation: "",
      verification: c.verificationScript(accountId),
    },
    requiredAuthorities: [],
  };
  let min = "100",
    network = "50",
    response = true;
  let preflight;
  const calls = [];
  const client = {
    networkMagic: 123,
    profileParameterDigest: PROFILE,
    revalidatePlan: async () => true,
    simulate: async () => ({
      state: "HALT",
      minimumRequiredFee: min,
      gasConsumed: "10",
      stack: plan.batch
        ? [
            {
              type: "Array",
              value: plan.preparedOperations.map(() => ({
                type: "Boolean",
                value: true,
              })),
            },
          ]
        : [{ type: "Boolean", value: true }],
    }),
    rpc: {
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === "getblockcount") return 100;
        if (method === "calculatenetworkfee") return { networkfee: network };
        if (method === "sendrawtransaction") return response;
        if (method === "invoketransaction") return preflight;
      },
    },
  };
  const options = {
    feePayer: payer,
    maxSystemFee: 1000,
    maxNetworkFee: 1000,
    maxTotalFee: 2000,
    nonce: 42,
  };
  return {
    tool,
    payer,
    custody,
    plan,
    client,
    options,
    calls,
    setMin: (v) => {
      min = v;
    },
    setNetwork: (v) => {
      network = v;
    },
    setPreflight: (txid, override = {}) => {
      preflight = {
        hash: txid,
        network: 123,
        snapshot: { height: 100, hash: "0x" + "aa".repeat(32) },
        simulation: {
          mode: "single-transaction-next-block",
          height: 101,
          timestamp: "1700000000000",
          primaryIndex: 0,
          view: 0,
          transactionCount: 1,
          onPersist: "HALT",
          nextConsensus: "0x" + "bb".repeat(20),
        },
        verification: "Succeed",
        state: "HALT",
        relayed: false,
        mempoolChecked: false,
        minimumrequiredfee: "100",
        gasconsumed: "10",
        stack: [{ type: "Any" }],
        ...override,
      };
    },
    setResponse: (v) => {
      response = v;
    },
  };
}
function lifecycleFixture(role = "verifier") {
  const f = fixture(),
    accountId = f.plan.accountId,
    module = "55".repeat(20),
    recovery = "66".repeat(20),
    I = (value) => ({ type: "Integer", value: String(value) }),
    B = (hex) => ({
      type: "ByteString",
      value: Buffer.from(hex, "hex").toString("base64"),
    }),
    H = (hex) => B(Buffer.from(hex, "hex").reverse().toString("hex")),
    A = (value) => ({ type: "Array", value }),
    N = { type: "Any", value: null },
    binding = A([H(module), H("aa".repeat(32))]),
    pendingBinding = A([...binding.value, I(1), I(86400001), I(11)]),
    record = A([
      I(2),
      H(accountId),
      H(c.accountAddress(accountId)),
      H(f.custody.account),
      H(recovery),
      binding,
      binding,
      I(0),
      I(11),
      pendingBinding,
      pendingBinding,
      A([H("77".repeat(20)), I(1), I(86400001), I(11)]),
      N,
      I(7),
    ]),
    pending = A([
      I(1),
      H(accountId),
      I(role === "verifier" ? 0 : 1),
      binding,
      binding,
      B(Buffer.from("setConfig").toString("hex")),
      A([H(accountId), I(1)]),
      I(1),
      I(86400001),
      I(11),
    ]),
    manifest = {
      name: "AccountManagement",
      extra: { smartAccount: { abiVersion: 2, profileParameterDigest: PROFILE } },
      abi: {
        methods: Object.entries(NATIVE_REQUIRED_ABI).map(
          ([name, [types, returntype, safe, names]]) => ({
            name,
            returntype,
            safe,
            parameters: types.map((type, index) => ({
              name: names[index],
              type,
            })),
          }),
        ),
        events: Object.entries(NATIVE_REQUIRED_EVENTS).map(
          ([name, parameters]) => ({ name, parameters }),
        ),
      },
    },
    reads = new Map([
      [c.dynamicCall(CORE, "getVersion", [], 5), I(2)],
      [c.dynamicCall(CORE, "getAccount", [c.hashValue(accountId)], 5), record],
      [
        c.dynamicCall(CORE, "getPendingModuleCall", [
          c.hashValue(accountId),
          c.stringValue(role),
        ], 5),
        pending,
      ],
    ]),
    actions = new Set([
      ...["activateVerifier", "activateHook", "activateRecoveryAddress"].map(
        (action) => c.dynamicCall(CORE, action, [c.hashValue(accountId)]),
      ),
      c.dynamicCall(CORE, "cancelModuleCall", [
        c.hashValue(accountId),
        c.stringValue(role),
      ]),
    ]),
    send = f.client.rpc.send;
  f.client = new NativeSmartAccountClient({
    networkMagic: 123,
    rpcClient: {
      send: async (method, params) => {
        if (!["getversion", "getcontractstate", "invokescript"].includes(method))
          return send(method, params);
        f.calls.push({ method, params });
        if (method === "getversion") return { protocol: { network: 123 } };
        if (method === "getcontractstate")
          return { id: -13, hash: "0x" + CORE, manifest };
        const script = Buffer.from(params[0], "base64").toString("hex");
        if (!reads.has(script) && !actions.has(script))
          throw new Error("unexpected lifecycle RPC script");
        return {
          state: "HALT",
          stack: [reads.get(script) ?? N],
          gasconsumed: "10",
          minimumrequiredfee: "100",
        };
      },
    },
  });
  return {
    ...f,
    accountId,
    pendingCallBytes: c.serializeValue(
      (function canonical(item) {
        return {
          type: item.type,
          value:
            item.type === "Array"
              ? item.value.map(canonical)
              : item.type === "ByteString"
                ? Buffer.from(item.value, "base64").toString("hex")
                : item.value,
        };
      })(pending),
    ),
    allowSimulation: (plan) => actions.add(plan.script),
    replacePending: () => {
      pending.value[6] = A([H(accountId), I(2)]);
    },
  };
}
function guardedCancellationScript(accountId, role, pendingCallBytes) {
  const { sc, u } = require("@cityofzion/neon-js"),
    args = [sc.ContractParam.hash160(accountId), role];
  return new sc.ScriptBuilder()
    .emitContractCall({
      scriptHash: CORE,
      operation: "getPendingModuleCall",
      args,
      callFlags: sc.CallFlags.ReadOnly,
    })
    .emitPush(1)
    .emit(sc.OpCode.PACK)
    .emitPush(sc.CallFlags.None)
    .emitPush("serialize")
    .emitHexString(
      u.HexString.fromHex("acce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"),
    )
    .emitSysCall(sc.InteropServiceCode.SYSTEM_CONTRACT_CALL)
    .emitHexString(pendingCallBytes)
    .emit(sc.OpCode.EQUAL)
    .emit(sc.OpCode.ASSERT)
    .emitContractCall({
      scriptHash: CORE,
      operation: "cancelModuleCall",
      args,
      callFlags: sc.CallFlags.All,
    })
    .str;
}
test("native transaction uses external payer first, exact proxy script, none payer scope and real P256 signed bytes", async () => {
  const f = fixture(),
    p = await f.tool.prepareNativeTransaction(f.client, f.plan, f.options);
  assert.equal(p.transaction.signers[0].account, "0x" + f.payer.account);
  assert.equal(p.transaction.signers[0].scopes, "None");
  assert.equal(p.transaction.signers[1].account, "0x" + f.plan.accountAddress);
  assert.equal(p.systemFee, "100");
  assert.equal(p.networkFee, "50");
  const signed = await f.tool.signNativeTransaction(f.client, p);
  assert.ok(signed.rawTransaction.includes(f.plan.proxyWitness.verification));
  f.setPreflight(signed.txid);
  const r = await f.tool.broadcastNativeTransaction(f.client, signed);
  assert.deepEqual(r, { txid: signed.txid, submitted: true, confirmed: false });
});
for (const action of [
  "activateVerifier",
  "activateHook",
  "activateRecoveryAddress",
]) {
  test(`${action} prepares and signs a lifecycle transaction with only an independent fee payer`, async () => {
    const f = lifecycleFixture(),
      plan = await f.client.buildAction({ accountId: f.accountId, action }),
      expectedScript = c.dynamicCall(CORE, action, [c.hashValue(f.accountId)]),
      expectedSigners = [{ account: "0x" + f.payer.account, scopes: "None" }];
    assert.notEqual(f.payer.account, f.custody.account);
    assert.deepEqual(plan.requiredAuthorities, []);
    assert.equal(plan.script, expectedScript);
    const prepared = await f.tool.prepareNativeTransaction(
        f.client,
        plan,
        f.options,
      ),
      signed = await f.tool.signNativeTransaction(f.client, prepared),
      { tx } = require("@cityofzion/neon-js"),
      decoded = tx.Transaction.deserialize(signed.rawTransaction).toJson();
    assert.deepEqual(prepared.transaction.signers, expectedSigners);
    assert.deepEqual(decoded.signers, expectedSigners);
    assert.equal(
      Buffer.from(decoded.script, "base64").toString("hex"),
      expectedScript,
    );
    assert.equal(decoded.witnesses.length, 1);
    assert.equal(
      Buffer.from(decoded.witnesses[0].verification, "base64").toString("hex"),
      f.payer.verificationScript,
    );
    const simulation = f.calls.find(
      (call) =>
        call.method === "invokescript" &&
        Buffer.from(call.params[0], "base64").toString("hex") === expectedScript,
    );
    assert.deepEqual(simulation.params[1], expectedSigners);
  });
}
test("guarded cancellation preserves the complete reviewed script through signing and transaction imports", async () => {
  for (const role of ["verifier", "hook"]) {
    const f = lifecycleFixture(role),
      plan = await f.client.buildAction({
        accountId: f.accountId,
        action: "cancelModuleCall",
        role,
      }),
      expectedScript = guardedCancellationScript(
        f.accountId,
        role,
        f.pendingCallBytes,
      ),
      methodOnlyScript = c.dynamicCall(CORE, "cancelModuleCall", [
        c.hashValue(f.accountId),
        c.stringValue(role),
      ]);
    assert.equal(plan.script, expectedScript);
    assert.equal(plan.requiresExactScript, true);
    assert.equal(plan.pendingCallBytes, f.pendingCallBytes);
    assert.notEqual(plan.script, methodOnlyScript);
    f.allowSimulation(plan);
    const prepared = await f.tool.prepareNativeTransaction(f.client, plan, {
        ...f.options,
        authoritySigners: [f.custody],
      }),
      signed = await f.tool.signNativeTransaction(f.client, prepared),
      { tx } = require("@cityofzion/neon-js"),
      imported = tx.Transaction.deserialize(signed.rawTransaction),
      jsonImported = tx.Transaction.fromJson(imported.toJson());
    assert.equal(prepared.transaction.script, expectedScript);
    assert.equal(imported.script.toString(), expectedScript);
    assert.equal(imported.serialize(), signed.rawTransaction);
    assert.equal(jsonImported.script.toString(), expectedScript);
    assert.equal(jsonImported.serialize(), signed.rawTransaction);
    const simulation = f.calls.find(
      (call) =>
        call.method === "invokescript" &&
        Buffer.from(call.params[0], "base64").toString("hex") === expectedScript,
    );
    assert.ok(simulation, "simulation must use the complete guarded script");
    for (const quote of f.calls.filter(
      (call) => call.method === "calculatenetworkfee",
    )) {
      const quoted = tx.Transaction.deserialize(
        Buffer.from(quote.params[0], "base64").toString("hex"),
      );
      assert.equal(quoted.script.toString(), expectedScript);
    }
  }
});
test("replacing a pending module cancellation intent rejects signing before any wallet callback", async () => {
  for (const role of ["verifier", "hook"]) {
    const f = lifecycleFixture(role),
      plan = await f.client.buildAction({
        accountId: f.accountId,
        action: "cancelModuleCall",
        role,
      }),
      expectedPending = await f.client.getPendingModuleCall(f.accountId, role),
      signedBy = [],
      observe = (wallet) => ({
        ...wallet,
        sign: async (hex) => {
          signedBy.push(wallet.account);
          return wallet.sign(hex);
        },
      });
    f.allowSimulation(plan);
    const prepared = await f.tool.prepareNativeTransaction(f.client, plan, {
        ...f.options,
        feePayer: observe(f.payer),
        authoritySigners: [observe(f.custody)],
      });
    assert.deepEqual(plan.requiredAuthorities, [f.custody.account]);
    assert.deepEqual(prepared.transaction.signers, [
      { account: "0x" + f.payer.account, scopes: "None" },
      {
        account: "0x" + f.custody.account,
        scopes: "CustomContracts",
        allowedcontracts: ["0x" + CORE],
      },
    ]);
    assert.equal(
      plan.script,
      guardedCancellationScript(f.accountId, role, f.pendingCallBytes),
    );
    assert.deepEqual(signedBy, []);
    f.replacePending();
    assert.deepEqual(await f.client.getAccount(f.accountId), plan.accountState);
    assert.notDeepEqual(
      await f.client.getPendingModuleCall(f.accountId, role),
      expectedPending,
    );
    await assert.rejects(
      () => f.tool.signNativeTransaction(f.client, prepared),
      /module proposal phase changed/,
    );
    assert.deepEqual(signedBy, []);
    assert.equal(plan.role, role);
    assert.deepEqual(plan.pending, expectedPending);
  }
});
test("native witness fallback adds independent custody authority scoped only to native service", async () => {
  const f = fixture();
  f.plan.requiredAuthorities = [f.custody.account];
  await assert.rejects(
    () => f.tool.prepareNativeTransaction(f.client, f.plan, f.options),
    /missing required/,
  );
  const p = await f.tool.prepareNativeTransaction(f.client, f.plan, {
    ...f.options,
    authoritySigners: [f.custody],
  });
  assert.equal(p.transaction.signers.length, 3);
  assert.deepEqual(p.transaction.signers[2].allowedcontracts, [
    "0xd9421d07adf206e9dc4be746a02e8e087fa61741",
  ]);
  await f.tool.signNativeTransaction(f.client, p);
});
test("native wallet methods retain the original receiver for fee payer and authority signing", async () => {
  class StatefulWallet {
    #delegate = signer();
    calls = 0;
    get account() {
      return this.#delegate.account;
    }
    get verificationScript() {
      return this.#delegate.verificationScript;
    }
    async sign(signDataHex) {
      const signature = await this.#delegate.sign(signDataHex);
      this.calls++;
      return signature;
    }
  }
  const f = fixture(),
    payer = new StatefulWallet(),
    custody = new StatefulWallet();
  f.plan.requiredAuthorities = [custody.account];
  const prepared = await f.tool.prepareNativeTransaction(f.client, f.plan, {
    ...f.options,
    feePayer: payer,
    authoritySigners: [custody],
  });
  assert.equal(payer.calls, 0);
  assert.equal(custody.calls, 0);
  const signed = await f.tool.signNativeTransaction(f.client, prepared);
  assert.equal(signed.kind, "signed-native-transaction");
  assert.equal(payer.calls, 1);
  assert.equal(custody.calls, 1);
});
test("signed preflight requires a well-typed single-transaction next-block OnPersist context", async () => {
  const f = fixture();
  const prepared = await f.tool.prepareNativeTransaction(
    f.client,
    f.plan,
    f.options,
  );
  const signed = await f.tool.signNativeTransaction(f.client, prepared);
  f.setPreflight(signed.txid);
  const valid = await f.tool.preflightNativeTransaction(f.client, signed);
  const malformed = [
    undefined,
    null,
    { ...valid.simulation, mode: "ledger-snapshot" },
    { ...valid.simulation, onPersist: "FAULT" },
    { ...valid.simulation, height: 100 },
    { ...valid.simulation, height: "101" },
    { ...valid.simulation, height: 2 ** 32 },
    { ...valid.simulation, view: 1 },
    { ...valid.simulation, view: "0" },
    { ...valid.simulation, transactionCount: 0 },
    { ...valid.simulation, transactionCount: 2 },
    { ...valid.simulation, primaryIndex: -1 },
    { ...valid.simulation, primaryIndex: 256 },
    { ...valid.simulation, primaryIndex: "0" },
    { ...valid.simulation, timestamp: 1700000000000 },
    { ...valid.simulation, timestamp: "01700000000000" },
    { ...valid.simulation, timestamp: "-1" },
    { ...valid.simulation, timestamp: (1n << 64n).toString() },
    { ...valid.simulation, nextConsensus: "bb".repeat(20) },
    { ...valid.simulation, nextConsensus: "0x" + "BB".repeat(20) },
  ];
  for (const simulation of malformed) {
    f.setPreflight(signed.txid, { simulation });
    await assert.rejects(
      () => f.tool.broadcastNativeTransaction(f.client, signed),
      /preflight (simulation|snapshot)/,
    );
  }
  f.setPreflight(signed.txid, {
    snapshot: { ...valid.snapshot, height: "100" },
  });
  await assert.rejects(
    () => f.tool.broadcastNativeTransaction(f.client, signed),
    /preflight snapshot/,
  );
  assert.equal(
    f.calls.filter((call) => call.method === "sendrawtransaction").length,
    0,
  );
  f.setPreflight(signed.txid);
  await f.tool.broadcastNativeTransaction(f.client, signed);
  assert.equal(
    f.calls.filter((call) => call.method === "sendrawtransaction").length,
    1,
  );
});
test("system admission field is required for automatic estimates; explicit budgets/caps remain distinct", async () => {
  const f = fixture();
  f.setMin(null);
  await assert.rejects(
    () => f.tool.prepareNativeTransaction(f.client, f.plan, f.options),
    /minimumrequiredfee/,
  );
  const p = await f.tool.prepareNativeTransaction(f.client, f.plan, {
    ...f.options,
    systemFee: 500,
  });
  assert.equal(p.systemFeeSource, "explicit-budget");
  f.setMin("100");
  await assert.rejects(
    () =>
      f.tool.prepareNativeTransaction(f.client, f.plan, {
        ...f.options,
        systemFee: 99,
      }),
    /admission/,
  );
  await assert.rejects(
    () =>
      f.tool.prepareNativeTransaction(f.client, f.plan, {
        ...f.options,
        maxTotalFee: 149,
      }),
    /caps/,
  );
});
test("wrong payer script, invalid signature, fee drift and counterfeit prepared transactions refuse", async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.tool.prepareNativeTransaction(f.client, f.plan, {
        ...f.options,
        feePayer: { ...f.payer, account: "00".repeat(20) },
      }),
    /does not match/,
  );
  const p = await f.tool.prepareNativeTransaction(f.client, f.plan, {
    ...f.options,
    feePayer: { ...f.payer, sign: async () => "00".repeat(64) },
  });
  await assert.rejects(
    () => f.tool.signNativeTransaction(f.client, p),
    /invalid transaction signature/,
  );
  const good = await f.tool.prepareNativeTransaction(
    f.client,
    f.plan,
    f.options,
  );
  f.setNetwork("51");
  await assert.rejects(
    () => f.tool.signNativeTransaction(f.client, good),
    /exceeds approved/,
  );
  await assert.rejects(
    () => f.tool.signNativeTransaction(f.client, { ...good }),
    /must be prepared/,
  );
});
test("read-only transaction submission result never claims confirmation and txid substitution refuses", async () => {
  const f = fixture(),
    p = await f.tool.prepareNativeTransaction(f.client, f.plan, f.options),
    signed = await f.tool.signNativeTransaction(f.client, p);
  f.setPreflight(signed.txid);
  f.setResponse({ hash: "0x" + "ff".repeat(32) });
  await assert.rejects(
    () => f.tool.broadcastNativeTransaction(f.client, signed),
    /different transaction/,
  );
});

test("broadcast requires exact signed-transaction verification and Application preflight", async () => {
  for (const override of [
    { network: 124 },
    { hash: "0x" + "ee".repeat(32) },
    { verification: "InvalidSignature" },
    { state: "FAULT" },
    { relayed: true },
    { mempoolChecked: true },
    { minimumrequiredfee: "101" },
    { snapshot: { height: -1, hash: "0x" + "aa".repeat(32) } },
  ]) {
    const f = fixture(),
      prepared = await f.tool.prepareNativeTransaction(
        f.client,
        f.plan,
        f.options,
      ),
      signed = await f.tool.signNativeTransaction(f.client, prepared);
    f.setPreflight(signed.txid, override);
    await assert.rejects(() =>
      f.tool.broadcastNativeTransaction(f.client, signed),
    );
    assert.equal(
      f.calls.filter((x) => x.method === "sendrawtransaction").length,
      0,
    );
  }
  const f = fixture(),
    prepared = await f.tool.prepareNativeTransaction(
      f.client,
      f.plan,
      f.options,
    ),
    signed = await f.tool.signNativeTransaction(f.client, prepared);
  await assert.rejects(
    () => f.tool.broadcastNativeTransaction(f.client, signed),
    /preflight/,
  );
  assert.equal(
    signed.rawTransaction.length > 0,
    true,
    "raw remains exportable when preflight is unavailable",
  );
});

function verifierFixture(multi = false) {
  const f = fixture(),
    { sc } = require("@cityofzion/neon-js"),
    { codeIdentityTools } = require("../src/native/moduleIdentity"),
    { moduleCodeHash } = codeIdentityTools(c);
  const root = "45".repeat(20),
    child = "46".repeat(20),
    other = "47".repeat(20);
  function module(hash, name) {
    const nef = new sc.NEF({
        compiler: "independent test serializer",
        script: "1040",
      }),
      json = nef.toJson();
    json.script = Buffer.from(json.script, "hex").toString("base64");
    return {
      id: 4,
      hash: "0x" + hash,
      nef: json,
      manifest: {
        name,
        groups: [],
        features: {},
        supportedstandards: [],
        abi: { methods: [], events: [] },
        permissions: [],
        trusts: [],
        extra: {
          SmartAccountProfile: "native-v2",
          smartAccount: {
            abiVersion: 2,
            profileDigest: PROFILE,
            compositeVerifier: name === "MultiSigVerifier",
            configurationMethods: ["setConfig"],
          },
        },
      },
    };
  }
  const contracts = new Map([
    [root, module(root, multi ? "MultiSigVerifier" : "NeoNativeVerifier")],
    ...(multi
      ? [
          [child, module(child, "NeoNativeVerifier")],
          [other, module(other, "SessionKeyVerifier")],
        ]
      : []),
  ]);
  const pins = [...contracts].map(([contract, value]) => ({
    contract,
    codeHash: moduleCodeHash(value),
  }));
  let registry = {
      root: pins[0],
      cleanupBindings: multi ? pins.slice(1) : [],
      activeChildren: multi ? [child, other] : [],
    },
    configured = [f.payer.account];
  f.plan.preparedOperations[0].account = { verifier: pins[0] };
  f.client.getModuleDependencies = async () => structuredClone(registry);
  const send = f.client.rpc.send;
  f.client.rpc.send = async (method, params) =>
    method === "getcontractstate"
      ? contracts.get(params[0].slice(2))
      : send(method, params);
  f.client._read = async (method, args, hash) => {
    if (method === "supportsComposition") return multi && hash === root;
    if (method === "getConfig")
      return {
        type: "Struct",
        value: [
          {
            type: "Array",
            value: configured.map((h) =>
              Uint8Array.from(Buffer.from(h, "hex").reverse()),
            ),
          },
          1n,
        ],
      };
    throw new Error("unknown module read");
  };
  return {
    ...f,
    root,
    child,
    other,
    contracts,
    setRegistry: (v) => {
      registry = v;
    },
    registry: () => structuredClone(registry),
    setConfigured: (v) => {
      configured = v;
    },
  };
}
test("explicit native verifier witnesses get exact chain-pinned module scopes, including a payer in both roles", async () => {
  for (const multi of [false, true]) {
    const f = verifierFixture(multi),
      p = await f.tool.prepareNativeTransaction(f.client, f.plan, {
        ...f.options,
        verifierSigners: [f.payer],
      });
    assert.equal(p.transaction.signers.length, 2);
    assert.deepEqual(p.transaction.signers[0].allowedcontracts, [
      "0x" + (multi ? f.child : f.root),
    ]);
    assert.equal(p.transaction.signers[0].scopes, "CustomContracts");
    assert.deepEqual(
      p.transaction.signers[1].allowedcontracts,
      f.plan.proxySigner.allowedcontracts,
    );
    await f.tool.signNativeTransaction(f.client, p);
  }
});
test("native verifier signer configuration, malformed roster and deployed code drift refuse", async () => {
  const f = verifierFixture(true);
  await assert.rejects(
    () =>
      f.tool.prepareNativeTransaction(f.client, f.plan, {
        ...f.options,
        verifierSigners: [f.custody],
      }),
    /not configured/,
  );
  const p = await f.tool.prepareNativeTransaction(f.client, f.plan, {
    ...f.options,
    verifierSigners: [f.payer],
  });
  f.setConfigured([f.custody.account]);
  await assert.rejects(
    () => f.tool.signNativeTransaction(f.client, p),
    /not configured|changed/,
  );
  const g = verifierFixture(true),
    prepared = await g.tool.prepareNativeTransaction(g.client, g.plan, {
      ...g.options,
      verifierSigners: [g.payer],
    });
  g.contracts.get(g.child).manifest.extra.changed = true;
  await assert.rejects(
    () => g.tool.signNativeTransaction(g.client, prepared),
    /pinned identity/,
  );
  for (const mutation of [
    (r) => r.cleanupBindings.push(null),
    (r) => r.activeChildren.push(r.activeChildren[0]),
    (r) => r.activeChildren.push("99".repeat(20)),
  ]) {
    const h = verifierFixture(true),
      r = h.registry();
    mutation(r);
    h.setRegistry(r);
    await assert.rejects(
      () =>
        h.tool.prepareNativeTransaction(h.client, h.plan, {
          ...h.options,
          verifierSigners: [h.payer],
        }),
      /malformed/,
    );
  }
});
test("native module identity reconstructs independent NEF bytes and uses JCS manifest semantics", () => {
  const { sc } = require("@cityofzion/neon-js"),
    { codeIdentityTools } = require("../src/native/moduleIdentity"),
    tool = codeIdentityTools(c),
    nef = new sc.NEF({
      compiler: "independent NEF",
      source: "https://example.invalid/a",
      script: "1040",
    }),
    json = nef.toJson();
  json.script = Buffer.from(json.script, "hex").toString("base64");
  assert.equal(tool.serializeNef(json).toString("hex"), nef.serialize());
  assert.equal(
    tool.canonicalJson({ z: -0, a: 1e-7, n: 1e21, x: "é" }),
    "{" + '"a":1e-7,"n":1e+21,"x":"é","z":0}',
  );
  assert.throws(() => tool.canonicalJson({ x: "\ud800" }));
  assert.throws(() => tool.serializeNef({ ...json, checksum: 0 }), /checksum/);
});
test("explicit fee metadata remains explicit even when node also reports admission minimum", async () => {
  const f = fixture(),
    p = await f.tool.prepareNativeTransaction(f.client, f.plan, {
      ...f.options,
      systemFee: 500,
    });
  assert.equal(p.systemFeeSource, "explicit-budget");
});
test("concurrent exact-byte broadcast shares one submission; preflight failures can recover without re-signing", async () => {
  const f = fixture(),
    p = await f.tool.prepareNativeTransaction(f.client, f.plan, f.options),
    signed = await f.tool.signNativeTransaction(f.client, p);
  await assert.rejects(
    () => f.tool.broadcastNativeTransaction(f.client, signed),
    /preflight/,
  );
  f.setPreflight(signed.txid);
  const result = await Promise.all([
    f.tool.broadcastNativeTransaction(f.client, signed),
    f.tool.broadcastNativeTransaction(f.client, signed),
  ]);
  assert.deepEqual(result[0], result[1]);
  assert.equal(
    f.calls.filter((x) => x.method === "sendrawtransaction").length,
    1,
  );
});

test("signed preflight rejects absent/malformed results and non-true transfer outcomes before submission", async () => {
  for (const batch of [false, true]) {
    const f = fixture();
    f.plan.preparedOperations[0].operation.method = "transfer";
    f.plan.batch = batch;
    if (batch)
      f.plan.preparedOperations.push({
        operation: {
          ...f.plan.preparedOperations[0].operation,
          method: "ping",
          nonce: 1,
        },
      });
    f.plan.script = c.buildExecutionScript(
      f.plan.accountId,
      f.plan.preparedOperations.map((p) => p.operation),
      { authorityEpoch: 0, configurationNonce: 0 },
      batch,
    );
    const prepared = await f.tool.prepareNativeTransaction(
      f.client,
      f.plan,
      f.options,
    );
    const signed = await f.tool.signNativeTransaction(f.client, prepared);
    const trueItem = { type: "Boolean", value: true },
      falseItem = { type: "Boolean", value: false };
    const stacks = [
      undefined,
      null,
      {},
      [],
      [trueItem, trueItem],
      [{ type: "Boolean", value: "true" }],
    ];
    const transferFailures = [
      falseItem,
      { type: "Integer", value: "1" },
      { type: "Any" },
    ];
    stacks.push(
      ...transferFailures.map((item) =>
        batch ? [{ type: "Array", value: [item, falseItem] }] : [item],
      ),
    );
    if (batch)
      stacks.push(
        [trueItem],
        [{ type: "Struct", value: [trueItem, falseItem] }],
        [{ type: "Array", value: [trueItem] }],
      );
    for (const stack of stacks) {
      f.setPreflight(signed.txid, { stack });
      await assert.rejects(
        () => f.tool.broadcastNativeTransaction(f.client, signed),
        /stack|result|transfer/i,
      );
    }
    assert.equal(
      f.calls.filter((c) => c.method === "sendrawtransaction").length,
      0,
    );
    f.setPreflight(signed.txid, {
      stack: batch
        ? [{ type: "Array", value: [trueItem, falseItem] }]
        : [trueItem],
    });
    assert.equal(
      (await f.tool.broadcastNativeTransaction(f.client, signed)).submitted,
      true,
    );
  }
});

test("signed preflight retains the RPC rejection cause, code, data and immutable transaction identity", async () => {
  const f = fixture();
  const prepared = await f.tool.prepareNativeTransaction(
    f.client,
    f.plan,
    f.options,
  );
  const signed = await f.tool.signNativeTransaction(f.client, prepared);
  const cause = Object.assign(new Error("Method not found"), {
    code: -32601,
    data: { method: "invoketransaction" },
  });
  const send = f.client.rpc.send;
  f.client.rpc.send = (method, params) => {
    if (method === "invoketransaction") throw cause;
    return send(method, params);
  };
  await assert.rejects(
    () => f.tool.broadcastNativeTransaction(f.client, signed),
    (error) => {
      assert.match(error.message, /preflight unavailable/);
      assert.equal(error.cause, cause);
      assert.equal(error.code, cause.code);
      assert.deepEqual(error.data, cause.data);
      assert.equal(error.txid, signed.txid);
      assert.equal(error.submissionAttempted, false);
      return true;
    },
  );
});
test("malformed simulation and non-true transfer results cannot reach transaction signing", async () => {
  for (const stack of [
    undefined,
    [],
    [{ type: "Boolean", value: "true" }],
    [{ type: "Integer", value: "1" }],
    [{ type: "Boolean", value: false }],
  ]) {
    const f = fixture();
    f.plan.preparedOperations[0].operation.method = "transfer";
    f.client.simulate = async () => ({
      state: "HALT",
      minimumRequiredFee: "100",
      stack,
    });
    let signatures = 0;
    f.payer.sign = () => {
      signatures++;
      throw new Error("must not sign");
    };
    await assert.rejects(async () => {
      const prepared = await f.tool.prepareNativeTransaction(
        f.client,
        f.plan,
        f.options,
      );
      await f.tool.signNativeTransaction(f.client, prepared);
    }, /stack|result|transfer/i);
    assert.equal(signatures, 0);
  }
});

test("verifier admission refuses even code-pinned modules with mismatched profile or composition metadata", async () => {
  const { moduleCodeHash } =
    require("../src/native/moduleIdentity").codeIdentityTools(c);
  for (const change of [
    (m) => delete m.abiVersion,
    (m) => (m.abiVersion = 1),
    (m) => (m.abiVersion = "2"),
    (m) => delete m.profileDigest,
    (m) => (m.profileDigest = "00".repeat(32)),
    (m) => delete m.compositeVerifier,
    (m) => (m.compositeVerifier = "false"),
    (m) => (m.compositeVerifier = true),
  ]) {
    const f = verifierFixture();
    const module = f.contracts.get(f.root);
    change(module.manifest.extra.smartAccount);
    const pin = { contract: f.root, codeHash: moduleCodeHash(module) };
    f.plan.preparedOperations[0].account.verifier = pin;
    f.setRegistry({ root: pin, cleanupBindings: [], activeChildren: [] });
    await assert.rejects(
      () =>
        f.tool.prepareNativeTransaction(f.client, f.plan, {
          ...f.options,
          verifierSigners: [f.payer],
        }),
      /profile|composition/i,
    );
  }
});

test("invalid simulation fee responses cannot reach a signing callback", async () => {
  for (const minimum of ["9", 100, "01", "-1", "1.5", "9223372036854775808"]) {
    const f = fixture(); f.setMin(minimum); let signatures = 0;
    f.payer.sign = () => { signatures++; throw Error("must not sign"); };
    await assert.rejects(async () => {
      const tx = await f.tool.prepareNativeTransaction(f.client,f.plan,f.options);
      await f.tool.signNativeTransaction(f.client,tx);
    }, /fee/);
    assert.equal(signatures,0);
  }
  const f = fixture(); f.setMin(null);
  await assert.rejects(f.tool.prepareNativeTransaction(f.client,f.plan,{...f.options,systemFee:"9"}),/consum|fee/);
});

function cancellationFixture(now = 1000) {
  const f = fixture(), send = f.client.rpc.send;
  f.plan = {kind:"lifecycle",method:"cancelRecovery",accountId:"11".repeat(20),
    script:c.dynamicCall(CORE,"cancelRecovery",[c.hashValue("11".repeat(20))]),requiredAuthorities:[],
    authorityPolicy:"recovery-or-custody-before-maturity",accountState:{custodyAddress:f.custody.account,recoveryAddress:f.payer.account,pendingRecovery:{matureAt:"2000"}}};
  let time = now;
  f.client.rpc.send = (method, params) => method === "getblockheader" ? {time} : send(method,params);
  f.setTime = value => {time=value;};
  return f;
}
test("explicit recovery cancellation keeps payer and authority roles separate", async () => {
  for (const selected of ["custody", "recovery"]) {
    const f = cancellationFixture(), authority = selected === "custody" ? f.custody : f.payer;
    const payer = selected === "custody" ? f.payer : f.custody;
    const tx = await f.tool.prepareNativeTransaction(f.client,f.plan,{...f.options,feePayer:payer,authoritySigners:[authority],cancellationAuthority:authority.account});
    assert.deepEqual(tx.transaction.signers,[{account:"0x"+payer.account,scopes:"None"},{account:"0x"+authority.account,scopes:"CustomContracts",allowedcontracts:["0x"+CORE]}]);
    assert.equal((await f.tool.signNativeTransaction(f.client,tx)).witnesses.length,2);
  }
  const f = cancellationFixture(2000);
  const tx = await f.tool.prepareNativeTransaction(f.client,f.plan,{...f.options,cancellationAuthority:f.payer.account});
  assert.equal(tx.transaction.signers.length,1);
  assert.equal(tx.transaction.signers[0].scopes,"CustomContracts");
});
test("custody cancellation refuses at maturity and rechecks the chain before signatures", async () => {
  for (const time of [2000,2001]) {
    const f = cancellationFixture(time);
    await assert.rejects(f.tool.prepareNativeTransaction(f.client,f.plan,{...f.options,authoritySigners:[f.custody],cancellationAuthority:f.custody.account}),/matur/);
  }
  const f = cancellationFixture(); let signed = 0;
  f.payer.sign = () => {signed++; throw Error("must not sign");};
  const tx = await f.tool.prepareNativeTransaction(f.client,f.plan,{...f.options,authoritySigners:[f.custody],cancellationAuthority:f.custody.account});
  f.setTime(2000);
  await assert.rejects(f.tool.signNativeTransaction(f.client,tx),/matur/);
  assert.equal(signed,0);
});
test("explicit cancellation requires the selected real authority and correct action", async () => {
  const f = cancellationFixture();
  for (const cancellationAuthority of ["77".repeat(20),"00".repeat(20)])
    await assert.rejects(f.tool.prepareNativeTransaction(f.client,f.plan,{...f.options,cancellationAuthority}),/authority/);
  await assert.rejects(f.tool.prepareNativeTransaction(f.client,f.plan,{...f.options,cancellationAuthority:f.custody.account}),/signer/);
  const unrelated = fixture();
  await assert.rejects(unrelated.tool.prepareNativeTransaction(unrelated.client,unrelated.plan,{...unrelated.options,cancellationAuthority:unrelated.payer.account}),/cancelRecovery/);
});

test("network fee RPC fields use exact strings during preparation and after signatures", async () => {
  for (const invalid of [50,null,"01","-1","0.5","9223372036854775808"]) {
    const f = fixture(); f.setNetwork(invalid);
    await assert.rejects(f.tool.prepareNativeTransaction(f.client,f.plan,f.options),/network.*fee/);
    f.setNetwork("50");
    const tx = await f.tool.prepareNativeTransaction(f.client,f.plan,f.options);
    f.setNetwork(invalid);
    await assert.rejects(f.tool.signNativeTransaction(f.client,tx),/network.*fee/);
  }
});

test("custody cancellation rejects maturity reached during signing before final fees or submission", async () => {
  const f = cancellationFixture(1999), sign = f.custody.sign;
  f.custody.sign = async (bytes) => { const signature = await sign(bytes); f.setTime(2000); return signature; };
  const prepared = await f.tool.prepareNativeTransaction(f.client,f.plan,{...f.options,authoritySigners:[f.custody],cancellationAuthority:f.custody.account});
  await assert.rejects(f.tool.signNativeTransaction(f.client,prepared),/matur/);
  assert.equal(f.calls.filter(call=>call.method === "calculatenetworkfee").length,1);
  assert.equal(f.calls.some(call=>call.method === "sendrawtransaction"),false);
});
