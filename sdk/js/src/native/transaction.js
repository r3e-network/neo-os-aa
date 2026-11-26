/**
 * Native v4 transaction lifecycle: review, sign, export, preflight, broadcast,
 * receipt.
 *
 * A review is `{format:"neo-native-reviewed-request", version:1,
 * submission:"native-sdk", profile, feePayer, signers, plan, recipe,
 * simulation}` — the same document an archived wallet exchange carries, so one
 * shape is reviewed, signed, exported and restored. The bytes are never
 * computed here: `shared/nativeTransactionArtifact.mjs` owns the canonical
 * serialization and re-derives every value this module signs.
 *
 * Signer order is part of the protocol, not a preference:
 *
 * - index 0 is the fee payer (never the account proxy);
 * - for an execution plan index 1 is the account proxy, whose witness carries
 *   no signature and is accepted only because the script is one shaped
 *   `executeUserOp` call (rule Allow/CalledByContract(core));
 * - every other signer is an authority the plan names (custody, or recovery for
 *   the two recovery entry points), at scope None.
 *
 * The v3 authorities, verifier scopes and cancellation policies are gone: v4
 * authorises configuration and account actions with the custody witness and
 * actions themselves with the validator signature inside the operation.
 */

const crypto = require("node:crypto");
const {
  createProxyWitness,
} = require("../../../../shared/proxyWitness.mjs");
const {
  createNativeWalletWitnessTools,
} = require("../../../../shared/nativeWalletWitness.mjs");
const {
  createNativeTransactionArtifactTools,
  validateNativeSignedPreflight,
} = require("../../../../shared/nativeTransactionArtifact.mjs");
const { parseNativeRpcFee } = require("./client");

