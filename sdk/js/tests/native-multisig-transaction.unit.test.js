const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { NativeSmartAccountClient, nativeCodec: c, NATIVE_ACCOUNT_SERVICE: CORE } = require("../src/native");
const hash160 = (script) => Buffer.from(crypto.createHash("ripemd160").update(crypto.createHash("sha256").update(Buffer.from(script, "hex")).digest()).digest()).reverse().toString("hex");
// Public fixture scalars already used by core AccountManagement Witness (2, 3),
// TransactionCommitment (19) and Clock (41) tests. Never use these test wallets.
function fixtureKey(scalar) {
  const secret = Buffer.alloc(32); secret[31] = scalar;
  const ec = crypto.createECDH("prime256v1"); ec.setPrivateKey(secret);
  const raw = ec.getPublicKey(undefined, "uncompressed");
  const publicKey = ec.getPublicKey(undefined, "compressed").toString("hex");
  const key = crypto.createPrivateKey({ format: "jwk", key: {
    kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"),
    y: raw.subarray(33).toString("base64url"), d: secret.toString("base64url"),
  } });
  const verificationScript = "0c21" + publicKey + "4156e7b327";
  return { publicKey, verificationScript, account: hash160(verificationScript),
    sign(hex) { return crypto.sign("sha256", Buffer.from(hex, "hex"), { key, dsaEncoding: "ieee-p1363" }).toString("hex"); } };
}
const members = [2, 3, 19].map(fixtureKey);
const payer = fixtureKey(41);
const point = (key) => crypto.ECDH.convertKey(key, "prime256v1", "hex", "hex", "uncompressed").slice(2);
const ordered = (keys) => [...keys].sort((a, b) => point(a).localeCompare(point(b)));
const pushInt = (n) => n <= 16 ? (0x10 + n).toString(16) : "00" + n.toString(16).padStart(2, "0");
const multiScript = (m, keys) => pushInt(m) + keys.map((key) => "0c21" + key).join("") + pushInt(keys.length) + "419ed0dc3a";
const keys = ordered(members.map((member) => member.publicKey));
const verificationScript = multiScript(2, keys);
const guardianHash = hash160(verificationScript);
const memberFor = (key) => members.find((member) => member.publicKey === key);
const tools = () => require("../../../shared/nativeWalletWitness.mjs").createNativeWalletWitnessTools({ hash160, verify: nodeVerify });
function nodeVerify(publicKey, signature, signData) {
  const raw = crypto.ECDH.convertKey(publicKey, "prime256v1", "hex", undefined, "uncompressed");
  const key = crypto.createPublicKey({ format: "jwk", key: {
    kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url"),
  } });
  return crypto.verify("sha256", Buffer.from(signData, "hex"), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "hex"));
}
function multisig(selected = members) {
  return { account: guardianHash, verificationScript,
    async sign(data) { return selected.map((member) => ({ publicKey: member.publicKey, signature: member.sign(data) })); } };
}
function transactionFixture(role = "guardian", signer = multisig()) {
  const calls = [];
  let networkFee = "50";
  const client = new NativeSmartAccountClient({ networkMagic: 123, rpcClient: {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "getblockcount") return 100;
      if (method === "calculatenetworkfee") return { networkfee: networkFee };
      throw Error("Unexpected fixture RPC: " + method);
    },
  } });
  let revalidations = 0;
  client.revalidatePlan = async () => { revalidations++; return true; };
  client.simulate = async () => ({ state: "HALT", gasConsumed: "10", minimumRequiredFee: "100", stack: [{ type: "Any", value: null }] });
  const plan = { kind: "lifecycle", accountId: "11".repeat(20),
    method: role === "payer" ? "activateHook" : role === "custody" ? "unfreeze" : "freeze",
    requiredAuthorities: role === "payer" ? [] : [guardianHash],
    script: c.dynamicCall(CORE, "freeze", [c.hashValue("11".repeat(20))]),
  };
  const options = { feePayer: role === "payer" ? signer : payer,
    authoritySigners: role === "payer" ? [] : [signer], nonce: 42,
    maxSystemFee: 1000, maxNetworkFee: 1000, maxTotalFee: 2000 };
  return { client, plan, options, calls, count: () => revalidations, fee(value) { networkFee = value; } };
}
function decode(raw) { return require("@cityofzion/neon-js").tx.Transaction.deserialize(raw).toJson(); }

