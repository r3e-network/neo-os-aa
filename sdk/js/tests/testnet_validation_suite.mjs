#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import paymasterRuntimeConfig from "./paymaster-runtime-config.js";
import testnetRpcHelpers from "./testnet-rpc.js";
import localPaymasterHandlerHelpers from "./local-paymaster-handler.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "..");
const SDK_REPORT_DIR = path.resolve(ROOT_DIR, "..", "..", "docs", "reports");
const REPO_REPORT_DIR = path.resolve(ROOT_DIR, "..", "..", "docs");
const REPO_ROOT = path.resolve(ROOT_DIR, "..", "..");
// One run id for every stage, so a suite run names a single deployment tag and
// its report can be read back against the contracts it deployed.
const SUITE_RUN_ID = (
  process.env.SA_VALIDATION_RUN_ID ||
  `suite-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`
).toLowerCase();
if (!process.env.SA_VALIDATION_RUN_ID) {
  process.env.SA_VALIDATION_RUN_ID = SUITE_RUN_ID;
}
const { shouldSkipPaymasterRelayValidation } = paymasterRuntimeConfig;
const { DEFAULT_TESTNET_RPC_URLS, resolveTestnetRpcCandidates } = testnetRpcHelpers;
const { resolveLocalPaymasterHandlerPath } = localPaymasterHandlerHelpers;

const LOCAL_PAYMASTER_HANDLER_PATH = resolveLocalPaymasterHandlerPath();
if (!process.env.MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH && LOCAL_PAYMASTER_HANDLER_PATH) {
  process.env.MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH = LOCAL_PAYMASTER_HANDLER_PATH;
}

// Every runbook reads the paying wallet as `TEST_WIF || NEO_TESTNET_WIF`, so a
// stage is ready when either one is set; requiring `TEST_WIF` alone would skip
// a suite whose operator only exported the v4-era name.
const WIF_ENV = ["TEST_WIF", "NEO_TESTNET_WIF"];
const RUNTIME_TOKEN_ENV = ["MORPHEUS_RUNTIME_TOKEN", "PHALA_API_TOKEN", "PHALA_SHARED_SECRET"];

const STAGES = [
  {
    id: "smoke",
    title: "V4 Smoke",
    command: ["node", "tests/testnet_smoke.js"],
    requiredEnvAny: [WIF_ENV],
  },
  {
    id: "plugin_matrix",
    title: "V4 Plugin Matrix",
    command: ["node", "tests/testnet_plugin_matrix.js"],
    requiredEnvAny: [WIF_ENV],
  },
  {
    id: "market_escrow",
    title: "V4 Market Escrow",
    command: ["node", "tests/testnet_market_escrow.js"],
    requiredEnvAny: [WIF_ENV],
  },
  {
    id: "paymaster_onchain",
    title: "V4 Paymaster On-Chain",
    command: ["node", "tests/testnet_paymaster_onchain.mjs"],
    requiredEnvAny: [WIF_ENV],
  },
  {
    // An off-chain allowlist probe: it needs the deployed core hash and the
    // account that core derived, but never a wallet.
    id: "paymaster_policy",
    title: "V4 Paymaster Policy",
    command: ["node", "tests/testnet_paymaster_policy.mjs"],
    requiredEnv: ["PAYMASTER_ACCOUNT_ID", "SA_CORE_HASH_TESTNET"],
    requiredEnvAny: [RUNTIME_TOKEN_ENV],
    optional: true,
  },
  {
    id: "paymaster",
    title: "V4 Paymaster Relay",
    command: ["node", "tests/testnet_paymaster_relay.mjs"],
    requiredEnvAny: [WIF_ENV, RUNTIME_TOKEN_ENV],
    optional: true,
    envOverrides: {
      TEST_WIF: process.env.NEO_TESTNET_WIF || process.env.PAYMASTER_TEST_WIF || process.env.TEST_WIF || "",
    },
  },
];

