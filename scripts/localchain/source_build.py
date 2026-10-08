#!/usr/bin/env python3
"""Build the AA contracts from the current checkout and read their verifier-callback build profile.

The local-chain suite runs on published Neo.Express, which registers the syscalls of the published
Neo core. The public AA profile uses standard Contract.Call; its explicit PLATFORM profile declares
`System.Contract.CallWithGasLimit` for both verifier callbacks. A build that carries that interop
faults on every verifier-signed `executeUserOp` on published Neo; only a private compatible runtime registers it.
The profile is therefore read from the compiled bytes, never claimed on the command line, so the
source variant's expectations flip with the build profile alone.

The compiler is the pinned published `nccs` (Neo.Compiler.CSharp 3.9.1); the modules under
`contracts/` restore in locked mode from nuget.org, which `nuget.config` makes the only source.
Nothing here touches a network beyond that restore, and nothing is deployed by this module.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

AA = Path(__file__).resolve().parents[2]
DEFAULT_PROJECT = AA / "contracts/UnifiedSmartWallet.csproj"

GAS_BOUNDED_SYSCALL = "System.Contract.CallWithGasLimit"
FAULT_MARKER = "The given key '1371299780' was not present in the dictionary."
PROFILE_SYSCALL_PRESENT = "platform-syscall-present"
PROFILE_SYSCALL_ABSENT = "platform-syscall-absent"

# The eight artifacts the local-chain suite deploys, in the names the compiler writes.
REQUIRED_ARTIFACTS = (
    "UnifiedSmartWalletV3",
    "MockTransferTarget",
    "WebAuthnVerifier",
    "SessionKeyVerifier",
    "AAPaymaster",
    "WhitelistHook",
    "DailyLimitHook",
    "SocialRecoveryVerifier",
)

# Neo VM operand sizes (Neo.VM OpCode attributes), needed to walk the script instead of searching
# it for bytes: a syscall token inside a PUSHDATA operand is data, not a call site.
_OPERAND_SIZE = {
    0x00: 1, 0x01: 2, 0x02: 4, 0x03: 8, 0x04: 16, 0x05: 32,          # PUSHINT8..PUSHINT256
    0x0A: 4,                                                        # PUSHA
    0x22: 1, 0x23: 4, 0x24: 1, 0x25: 4, 0x26: 1, 0x27: 4,           # JMP/JMPIF/JMPIFNOT
    0x28: 1, 0x29: 4, 0x2A: 1, 0x2B: 4, 0x2C: 1, 0x2D: 4,           # JMPEQ/JMPNE/JMPGT
    0x2E: 1, 0x2F: 4, 0x30: 1, 0x31: 4, 0x32: 1, 0x33: 4,           # JMPGE/JMPLT/JMPLE
    0x34: 1, 0x35: 4,                                               # CALL/CALL_L
    0x37: 2, 0x3B: 2, 0x3C: 8, 0x3D: 1, 0x3E: 4,                   # CALLT/TRY/ENDTRY
    0x41: 4,                                                        # SYSCALL
    0x56: 1, 0x57: 2, 0x5F: 1, 0x67: 1, 0x6F: 1, 0x77: 1,           # slot/local/arg indexes
    0x7F: 1, 0x87: 1, 0xC4: 1, 0xD9: 1, 0xDB: 1,                    # arg index, NEWARRAY_T, ...
}
_PUSHDATA_PREFIX = {0x0C: 1, 0x0D: 2, 0x0E: 4}
SYSCALL_OPCODE = 0x41
NEF_MAGIC = b"NEF3"


class BuildError(Exception):
    pass


class NefError(Exception):
    pass


def interop_hash(name):
    """The interop hash the compiler and the engine derive from a syscall name."""
    return int.from_bytes(hashlib.sha256(name.encode("ascii")).digest()[:4], "little")


INTEROP_HASH = interop_hash(GAS_BOUNDED_SYSCALL)


def _varint(data, offset):
    """Neo's variable-length integer: a single byte below 0xFD, otherwise a 0xFD/0xFE/0xFF tag
    followed by a fixed-width little-endian value."""
    if offset >= len(data):
        raise NefError("truncated variable-length integer")
    first = data[offset]
    if first < 0xFD:
        return first, offset + 1
    width = {0xFD: 2, 0xFE: 4, 0xFF: 8}[first]
    if offset + 1 + width > len(data):
        raise NefError("truncated variable-length integer")
    return int.from_bytes(data[offset + 1:offset + 1 + width], "little"), offset + 1 + width


def _varstring(data, offset, limit):
    length, offset = _varint(data, offset)
    if length > limit:
        raise NefError("variable-length string exceeds its limit")
    if offset + length > len(data):
        raise NefError("variable-length string overruns the file")
    return data[offset:offset + length].decode("utf-8", "replace"), offset + length


def read_nef(path):
    """Parse a NEF the way Neo's NefFile does, including the trailing checksum."""
    data = Path(path).read_bytes()
    if len(data) < 4 + 64 + 1 + 1 + 2 + 1 + 4:
        raise NefError("%s: too short to be a NEF" % path)
    if data[0:4] != NEF_MAGIC:
        raise NefError("%s: not a NEF3 file" % path)
    offset = 4
    compiler = data[offset:offset + 64].decode("ascii", "replace")
    offset += 64
    source, offset = _varstring(data, offset, 256)
    if data[offset] != 0:
        raise NefError("%s: reserved byte is not zero" % path)
    offset += 1
    token_count, offset = _varint(data, offset)
    if token_count > 128:
        raise NefError("%s: too many method tokens" % path)
    tokens = []
    for _ in range(token_count):
        if offset + 20 > len(data):
            raise NefError("%s: truncated method token" % path)
        token_hash = data[offset:offset + 20]
        offset += 20
        method, offset = _varstring(data, offset, 32)
        if offset + 4 > len(data):
            raise NefError("%s: truncated method token" % path)
        tokens.append({"hash": "0x" + token_hash[::-1].hex(), "method": method,
                       "parameters": int.from_bytes(data[offset:offset + 2], "little"),
                       "hasReturnValue": bool(data[offset + 2]), "callFlags": data[offset + 3]})
        offset += 4
    if data[offset:offset + 2] != b"\x00\x00":
        raise NefError("%s: reserved bytes are not zero" % path)
    offset += 2
    script_length, offset = _varint(data, offset)
    if offset + script_length + 4 > len(data):
        raise NefError("%s: script overruns the file" % path)
    script = data[offset:offset + script_length]
    offset += script_length
    if offset + 4 != len(data):
        raise NefError("%s: unexpected trailing bytes" % path)
    checksum = int.from_bytes(data[offset:offset + 4], "little")
    expected = int.from_bytes(hashlib.sha256(hashlib.sha256(data[:offset]).digest()).digest()[:4], "little")
    if checksum != expected:
        raise NefError("%s: checksum mismatch" % path)
    return {"compiler": compiler, "source": source, "tokens": tokens, "script": script}


