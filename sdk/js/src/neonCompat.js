const crypto = require('node:crypto');
const { EC, createError } = require('./errors');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_LOOKUP = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));
const DEFAULT_ADDRESS_VERSION = 53;
const DEFAULT_RPC_TIMEOUT_MS = 15000;
const CALL_FLAGS_ALL = 15;
const OPCODE = {
  PUSHINT8: 0,
  PUSHINT16: 1,
  PUSHINT32: 2,
  PUSHINT64: 3,
  PUSHINT128: 4,
  PUSHINT256: 5,
  PUSHDATA1: 12,
  PUSHDATA2: 13,
  PUSHDATA4: 14,
  PUSHM1: 15,
  PACKMAP: 190,
  PACK: 192,
  NEWARRAY0: 194,
  SYSCALL: 65,
};

function strip0x(value = '') {
  return String(value).replace(/^0x/i, '');
}

function normalizeHex(value = '') {
  const normalized = strip0x(value).toLowerCase();
  if (normalized.length % 2 !== 0) throw new Error('Hex strings must have an even length');
  return normalized;
}

function hexToBuffer(value = '') {
  return Buffer.from(normalizeHex(value), 'hex');
}

function bufferToHex(value) {
  return Buffer.from(value).toString('hex');
}

function concatBuffers(...values) {
  return Buffer.concat(values.map((value) => Buffer.from(value)));
}

function reverseBuffer(value) {
  return Buffer.from(value).reverse();
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(Buffer.from(value)).digest();
}

function hash256Bytes(value) {
  return sha256Bytes(sha256Bytes(value));
}

function hash160Bytes(value) {
  return crypto.createHash('ripemd160').update(sha256Bytes(value)).digest();
}

function hash160Hex(hex) {
  return bufferToHex(hash160Bytes(hexToBuffer(hex)));
}

function reverseHex(value) {
  return bufferToHex(reverseBuffer(hexToBuffer(value)));
}

function base58Encode(bytes) {
  const value = Buffer.from(bytes);
  let number = value.length > 0 ? BigInt(`0x${value.toString('hex')}`) : 0n;
  let encoded = '';

  while (number > 0n) {
    const remainder = Number(number % 58n);
    number /= 58n;
    encoded = BASE58_ALPHABET[remainder] + encoded;
  }

  for (let index = 0; index < value.length && value[index] === 0; index += 1) {
    encoded = `1${encoded}`;
  }

  return encoded || '1';
}

function base58Decode(value) {
  let number = 0n;
  for (const char of String(value || '')) {
    const digit = BASE58_LOOKUP.get(char);
    if (digit === undefined) throw new Error('invalid base58 payload');
    number = number * 58n + BigInt(digit);
  }

  let hex = number.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  let decoded = hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0);

  let leadingZeroes = 0;
  for (const char of String(value || '')) {
    if (char !== '1') break;
    leadingZeroes += 1;
  }

  if (leadingZeroes > 0) {
    decoded = Buffer.concat([Buffer.alloc(leadingZeroes), decoded]);
  }

  return decoded;
}

function checksum(payload) {
  return hash256Bytes(payload).subarray(0, 4);
}

function base58CheckEncode(payload) {
  return base58Encode(concatBuffers(payload, checksum(payload)));
}

function base58CheckDecode(value) {
  const decoded = base58Decode(value);
  if (decoded.length < 5) throw new Error('invalid base58check payload');
  const payload = decoded.subarray(0, -4);
  const expectedChecksum = checksum(payload);
  const actualChecksum = decoded.subarray(-4);
  if (!actualChecksum.equals(expectedChecksum)) throw new Error('invalid base58check checksum');
  return payload;
}

class HexString {
  constructor(value, littleEndian = false) {
    const normalized = normalizeHex(value);
    this.value = littleEndian ? reverseHex(normalized) : normalized;
  }

  toString() {
    return this.value;
  }

  toHex() {
    return this.value;
  }

  toBigEndian() {
    return this.value;
  }

  toLittleEndian() {
    return reverseHex(this.value);
  }

  toArrayBuffer(asLittleEndian = false) {
    return hexToBuffer(asLittleEndian ? this.toLittleEndian() : this.toBigEndian());
  }

  toBase64(asLittleEndian = false) {
    return this.toArrayBuffer(asLittleEndian).toString('base64');
  }

  static fromHex(value, littleEndian = false) {
    if (value instanceof HexString) return new HexString(value.toBigEndian(), littleEndian);
    return new HexString(value, littleEndian);
  }
}

