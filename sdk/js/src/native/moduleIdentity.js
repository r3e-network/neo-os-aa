const crypto = require("node:crypto");
const fail = (message) => {
  throw new Error(`Native module identity: ${message}`);
};
const sha = (data) => crypto.createHash("sha256").update(data).digest();
function codeIdentityTools(c) {
  const text = (value) => Buffer.from(c.stringValue(value).value, "hex");
  const le = (value, width) => {
    let n = c.unsigned(value, width * 8, "NEF integer");
    const b = Buffer.alloc(width);
    for (let i = 0; i < width; i++) {
      b[i] = Number(n & 255n);
      n >>= 8n;
    }
    return b;
  };
  const vi = (n) =>
    n < 253
      ? le(n, 1)
      : n < 65536
        ? Buffer.concat([Buffer.from([253]), le(n, 2)])
        : Buffer.concat([Buffer.from([254]), le(n, 4)]);
  const vb = (b) => Buffer.concat([vi(b.length), b]);
  function canonicalJson(value, depth = 0) {
    if (depth > 64) fail("manifest JSON exceeds maximum depth");
    if (value === null || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value === "string") {
      text(value);
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("non-finite JSON number");
      return JSON.stringify(value);
    }
    if (Array.isArray(value))
      return (
        "[" + value.map((v) => canonicalJson(v, depth + 1)).join(",") + "]"
      );
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      fail("invalid manifest JSON value");
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => {
          text(k);
          return JSON.stringify(k) + ":" + canonicalJson(value[k], depth + 1);
        })
        .join(",") +
      "}"
    );
  }
  function flags(value) {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 0 || value > 15)
        fail("invalid method-token flags");
      return value;
    }
    if (typeof value !== "string") fail("invalid method-token flags");
    const values = {
      None: 0,
      ReadStates: 1,
      WriteStates: 2,
      AllowCall: 4,
      AllowNotify: 8,
      States: 3,
      ReadOnly: 5,
      All: 15,
    };
    let result = 0;
    for (const word of value.split(",").map((x) => x.trim())) {
      if (!(word in values)) fail("unknown method-token flags");
      result |= values[word];
    }
    return result;
  }
  function serializeNef(nef) {
    if (
      nef?.magic !== 0x3346454e ||
      !Array.isArray(nef.tokens) ||
      nef.tokens.length > 128
    )
      fail("invalid NEF header");
    const compiler = text(nef.compiler),
      source = text(nef.source);
    if (compiler.length > 64 || source.length > 256)
      fail("invalid NEF compiler/source bounds");
    if (
      typeof nef.script !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        nef.script,
      )
    )
      fail("invalid NEF script base64");
    const script = Buffer.from(nef.script, "base64");
    if (!script.length || script.length > 512 * 1024)
      fail("invalid NEF script length");
    const tokens = nef.tokens.map((t) => {
      const method = text(t.method);
      if (
        !method.length ||
        method.length > 32 ||
        typeof t.hasreturnvalue !== "boolean"
      )
        fail("invalid NEF method token");
      return Buffer.concat([
        Buffer.from(c.hex(t.hash, 20), "hex").reverse(),
        vb(method),
        le(t.paramcount, 2),
        Buffer.from([Number(t.hasreturnvalue), flags(t.callflags)]),
      ]);
    });
    const content = Buffer.concat([
      le(nef.magic, 4),
      compiler,
      Buffer.alloc(64 - compiler.length),
      vb(source),
      Buffer.from([0]),
      vi(tokens.length),
      ...tokens,
      Buffer.from([0, 0]),
      vb(script),
    ]);
    const checksum = sha(sha(content)).subarray(0, 4);
    if (checksum.readUInt32LE() !== nef.checksum) fail("NEF checksum mismatch");
    return Buffer.concat([content, checksum]);
  }
  function moduleCodeHash(contract) {
    const nef = serializeNef(contract.nef),
      manifest = text(canonicalJson(contract.manifest));
    if (manifest.length > 65535) fail("manifest exceeds Neo size bound");
    return Buffer.from(sha(Buffer.concat([nef, Buffer.from([0]), manifest])))
      .reverse()
      .toString("hex");
  }
  return { canonicalJson, serializeNef, moduleCodeHash };
}
module.exports = { codeIdentityTools };
