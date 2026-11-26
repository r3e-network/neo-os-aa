"""scripts/native_purity.py: the native SmartAccount source carries no SDK-style logic.

python -m unittest discover -s scripts -p 'test_native_*.py'
"""
import contextlib
import io
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import native_purity  # noqa: E402

REPOSITORY = Path(__file__).resolve().parents[1] / "contracts/native/SmartAccount"
CLEAN = "using Neo;\nusing Neo.SmartContract;\n\nclass Clean : NativeContract\n{\n    int Count => 1;\n}\n"
#: one line per rule that the rule must refuse.
FORBIDDEN = {
    "embedded engine": "ApplicationEngine embedded = new ApplicationEngine(trigger, container, block, settings);",
    "engine runs a script": "engine.LoadScript(script);",
    "opcode interpretation": "OpCode code = instruction.OpCode;",
    "retired Envelope codec": "object envelope = SmartAccountEnvelope.Decode(bytes);",
    "retired bounded call": "engine.SysCall(ApplicationEngine.System_Contract_CallWithGasLimit, target, method, args);",
    "self-built gas budget": "long budget = BudgetDatoshi;",
    "runtime script construction": "using ScriptBuilder builder = new();",
}
REVIEW = "例外需复核"


class NativePurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "SmartAccount"
        self.source.mkdir()
        # The real file the pinned exceptions live in, so the fixture exercises them too.
        shutil.copyfile(REPOSITORY / "SmartAccountProtocol.cs", self.source / "SmartAccountProtocol.cs")
        (self.source / "SmartAccount.cs").write_text(CLEAN, encoding="utf-8", newline="\n")

    def copy_of_repository(self):
        """A scratch copy of the real native source, safe to mutate."""
        shutil.rmtree(self.source)
        shutil.copytree(REPOSITORY, self.source)
        return self.source / "SmartAccountProtocol.cs"

    def run_gate(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = native_purity.main(["--source", str(self.source)])
        return status, out.getvalue(), err.getvalue()

    def test_a_clean_source_passes(self):
        self.assertEqual(native_purity.evaluate(self.source), [])
        status, out, _ = self.run_gate()
        self.assertEqual(status, 0, out)
        self.assertIn("native purity: PASS", out)

    def test_every_rule_refuses_its_own_pattern_and_names_itself(self):
        for name, line in FORBIDDEN.items():
            with self.subTest(rule=name):
                (self.source / "SmartAccount.cs").write_text(
                    CLEAN.replace("    int Count => 1;", "    void Body() { " + line + " }"), encoding="utf-8", newline="\n")
                status, _, err = self.run_gate()
                self.assertEqual(status, 1, name)
                self.assertIn("native purity: FAIL", err)
                self.assertIn(f"SmartAccount.cs:6: [{name}] void Body() {{ {line} }}", err)

    def test_the_complete_retired_design_fails_together(self):
        body = "\n".join("        " + line for line in FORBIDDEN.values())
        (self.source / "SmartAccount.cs").write_text(
            CLEAN.replace("    int Count => 1;", "    void Body()\n    {\n" + body + "\n    }"),
            encoding="utf-8", newline="\n")
        problems = native_purity.evaluate(self.source)
        self.assertEqual(len(problems), len(FORBIDDEN))
        for name in FORBIDDEN:
            self.assertIn(f"[{name}]", " ".join(problems))

    def test_the_upstream_base_class_is_not_scanned(self):
        (self.source / "NativeContract.cs").write_text(
            CLEAN.replace("    int Count => 1;", "    void Body() { " + FORBIDDEN["opcode interpretation"] + " }"),
            encoding="utf-8", newline="\n")
        self.assertEqual(native_purity.evaluate(self.source), [])

    def test_comments_do_not_count(self):
        (self.source / "SmartAccount.cs").write_text(
            CLEAN + "// Retired: OpCode, SmartAccountEnvelope, BudgetDatoshi, ScriptBuilder; see https://example.invalid/a\n",
            encoding="utf-8", newline="\n")
        self.assertEqual(native_purity.evaluate(self.source), [])

    def test_a_missing_or_empty_source_never_passes(self):
        shutil.rmtree(self.source)
        status, _, err = self.run_gate()
        self.assertEqual((status, "native source directory not found" in err), (1, True))
        self.source.mkdir()
        status, _, err = self.run_gate()
        self.assertEqual((status, "no .cs file to scan" in err), (1, True))

    def test_the_repository_source_passes(self):
        self.assertEqual(native_purity.evaluate(REPOSITORY), [])

    def test_a_new_forbidden_line_outside_every_exception_fails(self):
        protocol = self.copy_of_repository()
        lines = protocol.read_text(encoding="utf-8").split("\n")
        lines.insert(300, "        private static OpCode extra;")
        protocol.write_text("\n".join(lines), encoding="utf-8", newline="")
        problems = native_purity.evaluate(self.source)
        self.assertEqual(sum("[opcode interpretation]" in p for p in problems), 1)
        self.assertIn("SmartAccountProtocol.cs:301: [opcode interpretation]", problems[0])

    def test_a_rule_an_exception_does_not_name_still_fails_inside_it(self):
        protocol = self.copy_of_repository()
        lines = protocol.read_text(encoding="utf-8").split("\n")
        lines.insert(97, "            long budget = BudgetDatoshi;")
        protocol.write_text("\n".join(lines), encoding="utf-8", newline="")
        problems = native_purity.evaluate(self.source)
        self.assertEqual(sum("[self-built gas budget]" in p for p in problems), 1)
        self.assertIn("SmartAccountProtocol.cs:98: [self-built gas budget]", problems[0])

    def test_a_drifted_exception_asks_for_review(self):
        protocol = self.copy_of_repository()
        original = protocol.read_text(encoding="utf-8")
        mutations = {
            "anchor rewritten": original.replace(
                "        private static Array DecodeOperationLiteral(ReadOnlyMemory<byte> literal)",
                "        private static Array DecodeOperationLiteralBytes(ReadOnlyMemory<byte> literal)"),
            "code shifted down": original.replace(
                "        internal static UInt160 GetAccountAddress(UInt160 accountId) =>",
                "        // one more line\n        internal static UInt160 GetAccountAddress(UInt160 accountId) =>"),
            "opcode cleaned up": original.replace("[(byte)OpCode.PUSHDATA1, (byte)UInt160.Length];",
                                                 "[(byte)0x0c, (byte)UInt160.Length];"),
            "method removed": original.replace("private static Array DecodeOperationLiteral(", "private static Array Renamed(")
                               .replace("DecodeOperationLiteral(literal)", "Renamed(literal)"),
        }
        for name, text in mutations.items():
            with self.subTest(mutation=name):
                self.assertNotEqual(text, original)
                protocol.write_text(text, encoding="utf-8", newline="")
                problems = native_purity.evaluate(self.source)
                self.assertTrue(any(p.startswith(REVIEW) for p in problems), problems)

    def test_the_call_tail_exception_covers_its_function_and_nothing_else(self):
        """The platform ScriptBuilder is accepted inside CreateCallTail only."""
        tail = next(e for e in native_purity.EXCEPTIONS if "CreateCallTail(" in e.anchor[0])
        without = tuple(e for e in native_purity.EXCEPTIONS if e is not tail)
        protocol = self.copy_of_repository()
        # Without the exception the gate refuses every line of the call it accepts.
        refused = re.findall(r"SmartAccountProtocol\.cs:(\d+): \[([^\]]+)\]",
                             "\n".join(native_purity.evaluate(self.source, without)))
        self.assertTrue(all(tail.first <= int(number) <= tail.last for number, _ in refused), refused)
        self.assertEqual(sorted(rule for _, rule in refused), [
            "opcode interpretation", "runtime script construction",
            "runtime script construction", "runtime script construction"])
        lines = protocol.read_text(encoding="utf-8").split("\n")
        first = lines.index(tail.anchor[0])
        last = first + tail.last - tail.first
        # The range is the method alone: its summary comment sits on the line above it.
        self.assertEqual((first + 1, lines[first + 1], lines[last]), (tail.first, "        {", "        }"))
        self.assertTrue(lines[first - 1].lstrip().startswith("///"), lines[first - 1])
        removed = lines[:first + 2] + ["            return FixedTails[argumentCount];"] * 4 + lines[last:]
        mutations = {
            # (the source after the mutation, the problem the gate must report, whether it is a review)
            "anchor rewritten": ("\n".join(lines).replace("CreateCallTail(", "BuildCallTail("),
                                 f"SmartAccountProtocol.cs:{tail.first} no longer reads", True),
            "code shifted down": ("\n".join(lines[:first] + ["        // one more line"] + lines[first:]),
                                  f"SmartAccountProtocol.cs:{tail.first} no longer reads", True),
            "emitter removed": ("\n".join(removed),
                                f"SmartAccountProtocol.cs:{tail.first}-{tail.last} carries no"
                                " runtime script construction/opcode interpretation any more", True),
            "unnamed rule inside": ("\n".join(lines[:last - 1] + ["            long budget = BudgetDatoshi;"] + lines[last:]),
                                    f"SmartAccountProtocol.cs:{tail.last - 1}: [self-built gas budget]", False),
            "named rule just outside": ("\n".join(lines[:first - 1] + ["        private static readonly ScriptBuilder extra;"] + lines[first:]),
                                        f"SmartAccountProtocol.cs:{tail.first - 1}: [runtime script construction]", False),
        }
        for name, (text, expected, review) in mutations.items():
            with self.subTest(mutation=name):
                self.assertNotEqual(text, "\n".join(lines))
                protocol.write_text(text, encoding="utf-8", newline="")
                problems = native_purity.evaluate(self.source)
                reviewed = [p for p in problems if p.startswith(REVIEW)]
                self.assertEqual(bool(reviewed), review, problems)
                self.assertTrue(any(expected in p for p in (reviewed or problems)), (expected, problems))

    def test_every_exception_is_tight_against_the_repository_source(self):
        """Each range is one member that names exactly the rules its own lines hit."""
        lines = (REPOSITORY / "SmartAccountProtocol.cs").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(native_purity.EXCEPTIONS), 6)
        for exception in native_purity.EXCEPTIONS:
            with self.subTest(anchor=exception.anchor[0].strip()):
                first, last = exception.first - 1, exception.last - 1
                self.assertEqual(lines[first:first + len(exception.anchor)], list(exception.anchor))
                self.assertTrue(lines[last].strip(), "the range ends on a blank line")
                self.assertEqual({name for _, name, _, _ in native_purity.scan(lines[first:last + 1])},
                                 set(exception.rules))

    def test_the_command_line_reports_every_file_line_and_rule(self):
        (self.source / "SmartAccount.cs").write_text(CLEAN.replace(
            "    int Count => 1;", "    void Body() { " + FORBIDDEN["retired bounded call"] + " }"),
            encoding="utf-8", newline="\n")
        status, out, err = self.run_gate()
        self.assertEqual((status, out), (1, ""))
        self.assertTrue(err.startswith("native purity: FAIL\n"), err)
        self.assertIn("[retired bounded call]", err)


if __name__ == "__main__":
    unittest.main()
