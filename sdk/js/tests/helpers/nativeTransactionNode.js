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
  NATIVE_ACCOUNT_ADDRESS_ABI,
  NATIVE_PROFILE_PARAMETER_DIGEST,
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
  NATIVE_STANDARD_RECOVERY_NEF_SHA256,
  NATIVE_STANDARD_RECOVERY_PROFILE_SHA256,
} = require("../../src/native/client");

const NETWORK = 123;
const ACCOUNT = "11".repeat(20);
const TOKEN = "22".repeat(20);
const SUBKEY = "00".repeat(32);
const SALT = "33".repeat(32);
/** The reviewed standard recovery seat: module contract, authority, guardian. */
const RECOVERY = "44".repeat(20);
const RECOVERY_MODULE_ID = 7;
const RECOVERY_AUTHORITY = "55".repeat(20);
const GUARDIAN = "66".repeat(20);
/** The governance module: a validator instance that publishes the governance flag. */
const GOVERNANCE = "77".repeat(20);
const GOVERNANCE_MODULE_ID = 9;

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
/** A module id is `UInt64Be` in GetModule and in a GetModules page. */
const BE8 = (id) => ({
  type: "ByteString",
  value: Buffer.from(BigInt(id).toString(16).padStart(16, "0"), "hex").toString("base64"),
});
/** A SHA-256 record keeps the order the hash function produced. */
const RAW = (hex) => ({ type: "ByteString", value: Buffer.from(hex, "hex").toString("base64") });

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
    extra: { smartAccount: { abiVersion: 4, profileParameterDigest: NATIVE_PROFILE_PARAMETER_DIGEST } },
    abi: {
      methods: Object.entries({ ...NATIVE_REQUIRED_ABI, ...NATIVE_ACCOUNT_ADDRESS_ABI }).map(
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
    // The node quotes only the consumed gas: the transaction declares it as its system fee.
    simulate: { state: "HALT", stack: [{ type: "Any" }], gasconsumed: "10" },
    preflight: null,
    send: true,
    wire: null,
    tx: null,
    log: null,
    recovery: null,
  };
  const answer = (method, args, value, contract = CORE) =>
    discovery.set(c.dynamicCall(contract, method, args, 5), value);
  const registration = () => {
    answer("getProtocolInfo", [], A([I(4)]));
    answer("getAccountImplementationId", [], TEXT("NativeSmartAccount"));
    // A core that holds no module of a type answers an empty page, not a fault.
    answer(
      "getModules",
      [ARG_HASH(ACCOUNT), c.stringValue("recovery"), I(0), I(32)],
      A([A([]), I(0), I(0)]),
    );
    if (state.account) answer("getAccount", [ARG_HASH(ACCOUNT)], state.account);
  };
  registration();

  const rpcClient = {
    async send(method, params = []) {
      calls.push({ method, params });
      if (method === "getversion") return { protocol: { network: state.network } };
      if (method === "getcontractstate") {
        if (state.recovery && params[0] === "0x" + state.recovery.contract)
          return {
            id: state.recovery.contractId,
            hash: "0x" + state.recovery.contract,
            updatecounter: state.recovery.updateCounter,
          };
        return { id: -13, hash: "0x" + CORE, manifest: manifest() };
      }
      if (method === "getblockcount") return state.height;
      if (method === "getblockheader") return { time: 1700000000000 };
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
      };
    },
  };

  const client = new NativeSmartAccountClient({ rpcClient, networkMagic: network });

  /** The 9-field v4.1 account descriptor `getAccount` answers. */
  const setAccount = ({ custody, status = 0, configurationNonce = 0 } = {}) => {
    state.account = A([
      BOOL(true),
      I(status),
      H(custody),
      I(1),
      I(configurationNonce),
      BOOL(true),
      BOOL(true),
      I(0),
      I(0),
    ]);
    registration();
  };

  /**
   * Installs the reviewed standard recovery seat. The client pins the seat by
   * its profile and NEF digests, so a fixture that answers different ones is
   * reported unsupported rather than driven through an unknown interface.
   */
  const setRecoverySeat = ({
    moduleId = RECOVERY_MODULE_ID,
    contract = RECOVERY,
    contractId = 9,
    updateCounter = 0,
    nefSha256 = NATIVE_STANDARD_RECOVERY_NEF_SHA256,
    profileSha256 = NATIVE_STANDARD_RECOVERY_PROFILE_SHA256,
    policy = {
      guardians: [GUARDIAN],
      threshold: 1,
      timelockMs: 604800000,
      authority: RECOVERY_AUTHORITY,
      revision: 1,
    },
    request = [],
  } = {}) => {
    state.recovery = { moduleId, contract, contractId, updateCounter, nefSha256, profileSha256 };
    answer(
      "getModules",
      [ARG_HASH(ACCOUNT), c.stringValue("recovery"), I(0), I(32)],
      // A page answers ids as Integers; GetModule answers the id as UInt64Be.
      A([A([I(moduleId)]), I(0), I(state.recoveryNonce ?? 0)]),
    );
    answer(
      "getModule",
      [ARG_HASH(ACCOUNT), I(moduleId)],
      A([
        BE8(moduleId),
        I(5),
        H(contract),
        I(contractId),
        I(updateCounter),
        RAW(nefSha256),
        RAW(profileSha256),
        I(1),
        I(1),
        BOOL(true),
        BOOL(false),
        BOOL(false),
        BOOL(false),
        BOOL(false),
        BOOL(false),
      ]),
    );
    answer("authorizedCore", [], H(CORE), contract);
    answer(
      "getRecoveryPolicySnapshot",
      [ARG_HASH(ACCOUNT)],
      A([
        A(policy.guardians.map((guardian) => H(guardian))),
        I(policy.threshold),
        I(policy.timelockMs),
        H(policy.authority),
        I(policy.revision),
        RAW("99".repeat(32)),
      ]),
      contract,
    );
    answer("getRecoveryStatus", [ARG_HASH(ACCOUNT)], A(request), contract);
  };

  /**
   * Installs a governance module bound to this core. The node's chain time is
   * the fixed header time above, so an intent that should confirm carries a
   * `matureAt` at or before it.
   */
  const setGovernanceSeat = ({
    moduleId = GOVERNANCE_MODULE_ID,
    contract = GOVERNANCE,
    intents = [],
    delayMs = 86400000,
  } = {}) => {
    answer(
      "getModules",
      [ARG_HASH(ACCOUNT), c.stringValue("validator"), I(0), I(32)],
      A([A([I(moduleId)]), I(0), I(0)]),
    );
    answer(
      "getModule",
      [ARG_HASH(ACCOUNT), I(moduleId)],
      A([
        BE8(moduleId),
        I(1),
        H(contract),
        I(9),
        I(1),
        RAW("aa".repeat(32)),
        RAW("bb".repeat(32)),
        I(1),
        I(1),
        BOOL(true),
        BOOL(false),
        BOOL(false),
        BOOL(false),
        // Field 13 is the governance flag the seat is recognized by.
        BOOL(true),
        BOOL(false),
      ]),
    );
    answer("authorizedCore", [], H(CORE), contract);
    answer("configurationMaturity", [], I(delayMs), contract);
    answer(
      "getPendingConfigurationIntentIds",
      [ARG_HASH(ACCOUNT)],
      A(intents.map((intent) => I(intent.intentId))),
      contract,
    );
    // getPendingConfiguration -> [id, kind, proposedAt, matureAt, expiresAt,
    // authorityEpoch, configurationNonce, digest, actionCount].
    for (const intent of intents)
      answer(
        "getPendingConfiguration",
        [ARG_HASH(ACCOUNT), I(intent.intentId)],
        A([
          I(intent.intentId),
          TEXT(intent.kind),
          I(intent.proposedAt),
          I(intent.matureAt),
          I(intent.expiresAt),
          I(intent.epoch),
          I(intent.nonce),
          RAW("ab".repeat(32)),
          I(intent.actionCount),
        ]),
        contract,
      );
  };

  return { client, calls, state, answer, setAccount, setRecoverySeat, setGovernanceSeat, registration };
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
    authorityEpoch: "1",
    configurationNonce: "0",
    signature: "aa".repeat(64),
  };
}

