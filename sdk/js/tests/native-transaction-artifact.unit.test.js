const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createNativeTransactionArtifactTools, validateNativeSignedPreflight, NATIVE_SIGNED_ARTIFACT_MAX_CHARS } = require("../../../shared/nativeTransactionArtifact.mjs");
const { createNativeWalletWitnessTools } = require("../../../shared/nativeWalletWitness.mjs");
const { NativeSmartAccountClient, nativeCodec: c } = require("../src/native");
const fixture = require("./fixtures/native-signed-registration.json");
const executionFixture = require("./fixtures/native-signed-execution.json");
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (hex) => crypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const hash160 = (hex) => Buffer.from(crypto.createHash("ripemd160").update(Buffer.from(hash(hex), "hex")).digest()).reverse().toString("hex");
const caps = { maxSystemFee: "300000", maxNetworkFee: "100000", maxTotalFee: "400000" };
function setup(source = fixture) {
  const data = clone(source), calls = [];
  let state = {
    blockCount: 10,
    preflight: {
      hash: data.artifact.txid, network: 123, snapshot: { height: 9, hash: "0x" + "aa".repeat(32) },
      simulation: { mode: "single-transaction-next-block", height: 10, timestamp: "1700000000000", primaryIndex: 0, view: 0, transactionCount: 1, onPersist: "HALT", nextConsensus: "0x" + "bb".repeat(20) },
      verification: "Succeed", state: "HALT", relayed: false, mempoolChecked: false, minimumrequiredfee: "100000", stack: [{ type: "Boolean", value: true }],
    },
    transaction: { hash: data.artifact.txid, blockhash: "0x" + "cc".repeat(32) },
    wire: Buffer.from(data.artifact.rawTransaction, "hex").toString("base64"),
    log: { txid: data.artifact.txid, executions: [{ trigger: "Application", vmstate: "HALT", stack: [{ type: "Boolean", value: true }] }] },
    send: true,
  };
  const client = {
    networkMagic: 123, profile: data.review.profile,
    async discover() { calls.push({ method: "discover" }); return this.profile; },
    async revalidatePlan(plan) { assert.equal(plan, data.review.plan); calls.push({ method: "revalidatePlan" }); },
    rpc: { async send(method, params) {
      calls.push({ method, params });
      if (method === "getblockcount") return state.blockCount;
      if (method === "invoketransaction") return typeof state.preflight === "function" ? state.preflight() : clone(state.preflight);
      if (method === "sendrawtransaction") { if (state.send instanceof Error) throw state.send; return state.send; }
      if (method === "getrawtransaction") return params[1] ? state.transaction : state.wire;
      if (method === "getapplicationlog") return state.log;
      throw Error("Unexpected fixture method: " + method);
    } },
  };
  // Default wallet verification is the same WebCrypto implementation used in browsers.
  const tools = createNativeTransactionArtifactTools({ codec: c, sha256: hash, walletWitness: createNativeWalletWitnessTools({ hash160 }) });
  const load = () => tools.importArtifact(client, data.review, JSON.stringify(data.artifact), caps);
  return { data, client, tools, calls, state, load };
}

test("portable signed-artifact transport exposes bounded import and shared preflight", () => {
  assert.equal(typeof createNativeTransactionArtifactTools, "function");
  assert.equal(typeof validateNativeSignedPreflight, "function");
  assert.equal(NATIVE_SIGNED_ARTIFACT_MAX_CHARS, 1048576);
});

test("static public registration artifact imports with exact review, fees and real browser crypto verification", async () => {
  const f = setup(), imported = await f.load();
  assert.equal(imported.txid, fixture.artifact.txid);
  assert.equal(imported.rawTransaction, fixture.artifact.rawTransaction);
  assert.deepEqual(imported.fees, { system: "200000", network: "50000", total: "250000" });
  assert.ok(Object.isFrozen(imported.transaction.signers));
  assert.equal(f.calls.filter((call) => call.method === "sendrawtransaction").length, 0);
  assert.equal((await f.tools.preflight(f.client, imported)).verification, "Succeed");
});

test("static public execution artifact validates its canonical proxy witness and strict token outcome", async () => {
  const f = setup(executionFixture), imported = await f.load();
  assert.equal(imported.witnesses[1].invocation, "");
  assert.equal((await f.tools.preflight(f.client, imported)).state, "HALT");
  f.state.preflight.stack = [{ type: "Boolean", value: false }];
  await assert.rejects(f.tools.preflight(f.client, imported), /token transfer/);
});

