/**
 * The v4 transaction lifecycle: review, sign, export, preflight, broadcast and
 * receipt, over the real client and a fake node.
 *
 * v4 collapsed the v3 authority machinery: there is no authority list, no
 * verifier roster and no cancellation policy in a plan. The account state is
 * the authority, and the custody witness (or the witness of an installed
 * validator) is the only witness a native account action asks for: the minimal
 * core has no permissionless action left, so recovery and configuration
 * transitions cannot be signed here at all. An execution is authorized by the
 * signature inside the operation. What this suite pins is that the lifecycle
 * cannot be talked out of any of those gates, and that no wallet is called
 * before the fees, the block window and the simulation have all been checked.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createProxyWitness } = require("../../../shared/proxyWitness.mjs");
const {
  ACCOUNT,
  ANY,
  ARG_HASH,
  A,
  BOOL,
  CAPS,
  GOVERNANCE,
  I,
  RECOVERY,
  RECOVERY_MODULE_ID,
  build,
  c,
  clone,
  createNode,
  executionReview,
  operation,
  registrationReview,
  wallet,
} = require("./helpers/nativeTransactionNode");

/** A module contract hash: an install names it, a removal names the id instead. */
const MODULE = "44".repeat(20);

/** A wallet that records every call, so "no wallet was touched" is provable. */
function spyWallet() {
  const base = wallet();
  const calls = [];
  const spy = {
    account: base.account,
    verificationScript: base.verificationScript,
    calls,
    sign(signData) {
      calls.push(signData);
      return base.sign(signData);
    },
  };
  return spy;
}

const prepare = (node, plan, options) => node.client.prepareTransaction(plan, options);
const options = (feePayer, extra = {}) => ({ feePayer, ...CAPS, systemFee: "200", nonce: 42, ...extra });

function descriptors(artifact) {
  return artifact.transaction.signers;
}

function staged(artifact, stack = [{ type: "Boolean", value: true }]) {
  return {
    tx: { hash: artifact.txid, blockhash: "0x" + "cc".repeat(32) },
    wire: Buffer.from(artifact.rawTransaction, "hex").toString("base64"),
    log: {
      txid: artifact.txid,
      executions: [{ trigger: "Application", vmstate: "HALT", stack }],
    },
    preflight: {
      hash: artifact.txid,
      network: artifact.networkMagic,
      snapshot: { height: 99, hash: "0x" + "aa".repeat(32) },
      simulation: {
        mode: "single-transaction-next-block",
        height: 100,
        timestamp: "1700000000000",
        primaryIndex: 0,
        view: 0,
        transactionCount: 1,
        onPersist: "HALT",
        nextConsensus: "0x" + "bb".repeat(20),
      },
      verification: "Succeed",
      state: "HALT",
      relayed: false,
      mempoolChecked: false,
      gasconsumed: "10",
      stack,
    },
  };
}

test("the payer is signer 0 at scope None and the account proxy is signer 1 with one core rule", async () => {
  const node = createNode();
  node.setAccount({ custody: wallet().account });
  const { artifact, plan, payer } = await executionReview(node);
  const [payerSigner, proxySigner] = descriptors(artifact);
  assert.deepEqual(payerSigner, { account: "0x" + payer.account, scopes: "None" });
  assert.equal(proxySigner.account, "0x" + plan.accountAddress);
  assert.equal(proxySigner.scopes, "WitnessRules");
  assert.deepEqual(proxySigner.rules, [
    { action: "Allow", condition: { type: "CalledByContract", hash: node.client.contractHash } },
  ]);
  // The proxy witness is the shared v4 script, not a second construction.
  const expected = createProxyWitness({
    coreHash: node.client.contractHash,
    accountId: ACCOUNT,
    proxyHash: plan.accountAddress,
    feePayer: payer.account,
    callFlags: plan.proxyCallFlags,
  });
  assert.equal(artifact.witnesses[1].verification, expected.witness.verificationScript);
  assert.equal(artifact.witnesses[1].invocation, "");
  assert.equal(artifact.witnesses[0].verification, payer.verificationScript);
  assert.match(artifact.witnesses[0].invocation, /^0c40[0-9a-f]{128}$/);
});

