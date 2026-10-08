"""Fast gates for the current-source variant.

No chain, no compiler and no network: the NEF samples are assembled byte by byte and the receipts
are dictionaries. The committed deployed core is parsed from disk as the negative sample of the
bytecode detector, so the parser is exercised against real compiler output as well.
"""
import copy
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/localchain"))
import aa_rpc_scenarios as suite  # noqa: E402
import source_build  # noqa: E402

SOURCE_EXPECTED = ROOT / "tests/localchain/expected-source.json"
DEPLOYED_CORE = ROOT / "contracts/build/UnifiedSmartWalletV3.nef"


def varint(value):
    """Neo's variable-length integer (the form NefFile writes lengths in)."""
    if value < 0xFD:
        return bytes([value])
    if value <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", value)
    if value <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", value)
    return b"\xff" + struct.pack("<Q", value)


def nef_bytes(script, compiler="Neo.Compiler.CSharp 3.9.1+fast-gate", source="", tokens=()):
    """Assemble a NEF with the layout the published compiler writes (NefFile.Serialize)."""
    out = bytearray(b"NEF3")
    out += compiler.encode()[:64].ljust(64, b"\x00")
    out += varint(len(source)) + source.encode()
    out += b"\x00"
    out += varint(len(tokens))
    for token in tokens:
        out += token
    out += b"\x00\x00"
    out += varint(len(script)) + script
    out += hashlib.sha256(hashlib.sha256(bytes(out)).digest()).digest()[:4]
    return bytes(out)


def syscall(method, token):
    return b"\x0c" + bytes([len(method)]) + method.encode() + b"\x41" + struct.pack("<I", token)


def write_nef(directory, name, payload):
    path = Path(directory) / name
    path.write_bytes(payload)
    return path


def nef_with_declared_script_length(declared, body):
    out = bytearray(b"NEF3") + "Neo.Compiler.CSharp 3.9.1+fast-gate".encode()[:64].ljust(64, b"\x00")
    out += b"\x00" + b"\x00" + b"\x00\x00" + varint(declared) + body
    out += hashlib.sha256(hashlib.sha256(bytes(out)).digest()).digest()[:4]
    return bytes(out)


def proxy_relay_proof():
    """Independent minimal successful chain observations for mutation gates."""
    proof = {name: "0x" + char * 40 for name, char in (("core", "1"), ("accountId", "2"), ("proxy", "3"),
             ("buyer", "4"), ("owner", "5"), ("relay", "6"), ("paymaster", "7"), ("sponsor", "8"))}
    proof["amount"] = suite.GAS
    proof["proxy"] = "0x" + suite.v.hash160(suite.proxy_script_for(proof["accountId"], proof["core"]))[::-1].hex()
    initial = {"proxy": "1000000000", "buyer": "0", "owner": "999", "relay": "999", "nonce": "0", "deposit": "1000"}
    proof["cases"] = [{"name": "invalidSignature", "before": initial, "after": dict(initial), "status": 200,
                       "response": {"vmState": "FAULT"}, "execution": None, "transaction": None}]
    proof["refusals"] = [{"name": name, "before": dict(initial), "after": dict(initial), "status": 502,
                           "response": {"rawMessage": marker}, "execution": None} for name, marker in (
                             ("missingReserve", "AA_RELAY_PROXY_NETWORK_FEE_RESERVE"),
                             ("insufficientReserve", "InsufficientFunds"),
                             ("networkFeeCeiling", "AA_RELAY_MAX_NETWORK_FEE"))]
    previous = initial
    for name in ("direct",):
        after = dict(previous, proxy=str(int(previous["proxy"]) - proof["amount"]), buyer=str(int(previous["buyer"]) + proof["amount"]),
                     nonce=str(int(previous["nonce"]) + 1))
        if name == "direct":
            after["relay"] = str(int(previous["relay"]) - 120)
        else:
            after["deposit"] = str(int(previous["deposit"]) - 120)
        txid = "0x" + ("ab" if name == "direct" else "cd") * 32
        method = "executeUserOp" if name == "direct" else "executeSponsoredUserOp"
        tail = b"\x0c\x14" + suite.v.hash_le(proof["accountId"]) + bytes([0x12 if name == "direct" else 0x15, 0xC0, 0x1F, 0x0C, len(method)]) + method.encode() + b"\x0c\x14" + suite.v.hash_le(proof["core"]) + bytes.fromhex("41627d5b52")
        tx = {"hash": txid, "sysfee": "100", "netfee": "20", "script": base64.b64encode(tail).decode(),
              "signers": [{"account": proof["relay"], "scopes": "CalledByEntry"}, {"account": proof["proxy"], "scopes": "WitnessRules", "rules": suite.v.aa_proxy_rules(proof["core"], suite.GAS_HASH)}],
              "witnesses": [{}, {"invocation": "", "verification": base64.b64encode(suite.proxy_script_for(proof["accountId"], proof["core"])).decode()}]}
        events = []
        if name == "sponsored":
            fields = [{"type": "ByteString", "value": base64.b64encode(suite.v.hash_le(proof[who])).decode()} for who in ("sponsor", "accountId", "relay")]
            events = [{"contract": proof["paymaster"], "eventname": "Reimbursed", "state": {"type": "Array", "value": fields + [{"type": "Integer", "value": "120"}]}}]
        proof["cases"].append({"name": name, "before": dict(previous), "after": after, "status": 200,
                               "response": {"txid": txid, "systemFee": "100", "networkFee": "20"},
                               "transaction": tx, "execution": {"vmstate": "HALT", "notifications": events}})
        previous = after
    proof["cases"].append({"name": "sponsored", "before": dict(previous), "after": dict(previous), "status": 502,
                           "response": {"rawMessage": "Sponsored proxy transfers are not supported"}, "execution": None, "transaction": None})
    return proof


