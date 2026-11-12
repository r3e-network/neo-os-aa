// Drives the frontend's own wallet signing path against a local chain, with a NEP-21 wallet shim
// standing in for the browser extension.
//
// usage: node wallet_shim_sign_proxy_transfer.mjs <request.json>
//   result: one JSON object on stdout, exit 0 when the drive completed (including a completed
//   refusal leg), 1 when the drive itself could not run.
//
// The shim is a wallet, not a test double for the frontend: it holds a throwaway fee-payer key,
// answers getAccounts, and when the frontend hands it a built proxy-witness transaction it signs
// that transaction as the fee payer, attaches the proxy verification witness the dApp supplied,
// and submits the packet. Everything it is asked to sign is produced by
// frontend/src/features/operations/execution.js and sent by frontend/src/services/walletService.js.
import { createHash, createPrivateKey, createPublicKey, sign as ecdsaSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { toMultiSigRpcParameter } from '../../shared/multiSigCore.mjs';
import { assertLocalchainProbe } from './probe_isolation.mjs';

const AA = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function emit(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(body.ok === false ? 1 : 0);
}

process.on('uncaughtException', (error) => {
  emit({ ok: false, error: String(error?.message || error), code: error?.code || '' });
});

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assertLocalchainProbe(request.rpcUrl);

// ---------------------------------------------------------------- Neo wire encoding
// N3 serialization is not expressed by any dependency on this path, and a byte that is one off is
// refused by the node with no diagnosis, so the framing lives here beside the assertions that pin it.
const GAS = 100000000;

function stripHex(value) {
  return String(value ?? '').replace(/^0x/i, '').toLowerCase();
}

function hashLe(displayHash) {
  return Buffer.from(stripHex(displayHash), 'hex').reverse();
}

function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.concat([Buffer.from([0xfd]), Buffer.from([n & 0xff, (n >> 8) & 0xff])]);
  const out = Buffer.alloc(4);
  out.writeUInt32LE(n);
  return Buffer.concat([Buffer.from([0xfe]), out]);
}

function u32(n) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(n >>> 0);
  return out;
}

function i64(n) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(n));
  return out;
}

// Neo WitnessScope is a bit mask: 1 CalledByEntry, 16 CustomContracts, 64 WitnessRules, 128 Global.
const SCOPE_BITS = { None: 0, CalledByEntry: 1, CustomContracts: 16, CustomGroups: 32, WitnessRules: 64, Global: 128 };

function scopeBits(scope) {
  if (typeof scope === 'number' && Number.isFinite(scope)) return scope;
  const raw = String(scope ?? '').trim();
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const bits = SCOPE_BITS[raw];
  if (bits === undefined) throw new Error(`wallet shim cannot express the signer scope ${raw}`);
  return bits;
}

function serializeSigner(signer) {
  const bits = scopeBits(signer.scopes);
  let out = Buffer.concat([hashLe(signer.account), Buffer.from([bits])]);
  if (bits & SCOPE_BITS.CustomContracts) {
    const allowed = (signer.allowedContracts || []).map((hash) => hashLe(hash));
    if (!allowed.length) throw new Error('a CustomContracts signer needs a nonempty allowlist');
    out = Buffer.concat([out, varint(allowed.length), ...allowed]);
  }
  if (bits & SCOPE_BITS.WitnessRules) {
    const rules = signer.rules || [];
    out = Buffer.concat([out, varint(rules.length)]);
    for (const rule of rules) {
      out = Buffer.concat([out, Buffer.from([rule.action === 'Allow' ? 1 : 0])]);
      const condition = rule.condition;
      if (condition.type !== 'Or') throw new Error('the wallet shim only expresses Or witness rules');
      out = Buffer.concat([out, Buffer.from([0x03]), varint(condition.expressions.length)]);
      for (const expression of condition.expressions) {
        if (expression.type !== 'CalledByContract') throw new Error('the wallet shim only expresses CalledByContract');
        out = Buffer.concat([out, Buffer.from([0x28]), hashLe(expression.hash)]);
      }
    }
  }
  return out;
}

function serializeUnsigned({ nonce, sysfee, netfee, validUntil, signers, script }) {
  return Buffer.concat([
    Buffer.from([0]),
    u32(nonce),
    i64(sysfee),
    i64(netfee),
    u32(validUntil),
    varint(signers.length),
    ...signers.map(serializeSigner),
    varint(0),
    varint(script.length),
    script,
  ]);
}

