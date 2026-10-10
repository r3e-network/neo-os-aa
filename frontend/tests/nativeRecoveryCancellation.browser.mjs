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
  nativeTestIdentity,
} from "./fixtures/nativeRpcFixture.js";
import {
  nativeCodec as c,
  NATIVE_ACCOUNT_SERVICE as CORE,
} from "../src/features/native/nativeWorkspace.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const payer = "66".repeat(20);
const evidenceDir = process.env.NATIVE_CANCELLATION_EVIDENCE_DIR ||
  join(tmpdir(), "aa-native-recovery-cancellation");
const evidenceStage = process.env.NATIVE_CANCELLATION_EVIDENCE_STAGE || "current";

test("recovery cancellation separates its payer and authority and invalidates stale UI", {
  timeout: 90000,
}, async () => {
  const fixture = createNativeRpcFixture();
  fixture.state.registered = true;
  fixture.state.time = 1900000000000;
  const maturity = fixture.state.time + 60000;
  const integer = (value) => ({ type: "Integer", value: String(value) });
  const hash = (value) => ({
    type: "ByteString",
    value: Buffer.from(value, "hex").reverse().toString("base64"),
  });
  const accountRead = c.dynamicCall(CORE, "getAccount", [c.hashValue(nativeTestIdentity.accountId)], 5);
  const cancellationScript = c.dynamicCall(CORE, "cancelRecovery", [c.hashValue(nativeTestIdentity.accountId)]);
  const errors = [], simulations = [];
  await mkdir(evidenceDir, { recursive: true });
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
    await page.addInitScript(() => localStorage.setItem("aa_locale", "en"));
    await page.route("https://native.fixture.test/rpc", async (route) => {
      const { id, method, params } = route.request().postDataJSON();
      let result = await fixture.send(method, params);
      if (method === "invokescript") {
        const script = Buffer.from(params[0], "base64").toString("hex");
        if (script === accountRead) {
          result = structuredClone(result);
          result.stack[0].value[12] = {
            type: "Array",
            value: [hash("55".repeat(20)), integer(maturity - 604800000), integer(maturity), integer(fixture.state.config)],
          };
        }
        if (script === cancellationScript) {
          const signers = params[1] || [];
          simulations.push(structuredClone(signers));
          const authorized = signers.some((signer) =>
            (signer.account.replace(/^0x/, "") === nativeTestRecovery ||
              (signer.account.replace(/^0x/, "") === nativeTestCustody && fixture.state.time < maturity)) &&
            (signer.scopes === "CalledByEntry" ||
              (signer.scopes === "CustomContracts" && signer.allowedcontracts?.includes("0x" + CORE))));
          if (!authorized) result = { state: "FAULT", stack: [], exception: "Missing recovery cancellation authority", gasconsumed: "100000" };
        }
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result }) });
    });
    const url = `http://127.0.0.1:${server.httpServer.address().port}/native`;
    await page.goto(url);
    await page.getByRole("heading", { name: "Native accounts", exact: true }).waitFor();
    assert.equal(page.url(), url);
    assert.match(await page.title(), /Native Accounts/);
    await page.getByTestId("native-endpoint").fill("https://native.fixture.test/rpc");
    await page.getByTestId("native-network").fill("123");
    await page.getByRole("button", { name: "Verify node", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Native ABI 2 and network verified." }).waitFor();
    await page.getByRole("button", { name: "Account & recovery", exact: true }).click();
    await page.getByTestId("native-account-id").fill(nativeTestIdentity.accountId);
    await page.getByRole("button", { name: "Load account", exact: true }).click();
    await page.getByTestId("native-account-summary").waitFor();
    await page.getByLabel("Action", { exact: true }).selectOption("cancelRecovery");
    await page.getByLabel("Fee payer Neo address / script hash", { exact: true }).fill(payer);
    await page.getByRole("button", { name: "Review management action", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /Only recovery, or custody before maturity/ }).waitFor();
    await page.screenshot({ path: join(evidenceDir, `${evidenceStage}-independent-payer.png`), fullPage: true });
    await writeFile(join(evidenceDir, `${evidenceStage}-independent-payer.txt`), await page.locator("body").innerText());

    const authority = page.getByTestId("native-cancellation-authority");
    assert.equal(await authority.count(), 1, "Recovery cancellation must expose an authority independent from the fee payer");
    assert.equal(await page.getByLabel("Cancellation authority", { exact: true }).count(), 1);
    assert.equal(await authority.inputValue(), "", "the existing same-wallet flow remains the default");
    for (const selected of [nativeTestRecovery, nativeTestCustody]) {
      await authority.selectOption(selected);
      await page.getByRole("button", { name: "Review management action", exact: true }).click();
      await page.getByTestId("native-required-authorities").getByText("0x" + selected, { exact: true }).waitFor();
      await page.getByTestId("native-signed-import").waitFor();
      assert.equal(await page.getByRole("button", { name: "Send to wallet for approval", exact: true }).isDisabled(), true);
      await page.getByLabel("I reviewed the network, authority, target, scope and fee payer.", { exact: true }).check();
      const downloaded = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export reviewed request", exact: true }).click();
      const exported = JSON.parse(await readFile(await (await downloaded).path(), "utf8"));
      assert.equal(exported.submission, "native-sdk");
      assert.equal(exported.feePayer, payer);
      assert.equal(exported.cancellationAuthority, selected);
      assert.deepEqual(exported.requiredAuthorities, [selected]);
      assert.deepEqual(exported.signers, [
        { account: "0x" + payer, scopes: "None" },
        { account: "0x" + selected, scopes: "CustomContracts", allowedcontracts: ["0x" + CORE] },
      ]);
      assert.equal(exported.request, null);
      assert.equal(exported.simulation.state, "HALT");
      await writeFile(join(evidenceDir, `${evidenceStage}-${selected === nativeTestRecovery ? "recovery" : "custody"}-review.json`), JSON.stringify(exported, null, 2));
      await page.screenshot({ path: join(evidenceDir, `${evidenceStage}-${selected === nativeTestRecovery ? "recovery" : "custody"}-review.png`), fullPage: true });
      await authority.selectOption("");
      await page.getByRole("heading", { name: "Your review appears here", exact: true }).waitFor();
      assert.equal(await page.getByTestId("native-signed-import").count(), 0, "changing authority removes the previous signed-import flow");
      assert.equal(await page.getByRole("button", { name: "Export reviewed request", exact: true }).count(), 0, "changing authority removes the previous export");
    }
    await page.screenshot({ path: join(evidenceDir, `${evidenceStage}-invalidated-review.png`), fullPage: true });
    await authority.selectOption(nativeTestRecovery);
    await page.getByRole("button", { name: "Review management action", exact: true }).click();
    await page.getByTestId("native-signed-import").waitFor();
    await page.getByLabel("Fee payer Neo address / script hash", { exact: true }).fill("77".repeat(20));
    await page.getByRole("heading", { name: "Your review appears here", exact: true }).waitFor();
    assert.equal(await page.getByTestId("native-signed-import").count(), 0, "changing payer clears the previous signed-import flow");
    assert.equal(await page.getByRole("button", { name: "Export reviewed request", exact: true }).count(), 0, "changing payer clears the previous export");
    await page.getByLabel("Fee payer Neo address / script hash", { exact: true }).fill(payer);

    fixture.state.time = maturity;
    await page.getByRole("button", { name: "Refresh account and chain time", exact: true }).click();
    await page.getByRole("button", { name: "Review management action", exact: true }).waitFor({ state: "visible" });
    await authority.locator(`option[value="${nativeTestCustody}"]`).waitFor({ state: "attached" });
    await page.waitForFunction((custody) =>
      document.querySelector(`[data-testid="native-cancellation-authority"] option[value="${custody}"]`)?.disabled,
    nativeTestCustody);
    assert.equal(await authority.locator(`option[value="${nativeTestRecovery}"]`).isDisabled(), false);
    await authority.selectOption(nativeTestRecovery);
    await page.getByRole("button", { name: "Review management action", exact: true }).click();
    await page.getByTestId("native-required-authorities").getByText("0x" + nativeTestRecovery, { exact: true }).waitFor();
    await page.getByTestId("native-signed-import").waitFor();
    assert.equal(await page.getByRole("alert").count(), 0, "recovery authority still reviews successfully exactly at maturity");
    await page.screenshot({ path: join(evidenceDir, `${evidenceStage}-mature-recovery.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(evidenceDir, `${evidenceStage}-mobile.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, "the authority and signer scopes do not overflow mobile width");
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    assert.equal(simulations.length >= 2, true, "both selected authorities reached application simulation");
    assert.equal(fixture.state.calls.some(({ method }) => method === "sendrawtransaction"), false);
  } finally {
    await writeFile(join(evidenceDir, `${evidenceStage}-console.json`), JSON.stringify(errors, null, 2));
    await browser.close();
    await server.close();
  }
});