test("artifact schema and input limits reject unknown data before any RPC", async () => {
  const f = setup();
  for (const text of [" ".repeat(NATIVE_SIGNED_ARTIFACT_MAX_CHARS + 1), "{", "null", "[]", JSON.stringify({ ...fixture.artifact, secret: "not-accepted" })]) {
    await assert.rejects(f.tools.importArtifact(f.client, f.data.review, text, caps));
    assert.equal(f.calls.length, 0);
  }
});

test("canonical transaction encoding rejects altered fields, byte casing, hashes and witnesses", async () => {
  const changes = [
    (a) => { a.transaction.nonce++; },
    (a) => { a.transaction.systemFee = "0200000"; },
    (a) => { a.transaction.networkFee = "-1"; },
    (a) => { a.transaction.script = a.transaction.script.toUpperCase(); },
    (a) => { a.transaction.attributes = []; },
    (a) => { a.transaction.signers[0].allowedcontracts.push(a.transaction.signers[0].allowedcontracts[0]); },
    (a) => { a.transaction.signers[0].scopes = "Global"; },
    (a) => { a.transaction.validUntilBlock = 1.5; },
    (a) => { a.txid = "0x" + "00".repeat(32); },
    (a) => { a.signData = "00" + a.signData.slice(2); },
    (a) => { a.unsignedHex += "00"; },
    (a) => { a.rawTransaction += "00"; },
    (a) => { a.witnesses.push(a.witnesses[0]); },
    (a) => { a.witnesses[0].verification += "00"; },
  ];
  for (const change of changes) {
    const f = setup(); change(f.data.artifact);
    await assert.rejects(f.load());
    assert.equal(f.calls.length, 0);
  }
});

test("canonical re-encoded artifact still rejects an invalid wallet signature", async () => {
  const f = setup(), prior = f.data.artifact.witnesses[0].invocation;
  const bad = "0c40" + "00".repeat(64);
  f.data.artifact.witnesses[0].invocation = bad;
  f.data.artifact.rawTransaction = f.data.artifact.rawTransaction.replace(prior, bad);
  await assert.rejects(f.load(), /signature|witness/);
  assert.equal(f.calls.length, 0);
});

test("canonical re-encoded proxy witness still rejects invocation bytes or an altered verification script", async () => {
  for (const field of ["invocation", "verification"]) {
    const f = setup(executionFixture), witness = f.data.artifact.witnesses[1];
    const tail = "00" + (witness.verification.length / 2).toString(16).padStart(2, "0") + witness.verification;
    assert.ok(f.data.artifact.rawTransaction.endsWith(tail));
    if (field === "invocation") witness.invocation = "00";
    else witness.verification = "00" + witness.verification.slice(2);
    const replacement = (witness.invocation.length / 2).toString(16).padStart(2, "0") + witness.invocation + (witness.verification.length / 2).toString(16).padStart(2, "0") + witness.verification;
    f.data.artifact.rawTransaction = f.data.artifact.rawTransaction.slice(0, -tail.length) + replacement;
    await assert.rejects(f.load(), /noncanonical native proxy witness/);
  }
});

test("network, profile, script, payer, signer order and scopes must match the current review", async () => {
  const changes = [
    (f) => { f.client.networkMagic = 124; },
    (f) => { f.data.review.profile.profileParameterDigest = "11".repeat(32); },
    (f) => { f.data.review.plan.script += "40"; },
    (f) => { f.data.review.feePayer = "11".repeat(20); },
    (f) => { f.data.review.signers[0].allowedcontracts = ["0x" + "11".repeat(20)]; },
    (f) => { f.data.review.signers.push({ account: "0x" + "11".repeat(20), scopes: "None" }); },
    (f) => { f.data.review.submission = "wallet-invoke"; },
  ];
  for (const change of changes) {
    const f = setup(); change(f);
    await assert.rejects(f.load());
    assert.equal(f.calls.length, 0);
  }
  const f = setup(executionFixture); f.data.review.signers.reverse();
  await assert.rejects(f.load(), /signer order/);
});

