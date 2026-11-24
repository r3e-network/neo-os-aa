/**
 * Native kernel account workspace (SA module protocol v4).
 *
 * Everything here mirrors the compiled v4 surface of
 * `contracts/native/SmartAccount/*`, which is the minimal core: it registers
 * an account from custody + salt + recovery timelock, freezes and unfreezes
 * it, administers module instances and executes signed operations. Recovery,
 * message, hook-order and configuration-intent transitions are user-space
 * module concerns; the core keeps their descriptor slots for ABI stability and
 * reports the inactive value, so this workspace reads them as inactive instead
 * of inventing module state. The v3 slots (verifier, hook, recovery address,
 * pending module call) do not exist in v4 and are deliberately absent: a
 * removed concept must fail, never be silently re-mapped onto a different one.
 *
 * The workspace never invents authority. It reads the account from the core,
 * derives who may sign, simulates the exact script, and hands the caller a
 * review that binds script, plan, payer and signer scopes. Exported reviews are
 * instructions to rebuild, never authority to sign.
 */

import { sha256, ripemd160 } from "ethers";
import {
  createProtocolCodec,
  NATIVE_SMART_ACCOUNT_CONTRACT,
} from "../../shared/nativeSmartAccount.mjs";
import { createNativeClientClass, validateNativeApplicationExecution } from "../../shared/nativeSmartAccountClient.mjs";
import { createProxyWitness } from "../../shared/proxyWitness.mjs";
import {
  getScriptHashFromAddress,
  getAddressFromScriptHash,
} from "../../utils/neo.js";

export { NATIVE_SMART_ACCOUNT_CONTRACT };
export const ZERO_HASH = "00".repeat(20);
// The native kernel's proxy script calls verify(accountId) with
// CallFlags.ReadOnly; a custom kernel pushes CallFlags.All (15). The address
// must be the one the submitting kernel derives.
export const NATIVE_PROXY_CALL_FLAGS = 5;

export const nativeCodec = createProtocolCodec({
  sha256: (hex) => sha256("0x" + hex).slice(2),
  hash160: (hex) => ripemd160(sha256("0x" + hex)).slice(2),
});
const Client = createNativeClientClass(nativeCodec, {
  callFlags: NATIVE_PROXY_CALL_FLAGS,
});

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

// Limits copied from SmartAccountModuleProtocol.cs; the tests pin them back to
// that source so a kernel change cannot leave the UI promising a longer window
// than the chain enforces.
export const RECOVERY_TIMELOCK_MIN_MS = 604800000; // 7 days
export const RECOVERY_TIMELOCK_MAX_MS = 7776000000; // 90 days
// The core installs at most this many actions at registration; a later
// configuration change belongs to the governance module and carries its own
// limits, so no intent window is promised here.
export const MAX_ACTIONS_PER_INTENT = 16;
export const MAX_OPERATIONS_PER_ENVELOPE = 32;
export const NATIVE_MODULE_TYPES = freeze({ validator: 1, hook: 4, recovery: 5 });
export const NATIVE_MODULE_LIMITS = freeze({ validator: 32, hook: 8, recovery: 1 });
export const NATIVE_THRESHOLD_LIMITS = freeze({
  maxMembers: 10,
  minValue: 1,
  maxValue: 10,
});
export const NATIVE_ACTION_CODES = freeze({
  installModule: 1,
  uninstallModule: 2,
  configureModule: 3,
  setHookOrder: 4,
  setDefaultPolicy: 5,
  rebindModuleCode: 6,
  setThresholdPolicy: 7,
  setRecoveryPolicy: 8,
  setMessageSubjects: 9,
});
export const NATIVE_STATUS_NAMES = freeze([
  "Active",
  "Frozen",
]);

async function browserTransactionTools() {
  const [{ createNativeTransactionArtifactTools }, { createNativeWalletWitnessTools }] =
    await Promise.all([
      import("../../shared/nativeTransactionArtifact.mjs"),
      import("../../shared/nativeWalletWitness.mjs"),
    ]);
  return createNativeTransactionArtifactTools({
    codec: nativeCodec,
    sha256: (hex) => sha256("0x" + hex).slice(2),
    walletWitness: createNativeWalletWitnessTools({
      hash160: (hex) =>
        ripemd160(sha256("0x" + hex))
          .slice(2)
          .match(/../g)
          .reverse()
          .join(""),
    }),
  });
}

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
  if (
    !zero &&
    (address === ZERO_HASH || address === NATIVE_SMART_ACCOUNT_CONTRACT)
  )
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
      { name: "saWallet", api: windowObject?.saWallet },
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

// ---------------------------------------------------------------------------
// Recovery descriptor: the offline instruction a custody wallet keeps.
// ---------------------------------------------------------------------------

function recoveryTimelockMs(value) {
  const ms = nativeCodec.unsigned(value, 64, "recovery timelock");
  if (
    ms < BigInt(RECOVERY_TIMELOCK_MIN_MS) ||
    ms > BigInt(RECOVERY_TIMELOCK_MAX_MS)
  )
    fail("Set a recovery timelock of 7 to 90 days.");
  return ms;
}

