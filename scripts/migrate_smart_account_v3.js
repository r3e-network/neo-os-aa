#!/usr/bin/env node

// Phase 1b post-upgrade migration driver (testnet first). The core V3 upgrade
// ships the service-extraction bytecode; this script walks the follow-up
// orchestration from docs/proposals/SMARTACCOUNT-V3-PLATFORM-SERVICE-EXTRACTION.md §7:
//   1. registrar deployed separately with data = reversed core hash (precondition, verified here)
//   2. --enroll-market      : core.setMarketService(market, true)
//   3. --propose-registrar  : core.proposePlatformRegistrar(registrar)  -> 7-day timelock
//      --confirm-registrar  : core.confirmPlatformRegistrar(registrar)
//   4. --migrate-rotations  : core.migratePlatformOwnerRotations(accountIds) (one-time)
// Default run is a read-only precondition audit that never writes chain.

const fs = require("fs");
const path = require("path");

const {
  neon,
  arrayParam,
  hash160Param,
  invokePersisted,
  makeSigner,
  normalizeHash,
  sanitizeHex,
  withRpcRetry,
} = require("./lib/deploy-helpers");

const { rpc, sc, wallet } = neon;

const TESTNET_MAGIC = 894710606;
const DEFAULT_RPC_URL = "https://testnet1.neo.coz.io:443";
const DEFAULT_CORE_HASH = "0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2";
const CONFIRMATION = "I_UNDERSTAND_THIS_WRITES_CHAIN";
// Post-upgrade surface the migration phases drive. A live core missing any of
// these has not landed the Phase 1b candidate yet, so every phase fails closed.
const REQUIRED_MIGRATION_METHODS = [
  "setMarketService",
  "isMarketService",
  "migratePlatformOwnerRotations",
  "getPlatformRegistrar",
  "getPendingPlatformRegistrar",
  "getPlatformRegistrarAvailableAt",
  "proposePlatformRegistrar",
  "confirmPlatformRegistrar",
  "getPlatformAccountBinding",
];
// migratePlatformOwnerRotations takes a UInt160[]; batch the array so a single
// invocation stays well inside block gas limits.
const DEFAULT_BATCH_SIZE = 50;

function migrationPhases() {
  return [
    { flag: "--verify", action: "read-only precondition audit", writes: false },
    { flag: "--enroll-market", action: "setMarketService(market, true)", writes: true },
    { flag: "--propose-registrar", action: "proposePlatformRegistrar(registrar)", writes: true },
    { flag: "--confirm-registrar", action: "confirmPlatformRegistrar(registrar) after the 7-day timelock", writes: true },
    { flag: "--migrate-rotations", action: "migratePlatformOwnerRotations(accountIds) batches", writes: true },
  ];
}

function parseAccountIds(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("no account ids provided: pass --accounts 0x...,0x... or AA_MIGRATION_ACCOUNTS_FILE");
  const ids = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const normalized = normalizeHash(token);
      if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
        throw new Error(`account id is not a 20-byte script hash: ${token}`);
      }
      return normalized;
    });
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`duplicate account ids would migrate the same legacy row twice: ${[...new Set(duplicates)].join(", ")}`);
  }
  return ids;
}

function chunkAccountIds(ids, size = DEFAULT_BATCH_SIZE) {
  if (!Number.isInteger(size) || size <= 0) throw new Error("batch size must be a positive integer");
  const batches = [];
  for (let index = 0; index < ids.length; index += size) batches.push(ids.slice(index, index + size));
  return batches;
}

function accountIdsParam(ids) {
  return arrayParam(...ids.map((id) => hash160Param(id)));
}

// The registrar is deployed with data = the core script hash in VM byte order
// (little-endian), i.e. the reversed display spelling — the same convention as
// every needs_core deployment in scripts/neoexpress_validate.py.
function registrarDeployDataHex(coreHash) {
  return Buffer.from(sanitizeHex(normalizeHash(coreHash)), "hex").reverse().toString("hex");
}

function isHalt(result) {
  return /HALT/i.test(String(result?.state || result?.vmstate || ""));
}

function stackValue(result) {
  return result?.stack?.[0]?.value ?? null;
}

function liveMethodNames(state) {
  return new Set((state?.manifest?.abi?.methods || []).map((method) => method.name));
}

function assertLiveMigrationSurface(state) {
  const methods = liveMethodNames(state);
  if (!methods.has("update")) throw new Error("live AA core does not expose update");
  return REQUIRED_MIGRATION_METHODS.filter((method) => methods.has(method));
}

async function readState(client, coreHash) {
  return withRpcRetry("getContractState SmartAccountV3", () => client.getContractState(sanitizeHex(coreHash)));
}

async function readNetwork(client) {
  const version = await withRpcRetry("getVersion", () => client.getVersion());
  const magic = Number(version?.protocol?.network);
  if (magic !== TESTNET_MAGIC) {
    throw new Error(`RPC network magic mismatch: expected ${TESTNET_MAGIC}, got ${magic}`);
  }
  return magic;
}

