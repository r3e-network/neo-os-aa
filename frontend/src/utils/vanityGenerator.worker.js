import { ripemd160, sha256 } from 'ethers';
import { EC } from '../config/errorCodes.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function sanitizeHex(value) {
  return String(value || '').replace(/^0x/i, '').toLowerCase();
}

function hexToBytes(hexValue) {
  const hex = sanitizeHex(hexValue);
  if (hex.length % 2 !== 0) throw new Error(EC.invalidHexLength);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function doubleSha256Bytes(bytes) {
  const h1 = hexToBytes(sha256(bytes));
  return hexToBytes(sha256(h1));
}

function hash160Hex(hexValue) {
  const bytes = hexToBytes(hexValue);
  const sha = hexToBytes(sha256(bytes));
  return sanitizeHex(ripemd160(sha));
}

function reverseHex(hexValue) {
  const hex = sanitizeHex(hexValue);
  let output = '';
  for (let i = hex.length; i > 0; i -= 2) {
    output += hex.slice(i - 2, i);
  }
  return output;
}

function encodeBase58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let output = '';
  while (value > 0n) {
    output = BASE58_ALPHABET[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) output = '1' + output;
  return output || '1';
}

function getAddressFromScriptHash(scriptHash, addressVersion = 53) {
  const payload = concatBytes(
    new Uint8Array([addressVersion]),
    hexToBytes(reverseHex(scriptHash))
  );
  const checksum = doubleSha256Bytes(payload).slice(0, 4);
  return encodeBase58(concatBytes(payload, checksum));
}

function deriveAccountIdHash(accountIdHexOrSeed) {
  const normalized = sanitizeHex(accountIdHexOrSeed || '');
  if (!normalized) throw new Error(EC.accountSeedRequired);
  if (/^[0-9a-f]{40}$/i.test(normalized)) return normalized;
  return hash160Hex(normalized);
}

function emitPushData(hexValue) {
  const hex = sanitizeHex(hexValue);
  const length = hex.length / 2;
  if (length < 0x100) {
    return `0c${length.toString(16).padStart(2, '0')}${hex}`;
  }
  if (length < 0x10000) {
    const sizeHex = `${(length & 0xff).toString(16).padStart(2, '0')}${((length >> 8) & 0xff).toString(16).padStart(2, '0')}`;
    return `0d${sizeHex}${hex}`;
  }
  throw new Error(EC.dataTooLargeToPush);
}

function emitSmallInteger(value) {
  if (value < 0 || value > 16) throw new Error(EC.unsupportedSmallInteger);
  return (0x10 + value).toString(16).padStart(2, '0');
}

function createProxyScript(contractHash, accountIdHex) {
  const accountId = deriveAccountIdHash(accountIdHex);
  const contract = sanitizeHex(contractHash);
  const operationHex = bytesToHex(new TextEncoder().encode('verify'));
  return [
    emitPushData(accountId),
    emitSmallInteger(1),
    'c0',
    emitSmallInteger(15),
    emitPushData(operationHex),
    emitPushData(reverseHex(contract)),
    '41627d5b52',
  ].join('');
}

function deriveAddress(contractHash, seedHex) {
  const accountIdHash = deriveAccountIdHash(seedHex);
  const script = createProxyScript(contractHash, accountIdHash);
  const scriptHash = reverseHex(hash160Hex(script));
  return getAddressFromScriptHash(scriptHash);
}

function generateRandomHex(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return bytesToHex(bytes);
}

function checkPattern(address, pattern, patternType) {
  // All Neo addresses start with 'N'. For prefix, match N + user pattern.
  if (patternType === 'prefix') return address.startsWith('N' + pattern);
  if (patternType === 'suffix') return address.endsWith(pattern);
  if (patternType === 'contains') return address.includes(pattern);
  return false;
}

let running = false;

self.onmessage = function (event) {
  const msg = event.data;

  if (msg.type === 'stop') {
    running = false;
    return;
  }

  if (msg.type === 'start') {
    const { contractHash, pattern, patternType, batchSize = 500 } = msg;
    running = true;
    const startTime = performance.now();
    let attempts = 0;

    function runBatch() {
      if (!running) return;

      try {
        const batchStart = performance.now();
        for (let i = 0; i < batchSize && running; i++) {
          const seed = generateRandomHex(32);
          const address = deriveAddress(contractHash, seed);
          attempts++;

          if (checkPattern(address, pattern, patternType)) {
            const elapsed = performance.now() - startTime;
            const accountIdHash = deriveAccountIdHash(seed);
            self.postMessage({
              type: 'result',
              found: true,
              seed,
              address,
              accountIdHash,
              attempts,
              elapsed,
            });
            running = false;
            return;
          }
        }

        const elapsed = performance.now() - startTime;
        self.postMessage({ type: 'progress', found: false, attempts, elapsed });

        if (running) {
          setTimeout(runBatch, 0);
        }
      } catch (err) {
        running = false;
        self.postMessage({
          type: 'result',
          found: false,
          error: err?.message || EC.vanityWorkerCrashed,
          attempts,
          elapsed: performance.now() - startTime,
        });
      }
    }

    runBatch();
  }
};
