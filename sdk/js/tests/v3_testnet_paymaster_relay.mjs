#!/usr/bin/env node

import http from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import paymasterRuntimeConfig from "./paymaster-runtime-config.js";
import localPaymasterHandlerHelpers from "./local-paymaster-handler.js";

const require = createRequire(import.meta.url);
const { resolveLocalPaymasterHandlerPath } = localPaymasterHandlerHelpers;

const { rpc, sc, wallet, experimental, tx, u, CONST } = require("@cityofzion/neon-js");
const { ethers } = require("ethers");
const { buildV3UserOperationTypedData, sanitizeHex } = require("../src/metaTx");
const { AbstractAccountClient } = require("../src/index");
const { resolveTestnetRpcUrl } = require("./testnet-rpc.js");

const relayModule = await import("../../../frontend/api/relay-transaction.js");
const relayHandler = relayModule.default;

const TEST_WIF = process.env.TEST_WIF || process.env.NEO_TESTNET_WIF || "";
let RPC_URL = process.env.TESTNET_RPC_URL || "";
const CORE_HASH = process.env.AA_CORE_HASH_TESTNET || "0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2";
const WEB3AUTH_VERIFIER_HASH = process.env.AA_WEB3AUTH_VERIFIER_HASH_TESTNET || "0x7147f9a508594a7656a25f45d0a7a7dede7c227f";
const PAYMASTER_APP_ID = process.env.MORPHEUS_PAYMASTER_APP_ID || "ddff154546fe22d15b65667156dd4b7c611e6093";
const PAYMASTER_API_TOKEN =
  process.env.MORPHEUS_RUNTIME_TOKEN
  || process.env.PHALA_API_TOKEN
  || process.env.PHALA_SHARED_SECRET
  || "";
const { resolvePaymasterAuthorizeEndpoint } = paymasterRuntimeConfig;
const PAYMASTER_ENDPOINT = resolvePaymasterAuthorizeEndpoint(process.env);
const LOCAL_PAYMASTER_HANDLER_PATH = resolveLocalPaymasterHandlerPath();
const PAYMASTER_DAPP_ID = String(process.env.MORPHEUS_PAYMASTER_DAPP_ID || PAYMASTER_APP_ID).trim();
const EXPLICIT_PAYMASTER_ACCOUNT_ID = (process.env.PAYMASTER_ACCOUNT_ID || "").trim();
const SKIP_PAYMASTER_ALLOWLIST_UPDATE =
  process.env.SKIP_PAYMASTER_ALLOWLIST_UPDATE === "1"
  || (
    process.env.SKIP_PAYMASTER_ALLOWLIST_UPDATE !== "0"
    && !EXPLICIT_PAYMASTER_ACCOUNT_ID
    && !LOCAL_PAYMASTER_HANDLER_PATH
  );
const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const REGISTRATION_ESCAPE_TIMELOCK = 604800;
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

function normalizeHash(value) {
  const hex = sanitizeHex(value || "");
  return hex ? `0x${hex}` : "";
}

function isUnauthorizedBootstrapError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Unauthorized/i.test(message);
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

function hash160Param(value) {
  return sc.ContractParam.hash160(sanitizeHex(value));
}

function byteArrayParam(hexValue) {
  return sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(hexValue), true));
}

function integerParam(value) {
  if (typeof value === "bigint") return sc.ContractParam.integer(value.toString());
  return sc.ContractParam.integer(value);
}

function stringParam(value) {
  return sc.ContractParam.string(String(value));
}

function arrayParam(values = []) {
  return sc.ContractParam.array(...values);
}

function emptyByteArrayParam() {
  return sc.ContractParam.byteArray(u.HexString.fromHex("", true));
}

function userOpJsonParam({ targetContract, method, args = [], nonce = 0n, deadline = 0n, signatureHex = "" }) {
  return {
    type: "Struct",
    value: [
      { type: "Hash160", value: normalizeHash(targetContract) },
      { type: "String", value: String(method) },
      { type: "Array", value: args },
      { type: "Integer", value: String(nonce) },
      { type: "Integer", value: String(deadline) },
      { type: "ByteArray", value: `0x${sanitizeHex(signatureHex)}` },
    ],
  };
}

async function waitForAppLog(client, txid, label, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const appLog = await client.getApplicationLog(txid);
      if (appLog?.executions?.length) return appLog;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`${label}: timed out waiting for application log`);
}