test("all 2-of-3 guardian quorums prepare, sign and serialize one scoped multisig witness", async () => {
  for (const omitted of members) {
    const selected = members.filter((member) => member !== omitted).reverse();
    const f = transactionFixture("guardian", multisig(selected));
    const prepared = await f.client.prepareTransaction(f.plan, f.options);
    const quoted = decode(Buffer.from(f.calls[1].params[0], "base64").toString("hex"));
    assert.equal(Buffer.from(quoted.witnesses[1].invocation, "base64").length, 2 * 66);
    assert.equal(Buffer.from(quoted.witnesses[1].verification, "base64").toString("hex"), verificationScript);
    assert.equal(prepared.transaction.signers.length, 2);
    assert.deepEqual(prepared.transaction.signers[1], { account: "0x" + guardianHash,
      scopes: "CustomContracts", allowedcontracts: ["0x" + CORE] });
    const signed = await f.client.signTransaction(prepared);
    const tx = decode(signed.rawTransaction);
    assert.equal(tx.witnesses.length, 2);
    const invocation = Buffer.from(tx.witnesses[1].invocation, "base64").toString("hex");
    const selectedKeys = keys.filter((key) => selected.some((member) => member.publicKey === key));
    for (let i = 0; i < 2; i++) assert.equal(nodeVerify(selectedKeys[i], invocation.slice(i * 132 + 4, (i + 1) * 132), prepared.signData), true);
    assert.equal(f.count(), 3);
    assert.equal(Object.isFrozen(signed.witnesses), true);
    assert.equal(signed.witnesses[1].invocation, invocation);
  }
});

test("standard multisig also signs independent payer and custody roles without adding members as signers", async () => {
  for (const role of ["payer", "custody"]) {
    const f = transactionFixture(role);
    const prepared = await f.client.prepareTransaction(f.plan, f.options);
    const signed = await f.client.signTransaction(prepared);
    assert.equal(prepared.transaction.signers.length, role === "payer" ? 1 : 2);
    assert.equal(prepared.transaction.signers[role === "payer" ? 0 : 1].scopes, role === "payer" ? "None" : "CustomContracts");
    assert.equal(decode(signed.rawTransaction).witnesses.length, prepared.transaction.signers.length);
  }
});

test("all submitted signatures are validated before canonical quorum selection", async () => {
  const w = tools(), parsed = w.parse(verificationScript, guardianHash), data = "ab".repeat(36);
  const response = members.map((member) => ({ publicKey: member.publicKey, signature: member.sign(data) }));
  const a = await w.assemble(parsed, response, data), b = await w.assemble(parsed, [...response].reverse(), data);
  assert.deepEqual(a, b);
  assert.equal(a.invocation.length, 264);
  assert.equal(a.invocation, keys.slice(0, 2).map((key) => "0c40" + response.find((item) => item.publicKey === key).signature).join(""));
  for (const invalid of [
    [response[0]], [response[0], response[0]],
    [response[0], { publicKey: payer.publicKey, signature: payer.sign(data) }],
    response.map((item) => item.publicKey === keys[2] ? { ...item, signature: "00".repeat(64) } : item),
    [...response, { publicKey: keys[0], signature: "aa" }],
    "00".repeat(64),
  ]) await assert.rejects(() => w.assemble(parsed, invalid, data));
  await assert.rejects(() => w.assemble(parsed, response, "cd".repeat(36)), /signature/i);
  assert.equal(await w.validate(a, guardianHash, data), true);
  for (const invocation of [a.invocation.slice(132), a.invocation + a.invocation.slice(0, 132),
    a.invocation.slice(132) + a.invocation.slice(0, 132), "0d4000" + a.invocation.slice(4)])
    await assert.rejects(() => w.validate({ ...a, invocation }, guardianHash, data));
  await assert.rejects(() => w.validate(a, payer.account, data), /account|hash/i);
  await assert.rejects(() => w.validate(a, undefined, data), /account/i);
});

test("signing rejects insufficient or bad surplus responses and final witness fee drift", async () => {
  for (const response of [members.slice(0, 1), members]) {
    const adapter = multisig(response);
    if (response.length === 3) adapter.sign = async (data) => members.map((member, index) => ({ publicKey: member.publicKey, signature: index === 2 ? "00".repeat(64) : member.sign(data) }));
    const f = transactionFixture("guardian", adapter);
    const prepared = await f.client.prepareTransaction(f.plan, f.options);
    await assert.rejects(() => f.client.signTransaction(prepared));
  }
  const f = transactionFixture();
  const prepared = await f.client.prepareTransaction(f.plan, f.options);
  f.fee("51");
  await assert.rejects(() => f.client.signTransaction(prepared), /final witness network fee/);
});

