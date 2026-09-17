import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_MAINNET_RPC_URL,
  isNeoDomain,
  normalizeNeoDomain,
  resolveContractIdentifier,
  resolveNeoDomain,
} from '../src/services/domainResolverService.js';
import { getAddressFromScriptHash } from '../src/utils/neo.js';
import { resolveMatrixDomain, buildMatrixRegistrationInvocation } from '../src/services/matrixDomainService.js';

const RESOLVED_SCRIPT_HASH = '49c095ce04d38642e39155f5481615c58227a498';
const RESOLVED_ADDRESS = getAddressFromScriptHash(RESOLVED_SCRIPT_HASH);

function createNnsFetchImpl(calls, address = RESOLVED_ADDRESS) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      async json() {
        return {
          result: {
            state: 'HALT',
            stack: [{ type: 'ByteString', value: Buffer.from(address, 'utf8').toString('base64') }],
          },
        };
      },
    };
  };
}

test('.neo fallback RPC is HTTPS and allowed by the deployed CSP', () => {
  assert.equal(DEFAULT_MAINNET_RPC_URL, 'https://api.n3index.dev/mainnet');
  assert.match(DEFAULT_MAINNET_RPC_URL, /^https:\/\//, 'mixed content: the SPA is served over HTTPS');

  const vercelConfig = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8'));
  const csp = JSON.stringify(vercelConfig);
  assert.match(csp, /connect-src[^"]*https:\/\/api\.n3index\.dev/);
  assert.doesNotMatch(csp, /seed1\.neo\.org/);
});

test('resolveNeoDomain defaults to the HTTPS mainnet RPC', async () => {
  const calls = [];
  const address = await resolveNeoDomain('example.neo', { fetchImpl: createNnsFetchImpl(calls) });

  assert.equal(address, RESOLVED_ADDRESS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.n3index.dev/mainnet');
  assert.equal(calls[0].body.method, 'invokefunction');
  assert.equal(calls[0].body.params[1], 'resolve');
});

test('resolveContractIdentifier threads the caller rpcUrl through to resolveNeoDomain', async () => {
  const calls = [];
  const resolved = await resolveContractIdentifier('example.neo', {
    rpcUrl: 'https://caller-rpc.example.org',
    fetchImpl: createNnsFetchImpl(calls),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://caller-rpc.example.org');
  assert.equal(resolved.kind, 'neo-domain');
  assert.equal(resolved.domain, 'example.neo');
  assert.equal(resolved.address, RESOLVED_ADDRESS);
  assert.equal(resolved.contractHash, RESOLVED_SCRIPT_HASH);
});

test('resolveNeoDomain raises EC_nns_resolve_fault on FAULT results', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { result: { state: 'FAULT', exception: 'token not found', stack: [] } };
    },
  });

  await assert.rejects(
    () => resolveNeoDomain('missing.neo', { fetchImpl }),
    /EC_nns_resolve_fault/,
  );
});

test('domain helpers normalize .neo identifiers', () => {
  assert.equal(isNeoDomain('Example.NEO'), true);
  assert.equal(isNeoDomain('example.matrix'), false);
  assert.equal(normalizeNeoDomain('Example'), 'example.neo');
});

test('contract lookup service reuses the single resolver implementation', () => {
  const source = fs.readFileSync(path.resolve('src/services/contractLookupService.js'), 'utf8');

  assert.doesNotMatch(source, /seed1\.neo\.org/);
  assert.doesNotMatch(source, /export async function resolveNeoDomain/);
  assert.match(source, /from '@\/services\/domainResolverService\.js'/);
  assert.match(source, /resolveNeoDomain/);
});

test('.matrix contract identifiers resolve via the supplied on-chain registry and transport', async () => {
  const calls = [];
  const registry = '994c3cbe0d8641b9c911452c37191de8dd9f5f4e';
  const result = await resolveContractIdentifier('Core.NeoOS.MATRIX', {
    rpcUrl: 'https://rpc.example.test/testnet', matrixContractHash: registry,
    fetchImpl: createNnsFetchImpl(calls),
  });
  assert.equal(result.kind, 'matrix-domain');
  assert.equal(result.domain, 'core.neoos.matrix');
  assert.equal(result.contractHash, RESOLVED_SCRIPT_HASH);
  assert.deepEqual(calls[0].body.params, [registry, 'resolve', [
    { type: 'String', value: 'core.neoos.matrix' }, { type: 'Integer', value: 16 },
  ]]);
  assert.equal(calls[0].url, 'https://rpc.example.test/testnet');
});

test('.matrix fails before network access when registry or domain is invalid', async () => {
  let calls = 0;
  const fetchImpl = () => { calls += 1; throw new Error('unexpected network access'); };
  await assert.rejects(resolveMatrixDomain('core.neoos.matrix', { matrixContractHash: '', fetchImpl }), /EC_contract_not_found/);
  await assert.rejects(resolveMatrixDomain('https://core.neoos.matrix', { matrixContractHash: '1'.repeat(40), fetchImpl }), /EC_matrix_domain_invalid/);
  assert.equal(calls, 0);
  assert.throws(() => buildMatrixRegistrationInvocation('core.neoos.matrix', RESOLVED_ADDRESS, { matrixContractHash: '' }), /EC_contract_not_found/);
  assert.throws(() => buildMatrixRegistrationInvocation('core..matrix', RESOLVED_ADDRESS, { matrixContractHash: '1'.repeat(40) }), /EC_matrix_domain_invalid/);
});

test('.matrix refuses malformed TXT addresses and faulted resolution', async () => {
  const options = { matrixContractHash: '1'.repeat(40), rpcUrl: 'https://rpc.example.test/testnet' };
  const malformed = RESOLVED_ADDRESS.slice(0, -1) + (RESOLVED_ADDRESS.endsWith('1') ? '2' : '1');
  await assert.rejects(resolveMatrixDomain('core.neoos.matrix', {
    ...options, fetchImpl: createNnsFetchImpl([], malformed),
  }), /EC_invalid_address_checksum/);
  await assert.rejects(resolveMatrixDomain('core.neoos.matrix', {
    ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ result: { state: 'FAULT', stack: [] } }) }),
  }), /EC_rpc_fault/);
  await assert.rejects(resolveMatrixDomain('core.neoos.matrix', {
    ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ result: { stack: [{ type: 'ByteString', value: Buffer.from(RESOLVED_ADDRESS).toString('base64') }] } }) }),
  }), /EC_rpc_fault/);
});
