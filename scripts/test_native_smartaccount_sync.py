"""The neo-native-core SmartAccount copies are generated, not forked.

The SA checkout owns the true source in contracts/native/SmartAccount/
and scripts/sync_native_smartaccount.py regenerates the copies the core
needs to build the node standalone. These tests pin the sync contract itself
on synthetic trees: regeneration must be byte-deterministic and idempotent,
a failed regeneration must leave the core tree byte-for-byte untouched, and
--check must fail closed on drift, missing, extra, or unmarked copies.
"""
import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_native_smartaccount as sync_mod  # noqa: E402

SA_DIR = sync_mod.SA_TRUE_SOURCE_DIR
NC_DIR = sync_mod.NC_NATIVE_DIR
# Independent fixture anchors keep pre-fix runs focused on behavior, not missing symbols.
SA_RUNTIME = Path("contracts/native/Runtime/ApplicationEngine.Runtime.cs")
NC_RUNTIME = Path("src/Neo/SmartContract/ApplicationEngine.Runtime.cs")
RUNTIME_METHOD = "        protected internal bool CheckWitnessInternal(UInt160 hash)"
RUNTIME_ORDINARY_WITNESS = "            if (hash.Equals(CallingScriptHash)) return true;"


def build_tree(root: Path) -> tuple[Path, Path]:
    """Create a synthetic SA true-source tree and an (empty) core tree."""
    sa_root = root / "sa"
    core_root = root / "core"
    (sa_root / SA_DIR).mkdir(parents=True)
    (core_root / NC_DIR).mkdir(parents=True)
    # The core's own NativeContract.cs is a node-repo file, never a sync copy.
    (core_root / NC_DIR / "NativeContract.cs").write_text("// core native contract\n", encoding="utf-8")
    for name in sync_mod.SYNCED_FILES:
        text = (
            "// fixture header\n\n"
            + sync_mod.TRUE_SOURCE_BLOCK
            + f"\nclass {name.replace('.', '_')} {{ }}\n"
        )
        (sa_root / SA_DIR / name).write_text(text, encoding="utf-8")
    runtime = (
        "// runtime header\n" + RUNTIME_METHOD + "\n        {\n"
        "            if (context is { } accountContext)\n"
        "            return accountContext.IsWitnessAuthorized(this, hash);\n"
        + RUNTIME_ORDINARY_WITNESS + "\n            return false;\n        }\n"
    )
    (sa_root / SA_RUNTIME).parent.mkdir(parents=True)
    (sa_root / SA_RUNTIME).write_text(runtime, encoding="utf-8")
    (core_root / NC_RUNTIME).write_text(runtime, encoding="utf-8")
    return sa_root, core_root


def build_stale_core(root: Path) -> tuple[Path, Path]:
    """A synced tree whose true source then moved on.

    Every copy is stale and the first one is gone, so a write-mode sync has
    all managed files to write, one of them new.
    """
    sa_root, core_root = build_tree(root)
    sync_mod.sync(sa_root, core_root)
    (core_root / NC_DIR / sync_mod.SYNCED_FILES[0]).unlink()
    for name in sync_mod.SYNCED_FILES:
        source = sa_root / SA_DIR / name
        source.write_text(source.read_text(encoding="utf-8") + "// edited\n", encoding="utf-8")
    return sa_root, core_root


def snapshot(root: Path) -> dict[str, bytes]:
    """Every file under root, by relative path, with its exact bytes."""
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


