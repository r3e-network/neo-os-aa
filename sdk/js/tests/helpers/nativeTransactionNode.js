/**
 * A v4 node fixture for the native transaction suites.
 *
 * The client, the codec, the proxy-witness builder and the artifact transport
 * all run their production code; only the node's answers are fixtures. Every
 * method a transaction lifecycle may call is answered here in wire form, and
 * each answer can be replaced per test, so a refusal is always attributable to
 * the production gate rather than to the fixture.
 *
 * Wallets are real P-256 key pairs: the SDK verifies every signature it
 * exports, so a fixture signature would only prove the fixture.
 */

const crypto = require("node:crypto");
const {
  NativeSmartAccountClient,
  nativeCodec: c,
  NATIVE_SMART_ACCOUNT_CONTRACT: CORE,
} = require("../../src/native");
const {
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
} = require("../../src/native/client");

const NETWORK = 123;
const ACCOUNT = "11".repeat(20);
const TOKEN = "22".repeat(20);
const SUBKEY = "00".repeat(32);
const SALT = "33".repeat(32);

const I = (value) => ({ type: "Integer", value: String(value) });
const A = (value) => ({ type: "Array", value });
const BOOL = (value) => ({ type: "Boolean", value });
const ANY = Object.freeze({ type: "Any", value: null });
/** Stack values are wire form: a hash is base64 of its stored byte order. */
const H = (displayHex) => ({
  type: "ByteString",
  value: Buffer.from(displayHex, "hex").reverse().toString("base64"),
});
const TEXT = (text) => ({
  type: "ByteString",
  value: Buffer.from(text, "utf8").toString("base64"),
});
/** Call arguments are codec form: a ByteString is hex, a hash is stored order. */
const ARG_HASH = (displayHex) => ({
  type: "ByteString",
  value: Buffer.from(displayHex, "hex").reverse().toString("hex"),
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const scriptHash = (verification) =>
  Buffer.from(
    crypto
      .createHash("ripemd160")
      .update(crypto.createHash("sha256").update(Buffer.from(verification, "hex")).digest())
      .digest(),
  )
    .reverse()
    .toString("hex");

/** A single-signature P-256 wallet: account id, standard script, real signer. */
function wallet() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const compressed = Buffer.concat([Buffer.from([2 + (y[31] & 1)]), x]);
  const verificationScript = "0c21" + compressed.toString("hex") + "4156e7b327";
  return {
    account: scriptHash(verificationScript),
    verificationScript,
    sign: (signData) =>
      crypto
        .sign("sha256", Buffer.from(signData, "hex"), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        })
        .toString("hex"),
  };
}

/** The ABI a v4 kernel must publish, taken from the client's own gate. */
function manifest() {
  return {
    name: "SmartAccount",
    abi: {
      methods: Object.entries(NATIVE_REQUIRED_ABI).map(
        ([name, [types, returntype, safe, names]]) => ({
          name,
          parameters: names.map((parameter, index) => ({
            name: parameter,
            type: types[index],
          })),
          returntype,
          safe,
        }),
      ),
      events: NATIVE_REQUIRED_EVENTS.map((name) => ({ name, parameters: [] })),
    },
  };
}

function createNode({ network = NETWORK } = {}) {
  const calls = [];
  const discovery = new Map();
  const state = {
    network,
    height: 100,
    networkFee: "50",
    account: null,
    // A HALTed invocation with no stack is what a `Void` entry point returns.
    simulate: { state: "HALT", stack: [], gasconsumed: "10", minimumrequiredfee: "100" },
    preflight: null,
    send: true,
    wire: null,
    tx: null,
    log: null,
  };
  const answer = (method, args, value, contract = CORE) =>
    discovery.set(c.dynamicCall(contract, method, args, 5), value);
  const registration = () => {
    answer("getProtocolInfo", [], A([I(4), BOOL(false)]));
    answer("getAccountImplementationId", [], TEXT("NativeSmartAccount/v4"));
    if (state.account) answer("getAccount", [ARG_HASH(ACCOUNT)], state.account);
  };
  registration();

  const rpcClient = {
    async send(method, params = []) {
      calls.push({ method, params });
      if (method === "getversion") return { protocol: { network: state.network } };
      if (method === "getcontractstate")
        return { id: -13, hash: "0x" + CORE, manifest: manifest() };
      if (method === "getblockcount") return state.height;
      if (method === "calculatenetworkfee") return { networkfee: state.networkFee };
      if (method === "sendrawtransaction") {
        if (state.send instanceof Error) throw state.send;
        return state.send;
      }
      if (method === "invoketransaction")
        return typeof state.preflight === "function"
          ? state.preflight()
          : clone(state.preflight);
      if (method === "getrawtransaction")
        return params[1] ? clone(state.tx) : state.wire;
      if (method === "getapplicationlog") return clone(state.log);
      if (method !== "invokescript")
        throw new Error(`unexpected fixture method ${method}`);
      const script = Buffer.from(String(params[0]), "base64").toString("hex");
      if (discovery.has(script))
        return { state: "HALT", stack: [clone(discovery.get(script))], gasconsumed: "0" };
      // Everything else is the application preflight of a plan.
      return {
        state: state.simulate.state,
        ...(state.simulate.exception ? { exception: state.simulate.exception } : {}),
        stack: clone(state.simulate.stack),
        gasconsumed: state.simulate.gasconsumed,
        ...(state.simulate.minimumrequiredfee === undefined
          ? {}
          : { minimumrequiredfee: state.simulate.minimumrequiredfee }),
      };
    },
  };

  const client = new NativeSmartAccountClient({ rpcClient, networkMagic: network });

  /** The 16-field account descriptor a v4 core answers. */
  const setAccount = ({ custody, recovery = "00".repeat(20), status = 0 } = {}) => {
    state.account = A([
      BOOL(true),
      I(status),
      H(custody),
      H(recovery),
      I(0),
      I(0),
      I(0),
      BOOL(true),
      BOOL(true),
      BOOL(false),
      I(0),
      I(0),
      BOOL(false),
      I(0),
      BOOL(false),
      A([]),
    ]);
    registration();
  };

  return { client, calls, state, answer, setAccount, registration };
}

