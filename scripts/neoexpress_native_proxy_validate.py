#!/usr/bin/env python3
"""Real signed native SmartAccount proxy transactions on disposable NeoExpress."""
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import shutil
import socket
import tempfile
import time
from pathlib import Path

from neoexpress_validate import (Chain, RawKey, ValidationFailure, H, B, I, S, A, ZERO,
    hash_le, hash160, decode, serialize_unsigned, serialize_witnesses, aa_proxy_rules, varint)
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require, runtime_hashes, check_readback
from neoexpress_native_service_validate import CORE, check_native, persist, transaction_system_fee, check_account_record

GAS_TOKEN = "0xd2a4cff31913016155e38e474a2c06d08be276cf"
GAS = 100_000_000
DEADLINE = 4_102_444_800_000


def push_bytes(value):
    require(len(value) <= 65535, "Diagnostic byte array exceeds PUSHDATA2")
    return ((b"\x0c" + bytes([len(value)])) if len(value) < 256 else b"\x0d" + len(value).to_bytes(2, "little")) + value


def push_integer(value):
    require(-(2**255) <= value < 2**255, "Integer is outside the signed NeoVM domain")
    if -1 <= value <= 16:
        return bytes([16 + value])
    for code, size in enumerate((1, 2, 4, 8, 16, 32)):
        if -(1 << (8 * size - 1)) <= value < (1 << (8 * size - 1)):
            return bytes([code]) + value.to_bytes(size, "little", signed=True)
    raise ValidationFailure("Unencodable Integer")


