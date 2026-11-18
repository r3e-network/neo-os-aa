"""Executable mutation checks for the nonce domain, not implementation proofs."""
from pathlib import Path
import re
import shutil
import subprocess
import unittest

import verify


@unittest.skipUnless(shutil.which("z3"), "Z3 is required for executable SMT controls")
class SmtAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (Path(__file__).parent / "smt/sa_core.smt2").read_text()

    def solve(self, source):
        return subprocess.run(
            [shutil.which("z3"), "-in", "-T:30"], input=source, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=40,
        )

    def check_gate(self, source):
        result = self.solve(source)
        return verify.parse_smt(source, result.stdout, result.returncode)

    def mutate_acceptance(self, body):
        source, count = re.subn(
            r"(?m)^(\(define-fun accepted .*? Bool ).+(\))$",
            lambda match: match[1] + body + match[2], self.source,
        )
        self.assertEqual(1, count, "acceptance mutation must affect exactly one predicate")
        return source

    def test_current_acceptance_domain_passes(self):
        self.assertEqual({"obligations": 7, "controls": 7}, self.check_gate(self.source))

    def test_reject_all_domain_fails_gate(self):
        source = self.mutate_acceptance("false")
        result = self.solve(source)
        self.assertIn("OBL:nonce-acceptance-is-signed-vm-bounded\nsat\n", result.stdout)
        self.assertIn("CTRL:nonce-acceptance-includes-both-executable-boundaries\nunsat\n",
                      result.stdout)
        with self.assertRaisesRegex(ValueError, "SMT verdict"):
            verify.parse_smt(source, result.stdout, result.returncode)

    def test_excluding_either_executable_boundary_fails_gate(self):
        for body in (
            "(and (> nonce 0) (< nonce NONCE_LIMIT))",
            "(and (>= nonce 0) (< nonce (- NONCE_LIMIT 1)))",
        ):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "SMT verdict"):
                self.check_gate(self.mutate_acceptance(body))

    def test_admitting_out_of_domain_values_fails_gate(self):
        for body in ("(< nonce NONCE_LIMIT)", "(>= nonce 0)", "true"):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "SMT verdict"):
                self.check_gate(self.mutate_acceptance(body))


if __name__ == "__main__":
    unittest.main()
