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
  buildSessionArguments,
  buildMultiSigArguments,
  NATIVE_MULTISIG_LIMITS,
  nativeWalletNetwork,
  createNativeRpc,
  NATIVE_PROFILE_PARAMETER_DIGEST,
  NATIVE_ACCOUNT_SERVICE,
} from "../src/features/native/nativeWorkspace.js";

const custody = "11".repeat(20),
  recovery = "22".repeat(20),
  salt = "33".repeat(32);
const profile = {
  networkMagic: 123,
  abiVersion: 2,
  profileParameterDigest: NATIVE_PROFILE_PARAMETER_DIGEST,
  service: NATIVE_ACCOUNT_SERVICE,
};
const identity = () =>
  nativeCodec.deriveIdentity({
    networkMagic: 123,
    custodyAddress: custody,
    salt,
  });
function fixture(options = {}) {
  let changed = false,
    called = 0;
  const state = {
    ...identity(),
    custodyAddress: custody,
    recoveryAddress: recovery,
    status: "Active",
    authorityEpoch: "0",
    configurationNonce: "0",
    verifier: null,
    hook: null,
  };
  const client = {
    profile,
    rpc: { send: async () => ({}) },
    discover: async () => profile,
    getAccount: async () => state,
    getNonce: async () => 0n,
    buildRegistration: (input) => ({
      kind: "registration",
      ...identity(),
      method: "registerAccount",
      requiredAuthorities: [input.custodyAddress],
      script: nativeCodec.dynamicCall(
        NATIVE_ACCOUNT_SERVICE,
        "registerAccount",
        [
          nativeCodec.hashValue(input.custodyAddress),
          { type: "ByteString", value: input.salt },
          nativeCodec.hashValue("00".repeat(20)),
          nativeCodec.hashValue("00".repeat(20)),
          nativeCodec.hashValue(input.recoveryAddress),
        ],
      ),
    }),
    revalidatePlan: async () => {
      if (changed) throw Error("changed");
    },
    simulate: async () => ({
      state: "HALT",
      gasConsumed: "10",
      failedTransfers: [],
    }),
  };
  const wallet = {
    account: async () => custody,
    network: async () => 123,
    invoke: async (request) => {
      called++;
      return { txid: "aa".repeat(32), request };
    },
  };
  const workspace = createNativeWorkspace({ makeClient: () => client, wallet, ...options });
  return {
    workspace,
    client,
    wallet,
    state,
    called: () => called,
    change: () => (changed = true),
  };
}
test("recovery descriptor is public, roundtrips and rejects identity or network substitution", () => {
  const descriptor = buildRecoveryDescriptor({
    ...profile,
    ...identity(),
    custodyAddress: custody,
    salt,
  });
  assert.equal(
    readRecoveryDescriptor(JSON.stringify(descriptor), profile).accountId,
    identity().accountId,
  );
  for (const patch of [
    { accountId: "44".repeat(20) },
    { networkMagic: 456 },
    { profileParameterDigest: "00".repeat(32) },
    { salt: "ff" },
  ])
    assert.throws(() =>
      readRecoveryDescriptor(
        JSON.stringify({ ...descriptor, ...patch }),
        profile,
      ),
    );
  assert.equal(JSON.stringify(descriptor).includes("private"), false);
  assert.throws(() => readRecoveryDescriptor("x".repeat(20000), profile));
});
test("addresses require Neo hashes or checked Neo address, no malformed/zero custody", () => {
  assert.equal(nativeAddress("0x" + custody), custody);
  assert.throws(() => nativeAddress("0x123"));
  assert.throws(() => nativeAddress("00".repeat(20)));
});
test("session builder requires finite future expiry, explicit cap, specific transfer target, excludes account id", () => {
  const args = buildSessionArguments(
    {
      publicKey: "02" + "11".repeat(32),
      target: recovery,
      expiresAt: "172801000",
      spendingLimit: "1",
      description: "session",
    },
    1000,
  );
  assert.equal(args.length, 6);
  assert.equal(args[2].value, nativeCodec.stringValue("transfer").value);
  for (const patch of [
    { expiresAt: "999" },
    { spendingLimit: "0" },
    { spendingLimit: "-1" },
    { publicKey: "abcd" },
    { target: "00".repeat(20) },
  ])
    assert.throws(() =>
      buildSessionArguments(
        {
          publicKey: "02" + "11".repeat(32),
          target: recovery,
          expiresAt: "172801000",
          spendingLimit: "1",
          ...patch,
        },
        1000,
      ),
    );
});
test("native multisig limits track native source markers and the pinned profile", () => {
  const source = readFileSync(new URL("../../contracts/verifiers/MultiSigVerifier.cs", import.meta.url), "utf8");
  const nativeCaps = /#if SMARTACCOUNT_NATIVE\s+private const int MaxChildVerifiers = (\d+);\s+private const int MaxApprovedChildren = (\d+);/.exec(source);
  assert.ok(nativeCaps, "native compile-time cap markers must remain explicit");
  const profile = JSON.parse(readFileSync(new URL("../../docs/proposals/smartaccount-native-profile-v2-parameters.json", import.meta.url), "utf8"));
  assert.equal(NATIVE_MULTISIG_LIMITS.maxChildren, Number(nativeCaps[1]));
  assert.equal(NATIVE_MULTISIG_LIMITS.maxThreshold, Number(nativeCaps[2]));
  assert.equal(NATIVE_MULTISIG_LIMITS.maxChildren, profile.compositeVerifierMaxChildren);
  assert.equal(NATIVE_MULTISIG_LIMITS.maxThreshold, profile.compositeVerifierMaxThreshold);
});
test("native multisig preserves child order and accepts 1-of-1 through 2-of-3", () => {
  const children = ["44".repeat(20), "55".repeat(20), "66".repeat(20)];
  for (const [count, threshold] of [[1, 1], [2, 1], [2, 2], [3, 1], [3, 2]]) {
    assert.deepEqual(buildMultiSigArguments({ children: children.slice(0, count).join("\n"), threshold: String(threshold) }), [
      { type: "Array", value: children.slice(0, count).map(nativeCodec.hashValue) },
      { type: "Integer", value: String(threshold) },
    ]);
  }
});
test("native multisig rejects oversized, duplicate and unreachable policies before RPC", () => {
  const hashes = ["44".repeat(20), "55".repeat(20), "66".repeat(20), "77".repeat(20)];
  for (const [children, threshold] of [["", "1"], [hashes.join(" "), "2"], [hashes.slice(0, 3).join(" "), "3"],
    [hashes[0], "2"], [hashes[0], "0"], [hashes[0], "1.5"], [hashes[0], "NaN"],
    [[hashes[0], "0x" + hashes[0]].join(" "), "1"], ["00".repeat(20), "1"], [null, "1"]]) {
    assert.throws(() => buildMultiSigArguments({ children, threshold }));
  }
});
test("wallet active network cannot be inferred from supported list", () => {
  assert.equal(nativeWalletNetwork({ magic: 123 }), 123);
  assert.equal(nativeWalletNetwork({ defaultNetwork: "TestNet" }), 894710606);
  assert.throws(() => nativeWalletNetwork({ networks: [123] }));
});
test("discovery must complete before review and switching endpoint discards every previous review", async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.workspace.registration({
        custodyAddress: custody,
        salt,
        recoveryAddress: recovery,
      }),
    /discover/i,
  );
  await f.workspace.connect({
    rpcUrl: "http://localhost:1234",
    networkMagic: 123,
  });
  const review = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  f.workspace.invalidate();
  await assert.rejects(() => f.workspace.submit(review), /stale|discover/i);
  assert.equal(f.called(), 0);
});
test("manual wallet handoff checks current network/actor/state and uses bounded scope", async () => {
  const f = fixture();
  await f.workspace.connect({
    rpcUrl: "http://localhost:1234",
    networkMagic: 123,
  });
  const review = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  f.wallet.network = async () => 456;
  await assert.rejects(() => f.workspace.submit(review), /network/i);
  assert.equal(f.called(), 0);
  f.wallet.network = async () => 123;
  f.wallet.account = async () => recovery;
  await assert.rejects(() => f.workspace.submit(review), /authority|actor/i);
  f.wallet.account = async () => custody;
  const result = await f.workspace.submit(review);
  assert.equal(result.request.operation, "registerAccount");
  assert.equal(result.request.signers[0].scopes, "CalledByEntry");
  assert.equal(result.request.signers[0].account, "0x" + custody);
  assert.equal(result.request.args.length, 5);
  const fresh = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  f.change();
  await assert.rejects(() => f.workspace.submit(fresh), /changed/);
  assert.equal(f.called(), 1);
});
test("unsuccessful simulation never reaches wallet", async () => {
  const f = fixture();
  f.client.simulate = async () => ({
    state: "FAULT",
    exception: "denied",
    failedTransfers: [],
  });
  await f.workspace.connect({
    rpcUrl: "http://localhost:1234",
    networkMagic: 123,
  });
  const review = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  await assert.rejects(() => f.workspace.submit(review), /simulation/i);
  assert.equal(f.called(), 0);
});
test("in-flight old endpoint discovery cannot replace newer connection", async () => {
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  let id = 0;
  const w = createNativeWorkspace({
    makeClient: () => ({
      discover: () =>
        ++id === 1 ? slow : Promise.resolve({ ...profile, networkMagic: 456 }),
    }),
  });
  const old = w.connect({ rpcUrl: "http://localhost:1234", networkMagic: 123 });
  await w.connect({ rpcUrl: "http://localhost:4567", networkMagic: 456 });
  release(profile);
  await assert.rejects(() => old, /stale/i);
  assert.equal(w.profile.networkMagic, 456);
});
test("RPC rejects embedded credentials and never logs remote error payloads", async () => {
  assert.throws(
    () => createNativeRpc("https://user:secret@example.com"),
    /credentials/i,
  );
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

test("editing inputs during simulation prevents a stale review from reappearing", async () => {
  const f = fixture();
  let release;
  f.client.simulate = () => new Promise((resolve) => (release = resolve));
  await f.workspace.connect({
    rpcUrl: "http://localhost:1234",
    networkMagic: 123,
  });
  const pending = f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  f.workspace.clearReview();
  release({ state: "HALT", failedTransfers: [] });
  await assert.rejects(() => pending, /inputs changed/);
  assert.equal(f.workspace.review, null);
});

const { createNativeRpcFixture, nativeTestIdentity } =
  await import("./fixtures/nativeRpcFixture.js");
const { createNativeClientClass } =
  await import("../src/shared/nativeSmartAccountClient.mjs");
test("actual browser client rejects absent native service, ABI1, wrong digest, native id and malformed account", async () => {
  const Client = createNativeClientClass(nativeCodec);
  for (const change of [
    (f) => (f.state.abiVersion = 1),
    (f) => (f.state.digest = "00".repeat(32)),
    (f) => (f.state.magic = 456),
    (f) => (f.state.nativeId = 1),
  ]) {
    const f = createNativeRpcFixture();
    change(f);
    const w = createNativeWorkspace({
      makeClient: () => new Client({ rpcClient: f, networkMagic: 123 }),
    });
    await assert.rejects(() => w.connect({}));
    assert.equal(w.profile, null);
  }
  const f = createNativeRpcFixture();
  f.state.registered = true;
  f.state.malformed = true;
  const w = createNativeWorkspace({
    makeClient: () => new Client({ rpcClient: f, networkMagic: 123 }),
  });
  await w.connect({});
  await assert.rejects(() => w.load(nativeTestIdentity.accountId), /identity/);
});
test("browser workspace discovery rejects incomplete methods and malformed event descriptors", async () => {
  const Client = createNativeClientClass(nativeCodec);
  for (const change of [
    (abi) =>
      (abi.methods = abi.methods.filter(
        (method) => method.name !== "setVerifierDependencies",
      )),
    (abi) => delete abi.events,
    (abi) => {
      const event = abi.events.find(
        (event) => event.name === "RecoveryExecuted",
      );
      [event.parameters[3], event.parameters[4]] = [
        event.parameters[4],
        event.parameters[3],
      ];
    },
  ]) {
    const f = createNativeRpcFixture();
    const send = f.send;
    f.send = async (method, params) => {
      const response = await send(method, params);
      if (method === "getcontractstate") change(response.manifest.abi);
      return response;
    };
    const workspace = createNativeWorkspace({
      makeClient: () => new Client({ rpcClient: f, networkMagic: 123 }),
    });
    await assert.rejects(() => workspace.connect({}), /native ABI/);
    assert.equal(workspace.profile, null);
    assert.equal(
      f.state.calls.some((call) => call.method === "invokescript"),
      false,
    );
  }
});
test("canonical native codecs are shipped byte-identically in the standalone frontend", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  for (const name of ["nativeSmartAccount.mjs", "nativeSmartAccountClient.mjs", "nativeTransactionArtifact.mjs", "nativeWalletWitness.mjs"])
    assert.equal(
      hash(await readFile(new URL("../src/shared/" + name, import.meta.url))),
      hash(await readFile(new URL("../../shared/" + name, import.meta.url))),
      name + " must match canonical shared source",
    );
});
test("export contains a rebuildable SDK recipe and immutable exact script comparison target", async () => {
  const f = fixture();
  await f.workspace.connect({
    rpcUrl: "http://localhost:1234",
    networkMagic: 123,
  });
  const review = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  const exported = await f.workspace.exportReview(review);
  assert.equal(exported.recipe.method, "buildRegistration");
  assert.equal(
    f.client.buildRegistration(exported.recipe.input).script,
    exported.plan.script,
  );
  f.workspace.clearReview();
  await assert.rejects(() => f.workspace.exportReview(review), /stale/);
});
test("editing a review while submission awaits the node never opens the wallet", async () => {
  const f = fixture();
  await f.workspace.connect({
    rpcUrl: "http://localhost:1234",
    networkMagic: 123,
  });
  const review = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  let release;
  f.client.revalidatePlan = () => new Promise((resolve) => (release = resolve));
  const result = f.workspace.submit(review);
  f.workspace.clearReview();
  release(true);
  await assert.rejects(() => result, /inputs changed/);
  assert.equal(f.called(), 0);
});
test("late wallet response is not shown as current after a network switch", async () => {
  const f = fixture();
  await f.workspace.connect({
    rpcUrl: "http://localhost:1234",
    networkMagic: 123,
  });
  const review = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  let signal, release;
  const opened = new Promise((resolve) => (signal = resolve));
  f.wallet.invoke = () => {
    signal();
    return new Promise((resolve) => (release = resolve));
  };
  const result = f.workspace.submit(review);
  await opened;
  f.workspace.invalidate();
  release({ txid: "aa".repeat(32) });
  await assert.rejects(() => result, /Wallet response arrived after/);
});
test("lost profile attestation during a later recheck revokes the verified state", async () => {
  const f = createNativeRpcFixture();
  const Client = createNativeClientClass(nativeCodec);
  const w = createNativeWorkspace({
    makeClient: () => new Client({ rpcClient: f, networkMagic: 123 }),
    wallet: {
      account: async () => custody,
      network: async () => 123,
      invoke: () => {
        throw Error("must not call");
      },
    },
  });
  await w.connect({});
  const review = await w.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  f.state.magic = 456;
  await assert.rejects(() => w.submit(review), /network magic mismatch/);
  assert.equal(w.profile, null);
});

test("rebuilding exported recovery and module calls binds full reviewed authority and pending intent, not just script", async () => {
  const { rebuildNativeReview } =
    await import("../src/features/native/nativeWorkspace.js");
  assert.equal(typeof rebuildNativeReview, "function");
  const base = {
    kind: "lifecycle",
    accountId: identity().accountId,
    method: "executeRecovery",
    script: "abcd",
    requiredAuthorities: [],
    accountState: {
      authorityEpoch: "0",
      configurationNonce: "1",
      pendingRecovery: { address: "aa".repeat(20), matureAt: "1" },
    },
  };
  const exported = {
    format: "neo-native-reviewed-request",
    version: 1,
    submission: "native-sdk",
    profile,
    feePayer: custody,
    requiredAuthorities: [],
    signers: [{ account: "0x" + custody, scopes: "None" }],
    recipe: {
      method: "buildAction",
      input: { accountId: identity().accountId, action: "executeRecovery" },
    },
    plan: base,
  };
  const client = {
    discover: async () => profile,
    buildAction: async () => base,
    revalidatePlan: async () => true,
  };
  assert.equal(await rebuildNativeReview(client, exported), base);
  for (const plan of [
    {
      ...base,
      accountState: {
        ...base.accountState,
        pendingRecovery: { address: "bb".repeat(20), matureAt: "2" },
      },
    },
    { ...base, pending: { method: "setConfig" } },
    { ...base, accountState: { ...base.accountState, authorityEpoch: "1" } },
  ]) {
    client.buildAction = async () => plan;
    await assert.rejects(
      () => rebuildNativeReview(client, exported),
      /changed|mismatch/i,
    );
  }
});
test("confirmation requires mined identity and matching Application log; editing during receipt fetch cancels it", async () => {
  const f = fixture();
  await f.workspace.connect({
    rpcUrl: "http://localhost:1234",
    networkMagic: 123,
  });
  const review = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  const hash = "0x" + "aa".repeat(32);
  const transaction = {
    hash,
    blockhash: "0x" + "bb".repeat(32),
    script: Buffer.from(review.plan.script, "hex").toString("base64"),
    signers: review.signers,
  };
  let log = {
      txid: hash,
      executions: [{ trigger: "Application", vmstate: "HALT", stack: [] }],
    },
    tx = transaction;
  f.client.rpc.send = async (method) =>
    method === "getrawtransaction" ? tx : log;
  assert.equal((await f.workspace.confirm(review, hash)).state, "HALT");
  tx = { ...transaction, blockhash: undefined };
  await assert.rejects(
    () => f.workspace.confirm(review, hash),
    /mined|confirm/i,
  );
  tx = {
    ...transaction,
    signers: [{ ...review.signers[0], scopes: "Global" }],
  };
  await assert.rejects(() => f.workspace.confirm(review, hash), /scope/i);
  tx = transaction;
  log = {
    txid: "0x" + "cc".repeat(32),
    executions: [{ trigger: "Application", vmstate: "HALT" }],
  };
  await assert.rejects(
    () => f.workspace.confirm(review, hash),
    /identity|transaction/i,
  );
  log = {
    txid: hash,
    executions: [{ trigger: "Verification", vmstate: "HALT" }],
  };
  await assert.rejects(() => f.workspace.confirm(review, hash), /Application/i);
  let release;
  f.client.rpc.send = () => new Promise((resolve) => (release = resolve));
  const pending = f.workspace.confirm(review, hash);
  await new Promise((resolve) => setImmediate(resolve));
  f.workspace.clearReview();
  release(transaction);
  await assert.rejects(() => pending, /changed|stale/i);
});
test("false or missing NEP17 transfer outcomes cannot be called a confirmed success", async () => {
  const { validateNativeReceipt } =
    await import("../src/features/native/nativeWorkspace.js");
  assert.equal(typeof validateNativeReceipt, "function");
  const hash = "0x" + "aa".repeat(32),
    review = {
      feePayer: custody,
      signers: [{ account: "0x" + custody, scopes: "CalledByEntry" }],
      plan: {
        kind: "execution",
        script: "abcd",
        batch: false,
        preparedOperations: [{ operation: { method: "transfer" } }],
      },
    };
  const tx = {
    hash,
    blockhash: "0x" + "bb".repeat(32),
    script: Buffer.from("abcd", "hex").toString("base64"),
    signers: review.signers,
  };
  for (const stack of [[{ type: "Boolean", value: false }], []])
    assert.throws(
      () =>
        validateNativeReceipt(
          review,
          tx,
          {
            txid: hash,
            executions: [{ trigger: "Application", vmstate: "HALT", stack }],
          },
          hash,
        ),
      /transfer/i,
    );
});
test("SDK review uses SDK payer scope while wallet invocation remains a separate bounded path", async () => {
  const f = fixture();
  await f.workspace.connect({
    rpcUrl: "http://localhost:1234",
    networkMagic: 123,
  });
  const review = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
    submission: "native-sdk",
  });
  assert.equal(review.submission, "native-sdk");
  assert.equal(review.walletSupported, false);
  assert.equal(review.request, null);
  assert.deepEqual(review.signers, [
    {
      account: "0x" + custody,
      scopes: "CustomContracts",
      allowedcontracts: ["0x" + NATIVE_ACCOUNT_SERVICE],
    },
  ]);
  await assert.rejects(() => f.workspace.submit(review), /exact-script/);
  const walletReview = await f.workspace.registration({
    custodyAddress: custody,
    salt,
    recoveryAddress: recovery,
  });
  const { rebuildNativeReview } =
    await import("../src/features/native/nativeWorkspace.js");
  const exported = await f.workspace.exportReview(walletReview);
  await assert.rejects(
    () => rebuildNativeReview(f.client, exported),
    /wallet invocation/,
  );
});
test("SDK recovery cancellation grants the actor core scope; permissionless recovery payer has None", async () => {
  const f = fixture();
  let state = { ...f.state, pendingRecovery: { matureAt: "2000" } };
  f.client.rpc.send = async (method) =>
    method === "getblockcount" ? 1 : { time: 1000 };
  f.client.buildAction = async (input) => ({
    kind: "lifecycle",
    accountId: state.accountId,
    accountState: state,
    method: input.action,
    requiredAuthorities: [],
    authorityPolicy:
      input.action === "cancelRecovery"
        ? "recovery-or-custody-before-maturity"
        : undefined,
    script: "abcd",
  });
  await f.workspace.connect({});
  const cancel = await f.workspace.lifecycle({
    accountId: state.accountId,
    action: "cancelRecovery",
    feePayer: recovery,
    submission: "native-sdk",
  });
  assert.equal(cancel.signers[0].scopes, "CustomContracts");
  assert.deepEqual(cancel.requiredAuthorities, [recovery]);
  assert.deepEqual(cancel.signers[0].allowedcontracts, [
    "0x" + NATIVE_ACCOUNT_SERVICE,
  ]);
  state = { ...state, pendingRecovery: { matureAt: "1" } };
  const execute = await f.workspace.lifecycle({
    accountId: state.accountId,
    action: "executeRecovery",
    feePayer: recovery,
    submission: "native-sdk",
  });
  assert.equal(execute.signers[0].scopes, "None");
  assert.deepEqual(execute.requiredAuthorities, []);
});

