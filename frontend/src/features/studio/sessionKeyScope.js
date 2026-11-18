// Session-key value-exposure analysis shared by the Permissions panel and its tests.
//
// A SessionKeyVerifier key only carries an enforceable spending cap when its method is the literal
// "transfer" AND its spending limit is positive (see contracts/plugins/verifiers/SessionKeyVerifier.cs:
// the on-chain ExtractTransferValue path is the only one the limit is checked against). Every other
// configuration — a wildcard ("*") method, or any key with a zero/absent spending limit — is
// VALUE-UNCAPPED: the delegated signer can move the whole balance on a value-bearing target. The
// one-target/one-method studio preset does not imply that, so the UI must warn distinctly.

// Well-known Neo N3 native asset script hashes (no 0x, lowercase).
export const NATIVE_ASSETS = Object.freeze({
  d2a4cff31913016155e38e474a2c06d08be276cf: "GAS",
  ef4073a0f2b305a38ec4050e4d3d28bc40ea63f5: "NEO",
});

export function normalizeHash(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");
}

/**
 * Analyzes a setSessionKey argument list for its true value exposure.
 *
 * setSessionKey args (Neo RPC params):
 *   [accountId, pubKey, targetContract, method, validUntil, spendingLimit?, description?]
 *
 * @param {Array<{type:string,value:any}>} args
 * @returns {{ applies: boolean, uncapped: boolean, nativeAsset: string|null }}
 *   applies   — true when this looks like a setSessionKey arg list we can reason about
 *   uncapped  — true when the key has no enforceable spending cap for its target
 *   nativeAsset — "GAS"/"NEO" when the target is a native asset, else null
 */
export function analyzeSessionKeyScope(args) {
  if (!Array.isArray(args) || args.length < 4) {
    return { applies: false, uncapped: false, nativeAsset: null };
  }

  const method = String(args[3]?.value ?? "");
  const rawLimit = args[5]?.value;
  const limit =
    rawLimit === undefined || rawLimit === null || rawLimit === ""
      ? 0
      : Number(rawLimit);

  // Capped only on the one path the contract actually enforces: transfer + positive limit.
  const uncapped = method === "*" || !(method === "transfer" && limit > 0);
  const nativeAsset = NATIVE_ASSETS[normalizeHash(args[2]?.value)] ?? null;

  return { applies: true, uncapped, nativeAsset };
}