class NativeSmartAccountSyncTests(unittest.TestCase):
    def test_sync_generates_all_copies_and_check_is_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_tree(Path(tmp))
            self.assertEqual([], sync_mod.sync(sa_root, core_root))
            for name in sync_mod.SYNCED_FILES:
                copy = core_root / NC_DIR / name
                self.assertTrue(copy.is_file(), copy)
                text = copy.read_text(encoding="utf-8")
                self.assertIn(sync_mod.GENERATED_MARKER.rstrip("\n"), text)
                self.assertNotIn("TRUE SOURCE", text)
                self.assertIn(f"class {name.replace('.', '_')}", text)
            self.assertEqual([], sync_mod.check(sa_root, core_root))

    def test_sync_is_idempotent_and_byte_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(sa_root, core_root)
            first = {name: (core_root / NC_DIR / name).read_bytes() for name in sync_mod.SYNCED_FILES}
            sync_mod.sync(sa_root, core_root)
            second = {name: (core_root / NC_DIR / name).read_bytes() for name in sync_mod.SYNCED_FILES}
            self.assertEqual(first, second)
            # The marker never stacks on regeneration.
            for name in sync_mod.SYNCED_FILES:
                self.assertEqual(1, (core_root / NC_DIR / name).read_text(encoding="utf-8")
                                 .count(sync_mod.GENERATED_MARKER.rstrip("\n")))

    def test_sync_writes_nothing_when_a_later_true_source_is_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_stale_core(Path(tmp))
            # Six valid files precede the broken one in SYNCED_FILES order.
            broken = sync_mod.SYNCED_FILES[-2]
            source = sa_root / SA_DIR / broken
            source.write_text(source.read_text(encoding="utf-8").replace("TRUE SOURCE", "EDITABLE"),
                              encoding="utf-8")
            before = snapshot(core_root)
            problems = sync_mod.sync(sa_root, core_root)
            self.assertEqual(1, len(problems), problems)
            self.assertIn(broken, problems[0])
            self.assertEqual(before, snapshot(core_root))
            # The copy that was missing beforehand must not have been created.
            self.assertFalse((core_root / NC_DIR / sync_mod.SYNCED_FILES[0]).exists())

    def test_sync_writes_nothing_when_a_later_true_source_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_stale_core(Path(tmp))
            missing = sync_mod.SYNCED_FILES[-1]
            (sa_root / SA_DIR / missing).unlink()
            before = snapshot(core_root)
            problems = sync_mod.sync(sa_root, core_root)
            self.assertEqual(1, len(problems), problems)
            self.assertIn("missing true source file", problems[0])
            self.assertIn(missing, problems[0])
            self.assertEqual(before, snapshot(core_root))

    def test_sync_writes_nothing_when_core_carries_an_unmanaged_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_stale_core(Path(tmp))
            (core_root / NC_DIR / "SmartAccountExtra.cs").write_text("// stray\n", encoding="utf-8")
            before = snapshot(core_root)
            problems = sync_mod.sync(sa_root, core_root)
            self.assertEqual(1, len(problems), problems)
            self.assertIn("SmartAccountExtra.cs", problems[0])
            self.assertEqual(before, snapshot(core_root))

    def test_sync_leaves_core_untouched_when_a_write_fails_midway(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_stale_core(Path(tmp))
            before = snapshot(core_root)
            real_write_bytes = Path.write_bytes
            calls = 0

            def flaky_write_bytes(path, data):
                nonlocal calls
                calls += 1
                if calls == 5:
                    raise OSError("simulated write failure")
                return real_write_bytes(path, data)

            with mock.patch.object(Path, "write_bytes", flaky_write_bytes):
                with self.assertRaises(OSError):
                    sync_mod.sync(sa_root, core_root)
            self.assertEqual(5, calls)
            self.assertEqual(before, snapshot(core_root))

    def test_check_detects_content_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(sa_root, core_root)
            drifted = core_root / NC_DIR / "SmartAccountRecords.cs"
            drifted.write_text(drifted.read_text(encoding="utf-8").replace("class", "struct"), encoding="utf-8")
            problems = sync_mod.check(sa_root, core_root)
            self.assertTrue(any("SmartAccountRecords.cs" in p for p in problems), problems)

    def test_check_detects_missing_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(sa_root, core_root)
            (core_root / NC_DIR / "SmartAccount.cs").unlink()
            problems = sync_mod.check(sa_root, core_root)
            self.assertTrue(any("missing generated copy" in p for p in problems), problems)

    def test_check_detects_unmanaged_extra_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(sa_root, core_root)
            (core_root / NC_DIR / "SmartAccountExtra.cs").write_text("// stray\n", encoding="utf-8")
            problems = sync_mod.check(sa_root, core_root)
            self.assertTrue(any("SmartAccountExtra.cs" in p for p in problems), problems)

    def test_check_detects_marker_stripped_from_a_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(sa_root, core_root)
            stripped = core_root / NC_DIR / "SmartAccountProtocol.cs"
            stripped.write_text(stripped.read_text(encoding="utf-8")
                                .replace(sync_mod.GENERATED_MARKER.rstrip("\n"), "// edited by hand"), encoding="utf-8")
            problems = sync_mod.check(sa_root, core_root)
            self.assertTrue(any("SmartAccountProtocol.cs" in p for p in problems), problems)

    def test_runtime_drift_is_checked_and_only_witness_prelude_is_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_tree(Path(tmp))
            self.assertEqual([], sync_mod.sync(sa_root, core_root))
            runtime = core_root / NC_RUNTIME
            text = runtime.read_text(encoding="utf-8")
            text = text.replace("// runtime header", "// user runtime changes")
            text = text.replace("            return false;", "            return LegacyWitness(hash);")
            text = text.replace("return accountContext.IsWitnessAuthorized(this, hash);", "return false;")
            runtime.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
            before = runtime.read_bytes()
            self.assertTrue(any("runtime witness prelude" in p for p in sync_mod.check(sa_root, core_root)))
            self.assertEqual([], sync_mod.sync(sa_root, core_root))
            expected = before.replace(b"            return false;\r\n",
                                      b"            return accountContext.IsWitnessAuthorized(this, hash);\r\n", 1)
            self.assertEqual(expected, runtime.read_bytes())
            self.assertEqual([], sync_mod.check(sa_root, core_root))
            self.assertEqual([], sync_mod.sync(sa_root, core_root))
            self.assertEqual(expected, runtime.read_bytes())

    def test_missing_or_ambiguous_runtime_anchors_prevent_all_writes(self):
        for malformed in ("// missing runtime", RUNTIME_METHOD + "\n" + RUNTIME_METHOD):
            with self.subTest(malformed=malformed), tempfile.TemporaryDirectory() as tmp:
                sa_root, core_root = build_stale_core(Path(tmp))
                (core_root / NC_RUNTIME).write_text(malformed, encoding="utf-8")
                before = snapshot(core_root)
                self.assertTrue(sync_mod.sync(sa_root, core_root))
                self.assertEqual(before, snapshot(core_root))
                self.assertTrue(sync_mod.check(sa_root, core_root))

    def test_malformed_runtime_opening_prevents_all_writes(self):
        for source in (True, False):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as tmp:
                sa_root, core_root = build_stale_core(Path(tmp))
                path = sa_root / SA_RUNTIME if source else core_root / NC_RUNTIME
                path.write_text(path.read_text(encoding="utf-8").replace("        {\n", "        // missing opening\n"),
                                encoding="utf-8")
                before = snapshot(core_root)
                self.assertTrue(sync_mod.sync(sa_root, core_root))
                self.assertEqual(before, snapshot(core_root))

    def test_missing_runtime_source_prevents_all_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_stale_core(Path(tmp))
            (sa_root / SA_RUNTIME).unlink()
            before = snapshot(core_root)
            self.assertTrue(sync_mod.sync(sa_root, core_root))
            self.assertEqual(before, snapshot(core_root))

    def test_true_source_without_marker_block_is_rejected(self):
        with self.assertRaises(ValueError):
            sync_mod.generate_nc_content("// no header block here\nclass X { }\n")

    def test_true_source_containing_generated_marker_is_rejected(self):
        with self.assertRaises(ValueError):
            sync_mod.generate_nc_content(sync_mod.GENERATED_MARKER + "class X { }\n")

    def test_cli_check_exit_code_reflects_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(sa_root, core_root)
            self.assertEqual(0, sync_mod.main(["--check", "--source", str(sa_root), "--core", str(core_root)]))
            drifted = core_root / NC_DIR / sync_mod.SYNCED_FILES[1]
            drifted.write_text("drift", encoding="utf-8")
            self.assertEqual(1, sync_mod.main(["--check", "--source", str(sa_root), "--core", str(core_root)]))
            self.assertEqual(0, sync_mod.main(["--source", str(sa_root), "--core", str(core_root)]))
            self.assertEqual(0, sync_mod.main(["--check", "--source", str(sa_root), "--core", str(core_root)]))

    def test_cli_failed_sync_exits_1_with_core_untouched_then_recovers(self):
        with tempfile.TemporaryDirectory() as tmp:
            sa_root, core_root = build_stale_core(Path(tmp))
            argv = ["--source", str(sa_root), "--core", str(core_root)]
            broken = sync_mod.SYNCED_FILES[-2]
            source = sa_root / SA_DIR / broken
            valid_text = source.read_text(encoding="utf-8")
            source.write_text(valid_text.replace("TRUE SOURCE", "EDITABLE"), encoding="utf-8")
            before = snapshot(core_root)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(1, sync_mod.main(argv))
            self.assertIn(broken, stderr.getvalue())
            self.assertEqual(before, snapshot(core_root))
            # Once the true source is repaired the same command regenerates everything.
            source.write_text(valid_text, encoding="utf-8")
            self.assertEqual(0, sync_mod.main(argv))
            self.assertEqual(0, sync_mod.main(["--check", *argv]))


if __name__ == "__main__":
    unittest.main()