test("only the fee payer may carry the None scope; an authority is scoped to the core", async () => {
  const node = createNode();
  const custodian = spyWallet();
  node.setAccount({ custody: custodian.account });
  const { plan, recipe } = build.account(node, { method: "freezeAccount" });
  const prepared = await prepare(node, plan, options(spyWallet(), { authorizers: [custodian], recipe }));
  assert.deepEqual(descriptors(prepared).slice(1), [
    {
      account: "0x" + custodian.account,
      scopes: "CustomContracts",
      allowedcontracts: ["0x" + node.client.contractHash],
    },
  ]);
  // None is only ever honoured for the payer: a custody witness scoped to
  // nothing would leave Runtime.CheckWitness unverified inside the core.
  assert.equal(descriptors(prepared)[0].scopes, "None");
});

test("a fee payer that is also custody receives the actual core witness scope", async () => {
  const node = createNode();
  const custody = spyWallet();
  node.setAccount({ custody: custody.account });
  const { plan, recipe } = build.account(node, { method: "freezeAccount" });
  const prepared = await prepare(node, plan, options(custody, { recipe }));
  assert.deepEqual(descriptors(prepared), [{ account: "0x" + custody.account,
    scopes: "CustomContracts", allowedcontracts: ["0x" + node.client.contractHash] }]);
});

test("a recovery review signs with custody and the newly introduced wallet", async () => {
  const node = createNode();
  const custody = spyWallet(), recipient = spyWallet();
  node.setAccount({ custody: custody.account });
  node.setRecoverySeat();
  const recipe = { method: "buildRecoveryModulePlan", input: { accountId: ACCOUNT,
    action: "beginRecovery", newCustody: recipient.account } };
  const plan = await node.client.buildRecoveryModulePlan(recipe.input);
  // Recovery is a user-space seat: the script targets the module, never the core.
  assert.equal(plan.kind, "recovery");
  assert.equal(plan.targetContract, RECOVERY);
  assert.equal(plan.governanceDelayMs, null);
  assert.equal(plan.policy.threshold, 1);
  await assert.rejects(prepare(node, plan, options(custody, { recipe })), /missing authority witness/);
  // beginRecovery answers the allocated request nonce.
  node.state.simulate = { state: "HALT", stack: [I(1)], gasconsumed: "10" };
  const prepared = await prepare(node, plan, options(custody, { recipe, authorizers: [recipient] }));
  assert.deepEqual(descriptors(prepared), [custody, recipient].map(({ account }) => ({
    account: "0x" + account, scopes: "CustomContracts", allowedcontracts: ["0x" + RECOVERY]
  })));
  const signed = await node.client.signTransaction(prepared);
  // A beginRecovery receipt carries the request nonce the module allocated.
  Object.assign(node.state, staged(node.client.exportSignedTransaction(signed), [I(1)]));
  node.setAccount({ custody: recipient.account, status: 1 });
  assert.equal((await node.client.getTransactionReceipt(signed)).succeeded, true);
});

