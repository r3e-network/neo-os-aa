#!/usr/bin/env node

/**
 * v4 paymaster policy probe.
 *
 * The probe asks the paymaster to authorize the exact request the v4 relay
 * sends (`executeUserOp` to the core, with the downstream target and method
 * derived from the 13-field operation) and then proves the policy refuses every
 * single-field deviation.
 *
 * Nothing here touches the chain: the probe is an off-chain allowlist check, so
 * it needs an already-deployed v4 core hash and the account id that core derived.
 *
 * Environment:
 *   SA_CORE_HASH_TESTNET                deployed v4 core (required)
 *   PAYMASTER_ACCOUNT_ID               account the policy allowlists (required)
 *   MORPHEUS_RUNTIME_TOKEN | PHALA_API_TOKEN | PHALA_SHARED_SECRET
 *                                       paymaster bearer token (required)
 *   MORPHEUS_PAYMASTER_APP_ID           dapp id the paymaster allowlists
 *   MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH
 *                                       run the allowlist handler in-process
 *   SKIP_PAYMASTER_ALLOWLIST_UPDATE=1   keep the handler's own allowlist
 *
 * A runbook, not a gate: `npm test` does not run it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import paymasterRuntimeConfig from "./paymaster-runtime-config.js";
import localPaymasterHandlerHelpers from "./local-paymaster-handler.js";

const { resolveLocalPaymasterHandlerPath } = localPaymasterHandlerHelpers;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const PAYMASTER_API_TOKEN = process.env.MORPHEUS_RUNTIME_TOKEN || process.env.PHALA_API_TOKEN || process.env.PHALA_SHARED_SECRET || "";
const PAYMASTER_APP_ID = process.env.MORPHEUS_PAYMASTER_APP_ID || "ddff154546fe22d15b65667156dd4b7c611e6093";
const PAYMASTER_DAPP_ID = String(process.env.MORPHEUS_PAYMASTER_DAPP_ID || PAYMASTER_APP_ID).trim();
// A v3 core hash has no v4 entry points, so the policy probe refuses to run
// against one: both identifiers must come from the deployment under test.
const PAYMASTER_ACCOUNT_ID = String(process.env.PAYMASTER_ACCOUNT_ID || "").trim();
const CORE_HASH = String(process.env.SA_CORE_HASH_TESTNET || "").trim();
const DISALLOWED_TARGET_CONTRACT = `0x${"f0".repeat(20)}`;
const PAYMASTER_METHOD = process.env.MORPHEUS_PAYMASTER_METHOD || "executeUserOp";
const PAYMASTER_MAX_GAS_UNITS = Number(process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS || 5_000_000);
const SKIP_PAYMASTER_ALLOWLIST_UPDATE = process.env.SKIP_PAYMASTER_ALLOWLIST_UPDATE === "1";
const { resolvePaymasterAuthorizeEndpoint } = paymasterRuntimeConfig;
const PAYMASTER_ENDPOINT = resolvePaymasterAuthorizeEndpoint(process.env);
const LOCAL_PAYMASTER_HANDLER_PATH = resolveLocalPaymasterHandlerPath();
const REPORT_DIR = path.resolve(MODULE_DIR, "..", "..", "..", "docs", "reports");
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

if (!PAYMASTER_API_TOKEN) {
  console.error("MORPHEUS_RUNTIME_TOKEN, PHALA_API_TOKEN, or PHALA_SHARED_SECRET is required.");
  process.exit(1);
}

if (!PAYMASTER_ACCOUNT_ID || !CORE_HASH) {
  console.error("PAYMASTER_ACCOUNT_ID and SA_CORE_HASH_TESTNET are required: the probe checks a policy pinned to a deployed v4 core.");
  process.exit(1);
}

function normalizeHash(value = "") {
  const hex = String(value || "").replace(/^0x/i, "").toLowerCase();
  return hex ? `0x${hex}` : "";
}

function buildPaymasterOverrides() {
  const normalizedAccount = normalizeHash(PAYMASTER_ACCOUNT_ID);
  const normalizedTarget = normalizeHash(CORE_HASH);
  return {
    MORPHEUS_PAYMASTER_TESTNET_ENABLED: "true",
    MORPHEUS_PAYMASTER_TESTNET_POLICY_ID: "testnet-sa",
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS: PAYMASTER_DAPP_ID,
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS: normalizedAccount,
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS: normalizedTarget,
    MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS: "executeUserOp,executeSponsoredUserOp",
    MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS: String(PAYMASTER_MAX_GAS_UNITS),
  };
}

async function callLocalPaymaster(payload, overrides) {
  const snapshot = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    snapshot.set(key, process.env[key]);
    process.env[key] = value;
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
      body: JSON.stringify(payload),
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

async function callDirectPaymaster(payload) {
  // `resolvePaymasterAuthorizeEndpoint` already appends the authorize path, so
  // the explicit override binds to exactly one route.
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

async function callPaymaster(payload) {
  if (LOCAL_PAYMASTER_HANDLER_PATH) {
    return callLocalPaymaster(payload, buildPaymasterOverrides());
  }
  if (!PAYMASTER_ENDPOINT) {
    throw new Error("no paymaster authorize endpoint configured (set MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH or the paymaster authorize endpoint)");
  }
  return callDirectPaymaster(payload);
}

function assertApproved(response, label) {
  if (Number(response?.status) !== 200) {
    throw new Error(`${label}: expected HTTP 200, got ${response?.status}`);
  }
  if (response?.body?.approved !== true) {
    throw new Error(`${label}: expected approved=true, got ${JSON.stringify(response?.body || {}, null, 2)}`);
  }
}

function assertDenied(response, label, reasonPattern, { status = 200 } = {}) {
  if (Number(response?.status) !== Number(status)) {
    throw new Error(`${label}: expected HTTP ${status}, got ${response?.status}`);
  }
  if (Number(status) !== 200) {
    const reason = response?.body?.reason || response?.body?.error || "";
    if (!reasonPattern.test(String(reason))) {
      throw new Error(`${label}: expected reason ${reasonPattern}, got ${reason || "n/a"}`);
    }
    return;
  }
  if (response?.body?.approved !== false) {
    throw new Error(`${label}: expected approved=false, got ${JSON.stringify(response?.body || {}, null, 2)}`);
  }
  if (!reasonPattern.test(String(response?.body?.reason || ""))) {
    throw new Error(`${label}: expected reason ${reasonPattern}, got ${response?.body?.reason || "n/a"}`);
  }
}

async function main() {
  const accountId = normalizeHash(PAYMASTER_ACCOUNT_ID);
  if (!SKIP_PAYMASTER_ALLOWLIST_UPDATE) {
    console.log(`Using per-request remote paymaster overrides for ${accountId}...`);
  }

  const approvedPayload = {
    network: "testnet",
    target_chain: "neo_n3",
    account_id: accountId,
    dapp_id: PAYMASTER_DAPP_ID,
    target_contract: normalizeHash(CORE_HASH),
    method: PAYMASTER_METHOD,
    // The relay derives these two from the 13-field operation, so the approved
    // request must carry the same shape the relay actually posts.
    userop_target_contract: normalizeHash(process.env.SA_PAYMASTER_PROBE_TARGET || "0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5"),
    userop_method: process.env.SA_PAYMASTER_PROBE_METHOD || "symbol",
    estimated_gas_units: 1985656,
    operation_hash: `0x${"44".repeat(32)}`,
  };

  const approved = await callPaymaster(approvedPayload);
  assertApproved(approved, "approved");

  const cases = [
    {
      id: "missingOperationHash",
      payload: { ...approvedPayload, operation_hash: "" },
      reason: /operation_hash is required/i,
    },
    {
      id: "wrongDappId",
      payload: { ...approvedPayload, dapp_id: "rogue-dapp", operation_hash: `0x${"45".repeat(32)}` },
      reason: /dapp_id is not allowlisted/i,
    },
    {
      id: "wrongAccountId",
      payload: { ...approvedPayload, account_id: "0x9999000011112222333344445555666677778888", operation_hash: `0x${"46".repeat(32)}` },
      reason: /account_id is not allowlisted/i,
    },
    {
      id: "wrongTargetContract",
      payload: { ...approvedPayload, target_contract: DISALLOWED_TARGET_CONTRACT, operation_hash: `0x${"47".repeat(32)}` },
      reason: /target_contract is not allowlisted/i,
    },
    {
      id: "wrongMethod",
      payload: { ...approvedPayload, method: "transfer", operation_hash: `0x${"48".repeat(32)}` },
      reason: /method is not allowlisted/i,
    },
    {
      id: "gasTooHigh",
      payload: { ...approvedPayload, estimated_gas_units: PAYMASTER_MAX_GAS_UNITS + 1, operation_hash: `0x${"49".repeat(32)}` },
      reason: /estimated gas exceeds network paymaster limit/i,
    },
    {
      id: "wrongTargetChain",
      payload: { ...approvedPayload, target_chain: "neo_x", operation_hash: `0x${"4a".repeat(32)}` },
      reason: /supports neo_n3 only|unsupported target_chain/i,
      status: 400,
    },
  ];

  const deniedCases = {};
  for (const item of cases) {
    const response = await callPaymaster(item.payload);
    assertDenied(response, item.id, item.reason, { status: item.status || 200 });
    deniedCases[item.id] = {
      approved: response.body.approved ?? false,
      reason: response.body.reason || response.body.error,
    };
  }

  const report = {
    network: "testnet",
    appId: PAYMASTER_APP_ID,
    policyId: approved.body.policy_id,
    accountId,
    approved: {
      approvalDigest: approved.body.approval_digest,
      attestationHash: approved.body.attestation_hash,
      targetContract: approved.body.target_contract,
      method: approved.body.method,
    },
    deniedCases,
  };

  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "sa-testnet-paymaster-policy.latest.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    reportPath,
    policyId: report.policyId,
    accountId: report.accountId,
    deniedCases: Object.keys(report.deniedCases),
    approvalDigest: report.approved.approvalDigest,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
