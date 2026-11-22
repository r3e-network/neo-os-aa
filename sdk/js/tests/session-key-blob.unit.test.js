/**
 * Session-key commands, v4: a module command array is an operation operand list.
 *
 * A session key is not a registration blob any more. It is a SessionKeyValidator
 * instance whose `initData`/`configData` is the command array the validator
 * parses, and that array travels as the `initData` of an `installModule` account
 * action — which means it is a v4 operation operand and must obey §4.1:
 * `Null`, `Boolean`, `Integer`, `ByteString` and `Array` only. A string is a
 * UTF-8 `ByteString`; a `UInt160` is a `ByteString` of its stored byte order.
 * The v3 `Hash160`/`String` spelling cannot enter an operation at all, which is
 * what the first tests pin.
 *
 * The rest mirrors the validator's own asserts, so a malformed command fails in
 * the SDK with a `SESSION_KEY_INVALID` error instead of reverting on chain.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NativeSmartAccountClient,
  codec: c,
  buildSessionKeyInstallCommand,
  buildSessionKeyClearCommand,
  buildSessionKeyPermission,
  SESSION_KEY_INSTALL_COMMAND,
  SESSION_KEY_CLEAR_COMMAND,
  MAX_SESSION_KEY_DESCRIPTION_BYTES,
  MAX_SESSION_DURATION_MS,
} = require("../src/index");

const CORE = "11".repeat(20);
const ACCOUNT = "22".repeat(20);
const TARGET = "33".repeat(20);
const MODULE = "44".repeat(20);
const MODULE_ID = 3;
const PUBKEY = "02" + "5a".repeat(32);
const VALID_UNTIL = 1900000000000;

// Configuration action codes and module types are protocol constants (§9); the
// test writes them out rather than importing names the contract never exposes.
const MODULE_TYPE_VALIDATOR = 1;

const I = (value) => ({ type: "Integer", value: String(value) });
const A = (...value) => ({ type: "Array", value });
const TEXT = (text) => ({ type: "ByteString", value: Buffer.from(String(text), "utf8").toString("hex") });
const BYTES = (hex) => ({ type: "ByteString", value: hex });
const HASH = (displayHex) => ({
  type: "ByteString",
  value: Buffer.from(String(displayHex).replace(/^0x/i, ""), "hex").reverse().toString("hex"),
});

const client = new NativeSmartAccountClient({
  rpcClient: { send: async () => ({}) },
  networkMagic: 123,
  contractHash: CORE,
});

const install = (overrides = {}) =>
  buildSessionKeyInstallCommand({
    publicKeyHex: PUBKEY,
    targetContract: TARGET,
    method: "transfer",
    validUntilMs: VALID_UNTIL,
    spendingLimitDatoshi: 1000,
    description: "session",
    ...overrides,
  });

// Installing a session key is one account action: the core allocates the module
// id and the command array is the initData the validator parses on chain.
const installSessionKey = (command) =>
  client.buildAccountActionScript({
    method: "installModule",
    accountId: ACCOUNT,
    args: [I(MODULE_TYPE_VALIDATOR), HASH(MODULE), A(...command)],
  });

test("setSessionKey is seven operands a v4 operation can carry", () => {
  const command = install();
  assert.equal(command.length, 7);
  assert.deepEqual(command, [
    TEXT(SESSION_KEY_INSTALL_COMMAND),
    BYTES(PUBKEY),
    HASH(TARGET),
    TEXT("transfer"),
    I(VALID_UNTIL),
    I(1000),
    TEXT("session"),
  ]);
  // Every entry is an operand §4.1 admits; nothing is a Hash160 or a bare string.
  for (const entry of command) assert.ok(["ByteString", "Integer"].includes(entry.type));
  assert.deepEqual(install({ targetContract: "0x" + TARGET }), command);
});

test("clearSessionKey is one operand", () => {
  const command = buildSessionKeyClearCommand();
  assert.deepEqual(command, [TEXT(SESSION_KEY_CLEAR_COMMAND)]);
  assert.equal(command.length, 1);
});

test("the command encodes to the same bytes twice and inside an install action", () => {
  const command = install();
  const encoded = c.encodeValue(A(...command));
  assert.equal(encoded, c.encodeValue(A(...install())));
  // The install script carries that very encoding: the command the caller built
  // is the command the chain deserialises.
  assert.ok(installSessionKey(command).script.includes(encoded));
  // The array is also a legal operand of an execution operation.
  const plan = client.buildExecutionScript({
    accountId: ACCOUNT,
    operations: [{
      targetContract: TARGET,
      method: "configure",
      args: [A(...command)],
      nonce: "1",
      nonceSubkey: "00".repeat(32),
      deadline: VALID_UNTIL,
      validatorId: "0",
      credentialGeneration: "1",
      authorityEpoch: "0",
      configurationNonce: "0",
      signature: "ab".repeat(64),
    }],
  });
  assert.ok(plan.script.includes(encoded));
});

test("installing and clearing a session key are two custody-gated account plans", () => {
  const command = install();
  const installed = installSessionKey(command);
  const cleared = client.buildAccountActionScript({
    method: "removeModule",
    accountId: ACCOUNT,
    args: [I(MODULE_ID), A(...buildSessionKeyClearCommand())],
  });
  assert.deepEqual([installed.method, cleared.method], ["installModule", "removeModule"]);
  for (const plan of [installed, cleared]) {
    assert.equal(plan.kind, "account");
    assert.equal(plan.accountId, ACCOUNT);
    // The account is the plan's only signer: the core checks the custody
    // witness, not an authority list carried in the plan.
    assert.deepEqual(plan.signers, [client.proxyAddress(ACCOUNT)]);
  }
  // The install names the validator and hands it the whole command as initData;
  // the removal names the id the core allocated and the clear command.
  assert.ok(installed.script.includes(c.encodeValue(A(...command))));
  assert.ok(installed.script.includes(c.encodeValue(HASH(MODULE))));
  assert.ok(cleared.script.includes(c.encodeValue(A(...buildSessionKeyClearCommand()))));
  assert.equal(client.prepare(installed), installed);
});

test("an install action carries the command as initData and never names a module id", () => {
  const command = install();
  const plan = installSessionKey(command);
  assert.ok(plan.script.includes(c.encodeValue(A(...command))));
  assert.ok(plan.script.includes(c.encodeValue(I(MODULE_TYPE_VALIDATOR))));
  // Module ids are the core's to allocate, so an install script carries none.
  assert.equal(plan.script.includes(c.encodeValue(I(MODULE_ID))), false);
});

test("a public key is 33 compressed or 65 uncompressed bytes", () => {
  assert.doesNotThrow(() => install({ publicKeyHex: "03" + "5a".repeat(32) }));
  assert.doesNotThrow(() => install({ publicKeyHex: "04" + "5a".repeat(64) }));
  for (const publicKeyHex of [
    "04" + "5a".repeat(32), // compressed length with an uncompressed prefix
    "02" + "5a".repeat(64), // uncompressed length with a compressed prefix
    "01" + "5a".repeat(32),
    "02" + "5a".repeat(31),
    "",
  ]) {
    assert.throws(
      () => install({ publicKeyHex }),
      (error) => error.code === "SESSION_KEY_INVALID",
      `accepted ${publicKeyHex.slice(0, 6)} (${publicKeyHex.length} hex chars)`,
    );
  }
});

test("the target is a nonzero twenty-byte hash", () => {
  for (const targetContract of ["00".repeat(20), "33".repeat(19), "33".repeat(21), "zz".repeat(20), ""]) {
    assert.throws(
      () => install({ targetContract }),
      (error) => error.code === "SESSION_KEY_INVALID",
      `accepted ${targetContract}`,
    );
  }
});

test("the method is 1..255 UTF-8 bytes and the description at most 128", () => {
  assert.doesNotThrow(() => install({ method: "*", spendingLimitDatoshi: 0 }));
  assert.doesNotThrow(() => install({ method: "m".repeat(255), spendingLimitDatoshi: 0 }));
  for (const method of ["", "m".repeat(256), "方".repeat(86)]) {
    assert.throws(() => install({ method, spendingLimitDatoshi: 0 }), (error) => error.code === "SESSION_KEY_INVALID");
  }
  assert.doesNotThrow(() => install({ description: "d".repeat(MAX_SESSION_KEY_DESCRIPTION_BYTES) }));
  assert.doesNotThrow(() => install({ description: "é".repeat(64) }));
  for (const description of ["d".repeat(129), "é".repeat(65)]) {
    assert.throws(() => install({ description }), (error) => error.code === "SESSION_KEY_INVALID");
  }
});

test("the expiry and the spending limit are unsigned 64-bit and the limit is transfer-only", () => {
  for (const validUntilMs of [-1, "1.5", 2n ** 64n, "abc"]) {
    assert.throws(() => install({ validUntilMs }), (error) => error.code === "SESSION_KEY_INVALID");
  }
  for (const spendingLimitDatoshi of [-1, 1.5, 2n ** 64n]) {
    assert.throws(
      () => install({ spendingLimitDatoshi }),
      (error) => error.code === "SESSION_KEY_INVALID",
    );
  }
  // A positive cap on a key that cannot move value would advertise a limit the
  // validator never enforces, so it is refused here exactly as it is on chain.
  for (const method of ["*", "approve"]) {
    assert.throws(
      () => install({ method, spendingLimitDatoshi: 1 }),
      (error) => error.code === "SESSION_KEY_INVALID",
    );
  }
  assert.equal(install({ validUntilMs: (2n ** 64n - 1n).toString() })[4].value, (2n ** 64n - 1n).toString());
  assert.equal(install({ spendingLimitDatoshi: 0 })[5].value, "0");
});

test("the session lifetime cap is the validator's own 30 days", () => {
  assert.equal(MAX_SESSION_DURATION_MS, 30 * 24 * 60 * 60 * 1000);
});

test("the 7715 permission envelope mirrors the command it accompanies", () => {
  const permission = buildSessionKeyPermission({
    publicKeyHex: PUBKEY,
    targetContract: "0x" + TARGET,
    method: "transfer",
    validUntilMs: VALID_UNTIL,
    spendingLimitDatoshi: 1000,
    description: "session",
  });
  assert.deepEqual(permission.installCommand, install());
  assert.equal(permission.permission.signer.type, "key");
  assert.equal(permission.permission.signer.data.publicKey, "0x" + PUBKEY);
  assert.equal(permission.permission.permissions.length, 1);
  assert.equal(permission.permission.permissions[0].type, "contract-call");
  assert.equal(permission.permission.permissions[0].data.address, "0x" + TARGET);
  assert.equal(permission.permission.permissions[0].data.selector, "transfer");
  assert.equal(permission.permission.permissions[0].data.spendingLimit, "1000");
  // 7715 counts expiry in unix seconds; the command keeps Runtime.Time
  // milliseconds, so the two shapes differ in units and never by rounding.
  assert.equal(permission.permission.expiry, Math.floor(VALID_UNTIL / 1000));
  assert.deepEqual(permission.sessionKeyArgs, {
    publicKeyHex: PUBKEY,
    targetContract: TARGET,
    method: "transfer",
    validUntilMs: String(VALID_UNTIL),
    spendingLimitDatoshi: "1000",
    description: "session",
  });
});
