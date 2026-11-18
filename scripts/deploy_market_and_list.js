#!/usr/bin/env node
/**
 * Deploy SAAddressMarket to testnet and list the vanity accounts from the
 * Neon/Postgres market inventory for sale.
 *
 * Sequence:
 *   0. Pre-flight: validate every DB row against the CURRENT registration
 *      protocol (strict vanity-ID conflict rejection by default)
 *   1. Deploy new SA Core (with market escrow methods)
 *   2. Deploy SAAddressMarket and allowlist the fresh core
 *   3. Register every account on-chain
 *   4. Create market listings for each account
 *
 * F-18 remediation (re-verified from code): the current RegisterAccount asserts
 * `accountId == ComputeRegistrationAccountId(verifier, verifierParams, hookId,
 * backupOwner, escapeTimelock)` ("Account id does not match registration
 * parameters"), so the DB's stored vanity IDs — derived by the old
 * seed/contract-hash-prefix scheme against the old core — can no longer be
 * registered as-is. The script therefore:
 *   * refuses by default (strict reject, nothing broadcast, exit code 1) when
 *     a stored vanity ID conflicts with the ID the current protocol derives
 *     from the registration parameters, when the stored verify script binds a
 *     different SA core, or when the row is internally inconsistent;
 *   * with `--derive-ids`, explicitly overrides the vanity-vs-protocol
 *     conflicts: it registers and lists the protocol-derived registration IDs
 *     (per-row registration material keeps the accounts distinct) and warns
 *     that the DB's vanity addresses no longer identify those accounts.
 *     Rows whose stored data is internally corrupt still refuse.
 *
 * The registration itself is protocol-consistent: no verifier (the accounts
 * authorize through the backup owner's native witness), per-row registration
 * material, no hook, the deployer as backup owner and the 7-day minimum escape
 * timelock. Any registration or listing failure keeps the exit code non-zero
 * and never prints a completion banner.
 *
 * Usage:
 *   node scripts/deploy_market_and_list.js [--derive-ids]
 *
 * Environment:
 *   Set `NEO_TESTNET_WIF` (or `MARKET_DEPLOY_WIF`) to the funded deployer WIF.
 *   Set `NEON_DB_URL` to the target Neon/Postgres connection string.
 *
 * Shared deploy plumbing lives in scripts/lib/deploy-helpers.js; its
 * invokePersisted/deployArtifact helpers abort with "<operation> preview FAULT"
 * before broadcasting whenever the testInvoke preview FAULTs.
 */

const fs = require('fs');
const path = require('path');

const {
  neon,
  sanitizeHex,
  withRpcRetry,
  normalizeHash,
  buildConfig,
  hash160Param,
  integerParam,
  stringParam,
  byteArrayParam,
  makeSigner,
  makeCustomContractSigner,
  waitForAppLog,
  assertVmState,
  invokePersisted,
  deployArtifact,
  loadArtifact,
  predictContractHash,
  classifyPrice,
  loadAccountsFromDB,
  parseVanityVerifyScript,
} = require('./lib/deploy-helpers');

const { SmartAccountClient } = require('../sdk/js/src/index');

const { rpc, sc, tx, wallet, experimental, u } = neon;

// ── Config ──────────────────────────────────────────────────────────────────

const WIF = process.env.MARKET_DEPLOY_WIF || process.env.NEO_TESTNET_WIF || '';
const RPC_URLS = [
  'http://seed1t5.neo.org:20332',
  'http://seed2t5.neo.org:20332',
  'http://seed3t5.neo.org:20332',
  'http://seed4t5.neo.org:20332',
  'http://seed5t5.neo.org:20332',
];
const NEON_DB_URL = process.env.NEON_DB_URL || '';
const TESTNET_NETWORK_MAGIC = 894710606;
const DEPLOY_TAG = `market-${Date.now().toString(36)}`;
const ZERO_HASH160 = '0000000000000000000000000000000000000000';

// The protocol minimum escape timelock (RegisterAccount asserts >= 604800).
const REGISTRATION_ESCAPE_TIMELOCK = 604800;

const RESULTS_FILE = path.resolve(__dirname, '..', 'docs', 'reports', 'market-deployment-results.json');

// ── Vanity ID conflict validation (F-18) ──────────────────────────────────────

/**
 * Structural consistency of a market row: the stored verify script must parse
 * as the standard vanity witness script, embed the row's stored account id, and
 * bind the SA core this run targets. Structural failures corrupt the inventory
 * itself and are never overridden, not even by --derive-ids.
 */
