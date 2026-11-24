/**
 * Neo N3 Smart Account v4 signed-transaction artifacts.
 *
 * This module is the one place that answers three questions the SDK, the
 * relay and the browser wallet must answer identically:
 *
 * 1. What bytes does a transaction sign? `unsigned()` serializes a Neo N3
 *    transaction with the v4 signer scopes, including the account proxy's
 *    `WitnessRules` signer (exactly one Allow/CalledByContract(core) rule).
 *    The v3 serializer only knew None/CustomContracts, so a proxy-witness
 *    transaction could not be hashed at all.
 * 2. May a signed artifact authorize this exact reviewed intent? The review
 *    carries the v4 plan (registration, execution or account action) plus the
 *    recipe that rebuilt it, so bytes that are not the canonical encoding of
 *    the reviewed intent are refused.
 * 3. Can an archived review be restored to read a receipt? Yes — and a
 *    restored artifact can never be preflighted or broadcast.
 *
 * Signer index 0 is always the fee payer. For an execution plan index 1 is the
 * account proxy, whose witness carries no signature: the chain accepts it only
 * because the script is one shaped executeUserOp(s) call on the core. The proxy
 * can never be the fee payer, so the two roles cannot alias.
 */

import {
  parseNativeRpcFees,
  validateNativeApplicationExecution,
  validateNativeInvocationResult,
} from "./nativeSmartAccountClient.mjs";
import { PROTOCOL_VERSION } from "./nativeSmartAccount.mjs";
import { createProxyWitness } from "./proxyWitness.mjs";

export const NATIVE_SIGNED_ARTIFACT_MAX_CHARS = 1048576;
const MAX_TRANSACTION_BYTES = 102400;
const PLAN_KINDS = ["registration", "execution", "account", "recovery"];
// The account actions of the minimal core: freezing, thawing and the two
// module-administration calls. Recovery, credential revocation and the
// configuration intents are user-space module concerns, so their scripts are
// not reconstructable here and cannot be archived as native plans.
const ACCOUNT_ACTIONS = [
  "freezeAccount",
  "unfreezeAccount",
  "installModule",
  "removeModule",
];
const WITNESS_RULE_CONDITIONS = ["CalledByContract"];

const fail = (message) => {
  throw new Error(`Native transaction: ${message}`);
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const exactKeys = (value, keys, label) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    fail(`${label} has unsupported or missing fields`);
};
const hex = (value, bytes, maximum = MAX_TRANSACTION_BYTES) => {
  if (
    typeof value !== "string" ||
    value.length > maximum * 2 ||
    !/^(?:[0-9a-f]{2})*$/.test(value) ||
    (bytes !== undefined && value.length !== bytes * 2)
  )
    fail("artifact hex must use canonical lowercase bytes within size limits");
  return value;
};
const uint32 = (n, label) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
    fail(`${label} must be UInt32`);
  return n;
};
const fee = (value, label) => {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) >= 1n << 63n
  )
    fail(`${label} must be a canonical nonnegative Int64 decimal string`);
  return BigInt(value);
};
const reverse = (s) => s.match(/../g).reverse().join("");
const le = (value, size) => {
  let n = BigInt(value),
    out = "";
  for (let i = 0; i < size; i++) {
    out += Number(n & 255n).toString(16).padStart(2, "0");
    n >>= 8n;
  }
  if (n) fail("integer overflow");
  return out;
};
const vi = (n) =>
  n < 253 ? le(n, 1) : n <= 65535 ? "fd" + le(n, 2) : "fe" + le(n, 4);
const vb = (s) => vi(s.length / 2) + s;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const toBase64 = (s) =>
  btoa(
    s.replace(/../g, (h) => String.fromCharCode(parseInt(h, 16))),
  );
const fromBase64 = (s) => {
  if (
    typeof s !== "string" ||
    s.length > Math.ceil(MAX_TRANSACTION_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      s,
    )
  )
    fail("persisted transaction must use bounded canonical base64");
  const bytes = atob(s);
  if (btoa(bytes) !== s) fail("persisted transaction has noncanonical base64");
  return Array.from(
    bytes,
    (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
};
const hash160 = (value, label) => {
  if (typeof value !== "string") fail(`${label} must be a Hash160`);
  const h = value.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(h) || /^0+$/.test(h))
    fail(`${label} must be a nonzero Hash160`);
  return h;
};
const accountHash = (value) => {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value))
    fail("signer account must be canonical UInt160");
  return value;
};

