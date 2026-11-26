/**
 * Builds a §8 message-verification invocation with the shared native client,
 * exactly as a wallet would, and prints the script hex.
 *
 * The C# suite executes the printed bytes in the same engine that holds the
 * deployed SigningModule, so the assertion covers the client's encoder and the
 * module's verifier in one hop. The client is offline: the transport is a
 * throwing stub, because building a script never sends anything.
 *
 * Usage: node ClientMessageInvocation.mjs '<json>'
 *   json: { moduleContractHash, accountId, originalSender, validatorId,
 *           generation, hash, pairs: [[scriptHex, signatureHex], ...] }
 */
import crypto from "node:crypto";
import {
  createProtocolCodec,
  createNativeClientClass,
} from "../../shared/nativeSmartAccountClient.mjs";

const sha256 = (hex) =>
  crypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const hash160 = (hex) =>
  crypto
    .createHash("ripemd160")
    .update(crypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest())
    .digest("hex");

const input = JSON.parse(process.argv[2] ?? "{}");
const codec = createProtocolCodec({ sha256, hash160 });
const Client = createNativeClientClass(codec);
const client = new Client({
  rpcClient: { send() { throw new Error("the script builder never sends"); } },
  networkMagic: input.networkMagic ?? 860833102,
});

const script = client.buildMessageVerificationScript({
  module: { contractHash: input.moduleContractHash, messageCapability: true },
  accountId: input.accountId,
  originalSender: input.originalSender,
  validatorId: input.validatorId,
  generation: input.generation,
  hash: input.hash,
  pairs: input.pairs ?? [],
});
process.stdout.write(script);
