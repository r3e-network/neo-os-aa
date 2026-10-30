"""Semantic proof controls for the actual sponsored-cap NEF region."""
import importlib.util
import json
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


class CapProofTests(unittest.TestCase):
    def prover(self):
        spec = importlib.util.spec_from_file_location("cap_region_prover", ROOT / "prove.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_legal_opcode_semantic_mutants_are_kernel_rejected(self):
        module = self.prover()
        with tempfile.TemporaryDirectory() as temporary:
            receipt = module.run_semantic_controls(Path(temporary))
        self.assertTrue(receipt["definitionsCompiled"])
        self.assertEqual(set(receipt["rejected"]), {
            "min-to-max", "remaining-sub-to-add", "estimation-one-to-zero",
            "unchecked-overflow", "wrong-operand-order", "source-min-to-max",
            "source-sub-to-add", "source-constant-one-to-zero", "unexpected-frame-write"})

    def test_arithmetic_proof_has_universal_preservation_and_fault_theorems(self):
        module = self.prover()
        with tempfile.TemporaryDirectory() as temporary:
            receipt = module.run_model_proofs(Path(temporary))
        self.assertTrue(receipt["kernelChecked"])
        self.assertFalse(receipt["fullImplementationVerified"])
        self.assertIn("cap_all_inputs_preserved", receipt["closedDeclarations"])
        self.assertIn("integer_overflow_faults", receipt["closedDeclarations"])

    def test_typed_source_projection_rejects_type_call_operator_and_flags(self):
        module = self.prover()
        fixture = json.loads((ROOT / "fixtures/cap-region.json").read_text())
        expression = fixture["operations"][0][1]
        mutations = [lambda n: n.update(type="bool"),
                     lambda n: n["details"].update(operator="Divide"),
                     lambda n: n["details"].update(checked=True),
                     lambda n: n["boundMetadata"].update({"IBinaryOperation.IsCompareText": True})]
        for mutate in mutations:
            changed = deepcopy(expression); mutate(changed)
            with self.assertRaises(ValueError):
                module.expression_from_operation(changed, {"actualCost": ("input", "Cost")})
        changed = deepcopy(expression)
        invocation = next(n for n in module.walk(changed) if n["kind"] == "Invocation")
        invocation["details"]["callee"] = "M:Unexpected.Min(System.Numerics.BigInteger,System.Numerics.BigInteger)"
        with self.assertRaises(ValueError):
            module.expression_from_operation(changed, {"actualCost": ("input", "Cost")})

    def test_source_wrapper_rejects_ignored_extra_statement(self):
        module = self.prover()
        wrapper = {"kind": "VariableDeclaration", "type": None, "details": {},
                   "children": [{"kind": "VariableDeclarator"}, {"kind": "Invocation"}],
                   "boundMetadata": {"IVariableDeclarationOperation.Initializer": None}}
        with self.assertRaisesRegex(ValueError, "extra children"):
            module.declaration_wrapper(wrapper, "VariableDeclaration")

    def test_region_cannot_execute_pushdata_payload_as_instructions(self):
        module = self.prover()
        fixture = json.loads((ROOT / "fixtures/cap-region.json").read_text())
        payload = bytes.fromhex(fixture["hex"])
        script = bytes([12, len(payload)]) + payload + bytes([64])
        declarations = [(i, {"location": {"path": "cap.cs", "startLine": i + 1, "endLine": i + 1}}, None)
                        for i in range(3)]
        inventory = {"nef": {"scriptHex": script.hex(), "tokens": []}, "sourceMap": {
            "debug": {"documents": ["cap.cs"]}, "focusedMethods": [{"id": module.METHOD,
                "range": "0-24", "source": {"params": ["requested,Integer,0"],
                    # The debug frame must match the actual 8-slot INITSLOT, including the
                    # VM-integer-range margin local; otherwise the locals gate fires first
                    # and this test never reaches the instruction-boundary check it names.
                    "variables": ["transactionHash,Hash256,0", "data,ByteArray,1", "budget,Any,2", "actualCost,Integer,3",
                                  "estimationFlag,Integer,4", "cap,Integer,5", "settled,Integer,6",
                                  "vmMax,Integer,7"],
                    "sequence-points": ["2[0]1:1-1:2", "23[0]3:1-3:2"]}}]}}
        with self.assertRaisesRegex(ValueError, "actual instruction boundaries"):
            module.selected_region(inventory, declarations)


if __name__ == "__main__":
    unittest.main()