function policyFixture(role = "verifier") {
  const rpc = createNativeRpcFixture();
  rpc.state.registered = true;
  const binding = { contract: "44".repeat(20), codeHash: "55".repeat(32) };
  const makePending = (method = "setPolicy") => ({
    accountId: nativeTestIdentity.accountId,
    role,
    root: binding,
    selected: binding,
    method,
    invokedArguments: { type: "Array", value: [nativeCodec.hashValue(nativeTestIdentity.accountId)] },
    proposedAt: String(rpc.state.time - 86400001),
    matureAt: String(rpc.state.time - 1),
    configurationNonce: "0",
  });
  const B = (value) => ({ type: "ByteString", value: Buffer.from(value, "hex").toString("base64") });
  const H = (value) => B(Buffer.from(value, "hex").reverse().toString("hex"));
  const I = (value) => ({ type: "Integer", value: String(value) });
  const A = (value) => ({ type: "Array", value });
  function setPending(value) {
    rpc.add("getPendingModuleCall", [nativeCodec.hashValue(nativeTestIdentity.accountId), nativeCodec.stringValue(role)], value ? A([
      I(1), H(value.accountId), I(role === "verifier" ? 0 : 1),
      A([H(binding.contract), H(binding.codeHash)]), A([H(binding.contract), H(binding.codeHash)]),
      B(Buffer.from(value.method).toString("hex")), A([H(value.accountId)]),
      I(value.proposedAt), I(value.matureAt), I(value.configurationNonce),
    ]) : { type: "Any", value: null });
  }
  setPending(makePending());
  const Client = createNativeClientClass(nativeCodec);
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  let walletCalls = 0;
  const wallet = {
    account: async () => custody,
    network: async () => 123,
    invoke: async (request) => { walletCalls++; return { request }; },
  };
  return {
    rpc, client,
    workspace: createNativeWorkspace({ makeClient: () => client, wallet }),
    called: () => walletCalls,
    replace() { setPending(makePending("replacePolicy")); },
    clear() { setPending(null); },
  };
}

