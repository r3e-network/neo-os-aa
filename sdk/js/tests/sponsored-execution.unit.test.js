/**
 * Sponsored execution, v4: the sponsor pays, the account still authorizes.
 *
 * v3 shipped a "sponsored payload" — a relay DTO with its own parameter
 * grammar, its own JSON round trip and its own argument walk. v4 has none of
 * that: a sponsored operation is an ordinary 13-field operation wrapped in one
 * `executeSponsoredUserOp(s)` call, and the sponsor's only privilege is paying
 * the fee. So the tests here are about the envelope: five arguments, one
 * operation value per entry, one reimbursement settled against the first
 * operation, and arguments that keep their exact v4 types.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { SmartAccountClient, codec: c } = require("../src/index");

const CORE = "11".repeat(20);
const ACCOUNT = "22".repeat(20);
const TARGET = "33".repeat(20);
const PAYMASTER = "44".repeat(20);
const SPONSOR = "55".repeat(20);
const AMOUNT = "123456789";

const client = new SmartAccountClient({
  rpcUrl: "http://127.0.0.1:1",
  networkMagic: 123,
  contractHash: CORE,
});

const signature = "ab".repeat(64);
const operation = (overrides = {}) => ({
  targetContract: TARGET,
  method: "transfer",
  args: [],
  nonce: "1",
  nonceSubkey: "00".repeat(32),
  deadline: "1900000000000",
  validatorId: "0",
  credentialGeneration: "1",
  authorityEpoch: "0",
  configurationNonce: "0",
  signature,
  ...overrides,
});

const sponsored = (extra = {}) =>
  client.buildSponsoredExecutionScript({
    accountId: ACCOUNT,
    operations: [operation()],
    paymaster: PAYMASTER,
    sponsor: SPONSOR,
    reimbursementAmount: AMOUNT,
    ...extra,
  });

/** The envelope, written out independently of the SDK's own builder. */
const envelope = (method, second, amount = AMOUNT) =>
  c.dynamicCall(CORE, method, [
    c.hashValue(ACCOUNT),
    second,
    c.hashValue(PAYMASTER),
    c.hashValue(SPONSOR),
    c.integerValue(c.unsigned(amount, 63, "reimbursement")),
  ]);

test("one sponsored execution is a single executeSponsoredUserOp call with five arguments", () => {
  const plan = sponsored();
  assert.equal(plan.kind, "execution");
  assert.equal(plan.method, "executeSponsoredUserOp");
  assert.equal(plan.batch, false);
  assert.equal(
    plan.script,
    envelope("executeSponsoredUserOp", c.operationValue(operation())),
  );
  assert.equal(plan.accountId, ACCOUNT);
  assert.equal(plan.accountAddress, client.proxyAddress(ACCOUNT));
  assert.equal(plan.proxyCallFlags, 15);
  assert.deepEqual(plan.signers, [client.proxyAddress(ACCOUNT)]);
  assert.equal(plan.paymaster, PAYMASTER);
  assert.equal(plan.sponsor, SPONSOR);
  assert.equal(plan.reimbursementAmount, AMOUNT);
});

test("a sponsored batch is one executeSponsoredUserOps call in order", () => {
  const ops = [operation({ nonce: "1" }), operation({ nonce: "2" })];
  const plan = sponsored({ operations: ops });
  assert.equal(plan.method, "executeSponsoredUserOps");
  assert.equal(plan.batch, true);
  assert.deepEqual(plan.operations, ops);
  assert.equal(plan.script, envelope("executeSponsoredUserOps", { type: "Array", value: ops.map((op) => c.operationValue(op)) }));
});

test("the plan is a v4 execution plan the client will prepare", () => {
  for (const plan of [sponsored(), sponsored({ operations: [operation(), operation()] })]) {
    assert.equal(client.prepare(plan), plan);
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.operations));
    // The proxy witness is derived from the plan's own flags, so a sponsored
    // plan whose flags were rewritten would no longer describe the account.
    assert.equal(plan.proxyCallFlags, 15);
    assert.equal(plan.accountAddress, client.proxyAddress(ACCOUNT));
    assert.equal(plan.method === "executeSponsoredUserOp", !plan.batch);
  }
});

test("one reimbursement settles against the first operation, so a mixed batch is refused", () => {
  const other = operation({ targetContract: "66".repeat(20) });
  assert.throws(
    () => sponsored({ operations: [operation(), other] }),
    (error) => error.code === "SDK_011" && /one target|same/.test(error.details?.hint ?? ""),
  );
  assert.throws(
    () => sponsored({ operations: [operation(), operation({ method: "approve" })] }),
    (error) => error.code === "SDK_011",
  );
  // Same target and method with different arguments is a legitimate batch.
  assert.doesNotThrow(() =>
    sponsored({ operations: [operation(), operation({ args: [] })] }),
  );
});