test("a thaw review signs the governance module's call with custody, scoped to the module", async () => {
  const node = createNode();
  const custody = spyWallet(), payer = spyWallet();
  node.setAccount({ custody: custody.account, status: 1, configurationNonce: 3 });
  // No governance instance: the core's own thaw is not a route the SDK can sign.
  node.answer("getModules", [ARG_HASH(ACCOUNT), c.stringValue("validator"), I(0), I(32)], A([A([]), I(0), I(0)]));
  await assert.rejects(
    node.client.buildGovernanceModulePlan({ accountId: ACCOUNT, action: "unfreezeAccount" }),
    /no supported governance module installed/,
  );
  node.setGovernanceSeat();
  const recipe = { method: "buildGovernanceModulePlan", input: { accountId: ACCOUNT, action: "unfreezeAccount" } };
  const plan = await node.client.buildGovernanceModulePlan(recipe.input);
  // The thaw is a module plan: its script targets the governance instance.
  assert.equal(plan.kind, "governance");
  assert.equal(plan.targetContract, GOVERNANCE);
  assert.deepEqual(plan.signers, [custody.account]);
  assert.notEqual(plan.script, node.client.buildAccountActionScript({ method: "unfreezeAccount", accountId: ACCOUNT, args: [] }).script);
  // The node's Void answer is not the intent id a proposal must return.
  await assert.rejects(
    prepare(node, plan, options(payer, { authorizers: [custody], recipe })),
    /positive intent id/,
  );
  node.state.simulate = { state: "HALT", stack: [I(4)], gasconsumed: "10" };
  // A payer alone is not custody: the module's RequireCustody would fault on chain.
  await assert.rejects(prepare(node, plan, options(payer, { recipe })), /missing authority witness/);
  // Only the governance recipe rebuilds this plan; a core action recipe does not.
  await assert.rejects(
    prepare(node, plan, options(payer, { authorizers: [custody],
      recipe: { method: "buildAccountActionScript", input: { method: "unfreezeAccount", accountId: ACCOUNT, args: [] } } })),
    /does not rebuild the plan/,
  );
  const prepared = await prepare(node, plan, options(payer, { authorizers: [custody], recipe }));
  // Custody is scoped to the module, not to the core.
  assert.deepEqual(descriptors(prepared), [
    { account: "0x" + payer.account, scopes: "None" },
    { account: "0x" + custody.account, scopes: "CustomContracts", allowedcontracts: ["0x" + GOVERNANCE] },
  ]);
  const signed = await node.client.signTransaction(prepared);
  // The proposal's receipt carries the intent id the module allocated, and it
  // stays readable after the account has moved on.
  Object.assign(node.state, staged(node.client.exportSignedTransaction(signed), [I(4)]));
  node.setAccount({ custody: custody.account, status: 1, configurationNonce: 3 });
  node.setGovernanceSeat({ intents: [{ intentId: 4, kind: "unfreeze", proposedAt: 1699996400000,
    matureAt: 1699999999000, expiresAt: 1700604799000, epoch: 1, nonce: 3, actionCount: 1 }] });
  assert.equal((await node.client.getTransactionReceipt(signed)).succeeded, true);

  // Confirmation: once the intent is pending, the step is confirmConfiguration
  // with the exact [[11]] action bytes, still custody-signed on the module.
  await assert.rejects(
    node.client.buildGovernanceModulePlan(recipe.input),
    /an unfreeze intent is already pending/,
  );
  const confirmRecipe = { method: "buildGovernanceModulePlan", input: { accountId: ACCOUNT, action: "confirmConfiguration", intentId: "4" } };
  const confirm = await node.client.buildGovernanceModulePlan(confirmRecipe.input);
  assert.equal(confirm.method, "confirmConfiguration");
  assert.equal(confirm.intentId, "4");
  assert.equal(confirm.script, c.dynamicCall(GOVERNANCE, "confirmConfiguration", [
    c.hashValue(ACCOUNT), I(4), A([A([I(11)])])]));
  node.state.simulate = { state: "HALT", stack: [ANY], gasconsumed: "10" };
  // The recipe names the intent that was reviewed; another one rebuilds another plan.
  await assert.rejects(
    prepare(node, confirm, options(payer, { authorizers: [custody],
      recipe: { ...confirmRecipe, input: { ...confirmRecipe.input, intentId: "5" } } })),
    /intent changed|does not rebuild/,
  );
  const confirmPrepared = await prepare(node, confirm, options(payer, { authorizers: [custody], recipe: confirmRecipe }));
  assert.deepEqual(descriptors(confirmPrepared), descriptors(prepared));
  const confirmSigned = await node.client.signTransaction(confirmPrepared);
  // The landed thaw leaves the account active with an advanced nonce; the
  // archived confirmation is still restorable for its receipt.
  Object.assign(node.state, staged(node.client.exportSignedTransaction(confirmSigned), [ANY]));
  node.setAccount({ custody: custody.account, status: 0, configurationNonce: 4 });
  assert.equal((await node.client.getTransactionReceipt(confirmSigned)).succeeded, true);
});