test("guarded policy cancellation preserves the selected intent and cannot fall back to wallet invoke", async () => {
  for (const role of ["verifier", "hook"]) {
    const f = policyFixture(role);
    await f.workspace.connect({});
    const inspected = await f.workspace.inspectPolicy({ accountId: nativeTestIdentity.accountId, role });
    assert.equal(inspected.role, role);
    assert.equal(inspected.chainTime, f.rpc.state.time);
    assert.equal(inspected.pending.method, "setPolicy");
    const review = await f.workspace.lifecycle({
      accountId: nativeTestIdentity.accountId, action: "cancelModuleCall", role,
      feePayer: custody, expectedPending: inspected.pending,
    });
    assert.equal(review.submission, "native-sdk");
    assert.equal(review.walletSupported, false);
    assert.equal(review.request, null);
    assert.equal(review.plan.requiresExactScript, true);
    assert.match(review.plan.pendingCallBytes, /^400a[0-9a-f]+$/);
    assert.notEqual(review.plan.script, nativeCodec.dynamicCall(NATIVE_ACCOUNT_SERVICE, "cancelModuleCall", [
      nativeCodec.hashValue(nativeTestIdentity.accountId), nativeCodec.stringValue(role),
    ]));
    assert.equal(review.plan.role, role);
    assert.deepEqual(review.plan.pending, inspected.pending);
    assert.deepEqual(review.requiredAuthorities, [custody]);
    await assert.rejects(() => f.workspace.submit(review), /exact-script/);
    assert.equal(f.called(), 0);
  }
});

