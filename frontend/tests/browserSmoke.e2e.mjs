#!/usr/bin/env node

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(MODULE_DIR, "..");
const REPO_ROOT = path.resolve(FRONTEND_DIR, "..");
const HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.AA_FRONTEND_E2E_PORT || 4173);
const VITE_BIN = path.resolve(FRONTEND_DIR, "node_modules", "vite", "bin", "vite.js");
const E2E_RUN_ID = String(process.env.AA_FRONTEND_E2E_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-"));
const SCREENSHOT_DIR = path.resolve(
  process.env.AA_FRONTEND_E2E_SCREENSHOT_DIR || path.join(REPO_ROOT, ".automation-logs", "frontend-e2e", E2E_RUN_ID),
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findAvailablePort(startPort, attempts = 50) {
  for (let port = startPort; port < startPort + attempts; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, HOST);
    });
    if (available) return port;
  }
  throw new Error(
    `No available preview port found from ${startPort} to ${startPort + attempts - 1}`
  );
}

async function waitForHttpReady(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(2_000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for preview server at ${url}`);
}

async function stopProcess(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    child.kill("SIGKILL");
  }
}

async function startPreviewServer(port) {
  const baseUrl = `http://${HOST}:${port}`;
  const child = spawn(
    process.execPath,
    [VITE_BIN, "preview", "--host", HOST, "--port", String(port), "--strictPort"],
    {
      cwd: FRONTEND_DIR,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  try {
    await waitForHttpReady(baseUrl);
  } catch (error) {
    await stopProcess(child);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`.trim());
  }

  return { child, baseUrl, output: () => output };
}

async function waitForVisible(locator, label, timeoutMs = 30_000) {
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await locator.isVisible(), true, `${label} should be visible`);
}

async function waitForText(locator, pattern, label, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = (await locator.textContent().catch(() => "")) || "";
    if (pattern.test(text.replace(/\s+/g, " "))) return;
    await sleep(250);
  }
  assert.fail(`${label} should contain ${pattern}`);
}

async function ensureScreenshotDir() {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
}

function safeScreenshotName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "shot";
}

async function captureScreenshot(page, name) {
  await ensureScreenshotDir();
  const filename = `${safeScreenshotName(name)}.png`;
  const filePath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

test("browser smoke covers home, identity, app workspace, market, and docs", async (t) => {
  const server = await startPreviewServer(await findAvailablePort(DEFAULT_PORT));
  t.after(async () => {
    await stopProcess(server.child);
  });

  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const baseUrl = server.baseUrl;

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForVisible(
    page.getByRole("link", { name: /Open App Workspace/i }).first(),
    "open app workspace link"
  );
  await waitForVisible(page.getByRole("heading", { name: /Neo AA Operations Console/i }), "home hero");
  await assert.doesNotReject(() => page.title(), "home title should be readable");
  await captureScreenshot(page, "desktop-home");

  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await waitForVisible(page.getByRole("heading", { name: /Abstract Account Workspace/i }), "workspace heading");
  await waitForVisible(
    page.locator("#main-content").getByRole("button", { name: /Connect Wallet/i }),
    "connect wallet button"
  );
  await captureScreenshot(page, "desktop-app");

  await page.goto(`${baseUrl}/identity`, { waitUntil: "domcontentloaded" });
  await waitForVisible(page.getByRole("heading", { name: /Web3Auth \/ NeoDID Workspace/i }), "identity heading");
  await waitForVisible(page.getByText(/Identity Control Plane/i).first(), "identity eyebrow");
  await captureScreenshot(page, "desktop-identity");

  await page.goto(`${baseUrl}/market`, { waitUntil: "domcontentloaded" });
  await waitForVisible(
    page.getByRole("heading", { name: /Create or settle an AA listing/i }),
    "market heading"
  );
  await waitForVisible(
    page.getByRole("heading", { name: /Vanity Address Generator/i }),
    "market vanity generator"
  );
  await page.locator("#vanity-generator").getByRole("button", { name: /^Suffix$/i }).click();
  await waitForText(page.locator("#vanity-generator"), /end of the address/i, "suffix vanity hint");
  await page.locator("#vanity-generator").getByRole("button", { name: /^Contains$/i }).click();
  await waitForText(page.locator("#vanity-generator"), /anywhere after N/i, "contains vanity hint");
  await waitForVisible(
    page.getByRole("heading", { name: /Create Escrow Listing/i }),
    "market listing form"
  );
  await captureScreenshot(page, "desktop-market");

  await page.goto(`${baseUrl}/docs`, { waitUntil: "domcontentloaded" });
  await waitForVisible(page.getByText(/^Documentation$/).first(), "docs heading");
  await waitForVisible(page.getByLabel(/Search documentation/i), "docs search");
  await captureScreenshot(page, "desktop-docs");

  // Mobile sanity snapshots for readability / density checks.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForVisible(page.getByRole("heading", { name: /Neo AA Operations Console/i }), "home hero (mobile)");
  await captureScreenshot(page, "mobile-home");

  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await waitForVisible(page.getByRole("heading", { name: /Abstract Account Workspace/i }), "workspace heading (mobile)");
  await captureScreenshot(page, "mobile-app");

  await page.goto(`${baseUrl}/identity`, { waitUntil: "domcontentloaded" });
  await waitForVisible(page.getByRole("heading", { name: /Web3Auth \/ NeoDID Workspace/i }), "identity heading (mobile)");
  await captureScreenshot(page, "mobile-identity");

  await page.goto(`${baseUrl}/market`, { waitUntil: "domcontentloaded" });
  await waitForVisible(
    page.getByRole("heading", { name: /Vanity Address Generator/i }),
    "market vanity generator (mobile)"
  );
  await captureScreenshot(page, "mobile-market");

  await page.goto(`${baseUrl}/docs`, { waitUntil: "domcontentloaded" });
  await waitForVisible(page.getByText(/^Documentation$/).first(), "docs heading (mobile)");
  await captureScreenshot(page, "mobile-docs");

  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const requested of ['testnet', 'invalid', '', 'mainnet&network=testnet']) {
      await page.goto(`${baseUrl}/app?network=${requested}`, { waitUntil: 'networkidle' });
      await waitForVisible(page.getByTestId('network-mismatch'), 'network mismatch guard');
      assert.equal(await page.getByRole('heading', { name: /Abstract Account Workspace/i }).count(), 0);
      assert.equal(await page.getByRole('button', { name: /Connect Wallet/i }).count(), 0);
    }
    await captureScreenshot(page, `network-mismatch-${viewport.width}`);
    await page.getByRole('link', { name: 'Open this network home' }).click();
    await waitForVisible(page.getByRole('heading', { name: /Neo AA Operations Console/i }), 'explicit network home');
    assert.equal(new URL(page.url()).searchParams.get('network'), 'mainnet');
  }
});