test("a recovery plan requires the reviewed seat and reports an unknown one as unsupported", async () => {
  const node = createNode();
  const custody = spyWallet(), recipient = spyWallet();
  node.setAccount({ custody: custody.account });
  // No seat installed: there is no native recovery entry to fall back to.
  await assert.rejects(
    node.client.buildRecoveryModulePlan({ accountId: ACCOUNT, action: "beginRecovery", newCustody: recipient.account }),
    /no supported recovery seat installed/,
  );
  // A seat whose code or profile is not the reviewed one is reported, not driven.
  node.setRecoverySeat({ nefSha256: "ab".repeat(32) });
  assert.deepEqual(await node.client.getRecoverySeat(ACCOUNT), { seat: (await node.client.getModule(ACCOUNT, RECOVERY_MODULE_ID)), supported: false });
  await assert.rejects(
    node.client.buildRecoveryModulePlan({ accountId: ACCOUNT, action: "beginRecovery", newCustody: recipient.account }),
    /no supported recovery seat installed/,
  );
  // A new custody may not be the account's own proxy, the core or the seat.
  node.setRecoverySeat();
  await assert.rejects(
    node.client.buildRecoveryModulePlan({ accountId: ACCOUNT, action: "beginRecovery",
      newCustody: node.client.proxyAddress(ACCOUNT) }),
    /invalid new custody/,
  );
  await assert.rejects(
    node.client.buildRecoveryModulePlan({ accountId: ACCOUNT, action: "beginRecovery", authority: recipient.account }),
    /Only custody, the recovery authority or a guardian/,
  );
});

test("a direct batch requires the custody witness and its receipt survives a later account change", async () => {
  const node = createNode();
  const custody = spyWallet();
  node.setAccount({ custody: custody.account });
  const recipe = { method: "buildConfigurationBatchPlan", input: { accountId: ACCOUNT, actions: [
    { method: "installModule", moduleType: 1, moduleContractHash: MODULE,
      profileDigest: "77".repeat(32), initData: [] },
    { method: "setBuiltinAuthorization", defaultOperationAuthorization: true, defaultMessageAuthorization: false }] } };
  const plan = await node.client.buildConfigurationBatchPlan(recipe.input);
  assert.equal(plan.method, "applyConfigurationActions");
  assert.deepEqual(plan.signers, [custody.account]);
  const stranger = spyWallet();
  await assert.rejects(prepare(node, plan, options(stranger, { recipe })), /missing authority witness/);
  const prepared = await prepare(node, plan, options(stranger, { recipe, authorizers: [custody] }));
  assert.deepEqual(descriptors(prepared), [
    { account: "0x" + stranger.account, scopes: "None" },
    { account: "0x" + custody.account, scopes: "CustomContracts", allowedcontracts: ["0x" + node.client.contractHash] },
  ]);
  const signed = await node.client.signTransaction(prepared);
  Object.assign(node.state, staged(node.client.exportSignedTransaction(signed), [{ type: "Any" }]));
  node.setAccount({ custody: custody.account, status: 1 });
  await assert.rejects(node.client.preflightTransaction(signed), /configuration changed/);
  const receipt = await node.client.getTransactionReceipt(signed);
  assert.equal(receipt.confirmed, true);
  assert.equal(receipt.succeeded, true);
});

test("registration asks for the custody witness and refuses any other", async () => {
  const node = createNode();
  const custody = spyWallet();
  const stranger = spyWallet();
  const { plan, recipe } = build.registration(node, { custody });
  await assert.rejects(
    prepare(node, plan, options(spyWallet(), { recipe })),
    /missing authority witness/,
  );
  await assert.rejects(
    prepare(node, plan, options(spyWallet(), { recipe, authorizers: [stranger] })),
    /missing authority witness/,
  );
  const prepared = await prepare(node, plan, options(spyWallet(), { recipe, authorizers: [custody] }));
  assert.deepEqual(descriptors(prepared).map((signer) => signer.account), [
    "0x" + prepared.review.feePayer,
    "0x" + custody.account,
  ]);
  // A payer that is also the custody authority is one signer, not two.
  const both = await prepare(node, plan, options(custody, { recipe, authorizers: [custody] }));
  assert.equal(descriptors(both).length, 1);
  // One account cannot present two verification scripts.
  const impostor = { ...custody, verificationScript: wallet().verificationScript };
  await assert.rejects(
    prepare(node, plan, options(spyWallet(), { recipe, authorizers: [impostor] })),
    /does not match verification script hash/,
  );
});

