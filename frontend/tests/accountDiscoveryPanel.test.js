import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const panelPath = path.resolve(
  "src/features/operations/components/AccountDiscoveryPanel.vue",
);
const panelSource = fs.readFileSync(panelPath, "utf8");

test("account discovery lists registered accounts from the NeoOS read API", () => {
  assert.match(panelSource, /discoverAAAccountsForWallet/);
  assert.match(panelSource, /isAAReadApiConfigured/);
  assert.match(panelSource, /registeredAccounts/);
  assert.match(panelSource, /discoveredRegisteredAccounts/);
  // The wallet address is the backup owner the read API filters on, and the
  // row's Load action loads the account by its 20-byte account id.
  assert.match(panelSource, /address:\s*scriptHash/);
  assert.match(panelSource, /\$emit\('select',\s*account\.accountIdHash\)/);
});

test("the address market listing scan is optional, not the discovery gate", () => {
  const configuredGate = panelSource.match(
    /const isConfigured = computed\(\(\) => ([^)]*)\)/,
  );
  assert.ok(configuredGate, "the panel must declare its configuration gate");
  assert.match(configuredGate[1], /isAAReadApiConfigured/);
  assert.doesNotMatch(configuredGate[1], /isAddressMarketConfigured/);
  assert.match(panelSource, /isAddressMarketConfigured\(\)/);
});

test("discovered account strings exist in both locales", () => {
  for (const localeFile of ["src/i18n/index.js", "src/i18n/zh-CN.js"]) {
    const source = fs.readFileSync(path.resolve(localeFile), "utf8");
    for (const key of [
      "discoveredRegisteredAccounts",
      "registeredAtBlock",
      "verifierShort",
      "discoverNotConfigured",
      "discoverNotConfiguredHint",
      "noAccountsHint",
    ]) {
      assert.match(source, new RegExp(`${key}:`), `${localeFile} is missing ${key}`);
    }
  }
});
