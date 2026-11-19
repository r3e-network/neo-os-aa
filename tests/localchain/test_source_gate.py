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
import sa_rpc_scenarios as suite  # noqa: E402
import source_build  # noqa: E402

SOURCE_EXPECTED = ROOT / "tests/localchain/expected-source.json"
DEPLOYED_CORE = ROOT / "contracts/build/SmartAccount.nef"


class ReceiptPrivacyTest(unittest.TestCase):
    def test_receipt_redaction_removes_machine_specific_locations(self):
        raw = {
            "trace": f"file://{ROOT}/frontend/node_modules/x.js",
            "workdir": "/private" + "/tmp/sa-localchain-1234",
            "tool": "/opt/homebrew/Cellar/openssl@3/bin/openssl",
            "nested": ["/tmp/sa-localchain-5678"],
        }
        rendered = json.dumps(suite._redact_receipt_value(raw))
        for marker in ("/Users/", "/private/tmp/", "/tmp/", "/opt/homebrew/", "node_modules/"):
            self.assertNotIn(marker, rendered)
        self.assertIn("<repo>", rendered)
        self.assertIn("<tmp>/", rendered)
        self.assertIn("<toolchain>/", rendered)
        self.assertIn("<dependencies>/", rendered)


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


def write_artifact_set(directory, methods=None):
    """Write the nine public artifacts at the nested paths the roster declares."""
    for name in source_build.REQUIRED_ARTIFACTS:
        nef, manifest = source_build.artifact_paths(directory, name)
        nef.parent.mkdir(parents=True, exist_ok=True)
        nef.write_bytes(nef_bytes(b"\x11\x40"))
        declared = methods if name == "SmartAccount" and methods is not None \
            else [{"name": method, "safe": False, "parameters": [], "returntype": "Void", "offset": 0}
                  for method in source_build.REQUIRED_CORE_METHODS]
        manifest.write_text(json.dumps({"name": name, "abi": {"methods": declared}}))
    return Path(directory)


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


