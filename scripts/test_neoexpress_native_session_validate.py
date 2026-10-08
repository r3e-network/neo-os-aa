"""Independent signing-domain vectors and native session admission controls."""
import hashlib
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from neoexpress_validate import A, B, H, I, S, ValidationFailure
from neoexpress_native_service_validate import CORE, STDLIB
from neoexpress_native_session_validate import signing_preimage, serialize_value, SessionTransactions


class NativeSessionTests(unittest.TestCase):
    def test_explicit_target_scope_preserves_default_and_allows_negative_controls(self):
        from neoexpress_native_proxy_validate import GAS_TOKEN
        from neoexpress_validate import aa_proxy_rules
        for options,target in (({},GAS_TOKEN),({'witness_target':STDLIB},STDLIB)):
            driver,args=self.rejection_driver()
            with patch('neoexpress_native_session_validate.serialize_unsigned',side_effect=ValueError('captured')) as serialize:
                with self.assertRaisesRegex(ValueError,'captured'):
                    driver.send('scope-control',CORE,'executeUserOp',args,proxy=True,**options)
            self.assertEqual(aa_proxy_rules(CORE,target),serialize.call_args.args[4][1]['rules'])

    def rejection_driver(self, error='rpc sendrawtransaction: Inventory verification failed - Invalid'):
        def rpc(method, args):
            if method == 'getblockcount': return 100
            if method == 'sendrawtransaction':
                if error is None: return {'hash':'unexpectedly-accepted'}
                raise ValidationFailure(error)
            self.fail('Unexpected RPC '+method)
        payer=SimpleNamespace(script_hash=bytes(20),verification=b'\x40',sign=lambda message: bytes(64))
        report={'executions':[], 'rejectedWitnesses':[]}
        driver=SessionTransactions(SimpleNamespace(magic=123,rpc=rpc), '0x'+'11'*20, '0x'+'22'*20,
                                   '0x'+'33'*20,payer,'0x'+'44'*20,report)
        driver.state=Mock(return_value={'unchanged':True});driver.value=Mock(return_value=123)
        operation=A(H(STDLIB),S('serialize'),A(I(7)),I(0),I(1234),B(bytes(64)))
        return driver, [H(driver.account),operation]

    def test_inventory_rejection_is_not_a_persisted_fault(self):
        driver,args=self.rejection_driver()
        driver.send('invalid-witness',CORE,'executeUserOp',args,proxy=True,admission_rejection=True)
        self.assertEqual([],driver.report['executions'])
        self.assertEqual(1,len(driver.report['rejectedWitnesses']))
        self.assertFalse(driver.report['rejectedWitnesses'][0]['persisted'])
        self.assertTrue(driver.report['rejectedWitnesses'][0]['observedStateAndIsolationMatched'])

    def test_admission_controls_reject_errors_acceptance_and_state_changes(self):
        for error in ('rpc sendrawtransaction: connection failed',None):
            driver,args=self.rejection_driver(error)
            with self.assertRaises(ValidationFailure):
                driver.send('invalid-witness',CORE,'executeUserOp',args,proxy=True,admission_rejection=True)
            self.assertEqual([],driver.report['rejectedWitnesses'])
        driver,args=self.rejection_driver()
        driver.state.side_effect=[{'unchanged':True},{'unchanged':True},{'unchanged':False}]
        with self.assertRaises(ValidationFailure):
            driver.send('invalid-witness',CORE,'executeUserOp',args,proxy=True,admission_rejection=True)
        self.assertEqual([],driver.report['rejectedWitnesses'])

    def test_admission_rejection_requires_proxy_and_no_application_fault(self):
        for options in ({'proxy':False},{'proxy':True,'fault':'application fault'}):
            driver,args=self.rejection_driver()
            with self.assertRaises(ValidationFailure):
                driver.send('invalid-witness',CORE,'executeUserOp',args,admission_rejection=True,**options)

    def test_profile_is_explicit_and_declares_configuration(self):
        profiles=json.loads((Path(__file__).resolve().parent.parent/'contracts/native/profiles.json').read_text())
        self.assertEqual(['setSessionKey','clearSessionKey'], profiles['SessionKeyVerifier']['configurationMethods'])

    def test_signing_input_matches_published_native_vector(self):
        vectors=json.loads((Path(__file__).resolve().parent.parent/'docs/proposals/smartaccount-native-profile-v1-vectors.json').read_text())
        published=vectors['operation']; identity=vectors['identity']
        original=A(B(bytes.fromhex(published['targetContractWire'])),S(published['methodUtf8']),
                   A(B(bytes.fromhex(published['args'][0]['value'])),I(42)),I(int(published['nonce'])),I(int(published['deadline'])),B(b''))
        known=signing_preimage(int(vectors['networkMagic'],16),'0x'+bytes.fromhex(identity['accountIdWire'])[::-1].hex(),original)
        self.assertEqual(published['canonicalOperationWithoutSignature'],serialize_value(original).hex())
        self.assertEqual(published['authorizationMessage'],known.hex())
        self.assertEqual(published['authorizationDigest'],hashlib.sha256(known).hexdigest())
        account='0x'+'11'*20
        op=A(H(STDLIB),S('serialize'),A(I(7)),I(0),I(1234),B(b'ignored'))
        preimage=signing_preimage(123,account,op)
        self.assertTrue(preimage.startswith(b'NeoSmartAccount/UserOperation\x01'+(123).to_bytes(4,'little')))
        empty=A(*op['value'][:5],B(b''))
        self.assertEqual(preimage,b'NeoSmartAccount/UserOperation\x01'+(123).to_bytes(4,'little')+bytes.fromhex(CORE[2:])[::-1]+bytes.fromhex(account[2:])[::-1]+serialize_value(empty))
        self.assertNotEqual(signing_preimage(124,account,op),preimage)
        self.assertNotEqual(signing_preimage(123,'0x'+'22'*20,op),preimage)

    def test_binary_types_and_signed_integer_boundaries(self):
        self.assertEqual(bytes.fromhex('210107'),serialize_value(I(7)))
        self.assertEqual(bytes.fromhex('2001'),serialize_value({'type':'Boolean','value':True}))
        self.assertEqual(bytes.fromhex('4000'),serialize_value(A()))
        for value in (-(1<<255)-1,1<<255):
            with self.assertRaises(ValidationFailure):serialize_value(I(value))
        with self.assertRaises(ValidationFailure):serialize_value({'type':'Boolean','value':1})


if __name__=='__main__':unittest.main()
