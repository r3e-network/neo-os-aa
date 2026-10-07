import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { EC } from "../src/config/errorCodes.js";
import { RUNTIME_CONFIG } from "../src/config/runtimeConfig.js";
import { getScriptHashFromAddress } from "../src/utils/neo.js";
import {
  AA_ACCOUNTS_PATH_SUFFIX,
  buildAAAccountByIdPath,
  buildAAAccountsByOwnerPath,
  discoverAAAccountsForWallet,
  fetchAAAccountById,
  fetchAAAccountsByOwner,
  isAAReadApiConfigured,
  normalizeAAAccountId,
  normalizeAAOwner,
} from "../src/services/aaAccountDiscoveryService.js";

const AA_CORE = "0x1111111111111111111111111111111111111111";
const ACCOUNT_ID = "0x14131211100f0e0d0c0b0a090807060504030201";
const OWNER_ADDRESS = "NXV7ZhHiyM1aHXwpVsRZC6BwNFP2jghXAq";
// The connected wallet's address and its script hash are the same owner.
const OWNER = `0x${getScriptHashFromAddress(OWNER_ADDRESS)}`;
const OTHER_OWNER = "0x1514131211100f0e0d0c0b0a0908070605040302";
const VERIFIER = "0x161514131211100f0e0d0c0b0a09080706050403";
const HOOK_ID = "0x17161514131211100f0e0d0c0b0a090807060504";
const REGISTRY_TX = "0x5f873503cfbd113dadde69029128008f67818f71cac90140acea7ae816212b90";

// The wire shape of the read API's AA routes, recorded from the fura head's
// canonical fixture docs/api/fixtures/read-api/v1-networks-network-aa-accounts.json.
const ACCOUNT_ROW = {
  network: "testnet",
  contract_hash: AA_CORE,
  account_id: ACCOUNT_ID,
  backup_owner: OWNER,
  verifier: VERIFIER,
  hook_id: HOOK_ID,
  registry_block_index: 42,
  registry_tx_hash: REGISTRY_TX,
  registry_time_ms: 1790424000000,
};

