"""Tests for whole-helper byte binding and effectful execution, not an AE proof."""
import copy
import hashlib
import gzip
import json
from pathlib import Path
import unittest
import shutil
import subprocess
import sys
import tempfile

import method_proofs as method

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / "docs/reports/aa-implementation-refinement-20261013/inventory.json.gz"


def materialize_nef_fixture(inventory, directory):
    """Reconstitute the exact pinned NEF using fixture script/token data.

    The first 68 bytes below were acquired from the original candidate. Its
    empty source URL is retained. This is a test fixture, not a rebuilt contract;
    the full resulting bytes must match the original independently pinned SHA.
    No user's SDK/package cache, checkout path or build output is consulted.
    """
    def variable_size(value):
        if value < 253:
            return bytes([value])
        if value < 65536:
            return b"\xfd" + value.to_bytes(2, "little")
        return b"\xfe" + value.to_bytes(4, "little")

    def variable_bytes(value):
        return variable_size(len(value)) + value

    header = bytes.fromhex("4e4546334e656f2e436f6d70696c65722e43536861727020332e392e312b35666139353636653531363565646532313635613962653166346130313230633137362e2e2e")
    tokens = inventory["nef"]["tokens"]
    body = header + b"\x00\x00" + variable_size(len(tokens))
    for token in tokens:
        body += bytes.fromhex(token["hash"][2:])[::-1]
        body += variable_bytes(token["method"].encode("utf-8"))
        body += token["parametersCount"].to_bytes(2, "little")
        body += bytes([int(token["hasReturnValue"]), token["callFlags"]])
    body += b"\x00\x00" + variable_bytes(bytes.fromhex(inventory["nef"]["scriptHex"]))
    nef = body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    if hashlib.sha256(nef).hexdigest() != inventory["nef"]["sha256"]:
        raise AssertionError("Reconstituted test NEF does not match the original candidate")
    path = Path(directory) / "UnifiedSmartWalletV3.nef"
    path.write_bytes(nef)
    return path

class MethodProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with gzip.open(INVENTORY, "rt") as stream:
            cls.inventory = json.load(stream)
        cls.fixture_directory = tempfile.TemporaryDirectory(prefix="aa-cap-nef-fixture-")
        cls.addClassCleanup(cls.fixture_directory.cleanup)
        nef = materialize_nef_fixture(cls.inventory, cls.fixture_directory.name)
        # Replace host-specific source/compiler inputs only in this fixture
        # assembly. Production CLI still checks every fresh exporter input.
        cls.inventory["inputs"] = {str(nef):cls.inventory["nef"]["sha256"]}
        cls.program = method.bind_method(cls.inventory)

    def test_complete_method_is_bound(self):
        self.assertEqual(self.program["start"], 13557)
        self.assertEqual(self.program["end"], 13765)
        self.assertEqual(len(self.program["bytes"]), 208)
        self.assertEqual(len(self.program["instructions"]), 96)

    def test_empty_storage_reserves_from_actual_fee(self):
        result = method.execute(self.program["bytes"], requested=90, system_fee=50,
                                network_fee=10, tx_hash=bytes([1])*32, stored=None)
        self.assertEqual(result["status"], "HALT")
        self.assertEqual(result["result"], 60)
        self.assertEqual(result["stored"].reserved, 60)
        self.assertEqual(result["stored"].tx_hash, bytes([1])*32)
        self.assertEqual(result["effects"].count("GetScriptContainer"), 3)
        self.assertEqual(result["effects"].count("Storage.Put"), 1)

    def test_matching_transaction_uses_shared_budget(self):
        ledger = method.Ledger(bytes([1])*32, 40, "Array")
        result = method.execute(self.program["bytes"], requested=30, system_fee=50,
                                network_fee=10, tx_hash=bytes([1])*32, stored=ledger)
        self.assertEqual(result["result"], 20)
        self.assertEqual(result["stored"].reserved, 60)

    def test_changed_transaction_resets_mutable_struct(self):
        ledger = method.Ledger(bytes([2])*32, 40, "Struct")
        result = method.execute(self.program["bytes"], requested=30, system_fee=50,
                                network_fee=10, tx_hash=bytes([1])*32, stored=ledger)
        self.assertEqual(result["result"], 30)
        self.assertEqual(result["stored"].reserved, 30)
        self.assertEqual(result["stored"].kind, "Struct")

    def test_exhausted_budget_aborts_without_storage_put(self):
        ledger = method.Ledger(bytes([1])*32, 60, "Array")
        result = method.execute(self.program["bytes"], requested=30, system_fee=50,
                                network_fee=10, tx_hash=bytes([1])*32, stored=ledger)
        self.assertEqual(result["status"], "ABORT")
        self.assertEqual(result["stored"], ledger)
        self.assertNotIn("Storage.Put", result["effects"])

    def test_zero_fee_update_overflow_faults_without_write(self):
        ledger = method.Ledger(bytes([1])*32, (1 << 255)-1, "Array")
        result = method.execute(self.program["bytes"], requested=1, system_fee=0,
                                network_fee=0, tx_hash=bytes([1])*32, stored=ledger)
        self.assertEqual(result["status"], "FAULT")
        self.assertEqual(result["stored"], ledger)
        self.assertNotIn("Storage.Put", result["effects"])

    def execute(self, *, stored=None, tx_hash=bytes([1])*32, requested=30,
                system_fee=50, network_fee=10, **kwargs):
        return method.execute(self.program["bytes"], requested=requested, system_fee=system_fee,
                              network_fee=network_fee, tx_hash=tx_hash, stored=stored, **kwargs)

    def test_overreserved_paid_ledger_aborts(self):
        before = method.Ledger(bytes([1])*32, 100, "Struct")
        result = self.execute(stored=before)
        self.assertEqual((result["status"], result["stored"]), ("ABORT", before))
        self.assertEqual(result["error"], method.ERROR)
        self.assertNotIn("Serialize", result["effects"])

    def test_safe_estimation_keeps_requested_quote(self):
        result = self.execute(stored=method.Ledger(bytes([1])*32, 40), system_fee=0, network_fee=0)
        self.assertEqual((result["status"], result["result"], result["stored"].reserved), ("HALT", 30, 70))

    def test_changed_hash_discards_large_previous_reservation(self):
        result = self.execute(stored=method.Ledger(bytes([2])*32, method.LIMIT-1))
        self.assertEqual((result["status"], result["result"], result["stored"].reserved), ("HALT", 30, 30))

    def test_zero_hash_initialization_without_reset(self):
        result = self.execute(tx_hash=bytes(32))
        self.assertEqual((result["status"], result["stored"].tx_hash), ("HALT", bytes(32)))
        self.assertNotIn("Deserialize", result["effects"])

    def test_missing_static_slot_faults(self):
        result = self.execute(static_values={})
        self.assertEqual(result["status"], "FAULT")
        self.assertNotIn("Storage.Get", result["effects"])

    def test_wrong_static_slot_type_or_key_faults(self):
        for key in (b"\x21", bytearray(b"\x22")):
            with self.subTest(key=key):
                self.assertEqual(self.execute(static_values={34:key})["status"], "FAULT")

    def test_malformed_storage_is_not_an_expected_result_oracle(self):
        for stored in ({"Reserved": 0}, b"garbage", method.Ledger(bytes(32), 0, "Map")):
            with self.subTest(stored=stored):
                result = self.execute(stored=stored)
                self.assertEqual(result["status"], "FAULT")
                self.assertNotIn("Storage.Put", result["effects"])

    def test_heap_alias_mutation_is_serialized(self):
        result = self.execute(stored=method.Ledger(bytes([2])*32, 900, "Struct"))
        reference = result["locals"][2]
        self.assertIsInstance(reference, method.Ref)
        kind, fields = result["heap"][reference.index]
        self.assertEqual((kind, fields), ("Struct", [bytes([1])*32, 30]))
        self.assertEqual(result["stored"], method.Ledger(*fields, kind))

    def test_paths_cover_every_actual_instruction(self):
        cases = [dict(), dict(tx_hash=bytes(32)),
                 dict(stored=method.Ledger(bytes([1])*32, 40)),
                 dict(stored=method.Ledger(bytes([2])*32, 40, "Struct")),
                 dict(stored=method.Ledger(bytes([1])*32, 60))]
        offsets = {offset for case in cases for offset in self.execute(**case)["instructionOffsets"]}
        self.assertEqual(offsets, {item["offset"] for item in self.program["instructions"]})

    def test_token_table_mismatch_rejected(self):
        inventory = copy.deepcopy(self.inventory)
        inventory["nef"]["tokens"][3]["method"] = "deserialize"
        with self.assertRaisesRegex(ValueError, "token effect contract"):
            method.bind_method(inventory)

    def test_partial_helper_boundary_rejected(self):
        inventory = copy.deepcopy(self.inventory)
        entry = next(item for item in inventory["sourceMap"]["focusedMethods"] if item["id"] == method.METHOD)
        entry["range"] = "13667-13688"
        with self.assertRaisesRegex(ValueError, "boundary"):
            method.bind_method(inventory)

    def test_exported_instruction_drift_rejected(self):
        inventory = copy.deepcopy(self.inventory)
        entry = next(item for item in inventory["nef"]["instructions"] if item["offset"] == 13667)
        entry["opcode"] = 255
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            method.bind_method(inventory)

    def test_debug_correspondence_flag_rejected(self):
        inventory = copy.deepcopy(self.inventory)
        inventory["sourceMap"]["exactByteMatch"] = False
        with self.assertRaisesRegex(ValueError, "correspondence unavailable"):
            method.bind_method(inventory)


    def test_min_to_max_control_has_observable_semantic_difference(self):
        mutated = list(self.program["bytes"])
        mutated[13687-method.START] = 0xba
        result = method.execute(mutated, requested=90, system_fee=50, network_fee=10,
                                tx_hash=bytes([1])*32, stored=None)
        self.assertEqual((result["status"], result["result"], result["stored"].reserved), ("HALT", 90, 90))

    def test_source_fixture_covers_full_statement_program(self):
        from method_source import project_method
        fixture = json.loads((ROOT / "formal/refinement/fixtures/cap-method-source.json").read_text())
        projection = project_method(fixture)
        self.assertEqual(len(projection["statements"]), 12)
        self.assertEqual(projection["statements"][-1], ["SReturn", ["ELocal", 6]])
        certificate = method.render_certificate(self.program, projection)
        self.assertIn("Theorem complete_helper_no_fault_or_timeout", certificate)
        self.assertIn("actual_zero_estimation_overflow_counterexample", certificate)
        self.assertEqual(set(method.THEOREM_NAMES) - set(method.declared_names(certificate)), set())

    def test_failed_cli_overwrites_old_success_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "receipt.json"
            report.write_text(json.dumps({"referenceRefinementVerified": True}))
            result = subprocess.run([sys.executable, str(Path(method.__file__)),
                                     "--inventory", str(Path(directory) / "missing.json"),
                                     "--output-dir", directory, "--json-report", str(report)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            failure = json.loads(report.read_text())
            self.assertEqual(failure["status"], "FAIL")
            self.assertIs(failure["referenceRefinementVerified"], False)

    @unittest.skipUnless(shutil.which("coqc") and shutil.which("coqchk"), "Coq kernel tools required")
    def test_full_fixture_kernel_certificate_and_semantic_controls(self):
        # The historical target inventory pins the same actual NEF. Its old
        # exporter lacked collection metadata, so the independent source-only
        # fixture supplies that metadata for this portable test assembly only.
        # Production CLI always consumes one complete fresh exporter inventory.
        fixture = json.loads((ROOT / "formal/refinement/fixtures/cap-method-source.json").read_text())
        inventory = copy.deepcopy(self.inventory)
        inventory["source"] = fixture["source"]
        with tempfile.TemporaryDirectory() as directory:
            receipt = method.run_proofs(inventory, directory, controls=True)
            self.assertIs(receipt["kernelChecked"], True)
            self.assertIs(receipt["referenceRefinementVerified"], True)
            self.assertIs(receipt["fullImplementationVerified"], False)
            self.assertEqual(receipt["methodRange"], [13557, 13765])
            self.assertEqual((receipt["byteCount"], receipt["instructionCount"]), (208, 96))
            self.assertEqual(len(receipt["semanticControls"]), 6)
            self.assertTrue(all(item["definitionsCompiled"] and item["certificateRejected"]
                                for item in receipt["semanticControls"]))
            self.assertEqual(receipt["closedAssumptionCount"],
                             sum(len(items) for items in receipt["assumptionDeclarations"].values()))
            self.assertGreater(receipt["closedAssumptionCount"], len(method.THEOREM_NAMES))


if __name__ == "__main__":
    unittest.main()
