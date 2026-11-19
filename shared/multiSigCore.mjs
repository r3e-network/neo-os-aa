/**
 * Threshold-signature assembly for the Neo N3 Smart Account v4 stack.
 *
 * One validator instance can route an operation for several member modules: the
 * core calls `validateUserOp` on the threshold instance, which then asks each
 * member. The operation's signature field (index 11) is therefore one of two
 * shapes (docs/SA-MODULE-PROTOCOL.md §5):
 *
 * - standalone route (`operation.validatorId == moduleId`): the raw bytes the
 *   module's own verifier expects (64-byte r‖s for P-256 / secp256k1);
 * - threshold route: the serialized list `[[memberModuleId, memberSignature]]`,
 *   strictly ascending by member id, 1..10 entries.
 *
 * Each member signs `SHA256("NeoSmartAccount/ThresholdMember" ‖ U1(4) ‖
 * operationDigest ‖ U64BE(memberModuleId) ‖ U64BE(memberGeneration))`, where
 * the generation is the member instance's current credential generation
 * (`getModule(accountId, memberId).credentialGeneration`) and the operation
 * digest is the core's §4.3 digest. The member id and generation are part of
 * the preimage, so a signature cannot be replayed onto another member or across
 * a credential rotation.
 *
 * Neo `StdLib.Serialize` layout: the encoder below is the binary serializer's
 * Array/Integer/ByteString form, matching the core's `StdLib.Deserialize` of
 * the signature field.
 *
 * Dependency-light by design: sha256 is injected, and the hex helpers come
 * from metaTxCore.mjs, so the SDK and the wallet frontend encode identical
 * bytes.
 */

import { sanitizeHex, reverseHex } from './metaTxCore.mjs';

export const THRESHOLD_MAX_MEMBERS = 10;
export const THRESHOLD_MEMBER_DOMAIN = 'NeoSmartAccount/ThresholdMember';
export const THRESHOLD_PROTOCOL_VERSION = 4;

const MAX_BUNDLE_BYTES = 65535;
const UINT64_MAX = (1n << 64n) - 1n;
const error = (message) => {
  throw new Error(`Threshold: ${message}`);
};
const hex = (value) => sanitizeHex(value);

function contractHash(value, label) {
  const normalized = hex(value);
  if (!/^[0-9a-f]{40}$/.test(normalized) || /^0+$/.test(normalized)) {
    error(`invalid ${label} hash`);
  }
  return normalized;
}

function uint64(value, label) {
  let integer;
  try {
    integer = BigInt(value);
  } catch {
    error(`${label} must be an integer`);
  }
  if (integer < 0n || integer > UINT64_MAX) error(`${label} outside uint64`);
  return integer;
}

function varInt(value) {
  if (value < 0xfd) return value.toString(16).padStart(2, '0');
  if (value <= 0xffff) {
    return `fd${(value & 255).toString(16).padStart(2, '0')}${((value >> 8) & 255).toString(16).padStart(2, '0')}`;
  }
  return `fe${[0, 8, 16, 24].map((shift) => ((value >> shift) & 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Neo StdLib.Serialize Integer: varint length + little-endian two's complement. */
function serializeInteger(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) error('invalid integer');
  const bytes = [];
  while (remaining > 0n) {
    bytes.push(Number(remaining & 255n));
    remaining >>= 8n;
  }
  if (bytes.length > 0 && (bytes[bytes.length - 1] & 0x80) !== 0) bytes.push(0);
  return `21${varInt(bytes.length)}${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Neo StdLib.Serialize of an Array of [memberModuleId, signature] pairs — the
 * v4 threshold-policy signature field. The core requires strictly ascending
 * member ids and 64-byte member signatures, so the encoder refuses any other
 * shape instead of letting the chain reject it.
 */
export function serializeMemberSignatures(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > THRESHOLD_MAX_MEMBERS) {
    error(`expected 1 to ${THRESHOLD_MAX_MEMBERS} member signature entries`);
  }
  let result = `40${varInt(entries.length)}`;
  let previous = 0n;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) error('member signature entry must be [memberId, signature]');
    const memberId = uint64(entry[0], 'member id');
    if (memberId <= previous) error('member ids must be strictly ascending positive integers');
    previous = memberId;
    const bytes = hex(entry[1]);
    if (!/^(?:[0-9a-f]{2})*$/.test(bytes) || bytes.length !== 128) {
      error('member signature must be 64 bytes of hex');
    }
    result += `4002${serializeInteger(memberId)}28${varInt(bytes.length / 2)}${bytes}`;
    if (result.length / 2 > MAX_BUNDLE_BYTES) error('member signature list exceeds 65535 bytes');
  }
  return result;
}

