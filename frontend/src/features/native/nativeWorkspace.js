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
      "Recovery authority freezes immediately. Pending changes are cleared.",
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
        "Activates a mature proposal. Old module cleanup may still fail; custody recovery is the callback-independent exit.",
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
    if (state.status === "Frozen" || state.pendingRecovery)
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
  await client.revalidatePlan(plan);
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
} = {}) {
  let generation = 0,
    intentVersion = 0,
    client = null,
    profile = null,
    active = null,
    submitting = false;
  const reviews = new WeakMap();
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
    return { version: generation, c: client, intent: ++intentVersion };
  }
  async function clock(c) {
    const count = await c.rpc.send("getblockcount", []);
    if (!Number.isSafeInteger(count) || count < 1)
      fail("Invalid block height.");
    const block = await c.rpc.send("getblockheader", [count - 1, true]);
    if (!Number.isSafeInteger(block?.time) || block.time < 0)
      fail("Invalid chain timestamp.");
    return block.time;
  }
  async function reviewPlan({
    version,
    c,
    intent,
    plan,
    args,
    actor,
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
    const authorities = [...plan.requiredAuthorities];
    const walletSupported =
      requestedSubmission !== "native-sdk" &&
      !!args &&
      authorities.length <= 1 &&
      (!authorities.length || authorities[0] === actor);
    const submission = walletSupported ? "wallet-invoke" : "native-sdk";
    const required = new Set(authorities);
    if (plan.authorityPolicy === "recovery-or-custody-before-maturity")
      required.add(actor);
    const sdkSigner = (account) => ({
      account: "0x" + account,
      scopes: required.has(account) ? "CustomContracts" : "None",
      ...(required.has(account)
        ? { allowedcontracts: ["0x" + NATIVE_ACCOUNT_SERVICE] }
        : {}),
    });
    const signers = walletSupported
      ? [{ account: "0x" + actor, scopes: "CalledByEntry" }]
      : [
          sdkSigner(actor),
          ...(plan.proxySigner ? [plan.proxySigner] : []),
          ...authorities.filter((h) => h !== actor).map(sdkSigner),
        ];
    const simulation = await c.simulate(plan, signers);
    guard(version);
    if (intent !== intentVersion) fail("Review inputs changed. Preview again.");
    const review = freeze({
      profile,
      plan,
      description,
      recipe,
      submission,
      feePayer: actor,
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
    },
    invalidate() {
      generation++;
      client = null;
      profile = null;
      active = null;
    },
    async connect(options) {
      const version = ++generation;
      client = null;
      profile = null;
      active = null;
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
      const block = actionBlockReason(plan.accountState, input.action, now);
      if (block) fail(block);
      let actor =
        input.feePayer ||
        plan.requiredAuthorities[0] ||
        plan.accountState.custodyAddress;
      actor = nativeAddress(actor);
      if (
        input.action === "cancelRecovery" &&
        actor !== plan.accountState.recoveryAddress &&
        (actor !== plan.accountState.custodyAddress ||
          BigInt(now) >= BigInt(plan.accountState.pendingRecovery.matureAt))
      )
        fail("Only recovery, or custody before maturity, can cancel recovery.");
      const args = [
        H(accountId),
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
        submission: input.submission,
        description:
          NATIVE_ACTIONS.find((a) => a.value === input.action)?.detail ||
          input.action,
      });
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
        await meta.c.revalidatePlan(review.plan);
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
        await meta.c.revalidatePlan(review.plan);
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
      await meta.c.revalidatePlan(review.plan);
      guard(meta.version);
      if (active !== review) fail("Review inputs changed. Preview again.");
      return { format: "neo-native-reviewed-request", version: 1, ...review };
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
