#!/usr/bin/env node

/**
 * Testnet verification for Neo Abstract Account.
 * Deploys existing pre-compiled NEFs and exercises core flows.
 *
 * Usage: TEST_WIF=Kzja... node v3_testnet_verify_refactor.js
 */

const fs = require('fs');
const path = require('path');
const { rpc, sc, wallet, experimental, tx, u, CONST } = require('@cityofzion/neon-js');
const { ethers } = require('ethers');

const { AbstractAccountClient, buildWeb3AuthSigningPayload } = require('../src/index');
const { sanitizeHex, computeArgsHash: sdkComputeArgsHash } = require('../src/metaTx');
const { extractDeployedContractHash } = require('../src/deployLog');

const RPC_URL = process.env.TESTNET_RPC_URL || 'https://testnet1.neo.coz.io:443';
const TEST_WIF = process.env.TEST_WIF || '';
if (!TEST_WIF) { console.error('TEST_WIF required'); process.exit(1); }

const GAS = CONST.NATIVE_CONTRACT_HASH.GasToken;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = v => `0x${sanitizeHex(v)}`;
let PASS = 0, FAIL = 0;

function assert(cond, label) {
  if (cond) { PASS++; console.log(`  PASS: ${label}`); }
  else { FAIL++; console.log(`  FAIL: ${label}`); }
}

async function retry(label, fn, n = 5) {
  for (let i = 1; i <= n; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= n) throw e;
      if (/socket hang up|ECONNRESET|ETIMEDOUT|fetch failed/i.test(e.message || '')) {
        console.warn(`  retry ${label} ${i}/${n}`);
        await sleep(1500 * i);
      } else throw e;
    }
  }
}

function load(name, suffix) {
  const root = path.resolve(__dirname, '..', '..', '..');
  const nef = sc.NEF.fromBuffer(fs.readFileSync(path.join(root, 'contracts', 'bin', 'v3', `${name}.nef`)));
  const mj = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'bin', 'v3', `${name}.manifest.json`), 'utf8'));
  mj.name = `${mj.name}-${suffix}`;
  return { nef, manifest: sc.ContractManifest.fromJson(mj) };
}

const h160 = v => sc.ContractParam.hash160(sanitizeHex(v));
const bytes = v => sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(v), true));
const int = v => sc.ContractParam.integer(typeof v === 'bigint' ? v.toString() : String(v));
const str = v => sc.ContractParam.string(String(v));
const bool = v => sc.ContractParam.boolean(Boolean(v));
const arr = (...vs) => sc.ContractParam.array(...vs);
const empty = () => sc.ContractParam.byteArray(u.HexString.fromHex('', true));

function cfg(acct, magic) {
  return { account: acct, networkMagic: magic, rpcAddress: RPC_URL, blocksTillExpiry: 200 };
}

async function waitLog(client, txid, label, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const log = await client.getApplicationLog(txid);
      if (log?.executions?.length) {
        const vm = String(log.executions[0].vmstate || log.executions[0].state || '');
        if (!vm.includes('HALT')) throw new Error(`${label}: VM fault - ${log.executions[0].exception || ''}`);
        return log;
      }
    } catch (e) { if (e.message?.includes('VM fault')) throw e; }
    await sleep(3000);
  }
  throw new Error(`${label}: timeout ${txid}`);
}

async function invoke(client, hash, account, magic, method, params) {
  const c = new experimental.SmartContract(sanitizeHex(hash), cfg(account, magic));
  console.log(`  invoking ${method}...`);
  const txid = await retry(method, () => c.invoke(method, params));
  console.log(`  txid=${txid}`);
  return waitLog(client, txid, method);
}

async function read(client, hash, method, params = []) {
  const r = await retry(method, () => client.invokeFunction(sanitizeHex(hash), method, params));
  if (String(r?.state || '').includes('FAULT')) throw new Error(`${method}: ${r.exception || 'fault'}`);
  return r?.stack?.[0];
}

async function deploy(client, account, magic, name, suffix) {
  const { nef, manifest } = load(name, suffix);
  const predicted = hex(
    experimental.getContractHash(u.HexString.fromHex(account.scriptHash), nef.checksum, manifest.name)
  );
  const txid = await retry(`deploy ${name}`, () => experimental.deployContract(nef, manifest, cfg(account, magic)));
  const log = await waitLog(client, txid, `deploy ${name}`);
  const deployed = extractDeployedContractHash(log) || predicted;
  console.log(`  ${name} => ${deployed}`);
  return deployed;
}