test("explicit fee caps, reviewed admission and expiry all constrain import", async () => {
  for (const low of [{ ...caps, maxSystemFee: "199999" }, { ...caps, maxNetworkFee: "49999" }, { ...caps, maxTotalFee: "249999" }, {}, { ...caps, maxSystemFee: 9007199254740992 }]) {
    const f = setup();
    await assert.rejects(f.tools.importArtifact(f.client, f.data.review, JSON.stringify(f.data.artifact), low));
  }
  const lowBudget = setup(); lowBudget.data.review.simulation.minimumRequiredFee = "200001";
  await assert.rejects(lowBudget.load(), /admission/);
  for (const height of [0, -1, 50, 51, 1.5, "10"]) {
    const f = setup(); f.state.blockCount = height;
    await assert.rejects(f.load(), /block|expire/);
  }
});

test("complete signed preflight checks every declared block and execution boundary", async () => {
  const changes = [
    (r) => { r.hash = "0x" + "00".repeat(32); }, (r) => { r.network = 124; },
    (r) => { r.verification = "Failed"; }, (r) => { r.state = "FAULT"; },
    (r) => { r.relayed = true; }, (r) => { delete r.mempoolChecked; },
    (r) => { r.snapshot.height = "9"; }, (r) => { r.snapshot.hash = "aa"; },
    (r) => { r.simulation.mode = "application-only"; }, (r) => { r.simulation.height++; },
    (r) => { r.simulation.onPersist = "FAULT"; }, (r) => { r.simulation.view = 1; },
    (r) => { r.simulation.transactionCount = 2; }, (r) => { r.simulation.timestamp = 10; },
    (r) => { r.simulation.timestamp = "18446744073709551616"; }, (r) => { r.simulation.primaryIndex = 256; },
    (r) => { r.simulation.nextConsensus = "0x" + "AA".repeat(20); },
    (r) => { r.minimumrequiredfee = "200001"; }, (r) => { delete r.stack; },
    (r) => { r.snapshot.height = 49; r.simulation.height = 50; },
  ];
  for (const change of changes) {
    const f = setup(), imported = await f.load(); change(f.state.preflight);
    await assert.rejects(f.tools.broadcast(f.client, imported));
    assert.equal(f.calls.filter((call) => call.method === "sendrawtransaction").length, 0);
  }
});

test("explicit broadcast performs fresh preflight and sends identical bytes once", async () => {
  const f = setup(), imported = await f.load();
  await f.tools.preflight(f.client, imported);
  const [a, b] = await Promise.all([f.tools.broadcast(f.client, imported), f.tools.broadcast(f.client, imported)]);
  assert.deepEqual(a, { txid: imported.txid, submitted: true, confirmed: false }); assert.equal(a, b);
  assert.equal(f.calls.filter((call) => call.method === "invoketransaction").length, 2);
  const sends = f.calls.filter((call) => call.method === "sendrawtransaction"); assert.equal(sends.length, 1);
  assert.equal(Buffer.from(sends[0].params[0], "base64").toString("hex"), imported.rawTransaction);
});

test("unavailable signed preflight preserves structured RPC errors and never submits", async () => {
  const f = setup(), imported = await f.load();
  f.state.preflight = () => { const error = Error("method unavailable"); error.code = -32601; error.data = { method: "invoketransaction" }; throw error; };
  await assert.rejects(f.tools.broadcast(f.client, imported), (error) => {
    assert.equal(error.code, -32601); assert.deepEqual(error.data, { method: "invoketransaction" });
    assert.equal(error.submissionAttempted, false); assert.equal(error.txid, imported.txid);
    return /preflight unavailable/.test(error.message);
  });
  assert.equal(f.calls.filter((call) => call.method === "sendrawtransaction").length, 0);
});

test("review invalidation during fresh preflight blocks broadcast at the final send boundary", async () => {
  const f = setup(), imported = await f.load(); let current = true;
  const preflight = f.state.preflight;
  f.state.preflight = async () => { current = false; return preflight; };
  await assert.rejects(f.tools.broadcast(f.client, imported, { assertCurrent() { if (!current) throw Error("review changed"); } }), (error) => {
    assert.equal(error.submissionAttempted, false); assert.equal(error.txid, imported.txid); return /review changed/.test(error.message);
  });
  assert.equal(f.calls.filter((call) => call.method === "sendrawtransaction").length, 0);
});

test("submission uncertainty retains the original txid and never retries even after reimport", async () => {
  const f = setup(), imported = await f.load(); f.state.send = Error("timeout");
  const check = (error) => error.message === "timeout" && error.submissionAttempted === true && error.txid === imported.txid;
  await assert.rejects(f.tools.broadcast(f.client, imported), check);
  await assert.rejects(f.tools.broadcast(f.client, await f.load()), check);
  assert.equal(f.calls.filter((call) => call.method === "sendrawtransaction").length, 1);
});

