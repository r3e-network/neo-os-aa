const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { nativeCodec: c } = require("../src/native");
const v = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../..",
      "docs/proposals/smartaccount-native-profile-v2-vectors.json",
    ),
    "utf8",
  ),
);
const reverse = (hex) => Buffer.from(hex, "hex").reverse().toString("hex");
const accountId = reverse(v.identity.accountIdWire);
const op = {
  targetContract: v.serviceHashDisplay,
  method: v.operation.methodUtf8,
  args: v.operation.args,
  nonce: "0",
  deadline: v.operation.deadline,
  signature: "",
};
const envelopeContext = (v) => ({
  authorityEpoch: v.expectedAuthorityEpoch,
  configurationNonce: v.expectedConfigurationNonce,
});
test("native identity and canonical verification script match independent core vector", () => {
  const actual = c.deriveIdentity({
    networkMagic: 0x12345678,
    custodyAddress: reverse(v.identity.custodyAddressWire),
    salt: v.identity.salt,
  });
  assert.equal(actual.accountId, accountId);
  assert.equal(
    actual.accountAddress,
    v.identity.accountAddressDisplay.slice(2),
  );
  assert.equal(actual.verificationScript, v.identity.verificationScript);
});
test("native operation and envelope match independent VM vectors, not public Struct", () => {
  assert.equal(
    c.serializeOperation(op, true),
    v.operation.canonicalOperationWithoutSignature,
  );
  assert.equal(
    c.buildExecutionScript(
      accountId,
      [op],
      envelopeContext(
        v.applicationEnvelopes.find((x) => x.name === "published-operation"),
      ),
    ),
    v.applicationEnvelopes.find((x) => x.name === "published-operation")
      .applicationScript,
  );
  const base = { ...op, method: "ping", args: [], deadline: "0" };
  assert.equal(
    c.buildExecutionScript(
      accountId,
      [base],
      envelopeContext(v.applicationEnvelopes[0]),
    ),
    v.applicationEnvelopes[0].applicationScript,
  );
  assert.equal(
    c.buildExecutionScript(
      accountId,
      [base, { ...base, nonce: "1" }],
      envelopeContext(v.applicationEnvelopes[1]),
      true,
    ),
    v.applicationEnvelopes[1].applicationScript,
  );
});
test("ABI2 auth domain binds epoch/config while identity version remains one", () => {
  const context = {
    networkMagic: 0x12345678,
    accountId,
    authorityEpoch: "1",
    configurationNonce: "2",
  };
  const expected = Buffer.concat([
    Buffer.from("NeoSmartAccount/UserOperation"),
    Buffer.from([2]),
    Buffer.from(
      "78563412" +
        v.serviceHashWire +
        v.identity.accountIdWire +
        "01000000000000000200000000000000",
      "hex",
    ),
  ]).toString("hex");
  assert.equal(c.authorizationDomain(context), expected);
  assert.notEqual(
    c.operationDigest(context, op),
    c.operationDigest({ ...context, authorityEpoch: "2" }, op),
  );
  assert.notEqual(
    c.operationDigest(context, op),
    c.operationDigest({ ...context, configurationNonce: "3" }, op),
  );
  assert.equal(
    c.operationDigest(context, op),
    c.operationDigest(context, { ...op, signature: "aa" }),
  );
});
test("strict VM Array/Struct/null/Boolean/integer/ByteString preserve types", () => {
  const values = [
    { type: "Struct", value: [] },
    { type: "Array", value: [] },
    { type: "Boolean", value: true },
    { type: "Null" },
    { type: "Integer", value: "-129" },
    { type: "ByteString", value: "aabb" },
  ];
  assert.equal(
    c.serializeValue({ type: "Array", value: values }),
    "40064100400020010021027fff2802aabb",
  );
  assert.equal(c.encodeValue({ type: "Struct", value: [] }), "c6");
  assert.notEqual(
    c.serializeOperation({ ...op, args: [values[0]] }),
    c.serializeOperation({ ...op, args: [values[1]] }),
  );
  for (const value of [
    { type: "Map", value: [] },
    { type: "Boolean", value: 1 },
    { type: "Integer", value: 1.5 },
    { type: "ByteString", value: "a" },
    { type: "Buffer", value: "aa" },
    { type: "Any", value: 0 },
  ])
    assert.throws(() => c.serializeValue(value));
});
test("native codec enforces VM bounds, aliases/cycles, UTF8, depth/count/size", () => {
  assert.throws(() => c.serializeOperation({ ...op, nonce: 1n << 255n }));
  assert.throws(() => c.serializeOperation({ ...op, deadline: -1 }));
  assert.throws(() => c.serializeOperation({ ...op, method: "\ud800" }));
  assert.throws(() =>
    c.serializeOperation({
      ...op,
      args: Array.from({ length: 65 }, () => ({ type: "Null" })),
    }),
  );
  assert.throws(() =>
    c.serializeOperation({
      ...op,
      args: [{ type: "ByteString", value: "aa".repeat(4096) }],
    }),
  );
  const shared = { type: "Array", value: [] };
  assert.throws(() => c.serializeOperation({ ...op, args: [shared, shared] }));
  const cycle = { type: "Array", value: [] };
  cycle.value.push(cycle);
  assert.throws(() => c.serializeOperation({ ...op, args: [cycle] }));
  let deep = { type: "Null" };
  for (let i = 0; i < 9; i++) deep = { type: "Struct", value: [deep] };
  assert.throws(() => c.serializeOperation({ ...op, args: [deep] }));
  assert.throws(() =>
    c.serializeOperation({ ...op, signature: "aa".repeat(1025) }),
  );
});
test("two dimensional nonce has 191-bit channels and exhaustion sentinel", () => {
  const channel = (1n << 191n) - 1n,
    sequence = (1n << 64n) - 1n;
  assert.deepEqual(c.splitNonce(c.composeNonce(channel, sequence)), {
    channel,
    sequence,
  });
  assert.equal(c.composeNonce(channel, sequence), (1n << 255n) - 1n);
  assert.throws(() => c.composeNonce(1n << 191n, 0));
  assert.throws(() => c.composeNonce(0, 1n << 64n));
  assert.throws(() => c.composeNonce(0, Number.MAX_SAFE_INTEGER + 1));
});

