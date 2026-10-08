// Builds a sponsored-operation meta-invocation with the SDK's own payload builder and prints it,
// with the invocation script the relay route would produce from it. `usage: node
// sdk_paymaster_fixture.mjs <request.json>` (request on argv, result on stdout, one JSON object).
//
// The request carries the operation and the sponsorship values; nothing is hard-coded to a
// particular chain, so the caller can drive the payload on a disposable chain. The payload is
// checked for the properties a relay-ready payload needs before it is printed: the argument list of
// the inner operation must keep its parameter types (no untyped carrier), and the JSON round trip
// must not change it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const AA = fileURLToPath(new URL('../../', import.meta.url));
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sdkRequire = createRequire(`${AA}/sdk/js/package.json`);
const { AbstractAccountClient } = sdkRequire(`${AA}/sdk/js/src/index.js`);
const { sc } = sdkRequire('@cityofzion/neon-js');

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

const client = new AbstractAccountClient(request.rpcUrl, request.core);
// The payload has to survive the transport the relay uses: JSON in, JSON out, unchanged. Everything
// below inspects the serialised form, so a payload whose parameter kinds only exist in memory is
// caught here instead of at the relay.
const payload = JSON.parse(JSON.stringify(client.createSponsoredUserOpPayload({
  accountScriptHash: request.accountId,
  userOp: {
    TargetContract: request.target,
    Method: request.method,
    Args: request.args || [],
    Nonce: request.nonce,
    Deadline: request.deadline,
    Signature: request.signatureHex || '',
  },
  paymasterHash: request.paymaster,
  sponsorAddress: request.sponsor,
  reimbursementAmount: request.reimbursementAmount,
})));

if (!payload || payload.operation !== 'executeSponsoredUserOp') fail('payload operation is not executeSponsoredUserOp');
const opParam = payload.args?.[1];
// The inner operation is a NeoVM struct; the payload layer serialises structs and arrays with the
// same parameter kind, so both names describe the same wire value here.
if (!['Array', 'Struct'].includes(opParam?.type) || !Array.isArray(opParam.value)) fail('the inner operation is not carried as an array parameter');
const argsParam = opParam.value[2];
if (argsParam?.type !== 'Array') fail(`the inner argument list is not an Array parameter (got ${argsParam?.type})`);
if (JSON.stringify(argsParam).includes('"Any"')) fail('the inner argument list carries an untyped parameter');

const args = payload.args.map((param) => sc.ContractParam.fromJson(param));
const script = sc.createScript({ scriptHash: payload.scriptHash, operation: payload.operation, args });

process.stdout.write(`${JSON.stringify({
  ok: true,
  payload,
  script: Buffer.from(script, 'hex').toString('base64'),
  argsParameter: { type: argsParam.type, value: argsParam.value.length, types: argsParam.value.map((item) => item.type) },
})}\n`);
