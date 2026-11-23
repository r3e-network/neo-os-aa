#!/usr/bin/env node
// Generates the frontend help pages under frontend/src/assets/docs/ from the
// authoritative docs/ books, so the copies cannot drift from their sources.
//
// Usage:
//   node scripts/sync-frontend-docs.mjs          regenerate every listed asset in place
//   node scripts/sync-frontend-docs.mjs --check  recompute every asset and fail (exit 1)
//                                                when any on-disk copy differs
//
// The mapping table below is the only place a page's source is declared. Two modes:
//
//   full    - the asset is a verbatim copy of one authoritative document
//             (the EN/zh overview pages mirror the root README);
//   chapter - the asset is one chapter of an authoritative book, sliced from
//             its `## <chapter>` heading (or `### <chapter>` with level: 3)
//             up to the next heading of the same or higher level, with every
//             heading demoted one level (the chapter heading becomes the page
//             H1). An optional `endBefore` heading text stops the slice early
//             when a trailing subsection belongs to a different audience.
//
// Every generated file starts with a machine marker naming its source; the
// registry (frontend/src/features/docs/registry.js) keeps loading the same
// file names, only the bytes change. Run this script after editing a book, or
// run `npm run sync:docs` from frontend/; the docsSync test runs --check so a
// stale copy fails `npm test`.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(repoRoot, 'frontend', 'src', 'assets', 'docs');

const MAPPING = [
  // English pages
  { target: 'repo-readme.md', source: 'README.md', mode: 'full' },
  {
    target: 'guide.md',
    source: 'docs/GUIDE.md',
    mode: 'chapter',
    chapter: 'How It Works & Usage Guide',
    level: 2,
  },
  {
    target: 'workflow.md',
    source: 'docs/GUIDE.md',
    mode: 'chapter',
    chapter: 'Smart Account Workflow Lifecycle',
    level: 2,
    endBefore: 'Domain-Assisted Account Workflow',
  },
  {
    target: 'data-flow.md',
    source: 'docs/ARCHITECTURE.md',
    mode: 'chapter',
    chapter: 'Data flow and storage',
    level: 2,
  },
  {
    target: 'architecture.md',
    source: 'docs/ARCHITECTURE.md',
    mode: 'chapter',
    chapter: 'Neo N3 Smart Account architecture',
    level: 2,
  },
  {
    target: 'sdk-usage.md',
    source: 'docs/SDK.md',
    mode: 'chapter',
    chapter: 'Frontend app workspace runtime',
    level: 2,
  },
  {
    target: 'evm-integration.md',
    source: 'docs/GUIDE.md',
    mode: 'chapter',
    chapter: 'Ethereum / EVM integration',
    level: 2,
  },
  {
    target: 'mixed-multisig.md',
    source: 'docs/GUIDE.md',
    mode: 'chapter',
    chapter: 'Mixed multi-sig and shared draft collection',
    level: 2,
  },
  {
    target: 'module-guide.md',
    source: 'docs/SA-MODULE-PROTOCOL.md',
    mode: 'chapter',
    chapter: 'Frontend module chooser guide',
    level: 2,
  },
  {
    target: 'MORPHEUS_PRIVATE_ACTIONS.md',
    source: 'docs/GUIDE.md',
    mode: 'chapter',
    chapter: 'Morpheus private actions and NeoDID binding',
    level: 3,
  },
  // Chinese pages
  { target: 'overview.zh.md', source: 'README.zh-CN.md', mode: 'full' },
  {
    target: 'guide.zh.md',
    source: 'docs/GUIDE.zh-CN.md',
    mode: 'chapter',
    chapter: '工作原理与使用指南',
    level: 2,
  },
  {
    target: 'workflow.zh.md',
    source: 'docs/GUIDE.zh-CN.md',
    mode: 'chapter',
    chapter: 'Smart Account 工作流生命周期',
    level: 2,
    endBefore: '域名辅助的账户工作流',
  },
  {
    target: 'data-flow.zh.md',
    source: 'docs/ARCHITECTURE.zh-CN.md',
    mode: 'chapter',
    chapter: '数据流与存储',
    level: 2,
  },
  {
    target: 'architecture.zh.md',
    source: 'docs/ARCHITECTURE.zh-CN.md',
    mode: 'chapter',
    chapter: 'Neo N3 Smart Account 架构',
    level: 2,
  },
  {
    target: 'MORPHEUS_PRIVATE_ACTIONS.zh-CN.md',
    source: 'docs/GUIDE.zh-CN.md',
    mode: 'chapter',
    chapter: 'Morpheus 私密操作与 NeoDID 绑定',
    level: 3,
  },
];

const MARKER_SCRIPT = 'scripts/sync-frontend-docs.mjs';

function readSource(relative) {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n');
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function extractChapter(text, spec) {
  const lines = text.split('\n');
  const wantedHeading = `${'#'.repeat(spec.level)} ${spec.chapter}`;
  const start = lines.indexOf(wantedHeading);
  if (start < 0) {
    throw new Error(`${spec.source}: no ${wantedHeading} heading to slice`);
  }
  const stopHeading = new RegExp(`^#{1,${spec.level}} `);
  const endBefore = spec.endBefore
    ? new RegExp(`^#{1,6} ${escapeRegExp(spec.endBefore)}$`)
    : null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (endBefore && endBefore.test(lines[i])) {
      end = i;
      break;
    }
    if (stopHeading.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end <= start) {
    throw new Error(`${spec.source}: chapter "${spec.chapter}" is empty`);
  }
  // Demote every heading so the chapter heading itself becomes the page H1: a
  // level-2 chapter loses one `#`, a level-3 chapter loses two.
  const demote = spec.level - 1;
  const slice = lines.slice(start, end).map((line) => {
    const match = line.match(/^(#{1,6}) /);
    if (!match) return line;
    return '#'.repeat(Math.max(1, match[1].length - demote)) + line.slice(match[1].length);
  });
  while (slice.length > 0 && slice[slice.length - 1].trim() === '') slice.pop();
  return `${slice.join('\n')}\n`;
}

function buildPage(entry) {
  const source = readSource(entry.source);
  const marker = `<!-- generated from ${entry.source} by ${MARKER_SCRIPT}; do not edit this file by hand -->`;
  const body = entry.mode === 'full'
    ? source
    : extractChapter(source, entry);
  return `${marker}\n\n${body}`;
}

const checkOnly = process.argv.includes('--check');
const stale = [];
for (const entry of MAPPING) {
  const target = path.join(assetsDir, entry.target);
  const generated = buildPage(entry);
  if (checkOnly) {
    const onDisk = fs.existsSync(target)
      ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
      : null;
    if (onDisk !== generated) stale.push(entry.target);
  } else {
    fs.writeFileSync(target, generated, 'utf8');
    console.log(`generated frontend/src/assets/docs/${entry.target} from ${entry.source}`);
  }
}

if (checkOnly) {
  if (stale.length > 0) {
    console.error(`docs drift: ${stale.length} frontend help page(s) differ from the authoritative docs/ books:`);
    for (const target of stale) console.error(`  frontend/src/assets/docs/${target}`);
    console.error(`run \`node ${MARKER_SCRIPT}\` (or \`npm run sync:docs\` in frontend/) to regenerate them`);
    process.exit(1);
  }
  console.log(`docs sync: all ${MAPPING.length} frontend help pages match the authoritative docs/ books`);
}
