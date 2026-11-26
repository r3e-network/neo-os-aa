#!/usr/bin/env python3
"""Core-tree pin gate: the Neo fork behind SmartAccount stays a small, reviewed diff.

The core checkout (``--core``, default: the sibling ``../neo-native-core``) is a
fork of upstream Neo. This gate compares it with the upstream commit
``UPSTREAM_BASE`` and requires three things:

* Every path that differs from that commit, tracked or untracked, matches an
  entry of ``ALLOWED``. Anything else means unrelated upstream code was touched.
* Every ``PRISTINE`` file exists and is byte-identical to upstream: the VM pieces
  a native contract must not bend are never allowed to drift, allowlist or not.
* Every ``ALLOWED`` entry still matches a difference. An entry whose file was
  reverted is stale and fails too, so the allowlist only shrinks deliberately.

An entry without ``*`` is an exact repository path; with ``*`` it is a glob.
Read-only: the gate runs ``git diff``, ``git ls-files`` and ``git show`` and
writes nothing. Byte comparisons ignore CRLF versus LF checkout settings only.
"""

import argparse
import fnmatch
from pathlib import Path
import subprocess
import sys

#: Upstream neo-project/neo commit the fork is measured against:
#: ".gitignore: ignore .lscache files (#4761)".
UPSTREAM_BASE = "99618f483a7e8bf783ad50af8a049752abd5ce4e"

#: VM files a native contract depends on but must never change.
PRISTINE = (
    "src/Neo/SmartContract/ApplicationEngine.Contract.cs",
    "src/Neo/SmartContract/ExecutionContextState.cs",
)

