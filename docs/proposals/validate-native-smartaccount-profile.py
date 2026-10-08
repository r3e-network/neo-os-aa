#!/usr/bin/env python3
"""Validate the native SmartAccount profile document and published vectors."""

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).parent
DOCUMENT = (ROOT / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md").read_text()
VECTORS = json.loads((ROOT / "smartaccount-native-profile-v2-vectors.json").read_text())


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
    "MUST return false, including in a directly dispatched target",
    "Custody and non-zero recovery addresses MUST NOT be native contract hashes.",
    "HF_SmartAccountV1",
    "Cleanup runs only\nunder the authenticated `cleanup` context",
    "under that child's authenticated `cleanup` context",
    "MUST be the RFC 8785 JSON Canonicalization Scheme",
    "names MUST be sorted recursively by unsigned UTF-16 code units",
    "including negative zero encoded as `0`",
    "including its\nheader, method tokens and checksum",
    "### 5.4 Application witness authority",
    "### 8.1 Authenticated invocation contexts",
    "hasModuleContext(accountId: Hash160, moduleType: String, module: Hash160,",
    "isAccountAuthorized(accountId: Hash160) -> Boolean",
    "a public\nBoolean query that callers can choose to ignore is not an equivalent control",
    "System.Contract.CallWithGasLimit",
    "validateSignature(accountId: Hash160, op: Array) -> Boolean",
    "postExecute(accountId: Hash160, op: Array, result: Any) -> Void",
    "getSignerDomains(accountId: Hash160) -> Array",
    "preExecute(accountId: Hash160, op: Array) -> Void",
    "executeUserOp(accountId: Hash160, op: Array, expectedAuthorityEpoch: Integer, expectedConfigurationNonce: Integer) -> Any",
    "executeUserOps(accountId: Hash160, ops: Array, expectedAuthorityEpoch: Integer, expectedConfigurationNonce: Integer) -> Array",
    "callVerifierChild(accountId: Hash160, childVerifier: Hash160,",
    "module if its current code identity differs from the stored binding",
    "transaction that directly calls a token, NFT, application contract",
    "exhaustion sentinel",
    "0 <= nonce < 2^255",
    "0 <= deadline < 2^255",
    "0 <= channel < 2^191",
    "highest bit MUST be zero",
    "The top-level argument Array does not count as a nesting level",
    "NEWSTRUCT0",
    "PACKSTRUCT",
    "PUSHT",
    "PUSHF",
    "private shadow cursor",
    "Active = 0",
    "Frozen = 1",
    "clears all pending intents",
    "configuration changes MUST be rejected while custody recovery is pending",
    "custody and recovery addresses MUST NOT equal the account-address proxy",
):
    assert required in DOCUMENT, required

assert "**Version:** 2 (identity version 1; authorization and account-record version 2)" in DOCUMENT
assert VECTORS["profileVersion"] == 2
assert VECTORS["identityVersion"] == 1
assert VECTORS["authorizationVersion"] == VECTORS["accountRecordVersion"] == VECTORS["abiVersion"] == 2
assert VECTORS["serviceName"] == "AccountManagement"
assert VECTORS["serviceHashDisplay"] == "0xd9421d07adf206e9dc4be746a02e8e087fa61741"
assert "| Verifier callback budget | `100,000,000` datoshi per callback |" in DOCUMENT
assert "| Module maintenance callback budget | `250,000,000` datoshi per callback |" in DOCUMENT
assert "1,000,000,000" not in DOCUMENT
assert "The verifier budget is `100,000,000` datoshi per callback." in DOCUMENT
assert "less than or equal to Neo's `MaxVerificationGas` envelope of `150,000,000` datoshi" in " ".join(DOCUMENT.split())
assert "| `AccountCreated` | `Hash160, Hash160, Hash160, Hash160, Hash160, Hash160` |" in DOCUMENT

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

assert "clearAccount(accountId: Hash160) -> Void" in DOCUMENT
assert "Signer-domain discovery applies to verifier children only" in DOCUMENT

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

