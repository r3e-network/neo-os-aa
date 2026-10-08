"""Exact storage and event oracles for native uncapped session validation."""
import base64
import copy
import importlib
from pathlib import Path
import tempfile
import unittest

from neoexpress_validate import ValidationFailure, decode, hash_le, A, B, H, I, S
from neoexpress_native_proxy_validate import GAS_TOKEN
from neoexpress_native_session_validate import serialize_value


class NativeSessionScopeTests(unittest.TestCase):
    def module(self):
        return importlib.import_module('neoexpress_native_session_scope_validate')

    def state(self):
        return {'account':[None]*8+[7], 'pending':['old'], 'key':None,'metadata':None,
                'spent':9,'nonce':3,'balance':100,'raw':[None,None,'CQ==','AA==']}

    def test_grant_oracle_preserves_spent_and_encodes_exact_storage(self):
        m=self.module();state=self.state();key=b'\x02'+bytes(32)
        m.grant_change(state,123,key,GAS_TOKEN,'*',999,0,'wildcard')
        self.assertEqual(8,state['account'][8]);self.assertIsNone(state['pending'])
        self.assertEqual(9,state['spent']);self.assertEqual('CQ==',state['raw'][2])
        self.assertEqual([key,hash_le(GAS_TOKEN),b'*',999,0],state['key'])
        self.assertEqual([123,0,b'wildcard'],state['metadata'])
        expected=A(B(key),H(GAS_TOKEN),S('*'),I(999),I(0))
        self.assertEqual(base64.b64encode(serialize_value(expected)).decode(),state['raw'][0])
        self.assertEqual('ew==',state['raw'][3])

    def test_uncapped_completion_advances_nonce_not_spent(self):
        m=self.module();state=self.state();state['metadata']=[10,0,b'scope']
        m.use_change(state,20,40)
        self.assertEqual((4,9,60),(state['nonce'],state['spent'],state['balance']))
        self.assertEqual([10,20,b'scope'],state['metadata'])
        self.assertEqual('CQ==',state['raw'][2])
        self.assertEqual(base64.b64encode(serialize_value(A(I(10),I(20),B(b'scope')))).decode(),state['raw'][1])
        m.use_change(state,21,0);self.assertEqual((5,9,60),(state['nonce'],state['spent'],state['balance']))

    def test_revocation_clears_three_prefixes_but_not_cooldown_or_nonce(self):
        m=self.module();state=self.state();m.revoke_change(state,100)
        self.assertEqual([None,None,None,'AA=='],state['raw'])
        self.assertEqual((0,3,8),(state['spent'],state['nonce'],state['account'][8]))
        self.assertIsNone(state['pending']);self.assertIsNone(state['key']);self.assertIsNone(state['metadata'])

    def test_grant_notification_requires_exact_scope_and_boolean(self):
        m=self.module();account='0x'+'11'*20;verifier='0x'+'22'*20;key=b'\x02'+bytes(32)
        values=A(H(account),B(key),H(GAS_TOKEN),S('*'),I(999),I(0),{'type':'Boolean','value':True})
        def vm(item):
            kind=item['type'];value=item.get('value')
            if kind=='Array':return {'type':'Array','value':[vm(v) for v in value]}
            if kind=='Hash160':return {'type':'ByteString','value':base64.b64encode(hash_le(value)).decode()}
            if kind=='String':return {'type':'ByteString','value':base64.b64encode(value.encode()).decode()}
            if kind=='ByteArray':return {'type':'ByteString','value':value}
            return item
        notice={'contract':verifier,'eventname':'SessionKeyGranted','state':vm(values)}
        expected=[hash_le(account),key,hash_le(GAS_TOKEN),b'*',999,0,True]
        m.check_grant_notification({'notifications':[notice]},verifier,expected)
        for field,changed in [('contract',account),('eventname','SessionKeyRevoked')]:
            wrong=copy.deepcopy(notice);wrong[field]=changed
            with self.assertRaises(ValidationFailure):m.check_grant_notification({'notifications':[wrong]},verifier,expected)
        for index,replacement in [(3,vm(S('transfer'))),(5,I(1)),(6,I(1))]:
            wrong=copy.deepcopy(notice);wrong['state']['value'][index]=replacement
            with self.assertRaises(ValidationFailure):m.check_grant_notification({'notifications':[wrong]},verifier,expected)
        for notices in [[],[notice,notice]]:
            with self.assertRaises(ValidationFailure):m.check_grant_notification({'notifications':notices},verifier,expected)

    def test_missing_provenance_overwrites_stale_pass(self):
        m=self.module()
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);output=root/'receipt.json';output.write_text('{"status":"PASS"}')
            with self.assertRaises(FileNotFoundError):m.validate(root,root,root,root/'missing',root/'modules',output)
            import json
            self.assertEqual('FAIL',json.loads(output.read_text())['status'])


if __name__=='__main__':unittest.main()
