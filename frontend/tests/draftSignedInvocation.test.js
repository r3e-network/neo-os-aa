import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientBroadcastRequest, buildRelayBroadcastRequest, buildRelayPayloadOptions, buildStagedTransactionBody, executeBroadcast } from '../src/features/operations/execution.js';
import { summarizeSignerProgress } from '../src/features/operations/signatures.js';
import { buildExecuteUserOpInvocation, buildV3UserOperationTypedData } from '../src/features/operations/metaTx.js';

const core = '11'.repeat(20);
const accountId = '22'.repeat(20);
const target = '33'.repeat(20);
function fixture() {
  const operationBody = { targetContract: target, method: 'balanceOf', args: [{ type: 'Hash160', value: `0x${accountId}` }] };
  const body = buildStagedTransactionBody({ aaContractHash: core, account: { accountIdHash: accountId }, operationBody, morpheusNetwork: 'testnet' });
  const invocation = buildExecuteUserOpInvocation({ aaContractHash: core, accountIdHash: accountId, targetContract: target, method: 'balanceOf', methodArgs: operationBody.args, nonce: '9', deadline: '2000000000000', signatureHex: 'ab'.repeat(64) });
  const typedData = buildV3UserOperationTypedData({ chainId: 894710606, verifyingContract: '44'.repeat(20), coreContractHash: core, accountIdHash: accountId, targetContract: target, method: 'balanceOf', argsHashHex: '55'.repeat(32), nonce: '9', deadline: '2000000000000' });
  const signatures = [{ kind: 'evm', signerId: 'alice', signatureHex: 'ab'.repeat(64), metadata: { metaInvocation: invocation, typedData } }];
  return { body, signatures, invocation };
}
const client = ({ body, signatures }) => buildClientBroadcastRequest({ signerAddress: 'N-fee-payer', transactionBody: body, signatures, morpheusNetwork: 'testnet' });
const relay = ({ body, signatures }) => buildRelayBroadcastRequest({ relayEndpoint: '/api/relay-transaction', transactionBody: body, signatures, morpheusNetwork: 'testnet' });

test('immutable draft client and relay carry the same signed UserOperation without mutating its staged body', async () => {
  const state = fixture();
  const before = JSON.stringify(state);
  assert.deepEqual(client(state).args, state.invocation.args);
  assert.deepEqual(relay(state).metaInvocation.args, state.invocation.args);
  let sent;
  await executeBroadcast({ mode: 'client', deps: { computeArgsHash: async () => '55'.repeat(32) }, signerAddress: 'N-fee-payer', transactionBody: state.body, signatures: state.signatures, morpheusNetwork: 'testnet', walletService: { invoke: async (request) => { sent = request; return { txid: 'ok' }; } } });
  assert.deepEqual(sent.args, state.invocation.args);
  assert.equal(JSON.stringify(state), before);
});

for (const [label, mutate] of [
  ['core', (s) => { s.invocation.scriptHash = '66'.repeat(20); }],
  ['account', (s) => { s.invocation.args[0].value = `0x${'66'.repeat(20)}`; }],
  ['target', (s) => { s.invocation.args[1].value[0].value = `0x${'66'.repeat(20)}`; }],
  ['method', (s) => { s.invocation.args[1].value[1].value = 'transfer'; }],
  ['arguments', (s) => { s.invocation.args[1].value[2].value = []; }],
  ['body account', (s) => { s.body.accountIdHash = '66'.repeat(20); }],
  ['network', (s) => { s.body.network = 'neo-n3-mainnet'; }],
  ['typed network', (s) => { s.signatures[0].metadata.typedData.domain.chainId = 860833102; }],
  ['typed target', (s) => { s.signatures[0].metadata.typedData.message.targetContract = `0x${'66'.repeat(20)}`; }],
  ['typed nonce', (s) => { s.signatures[0].metadata.typedData.message.nonce = '10'; }],
  ['signature bytes', (s) => { s.signatures[0].signatureHex = 'cd'.repeat(64); }],
]) {
  test(`both routes reject mismatched signed ${label}`, () => {
    const state = fixture();
    mutate(state);
    assert.throws(() => client(state), /mismatch/i);
    assert.throws(() => relay(state), /mismatch/i);
    assert.deepEqual(buildRelayPayloadOptions({ runtime: { morpheusNetwork: 'testnet' }, transactionBody: state.body, signatures: state.signatures }), []);
  });
}

