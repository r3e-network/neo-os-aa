#!/usr/bin/env node
/**
 * Deploy AAAddressMarket to testnet and list all 55 vanity accounts for sale.
 *
 * Sequence:
 *   1. Deploy new AA Core (with market escrow methods)
 *   2. Deploy AAAddressMarket
 *   3. Deploy NeoNativeVerifier (minimal verifier for account registration)
 *   4. Register all 55 accounts on-chain
 *   5. Create market listings for each account
 *
 * Usage:
 *   node scripts/deploy_market_and_list.js
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
  classifyPrice,
  loadAccountsFromDB,
} = require('./lib/deploy-helpers');

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

const RESULTS_FILE = path.resolve(__dirname, '..', 'docs', 'reports', 'market-deployment-results.json');

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

  console.log('=== AA Address Market Deployment ===');
  console.log(`Deployer: ${account.address} (${normalizeHash(account.scriptHash)})`);
  console.log(`RPC: ${RPC_URLS[0]}`);
  console.log(`Network Magic: ${networkMagic}`);
  console.log(`Deploy Tag: ${DEPLOY_TAG}`);
  console.log('');

  const deployCtx = { client, account, networkMagic, rpcUrl: RPC_URLS[0] };

  // Step 1: Deploy contracts
  console.log('[1/5] Deploying AA Core (with market escrow)...');
  const core = await deployArtifact({ ...deployCtx, baseName: 'SmartAccountV3', uniqueSuffix: `${DEPLOY_TAG}-core` });
  console.log(`  AA Core deployed: ${core.hash}`);
  console.log('');

  console.log('[2/5] Deploying AAAddressMarket...');
  const market = await deployArtifact({ ...deployCtx, baseName: 'AAAddressMarket', uniqueSuffix: `${DEPLOY_TAG}-market` });
  console.log(`  Market deployed: ${market.hash}`);
  console.log('');

  console.log('[3/5] Deploying NeoNativeVerifier...');
  const verifier = await deployArtifact({ ...deployCtx, baseName: 'NeoNativeVerifier', uniqueSuffix: `${DEPLOY_TAG}-verifier` });
  console.log(`  Verifier deployed: ${verifier.hash}`);
  console.log('');

  // Step 2: Load accounts from DB
  console.log('[4/5] Registering 55 vanity accounts on-chain...');
  const accounts = loadAccountsFromDB(NEON_DB_URL);
  console.log(`  Loaded ${accounts.length} accounts from Neon DB`);

  // Register accounts in batches (multi-invoke to avoid nonce conflicts)
  const BATCH_SIZE = 5;
  for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
    const batch = accounts.slice(i, i + BATCH_SIZE);
    const batchLabel = `Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(accounts.length / BATCH_SIZE)}`;
    console.log(`  ${batchLabel}: registering accounts ${batch[0].id}-${batch[batch.length - 1].id}...`);

    const calls = batch.map((acct) => ({
      scriptHash: core.hash,
      operation: 'registerAccount',
      args: [
        hash160Param(acct.account_id_hash),
        hash160Param(verifier.hash),
        byteArrayParam(sanitizeHex(account.publicKey)),
        hash160Param(ZERO_HASH160),
        hash160Param(account.scriptHash),
        integerParam(604800),
      ],
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
            params: [
              hash160Param(acct.account_id_hash),
              hash160Param(verifier.hash),
              byteArrayParam(sanitizeHex(account.publicKey)),
              hash160Param(ZERO_HASH160),
              hash160Param(account.scriptHash),
              integerParam(604800),
            ],
            signers: [makeSigner(account.scriptHash)],
          });
          console.log(`    Account ${acct.id}: OK`);
        } catch (retryErr) {
          console.error(`    Account ${acct.id}: FAILED - ${retryErr.message}`);
        }
      }
    }
  }
  console.log('');

  // Step 3: Create market listings
  console.log('[5/5] Creating market listings for all accounts...');
  const listings = [];

  for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
    const batch = accounts.slice(i, i + BATCH_SIZE);
    const batchLabel = `Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(accounts.length / BATCH_SIZE)}`;
    console.log(`  ${batchLabel}: listing accounts ${batch[0].id}-${batch[batch.length - 1].id}...`);

    // Listings must be done one-by-one because createListing allocates sequential IDs
    // and the market escrow call needs CalledByEntry witness scope from the seller
    // through the market contract into the core. Use CustomContracts scope.
    for (const acct of batch) {
      const price = classifyPrice(acct.pattern);
      const title = `${acct.pattern} | ${acct.address}`;
      const truncatedTitle = title.length > 80 ? title.substring(0, 77) + '...' : title;

      try {
        const result = await invokePersisted({
          ...deployCtx,
          contractHash: market.hash,
          operation: 'createListing',
          params: [
            hash160Param(core.hash),
            hash160Param(acct.account_id_hash),
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
          address: acct.address,
          accountIdHash: acct.account_id_hash,
          priceGas,
          txid: result.txid,
        });
        console.log(`    #${acct.id} ${acct.pattern} (${priceGas} GAS): OK`);
      } catch (err) {
        console.error(`    #${acct.id} ${acct.pattern}: FAILED - ${err.message}`);
      }
    }
  }

  // Save results
  const results = {
    timestamp: new Date().toISOString(),
    deployTag: DEPLOY_TAG,
    network: 'testnet',
    networkMagic,
    deployer: { address: account.address, scriptHash: normalizeHash(account.scriptHash) },
    contracts: {
      aaCore: core,
      market: market,
      verifier: verifier,
    },
    totalAccounts: accounts.length,
    totalListings: listings.length,
    listings,
  };

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log('');
  console.log('=== Deployment Complete ===');
  console.log(`AA Core: ${core.hash}`);
  console.log(`Market:  ${market.hash}`);
  console.log(`Verifier: ${verifier.hash}`);
  console.log(`Listings: ${listings.length}/${accounts.length}`);
  console.log(`Results saved to: ${RESULTS_FILE}`);
  console.log('');
  console.log('Update frontend/.env:');
  console.log(`  VITE_AA_MARKET_HASH=${market.hash}`);
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
