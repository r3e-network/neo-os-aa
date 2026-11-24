import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { webcrypto } from "node:crypto";
import { sha256, ripemd160 } from "ethers";
import {
  createNativeRpcFixture,
  nativeTestCustody,
  nativeTestRecovery,
  nativeTestRecoverySeat,
  nativeTestSalt,
  nativeTestIdentity,
} from "./fixtures/nativeRpcFixture.js";
import {
  nativeCodec as c,
  NATIVE_SMART_ACCOUNT_CONTRACT as CORE,
} from "../src/features/native/nativeWorkspace.js";
import { createNativeTransactionArtifactTools } from "../src/shared/nativeTransactionArtifact.mjs";
import { createNativeWalletWitnessTools } from "../src/shared/nativeWalletWitness.mjs";
import { getAddressFromScriptHash } from "../src/utils/neo.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const evidenceDir =
  process.env.NATIVE_WORKSPACE_EVIDENCE_DIR || join(tmpdir(), "sa-native-workspace");
const evidenceStage = process.env.NATIVE_WORKSPACE_EVIDENCE_STAGE || "current";
// The one success notice the v4 workspace emits after discovery: the node
// answered the v4 protocol, the full native ABI and the shipped implementation.
const PROFILE_READY =
  "Node supports the current SmartAccount protocol.";

const browserPage = async (browser, { width = 1440, height = 1100 } = {}) =>
  browser.newPage({ viewport: { width, height }, acceptDownloads: true });

