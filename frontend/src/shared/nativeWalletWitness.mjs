// Standard Neo transaction-wallet witnesses. This module never executes scripts.
export const NATIVE_WALLET_MAX_SCRIPT_BYTES = 1024;
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const fail = (message) => { throw new Error(`Native wallet witness: ${message}`); };
function hex(value, size, label = "hex") {
  if (typeof value !== "string") fail(`${label} must be hex`);
  const normalized = value.replace(/^0x/i, "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(normalized) || (size !== undefined && normalized.length !== size * 2))
    fail(`invalid ${label}`);
  return normalized;
}
const mod = (value) => ((value % P) + P) % P;
function power(base, exponent) {
  let result = 1n;
  for (; exponent; exponent >>= 1n, base = base * base % P)
    if (exponent & 1n) result = result * base % P;
  return result;
}
function decodePoint(value) {
  const key = hex(value, 33, "P-256 public key");
  if (!/^(02|03)/.test(key)) fail("P-256 public key must be compressed");
  const x = BigInt("0x" + key.slice(2));
  if (x >= P) fail("P-256 public key is not on the curve");
  const square = mod(x * x * x - 3n * x + B);
  let y = power(square, (P + 1n) / 4n);
  if (y * y % P !== square) fail("P-256 public key is not on the curve");
  const parity = BigInt(key.slice(0, 2)) & 1n;
  if ((y & 1n) !== parity) y = P - y;
  if (y >= P || (y & 1n) !== parity) fail("invalid compressed P-256 point");
  return { key, x, y };
}
const comparePoints = (left, right) =>
  left.x < right.x ? -1 : left.x > right.x ? 1 : left.y < right.y ? -1 : left.y > right.y ? 1 : 0;
const bytes = (value) => Uint8Array.from(value.match(/../g) || [], (byte) => Number.parseInt(byte, 16));

/** Browser-safe verifier for IEEE P1363 signatures over exact transaction sign data. */
export async function verifyNativeP256Signature(publicKey, signature, signData, subtle = globalThis.crypto?.subtle) {
  const point = decodePoint(publicKey);
  const sig = hex(signature, 64, "signature"), data = hex(signData, 36, "transaction sign data");
  if (!subtle) fail("P-256 WebCrypto verification is unavailable");
  const raw = "04" + point.x.toString(16).padStart(64, "0") + point.y.toString(16).padStart(64, "0");
  const key = await subtle.importKey("raw", bytes(raw), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(sig), bytes(data));
}

/** hash160 returns a display-order script hash; verify may be synchronous or async. */
export function createNativeWalletWitnessTools({ hash160, verify = verifyNativeP256Signature } = {}) {
  if (typeof hash160 !== "function" || typeof verify !== "function") fail("hash160 and verify functions are required");
  const issued = new WeakSet();
  function parse(verificationScript, expectedAccount) {
    const verification = hex(verificationScript, undefined, "verification script");
    if (!verification.length || verification.length / 2 > NATIVE_WALLET_MAX_SCRIPT_BYTES)
      fail("verification script exceeds the 1024-byte limit or is empty");
    let threshold, points, kind;
    if (/^0c21[0-9a-f]{66}4156e7b327$/.test(verification)) {
      kind = "signature";
      threshold = 1;
      points = [decodePoint(verification.slice(4, 70))];
    } else {
      kind = "multisig";
      let offset = 0;
      const integer = () => {
        const opcode = Number.parseInt(verification.slice(offset, offset + 2), 16);
        offset += 2;
        if (opcode >= 0x11 && opcode <= 0x20) return opcode - 0x10;
        if (opcode === 0 && offset + 2 <= verification.length) {
          const value = Number.parseInt(verification.slice(offset, offset + 2), 16);
          offset += 2;
          if (value >= 17 && value <= 127) return value;
        }
        fail("noncanonical standard multisig integer");
      };
      threshold = integer();
      points = [];
      while (verification.slice(offset, offset + 4) === "0c21") {
        const point = decodePoint(verification.slice(offset + 4, offset + 70));
        if (points.length && comparePoints(points.at(-1), point) >= 0)
          fail("multisig members must be unique and in canonical point order");
        points.push(point);
        offset += 70;
      }
      const count = integer();
      if (!points.length || count !== points.length || threshold > count || verification.slice(offset) !== "419ed0dc3a")
        fail("unsupported or malformed standard multisig verification script");
    }
    if (threshold * 66 > NATIVE_WALLET_MAX_SCRIPT_BYTES)
      fail("signature invocation exceeds the 1024-byte limit");
    const account = hex(hash160(verification), 20, "wallet script hash");
    if (expectedAccount !== undefined && account !== hex(expectedAccount, 20, "wallet account"))
      fail("wallet account does not match verification script hash");
    const parsed = Object.freeze({ kind, account, verification, threshold,
      publicKeys: Object.freeze(points.map((point) => point.key)) });
    issued.add(parsed);
    return parsed;
  }
  function known(parsed) {
    if (!issued.has(parsed)) fail("wallet script must be parsed by this instance");
  }
  function placeholder(parsed) {
    known(parsed);
    return Object.freeze({ invocation: ("0c40" + "00".repeat(64)).repeat(parsed.threshold), verification: parsed.verification });
  }
  async function valid(publicKey, signature, signData) {
    if (await verify(publicKey, signature, signData) !== true) fail("wallet returned an invalid transaction signature");
  }
  async function assemble(parsed, response, signData) {
    known(parsed);
    const data = hex(signData, 36, "transaction sign data");
    let signatures;
    if (parsed.kind === "signature") {
      const signature = hex(response, 64, "single-wallet signature");
      await valid(parsed.publicKeys[0], signature, data);
      signatures = [signature];
    } else {
      if (!Array.isArray(response) || response.length < parsed.threshold || response.length > parsed.publicKeys.length)
        fail("multisig response must contain a sufficient bounded member signature array");
      // Snapshot provider-owned values before asynchronous verification begins.
      const entries = Array.from(response, (item) => ({
        publicKey: hex(item?.publicKey, 33, "member public key"),
        signature: hex(item?.signature, 64, "member signature"),
      }));
      const submitted = new Map();
      for (const { publicKey, signature } of entries) {
        if (!parsed.publicKeys.includes(publicKey) || submitted.has(publicKey))
          fail("duplicate or unknown multisig member");
        await valid(publicKey, signature, data);
        submitted.set(publicKey, signature);
      }
      // Validate every submitted item above before selecting a deterministic quorum.
      signatures = parsed.publicKeys.filter((key) => submitted.has(key)).slice(0, parsed.threshold).map((key) => submitted.get(key));
    }
    return Object.freeze({ invocation: signatures.map((signature) => "0c40" + signature).join(""), verification: parsed.verification });
  }
  async function validate(witness, account, signData) {
    const parsed = parse(witness?.verification, hex(account, 20, "wallet account"));
    const invocation = hex(witness?.invocation, undefined, "invocation script");
    const data = hex(signData, 36, "transaction sign data");
    if (invocation.length !== parsed.threshold * 132)
      fail("invocation must contain exactly the required signatures");
    let nextKey = 0;
    for (let index = 0; index < parsed.threshold; index++) {
      const chunk = invocation.slice(index * 132, (index + 1) * 132);
      if (!chunk.startsWith("0c40")) fail("noncanonical signature invocation");
      let matched = false;
      while (nextKey < parsed.publicKeys.length) {
        if (await verify(parsed.publicKeys[nextKey++], chunk.slice(4), data) === true) {
          matched = true;
          break;
        }
      }
      if (!matched) fail("invalid signature or multisig signature order");
    }
    return true;
  }
  return Object.freeze({ parse, placeholder, assemble, validate });
}
