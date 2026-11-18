import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const marketViewPath = path.resolve('src/views/AddressMarketView.vue');
const marketServicePath = path.resolve('src/services/addressMarketService.js');
const marketDocPath = path.resolve('src/assets/docs/address-market.md');
const patternInputPath = path.resolve('src/features/market/components/PatternInputSection.vue');
const i18nEnPath = path.resolve('src/i18n/index.js');
const i18nZhPath = path.resolve('src/i18n/zh-CN.js');
const marketContractPath = path.resolve('..', 'contracts', 'market', 'SAAddressMarket.cs');

// Markup from a parent SFC was extracted into colocated child components living
// in a sibling folder named after the parent (e.g. `AddressMarketView.vue` ->
// `AddressMarketView/*.vue`). This helper reads the parent file plus every
// colocated child so source-text contract assertions still check the real
// current location of the asserted markup.
function readComponentTree(parentVuePath) {
  const sources = [fs.readFileSync(parentVuePath, 'utf8')];
  const childDir = parentVuePath.replace(/\.vue$/, '');
  if (fs.existsSync(childDir) && fs.statSync(childDir).isDirectory()) {
    for (const entry of fs.readdirSync(childDir).sort()) {
      const childPath = path.join(childDir, entry);
      if (fs.statSync(childPath).isFile()) {
        sources.push(fs.readFileSync(childPath, 'utf8'));
      }
    }
  }
  return sources.join('\n\n');
}

function readSmartAccountSource() {
  const contractsDir = path.resolve('..', 'contracts');
  const files = fs.readdirSync(contractsDir)
    .filter((name) => name.startsWith('SmartAccount') && name.endsWith('.cs'))
    .sort();
  return files.map((name) => fs.readFileSync(path.join(contractsDir, name), 'utf8')).join('\n\n');
}

test('address market UI and docs describe trustless escrow semantics', () => {
  // Hero copy and per-listing escrow actions were extracted into colocated
  // AddressMarketView/*.vue child components, so scan the full component tree.
  const view = readComponentTree(marketViewPath);
  const service = fs.readFileSync(marketServicePath, 'utf8');
  const doc = fs.readFileSync(marketDocPath, 'utf8');

  assert.match(view, /Trustless escrow for SA address transfers/);
  assert.match(view, /Create Trustless Listing/);
  assert.match(view, /Buy With Escrow/);
  assert.match(view, /Refund Pending Payment/);
  assert.match(service, /invokeMultiple/);
  assert.match(service, /settleListing/);
  assert.match(service, /refundPendingPayment/);
  assert.match(doc, /atomic chain flow/i);
  assert.match(doc, /frozen|locked/i);
});

test('SA core and market contract expose escrow transfer primitives', () => {
  const core = readSmartAccountSource();
  const market = fs.readFileSync(marketContractPath, 'utf8');

  assert.match(core, /EnterMarketEscrow/);
  assert.match(core, /CancelMarketEscrow/);
  assert.match(core, /SettleMarketEscrow/);
  assert.match(core, /AssertNoMarketEscrow/);
  assert.match(core, /Account locked in market escrow/);

  assert.match(market, /CreateListing/);
  assert.match(market, /SettleListing/);
  assert.match(market, /RefundPendingPayment/);
  assert.match(market, /Only GAS accepted/);
});

test('vanity generator explains prefix, suffix, and contains matching modes', () => {
  const patternInput = fs.readFileSync(patternInputPath, 'utf8');
  const i18nEn = fs.readFileSync(i18nEnPath, 'utf8');
  const i18nZh = fs.readFileSync(i18nZhPath, 'utf8');

  assert.match(patternInput, /selectedType === "prefix"/);
  assert.match(patternInput, /selectedType === "suffix"/);
  assert.match(patternInput, /selectedType === "contains"/);
  assert.match(patternInput, /market\.vanityPrefixHint/);
  assert.match(patternInput, /market\.vanitySuffixHint/);
  assert.match(patternInput, /market\.vanityContainsHint/);

  assert.match(i18nEn, /vanityPrefixHint/);
  assert.match(i18nEn, /vanitySuffixHint/);
  assert.match(i18nEn, /vanityContainsHint/);
  assert.match(i18nZh, /vanityPrefixHint/);
  assert.match(i18nZh, /vanitySuffixHint/);
  assert.match(i18nZh, /vanityContainsHint/);
});
