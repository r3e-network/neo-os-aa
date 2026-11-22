#!/usr/bin/env python3
"""Independent (non-C#, non-C++/native) derivation of the SA module-protocol v4
golden vectors consumed by the native kernel.

Everything here is written from docs/SA-MODULE-PROTOCOL.md only: the §16.1
account identity, the §4.2 thirteen-field operation envelope and its NeoVM
binary serialisation, the §4.3 operation digest domain, the §6 nonce channel
derivation, and the §7.1 storage-key table. If the kernel and this script
disagree, one of them is wrong.

The kernel mixes its own core hash and network magic into every digest
(§4.3, §8, §6), so those digests are pinned under `expected.native`; the
kernel-independent parts (account identity, the canonical operation bytes, the
key table) are pinned once. Pre-consolidation copies of these files also carry
an `expected.custom` lane for the retired custom kernel; that lane is gone with
the kernel, and nothing in this repository produces or checks it.

Run with:
    python tests/fixtures/sa-module-protocol/generate-vectors.py
"""

import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))

# ---------------------------------------------------------------------------
# Pinned environment of the kernel under test.
#
#   native — SmartAccountProtocol.ServiceHash, a compile-time constant of the
#            native runtime. The retired custom kernel's core hash and magic
#            (#39 / 0x334F454E) are no longer pinned: that user-contract tree was
#            removed when the repository went native-only, so a "custom" lane
#            would attest a kernel nothing in the tree can still execute.
# ---------------------------------------------------------------------------
KERNELS = {
    "native": {
        "coreHash": "0x398dc3f0227d7efac5533ed5ce9937390c158084",
        "network": 0x12345678,  # UT_SmartAccountProtocol.Network
    },
}

# Shared fixture identity: custody + salt -> accountId (§16.1). These are the
# same inputs the native vector file pins, so one account id is asserted by
# every kernel.
CUSTODY = "0x202122232425262728292a2b2c2d2e2f30313233"
SALT = bytes.fromhex("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f")
NONCE_SUBKEY = bytes(32)
# Any non-empty signature is legal on the wire; the canonical unsigned form
# always replaces it with the empty ByteString (§4.2). Fixed test material,
# never a real key.
SIGNATURE = bytes.fromhex("11" * 64)

ACCOUNT_IDENTITY_DOMAIN = bytes.fromhex("aa524704")
USER_OPERATION_DOMAIN = b"NeoSmartAccount/UserOperation"

DEADLINE = 1_700_000_000_000


# ---------------------------------------------------------------------------
# Encoding helpers
# ---------------------------------------------------------------------------
def display_to_raw(display):
    """A UInt160 display string is the big-endian form of the hash; the in-VM
    byte array (IByteSerializable / ToArray) is the byte reversal."""
    return bytes(reversed(bytes.fromhex(display.removeprefix("0x"))))


def raw_to_display(raw):
    return "0x" + bytes(reversed(raw)).hex()


def hash160(data):
    return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()


def u64be(value):
    return value.to_bytes(8, "big")


def var_int(value):
    if value < 0xFD:
        return bytes([value])
    if value <= 0xFFFF:
        return bytes([0xFD]) + value.to_bytes(2, "little")
    if value <= 0xFFFFFFFF:
        return bytes([0xFE]) + value.to_bytes(4, "little")
    return bytes([0xFF]) + value.to_bytes(8, "little")


def serialize_integer(value):
    if value == 0:
        payload = b""
    else:
        length = (value.bit_length() + 8) // 8
        payload = value.to_bytes(length, "little", signed=True).rstrip(b"\x00")
        if not payload:
            payload = b"\x00"
        if payload[-1] & 0x80:
            payload += b"\x00"
    return bytes([0x21]) + var_int(len(payload)) + payload


def serialize_bytes(data):
    return bytes([0x28]) + var_int(len(data)) + data


def serialize_array(items):
    return bytes([0x40]) + var_int(len(items)) + b"".join(items)


# ---------------------------------------------------------------------------
# §16.1 account identity
# ---------------------------------------------------------------------------
def account_id(custody_raw, salt):
    return bytes(reversed(hash160(ACCOUNT_IDENTITY_DOMAIN + custody_raw + salt)))


