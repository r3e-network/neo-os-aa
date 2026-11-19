// CU-161 drive, v4: guided account creation.
//
// A v4 account is created from a custody, a salt and a recovery timelock — no
// verifier, no hook and no backup owner enter the identity, so the same pair
// names the same account on both kernels. Every assertion here is a value
// compared with the built ABI, the shared identity deriver or a mutation
// observed on the real create form; the panel is compiled and mounted rather
// than grepped.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRenderer, nextTick, ref } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { createServer } from 'vite';

import * as matrixDomain from '../src/services/matrixDomainService.js';
import { createCreateFormState } from '../src/features/studio/constants.js';
import {
  MAX_RECOVERY_TIMELOCK_DAYS,
  MIN_RECOVERY_TIMELOCK_DAYS,
  REGISTRATION_SALT_BYTES,
  generateRegistrationSalt,
  normalizeRegistrationSalt,
  planCreateAccount,
  recoveryTimelockDaysToMs,
} from '../src/features/studio/createAccountPlan.js';
import {
  createProxyScript,
  deriveAccountAddress,
  deriveAccountIdentity,
} from '../src/utils/neo.js';
import { getSmartAccountHash } from './fixtures/studioBoundaryStubs.js';

const FRONTEND_ROOT = path.resolve('.');
const PANEL_FILE = path.resolve('src/features/studio/components/CreateAccountPanel.vue');
const BOUNDARY_STUB = path.resolve('tests/fixtures/studioBoundaryStubs.js');
const MANIFEST_PATH = path.resolve('..', 'contracts', 'bin', 'public', 'SmartAccount.manifest.json');

const CORE = getSmartAccountHash();
const OTHER_CORE = 'aa'.repeat(20);
const CUSTODY = '11'.repeat(19) + '12';
const SALT = 'a1b2c3d4e5f60718';
const DAY = 86_400_000;

