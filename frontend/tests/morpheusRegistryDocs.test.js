import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MORPHEUS_PUBLIC_REGISTRY } from '../src/config/generatedMorpheusRegistry.js';

// README.md and the docs viewer's copy restate the generated Morpheus registry by
// hand. Keep both equal to it so the prose cannot drift from the gated copy.
const frontendRoot = path.resolve(import.meta.dirname, '..');
const DOCUMENTS = [
  path.join(frontendRoot, '..', 'README.md'),
  path.join(frontendRoot, 'src', 'assets', 'docs', 'repo-readme.md'),
];

const TABLE_ROWS = {
  'SA core': 'saCore',
  'Morpheus Oracle': 'morpheusOracle',
  'Morpheus DataFeed': 'morpheusDatafeed',
  'Oracle callback consumer': 'oracleCallbackConsumer',
  NeoDIDRegistry: 'morpheusNeoDid',
  'SA Web3AuthVerifier': 'saWeb3AuthVerifier',
  'SocialRecoveryVerifier v2': 'saSocialRecoveryVerifier',
};

const HASH = /`(0x[0-9a-fA-F]{40})`/;

function anchorSection(markdown, file) {
  const start = markdown.indexOf('## Canonical Morpheus Network Anchors');
  assert.notEqual(start, -1, `${file} has no Canonical Morpheus Network Anchors section`);
  const rest = markdown.slice(start + 1);
  const end = rest.search(/\n#/);
  return end === -1 ? rest : rest.slice(0, end);
}

function literal(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relative(file) {
  return path.relative(path.join(frontendRoot, '..'), file);
}

function normalizeLabel(label) {
  // The deferred docs mirror (src/assets/docs/repo-readme.md) still restates the
  // pre-rename "AA …" row labels; accept both spellings until the docs track
  // renames the mirror together with docs/ originals.
  return label.replace(/^AA /, 'SA ');
}

for (const file of DOCUMENTS) {
  const markdown = fs.readFileSync(file, 'utf8');
  const name = relative(file);

  test(`${name} anchor table matches the generated Morpheus registry`, () => {
    const rows = anchorSection(markdown, name)
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Item') && !line.startsWith('| ---'))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
    const checked = new Set();
    for (const [rawLabel, mainnetCell, testnetCell] of rows) {
      const label = normalizeLabel(rawLabel);
      const key = TABLE_ROWS[label];
      if (!key) {
        assert.ok(!HASH.test(mainnetCell) && !HASH.test(testnetCell), `${name}: add the row "${label}" to TABLE_ROWS`);
        continue;
      }
      checked.add(label);
      for (const [network, cell] of [['mainnet', mainnetCell], ['testnet', testnetCell]]) {
        const canonical = MORPHEUS_PUBLIC_REGISTRY[network].contracts[key];
        const stated = cell.match(HASH)?.[1];
        if (canonical) {
          assert.equal(stated?.toLowerCase(), canonical.toLowerCase(), `${name}: ${label} (${network})`);
        } else {
          assert.equal(stated, undefined, `${name}: ${label} (${network}) is unpublished in the registry`);
        }
      }
    }
    assert.deepEqual([...checked].sort(), Object.keys(TABLE_ROWS).sort(), `${name}: anchor rows`);
  });

  test(`${name} domain rules and status notes match the generated Morpheus registry`, () => {
    const { mainnet, testnet } = MORPHEUS_PUBLIC_REGISTRY;
    const section = anchorSection(markdown, name);
    // The deferred repo-readme mirror still spells these lines with the legacy
    // "AA" wording; accept both until the docs track renames it with docs/.
    const sa = '(?:SA|AA)';
    assert.match(section, new RegExp(`- mainnet ${sa} domain: \`${literal(mainnet.domains.sa)}\``));
    assert.match(section, new RegExp(`- mainnet ${sa} additional alias: \`${literal(mainnet.domains.saAlias)}\``));
    assert.match(section, new RegExp(`- mainnet NeoDID domain: \`${literal(mainnet.domains.neodid)}\``));
    assert.match(section, new RegExp(`- testnet currently has no shared ${sa} \/ NeoDID NNS aliases`));
    assert.deepEqual([testnet.domains.sa, testnet.domains.saAlias, testnet.domains.neodid], ['', '', '']);

    const mainnetNote = markdown.match(
      new RegExp(`canonical mainnet ${sa} anchor now points to the clean deploy \`(0x[0-9a-f]{40})\` and resolves from \`([^\`]+)\` plus \`([^\`]+)\``),
    );
    assert.ok(mainnetNote, `${name}: mainnet status note`);
    assert.deepEqual(mainnetNote.slice(1), [mainnet.contracts.saCore, mainnet.domains.sa, mainnet.domains.saAlias]);

    const testnetNote = markdown.match(
      new RegExp(`canonical shared testnet ${sa} anchor now points to the clean deployment \`(0x[0-9a-f]{40})\`, with shared \`Web3AuthVerifier\` \`(0x[0-9a-f]{40})\``),
    );
    assert.ok(testnetNote, `${name}: testnet status note`);
    assert.deepEqual(testnetNote.slice(1), [testnet.contracts.saCore, testnet.contracts.saWeb3AuthVerifier]);
  });
}
