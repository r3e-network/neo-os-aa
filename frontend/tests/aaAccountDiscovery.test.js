import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { EC } from "../src/config/errorCodes.js";
import { RUNTIME_CONFIG, getRuntimeConfig } from "../src/config/runtimeConfig.js";
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

// The page size the wallet asks for: the read API's documented maximum
// (docs/api/aa-accounts.md, "limit (default 20, maximum 200)").
const AA_PAGE_LIMIT = 200;

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

// accountRows builds a newest-registration-first dataset in the shape the read
// API serves, so a walk can be checked against the exact order it must keep.
function accountRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    ...ACCOUNT_ROW,
    account_id: `0x${String(index + 1).padStart(40, "0")}`,
    registry_block_index: 100000 - index,
  }));
}

// withPagedReadApi stands in for the read API's by-owner route over a fixed
// dataset: it applies the same limit/offset window the fura handler documents
// (limit default 20, maximum 200) and answers the documented envelope, which
// carries a per-page limit/offset/count and no total. Every served window is
// recorded so a test can pin the walk the client performs.
async function withPagedReadApi(rows, run) {
  const served = [];
  await withLocalReadApi(
    (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 200);
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
      const window = rows.slice(offset, offset + limit);
      served.push({ url: req.url, limit, offset, count: window.length });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: window, paging: { limit, offset, count: window.length } }));
    },
    async ({ baseUrl }) => run({ baseUrl, served }),
  );
}

test("abstract-account discovery reads the configured NeoOS read API", () => {
  // The shared indexer base URL keeps its public default for the other
  // consumers (contract lookup, the address market scan). The discovery path
  // must not use it: with nothing configured that default silently listed
  // accounts from the public production read API.
  assert.equal(RUNTIME_CONFIG.n3IndexApiBaseUrl.length > 0, true);
  assert.equal(RUNTIME_CONFIG.aaReadApiBaseUrl, "");
  assert.equal(isAAReadApiConfigured(), false);
  const source = fs.readFileSync(path.resolve("src/services/aaAccountDiscoveryService.js"), "utf8");
  assert.doesNotMatch(
    source,
    /https?:\/\/(api\.)?n3index\.dev/,
    "the discovery service must take its host from runtime config, never hard-code the public indexer",
  );
  assert.match(source, /baseUrl = RUNTIME_CONFIG\.aaReadApiBaseUrl/);
  assert.doesNotMatch(source, /baseUrl = RUNTIME_CONFIG\.n3IndexApiBaseUrl/);
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
  assert.equal(
    buildAAAccountsByOwnerPath({
      network: "testnet",
      owner: OWNER_ADDRESS,
      contractHash: AA_CORE,
      limit: 50,
      offset: 100,
    }),
    `/indexer/v1/networks/testnet/aa/accounts?owner=${OWNER}&contract_hash=${AA_CORE}&limit=50&offset=100`,
  );
  for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }, { offset: "x" }]) {
    assert.throws(
      () => buildAAAccountsByOwnerPath({ network: "testnet", owner: OWNER, contractHash: AA_CORE, ...bad }),
      (error) => error.message === EC.addressValidationFailed,
      `${JSON.stringify(bad)} must be refused before a URL is built`,
    );
  }
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
      const url = new URL(req.url, "http://127.0.0.1");
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
      const rows = offset === 0 ? [ACCOUNT_ROW] : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: rows,
          paging: { limit: AA_PAGE_LIMIT, offset, count: rows.length },
        }),
      );
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
  assert.deepEqual(requests, [
    `/indexer/v1/networks/testnet/aa/accounts?owner=${OWNER}&contract_hash=${AA_CORE}&limit=${AA_PAGE_LIMIT}&offset=0`,
    `/indexer/v1/networks/testnet/aa/accounts?owner=${OWNER}&contract_hash=${AA_CORE}&limit=${AA_PAGE_LIMIT}&offset=${AA_PAGE_LIMIT}`,
  ]);
});

test("discovery reaches every account past the read API's default window", async () => {
  // The defect this pins: the by-owner route pages (limit default 20) and the
  // client read one page, so a wallet with 21 registered accounts saw only its
  // newest 20 and repeated discovery could never reach the omitted account.
  const rows = accountRows(21);
  await withPagedReadApi(rows, async ({ baseUrl, served }) => {
    const accounts = await discoverAAAccountsForWallet({
      address: OWNER_ADDRESS,
      baseUrl,
      network: "testnet",
      contractHash: AA_CORE,
    });
    assert.equal(accounts.length, 21, "every registered account must be reachable");
    assert.deepEqual(
      accounts.map((account) => account.accountIdHash),
      rows.map((row) => row.account_id),
      "the newest-registration-first order must survive the walk",
    );
    assert.deepEqual(
      served.map((page) => [page.offset, page.count]),
      [
        [0, 21],
        [AA_PAGE_LIMIT, 0],
      ],
      "each request must name its own window and the walk must end on an empty one",
    );
  });
});

