const test = require('node:test');
const assert = require('node:assert/strict');
const { SmartAccountClient } = require('../src/index');

test('invokeScriptWithRetry retries transient transport failures', async () => {
  const client = new SmartAccountClient('https://example.invalid', '0x1234567890123456789012345678901234567890');
  let attempts = 0;
  client.rpcClient = {
    async invokeScript() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('Client network socket disconnected before secure TLS connection was established');
      }
      return { state: 'HALT', stack: [] };
    },
  };

  const result = await client.invokeScriptWithRetry('deadbeef');

  assert.equal(result.state, 'HALT');
  assert.equal(attempts, 2);
});

test('invokeScriptWithRetry does not retry non-transport failures', async () => {
  const client = new SmartAccountClient('https://example.invalid', '0x1234567890123456789012345678901234567890');
  let attempts = 0;
  client.rpcClient = {
    async invokeScript() {
      attempts += 1;
      throw new Error('contract fault');
    },
  };

  await assert.rejects(() => client.invokeScriptWithRetry('deadbeef'), /contract fault/);
  assert.equal(attempts, 1);
});

test('invokeFunctionWithRetry retries transient transport failures', async () => {
  const client = new SmartAccountClient('https://example.invalid', '0x1234567890123456789012345678901234567890');
  let attempts = 0;
  client.rpcClient = {
    async invokeFunction() {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('socket hang up');
      }
      return {
        state: 'HALT',
        stack: [{
          type: 'Array',
          value: [
            { type: 'Boolean', value: true },
            { type: 'Boolean', value: true },
            { type: 'Boolean', value: false },
            { type: 'Hash160', value: '0xb4107cb2cb4bace0ebe15bc4842890734abe133a' },
            { type: 'Hash160', value: '0x1111111111111111111111111111111111111111' },
          ],
        }],
      };
    },
  };

  const preview = await client.getUserOpValidationPreview({
    accountIdHash: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
    targetContract: '49c095ce04d38642e39155f5481615c58227a498',
    method: 'transfer',
    args: [],
    nonce: 0,
    deadline: 1700000000,
  });

  assert.deepEqual(preview, {
    deadlineValid: true,
    nonceAcceptable: true,
    hasVerifier: false,
    verifier: 'b4107cb2cb4bace0ebe15bc4842890734abe133a',
    hook: '1111111111111111111111111111111111111111',
  });
  assert.equal(attempts, 3);
});