function serializeWitnesses(witnesses) {
  const parts = [varint(witnesses.length)];
  for (const { invocationScript, verificationScript } of witnesses) {
    const invocation = Buffer.from(invocationScript || '', 'hex');
    const verification = Buffer.from(verificationScript || '', 'hex');
    parts.push(varint(invocation.length), invocation, varint(verification.length), verification);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- the fee-payer key
function loadKey(derPath) {
  const der = readFileSync(derPath);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'sec1' });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const point = spki.subarray(spki.length - 65);
  if (point[0] !== 0x04) throw new Error('the fee-payer key did not export an uncompressed P-256 point');
  const x = point.subarray(1, 33);
  const y = point.subarray(33, 65);
  const compressed = Buffer.concat([Buffer.from([(y[31] & 1) ? 0x03 : 0x02]), x]);
  // Standard single-signature verification script: PUSHDATA1 33 <key> SYSCALL CheckSig.
  const verificationScript = Buffer.concat([Buffer.from([0x0c, 0x21]), compressed, Buffer.from([0x41, 0x56, 0xe7, 0xb3, 0x27])]);
  const scriptHash = createHash('ripemd160').update(createHash('sha256').update(verificationScript).digest()).digest();
  return {
    privateKey,
    verificationScript: verificationScript.toString('hex'),
    scriptHash: Buffer.from(scriptHash).reverse().toString('hex'),
  };
}

// DER -> r||s, 64 bytes, each integer trimmed of its sign padding and left-padded to 32.
function derToRs(der) {
  const buffer = Buffer.from(der);
  let offset = 2;
  const readInt = () => {
    if (buffer[offset] !== 0x02) throw new Error('malformed DER signature');
    const length = buffer[offset + 1];
    const raw = buffer.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    let start = 0;
    while (start < raw.length - 1 && raw[start] === 0x00) start += 1;
    const body = raw.subarray(start);
    if (body.length > 32) throw new Error('DER integer wider than 32 bytes');
    return Buffer.concat([Buffer.alloc(32 - body.length, 0), body]);
  };
  if (buffer[0] !== 0x30) throw new Error('malformed DER signature');
  return Buffer.concat([readInt(), readInt()]);
}

function signDigest(key, magic, unsigned) {
  const txHash = createHash('sha256').update(unsigned).digest();
  const payload = Buffer.concat([u32(magic), txHash]);
  const der = ecdsaSign('sha256', payload, key.privateKey);
  // PUSHDATA1 64 <r||s>
  return Buffer.concat([Buffer.from([0x0c, 0x40]), derToRs(der)]).toString('hex');
}

// ---------------------------------------------------------------- chain access
async function rpc(method, params) {
  const response = await fetch(request.rpcUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload?.error) {
    const error = new Error(`rpc ${method}: ${payload.error.message || 'failed'}`);
    error.rpcDetail = payload.error.data || '';
    throw error;
  }
  return payload.result;
}

// ---------------------------------------------------------------- the wallet shim
// A NEP-21 provider that can carry a verification script it did not create. An ordinary invoke-only
// wallet cannot: it broadcasts its own transaction and would drop the proxy witness, which is why
// the client path refuses those wallets rather than send a transfer that returns false and still
// burns the fee. `carriesProxyWitness` is the capability opt-in.
function installWalletShim({ key, address, refuse }) {
  const seen = { connects: 0, invokes: 0, signers: [], invokeArgs: [] };
  const provider = {
    dapiVersion: '1.0',
    name: 'WalletShim',
    carriesProxyWitness: true,
    async getAccounts() {
      seen.connects += 1;
      if (refuse) {
        throw new Error(refuse.words);
      }
      return [{ address, hash: `0x${key.scriptHash}` }];
    },
    async invoke(invokeArgs, signers) {
      seen.invokes += 1;
      seen.invokeArgs = invokeArgs;
      seen.signers = signers;
      return submitFromShim({ key, invokeArgs, signers });
    },
  };
  return { provider, seen };
}

