"""Offline recipe input and fail-closed receipt controls."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import build_native_modules as builder

class NativeBuildTests(unittest.TestCase):
    def test_linked_source_rejects_escape_and_symlink_alias(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); contracts=root/'contracts'; contracts.mkdir(); source=contracts/'module.cs'; source.write_text('class C {}')
            self.assertEqual(source,builder.checked_input(contracts,source))
            link=contracts/'alias.cs';link.symlink_to(source)
            for invalid in (link,root/'outside.cs'):
                with self.assertRaises(ValueError):builder.checked_input(contracts,invalid)

    def test_failed_build_overwrites_old_success_and_never_invokes_compiler(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); contracts=root/'contracts'; (contracts/'native').mkdir(parents=True)
            (contracts/'native/profiles.json').write_text('{}'); receipt=root/'receipt.json';receipt.write_text('{"status":"PASS"}')
            with patch.object(builder.subprocess,'check_output') as compiler:
                with self.assertRaises(ValueError):builder.build(contracts,root/'compiler',root/'cache',root/'output',receipt)
                compiler.assert_not_called()
            self.assertEqual('FAIL',json.loads(receipt.read_text())['status'])

if __name__=='__main__':unittest.main()
