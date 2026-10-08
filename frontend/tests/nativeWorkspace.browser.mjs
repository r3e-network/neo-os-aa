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
      await page.getByText("0.001 GAS", { exact: true }).waitFor();
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