test("receipt verifies exact persisted bytes and txid without requiring old account state", async () => {
  const f = setup(), imported = await f.load();
  f.client.revalidatePlan = async () => { throw Error("account already changed after execution"); };
  const receipt = await f.tools.receipt(f.client, imported);
  assert.equal(receipt.confirmed, true); assert.equal(receipt.succeeded, true); assert.equal(receipt.txid, imported.txid);
  f.state.wire = Buffer.from("00", "hex").toString("base64");
  await assert.rejects(f.tools.receipt(f.client, imported), /persisted transaction bytes/);
  f.state.wire = Buffer.from(imported.rawTransaction, "hex").toString("base64"); f.state.log.txid = "0x" + "00".repeat(32);
  await assert.rejects(f.tools.receipt(f.client, imported), /log transaction identity/);
});

test("confirmed FAULT and unsuccessful transfers are never reported as successful", async () => {
  for (const mode of ["FAULT", "false-transfer", "malformed-stack"]) {
    const f = setup(executionFixture), imported = await f.load();
    const execution = f.state.log.executions[0];
    if (mode === "FAULT") execution.vmstate = "FAULT";
    if (mode === "false-transfer") execution.stack[0].value = false;
    if (mode === "malformed-stack") execution.stack = [];
    const receipt = await f.tools.receipt(f.client, imported);
    assert.equal(receipt.confirmed, true); assert.equal(receipt.succeeded, false); assert.ok(receipt.failures.length);
  }
});

test("receipt cannot claim confirmation from a zero block hash or invalid confirmation count", async () => {
  for (const confirmations of [0, -1, 0.5, "1", null, 9007199254740992]) {
    const f = setup(), imported = await f.load(); f.state.transaction.confirmations = confirmations;
    await assert.rejects(f.tools.receipt(f.client, imported), /invalid confirmations/);
  }
  const zero = setup(), imported = await zero.load(); zero.state.transaction.blockhash = "0x" + "00".repeat(32);
  await assert.rejects(zero.tools.receipt(zero.client, imported), /zero block hash/);
  const valid = setup(), signed = await valid.load(); valid.state.transaction.confirmations = 1;
  assert.equal((await valid.tools.receipt(valid.client, signed)).confirmed, true);
});

test("transport-issued provenance is retained and cannot be restored by object casting", async () => {
  const f = setup(), imported = await f.load();
  await assert.rejects(f.tools.preflight(f.client, clone(imported)), /must be imported/);
  await assert.rejects(f.tools.receipt({ ...f.client }, imported), /must be imported/);
});

function archivedRegistration(data) {
  return { format: "neo-native-reviewed-request", version: 1, ...clone(data.review), recipe: { method: "buildRegistration", input: clone(fixture.recipe) } };
}
test("historical receipt restoration survives execution and expiry but cannot authorize preflight or broadcast", async () => {
  const f = setup(); f.state.blockCount = 1000;
  f.client.revalidatePlan = async () => { throw Error("old state no longer exists"); };
  const archive = archivedRegistration(f.data);
  const restored = await f.tools.restoreForReceipt(f.client, archive, JSON.stringify(f.data.artifact));
  assert.equal(restored.receiptOnly, true);
  assert.equal((await f.tools.receipt(f.client, restored)).succeeded, true);
  await assert.rejects(f.tools.preflight(f.client, restored), /receipt-only/);
  await assert.rejects(f.tools.broadcast(f.client, restored), /receipt-only/);
  assert.equal(f.calls.filter((call) => ["getblockcount", "invoketransaction", "sendrawtransaction"].includes(call.method)).length, 0);
});

test("receipt-only provenance is checked before a prior normal-import broadcast cache", async () => {
  const f = setup(), normal = await f.load();
  await f.tools.broadcast(f.client, normal);
  const restored = await f.tools.restoreForReceipt(f.client, archivedRegistration(f.data), JSON.stringify(f.data.artifact));
  await assert.rejects(f.tools.broadcast(f.client, restored), /receipt-only/);
  await assert.rejects(f.tools.preflight(f.client, restored), /receipt-only/);
  await assert.rejects(f.tools.broadcast(f.client, { ...restored, receiptOnly: false }), /must be imported/);
  assert.equal(f.calls.filter((call) => call.method === "sendrawtransaction").length, 1);
});

