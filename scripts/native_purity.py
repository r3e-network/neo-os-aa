#!/usr/bin/env python3
"""Native purity gate: contracts/native/SmartAccount stays a native contract, not an SDK.

Every ``.cs`` file of the native source (``--source``) is scanned line by line,
with ``//`` comments removed, and each line that matches a pattern of ``RULES``
fails the gate. The rules refuse an embedded or script-running engine, an opcode
interpreter, the retired Envelope codec and bounded call, a self-built gas budget
and runtime script construction; each one says why it is forbidden.

``NativeContract.cs`` is the upstream Neo base class and is not scanned.
``EXCEPTIONS`` is the complete list of places where one named rule is accepted.
An exception is pinned to its file, line range, the verbatim first line(s) of
that range and a reason; it permits its rules inside its range and nothing else.
When the range or an anchor drifts, or the excepted code is gone, the gate fails
with "例外需复核" (the exception must be reviewed again): an exception is a
tripwire, not a permanent whitelist. Read-only.
"""

import argparse
from collections import namedtuple
from pathlib import Path
import re
import sys

#: (rule name, pattern, why it is forbidden)
RULES = (
    ("embedded engine",
     re.compile(r"\bExecutionEngine\b|new\s+ApplicationEngine\b|\bApplicationEngine\s*\.\s*(?:Create|Run)\s*\("),
     "a native contract runs inside the platform engine; a second, embedded engine is the retired SDK design"),
    ("engine runs a script",
     re.compile(r"\bengine\s*\.\s*(?:LoadScript|LoadClonedContext|Execute\w*|Step\w*)\s*\("),
     "the platform engine is the only executor; the native contract never loads or steps a script itself"),
    ("opcode interpretation",
     re.compile(r"\bOpCode\b|\bInstruction\b"),
     "reading or enumerating opcodes is a hand-written VM interpreter; script bytes are compared, not interpreted"),
    ("retired Envelope codec",
     re.compile(r"\w*Envelope\w*"),
     "the Envelope wire codec is retired with the custom kernel"),
    ("retired bounded call",
     re.compile(r"\b\w*CallWithGasLimit\b"),
     "the per-callback bounded call is retired together with its gas budget"),
    ("self-built gas budget",
     re.compile(r"\b(?:MinimumRequiredFee|EnclosingGasAllowance|BudgetDatoshi|SA_GAS_BUDGET_EXCEEDED)\b"),
     "a self-built gas budget duplicates the platform fee mechanism"),
    ("runtime script construction",
     re.compile(r"\bScriptBuilder\b|\.\s*(?:EmitPush|EmitSysCall|EmitDynamicCall|EmitCall|EmitJump\w*|EmitAppCall)\s*\("),
     "building a script at runtime is SDK behaviour; the native contract only compares fixed script bytes"),
)

#: One accepted place: file, closed line range, the rules accepted there, the verbatim
#: first line(s) of the range, and why it is accepted.
Exception = namedtuple("Exception", "file first last rules anchor reason")

