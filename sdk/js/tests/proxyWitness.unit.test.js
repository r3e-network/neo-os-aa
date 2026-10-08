const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createProxyVerificationScript, createProxyWitness } = require('../src/proxyWitness');
const coreHash = '0123456789abcdef0123456789abcdef01234567';
const accountId = '89abcdef0123456789abcdef0123456789abcdef';
const targetContract = 'a'.repeat(40);
const scopeTarget = targetContract;
const feePayer = 'b'.repeat(40);

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
