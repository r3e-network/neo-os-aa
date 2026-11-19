/**
 * The signed-artifact transport (SA-MODULE-PROTOCOL.md §11 review exchange).
 *
 * A signed artifact is the only thing that crosses a wallet boundary, so this
 * suite is about what the transport re-derives rather than trusts: the bytes
 * from the transaction fields, the hash from the bytes, the sign data from the
 * network magic, every witness signature from the account it names, the proxy
 * witness from the account id and the core, and the fees from the caps the
 * reviewer approved.
 *
 * The artifacts here are produced by the SDK's own review-sign-export path over
 * a fake node; nothing is hand-assembled, so a refusal always means the
 * transport disagreed with the SDK, never with the fixture.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  createNativeTransactionArtifactTools,
  validateNativeSignedPreflight,
  NATIVE_SIGNED_ARTIFACT_MAX_CHARS,
} = require("../../../shared/nativeTransactionArtifact.mjs");
const { createNativeWalletWitnessTools } = require("../../../shared/nativeWalletWitness.mjs");
const {
  CAPS,
  c,
  clone,
  createNode,
  executionReview,
  registrationReview,
  wallet,
} = require("./helpers/nativeTransactionNode");
const v3Artifact = require("./fixtures/native-signed-registration.json");

const sha256 = (hex) =>
  crypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const hash160 = (hex) =>
  Buffer.from(
    crypto
      .createHash("ripemd160")
      .update(crypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest())
      .digest(),
  )
    .reverse()
    .toString("hex");

/**
 * The transport under test. Only `hash160` is injected: signature verification
 * runs the same WebCrypto P-256 verifier a browser wallet uses, so a witness
 * that passes here would pass in the page.
 */
const tools = createNativeTransactionArtifactTools({
  codec: c,
  sha256,
  walletWitness: createNativeWalletWitnessTools({ hash160 }),
});
/** Canonical re-encoding, so a tamper test can rebuild every derived field. */
const encoding = createNativeTransactionArtifactTools({ codec: c, sha256 });

const importArtifact = (node, review, artifact, caps = CAPS) =>
  tools.importArtifact(node.client, review, JSON.stringify(artifact), caps);

/** Rebuild every field the transport re-derives after a tampered edit. */
function reseal(artifact) {
  const bytes = encoding.bytes({
    networkMagic: artifact.networkMagic,
    transaction: artifact.transaction,
    witnesses: artifact.witnesses,
  });
  return Object.assign({}, artifact, bytes);
}

function preflightOf(artifact, overrides = {}) {
  return {
    hash: artifact.txid,
    network: artifact.networkMagic,
    snapshot: { height: 99, hash: "0x" + "aa".repeat(32) },
    simulation: {
      mode: "single-transaction-next-block",
      height: 100,
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
    gasconsumed: "10",
    minimumrequiredfee: "100",
    stack: [{ type: "Boolean", value: true }],
    ...overrides,
  };
}

function confirmed(node, artifact, execution) {
  node.state.tx = { hash: artifact.txid, blockhash: "0x" + "cc".repeat(32) };
  node.state.wire = Buffer.from(artifact.rawTransaction, "hex").toString("base64");
  node.state.log = {
    txid: artifact.txid,
    executions: [
      {
        trigger: "Application",
        vmstate: "HALT",
        stack: [{ type: "Boolean", value: true }],
        ...execution,
      },
    ],
  };
}

test("the transport exposes bounded import and the shared preflight validator", () => {
  assert.equal(typeof createNativeTransactionArtifactTools, "function");
  assert.equal(typeof validateNativeSignedPreflight, "function");
  assert.equal(NATIVE_SIGNED_ARTIFACT_MAX_CHARS, 1048576);
});

test("a v3 artifact is refused before any node is asked", async () => {
  const node = createNode();
  await assert.rejects(
    importArtifact(node, v3Artifact.review, v3Artifact.artifact),
    /profile has unsupported or missing fields/,
  );
  // The artifact alone is already unusable: the v4 profile is discovered, not
  // declared, so a v3 profile digest can never bind to a live core.
  await assert.rejects(
    importArtifact(node, v3Artifact.review, { ...v3Artifact.artifact, witnesses: [] }),
    /profile has unsupported or missing fields/,
  );
  assert.deepEqual(node.calls, []);
});

test("export binds canonical bytes, hash, sign data and carries no callbacks", async () => {
  const node = createNode();
  const { artifact, prepared, signed } = await registrationReview(node);
  assert.deepEqual(Object.keys(artifact).sort(), [
    "format",
    "networkMagic",
    "profile",
    "rawTransaction",
    "signData",
    "transaction",
    "txid",
    "unsignedHex",
    "version",
    "witnesses",
  ]);
  assert.equal(artifact.format, "neo-native-signed-transaction");
  assert.equal(artifact.version, 1);
  assert.equal(artifact.txid, "0x" + Buffer.from(sha256(artifact.unsignedHex), "hex").reverse().toString("hex"));
  assert.equal(artifact.signData, Buffer.from(artifact.networkMagic.toString(16).padStart(8, "0"), "hex").reverse().toString("hex") + sha256(artifact.unsignedHex));
  assert.ok(artifact.rawTransaction.startsWith(artifact.unsignedHex));
  assert.equal(artifact.profile.contract, node.client.contractHash);
  assert.equal(artifact.profile.implementationId, "NativeSmartAccount/v4");
  assert.equal(artifact.witnesses.length, artifact.transaction.signers.length);
  assert.deepEqual(artifact.transaction.signers, prepared.review.signers);
  // The archive is data: a wallet loading it must not have to run SDK code.
  assert.deepEqual(JSON.parse(JSON.stringify(artifact)), artifact);
  assert.equal(JSON.stringify(signed).includes("sign("), false);
  assert.ok(Object.isFrozen(artifact));
});

test("import returns the reviewed bytes and submits nothing", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  node.calls.length = 0;
  const imported = await importArtifact(node, review, artifact);
  assert.equal(imported.txid, artifact.txid);
  assert.equal(imported.rawTransaction, artifact.rawTransaction);
  assert.deepEqual(imported.fees, { system: "200", network: "50", total: "250" });
  assert.ok(Object.isFrozen(imported.transaction.signers));
  assert.deepEqual(node.calls.map((call) => call.method), ["getblockcount"]);
});

