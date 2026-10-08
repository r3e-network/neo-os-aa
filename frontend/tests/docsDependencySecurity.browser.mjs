import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const frontendRoot = fileURLToPath(new URL('..', import.meta.url));

// Exercise the actual installed renderers in Chromium. Mermaid's narrower KaTeX
// semver range needs this contract test before advancing the scoped override.
test('patched KaTeX rejects inherited trust options in a real browser', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body></body>');
    await page.addScriptTag({ path: require.resolve('katex') });
    const result = await page.evaluate(() => {
      const payload = String.raw`\href{javascript:alert(1)}{click}`;
      const options = Object.assign(Object.create({ trust: true }), { output: 'mathml', throwOnError: true });
      const html = window.katex.renderToString(payload, options);
      const host = document.createElement('div');
      host.innerHTML = html;
      return { version: window.katex.version, links: host.querySelectorAll('[href]').length };
    });
    assert.equal(result.version, '0.18.2');
    assert.equal(result.links, 0);
  } finally { await browser.close(); }
});

test('Mermaid renders diagrams and math while removing active attacker markup', async () => {
  const bundle = await build({
    configFile: false, root: frontendRoot, publicDir: false, logLevel: 'silent',
    build: { write: false, minify: false,
      lib: { entry: require.resolve('mermaid'), name: 'MermaidSecurityTest', formats: ['iife'] } },
  });
  const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find((item) => item.type === 'chunk').code;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const dialogs = [];
    page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.setContent('<!doctype html><body></body>');
    await page.addScriptTag({ content: code });
    const results = await page.evaluate(async () => {
      const mermaid = window.MermaidSecurityTest.default;
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      const cases = [
        ['flow', 'flowchart TD\n A[Register] --> B[Verify] --> C[Execute]'],
        ['sequence', 'sequenceDiagram\n Wallet->>Core: execute\n Core-->>Wallet: HALT'],
        ['math', String.raw`flowchart LR
 A["$$\frac{a}{b} + \sqrt{x^2}$$"] --> B["$$E=mc^2$$"]`],
        ['html', 'flowchart LR\n A["<img src=x onerror=alert(1)>"] --> B["<script>alert(1)</script>"]'],
        ['link', 'flowchart LR\n A["safe"]\n click A "javascript:alert(1)"'],
        ['mathlink', String.raw`flowchart LR
 A["$$\href{javascript:alert(1)}{click}$$"]`],
      ];
      const outputs = [];
      for (const [id, source] of cases) {
        // Check the advisory prerequisite as well as ordinary untrusted input.
        if (id === 'mathlink') Object.prototype.trust = true;
        try {
          const { svg } = await mermaid.render(`security${id}`, source);
          const host = document.createElement('div');
          host.innerHTML = svg;
          document.body.append(host);
          const active = [...host.querySelectorAll('*')].flatMap((element) => [...element.attributes].filter((attr) =>
            /^on/i.test(attr.name) || (['href', 'xlink:href', 'src'].includes(attr.name) && /^javascript:/i.test(attr.value))));
          outputs.push({ id, svg: host.querySelectorAll('svg').length, math: host.querySelectorAll('math').length,
            fractions: host.querySelectorAll('mfrac').length, roots: host.querySelectorAll('msqrt').length,
            scripts: host.querySelectorAll('script').length, active: active.length });
          host.remove();
        } finally { if (id === 'mathlink') delete Object.prototype.trust; }
      }
      return outputs;
    });
    for (const result of results) {
      assert.equal(result.svg, 1, result.id);
      assert.equal(result.active, 0, result.id);
      assert.equal(result.scripts, 0, result.id);
    }
    const math = results.find((result) => result.id === 'math');
    assert.equal(math.math, 2);
    assert.equal(math.fractions, 1);
    assert.equal(math.roots, 1);
    assert.deepEqual(dialogs, []);
  } finally { await browser.close(); }
});
