#!/usr/bin/env python3
"""Negative controls for the native profile's canonical code-identity definition."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parent


class CanonicalIdentityDocumentTests(unittest.TestCase):
    def check(self, before=None, after=None):
        with tempfile.TemporaryDirectory(prefix="native-profile-document-") as directory:
            target = Path(directory)
            for name in ("SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md",
                         "smartaccount-native-profile-v2-vectors.json",
                         "smartaccount-native-profile-v2-parameters.json",
                         "validate-native-smartaccount-profile.py"):
                text = (ROOT / name).read_text(encoding="utf-8")
                if name.endswith(".md") and before is not None:
                    self.assertEqual(text.count(before), 1)
                    text = text.replace(before, after)
                (target / name).write_text(text, encoding="utf-8")
            return subprocess.run([sys.executable, str(target / "validate-native-smartaccount-profile.py")],
                                  capture_output=True, text=True, timeout=15)

    def test_cleanup_uses_the_distinct_cleanup_phase(self):
        text = (ROOT / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md").read_text(encoding="utf-8")
        self.assertIn("Cleanup runs only\nunder the authenticated `cleanup` context", text)
        self.assertIn("under that child's authenticated `cleanup` context", text)
        self.assertNotIn("cleared by escape, market settlement,", text)

    def test_service_authority_restrictions_are_required(self):
        for before, after in (
            ("MUST return false, including in a directly dispatched target", "MAY return true in a directly dispatched target"),
            ("Custody and non-zero recovery addresses MUST NOT be native contract hashes.", "Custody and recovery MAY be native contract hashes."),
        ):
            with self.subTest(rule=before):
                self.assertNotEqual(self.check(before, after).returncode, 0)

    def test_authority_admission_cannot_omit_proxy_or_recipient_checks(self):
        for before, after in (
            ("Current and pending custody or recovery authorities MUST NOT be registered\nnative SmartAccount proxies.",
             "Pending recovery authorities MAY be registered native SmartAccount proxies."),
            ("Every account-state read and\nwrite MUST validate all current and pending non-zero authority addresses",
             "Only account creation MUST validate the current custody address"),
            ("admission MUST require a witness for every address in\n`Authorities(next) - Authorities(prior)`",
             "admission MAY ignore a newly introduced recovery recipient"),
            ("`recoveryAddress`, `pendingRecovery.newCustodyAddress` and\n`pendingRecoveryAddr.recoveryAddress`",
             "`recoveryAddress` alone"),
            ("require the custody address and every non-zero recovery address to witness the transaction",
             "require only the custody address to witness the transaction"),
            ("zero represents absent recovery and requires no witness",
             "zero MUST supply an admission witness"),
            ("They MUST NOT\nrequire a fresh recipient witness merely to move that address into its current\nslot.",
             "They MUST require a fresh recipient witness at activation."),
            ("The SmartAccount native contract MUST NOT reserve an authority address in a reverse index or prevent\nits independent account registration because another account nominated it.",
             "The service MUST reserve every unconsenting recovery nomination."),
        ):
            with self.subTest(rule=before):
                self.assertNotEqual(self.check(before, after).returncode, 0)

    def test_current_profile_passes(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_canonicalization_rule_is_rejected(self):
        for before, after in (
            ("MUST be the RFC 8785 JSON Canonicalization Scheme", "MUST use a platform JSON serializer"),
            ("names MUST be sorted recursively by unsigned UTF-16 code units", "names MAY use locale-dependent sorting"),
            ("including negative zero encoded as `0`", "including negative zero encoded as `-0`"),
            ("including its\nheader, method tokens and checksum", "including only the executable script"),
        ):
            with self.subTest(rule=before):
                self.assertNotEqual(self.check(before, after).returncode, 0)


if __name__ == "__main__":
    unittest.main()
