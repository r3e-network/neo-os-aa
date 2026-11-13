#!/usr/bin/env python3
"""Persist and read back native SmartAccount transitions on a disposable local chain."""
import argparse
import base64
import datetime
import hashlib
import json
import os
import time
import re
import shutil
import socket
import tempfile
from pathlib import Path

from neoexpress_validate import Chain, RawKey, ValidationFailure, serialize_unsigned, serialize_witnesses, H, B, I, S, A, ZERO, decode, hash_le, hash160, varint
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require, runtime_hashes, check_readback

CORE = "0x398dc3f0227d7efac5533ed5ce9937390c158084"
STDLIB = "0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"
DIGEST = "ae557647b63789c7af0a8c7816dc90d5c0d7e65afb78ce3c669de9a01ce3c91a"
PRIVATE_CORE_GAS_ENVELOPE_DATOSHI = 10 * 100_000_000


def _parameters(*entries):
    return [{"name": name, "type": type_name} for name, type_name in entries]


def _method(parameters, returntype, safe):
    return {"parameters": _parameters(*parameters), "returntype": returntype, "safe": safe}


# Keep this descriptor table aligned with section 13 of the native profile. The
# service gate checks the complete ABI shape, while the private-chain scenario
# below remains intentionally bounded to the lifecycle transitions it drives.
REQUIRED_METHOD_ABI = {
    "verify": _method((("accountId", "Hash160"),), "Boolean", True),
    "getVersion": _method((), "Integer", True),
    "canonicalP256PublicKey": _method((("publicKey", "ByteArray"),), "ByteArray", True),
    "getAccount": _method((("accountId", "Hash160"),), "Any", True),
    "getAccountAddress": _method((("accountId", "Hash160"),), "Hash160", True),
    "getAuthorityEpoch": _method((("accountId", "Hash160"),), "Integer", True),
    "getNonce": _method((("accountId", "Hash160"), ("channel", "Integer")), "Integer", True),
    "getAuthorizationDomain": _method((("accountId", "Hash160"),), "ByteArray", True),
    "getOperationDigest": _method((("accountId", "Hash160"), ("op", "Array")), "ByteArray", True),
    "getPendingModuleCall": _method((("accountId", "Hash160"), ("moduleType", "String")), "Any", True),
    "getModuleDependencies": _method((("accountId", "Hash160"), ("moduleType", "String")), "Array", True),
    "hasModuleContext": _method((("accountId", "Hash160"), ("moduleType", "String"), ("module", "Hash160"), ("phase", "String")), "Boolean", True),
    "isAccountAuthorized": _method((("accountId", "Hash160"),), "Boolean", True),
    "registerAccount": _method((("custodyAddress", "Hash160"), ("salt", "ByteArray"), ("verifier", "Hash160"), ("hook", "Hash160"), ("recoveryAddress", "Hash160")), "Hash160", False),
    "executeUserOp": _method((("accountId", "Hash160"), ("op", "Array"), ("expectedAuthorityEpoch", "Integer"), ("expectedConfigurationNonce", "Integer")), "Any", False),
    "executeUserOps": _method((("accountId", "Hash160"), ("ops", "Array"), ("expectedAuthorityEpoch", "Integer"), ("expectedConfigurationNonce", "Integer")), "Array", False),
    "callVerifier": _method((("accountId", "Hash160"), ("method", "String"), ("args", "Array")), "Any", False),
    "callHook": _method((("accountId", "Hash160"), ("method", "String"), ("args", "Array")), "Any", False),
    "callVerifierChild": _method((("accountId", "Hash160"), ("childVerifier", "Hash160"), ("method", "String"), ("args", "Array")), "Any", False),
    "callHookChild": _method((("accountId", "Hash160"), ("childHook", "Hash160"), ("method", "String"), ("args", "Array")), "Any", False),
    "cancelModuleCall": _method((("accountId", "Hash160"), ("moduleType", "String")), "Void", False),
    "proposeVerifier": _method((("accountId", "Hash160"), ("verifier", "Hash160")), "Void", False),
    "activateVerifier": _method((("accountId", "Hash160"),), "Void", False),
    "cancelVerifier": _method((("accountId", "Hash160"),), "Void", False),
    "proposeHook": _method((("accountId", "Hash160"), ("hook", "Hash160")), "Void", False),
    "activateHook": _method((("accountId", "Hash160"),), "Void", False),
    "cancelHook": _method((("accountId", "Hash160"),), "Void", False),
    "proposeRecoveryAddress": _method((("accountId", "Hash160"), ("recovery", "Hash160")), "Void", False),
    "activateRecoveryAddress": _method((("accountId", "Hash160"),), "Void", False),
    "cancelRecoveryAddress": _method((("accountId", "Hash160"),), "Void", False),
    "proposeRecovery": _method((("accountId", "Hash160"), ("newCustody", "Hash160")), "Void", False),
    "executeRecovery": _method((("accountId", "Hash160"),), "Void", False),
    "cancelRecovery": _method((("accountId", "Hash160"),), "Void", False),
    "freeze": _method((("accountId", "Hash160"),), "Void", False),
    "unfreeze": _method((("accountId", "Hash160"),), "Void", False),
    "setVerifierDependencies": _method((("accountId", "Hash160"), ("children", "Array")), "Void", False),
    "setHookDependencies": _method((("accountId", "Hash160"), ("children", "Array")), "Void", False),
    "clearVerifierDependencies": _method((("accountId", "Hash160"),), "Void", False),
    "clearHookDependencies": _method((("accountId", "Hash160"),), "Void", False),
}