function validateVanityAccountRows(rows, { coreHash }) {
  const target = sanitizeHex(coreHash || '');
  const conflicts = [];
  for (const row of rows) {
    const parsed = parseVanityVerifyScript(row.verify_script);
    if (!parsed) {
      conflicts.push({
        id: row.id,
        kind: 'unparseable-script',
        message: `account #${row.id} (${row.pattern || '?'}) has a verify script that is not the standard vanity witness layout`,
      });
      continue;
    }
    if (parsed.accountId !== sanitizeHex(row.account_id_hash || '')) {
      conflicts.push({
        id: row.id,
        kind: 'stored-id-mismatch',
        message: `account #${row.id}: stored account id ${row.account_id_hash} does not match the id embedded in its verify script (${parsed.accountId})`,
      });
    }
    if (parsed.coreContractHash !== target) {
      conflicts.push({
        id: row.id,
        kind: 'core-binding-mismatch',
        message: `account #${row.id}: its verify script binds SA core 0x${parsed.coreContractHash}, not this run's core 0x${target}`,
      });
    }
  }
  return conflicts;
}

/**
 * The registration id the CURRENT protocol derives for the exact registration
 * parameters this script sends. `registrationMaterialHex` is the per-row
 * verifierParams preimage that keeps the derived ids distinct per account.
 */
function deriveRegistrationId({ registrationMaterialHex, backupOwnerScriptHash, escapeTimelock = REGISTRATION_ESCAPE_TIMELOCK }) {
  return sanitizeHex(deriveRegistrationIdHexWith({
    registrationMaterialHex,
    backupOwnerScriptHash,
    escapeTimelock,
  }));
}

// Kept as a thin seam so tests can inject the SDK deriver without constructing
// an RPC client; production callers pass the SmartAccountClient-bound deriver.
let registrationIdDeriver = null;

function setRegistrationIdDeriver(deriver) {
  registrationIdDeriver = deriver;
}

function deriveRegistrationIdHexWith({ registrationMaterialHex, backupOwnerScriptHash, escapeTimelock }) {
  if (!registrationIdDeriver) {
    throw new Error('registration id deriver not configured (setRegistrationIdDeriver)');
  }
  return registrationIdDeriver({
    verifierContractHash: '',
    verifierParamsHex: sanitizeHex(registrationMaterialHex || ''),
    hookContractHash: '',
    backupOwnerAddress: backupOwnerScriptHash,
    escapeTimelock,
  });
}

/**
 * The per-row vanity ID conflicts against the current registration protocol:
 * every row whose stored account id differs from the protocol-derived
 * registration id cannot be registered as-is (the core faults with
 * "Account id does not match registration parameters").
 */
function findVanityRegistrationIdConflicts(rows, { backupOwnerScriptHash, escapeTimelock = REGISTRATION_ESCAPE_TIMELOCK }) {
  const conflicts = [];
  for (const row of rows) {
    const derivedId = deriveRegistrationId({
      registrationMaterialHex: row.account_id_hash,
      backupOwnerScriptHash,
      escapeTimelock,
    });
    if (derivedId !== sanitizeHex(row.account_id_hash || '')) {
      conflicts.push({
        id: row.id,
        kind: 'registration-id-conflict',
        derivedId,
        message: `account #${row.id}: the stored vanity id ${row.account_id_hash} conflicts with the id the current protocol derives from its registration parameters (${derivedId})`,
      });
    }
  }
  return conflicts;
}

/**
 * The exact registerAccount argument list for one row, matching the
 * registration derivation byte-for-byte (verifier-less owner-witness account,
 * per-row registration material as verifierParams — hashed into the id by the
 * core but never dispatched, since the verifier is zero).
 */
function buildRegisterAccountArgs({ derivedId, registrationMaterialHex, backupOwnerScriptHash, escapeTimelock = REGISTRATION_ESCAPE_TIMELOCK }) {
  return [
    hash160Param(derivedId),
    hash160Param(ZERO_HASH160), // no verifier: authorize through the backup owner's native witness
    byteArrayParam(sanitizeHex(registrationMaterialHex || '')),
    hash160Param(ZERO_HASH160), // no hook
    hash160Param(backupOwnerScriptHash),
    integerParam(escapeTimelock),
  ];
}

function parseArgs(argv) {
  const flags = new Set(argv);
  const unknown = [...flags].filter((flag) => flag !== '--derive-ids');
  if (unknown.length > 0) {
    throw new Error(`Unknown arguments: ${unknown.join(' ')} (only --derive-ids is supported)`);
  }
  return { deriveIds: flags.has('--derive-ids') };
}