# ---------------------------------------------------------------------------
# §4.2 operation envelope and §4.3 digest
# ---------------------------------------------------------------------------
def operation(target, method, args, nonce, nonce_subkey, deadline, validator_id,
              credential_generation, authority_epoch, configuration_nonce,
              signature, hook_proofs):
    """The canonical thirteen-field operation: signature blanked."""
    return serialize_array([
        serialize_integer(4),
        serialize_bytes(target),
        serialize_bytes(method.encode("utf-8")),
        serialize_array(args),
        serialize_integer(nonce),
        serialize_bytes(nonce_subkey),
        serialize_integer(deadline),
        serialize_integer(validator_id),
        serialize_integer(credential_generation),
        serialize_integer(authority_epoch),
        serialize_integer(configuration_nonce),
        serialize_bytes(b""),  # §4.2: the signature is never signed
        serialize_array(hook_proofs),
    ])


def operation_digest(canonical, account, kernel):
    k = KERNELS[kernel]
    domain = (
        USER_OPERATION_DOMAIN
        + bytes([4])
        + k["network"].to_bytes(4, "little")
        + display_to_raw(k["coreHash"])
        + account
        + u64be(0)   # validatorId
        + u64be(1)   # credentialGeneration
        + u64be(1)   # authorityEpoch
        + u64be(0)   # configurationNonce
    )
    return domain, hashlib.sha256(domain + canonical).digest()


# ---------------------------------------------------------------------------
# §6 nonce channel
# ---------------------------------------------------------------------------
def nonce_channel(account, authority_epoch, validator_id, credential_generation,
                  nonce_subkey, kernel):
    k = KERNELS[kernel]
    preimage = (
        bytes([4])
        + display_to_raw(k["coreHash"])
        + account
        + u64be(authority_epoch)
        + u64be(validator_id)
        + u64be(credential_generation)
        + nonce_subkey
    )
    digest = hashlib.sha256(preimage).digest()
    channel = bytes([digest[8] & 0x7F]) + digest[9:32]
    return preimage, digest, channel


# ---------------------------------------------------------------------------
# §7.1 storage keys
# ---------------------------------------------------------------------------
def storage_keys(account, channel):
    return {
        "0x50": "50",
        "0x51": "51" + account.hex(),
        "0x52": "52" + account.hex() + u64be(1).hex(),
        "0x53": "53" + account.hex() + "01" + u64be(1).hex(),
        "0x54": "54" + account.hex(),
        "0x55": "55" + account.hex() + u64be(1).hex(),
        "0x56": "56" + account.hex() + channel.hex(),
        "0x57": "57" + account.hex(),
        "0x58": "58" + account.hex(),
        "0x59": "59" + account.hex(),
        "0x5A": "5a" + account.hex(),
        "0x5B": "5b" + account.hex() + u64be(1).hex(),
        "0x5C": "5c" + account.hex() + channel.hex(),
        "0x5D": "5d" + account.hex(),
        "0x5E": "5e" + account.hex(),
    }


# ---------------------------------------------------------------------------
# Emitters
# ---------------------------------------------------------------------------
def write(name, payload):
    path = os.path.join(HERE, "golden-vectors", name)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print("wrote", os.path.relpath(path, REPO))