REQUIRED_EVENT_ABI = {
    "AccountCreated": _parameters(("accountId", "Hash160"), ("accountAddress", "Hash160"), ("custodyAddress", "Hash160"), ("verifier", "Hash160"), ("hook", "Hash160"), ("recoveryAddress", "Hash160")),
    "RecoveryProposed": _parameters(("accountId", "Hash160"), ("newCustodyAddress", "Hash160"), ("executeAt", "Integer"), ("configurationNonce", "Integer")),
    "RecoveryCancelled": _parameters(("accountId", "Hash160"), ("configurationNonce", "Integer")),
    "RecoveryExecuted": _parameters(("accountId", "Hash160"), ("oldCustodyAddress", "Hash160"), ("newCustodyAddress", "Hash160"), ("configurationNonce", "Integer"), ("authorityEpoch", "Integer")),
    "AccountFrozen": _parameters(("accountId", "Hash160")),
    "AccountUnfrozen": _parameters(("accountId", "Hash160")),
    "UserOpExecuted": _parameters(("accountId", "Hash160"), ("targetContract", "Hash160"), ("method", "String"), ("nonce", "Integer")),
    "VerifierChangeProposed": _parameters(("accountId", "Hash160"), ("verifier", "Hash160"), ("activateAt", "Integer"), ("configurationNonce", "Integer")),
    "VerifierChanged": _parameters(("accountId", "Hash160"), ("verifier", "Hash160"), ("configurationNonce", "Integer")),
    "VerifierChangeCancelled": _parameters(("accountId", "Hash160"), ("configurationNonce", "Integer")),
    "HookChangeProposed": _parameters(("accountId", "Hash160"), ("hook", "Hash160"), ("activateAt", "Integer"), ("configurationNonce", "Integer")),
    "HookChanged": _parameters(("accountId", "Hash160"), ("hook", "Hash160"), ("configurationNonce", "Integer")),
    "HookChangeCancelled": _parameters(("accountId", "Hash160"), ("configurationNonce", "Integer")),
    "RecoveryAddressChangeProposed": _parameters(("accountId", "Hash160"), ("recoveryAddress", "Hash160"), ("activateAt", "Integer"), ("configurationNonce", "Integer")),
    "RecoveryAddressChanged": _parameters(("accountId", "Hash160"), ("recoveryAddress", "Hash160"), ("configurationNonce", "Integer")),
    "RecoveryAddressChangeCancelled": _parameters(("accountId", "Hash160"), ("configurationNonce", "Integer")),
}

REQUIRED_METHODS = set(REQUIRED_METHOD_ABI)
REQUIRED_EVENTS = set(REQUIRED_EVENT_ABI)


