#!/usr/bin/env python3
"""Persist root-mutation rollback and benign child configuration on private NeoExpress."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import time
from neoexpress_validate import Chain, RawKey, ValidationFailure, H, B, I, S, A, ZERO, decode, hash_le, varint, serialize_unsigned, serialize_witnesses
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require, runtime_hashes, check_readback
from neoexpress_native_service_validate import CORE, check_native, persist, transaction_system_fee
from neoexpress_native_proxy_validate import encode_value, push_bytes, check_transaction, check_fault, GAS

MANAGEMENT = "0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"


def syscall(name):
    return b"\x41" + hashlib.sha256(name.encode()).digest()[:4]


def call_script(target, method, args):
    return encode_value(A(*args)) + b"\x1f" + push_bytes(method.encode()) + push_bytes(hash_le(target)) + syscall("System.Contract.Call")


def module_fixture(hook, root, destroy_target=None):
    """Small diagnostic NEF: an exposed destroy method is intentional test behavior."""
    script = bytearray(); methods = []
    def method(name, result, safe, types, body):
        methods.append({"name": name, "parameters": [{"name": "arg" + str(i), "type": t} for i, t in enumerate(types)],
                        "returntype": result, "offset": len(script), "safe": safe})
        if types: script.extend(b"\x57\x00" + bytes([len(types)]))  # INITSLOT consumes ABI arguments.
        script.extend(body + b"\x40")
    method("supportsComposition", "Boolean", True, [], b"\x08" if root else b"\x09")
    method("preExecute" if hook else "validateSignature", "Void" if hook else "Boolean", False,
           ["Hash160", "Array"], b"" if hook else b"\x08")
    method("postExecute", "Void", False, ["Hash160", "Array", "Any"], b"")
    method("clearAccount", "Void", False, ["Hash160"], push_bytes(b"x") + syscall("System.Storage.GetContext") + syscall("System.Storage.Delete"))
    if not hook: method("getSignerDomains", "Array", True, ["Hash160"], encode_value(A(B(bytes([7]) * 32))))
    body = b"\x79" + push_bytes(b"x") + syscall("System.Storage.GetContext") + syscall("System.Storage.Put")
    if destroy_target: body += call_script(destroy_target, "destroySelf", []) + b"\x45"
    method("configure", "Any", False, ["Hash160", "Integer"], body + b"\x09")
    method("getValue", "Any", True, [], push_bytes(b"x") + syscall("System.Storage.GetReadOnlyContext") + syscall("System.Storage.Get"))
    if root: method("destroySelf", "Void", False, [], call_script(MANAGEMENT, "destroy", []) + b"\x45")
    name = ("MultiHook" if hook else "MultiSigVerifier") if root else ("NativeLeafHook" if hook else "NativeLeafVerifier")
    if destroy_target: name += "Destructive"
    manifest = {"name": name, "groups": [], "features": {}, "supportedstandards": [], "abi": {"methods": methods, "events": []},
                "permissions": [{"contract": "*", "methods": "*"}], "trusts": [],
                "extra": {"smartAccount": {"abiVersion": 2, "configurationMethods": ["configure"]}}}
    script = bytes(script)
    body = b"NEF3" + b"Native configuration diagnostic".ljust(64, b"\x00") + bytes(5) + varint(len(script)) + script
    return script, body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4], manifest


def check_configuration_outcome(execution, fault):
    if fault: check_fault(execution, "The module is zero, native or blocked.")
    else:
        require(execution.get("vmstate") == "HALT", "Configuration did not halt")
        require(execution.get("stack") == [{"type": "Boolean", "value": False}], "Configuration did not return exact false")


def pending_log(error):
    return str(error) in ("rpc getapplicationlog: Unknown transaction", "rpc getapplicationlog: Unknown application log",
                          "rpc getapplicationlog: Unknown transaction/blockhash")


def send(chain, owner, report, label, method, args, *, fault=False, cancellation=False, event=None):
    script = call_script(CORE, method, args)
    signers = [{"account": "0x" + owner.script_hash[::-1].hex(), "scopes": "CalledByEntry"}]
    sysfee, netfee = transaction_system_fee(chain, script, signers), GAS
    unsigned = serialize_unsigned(int.from_bytes(os.urandom(4), "little"), sysfee, netfee, chain.rpc("getblockcount", []) + 50, signers, script)
    digest = hashlib.sha256(unsigned).digest(); txid = "0x" + digest[::-1].hex()
    witnesses = [(push_bytes(owner.sign(chain.magic.to_bytes(4, "little") + digest)), owner.verification)]
    raw = base64.b64encode(unsigned + serialize_witnesses(witnesses)).decode()
    require(chain.rpc("sendrawtransaction", [raw]).get("hash") == txid, "Node transaction hash mismatch")
    deadline = time.monotonic() + 90; execution = None
    while time.monotonic() < deadline:
        try: execution = chain.rpc("getapplicationlog", [txid])["executions"][0]; break
        except ValidationFailure as error:
            if not pending_log(error): raise
        time.sleep(0.5)
    require(execution is not None, "Configuration transaction did not persist")
    tx = chain.rpc("getrawtransaction", [txid, True]); check_transaction(tx, txid, script, signers, witnesses)
    if event:
        require(execution["vmstate"]=="HALT" and [(n["contract"],n["eventname"])for n in execution["notifications"]]==[(CORE,event)],"Unexpected recovery outcome or event")
        require(decode(execution["notifications"][0]["state"])[0]==hash_le(args[0]["value"]),"Recovery event account mismatch")
    elif cancellation: require(execution["vmstate"] == "HALT", "Cancellation failed")
    else: check_configuration_outcome(execution, fault)
    report["executions"].append({"step": label, "txid": txid, "method": method, "vmstate": execution["vmstate"], "persisted": True,
        "gasConsumedDatoshi": int(execution["gasconsumed"]), "systemFeeDatoshi": sysfee, "networkFeeDatoshi": netfee,
        "notifications": len(execution.get("notifications", [])), "confirmedBlock": tx["blockhash"],
        "rawTransactionAndWitnessReadbackMatched": True})
    print(label + ": " + execution["vmstate"], flush=True)


def validate(runtime, dotnet, output):
    report = {"schema": "smartaccount-native-configuration-private/v1", "status": "RUNNING", "publicNetworksTouched": False,
        "scope": "Persisted root destruction rollback and benign child configuration for verifier/hook roles; diagnostic plugins, not full conformance.",
        "runtimeMode": "Isolated local assembly overlay, not a reproducible NeoExpress distribution build.",
        "transactions": [], "executions": [], "scenarios": [], "ownedNodesStopped": False,
        "sourceSha256": {n: hashlib.sha256(Path(__file__).with_name(n).read_bytes()).hexdigest() for n in
            ("neoexpress_native_configuration_validate.py", "neoexpress_native_proxy_validate.py", "neoexpress_native_service_validate.py", "neoexpress_activation_validate.py", "neoexpress_validate.py")}}
    output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(report, indent=2) + "\n")
    stage = "runtime-validation"
    try:
        hashes = runtime_hashes(runtime); report["runtimeSha256"] = hashes
        with tempfile.TemporaryDirectory(prefix="smartaccount-native-configuration-") as scratch:
            directory = Path(scratch); chain = Chain(make_runner(runtime, dotnet, directory), directory)
            try:
                stage = "private-chain-setup"; chain.nx("create", "-o", str(chain.file)); config = json.loads(chain.file.read_text())
                config.setdefault("settings", {}).update({ACTIVATION_KEY: "0", "chain.SecondsPerBlock": "1"})
                for field in ("rpc-port", "tcp-port"):
                    with socket.socket() as sock:
                        sock.bind(("127.0.0.1", 0)); config["consensus-nodes"][0][field] = sock.getsockname()[1]
                chain.file.write_text(json.dumps(config)); chain.magic = config["magic"]; chain.rpc_port = config["consensus-nodes"][0]["rpc-port"]
                chain.nx("wallet", "create", "owner"); chain.nx("transfer", "1000", "GAS", "genesis", "owner")
                owner = RawKey(directory, "private-owner", chain.wallet_private_key("owner"))
                custody = "0x" + owner.script_hash[::-1].hex(); scenarios = []
                recovery_keys={}
                for label in ("guardian","replacement"):
                    chain.nx("wallet","create",label);chain.nx("transfer","1000","GAS","genesis",label)
                    recovery_keys[label]=RawKey(directory,"private-"+label,chain.wallet_private_key(label))
                recovery_addresses={name:"0x"+key.script_hash[::-1].hex()for name,key in recovery_keys.items()}
                def deploy(label, artifact):
                    script, nef, manifest = artifact
                    path = directory / (label + ".nef"); path.write_bytes(nef); path.with_suffix(".manifest.json").write_text(json.dumps(manifest))
                    _, result = chain.nx("contract", "deploy", str(path), "genesis", "-j")
                    return chain.json_from(result)["contract-hash"]
                for hook in (False, True):
                    role = "hook" if hook else "verifier"; root_artifact = module_fixture(hook, True)
                    root = deploy(role + "-root", root_artifact)
                    bad_artifact = module_fixture(hook, False, root); good_artifact = module_fixture(hook, False)
                    bad = deploy(role + "-bad", bad_artifact); good = deploy(role + "-good", good_artifact)
                    account = persist(chain, report, role + "-register", "registerAccount",
                        [H(custody), B(bytes([1 + int(hook)]) * 32), H(ZERO if hook else root), H(root if hook else ZERO), H(recovery_addresses["guardian"])], "AccountCreated")
                    scenarios.append({"role": role, "route": "callHookChild" if hook else "callVerifierChild", "id": "0x" + account[::-1].hex(),
                        "root": root, "bad": bad, "good": good, "artifacts": [(root, root_artifact), (bad, bad_artifact), (good, good_artifact)]})
                chain.start_node(); check_native(chain.rpc("getcontractstate", [CORE]))
                require(chain.rpc("getversion", [])["protocol"]["network"] == chain.magic, "Wrong private network")
                def value(target, method, args): return chain.rpc_invoke(target, method, args)[0]
                def state(s): return (value(CORE, "getAccount", [H(s["id"])]), value(CORE, "getPendingModuleCall", [H(s["id"]), S(s["role"])]),
                                     value(CORE, "getModuleDependencies", [H(s["id"]), S(s["role"])]), value(s["bad"], "getValue", []))
                def config_args(s, leaf): return [H(s["id"]), H(s[leaf]), S("configure"), A(I(7))]
                for s in scenarios:
                    for target, artifact in s["artifacts"]: check_readback(chain.rpc("getcontractstate", [target]), *artifact)
                    send(chain, owner, report, s["role"] + "-propose-destructive", s["route"], config_args(s, "bad"))
                    s["before"] = state(s); require(s["before"][3] is None and s["before"][0][8] == 0, "Unexpected initial module state")
                chain.stop_node(); chain.nx("fastfwd", "1", "-t", "86401"); chain.start_node()
                stage = "persisted-root-rollback"
                for s in scenarios:
                    send(chain, owner, report, s["role"] + "-reject-root-destruction", s["route"], config_args(s, "bad"), fault=True)
                    require(state(s) == s["before"], "Configuration FAULT changed account, intent, roster or child storage")
                    check_readback(chain.rpc("getcontractstate", [s["root"]]), *s["artifacts"][0][1])
                    send(chain, owner, report, s["role"] + "-cancel", "cancelModuleCall", [H(s["id"]), S(s["role"])], cancellation=True)
                    send(chain, owner, report, s["role"] + "-propose-benign", s["route"], config_args(s, "good"))
                chain.stop_node(); chain.nx("fastfwd", "1", "-t", "86401"); chain.start_node()
                stage = "benign-configuration-control"
                for s in scenarios:
                    send(chain, owner, report, s["role"] + "-confirm-benign", s["route"], config_args(s, "good"))
                    after = state(s); marker = value(s["good"], "getValue", [])
                    require(after[0][8] == 1 and after[1] is None and after[3] is None and marker == b"\x07", "Benign configuration did not commit exact expected state")
                    require(len(after[2][1]) == 1 and after[2][1][0][0] == hash_le(s["good"]) and after[2][2] == [], "Cleanup enrollment differs from benign child")
                    check_readback(chain.rpc("getcontractstate", [s["root"]]), *s["artifacts"][0][1])
                    report["scenarios"].append({"role": s["role"], "accountId": s["id"], "root": s["root"], "rootReadbackMatched": True,
                        "faultRolledBackAccountIntentRosterAndChild": True, "benignFalseResultCommitted": True, "configurationNonce": 1,
                        "artifacts": [{"contract": h, "nefSha256": hashlib.sha256(a[1]).hexdigest(), "manifestSha256": hashlib.sha256(json.dumps(a[2], sort_keys=True).encode()).hexdigest()} for h, a in s["artifacts"]]})
                stage = "recovery-revokes-enrollment-and-pending"
                for scenario in scenarios:
                    account=scenario["id"]
                    send(chain,owner,report,scenario["role"]+"-seed-pending-before-recovery",scenario["route"],config_args(scenario,"bad"))
                    before=state(scenario);nonce=value(CORE,"getNonce",[H(account),I(0)])
                    require(before[1] is not None and len(before[2][1])==1,"Recovery fixture must contain pending authority and enrollment")
                    send(chain,recovery_keys["guardian"],report,scenario["role"]+"-propose-recovery","proposeRecovery",
                         [H(account),H(recovery_addresses["replacement"])],event="RecoveryProposed")
                    scenario["recoveryBefore"]=(before,nonce)
                chain.stop_node();chain.nx("fastfwd","1","-t","604801");chain.start_node()
                for scenario in scenarios:
                    account=scenario["id"];before,nonce=scenario["recoveryBefore"]
                    send(chain,recovery_keys["replacement"],report,scenario["role"]+"-execute-recovery","executeRecovery",[H(account)],event="RecoveryExecuted")
                    after=state(scenario);expected=list(before[0]);expected[3]=hash_le(recovery_addresses["replacement"])
                    expected[5:7]=[None,None];expected[8]+=1;expected[9:13]=[None]*4;expected[13]+=1
                    require(after[0]==expected and after[1] is None and after[2]==[None,[],[]],"Recovery did not revoke root, pending authority and enrollment exactly")
                    require(value(CORE,"getNonce",[H(account),I(0)])==nonce,"Recovery reset operation nonce")
                    for role in ("verifier","hook"):
                        require(value(CORE,"getModuleDependencies",[H(account),S(role)])==[None,[],[]],"Recovery retained other-role dependencies")
                        require(value(CORE,"getPendingModuleCall",[H(account),S(role)]) is None,"Recovery retained other-role pending authority")
                    require(value(scenario["good"],"getValue",[])==b"\x07","Recovery unexpectedly relied on old plugin cleanup")
                    next(row for row in report["scenarios"]if row["role"]==scenario["role"])["recoveryRevokedPendingAndEnrollment"]=True
                report["networkMagic"] = chain.magic
            finally: chain.stop_node(); report["ownedNodesStopped"] = chain.node is None
        require(hashes == runtime_hashes(runtime), "Runtime changed during validation")
        report.update(status="PASS", runtimeHashesUnchanged=True)
    except Exception as error:
        report["failure"] = {"stage": stage, "type": type(error).__name__}; raise
    finally:
        if report["status"] != "PASS": report["status"] = "FAIL"
        report["completedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        output.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True); parser.add_argument("--dotnet", type=Path, default=shutil.which("dotnet")); args = parser.parse_args()
    require(args.dotnet is not None, "A local dotnet runtime is required")
    validate(args.runtime.resolve(), args.dotnet.resolve(), args.output)
    print("PASS: persisted configuration root-mutation rollback and benign controls")