test("pending cancellation refuses a changed inspected intent and stale SDK export even with unchanged account state", async () => {
  const f = policyFixture();
  await f.workspace.connect({});
  const inspected = await f.workspace.inspectPolicy({ accountId: nativeTestIdentity.accountId, role: "verifier" });
  const input = {
    accountId: nativeTestIdentity.accountId, action: "cancelModuleCall", role: "verifier",
    expectedPending: inspected.pending, feePayer: custody, submission: "native-sdk",
  };
  const review = await f.workspace.lifecycle(input);
  const exported = await f.workspace.exportReview(review);
  assert.equal(exported.recipe.input.role, "verifier");
  f.replace();
  await assert.rejects(() => f.workspace.exportReview(review), /pending|intent|changed/i);
  const { rebuildNativeReview } = await import("../src/features/native/nativeWorkspace.js");
  await assert.rejects(() => rebuildNativeReview(f.client, exported), /pending|intent|changed/i);
  await assert.rejects(() => f.workspace.lifecycle(input), /pending.*changed|changed.*pending/i);
  f.clear();
  const empty = await f.workspace.inspectPolicy({ accountId: nativeTestIdentity.accountId, role: "verifier" });
  assert.equal(empty.pending, null);
});

test("changing policy inputs during inspection prevents a stale pending card", async () => {
  const f = policyFixture();
  await f.workspace.connect({});
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  f.client.getPendingModuleCall = async () => result;
  const inspection = f.workspace.inspectPolicy({
    accountId: nativeTestIdentity.accountId, role: "verifier",
  });
  f.workspace.clearReview();
  finish(null);
  await assert.rejects(() => inspection, /inputs changed/i);
});

