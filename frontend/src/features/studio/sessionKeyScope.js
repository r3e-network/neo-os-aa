// Session-key value-exposure analysis shared by the configure panel and its tests.
//
// In v4 a session key is a configured SessionKeyValidator instance, not a standalone verifier:
// the instance's `configure` data is `["setSessionKey", pubKey, targetContract, method, validUntil,
// spendingLimit, description]` (see contracts/plugins/validators/SessionKeyValidator.cs). The
// spending cap is only enforceable on the value-moving "transfer" path, and the plugin rejects a
// positive limit on any other method. Every configuration that still passes — a wildcard ("*")
// method, or any key with a zero spending limit — is VALUE-UNCAPPED: the delegated signer can move
// the whole balance on a value-bearing target. The UI must warn distinctly instead of implying the
// one-target/one-method shape bounds the value.

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

// Configure data arrives either as typed VM DTOs ({type, value}) or as plain JSON values; both
// spellings describe the same command list, so read the payload out of either one.
function payload(entry) {
  return entry && typeof entry === "object" && "value" in entry ? entry.value : entry;
}

/**
 * Analyzes a `setSessionKey` configure command for its true value exposure.
 *
 * setSessionKey args (the configure(data) array the core forwards to the module):
 *   ["setSessionKey", pubKey, targetContract, method, validUntil, spendingLimit?, description?]
 *
 * @param {Array<{type:string,value:any}|any>} args
 * @returns {{ applies: boolean, uncapped: boolean, nativeAsset: string|null }}
 *   applies   — true when this is a setSessionKey command list we can reason about
 *   uncapped  — true when the key has no enforceable spending cap for its target
 *   nativeAsset — "GAS"/"NEO" when the target is a native asset, else null
 */
export function analyzeSessionKeyScope(args) {
  if (!Array.isArray(args) || args.length < 4) {
    return { applies: false, uncapped: false, nativeAsset: null };
  }
  if (String(payload(args[0]) ?? "") !== "setSessionKey") {
    return { applies: false, uncapped: false, nativeAsset: null };
  }

  const method = String(payload(args[3]) ?? "");
  const rawLimit = payload(args[5]);
  const limit =
    rawLimit === undefined || rawLimit === null || rawLimit === ""
      ? 0
      : Number(rawLimit);

  // Capped only on the one path the module actually enforces: transfer + positive limit.
  const uncapped = method === "*" || !(method === "transfer" && limit > 0);
  const nativeAsset = NATIVE_ASSETS[normalizeHash(payload(args[2]))] ?? null;

  return { applies: true, uncapped, nativeAsset };
}
