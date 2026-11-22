#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import testnetRpcHelpers from "./testnet-rpc.js";
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
const { DEFAULT_TESTNET_RPC_URLS, resolveTestnetRpcCandidates } = testnetRpcHelpers;

// Every runbook reads the paying wallet as `TEST_WIF || NEO_TESTNET_WIF`, so a
// stage is ready when either one is set; requiring `TEST_WIF` alone would skip
// a suite whose operator only exported the v4-era name.
const WIF_ENV = ["TEST_WIF", "NEO_TESTNET_WIF"];

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

async function summarizeStage(stageId, stdout) {
  switch (stageId) {
    case "smoke":
      return summarizeSmoke(stdout);
    case "plugin_matrix":
      return summarizePluginMatrix(stdout);
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
  return "";
}

function buildMarkdownReport(report) {
  const smoke = report.stages.find((stage) => stage.id === "smoke");
  const pluginMatrix = report.stages.find((stage) => stage.id === "plugin_matrix");

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
