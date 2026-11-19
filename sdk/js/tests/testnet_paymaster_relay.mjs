#!/usr/bin/env node

/**
 * v4 relay runbook: `executeUserOp` submitted through the relay with paymaster
 * pre-authorization.
 *
 * v3 relayed a six-field user operation to a pre-deployed core, bootstrapped the
 * account with `registerAccount`, and signed typed data whose operation payload
 * ended at the deadline. Protocol v4 has none of that: an account is created
 * from custody plus salt, the verifier is a module instance installed by action,
 * and the operation is the 13-field array whose field 11 signature covers a
 * channel nonce, the routing ids and the §4.3 digest.
 *
 * This runbook therefore:
 *
 *   1. deploys its own v4 core and Web3AuthValidator and binds them together,
 *      so the relay target exists without depending on a public v4 deployment;
 *   2. creates (or, when the salt and key are reused, adopts) a validator-routed
 *      account and checks the installed key is the one this run signs with;
 *   3. asks the paymaster to authorize the exact relayed operation — the relay
 *      derives the downstream target/method from the v4 operation layout, so an
 *      incorrect derivation is refused by the paymaster policy instead of being
 *      relayed blindly;
 *   4. submits the operation through `frontend/api/relay-transaction.js` and
 *      proves the relayed transaction HALTs and returns the GAS symbol;
 *   5. proves the relay still refuses an operation outside the deployed core's
 *      ABI (no fee is spent on that refusal).
 *
 * Environment:
 *   TEST_WIF | NEO_TESTNET_WIF          relay signer (required)
 *   MORPHEUS_RUNTIME_TOKEN | PHALA_API_TOKEN | PHALA_SHARED_SECRET
 *                                       paymaster bearer token (required)
 *   MORPHEUS_PAYMASTER_APP_ID           dapp id the paymaster allowlists
 *   MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH
 *                                       local authorize handler; when present the
 *                                       account/target allowlist is applied per
 *                                       request instead of on the remote worker
 *   PAYMASTER_ACCOUNT_ID                optional; when set the derived account
 *                                       must match it, because a remote policy is
 *                                       already pinned to that id
 *   SKIP_PAYMASTER_ALLOWLIST_UPDATE=1   keep the local handler's own allowlist
 *                                       instead of re-scoping it to this run
 *   SA_RELAY_EVM_PRIVATE_KEY            optional secp256k1 key of the validator
 *   SA_RELAY_ACCOUNT_SALT               optional 20-byte hex salt
 *
 * A runbook, not a gate: `npm test` does not run it, and the v4 core is not
 * deployed to a public testnet yet.
 */

import http from "node:http";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import paymasterRuntimeConfig from "./paymaster-runtime-config.js";
import localPaymasterHandlerHelpers from "./local-paymaster-handler.js";

const require = createRequire(import.meta.url);
const { ethers } = require("ethers");
const { CONST: neonConst } = require("@cityofzion/neon-js");
const h = require("./testnet-v4-harness.js");

const { resolveLocalPaymasterHandlerPath } = localPaymasterHandlerHelpers;
const { resolvePaymasterAuthorizeEndpoint } = paymasterRuntimeConfig;

const relayModule = await import("../../../frontend/api/relay-transaction.js");
const relayHandler = relayModule.default;

const TEST_WIF = process.env.TEST_WIF || process.env.NEO_TESTNET_WIF || "";
const PAYMASTER_APP_ID = process.env.MORPHEUS_PAYMASTER_APP_ID || "ddff154546fe22d15b65667156dd4b7c611e6093";
const PAYMASTER_DAPP_ID = String(process.env.MORPHEUS_PAYMASTER_DAPP_ID || PAYMASTER_APP_ID).trim();
const PAYMASTER_API_TOKEN =
  process.env.MORPHEUS_RUNTIME_TOKEN
  || process.env.PHALA_API_TOKEN
  || process.env.PHALA_SHARED_SECRET
  || "";
