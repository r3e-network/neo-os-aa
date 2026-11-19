/**
 * The v4 operation builder: one shape, checked by the one serializer.
 *
 * The builder is offline by design — it composes the packed channel nonce,
 * refuses out-of-range fields, and hands out exactly the value the core
 * serializes. These tests pin it to the independently generated golden vector,
 * so a builder change that still "looks right" cannot change what a signature
 * covers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  UserOperationBuilder,
  createUserOpBuilder,
  codec,
  PROTOCOL_VERSION,
} = require('../src/index');

const vectors = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../..', 'tests/SmartAccount.Native.Tests/TestFile/smartaccount-v4-vectors.json'),
    'utf8',
  ),
);
const strip = (hash) => hash.replace(/^0x/i, '');
const NETWORK = vectors.network;
const CORE = strip(vectors.serviceHash);
const ACCOUNT_ID = strip(vectors.accountId);
const CUSTODY = strip(vectors.custody);
const ZERO_SUBKEY = '00'.repeat(32);
const DEADLINE = '1700000000000';

/**
 * The SDK keeps one message per failure class and puts the specific reason in
 * `details.hint`, so both are asserted: the code is what a caller switches on.
 */
const throws = (fn, code, hint, label) =>
  assert.throws(
    fn,
    (error) => {
      assert.equal(error.code, code, label);
      if (hint) assert.match(error.details?.hint ?? '', hint, label);
      return true;
    },
    label,
  );

/** The vector operation, expressed through the fluent builder. */
function builder(vector = vectors) {
  return createUserOpBuilder({
    networkMagic: vector.network,
    coreContractHash: strip(vector.serviceHash),
    accountId: strip(vector.accountId),
  })
    .setTarget(strip(vector.serviceHash))
    .setMethod('ping')
    .setArgs([])
    .setRouting({
      validatorId: 0,
      credentialGeneration: 0,
      authorityEpoch: 1,
      configurationNonce: 0,
    })
    .setNonceSubkey(ZERO_SUBKEY)
    .setNonce(0)
    .setDeadline(DEADLINE);
}

test('the builder reproduces the golden vector byte for byte', () => {
  const op = builder();
  assert.equal(op.serialize(), vectors.operation.canonical);
  assert.equal(op.digest(), vectors.operation.digest);
  const operation = op.build();
  assert.equal(operation.nonce, '0');
  assert.equal(operation.validatorId, '0');
  assert.equal(operation.credentialGeneration, '0');
  assert.equal(operation.authorityEpoch, '1');
  assert.equal(operation.configurationNonce, '0');
  assert.equal(Object.isFrozen(operation), true);
  // The value handed to a script is the same thirteen fields, not a copy of
  // the RPC shape.
  const value = op.toValue();
  assert.equal(value.type, 'Array');
  assert.equal(value.value.length, 13);
  assert.equal(codec.serializeValue(value), vectors.operation.canonical);
});

test('a different chain changes the digest but not the operation bytes', () => {
  const here = builder();
  const elsewhere = builder({ ...vectors, network: vectors.network + 1 });
  assert.equal(elsewhere.serialize(), here.serialize());
  assert.notEqual(elsewhere.digest(), here.digest());
  // The domain is versioned too: a v3 client cannot produce this digest.
  assert.equal(PROTOCOL_VERSION, 4);
});

test('every routing field is bound into both the body and the domain', () => {
  const base = builder();
  const variants = {
    validatorId: 1,
    credentialGeneration: 1,
    authorityEpoch: 2,
    configurationNonce: 1,
  };
  for (const [field, value] of Object.entries(variants)) {
    const changed = builder().setRouting({ [field]: value });
    assert.notEqual(changed.digest(), base.digest(), `${field} must change the digest`);
    assert.notEqual(changed.serialize(), base.serialize(), `${field} is a body field`);
  }
  // A different subkey keeps the body's routing but moves the channel, so the
  // packed nonce of the same sequence lands in another namespace.
  const otherSubkey = builder().setNonceSubkey('ee'.repeat(32));
  assert.notEqual(otherSubkey.nonceChannel(), base.nonceChannel());
  assert.notEqual(otherSubkey.digest(), base.digest());
});

test('arguments are typed VM values, not JavaScript values', () => {
  const op = builder().setArgs([
    { type: 'ByteString', value: 'ab'.repeat(20) },
    { type: 'Integer', value: '42' },
    { type: 'Boolean', value: true },
    { type: 'Null' },
    { type: 'Array', value: [{ type: 'Integer', value: '-1' }] },
  ]);
  assert.doesNotThrow(() => op.build());
  for (const bad of [
    { type: 'Hash160', value: 'ab'.repeat(20) },
    { type: 'Map', value: [] },
    { type: 'Buffer', value: '00' },
    { type: 'Integer', value: 1.5 },
    { type: 'Boolean', value: 'true' },
  ]) {
    assert.throws(() => builder().setArgs([bad]).build(), undefined, JSON.stringify(bad));
  }
  // A plain JavaScript array is a shape error, not an implicit conversion.
  assert.throws(() => builder().setArgs(['transfer']).build());
  throws(() => builder().setArgs('transfer'), 'SDK_011', /args must be an array/);
});

