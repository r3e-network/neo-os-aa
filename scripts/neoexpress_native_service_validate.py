#!/usr/bin/env python3
"""Persist and read back native SmartAccount transitions on a disposable local chain."""
import argparse
import datetime
import hashlib
import json
import re
import shutil
import socket
import tempfile
from pathlib import Path

from neoexpress_validate import Chain, H, B, I, S, A, ZERO, decode, hash_le, hash160, varint
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require, runtime_hashes, check_readback

CORE = "0xd9421d07adf206e9dc4be746a02e8e087fa61741"
STDLIB = "0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"
DIGEST = "2601e456d8d5a3f746c8cdcd6f90f19a62bf00bdfb856ef6f14be74a2b44f81a"
REQUIRED_METHODS = {"registerAccount", "getAccount", "getNonce", "getAccountAddress", "getVersion", "verify",
                    "executeUserOp", "executeUserOps", "callVerifier", "callHook", "callVerifierChild", "callHookChild",
                    "setVerifierDependencies", "setHookDependencies", "clearVerifierDependencies", "clearHookDependencies",
                    "getModuleDependencies", "cancelModuleCall", "getPendingModuleCall", "proposeRecoveryAddress",
                    "activateRecoveryAddress", "freeze", "unfreeze"}
REQUIRED_EVENTS = {"AccountCreated", "UserOpExecuted", "RecoveryAddressChangeProposed", "RecoveryAddressChanged", "AccountFrozen"}


def check_native(state):
    require(state.get("hash") == CORE and state.get("id") == -13, "Wrong native service identity")
    manifest = state.get("manifest", {})
    require(manifest.get("name") == "AccountManagement", "Wrong native service name")
    metadata = (manifest.get("extra") or {}).get("smartAccount", {})
    require(metadata.get("abiVersion") == 1 and metadata.get("profileParameterDigest") == DIGEST, "Wrong native profile metadata")
    abi = manifest.get("abi", {})
    require(REQUIRED_METHODS <= {m.get("name") for m in abi.get("methods", [])}, "Incomplete native method ABI")
    require(REQUIRED_EVENTS <= {e.get("name") for e in abi.get("events", [])}, "Incomplete native event ABI")


def check_application(execution, event):
    require(execution.get("vmstate") == "HALT", "Persisted native transaction did not halt")
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


def persist(chain, report, label, method, args, event, wallet="owner"):
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
    report = {"schema": "smartaccount-native-service-private/v1", "status": "RUNNING", "publicNetworksTouched": False,
              "scope": "Actual native activation, registration, fallback operations and recovery-address lifecycle; not full native conformance.",
              "runtimeMode": "Isolated local assembly overlay; not a reproducible NeoExpress distribution build.",
              "transactions": [], "preflightRejections": [], "ownedNodesStopped": False,
              "sourceSha256": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in
                               ("neoexpress_native_service_validate.py", "neoexpress_activation_validate.py", "neoexpress_validate.py")}}
    output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(report, indent=2) + "\n")
    stage = "runtime-validation"
    try:
        hashes = runtime_hashes(runtime); report["runtimeSha256"] = hashes
        with tempfile.TemporaryDirectory(prefix="smartaccount-native-service-") as scratch:
            directory = Path(scratch); chain = Chain(make_runner(runtime, dotnet, directory), directory)
            try:
                stage = "private-chain-creation"
                chain.nx("create", "-o", str(chain.file))
                config = json.loads(chain.file.read_text()); config.setdefault("settings", {})[ACTIVATION_KEY] = "0"
                for field in ("rpc-port", "tcp-port"):
                    with socket.socket() as sock:
                        sock.bind(("127.0.0.1", 0)); config["consensus-nodes"][0][field] = sock.getsockname()[1]
                chain.file.write_text(json.dumps(config)); chain.magic = config["magic"]; chain.rpc_port = config["consensus-nodes"][0]["rpc-port"]
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
                                                          (2, CORE, False, "service-hash-not-authority")):
                    op = A(H(diagnostic), S("check"), A(H(principal)), I(nonce), I(4_102_444_800_000), B(b""))
                    result = persist(chain, report, label, "executeUserOp", [H(account_text), op], "UserOpExecuted")
                    require(result is expected, "Witness control returned the wrong exact Boolean")
                    report["transactions"][-1]["witnessResult"] = result
                stage = "delayed-recovery-address"
                persist(chain, report, "propose-guardian", "proposeRecoveryAddress", [H(account_text), H(addresses["guardian"])], "RecoveryAddressChangeProposed")
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
                check_readback(chain.rpc("getcontractstate", [diagnostic]), probe_script, probe_nef, probe_manifest)
                report["witnessDiagnostic"] = {"contractHash": diagnostic, "readbackMatched": True,
                    "nefSha256": hashlib.sha256(probe_nef).hexdigest(), "scriptHex": probe_script.hex()}
                state, _, _ = chain.rpc_invoke(CORE, "getAccount", [H(account_text)])
                nonce, _, _ = chain.rpc_invoke(CORE, "getNonce", [H(account_text), I(0)])
                proxy, _, _ = chain.rpc_invoke(CORE, "getAccountAddress", [H(account_text)])
                require(len(state) == 13 and state[0] == 1 and state[1] == account and state[2] == proxy, "Account record identity mismatch")
                require(state[3] == hash_le(addresses["owner"]) and state[4] == hash_le(addresses["guardian"]), "Custody/guardian readback mismatch")
                require(state[7] == 1 and state[8] == 2 and nonce == 3, "Freeze, configuration epoch or rollback nonce mismatch")
                require(all(value is None for value in state[9:]), "Lifecycle did not clear pending intents")
                report["readback"] = {"nativeId": native["id"], "nativeHash": CORE, "nativeManifestVerified": True,
                    "nativeManifestSha256": hashlib.sha256(json.dumps(native["manifest"], sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                    "accountStateMatched": True, "status": "Frozen", "configurationNonce": state[8], "nextSequence": nonce,
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
    print("PASS: native service private lifecycle and RPC readback (bounded scenario coverage)")


if __name__ == "__main__": main()
