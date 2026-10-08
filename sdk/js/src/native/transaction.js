const crypto = require("node:crypto");
const { createVerifierWitnessTools } = require("./verifierWitness");
const { validateNativeInvocationResult } = require("./client");
const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};
const fail = (message) => {
  throw new Error(`Native transaction: ${message}`);
};
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest();
const accountOf = (script) =>
  Buffer.from(
    crypto
      .createHash("ripemd160")
      .update(hash(Buffer.from(script, "hex")))
      .digest(),
  )
    .reverse()
    .toString("hex");
function createNativeTransactionTools(c) {
  const verifierWitness = createVerifierWitnessTools(c);
  const le = (value, size) => {
    let n = BigInt(value);
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
      out[i] = Number(n & 255n);
      n >>= 8n;
    }
    if (n) fail("integer overflow");
    return out;
  };
  const vi = (n) =>
    n < 253
      ? le(n, 1)
      : n <= 65535
        ? Buffer.concat([Buffer.from([253]), le(n, 2)])
        : Buffer.concat([Buffer.from([254]), le(n, 4)]);
  const vb = (hex) => {
    const b = Buffer.from(c.hex(hex), "hex");
    return Buffer.concat([vi(b.length), b]);
  };
  const h160 = (hex) => Buffer.from(c.hex(hex, 20), "hex").reverse();
  const fee = (value, label) => c.unsigned(value, 63, label);
  const signerBytes = (s) =>
    Buffer.concat([
      h160(s.account),
      Buffer.from([
        s.scopes === "None"
          ? 0
          : s.scopes === "CustomContracts"
            ? 16
            : fail("unsupported signer scope"),
      ]),
      ...(s.scopes === "CustomContracts"
        ? [vi(s.allowedcontracts.length), ...s.allowedcontracts.map(h160)]
        : []),
    ]);
  const unsigned = (tx) =>
    Buffer.concat([
      Buffer.from([0]),
      le(tx.nonce, 4),
      le(tx.systemFee, 8),
      le(tx.networkFee, 8),
      le(tx.validUntilBlock, 4),
      vi(tx.signers.length),
      ...tx.signers.map(signerBytes),
      Buffer.from([0]),
      vb(tx.script),
    ]);
  const raw = (tx, witnesses) =>
    Buffer.concat([
      unsigned(tx),
      vi(witnesses.length),
      ...witnesses.flatMap((w) => [vb(w.invocation), vb(w.verification)]),
    ]);
  function keySigner(input, requiredAuthorities, verifierScopes = []) {
    if (!input || typeof input.sign !== "function")
      fail("payer/authority signer must expose sign(signDataHex)");
    const verification = c.hex(input.verificationScript);
    // Current native transport supports ordinary P-256 single-signature Neo accounts.
    if (!/^0c21(?:02|03)[0-9a-f]{64}4156e7b327$/.test(verification))
      fail(
        "unsupported wallet verification script; standard P-256 account required",
      );
    const account = c.hex(input.account, 20);
    if (accountOf(verification) !== account)
      fail("wallet account does not match verification script");
    const contracts = [
      ...new Set([
        ...(requiredAuthorities.has(account)
          ? ["0xd9421d07adf206e9dc4be746a02e8e087fa61741"]
          : []),
        ...verifierScopes.map((h) => "0x" + h),
      ]),
    ];
    if (contracts.length > 16)
      fail("verifier witness scope exceeds protocol limit");
    return deepFreeze({
      account,
      verification,
      sign: input.sign.bind(input),
      descriptor: {
        account: "0x" + account,
        scopes: contracts.length ? "CustomContracts" : "None",
        ...(contracts.length ? { allowedcontracts: contracts } : {}),
      },
    });
  }
  function verify(signature, verification, message) {
    const compressed = Buffer.from(verification.slice(4, 70), "hex");
    const point = crypto.ECDH.convertKey(
      compressed,
      "prime256v1",
      undefined,
      undefined,
      "uncompressed",
    );
    const spki = Buffer.concat([
      Buffer.from(
        "3059301306072a8648ce3d020106082a8648ce3d030107034200",
        "hex",
      ),
      point,
    ]);
    return crypto.verify(
      "sha256",
      message,
      {
        key: crypto.createPublicKey({ key: spki, format: "der", type: "spki" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "hex"),
    );
  }
  const issued = new WeakSet(),
    signedIssued = new WeakSet();
  async function prepareNativeTransaction(
    client,
    plan,
    {
      feePayer,
      authoritySigners = [],
      verifierSigners = [],
      systemFee,
      maxSystemFee,
      maxNetworkFee,
      maxTotalFee,
      validUntilBlock,
      nonce,
    } = {},
  ) {
    await client.revalidatePlan(plan);
    const caps = {
      system: fee(maxSystemFee, "system fee cap"),
      network: fee(maxNetworkFee, "network fee cap"),
      total: fee(maxTotalFee, "total fee cap"),
    };
    const required = new Set(plan.requiredAuthorities);
    if (plan.authorityPolicy === "recovery-or-custody-before-maturity") {
      const candidates = [feePayer, ...authoritySigners].map((s) =>
          c.hex(s?.account, 20),
        ),
        state = plan.accountState;
      if (
        candidates.includes(state.recoveryAddress) &&
        !/^0+$/.test(state.recoveryAddress)
      )
        required.add(state.recoveryAddress);
      else if (candidates.includes(state.custodyAddress))
        required.add(state.custodyAddress);
      else fail("recovery cancellation needs a recovery or custody signer");
    }
    const verifierAccounts = verifierSigners.map((s) => c.hex(s.account, 20));
    if (new Set(verifierAccounts).size !== verifierAccounts.length)
      fail("duplicate explicit verifier signer");
    const verifierContext = await verifierWitness.read(
      client,
      plan,
      verifierAccounts,
    );
    const allWallets = new Map();
    for (const signer of [feePayer, ...authoritySigners, ...verifierSigners]) {
      const account = c.hex(signer?.account, 20),
        prior = allWallets.get(account);
      if (
        prior &&
        c.hex(prior.verificationScript) !== c.hex(signer.verificationScript)
      )
        fail("conflicting wallet identity");
      if (!prior) allWallets.set(account, signer);
    }
    const wallets = [...allWallets.values()].map((s) =>
      keySigner(
        s,
        required,
        verifierContext?.scopes[c.hex(s.account, 20)] ?? [],
      ),
    );
    const identities = wallets.map((s) => s.account);
    if (plan.kind === "execution" && identities.includes(plan.accountAddress))
      fail("native proxy cannot be payer or wallet authority");
    for (const authority of required)
      if (!identities.includes(authority))
        fail("missing required custody/recovery transaction signer");
    const signers = [
      wallets[0].descriptor,
      ...(plan.kind === "execution" ? [plan.proxySigner] : []),
      ...wallets.slice(1).map((s) => s.descriptor),
    ];
    if (signers.length > 16) fail("too many transaction signers");
    const simulation = await client.simulate(plan, signers);
    if (simulation.state !== "HALT")
      fail(
        `application preflight failed: ${simulation.exception ?? simulation.state}`,
      );
    if (validateNativeInvocationResult(plan, simulation.stack).length)
      fail("a simulated token transfer did not return Boolean true");
    const minimum =
      simulation.minimumRequiredFee === null
        ? null
        : fee(simulation.minimumRequiredFee, "minimum required system fee");
    if (systemFee === undefined && minimum === null)
      fail(
        "node does not report minimumrequiredfee; supply an explicit system fee budget",
      );
    const system =
      systemFee === undefined ? minimum : fee(systemFee, "system fee");
    if (minimum !== null && system < minimum)
      fail("system fee is below bounded-call admission requirement");
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
    const tx = {
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
    const walletPlaceholder = (w) => ({
      invocation: "0c40" + "00".repeat(64),
      verification: w.verification,
    });
    const placeholders = [
      walletPlaceholder(wallets[0]),
      ...(plan.kind === "execution" ? [plan.proxyWitness] : []),
      ...wallets.slice(1).map(walletPlaceholder),
    ];
    const quote = await client.rpc.send("calculatenetworkfee", [
      raw(tx, placeholders).toString("base64"),
    ]);
    const network = fee(quote?.networkfee, "network fee");
    if (network > caps.network || network + system > caps.total)
      fail("transaction fees exceed approved caps");
    tx.networkFee = network.toString();
    const unsignedHex = unsigned(tx).toString("hex"),
      txHash = hash(Buffer.from(unsignedHex, "hex")),
      signData = Buffer.concat([le(client.networkMagic, 4), txHash]).toString(
        "hex",
      );
    const result = deepFreeze({
      kind: "native-transaction",
      plan,
      transaction: Object.freeze({ ...tx, signers: Object.freeze(signers) }),
      unsignedHex,
      txid: "0x" + Buffer.from(txHash).reverse().toString("hex"),
      signData,
      systemFee: tx.systemFee,
      networkFee: tx.networkFee,
      systemFeeSource:
        systemFee === undefined ? "minimumrequiredfee" : "explicit-budget",
      verifierAccounts,
      verifierContext,
      simulation,
      wallets: Object.freeze(wallets),
      placeholderWitnesses: Object.freeze(placeholders),
    });
    issued.add(result);
    return result;
  }
  async function signNativeTransaction(client, prepared) {
    if (!issued.has(prepared))
      fail("transaction must be prepared by this SDK instance");
    await client.revalidatePlan(prepared.plan);
    await verifierWitness.revalidate(client, prepared);
    if (unsigned(prepared.transaction).toString("hex") !== prepared.unsignedHex)
      fail("transaction changed after fee approval");
    const signatures = [];
    for (const wallet of prepared.wallets) {
      const sig = c.hex(await wallet.sign(prepared.signData), 64);
      if (
        !verify(sig, wallet.verification, Buffer.from(prepared.signData, "hex"))
      )
        fail("wallet returned an invalid transaction signature");
      signatures.push({
        invocation: "0c40" + sig,
        verification: wallet.verification,
      });
    }
    const witnesses = [
      signatures[0],
      ...(prepared.plan.kind === "execution"
        ? [prepared.plan.proxyWitness]
        : []),
      ...signatures.slice(1),
    ];
    await client.revalidatePlan(prepared.plan);
    await verifierWitness.revalidate(client, prepared);
    if (unsigned(prepared.transaction).toString("hex") !== prepared.unsignedHex)
      fail("transaction changed during signing");
    const finalBytes = raw(prepared.transaction, witnesses);
    const quote = await client.rpc.send("calculatenetworkfee", [
      finalBytes.toString("base64"),
    ]);
    if (
      fee(quote?.networkfee, "final network fee") > BigInt(prepared.networkFee)
    )
      fail("final witness network fee exceeds approved transaction");
    const result = Object.freeze({
      kind: "signed-native-transaction",
      prepared,
      txid: prepared.txid,
      rawTransaction: finalBytes.toString("hex"),
    });
    signedIssued.add(result);
    return result;
  }
  async function preflightNativeTransaction(client, signed) {
    if (!signedIssued.has(signed))
      fail("signed transaction must be produced by this SDK instance");
    await client.revalidatePlan(signed.prepared.plan);
    await verifierWitness.revalidate(client, signed.prepared);
    let result;
    try {
      result = await client.rpc.send("invoketransaction", [
        Buffer.from(signed.rawTransaction, "hex").toString("base64"),
      ]);
    } catch (cause) {
      const error = new Error(
        `Native transaction: signed transaction preflight unavailable: ${cause?.message ?? cause}`,
        { cause },
      );
      if (cause && typeof cause === "object") {
        if (Object.hasOwn(cause, "code")) error.code = cause.code;
        if (Object.hasOwn(cause, "data")) error.data = cause.data;
      }
      throw error;
    }
    if (
      result?.hash !== signed.txid ||
      result?.network !== client.networkMagic ||
      result?.verification !== "Succeed" ||
      result?.state !== "HALT" ||
      result?.relayed !== false ||
      result?.mempoolChecked !== false
    )
      fail(
        "signed transaction preflight rejected or returned mismatched identity",
      );
    if (!Number.isSafeInteger(result?.snapshot?.height))
      fail("preflight snapshot height must be a UInt32 number");
    c.unsigned(result.snapshot.height, 32, "preflight snapshot height");
    c.hex(result?.snapshot?.hash, 32);
    const simulation = result.simulation;
    if (
      simulation?.mode !== "single-transaction-next-block" ||
      simulation?.onPersist !== "HALT" ||
      simulation?.view !== 0 ||
      simulation?.transactionCount !== 1 ||
      !Number.isSafeInteger(simulation?.height) ||
      simulation.height !== result.snapshot.height + 1 ||
      simulation.height > 0xffffffff ||
      !Number.isSafeInteger(simulation?.primaryIndex) ||
      simulation.primaryIndex < 0 ||
      simulation.primaryIndex > 0xff ||
      typeof simulation?.timestamp !== "string" ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(simulation.timestamp) ||
      typeof simulation?.nextConsensus !== "string" ||
      !/^0x[0-9a-f]{40}$/.test(simulation.nextConsensus)
    )
      fail(
        "preflight simulation must declare successful single-transaction next-block preparation",
      );
    c.unsigned(simulation.timestamp, 64, "preflight simulation timestamp");
    if (
      fee(result.minimumrequiredfee, "final minimum required fee") >
      BigInt(signed.prepared.systemFee)
    )
      fail("final Application admission exceeds signed system fee");
    if (
      validateNativeInvocationResult(signed.prepared.plan, result.stack).length
    )
      fail(
        "signed transaction preflight token transfer did not return Boolean true",
      );
    return deepFreeze(result);
  }
  const submissions = new WeakMap();
  function broadcastNativeTransaction(client, signed) {
    if (!signedIssued.has(signed))
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
    const promise = submitNativeTransaction(client, signed, () => {
      sendAttempted = true;
    }).catch((error) => {
      error.txid = signed.txid;
      error.submissionAttempted = sendAttempted;
      if (!sendAttempted) byId.delete(key);
      throw error;
    });
    byId.set(key, promise);
    return promise;
  }
  async function submitNativeTransaction(client, signed, markSendAttempted) {
    if (!signedIssued.has(signed))
      fail("signed transaction must be produced by this SDK instance");
    await preflightNativeTransaction(client, signed);
    markSendAttempted();
    const result = await client.rpc.send("sendrawtransaction", [
      Buffer.from(signed.rawTransaction, "hex").toString("base64"),
    ]);
    if (result?.hash && String(result.hash).toLowerCase() !== signed.txid)
      fail("RPC returned a different transaction id");
    if (result !== true && !result?.hash)
      fail("RPC did not confirm transaction submission");
    return { txid: signed.txid, submitted: true, confirmed: false };
  }
  async function getNativeTransactionReceipt(client, signed) {
    if (!signedIssued.has(signed))
      fail("signed transaction must be produced by this SDK instance");
    const tx = await client.rpc.send("getrawtransaction", [signed.txid, true]);
    if (!tx?.blockhash) return { txid: signed.txid, confirmed: false };
    const [wire, log] = await Promise.all([
      client.rpc.send("getrawtransaction", [signed.txid, false]),
      client.rpc.send("getapplicationlog", [signed.txid]),
    ]);
    if (
      typeof wire !== "string" ||
      Buffer.from(wire, "base64").toString("hex") !== signed.rawTransaction
    )
      fail("persisted transaction bytes differ from signed transaction");
    if (String(log?.txid).toLowerCase() !== signed.txid)
      fail("application log transaction identity mismatch");
    const execution = log.executions?.find((x) => x.trigger === "Application");
    if (!execution) fail("confirmed transaction has no Application execution");
    return {
      txid: signed.txid,
      confirmed: true,
      blockHash: tx.blockhash,
      vmState: execution.vmstate,
      exception: execution.exception ?? null,
      stack: execution.stack ?? [],
      notifications: execution.notifications ?? [],
      gasConsumed: execution.gasconsumed ?? null,
      systemFee: signed.prepared.systemFee,
      networkFee: signed.prepared.networkFee,
    };
  }
  return {
    prepareNativeTransaction,
    signNativeTransaction,
    broadcastNativeTransaction,
    getNativeTransactionReceipt,
    preflightNativeTransaction,
  };
}
module.exports = { createNativeTransactionTools };
