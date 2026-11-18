import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath) => fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');

test('wallet service recognizes NEOLineN3 and NEOLine module-style providers', () => {
  const source = read('src/services/walletService.js');

  assert.match(source, /window\.NEOLineN3\?\.N3/);
  assert.match(source, /window\.NEOLine\?\.NEO/);
  assert.match(source, /candidate\.api\?\.getAccount/);
  assert.match(source, /candidate\.api\?\.invoke/);
  assert.doesNotMatch(source, /WalletService Debug/);
});

test('wallet service prefers standard NEP-21 providers for OneGate and NeoLine', () => {
  const source = read('src/services/walletService.js');

  assert.match(source, /window\.NEP21Provider/);
  assert.match(source, /window\.NEP21Providers/);
  assert.match(source, /window\.OneGateDapiProvider/);
  assert.match(source, /window\.Neo\?\.DapiProvider/);
  assert.match(source, /window\.neoDapiProvider/);
  assert.match(source, /Neo\.DapiProvider\.request/);
  assert.match(source, /Neo\.DapiProvider\.ready/);
  assert.match(source, /provider\.getAccounts/);
  assert.match(source, /provider\.authenticate/);
});

test('wallet service maps SA invokes onto NEP-21 invoke arrays', () => {
  const source = read('src/services/walletService.js');

  assert.match(source, /buildNep21Invocation/);
  assert.match(source, /buildNep21Signers/);
  assert.match(source, /normalizeSignerScope/);
  assert.match(source, /nep21\.api\.invoke\(\s*\[/);
  assert.match(source, /invokeArgs\.map\(\(entry\) => buildNep21Invocation/);
  assert.match(source, /normalizeTxResult/);
});