PARAMETERS = json.loads((ROOT / "smartaccount-native-profile-v2-parameters.json").read_text())
profile_json = json.dumps(PARAMETERS, sort_keys=True, separators=(",", ":"))
assert PARAMETERS["abiVersion"] == PARAMETERS["accountRecordVersion"] == PARAMETERS["authorizationVersion"] == PARAMETERS["profileVersion"] == 2
assert PARAMETERS["identityVersion"] == 1
assert PARAMETERS["authorityEpochWidthBits"] == PARAMETERS["configurationNonceWidthBits"] == 64
assert PARAMETERS["authorizationDomainSuffix"] == ["authorityEpochLE64", "configurationNonceLE64"]
assert PARAMETERS["recoveryRevokesModules"] is True
assert PARAMETERS["executionArgumentOrder"] == ["accountId", "operationOrBatch", "expectedAuthorityEpoch", "expectedConfigurationNonce"]
assert PARAMETERS["executionCounterCommitments"] == ["authorityEpoch", "configurationNonce"]
assert "former two-argument entrypoints MUST NOT remain callable" in DOCUMENT
assert PARAMETERS["verifierBudgetDatoshi"] == 100_000_000
assert PARAMETERS["hookBudgetDatoshi"] == PARAMETERS["maintenanceBudgetDatoshi"] == 250_000_000
assert profile_json in DOCUMENT
profile_digest = hashlib.sha256(b"NeoSmartAccount/Profile" + bytes([2]) + profile_json.encode()).hexdigest()
assert profile_digest == VECTORS["profileParameterDigest"]
assert profile_digest in DOCUMENT
for required in (
    "Array with exactly these 14 positions",
    "pendingRecoveryAddr, pendingRecovery, authorityEpoch]",
    "getAuthorityEpoch(accountId: Hash160) -> Integer",
    "UInt64LE(authorityEpoch) ||\nUInt64LE(configurationNonce)",
    "without invoking any external callback",
    "increments both the configuration nonce and the authority epoch, with checked overflow",
    "| `RecoveryExecuted` | `Hash160, Hash160, Hash160, Integer, Integer` |",
):
    assert required in DOCUMENT, required
assert VECTORS["events"]["AccountCreated"] == ["Hash160"] * 6
assert VECTORS["events"]["RecoveryExecuted"] == ["Hash160", "Hash160", "Hash160", "Integer", "Integer"]
assert VECTORS["accountRecord"]["fieldOrder"] == ["version", "accountId", "accountAddress", "custodyAddress", "recoveryAddress", "verifier", "hook", "status", "configurationNonce", "pendingVerifier", "pendingHook", "pendingRecoveryAddr", "pendingRecovery", "authorityEpoch"]
assert VECTORS["accountRecord"]["authorityEpochIndex"] == 13
assert VECTORS["accountRecord"]["configurationNonceIndex"] == 8

# Independently serialize the fixed initial VM Array; zero Integers use an empty
# byte sequence, and nulls remain Any/null rather than Integer zero.
def serialize_record_value(value):
    if value is None: return b"\x00"
    if isinstance(value, list): return bytes([0x40, len(value)]) + b"".join(map(serialize_record_value, value))
    if isinstance(value, bytes): return bytes([0x28, len(value)]) + value
    assert type(value) is int and 0 <= value <= 2
    return bytes([0x21, 0]) if value == 0 else bytes([0x21, 1, value])
initial = [2, bytes.fromhex(identity["accountIdWire"]), hash160(script), custody,
           bytes(20), None, None, 0, 0, None, None, None, None, 0]
assert VECTORS["accountRecord"]["version"] == 2
assert VECTORS["accountRecord"]["initialSerialized"] == serialize_record_value(initial).hex()
assert "0xA2 || policyPrefix || accountIdLE20 || authorityEpochLE64 || suffix" in DOCUMENT
namespaces = VECTORS["storageNamespaces"]
assert {v["name"] for v in namespaces} == {"initial", "recovered", "other-policy", "maximum-epoch"}
for vector in namespaces:
    prefix, epoch = vector["policyPrefix"], int(vector["authorityEpoch"])
    account = bytes.fromhex(vector["accountIdWire"])
    assert type(prefix) is int and 0 <= prefix <= 255 and len(account) == 20
    assert 0 <= epoch < 1 << 64
    key = bytes([0xa2, prefix]) + account + epoch.to_bytes(8, "little") + bytes.fromhex(vector["suffix"])
    assert vector["key"] == key.hex()
assert len({v["key"] for v in namespaces}) == 4

signer_domain_prefix = b"NeoSmartAccount/SignerDomain" + bytes([1])
for name, vector in VECTORS["signerDomains"].items():
    material = signer_domain_prefix + bytes.fromhex(vector["schemeTag"])
    material += bytes.fromhex(vector["canonicalSignerMaterial"])
    assert hashlib.sha256(material).hexdigest() == vector["commitment"], name

operation = VECTORS["operation"]
# Reconstruct the domain from independent state fields; self-consistent message/hash
# pairs alone do not prove that an operation binds the current authority counters.
def check_authorization(vector):
    epoch, configuration = int(vector["authorityEpoch"]), int(vector["configurationNonce"])
    assert 0 <= epoch < 1 << 64 and 0 <= configuration < 1 << 64
    domain = (b"NeoSmartAccount/UserOperation" + bytes([2])
              + int(VECTORS["networkMagic"], 16).to_bytes(4, "little")
              + service_wire + bytes.fromhex(identity["accountIdWire"])
              + epoch.to_bytes(8, "little") + configuration.to_bytes(8, "little"))
    message = domain + bytes.fromhex(operation["canonicalOperationWithoutSignature"])
    assert domain.hex() == vector["authorizationDomain"]
    assert message.hex() == vector["authorizationMessage"]
    assert hashlib.sha256(message).hexdigest() == vector["authorizationDigest"]
