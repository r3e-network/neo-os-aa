"""scripts/native_core_pin.py: the core checkout stays a small, reviewed diff of upstream Neo.

python -m unittest discover -s scripts -p 'test_native_*.py'
"""
import contextlib
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import native_core_pin  # noqa: E402

GIT = shutil.which("git")
PRISTINE_ENGINE, PRISTINE_STATE = native_core_pin.PRISTINE
ENGINE = "src/Neo/SmartContract/ApplicationEngine.cs"
NETWORK = "src/Neo/Network/P2P.cs"
UPSTREAM = {
    PRISTINE_ENGINE: "class ApplicationEngine.Contract { int Version = 1; }\n",
    PRISTINE_STATE: "class ExecutionContextState { }\n",
    ENGINE: "class ApplicationEngine { }\n",
    NETWORK: "class P2P { }\n",
}
ALLOWED = (("engine entry points", (ENGINE, "tests/fixtures/*")),)


def git(directory, *args):
    completed = subprocess.run(
        [GIT, "-C", str(directory), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
         "-c", "core.autocrlf=false", *args], capture_output=True, text=True)
    if completed.returncode:
        raise AssertionError(f"git {' '.join(args)}: {completed.stderr}")
    return completed.stdout.strip()


def write(root, name, text):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


@unittest.skipIf(GIT is None, "git is not installed")
class NativeCorePinTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.upstream = Path(self.temp.name) / "upstream"
        self.core = Path(self.temp.name) / "core"
        for name, text in UPSTREAM.items():
            write(self.upstream, name, text)
        git(self.upstream, "init", "-q")
        git(self.upstream, "add", "-A")
        git(self.upstream, "commit", "-q", "-m", "upstream")
        self.base = git(self.upstream, "rev-parse", "HEAD")
        shutil.copytree(self.upstream, self.core)

    def evaluate(self, allowed=ALLOWED, pristine=native_core_pin.PRISTINE):
        return native_core_pin.evaluate(self.core, self.base, allowed, pristine)

    def add_fixture(self, name="tests/fixtures/vectors.json", text="{}\n"):
        (self.core / name).parent.mkdir(parents=True, exist_ok=True)
        write(self.core, name, text)

    def run_gate(self):
        """main() on the fixture, with its base commit and allowlist."""
        real_evaluate = native_core_pin.evaluate
        evaluate = lambda core, *_: real_evaluate(core, self.base, ALLOWED, native_core_pin.PRISTINE)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(native_core_pin, "evaluate", evaluate), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = native_core_pin.main(["--core", str(self.core)])
        return status, out.getvalue(), err.getvalue()

    def test_a_tree_that_only_touches_allowlisted_paths_passes(self):
        write(self.core, ENGINE, "class ApplicationEngine { void New() { } }\n")
        self.add_fixture()
        changes, problems = self.evaluate()
        self.assertEqual((problems, changes), ([], {ENGINE: "M", "tests/fixtures/vectors.json": "?"}))
        status, out, _ = self.run_gate()
        self.assertEqual((status, "native core pin: PASS - 2 difference(s)" in out), (0, True), out)

    def test_an_untouched_clone_makes_the_allowlist_stale(self):
        problems = self.evaluate()[1]
        self.assertEqual(problems, ["stale allowlist entries (no difference left; remove them):\n  "
                                   f"{ENGINE}\n  tests/fixtures/*"])

    def test_a_difference_outside_the_allowlist_fails_and_is_listed(self):
        write(self.core, NETWORK, "class P2P { void Changed() { } }\n")
        self.add_fixture("src/Neo/Other.cs", "class Other { }\n")
        self.add_fixture()
        write(self.core, ENGINE, "class ApplicationEngine { void New() { } }\n")
        write(self.core, "tests/Neo.UnitTests.csproj", "<Project />\n")
        problems = self.evaluate()[1]
        self.assertEqual(len(problems), 1, problems)
        for listed in ("3 difference(s) outside the allowlist", f"  M {NETWORK}", "  ? src/Neo/Other.cs",
                       "  ? tests/Neo.UnitTests.csproj"):
            self.assertIn(listed, problems[0])
        status, _, err = self.run_gate()
        self.assertEqual(status, 1)
        self.assertIn("native core pin: FAIL", err)

    def test_a_pristine_file_may_neither_drift_nor_disappear_even_if_allowlisted(self):
        write(self.core, ENGINE, "class ApplicationEngine { void New() { } }\n")
        self.add_fixture()
        write(self.core, PRISTINE_ENGINE, UPSTREAM[PRISTINE_ENGINE] + "// one changed line\n")
        allowlisting_it = ((ALLOWED[0][0], (ENGINE, PRISTINE_ENGINE, "tests/fixtures/*")),)
        drift = "VM files that must stay byte-identical to upstream:\n  " + f"{PRISTINE_ENGINE}: differs from upstream"
        for allowed in (ALLOWED, allowlisting_it):
            problems = self.evaluate(allowed)[1]
            self.assertTrue(any(p.startswith(drift) for p in problems), problems)
        (self.core / PRISTINE_STATE).unlink()
        problems = self.evaluate(allowlisting_it)[1]
        self.assertTrue(any(f"{PRISTINE_STATE}: missing from the core checkout" in p for p in problems), problems)
        self.assertFalse(any("stale" in p for p in problems), problems)

    def test_a_crlf_checkout_of_a_pristine_file_still_passes(self):
        write(self.core, ENGINE, "class ApplicationEngine { void New() { } }\n")
        self.add_fixture()
        write(self.core, PRISTINE_ENGINE, UPSTREAM[PRISTINE_ENGINE].replace("\n", "\r\n"))
        self.assertEqual(self.evaluate()[1], [])

    def test_a_stale_allowlist_entry_fails(self):
        write(self.core, ENGINE, "class ApplicationEngine { void New() { } }\n")
        allowed = (("engine entry points", (ENGINE, "src/Neo/Gone.cs")),)
        problems = self.evaluate(allowed)[1]
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("stale allowlist entries (no difference left; remove them):\n  src/Neo/Gone.cs", problems[0])

    def test_an_unknown_base_commit_fails_instead_of_comparing_nothing(self):
        with self.assertRaisesRegex(ValueError, "rev-parse"):
            native_core_pin.evaluate(self.core, "0" * 40)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(native_core_pin.main(["--core", str(self.upstream)]), 1)
        self.assertIn("native core pin: FAIL", err.getvalue())


class RealAllowlistTests(unittest.TestCase):
    """The shipped allowlist and pristine list keep their documented shape."""

    def test_every_entry_is_a_relative_repository_path_with_a_reason(self):
        for why, paths in native_core_pin.ALLOWED:
            self.assertTrue(why.strip() and paths)
            for path in paths:
                self.assertTrue(path.startswith(("src/", "tests/", "docs/")), path)
                self.assertNotIn(path, (" ", "..", "\\"))
        self.assertEqual(len({path for _, paths in native_core_pin.ALLOWED for path in paths}),
                         sum(len(paths) for _, paths in native_core_pin.ALLOWED))

    def test_the_pristine_files_are_never_allowlisted(self):
        allowlisted = {path for _, paths in native_core_pin.ALLOWED for path in paths}
        for name in native_core_pin.PRISTINE:
            self.assertFalse(any(native_core_pin.matches(entry, name) for entry in allowlisted), name)
        self.assertEqual(len(native_core_pin.PRISTINE), 2)

    def test_the_upstream_base_is_a_full_commit_hash(self):
        self.assertRegex(native_core_pin.UPSTREAM_BASE, r"^[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
