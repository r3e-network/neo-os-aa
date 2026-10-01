#!/usr/bin/env python3
"""Validate the native SmartAccount profile document and published vectors."""

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).parent
DOCUMENT = (ROOT / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md").read_text()
VECTORS = json.loads((ROOT / "smartaccount-native-profile-v1-vectors.json").read_text())


def hash160(value: bytes) -> bytes:
    return hashlib.new("ripemd160", hashlib.sha256(value).digest()).digest()


def hex_wire(value: bytes) -> str:
    return value.hex()


assert "# Native SmartAccount Profile" in DOCUMENT
for heading in (
    "## 4. Native identity and activation",
    "## 5. Account identity and address",
    "## 6. Canonical account state",
    "## 7. Account lifecycle and authority separation",
    "## 8. Module binding and code identity",
    "## 9. UserOperation authorization and execution",
    "## 10. Resource and fee accounting",
    "## 11. Governance and upgrades",
    "## 12. Migration and compatibility",
    "## 13. Required ABI surface",
    "## 14. Conformance vectors",
):
    assert heading in DOCUMENT, heading

for required in (
    "HF_SmartAccountV1",
    "System.Contract.CallWithGasLimit",
    "validateSignature(accountId: Hash160, op: Array) -> Boolean",
    "postExecute(accountId: Hash160, op: Array, result: Any) -> Void",
    "preExecute(accountId: Hash160, op: Array) -> Void",
    "executeUserOp(accountId: Hash160, op: Array) -> Any",
    "executeUserOps(accountId: Hash160, ops: Array) -> Array",
    "module if its current code identity differs from the stored binding",
    "transaction that directly calls a token, NFT, application contract",
    "exhaustion sentinel",
):
    assert required in DOCUMENT, required

assert VECTORS["profileVersion"] == 1
assert VECTORS["serviceName"] == "AccountManagement"
assert VECTORS["serviceHashDisplay"] == "0xd9421d07adf206e9dc4be746a02e8e087fa61741"

identity = VECTORS["identity"]
service_wire = bytes.fromhex(VECTORS["serviceHashWire"])
custody = bytes.fromhex(identity["custodyAddressWire"])
salt = bytes.fromhex(identity["salt"])
account_input = (
    b"NeoSmartAccount"
    + bytes([1])
    + (0x12345678).to_bytes(4, "little")
    + service_wire
    + custody
    + salt
)
assert hash160(account_input).hex() == identity["accountIdWire"]

script = bytes.fromhex(identity["verificationScript"])
assert script == (
    bytes([0x0C, 0x14])
    + bytes.fromhex(identity["accountIdWire"])
    + bytes([0x11, 0xC0, 0x15, 0x0C, 0x06])
    + b"verify"
    + bytes([0x0C, 0x14])
    + service_wire
    + bytes.fromhex("41627d5b52")
)
assert "0x" + hash160(script)[::-1].hex() == identity["accountAddressDisplay"]

profile_json = (
    '{"abiVersion":1,"argumentCountMax":64,"argumentDepthMax":8,'
    '"argumentSizeMax":4096,"batchMax":32,"custodyRecoveryDelayMs":604800000,'
    '"hookBudgetDatoshi":250000000,"methodBytesMax":128,'
    '"moduleChangeDelayMs":86400000,"nativeSponsorship":false,'
    '"profileVersion":1,"serviceName":"AccountManagement",'
    '"signatureBytesMax":1024,"verifierBudgetDatoshi":1000000000}'
)
profile_digest = hashlib.sha256(
    b"NeoSmartAccount/Profile" + bytes([1]) + profile_json.encode()
).hexdigest()
assert profile_digest == VECTORS["profileParameterDigest"]

operation = VECTORS["operation"]
assert hashlib.sha256(bytes.fromhex(operation["authorizationMessage"])).hexdigest() == operation["authorizationDigest"]

print("PASS: native SmartAccount profile document and vectors")
print("Not a native implementation, consensus activation, or proof of full NeoVM conformance.")
