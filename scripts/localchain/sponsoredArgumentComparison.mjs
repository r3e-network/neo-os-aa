// Whether a sponsored payload reproduces the operation the account signed, parameter by parameter.
//
// The AA-11 fixture used to compare nested ByteArray bytes and then report success for every other
// nested type: a reviewer changed a nested Integer(7) to Integer(999) and the fixture still answered
// ok=true. A comparison that pins one parameter kind while claiming to pin the operation pins less
// than it claims, so this walk is total over the kinds the relay carries and counts every node it
// visits. It lives in its own module because the recursion over each kind is the property under test:
// the fixture calls it, and sdk/js/tests/sponsored-argument-comparison.unit.test.js exercises the same
// function with a planted expectation.
//
// Ordering is meaningful and therefore compared everywhere here:
//  - a NeoVM array is an ordered sequence; its element order is part of its value, and reordering the
//    requested arguments changes the signed arguments hash.
//  - a Map is emitted as an ordered entry list (the relay normaliser refuses a duplicate key and keeps
//    entry order), so an entry swap is a different Map. Map keys compare as VM primitives, which is the
//    identity the relay itself uses to reject a duplicate key.
// Nothing in this boundary is an unordered collection, so no ordering check is skipped.

const TYPES = {
  scalar: new Set(['Boolean', 'Integer', 'String']),
  hash: new Set(['Hash160', 'Hash256', 'PublicKey']),
  container: new Set(['Array', 'Struct', 'Map']),
};

const isContainer = (type) => TYPES.container.has(type);

// A byte string has one identity on the wire and two spellings at this boundary: the relay DTO spells
// it as explicit 0x hex, while a value read back over RPC is canonical base64. Normalise the spelling
// rather than assuming one, and throw on anything that is neither, because Buffer.from(value, 'base64')
// silently decodes non-base64 text ('0x' becomes d3) and would let a mismatched byte string match.
export function canonicalByteHex(value) {
  const text = String(value ?? '');
  if (/^0x/i.test(text)) {
    const hexText = text.slice(2).toLowerCase();
    if (!/^(?:[0-9a-f]{2})*$/.test(hexText)) throw new Error(`not a 0x hex byte string: ${text.slice(0, 40)}`);
    return hexText;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error(`not a canonical base64 byte string: ${text.slice(0, 40)}`);
  }
  const binary = Buffer.from(text, 'base64').toString('binary');
  if (Buffer.from(binary, 'binary').toString('base64') !== text) {
    throw new Error(`not canonical base64: ${text.slice(0, 40)}`);
  }
  return Buffer.from(binary, 'binary').toString('hex');
}

// How deep one argument's containers go, measured on the payload rather than on the walk, so a walk
// that refuses a shallow change still reports the tree it was asked to cross.
export function parameterDepth(parameter) {
  if (!parameter || !isContainer(parameter.type) || !Array.isArray(parameter.value)) return 1;
  const children = parameter.type === 'Map'
    ? parameter.value.map((entry) => entry?.value)
    : parameter.value;
  return 1 + Math.max(0, ...children.map(parameterDepth));
}

