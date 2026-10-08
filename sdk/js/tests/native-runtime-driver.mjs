/** Private integration bridge. Ephemeral fixture keys enter only on stdin; never print them. */
import crypto from "node:crypto";
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
    if (options.sessionPrivateKey) {
      const session = wallet(options.sessionPrivateKey);
      const op = operation.operation;
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
        options.sessionVerifier,
      );
      if (
        !(chainPayload instanceof Uint8Array) ||
        Buffer.from(chainPayload).toString("hex") !== operation.preimage
      )
        throw new Error(
          "Session module payload differs from SDK native authorization preimage",
        );
      let signature = await session.sign(operation.preimage);
      if (options.multiSig) {
        const config = await client._read(
          "getConfig",
          [c.hashValue(options.accountId)],
          operation.account.verifier.contract,
        );
        if (
          !["Array", "Struct"].includes(config?.type) ||
          config.value.length !== 2 ||
          config.value[0]?.type !== "Array"
        )
          throw new Error("Invalid real MultiSig configuration");
        const children = config.value[0].value.map((v) =>
          Buffer.from(v).reverse().toString("hex"),
        );
        const sessionIndex = children.indexOf(
          c.hex(options.sessionVerifier, 20),
        );
        if (
          children.length !== 2 ||
          new Set(children).size !== 2 ||
          sessionIndex < 0 ||
          config.value[1] !== 2n
        )
          throw new Error(
            "Runtime fixture expects exact 2-of-2 Session/NeoNative child order",
          );
        const other = children[1 - sessionIndex];
        const deployed = await client.rpc.send("getcontractstate", [
          "0x" + other,
        ]);
        if (deployed.manifest.name !== "NeoNativeVerifier")
          throw new Error("Unexpected witness child");
        signature = c.serializeValue({
          type: "Array",
          value: children.map((_, i) => ({
            type: "ByteString",
            value: i === sessionIndex ? signature : "",
          })),
        });
        payloadEvidence = { children, threshold: "2", sessionIndex };
      }
      operation = client.attachSignature(operation, signature);
      payloadEvidence = {
        ...payloadEvidence,
        publicKey: session.publicKey,
        sessionVerifier: c.hex(options.sessionVerifier, 20),
        preimage: operation.preimage,
        digest: operation.digest,
        context: operation.context,
        chainPayloadMatched: true,
      };
    }
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