const fail = (message) => {
  throw new Error(`Native transaction: ${message}`);
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const sha256 = (hex) =>
  crypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const hash160Of = (hex) =>
  Buffer.from(
    crypto
      .createHash("ripemd160")
      .update(crypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest())
      .digest(),
  )
    .reverse()
    .toString("hex");

/** P-256 / SHA-256 verification of the wallet's transaction signature. */
function verify(publicKey, signature, signData) {
  const point = crypto.ECDH.convertKey(
    Buffer.from(publicKey, "hex"),
    "prime256v1",
    undefined,
    undefined,
    "uncompressed",
  );
  const spki = Buffer.concat([
    Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
    point,
  ]);
  return crypto.verify(
    "sha256",
    Buffer.from(signData, "hex"),
    {
      key: crypto.createPublicKey({ key: spki, format: "der", type: "spki" }),
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(signature, "hex"),
  );
}

function createNativeTransactionTools(c) {
  const walletWitness = createNativeWalletWitnessTools({
    hash160: hash160Of,
    verify,
  });
  const artifactTools = createNativeTransactionArtifactTools({
    codec: c,
    sha256,
    walletWitness,
  });
  const reviews = new WeakSet(),
    signedTransactions = new WeakSet(),
    submissions = new WeakMap();

  const required = (value, label) => {
    if (!value) fail(`${label} is required`);
    return value;
  };

  /**
   * A wallet is an account, its standard verification script and a signer.
   *
   * `contracts` is the witness scope the signer must carry: an empty list is
   * `None`, which the node only honours for the fee payer. An authority witness
   * is recognized by `Runtime.CheckWitness` inside the core, so it is scoped to
   * exactly the core's hash and nothing else — `None` there would leave the
   * witness unverified and every custody-gated call would fault on chain.
   */
  function wallet(input, role, { contracts = [] } = {}) {
    const account = c.hex(required(input?.account, `${role} account`), 20);
    const verification = c.hex(
      required(input?.verificationScript, `${role} verification script`),
    );
    const parsed = walletWitness.parse(verification, account);
    if (typeof input.sign !== "function")
      fail(`${role} must expose sign(signDataHex)`);
    const allowed = [...new Set(contracts.map((hash) => c.hex(hash, 20)))];
    if (allowed.length > 16) fail("witness scope exceeds the protocol limit");
    return Object.freeze({
      account,
      verification,
      parsed,
      sign: input.sign.bind(input),
      descriptor: Object.freeze(
        allowed.length
          ? {
              account: "0x" + account,
              scopes: "CustomContracts",
              allowedcontracts: allowed.map((hash) => "0x" + hash),
            }
          : { account: "0x" + account, scopes: "None" },
      ),
      role,
    });
  }

  /** Resolve the witnesses for the independently rebuilt plan. */
  async function requiredWitnesses(client, plan) {
    // A module-targeted plan (recovery seat, governance module) names its own
    // witnesses; so does a direct custody batch.
    if (plan.kind === "recovery" || plan.kind === "governance" || plan.method === "applyConfigurationActions")
      return { all: [...plan.signers], any: [] };
    if (plan.kind === "registration")
      return { all: [c.hex(required(plan.custodyAddress, "registration custody"), 20)], any: [] };
    if (plan.kind === "execution") return { all: [], any: [] };
    const state = await client.getAccount(plan.accountId);
    if (!state) fail("account does not exist on this core");
    return { all: [c.hex(state.custodyAddress, 20)], any: [] };
  }

  /** Rebuild the plan from the review recipe so an archived review stays checkable. */
  function rebuild(client, recipe) {
    if (!recipe || typeof recipe !== "object" || !recipe.input)
      fail("a review requires the recipe that built its plan");
    if (recipe.method === "buildCreateAccountScript")
      return client.buildCreateAccountScript(recipe.input);
    if (recipe.method === "buildExecutionScript")
      return client.buildExecutionScript(recipe.input);
    if (recipe.method === "buildRecoveryModulePlan") return client.buildRecoveryModulePlan(recipe.input);
    if (recipe.method === "buildGovernanceModulePlan") return client.buildGovernanceModulePlan(recipe.input);
    if (recipe.method === "buildConfigurationBatchPlan") return client.buildConfigurationBatchPlan(recipe.input);
    if (recipe.method === "buildAccountActionScript")
      return client.buildAccountActionScript(recipe.input);
    fail(`unsupported review recipe ${String(recipe.method)}`);
  }

  async function prepareNativeTransaction(
    client,
    plan,
    {
      feePayer,
      authorizers = [],
      recipe,
      systemFee,
      maxSystemFee,
      maxNetworkFee,
      maxTotalFee,
      validUntilBlock,
      nonce,
    } = {},
  ) {
    await client.discover();
    const caps = {
      system: c.unsigned(required(maxSystemFee, "system fee cap"), 63, "system fee cap"),
      network: c.unsigned(
        required(maxNetworkFee, "network fee cap"),
        63,
        "network fee cap",
      ),
      total: c.unsigned(required(maxTotalFee, "total fee cap"), 63, "total fee cap"),
    };
    if (!Array.isArray(plan?.signers) || typeof plan?.script !== "string")
      fail("malformed plan");
    const rebuilt = await rebuild(client, recipe);
    if (
      rebuilt.kind !== plan.kind ||
      rebuilt.accountId !== plan.accountId ||
      rebuilt.script !== plan.script ||
      rebuilt.method !== plan.method ||
      ((rebuilt.kind === "recovery" || rebuilt.kind === "governance" || rebuilt.method === "applyConfigurationActions") &&
        (JSON.stringify(rebuilt.signers) !== JSON.stringify(plan.signers) ||
         rebuilt.targetContract !== plan.targetContract || rebuilt.configurationNonce !== plan.configurationNonce ||
         rebuilt.nefSha256 !== plan.nefSha256 || rebuilt.moduleId !== plan.moduleId ||
         rebuilt.intentId !== plan.intentId)) ||
      (plan.kind === "execution" && rebuilt.proxyCallFlags !== plan.proxyCallFlags)
    )
      fail("review recipe does not rebuild the plan that will be signed");
    client.prepare(plan);
    await client.revalidatePlan(plan);

    const needs = await requiredWitnesses(client, rebuilt);
    // The witness scope is the contract the plan calls: the module for a
    // module-targeted plan, the core for everything else.
    const scope =
      rebuilt.kind === "recovery" || rebuilt.kind === "governance"
        ? rebuilt.targetContract
        : client.contractHash;
    const payerAccount = c.hex(required(feePayer?.account, "fee payer account"), 20);
    const payer = wallet(feePayer, "fee payer", { contracts: needs.all.includes(payerAccount) ? [scope] : [] });
    const extras = [];
    const seen = new Map([[payer.account, payer.verification]]);
    for (const [index, input] of authorizers.entries()) {
      const signer = wallet(input, `authorizer ${index + 1}`, { contracts: [scope] });
      const prior = seen.get(signer.account);
      if (prior !== undefined && prior !== signer.verification)
        fail("conflicting wallet identity for one account");
      if (prior === undefined) {
        seen.set(signer.account, signer.verification);
        extras.push(signer);
      }
    }

    let proxy = null;
    if (plan.kind === "execution") {
      if (payer.account === plan.accountAddress)
        fail("the account proxy cannot be the fee payer");
      const artifacts = createProxyWitness({
        coreHash: client.contractHash,
        accountId: plan.accountId,
        proxyHash: plan.accountAddress,
        feePayer: payer.account,
        callFlags: plan.proxyCallFlags,
      });
      proxy = Object.freeze({
        signer: Object.freeze({
          account: "0x" + artifacts.signer.account,
          scopes: artifacts.signer.scopes,
          rules: artifacts.signer.rules,
        }),
        witness: Object.freeze({
          invocation: artifacts.witness.invocationScript,
          verification: artifacts.witness.verificationScript,
        }),
      });
      if (seen.has(artifacts.signer.account))
        fail("the account proxy cannot also be a wallet authority");
      seen.set(artifacts.signer.account, artifacts.witness.verificationScript);
    }

    for (const account of needs.all)
      if (!seen.has(account))
        fail(`missing authority witness for ${account}`);
    if (needs.any.length && !needs.any.some((account) => seen.has(account)))
      fail("missing custody or recovery authority witness");

    const signers = [
      payer.descriptor,
      ...(proxy ? [proxy.signer] : []),
      ...extras.map((signer) => signer.descriptor),
    ];
    if (signers.length > 16) fail("too many transaction signers");

    const simulation = await client.simulate(plan, signers);
    if (simulation.state !== "HALT")
      fail(
        `application preflight failed: ${
          simulation.exception ?? simulation.state ?? "unknown state"
        }`,
      );
    if (simulation.incompleteTransfers.length)
      fail("a simulated token transfer did not return Boolean true");
    // Plain Neo: the declared system fee is the transaction's only gas limit and
    // the node burns the whole declared amount, so the transaction declares
    // exactly the gas this script consumed in its simulation. No budget-derived
    // minimum and no margin is added. A caller-supplied `systemFee` is an
    // explicit declaration and must still cover the consumption.
    const consumed = parseNativeRpcFee(simulation.gasConsumed, "gasconsumed");
    const system =
      systemFee === undefined ? consumed : c.unsigned(systemFee, 63, "system fee");
    if (system < consumed)
      fail("system fee is below actual simulated consumption");
    if (system > caps.system) fail("system fee exceeds approved cap");

    const height = await client.rpc.send("getblockcount", []);
    if (!Number.isSafeInteger(height) || height <= 0)
      fail("invalid block height");
    const until =
      validUntilBlock === undefined
        ? height + 100
        : Number(c.unsigned(validUntilBlock, 32, "valid until block"));
    if (until <= height || until > height + 100)
      fail("validity must be within the next 100 blocks");

    const transaction = {
      nonce:
        nonce === undefined
          ? crypto.randomBytes(4).readUInt32LE()
          : Number(c.unsigned(nonce, 32, "transaction nonce")),
      systemFee: system.toString(),
      networkFee: "0",
      validUntilBlock: until,
      script: c.hex(plan.script),
      signers,
    };
    const placeholders = [
      walletWitness.placeholder(payer.parsed),
      ...(proxy ? [proxy.witness] : []),
      ...extras.map((signer) => walletWitness.placeholder(signer.parsed)),
    ];
    const quote = await client.rpc.send("calculatenetworkfee", [
      Buffer.from(
        artifactTools.bytes({
          networkMagic: client.networkMagic,
          transaction,
          witnesses: placeholders,
        }).rawTransaction,
        "hex",
      ).toString("base64"),
    ]);
    const network = parseNativeRpcFee(quote?.networkfee, "network");
    if (network > caps.network || network + system > caps.total)
      fail("transaction fees exceed approved caps");
    transaction.networkFee = network.toString();

    const canonical = artifactTools.bytes({
      networkMagic: client.networkMagic,
      transaction,
      witnesses: placeholders,
    });
    const review = freeze({
      format: "neo-native-reviewed-request",
      version: 1,
      submission: "native-sdk",
      profile: client.profile,
      feePayer: payer.account,
      signers,
      plan,
      recipe,
      simulation: {
        state: simulation.state,
        gasConsumed: simulation.gasConsumed,
      },
    });
    reviews.add(review);
    return freeze({
      kind: "native-transaction",
      review,
      reviewJson: JSON.stringify(review),
      transaction: canonical.transaction,
      witnesses: canonical.witnesses,
      unsignedHex: canonical.unsignedHex,
      txid: canonical.txid,
      signData: canonical.signData,
      systemFee: transaction.systemFee,
      networkFee: transaction.networkFee,
      // "simulation": the declared fee is the simulated consumption itself.
      systemFeeSource: systemFee === undefined ? "simulation" : "explicit",
      simulation,
      wallets: [payer, ...extras],
      proxy,
      placeholderWitnesses: placeholders,
    });
  }

  function requirePrepared(client, prepared) {
    if (!prepared || !reviews.has(prepared.review))
      fail("transaction must be prepared by this SDK instance");
    return prepared;
  }

  async function signNativeTransaction(client, prepared) {
    requirePrepared(client, prepared);
    await client.revalidatePlan(prepared.review.plan);
    if (
      artifactTools.bytes({
        networkMagic: client.networkMagic,
        transaction: prepared.transaction,
        witnesses: prepared.placeholderWitnesses,
      }).unsignedHex !== prepared.unsignedHex
    )
      fail("transaction changed after fee approval");
    const signatures = [];
    for (const signer of prepared.wallets)
      signatures.push(
        await walletWitness.assemble(
          signer.parsed,
          await signer.sign(prepared.signData),
          prepared.signData,
        ),
      );
    const witnesses = [
      signatures[0],
      ...(prepared.proxy ? [prepared.proxy.witness] : []),
      ...signatures.slice(1),
    ];
    await client.revalidatePlan(prepared.review.plan);
    const final = artifactTools.bytes({
      networkMagic: client.networkMagic,
      transaction: prepared.transaction,
      witnesses,
    });
    if (final.unsignedHex !== prepared.unsignedHex)
      fail("transaction changed during signing");
    const quote = await client.rpc.send("calculatenetworkfee", [
      Buffer.from(final.rawTransaction, "hex").toString("base64"),
    ]);
    if (
      parseNativeRpcFee(quote?.networkfee, "final network") >
      BigInt(prepared.networkFee)
    )
      fail("final witness network fee exceeds approved transaction");
    const signed = freeze({
      kind: "signed-native-transaction",
      prepared,
      txid: final.txid,
      rawTransaction: final.rawTransaction,
      witnesses: final.witnesses,
    });
    signedTransactions.add(signed);
    return signed;
  }

  function requireSigned(client, signed) {
    if (!signed || !signedTransactions.has(signed))
      fail("signed transaction must be produced by this SDK instance");
    if (!client) fail("signed transaction requires its client");
    return signed;
  }

  /** The archived artifact. It binds to the review; it is not a receipt. */
  function exportSignedTransaction(client, signed) {
    requireSigned(client, signed);
    const prepared = signed.prepared;
    return artifactTools.createArtifact({
      networkMagic: client.networkMagic,
      profile: prepared.review.profile,
      transaction: prepared.transaction,
      witnesses: signed.witnesses,
      unsignedHex: prepared.unsignedHex,
      txid: signed.txid,
      signData: prepared.signData,
      rawTransaction: signed.rawTransaction,
    });
  }

  async function preflightNativeTransaction(client, signed) {
    requireSigned(client, signed);
    const prepared = signed.prepared;
    await client.revalidatePlan(prepared.review.plan);
    let result;
    try {
      result = await client.rpc.send("invoketransaction", [
        Buffer.from(signed.rawTransaction, "hex").toString("base64"),
      ]);
    } catch (cause) {
      const error = new Error(
        `Native transaction: signed transaction preflight unavailable: ${
          cause?.message ?? cause
        }`,
        { cause },
      );
      if (cause && typeof cause === "object") {
        if (Object.hasOwn(cause, "code")) error.code = cause.code;
        if (Object.hasOwn(cause, "data")) error.data = cause.data;
      }
      // The identity of what was not submitted is part of the failure, so a
      // caller cannot mistake this for an error about another transaction.
      error.txid = signed.txid;
      error.submissionAttempted = false;
      throw error;
    }
    return validateNativeSignedPreflight(
      c,
      {
        txid: signed.txid,
        networkMagic: client.networkMagic,
        plan: prepared.review.plan,
        systemFee: prepared.systemFee,
        validUntilBlock: prepared.transaction.validUntilBlock,
      },
      result,
    );
  }

  function broadcastNativeTransaction(client, signed) {
    if (!signedTransactions.has(signed))
      return Promise.reject(
        new Error(
          "Native transaction: signed transaction must be produced by this SDK instance",
        ),
      );
    let byId = submissions.get(client);
    if (!byId) {
      byId = new Map();
      submissions.set(client, byId);
    }
    const key = signed.txid + ":" + signed.rawTransaction;
    if (byId.has(key)) return byId.get(key);
    let sendAttempted = false;
    const promise = (async () => {
      await preflightNativeTransaction(client, signed);
      sendAttempted = true;
      const result = await client.rpc.send("sendrawtransaction", [
        Buffer.from(signed.rawTransaction, "hex").toString("base64"),
      ]);
      if (result?.hash && String(result.hash).toLowerCase() !== signed.txid)
        fail("RPC returned a different transaction id");
      if (result !== true && !result?.hash)
        fail("RPC did not confirm transaction submission");
      return { txid: signed.txid, submitted: true, confirmed: false };
    })().catch((error) => {
      error.txid = signed.txid;
      error.submissionAttempted = sendAttempted;
      if (!sendAttempted) byId.delete(key);
      throw error;
    });
    byId.set(key, promise);
    return promise;
  }

  /**
   * A receipt is read through the archived review: the artifact is restored
   * from its recipe (script, signers and witnesses re-derived), then the
   * confirmed bytes are compared with the signed ones.
   */
  async function getNativeTransactionReceipt(client, signed) {
    requireSigned(client, signed);
    const restored = await artifactTools.restoreForReceipt(
      client,
      signed.prepared.review,
      JSON.stringify(exportSignedTransaction(client, signed)),
    );
    return artifactTools.receipt(client, restored);
  }

  return Object.freeze({
    prepareNativeTransaction,
    signNativeTransaction,
    exportSignedTransaction,
    preflightNativeTransaction,
    broadcastNativeTransaction,
    getNativeTransactionReceipt,
  });
}

module.exports = { createNativeTransactionTools };
