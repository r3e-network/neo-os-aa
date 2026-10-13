// The pre-fix sponsored-argument walk: a verbatim copy of three bindings of
// `scripts/localchain/sdk_paymaster_fixture.mjs` as that file stood at commit c09972a (the head of
// `ds/cu-162-paymaster-ergonomics`), which is the code the live red in
// `sponsored-fixture-nested.unit.test.js` is measured against.
//
// It is a committed copy rather than a history lookup on purpose. That red has to run in a clean
// `git archive` export, and an export carries no `.git` directory, so a `git show` of c09972a fails
// there: the suite reported 209 passing and 1 failing in the archive for that reason alone. The copy
// is what lets the same assertion run unchanged in a worktree, in an archive and in CI.
//
// Do not "fix" this back into a history lookup, and do not update the walk to match the corrected
// one: the red asserts that this exact text accepts exactly the non-byte nested mutations it accepted
// at c09972a, so any edit here re-bases the red on a different walk instead of reproducing the
// reported defect. The test pins the SHA-256 of the text it executes out of this file.
//
// Source provenance, for a reader with a clone that has history (the archive cannot do this):
//   $ git show c09972a:scripts/localchain/sdk_paymaster_fixture.mjs | shasum -a 256
//   19d28be9bef283a2320ecde26ec82b8e97e42084c401b957d6ca65b3f43052c3
// The three bindings below were sliced out of that file with the same slicing helper the test still
// uses, and they are unmodified; the file around them (the SDK payload builder, the relay conversion,
// the acceptance checks) is not part of the red and is not copied. They appear here in the order the
// source file carries them; the red executes them in the order the pre-fix test did.

const hex = (value) => String(value ?? '').replace(/^0x/i, '').toLowerCase();
const byteHex = (value) => {
  const text = String(value ?? '');
  if (/^0x/i.test(text)) {
    const hexText = String(text).slice(2).toLowerCase();
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
};
function byteDifference(actual, expected, label) {
  if (expected.type === 'Array') {
    if (!Array.isArray(expected.value) || !Array.isArray(actual?.value) || actual.value.length !== expected.value.length) {
      return `${label} does not carry the requested nested parameters`;
    }
    return expected.value.map((item, index) => byteDifference(actual.value[index], item, `${label}[${index}]`)).find(Boolean) || null;
  }
  if (expected.type !== 'ByteArray') return null;
  if (!actual || actual.type !== 'ByteArray') return `${label} is not the requested parameter`;
  try {
    return byteHex(actual.value) === hex(expected.value) ? null : `${label} bytes differ`;
  } catch (error) {
    return `${label} is not a byte string: ${error.message}`;
  }
}
