/**
 * Shared deploy plumbing for the scripts/ deploy entrypoints
 * (deploy_market_and_list.js, deploy_market_phase2.js,
 * deploy_mainnet_market_paymaster.js).
 *
 * Covers: workspace package resolution, RPC retry, artifact loading,
 * ContractParam/signer builders, application-log waiting, HALT assertion,
 * preview-then-invoke (which always aborts on a FAULT preview instead of
 * broadcasting), contract deployment, and the market-listing helpers shared
 * by the two testnet market scripts (psql access + price classification).
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function requireWorkspacePackage(name) {
  try {
    return require(name);
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return require(path.resolve(REPO_ROOT, 'sdk', 'js', 'node_modules', name));
  }
}

const neon = requireWorkspacePackage('@cityofzion/neon-js');
const { sc, tx, u, experimental } = neon;

const { extractDeployedContractHash } = require('../../sdk/js/src/deployLog');
const { sanitizeHex } = require('../../sdk/js/src/metaTx');

// ── RPC retry ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRpcError(error) {
  const msg = error instanceof Error ? error.message : String(error || '');
  return /socket hang up|ECONNRESET|ETIMEDOUT|fetch failed|network error|EAI_AGAIN|ECONNREFUSED|EADDRNOTAVAIL|premature close/i.test(msg);
}

async function withRpcRetry(label, fn, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt >= attempts) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`  [rpc-retry] ${label} attempt ${attempt}/${attempts}: ${msg}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

// ── Artifact loading ────────────────────────────────────────────────────────

function artifactPaths(baseName) {
  // Deployment names may select a nested public module, never an alternate
  // profile or filesystem path. In particular ../platform must not be usable.
  if (typeof baseName !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(baseName)) {
    throw new Error('Invalid public artifact name; select an artifact under contracts/bin/v3');
  }
  const base = path.resolve(REPO_ROOT, 'contracts', 'bin', 'v3');
  return {
    nef: path.join(base, `${baseName}.nef`),
    manifest: path.join(base, `${baseName}.manifest.json`),
  };
}

function loadArtifact(baseName, uniqueSuffix = '') {
  const paths = artifactPaths(baseName);
  const nef = sc.NEF.fromBuffer(fs.readFileSync(paths.nef));
  const manifestJson = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  if (uniqueSuffix) manifestJson.name = `${manifestJson.name}-${uniqueSuffix}`;
  const manifest = sc.ContractManifest.fromJson(manifestJson);
  return { nef, manifest, manifestName: manifestJson.name };
}

// ── Hash / config / param builders ──────────────────────────────────────────

function normalizeHash(value) {
  const hex = sanitizeHex(value || '');
  return hex ? `0x${hex}` : '';
}

function stackHash160(item) {
  const raw = String(item?.value || '').trim();
  const direct = sanitizeHex(raw);
  if (/^[0-9a-f]{40}$/i.test(direct)) return `0x${direct.toLowerCase()}`;

  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 20) {
    throw new Error(`Expected a Hash160 stack item, received ${item?.type || 'unknown'}`);
  }
  return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
}

function buildConfig(account, networkMagic, rpcAddress) {
  return { account, networkMagic, rpcAddress, blocksTillExpiry: 200 };
}

function predictContractHash(account, nefChecksum, manifestName) {
  return normalizeHash(
    experimental.getContractHash(
      u.HexString.fromHex(account.scriptHash),
      nefChecksum,
      manifestName
    )
  );
}

function hash160Param(value) {
  return sc.ContractParam.hash160(sanitizeHex(value));
}

function integerParam(value) {
  return sc.ContractParam.integer(typeof value === 'bigint' ? value.toString() : String(value));
}

function stringParam(value) {
  return sc.ContractParam.string(String(value));
}

function byteArrayParam(hexValue = '') {
  return sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(hexValue), true));
}

function arrayParam(...items) {
  return sc.ContractParam.array(...items);
}

function makeSigner(scriptHash) {
  return new tx.Signer({ account: scriptHash, scopes: tx.WitnessScope.CalledByEntry });
}

function makeCustomContractSigner(scriptHash, allowedContracts = []) {
  return new tx.Signer({
    account: scriptHash,
    scopes: tx.WitnessScope.CustomContracts,
    allowedContracts: allowedContracts.map((value) => sanitizeHex(value)),
  });
}

// ── Application-log wait + HALT assert ──────────────────────────────────────

async function waitForAppLog(client, txid, label, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const appLog = await client.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch (_) {
      // Still waiting for persistence.
    }
    await sleep(3000);
  }
  throw new Error(`${label}: timed out waiting for application log for ${txid}`);
}

function assertVmState(appLog, label, expected = 'HALT') {
  const execution = appLog?.executions?.[0];
  if (!execution) throw new Error(`${label}: missing execution log`);
  const vmState = String(execution.vmstate || execution.state || '');
  if (!vmState.includes(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${vmState} -- ${execution.exception || ''}`.trim());
  }
  return execution;
}

// ── Preview-then-invoke / deploy ────────────────────────────────────────────

/**
 * Test-invokes the operation first and refuses to broadcast when the preview
 * FAULTs, then broadcasts with the previewed gas as the system fee and waits
 * for a HALTed application log.
 */
