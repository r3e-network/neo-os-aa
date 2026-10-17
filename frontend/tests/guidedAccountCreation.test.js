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

import { createRenderer, nextTick, ref } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { createServer } from 'vite';

import { MORPHEUS_PUBLIC_REGISTRY } from '../src/config/generatedMorpheusRegistry.js';
import { EC } from '../src/config/errorCodes.js';
import * as operationPresets from '../src/features/operations/presets.js';
import * as matrixDomain from '../src/services/matrixDomainService.js';
import { createCreateFormState } from '../src/features/studio/constants.js';
import {
  applyCreateAccountVerifierPreset,
  createAccountVerifierPresets,
  findCreateAccountVerifierPreset,
  planCreateAccount,
} from '../src/features/studio/createAccountPresets.js';
import { deriveRegistrationAccountIdHash } from '../src/utils/neo.js';

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
// v-model's directive reads document.activeElement during patch; the custom
// renderer has no browser document, and none of the driven controls is focused.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { activeElement: null };
}
// v-model's directive compares getRootNode() against Document; the custom
// renderer's nodes are not DOM nodes, so the check simply never matches.
globalThis.Document ??= class Document {};
globalThis.ShadowRoot ??= class ShadowRoot {};

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
    getRootNode() {
      const root = new globalThis.Document();
      root.activeElement = null;
      return root;
    },
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


// --- the catalogue is the registry, not a wish list -----------------------

const fallbackT = (_, fallback) => fallback;

test('the catalogue is exactly the verifier modules the registry publishes on each network', () => {
  for (const network of ['mainnet', 'testnet']) {
    const presets = createAccountVerifierPresets(network, { t: fallbackT });
    assert.deepEqual(
      presets.map((preset) => preset.registryKey),
      PUBLISHED_VERIFIER_KEYS,
      `${network} preset keys are not the published verifier keys`,
    );
    for (const preset of presets) {
      assert.equal(
        preset.verifierContract,
        MORPHEUS_PUBLIC_REGISTRY[network].contracts[preset.registryKey],
        `${network} ${preset.id} does not carry the registry address`,
      );
    }
  }
});

test('an unpublished, empty or malformed registry entry yields no preset (control: the same oracle lists the published three)', () => {
  const registry = structuredClone(MORPHEUS_PUBLIC_REGISTRY);
  delete registry.mainnet.contracts.aaSessionKeyVerifier;
  registry.mainnet.contracts.aaWeb3AuthVerifier = '0xnot-a-hash';
  const narrowed = createAccountVerifierPresets('mainnet', { registry, t: fallbackT });
  assert.deepEqual(
    narrowed.map((preset) => preset.registryKey),
    ['aaSocialRecoveryVerifier'],
    'the catalogue still offers a verifier the registry does not publish',
  );
  // Positive control: the same function lists all three from the unmodified
  // registry, so the assertion above is about the registry content and not
  // about a catalogue that is always short.
  assert.equal(createAccountVerifierPresets('mainnet', { t: fallbackT }).length, 3);
});

test('each preset params mode is pinned to the shipped verifier ABI', () => {
  const presets = createAccountVerifierPresets('mainnet', { t: fallbackT });
  for (const preset of presets) {
    const setPublicKey = manifestMethods(preset.module).find((method) => method.name === 'setPublicKey');
    assert.equal(
      preset.paramsMode === 'publicKey',
      Boolean(setPublicKey),
      `${preset.module} params mode disagrees with its shipped setPublicKey`,
    );
  }
  // Paired controls: the instrument sees the method where it exists and its
  // absence where it does not, and it reads the pushed parameter type.
  const web3auth = manifestMethods('Web3AuthVerifier').find((method) => method.name === 'setPublicKey');
  assert.deepEqual(web3auth.parameters.map((parameter) => parameter.type), ['Hash160', 'ByteArray']);
  assert.equal(
    manifestMethods('SessionKeyVerifier').some((method) => method.name === 'setPublicKey'),
    false,
    'SessionKeyVerifier unexpectedly exports setPublicKey; re-derive its params mode',
  );
});