function parseArgs(argv = []) {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function envSnapshot() {
  return {
    TESTNET_RPC_URL: process.env.TESTNET_RPC_URL || null,
    TESTNET_RPC_URLS: process.env.TESTNET_RPC_URLS || null,
    rpcCandidateCount: resolveTestnetRpcCandidates(process.env).length,
    defaultRpcCandidates: DEFAULT_TESTNET_RPC_URLS,
    hasTestWif: Boolean(process.env.TEST_WIF),
    hasNeoTestnetWif: Boolean(process.env.NEO_TESTNET_WIF),
    validationRunId: process.env.SA_VALIDATION_RUN_ID || null,
    deployTag: process.env.SA_VALIDATION_DEPLOY_TAG || `sa-v4-${SUITE_RUN_ID}`,
    coreHashTestnet: process.env.SA_CORE_HASH_TESTNET || null,
    matrixScenarios: process.env.SA_MATRIX_SCENARIOS || null,
    feeCaps: {
      maxSystemFee: process.env.SA_MAX_SYSTEM_FEE || "50000000",
      maxNetworkFee: process.env.SA_MAX_NETWORK_FEE || "5000000",
      maxTotalFee: process.env.SA_MAX_TOTAL_FEE || "55000000",
    },
    hasMorpheusRuntimeToken: Boolean(process.env.MORPHEUS_RUNTIME_TOKEN || process.env.PHALA_API_TOKEN || process.env.PHALA_SHARED_SECRET),
    morpheusPaymasterAppId: process.env.MORPHEUS_PAYMASTER_APP_ID || "ddff154546fe22d15b65667156dd4b7c611e6093",
    paymasterAccountId: process.env.PAYMASTER_ACCOUNT_ID || null,
    skipPaymasterAllowlistUpdate: process.env.SKIP_PAYMASTER_ALLOWLIST_UPDATE === "1",
    localPaymasterHandlerPath: process.env.MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH || null,
  };
}

function extractJsonObjects(text = "") {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, index + 1);
        try {
          objects.push(JSON.parse(candidate));
        } catch {
          // ignore non-JSON blocks
        }
        start = -1;
      }
    }
  }

  return objects;
}

function latestJsonObject(stdout = "") {
  const objects = extractJsonObjects(stdout);
  return objects.length > 0 ? objects[objects.length - 1] : null;
}

function summarizeSmoke(stdout = "") {
  const summary = latestJsonObject(stdout) || {};
  return {
    address: summary.address || null,
    coreHash: summary.coreHash || null,
    web3AuthHash: summary.web3AuthHash || null,
    whitelistHash: summary.whitelistHash || null,
    accountId: summary.accountId || null,
    virtualAddress: summary.virtualAddress || null,
    txids: summary.txids || {},
  };
}

async function summarizePluginMatrix(stdout = "") {
  const summary = latestJsonObject(stdout) || {};
  const reportPathAbsolute = typeof summary.reportPath === "string" ? summary.reportPath : null;
  const reportPath = reportPathAbsolute ? path.relative(REPO_ROOT, reportPathAbsolute) : null;
  let report = null;
  if (reportPathAbsolute) {
    try {
      report = JSON.parse(await readFile(reportPathAbsolute, "utf8"));
    } catch {
      report = null;
    }
  }

  // The matrix report names the deployed core and every module under
  // `deployments`; the test probe that stands in for a target contract is
  // recorded there as `probe`.
  const scenarios = summary.scenarios && typeof summary.scenarios === "object" && !Array.isArray(summary.scenarios)
    ? Object.entries(summary.scenarios)
    : Object.entries(report?.matrix || {}).map(([name, item]) => [name, item?.status || "unknown"]);

  return {
    reportPath,
    core: report?.deployments?.core?.hash || null,
    mockTarget: report?.deployments?.modules?.probe || null,
    scenarios: scenarios.map(([name, status]) => ({ name, status })),
    failed: scenarios.filter(([, status]) => status !== "passed").map(([name]) => name),
  };
}

async function summarizePaymasterPolicy(stdout = "") {
  const summary = latestJsonObject(stdout) || {};
  const reportPathAbsolute = typeof summary.reportPath === "string" ? summary.reportPath : null;
  const reportPath = reportPathAbsolute ? path.relative(REPO_ROOT, reportPathAbsolute) : null;
  let report = null;
  if (reportPathAbsolute) {
    try {
      report = JSON.parse(await readFile(reportPathAbsolute, "utf8"));
    } catch {
      report = null;
    }
  }

  return {
    reportPath,
    policyId: summary.policyId || report?.policyId || null,
    accountId: summary.accountId || report?.accountId || null,
    approvalDigest: summary.approvalDigest || report?.approved?.approvalDigest || null,
    attestationHash: report?.approved?.attestationHash || null,
    deniedCases: Array.isArray(summary.deniedCases)
      ? summary.deniedCases
      : report?.deniedCases
        ? Object.keys(report.deniedCases)
        : [],
  };
}

function summarizePaymaster(stdout = "") {
  const summary = latestJsonObject(stdout) || {};
  return {
    txid: summary.relayTxid || null,
    coreHash: summary.coreHash || null,
    verifierHash: summary.verifierHash || null,
    accountId: summary.accountId || null,
    validatorId: summary.validatorId ?? null,
    policyId: summary.paymaster?.policyId ?? null,
    approvalDigest: summary.paymaster?.approvalDigest || null,
    vmstate: summary.execution?.vmstate || null,
    result: summary.execution?.result || null,
    refusedOperation: summary.refusal?.operation || null,
  };
}