def encode_value(item):
    """Exact scalar/Array subset used by this diagnostic, not a general SDK codec."""
    kind = item.get("type")
    value = item.get("value")
    if kind == "Any":
        require(value is None, "Any must encode Null"); return b"\x0b"
    if kind == "Boolean":
        require(type(value) is bool, "Boolean coercion is forbidden"); return b"\x08" if value else b"\x09"
    if kind == "Integer": return push_integer(int(value))
    if kind == "ByteArray": return push_bytes(base64.b64decode(value, validate=True))
    if kind == "String": return push_bytes(value.encode("utf-8", errors="strict"))
    if kind == "Hash160":
        require(isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{40}", value), "Invalid Hash160")
        return push_bytes(hash_le(value))
    if kind == "Array":
        require(type(value) is list, "Array requires a list")
        return b"".join(encode_value(v) for v in reversed(value)) + push_integer(len(value)) + b"\xc0" if value else b"\xc2"
    raise ValidationFailure("Unsupported diagnostic initializer type")


def verification_script(account):
    return encode_value(H(account)) + b"\x11\xc0\x15" + push_bytes(b"verify") + push_bytes(hash_le(CORE)) + bytes.fromhex("41627d5b52")


def proxy_address(account):
    return "0x" + hash160(verification_script(account))[::-1].hex()


def application_script(account, payload, batch=False, *, authority_epoch, configuration_nonce):
    for value in (authority_epoch, configuration_nonce):
        require(type(value) is int and 0 <= value < 2**64, "Execution authority counters must be UInt64")
    return (encode_value(I(configuration_nonce)) + encode_value(I(authority_epoch)) +
            encode_value(payload) + encode_value(H(account)) + b"\x14\xc0\x1f" +
            push_bytes(b"executeUserOps" if batch else b"executeUserOp") + push_bytes(hash_le(CORE)) + bytes.fromhex("41627d5b52"))


def transfer(proxy, recipient, nonce, amount=GAS):
    return A(H(GAS_TOKEN), S("transfer"), A(H(proxy), H(recipient), I(amount), {"type": "Any", "value": None}), I(nonce), I(DEADLINE), B(b""))


def check_fault(execution, reason):
    require(execution.get("vmstate") == "FAULT", "Expected persisted FAULT")
    require(reason in (execution.get("exception") or ""), "The transaction failed for an unexpected reason")
    require(execution.get("notifications") == [], "A fault leaked committed notifications")


def check_transaction(tx, txid, script, signers, witnesses):
    require(tx.get("hash") == txid, "Transaction hash readback mismatch")
    require(base64.b64decode(tx.get("script", ""), validate=True) == script, "Application script readback mismatch")
    actual = tx.get("signers", [])
    require(len(actual) == len(signers) and all(all(a.get(k) == v for k, v in s.items()) for a, s in zip(actual, signers)), "Signer readback mismatch")
    require(tx.get("witnesses") == [{"invocation": base64.b64encode(i).decode(), "verification": base64.b64encode(v).decode()}
                                   for i, v in witnesses], "Witness script readback mismatch")
    require(isinstance(tx.get("blockhash"), str) and re.fullmatch(r"0x[0-9a-fA-F]{64}", tx["blockhash"]) and
            int(tx.get("confirmations", 0)) >= 1, "Transaction has no persisted block inclusion")


def check_admission_rejection(error, expected):
    require(expected in ("Invalid", "InvalidSignature"), "Unsupported admission control")
    description = "Invalid signature" if expected == "InvalidSignature" else "Inventory verification failed"
    require(str(error) == "rpc sendrawtransaction: " + description + " - " + expected,
            "Unexpected transaction admission rejection")


def check_state_delta(before, after, amount, consumed):
    require(after == (before[0] - amount, before[1] + amount, before[2] + consumed), "Asset balance or nonce delta differs from the declared outcome")


def abort_receiver():
    script = b"\x38"  # ABORT: deliberately fail after GAS.transfer writes and emits.
    body = b"NEF3" + b"Native rollback diagnostic".ljust(64, b"\x00") + bytes(5) + varint(len(script)) + script
    nef = body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    manifest = {"name": "NativeAbortReceiver", "groups": [], "features": {}, "supportedstandards": [],
        "abi": {"methods": [{"name": "onNEP17Payment", "parameters": [{"name": "from", "type": "Hash160"},
                {"name": "amount", "type": "Integer"}, {"name": "data", "type": "Any"}],
                "returntype": "Void", "offset": 0, "safe": False}], "events": []},
        "permissions": [], "trusts": [], "extra": None}
    return script, nef, manifest


class ProxyTransactions:
    def __init__(self, chain, owner, account, recipient, receiver, report):
        self.chain, self.owner, self.account, self.recipient, self.report = chain, owner, account, recipient, report
        self.receiver = receiver
        self.proxy = proxy_address(account)
        self.payer = {"account": "0x" + owner.script_hash[::-1].hex(), "scopes": "CalledByEntry"}
        require(chain.rpc("getversion", [])["protocol"]["network"] == chain.magic, "Wrong private network")

    def state(self):
        c = self.chain
        source, _, _ = c.rpc_invoke(GAS_TOKEN, "balanceOf", [H(self.proxy)])
        recipient, _, _ = c.rpc_invoke(GAS_TOKEN, "balanceOf", [H(self.recipient)])
        nonce, _, _ = c.rpc_invoke(CORE, "getNonce", [H(self.account), I(0)])
        return source, recipient, nonce

    def submit(self, label, payload, *, batch=False, proxy_scope="allow", expected=True, amount=0, consumed=1,
               expected_fault=None, admission_failure=None, corrupt_signature=False, noncanonical=False):
        before = self.state()
        receiver_before, _, _ = self.chain.rpc_invoke(GAS_TOKEN, "balanceOf", [H(self.receiver)])
        require(receiver_before == 0, "Abort recipient unexpectedly holds GAS")
        signers = [self.payer]
        if proxy_scope != "absent":
            rules = aa_proxy_rules(CORE, GAS_TOKEN)
            if proxy_scope == "deny": rules[0]["action"] = "Deny"
            signers += [{"account": self.proxy, "scopes": "WitnessRules", "rules": rules}]
        record = check_account_record(self.chain.rpc_invoke(CORE, "getAccount", [H(self.account)])[0])
        require(record[1] == hash_le(self.account), "Proxy authority record identity mismatch")
        script = application_script(self.account, payload, batch, authority_epoch=record[13], configuration_nonce=record[8])
        if noncanonical: script += b"\x21"  # NOP changes the exact canonical envelope.
        sysfee, netfee = transaction_system_fee(self.chain, script, signers), 2 * GAS
        height = self.chain.rpc("getblockcount", [])
        unsigned = serialize_unsigned(int.from_bytes(os.urandom(4), "little"), sysfee, netfee, height + 50, signers, script)
        digest = hashlib.sha256(unsigned).digest(); txid = "0x" + digest[::-1].hex()
        signature = self.owner.sign(self.chain.magic.to_bytes(4, "little") + digest)
        if corrupt_signature: signature = bytes([signature[0] ^ 1]) + signature[1:]
        witnesses = [(push_bytes(signature), self.owner.verification)]
        if proxy_scope != "absent": witnesses.append((b"", verification_script(self.account)))
        raw = base64.b64encode(unsigned + serialize_witnesses(witnesses)).decode()
        row = {"step": label, "txid": txid, "proxyScope": proxy_scope, "canonicalEnvelope": not noncanonical,
               "scriptSha256": hashlib.sha256(script).hexdigest(), "before": list(before),
               "committedAuthorityEpoch":record[13], "committedConfigurationNonce":record[8]}
        if admission_failure is not None:
            try: self.chain.rpc("sendrawtransaction", [raw])
            except ValidationFailure as error:
                check_admission_rejection(error, admission_failure)
            else: raise ValidationFailure("The invalid witness/envelope was admitted")
            require(txid not in self.chain.rpc("getrawmempool", []), "Rejected transaction entered the mempool")
            try: self.chain.rpc("getrawtransaction", [txid, True])
            except ValidationFailure as error:
                require(str(error) == "rpc getrawtransaction: Unknown transaction", "Unexpected transaction lookup failure")
            else: raise ValidationFailure("Rejected transaction is available in transaction readback")
            after = self.state(); check_state_delta(before, after, amount=0, consumed=0)
            receiver_after, _, _ = self.chain.rpc_invoke(GAS_TOKEN, "balanceOf", [H(self.receiver)])
            require(receiver_after == receiver_before, "Rejected transaction changed the abort recipient balance")
            row.update(admission="REJECTED", expectedReason=admission_failure, persisted=False, after=list(after),
                       absentFromMempoolAndReadback=True, abortRecipientBalance=receiver_after)
            self.report["admissionRejections"].append(row)
            print(label + ": REJECTED (" + admission_failure + ")", flush=True)
            return
        sent = self.chain.rpc("sendrawtransaction", [raw]); require(sent.get("hash") == txid, "Node accepted a different transaction hash")
        execution = None; deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try: execution = self.chain.rpc("getapplicationlog", [txid])["executions"][0]; break
            except ValidationFailure as error:
                # Only the specific not-yet-persisted result is a wait, never a VM verdict.
                if "Unknown transaction" not in str(error) and "Unknown application log" not in str(error): raise
            time.sleep(0.5)
        require(execution is not None, "Accepted transaction did not persist within the bounded wait")
        tx = self.chain.rpc("getrawtransaction", [txid, True]); check_transaction(tx, txid, script, signers, witnesses)
        if expected_fault:
            check_fault(execution, expected_fault)
        else:
            require(execution.get("vmstate") == "HALT", "Expected persisted HALT")
            stack = execution.get("stack", [])
            require(len(stack) == 1, "Unexpected operation result stack")
            result = decode(stack[0]); require(result == expected and type(result) is type(expected), "Unexpected exact operation result")
            events = execution.get("notifications", [])
            require(sum(n["contract"] == CORE and n["eventname"] == "UserOpExecuted" for n in events) == consumed, "Incorrect operation-event count")
            transfers = [n for n in events if n["contract"] == GAS_TOKEN and n["eventname"] == "Transfer"]
            require(len(transfers) == (consumed if amount else 0), "Unexpected committed asset-transfer events")
            for event in transfers:
                values = decode(event["state"])
                require(values[:2] == [hash_le(self.proxy), hash_le(self.recipient)], "Transfer event identities mismatch")
            require(sum(decode(n["state"])[2] for n in transfers) == amount, "Transfer event amount mismatch")
        after = self.state(); check_state_delta(before, after, amount, consumed)
        receiver_after, _, _ = self.chain.rpc_invoke(GAS_TOKEN, "balanceOf", [H(self.receiver)])
        require(receiver_after == receiver_before, "A fault leaked GAS to the abort recipient")
        row.update(persisted=True, vmstate=execution["vmstate"], gasConsumedDatoshi=int(execution["gasconsumed"]),
                   systemFeeDatoshi=sysfee, networkFeeDatoshi=netfee, after=list(after),
                   notifications=len(execution.get("notifications", [])), confirmedBlock=tx["blockhash"],
                   rawTransactionReadbackMatched=True, witnessBytesReadbackMatched=True,
                   abortRecipientBalance=receiver_after)
        self.report["executions"].append(row)
        print(label + ": " + execution["vmstate"], flush=True)


def validate(runtime, dotnet, output):
    report = {"schema": "smartaccount-native-proxy-private/v1", "status": "RUNNING", "publicNetworksTouched": False,
              "scope": "Actual signed native proxy, GAS balances, persisted atomic rollback and witness admission controls; not full native conformance or a cryptographic proof.",
              "runtimeMode": "Caller-supplied NeoExpress runtime; this runner does not establish build provenance. Verify the separate source-build receipt.",
              "transactions": [], "executions": [], "admissionRejections": [], "ownedNodesStopped": False,
              "sourceSha256": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in
                  ("neoexpress_native_proxy_validate.py", "neoexpress_native_service_validate.py", "neoexpress_activation_validate.py", "neoexpress_validate.py")}}
    output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(report, indent=2) + "\n")
    stage = "runtime-validation"
    try:
        hashes = runtime_hashes(runtime); report["runtimeSha256"] = hashes
        with tempfile.TemporaryDirectory(prefix="smartaccount-native-proxy-") as scratch:
            directory = Path(scratch); chain = Chain(make_runner(runtime, dotnet, directory), directory)
            try:
                stage = "private-chain-creation"
                chain.nx("create", "-o", str(chain.file)); config = json.loads(chain.file.read_text())
                config.setdefault("settings", {})[ACTIVATION_KEY] = "0"
                config["settings"]["chain.SecondsPerBlock"] = "1"
                for field in ("rpc-port", "tcp-port"):
                    with socket.socket() as sock:
                        sock.bind(("127.0.0.1", 0)); config["consensus-nodes"][0][field] = sock.getsockname()[1]
                chain.file.write_text(json.dumps(config)); chain.magic = config["magic"]; chain.rpc_port = config["consensus-nodes"][0]["rpc-port"]
                for wallet in ("owner", "recipient"): chain.nx("wallet", "create", wallet)
                _, listing = chain.nx("wallet", "list", "-j"); wallets = chain.json_from(listing); addresses = {}
                for wallet in ("owner", "recipient"):
                    accounts = wallets[wallet] if isinstance(wallets[wallet], list) else [wallets[wallet]]
                    addresses[wallet] = next(a["script-hash"] for a in accounts if a.get("account-label") == "Default")
                chain.nx("transfer", "1000", "GAS", "genesis", "owner")
                stage = "native-registration"
                account = persist(chain, report, "register", "registerAccount", [H(addresses["owner"]), B(bytes(32)), H(ZERO), H(ZERO), H(ZERO)], "AccountCreated")
                expected_id = hash160(b"NeoSmartAccount\x01" + chain.magic.to_bytes(4, "little") + hash_le(CORE) + hash_le(addresses["owner"]) + bytes(32))
                require(account == expected_id, "Native identity differs from independently derived identity")
                account_text = "0x" + account[::-1].hex(); proxy = proxy_address(account_text)
                published_proxy = chain.results(CORE, "getAccountAddress", H(account_text))
                require(published_proxy == hash_le(proxy), "Native proxy differs from the exact verification script")
                # NeoExpress transfer resolves wallet names/Base58 addresses, not
                # arbitrary UInt160 text. Invoke GAS.transfer with typed parameters.
                fund = chain.invoke_file(GAS_TOKEN, "transfer", [H(addresses["owner"]), H(proxy), I(10 * GAS), None])
                _, funded = chain.nx("contract", "invoke", str(fund), "owner", "-j")
                funding_hash = re.search(r"0x[0-9a-fA-F]{64}", funded)
                require(funding_hash is not None, "Missing proxy funding transaction")
                funding_log, _ = chain.app_log(funding_hash.group(0))
                require(funding_log["vmstate"] == "HALT" and decode(funding_log["stack"][0]) is True, "Proxy funding failed")
                report["fundingTransaction"] = funding_hash.group(0)
                receiver_script, receiver_nef, receiver_manifest = abort_receiver()
                file = directory / "abort.nef"; file.write_bytes(receiver_nef); file.with_suffix(".manifest.json").write_text(json.dumps(receiver_manifest))
                _, deployed = chain.nx("contract", "deploy", str(file), "genesis", "-j"); receiver = chain.json_from(deployed)["contract-hash"]
                stage = "signed-proxy-matrix"
                chain.start_node(); check_native(chain.rpc("getcontractstate", [CORE]))
                check_readback(chain.rpc("getcontractstate", [receiver]), receiver_script, receiver_nef, receiver_manifest)
                owner = RawKey(directory, "private-owner", chain.wallet_private_key("owner"))
                require("0x" + owner.script_hash[::-1].hex() == addresses["owner"], "Private wallet key identity mismatch")
                driver = ProxyTransactions(chain, owner, account_text, addresses["recipient"], receiver, report)
                driver.submit("missing-proxy-witness", transfer(proxy, addresses["recipient"], 0), proxy_scope="absent", expected=False)
                driver.submit("signed-proxy-transfer", transfer(proxy, addresses["recipient"], 1), amount=GAS)
                driver.submit("denying-proxy-scope", transfer(proxy, addresses["recipient"], 2), proxy_scope="deny", expected=False)
                driver.submit("recipient-callback-abort", transfer(proxy, receiver, 3), expected_fault="ABORT", consumed=0)
                driver.submit("batch-second-callback-abort", A(transfer(proxy, addresses["recipient"], 3), transfer(proxy, receiver, 4)),
                              batch=True, expected_fault="ABORT", consumed=0)
                duplicate = A(transfer(proxy, addresses["recipient"], 3), transfer(proxy, addresses["recipient"], 3))
                driver.submit("duplicate-batch-nonce", duplicate, batch=True, admission_failure="Invalid")
                driver.submit("noncanonical-tail", transfer(proxy, addresses["recipient"], 3), noncanonical=True, admission_failure="Invalid")
                driver.submit("invalid-payer-signature", transfer(proxy, addresses["recipient"], 3), corrupt_signature=True, admission_failure="InvalidSignature")
                driver.submit("signed-proxy-batch", A(transfer(proxy, addresses["recipient"], 3, GAS // 2), transfer(proxy, addresses["recipient"], 4, GAS // 2)),
                              batch=True, expected=[True, True], amount=GAS, consumed=2)
                report.update(networkMagic=chain.magic, accountId=account_text, proxy=proxy, finalState=list(driver.state()),
                    receiverReadbackMatched=True, receiverNefSha256=hashlib.sha256(receiver_nef).hexdigest(),
                    blockCount=chain.rpc("getblockcount", []), nodeVersion=chain.rpc("getversion", [])["useragent"])
                require(driver.state() == (8 * GAS, 2 * GAS, 5), "Final proxy matrix state mismatch")
            finally:
                chain.stop_node(); report["ownedNodesStopped"] = chain.node is None
        stage = "runtime-stability"; require(hashes == runtime_hashes(runtime), "Runtime changed during execution")
        report["runtimeHashesUnchanged"] = True; report["status"] = "PASS"
    except Exception as error:
        report["failure"] = {"stage": stage, "type": type(error).__name__}; raise
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
    print("PASS: actual native proxy signatures, asset transfers and persisted rollback")


if __name__ == "__main__": main()