const PAYMASTER_ENDPOINT = resolvePaymasterAuthorizeEndpoint(process.env);
const LOCAL_PAYMASTER_HANDLER_PATH = resolveLocalPaymasterHandlerPath();
const EXPLICIT_PAYMASTER_ACCOUNT_ID = (process.env.PAYMASTER_ACCOUNT_ID || "").trim();
// A remote policy may already allow the derived account, in which case the local
// handler must not be re-scoped per request. Default: re-scope whenever the
// runbook serves the local handler, since a fresh deployment derives a new id.
const SKIP_PAYMASTER_ALLOWLIST_UPDATE = process.env.SKIP_PAYMASTER_ALLOWLIST_UPDATE === "1";
const EVM_PRIVATE_KEY = String(process.env.SA_RELAY_EVM_PRIVATE_KEY || "").trim();
const ACCOUNT_SALT = String(process.env.SA_RELAY_ACCOUNT_SALT || "").trim();
const GAS_HASH = neonConst.NATIVE_CONTRACT_HASH.GasToken;
const LOCAL_PAYMASTER_SIGNER_ENV_KEYS = [
  "NEO_TESTNET_WIF",
  "NEO_N3_WIF",
  "PHALA_NEO_N3_WIF",
  "PHALA_NEO_N3_PRIVATE_KEY",
  "PHALA_NEO_N3_WIF_TESTNET",
  "PHALA_NEO_N3_PRIVATE_KEY_TESTNET",
  "MORPHEUS_RELAYER_NEO_N3_WIF",
  "MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY",
  "MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET",
  "MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET",
  "MORPHEUS_UPDATER_NEO_N3_WIF",
  "MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY",
  "MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET",
  "MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET",
  "MORPHEUS_ORACLE_VERIFIER_WIF",
  "MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY",
  "MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET",
  "MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET",
  "PHALA_ORACLE_VERIFIER_WIF",
  "PHALA_ORACLE_VERIFIER_PRIVATE_KEY",
  "PHALA_ORACLE_VERIFIER_WIF_TESTNET",
  "PHALA_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET",
];
const LOCAL_PAYMASTER_RUNTIME_ENV_KEYS = [
  "PHALA_API_TOKEN",
  "MORPHEUS_RUNTIME_TOKEN",
  "PHALA_SHARED_SECRET",
];

if (!TEST_WIF) {
  console.error("TEST_WIF or NEO_TESTNET_WIF is required.");
  process.exit(1);
}

if (!PAYMASTER_API_TOKEN) {
  console.error("MORPHEUS_RUNTIME_TOKEN, PHALA_API_TOKEN, or PHALA_SHARED_SECRET is required.");
  process.exit(1);
}

if (!LOCAL_PAYMASTER_HANDLER_PATH && !PAYMASTER_ENDPOINT) {
  console.error("No paymaster authorize endpoint: set MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH or MORPHEUS_PAYMASTER_TESTNET_ENDPOINT.");
  process.exit(1);
}

