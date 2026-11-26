"""Boundary tests for the native source budget and module-ownership gate."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import native_source_budget as budget

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(budget.__file__).resolve()
CLEAN = """namespace Neo.SmartContract.Native
{
    internal static class Clean
    {
        private const byte ProxyPrefix = 0x11;
        private const int Fields = SmartAccountModuleProtocol.OpNonce;
    }
}
"""
CLEAN_LINES = len(CLEAN.splitlines())


def write(source, name, text):
    path = Path(source) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class MeasureTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.source = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_counts_every_cs_file_but_the_shared_native_base(self):
        write(self.source, "SmartAccount.cs", "a\nb\nc\n")
        write(self.source, "NativeContract.cs", "x\ny\nz\nw\nv\n")
        report = budget.evaluate(self.source, 3)
        self.assertEqual(report["files"], {"SmartAccount.cs": 3})
        self.assertEqual(report["total"], 3)
        self.assertEqual(report["headroom"], 0)
        self.assertEqual(report["status"], "PASS")

    def test_metric_matches_physical_line_count(self):
        path = write(self.source, "SmartAccount.cs", "one\ntwo\n\nthree\n")
        self.assertEqual(budget.measure([path]), {"SmartAccount.cs": 4})
        self.assertEqual(budget.evaluate(self.source, 4)["total"], 4)

    def test_budget_is_inclusive_and_reports_the_overflow(self):
        write(self.source, "SmartAccount.cs", "a\nb\nc\n")
        self.assertEqual(budget.evaluate(self.source, 3)["status"], "PASS")
        failed = budget.evaluate(self.source, 2)
        self.assertEqual(failed["status"], "FAIL")
        self.assertEqual(failed["headroom"], -1)
        self.assertIn("3 exceed the 2-line budget by 1", failed["error"])
        self.assertIn("SmartAccount.cs 3", failed["error"])

    def test_missing_source_directory_raises(self):
        with self.assertRaises(ValueError) as raised:
            budget.evaluate(self.source / "absent", 4)
        self.assertIn("not found", str(raised.exception))


class OwnershipTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.source = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def violations(self, text):
        return budget.ownership_violations([write(self.source, "SmartAccount.cs", text)])

    def test_native_prefixes_below_the_module_floor_are_clean(self):
        self.assertEqual(self.violations(CLEAN), [])

    def test_module_owned_storage_prefix_is_reported(self):
        found = self.violations("        private const byte RecoveryPrefix = 0x9A;\n")
        self.assertEqual(len(found), 1)
        self.assertIn("SmartAccount.cs:1", found[0])
        self.assertIn("RecoveryPrefix=0x9A is module-owned", found[0])

    def test_module_private_method_policy_type_and_constant_are_reported(self):
        found = self.violations("            BeginRecovery(GetPolicySnapshot(ThresholdPolicy, SA_INTENT_LIMIT));\n"
                                "            beginRecovery(ModuleProtocol.MaxMembers);\n")
        self.assertTrue(any("'beginRecovery'" in item for item in found))
        self.assertTrue(any("'getPolicySnapshot'" in item for item in found))
        self.assertTrue(any("'ThresholdPolicy'" in item for item in found))
        self.assertTrue(any("'SA_INTENT_'" in item for item in found))
        self.assertTrue(any("ModuleProtocol constant table" in item for item in found))

    def test_native_module_protocol_scope_is_not_a_module_dependency(self):
        self.assertEqual(budget.ownership_violations(
            [write(self.source, "SmartAccount.cs", "x = SmartAccountModuleProtocol.MaxModuleCount;\n")]), [])

    def test_comments_are_stripped_before_matching(self):
        self.assertEqual(self.violations("        // beginRecovery is module policy\n"), [])
        self.assertTrue(self.violations("        BeginRecovery(); // module policy\n"))


class CommandLineTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.source = Path(self.temporary.name)
        write(self.source, "SmartAccount.cs", CLEAN)
        self.addCleanup(self.temporary.cleanup)

    def run_script(self, *arguments):
        return subprocess.run([sys.executable, str(SCRIPT), "--source", str(self.source), *arguments],
                              capture_output=True, text=True, cwd=ROOT, timeout=120)

    def test_pass_exits_zero_with_a_receipt_and_a_summary(self):
        completed = self.run_script("--budget", str(CLEAN_LINES))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["status"], "PASS")
        self.assertIn(f"{CLEAN_LINES}/{CLEAN_LINES} SmartAccount-specific lines", completed.stderr)

    def test_fail_exits_one_without_a_traceback(self):
        completed = self.run_script("--budget", "1")
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(json.loads(completed.stdout)["status"], "FAIL")
        self.assertIn("exceed the 1-line budget", completed.stderr)
        self.assertNotIn("Traceback", completed.stderr)

    def test_receipt_can_be_written_to_a_file(self):
        receipt = Path(self.temporary.name) / "receipt.json"
        completed = self.run_script("--budget", str(CLEAN_LINES), "--output", str(receipt))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["total"], CLEAN_LINES)

    def test_missing_source_reports_fail_without_a_traceback(self):
        completed = subprocess.run([sys.executable, str(SCRIPT), "--source", str(self.source / "gone")],
                                   capture_output=True, text=True, cwd=ROOT, timeout=120)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(json.loads(completed.stdout)["status"], "FAIL")
        self.assertIn("not found", completed.stderr)
        self.assertNotIn("Traceback", completed.stderr)


class RepositoryGateTest(unittest.TestCase):
    """The committed sources must satisfy the gate the repository ships."""

    def test_committed_native_sources_pass_the_default_gate(self):
        report = budget.evaluate(ROOT / "contracts/native/SmartAccount", budget.BUDGET)
        self.assertEqual(report["status"], "PASS", report.get("error"))
        self.assertGreaterEqual(report["headroom"], 0)
        self.assertEqual(budget.BUDGET, 4373)
        self.assertNotIn("NativeContract.cs", report["files"])


if __name__ == "__main__":
    unittest.main()
