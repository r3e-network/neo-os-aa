#!/usr/bin/env python3
"""Persist actual native-profile witness and allowlist module lifecycles locally."""
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

from neoexpress_validate import (Chain, RawKey, ValidationFailure, H, B, I, S, A, ZERO, decode,
                                hash_le, nef_script, varint, serialize_unsigned, serialize_witnesses)
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require, runtime_hashes, check_readback
from neoexpress_native_service_validate import CORE, STDLIB, check_native, persist, operation, transaction_system_fee, module_storage_key, execution_arguments
from neoexpress_native_proxy_validate import push_bytes, check_transaction, check_fault, GAS
from neoexpress_native_configuration_validate import call_script, pending_log
from neoexpress_native_recovery_validate import equal_typed
from neoexpress_reproducible_build import check_runtime_receipt, sha256
from native_module_profile import validate_descriptor
from build_native_modules import collect_inputs

NULL = {"type": "Any", "value": None}
CONTEXT = "Missing native module invocation context"


def nef_from_rpc(value):
    """Serialize every RPC NEF field, including CALLT tokens, for byte equality."""
    require(type(value["magic"]) is int and value["magic"] == int.from_bytes(b"NEF3", "little"), "Wrong NEF magic")
    compiler = value["compiler"].encode("utf-8"); source = value["source"].encode("utf-8")
    require(len(compiler) <= 64 and b"\0" not in compiler and len(source) <= 256, "Invalid NEF header")
    tokens = value["tokens"]; require(type(tokens) is list and len(tokens) <= 128, "Invalid NEF token list")
    body = b"NEF3" + compiler.ljust(64, b"\0") + varint(len(source)) + source + b"\0" + varint(len(tokens))
    flag_values = {"None": 0, "ReadStates": 1, "WriteStates": 2, "AllowCall": 4, "AllowNotify": 8, "States": 3, "ReadOnly": 5, "All": 15}
    for token in tokens:
        method = token["method"].encode("utf-8"); count = token["paramcount"]; flags = token["callflags"]
        require(len(method) <= 32 and not method.startswith(b"_") and type(count) is int and 0 <= count <= 65535, "Invalid NEF method token")
        require(type(token["hasreturnvalue"]) is bool, "Invalid NEF token return flag")
        if type(flags) is str:
            names = flags.split(", "); require(all(n in flag_values for n in names), "Unknown NEF call flag")
            flags = 0
            for name in names: flags |= flag_values[name]
        require(type(flags) is int and 0 <= flags <= 15, "Invalid NEF call flags")
        body += hash_le(token["hash"]) + varint(len(method)) + method + count.to_bytes(2, "little") + bytes([int(token["hasreturnvalue"]), flags])
    script = base64.b64decode(value["script"], validate=True)
    require(bool(script), "Empty NEF script")
    body += bytes(2) + varint(len(script)) + script
    checksum = value["checksum"]
    require(type(checksum) is int and 0 <= checksum <= 0xffffffff, "Invalid NEF checksum")
    check = checksum.to_bytes(4, "little")
    require(check == hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4], "RPC NEF checksum mismatch")
    return body + check


def check_module_build(compiled, artifacts, contracts):
    # ABI v2 receipts pin root restore policy as well as native module sources.
    require(compiled.get("schema") == "smartaccount-native-module-build/v2" and
            compiled.get("sourceRoot") == "repository" and compiled.get("restoreLockedMode") is True and
            compiled.get("packageSourcesPolicy") == "nuget.config", "A locked repository-scoped v2 build receipt is required")
    require(compiled.get("status") == "PASS" and compiled.get("reproducible") is True and len(compiled.get("builds", [])) == 2,
            "A successful native two-build receipt is required")
    require(compiled["builds"][0], "Native artifact certificate is empty")
    profiles = validate_descriptor(json.loads((contracts / "native/profiles.json").read_text()))
    files = {name + suffix for name in profiles for suffix in (".nef", ".manifest.json")}
    files.add("native-profile-packaging.json")
    require(set(compiled["builds"][0]) == files and compiled["builds"][0] == compiled["builds"][1], "Native artifact roster or replay mismatch")
    pins = compiled["builds"][0]
    require(all(sha256(artifacts/n) == h for n,h in pins.items()), "Native artifact pin mismatch")
    _, source_pins = collect_inputs(contracts)
    require(compiled.get("sourceSha256") == source_pins, "Native source inventory or bytes changed after build")
    scripts = Path(__file__).parent
    require(compiled["recipeSha256"] == sha256(scripts/"build_native_modules.py") and
            compiled["packagingRecipeSha256"] == sha256(scripts/"native_module_profile.py"), "Native recipe changed after build")
    return pins