/**
 * The discoverable v4 profile. `implementationId` is whatever the submitting
 * core answers (`NativeSmartAccount` for the native core), and it is
 * authenticated by the profile that both the review and the artifact must
 * agree on.
 *
 * The contract hash is shape-checked here, not pinned to the native constant:
 * a local chain may register the core at another hash, so the caller that knows
 * the deployment is the one that compares (`checked`/`bindArtifact` compare a
 * restored artifact against `profile(client.profile)`).
 */
function profile(value) {
  exactKeys(
    value,
    ["contract", "networkMagic", "protocolVersion", "implementationId"],
    "profile",
  );
  const contract = hex(value.contract, 20);
  if (/^0+$/.test(contract) || value.protocolVersion !== PROTOCOL_VERSION)
    fail("unsupported native profile");
  if (
    typeof value.implementationId !== "string" ||
    !/^[0-9A-Za-z._:\/-]{1,128}$/.test(value.implementationId)
  )
    fail("unsupported native implementation id");
  return {
    contract,
    networkMagic: uint32(value.networkMagic, "network magic"),
    protocolVersion: PROTOCOL_VERSION,
    implementationId: value.implementationId,
  };
}

function condition(value) {
  exactKeys(value, ["type", "hash"], "witness condition");
  if (!WITNESS_RULE_CONDITIONS.includes(value.type))
    fail("only CalledByContract witness conditions are expressible");
  return { type: value.type, hash: hash160(value.hash, "witness condition hash") };
}

function rule(value) {
  exactKeys(value, ["action", "condition"], "witness rule");
  if (value.action !== "Allow")
    fail("the account proxy carries exactly one Allow witness rule");
  return { action: value.action, condition: condition(value.condition) };
}

/**
 * A transaction signer descriptor. `WitnessRules` is the account proxy's
 * scope and admits exactly one Allow/CalledByContract rule; every other scope
 * is a plain wallet scope. Allowed contracts and groups are not part of the
 * v4 transactions this SDK builds.
 */
function signer(value) {
  if (value?.scopes === "WitnessRules") {
    exactKeys(value, ["account", "scopes", "rules"], "signer");
    if (
      !Array.isArray(value.rules) ||
      value.rules.length !== 1 ||
      !value.rules[0]
    )
      fail("the account proxy carries exactly one witness rule");
    return {
      account: accountHash(value.account),
      scopes: value.scopes,
      rules: [rule(value.rules[0])],
    };
  }
  if (value?.scopes === "CustomContracts") {
    exactKeys(value, ["account", "scopes", "allowedcontracts"], "signer");
    if (
      !Array.isArray(value.allowedcontracts) ||
      !value.allowedcontracts.length ||
      value.allowedcontracts.length > 16 ||
      value.allowedcontracts.some(
        (h) => typeof h !== "string" || !/^0x[0-9a-f]{40}$/.test(h),
      ) ||
      new Set(value.allowedcontracts).size !== value.allowedcontracts.length
    )
      fail("signer allowlist must be 1..16 distinct canonical UInt160 values");
    return {
      account: accountHash(value.account),
      scopes: value.scopes,
      allowedcontracts: [...value.allowedcontracts],
    };
  }
  exactKeys(value, ["account", "scopes"], "signer");
  if (!["None", "CalledByEntry", "Global"].includes(value.scopes))
    fail("unsupported signer scope");
  return { account: accountHash(value.account), scopes: value.scopes };
}

/** Witness-rule signer encoding: scope byte, rule count, action, condition. */
function signerBytes(s) {
  const account = reverse(s.account.slice(2));
  if (s.scopes === "None") return account + "00";
  if (s.scopes === "CalledByEntry") return account + "01";
  if (s.scopes === "Global") return account + "80";
  if (s.scopes === "WitnessRules")
    return (
      account +
      "40" +
      vi(s.rules.length) +
      s.rules
        .map((r) => "01" + "28" + reverse(r.condition.hash))
        .join("")
    );
  return (
    account +
    "10" +
    vi(s.allowedcontracts.length) +
    s.allowedcontracts.map((h) => reverse(h.slice(2))).join("")
  );
}