test("historical restore binds version, recipe, plan, signers and live profile without trusting archived labels", async () => {
  const changes = [
    (a) => { a.version = 2; }, (a) => { a.format = "other"; },
    (a) => { a.recipe.input.recoveryAddress = "44".repeat(20); },
    (a) => { a.recipe.method = "buildAction"; },
    (a) => { a.plan.accountId = "44".repeat(20); },
    (a) => { a.plan.method = "unfreeze"; },
    (a) => { a.plan.script += "40"; },
    (a) => { a.signers[0].allowedcontracts = ["0x" + "44".repeat(20)]; },
    (a) => { a.feePayer = "44".repeat(20); },
  ];
  for (const change of changes) {
    const f = setup(), archive = archivedRegistration(f.data); change(archive);
    await assert.rejects(f.tools.restoreForReceipt(f.client, archive, JSON.stringify(f.data.artifact)));
    assert.equal(f.calls.length, 0);
  }
  const f = setup(), archive = archivedRegistration(f.data);
  archive.description = "Invented successful result";
  archive.plan.accountState = { custodyAddress: "44".repeat(20), status: "Active" };
  archive.plan.pending = { address: "55".repeat(20) };
  const restored = await f.tools.restoreForReceipt(f.client, JSON.stringify(archive), JSON.stringify(f.data.artifact));
  assert.equal(restored.review.description, undefined);
  assert.equal(restored.review.plan.accountState, undefined);
  assert.equal(restored.review.plan.pending, undefined);
  f.client.discover = async () => { f.client.profile = { ...f.client.profile, profileParameterDigest: "44".repeat(32) }; };
  await assert.rejects(f.tools.restoreForReceipt(f.client, archive, JSON.stringify(f.data.artifact)), /profile changed/);
});

function archivedExecution(data) {
  const archive = { format: "neo-native-reviewed-request", version: 1, ...clone(data.review) }, operation = archive.plan.preparedOperations[0].operation;
  archive.plan.preparedOperations[0].context = { networkMagic: 123, accountId: archive.plan.accountId, authorityEpoch: "0", configurationNonce: "0" };
  archive.recipe = { method: "prepareOperation", input: { accountId: archive.plan.accountId, targetContract: operation.targetContract, method: operation.method,
    args: operation.args, channel: "0", deadline: operation.deadline }, signature: operation.signature };
  return archive;
}
test("historical execution rebuilds signed operation semantics and cannot hide a failed transfer", async () => {
  const f = setup(executionFixture), archive = archivedExecution(f.data);
  f.client.revalidatePlan = async () => { throw Error("execution already consumed nonce"); };
  const restored = await f.tools.restoreForReceipt(f.client, archive, JSON.stringify(f.data.artifact));
  f.state.log.executions[0].stack = [{ type: "Boolean", value: false }];
  const receipt = await f.tools.receipt(f.client, restored);
  assert.equal(receipt.confirmed, true); assert.equal(receipt.succeeded, false);
  const changes = [
    (a) => { a.plan.preparedOperations[0].operation.method = "ping"; a.recipe.input.method = "ping"; },
    (a) => { a.plan.preparedOperations[0].context.authorityEpoch = "1"; },
    (a) => { a.plan.preparedOperations[0].context.networkMagic = 124; },
    (a) => { a.recipe.input.channel = "1"; },
    (a) => { a.recipe.signature = "ff"; },
    (a) => { a.plan.batch = true; },
    (a) => { a.plan.kind = "lifecycle"; },
  ];
  for (const change of changes) {
    const bad = clone(archive); change(bad);
    await assert.rejects(f.tools.restoreForReceipt(f.client, bad, JSON.stringify(f.data.artifact)));
  }
});

