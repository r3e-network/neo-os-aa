#!/usr/bin/env python3
"""Actual multi-witness native recovery transitions on a disposable NeoExpress chain."""
import argparse
import base64
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import time
from neoexpress_validate import Chain, RawKey, ValidationFailure, H, B, I, ZERO, hash_le, decode, serialize_unsigned, serialize_witnesses
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require, runtime_hashes
from neoexpress_native_service_validate import CORE, check_native, persist, operation
from neoexpress_native_proxy_validate import push_bytes, check_transaction, check_fault, proxy_address, GAS
from neoexpress_native_configuration_validate import call_script, pending_log

MODULE_DELAY = 86_400_000
RECOVERY_DELAY = 604_800_000


def equal_typed(left, right):
    if type(left) is not type(right): return False
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(equal_typed(a, b) for a, b in zip(left, right))
    return left == right


def check_transition(before, after, changes, nonce_delta):
    require(all(type(i) is int and i in (3, 7, 8, 9, 10, 11, 12) for i in changes), "Recovery matrix may not mutate immutable identity/module fields")
    require(type(before) is tuple and len(before) == 2 and type(before[0]) is list and len(before[0]) == 13 and type(before[1]) is int,
            "Invalid native account/cursor observation")
    expected = copy.deepcopy(before[0])
    for i, value in changes.items(): expected[i] = value
    require(equal_typed((expected, before[1] + nonce_delta), after), "Native account record or nonce transition differs from the declared outcome")


def signers_for(keys):
    require(keys and len({k.script_hash for k in keys}) == len(keys), "A transaction requires distinct signers in payer-first order")
    require(all(type(k.script_hash) is bytes and len(k.script_hash) == 20 for k in keys), "Invalid signer identity")
    return [{"account": "0x" + key.script_hash[::-1].hex(), "scopes": "CalledByEntry"} for key in keys]


class RecoveryTransactions:
    def __init__(self, chain, account, report): self.chain, self.account, self.report = chain, account, report

    def state(self):
        return (self.chain.rpc_invoke(CORE, "getAccount", [H(self.account)])[0],
                self.chain.rpc_invoke(CORE, "getNonce", [H(self.account), I(0)])[0])

    def send(self, label, method, args, keys, *, changes=None, nonce_delta=0, event=None, fault=None, pending=None):
        before = self.state(); changes = dict(changes or {})
        script = call_script(CORE, method, [H(self.account), *args]); signers = signers_for(keys)
        sysfee, netfee = 5 * GAS, GAS
        unsigned = serialize_unsigned(int.from_bytes(os.urandom(4), "little"), sysfee, netfee, self.chain.rpc("getblockcount", []) + 50, signers, script)
        digest = hashlib.sha256(unsigned).digest(); txid = "0x" + digest[::-1].hex()
        witnesses = [(push_bytes(k.sign(self.chain.magic.to_bytes(4, "little") + digest)), k.verification) for k in keys]
        raw = base64.b64encode(unsigned + serialize_witnesses(witnesses)).decode()
        require(self.chain.rpc("sendrawtransaction", [raw]).get("hash") == txid, "Transaction hash mismatch")
        deadline = time.monotonic() + 90; execution = None
        while time.monotonic() < deadline:
            try: execution = self.chain.rpc("getapplicationlog", [txid])["executions"][0]; break
            except ValidationFailure as error:
                if not pending_log(error): raise
            time.sleep(0.5)
        require(execution is not None, "Recovery transaction did not persist")
        tx = self.chain.rpc("getrawtransaction", [txid, True]); check_transaction(tx, txid, script, signers, witnesses)
        if fault: check_fault(execution, fault)
        else:
            require(execution["vmstate"] == "HALT", "Recovery transition did not halt")
            notifications = execution.get("notifications", [])
            require(len(notifications) == 1 and notifications[0]["contract"] == CORE and notifications[0]["eventname"] == event,
                    "Unexpected recovery event set")
            values = decode(notifications[0]["state"]); require(values[0] == hash_le(self.account), "Event account mismatch")
            require(len(execution.get("stack", [])) == 1, "Unexpected result stack size")
            expected = b"\x21\x01\x07" if nonce_delta else None
            require(equal_typed(decode(execution["stack"][0]), expected), "Unexpected exact operation result")
            if pending:
                field, target, delay = pending
                timestamp = self.chain.rpc("getblockheader", [tx["blockhash"], True])["time"]
                record = [hash_le(target)] + ([bytes(32)] if field in (9, 10) else [])
                changes[field] = record + [timestamp, timestamp + delay, before[0][8]]
        after = self.state(); check_transition(before, after, changes, nonce_delta)
        self.report["executions"].append({"step": label, "method": method, "txid": txid, "vmstate": execution["vmstate"], "persisted": True,
            "signers": [s["account"] for s in signers], "witnessBytesReadbackMatched": True, "confirmedBlock": tx["blockhash"],
            "event": event if not fault else None, "fullAccountAndNonceMatched": True, "configurationNonce": after[0][8], "operationNonce": after[1],
            "gasConsumedDatoshi": int(execution["gasconsumed"]), "systemFeeDatoshi": sysfee, "networkFeeDatoshi": netfee})
        print(label + ": " + execution["vmstate"], flush=True)