function transaction(value) {
  exactKeys(
    value,
    ["nonce", "systemFee", "networkFee", "validUntilBlock", "script", "signers"],
    "transaction",
  );
  fee(value.systemFee, "system fee");
  fee(value.networkFee, "network fee");
  if (
    !Array.isArray(value.signers) ||
    !value.signers.length ||
    value.signers.length > 16
  )
    fail("transaction needs 1..16 signers");
  const signers = value.signers.map(signer);
  if (new Set(signers.map((s) => s.account)).size !== signers.length)
    fail("duplicate transaction signer");
  const script = hex(value.script, undefined, 65535);
  if (!script) fail("empty transaction script");
  return {
    nonce: uint32(value.nonce, "nonce"),
    systemFee: value.systemFee,
    networkFee: value.networkFee,
    validUntilBlock: uint32(value.validUntilBlock, "valid until block"),
    script,
    signers,
  };
}
function witnesses(values, count) {
  if (!Array.isArray(values) || values.length !== count)
    fail("witness count does not match signers");
  return values.map((value) => {
    exactKeys(value, ["invocation", "verification"], "witness");
    return {
      invocation: hex(value.invocation, undefined, 1024),
      verification: hex(value.verification, undefined, 1024),
    };
  });
}
function unsigned(tx) {
  return (
    "00" +
    le(tx.nonce, 4) +
    le(tx.systemFee, 8) +
    le(tx.networkFee, 8) +
    le(tx.validUntilBlock, 4) +
    vi(tx.signers.length) +
    tx.signers.map(signerBytes).join("") +
    "00" +
    vb(tx.script)
  );
}

/**
 * The canonical proxy signer/witness for an execution plan.
 *
 * The proxy address is not a claim: it is recomputed from the account id, the
 * core and the plan's call flags, so a review that pairs an account id with a
 * foreign proxy script is refused here instead of on chain. The witness itself
 * comes from shared/proxyWitness.mjs, so the SDK cannot grow a second
 * construction; only the artifact's own signer/witness shapes are applied.
 */
function proxyArtifacts(c, contract, plan, payer) {
  const proxyAddress = c.accountAddress(plan.accountId, {
    coreContractHash: contract,
    callFlags: plan.proxyCallFlags,
  });
  if (proxyAddress !== plan.accountAddress)
    fail("review proxy address is not the account's proxy under this core");
  const proxy = createProxyWitness({
    coreHash: contract,
    accountId: plan.accountId,
    proxyHash: proxyAddress,
    feePayer: payer,
    callFlags: plan.proxyCallFlags,
  });
  return {
    signer: signer({
      account: "0x" + proxy.signer.account,
      scopes: proxy.signer.scopes,
      rules: proxy.signer.rules,
    }),
    witness: {
      invocation: proxy.witness.invocationScript,
      verification: proxy.witness.verificationScript,
    },
  };
}

/** The SDK and browser must call this exact complete-signed-transaction response validator. */
export function validateNativeSignedPreflight(c, expected, result) {
  if (
    result?.hash !== expected.txid ||
    result?.network !== expected.networkMagic ||
    result?.verification !== "Succeed" ||
    result?.state !== "HALT" ||
    result.exception != null ||
    result?.relayed !== false ||
    result?.mempoolChecked !== false
  )
    fail("signed transaction preflight rejected or returned mismatched identity");
  if (!Number.isSafeInteger(result?.snapshot?.height))
    fail("preflight snapshot height must be a UInt32 number");
  c.unsigned(result.snapshot.height, 32, "preflight snapshot height");
  c.hex(result?.snapshot?.hash, 32);
  const simulation = result.simulation;
  if (
    simulation?.mode !== "single-transaction-next-block" ||
    simulation?.onPersist !== "HALT" ||
    simulation?.view !== 0 ||
    simulation?.transactionCount !== 1 ||
    !Number.isSafeInteger(simulation?.height) ||
    simulation.height !== result.snapshot.height + 1 ||
    simulation.height > 0xffffffff ||
    !Number.isSafeInteger(simulation?.primaryIndex) ||
    simulation.primaryIndex < 0 ||
    simulation.primaryIndex > 0xff ||
    typeof simulation?.timestamp !== "string" ||
    !/^(?:0|[1-9][0-9]{0,19})$/.test(simulation.timestamp) ||
    typeof simulation?.nextConsensus !== "string" ||
    !/^0x[0-9a-f]{40}$/.test(simulation.nextConsensus)
  )
    fail(
      "preflight simulation must declare successful single-transaction next-block preparation",
    );
  c.unsigned(simulation.timestamp, 64, "preflight simulation timestamp");
  if (
    expected.validUntilBlock !== undefined &&
    expected.validUntilBlock <= simulation.height
  )
    fail("signed transaction expires before the simulated block");
  const fees = parseNativeRpcFees(result, true);
  if (BigInt(fees.minimumRequiredFee) > BigInt(expected.systemFee))
    fail("final Application admission exceeds signed system fee");
  if (validateNativeInvocationResult(expected.plan, result.stack).length)
    fail("signed transaction preflight token transfer did not return Boolean true");
  return freeze(result);
}

