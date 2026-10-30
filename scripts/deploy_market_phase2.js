#!/usr/bin/env node
/**
 * Phase 2 (archival, parameterized): deploy TEEVerifier, register accounts on
 * an already-deployed AA core, and create market listings on an
 * already-deployed market.
 *
 * This was originally a one-shot follow-up to a specific phase-1 run of
 * deploy_market_and_list.js (which had deployed NeoNativeVerifier where
 * TEEVerifier was needed). The phase-1 market hash from that run remains the
 * default (the core default now tracks the canonical testnet deployment), but
 * every deployment-specific value can now be overridden:
 *
 *   AA_TESTNET_CORE_HASH    already-deployed AA core (default: canonical testnet SmartAccountV3)
 *   AA_TESTNET_MARKET_HASH  already-deployed AAAddressMarket (default: 2026-03 phase 1)
 *   MARKET_DEPLOY_TAG       manifest suffix tag for the TEEVerifier deployment
 *   MARKET_DEPLOY_WIF / NEO_TESTNET_WIF   funded deployer WIF
 *   NEON_DB_URL             Neon/Postgres connection string with aa_accounts
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
  hash160Param,
  integerParam,
  stringParam,
  byteArrayParam,
  makeSigner,
  makeCustomContractSigner,
  invokePersisted,
  deployArtifact,
  classifyPrice,
  loadAccountsFromDB,
} = require('./lib/deploy-helpers');

const { rpc, wallet } = neon;

// ── Config ──────────────────────────────────────────────────────────────────

const WIF = process.env.MARKET_DEPLOY_WIF || process.env.NEO_TESTNET_WIF || '';
const RPC_URL = 'http://seed1t5.neo.org:20332';
const NEON_DB_URL = process.env.NEON_DB_URL || '';
const TESTNET_NETWORK_MAGIC = 894710606;

// Already-deployed contracts. The core default is the canonical testnet
// SmartAccountV3 (the 2026-03 phase-1 core 0x2818ce32… is superseded);
// the market default is still the 2026-03 phase-1 deployment.
const CORE_HASH = normalizeHash(process.env.AA_TESTNET_CORE_HASH || '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2');
const MARKET_HASH = normalizeHash(process.env.AA_TESTNET_MARKET_HASH || '0x8dbd4cf6fc47afc013e7fd7128d028db2985bddf');

const DEPLOY_TAG = process.env.MARKET_DEPLOY_TAG || 'market-mneku8bc';
const ZERO_HASH160 = '0000000000000000000000000000000000000000';

const RESULTS_FILE = path.resolve(__dirname, '..', 'docs', 'reports', 'market-deployment-results.json');

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!WIF) {
    throw new Error('MARKET_DEPLOY_WIF or NEO_TESTNET_WIF is required');
  }
  if (!NEON_DB_URL) {
    throw new Error('NEON_DB_URL is required');
  }

  const account = new wallet.Account(WIF);
  const client = new rpc.RPCClient(RPC_URL);
  const version = await withRpcRetry('getVersion', () => client.getVersion());
  const networkMagic = Number(version.protocol.network);
  if (networkMagic !== TESTNET_NETWORK_MAGIC) {
    throw new Error(`RPC network magic mismatch: expected ${TESTNET_NETWORK_MAGIC}, got ${networkMagic || 'unknown'}`);
  }

  console.log('=== Phase 2: TEEVerifier + Register + List ===');
  console.log(`Deployer: ${account.address}`);
  console.log(`Core: ${CORE_HASH}`);
  console.log(`Market: ${MARKET_HASH}`);
  console.log('');

  const deployCtx = { client, account, networkMagic, rpcUrl: RPC_URL };

  // Step 1: Deploy TEEVerifier
  console.log('[1/4] Deploying TEEVerifier...');
  const teeVerifier = await deployArtifact({ ...deployCtx, baseName: 'TEEVerifier', uniqueSuffix: `${DEPLOY_TAG}-tee` });
  console.log('');

  // Step 2: Authorize the TEEVerifier to accept calls from our AA Core
  console.log('[2/4] Authorizing TEEVerifier for core...');
  await invokePersisted({
    ...deployCtx,
    contractHash: teeVerifier.hash,
    operation: 'setAuthorizedCore',
    params: [hash160Param(CORE_HASH)],
  });
  console.log('  TEEVerifier authorized');
  console.log('');

  // Step 3: Register all accounts
  console.log('[3/4] Registering vanity accounts...');
  const accounts = loadAccountsFromDB(NEON_DB_URL);
  console.log(`  Loaded ${accounts.length} accounts from DB`);

  let registered = 0;
  let failed = 0;
  for (const acct of accounts) {
    try {
      process.stdout.write(`  #${acct.id} ${acct.pattern}... `);
      await invokePersisted({
        ...deployCtx,
        contractHash: CORE_HASH,
        operation: 'registerAccount',
        params: [
          hash160Param(acct.account_id_hash),
          hash160Param(teeVerifier.hash),
          byteArrayParam(sanitizeHex(account.publicKey)),
          hash160Param(ZERO_HASH160),        // no hook
          hash160Param(account.scriptHash),   // backupOwner = our address
          integerParam(604800),               // 7 day escape timelock
        ],
        signers: [makeSigner(account.scriptHash)],
      });
      registered++;
      console.log('OK');
    } catch (err) {
      failed++;
      console.log(`FAILED: ${err.message.substring(0, 100)}`);
    }
  }
  console.log(`  Registered: ${registered}, Failed: ${failed}`);
  console.log('');

  // Step 4: Create market listings
  console.log('[4/4] Creating market listings...');
  const listings = [];
  let listOk = 0;
  let listFail = 0;

  for (const acct of accounts) {
    const price = classifyPrice(acct.pattern);
    const title = `${acct.pattern} | ${acct.address}`;
    const truncatedTitle = title.length > 80 ? title.substring(0, 77) + '...' : title;

    try {
      process.stdout.write(`  #${acct.id} ${acct.pattern} (${Number(price) / 1e8} GAS)... `);
      const result = await invokePersisted({
        ...deployCtx,
        contractHash: MARKET_HASH,
        operation: 'createListing',
        params: [
          hash160Param(CORE_HASH),
          hash160Param(acct.account_id_hash),
          integerParam(price),
          stringParam(truncatedTitle),
          stringParam(''),
        ],
        signers: [makeCustomContractSigner(account.scriptHash, [MARKET_HASH, CORE_HASH])],
      });

      listings.push({
        dbId: acct.id, pattern: acct.pattern, address: acct.address,
        accountIdHash: acct.account_id_hash, priceGas: Number(price) / 1e8, txid: result.txid,
      });
      listOk++;
      console.log('OK');
    } catch (err) {
      listFail++;
      console.log(`FAILED: ${err.message.substring(0, 100)}`);
    }
  }
  console.log(`  Listed: ${listOk}, Failed: ${listFail}`);

  // Save results
  const results = {
    timestamp: new Date().toISOString(),
    deployTag: DEPLOY_TAG,
    network: 'testnet',
    networkMagic,
    deployer: { address: account.address, scriptHash: normalizeHash(account.scriptHash) },
    contracts: {
      aaCore: { hash: CORE_HASH },
      market: { hash: MARKET_HASH },
      teeVerifier: teeVerifier,
    },
    totalAccounts: accounts.length,
    registeredCount: registered,
    totalListings: listOk,
    listings,
  };

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log('');
  console.log('=== Complete ===');
  console.log(`AA Core:     ${CORE_HASH}`);
  console.log(`Market:      ${MARKET_HASH}`);
  console.log(`TEEVerifier: ${teeVerifier.hash}`);
  console.log(`Registered:  ${registered}/${accounts.length}`);
  console.log(`Listed:      ${listOk}/${accounts.length}`);
  console.log(`Results:     ${RESULTS_FILE}`);
  console.log('');
  console.log('Frontend .env update:');
  console.log(`  VITE_AA_MARKET_HASH=${MARKET_HASH}`);
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