def build_operation_envelope(custody_raw, account):
    target = display_to_raw(KERNELS["native"]["coreHash"])
    canonical_integer = operation(
        target=target, method="transfer",
        args=[serialize_bytes(bytes(32)), serialize_integer(1)],
        nonce=0, nonce_subkey=NONCE_SUBKEY, deadline=DEADLINE,
        validator_id=0, credential_generation=1, authority_epoch=1,
        configuration_nonce=0, signature=SIGNATURE, hook_proofs=[])
    # The canonical form blanks field 11, so the signed shape above and the
    # published unsigned bytes are the same bytes.
    expected = {
        "canonicalUnsignedOperationHex": canonical_integer.hex(),
        "equality": {
            "customStdLibSerializeHex": canonical_integer.hex(),
            "nativeBinarySerializerHex": canonical_integer.hex(),
        },
    }
    for kernel in ("native",):
        domain, digest = operation_digest(canonical_integer, account, kernel)
        expected[kernel] = {
            "coreHash": KERNELS[kernel]["coreHash"],
            "network": KERNELS[kernel]["network"],
            "domainHex": domain.hex(),
            "digestHex": digest.hex(),
        }
    payload = {
        "vectorId": "sa4-operation-envelope",
        "kind": "operation-envelope",
        "constantsRevision": {
            "native": read_blob_sha("contracts/native/SmartAccount/SmartAccountModuleProtocol.cs"),
        },
        "input": {
            "custody": CUSTODY,
            "salt": SALT.hex(),
            "accountId": raw_to_display(account),
            "operation": {
                "version": 4,
                "target": raw_to_display(target),
                "method": "transfer",
                "args": [bytes(32).hex(), 1],
                "nonce": 0,
                "nonceSubkey": NONCE_SUBKEY.hex(),
                "deadline": DEADLINE,
                "validatorId": 0,
                "credentialGeneration": 1,
                "authorityEpoch": 1,
                "configurationNonce": 0,
                "signature": SIGNATURE.hex(),
                "hookProofs": [],
            },
        },
        "expected": expected,
        "notes": (
            "One account, one operation, two kernels. The canonical bytes are kernel "
            "independent; the digests differ because each kernel mixes its own core hash "
            "and chain magic into the §4.3 domain."
        ),
    }
    write("operation-envelope.json", payload)


def build_nonce_channel(account):
    expected = {}
    for kernel in ("native",):
        preimage, digest, channel = nonce_channel(account, 1, 0, 1, NONCE_SUBKEY, kernel)
        expected[kernel] = {
            "coreHash": KERNELS[kernel]["coreHash"],
            "derivationPreimageHex": preimage.hex(),
            "fullDigestHex": digest.hex(),
            "channelBytesHex": channel.hex(),
            "nonceCursorKeyBytes": ("56" + account.hex() + channel.hex()),
            "nonceNamespaceKeyBytes": ("5c" + account.hex() + channel.hex()),
            "packedNonce": str(int.from_bytes(channel, "big") << 64),
            "packedNonceHex": "0x" + (int.from_bytes(channel, "big") << 64).to_bytes(32, "big").hex(),
        }
    payload = {
        "vectorId": "sa4-nonce-channel",
        "kind": "nonce-channel",
        "constantsRevision": {
            "native": read_blob_sha("contracts/native/SmartAccount/SmartAccountModuleProtocol.cs"),
        },
        "input": {
            "accountId": raw_to_display(account),
            "nonceSubkey": NONCE_SUBKEY.hex(),
            "authorityEpoch": 1,
            "validatorId": 0,
            "credentialGeneration": 1,
            "newCursor": 1,
            "legacyCursorSameChannel": 0,
        },
        "expected": expected,
        "mergedCursor": 1,
        "exhaustionSentinel": str(1 << 64),
        "notes": (
            "Channel := low 191 bits of SHA256(U1(4) || coreHash || accountId || "
            "U64BE(authorityEpoch) || U64BE(validatorId) || U64BE(credentialGeneration) || "
            "nonceSubkey), 24 bytes right-aligned big-endian with the top bit of the first "
            "byte clear (191 bits). "
            "getNonce returns (channel << 64) | sequence; the vector pins sequence 0."
        ),
    }
    write("nonce-channel.json", payload)