test("import refuses canonical byte drift and unknown artifact fields", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  node.calls.length = 0;
  const changes = [
    (a) => (a.txid = "0x" + "00".repeat(32)),
    (a) => (a.signData = "00" + a.signData.slice(2)),
    (a) => (a.unsignedHex += "00"),
    (a) => (a.rawTransaction += "00"),
    (a) => (a.witnesses.pop()),
    (a) => a.witnesses.push(a.witnesses[0]),
    (a) => (a.networkMagic = 124),
    (a) => (a.secret = "not-accepted"),
    (a) => delete a.signData,
  ];
  for (const change of changes) {
    const tampered = clone(artifact);
    change(tampered);
    await assert.rejects(importArtifact(node, review, tampered));
  }
  for (const text of [" ".repeat(NATIVE_SIGNED_ARTIFACT_MAX_CHARS + 1), "{", "null", "[]"]) {
    await assert.rejects(tools.importArtifact(node.client, review, text, CAPS));
  }
  assert.equal(node.calls.some((call) => call.method === "getblockcount"), false);
});

test("import refuses a transaction field that is not canonical", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const changes = [
    (a) => {
      a.transaction.nonce++;
    },
    (a) => {
      a.transaction.systemFee = "0200";
    },
    (a) => {
      a.transaction.networkFee = "-1";
    },
    (a) => {
      a.transaction.script = a.transaction.script.toUpperCase();
    },
    (a) => {
      a.transaction.validUntilBlock = 1.5;
    },
    // A v4 signer carries only its scope: groups and allowlists are not part of
    // the transactions this SDK builds, and a witness rule belongs to the proxy.
    (a) => {
      a.transaction.signers[0].scopes = "Global";
    },
    (a) => {
      a.transaction.signers[0].rules = [];
    },
    (a) => {
      a.transaction.signers[1].allowedcontracts.push("0x" + "11".repeat(20));
    },
  ];
  for (const change of changes) {
    const tampered = clone(artifact);
    change(tampered);
    await assert.rejects(importArtifact(node, review, tampered));
  }
});

test("import refuses a wallet witness whose signature does not verify", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  node.calls.length = 0;
  for (const edit of [
    (w) => {
      w.invocation = "0c40" + "00".repeat(64);
    },
    (w) => {
      w.invocation = w.invocation.slice(0, -2) + "00";
    },
    (w) => {
      w.verification = "0c21" + "02" + "11".repeat(32) + "4156e7b327";
    },
  ]) {
    const tampered = clone(artifact);
    edit(tampered.witnesses[1]);
    await assert.rejects(importArtifact(node, review, reseal(tampered)), /witness|signature/);
  }
  assert.equal(node.calls.some((call) => call.method === "getblockcount"), false);
});

