import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createNativeWorkspace,
  actionBlockReason,
  nativeCodec,
  nativeAddress,
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
function fixture() {
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
  const workspace = createNativeWorkspace({ makeClient: () => client, wallet });
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
test("canonical native codecs are shipped byte-identically in the standalone frontend", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  for (const name of ["nativeSmartAccount.mjs", "nativeSmartAccountClient.mjs"])
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