def check_native(state):
    require(state.get("hash") == CORE and state.get("id") == -13, "Wrong native contract identity")
    manifest = state.get("manifest")
    require(type(manifest) is dict, "Malformed native manifest")
    require(manifest.get("name") == "SmartAccount", "Wrong native contract name")
    extra = manifest.get("extra")
    require(extra is None or type(extra) is dict, "Malformed native manifest metadata")
    metadata = (extra or {}).get("smartAccount", {})
    require(type(metadata) is dict, "Malformed native profile metadata")
    require(type(metadata.get("abiVersion")) is int and metadata["abiVersion"] == 2 and metadata.get("profileParameterDigest") == DIGEST, "Wrong native profile metadata")
    abi = manifest.get("abi", {})
    require(type(abi) is dict, "Malformed native ABI")
    methods = abi.get("methods")
    events = abi.get("events")
    require(type(methods) is list and type(events) is list, "Native ABI must contain method and event arrays")

    def match_parameters(actual, expected):
        return type(actual) is list and len(actual) == len(expected) and all(
            type(item) is dict and item.get("name") == wanted["name"] and item.get("type") == wanted["type"]
            for item, wanted in zip(actual, expected)
        )

    for name, expected in REQUIRED_METHOD_ABI.items():
        matches = [method for method in methods if type(method) is dict and method.get("name") == name]
        require(len(matches) == 1 and matches[0].get("returntype") == expected["returntype"] and
                matches[0].get("safe") is expected["safe"] and
                match_parameters(matches[0].get("parameters"), expected["parameters"]),
                f"Native method ABI mismatch: {name}")
    for name, expected in REQUIRED_EVENT_ABI.items():
        matches = [event for event in events if type(event) is dict and event.get("name") == name]
        require(len(matches) == 1 and match_parameters(matches[0].get("parameters"), expected),
                f"Native event ABI mismatch: {name}")


def check_profile_storage_readback(chain):
    """External readback of the activation-time profile record at storage key 0x00.

    The native service intentionally exposes no ABI getter for this record;
    external consumers close the identity loop through the raw storage readback.
    """
    value = chain.rpc("getstorage", [CORE, "00"])
    require(type(value) is str, "Native activation profile storage record is missing")
    record = base64.b64decode(value, validate=True)
    # Neo BinarySerializer layout of Array[Integer(2), ByteString(32)]:
    # array header 0x80, count 2, integer header 0x03 plus minimal value 2,
    # byte-string header 0x00 plus length 32, then the profile digest bytes.
    require(record == b"\x80\x02\x03\x02\x00\x20" + bytes.fromhex(DIGEST),
            "Native activation profile storage readback mismatch")


def canonical_p256_readback(chain):
    """Read-only public vectors with no account argument, signer or call capability."""
    compressed = bytes.fromhex('036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296')
    uncompressed = b'\x04' + compressed[1:] + bytes.fromhex('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')
    push = lambda value: b'\x0c' + bytes([len(value)]) + value
    # One argument, PACK, then CallFlags.None; the native helper needs no account state.
    suffix = b'\x11\xc0\x10' + push(b'canonicalP256PublicKey') + push(hash_le(CORE)) + b'\x41' + hashlib.sha256(b'System.Contract.Call').digest()[:4]
    expected = base64.b64encode(compressed).decode('ascii')

    def invoke(argument, reason=None):
        script = argument + suffix
        result = chain.rpc('invokescript', [base64.b64encode(script).decode('ascii'), []])
        require(type(result) is dict and result.get('notifications', []) == [], 'P-256 readback emitted notifications or returned invalid RPC data')
        if reason is not None:
            require(result.get('state') == 'FAULT' and type(result.get('exception')) is str and
                    result['exception'] and reason in result['exception'], 'Invalid P-256 input was accepted or faulted for the wrong reason')
        else:
            stack = result.get('stack')
            require(result.get('state') == 'HALT' and type(stack) is list and len(stack) == 1 and
                    stack[0].get('type') == 'ByteString' and stack[0].get('value') == expected,
                    'P-256 canonicalization did not return the exact compressed ByteString')

    for value in (compressed, uncompressed): invoke(push(value))
    invalid = [
        ('Buffer', push(compressed) + b'\xdb\x30', 'exact ByteString'),
        ('Integer', b'\x11', 'exact ByteString'),
        ('Boolean', b'\x08', 'exact ByteString'),
        ('Array', b'\xc2', 'exact ByteString'),
        ('Null', b'\x0b', "can't be null"),
        ('invalid-length', push(bytes(32)), 'requires a 33-byte compressed or 65-byte uncompressed encoding'),
        ('invalid-uncompressed-y', push(uncompressed[:-1] + bytes([uncompressed[-1] ^ 2])), 'not a point on the curve'),
        ('outside-field', push(b'\x02' + b'\xff' * 32), ''),
        ('no-square-root', push(b'\x02' + bytes(31) + b'\x01'), ''),
        ('hybrid-encoding', push(b'\x06' + uncompressed[1:]), 'requires a 33-byte compressed or 65-byte uncompressed encoding'),
    ]
    for _, argument, reason in invalid: invoke(argument, reason)
    return {'acceptedInputBytes': [33, 65], 'outputType': 'ByteString', 'outputBytes': 33,
            'canonicalPublicKeyHex': compressed.hex(), 'callFlags': 'None', 'signers': [],
            'rejectedInputs': [name for name, _, _ in invalid], 'notifications': []}


