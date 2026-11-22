/**
 * Exact SA module protocol v4 codec (docs/SA-MODULE-PROTOCOL.md).
 *
 * One implementation of the wire format of the native kernel: the 13-field
 * operation envelope (§4), the canonical unsigned
 * serialization (§4.2), the §4.3 operation digest, the §6 nonce channel
 * derivation, the §8 message digest, the §16.1 identity domain and the
 * script builders. Every helper is pure: no RPC, no ambient state, hashing is
 * injected as synchronous hex adapters so Node and the browser agree.
 */
export const NATIVE_SMART_ACCOUNT_CONTRACT =
  "398dc3f0227d7efac5533ed5ce9937390c158084";
export const PROTOCOL_VERSION = 4;
export const NATIVE_ABI_VERSION = 4;
export const OPERATION_FIELDS = 13;
export const NONCE_SUBKEY_BYTES = 32;
export const MESSAGE_HASH_BYTES = 32;
export const SIGNATURE_BYTES_MAX = 8192;
export const ARGS_ENTRIES_MAX = 64;
export const ARGS_BYTES_MAX = 4096;
export const ARGS_DEPTH_MAX = 8;
export const OPERATIONS_PER_ENVELOPE_MAX = 32;
export const OPERATION_ENCODED_SIZE_MAX = 16384;
export const ENVELOPE_ENCODED_SIZE_MAX = 65536;
export const HOOK_PROOFS_ENTRIES_MAX = 8;
export const HOOK_PROOFS_BYTES_MAX = 4096;
const ACCOUNT_IDENTITY_DOMAIN = "aa524704";
const USER_OPERATION_DOMAIN = "NeoSmartAccount/UserOperation";
const MESSAGE_DOMAIN = "NeoSmartAccount/Message";
const U64 = 1n << 64n;
const I255 = 1n << 255n;
const CHANNEL_MASK = (1n << 191n) - 1n;
const utf8 = new TextEncoder();
const fail = (message) => {
  throw new Error(`SmartAccount v4: ${message}`);
};
export function nativeHex(value, bytes) {
  if (typeof value !== "string") fail("hex bytes must be a string");
  const s = value.replace(/^0x/i, "").toLowerCase();
  if (
    !/^(?:[0-9a-f]{2})*$/.test(s) ||
    (bytes !== undefined && s.length !== bytes * 2)
  )
    fail("invalid hex byte length or encoding");
  return s;
}
function bytes(hex) {
  const s = nativeHex(hex);
  return Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));
}
function hex(data) {
  return Array.from(data, (n) => n.toString(16).padStart(2, "0")).join("");
}
const join = (...parts) => parts.join("");
function integer(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    fail("integer number must be safe and exact");
  if (
    !["bigint", "number", "string"].includes(typeof value) ||
    (typeof value === "string" && !/^-?(?:0|[1-9][0-9]*)$/.test(value))
  )
    fail("expected an exact decimal integer");
  return BigInt(value);
}
function unsigned(value, bits, label) {
  const n = integer(value);
  if (n < 0n || n >> BigInt(bits) !== 0n) fail(`${label} outside uint${bits}`);
  return n;
}
function le(value, size) {
  let n = BigInt(value);
  if (n < 0n) n += 1n << BigInt(size * 8);
  let s = "";
  for (let i = 0; i < size; i++) {
    s += Number(n & 255n)
      .toString(16)
      .padStart(2, "0");
    n >>= 8n;
  }
  return s;
}
function be(value, size) {
  let n = unsigned(value, size * 8, "big-endian word");
  let s = "";
  for (let i = 0; i < size; i++) {
    s = Number(n & 255n)
      .toString(16)
      .padStart(2, "0") + s;
    n >>= 8n;
  }
  return s;
}
function signedBytes(value) {
  const n = integer(value);
  if (n < -I255 || n >= I255) fail("integer outside signed NeoVM domain");
  if (!n) return "";
  for (let size = 1; size <= 32; size++)
    if (n >= -(1n << BigInt(size * 8 - 1)) && n < 1n << BigInt(size * 8 - 1))
      return le(n, size);
  fail("invalid integer");
}
function vi(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
    fail("length exceeds codec bounds");
  return n < 253 ? le(n, 1) : n <= 65535 ? "fd" + le(n, 2) : "fe" + le(n, 4);
}
function strictText(value) {
  if (
    typeof value !== "string" ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    fail("text must be strict Unicode");
  return hex(utf8.encode(value));
}
function reverse(value) {
  return hex(bytes(value).reverse());
}
function pushBytes(value) {
  const n = value.length / 2;
  return n < 256
    ? "0c" + le(n, 1) + value
    : n < 65536
      ? "0d" + le(n, 2) + value
      : "0e" + le(n, 4) + value;
}
function pushInt(value) {
  const n = integer(value);
  signedBytes(n);
  if (n >= -1n && n <= 16n) return le(n + 16n, 1);
  for (const [i, size] of [1, 2, 4, 8, 16, 32].entries())
    if (n >= -(1n << BigInt(size * 8 - 1)) && n < 1n << BigInt(size * 8 - 1))
      return le(i, 1) + le(n, size);
  fail("unencodable integer");
}
const integerValue = (value) => ({
  type: "Integer",
  value: integer(value).toString(),
});
const byteStringValue = (value) => ({ type: "ByteString", value: nativeHex(value) });
function canonicalValue(item, seen = new Set(), depth = 0, maxDepth = ARGS_DEPTH_MAX) {
  if (!item || typeof item !== "object" || Array.isArray(item))
    fail("typed VM value required");
  const { type, value } = item;
  if (type === "Null") {
    if (value !== undefined && value !== null) fail("Null cannot have a value");
    return { type };
  }
  if (type === "Boolean") {
    if (typeof value !== "boolean") fail("Boolean coercion forbidden");
    return { type, value };
  }
  if (type === "Integer") {
    signedBytes(value);
    return integerValue(value);
  }
  if (type === "ByteString") return byteStringValue(value);
  if (type !== "Array")
    // §4.1: an operation argument is Null, Boolean, Integer, ByteString or
    // Array. A Struct (or a Map) anywhere in the operation is rejected, because
    // the two kernels would have to agree on a container this protocol never
    // defines.
    fail(`unsupported VM type ${type}`);
  if (
    !Array.isArray(value) ||
    depth > maxDepth ||
    seen.has(item) ||
    seen.has(value)
  )
    fail("compound value depth, type or shared reference invalid");
  seen.add(item);
  seen.add(value);
  return {
    type,
    value: value.map((v) => canonicalValue(v, seen, depth + 1, maxDepth)),
  };
}
function serialize(item) {
  switch (item.type) {
    case "Null":
      return "00";
    case "Boolean":
      return item.value ? "2001" : "2000";
    case "Integer": {
      const b = signedBytes(item.value);
      return "21" + vi(b.length / 2) + b;
    }
    case "ByteString":
      return "28" + vi(item.value.length / 2) + item.value;
    case "Array":
    case "Struct":
      return (
        (item.type === "Array" ? "40" : "41") +
        vi(item.value.length) +
        item.value.map(serialize).join("")
      );
    default:
      return fail("unsupported VM value");
  }
}
function encode(item) {
  switch (item.type) {
    case "Null":
      return "0b";
    case "Boolean":
      return item.value ? "08" : "09";
    case "Integer":
      return pushInt(item.value);
    case "ByteString":
      return pushBytes(item.value);
    case "Array":
    case "Struct":
      return item.value.length
        ? [...item.value].reverse().map(encode).join("") +
            pushInt(item.value.length) +
            (item.type === "Array" ? "c0" : "bf")
        : item.type === "Array"
          ? "c2"
          : "c6";
    default:
      return fail("unsupported VM value");
  }
}
function methodBytes(method) {
  const s = strictText(method);
  const length = s.length / 2;
  if (length < 1 || length > 128) fail("method must contain 1..128 UTF8 bytes");
  return s;
}
function hashValue(value) {
  return { type: "ByteString", value: reverse(nativeHex(value, 20)) };
}
function hookProofsValue(proofs) {
  if (proofs === undefined || proofs === null) return { type: "Array", value: [] };
  if (!Array.isArray(proofs) || proofs.length > HOOK_PROOFS_ENTRIES_MAX)
    fail(`hook proofs require 0..${HOOK_PROOFS_ENTRIES_MAX} entries`);
  let total = 0;
  // §4.1 [12]: hook ids are module ids, so 0 is not a hook. Seeding the cursor
  // with 0 makes the strictly-ascending check reject a zero id as well; a -1
  // cursor silently accepted it.
  let previous = 0n;
  const entries = proofs.map((entry) => {
    const pair = Array.isArray(entry)
      ? { hookId: entry[0], proof: entry[1] }
      : { hookId: entry?.hookId, proof: entry?.proof };
    const hookId = unsigned(pair.hookId, 64, "hook id");
    if (hookId <= previous) fail("hook ids must be unique and strictly ascending");
    previous = hookId;
    const proof = nativeHex(pair.proof ?? "");
    total += proof.length / 2;
    return {
      type: "Array",
      value: [integerValue(hookId), byteStringValue(proof)],
    };
  });
  if (total > HOOK_PROOFS_BYTES_MAX) fail("aggregate hook proof bytes exceed 4096");
  return { type: "Array", value: entries };
}
function operationValue(op, emptySignature = false) {
  if (!op || typeof op !== "object") fail("operation required");
  const target = nativeHex(op.targetContract, 20);
  if (/^0+$/.test(target)) fail("zero target");
  if (!Array.isArray(op.args) || op.args.length > ARGS_ENTRIES_MAX)
    fail(`operation args must be an Array with at most ${ARGS_ENTRIES_MAX} values`);
  // §4.1: the args vector is the first of the eight permitted levels, so the
  // root is seeded at depth 1 — seven nested Arrays fit, an eighth does not.
  const args = canonicalValue({ type: "Array", value: op.args }, new Set(), 1);
  if (serialize(args).length / 2 > ARGS_BYTES_MAX)
    fail(`serialized arguments exceed ${ARGS_BYTES_MAX} bytes`);
  const signature = op.signature === undefined || op.signature === null
    ? ""
    : nativeHex(op.signature);
  if (signature.length / 2 > SIGNATURE_BYTES_MAX)
    fail(`signature exceeds ${SIGNATURE_BYTES_MAX} bytes`);
  if (!emptySignature && signature.length === 0)
    fail("signature must contain 1..8192 bytes");
  const nonce = unsigned(op.nonce, 255, "nonce");
  const deadline = unsigned(op.deadline, 255, "deadline");
  const validatorId = unsigned(op.validatorId, 64, "validator id");
  const credentialGeneration = unsigned(
    requireGeneration(op.credentialGeneration),
    64,
    "credential generation",
  );
  // §4.1 [8]: the generation is 1-based and the core faults a zero with
  // SA_OPERATION_MALFORMED, so the codec refuses to encode one.
  if (credentialGeneration < 1n) fail("credentialGeneration must be >= 1");
  const authorityEpoch = unsigned(op.authorityEpoch, 64, "authority epoch");
  const configurationNonce = unsigned(
    op.configurationNonce,
    64,
    "configuration nonce",
  );
  const fields = [
    integerValue(PROTOCOL_VERSION),
    hashValue(target),
    byteStringValue(methodBytes(op.method)),
    args,
    integerValue(nonce),
    byteStringValue(nativeHex(op.nonceSubkey, NONCE_SUBKEY_BYTES)),
    integerValue(deadline),
    integerValue(validatorId),
    integerValue(credentialGeneration),
    integerValue(authorityEpoch),
    integerValue(configurationNonce),
    byteStringValue(signature),
    hookProofsValue(op.hookProofs),
  ];
  // §4.1 envelope cap: one operation encodes to at most 16 KiB. The signed form
  // is measured even on the digest path, because the core validates the
  // broadcast operation, not its signature-free preimage.
  const signed = { type: "Array", value: fields };
  if (serialize(signed).length / 2 > OPERATION_ENCODED_SIZE_MAX)
    fail(`serialized operation exceeds ${OPERATION_ENCODED_SIZE_MAX} bytes`);
  return emptySignature
    ? {
        type: "Array",
        value: fields.map((field, index) =>
          index === 11 ? byteStringValue("") : field,
        ),
      }
    : signed;
}
function dynamicCall(contract, method, args, flags = 15) {
  const values = canonicalValue(
    { type: "Array", value: args },
    new Set(),
    0,
    12,
  );
  return (
    encode(values) +
    pushInt(flags) +
    pushBytes(methodBytes(method)) +
    pushBytes(reverse(nativeHex(contract, 20))) +
    "41627d5b52"
  );
}
function operationSetting(op, name) {
  const value = unsigned(op?.[name], 64, name);
  return be(value, 8);
}

/// §4.3/§6/§8 generation word. There is no protocol default: the built-in
/// validator's generation is the account's 0x57 SubjectRevision and an
/// installed validator's is its CredentialGeneration, so a rule that silently
/// substituted 1 (or 0) would bind every such digest to a namespace the core
/// never validates. Only the caller -- or the chain, for the read paths --
/// knows the value, so a missing one is a hard error here.
const GENERATION_REQUIRED =
  "credential generation is required: pass the routing generation read from " +
  "the chain (SubjectRevision for the built-in validator, CredentialGeneration " +
  "for an installed validator or threshold policy), never an assumed default";
function requireGeneration(value) {
  if (value === undefined || value === null) fail(GENERATION_REQUIRED);
  return value;
}
function generationSetting(value) {
  return be(unsigned(requireGeneration(value), 64, "credential generation"), 8);
}

// ---------------------------------------------------------------------------
// Standalone VM encoders for modules that only build scripts or parameters and
// never hash (the proxy-witness builder, the transaction artifact, the relay
// parameter adapter). The codec factory below exposes the same functions next
// to the hash derivations; there is one implementation, not two.
// ---------------------------------------------------------------------------
export const canonicalizeValue = (value) => canonicalValue(value);
export const serializeCanonicalValue = (value) => serialize(value);
export const encodeCanonicalValue = (value) => encode(value);
export { integerValue, byteStringValue, hashValue };
export const userOperationValue = (op) => operationValue(op);
export const serializeUserOperation = (op, emptySignature = false) =>
  serialize(operationValue(op, emptySignature));
export const encodeUserOperation = (op) => encode(operationValue(op));
export const encodeDynamicCall = (contract, method, flagsOrArgs, maybeFlags) =>
  // Callers pass (contract, method, args, flags); a direct call without flags
  // keeps the native kernel's CallFlags.All default.
  dynamicCall(contract, method, flagsOrArgs, maybeFlags);
export function createProtocolCodec({ sha256, hash160 }) {
  if (typeof sha256 !== "function" || typeof hash160 !== "function")
    fail("synchronous hex hash adapters required");
  const sha = (value) => nativeHex(sha256(value), 32);
  const hash = (value) => nativeHex(hash160(value), 20);

  /// The account-bound proxy verification script: PUSHDATA1 20 accountId,
  /// PUSH1 PACK <flags>, PUSHDATA1 6 "verify", PUSHDATA1 20 core,
  /// SYSCALL System.Contract.Call. The native kernel builds PUSH5 =
  /// CallFlags.ReadOnly, so 5 is the default here as well; the numeric flag is
  /// still an explicit parameter, because the proxy address must be the one the
  /// submitting core derives (spec §16.1).
  const verificationScript = (
    accountId,
    { coreContractHash = NATIVE_SMART_ACCOUNT_CONTRACT, callFlags = 5 } = {},
  ) => dynamicCall(coreContractHash, "verify", [hashValue(accountId)], callFlags);

  /// §16.1 identity: Hash160(0xAA524704 ‖ custody ‖ salt), raw UInt160 storage
  /// order; the display form is the big-endian reversal of the same bytes.
  const deriveIdentity = ({ custodyAddress, salt, coreContractHash, callFlags }) => {
    const custody = nativeHex(custodyAddress, 20);
    const core = nativeHex(
      coreContractHash ?? NATIVE_SMART_ACCOUNT_CONTRACT,
      20,
    );
    // The proxy calls its own core, so naming the core as custody would make
    // the account id a hash of the contract that is answering for it.
    if (/^0+$/.test(custody) || custody === core) fail("invalid custody");
    const saltHex = nativeHex(salt);
    if (saltHex.length < 2 || saltHex.length > 256)
      fail("registration salt must contain 1..128 bytes");
    const accountId = hash(join(ACCOUNT_IDENTITY_DOMAIN, reverse(custody), saltHex));
    if (/^0+$/.test(accountId)) fail("derived zero identity");
    const script = verificationScript(accountId, { coreContractHash, callFlags });
    return Object.freeze({
      accountId,
      verificationScript: script,
      accountAddress: reverse(hash(script)),
    });
  };

  /// §4.3 domain: UTF8("NeoSmartAccount/UserOperation") ‖ U1(4) ‖
  /// U32LE(network) ‖ coreHash ‖ accountId ‖ U64BE(validatorId) ‖
  /// U64BE(credentialGeneration) ‖ U64BE(authorityEpoch) ‖
  /// U64BE(configurationNonce). The validator id defaults to 0 because that is
  /// the built-in route itself; the generation never defaults.
  const operationDomain = (context, op) =>
    join(
      strictText(USER_OPERATION_DOMAIN),
      le(PROTOCOL_VERSION, 1),
      le(unsigned(context?.networkMagic, 32, "network magic"), 4),
      reverse(nativeHex(context?.coreContractHash ?? NATIVE_SMART_ACCOUNT_CONTRACT, 20)),
      reverse(nativeHex(context?.accountId, 20)),
      operationSetting(op, "validatorId"),
      generationSetting(op?.credentialGeneration),
      operationSetting(op, "authorityEpoch"),
      operationSetting(op, "configurationNonce"),
    );

  /// §8 message digest: UTF8("NeoSmartAccount/Message") ‖ U1(4) ‖
  /// U32LE(network) ‖ coreHash ‖ accountId ‖ originalSender ‖
  /// U64BE(validatorId) ‖ U64BE(credentialGeneration) ‖ U64BE(authorityEpoch)
  /// ‖ hash. `validatorId` defaults to the built-in route 0; the generation
  /// does not default (§8 binds it to SubjectRevision or CredentialGeneration).
  const messageDigest = (context, message) =>
    sha(
      join(
        strictText(MESSAGE_DOMAIN),
        le(PROTOCOL_VERSION, 1),
        le(unsigned(context?.networkMagic, 32, "network magic"), 4),
        reverse(nativeHex(context?.coreContractHash ?? NATIVE_SMART_ACCOUNT_CONTRACT, 20)),
        reverse(nativeHex(context?.accountId, 20)),
        reverse(nativeHex(message?.originalSender, 20)),
        be(unsigned(message?.validatorId ?? 0, 64, "validator id"), 8),
        generationSetting(message?.credentialGeneration),
        be(unsigned(context?.authorityEpoch, 64, "authority epoch"), 8),
        nativeHex(message?.hash, MESSAGE_HASH_BYTES),
      ),
    );

  /// §6 nonce namespace digest (the full 256-bit derivation), and the derived
  /// 191-bit channel taken from its low bits. The generation is part of the
  /// namespace, so it is supplied, never assumed.
  const nonceNamespaceDigest = (context, { validatorId, credentialGeneration, nonceSubkey }) =>
    sha(
      join(
        le(PROTOCOL_VERSION, 1),
        reverse(nativeHex(context?.coreContractHash ?? NATIVE_SMART_ACCOUNT_CONTRACT, 20)),
        reverse(nativeHex(context?.accountId, 20)),
        be(unsigned(context?.authorityEpoch, 64, "authority epoch"), 8),
        be(unsigned(validatorId ?? 0, 64, "validator id"), 8),
        generationSetting(credentialGeneration),
        nativeHex(nonceSubkey, NONCE_SUBKEY_BYTES),
      ),
    );
  const deriveNonceChannel = (context, routing) =>
    (BigInt("0x" + nonceNamespaceDigest(context, routing)) & CHANNEL_MASK).toString();

  /// Built-in (validatorId = 0) message and operation signature envelope:
  /// serialized [4, 0, generation, [[canonicalP256Script, r‖s], ...]].
  const builtInSignature = ({ credentialGeneration, pairs }) => {
    if (!Array.isArray(pairs) || pairs.length < 1) fail("at least one signature pair required");
    const seen = new Set();
    const value = pairs.map((pair) => {
      const script = nativeHex(pair.script);
      if (seen.has(script)) fail("signature scripts must be pairwise distinct");
      seen.add(script);
      return {
        type: "Array",
        value: [byteStringValue(script), byteStringValue(nativeHex(pair.signature, 64))],
      };
    });
    return serialize(
      canonicalValue({
        type: "Array",
        value: [
          integerValue(PROTOCOL_VERSION),
          integerValue(0),
          integerValue(credentialGeneration),
          { type: "Array", value },
        ],
      }),
    );
  };

  /// Threshold route signature field: serialized [[memberModuleId, signature]].
  const thresholdSignature = (members) => {
    if (!Array.isArray(members) || members.length < 1) fail("at least one member signature required");
    // §5: members are module ids, so 0 is not a member. Seeding the cursor
    // with 0 makes the strictly-ascending check reject a zero id as well; a -1
    // cursor silently accepted it (ModuleOperation.cs seeds BigInteger.Zero).
    let previous = 0n;
    const value = members.map((member) => {
      const moduleId = unsigned(member.moduleId, 64, "member module id");
      if (moduleId <= previous) fail("threshold members must be strictly ascending");
      previous = moduleId;
      return {
        type: "Array",
        value: [
          integerValue(moduleId),
          byteStringValue(nativeHex(member.signature)),
        ],
      };
    });
    return serialize(canonicalValue({ type: "Array", value }));
  };

  /// §5 threshold member digest: SHA256("NeoSmartAccount/ThresholdMember" ‖
  /// U1(4) ‖ operationDigest ‖ U64BE(memberModuleId) ‖ U64BE(memberGeneration)).
  const thresholdMemberDigest = (operationDigest, moduleId, credentialGeneration) =>
    sha(
      join(
        strictText("NeoSmartAccount/ThresholdMember"),
        le(PROTOCOL_VERSION, 1),
        nativeHex(operationDigest, 32),
        be(unsigned(moduleId, 64, "member module id"), 8),
        be(unsigned(credentialGeneration, 64, "member credential generation"), 8),
      ),
    );

  const serializeOperation = (op, emptySignature = false) =>
    serialize(operationValue(op, emptySignature));

  const buildExecutionScript = (accountId, operations, context) => {
    if (
      !Array.isArray(operations) ||
      !operations.length ||
      operations.length > OPERATIONS_PER_ENVELOPE_MAX
    )
      fail(`execution requires 1..${OPERATIONS_PER_ENVELOPE_MAX} operations`);
    const batch = operations.length !== 1;
    const sameAccount =
      context?.accountId === undefined ||
      nativeHex(context.accountId, 20) === nativeHex(accountId, 20);
    if (!sameAccount) fail("execution context account mismatch");
    const ops = operations.map((op) => operationValue(op));
    const envelope = batch ? { type: "Array", value: ops } : ops[0];
    // §4.1 envelope cap: a batch of at most 32 operations encodes to 64 KiB.
    if (batch && serialize(envelope).length / 2 > ENVELOPE_ENCODED_SIZE_MAX)
      fail(`serialized batch envelope exceeds ${ENVELOPE_ENCODED_SIZE_MAX} bytes`);
    return dynamicCall(
      context?.coreContractHash ?? NATIVE_SMART_ACCOUNT_CONTRACT,
      batch ? "executeUserOps" : "executeUserOp",
      [hashValue(accountId), envelope],
    );
  };

  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    hex: nativeHex,
    bytes,
    bytesToHex: hex,
    integer,
    unsigned,
    integerValue,
    byteStringValue,
    hashValue,
    stringValue: (value) => ({ type: "ByteString", value: strictText(value) }),
    canonicalValue,
    serializeValue: (value) => serialize(canonicalValue(value)),
    encodeValue: (value) => encode(canonicalValue(value)),
    operationValue,
    serializeOperation,
    dynamicCall,
    composeNonce: (channel, sequence) =>
      (unsigned(channel, 191, "nonce channel") << 64n) |
      unsigned(sequence, 64, "nonce sequence"),
    splitNonce: (nonce) => {
      const n = unsigned(nonce, 255, "nonce");
      return { channel: n >> 64n, sequence: n & (U64 - 1n) };
    },
    verificationScript,
    accountAddress: (accountId, options) =>
      reverse(hash(verificationScript(accountId, options))),
    deriveIdentity,
    nonceNamespaceDigest,
    deriveNonceChannel,
    operationDomain,
    operationPreimage: (context, op) => operationDomain(context, op) + serializeOperation(op, true),
    operationDigest: (context, op) => sha(operationDomain(context, op) + serializeOperation(op, true)),
    messageDigest,
    builtInSignature,
    thresholdSignature,
    thresholdMemberDigest,
    buildExecutionScript,
  });
}