test("all independently generated ABI2 authorization control vectors match including maximum epochs", () => {
  for (const vector of [
    ...v.authorizationControls,
    { ...v.operation, authorizationDomain: v.operation.authorizationDomain },
  ]) {
    const context = {
      networkMagic: 0x12345678,
      accountId,
      authorityEpoch: vector.authorityEpoch,
      configurationNonce: vector.configurationNonce,
    };
    assert.equal(c.operationPreimage(context, op), vector.authorizationMessage);
    assert.equal(c.operationDigest(context, op), vector.authorizationDigest);
    if (vector.authorizationDomain)
      assert.equal(c.authorizationDomain(context), vector.authorizationDomain);
  }
});
test("max nested Struct depth survives complete envelope without adding wrapper depth", () => {
  let arg = { type: "Null" };
  for (let i = 0; i < 8; i++) arg = { type: "Struct", value: [arg] };
  assert.ok(
    c.buildExecutionScript(accountId, [{ ...op, args: [arg] }], {
      authorityEpoch: 0,
      configurationNonce: 0,
    }),
  );
});
test("native execution requires explicit epoch commitments even for witness-only operations", () => {
  assert.throws(() => c.buildExecutionScript(accountId, [op]), /epoch|integer/);
  const context = { authorityEpoch: 7, configurationNonce: 11 };
  const script = c.buildExecutionScript(accountId, [op], context);
  assert.notEqual(
    script,
    c.buildExecutionScript(accountId, [op], { ...context, authorityEpoch: 8 }),
  );
  assert.notEqual(
    script,
    c.buildExecutionScript(accountId, [op], {
      ...context,
      configurationNonce: 12,
    }),
  );
  assert.throws(() =>
    c.buildExecutionScript(accountId, [op], {
      authorityEpoch: 1n << 64n,
      configurationNonce: 11,
    }),
  );
});