test("paging follows the read API's limit and offset windows in order", async () => {
  const rows = accountRows(25);
  await withPagedReadApi(rows, async ({ baseUrl, served }) => {
    const accounts = await fetchAAAccountsByOwner({
      owner: OWNER,
      baseUrl,
      network: "testnet",
      contractHash: AA_CORE,
      limit: 5,
    });
    assert.equal(accounts.length, 25);
    assert.deepEqual(
      accounts.map((account) => account.accountIdHash),
      rows.map((row) => row.account_id),
    );
    assert.equal(new Set(accounts.map((account) => account.accountIdHash)).size, 25, "no account is returned twice");
    assert.deepEqual(
      served.map((page) => [page.offset, page.count]),
      [
        [0, 5],
        [5, 5],
        [10, 5],
        [15, 5],
        [20, 5],
        [25, 0],
      ],
    );
    assert.equal(served.every((page) => page.limit === 5), true);
    // The owner and contract filters stay on every page of the walk.
    for (const page of served) {
      const query = new URL(page.url, "http://127.0.0.1").searchParams;
      assert.equal(query.get("owner"), OWNER);
      assert.equal(query.get("contract_hash"), AA_CORE);
    }
  });
});

test("a page that contradicts its own window fails closed", async () => {
  const rows = accountRows(3);
  const envelopes = {
    "missing-paging": ({ window }) => ({ data: window }),
    "wrong-offset": ({ window, limit, offset }) => ({
      data: window,
      paging: { limit, offset: offset + 1, count: window.length },
    }),
    "count-mismatch": ({ window, limit, offset }) => ({
      data: window,
      paging: { limit, offset, count: window.length + 1 },
    }),
    "invalid-limit": ({ window, offset }) => ({
      data: window,
      paging: { limit: 0, offset, count: window.length },
    }),
  };
  for (const [mode, envelope] of Object.entries(envelopes)) {
    let requests = 0;
    await withLocalReadApi(
      (req, res) => {
        requests += 1;
        const url = new URL(req.url, "http://127.0.0.1");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 200);
        const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
        const window = rows.slice(offset, offset + limit);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(envelope({ window, limit, offset })));
      },
      async ({ baseUrl }) => {
        await assert.rejects(
          () =>
            fetchAAAccountsByOwner({
              owner: OWNER,
              baseUrl,
              network: "testnet",
              contractHash: AA_CORE,
              limit: 10,
            }),
          (error) => error.message === EC.rpcRequestFailed,
          `${mode} must fail closed`,
        );
        assert.equal(requests, 1, `${mode} must not be retried and must not return a partial list`);
      },
    );
  }
});

test("a page that repeats an earlier window fails closed instead of looping", async () => {
  const rows = accountRows(4);
  let requests = 0;
  await withLocalReadApi(
    (req, res) => {
      requests += 1;
      const url = new URL(req.url, "http://127.0.0.1");
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
      // A broken pager: it echoes the requested window but always answers the
      // same rows, so nothing new can ever arrive.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: rows, paging: { limit: 4, offset, count: rows.length } }));
    },
    async ({ baseUrl }) => {
      await assert.rejects(
        () =>
          fetchAAAccountsByOwner({
            owner: OWNER,
            baseUrl,
            network: "testnet",
            contractHash: AA_CORE,
            limit: 4,
          }),
        (error) => error.message === EC.rpcRequestFailed,
      );
      assert.equal(requests, 2, "the walk must stop as soon as a page repeats itself");
    },
  );
});

test("the paging walk is bounded and refuses rather than truncating", async () => {
  const rows = accountRows(12);
  await withPagedReadApi(rows, async ({ baseUrl, served }) => {
    await assert.rejects(
      () =>
        fetchAAAccountsByOwner({
          owner: OWNER,
          baseUrl,
          network: "testnet",
          contractHash: AA_CORE,
          limit: 4,
          maxPages: 2,
        }),
      (error) => error.message === EC.rpcRequestFailed,
      "a walk that cannot finish within its bound must refuse, never truncate",
    );
    assert.equal(served.length, 2);
  });
});

