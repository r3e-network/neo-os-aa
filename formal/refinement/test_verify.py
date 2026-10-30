"""Adversarial tests for refinement evidence, separate from semantic proofs."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
from contextlib import redirect_stderr
from io import StringIO

SPEC = importlib.util.spec_from_file_location("refinement_gate", Path(__file__).with_name("verify.py"))
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def nef(script=b"\x11\x40", source=b"", tokens=b"\x00"):
    body = b"NEF3" + b"compiler".ljust(64, b"\x00") + bytes([len(source)]) + source
    body += b"\x00" + tokens + b"\x00\x00" + bytes([len(script)]) + script
    return body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]


def checksum(body):
    return body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]


class ContainerTests(unittest.TestCase):
    def test_exact_script_and_checksum(self):
        self.assertEqual(gate.decode_nef(nef())["script"], b"\x11\x40")

    def test_valid_checksum_does_not_hide_reserved_byte(self):
        raw = bytearray(nef()[:-4]); raw[69] = 1
        with self.assertRaisesRegex(gate.RefinementError, "reserved"):
            gate.decode_nef(checksum(raw))

    def test_truncation_and_trailing_bytes_fail(self):
        for raw in [nef()[:-1], checksum(nef()[:-4] + b"\x00")]:
            with self.subTest(raw=raw), self.assertRaises(gate.RefinementError):
                gate.decode_nef(raw)

    def test_noncanonical_length_fails_with_valid_checksum(self):
        raw = nef()[:-4]
        with self.assertRaisesRegex(gate.RefinementError, "canonical"):
            gate.decode_nef(checksum(raw[:68] + b"\xfd\x00\x00" + raw[69:]))

    def test_empty_script_and_unknown_token_flags_fail(self):
        token = b"\x01" + bytes(20) + b"\x01m" + b"\x00\x00\x01\xff"
        for raw in [nef(b""), nef(tokens=token)]:
            with self.subTest(raw=raw), self.assertRaises(gate.RefinementError):
                gate.decode_nef(raw)

    def test_every_truncated_prefix_is_rejected(self):
        raw = nef()
        for length in range(len(raw)):
            with self.subTest(length=length), self.assertRaises(gate.RefinementError):
                gate.decode_nef(raw[:length])

    def test_compiler_text_and_padding_are_checked(self):
        for position, value in [(4, 255), (67, 65)]:
            raw = bytearray(nef()[:-4]); raw[position] = value
            with self.subTest(position=position), self.assertRaises(gate.RefinementError):
                gate.decode_nef(checksum(raw))

    def test_token_count_and_reserved_method_are_checked(self):
        empty_token = bytes(20) + b"\x00\x00\x00\x00\x00"
        reserved_token = bytes(20) + b"\x02_m\x00\x00\x00\x00"
        for tokens in [bytes([129]) + empty_token * 129, b"\x01" + reserved_token]:
            with self.subTest(tokens=tokens[:30]), self.assertRaises(gate.RefinementError):
                gate.decode_nef(nef(tokens=tokens))

    def test_container_limit_includes_header_and_checksum(self):
        script = bytes(131000)
        body = b"NEF3" + bytes(64) + bytes(5) + b"\xfe" + len(script).to_bytes(4, "little") + script
        with self.assertRaisesRegex(gate.RefinementError, "limit"):
            gate.decode_nef(checksum(body))


class ToolFailureTests(unittest.TestCase):
    def test_compilation_membership_additions_removals_and_changes_are_detected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            contracts = root / "contracts"
            contracts.mkdir()
            source = contracts / "Contract.cs"
            source.write_text("original")
            original = gate.project_snapshot(root)
            for added in [contracts / "Added.cs", contracts / "Another.csproj",
                          root / "Directory.Build.targets", root / "global.json"]:
                added.write_text("new compile input")
                self.assertNotEqual(original, gate.project_snapshot(root))
                added.unlink()
                self.assertEqual(original, gate.project_snapshot(root))
            source.unlink()
            self.assertNotEqual(original, gate.project_snapshot(root))
            source.write_text("changed")
            self.assertNotEqual(original, gate.project_snapshot(root))

    def test_generated_and_unrelated_files_are_not_compilation_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "contracts").mkdir()
            original = gate.project_snapshot(root)
            for path in [root / "contracts/bin/Generated.cs", root / "contracts/obj/Temporary.cs",
                         root / "frontend/Client.cs", root / "contracts/NOTES.md"]:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("irrelevant to compiler snapshot")
            self.assertEqual(original, gate.project_snapshot(root))

    def test_tool_snapshot_detects_added_or_modified_proof_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); first = root / "Proof.v"; first.write_text("original")
            original = gate.tool_snapshot(root)
            (root / "Hidden.v").write_text("new theorem")
            self.assertNotEqual(original, gate.tool_snapshot(root))
            (root / "Hidden.v").unlink(); first.write_text("changed")
            self.assertNotEqual(original, gate.tool_snapshot(root))

    def test_generated_proof_template_is_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            template = root / "proof_tactic.txt"
            template.write_text("exact original_proof.")
            original = gate.tool_snapshot(root)
            self.assertIn(str(template), original)
            template.write_text("exact different_proof.")
            self.assertNotEqual(original, gate.tool_snapshot(root))

    def test_external_protocol_model_and_semantic_fixture_are_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            refinement = root / "refinement"
            refinement.mkdir()
            protocol = root / "OrdinarySponsorship.v"
            protocol.write_text("original protocol")
            fixture = refinement / "cap-region.json"
            fixture.write_text("{}")
            original = gate.tool_snapshot(refinement, [protocol])
            self.assertIn(str(protocol), original)
            self.assertIn(str(fixture), original)
            protocol.write_text("changed protocol")
            self.assertNotEqual(original, gate.tool_snapshot(refinement, [protocol]))

    def test_stderr_and_exit_failure_are_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "tool.log"
            with self.assertRaisesRegex(gate.RefinementError, "tool failed"):
                gate._run([sys.executable, "-c", "import sys; print('proof failed', file=sys.stderr); sys.exit(7)"], path, 5)
            self.assertIn("proof failed", path.read_text())

    def test_missing_tool_and_timeout_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "tool.log"
            for command, timeout in [([str(Path(temp) / "missing")], 1), ([sys.executable, "-c", "import time; time.sleep(1)"], 0.01)]:
                with self.subTest(command=command), self.assertRaises(gate.RefinementError):
                    gate._run(command, path, timeout)

    def test_nonempty_output_is_not_reused_or_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            receipt = Path(temp) / "result.json"; receipt.write_text("original evidence")
            with redirect_stderr(StringIO()):
                status = gate.main(["--output-dir", temp])
            self.assertEqual(status, 1)
            self.assertEqual(receipt.read_text(), "original evidence")

    def test_timeout_preserves_partial_diagnostic(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "timeout.log"
            # Interpreter startup alone can exceed short timeouts on a loaded
            # host; 1.0s still proves partial diagnostics survive a timeout.
            with self.assertRaises(gate.RefinementError):
                gate._run([sys.executable, "-c", "import time; print('kernel started', flush=True); time.sleep(5)"], path, 1.0)
            self.assertIn("kernel started", path.read_text())


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.nef = self.root / "Candidate.nef"; self.nef.write_bytes(nef())
        self.manifest = self.root / "Candidate.manifest.json"
        methods = [{"name": "value", "offset": 0, "parameters": [], "returntype": "Integer", "safe": True}]
        self.manifest.write_text(json.dumps({"abi": {"methods": methods}}))
        self.source = self.root / "Contract.cs"; self.source.write_text("class Contract {}")
        self.inventory = {
            "schema": "neoos-aa-refinement-inventory/v1", "status": "INVENTORY_ONLY",
            "inputs": {str(p): gate.sha256(p) for p in [self.source, self.nef, self.manifest]},
            "nef": {"sha256": gate.sha256(self.nef), "scriptSha256": hashlib.sha256(b"\x11\x40").hexdigest(),
                    "scriptHex": "1140", "instructions": [
                        {"offset": 0, "opcode": 17, "name": "PUSH1", "operandHex": "", "instructionHex": "11", "size": 1, "edges": [{"kind": "fallthrough", "target": 1}]},
                        {"offset": 1, "opcode": 64, "name": "RET", "operandHex": "", "instructionHex": "40", "size": 1, "edges": []}]},
            "manifest": {"sha256": gate.sha256(self.manifest), "methods": methods},
            "source": {"methods": [{"id": "Contract.Value", "operations": []}], "unsupportedOperations": []},
            "sourceMap": {"exactByteMatch": True},
        }

    def validate(self, inventory=None):
        return gate.validate_inventory(inventory or self.inventory, self.nef, self.manifest, self.root)

    def test_bound_inventory_is_not_a_semantic_proof(self):
        summary = self.validate()
        self.assertEqual(summary["abiEntries"], 1)
        self.assertNotIn("implementationVerified", summary)

    def test_changed_source_rejected_even_when_nef_is_unchanged(self):
        self.source.write_text("class Wrong {}");
        with self.assertRaisesRegex(gate.RefinementError, "input.*hash"):
            self.validate()

    def test_source_inventory_cannot_be_missing(self):
        self.inventory["inputs"] = {str(self.nef): gate.sha256(self.nef)}
        with self.assertRaises(gate.RefinementError):
            self.validate()

    def test_wrong_script_and_byte_coverage_rejected(self):
        for mutation in ["script", "hole", "duplicate", "opcode"]:
            inv = copy.deepcopy(self.inventory)
            if mutation == "script": inv["nef"]["scriptHex"] = "1240"
            if mutation == "hole": inv["nef"]["instructions"] = inv["nef"]["instructions"][1:]
            if mutation == "duplicate": inv["nef"]["instructions"][1]["offset"] = 0
            if mutation == "opcode": inv["nef"]["instructions"][0]["opcode"] = 18
            with self.subTest(mutation=mutation), self.assertRaises(gate.RefinementError): self.validate(inv)

    def test_deleted_abi_or_wrong_boundary_rejected(self):
        inv = copy.deepcopy(self.inventory); inv["manifest"]["methods"] = []
        with self.assertRaises(gate.RefinementError): self.validate(inv)
        self.inventory["nef"]["instructions"][0]["edges"] = [{"kind": "branch", "target": 99}]
        with self.assertRaisesRegex(gate.RefinementError, "target"):
            self.validate()

    def test_mapping_from_other_build_rejected(self):
        self.inventory["sourceMap"]["exactByteMatch"] = False
        with self.assertRaisesRegex(gate.RefinementError, "mapping"):
            self.validate()

    def test_partial_kernel_proof_cannot_mark_whole_implementation_verified(self):
        report = gate.coverage_report(self.inventory, {"scope": "arithmetic-region", "kernelChecked": True})
        self.assertFalse(report["implementationVerified"])
        self.assertEqual(report["unprovedEntrypoints"], ["value/0"])
        self.assertEqual(report["verifiedEntrypoints"], [])
        self.assertIn("APPLICATION_ENGINE_REFINEMENT", report["openObligations"])

    def test_forged_full_scope_is_rejected(self):
        with self.assertRaises(gate.RefinementError):
            gate.coverage_report(self.inventory, {"scope": "whole-artifact", "kernelChecked": True})

    def helper_receipts(self):
        identity = {"nefSha256": self.inventory["nef"]["sha256"],
                    "scriptSha256": self.inventory["nef"]["scriptSha256"],
                    "methodBytesSha256": "a" * 64, "start": 100, "endExclusive": 108,
                    "byteCount": 8, "instructionCount": 4}
        common = {"kernelChecked": True, "fullImplementationVerified": False}
        receipts = {
            "method": {**common, "scope": "complete-helper-reference-refinement",
                       "referenceRefinementVerified": True,
                       "nefSha256": identity["nefSha256"], "scriptSha256": identity["scriptSha256"],
                       "methodSha256": identity["methodBytesSha256"], "methodRange": [100, 108],
                       "byteCount": 8, "instructionCount": 4, "sourceProjectionSha256": "b" * 64},
            "numeric": {**common, "scope": "numeric-coercions"},
            "reservation": {**common, "scope": "reservation-arithmetic"},
        }
        return identity, receipts

    def test_complete_helper_reference_proof_keeps_every_abi_entry_open(self):
        identity, receipts = self.helper_receipts()
        report = gate.coverage_report(self.inventory, {"scope": "arithmetic-region", "kernelChecked": True},
                                      supporting_proofs=receipts, helper_inventory=identity,
                                     expected_source_projection_sha256="b" * 64)
        self.assertFalse(report["implementationVerified"])
        self.assertEqual(report["unprovedEntrypoints"], ["value/0"])
        self.assertEqual(report["verifiedEntrypoints"], [])
        self.assertEqual(report["supportingProofs"], receipts)
        self.assertIn("CALLER_STATIC_AND_LEDGER_INVARIANTS", report["openObligations"])
        self.assertIn("APPLICATION_ENGINE_REFINEMENT", report["openObligations"])

    def test_helper_proof_cannot_be_promoted_or_bound_to_a_different_method(self):
        identity, original = self.helper_receipts()
        mutations = [("scope", "whole-artifact"), ("kernelChecked", False),
                     ("referenceRefinementVerified", False), ("fullImplementationVerified", True),
                     ("nefSha256", "c" * 64), ("scriptSha256", "c" * 64),
                     ("methodSha256", "c" * 64), ("methodRange", [101, 108]),
                     ("byteCount", 7), ("instructionCount", 3), ("sourceProjectionSha256", ""),
                     ("sourceProjectionSha256", "0" * 64)]
        for field, value in mutations:
            receipts = copy.deepcopy(original); receipts["method"][field] = value
            with self.subTest(field=field), self.assertRaises(gate.RefinementError):
                gate.coverage_report(self.inventory, {"scope": "arithmetic-region", "kernelChecked": True},
                                     supporting_proofs=receipts, helper_inventory=identity,
                                     expected_source_projection_sha256="b" * 64)

    def test_missing_or_unchecked_supporting_lane_fails_closed(self):
        identity, original = self.helper_receipts()
        for key in original:
            for failure in ("missing", "unchecked", "wrong-scope", "promoted"):
                receipts = copy.deepcopy(original)
                if failure == "missing": del receipts[key]
                elif failure == "unchecked": receipts[key]["kernelChecked"] = False
                elif failure == "wrong-scope": receipts[key]["scope"] = "complete-artifact"
                else: receipts[key]["fullImplementationVerified"] = True
                with self.subTest(key=key, failure=failure), self.assertRaises(gate.RefinementError):
                    gate.coverage_report(self.inventory, {"scope": "arithmetic-region", "kernelChecked": True},
                                         supporting_proofs=receipts, helper_inventory=identity,
                                     expected_source_projection_sha256="b" * 64)

    def test_duplicate_manifest_dispatch_rejected(self):
        self.inventory["manifest"]["methods"] *= 2
        self.manifest.write_text(json.dumps({"abi": {"methods": self.inventory["manifest"]["methods"]}}))
        self.inventory["inputs"][str(self.manifest)] = gate.sha256(self.manifest)
        self.inventory["manifest"]["sha256"] = gate.sha256(self.manifest)
        with self.assertRaisesRegex(gate.RefinementError, "duplicate"):
            self.validate()

    def test_forged_instruction_size_cannot_hide_the_return(self):
        self.inventory["nef"]["instructions"] = [{"offset": 0, "opcode": 17, "name": "PUSH1", "size": 2, "edges": []}]
        with self.assertRaises(gate.RefinementError): self.validate()

    def test_forged_instruction_name_cannot_change_opcode_semantics(self):
        self.inventory["nef"]["instructions"][0]["name"] = "RET"
        with self.assertRaises(gate.RefinementError): self.validate()

    def test_omitted_branch_edge_is_rejected(self):
        script = b"\x22\x02\x40"  # JMP +2; RET
        self.nef.write_bytes(nef(script)); self.inventory["inputs"][str(self.nef)] = gate.sha256(self.nef)
        target = self.inventory["nef"]
        target.update(sha256=gate.sha256(self.nef), scriptHex=script.hex(), scriptSha256=hashlib.sha256(script).hexdigest())
        target["instructions"] = [
            {"offset": 0, "opcode": 34, "name": "JMP", "operandHex": "02", "instructionHex": "2202", "size": 2, "edges": []},
            {"offset": 2, "opcode": 64, "name": "RET", "operandHex": "", "instructionHex": "40", "size": 1, "edges": []}]
        with self.assertRaises(gate.RefinementError): self.validate()

    def test_unknown_opcode_cannot_be_added_by_inventory(self):
        script = b"\xff\x40"
        self.nef.write_bytes(nef(script)); self.inventory["inputs"][str(self.nef)] = gate.sha256(self.nef)
        target = self.inventory["nef"]
        target.update(sha256=gate.sha256(self.nef), scriptHex=script.hex(), scriptSha256=hashlib.sha256(script).hexdigest())
        target["instructions"][0]["opcode"] = 255
        with self.assertRaises(gate.RefinementError): self.validate()


if __name__ == "__main__":
    unittest.main()