// --- applying a preset is decided by the registry and the ABI -------------

test('applying a published preset writes the registry address and clears params a none preset cannot take', () => {
  Object.assign(studio.createForm.value, createCreateFormState());
  const form = studio.createForm.value;
  form.verifierContract = `0x${'11'.repeat(20)}`;
  form.verifierParams = 'deadbeef';
  studio.applyCreateVerifierPreset('sessionKey');
  assert.equal(form.verifierPreset, 'sessionKey');
  assert.equal(
    form.verifierContract,
    MORPHEUS_PUBLIC_REGISTRY[NETWORK].contracts.aaSessionKeyVerifier,
  );
  assert.equal(form.verifierParams, '', 'a none preset left stale registration params in the form');
});

test('a forged preset object cannot substitute an address the registry does not publish', () => {
  const form = { ...createCreateFormState() };
  applyCreateAccountVerifierPreset(
    form,
    { id: 'web3Auth', verifierContract: `0x${'22'.repeat(20)}`, paramsMode: 'none' },
    NETWORK,
    { t: fallbackT },
  );
  assert.equal(
    form.verifierContract,
    MORPHEUS_PUBLIC_REGISTRY[NETWORK].contracts.aaWeb3AuthVerifier,
    'the applied address came from the caller instead of the registry',
  );
  assert.equal(form.verifierPreset, 'web3Auth');
});

test('an unpublished preset is refused and the form is not touched', () => {
  const form = {
    ...createCreateFormState(),
    verifierPreset: 'web3Auth',
    verifierContract: MORPHEUS_PUBLIC_REGISTRY[NETWORK].contracts.aaWeb3AuthVerifier,
    verifierParams: '02ab',
  };
  const snapshot = structuredClone(form);
  assert.throws(
    () => applyCreateAccountVerifierPreset(form, { id: 'teeVerifier' }, NETWORK, { t: fallbackT }),
    /is not published on mainnet/,
  );
  assert.deepEqual(form, snapshot, 'a refused preset mutated the create form');
  assert.throws(
    () => applyCreateAccountVerifierPreset(form, '', NETWORK, { t: fallbackT }),
    /Verifier preset \(none\) is not published on mainnet/,
  );
  assert.deepEqual(form, snapshot);
});

// --- the invocation the create flow submits -------------------------------

function createFormWith(backupOwnerSeed = 'ab') {
  return {
    ...createCreateFormState(),
    backupOwner: `0x${backupOwnerSeed.repeat(20)}`,
  };
}

test('the planned registerAccount invocation carries what the shipped ABI declares', () => {
  const register = manifestMethods('UnifiedSmartWalletV3').find((method) => method.name === 'registerAccount');
  assert.ok(register, 'the shipped V3 ABI has no registerAccount');
  assert.equal(register.safe, false);

  const form = createFormWith();
  applyCreateAccountVerifierPreset(form, 'web3Auth', NETWORK, { t: fallbackT });
  form.verifierParams = '0x02ab';
  const plan = planCreateAccount(form, NETWORK, { t: fallbackT });

  assert.equal(plan.invocation.operation, 'registerAccount');
  assert.deepEqual(
    plan.invocation.args.map((argument) => argument.type),
    register.parameters.map((parameter) => parameter.type),
    'the invocation argument types are not the shipped registerAccount parameter types',
  );
  assert.equal(plan.invocation.args[0].value, plan.accountIdHash);
  assert.equal(plan.invocation.args[1].value, plan.verifierHash);
  assert.equal(plan.invocation.args[2].value, '0x02ab');
  assert.equal(plan.invocation.args[3].value, plan.hookHash);
  assert.equal(plan.invocation.args[4].value, plan.backupOwnerHash);
  assert.equal(plan.invocation.args[5].value, plan.escapeTimelockSeconds);
  assert.equal(plan.escapeTimelockSeconds, 30 * 24 * 60 * 60);
  assert.equal(
    plan.verifierHash,
    MORPHEUS_PUBLIC_REGISTRY[NETWORK].contracts.aaWeb3AuthVerifier.replace(/^0x/, ''),
  );
});

