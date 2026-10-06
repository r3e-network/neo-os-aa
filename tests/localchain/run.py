#!/usr/bin/env python3
"""Run the deployed suite; the Python CLI owns the chain and enforces expectations."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
sys.exit(subprocess.call([sys.executable, str(root / "scripts/localchain/aa_rpc_scenarios.py"),
                          "--variant", "deployed", *sys.argv[1:]]))
