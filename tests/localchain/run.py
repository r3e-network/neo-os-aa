#!/usr/bin/env python3
"""Run one local-chain suite variant; the Python CLI owns the chain and enforces expectations."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SUITE = ROOT / "scripts/localchain/aa_rpc_scenarios.py"


def command(argv):
    """The suite command line for these arguments, with the variant's own default receipt."""
    variant = "deployed"
    rest = []
    index = 0
    while index < len(argv):
        if argv[index] == "--variant" and index + 1 < len(argv):
            variant = argv[index + 1]
            index += 2
            continue
        rest.append(argv[index])
        index += 1
    cmd = [sys.executable, str(SUITE), "--variant", variant]
    if "--receipt" not in rest:
        cmd += ["--receipt", str(ROOT / "tests/localchain/out" / ("rpc-%s.json" % variant))]
    return cmd + rest


if __name__ == "__main__":
    sys.exit(subprocess.call(command(sys.argv[1:])))
