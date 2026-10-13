const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sc, u } = require('@cityofzion/neon-js');
const {
  PROXY_SCOPE_TARGET_REQUIRED,
  buildExecuteUserOpScript,
  buildProxyWalletSignRequest,
  buildProxyWitnessTransaction,
  createProxyVerificationScript,
  createProxyWitness,
  resolveProxyWitnessTransaction,
} = require('../src/proxyWitness');
const coreHash = '0123456789abcdef0123456789abcdef01234567';
const accountId = '89abcdef0123456789abcdef0123456789abcdef';
const targetContract = 'a'.repeat(40);
const scopeTarget = targetContract;
const feePayer = 'b'.repeat(40);
const buyer = 'c'.repeat(40);

test('proxy script is the exact contract derivation, with display hashes reversed once', () => {
  const script = createProxyVerificationScript({ coreHash, accountId });
  assert.equal(script, `0c14${Buffer.from(accountId, 'hex').reverse().toString('hex')}11c01f0c067665726966790c14${Buffer.from(coreHash, 'hex').reverse().toString('hex')}41627d5b52`);
  const expectedProxyHash = crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(Buffer.from(script, 'hex')).digest()).digest().reverse().toString('hex');
  const result = createProxyWitness({ coreHash, accountId, targetContract, scopeTarget, feePayer, expectedProxyHash });
  assert.equal(result.signer.account, expectedProxyHash);
  assert.equal(result.witness.invocationScript, '');
  assert.equal(result.witness.verificationScript, script);
  assert.deepEqual(result.signer, { account: expectedProxyHash, scopes: 'WitnessRules', rules: [{ action: 'Allow', condition: { type: 'Or', expressions: [
    { type: 'CalledByContract', hash: coreHash }, { type: 'CalledByContract', hash: targetContract },
  ] } }] });
});

test('proxy witness fails closed on scope, identity, payer or malformed hashes', () => {
  const valid = { coreHash, accountId, targetContract, scopeTarget, feePayer };
  const result = createProxyWitness(valid);
  assert.throws(() => createProxyWitness({ ...valid, scopeTarget: '0'.repeat(40) }), /scope/i);
  assert.throws(() => createProxyWitness({ ...valid, scopeTarget: feePayer }), /scope/i);
  assert.throws(() => createProxyWitness({ ...valid, expectedProxyHash: feePayer }), /proxy/i);
  assert.throws(() => createProxyWitness({ ...valid, feePayer: result.signer.account }), /fee payer/i);
  for (const field of ['coreHash', 'accountId', 'targetContract', 'feePayer']) {
    assert.throws(() => createProxyWitness({ ...valid, [field]: '0x11zz' }), /hash/i);
  }
});

// ---------------------------------------------------------------------------------------
// The proxy-witness transaction builder (CU-39).
// ---------------------------------------------------------------------------------------

const HASH = (value) => ({ type: 'Hash160', value: `0x${value}` });

function userOperation({ target = targetContract, method = 'transfer', args = null, nonce = '0', deadline = '9999999999999', signature = '01'.repeat(64) } = {}) {
  return {
    type: 'Struct',
    value: [
      HASH(target),
      { type: 'String', value: method },
      { type: 'Array', value: args === null ? [HASH('1'.repeat(40)), HASH(buyer), { type: 'Integer', value: '1000' }, { type: 'ByteArray', value: '0x' }] : args },
      { type: 'Integer', value: String(nonce) },
      { type: 'Integer', value: String(deadline) },
      { type: 'ByteArray', value: `0x${signature}` },
    ],
  };
}

function invocation({ operation = 'executeUserOp', ops = null, core = coreHash, account = accountId, batch = false } = {}) {
  const list = ops === null ? [userOperation()] : ops;
  const second = batch || operation.endsWith('Ops')
    ? { type: 'Array', value: list }
    : list[0];
  return {
    scriptHash: `0x${core}`,
    operation,
    args: [HASH(account), second],
  };
}

