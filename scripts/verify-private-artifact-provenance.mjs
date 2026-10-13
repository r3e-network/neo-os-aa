#!/usr/bin/env node

// Joins the source/rebuild certificate to the private NeoExpress deployment and
// RPC readback receipt. This is deliberately read-only: it proves that the exact
// release files selected by the validator are the files rebuilt from the current
// contract inputs and the files read back from the isolated chain.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_PROFILES, buildInputSnapshot, listArtifacts } from "./check-artifact-reproducibility.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(repoRoot, "contracts", "bin", "v3");
const reportsDir = path.join(repoRoot, "docs", "reports");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function selectLatestDatedReport(names, prefix) {
  const candidates = names
    .filter((name) => new RegExp(`^${prefix}-\\d{8}\\.json$`).test(name))
    .sort();
  if (candidates.length === 0) throw new Error(`no dated ${prefix} report found`);
  return candidates.at(-1);
}

function latestDatedReport(prefix) {
  const name = selectLatestDatedReport(fs.readdirSync(reportsDir), prefix);
  return path.join(reportsDir, name);
}

// Defaults intentionally resolve only canonical dated reports. This excludes
// historical `-final` receipts and the explicitly non-evidence `-unmatched-runner`
// receipt, so a direct invocation cannot silently join stale or ineligible data.
const reproPath = latestDatedReport("aa-artifact-reproducibility");
const receiptPath = latestDatedReport("aa-neoexpress-validation");

// Keep this list identical to scripts/neoexpress_validate.py::ARTIFACTS for the
// 24 artifacts produced by this repository. NeoDIDRegistry is an external sibling
// artifact and is checked by the NeoExpress receipt but not by this source tree.
export const LOCAL_ARTIFACTS = {
  UnifiedSmartWalletV3: "UnifiedSmartWalletV3.nef",
  MockTransferTarget: "MockTransferTarget.nef",
  Web3AuthVerifier: "verifiers/Web3AuthVerifier.nef",
  TEEVerifier: "verifiers/TEEVerifier.nef",
  SessionKeyVerifier: "verifiers/SessionKeyVerifier.nef",
  WebAuthnVerifier: "verifiers/WebAuthnVerifier.nef",
  ZKEmailVerifier: "verifiers/ZKEmailVerifier.nef",
  ZkLoginVerifier: "verifiers/ZkLoginVerifier.nef",
  MultiSigVerifier: "verifiers/MultiSigVerifier.nef",
  SubscriptionVerifier: "verifiers/SubscriptionVerifier.nef",
  NeoNativeVerifier: "verifiers/NeoNativeVerifier.nef",
  DailyLimitHook: "hooks/DailyLimitHook.nef",
  NeoDIDCredentialHook: "hooks/NeoDIDCredentialHook.nef",
  WhitelistHook: "hooks/WhitelistHook.nef",
  MultiHook: "hooks/MultiHook.nef",
  TokenRestrictedHook: "hooks/TokenRestrictedHook.nef",
  AAPaymaster: "AAPaymaster.nef",
  AAAddressMarket: "AAAddressMarket.nef",
  SocialRecoveryVerifier: "SocialRecoveryVerifier.nef",
  MockVerifierCore: "MockVerifierCore.nef",
  PlatformRegistrarMock: "PlatformRegistrarMock.nef",
  MarkerOnlyModule: "MarkerOnlyModule.nef",
  WrongLifecycleAbiModule: "WrongLifecycleAbiModule.nef",
  WrongHookLifecycleAbiModule: "WrongHookLifecycleAbiModule.nef",
};

function readVarInt(data, offset, end, maximum) {
  if (offset >= end) throw new Error("truncated NEF length");
  const first = data[offset];
  const width = first < 0xfd ? 0 : first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (offset + 1 + width > end) throw new Error("truncated NEF length");
  const value = width === 0 ? BigInt(first)
    : width === 2 ? BigInt(data.readUInt16LE(offset + 1))
      : width === 4 ? BigInt(data.readUInt32LE(offset + 1))
        : data.readBigUInt64LE(offset + 1);
  const minimum = width === 0 ? 0n : width === 2 ? 0xfdn : width === 4 ? 0x10000n : 0x100000000n;
  if (value < minimum) throw new Error("noncanonical NEF length");
  // Bound the bigint before converting it to Number or using it as an offset.
  if (value > BigInt(maximum)) throw new Error("NEF length exceeds field limit");
  return [Number(value), offset + 1 + width];
}