async function invokePersisted({ client, account, networkMagic, rpcUrl, contractHash, operation, params = [], signers, onBroadcast }) {
  const baseConfig = buildConfig(account, networkMagic, rpcUrl);
  const effectiveSigners = signers && signers.length > 0 ? signers : [makeSigner(account.scriptHash)];
  const contract = new experimental.SmartContract(sanitizeHex(contractHash), baseConfig);
  const preview = await withRpcRetry(`${operation}.preview`, () =>
    contract.testInvoke(operation, params, effectiveSigners));
  if (String(preview?.state || '') !== 'HALT') {
    throw new Error(`${operation} preview ${preview?.state || 'UNKNOWN'}: ${preview?.exception || 'missing successful HALT result'}`);
  }
  const systemFeeOverride = u.BigInteger.fromDecimal(preview.gasconsumed || '1', 0);
  const invokeContract = new experimental.SmartContract(
    sanitizeHex(contractHash),
    { ...baseConfig, systemFeeOverride },
  );
  // Never retry an ambiguous broadcast.  A transport timeout can happen after
  // the node accepted the transaction; retrying could create a second state
  // transition (or make the caller incorrectly fall back to another witness).
  const txid = await invokeContract.invoke(operation, params, effectiveSigners);
  // Persist the transaction ID before waiting for confirmation or doing any
  // post-state checks.  A later read failure must not erase the broadcast receipt.
  if (onBroadcast) await onBroadcast(txid);
  const appLog = await waitForAppLog(client, txid, operation);
  assertVmState(appLog, operation, 'HALT');
  return { txid, appLog };
}

/**
 * Deploys a contracts/bin/v3 artifact (optionally renamed with a unique
 * manifest suffix) and waits for the HALTed deployment log.
 */
async function deployArtifact({ client, account, networkMagic, rpcUrl, baseName, uniqueSuffix = '' }) {
  const { nef, manifest, manifestName } = loadArtifact(baseName, uniqueSuffix);
  const predictedHash = predictContractHash(account, nef.checksum, manifestName);
  console.log(`  Deploying ${baseName}${uniqueSuffix ? ` (suffix: ${uniqueSuffix})` : ''}...`);
  console.log(`  Predicted hash: ${predictedHash}`);
  const txid = await withRpcRetry(`deploy ${baseName}`, () =>
    experimental.deployContract(nef, manifest, buildConfig(account, networkMagic, rpcUrl)));
  console.log(`  TX: ${txid}`);
  const appLog = await waitForAppLog(client, txid, `deploy ${baseName}`);
  assertVmState(appLog, `deploy ${baseName}`, 'HALT');
  const hash = normalizeHash(extractDeployedContractHash(appLog) || predictedHash);
  console.log(`  Deployed: ${hash}`);
  return { txid, hash, manifestName };
}

// ── Vanity market-row and core-binding analysis ─────────────────────────────

/**
 * Extracts the identity material a vanity market row's stored witness script
 * commits to. The vanity generator and the SDK's buildVerifyScript agree on
 * the layout's tail:
 *
 *   0c14 <accountId: 20 bytes> 11 c0 1f 0c06 <"verify"> 0c14 <coreHash:
 *   20 bytes in wire (reversed) form> 41627d5b52   (SYSCALL System.Contract.Call)
 *
 * The first 20-byte PUSHDATA is the vanity account id exactly as the vanity
 * generator pushed it (display hex); the last one is the SA core hash in
 * reversed wire form, so its display form is the byte reverse of the push.
 * Anything that is not that layout returns null — a strict parse, because a
 * lenient one could bless a corrupted row as a consistent one.
 */
