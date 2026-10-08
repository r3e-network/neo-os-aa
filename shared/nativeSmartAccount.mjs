/** Exact native AccountManagement ABI 2 codec. No public V3/RPC type coercion. */
export const NATIVE_ACCOUNT_SERVICE =
  "d9421d07adf206e9dc4be746a02e8e087fa61741";
export const NATIVE_ABI_VERSION = 2;
const U64 = 1n << 64n;
const I255 = 1n << 255n;
const utf8 = new TextEncoder();
const fail = (message) => {
  throw new Error(`Native SmartAccount: ${message}`);
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
function join(...data) {
  return data.join("");
}
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
  if (n < 0n || n >= 1n << BigInt(bits)) fail(`${label} outside uint${bits}`);
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
function canonicalValue(item, seen = new Set(), depth = 0, maxDepth = 8) {
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
    return { type, value: integer(value).toString() };
  }
  if (type === "ByteString") return { type, value: nativeHex(value) };
  if (type !== "Array" && type !== "Struct")
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
  if (s.length < 2 || s.length > 256)
    fail("method must contain 1..128 UTF8 bytes");
  return s;
}
function hashValue(value) {
  return { type: "ByteString", value: reverse(nativeHex(value, 20)) };
}
function operationValue(op, emptySignature = false) {
  if (!op || typeof op !== "object") fail("operation required");
  const target = nativeHex(op.targetContract, 20);
  if (/^0+$/.test(target)) fail("zero target");
  if (!Array.isArray(op.args) || op.args.length > 64)
    fail("operation args must be an Array with at most 64 values");
  const args = canonicalValue({ type: "Array", value: op.args });
  if (serialize(args).length > 8192)
    fail("serialized arguments exceed 4096 bytes");
  const sig = nativeHex(op.signature ?? "");
  if (sig.length > 2048) fail("signature exceeds 1024 bytes");
  const nonce = unsigned(op.nonce, 255, "nonce").toString(),
    deadline = unsigned(op.deadline, 255, "deadline").toString();
  return {
    type: "Array",
    value: [
      hashValue(target),
      { type: "ByteString", value: methodBytes(op.method) },
      args,
      { type: "Integer", value: nonce },
      { type: "Integer", value: deadline },
      { type: "ByteString", value: emptySignature ? "" : sig },
    ],
  };
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
export function createNativeCodec({ sha256, hash160 }) {
  if (typeof sha256 !== "function" || typeof hash160 !== "function")
    fail("synchronous hex hash adapters required");
  const sha = (value) => nativeHex(sha256(value), 32),
    hash = (value) => nativeHex(hash160(value), 20);
  const verificationScript = (accountId) =>
    dynamicCall(NATIVE_ACCOUNT_SERVICE, "verify", [hashValue(accountId)], 5);
  const authorizationDomain = (context) =>
    join(
      strictText("NeoSmartAccount/UserOperation"),
      "02",
      le(unsigned(context.networkMagic, 32, "network magic"), 4),
      reverse(NATIVE_ACCOUNT_SERVICE),
      reverse(nativeHex(context.accountId, 20)),
      le(unsigned(context.authorityEpoch, 64, "authority epoch"), 8),
      le(unsigned(context.configurationNonce, 64, "configuration nonce"), 8),
    );
  const serializeOperation = (op, emptySignature = false) =>
    serialize(operationValue(op, emptySignature));
  return Object.freeze({
    hex: nativeHex,
    bytes,
    bytesToHex: hex,
    integer,
    unsigned,
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
    accountAddress: (accountId) => reverse(hash(verificationScript(accountId))),
    deriveIdentity: ({ networkMagic, custodyAddress, salt }) => {
      const custody = nativeHex(custodyAddress, 20);
      if (/^0+$/.test(custody) || custody === NATIVE_ACCOUNT_SERVICE)
        fail("invalid custody");
      const accountId = reverse(
        hash(
          join(
            strictText("NeoSmartAccount"),
            "01",
            le(unsigned(networkMagic, 32, "network magic"), 4),
            reverse(NATIVE_ACCOUNT_SERVICE),
            reverse(custody),
            nativeHex(salt, 32),
          ),
        ),
      );
      if (/^0+$/.test(accountId)) fail("derived zero identity");
      return Object.freeze({
        accountId,
        accountAddress: reverse(hash(verificationScript(accountId))),
        verificationScript: verificationScript(accountId),
      });
    },
    authorizationDomain,
    operationPreimage: (context, op) =>
      authorizationDomain(context) + serializeOperation(op, true),
    operationDigest: (context, op) =>
      sha(authorizationDomain(context) + serializeOperation(op, true)),
    buildExecutionScript: (
      accountId,
      operations,
      context,
      batch = operations.length !== 1,
    ) => {
      if (
        !Array.isArray(operations) ||
        !operations.length ||
        operations.length > 32 ||
        (!batch && operations.length !== 1)
      )
        fail("execution requires 1..32 operations");
      const authorityEpoch = unsigned(
        context?.authorityEpoch,
        64,
        "expected authority epoch",
      ).toString();
      const configurationNonce = unsigned(
        context?.configurationNonce,
        64,
        "expected configuration nonce",
      ).toString();
      if (
        context?.accountId !== undefined &&
        nativeHex(context.accountId, 20) !== nativeHex(accountId, 20)
      )
        fail("execution context account mismatch");
      const ops = operations.map((op) => operationValue(op));
      return dynamicCall(
        NATIVE_ACCOUNT_SERVICE,
        batch ? "executeUserOps" : "executeUserOp",
        [
          hashValue(accountId),
          batch ? { type: "Array", value: ops } : ops[0],
          { type: "Integer", value: authorityEpoch },
          { type: "Integer", value: configurationNonce },
        ],
      );
    },
  });
}