/** Validates NEF3 framing and checksum, not NeoVM instructions or ABI semantics. */
export function parseNefScript(data) {
  if (!Buffer.isBuffer(data)) throw new TypeError("NEF data must be a Buffer");
  if (!data.subarray(0, 4).equals(Buffer.from("NEF3", "ascii"))) throw new Error("not a NEF3 file");
  const end = data.length - 4;
  let offset = 4;
  const take = (length) => {
    if (length > end - offset) throw new Error("truncated NEF field");
    const bytes = data.subarray(offset, offset + length);
    offset += length;
    return bytes;
  };
  const readBytes = (maximum) => {
    let length;
    [length, offset] = readVarInt(data, offset, end, maximum);
    return take(length);
  };
  const decode = (bytes) => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("invalid NEF UTF-8");
    }
  };
  const compiler = take(64);
  const terminator = compiler.indexOf(0);
  if (terminator >= 0 && compiler.subarray(terminator).some((value) => value !== 0)) {
    throw new Error("invalid NEF compiler padding");
  }
  decode(terminator < 0 ? compiler : compiler.subarray(0, terminator));
  decode(readBytes(256));
  if (take(1)[0] !== 0) throw new Error("NEF reserved byte must be zero");
  let methodCount;
  [methodCount, offset] = readVarInt(data, offset, end, 128);
  for (let i = 0; i < methodCount; i++) {
    take(20);
    const method = decode(readBytes(32));
    if (method.startsWith("_")) throw new Error("NEF token method must not start with an underscore");
    take(2); // ushort parameter count
    if (take(1)[0] > 1) throw new Error("noncanonical NEF boolean");
    if ((take(1)[0] & ~0x0f) !== 0) throw new Error("invalid NEF call flags");
  }
  if (take(2).some((value) => value !== 0)) throw new Error("NEF reserved bytes must be zero");
  const script = readBytes(end);
  if (script.length === 0) throw new Error("NEF script is empty");
  if (offset !== end) throw new Error("NEF framing has trailing bytes before checksum");
  const expected = createHash("sha256").update(createHash("sha256").update(data.subarray(0, end)).digest()).digest().readUInt32LE(0);
  if (data.readUInt32LE(end) !== expected) throw new Error("NEF checksum mismatch");
  return script;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function verifyReleaseCertificate(repro, releaseRoot = releaseDir) {
  const certificate = repro?.certificate;
  const fresh = certificate?.fresh_artifact_sha256;
  const release = certificate?.release_artifact_sha256;
  if (repro?.release_matches_fresh_build !== true || certificate?.byte_equal_release !== true ||
      !Array.isArray(repro?.drifted) || repro.drifted.length !== 0 ||
      !Array.isArray(repro?.missing) || repro.missing.length !== 0 ||
      !fresh || !release) {
    throw new Error("rebuild certificate is not byte-identical");
  }

  // v3 is the deployed module set, but its source certificate also attests the
  // isolated platform core. Validate both profile inventories before chain joining.
  const binRoot = path.dirname(releaseRoot);
  const disk = ARTIFACT_PROFILES.flatMap((profile) => {
    const directory = profile === "v3" ? releaseRoot : path.join(binRoot, profile);
    const files = listArtifacts(directory);
    const entry = repro.profiles?.[profile];
    if (entry?.matches_fresh_build !== true || entry?.required_core_present !== true
        || entry.artifacts_compared !== files.length
        || !["UnifiedSmartWalletV3.nef", "UnifiedSmartWalletV3.manifest.json"].every((name) => files.includes(name))) {
      throw new Error(`rebuild certificate profile inventory mismatch: ${profile}`);
    }
    return files.map((file) => `${profile}/${file}`);
  }).sort();
  const freshNames = Object.keys(fresh).sort();
  const releaseNames = Object.keys(release).sort();
  if (repro.artifacts_compared !== disk.length ||
      JSON.stringify(freshNames) !== JSON.stringify(releaseNames) ||
      JSON.stringify(releaseNames) !== JSON.stringify(disk)) {
    throw new Error("rebuild certificate artifact inventory mismatch");
  }

  for (const artifact of disk) {
    if (fresh[artifact] !== release[artifact]) {
      throw new Error(`rebuild certificate fresh/release mismatch: ${artifact}`);
    }
    const [profile, ...relative] = artifact.split("/");
    const directory = profile === "v3" ? releaseRoot : path.join(binRoot, profile);
    const actual = sha256(fs.readFileSync(path.join(directory, ...relative)));
    if (actual !== release[artifact]) {
      throw new Error(`rebuild certificate does not match release bytes: ${artifact}`);
    }
  }
  return disk.length;
}

