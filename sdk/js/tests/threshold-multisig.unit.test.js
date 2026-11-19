/**
 * The v4 threshold route (docs/SA-MODULE-PROTOCOL.md §5).
 *
 * v3 resolved child verifiers and serialized a `MultiSigVerifier` array of
 * typed-data signatures. v4 has one threshold mechanism: the operation names a
 * threshold policy in `validatorId`, each member instance signs its own member
 * digest, and field 11 carries the serialized `[[memberModuleId, signature]]`
 * list. The generation in that digest is read from the core, never supplied by
 * the caller, so a rotated member cannot be replayed.
 *
 * The serialized form is checked against an independent encoder here, because
 * the core deserializes field 11 with `StdLib.Deserialize` and rejects anything
 * that is not exactly this shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createThresholdClient,
  serializeMemberSignatures,
  toMultiSigRpcParameter,
  thresholdTools,
  THRESHOLD_MAX_MEMBERS,
} = require('../src/index');

const ACCOUNT = 'f2125dfc4ba9c9d13e5e1d0e4b95b3f4b45c2f7b';
const OPERATION_DIGEST = 'b42b2a74a1b0dd6d1c9e0d70a0d5f55cbe7a1d95f8c40cf1b1e63d18a4b24a5c';
const sha256 = (hex) => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const utf8hex = (text) => Buffer.from(text, 'utf8').toString('hex');
const u64be = (value) => BigInt(value).toString(16).padStart(16, '0');
const sig = (byte) => byte.repeat(64);

/** Neo `StdLib.Serialize` Integer: varint byte count then little-endian bytes. */
function serializeInteger(value) {
  const bytes = [];
  let remaining = BigInt(value);
  while (remaining > 0n) {
    bytes.push(Number(remaining & 255n));
    remaining >>= 8n;
  }
  if (!bytes.length) bytes.push(0);
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return bytes.length.toString(16).padStart(2, '0') + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The serialized threshold signature field, written out by hand. */
function independentBundle(entries) {
  let hex = `40${entries.length.toString(16).padStart(2, '0')}`;
  // Each entry is a two-item Array whose Integer carries its own `21` marker.
  for (const [memberId, signature] of entries) {
    hex += `400221${serializeInteger(memberId)}28${(signature.length / 2).toString(16).padStart(2, '0')}${signature}`;
  }
  return hex;
}

/** A core stub: the only thing the threshold client may consult. */
function coreWith(modules) {
  const reads = [];
  return {
    reads,
    getModule: async (accountId, moduleId) => {
      reads.push([accountId, moduleId]);
      return modules[String(moduleId)] ?? null;
    },
  };
}
const member = (moduleId, credentialGeneration, eligible = true) => ({
  moduleId,
  credentialGeneration,
  thresholdMemberEligible: eligible,
  moduleType: 'validator',
});

test('member digest preimage is the §5 domain, not a re-used operation digest', () => {
  const digest = thresholdTools.memberDigest(OPERATION_DIGEST, 7, 2);
  assert.equal(
    digest,
    sha256(utf8hex('NeoSmartAccount/ThresholdMember') + '04' + OPERATION_DIGEST + u64be(7) + u64be(2)),
  );
  // The member id and the credential generation are both bound: two members
  // signing one operation never produce the same digest.
  assert.notEqual(digest, thresholdTools.memberDigest(OPERATION_DIGEST, 8, 2));
  assert.notEqual(digest, thresholdTools.memberDigest(OPERATION_DIGEST, 7, 3));
  assert.throws(() => thresholdTools.memberDigest(OPERATION_DIGEST.slice(2), 1, 1), /32 bytes/);
  assert.throws(() => thresholdTools.memberDigest(OPERATION_DIGEST, 1, -1), /uint64/);
});

test('member generations come from the core and an ineligible module is refused', async () => {
  const core = coreWith({
    7: member(7, 3),
    9: member(9, 1, false),
  });
  const threshold = createThresholdClient({ client: core });

  const prepared = await threshold.prepareMembers({
    accountId: ACCOUNT,
    operationDigest: OPERATION_DIGEST,
    memberIds: [7],
  });
  assert.deepEqual(prepared, [
    {
      moduleId: '7',
      credentialGeneration: '3',
      digest: sha256(utf8hex('NeoSmartAccount/ThresholdMember') + '04' + OPERATION_DIGEST + u64be(7) + u64be(3)),
    },
  ]);
  assert.deepEqual(core.reads, [[ACCOUNT, 7]]);

  // A caller-supplied generation is not an input: rotation is read, never typed.
  await assert.rejects(
    threshold.prepareMembers({ accountId: ACCOUNT, operationDigest: OPERATION_DIGEST, memberIds: [7, 7] }),
    /strictly ascending|duplicate/,
  );
  await assert.rejects(
    threshold.prepareMembers({ accountId: ACCOUNT, operationDigest: OPERATION_DIGEST, memberIds: [9] }),
    /not threshold-eligible/,
  );
  await assert.rejects(
    threshold.prepareMembers({ accountId: ACCOUNT, operationDigest: OPERATION_DIGEST, memberIds: [8] }),
    /not installed/,
  );
  assert.throws(() => createThresholdClient({}), /SmartAccount client is required/);
});

test('the assembled field 11 is the exact serialized ascending member list', async () => {
  const threshold = createThresholdClient({ client: coreWith({ 1: member(1, 1), 2: member(2, 1), 3: member(3, 2) }) });
  const signed = [
    { moduleId: 1, signature: sig('aa') },
    { moduleId: 2, signature: sig('bb') },
    { moduleId: 3, signature: sig('cc') },
  ];
  const bundle = threshold.assembleSignature({ members: signed });
  assert.equal(
    bundle,
    independentBundle([
      [1, sig('aa')],
      [2, sig('bb')],
      [3, sig('cc')],
    ]),
  );
  assert.equal(bundle, serializeMemberSignatures([[1, sig('aa')], [2, sig('bb')], [3, sig('cc')]]));

  // The core requires strictly ascending ids: an unordered list is refused, not
  // sorted, because a wallet that silently reorders hides a mismatched roster.
  assert.throws(
    () => threshold.assembleSignature({ members: [{ moduleId: 3, signature: sig('cc') }, { moduleId: 1, signature: sig('aa') }] }),
    /strictly ascending/,
  );
  assert.throws(
    () => threshold.assembleSignature({ members: [{ moduleId: 1, signature: sig('aa') }, { moduleId: 1, signature: sig('bb') }] }),
    /strictly ascending|duplicate/,
  );
  assert.throws(() => threshold.assembleSignature({ members: [{ moduleId: 1, signature: 'aa' }] }), /64 bytes/);
  assert.throws(() => threshold.assembleSignature({ members: [] }), /requires 1 to 10/);
  assert.throws(
    () =>
      threshold.assembleSignature({
        members: Array.from({ length: THRESHOLD_MAX_MEMBERS + 1 }, (_, index) => ({
          moduleId: index + 1,
          signature: sig('aa'),
        })),
      }),
    /requires 1 to 10/,
  );
});

test('one signed operation yields the field-11 value and the digests that were signed', async () => {
  const threshold = createThresholdClient({ client: coreWith({ 4: member(4, 5), 6: member(6, 9) }) });
  const prepared = await threshold.prepareMembers({
    accountId: ACCOUNT,
    operationDigest: OPERATION_DIGEST,
    memberIds: [4, 6],
  });
  assert.deepEqual(
    prepared.map((entry) => entry.credentialGeneration),
    ['5', '9'],
  );

  const assembled = threshold.assembleOperationSignature({
    operationDigest: OPERATION_DIGEST,
    members: [
      { moduleId: 4, credentialGeneration: 5, signature: sig('11') },
      { moduleId: 6, credentialGeneration: 9, signature: sig('22') },
    ],
  });
  assert.equal(
    assembled.signatureHex,
    independentBundle([
      [4, sig('11')],
      [6, sig('22')],
    ]),
  );
  assert.deepEqual(
    assembled.members.map((entry) => entry.digest),
    [prepared[0].digest, prepared[1].digest],
  );
});

test('the tools refuse a malformed digest and a short signature', () => {
  assert.throws(
    () => thresholdTools.prepareMembers({ operationDigest: '00', members: [{ moduleId: 1, credentialGeneration: 1 }] }),
    /32 bytes/,
  );
  assert.throws(
    () => thresholdTools.assembleSignature({ members: [{ moduleId: 1, signature: 'aa'.repeat(63) }] }),
    /64 bytes/,
  );
  assert.throws(() => thresholdTools.memberDigest('zz'.repeat(32), 1, 1), /32 bytes/);
});

test('an RPC parameter carries bytes once, as base64, through every nesting level', () => {
  assert.deepEqual(toMultiSigRpcParameter({ type: 'ByteArray', value: '00aabbff' }), {
    type: 'ByteArray',
    value: Buffer.from('00aabbff', 'hex').toString('base64'),
  });
  assert.deepEqual(
    toMultiSigRpcParameter({
      type: 'Struct',
      value: [
        { type: 'Integer', value: '7' },
        { type: 'Array', value: [{ type: 'ByteArray', value: 'aabb' }] },
      ],
    }),
    {
      type: 'Array',
      value: [
        { type: 'Integer', value: '7' },
        { type: 'Array', value: [{ type: 'ByteArray', value: Buffer.from('aabb', 'hex').toString('base64') }] },
      ],
    },
  );
  assert.throws(() => toMultiSigRpcParameter({ type: 'ByteArray', value: 'aa a' }), /invalid RPC bytes/);
  assert.throws(() => toMultiSigRpcParameter({ type: 'Array', value: 'nope' }), /invalid RPC array/);
  assert.throws(() => toMultiSigRpcParameter(null), /invalid RPC parameter/);
});
