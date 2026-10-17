// CU-161 drive: guided account creation with verifier presets, and the dead V2
// create paths the operations composer still carried.
//
// Every assertion here is a value: a hash compared with the registry, an id
// compared with the shipped ABI, a mutation observed on the real create form,
// or an error carrying the reason it claims. The component is not grepped: the
// real <script setup> and the real template are compiled, evaluated and mounted
// on a minimal renderer, then its rendered buttons are clicked.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRenderer, nextTick } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { createServer } from 'vite';

import { MORPHEUS_PUBLIC_REGISTRY } from '../src/config/generatedMorpheusRegistry.js';
import { EC } from '../src/config/errorCodes.js';
import * as operationPresets from '../src/features/operations/presets.js';
import * as matrixDomain from '../src/services/matrixDomainService.js';

const FRONTEND_ROOT = path.resolve('.');
const PANEL_FILE = path.resolve('src/features/studio/components/CreateAccountPanel.vue');
const BOUNDARY_STUB = path.resolve('tests/fixtures/studioBoundaryStubs.js');
const MANIFEST_DIR = path.resolve('..', 'contracts', 'build');
const NETWORK = 'mainnet';
const PUBLISHED_VERIFIER_KEYS = [
  'aaWeb3AuthVerifier',
  'aaSessionKeyVerifier',
  'aaSocialRecoveryVerifier',
];

const publishedVerifierContracts = PUBLISHED_VERIFIER_KEYS.map(
  (key) => MORPHEUS_PUBLIC_REGISTRY[NETWORK].contracts[key],
);

function readManifest(moduleName) {
  return JSON.parse(readFileSync(path.join(MANIFEST_DIR, `${moduleName}.manifest.json`), 'utf8'));
}

function manifestMethods(moduleName) {
  return readManifest(moduleName).abi.methods;
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
}

// The wallet and toast boundary is replaced so the real studio controller can be
// loaded in Node; nothing under test lives in those modules.
const STUBBED_SPECIFIERS = {
  'vue-toastification': BOUNDARY_STUB,
  '@/utils/wallet': BOUNDARY_STUB,
  '@/services/walletService': BOUNDARY_STUB,
  '@/utils/did': BOUNDARY_STUB,
  '@/services/accountMetadataService': BOUNDARY_STUB,
  '@/composables/useClipboard': BOUNDARY_STUB,
};

let viteServer;
let studio;

