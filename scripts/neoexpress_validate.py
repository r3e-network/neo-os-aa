#!/usr/bin/env python3
"""Private-chain validation of the AA protocol on NeoExpress.

Creates a fresh single-node NeoExpress chain in a scratch directory, deploys every
artifact under contracts/bin/v3 with the same deploy data the production tooling
uses, drives the protocol through real transactions (native backup-owner path,
escape hatch, hook callbacks, lifecycle-ABI pre-checks, session-key relay
submission, paymaster settlement, recovery cleanup with credit refund, MultiSig
and MultiHook child pre-checks, market escrow including the silent-market owner
escape, subscription pulls), reads every deployed contract back over JSON-RPC
against the local NEF and manifest, and writes a dated receipt.

Every assertion is fail-closed: the first mismatch aborts the run and the receipt
records the failure. Nothing here touches a public network, and the receipt never
contains wallet keys or absolute host paths.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "contracts" / "bin" / "v3"
ZERO = "0x0000000000000000000000000000000000000000"
ANSI = re.compile(r"\x1b\[[0-9;]*m")

# name -> (relative nef path, deploy data is the core hash)
ARTIFACTS = [
    ("UnifiedSmartWalletV3", "UnifiedSmartWalletV3.nef", False),
    ("MockTransferTarget", "MockTransferTarget.nef", False),
    ("Web3AuthVerifier", "verifiers/Web3AuthVerifier.nef", True),
    ("TEEVerifier", "verifiers/TEEVerifier.nef", True),
    ("SessionKeyVerifier", "verifiers/SessionKeyVerifier.nef", True),
    ("WebAuthnVerifier", "verifiers/WebAuthnVerifier.nef", True),
    ("ZKEmailVerifier", "verifiers/ZKEmailVerifier.nef", True),
    ("ZkLoginVerifier", "verifiers/ZkLoginVerifier.nef", True),
    ("MultiSigVerifier", "verifiers/MultiSigVerifier.nef", True),
    ("SubscriptionVerifier", "verifiers/SubscriptionVerifier.nef", True),
    ("NeoNativeVerifier", "verifiers/NeoNativeVerifier.nef", True),
    ("DailyLimitHook", "hooks/DailyLimitHook.nef", True),
    ("NeoDIDCredentialHook", "hooks/NeoDIDCredentialHook.nef", True),
    ("WhitelistHook", "hooks/WhitelistHook.nef", True),
    ("MultiHook", "hooks/MultiHook.nef", True),
    ("TokenRestrictedHook", "hooks/TokenRestrictedHook.nef", True),
    ("AAPaymaster", "AAPaymaster.nef", True),
    ("AAAddressMarket", "AAAddressMarket.nef", False),
    ("SocialRecoveryVerifier", "SocialRecoveryVerifier.nef", False),
    ("MockVerifierCore", "MockVerifierCore.nef", False),
    ("PlatformRegistrarMock", "PlatformRegistrarMock.nef", False),
    ("MarkerOnlyModule", "MarkerOnlyModule.nef", False),
    ("WrongLifecycleAbiModule", "WrongLifecycleAbiModule.nef", False),
    ("WrongHookLifecycleAbiModule", "WrongHookLifecycleAbiModule.nef", False),
]
WALLETS = ["owner", "buyer", "merchant", "relay", "sponsor", "stranger"]
ESCAPE_TIMELOCK = 2_592_000          # 30 days, seconds
DAY = 86_400
FAR_DEADLINE = 4_102_444_800_000     # 2100-01-01 in ms
GAS = 100_000_000


class ValidationFailure(Exception):
    pass


def H(value):
    return {"type": "Hash160", "value": value}


def B(raw):
    if isinstance(raw, str):
        raw = raw.encode()
    return {"type": "ByteArray", "value": base64.b64encode(raw).decode()}


def I(value):
    return {"type": "Integer", "value": str(int(value))}


def S(value):
    return {"type": "String", "value": value}


def BOOL(value):
    return {"type": "Boolean", "value": bool(value)}


def A(*items):
    return {"type": "Array", "value": list(items)}


def hash_of(b64):
    return "0x" + base64.b64decode(b64)[::-1].hex()


def decode(item):
    kind = item.get("type")
    if kind == "Integer":
        return int(item["value"])
    if kind == "Boolean":
        return bool(item["value"])
    if kind == "ByteString" or kind == "Buffer":
        return base64.b64decode(item["value"])
    if kind == "Array" or kind == "Struct":
        return [decode(x) for x in item["value"]]
    if kind == "Any":
        return None
    return item


def read_varint(data, pos):
    first = data[pos]
    if first < 0xFD:
        return first, pos + 1
    if first == 0xFD:
        return int.from_bytes(data[pos + 1:pos + 3], "little"), pos + 3
    if first == 0xFE:
        return int.from_bytes(data[pos + 1:pos + 5], "little"), pos + 5
    return int.from_bytes(data[pos + 1:pos + 9], "little"), pos + 9


def nef_script(path):
    """Script bytes and checksum of a NEF file (NEF3 layout)."""
    data = path.read_bytes()
    if data[:4] != b"NEF3":
        raise ValidationFailure(f"{path.name}: not a NEF3 file")
    pos = 4 + 64
    length, pos = read_varint(data, pos)
    pos += length                      # source
    pos += 1                           # reserved
    count, pos = read_varint(data, pos)
    for _ in range(count):
        pos += 20
        length, pos = read_varint(data, pos)
        pos += length + 2 + 1 + 1      # method, parameters count, has return, call flags
    pos += 2                           # reserved
    length, pos = read_varint(data, pos)
    script = data[pos:pos + length]
    checksum = int.from_bytes(data[-4:], "little")
    expected = int.from_bytes(hashlib.sha256(hashlib.sha256(data[:-4]).digest()).digest()[:4], "little")
    if checksum != expected:
        raise ValidationFailure(f"{path.name}: checksum mismatch")
    return script, checksum


def der_to_rs(der):
    """ASN.1 DER ECDSA signature -> 64-byte r||s."""
    assert der[0] == 0x30
    pos = 2
    assert der[pos] == 0x02
    rlen = der[pos + 1]
    r = der[pos + 2:pos + 2 + rlen]
    pos += 2 + rlen
    assert der[pos] == 0x02
    slen = der[pos + 1]
    s = der[pos + 2:pos + 2 + slen]
    r = r.lstrip(b"\x00").rjust(32, b"\x00")
    s = s.lstrip(b"\x00").rjust(32, b"\x00")
    return r + s


class P256Key:
    """Host-side P-256 key backed by the openssl CLI (no Python crypto dependency)."""

    def __init__(self, workdir, name):
        self.pem = Path(workdir) / f"{name}.pem"
        subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", str(self.pem)],
                       check=True, capture_output=True)
        der = subprocess.run(["openssl", "ec", "-in", str(self.pem), "-pubout", "-conv_form", "compressed",
                              "-outform", "DER"], check=True, capture_output=True).stdout
        self.compressed = der[-33:]
        if self.compressed[0] not in (2, 3):
            raise ValidationFailure("unexpected compressed public key encoding")

    def sign(self, payload):
        with tempfile.NamedTemporaryFile(delete=False) as handle:
            handle.write(payload)
            path = handle.name
        try:
            der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(self.pem), path],
                                 check=True, capture_output=True).stdout
        finally:
            os.unlink(path)
        return der_to_rs(der)


def dotnet_root():
    """The neoxp tool is a framework-dependent app host that finds its runtime through
    DOTNET_ROOT. Homebrew installs the runtime under libexec, which the app host does not
    probe on its own, so derive the root from the runtime listing when it is not set."""
    try:
        listing = subprocess.run(["dotnet", "--list-runtimes"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValidationFailure(f"dotnet runtime listing unavailable: {error}") from error
    for line in listing.splitlines():
        if line.startswith("Microsoft.NETCore.App ") and "[" in line:
            shared = Path(line[line.index("[") + 1:line.rindex("]")])
            return str(shared.parent.parent)
    raise ValidationFailure("no Microsoft.NETCore.App runtime found; set DOTNET_ROOT explicitly")


class Chain:
    def __init__(self, neoxp, workdir):
        self.neoxp = neoxp
        self.workdir = Path(workdir)
        self.file = self.workdir / "aa-validation.neo-express"
        self.env = dict(os.environ)
        self.env.setdefault("DOTNET_ROOT", dotnet_root())
        self.invoke_counter = 0
        self.wallets = {}
        self.contracts = {}
        self.timelocks = {}
        self.deployments = []
        self.scenarios = []
        self.simulated_seconds = 0
        self.node = None
        self.node_log = None
        self.current = None

    # ---- process plumbing -------------------------------------------------
    def nx(self, *args, check=True):
        # `create` names the chain file with -o; every other command takes it with -i.
        command = [self.neoxp, *args] if args and args[0] == "create" else [self.neoxp, *args, "-i", str(self.file)]
        completed = subprocess.run(command, capture_output=True, text=True, env=self.env)
        text = ANSI.sub("", completed.stdout + completed.stderr)
        if check and completed.returncode != 0:
            raise ValidationFailure(f"neoxp {' '.join(args[:3])} failed: {text.strip()[:400]}")
        return completed.returncode, text

    @staticmethod
    def json_from(text):
        start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
        if start < 0:
            raise ValidationFailure(f"no JSON in output: {text[:200]}")
        return json.loads(text[start:])

    def invoke_file(self, contract, operation, args):
        self.invoke_counter += 1
        path = self.workdir / f"invoke-{self.invoke_counter}.neo-invoke.json"
        path.write_text(json.dumps([{"contract": contract, "operation": operation, "args": args}]))
        return path

    # ---- chain lifecycle --------------------------------------------------
    def create(self):
        self.nx("create", "-o", str(self.file), "-f")
        for name in WALLETS:
            self.nx("wallet", "create", name)
        _, text = self.nx("wallet", "list", "-j")
        listing = self.json_from(text)
        for name, value in listing.items():
            accounts = value if isinstance(value, list) else [value]
            for account in accounts:
                if name == "genesis" or account.get("account-label") == "Default":
                    self.wallets[name] = account["script-hash"]
        for name in WALLETS:
            self.nx("transfer", "5000", "GAS", "genesis", name)
        config = json.loads(self.file.read_text())
        self.magic = config.get("magic")
        self.rpc_port = config["consensus-nodes"][0]["rpc-port"]

    def deploy_all(self):
        core = None
        for name, relative, needs_core in ARTIFACTS:
            nef = BIN / relative
            manifest = nef.with_name(nef.name.replace(".nef", ".manifest.json"))
            args = ["contract", "deploy", str(nef), "genesis", "-j"]
            if needs_core:
                # neoxp passes a 0x-prefixed --data literally as bytes, so the 20-byte value must be
                # given in the little-endian order a UInt160 ByteString carries on the VM.
                args += ["-d", "0x" + bytes.fromhex(core[2:])[::-1].hex()]
            _, text = self.nx(*args)
            result = self.json_from(text)
            if result["contract-name"] != name:
                raise ValidationFailure(f"deployed name {result['contract-name']} != {name}")
            self.contracts[name] = result["contract-hash"]
            if name == "UnifiedSmartWalletV3":
                core = result["contract-hash"]
            self.deployments.append({
                "contractName": name,
                "contractHash": result["contract-hash"],
                "deploymentTransaction": result["tx-hash"],
                "deployData": "core hash" if needs_core else None,
                "localNefSha256": hashlib.sha256(nef.read_bytes()).hexdigest(),
                "localManifestSha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
            })
        self.core = core
        for name, _, needs_core in ARTIFACTS:
            if needs_core and self.hash_result(name, "authorizedCore") != core:
                raise ValidationFailure(f"{name}: authorizedCore does not decode to the core hash")

    # ---- invocation helpers ----------------------------------------------
    def results(self, contract, operation, *args):
        path = self.invoke_file(contract, operation, list(args))
        _, text = self.nx("contract", "invoke", str(path), "-r", "-j")
        result = self.json_from(text)
        if result.get("state") != "HALT":
            raise ValidationFailure(f"{contract}.{operation} results call faulted: {result.get('exception')}")
        stack = result.get("stack") or []
        return decode(stack[0]) if stack else None

    def estimate(self, contract, operation, args, account):
        """Gas the pre-submission simulation charges for this invocation with the given signer:
        the zero-fee container standard tooling prices a transaction with."""
        path = self.invoke_file(contract, operation, list(args))
        _, text = self.nx("contract", "invoke", str(path), account, "-r", "-j")
        result = self.json_from(text)
        if result.get("state") != "HALT":
            raise ValidationFailure(f"{contract}.{operation} estimation faulted: {result.get('exception')}")
        return int(result["gasconsumed"])

    def app_log(self, txid):
        _, text = self.nx("show", "transaction", txid)
        result = self.json_from(text)
        execution = result["application-log"]["executions"][0]
        transaction = result["transaction"]
        return execution, transaction

    def tx(self, step, contract, operation, args, account, scope=None, expect_fault=None):
        path = self.invoke_file(contract, operation, list(args))
        command = ["contract", "invoke", str(path), account, "-j"]
        if scope:
            command += ["-w", scope]
        rc, text = self.nx(*command, check=False)
        record = {"step": step, "contract": contract, "operation": operation, "signer": account,
                  "witnessScope": scope or "CalledByEntry"}
        if rc != 0:
            reason = re.search(r"Reason: ([^\n]*)", text)
            reason = reason.group(1).strip() if reason else text.strip()[-300:]
            record["outcome"] = "FAULT"
            record["exception"] = reason
            if expect_fault is None:
                raise ValidationFailure(f"{step}: unexpected fault: {reason}")
            if expect_fault not in reason:
                raise ValidationFailure(f"{step}: expected fault containing {expect_fault!r}, got {reason!r}")
            record["expectedFault"] = expect_fault
        else:
            match = re.search(r"0x[0-9a-fA-F]{64}", text)
            if match is None:
                raise ValidationFailure(f"{step}: no transaction id in output: {text.strip()[:200]}")
            txid = match.group(0)
            execution, transaction = self.app_log(txid)
            record["txid"] = txid
            record["outcome"] = execution["vmstate"]
            record["gasConsumed"] = int(execution["gasconsumed"])
            record["systemFee"] = int(transaction.get("sysfee", 0))
            record["networkFee"] = int(transaction.get("netfee", 0))
            if execution.get("exception"):
                record["exception"] = execution["exception"]
            record["events"] = [n["eventname"] for n in execution.get("notifications", [])]
            stack = execution.get("stack") or []
            record["result"] = decode(stack[0]) if stack and stack[0].get("type") not in ("Any",) else None
            if isinstance(record["result"], bytes):
                record["result"] = record["result"].hex()
            if expect_fault is not None:
                raise ValidationFailure(f"{step}: expected fault {expect_fault!r} but transaction halted")
            if execution["vmstate"] != "HALT":
                raise ValidationFailure(f"{step}: vmstate {execution['vmstate']}: {execution.get('exception')}")
        self.current["steps"].append(record)
        return record

    def check(self, condition, description):
        self.current["assertions"].append({"check": description, "ok": bool(condition)})
        if not condition:
            raise ValidationFailure(f"{self.current['name']}: assertion failed: {description}")

    def fastfwd(self, seconds):
        self.nx("fastfwd", "1", "-t", str(int(seconds)))
        self.simulated_seconds += int(seconds)
        self.current["steps"].append({"step": f"fastfwd +{int(seconds)}s", "outcome": "minted"})

    def events(self, contract, event):
        _, text = self.nx("show", "notifications", "-c", contract, "-e", event)
        try:
            return self.json_from(text)
        except ValidationFailure:
            return []

    def now(self):
        return self.results("MockVerifierCore", "now")

    def gas_balance(self, hash_or_name):
        target = self.contracts.get(hash_or_name) or self.wallets.get(hash_or_name) or hash_or_name
        return self.results("GasToken", "balanceOf", H(target))

    def scenario(self, name):
        self.current = {"name": name, "steps": [], "assertions": []}
        self.scenarios.append(self.current)
        return self.current

    # ---- protocol helpers --------------------------------------------------
    def register(self, step, verifier=ZERO, params=b"", hook=ZERO, owner="owner", expect_fault=None):
        # The account id is derived from the registration inputs, so two registrations with the
        # same verifier, hook and owner would collide. Each registration gets its own escape
        # timelock (the id covers it), which stays inside the core's 7 to 90 day window; the
        # escape scenario reads the timelock it must wait out from this table.
        timelock = ESCAPE_TIMELOCK + len(self.timelocks)
        account = self.results("UnifiedSmartWalletV3", "computeRegistrationAccountId",
                               H(verifier), B(params), H(hook), H(self.wallets[owner]), I(timelock))
        account = "0x" + account[::-1].hex()
        self.timelocks[account] = timelock
        self.tx(step, "UnifiedSmartWalletV3", "registerAccount",
                [H(account), H(verifier), B(params), H(hook), H(self.wallets[owner]), I(timelock)],
                owner, expect_fault=expect_fault)
        if expect_fault:
            return None
        proxy = "0x" + self.results("UnifiedSmartWalletV3", "getProxyScriptHash", H(account))[::-1].hex()
        return account, proxy

    def transfer_op(self, target, source, recipient, amount, nonce, deadline=FAR_DEADLINE, signature=b""):
        return A(H(target), S("transfer"), A(H(source), H(recipient), I(amount), B(b"")),
                 I(nonce), I(deadline), B(signature))

    def execute(self, step, account, op, signer, expect_fault=None, scope=None):
        return self.tx(step, "UnifiedSmartWalletV3", "executeUserOp", [H(account), op], signer,
                       scope=scope, expect_fault=expect_fault)

    def nonce(self, account, channel=0):
        return self.results("UnifiedSmartWalletV3", "getNonce", H(account), I(channel))

    def hash_result(self, contract, operation, *args):
        raw = self.results(contract, operation, *args)
        return "0x" + raw[::-1].hex() if isinstance(raw, bytes) else raw

    def two_phase(self, step, account, kind, method, args, signer="owner", expect_fault=None):
        """callVerifier/callHook: first call arms the 24h timelock, the second executes."""
        entry = "callVerifier" if kind == "verifier" else "callHook"
        first = self.tx(step + " (arm)", "UnifiedSmartWalletV3", entry, [H(account), S(method), A(*args)], signer)
        self.check(first["result"] is False, f"{step}: first call arms the timelock and returns false")
        self.fastfwd(DAY)
        return self.tx(step + " (execute)", "UnifiedSmartWalletV3", entry, [H(account), S(method), A(*args)],
                       signer, expect_fault=expect_fault)

    # ---- RPC readback -------------------------------------------------------
    def rpc(self, method, params):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{self.rpc_port}", data=body,
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())["result"]

    def readback(self):
        self.node_log = (self.workdir / "node.log").open("w")
        self.node = subprocess.Popen([self.neoxp, "run", "-i", str(self.file), "-s", "1"],
                                     stdout=self.node_log, stderr=subprocess.STDOUT, env=self.env)
        try:
            for _ in range(60):
                time.sleep(1)
                if self.node.poll() is not None:
                    raise ValidationFailure(f"node exited with code {self.node.returncode} before answering RPC; "
                                            f"see {self.workdir / 'node.log'}")
                try:
                    self.rpc("getversion", [])
                    break
                except Exception:
                    continue
            else:
                raise ValidationFailure("node did not answer RPC")
            block_count = self.rpc("getblockcount", [])
            rows = []
            for name, relative, _ in ARTIFACTS:
                nef = BIN / relative
                manifest = json.loads(nef.with_name(nef.name.replace(".nef", ".manifest.json")).read_text())
                local_script, local_checksum = nef_script(nef)
                state = self.rpc("getcontractstate", [self.contracts[name]])
                remote_script = base64.b64decode(state["nef"]["script"])
                row = {
                    "contractName": name,
                    "contractHash": self.contracts[name],
                    "nefScriptByteEquality": remote_script == local_script,
                    "nefChecksumEquality": int(state["nef"]["checksum"]) == local_checksum,
                    "manifestSemanticEquality": state["manifest"] == manifest,
                    "nefScriptSha256": hashlib.sha256(remote_script).hexdigest(),
                    "nefScriptLength": len(remote_script),
                    "nefChecksum": int(state["nef"]["checksum"]),
                }
                if not (row["nefScriptByteEquality"] and row["nefChecksumEquality"] and row["manifestSemanticEquality"]):
                    raise ValidationFailure(f"RPC readback parity failed for {name}: {row}")
                rows.append(row)
            return {"blockCountAtReadback": block_count, "contracts": rows}
        finally:
            self.stop_node()

    def stop_node(self):
        # The node is our own child process, so it is stopped directly. `neoxp stop` talks to
        # the node over RPC and was observed to block indefinitely after the readback completed.
        node, self.node = self.node, None
        if node is None:
            return
        if node.poll() is None:
            node.terminate()
            try:
                node.wait(timeout=20)
            except subprocess.TimeoutExpired:
                node.kill()
                node.wait(timeout=5)
        self.node_log.close()


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------
def scenario_native_execution(c):
    c.scenario("core native backup-owner execution")
    account, proxy = c.register("register native account")
    owner = c.wallets["owner"]
    c.check(c.hash_result("UnifiedSmartWalletV3", "getBackupOwner", H(account)) == owner, "backup owner recorded")
    target = c.contracts["MockTransferTarget"]
    c.execute("executeUserOp nonce 0", account, c.transfer_op(target, proxy, c.wallets["buyer"], 1000, 0), "owner")
    c.check(c.nonce(account) == 1, "channel 0 cursor advanced to 1")
    c.execute("replay nonce 0", account, c.transfer_op(target, proxy, c.wallets["buyer"], 1000, 0), "owner",
              expect_fault="Invalid sequence for channel")
    c.check(c.nonce(account) == 1, "replay leaves the cursor unchanged")
    c.tx("executeUserOps batch nonces 1,2", "UnifiedSmartWalletV3", "executeUserOps",
         [H(account), A(c.transfer_op(target, proxy, c.wallets["buyer"], 1000, 1),
                        c.transfer_op(target, proxy, c.wallets["buyer"], 1000, 2))], "owner")
    c.check(c.nonce(account) == 3, "batch consumed two sequential nonces")
    c.execute("stranger witness", account, c.transfer_op(target, proxy, c.wallets["buyer"], 1000, 3), "stranger",
              expect_fault="Native witness failed")
    c.execute("expired deadline", account, c.transfer_op(target, proxy, c.wallets["buyer"], 1000, 3, deadline=1),
              "owner", expect_fault="UserOp expired")
    oversized = A(H(target), S("transfer"), A(*([I(0)] * 65)), I(3), I(FAR_DEADLINE), B(b""))
    c.execute("65 arguments", account, oversized, "owner", expect_fault="Arguments exceed protocol limit")
    c.execute("channel 1 sequence 0", account,
              c.transfer_op(target, proxy, c.wallets["buyer"], 1000, 1 << 64), "owner")
    c.check(c.nonce(account, 1) == 1 and c.nonce(account, 0) == 3, "channels are independent lanes")
    preview = c.results("UnifiedSmartWalletV3", "previewUserOpValidation", H(account),
                        c.transfer_op(target, proxy, c.wallets["buyer"], 1000, 3))
    c.check(preview[0] is True and preview[1] is True and preview[2] is False, "preview reports deadline, nonce, no verifier")
    return account, proxy


def scenario_escape(c, account, proxy):
    c.scenario("escape hatch")
    target = c.contracts["MockTransferTarget"]
    c.tx("initiateEscape", "UnifiedSmartWalletV3", "initiateEscape", [H(account)], "owner")
    c.check(c.results("UnifiedSmartWalletV3", "isEscapeActive", H(account)) is True, "escape active")
    record = c.execute("owner execution cancels escape", account,
                       c.transfer_op(target, proxy, c.wallets["buyer"], 1000, 3), "owner")
    c.check("EscapeCancelled" in record["events"], "EscapeCancelled emitted")
    c.check(c.results("UnifiedSmartWalletV3", "isEscapeActive", H(account)) is False, "escape cleared")
    c.tx("initiateEscape inside cooldown", "UnifiedSmartWalletV3", "initiateEscape", [H(account)], "owner",
         expect_fault="Escape cooldown active")
    c.fastfwd(3600)
    c.tx("initiateEscape after cooldown", "UnifiedSmartWalletV3", "initiateEscape", [H(account)], "owner")
    c.tx("finalizeEscape before timelock", "UnifiedSmartWalletV3", "finalizeEscape", [H(account), H(ZERO)], "owner",
         expect_fault="Timelock active")
    c.fastfwd(c.timelocks[account])
    record = c.tx("finalizeEscape after timelock", "UnifiedSmartWalletV3", "finalizeEscape",
                  [H(account), H(ZERO)], "owner")
    c.check("EscapeFinalized" in record["events"], "EscapeFinalized emitted")
    c.check(c.results("UnifiedSmartWalletV3", "isEscapeActive", H(account)) is False, "escape finalized")


def scenario_hook(c):
    c.scenario("whitelist hook callback tuple")
    hook = c.contracts["WhitelistHook"]
    target = c.contracts["MockTransferTarget"]
    account, proxy = c.register("register account with WhitelistHook", hook=hook)
    c.check(c.hash_result("UnifiedSmartWalletV3", "getHook", H(account)) == hook, "hook bound")
    c.two_phase("setWhitelist", account, "hook", "setWhitelist", [H(account), H(target), BOOL(True)])
    c.check(c.results("WhitelistHook", "isWhitelisted", H(account), H(target)) is True, "target whitelisted")
    c.execute("whitelisted target", account, c.transfer_op(target, proxy, c.wallets["buyer"], 1, 0), "owner")
    c.check(c.nonce(account) == 1, "whitelisted op consumed nonce 0")
    blocked = A(H(c.contracts["TEEVerifier"]), S("supportsV3"), A(), I(1), I(FAR_DEADLINE), B(b""))
    c.execute("unlisted target", account, blocked, "owner", expect_fault="Target contract not in whitelist")
    c.check(c.nonce(account) == 1, "rejected pre-hook leaves the nonce unchanged")


def scenario_abi_precheck(c):
    c.scenario("lifecycle ABI pre-check")
    c.register("verifier with marker only", verifier=c.contracts["MarkerOnlyModule"],
               expect_fault="Verifier V3 validation ABI missing")
    c.register("verifier with wrong return type", verifier=c.contracts["WrongLifecycleAbiModule"],
               expect_fault="Verifier V3 validation ABI missing")
    c.register("hook with marker only", hook=c.contracts["MarkerOnlyModule"],
               expect_fault="Hook V3 pre ABI missing")
    c.register("hook with wrong return type", hook=c.contracts["WrongHookLifecycleAbiModule"],
               expect_fault="Hook V3 pre ABI missing")
    for name in ("Web3AuthVerifier", "TEEVerifier", "WebAuthnVerifier", "NeoNativeVerifier",
                 "MultiSigVerifier", "SubscriptionVerifier", "ZkLoginVerifier", "ZKEmailVerifier"):
        c.register(f"verifier {name} passes the pre-check", verifier=c.contracts[name])
    for name in ("DailyLimitHook", "TokenRestrictedHook", "NeoDIDCredentialHook", "MultiHook"):
        c.register(f"hook {name} passes the pre-check", hook=c.contracts[name])


def scenario_session_key_and_paymaster(c, workdir):
    c.scenario("session-key relay submission and paymaster settlement")
    verifier = c.contracts["SessionKeyVerifier"]
    target = c.contracts["MockTransferTarget"]
    account, proxy = c.register("register account with SessionKeyVerifier", verifier=verifier)
    key = P256Key(workdir, "session")
    # The two-phase call executes 24h after it is armed; keep the key inside the 30-day cap
    # while leaving it valid for the rest of the scenario.
    valid_until = c.now() + 20 * DAY * 1000
    c.two_phase("setSessionKey", account, "verifier", "setSessionKey",
                [H(account), B(key.compressed), H(target), S("transfer"), I(valid_until), I(0), S("neoexpress")])
    session = c.results("SessionKeyVerifier", "getSessionKey", H(account))
    c.check(session[0] == key.compressed, "session key stored")

    def signed_op(nonce):
        args = A(H(proxy), H(c.wallets["buyer"]), I(1000), B(b""))
        payload = c.results("SessionKeyVerifier", "getPayload", H(account), H(target), S("transfer"), args,
                            I(nonce), I(FAR_DEADLINE))
        return A(H(target), S("transfer"), args, I(nonce), I(FAR_DEADLINE), B(key.sign(payload)))

    record = c.execute("relay submits session-signed op", account, signed_op(0), "relay")
    c.check(record["outcome"] == "HALT" and c.nonce(account) == 1, "relay-only submission accepted by the verifier")
    forged = A(H(target), S("transfer"), A(H(proxy), H(c.wallets["buyer"]), I(1000), B(b"")),
               I(1), I(FAR_DEADLINE), B(bytes(64)))
    c.execute("relay submits zero signature", account, forged, "relay", expect_fault="Verifier rejected signature")

    paymaster = c.contracts["AAPaymaster"]
    sponsor = c.wallets["sponsor"]
    c.tx("sponsor deposits 100 GAS", "GasToken", "transfer", [H(sponsor), H(paymaster), I(100 * GAS), B(b"")], "sponsor")
    c.check(c.results("AAPaymaster", "getSponsorDeposit", H(sponsor)) == 100 * GAS, "deposit credited")
    c.tx("sponsor sets policy", "AAPaymaster", "setPolicy",
         [H(account), H(target), S("transfer"), I(5 * GAS), I(0), I(0), I(0)], "sponsor")
    relay_before = c.gas_balance("relay")
    sponsored = [H(account), signed_op(1), H(paymaster), H(sponsor), I(5 * GAS)]
    # The zero-fee estimation container settles the request; the persisted transaction settles
    # the capped amount. The cap is branch-free so both charge exactly the same gas, which is
    # what lets a relay price a sponsored operation with a plain invokescript.
    estimated = c.estimate("UnifiedSmartWalletV3", "executeSponsoredUserOp", sponsored, "relay")
    record = c.tx("relay executes sponsored op", "UnifiedSmartWalletV3", "executeSponsoredUserOp", sponsored, "relay")
    record["estimatedGas"] = estimated
    c.check(record["gasConsumed"] == estimated,
            f"zero-fee estimation ({estimated}) equals the persisted gas ({record['gasConsumed']}) to the datoshi")
    c.check("SponsoredUserOpExecuted" in record["events"], "SponsoredUserOpExecuted emitted")
    settled = min(5 * GAS, record["systemFee"] + record["networkFee"])
    deposit = c.results("AAPaymaster", "getSponsorDeposit", H(sponsor))
    c.check(deposit == 100 * GAS - settled, f"sponsor deposit reduced by the capped reimbursement {settled}")
    relay_after = c.gas_balance("relay")
    c.check(relay_after - relay_before == settled - record["systemFee"] - record["networkFee"],
            "relay net GAS change equals reimbursement minus the fees it paid")
    c.check(c.nonce(account) == 2, "sponsored op consumed nonce 1")


def scenario_recovery_cleanup(c, workdir):
    c.scenario("recovery verifier rotation with cleanup and credit refund")
    recovery = c.contracts["SocialRecoveryVerifier"]
    c.tx("admin pins the core on the recovery verifier", "SocialRecoveryVerifier", "setAuthorizedCore",
         [H(c.core)], "genesis")
    account, proxy = c.register("register account with SocialRecoveryVerifier", verifier=recovery)
    morpheus = P256Key(workdir, "morpheus")
    factor = bytes(range(1, 33))
    c.tx("setupRecovery", "SocialRecoveryVerifier", "setupRecovery",
         [H(account), S(account), S("neo3-express"), H(c.wallets["owner"]), H(c.core), H(proxy),
          H(c.wallets["stranger"]), A(B(factor)), I(1), I(604_800_000), B(morpheus.compressed)], "owner")
    c.check(c.hash_result("SocialRecoveryVerifier", "getOwner", H(account)) == c.wallets["owner"], "recovery owner set")
    credit = int(2.5 * GAS)
    c.tx("owner earmarks oracle credit", "GasToken", "transfer",
         [H(c.wallets["owner"]), H(recovery), I(credit), H(account)], "owner")
    c.check(c.results("SocialRecoveryVerifier", "getOracleCredit", H(account)) == credit, "oracle credit earmarked")
    c.tx("updateVerifier to none", "UnifiedSmartWalletV3", "updateVerifier", [H(account), H(ZERO), B(b"")], "owner")
    c.tx("confirm before timelock", "UnifiedSmartWalletV3", "confirmVerifierUpdate", [H(account)], "owner",
         expect_fault="Timelock not elapsed")
    c.fastfwd(DAY)
    owner_before = c.gas_balance("owner")
    record = c.tx("confirmVerifierUpdate", "UnifiedSmartWalletV3", "confirmVerifierUpdate", [H(account)], "owner")
    c.check("RecoveryCleared" in record["events"], "RecoveryCleared emitted by the outgoing verifier")
    c.check(c.hash_result("UnifiedSmartWalletV3", "getVerifier", H(account)) == ZERO, "verifier detached")
    c.check(c.hash_result("SocialRecoveryVerifier", "getOwner", H(account)) == ZERO, "recovery owner cleared")
    c.check(c.results("SocialRecoveryVerifier", "getOracleCredit", H(account)) == 0, "credit record cleared")
    owner_after = c.gas_balance("owner")
    c.check(owner_after - owner_before == credit - record["systemFee"] - record["networkFee"],
            "owner received the credit refund net of the fees paid")


def scenario_multisig(c):
    c.scenario("MultiSig child pre-check")
    multisig = c.contracts["MultiSigVerifier"]
    account, _ = c.register("register account with MultiSigVerifier", verifier=multisig)
    children = A(H(c.contracts["Web3AuthVerifier"]), H(c.contracts["TEEVerifier"]))
    c.two_phase("setConfig 1-of-2", account, "verifier", "setConfig", [H(account), children, I(1)])
    config = c.results("MultiSigVerifier", "getConfig", H(account))
    c.check(len(config[0]) == 2 and config[1] == 1, "configuration stored")
    c.two_phase("setConfig with marker-only child", account, "verifier", "setConfig",
                [H(account), A(H(c.contracts["MarkerOnlyModule"])), I(1)],
                expect_fault="Child verifier validation ABI missing")
    c.two_phase("setConfig containing itself", account, "verifier", "setConfig",
                [H(account), A(H(multisig)), I(1)], expect_fault="MultiSig verifier cannot contain itself")
    c.two_phase("setConfig with undeployed child", account, "verifier", "setConfig",
                [H(account), A(H("0x1111111111111111111111111111111111111111")), I(1)],
                expect_fault="Child verifier is not deployed")


def scenario_multihook(c):
    c.scenario("MultiHook child pre-check")
    account, _ = c.register("register account with MultiHook", hook=c.contracts["MultiHook"])
    hooks = A(H(c.contracts["WhitelistHook"]), H(c.contracts["TokenRestrictedHook"]))
    c.two_phase("setHooks", account, "hook", "setHooks", [H(account), hooks])
    c.check(len(c.results("MultiHook", "getHooks", H(account))) == 2, "two child hooks stored")
    c.two_phase("setHooks with marker-only child", account, "hook", "setHooks",
                [H(account), A(H(c.contracts["MarkerOnlyModule"]))], expect_fault="Child hook pre ABI missing")


def scenario_market(c):
    c.scenario("market escrow: sale, owner escape, silent market")
    market = c.contracts["AAAddressMarket"]
    target = c.contracts["MockTransferTarget"]
    c.tx("admin allowlists the core", "AAAddressMarket", "setAllowedAA", [H(c.core), BOOL(True)], "genesis")

    account, proxy = c.register("register account for sale")
    c.tx("createListing", "AAAddressMarket", "createListing",
         [H(c.core), H(account), I(GAS), S("AA address"), S("")], "owner", scope="Global")
    listing = c.results("AAAddressMarket", "getListingCount")
    c.check(c.results("UnifiedSmartWalletV3", "isMarketEscrowActive", H(account)) is True, "escrow armed")
    c.execute("execution while escrowed", account, c.transfer_op(target, proxy, c.wallets["buyer"], 1, 0), "owner",
              expect_fault="Account locked in market escrow")
    c.tx("buyer pays the price", "GasToken", "transfer",
         [H(c.wallets["buyer"]), H(market), I(GAS), I(listing)], "buyer")
    c.check(c.results("AAAddressMarket", "getPendingPaymentOf", I(listing), H(c.wallets["buyer"])) == GAS,
            "payment escrowed by the market")
    record = c.tx("settleListing", "AAAddressMarket", "settleListing",
                  [I(listing), H(c.wallets["buyer"]), H(c.wallets["buyer"])], "buyer")
    c.check("MarketEscrowSettled" in record["events"], "MarketEscrowSettled emitted")
    c.check(c.hash_result("UnifiedSmartWalletV3", "getBackupOwner", H(account)) == c.wallets["buyer"],
            "buyer owns the shell")
    c.check(c.results("UnifiedSmartWalletV3", "isMarketEscrowActive", H(account)) is False, "escrow cleared")
    c.execute("buyer controls the account", account, c.transfer_op(target, proxy, c.wallets["owner"], 1, 0), "buyer")

    account, _ = c.register("register account for owner escape")
    c.tx("createListing (stuck)", "AAAddressMarket", "createListing",
         [H(c.core), H(account), I(GAS), S("stuck"), S("")], "owner", scope="Global")
    listing = c.results("AAAddressMarket", "getListingCount")
    c.tx("initiateMarketEscrowCancel", "UnifiedSmartWalletV3", "initiateMarketEscrowCancel", [H(account)], "owner")
    c.tx("forceCancel before timelock", "UnifiedSmartWalletV3", "forceCancelMarketEscrow", [H(account)], "owner",
         expect_fault="Owner cancel timelock active")
    c.fastfwd(7 * DAY)
    c.tx("forceCancelMarketEscrow", "UnifiedSmartWalletV3", "forceCancelMarketEscrow", [H(account)], "owner")
    c.check(c.results("UnifiedSmartWalletV3", "isMarketEscrowActive", H(account)) is False, "owner reclaimed the account")
    c.check(c.results("AAAddressMarket", "getListing", I(listing))[7] == 3, "market listing flipped to Cancelled")

    account, _ = c.register("register account for silent market")
    silent = c.contracts["MockVerifierCore"]
    c.tx("silent market arms the escrow", "MockVerifierCore", "forward",
         [H(c.core), S("enterMarketEscrow"), A(H(account), H(silent), I(1))], "owner", scope="Global")
    c.check(c.results("UnifiedSmartWalletV3", "isMarketEscrowActive", H(account)) is True, "silent escrow armed")
    c.tx("initiateMarketEscrowCancel (silent)", "UnifiedSmartWalletV3", "initiateMarketEscrowCancel",
         [H(account)], "owner")
    c.fastfwd(7 * DAY)
    c.tx("forceCancelMarketEscrow (silent market lacks abandonListing)", "UnifiedSmartWalletV3",
         "forceCancelMarketEscrow", [H(account)], "owner")
    c.check(c.results("UnifiedSmartWalletV3", "isMarketEscrowActive", H(account)) is False,
            "owner escaped a market without abandonListing")


def scenario_subscription(c):
    c.scenario("subscription pull from the proxy asset address")
    verifier = c.contracts["SubscriptionVerifier"]
    target = c.contracts["MockTransferTarget"]
    account, proxy = c.register("register account with SubscriptionVerifier", verifier=verifier)
    sub_id = bytes.fromhex("abcdef01")
    c.two_phase("createSubscription", account, "verifier", "createSubscription",
                [H(account), B(sub_id), H(c.wallets["merchant"]), H(target), I(1000), I(2_592_000)])
    tag = int.from_bytes(hashlib.sha256(sub_id).digest()[:8], "big")
    nonce = (tag << 64)
    op = A(H(target), S("transfer"), A(H(proxy), H(c.wallets["merchant"]), I(1000), B(b"")),
           I(nonce), I(FAR_DEADLINE), B(sub_id))
    # The verifier checks the merchant witness from inside a nested call, so the merchant's signer
    # scope has to reach the verifier: CalledByEntry stops at the core and is rejected as
    # "merchant authorization required". neoxp offers Global; a production merchant scopes the
    # signer to the verifier with CustomContracts instead.
    c.execute("merchant pulls with CalledByEntry scope", account, op, "merchant",
              expect_fault="merchant authorization required")
    c.execute("merchant pulls the charge", account, op, "merchant", scope="Global")
    c.check(c.nonce(account, tag) == 1, "subscription lane advanced")
    op2 = A(H(target), S("transfer"), A(H(proxy), H(c.wallets["merchant"]), I(1000), B(b"")),
            I(nonce + 1), I(FAR_DEADLINE), B(sub_id))
    c.execute("second pull in the same period", account, op2, "merchant", scope="Global",
              expect_fault="Subscription already charged this period")
    bad_source = A(H(target), S("transfer"), A(H(account), H(c.wallets["merchant"]), I(1000), B(b"")),
                   I(nonce + 1), I(FAR_DEADLINE), B(sub_id))
    c.execute("pull sourced from the account id", account, bad_source, "merchant", scope="Global",
              expect_fault="Transfer source must be the account asset address")
    c.execute("stranger pulls", account, op2, "stranger", scope="Global",
              expect_fault="merchant authorization required")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--neoxp", default=str(Path.home() / ".dotnet" / "tools" / "neoxp"))
    parser.add_argument("--workdir", default=None, help="scratch directory for the chain (default: temp)")
    parser.add_argument("--output", default=None, help="receipt path (default: docs/reports/aa-neoexpress-validation-<date>.json)")
    parser.add_argument("--keep", action="store_true", help="keep the scratch chain after the run")
    args = parser.parse_args()

    today = dt.date.today().strftime("%Y%m%d")
    output = Path(args.output) if args.output else ROOT / "docs" / "reports" / f"aa-neoexpress-validation-{today}.json"
    workdir = Path(args.workdir) if args.workdir else Path(tempfile.mkdtemp(prefix="aa-neoxp-"))
    workdir.mkdir(parents=True, exist_ok=True)
    chain = Chain(args.neoxp, workdir)
    receipt = {
        "schema": "neoos-aa-neoexpress-validation/v1",
        "observedOn": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scope": "Fresh isolated single-node NeoExpress chain: deployment of every contracts/bin/v3 artifact, "
                 "protocol flows driven by real transactions, and JSON-RPC readback of every deployed contract. "
                 "No public network, no production deployment, no signing or broadcast outside the private chain.",
        "status": "FAILED",
    }
    try:
        version = subprocess.run([args.neoxp, "--version"], capture_output=True, text=True, env=chain.env)
        version = ANSI.sub("", version.stdout).strip()
        if not version:
            raise ValidationFailure("neoxp did not report a version; is the tool installed and its runtime reachable?")
        receipt["tool"] = {"name": "NeoExpress", "version": version}
        chain.create()
        receipt["network"] = {"kind": "isolated-private-single-node", "networkMagic": chain.magic,
                              "rpcHost": "127.0.0.1", "publicNetwork": False}
        chain.deploy_all()
        receipt["deployments"] = chain.deployments

        account, proxy = scenario_native_execution(chain)
        scenario_escape(chain, account, proxy)
        scenario_hook(chain)
        scenario_abi_precheck(chain)
        scenario_session_key_and_paymaster(chain, workdir)
        scenario_recovery_cleanup(chain, workdir)
        scenario_multisig(chain)
        scenario_multihook(chain)
        scenario_market(chain)
        scenario_subscription(chain)

        receipt["rpcReadback"] = chain.readback()
        receipt["status"] = "PASS"
    except ValidationFailure as failure:
        receipt["failure"] = str(failure)
        print(f"FAIL: {failure}", file=sys.stderr)
    finally:
        chain.stop_node()
        receipt["scenarios"] = chain.scenarios
        transactions = [s for sc in chain.scenarios for s in sc["steps"] if "txid" in s]
        faults = [s for sc in chain.scenarios for s in sc["steps"] if s.get("outcome") == "FAULT"]
        receipt["summary"] = {
            "artifactsDeployed": len(chain.deployments),
            "scenarios": len(chain.scenarios),
            "transactionsHalted": len(transactions),
            "expectedFaults": len(faults),
            "assertions": sum(len(sc["assertions"]) for sc in chain.scenarios),
            "simulatedTimeAdvancedSeconds": chain.simulated_seconds,
        }
        receipt["parityBoundary"] = {
            "localNefToPrivateChainRpc": "byte-identical NEF script, checksum and semantically equal manifest for every artifact"
                                         if receipt["status"] == "PASS" else "not established",
            "witnessScopes": "neoxp signs with wallet accounts under CalledByEntry or Global; the proxy verification-trigger "
                             "witness path is covered by ProxyWitnessRuntimeTests and the ProxyWitnessScript Coq model, not here",
            "publicNetwork": "not touched",
        }
        receipt["privacy"] = {"credentialsIncluded": False, "privateKeysIncluded": False, "absoluteUserPathsIncluded": False}
        output.write_text(json.dumps(receipt, indent=2) + "\n")
        print(f"{receipt['status']}: receipt written to {output.relative_to(ROOT) if output.is_relative_to(ROOT) else output}")
        if not args.keep:
            shutil.rmtree(workdir, ignore_errors=True)
    return 0 if receipt["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
