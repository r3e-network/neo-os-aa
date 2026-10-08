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
from neoexpress_validate import Chain, RawKey, ValidationFailure, H, B, I, ZERO, hash_le, decode, serialize_unsigned, serialize_witnesses, aa_proxy_rules
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require, runtime_hashes
from neoexpress_native_service_validate import CORE, STDLIB, check_native, persist, operation, check_account_record, transaction_system_fee, execution_arguments
from neoexpress_native_proxy_validate import push_bytes, check_transaction, check_fault, proxy_address, verification_script, check_admission_rejection, GAS
from neoexpress_native_configuration_validate import call_script, pending_log

MODULE_DELAY = 86_400_000
RECOVERY_DELAY = 604_800_000
STALE_AUTHORITY = "The SmartAccount execution authority epoch or configuration nonce is stale."


def equal_typed(left, right):
    if type(left) is not type(right): return False
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(equal_typed(a, b) for a, b in zip(left, right))
    return left == right


def check_transition(before, after, changes, nonce_delta):
    require(all(type(i) is int and i in (3, 5, 6, 7, 8, 9, 10, 11, 12, 13) for i in changes), "Recovery matrix may not mutate immutable identity/module fields")
    require(type(before) is tuple and len(before) == 2 and type(before[0]) is list and len(before[0]) == 14 and type(before[1]) is int,
            "Invalid native account/cursor observation")
    check_account_record(before[0]); check_account_record(after[0])
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

    def send(self, label, method, args, keys, *, changes=None, nonce_delta=0, event=None, fault=None, pending=None,
             prepare_only=False, prepared=None, proxy=False, admission_rejection=False):
        before = self.state(); changes = dict(changes or {})
        require(not prepare_only or prepared is None and method in ("executeUserOp", "executeUserOps"), "Only a fresh execution can be retained")
        require(not admission_rejection or prepared is not None and prepared.get('proxy') is True and fault is None,
                'Admission rejection requires a retained proxy transaction without an Application fault expectation')
        if prepared is None:
            arguments = execution_arguments(self.account, args[0], before[0]) if method in ("executeUserOp", "executeUserOps") else [H(self.account), *args]
            script = call_script(CORE, method, arguments); signers = signers_for(keys)
            if proxy:
                require(method in ('executeUserOp','executeUserOps'),'Proxy authority can only execute operations')
                signers.append({'account':proxy_address(self.account),'scopes':'WitnessRules','rules':aa_proxy_rules(CORE,STDLIB)})
            sysfee, netfee = transaction_system_fee(self.chain, script, signers), (2 if proxy else 1)*GAS
            unsigned = serialize_unsigned(int.from_bytes(os.urandom(4), "little"), sysfee, netfee, self.chain.rpc("getblockcount", []) + 50, signers, script)
            digest = hashlib.sha256(unsigned).digest(); txid = "0x" + digest[::-1].hex()
            witnesses = [(push_bytes(k.sign(self.chain.magic.to_bytes(4, "little") + digest)), k.verification) for k in keys]
            if proxy:witnesses.append((b'',verification_script(self.account)))
            raw = base64.b64encode(unsigned + serialize_witnesses(witnesses)).decode()
            if prepare_only:
                preflight=self.chain.rpc('invoketransaction',[raw])
                require(preflight.get('hash')==txid and preflight.get('network')==self.chain.magic and
                    preflight.get('verification')=='Succeed' and preflight.get('state')=='HALT' and
                    preflight.get('relayed') is False and preflight.get('mempoolChecked') is False,
                    'Retained raw must pass exact signed preflight before the authority changes')
                minimum=preflight.get('minimumrequiredfee')
                require(type(minimum) is str and minimum.isascii() and minimum.isdecimal() and int(minimum)<=sysfee,
                    'Retained raw does not reserve the actual signed preflight minimum')
                require(equal_typed(before,self.state()),'Signed preflight changed retained account state')
                return {'method':method,'raw':raw,'script':script,'signers':signers,'witnesses':witnesses,'txid':txid,
                    'systemFee':sysfee,'networkFee':netfee,'rawSha256':hashlib.sha256(base64.b64decode(raw)).hexdigest(),
                    'authorityEpoch':before[0][13],'configurationNonce':before[0][8],'proxy':proxy,
                    'preflightBeforeAuthorityChange':preflight}
        else:
            require(not keys and not args and not changes and nonce_delta==0 and (fault is not None or admission_rejection) and method==prepared['method'],
                    'Retained submission is a negative control without new signatures or arguments')
            raw,script,signers,witnesses,txid=(prepared[k] for k in ('raw','script','signers','witnesses','txid'))
            sysfee,netfee=prepared['systemFee'],prepared['networkFee']
            require(hashlib.sha256(base64.b64decode(raw)).hexdigest()==prepared['rawSha256'], 'Retained transaction bytes changed')
        try:submitted=self.chain.rpc("sendrawtransaction",[raw])
        except ValidationFailure as error:
            if not admission_rejection:raise
            check_admission_rejection(error,'Invalid')
            require(txid not in self.chain.rpc('getrawmempool',[]),'Rejected retained transaction entered mempool')
            try:self.chain.rpc('getrawtransaction',[txid,True])
            except ValidationFailure as lookup:
                require(str(lookup)=='rpc getrawtransaction: Unknown transaction','Unexpected rejected-transaction lookup failure')
            else:raise ValidationFailure('Rejected retained transaction was persisted')
            require(equal_typed(before,self.state()),'Rejected retained proxy transaction changed account state')
            self.report['admissionRejections'].append({'step':label,'txid':txid,'persisted':False,'expectedReason':'Invalid',
                'retainedRawSha256':prepared['rawSha256'],'retainedTransactionNotRebuiltOrResigned':True,
                'preflightBeforeAuthorityChange':prepared['preflightBeforeAuthorityChange'],
                'absentFromMempoolAndReadback':True,'fullAccountAndNonceMatched':True,
                'committedAuthorityEpoch':prepared['authorityEpoch'],'committedConfigurationNonce':prepared['configurationNonce']})
            print(label+': REJECTED (original proxy transaction bytes)',flush=True)
            return
        require(not admission_rejection and submitted.get("hash") == txid, "Unexpected transaction admission")
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
        if not fault and event=="RecoveryExecuted":
            require(equal_typed(values,[hash_le(self.account),before[0][3],after[0][3],after[0][8],after[0][13]]),
                    "RecoveryExecuted must expose exact old/new custody, configuration nonce and authority epoch")
        self.report["executions"].append({"step": label, "method": method, "txid": txid, "vmstate": execution["vmstate"], "persisted": True,
            "signers": [s["account"] for s in signers], "witnessBytesReadbackMatched": True, "confirmedBlock": tx["blockhash"],
            "event": event if not fault else None, "fullAccountAndNonceMatched": True, "configurationNonce": after[0][8], "authorityEpoch": after[0][13], "operationNonce": after[1],
            "gasConsumedDatoshi": int(execution["gasconsumed"]), "systemFeeDatoshi": sysfee, "networkFeeDatoshi": netfee,
            "retainedRawSha256": prepared['rawSha256'] if prepared else None,
            "retainedTransactionNotRebuiltOrResigned": prepared is not None,
            "preflightBeforeAuthorityChange":prepared['preflightBeforeAuthorityChange'] if prepared else None,
            "committedAuthorityEpoch":prepared['authorityEpoch'] if prepared else before[0][13] if method in ('executeUserOp','executeUserOps') else None,
            "committedConfigurationNonce":prepared['configurationNonce'] if prepared else before[0][8] if method in ('executeUserOp','executeUserOps') else None})
        print(label + ": " + execution["vmstate"], flush=True)


