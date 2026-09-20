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

The final scenario composes AA with the NeoDID registry: it deploys
NeoDIDRegistry.nef/.manifest.json from the sibling neo-os-services build
(override the directory with NEOOS_SERVICES_CONTRACT_BUILD; set
NEOOS_REQUIRE_SERVICES_ARTIFACTS=1 to fail instead of recording a skip when the
artifact is absent) and drives the AA proxy-witness path with hand-built,
hand-signed transactions over RPC, because neoxp cannot express a proxy signer.
NEOOS_VALIDATE_ONLY=did runs deployment plus that scenario alone for iteration;
its receipt is marked partialRun and is never release evidence.
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


def varint(n):
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + n.to_bytes(2, "little")
    return b"\xfe" + n.to_bytes(4, "little")


def hash_le(text):
    """0x-prefixed big-endian UInt160 text -> the 20 little-endian bytes the wire carries."""
    return bytes.fromhex(text[2:])[::-1]


def hash160(data):
    return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()


def sec1_der(private_key):
    """SEC1 ECPrivateKey DER for a raw P-256 scalar (no public key member)."""
    return bytes.fromhex("3031020101") + b"\x04\x20" + private_key + bytes.fromhex("a00a06082a8648ce3d030107")


class RawKey:
    """A P-256 key from a raw scalar, signing through the openssl CLI like P256Key."""

    def __init__(self, workdir, name, private_key):
        self.der = Path(workdir) / f"{name}.der"
        self.der.write_bytes(sec1_der(private_key))
        pub = subprocess.run(["openssl", "ec", "-inform", "DER", "-in", str(self.der), "-pubout",
                              "-conv_form", "compressed", "-outform", "DER"], check=True, capture_output=True).stdout
        self.compressed = pub[-33:]
        # Standard single-signature verification script: PUSHDATA1 33 <key> SYSCALL CheckSig.
        self.verification = b"\x0c\x21" + self.compressed + b"\x41\x56\xe7\xb3\x27"
        self.script_hash = hash160(self.verification)

    def sign(self, payload):
        with tempfile.NamedTemporaryFile(delete=False) as handle:
            handle.write(payload)
            path = handle.name
        try:
            der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(self.der), "-keyform", "DER", path],
                                 check=True, capture_output=True).stdout
        finally:
            os.unlink(path)
        return der_to_rs(der)


def aa_proxy_rules(wallet, target):
    """The single WitnessRules entry UnifiedSmartWalletV3.verify demands of a proxy signer:
    Allow when called by the wallet or by the scoped target, nothing else."""
    return [{"action": "Allow", "condition": {"type": "Or", "expressions": [
        {"type": "CalledByContract", "hash": wallet}, {"type": "CalledByContract", "hash": target}]}}]


def serialize_signer(signer):
    out = hash_le(signer["account"])
    if signer["scopes"] == "CalledByEntry":
        return out + b"\x01"
    if signer["scopes"] == "WitnessRules":
        out += b"\x40" + varint(len(signer["rules"]))
        for rule in signer["rules"]:
            out += b"\x01" if rule["action"] == "Allow" else b"\x00"
            condition = rule["condition"]
            assert condition["type"] == "Or"
            out += b"\x03" + varint(len(condition["expressions"]))
            for expression in condition["expressions"]:
                assert expression["type"] == "CalledByContract"
                out += b"\x28" + hash_le(expression["hash"])
        return out
    raise ValidationFailure(f"unsupported signer scope {signer['scopes']}")


def serialize_unsigned(nonce, sysfee, netfee, valid_until, signers, script):
    out = b"\x00" + nonce.to_bytes(4, "little") + sysfee.to_bytes(8, "little") + netfee.to_bytes(8, "little")
    out += valid_until.to_bytes(4, "little") + varint(len(signers))
    for signer in signers:
        out += serialize_signer(signer)
    out += varint(0) + varint(len(script)) + script
    return out


