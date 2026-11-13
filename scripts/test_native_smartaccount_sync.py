"""The neo-native-core SmartAccount copies are generated, not forked.

The AA checkout owns the true source in implementations/native/core/SmartAccount/
and scripts/sync_native_smartaccount.py regenerates the ten copies the core
needs to build the node standalone. These tests pin the sync contract itself
on synthetic trees: regeneration must be byte-deterministic and idempotent,
and --check must fail closed on drift, missing, extra, or unmarked copies.
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_native_smartaccount as sync_mod  # noqa: E402

AA_DIR = sync_mod.AA_TRUE_SOURCE_DIR
NC_DIR = sync_mod.NC_NATIVE_DIR


def build_tree(root: Path) -> tuple[Path, Path]:
    """Create a synthetic AA true-source tree and an (empty) core tree."""
    aa_root = root / "aa"
    core_root = root / "core"
    (aa_root / AA_DIR).mkdir(parents=True)
    (core_root / NC_DIR).mkdir(parents=True)
    # The core's own NativeContract.cs is a node-repo file, never a sync copy.
    (core_root / NC_DIR / "NativeContract.cs").write_text("// core native contract\n", encoding="utf-8")
    for name in sync_mod.SYNCED_FILES:
        text = (
            "// fixture header\n\n"
            + sync_mod.TRUE_SOURCE_BLOCK
            + f"\nclass {name.replace('.', '_')} {{ }}\n"
        )
        (aa_root / AA_DIR / name).write_text(text, encoding="utf-8")
    return aa_root, core_root


class NativeSmartAccountSyncTests(unittest.TestCase):
    def test_sync_generates_all_copies_and_check_is_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            aa_root, core_root = build_tree(Path(tmp))
            self.assertEqual([], sync_mod.sync(aa_root, core_root))
            for name in sync_mod.SYNCED_FILES:
                copy = core_root / NC_DIR / name
                self.assertTrue(copy.is_file(), copy)
                text = copy.read_text(encoding="utf-8")
                self.assertIn(sync_mod.GENERATED_MARKER.rstrip("\n"), text)
                self.assertNotIn("TRUE SOURCE", text)
                self.assertIn(f"class {name.replace('.', '_')}", text)
            self.assertEqual([], sync_mod.check(aa_root, core_root))

    def test_sync_is_idempotent_and_byte_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            aa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(aa_root, core_root)
            first = {name: (core_root / NC_DIR / name).read_bytes() for name in sync_mod.SYNCED_FILES}
            sync_mod.sync(aa_root, core_root)
            second = {name: (core_root / NC_DIR / name).read_bytes() for name in sync_mod.SYNCED_FILES}
            self.assertEqual(first, second)
            # The marker never stacks on regeneration.
            for name in sync_mod.SYNCED_FILES:
                self.assertEqual(1, (core_root / NC_DIR / name).read_text(encoding="utf-8")
                                 .count(sync_mod.GENERATED_MARKER.rstrip("\n")))

    def test_check_detects_content_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            aa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(aa_root, core_root)
            drifted = core_root / NC_DIR / "SmartAccountState.cs"
            drifted.write_text(drifted.read_text(encoding="utf-8").replace("class", "struct"), encoding="utf-8")
            problems = sync_mod.check(aa_root, core_root)
            self.assertTrue(any("SmartAccountState.cs" in p for p in problems), problems)

    def test_check_detects_missing_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            aa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(aa_root, core_root)
            (core_root / NC_DIR / "SmartAccount.cs").unlink()
            problems = sync_mod.check(aa_root, core_root)
            self.assertTrue(any("missing generated copy" in p for p in problems), problems)

    def test_check_detects_unmanaged_extra_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            aa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(aa_root, core_root)
            (core_root / NC_DIR / "SmartAccountExtra.cs").write_text("// stray\n", encoding="utf-8")
            problems = sync_mod.check(aa_root, core_root)
            self.assertTrue(any("SmartAccountExtra.cs" in p for p in problems), problems)

    def test_check_detects_marker_stripped_from_a_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            aa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(aa_root, core_root)
            stripped = core_root / NC_DIR / "SmartAccountProtocol.cs"
            stripped.write_text(stripped.read_text(encoding="utf-8")
                                .replace(sync_mod.GENERATED_MARKER.rstrip("\n"), "// edited by hand"), encoding="utf-8")
            problems = sync_mod.check(aa_root, core_root)
            self.assertTrue(any("SmartAccountProtocol.cs" in p for p in problems), problems)

    def test_true_source_without_marker_block_is_rejected(self):
        with self.assertRaises(ValueError):
            sync_mod.generate_nc_content("// no header block here\nclass X { }\n")

    def test_true_source_containing_generated_marker_is_rejected(self):
        with self.assertRaises(ValueError):
            sync_mod.generate_nc_content(sync_mod.GENERATED_MARKER + "class X { }\n")

    def test_cli_check_exit_code_reflects_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            aa_root, core_root = build_tree(Path(tmp))
            sync_mod.sync(aa_root, core_root)
            self.assertEqual(0, sync_mod.main(["--check", "--source", str(aa_root), "--core", str(core_root)]))
            drifted = core_root / NC_DIR / "SmartAccount.Keys.cs"
            drifted.write_text("drift", encoding="utf-8")
            self.assertEqual(1, sync_mod.main(["--check", "--source", str(aa_root), "--core", str(core_root)]))
            self.assertEqual(0, sync_mod.main(["--source", str(aa_root), "--core", str(core_root)]))
            self.assertEqual(0, sync_mod.main(["--check", "--source", str(aa_root), "--core", str(core_root)]))


if __name__ == "__main__":
    unittest.main()