test('a none preset feeds empty params to both the account id and the invocation', () => {
  const form = createFormWith();
  applyCreateAccountVerifierPreset(form, 'socialRecovery', NETWORK, { t: fallbackT });
  form.verifierParams = 'deadbeef';
  const plan = planCreateAccount(form, NETWORK, { t: fallbackT });
  assert.equal(plan.verifierParamsHex, '');
  assert.equal(plan.invocation.args[2].value, '0x');
  assert.equal(
    plan.accountIdHash,
    deriveRegistrationAccountIdHash({
      verifierContractHash: plan.verifierHash,
      verifierParamsHex: '',
      hookContractHash: plan.hookHash,
      backupOwnerAddress: form.backupOwner,
      escapeTimelock: plan.escapeTimelockSeconds,
    }),
    'the stale params reached the account id derivation',
  );
  // Control: the same stale params on a publicKey preset are carried and do
  // change the derived id, so the assertion above is not true of every preset.
  const keyed = createFormWith();
  applyCreateAccountVerifierPreset(keyed, 'web3Auth', NETWORK, { t: fallbackT });
  keyed.verifierParams = 'deadbeef';
  const keyedPlan = planCreateAccount(keyed, NETWORK, { t: fallbackT });
  assert.equal(keyedPlan.invocation.args[2].value, '0xdeadbeef');
  assert.notEqual(keyedPlan.accountIdHash, plan.accountIdHash);
});

// --- the rendered create flow, clicked ------------------------------------

test('each rendered preset control applies its own registry address to the real create form', async () => {
  Object.assign(studio.createForm.value, createCreateFormState());
  const mounted = await mountCreateAccountPanel(studio);
  try {
    const presets = studio.createVerifierPresets.value;
    assert.equal(presets.length, 3);
    for (const preset of presets) {
      studio.createForm.value.verifierContract = '';
      studio.createForm.value.verifierParams = 'deadbeef';
      const button = mounted.buttons.find((candidate) =>
        textOf(candidate).includes(preset.verifierContract),
      );
      assert.ok(button, `no rendered preset control shows ${preset.verifierContract}`);
      await mounted.click(button);
      assert.equal(studio.createForm.value.verifierPreset, preset.id);
      assert.equal(
        studio.createForm.value.verifierContract,
        MORPHEUS_PUBLIC_REGISTRY[NETWORK].contracts[preset.registryKey],
      );
      assert.equal(
        studio.createForm.value.verifierParams,
        preset.paramsMode === 'none' ? '' : 'deadbeef',
      );
    }
  } finally {
    mounted.unmount();
  }
});

test('the rendered choices come from the controller catalogue (control: an empty catalogue renders none of them)', async () => {
  const emptyStudio = { ...studio, createVerifierPresets: ref([]) };
  const mounted = await mountCreateAccountPanel(emptyStudio);
  try {
    for (const contract of publishedVerifierContracts) {
      assert.equal(
        mounted.text().includes(contract),
        false,
        `the panel still renders ${contract} with an empty catalogue, so the drive is not reading the catalogue`,
      );
    }
    assert.ok(
      mounted.text().includes('Create Abstract Account'),
      'the control mount did not render the create panel, so its silence proves nothing',
    );
  } finally {
    mounted.unmount();
  }
});

test('the dead V2 account-discovery helper is gone from the matrix service', () => {
  assert.equal(
    'discoverAccountsForMatrixDomain' in matrixDomain,
    false,
    'matrixDomainService still exports discoverAccountsForMatrixDomain, which calls removed V2 reads',
  );
});