async function withLocalReadApi(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run({ baseUrl: `http://127.0.0.1:${port}`, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("abstract-account discovery reads the configured NeoOS read API", () => {
  assert.equal(RUNTIME_CONFIG.n3IndexApiBaseUrl.length > 0, true);
  const source = fs.readFileSync(path.resolve("src/services/aaAccountDiscoveryService.js"), "utf8");
  assert.doesNotMatch(
    source,
    /https?:\/\/(api\.)?n3index\.dev/,
    "the discovery service must take its host from runtime config, never hard-code the public indexer",
  );
  assert.match(source, /n3IndexApiBaseUrl/);
});

test("owner and account id inputs are normalized or refused", () => {
  assert.equal(normalizeAAOwner(OWNER_ADDRESS), OWNER);
  assert.equal(normalizeAAOwner(OTHER_OWNER.toUpperCase().replace("0X", "0x")), OTHER_OWNER);
  assert.equal(normalizeAAOwner(OTHER_OWNER.slice(2)), OTHER_OWNER);
  assert.equal(normalizeAAAccountId(ACCOUNT_ID.slice(2)), ACCOUNT_ID);
  assert.equal(normalizeAAAccountId(ACCOUNT_ID.toUpperCase().replace("0X", "0x")), ACCOUNT_ID);
  for (const bad of ["", "   ", "not-an-address", "0x1234", `0x${"ab".repeat(32)}`]) {
    assert.throws(() => normalizeAAOwner(bad), (error) => error.message === EC.addressValidationFailed);
    assert.throws(() => normalizeAAAccountId(bad), (error) => error.message === EC.addressValidationFailed);
  }
});

test("account paths name the network, the AA core contract and the owner", () => {
  assert.equal(AA_ACCOUNTS_PATH_SUFFIX, "/aa/accounts");
  assert.equal(
    buildAAAccountsByOwnerPath({ network: "testnet", owner: OWNER_ADDRESS, contractHash: AA_CORE }),
    `/indexer/v1/networks/testnet/aa/accounts?owner=${OWNER}&contract_hash=${AA_CORE}`,
  );
  assert.equal(
    buildAAAccountsByOwnerPath({ network: "devnet", owner: OWNER, contractHash: AA_CORE.toUpperCase() }),
    `/indexer/v1/networks/mainnet/aa/accounts?owner=${OWNER}&contract_hash=${AA_CORE}`,
  );
  assert.equal(
    buildAAAccountByIdPath({ network: "testnet", accountId: ACCOUNT_ID, contractHash: AA_CORE }),
    `/indexer/v1/networks/testnet/aa/accounts/${ACCOUNT_ID}?contract_hash=${AA_CORE}`,
  );
  assert.throws(
    () => buildAAAccountsByOwnerPath({ network: "testnet", owner: OWNER, contractHash: "" }),
    (error) => error.message === EC.addressValidationFailed,
  );
});

test("the wallet lists the accounts the read API serves for its owner", async () => {
  const requests = [];
  await withLocalReadApi(
    (req, res) => {
      requests.push(req.url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [ACCOUNT_ROW], paging: { limit: 20, offset: 0, count: 1 } }));
    },
    async ({ baseUrl }) => {
      const accounts = await discoverAAAccountsForWallet({
        address: OWNER_ADDRESS,
        baseUrl,
        network: "testnet",
        contractHash: AA_CORE,
      });
      assert.equal(accounts.length, 1);
      assert.deepEqual(accounts[0], {
        accountIdHash: ACCOUNT_ID,
        backupOwner: OWNER,
        verifier: VERIFIER,
        hookId: HOOK_ID,
        registryBlockIndex: 42,
        registryTxHash: REGISTRY_TX,
        registryTimeMs: 1790424000000,
      });
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0], `/indexer/v1/networks/testnet/aa/accounts?owner=${OWNER}&contract_hash=${AA_CORE}`);
});

test("one account by id is returned from the read API", async () => {
  await withLocalReadApi(
    (req, res) => {
      assert.equal(req.url, `/indexer/v1/networks/testnet/aa/accounts/${ACCOUNT_ID}?contract_hash=${AA_CORE}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: ACCOUNT_ROW }));
    },
    async ({ baseUrl }) => {
      const account = await fetchAAAccountById({ accountId: ACCOUNT_ID, baseUrl, network: "testnet", contractHash: AA_CORE });
      assert.equal(account.accountIdHash, ACCOUNT_ID);
      assert.equal(account.backupOwner, OWNER);
    },
  );
});

test("an empty or malformed answer never becomes an account list", async () => {
  let mode = "empty";
  await withLocalReadApi(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (mode === "empty") return res.end(JSON.stringify({ data: [], paging: { limit: 20, offset: 0, count: 0 } }));
      if (mode === "not-object") return res.end(JSON.stringify({ data: ["nope"] }));
      if (mode === "missing-id") return res.end(JSON.stringify({ data: [{ backup_owner: OWNER }] }));
      return res.end("not json");
    },
    async ({ baseUrl }) => {
      const accounts = await fetchAAAccountsByOwner({ owner: OWNER, baseUrl, network: "testnet", contractHash: AA_CORE });
      assert.deepEqual(accounts, []);
      for (const bad of ["not-object", "missing-id", "not-json"]) {
        mode = bad;
        await assert.rejects(
          () => fetchAAAccountsByOwner({ owner: OWNER, baseUrl, network: "testnet", contractHash: AA_CORE }),
          (error) => error.message === EC.rpcRequestFailed,
          `${bad} must fail closed`,
        );
      }
    },
  );
});

test("read API failures surface as one translated request error", async () => {
  await withLocalReadApi(
    (req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    },
    async ({ baseUrl }) => {
      await assert.rejects(
        () => fetchAAAccountById({ accountId: ACCOUNT_ID, baseUrl, network: "testnet", contractHash: AA_CORE }),
        (error) => error.message === EC.rpcRequestFailed && error.status === 404,
      );
      await assert.rejects(
        () => fetchAAAccountsByOwner({ owner: OWNER, baseUrl, network: "testnet", contractHash: AA_CORE }),
        (error) => error.message === EC.rpcRequestFailed,
      );
    },
  );
  assert.equal(isAAReadApiConfigured({ baseUrl: "http://127.0.0.1:1", contractHash: AA_CORE }), true);
  assert.equal(isAAReadApiConfigured({ baseUrl: "", contractHash: AA_CORE }), false);
  assert.equal(isAAReadApiConfigured({ baseUrl: "http://127.0.0.1:1", contractHash: "" }), false);
  await assert.rejects(
    () => fetchAAAccountsByOwner({ owner: OWNER, baseUrl: "", network: "testnet", contractHash: AA_CORE }),
    (error) => error.message === EC.rpcRequestFailed,
  );
});