test("import refuses a proxy witness that is not the one the core derives", async () => {
  const node = createNode();
  const authorizer = wallet();
  node.setAccount({ custody: authorizer.account });
  const { artifact, review } = await executionReview(node);
  assert.equal(review.signers[1].scopes, "WitnessRules");
  assert.equal(artifact.witnesses[1].invocation, "");
  const tampered = clone(artifact);
  tampered.witnesses[1].verification = "00" + tampered.witnesses[1].verification.slice(2);
  await assert.rejects(importArtifact(node, review, reseal(tampered)), /noncanonical native proxy witness/);
  const signed = clone(artifact);
  signed.witnesses[1].invocation = "0c40" + "00".repeat(64);
  await assert.rejects(importArtifact(node, review, reseal(signed)), /noncanonical native proxy witness/);
});

test("import refuses a review for another network, profile, script, payer or signer set", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const changes = [
    (r) => {
      r.plan.script += "40";
    },
    (r) => {
      r.plan.accountId = "44".repeat(20);
    },
    (r) => {
      r.feePayer = "44".repeat(20);
    },
    (r) => {
      r.signers[0].scopes = "Global";
    },
    (r) => {
      r.signers[1].allowedcontracts = ["0x" + "44".repeat(20)];
    },
    (r) => {
      r.signers.push({ account: "0x" + "44".repeat(20), scopes: "None" });
    },
    (r) => {
      r.signers.reverse();
    },
    (r) => {
      r.submission = "wallet-invoke";
    },
    (r) => {
      r.profile.implementationId = "org.r3e.neo.smart-account.v4";
    },
  ];
  for (const change of changes) {
    const edited = clone(review);
    change(edited);
    await assert.rejects(importArtifact(node, edited, artifact));
  }
  node.state.network = 124;
  const other = createNode({ network: 124 });
  await assert.rejects(importArtifact(other, review, artifact), /profile mismatch|network/);
});

test("import refuses fees above the caps, below the reviewed admission and an unreachable window", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  for (const caps of [
    { ...CAPS, maxSystemFee: "199" },
    { ...CAPS, maxNetworkFee: "49" },
    { ...CAPS, maxTotalFee: "249" },
    {},
    { ...CAPS, maxSystemFee: 9007199254740992 },
  ]) {
    await assert.rejects(importArtifact(node, review, artifact, caps));
  }
  const admission = clone(review);
  admission.simulation.minimumRequiredFee = "201";
  await assert.rejects(importArtifact(node, admission, artifact), /admission/);
  for (const height of [0, -1, 200, 50, 1.5, "100"]) {
    const expired = createNode();
    const flow = await registrationReview(expired);
    expired.state.height = height;
    await assert.rejects(importArtifact(expired, flow.review, flow.artifact), /block|expire/);
  }
});

test("preflight checks every declared block, execution boundary and fee", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const imported = await importArtifact(node, review, artifact);
  node.state.preflight = preflightOf(artifact);
  assert.equal((await tools.preflight(node.client, imported)).verification, "Succeed");
  const changes = [
    { hash: "0x" + "00".repeat(32) },
    { network: 124 },
    { verification: "Failed" },
    { state: "FAULT" },
    { relayed: true },
    { mempoolChecked: true },
    { minimumrequiredfee: "201" },
    { minimumrequiredfee: undefined },
  ];
  for (const change of changes) {
    const faulted = preflightOf(artifact, change);
    node.state.preflight = faulted;
    await assert.rejects(tools.preflight(node.client, imported));
  }
  for (const simulation of [
    { mode: "application-only" },
    { height: 99 },
    { height: 100.5 },
    { onPersist: "FAULT" },
    { view: 1 },
    { transactionCount: 2 },
    { primaryIndex: -1 },
    { timestamp: "18446744073709551616" },
    { nextConsensus: "0x" + "AA".repeat(20) },
  ]) {
    node.state.preflight = preflightOf(artifact, {
      simulation: { ...preflightOf(artifact).simulation, ...simulation },
    });
    await assert.rejects(tools.preflight(node.client, imported));
  }
  node.state.preflight = preflightOf(artifact, { snapshot: { height: "99", hash: "0x" + "aa".repeat(32) } });
  await assert.rejects(tools.preflight(node.client, imported));
});

