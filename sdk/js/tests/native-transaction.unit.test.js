const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { nativeCodec: c } = require("../src/native");
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
        verification: "Succeed",
        state: "HALT",
        relayed: false,
        mempoolChecked: false,
        minimumrequiredfee: "100",
        stack: [{ type: "Any" }],
        ...override,
      };
    },
    setResponse: (v) => {
      response = v;
    },
  };
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
          smartAccount: { configurationMethods: ["setConfig"] },
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
