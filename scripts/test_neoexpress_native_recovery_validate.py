"""Strict signer construction and state-transition evidence checks."""
import copy
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
import neoexpress_native_recovery_validate as recovery
from neoexpress_validate import ValidationFailure


class NativeRecoveryTests(unittest.TestCase):
    def test_retained_transaction_is_submitted_byte_identically_without_resigning(self):
        account='0x'+'11'*20
        record=[2,bytes.fromhex('11'*20),bytes(20),bytes(20),None,None,None,0,11,None,None,None,None,7]
        key=SimpleNamespace(script_hash=bytes(20),verification=b'\x40',sign=Mock(return_value=bytes(64)))
        def rpc(method,args):
            if method=='invokescript':return {'state':'HALT','gasconsumed':'12','minimumrequiredfee':'1000'}
            if method=='getblockcount':return 100
            if method=='sendrawtransaction':raise ValueError('captured raw')
            self.fail('Unexpected RPC '+method)
        chain=SimpleNamespace(magic=123,rpc=Mock(side_effect=rpc))
        driver=recovery.RecoveryTransactions(chain,account,{'executions':[]})
        driver.state=Mock(return_value=(record,1))
        held=driver.send('held','executeUserOp',[recovery.operation(1)],[key],prepare_only=True)
        self.assertEqual('invokescript', held['preflightBeforeAuthorityChange']['method'])
        self.assertTrue(held['preflightBeforeAuthorityChange']['signatureAdmissionDeferredToSendRawTransaction'])
        self.assertEqual(1,key.sign.call_count)
        driver.state.return_value=(copy.deepcopy(record),1)
        driver.state.return_value[0][8]=12
        with patch.object(recovery,'call_script',side_effect=AssertionError('must not reconstruct')):
            with patch.object(recovery,'serialize_unsigned',side_effect=AssertionError('must not reconstruct')):
                with self.assertRaisesRegex(ValueError,'captured raw'):
                    driver.send('retained','executeUserOp',[],[],prepared=held,fault='stale')
        self.assertEqual(1,key.sign.call_count)
        self.assertEqual(('sendrawtransaction',[held['raw']]),chain.rpc.call_args.args)

    def test_retained_proxy_transaction_is_an_admission_rejection_not_a_fault(self):
        account='0x'+'11'*20
        record=[2,bytes.fromhex('11'*20),bytes(20),bytes(20),None,None,None,0,11,None,None,None,None,7]
        key=SimpleNamespace(script_hash=bytes(20),verification=b'\x40',sign=Mock(return_value=bytes(64)))
        def rpc(method,args):
            if method=='invokescript':return {'state':'HALT','gasconsumed':'12','minimumrequiredfee':'1000'}
            if method=='getblockcount':return 100
            if method=='sendrawtransaction':raise ValidationFailure('rpc sendrawtransaction: Inventory verification failed - Invalid')
            if method=='getrawmempool':return []
            if method=='getrawtransaction':raise ValidationFailure('rpc getrawtransaction: Unknown transaction')
            self.fail('Unexpected RPC '+method)
        chain=SimpleNamespace(magic=123,rpc=Mock(side_effect=rpc))
        driver=recovery.RecoveryTransactions(chain,account,{'executions':[],'admissionRejections':[]})
        driver.state=Mock(return_value=(record,1))
        held=driver.send('held','executeUserOp',[recovery.operation(1)],[key],proxy=True,prepare_only=True)
        self.assertEqual(2,len(held['witnesses']))
        driver.state.return_value=(copy.deepcopy(record),1);driver.state.return_value[0][8]=12
        driver.send('retained','executeUserOp',[],[],prepared=held,admission_rejection=True)
        self.assertEqual(1,key.sign.call_count)
        self.assertEqual([],driver.report['executions'])
        self.assertEqual(held['rawSha256'],driver.report['admissionRejections'][0]['retainedRawSha256'])

    def test_expected_record_only_changes_declared_fields_and_cursor(self):
        before = ([2, bytes(20), bytes([1]) * 20, bytes([2]) * 20, bytes([3]) * 20, None, None, 0, 2, None, None, None, None, 1], 7)
        after = copy.deepcopy(before); after[0][7] = 1; after[0][8] = 3
        recovery.check_transition(before, after, {7: 1, 8: 3}, 0)
        for index in (1, 2, 3, 4, 5, 12):
            wrong = copy.deepcopy(after); wrong[0][index] = b"changed"
            with self.assertRaises(ValidationFailure): recovery.check_transition(before, wrong, {7: 1, 8: 3}, 0)
        with self.assertRaises(ValidationFailure): recovery.check_transition(before, (after[0], 8), {7: 1, 8: 3}, 0)
        wrong = copy.deepcopy(after); wrong[0][7] = True
        with self.assertRaises(ValidationFailure): recovery.check_transition(before, wrong, {7: 1, 8: 3}, 0)

    def test_mutation_indices_cannot_overwrite_identity(self):
        before = ([2] + [0] * 12 + [4], 0)
        for index in (0, 1, 2, 4, -1):
            with self.assertRaises(ValidationFailure): recovery.check_transition(before, before, {index: 0}, 0)

    def test_recovery_rotates_authority_but_preserves_frozen_identity_and_nonce(self):
        record=[2,bytes(20),bytes([1])*20,bytes([2])*20,bytes([3])*20,bytes([4])*20,bytes([5])*20,1,8,None,None,None,None,3]
        before=(record,7); after=copy.deepcopy(before)
        changes={3:bytes([6])*20,5:None,6:None,8:9,13:4}
        for index,value in changes.items():after[0][index]=value
        recovery.check_transition(before,after,changes,0)
        for index,value in ((7,0),(13,3),(5,bytes([4])*20),(6,bytes([5])*20)):
            wrong=copy.deepcopy(after);wrong[0][index]=value
            with self.assertRaises(ValidationFailure):recovery.check_transition(before,wrong,changes,0)
        with self.assertRaises(ValidationFailure):recovery.check_transition((record[:13],7),after,changes,0)

    def test_joint_signers_are_distinct_and_keep_payer_order(self):
        from types import SimpleNamespace
        one = SimpleNamespace(script_hash=bytes([1]) * 20); two = SimpleNamespace(script_hash=bytes([2]) * 20)
        signers = recovery.signers_for([one, two])
        self.assertEqual("0x" + "01" * 20, signers[0]["account"])
        self.assertEqual("CalledByEntry", signers[1]["scopes"])
        for keys in ([], [one, one]):
            with self.assertRaises(ValidationFailure): recovery.signers_for(keys)


if __name__ == "__main__": unittest.main()