class DetectorTest(unittest.TestCase):
    def test_interop_hash_matches_the_diagnostic_value(self):
        self.assertEqual(1371299780, source_build.interop_hash(source_build.GAS_BOUNDED_SYSCALL))

    def test_fault_marker_names_that_interop_hash(self):
        self.assertIn(str(source_build.interop_hash(source_build.GAS_BOUNDED_SYSCALL)),
                      suite.SOURCE_FAULT_MARKER)

    def test_deployed_core_has_no_gas_bounded_syscall(self):
        detected = source_build.profile_of(DEPLOYED_CORE)
        self.assertEqual(source_build.PROFILE_SYSCALL_ABSENT, detected["profile"])
        self.assertEqual(0, detected["gasBoundedSyscall"])
        self.assertEqual(0, detected["validateSignature"])
        self.assertEqual(0, detected["postExecute"])

    def test_parses_a_nef_with_both_bounded_callbacks(self):
        # Padded past 0xFD so the script length uses the tagged two-byte form.
        script = (b"\x11" * 250 + b"\x10" + syscall("validateSignature", source_build.INTEROP_HASH)
                  + b"\x10" + syscall("postExecute", source_build.INTEROP_HASH))
        with tempfile.TemporaryDirectory() as tmp:
            path = write_nef(tmp, "core.nef", nef_bytes(script, tokens=(
                bytes(20) + varint(12) + b"someContract" + b"\x00\x00\x00\x01",)))
            detected = source_build.profile_of(path)
        self.assertEqual(source_build.PROFILE_SYSCALL_PRESENT, detected["profile"])
        self.assertEqual(2, detected["gasBoundedSyscall"])
        self.assertEqual(1, detected["validateSignature"])
        self.assertEqual(1, detected["postExecute"])
        self.assertEqual(source_build.INTEROP_HASH, detected["sites"][0][0])
        self.assertEqual("validateSignature", detected["sites"][0][1])

    def test_only_syscall_instructions_count(self):
        # The same five bytes inside a PUSHDATA operand are data, not a call site: a byte search
        # would report it and could flip the profile.
        payload = struct.pack("<I", source_build.INTEROP_HASH)
        script = b"\x0d" + struct.pack("<H", 5) + b"\x41" + payload
        with tempfile.TemporaryDirectory() as tmp:
            path = write_nef(tmp, "core.nef", nef_bytes(script))
            detected = source_build.profile_of(path)
        self.assertEqual(source_build.PROFILE_SYSCALL_ABSENT, detected["profile"])
        self.assertEqual(0, detected["gasBoundedSyscall"])

    def test_damaged_nefs_fail_closed(self):
        good = nef_bytes(syscall("validateSignature", source_build.INTEROP_HASH))
        cases = {
            "bad magic": b"XXXX" + good[4:],
            "truncated": good[:40],
            "bad checksum": good[:-1] + bytes([good[-1] ^ 0xFF]),
            "trailing bytes": good + b"\x00",
            "reserved byte set": good[:69] + b"\x01" + good[70:],
            "script overruns the file": nef_with_declared_script_length(1 << 20, b"\x10"),
        }
        for name, payload in cases.items():
            with self.subTest(case=name), tempfile.TemporaryDirectory() as tmp:
                path = write_nef(tmp, "core.nef", payload)
                with self.assertRaises(source_build.NefError):
                    source_build.profile_of(path)