function normalizeSignerInput(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("AA_TESTNET_UPDATE_SIGNER is required for a dry-run");
  if (wallet.isAddress(input)) return normalizeHash(wallet.getScriptHashFromAddress(input));
  const candidate = normalizeHash(input);
  if (!/^0x[0-9a-f]{40}$/.test(candidate)) {
    throw new Error("AA_TESTNET_UPDATE_SIGNER must be a Neo address or 20-byte script hash");
  }
  return candidate;
}

function requiredHashEnv(name) {
  const value = normalizeHash(process.env[name] || "");
  if (!/^0x[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte script hash (0x-prefixed hex)`);
  }
  return value;
}

function writeReport(report) {
  const reportPath = path.resolve(
    process.env.AA_TESTNET_MIGRATION_REPORT_PATH ||
      path.resolve(__dirname, "..", "docs", "reports", "testnet-smart-account-migration-latest.json"),
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function invokeRead(client, contractHash, method, params = []) {
  return withRpcRetry(`${method} readback`, () =>
    client.invokeFunction(sanitizeHex(contractHash), method, params),
  );
}

async function main() {
  const execute = process.argv.includes("--execute");
  const enrollMarket = process.argv.includes("--enroll-market");
  const proposeRegistrar = process.argv.includes("--propose-registrar");
  const confirmRegistrar = process.argv.includes("--confirm-registrar");
  const migrateRotations = process.argv.includes("--migrate-rotations");
  const writePhases = [enrollMarket, proposeRegistrar, confirmRegistrar, migrateRotations].filter(Boolean);
  if (writePhases.length > 1) {
    throw new Error("run one migration phase per invocation (timelock and witness gating are per phase)");
  }

  const coreHash = normalizeHash(process.env.AA_TESTNET_CORE_HASH || DEFAULT_CORE_HASH);
  const rpcUrl = process.env.AA_TESTNET_RPC_URL || process.env.NEO_TESTNET_RPC_URL || DEFAULT_RPC_URL;
  const wif = process.env.AA_TESTNET_UPDATE_WIF || process.env.NEO_TESTNET_WIF || process.env.TEST_WIF || "";
  const client = new rpc.RPCClient(rpcUrl);
  const networkMagic = await readNetwork(client);
  const state = await readState(client, coreHash);
  const present = assertLiveMigrationSurface(state);
  const missing = REQUIRED_MIGRATION_METHODS.filter((method) => !present.includes(method));
  if (missing.length > 0) {
    throw new Error(`live AA core has not landed the Phase 1b candidate; missing: ${missing.join(", ")}`);
  }

  const signerHash = normalizeSignerInput(
    process.env.AA_TESTNET_UPDATE_SIGNER || process.env.AA_TESTNET_DRY_RUN_SIGNER,
  );
  const report = {
    network: "testnet",
    network_magic: networkMagic,
    rpc_url: rpcUrl,
    core_hash: coreHash,
    signer_hash: signerHash,
    execute_requested: execute,
    phase_requested: enrollMarket ? "enroll-market" : proposeRegistrar ? "propose-registrar"
      : confirmRegistrar ? "confirm-registrar" : migrateRotations ? "migrate-rotations" : "verify",
    chain_writes_performed: false,
    preconditions: {
      required_migration_methods: REQUIRED_MIGRATION_METHODS,
      registrar_deploy_data_hex: registrarDeployDataHex(coreHash),
    },
    generated_at_utc: new Date().toISOString(),
  };

  const registrarHash = proposeRegistrar || confirmRegistrar ? requiredHashEnv("AA_TESTNET_REGISTRAR_HASH") : null;
  const marketHash = enrollMarket ? requiredHashEnv("AA_TESTNET_MARKET_HASH") : null;

  // Registrar authority precondition: the deployed registrar must already be
  // bound to this core (deployed with data = reversed core hash).
  if (registrarHash) {
    const authorized = await invokeRead(client, registrarHash, "authorizedCore");
    if (!isHalt(authorized)) throw new Error("registrar authorizedCore readback FAULT");
    const authorizedHash = String(stackValue(authorized) || "");
    const expected = Buffer.from(sanitizeHex(coreHash), "hex").reverse().toString("base64");
    if (authorizedHash !== expected) {
      throw new Error(`registrar ${registrarHash} is not bound to core ${coreHash}; redeploy with data = reversed core hash`);
    }
    report.preconditions.registrar_authorized_core = coreHash;
  }

  let operation = null;
  let params = null;
  let batches = null;
  if (enrollMarket) {
    operation = "setMarketService";
    params = [hash160Param(marketHash), sc.ContractParam.boolean(true)];
  } else if (proposeRegistrar) {
    operation = "proposePlatformRegistrar";
    params = [hash160Param(registrarHash)];
  } else if (confirmRegistrar) {
    const available = await invokeRead(client, coreHash, "getPlatformRegistrarAvailableAt");
    if (!isHalt(available)) throw new Error("getPlatformRegistrarAvailableAt readback FAULT");
    const availableAt = Number(stackValue(available) || 0);
    const now = Date.now();
    if (availableAt > now) {
      throw new Error(`registrar confirmation timelock not expired: available at ${availableAt}, now ${now}`);
    }
    operation = "confirmPlatformRegistrar";
    params = [hash160Param(registrarHash)];
  } else if (migrateRotations) {
    const accountsFile = process.env.AA_MIGRATION_ACCOUNTS_FILE;
    const ids = parseAccountIds(
      accountsFile ? fs.readFileSync(path.resolve(accountsFile), "utf8") : argumentValue("--accounts"),
    );
    batches = chunkAccountIds(ids);
    report.migration = { account_count: ids.length, batch_size: batches[0]?.length ?? 0, batch_count: batches.length };
  }

  if (operation) {
    const preview = await withRpcRetry(`SmartAccountV3.${operation} preview`, () =>
      client.invokeFunction(sanitizeHex(coreHash), operation, params, [makeSigner(signerHash)]),
    );
    if (!isHalt(preview)) {
      throw new Error(`SmartAccountV3.${operation} preview FAULT: ${preview?.exception || "unknown error"}`);
    }
    report.preview = { state: preview.state || preview.vmstate || null, gas_consumed: preview.gasconsumed || preview.gas_consumed || null };
  }

  if (execute) {
    if (process.env.CONFIRM_AA_TESTNET_MIGRATION !== CONFIRMATION) {
      throw new Error(`set CONFIRM_AA_TESTNET_MIGRATION=${CONFIRMATION} to write chain`);
    }
    if (!wif) throw new Error("AA_TESTNET_UPDATE_WIF, NEO_TESTNET_WIF, or TEST_WIF is required for --execute");
    const account = new wallet.Account(wif);
    const actualSignerHash = normalizeHash(account.scriptHash);
    if (actualSignerHash !== signerHash) {
      throw new Error(`signer mismatch: configured ${signerHash}, WIF resolves to ${actualSignerHash}`);
    }
    const runOne = async (name, callParams) =>
      invokePersisted({
        client,
        account,
        networkMagic,
        rpcUrl,
        contractHash: coreHash,
        operation: name,
        params: callParams,
        onBroadcast: (txid) => {
          report.chain_writes_performed = true;
          report.transaction = { txid };
          report.broadcast_status = "submitted_awaiting_confirmation";
          writeReport(report);
        },
      });
    if (operation && !batches) {
      await runOne(operation, params);
    } else if (batches) {
      for (const [index, batch] of batches.entries()) {
        await runOne("migratePlatformOwnerRotations", [accountIdsParam(batch)]);
        report.migration.completed_batches = index + 1;
      }
    }
    report.chain_writes_performed = true;
    report.broadcast_status = "confirmed_halt";

    // Post-conditions, read back through safe entries.
    if (enrollMarket) {
      const enrolled = await invokeRead(client, coreHash, "isMarketService", [hash160Param(marketHash)]);
      if (!isHalt(enrolled) || String(stackValue(enrolled)).toLowerCase() !== "true") {
        throw new Error(`post-enroll isMarketService(${marketHash}) did not read back true`);
      }
      report.post_conditions = { market_enrolled: marketHash };
    }
    if (confirmRegistrar) {
      const bound = await invokeRead(client, coreHash, "getPlatformRegistrar");
      const boundHash = stackValue(bound);
      const expectedRegistrar = Buffer.from(sanitizeHex(registrarHash), "hex").reverse().toString("base64");
      if (!isHalt(bound) || String(boundHash || "") !== expectedRegistrar) {
        throw new Error(`post-confirm getPlatformRegistrar did not read back ${registrarHash}`);
      }
      report.post_conditions = { platform_registrar: registrarHash };
    }
    if (migrateRotations) {
      report.post_conditions = { rotations_migrated: report.migration.account_count };
      report.next_action = "verify each account via registrar getPendingPlatformOwnerRotation; the legacy 0x20 rows are gone";
    }
  } else if (operation || batches) {
    report.next_action = "preview only; pass --execute with the admin witness to write chain";
  } else {
    report.next_action = "preconditions audited; run --enroll-market, then --propose-registrar, wait 7 days, --confirm-registrar, then --migrate-rotations";
  }

  const reportPath = writeReport(report);
  console.log(JSON.stringify({ ...report, report_path: reportPath }, null, 2));
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : "";
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  REQUIRED_MIGRATION_METHODS,
  accountIdsParam,
  assertLiveMigrationSurface,
  chunkAccountIds,
  migrationPhases,
  parseAccountIds,
  registrarDeployDataHex,
};