function summarizeMarketEscrow(stdout = "") {
  const summary = latestJsonObject(stdout) || {};
  return {
    core: summary.core?.hash || null,
    market: summary.market?.hash || null,
    verifier: summary.teeVerifier?.hash || null,
    hook: summary.whitelistHook?.hash || null,
    listingId: summary.listingId ?? null,
    accountId: summary.accountId || null,
    buyerRecorded: summary.buyerRecorded ?? null,
    buyer: summary.buyer || null,
    custodyAfterSale: summary.custodyAfterSale || null,
    status: summary.status ?? null,
  };
}

function summarizePaymasterOnchain(stdout = "") {
  const summary = latestJsonObject(stdout) || {};
  return {
    core: summary.deployments?.core || null,
    verifier: summary.deployments?.verifier || null,
    paymaster: summary.deployments?.paymaster || null,
    accountId: summary.account?.id || null,
    sponsoredTxid: summary.sponsoredExec?.txid || null,
    sponsoredResult: summary.sponsoredExec?.result || null,
    depositBefore: summary.sponsoredExec?.depositBefore || null,
    depositAfter: summary.sponsoredExec?.depositAfter || null,
    reimbursement: summary.sponsoredExec?.reimbursement || null,
    overLimitRejected: summary.negativeOverLimit?.rejected ?? null,
    revokedRejected: summary.negativeRevoked?.rejected ?? null,
    withdrawSuccess: summary.withdraw?.success ?? null,
  };
}

async function summarizeStage(stageId, stdout) {
  switch (stageId) {
    case "smoke":
      return summarizeSmoke(stdout);
    case "plugin_matrix":
      return summarizePluginMatrix(stdout);
    case "market_escrow":
      return summarizeMarketEscrow(stdout);
    case "paymaster_onchain":
      return summarizePaymasterOnchain(stdout);
    case "paymaster_policy":
      return summarizePaymasterPolicy(stdout);
    case "paymaster":
      return summarizePaymaster(stdout);
    default:
      return {};
  }
}

