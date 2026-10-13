import { sha256, ripemd160 } from "ethers";
import {
  createNativeCodec,
  NATIVE_ACCOUNT_SERVICE,
} from "../../shared/nativeSmartAccount.mjs";
import {
  createNativeClientClass,
  NATIVE_PROFILE_PARAMETER_DIGEST,
} from "../../shared/nativeSmartAccountClient.mjs";
import {
  getScriptHashFromAddress,
  getAddressFromScriptHash,
} from "../../utils/neo.js";

export { NATIVE_ACCOUNT_SERVICE, NATIVE_PROFILE_PARAMETER_DIGEST };
export const ZERO_HASH = "00".repeat(20);
export const nativeCodec = createNativeCodec({
  sha256: (hex) => sha256("0x" + hex).slice(2),
  hash160: (hex) => ripemd160(sha256("0x" + hex)).slice(2),
});
const Client = createNativeClientClass(nativeCodec);
async function browserTransactionTools() {
  const [{ createNativeTransactionArtifactTools }, { createNativeWalletWitnessTools }] = await Promise.all([
    import("../../shared/nativeTransactionArtifact.mjs"),
    import("../../shared/nativeWalletWitness.mjs"),
  ]);
  return createNativeTransactionArtifactTools({
    codec: nativeCodec,
    sha256: (hex) => sha256("0x" + hex).slice(2),
    walletWitness: createNativeWalletWitnessTools({
      hash160: (hex) => ripemd160(sha256("0x" + hex)).slice(2).match(/../g).reverse().join(""),
    }),
  });
}
const fail = (message) => {
  throw new Error(message);
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
export const jsonText = (value) =>
  JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
export function nativeGasLimit(value) {
  const text = String(value).trim();
  if (text.length > 32 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(text))
    fail("Enter an explicit GAS fee limit with at most 8 decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0"));
  if (amount > 9223372036854775807n) fail("The fee limit is too large.");
  return amount.toString();
}
export function nativeAddress(value, { zero = false } = {}) {
  const raw = String(value ?? "").trim();
  const address = nativeCodec.hex(
    raw.startsWith("N") ? getScriptHashFromAddress(raw) : raw,
    20,
  );
  if (!zero && (address === ZERO_HASH || address === NATIVE_ACCOUNT_SERVICE))
    fail("A nonzero Neo authority or contract is required.");
  if (raw.startsWith("N") && getAddressFromScriptHash(address) !== raw)
    fail("Use a Neo N3 address.");
  return address;
}
export function createNativeRpc(
  endpoint,
  { fetchImpl = globalThis.fetch, timeoutMs = 12_000 } = {},
) {
  const url = new URL(endpoint);
  if (!["https:", "http:"].includes(url.protocol))
    fail("RPC must use HTTP or HTTPS.");
  if (url.username || url.password || url.search || url.hash)
    fail("RPC credentials, query strings and fragments are not accepted.");
  let next = 0;
  return {
    async send(method, params = []) {
      const id = ++next,
        controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url.href, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal,
          credentials: "omit",
          redirect: "error",
        });
        if (!response.ok)
          fail(`RPC ${method} failed (HTTP ${response.status}).`);
        const payload = await response.json();
        if (
          payload.id !== id ||
          payload.error ||
          !Object.hasOwn(payload, "result")
        )
          fail(`RPC ${method} is unavailable or returned an invalid response.`);
        return payload.result;
      } catch (error) {
        if (error.name === "AbortError") fail(`RPC ${method} timed out.`);
        if (error.message?.startsWith("RPC ")) throw error;
        fail(
          `RPC ${method} could not be reached. Check the endpoint and browser CORS policy.`,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
export function nativeWalletNetwork(result) {
  const selected =
    typeof result === "object" && result
      ? (result.magic ??
        result.networkMagic ??
        result.network ??
        result.defaultNetwork)
      : result;
  if (
    typeof selected === "number" &&
    Number.isSafeInteger(selected) &&
    selected >= 0 &&
    selected <= 0xffffffff
  )
    return selected;
  if (typeof selected === "string") {
    if (/^(?:0|[1-9][0-9]*)$/.test(selected) && Number(selected) <= 0xffffffff)
      return Number(selected);
    if (selected.toLowerCase() === "mainnet") return 860833102;
    if (selected.toLowerCase() === "testnet") return 894710606;
  }
  fail(
    "Wallet does not expose a verifiable active network. Export the reviewed request instead.",
  );
}
/** Select the same concrete provider used by walletService.invoke, then read its live identity. */
export function createNativeWalletAdapter(
  service,
  windowObject = globalThis.window,
) {
  function resolve() {
    const selected = service.getInvokeProvider();
    if (!selected) fail("Connect a Neo wallet with invoke support.");
    const nep = service.findNep21ProviderCandidate();
    const providers = [
      ...(nep ? [{ name: nep.name || "NEP-21", api: nep.api }] : []),
      { name: "neo3Dapi", api: windowObject?.neo3Dapi },
      ...service.getNeoLineProviderCandidates(),
      { name: "aaWallet", api: windowObject?.aaWallet },
    ];
    const candidate = providers.find(
      (p) => p.name === selected.name && typeof p.api?.invoke === "function",
    );
    if (!candidate)
      fail("The selected wallet cannot be checked safely. Export the request.");
    return candidate.api;
  }
  let checkedProvider = null;
  return {
    async account() {
      const provider = resolve();
      checkedProvider = provider;
      const accounts =
        typeof provider.getAccounts === "function"
          ? await provider.getAccounts()
          : [await provider.getAccount?.()];
      const a = accounts?.find((a) => a.isDefault) || accounts?.[0];
      return nativeAddress(
        a?.hash || a?.scriptHash || a?.address || a?.account?.address,
      );
    },
    async network() {
      const provider = resolve();
      if (checkedProvider !== provider)
        fail("Wallet provider changed. Review again.");
      return nativeWalletNetwork(
        typeof provider.getNetwork === "function"
          ? await provider.getNetwork()
          : await provider.getNetworks?.(),
      );
    },
    async invoke(request) {
      if (resolve() !== checkedProvider)
        fail("Wallet provider changed. Review again.");
      return service.invoke(request);
    },
  };
}
export function buildRecoveryDescriptor(input) {
  const custody = nativeAddress(input.custodyAddress),
    salt = nativeCodec.hex(input.salt, 32);
  const networkMagic = Number(
    nativeCodec.unsigned(input.networkMagic, 32, "network magic"),
  );
  const identity = nativeCodec.deriveIdentity({
    networkMagic,
    custodyAddress: custody,
    salt,
  });
  if (
    input.accountId &&
    nativeCodec.hex(input.accountId, 20) !== identity.accountId
  )
    fail("Descriptor identity mismatch.");
  if (
    input.accountAddress &&
    nativeCodec.hex(input.accountAddress, 20) !== identity.accountAddress
  )
    fail("Descriptor funding address mismatch.");
  if (input.profileParameterDigest !== NATIVE_PROFILE_PARAMETER_DIGEST)
    fail("Descriptor profile mismatch.");
  return freeze({
    format: "neo-native-account-descriptor",
    version: 1,
    abiVersion: 2,
    networkMagic,
    profileParameterDigest: NATIVE_PROFILE_PARAMETER_DIGEST,
    service: NATIVE_ACCOUNT_SERVICE,
    ...identity,
    custodyAddress: custody,
    salt,
  });
}
export function readRecoveryDescriptor(text, profile) {
  if (typeof text !== "string" || text.length > 16_384)
    fail("Descriptor must be a JSON file smaller than 16 KiB.");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("Invalid recovery descriptor JSON.");
  }
  if (
    value?.format !== "neo-native-account-descriptor" ||
    value.version !== 1 ||
    value.abiVersion !== 2 ||
    value.service !== NATIVE_ACCOUNT_SERVICE
  )
    fail("Unsupported native recovery descriptor.");
  if (
    profile &&
    (value.networkMagic !== profile.networkMagic ||
      value.profileParameterDigest !== profile.profileParameterDigest)
  )
    fail("Descriptor network or profile mismatch.");
  return buildRecoveryDescriptor(value);
}
// SMARTACCOUNT_NATIVE MultiSigVerifier.cs: MaxChildVerifiers / MaxApprovedChildren.
export const NATIVE_MULTISIG_LIMITS = freeze({ maxChildren: 3, maxThreshold: 2 });
export function buildMultiSigArguments(
  { children, threshold },
  invalidMessage = "Use 1–3 unique modules and a reachable threshold of 1–2.",
) {
  if (typeof children !== "string") fail(invalidMessage);
  const ordered = children.split(/\s+/).filter(Boolean).map((hash) => nativeAddress(hash));
  const required = Number(threshold);
  if (
    ordered.length < 1 ||
    ordered.length > NATIVE_MULTISIG_LIMITS.maxChildren ||
    new Set(ordered).size !== ordered.length ||
    !Number.isInteger(required) ||
    required < 1 ||
    required > NATIVE_MULTISIG_LIMITS.maxThreshold ||
    required > ordered.length
  ) fail(invalidMessage);
  return [
    { type: "Array", value: ordered.map(nativeCodec.hashValue) },
    { type: "Integer", value: String(required) },
  ];
}
export function buildSessionArguments(
  {
    publicKey,
    target,
    expiresAt,
    spendingLimit,
    description = "Restricted transfer session",
  },
  now = Date.now(),
) {
  const key = nativeCodec.hex(publicKey, 33);
  if (!/^(02|03)/.test(key)) fail("Use a compressed P-256 session public key.");
  const expiry = nativeCodec.unsigned(expiresAt, 64, "expiry");
  if (expiry <= BigInt(now) || expiry > BigInt(now) + 7n * 86400000n)
    fail("Session expiry must be in the next 7 days, in milliseconds.");
  const limit = nativeCodec.unsigned(spendingLimit, 255, "spending cap");
  if (limit === 0n)
    fail(
      "Set a positive spending cap in token base units. Zero means unlimited on chain.",
    );
  if (new TextEncoder().encode(description).length > 128)
    fail("Use a description of at most 128 UTF-8 bytes.");
  return [
    { type: "ByteString", value: key },
    nativeCodec.hashValue(nativeAddress(target)),
    nativeCodec.stringValue("transfer"),
    { type: "Integer", value: expiry.toString() },
    { type: "Integer", value: limit.toString() },
    nativeCodec.stringValue(description),
  ];
}
export const NATIVE_ACTIONS = freeze([
  {
    value: "freeze",
    label: "Freeze spending",
    detail:
      "Recovery authority freezes immediately and clears pending changes. Unfreezing needs custody and recovery cooperation.",
  },
  {
    value: "proposeRecovery",
    label: "Start custody recovery",
    address: true,
    detail:
      "Recovery authority proposes a new custody wallet. Wait 7 days, then execute a separate transaction.",
  },
  {
    value: "executeRecovery",
    label: "Complete custody recovery",
    detail:
      "After 7 days, anyone can execute. Old modules are detached, authority epoch advances, funding address and frozen status stay unchanged.",
  },
  {
    value: "cancelRecovery",
    label: "Cancel custody recovery",
    detail:
      "Recovery authority may cancel; custody may cancel only before maturity.",
  },
  {
    value: "unfreeze",
    label: "Unfreeze spending",
    detail:
      "Requires both custody and recovery witnesses. Export for a wallet that supports both authorities.",
  },
  ...["Verifier", "Hook", "RecoveryAddress"].flatMap((name) => [
    {
      value: "propose" + name,
      label:
        "Propose " +
        name.replace("RecoveryAddress", "recovery authority").toLowerCase(),
      address: true,
      detail:
        "Custody-authorized change. Wait 24 hours, then activate separately. Replacing a proposal restarts the delay.",
    },
    {
      value: "activate" + name,
      label:
        "Activate " +
        name.replace("RecoveryAddress", "recovery authority").toLowerCase(),
      detail:
        name === "RecoveryAddress"
          ? "After 24 hours, anyone can activate the mature recovery-authority proposal and pay its fees. No custody signature is required."
          : "After 24 hours, anyone can activate the mature proposal and pay its fees. No custody signature is required. Old module cleanup may still fail; custody recovery is the callback-independent exit.",
    },
    {
      value: "cancel" + name,
      label:
        "Cancel " +
        name.replace("RecoveryAddress", "recovery authority").toLowerCase(),
      detail: "Cancels the pending change.",
    },
  ]),
]);
export function actionBlockReason(state, action, now) {
  if (!state) return "Load an account first.";
  const recovery = state.recoveryAddress !== ZERO_HASH;
  if (["freeze", "proposeRecovery"].includes(action) && !recovery)
    return "This account has no recovery authority.";
  if (action === "freeze" && state.status === "Frozen")
    return "The account is already frozen.";
  if (action === "unfreeze" && state.status !== "Frozen")
    return "The account is not frozen.";
  if (
    action === "executeRecovery" &&
    (!state.pendingRecovery ||
      BigInt(state.pendingRecovery.matureAt) > BigInt(now))
  )
    return "Custody recovery has not matured.";
  if (action === "cancelRecovery" && !state.pendingRecovery)
    return "No custody recovery is pending.";
  if (
    /^(?:propose|activate|cancel)(?:Verifier|Hook|RecoveryAddress)$/.test(
      action,
    )
  ) {
    if (
      !action.startsWith("cancel") &&
      (state.status === "Frozen" || state.pendingRecovery)
    )
      return "Configuration is blocked while frozen or custody recovery is pending.";
    const suffix = action.replace(/^(propose|activate|cancel)/, "");
    const pending = state["pending" + suffix];
    if (
      action.startsWith("activate") &&
      (!pending || BigInt(pending.matureAt) > BigInt(now))
    )
      return "The configuration proposal has not matured.";
    if (action.startsWith("cancel") && !pending)
      return "No matching configuration proposal is pending.";
  }
  return "";
}
function H(value) {
  return { type: "Hash160", value: "0x" + nativeCodec.hex(value, 20) };
}
function displayError(simulation) {
  return simulation.state === "HALT" && !simulation.failedTransfers?.length
    ? ""
    : "Simulation failed or a token transfer returned false. The request cannot be sent.";
}

// Exported review files are instructions to reconstruct, never authority to sign.
function comparable(value) {
  return JSON.stringify(value, (_, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .filter((key) => item[key] !== undefined)
          .map((key) => [key, item[key]]),
      );
    }
    return item;
  });
}
async function chainTime(client) {
  const count = await client.rpc.send("getblockcount", []);
  if (!Number.isSafeInteger(count) || count < 1) fail("Invalid block height.");
  const block = await client.rpc.send("getblockheader", [count - 1, true]);
  if (!Number.isSafeInteger(block?.time) || block.time < 0)
    fail("Invalid chain timestamp.");
  return block.time;
}
function cancellationAuthorityFor(plan, value, now) {
  const authority = nativeAddress(value);
  const state = plan.accountState;
  if (!state?.pendingRecovery) fail("No custody recovery is pending.");
  if (
    authority !== state.recoveryAddress &&
    (authority !== state.custodyAddress ||
      BigInt(now) >= BigInt(state.pendingRecovery.matureAt))
  )
    fail("Only recovery, or custody before maturity, can cancel recovery.");
  return authority;
}
function reviewAuthorities(plan, cancellationAuthority) {
  return [...new Set([
    ...plan.requiredAuthorities,
    ...(plan.authorityPolicy === "recovery-or-custody-before-maturity"
      ? [nativeAddress(cancellationAuthority)] : []),
  ])];
}
function sdkReviewSigners(plan, actor, authorities) {
  if (actor === (plan.accountAddress || plan.accountState?.accountAddress))
    fail("The fee payer must be a separate Neo wallet, not the account proxy.");
  const required = new Set(authorities);
  const signer = (account) => ({
    account: "0x" + account,
    scopes: required.has(account) ? "CustomContracts" : "None",
    ...(required.has(account)
      ? { allowedcontracts: ["0x" + NATIVE_ACCOUNT_SERVICE] } : {}),
  });
  return [signer(actor), ...(plan.proxySigner ? [plan.proxySigner] : []),
    ...authorities.filter((account) => account !== actor).map(signer)];
}
async function checkCancellationTime(client, review) {
  if (review.plan.authorityPolicy === "recovery-or-custody-before-maturity")
    cancellationAuthorityFor(review.plan, review.cancellationAuthority, await chainTime(client));
}
async function revalidateReview(client, review) {
  await client.revalidatePlan(review.plan);
  await checkCancellationTime(client, review);
}
export async function rebuildNativeReview(client, exported) {
  if (
    exported?.format !== "neo-native-reviewed-request" ||
    exported.version !== 1
  )
    fail("Unsupported native review format.");
  if (exported.submission !== "native-sdk")
    fail(
      "This is a wallet invocation review. Choose Native SDK and review again before using the SDK builder.",
    );
  const profile = await client.discover();
  if (comparable(profile) !== comparable(exported.profile))
    fail("Review network or native profile mismatch.");
  const recipe = exported.recipe;
  let plan;
  if (recipe?.method === "prepareOperation") {
    let prepared = await client.prepareOperation(recipe.input);
    prepared = client.attachSignature(prepared, recipe.signature);
    plan = client.buildExecution([prepared]);
  } else if (
    ["buildRegistration", "buildAction", "buildModuleCall"].includes(
      recipe?.method,
    )
  ) {
    plan = await client[recipe.method](recipe.input);
  } else fail("Unsupported review recipe.");
  // Script equality alone cannot identify a mutable lifecycle intent. For example,
  // executeRecovery has the same script after the pending new custody changes.
  // Compare every public plan field: account state, intent/phase, epoch/config,
  // operation context/digest/proof, signer roles and exact script.
  if (comparable(plan) !== comparable(exported.plan))
    fail(
      "Reviewed authority, pending intent or operation changed. Review again.",
    );
  const payer = nativeAddress(exported.feePayer);
  // Version-one exports originally represented cancellation by the payer's
  // authority alone. Accept only that shape, then recheck its complete roster.
  const legacyCancellation = !Object.hasOwn(exported, "cancellationAuthority") &&
    plan.kind === "lifecycle" && plan.method === "cancelRecovery" &&
    plan.authorityPolicy === "recovery-or-custody-before-maturity" &&
    recipe.method === "buildAction" && recipe.input?.action === "cancelRecovery" &&
    !Object.hasOwn(recipe.input, "cancellationAuthority");
  const cancellationAuthority = legacyCancellation ? payer : exported.cancellationAuthority;
  const authorities = reviewAuthorities(plan, cancellationAuthority);
  if (comparable(authorities) !== comparable(exported.requiredAuthorities) ||
      comparable(sdkReviewSigners(plan, payer, authorities)) !== comparable(exported.signers))
    fail("Reviewed cancellation authority, fee payer or signer scopes changed. Review again.");
  await revalidateReview(client, { ...exported, cancellationAuthority, plan });
  return plan;
}
export function validateNativeReceipt(review, transaction, log, txid) {
  const hash = nativeCodec.hex(txid, 32);
  if (nativeCodec.hex(transaction?.hash, 32) !== hash)
    fail("Transaction identity mismatch.");
  if (
    !transaction.blockhash ||
    /^0+$/.test(nativeCodec.hex(transaction.blockhash, 32)) ||
    (transaction.confirmations !== undefined &&
      (!Number.isSafeInteger(transaction.confirmations) ||
        transaction.confirmations < 1))
  )
    fail("Transaction is not confirmed in a mined block.");
  const normalizeSigner = (signer) => {
    if (
      !signer ||
      typeof signer !== "object" ||
      signer.rules?.length ||
      signer.allowedgroups?.length ||
      signer.allowedGroups?.length
    )
      fail("Transaction signer scope mismatch.");
    const scope =
      { 0: "None", 1: "CalledByEntry", 16: "CustomContracts" }[signer.scopes] ||
      signer.scopes;
    if (!["None", "CalledByEntry", "CustomContracts"].includes(scope))
      fail("Transaction signer scope mismatch.");
    const contracts = signer.allowedcontracts ?? signer.allowedContracts ?? [];
    if (!Array.isArray(contracts)) fail("Transaction signer scope mismatch.");
    return {
      account: nativeCodec.hex(signer.account, 20),
      scopes: scope,
      allowedcontracts: contracts
        .map((contract) => nativeCodec.hex(contract, 20))
        .sort(),
    };
  };
  if (
    !Array.isArray(transaction.signers) ||
    !Array.isArray(review.signers) ||
    comparable(transaction.signers.map(normalizeSigner)) !==
      comparable(review.signers.map(normalizeSigner)) ||
    nativeCodec.hex(transaction.signers[0]?.account, 20) !==
      nativeCodec.hex(review.feePayer, 20)
  )
    fail("Transaction fee payer or signer scopes differ from this review.");
  const bytes = nativeCodec.bytes(review.plan.script);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (transaction.script !== btoa(binary))
    fail("Transaction script does not match this review.");
  if (nativeCodec.hex(log?.txid, 32) !== hash)
    fail("Application log transaction identity mismatch.");
  const applications = Array.isArray(log.executions)
    ? log.executions.filter((item) => item.trigger === "Application")
    : [];
  if (applications.length !== 1 || applications[0].vmstate !== "HALT")
    fail("Transaction has no successful Application result.");
  if (review.plan.kind === "execution") {
    const stack = applications[0].stack;
    const values = review.plan.batch
      ? stack?.[0]?.type === "Array"
        ? stack[0].value
        : []
      : [stack?.[0]];
    for (const [index, prepared] of review.plan.preparedOperations.entries())
      if (
        prepared.operation.method === "transfer" &&
        (values?.[index]?.type !== "Boolean" || values[index].value !== true)
      )
        fail("Token transfer result is false or could not be verified.");
  }
  return { txid: "0x" + hash, state: "HALT" };
}