const ContractParamType = {
  Any: 0,
  Boolean: 16,
  Integer: 17,
  ByteArray: 18,
  String: 19,
  Hash160: 20,
  Array: 32,
  Map: 34,
  Void: 255,
};

class ContractParam {
  constructor(type, value) {
    this.type = type;
    this.value = value;
  }

  toJSON() {
    if (this.type === ContractParamType.Array) {
      return {
        type: 'Array',
        value: this.value.map((item) =>
          item instanceof ContractParam ? item.toJSON() : ContractParam.any(item).toJSON()
        ),
      };
    }

    if (this.type === ContractParamType.ByteArray) {
      return { type: 'ByteArray', value: this.value.toBase64(true) };
    }

    if (this.type === ContractParamType.Hash160) {
      return { type: 'Hash160', value: this.value.toBigEndian() };
    }

    if (this.type === ContractParamType.Boolean) {
      return { type: 'Boolean', value: this.value };
    }

    if (this.type === ContractParamType.Integer) {
      return { type: 'Integer', value: String(this.value) };
    }

    if (this.type === ContractParamType.String) {
      return { type: 'String', value: this.value };
    }

    if (this.type === ContractParamType.Any) {
      return { type: 'Any', value: this.value };
    }

    return { type: 'Any', value: this.value };
  }

  static any(value = null) {
    return new ContractParam(ContractParamType.Any, value);
  }

  static boolean(value) {
    return new ContractParam(ContractParamType.Boolean, Boolean(value));
  }

  static integer(value) {
    return new ContractParam(ContractParamType.Integer, String(typeof value === 'bigint' ? value : BigInt(value)));
  }

  static string(value) {
    return new ContractParam(ContractParamType.String, String(value));
  }

  static byteArray(value) {
    // Plain strings are interpreted as hex, matching @cityofzion/neon-js
    // semantics. Use HexString.fromBase64 explicitly for base64 inputs.
    const hex = value instanceof HexString ? value : HexString.fromHex(String(value || ''), true);
    return new ContractParam(ContractParamType.ByteArray, hex);
  }

  static hash160(value) {
    const normalized = value && /^N/.test(String(value))
      ? getScriptHashFromAddress(String(value))
      : normalizeHex(value);
    if (normalized.length !== 40) throw new Error('hash160 expected 20 bytes');
    return new ContractParam(ContractParamType.Hash160, HexString.fromHex(normalized));
  }

  static array(...params) {
    return new ContractParam(
      ContractParamType.Array,
      params.map((param) => (param instanceof ContractParam ? param : ContractParam.any(param)))
    );
  }

  static fromJson(input) {
    if (input instanceof ContractParam) return input;
    const type = typeof input?.type === 'string' ? ContractParamType[input.type] : input?.type;
    switch (type) {
      case ContractParamType.Any:
        return ContractParam.any(input.value);
      case ContractParamType.Boolean:
        return ContractParam.boolean(input.value);
      case ContractParamType.Integer:
        return ContractParam.integer(input.value);
      case ContractParamType.String:
        return ContractParam.string(input.value ?? '');
      case ContractParamType.ByteArray:
        return ContractParam.byteArray(input.value);
      case ContractParamType.Hash160:
        return ContractParam.hash160(input.value);
      case ContractParamType.Array:
        return ContractParam.array(...(input.value || []).map((item) => ContractParam.fromJson(item)));
      default:
        return ContractParam.any(input?.value ?? input);
    }
  }
}

HexString.fromBase64 = function fromBase64(value, littleEndian = false) {
  return new HexString(Buffer.from(String(value || ''), 'base64').toString('hex'), littleEndian);
};

function emit(opcode, operand = Buffer.alloc(0)) {
  return concatBuffers(Buffer.from([opcode]), operand);
}

function bigintToFixedLE(value) {
  const bigintValue = BigInt(value);
  if (bigintValue >= -1n && bigintValue <= 16n) return Buffer.alloc(0);
  const widths = [8, 16, 32, 64, 128, 256];
  for (const bits of widths) {
    const min = -(1n << BigInt(bits - 1));
    const max = (1n << BigInt(bits - 1)) - 1n;
    if (bigintValue < min || bigintValue > max) continue;
    const mod = 1n << BigInt(bits);
    let unsigned = bigintValue < 0n ? mod + bigintValue : bigintValue;
    const bytes = Buffer.alloc(bits / 8);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number(unsigned & 0xffn);
      unsigned >>= 8n;
    }
    return bytes;
  }
  throw new Error(`unsupported integer width: ${bigintValue.toString()}`);
}