test("preflight keeps the node's structured error and never submits", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const imported = await importArtifact(node, review, artifact);
  node.state.preflight = () => {
    const error = new Error("method unavailable");
    error.code = -32601;
    error.data = { method: "invoketransaction" };
    throw error;
  };
  await assert.rejects(tools.broadcast(node.client, imported), (error) => {
    assert.equal(error.code, -32601);
    assert.deepEqual(error.data, { method: "invoketransaction" });
    assert.equal(error.submissionAttempted, false);
    assert.equal(error.txid, imported.txid);
    return /preflight unavailable/.test(error.message);
  });
  assert.equal(node.calls.some((call) => call.method === "sendrawtransaction"), false);
});

test("broadcast preflights freshly, sends the identical bytes once and dedupes concurrent calls", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const imported = await importArtifact(node, review, artifact);
  node.state.preflight = preflightOf(artifact);
  node.calls.length = 0;
  const [a, b] = await Promise.all([
    tools.broadcast(node.client, imported),
    tools.broadcast(node.client, imported),
  ]);
  assert.deepEqual(a, { txid: imported.txid, submitted: true, confirmed: false });
  assert.equal(a, b);
  const sends = node.calls.filter((call) => call.method === "sendrawtransaction");
  assert.equal(sends.length, 1);
  assert.equal(Buffer.from(sends[0].params[0], "base64").toString("hex"), imported.rawTransaction);
  assert.equal(node.calls.filter((call) => call.method === "invoketransaction").length, 1);
});

test("a review invalidated during preflight blocks the send", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const imported = await importArtifact(node, review, artifact);
  let current = true;
  node.state.preflight = async () => {
    current = false;
    return preflightOf(artifact);
  };
  await assert.rejects(
    tools.broadcast(node.client, imported, {
      assertCurrent() {
        if (!current) throw Error("review changed");
      },
    }),
    (error) => {
      assert.equal(error.submissionAttempted, false);
      assert.equal(error.txid, imported.txid);
      return /review changed/.test(error.message);
    },
  );
  assert.equal(node.calls.some((call) => call.method === "sendrawtransaction"), false);
});

test("an uncertain submission is never retried, even after reimport", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const imported = await importArtifact(node, review, artifact);
  node.state.preflight = preflightOf(artifact);
  node.state.send = new Error("timeout");
  const check = (error) =>
    /timeout/.test(error.message) &&
    error.submissionAttempted === true &&
    error.txid === imported.txid;
  await assert.rejects(tools.broadcast(node.client, imported), check);
  await assert.rejects(tools.broadcast(node.client, await importArtifact(node, review, artifact)), check);
  assert.equal(node.calls.filter((call) => call.method === "sendrawtransaction").length, 1);
  // A node that answers with somebody else's hash is not this transaction.
  const other = createNode();
  const flow = await registrationReview(other);
  const fresh = await importArtifact(other, flow.review, flow.artifact);
  other.state.preflight = preflightOf(flow.artifact);
  other.state.send = { hash: "0x" + "00".repeat(32) };
  await assert.rejects(tools.broadcast(other.client, fresh), /different transaction id/);
});

test("a receipt compares the persisted bytes and refuses identity drift", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const imported = await importArtifact(node, review, artifact);
  confirmed(node, artifact);
  node.client.revalidatePlan = async () => {
    throw Error("account already registered after execution");
  };
  const receipt = await tools.receipt(node.client, imported);
  assert.equal(receipt.confirmed, true);
  assert.equal(receipt.succeeded, true);
  assert.equal(receipt.txid, imported.txid);
  assert.equal(receipt.systemFee, "200");
  node.state.wire = Buffer.from("00", "hex").toString("base64");
  await assert.rejects(tools.receipt(node.client, imported), /persisted transaction bytes/);
  node.state.wire = Buffer.from(artifact.rawTransaction, "hex").toString("base64");
  node.state.log.txid = "0x" + "00".repeat(32);
  await assert.rejects(tools.receipt(node.client, imported), /log transaction identity/);
  node.state.log.txid = artifact.txid;
  node.state.tx.hash = "0x" + "00".repeat(32);
  await assert.rejects(tools.receipt(node.client, imported), /identity mismatch/);
});

test("a FAULT or a refused transfer is never reported as success", async () => {
  const node = createNode();
  node.setAccount({ custody: wallet().account });
  const { artifact, review } = await executionReview(node);
  const imported = await importArtifact(node, review, artifact);
  for (const execution of [
    { vmstate: "FAULT" },
    { stack: [{ type: "Boolean", value: false }] },
    { stack: [] },
    { stack: [{ type: "Boolean", value: "true" }] },
  ]) {
    confirmed(node, artifact, execution);
    const receipt = await tools.receipt(node.client, imported);
    assert.equal(receipt.confirmed, true);
    assert.equal(receipt.succeeded, false);
    assert.ok(receipt.failures.length);
  }
  confirmed(node, artifact, {});
  assert.equal((await tools.receipt(node.client, imported)).succeeded, true);
});