function randomId() {
  return Buffer.from(require('crypto').randomBytes(20)).toString('hex');
}

function stackText(item) {
  if (!item) return '';
  if (item.type === 'Integer') return String(item.value || '0');
  if (item.type === 'Boolean') return String(item.value);
  if (item.type === 'Hash160') return hex(item.value);
  if (item.type === 'ByteString') {
    const h = Buffer.from(item.value || '', 'base64').toString('hex');
    const utf8 = Buffer.from(h, 'hex').toString('utf8');
    return /^[\x20-\x7E]+$/.test(utf8) ? utf8 : `0x${h}`;
  }
  return JSON.stringify(item);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const account = new wallet.Account(TEST_WIF);
  const client = new rpc.RPCClient(RPC_URL);
  const ver = await retry('getVersion', () => client.getVersion());
  const magic = Number(ver.protocol.network);
  const tag = `rf-${Date.now().toString(36)}`;

  console.log(`\naddr=${account.address} sh=${hex(account.scriptHash)} magic=${magic}`);

  // ── Deploy core + plugins ──
  console.log('\n== Deploy ==');
  const core = await deploy(client, account, magic, 'UnifiedSmartWalletV3', `${tag}-core`);
  const web3auth = await deploy(client, account, magic, 'Web3AuthVerifier', `${tag}-w3a`);
  const sessionKey = await deploy(client, account, magic, 'SessionKeyVerifier', `${tag}-sk`);
  const dailyLimit = await deploy(client, account, magic, 'DailyLimitHook', `${tag}-dl`);
  const whitelist = await deploy(client, account, magic, 'WhitelistHook', `${tag}-wl`);
  const multiSig = await deploy(client, account, magic, 'MultiSigVerifier', `${tag}-ms`);
  const multiHook = await deploy(client, account, magic, 'MultiHook', `${tag}-mh`);

  // Authorize plugins
  for (const h of [web3auth, sessionKey, multiSig]) {
    await invoke(client, h, account, magic, 'setAuthorizedCore', [h160(core)]);
  }
  for (const h of [dailyLimit, whitelist, multiHook]) {
    await invoke(client, h, account, magic, 'setAuthorizedCore', [h160(core)]);
  }
  console.log('  all plugins authorized');

  const aa = new AbstractAccountClient(RPC_URL, core);

  // ═════════════════════════════════════════════════════════════════
  // TEST 1: Register + native ExecuteUserOp (no verifier, no hook)
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== Test 1: Register + Native ExecuteUserOp ==');
  const id1 = randomId();
  const virt1 = aa.deriveVirtualAccount(id1);
  await invoke(client, core, account, magic, 'registerAccount', [
    h160(id1), h160('0'.repeat(40)), empty(), h160('0'.repeat(40)),
    h160(hex(account.scriptHash)), int(7 * 24 * 3600),
  ]);
  console.log(`  id=0x${id1} addr=${virt1.address}`);
  assert(true, 'account registered (no verifier, no hook)');

  const deadline = BigInt(Date.now() + 3600_000);
  const userOp1 = arr(h160(GAS), str('symbol'), arr(), int(0), int(deadline), empty());
  const exec1 = await invoke(client, core, account, magic, 'executeUserOp', [h160(id1), userOp1]);
  const result1 = stackText(exec1.executions[0].stack?.[0]);
  assert(result1 === 'GAS', `native op returned: ${result1}`);

  // ═════════════════════════════════════════════════════════════════
  // TEST 2: Register with MultiSigVerifier, config + duplicate rejection
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== Test 2: MultiSigVerifier ==');
  const id2 = randomId();
  // Register with multiSig as verifier (set at registration, no timelock)
  await invoke(client, core, account, magic, 'registerAccount', [
    h160(id2), h160(multiSig), empty(), h160('0'.repeat(40)),
    h160(hex(account.scriptHash)), int(7 * 24 * 3600),
  ]);
  console.log(`  id=0x${id2} (multisig verifier)`);

  const dummies = ['01'.repeat(20), '02'.repeat(20), '03'.repeat(20)];
  await invoke(client, core, account, magic, 'callVerifier', [
    h160(id2), str('setConfig'),
    arr(h160(id2), arr(h160(dummies[0]), h160(dummies[1]), h160(dummies[2])), int(2)),
  ]);
  const msCfg = await read(client, multiSig, 'getConfig', [h160(id2)]);
  assert(msCfg != null, 'multisig config stored');

  // Duplicate rejection
  try {
    await invoke(client, core, account, magic, 'callVerifier', [
      h160(id2), str('setConfig'),
      arr(h160(id2), arr(h160(dummies[0]), h160(dummies[0])), int(2)),
    ]);
    assert(false, 'duplicate rejected');
  } catch (e) {
    assert(e.message?.includes('Duplicate') || e.message?.includes('FAULT'), 'duplicate verifiers rejected');
  }

  // ═════════════════════════════════════════════════════════════════
  // TEST 3: Register with DailyLimitHook, set limit & verify
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== Test 3: DailyLimitHook ==');
  const id3 = randomId();
  await invoke(client, core, account, magic, 'registerAccount', [
    h160(id3), h160('0'.repeat(40)), empty(), h160(dailyLimit),
    h160(hex(account.scriptHash)), int(7 * 24 * 3600),
  ]);
  console.log(`  id=0x${id3} (daily limit hook)`);

  await invoke(client, core, account, magic, 'callHook', [
    h160(id3), str('setDailyLimit'),
    arr(h160(id3), h160(GAS), int(10000), bool(false)),
  ]);
  const limit = await read(client, dailyLimit, 'getDailyLimit', [h160(id3), h160(GAS)]);
  assert(stackText(limit) === '10000', `daily limit = ${stackText(limit)}`);

  // ═════════════════════════════════════════════════════════════════
  // TEST 4: Register with MultiHook, set hooks + duplicate rejection
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== Test 4: MultiHook ==');
  const id4 = randomId();
  await invoke(client, core, account, magic, 'registerAccount', [
    h160(id4), h160('0'.repeat(40)), empty(), h160(multiHook),
    h160(hex(account.scriptHash)), int(7 * 24 * 3600),
  ]);
  console.log(`  id=0x${id4} (multihook)`);

  await invoke(client, core, account, magic, 'callHook', [
    h160(id4), str('setHooks'),
    arr(h160(id4), arr(h160(whitelist), h160(dailyLimit))),
  ]);
  const hooks = await read(client, multiHook, 'getHooks', [h160(id4)]);
  assert(hooks != null, 'multihook config stored');

  try {
    await invoke(client, core, account, magic, 'callHook', [
      h160(id4), str('setHooks'),
      arr(h160(id4), arr(h160(whitelist), h160(whitelist))),
    ]);
    assert(false, 'duplicate hook rejected');
  } catch (e) {
    assert(e.message?.includes('Duplicate') || e.message?.includes('FAULT'), 'duplicate hooks rejected');
  }

  // ═════════════════════════════════════════════════════════════════
  // TEST 5: Escape hatch — initiate + verify active
  // Note: Cannot finalize (7-day timelock), so test initiation only
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== Test 5: Escape Hatch Initiate ==');
  const id5 = randomId();
  await invoke(client, core, account, magic, 'registerAccount', [
    h160(id5), h160('0'.repeat(40)), empty(), h160('0'.repeat(40)),
    h160(hex(account.scriptHash)), int(7 * 24 * 3600),
  ]);
  await invoke(client, core, account, magic, 'initiateEscape', [h160(id5)]);
  const escActive = await read(client, core, 'isEscapeActive', [h160(id5)]);
  assert(escActive?.value === true || stackText(escActive) === 'True' || stackText(escActive) === 'true', 'escape initiated');

  // ═════════════════════════════════════════════════════════════════
  // TEST 6: Hook update timelock — updateHook creates pending state
  // Register with an initial hook, then update to trigger pending
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== Test 6: Hook Update Timelock ==');
  const id6 = randomId();
  await invoke(client, core, account, magic, 'registerAccount', [
    h160(id6), h160('0'.repeat(40)), empty(), h160(dailyLimit),
    h160(hex(account.scriptHash)), int(7 * 24 * 3600),
  ]);
  // Now update to multiHook — since hook is already set, this creates pending
  await invoke(client, core, account, magic, 'updateHook', [h160(id6), h160(multiHook)]);
  const pending = await read(client, core, 'hasPendingHookUpdate', [h160(id6)]);
  assert(pending?.value === true || stackText(pending) === 'True' || stackText(pending) === 'true', 'pending hook update created');
  const hookTime = await read(client, core, 'getPendingHookUpdateTime', [h160(id6)]);
  assert(hookTime != null && BigInt(hookTime.value || 0) > 0n, 'pending hook update has future time');

  // ═════════════════════════════════════════════════════════════════
  // TEST 7: Web3Auth Verifier — full EIP-712 signing flow
  // Uses custom struct hasher to match contract's non-standard encoding:
  // - Raw keccak256 of method (not EIP-712 string encoding)
  // - Reversed bytes for accountId (ToBytes20Word)
  // - Reversed+padding for targetContract (ToAddressWord)
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== Test 7: Web3Auth Verifier (EIP-712 signing) ==');
  const evmWallet = ethers.Wallet.createRandom();
  const pubKey = sanitizeHex(evmWallet.signingKey.publicKey);
  const evmAddress = evmWallet.address;

  const id7 = randomId();
  await invoke(client, core, account, magic, 'registerAccount', [
    h160(id7), h160(web3auth), bytes(pubKey), h160('0'.repeat(40)),
    h160(hex(account.scriptHash)), int(7 * 24 * 3600),
  ]);
  console.log(`  id=0x${id7} (web3auth verifier)`);

  const storedKey = await read(client, web3auth, 'getPublicKey', [h160(id7)]);
  assert(storedKey != null, 'web3auth public key stored');

  // Create a UserOperation to sign
  const opDeadline = BigInt(Date.now() + 3600_000);
  const method = 'symbol';
  const args = [];

  // Serialize args for hashing (same as contract's StdLib.Serialize)
  const argsForHash = arr(...args); // Create ContractParam array
  const argsScript = sc.createScript({
    scriptHash: core,
    operation: 'computeArgsHash',
    args: [argsForHash],
  });
  const argsHashResult = await client.invokeScript(u.HexString.fromHex(argsScript), []);
  const argsHash = hex(Buffer.from(argsHashResult.stack[0].value, 'base64').toString('hex'));

  // Build contract-compatible signing payload
  const signingPayload = buildWeb3AuthSigningPayload({
    chainId: magic,
    verifierHash: web3auth,
    accountIdHash: id7,
    coreContractHash: core,
    targetContract: sanitizeHex(GAS),
    method,
    argsHash,
    nonce: 0n,
    deadline: opDeadline,
  });

  // Sign using raw ECDSA — the contract verifies keccak256(payload) directly
  // (NOT EIP-191 signMessage, which wraps with "\x19Ethereum Signed Message:\n")
  const signingDigest = ethers.keccak256(signingPayload);
  const sig = evmWallet.signingKey.sign(signingDigest);
  // Contract expects 64-byte signature (r=32 + s=32), no recovery byte
  const sigBytes = ethers.getBytes(sig.serialized).slice(0, 64);
  console.log(`  signature=${hex(ethers.hexlify(sigBytes))}`);

  const sigHex = hex(ethers.hexlify(sigBytes));

  // Create UserOperation with signature
  const userOp7 = {
    TargetContract: hex(sanitizeHex(GAS)),
    Method: method,
    Args: args,
    Nonce: 0,
    Deadline: opDeadline,
    Signature: sigHex,
  };

  // Execute the signed UserOperation via callVerifier
  // Web3AuthVerifier.ValidateSignature checks the signature
  const execResult = await read(client, web3auth, 'validateSignature', [
    h160(id7), arr(
      h160(userOp7.TargetContract),
      str(userOp7.Method),
      arr(...userOp7.Args),
      int(userOp7.Nonce),
      int(userOp7.Deadline),
      bytes(userOp7.Signature)
    ),
  ]);
  const isValid = execResult?.value === true || stackText(execResult) === 'True' || stackText(execResult) === 'true';
  assert(isValid, 'EIP-712 signature validated by contract');
  console.log(`  EVM signer address: ${evmAddress}`);

  // Also verify by calling executeUserOp on the core contract
  const exec7 = await invoke(client, core, account, magic, 'executeUserOp', [
    h160(id7), arr(
      h160(userOp7.TargetContract),
      str(userOp7.Method),
      arr(...userOp7.Args),
      int(userOp7.Nonce),
      int(userOp7.Deadline),
      bytes(userOp7.Signature)
    ),
  ]);
  const result7 = stackText(exec7.executions[0].stack?.[0]);
  assert(result7 === 'GAS', `signed op returned: ${result7}`);
  console.log('  EIP-712 signed UserOp executed successfully');

  // ── Summary ──
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${PASS} passed, ${FAIL} failed`);
  console.log(`${'='.repeat(50)}`);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
