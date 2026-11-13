#!/usr/bin/env python3
"""Regenerate the neo-native-core SmartAccount copies from the AA true source.

`implementations/native/core/SmartAccount/` in neo-os-aa is the only editable
home of the SmartAccount native contract. The neo-native-core checkout needs
its own copies of those ten files to build the node standalone, so it carries
generated ones: this script rewrites them, byte-deterministically, from the
true source (each copy is headed with a GENERATED marker).

Usage:
    python scripts/sync_native_smartaccount.py            # regenerate in place
    python scripts/sync_native_smartaccount.py --check    # exit 1 on drift

The core checkout defaults to the sibling `../neo-native-core` directory and
can be pointed elsewhere with `--core PATH` (the CI gate uses that to target
the SHA-pinned checkout).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# The ten contract files that have generated copies in the core checkout.
SYNCED_FILES = [
    "SmartAccount.cs",
    "SmartAccount.Execution.cs",
    "SmartAccount.Keys.cs",
    "SmartAccount.Modules.cs",
    "SmartAccountCanonicalJson.cs",
    "SmartAccountEnvelope.cs",
    "SmartAccountInvocationContext.cs",
    "SmartAccountModulePolicy.cs",
    "SmartAccountProtocol.cs",
    "SmartAccountState.cs",
]

# Header of the generated copies in neo-native-core (exactly one occurrence).
GENERATED_MARKER = (
    "// GENERATED from neo-os-aa implementations/native/core/SmartAccount/ "
    "\u2014 do not edit here; regenerate via scripts/sync_native_smartaccount.py\n"
)

# Header block the true source carries in place of the marker (exactly once).
TRUE_SOURCE_BLOCK = (
    "// TRUE SOURCE: this is the only editable copy of this SmartAccount native\n"
    "// contract file. The neo-native-core checkout carries a generated copy \u2014\n"
    "// regenerate it via scripts/sync_native_smartaccount.py.\n"
)

AA_TRUE_SOURCE_DIR = Path("implementations/native/core/SmartAccount")
NC_NATIVE_DIR = Path("src/Neo/SmartContract/Native")


def normalize(text: str) -> str:
    """Canonical form of a file's text: UTF-8 (BOM stripped), LF endings."""
    return text.replace("\r\n", "\n")


def read_text(path: Path) -> str:
    return normalize(path.read_text(encoding="utf-8-sig"))


def generate_nc_content(aa_text: str) -> str:
    """Derive the generated copy's content from the true source's content."""
    if aa_text.count(TRUE_SOURCE_BLOCK) != 1:
        raise ValueError(
            "true source must carry exactly one TRUE SOURCE header block "
            f"(found {aa_text.count(TRUE_SOURCE_BLOCK)})"
        )
    if GENERATED_MARKER in aa_text:
        raise ValueError("true source must not contain the GENERATED marker")
    return aa_text.replace(TRUE_SOURCE_BLOCK, GENERATED_MARKER, 1)


def core_synced_set(nc_native_dir: Path) -> set[str]:
    """The SmartAccount contract files the core checkout actually carries."""
    return {
        p.name
        for p in nc_native_dir.glob("SmartAccount*.cs")
        if p.name != "NativeContract.cs"
    }


def sync(aa_root: Path, core_root: Path) -> list[str]:
    """Regenerate the core copies; returns a list of problems (empty = ok)."""
    problems: list[str] = []
    aa_dir = aa_root / AA_TRUE_SOURCE_DIR
    nc_dir = core_root / NC_NATIVE_DIR

    # Missing copies are simply generated below; only unmanaged extras fail.
    for name in sorted(core_synced_set(nc_dir) - set(SYNCED_FILES)):
        problems.append(f"unexpected SmartAccount copy in core (not managed): {NC_NATIVE_DIR / name}")

    for name in SYNCED_FILES:
        try:
            content = generate_nc_content(read_text(aa_dir / name))
        except FileNotFoundError:
            problems.append(f"missing true source file: {AA_TRUE_SOURCE_DIR / name}")
            continue
        except ValueError as exc:
            problems.append(f"{AA_TRUE_SOURCE_DIR / name}: {exc}")
            continue
        (nc_dir / name).write_bytes(content.encode("utf-8"))
    return problems


def check(aa_root: Path, core_root: Path) -> list[str]:
    """Diff the core copies against a fresh regeneration; empty = in sync."""
    problems: list[str] = []
    aa_dir = aa_root / AA_TRUE_SOURCE_DIR
    nc_dir = core_root / NC_NATIVE_DIR

    actual = core_synced_set(nc_dir)
    expected = set(SYNCED_FILES)
    for name in sorted(expected - actual):
        problems.append(f"missing generated copy in core: {NC_NATIVE_DIR / name}")
    for name in sorted(actual - expected):
        problems.append(f"unexpected SmartAccount copy in core (not managed): {NC_NATIVE_DIR / name}")

    for name in SYNCED_FILES:
        aa_path = aa_dir / name
        nc_path = nc_dir / name
        if not aa_path.is_file():
            problems.append(f"missing true source file: {AA_TRUE_SOURCE_DIR / name}")
            continue
        if not nc_path.is_file():
            continue  # already reported by the set check above
        try:
            expected_nc = generate_nc_content(read_text(aa_path))
        except ValueError as exc:
            problems.append(f"{AA_TRUE_SOURCE_DIR / name}: {exc}")
            continue
        if read_text(nc_path) != expected_nc:
            problems.append(f"drift between true source and core copy: {name}")

    # A copy must carry its marker exactly once.
    for name in SYNCED_FILES:
        nc_path = nc_dir / name
        if nc_path.is_file():
            occurrences = read_text(nc_path).count(GENERATED_MARKER.rstrip("\n"))
            if occurrences != 1:
                problems.append(f"{NC_NATIVE_DIR / name}: GENERATED marker occurs {occurrences} times")
    return problems


def default_core_root(aa_root: Path) -> Path:
    """The core checkout lives next to the AA checkout by default."""
    return aa_root.parent / "neo-native-core"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--source",
        metavar="PATH",
        default=None,
        help="neo-os-aa checkout (defaults to the one this script lives in)",
    )
    parser.add_argument(
        "--core",
        metavar="PATH",
        default=None,
        help="neo-native-core checkout (defaults to the sibling ../neo-native-core)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the copies are regenerated (exit 1 on drift, no writes)",
    )
    args = parser.parse_args(argv)

    aa_root = Path(args.source).resolve() if args.source else Path(__file__).resolve().parent.parent
    core_root = Path(args.core).resolve() if args.core else default_core_root(aa_root)

    if not (core_root / NC_NATIVE_DIR).is_dir():
        print(f"core checkout not found at {core_root}", file=sys.stderr)
        return 1

    if args.check:
        problems = check(aa_root, core_root)
    else:
        problems = sync(aa_root, core_root)

    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        mode = "check failed" if args.check else "sync failed"
        print(f"smartaccount sync {mode}: {len(problems)} problem(s)", file=sys.stderr)
        return 1

    print(f"smartaccount sync {'in sync' if args.check else 'regenerated'}: "
          f"{len(SYNCED_FILES)} copies under {core_root / NC_NATIVE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
