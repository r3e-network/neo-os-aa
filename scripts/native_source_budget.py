#!/usr/bin/env python3
"""Read-only SmartAccount native source budget and module-ownership gate.

Metric (exactly one definition, shared by the gate and its tests): the number of
physical lines returned by ``str.splitlines`` for every ``*.cs`` file directly
inside ``contracts/native/SmartAccount``, excluding the shared ``NativeContract.cs``.

``NativeContract.cs`` is the Neo N3 NEP-17 native base that the stand-alone
overlay build keeps beside the contract sources. It carries no SmartAccount
behaviour, so counting it would make the budget a function of the Neo upstream
revision instead of the SmartAccount surface.

Two independent gates, both additive and never rewriting sources:

* Budget: the SmartAccount-specific line count must stay at or below ``--budget``
  (default 4,373, the ceiling recorded in the v4.1 remediation plan).
* Ownership: module policy belongs to the user-space modules under
  ``contracts/modules`` and ``contracts/plugins``. The native core must not
  1. declare a storage prefix from the module-owned ``0x80..0xFF`` range,
  2. name a module-private contract method, or
  3. reference a module policy record, helper type or module-private constant.

Line count is one gate only. It never substitutes for the ABI, storage ownership
or responsibility-boundary gates.
"""

import argparse
import json
from pathlib import Path
import re
import sys


SCHEMA = "smartaccount-native-source-budget/v1"
BUDGET = 4373
#: Shared Neo N3 native base, not SmartAccount-specific code.
EXCLUDED_FILES = frozenset({"NativeContract.cs"})
#: The native core owns the reserved half of the storage key space. Installed
#: modules are ordinary contracts and own the user-space half, so a prefix
#: constant in this range is a module-policy dependency pulled back into native.
MODULE_PREFIX_FLOOR = 0x80
PREFIX_PATTERN = re.compile(r"\bconst\s+byte\s+(?P<name>\w*[Pp]refix\w*)\s*=\s*0x(?P<value>[0-9A-Fa-f]{1,2})\b")
#: A bare ``ModuleProtocol.`` is the module-side constant table. The lookbehind
#: keeps the native ``SmartAccountModuleProtocol.`` out of the rule.
MODULE_SCOPE_PATTERN = re.compile(r"(?<![A-Za-z0-9_])ModuleProtocol\.")
COMMENT_PATTERN = re.compile(r"(?<!:)//.*$")
MODULE_METHODS = (
    "proposeConfiguration",
    "confirmConfiguration",
    "cancelConfiguration",
    "getPendingConfiguration",
    "getPendingConfigurationIntentIds",
    "getLastCompletion",
    "beginRecovery",
    "cancelRecovery",
    "executeRecovery",
    "getRecoveryStatus",
    "getRecoveryPolicySnapshot",
    "getExecutedRecoveryNonce",
    "setHookOrder",
    "getHookOrder",
    "getHookSnapshot",
    "getThresholdPolicy",
    "getPolicySnapshot",
    "setAuthorizedCore",
    "revokeCredentials",
    "getCredentialGeneration",
)
MODULE_POLICY_TYPES = (
    "GovernanceIntent",
    "ThresholdPolicy",
    "RecoveryPolicy",
    "HookAuthority",
    "SigningPolicy",
    "PolicyExecutionProbe",
    "SocialRecoveryService",
    "ModuleSupport",
)
MODULE_CONSTANTS = (
    "SA_INTENT_",
    "SA_RECOVERY_",
    "SA_MODULE_LIMIT_THRESHOLD",
    "SA_MODULE_LIMIT_MEMBERS",
)
#: Matched case-insensitively: a native ``BeginRecovery`` wrapper is the same
#: policy leak as a literal ``beginRecovery``, and no native identifier may be
#: allowed to spell a module-private name in any casing.
MODULE_TOKENS = (("method", MODULE_METHODS), ("policy type", MODULE_POLICY_TYPES),
                 ("module-private constant", MODULE_CONSTANTS))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def source_files(source):
    """Every counted SmartAccount source, in stable order."""
    require(source.is_dir(), f"SmartAccount native source directory not found: {source}")
    files = sorted((path for path in source.rglob("*.cs") if path.name not in EXCLUDED_FILES),
                   key=lambda path: path.as_posix())
    require(files, f"No SmartAccount native sources found under {source}")
    return files