class SourceReceiptGateTest(unittest.TestCase):
    def setUp(self):
        self.expected = json.loads(SOURCE_EXPECTED.read_text())

    def receipt(self, profile):
        wanted = self.expected["profiles"][profile]
        receipt = {"variant": "source", "profile": profile, "status": "DONE",
                   "source": {"validateSignature": wanted["build"]["validateSignature"],
                              "postExecute": wanted["build"]["postExecute"],
                              "gasBoundedSyscall": 2 if wanted["build"]["gasBounded"] == "present" else 0,
                              "coreSha256": "b" * 64},
                   "results": [], "records": []}
        for scenario in wanted["scenarios"]:
            checks = [{"check": name, "ok": True} for name in scenario["checks"]]
            receipt["results"].append({"name": scenario["name"], "status": "PASS", "checks": checks})
            receipt["records"].extend(copy.deepcopy(checks))
        for outcome, key in (("HALT", "executedTransactions"), ("FAULT", "simulatedFaults"),
                             ("REJECTED", "nodeRefusals")):
            receipt["records"].extend({"outcome": outcome} for _ in range(wanted["totals"][key]))
        if profile == source_build.PROFILE_SYSCALL_ABSENT:
            receipt["sourceProxyRelay"] = proxy_relay_proof()
            receipt["contracts"] = {"UnifiedSmartWalletV3": receipt["sourceProxyRelay"]["core"]}
        return receipt

    def test_both_profiles_are_declared(self):
        self.assertEqual({source_build.PROFILE_SYSCALL_PRESENT, source_build.PROFILE_SYSCALL_ABSENT},
                         set(self.expected["profiles"]))

    def test_profile_inventory_matches_the_suite_scenarios(self):
        names = [name for name, _ in suite.SOURCE_SCENARIOS]
        for profile, wanted in self.expected["profiles"].items():
            with self.subTest(profile=profile):
                self.assertEqual(names, [scenario["name"] for scenario in wanted["scenarios"]])

    def test_each_profile_validates_its_own_receipt(self):
        for profile in self.expected["profiles"]:
            with self.subTest(profile=profile):
                self.assertEqual([], suite.validate_source_receipt(self.receipt(profile), self.expected))

    def test_mutants_fail_closed(self):
        present = source_build.PROFILE_SYSCALL_PRESENT
        mutations = [
            lambda r: r.update(status="ABORTED"),
            lambda r: r.update(variant="deployed"),
            lambda r: r.update(profile="no-such-profile"),
            # a build that still emits the syscall cannot claim the cleared profile
            lambda r: r.update(profile=source_build.PROFILE_SYSCALL_ABSENT),
            lambda r: r["source"].update(gasBoundedSyscall=0),
            lambda r: r["source"].update(validateSignature=0),
            lambda r: r["source"].update(postExecute=2),
            lambda r: r["source"].update(coreSha256=self.expected["deployedCore"]["sha256"]),
            lambda r: r["source"].pop("coreSha256"),
            lambda r: r["results"].pop(),
            lambda r: r["results"].append(copy.deepcopy(r["results"][0])),
            lambda r: r["results"][0].update(status="FAIL"),
            lambda r: r["results"][0]["checks"][0].update(ok=False),
            lambda r: r["results"][0]["checks"][0].update(check="unexpected"),
            lambda r: r["results"][0]["checks"].pop(),
            lambda r: r["records"][0].update(ok=False),
            lambda r: r["records"].pop(0),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                receipt = self.receipt(present)
                mutate(receipt)
                self.assertTrue(suite.validate_source_receipt(receipt, self.expected),
                                "mutation %d survived the source gate" % index)

    def test_inconsistent_build_profile_fails_closed(self):
        receipt = self.receipt(source_build.PROFILE_SYSCALL_ABSENT)
        receipt["source"]["gasBoundedSyscall"] = 2
        self.assertTrue(suite.validate_source_receipt(receipt, self.expected))

    def test_outcome_drift_fails_closed(self):
        present = source_build.PROFILE_SYSCALL_PRESENT
        for outcome in ("HALT", "FAULT", "REJECTED"):
            with self.subTest(outcome=outcome):
                receipt = self.receipt(present)
                receipt["records"].append({"outcome": outcome})
                self.assertTrue(suite.validate_source_receipt(receipt, self.expected))


    def test_proxy_relay_causal_readback_mutations_fail_closed(self):
        mutations = [
            lambda p: p.pop("cases"),
            lambda p: p.update(proxy="0x" + "9" * 40),
            lambda p: p.pop("refusals"),
            lambda p: p["refusals"][1]["after"].update(nonce="1"),
            lambda p: p["refusals"][2]["response"].update(txid="unexpected"),
            lambda p: p["refusals"][0]["response"].update(rawMessage="unrelated error"),
            lambda p: p["cases"].reverse(),
            lambda p: p["cases"][0]["response"].update(txid="unexpected"),
            lambda p: p["cases"][0]["after"].update(nonce="1"),
            lambda p: p["cases"][1]["after"].update(buyer="0"),
            lambda p: p["cases"][1]["after"].update(proxy="1000"),
            lambda p: p["cases"][1]["after"].update(owner="0"),
            lambda p: p["cases"][1]["after"].update(nonce="0"),
            lambda p: p["cases"][1]["transaction"]["signers"][0].update(account=p["proxy"]),
            lambda p: p["cases"][1]["transaction"]["signers"][1].update(scopes="Global"),
            lambda p: p["cases"][1]["transaction"].update(script="AA=="),
            lambda p: p["cases"][1]["transaction"].update(script=base64.b64encode(b"\x40" + base64.b64decode(p["cases"][1]["transaction"]["script"])).decode()),
            lambda p: p["cases"][1]["transaction"]["witnesses"][1].update(verification="AA=="),
            lambda p: p["cases"][1]["transaction"].update(netfee="21"),
            lambda p: p["cases"][2]["after"].update(deposit="0"),
            lambda p: p["cases"][2]["response"].update(txid="unexpected"),
            lambda p: p["cases"][2]["response"].update(rawMessage="unrelated error"),
            lambda p: p["cases"][2].update(status=200),
            lambda p: p["cases"][2]["after"].update(proxy="0"),
        ]
        self.assertEqual([], suite._source_proxy_relay_failures(proxy_relay_proof()))
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                receipt = self.receipt(source_build.PROFILE_SYSCALL_ABSENT)
                mutate(receipt["sourceProxyRelay"])
                self.assertTrue(suite.validate_source_receipt(receipt, self.expected))


class CliTest(unittest.TestCase):
    def test_suite_cli_offers_the_source_variant(self):
        done = subprocess.run([sys.executable, str(ROOT / "scripts/localchain/aa_rpc_scenarios.py"), "--help"],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(0, done.returncode, done.stderr[-400:])
        self.assertIn("source", done.stdout)
        self.assertIn("deployed", done.stdout)

    def test_source_runner_defaults_to_its_own_receipt(self):
        spec = importlib.util.spec_from_file_location("localchain_run", ROOT / "tests/localchain/run.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        deployed = module.command([])
        source = module.command(["--variant", "source"])
        self.assertIn("--variant", deployed)
        self.assertTrue(deployed[-1].endswith("rpc-deployed.json"), deployed[-1])
        self.assertIn("--variant", source)
        self.assertTrue(source[-1].endswith("rpc-source.json"), source[-1])

    def test_source_build_cli_reports_a_profile(self):
        done = subprocess.run([sys.executable, str(ROOT / "scripts/localchain/source_build.py"), "--help"],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(0, done.returncode, done.stderr[-400:])
        self.assertIn("--out", done.stdout)


if __name__ == "__main__":
    unittest.main()