test("account actions are custody-gated and carry their operands verbatim", async () => {
  const node = createNode();
  const custody = wallet();
  node.setAccount({ custody: custody.account });
  const freeze = build.account(node, { method: "freezeAccount" });
  await assert.rejects(prepare(node, freeze.plan, options(wallet(), { recipe: freeze.recipe })), /missing authority witness/);
  await assert.doesNotReject(prepare(node, freeze.plan, options(wallet(), { recipe: freeze.recipe, authorizers: [custody] })));

  // Module administration is the same gate, and its operands are protocol
  // values: the module type, the module contract and the initData array.
  const install = build.account(node, {
    method: "installModule",
    args: [I(1), c.hashValue(MODULE), A([])],
  });
  await assert.rejects(
    prepare(node, install.plan, options(wallet(), { recipe: install.recipe })),
    /missing authority witness/,
  );
  for (const item of [{ type: "Boolean", value: true }, I(0), I(-1), I("18446744073709551615")]) {
    node.state.simulate.stack = [item];
    await assert.rejects(prepare(node, install.plan, options(wallet(), { recipe: install.recipe, authorizers: [custody] })), /allocated module ID/);
  }
  node.state.simulate.stack = [I(3)];
  const prepared = await prepare(node, install.plan, options(wallet(), { recipe: install.recipe, authorizers: [custody] }));
  assert.equal(prepared.review.plan.method, "installModule");
  assert.equal(descriptors(prepared).length, 2);

  // Removing a module names the id the core allocated, never the contract.
  const remove = build.account(node, { method: "removeModule", args: [I(3), A([])] });
  node.state.simulate.stack = [{ type: "Any" }];
  const removed = await prepare(node, remove.plan, options(wallet(), { recipe: remove.recipe, authorizers: [custody] }));
  assert.equal(removed.review.plan.method, "removeModule");
});

test("the review recipe must rebuild the plan byte for byte", async () => {
  const node = createNode();
  const custody = wallet();
  const { plan, recipe } = build.registration(node, { custody });
  const other = build.registration(node, { custody, salt: "44".repeat(32) });
  await assert.rejects(
    prepare(node, plan, options(wallet(), { recipe: other.recipe, authorizers: [custody] })),
    /does not rebuild the plan/,
  );
  await assert.rejects(
    prepare(node, { ...plan, script: plan.script + "40" }, options(wallet(), { recipe, authorizers: [custody] })),
    /does not rebuild the plan/,
  );
  await assert.rejects(
    prepare(node, plan, options(wallet(), { authorizers: [custody] })),
    /requires the recipe/,
  );
  await assert.rejects(
    prepare(node, plan, options(wallet(), { recipe: { method: "buildV3UserOp", input: {} }, authorizers: [custody] })),
    /unsupported review recipe/,
  );
});

test("a plan that is not a v4 plan never reaches a wallet", async () => {
  const node = createNode();
  const payer = spyWallet();
  await assert.rejects(prepare(node, { kind: "registration", script: "00" }, options(payer)), /malformed plan/);
  await assert.rejects(prepare(node, null, options(payer)), /malformed plan/);
  assert.deepEqual(payer.calls, []);
});

