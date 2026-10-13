// Builds a sponsored-operation meta-invocation with the SDK's own payload builder and prints it,
// with the invocation script the relay route would produce from it. `usage: node
// sdk_paymaster_fixture.mjs <request.json>` (request on argv, result on stdout, one JSON object).
//
// The request carries the operation and the sponsorship values; nothing is hard-coded to a
// particular chain, so the caller can drive the payload on a disposable chain. Before printing, the
// payload is checked against the request for the two properties a relay-ready sponsored invocation
// needs: the inner operation must be reproduced field by field with its argument types intact (a
// value the payload cannot classify is refused rather than silently carried as an untyped
// parameter), and the whole payload must survive a JSON round trip unchanged.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// The relay turns a payload into an invocation with this module (the relay route imports the same
// one). It is deliberately not neon-js's ContractParam.fromJson: a relay DTO spells ByteArray as
// explicit 0x hex, while ContractParam.fromJson reads an RPC JSON ByteArray as base64, so decoding a
// payload with it turns a 64-byte signature into 65 bytes and the account's verifier refuses the
// operation on chain.
import { normalizeRelayContractParameter } from '../../shared/relayContractParameter.mjs';
import { canonicalByteHex, compareSponsArgs, sameValue } from './sponsoredArgumentComparison.mjs';

const AA = fileURLToPath(new URL('../../', import.meta.url));
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sdkRequire = createRequire(`${AA}/sdk/js/package.json`);
const { AbstractAccountClient } = sdkRequire(`${AA}/sdk/js/src/index.js`);
const { sc, u } = sdkRequire('@cityofzion/neon-js');

// The relay's typed byte boundary, as an object array the script builder can emit.
function relayArguments(payload) {
  return JSON.parse(JSON.stringify(payload.args)).map((parameter) => {
    const normalized = normalizeRelayContractParameter(parameter, { depth: 0, byteEncoding: 'hex', allowClasses: true });
    return toRpcParameter(normalized);
  });
}

// Matches the frontend relay route's own conversion of a normalized relay DTO.
function toRpcParameter(parameter) {
  switch (parameter.type) {
    case 'Hash160': return sc.ContractParam.hash160(parameter.value);
    case 'Hash256': return sc.ContractParam.hash256(parameter.value);
    case 'PublicKey': return sc.ContractParam.publicKey(parameter.value);
    case 'Integer': return sc.ContractParam.integer(parameter.value);
    case 'Boolean': return sc.ContractParam.boolean(parameter.value);
    case 'String': return sc.ContractParam.string(parameter.value);
    case 'ByteArray': return sc.ContractParam.byteArray(u.HexString.fromHex(parameter.value.slice(2), true));
    case 'Array': return sc.ContractParam.array(...parameter.value.map(toRpcParameter));
    case 'Map': return sc.ContractParam.map(...parameter.value.map((entry) => ({ key: toRpcParameter(entry.key), value: toRpcParameter(entry.value) })));
    case 'Any': return sc.ContractParam.any(null);
    default: throw new Error(`the relay cannot carry a ${parameter.type} parameter`);
  }
}

function emit(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(body.ok ? 0 : 1);
}

function fail(message) {
  emit({ ok: false, error: message });
}

// An SDK refusal is the answer to an invalid request, not a crash: report the code and the hint, so a
// caller can tell "the builder refused this" from "the fixture could not run".
process.on('uncaughtException', (error) => {
  emit({ ok: false, error: String(error?.message || error), code: error?.code || '', hint: error?.details?.hint || '' });
});

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// The requested arguments, and the copy this fixture holds them to. They are the same object today;
// keeping the expectation separate from what the builders receive is what lets the argument walk be
// exercised against a planted expectation without changing the request.
const requestArgs = request.args || [];
const expectedArgs = requestArgs;

const client = new AbstractAccountClient(request.rpcUrl, request.core);
// The payload has to survive the transport the relay uses: JSON in, JSON out, unchanged. Everything
// below inspects the serialised form, so a payload whose parameter kinds only exist in memory is
// caught here instead of at the relay.
const payload = JSON.parse(JSON.stringify(client.createSponsoredUserOpPayload({
  accountScriptHash: request.accountId,
  userOp: {
    TargetContract: request.target,
    Method: request.method,
    Args: requestArgs,
    Nonce: request.nonce,
    Deadline: request.deadline,
    Signature: request.signatureHex || '',
  },
  paymasterHash: request.paymaster,
  sponsorAddress: request.sponsor,
  reimbursementAmount: request.reimbursementAmount,
})));

