// A planted failure for the fixture's nested-parameter comparison.
//
// The fixture builds the payload it then checks, so no request file can make the
// payload and the expectation disagree. This hook plants exactly one mutation in
// the request copy the fixture uses as its expectation, then loads the fixture
// unchanged: the payload is built from the request file, the expectation carries
// the planted mutation, and whatever the fixture reports is its own comparison
// verdict rather than an input the test pre-arranged.
//
// The SDK and the fixture are CommonJS, so the hook patches the module registry
// rather than an ESM loader chain. Load it before the fixture:
//   node --require sdk/js/tests/fixtureNestedMutation.cjs scripts/localchain/sdk_paymaster_fixture.mjs <request.json>
//   AA_FIXTURE_MODULE=<absolute scripts/localchain/sdk_paymaster_fixture.mjs>
//   AA_NESTED_MUTATION={"op":"value","path":"0.value.0","value":"999"}
// The mutation is an operation applied to the first argument of the expectation:
//   {"op":"value","path":"0.value.0","value":<json>}         set `.value` of the parameter at the path
//   {"op":"parameter","path":"0.value.1","parameter":{...}}  swap the parameter at the path
//   {"op":"entry","path":"0.value.2","entry":{key,value}}    swap the Map entry at the path
'use strict';

const Module = require('node:module');
const path = require('node:path');

const fixtureEntry = path.resolve(process.env.AA_FIXTURE_MODULE);

function patch(source) {
  const marker = 'const expectedArgs = request.args || [];';
  const replacement = [
    'const expectedArgs = __plantedExpectation(request.args || []);',
    'function __plantedExpectation(__args) {',
    "  const __planted = JSON.parse(globalThis.process?.env?.AA_NESTED_MUTATION || 'null');",
    '  if (!__planted) return __args;',
    '  const __mutated = JSON.parse(JSON.stringify(__args));',
    '  const __at = (__target, __tokens) => __tokens.reduce((__node, __token) => (/^[0-9]+$/.test(__token) ? __node[Number(__token)] : __node[__token]), __target);',
    "  const __tokens = String(__planted.path || '').split('.').filter((__token) => __token.length);",
    '  if (!__tokens.length) throw new Error("a planted mutation must name the argument path it changes");',
    '  const __target = __at(__mutated, __tokens);',
    '  if (!__target || typeof __target !== "object") throw new Error(`a planted mutation must name a parameter, not ${JSON.stringify(__target)}`);',
    '  const __last = __tokens[__tokens.length - 1];',
    '  const __parent = __at(__mutated, __tokens.slice(0, -1));',
    '  const __slot = /^[0-9]+$/.test(__last) ? Number(__last) : __last;',
    "  if (__planted.op === 'value') {",
    '    if (!("value" in __target)) throw new Error(`the planted mutation names a parameter without a value at ${__planted.path}`);',
    '    __target.value = __planted.value;',
    "  } else if (__planted.op === 'parameter') {",
    '    __parent[__slot] = __planted.parameter;',
    "  } else if (__planted.op === 'entry') {",
    '    __parent[__slot] = __planted.entry;',
    '  } else {',
    '    throw new Error(`unknown planted mutation op: ${String(__planted.op)}`);',
    '  }',
    '  return __mutated.map((__parameter) => (__parameter && typeof __parameter === "object"',
    '    ? { ...JSON.parse(JSON.stringify(__parameter)) }',
    '    : __parameter));',
    '}',
  ].join('\n');
  if (!String(source).includes(marker)) {
    throw new Error(`the fixture no longer carries the expectation marker: ${marker}`);
  }
  return String(source).replace(marker, replacement);
}

const load = Module._load;
Module._load = function loadWithPlantedMutation(request, parent, isMain) {
  const resolved = parent ? path.resolve(path.dirname(parent.filename), request) : '';
  if (resolved !== fixtureEntry) return load.call(this, request, parent, isMain);
  const source = require('node:fs').readFileSync(fixtureEntry, 'utf8');
  const module = new Module(fixtureEntry, parent);
  module.filename = fixtureEntry;
  module.paths = Module._nodeModulePaths(path.dirname(fixtureEntry));
  module._compile(patch(source), fixtureEntry);
  return module.exports;
};
