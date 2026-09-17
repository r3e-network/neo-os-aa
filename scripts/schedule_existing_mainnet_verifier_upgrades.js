#!/usr/bin/env node

// Schedules in-place verifier upgrades. This command never creates a second
// verifier address and never bypasses the verifier's own timelock.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  neon, artifactPaths, byteArrayParam, invokePersisted, loadArtifact,
  normalizeHash, sanitizeHex, stringParam, withRpcRetry,
} = require("./lib/deploy-helpers");

const { rpc, sc, wallet } = neon;
const MAINNET_MAGIC = 860833102;
const RPC_URL = "https://api.n3index.dev/mainnet";
const CONFIRMATION = "I_UNDERSTAND_THIS_SCHEDULES_MAINNET_VERIFIER_UPGRADES";
const TARGETS = {
  SessionKeyVerifier: "0x63d6a10d388dd4885bc42ba69593734476f47151",
  SocialRecoveryVerifier: "0xfb3f605fc6bcd59d265d7c18230093d7dc24ac26",
};

function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function rawHash256Param(hexDigest) {
  // Hash256 RPC spelling is little-endian; VerifierAuthority compares the raw
  // CryptoLib.Sha256 bytes, so reverse only at the ABI boundary.
  return sc.ContractParam.hash256(Buffer.from(hexDigest, "hex").reverse().toString("hex"));
}
function artifact(name) {
  const a = loadArtifact(name);
  const manifestText = fs.readFileSync(artifactPaths(name).manifest, "utf8");
  const nef = Buffer.from(a.nef.serialize(), "hex");
  return { a, manifestText, nef, nefDigest: digest(nef), manifestDigest: digest(Buffer.from(manifestText)) };
}

async function main() {
  if (!process.argv.includes("--execute")) throw new Error("--execute is required; this command schedules real mainnet proposals");
  if (process.env.CONFIRM_MAINNET_VERIFIER_SCHEDULE !== CONFIRMATION) throw new Error(`set CONFIRM_MAINNET_VERIFIER_SCHEDULE=${CONFIRMATION}`);
  const wif = process.env.AA_MAINNET_VERIFIER_WIF || process.env.NEO_MAINNET_WIF || process.env.NEO_TESTNET_WIF;
  if (!wif) throw new Error("AA_MAINNET_VERIFIER_WIF (or configured mainnet deployment WIF) is required");
  const account = new wallet.Account(wif);
  const client = new rpc.RPCClient(process.env.AA_MAINNET_RPC_URL || RPC_URL);
  const version = await withRpcRetry("mainnet verifier getversion", () => client.getVersion());
  if (Number(version?.protocol?.network) !== MAINNET_MAGIC) throw new Error("RPC is not Neo N3 mainnet");
  const result = { network: "mainnet", read_only: false, chain_writes_performed: false, targets: [], generated_at: new Date().toISOString() };
  for (const [name, hash] of Object.entries(TARGETS)) {
    const candidate = artifact(name);
    const state = await withRpcRetry(`${name} state`, () => client.getContractState(sanitizeHex(hash)));
    const methods = new Set((state?.manifest?.abi?.methods || []).map((m) => m.name));
    for (const method of ["proposeUpdate", "update", "cancelUpdate"]) if (!methods.has(method)) throw new Error(`${name} lacks ${method}`);
    const params = [rawHash256Param(candidate.nefDigest), rawHash256Param(candidate.manifestDigest)];
    const row = { name, hash, update_counter_before: state.updatecounter, candidate_nef_sha256: `0x${candidate.nefDigest}`, candidate_manifest_sha256: `0x${candidate.manifestDigest}` };
    const tx = await invokePersisted({ client, account, networkMagic: MAINNET_MAGIC, rpcUrl: RPC_URL, contractHash: hash, operation: "proposeUpdate", params, onBroadcast: (txid) => { row.txid = txid; result.chain_writes_performed = true; result.targets.push(row); } });
    row.txid = tx.txid;
    row.application_halt = true;
    if (!result.targets.includes(row)) result.targets.push(row);
  }
  const out = path.resolve(process.env.AA_MAINNET_VERIFIER_SCHEDULE_REPORT || path.join(__dirname, "..", "docs", "reports", "mainnet-verifier-schedule-20260915.json"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, report: out }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