async function runStage(stage) {
  const startedAt = nowIso();
  const child = spawn(stage.command[0], stage.command.slice(1), {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...(stage.envOverrides || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    const error = new Error(`${stage.id} failed with exit code ${exitCode}`);
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }

  return {
    id: stage.id,
    title: stage.title,
    startedAt,
    finishedAt: nowIso(),
    command: stage.command.join(" "),
    summary: await summarizeStage(stage.id, stdout),
  };
}

function missingRequiredEnv(stage) {
  const missing = (stage.requiredEnv || []).filter((key) => !process.env[key]);
  for (const group of (stage.requiredEnvAny || [])) {
    if (!group.some((key) => process.env[key])) {
      missing.push(group.join(" | "));
    }
  }
  return missing;
}

function markdownList(items = []) {
  return items.map((item) => `- ${item}`).join("\n");
}

function optionalSkipReason(stage) {
  if (stage.id === "paymaster") {
    return shouldSkipPaymasterRelayValidation(process.env);
  }
  return "";
}

function buildMarkdownReport(report) {
  const smoke = report.stages.find((stage) => stage.id === "smoke");
  const pluginMatrix = report.stages.find((stage) => stage.id === "plugin_matrix");
  const marketEscrow = report.stages.find((stage) => stage.id === "market_escrow");
  const paymasterOnchain = report.stages.find((stage) => stage.id === "paymaster_onchain");
  const paymasterPolicy = report.stages.find((stage) => stage.id === "paymaster_policy");
  const paymaster = report.stages.find((stage) => stage.id === "paymaster");

  const smokeTxLines = Object.entries(smoke?.summary?.txids || {}).map(([key, value]) => `${key}: \`${value}\``);
  const pluginScenarioLines = (pluginMatrix?.summary?.scenarios || []).map(
    (item) => `${item.name}: \`${item.status}\``,
  );

  const lines = [
    "# V4 Testnet Validation Suite Report",
    "",
    `Date: ${report.createdAt}`,
    "",
    "## Environment",
    "",
    markdownList([
      `RPC: \`${report.environment.TESTNET_RPC_URL}\``,
      `Validation run id: \`${report.environment.validationRunId || "n/a"}\``,
      `Deployment tag: \`${report.environment.deployTag}\``,
      `Has TEST_WIF: \`${report.environment.hasTestWif}\``,
      `Has NEO_TESTNET_WIF: \`${report.environment.hasNeoTestnetWif}\``,
      `Core under test: \`${report.environment.coreHashTestnet || "deployed by the smoke stage"}\``,
      `Matrix scenarios: \`${report.environment.matrixScenarios || "all"}\``,
      `Has Morpheus runtime token: \`${report.environment.hasMorpheusRuntimeToken}\``,
      `Paymaster app id: \`${report.environment.morpheusPaymasterAppId}\``,
      `Paymaster account override: \`${report.environment.paymasterAccountId || "none"}\``,
      `Skip allowlist update: \`${report.environment.skipPaymasterAllowlistUpdate}\``,
    ]),
    "",
    "## Stages",
    "",
    markdownList(report.stages.map((stage) => `${stage.title}: \`ok\``)),
    "",
    "## Smoke Summary",
    "",
    markdownList([
      `Address: \`${smoke?.summary?.address || "n/a"}\``,
      `Core hash: \`${smoke?.summary?.coreHash || "n/a"}\``,
      `Web3Auth verifier: \`${smoke?.summary?.web3AuthHash || "n/a"}\``,
      `Whitelist hook: \`${smoke?.summary?.whitelistHash || "n/a"}\``,
      `Account ID: \`${smoke?.summary?.accountId || "n/a"}\``,
      `Virtual address: \`${smoke?.summary?.virtualAddress || "n/a"}\``,
    ]),
    "",
    ...(smokeTxLines.length > 0 ? ["Transactions:", "", markdownList(smokeTxLines), ""] : []),
    "## Plugin Matrix Summary",
    "",
    markdownList([
      `Report path: \`${pluginMatrix?.summary?.reportPath || "n/a"}\``,
      `Core hash: \`${pluginMatrix?.summary?.core || "n/a"}\``,
      `Test probe: \`${pluginMatrix?.summary?.mockTarget || "n/a"}\``,
      `Scenarios: \`${(pluginMatrix?.summary?.scenarios || []).length}\``,
      `Failed: \`${(pluginMatrix?.summary?.failed || []).join(", ") || "none"}\``,
    ]),
    "",
    ...(pluginScenarioLines.length > 0 ? ["Scenario results:", "", markdownList(pluginScenarioLines), ""] : []),
  ];

  if (marketEscrow) {
    lines.push(
      "## Market Escrow Summary",
      "",
      markdownList([
        `Core hash: \`${marketEscrow.summary.core || "n/a"}\``,
        `Market hash: \`${marketEscrow.summary.market || "n/a"}\``,
        `TEE verifier: \`${marketEscrow.summary.verifier || "n/a"}\``,
        `Whitelist hook: \`${marketEscrow.summary.hook || "n/a"}\``,
        `Listing ID: \`${marketEscrow.summary.listingId ?? "n/a"}\``,
        `Account ID: \`${marketEscrow.summary.accountId || "n/a"}\``,
        `Buyer recorded: \`${marketEscrow.summary.buyerRecorded ?? "n/a"}\``,
        `Buyer: \`${marketEscrow.summary.buyer || "n/a"}\``,
        `Custody after sale: \`${marketEscrow.summary.custodyAfterSale || "n/a"}\``,
        `Listing status: \`${marketEscrow.summary.status ?? "n/a"}\``,
      ]),
      "",
    );
  }

  if (paymasterOnchain) {
    lines.push(
      "## Paymaster On-Chain Summary",
      "",
      markdownList([
        `Core hash: \`${paymasterOnchain.summary.core || "n/a"}\``,
        `Verifier hash: \`${paymasterOnchain.summary.verifier || "n/a"}\``,
        `Paymaster hash: \`${paymasterOnchain.summary.paymaster || "n/a"}\``,
        `Account ID: \`${paymasterOnchain.summary.accountId || "n/a"}\``,
        `Sponsored txid: \`${paymasterOnchain.summary.sponsoredTxid || "n/a"}\``,
        `Sponsored result: \`${paymasterOnchain.summary.sponsoredResult || "n/a"}\``,
        `Deposit before: \`${paymasterOnchain.summary.depositBefore || "n/a"}\``,
        `Deposit after: \`${paymasterOnchain.summary.depositAfter || "n/a"}\``,
        `Reimbursement: \`${paymasterOnchain.summary.reimbursement || "n/a"}\``,
        `Over-limit rejected: \`${paymasterOnchain.summary.overLimitRejected}\``,
        `Revoked rejected: \`${paymasterOnchain.summary.revokedRejected}\``,
        `Withdraw success: \`${paymasterOnchain.summary.withdrawSuccess}\``,
      ]),
      "",
    );
  }

  if (paymasterPolicy) {
    lines.push(
      "## Paymaster Policy Summary",
      "",
      ...[
        `- Report path: \`${paymasterPolicy.summary.reportPath || "n/a"}\``,
        `- Policy ID: \`${paymasterPolicy.summary.policyId || "n/a"}\``,
        `- Account ID: \`${paymasterPolicy.summary.accountId || "n/a"}\``,
        `- Approval digest: \`${paymasterPolicy.summary.approvalDigest || "n/a"}\``,
        `- Attestation hash: \`${paymasterPolicy.summary.attestationHash || "n/a"}\``,
      ],
      "",
      "Denied cases:",
      "",
      ...((paymasterPolicy.summary.deniedCases || []).map((name) => `- ${name}`)),
      "",
    );
  }

  if (paymaster) {
    lines.push(
      "## Paymaster Relay Summary",
      "",
      markdownList([
        `Relay txid: \`${paymaster.summary.txid || "n/a"}\``,
        `Core hash: \`${paymaster.summary.coreHash || "n/a"}\``,
        `Account ID: \`${paymaster.summary.accountId || "n/a"}\``,
        `Validator id: \`${paymaster.summary.validatorId ?? "n/a"}\``,
        `Policy ID: \`${paymaster.summary.policyId ?? "n/a"}\``,
        `Approval digest: \`${paymaster.summary.approvalDigest || "n/a"}\``,
        `VM state: \`${paymaster.summary.vmstate || "n/a"}\``,
        `Result: \`${paymaster.summary.result || "n/a"}\``,
        `Refused operation: \`${paymaster.summary.refusedOperation || "n/a"}\``,
      ]),
      "",
    );
  }

  if (report.skippedStages.length > 0) {
    lines.push(
      "## Skipped Stages",
      "",
      markdownList(report.skippedStages.map((stage) => `${stage.title}: ${stage.reason}`)),
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

async function writeReports(report) {
  await mkdir(SDK_REPORT_DIR, { recursive: true });
  await mkdir(REPO_REPORT_DIR, { recursive: true });

  const latestFilename = `sa-testnet-validation-suite.latest.json`;
  const markdownFilename = `TESTNET_VALIDATION_SUMMARY.md`;

  const latestPath = path.join(SDK_REPORT_DIR, latestFilename);
  const markdownPath = path.join(REPO_REPORT_DIR, markdownFilename);

  await writeFile(latestPath, JSON.stringify(report, null, 2));
  await writeFile(markdownPath, buildMarkdownReport(report));

  return { jsonPath: latestPath, latestPath, markdownPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = {
    createdAt: nowIso(),
    environment: envSnapshot(),
    stages: [],
    skippedStages: [],
  };

  if (args.dryRun) {
    console.log(`Dry run only. Run id ${SUITE_RUN_ID}. Planned stages:`);
    for (const stage of STAGES) {
      const missingEnv = missingRequiredEnv(stage);
      const skipReason = optionalSkipReason(stage);
      if (skipReason) {
        console.log(`- ${stage.title}: skip (${skipReason})`);
        continue;
      }
      if (missingEnv.length > 0) {
        // A required stage without its env aborts the real run, so the dry run
        // says so instead of listing a command that cannot start.
        console.log(`- ${stage.title}: ${stage.optional ? "skip" : "blocked"} (${missingEnv.join(", ")} missing)`);
        continue;
      }
      console.log(`- ${stage.title}: ${stage.command.join(" ")}`);
    }
    return;
  }

  for (const stage of STAGES) {
    const missingEnv = missingRequiredEnv(stage);
    const skipReason = optionalSkipReason(stage);
    if (skipReason) {
      report.skippedStages.push({ id: stage.id, title: stage.title, reason: skipReason });
      console.log(`\n==> skipping ${stage.command.join(" ")} (${skipReason})`);
      continue;
    }
    if (missingEnv.length > 0) {
      if (stage.optional) {
        const reason = `skipped because ${missingEnv.join(", ")} ${missingEnv.length > 1 ? "are" : "is"} missing`;
        report.skippedStages.push({ id: stage.id, title: stage.title, reason });
        console.log(`\n==> skipping ${stage.command.join(" ")} (${reason})`);
        continue;
      }
      throw new Error(`Missing required env for ${stage.title}: ${missingEnv.join(", ")}`);
    }

    console.log(`\n==> ${stage.command.join(" ")}`);
    const result = await runStage(stage);
    report.stages.push(result);
  }

  const paths = await writeReports(report);
  console.log("\n==> validation suite report");
  console.log(JSON.stringify(paths, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
