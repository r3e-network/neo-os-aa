"""Strict signer construction and state-transition evidence checks."""
import copy
import unittest
import neoexpress_native_recovery_validate as recovery
from neoexpress_validate import ValidationFailure


class NativeRecoveryTests(unittest.TestCase):
    def test_expected_record_only_changes_declared_fields_and_cursor(self):
        before = ([1, bytes(20), bytes([1]) * 20, bytes([2]) * 20, bytes([3]) * 20, None, None, 0, 2, None, None, None, None], 7)
        after = copy.deepcopy(before); after[0][7] = 1; after[0][8] = 3
        recovery.check_transition(before, after, {7: 1, 8: 3}, 0)
        for index in (1, 2, 3, 4, 5, 12):
            wrong = copy.deepcopy(after); wrong[0][index] = b"changed"
            with self.assertRaises(ValidationFailure): recovery.check_transition(before, wrong, {7: 1, 8: 3}, 0)
        with self.assertRaises(ValidationFailure): recovery.check_transition(before, (after[0], 8), {7: 1, 8: 3}, 0)
        wrong = copy.deepcopy(after); wrong[0][7] = True
        with self.assertRaises(ValidationFailure): recovery.check_transition(before, wrong, {7: 1, 8: 3}, 0)

    def test_mutation_indices_cannot_overwrite_identity(self):
        before = ([0] * 13, 0)
        for index in (0, 1, 2, 4, 5, 6, 13, -1):
            with self.assertRaises(ValidationFailure): recovery.check_transition(before, before, {index: 0}, 0)

    def test_joint_signers_are_distinct_and_keep_payer_order(self):
        from types import SimpleNamespace
        one = SimpleNamespace(script_hash=bytes([1]) * 20); two = SimpleNamespace(script_hash=bytes([2]) * 20)
        signers = recovery.signers_for([one, two])
        self.assertEqual("0x" + "01" * 20, signers[0]["account"])
        self.assertEqual("CalledByEntry", signers[1]["scopes"])
        for keys in ([], [one, one]):
            with self.assertRaises(ValidationFailure): recovery.signers_for(keys)


if __name__ == "__main__": unittest.main()