test("all three mature activations use only the unrelated payer in wallet and SDK reviews", async () => {
  const rpc = createNativeRpcFixture();
  rpc.state.registered = true;
  const Client = createNativeClientClass(nativeCodec);
  const client = new Client({ rpcClient: rpc, networkMagic: 123 });
  const state = await client.getAccount(nativeTestIdentity.accountId);
  client.getAccount = async () => ({ ...state,
    pendingVerifier: { matureAt: "1" }, pendingHook: { matureAt: "1" },
    pendingRecoveryAddress: { matureAt: "1" },
  });
  const workspace = createNativeWorkspace({ makeClient: () => client });
  await workspace.connect({});
  for (const action of ["activateVerifier", "activateHook", "activateRecoveryAddress"]) {
    for (const submission of ["wallet-invoke", "native-sdk"]) {
      const review = await workspace.lifecycle({ accountId: state.accountId, action, feePayer: "66".repeat(20), submission });
      assert.deepEqual(review.requiredAuthorities, []);
      assert.equal(review.signers.length, 1);
      assert.equal(review.signers[0].scopes, submission === "native-sdk" ? "None" : "CalledByEntry");
      assert.equal(review.walletSupported, submission === "wallet-invoke");
      assert.match(review.description, /anyone/i);
    }
  }
});
test("SDK execution signer order is fee payer, proxy, remaining custody authority", async () => {
  const f = fixture();
  f.client.rpc.send = async (method) =>
    method === "getblockcount" ? 1 : { time: 1000 };
  const prepared = {
    account: f.state,
    channel: "0",
    operation: {
      targetContract: recovery,
      method: "ping",
      args: [],
      deadline: "2000",
      signature: "",
    },
  };
  f.client.prepareOperation = async () => prepared;
  f.client.buildExecution = () => ({
    kind: "execution",
    accountId: f.state.accountId,
    accountAddress: f.state.accountAddress,
    requiredAuthorities: [custody],
    proxySigner: {
      account: "0x" + f.state.accountAddress,
      scopes: "CustomContracts",
      allowedcontracts: ["0x" + recovery],
    },
    script: "abcd",
    preparedOperations: [prepared],
  });
  await f.workspace.connect({});
  const result = await f.workspace.operation({
    accountId: f.state.accountId,
    deadline: "2000",
    feePayer: recovery,
  });
  assert.deepEqual(
    result.signers.map((s) => s.account),
    ["0x" + recovery, "0x" + f.state.accountAddress, "0x" + custody],
  );
  assert.deepEqual(
    result.signers.map((s) => s.scopes),
    ["None", "CustomContracts", "CustomContracts"],
  );
});

test("custody may cancel configuration proposals during recovery without enabling new configuration", async () => {
  const f = fixture();
  const pending = { matureAt: "1" };
  const state = {
    ...f.state,
    pendingVerifier: pending,
    pendingHook: pending,
    pendingRecoveryAddress: pending,
    pendingRecovery: { matureAt: "2000" },
  };
  f.client.rpc.send = async (method) =>
    method === "getblockcount" ? 1 : { time: 1000 };
  f.client.buildAction = async ({ action }) => ({
    kind: "lifecycle",
    accountId: state.accountId,
    accountState: state,
    method: action,
    requiredAuthorities: [custody],
    script: "abcd",
  });
  await f.workspace.connect({});
  for (const target of ["Verifier", "Hook", "RecoveryAddress"]) {
    const review = await f.workspace.lifecycle({
      accountId: state.accountId,
      action: "cancel" + target,
      feePayer: custody,
    });
    assert.deepEqual(review.plan.requiredAuthorities, [custody]);
    assert.equal(review.walletSupported, true);
    for (const verb of ["propose", "activate"])
      assert.match(
        actionBlockReason(state, verb + target, 1000),
        /Configuration is blocked/,
      );
    assert.match(
      actionBlockReason(
        { ...state, ["pending" + target]: null },
        "cancel" + target,
        1000,
      ),
      /No matching configuration proposal/,
    );
    assert.match(
      actionBlockReason(
        { ...state, pendingRecovery: null, status: "Frozen" },
        "propose" + target,
        1000,
      ),
      /Configuration is blocked/,
    );
  }
});

