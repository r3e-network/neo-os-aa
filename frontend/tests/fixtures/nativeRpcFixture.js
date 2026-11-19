/**
 * v4 native-kernel RPC fixture.
 *
 * The answers here are the exact stack shapes of `contracts/native/SmartAccount
 * /*`: a 16-field account descriptor, the 8-field intent record, the 12-field
 * module descriptor, [version, migrationModeOpen] from `getProtocolInfo`, and
 * the shipped implementation id. Anything the client does not gate on is left
 * out on purpose, so a new client read fails here instead of silently passing.
 */
import {
  nativeCodec as c,
  NATIVE_SMART_ACCOUNT_CONTRACT as CORE,
} from "../../src/features/native/nativeWorkspace.js";
import {
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
} from "../../src/shared/nativeSmartAccountClient.mjs";

export const nativeTestCustody = "11".repeat(20),
  nativeTestRecovery = "22".repeat(20),
  nativeTestSalt = "33".repeat(32),
  nativeTestTarget = "44".repeat(20);
export const nativeTestIdentity = c.deriveIdentity({
  custodyAddress: nativeTestCustody,
  salt: nativeTestSalt,
  callFlags: 5,
});

const I = (value) => ({ type: "Integer", value: String(value) }),
  BOOL = (value) => ({ type: "Boolean", value: value === true }),
  B = (hex) => ({
    type: "ByteString",
    value: Buffer.from(hex, "hex").toString("base64"),
  }),
  TEXT = (text) => B(Buffer.from(text, "utf8").toString("hex")),
  H = (hex) => B(Buffer.from(hex, "hex").reverse().toString("hex")),
  A = (value) => ({ type: "Array", value }),
  N = { type: "Any", value: null };
// Canonical VM values become RPC stack items. A ByteString travels as base64
// over RPC and as hex inside the script builder, so this round trip is exactly
// what `getPendingConfiguration` has to survive to rebuild a confirm script.
const RPC = (v) => {
  if (v === null || v === undefined) return N;
  if (v.type === "Integer") return I(v.value);
  if (v.type === "Boolean") return BOOL(v.value);
  if (v.type === "ByteString") return B(v.value);
  if (v.type === "Array") return A(v.value.map(RPC));
  throw Error("fixture: unsupported canonical VM value");
};

