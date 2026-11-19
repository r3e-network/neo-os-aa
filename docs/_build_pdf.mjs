// Build a single merged Chinese documentation Markdown file and convert it to PDF.
// Run: node _build_pdf.mjs   (from d:/Git/neo-os/neo-os-aa/docs)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const DOCS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = 'd:/Git/neo-os/neo-os-aa/.work/pdf-build';
const require = createRequire(path.join(BUILD_DIR, 'index.js'));
const { mdToPdf } = require('md-to-pdf');

const MERGED_MD = path.join(DOCS_DIR, '_merged-zh-CN.md');
const OUTPUT_PDF = path.join(DOCS_DIR, 'Neo-Smart-Account-Documentation-zh-CN.pdf');

const PARTS = [
  {
    title: '第一部分：从这里开始',
    files: [
      'SA-SYSTEM-STATUS.zh-CN.md',
      'HOW_IT_WORKS.zh-CN.md',
      'USER_GUIDE.zh-CN.md',
      'QUICK_REFERENCE.zh-CN.md',
      'WORKFLOWS.zh-CN.md',
      'DATA_FLOW.zh-CN.md',
      'architecture.zh-CN.md',
      'NEOOS_ARCHITECTURE.zh-CN.md',
      'ORGANIZATION.zh-CN.md',
      'SA-IMPLEMENTATION-STRATEGY.zh-CN.md',
    ],
  },
  {
    title: '第二部分：原生 SmartAccount',
    files: [
      'NATIVE_SYSTEM_ARCHITECTURE.zh-CN.md',
      'NATIVE_SDK.zh-CN.md',
      'NATIVE_ACCOUNT_WORKSPACE.zh-CN.md',
      'NATIVE_ACCOUNT_USER_GUIDE.zh-CN.md',
      'NATIVE_ACCOUNT_TRANSACTION_GUARDS.zh-CN.md',
      'NATIVE_ACCOUNT_THRESHOLD_RECOVERY.zh-CN.md',
      'NATIVE_SIGNED_TRANSACTION_IMPORT.zh-CN.md',
      'NATIVE_ACCOUNT_PERFORMANCE.zh-CN.md',
      'proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.zh-CN.md',
      'proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md',
      'proposals/SMARTACCOUNT-NATIVE-MULTISIG.zh-CN.md',
      'proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.zh-CN.md',
      'proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.zh-CN.md',
      'proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.zh-CN.md',
    ],
  },
  {
    title: '第三部分：SA 运行时规范',
    files: [
      'SA-SPEC.zh-CN.md',
      'SA-EIP-712-SPEC.zh-CN.md',
      'SA-IMPLEMENTATION-REFINEMENT.zh-CN.md',
      'SA-METHOD-REFINEMENT.zh-CN.md',
      'SA-PROXY-TRANSFERS.zh-CN.md',
      'SA-MODULE-PROTOCOL.zh-CN.md',
      'SA-MIGRATION-MANIFEST.zh-CN.md',
      'SA-CONTRACT-HANDOFF.zh-CN.md',
      'SA-FRONTEND-CORRESPONDENCE.zh-CN.md',
    ],
  },
  {
    title: '第四部分：闭合与形式化验证',
    files: [
      'SA-CLOSURE-GATE.zh-CN.md',
      'SA-ENTRYPOINT-CLOSURE.zh-CN.md',
      'SA-FORMAL-VERIFICATION.zh-CN.md',
    ],
  },
  {
    title: '第五部分：账户、恢复与运维',
    files: [
      'ACCOUNT_RECOVERY_AND_IDENTITY.zh-CN.md',
      'OPERATOR_KEY_RECOVERY.zh-CN.md',
      'MORPHEUS_PRIVATE_ACTIONS.zh-CN.md',
      'action-sessions.zh-CN.md',
      'MULTISIG_SDK.zh-CN.md',
      'MULTISIG_CHILD_CONFIGURATION.zh-CN.md',
      'PENDING_CONFIG_UPDATE_READ_ABI.zh-CN.md',
      'CUSTOM_ACCOUNT_WORKSPACE.zh-CN.md',
      'mainnet-validation-runbook.zh-CN.md',
      'TESTNET_QUICKSTART.zh-CN.md',
      'testnet-validation-runbook.zh-CN.md',
      'POST_DEPLOY_SMOKE_TEST.zh-CN.md',
    ],
  },
  {
    title: '第六部分：安全、审计与对比',
    files: [
      'SECURITY_MODEL.zh-CN.md',
      'PROTOCOL_COMPLETENESS_AUDIT.zh-CN.md',
      'ETHEREUM_AA_COMPARISON.zh-CN.md',
      'FRONTEND_DEPENDENCY_SECURITY.zh-CN.md',
      'PLUGIN_DEVELOPER_GUIDE.zh-CN.md',
      'proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.zh-CN.md',
    ],
  },
  {
    title: '第七部分：构建与打包',
    files: [
      'SA-REPRODUCIBLE-BUILD.zh-CN.md',
      'NEO-PLATFORM-PACKAGES.zh-CN.md',
    ],
  },
];

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const anchorKey = (relPath) => path.basename(relPath).replace(/\.zh-CN\.md$/i, '').replace(/\.md$/i, '');
const anchorId = (key) => `doc-${key}`;