// The relay's own conversion of a normalized relay DTO (frontend/api/relayHelpers.js).
function toRpcParameter(parameter) {
  switch (parameter.type) {
    case 'Hash160': return sc.ContractParam.hash160(parameter.value);
    case 'Hash256': return sc.ContractParam.hash256(parameter.value);
    case 'PublicKey': return sc.ContractParam.publicKey(parameter.value);
    case 'Integer': return sc.ContractParam.integer(parameter.value);
    case 'Boolean': return sc.ContractParam.boolean(parameter.value);
    case 'String': return sc.ContractParam.string(parameter.value);
    case 'ByteArray': return sc.ContractParam.byteArray(u.HexString.fromHex(String(parameter.value).slice(2), true));
    case 'Array': return sc.ContractParam.array(...parameter.value.map(toRpcParameter));
    case 'Struct': return sc.ContractParam.array(...parameter.value.map(toRpcParameter));
    case 'Any': return sc.ContractParam.any(null);
    default: throw new Error(`unexpected parameter type ${parameter.type}`);
  }
}

function neonScript(inv) {
  return sc.createScript({
    scriptHash: inv.scriptHash,
    operation: inv.operation,
    args: inv.args.map(toRpcParameter),
  });
}

test('the shape-bound executeUserOp script is byte-identical to the node assembler', () => {
  const cases = [
    { name: 'single transfer', inv: invocation() },
    {
      name: 'batch of two',
      inv: invocation({
        operation: 'executeUserOps',
        ops: [userOperation({ nonce: '1' }), userOperation({ target: targetContract, nonce: '2', method: 'transfer' })],
      }),
    },
    {
      name: 'empty signature and nested arguments',
      inv: invocation({
        ops: [userOperation({
          signature: '',
          args: [
            { type: 'Array', value: [HASH(buyer), { type: 'Integer', value: '17' }] },
            { type: 'Struct', value: [{ type: 'Boolean', value: true }, { type: 'Boolean', value: false }, { type: 'Any', value: null }] },
            { type: 'String', value: '' },
            { type: 'ByteArray', value: '0xdeadbeef' },
            { type: 'Integer', value: '-2' },
            { type: 'Integer', value: String(2n ** 200n) },
          ],
        })],
      }),
    },
  ];
  for (const { name, inv } of cases) {
    assert.equal(buildExecuteUserOpScript({ coreHash, accountId, invocation: inv }), neonScript(inv), name);
  }
});

test('the shape-bound script refuses every envelope that is not one executeUserOp(s) call', () => {
  for (const operation of ['executeSponsoredUserOp', 'executeSponsoredUserOps', 'transfer', 'executeUserOpExtra', '']) {
    assert.throws(
      () => buildExecuteUserOpScript({ coreHash, accountId, invocation: invocation({ operation }) }),
      /executeUserOp/,
      operation,
    );
  }
  assert.throws(() => buildExecuteUserOpScript({ coreHash, accountId, invocation: invocation({ core: 'd'.repeat(40) }) }), /core/i);
  assert.throws(() => buildExecuteUserOpScript({ coreHash, accountId, invocation: invocation({ account: 'e'.repeat(40) }) }), /account/i);
  const three = invocation();
  three.args = [...three.args, { type: 'Integer', value: '1' }];
  assert.throws(() => buildExecuteUserOpScript({ coreHash, accountId, invocation: three }), /two arguments/i);
  const notHash = invocation();
  notHash.args = [{ type: 'String', value: accountId }, notHash.args[1]];
  assert.throws(() => buildExecuteUserOpScript({ coreHash, accountId, invocation: notHash }), /account/i);
  const emptyOps = invocation({ operation: 'executeUserOps', ops: [] });
  assert.throws(() => buildExecuteUserOpScript({ coreHash, accountId, invocation: emptyOps }), /operation/i);
});

test('the builder refuses when no scope target exists', () => {
  const base = { coreHash, accountId, invocation: invocation(), feePayer };
  for (const scopeTargetValue of [undefined, null, '', '0x', '0'.repeat(40), '0x' + '0'.repeat(40)]) {
    assert.throws(
      () => buildProxyWitnessTransaction({ ...base, scopeTarget: scopeTargetValue }),
      (error) => error && error.message === PROXY_SCOPE_TARGET_REQUIRED,
      String(scopeTargetValue),
    );
  }
  assert.throws(() => buildProxyWitnessTransaction({ ...base, scopeTarget: coreHash }), /core/i);
  assert.throws(() => buildProxyWitnessTransaction({ ...base, scopeTarget: 'd'.repeat(40) }), /scope target/i);
});