test("fee gates: the declared system fee is the simulated consumption, never a budget", async () => {
  const node = createNode();
  const custody = wallet();
  const { plan, recipe } = build.registration(node, { custody });
  const base = { feePayer: wallet(), authorizers: [custody], recipe };
  // Plain Neo: with no explicit system fee the transaction declares exactly
  // the gas the simulation consumed. No budget-derived minimum, no margin.
  node.state.simulate = { state: "HALT", stack: [{ type: "Any" }], gasconsumed: "12866237" };
  const automatic = await prepare(node, plan, { ...CAPS, maxSystemFee: "20000000", maxTotalFee: "20001000", nonce: 1, ...base, systemFee: undefined });
  assert.equal(automatic.systemFeeSource, "simulation");
  assert.equal(automatic.systemFee, "12866237");
  assert.equal(automatic.transaction.systemFee, "12866237");
  assert.deepEqual(automatic.review.simulation, { state: "HALT", gasConsumed: "12866237" });
  // A simulation that consumed more than the approved cap is refused, not trimmed.
  await assert.rejects(
    prepare(node, plan, { ...CAPS, nonce: 1, ...base, systemFee: undefined }),
    /exceeds approved cap/,
  );
  // A caller's explicit system fee must cover the simulated consumption.
  node.state.simulate = { state: "HALT", stack: [{ type: "Any" }], gasconsumed: "210" };
  await assert.rejects(
    prepare(node, plan, options(wallet(), { recipe, authorizers: [custody] })),
    /below actual simulated consumption/,
  );
  node.state.simulate = { state: "HALT", stack: [{ type: "Any" }], gasconsumed: "10" };
  await assert.rejects(
    prepare(node, plan, options(wallet(), { recipe, authorizers: [custody], systemFee: "1001" })),
    /exceeds approved cap/,
  );
  await assert.rejects(
    prepare(node, plan, options(wallet(), { recipe, authorizers: [custody], maxSystemFee: undefined })),
    /system fee cap is required/,
  );
  // The source of the signed system fee is part of the review, not a detail.
  const explicit = await prepare(node, plan, options(wallet(), { recipe, authorizers: [custody] }));
  assert.equal(explicit.systemFeeSource, "explicit");
  assert.equal(explicit.systemFee, "200");
  const simulated = await prepare(node, plan, { ...CAPS, nonce: 1, ...base, systemFee: undefined });
  assert.equal(simulated.systemFeeSource, "simulation");
  assert.equal(simulated.systemFee, "10");
});

test("the network quote stays inside the approved cap and is never guessed", async () => {
  const node = createNode();
  const custody = wallet();
  const { plan, recipe } = build.registration(node, { custody });
  node.state.networkFee = "1001";
  await assert.rejects(
    prepare(node, plan, options(wallet(), { recipe, authorizers: [custody] })),
    /exceed approved caps/,
  );
  node.state.networkFee = "9".repeat(40);
  await assert.rejects(prepare(node, plan, options(wallet(), { recipe, authorizers: [custody] })));
  node.state.networkFee = "50";
  const prepared = await prepare(node, plan, options(wallet(), { recipe, authorizers: [custody] }));
  assert.equal(prepared.networkFee, "50");
  assert.equal(prepared.transaction.networkFee, "50");
});

test("the validity window is the next 100 blocks, not a caller preference", async () => {
  const node = createNode();
  const custody = wallet();
  const { plan, recipe } = build.registration(node, { custody });
  const base = { feePayer: wallet(), authorizers: [custody], recipe };
  const prepared = await prepare(node, plan, options(base.feePayer, base));
  assert.equal(prepared.transaction.validUntilBlock, 200);
  for (const validUntilBlock of [100, 201, "100"]) {
    await assert.rejects(
      prepare(node, plan, options(wallet(), { ...base, validUntilBlock })),
      /next 100 blocks/,
    );
  }
  await assert.rejects(
    prepare(node, plan, options(wallet(), { ...base, validUntilBlock: 1.5 })),
    /integer/,
  );
  const inside = await prepare(node, plan, options(wallet(), { ...base, validUntilBlock: 150 }));
  assert.equal(inside.transaction.validUntilBlock, 150);
  node.state.height = 0;
  await assert.rejects(prepare(node, plan, options(wallet(), base)), /invalid block height/);
});

test("a failed simulation, a refused transfer or a malformed stack never reaches a wallet", async () => {
  const node = createNode();
  node.setAccount({ custody: wallet().account });
  const payer = spyWallet();
  const { plan, recipe } = build.execution(node, { operation: operation() });
  node.state.simulate = { state: "FAULT", stack: [], gasconsumed: "10", exception: "boom" };
  await assert.rejects(prepare(node, plan, options(payer, { recipe })), /application preflight failed: boom/);
  node.state.simulate = { state: "HALT", stack: [BOOL(false)], gasconsumed: "10" };
  await assert.rejects(prepare(node, plan, options(payer, { recipe })), /did not return Boolean true/);
  node.state.simulate = { state: "HALT", stack: [{ type: "Integer", value: "1" }], gasconsumed: "10" };
  await assert.rejects(prepare(node, plan, options(payer, { recipe })), /token transfer/);
  node.state.simulate = { state: "HALT", stack: [{ type: "Nope", value: null }], gasconsumed: "10" };
  await assert.rejects(prepare(node, plan, options(payer, { recipe })), /unsupported RPC result stack type/);
  node.state.simulate = { state: "HALT", stack: [], gasconsumed: "10" };
  await assert.rejects(prepare(node, plan, options(payer, { recipe })), /exactly one item/);
  assert.deepEqual(payer.calls, []);
});