def check_account_record(record):
    require(type(record) is list and len(record) == 14 and type(record[0]) is int and record[0] == 2,
            "Native ABI v2 requires a fourteen-field account record")
    for index in (8, 13):
        require(type(record[index]) is int and 0 <= record[index] < 2**64, "Native authority counters must be UInt64")
    require(record[13] <= record[8], "Authority epoch exceeds configuration nonce")
    return record


def execution_arguments(account, payload, record):
    """Commit the observed authority generation into a newly constructed call."""
    check_account_record(record)
    require(record[1] == hash_le(account), "Execution account differs from the observed record")
    return [H(account), payload, I(record[13]), I(record[8])]


def module_storage_key(account, prefix, authority_epoch, suffix=b''):
    require(type(prefix) is int and 0 <= prefix <= 255, "Storage prefix must be a byte")
    require(type(authority_epoch) is int and 0 <= authority_epoch < 2**64, "Authority epoch must be UInt64")
    require(len(hash_le(account)) == 20 and type(suffix) is bytes, "Invalid module storage identity or suffix")
    return b'\xa2' + bytes([prefix]) + hash_le(account) + authority_epoch.to_bytes(8, 'little') + suffix


def transaction_system_fee(chain, script, signers, reserve=0):
    """Price these exact transaction inputs, including intentionally faulting probes."""
    require(type(reserve) is int and reserve >= 0, "Transaction fee reserve must be nonnegative")
    result = chain.rpc("invokescript", [base64.b64encode(script).decode("ascii"), signers])
    require(type(result) is dict and result.get("state") in ("HALT", "FAULT"),
            "Transaction fee simulation must finish in HALT or FAULT")
    consumed = result.get("gasconsumed")
    require(type(consumed) is str and re.fullmatch(r"[0-9]+", consumed) is not None,
            "Transaction fee simulation requires nonnegative integer gasconsumed datoshi")
    # minimumrequiredfee is an optional RPC extension.  The source-built
    # neo-node runtime returns the standard invokescript fields only; when the
    # extension is present, retain its conservative upper bound.
    minimum = result.get("minimumrequiredfee")
    if "minimumrequiredfee" not in result:
        return max(int(consumed), reserve)
    require(type(minimum) is str and re.fullmatch(r"[0-9]+", minimum) is not None,
            "Transaction fee simulation requires nonnegative integer minimumrequiredfee datoshi")
    return max(int(consumed), int(minimum), reserve)


def check_application(execution, event):
    require(execution.get("vmstate") == "HALT",
            f"Persisted native transaction did not halt: vmstate={execution.get('vmstate')!r}, "
            f"exception={execution.get('exception')!r}")
    require(any(n.get("eventname") == event and n.get("contract") == CORE
                for n in execution.get("notifications", [])), "Expected native event missing")


def witness_probe():
    script = b"\x41" + hashlib.sha256(b"System.Runtime.CheckWitness").digest()[:4] + b"\x40"
    body = b"NEF3" + b"Native witness diagnostic".ljust(64, b"\x00") + bytes(5) + varint(len(script)) + script
    nef = body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    manifest = {"name": "NativeWitnessDiagnostic", "groups": [], "features": {}, "supportedstandards": [],
        "abi": {"methods": [{"name": "check", "parameters": [{"name": "principal", "type": "Hash160"}],
                "returntype": "Boolean", "offset": 0, "safe": True}], "events": []},
        "permissions": [], "trusts": [], "extra": None}
    return script, nef, manifest


def operation(nonce):
    return A(H(STDLIB), S("serialize"), A(I(7)), I(nonce), I(4_102_444_800_000), B(b""))


