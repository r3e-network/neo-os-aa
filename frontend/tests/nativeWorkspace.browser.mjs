import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
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
      await page
        .getByLabel(
          "I reviewed the network, authority, target, scope and fee payer.",
          { exact: true },
        )
        .check();
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
        assert.deepEqual(exported.request.args, [
          { type: "Hash160", value: "0x" + nativeTestIdentity.accountId },
          { type: "String", value: role },
        ]);
        assert.equal(exported.plan.script, c.dynamicCall(CORE, "cancelModuleCall", [c.hashValue(nativeTestIdentity.accountId), c.stringValue(role)]));
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
        await send();
        assert.deepEqual(requests.at(-1).args, exported.request.args);
        assert.equal(requests.at(-1).operation, "cancelModuleCall");
        await page.getByRole("button", { name: "Refresh pending policy", exact: true }).click();
        await card.getByText("No policy call is pending for this role.", { exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Review policy cancellation", exact: true }).count(), 0);
      }
      assert.equal(requests.length, 2);

      pending.set("hook", { method: "setTransferLimit", amount: "84" });
      await page.getByRole("button", { name: "Refresh pending policy", exact: true }).click();
      await page.getByTestId("native-pending-policy").waitFor();
      pending.set("hook", { method: "setTransferLimit", amount: "85" });
      await page.getByRole("button", { name: "Review policy cancellation", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: /pending.*changed|changed.*pending/i }).waitFor();
      assert.equal(await reviewMethod("cancelModuleCall").count(), 0);
      assert.equal(requests.length, 2, "a replaced pending intent must not reach the wallet");

      pendingRecovery = true;
      await page.getByRole("button", { name: "Account & recovery", exact: true }).click();
      await page.getByRole("button", { name: "Refresh account and chain time", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Account loaded from the selected node." }).waitFor();
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
      assert.equal(requests.length, 5);
      await page.screenshot({ path: "/tmp/aa-native-mature-activation-20261009.png", fullPage: true });
      assert.equal(await page.locator("vite-error-overlay").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