async function submitFromShim({ key, invokeArgs, signers }) {
  const [entry] = invokeArgs;
  if (!entry?.script) {
    throw new Error('the wallet shim only signs a transaction the SDK builder assembled');
  }
  const script = Buffer.from(stripHex(entry.script), 'hex');
  const proxyWitness = entry.proxyWitness;
  if (!proxyWitness?.verificationScript) {
    throw new Error('the wallet shim needs the proxy verification witness the dApp attaches');
  }
  const feePayerAccount = key.scriptHash;
  const signerAccounts = signers.map((signer) => stripHex(signer.account));
  if (signerAccounts[0] !== feePayerAccount) {
    throw new Error('the wallet must be the first signer: it pays the fee');
  }

  const height = await rpc('getblockcount', []);
  const probe = await rpc('invokefunction', [
    `0x${stripHex(entry.hash)}`,
    entry.operation,
    // The repository's own internal->wire converter: a struct travels as an Array and a ByteArray
    // travels base64. A second spelling of that mapping is exactly how a packet ends up unreadable.
    (entry.args || []).map(toMultiSigRpcParameter),
    // Signer JSON uses Neo's own lowercase member names: `allowedcontracts`, `allowedgroups`,
    // `rules`. A camelCase member is ignored by the node, which would price the transaction as if
    // the allowlist were empty.
    signers.map((signer) => ({
      account: `0x${stripHex(signer.account)}`,
      scopes: signer.scopes,
      ...(signer.allowedContracts?.length
        ? { allowedcontracts: signer.allowedContracts.map((hash) => `0x${stripHex(hash)}`) }
        : {}),
      ...(signer.rules?.length ? { rules: signer.rules } : {}),
    })),
  ]);
  if (probe.state !== 'HALT') {
    throw new Error(`the wallet's own simulation faulted: ${probe.exception || probe.state}`);
  }

  const nonce = Math.floor(Math.random() * 0xffffffff);
  const sysfee = Math.ceil(Number(probe.gasconsumed || 0)) + 3 * GAS;
  const netfee = GAS;
  const unsigned = serializeUnsigned({
    nonce,
    sysfee,
    netfee,
    validUntil: height + 100,
    signers,
    script,
  });
  const invocationScript = signDigest(key, request.magic, unsigned);
  const packet = Buffer.concat([
    unsigned,
    serializeWitnesses([
      { invocationScript, verificationScript: key.verificationScript },
      { invocationScript: proxyWitness.invocationScript || '', verificationScript: stripHex(proxyWitness.verificationScript) },
    ]),
  ]);

  let sent = null;
  const attempts = [];
  for (let tryIndex = 0; tryIndex < 3; tryIndex += 1) {
    try {
      sent = await rpc('sendrawtransaction', [packet.toString('base64')]);
      attempts.push('accepted');
      break;
    } catch (error) {
      attempts.push(String(error.message || error).slice(0, 160));
    }
  }
  if (!sent) {
    const error = new Error(`node rejected the transaction: ${attempts[attempts.length - 1]}`);
    error.attempts = attempts;
    error.packetBytes = packet.length;
    error.scriptBytes = script.length;
    throw error;
  }

  let execution = null;
  for (let poll = 0; poll < 90; poll += 1) {
    try {
      execution = (await rpc('getapplicationlog', [sent.hash])).executions[0];
      break;
    } catch (_error) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!execution) throw new Error(`the transaction ${sent.hash} was not executed`);
  return {
    txid: sent.hash,
    outcome: execution.vmstate,
    gas: Number(execution.gasconsumed || 0),
    exception: execution.exception || '',
    sysfee,
    netfee,
    packetBytes: packet.length,
    scriptBytes: script.length,
    scriptHex: script.toString('hex'),
    invocationScript,
    signers,
    attempts,
  };
}

