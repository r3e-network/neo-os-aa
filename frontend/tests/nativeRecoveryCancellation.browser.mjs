import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createNativeRpcFixture,
  nativeTestCustody,
  nativeTestRecovery,
  nativeTestRecoverySeat,
  nativeTestIdentity,
} from "./fixtures/nativeRpcFixture.js";
import { getAddressFromScriptHash } from "../src/utils/neo.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const payer = "66".repeat(20);
const PROFILE_READY =
  "Node supports the current SmartAccount protocol.";
const evidenceDir =
  process.env.NATIVE_CANCELLATION_EVIDENCE_DIR ||
  join(tmpdir(), "sa-native-recovery-cancellation");
const evidenceStage = process.env.NATIVE_CANCELLATION_EVIDENCE_STAGE || "current";

test("recovery cancellation separates its payer and authority and invalidates stale UI", {
  timeout: 120000,
}, async () => {
  const fixture = createNativeRpcFixture();
  fixture.state.registered = true;
  // v4 keeps the recovery authority in the account descriptor; a zero address
  // disables it, so the fixture must declare the separately controlled wallet.
  fixture.state.recovery = nativeTestRecovery;
  fixture.state.modules.push(nativeTestRecoverySeat);
  fixture.state.time = 1900000000000;
  const maturity = fixture.state.time + 60000;
  fixture.state.pendingRecovery = {
    newCustody: "55".repeat(20),
    initiatedAt: fixture.state.time - 60000,
    matureAt: maturity,
    authorityEpochAtInit: 1,
  };
  const errors = [], simulations = [];
  await mkdir(evidenceDir, { recursive: true });
  const server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/*"] } },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(15000);
  try {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.addInitScript(() => localStorage.setItem("sa_locale", "en"));
    await page.route("https://native.fixture.test/rpc", async (route) => {
      const { id, method, params } = route.request().postDataJSON();
      const result = await fixture.send(method, params);
      if (method === "invokescript") {
        // A plan the read surface does not answer is a reviewed account action.
        const script = Buffer.from(params[0], "base64").toString("hex");
        if (!fixture.answers().has(script))
          simulations.push({ script, signers: structuredClone(params[1] ?? []) });
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id, result }),
      });
    });
    await page.exposeFunction("nativeWalletInvoke", async (request) => {
      simulations.push({ invoked: request });
      return { txid: "aa".repeat(32) };
    });
    await page.addInitScript(
      ({ address, hash }) => {
        window.__nativeWalletAccount = { address, hash };
        window.neo3Dapi = {
          getAccount: async () => window.__nativeWalletAccount,
          getNetwork: async () => ({ magic: 123 }),
          invoke: (request) => window.nativeWalletInvoke(request),
        };
      },
      { address: getAddressFromScriptHash(nativeTestCustody), hash: nativeTestCustody },
    );
    const url = `http://127.0.0.1:${server.httpServer.address().port}/native`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.getByRole("heading", { name: "Native accounts", exact: true }).waitFor();
    assert.equal(page.url(), url);
    assert.match(await page.title(), /Native Accounts/);
    await page.getByTestId("native-endpoint").fill("https://native.fixture.test/rpc");
    await page.getByTestId("native-network").fill("123");
    await page.getByRole("button", { name: "Verify node", exact: true }).click();
    await page.getByRole("status").filter({ hasText: PROFILE_READY }).waitFor();
    await page.getByRole("button", { name: "Account & recovery", exact: true }).click();
    await page.getByTestId("native-account-id").fill(nativeTestIdentity.accountId);
    await page.getByRole("button", { name: "Load account", exact: true }).click();
    await page.getByTestId("native-account-summary").waitFor();
    const summary = (await page.getByTestId("native-account-summary").innerText())
      .replace(/\s+/g, " ")
      .trim();
    assert.match(summary, /Standard recovery configured/);
    assert.ok(summary.includes("Pending recovery"), summary);
    await page.getByText("Account details", { exact: true }).click();
    assert.ok((await page.getByTestId("native-account-summary").innerText()).includes("0x" + nativeTestRecovery));
    await page
      .getByRole("button", { name: "Use connected Neo wallet", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Live wallet identity checked. No transaction was signed." })
      .waitFor();
    await page.getByLabel("Action", { exact: true }).selectOption("cancelRecovery");
    await page
      .getByLabel("Fee payer Neo address / script hash", { exact: true })
      .fill(payer);
    await page.getByRole("button", { name: "Review account action", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Only custody or the recovery authority can start or cancel recovery." })
      .waitFor();
    await page.screenshot({
      path: join(evidenceDir, `${evidenceStage}-independent-payer.png`),
      fullPage: true,
    });
    await writeFile(
      join(evidenceDir, `${evidenceStage}-independent-payer.txt`),
      await page.locator("body").innerText(),
    );
    assert.equal(simulations.length, 0, "an unauthorized payer never reaches simulation");

    await page
      .getByLabel("Fee payer Neo address / script hash", { exact: true })
      .fill(nativeTestRecovery);
    await page.getByRole("button", { name: "Review account action", exact: true }).click();
    await page
      .locator(".review-heading")
      .getByText("cancelReviewedRecovery", { exact: true })
      .waitFor();
    assert.equal(
      (await page.getByTestId("native-required-authorities").innerText()).trim(),
      "0x" + nativeTestRecovery,
    );
    assert.equal(
      (await page.getByTestId("native-reviewed-authority").innerText()).trim(),
      "0x" + nativeTestRecovery,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Send to wallet for approval", exact: true })
        .isDisabled(),
      true,
      "the acknowledgement gates the wallet handoff",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Export reviewed request", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByLabel("I reviewed the network, authority, target, scope and fee payer.", {
        exact: true,
      })
      .check();
    const recoveryDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export reviewed request", exact: true }).click();
    const recoveryReview = JSON.parse(
      await readFile(await (await recoveryDownload).path()),
    );
    assert.equal(recoveryReview.submission, "wallet-invoke");
    assert.equal(recoveryReview.feePayer, nativeTestRecovery);
    assert.equal(recoveryReview.authority, nativeTestRecovery);
    assert.deepEqual(recoveryReview.requiredAuthorities, [nativeTestRecovery]);
    assert.deepEqual(recoveryReview.signers, [
      { account: "0x" + nativeTestRecovery, scopes: "CalledByEntry" },
    ]);
    assert.equal(recoveryReview.request.operation, "cancelReviewedRecovery");
    assert.equal(recoveryReview.request.scriptHash, "0x" + nativeTestRecoverySeat.contractHash);
    assert.equal(recoveryReview.simulation.state, "HALT");
    await writeFile(
      join(evidenceDir, `${evidenceStage}-recovery-authority-review.json`),
      JSON.stringify(recoveryReview, null, 2),
    );
    await page.screenshot({
      path: join(evidenceDir, `${evidenceStage}-recovery-authority.png`),
      fullPage: true,
    });

    await page
      .getByLabel("Fee payer Neo address / script hash", { exact: true })
      .fill(payer);
    await page
      .getByRole("heading", { name: "Your review appears here", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Export reviewed request", exact: true }).count(),
      0,
      "changing the payer clears the previous export",
    );
    assert.equal(
      await page.getByRole("button", { name: "Send to wallet for approval", exact: true }).count(),
      0,
    );

    // Exactly at maturity a permissionless completion becomes available while
    // the current custody keeps the right to cancel the pending recovery.
    fixture.state.time = maturity;
    await page
      .getByRole("button", { name: "Refresh account and chain time", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Account loaded from the selected node." })
      .waitFor();
    await page
      .getByLabel("Fee payer Neo address / script hash", { exact: true })
      .fill(nativeTestCustody);
    await page.getByRole("button", { name: "Review account action", exact: true }).click();
    await page
      .locator(".review-heading")
      .getByText("cancelReviewedRecovery", { exact: true })
      .waitFor();
    assert.equal(
      (await page.getByTestId("native-required-authorities").innerText()).trim(),
      "0x" + nativeTestCustody,
      "custody still controls a recovery it has not completed",
    );
    assert.equal(await page.getByRole("alert").count(), 0);

    await page.evaluate(
      ({ address, hash }) => {
        window.__nativeWalletAccount = { address, hash };
      },
      { address: getAddressFromScriptHash(payer), hash: payer },
    );
    await page
      .getByRole("button", { name: "Use connected Neo wallet", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Live wallet identity checked. No transaction was signed." })
      .waitFor();
    await page.getByLabel("Action", { exact: true }).selectOption("executeRecovery");
    await page.getByRole("button", { name: "Review account action", exact: true }).click();
    await page
      .locator(".review-heading")
      .getByText("executeReviewedRecovery", { exact: true })
      .waitFor();
    assert.match(
      (await page.getByTestId("native-required-authorities").innerText()).trim(),
      /Permissionless executor \/ hook proof/,
    );
    await page
      .getByLabel("I reviewed the network, authority, target, scope and fee payer.", {
        exact: true,
      })
      .check();
    const executeDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export reviewed request", exact: true }).click();
    const completion = JSON.parse(
      await readFile(await (await executeDownload).path()),
    );
    assert.deepEqual(completion.requiredAuthorities, []);
    assert.equal(completion.submission, "wallet-invoke");
    assert.deepEqual(completion.signers, [
      { account: "0x" + payer, scopes: "CalledByEntry" },
    ]);
    assert.equal(completion.request.operation, "executeReviewedRecovery");
    await page.getByRole("button", { name: "Send to wallet for approval", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Sent to wallet." }).waitFor();
    const invoked = simulations.filter((entry) => entry.invoked);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].invoked.operation, "executeReviewedRecovery");
    assert.deepEqual(invoked[0].invoked.signers, [
      { account: "0x" + payer, scopes: "CalledByEntry" },
    ]);
    await page.screenshot({
      path: join(evidenceDir, `${evidenceStage}-mature-permissionless.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: join(evidenceDir, `${evidenceStage}-mobile.png`),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
      false,
      "the authority and signer scopes do not overflow mobile width",
    );
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    assert.equal(
      simulations.filter((entry) => entry.script).length >= 2,
      true,
      "both the cancellation review and the permissionless completion were simulated",
    );
    assert.equal(
      fixture.state.calls.some(({ method }) => method === "sendrawtransaction"),
      false,
    );
  } finally {
    await writeFile(join(evidenceDir, `${evidenceStage}-console.json`), JSON.stringify(errors, null, 2));
    await browser.close();
    await server.close();
  }
});
