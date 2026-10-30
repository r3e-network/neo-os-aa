"""Adversarial controls for complete helper inventory, not semantic proofs."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


METHOD = "SmartAccount.SmartAccount.CapReimbursementToActualCost(System.Numerics.BigInteger)"
BODY = bytes.fromhex(
    "570701412d51083010ce705f22419bf667ce41925de83171690b97262910"
    "0c200000000000000000000000000000000000000000000000000000000000000000"
    "12c0220669370400726a10ce68982610684a6a1051d045104a6a1151d045"
    "412d51083014ce412d51083015ce9e7311116bb99f74106b6a11ce9fba6c78a09e756d78b976"
    "6e10b7242a0c255265696d62757273656d656e7420657863656564732061637475616c2067617320636f7374"
    "e06a4a11ce6e9e4e1150d0456a3703005f22419bf667ce41e63f18846e220240"
)


def fixture(script=BODY, end=None):
    decoder = load("nef_decode")
    end = len(script) - 1 if end is None else end
    debug = {"id": METHOD, "name": "SmartAccount.SmartAccount,CapReimbursementToActualCost",
             "range": "0-" + str(end), "params": ["requested,Integer,0"],
             "variables": ["local%d,Any,%d" % (i, i) for i in range(7)],
             "sequence-points": ["3[0]55:39-55:63"]}
    tokens = [{"hash": "0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0",
               "method": "serialize" if i == 3 else "deserialize",
               "parametersCount": 1, "hasReturnValue": True, "callFlags": 15} for i in range(5)]
    return {"nef": {"sha256": "a" * 64, "scriptSha256": __import__("hashlib").sha256(script).hexdigest(),
                    "scriptHex": script.hex(), "instructions": decoder.decode_script(script, len(tokens)), "tokens": tokens},
            "sourceMap": {"exactByteMatch": True, "debug": {"documents": ["SmartAccount.Paymaster.cs"], "methods": [debug]},
                          "focusedMethods": [{"id": METHOD, "range": debug["range"], "source": deepcopy(debug)}]}}


class MethodInventoryTests(unittest.TestCase):
    def module(self):
        return load("method_inventory")

    def test_full_actual_body_counts_and_external_effects(self):
        report = self.module().build_method_inventory(fixture())
        self.assertEqual(report["byteCount"], 208)
        self.assertEqual(report["instructionCount"], 96)
        self.assertEqual(report["distinctOpcodeCount"], 47)
        self.assertEqual(len(report["conditionalBranches"]), 3)
        self.assertEqual(len(report["unconditionalBranches"]), 2)
        self.assertEqual(report["internalCalls"], [])
        self.assertEqual(len(report["externalEffects"]), 9)
        self.assertEqual([r["token"]["method"] for r in report["externalEffects"] if r["kind"] == "native-call"], ["deserialize", "serialize"])
        self.assertEqual(report["normalReturns"], [207])
        self.assertEqual(report["explicitFaultTerminals"], [176])
        self.assertFalse(report["wholeMethodVerified"])
        self.assertFalse(report["implementationVerified"])

    def test_region_cannot_replace_method_prefix_or_suffix(self):
        for start, end in [(110, 131), (0, 131), (3, 207)]:
            data = fixture()
            for m in [data["sourceMap"]["debug"]["methods"][0], data["sourceMap"]["focusedMethods"][0], data["sourceMap"]["focusedMethods"][0]["source"]]:
                m["range"] = "%d-%d" % (start, end)
            with self.assertRaises(ValueError):
                self.module().build_method_inventory(data)

    def test_forged_exported_size_or_omitted_edge_fails(self):
        for field, replacement in [("size", 1), ("edges", [])]:
            data = fixture()
            data["nef"]["instructions"][0][field] = replacement
            with self.assertRaisesRegex(ValueError, "independent"):
                self.module().build_method_inventory(data)

    def test_disagreeing_debug_range_or_overlap_fails(self):
        data = fixture(); data["sourceMap"]["debug"]["methods"][0]["range"] = "3-207"
        with self.assertRaises(ValueError):
            self.module().build_method_inventory(data)
        data = fixture(); data["sourceMap"]["debug"]["methods"].append({"id": "other", "range": "3-207"})
        with self.assertRaisesRegex(ValueError, "overlap"):
            self.module().build_method_inventory(data)

    def test_invalid_source_point_fails_and_unmapped_entry_is_explicit(self):
        for point in ["4[0]55:1-55:2", "3[9]55:1-55:2", "malformed"]:
            data = fixture()
            data["sourceMap"]["focusedMethods"][0]["source"]["sequence-points"] = [point]
            data["sourceMap"]["debug"]["methods"][0]["sequence-points"] = [point]
            with self.assertRaises(ValueError): self.module().build_method_inventory(data)
        self.assertEqual(self.module().build_method_inventory(fixture())["instructions"][0]["sourcePoints"], [])

    def test_raw_syscall_identifier_overrides_untrusted_exporter_label(self):
        data = fixture(); data["nef"]["instructions"][1]["syscallName"] = "Invented.Handler"
        report = self.module().build_method_inventory(data)
        self.assertEqual(report["externalEffects"][0]["name"], "System.Runtime.GetScriptContainer")
        data = fixture(bytes.fromhex("570701410000000040"))
        report = self.module().build_method_inventory(data)
        self.assertEqual(report["externalEffects"][0]["classification"], "unresolved-syscall")
        self.assertTrue(report["openExternalCorrespondence"])

    def test_calla_and_external_call_are_explicit_gaps(self):
        dynamic = fixture(bytes.fromhex("5707013640"))
        report = self.module().build_method_inventory(dynamic)
        self.assertEqual(report["unresolvedIndirectCalls"], [{"offset": 3, "target": None}])
        data = fixture(bytes.fromhex("5707013404402140"), end=5)
        data["sourceMap"]["debug"]["methods"].append({"id": "helper", "range": "6-7"})
        report = self.module().build_method_inventory(data)
        self.assertEqual(report["internalCalls"][0]["target"], 7)
        self.assertFalse(report["internalCalls"][0]["insideMethod"])

    def test_partial_certificate_exposes_complete_uncovered_prefix_suffix(self):
        module = self.module(); report = module.build_method_inventory(fixture())
        certificate = {"scope": "arithmetic-region", "sourceMethod": "M:" + METHOD,
                       "nefSha256": report["nefSha256"], "scriptSha256": report["scriptSha256"],
                       "verifiedRegions": [{"start": 110, "endExclusive": 132}], "fullImplementationVerified": False}
        coverage = module.assess_certificate_coverage(report, certificate)
        self.assertEqual(coverage["claimedInstructionCount"], 22)
        self.assertEqual(coverage["uncoveredByteRanges"], [{"start": 0, "endExclusive": 110}, {"start": 132, "endExclusive": 208}])
        self.assertFalse(coverage["wholeMethodVerified"])
        for field, value in [("scope", "whole-method"), ("fullImplementationVerified", True), ("nefSha256", "b" * 64), ("sourceMethod", "M:Wrong.Overload()")]:
            changed = deepcopy(certificate); changed[field] = value
            with self.assertRaises(ValueError): module.assess_certificate_coverage(report, changed)
        changed = deepcopy(certificate); changed["verifiedRegions"] = [{"start": 4, "endExclusive": 132}]
        with self.assertRaises(ValueError): module.assess_certificate_coverage(report, changed)

    def test_claiming_all_bytes_still_does_not_create_a_whole_method_proof(self):
        module = self.module(); report = module.build_method_inventory(fixture())
        certificate = {"scope": "arithmetic-region", "sourceMethod": METHOD,
                       "nefSha256": report["nefSha256"], "scriptSha256": report["scriptSha256"],
                       "verifiedRegions": [{"start": 0, "endExclusive": 208}], "kernelChecked": True}
        coverage = module.assess_certificate_coverage(report, certificate)
        self.assertTrue(coverage["wholeByteRangeClaimed"])
        self.assertFalse(coverage["wholeMethodVerified"])
        self.assertFalse(coverage["implementationVerified"])
        for field in ["wholeMethodVerified", "implementationVerified", "fullImplementationVerified"]:
            for value in [True, 1, "false"]:
                changed = deepcopy(certificate); changed[field] = value
                with self.assertRaises(ValueError): module.assess_certificate_coverage(report, changed)


if __name__ == "__main__":
    unittest.main()