/** The v4 operation envelope: 13 fields, field 11 non-empty for a real request. */
function operation({
  targetContract = TOKEN,
  method = "transfer",
  args = [],
  nonce = "0",
  deadline = "9999999999999",
} = {}) {
  return {
    targetContract,
    method,
    args,
    nonce,
    nonceSubkey: SUBKEY,
    deadline,
    validatorId: "0",
    credentialGeneration: "1",
    authorityEpoch: "0",
    configurationNonce: "0",
    signature: "aa".repeat(64),
  };
}

const CAPS = { maxSystemFee: "1000", maxNetworkFee: "1000", maxTotalFee: "2000" };

/**
 * The four v4 plan shapes, each with the recipe that rebuilds it. A review is
 * only as trustworthy as the recipe that reproduces its script, so the two are
 * always produced together here.
 */
const build = {
  registration(node, { custody, salt = SALT, recoveryTimelockMs = 0 } = {}) {
    const input = { custodyAddress: custody.account, salt, recoveryTimelockMs };
    return { plan: node.client.buildCreateAccountScript(input), recipe: { method: "buildCreateAccountScript", input } };
  },
  execution(node, { accountId = ACCOUNT, ops = [operation()] } = {}) {
    const input = { accountId, operations: ops };
    return { plan: node.client.buildExecutionScript(input), recipe: { method: "buildExecutionScript", input } };
  },
  account(node, { accountId = ACCOUNT, method = "freezeAccount", args = [] } = {}) {
    const input = { method, accountId, args };
    return { plan: node.client.buildAccountActionScript(input), recipe: { method: "buildAccountActionScript", input } };
  },
  configuration(node, { accountId = ACCOUNT, kind = "propose", intentId = 7, actions = [], readSet = [] } = {}) {
    const input = { kind, accountId, intentId, actions, readSet };
    return { plan: node.client.buildConfigurationScript(input), recipe: { method: "buildConfigurationScript", input } };
  },
};

/**
 * Review, sign and export one registration: custody is the only witness v4
 * asks for, and the recipe is what an archive replays.
 */
async function registrationReview(node, { payer = wallet(), custody = wallet() } = {}) {
  const { plan, recipe } = build.registration(node, { custody });
  node.state.simulate = { state: "HALT", stack: [], gasconsumed: "10", minimumrequiredfee: "100" };
  const prepared = await node.client.prepareTransaction(plan, {
    feePayer: payer,
    authorizers: [custody],
    recipe,
    ...CAPS,
    systemFee: "200",
    nonce: 42,
  });
  const signed = await node.client.signTransaction(prepared);
  return {
    payer,
    custody,
    plan,
    prepared,
    signed,
    review: prepared.review,
    artifact: node.client.exportSignedTransaction(signed),
  };
}

/**
 * Review, sign and export one execution: the fee payer is index 0, the account
 * proxy is index 1 and carries no signature, and no other witness is asked for.
 */
async function executionReview(node, { payer = wallet(), ops = [operation()] } = {}) {
  const { plan, recipe } = build.execution(node, { ops });
  node.state.simulate = {
    state: "HALT",
    stack: plan.batch ? [A(ops.map(() => BOOL(true)))] : [BOOL(true)],
    gasconsumed: "10",
    minimumrequiredfee: "100",
  };
  const prepared = await node.client.prepareTransaction(plan, {
    feePayer: payer,
    recipe,
    ...CAPS,
    systemFee: "200",
    nonce: 42,
  });
  const signed = await node.client.signTransaction(prepared);
  return {
    payer,
    plan,
    prepared,
    signed,
    review: prepared.review,
    artifact: node.client.exportSignedTransaction(signed),
  };
}

module.exports = {
  ACCOUNT,
  ANY,
  A,
  ARG_HASH,
  BOOL,
  build,
  CAPS,
  CORE,
  H,
  I,
  NETWORK,
  SALT,
  SUBKEY,
  TEXT,
  TOKEN,
  c,
  clone,
  createNode,
  executionReview,
  manifest,
  operation,
  registrationReview,
  wallet,
};
