"""Raw-storage oracles and fail-closed compilation for restricted-token checks."""
import base64
import importlib
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock,patch

from neoexpress_validate import ValidationFailure
from neoexpress_native_daily_validate import stored,raw_integer
from neoexpress_native_proxy_validate import proxy_address

class NativeRestrictedMatrixTests(unittest.TestCase):
    def module(self):return importlib.import_module('neoexpress_native_restricted_validate')

    def state(self):
        return {'nonce':0,'tokenBalances':[1000,1000],'tokenModes':[0,0], 'tokenRaw':[{}]*4}

    def test_movement_oracle_tracks_both_directions_and_mode(self):
        m=self.module();account='0x'+'11'*20;recipient='0x'+'22'*20
        for outward,expected in [(True,[997,1003]),(False,[1003,997])]:
            state=self.state();m.change_move(state,account,recipient,3,outward,0)
            self.assertEqual(expected,state['tokenBalances']);self.assertEqual(1,state['nonce'])
            self.assertEqual(stored(proxy_address(account),1,raw_integer(expected[0]),token=None),state['tokenRaw'][0])
            self.assertEqual(stored(recipient,1,raw_integer(expected[1]),token=None),state['tokenRaw'][2])
        state=self.state();m.change_mode(state,account,7)
        self.assertEqual([7,0],state['tokenModes'])
        self.assertEqual(stored(proxy_address(account),2,raw_integer(7),token=None),state['tokenRaw'][1])

    def test_storage_observer_does_not_trust_token_queries_or_share_recipient(self):
        m=self.module();a='0x'+'11'*20;other='0x'+'22'*20
        driver=m.RestrictedTransactions(None,a,other,'0x'+'33'*20,None,'0x'+'44'*20,{})
        driver.diagnostic_token='0x'+'55'*20;driver.storage=Mock(return_value=[{},{}]);driver.value=Mock(return_value=0)
        with patch.object(m,'storage_prefix',return_value={}):
            self.assertEqual([0,0],driver.state(a)['tokenBalances']);self.assertEqual([0],driver.state(other)['tokenBalances'])
        self.assertFalse(any(c.args[0]==driver.diagnostic_token for c in driver.value.call_args_list))

    def test_diagnostic_build_requires_four_matching_artifacts(self):
        m=self.module()
        for mode in ('error','missing','drift','match'):
            count=[0]
            def compile(command,**options):
                count[0]+=1;output=Path(command[-1]);output.mkdir()
                for name in ('RestrictedOutflowToken','RestrictedOutflowRouter'):
                    (output/(name+'.nef')).write_bytes(bytes([count[0] if mode=='drift' else 1]))
                    if mode!='missing':(output/(name+'.manifest.json')).write_text('{}')
                return SimpleNamespace(returncode=1 if mode=='error' else 0,stdout='',stderr='')
            with tempfile.TemporaryDirectory() as tmp, patch.object(m.subprocess,'run',side_effect=compile):
                root=Path(tmp)
                if mode=='match':
                    path,receipts=m.build_diagnostic(Path('compiler'),root,root);self.assertTrue(path.exists());self.assertEqual(receipts[0],receipts[1])
                else:
                    with self.assertRaises(ValidationFailure):m.build_diagnostic(Path('compiler'),root,root)

    def test_missing_provenance_replaces_stale_pass(self):
        import json
        m=self.module()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);receipt=root/'receipt.json';receipt.write_text('{"status":"PASS"}')
            with self.assertRaises(FileNotFoundError):m.validate(root,root,root,root/'missing',root/'module',receipt,root,root)
            self.assertEqual('FAIL',json.loads(receipt.read_text())['status'])

if __name__=='__main__':unittest.main()