def build_storage_keys(account):
    _, _, channel = nonce_channel(account, 1, 0, 1, NONCE_SUBKEY, "native")
    payload = {
        "vectorId": "sa4-storage-keys",
        "kind": "storage-key",
        "constantsRevision": {
            "native": read_blob_sha("contracts/native/SmartAccount/SmartAccountModuleProtocol.cs"),
        },
        "input": {
            "accountId": raw_to_display(account),
            "moduleId": 1,
            "moduleType": 1,
            "intentId": 1,
            "policyId": 1,
            "channelBytesHex": channel.hex(),
        },
        "expected": {
            "keys": storage_keys(account, channel),
            "lengths": {
                "0x50": 1, "0x51": 21, "0x52": 29, "0x53": 30, "0x54": 21,
                "0x55": 29, "0x56": 45, "0x57": 21, "0x58": 21, "0x59": 21,
                "0x5A": 21, "0x5B": 29, "0x5C": 45, "0x5D": 21, "0x5E": 21,
            },
            "moduleTypeCodes": {"validator": 1, "hook": 4},
        },
        "notes": (
            "The §7.1 key table, byte for byte. Account bytes are the raw UInt160 "
            "bytes and every integer suffix is fixed-width big-endian, so the same "
            "key builder produces the same key in both kernels. 0x5F is reserved and "
            "never produced."
        ),
    }
    write("storage-keys.json", payload)


# ---------------------------------------------------------------------------
# §8 message signatures (ERC-1271)
#
# The fixed test key is the one the native fixture already seeds custody with
# (0x11 repeated 32 times). It is fixture material, never wallet material: the
# point, the canonical script and the signature are all published here.
# ---------------------------------------------------------------------------
MESSAGE_SECRET = int.from_bytes(bytes.fromhex("11" * 32), "big")
MESSAGE_SALT = bytes(32)
MESSAGE_HASH = bytes.fromhex("5a" * 32)
MESSAGE_DOMAIN = b"NeoSmartAccount/Message"
CHECK_SIG_SYSCALL = bytes.fromhex("56e7b327")
MESSAGE_NETWORK = 0x334F454E  # TestProtocolSettings.Default — both live harnesses
MESSAGE_VALIDATOR_ID = 0
MESSAGE_CREDENTIAL_GENERATION = 1
MESSAGE_AUTHORITY_EPOCH = 1
MESSAGE_THRESHOLD = 1

SUCCESS_MAGIC = "1626ba7e"
FAILURE_MAGIC = "ffffffff"

# Calling-script hash of each fixture's forwarder. These are harness
# properties, not kernel outputs: the custom fixture submits the envelope
# through the MockVerifierCore stub, the native fixture through a script-hash
# contract built from FORWARDER_SCRIPT_NATIVE. The domain binds that hash, so
# it has to be published; both consumers assert their own forwarder against the
# pin, and a harness change therefore fails loudly instead of silently
# re-pinning the domain.
MESSAGE_SENDER = {
    "native": "0x53773c391326e97bab5daae2764e0739e083eaf1",
}

# The exact bytes the native fixture's forwarder emits:
#   INITSLOT 0,3 | LDARG2 LDARG1 LDARG0 | PUSH3 PACK | PUSH1 (ReadStates)
#   PUSHDATA1 16 "isValidSignature" | PUSHDATA1 20 <core> | SYSCALL Call | RET
FORWARDER_SCRIPT_NATIVE = (
    "5700037a797813c0110c10697356616c69645369676e61747572650c14"
    "8480150c393799ced53e53c5fa7e7d22f0c38d3941627d5b5240"
)

# secp256r1 (SEC 2 / FIPS 186-4 P-256).
_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_A = _P - 3
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)


def _point_add(left, right):
    if left is None:
        return right
    if right is None:
        return left
    x1, y1 = left
    x2, y2 = right
    if x1 == x2 and (y1 + y2) % _P == 0:
        return None
    if left == right:
        slope = (3 * x1 * x1 + _A) * pow(2 * y1, _P - 2, _P) % _P
    else:
        slope = (y2 - y1) * pow(x2 - x1, _P - 2, _P) % _P
    x3 = (slope * slope - x1 - x2) % _P
    return x3, (slope * (x1 - x3) - y1) % _P


def _point_mul(scalar, point):
    result = None
    addend = point
    while scalar:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        scalar >>= 1
    return result


def compressed_point(scalar):
    x, y = _point_mul(scalar, _G)
    return bytes([0x03 if y & 1 else 0x02]) + x.to_bytes(32, "big")


def canonical_p256_script(point):
    """The N3 wallet script shape the core accepts, byte for byte."""
    return b"\x0c\x21" + point + b"\x41" + CHECK_SIG_SYSCALL


