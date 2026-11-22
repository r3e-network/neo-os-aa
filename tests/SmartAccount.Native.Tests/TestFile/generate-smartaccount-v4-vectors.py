#!/usr/bin/env python3
"""Independent (non-C#) derivation of the SA module protocol v4 vectors that
UT_SmartAccountProtocol / UT_SmartAccountEnvelope pin against.

Everything here is written from docs/SA-MODULE-PROTOCOL.md only: the account
identity domain, the thirteen-field operation envelope, the NeoVM binary
serialisation of the canonical operation and the §4.3 digest domain. If the
kernel and this script disagree, one of them is wrong.

Run with: python tests/SmartAccount.Native.Tests/TestFile/generate-smartaccount-v4-vectors.py
"""

import hashlib
import json
import sys

# Service hash of the SmartAccount native core: Helper.GetContractHash(0, 0, "SmartAccount").
# It is a compile-time constant of the runtime, so it is pinned here instead of recomputed.
SERVICE_HASH_DISPLAY = "0x398dc3f0227d7efac5533ed5ce9937390c158084"
NETWORK = 0x12345678

ACCOUNT_IDENTITY_DOMAIN = bytes.fromhex("aa524704")  # §16.1 v4 identity domain
USER_OPERATION_DOMAIN = b"NeoSmartAccount/UserOperation"

CUSTODY_DISPLAY = "0x202122232425262728292a2b2c2d2e2f30313233"
SALT = bytes.fromhex("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f")
NONCE_SUBKEY = bytes(32)
# Any non-empty signature is legal on the wire; the canonical unsigned form
# always replaces it with the empty ByteString (§4.2).
SIGNATURE = bytes.fromhex("11" * 64)


def display_to_le(display: str) -> bytes:
    """A UInt160 display string is the big-endian form of the hash; the in-VM
    representation (IByteSerializable / ToArray) is the byte reversal."""
    return bytes(reversed(bytes.fromhex(display.removeprefix("0x"))))


def le_to_display(raw: bytes) -> str:
    return "0x" + bytes(reversed(raw)).hex()


def hash160(data: bytes) -> bytes:
    return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()


SERVICE_HASH = display_to_le(SERVICE_HASH_DISPLAY)


def account_id(custody_le: bytes, salt: bytes) -> bytes:
    payload = ACCOUNT_IDENTITY_DOMAIN + custody_le + salt
    digest = hash160(payload)
    # The kernel reverses the digest into raw UInt160 storage, so the display
    # form of the id is the digest itself.
    return bytes(reversed(digest))


def push_zero(data: bytes) -> bytes:
    """NeoVM PUSHDATA encoding used by ScriptBuilder.EmitPush(byte[])."""
    if len(data) < 0x100:
        return bytes([0x0C, len(data)]) + data
    if len(data) < 0x10000:
        return bytes([0x0D]) + len(data).to_bytes(2, "little") + data
    return bytes([0x0E]) + len(data).to_bytes(4, "little") + data


SYSCALL_CONTRACT_CALL = bytes.fromhex("41627d5b52")


def verification_script(account: bytes) -> bytes:
    """PUSHDATA1 20 accountId, PUSH1 PACK PUSH5 (args=[accountId], flags=ReadOnly),
    PUSHDATA1 6 "verify", PUSHDATA1 20 core, SYSCALL System.Contract.Call."""
    return (
        push_zero(account)
        + bytes([0x11, 0xC0, 0x15])
        + push_zero(b"verify")
        + push_zero(SERVICE_HASH)
        + SYSCALL_CONTRACT_CALL
    )

def var_int(value: int) -> bytes:
    if value < 0xFD:
        return bytes([value])
    if value <= 0xFFFF:
        return bytes([0xFD]) + value.to_bytes(2, "little")
    if value <= 0xFFFFFFFF:
        return bytes([0xFE]) + value.to_bytes(4, "little")
    return bytes([0xFF]) + value.to_bytes(8, "little")


def serialize_integer(value: int) -> bytes:
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


def serialize_bytes(data: bytes) -> bytes:
    return bytes([0x28]) + var_int(len(data)) + data


def serialize_array(items) -> bytes:
    body = b"".join(items)
    return bytes([0x40]) + var_int(len(items)) + body


def operation(target=b"", method=b"ping", args=None, nonce=0, deadline=1700000000000,
              validator_id=0, credential_generation=1, authority_epoch=1,
              configuration_nonce=0, signature=SIGNATURE, nonce_subkey=NONCE_SUBKEY,
              hook_proofs=None) -> bytes:
    """The canonical (unsigned) thirteen-field operation of §4.2."""
    return serialize_array([
        serialize_integer(4),
        serialize_bytes(target or SERVICE_HASH),
        serialize_bytes(method),
        serialize_array([] if args is None else args),
        serialize_integer(nonce),
        serialize_bytes(nonce_subkey),
        serialize_integer(deadline),
        serialize_integer(validator_id),
        serialize_integer(credential_generation),
        serialize_integer(authority_epoch),
        serialize_integer(configuration_nonce),
        serialize_bytes(signature),
        serialize_array([] if hook_proofs is None else hook_proofs),
    ])


def u64be(value: int) -> bytes:
    return value.to_bytes(8, "big")


def operation_digest(canonical: bytes, account: bytes, validator_id: int,
                     credential_generation: int, authority_epoch: int,
                     configuration_nonce: int, core_hash: bytes = SERVICE_HASH) -> bytes:
    domain = (
        USER_OPERATION_DOMAIN
        + bytes([4])
        + NETWORK.to_bytes(4, "little")
        + core_hash
        + account
        + u64be(validator_id)
        + u64be(credential_generation)
        + u64be(authority_epoch)
        + u64be(configuration_nonce)
    )
    return hashlib.sha256(domain + canonical).digest()


def main() -> int:
    custody = display_to_le(CUSTODY_DISPLAY)
    account = account_id(custody, SALT)
    canonical = operation(nonce=0, signature=b"")

    vectors = {
        "schema": "smartaccount-v4",
        "note": "Derived independently of the C# kernels by generate-smartaccount-v4-vectors.py.",
        "network": NETWORK,
        "serviceHash": SERVICE_HASH_DISPLAY,
        "custody": CUSTODY_DISPLAY,
        "salt": SALT.hex(),
        "accountId": le_to_display(account),
        "proxyAddress": le_to_display(hash160(verification_script(account))),
        "verificationScript": verification_script(account).hex(),
        "operation": {
            "canonical": canonical.hex(),
            "digest": operation_digest(canonical, account, 0, 1, 1, 0).hex(),
        },
        "digests": {
            "epoch2": operation_digest(operation(signature=b"", authority_epoch=2), account, 0, 1, 2, 0).hex(),
            "nonce1": operation_digest(operation(signature=b"", configuration_nonce=1), account, 0, 1, 1, 1).hex(),
            "validator1": operation_digest(operation(signature=b"", validator_id=1), account, 1, 1, 1, 0).hex(),
            "subkey1": operation_digest(operation(signature=b"", nonce_subkey=bytes.fromhex("ee" * 32)), account, 0, 1, 1, 0).hex(),
        },
    }
    json.dump(vectors, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
