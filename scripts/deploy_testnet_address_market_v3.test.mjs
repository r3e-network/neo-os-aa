import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'deploy_testnet_address_market_v3.js'), 'utf8');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts', 'bin', 'v3', 'AAAddressMarket.manifest.json'), 'utf8')
);

test('testnet market deployment is explicit, network-pinned, and verifies readback', () => {
  assert.match(script, /CONFIRM_TESTNET_AA_MARKET_DEPLOY/);
  assert.match(script, /networkMagic !== TESTNET_MAGIC/);
  assert.match(script, /setAllowedAA/);
  assert.match(script, /core allowlist readback is false/);
  assert.match(script, /market admin mismatch/);
  assert.match(script, /requiredAbiVerified: true/);
  assert.doesNotMatch(script, /console\.log\([^\n]*(?:WIF|secret)/i);
});

test('canonical market artifact contains the hardened lifecycle ABI', () => {
  const methods = new Set(
    manifest.abi.methods.map((method) => `${method.name}/${method.parameters.length}`)
  );
  for (const method of [
    'admin/0',
    'setAllowedAA/2',
    'isAllowedAA/1',
    'abandonListing/2',
    'createListing/5',
    'settleListing/3',
  ]) {
    assert.ok(methods.has(method), `missing ${method}`);
  }
});

test('contract hash prediction passes the deployer as UInt160 bytes, not a string', () => {
  const helpers = fs.readFileSync(path.join(root, 'scripts', 'lib', 'deploy-helpers.js'), 'utf8');
  assert.match(helpers, /getContractHash\(\s*u\.HexString\.fromHex\(account\.scriptHash\)/);
  assert.doesNotMatch(helpers, /getContractHash\(account\.scriptHash/);
});
