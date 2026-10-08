"""Native daily-limit descriptor and fail-closed storage enumeration tests."""
import base64
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import unittest
import tempfile

from neoexpress_validate import ValidationFailure
from neoexpress_native_daily_validate import DailyTransactions, build_diagnostic, storage_prefix, raw_integer, stored, validate
from neoexpress_validate import hash_le
from neoexpress_native_proxy_validate import GAS_TOKEN


def row(key, value=b'\x01'):
    return {'key':base64.b64encode(key).decode(),'value':base64.b64encode(value).decode()}


class NativeDailyTests(unittest.TestCase):
    def test_compiled_balance_fixture_values_are_checked_before_policy_tests(self):
        from neoexpress_native_daily_validate import check_balance_observation
        stacks=[{'type':'Integer','value':'-1'},{'type':'ByteString','value':'AQ=='},
                {'type':'Boolean','value':True},{'type':'Any','value':None},
                {'type':'Array','value':[{'type':'Integer','value':'0'}]}]
        for mode,value in enumerate(stacks,1):
            chain=SimpleNamespace(rpc=Mock(return_value={'state':'HALT','stack':[value],'gasconsumed':'1'}))
            self.assertEqual(mode,check_balance_observation(chain,'token','0x'+'11'*20,mode)['mode'])
        for result in ({'state':'FAULT','stack':[]},{'state':'HALT','stack':[]},
                       {'state':'HALT','stack':[stacks[0],stacks[0]]},
                       {'state':'HALT','stack':[{'type':'Integer','value':'1'}]}):
            with self.assertRaises(ValidationFailure):
                check_balance_observation(SimpleNamespace(rpc=Mock(return_value=result)),'token','0x'+'11'*20,1)

    def test_balance_fixture_manifest_requires_exact_new_abi(self):
        from neoexpress_native_daily_validate import check_balance_fixture
        methods=[{'name':name,'parameters':[{'type':t} for t in args],'returntype':result,'safe':safe}
                 for name,args,result,safe in (
                     ('balanceOf',['Hash160'],'Any',True),
                     ('storedBalanceOf',['Hash160'],'Integer',True),
                     ('setBalanceMode',['Hash160','Integer'],'Void',False),
                     ('moveAndSpoof',['Hash160','Hash160','Integer','Integer'],'Boolean',False))]
        check_balance_fixture({'abi':{'methods':methods}})
        for rows in (methods[:-1],methods+[methods[0]]):
            with self.assertRaises(ValidationFailure):check_balance_fixture({'abi':{'methods':rows}})
        for field,value in [('returntype','Integer'),('safe',False),('parameters',[{'type':'Any'}])]:
            bad=[dict(row) for row in methods];bad[0][field]=value
            with self.assertRaises(ValidationFailure):check_balance_fixture({'abi':{'methods':bad}})

    def test_diagnostic_observer_uses_raw_storage_not_hostile_balance_query(self):
        driver=DailyTransactions(None,'0x'+'11'*20,'0x'+'22'*20,'0x'+'33'*20,None,'0x'+'44'*20,{})
        driver.diagnostic_token='0x'+'55'*20
        driver.storage=Mock(return_value=[{}]*6);driver.value=Mock(return_value=0)
        with patch('neoexpress_native_daily_validate.storage_prefix',return_value={}):
            state=driver.state(driver.account)
        self.assertEqual([{}, {}, {}],state['diagnosticRaw'])
        self.assertEqual(0,state['diagnosticMode'])
        self.assertFalse(any(call.args[0]==driver.diagnostic_token for call in driver.value.call_args_list))

    def test_cross_account_isolation_excludes_shared_recipient_balance(self):
        account='0x'+'11'*20;other='0x'+'22'*20
        driver=DailyTransactions(None,account,other,'0x'+'33'*20,None,'0x'+'44'*20,{})
        driver.diagnostic_token='0x'+'55'*20
        driver.storage=Mock(return_value=[{}]*6);driver.value=Mock(return_value=0)
        with patch('neoexpress_native_daily_validate.storage_prefix',return_value={}):
            self.assertEqual([0,0],driver.state(account)['diagnosticBalances'])
            self.assertEqual([0],driver.state(other)['diagnosticBalances'])

    def test_diagnostic_build_rejects_failure_missing_artifact_and_drift(self):
        for mode in ('compiler-error','missing-manifest','drift','match'):
            count=[0]
            def compile(command,**options):
                count[0]+=1;output=Path(command[-1]);output.mkdir()
                (output/'DailyOutflowToken.nef').write_bytes(bytes([count[0] if mode=='drift' else 1]))
                if mode!='missing-manifest':(output/'DailyOutflowToken.manifest.json').write_text('{}')
                return SimpleNamespace(returncode=1 if mode=='compiler-error' else 0,stdout='',stderr='')
            with tempfile.TemporaryDirectory() as temporary, patch('neoexpress_native_daily_validate.subprocess.run',side_effect=compile):
                root=Path(temporary)
                if mode=='match':
                    retained,receipts=build_diagnostic(Path('compiler'),root,root)
                    self.assertTrue(retained.exists());self.assertEqual(receipts[0],receipts[1])
                else:
                    with self.assertRaises(ValidationFailure):build_diagnostic(Path('compiler'),root,root)

    def test_adversarial_mode_requires_explicit_tool_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);receipt=root/'receipt.json'
            with self.assertRaisesRegex(ValidationFailure,'explicit compiler and cache'):
                validate(root,root,root,root,root,receipt,adversarial=True)
            self.assertEqual('FAIL',json.loads(receipt.read_text())['status'])

    def test_fixed_counter_selects_gas_key_not_first_configured_token(self):
        account='0x'+'11'*20
        driver=DailyTransactions(None,account,'0x'+'22'*20,'0x'+'33'*20,None,None,{})
        counters=stored(account,2,raw_integer(999),token='0x'+'00'*19+'01',authority_epoch=0)
        counters.update(stored(account,2,raw_integer(7),authority_epoch=0))
        driver.storage=Mock(return_value=[{},counters,{},{},{},{}]);driver.value=Mock(return_value=None);driver.epoch=Mock(return_value=0)
        self.assertEqual(7,driver.state(account)['spent'])

    def test_raw_integer_and_exact_account_token_prefix(self):
        for value in (0,1,127,128,255,-1,-128,-129):
            encoded=raw_integer(value)
            self.assertEqual(value,int.from_bytes(encoded,'little',signed=True))
            if len(encoded)>1:self.assertNotEqual(encoded[-1:],encoded[-2:-1])
        self.assertEqual(b'',raw_integer(0))
        account='0x'+'11'*20
        for token in (GAS_TOKEN,None):
            result=stored(account,5,b'\x01',token=token,suffix=b'\x02')
            self.assertEqual(bytes([5])+hash_le(account)+(hash_le(token) if token else b'')+b'\x02',base64.b64decode(next(iter(result))))

    def test_module_storage_keys_are_tagged_and_epoch_isolated(self):
        account='0x'+'11'*20
        encoded=next(iter(stored(account,5,b'v',token=GAS_TOKEN,suffix=b'\x02',authority_epoch=7)))
        self.assertEqual(b'\xa2\x05'+hash_le(account)+(7).to_bytes(8,'little')+hash_le(GAS_TOKEN)+b'\x02',base64.b64decode(encoded))
        self.assertNotEqual(encoded,next(iter(stored(account,5,b'v',suffix=b'\x02',authority_epoch=8))))

    def test_storage_pagination_is_bounded(self):
        count=0
        def rpc(method,args):
            nonlocal count
            count+=1;item=row(b'\x01'+count.to_bytes(2,'big'))
            return {'results':[item],'next':item['key'],'truncated':True}
        with self.assertRaisesRegex(ValueError,'page bound'):
            storage_prefix(SimpleNamespace(rpc=rpc),'contract',b'\x01')

    def test_missing_provenance_invalidates_prior_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);receipt=root/'receipt.json';receipt.write_text('{"status":"PASS"}')
            with self.assertRaises(FileNotFoundError):
                validate(root/'runtime',root/'dotnet',root/'artifacts',root/'missing',root/'module',receipt)
            self.assertEqual('FAIL',json.loads(receipt.read_text())['status'])

    def test_daily_profile_is_explicit(self):
        profiles=json.loads((Path(__file__).resolve().parent.parent/'contracts/native/profiles.json').read_text())
        self.assertEqual('hook',profiles['DailyLimitHook']['role'])
        self.assertEqual(['setDailyLimit'],profiles['DailyLimitHook']['configurationMethods'])

    def test_all_pages_and_empty_prefix_are_read(self):
        a,b=row(b'\x01a'),row(b'\x01b')
        chain=SimpleNamespace(rpc=Mock(side_effect=[{'results':[a],'next':a['key'],'truncated':True},
            {'results':[b],'next':b['key'],'truncated':False}]))
        self.assertEqual({a['key']:a['value'],b['key']:b['value']},storage_prefix(chain,'contract',b'\x01'))
        self.assertEqual(['contract','AQ==',''],chain.rpc.call_args_list[0].args[1])
        self.assertEqual(['contract','AQ==',a['key']],chain.rpc.call_args_list[1].args[1])
        chain.rpc=Mock(return_value={'results':[],'next':'','truncated':False})
        self.assertEqual({},storage_prefix(chain,'contract',b'\x01'))

    def test_terminal_empty_page_preserves_the_exclusive_cursor(self):
        first=row(b'\x01a')
        chain=SimpleNamespace(rpc=Mock(side_effect=[{'results':[first],'next':first['key'],'truncated':True},
            {'results':[],'next':first['key'],'truncated':False}]))
        self.assertEqual({first['key']:first['value']},storage_prefix(chain,'contract',b'\x01'))

    def test_duplicate_backwards_and_stalled_second_pages_fail_closed(self):
        a,b,c=row(b'\x01a'),row(b'\x01b'),row(b'\x01c')
        first={'results':[b],'next':b['key'],'truncated':True}
        for second in ({'results':[b],'next':b['key'],'truncated':False},
                       {'results':[a],'next':a['key'],'truncated':False},
                       {'results':[c],'next':b['key'],'truncated':False},
                       {'results':[],'next':b['key'],'truncated':True},
                       {'results':[c],'next':c['key'],'truncated':1}):
            with self.subTest(second=second), self.assertRaises(ValidationFailure):
                storage_prefix(SimpleNamespace(rpc=Mock(side_effect=[first,second])),'contract',b'\x01')

    def test_malformed_pagination_and_foreign_keys_fail_closed(self):
        valid=row(b'\x01a');later=row(b'\x01b')
        for page in ({'results':[],'next':'','truncated':True},
                     {'results':[valid],'next':2,'truncated':False},
                     {'results':[valid],'next':True,'truncated':False},
                     {'results':[valid],'next':'@@@','truncated':False},
                     {'results':[valid],'next':later['key'],'truncated':False},
                     {'results':[row(b'\x02a')],'next':row(b'\x02a')['key'],'truncated':False},
                     {'results':[valid,valid],'next':valid['key'],'truncated':False},
                     {'results':[later,valid],'next':valid['key'],'truncated':False},
                     {'results':[{'key':'AWH=','value':'AQ=='}],'next':'AWH=','truncated':False},
                     {'results':[{'key':valid['key'],'value':'AR=='}],'next':valid['key'],'truncated':False},
                     {'results':[{}],'next':valid['key'],'truncated':False},
                     {'results':[],'next':0,'truncated':False}):
            with self.assertRaises(ValidationFailure):
                storage_prefix(SimpleNamespace(rpc=Mock(return_value=page)),'contract',b'\x01')


if __name__=='__main__':unittest.main()