class RosterTest(unittest.TestCase):
    def test_the_roster_is_the_nine_v4_modules_at_their_declared_paths(self):
        self.assertEqual(("SmartAccount", "MockTransferTarget", "SAPaymaster", "NeoWitnessValidator",
                          "SessionKeyValidator", "MultiSigValidator", "WhitelistHook", "DailyLimitHook",
                          "TokenRestrictedHook"), source_build.REQUIRED_ARTIFACTS)
        self.assertEqual("validators/NeoWitnessValidator.nef", source_build.MODULE_FILES["NeoWitnessValidator"])
        self.assertEqual("hooks/WhitelistHook.nef", source_build.MODULE_FILES["WhitelistHook"])

    def test_a_build_without_the_v4_entrypoints_fails_closed(self):
        with tempfile.TemporaryDirectory() as output:
            write_artifact_set(output, methods=[{"name": "registerAccount", "safe": False,
                                                 "parameters": [], "returntype": "Void", "offset": 0}])
            with self.assertRaises(source_build.BuildError):
                source_build.require_artifacts(output)

    def test_a_build_without_a_nested_module_fails_closed(self):
        with tempfile.TemporaryDirectory() as output:
            write_artifact_set(output)
            Path(output, "validators/SessionKeyValidator.nef").unlink()
            with self.assertRaises(source_build.BuildError):
                source_build.require_artifacts(output)


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
        with tempfile.TemporaryDirectory() as output:
            write_artifact_set(output)
            artifacts = source_build.artifact_snapshot(output)
        receipt["source"]["coreSha256"] = artifacts[0]["nefSha256"]
        receipt["contracts"] = {name: "0x" + format(index + 1, "040x")
                                for index, name in enumerate(source_build.REQUIRED_ARTIFACTS)}
        receipt["sourceArtifactRuntime"] = {
            "schema": "neoos-sa-custom-source-artifact-runtime/v1", "publicNetwork": False,
            "scope": "%d deployed artifacts only" % len(source_build.REQUIRED_ARTIFACTS), "artifacts": artifacts,
            "runnerSourceSha256": suite.source_runner_snapshot(),
            "readback": [{"contractName": artifact["contractName"],
                          "contractHash": receipt["contracts"][artifact["contractName"]],
                          "nef": {"script": base64.b64encode(b"\x11\x40").decode(), "checksum": artifact["nefChecksum"]},
                          "manifest": copy.deepcopy(artifact["manifest"]),
                          "manifestCanonicalSha256": artifact["manifestCanonicalSha256"],
                          "nefScriptSha256": artifact["nefScriptSha256"], "nefChecksum": artifact["nefChecksum"],
                          "nefScriptByteEquality": True, "nefChecksumEquality": True,
                          "manifestSemanticEquality": True} for artifact in artifacts],
        }
        for scenario in wanted["scenarios"]:
            checks = [{"check": name, "ok": True} for name in scenario["checks"]]
            receipt["results"].append({"name": scenario["name"], "status": "PASS", "checks": checks})
            receipt["records"].extend(copy.deepcopy(checks))
        for outcome, key in (("HALT", "executedTransactions"), ("FAULT", "simulatedFaults"),
                             ("REJECTED", "nodeRefusals")):
            receipt["records"].extend({"outcome": outcome} for _ in range(wanted["totals"][key]))
        return receipt

    def test_the_v4_oracle_declares_the_public_build_profile(self):
        self.assertEqual("v4", self.expected.get("suite"))
        self.assertEqual({source_build.PROFILE_SYSCALL_ABSENT}, set(self.expected["profiles"]))
        self.assertEqual("absent", self.expected["profiles"][source_build.PROFILE_SYSCALL_ABSENT]["build"]["gasBounded"])

    def test_profile_inventory_matches_the_suite_scenarios(self):
        names = [name for name, _ in suite.SOURCE_SCENARIOS]
        for profile, wanted in self.expected["profiles"].items():
            with self.subTest(profile=profile):
                self.assertEqual(names, [scenario["name"] for scenario in wanted["scenarios"]])

    def test_each_profile_validates_its_own_receipt(self):
        for profile in self.expected["profiles"]:
            with self.subTest(profile=profile):
                self.assertEqual([], suite.validate_source_receipt(self.receipt(profile), self.expected))

    def test_the_declared_roster_is_required(self):
        receipt = self.receipt(source_build.PROFILE_SYSCALL_ABSENT)
        receipt["contracts"].pop("SessionKeyValidator")
        self.assertTrue(suite.validate_source_receipt(receipt, self.expected))

    def test_source_artifact_readback_mutations_fail_closed(self):
        mutations = {
            "missing evidence": lambda r: r.pop("sourceArtifactRuntime"),
            "wrong schema": lambda r: r["sourceArtifactRuntime"].update(schema="older"),
            "public network": lambda r: r["sourceArtifactRuntime"].update(publicNetwork=True),
            "expanded scope": lambda r: r["sourceArtifactRuntime"].update(scope="all modules verified"),
            "missing runner hashes": lambda r: r["sourceArtifactRuntime"].pop("runnerSourceSha256"),
            "changed runner hash": lambda r: r["sourceArtifactRuntime"]["runnerSourceSha256"].update({suite.SOURCE_RUNNER_FILES[0]: "0" * 64}),
            "missing artifact": lambda r: r["sourceArtifactRuntime"]["artifacts"].pop(),
            "duplicate artifact": lambda r: r["sourceArtifactRuntime"]["artifacts"].append(copy.deepcopy(r["sourceArtifactRuntime"]["artifacts"][0])),
            "missing readback": lambda r: r["sourceArtifactRuntime"]["readback"].pop(),
            "duplicate readback": lambda r: r["sourceArtifactRuntime"]["readback"].append(copy.deepcopy(r["sourceArtifactRuntime"]["readback"][0])),
            "foreign deployment": lambda r: r["contracts"].update(Unknown="0x" + "ff" * 20),
            "historical core substitute": lambda r: r["sourceArtifactRuntime"]["artifacts"][0].update(nefSha256=self.expected["deployedCore"]["sha256"]),
            "flat artifact path": lambda r: r["sourceArtifactRuntime"]["artifacts"][3].update(relativeNefPath="NeoWitnessValidator.nef"),
            "wrong artifact path": lambda r: r["sourceArtifactRuntime"]["artifacts"][1].update(relativeNefPath="../build/MockTransferTarget.nef"),
            "missing manifest hash": lambda r: r["sourceArtifactRuntime"]["artifacts"][1].pop("manifestSha256"),
            "bad hash": lambda r: r["sourceArtifactRuntime"]["artifacts"][1].update(nefSha256="unknown"),
            "changed RPC identity": lambda r: r["sourceArtifactRuntime"]["readback"][1].update(contractHash="0x" + "ff" * 20),
            "changed RPC script": lambda r: r["sourceArtifactRuntime"]["readback"][1]["nef"].update(script=base64.b64encode(b"\x10\x40").decode()),
            "invalid base64": lambda r: r["sourceArtifactRuntime"]["readback"][1]["nef"].update(script="!"),
            "declared script drift": lambda r: r["sourceArtifactRuntime"]["readback"][1].update(nefScriptSha256="0" * 64),
            "checksum drift": lambda r: r["sourceArtifactRuntime"]["readback"][1]["nef"].update(checksum=0),
            "boolean checksum": lambda r: r["sourceArtifactRuntime"]["artifacts"][1].update(nefChecksum=True),
            "changed RPC manifest": lambda r: r["sourceArtifactRuntime"]["readback"][1]["manifest"].update(permissions=["*"]),
            "declared canonical drift": lambda r: r["sourceArtifactRuntime"]["readback"][1].update(manifestCanonicalSha256="0" * 64),
            "nontrue parity": lambda r: r["sourceArtifactRuntime"]["readback"][1].update(manifestSemanticEquality=1),
        }
        for label, mutate in mutations.items():
            with self.subTest(mutation=label):
                receipt = self.receipt(source_build.PROFILE_SYSCALL_ABSENT)
                mutate(receipt)
                self.assertTrue(suite.validate_source_receipt(receipt, self.expected), label)

    def test_source_snapshot_requires_fresh_named_nef_manifest_pairs(self):
        with tempfile.TemporaryDirectory() as output:
            write_artifact_set(output)
            rows = source_build.artifact_snapshot(output)
            self.assertEqual(list(source_build.REQUIRED_ARTIFACTS), [row["contractName"] for row in rows])
            self.assertEqual("validators/NeoWitnessValidator.nef",
                             [row["relativeNefPath"] for row in rows if row["contractName"] == "NeoWitnessValidator"][0])
            core = Path(output, "SmartAccount.nef")
            core.write_bytes(core.read_bytes()[:-1] + b"\x00")
            with self.assertRaises(source_build.NefError):
                source_build.artifact_snapshot(output)
            core.write_bytes(nef_bytes(b"\x40"))
            Path(output, "SmartAccount.manifest.json").write_text('{"name":"HistoricalOther"}')
            with self.assertRaises(source_build.BuildError):
                source_build.artifact_snapshot(output)
            Path(output, "SmartAccount.manifest.json").unlink()
            with self.assertRaises(source_build.BuildError):
                source_build.artifact_snapshot(output)

    def test_mutants_fail_closed(self):
        absent = source_build.PROFILE_SYSCALL_ABSENT
        mutations = [
            lambda r: r.update(status="ABORTED"),
            lambda r: r.update(variant="deployed"),
            lambda r: r.update(profile="no-such-profile"),
            # a build that still emits the syscall cannot claim the public profile
            lambda r: r.update(profile=source_build.PROFILE_SYSCALL_PRESENT),
            lambda r: r["source"].update(gasBoundedSyscall=2),
            lambda r: r["source"].update(validateSignature=1),
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
                receipt = self.receipt(absent)
                mutate(receipt)
                self.assertTrue(suite.validate_source_receipt(receipt, self.expected),
                                "mutation %d survived the source gate" % index)

    def test_inconsistent_build_profile_fails_closed(self):
        receipt = self.receipt(source_build.PROFILE_SYSCALL_ABSENT)
        receipt["source"]["gasBoundedSyscall"] = 2
        self.assertTrue(suite.validate_source_receipt(receipt, self.expected))

    def test_outcome_drift_fails_closed(self):
        for outcome in ("HALT", "FAULT", "REJECTED"):
            with self.subTest(outcome=outcome):
                receipt = self.receipt(source_build.PROFILE_SYSCALL_ABSENT)
                receipt["records"].append({"outcome": outcome})
                self.assertTrue(suite.validate_source_receipt(receipt, self.expected))


class CliTest(unittest.TestCase):
    def test_suite_cli_offers_the_source_variant(self):
        done = subprocess.run([sys.executable, str(ROOT / "scripts/localchain/sa_rpc_scenarios.py"), "--help"],
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