function assertHalt(appLog, label) {
  const execution = appLog?.executions?.[0];
  if (!execution) throw new Error(`${label}: missing execution`);
  const vmState = String(execution.vmstate || execution.state || "");
  if (!vmState.includes("HALT")) {
    throw new Error(`${label}: expected HALT, got ${vmState} ${execution.exception || ""}`.trim());
  }
  return execution;
}

async function invokePersisted(client, contractHash, account, networkMagic, operation, params = [], signers = undefined) {
  const contract = new experimental.SmartContract(sanitizeHex(contractHash), {
    account,
    networkMagic,
    rpcAddress: RPC_URL,
    blocksTillExpiry: 200,
  });
  const txid = await contract.invoke(operation, params, signers);
  const appLog = await waitForAppLog(client, txid, operation);
  const execution = assertHalt(appLog, operation);
  return { txid, appLog, execution };
}

async function invokeRead(client, contractHash, operation, params = []) {
  const result = await client.invokeFunction(sanitizeHex(contractHash), operation, params);
  if (String(result?.state || "").includes("FAULT")) {
    throw new Error(`${operation} fault: ${result.exception || "VM fault"}`);
  }
  return result?.stack?.[0];
}

function decodeIntStack(item) {
  return BigInt(item?.value || "0");
}

function decodeByteStringHex(item) {
  if (!item || item.type !== "ByteString" || !item.value) return "";
  return Buffer.from(item.value, "base64").toString("hex");
}

function buildLocalPaymasterOverrides(accountId) {
  const normalized = normalizeHash(accountId).toLowerCase();
  const normalizedTarget = normalizeHash(CORE_HASH).toLowerCase();
  return {
    MORPHEUS_PAYMASTER_TESTNET_ENABLED: "true",
    MORPHEUS_PAYMASTER_TESTNET_POLICY_ID: "testnet-aa",
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS: PAYMASTER_DAPP_ID,
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS: normalized,
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS: normalizedTarget,
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS: "executeUserOp,executeUnifiedByAddress",
    MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS: String(process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS || 5_000_000),
  };
}