// ---------------------------------------------------------------- the drive
async function main() {
  const key = loadKey(request.feePayerKeyDer);
  if (stripHex(request.feePayer) !== key.scriptHash) {
    emit({ ok: false, error: 'the fee-payer key does not hash to the fee payer the request names', code: 'fee_payer_mismatch' });
    return;
  }

  const refuse = request.refuseConnect ? { words: request.refuseWords || 'User rejected the request.' } : null;
  const { provider, seen } = installWalletShim({ key, address: request.feePayerAddress || `N${key.scriptHash.slice(0, 30)}`, refuse });

  const listeners = new Map();
  const memory = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (memory.has(k) ? memory.get(k) : null),
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
      has: (k) => memory.has(k),
    },
    location: { host: 'localhost', hostname: 'localhost', origin: 'http://localhost' },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) {
      listeners.get(name)?.delete(handler);
    },
    dispatchEvent() {
      return true;
    },
    NEP21Provider: provider,
  };

  const walletModule = await import(pathToFileURL(path.join(AA, 'frontend/src/services/walletService.js')).href);
  const execution = await import(pathToFileURL(path.join(AA, 'frontend/src/features/operations/execution.js')).href);
  const errorCodes = await import(pathToFileURL(path.join(AA, 'frontend/src/config/errorCodes.js')).href);
  const { walletService } = walletModule;
  walletService.rpcUrl = request.rpcUrl;

  if (refuse) {
    let thrown = null;
    try {
      await walletService.connect();
    } catch (error) {
      thrown = error;
    }
    emit({
      ok: true,
      leg: 'refuse-connect',
      refused: Boolean(thrown),
      errorCode: thrown?.message || '',
      classifiedCode: thrown?.code || '',
      providerMessage: thrown?.providerMessage || String(thrown?.message || ''),
      renderedEn: errorCodes.connectErrorMessage(thrown, (key2, fallback = '') => fallback || key2),
      connects: seen.connects,
    });
    return;
  }

  const connected = await walletService.connect();

  // The user operation is signed by a session key that is not in this process: the harness hands us
  // the signature the session key produced. The frontend assembles the rest.
  const metaTx = await import(pathToFileURL(path.join(AA, 'frontend/src/features/operations/metaTx.js')).href);
  const invocation = metaTx.buildExecuteUserOpInvocation({
    aaContractHash: request.core,
    accountIdHash: request.accountId,
    targetContract: request.target,
    method: request.method,
    methodArgs: request.args,
    nonce: request.nonce,
    deadline: request.deadline,
    signatureHex: request.signatureHex,
  });
  if (!invocation) {
    emit({ ok: false, error: 'the frontend refused to stage the invocation', code: 'invocation_missing' });
    return;
  }

  let refusal = null;
  let request0 = null;
  try {
    request0 = await execution.buildClientProxyWitnessTransaction({
      invocation,
      feePayer: `0x${key.scriptHash}`,
      rpcUrl: request.rpcUrl,
      ...(request.scope ? { feePayerScope: request.scope } : {}),
      ...(request.allowedContracts ? { feePayerAllowedContracts: request.allowedContracts } : {}),
    });
  } catch (error) {
    refusal = { message: error.message || '', code: error.code || '', missing: error.missingContracts || null };
  }

  if (refusal) {
    emit({
      ok: true,
      leg: 'refused-build',
      refusal,
      connects: seen.connects,
      invokes: seen.invokes,
    });
    return;
  }

  const broadcast = execution.buildClientBroadcastRequest({
    signerAddress: `0x${key.scriptHash}`,
    transactionBody: {
      requiresProxyWitness: true,
      accountAddressScriptHash: `0x${request0.proxyHash}`,
      clientInvocation: invocation,
    },
    proxyWitnessTransaction: request0,
  });

  let submission = null;
  let submitError = null;
  try {
    submission = await walletService.invoke(broadcast);
  } catch (error) {
    submitError = String(error?.message || error);
  }

  emit({
    ok: true,
    leg: 'transfer',
    connect: {
      provider: connected.provider,
      address: connected.address,
      shimName: provider.name,
      connects: seen.connects,
      kept: connected.address === (request.feePayerAddress || request.feePayer),
    },
    walletSignRequest: {
      scope: request0.feePayerSigner.scopes,
      allowedContracts: request0.feePayerSigner.allowedContracts || null,
      signers: request0.signers.map((signer) => ({
        account: signer.account,
        scopes: signer.scopes,
        ...(signer.allowedContracts ? { allowedContracts: signer.allowedContracts } : {}),
        ...(signer.rules ? { rules: signer.rules } : {}),
      })),
    },
    proxyHash: request0.proxyHash,
    proxyWitness: request0.proxyWitness,
    scriptHex: request0.script,
    signersSeen: seen.signers,
    invokeArgsSeen: seen.invokeArgs.map((entry) => ({
      hash: entry.hash,
      operation: entry.operation,
      scriptLength: entry.script ? stripHex(entry.script).length / 2 : 0,
      carriesProxyWitness: Boolean(entry.proxyWitness?.verificationScript),
    })),
    invocationCount: seen.invokes,
    submission,
    submitError,
  });
}

await main();
