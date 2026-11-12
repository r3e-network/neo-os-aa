import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const servicePath = path.resolve("src/services/contractLookupService.js");
const n3IndexServicePath = path.resolve("src/services/n3indexService.js");

test("contract lookup service targets documented n3index contract endpoints", () => {
  assert.equal(
    fs.existsSync(servicePath),
    true,
    "expected src/services/contractLookupService.js to exist",
  );
  const source = fs.readFileSync(servicePath, "utf8");

  assert.match(source, /DEFAULT_N3INDEX_API_BASE_URL|n3IndexApiBaseUrl/);
  assert.match(source, /v_contract_overview/);
  assert.match(source, /v_account_contract_interactions/);
  assert.match(source, /\/rest\/v1\/contracts|buildContractManifestUrl/);
  assert.match(source, /resolveContractCandidates/);
  assert.match(source, /loadContractMethodsByHash/);
  assert.match(source, /searchContractsByName/);
  assert.match(source, /searchContractsByDomain/);
});

test("contract lookup service supports .matrix and .neo resolution paths", () => {
  const source = fs.readFileSync(servicePath, "utf8");

  assert.match(source, /\.matrix/);
  assert.match(source, /\.neo/);
  assert.match(source, /resolveMatrixDomain/);
  assert.match(source, /resolveNeoDomain/);
});

test("n3index service builds network-specific status and summary endpoints", () => {
  assert.equal(
    fs.existsSync(n3IndexServicePath),
    true,
    "expected src/services/n3indexService.js to exist",
  );
  const source = fs.readFileSync(n3IndexServicePath, "utf8");

  assert.match(source, /normalizeN3IndexNetwork/);
  assert.match(source, /buildNetworkSummaryPath/);
  assert.match(source, /buildNetworkStatusPath/);
  assert.match(
    source,
    /\/indexer\/v1\/networks\/\$\{normalizeN3IndexNetwork\(network\)\}\/summary/,
  );
  assert.match(
    source,
    /\/indexer\/v1\/networks\/\$\{normalizeN3IndexNetwork\(network\)\}\/status/,
  );
  assert.match(source, /fetchNetworkSummary/);
  assert.match(source, /fetchNetworkStatus/);
  assert.match(source, /redirect:\s*"error"/);
  assert.match(
    source,
    /fetchNetworkSummary\(\{\s*baseUrl,\s*fetchImpl,\s*network:\s*["']testnet["'],?\s*\}\)/,
  );
  assert.match(
    source,
    /fetchNetworkStatus\(\{\s*baseUrl,\s*fetchImpl,\s*network:\s*["']testnet["'],?\s*\}\)/,
  );
});

test("home and console request n3index data for the active runtime network", () => {
  const homeSource = fs.readFileSync(
    path.resolve("src/views/HomeView.vue"),
    "utf8",
  );
  const consoleSource = fs.readFileSync(
    path.resolve("src/views/ConsoleView.vue"),
    "utf8",
  );
  const combined = `${homeSource}\n${consoleSource}`;

  assert.doesNotMatch(combined, /fetchTestnet(Status|Summary)/);
  assert.match(homeSource, /resolveRuntimeNetwork\(\)/);
  assert.match(consoleSource, /resolveRuntimeNetwork\(\)/);
  assert.match(
    homeSource,
    /fetchNetworkSummary\(\{\s*network:\s*runtimeNetwork,?\s*\}\)/,
  );
  assert.match(
    homeSource,
    /fetchNetworkStatus\(\{\s*network:\s*runtimeNetwork,?\s*\}\)/,
  );
  assert.match(
    consoleSource,
    /fetchNetworkSummary\(\{\s*network:\s*runtimeNetwork,?\s*\}\)/,
  );
  assert.match(
    consoleSource,
    /fetchNetworkStatus\(\{\s*network:\s*runtimeNetwork,?\s*\}\)/,
  );
});
