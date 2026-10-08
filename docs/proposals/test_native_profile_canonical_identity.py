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
                         "smartaccount-native-profile-v1-vectors.json",
                         "validate-native-smartaccount-profile.py"):
                text = (ROOT / name).read_text()
                if name.endswith(".md") and before is not None:
                    self.assertEqual(text.count(before), 1)
                    text = text.replace(before, after)
                (target / name).write_text(text)
            return subprocess.run([sys.executable, str(target / "validate-native-smartaccount-profile.py")],
                                  capture_output=True, text=True, timeout=15)

    def test_cleanup_uses_the_distinct_cleanup_phase(self):
        text = (ROOT / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md").read_text()
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
