"""Fail-closed checks for the actual native module integration matrix."""
import copy
import unittest
import base64
import hashlib
import tempfile
from pathlib import Path
import json
from unittest.mock import patch
from neoexpress_validate import ValidationFailure
from neoexpress_native_modules_validate import module_signers, check_outcome, nef_from_rpc, check_module_build, validate

class Key:
    def __init__(self, value): self.script_hash = bytes([value]) * 20

class NativeModuleMatrixTests(unittest.TestCase):
    def test_configuration_clears_only_pending_fields_and_preserves_authority_epoch(self):
        from neoexpress_native_modules_validate import commit_config
        record=[2,bytes(20),bytes(20),bytes(20),None,None,None,0,11,'verifier','hook','address','recovery',7]
        state=[record,3,'verifier-call','hook-call',None,0,False]
        commit_config(state)
        self.assertEqual(14,len(state[0]));self.assertEqual(7,state[0][13]);self.assertEqual(12,state[0][8])
        self.assertEqual([None]*4,state[0][9:13]);self.assertEqual([None,None],state[2:4]);self.assertEqual(3,state[1])

    def test_artifact_roster_tracks_explicit_profiles(self):
        root=Path(__file__).resolve().parent.parent
        profiles=json.loads((root/'contracts/native/profiles.json').read_text())
        pins={n+s:'pinned' for n in profiles for s in ('.nef','.manifest.json')}
        pins['native-profile-packaging.json']='pinned'
        receipt={'schema':'smartaccount-native-module-build/v2','sourceRoot':'repository','restoreLockedMode':True,'packageSourcesPolicy':'nuget.config','status':'PASS','reproducible':True,'builds':[pins,pins],
                 'sourceSha256':{'contracts/native/profiles.json':'pinned'},'recipeSha256':'pinned','packagingRecipeSha256':'pinned'}
        with patch('neoexpress_native_modules_validate.sha256',return_value='pinned'), patch('neoexpress_native_modules_validate.collect_inputs', return_value=(profiles, receipt['sourceSha256'])):
            self.assertEqual(pins,check_module_build(receipt,root/'artifacts',root/'contracts'))
            for key, value in [('schema', 'smartaccount-native-module-build/v1'), ('sourceRoot', 'contracts'), ('restoreLockedMode', False), ('packageSourcesPolicy', 'offline')]:
                wrong = copy.deepcopy(receipt); wrong[key] = value
                with self.assertRaises(ValidationFailure): check_module_build(wrong, root/'artifacts', root/'contracts')
            wrong = copy.deepcopy(receipt); wrong['sourceSha256']['Directory.Build.props'] = 'unexpected'
            with self.assertRaises(ValidationFailure): check_module_build(wrong, root/'artifacts', root/'contracts')

    def test_missing_provenance_invalidates_previous_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); output=root/'receipt.json';output.write_text('{"status":"PASS"}')
            with self.assertRaises(FileNotFoundError):
                validate(root/'runtime',root/'dotnet',root/'artifacts',root/'missing-build',root/'missing-module',output)
            self.assertEqual('FAIL',json.loads(output.read_text())['status'])

    def test_full_rpc_nef_roundtrip_and_metadata_tampering(self):
        body=b'NEF3'+b'compiler'.ljust(64,b'\0')+bytes(5)+b'\x01\x40'
        checksum=hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
        value={'magic':int.from_bytes(b'NEF3','little'),'compiler':'compiler','source':'','tokens':[],
               'script':base64.b64encode(b'\x40').decode(),'checksum':int.from_bytes(checksum,'little')}
        self.assertEqual(body+checksum,nef_from_rpc(value))
        for field,changed in [('compiler','changed'),('magic',0),('source','changed'),('script','AA==')]:
            wrong=dict(value);wrong[field]=changed
            with self.assertRaises(ValidationFailure):nef_from_rpc(wrong)

    def test_empty_artifact_certificate_is_not_a_success(self):
        with self.assertRaises(ValidationFailure):
            check_module_build({'status':'PASS','reproducible':True,'builds':[{},{}]}, None, None)

    def test_threshold_signers_have_explicit_context_rules(self):
        signers = module_signers([Key(1), Key(2)], True)
        self.assertEqual(2, len(signers))
        self.assertEqual('WitnessRules', signers[0]['scopes'])
        self.assertEqual('CalledByContract', signers[0]['rules'][0]['condition']['expressions'][0]['type'])
        self.assertEqual('CalledByEntry', module_signers([Key(1)], False)[0]['scopes'])
        for keys in ([], [Key(1), Key(1)]):
            with self.assertRaises(ValidationFailure): module_signers(keys, True)

    def test_halt_requires_exact_result_and_event_set(self):
        execution = {'vmstate':'HALT','stack':[{'type':'Boolean','value':False}],'notifications':[]}
        check_outcome(execution, False, None, None)
        for mutation in ('result','state','event'):
            wrong = copy.deepcopy(execution)
            if mutation == 'result': wrong['stack'][0] = {'type':'Integer','value':'0'}
            if mutation == 'state': wrong['vmstate'] = 'FAULT'
            if mutation == 'event': wrong['notifications'] = [{}]
            with self.assertRaises(ValidationFailure): check_outcome(wrong, False, None, None)

    def test_fault_requires_exact_reason_and_no_events(self):
        execution = {'vmstate':'FAULT','exception':'assert: Missing native module invocation context','notifications':[]}
        check_outcome(execution, None, None, 'Missing native module invocation context')
        for field, value in [('vmstate','HALT'),('exception','out of gas'),('notifications',[{}])]:
            wrong = dict(execution); wrong[field] = value
            with self.assertRaises(ValidationFailure): check_outcome(wrong, None, None, 'Missing native module invocation context')

if __name__ == '__main__': unittest.main()