test("GAS limits remain exact decimal integers and reject implicit or rounded fees", () => {
  assert.equal(nativeGasLimit("0.00000001"), "1");
  assert.equal(nativeGasLimit("1.23456789"), "123456789");
  assert.equal(nativeGasLimit("0"), "0");
  for (const invalid of ["", "1e2", "-1", "0.000000001", "01", "Infinity", "92233720369"])
    assert.throws(() => nativeGasLimit(invalid), /fee|GAS/);
});

function exactImportFixture(overrides = {}) {
  let sends = 0;
  const tools = {
    importArtifact: async (_client, review, _text, caps) => Object.freeze({
      review, txid: "0x" + "ab".repeat(32), rawTransaction: "aa",
      fees: { system: "10", network: "1", total: "11" }, caps,
      transaction: { validUntilBlock: 20 },
    }),
    preflight: async () => ({ snapshot: { height: 10 }, state: "HALT" }),
    broadcast: async (_client, _transaction, { assertCurrent }) => {
      assertCurrent(); sends++;
      return { txid: "0x" + "ab".repeat(32), submitted: true };
    },
    receipt: async () => ({ confirmed: true, succeeded: true, vmState: "HALT" }),
    ...overrides,
  };
  return { ...fixture({ transactionTools: tools }), tools, sends: () => sends };
}
const exactReview = async (f) => {
  await f.workspace.connect({});
  return f.workspace.registration({ custodyAddress: custody, recoveryAddress: recovery, salt, submission: "native-sdk" });
};
const importCaps = { maxSystemFee: "100", maxNetworkFee: "100", maxTotalFee: "200" };

function recoveryCancellationFixture(options = {}) {
  const f = fixture(options);
  let chainTime = 1000;
  f.state.pendingRecovery = { address: "33".repeat(20), proposedAt: "0", matureAt: "2000", configurationNonce: "0" };
  f.client.rpc.send = async (method) => method === "getblockcount" ? 1 : { time: chainTime };
  f.client.buildAction = async ({ accountId, action }) => ({
    kind: "lifecycle", accountId, accountState: structuredClone(f.state), method: action,
    requiredAuthorities: [], authorityPolicy: "recovery-or-custody-before-maturity",
    script: nativeCodec.dynamicCall(NATIVE_ACCOUNT_SERVICE, action, [nativeCodec.hashValue(accountId)]),
  });
  return { ...f, time(value) { chainTime = value; } };
}

test("cancellation authority is separate from payer and forces exact signing only when needed", async () => {
  const f = recoveryCancellationFixture();
  await f.workspace.connect({});
  const payer = "66".repeat(20);
  for (const authority of [custody, recovery]) {
    const review = await f.workspace.lifecycle({ accountId: f.state.accountId, action: "cancelRecovery", feePayer: payer, cancellationAuthority: authority });
    assert.equal(review.cancellationAuthority, authority);
    assert.equal(review.feePayer, payer);
    assert.equal(review.submission, "native-sdk");
    assert.equal(review.request, null);
    assert.deepEqual(review.requiredAuthorities, [authority]);
    assert.deepEqual(review.plan.requiredAuthorities, [], "the client-issued plan is not rewritten");
    assert.deepEqual(review.signers, [{ account: "0x" + payer, scopes: "None" },
      { account: "0x" + authority, scopes: "CustomContracts", allowedcontracts: ["0x" + NATIVE_ACCOUNT_SERVICE] }]);
  }
  for (const authority of [custody, recovery]) {
    const review = await f.workspace.lifecycle({ accountId: f.state.accountId, action: "cancelRecovery", feePayer: authority });
    assert.equal(review.cancellationAuthority, authority);
    assert.equal(review.submission, "wallet-invoke");
    assert.deepEqual(review.signers, [{ account: "0x" + authority, scopes: "CalledByEntry" }]);
    f.wallet.account = async () => authority;
    const sent = await f.workspace.submit(review);
    assert.equal(sent.request.operation, "cancelRecovery");
    assert.deepEqual(sent.request.args, [{ type: "Hash160", value: "0x" + f.state.accountId }]);
  }
  const crossing = await f.workspace.lifecycle({ accountId: f.state.accountId, action: "cancelRecovery", feePayer: recovery, cancellationAuthority: custody });
  assert.equal(crossing.signers[0].scopes, "None", "an unselected recovery payer gains no authority scope");
  assert.deepEqual(crossing.requiredAuthorities, [custody]);
});

test("recovery cancellation uses chain maturity with strict custody boundary and rejects unrelated authority", async () => {
  const f = recoveryCancellationFixture();
  await f.workspace.connect({});
  const input = { accountId: f.state.accountId, action: "cancelRecovery", feePayer: "66".repeat(20) };
  for (const now of [1999, 2000, 2001]) {
    f.time(now);
    await f.workspace.lifecycle({ ...input, cancellationAuthority: recovery });
    if (now < 2000) await f.workspace.lifecycle({ ...input, cancellationAuthority: custody });
    else await assert.rejects(() => f.workspace.lifecycle({ ...input, cancellationAuthority: custody }), /before maturity/);
  }
  for (const authority of ["77".repeat(20), "00".repeat(20), "bad"])
    await assert.rejects(() => f.workspace.lifecycle({ ...input, cancellationAuthority: authority }));
  f.state.pendingRecovery = null;
  await assert.rejects(() => f.workspace.lifecycle({ ...input, cancellationAuthority: recovery }), /No custody recovery/);
});

test("cancellation export and rebuild bind actual authority, scopes and current chain time", async () => {
  const { rebuildNativeReview } = await import("../src/features/native/nativeWorkspace.js");
  const f = recoveryCancellationFixture();
  await f.workspace.connect({});
  const review = await f.workspace.lifecycle({ accountId: f.state.accountId, action: "cancelRecovery", feePayer: "66".repeat(20), cancellationAuthority: custody });
  const exported = await f.workspace.exportReview(review);
  assert.equal(exported.cancellationAuthority, custody);
  assert.equal(Object.hasOwn(exported.recipe.input, "cancellationAuthority"), false);
  assert.deepEqual(await rebuildNativeReview(f.client, exported), review.plan);
  for (const change of [
    (copy) => { copy.cancellationAuthority = recovery; },
    (copy) => { copy.requiredAuthorities = [recovery]; },
    (copy) => { copy.signers[0].scopes = "CustomContracts"; },
    (copy) => { copy.signers.reverse(); },
    (copy) => { copy.feePayer = recovery; },
  ]) {
    const copy = structuredClone(exported); change(copy);
    await assert.rejects(() => rebuildNativeReview(f.client, copy), /authority|signer|payer|scope/i);
  }
  f.time(2000);
  await assert.rejects(() => f.workspace.exportReview(review), /before maturity/);
  await assert.rejects(() => rebuildNativeReview(f.client, exported), /before maturity/);
});