def module_signers(keys, module_scope):
    require(keys and len({k.script_hash for k in keys}) == len(keys), "Distinct nonempty signer list required")
    signers = [{"account": "0x" + k.script_hash[::-1].hex(), "scopes": "CalledByEntry"} for k in keys]
    if module_scope:
        for s in signers:
            s.update(scopes="WitnessRules", rules=[{"action": "Allow", "condition": {"type": "Or", "expressions": [
                {"type": "CalledByContract", "hash": CORE}]}}])
    return signers


def check_outcome(execution, expected, event, fault):
    if fault:
        check_fault(execution, fault)
        return
    require(execution.get("vmstate") == "HALT", "Expected HALT: " + str(execution.get("exception")))
    stack = execution.get("stack", [])
    require(len(stack) == 1 and equal_typed(decode(stack[0]), expected), "Incorrect exact return value")
    notifications = execution.get("notifications", [])
    require(len(notifications) == int(event is not None), "Unexpected event count")
    if event:
        require(notifications[0].get("contract") == CORE and notifications[0].get("eventname") == event, "Wrong native event")


class ModuleTransactions:
    def __init__(self, chain, account, other, verifier, hook, report):
        self.chain, self.account, self.other, self.verifier, self.hook, self.report = chain, account, other, verifier, hook, report

    def value(self, target, method, args): return self.chain.rpc_invoke(target, method, args)[0]

    def state(self, account):
        return [self.value(CORE, "getAccount", [H(account)]), self.value(CORE, "getNonce", [H(account), I(0)]),
                self.value(CORE, "getPendingModuleCall", [H(account), S("verifier")]),
                self.value(CORE, "getPendingModuleCall", [H(account), S("hook")]),
                self.value(self.verifier, "getConfig", [H(account)]), self.value(self.verifier, "getThreshold", [H(account)]),
                self.value(self.hook, "isWhitelisted", [H(account), H(STDLIB)])]

    def send(self, label, target, method, args, keys, *, module_scope=False, expected=None, event=None, fault=None,
             state_change=None, pending=None, root_pending=None, recovery_pending=None):
        before = self.state(self.account); other = self.state(self.other)
        if target == CORE and method in ("executeUserOp", "executeUserOps"):
            require(len(args) == 2, "Fresh execution requires account and payload")
            args = execution_arguments(self.account, args[1], before[0])
        script = call_script(target, method, args); signers = module_signers(keys, module_scope)
        sysfee, netfee = transaction_system_fee(self.chain, script, signers), GAS
        unsigned = serialize_unsigned(int.from_bytes(os.urandom(4), "little"), sysfee, netfee,
                                      self.chain.rpc("getblockcount", []) + 50, signers, script)
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
        require(execution is not None, "Module transaction did not persist")
        tx = self.chain.rpc("getrawtransaction", [txid, True]); check_transaction(tx, txid, script, signers, witnesses)
        # Keep diagnostic detail on stdout, not in public receipts containing host paths.
        print(label + ": " + execution["vmstate"] + (" " + str(execution.get("exception")) if execution["vmstate"] != "HALT" else ""), flush=True)
        check_outcome(execution, expected, event, fault)
        if event: require(decode(execution["notifications"][0]["state"])[0] == hash_le(self.account), "Event account mismatch")
        after = self.state(self.account); desired = copy.deepcopy(before)
        if state_change: state_change(desired)
        if pending:
            field, role, name, arguments, binding = pending
            timestamp = self.chain.rpc("getblockheader", [tx["blockhash"], True])["time"]
            desired[field] = [1, hash_le(self.account), role, before[0][binding], before[0][binding], name.encode(),
                              [hash_le(self.account), *arguments], timestamp, timestamp + 86_400_000, before[0][8]]
        if root_pending:
            timestamp = self.chain.rpc("getblockheader", [tx["blockhash"], True])["time"]
            field,binding = root_pending if isinstance(root_pending,tuple) else (root_pending,[hash_le(ZERO),bytes(32)])
            desired[0][field] = [*binding, timestamp, timestamp + 86_400_000, before[0][8]]
        if recovery_pending:
            timestamp = self.chain.rpc("getblockheader", [tx["blockhash"], True])["time"]
            desired[0][12] = [hash_le(recovery_pending),timestamp,timestamp+604_800_000,before[0][8]]
        if not equal_typed(desired, after):
            print("Expected state:", desired, "Actual state:", after, flush=True)
            raise ValidationFailure("Full declared account, cursor, intent and policy transition mismatch")
        require(equal_typed(other, self.state(self.other)), "A different account was modified")
        self.report["executions"].append({"step": label, "method": method, "txid": txid, "vmstate": execution["vmstate"],
            "persisted": True, "confirmedBlock": tx["blockhash"], "expectedFailure": fault,
            "witnessScopes": [s["scopes"] for s in signers], "rawTransactionAndWitnessReadbackMatched": True,
            "accountNonceIntentsAndPolicyMatched": True, "otherAccountUnchanged": True,
            "configurationNonce": after[0][8], "operationNonce": after[1], "gasConsumedDatoshi": int(execution["gasconsumed"]),
            "systemFeeDatoshi": sysfee, "networkFeeDatoshi": netfee,
            "committedAuthorityEpoch":before[0][13] if method in ('executeUserOp','executeUserOps') else None,
            "committedConfigurationNonce":before[0][8] if method in ('executeUserOp','executeUserOps') else None})
        return tx