// Build the set of document keys that will actually be present in the merge.
const availableKeys = new Set();
const missing = [];
for (const part of PARTS) {
  for (const file of part.files) {
    if (existsSync(path.join(DOCS_DIR, file))) {
      availableKeys.add(anchorKey(file));
    } else {
      missing.push(file);
    }
  }
}

const stripYamlFrontMatter = (text) => {
  if (/^---\r?\n/.test(text)) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const rest = text.slice(end + 4);
      return rest.replace(/^\r?\n/, '');
    }
  }
  return text;
};

const shiftHeadings = (text) => {
  const lines = text.split('\n');
  let fence = null; // { marker: '```' | '~~~', len: number }
  const out = lines.map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = { marker, len: fenceMatch[1].length };
      } else if (marker === fence.marker && fenceMatch[1].length >= fence.len) {
        fence = null;
      }
      return line;
    }
    if (fence !== null) return line;
    const h = /^(#{1,6})(\s+.*)$/.exec(line);
    if (!h) return line;
    const level = Math.min(h[1].length + 2, 6);
    return '#'.repeat(level) + h[2];
  });
  return out.join('\n');
};

const isExternal = (target) => /^(https?:|mailto:|tel:|#|data:)/i.test(target);

const rewriteLinks = (text) => {
  // Inline links: [text](target "title")
  const inline = /\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let result = text.replace(inline, (match, label, target) => {
    if (isExternal(target)) return match;
    const withoutFragment = target.split('#')[0];
    if (!withoutFragment) return match;
    if (withoutFragment.endsWith('/')) return label;

    if (/\.zh-CN\.md$/i.test(withoutFragment)) {
      const key = withoutFragment.replace(/\.zh-CN\.md$/i, '').split('/').pop();
      return availableKeys.has(key) ? `[${label}](#${anchorId(key)})` : label;
    }
    if (/\.md$/i.test(withoutFragment)) {
      const key = withoutFragment.replace(/\.md$/i, '').split('/').pop();
      return availableKeys.has(key) ? `[${label}](#${anchorId(key)})` : label;
    }
    // Any other local target (json/js/cs/yml/txt/mediawiki/...) — keep only the label,
    // otherwise the browser resolves it against md-to-pdf's temporary localhost server.
    return label;
  });

  // Reference-style link definitions: [id]: ./file.json
  result = result.replace(/^\[([^\]]+)\]:\s*(\S+)\s*$/gm, (match, id, target) => {
    if (isExternal(target)) return match;
    const withoutFragment = target.split('#')[0];
    if (/\.zh-CN\.md$/i.test(withoutFragment)) {
      const key = withoutFragment.replace(/\.zh-CN\.md$/i, '').split('/').pop();
      return availableKeys.has(key) ? `[${id}]: #${anchorId(key)}` : '';
    }
    return '';
  });

  // Collapse reference links [text][id] / [text][] into plain text when the
  // definition was dropped above.
  result = result.replace(/\[([^\]]*)\]\[([^\]]*)\]/g, (match, label, id) => {
    const def = id || label;
    return availableKeys.has(def) ? `[${label}](#${anchorId(def)})` : label;
  });

  // Autolinks to local files: <../foo/bar.md>
  return result.replace(/<([^<>]+\.(?:md|json|js|cs|yml|yaml|txt))>/g, '$1');
};