test("legacy version-one cancellation exports rebuild only with the exact same-payer authority roster", async () => {
  const { rebuildNativeReview } = await import("../src/features/native/nativeWorkspace.js");
  const f = recoveryCancellationFixture();
  await f.workspace.connect({});
  const review = await f.workspace.lifecycle({ accountId: f.state.accountId, action: "cancelRecovery", feePayer: custody, submission: "native-sdk" });
  const legacy = structuredClone(await f.workspace.exportReview(review));
  delete legacy.cancellationAuthority;
  assert.deepEqual(await rebuildNativeReview(f.client, legacy), review.plan);
  assert.equal(Object.hasOwn(legacy, "cancellationAuthority"), false, "legacy input is not rewritten");
  for (const change of [
    (copy) => { copy.feePayer = "66".repeat(20); },
    (copy) => { copy.requiredAuthorities = [recovery]; },
    (copy) => { copy.signers[0].scopes = "None"; delete copy.signers[0].allowedcontracts; },
    (copy) => { copy.cancellationAuthority = null; },
    (copy) => { copy.cancellationAuthority = undefined; },
    (copy) => { copy.recipe.input.cancellationAuthority = recovery; },
  ]) {
    const copy = structuredClone(legacy); change(copy);
    await assert.rejects(() => rebuildNativeReview(f.client, copy));
  }
  f.time(2000);
  await assert.rejects(() => rebuildNativeReview(f.client, legacy), /before maturity/);
});

test("cancellation authority changes invalidate pending imported transactions and delayed reviews", async () => {
  let importedReview;
  const f = recoveryCancellationFixture({ transactionTools: { importArtifact: async (_client, review) => { importedReview = review; return {}; } } });
  await f.workspace.connect({});
  const input = { accountId: f.state.accountId, action: "cancelRecovery", feePayer: "66".repeat(20), cancellationAuthority: custody };
  const first = await f.workspace.lifecycle(input);
  const imported = await f.workspace.importSigned(first, "{}", importCaps);
  assert.equal(importedReview, first);
  await f.workspace.lifecycle({ ...input, cancellationAuthority: recovery });
  await assert.rejects(() => f.workspace.exportReview(first), /stale/);
  await assert.rejects(() => f.workspace.preflightSigned(imported), /stale/);
  const beforeMaturity = await f.workspace.lifecycle(input);
  f.time(2000);
  await assert.rejects(() => f.workspace.importSigned(beforeMaturity, "{}", importCaps), /before maturity/);
});

test("custody cancellation cannot cross maturity during simulation or before wallet approval", async () => {
  const f = recoveryCancellationFixture();
  await f.workspace.connect({});
  const input = { accountId: f.state.accountId, action: "cancelRecovery", feePayer: custody };
  const review = await f.workspace.lifecycle(input);
  f.time(2000);
  await assert.rejects(() => f.workspace.submit(review), /before maturity/);
  assert.equal(f.called(), 0);
  f.time(1999);
  f.client.simulate = async () => {
    f.time(2000);
    return { state: "HALT", gasConsumed: "10", failedTransfers: [] };
  };
  await assert.rejects(() => f.workspace.lifecycle(input), /before maturity/);
  assert.equal(f.workspace.review, null);
});

test("cancellation review rebuilds through SDK signing and real browser witness import with independent payer", async () => {
  const crypto = await import("node:crypto");
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../../sdk/js/package.json", import.meta.url));
  const { NativeSmartAccountClient } = require("./src/native");
  const { rebuildNativeReview } = await import("../src/features/native/nativeWorkspace.js");
  // Existing public offline fixture scalars from the SDK multisig tests.
  function fixtureWallet(scalar) {
    const bytes = Buffer.alloc(32); bytes[31] = scalar;
    const ec = crypto.createECDH("prime256v1"); ec.setPrivateKey(bytes);
    const publicPoint = ec.getPublicKey(undefined, "uncompressed");
    const key = crypto.createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256",
      x: publicPoint.subarray(1, 33).toString("base64url"), y: publicPoint.subarray(33).toString("base64url"), d: bytes.toString("base64url") } });
    const verificationScript = "0c21" + ec.getPublicKey(undefined, "compressed").toString("hex") + "4156e7b327";
    const account = crypto.createHash("ripemd160").update(crypto.createHash("sha256").update(Buffer.from(verificationScript, "hex")).digest()).digest().reverse().toString("hex");
    return { account, verificationScript, sign(data) { return crypto.sign("sha256", Buffer.from(data, "hex"), { key, dsaEncoding: "ieee-p1363" }).toString("hex"); } };
  }
  const owner = fixtureWallet(2), guardian = fixtureWallet(3), independent = fixtureWallet(41);
  const rpc = createNativeRpcFixture();
  rpc.state.registered = true;
  rpc.state.time = 1900000000000;
  const identity = nativeCodec.deriveIdentity({ networkMagic: 123, custodyAddress: owner.account, salt });
  const accountRead = nativeCodec.dynamicCall(NATIVE_ACCOUNT_SERVICE, "getAccount", [nativeCodec.hashValue(identity.accountId)], 5);
  const H = (value) => ({ type: "ByteString", value: Buffer.from(value, "hex").reverse().toString("base64") });
  const I = (value) => ({ type: "Integer", value: String(value) });
  let replacement = "55".repeat(20);
  const rpcClient = { async send(method, params) {
    if (method === "calculatenetworkfee") return { networkfee: "50" };
    if (method === "invokescript" && Buffer.from(params[0], "base64").toString("hex") === accountRead) {
      const record = rpc.record();
      record.value[1] = H(identity.accountId); record.value[2] = H(identity.accountAddress);
      record.value[3] = H(owner.account); record.value[4] = H(guardian.account);
      record.value[12] = { type: "Array", value: [H(replacement), I(1899999999000), I(1900000001000), I(0)] };
      return { state: "HALT", stack: [record], gasconsumed: "100000", minimumrequiredfee: "100000" };
    }
    return rpc.send(method, params);
  } };
  const makeClient = () => new NativeSmartAccountClient({ networkMagic: 123, rpcClient });
  const workspace = createNativeWorkspace({ makeClient });
  await workspace.connect({});
  const caps = { maxSystemFee: "200000", maxNetworkFee: "100", maxTotalFee: "200100" };
  for (const [payer, authority] of [[independent, owner], [independent, guardian], [guardian, owner], [owner, owner], [guardian, guardian]]) {
    const review = await workspace.lifecycle({ accountId: identity.accountId, action: "cancelRecovery", feePayer: payer.account,
      cancellationAuthority: authority.account, submission: "native-sdk" });
    const exported = await workspace.exportReview(review);
    const sdk = makeClient();
    const plan = await rebuildNativeReview(sdk, exported);
    const prepared = await sdk.prepareTransaction(plan, { feePayer: payer, authoritySigners: payer === authority ? [] : [authority],
      cancellationAuthority: exported.cancellationAuthority, nonce: 42, validUntilBlock: 50, ...caps });
    const signed = await sdk.signTransaction(prepared);
    const artifact = sdk.exportSignedTransaction(signed);
    const imported = await workspace.importSigned(review, JSON.stringify(artifact), caps);
    assert.equal(imported.txid, signed.txid);
    assert.equal(imported.witnesses.length, payer === authority ? 1 : 2);
    assert.equal(imported.transaction.signers[0].scopes, payer === authority ? "CustomContracts" : "None");
    assert.equal(imported.transaction.signers.at(-1).account, "0x" + authority.account);
    assert.deepEqual(imported.transaction.signers.at(-1).allowedcontracts, ["0x" + NATIVE_ACCOUNT_SERVICE]);
    const changedRoster = structuredClone(artifact);
    changedRoster.transaction.signers[0].scopes = "Global";
    await assert.rejects(() => workspace.importSigned(review, JSON.stringify(changedRoster), caps), /scope|canonical|signer/);
    replacement = "56".repeat(20);
    await assert.rejects(() => workspace.importSigned(review, JSON.stringify(artifact), caps), /account changed/);
    replacement = "55".repeat(20);
  }
  assert.equal(rpc.state.calls.some(({ method }) => method === "sendrawtransaction"), false);
});