test("a receipt cannot claim confirmation from a zero block hash or invalid confirmations", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const imported = await importArtifact(node, review, artifact);
  confirmed(node, artifact);
  for (const confirmations of [0, -1, 0.5, "1", null, 9007199254740992]) {
    node.state.tx.confirmations = confirmations;
    await assert.rejects(tools.receipt(node.client, imported), /invalid confirmations/);
  }
  delete node.state.tx.confirmations;
  node.state.tx.blockhash = "0x" + "00".repeat(32);
  await assert.rejects(tools.receipt(node.client, imported), /zero block hash/);
  node.state.tx.blockhash = "0x" + "cc".repeat(32);
  assert.equal((await tools.receipt(node.client, imported)).confirmed, true);
  node.state.tx = { hash: artifact.txid };
  assert.deepEqual(await tools.receipt(node.client, imported), {
    txid: imported.txid,
    confirmed: false,
  });
});

test("a receipt-only restoration survives execution and expiry but cannot preflight or broadcast", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const imported = await importArtifact(node, review, artifact);
  confirmed(node, artifact);
  node.state.height = 1000;
  node.client.revalidatePlan = async () => {
    throw Error("old account state no longer exists");
  };
  const restored = await tools.restoreForReceipt(
    node.client,
    JSON.stringify(review),
    JSON.stringify(artifact),
  );
  assert.equal(restored.receiptOnly, true);
  assert.equal((await tools.receipt(node.client, restored)).succeeded, true);
  await assert.rejects(tools.preflight(node.client, restored), /receipt-only/);
  await assert.rejects(tools.broadcast(node.client, restored), /receipt-only/);
  assert.equal(
    node.calls.some((call) => ["invoketransaction", "sendrawtransaction"].includes(call.method)),
    false,
  );
  // A receipt-only object is transport-issued provenance, not a flag.
  await assert.rejects(tools.broadcast(node.client, { ...restored, receiptOnly: false }), /must be imported/);
});

test("an archived review must replay its own recipe byte for byte", async () => {
  const node = createNode();
  const { artifact, review, custody } = await registrationReview(node);
  confirmed(node, artifact);
  node.client.revalidatePlan = async () => {
    throw Error("old account state no longer exists");
  };
  const changes = [
    (r) => {
      r.recipe.input.custodyAddress = "44".repeat(20);
    },
    (r) => {
      r.recipe.input.salt = "55".repeat(32);
    },
    (r) => {
      r.recipe.method = "buildExecutionScript";
    },
    (r) => {
      r.plan.script += "40";
    },
    (r) => {
      r.plan.method = "freezeAccount";
    },
    (r) => {
      r.signers[1].allowedcontracts = ["0x" + "44".repeat(20)];
    },
    (r) => {
      r.feePayer = "44".repeat(20);
    },
    (r) => {
      r.profile.implementationId = "org.r3e.neo.smart-account.v4";
    },
  ];
  for (const change of changes) {
    const archive = clone(review);
    change(archive);
    await assert.rejects(
      tools.restoreForReceipt(node.client, JSON.stringify(archive), JSON.stringify(artifact)),
    );
  }
  // Unsigned labels in an archive are not authenticated, so they are dropped.
  const archive = clone(review);
  archive.description = "Invented successful result";
  archive.plan.accountState = { custodyAddress: custody.account, status: "Active" };
  const restored = await tools.restoreForReceipt(
    node.client,
    JSON.stringify(archive),
    JSON.stringify(artifact),
  );
  assert.equal(restored.review.description, undefined);
  assert.equal(restored.review.plan.accountState, undefined);
  // A live profile that moved cannot inherit an old receipt.
  const moved = clone(artifact);
  moved.profile.implementationId = "NativeSmartAccount/v5";
  await assert.rejects(tools.restoreForReceipt(node.client, JSON.stringify(review), JSON.stringify(reseal(moved))));
});

test("provenance cannot be rebuilt by object casting", async () => {
  const node = createNode();
  const { artifact, review } = await registrationReview(node);
  const imported = await importArtifact(node, review, artifact);
  node.state.preflight = preflightOf(artifact);
  await assert.rejects(tools.preflight(node.client, clone(imported)), /must be imported/);
  await assert.rejects(tools.receipt({ ...node.client }, imported));
  // The same bytes imported by another client instance are not this client's.
  const other = createNode();
  await assert.rejects(tools.preflight(other.client, imported), /must be imported/);
});