function normalizeHash(value) {
  return h.normalizeHash(value);
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

/** A canonical VM value as the relay's parameter DTO. */
function relayParam(value) {
  switch (value?.type) {
    case "Null":
      return { type: "Any", value: null };
    case "Boolean":
      return { type: "Boolean", value: value.value };
    case "Integer":
      return { type: "Integer", value: String(value.value) };
    case "ByteString":
      return { type: "ByteArray", value: `0x${value.value}` };
    case "Array":
      return { type: "Array", value: value.value.map(relayParam) };
    default:
      throw new Error(`unsupported VM type ${value?.type}`);
  }
}

/**
 * The signed operation as the relay transports it. The codec builds the
 * canonical array — including field 11 — so the relay publishes the same bytes
 * the validator signed.
 */
function operationParamJson(op) {
  return relayParam(h.codec.operationValue(op));
}

function buildLocalPaymasterOverrides(accountId, coreHash) {
  return {
    MORPHEUS_PAYMASTER_TESTNET_ENABLED: "true",
    MORPHEUS_PAYMASTER_TESTNET_POLICY_ID: "testnet-sa",
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS: PAYMASTER_DAPP_ID,
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS: normalizeHash(accountId).toLowerCase(),
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS: normalizeHash(coreHash).toLowerCase(),
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS: "executeUserOp,executeSponsoredUserOp",
    MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS: String(process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS || 5_000_000),
  };
}

async function callRemotePaymaster(payload, { allowlistAccountId = null, coreHash = "" } = {}) {
  if (LOCAL_PAYMASTER_HANDLER_PATH) {
    const snapshot = new Map();
    const overrides = allowlistAccountId && !SKIP_PAYMASTER_ALLOWLIST_UPDATE
      ? buildLocalPaymasterOverrides(allowlistAccountId, coreHash)
      : null;
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        snapshot.set(key, process.env[key]);
        process.env[key] = value;
      }
    }
    for (const key of LOCAL_PAYMASTER_SIGNER_ENV_KEYS) {
      if (!snapshot.has(key)) snapshot.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const key of LOCAL_PAYMASTER_RUNTIME_ENV_KEYS) {
      if (!snapshot.has(key)) snapshot.set(key, process.env[key]);
    }
    try {
      process.env.PHALA_API_TOKEN = process.env.PHALA_API_TOKEN || process.env.MORPHEUS_RUNTIME_TOKEN || process.env.PHALA_SHARED_SECRET || "";
      const { default: handler } = await import(pathToFileURL(LOCAL_PAYMASTER_HANDLER_PATH).href);
      const request = new Request("http://local/paymaster/authorize", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PAYMASTER_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const response = await handler(request);
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    } finally {
      for (const [key, value] of snapshot.entries()) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const response = await fetch(PAYMASTER_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PAYMASTER_API_TOKEN}`,
      "x-phala-token": PAYMASTER_API_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function startPaymasterProxy({ accountId, coreHash }) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (!["/paymaster", "/paymaster/authorize"].includes(req.url)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    try {
      const remote = await callRemotePaymaster(body, { allowlistAccountId: accountId, coreHash });
      res.writeHead(Number(remote.status || 200), { "content-type": "application/json" });
      res.end(JSON.stringify(remote.body || {}));
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}/paymaster/authorize`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** The v4 account: created on first run, adopted when salt and key are reused. */
async function ensureAccount(chain, sdk, { salt, evmPubKey, web3Auth }) {
  const identity = sdk.deriveIdentity({ custodyAddress: chain.account.scriptHash, salt });
  let state = null;
  try {
    state = await sdk.getAccount(identity.accountId);
  } catch (_) {
    state = null;
  }

  if (!state) {
    const install = await h.installActionFor(chain, {
      moduleType: h.VALIDATOR_MODULE_TYPE,
      moduleHash: web3Auth.hash,
      initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(evmPubKey)],
    });
    const created = await h.createAccount(chain, sdk, { custody: chain.account, salt, actions: [install] });
    return { ...created, created: true };
  }

  const modules = await h.moduleIds(sdk, identity.accountId, h.VALIDATOR_MODULE_TYPE);
  if (modules.moduleIds.length === 0) {
    throw new Error(`account ${normalizeHash(identity.accountId)} exists but carries no validator; use another salt`);
  }
  const stored = Buffer.from(
    (await h.readAndDecode(chain, web3Auth.hash, "getPublicKey", [
      h.hash160Param(identity.accountId),
      h.integerParam(modules.moduleIds[0]),
    ])).value || "",
    "base64",
  ).toString("hex");
  if (stored.toUpperCase() !== evmPubKey.toUpperCase()) {
    throw new Error(`account ${normalizeHash(identity.accountId)} already holds another validator key; use another salt or SA_RELAY_EVM_PRIVATE_KEY`);
  }
  return { ...identity, txid: null, created: false };
}

async function main() {
  const chain = await h.connect({ wif: TEST_WIF });
  const relayAccount = chain.account;
  const evmSigner = EVM_PRIVATE_KEY ? new ethers.Wallet(EVM_PRIVATE_KEY) : ethers.Wallet.createRandom();
  const evmPubKey = h.sanitizeHex(evmSigner.signingKey.compressedPublicKey);
  const salt = ACCOUNT_SALT || randomBytes(20).toString("hex");
  if (!/^[0-9a-f]{40}$/i.test(salt)) throw new Error("SA_RELAY_ACCOUNT_SALT must be 20 bytes of hex");

  console.log(JSON.stringify({
    rpc: chain.rpcUrl,
    networkMagic: chain.networkMagic,
    relayAddress: relayAccount.address,
    relayScriptHash: normalizeHash(relayAccount.scriptHash),
    accountSalt: salt,
    evmAddress: evmSigner.address,
    verifierPubKey: evmPubKey,
  }, null, 2));

  // -------------------------------------------------------------------------
  // 1. Deploy the v4 core and the validator module.
  // -------------------------------------------------------------------------

  h.logSection("1. Deploy core and Web3AuthValidator");
  const core = await h.deployCore(chain);
  const web3Auth = await h.deployModule(chain, core.hash, "validators/Web3AuthValidator");
  const sdk = h.clientFor(chain, core.hash);
  const protocol = await sdk.getProtocolInfo();
  if (protocol.protocolVersion !== "4") throw new Error(`core reports protocol ${protocol.protocolVersion}, expected 4`);
  console.log(JSON.stringify({ core, web3Auth, protocol }, null, 2));

  // -------------------------------------------------------------------------
  // 2. The account the relayed operation addresses.
  // -------------------------------------------------------------------------

  h.logSection("2. Create or adopt the validator-routed account");
  const account = await ensureAccount(chain, sdk, { salt, evmPubKey, web3Auth });
  const accountId = account.accountId;
  const state = await sdk.getAccount(accountId);
  const validatorModules = await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE);
  const validatorId = validatorModules.moduleIds[0];
  const validatorRecord = await h.moduleState(sdk, accountId, validatorId);
  console.log(JSON.stringify({
    accountId: normalizeHash(accountId),
    virtualAddress: account.accountAddress,
    created: account.created,
    createTxid: account.txid,
    validatorId,
    credentialGeneration: validatorRecord.credentialGeneration,
    defaultOperationAuthorization: state.defaultOperationAuthorization,
  }, null, 2));

  if (EXPLICIT_PAYMASTER_ACCOUNT_ID && EXPLICIT_PAYMASTER_ACCOUNT_ID.toLowerCase() !== normalizeHash(accountId).toLowerCase()) {
    console.warn(
      `PAYMASTER_ACCOUNT_ID ${EXPLICIT_PAYMASTER_ACCOUNT_ID} differs from the derived account ${normalizeHash(accountId)}; a remote policy pinned to the former will deny this run.`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. The signed operation and the paymaster pre-authorization it implies.
  // -------------------------------------------------------------------------

  h.logSection("3. Sign the operation and ask the paymaster");
  const routing = {
    validatorId: String(validatorId),
    credentialGeneration: validatorRecord.credentialGeneration,
    authorityEpoch: state.authorityEpoch,
    nonceSubkey: "00".repeat(32),
  };
  const nonce = await h.nextNonce(sdk, accountId, routing);
  const op = h.operation({
    targetContract: GAS_HASH,
    method: "symbol",
    nonce,
    validatorId: validatorId,
    credentialGeneration: validatorRecord.credentialGeneration,
    authorityEpoch: state.authorityEpoch,
  });
  const argsHashHex = await h.operationArgsHash(chain, core.hash, op.args);
  const signedOp = await h.signOperationForWeb3Auth(chain, core.hash, {
    validatorHash: web3Auth.hash,
    accountId,
    operation: op,
    argsHashHex,
    signer: evmSigner,
  });

  const paymasterPolicy = await callRemotePaymaster({
    network: "testnet",
    target_chain: "neo_n3",
    account_id: normalizeHash(accountId),
    dapp_id: PAYMASTER_DAPP_ID,
    target_contract: normalizeHash(core.hash),
    method: "executeUserOp",
    userop_target_contract: normalizeHash(GAS_HASH),
    userop_method: "symbol",
    estimated_gas_units: 2_000_000,
    operation_hash: `0x${randomBytes(32).toString("hex")}`,
  }, { allowlistAccountId: accountId, coreHash: core.hash });
  if (Number(paymasterPolicy?.status) !== 200 || paymasterPolicy?.body?.approved !== true) {
    throw new Error(`paymaster did not authorize the operation: ${JSON.stringify(paymasterPolicy, null, 2)}`);
  }
  console.log(JSON.stringify({
    policyId: paymasterPolicy.body.policy_id || null,
    approvalDigest: paymasterPolicy.body.approval_digest || null,
    allowAccounts: paymasterPolicy.body.policy?.allow_accounts || [],
  }, null, 2));

  // -------------------------------------------------------------------------
  // 4. Relay the operation.
  // -------------------------------------------------------------------------

  h.logSection("4. Relay executeUserOp");
  const paymasterProxy = await startPaymasterProxy({ accountId, coreHash: core.hash });
  const metaInvocation = {
    scriptHash: normalizeHash(core.hash),
    operation: "executeUserOp",
    args: [
      { type: "Hash160", value: normalizeHash(accountId) },
      operationParamJson(signedOp),
    ],
  };

  const snapshot = {
    SA_RELAY_RPC_URL: process.env.SA_RELAY_RPC_URL,
    SA_RELAY_WIF: process.env.SA_RELAY_WIF,
    SA_RELAY_ALLOWED_HASH: process.env.SA_RELAY_ALLOWED_HASH,
    MORPHEUS_NETWORK: process.env.MORPHEUS_NETWORK,
    MORPHEUS_PAYMASTER_TESTNET_ENDPOINT: process.env.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT,
    SA_RELAY_MAX_SYSTEM_FEE: process.env.SA_RELAY_MAX_SYSTEM_FEE,
    SA_RELAY_MAX_NETWORK_FEE: process.env.SA_RELAY_MAX_NETWORK_FEE,
    SA_RELAY_MAX_TOTAL_FEE: process.env.SA_RELAY_MAX_TOTAL_FEE,
  };

  process.env.SA_RELAY_RPC_URL = chain.rpcUrl;
  process.env.SA_RELAY_WIF = TEST_WIF;
  process.env.SA_RELAY_ALLOWED_HASH = normalizeHash(core.hash);
  process.env.MORPHEUS_NETWORK = "testnet";
  process.env.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT = paymasterProxy.endpoint;
  // The relay refuses to sign a sponsored broadcast without an explicit fee
  // ceiling; pin the runbook's defaults unless the operator narrowed them.
  process.env.SA_RELAY_MAX_SYSTEM_FEE = snapshot.SA_RELAY_MAX_SYSTEM_FEE || "50000000";
  process.env.SA_RELAY_MAX_NETWORK_FEE = snapshot.SA_RELAY_MAX_NETWORK_FEE || "5000000";
  process.env.SA_RELAY_MAX_TOTAL_FEE = snapshot.SA_RELAY_MAX_TOTAL_FEE || "55000000";

  try {
    const response = createResponse();
    await relayHandler({
      method: "POST",
      headers: {},
      socket: { remoteAddress: `paymaster-relay-${Date.now()}` },
      body: {
        paymaster: {
          account_id: normalizeHash(accountId),
          dapp_id: PAYMASTER_DAPP_ID,
          operation_hash: `0x${randomBytes(32).toString("hex")}`,
        },
        metaInvocation,
      },
    }, response);

    if (response.statusCode !== 200 || !response.payload?.txid) {
      throw new Error(`relay submission failed: ${JSON.stringify(response.payload || {}, null, 2)}`);
    }

    const appLog = await h.waitForAppLog(chain, response.payload.txid, "relay executeUserOp");
    const execution = h.assertHalt(appLog, "relay executeUserOp");
    const result = h.stackText(execution.stack?.[0]);
    if (result !== "GAS") throw new Error(`relayed operation returned ${result}, expected GAS`);
    const after = await sdk.getNonce(accountId, routing);
    if (BigInt(after.sequence) !== 1n) throw new Error(`relayed operation left the channel at sequence ${after.sequence}, expected 1`);

    console.log(JSON.stringify({
      txid: response.payload.txid,
      result,
      paymaster: response.payload.paymaster || null,
      nonceSequence: after.sequence,
      vmstate: execution.vmstate || execution.state || "",
    }, null, 2));

    // -----------------------------------------------------------------------
    // 5. The relay refuses an operation the deployed ABI does not export.
    // -----------------------------------------------------------------------

    h.logSection("5. Relay refuses an operation outside the ABI");
    const refused = createResponse();
    await relayHandler({
      method: "POST",
      headers: {},
      socket: { remoteAddress: `paymaster-relay-refusal-${Date.now()}` },
      body: {
        metaInvocation: {
          scriptHash: normalizeHash(core.hash),
          operation: "registerAccount",
          args: [],
        },
      },
    }, refused);
    if (refused.statusCode !== 400 || refused.payload?.error !== "relay_meta_invocation_not_allowed") {
      throw new Error(`relay did not refuse an out-of-ABI operation: ${JSON.stringify(refused.payload || {}, null, 2)}`);
    }
    console.log(JSON.stringify({
      status: refused.statusCode,
      error: refused.payload.error,
      reason: refused.payload.reason || null,
    }, null, 2));

    h.logSection("Summary");
    console.log(JSON.stringify({
      rpc: chain.rpcUrl,
      coreHash: normalizeHash(core.hash),
      verifierHash: normalizeHash(web3Auth.hash),
      accountId: normalizeHash(accountId),
      validatorId,
      relayTxid: response.payload.txid,
      paymaster: {
        policyId: paymasterPolicy.body.policy_id || null,
        approvalDigest: paymasterPolicy.body.approval_digest || null,
      },
      execution: {
        vmstate: execution.vmstate || execution.state || "",
        result,
      },
      refusal: {
        operation: "registerAccount",
        error: refused.payload.error,
      },
    }, null, 2));
  } finally {
    process.env.SA_RELAY_RPC_URL = snapshot.SA_RELAY_RPC_URL;
    process.env.SA_RELAY_WIF = snapshot.SA_RELAY_WIF;
    process.env.SA_RELAY_ALLOWED_HASH = snapshot.SA_RELAY_ALLOWED_HASH;
    process.env.MORPHEUS_NETWORK = snapshot.MORPHEUS_NETWORK;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT = snapshot.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT;
    process.env.SA_RELAY_MAX_SYSTEM_FEE = snapshot.SA_RELAY_MAX_SYSTEM_FEE;
    process.env.SA_RELAY_MAX_NETWORK_FEE = snapshot.SA_RELAY_MAX_NETWORK_FEE;
    process.env.SA_RELAY_MAX_TOTAL_FEE = snapshot.SA_RELAY_MAX_TOTAL_FEE;
    await paymasterProxy.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