test('conflicting EVM signatures require explicit aggregation and cannot select the first record', () => {
  const state = fixture();
  const second = structuredClone(state.signatures[0]);
  second.signerId = 'bob';
  second.signatureHex = 'cd'.repeat(64);
  second.metadata.metaInvocation.args[1].value[5].value = `0x${second.signatureHex}`;
  state.signatures.push(second);
  assert.throws(() => client(state), /multiple.*aggregation.*unsupported/i);
  assert.throws(() => relay(state), /multiple.*aggregation.*unsupported/i);
});

test('duplicate canonical invocations are harmless but stale signed body conflicts fail closed', () => {
  const state = fixture();
  state.body.v3Invocation = structuredClone(state.invocation);
  assert.deepEqual(client(state).args, state.invocation.args);
  state.body.v3Invocation.args[1].value[3].value = '1';
  assert.throws(() => client(state), /multiple.*aggregation.*unsupported/i);
});

test('collaborator metadata cannot inject fee-payer signers', () => {
  const state = fixture();
  state.invocation.signers = [{ account: 'attacker', scopes: 128 }];
  assert.deepEqual(client(state).signers, [{ account: 'N-fee-payer', scopes: 1 }]);
});

test('approval progress counts distinct required records and never claims chain quorum', () => {
  const progress = summarizeSignerProgress([{ kind: 'neo', id: 'alice' }, { kind: 'evm', id: 'bob' }], [
    { kind: 'neo', signerId: 'alice', signatureHex: 'aa' },
    { kind: 'neo', signerId: 'alice', signatureHex: 'aa' },
    { kind: 'evm', signerId: 'outsider', signatureHex: 'bb' },
  ]);
  assert.equal(progress.signatureCount, 1);
  assert.equal(progress.isComplete, false);
  assert.equal(progress.chainQuorumVerified, false);
});

test('invalid signed invocation blocks relay readiness with a useful cause', async () => {
  const { evaluateRelayReadiness } = await import('../src/features/operations/relayReadiness.js');
  const state = fixture();
  state.invocation.args[1].value[1].value = 'transfer';
  const readiness = evaluateRelayReadiness({ runtime: { relayEnabled: true, relayMetaEnabled: true, morpheusNetwork: 'testnet' }, transactionBody: state.body, signatures: state.signatures });
  assert.equal(readiness.payloadReady, false);
  assert.equal(readiness.level, 'blocked');
  assert.match(readiness.detail, /mismatch/i);
});

test('malformed and unsigned V3 metadata cannot be offered as a signed relay payload', () => {
  for (const bad of [{ operation: 'executeUserOp', args: [] }, { operation: 'executeUserOp' }]) {
    const state = fixture();
    state.signatures[0].metadata.metaInvocation = { scriptHash: core, ...bad };
    assert.throws(() => client(state), /mismatch/i);
  }
  const state = fixture();
  state.invocation.args[1].value[5].value = '0x';
  assert.throws(() => client(state), /no signature/i);
});

test('client blocks proxy-sourced transfer even when imported metadata omits the witness requirement flag', () => {
  const body = buildStagedTransactionBody({ aaContractHash: core, account: { accountIdHash: accountId, accountAddressScriptHash: target }, morpheusNetwork: 'testnet', operationBody: { targetContract: core, method: 'transfer', args: [{ type: 'Hash160', value: `0x${target}` }] } });
  assert.equal(body.requiresProxyWitness, false);
  assert.throws(() => client({ body, signatures: [] }), /proxy witness/);
  body.clientInvocation.args[1].value[2].value[0].value = `0x${'77'.repeat(20)}`;
  assert.doesNotThrow(() => client({ body, signatures: [] }));
});