test(
  "native route: verify, create, backup, wallet handoff, module administration, freeze review, stale endpoint and mobile read-only",
  { timeout: 120000 },
  async (t) => {
    const fixture = createNativeRpcFixture(),
      requests = [],
      errors = [];
    // The createAccount/freeze scripts are built with CallFlags.All (15), so the
    // fixture's read surface never answers them. Remember the last simulated
    // plan so a receipt can return the exact bytes and signers that were
    // reviewed instead of a re-derived guess.
    let reviewedScript = "",
      reviewedSigners = [];
    await mkdir(evidenceDir, { recursive: true });
    const server = await createServer({
      root,
      server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/*"] } },
      logLevel: "error",
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    const page = await browserPage(browser);
    page.setDefaultTimeout(15000);
    try {
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.route("https://native.fixture.test/rpc", async (route) => {
        const { id, method, params } = route.request().postDataJSON();
        const result = await fixture.send(method, params);
        if (method === "invokescript") {
          const script = Buffer.from(params[0], "base64").toString("hex");
          if (!fixture.answers().has(script)) {
            reviewedScript = script;
            reviewedSigners = params[1] ?? [];
          }
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id, result }),
        });
      });
      await page.exposeFunction("nativeWalletInvoke", async (request) => {
        requests.push(request);
        fixture.state.registered = true;
        fixture.state.script = reviewedScript;
        fixture.state.signers = reviewedSigners;
        return { txid: "aa".repeat(32) };
      });
      await page.addInitScript(
        ({ address, hash }) => {
          localStorage.setItem("sa_locale", "en");
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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
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
        "registration stays disabled until native discovery succeeds",
      );
      await page
        .getByTestId("native-endpoint")
        .fill("https://native.fixture.test/rpc");
      await page.getByTestId("native-network").fill("123");
      await page.getByRole("button", { name: "Verify node", exact: true }).click();
      await page
        .getByRole("status")
        .filter({ hasText: PROFILE_READY })
        .waitFor();
      await page
        .getByRole("button", { name: "Use connected Neo wallet", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Live wallet identity checked. No transaction was signed." })
        .waitFor();
      await page.getByTestId("native-salt").fill(nativeTestSalt);
      await t.test("a partial initial module cannot be reviewed as a module-free account", async () => {
        const details = page.getByTestId("native-initial-install");
        const button = page.getByRole("button", { name: "Review registration", exact: true });
        await details.locator("summary").click();
        const hash = details.getByLabel("Module contract hash", { exact: true });
        const digest = details.getByLabel("Module profile digest (32 bytes)", { exact: true });
        for (const [hashText, digestText, ready] of [
          ["ab".repeat(20), "", false], ["", "cd".repeat(32), false],
          ["ab".repeat(20), "cd".repeat(32), true], ["", "", true],
        ]) {
          await hash.fill(hashText);
          await digest.fill(digestText);
          assert.equal(await button.isEnabled(), ready);
          assert.equal(await details.getByRole("alert").isVisible(), !ready);
        }
      });
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
      await page.locator(".review-heading").getByText("createAccount", { exact: true }).waitFor();
      await page
        .getByTestId("native-application-consumption")
        .getByText("0.001 GAS", { exact: true })
        .waitFor();
      await page
        .getByTestId("native-minimum-system-fee")
        .getByText("0.001 GAS", { exact: true })
        .waitFor();
      assert.equal(
        (await page.getByTestId("native-required-authorities").innerText()).trim(),
        "0x" + nativeTestCustody,
        "v4 registration is authorized by custody alone",
      );
      assert.equal(requests.length, 0);
      await page
        .getByLabel(
          "I reviewed the network, authority, target, scope and fee payer.",
          { exact: true },
        )
        .check();
      await page.screenshot({
        path: join(evidenceDir, `${evidenceStage}-registration.png`),
        fullPage: true,
      });
      assert.equal(
        await page
          .getByRole("button", { name: "Send to wallet for approval", exact: true })
          .isDisabled(),
        false,
        "a single custody authority the fee payer controls is wallet-invokable",
      );
      await page
        .getByRole("button", { name: "Send to wallet for approval", exact: true })
        .click();
      await page.getByRole("status").filter({ hasText: "Sent to wallet." }).waitFor();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].operation, "createAccount");
      assert.deepEqual(requests[0].signers, [
        { account: "0x" + nativeTestCustody, scopes: "CalledByEntry" },
      ]);
      await page
        .getByRole("button", { name: "Check chain confirmation", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Reviewed script and authorities confirmed with HALT." })
        .waitFor();
      const transactionHash = page.getByLabel(
        "Submitted transaction hash (optional)",
        { exact: true },
      );
      await transactionHash.fill("bb".repeat(32));
      assert.equal(
        await page
          .getByRole("status")
          .filter({ hasText: "Reviewed script and authorities confirmed with HALT." })
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
        .filter({ hasText: "Reviewed script and authorities confirmed with HALT." })
        .waitFor();
      await page.getByTestId("native-salt").fill("44".repeat(32));
      assert.equal(
        await page
          .getByRole("status")
          .filter({ hasText: "Reviewed script and authorities confirmed with HALT." })
          .count(),
        0,
        "Editing the reviewed inputs clears the old transaction confirmation",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Check chain confirmation", exact: true })
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
      await page.getByRole("button", { name: "Load account", exact: true }).click();
      await page.getByTestId("native-account-summary").waitFor();
      const summary = (await page.getByTestId("native-account-summary").innerText())
        .replace(/\s+/g, " ")
        .trim();
      assert.ok(summary.includes("Not configured"), summary);
      assert.ok(summary.includes("Funding address"), summary);
      assert.match(await page.getByTestId("native-balances").innerText(), /NEO: 17 · GAS: 2.00000001/);
      assert.equal(await page.getByTestId("native-module-counts").count(), 0);
      await page.getByRole("button", { name: "Modules", exact: true }).click();
      await page.getByTestId("native-module-counts").waitFor();
      assert.equal((await page.getByTestId("native-module-counts").innerText()).replace(/\s+/g," ").trim(), "0 validators · 0 hooks · 0 recovery seats");
      await page.getByRole("button", { name: "Account & recovery", exact: true }).click();

      await page.getByRole("button", { name: "Modules", exact: true }).click();
      assert.match(await page.getByTestId("native-module-admin").innerText(), /installModule and removeModule/);
      await page.getByLabel("Action", { exact: true }).selectOption("install");
      await page.getByLabel("Module type", { exact: true }).selectOption("recovery");
      assert.equal(await page.getByLabel("Module type", { exact: true }).inputValue(), "recovery");
      assert.equal(requests.length, 1, "viewing module settings must not invoke the wallet");
      await page
        .getByRole("button", { name: "Account & recovery", exact: true })
        .click();
      await page
        .getByLabel("Fee payer Neo address / script hash", { exact: true })
        .fill(nativeTestCustody);
      await page
        .getByRole("button", { name: "Review account action", exact: true })
        .click();
      await page.locator(".review-heading").getByText("freezeAccount", { exact: true }).waitFor();
      const freezeRisk = await page.getByTestId("native-freeze-risk").innerText();
      assert.match(freezeRisk, /Freezing advances the authority epoch/);
      assert.match(freezeRisk, /custody can unfreeze through the custody route alone/);
      await page
        .getByLabel(
          "I reviewed the network, authority, target, scope and fee payer.",
          { exact: true },
        )
        .check();
      assert.equal(
        await page
          .getByRole("button", { name: "Export reviewed request", exact: true })
          .isDisabled(),
        true,
        "freeze requires its separate epoch acknowledgement",
      );
      await page
        .getByTestId("native-freeze-acknowledgement")
        .getByRole("checkbox")
        .check();
      await page.screenshot({
        path: join(evidenceDir, `${evidenceStage}-freeze-risk.png`),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(evidenceDir, `${evidenceStage}-freeze-mobile.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
        false,
      );
      await page.setViewportSize({ width: 1440, height: 1100 });
      const freezeDownload = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Export reviewed request", exact: true })
        .click();
      const freeze = JSON.parse(
        await readFile(await (await freezeDownload).path()),
      );
      assert.equal(freeze.plan.method, "freezeAccount");
      assert.equal(freeze.submission, "wallet-invoke");
      assert.deepEqual(freeze.request.signers, [
        { account: "0x" + nativeTestCustody, scopes: "CalledByEntry" },
      ]);
      assert.equal(freeze.request.operation, "freezeAccount");
      assert.equal(requests.length, 1);

      await page
        .getByLabel("Signing path", { exact: true })
        .selectOption("native-sdk");
      await page
        .getByRole("button", { name: "Review account action", exact: true })
        .click();
      await page.locator(".review-heading").getByText("freezeAccount", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByTestId("native-freeze-acknowledgement")
          .getByRole("checkbox")
          .isChecked(),
        false,
        "changing the review clears the freeze acknowledgement",
      );
      await page
        .getByLabel(
          "I reviewed the network, authority, target, scope and fee payer.",
          { exact: true },
        )
        .check();
      await page
        .getByTestId("native-freeze-acknowledgement")
        .getByRole("checkbox")
        .check();
      const sdkDownload = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Export reviewed request", exact: true })
        .click();
      const sdkReview = JSON.parse(
        await readFile(await (await sdkDownload).path()),
      );
      assert.equal(sdkReview.submission, "native-sdk");
      assert.equal(sdkReview.request, null);
      assert.equal(sdkReview.signers[0].scopes, "CustomContracts");
      assert.deepEqual(sdkReview.signers[0].allowedcontracts, ["0x" + CORE]);

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
          .getByRole("button", { name: "Export reviewed request", exact: true })
          .count(),
        0,
        "the stale profile revokes the exported review",
      );
      await page.getByRole("button", { name: "Verify node", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "RPC network magic mismatch" }).waitFor();
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
        path: join(evidenceDir, `${evidenceStage}-mobile.png`),
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
      await writeFile(
        join(evidenceDir, `${evidenceStage}-summary.json`),
        JSON.stringify({ url, consoleErrors: errors, requests, summary }, null, 2),
      );
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  "native recovery requires a supported seat and permits an independent payer only after maturity",
  { timeout: 120000 },
  async () => {
    const fixture = createNativeRpcFixture();
    fixture.state.registered = true;
    fixture.state.recovery = nativeTestRecovery;
    fixture.state.time = 1900000000000;
    const initialTime = fixture.state.time;
    const maturity = initialTime + 60000;
    const unrelatedPayer = "77".repeat(20);
    const requests = [], errors = [];
    fixture.state.pendingRecovery = {
      newCustody: "55".repeat(20),
      initiatedAt: initialTime - 60000,
      matureAt: maturity,
      authorityEpochAtInit: 1,
    };
    const server = await createServer({
      root,
      server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/*"] } },
      logLevel: "error",
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    const page = await browserPage(browser);
    page.setDefaultTimeout(15000);
    try {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
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
        return { txid: "aa".repeat(32) };
      });
      await page.addInitScript(
        ({ address, hash }) => {
          localStorage.setItem("sa_locale", "en");
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
      await page.getByTestId("native-account-id").fill(nativeTestIdentity.accountId);
      await page.getByRole("button", { name: "Load account", exact: true }).click();
      await page.getByTestId("native-account-summary").waitFor();
      const readiness = page.getByTestId("native-recovery-readiness");
      assert.match(await readiness.innerText(), /no recovery module installed/i);
      await page.getByLabel("Action", { exact: true }).selectOption("executeRecovery");
      const review = page.getByRole("button", { name: "Review account action", exact: true });
      assert.equal(await review.isDisabled(), true);
      fixture.state.modules.push(nativeTestRecoverySeat);
      await page.getByRole("button", { name: "Refresh account and chain time", exact: true }).click();
      await readiness.filter({ hasText: /Standard recovery configured/ }).waitFor();
      await page.getByLabel("Fee payer Neo address / script hash", { exact: true }).fill(unrelatedPayer);
      await page.getByLabel("Action", { exact: true }).selectOption("executeRecovery");
      await review.click();
      await page.getByRole("alert").filter({ hasText: /not matured/i }).waitFor();
      assert.equal(requests.length, 0);
      fixture.state.time = maturity;
      await page.getByRole("button", { name: "Refresh account and chain time", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Account loaded from the selected node." }).waitFor();
      await review.click();
      await page.locator(".review-heading").getByText("executeReviewedRecovery", { exact: true }).waitFor();
      await page.getByLabel("I reviewed the network, authority, target, scope and fee payer.", { exact: true }).check();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export reviewed request", exact: true }).click();
      const artifact = JSON.parse(await readFile(await (await download).path()));
      assert.equal(artifact.feePayer, unrelatedPayer);
      assert.equal(artifact.plan.targetContract, nativeTestRecoverySeat.contractHash);
      assert.equal(artifact.plan.method, "executeReviewedRecovery");
      assert.deepEqual(artifact.requiredAuthorities, []);
      assert.equal(requests.length, 0, "review does not submit a transaction");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  "signed v4 artifact import verifies public signatures, fresh preflight, exact broadcast and receipt",
  { timeout: 120000 },
  async () => {
    // A single-signature standard wallet built in the test: verification script
    // `0c21<pubkey>4156e7b327`, account = reversed hash160 of that script. The
    // v3 SDK fixture could not produce a v4 createAccount plan, so the artifact
    // is signed here with the same WebCrypto primitives the wallet uses.
    const pair = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
    const compressed =
      (raw[64] % 2 === 0 ? "02" : "03") + Buffer.from(raw.subarray(1, 33)).toString("hex");
    const verification = "0c21" + compressed + "4156e7b327";
    const walletHash160 = (hex) =>
      ripemd160(sha256("0x" + hex))
        .slice(2)
        .match(/../g)
        .reverse()
        .join("");
    const walletAccount = walletHash160(verification);
    const salt = "55".repeat(32);
    const identity = c.deriveIdentity({ custodyAddress: walletAccount, salt });
    const fixture = createNativeRpcFixture({ accountId: identity.accountId });
    const server = await createServer({
      root,
      server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/*"] } },
      logLevel: "error",
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    const page = await browserPage(browser);
    page.setDefaultTimeout(15000);
    const errors = [], submittedRaw = [], historicalRpc = [];
    let historical = false;
    let artifact = null;
    let preflights = 0,
      preflightValid = true,
      confirmed = false,
      receiptFault = false;
    try {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.addInitScript(() => localStorage.setItem("sa_locale", "en"));
      await page.route("https://native.fixture.test/rpc", async (route) => {
        const { id, method, params } = route.request().postDataJSON();
        if (historical) historicalRpc.push({ method, params });
        let result;
        if (method === "invoketransaction") {
          preflights++;
          assert.equal(Buffer.from(params[0], "base64").toString("hex"), artifact.rawTransaction);
          result = {
            hash: artifact.txid,
            network: 123,
            verification: preflightValid ? "Succeed" : "Invalid",
            state: "HALT",
            relayed: false,
            mempoolChecked: false,
            snapshot: { height: 9, hash: "0x" + "bb".repeat(32) },
            simulation: {
              mode: "single-transaction-next-block",
              height: 10,
              timestamp: String(fixture.state.time),
              primaryIndex: 0,
              view: 0,
              transactionCount: 1,
              onPersist: "HALT",
              nextConsensus: "0x" + "cc".repeat(20),
            },
            gasconsumed: "100000",
            minimumrequiredfee: "100000",
            stack: [{ type: "Any" }],
          };
        } else if (method === "sendrawtransaction") {
          submittedRaw.push(Buffer.from(params[0], "base64").toString("hex"));
          // The same bytes may be persisted even when the submission response is lost.
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: "Submission response unavailable" },
            }),
          });
          return;
        } else if (method === "getrawtransaction") {
          assert.equal(params[0], artifact.txid);
          result =
            params[1] === false
              ? Buffer.from(artifact.rawTransaction, "hex").toString("base64")
              : confirmed
                ? { hash: artifact.txid, blockhash: "0x" + "dd".repeat(32) }
                : { hash: artifact.txid };
        } else if (method === "getapplicationlog") {
          result = {
            txid: artifact.txid,
            executions: [
              {
                trigger: "Application",
                vmstate: receiptFault ? "FAULT" : "HALT",
                stack: [{ type: "Any" }],
                notifications: [],
                gasconsumed: "100000",
              },
            ],
          };
        } else result = await fixture.send(method, params);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id, result }),
        });
      });
      const port = server.httpServer.address().port;
      await page.goto(`http://127.0.0.1:${port}/native`);
      assert.equal(new URL(page.url()).pathname, "/native");
      await page.getByRole("heading", { name: "Native accounts", exact: true }).waitFor();
      await page.getByLabel("RPC endpoint", { exact: true }).fill("https://native.fixture.test/rpc");
      await page.getByLabel("Expected network magic", { exact: true }).fill("123");
      await page.getByRole("button", { name: "Verify node", exact: true }).click();
      await page.getByRole("status").filter({ hasText: PROFILE_READY }).waitFor();
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      await page.getByTestId("native-custody").fill(walletAccount);
      await page.getByTestId("native-salt").fill(salt);
      await page.getByLabel("Signing path", { exact: true }).selectOption("native-sdk");
      await page
        .getByLabel("Fee payer Neo address / script hash", { exact: true })
        .fill(walletAccount);
      await page.getByRole("button", { name: "Review registration", exact: true }).click();
      await page.locator(".review-heading").getByText("createAccount", { exact: true }).waitFor();
      await page
        .getByLabel("I reviewed the network, authority, target, scope and fee payer.", {
          exact: true,
        })
        .check();
      const reviewedDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export reviewed request", exact: true }).click();
      const archivedReview = await readFile(await (await reviewedDownload).path());
      const review = JSON.parse(archivedReview);
      assert.equal(review.plan.accountId, identity.accountId);
      assert.equal(review.submission, "native-sdk");
      assert.deepEqual(review.signers, [
        {
          account: "0x" + walletAccount,
          scopes: "CustomContracts",
          allowedcontracts: ["0x" + CORE],
        },
      ]);

      const tools = createNativeTransactionArtifactTools({
        codec: c,
        sha256: (hex) => sha256("0x" + hex).slice(2),
        walletWitness: createNativeWalletWitnessTools({ hash160: walletHash160 }),
      });
      const transaction = {
        nonce: 0,
        systemFee: "200000",
        networkFee: "50000",
        validUntilBlock: 20,
        script: review.plan.script,
        signers: review.signers,
      };
      const unsigned = tools.bytes({
        networkMagic: 123,
        transaction,
        witnesses: [{ invocation: "", verification }],
      });
      const signature = Buffer.from(
        await webcrypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          Buffer.from(unsigned.signData, "hex"),
        ),
      ).toString("hex");
      const canonical = tools.bytes({
        networkMagic: 123,
        transaction,
        witnesses: [{ invocation: "0c40" + signature, verification }],
      });
      artifact = tools.createArtifact({
        profile: review.profile,
        networkMagic: 123,
        transaction,
        witnesses: [{ invocation: "0c40" + signature, verification }],
        unsignedHex: canonical.unsignedHex,
        txid: canonical.txid,
        signData: canonical.signData,
        rawTransaction: canonical.rawTransaction,
      });
      assert.equal(artifact.txid, canonical.txid);

      const panel = page.getByTestId("native-signed-import");
      await panel.getByLabel("Maximum system fee (GAS)", { exact: true }).fill("0.003");
      await panel.getByLabel("Maximum network fee (GAS)", { exact: true }).fill("0.001");
      await panel.getByLabel("Maximum total fee (GAS)", { exact: true }).fill("0.004");
      const upload = (candidate) =>
        panel
          .getByLabel("Import signed transaction file", { exact: true })
          .setInputFiles({
            name: "signed-transaction.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify(candidate)),
          });
      await upload({ ...artifact, networkMagic: 456 });
      await page.getByRole("alert").filter({ hasText: /network mismatch/ }).waitFor();
      assert.equal(preflights, 0);
      assert.equal(submittedRaw.length, 0);
      await upload(artifact);
      await panel.getByText(artifact.txid, { exact: true }).waitFor();
      await panel.getByText("0.0025 GAS", { exact: true }).waitFor();
      await panel.getByLabel("Maximum total fee (GAS)", { exact: true }).fill("0.005");
      assert.equal(
        await panel.getByText(artifact.txid, { exact: true }).count(),
        0,
        "fee changes invalidate the imported transaction",
      );
      await upload(artifact);
      await panel.getByText(artifact.txid, { exact: true }).waitFor();
      const preflight = panel.getByRole("button", { name: "Check signed transaction", exact: true });
      const broadcast = panel.getByRole("button", {
        name: "Broadcast signed transaction",
        exact: true,
      });
      assert.equal(await broadcast.isDisabled(), true);
      preflightValid = false;
      await preflight.click();
      await page.getByRole("alert").filter({ hasText: /preflight rejected/ }).waitFor();
      assert.equal(await broadcast.isDisabled(), true);
      preflightValid = true;
      await preflight.click();
      await page.getByTestId("native-signed-preflight").waitFor();
      await page
        .getByLabel("I reviewed the network, authority, target, scope and fee payer.", {
          exact: true,
        })
        .check();
      await panel
        .getByLabel("I approve these exact signed fees and this transaction hash for broadcast.", {
          exact: true,
        })
        .check();
      assert.equal(await broadcast.isDisabled(), false);
      await page.screenshot({
        path: join(evidenceDir, `${evidenceStage}-signed-import.png`),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(evidenceDir, `${evidenceStage}-signed-import-mobile.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
      await page.setViewportSize({ width: 1440, height: 1100 });
      preflightValid = false;
      const beforeBroadcast = preflights;
      await broadcast.click();
      await page.getByRole("alert").filter({ hasText: /preflight rejected/ }).waitFor();
      assert.equal(
        preflights,
        beforeBroadcast + 1,
        "broadcast uses fresh preflight even after a successful explicit check",
      );
      assert.equal(submittedRaw.length, 0);
      preflightValid = true;
      await broadcast.click();
      await page.getByRole("alert").filter({ hasText: /Submission result is uncertain/ }).waitFor();
      assert.deepEqual(submittedRaw, [artifact.rawTransaction]);
      assert.equal(await broadcast.isDisabled(), true, "uncertain submission cannot be resent");
      const confirm = panel.getByRole("button", {
        name: "Check imported transaction confirmation",
        exact: true,
      });
      await confirm.click();
      await page.getByRole("status").filter({ hasText: /not confirmed/ }).waitFor();
      confirmed = true;
      receiptFault = true;
      await confirm.click();
      await page.getByRole("alert").filter({ hasText: /confirmed but execution failed/ }).waitFor();
      receiptFault = false;
      await confirm.click();
      await page
        .getByRole("status")
        .filter({ hasText: /exact signed bytes are confirmed and execution succeeded/ })
        .waitFor();
      assert.equal(submittedRaw.length, 1);
      historical = true;
      await page.reload();
      await page.getByRole("heading", { name: "Native accounts", exact: true }).waitFor();
      await page.getByLabel("RPC endpoint", { exact: true }).fill("https://native.fixture.test/rpc");
      await page.getByLabel("Expected network magic", { exact: true }).fill("123");
      await page.getByRole("button", { name: "Verify node", exact: true }).click();
      await page.getByRole("status").filter({ hasText: PROFILE_READY }).waitFor();
      const restored = page.getByTestId("native-receipt-restore");
      await restored.locator("summary").click();
      await restored
        .getByLabel("Archived reviewed request", { exact: true })
        .setInputFiles({
          name: "reviewed-request.json",
          mimeType: "application/json",
          buffer: archivedReview,
        });
      await restored.getByText("reviewed-request.json", { exact: true }).waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="native-receipt-restore"] input[type="file"]')
            ?.disabled === false,
      );
      const receiptUpload = (candidate) =>
        restored
          .getByLabel("Signed transaction for receipt", { exact: true })
          .setInputFiles({
            name: "signed-transaction.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify(candidate)),
          });
      await receiptUpload({ ...artifact, networkMagic: 456 });
      await restored.getByRole("button", { name: "Verify receipt files", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: /network mismatch/ }).waitFor();
      assert.equal(
        await restored.getByRole("button", { name: "Check restored receipt", exact: true }).count(),
        0,
      );
      await receiptUpload(artifact);
      await restored.getByRole("button", { name: "Verify receipt files", exact: true }).click();
      await restored.getByText(artifact.txid, { exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Broadcast signed transaction", exact: true }).count(),
        0,
        "a restored receipt never regains a submission path",
      );
      assert.equal(
        await page.getByRole("button", { name: "Check signed transaction", exact: true }).count(),
        0,
      );
      await restored.getByRole("button", { name: "Check restored receipt", exact: true }).click();
      await page
        .getByRole("status")
        .filter({ hasText: /exact signed bytes are confirmed and execution succeeded/ })
        .waitFor();
      assert.equal(submittedRaw.length, 1);
      assert.equal(preflights, 4);
      assert.equal(
        historicalRpc.some(({ method }) =>
          ["getblockcount", "invoketransaction", "sendrawtransaction"].includes(method),
        ),
        false,
        "historical receipt does not check fresh expiry or gain a submission path",
      );
      const discoveryScripts = new Set([
        c.dynamicCall(CORE, "getProtocolInfo", [], 5),
        c.dynamicCall(CORE, "getAccountImplementationId", [], 5),
      ]);
      assert.equal(
        historicalRpc
          .filter(({ method }) => method === "invokescript")
          .every(({ params }) =>
            discoveryScripts.has(Buffer.from(params[0], "base64").toString("hex")),
          ),
        true,
        "history re-verifies the live v4 profile without reading old account state",
      );
      await page.screenshot({
        path: join(evidenceDir, `${evidenceStage}-restored-receipt.png`),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(evidenceDir, `${evidenceStage}-restored-receipt-mobile.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
      await page.setViewportSize({ width: 1440, height: 1100 });
      assert.equal(await page.locator("vite-error-overlay").count(), 0);
      assert.deepEqual(errors, []);
      await writeFile(
        join(evidenceDir, `${evidenceStage}-signed-import.json`),
        JSON.stringify(
          {
            url: page.url(),
            title: await page.title(),
            consoleErrors: errors,
            submittedHash: artifact.txid,
            broadcasts: submittedRaw.length,
            preflights,
            finalStatus: await page
              .getByRole("status")
              .filter({ hasText: /exact signed bytes are confirmed and execution succeeded/ })
              .innerText(),
          },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