test("imported transaction remains bound to the current review and fee limits across async work", async () => {
  const f = exactImportFixture();
  const review = await exactReview(f);
  const imported = await f.workspace.importSigned(review, "{}", importCaps);
  assert.equal((await f.workspace.preflightSigned(imported)).state, "HALT");
  f.workspace.clearImported();
  await assert.rejects(() => f.workspace.broadcastSigned(imported), /stale/);
  assert.equal(f.sends(), 0);
  let finish, started;
  const importingStarted = new Promise((resolve) => { started = resolve; });
  f.tools.importArtifact = () => new Promise((resolve) => { finish = resolve; started(); });
  const importing = f.workspace.importSigned(review, "{}", importCaps);
  await importingStarted;
  f.workspace.clearReview();
  finish(Object.freeze({ txid: imported.txid }));
  await assert.rejects(() => importing, /changed/);
});

test("a changed review during the broadcast preflight never reaches submission", async () => {
  let resume;
  const pending = new Promise((resolve) => { resume = resolve; });
  let sent = 0;
  const f = exactImportFixture({ broadcast: async (_c, _tx, { assertCurrent }) => {
    await pending;
    assertCurrent();
    sent++;
  } });
  const review = await exactReview(f);
  const imported = await f.workspace.importSigned(review, "{}", importCaps);
  const broadcasting = f.workspace.broadcastSigned(imported);
  f.workspace.clearReview();
  resume();
  await assert.rejects(() => broadcasting, /stale/);
  assert.equal(sent, 0);
});

test("uncertain submission retains same transaction for receipt and cannot be retried", async () => {
  let attempts = 0;
  const f = exactImportFixture({ broadcast: async (_c, tx, { assertCurrent }) => {
    assertCurrent(); attempts++;
    throw Object.assign(Error("timed out"), { submissionAttempted: true, txid: tx.txid });
  } });
  const review = await exactReview(f);
  const imported = await f.workspace.importSigned(review, "{}", importCaps);
  await assert.rejects(() => f.workspace.broadcastSigned(imported), { message: "timed out", submissionAttempted: true });
  await assert.rejects(() => f.workspace.broadcastSigned(imported), /already attempted/);
  await assert.rejects(() => f.workspace.importSigned(review, "{}", importCaps), /current exact-script review/);
  f.change(); // Receipt must remain available after a successful transaction changes account state.
  assert.equal((await f.workspace.confirmSigned(imported)).succeeded, true);
  assert.equal(attempts, 1);
});

test("archived receipts survive executed state and expiry without gaining submission authority", async () => {
  let restoredChecks = 0;
  const f = exactImportFixture({
    restoreForReceipt: async (_client, review) => {
      assert.equal(review.format, "neo-native-reviewed-request");
      return Object.freeze({ txid: "0x" + "ab".repeat(32), receiptOnly: true });
    },
    receipt: async () => { restoredChecks++; return { confirmed: true, succeeded: true }; },
  });
  await f.workspace.connect({});
  f.change();
  const restored = await f.workspace.restoreReceipt('{"format":"neo-native-reviewed-request","version":1}', "{}");
  assert.equal((await f.workspace.confirmRestoredReceipt(restored)).succeeded, true);
  await assert.rejects(() => f.workspace.preflightSigned(restored), /stale/);
  await assert.rejects(() => f.workspace.broadcastSigned(restored), /stale/);
  assert.equal(f.sends(), 0);
  f.workspace.clearReview();
  assert.equal((await f.workspace.confirmRestoredReceipt(restored)).confirmed, true, "changing new form inputs does not invalidate a read-only archived receipt");
  f.workspace.clearArchived();
  await assert.rejects(() => f.workspace.confirmRestoredReceipt(restored), /files changed/);
  assert.equal(restoredChecks, 2);
});

test("archived receipt restoration is revoked by a network change during verification", async () => {
  let finish;
  const f = exactImportFixture({ restoreForReceipt: () => new Promise((resolve) => { finish = resolve; }) });
  await f.workspace.connect({});
  const restoring = f.workspace.restoreReceipt("{}", "{}");
  await Promise.resolve();
  f.workspace.invalidate();
  finish(Object.freeze({ receiptOnly: true }));
  await assert.rejects(() => restoring, /Stale/);
});
