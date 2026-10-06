"""Integration negative control: a real verifier substitution must fail by name."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class MismatchTest(unittest.TestCase):
    def test_verifier_mismatch_exits_one(self):
        with tempfile.TemporaryDirectory(prefix="aa-mismatch-", dir="/private/tmp" if sys.platform == "darwin" else "/tmp") as tmp:
            receipt = Path(tmp) / "receipt.json"
            done = subprocess.run([sys.executable, str(ROOT / "scripts/localchain/aa_rpc_scenarios.py"),
                "--variant", "deployed", "--receipt", str(receipt), "--plant-mismatch", "verifier"],
                capture_output=True, text=True, timeout=480)
            print(done.stdout, flush=True)
            self.assertTrue(receipt.exists(), done.stderr[-600:])
            r = json.loads(receipt.read_text())
            row = next(x for x in r["results"] if x["name"] == "AA-01/02 create + native execute")
            self.assertEqual(row["status"], "FAIL")
            self.assertIn("no verifier: native fallback", row["failure"])
            self.assertIn({"check": "no verifier: native fallback", "ok": False}, r["records"])
            self.assertEqual(done.returncode, 1)
            self.assertTrue(all(x["status"] == "PASS" for x in r["results"] if x is not row))
            data_path = done.stdout.split("data ", 1)[1].splitlines()[0]
            self.assertFalse(Path(data_path).exists(), "disposable chain and keys were removed")

if __name__ == "__main__":
    unittest.main()
