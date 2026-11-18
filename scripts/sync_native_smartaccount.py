#!/usr/bin/env python3
"""Regenerate the neo-native-core SmartAccount copies from the SA true source.

`contracts/native/SmartAccount/` in neo-os-sa is the only editable
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
import contextlib
import os
import sys
from pathlib import Path

# The eleven contract files that have generated copies in the core checkout.
SYNCED_FILES = [
    "SmartAccount.cs",
    "SmartAccount.Execution.cs",
    "SmartAccount.Keys.cs",
    "SmartAccount.Modules.cs",
    "SmartAccountCanonicalJson.cs",
    "SmartAccountEnvelope.cs",
    "SmartAccountInvocationContext.cs",
    "SmartAccountModulePolicy.cs",
    "SmartAccountModuleProtocol.cs",
    "SmartAccountProtocol.cs",
    "SmartAccountState.cs",
]

# Header of the generated copies in neo-native-core (exactly one occurrence).
GENERATED_MARKER = (
    "// GENERATED from neo-os-sa implementations/native/core/SmartAccount/ "
    "\u2014 do not edit here; regenerate via scripts/sync_native_smartaccount.py\n"
)

# Header block the true source carries in place of the marker (exactly once).
TRUE_SOURCE_BLOCK = (
    "// TRUE SOURCE: this is the only editable copy of this SmartAccount native\n"
    "// contract file. The neo-native-core checkout carries a generated copy \u2014\n"
    "// regenerate it via scripts/sync_native_smartaccount.py.\n"
)

SA_TRUE_SOURCE_DIR = Path("contracts/native/SmartAccount")
NC_NATIVE_DIR = Path("src/Neo/SmartContract/Native")

# Suffix of the staged files a regeneration swaps in; it keeps them out of the
# `SmartAccount*.cs` set the core build and core_synced_set() pick up.
STAGING_SUFFIX = ".sync-tmp"


def normalize(text: str) -> str:
    """Canonical form of a file's text: UTF-8 (BOM stripped), LF endings."""
    return text.replace("\r\n", "\n")


def read_text(path: Path) -> str:
    return normalize(path.read_text(encoding="utf-8-sig"))


def generate_nc_content(sa_text: str) -> str:
    """Derive the generated copy's content from the true source's content."""
    if sa_text.count(TRUE_SOURCE_BLOCK) != 1:
        raise ValueError(
            "true source must carry exactly one TRUE SOURCE header block "
            f"(found {sa_text.count(TRUE_SOURCE_BLOCK)})"
        )
    if GENERATED_MARKER in sa_text:
        raise ValueError("true source must not contain the GENERATED marker")
    return sa_text.replace(TRUE_SOURCE_BLOCK, GENERATED_MARKER, 1)


def core_synced_set(nc_native_dir: Path) -> set[str]:
    """The SmartAccount contract files the core checkout actually carries."""
    return {
        p.name
        for p in nc_native_dir.glob("SmartAccount*.cs")
        if p.name != "NativeContract.cs"
    }


def write_copies(nc_dir: Path, generated: dict[str, bytes]) -> None:
    """Stage every copy next to its target, then swap them all in.

    A failure while staging removes the staged files and leaves the existing
    copies untouched; each swap is an atomic rename.
    """
    staged: list[tuple[Path, Path]] = []
    try:
        for name, data in generated.items():
            tmp = nc_dir / (name + STAGING_SUFFIX)
            staged.append((tmp, nc_dir / name))
            tmp.write_bytes(data)
        for tmp, target in staged:
            os.replace(tmp, target)
    finally:
        for tmp, _ in staged:
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)


def sync(sa_root: Path, core_root: Path) -> list[str]:
    """Regenerate the core copies; returns a list of problems (empty = ok).

    All-or-nothing: every true source file is validated before the first
    write, so any problem leaves the core checkout exactly as it was.
    """
    problems: list[str] = []
    sa_dir = sa_root / SA_TRUE_SOURCE_DIR
    nc_dir = core_root / NC_NATIVE_DIR

    # Missing copies are simply generated below; only unmanaged extras fail.
    for name in sorted(core_synced_set(nc_dir) - set(SYNCED_FILES)):
        problems.append(f"unexpected SmartAccount copy in core (not managed): {NC_NATIVE_DIR / name}")

    generated: dict[str, bytes] = {}
    for name in SYNCED_FILES:
        try:
            content = generate_nc_content(read_text(sa_dir / name))
        except FileNotFoundError:
            problems.append(f"missing true source file: {SA_TRUE_SOURCE_DIR / name}")
            continue
        except ValueError as exc:
            problems.append(f"{SA_TRUE_SOURCE_DIR / name}: {exc}")
            continue
        generated[name] = content.encode("utf-8")

    if not problems:
        write_copies(nc_dir, generated)
    return problems


def check(sa_root: Path, core_root: Path) -> list[str]:
    """Diff the core copies against a fresh regeneration; empty = in sync."""
    problems: list[str] = []
    sa_dir = sa_root / SA_TRUE_SOURCE_DIR
    nc_dir = core_root / NC_NATIVE_DIR

    actual = core_synced_set(nc_dir)
    expected = set(SYNCED_FILES)
    for name in sorted(expected - actual):
        problems.append(f"missing generated copy in core: {NC_NATIVE_DIR / name}")
    for name in sorted(actual - expected):
        problems.append(f"unexpected SmartAccount copy in core (not managed): {NC_NATIVE_DIR / name}")

    for name in SYNCED_FILES:
        sa_path = sa_dir / name
        nc_path = nc_dir / name
        if not sa_path.is_file():
            problems.append(f"missing true source file: {SA_TRUE_SOURCE_DIR / name}")
            continue
        if not nc_path.is_file():
            continue  # already reported by the set check above
        try:
            expected_nc = generate_nc_content(read_text(sa_path))
        except ValueError as exc:
            problems.append(f"{SA_TRUE_SOURCE_DIR / name}: {exc}")
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


def default_core_root(sa_root: Path) -> Path:
    """The core checkout lives next to the SA checkout by default."""
    return sa_root.parent / "neo-native-core"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--source",
        metavar="PATH",
        default=None,
        help="neo-os-sa checkout (defaults to the one this script lives in)",
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

    sa_root = Path(args.source).resolve() if args.source else Path(__file__).resolve().parent.parent
    core_root = Path(args.core).resolve() if args.core else default_core_root(sa_root)

    if not (core_root / NC_NATIVE_DIR).is_dir():
        print(f"core checkout not found at {core_root}", file=sys.stderr)
        return 1

    if args.check:
        problems = check(sa_root, core_root)
    else:
        problems = sync(sa_root, core_root)

    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        summary = "smartaccount sync check failed" if args.check else "smartaccount sync failed, no copies written"
        print(f"{summary}: {len(problems)} problem(s)", file=sys.stderr)
        return 1

    print(f"smartaccount sync {'in sync' if args.check else 'regenerated'}: "
          f"{len(SYNCED_FILES)} copies under {core_root / NC_NATIVE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