test("a batch execution has no preflight: the retired entry is refused before a wallet sees it", async () => {
  const node = createNode();
  node.setAccount({ custody: wallet().account });
  const payer = spyWallet();
  const single = operation();
  assert.throws(
    () => node.client.buildExecutionScript({ accountId: ACCOUNT, operations: [single, single] }),
    /protocol-incompatible: executeUserOps is retired in v4\.1/,
  );
  assert.throws(
    () => node.client.buildExecutionScript({ accountId: ACCOUNT, operations: [single] }),
    /protocol-incompatible: executeUserOps is retired in v4\.1/,
  );
  // A single-result stack is the only execution stack: an Array answer for a
  // single operation is a different protocol, not a shorter batch.
  const { plan, recipe } = build.execution(node, { operation: single });
  node.state.simulate = {
    state: "HALT",
    stack: [A([BOOL(true)])],
    gasconsumed: "10",
  };
  await assert.rejects(prepare(node, plan, options(payer, { recipe })), /unsupported RPC result stack type|did not return Boolean true/);
  assert.deepEqual(payer.calls, []);
});

test("signing verifies every signature, keeps the bytes and refuses a raised fee", async () => {
  const node = createNode();
  const custody = wallet();
  const { plan, recipe } = build.registration(node, { custody });
  const forged = { account: custody.account, verificationScript: custody.verificationScript, sign: () => "00".repeat(64) };
  const prepared = await prepare(node, plan, options(wallet(), { recipe, authorizers: [forged] }));
  await assert.rejects(node.client.signTransaction(prepared), /invalid.*signature/);

  const honest = await prepare(node, plan, options(wallet(), { recipe, authorizers: [custody] }));
  const signed = await node.client.signTransaction(honest);
  assert.equal(signed.prepared.unsignedHex, honest.unsignedHex);
  assert.equal(signed.txid, honest.txid);
  // A node that quotes a higher witness fee after the signatures were approved
  // does not get to have them: the approved network fee is part of the review.
  const drifted = await prepare(node, plan, options(wallet(), { recipe, authorizers: [custody] }));
  node.state.networkFee = "51";
  await assert.rejects(node.client.signTransaction(drifted), /final witness network fee/);
  node.state.networkFee = "50";
});

test("a wallet keeps its receiver and a counterfeit prepared or signed object is refused", async () => {
  const node = createNode();
  const custody = wallet();
  const tagged = {
    account: custody.account,
    verificationScript: custody.verificationScript,
    tag: "custody",
    seen: null,
    sign(signData) {
      this.seen = this.tag;
      return crypto
        .createHash("sha256")
        .update(signData)
        .digest("hex");
    },
  };
  // The hash above is not a signature, so preparation must survive and signing
  // must not: the point here is that the receiver reached `sign`.
  const { plan, recipe } = build.registration(node, { custody: tagged });
  const prepared = await prepare(node, plan, options(wallet(), { recipe, authorizers: [tagged] }));
  await assert.rejects(node.client.signTransaction(prepared), /invalid.*signature/);
  assert.equal(tagged.seen, "custody");

  const honest = await prepare(node, plan, options(wallet(), { recipe, authorizers: [custody] }));
  await assert.rejects(node.client.signTransaction(clone(honest)), /must be prepared by this SDK instance/);
  const signed = await node.client.signTransaction(honest);
  assert.throws(() => node.client.exportSignedTransaction({ ...signed }), /produced by this SDK instance/);
  assert.throws(() => node.client.exportSignedTransaction(clone(signed)), /produced by this SDK instance/);
  await assert.rejects(node.client.broadcastTransaction({ ...signed }), /produced by this SDK instance/);
});