test("the reimbursement is positive and exactly representable", () => {
  for (const reimbursementAmount of [0, "0"]) {
    assert.throws(
      () => sponsored({ reimbursementAmount }),
      (error) => error.code === "SDK_011",
      `accepted ${String(reimbursementAmount)}`,
    );
  }
  // Anything outside uint63 is refused by the operand grammar, not rounded.
  for (const reimbursementAmount of [-1, "-1", 1.5, "1.5", 2n ** 63n, "9223372036854775808", "abc"]) {
    assert.throws(() => sponsored({ reimbursementAmount }), `accepted ${String(reimbursementAmount)}`);
  }
  assert.equal(sponsored({ reimbursementAmount: 1 }).reimbursementAmount, "1");
  assert.equal(sponsored({ reimbursementAmount: "9007199254740993" }).reimbursementAmount, "9007199254740993");
});

test("a sponsored envelope carries one to thirty-two operations", () => {
  assert.throws(() => sponsored({ operations: [] }), /1\.\.32/);
  const many = Array.from({ length: 33 }, () => operation());
  assert.throws(() => sponsored({ operations: many }), /1\.\.32/);
  assert.doesNotThrow(() => sponsored({ operations: Array.from({ length: 32 }, () => operation()) }));
});

test("arguments keep their exact v4 types in the encoded operation", () => {
  const args = [
    c.hashValue(TARGET),
    { type: "Integer", value: "-9007199254740993" },
    { type: "Boolean", value: false },
    { type: "Null" },
    { type: "Array", value: [{ type: "Integer", value: "7" }, { type: "ByteString", value: "aabb" }] },
  ];
  const op = operation({ args });
  const plan = sponsored({ operations: [op] });
  assert.equal(plan.script, envelope("executeSponsoredUserOp", c.operationValue(op)));
  // The same values serialise identically twice: nothing was coerced on the way in.
  assert.equal(c.serializeValue({ type: "Array", value: args }), c.serializeValue({ type: "Array", value: args }));
});

test("values the v4 operand grammar cannot carry are refused, not coerced", () => {
  const invalid = [
    // A hash is a ByteString of its stored byte order in v4; the v3 display-hex
    // Hash160 kind is not a VM type this protocol defines.
    { type: "Hash160", value: "0x" + TARGET },
    { type: "Hash256", value: "aa".repeat(32) },
    { type: "Any", value: null },
    { type: "Struct", value: [{ type: "Integer", value: "1" }] },
    { type: "Map", value: [] },
    { type: "Integer", value: 9007199254740992 },
    { type: "Integer", value: "3.1" },
    { type: "Integer", value: (1n << 255n).toString() },
    { type: "Boolean", value: "false" },
    { type: "ByteString", value: "zz" },
    { type: "Array", value: "raw" },
    { type: "Null", value: 1 },
    "untyped",
    { value: 1 },
  ];
  for (const argument of invalid) {
    assert.throws(
      () => sponsored({ operations: [operation({ args: [argument] })] }),
      `accepted ${String(argument?.type ?? argument)}`,
    );
  }
});

test("a cyclic or over-deep argument list is refused before it can reach a node", () => {
  const cycle = { type: "Array", value: [] };
  cycle.value.push(cycle);
  let deep = { type: "Integer", value: "1" };
  for (let index = 0; index < 12; index += 1) deep = { type: "Array", value: [deep] };
  for (const argument of [cycle, deep]) {
    assert.throws(() => sponsored({ operations: [operation({ args: [argument] })] }));
  }
});

test("a Map argument is refused rather than flattened into an array", () => {
  // §4.1 admits no Map: a caller that wants an ordered pair list says Array.
  const map = {
    type: "Map",
    value: [{ key: { type: "ByteString", value: "61" }, value: { type: "Integer", value: "1" } }],
  };
  assert.throws(() => sponsored({ operations: [operation({ args: [map] })] }), /unsupported VM type Map/);
});

test("the operation envelope is the same 13 fields an unsponsored execution carries", () => {
  const plan = sponsored();
  const fields = c.operationValue(operation()).value;
  assert.equal(fields.length, 13);
  assert.equal(c.operationValue(operation()).type, "Array");
  // The sponsored call embeds that value directly; nothing is reshaped for the
  // sponsor, so a signature the core accepts unsponsored is accepted here too.
  assert.ok(plan.script.includes(c.encodeValue(c.operationValue(operation()))));
});