function emitPushInt(value) {
  const bigintValue = BigInt(value);
  if (bigintValue >= -1n && bigintValue <= 16n) {
    return emit(OPCODE.PUSHM1 + Number(bigintValue) + 1);
  }
  const payload = bigintToFixedLE(bigintValue);
  switch (payload.length) {
    case 1:
      return emit(OPCODE.PUSHINT8, payload);
    case 2:
      return emit(OPCODE.PUSHINT16, payload);
    case 4:
      return emit(OPCODE.PUSHINT32, payload);
    case 8:
      return emit(OPCODE.PUSHINT64, payload);
    case 16:
      return emit(OPCODE.PUSHINT128, payload);
    case 32:
      return emit(OPCODE.PUSHINT256, payload);
    default:
      throw new Error(`unsupported integer width: ${payload.length}`);
  }
}

function emitPushBytes(value) {
  const bytes = Buffer.from(value);
  if (bytes.length < 0x100) {
    return emit(OPCODE.PUSHDATA1, concatBuffers(Buffer.from([bytes.length]), bytes));
  }
  if (bytes.length < 0x10000) {
    return emit(OPCODE.PUSHDATA2, concatBuffers(Buffer.from([bytes.length & 0xff, (bytes.length >> 8) & 0xff]), bytes));
  }
  return emit(
    OPCODE.PUSHDATA4,
    concatBuffers(
      Buffer.from([
        bytes.length & 0xff,
        (bytes.length >> 8) & 0xff,
        (bytes.length >> 16) & 0xff,
        (bytes.length >> 24) & 0xff,
      ]),
      bytes
    )
  );
}

function syscallCode(name) {
  const hash = sha256Bytes(Buffer.from(name, 'utf8'));
  return hash[0] | (hash[1] << 8) | (hash[2] << 16) | (hash[3] << 24);
}

class ScriptBuilder {
  constructor() {
    this.script = [];
  }

  emit(opcode, operand = Buffer.alloc(0)) {
    this.script.push(...emit(opcode, operand));
    return this;
  }

  emitPush(value) {
    if (value === null || value === undefined) return this.emitPush(false);
    if (typeof value === 'boolean') return this.emit(value ? 8 : 9);
    if (typeof value === 'number' || typeof value === 'bigint') {
      this.script.push(...emitPushInt(value));
      return this;
    }
    if (typeof value === 'string') {
      this.script.push(...emitPushBytes(Buffer.from(value, 'utf8')));
      return this;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        this.script.push(...emit(OPCODE.NEWARRAY0));
        return this;
      }
      for (const item of [...value].reverse()) this.emitPush(item);
      this.script.push(...emitPushInt(value.length));
      this.script.push(...emit(OPCODE.PACK));
      return this;
    }
    if (value instanceof HexString) {
      this.script.push(...emitPushBytes(value.toArrayBuffer(true)));
      return this;
    }
    if (value instanceof ContractParam) {
      switch (value.type) {
        case ContractParamType.Boolean:
          return this.emitPush(value.value);
        case ContractParamType.Integer:
          this.script.push(...emitPushInt(value.value));
          return this;
        case ContractParamType.String:
          this.script.push(...emitPushBytes(Buffer.from(String(value.value), 'utf8')));
          return this;
        case ContractParamType.ByteArray:
        case ContractParamType.Hash160:
          this.script.push(...emitPushBytes(value.value.toArrayBuffer(true)));
          return this;
        case ContractParamType.Array:
          return this.emitPush(value.value);
        case ContractParamType.Any:
          return this.emitPush(value.value ?? false);
        default:
          return this.emitPush(value.value ?? false);
      }
    }
    if (value && typeof value === 'object' && 'type' in value) {
      return this.emitPush(ContractParam.fromJson(value));
    }
    throw new Error(`Unsupported push value: ${String(value)}`);
  }

  emitContractCall(scriptHash, operation, callFlags = CALL_FLAGS_ALL, args = []) {
    if (typeof scriptHash === 'object' && scriptHash !== null) {
      return this.emitContractCall(
        scriptHash.scriptHash,
        scriptHash.operation,
        scriptHash.callFlags ?? CALL_FLAGS_ALL,
        scriptHash.args ?? []
      );
    }
    if (args.length === 0) {
      this.script.push(...emit(OPCODE.NEWARRAY0));
    } else {
      for (const arg of [...args].reverse()) this.emitPush(arg);
      this.script.push(...emitPushInt(args.length));
      this.script.push(...emit(OPCODE.PACK));
    }
    this.emitPush(callFlags);
    this.emitPush(operation);
    this.emitPush(HexString.fromHex(scriptHash));
    const code = syscallCode('System.Contract.Call');
    this.script.push(...emit(OPCODE.SYSCALL, Buffer.from([code & 0xff, (code >> 8) & 0xff, (code >> 16) & 0xff, (code >> 24) & 0xff])));
    return this;
  }

  toHex() {
    return bufferToHex(Buffer.from(this.script));
  }
}