function manifest() {
  assert.ok(
    path.relative(FRONTEND_ROOT, MANIFEST_PATH) && readFileSyncExists(MANIFEST_PATH),
    `the v4 core ABI is missing at ${MANIFEST_PATH}; run contracts/compile.sh before the frontend tests`,
  );
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function readFileSyncExists(file) {
  try {
    readFileSync(file, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function createForm(overrides = {}) {
  return { ...createCreateFormState(), custody: CUSTODY, salt: SALT, recoveryTimelockDays: 30, ...overrides };
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { activeElement: null };
}
globalThis.Document ??= class Document {};
globalThis.ShadowRoot ??= class ShadowRoot {};

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
      vue: import.meta.resolve('vue'),
      '@/i18n': pathToFileURL(path.resolve('src/i18n/index.js')).href,
      '@/composables/useClipboard': pathToFileURL(
        path.resolve('src/composables/useClipboard.js'),
      ).href,
      '@/utils/neo.js': pathToFileURL(path.resolve('src/utils/neo.js')).href,
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
  const nodes = [];
  walk(root, (node) => nodes.push(node));
  return {
    root,
    nodes,
    text: () => textOf(root),
    buttons: nodes.filter((node) => String(node.tag).toLowerCase() === 'button'),
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

// --- the identity the create flow commits to ------------------------------

test('the identity is derived from custody and salt alone, so one pair names the same account on both kernels', () => {
  const plan = planCreateAccount(createForm(), CORE);
  const identity = deriveAccountIdentity({ custodyAddress: CUSTODY, salt: SALT });
  assert.equal(plan.accountId, identity.accountId);
  assert.match(plan.accountId, /^[0-9a-f]{40}$/);
  assert.equal(plan.identityPreimageHex, identity.identityPreimageHex);

  // The core hash decides the address, never the id: the same account is
  // addressable at two cores without becoming two identities.
  const otherCore = planCreateAccount(createForm(), OTHER_CORE);
  assert.equal(otherCore.accountId, plan.accountId);
  assert.notEqual(otherCore.accountAddress, plan.accountAddress);

  // And the plan's script/address are the shared derivation, not a local copy.
  assert.equal(plan.verificationScript, createProxyScript(CORE, plan.accountId));
  assert.equal(plan.accountAddress, deriveAccountAddress({ accountId: plan.accountId, coreContractHash: CORE }));

  // A different salt is a different account.
  const salted = planCreateAccount(createForm({ salt: 'ff' }), CORE);
  assert.notEqual(salted.accountId, plan.accountId);
});

test('the planned createAccount invocation carries exactly what the built v4 ABI declares', () => {
  const createAccount = manifest().abi.methods.find((method) => method.name === 'createAccount');
  assert.ok(createAccount, 'the built v4 ABI has no createAccount');
  assert.equal(createAccount.safe, false);
  assert.deepEqual(createAccount.parameters.map((parameter) => parameter.type), [
    'Hash160', 'Hash160', 'ByteArray', 'Integer', 'Array',
  ]);

  const plan = planCreateAccount(createForm(), CORE);
  assert.equal(plan.invocation.operation, 'createAccount');
  assert.deepEqual(
    plan.invocation.args.map((argument) => argument.type),
    createAccount.parameters.map((parameter) => parameter.type),
    'the invocation argument types are not the shipped createAccount parameter types',
  );
  assert.equal(plan.invocation.args[0].value, plan.accountId);
  assert.equal(plan.invocation.args[1].value, plan.custodyAddress);
  assert.equal(plan.invocation.args[2].value, `0x${plan.salt}`);
  assert.equal(plan.invocation.args[3].value, String(30 * DAY));
  // Creation installs nothing: modules arrive through configuration intents.
  assert.deepEqual(plan.invocation.args[4].value, []);

  // The v3 create entries are gone from the built ABI.
  const names = new Set(manifest().abi.methods.map((method) => method.name));
  for (const retired of ['create', 'registerAccount', 'registerAccounts']) {
    assert.equal(names.has(retired), false, `${retired} must not exist in the v4 ABI`);
  }
});

test('a salt is 1 through 128 hex bytes and the generator draws from a secure source', () => {
  const generated = generateRegistrationSalt();
  assert.equal(generated.length, REGISTRATION_SALT_BYTES * 2);
  assert.match(generated, /^[0-9a-f]+$/);
  assert.notEqual(generateRegistrationSalt(), generateRegistrationSalt(), 'two salts must not collide');
  assert.equal(normalizeRegistrationSalt('0xAB'), 'ab');
  assert.equal(normalizeRegistrationSalt('ab'.repeat(128)).length, 256);

  for (const byteLength of [0, 129, 1.5, -1]) {
    assert.throws(() => generateRegistrationSalt(byteLength), /salt/i, `length ${byteLength}`);
  }
  for (const bad of ['', '0x', 'a', 'zz', 'ab'.repeat(129)]) {
    assert.throws(() => normalizeRegistrationSalt(bad), /salt/i, `value ${bad.slice(0, 8)}`);
  }
  assert.throws(() => planCreateAccount(createForm({ salt: 'a1b' }), CORE), /salt/i);
  assert.throws(() => planCreateAccount(createForm({ salt: '' }), CORE), /salt/i);
});

test('the recovery timelock is 7 through 90 days, carried as milliseconds', () => {
  assert.equal(MIN_RECOVERY_TIMELOCK_DAYS, 7);
  assert.equal(MAX_RECOVERY_TIMELOCK_DAYS, 90);
  assert.equal(recoveryTimelockDaysToMs(7), 7 * DAY);
  assert.equal(recoveryTimelockDaysToMs(90), 90 * DAY);
  assert.equal(recoveryTimelockDaysToMs('30'), 30 * DAY);
  for (const bad of [0, 6, 6.9, 91, 365, Number.NaN, 'soon', null, undefined]) {
    assert.throws(() => recoveryTimelockDaysToMs(bad), /timelock/i, `days ${String(bad)}`);
  }
});

test('a plan refuses a malformed custody or a missing core instead of guessing', () => {
  assert.throws(() => planCreateAccount(createForm({ custody: '' }), CORE), /address/i);
  assert.throws(() => planCreateAccount(createForm({ custody: '0x1234' }), CORE), /address/i);
  assert.throws(() => planCreateAccount(createForm({ custody: '00'.repeat(20) }), CORE), /address/i);
  assert.throws(() => planCreateAccount(createForm(), ''), /contract/i);
  assert.throws(() => planCreateAccount(null, CORE), TypeError);
});

// --- the controller that drives the form ----------------------------------

test('the controller derives the same id, address and script the plan does', async () => {
  Object.assign(studio.createForm.value, createForm());
  await studio.computeSA();
  const plan = planCreateAccount(createForm(), CORE);
  assert.equal(studio.computedAccountIdHash.value, plan.accountId);
  assert.equal(studio.computedAddress.value, plan.accountAddress);
  assert.equal(studio.computedScriptHex.value, plan.verificationScript);

  // An unusable timelock clears all three instead of deriving a half identity.
  studio.createForm.value.recoveryTimelockDays = 6;
  await studio.computeSA();
  assert.equal(studio.computedAccountIdHash.value, '');
  assert.equal(studio.computedAddress.value, '');
  assert.equal(studio.computedScriptHex.value, '');

  // So does a salt the derivation refuses.
  studio.createForm.value.recoveryTimelockDays = 30;
  studio.createForm.value.salt = 'zz';
  await studio.computeSA();
  assert.equal(studio.computedAddress.value, '');
});

test('regenerating the salt replaces it with fresh bytes', () => {
  Object.assign(studio.createForm.value, createForm());
  const before = studio.createForm.value.salt;
  studio.regenerateSalt();
  assert.match(studio.createForm.value.salt, /^[0-9a-f]{32}$/);
  assert.notEqual(studio.createForm.value.salt, before);
});

// --- the rendered create flow, clicked ------------------------------------

test('the create panel renders the derived identity from the controller state', async () => {
  Object.assign(studio.createForm.value, createForm());
  await studio.computeSA();
  const mounted = await mountCreateAccountPanel(studio);
  try {
    const text = mounted.text();
    assert.ok(text.includes('Create Smart Account'), 'the create panel did not render');
    assert.ok(text.includes(studio.computedAddress.value), 'the derived address is not shown');
    assert.ok(text.includes(studio.computedAccountIdHash.value), 'the derived account id is not shown');
    assert.ok(
      text.includes('AA524704'),
      'the account id hint does not name the identity preimage the id commits to',
    );
    // The v4 form has exactly these controls: no verifier address, no hook
    // address, no backup owner and no escape timelock are collected at creation.
    const controls = mounted.nodes
      .filter((node) => ['input', 'textarea'].includes(String(node.tag).toLowerCase()))
      .map((node) => node.props.id || node.props.type || String(node.tag).toLowerCase());
    assert.deepEqual(controls, [
      'matrix-domain-input',
      'custody-input',
      'recovery-timelock-days',
      'salt-input',
      'verificationScriptHex',
    ]);
  } finally {
    mounted.unmount();
  }
});

test('the create panel disables creation until a custody wallet is connected', async () => {
  Object.assign(studio.createForm.value, createForm());
  await studio.computeSA();
  const mounted = await mountCreateAccountPanel(studio);
  try {
    const create = buttonWithText(mounted, 'Create Account');
    assert.ok(create, 'the panel renders no Create Account control');
    // The boundary stub reports no connected wallet, so the controller refuses.
    assert.equal(create.props.disabled, true, 'creation is offered without a custody wallet');
  } finally {
    mounted.unmount();
  }

  // Control: the same control is enabled once the controller reports readiness.
  const ready = { ...studio, canCreate: ref(true), isCreating: ref(false) };
  const mountedReady = await mountCreateAccountPanel(ready);
  try {
    const create = buttonWithText(mountedReady, 'Create Account');
    assert.ok(create);
    assert.equal(create.props.disabled, false, 'the drive cannot enable the control it just disabled');
  } finally {
    mountedReady.unmount();
  }
});

test('the Generate control regenerates the salt through the controller', async () => {
  Object.assign(studio.createForm.value, createForm());
  await studio.computeSA();
  const mounted = await mountCreateAccountPanel(studio);
  try {
    const generate = buttonWithText(mounted, 'Generate');
    assert.ok(generate, 'the panel renders no Generate control');
    await mounted.click(generate);
    assert.match(studio.createForm.value.salt, /^[0-9a-f]{32}$/);
    assert.notEqual(studio.createForm.value.salt, SALT);
  } finally {
    mounted.unmount();
  }
});

test('the recovery timelock input is bounded to the contract window', async () => {
  Object.assign(studio.createForm.value, createForm());
  await studio.computeSA();
  const mounted = await mountCreateAccountPanel(studio);
  try {
    const input = mounted.nodes.find((node) => String(node.tag).toLowerCase() === 'input'
      && node.props.id === 'recovery-timelock-days');
    assert.ok(input, 'the panel renders no recovery timelock control');
    assert.equal(String(input.props.min), '7');
    assert.equal(String(input.props.max), '90');
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