test('required fields fail closed with the SDK vocabulary', () => {
  // Every field except the one under test is present, so a row proves that one
  // field alone is required. setRouting has no unset, so a required routing
  // field can only be absent by never being set.
  const routed = (omit) => {
    const op = createUserOpBuilder({ networkMagic: NETWORK, coreContractHash: CORE, accountId: ACCOUNT_ID })
      .setTarget(CUSTODY)
      .setMethod('ping')
      .setArgs([])
      .setNonceSubkey(ZERO_SUBKEY)
      .setNonce(0)
      .setDeadline(DEADLINE);
    const routing = { validatorId: 0, credentialGeneration: 0, authorityEpoch: 1, configurationNonce: 0 };
    for (const [field, value] of Object.entries(routing)) {
      if (field !== omit) op.setRouting({ [field]: value });
    }
    return op;
  };
  const cases = [
    ['target', routed().setTarget(undefined), 'SDK_011', /target contract is required/],
    ['method', routed().setMethod(undefined), 'SDK_011', /method is required/],
    ['nonce', routed().setNonce(undefined), 'SDK_008', null],
    ['deadline', routed().setDeadline(undefined), 'SDK_009', null],
    ['subkey', routed().setNonceSubkey(undefined), 'SDK_011', /nonce subkey is required/],
    ['epoch', routed('authorityEpoch'), 'SDK_011', /authority epoch is required/],
    ['configuration', routed('configurationNonce'), 'SDK_011', /configuration nonce is required/],
    ['nonce width', routed().setNonce(codec.composeNonce(0, 0) + (1n << 300n)), 'SDK_011', /nonce/],
  ];
  for (const [label, op, code, hint] of cases) {
    throws(() => op.build(), code, hint === null ? null : hint, label);
  }
});

test('a composed nonce is channel << 64 | sequence, and both widths hold', () => {
  const channel = builder().nonceChannel();
  assert.equal(builder().setNonceSequence({ channel, sequence: 7 }).build().nonce, (BigInt(channel) << 64n | 7n).toString());
  assert.equal(codec.splitNonce(builder().setNonceSequence({ channel, sequence: 7 }).build().nonce).sequence, 7n);
  // The channel is 191 bits and the sequence 64: neither can overflow.
  throws(() => builder().setNonceSequence({ channel: 1n << 191n, sequence: 0 }), 'VP_002', /nonce channel/);
  throws(() => builder().setNonceSequence({ channel: 0, sequence: 1n << 64n }), 'VP_002', /nonce sequence/);
});

test('autoNonce awaits both a synchronous and an asynchronous loader', async () => {
  const channel = builder().nonceChannel();
  const seen = [];
  await builder().autoNonce((routing) => {
    seen.push(routing.channel);
    return { sequence: 3 };
  });
  const sync = await builder().autoNonce((routing) => ({ sequence: routing.channel === channel ? 4 : 0 }));
  assert.equal(sync.build().nonce, (BigInt(channel) << 64n | 4n).toString());
  assert.deepEqual(seen, [channel]);
  // A loader may return the packed nonce itself; it is used verbatim.
  const packed = await builder().autoNonce(async () => ({ nonce: (BigInt(channel) << 64n | 9n).toString() }));
  assert.equal(packed.build().nonce, (BigInt(channel) << 64n | 9n).toString());
  await assert.rejects(() => builder().autoNonce(), (error) => error.code === 'SDK_011');
});

test('autoDeadline is Runtime.Time milliseconds ahead, never behind', () => {
  const before = Date.now();
  const deadline = BigInt(builder().autoDeadline(60_000).build().deadline);
  assert.ok(deadline >= BigInt(before + 60_000));
  assert.ok(deadline <= BigInt(Date.now() + 60_000));
  throws(() => builder().autoDeadline(-1), 'VP_001', /buffer must be nonnegative ms/);
});

test('clone is independent, toJSON is a snapshot and reset keeps identity', () => {
  const original = builder().setArgs([{ type: 'Integer', value: '1' }]);
  const copy = original.clone().addArg({ type: 'Integer', value: '2' });
  assert.equal(original.toJSON().args.length, 1);
  assert.equal(copy.toJSON().args.length, 2);
  assert.equal(original.build().args.length, 1);

  const snapshot = original.toJSON();
  snapshot.args.push({ type: 'Integer', value: '3' });
  assert.equal(original.build().args.length, 1);

  const reset = original.reset();
  assert.equal(reset.nonceChannel(), original.nonceChannel(), 'identity survives a reset');
  assert.equal(reset.toJSON().args.length, 0);
  assert.equal(reset.toJSON().nonce, undefined);
  assert.equal(reset.toJSON().targetContract, undefined);
  // The account and routing identity are not operation state: a recycled
  // builder keeps its channel instead of silently moving to a new one.
  assert.equal(reset.toJSON().accountId, ACCOUNT_ID);
  assert.equal(reset.toJSON().nonceSubkey, ZERO_SUBKEY);
  assert.equal(reset.toJSON().authorityEpoch, 1);
});

test('the removed v3 builder surface is gone', () => {
  const op = new UserOperationBuilder({ networkMagic: NETWORK, coreContractHash: CORE, accountId: ACCOUNT_ID });
  for (const name of ['setVerifier', 'setChainId', 'setArgsHash', 'setAccountAddressScriptHash', 'setVerifierParams']) {
    assert.equal(name in op, false, `${name} must not exist`);
  }
  // The one custody-shaped helper that remains is setTarget: a v3 verifier hash
  // here is just the target contract, and the digest binds it.
  assert.equal(op.setTarget(CUSTODY).build === undefined, false);
});