test("signed preflight validates the single-transaction next-block context and keeps the node's error", async () => {
  const node = createNode();
  node.setAccount({ custody: wallet().account });
  const { artifact, signed } = await executionReview(node);
  Object.assign(node.state, staged(artifact));
  const result = await node.client.preflightTransaction(signed);
  assert.equal(result.hash, signed.txid);
  assert.equal(result.simulation.onPersist, "HALT");
  for (const simulation of [{ onPersist: "FAULT" }, { view: 1 }, { transactionCount: 2 }, { height: 99 }]) {
    node.state.preflight.simulation = { ...staged(artifact).preflight.simulation, ...simulation };
    await assert.rejects(node.client.preflightTransaction(signed), /next-block/);
  }
  node.state.preflight = () => {
    const error = new Error("connection reset");
    error.code = -32000;
    error.data = { detail: "reset" };
    throw error;
  };
  await assert.rejects(node.client.preflightTransaction(signed), (error) => {
    assert.equal(error.code, -32000);
    assert.deepEqual(error.data, { detail: "reset" });
    assert.equal(error.txid, signed.txid);
    assert.equal(error.submissionAttempted, false);
    return /preflight unavailable/.test(error.message);
  });
  assert.equal(node.calls.some((call) => call.method === "sendrawtransaction"), false);
});

test("broadcast sends the identical bytes once, dedupes, and recovers after a failed preflight", async () => {
  const node = createNode();
  const custody = wallet();
  const { plan, recipe } = build.registration(node, { custody });
  const prepared = await prepare(node, plan, options(wallet(), { recipe, authorizers: [custody] }));
  const signed = await node.client.signTransaction(prepared);
  await assert.rejects(node.client.broadcastTransaction(signed), /preflight/);
  assert.equal(node.calls.some((call) => call.method === "sendrawtransaction"), false);
  Object.assign(node.state, staged(node.client.exportSignedTransaction(signed), [{ type: "Any" }]));
  node.calls.length = 0;
  const [a, b] = await Promise.all([
    node.client.broadcastTransaction(signed),
    node.client.broadcastTransaction(signed),
  ]);
  assert.deepEqual(a, { txid: signed.txid, submitted: true, confirmed: false });
  assert.equal(a, b);
  const sends = node.calls.filter((call) => call.method === "sendrawtransaction");
  assert.equal(sends.length, 1);
  assert.equal(Buffer.from(sends[0].params[0], "base64").toString("hex"), signed.rawTransaction);
});

test("a receipt reports FAULT and a refused transfer as unsuccessful", async () => {
  const node = createNode();
  node.setAccount({ custody: wallet().account });
  const { artifact, signed } = await executionReview(node);
  Object.assign(node.state, staged(artifact));
  assert.equal((await node.client.getTransactionReceipt(signed)).succeeded, true);
  node.state.log.executions[0].vmstate = "FAULT";
  const faulted = await node.client.getTransactionReceipt(signed);
  assert.equal(faulted.confirmed, true);
  assert.equal(faulted.succeeded, false);
  assert.ok(faulted.failures.length);
  node.state.log.executions[0].vmstate = "HALT";
  node.state.log.executions[0].stack = [BOOL(false)];
  const refused = await node.client.getTransactionReceipt(signed);
  assert.equal(refused.confirmed, true);
  assert.equal(refused.succeeded, false);
  node.state.tx.blockhash = "0x" + "00".repeat(32);
  await assert.rejects(node.client.getTransactionReceipt(signed), /zero block hash/);
});

test("native module identity reconstructs independent NEF bytes and uses JCS manifest semantics", () => {
  const { sc } = require("@cityofzion/neon-js"),
    { codeIdentityTools } = require("../src/native/moduleIdentity"),
    tool = codeIdentityTools(c),
    nef = new sc.NEF({
      compiler: "independent NEF",
      source: "https://example.invalid/a",
      script: "1040",
    }),
    json = nef.toJson();
  json.script = Buffer.from(json.script, "hex").toString("base64");
  assert.equal(tool.serializeNef(json).toString("hex"), nef.serialize());
  assert.equal(
    tool.canonicalJson({ z: -0, a: 1e-7, n: 1e21, x: "é" }),
    "{" + '"a":1e-7,"n":1e+21,"x":"é","z":0}',
  );
  assert.throws(() => tool.canonicalJson({ x: "\ud800" }));
  assert.throws(() => tool.serializeNef({ ...json, checksum: 0 }), /checksum/);
});
