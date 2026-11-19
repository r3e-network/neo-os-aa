/**
 * Module profile reads for the v4 install path (§7.3).
 *
 * Installing a module requires the digest the core will re-check: it hashes the
 * module's `getModuleProfile()` string and compares it with the digest carried
 * in the install action. The frontend therefore reads the profile from the
 * deployed contract — never from a local file — and hashes the exact bytes the
 * chain will hash. A profile that does not declare a supported moduleType or
 * capability set is refused before any intent is built.
 */

import { sha256, toUtf8Bytes } from 'ethers';
import { invokeReadFunction } from '../utils/neo.js';
import { sanitizeHex } from '../utils/hex.js';

export const PROFILE_VERSION = 1;
export const MODULE_TYPES = Object.freeze(['validator', 'hook']);

/** sha256 of the UTF-8 profile text, hex without a prefix. */
export function profileDigestOf(profileText) {
  return sha256(toUtf8Bytes(String(profileText))).replace(/^0x/i, '').toLowerCase();
}

function decodeBase64Utf8(value) {
  const binary = atob(String(value || ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Validates the shape the core relies on: a v1 profile, a supported
 * moduleType, a capability object and the lifecycle/callback lists.
 */
export function parseModuleProfile(profileText) {
  let profile;
  try {
    profile = JSON.parse(profileText);
  } catch (_) {
    throw new Error('The module profile is not valid JSON');
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('The module profile is not an object');
  }
  if (profile.profileVersion !== PROFILE_VERSION) {
    throw new Error('The module profile declares an unsupported profileVersion');
  }
  if (!MODULE_TYPES.includes(profile.moduleType)) {
    throw new Error('The module profile declares no supported moduleType');
  }
  if (!profile.capabilities || typeof profile.capabilities !== 'object') {
    throw new Error('The module profile declares no capability set');
  }
  if (!Array.isArray(profile.lifecycle) || !Array.isArray(profile.callbacks)) {
    throw new Error('The module profile declares no lifecycle or callback list');
  }
  return profile;
}

/**
 * Reads and hashes a module's profile. The returned digest is the value the
 * install action must carry, and the profile is the one the screen renders.
 */
export async function fetchModuleProfile({ rpcUrl, moduleHash, fetchImpl } = {}) {
  if (!rpcUrl) throw new Error('An RPC endpoint is required to read a module profile');
  const normalized = sanitizeHex(moduleHash || '');
  if (!/^[0-9a-f]{40}$/i.test(normalized)) throw new Error('A module script hash is required');

  const result = await invokeReadFunction(rpcUrl, normalized, 'getModuleProfile', [], fetchImpl);
  if (String(result?.state).toUpperCase() !== 'HALT') {
    throw new Error('The module does not answer getModuleProfile');
  }
  const item = result.stack?.[0];
  if (item?.type !== 'ByteString' || typeof item.value !== 'string') {
    throw new Error('The module does not expose a getModuleProfile string');
  }
  const profileText = decodeBase64Utf8(item.value);
  const profile = parseModuleProfile(profileText);
  return {
    moduleHash: normalized,
    profileText,
    profile,
    profileDigest: profileDigestOf(profileText),
  };
}
