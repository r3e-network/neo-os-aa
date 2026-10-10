import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import {
  createNativeRpcFixture,
  nativeTestCustody,
  nativeTestRecovery,
  nativeTestSalt,
  nativeTestIdentity,
} from "./fixtures/nativeRpcFixture.js";
import {
  nativeCodec as c,
  NATIVE_ACCOUNT_SERVICE as CORE,
} from "../src/features/native/nativeWorkspace.js";
import { getAddressFromScriptHash } from "../src/utils/neo.js";
const root = fileURLToPath(new URL("..", import.meta.url));

test(
  "native route: verify, create, backup, wallet handoff, recovery review, stale endpoint and mobile read-only",
  { timeout: 90000 },
  async () => {
    const fixture = createNativeRpcFixture(),
      requests = [],
      errors = [];
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
    try {
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.route("https://native.fixture.test/rpc", async (route) => {
        const { id, method, params } = route.request().postDataJSON();
        const result = await fixture.send(method, params);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id, result }),
        });
      });
      await page.exposeFunction("nativeWalletInvoke", async (request) => {
        requests.push(request);
        fixture.state.registered = true;
        fixture.state.signers = request.signers;
        fixture.state.script = c.dynamicCall(CORE, "registerAccount", [
          c.hashValue(nativeTestCustody),
          { type: "ByteString", value: nativeTestSalt },
          c.hashValue("00".repeat(20)),
          c.hashValue("00".repeat(20)),
          c.hashValue(nativeTestRecovery),
        ]);
        return { txid: "aa".repeat(32) };
      });
      await page.addInitScript(
        ({ address, hash }) => {
          localStorage.setItem("aa_locale", "en");
          window.neo3Dapi = {
            getAccount: async () => ({ address, hash }),
            getNetwork: async () => ({ magic: 123 }),
            invoke: (request) => window.nativeWalletInvoke(request),
          };
        },
        {
          address: getAddressFromScriptHash(nativeTestCustody),
          hash: nativeTestCustody,
        },
      );
      const url = `http://127.0.0.1:${server.httpServer.address().port}/native`;
      await page.goto(url);
      await page
        .getByRole("heading", { name: "Native accounts", exact: true })
        .waitFor();
      assert.match(await page.title(), /Native Accounts/);
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "Review registration", exact: true })
          .isDisabled(),
        true,
      );
      await page
        .getByTestId("native-endpoint")
        .fill("https://native.fixture.test/rpc");
      await page.getByTestId("native-network").fill("123");
      await page
        .getByRole("button", { name: "Verify node", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Native ABI 2 and network verified." })
        .waitFor();
      await page
        .getByRole("button", { name: "Use connected Neo wallet", exact: true })
        .click();
      await page.getByTestId("native-recovery").fill(nativeTestRecovery);
      await page.getByTestId("native-salt").fill(nativeTestSalt);
      const downloadPromise = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Save recovery descriptor", exact: true })
        .click();
      const download = await downloadPromise;
      const backup = await readFile(await download.path());
      assert.equal(JSON.parse(backup).accountId, nativeTestIdentity.accountId);
      await page
        .getByRole("button", { name: "Review registration", exact: true })
        .click();
      await page.getByText("registerAccount", { exact: true }).waitFor();
      await page.getByTestId("native-application-consumption").getByText("0.001 GAS", { exact: true }).waitFor();
      assert.equal(requests.length, 0);
      await page
        .getByLabel(
          "I reviewed the network, authority, target, scope and fee payer.",
          { exact: true },
        )
        .check();
      await page.screenshot({
        path: "/tmp/aa-native-desktop-20261008.png",
        fullPage: true,
      });
      await page
        .getByRole("button", {
          name: "Send to wallet for approval",
          exact: true,
        })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Sent to wallet." })
        .waitFor();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].operation, "registerAccount");
      assert.equal(requests[0].signers[0].scopes, "CalledByEntry");
      await page
        .getByRole("button", { name: "Check chain confirmation", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({
          hasText: "Reviewed script and authorities confirmed with HALT.",
        })
        .waitFor();
      const transactionHash = page.getByLabel(
        "Submitted transaction hash (optional)",
        { exact: true },
      );
      await transactionHash.fill("bb".repeat(32));
      assert.equal(
        await page
          .getByRole("status")
          .filter({
            hasText: "Reviewed script and authorities confirmed with HALT.",
          })
          .count(),
        0,
        "Changing the transaction hash clears the previous receipt confirmation",
      );
      assert.equal(await transactionHash.inputValue(), "bb".repeat(32));
      await transactionHash.fill("aa".repeat(32));
      await page
        .getByRole("button", { name: "Check chain confirmation", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({
          hasText: "Reviewed script and authorities confirmed with HALT.",
        })
        .waitFor();
      await page.getByTestId("native-salt").fill("44".repeat(32));
      await page.screenshot({
        path: "/tmp/aa-native-invalidated-confirmation-20261009.png",
        fullPage: true,
      });
      assert.equal(
        await page
          .getByRole("status")
          .filter({
            hasText: "Reviewed script and authorities confirmed with HALT.",
          })
          .count(),
        0,
        "Editing the reviewed inputs clears the old transaction confirmation",
      );
      assert.equal(
        await page
          .getByRole("button", {
            name: "Check chain confirmation",
            exact: true,
          })
          .count(),
        0,
      );
      await page
        .getByRole("button", { name: "Account & recovery", exact: true })
        .click();
      await page
        .getByLabel("Import recovery descriptor", { exact: true })
        .setInputFiles({
          name: "native.json",
          mimeType: "application/json",
          buffer: backup,
        });
      await page
        .getByRole("status")
        .filter({ hasText: "Descriptor identity verified." })
        .waitFor();
      assert.equal(
        await page.getByTestId("native-account-id").inputValue(),
        nativeTestIdentity.accountId,
      );
      await page
        .getByRole("button", { name: "Load account", exact: true })
        .click();
      await page.getByTestId("native-account-summary").waitFor();
      assert.match(
        await page.getByTestId("native-account-summary").innerText(),
        /Custody witness fallback/,
      );
      await page.getByRole("button", { name: "Sessions & approvals", exact: true }).click();
      await page.getByLabel("Policy", { exact: true }).selectOption("multisig");
      const thresholdInput = page.getByLabel("Required modules", { exact: true });
      assert.equal(await thresholdInput.getAttribute("max"), "2");
      const childrenInput = page.getByLabel("Ordered verifier child hashes (one per line)", { exact: true });
      for (const [count, threshold] of [[4, "2"], [3, "3"]]) {
        await childrenInput.fill(Array.from({ length: count }, (_, index) => String(index + 4).repeat(40)).join("\n"));
        await thresholdInput.fill(threshold);
        const callsBefore = fixture.state.calls.length;
        await page.getByRole("button", { name: "Review delayed policy", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "Use 1–3 unique modules and a reachable threshold of 1–2." }).waitFor();
        assert.equal(fixture.state.calls.length, callsBefore, "invalid roster must fail before RPC or wallet handoff");
        assert.equal(requests.length, 1);
      }
      await page.getByRole("button", { name: "Account & recovery", exact: true }).click();
      await page
        .getByLabel("Fee payer Neo address / script hash", { exact: true })
        .fill(nativeTestRecovery);
      await page
        .getByRole("button", { name: "Review management action", exact: true })
        .click();
      await page.getByText("freeze", { exact: true }).waitFor();
      const freezeRisk = page.getByTestId("native-freeze-risk");
      assert.ok((await freezeRisk.innerText()).includes(nativeTestCustody));
      assert.ok((await freezeRisk.innerText()).includes(nativeTestRecovery));
      assert.match(await freezeRisk.innerText(), /custody alone cannot unfreeze or replace recovery/);
      assert.match(await freezeRisk.innerText(), /pending policy calls for both verifier and hook/);
      await page
        .getByLabel(
          "I reviewed the network, authority, target, scope and fee payer.",
          { exact: true },
        )
        .check();
      assert.equal(await page.getByRole("button", { name: "Export reviewed request", exact: true }).isDisabled(), true, "freeze requires its separate risk acknowledgement");
      await page.getByTestId("native-freeze-acknowledgement").getByRole("checkbox").check();
      await page.screenshot({ path: "/tmp/native-freeze-risk-desktop-20261009.png", fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: "/tmp/native-freeze-risk-mobile-20261009.png", fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
      await page.setViewportSize({ width: 1440, height: 1100 });
      const freezeDownload = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Export reviewed request", exact: true })
        .click();
      const request = JSON.parse(
        await readFile(await (await freezeDownload).path()),
      );
      assert.equal(request.plan.method, "freeze");
      assert.equal(
        request.request.signers[0].account,
        "0x" + nativeTestRecovery,
      );
      assert.equal(requests.length, 1);
      await page
        .getByLabel("Signing path", { exact: true })
        .selectOption("native-sdk");
      await page
        .getByRole("button", { name: "Review management action", exact: true })
        .click();
      await page.getByText("freeze", { exact: true }).waitFor();
      assert.equal(await page.getByTestId("native-freeze-acknowledgement").getByRole("checkbox").isChecked(), false, "changing the review clears freeze acknowledgement");
      assert.equal(
        await page
          .getByRole("button", {
            name: "Send to wallet for approval",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      await page
        .getByLabel(
          "I reviewed the network, authority, target, scope and fee payer.",
          { exact: true },
        )
        .check();
      await page.getByTestId("native-freeze-acknowledgement").getByRole("checkbox").check();
      const sdkDownload = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Export reviewed request", exact: true })
        .click();
      const sdkReview = JSON.parse(
        await readFile(await (await sdkDownload).path()),
      );
      assert.equal(sdkReview.submission, "native-sdk");
      assert.equal(sdkReview.signers[0].scopes, "CustomContracts");
      assert.equal(sdkReview.request, null);
      await page.evaluate(() => {
        const original = File.prototype.text;
        window.__nativeOriginalText = original;
        File.prototype.text = function () {
          return new Promise((resolve) => {
            window.__nativeReleaseFile = async () =>
              resolve(await original.call(this));
          });
        };
      });
      await page
        .getByLabel("Import recovery descriptor", { exact: true })
        .setInputFiles({
          name: "native.json",
          mimeType: "application/json",
          buffer: backup,
        });
      await page.waitForFunction(
        () => typeof window.__nativeReleaseFile === "function",
      );
      await page.getByTestId("native-network").fill("456");
      await page.evaluate(async () => {
        await window.__nativeReleaseFile();
        File.prototype.text = window.__nativeOriginalText;
      });
      await page
        .getByRole("alert")
        .filter({ hasText: "Network changed during descriptor import" })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", {
            name: "Send to wallet for approval",
            exact: true,
          })
          .count(),
        0,
      );
      await page
        .getByRole("button", { name: "Verify node", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "network magic mismatch" })
        .waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "Review registration", exact: true })
          .isDisabled(),
        true,
      );
      await page.screenshot({
        path: "/tmp/aa-native-mobile-20261008.png",
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        ),
        false,
        "no mobile horizontal overflow",
      );
      assert.equal(await page.locator("vite-error-overlay").count(), 0);
      assert.deepEqual(errors, []);
      assert.equal(requests.length, 1);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  "native policy cancellation, refreshed maturity, effective recovery authority and permissionless activations",
  { timeout: 90000 },
  async () => {
    const fixture = createNativeRpcFixture();
    fixture.state.registered = true;
    fixture.state.time = 1900000000000;
    const initialTime = fixture.state.time;
    const maturity = initialTime + 60000;
    const unrelatedPayer = "66".repeat(20);
    const moduleContract = "77".repeat(20);
    const moduleCodeHash = "88".repeat(32);
    const requests = [], errors = [];
    const integer = (value) => ({ type: "Integer", value: String(value) });
    const bytes = (hex) => ({
      type: "ByteString",
      value: Buffer.from(hex, "hex").toString("base64"),
    });
    const hash = (hex) => bytes(Buffer.from(hex, "hex").reverse().toString("hex"));
    const array = (value) => ({ type: "Array", value });
    const none = { type: "Any", value: null };
    const binding = () => array([hash(moduleContract), hash(moduleCodeHash)]);
    const pending = new Map([
      ["verifier", { method: "setPolicy", amount: "42" }],
      ["hook", { method: "setTransferLimit", amount: "84" }],
    ]);
    const accountRead = c.dynamicCall(CORE, "getAccount", [c.hashValue(nativeTestIdentity.accountId)], 5);
    let pendingRecovery = false, pendingConfiguration = false;
    const server = await createServer({
      root,
      server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/*"] } },
      logLevel: "error",
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    page.setDefaultTimeout(10000);
    try {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.route("https://native.fixture.test/rpc", async (route) => {
        const { id, method, params } = route.request().postDataJSON();
        for (const role of ["verifier", "hook"]) {
          const intent = pending.get(role);
          fixture.add("getPendingModuleCall", [c.hashValue(nativeTestIdentity.accountId), c.stringValue(role)], intent
            ? array([
                integer(1), hash(nativeTestIdentity.accountId), integer(role === "verifier" ? 0 : 1),
                binding(), binding(), bytes(Buffer.from(intent.method).toString("hex")),
                array([hash(nativeTestIdentity.accountId), integer(intent.amount), { type: "Boolean", value: true }, bytes("cafe")]),
                integer(maturity - 86400000), integer(maturity), integer(0),
              ])
            : none);
        }
        const result = await fixture.send(method, params);
        if (method === "invokescript") {
          result.minimumrequiredfee = "200000";
          if (Buffer.from(params[0], "base64").toString("hex") === accountRead) {
            const record = result.stack[0].value;
            record[5] = binding();
            record[6] = binding();
            if (pendingConfiguration) {
              const moduleProposal = () => array([
                hash(moduleContract), hash(moduleCodeHash), integer(maturity - 86400000), integer(maturity), integer(0),
              ]);
              record[9] = moduleProposal();
              record[10] = moduleProposal();
              record[11] = array([hash("99".repeat(20)), integer(maturity - 86400000), integer(maturity), integer(0)]);
            }
            record[12] = pendingRecovery
              ? array([hash("55".repeat(20)), integer(initialTime - 604800001), integer(initialTime - 1), integer(0)])
              : none;
          }
        }
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result }) });
      });
      await page.exposeFunction("nativeWalletInvoke", async (request) => {
        requests.push(request);
        if (request.operation === "cancelModuleCall") pending.delete(request.args[1].value);
        return { txid: "aa".repeat(32) };
      });
      await page.addInitScript(({ address, hash }) => {
        localStorage.setItem("aa_locale", "en");
        window.__nativeWalletAccount = { address, hash };
        window.neo3Dapi = {
          getAccount: async () => window.__nativeWalletAccount,
          getNetwork: async () => ({ magic: 123 }),
          invoke: (request) => window.nativeWalletInvoke(request),
        };
      }, { address: getAddressFromScriptHash(nativeTestCustody), hash: nativeTestCustody });
      const url = `http://127.0.0.1:${server.httpServer.address().port}/native`;
      await page.goto(url);
      await page.getByRole("heading", { name: "Native accounts", exact: true }).waitFor();
      assert.equal(page.url(), url);
      assert.match(await page.title(), /Native Accounts/);
      await page.getByTestId("native-endpoint").fill("https://native.fixture.test/rpc");
      await page.getByTestId("native-network").fill("123");
      await page.getByRole("button", { name: "Verify node", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Native ABI 2 and network verified." }).waitFor();
      await page.getByTestId("native-account-id").fill(nativeTestIdentity.accountId);
      await page.getByRole("button", { name: "Load account", exact: true }).click();
      await page.getByTestId("native-account-summary").waitFor();
      await page.getByRole("button", { name: "Use connected Neo wallet", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Live wallet identity checked. No transaction was signed." }).waitFor();
      await page.getByRole("button", { name: "Sessions & approvals", exact: true }).click();
      const reviewMethod = (method) => page.locator(".review-heading").getByText(method, { exact: true });
      const accept = () => page.getByLabel("I reviewed the network, authority, target, scope and fee payer.", { exact: true }).check();
      const exportReview = async () => {
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Export reviewed request", exact: true }).click();
        return JSON.parse(await readFile(await (await download).path()));
      };
      const send = async () => {
        await page.getByRole("button", { name: "Send to wallet for approval", exact: true }).click();
        await page.getByRole("status").filter({ hasText: "Sent to wallet." }).waitFor();
      };
      for (const role of ["verifier", "hook"]) {
        const intent = pending.get(role);
        await page.getByLabel("Module role", { exact: true }).selectOption(role);
        await page.getByRole("button", { name: "Refresh pending policy", exact: true }).click();
        const card = page.getByTestId("native-pending-policy");
        await card.waitFor();
        const text = await card.innerText();
        assert.match(text, new RegExp(role));
        assert.ok(text.includes(intent.method));
        assert.ok(text.includes(moduleContract));
        assert.ok(text.includes(new Date(maturity).toISOString()));
        assert.match(text, /Waiting for chain time/);
        await card.locator("summary").click();
        const exactArguments = JSON.parse(await card.locator("pre").innerText());
        assert.deepEqual(exactArguments, { type: "Array", value: [
          c.hashValue(nativeTestIdentity.accountId),
          { type: "Integer", value: intent.amount },
          { type: "Boolean", value: true },
          { type: "ByteString", value: "cafe" },
        ] });
        await page.getByRole("button", { name: "Review policy cancellation", exact: true }).click();
        await reviewMethod("cancelModuleCall").waitFor();
        assert.equal(await page.getByTestId("native-required-authorities").innerText(), "0x" + nativeTestCustody);
        await accept();
        const exported = await exportReview();
        assert.equal(exported.plan.role, role);
        assert.equal(exported.recipe.input.role, role);
        assert.equal(exported.plan.pending.method, intent.method);
        assert.deepEqual(exported.plan.pending.invokedArguments, exactArguments);
        assert.equal(exported.submission, "native-sdk");
        assert.equal(exported.request, null);
        assert.equal(exported.plan.requiresExactScript, true);
        assert.match(exported.plan.pendingCallBytes, /^400a[0-9a-f]+$/);
        assert.notEqual(exported.plan.script, c.dynamicCall(CORE, "cancelModuleCall", [c.hashValue(nativeTestIdentity.accountId), c.stringValue(role)]));
        await page.getByText(/invoke interface rebuilds the call and cannot preserve that check/).waitFor();
        assert.equal(await page.getByRole("button", { name: "Send to wallet for approval", exact: true }).isDisabled(), true);
        await page.getByLabel("Signing path", { exact: true }).selectOption("native-sdk");
        await page.getByRole("button", { name: "Review policy cancellation", exact: true }).click();
        await reviewMethod("cancelModuleCall").waitFor();
        await accept();
        const sdkExport = await exportReview();
        assert.equal(sdkExport.submission, "native-sdk");
        assert.equal(sdkExport.request, null);
        assert.equal(sdkExport.recipe.input.role, role);
        assert.deepEqual(sdkExport.plan.pending, exported.plan.pending);
        await page.getByLabel("Module role", { exact: true }).selectOption(role === "verifier" ? "hook" : "verifier");
        assert.equal(await reviewMethod("cancelModuleCall").count(), 0, "changing the role clears the previous cancellation review");
        assert.equal(await card.count(), 0, "changing the role clears the previous pending policy inspection");
        await page.getByLabel("Module role", { exact: true }).selectOption(role);
        assert.equal(await card.count(), 0, "returning to a role requires a fresh inspection");
        await page.getByRole("button", { name: "Refresh pending policy", exact: true }).click();
        await card.waitFor();
        await card.locator("summary").click();
        assert.deepEqual(JSON.parse(await card.locator("pre").innerText()), exactArguments);
        await page.getByLabel("Signing path", { exact: true }).selectOption("wallet-invoke");
        await page.getByRole("button", { name: "Review policy cancellation", exact: true }).click();
        await reviewMethod("cancelModuleCall").waitFor();
        await accept();
        if (role === "hook") {
          await page.screenshot({ path: "/tmp/native-policy-desktop-20261009.png", fullPage: true });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.screenshot({ path: "/tmp/native-policy-mobile-20261009.png", fullPage: true });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, "pending policy review fits the mobile viewport");
          await page.setViewportSize({ width: 1440, height: 1100 });
        }
        assert.equal(await page.getByRole("button", { name: "Send to wallet for approval", exact: true }).isDisabled(), true, "selecting invoke never removes the cancellation guard");
        assert.equal(requests.length, 0);
        pending.delete(role);
        await page.getByRole("button", { name: "Refresh pending policy", exact: true }).click();
        await card.getByText("No policy call is pending for this role.", { exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Review policy cancellation", exact: true }).count(), 0);
      }
      assert.equal(requests.length, 0);

      pending.set("hook", { method: "setTransferLimit", amount: "84" });
      await page.getByRole("button", { name: "Refresh pending policy", exact: true }).click();
      await page.getByTestId("native-pending-policy").waitFor();
      pending.set("hook", { method: "setTransferLimit", amount: "85" });
      await page.getByRole("button", { name: "Review policy cancellation", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: /pending.*changed|changed.*pending/i }).waitFor();
      assert.equal(await reviewMethod("cancelModuleCall").count(), 0);
      assert.equal(requests.length, 0, "a replaced pending intent must not reach the wallet");

      pendingRecovery = true;
      await page.getByRole("button", { name: "Account & recovery", exact: true }).click();
      await page.getByRole("button", { name: "Refresh account and chain time", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Account loaded from the selected node." }).waitFor();
      await page.getByTestId("native-freeze-risk").getByText(/Starting it again requires a new proposal and a new 7-day delay/).waitFor();
      await page.getByLabel("Action", { exact: true }).selectOption("cancelRecovery");
      await page.getByLabel("Fee payer Neo address / script hash", { exact: true }).fill(nativeTestRecovery);
      await page.getByRole("button", { name: "Review management action", exact: true }).click();
      await reviewMethod("cancelRecovery").waitFor();
      assert.equal(await page.getByTestId("native-required-authorities").innerText(), "0x" + nativeTestRecovery);
      const feeValue = (label) => page.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
      assert.equal((await feeValue("Application consumption").innerText()).trim(), "0.001 GAS");
      assert.equal((await feeValue("Minimum system fee budget").innerText()).trim(), "0.002 GAS");
      await page.getByText("Not quoted; confirm in wallet or SDK", { exact: true }).waitFor();
      await page.screenshot({ path: "/tmp/aa-native-recovery-authority-20261009.png", fullPage: true });

      pendingRecovery = false;
      pendingConfiguration = true;
      await page.getByRole("button", { name: "Refresh account and chain time", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Account loaded from the selected node." }).waitFor();
      await page.getByLabel("Action", { exact: true }).selectOption("activateVerifier");
      const reviewAction = page.getByRole("button", { name: "Review management action", exact: true });
      assert.equal(await reviewAction.isDisabled(), true);
      fixture.state.time = maturity;
      assert.equal(await reviewAction.isDisabled(), true, "the loaded snapshot remains explicit until chain time is refreshed");
      await page.getByRole("button", { name: "Refresh account and chain time", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Account loaded from the selected node." }).waitFor();
      assert.equal(await reviewAction.isDisabled(), false);
      assert.ok((await page.getByTestId("native-account-summary").innerText()).includes(new Date(maturity).toISOString()));
      await page.evaluate(({ address, hash }) => {
        window.__nativeWalletAccount = { address, hash };
      }, { address: getAddressFromScriptHash(unrelatedPayer), hash: unrelatedPayer });
      await page.getByRole("button", { name: "Use connected Neo wallet", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Live wallet identity checked. No transaction was signed." }).waitFor();
      for (const action of ["activateVerifier", "activateHook", "activateRecoveryAddress"]) {
        await page.getByLabel("Action", { exact: true }).selectOption(action);
        await reviewAction.click();
        await reviewMethod(action).waitFor();
        assert.match(await page.getByTestId("native-required-authorities").innerText(), /Permissionless/);
        await accept();
        const exported = await exportReview();
        assert.deepEqual(exported.plan.requiredAuthorities, []);
        assert.deepEqual(exported.requiredAuthorities, []);
        assert.equal(exported.signers.length, 1);
        assert.equal(exported.signers[0].account, "0x" + unrelatedPayer);
        assert.equal(exported.submission, "wallet-invoke");
        assert.equal(await page.getByRole("button", { name: "Send to wallet for approval", exact: true }).isDisabled(), false);
        await send();
        assert.equal(requests.at(-1).operation, action);
        assert.deepEqual(requests.at(-1).signers, [{ account: "0x" + unrelatedPayer, scopes: "CalledByEntry" }]);
      }
      assert.equal(requests.length, 3);
      await page.screenshot({ path: "/tmp/aa-native-mature-activation-20261009.png", fullPage: true });
      assert.equal(await page.locator("vite-error-overlay").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test("signed artifact import verifies public signatures, fresh preflight, exact broadcast and receipt", { timeout: 90000 }, async () => {
  const vector = JSON.parse(await readFile(new URL("../../sdk/js/tests/fixtures/native-signed-registration.json", import.meta.url)));
  const fixture = createNativeRpcFixture();
  const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/*"] } }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(10000);
  const errors = [], submittedRaw = [], historicalRpc = [];
  let historical = false;
  let preflights = 0, preflightValid = true, confirmed = false, receiptFault = false;
  try {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript(() => localStorage.setItem("aa_locale", "en"));
    await page.route("https://native.fixture.test/rpc", async (route) => {
      const { id, method, params } = route.request().postDataJSON();
      if (historical) historicalRpc.push({ method, params });
      let result;
      if (method === "invoketransaction") {
        preflights++;
        assert.equal(Buffer.from(params[0], "base64").toString("hex"), vector.artifact.rawTransaction);
        result = {
          hash: vector.artifact.txid, network: 123, verification: preflightValid ? "Succeed" : "Invalid",
          state: "HALT", relayed: false, mempoolChecked: false,
          snapshot: { height: 9, hash: "0x" + "bb".repeat(32) },
          simulation: { mode: "single-transaction-next-block", height: 10, timestamp: String(fixture.state.time), primaryIndex: 0, view: 0, transactionCount: 1, onPersist: "HALT", nextConsensus: "0x" + "cc".repeat(20) },
          gasconsumed: "100000", minimumrequiredfee: "100000", stack: [{ type: "Boolean", value: true }],
        };
      } else if (method === "sendrawtransaction") {
        submittedRaw.push(Buffer.from(params[0], "base64").toString("hex"));
        // The same bytes may be persisted even when the submission response is lost.
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Submission response unavailable" } }) });
        return;
      } else if (method === "getrawtransaction") {
        assert.equal(params[0], vector.artifact.txid);
        result = params[1] === false ? Buffer.from(vector.artifact.rawTransaction, "hex").toString("base64")
          : confirmed ? { hash: vector.artifact.txid, blockhash: "0x" + "dd".repeat(32) } : { hash: vector.artifact.txid };
      } else if (method === "getapplicationlog") {
        result = { txid: vector.artifact.txid, executions: [{ trigger: "Application", vmstate: receiptFault ? "FAULT" : "HALT", stack: [{ type: "Boolean", value: true }], notifications: [], gasconsumed: "100000" }] };
      } else result = await fixture.send(method, params);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result }) });
    });
    const port = server.httpServer.address().port;
    await page.goto(`http://127.0.0.1:${port}/native`);
    assert.equal(new URL(page.url()).pathname, "/native");
    await page.getByRole("heading", { name: "Native accounts", exact: true }).waitFor();
    await page.getByLabel("RPC endpoint", { exact: true }).fill("https://native.fixture.test/rpc");
    await page.getByLabel("Expected network magic", { exact: true }).fill("123");
    await page.getByRole("button", { name: "Verify node", exact: true }).click();
    await page.getByText("Native ABI 2 and network verified.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.getByTestId("native-custody").fill(vector.recipe.custodyAddress);
    await page.getByTestId("native-recovery").fill(vector.recipe.recoveryAddress);
    await page.getByTestId("native-salt").fill(vector.recipe.salt);
    await page.getByLabel("Signing path", { exact: true }).selectOption("native-sdk");
    await page.getByRole("button", { name: "Review registration", exact: true }).click();
    await page.locator(".review-heading").getByText("registerAccount", { exact: true }).waitFor();
    await page.getByLabel("I reviewed the network, authority, target, scope and fee payer.", { exact: true }).check();
    const reviewedDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export reviewed request", exact: true }).click();
    const archivedReview = await readFile(await (await reviewedDownload).path());
    const panel = page.getByTestId("native-signed-import");
    await panel.getByLabel("Maximum system fee (GAS)", { exact: true }).fill("0.003");
    await panel.getByLabel("Maximum network fee (GAS)", { exact: true }).fill("0.001");
    await panel.getByLabel("Maximum total fee (GAS)", { exact: true }).fill("0.004");
    const upload = (artifact) => panel.getByLabel("Import signed transaction file", { exact: true }).setInputFiles({ name: "signed-transaction.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(artifact)) });
    await upload({ ...vector.artifact, networkMagic: 456 });
    await page.getByRole("alert").filter({ hasText: /network mismatch/ }).waitFor();
    assert.equal(preflights, 0);
    assert.equal(submittedRaw.length, 0);
    await upload(vector.artifact);
    await panel.getByText(vector.artifact.txid, { exact: true }).waitFor();
    await panel.getByText("0.0025 GAS", { exact: true }).waitFor();
    await panel.getByLabel("Maximum total fee (GAS)", { exact: true }).fill("0.005");
    assert.equal(await panel.getByText(vector.artifact.txid, { exact: true }).count(), 0, "fee changes invalidate the imported transaction");
    await upload(vector.artifact);
    await panel.getByText(vector.artifact.txid, { exact: true }).waitFor();
    const preflight = panel.getByRole("button", { name: "Check signed transaction", exact: true });
    const broadcast = panel.getByRole("button", { name: "Broadcast signed transaction", exact: true });
    assert.equal(await broadcast.isDisabled(), true);
    preflightValid = false;
    await preflight.click();
    await page.getByRole("alert").filter({ hasText: /preflight rejected/ }).waitFor();
    assert.equal(await broadcast.isDisabled(), true);
    preflightValid = true;
    await preflight.click();
    await page.getByTestId("native-signed-preflight").waitFor();
    await page.getByLabel("I reviewed the network, authority, target, scope and fee payer.", { exact: true }).check();
    await panel.getByLabel("I approve these exact signed fees and this transaction hash for broadcast.", { exact: true }).check();
    assert.equal(await broadcast.isDisabled(), false);
    await page.screenshot({ path: "/tmp/native-signed-import-desktop-20261009.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/native-signed-import-mobile-20261009.png", fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.setViewportSize({ width: 1440, height: 1100 });
    preflightValid = false;
    const beforeBroadcast = preflights;
    await broadcast.click();
    await page.getByRole("alert").filter({ hasText: /preflight rejected/ }).waitFor();
    assert.equal(preflights, beforeBroadcast + 1, "broadcast uses fresh preflight even after a successful explicit check");
    assert.equal(submittedRaw.length, 0);
    preflightValid = true;
    await broadcast.click();
    await page.getByRole("alert").filter({ hasText: /Submission result is uncertain/ }).waitFor();
    assert.deepEqual(submittedRaw, [vector.artifact.rawTransaction]);
    assert.equal(await broadcast.isDisabled(), true, "uncertain submission cannot be resent");
    const confirm = panel.getByRole("button", { name: "Check imported transaction confirmation", exact: true });
    await confirm.click();
    await page.getByRole("status").filter({ hasText: /not confirmed/ }).waitFor();
    confirmed = true;
    receiptFault = true;
    await confirm.click();
    await page.getByRole("alert").filter({ hasText: /confirmed but execution failed/ }).waitFor();
    receiptFault = false;
    await confirm.click();
    await page.getByRole("status").filter({ hasText: /exact signed bytes are confirmed and execution succeeded/ }).waitFor();
    assert.equal(submittedRaw.length, 1);
    historical = true;
    await page.reload();
    await page.getByRole("heading", { name: "Native accounts", exact: true }).waitFor();
    await page.getByLabel("RPC endpoint", { exact: true }).fill("https://native.fixture.test/rpc");
    await page.getByLabel("Expected network magic", { exact: true }).fill("123");
    await page.getByRole("button", { name: "Verify node", exact: true }).click();
    await page.getByText("Native ABI 2 and network verified.", { exact: true }).waitFor();
    const restored = page.getByTestId("native-receipt-restore");
    await restored.locator("summary").click();
    await restored.getByLabel("Archived reviewed request", { exact: true }).setInputFiles({ name: "reviewed-request.json", mimeType: "application/json", buffer: archivedReview });
    await restored.getByText("reviewed-request.json", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="native-receipt-restore"] input[type="file"]')?.disabled === false);
    const receiptUpload = (artifact) => restored.getByLabel("Signed transaction for receipt", { exact: true }).setInputFiles({ name: "signed-transaction.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(artifact)) });
    await receiptUpload({ ...vector.artifact, networkMagic: 456 });
    await restored.getByRole("button", { name: "Verify receipt files", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /network mismatch/ }).waitFor();
    assert.equal(await restored.getByRole("button", { name: "Check restored receipt", exact: true }).count(), 0);
    await receiptUpload(vector.artifact);
    await restored.getByRole("button", { name: "Verify receipt files", exact: true }).click();
    await restored.getByText(vector.artifact.txid, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Broadcast signed transaction", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Check signed transaction", exact: true }).count(), 0);
    await restored.getByRole("button", { name: "Check restored receipt", exact: true }).click();
    await page.getByRole("status").filter({ hasText: /exact signed bytes are confirmed and execution succeeded/ }).waitFor();
    assert.equal(submittedRaw.length, 1);
    assert.equal(preflights, 4);
    assert.equal(historicalRpc.some(({ method }) => ["getblockcount", "invoketransaction", "sendrawtransaction"].includes(method)), false, "historical receipt does not check fresh expiry or gain a submission path");
    assert.equal(historicalRpc.filter(({ method }) => method === "invokescript").every(({ params }) => Buffer.from(params[0], "base64").toString("hex") === c.dynamicCall(CORE, "getVersion", [], 5)), true, "history verifies the live service without reading old account state");
    await page.screenshot({ path: "/tmp/native-restored-receipt-desktop-20261009.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/native-restored-receipt-mobile-20261009.png", fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.setViewportSize({ width: 1440, height: 1100 });
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    await writeFile("/tmp/native-signed-import-evidence-20261009.json", JSON.stringify({
      url: page.url(), title: await page.title(), heading: await page.getByRole("heading", { name: "Native accounts", exact: true }).innerText(),
      consoleErrors: errors, submittedHash: vector.artifact.txid, broadcasts: submittedRaw.length, preflights,
      finalStatus: await page.getByRole("status").filter({ hasText: /exact signed bytes are confirmed and execution succeeded/ }).innerText(),
      desktopScreenshot: "/tmp/native-signed-import-desktop-20261009.png", mobileScreenshot: "/tmp/native-signed-import-mobile-20261009.png",
    }, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
});
