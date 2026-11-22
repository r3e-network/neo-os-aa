/**
 * The proxy witness (docs/SA-MODULE-PROTOCOL.md §16.1).
 *
 * The proxy verification script carries no secret: it calls `core.verify(
 * accountId)`, and the core accepts it only when the whole transaction is one
 * `executeUserOp`/`executeUserOps` call on that core for that account. So the
 * proxy witness has exactly one safe construction, and this suite pins it:
 *
 * - the transaction script is one shaped v4 call and nothing else;
 * - the proxy signer's rule is exactly one Allow/CalledByContract(core);
 * - the proxy is never the fee payer;
 * - the proxy address is derived by the caller and pinned to the core's answer.
 *
 * The v3 Or(core, target) rule and the verifier-scope target are gone: the
 * operation's own 13-field target is the only authorized target, and it is
 * covered by the validator signature inside executeUserOp.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  DEFAULT_CALL_FLAGS,
  buildExecuteUserOpScript,
  buildProxyWalletSignRequest,
  buildProxyWitnessTransaction,
  createProxyVerificationScript,
  createProxyWitness,
  resolveProxyWitnessTransaction,
} = require('../src/index');
const { codec } = require('../src/index');

const CORE = '0123456789abcdef0123456789abcdef01234567';
const ACCOUNT = '89abcdef0123456789abcdef0123456789abcdef';
const PAYER = 'b'.repeat(40);
const TARGET = 'a'.repeat(40);
const ZERO_SUBKEY = '00'.repeat(32);

const addressOf = (script) =>
  crypto
    .createHash('ripemd160')
    .update(crypto.createHash('sha256').update(Buffer.from(script, 'hex')).digest())
    .digest()
    .reverse()
    .toString('hex');
const PROXY = addressOf(createProxyVerificationScript({ coreHash: CORE, accountId: ACCOUNT }));

/** A 13-field v4 operation as the VM value the core expects (§4). */
function operation(overrides = {}) {
  return {
    version: 4,
    targetContract: TARGET,
    method: 'transfer',
    args: [
      // A hash argument is a ByteString of the stored byte order in v4.
      codec.hashValue('1'.repeat(40)),
      { type: 'Integer', value: '1000' },
    ],
    nonce: '0',
    nonceSubkey: ZERO_SUBKEY,
    deadline: '9999999999999',
    validatorId: '1',
    credentialGeneration: '1',
    authorityEpoch: '1',
    configurationNonce: '0',
    signature: '01'.repeat(64),
    hookProofs: [],
    ...overrides,
  };
}
const value = (op = operation()) => codec.operationValue(op);
// The client builds this argument with `codec.hashValue`, so the witness is
// tested against what a plan actually contains, not a v3 spelling.
const ACCOUNT_ARG = codec.hashValue(ACCOUNT);
const invocation = (op = operation(), entry = 'executeUserOp') => ({
  operation: entry,
  scriptHash: CORE,
  args: [
    ACCOUNT_ARG,
    entry === 'executeUserOps' ? { type: 'Array', value: [value(op)] } : value(op),
  ],
});

test('the proxy verification script is the exact core derivation, at the kernel call flags', () => {
  const native = createProxyVerificationScript({ coreHash: CORE, accountId: ACCOUNT });
  assert.equal(
    native,
    `0c14${Buffer.from(ACCOUNT, 'hex').reverse().toString('hex')}11c0150c06` +
      `${Buffer.from('verify', 'utf8').toString('hex')}0c14${Buffer.from(CORE, 'hex').reverse().toString('hex')}41627d5b52`,
  );
  // The native core pushes CallFlags.ReadOnly (5), so that is the default.
  assert.equal(DEFAULT_CALL_FLAGS, 5);
  // The same account id at a different flag is a different address, so the flag
  // is never assumed: a caller that changes it gets the address it asked for.
  const readStates = createProxyVerificationScript({ coreHash: CORE, accountId: ACCOUNT, callFlags: 1 });
  assert.equal(readStates, native.replace('11c015', '11c011'));
  assert.notEqual(addressOf(readStates), addressOf(native));
  assert.throws(() => createProxyVerificationScript({ coreHash: CORE, accountId: ACCOUNT, callFlags: 17 }), /flags/);
  assert.throws(() => createProxyVerificationScript({ coreHash: CORE, accountId: '0'.repeat(40) }), /accountId/);
  assert.throws(() => createProxyVerificationScript({ coreHash: CORE, accountId: '11zz' }), /accountId/);
});