#: (why the difference exists, paths that may differ from upstream).
ALLOWED = (
    ("hardfork activation wiring of the opt-in HF_SmartAccountV1 profile", (
        "src/Neo/Hardfork.cs",
        "src/Neo/ProtocolSettings.cs",
        "src/Neo/SmartContract/Native/NativeContract.cs",
        "src/Neo/SmartContract/Native/ContractEventAttribute.cs",
    )),
    ("engine entry points: native CPU fee, opt-in hardfork height, witness prelude, "
     "dynamic native callback dispatch", (
        "src/Neo/SmartContract/ApplicationEngine.cs",
        "src/Neo/SmartContract/ApplicationEngine.NativeCalls.cs",
        "src/Neo/SmartContract/ApplicationEngine.Runtime.cs",
    )),
    ("SmartAccount native contract; the core carries the generated copies of "
     "contracts/native/SmartAccount (scripts/native_purity.py, sync_native_smartaccount.py)", (
        "src/Neo/SmartContract/Native/SmartAccount.cs",
        "src/Neo/SmartContract/Native/SmartAccount.Execution.cs",
        "src/Neo/SmartContract/Native/SmartAccount.Modules.cs",
        "src/Neo/SmartContract/Native/SmartAccountInvocationContext.cs",
        "src/Neo/SmartContract/Native/SmartAccountModulePolicy.cs",
        "src/Neo/SmartContract/Native/SmartAccountModuleProtocol.cs",
        "src/Neo/SmartContract/Native/SmartAccountProtocol.cs",
        "src/Neo/SmartContract/Native/SmartAccountRecords.cs",
    )),
    ("wallet: quote and execute the proxy verification script as a witness", (
        "src/Neo/Wallets/Helper.cs",
        "src/Neo/Wallets/Wallet.cs",
    )),
    ("core unit tests and fixtures of the above", (
        "tests/Neo.UnitTests/Neo.UnitTests.csproj",
        "tests/Neo.UnitTests/module-profile-vectors.json",
        "tests/Neo.UnitTests/native-smartaccount.manifest.json",
        "tests/Neo.UnitTests/Wallets/UT_Helper.SmartAccount.cs",
        "tests/Neo.UnitTests/Wallets/UT_Wallet.cs",
        "tests/Neo.UnitTests/SmartContract/UT_ApplicationEngine_NativeRawCall.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_NativeContract.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccount.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountAuthorization.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountEnvelope.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountFixtures.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountGovernance.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountHookBracket.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountInvocationContext.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountKernel.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountProtocol.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountRecordSchema.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountRecords.cs",
        "tests/Neo.UnitTests/SmartContract/Native/UT_SmartAccountSignerSet.cs",
        "tests/Neo.UnitTests/SmartContract/Native/SmartAccountTestSupport.cs",
        "tests/Neo.UnitTests/SmartContract/Native/TestFile/generate-smartaccount-v4-vectors.py",
        "tests/Neo.UnitTests/SmartContract/Native/TestFile/smartaccount-v4-vectors.json",
        "tests/fixtures/sa-module-protocol/*",
    )),
    ("SmartAccount design notes and an orphan test project; not an input of any build", (
        "docs/smartaccount-*.md",
        "docs/reports/smartaccount-source-runtime-tests.csproj",
    )),
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git(core, *args):
    """One read-only git query in the core checkout, or a ValueError naming it."""
    completed = subprocess.run(["git", "-C", str(core), *args], capture_output=True)
    require(completed.returncode == 0,
            f"git {' '.join(args)} failed in {core}:\n{completed.stderr.decode('utf-8', 'replace').strip()}")
    return completed.stdout


def changed_paths(core, base):
    """{path: status} of every tracked and untracked difference from ``base``."""
    git(core, "rev-parse", "--verify", "--quiet", base + "^{commit}")
    tracked = git(core, "diff", "--name-status", "--no-renames", "-z", base)
    fields = tracked.decode("utf-8").split("\0")
    # -z layout: status, path, (old path of a copy; none here because renames are off), ...
    changes = {fields[i + 1]: fields[i] for i in range(0, len(fields) - 1, 2)}
    untracked = git(core, "ls-files", "--others", "--exclude-standard", "-z")
    for name in untracked.decode("utf-8").split("\0"):
        if name:
            changes[name] = "?"
    return dict(sorted(changes.items()))


def pristine_drift(core, base):
    """PRISTINE files that are missing or differ from upstream."""
    drift = []
    for name in PRISTINE:
        path = Path(core) / name
        if not path.is_file():
            drift.append(f"{name}: missing from the core checkout")
            continue
        upstream = git(core, "show", f"{base}:{name}")
        if path.read_bytes().replace(b"\r\n", b"\n") != upstream.replace(b"\r\n", b"\n"):
            drift.append(f"{name}: differs from upstream {base[:8]}")
    return drift


def matches(entry, path):
    return fnmatch.fnmatchcase(path, entry) if "*" in entry else path == entry


def evaluate(core, base=UPSTREAM_BASE, allowed=ALLOWED, pristine=PRISTINE):
    """(changes, problems); ``problems`` is empty when the core tree is pinned."""
    changes = changed_paths(core, base)
    entries = [entry for _, paths in allowed for entry in paths]
    problems = []
    outside = [f"  {status} {path}" for path, status in changes.items()
               if not any(matches(entry, path) for entry in entries)]
    if outside:
        problems.append(f"{len(outside)} difference(s) outside the allowlist:\n" + "\n".join(outside))
    drift = pristine_drift(core, base) if pristine is not None else []
    if drift:
        problems.append("VM files that must stay byte-identical to upstream:\n  " + "\n  ".join(drift))
    stale = [entry for entry in entries if not any(matches(entry, path) for path in changes)]
    if stale:
        problems.append("stale allowlist entries (no difference left; remove them):\n  " + "\n  ".join(stale))
    return changes, problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--core", type=Path, default=Path(__file__).resolve().parents[2] / "neo-native-core",
                        help="core checkout (default: the sibling ../neo-native-core)")
    args = parser.parse_args(argv)
    try:
        changes, problems = evaluate(args.core.resolve())
    except ValueError as error:
        problems, changes = [str(error)], {}
    if problems:
        print("native core pin: FAIL", file=sys.stderr)
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"native core pin: PASS - {len(changes)} difference(s) from upstream {UPSTREAM_BASE[:8]} in "
          f"{args.core.resolve().as_posix()} all inside the allowlist; {len(PRISTINE)} VM files"
          " byte-identical to upstream")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