test("archived lifecycle, guarded cancellation and module recipes reproduce independently issued SDK scripts", async () => {
  const accountId = "11".repeat(20), binding = { contract: "55".repeat(20), codeHash: "66".repeat(32) };
  const A = (value) => ({ type: "Array", value });
  const H = (value) => Uint8Array.from(Buffer.from(value, "hex").reverse());
  const client = new NativeSmartAccountClient({ networkMagic: 123, rpcClient: { async send(method) {
    assert.equal(method, "getcontractstate");
    return { manifest: { name: "FixtureModule", extra: { smartAccount: { abiVersion: 2, profileDigest: fixture.review.profile.profileParameterDigest,
      compositeVerifier: false, configurationMethods: ["configure"] } }, abi: { methods: [{ name: "configure", safe: false,
        parameters: [{ name: "accountId", type: "Hash160" }, { name: "value", type: "Integer" }] }] } } };
  } } });
  client.profile = fixture.review.profile; client.discover = async () => client.profile;
  client.getAccount = async () => ({ accountId, accountAddress: c.accountAddress(accountId), custodyAddress: fixture.review.feePayer,
    recoveryAddress: "22".repeat(20), status: "Active", configurationNonce: "0", verifier: binding, hook: binding, pendingRecovery: null });
  client._read = async (method, args) => {
    if (method === "supportsComposition") return false;
    assert.equal(method, "getPendingModuleCall");
    const role = Buffer.from(args[1].value, "hex").toString("utf8");
    return A([1n, H(accountId), role === "verifier" ? 0n : 1n, A([H(binding.contract), H(binding.codeHash)]), A([H(binding.contract), H(binding.codeHash)]),
      Uint8Array.from(Buffer.from("configure")), A([H(accountId), 1n]), 1n, 86400001n, 0n]);
  };
  const recipes = [];
  for (const action of ["proposeVerifier", "activateVerifier", "cancelVerifier", "proposeHook", "activateHook", "cancelHook", "proposeRecoveryAddress", "activateRecoveryAddress", "cancelRecoveryAddress", "proposeRecovery", "executeRecovery", "cancelRecovery", "freeze", "unfreeze"])
    recipes.push({ method: "buildAction", input: { accountId, action, ...(action.startsWith("propose") ? { address: "77".repeat(20) } : {}) } });
  for (const role of ["verifier", "hook"]) {
    recipes.push({ method: "buildAction", input: { accountId, action: "cancelModuleCall", role } });
    for (const child of [undefined, "77".repeat(20)]) recipes.push({ method: "buildModuleCall", input: { accountId, role,
      ...(child ? { child } : {}), method: "configure", args: [{ type: "Integer", value: "1" }] } });
  }
  for (const recipe of recipes) {
    const f = setup(), archive = archivedRegistration(f.data);
    archive.recipe = recipe; archive.plan = await client[recipe.method](recipe.input);
    // The independently generated SDK script passes archive reconstruction. The
    // unrelated registration signature must then fail the exact artifact binding.
    await assert.rejects(f.tools.restoreForReceipt(f.client, archive, JSON.stringify(f.data.artifact)), /artifact script does not match current review/);
    assert.equal(f.calls.length, 0);
  }
});

test("SDK exports only signed objects, with public artifact fields and no callbacks", async () => {
  const sdkPreflight = setup().state.preflight;
  const client = new NativeSmartAccountClient({ networkMagic: 123, rpcClient: { async send(method) {
    if (method === "getblockcount") return 10;
    if (method === "calculatenetworkfee") return { networkfee: "50000" };
    if (method === "invoketransaction") return clone(sdkPreflight);
    throw Error("Unexpected fixture method: " + method);
  } } });
  client.profile = fixture.review.profile;
  client.revalidatePlan = async () => true;
  client.simulate = async () => fixture.review.simulation;
  const plan = client.buildRegistration(fixture.recipe);
  const prepared = await client.prepareTransaction(plan, {
    feePayer: { account: fixture.review.feePayer, verificationScript: fixture.artifact.witnesses[0].verification,
      sign(signData) { assert.equal(signData, fixture.artifact.signData); return fixture.artifact.witnesses[0].invocation.slice(4); } },
    ...caps, nonce: 42, validUntilBlock: 50, systemFee: "200000",
  });
  const signed = await client.signTransaction(prepared);
  assert.deepEqual(client.exportSignedTransaction(signed), fixture.artifact);
  assert.throws(() => client.exportSignedTransaction({ ...signed }), /produced by this SDK instance/);
  assert.throws(() => client.exportSignedTransaction(JSON.parse(JSON.stringify(signed))), /produced by this SDK instance/);
  assert.equal(JSON.stringify(client.exportSignedTransaction(signed)).includes("wallets"), false);
  assert.equal((await client.preflightTransaction(signed)).hash, signed.txid);
  sdkPreflight.simulation.onPersist = "FAULT";
  await assert.rejects(client.preflightTransaction(signed), /single-transaction next-block/);
});