def commit_config(state):
    state[0][8] += 1
    state[0][9:13] = [None] * 4
    state[2:4] = [None, None]


def validate(runtime, dotnet, artifacts, build_receipt, module_receipt, output):
    sources = [Path(__file__), *[Path(__file__).with_name(n) for n in (
        "neoexpress_validate.py", "neoexpress_activation_validate.py", "neoexpress_native_service_validate.py",
        "neoexpress_native_proxy_validate.py", "neoexpress_native_configuration_validate.py", "neoexpress_native_recovery_validate.py",
        "neoexpress_reproducible_build.py", "build_native_modules.py", "native_module_profile.py")]]
    report = {"schema": "smartaccount-native-real-modules-private/v1", "status": "RUNNING", "publicNetworksTouched": False,
              "scope": "Actual NeoNativeVerifier and WhitelistHook native profiles; not all modules or a cryptographic/refinement proof.",
              "runtimeMode": "Complete source-built runner with exact full runtime file map verification.",
              "transactions": [], "executions": [], "modules": [], "ownedNodesStopped": False}
    output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(report, indent=2) + "\n")
    stage = "provenance"
    try:
        report.update(sourceSha256={p.name: sha256(p) for p in sources}, sourceBuildReceiptSha256=sha256(build_receipt),
                      moduleBuildReceiptSha256=sha256(module_receipt))
        build = json.loads(build_receipt.read_text()); check_runtime_receipt(build, runtime)
        compiled = json.loads(module_receipt.read_text())
        contracts = Path(__file__).resolve().parent.parent / "contracts"
        artifact_pins = check_module_build(compiled, artifacts, contracts)
        report["runtimeSha256"] = runtime_hashes(runtime)
        with tempfile.TemporaryDirectory(prefix="smartaccount-native-modules-") as scratch:
            root = Path(scratch); chain = Chain(make_runner(runtime, dotnet, root), root)
            try:
                stage = "setup"; chain.nx("create", "-o", str(chain.file)); config = json.loads(chain.file.read_text())
                config.setdefault("settings", {}).update({ACTIVATION_KEY: "0", "chain.SecondsPerBlock": "1"})
                for field in ("rpc-port", "tcp-port"):
                    with socket.socket() as sock:
                        sock.bind(("127.0.0.1", 0)); config["consensus-nodes"][0][field] = sock.getsockname()[1]
                chain.file.write_text(json.dumps(config)); chain.magic = config["magic"]; chain.rpc_port = config["consensus-nodes"][0]["rpc-port"]
                keys = []
                for label in ("owner", "cosigner"):
                    chain.nx("wallet", "create", label); chain.nx("transfer", "1000", "GAS", "genesis", label)
                    keys.append(RawKey(root, "private-" + label, chain.wallet_private_key(label)))
                owner, cosigner = keys; addresses = ["0x" + k.script_hash[::-1].hex() for k in keys]
                recovery_keys={}
                for label in ("guardian","replacement"):
                    chain.nx("wallet","create",label);chain.nx("transfer","1000","GAS","genesis",label)
                    recovery_keys[label]=RawKey(root,"private-"+label,chain.wallet_private_key(label))
                recovery_addresses={name:"0x"+key.script_hash[::-1].hex() for name,key in recovery_keys.items()}
                modules = []
                for name in ("NeoNativeVerifier", "WhitelistHook"):
                    path = artifacts / (name + ".nef")
                    _, text = chain.nx("contract", "deploy", str(path), "genesis", "-j", "-d", "0x" + hash_le(CORE).hex())
                    deployed = chain.json_from(text); require(deployed["contract-name"] == name, "Deployed module name mismatch")
                    modules.append(deployed["contract-hash"])
                    report["modules"].append({"name": name, "contractHash": modules[-1], "deploymentTransaction": deployed["tx-hash"],
                        "nefSha256": sha256(path), "manifestSha256": sha256(path.with_suffix(".manifest.json"))})
                verifier, hook = modules; accounts = []
                for salt in (bytes(32), bytes([1]) * 32):
                    account = persist(chain, report, "register-" + str(len(accounts)), "registerAccount",
                                      [H(addresses[0]), B(salt), H(verifier), H(hook), H(recovery_addresses["guardian"])], "AccountCreated")
                    accounts.append("0x" + account[::-1].hex())
                chain.start_node(); check_native(chain.rpc("getcontractstate", [CORE]))
                require(chain.rpc("getversion", [])["protocol"]["network"] == chain.magic, "Wrong private network")
                def readback():
                    for row in report["modules"]:
                        path = artifacts / (row["name"] + ".nef"); script, _ = nef_script(path)
                        state = chain.rpc("getcontractstate", [row["contractHash"]])
                        check_readback(state, script, path.read_bytes(), json.loads(path.with_suffix(".manifest.json").read_text()))
                        require(nef_from_rpc(state["nef"]) == path.read_bytes(), "Full RPC NEF bytes differ from the compiled artifact")
                        require(chain.rpc_invoke(row["contractHash"], "authorizedCore", [])[0] == hash_le(CORE), "Module service identity mismatch")
                        row["scriptChecksumAndManifestReadbackMatched"] = True
                        row["fullNefByteReadbackMatched"] = True
                readback(); driver = ModuleTransactions(chain, *accounts, verifier, hook, report); account = accounts[0]
                initial = driver.state(account)
                require(initial[0][8] == 0 and initial[1:] == [0, None, None, None, 0, False], "Unexpected initial module state")
                def send(label, method, args, **kw): return driver.send(label, CORE, method, [H(account), *args], [owner], **kw)
                def wait_delay():
                    chain.stop_node(); chain.nx("fastfwd", "1", "-t", "86401"); chain.start_node()
                config_args = [A(*[H(a) for a in addresses]), I(2)]
                stage = "direct-context-rejection"
                for target, method, args in [(verifier, "setConfig", [H(account), *config_args]),
                    (verifier, "validateSignature", [H(account), operation(0)]), (verifier, "postExecute", [H(account), operation(0), NULL]),
                    (verifier, "clearAccount", [H(account)]), (hook, "setWhitelist", [H(account), H(STDLIB), {"type":"Boolean","value":True}]),
                    (hook, "preExecute", [H(account), operation(0)]), (hook, "postExecute", [H(account), operation(0), NULL]), (hook, "clearAccount", [H(account)])]:
                    driver.send("direct-" + ("verifier-" if target == verifier else "hook-") + method, target, method, args, [owner], fault=CONTEXT)
                stage = "configuration"
                send("propose-threshold", "callVerifier", [S("setConfig"), A(*config_args)], expected=False,
                     pending=(2, 0, "setConfig", [[hash_le(a) for a in addresses], 2], 5))
                send("immature-threshold", "callVerifier", [S("setConfig"), A(*config_args)], fault="immature, changed or stale")
                wait_delay()
                def configure(state):
                    commit_config(state); state[4] = [[hash_le(a) for a in addresses], 2]; state[5] = 2
                send("confirm-threshold", "callVerifier", [S("setConfig"), A(*config_args)], state_change=configure)
                def execute(label, op, signing_keys=keys, **kw):
                    driver.send(label, CORE, "executeUserOp", [H(account), op], signing_keys, **kw)
                execute("default-deny-hook", operation(0), module_scope=True, fault="Target contract not in whitelist")
                allow_args = [H(STDLIB), {"type":"Boolean","value":True}]
                send("propose-allowlist", "callHook", [S("setWhitelist"), A(*allow_args)], expected=False,
                     pending=(3, 1, "setWhitelist", [hash_le(STDLIB), True], 6))
                wait_delay()
                def allow(state): commit_config(state); state[6] = True
                send("confirm-allowlist", "callHook", [S("setWhitelist"), A(*allow_args)], state_change=allow)
                stage = "threshold-and-scope"
                for label, signing_keys, scope in [("missing-cosigner", [owner], True), ("wrong-witness-scope", keys, False)]:
                    execute(label, operation(0), signing_keys, module_scope=scope, fault="The verifier must return exactly Boolean true.")
                def consumed(state): state[1] += 1
                execute("threshold-success", operation(0), module_scope=True, expected=b"\x21\x01\x07", event="UserOpExecuted", state_change=consumed)
                denied_op = A(H(verifier), S("getThreshold"), A(H(account)), I(1), I(4_102_444_800_000), B(b""))
                execute("nonallowlisted-target", denied_op, module_scope=True, fault="Target contract not in whitelist")
                for target in (verifier, hook): driver.send("configured-direct-cleanup-" + str(target == hook), target, "clearAccount", [H(account)], [owner], fault=CONTEXT)
                send("lifecycle-not-config-capability", "callVerifier", [S("clearAccount"), A()], fault="not an admitted account-scoped configuration capability")
                stage = "cleanup"
                for role, field in (("Hook", 10), ("Verifier", 9)):
                    send("propose-remove-" + role.lower(), "propose" + role, [H(ZERO)], event=role + "ChangeProposed", root_pending=field)
                    wait_delay()
                    def remove(state, role=role):
                        commit_config(state)
                        if role == "Hook": state[0][6] = None; state[6] = False
                        else: state[0][5] = None; state[4] = None; state[5] = 0
                    send("activate-remove-" + role.lower(), "activate" + role, [], event=role + "Changed", state_change=remove)
                    if role == "Hook":
                        confused = A(H(verifier), S("postExecute"), A(H(account), operation(1), NULL), I(1), I(4_102_444_800_000), B(b""))
                        execute("target-frame-not-callback", confused, module_scope=True, fault=CONTEXT)
                        execute("post-fault-positive-control", operation(1), module_scope=True, expected=b"\x21\x01\x07", event="UserOpExecuted", state_change=consumed)
                execute("retired-cosigner", operation(2), [cosigner], fault="custody witness")
                execute("custody-fallback", operation(2), [owner], expected=b"\x21\x01\x07", event="UserOpExecuted", state_change=consumed)
                stage = "recovery-module-epoch-reinstallation"
                def install_same(role, binding):
                    field=5 if role=="Verifier" else 6; pending_field=9 if role=="Verifier" else 10
                    send("reinstall-"+role.lower()+"-propose","propose"+role,[H(verifier if field==5 else hook)],
                         event=role+"ChangeProposed",root_pending=(pending_field,binding))
                    wait_delay()
                    def installed(state):commit_config(state);state[0][field]=copy.deepcopy(binding)
                    send("reinstall-"+role.lower()+"-confirm","activate"+role,[],event=role+"Changed",state_change=installed)
                verifier_binding,hook_binding=initial[0][5:7]
                install_same("Verifier",verifier_binding);install_same("Hook",hook_binding)
                def configure_again(label, signer_addresses):
                    args=[A(*[H(a) for a in signer_addresses]),I(2)]
                    send(label+"-threshold-propose","callVerifier",[S("setConfig"),A(*args)],expected=False,
                         pending=(2,0,"setConfig",[[hash_le(a) for a in signer_addresses],2],5))
                    wait_delay()
                    def configured(state):commit_config(state);state[4]=[[hash_le(a) for a in signer_addresses],2];state[5]=2
                    send(label+"-threshold-confirm","callVerifier",[S("setConfig"),A(*args)],state_change=configured)
                    send(label+"-allowlist-propose","callHook",[S("setWhitelist"),A(*allow_args)],expected=False,
                         pending=(3,1,"setWhitelist",[hash_le(STDLIB),True],6))
                    wait_delay();send(label+"-allowlist-confirm","callHook",[S("setWhitelist"),A(*allow_args)],state_change=allow)
                configure_again("before-recovery",addresses)
                before_recovery=driver.state(account);old_epoch=before_recovery[0][13]
                def old_namespace():
                    keys=[(verifier,module_storage_key(account,p,old_epoch))for p in (1,2)]
                    keys.append((hook,module_storage_key(account,1,old_epoch,hash_le(STDLIB))))
                    return [chain.rpc("getstorage",[contract,base64.b64encode(key).decode()])for contract,key in keys]
                old_storage=old_namespace();require(all(v is not None for v in old_storage),"Recovery requires initialized native and hook storage")
                guardian=recovery_keys["guardian"];replacement=recovery_keys["replacement"]
                driver.send("guardian-proposes-module-recovery",CORE,"proposeRecovery",[H(account),H(recovery_addresses["replacement"])],
                    [guardian],event="RecoveryProposed",recovery_pending=recovery_addresses["replacement"])
                chain.stop_node();chain.nx("fastfwd","1","-t","604801");chain.start_node()
                def recovered(state):
                    state[0][3]=hash_le(recovery_addresses["replacement"]);state[0][5:7]=[None,None]
                    commit_config(state);state[0][13]+=1;state[4:7]=[None,0,False]
                driver.send("execute-module-authority-recovery",CORE,"executeRecovery",[H(account)],[replacement],
                    event="RecoveryExecuted",state_change=recovered)
                recovered_state=driver.state(account)
                require(recovered_state[1]==before_recovery[1] and recovered_state[0][7]==before_recovery[0][7],"Recovery reset nonce or frozen state")
                require(old_namespace()==old_storage,"Recovery changed old-epoch policy bytes")
                for role in ("verifier","hook"):
                    require(driver.value(CORE,"getModuleDependencies",[H(account),S(role)])==[None,[],[]],"Recovery retained dependency authority")
                owner=replacement
                install_same("Verifier",verifier_binding);install_same("Hook",hook_binding)
                require(driver.state(account)[4:7]==[None,0,False],"Same-module reinstall resurrected old native/hook configuration")
                execute("old-native-signers-after-recovery",operation(driver.state(account)[1]),keys,module_scope=True,fault="No NeoNativeVerifier config")
                new_addresses=[recovery_addresses["replacement"],addresses[1]]
                configure_again("after-recovery",new_addresses)
                execute("retired-native-signer-after-new-config",operation(driver.state(account)[1]),keys,module_scope=True,
                    fault="The verifier must return exactly Boolean true.")
                execute("new-authority-native-and-hook-positive",operation(driver.state(account)[1]),[replacement,cosigner],module_scope=True,
                    expected=b"\x21\x01\x07",event="UserOpExecuted",state_change=consumed)
                require(old_namespace()==old_storage,"New authority modified old epoch namespace")
                report["recoveryEpoch"]={"before":old_epoch,"after":driver.state(account)[0][13],
                    "nativeAndHookOldConfigurationDidNotResurrect":True,"oldNamespaceUnchanged":True,"newAuthorityExecutionSucceeded":True}
                readback(); final = driver.state(account)
                report.update(networkMagic=chain.magic, accountId=account, otherAccountId=accounts[1],
                              finalConfigurationNonce=final[0][8], finalOperationNonce=final[1])
            finally:
                chain.stop_node(); report["ownedNodesStopped"] = chain.node is None
        check_runtime_receipt(build, runtime)
        require(all(sha256(artifacts/n) == h for n,h in artifact_pins.items()), "Native artifact changed during validation")
        require(all(sha256(p) == report["sourceSha256"][p.name] for p in sources), "Harness changed during validation")
        require(sha256(build_receipt) == report["sourceBuildReceiptSha256"] and sha256(module_receipt) == report["moduleBuildReceiptSha256"], "Build receipt changed")
        report.update(status="PASS", runtimeFilesMatched=True)
    except Exception as error:
        report["failure"] = {"stage": stage, "type": type(error).__name__}; raise
    finally:
        if report["status"] != "PASS": report["status"] = "FAIL"
        report["completedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        output.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("runtime", "artifacts", "build-receipt", "module-receipt", "output"): parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--dotnet", type=Path, default=shutil.which("dotnet")); args = parser.parse_args()
    require(args.dotnet is not None, "A local dotnet runtime is required")
    validate(args.runtime.resolve(), args.dotnet.resolve(), args.artifacts.resolve(), args.build_receipt.resolve(), args.module_receipt.resolve(), args.output.resolve())
