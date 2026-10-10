import { validateNativeInvocationResult } from "./nativeSmartAccountClient.mjs";

export const NATIVE_SIGNED_ARTIFACT_MAX_CHARS = 1048576;
const MAX_TRANSACTION_BYTES = 102400;
const fail = (message) => { throw new Error(`Native transaction: ${message}`); };
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    fail(`${label} has unsupported or missing fields`);
};
const hex = (value, bytes, maximum = MAX_TRANSACTION_BYTES) => {
  if (typeof value !== "string" || value.length > maximum * 2 ||
      !/^(?:[0-9a-f]{2})*$/.test(value) || (bytes !== undefined && value.length !== bytes * 2))
    fail("artifact hex must use canonical lowercase bytes within size limits");
  return value;
};
const uint32 = (n, label) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) fail(`${label} must be UInt32`);
  return n;
};
const fee = (value, label) => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) >= (1n << 63n))
    fail(`${label} must be a canonical nonnegative Int64 decimal string`);
  return BigInt(value);
};
const reverse = (s) => s.match(/../g).reverse().join("");
const le = (value, size) => {
  let n = BigInt(value), out = "";
  for (let i = 0; i < size; i++) { out += Number(n & 255n).toString(16).padStart(2, "0"); n >>= 8n; }
  if (n) fail("integer overflow");
  return out;
};
const vi = (n) => n < 253 ? le(n, 1) : n <= 65535 ? "fd" + le(n, 2) : "fe" + le(n, 4);
const vb = (s) => vi(s.length / 2) + s;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const toBase64 = (s) => btoa(s.replace(/../g, (h) => String.fromCharCode(parseInt(h, 16))));
const fromBase64 = (s) => {
  if (typeof s !== "string" || s.length > Math.ceil(MAX_TRANSACTION_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))
    fail("persisted transaction must use bounded canonical base64");
  const bytes = atob(s);
  if (btoa(bytes) !== s) fail("persisted transaction has noncanonical base64");
  return Array.from(bytes, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
};
function profile(value) {
  exactKeys(value, ["service", "networkMagic", "abiVersion", "identityVersion", "authorizationVersion", "profileParameterDigest"], "profile");
  if (value.service !== "d9421d07adf206e9dc4be746a02e8e087fa61741" || value.abiVersion !== 2 || value.identityVersion !== 1 || value.authorizationVersion !== 2)
    fail("unsupported native profile");
  return { service: hex(value.service, 20), networkMagic: uint32(value.networkMagic, "network magic"), abiVersion: 2,
    identityVersion: 1, authorizationVersion: 2, profileParameterDigest: hex(value.profileParameterDigest, 32) };
}
function signer(value) {
  exactKeys(value, value?.scopes === "CustomContracts" ? ["account", "scopes", "allowedcontracts"] : ["account", "scopes"], "signer");
  if (typeof value.account !== "string" || !/^0x[0-9a-f]{40}$/.test(value.account)) fail("signer account must be canonical UInt160");
  if (value.scopes === "None") return { account: value.account, scopes: "None" };
  if (value.scopes !== "CustomContracts" || !Array.isArray(value.allowedcontracts) || !value.allowedcontracts.length || value.allowedcontracts.length > 16 ||
      value.allowedcontracts.some((h) => typeof h !== "string" || !/^0x[0-9a-f]{40}$/.test(h)) || new Set(value.allowedcontracts).size !== value.allowedcontracts.length)
    fail("unsupported or noncanonical signer scope");
  return { account: value.account, scopes: value.scopes, allowedcontracts: [...value.allowedcontracts] };
}
function transaction(value) {
  exactKeys(value, ["nonce", "systemFee", "networkFee", "validUntilBlock", "script", "signers"], "transaction");
  fee(value.systemFee, "system fee"); fee(value.networkFee, "network fee");
  if (!Array.isArray(value.signers) || !value.signers.length || value.signers.length > 16) fail("transaction needs 1..16 signers");
  const signers = value.signers.map(signer);
  if (new Set(signers.map((s) => s.account)).size !== signers.length) fail("duplicate transaction signer");
  const script = hex(value.script, undefined, 65535);
  if (!script) fail("empty transaction script");
  return { nonce: uint32(value.nonce, "nonce"), systemFee: value.systemFee, networkFee: value.networkFee,
    validUntilBlock: uint32(value.validUntilBlock, "valid until block"), script, signers };
}
function witnesses(values, count) {
  if (!Array.isArray(values) || values.length !== count) fail("witness count does not match signers");
  return values.map((value) => {
    exactKeys(value, ["invocation", "verification"], "witness");
    return { invocation: hex(value.invocation, undefined, 1024), verification: hex(value.verification, undefined, 1024) };
  });
}
function unsigned(tx) {
  return "00" + le(tx.nonce, 4) + le(tx.systemFee, 8) + le(tx.networkFee, 8) + le(tx.validUntilBlock, 4) + vi(tx.signers.length) +
    tx.signers.map((s) => reverse(s.account.slice(2)) + (s.scopes === "None" ? "00" : "10" + vi(s.allowedcontracts.length) + s.allowedcontracts.map((h) => reverse(h.slice(2))).join(""))).join("") +
    "00" + vb(tx.script);
}

/** The SDK and browser must call this exact complete-signed-transaction response validator. */
export function validateNativeSignedPreflight(c, expected, result) {
  if (result?.hash !== expected.txid || result?.network !== expected.networkMagic || result?.verification !== "Succeed" ||
      result?.state !== "HALT" || result?.relayed !== false || result?.mempoolChecked !== false)
    fail("signed transaction preflight rejected or returned mismatched identity");
  if (!Number.isSafeInteger(result?.snapshot?.height)) fail("preflight snapshot height must be a UInt32 number");
  c.unsigned(result.snapshot.height, 32, "preflight snapshot height");
  c.hex(result?.snapshot?.hash, 32);
  const simulation = result.simulation;
  if (simulation?.mode !== "single-transaction-next-block" || simulation?.onPersist !== "HALT" || simulation?.view !== 0 || simulation?.transactionCount !== 1 ||
      !Number.isSafeInteger(simulation?.height) || simulation.height !== result.snapshot.height + 1 || simulation.height > 0xffffffff ||
      !Number.isSafeInteger(simulation?.primaryIndex) || simulation.primaryIndex < 0 || simulation.primaryIndex > 0xff ||
      typeof simulation?.timestamp !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(simulation.timestamp) ||
      typeof simulation?.nextConsensus !== "string" || !/^0x[0-9a-f]{40}$/.test(simulation.nextConsensus))
    fail("preflight simulation must declare successful single-transaction next-block preparation");
  c.unsigned(simulation.timestamp, 64, "preflight simulation timestamp");
  if (expected.validUntilBlock !== undefined && expected.validUntilBlock <= simulation.height)
    fail("signed transaction expires before the simulated block");
  if (c.unsigned(result.minimumrequiredfee, 63, "final minimum required fee") > BigInt(expected.systemFee))
    fail("final Application admission exceeds signed system fee");
  if (validateNativeInvocationResult(expected.plan, result.stack).length)
    fail("signed transaction preflight token transfer did not return Boolean true");
  return freeze(result);
}

/** Public, portable transport. Crypto and standard wallet witness validation are injected. */
export function createNativeTransactionArtifactTools({ codec: c, sha256, walletWitness } = {}) {
  if (!c || typeof sha256 !== "function") fail("artifact codec and SHA256 adapter required");
  const issued = new WeakMap(), submissions = new WeakMap();
  function createArtifact(input) {
    const p = profile(input.profile), networkMagic = uint32(input.networkMagic, "network magic"), tx = transaction(input.transaction), ws = witnesses(input.witnesses, tx.signers.length);
    if (p.networkMagic !== networkMagic) fail("artifact profile network mismatch");
    const unsignedHex = unsigned(tx), digest = hex(sha256(unsignedHex), 32), txid = "0x" + reverse(digest), signData = le(networkMagic, 4) + digest;
    const rawTransaction = unsignedHex + vi(ws.length) + ws.map((w) => vb(w.invocation) + vb(w.verification)).join("");
    hex(rawTransaction);
    if (input.unsignedHex !== unsignedHex || input.txid !== txid || input.signData !== signData || input.rawTransaction !== rawTransaction)
      fail("artifact transaction bytes, hash or signing data do not match canonical encoding");
    return freeze({ format: "neo-native-signed-transaction", version: 1, networkMagic, profile: p, transaction: tx, witnesses: ws, unsignedHex, txid, signData, rawTransaction });
  }
  function checked(client, imported) {
    const record = issued.get(imported);
    if (!record || record.client !== client) fail("signed artifact must be imported by this transport and client");
    if (client.networkMagic !== imported.profile.networkMagic || !same(profile(client.profile), imported.profile)) fail("current native profile changed");
    return record;
  }
  async function bindArtifact(client, review, text) {
    if (typeof text !== "string" || !text.length || text.length > NATIVE_SIGNED_ARTIFACT_MAX_CHARS) fail("signed artifact JSON exceeds input size limit");
    let input;
    try { input = JSON.parse(text); } catch { fail("signed artifact must be valid JSON"); }
    exactKeys(input, ["format", "version", "networkMagic", "profile", "transaction", "witnesses", "unsignedHex", "txid", "signData", "rawTransaction"], "artifact");
    if (input.format !== "neo-native-signed-transaction" || input.version !== 1) fail("unsupported signed artifact version");
    if (!review || review.submission !== "native-sdk" || !review.plan) fail("signed import requires the current exact-script review");
    const artifact = createArtifact(input);
    if (artifact.networkMagic !== client.networkMagic || !same(artifact.profile, profile(review.profile))) fail("artifact network or reviewed profile mismatch");
    if (artifact.transaction.script !== c.hex(review.plan.script)) fail("artifact script does not match current review");
    if (!same(artifact.transaction.signers, review.signers.map(signer))) fail("artifact signer order, scopes or accounts do not match current review");
    if (artifact.transaction.signers[0].account !== "0x" + c.hex(review.feePayer, 20)) fail("artifact payer does not match current review");
    const proxy = review.plan.kind === "execution" ? c.hex(review.plan.accountAddress, 20) : null;
    if (!walletWitness || typeof walletWitness.validate !== "function") fail("standard wallet signature validation is unavailable");
    for (const [index, descriptor] of artifact.transaction.signers.entries()) {
      const witness = artifact.witnesses[index];
      if (proxy && descriptor.account === "0x" + proxy) {
        if (index !== 1 || witness.invocation !== "" || witness.verification !== c.verificationScript(review.plan.accountId) || !same(descriptor, signer(review.plan.proxySigner))) fail("noncanonical native proxy witness");
      } else if (!(await walletWitness.validate(witness, descriptor.account.slice(2), artifact.signData))) fail("invalid wallet transaction witness");
    }
    if (proxy && artifact.transaction.signers[1]?.account !== "0x" + proxy) fail("missing canonical native proxy signer");
    return artifact;
  }
  const feesOf = (artifact) => ({ system: artifact.transaction.systemFee, network: artifact.transaction.networkFee,
    total: (BigInt(artifact.transaction.systemFee) + BigInt(artifact.transaction.networkFee)).toString() });
  async function importArtifact(client, review, text, caps) {
    const artifact = await bindArtifact(client, review, text), approved = {
      system: c.unsigned(caps?.maxSystemFee, 63, "system fee cap"), network: c.unsigned(caps?.maxNetworkFee, 63, "network fee cap"), total: c.unsigned(caps?.maxTotalFee, 63, "total fee cap"),
    };
    const system = fee(artifact.transaction.systemFee, "system fee"), network = fee(artifact.transaction.networkFee, "network fee");
    if (system > approved.system || network > approved.network || system + network > approved.total) fail("artifact fees exceed approved caps");
    if (review.simulation?.minimumRequiredFee != null && system < c.unsigned(review.simulation.minimumRequiredFee, 63, "reviewed minimum required fee")) fail("artifact system fee is below the reviewed admission requirement");
    await client.revalidatePlan(review.plan);
    if (!same(artifact.profile, profile(client.profile))) fail("current native profile changed");
    const height = uint32(await client.rpc.send("getblockcount", []), "block count");
    if (!height || artifact.transaction.validUntilBlock <= height || artifact.transaction.validUntilBlock > height + 100) fail("signed transaction must expire within the next 100 blocks");
    const imported = freeze({ ...artifact, review, fees: feesOf(artifact) });
    issued.set(imported, { client });
    return imported;
  }
  function archivedReview(input) {
    let text;
    try { text = typeof input === "string" ? input : JSON.stringify(input); }
    catch { fail("archived review must be bounded JSON"); }
    if (typeof text !== "string" || text.length > NATIVE_SIGNED_ARTIFACT_MAX_CHARS) fail("archived review exceeds input size limit");
    let archive;
    try { archive = JSON.parse(text); } catch { fail("archived review must be valid JSON"); }
    if (archive?.format !== "neo-native-reviewed-request" || archive.version !== 1 || archive.submission !== "native-sdk") fail("unsupported archived review format or signing path");
    const p = profile(archive.profile), prior = archive.plan, recipe = archive.recipe;
    if (!prior || !recipe || !recipe.input) fail("archived review requires a reconstructable recipe");
    const inputPlan = recipe.input, H = c.hashValue, S = c.stringValue, service = p.service, zero = "00".repeat(20);
    let plan;
    if (recipe.method === "buildRegistration" && prior.kind === "registration") {
      const identity = c.deriveIdentity({ networkMagic: p.networkMagic, custodyAddress: inputPlan.custodyAddress, salt: inputPlan.salt });
      plan = { kind: "registration", ...identity, method: "registerAccount", script: c.dynamicCall(service, "registerAccount", [
        H(inputPlan.custodyAddress), { type: "ByteString", value: c.hex(inputPlan.salt, 32) }, H(inputPlan.verifier ?? zero), H(inputPlan.hook ?? zero), H(inputPlan.recoveryAddress ?? zero),
      ]) };
    } else if (recipe.method === "buildAction" && prior.kind === "lifecycle") {
      const allowed = ["proposeVerifier", "activateVerifier", "cancelVerifier", "proposeHook", "activateHook", "cancelHook", "proposeRecoveryAddress", "activateRecoveryAddress", "cancelRecoveryAddress", "proposeRecovery", "executeRecovery", "cancelRecovery", "freeze", "unfreeze", "cancelModuleCall"];
      const method = inputPlan.action, accountId = c.hex(inputPlan.accountId, 20), params = [H(accountId)];
      if (!allowed.includes(method)) fail("unsupported archived lifecycle action");
      if (method.startsWith("propose")) params.push(H(inputPlan.address));
      if (method === "cancelModuleCall") {
        if (!["verifier", "hook"].includes(inputPlan.role) || prior.role !== inputPlan.role || prior.requiresExactScript !== true) fail("archived cancellation requires its exact role and guard");
        params.push(S(inputPlan.role));
      }
      let script = c.dynamicCall(service, method, params);
      if (method === "cancelModuleCall") {
        const pending = hex(prior.pendingCallBytes, undefined, 8192);
        if (!pending) fail("archived cancellation has no guarded pending bytes");
        script = c.dynamicCall(service, "getPendingModuleCall", params, 5) + "11c010" + c.encodeValue(S("serialize")) +
          c.encodeValue(H("acce6fd80d44e1796aa0c2c625e9e4e0ce39efc0")) + "41627d5b52" + c.encodeValue({ type: "ByteString", value: pending }) + "9739" + script;
      }
      plan = { kind: "lifecycle", accountId, accountAddress: c.accountAddress(accountId), method, script };
    } else if (recipe.method === "buildModuleCall" && prior.kind === "configuration") {
      if (!["verifier", "hook"].includes(inputPlan.role) || prior.role !== inputPlan.role) fail("unsupported archived module role");
      const accountId = c.hex(inputPlan.accountId, 20), method = "call" + (inputPlan.role === "verifier" ? "Verifier" : "Hook") + (inputPlan.child ? "Child" : "");
      const args = c.canonicalValue({ type: "Array", value: inputPlan.args ?? [] });
      plan = { kind: "configuration", accountId, accountAddress: c.accountAddress(accountId), method, script: c.dynamicCall(service, method, [
        H(accountId), ...(inputPlan.child ? [H(inputPlan.child)] : []), S(inputPlan.method), args,
      ]) };
    } else if (recipe.method === "prepareOperation" && prior.kind === "execution") {
      if (!Array.isArray(prior.preparedOperations) || prior.preparedOperations.length !== 1 || typeof prior.batch !== "boolean") fail("archived workspace execution requires one exact operation");
      const prepared = prior.preparedOperations[0], context = prepared?.context, accountId = c.hex(inputPlan.accountId, 20);
      if (!context || context.networkMagic !== p.networkMagic || c.hex(context.accountId, 20) !== accountId) fail("archived operation context mismatch");
      const source = prepared.operation;
      const operation = { targetContract: c.hex(source.targetContract, 20), method: source.method,
        args: c.canonicalValue({ type: "Array", value: source.args ?? [] }).value,
        nonce: c.unsigned(source.nonce, 255, "archived operation nonce").toString(), deadline: c.unsigned(source.deadline, 255, "archived operation deadline").toString(), signature: c.hex(source.signature) };
      if (c.hex(inputPlan.targetContract, 20) !== operation.targetContract || inputPlan.method !== operation.method ||
          c.serializeValue({ type: "Array", value: inputPlan.args ?? [] }) !== c.serializeValue({ type: "Array", value: operation.args }) ||
          c.unsigned(inputPlan.deadline, 255, "recipe deadline").toString() !== operation.deadline ||
          c.unsigned(inputPlan.channel ?? 0, 191, "recipe channel") !== c.splitNonce(operation.nonce).channel || c.hex(recipe.signature) !== operation.signature)
        fail("archived operation recipe does not match its signed operation");
      const accountAddress = c.accountAddress(accountId);
      plan = { kind: "execution", accountId, accountAddress, batch: prior.batch, preparedOperations: [{ operation }],
        script: c.buildExecutionScript(accountId, [operation], context, prior.batch),
        proxySigner: { account: "0x" + accountAddress, scopes: "CustomContracts", allowedcontracts: ["0x" + operation.targetContract] },
      };
    } else fail("unsupported archived review recipe");
    if (c.hex(prior.accountId, 20) !== plan.accountId || prior.script !== plan.script ||
        (plan.kind !== "execution" && prior.method !== plan.method) ||
        (prior.accountAddress !== undefined && c.hex(prior.accountAddress, 20) !== plan.accountAddress))
      fail("archived recipe and plan do not reconstruct the signed script");
    // Only byte-bound semantics survive. Historical account snapshots, descriptions,
    // pending-intent labels and unsigned authority-role claims are not authenticated.
    return freeze({ format: archive.format, version: 1, profile: p, submission: "native-sdk", feePayer: c.hex(archive.feePayer, 20), signers: archive.signers.map(signer), plan });
  }
  async function restoreForReceipt(client, archive, text) {
    const review = archivedReview(archive), artifact = await bindArtifact(client, review, text);
    await client.discover();
    if (client.networkMagic !== artifact.networkMagic || !same(artifact.profile, profile(client.profile))) fail("current native profile changed");
    const imported = freeze({ ...artifact, review, fees: feesOf(artifact), receiptOnly: true, semanticsVerified: true });
    issued.set(imported, { client, receiptOnly: true });
    return imported;
  }
  async function preflight(client, imported) {
    if (checked(client, imported).receiptOnly) fail("receipt-only restoration cannot authorize transaction preflight");
    await client.revalidatePlan(imported.review.plan);
    checked(client, imported);
    let result;
    try { result = await client.rpc.send("invoketransaction", [toBase64(imported.rawTransaction)]); }
    catch (cause) {
      const error = new Error(`Native transaction: signed transaction preflight unavailable: ${cause?.message ?? cause}`, { cause });
      if (cause && typeof cause === "object") for (const key of ["code", "data"]) if (Object.hasOwn(cause, key)) error[key] = cause[key];
      throw error;
    }
    checked(client, imported);
    return validateNativeSignedPreflight(c, { txid: imported.txid, networkMagic: client.networkMagic, plan: imported.review.plan, systemFee: imported.transaction.systemFee, validUntilBlock: imported.transaction.validUntilBlock }, result);
  }
  function broadcast(client, imported, { assertCurrent = () => {} } = {}) {
    try { if (checked(client, imported).receiptOnly) fail("receipt-only restoration cannot authorize broadcast"); assertCurrent(); }
    catch (error) {
      if (issued.has(imported)) error.txid = imported.txid;
      error.submissionAttempted = false;
      return Promise.reject(error);
    }
    let byId = submissions.get(client);
    if (!byId) { byId = new Map(); submissions.set(client, byId); }
    const key = imported.txid + ":" + imported.rawTransaction;
    if (byId.has(key)) return byId.get(key);
    let submissionAttempted = false;
    const promise = (async () => {
      await preflight(client, imported);
      checked(client, imported); assertCurrent();
      submissionAttempted = true;
      const result = await client.rpc.send("sendrawtransaction", [toBase64(imported.rawTransaction)]);
      if (result?.hash && String(result.hash).toLowerCase() !== imported.txid) fail("RPC returned a different transaction id");
      if (result !== true && !result?.hash) fail("RPC did not confirm transaction submission");
      return { txid: imported.txid, submitted: true, confirmed: false };
    })().catch((error) => {
      error.txid = imported.txid; error.submissionAttempted = submissionAttempted;
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
    if (String(tx.hash).toLowerCase() !== imported.txid) fail("persisted transaction identity mismatch");
    if (/^0+$/.test(c.hex(tx.blockhash, 32))) fail("persisted transaction has a zero block hash");
    if (tx.confirmations !== undefined && (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 1))
      fail("persisted transaction has invalid confirmations");
    const [wire, log] = await Promise.all([client.rpc.send("getrawtransaction", [imported.txid, false]), client.rpc.send("getapplicationlog", [imported.txid])]);
    checked(client, imported);
    if (fromBase64(wire) !== imported.rawTransaction) fail("persisted transaction bytes differ from signed transaction");
    if (String(log?.txid).toLowerCase() !== imported.txid) fail("application log transaction identity mismatch");
    const executions = log.executions?.filter((x) => x.trigger === "Application");
    if (!executions || executions.length !== 1) fail("confirmed transaction must have one Application execution");
    const execution = executions[0], failures = [];
    if (execution.vmstate !== "HALT") failures.push(`Application state is ${execution.vmstate ?? "unknown"}`);
    else {
      try { for (const index of validateNativeInvocationResult(imported.review.plan, execution.stack)) failures.push(`Token transfer ${index + 1} did not return Boolean true`); }
      catch (error) { failures.push(error.message); }
    }
    return freeze({ txid: imported.txid, confirmed: true, succeeded: failures.length === 0, failures, blockHash: tx.blockhash, vmState: execution.vmstate,
      exception: execution.exception ?? null, stack: execution.stack ?? [], notifications: execution.notifications ?? [], gasConsumed: execution.gasconsumed ?? null,
      systemFee: imported.transaction.systemFee, networkFee: imported.transaction.networkFee });
  }
  return Object.freeze({ createArtifact, importArtifact, restoreForReceipt, preflight, broadcast, receipt });
}