def serialize_witnesses(witnesses):
    out = varint(len(witnesses))
    for invocation, verification in witnesses:
        out += varint(len(invocation)) + invocation + varint(len(verification)) + verification
    return out


def action_digest(proxy, action_id, nullifier, magic):
    """NeoDIDRegistry action ticket digest: domain || big-endian proxy || len+actionId || nullifier || magic LE."""
    payload = b"neodid-action-v1" + bytes.fromhex(proxy[2:]) + bytes([len(action_id)]) + action_id.encode()
    payload += nullifier + int(magic).to_bytes(4, "little")
    return hashlib.sha256(payload).digest()


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
            reply = json.loads(response.read())
        if "result" not in reply:
            error = reply.get("error") or {}
            raise ValidationFailure(f"rpc {method}: {error.get('message', error)} {error.get('data', '')}".strip())
        return reply["result"]

    def start_node(self):
        """Run the single consensus node with one-second blocks and wait for RPC. Offline neoxp
        commands hold the chain database themselves, so every read after this point goes over RPC."""
        if self.node is not None:
            return
        # Every express chain answers on the same default RPC port, so a node left behind by
        # another run would silently serve a different chain's state. Refuse to start into it.
        try:
            self.rpc("getversion", [])
        except Exception:
            pass
        else:
            raise ValidationFailure(f"another node already answers on 127.0.0.1:{self.rpc_port}; stop it before validating")
        self.node_log = (self.workdir / "node.log").open("w")
        self.node = subprocess.Popen([self.neoxp, "run", "-i", str(self.file), "-s", "1"],
                                     stdout=self.node_log, stderr=subprocess.STDOUT, env=self.env)
        for _ in range(60):
            time.sleep(1)
            if self.node.poll() is not None:
                raise ValidationFailure(f"node exited with code {self.node.returncode} before answering RPC; "
                                        f"see {self.workdir / 'node.log'}")
            try:
                self.rpc("getversion", [])
                return
            except Exception:
                continue
        raise ValidationFailure("node did not answer RPC")

    def rpc_invoke(self, contract_hash, operation, args, signers=None):
        """invokefunction over RPC: the exact script the node would run, its gas, and the stack."""
        result = self.rpc("invokefunction", [contract_hash, operation, list(args), signers or []])
        if result.get("state") != "HALT":
            raise ValidationFailure(f"{operation} simulation faulted: {result.get('exception')}")
        stack = result.get("stack") or []
        value = decode(stack[0]) if stack and stack[0].get("type") not in ("Any",) else None
        return value, base64.b64decode(result["script"]), int(result["gasconsumed"])

    def wallet_private_key(self, name):
        """The dev wallet's raw P-256 scalar from the express chain file (dev chain only)."""
        config = json.loads(self.file.read_text())
        for wallet in config.get("wallets", []):
            if wallet["name"] == name:
                return bytes.fromhex(wallet["accounts"][0]["private-key"])
        raise ValidationFailure(f"wallet {name} not in chain file")

    def readback(self):
        self.start_node()
        try:
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