// ── Multi-call invoke (unique to this script) ───────────────────────────────

async function invokeMultiPersisted(client, account, networkMagic, calls = [], signers = undefined) {
  const builder = new sc.ScriptBuilder();
  for (const call of calls) {
    builder.emitAppCall(sanitizeHex(call.scriptHash), call.operation, call.args || []);
  }
  const scriptHex = builder.build();
  const transaction = new tx.Transaction();
  transaction.script = u.HexString.fromHex(scriptHex);
  await experimental.txHelpers.setBlockExpiry(transaction, buildConfig(account, networkMagic, RPC_URLS[0]), 200);
  transaction.signers = signers && signers.length > 0 ? signers : [makeSigner(account.scriptHash)];
  const preview = await withRpcRetry('invokeScript', () =>
    client.invokeScript(scriptHex, transaction.signers)
  );
  if (String(preview?.state || '').includes('FAULT')) {
    throw new Error(`invokeMulti preview FAULT: ${preview.exception || 'unknown error'}`);
  }
  transaction.systemFee = u.BigInteger.fromDecimal(preview.gasconsumed, 0);
  await experimental.txHelpers.addFees(transaction, buildConfig(account, networkMagic, RPC_URLS[0]));
  transaction.sign(account, networkMagic);
  const txid = await withRpcRetry('sendRawTransaction', () => client.sendRawTransaction(transaction));
  const appLog = await waitForAppLog(client, txid, 'invokeMulti');
  assertVmState(appLog, 'invokeMulti', 'HALT');
  return { txid, appLog };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { deriveIds } = parseArgs(process.argv.slice(2));
  if (!WIF) {
    throw new Error('MARKET_DEPLOY_WIF or NEO_TESTNET_WIF is required');
  }
  if (!NEON_DB_URL) {
    throw new Error('NEON_DB_URL is required');
  }

  const account = new wallet.Account(WIF);
  const client = new rpc.RPCClient(RPC_URLS[0]);
  const version = await withRpcRetry('getVersion', () => client.getVersion());
  const networkMagic = Number(version.protocol.network);
  if (networkMagic !== TESTNET_NETWORK_MAGIC) {
    throw new Error(`RPC network magic mismatch: expected ${TESTNET_NETWORK_MAGIC}, got ${networkMagic || 'unknown'}`);
  }

  console.log('=== SA Address Market Deployment ===');
  console.log(`Deployer: ${account.address} (${normalizeHash(account.scriptHash)})`);
  console.log(`RPC: ${RPC_URLS[0]}`);
  console.log(`Network Magic: ${networkMagic}`);
  console.log(`Deploy Tag: ${DEPLOY_TAG}`);
  console.log(`Vanity ID conflicts: ${deriveIds ? 'overridden (--derive-ids)' : 'strict reject (default)'}`);
  console.log('');

  const deployCtx = { client, account, networkMagic, rpcUrl: RPC_URLS[0] };

  // Step 0: load the inventory and validate it BEFORE anything is broadcast —
  // the predicted core hash is deterministic, so the conflict check runs
  // against the exact core this run will deploy.
  console.log('[0/4] Validating vanity accounts against the current registration protocol...');
  const accounts = loadAccountsFromDB(NEON_DB_URL);
  console.log(`  Loaded ${accounts.length} accounts from Neon DB`);

  const coreArtifact = loadArtifact('SmartAccount', `${DEPLOY_TAG}-core`);
  const predictedCoreHash = predictContractHash(account, coreArtifact.nef.checksum, coreArtifact.manifestName);
  const saClient = new SmartAccountClient(RPC_URLS[0], predictedCoreHash);
  setRegistrationIdDeriver((options) => saClient.deriveRegistrationAccountIdHash(options));

  const structuralConflicts = validateVanityAccountRows(accounts, { coreHash: predictedCoreHash });
  const registrationConflicts = findVanityRegistrationIdConflicts(accounts, {
    backupOwnerScriptHash: account.scriptHash,
  });

  if (structuralConflicts.length > 0) {
    for (const conflict of structuralConflicts) console.error(`  REFUSED: ${conflict.message}`);
    throw new Error(`Refusing to deploy: ${structuralConflicts.length} inventory row(s) are structurally inconsistent; fix the Neon DB rows first (--derive-ids does not override data corruption).`);
  }
  if (registrationConflicts.length > 0 && !deriveIds) {
    for (const conflict of registrationConflicts) console.error(`  REFUSED: ${conflict.message}`);
    throw new Error(`Refusing to broadcast: ${registrationConflicts.length} stored vanity id(s) conflict with the ids the current protocol derives from their registration parameters ("Account id does not match registration parameters"). Re-run with --derive-ids to explicitly register the derived ids instead of the stored vanity ids.`);
  }
  if (deriveIds && registrationConflicts.length > 0) {
    console.log(`  --derive-ids: overriding ${registrationConflicts.length} vanity id conflict(s); the protocol-derived registration ids will be registered instead.`);
    console.log('  WARNING: the DB vanity addresses no longer identify these accounts; listing titles use the derived virtual addresses.');
  }
  if (deriveIds && structuralConflicts.length === 0 && registrationConflicts.length === 0) {
    console.log('  --derive-ids: no conflicts found; the stored vanity ids are already protocol-consistent.');
  }
  console.log('');

  // Resolve the effective account id for every row once: the stored vanity id
  // when it already satisfies the protocol, otherwise (--derive-ids) the
  // protocol-derived registration id.
  const effectiveAccounts = accounts.map((acct) => {
    const derivedId = deriveRegistrationId({
      registrationMaterialHex: acct.account_id_hash,
      backupOwnerScriptHash: account.scriptHash,
    });
    const registrationId = derivedId === sanitizeHex(acct.account_id_hash)
      ? sanitizeHex(acct.account_id_hash)
      : (deriveIds ? derivedId : sanitizeHex(acct.account_id_hash));
    // The SDK-derived virtual address of the account this run registers.
    const virtualAddress = saClient.deriveVirtualAccount(registrationId).address;
    return {
      ...acct,
      registrationId,
      virtualAddress,
    };
  });
  console.log('');

  // Step 1: Deploy contracts
  console.log('[1/4] Deploying SA Core (with market escrow)...');
  const core = await deployArtifact({ ...deployCtx, baseName: 'SmartAccount', uniqueSuffix: `${DEPLOY_TAG}-core` });
  console.log(`  SA Core deployed: ${core.hash}`);
  console.log('');

  console.log('[2/4] Deploying SAAddressMarket and allowlisting the core...');
  const market = await deployArtifact({ ...deployCtx, baseName: 'SAAddressMarket', uniqueSuffix: `${DEPLOY_TAG}-market` });
  console.log(`  Market deployed: ${market.hash}`);
  // CreateListing asserts IsAllowedSA(saContract); the market admin is the
  // deployer (Runtime.Transaction.Sender at deployment), so allowlist the core
  // this run just deployed — otherwise every listing faults.
  await invokePersisted({
    ...deployCtx,
    contractHash: market.hash,
    operation: 'setAllowedSA',
    params: [hash160Param(core.hash), sc.ContractParam.boolean(true)],
  });
  console.log(`  Core ${core.hash} allowlisted on the market`);
  console.log('');

  // Step 2: Register accounts in batches (multi-invoke to avoid nonce conflicts)
  const failedRegistrations = [];
  console.log('[3/4] Registering vanity accounts on-chain...');
  const BATCH_SIZE = 5;
  for (let i = 0; i < effectiveAccounts.length; i += BATCH_SIZE) {
    const batch = effectiveAccounts.slice(i, i + BATCH_SIZE);
    const batchLabel = `Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(effectiveAccounts.length / BATCH_SIZE)}`;
    console.log(`  ${batchLabel}: registering accounts ${batch[0].id}-${batch[batch.length - 1].id}...`);

    const calls = batch.map((acct) => ({
      scriptHash: core.hash,
      operation: 'registerAccount',
      args: buildRegisterAccountArgs({
        derivedId: acct.registrationId,
        registrationMaterialHex: acct.account_id_hash,
        backupOwnerScriptHash: account.scriptHash,
      }),
    }));

    try {
      const result = await invokeMultiPersisted(client, account, networkMagic, calls, [
        makeSigner(account.scriptHash),
      ]);
      console.log(`  ${batchLabel}: OK (tx: ${result.txid})`);
    } catch (err) {
      console.error(`  ${batchLabel}: FAILED - ${err.message}`);
      // Try one-by-one fallback for this batch
      for (const acct of batch) {
        try {
          console.log(`    Retrying account ${acct.id} individually...`);
          await invokePersisted({
            ...deployCtx,
            contractHash: core.hash,
            operation: 'registerAccount',
            params: buildRegisterAccountArgs({
              derivedId: acct.registrationId,
              registrationMaterialHex: acct.account_id_hash,
              backupOwnerScriptHash: account.scriptHash,
            }),
            signers: [makeSigner(account.scriptHash)],
          });
          console.log(`    Account ${acct.id}: OK`);
        } catch (retryErr) {
          console.error(`    Account ${acct.id}: FAILED - ${retryErr.message}`);
          failedRegistrations.push({ dbId: acct.id, pattern: acct.pattern, error: retryErr.message });
        }
      }
    }
  }
  console.log('');

  // Step 3: Create market listings
  console.log('[4/4] Creating market listings for all accounts...');
  const listings = [];
  const failedListings = [];

  for (let i = 0; i < effectiveAccounts.length; i += BATCH_SIZE) {
    const batch = effectiveAccounts.slice(i, i + BATCH_SIZE);
    const batchLabel = `Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(effectiveAccounts.length / BATCH_SIZE)}`;
    console.log(`  ${batchLabel}: listing accounts ${batch[0].id}-${batch[batch.length - 1].id}...`);

    // Listings must be done one-by-one because createListing allocates sequential IDs
    // and the market escrow call needs CalledByEntry witness scope from the seller
    // through the market contract into the core. Use CustomContracts scope.
    for (const acct of batch) {
      const price = classifyPrice(acct.pattern);
      const title = `${acct.pattern} | ${acct.virtualAddress}`;
      const truncatedTitle = title.length > 80 ? title.substring(0, 77) + '...' : title;

      try {
        const result = await invokePersisted({
          ...deployCtx,
          contractHash: market.hash,
          operation: 'createListing',
          params: [
            hash160Param(core.hash),
            hash160Param(acct.registrationId),
            integerParam(price),
            stringParam(truncatedTitle),
            stringParam(''),
          ],
          signers: [makeCustomContractSigner(account.scriptHash, [market.hash, core.hash])],
        });

        const priceGas = Number(price) / 1e8;
        listings.push({
          dbId: acct.id,
          pattern: acct.pattern,
          address: acct.virtualAddress,
          accountIdHash: acct.registrationId,
          storedVanityId: sanitizeHex(acct.account_id_hash),
          priceGas,
          txid: result.txid,
        });
        console.log(`    #${acct.id} ${acct.pattern} (${priceGas} GAS): OK`);
      } catch (err) {
        console.error(`    #${acct.id} ${acct.pattern}: FAILED - ${err.message}`);
        failedListings.push({ dbId: acct.id, pattern: acct.pattern, error: err.message });
      }
    }
  }

  // Save results (always: the receipt of what did happen must survive an
  // incomplete run).
  const results = {
    timestamp: new Date().toISOString(),
    deployTag: DEPLOY_TAG,
    network: 'testnet',
    networkMagic,
    deriveIds,
    deployer: { address: account.address, scriptHash: normalizeHash(account.scriptHash) },
    contracts: {
      saCore: core,
      market: market,
    },
    totalAccounts: accounts.length,
    totalRegistered: accounts.length - failedRegistrations.length,
    totalListings: listings.length,
    failedRegistrations,
    failedListings,
    listings,
  };

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log('');
  const failed = failedRegistrations.length + failedListings.length;
  if (failed > 0) {
    // F-18: a partial run must not print a completion banner or exit 0.
    console.log('=== Deployment Incomplete ===');
    console.log(`SA Core: ${core.hash}`);
    console.log(`Market:  ${market.hash}`);
    console.log(`Registered: ${results.totalRegistered}/${accounts.length} (failed: ${failedRegistrations.length})`);
    console.log(`Listings: ${listings.length}/${accounts.length} (failed: ${failedListings.length})`);
    for (const failure of failedRegistrations) console.error(`  register #${failure.dbId} (${failure.pattern}): ${failure.error}`);
    for (const failure of failedListings) console.error(`  list #${failure.dbId} (${failure.pattern}): ${failure.error}`);
    console.log(`Results saved to: ${RESULTS_FILE}`);
    process.exitCode = 1;
    return;
  }
  console.log('=== Deployment Complete ===');
  console.log(`SA Core: ${core.hash}`);
  console.log(`Market:  ${market.hash}`);
  console.log(`Listings: ${listings.length}/${accounts.length}`);
  console.log(`Results saved to: ${RESULTS_FILE}`);
  console.log('');
  console.log('Update frontend/.env:');
  console.log(`  VITE_SA_MARKET_HASH=${market.hash}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('FATAL:', error.message);
    process.exit(1);
  });
}

module.exports = {
  REGISTRATION_ESCAPE_TIMELOCK,
  validateVanityAccountRows,
  findVanityRegistrationIdConflicts,
  deriveRegistrationId,
  buildRegisterAccountArgs,
  parseArgs,
  setRegistrationIdDeriver,
};