def syscall_sites(script):
    """Every SYSCALL instruction with the last printable string pushed before it."""
    sites = []
    offset, last_string = 0, ""
    while offset < len(script):
        opcode = script[offset]
        if opcode in _PUSHDATA_PREFIX:
            prefix = _PUSHDATA_PREFIX[opcode]
            if offset + 1 + prefix > len(script):
                raise NefError("PUSHDATA prefix overruns the script")
            size = int.from_bytes(script[offset + 1:offset + 1 + prefix], "little")
            start = offset + 1 + prefix
            end = start + size
            if end > len(script):
                raise NefError("PUSHDATA operand overruns the script")
            operand = script[start:end]
            if 0 < len(operand) < 64 and all(0x20 <= byte < 0x7F for byte in operand):
                last_string = operand.decode("ascii")
        else:
            size = _OPERAND_SIZE.get(opcode, 0)
            end = offset + 1 + size
            if end > len(script):
                raise NefError("operand overruns the script")
            if opcode == SYSCALL_OPCODE:
                sites.append((int.from_bytes(script[offset + 1:end], "little"), last_string))
        offset = end
    return sites


def profile_of(nef_path):
    """The build profile of one compiled core, read from its bytes."""
    path = Path(nef_path)
    nef = read_nef(path)
    bounded = [site for site in syscall_sites(nef["script"]) if site[0] == INTEROP_HASH]
    return {
        "path": str(path),
        "coreSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bytes": path.stat().st_size,
        "compiler": nef["compiler"].strip(),
        "gasBoundedSyscall": len(bounded),
        "validateSignature": sum(1 for _, method in bounded if method == "validateSignature"),
        "postExecute": sum(1 for _, method in bounded if method == "postExecute"),
        "sites": [[token, method] for token, method in bounded],
        "profile": PROFILE_SYSCALL_PRESENT if bounded else PROFILE_SYSCALL_ABSENT,
    }


