import copy
from pathlib import Path
import unittest
from unittest.mock import patch

import verify


class CurrentProtocolTests(unittest.TestCase):
    def test_current_receipt_selects_only_models_reviewed_for_this_protocol(self):
        _, sources, artifacts = verify.current_snapshot()
        self.assertIn('coq/NativeAdmission.v', artifacts)
        for model in artifacts:
            self.assertEqual([verify.CURRENT_PROFILE], verify.MODEL_PROFILES[model])
            self.assertTrue(verify.COQ_MODULES[Path(model).name])
        self.assertIn('docs/proposals/smartaccount-native-profile-parameters.json', sources)
        self.assertFalse(any('profile-v2-' in name for name in sources))

    def test_unreviewed_source_hash_is_not_acceptable(self):
        lock, _, _ = verify.current_snapshot()
        changed = copy.deepcopy(lock)
        changed['sources']['contracts/native/SmartAccount/SmartAccount.cs'] = '0' * 64
        with patch.object(verify.json, 'loads', return_value=changed):
            with self.assertRaisesRegex(ValueError, 'sources differ'):
                verify.current_snapshot()
