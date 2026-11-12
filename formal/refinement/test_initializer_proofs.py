"""Portable source/NEF initializer binding and kernel rejection controls."""
import copy
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import initializer_proofs as proof
from test_method_proofs import load_inventory, materialize_nef_fixture

ROOT = Path(__file__).resolve().parents[2]


class InitializerProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inventory = load_inventory()
        current = json.loads((Path(__file__).with_name("fixtures") / "current-initializer-source.json").read_text())["fixtureOrigin"]
        if cls.inventory["nef"]["sha256"] == current["nefSha256"]:
            cls.inventory["source"] = current["source"]
            cls.inventory["sourceMap"]["debug"]["static-variables"] = current["staticVariables"]
        else:
            cls.inventory["source"] = json.loads((Path(__file__).with_name("fixtures") / "initializer-source.json").read_text())["source"]
        cls.directory = tempfile.TemporaryDirectory(prefix="aa-source-init-fixture-")
        cls.addClassCleanup(cls.directory.cleanup)
        nef = materialize_nef_fixture(cls.inventory, cls.directory.name)
        cls.inventory["inputs"] = {str(nef): cls.inventory["nef"]["sha256"]}
        # Bind a portable ABI-only test manifest without claiming the original
        # production manifest container hash or depending on ignored outputs.
        manifest = Path(cls.directory.name) / "SmartAccountV3.manifest.json"
        raw = json.dumps({"abi": {"methods": cls.inventory["manifest"]["methods"]}}, sort_keys=True).encode()
        manifest.write_bytes(raw)
        cls.inventory["manifest"]["sha256"] = hashlib.sha256(raw).hexdigest()
        cls.inventory["inputs"][str(manifest)] = cls.inventory["manifest"]["sha256"]

    def test_exact_bijection_all_source_values(self):
        fixture = (Path(__file__).with_name("fixtures") / "current-initializer-source.json").read_text()
        self.assertNotRegex(fixture, r'/(?:Users|private|var|opt)/')
        bound = proof.bind(self.inventory)
        self.assertEqual(len(bound["slots"]), len(self.inventory["sourceMap"]["debug"]["static-variables"]))
        self.assertEqual(bound["slots"]["Prefix_TransactionReimbursement"], 38)

    def test_missing_duplicate_slot_and_wrong_type_rejected(self):
        for kind in ("missing", "duplicate", "type"):
            inventory = copy.deepcopy(self.inventory)
            slots = inventory["sourceMap"]["debug"]["static-variables"]
            if kind == "missing": slots.pop()
            elif kind == "duplicate": slots.append(slots[0])
            else: slots[0] = slots[0].replace("ByteArray", "Integer")
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                proof.bind(inventory)

    def test_actual_source_program_is_target_independent(self):
        before = proof.bind(self.inventory)
        changed = copy.deepcopy(self.inventory)
        contract = next(t for t in changed["source"]["types"]
                        if t["id"] == proof.initializer_source.TYPE_ID)
        field_ids = {
            field["id"] for field in contract["fields"]
            if field["isStatic"] and field["isReadOnly"] and field["constant"] is None
        }
        initializer_operations = []
        for initializer in changed["source"]["initializers"]:
            for operation in initializer["operations"]:
                initialized = operation.get("semanticCollections", {}).get(
                    "IFieldInitializerOperation.InitializedFields", {}).get("items", [])
                if any(item.get("id") in field_ids for item in initialized):
                    initializer_operations.append(operation)
        node = next(i for operation in initializer_operations
                    for i in proof.initializer_source.nodes(operation)
                    if i["kind"] == "Literal" and i["type"] == "string")
        node["constant"]["value"]["value"] = "changed"
        after = proof.bind(changed)
        self.assertNotEqual(before["source"]["sourceProjectionSha256"], after["source"]["sourceProjectionSha256"])
        self.assertEqual(before["initializer"], after["initializer"])

    def test_full_kernel_and_semantic_rejection(self):
        with tempfile.TemporaryDirectory(prefix="aa-source-init-kernel-") as output:
            result = proof.run_proofs(self.inventory, output)
            self.assertTrue(result["kernelChecked"])
            self.assertEqual(result["fieldCount"], len(self.inventory["sourceMap"]["debug"]["static-variables"]))
            self.assertFalse(result["fullImplementationVerified"])
            self.assertEqual(len(result["semanticControls"]), 4)


if __name__ == "__main__":
    unittest.main()