test("provider-owned member responses cannot change quorum during asynchronous verification", async () => {
  const data = "12".repeat(36), response = await multisig(members.slice(0, 2)).sign(data);
  let changed = false;
  const w = require("../../../shared/nativeWalletWitness.mjs").createNativeWalletWitnessTools({
    hash160, async verify(key, signature, message) {
      if (!changed) { changed = true; response.length = 0; }
      return nodeVerify(key, signature, message);
    },
  });
  const witness = await w.assemble(w.parse(verificationScript), response, data);
  assert.equal(witness.invocation.length, 264);
  assert.equal(await tools().validate(witness, guardianHash, data), true);
});

test("parser rejects nonstandard, noncanonical, repeated, off-curve and mismatched wallet scripts", () => {
  const w = tools();
  for (const script of ["", "10", verificationScript + "00",
    multiScript(2, [...keys].reverse()), multiScript(2, [keys[0], keys[0], keys[2]]),
    "0002" + verificationScript.slice(2), multiScript(0, keys), multiScript(4, keys),
    multiScript(2, [...keys.slice(0, 2), "02" + "ff".repeat(32)]),
    "0c2102" + "00".repeat(31) + "01" + "4156e7b327",
    "0c21" + "02" + "ff".repeat(32) + "4156e7b327", "0c21" + "00".repeat(33) + "4156e7b327",
  ]) assert.throws(() => w.parse(script));
  assert.throws(() => w.parse(verificationScript, payer.account), /account|hash/i);
  assert.throws(() => w.parse("not hex"));
  assert.equal(w.parse(payer.verificationScript, payer.account).threshold, 1);
});

// Public points only: find compressed curve points without creating private keys.
function publicPoints(count) {
  const result = [];
  for (let x = 0; result.length < count; x++) {
    const candidate = "02" + x.toString(16).padStart(64, "0");
    try { point(candidate); result.push(candidate); } catch { /* not a curve point */ }
  }
  return result;
}
test("1024-byte witness bounds allow 15-of-29 but reject 16 signatures or 30 keys", () => {
  const w = tools(), publicKeys = publicPoints(30);
  const largest = multiScript(15, publicKeys.slice(0, 29));
  assert.equal(largest.length / 2, 1023);
  const parsed = w.parse(largest);
  assert.equal(parsed.publicKeys.length, 29);
  assert.equal(w.placeholder(parsed).invocation.length / 2, 990);
  assert.throws(() => w.parse(multiScript(16, publicKeys.slice(0, 29))), /invocation|limit|1024/i);
  assert.throws(() => w.parse(multiScript(1, publicKeys)), /verification|limit|1024/i);
});

test("point order is Neo X then Y, including opposite points with the same X", () => {
  const w = tools(), key = keys[0], negative = (key.startsWith("02") ? "03" : "02") + key.slice(2);
  const pair = ordered([key, negative]);
  assert.equal(w.parse(multiScript(1, pair)).publicKeys.length, 2);
  assert.throws(() => w.parse(multiScript(1, [...pair].reverse())), /order|canonical/i);
});

test("browser WebCrypto and Node verify identical single and threshold witnesses", async () => {
  const module = require("../../../shared/nativeWalletWitness.mjs");
  const web = module.createNativeWalletWitnessTools({ hash160 });
  const data = "05".repeat(36), signature = payer.sign(data);
  assert.equal(await module.verifyNativeP256Signature(payer.publicKey, signature, data, crypto.webcrypto.subtle), true);
  const single = web.parse(payer.verificationScript, payer.account);
  const witness = await web.assemble(single, signature, data);
  assert.equal(await web.validate(witness, payer.account, data), true);
  await assert.rejects(() => web.assemble(single, [{ publicKey: payer.publicKey, signature }], data));
  await assert.rejects(() => web.assemble(single, "00".repeat(64), data), /signature/i);
  const parsed = web.parse(verificationScript, guardianHash);
  const multi = await web.assemble(parsed, await multisig().sign(data), data);
  assert.equal(await web.validate(multi, guardianHash, data), true);
  const fs = require("node:fs");
  assert.equal(fs.readFileSync(require.resolve("../../../shared/nativeWalletWitness.mjs"), "utf8"), fs.readFileSync(require.resolve("../../../frontend/src/shared/nativeWalletWitness.mjs"), "utf8"));
});
