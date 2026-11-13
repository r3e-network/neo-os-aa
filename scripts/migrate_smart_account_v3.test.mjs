import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const script = require("./migrate_smart_account_v3.js");
const { loadArtifact } = require("./lib/deploy-helpers.js");

test("account id parsing normalizes, rejects malformed input and duplicates", () => {
  const a = "0x112233445566778899aabbccddeeff0011223344";
  const b = "0x112233445566778899aabbccddeeff0011223355";
  assert.deepEqual(script.parseAccountIds(`${a}, ${b}`), [a, b]);
  assert.deepEqual(script.parseAccountIds(`${a}\n${b}`), [a, b]);
  assert.throws(() => script.parseAccountIds(""), /no account ids provided/);
  assert.throws(() => script.parseAccountIds("0x12"), /not a 20-byte script hash/);
  assert.throws(() => script.parseAccountIds("not-a-hash"), /not a 20-byte script hash/);
  assert.throws(() => script.parseAccountIds(`${a},${a}`), /duplicate account ids/);
});

test("rotation migration batches account ids without splitting or losing rows", () => {
  const ids = Array.from({ length: 121 }, (_, index) =>
    `0x${String(index).padStart(40, "0")}`.slice(0, 42),
  ).map((id) => id.replace(/^0x/, "0x"));
  const batches = script.chunkAccountIds(ids, 50);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.flat(), ids);
  assert.equal(batches[2].length, 21);
  assert.throws(() => script.chunkAccountIds(ids, 0), /positive integer/);
  assert.throws(() => script.chunkAccountIds(ids, 1.5), /positive integer/);
});

test("registrar deploy data is the core hash in VM byte order", () => {
  const coreHash = "0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2";
  assert.equal(
    script.registrarDeployDataHex(coreHash),
    Buffer.from(coreHash.slice(2), "hex").reverse().toString("hex"),
  );
  // Same convention as the needs_core deployments in neoexpress_validate.py.
  const validator = fs.readFileSync(new URL("./neoexpress_validate.py", import.meta.url), "utf8");
  assert.match(validator, /bytes\.fromhex\(core\[2:\]\)\[::-1\]/);
});

test("migration surface assertions fail closed on a pre-1b core", () => {
  assert.deepEqual(
    script.assertLiveMigrationSurface({
      manifest: { abi: { methods: [{ name: "update" }, ...script.REQUIRED_MIGRATION_METHODS.map((name) => ({ name }))] } },
    }),
    script.REQUIRED_MIGRATION_METHODS,
  );
  assert.throws(() => script.assertLiveMigrationSurface({ manifest: { abi: { methods: [] } } }), /does not expose update/);
  const partial = {
    manifest: {
      abi: {
        methods: [
          { name: "update" },
          { name: "setMarketService" },
          { name: "rotatePlatformAccountOwner" },
        ],
      },
    },
  };
  assert.deepEqual(script.assertLiveMigrationSurface(partial), ["setMarketService"]);
});

test("account id parameters marshal as an array of Hash160 entries", () => {
  const param = script.accountIdsParam(["0x112233445566778899aabbccddeeff0011223344", "0x112233445566778899aabbccddeeff0011223355"]);
  const { neon } = require("./lib/deploy-helpers.js");
  const { sc } = neon;
  assert.equal(param.type, sc.ContractParamType.Array);
  assert.equal(param.value.length, 2);
  assert.equal(param.value[0].type, sc.ContractParamType.Hash160);
  assert.equal(String(param.value[0].value), "112233445566778899aabbccddeeff0011223344");
});

test("the candidate artifact carries the full migration surface", () => {
  const { manifest } = loadArtifact("SmartAccountV3");
  const methods = new Set((manifest.abi?.methods || []).map((method) => method.name));
  for (const method of script.REQUIRED_MIGRATION_METHODS) {
    assert.equal(methods.has(method), true, method);
  }
});

test("migration phases keep the read-only audit separate from the chain-writing phases", () => {
  const phases = script.migrationPhases();
  assert.equal(phases[0].flag, "--verify");
  assert.equal(phases[0].writes, false);
  assert.ok(phases.slice(1).every((phase) => phase.writes === true));
  assert.deepEqual(
    phases.map((phase) => phase.flag),
    ["--verify", "--enroll-market", "--propose-registrar", "--confirm-registrar", "--migrate-rotations"],
  );
});

test("migration execution requires an explicit confirmation and an environment WIF", () => {
  const source = fs.readFileSync(new URL("./migrate_smart_account_v3.js", import.meta.url), "utf8");
  assert.match(source, /--execute/);
  assert.match(source, /CONFIRM_AA_TESTNET_MIGRATION/);
  assert.match(source, /AA_TESTNET_UPDATE_WIF/);
  assert.match(source, /run one migration phase per invocation/);
  assert.doesNotMatch(source, /Kx2Bey|L[1-9A-HJ-NP-Za-km-z]{50,}/);
});