test('the builder assembles the fee payer, the WitnessRules proxy signer and the proxy witness', () => {
  const inv = invocation();
  const built = buildProxyWitnessTransaction({ coreHash, accountId, invocation: inv, scopeTarget, feePayer });
  const expected = createProxyWitness({ coreHash, accountId, targetContract, scopeTarget, feePayer });
  assert.equal(built.script, neonScript(inv));
  assert.equal(built.operation, 'executeUserOp');
  assert.equal(built.proxyHash, expected.signer.account);
  assert.deepEqual(built.proxyWitness, expected.witness);
  assert.equal(built.signers.length, 2);
  assert.deepEqual(built.signers[0], { account: feePayer, scopes: 'CalledByEntry' });
  assert.deepEqual(built.signers[1], expected.signer);
  assert.deepEqual(built.proxySigner, expected.signer);
  assert.deepEqual(built.feePayerSigner, built.signers[0]);
});

test('the batch builder binds every operation to the one configured scope target', () => {
  const inv = invocation({ operation: 'executeUserOps', ops: [userOperation({ nonce: '1' }), userOperation({ nonce: '2' })] });
  const built = buildProxyWitnessTransaction({ coreHash, accountId, invocation: inv, scopeTarget, feePayer });
  assert.equal(built.operation, 'executeUserOps');
  assert.equal(built.script, neonScript(inv));
  const mixed = invocation({
    operation: 'executeUserOps',
    ops: [userOperation({ nonce: '1' }), userOperation({ target: 'd'.repeat(40), nonce: '2' })],
  });
  assert.throws(() => buildProxyWitnessTransaction({ coreHash, accountId, invocation: mixed, scopeTarget, feePayer }), /scope target/i);
});

test('the proxy can never pay the enclosing transaction fees', () => {
  const inv = invocation();
  const built = buildProxyWitnessTransaction({ coreHash, accountId, invocation: inv, scopeTarget, feePayer });
  assert.throws(
    () => buildProxyWitnessTransaction({ coreHash, accountId, invocation: inv, scopeTarget, feePayer: built.proxyHash }),
    /fee payer/i,
  );
});

test('the browser-wallet signing path expresses the fee payer in custom scopes', () => {
  const inv = invocation();
  const built = buildProxyWitnessTransaction({ coreHash, accountId, invocation: inv, scopeTarget, feePayer });

  const custom = buildProxyWalletSignRequest({ transaction: built, scope: 'CustomContracts', allowedContracts: [coreHash, targetContract] });
  assert.deepEqual(custom.feePayerSigner, { account: feePayer, scopes: 'CustomContracts', allowedContracts: [coreHash, targetContract] });
  assert.deepEqual(custom.signers[0], custom.feePayerSigner);
  assert.deepEqual(custom.signers[1], built.proxySigner);
  assert.equal(custom.script, built.script);
  assert.deepEqual(custom.proxyWitness, built.proxyWitness);

  const global = buildProxyWalletSignRequest({ transaction: built, scope: 'Global' });
  assert.deepEqual(global.feePayerSigner, { account: feePayer, scopes: 'Global' });

  const direct = buildProxyWitnessTransaction({
    coreHash, accountId, invocation: inv, scopeTarget, feePayer,
    feePayerScope: 'CustomContracts', feePayerAllowedContracts: [coreHash],
  });
  assert.deepEqual(direct.feePayerSigner, { account: feePayer, scopes: 'CustomContracts', allowedContracts: [coreHash] });

  assert.throws(() => buildProxyWalletSignRequest({ transaction: built, scope: 'WitnessRules' }), /scope/i);
  assert.throws(() => buildProxyWalletSignRequest({ transaction: built, scope: 'CustomContracts' }), /allow/i);
  assert.throws(() => buildProxyWalletSignRequest({ transaction: built, scope: 'CustomContracts', allowedContracts: [] }), /allow/i);
});

test('the resolver takes the scope state from its reader and never from the caller', async () => {
  const inv = invocation();
  const seen = [];
  const built = await resolveProxyWitnessTransaction({
    coreHash,
    accountId,
    invocation: inv,
    feePayer,
    readState: async (request) => {
      seen.push(request);
      return { scopeTarget, expectedProxyHash: undefined };
    },
  });
  assert.deepEqual(seen, [{ coreHash, accountId }]);
  assert.deepEqual(built, buildProxyWitnessTransaction({ coreHash, accountId, invocation: inv, scopeTarget, feePayer }));
  await assert.rejects(
    resolveProxyWitnessTransaction({ coreHash, accountId, invocation: inv, feePayer, readState: async () => ({}) }),
    (error) => error && error.message === PROXY_SCOPE_TARGET_REQUIRED,
  );
  await assert.rejects(
    resolveProxyWitnessTransaction({ coreHash, accountId, invocation: inv, feePayer }),
    /reader/i,
  );
});