test('the proxy witness is one WitnessRules signer with an empty invocation script', () => {
  const { signer, witness } = createProxyWitness({
    coreHash: CORE,
    accountId: ACCOUNT,
    proxyHash: PROXY,
    feePayer: PAYER,
    expectedProxyHash: PROXY,
  });
  assert.deepEqual(signer, {
    account: PROXY,
    scopes: 'WitnessRules',
    rules: [{ action: 'Allow', condition: { type: 'CalledByContract', hash: CORE } }],
  });
  assert.equal(witness.invocationScript, '');
  assert.equal(witness.verificationScript, createProxyVerificationScript({ coreHash: CORE, accountId: ACCOUNT }));

  const valid = { coreHash: CORE, accountId: ACCOUNT, proxyHash: PROXY, feePayer: PAYER };
  // The proxy address is never guessed from a hash the caller made up.
  assert.throws(() => createProxyWitness({ ...valid, expectedProxyHash: PAYER }), /differs from the core/);
  assert.throws(() => createProxyWitness({ ...valid, proxyHash: undefined }), /proxyHash must be a nonzero Hash160/);
  assert.throws(() => createProxyWitness({ ...valid, proxyHash: '0'.repeat(40) }), /proxyHash/);
  assert.throws(() => createProxyWitness({ ...valid, feePayer: PROXY }), /cannot be the fee payer/);
  for (const field of ['coreHash', 'accountId', 'feePayer']) {
    assert.throws(() => createProxyWitness({ ...valid, [field]: '0x11zz' }), /Hash160/);
  }
});

test('the transaction script is one shaped executeUserOp call and nothing else', () => {
  const script = buildExecuteUserOpScript({ coreHash: CORE, accountId: ACCOUNT, invocation: invocation() });
  // The one call the core's verification context accepts: the account id, the
  // 13-field operation, and nothing else in the script.
  assert.equal(
    script,
    codec.dynamicCall(CORE, 'executeUserOp', [ACCOUNT_ARG, value(operation())]),
  );
  assert.match(script, /41627d5b52$/);
  // The display-hex Hash160 spelling of the same account names the same
  // account and emits the same bytes, so a caller cannot authorize a script
  // that differs from the one the plan sends.
  assert.equal(
    buildExecuteUserOpScript({
      coreHash: CORE,
      accountId: ACCOUNT,
      invocation: { ...invocation(), args: [{ type: 'Hash160', value: ACCOUNT }, value(operation())] },
    }),
    script,
  );
  const batch = buildExecuteUserOpScript({
    coreHash: CORE,
    accountId: ACCOUNT,
    invocation: invocation(undefined, 'executeUserOps'),
  });
  assert.notEqual(batch, script);

  const op = operation();
  const rejects = [
    [invocation(op, 'executeSponsoredUserOp'), /executeUserOp or executeUserOps/],
    [{ ...invocation(op), operation: 'setAdmin' }, /executeUserOp or executeUserOps/],
    [{ ...invocation(op), scriptHash: TARGET }, /different core/],
    [{ ...invocation(op), args: [codec.hashValue(PAYER), value(op)] }, /does not name this account/],
    [{ ...invocation(op), args: [{ type: 'Hash160', value: '11zz' }, value(op)] }, /does not name this account/],
    [{ ...invocation(op), args: [value(op)] }, /exactly two arguments/],
    [{ ...invocation(op), args: [ACCOUNT_ARG, value(op), value(op)] }, /exactly two arguments/],
    [{ ...invocation(op), args: [ACCOUNT_ARG, { type: 'Array', value: [] }] }, /13-field user operation/],
    // A batch with no operations authorizes nothing.
    [{ ...invocation(op, 'executeUserOps'), args: [ACCOUNT_ARG, { type: 'Array', value: [] }] }, /at least one user operation/],
    // The v3 6-field envelope is refused, never adapted.
    [{ ...invocation(op), args: [ACCOUNT_ARG, { type: 'Array', value: [{ type: 'Integer', value: '1' }] }] }, /13-field user operation/],
  ];
  for (const [bad, pattern] of rejects) {
    assert.throws(() => buildExecuteUserOpScript({ coreHash: CORE, accountId: ACCOUNT, invocation: bad }), pattern);
  }
  assert.throws(() => buildExecuteUserOpScript({ coreHash: CORE, accountId: ACCOUNT }), /invocation required/);
});

