import { EC } from "../config/errorCodes.js";
import { RUNTIME_CONFIG } from "@/config/runtimeConfig";

export const TESTNET_SUMMARY_PATH = "/indexer/v1/networks/testnet/summary";
export const TESTNET_STATUS_PATH = "/indexer/v1/networks/testnet/status";

function trimTrailingSlash(value = "") {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

export function normalizeN3IndexNetwork(
  network = RUNTIME_CONFIG.n3IndexNetwork,
) {
  return String(network || "")
    .trim()
    .toLowerCase() === "testnet"
    ? "testnet"
    : "mainnet";
}

export function buildNetworkSummaryPath(
  network = RUNTIME_CONFIG.n3IndexNetwork,
) {
  return `/indexer/v1/networks/${normalizeN3IndexNetwork(network)}/summary`;
}

export function buildNetworkStatusPath(
  network = RUNTIME_CONFIG.n3IndexNetwork,
) {
  return `/indexer/v1/networks/${normalizeN3IndexNetwork(network)}/status`;
}

export function buildN3IndexUrl(
  path,
  { baseUrl = RUNTIME_CONFIG.n3IndexApiBaseUrl } = {},
) {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl);
  const normalizedPath = String(path || "").startsWith("/")
    ? String(path)
    : `/${String(path || "")}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

async function fetchJson(url, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(EC.rpcRequestFailed);
  }

  return response.json();
}

export async function fetchNetworkSummary({
  baseUrl = RUNTIME_CONFIG.n3IndexApiBaseUrl,
  fetchImpl,
  network = RUNTIME_CONFIG.n3IndexNetwork,
} = {}) {
  return fetchJson(
    buildN3IndexUrl(buildNetworkSummaryPath(network), { baseUrl }),
    { fetchImpl },
  );
}

export async function fetchNetworkStatus({
  baseUrl = RUNTIME_CONFIG.n3IndexApiBaseUrl,
  fetchImpl,
  network = RUNTIME_CONFIG.n3IndexNetwork,
} = {}) {
  return fetchJson(
    buildN3IndexUrl(buildNetworkStatusPath(network), { baseUrl }),
    { fetchImpl },
  );
}

export async function fetchTestnetSummary({
  baseUrl = RUNTIME_CONFIG.n3IndexApiBaseUrl,
  fetchImpl,
} = {}) {
  return fetchNetworkSummary({ baseUrl, fetchImpl, network: "testnet" });
}

export async function fetchTestnetStatus({
  baseUrl = RUNTIME_CONFIG.n3IndexApiBaseUrl,
  fetchImpl,
} = {}) {
  return fetchNetworkStatus({ baseUrl, fetchImpl, network: "testnet" });
}