def scenario_did_action_ticket(c, workdir):
    """AA proxy witness consuming a NeoDID action ticket with real transactions: the wallet's
    verification-trigger path (WitnessRules proxy signer scoped to the registry) that neoxp
    invoke cannot express, so the transactions are built, signed and broadcast by hand."""
    build = Path(os.environ.get("NEOOS_SERVICES_CONTRACT_BUILD") or (ROOT.parent / "neo-os-services" / "contracts" / "build"))
    nef = build / "NeoDIDRegistry.nef"
    manifest = build / "NeoDIDRegistry.manifest.json"
    scenario = c.scenario("AA proxy witness consumes a NeoDID action ticket")
    if not (nef.is_file() and manifest.is_file()):
        if os.environ.get("NEOOS_REQUIRE_SERVICES_ARTIFACTS") == "1":
            raise ValidationFailure(f"NeoDIDRegistry artifact missing from {build}")
        scenario["skipped"] = f"NeoDIDRegistry.nef/.manifest.json not found beside this checkout ({build.name})"
        return
    _, text = c.nx("contract", "deploy", str(nef), "genesis", "-j")
    deployed = c.json_from(text)
    if deployed["contract-name"] != "NeoDIDRegistry":
        raise ValidationFailure(f"deployed name {deployed['contract-name']} != NeoDIDRegistry")
    registry = deployed["contract-hash"]
    c.contracts["NeoDIDRegistry"] = registry
    c.deployments.append({"contractName": "NeoDIDRegistry", "contractHash": registry,
                          "deploymentTransaction": deployed["tx-hash"], "deployData": None,
                          "localNefSha256": hashlib.sha256(nef.read_bytes()).hexdigest(),
                          "localManifestSha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
                          "source": "neo-os-services/contracts/build (sibling checkout)"})
    verifier = P256Key(workdir, "did-verifier")
    c.tx("registry admin sets the action verifier key", "NeoDIDRegistry", "setVerifier", [B(verifier.compressed)], "genesis")
    account, proxy = c.register("register native account for the ticket", owner="owner")
    wallet = c.contracts["UnifiedSmartWalletV3"]
    c.tx("wallet admin binds the account's verify scope to the registry", "UnifiedSmartWalletV3",
         "setVerifyScopeTarget", [H(account), H(registry)], "genesis")
    c.check(c.hash_result("UnifiedSmartWalletV3", "getVerifyScopeTarget", H(account)) == registry, "verify scope target recorded")
    # Everything below runs against the live node over JSON-RPC.
    c.start_node()
    owner = RawKey(workdir, "owner-raw", c.wallet_private_key("owner"))
    c.check("0x" + owner.script_hash[::-1].hex() == c.wallets["owner"], "owner key derives the wallet script hash")
    # The proxy is not a deployed contract: it is the verification script
    # PUSHDATA1 20 accountId | PUSH1 PACK PUSH15 | PUSHDATA1 6 "verify" | PUSHDATA1 20 core | SYSCALL Contract.Call
    # whose hash the core publishes as the proxy script hash, so the witness carries the script itself.
    proxy_script = (b"\x0c\x14" + hash_le(account) + bytes.fromhex("11c01f0c06") + b"verify" + b"\x0c\x14"
                    + hash_le(wallet) + bytes.fromhex("41627d5b52"))
    c.check("0x" + hash160(proxy_script)[::-1].hex() == proxy, "locally built proxy verification script hashes to the core's proxy hash")
    signers = [{"account": c.wallets["owner"], "scopes": "CalledByEntry"},
               {"account": proxy, "scopes": "WitnessRules", "rules": aa_proxy_rules(wallet, registry)}]
    action_id = "neoos|private-chain|ticket|1"

    def ticket(step, nullifier, signature, nonce, target_action=action_id, expect_fault=None):
        op = A(H(registry), S("useActionTicket"), A(H(proxy), S(target_action), B(nullifier), B(signature)),
               I(nonce), I(FAR_DEADLINE), B(b""))
        args = [H(account), op]
        record = {"step": step, "contract": "UnifiedSmartWalletV3", "operation": "executeUserOp", "signer": "owner",
                  "witnessScope": "owner CalledByEntry + proxy WitnessRules(CalledByContract wallet|registry)",
                  "nestedCall": "NeoDIDRegistry.useActionTicket"}
        try:
            _, script, gas = c.rpc_invoke(wallet, "executeUserOp", args, signers)
        except ValidationFailure as failure:
            # A deterministic refusal surfaces in simulation; broadcast it anyway so the
            # chain itself records the fault, exactly as a relayer would observe it.
            probe = c.rpc("invokefunction", [wallet, "executeUserOp", args, signers])
            script, gas = base64.b64decode(probe["script"]), int(probe["gasconsumed"])
            record["simulation"] = str(failure)
        height = c.rpc("getblockcount", [])
        nonce_value = int.from_bytes(os.urandom(4), "little")
        sysfee = gas + 2_000_000
        # NeoExpress's calculatenetworkfee endpoint resolves every signer through an
        # opened wallet.  The AA proxy is deliberately not a wallet account: its
        # verification script is carried by the witness itself.  Ask the endpoint
        # for a lower-bound owner-only estimate, then add a deliberately conservative
        # test-only margin for the proxy signer/script.  The final transaction still
        # contains the real WitnessRules signer and proxy verification script.
        fee_probe_signers = [{"account": c.wallets["owner"], "scopes": "CalledByEntry"}]
        fee_probe_witnesses = [(b"\x0c\x40" + bytes(64), owner.verification)]
        fee_probe = serialize_unsigned(nonce_value, sysfee, 0, height + 50, fee_probe_signers, script)
        fee = c.rpc("calculatenetworkfee", [base64.b64encode(fee_probe + serialize_witnesses(fee_probe_witnesses)).decode()])
        netfee = int(fee["networkfee"]) + GAS
        unsigned = serialize_unsigned(nonce_value, sysfee, netfee, height + 50, signers, script)
        # Neo N3 signs magic || SHA256(unsigned transaction); the node's reported hash pins
        # that construction so a serialization drift cannot pass unnoticed.
        tx_hash = hashlib.sha256(unsigned).digest()
        signature_bytes = owner.sign(int(c.magic).to_bytes(4, "little") + tx_hash)
        witnesses = [(b"\x0c\x40" + signature_bytes, owner.verification), (b"", proxy_script)]
        raw = base64.b64encode(unsigned + serialize_witnesses(witnesses)).decode()
        sent = None
        attempts = []
        for attempt in range(4):
            try:
                sent = c.rpc("sendrawtransaction", [raw])
                attempts.append("accepted")
                break
            except ValidationFailure as failure:
                attempts.append(str(failure)[:80])
                if "InvalidSignature" not in str(failure):
                    raise
                time.sleep(2)
        record["sendAttempts"] = attempts
        if sent is None:
            # Decide which witness the node refuses: the same script with only the owner
            # signer is accepted by the mempool when the owner signature is valid (it then
            # faults on chain because CheckWitness(proxy) is missing), so a second rejection
            # isolates the owner signature and an acceptance isolates the proxy witness.
            owner_only = [signers[0]]
            probe_unsigned = serialize_unsigned(nonce_value, sysfee, netfee, height + 50, owner_only, script)
            probe_hash = hashlib.sha256(probe_unsigned).digest()
            probe_sig = owner.sign(int(c.magic).to_bytes(4, "little") + probe_hash)
            probe_raw = base64.b64encode(probe_unsigned + serialize_witnesses([(b"\x0c\x40" + probe_sig, owner.verification)])).decode()
            try:
                c.rpc("sendrawtransaction", [probe_raw])
                diagnosis = "owner signature accepted alone; the node refuses the proxy witness (wallet verify returned false or exceeded the verification gas)"
            except ValidationFailure as failure:
                diagnosis = f"owner-only transaction also refused ({str(failure)[:80]}); the owner signature or serialization is wrong"
            c.current["steps"].append({**record, "outcome": "REJECTED", "diagnosis": diagnosis})
            raise ValidationFailure(f"{step}: identical bytes rejected {len(attempts)} times; {diagnosis}")
        if sent["hash"].lower() != "0x" + tx_hash[::-1].hex():
            raise ValidationFailure(f"{step}: node hash {sent['hash']} differs from the computed transaction hash")
        record["txHashAlgorithm"] = "sha256"
        txid = sent["hash"]
        record.update({"txid": txid, "systemFee": sysfee, "networkFee": netfee})
        execution = None
        for _ in range(40):
            time.sleep(1)
            try:
                log = c.rpc("getapplicationlog", [txid])
                execution = log["executions"][0]
                break
            except Exception:
                continue
        if execution is None:
            raise ValidationFailure(f"{step}: transaction {txid} was not executed by the node")
        record["outcome"] = execution["vmstate"]
        record["gasConsumed"] = int(execution["gasconsumed"])
        record["events"] = [n["eventname"] for n in execution.get("notifications", [])]
        if execution.get("exception"):
            record["exception"] = execution["exception"]
        if expect_fault is None and execution["vmstate"] != "HALT":
            raise ValidationFailure(f"{step}: vmstate {execution['vmstate']}: {execution.get('exception')}")
        if expect_fault is not None:
            if execution["vmstate"] != "FAULT":
                raise ValidationFailure(f"{step}: expected fault {expect_fault!r} but transaction halted")
            if expect_fault not in (execution.get("exception") or ""):
                raise ValidationFailure(f"{step}: expected fault containing {expect_fault!r}, got {execution.get('exception')!r}")
            record["expectedFault"] = expect_fault
        c.current["steps"].append(record)
        return record

    def used(nullifier):
        value, _, _ = c.rpc_invoke(registry, "isActionNullifierUsed", [B(nullifier)])
        return value is True

    nullifier = bytes([0x51]) * 32
    signature = verifier.sign(action_digest(proxy, action_id, nullifier, c.magic))
    nonce0, _, _ = c.rpc_invoke(wallet, "getNonce", [H(account), I(0)])
    first = ticket("proxy witness consumes the ticket", nullifier, signature, nonce0)
    c.check("ActionTicketUsed" in first["events"], "registry emitted ActionTicketUsed for the proxy account")
    c.check(used(nullifier), "action nullifier is recorded as used")
    nonce1, _, _ = c.rpc_invoke(wallet, "getNonce", [H(account), I(0)])
    c.check(nonce1 == nonce0 + 1, "user operation nonce advanced through the composed call")
    ticket("replaying the same nullifier", nullifier, signature, nonce1, expect_fault="action nullifier already used")
    other = bytes([0x52]) * 32
    escalated = "neoos|private-chain|ticket|escalated"
    ticket("retargeting the signature to another action id", other, verifier.sign(action_digest(proxy, action_id, other, c.magic)),
           nonce1, target_action=escalated, expect_fault="invalid verification signature")
    c.check(not used(other), "a retargeted ticket leaves its nullifier unused")
    state = c.rpc("getcontractstate", [registry])
    local_script, local_checksum = nef_script(nef)
    c.check(base64.b64decode(state["nef"]["script"]) == local_script and int(state["nef"]["checksum"]) == local_checksum,
            "deployed NeoDIDRegistry bytes equal the sibling build artifact")


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
        "scope": "Fresh isolated single-node NeoExpress chain: deployment of every contracts/bin/v3 artifact plus the sibling "
                 "NeoDIDRegistry build, a hand-signed AA proxy-witness transaction that consumes a NeoDID action ticket, "
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

        only_did = os.environ.get("NEOOS_VALIDATE_ONLY") == "did"
        if only_did:
            receipt["partialRun"] = "NEOOS_VALIDATE_ONLY=did: iteration run, not release evidence"
        account, proxy = (None, None) if only_did else scenario_native_execution(chain)
        if not only_did:
            scenario_escape(chain, account, proxy)
        if not only_did:
            scenario_hook(chain)
        if not only_did:
            scenario_abi_precheck(chain)
        if not only_did:
            scenario_session_key_and_paymaster(chain, workdir)
        if not only_did:
            scenario_recovery_cleanup(chain, workdir)
        if not only_did:
            scenario_multisig(chain)
        if not only_did:
            scenario_multihook(chain)
        if not only_did:
            scenario_market(chain)
        if not only_did:
            scenario_subscription(chain)

        scenario_did_action_ticket(chain, workdir)
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
                             "witness path (WitnessRules proxy signer scoped to a target contract) is exercised here only by the "
                             "hand-built NeoDID action-ticket transactions, and otherwise by ProxyWitnessRuntimeTests and "
                             "the ProxyWitnessScript Coq model",
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
