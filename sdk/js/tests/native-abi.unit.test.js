const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const {
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
} = require("../src/native/client");

test("native discovery catalogue matches every normative method and event descriptor", () => {
  const draft = readFileSync(
    resolve(
      __dirname,
      "../../../docs/proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md",
    ),
    "utf8",
  );
  const section = draft
    .split("## 13. Required ABI surface\n")[1]
    .split("## 14.")[0];
  const methodSection = section.split("### Events")[0];
  const methods = {};
  const blocks = [...methodSection.matchAll(/```text\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 2, "read-only and application method blocks");
  for (const [index, block] of blocks.entries()) {
    for (const [, name, fields, result] of block[1].matchAll(
      /(\w+)\(([\s\S]*?)\) -> (\w+)/g,
    )) {
      const parameters = [...fields.matchAll(/(\w+): (\w+)/g)];
      methods[name] = [
        parameters.map((parameter) => parameter[2]),
        result,
        index === 0,
        parameters.map((parameter) => parameter[1]),
      ];
    }
  }
  assert.equal(Object.keys(methods).length, 39);
  assert.deepEqual(NATIVE_REQUIRED_ABI, methods);

  const eventSection = section.split("### Events")[1];
  const eventBlock = eventSection.match(/```text\n([\s\S]*?)\n```/)[1];
  const names = Object.fromEntries(
    [...eventBlock.matchAll(/(\w+)\(([\s\S]*?)\)/g)].map(([, name, fields]) => [
      name,
      fields.split(/,\s*/).map((field) => field.trim()),
    ]),
  );
  const events = Object.fromEntries(
    [...eventSection.matchAll(/\| `(\w+)` \| `([^`]+)` \|/g)].map(
      ([, name, types]) => {
        const fields = types.split(", ");
        assert.equal(fields.length, names[name].length, `${name} field count`);
        return [
          name,
          fields.map((type, index) => ({ name: names[name][index], type })),
        ];
      },
    ),
  );
  assert.equal(Object.keys(events).length, 16);
  assert.deepEqual(NATIVE_REQUIRED_EVENTS, events);
});