test('the built transaction keeps the fee payer first and the proxy second', () => {
  const transaction = buildProxyWitnessTransaction({
    coreHash: CORE,
    accountId: ACCOUNT,
    invocation: invocation(),
    proxyHash: PROXY,
    feePayer: PAYER,
  });
  assert.equal(transaction.signers.length, 2);
  assert.equal(transaction.signers[0].account, PAYER);
  assert.equal(transaction.signers[0].scopes, 'CalledByEntry');
  assert.deepEqual(transaction.signers[1], transaction.proxySigner);
  assert.equal(transaction.proxyWitness.verificationScript, createProxyVerificationScript({ coreHash: CORE, accountId: ACCOUNT }));
  assert.equal(transaction.witness, transaction.proxyWitness);
  assert.equal(transaction.operation, 'executeUserOp');

  // A fee payer allowlist is only expressible with the CustomContracts scope.
  assert.throws(
    () => buildProxyWitnessTransaction({ coreHash: CORE, accountId: ACCOUNT, invocation: invocation(), proxyHash: PROXY, feePayer: PAYER, feePayerAllowedContracts: [CORE] }),
    /only meaningful with the CustomContracts scope/,
  );
  assert.throws(
    () => buildProxyWitnessTransaction({ coreHash: CORE, accountId: ACCOUNT, invocation: invocation(), proxyHash: PROXY, feePayer: PAYER, feePayerScope: 'CustomContracts' }),
    /requires a nonempty allowlist/,
  );
  const scoped = buildProxyWitnessTransaction({
    coreHash: CORE,
    accountId: ACCOUNT,
    invocation: invocation(),
    proxyHash: PROXY,
    feePayer: PAYER,
    feePayerScope: 'CustomContracts',
    feePayerAllowedContracts: [CORE, TARGET],
  });
  assert.deepEqual(scoped.signers[0], { account: PAYER, scopes: 'CustomContracts', allowedContracts: [CORE, TARGET] });
  // The proxy is still never a payer and never gains a second rule.
  assert.equal(scoped.signers[1].rules.length, 1);
});

test('the browser-wallet request re-scopes the payer and keeps the proxy rule', () => {
  const transaction = buildProxyWitnessTransaction({
    coreHash: CORE,
    accountId: ACCOUNT,
    invocation: invocation(),
    proxyHash: PROXY,
    feePayer: PAYER,
  });
  const request = buildProxyWalletSignRequest({ transaction, scope: 'CustomContracts', allowedContracts: [CORE] });
  assert.deepEqual(request.signers[0], { account: PAYER, scopes: 'CustomContracts', allowedContracts: [CORE] });
  assert.deepEqual(request.signers[1], transaction.proxySigner);
  assert.equal(request.script, transaction.script);
  assert.equal(request.witness, transaction.proxyWitness);
  const global = buildProxyWalletSignRequest({ transaction, scope: 'Global' });
  assert.deepEqual(global.signers[0], { account: PAYER, scopes: 'Global' });
  assert.throws(() => buildProxyWalletSignRequest({}), /built proxy-witness transaction is required/);
  assert.throws(() => buildProxyWalletSignRequest({ transaction: { signers: [{}] } }), /built proxy-witness transaction is required/);
  assert.throws(() => buildProxyWalletSignRequest({ transaction, scope: 'WitnessRules' }), /not expressible/);
});

test('the resolver takes the expected proxy address from its reader only', async () => {
  const seen = [];
  const transaction = await resolveProxyWitnessTransaction({
    coreHash: CORE,
    accountId: ACCOUNT,
    invocation: invocation(),
    proxyHash: PROXY,
    feePayer: PAYER,
    readState: async (request) => {
      seen.push(request);
      return { proxyHash: PROXY };
    },
  });
  assert.deepEqual(seen, [{ coreHash: CORE, accountId: ACCOUNT }]);
  assert.equal(transaction.proxyHash, PROXY);

  // A core that answers a different address, or a caller-supplied pin, fails.
  await assert.rejects(
    resolveProxyWitnessTransaction({
      coreHash: CORE,
      accountId: ACCOUNT,
      invocation: invocation(),
      proxyHash: PROXY,
      feePayer: PAYER,
      readState: async () => ({ proxyHash: PAYER }),
    }),
    /differs from the core/,
  );
  await assert.rejects(
    resolveProxyWitnessTransaction({
      coreHash: CORE,
      accountId: ACCOUNT,
      invocation: invocation(),
      proxyHash: PROXY,
      feePayer: PAYER,
      readState: async () => null,
    }),
    /nonzero Hash160/,
  );
  await assert.rejects(
    resolveProxyWitnessTransaction({
      coreHash: CORE,
      accountId: ACCOUNT,
      invocation: invocation(),
      proxyHash: PROXY,
      feePayer: PAYER,
    }),
    /proxy-state reader is required/,
  );
});
