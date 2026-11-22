import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const files = [
  'src/features/operations/components/LoadAccountPanel.vue',
  'src/features/operations/components/OperationComposerPanel.vue',
  'src/features/operations/components/SignatureWorkflowPanel.vue',
  'src/features/operations/components/BroadcastOptionsPanel.vue',
  'src/features/operations/components/RelayPreflightPanel.vue',
  'src/features/operations/components/ActivitySidebar.vue',
  'src/features/operations/components/HomeOperationsWorkspace.vue',
  'src/views/TransactionInfoView.vue',
];

test('major workspace views opt into i18n', () => {
  for (const relativePath of files) {
    const source = fs.readFileSync(path.resolve(relativePath), 'utf8');
    assert.match(source, /useI18n/);
  }
});

test('both locales define the session-key value-uncapped warning keys', () => {
  const en = fs.readFileSync(path.resolve('src/i18n/index.js'), 'utf8');
  const zh = fs.readFileSync(path.resolve('src/i18n/zh-CN.js'), 'utf8');
  for (const source of [en, zh]) {
    assert.match(source, /sessionKeyUncappedWarning:/);
    assert.match(source, /sessionKeyUncappedNativeWarning:/);
    // The native-asset message must keep its {asset} interpolation placeholder.
    assert.match(source, /sessionKeyUncappedNativeWarning:[\s\S]{0,400}\{asset\}/);
  }
});