export function compareSponsArgs(actualList, expectedList) {
  const inspection = {
    arguments: Array.isArray(expectedList) ? expectedList.length : 0,
    argumentsReached: 0,
    deepestArgumentDepth: 0,
    parameters: 0,
    leavesCompared: 0,
    hashesCompared: 0,
    byteArraysCompared: 0,
    skipped: 0,
    types: [],
  };
  // Hash-valued parameters are printed without the 0x prefix the request carries; nothing else about
  // them may differ.
  const note = (type) => { if (!inspection.types.includes(type)) inspection.types.push(type); };

  function byteDifference(actual, expected, label) {
    try {
      inspection.byteArraysCompared += 1;
      return canonicalByteHex(actual?.value) === canonicalByteHex(expected?.value)
        ? null
        : `${label} ${expected?.type} value differs`;
    } catch (error) {
      return `${label} is not a byte string: ${error.message}`;
    }
  }

  function scalarDifference(actual, expected, label) {
    if (expected.type === 'ByteArray') return byteDifference(actual, expected, label);
    if (expected.type === 'Any') {
      return sameValue(actual.value, expected.value) ? null : `${label} Any value differs`;
    }
    if (TYPES.hash.has(expected.type)) {
      inspection.hashesCompared += 1;
      return sameValue(actual.value, expected.value, expected.type)
        ? null
        : `${label} ${expected.type} value differs`;
    }
    if (!TYPES.scalar.has(expected.type)) return `${label} carries a ${expected.type} the walk does not compare`;
    inspection.leavesCompared += 1;
    return sameValue(actual.value, expected.value) ? null : `${label} ${expected.type} value differs`;
  }

  function keyDifference(actual, expected, label) {
    if (!actual || typeof actual !== 'object') return `${label} is missing`;
    if (actual.type !== expected.type) return `${label} is ${actual.type}, not ${expected.type}`;
    return scalarDifference(actual, expected, label);
  }

  function entryDifference(actual, expected, label) {
    // The payload carries an entry as {key, value}; the request may spell the same entry flat or as the
    // {type, value:[{key, value}]} pair the Map parameter itself is built from.
    const actualKey = actual && ('key' in actual) ? actual.key : actual?.value?.[0]?.key;
    const actualValue = actual && ('value' in actual) && !Array.isArray(actual.value)
      ? actual.value
      : actual?.value?.[0]?.value;
    return keyDifference(actualKey, expected.key, `${label}.key`)
      || parameterDifference(actualValue, expected.value, `${label}.value`);
  }

  function parameterDifference(actual, expected, label) {
    inspection.parameters += 1;
    note(expected?.type);
    if (!actual || typeof actual !== 'object') return `${label} does not carry the requested parameter`;
    if (actual.type !== expected.type) return `${label} is ${actual.type}, not ${expected.type}`;
    if (expected.type === 'Map') {
      const actualEntries = actual.value;
      const expectedEntries = expected.value;
      if (!Array.isArray(actualEntries) || !Array.isArray(expectedEntries)
        || actualEntries.length !== expectedEntries.length) {
        return `${label} does not carry the requested map entries`;
      }
      return expectedEntries
        .map((entry, index) => entryDifference(actualEntries[index], entry, `${label}.value[${index}]`))
        .find(Boolean) || null;
    }
    if (isContainer(expected.type)) {
      const actualItems = actual.value;
      const expectedItems = expected.value;
      if (!Array.isArray(actualItems) || !Array.isArray(expectedItems)
        || actualItems.length !== expectedItems.length) {
        return `${label} does not carry the requested nested parameters`;
      }
      return expectedItems
        .map((item, index) => parameterDifference(actualItems[index], item, `${label}[${index}]`))
        .find(Boolean) || null;
    }
    return scalarDifference(actual, expected, label);
  }

  if (!Array.isArray(actualList) || !Array.isArray(expectedList)) {
    return { difference: 'the argument list is not an array', inspection };
  }
  const differences = expectedList.map((arg, index) => {
    const actual = actualList[index];
    if (!actual) return `argument ${index} is missing`;
    inspection.argumentsReached += 1;
    inspection.deepestArgumentDepth = Math.max(inspection.deepestArgumentDepth, parameterDepth(actual));
    return parameterDifference(actual, arg, `argument ${index}`);
  }).filter(Boolean);
  return { difference: differences[0] || null, inspection };
}

// The same normalisation the walk uses, exported for the field checks the fixture makes outside it.
export function sameValue(actual, expected, type) {
  if (type && TYPES.hash.has(type)) {
    return String(actual ?? '').replace(/^0x/i, '').toLowerCase()
      === String(expected ?? '').replace(/^0x/i, '').toLowerCase();
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}