/** JSON-RPC ByteArray values are base64, while draft/SDK parameters carry hex. */
export function toMultiSigRpcParameter(parameter) {
  if (!parameter || typeof parameter !== 'object') error('invalid RPC parameter');
  if (parameter.type === 'Array' || parameter.type === 'Struct') {
    if (!Array.isArray(parameter.value)) error('invalid RPC array');
    return { type: 'Array', value: parameter.value.map(toMultiSigRpcParameter) };
  }
  if (parameter.type === 'ByteArray') {
    const bytes = hex(parameter.value);
    if (!/^(?:[0-9a-f]{2})*$/.test(bytes)) error('invalid RPC bytes');
    const binary = (bytes.match(/../g) || [])
      .map((pair) => String.fromCharCode(parseInt(pair, 16)))
      .join('');
    return { type: 'ByteArray', value: globalThis.btoa(binary) };
  }
  if (parameter.type === 'Map') {
    return {
      type: 'Map',
      value: parameter.value.map((entry) => ({
        key: toMultiSigRpcParameter(entry.key),
        value: toMultiSigRpcParameter(entry.value),
      })),
    };
  }
  return { ...parameter };
}

function u64be(value) {
  return BigInt(value).toString(16).padStart(16, '0');
}

function utf8Hex(value) {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeMembers(members, label) {
  if (!Array.isArray(members) || members.length < 1 || members.length > THRESHOLD_MAX_MEMBERS) {
    error(`${label} requires 1 to ${THRESHOLD_MAX_MEMBERS} entries`);
  }
  const seen = new Set();
  let previous = 0n;
  return members.map((member) => {
    const moduleId = uint64(member?.moduleId, 'member module id');
    if (moduleId <= previous) error('member module ids must be strictly ascending');
    previous = moduleId;
    if (seen.has(moduleId.toString())) error('duplicate member module id');
    seen.add(moduleId.toString());
    return { ...member, moduleId };
  });
}

/**
 * Creates the v4 threshold tools with an injected sha256.
 *
 * @param {Object} options
 * @param {Function} options.sha256 - sha256(hexBytes) returning 32 hex characters
 */
export function createThresholdTools({ sha256 } = {}) {
  if (typeof sha256 !== 'function') {
    throw new TypeError('createThresholdTools requires a sha256(hex) implementation');
  }
  const sha = (value) => {
    const digest = sanitizeHex(sha256(value));
    if (!/^[0-9a-f]{64}$/.test(digest)) error('sha256 returned a malformed digest');
    return digest;
  };

  /** §5 member digest for one member instance. */
  function memberDigest(operationDigest, moduleId, credentialGeneration) {
    const digest = hex(operationDigest);
    if (!/^[0-9a-f]{64}$/.test(digest)) error('operation digest must be 32 bytes');
    const preimage = [
      utf8Hex(THRESHOLD_MEMBER_DOMAIN),
      THRESHOLD_PROTOCOL_VERSION.toString(16).padStart(2, '0'),
      digest,
      u64be(uint64(moduleId, 'member module id')),
      u64be(uint64(credentialGeneration, 'member credential generation')),
    ].join('');
    return sha(preimage);
  }

  /**
   * Digest each member should sign. Members are `{ moduleId,
   * credentialGeneration }`, both read from the core for the current account.
   */
  function prepareMembers({ operationDigest, members } = {}) {
    const normalized = normalizeMembers(members, 'threshold preparation');
    return Object.freeze(
      normalized.map((member) =>
        Object.freeze({
          moduleId: member.moduleId.toString(),
          credentialGeneration: uint64(member.credentialGeneration, 'member credential generation').toString(),
          digest: memberDigest(operationDigest, member.moduleId, member.credentialGeneration),
        }),
      ),
    );
  }

  /**
   * Assemble the signature field from signed members. `members` entries carry
   * `moduleId` and a 64-byte `signature` over that member's digest.
   */
  function assembleSignature({ members } = {}) {
    const normalized = normalizeMembers(members, 'threshold assembly');
    const entries = normalized.map((member) => {
      const signature = hex(member.signature);
      if (!/^[0-9a-f]{128}$/.test(signature)) error('member signature must be 64 bytes');
      return [member.moduleId, signature];
    });
    return serializeMemberSignatures(entries);
  }

  /**
   * Assemble a threshold-routed operation signature: the serialized member list
   * that goes into field 11 of the 13-field operation.
   */
  function assembleOperationSignature({ operationDigest, members } = {}) {
    const prepared = prepareMembers({ operationDigest, members });
    const signed = members.map((member) => {
      const signature = hex(member.signature);
      if (!/^[0-9a-f]{128}$/.test(signature)) error('member signature must be 64 bytes');
      return { moduleId: member.moduleId, signature };
    });
    return Object.freeze({
      signatureHex: assembleSignature({ members: signed }),
      members: prepared,
    });
  }

  return Object.freeze({
    memberDigest,
    prepareMembers,
    assembleSignature,
    assembleOperationSignature,
  });
}

/** Stored (little-endian UInt160) form of a display hash, for raw script bytes. */
export function toChainHashHex(value) {
  return reverseHex(contractHash(value, 'hash'));
}
