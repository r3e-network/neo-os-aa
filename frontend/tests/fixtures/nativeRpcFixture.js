/**
 * v4.1 native-kernel RPC fixture.
 *
 * The answers here are the exact stack shapes of `contracts/native/SmartAccount
 * /*`: a nine-field account descriptor, the fifteen-field module descriptor,
 * [wire tag] from `getProtocolInfo`, and the shipped implementation id. The
 * recovery policy and request record are answered by the recovery *module*,
 * because v4.1 keeps no native recovery state. Anything the client does not
 * gate on is left out on purpose, so a new client read fails here instead of
 * silently passing.
 */
import {
  nativeCodec as c,
  NATIVE_SMART_ACCOUNT_CONTRACT as CORE,
} from "../../src/features/native/nativeWorkspace.js";
import {
  NATIVE_ACCOUNT_ADDRESS_ABI,
  NATIVE_PROFILE_PARAMETER_DIGEST,
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

export function createNativeRpcFixture({ accountId = nativeTestIdentity.accountId, accountAddress = nativeTestIdentity.accountAddress } = {}) {
  const state = {
    registered: false,
    defaultOperationAuthorization: true,
    magic: 123,
    malformed: false,
    protocolVersion: 4,
    implementationId: "NativeSmartAccount",
    nativeId: -13,
    status: 0,
    epoch: 1,
    config: 0,
    controlRevision: 1,
    requiredValidatorId: "0",
    custody: nativeTestCustody,
    recovery: "00".repeat(20),
    timelock: String(604800000),
    pendingRecovery: null,
    // The governance window and its intent queue live in the governance module
    // (a validator instance with the governance flag), never in the core.
    governanceDelayMs: "86400000",
    pendingConfigIntents: [],
    modules: [],
    neoBalance: "17", gasBalance: "200000001",
    hookOrder: [],
    hookRevision: 0,
    script: "",
    signers: [],
    calls: [],
    time: Date.now(),
  };
  // Extra answers the test layers on top of the descriptor surface. The key is
  // the same canonical `dynamicCall(core, method, args, 5)` script the client
  // builds for a read, so an override is byte exact and takes precedence over
  // the state-derived answer of the same call.
  const extras = new Map();
  const add = (method, args, value) =>
    extras.set(c.dynamicCall(CORE, method, args, 5), value);
  const manifest = () => ({
    name: "SmartAccount",
    extra: { smartAccount: { abiVersion: 4, profileParameterDigest: NATIVE_PROFILE_PARAMETER_DIGEST } },
    abi: {
      methods: Object.entries({
        ...NATIVE_REQUIRED_ABI,
        ...NATIVE_ACCOUNT_ADDRESS_ABI,
      }).map(([name, [types, returntype, safe, names]]) => ({
        name,
        parameters: types.map((type, index) => ({ name: names[index], type })),
        returntype,
        safe,
      })),
      // The event gate is presence-only: the client never decodes a payload,
      // so the fixture declares the names with no parameters on purpose.
      events: NATIVE_REQUIRED_EVENTS.map((name) => ({ name, parameters: [] })),
    },
  });
  // GetAccount answers exactly nine fields in v4.1:
  // [exists, status, custody, authorityEpoch, configurationNonce,
  //  defaultOperationAuthorization, defaultMessageAuthorization,
  //  requiredValidatorId, controlRevision].
  const notFound = () =>
    A([
      BOOL(false),
      I(0),
      H("00".repeat(20)),
      I(0),
      I(0),
      BOOL(false),
      BOOL(false),
      I(0),
      I(0),
    ]);
  const record = () =>
    A([
      BOOL(true),
      I(state.status),
      H(state.malformed ? "99".repeat(20) : state.custody),
      I(state.epoch),
      I(state.config),
      BOOL(state.defaultOperationAuthorization),
      BOOL(true),
      I(state.requiredValidatorId),
      I(state.controlRevision),
    ]);
  // The chain publishes each module instance's CredentialGeneration (field 8 of
  // the 15-field descriptor), so the fixture requires the test to declare it.
  // Inventing 1 here would hide exactly the stale-generation bug the routing
  // generation exists to expose.
  const generation = (module) => {
    if (module.credentialGeneration === undefined || module.credentialGeneration === null)
      throw Error(
        "nativeRpcFixture: module " + module.moduleId + " must declare credentialGeneration",
      );
    return module.credentialGeneration;
  };
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
      I(generation(module)),
      BOOL(module.instanceIsolation === true),
      BOOL(module.messageCapability === true),
      BOOL(module.thresholdMemberEligible !== false),
      BOOL(module.compositeLayer === true),
      BOOL(module.governance === true),
      BOOL(module.hookPlanner === true),
    ]);
  function answers() {
    const map = new Map();
    const add = (method, args, value) =>
      map.set(c.dynamicCall(CORE, method, args, 5), value);
    const id = c.hashValue(accountId);
    const proxy = c.hashValue(accountAddress);
    for (const [token, amount] of [["ef4073a0f2b305a38ec4050e4d3d28bc40ea63f5", state.neoBalance], ["d2a4cff31913016155e38e474a2c06d08be276cf", state.gasBalance]]) {
      map.set(c.dynamicCall(token, "balanceOf", [proxy], 5), amount === null ? N : I(amount));
    }
    const subkey = "00".repeat(32);
    const channel = c.deriveNonceChannel({ accountId, coreContractHash: CORE },
      { authorityEpoch: String(state.epoch), validatorId: "0", credentialGeneration: "1", nonceSubkey: subkey });
    add("getNonce", [id, I(0), { type: "ByteString", value: subkey }], I(c.composeNonce(channel, 0)));
    add("getProtocolInfo", [], A([I(state.protocolVersion)]));
    add("getAccountImplementationId", [], TEXT(state.implementationId));
    add("getAccount", [id], state.registered ? record() : notFound());
    for (const [type, code] of [
      ["validator", 1],
      ["hook", 4],
      ["recovery", 5],
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
    for (const seat of state.modules.filter(m => m.moduleType === 5)) {
      map.set(c.dynamicCall(seat.contractHash, "authorizedCore", [], 5), H(CORE));
      // The recovery policy is the module's own state: guardians, threshold,
      // timelock, authority, revision, digest. A seat with no configured
      // authority answers the empty Array, which the client reads as "no
      // policy" rather than inventing one.
      map.set(
        c.dynamicCall(seat.contractHash, "getRecoveryPolicySnapshot", [id], 5),
        state.recovery === "00".repeat(20)
          ? A([])
          : A([A([H(state.recovery)]), I(1), I(state.timelock), H(state.recovery), I(1), B("cc".repeat(32))]),
      );
      const p = state.pendingRecovery;
      map.set(c.dynamicCall(seat.contractHash, "getRecoveryStatus", [id], 5), !p ? A([]) : A([
        I(p.nonce ?? 1), H(state.custody), I(p.initiatedAt ?? state.time - 1000), I(p.matureAt), I(1),
        H(p.newCustody ?? "66".repeat(20)), I(p.authorityEpochAtInit ?? state.epoch),
        I(p.configurationNonceAtInit ?? state.config), B(p.policyDigest ?? "dd".repeat(32)), I(p.policyRevision ?? 1),
        I(0), I(0),
      ]));
    }
    for (const module of state.modules)
      add("getModule", [id, I(module.moduleId)], moduleRecord(module));
    // Governance reads target the module instance, exactly like recovery: the
    // core publishes neither the maturity window nor the intent queue.
    for (const seat of state.modules.filter(m => m.governance === true)) {
      map.set(c.dynamicCall(seat.contractHash, "authorizedCore", [], 5), H(CORE));
      map.set(c.dynamicCall(seat.contractHash, "configurationMaturity", [], 5), I(state.governanceDelayMs));
      map.set(
        c.dynamicCall(seat.contractHash, "getPendingConfigurationIntentIds", [id], 5),
        A(state.pendingConfigIntents.map((intent) => I(intent.intentId))),
      );
      for (const intent of state.pendingConfigIntents)
        map.set(
          c.dynamicCall(seat.contractHash, "getPendingConfiguration", [id, I(intent.intentId)], 5),
          A([
            // The module stores the kind as its UTF-8 string ("configure" / "unfreeze").
            I(intent.intentId), TEXT(intent.kind ?? "configure"), I(intent.proposedAt ?? state.time - 1000),
            I(intent.matureAt ?? state.time + 86399000), I(intent.expiresAt ?? state.time + 604799000),
            I(intent.authorityEpoch ?? state.epoch), I(intent.configurationNonce ?? state.config),
            B(intent.digest ?? "ab".repeat(32)), I(intent.actionCount ?? 1),
          ]),
        );
    }
    return map;
  }
  async function send(method, params) {
    state.calls.push({ method, params });
    if (method === "getversion") return { protocol: { network: state.magic } };
    if (method === "getcontractstate" && params[0] !== "0x" + CORE) {
      const module = state.modules.find(m => "0x" + m.contractHash === params[0]);
      return module ? { hash: params[0], id: module.contractId ?? 7, updatecounter: module.liveUpdateCounter ?? module.updateCounter ?? 1 } : null;
    }
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
        executions: [{ trigger: "Application", vmstate: "HALT", stack: [N] }],
      };
    if (method !== "invokescript") throw Error("Unsupported fixture RPC");
    const script = Buffer.from(params[0], "base64").toString("hex");
    const known = answers();
    for (const [registered, value] of extras) known.set(registered, value);
    return {
      state: "HALT",
      stack: [known.has(script) ? known.get(script) : N],
      gasconsumed: "100000",
    };
  }
  return { state, send, answers, add, manifest, record,
    setInvocationResult: (script, item) => extras.set(script, item) };
}

export const nativeTestRecoverySeat = Object.freeze({ nefSha256: "70e94cd8d1aa55411ed7612ba3d50ec7262714c5f133aa5dbb8cc9782a285870", moduleType: 5, moduleId: 17, contractHash: "ef".repeat(20), credentialGeneration: 1, profileSha256: "64e4a614163968e6306083058044c6fad3c1c0c6a6e938737485f3325b9f13e3" });
