// Cross-check the exact native engine export with the consumer-facing SDK.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { nativeCodec, NATIVE_SMART_ACCOUNT_CONTRACT } = require('../sdk/js/src/native');
const { createProxyVerificationScript } = require('../sdk/js/src/proxyWitness');

const { core, cases, assemblySha256 } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(core.slice(2), NATIVE_SMART_ACCOUNT_CONTRACT);
assert.match(assemblySha256, /^[a-f0-9]{64}$/);
assert.equal(cases.length, 320);
const seen = new Set();
for (const { accountId, script, address } of cases) {
  assert.match(accountId, /^0x[0-9a-f]{40}$/);
  assert.equal(nativeCodec.verificationScript(accountId), script);
  assert.equal(createProxyVerificationScript({ coreHash: core, accountId }), script);
  assert.equal('0x' + nativeCodec.accountAddress(accountId), address);
  seen.add(accountId);
}
for (let i = 0n; i < 160n; i++) {
  const bit = 1n << i;
  for (const n of [bit, ((1n << 160n) - 1n) ^ bit])
    assert.ok(seen.has('0x' + n.toString(16).padStart(40, '0')));
}
console.log(`${cases.length} native receiving addresses and scripts matched the SDK (DLL ${assemblySha256}).`);