export function buildRecoveryDescriptor(input) {
  const custody = nativeAddress(input.custodyAddress),
    salt = nativeCodec.hex(input.salt);
  const saltBytes = salt.length / 2;
  if (saltBytes < 1 || saltBytes > 128)
    fail("Descriptor salt must contain 1 to 128 bytes.");
  const networkMagic = Number(
    nativeCodec.unsigned(input.networkMagic, 32, "network magic"),
  );
  const contract = nativeCodec.hex(input.contract, 20);
  if (contract === ZERO_HASH) fail("Descriptor requires the core contract hash.");
  const timelock = recoveryTimelockMs(input.recoveryTimelockMs);
  // v4 identity is custody + salt alone (§16.1); the proxy address additionally
  // binds the core and its call flags, so both are recorded and re-derived.
  const identity = nativeCodec.deriveIdentity({
    custodyAddress: custody,
    salt,
    coreContractHash: contract,
    callFlags: NATIVE_PROXY_CALL_FLAGS,
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
  return freeze({
    format: "neo-native-account-descriptor",
    version: 2,
    protocolVersion: 4,
    networkMagic,
    contract,
    callFlags: NATIVE_PROXY_CALL_FLAGS,
    recoveryTimelockMs: timelock.toString(),
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
    value.version !== 2 ||
    value.protocolVersion !== 4 ||
    value.callFlags !== NATIVE_PROXY_CALL_FLAGS
  )
    fail("Unsupported native recovery descriptor.");
  if (
    profile &&
    (value.networkMagic !== Number(profile.networkMagic) ||
      value.contract !== nativeCodec.hex(profile.contract, 20))
  )
    fail("Descriptor network or profile mismatch.");
  return buildRecoveryDescriptor(value);
}

// ---------------------------------------------------------------------------
// Configuration actions (§9): positional Arrays, element 0 is the code.
// ---------------------------------------------------------------------------

const I = (value) => ({ type: "Integer", value: String(value) });
const B = (value) => ({ type: "ByteString", value: nativeCodec.hex(value) });
const A = (value) => ({ type: "Array", value });
const RPC_HASH = (value) => ({ type: "Hash160", value: "0x" + nativeCodec.hex(value, 20) });

function moduleTypeCode(value) {
  const name = String(value ?? "").toLowerCase();
  const code =
    typeof value === "number" ? value : NATIVE_MODULE_TYPES[name];
  if (!Object.values(NATIVE_MODULE_TYPES).includes(code))
    fail("Choose a validator (1), hook (4) or recovery (5) module.");
  return code;
}

function digest32(value, label) {
  const hex = nativeCodec.hex(value);
  if (hex.length !== 64) fail(`${label} must be a 32-byte SHA-256 digest.`);
  return hex;
}

function dataArray(value, label) {
  if (value === undefined || value === null) return A([]);
  if (!Array.isArray(value) || value.length > 64)
    fail(`${label} must be an Array of at most 64 values.`);
  return A(value);
}

// Human input uses text for commands, explicit Hash160 for display-order
// addresses, and explicit ByteString for opaque bytes. No hex guessing.
export function parseModuleInstallData(text) {
  let values;
  try { values = JSON.parse(text.trim() || "[]"); }
  catch { fail("Initial configuration must be a JSON array."); }
  if (!Array.isArray(values) || values.length > 64) fail("Expected at most 64 install arguments.");
  function encode(value, depth) {
    if (depth > 8) fail("Install arguments are nested too deeply.");
    if (Array.isArray(value)) return A(value.map(v => encode(v, depth + 1)));
    if (typeof value === "string") return nativeCodec.stringValue(value);
    if (typeof value === "boolean") return { type: "Boolean", value };
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) fail("Use a typed Integer with a decimal string for large integers.");
      return I(value);
    }
    if (value?.type === "Hash160") return nativeCodec.hashValue(nativeAddress(value.value, { zero: true }));
    return nativeCodec.canonicalValue(value);
  }
  return nativeCodec.canonicalValue(A(values.map(v => encode(v, 1)))).value;
}

export function installModuleAction({
  moduleType,
  contractHash,
  profileDigest,
  initData = [],
}) {
  const contract = nativeAddress(contractHash);
  return freeze(
    A([
      I(NATIVE_ACTION_CODES.installModule),
      I(moduleTypeCode(moduleType)),
      nativeCodec.hashValue(contract),
      B(digest32(profileDigest, "Module profile digest")),
      dataArray(initData, "Install data"),
    ]),
  );
}

export function uninstallModuleAction({ moduleId, deInitData = [] }) {
  const id = nativeCodec.unsigned(moduleId, 64, "module id");
  if (id === 0n) fail("Module id must be positive.");
  return freeze(
    A([
      I(NATIVE_ACTION_CODES.uninstallModule),
      I(id),
      dataArray(deInitData, "Uninstall data"),
    ]),
  );
}

export function configureModuleAction({ moduleId, configData = [] }) {
  return freeze(
    A([
      I(NATIVE_ACTION_CODES.configureModule),
      I(nativeCodec.unsigned(moduleId, 64, "module id")),
      dataArray(configData, "Configuration data"),
    ]),
  );
}

export function rebindModuleCodeAction({ moduleId, profileDigest }) {
  return freeze(
    A([
      I(NATIVE_ACTION_CODES.rebindModuleCode),
      I(nativeCodec.unsigned(moduleId, 64, "module id")),
      B(digest32(profileDigest, "Module profile digest")),
    ]),
  );
}

export function setHookOrderAction({ hookIds }) {
  if (!Array.isArray(hookIds) || hookIds.length > NATIVE_MODULE_LIMITS.hook)
    fail(`Hook order accepts at most ${NATIVE_MODULE_LIMITS.hook} ids.`);
  const ids = hookIds.map((id) => nativeCodec.unsigned(id, 64, "hook id"));
  if (new Set(ids.map(String)).size !== ids.length)
    fail("Hook order cannot repeat a module id.");
  return freeze(A([I(NATIVE_ACTION_CODES.setHookOrder), A(ids.map(I))]));
}

export function setDefaultPolicyAction({
  operationAuthorization,
  messageAuthorization,
}) {
  return freeze(
    A([
      I(NATIVE_ACTION_CODES.setDefaultPolicy),
      { type: "Boolean", value: operationAuthorization === true },
      { type: "Boolean", value: messageAuthorization === true },
    ]),
  );
}

export function setThresholdPolicyAction({
  policyId = 0,
  threshold,
  memberIds,
  active = true,
}) {
  const id = nativeCodec.unsigned(policyId, 64, "policy id");
  const value = Number(nativeCodec.unsigned(threshold, 8, "threshold"));
  if (active !== true || id !== 0n) fail("Changing an active spending policy requires delayed recovery.");
  if (!Array.isArray(memberIds) || memberIds.length > NATIVE_THRESHOLD_LIMITS.maxMembers)
    fail(`A threshold policy carries at most ${NATIVE_THRESHOLD_LIMITS.maxMembers} members.`);
  const members = memberIds.map(v => nativeCodec.unsigned(v, 64, "member module id"));
  if (members.includes(0n) || new Set(members).size !== members.length)
    fail("Threshold members must be distinct nonzero module ids.");
  if (active && (value < 1 || value > members.length))
    fail("A reachable threshold needs between 1 and its member count.");
  return freeze(
    A([
      I(NATIVE_ACTION_CODES.setThresholdPolicy),
      I(id),
      I(value),
      A(members.map(I)),
      { type: "Boolean", value: active === true },
    ]),
  );
}

export function setRecoveryPolicyAction({
  recoveryAuthority,
  recoveryTimelockMs: timelock,
  ownerOnlyRecovery = false,
}) {
  if (ownerOnlyRecovery !== false)
    throw new Error("ownerOnlyRecovery is reserved and must be false");
  const delay = recoveryTimelockMs(timelock);
  const authority = nativeAddress(recoveryAuthority);
  return freeze(
    A([
      I(NATIVE_ACTION_CODES.setRecoveryPolicy),
      nativeCodec.hashValue(authority),
      I(delay),
      { type: "Boolean", value: ownerOnlyRecovery === true },
    ]),
  );
}

function moduleTypeName(code) {
  return code === NATIVE_MODULE_TYPES.validator
    ? "validator"
    : code === NATIVE_MODULE_TYPES.hook
      ? "hook"
      : code === NATIVE_MODULE_TYPES.recovery ? "recovery" : `type ${code}`;
}

function shortHash(item) {
  const value = typeof item?.value === "string" ? item.value : "";
  if (!/^[0-9a-f]{40}$/.test(value)) return "unknown";
  return value.match(/../g).reverse().join("").slice(0, 8) + "…";
}

/** Human summary of one configuration action, for the pending-intent card. */
export function describeConfigurationAction(action) {
  const fields = action?.type === "Array" ? action.value : null;
  if (!Array.isArray(fields) || !fields.length) return "Unrecognized action";
  const code = Number(fields[0]?.value);
  switch (code) {
    case NATIVE_ACTION_CODES.installModule:
      return `Install ${moduleTypeName(Number(fields[1]?.value))} module ${shortHash(fields[2])}`;
    case NATIVE_ACTION_CODES.uninstallModule:
      return `Uninstall module ${fields[1]?.value}`;
    case NATIVE_ACTION_CODES.configureModule:
      return `Reconfigure module ${fields[1]?.value}`;
    case NATIVE_ACTION_CODES.setHookOrder:
      return `Set hook order [${(fields[1]?.value ?? []).map((id) => id.value).join(" → ")}]`;
    case NATIVE_ACTION_CODES.setDefaultPolicy:
      return `Built-in route: operations ${fields[1]?.value === true ? "on" : "off"}, messages ${fields[2]?.value === true ? "on" : "off"}`;
    case NATIVE_ACTION_CODES.rebindModuleCode:
      return `Rebind module ${fields[1]?.value} to the profile ${fields[2]?.value?.slice(0, 8) ?? ""}…`;
    case NATIVE_ACTION_CODES.setThresholdPolicy:
      return `Threshold policy ${fields[1]?.value}: ${fields[2]?.value}-of-${(fields[3]?.value ?? []).length}${fields[4]?.value === true ? "" : " (inactive)"}`;
    case NATIVE_ACTION_CODES.setRecoveryPolicy: {
      const days = Number(fields[2]?.value ?? 0) / 86400000;
      return `Recovery policy ${shortHash(fields[1])}, ${days}-day timelock`;
    }
    case NATIVE_ACTION_CODES.setMessageSubjects:
      return "Set message subjects";
    default:
      return `Action ${code}`;
  }
}

// ---------------------------------------------------------------------------
// Account actions (immediate, custody/recovery gated, no intent).
// ---------------------------------------------------------------------------

// The core owns exactly the two immediate transitions. Recovery begin / execute
// / cancel are the recovery module's methods, so they are not actions this
// workspace can plan against the core ABI.
export const NATIVE_ACTIONS = freeze([
  {
    value: "freezeAccount",
    label: "Freeze the account",
    detail:
      "Custody witness. Freezing advances the authority epoch, so every signed operation from before stops being valid.",
  },
  {
    value: "unfreezeAccount",
    label: "Unfreeze the account",
    detail:
      "Custody witness. Only a frozen account can be unfrozen, and the authority epoch advances again.",
  },
  {
    value: "setRecoveryPolicy", label: "Set recovery authority", address: true,
    detail: "Custody approves the policy. A newly appointed recovery wallet must also sign.",
  },
  { value: "beginRecovery", label: "Start recovery", recipient: true, detail: "Custody or recovery signs; a new custody wallet also signs." },
  { value: "cancelRecovery", label: "Cancel pending recovery", detail: "Custody or the recovery authority signs for the reviewed record." },
  { value: "executeRecovery", label: "Complete mature recovery", detail: "Anyone can pay to complete the reviewed recovery once mature." },
]);

export function actionBlockReason(state, action, translate = (en) => en) {
  if (!state) return "Load an account first.";
  if (!NATIVE_STATUS_NAMES.includes(state.statusName)) return "Unrecognized account status.";
  if (["freezeAccount", "unfreezeAccount", "setRecoveryPolicy"].includes(action)) {
    if (state.requiredPolicyId) return translate("Mandatory multisig locks custody administration. Use the preset delayed recovery process.", "已启用强制多签，托管人不能单独管理账户。请走预设延时恢复流程。");
    if (state.policyCheckFailed) return translate("Could not verify the spending policy. Refresh before changing account settings.", "无法核验支出策略，请刷新后再更改账户设置。");
  }
  if (["beginRecovery", "cancelRecovery", "executeRecovery"].includes(action)) {
    if (state.recoveryAuthority === ZERO_HASH) return "Configure a recovery authority first.";
    if (!state.recoverySeat?.supported) return "No supported recovery module is installed.";
    if (action === "beginRecovery" && state.pendingRecovery) return "A recovery is already pending.";
    if (action !== "beginRecovery" && !state.pendingRecovery) return "No pending recovery.";
  }
  if (action === "setRecoveryPolicy" && state.statusName !== "Active")
    return "Recovery policy can only be changed on an active account.";
  if (action === "freezeAccount" && state.statusName === "Frozen")
    return "The account is already frozen.";
  if (action === "unfreezeAccount" && state.statusName !== "Frozen")
    return "The account is not frozen.";
  return "";
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const comparable = (value) =>
  JSON.stringify(value, (_, item) => {
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

function displayError(simulation) {
  return simulation.state === "HALT" && !simulation.incompleteTransfers?.length
    ? ""
    : "Simulation failed or a token transfer returned false. The request cannot be sent.";
}

async function chainTime(client) {
  const count = await client.rpc.send("getblockcount", []);
  if (!Number.isSafeInteger(count) || count < 1) fail("Invalid block height.");
  const block = await client.rpc.send("getblockheader", [count - 1, true]);
  if (!Number.isSafeInteger(block?.time) || block.time < 0)
    fail("Invalid chain timestamp.");
  return block.time;
}

async function readState(client, accountId, { overview = false } = {}) {
  const account = await client.getAccount(accountId);
  if (!account) fail("This native account is not registered.");
  let requiredPolicyId = null, policyCheckFailed = false;
  if (!account.defaultOperationAuthorization && account.recoveryAuthority !== ZERO_HASH) {
    try { requiredPolicyId = (await client.getThresholdPolicy(accountId))?.policyId ?? null; }
    catch { policyCheckFailed = true; }
  }
  let recoverySeat = null, recoveryCheckFailed = false;
  if (account.recoveryAuthority !== ZERO_HASH) {
    try { recoverySeat = await client.getRecoverySeat(accountId); }
    catch (error) {
      if (!overview) throw error;
      recoveryCheckFailed = true;
    }
    if (overview && recoverySeat?.supported &&
        (await client.getAccount(accountId))?.configurationNonce !== account.configurationNonce)
      fail("Account configuration changed. Refresh the account.");
  }
  return freeze({ ...account, statusName: NATIVE_STATUS_NAMES[account.status] ?? "Unknown",
    recoverySeat, recoveryCheckFailed, requiredPolicyId, policyCheckFailed, pendingRecovery: recoverySeat?.pending ?? null });
}

const nativeAssets = Object.freeze({
  NEO: { hash: "ef4073a0f2b305a38ec4050e4d3d28bc40ea63f5", decimals: 0 },
  GAS: { hash: "d2a4cff31913016155e38e474a2c06d08be276cf", decimals: 8 },
});

// Read the two native assets directly; nodes need no wallet indexer. A failed
// balance query is unknown, never a zero balance.
async function readBalances(client, address) {
  const pairs = await Promise.all(Object.entries(nativeAssets).map(async ([symbol, asset]) => {
    try {
      const script = nativeCodec.dynamicCall(asset.hash, "balanceOf", [nativeCodec.hashValue(address)], 5);
      const { stack } = await client.invokeScript(script);
      const item = stack[0];
      if (stack.length === 1 && item?.type === "Integer" && typeof item.value === "string" &&
          /^(0|[1-9][0-9]{0,76})$/.test(item.value) && BigInt(item.value) < 1n << 255n)
        return [symbol, item.value];
    } catch { /* The other balance and account identity remain useful. */ }
    return [symbol, null];
  }));
  return Object.fromEntries(pairs);
}

async function readModules(client, accountId, config) {
  const changed = () => fail("Module configuration changed. Refresh the account and try again.");
  const page = async (type) => {
    const { moduleIds, configurationNonce, nextCursor } = await client.getModules(accountId, type);
    if (configurationNonce !== config) changed();
    if (moduleIds.length > NATIVE_MODULE_LIMITS[type] ||
        moduleIds.some((id, i) => BigInt(id) <= BigInt(moduleIds[i - 1] ?? "0")))
      fail("Invalid native module roster.");
    if (nextCursor !== "0") {
      // At the 32-validator limit the core returns the last ID as a cursor,
      // even if no further IDs exist. Verify the empty tail on this revision.
      if (moduleIds.length !== 32 || nextCursor !== moduleIds.at(-1)) changed();
      const tail = await client.getModules(accountId, type, { cursor: nextCursor });
      if (tail.configurationNonce !== config || tail.nextCursor !== "0" || tail.moduleIds.length) changed();
    }
    const modules = [];
    for (const moduleId of moduleIds) {
      const module = await client.getModule(accountId, moduleId);
      if (!module || module.moduleId !== moduleId || module.moduleType !== NATIVE_MODULE_TYPES[type]) changed();
      modules.push({ ...module, moduleTypeName: moduleTypeName(module.moduleType) });
    }
    return modules;
  };
  const [validators, hooks, recovery] = await Promise.all([page("validator"), page("hook"), page("recovery")]);
  if ((await client.getAccount(accountId))?.configurationNonce !== config) changed();
  return freeze({ validators, hooks, recovery });
}

function sdkSigners(client, plan, actor, authorities) {
  if (plan.accountAddress && actor === plan.accountAddress)
    fail("The fee payer must be a separate Neo wallet, not the account proxy.");
  const required = new Set(authorities);
  const descriptor = (account) =>
    required.has(account)
      ? {
          account: "0x" + account,
          scopes: "CustomContracts",
          allowedcontracts: ["0x" + (plan.targetContract ?? client.contractHash)],
        }
      : { account: "0x" + account, scopes: "None" };
  const signers = [descriptor(actor)];
  if (plan.kind === "execution") {
    const proxy = createProxyWitness({
      coreHash: client.contractHash,
      accountId: plan.accountId,
      proxyHash: plan.accountAddress,
      feePayer: actor,
      callFlags: plan.proxyCallFlags,
    });
    if (proxy.signer.account !== plan.accountAddress)
      fail("The plan proxy address is not this account's proxy under this core.");
    signers.push({
      account: "0x" + proxy.signer.account,
      scopes: proxy.signer.scopes,
      rules: proxy.signer.rules,
    });
  }
  for (const account of authorities)
    if (account !== actor) signers.push(descriptor(account));
  return signers;
}

function custodyOnly(state, authority) {
  if (authority !== state.custodyAddress)
    fail("Only the custody wallet can sign this account action.");
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
  const { recipe } = exported;
  let plan;
  if (recipe?.method === "buildCreateAccountScript")
    plan = client.buildCreateAccountScript(recipe.input);
  else if (recipe?.method === "buildRecoveryModulePlan")
    plan = await client.buildRecoveryModulePlan(recipe.input);
  else if (recipe?.method === "buildRecoveryPolicyPlan")
    plan = await client.buildRecoveryPolicyPlan(recipe.input);
  else if (recipe?.method === "buildAccountActionScript")
    plan = client.buildAccountActionScript(recipe.input);
  else if (recipe?.method === "buildExecutionScript")
    plan = client.buildExecutionScript(recipe.input);
  else fail("Unsupported review recipe.");
  // Script equality alone cannot identify a mutable plan: two freezes of the
  // same account share a script. Compare every public plan field, then the
  // authority roster and signer scopes.
  if (comparable(plan) !== comparable(exported.plan))
    fail("Reviewed authority, pending intent or operation changed. Review again.");
  // A configuration-intent recipe belonged to a kernel that carried one. The
  // minimal core has no such method, so a review exported against this ABI can
  // never contain one; the recipe branch above already refused it.
  const payer = nativeAddress(exported.feePayer);
  const authorities = await expectedAuthorities(client, plan, exported);
  if (
    comparable(authorities) !== comparable(exported.requiredAuthorities) ||
    comparable(sdkSigners(client, plan, payer, authorities)) !==
      comparable(exported.signers)
  )
    fail("Reviewed authority, fee payer or signer scopes changed. Review again.");
  if (
    exported.authority !== undefined &&
    nativeAddress(exported.authority) !== exported.authority
  )
    fail("Reviewed authority changed. Review again.");
  client.prepare(plan);
  await client.revalidatePlan(plan);
  return plan;
}

async function expectedAuthorities(client, plan, exported) {
  if (plan.kind === "registration") return [plan.custodyAddress];
  if (plan.kind === "execution") return [];
  if (plan.kind === "recovery" || plan.method === "setRecoveryPolicy") return [...plan.signers];
  const state = await readState(client, plan.accountId);
  if (plan.method === "freezeAccount" || plan.method === "unfreezeAccount") {
    if (exported.authority !== undefined) custodyOnly(state, exported.authority);
    return [state.custodyAddress];
  }
  fail("Unsupported account action.");
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
  const scopeName = { 0: "None", 1: "CalledByEntry", 16: "CustomContracts", 64: "WitnessRules" };
  const normalizeSigner = (signer) => {
    if (!signer || typeof signer !== "object")
      fail("Transaction signer scope mismatch.");
    const scope = scopeName[signer.scopes] || signer.scopes;
    if (signer.allowedgroups?.length || signer.allowedGroups?.length)
      fail("Transaction signer scope mismatch.");
    if (scope === "WitnessRules") {
      const rules = signer.rules ?? [];
      if (rules.length !== 1) fail("Transaction signer scope mismatch.");
      const rule = rules[0];
      if (rule?.action !== "Allow") fail("Transaction signer scope mismatch.");
      const condition = rule.condition ?? {};
      if (condition.type !== "CalledByContract")
        fail("Transaction signer scope mismatch.");
      return {
        account: nativeCodec.hex(signer.account, 20),
        scopes: scope,
        rules: [
          {
            action: rule.action,
            condition: {
              type: condition.type,
              hash: nativeCodec.hex(condition.hash, 20),
            },
          },
        ],
      };
    }
    if (!["None", "CalledByEntry", "CustomContracts"].includes(scope))
      fail("Transaction signer scope mismatch.");
    const contracts = signer.allowedcontracts ?? signer.allowedContracts ?? [];
    if (!Array.isArray(contracts)) fail("Transaction signer scope mismatch.");
    return {
      account: nativeCodec.hex(signer.account, 20),
      scopes: scope,
      ...(scope === "CustomContracts"
        ? {
            allowedcontracts: contracts
              .map((contract) => nativeCodec.hex(contract, 20))
              .sort(),
          }
        : {}),
    };
  };
  const normalizeReviewSigner = (signer) => {
    const normalized = normalizeSigner(signer);
    if (normalized.scopes !== "CustomContracts")
      delete normalized.allowedcontracts;
    return normalized;
  };
  if (
    !Array.isArray(transaction.signers) ||
    !Array.isArray(review.signers) ||
    comparable(transaction.signers.map(normalizeSigner)) !==
      comparable(review.signers.map(normalizeReviewSigner)) ||
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
  if (applications.length !== 1)
    fail("Transaction must have exactly one Application result.");
  if (validateNativeApplicationExecution(review.plan, applications[0]).length)
    fail("Token transfer result is false or could not be verified.");
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
  const exactTools = () =>
    (toolsPromise ||= Promise.resolve(
      transactionTools || browserTransactionTools(),
    ));
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
  // A review is only as good as the node still answering the same profile: a
  // swapped node or a re-deployed kernel must revoke every pending review, not
  // merely re-simulate against whatever answers now. A configuration intent is
  // re-read too, because the same script can confirm a different action set.
  async function revalidateReview(c, review) {
    const found = await c.discover();
    if (comparable(found) !== comparable(review.profile))
      fail("Review network or native profile mismatch.");
    await c.revalidatePlan(review.plan);
  }
  async function reviewPlan({
    version,
    c,
    intent,
    plan,
    args,
    authorities,
    actor,
    description,
    recipe,
    requiresExactScript = false,
    extra,
    submission: requestedSubmission,
  }) {
    if (intent !== intentVersion) fail("Review inputs changed. Preview again.");
    guard(version);
    actor = nativeAddress(actor);
    const requiredAuthorities = [...new Set(authorities)];
    const submissionRequested =
      requestedSubmission !== "native-sdk" &&
      !requiresExactScript &&
      !!args &&
      requiredAuthorities.length <= 1 &&
      (!requiredAuthorities.length || requiredAuthorities[0] === actor);
    const submission = submissionRequested ? "wallet-invoke" : "native-sdk";
    const signers = submissionRequested
      ? [{ account: "0x" + actor, scopes: "CalledByEntry" }]
      : sdkSigners(c, plan, actor, requiredAuthorities);
    c.prepare(plan);
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
      ...(extra ?? {}),
      requiredAuthorities,
      signers,
      simulation,
      simulationError: displayError(simulation),
      walletSupported: submissionRequested,
      request: submissionRequested
        ? {
            scriptHash: "0x" + (plan.targetContract ?? c.contractHash),
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
    async load(accountId) {
      const { version, c, intent } = begin();
      const id = nativeAddress(accountId);
      await c.discover();
      const [account, chainNow] = await Promise.all([readState(c, id, { overview: true }), chainTime(c)]);
      const balances = await readBalances(c, account.accountAddress);
      guard(version);
      if (intent !== intentVersion) fail("Account input changed. Load again.");
      return freeze({ account, balances, chainTime: chainNow });
    },
    async loadModules(accountId, configurationNonce) {
      const { version, c, intent } = begin();
      await c.discover();
      const modules = await readModules(c, nativeAddress(accountId), configurationNonce);
      guard(version);
      if (intent !== intentVersion) fail("Account input changed. Load again.");
      return modules;
    },
    async transferDraft({ accountId, symbol, recipient, amount }) {
      const { version, c, intent } = begin();
      const id = nativeAddress(accountId), to = nativeAddress(recipient);
      if (!Object.hasOwn(nativeAssets, symbol)) fail("Choose NEO or GAS.");
      const asset = nativeAssets[symbol], value = String(amount).trim();
      if (value.length > 32 || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))
        fail("Enter a positive token amount.");
      const [whole, fraction = ""] = value.split(".");
      if (fraction.length > asset.decimals) fail(symbol === "NEO" ? "NEO transfers require a whole number." : "GAS supports up to 8 decimal places.");
      const units = BigInt(whole + fraction.padEnd(asset.decimals, "0"));
      if (units === 0n) fail("Enter a positive token amount.");
      await c.discover();
      const [account, now] = await Promise.all([c.getAccount(id), chainTime(c)]);
      if (!account || account.statusName !== "Active" || !account.defaultOperationAuthorization)
        fail("This transfer form requires an active account with the built-in custody route.");
      const nonceSubkey = "00".repeat(32), credentialGeneration = "1";
      // Native v4 fixes the built-in generation at 1. Verify it and the
      // account epoch against the channel returned by the node.
      const { packed } = await c.getNonce(id, { authorityEpoch: account.authorityEpoch,
        validatorId: "0", credentialGeneration, nonceSubkey });
      if (packed === (1n << 64n).toString()) fail("Nonce channel exhausted.");
      const op = { targetContract: asset.hash, method: "transfer",
        args: [nativeCodec.hashValue(account.accountAddress), nativeCodec.hashValue(to),
          { type: "Integer", value: units.toString() }, { type: "Null" }],
        nonce: packed, nonceSubkey, deadline: String(now + 900000), validatorId: "0",
        credentialGeneration, authorityEpoch: account.authorityEpoch, configurationNonce: account.configurationNonce,
        signature: "", hookProofs: [] };
      const digest = nativeCodec.operationDigest({ networkMagic: c.networkMagic, coreContractHash: c.contractHash, accountId: id }, op);
      guard(version);
      if (intent !== intentVersion) fail("Transfer inputs changed. Prepare the draft again.");
      return freeze({ accountId: id, networkMagic: c.networkMagic, core: c.contractHash, recipient: to,
        symbol, amount: value, digest, operation: op });
    },
    async registration(input) {
      const { version, c, intent } = begin();
      const timelock =
        input.recoveryTimelockMs !== undefined
          ? input.recoveryTimelockMs
          : input.recoveryTimelockDays !== undefined
            ? Math.round(Number(input.recoveryTimelockDays) * 86400000)
            : undefined;
      if (timelock === undefined) fail("Choose a recovery timelock of 7 to 90 days.");
      const normalized = {
        custodyAddress: nativeAddress(input.custodyAddress),
        salt: nativeCodec.hex(input.salt),
        recoveryTimelockMs: recoveryTimelockMs(timelock).toString(),
        actions: input.actions ? [...input.actions] : [],
      };
      const saltBytes = normalized.salt.length / 2;
      if (saltBytes < 1 || saltBytes > 128)
        fail("Use a registration salt of 1 to 128 bytes.");
      if (normalized.actions.length > MAX_ACTIONS_PER_INTENT)
        fail(`Registration installs at most ${MAX_ACTIONS_PER_INTENT} actions.`);
      const plan = c.buildCreateAccountScript(normalized);
      if (
        input.accountId &&
        nativeCodec.hex(input.accountId, 20) !== plan.accountId
      )
        fail("Registration identity mismatch.");
      const state = await readState(c, plan.accountId).catch((error) => {
        if (/not registered/.test(String(error?.message))) return null;
        throw error;
      });
      if (state) fail("This account id is already registered on this core.");
      const args = [
        RPC_HASH(plan.accountId),
        RPC_HASH(normalized.custodyAddress),
        { type: "ByteArray", value: normalized.salt },
        { type: "Integer", value: normalized.recoveryTimelockMs },
        { type: "Array", value: normalized.actions },
      ];
      return reviewPlan({
        version,
        c,
        intent,
        plan,
        args,
        authorities: [normalized.custodyAddress],
        recipe: { method: "buildCreateAccountScript", input: normalized },
        submission: input.submission,
        actor: input.feePayer || normalized.custodyAddress,
        description: normalized.actions.length
          ? "Register with the initial module install executed atomically, no timelock. Installing a validator leaves the built-in custody route unchanged."
          : "Register with the built-in custody route. Validators and hooks are administered afterwards by installModule/removeModule; the core has no proposal window.",
      });
    },
    async lifecycle(input) {
      const { version, c, intent } = begin();
      const accountId = nativeAddress(input.accountId);
      const action = String(input.action ?? "");
      if (!NATIVE_ACTIONS.some((entry) => entry.value === action))
        fail("Choose a supported account action.");
      const state = await readState(c, accountId);
      const block = actionBlockReason(state, action);
      if (block) fail(block);
      // Freeze and unfreeze are custody-only. Recovery begin / execute / cancel
      // belong to the recovery module and are not core methods, so no core
      // authority rule is invented for them here.
      const actor = nativeAddress(
        input.feePayer || input.authority || state.custodyAddress,
      );
      if (["beginRecovery", "cancelRecovery", "executeRecovery"].includes(action)) {
        const policy = { accountId, action,
          ...(action !== "executeRecovery" ? { authority: nativeAddress(input.authority || actor) } : {}),
          ...(action === "beginRecovery" ? { newCustody: input.newCustody ? nativeAddress(input.newCustody) : ZERO_HASH } : {}) };
        const plan = await c.buildRecoveryModulePlan(policy);
        const args = [RPC_HASH(accountId), ...(action === "beginRecovery" ? [RPC_HASH(policy.newCustody)]
          : [{ type: "Integer", value: plan.pending.nonce }, { type: "Integer", value: plan.configurationNonce }])];
        return reviewPlan({ version, c, intent, plan, actor, authorities: plan.signers, args,
          extra: { ...(action === "executeRecovery" ? {} : { authority: policy.authority }),
            newCustody: (action === "beginRecovery" ? plan.newCustody : plan.pending?.newCustody) || ZERO_HASH },
          description: NATIVE_ACTIONS.find(a => a.value === action).detail,
          recipe: { method: "buildRecoveryModulePlan", input: policy }, submission: input.submission });
      }
      custodyOnly(state, actor);
      if (action === "setRecoveryPolicy") {
        const recipient = nativeAddress(input.recoveryAuthority);
        const delay = recoveryTimelockMs(input.recoveryTimelockMs ?? state.recoveryTimelockMs).toString();
        const policy = { accountId, recoveryAuthority: recipient, recoveryTimelockMs: delay,
          ownerOnlyRecovery: state.ownerOnlyRecovery };
        const plan = await c.buildRecoveryPolicyPlan(policy);
        return reviewPlan({ version, c, intent, plan, actor,
          authorities: plan.signers, description: "Set recovery authority and timelock.",
          args: [RPC_HASH(accountId), RPC_HASH(recipient), { type: "Integer", value: delay },
            { type: "Boolean", value: policy.ownerOnlyRecovery }],
          recipe: { method: "buildRecoveryPolicyPlan", input: policy }, submission: input.submission });
      }
      const args = [RPC_HASH(accountId)];
      const vmArgs = [];
      const plan = c.buildAccountActionScript({
        method: action,
        accountId,
        args: vmArgs,
      });
      return reviewPlan({
        version,
        c,
        intent,
        plan,
        args,
        authorities: [actor],
        extra: {},
        recipe: {
          method: "buildAccountActionScript",
          input: {
            method: action,
            accountId,
            args: vmArgs.map((value) => ({ ...value })),
          },
        },
        submission: input.submission,
        actor,
        description:
          NATIVE_ACTIONS.find((entry) => entry.value === action)?.detail ??
          action,
      });
    },
    async inspectConfiguration({ accountId }) {
      const { version, c, intent } = begin();
      const id = nativeAddress(accountId);
      await c.discover();
      const now = await chainTime(c);
      guard(version);
      if (intent !== intentVersion)
        fail("Configuration inputs changed. Refresh the pending intents again.");
      // Proposals, maturity and expiry are the governance module's state. The
      // core has no intent record, so the honest answer for this account is an
      // empty list rather than a read of something the ABI does not publish.
      return freeze({ accountId: id, chainTime: now, intents: [] });
    },
    async configuration() {
      // The core is a kernel: it exposes installModule/removeModule and nothing
      // else about configuration. A 24-hour proposal that matures, expires and
      // is confirmed by digest is the governance module's contract, so there is
      // no core script to build and no authority the core could re-check.
      fail(
        "The minimal core has no configuration intent. Module administration is installModule/removeModule; the proposal window belongs to the governance module.",
      );
    },
    async operation(input) {
      const { version, c, intent } = begin();
      const accountId = nativeAddress(input.accountId);
      const operations = input.operations;
      if (
        !Array.isArray(operations) ||
        !operations.length ||
        operations.length > MAX_OPERATIONS_PER_ENVELOPE
      )
        fail(
          `An execution envelope carries 1 to ${MAX_OPERATIONS_PER_ENVELOPE} operations.`,
        );
      const state = await readState(c, accountId);
      if (state.statusName !== "Active")
        fail("The account is not active. Check whether the account is frozen or in recovery.");
      const plan = c.buildExecutionScript({ accountId, operations });
      return reviewPlan({
        version,
        c,
        intent,
        plan,
        authorities: [],
        requiresExactScript: true,
        recipe: { method: "buildExecutionScript", input: { accountId, operations } },
        submission: input.submission,
        actor: input.feePayer || state.custodyAddress,
        description:
          "Signed user operation batch. The proxy witness is the only signer the core accepts for executeUserOp, and the operation signature must come from an installed validator or the built-in route.",
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
      try {
        review = JSON.parse(reviewText);
      } catch {
        fail("Archived review must be valid JSON.");
      }
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
      const transaction = await meta.c.rpc.send("getrawtransaction", [hash, true]);
      checkReview();
      const log = await meta.c.rpc.send("getapplicationlog", [hash]);
      checkReview();
      return validateNativeReceipt(review, transaction, log, hash);
    },
  };
}
