/** Private integration bridge. Ephemeral fixture keys enter only on stdin; never print them. */
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  NativeSmartAccountClient,
  nativeCodec: c,
} = require("../src/native.js");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const options = JSON.parse(input);
const endpoint = new URL(options.rpcUrl);
if (
  !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname) ||
  endpoint.protocol !== "http:"
)
  throw new Error("Private runtime driver requires a loopback HTTP node");
const client = new NativeSmartAccountClient({
  rpcUrl: options.rpcUrl,
  networkMagic: options.networkMagic,
});
if (options.diagnosticOutput) {
  const send = client.rpc.send.bind(client.rpc);
  client.rpc.send = async (method, params) => {
    const result = await send(
      method,
      method === "invokescript" ? [...params.slice(0, 2), true] : params,
    );
    if (method === "invokescript" && result?.state === "FAULT")
      fs.writeFileSync(
        options.diagnosticOutput,
        JSON.stringify({ method, params, result }),
        { mode: 0o600 },
      );
    return result;
  };
}
function wallet(hex) {
  const raw = Buffer.from(c.hex(hex, 32), "hex");
  const der = Buffer.concat([
    Buffer.from("30310201010420", "hex"),
    raw,
    Buffer.from("a00a06082a8648ce3d030107", "hex"),
  ]);
  const key = crypto.createPrivateKey({
    key: der,
    format: "der",
    type: "sec1",
  });
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(raw);
  const verificationScript =
    "0c21" + ecdh.getPublicKey("hex", "compressed") + "4156e7b327";
  const account = Buffer.from(
    crypto
      .createHash("ripemd160")
      .update(
        crypto
          .createHash("sha256")
          .update(Buffer.from(verificationScript, "hex"))
          .digest(),
      )
      .digest(),
  )
    .reverse()
    .toString("hex");
  return {
    account,
    verificationScript,
    publicKey: ecdh.getPublicKey("hex", "compressed"),
    sign: async (data) =>
      crypto
        .sign("sha256", Buffer.from(data, "hex"), {
          key,
          dsaEncoding: "ieee-p1363",
        })
        .toString("hex"),
  };
}
const profile = await client.discover();
const output = (value) => process.stdout.write(JSON.stringify(value));
if (options.mode === "preflight-raw") {
  const raw = Buffer.from(c.hex(options.rawTransaction), "hex").toString(
    "base64",
  );
  output({
    profile,
    preflight: await client.rpc.send("invoketransaction", [raw]),
  });
} else if (options.mode === "read") {
  output({
    profile,
    account: await client.getAccount(options.accountId),
    nonce: (
      await client.getNonce(options.accountId, options.channel ?? 0)
    ).toString(),
  });
} else {
  const payer = wallet(options.payerPrivateKey),
    custody = wallet(options.custodyPrivateKey);
  let plan, payloadEvidence;
  if (options.mode === "register") {
    plan = client.buildRegistration({
      custodyAddress: custody.account,
      salt: options.salt,
      verifier: options.verifier ?? "00".repeat(20),
      hook: options.hook ?? "00".repeat(20),
      recoveryAddress: options.recoveryAddress ?? "00".repeat(20),
    });
  } else if (options.mode === "configure") {
    plan = await client.buildModuleCall({
      accountId: options.accountId,
      ...options.configuration,
    });
  } else {
    let operation = await client.prepareOperation({
      accountId: options.accountId,
      ...options.operation,
    });
    const sessionInputs =
      options.sessionSigners ??
      (options.sessionPrivateKey
        ? [
            {
              verifier: options.sessionVerifier,
              privateKey: options.sessionPrivateKey,
            },
          ]
        : []);
    const proofs = new Map(),
      sessionEvidence = [];
    for (const input of sessionInputs) {
      const verifier = c.hex(input.verifier, 20),
        session = wallet(input.privateKey),
        op = operation.operation;
      if (proofs.has(verifier)) throw new Error("Duplicate session verifier");
      const deployed = await client.rpc.send("getcontractstate", [
        "0x" + verifier,
      ]);
      if (deployed.manifest.name !== "SessionKeyVerifier")
        throw new Error("Unexpected session module");
      const chainPayload = await client._read(
        "getPayload",
        [
          c.hashValue(options.accountId),
          c.hashValue(op.targetContract),
          c.stringValue(op.method),
          { type: "Array", value: op.args },
          { type: "Integer", value: op.nonce },
          { type: "Integer", value: op.deadline },
        ],
        verifier,
      );
      if (
        !(chainPayload instanceof Uint8Array) ||
        Buffer.from(chainPayload).toString("hex") !== operation.preimage
      )
        throw new Error(
          "Session module payload differs from SDK native authorization preimage",
        );
      proofs.set(verifier, await session.sign(operation.preimage));
      sessionEvidence.push({
        publicKey: session.publicKey,
        sessionVerifier: verifier,
        chainPayloadMatched: true,
      });
    }
    if (options.multiSig) {
      const config = await client._read(
        "getConfig",
        [c.hashValue(options.accountId)],
        operation.account.verifier.contract,
      );
      if (
        !["Array", "Struct"].includes(config?.type) ||
        config.value.length !== 2 ||
        config.value[0]?.type !== "Array" ||
        config.value[0].value.some(
          (child) => !(child instanceof Uint8Array) || child.length !== 20,
        )
      )
        throw new Error("Invalid real MultiSig configuration");
      const children = config.value[0].value.map((v) =>
        Buffer.from(v).reverse().toString("hex"),
      );
      if (
        children.length < 1 ||
        children.length > 3 ||
        new Set(children).size !== children.length ||
        typeof config.value[1] !== "bigint" ||
        config.value[1] < 1n ||
        config.value[1] > 2n ||
        config.value[1] > BigInt(children.length)
      )
        throw new Error("Invalid bounded MultiSig topology");
      // Explicitly selected witness leaves use a present empty ByteString; absent
      // proofs stay Null, preserving the exact on-chain child slot order.
      const nativeLeaves =
        options.nativeVerifierLeaves ??
        children.filter((child) => !proofs.has(child));
      for (const raw of nativeLeaves) {
        const leaf = c.hex(raw, 20);
        if (!children.includes(leaf) || proofs.has(leaf))
          throw new Error("Invalid or duplicate witness leaf");
        const deployed = await client.rpc.send("getcontractstate", [
          "0x" + leaf,
        ]);
        if (deployed.manifest.name !== "NeoNativeVerifier")
          throw new Error("Unexpected witness child");
        proofs.set(leaf, "");
      }
      if ([...proofs.keys()].some((child) => !children.includes(child)))
        throw new Error("Proof is not an active child");
      const signature = c.serializeValue({
        type: "Array",
        value: children.map((child) =>
          proofs.has(child)
            ? { type: "ByteString", value: proofs.get(child) }
            : { type: "Null" },
        ),
      });
      operation = client.attachSignature(operation, signature);
      const sessionIndices = sessionEvidence.map((item) =>
        children.indexOf(item.sessionVerifier),
      );
      payloadEvidence = {
        children,
        threshold: config.value[1].toString(),
        sessionIndices,
        sessionIndex: sessionIndices[0],
        presentSlots: children.map((child) => proofs.has(child)),
      };
    } else if (sessionInputs.length) {
      if (
        sessionInputs.length !== 1 ||
        !proofs.has(operation.account.verifier.contract)
      )
        throw new Error("Session proof must match the account's root verifier");
      operation = client.attachSignature(
        operation,
        proofs.get(operation.account.verifier.contract),
      );
    }
    if (sessionEvidence.length)
      payloadEvidence = {
        ...payloadEvidence,
        sessions: sessionEvidence,
        preimage: operation.preimage,
        digest: operation.digest,
        context: operation.context,
        chainPayloadMatched: true,
      };
    plan = client.buildExecution([operation]);
  }
  const required = plan.requiredAuthorities ?? [];
  const prepared = await client.prepareTransaction(plan, {
    feePayer: payer,
    authoritySigners:
      required.includes(custody.account) && payer.account !== custody.account
        ? [custody]
        : [],
    verifierSigners: (options.verifierPrivateKeys ?? []).map(wallet),
    maxSystemFee: "1000000000",
    maxNetworkFee: "300000000",
    maxTotalFee: "1300000000",
  });
  const signed = await client.signTransaction(prepared),
    preflight = await client.preflightTransaction(signed);
  let receipt;
  if (options.mode !== "sign-only") {
    await client.broadcastTransaction(signed);
    const end = Date.now() + 45000;
    while (Date.now() < end) {
      try {
        receipt = await client.getTransactionReceipt(signed);
        if (receipt.confirmed) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!receipt?.confirmed || receipt.vmState !== "HALT")
      throw new Error("SDK transaction did not confirm HALT");
  }
  output({
    profile,
    account: await client.getAccount(plan.accountId),
    accountId: plan.accountId,
    txid: signed.txid,
    rawTransaction: signed.rawTransaction,
    systemFee: prepared.systemFee,
    networkFee: prepared.networkFee,
    systemFeeSource: prepared.systemFeeSource,
    signers: prepared.transaction.signers,
    verifierContext: prepared.verifierContext ?? null,
    payloadEvidence,
    preflight,
    receipt,
    nonce: (
      await client.getNonce(plan.accountId, options.operation?.channel ?? 0)
    ).toString(),
  });
}
