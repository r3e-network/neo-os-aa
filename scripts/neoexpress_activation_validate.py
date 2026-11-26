#!/usr/bin/env python3
"""Shared runtime helpers of the NeoExpress validators of the native SmartAccount runtime.

Each validator owns its own probe, receipt and scenario matrix. This module only pins what they
must agree on: the hardfork setting a private chain activates, the runtime files a receipt hashes,
the direct assembly runner, and the readback check of a deployed probe.
"""
import base64
import hashlib
from pathlib import Path

from neoexpress_validate import ValidationFailure

RUNTIME_FILES = ("neoxp.dll", "Neo.dll", "Neo.Extensions.dll", "Neo.IO.dll",
                 "Neo.Json.dll", "Neo.VM.dll")
ACTIVATION_KEY = "protocol.Hardforks.HF_SmartAccountV1"


def require(condition, message):
    if not condition:
        raise ValidationFailure(message)


def check_readback(state, script, nef, manifest):
    """The deployed probe must read back as exactly the bytes that were deployed."""
    require(base64.b64decode(state["nef"]["script"], validate=True) == script, "Probe script mismatch")
    require(state["nef"]["checksum"] == int.from_bytes(nef[-4:], "little"), "Probe checksum mismatch")
    require(state["manifest"] == manifest, "Probe manifest mismatch")


def runtime_hashes(directory):
    require(all((directory / name).is_file() for name in RUNTIME_FILES), "Incomplete NeoExpress runtime")
    return {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in RUNTIME_FILES}


def make_runner(directory, dotnet, target):
    """Execute the selected assembly directly; do not trust an opaque shell wrapper."""
    runner = target / "neoxp"
    runner.write_text("#!/usr/bin/env python3\nimport os, sys\n" +
                      f"os.execv({str(dotnet)!r}, [{str(dotnet)!r}, {str(directory / 'neoxp.dll')!r}, *sys.argv[1:]])\n")
    runner.chmod(0o700)
    return str(runner)
