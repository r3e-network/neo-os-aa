"""Receipt gate mutations do not require a chain or any credentials."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/localchain"))
import aa_rpc_scenarios as suite

class GateTest(unittest.TestCase):
    def setUp(self):
        self.expected = json.loads((ROOT / "tests/localchain/expected-deployed.json").read_text())
        self.receipt = {"variant": "deployed", "status": "DONE", "results": [], "records": []}
        for scenario in self.expected["scenarios"]:
            checks = [{"check": name, "ok": True} for name in scenario["checks"]]
            self.receipt["results"].append({"name": scenario["name"], "status": "PASS", "checks": checks})
            self.receipt["records"].extend(copy.deepcopy(checks))
        for outcome, count in [("HALT", 66), ("FAULT", 21), ("REJECTED", 6)]:
            self.receipt["records"].extend({"outcome": outcome} for _ in range(count))

    def test_intact_receipt(self):
        self.assertEqual(suite.validate_receipt(self.receipt, self.expected), [])

    def test_mutants_fail_closed(self):
        mutations = [
            lambda r: r.update(status="ABORTED"),
            lambda r: r.update(variant="source"),
            lambda r: r["results"].pop(),
            lambda r: r["results"].append(copy.deepcopy(r["results"][0])),
            lambda r: r["results"][0].update(status="FAIL"),
            lambda r: r["results"][0]["checks"][0].update(ok=False),
            lambda r: r["results"][0]["checks"][0].update(check="unexpected"),
            lambda r: r["results"][0]["checks"].pop(),
            lambda r: r["records"][0].update(ok=False),
            lambda r: r["records"].pop(0),
            lambda r: r["records"].append({"outcome": "HALT"}),
            lambda r: r["records"].append({"outcome": "FAULT"}),
            lambda r: r["records"].pop(),
            lambda r: r["records"].append({"outcome": "ACCEPTED"}),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                r = copy.deepcopy(self.receipt)
                mutate(r)
                self.assertTrue(suite.validate_receipt(r, self.expected))

    def test_artifact_mismatch_names_file(self):
        expected = copy.deepcopy(self.expected)
        name = "contracts/build/UnifiedSmartWalletV3.nef"
        next(a for a in expected["artifacts"] if a["path"] == name)["sha256"] = "0" * 64
        with self.assertRaisesRegex(suite.Fail, "UnifiedSmartWalletV3.nef"):
            suite.validate_artifacts(expected)

if __name__ == "__main__":
    unittest.main()