test("a malformed by-id answer is refused rather than returned", async () => {
  const malformed = {
    "no-data": {},
    "null-data": { data: null },
    "array-data": { data: [] },
    "non-object-data": { data: "0x14131211100f0e0d0c0b0a090807060504030201" },
    "malformed-account-id": { data: { ...ACCOUNT_ROW, account_id: "0x1234" } },
    "missing-account-id": { data: { ...ACCOUNT_ROW, account_id: undefined } },
  };
  for (const [mode, body] of Object.entries(malformed)) {
    await withLocalReadApi(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      },
      async ({ baseUrl }) => {
        await assert.rejects(
          () =>
            fetchAAAccountById({
              accountId: ACCOUNT_ID,
              baseUrl,
              network: "testnet",
              contractHash: AA_CORE,
            }),
          (error) => error.message === EC.rpcRequestFailed,
          `${mode} must surface the translated refusal, never a null account`,
        );
      },
    );
  }
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

test("the configured base URL is the origin that serves the read API under /indexer", async () => {
  // .env.example documents this: every wallet request carries the /indexer
  // prefix, so the setting must be the edge or reverse-proxy origin. Pointed at
  // a bare read-API listener, whose routes live under /v1/..., the same calls
  // are 404s and the panel reports a translated failure rather than an empty
  // "you own no accounts".
  const requests = [];
  await withLocalReadApi(
    (req, res) => {
      requests.push(req.url);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    },
    async ({ baseUrl }) => {
      await assert.rejects(
        () => fetchAAAccountsByOwner({ owner: OWNER, baseUrl, network: "testnet", contractHash: AA_CORE }),
        (error) => error.message === EC.rpcRequestFailed && error.status === 404,
      );
      await assert.rejects(
        () => fetchAAAccountById({ accountId: ACCOUNT_ID, baseUrl, network: "testnet", contractHash: AA_CORE }),
        (error) => error.message === EC.rpcRequestFailed && error.status === 404,
      );
    },
  );
  assert.equal(requests.length, 2);
  assert.equal(requests.every((url) => url.startsWith("/indexer/v1/networks/testnet/aa/accounts")), true);
});

test("discovery fails closed and contacts no host without an explicit read API setting", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    throw new Error("discovery must not reach any host without an explicit read API base URL");
  };
  await assert.rejects(
    () => discoverAAAccountsForWallet({ address: OWNER_ADDRESS, fetchImpl }),
    (error) => error.message === EC.rpcRequestFailed,
  );
  await assert.rejects(
    () => fetchAAAccountsByOwner({ owner: OWNER, network: "testnet", contractHash: AA_CORE, fetchImpl }),
    (error) => error.message === EC.rpcRequestFailed,
  );
  await assert.rejects(
    () => fetchAAAccountById({ accountId: ACCOUNT_ID, network: "testnet", contractHash: AA_CORE, fetchImpl }),
    (error) => error.message === EC.rpcRequestFailed,
  );
  assert.deepEqual(requests, []);
  assert.equal(isAAReadApiConfigured(), false);
  assert.equal(RUNTIME_CONFIG.aaReadApiBaseUrl, "");
});

test("an explicit AA read API setting is the only host discovery queries", async () => {
  const explicit = getRuntimeConfig({
    VITE_AA_N3INDEX_API_BASE_URL: "http://127.0.0.1:41295",
    VITE_N3INDEX_API_BASE_URL: "https://api.n3index.dev",
  });
  assert.equal(explicit.aaReadApiBaseUrl, "http://127.0.0.1:41295");
  // The shared key keeps its public default for the other consumers when no
  // explicit setting is present.
  assert.equal(getRuntimeConfig({}).n3IndexApiBaseUrl, "https://api.n3index.dev");
  assert.equal(getRuntimeConfig({}).aaReadApiBaseUrl, "");
  assert.equal(
    getRuntimeConfig({ VITE_N3INDEX_API_BASE_URL: "http://127.0.0.1:41296" }).aaReadApiBaseUrl,
    "http://127.0.0.1:41296",
  );

  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    const query = new URL(String(url)).searchParams;
    const offset = Number(query.get("offset") || 0);
    const limit = Number(query.get("limit") || AA_PAGE_LIMIT);
    const data = offset === 0 ? [ACCOUNT_ROW] : [];
    return { ok: true, json: async () => ({ data, paging: { limit, offset, count: data.length } }) };
  };
  const accounts = await discoverAAAccountsForWallet({
    address: OWNER_ADDRESS,
    baseUrl: explicit.aaReadApiBaseUrl,
    network: "testnet",
    contractHash: AA_CORE,
    fetchImpl,
  });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountIdHash, ACCOUNT_ID);
  assert.deepEqual(requests, [
    `http://127.0.0.1:41295/indexer/v1/networks/testnet/aa/accounts?owner=${OWNER}&contract_hash=${AA_CORE}&limit=${AA_PAGE_LIMIT}&offset=0`,
    `http://127.0.0.1:41295/indexer/v1/networks/testnet/aa/accounts?owner=${OWNER}&contract_hash=${AA_CORE}&limit=${AA_PAGE_LIMIT}&offset=${AA_PAGE_LIMIT}`,
  ]);
});

test("an empty wallet address is refused before any request", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    throw new Error("discovery must not be reached without a wallet address");
  };
  for (const address of ["", "   ", "\t\n"]) {
    await assert.rejects(
      () => discoverAAAccountsForWallet({ address, fetchImpl }),
      (error) => error.message === EC.addressValidationFailed,
      `address ${JSON.stringify(address)} must be refused`,
    );
  }
  for (const address of ["not-an-address", "0x1234", `0x${"ab".repeat(32)}`]) {
    await assert.rejects(
      () =>
        discoverAAAccountsForWallet({
          address,
          baseUrl: "http://127.0.0.1:41295",
          contractHash: AA_CORE,
          fetchImpl,
        }),
      (error) => error.message === EC.addressValidationFailed,
      `address ${JSON.stringify(address)} must be refused`,
    );
  }
  assert.deepEqual(requests, []);
});
