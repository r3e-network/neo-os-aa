import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createI18nController } from '../src/i18n/index.js';

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test('i18n controller defaults to English and persists Chinese selection', async () => {
  const storage = createMemoryStorage();
  const i18n = createI18nController({ storage, forceNew: true });

  assert.equal(i18n.locale.value, 'en');
  assert.equal(i18n.t('nav.home', 'Home'), 'Home');

  await i18n.setLocale('zh-CN');
  assert.equal(i18n.locale.value, 'zh-CN');
  assert.equal(i18n.t('nav.home', 'Home'), '首页');

  const restored = createI18nController({ storage, forceNew: true });
  assert.equal(restored.locale.value, 'zh-CN');
});

test('docs registry is guide-first and includes localized Chinese documentation assets', () => {
  const registrySource = fs.readFileSync(path.resolve('src/features/docs/registry.js'), 'utf8');
  const guideZh = fs.readFileSync(path.resolve('src/assets/docs/guide.zh.md'), 'utf8');

  assert.match(registrySource, /DEFAULT_DOC_KEY = 'guide'/);
  assert.match(registrySource, /How It Works & Usage Guide/);
  assert.match(registrySource, /工作原理与使用指南/);
  assert.match(registrySource, /overview\.zh\.md/);
  assert.match(registrySource, /architecture\.zh\.md/);
  assert.match(registrySource, /workflow\.zh\.md/);
  assert.match(registrySource, /data-flow\.zh\.md/);
  assert.match(guideZh, /智能账户|Neo/i);
});

test('main layout exposes a bilingual language switcher', () => {
  const source = fs.readFileSync(path.resolve('src/components/layout/MainLayout.vue'), 'utf8');
  assert.match(source, /English/);
  assert.match(source, /中文/);
  assert.match(source, /setLocale/);
});


test('docs registry localizes the pages that carry a Chinese edition', () => {
  const registrySource = fs.readFileSync(path.resolve('src/features/docs/registry.js'), 'utf8');

  for (const asset of ['guide.zh.md', 'overview.zh.md', 'architecture.zh.md', 'workflow.zh.md', 'data-flow.zh.md']) {
    assert.ok(fs.existsSync(path.resolve('src/assets/docs', asset)), `missing Chinese docs asset: ${asset}`);
    assert.match(registrySource, new RegExp(asset.replace(/\./g, '\\.')));
  }
});
