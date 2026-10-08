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
    def test_native_session_domain_equals_the_standard_account_authority(self):
        import neoexpress_native_session_validate as session
        key=bytes.fromhex('036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296')
        expected=bytes.fromhex('95f9b24ea3b055e8bd3bce0bf24c6ec31b68689ad320de2adef18b0719f6f528')
        self.assertEqual(expected,session.native_session_signer_domain(key))
        self.assertNotEqual(hashlib.sha256(b'NeoSmartAccount/SignerDomain\x01\x02'+key).digest(),expected)
        for invalid in (b'',bytes(33),b'\x04'+bytes(32),b'\x04'+bytes(64),key.hex(),bytearray(key)):
            with self.assertRaises(ValidationFailure):session.native_session_signer_domain(invalid)

    def test_explicit_target_scope_preserves_default_and_allows_negative_controls(self):
        from neoexpress_native_proxy_validate import GAS_TOKEN
        from neoexpress_validate import aa_proxy_rules
        for options,target in (({},GAS_TOKEN),({'witness_target':STDLIB},STDLIB)):
            driver,args=self.rejection_driver()
            with patch('neoexpress_native_session_validate.serialize_unsigned',side_effect=ValueError('captured')) as serialize:
                with self.assertRaisesRegex(ValueError,'captured'):
                    driver.send('scope-control',CORE,'executeUserOp',args,proxy=True,**options)
            self.assertEqual(aa_proxy_rules(CORE,target),serialize.call_args.args[4][1]['rules'])
            self.assertTrue(serialize.call_args.args[5].startswith(bytes.fromhex('1b17')),
                            'The fresh proxy script must push observed configuration 11 then epoch 7')

    def test_nonproxy_execution_passes_both_observed_authority_counters(self):
        driver,args=self.rejection_driver()
        with patch('neoexpress_native_session_validate.call_script',side_effect=ValueError('captured call')) as call:
            with self.assertRaisesRegex(ValueError,'captured call'):
                driver.send('direct-control',CORE,'executeUserOp',args)
        self.assertEqual((CORE,'executeUserOp',[*args,I(7),I(11)]),call.call_args.args)

    def rejection_driver(self, error='rpc sendrawtransaction: Inventory verification failed - Invalid'):
        def rpc(method, args):
            if method == 'getblockcount': return 100
            if method == 'invokescript': return {'state':'HALT','gasconsumed':'1000','minimumrequiredfee':'300000000'}
            if method == 'sendrawtransaction':
                if error is None: return {'hash':'unexpectedly-accepted'}
                raise ValidationFailure(error)
            self.fail('Unexpected RPC '+method)
        payer=SimpleNamespace(script_hash=bytes(20),verification=b'\x40',sign=lambda message: bytes(64))
        report={'executions':[], 'rejectedWitnesses':[]}
        driver=SessionTransactions(SimpleNamespace(magic=123,rpc=rpc), '0x'+'11'*20, '0x'+'22'*20,
                                   '0x'+'33'*20,payer,'0x'+'44'*20,report)
        driver.state=Mock(return_value={'unchanged':True,'account':[2,bytes.fromhex('11'*20),bytes(20),bytes(20),None,None,None,0,11,None,None,None,None,7]});driver.value=Mock(return_value=123)
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
        before=driver.state.return_value
        driver.state.side_effect=[before,before,{**before,'unchanged':False}]
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
        vectors=json.loads((Path(__file__).resolve().parent.parent/'docs/proposals/smartaccount-native-profile-v2-vectors.json').read_text())
        published=vectors['operation']; identity=vectors['identity']
        original=A(B(bytes.fromhex(published['targetContractWire'])),S(published['methodUtf8']),
                   A(B(bytes.fromhex(published['args'][0]['value'])),I(42)),I(int(published['nonce'])),I(int(published['deadline'])),B(b''))
        known=signing_preimage(int(vectors['networkMagic'],16),'0x'+bytes.fromhex(identity['accountIdWire'])[::-1].hex(),original, authority_epoch=int(published['authorityEpoch']), configuration_nonce=int(published['configurationNonce']))
        self.assertEqual(published['canonicalOperationWithoutSignature'],serialize_value(original).hex())
        self.assertEqual(published['authorizationMessage'],known.hex())
        self.assertEqual(published['authorizationDigest'],hashlib.sha256(known).hexdigest())
        account='0x'+'11'*20
        op=A(H(STDLIB),S('serialize'),A(I(7)),I(0),I(1234),B(b'ignored'))
        preimage=signing_preimage(123,account,op)
        self.assertTrue(preimage.startswith(b'NeoSmartAccount/UserOperation\x02'+(123).to_bytes(4,'little')))
        empty=A(*op['value'][:5],B(b''))
        self.assertEqual(preimage,b'NeoSmartAccount/UserOperation\x02'+(123).to_bytes(4,'little')+bytes.fromhex(CORE[2:])[::-1]+bytes.fromhex(account[2:])[::-1]+bytes(16)+serialize_value(empty))
        self.assertNotEqual(signing_preimage(124,account,op),preimage)
        self.assertNotEqual(signing_preimage(123,'0x'+'22'*20,op),preimage)

    def test_authority_epoch_and_configuration_nonce_are_independently_bound(self):
        op=A(H(STDLIB),S('serialize'),A(I(7)),I(0),I(1234),B(b'')); account='0x'+'11'*20
        original=signing_preimage(123,account,op,authority_epoch=7,configuration_nonce=11)
        self.assertNotEqual(original,signing_preimage(123,account,op,authority_epoch=8,configuration_nonce=11))
        self.assertNotEqual(original,signing_preimage(123,account,op,authority_epoch=7,configuration_nonce=12))
        for field in ('authority_epoch','configuration_nonce'):
            for value in (-1,2**64,True,'1'):
                with self.assertRaises(ValidationFailure):signing_preimage(123,account,op,**{field:value})

    def test_module_observers_read_only_current_epoch_namespaces(self):
        import base64
        from neoexpress_native_daily_validate import DailyTransactions
        from neoexpress_native_restricted_validate import RestrictedTransactions
        from neoexpress_validate import hash_le
        for cls,count in ((SessionTransactions,6),(DailyTransactions,6),(RestrictedTransactions,2)):
            calls=[]
            def rpc(method,args):
                calls.append((method,args))
                return None if method=='getstorage' else {'results':[],'next':'','truncated':False}
            chain=SimpleNamespace(rpc=rpc,rpc_invoke=Mock(return_value=(7,None,None)))
            driver=cls(chain,'0x'+'11'*20,'0x'+'22'*20,'module',None,None,{})
            driver.storage(driver.account)
            self.assertEqual(count,len(calls))
            for prefix,(_,args) in enumerate(calls,1):
                self.assertEqual(b'\xa2'+bytes([prefix])+hash_le(driver.account)+(7).to_bytes(8,'little'),base64.b64decode(args[1]))
            self.assertEqual('getAuthorityEpoch',chain.rpc_invoke.call_args.args[1])

    def test_live_signing_queries_epoch_and_configuration_instead_of_default_zero(self):
        op=A(H(STDLIB),S('serialize'),A(I(7)),I(0),I(1234),B(b''));account='0x'+'11'*20
        record=[2,bytes(20),bytes(20),bytes(20),None,None,None,0,11,None,None,None,None,7]
        preimage=signing_preimage(123,account,op,authority_epoch=7,configuration_nonce=11)
        calls=[]
        def read(target,method,args):
            calls.append(method)
            return {'getAccount':record,'getAuthorityEpoch':7,'getPayload':preimage,'getOperationDigest':hashlib.sha256(preimage).digest()}[method]
        driver=SessionTransactions(SimpleNamespace(magic=123),account,'other','module',None,None,{'signingVectors':[]});driver.value=read
        key=SimpleNamespace(compressed=bytes(33),sign=Mock(return_value=bytes(64)))
        driver.signed(key,op)
        key.sign.assert_called_once_with(preimage)
        self.assertEqual(['getAccount','getAuthorityEpoch','getPayload','getOperationDigest'],calls)
        self.assertEqual(7,driver.report['signingVectors'][0]['authorityEpoch'])
        self.assertEqual(11,driver.report['signingVectors'][0]['configurationNonce'])

    def test_binary_types_and_signed_integer_boundaries(self):
        self.assertEqual(bytes.fromhex('210107'),serialize_value(I(7)))
        self.assertEqual(bytes.fromhex('2001'),serialize_value({'type':'Boolean','value':True}))
        self.assertEqual(bytes.fromhex('4000'),serialize_value(A()))
        for value in (-(1<<255)-1,1<<255):
            with self.assertRaises(ValidationFailure):serialize_value(I(value))
        with self.assertRaises(ValidationFailure):serialize_value({'type':'Boolean','value':1})


if __name__=='__main__':unittest.main()