check_authorization(operation)
for control in VECTORS["authorizationControls"]:
    check_authorization(control)
    assert control["validAccountState"] is (int(control["authorityEpoch"]) <= int(control["configurationNonce"]))
assert "authorityEpoch <= configurationNonce" in DOCUMENT
assert len({value["authorizationDigest"] for value in VECTORS["authorizationControls"]}) == 5

integer_domain = VECTORS["integerDomain"]
maximum_nonce = (1 << 255) - 1
maximum_channel, maximum_sequence = divmod(maximum_nonce, 1 << 64)
assert integer_domain["vmIntegerBytes"] == 32
assert int(integer_domain["maximumNonce"]) == maximum_nonce
assert int(integer_domain["maximumDeadline"]) == maximum_nonce
assert int(integer_domain["maximumChannel"]) == maximum_channel == (1 << 191) - 1
assert int(integer_domain["maximumSequence"]) == maximum_sequence == (1 << 64) - 1
assert int(integer_domain["exhaustedCursor"]) == maximum_sequence + 1
assert int(integer_domain["firstUnrepresentableNonnegativeInteger"]) == 1 << 255
assert maximum_nonce.to_bytes(32, "little", signed=True).hex() == integer_domain["maximumNonceSignedLittleEndian"]
channel_bytes = maximum_channel.to_bytes(24, "big")
assert channel_bytes[0] == 0x7f
assert channel_bytes.hex() == integer_domain["maximumChannelStorageBytes"]
assert "20" + identity["accountIdWire"] + channel_bytes.hex() == integer_domain["maximumChannelNonceKey"]
try:
    (1 << 255).to_bytes(32, "little", signed=True)
except OverflowError:
    pass
else:
    raise AssertionError("The unsigned upper half must not fit a signed 32-byte Integer")

# Independently reconstruct the typed initializers, without running supplied code.
def push_integer(value):
    if -1 <= value <= 16:
        return bytes([0x10 + value])
    for opcode, width in enumerate((1, 2, 4, 8, 16, 32)):
        if -(1 << (8 * width - 1)) <= value < (1 << (8 * width - 1)):
            return bytes([opcode]) + value.to_bytes(width, "little", signed=True)
    raise ValueError("Integer outside NeoVM range")


def push_value(value):
    if isinstance(value, int):
        return push_integer(value)
    if isinstance(value, bytes):
        if len(value) <= 255:
            return b"\x0c" + bytes([len(value)]) + value
        return b"\x0d" + len(value).to_bytes(2, "little") + value
    if isinstance(value, list):
        return (b"\xc2" if not value else b"".join(push_value(item) for item in reversed(value))
                + push_integer(len(value)) + b"\xc0")
    raise TypeError("Unsupported fixture type")


account_wire = bytes.fromhex(identity["accountIdWire"])
minimal = [service_wire, b"ping", [], 0, 0, b""]
sequential = [minimal, [service_wire, b"ping", [], 1, 0, b""]]
published = [service_wire, b"transfer", [account_wire, 42], 0, 1700000000000, b""]
expected_envelopes = [("minimal-single", minimal, False),
                      ("sequential-batch", sequential, True),
                      ("published-operation", published, False)]
assert len(VECTORS["applicationEnvelopes"]) == len(expected_envelopes)
for vector, (name, payload, batch) in zip(VECTORS["applicationEnvelopes"], expected_envelopes):
    assert vector["name"] == name and vector["isBatch"] == batch
    epoch, configuration = int(vector["expectedAuthorityEpoch"]), int(vector["expectedConfigurationNonce"])
    assert 0 <= epoch < 1 << 64 and 0 <= configuration < 1 << 64
    assert vector["argumentCount"] == 4
    prefix = push_value(payload)
    commitments = push_integer(configuration) + push_integer(epoch)
    tail = (push_value(account_wire) + push_integer(4) + b"\xc0" + push_integer(15)
            + push_value(b"executeUserOps" if batch else b"executeUserOp")
            + push_value(service_wire) + bytes.fromhex("41627d5b52"))
    assert vector["initializer"] == prefix.hex()
    assert vector["applicationScript"] == (commitments + prefix + tail).hex()
assert VECTORS["applicationEnvelopes"][2]["serializedPayload"] == operation["canonicalOperationWithoutSignature"]

print("PASS: native SmartAccount profile document and vectors")
print("Not a native implementation, consensus activation, or proof of full NeoVM conformance.")