def persist_with_consent(chain, report, label, method, args, event, wallet, consent_wallets, gas_reserve=0):
    """Sign every admitted authority with its explicitly selected local fixture wallet."""
    from neoexpress_native_proxy_validate import encode_value, push_bytes, check_transaction
    wallets = [wallet, *consent_wallets]
    require(len(set(wallets)) == len(wallets), "Consent wallets must be distinct")
    keys = [RawKey(chain.workdir, "consent-" + name, chain.wallet_private_key(name)) for name in wallets]
    require(len({key.script_hash for key in keys}) == len(keys), "Consent identities must be distinct")
    script = encode_value(A(*args)) + b"\x1f" + push_bytes(method.encode()) + push_bytes(hash_le(CORE)) + b"\x41\x62\x7d\x5b\x52"
    signers = [{"account": "0x" + key.script_hash[::-1].hex(), "scopes": "CalledByEntry"} for key in keys]
    was_running = chain.node is not None
    try:
        chain.start_node()
        sysfee, netfee = transaction_system_fee(chain, script, signers, gas_reserve), 100_000_000
        unsigned = serialize_unsigned(int.from_bytes(os.urandom(4), "little"), sysfee, netfee, chain.rpc("getblockcount", []) + 50, signers, script)
        digest = hashlib.sha256(unsigned).digest(); txid = "0x" + digest[::-1].hex()
        witnesses = [(push_bytes(key.sign(chain.magic.to_bytes(4, "little") + digest)), key.verification) for key in keys]
        raw = base64.b64encode(unsigned + serialize_witnesses(witnesses)).decode()
        require(chain.rpc("sendrawtransaction", [raw]).get("hash") == txid, "Consent transaction hash mismatch")
        deadline = time.monotonic() + 90; execution = None
        while time.monotonic() < deadline:
            try:
                execution = chain.rpc("getapplicationlog", [txid])["executions"][0]; break
            except ValidationFailure as error:
                require(str(error) in ("rpc getapplicationlog: Unknown transaction", "rpc getapplicationlog: Unknown application log", "rpc getapplicationlog: Unknown transaction/blockhash"), "Unexpected consent receipt failure")
            time.sleep(0.5)
        require(execution is not None, "Consent transaction did not persist")
        transaction = chain.rpc("getrawtransaction", [txid, True])
        check_transaction(transaction, txid, script, signers, witnesses)
        check_application(execution, event)
        report["transactions"].append({"step": label, "txid": txid, "operation": method, "vmstate": "HALT", "event": event,
            "gasConsumedDatoshi": int(execution["gasconsumed"]), "systemFeeDatoshi": sysfee,
            "consentWitnesses": len(witnesses), "rawTransactionAndWitnessReadbackMatched": True})
        return decode(execution["stack"][0]) if execution["stack"] else None
    finally:
        if not was_running: chain.stop_node()


def persist(chain, report, label, method, args, event, wallet="owner", *, consent_wallets=(), gas_reserve=0):
    if consent_wallets:
        return persist_with_consent(chain, report, label, method, args, event, wallet, consent_wallets, gas_reserve)
    if method in ("executeUserOp", "executeUserOps"):
        require(len(args) == 2, "Fresh execution requires account and payload")
        args = execution_arguments(args[0]["value"], args[1], chain.results(CORE, "getAccount", args[0]))
    path = chain.invoke_file(CORE, method, args)
    _, output = chain.nx("contract", "invoke", str(path), wallet, "-w", "Global", "-g", "10", "-j")
    match = re.search(r"0x[0-9a-fA-F]{64}", output)
    require(match is not None, "No persisted transaction identifier")
    txid = match.group(0)
    execution, transaction = chain.app_log(txid)
    check_application(execution, event)
    row = {"step": label, "txid": txid, "operation": method, "vmstate": "HALT", "event": event,
           "gasConsumedDatoshi": int(execution["gasconsumed"]), "systemFeeDatoshi": int(transaction["sysfee"])}
    report["transactions"].append(row)
    return decode(execution["stack"][0])


def rejected(chain, report, label, method, args, expected):
    if method in ("executeUserOp", "executeUserOps"):
        require(len(args) == 2, "Fresh execution requires account and payload")
        args = execution_arguments(args[0]["value"], args[1], chain.results(CORE, "getAccount", args[0]))
    path = chain.invoke_file(CORE, method, args)
    rc, output = chain.nx("contract", "invoke", str(path), "owner", "-w", "Global", "-g", "10", "-r", "-j", check=False)
    try:
        result = chain.json_from(output)
    except Exception:
        require(rc != 0 and expected in output, "Expected preflight rejection not observed")
    else:
        require(result.get("state") == "FAULT" and expected in result.get("exception", ""), "Wrong preflight failure")
    report["preflightRejections"].append({"step": label, "operation": method, "state": "FAULT", "persisted": False})