export function createNativeWorkspace({
  makeClient = ({ rpcUrl, networkMagic }) =>
    new Client({ rpcClient: createNativeRpc(rpcUrl), networkMagic }),
  wallet,
  transactionTools,
} = {}) {
  let generation = 0,
    intentVersion = 0,
    client = null,
    profile = null,
    active = null,
    submitting = false,
    imported = null,
    importVersion = 0,
    archived = null,
    archiveVersion = 0;
  const reviews = new WeakMap();
  const imports = new WeakMap();
  const archives = new WeakMap();
  let toolsPromise;
  const exactTools = () => toolsPromise ||= Promise.resolve(transactionTools || browserTransactionTools());
  function clearImported() {
    imported = null;
    importVersion++;
  }
  function clearArchived() {
    archived = null;
    archiveVersion++;
  }
  function guard(version) {
    if (version !== generation || !client || !profile)
      fail(
        "Stale review or unavailable discovery. Verify the node and review again.",
      );
  }
  function begin() {
    if (!client || !profile)
      fail("Complete native discovery before creating a review.");
    active = null;
    clearImported();
    return { version: generation, c: client, intent: ++intentVersion };
  }
  async function clock(c) {
    return chainTime(c);
  }
  async function reviewPlan({
    version,
    c,
    intent,
    plan,
    args,
    actor,
    cancellationAuthority,
    description,
    recipe,
    submission: requestedSubmission,
  }) {
    if (intent !== intentVersion) fail("Review inputs changed. Preview again.");
    guard(version);
    actor = nativeAddress(actor);
    if (actor === (plan.accountAddress || plan.accountState?.accountAddress))
      fail(
        "The fee payer must be a separate Neo wallet, not the account proxy.",
      );
    const authorities = reviewAuthorities(plan, cancellationAuthority);
    const walletSupported =
      requestedSubmission !== "native-sdk" &&
      !plan.requiresExactScript &&
      !!args &&
      authorities.length <= 1 &&
      (!authorities.length || authorities[0] === actor);
    const submission = walletSupported ? "wallet-invoke" : "native-sdk";
    const signers = walletSupported
      ? [{ account: "0x" + actor, scopes: "CalledByEntry" }]
      : sdkReviewSigners(plan, actor, authorities);
    const simulation = await c.simulate(plan, signers);
    await checkCancellationTime(c, { plan, cancellationAuthority });
    guard(version);
    if (intent !== intentVersion) fail("Review inputs changed. Preview again.");
    const review = freeze({
      profile,
      plan,
      description,
      recipe,
      submission,
      feePayer: actor,
      ...(cancellationAuthority ? { cancellationAuthority } : {}),
      requiredAuthorities: authorities,
      signers,
      simulation,
      simulationError: displayError(simulation),
      walletSupported,
      request: walletSupported
        ? {
            scriptHash: "0x" + NATIVE_ACCOUNT_SERVICE,
            operation: plan.method,
            args,
            signers,
          }
        : null,
      createdAt: Date.now(),
    });
    reviews.set(review, { version, c, used: false });
    active = review;
    return review;
  }
  return {
    get profile() {
      return profile;
    },
    get client() {
      return client;
    },
    get review() {
      return active;
    },
    clearReview() {
      intentVersion++;
      active = null;
      clearImported();
    },
    clearImported,
    clearArchived,
    invalidate() {
      generation++;
      client = null;
      profile = null;
      active = null;
      clearImported();
      clearArchived();
    },
    async connect(options) {
      const version = ++generation;
      client = null;
      profile = null;
      active = null;
      clearImported();
      clearArchived();
      const candidate = makeClient(options);
      const discover = candidate.discover.bind(candidate);
      candidate.discover = async () => {
        try {
          return await discover();
        } catch (error) {
          if (client === candidate && version === generation) {
            generation++;
            client = null;
            profile = null;
            active = null;
          }
          throw error;
        }
      };
      const found = await candidate.discover();
      if (version !== generation) fail("Stale discovery result.");
      client = candidate;
      profile = found;
      return found;
    },
    async load(accountId, channel = "0") {
      const { version, c, intent } = begin();
      const id = nativeAddress(accountId);
      await c.discover();
      const [account, nonce, chainTime] = await Promise.all([
        c.getAccount(id),
        c.getNonce(id, channel),
        clock(c),
      ]);
      guard(version);
      if (intent !== intentVersion) fail("Account input changed. Load again.");
      if (!account) fail("This native account is not registered.");
      return {
        account,
        nonce: nonce.toString(),
        chainTime,
        channel: String(channel),
      };
    },
    async registration(input) {
      const { version, c, intent } = begin();
      const normalized = {
        custodyAddress: nativeAddress(input.custodyAddress),
        salt: nativeCodec.hex(input.salt, 32),
        recoveryAddress: input.recoveryAddress
          ? nativeAddress(input.recoveryAddress)
          : ZERO_HASH,
        verifier: ZERO_HASH,
        hook: ZERO_HASH,
      };
      if (
        normalized.recoveryAddress === ZERO_HASH &&
        input.allowNoRecovery !== true
      )
        fail(
          "Acknowledge that losing custody without a recovery authority is permanent.",
        );
      const plan = c.buildRegistration(normalized);
      const args = [
        H(normalized.custodyAddress),
        { type: "ByteArray", value: normalized.salt },
        H(ZERO_HASH),
        H(ZERO_HASH),
        H(normalized.recoveryAddress),
      ];
      const result = await reviewPlan({
        version,
        c,
        intent,
        plan,
        args,
        recipe: { method: "buildRegistration", input: normalized },
        submission: input.submission,
        actor: input.feePayer || normalized.custodyAddress,
        description:
          "Register with custody witness fallback; no verifier or hook is installed.",
      });
      return result;
    },
    async lifecycle(input) {
      const { version, c, intent } = begin();
      const accountId = nativeAddress(input.accountId);
      const plan = await c.buildAction({
        ...input,
        accountId,
        address: input.address
          ? nativeAddress(input.address, {
              zero: [
                "proposeVerifier",
                "proposeHook",
                "proposeRecoveryAddress",
              ].includes(input.action),
            })
          : undefined,
      });
      const now = await clock(c);
      if (
        input.action === "cancelModuleCall" &&
        input.expectedPending !== undefined &&
        comparable(plan.pending) !== comparable(input.expectedPending)
      )
        fail("The pending policy changed. Refresh it before reviewing cancellation.");
      const block = actionBlockReason(plan.accountState, input.action, now);
      if (block) fail(block);
      let actor =
        input.feePayer ||
        plan.requiredAuthorities[0] ||
        plan.accountState.custodyAddress;
      actor = nativeAddress(actor);
      const cancellationAuthority = input.action === "cancelRecovery"
        ? cancellationAuthorityFor(plan, input.cancellationAuthority || actor, now)
        : undefined;
      const args = [
        H(accountId),
        ...(input.action === "cancelModuleCall"
          ? [{ type: "String", value: plan.role }]
          : []),
        ...(input.action.startsWith("propose")
          ? [H(nativeAddress(input.address, { zero: true }))]
          : []),
      ];
      return reviewPlan({
        version,
        c,
        intent,
        plan,
        args,
        recipe: {
          method: "buildAction",
          input: {
            accountId,
            action: input.action,
            ...(input.address
              ? { address: nativeAddress(input.address, { zero: true }) }
              : {}),
            ...(input.role ? { role: input.role } : {}),
          },
        },
        actor,
        cancellationAuthority,
        submission: input.submission,
        description:
          input.action === "cancelModuleCall"
            ? `Cancel the reviewed ${plan.role} policy call. The exact script checks that this pending intent is unchanged before cancelling it; active permissions remain unchanged.`
            : NATIVE_ACTIONS.find((a) => a.value === input.action)?.detail ||
              input.action,
      });
    },
    async inspectPolicy({ accountId, role = "verifier" }) {
      const { version, c, intent } = begin();
      const id = nativeAddress(accountId);
      if (!["verifier", "hook"].includes(role))
        fail("Select the verifier or hook policy role.");
      await c.discover();
      const [pending, chainTime] = await Promise.all([
        c.getPendingModuleCall(id, role),
        clock(c),
      ]);
      guard(version);
      if (intent !== intentVersion)
        fail("Policy inputs changed. Refresh the pending policy again.");
      return freeze({ accountId: id, role, pending, chainTime });
    },
    async policy(input) {
      const { version, c, intent } = begin();
      const plan = await c.buildModuleCall(input);
      if (input.method === "setSessionKey") {
        const now = await clock(c);
        const exactPending =
          plan.pending?.method === input.method &&
          JSON.stringify(plan.pending.invokedArguments) ===
            JSON.stringify({
              type: "Array",
              value: [nativeCodec.hashValue(input.accountId), ...input.args],
            });
        if (
          !exactPending &&
          BigInt(input.args[3].value) <= BigInt(now) + 86400000n
        )
          fail("A new session must expire after its 24-hour activation delay.");
      }
      return reviewPlan({
        version,
        c,
        intent,
        plan,
        recipe: {
          method: "buildModuleCall",
          input: {
            accountId: input.accountId,
            role: input.role,
            ...(input.child ? { child: input.child } : {}),
            method: input.method,
            args: input.args,
          },
        },
        actor: input.feePayer || plan.requiredAuthorities[0],
        description:
          "Delayed module policy call: first call proposes; repeat the exact call after 24 hours to activate. Export preserves all typed arguments.",
      });
    },
    async activatePolicy({ accountId, role = "verifier", feePayer }) {
      const { version, c, intent } = begin();
      const pending = await c.getPendingModuleCall(accountId, role);
      if (!pending) fail("No module policy call is pending.");
      if (BigInt(pending.matureAt) > BigInt(await clock(c)))
        fail("The pending policy has not reached its 24-hour activation time.");
      const args = pending.invokedArguments;
      if (
        args?.type !== "Array" ||
        JSON.stringify(args.value[0]) !==
          JSON.stringify(nativeCodec.hashValue(accountId))
      )
        fail("Pending policy account mismatch.");
      const plan = await c.buildModuleCall({
        accountId,
        role,
        child:
          pending.selected.contract === pending.root.contract
            ? undefined
            : pending.selected.contract,
        method: pending.method,
        args: args.value.slice(1),
      });
      return reviewPlan({
        version,
        c,
        intent,
        plan,
        recipe: {
          method: "buildModuleCall",
          input: {
            accountId,
            role,
            ...(pending.selected.contract !== pending.root.contract
              ? { child: pending.selected.contract }
              : {}),
            method: pending.method,
            args: args.value.slice(1),
          },
        },
        actor: feePayer || plan.requiredAuthorities[0],
        description:
          "Activate the exact mature pending policy. Any changed configuration invalidates this review.",
      });
    },
    async operation(input) {
      const { version, c, intent } = begin();
      const now = await clock(c);
      const deadline = nativeCodec.unsigned(input.deadline, 255, "deadline");
      if (deadline <= BigInt(now) || deadline > BigInt(now) + 3600000n)
        fail("Use a deadline within one hour of the current chain time.");
      let prepared = await c.prepareOperation(input);
      if (input.signature)
        prepared = c.attachSignature(prepared, input.signature);
      const plan = c.buildExecution([prepared]);
      return reviewPlan({
        version,
        c,
        intent,
        plan,
        recipe: {
          method: "prepareOperation",
          input: {
            accountId: input.accountId,
            targetContract: prepared.operation.targetContract,
            method: prepared.operation.method,
            args: prepared.operation.args,
            channel: prepared.channel,
            deadline: prepared.operation.deadline,
          },
          signature: prepared.operation.signature,
        },
        actor: input.feePayer || prepared.account.custodyAddress,
        description:
          "Exact native operation. A compatible signer must preserve the script, proxy witness and CustomContracts targets. Native sponsorship is unavailable.",
      });
    },
    async submit(review) {
      const meta = reviews.get(review);
      if (!meta || meta.used || active !== review)
        fail("This review is stale or already submitted.");
      const checkReview = () => {
        guard(meta.version);
        if (active !== review) fail("Review inputs changed. Preview again.");
      };
      checkReview();
      if (submitting) fail("A wallet request is already pending.");
      if (!review.walletSupported || !review.request)
        fail(
          "This plan requires exact-script or multiple-authority signing. Export it for a compatible wallet.",
        );
      if (review.simulationError) fail(review.simulationError);
      if (!wallet) fail("Connect a supported Neo wallet.");
      submitting = true;
      try {
        await revalidateReview(meta.c, review);
        checkReview();
        const actor = await wallet.account();
        if (actor !== review.feePayer)
          fail(
            "Wallet actor does not match the reviewed authority and fee payer.",
          );
        const network = await wallet.network();
        if (network !== review.profile.networkMagic)
          fail("Wallet network does not match the reviewed native network.");
        checkReview();
        const simulation = await meta.c.simulate(review.plan, review.signers);
        checkReview();
        const reason = displayError(simulation);
        if (reason) fail(reason);
        await revalidateReview(meta.c, review);
        checkReview();
        if (
          (await wallet.account()) !== actor ||
          (await wallet.network()) !== network
        )
          fail("Wallet account or network changed. Review again.");
        checkReview();
        const result = await wallet.invoke(review.request);
        meta.used = true;
        if (meta.version !== generation || active !== review)
          fail(
            "Wallet response arrived after the review changed. Check the transaction in your wallet before retrying.",
          );
        return result;
      } finally {
        submitting = false;
      }
    },
    async exportReview(review) {
      const meta = reviews.get(review);
      if (!meta || active !== review) fail("Unknown or stale review.");
      guard(meta.version);
      await revalidateReview(meta.c, review);
      guard(meta.version);
      if (active !== review) fail("Review inputs changed. Preview again.");
      return { format: "neo-native-reviewed-request", version: 1, ...review };
    },
    async importSigned(review, text, caps) {
      const meta = reviews.get(review);
      if (!meta || meta.used || active !== review || review.submission !== "native-sdk")
        fail("Create a current exact-script review before importing a signed transaction.");
      guard(meta.version);
      clearImported();
      const revision = importVersion;
      await revalidateReview(meta.c, review);
      guard(meta.version);
      if (active !== review || revision !== importVersion)
        fail("Review or fee limits changed during import. Import again.");
      const tools = await exactTools();
      const result = await tools.importArtifact(meta.c, review, text, caps);
      await checkCancellationTime(meta.c, review);
      guard(meta.version);
      if (active !== review || revision !== importVersion)
        fail("Review or fee limits changed during import. Import again.");
      imports.set(result, { ...meta, review, tools, revision, attempted: false });
      imported = result;
      return result;
    },
    async preflightSigned(transaction) {
      const meta = imports.get(transaction);
      const check = () => {
        if (!meta || imported !== transaction || active !== meta.review || meta.revision !== importVersion)
          fail("The imported transaction is stale. Review and import again.");
        guard(meta.version);
      };
      check();
      if (meta.attempted) fail("Submission was already attempted. Check this transaction's confirmation.");
      await revalidateReview(meta.c, meta.review);
      check();
      const result = await meta.tools.preflight(meta.c, transaction);
      check();
      return result;
    },
    async broadcastSigned(transaction) {
      const meta = imports.get(transaction);
      const check = () => {
        if (!meta || imported !== transaction || active !== meta.review || meta.revision !== importVersion)
          fail("The imported transaction is stale. Review and import again.");
        guard(meta.version);
      };
      check();
      if (meta.attempted) fail("Submission was already attempted. Check this transaction's confirmation.");
      if (submitting) fail("A transaction submission is already pending.");
      submitting = true;
      try {
        await revalidateReview(meta.c, meta.review);
        check();
        const result = await meta.tools.broadcast(meta.c, transaction, { assertCurrent: check });
        meta.attempted = true;
        reviews.get(meta.review).used = true;
        return result;
      } catch (error) {
        if (error.submissionAttempted) {
          meta.attempted = true;
          reviews.get(meta.review).used = true;
        }
        throw error;
      } finally {
        submitting = false;
      }
    },
    async confirmSigned(transaction) {
      const meta = imports.get(transaction);
      const check = () => {
        if (!meta || imported !== transaction || active !== meta.review || meta.revision !== importVersion)
          fail("The imported transaction is stale. Use the matching review to check its receipt.");
        guard(meta.version);
      };
      check();
      const receipt = await meta.tools.receipt(meta.c, transaction);
      check();
      return receipt;
    },
    async restoreReceipt(reviewText, artifactText) {
      const version = generation, c = client;
      guard(version);
      clearArchived();
      const revision = archiveVersion;
      if (typeof reviewText !== "string" || reviewText.length > 1048576)
        fail("Archived review exceeds the input limit.");
      let review;
      try { review = JSON.parse(reviewText); } catch { fail("Archived review must be valid JSON."); }
      const tools = await exactTools();
      const result = await tools.restoreForReceipt(c, review, artifactText);
      guard(version);
      if (revision !== archiveVersion) fail("Receipt files changed during verification. Restore again.");
      archives.set(result, { version, c, tools, revision });
      archived = result;
      return result;
    },
    async confirmRestoredReceipt(transaction) {
      const meta = archives.get(transaction);
      const check = () => {
        if (!meta || archived !== transaction || meta.revision !== archiveVersion)
          fail("Receipt files changed. Restore them again.");
        guard(meta.version);
      };
      check();
      const receipt = await meta.tools.receipt(meta.c, transaction);
      check();
      return receipt;
    },
    async confirm(review, txid) {
      const meta = reviews.get(review);
      if (!meta) fail("Unknown review.");
      const checkReview = () => {
        guard(meta.version);
        if (active !== review)
          fail(
            "Review inputs changed. Check the receipt from the matching account.",
          );
      };
      checkReview();
      await meta.c.discover();
      checkReview();
      const hash = "0x" + nativeCodec.hex(txid, 32);
      const transaction = await meta.c.rpc.send("getrawtransaction", [
        hash,
        true,
      ]);
      checkReview();
      const log = await meta.c.rpc.send("getapplicationlog", [hash]);
      checkReview();
      return validateNativeReceipt(review, transaction, log, hash);
    },
  };
}