PROTOCOL = "SmartAccountProtocol.cs"
EXCEPTIONS = (
    Exception(PROTOCOL, 49, 50, ("opcode interpretation",), (
        "        private static ReadOnlySpan<byte> AccountPushHeader =>",
        "            [(byte)OpCode.PUSHDATA1, (byte)UInt160.Length];",
    ), "the two constant bytes of an account push, compared bytewise with the script prefix; never interpreted"),
    Exception(PROTOCOL, 56, 62, ("runtime script construction", "opcode interpretation"), (
        "        private static byte[] CreateCallTail(int argumentCount, CallFlags flags, string method)",
        "        {",
    ), "the fixed call tail of the proxy and entry scripts, emitted once by the platform ScriptBuilder and only ever"
       " compared bytewise; the same platform use as Contract.CreateSignatureRedeemScript"),
    Exception(PROTOCOL, 93, 99, ("runtime script construction",), (
        "        internal static byte[] CreateVerificationScript(UInt160 accountId)",
        "        {",
    ), "the proxy verification script of an account, emitted by the platform ScriptBuilder to derive the account"
       " address, as the platform's Contract.CreateSignatureRedeemScript does; no platform API replaces it"),
    Exception(PROTOCOL, 150, 205, ("opcode interpretation",), (
        "        private static Array DecodeOperationLiteral(ReadOnlyMemory<byte> literal)",
        "        {",
    ), "the literal decoder of the operation in front of the fixed entry tail: it accepts push opcodes, NEWARRAY0"
       " and PACK only, refuses every other opcode and never executes, jumps or calls a byte"),
    Exception(PROTOCOL, 229, 248, ("opcode interpretation",), (
        "        private static Integer ReadInteger(Instruction instruction)",
        "        {",
    ), "reads the operand of one push accepted by the literal decoder; it decodes bytes and executes nothing"),
    Exception(PROTOCOL, 253, 265, ("opcode interpretation",), (
        "        private static ByteString ReadData(Instruction instruction)",
        "        {",
    ), "reads the operand of one push accepted by the literal decoder; it decodes bytes and executes nothing"),
)

#: The upstream Neo base class of every native contract.
NOT_SCANNED = ("NativeContract.cs",)
COMMENT = re.compile(r"(?<!:)//.*$")


def scan(lines):
    """[(line number, rule name, code, why)] of every forbidden line of one file."""
    hits = []
    for number, line in enumerate(lines, 1):
        code = COMMENT.sub("", line).rstrip()
        for name, pattern, why in RULES:
            if pattern.search(code):
                hits.append((number, name, code, why))
    return hits


def source_files(source):
    """The scanned .cs files of ``source``, by file name, or a ValueError."""
    if not source.is_dir():
        raise ValueError(f"native source directory not found: {source}")
    files = {path.name: path for path in sorted(source.glob("*.cs")) if path.name not in NOT_SCANNED}
    if not files:
        raise ValueError(f"no .cs file to scan under {source}")
    return files


def evaluate(source, exceptions=EXCEPTIONS):
    """Problem lines of the native source; empty when the source is pure."""
    source = Path(source)
    problems = []
    try:
        files = source_files(source)
    except ValueError as error:
        return [str(error)]
    contents = {}
    for name, path in files.items():
        lines = contents[name] = path.read_text(encoding="utf-8").splitlines()
        for number, rule, code, why in scan(lines):
            if not any(e.file == name and e.first <= number <= e.last and rule in e.rules for e in exceptions):
                problems.append(f"{source.as_posix()}/{name}:{number}: [{rule}] {code.strip()} - {why}")
    review = "例外需复核 (exception must be reviewed)"
    for e in exceptions:
        if e.file not in files:
            problems.append(f"{review}: {e.file}:{e.first} is no longer a scanned file")
            continue
        lines = contents[e.file]
        for offset, anchor in enumerate(e.anchor):
            if e.first + offset > len(lines) or lines[e.first + offset - 1] != anchor:
                problems.append(f"{review}: {e.file}:{e.first + offset} no longer reads\n  {anchor}")
        if not any(name in e.rules for _, name, _, _ in scan(lines[e.first - 1:e.last])):
            problems.append(f"{review}: {e.file}:{e.first}-{e.last} carries no {('/'.join(e.rules))} any more; remove the exception")
    return problems


def main(argv=None):
    # UTF-8 on every stream, so the review marker below survives a pipe or a log file
    # on a host whose locale cannot encode it.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "contracts/native/SmartAccount",
                        help="native source directory (default: contracts/native/SmartAccount)")
    args = parser.parse_args(argv)
    problems = evaluate(args.source.resolve())
    if problems:
        print("native purity: FAIL", file=sys.stderr)
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"native purity: PASS - {len(source_files(args.source.resolve()))} file(s) under {args.source.resolve().as_posix()} carry no"
          f" forbidden pattern outside {len(EXCEPTIONS)} pinned exception(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