def validate(runtime, dotnet, output):
    report = {"schema": "smartaccount-native-recovery-private/v1", "status": "RUNNING", "publicNetworksTouched": False,
        "scope": "Actual multi-signer freeze/unfreeze, delayed custody recovery and retired-custody rejection; not complete lifecycle conformance or a cryptographic proof.",
        "runtimeMode": "Isolated local assembly overlay, not a reproducible NeoExpress distribution build.",
        "transactions": [], "executions": [], "ownedNodesStopped": False,
        "sourceSha256": {n: hashlib.sha256(Path(__file__).with_name(n).read_bytes()).hexdigest() for n in
            ("neoexpress_native_recovery_validate.py", "neoexpress_native_configuration_validate.py", "neoexpress_native_proxy_validate.py", "neoexpress_native_service_validate.py", "neoexpress_activation_validate.py", "neoexpress_validate.py")}}
    output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(report, indent=2) + "\n"); stage = "runtime-validation"
    try:
        hashes = runtime_hashes(runtime); report["runtimeSha256"] = hashes
        with tempfile.TemporaryDirectory(prefix="smartaccount-native-recovery-") as scratch:
            directory = Path(scratch); chain = Chain(make_runner(runtime, dotnet, directory), directory)
            try:
                stage = "private-chain-setup"; chain.nx("create", "-o", str(chain.file)); config = json.loads(chain.file.read_text())
                config.setdefault("settings", {}).update({ACTIVATION_KEY: "0", "chain.SecondsPerBlock": "1"})
                for field in ("rpc-port", "tcp-port"):
                    with socket.socket() as sock:
                        sock.bind(("127.0.0.1", 0)); config["consensus-nodes"][0][field] = sock.getsockname()[1]
                chain.file.write_text(json.dumps(config)); chain.magic = config["magic"]; chain.rpc_port = config["consensus-nodes"][0]["rpc-port"]
                keys = {}; addresses = {}
                for label in ("owner", "guardian", "replacement", "relay"):
                    chain.nx("wallet", "create", label); chain.nx("transfer", "1000", "GAS", "genesis", label)
                    keys[label] = RawKey(directory, "private-" + label, chain.wallet_private_key(label))
                    addresses[label] = "0x" + keys[label].script_hash[::-1].hex()
                account = persist(chain, report, "register", "registerAccount", [H(addresses["owner"]), B(bytes(32)), H(ZERO), H(ZERO), H(addresses["guardian"])], "AccountCreated")
                account = "0x" + account[::-1].hex(); chain.start_node(); check_native(chain.rpc("getcontractstate", [CORE]))
                require(chain.rpc("getversion", [])["protocol"]["network"] == chain.magic, "Wrong private network")
                driver = RecoveryTransactions(chain, account, report); initial = driver.state()
                require(initial[0][2] == hash_le(proxy_address(account)) and initial[0][8] == 0 and initial[1] == 0, "Unexpected initial account identity/counters")
                domain = chain.rpc_invoke(CORE, "getAuthorizationDomain", [H(account)])[0]
                O, G, N, R = (keys[n] for n in ("owner", "guardian", "replacement", "relay"))
                clear = {9: None, 10: None, 11: None, 12: None}
                stage = "joint-witness-matrix"
                driver.send("custody-cannot-freeze", "freeze", [], [O], fault="configured recovery authority")
                driver.send("seed-verifier-intent", "proposeVerifier", [H(ZERO)], [O], event="VerifierChangeProposed", pending=(9, ZERO, MODULE_DELAY))
                driver.send("seed-address-intent", "proposeRecoveryAddress", [H(addresses["replacement"])], [O], event="RecoveryAddressChangeProposed", pending=(11, addresses["replacement"], MODULE_DELAY))
                driver.send("guardian-freeze", "freeze", [], [G], event="AccountFrozen", changes={**clear, 7: 1, 8: 1})
                driver.send("frozen-execute", "executeUserOp", [operation(0)], [O], fault="Frozen")
                driver.send("custody-only-unfreeze", "unfreeze", [], [O], fault="Unfreeze requires custody")
                driver.send("guardian-only-unfreeze", "unfreeze", [], [G], fault="Unfreeze requires custody")
                driver.send("joint-unfreeze", "unfreeze", [], [O, G], event="AccountUnfrozen", changes={**clear, 7: 0, 8: 2})
                driver.send("custody-cannot-propose-recovery", "proposeRecovery", [H(addresses["replacement"])], [O], fault="configured recovery authority")
                driver.send("guardian-propose-recovery", "proposeRecovery", [H(addresses["replacement"])], [G], event="RecoveryProposed", pending=(12, addresses["replacement"], RECOVERY_DELAY))
                driver.send("configuration-during-recovery", "proposeHook", [H(ZERO)], [O], fault="Configuration is unavailable during custody recovery")
                driver.send("immature-recovery", "executeRecovery", [], [R], fault="immature or stale")
                driver.send("custody-cancels-before-maturity", "cancelRecovery", [], [O], event="RecoveryCancelled", changes={12: None})
                driver.send("seed-retained-module-intent", "proposeVerifier", [H(ZERO)], [O], event="VerifierChangeProposed", pending=(9, ZERO, MODULE_DELAY))
                driver.send("guardian-renews-recovery", "proposeRecovery", [H(addresses["replacement"])], [G], event="RecoveryProposed", pending=(12, addresses["replacement"], RECOVERY_DELAY))
                driver.send("active-execute-during-recovery", "executeUserOp", [operation(0)], [O], event="UserOpExecuted", nonce_delta=1)
                chain.stop_node(); chain.nx("fastfwd", "1", "-t", str(RECOVERY_DELAY // 1000 + 1)); chain.start_node()
                stage = "mature-recovery-matrix"
                driver.send("custody-cannot-cancel-mature", "cancelRecovery", [], [O], fault="Custody cancellation expires at recovery maturity")
                driver.send("guardian-cancels-after-maturity", "cancelRecovery", [], [G], event="RecoveryCancelled", changes={12: None})
                driver.send("final-recovery-proposal", "proposeRecovery", [H(addresses["replacement"])], [G], event="RecoveryProposed", pending=(12, addresses["replacement"], RECOVERY_DELAY))
                chain.stop_node(); chain.nx("fastfwd", "1", "-t", str(RECOVERY_DELAY // 1000 + 1)); chain.start_node()
                driver.send("neutral-payer-executes-recovery", "executeRecovery", [], [R], event="RecoveryExecuted", changes={**clear, 3: hash_le(addresses["replacement"]), 8: 3})
                driver.send("retired-custody-execute", "executeUserOp", [operation(1)], [O], fault="custody witness")
                driver.send("replacement-custody-execute", "executeUserOp", [operation(1)], [N], event="UserOpExecuted", nonce_delta=1)
                driver.send("guardian-refreeze", "freeze", [], [G], event="AccountFrozen", changes={**clear, 7: 1, 8: 4})
                driver.send("retired-custody-joint-unfreeze", "unfreeze", [], [O, G], fault="Unfreeze requires custody")
                driver.send("replacement-joint-unfreeze", "unfreeze", [], [N, G], event="AccountUnfrozen", changes={**clear, 7: 0, 8: 5})
                final = driver.state(); require(final[0][1:3] == initial[0][1:3] and final[1] == 2, "Recovery changed identity or nonce history")
                require(chain.rpc_invoke(CORE, "getAuthorizationDomain", [H(account)])[0] == domain, "Recovery changed the authorization domain")
                report.update(networkMagic=chain.magic, accountId=account, proxy=proxy_address(account), preservedIdentityAndDomain=True,
                              finalCustody=addresses["replacement"], finalConfigurationNonce=5, finalOperationNonce=2)
            finally: chain.stop_node(); report["ownedNodesStopped"] = chain.node is None
        require(hashes == runtime_hashes(runtime), "Runtime changed during validation"); report.update(status="PASS", runtimeHashesUnchanged=True)
    except Exception as error:
        report["failure"] = {"stage": stage, "type": type(error).__name__}; raise
    finally:
        if report["status"] != "PASS": report["status"] = "FAIL"
        report["completedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat(); output.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True); parser.add_argument("--dotnet", type=Path, default=shutil.which("dotnet")); args = parser.parse_args()
    require(args.dotnet is not None, "A local dotnet runtime is required")
    validate(args.runtime.resolve(), args.dotnet.resolve(), args.output)
    print("PASS: signed recovery authority, maturity and custody-rotation matrix")
