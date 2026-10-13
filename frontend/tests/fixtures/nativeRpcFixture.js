import {
  nativeCodec as c,
  NATIVE_ACCOUNT_SERVICE as CORE,
  NATIVE_PROFILE_PARAMETER_DIGEST,
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
  networkMagic: 123,
  custodyAddress: nativeTestCustody,
  salt: nativeTestSalt,
});
const I = (value) => ({ type: "Integer", value: String(value) }),
  B = (hex) => ({
    type: "ByteString",
    value: Buffer.from(hex, "hex").toString("base64"),
  }),
  H = (hex) => B(Buffer.from(hex, "hex").reverse().toString("hex")),
  A = (value) => ({ type: "Array", value }),
  N = { type: "Any", value: null };
export function createNativeRpcFixture() {
  const state = {
    registered: false,
    abiVersion: 2,
    digest: NATIVE_PROFILE_PARAMETER_DIGEST,
    nativeId: -13,
    magic: 123,
    malformed: false,
    epoch: 0,
    config: 0,
    frozen: false,
    script: "",
    calls: [],
    time: Date.now(),
    pending: null,
  };
  const responses = new Map();
  const add = (method, args, value) =>
    responses.set(c.dynamicCall(CORE, method, args, 5), value);
  const manifest = () => ({
    name: "AccountManagement",
    extra: {
      smartAccount: {
        abiVersion: state.abiVersion,
        profileParameterDigest: state.digest,
      },
    },
    abi: {
      methods: Object.entries(NATIVE_REQUIRED_ABI).map(
        ([name, [types, returntype, safe, names]]) => ({
          name,
          parameters: types.map((type, index) => ({
            name: names[index],
            type,
          })),
          returntype,
          safe,
        }),
      ),
      events: Object.entries(NATIVE_REQUIRED_EVENTS).map(
        ([name, parameters]) => ({
          name,
          parameters: structuredClone(parameters),
        }),
      ),
    },
  });
  const record = () =>
    A([
      I(2),
      H(nativeTestIdentity.accountId),
      H(state.malformed ? "99".repeat(20) : nativeTestIdentity.accountAddress),
      H(nativeTestCustody),
      H(nativeTestRecovery),
      N,
      N,
      I(state.frozen ? 1 : 0),
      I(state.config),
      N,
      N,
      N,
      state.pending
        ? A([
            H("55".repeat(20)),
            I(state.time - 604800001),
            I(state.time - 1),
            I(state.config),
          ])
        : N,
      I(state.epoch),
    ]);
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
    add("getVersion", [], I(2));
    add(
      "getAccount",
      [c.hashValue(nativeTestIdentity.accountId)],
      state.registered ? record() : N,
    );
    add(
      "getAuthorityEpoch",
      [c.hashValue(nativeTestIdentity.accountId)],
      I(state.epoch),
    );
    add(
      "getAuthorizationDomain",
      [c.hashValue(nativeTestIdentity.accountId)],
      B(
        c.authorizationDomain({
          networkMagic: 123,
          accountId: nativeTestIdentity.accountId,
          authorityEpoch: state.epoch,
          configurationNonce: state.config,
        }),
      ),
    );
    add("getNonce", [c.hashValue(nativeTestIdentity.accountId), I(0)], I(0));
    if (responses.has(script))
      return {
        state: "HALT",
        stack: [responses.get(script)],
        gasconsumed: "100000",
        minimumrequiredfee: "100000",
      };
    return {
      state: "HALT",
      stack: [N],
      gasconsumed: "100000",
      minimumrequiredfee: "100000",
    };
  }
  return { state, send, add, manifest, record };
}