export function verifyProvenance({ repro, receipt, releaseRoot = releaseDir }) {
  if (repro.certificate?.schema !== "neoos-aa-source-to-artifact-certificate/v1") {
    throw new Error("source-to-artifact certificate is missing");
  }
  if (repro.certificate.source_root !== "repository") throw new Error("source-to-artifact certificate must include repository restore policy");
  const currentSourceFiles = buildInputSnapshot(repoRoot);
  const currentSourceSnapshotSha256 = sha256(Buffer.from(JSON.stringify(currentSourceFiles)));
  if (currentSourceSnapshotSha256 !== repro.certificate.source_snapshot_sha256) {
    throw new Error("current contract source inputs differ from the reproducibility certificate");
  }
  if (JSON.stringify(currentSourceFiles) !== JSON.stringify(repro.certificate.source_files)) {
    throw new Error("current contract source file hashes differ from the reproducibility certificate");
  }
  verifyReleaseCertificate(repro, releaseRoot);
  if (receipt.status !== "PASS" || receipt.releaseEvidenceEligible !== true) {
    throw new Error("private NeoExpress receipt is not release-eligible");
  }
  if (receipt.network?.publicNetwork !== false || receipt.privacy?.privateKeysIncluded !== false) {
    throw new Error("receipt is not private or contains key material");
  }

  const deployments = Object.fromEntries(receipt.deployments.map((row) => [row.contractName, row]));
  const readback = Object.fromEntries(receipt.rpcReadback.contracts.map((row) => [row.contractName, row]));
  const rows = [];
  for (const [name, relative] of Object.entries(LOCAL_ARTIFACTS)) {
    const nefPath = path.join(releaseRoot, relative);
    const manifestPath = nefPath.replace(/\.nef$/, ".manifest.json");
    const nef = fs.readFileSync(nefPath);
    const manifest = fs.readFileSync(manifestPath);
    const script = parseNefScript(nef);
    const deployed = deployments[name];
    const chain = readback[name];
    if (!deployed || !chain) throw new Error(`receipt missing ${name}`);
    const row = {
      contractName: name,
      artifact: relative,
      releaseNefSha256: sha256(nef),
      deploymentNefSha256: deployed.localNefSha256,
      releaseManifestSha256: sha256(manifest),
      deploymentManifestSha256: deployed.localManifestSha256,
      releaseScriptSha256: sha256(script),
      rpcScriptSha256: chain.nefScriptSha256,
      nefFullHashMatch: sha256(nef) === deployed.localNefSha256,
      manifestFullHashMatch: sha256(manifest) === deployed.localManifestSha256,
      rpcScriptHashMatch: sha256(script) === chain.nefScriptSha256,
      rpcChecksumMatch: chain.nefChecksumEquality === true,
      rpcManifestSemanticMatch: chain.manifestSemanticEquality === true,
      rpcScriptByteMatch: chain.nefScriptByteEquality === true,
      releaseCertificateHashMatch: repro.certificate.release_artifact_sha256?.[`v3/${relative}`] === sha256(nef),
    };
    if (!Object.entries(row).filter(([key]) => key.endsWith("Match")).every(([, value]) => value === true)) {
      throw new Error(`private artifact provenance mismatch: ${name}`);
    }
    rows.push(row);
  }

  const external = Object.keys(deployments).filter((name) => !(name in LOCAL_ARTIFACTS));
  return {
    schema: "neoos-aa-private-artifact-provenance/v1",
    status: "PASS",
    sourceToRelease: {
      sourceSnapshotSha256: repro.certificate.source_snapshot_sha256,
      currentSourceSnapshotSha256,
      sourceSnapshotMatch: true,
      compileRecipeSha256: repro.certificate.compile_recipe_sha256,
      compiler: repro.certificate.compiler,
      artifactsCompared: repro.artifacts_compared,
      releaseMatchesFreshBuild: repro.release_matches_fresh_build,
    },
    releaseToPrivateChain: {
      localArtifactsChecked: rows.length,
      rows,
      externalArtifacts: external,
      externalArtifactNote: "NeoDIDRegistry is a sibling-repository input; it is read back but not part of this source certificate.",
    },
    publicNetworkWritesPerformed: false,
    boundary: "Proves source-input rebuild, release-file identity and isolated NeoExpress RPC readback; not a compiler-correctness theorem, full NeoVM refinement proof or public deployment parity.",
    privacy: { credentialsIncluded: false, privateKeysIncluded: false, absoluteUserPathsIncluded: false },
  };
}

function cliOptions(argv) {
  const options = { repro: reproPath, receipt: receiptPath, releaseRoot: releaseDir };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--repro" || argument === "--receipt" || argument === "--release-root") {
      if (!argv[index + 1]) throw new Error(`${argument} requires a path`);
      const key = argument === "--repro" ? "repro" : argument === "--receipt" ? "receipt" : "releaseRoot";
      options[key] = path.resolve(argv[++index]);
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const options = cliOptions(process.argv.slice(2));
  const report = verifyProvenance({
    repro: loadJson(options.repro),
    receipt: loadJson(options.receipt),
    releaseRoot: options.releaseRoot,
  });
  console.log(JSON.stringify(report, null, 2));
}