function createScript(input) {
  const builder = new ScriptBuilder();
  const scripts = Array.isArray(input) ? input : [input];
  for (const script of scripts) builder.emitContractCall(script);
  return builder.toHex();
}

function serializeSigner(signer) {
  if (!signer || typeof signer !== 'object') return signer;
  const out = { ...signer };
  if (out.account) out.account = `0x${normalizeHex(out.account)}`;
  if (Array.isArray(out.allowedContracts)) {
    out.allowedContracts = out.allowedContracts.map((value) => `0x${normalizeHex(value)}`);
  }
  return out;
}

class RPCClient {
  constructor(rpcUrl, options = {}) {
    this.rpcUrl = rpcUrl;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_RPC_TIMEOUT_MS;
  }

  async send(method, params = []) {
    let response;
    try {
      response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw createError(EC.NETWORK_TIMEOUT, { method, timeoutMs: this.timeoutMs });
      }
      throw error;
    }
    if (!response.ok) {
      // Embed the HTTP status in the message so retry layers matching
      // '502'/'503'/'504' patterns classify gateway errors as retryable.
      const error = new Error(`RPC endpoint returned HTTP ${response.status} for ${method}`);
      error.code = EC.NETWORK_RPC_CONNECTION_FAILED.code;
      error.details = { method, status: response.status };
      throw error;
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      const wrapped = new Error(`RPC endpoint returned non-JSON response for ${method}: ${error.message}`);
      wrapped.code = EC.NETWORK_RPC_CONNECTION_FAILED.code;
      wrapped.details = { method };
      throw wrapped;
    }
    if (payload.error) {
      const error = new Error(payload.error.message || `RPC error ${payload.error.code ?? ''}`.trim());
      // Preserve the node's error identity and diagnostic payload. Submission
      // callers must distinguish rejection from an uncertain transport failure.
      error.code = payload.error.code;
      if (Object.hasOwn(payload.error, 'data')) error.data = payload.error.data;
      throw error;
    }
    return payload.result;
  }

  getVersion() {
    return this.send('getversion');
  }

  getBlockCount() {
    return this.send('getblockcount');
  }

  getApplicationLog(...params) {
    return this.send('getapplicationlog', params);
  }

  invokeScript(script, signers = []) {
    const value =
      script instanceof HexString
        ? script.toBigEndian()
        : script && typeof script.toString === 'function'
          ? normalizeHex(script.toString())
          : normalizeHex(script);
    return this.send('invokescript', [`0x${value}`, signers.map(serializeSigner)]);
  }

  invokeFunction(scriptHash, operation, params = [], signers = undefined) {
    const serializedParams = params.map((param) => {
      if (param instanceof ContractParam) return param.toJSON();
      if (param && typeof param === 'object' && 'type' in param) return ContractParam.fromJson(param).toJSON();
      return ContractParam.any(param).toJSON();
    });
    const rpcParams = [`0x${normalizeHex(scriptHash)}`, operation, serializedParams];
    if (signers !== undefined) rpcParams.push(signers.map(serializeSigner));
    return this.send('invokefunction', rpcParams);
  }
}

function getAddressFromScriptHash(scriptHash) {
  const normalized = normalizeHex(scriptHash);
  if (normalized.length !== 40) throw new Error('invalid script hash');
  const payload = concatBuffers(Buffer.from([DEFAULT_ADDRESS_VERSION]), reverseBuffer(hexToBuffer(normalized)));
  return base58CheckEncode(payload);
}

function getScriptHashFromAddress(address) {
  const payload = base58CheckDecode(address);
  if (payload.length !== 21) throw new Error('invalid address payload');
  return bufferToHex(reverseBuffer(payload.subarray(1)));
}

module.exports = {
  rpc: { RPCClient },
  sc: { ContractParam, createScript, ScriptBuilder },
  u: {
    reverseHex,
    hash160: hash160Hex,
    HexString,
  },
  wallet: {
    getAddressFromScriptHash,
    getScriptHashFromAddress,
  },
};
