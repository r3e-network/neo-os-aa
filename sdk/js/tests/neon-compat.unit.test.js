/**
 * Transport and encoding tests for the neon-js compatibility shim.
 *
 * Covers the script-builder parameter encodings (numeric-looking String
 * params, ByteArray hex semantics) and the RPCClient transport hardening
 * (request timeout, HTTP-status errors, non-JSON bodies).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { rpc, sc, u } = require('../src/neonCompat');
const { EC } = require('../src/errors');
const { isRetryableError } = require('../src/retry');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

test('String contract param with numeric content is encoded as UTF-8 bytes, not an integer', () => {
  // '123' must become PUSHDATA1 0x03 '313233', never PUSHINT 123.
  const builder = new sc.ScriptBuilder();
  builder.emitPush(sc.ContractParam.string('123'));
  assert.equal(builder.toHex(), '0c03313233');

  const script = sc.createScript({
    scriptHash: '49c095ce04d38642e39155f5481615c58227a498',
    operation: 'setLabel',
    args: [{ type: 'String', value: '123' }],
  });
  assert.match(script, /0c03313233/);
});

test('Integer contract params still encode as integers, including string-typed values', () => {
  const builder = new sc.ScriptBuilder();
  builder.emitPush(sc.ContractParam.integer('123'));
  // PUSHINT8 (0x00) followed by 0x7b
  assert.equal(builder.toHex(), '007b');

  const small = new sc.ScriptBuilder();
  small.emitPush(sc.ContractParam.fromJson({ type: 'Integer', value: '7' }));
  // PUSH7 = 0x17
  assert.equal(small.toHex(), '17');
});

test('ByteArray contract params treat plain strings as hex, matching neon-js', () => {
  // Wire (JSON-RPC) form is base64 of the same bytes
  assert.equal(
    sc.ContractParam.byteArray('abcd').toJSON().value,
    Buffer.from('abcd', 'hex').toString('base64'),
  );

  // Script form pushes the raw bytes
  const builder = new sc.ScriptBuilder();
  builder.emitPush(sc.ContractParam.byteArray('abcd'));
  assert.equal(builder.toHex(), '0c02abcd');

  // HexString inputs round-trip unchanged
  assert.equal(
    sc.ContractParam.byteArray(u.HexString.fromHex('abcd', true)).toJSON().value,
    Buffer.from('abcd', 'hex').toString('base64'),
  );
});

test('empty ByteArray params encode as zero bytes — the empty preview signature stays empty', () => {
  for (const empty of ['', '0x']) {
    const param = sc.ContractParam.fromJson({ type: 'ByteArray', value: empty });
    assert.equal(param.toJSON().value, '', `'${empty}' must serialize to an empty base64 payload`);

    const builder = new sc.ScriptBuilder();
    builder.emitPush(param);
    // PUSHDATA1 with zero length
    assert.equal(builder.toHex(), '0c00');
  }
});

test('RPCClient.send times out hung nodes with EC.NETWORK_TIMEOUT', async () => {
  const { server, url } = await listen(() => {
    // Never respond — simulates a hung node.
  });
  try {
    const client = new rpc.RPCClient(url, { timeoutMs: 100 });
    await assert.rejects(
      () => client.send('getversion'),
      (error) => {
        assert.equal(error.code, EC.NETWORK_TIMEOUT.code);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test('RPCClient.send surfaces HTTP gateway errors with the status in the message', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>Bad Gateway</html>');
  });
  try {
    const client = new rpc.RPCClient(url, { timeoutMs: 2000 });
    await assert.rejects(
      () => client.send('getversion'),
      (error) => {
        assert.equal(error.code, EC.NETWORK_RPC_CONNECTION_FAILED.code);
        assert.match(error.message, /502/);
        assert.equal(isRetryableError(error), true,
          'gateway errors must be classified as retryable by the retry layer');
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test('RPCClient.send wraps non-JSON 200 responses in a network-coded error', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json');
  });
  try {
    const client = new rpc.RPCClient(url, { timeoutMs: 2000 });
    await assert.rejects(
      () => client.send('getversion'),
      (error) => {
        assert.equal(error.code, EC.NETWORK_RPC_CONNECTION_FAILED.code);
        assert.match(error.message, /non-JSON/);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test('RPCClient.send still returns results and maps JSON-RPC errors', async () => {
  const { server, url } = await listen((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (request.method === 'getblockcount') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 42 }));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }));
      }
    });
  });
  try {
    const client = new rpc.RPCClient(url, { timeoutMs: 2000 });
    assert.equal(await client.send('getblockcount'), 42);
    await assert.rejects(() => client.send('bogus'), /Method not found/);
  } finally {
    await closeServer(server);
  }
});


test('RPCClient.send preserves JSON-RPC code and structured data for submission classification', async () => {
  const data = { reason: 'AlreadyExists', txid: '0x' + 'ab'.repeat(32), nested: { retryable: false } };
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -501, message: 'Already exists', data } }));
  });
  try {
    const client = new rpc.RPCClient(url);
    await assert.rejects(() => client.send('sendrawtransaction', ['AA==']), (error) => {
      assert.equal(error.message, 'Already exists');
      assert.equal(error.code, -501);
      assert.deepEqual(error.data, data);
      return true;
    });
  } finally {
    await closeServer(server);
  }
});