async function callRemotePaymaster(
  payload,
  {
    allowlistAccountId = EXPLICIT_PAYMASTER_ACCOUNT_ID || null,
    skipAllowlistUpdate = SKIP_PAYMASTER_ALLOWLIST_UPDATE,
  } = {},
) {
  const bodyBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const normalizedAllowlistAccountId = normalizeHash(allowlistAccountId);
  if (LOCAL_PAYMASTER_HANDLER_PATH) {
    const snapshot = new Map();
    const localOverrides = (!skipAllowlistUpdate && normalizedAllowlistAccountId)
      ? buildLocalPaymasterOverrides(normalizedAllowlistAccountId)
      : null;
    if (localOverrides) {
      for (const [key, value] of Object.entries(localOverrides)) {
        snapshot.set(key, process.env[key]);
        process.env[key] = value;
      }
    }
    for (const key of LOCAL_PAYMASTER_SIGNER_ENV_KEYS) {
      if (!snapshot.has(key)) {
        snapshot.set(key, process.env[key]);
      }
      delete process.env[key];
    }
    for (const key of LOCAL_PAYMASTER_RUNTIME_ENV_KEYS) {
      if (!snapshot.has(key)) {
        snapshot.set(key, process.env[key]);
      }
    }
    try {
      process.env.PHALA_API_TOKEN = process.env.PHALA_API_TOKEN || process.env.MORPHEUS_RUNTIME_TOKEN || process.env.PHALA_SHARED_SECRET || "";
      const { default: handler } = await import(pathToFileURL(LOCAL_PAYMASTER_HANDLER_PATH).href);
      const req = new Request("http://local/paymaster/authorize", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PAYMASTER_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: Buffer.from(bodyBase64, "base64").toString("utf8"),
      });
      const res = await handler(req);
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    } finally {
      for (const [key, value] of snapshot.entries()) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
  if (PAYMASTER_ENDPOINT) {
    const response = await fetch(PAYMASTER_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PAYMASTER_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: Buffer.from(bodyBase64, "base64").toString("utf8"),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  }
  throw new Error("no paymaster authorize endpoint configured (set MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH or the paymaster authorize endpoint)");
}

async function startPaymasterProxy({
  allowlistAccountId = EXPLICIT_PAYMASTER_ACCOUNT_ID || null,
  skipAllowlistUpdate = SKIP_PAYMASTER_ALLOWLIST_UPDATE,
} = {}) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (req.url !== "/paymaster") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    try {
      const remote = await callRemotePaymaster(body, {
        allowlistAccountId,
        skipAllowlistUpdate,
      });
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
    server,
    endpoint: `http://127.0.0.1:${port}/paymaster`,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function main() {
  RPC_URL = await resolveTestnetRpcUrl({ env: process.env });
  const account = new wallet.Account(TEST_WIF);
  const rpcClient = new rpc.RPCClient(RPC_URL);
  const version = await rpcClient.getVersion();
  const networkMagic = Number(version.protocol.network);
  const aaClient = new AbstractAccountClient(RPC_URL, CORE_HASH);
  const deriveBootstrapAccountId = ({ verifierContractHash = "", verifierParamsHex = "" } = {}) => aaClient.deriveRegistrationAccountIdHash({
    verifierContractHash,
    verifierParamsHex,
    backupOwnerAddress: account.scriptHash,
    escapeTimelock: REGISTRATION_ESCAPE_TIMELOCK,
  });

  const evmSigner = ethers.Wallet.createRandom();
  const verifierPubKey = sanitizeHex(evmSigner.signingKey.publicKey);
  const defaultBootstrapAccountId = sanitizeHex(
    EXPLICIT_PAYMASTER_ACCOUNT_ID
    || deriveBootstrapAccountId({
      verifierContractHash: WEB3AUTH_VERIFIER_HASH,
      verifierParamsHex: verifierPubKey,
    })
  );
  let accountId = defaultBootstrapAccountId;
  let skipAllowlistUpdate = SKIP_PAYMASTER_ALLOWLIST_UPDATE;

  console.log(JSON.stringify({
    rpc: RPC_URL,
    coreHash: normalizeHash(CORE_HASH),
    verifierHash: normalizeHash(WEB3AUTH_VERIFIER_HASH),
    relayAddress: account.address,
    relayScriptHash: normalizeHash(account.scriptHash),
    accountId: normalizeHash(accountId),
    verifierPubKey: `0x${verifierPubKey}`,
  }, null, 2));

  async function bootstrapAccount(targetAccountId) {
    let register = null;
    try {
      register = await invokePersisted(
        rpcClient,
        CORE_HASH,
        account,
        networkMagic,
        "registerAccount",
        [
          hash160Param(targetAccountId),
          hash160Param(WEB3AUTH_VERIFIER_HASH),
          byteArrayParam(verifierPubKey),
          hash160Param("0".repeat(40)),
          hash160Param(account.scriptHash),
          integerParam(REGISTRATION_ESCAPE_TIMELOCK),
        ],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Account already exists")) throw error;
      console.log(`registerAccount skipped for existing account ${normalizeHash(targetAccountId)}`);
    }

    return {
      register,
      updateVerifier: null,
    };
  }

  let register = null;
  let updateVerifier;
  try {
    ({ register, updateVerifier } = await bootstrapAccount(accountId));
  } catch (error) {
    const usingReusableBootstrapAccount = skipAllowlistUpdate && normalizeHash(accountId) === normalizeHash(defaultBootstrapAccountId);
    if (!usingReusableBootstrapAccount || !isUnauthorizedBootstrapError(error)) {
      throw error;
    }
    accountId = deriveBootstrapAccountId({
      verifierContractHash: WEB3AUTH_VERIFIER_HASH,
      verifierParamsHex: verifierPubKey,
    });
    skipAllowlistUpdate = false;
    console.warn(
      `Reusable paymaster bootstrap account was rejected; falling back to disposable account ${normalizeHash(accountId)}`
    );
    ({ register, updateVerifier } = await bootstrapAccount(accountId));
  }

  console.log(JSON.stringify({
    registerTxid: register?.txid || null,
    updateVerifierTxid: updateVerifier?.txid || null,
  }, null, 2));

  if (!skipAllowlistUpdate) {
    console.log("Using per-request remote paymaster overrides for allowlist validation...");
    const paymasterPolicy = await callRemotePaymaster({
      network: "testnet",
      target_chain: "neo_n3",
      account_id: normalizeHash(accountId),
      dapp_id: PAYMASTER_DAPP_ID,
      target_contract: normalizeHash(CORE_HASH),
      method: "executeUserOp",
      userop_target_contract: normalizeHash(GAS_HASH),
      userop_method: "symbol",
      estimated_gas_units: 2_000_000,
      operation_hash: `0x${Buffer.from(randomBytes(32)).toString("hex")}`,
    }, {
      allowlistAccountId: accountId,
      skipAllowlistUpdate,
    });
    console.log(JSON.stringify({
      paymasterPolicyId: paymasterPolicy?.body?.policy_id || null,
      allowAccounts: paymasterPolicy?.body?.policy?.allow_accounts || [],
    }, null, 2));
  }
  const paymasterProxy = await startPaymasterProxy({
    allowlistAccountId: accountId,
    skipAllowlistUpdate,
  });

  const nonce = decodeIntStack(await invokeRead(rpcClient, CORE_HASH, "getNonce", [hash160Param(accountId), integerParam(0)]));
  const argsHashHex = await aaClient.computeArgsHash([]);
  const deadline = BigInt(Date.now() + (60 * 60 * 1000));
  const typedData = buildV3UserOperationTypedData({
    chainId: networkMagic,
    verifyingContract: sanitizeHex(WEB3AUTH_VERIFIER_HASH),
    accountIdHash: accountId,
    coreContractHash: sanitizeHex(CORE_HASH),
    targetContract: sanitizeHex(GAS_HASH),
    method: "symbol",
    argsHashHex,
    nonce,
    deadline,
  });
  const signature = ethers.Signature.from(await evmSigner.signTypedData(typedData.domain, typedData.types, typedData.message));
  const compactSignature = `${sanitizeHex(signature.r)}${sanitizeHex(signature.s)}`;

  const response = createResponse();
  const snapshot = {
    AA_RELAY_RPC_URL: process.env.AA_RELAY_RPC_URL,
    AA_RELAY_WIF: process.env.AA_RELAY_WIF,
    AA_RELAY_ALLOWED_HASH: process.env.AA_RELAY_ALLOWED_HASH,
    MORPHEUS_NETWORK: process.env.MORPHEUS_NETWORK,
    MORPHEUS_PAYMASTER_TESTNET_ENDPOINT: process.env.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT,
  };

  process.env.AA_RELAY_RPC_URL = RPC_URL;
  process.env.AA_RELAY_WIF = TEST_WIF;
  process.env.AA_RELAY_ALLOWED_HASH = normalizeHash(CORE_HASH);
  process.env.MORPHEUS_NETWORK = "testnet";
  process.env.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT = paymasterProxy.endpoint;

  try {
    console.log("Submitting executeUserOp via AA relay with paymaster pre-authorization...");
    await relayHandler({
      method: "POST",
      headers: {},
      socket: { remoteAddress: `paymaster-relay-${Date.now()}` },
      body: {
        paymaster: {
          account_id: normalizeHash(accountId),
          dapp_id: PAYMASTER_DAPP_ID,
          operation_hash: `0x${Buffer.from(randomBytes(32)).toString("hex")}`,
        },
        metaInvocation: {
          scriptHash: normalizeHash(CORE_HASH),
          operation: "executeUserOp",
          args: [
            { type: "Hash160", value: normalizeHash(accountId) },
            userOpJsonParam({
              targetContract: normalizeHash(GAS_HASH),
              method: "symbol",
              args: [],
              nonce,
              deadline,
              signatureHex: compactSignature,
            }),
          ],
        },
      },
    }, response);
  } finally {
    process.env.AA_RELAY_RPC_URL = snapshot.AA_RELAY_RPC_URL;
    process.env.AA_RELAY_WIF = snapshot.AA_RELAY_WIF;
    process.env.AA_RELAY_ALLOWED_HASH = snapshot.AA_RELAY_ALLOWED_HASH;
    process.env.MORPHEUS_NETWORK = snapshot.MORPHEUS_NETWORK;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT = snapshot.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT;
    await paymasterProxy.close();
  }

  if (response.statusCode !== 200 || !response.payload?.txid) {
    throw new Error(`relay submission failed: ${JSON.stringify(response.payload || {}, null, 2)}`);
  }

  const appLog = await waitForAppLog(rpcClient, response.payload.txid, "relay executeUserOp");
  const execution = assertHalt(appLog, "relay executeUserOp");

  console.log(JSON.stringify({
    txid: response.payload.txid,
    paymaster: response.payload.paymaster || null,
    execution: {
      vmstate: execution.vmstate || execution.state || "",
      stack: execution.stack || [],
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