def dotnet_root():
    root = os.environ.get("DOTNET_ROOT")
    if root:
        return root
    try:
        done = subprocess.run(["dotnet", "--list-runtimes"], capture_output=True, text=True, timeout=120)
    except OSError:
        return None
    for line in done.stdout.splitlines():
        if "[" in line and "]" in line:
            runtime = line.split("[", 1)[1].split("]", 1)[0]
            return runtime.split("/shared/", 1)[0]
    return None


def find_nccs():
    candidate = os.environ.get("NCCS") or shutil.which("nccs") or str(Path.home() / ".dotnet" / "tools" / "nccs")
    if not candidate or not os.access(candidate, os.X_OK):
        raise BuildError("the pinned Neo compiler is not executable: %s (set NCCS or install "
                         "neo.compiler.csharp 3.9.1)" % candidate)
    return candidate


def require_artifacts(directory):
    directory = Path(directory)
    missing = [name for name in REQUIRED_ARTIFACTS
               if not (directory / (name + ".nef")).is_file() or not (directory / (name + ".manifest.json")).is_file()]
    if missing:
        raise BuildError("the source build directory %s is missing: %s" % (directory, ", ".join(missing)))
    return directory


def build_source_contracts(out_dir, project=None, nccs=None, timeout=1800):
    """Compile the current checkout with the pinned compiler into out_dir."""
    project = Path(project or DEFAULT_PROJECT)
    if not project.is_file():
        raise BuildError("contract project not found: %s" % project)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    root = dotnet_root()
    if root:
        env["DOTNET_ROOT"] = root
    command = [nccs or find_nccs(), str(project), "-o", str(out_dir)]
    done = subprocess.run(command, cwd=str(project.parent), capture_output=True, text=True, env=env, timeout=timeout)
    if done.returncode != 0:
        tail = (done.stdout + done.stderr).strip().splitlines()[-12:]
        raise BuildError("nccs exited %d: %s" % (done.returncode, " | ".join(tail)))
    return require_artifacts(out_dir)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, help="output directory (default: a fresh temporary directory)")
    parser.add_argument("--project", type=Path, default=DEFAULT_PROJECT)
    parser.add_argument("--source-dir", type=Path, help="report the profile of an existing build instead of compiling")
    args = parser.parse_args()
    try:
        if args.source_dir:
            directory = require_artifacts(args.source_dir)
            built = False
        else:
            directory = build_source_contracts(args.out or Path(tempfile.mkdtemp(prefix="aa-source-")), args.project)
            built = True
        report = profile_of(directory / "UnifiedSmartWalletV3.nef")
        report["out"] = str(directory)
        report["built"] = built
        print(json.dumps(report, indent=2))
    except (BuildError, NefError, subprocess.TimeoutExpired) as error:
        print("FAIL: %s" % error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