const captionFromFile = (text, fallback) => {
  const line = text.split('\n').find((l) => /^#\s+/.test(l));
  if (!line) return fallback;
  return line.replace(/^#\s+/, '').replace(/[`*_]/g, '').trim() || fallback;
};

const tidy = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/* ------------------------------------------------------------------ */
/* merge                                                               */
/* ------------------------------------------------------------------ */

const toc = [];
const body = [];

for (const part of PARTS) {
  const entries = [];
  const chunks = [];

  for (const file of part.files) {
    const full = path.join(DOCS_DIR, file);
    if (!existsSync(full)) {
      console.warn(`[warn] missing file, skipped: ${file}`);
      continue;
    }
    const raw = stripYamlFrontMatter(readFileSync(full, 'utf8'));
    const key = anchorKey(file);
    const title = captionFromFile(raw, key);
    const processed = tidy(rewriteLinks(shiftHeadings(raw.replace(/\r\n/g, '\n'))));

    entries.push({ key, title });
    chunks.push(
      [
        `<a id="${anchorId(key)}"></a>`,
        '',
        '<div style="page-break-before: always;"></div>',
        '',
        `<!-- source: ${file} -->`,
        '',
        processed,
      ].join('\n'),
    );
  }

  toc.push({ part: part.title, entries });
  if (chunks.length) {
    body.push(
      [`## ${part.title}`, '', '---', '', chunks.join('\n\n---\n\n')].join('\n'),
    );
  }
}

const tocLines = ['## 目录', ''];
toc.forEach((section, index) => {
  if (!section.entries.length) return;
  if (index > 0) tocLines.push('');
  tocLines.push(`**${section.part}**`, '');
  for (const entry of section.entries) {
    tocLines.push(`- [${entry.title}](#${anchorId(entry.key)})`);
  }
});

const cover = [
  '# Neo Smart Account 技术文档',
  '',
  '**中文版** | 2026 年 11 月',
  '',
  '---',
  '',
  '本文档由 `docs/INDEX.zh-CN.md` 中列出的全部中文文档合并而成。',
  '产品名称：**Neo Smart Account (SA)**。',
  '',
  '<div style="page-break-after: always;"></div>',
].join('\n');

const merged = [cover, tocLines.join('\n'), '<div style="page-break-after: always;"></div>', body.join('\n\n')].join(
  '\n\n',
);

writeFileSync(MERGED_MD, merged, 'utf8');
console.log(`[ok] merged markdown: ${MERGED_MD} (${merged.length} chars)`);
if (missing.length) console.log(`[warn] ${missing.length} files missing: ${missing.join(', ')}`);

/* ------------------------------------------------------------------ */
/* pdf                                                                 */
/* ------------------------------------------------------------------ */

const CSS = `
:root {
  --ink: #1b1b1f;
  --muted: #5a5a66;
  --accent: #8a1c1c;
  --rule: #d8d4cc;
}
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "SimSun", "Segoe UI", sans-serif;
  font-size: 10.5pt;
  line-height: 1.72;
  color: var(--ink);
  letter-spacing: 0.01em;
}
h1, h2, h3, h4, h5, h6 {
  font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI Semibold", sans-serif;
  color: #111116;
  line-height: 1.35;
  page-break-after: avoid;
  break-after: avoid;
}
h1 { font-size: 26pt; margin: 0 0 0.6em; }
h2 { font-size: 18pt; margin: 1.8em 0 0.6em; padding-bottom: 0.25em; border-bottom: 2px solid var(--rule); }
h3 { font-size: 15pt; margin: 1.4em 0 0.5em; padding-left: 0.5em; border-left: 4px solid var(--accent); }
h4 { font-size: 12.5pt; margin: 1.2em 0 0.4em; color: #2a2a33; }
h5 { font-size: 11pt; margin: 1em 0 0.3em; color: var(--muted); }
h6 { font-size: 10.5pt; margin: 1em 0 0.3em; color: var(--muted); }
p { margin: 0.55em 0; text-align: justify; }
ul, ol { margin: 0.5em 0 0.6em; padding-left: 1.6em; }
li { margin: 0.22em 0; }
a { color: #1f4e8c; text-decoration: none; }
a[href^="#"] { color: #1f4e8c; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 1.4em 0; }
blockquote {
  margin: 0.8em 0;
  padding: 0.5em 0.9em;
  border-left: 3px solid #b9b0a0;
  background: #faf8f4;
  color: #3d3d47;
}
code {
  font-family: "Consolas", "Cascadia Mono", "Courier New", monospace;
  font-size: 9pt;
  background: #f2f0ec;
  padding: 0.1em 0.3em;
  border-radius: 2px;
  word-break: break-word;
}
pre {
  background: #f7f6f3;
  border: 1px solid #e2ded6;
  border-radius: 3px;
  padding: 0.7em 0.9em;
  overflow-x: auto;
  page-break-inside: auto;
}
pre code { background: transparent; padding: 0; font-size: 8.6pt; line-height: 1.5; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
  font-size: 9pt;
  page-break-inside: auto;
}
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #d5d1c9; padding: 0.35em 0.5em; vertical-align: top; }
th { background: #efece6; font-weight: 600; text-align: left; }
img { max-width: 100%; }
`;

const pdfOptions = {
  format: 'A4',
  printBackground: true,
  margin: { top: '2cm', right: '2cm', bottom: '2cm', left: '2cm' },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:8px;color:#8a8a94;text-align:center;font-family:sans-serif;">Neo Smart Account 技术文档 · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  timeout: 600000,
  outline: true,
  tagged: true,
};

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

console.log(`[..] rendering PDF with ${CHROME || 'bundled chromium'} (this may take a while)`);

const pdf = await mdToPdf(
  { content: merged, path: MERGED_MD },
  {
    dest: OUTPUT_PDF,
    css: CSS,
    body_class: 'markdown-body',
    document_title: 'Neo Smart Account 技术文档（中文版）',
    launch_options: {
      headless: true,
      ...(CHROME ? { executablePath: CHROME } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    },
    pdf_options: pdfOptions,
    marked_options: { mangle: false },
  },
);

if (!pdf) {
  console.error('[error] PDF generation returned no output');
  process.exit(1);
}
console.log(`[ok] pdf: ${OUTPUT_PDF}`);