const CAPS = { maxSystemFee: "1000", maxNetworkFee: "1000", maxTotalFee: "2000" };

/**
 * The three v4 plan shapes, each with the recipe that rebuilds it. A review is
 * only as trustworthy as the recipe that reproduces its script, so the two are
 * always produced together here.
 */
const build = {
  registration(node, { custody, salt = SALT, actions = [] } = {}) {
    const input = { custodyAddress: custody.account, salt, actions };
    return { plan: node.client.buildCreateAccountScript(input), recipe: { method: "buildCreateAccountScript", input } };
  },
  execution(node, { accountId = ACCOUNT, operation: entry = operation() } = {}) {
    const input = { accountId, operation: entry };
    return { plan: node.client.buildExecutionScript(input), recipe: { method: "buildExecutionScript", input } };
  },
  account(node, { accountId = ACCOUNT, method = "freezeAccount", args = [] } = {}) {
    const input = { method, accountId, args };
    return { plan: node.client.buildAccountActionScript(input), recipe: { method: "buildAccountActionScript", input } };
  },
};

/**
 * Review, sign and export one registration: custody is the only witness v4
 * asks for, and the recipe is what an archive replays.
 */
async function registrationReview(node, { payer = wallet(), custody = wallet() } = {}) {
  const { plan, recipe } = build.registration(node, { custody });
  node.state.simulate = { state: "HALT", stack: [{ type: "Any" }], gasconsumed: "10" };
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
async function executionReview(node, { payer = wallet(), operation: entry = operation() } = {}) {
  const { plan, recipe } = build.execution(node, { operation: entry });
  node.state.simulate = {
    state: "HALT",
    stack: [BOOL(true)],
    gasconsumed: "10",
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
  BE8,
  build,
  CAPS,
  CORE,
  GOVERNANCE,
  GOVERNANCE_MODULE_ID,
  GUARDIAN,
  H,
  I,
  NETWORK,
  RAW,
  RECOVERY,
  RECOVERY_AUTHORITY,
  RECOVERY_MODULE_ID,
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