test('typed EVM signature recovery verifies signer identity and submitted compact bytes', async () => {
  const { Wallet, TypedDataEncoder } = await import('ethers');
  const signer = new Wallet(`0x${'01'.repeat(32)}`);
  const state = fixture();
  const record = state.signatures[0];
  const typed = record.metadata.typedData;
  const signature = signer.signingKey.sign(TypedDataEncoder.hash(typed.domain, typed.types, typed.message));
  record.signerId = signer.address;
  record.signatureHex = `${signature.r.slice(2)}${signature.s.slice(2)}`;
  record.metadata.signatureFullHex = signature.serialized;
  state.invocation.args[1].value[5].value = `0x${record.signatureHex}`;
  assert.doesNotThrow(() => client(state));
  record.signerId = `0x${'77'.repeat(20)}`;
  assert.throws(() => client(state), /EVM signer/);
});

test('case sensitive Neo signer identities do not count toward another signer requirement', () => {
  const progress = summarizeSignerProgress([{ kind: 'neo', id: 'NeoAlice' }], [{ kind: 'neo', signerId: 'neoalice', signatureHex: 'aa' }]);
  assert.equal(progress.signatureCount, 0);
  assert.equal(progress.isComplete, false);
});

test('collaborator payload cannot replace an unanchored raw draft with wallet spending', () => {
  const state = fixture();
  state.body = { network: 'neo-n3-testnet', accountIdHash: accountId, rawTransaction: 'deadbeef' };
  assert.throws(() => client(state), /staged operation anchor/);
  state.signatures[0].metadata.metaInvocation = { scriptHash: target, operation: 'transfer', args: [{ type: 'Hash160', value: `0x${accountId}` }] };
  assert.throws(() => client(state), /unsupported AA wrapper/);
});

test('client cannot send metadata whose claimed argument hash differs from the core computation', async () => {
  const state = fixture();
  let invoked = false;
  await assert.rejects(() => executeBroadcast({ mode: 'client', signerAddress: 'fee-payer', morpheusNetwork: 'testnet', transactionBody: state.body, signatures: state.signatures,
    deps: { computeArgsHash: async ({ args }) => { assert.deepEqual(args, state.invocation.args[1].value[2].value); return '66'.repeat(32); } },
    walletService: { invoke: async () => { invoked = true; } },
  }), /on-chain arguments hash/);
  assert.equal(invoked, false);
});

test('wrong EIP-712 domain name or type schema is not a contract-compatible signature', () => {
  const state = fixture();
  state.signatures[0].metadata.typedData.domain.name = 'Unrelated app';
  assert.throws(() => client(state), /domain\/schema/);
  const other = fixture();
  other.signatures[0].metadata.typedData.types.UserOperation.pop();
  assert.throws(() => client(other), /domain\/schema/);
});

test('custom network magic is consistent in availability, client, relay and preflight', async () => {
  const { buildRelayPreflightRequest } = await import('../src/features/operations/relayPreflight.js');
  const state = fixture();
  state.signatures[0].metadata.typedData.domain.chainId = 123456;
  const input = { transactionBody: state.body, signatures: state.signatures, morpheusNetwork: 'testnet', networkMagic: 123456, relayEndpoint: '/api/relay-transaction', signerAddress: 'fee-payer' };
  assert.deepEqual(buildRelayPayloadOptions({ ...input, runtime: { morpheusNetwork: 'testnet', networkMagic: 123456 } }), ['meta']);
  assert.deepEqual(buildClientBroadcastRequest(input).args, state.invocation.args);
  assert.deepEqual(buildRelayBroadcastRequest(input).metaInvocation.args, state.invocation.args);
  assert.deepEqual(buildRelayPreflightRequest(input).metaInvocation.args, state.invocation.args);
});
