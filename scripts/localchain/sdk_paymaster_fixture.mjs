// Builds a sponsored v4 execution plan with the SDK's own builder and prints it.
// `usage: node sdk_paymaster_fixture.mjs <request.json>` (request on argv, one JSON object on stdout).
//
// The request carries the 13-field operation and the sponsorship values; nothing is hard-coded to a
// particular chain, so the caller can drive the plan on a disposable chain. Two modes:
//
//   "plan"   (default) build the plan, check it, and print the invocation script a relay submits.
//   "digest"  print the operation digest a validator signs for that request. The digest is the one
//             the core recomputes (§4.3), so the caller signs exactly the bytes the chain verifies.
//
// Before printing, the plan is checked against the request for the properties a sponsored invocation
// needs: the envelope carries exactly the five arguments of §4.2, the embedded operation is the same
// 13 fields an unsponsored execution carries, its argument list is made only of the operand kinds
// §4.1 admits (a value the grammar cannot classify is refused rather than silently carried), a batch
// reproduces its operations in order, and the plan survives a JSON round trip unchanged.
//
// Target: the retired custom v4 wallet kernel (contracts/build), driven by scenario SA-11 of
// sa_rpc_scenarios.py. The sponsored entries executeSponsoredUserOp/executeSponsoredUserOps are that
// kernel's ABI and are not in the v4.1 native IDL (docs/proposals/smartaccount-v4.1.idl.json).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SA = fileURLToPath(new URL('../../', import.meta.url));
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sdkRequire = createRequire(`${SA}/sdk/js/package.json`);
const { SmartAccountClient, codec } = sdkRequire(`${SA}/sdk/js/src/index.js`);

function emit(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(body.ok ? 0 : 1);
}

// An SDK refusal is the answer to an invalid request, not a crash: report the code and the hint, so a
// caller can tell "the builder refused this" from "the fixture could not run".
process.on('uncaughtException', (error) => {
  emit({ ok: false, error: String(error?.message || error), code: error?.code || '', hint: error?.details?.hint || '' });
});

const hex = (value) => codec.hex(value, 20);
// One operation, or an ordered batch of them. The batch form is what the builder selects on;
// nothing in the request decides a method name.
const operations = request.operations ? [...request.operations] : request.operation ? [request.operation] : [];
if (operations.length === 0) emit({ ok: false, error: 'request.operation or request.operations is required' });

const client = new SmartAccountClient({
  rpcUrl: request.rpcUrl,
  networkMagic: request.networkMagic,
  contractHash: request.core,
});

// The digest a validator signs: the operation with the signature field emptied, under the §4.3
// domain. Returned before any plan is built, because a caller needs it to produce the signature the
// plan then carries.
if (request.mode === 'digest') {
  const digest = codec.operationDigest(
    { networkMagic: request.networkMagic, coreContractHash: request.core, accountId: request.accountId },
    operations[0],
  );
  emit({ ok: true, mode: 'digest', digest, preimage: codec.operationPreimage(
    { networkMagic: request.networkMagic, coreContractHash: request.core, accountId: request.accountId },
    operations[0],
  ) });
}

const plan = JSON.parse(JSON.stringify(client.buildSponsoredExecutionScript({
  accountId: request.accountId,
  operations,
  paymaster: request.paymaster,
  sponsor: request.sponsor,
  reimbursementAmount: request.reimbursementAmount,
})));

// 1. Plan shape: one envelope, five arguments, the operations in the order they were requested.
if (plan.kind !== 'execution') emit({ ok: false, error: `the plan is a ${plan.kind} plan, not an execution` });
if (plan.method !== (operations.length === 1 ? 'executeSponsoredUserOp' : 'executeSponsoredUserOps')) {
  emit({ ok: false, error: `the plan names ${plan.method} for ${operations.length} operations` });
}
if (plan.batch !== (operations.length !== 1)) emit({ ok: false, error: 'the plan batch flag does not match its operation count' });
if (plan.accountId !== hex(request.accountId)) emit({ ok: false, error: 'the plan does not name the requested account' });
if (plan.paymaster !== hex(request.paymaster)) emit({ ok: false, error: 'the plan does not name the requested paymaster' });
if (plan.sponsor !== hex(request.sponsor)) emit({ ok: false, error: 'the plan does not name the requested sponsor' });
if (plan.reimbursementAmount !== String(request.reimbursementAmount)) {
  emit({ ok: false, error: 'the plan does not carry the requested reimbursement amount' });
}

// 2. Operations: the same 13 fields, in order, with an argument list made only of §4.1 operands.
// A Struct, Map, Any or v3 hash kind anywhere in the list is named rather than carried: the codec
// already refused them while building, and this reads the encoded value back to show it stayed so.
const operandType = (value) => {
  if (!value || typeof value !== 'object') return 'missing';
  if (!['Null', 'Boolean', 'Integer', 'ByteString', 'Array'].includes(value.type)) return value.type;
  if (value.type !== 'Array') return '';
  for (const entry of value.value) {
    const nested = operandType(entry);
    if (nested) return nested;
  }
  return '';
};
const values = plan.operations.map((operation) => codec.operationValue(operation));
for (const [index, value] of values.entries()) {
  if (value.value.length !== 13) emit({ ok: false, error: `operation ${index} carries ${value.value.length} fields, not 13` });
  const args = value.value[3];
  if (args.type !== 'Array') emit({ ok: false, error: `operation ${index} does not carry its arguments as an Array` });
  const unsupported = operandType(args);
  if (unsupported) emit({ ok: false, error: `operation ${index} carries a ${unsupported} argument, which §4.1 does not admit` });
}
if (values.length !== operations.length) emit({ ok: false, error: `the plan carries ${values.length} operations, not ${operations.length}` });
for (const [index, operation] of operations.entries()) {
  if (plan.operations[index].nonce !== operation.nonce) emit({ ok: false, error: `operation ${index} does not carry the requested nonce` });
  if (plan.operations[index].signature !== operation.signature) emit({ ok: false, error: `operation ${index} does not carry the requested signature` });
}

// 3. The script is the envelope written out independently of the builder: account, operation (or the
// ordered operation list), paymaster, sponsor, reimbursement.
const expected = codec.dynamicCall(request.core, plan.method, [
  codec.hashValue(hex(request.accountId)),
  values.length === 1 ? values[0] : { type: 'Array', value: values },
  codec.hashValue(hex(request.paymaster)),
  codec.hashValue(hex(request.sponsor)),
  codec.integerValue(codec.unsigned(request.reimbursementAmount, 63, 'reimbursement')),
]);
if (plan.script !== expected) emit({ ok: false, error: 'the plan script is not the envelope its own fields describe' });

// 4. Transport: the plan a caller receives is the plan the fixture checked, JSON in and JSON out.
const echoed = JSON.parse(JSON.stringify(plan));
if (JSON.stringify(echoed) !== JSON.stringify(plan)) emit({ ok: false, error: 'the plan does not survive a JSON round trip' });

emit({
  ok: true,
  mode: 'plan',
  kind: plan.kind,
  method: plan.method,
  batch: plan.batch,
  accountId: plan.accountId,
  accountAddress: plan.accountAddress,
  paymaster: plan.paymaster,
  sponsor: plan.sponsor,
  reimbursementAmount: plan.reimbursementAmount,
  proxyCallFlags: plan.proxyCallFlags,
  operationFields: values[0].value.length,
  argumentTypes: values.map((value) => value.value[3].value.map((item) => item.type)),
  script: Buffer.from(plan.script, 'hex').toString('base64'),
});