export function createNativeRpcFixture({ accountId = nativeTestIdentity.accountId } = {}) {
  const state = {
    registered: false,
    magic: 123,
    malformed: false,
    protocolVersion: 4,
    implementationId: "NativeSmartAccount/v4",
    nativeId: -13,
    status: 0,
    epoch: 0,
    config: 0,
    custody: nativeTestCustody,
    recovery: "00".repeat(20),
    timelock: String(604800000),
    pendingRecovery: null,
    intents: {},
    modules: [],
    hookOrder: [],
    hookRevision: 0,
    script: "",
    signers: [],
    calls: [],
    time: Date.now(),
  };
  const manifest = () => ({
    name: "SmartAccount",
    extra: {},
    abi: {
      methods: Object.entries(NATIVE_REQUIRED_ABI).map(
        ([name, [types, returntype, safe, names]]) => ({
          name,
          parameters: types.map((type, index) => ({ name: names[index], type })),
          returntype,
          safe,
        }),
      ),
      // The event gate is presence-only: the client never decodes a payload,
      // so the fixture declares the names with no parameters on purpose.
      events: NATIVE_REQUIRED_EVENTS.map((name) => ({ name, parameters: [] })),
    },
  });
  const notFound = () =>
    A([
      BOOL(false),
      I(0),
      H("00".repeat(20)),
      H("00".repeat(20)),
      I(0),
      I(0),
      I(0),
      BOOL(false),
      BOOL(false),
      BOOL(false),
      I(0),
      I(0),
      BOOL(false),
      I(0),
      BOOL(false),
      N,
    ]);
  const record = () =>
    A([
      BOOL(true),
      I(state.status),
      H(state.malformed ? "99".repeat(20) : state.custody),
      H(state.recovery),
      I(state.epoch),
      I(state.config),
      I(state.timelock),
      BOOL(true),
      BOOL(true),
      BOOL(false),
      I(state.hookRevision),
      I(state.config),
      BOOL(!!state.pendingRecovery),
      I(state.pendingRecovery?.matureAt ?? 0),
      BOOL(false),
      N,
    ]);
  const intentRecord = (intent) =>
    A([
      BOOL(true),
      I(intent.intentId),
      I(intent.proposedAt),
      I(intent.matureAt),
      I(intent.expiresAt),
      I(intent.authorityEpoch ?? state.epoch),
      intent.actionDigest,
      A((intent.actions ?? []).map(RPC)),
    ]);
  const moduleRecord = (module) =>
    A([
      I(module.moduleId),
      I(module.moduleType),
      H(module.contractHash),
      I(module.contractId ?? 7),
      I(module.updateCounter ?? 1),
      B(module.nefSha256 ?? "aa".repeat(32)),
      B(module.profileSha256 ?? "bb".repeat(32)),
      I(module.moduleRevision ?? 1),
      I(module.credentialGeneration ?? 1),
      BOOL(module.instanceIsolation === true),
      BOOL(module.messageCapability === true),
      BOOL(module.thresholdMemberEligible !== false),
    ]);
  function answers() {
    const map = new Map();
    const add = (method, args, value) =>
      map.set(c.dynamicCall(CORE, method, args, 5), value);
    const id = c.hashValue(accountId);
    add("getProtocolInfo", [], A([I(state.protocolVersion), BOOL(false)]));
    add("getAccountImplementationId", [], TEXT(state.implementationId));
    add("getAccount", [id], state.registered ? record() : notFound());
    add(
      "getRecoveryStatus",
      [id],
      state.pendingRecovery
        ? A([
            BOOL(true),
            I(state.pendingRecovery.initiatedAt ?? state.time - 1000),
            I(state.pendingRecovery.matureAt),
            I(state.pendingRecovery.authorityEpochAtInit ?? state.epoch),
            H(state.pendingRecovery.newCustody ?? "66".repeat(20)),
          ])
        : A([]),
    );
    const intents = Object.values(state.intents);
    add(
      "getPendingConfigurationIntentIds",
      [id],
      A(intents.map((intent) => I(intent.intentId))),
    );
    for (const intent of intents)
      add("getPendingConfiguration", [id, I(intent.intentId)], intentRecord(intent));
    // A node answers an empty Array for an id that is not pending. The client
    // must see that shape, not a null stack item, so ids outside the fixture's
    // state are answered explicitly for the range the tests exercise.
    const pendingIds = new Set(intents.map((intent) => intent.intentId));
    for (let intentId = 0; intentId <= 64; intentId++)
      if (!pendingIds.has(intentId))
        add("getPendingConfiguration", [id, I(intentId)], A([]));
    for (const [type, code] of [
      ["validator", 1],
      ["hook", 4],
    ])
      add(
        "getModules",
        [id, c.stringValue(type), I(0), I(32)],
        A([
          A(
            state.modules
              .filter((module) => module.moduleType === code)
              .map((module) => I(module.moduleId)),
          ),
          I(0),
          I(state.config),
        ]),
      );
    for (const module of state.modules)
      add("getModule", [id, I(module.moduleId)], moduleRecord(module));
    add(
      "getHookOrder",
      [id],
      A([A(state.hookOrder.map((hookId) => I(hookId))), I(state.hookRevision)]),
    );
    return map;
  }
  async function send(method, params) {
    state.calls.push({ method, params });
    if (method === "getversion") return { protocol: { network: state.magic } };
    if (method === "getcontractstate")
      return { id: state.nativeId, hash: "0x" + CORE, manifest: manifest() };
    if (method === "getblockcount") return 10;
    if (method === "getblockheader") return { time: state.time };
    if (method === "getrawtransaction")
      return {
        hash: params[0],
        blockhash: "0x" + "bb".repeat(32),
        script: Buffer.from(state.script, "hex").toString("base64"),
        signers: state.signers,
      };
    if (method === "getapplicationlog")
      return {
        txid: params[0],
        executions: [{ trigger: "Application", vmstate: "HALT", stack: [] }],
      };
    if (method !== "invokescript") throw Error("Unsupported fixture RPC");
    const script = Buffer.from(params[0], "base64").toString("hex");
    const known = answers();
    return {
      state: "HALT",
      stack: [known.has(script) ? known.get(script) : N],
      gasconsumed: "100000",
      minimumrequiredfee: "100000",
    };
  }
  return { state, send, answers, manifest, record };
}
