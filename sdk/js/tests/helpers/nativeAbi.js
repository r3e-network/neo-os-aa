/**
 * The native kernel ABI, read from its true source.
 *
 * A native contract has no compiled manifest artifact: its ABI is the set of
 * `[ContractMethod]` members on the classes registered with `NativeContract`,
 * projected by the core at runtime (`ContractMethodMetadata`):
 *
 * - the ABI name is `attribute.Name ?? member.Name`, lower-cased on the first
 *   character only;
 * - `ApplicationEngine` / `IReadOnlyStore` leading parameters are the call
 *   context, not ABI parameters;
 * - `safe` is `(RequiredCallFlags & ~CallFlags.ReadOnly) == 0`.
 *
 * So the source is the authority the chain builds its manifest from, and this
 * module parses exactly the shapes `contracts/native/SmartAccount/*.cs` uses.
 * A drift in the kernel therefore fails the ABI guard instead of hiding behind
 * a checked-in snapshot that someone forgot to regenerate.
 */

const fs = require('node:fs');
const path = require('node:path');

/** C# parameter/return type -> `ContractParameterType` name. */
const PARAMETER_TYPES = {
  bool: 'Boolean',
  int: 'Integer',
  uint: 'Integer',
  long: 'Integer',
  ulong: 'Integer',
  short: 'Integer',
  ushort: 'Integer',
  sbyte: 'Integer',
  byte: 'Integer',
  BigInteger: 'Integer',
  string: 'String',
  'byte[]': 'ByteArray',
  UInt160: 'Hash160',
  UInt256: 'Hash256',
  Array: 'Array',
  StackItem: 'Any',
  void: 'Void',
  'UInt160[]': 'Array',
  'byte[][]': 'Array',
  'string[]': 'Array',
};

/** Neo `CallFlags` values, as declared in the core. */
const CALL_FLAGS = {
  None: 0,
  ReadStates: 1,
  WriteStates: 2,
  AllowCall: 4,
  AllowNotify: 8,
  ReadOnly: 5,
  All: 15,
  States: 3,
};

/** The call context a native method receives alongside its ABI parameters. */
const CONTEXT_TYPES = new Set(['ApplicationEngine', 'IReadOnlyStore', 'DataCache']);

function parameterType(type, label) {
  const mapped = PARAMETER_TYPES[type];
  if (!mapped) throw new Error(`native ABI: unmapped ${label} type ${type}`);
  return mapped;
}

/** `ContractTask<X>` is the async projection of `X`; bare `ContractTask` is void. */
function returnType(type) {
  const task = /^ContractTask(?:<(.+)>)?$/.exec(type);
  if (task) return parameterType(task[1] ?? 'void', 'return');
  return parameterType(type, 'return');
}

/** Splits a parameter list on top-level commas (generic brackets nest). */
function splitParameters(list) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '<' || character === '[') depth += 1;
    if (character === '>' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** One parameter: `[Attribute] Type name`, context parameters excluded. */
function parseParameter(part) {
  const text = part.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').replace(/\s+/g, ' ').trim();
  const match = /^(.+?)\s+([A-Za-z_]\w*)$/.exec(text);
  if (!match) throw new Error(`native ABI: malformed parameter ${JSON.stringify(part)}`);
  return { type: match[1], name: match[2] };
}

const DECLARATION =
  /^\s*(?:public|private|internal|protected)\s+(?:static\s+)?(?:async\s+)?([A-Za-z_][\w.<>[\]]*)\s+([A-Za-z_]\w*)\s*\(/;

function readSource(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? readSource(path.join(directory, entry.name))
        : entry.name.endsWith('.cs')
          ? [path.join(directory, entry.name)]
          : [],
    );
}

/**
 * Every ABI method of the native SmartAccount kernel.
 *
 * @param {string} root repository root
 * @returns {Map<string, Array<{types: string[], names: string[], returntype: string, safe: boolean}>>}
 */
function nativeAbi(root, relative = 'contracts/native/SmartAccount') {
  const methods = new Map();
  for (const file of readSource(path.join(root, relative))) {
    const source = fs.readFileSync(file, 'utf8');
    for (let index = source.indexOf('[ContractMethod('); index >= 0; index = source.indexOf('[ContractMethod(', index + 1)) {
      const close = source.indexOf(')]', index);
      if (close < 0) throw new Error(`native ABI: unterminated attribute in ${file}`);
      const attribute = source.slice(index + '[ContractMethod('.length, close);
      const declaration = source
        .slice(close + 2)
        .split('\n')
        .slice(0, 8)
        .map((line) => DECLARATION.exec(line))
        .find(Boolean);
      if (!declaration) throw new Error(`native ABI: no declaration after attribute in ${file}`);
      const [, declaredType, name] = declaration;
      const open = source.indexOf('(', close + 2 + source.slice(close + 2).indexOf(declaration[0]));
      const parameters = splitParameters(source.slice(open + 1, source.indexOf(')', open)))
        .map(parseParameter)
        .filter((parameter) => !CONTEXT_TYPES.has(parameter.type));
      const flags = /RequiredCallFlags\s*=\s*CallFlags\.([A-Za-z]+)/.exec(attribute);
      if (!flags) throw new Error(`native ABI: ${name} declares no RequiredCallFlags`);
      const value = CALL_FLAGS[flags[1]];
      if (value === undefined) throw new Error(`native ABI: unknown CallFlags.${flags[1]}`);
      const entry = {
        types: parameters.map((parameter) => parameterType(parameter.type, `${name} parameter`)),
        names: parameters.map((parameter) => parameter.name),
        returntype: returnType(declaredType),
        safe: (value & ~CALL_FLAGS.ReadOnly) === 0,
      };
      const abiName = name.charAt(0).toLowerCase() + name.slice(1);
      methods.set(abiName, [...(methods.get(abiName) ?? []), entry]);
    }
  }
  return methods;
}

module.exports = { nativeAbi };
