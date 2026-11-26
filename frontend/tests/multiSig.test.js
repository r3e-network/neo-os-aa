// Threshold route (docs/SA-MODULE-PROTOCOL.md §5): one validator instance routes an operation for
// several member modules, and the operation's signature field carries the serialized member list
// instead of one signature. The member list is not readable from the core, so the caller supplies
// the members and the session reads the one value it must not guess: each member's current
// credential generation, from `getModule(accountId, moduleId)`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createThresholdSession } from '../src/features/operations/multiSig.js';

const core = '11'.repeat(20);
const account = '22'.repeat(20);
const memberContract = '33'.repeat(20);

/** A UInt160 as the node returns it: a ByteString in the stored byte order. */
const hash = (value) => ({ type: 'ByteString', value: Buffer.from(value, 'hex').reverse().toString('base64') });
const bytes = (hex) => ({ type: 'ByteString', value: Buffer.from(hex, 'hex').toString('base64') });
const integer = (value) => ({ type: 'Integer', value: String(value) });
const bool = (value) => ({ type: 'Boolean', value });
const halt = (value) => ({ state: 'HALT', stack: [value] });

/** The 15-field v4.1 `getModule` descriptor of §9. */
function moduleDescriptor({
  moduleId = 2,
  contractHash = memberContract,
  credentialGeneration = 3,
  thresholdMemberEligible = true,
} = {}) {
  return {
    type: 'Array',
    value: [
      integer(moduleId), integer(1), hash(contractHash), integer(0), integer(0),
      bytes('aa'.repeat(32)), bytes('bb'.repeat(32)), integer(1), integer(credentialGeneration),
      bool(true), bool(false), bool(thresholdMemberEligible),
      // compositeLayer, governance, hookPlanner
      bool(false), bool(false), bool(false),
    ],
  };
}

/** §5 member digest, computed independently of the module under test. */
function memberDigest(operationDigest, moduleId, credentialGeneration) {
  const u64 = (value) => Buffer.from(BigInt(value).toString(16).padStart(16, '0'), 'hex');
  return createHash('sha256')
    .update(Buffer.concat([
      Buffer.from('NeoSmartAccount/ThresholdMember', 'utf8'),
      Buffer.from([4]),
      Buffer.from(operationDigest, 'hex'),
      u64(moduleId),
      u64(credentialGeneration),
    ]))
    .digest('hex');
}

const MEMBER_SIGNATURE = 'aa'.repeat(64);
// The assembled threshold bundle for one member: Neo StdLib.Serialize of
// Array[2]{ Integer(2), ByteString(64) }.
const THRESHOLD_SIGNATURE = `400140022101022840${MEMBER_SIGNATURE}`;

const OPERATION = {
  targetContract: core,
  method: 'symbol',
  args: [],
  nonce: '1',
  nonceSubkey: '00'.repeat(32),
  deadline: '2000000000000',
  validatorId: '2',
  credentialGeneration: '1',
  authorityEpoch: '0',
  configurationNonce: '0',
  signature: THRESHOLD_SIGNATURE,
  hookProofs: [],
};

function sessionWith(handler) {
  return createThresholdSession({
    rpcUrl: 'http://localhost:20332',
    fetchImpl: async (_url, options) => {
      const { method, params } = JSON.parse(options.body);
      return { ok: true, json: async () => ({ result: handler(method, params) }) };
    },
  });
}

test('a threshold session reads each member generation and assembles the v4 signature field', async () => {
  const session = sessionWith((method, params) => {
    if (params[1] === 'getModule') return halt(moduleDescriptor());
    throw new Error(`unexpected RPC ${method}/${params[1]}`);
  });
  const networkMagic = 894710606;
  const operationDigest = session.operationDigest({ networkMagic, coreContractHash: core, accountId: account, operation: OPERATION });
  assert.match(operationDigest, /^[0-9a-f]{64}$/);

  const members = await session.prepareMembers({
    networkMagic,
    coreContractHash: core,
    accountId: account,
    operation: OPERATION,
    memberModuleIds: [2],
  });
  assert.equal(members.length, 1);
  assert.equal(members[0].moduleId, '2');
  // The generation is read from the core, never assumed by the caller.
  assert.equal(members[0].credentialGeneration, '3');
  assert.equal(members[0].digest, memberDigest(operationDigest, 2, 3));

  const signature = MEMBER_SIGNATURE;
  const result = session.assembleOperationSignature({
    operationDigest,
    members: [{ moduleId: 2, credentialGeneration: 3, signature }],
  });
  // Neo StdLib.Serialize of Array[2]{ Integer(2), ByteString(64) }, one member.
  assert.equal(result.signatureHex, THRESHOLD_SIGNATURE);
  assert.equal(result.members[0].digest, memberDigest(operationDigest, 2, 3));
});

test('a member that is not eligible for the threshold route is refused before assembly', async () => {
  const session = sessionWith(() => halt(moduleDescriptor({ thresholdMemberEligible: false })));
  await assert.rejects(
    session.prepareMembers({
      networkMagic: 894710606,
      coreContractHash: core,
      accountId: account,
      operation: OPERATION,
      memberModuleIds: [2],
    }),
    /not eligible as a threshold member/,
  );
});

test('the session reads the proxy address and previews an operation through validateUserOp', async () => {
  const proxy = '44'.repeat(20);
  const digest = 'cc'.repeat(32);
  const calls = [];
  const session = sessionWith((method, params) => {
    calls.push(params[1]);
    if (params[1] === 'getProxyScriptHash') return halt(hash(proxy));
    if (params[1] === 'validateUserOp') {
      return halt({ type: 'Array', value: [bool(true), bytes(digest)] });
    }
    throw new Error(`unexpected RPC ${method}/${params[1]}`);
  });

  assert.equal(await session.readProxyHash({ coreContractHash: core, accountId: account }), proxy);

  const preview = await session.preview({ coreContractHash: core, accountId: account, operation: OPERATION });
  assert.equal(preview.accepted, true);
  assert.equal(preview.operationDigest, digest);
  assert.deepEqual(calls, ['getProxyScriptHash', 'validateUserOp']);
});

test('a threshold session cannot exist without an RPC endpoint', () => {
  assert.throws(() => createThresholdSession({}), (error) => error.message === 'EC_rpc_request_failed');
});

test('UserOperation args hash RPC uses base64 bytes and RPC Array types', async () => {
  const { computeArgsHash } = await import('../src/features/operations/metaTx.js');
  let params;
  const actual = await computeArgsHash({
    rpcUrl: 'http://localhost:20332',
    saContractHash: core,
    args: [{ type: 'ByteArray', value: '0xaabb' }, { type: 'Struct', value: [{ type: 'ByteArray', value: '0x' }] }],
    fetchImpl: async (_url, options) => {
      params = JSON.parse(options.body).params;
      return { ok: true, json: async () => ({ result: halt(bytes('aa'.repeat(32))) }) };
    },
  });
  assert.equal(actual, 'aa'.repeat(32));
  assert.deepEqual(params[2][0], {
    type: 'Array',
    value: [{ type: 'ByteArray', value: 'qrs=' }, { type: 'Array', value: [{ type: 'ByteArray', value: '' }] }],
  });
});
