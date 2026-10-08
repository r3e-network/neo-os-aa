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
        totals = self.expected["totals"]
        self.receipt = {"variant": "deployed", "status": "DONE", "results": [], "records": [],
                        "timelockBoundaries": [
                            {"timelock": "24h-config-update", "deadlineMs": 86400000, "earliestDeadlineMs": 86390000,
                             "deniedAtMs": 86340000, "allowedAtMs": 86460000, "observedDenied": True, "observedAllowed": True},
                            {"timelock": "7d-escape", "deadlineMs": 604800000, "earliestDeadlineMs": 604800000,
                             "deniedAtMs": 604740000, "allowedAtMs": 604860000, "observedDenied": True, "observedAllowed": True},
                        ]}
        for scenario in self.expected["scenarios"]:
            checks = [{"check": name, "ok": True} for name in scenario["checks"]]
            self.receipt["results"].append({"name": scenario["name"], "status": "PASS", "checks": checks})
            self.receipt["records"].extend(copy.deepcopy(checks))
        for outcome, count in [("HALT", totals["executedTransactions"]), ("FAULT", totals["simulatedFaults"]),
                               ("REJECTED", totals["nodeRefusals"])]:
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

    def test_timelock_boundary_mutants_fail_closed(self):
        """The 24 h and the 7 d walk are only evidence with both observed sides around the on-chain deadline."""
        mutations = [
            lambda r: r.pop("timelockBoundaries"),
            lambda r: r.update(timelockBoundaries=[]),
            lambda r: r["timelockBoundaries"][0].update(observedDenied=False),
            lambda r: r["timelockBoundaries"][1].update(observedAllowed=False),
            lambda r: r["timelockBoundaries"][0].update(deniedAtMs=86460000),
            lambda r: r["timelockBoundaries"][1].update(allowedAtMs=604740000),
            lambda r: r["timelockBoundaries"][0].pop("deniedAtMs"),
            lambda r: r["timelockBoundaries"][0].update(earliestDeadlineMs=86460000),
            lambda r: r["timelockBoundaries"].reverse(),
            lambda r: r["timelockBoundaries"][1].update(timelock="24h-config-update"),
            lambda r: r.update(timelockBoundaries={"24h-config-update": True, "7d-escape": True}),
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