def measure(files):
    """Physical line count per file; the single metric definition."""
    return {path.name: len(path.read_text(encoding="utf-8").splitlines()) for path in files}


def code_lines(path):
    """Yield (line number, code without the trailing line comment)."""
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        yield number, COMMENT_PATTERN.sub("", line)


def ownership_violations(files):
    """Module policy that must stay in ``contracts/modules``, reported as file:line."""
    violations = []
    for path in files:
        for number, code in code_lines(path):
            prefix = PREFIX_PATTERN.search(code)
            if prefix is not None and int(prefix.group("value"), 16) >= MODULE_PREFIX_FLOOR:
                violations.append(f"{path.name}:{number}: storage prefix {prefix.group('name')}"
                                  f"=0x{int(prefix.group('value'), 16):02X} is module-owned"
                                  f" (native prefixes must stay below 0x{MODULE_PREFIX_FLOOR:02X})")
            if MODULE_SCOPE_PATTERN.search(code):
                violations.append(f"{path.name}:{number}: references the module-side ModuleProtocol"
                                  " constant table instead of SmartAccountModuleProtocol")
            lowered = code.lower()
            for kind, tokens in MODULE_TOKENS:
                for token in tokens:
                    if token.lower() in lowered:
                        violations.append(f"{path.name}:{number}: names the module-private {kind}"
                                          f" '{token}'")
    return violations


def evaluate(source, budget):
    require(isinstance(budget, int) and budget > 0, f"budget must be a positive integer, got {budget!r}")
    files = source_files(source)
    counts = measure(files)
    total = sum(counts.values())
    violations = ownership_violations(files)
    report = {
        "schema": SCHEMA,
        "status": "PASS",
        "metric": "physical lines of contracts/native/SmartAccount/*.cs excluding NativeContract.cs",
        "source": source.as_posix(),
        "budget": budget,
        "total": total,
        "headroom": budget - total,
        "files": counts,
        "violations": violations,
    }
    failures = []
    if total > budget:
        failures.append(f"SmartAccount-specific lines {total} exceed the {budget}-line budget by"
                        f" {total - budget}: {details(counts)}")
    if violations:
        failures.append(f"{len(violations)} module-ownership violation(s) in the native core:\n  "
                        + "\n  ".join(violations))
    if failures:
        report.update(status="FAIL", error="\n".join(failures))
    return report


def details(counts):
    return ", ".join(f"{name} {lines}" for name, lines in sorted(counts.items(), key=lambda item: -item[1]))


def main(argv=None):
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, default=root / "contracts/native/SmartAccount",
                        help="SmartAccount native source directory (default: contracts/native/SmartAccount)")
    parser.add_argument("--budget", type=int, default=BUDGET,
                        help=f"maximum SmartAccount-specific lines (default: {BUDGET})")
    parser.add_argument("--output", type=Path, help="write the JSON receipt here instead of stdout")
    args = parser.parse_args(argv)
    try:
        report = evaluate(args.source, args.budget)
    except (ValueError, OSError, UnicodeError) as error:
        report = {"schema": SCHEMA, "status": "FAIL", "source": args.source.as_posix(), "error": str(error)}
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        try:
            args.output.write_text(serialized, encoding="utf-8")
        except OSError as error:
            print(f"Cannot write the source-budget receipt: {error}", file=sys.stderr)
            return 1
    else:
        print(serialized, end="")
    if report["status"] != "PASS":
        print(report["error"], file=sys.stderr)
        return 1
    print(f"native source budget: {report['total']}/{report['budget']} SmartAccount-specific lines"
          f" ({report['headroom']} headroom), no module-ownership violations", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