def validate(runtime, dotnet, output):
    report = {"schema": "smartaccount-native-recovery-private/v1", "status": "RUNNING", "publicNetworksTouched": False,
        "scope": "Actual multi-signer freeze/unfreeze, delayed custody recovery and retired-custody rejection; not complete lifecycle conformance or a cryptographic proof.",
        "runtimeMode": "Caller-supplied NeoExpress runtime; this runner does not establish build provenance. Verify the separate source-build receipt.",
        "transactions": [], "executions": [], "admissionRejections": [], "ownedNodesStopped": False,
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
                retained_before_configuration=driver.send("retain-before-configuration-change","executeUserOp",[operation(0)],[O],prepare_only=True)
                proxy_before_configuration=driver.send("retain-proxy-before-configuration-change","executeUserOp",[operation(0)],[O],proxy=True,prepare_only=True)
                driver.send("guardian-freeze", "freeze", [], [G], event="AccountFrozen", changes={**clear, 7: 1, 8: 1})
                driver.send("frozen-execute", "executeUserOp", [operation(0)], [O], fault="Frozen")
                driver.send("custody-only-unfreeze", "unfreeze", [], [O], fault="Unfreeze requires custody")
                driver.send("guardian-only-unfreeze", "unfreeze", [], [G], fault="Unfreeze requires custody")
                driver.send("joint-unfreeze", "unfreeze", [], [O, G], event="AccountUnfrozen", changes={**clear, 7: 0, 8: 2})
                driver.send("unchanged-custody-retained-raw-stale-after-configuration","executeUserOp",[],[],
                    prepared=retained_before_configuration,fault=STALE_AUTHORITY)
                driver.send("proxy-retained-raw-rejected-after-configuration","executeUserOp",[],[],prepared=proxy_before_configuration,admission_rejection=True)
                driver.send("custody-cannot-propose-recovery", "proposeRecovery", [H(addresses["replacement"])], [O], fault="configured recovery authority")
                driver.send("guardian-propose-recovery", "proposeRecovery", [H(addresses["replacement"])], [G], event="RecoveryProposed", pending=(12, addresses["replacement"], RECOVERY_DELAY))
                driver.send("configuration-during-recovery", "proposeHook", [H(ZERO)], [O], fault="Configuration is unavailable during custody recovery")
                driver.send("immature-recovery", "executeRecovery", [], [R], fault="immature or stale")
                driver.send("custody-cancels-before-maturity", "cancelRecovery", [], [O], event="RecoveryCancelled", changes={12: None})
                driver.send("seed-retained-module-intent", "proposeVerifier", [H(ZERO)], [O], event="VerifierChangeProposed", pending=(9, ZERO, MODULE_DELAY))
                driver.send("guardian-renews-recovery", "proposeRecovery", [H(addresses["replacement"])], [G], event="RecoveryProposed", pending=(12, addresses["replacement"], RECOVERY_DELAY))
                driver.send("active-execute-during-recovery", "executeUserOp", [operation(0)], [O], event="UserOpExecuted", nonce_delta=1)
                retained_before_recovery=driver.send("retain-before-recovery","executeUserOp",[operation(1)],[O],prepare_only=True)
                proxy_before_recovery=driver.send("retain-proxy-before-recovery","executeUserOp",[operation(1)],[O],proxy=True,prepare_only=True)
                chain.stop_node(); chain.nx("fastfwd", "1", "-t", str(RECOVERY_DELAY // 1000 + 1)); chain.start_node()
                stage = "mature-recovery-matrix"
                driver.send("custody-cannot-cancel-mature", "cancelRecovery", [], [O], fault="Custody cancellation expires at recovery maturity")
                driver.send("guardian-cancels-after-maturity", "cancelRecovery", [], [G], event="RecoveryCancelled", changes={12: None})
                driver.send("final-recovery-proposal", "proposeRecovery", [H(addresses["replacement"])], [G], event="RecoveryProposed", pending=(12, addresses["replacement"], RECOVERY_DELAY))
                chain.stop_node(); chain.nx("fastfwd", "1", "-t", str(RECOVERY_DELAY // 1000 + 1)); chain.start_node()
                driver.send("neutral-payer-executes-recovery", "executeRecovery", [], [R], event="RecoveryExecuted", changes={**clear, 3: hash_le(addresses["replacement"]), 5: None, 6: None, 8: 3, 13: 1})
                driver.send("retained-raw-stale-after-recovery","executeUserOp",[],[],prepared=retained_before_recovery,fault=STALE_AUTHORITY)
                driver.send("proxy-retained-raw-rejected-after-recovery","executeUserOp",[],[],prepared=proxy_before_recovery,admission_rejection=True)
                driver.send("retired-custody-execute", "executeUserOp", [operation(1)], [O], fault="custody witness")
                driver.send("replacement-custody-execute", "executeUserOp", [operation(1)], [N], event="UserOpExecuted", nonce_delta=1)
                driver.send("guardian-refreeze", "freeze", [], [G], event="AccountFrozen", changes={**clear, 7: 1, 8: 4})
                driver.send("retired-custody-joint-unfreeze", "unfreeze", [], [O, G], fault="Unfreeze requires custody")
                driver.send("replacement-joint-unfreeze", "unfreeze", [], [N, G], event="AccountUnfrozen", changes={**clear, 7: 0, 8: 5})
                final = driver.state(); require(final[0][1:3] == initial[0][1:3] and final[1] == 2, "Recovery changed identity or nonce history")
                expected_domain = b"NeoSmartAccount/UserOperation\x02" + chain.magic.to_bytes(4, "little") + hash_le(CORE) + hash_le(account) + final[0][13].to_bytes(8, "little") + final[0][8].to_bytes(8, "little")
                require(chain.rpc_invoke(CORE, "getAuthorizationDomain", [H(account)])[0] == expected_domain and expected_domain != domain, "Recovery did not rotate the exact authority domain")
                report.update(networkMagic=chain.magic, accountId=account, proxy=proxy_address(account), preservedIdentity=True, authorityDomainRotated=True, finalAuthorityEpoch=final[0][13],
                              finalCustody=addresses["replacement"], finalConfigurationNonce=5, finalOperationNonce=2,
                              originalSignedRawRejectedAfterConfigurationAndRecovery=True)
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