/** Public, portable transport. Crypto and standard wallet witness validation are injected. */
export function createNativeTransactionArtifactTools({ codec: c, sha256, walletWitness } = {}) {
  if (!c || typeof sha256 !== "function")
    fail("artifact codec and SHA256 adapter required");
  const issued = new WeakMap(),
    submissions = new WeakMap();

  function bytes({ networkMagic, transaction: tx, witnesses: ws }) {
    const magic = uint32(networkMagic, "network magic"),
      parsed = transaction(tx),
      parsedWitnesses = witnesses(ws, parsed.signers.length),
      unsignedHex = unsigned(parsed),
      digest = hex(sha256(unsignedHex), 32);
    const rawTransaction =
      unsignedHex +
      vi(parsedWitnesses.length) +
      parsedWitnesses
        .map((w) => vb(w.invocation) + vb(w.verification))
        .join("");
    hex(rawTransaction);
    return {
      networkMagic: magic,
      transaction: parsed,
      witnesses: parsedWitnesses,
      unsignedHex,
      txid: "0x" + reverse(digest),
      signData: le(magic, 4) + digest,
      rawTransaction,
    };
  }

  function createArtifact(input) {
    const p = profile(input.profile),
      canonical = bytes({
        networkMagic: input.networkMagic,
        transaction: input.transaction,
        witnesses: input.witnesses,
      });
    if (p.networkMagic !== canonical.networkMagic)
      fail("artifact profile network mismatch");
    if (
      input.unsignedHex !== canonical.unsignedHex ||
      input.txid !== canonical.txid ||
      input.signData !== canonical.signData ||
      input.rawTransaction !== canonical.rawTransaction
    )
      fail("artifact transaction bytes, hash or signing data do not match canonical encoding");
    return freeze({
      format: "neo-native-signed-transaction",
      version: 1,
      networkMagic: canonical.networkMagic,
      profile: p,
      transaction: canonical.transaction,
      witnesses: canonical.witnesses,
      unsignedHex: canonical.unsignedHex,
      txid: canonical.txid,
      signData: canonical.signData,
      rawTransaction: canonical.rawTransaction,
    });
  }

  function checked(client, imported) {
    const record = issued.get(imported);
    if (!record || record.client !== client)
      fail("signed artifact must be imported by this transport and client");
    if (
      client.networkMagic !== imported.profile.networkMagic ||
      !same(profile(client.profile), imported.profile)
    )
      fail("current native profile changed");
    return record;
  }

  /**
   * A review is the reviewed intent: the v4 plan, the fee payer, the exact
   * signer list and the simulation that admitted it. Nothing here trusts a
   * review that was not signed; the artifact only binds to one.
   */
  function reviewedPlan(review) {
    const plan = review?.plan;
    if (!plan || !PLAN_KINDS.includes(plan.kind)) fail("review does not contain a supported SmartAccount plan");
    // A batch registration names its accounts as a list, so a single account id
    // is optional on registration plans; the script is not.
    const accountId =
      plan.accountId === undefined ? undefined : hex(plan.accountId, 20);
    const script = hex(plan.script, undefined, 65535);
    if (!script) fail("reviewed plan has no script");
    const payer = hash160(review.feePayer, "review fee payer");
    if (!Array.isArray(review.signers) || !review.signers.length)
      fail("review has no signers");
    const signers = review.signers.map(signer);
    if (signers.length > 16) fail("review has too many signers");
    if (new Set(signers.map((s) => s.account)).size !== signers.length)
      fail("review has duplicate signers");
    if (signers[0].account !== "0x" + payer)
      fail("review fee payer must be the first signer");
    const other = signers.slice(1).filter((s) => s.scopes === "WitnessRules");
    if (plan.kind !== "execution") {
      if (other.length) fail("only execution plans carry a proxy signer");
      return { plan: { kind: plan.kind, accountId, script }, payer, signers, proxy: null };
    }
    const accountAddress = hex(plan.accountAddress, 20);
    if (plan.proxyCallFlags !== 5)
      fail("review must carry the proxy call flags the core derives with");
    const proxy = proxyArtifacts(
      c,
      hex(review.profile?.contract, 20),
      { accountId, accountAddress, proxyCallFlags: plan.proxyCallFlags },
      payer,
    );
    if (other.length !== 1 || !same(signers[1], proxy.signer))
      fail("execution review must carry the canonical proxy signer at index 1");
    return {
      plan: { kind: plan.kind, accountId, script, accountAddress, proxyCallFlags: plan.proxyCallFlags },
      payer,
      signers,
      proxy,
    };
  }

  async function bindArtifact(client, review, text) {
    if (
      typeof text !== "string" ||
      !text.length ||
      text.length > NATIVE_SIGNED_ARTIFACT_MAX_CHARS
    )
      fail("signed artifact JSON exceeds input size limit");
    let input;
    try {
      input = JSON.parse(text);
    } catch {
      fail("signed artifact must be valid JSON");
    }
    exactKeys(
      input,
      [
        "format",
        "version",
        "networkMagic",
        "profile",
        "transaction",
        "witnesses",
        "unsignedHex",
        "txid",
        "signData",
        "rawTransaction",
      ],
      "artifact",
    );
    if (input.format !== "neo-native-signed-transaction" || input.version !== 1)
      fail("unsupported signed artifact version");
    if (!review || review.submission !== "native-sdk" || !review.plan)
      fail("signed import requires the current exact-script review");
    const artifact = createArtifact(input);
    if (
      artifact.networkMagic !== client.networkMagic ||
      !same(artifact.profile, profile(review.profile))
    )
      fail("artifact network or reviewed profile mismatch");
    const reviewed = reviewedPlan(review);
    if (artifact.transaction.script !== reviewed.plan.script)
      fail("artifact script does not match current review");
    if (!same(artifact.transaction.signers, reviewed.signers))
      fail("artifact signer order, scopes or accounts do not match current review");
    if (!walletWitness || typeof walletWitness.validate !== "function")
      fail("standard wallet signature validation is unavailable");
    for (const [index, descriptor] of artifact.transaction.signers.entries()) {
      const witness = artifact.witnesses[index];
      if (reviewed.proxy && index === 1) {
        if (
          descriptor.account !== reviewed.proxy.signer.account ||
          witness.invocation !== "" ||
          witness.verification !== reviewed.proxy.witness.verification
        )
          fail("noncanonical native proxy witness");
      } else if (
        !(await walletWitness.validate(
          witness,
          descriptor.account.slice(2),
          artifact.signData,
        ))
      )
        fail("invalid wallet transaction witness");
    }
    if (reviewed.proxy && artifact.transaction.signers[1]?.account !== reviewed.proxy.signer.account)
      fail("missing canonical native proxy signer");
    return artifact;
  }

  const feesOf = (artifact) => ({
    system: artifact.transaction.systemFee,
    network: artifact.transaction.networkFee,
    total: (
      BigInt(artifact.transaction.systemFee) + BigInt(artifact.transaction.networkFee)
    ).toString(),
  });

  async function importArtifact(client, review, text, caps) {
    const artifact = await bindArtifact(client, review, text),
      approved = {
        system: c.unsigned(caps?.maxSystemFee, 63, "system fee cap"),
        network: c.unsigned(caps?.maxNetworkFee, 63, "network fee cap"),
        total: c.unsigned(caps?.maxTotalFee, 63, "total fee cap"),
      };
    const system = fee(artifact.transaction.systemFee, "system fee"),
      network = fee(artifact.transaction.networkFee, "network fee");
    if (system > approved.system || network > approved.network || system + network > approved.total)
      fail("artifact fees exceed approved caps");
    const reviewedFees = parseNativeRpcFees({
      gasconsumed: review.simulation?.gasConsumed,
      minimumrequiredfee:
        review.simulation?.minimumRequiredFee === null
          ? undefined
          : review.simulation?.minimumRequiredFee,
    });
    if (system < BigInt(reviewedFees.minimumRequiredFee ?? reviewedFees.gasConsumed))
      fail("artifact system fee is below the reviewed admission requirement");
    await client.revalidatePlan(review.plan);
    if (!same(artifact.profile, profile(client.profile)))
      fail("current native profile changed");
    const height = uint32(await client.rpc.send("getblockcount", []), "block count");
    if (
      !height ||
      artifact.transaction.validUntilBlock <= height ||
      artifact.transaction.validUntilBlock > height + 100
    )
      fail("signed transaction must expire within the next 100 blocks");
    const imported = freeze({ ...artifact, review, fees: feesOf(artifact) });
    issued.set(imported, { client });
    return imported;
  }

  /**
   * A review archive carries the v4 recipe that rebuilt its plan. The rebuilt
   * plan must reproduce the archived script, account id and method byte for
   * byte; historical descriptions and unsigned claims are not authenticated.
   */
  function archivedReview(client, input) {
    let text;
    try {
      text = typeof input === "string" ? input : JSON.stringify(input);
    } catch {
      fail("archived review must be bounded JSON");
    }
    if (typeof text !== "string" || text.length > NATIVE_SIGNED_ARTIFACT_MAX_CHARS)
      fail("archived review exceeds input size limit");
    let archive;
    try {
      archive = JSON.parse(text);
    } catch {
      fail("archived review must be valid JSON");
    }
    if (
      archive?.format !== "neo-native-reviewed-request" ||
      archive.version !== 1 ||
      archive.submission !== "native-sdk"
    )
      fail("unsupported archived review format or signing path");
    const p = profile(archive.profile),
      prior = archive.plan,
      recipe = archive.recipe;
    if (!prior || !recipe || !recipe.input)
      fail("archived review requires a reconstructable recipe");
    const args = recipe.input;
    let plan;
    if (recipe.method === "buildCreateAccountScript" && prior.kind === "registration")
      plan = client.buildCreateAccountScript(args);
    else if (["buildConfigurationBatchPlan", "buildRecoveryPolicyPlan"].includes(recipe.method) && prior.kind === "account") {
      // Receipt restoration checks signed bytes after the configuration may already have changed.
      const accountId = hex(args.accountId, 20);
      const batch = recipe.method === "buildConfigurationBatchPlan";
      plan = { kind: "account", method: batch ? "applyConfigurationActions" : "setRecoveryPolicy", accountId,
        accountAddress: client.proxyAddress(accountId),
        script: batch ? client.buildConfigurationBatchScript(args) : client.buildRecoveryPolicyScript(args), signers: [] };
    } else if (recipe.method === "buildAccountActionScript" && prior.kind === "account") {
      if (!ACCOUNT_ACTIONS.includes(args.method))
        fail("unsupported archived account action");
      plan = client.buildAccountActionScript(args);
    } else if (recipe.method === "buildExecutionScript" && prior.kind === "execution")
      plan = client.buildExecutionScript(args);
    else fail("unsupported archived review recipe");
    if (
      (prior.accountId === undefined
        ? plan.accountId !== undefined
        : hex(prior.accountId, 20) !== plan.accountId) ||
      prior.script !== plan.script ||
      prior.method !== plan.method ||
      (prior.accountAddress !== undefined &&
        hex(prior.accountAddress, 20) !== plan.accountAddress) ||
      (plan.kind === "execution" &&
        (prior.batch !== plan.batch ||
          prior.proxyCallFlags !== plan.proxyCallFlags))
    )
      fail("archived recipe and plan do not reconstruct the signed script");
    client.prepare(plan);
    return freeze({
      format: archive.format,
      version: 1,
      profile: p,
      submission: "native-sdk",
      feePayer: hash160(archive.feePayer, "archived fee payer"),
      signers: archive.signers.map(signer),
      plan,
    });
  }

  async function restoreForReceipt(client, archive, text) {
    await client.discover();
    const review = archivedReview(client, archive),
      artifact = await bindArtifact(client, review, text);
    if (
      client.networkMagic !== artifact.networkMagic ||
      !same(artifact.profile, profile(client.profile))
    )
      fail("current native profile changed");
    const imported = freeze({
      ...artifact,
      review,
      fees: feesOf(artifact),
      receiptOnly: true,
      semanticsVerified: true,
    });
    issued.set(imported, { client, receiptOnly: true });
    return imported;
  }

  async function preflight(client, imported) {
    if (checked(client, imported).receiptOnly)
      fail("receipt-only restoration cannot authorize transaction preflight");
    await client.revalidatePlan(imported.review.plan);
    checked(client, imported);
    let result;
    try {
      result = await client.rpc.send("invoketransaction", [
        toBase64(imported.rawTransaction),
      ]);
    } catch (cause) {
      const error = new Error(
        `Native transaction: signed transaction preflight unavailable: ${cause?.message ?? cause}`,
        { cause },
      );
      if (cause && typeof cause === "object")
        for (const key of ["code", "data"])
          if (Object.hasOwn(cause, key)) error[key] = cause[key];
      throw error;
    }
    checked(client, imported);
    return validateNativeSignedPreflight(
      c,
      {
        txid: imported.txid,
        networkMagic: client.networkMagic,
        plan: imported.review.plan,
        systemFee: imported.transaction.systemFee,
        validUntilBlock: imported.transaction.validUntilBlock,
      },
      result,
    );
  }

  function broadcast(client, imported, { assertCurrent = () => {} } = {}) {
    try {
      if (checked(client, imported).receiptOnly)
        fail("receipt-only restoration cannot authorize broadcast");
      assertCurrent();
    } catch (error) {
      if (issued.has(imported)) error.txid = imported.txid;
      error.submissionAttempted = false;
      return Promise.reject(error);
    }
    let byId = submissions.get(client);
    if (!byId) {
      byId = new Map();
      submissions.set(client, byId);
    }
    const key = imported.txid + ":" + imported.rawTransaction;
    if (byId.has(key)) return byId.get(key);
    let submissionAttempted = false;
    const promise = (async () => {
      await preflight(client, imported);
      checked(client, imported);
      assertCurrent();
      submissionAttempted = true;
      const result = await client.rpc.send("sendrawtransaction", [
        toBase64(imported.rawTransaction),
      ]);
      if (result?.hash && String(result.hash).toLowerCase() !== imported.txid)
        fail("RPC returned a different transaction id");
      if (result !== true && !result?.hash)
        fail("RPC did not confirm transaction submission");
      return { txid: imported.txid, submitted: true, confirmed: false };
    })().catch((error) => {
      error.txid = imported.txid;
      error.submissionAttempted = submissionAttempted;
      if (!submissionAttempted) byId.delete(key);
      throw error;
    });
    byId.set(key, promise);
    return promise;
  }

  async function receipt(client, imported) {
    checked(client, imported);
    await client.discover();
    checked(client, imported);
    const tx = await client.rpc.send("getrawtransaction", [imported.txid, true]);
    if (!tx?.blockhash) return { txid: imported.txid, confirmed: false };
    if (String(tx.hash).toLowerCase() !== imported.txid)
      fail("persisted transaction identity mismatch");
    if (/^0+$/.test(c.hex(tx.blockhash, 32)))
      fail("persisted transaction has a zero block hash");
    if (
      tx.confirmations !== undefined &&
      (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 1)
    )
      fail("persisted transaction has invalid confirmations");
    const [wire, log] = await Promise.all([
      client.rpc.send("getrawtransaction", [imported.txid, false]),
      client.rpc.send("getapplicationlog", [imported.txid]),
    ]);
    checked(client, imported);
    if (fromBase64(wire) !== imported.rawTransaction)
      fail("persisted transaction bytes differ from signed transaction");
    if (String(log?.txid).toLowerCase() !== imported.txid)
      fail("application log transaction identity mismatch");
    const executions = log.executions?.filter((x) => x.trigger === "Application");
    if (!executions || executions.length !== 1)
      fail("confirmed transaction must have one Application execution");
    const execution = executions[0],
      failures = [];
    try {
      for (const index of validateNativeApplicationExecution(imported.review.plan, execution))
        failures.push(`Token transfer ${index + 1} did not return Boolean true`);
    } catch (error) {
      failures.push(error.message);
    }
    return freeze({
      txid: imported.txid,
      confirmed: true,
      succeeded: failures.length === 0,
      failures,
      blockHash: tx.blockhash,
      vmState: execution.vmstate,
      exception: execution.exception ?? null,
      stack: execution.stack ?? [],
      notifications: execution.notifications ?? [],
      gasConsumed: execution.gasconsumed ?? null,
      systemFee: imported.transaction.systemFee,
      networkFee: imported.transaction.networkFee,
    });
  }

  return Object.freeze({
    bytes,
    createArtifact,
    importArtifact,
    restoreForReceipt,
    preflight,
    broadcast,
    receipt,
  });
}