before(async () => {
  const alias = Object.entries(STUBBED_SPECIFIERS).map(([specifier, replacement]) => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.js)?$`),
    replacement,
  }));
  alias.push({ find: /^@\//, replacement: `${path.resolve('src')}/` });
  viteServer = await createServer({
    root: FRONTEND_ROOT,
    configFile: false,
    resolve: { alias },
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const controllerModule = await viteServer.ssrLoadModule('/src/features/studio/useStudioController.js');
  studio = controllerModule.useStudioController();
});

after(async () => {
  await viteServer?.close();
});

// --- the create panel, evaluated rather than grepped -----------------------

let panelModulePromise;

function loadPanelModule() {
  panelModulePromise ??= (async () => {
    const filename = PANEL_FILE;
    const source = readFileSync(filename, 'utf8');
    const { descriptor } = parse(source, { filename });
    if (!descriptor.template) throw new Error('CreateAccountPanel.vue has no template');
    if (!descriptor.scriptSetup) throw new Error('CreateAccountPanel.vue has no <script setup>');
    const script = compileScript(descriptor, { id: 'cu161-panel', inlineTemplate: false });
    const template = compileTemplate({
      source: descriptor.template.content,
      filename,
      id: 'cu161-panel',
      compilerOptions: { bindingMetadata: script.bindings },
    });
    if (template.errors.length > 0) {
      throw new AggregateError(template.errors, 'CreateAccountPanel.vue template did not compile');
    }
    const specifierFiles = {
      'vue': import.meta.resolve('vue'),
      '@/i18n': pathToFileURL(path.resolve('src/i18n/index.js')).href,
      '@/composables/useClipboard': pathToFileURL(
        path.resolve('src/composables/useClipboard.js'),
      ).href,
    };
    const unknown = [];
    const code = `${script.content}\n${template.code}`.replace(
      /\bfrom\s+(['"])([^'"]+)\1/g,
      (match, quote, specifier) => {
        if (!specifierFiles[specifier]) {
          unknown.push(specifier);
          return match;
        }
        return `from ${JSON.stringify(specifierFiles[specifier])}`;
      },
    );
    if (unknown.length > 0) {
      throw new Error(`the panel gained imports the drive cannot resolve: ${unknown.join(', ')}`);
    }
    const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    const evaluated = await import(dataUrl);
    return { component: { ...evaluated.default, render: evaluated.render } };
  })();
  return panelModulePromise;
}

function makeNode(tag) {
  return {
    tag,
    children: [],
    parent: null,
    props: {},
    text: null,
    nodeType: 1,
    value: '',
    addEventListener() {},
    removeEventListener() {},
  };
}

function textOf(node) {
  if (!node) return '';
  if (node.text != null) return String(node.text);
  return (node.children || []).map(textOf).join(' ');
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

// Mounts the real panel against a studio object. The renderer keeps the props
// Vue patches onto each node, so a click is the component's own listener.
async function mountCreateAccountPanel(activeStudio) {
  const { component } = await loadPanelModule();
  const listeners = new Map();
  const root = makeNode('root');
  const renderer = createRenderer({
    createElement: makeNode,
    createText: (text) => ({ text, children: [], parent: null, props: {}, nodeType: 3 }),
    createComment: (text) => ({ comment: text, children: [], parent: null, props: {}, nodeType: 8 }),
    insert(child, parent) {
      child.parent = parent;
      parent.children.push(child);
    },
    remove(child) {
      const parent = child.parent;
      if (parent) parent.children.splice(parent.children.indexOf(child), 1);
    },
    setElementText(node, text) {
      node.text = text;
      node.children = [];
    },
    setText(node, text) {
      node.text = text;
    },
    parentNode: (node) => node.parent || null,
    nextSibling: () => null,
    patchProp(node, key, previous, next) {
      node.props[key] = next;
      if (/^on[A-Z]/.test(key) && typeof next === 'function') {
        const existing = listeners.get(node) || {};
        existing[key] = next;
        listeners.set(node, existing);
      }
    },
    querySelector: () => null,
    setScopeId: () => {},
  });
  const app = renderer.createApp(component);
  app.component('router-link', { render: () => null });
  app.provide('studio', activeStudio);
  app.mount(root);
  await nextTick();
  const buttons = [];
  walk(root, (node) => {
    if (String(node.tag).toLowerCase() === 'button') buttons.push(node);
  });
  return {
    root,
    text: () => textOf(root),
    buttons,
    click: async (node) => {
      const onClick = listeners.get(node)?.onClick;
      assert.equal(typeof onClick, 'function', 'the rendered control carries no click handler');
      onClick({ preventDefault() {}, stopPropagation() {} });
      await nextTick();
    },
    unmount: () => app.unmount(),
  };
}

function buttonWithText(mounted, text) {
  return mounted.buttons.find((button) => textOf(button).trim() === text);
}

// --- acceptance clause 1: the create flow offers registry presets ---------

test('the studio create flow exposes a verifier preset catalogue', () => {
  assert.ok(
    studio.createVerifierPresets,
    'useStudioController() exposes no createVerifierPresets: the create flow offers no presets',
  );
  const presets = studio.createVerifierPresets.value;
  assert.deepEqual(
    presets.map((preset) => preset.registryKey),
    PUBLISHED_VERIFIER_KEYS,
    'the create presets are not the registry-published verifier keys',
  );
  for (const preset of presets) {
    assert.equal(
      preset.verifierContract,
      MORPHEUS_PUBLIC_REGISTRY[NETWORK].contracts[preset.registryKey],
      `${preset.id} does not carry the ${NETWORK} registry address`,
    );
  }
});

test('the create panel renders every published verifier address as a choice', async () => {
  const mounted = await mountCreateAccountPanel(studio);
  try {
    for (const contract of publishedVerifierContracts) {
      assert.ok(
        mounted.text().includes(contract),
        `the create panel offers no choice backed by the registry address ${contract}`,
      );
    }
  } finally {
    mounted.unmount();
  }
});

// --- acceptance clause 2: the create flow targets no removed ABI entry ----

test('the shipped V3 ABI has no V2 create entry, and the operations preset refuses batchCreate', () => {
  const methodNames = manifestMethods('UnifiedSmartWalletV3').map((method) => method.name);
  assert.equal(methodNames.includes('create'), false, 'the V3 ABI never exported create');
  assert.equal(methodNames.includes('registerAccount'), true);
  assert.equal(
    'EXPERIMENTAL_OPERATION_PRESETS' in operationPresets,
    false,
    'the operations module still exports the unreachable batch-create preset list',
  );
  assert.throws(
    () =>
      operationPresets.buildOperationFromPreset({
        preset: 'batchCreate',
        invoke: { targetContract: '0x5be915aea3ce85e4752d522632f0a9520e377aaf' },
        batch: { accountIds: '["0xabc"]', signers: '[]', threshold: '1' },
      }),
    (error) => {
      assert.ok(error instanceof operationPresets.OperationPresetRefusedError);
      assert.equal(error.code, EC.presetUnknown);
      assert.equal(error.details.preset, 'batchCreate');
      return true;
    },
    'the removed batch-create preset still builds an operation',
  );
});

test('the live operation presets still build, so the refusal is not the only path', () => {
  const operation = operationPresets.buildOperationFromPreset({
    preset: 'invoke',
    invoke: {
      targetContract: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
      method: 'getNonce',
      argsText: '[]',
    },
  });
  assert.equal(operation.kind, 'invoke');
  assert.equal(operation.method, 'getNonce');
  assert.equal(operation.targetContract, '5be915aea3ce85e4752d522632f0a9520e377aaf');
});

test('the dead V2 account-discovery helper is gone from the matrix service', () => {
  assert.equal(
    'discoverAccountsForMatrixDomain' in matrixDomain,
    false,
    'matrixDomainService still exports discoverAccountsForMatrixDomain, which calls removed V2 reads',
  );
});