def rfc6979_nonce(secret, digest):
    """Deterministic k (RFC 6979 §3.2, HMAC-SHA256), so the vector is stable."""
    import hmac

    order_bytes = (secret).to_bytes(32, "big")
    hash_bytes = (int.from_bytes(digest, "big") % _N).to_bytes(32, "big")
    v = b"\x01" * 32
    k = b"\x00" * 32
    k = hmac.new(k, v + b"\x00" + order_bytes + hash_bytes, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + order_bytes + hash_bytes, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        candidate = int.from_bytes(v, "big")
        if 1 <= candidate < _N:
            return candidate
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


def ecdsa_sign(secret, payload):
    """IEEE P1363 r||s over SHA-256(payload), low-s normalised.

    The payload is the §8 message digest; SHA-256 is applied here because both
    kernels verify with the `secp256r1SHA256` curve/hash pair, which hashes the
    message it is handed.
    """
    digest = hashlib.sha256(payload).digest()
    z = int.from_bytes(digest, "big")
    nonce = rfc6979_nonce(secret, digest)
    r = _point_mul(nonce, _G)[0] % _N
    s = (pow(nonce, _N - 2, _N) * (z + r * secret)) % _N
    if s > _N // 2:
        s = _N - s
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def ecdsa_verify(point, payload, signature):
    digest = hashlib.sha256(payload).digest()
    z = int.from_bytes(digest, "big")
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    if not (1 <= r < _N and 1 <= s < _N):
        return False
    w = pow(s, _N - 2, _N)
    candidate = _point_add(_point_mul(z * w % _N, _G), _point_mul(r * w % _N, point))
    return candidate is not None and candidate[0] % _N == r


def message_domain(account, sender, kernel):
    return (
        MESSAGE_DOMAIN
        + bytes([4])
        + MESSAGE_NETWORK.to_bytes(4, "little")
        + display_to_raw(KERNELS[kernel]["coreHash"])
        + account
        + display_to_raw(sender)
        + u64be(MESSAGE_VALIDATOR_ID)
        + u64be(MESSAGE_CREDENTIAL_GENERATION)
        + u64be(MESSAGE_AUTHORITY_EPOCH)
    )


def build_message_envelope(account):
    point = compressed_point(MESSAGE_SECRET)
    script = canonical_p256_script(point)

    # Self-checks: the published forwarder hash must be the hash of the
    # published forwarder bytes, and the published signature must verify under
    # the published point. Both catch a transcription slip before a test does.
    if raw_to_display(hash160(bytes.fromhex(FORWARDER_SCRIPT_NATIVE))) != MESSAGE_SENDER["native"]:
        raise SystemExit("native forwarder script and pinned caller hash disagree")

    expected = {
        "messageDomainPrefixHex": MESSAGE_DOMAIN.hex(),
        "versionByte": 4,
        "successMagicHex": SUCCESS_MAGIC,
        "failureMagicHex": FAILURE_MAGIC,
    }
    for kernel in ("native",):
        sender = MESSAGE_SENDER[kernel]
        domain = message_domain(account, sender, kernel)
        digest = hashlib.sha256(domain + MESSAGE_HASH).digest()
        signature = ecdsa_sign(MESSAGE_SECRET, digest)
        if not ecdsa_verify(_point_mul(MESSAGE_SECRET, _G), digest, signature):
            raise SystemExit("generated message signature does not verify")
        expected[kernel] = {
            "coreHash": KERNELS[kernel]["coreHash"],
            "network": MESSAGE_NETWORK,
            "originalSender": sender,
            "messageDomainHex": domain.hex(),
            "messageDigestHex": digest.hex(),
            "signatureHex": signature.hex(),
            "signaturePairs": [[script.hex(), signature.hex()]],
        }
        if kernel == "native":
            # The fixture publishes its caller script so the native consumer can
            # assert the bytes it deploys, not just the hash of them.
            expected[kernel]["forwarderScriptHex"] = FORWARDER_SCRIPT_NATIVE

    payload = {
        "vectorId": "sa4-message-envelope",
        "kind": "message-envelope",
        "constantsRevision": {
            "native": read_blob_sha("contracts/native/SmartAccount/SmartAccountModuleProtocol.cs"),
        },
        "input": {
            "custody": raw_to_display(hash160(script)),
            "salt": MESSAGE_SALT.hex(),
            "accountId": raw_to_display(account),
            "verificationScript": script.hex(),
            "messageHash": MESSAGE_HASH.hex(),
            "envelopeVersion": 4,
            "validatorId": MESSAGE_VALIDATOR_ID,
            "credentialGeneration": MESSAGE_CREDENTIAL_GENERATION,
            "authorityEpoch": MESSAGE_AUTHORITY_EPOCH,
            "threshold": MESSAGE_THRESHOLD,
            "thresholdVariant": 3,
            "network": MESSAGE_NETWORK,
        },
        "expected": expected,
        "rejections": [
            {"mutation": "messageHash differs from the signed digest",
             "error": "SA_MESSAGE_INVALID"},
            {"mutation": "duplicate verification script in one envelope",
             "error": "SA_MESSAGE_INVALID"},
            {"mutation": "non-canonical or off-curve verification script",
             "error": "SA_MESSAGE_INVALID"},
            {"mutation": "signature count below the 0x57 threshold",
             "error": "SA_MESSAGE_INVALID"},
            {"mutation": "validatorId of a module without messageCapability",
             "error": "SA_MODULE_MESSAGE_CAPABILITY_ABSENT"},
            {"mutation": "stale credentialGeneration against the 0x57 subjectRevision",
             "error": "SA_CREDENTIAL_STALE"},
            {"mutation": "contract custody passes CheckWitness but holds no subject script",
             "error": "SA_MESSAGE_INVALID"},
            {"mutation": "frozen account",
             "error": "SA_MESSAGE_INVALID"},
        ],
        "notes": (
            "ERC-1271 is a magic-value surface, never a throw surface: every row above "
            "returns 0xffffffff. The vector therefore pins the two magics plus, per kernel, "
            "the digest and the deterministic RFC 6979 signature over it. The digest binds "
            "the calling script hash, so each kernel is exercised through its own forwarder "
            "and the two signatures differ by construction."
        ),
    }
    write("message-envelope.json", payload)


# ---------------------------------------------------------------------------
# §14 per-account migration acceptance (M-1..M-6)
#
# A legacy account is a 0x01 five-field row (Verifier, HookId, BackupOwner,
# EscapeTimelock, EscapeTriggeredAt) with no 0x51 control record. The vector
# pins the state machine a keeper + owner drive after the in-place core update
# opens migration mode: 0x50 {version, open}, then 0x5A status 1 at the keeper
# mark, then 0x5A status 2 at the owner's 24h import intent.
# ---------------------------------------------------------------------------
MIGRATION_BACKUP_OWNER = "0x" + "51" * 20
MIGRATION_VERIFIER = "0x" + "66" * 20
MIGRATION_SALT = bytes.fromhex("62" * 32)
MIGRATION_ESCAPE_TIMELOCK_SECONDS = 30 * 24 * 60 * 60
MIGRATION_MANIFEST_DIGEST = bytes.fromhex("aa" * 32)
MIGRATION_SECOND_DIGEST = bytes.fromhex("bb" * 32)


def build_migration():
    account = account_id(display_to_raw(MIGRATION_BACKUP_OWNER), MIGRATION_SALT)
    payload = {
        "vectorId": "sa4-migration",
        "kind": "migration",
        "constantsRevision": {
            "native": read_blob_sha("contracts/native/SmartAccount/SmartAccountModuleProtocol.cs"),
        },
        "input": {
            "accountId": raw_to_display(account),
            "salt": MIGRATION_SALT.hex(),
            "backupOwner": MIGRATION_BACKUP_OWNER,
            "legacyRow": {
                "verifier": MIGRATION_VERIFIER,
                "hookId": "0x" + "00" * 20,
                "backupOwner": MIGRATION_BACKUP_OWNER,
                "escapeTimelockSeconds": MIGRATION_ESCAPE_TIMELOCK_SECONDS,
                "escapeTriggeredAt": 0,
            },
            "protocolRecord": [4, True],
            "manifestDigest": MIGRATION_MANIFEST_DIGEST.hex(),
            "secondManifestDigest": MIGRATION_SECOND_DIGEST.hex(),
            "classification": "no-plugin",
            "ownerOnlyClassification": "owner-only",
            "unknownClassification": "unknown-plugin",
        },
        "expected": {
            # Status codes are the public ABI's: getAccount status 0 Active /
            # 2 MigrationRequired; getMigrationState status 0 none / 1 required
            # / 2 imported.
            "inertBeforeUpdate": {"migrationRequired": False, "accountStatus": 2},
            "unmarked": {"migrationRequired": True, "accountStatus": 2,
                         "migrationRecordStatus": 0, "legacyModuleCount": 1},
            "executionWhileUnmigratedError": "SA_MIGRATION_REQUIRED",
            "markWhileModeClosedError": "SA_MIGRATION_REQUIRED",
            "marked": {"accountStatus": 2, "migrationRecordStatus": 1,
                       "legacyModuleCount": 1, "legacyScopeInvalidated": True},
            "imported": {"accountStatus": 0, "migrationRecordStatus": 2,
                         "legacyScopeInvalidated": True,
                         "legacyModuleCount": 1,
                         "defaultOperationAuthorization": True,
                         "defaultMessageAuthorization": True},
            "ownerOnly": {"accountStatus": 0, "ownerOnlyRecovery": True,
                          "defaultOperationAuthorization": True},
            "unknownClassificationError": "SA_MIGRATION_REQUIRED",
            "differentDigestReplayError": "SA_OPERATION_MALFORMED",
            "epochAndNonceMonotonic": True,
            "events": {"required": "MigrationRequired", "imported": "MigrationImported"},
        },
        "matrix": [
            {"id": "M-1", "status": "pinned",
             "covers": "five-field legacy row decoded as migration input, 0x01 row kept "
                       "as evidence, inert until the migration mode opens"},
            {"id": "M-1", "status": "notPinned",
             "covers": "the 53/407 real account exports and the native 14-slot legacy "
                       "decoder: no such export data exists in this repository"},
            {"id": "M-2", "status": "notPinned",
             "covers": "MultiHook order / MultiSig threshold preservation: legacy module "
                       "ids have no v4 instance to map them onto without a real export"},
            {"id": "M-3", "status": "pinned",
             "covers": "authorityEpoch / configurationNonce never decrease across "
                       "materialization and import"},
            {"id": "M-4", "status": "pinned",
             "covers": "legacyScopeInvalidated is declared at the mark and stays declared "
                       "after the import; retirement is a declaration, never authorization"},
            {"id": "M-5", "status": "pinned",
             "covers": "owner-only import carries OwnerOnlyRecovery forward"},
            {"id": "M-5", "status": "notPinned",
             "covers": "market-locked and recovery-pending imports need a legacy escrow / "
                       "in-flight escape to exist first"},
            {"id": "M-6", "status": "pinned",
             "covers": "repeated identical (accountId, manifestDigest) import is a no-op, a "
                       "different digest is rejected, and an unmigrated account executes "
                       "nothing"},
        ],
        "notes": (
            "The fixture seeds the post-update 0x50 {4, true} record instead of replaying a "
            "ContractManagement update: the update path writes exactly this record and "
            "nothing else (spec §14), so the seeded state is the state an update leaves."
        ),
    }
    write("migration.json", payload)


def read_blob_sha(relative):
    import subprocess
    return subprocess.check_output(
        ["git", "hash-object", relative], cwd=REPO).decode().strip()


def main():
    custody_raw = display_to_raw(CUSTODY)
    account = account_id(custody_raw, SALT)
    build_operation_envelope(custody_raw, account)
    build_nonce_channel(account)
    build_storage_keys(account)
    message_account = account_id(
        display_to_raw(raw_to_display(hash160(canonical_p256_script(compressed_point(MESSAGE_SECRET))))),
        MESSAGE_SALT)
    build_message_envelope(message_account)
    build_migration()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