function parseVanityVerifyScript(verifyScriptHex) {
  const hex = sanitizeHex(verifyScriptHex || '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  if (!hex.endsWith('41627d5b52')) return null; // must end in the Contract.Call syscall

  const pushes = [];
  for (let i = 0; i + 2 <= hex.length;) {
    const opcode = parseInt(hex.slice(i, i + 2), 16);
    if (opcode === 0x0c || opcode === 0x0d) {
      const sizeBytes = opcode === 0x0c ? 1 : 2;
      const sizeStart = i + 2;
      if (sizeStart + sizeBytes * 2 > hex.length) return null;
      let length = 0;
      for (let b = 0; b < sizeBytes; b += 1) {
        length += parseInt(hex.slice(sizeStart + b * 2, sizeStart + b * 2 + 2), 16) << (8 * b);
      }
      const dataStart = sizeStart + sizeBytes * 2;
      if (length === 0 || dataStart + length * 2 > hex.length) return null;
      pushes.push(hex.slice(dataStart, dataStart + length * 2));
      i = dataStart + length * 2;
      continue;
    }
    i += 2;
  }

  const twentyBytePushes = pushes.filter((item) => item.length === 40);
  if (twentyBytePushes.length !== 2) return null;
  if (!pushes.includes('766572696679')) return null; // the "verify" method name

  const accountId = twentyBytePushes[0];
  const coreWire = twentyBytePushes[twentyBytePushes.length - 1];
  let coreDisplay = '';
  for (let i = coreWire.length; i > 0; i -= 2) coreDisplay += coreWire.slice(i - 2, i);
  return { accountId, coreContractHash: coreDisplay };
}

/**
 * Classifies how a deployed module's authorized-core state relates to the SA
 * core this run targets. VerifierAuthority/PaymasterAuthority (audit fix M-7)
 * permit the instant SetAuthorizedCore only for the initial (unset) core:
 * re-pointing an already-configured core is a rebind that faults inside
 * SetAuthorizedCore and must go through the timelocked
 * Propose/ConfirmAuthorizedCore path. `currentCore` may be the raw stack value
 * (with or without 0x); an all-zero or empty value counts as unset.
 */
function classifyAuthorizedCoreBinding(currentCore, activeCoreHash) {
  const current = sanitizeHex(currentCore || '');
  const active = sanitizeHex(activeCoreHash || '');
  if (!current || current === '00'.repeat(20)) return 'first-bind';
  if (current === active) return 'already-bound';
  return 'rebind';
}

// ── Market listing helpers (testnet market scripts) ─────────────────────────

// Price tiers (GAS has 8 decimals)
const PRICE_TIERS = {
  MIRROR: 50_00000000n, // 50 GAS
  NAMED: 100_00000000n, // 100 GAS
  PREFIX: 10_00000000n, // 10 GAS
  ULTRA: 200_00000000n, // 200 GAS
  COMPOUND: 25_00000000n, // 25 GAS (multi-token patterns like NR3EBTC)
};

function classifyPrice(pattern) {
  const p = pattern.toUpperCase();
  if (p.startsWith('ULTRA')) return PRICE_TIERS.ULTRA;
  if (p.startsWith('MIRROR')) return PRICE_TIERS.MIRROR;

  // Named patterns (contain recognizable brand names)
  const namedPatterns = ['TRUMP', 'NVIDIA', 'BITCOIN'];
  for (const name of namedPatterns) {
    if (p.includes(name)) return PRICE_TIERS.NAMED;
  }

  // Compound token patterns like NR3EBTC, NNeoBTC, NNeoETH, NNeoNGD, NNeoNNT, NR3ENGD, etc.
  const compoundTokens = ['BTC', 'ETH', 'NGD', 'NNT', 'NEO', 'R3E', 'COZ'];
  let tokenCount = 0;
  for (const token of compoundTokens) {
    if (p.includes(token)) tokenCount += 1;
  }
  if (tokenCount >= 2) return PRICE_TIERS.COMPOUND;

  // Named ecosystem patterns
  if (p.includes('NEOVM') || p.includes('NEOFS') || p.includes('CRYPTO')) return PRICE_TIERS.COMPOUND;

  // Simple prefix patterns
  return PRICE_TIERS.PREFIX;
}

function decodeDbUrlPart(value) {
  return decodeURIComponent(value || '');
}

function buildPsqlEnv(connectionString) {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('NEON_DB_URL must be a postgres connection string');
  }

  const env = { ...process.env };
  delete env.NEON_DB_URL;
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || '5432';
  env.PGDATABASE = decodeDbUrlPart(url.pathname.replace(/^\/+/, ''));
  env.PGUSER = decodeDbUrlPart(url.username);
  env.PGPASSWORD = decodeDbUrlPart(url.password);
  env.PGSSLMODE = url.searchParams.get('sslmode') || process.env.PGSSLMODE || 'require';
  return env;
}

function loadAccountsFromDB(neonDbUrl) {
  // Use psql via child_process since pg module may not be installed in this project
  const { execFileSync } = require('child_process');
  const query = 'SELECT id, pattern, address, account_id_hash, script_hash, verify_script FROM sa_accounts ORDER BY id';
  if (!neonDbUrl) {
    throw new Error('NEON_DB_URL is required');
  }
  const result = execFileSync(
    'psql',
    ['-t', '-A', '-F', '|', '-c', query],
    { env: buildPsqlEnv(neonDbUrl), encoding: 'utf8', timeout: 30000 }
  );
  return result.trim().split('\n').filter(Boolean).map((line) => {
    const [id, pattern, address, account_id_hash, script_hash, verify_script] = line.split('|');
    return { id: parseInt(id), pattern, address, account_id_hash, script_hash, verify_script };
  });
}

module.exports = {
  neon,
  requireWorkspacePackage,
  sanitizeHex,
  extractDeployedContractHash,
  sleep,
  isRetryableRpcError,
  withRpcRetry,
  artifactPaths,
  loadArtifact,
  parseVanityVerifyScript,
  classifyAuthorizedCoreBinding,
  normalizeHash,
  stackHash160,
  buildConfig,
  predictContractHash,
  hash160Param,
  integerParam,
  stringParam,
  byteArrayParam,
  arrayParam,
  makeSigner,
  makeCustomContractSigner,
  waitForAppLog,
  assertVmState,
  invokePersisted,
  deployArtifact,
  PRICE_TIERS,
  classifyPrice,
  decodeDbUrlPart,
  buildPsqlEnv,
  loadAccountsFromDB,
};