if (!payload || payload.operation !== 'executeSponsoredUserOp') fail('payload operation is not executeSponsoredUserOp');
if (payload.args?.length !== 5) fail(`the payload carries ${payload.args?.length} contract arguments, not 5`);
const opParam = payload.args?.[1];
// The inner operation is a NeoVM struct; the payload layer serialises structs and arrays with the
// same parameter kind, so both names describe the same wire value here.
if (!['Array', 'Struct'].includes(opParam?.type) || !Array.isArray(opParam.value)) fail('the inner operation is not carried as an array parameter');
if (opParam.value.length !== 6) fail(`the inner operation carries ${opParam.value.length} fields, not 6`);
const argsParam = opParam.value[2];
if (argsParam?.type !== 'Array') fail(`the inner argument list is not an Array parameter (got ${argsParam?.type})`);
if (JSON.stringify(argsParam).includes('"Any"')) fail('the inner argument list carries an untyped parameter');
if (argsParam.value.length !== expectedArgs.length) {
  fail(`the inner argument list carries ${argsParam.value.length} arguments, not ${expectedArgs.length}`);
}

// A byte string has one identity on the wire and two spellings at this boundary, and the fixture makes
// two field-level checks outside the argument walk: the signature and the hash-valued fields. They use
// the comparison module's own normalisation so one rule covers the whole payload.
const byteHex = canonicalByteHex;
const hex = (value) => String(value ?? '').replace(/^0x/i, '').toLowerCase();

// The payload must reproduce the requested operation, argument by argument: a swapped, dropped,
// re-typed or re-ordered argument changes the signed arguments hash and would no longer execute. The
// comparison itself lives in sponsoredArgumentComparison.mjs so that its recursion over every nested
// parameter kind is exercised directly, not only through this script.
const comparison = compareSponsArgs(argsParam.value, expectedArgs);
if (comparison.difference) {
  // The walk's own verdict is reported before any other check, so a refusal always names the nested
  // parameter it caught rather than whatever unrelated assertion runs next.
  fail(`the payload does not reproduce the operation: ${comparison.difference}`);
}

if (!sameValue(opParam.value[0].value, request.target, 'Hash160')) fail('the payload does not name the requested target');
if (opParam.value[1].value !== request.method) fail('the payload does not name the requested method');
if (String(opParam.value[3].value) !== String(request.nonce)) fail('the payload does not carry the requested nonce');
if (String(opParam.value[4].value) !== String(request.deadline)) fail('the payload does not carry the requested deadline');
if (byteHex(opParam.value[5].value) !== hex(request.signatureHex)) fail('the payload does not carry the requested signature');
if (!sameValue(payload.args[0].value, request.accountId, 'Hash160')) fail('the payload does not name the requested account');
if (!sameValue(payload.args[2].value, request.paymaster, 'Hash160')) fail('the payload does not name the requested paymaster');
if (!sameValue(payload.args[3].value, request.sponsor, 'Hash160')) fail('the payload does not name the requested sponsor');
if (String(payload.args[4].value) !== String(request.reimbursementAmount)) fail('the payload does not carry the requested reimbursement amount');

const args = relayArguments(payload);
const script = sc.createScript({ scriptHash: payload.scriptHash, operation: payload.operation, args });

// The batch builder carries its per-operation arguments through the same path, so a payload built
// with one operation must describe that operation the same way the single-operation builder does.
const batch = JSON.parse(JSON.stringify(client.createSponsoredBatchPayload({
  accountScriptHash: request.accountId,
  userOps: [{
    TargetContract: request.target, Method: request.method, Args: requestArgs,
    Nonce: request.nonce, Deadline: request.deadline, Signature: request.signatureHex || '',
  }],
  paymasterHash: request.paymaster,
  sponsorAddress: request.sponsor,
  reimbursementAmount: request.reimbursementAmount,
})));
if (batch.operation !== 'executeSponsoredUserOps') fail('the batch payload operation is not executeSponsoredUserOps');
const batchOps = batch.args?.[1]?.value || [];
if (batchOps.length !== 1) fail(`the batch payload carries ${batchOps.length} operations, not 1`);
const batchOp = batchOps[0];
const batchArgsParam = Array.isArray(batchOp) ? batchOp[2] : batchOp?.value?.[2];
if (!same(batchOp, opParam) || !same(batchArgsParam, argsParam)) {
  fail('the batch payload does not carry the same typed arguments as the single-operation payload');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  payload,
  script: Buffer.from(script, 'hex').toString('base64'),
  batchArgsTypes: (batchArgsParam?.value || []).map((item) => item.type),
  argsParameter: { type: argsParam.type, value: argsParam.value.length, types: argsParam.value.map((item) => item.type) },
  inspection: comparison.inspection,
})}\n`);