def validate(runtime, dotnet, output):
    report = {"schema": "smartaccount-native-contract-private/v1", "status": "RUNNING", "publicNetworksTouched": False,
              "scope": "Actual native activation, registration, fallback operations and recovery-address lifecycle; not full native conformance.",
              "runtimeMode": "Caller-supplied NeoExpress runtime; this runner does not establish build provenance. Verify the separate source-build receipt.",
              "transactions": [], "preflightRejections": [], "ownedNodesStopped": False,
              "sourceSha256": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in
                               ("neoexpress_native_service_validate.py", "neoexpress_activation_validate.py", "neoexpress_validate.py")}}
    output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(report, indent=2) + "\n")
    stage = "runtime-validation"
    try:
        hashes = runtime_hashes(runtime); report["runtimeSha256"] = hashes
        with tempfile.TemporaryDirectory(prefix="smartaccount-native-contract-") as scratch:
            directory = Path(scratch); chain = Chain(make_runner(runtime, dotnet, directory), directory)
            try:
                stage = "private-chain-creation"
                chain.nx("create", "-o", str(chain.file))
                config = json.loads(chain.file.read_text()); config.setdefault("settings", {})[ACTIVATION_KEY] = "0"
                for field in ("rpc-port", "tcp-port"):
                    with socket.socket() as sock:
                        sock.bind(("127.0.0.1", 0)); config["consensus-nodes"][0][field] = sock.getsockname()[1]
                chain.file.write_text(json.dumps(config)); chain.magic = config["magic"]; chain.rpc_port = config["consensus-nodes"][0]["rpc-port"]
                stage = 'public-key-canonicalization'
                chain.start_node()
                require(chain.rpc('getversion', [])['protocol']['network'] == chain.magic, 'Wrong loopback network')
                check_native(chain.rpc('getcontractstate', [CORE]))
                report['canonicalP256PublicKey'] = canonical_p256_readback(chain)
                report['canonicalP256PublicKey']['beforeAccountRegistration'] = True
                chain.stop_node()
                for wallet in ("owner", "guardian"):
                    chain.nx("wallet", "create", wallet)
                _, listing = chain.nx("wallet", "list", "-j"); wallets = chain.json_from(listing)
                addresses = {}
                for wallet in ("owner", "guardian"):
                    accounts = wallets[wallet] if isinstance(wallets[wallet], list) else [wallets[wallet]]
                    addresses[wallet] = next(a["script-hash"] for a in accounts if a.get("account-label") == "Default")
                    chain.nx("transfer", "100", "GAS", "genesis", wallet)
                stage = "diagnostic-deployment"
                probe_script, probe_nef, probe_manifest = witness_probe()
                probe_file = directory / "witness.nef"; probe_file.write_bytes(probe_nef)
                probe_file.with_suffix(".manifest.json").write_text(json.dumps(probe_manifest))
                _, deployed = chain.nx("contract", "deploy", str(probe_file), "genesis", "-j")
                diagnostic = chain.json_from(deployed)["contract-hash"]
                stage = "registration"
                account = persist(chain, report, "register", "registerAccount", [H(addresses["owner"]), B(bytes(32)), H(ZERO), H(ZERO), H(ZERO)], "AccountCreated")
                expected = hash160(b"NeoSmartAccount\x01" + chain.magic.to_bytes(4, "little") + hash_le(CORE) + hash_le(addresses["owner"]) + bytes(32))
                require(account == expected, "Native account identifier differs from independent vector")
                account_text = "0x" + account[::-1].hex(); report["accountId"] = account_text; report["networkMagic"] = chain.magic
                stage = "execution"
                persist(chain, report, "execute", "executeUserOp", [H(account_text), operation(0)], "UserOpExecuted")
                rejected(chain, report, "replay", "executeUserOp", [H(account_text), operation(0)], "sequence is not current")
                stage = "witness-boundary"
                for nonce, principal, expected, label in ((1, addresses["owner"], True, "custody-witness-control"),
                                                          (2, CORE, False, "native-contract-hash-not-authority")):
                    op = A(H(diagnostic), S("check"), A(H(principal)), I(nonce), I(4_102_444_800_000), B(b""))
                    result = persist(chain, report, label, "executeUserOp", [H(account_text), op], "UserOpExecuted")
                    require(result is expected, "Witness control returned the wrong exact Boolean")
                    report["transactions"][-1]["witnessResult"] = result
                stage = "delayed-recovery-address"
                persist(chain, report, "propose-guardian", "proposeRecoveryAddress", [H(account_text), H(addresses["guardian"])], "RecoveryAddressChangeProposed", consent_wallets=("guardian",))
                rejected(chain, report, "immature-guardian", "activateRecoveryAddress", [H(account_text)], "mature")
                chain.nx("fastfwd", "1", "-t", "86401")
                persist(chain, report, "activate-guardian", "activateRecoveryAddress", [H(account_text)], "RecoveryAddressChanged")
                stage = "freeze"
                persist(chain, report, "freeze", "freeze", [H(account_text)], "AccountFrozen", wallet="guardian")
                rejected(chain, report, "frozen-execution", "executeUserOp", [H(account_text), operation(3)], "Frozen")
                stage = "rpc-readback"
                chain.start_node(); version = chain.rpc("getversion", [])
                require(version["protocol"]["network"] == chain.magic, "Wrong loopback network")
                native = chain.rpc("getcontractstate", [CORE]); check_native(native)
                check_profile_storage_readback(chain)
                check_readback(chain.rpc("getcontractstate", [diagnostic]), probe_script, probe_nef, probe_manifest)
                report["witnessDiagnostic"] = {"contractHash": diagnostic, "readbackMatched": True,
                    "nefSha256": hashlib.sha256(probe_nef).hexdigest(), "scriptHex": probe_script.hex()}
                require(chain.rpc_invoke(CORE, "getVersion", [])[0] == 2, "SmartAccount native contract version is not ABI v2")
                state, _, _ = chain.rpc_invoke(CORE, "getAccount", [H(account_text)])
                nonce, _, _ = chain.rpc_invoke(CORE, "getNonce", [H(account_text), I(0)])
                proxy, _, _ = chain.rpc_invoke(CORE, "getAccountAddress", [H(account_text)])
                require(check_account_record(state) and state[0] == 2 and state[1] == account and state[2] == proxy, "Account record identity mismatch")
                require(state[3] == hash_le(addresses["owner"]) and state[4] == hash_le(addresses["guardian"]), "Custody/guardian readback mismatch")
                require(state[7] == 1 and state[8] == 2 and nonce == 3, "Freeze, configuration epoch or rollback nonce mismatch")
                require(all(value is None for value in state[9:13]), "Lifecycle did not clear pending intents")
                report["readback"] = {"nativeId": native["id"], "nativeHash": CORE, "nativeManifestVerified": True, "authorityEpoch": state[13],
                    "nativeManifestSha256": hashlib.sha256(json.dumps(native["manifest"], sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                    "accountStateMatched": True, "status": "Frozen", "configurationNonce": state[8], "nextSequence": nonce,
                    "profileStorageReadbackMatched": True,
                    "blockCount": chain.rpc("getblockcount", []), "nodeVersion": version["useragent"]}
                # Re-read the actual persisted logs via RPC, not just CLI summaries.
                for row in report["transactions"]:
                    log = chain.rpc("getapplicationlog", [row["txid"]]); check_application(log["executions"][0], row["event"])
                report["persistedLogsMatchedRpc"] = True
            finally:
                chain.stop_node(); report["ownedNodesStopped"] = chain.node is None
        stage = "runtime-stability"
        require(hashes == runtime_hashes(runtime), "Runtime assemblies changed during validation")
        report["runtimeHashesUnchanged"] = True; report["status"] = "PASS"
    except Exception as error:
        report["failure"] = {"stage": stage, "type": type(error).__name__}
        raise
    finally:
        if report["status"] != "PASS": report["status"] = "FAIL"
        report["completedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        output.write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True); parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dotnet", type=Path, default=shutil.which("dotnet")); args = parser.parse_args()
    require(args.dotnet is not None, "A local dotnet runtime is required")
    validate(args.runtime.resolve(), Path(args.dotnet).resolve(), args.output)
    print("PASS: native contract private lifecycle and RPC readback (bounded scenario coverage)")


if __name__ == "__main__": main()
