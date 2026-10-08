"""Fail-closed checks for the actual native module integration matrix."""
import copy
from contextlib import contextmanager
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
    def test_native_domain_storage_is_ordered_packed_bytes_in_its_current_epoch(self):
        from types import SimpleNamespace
        from neoexpress_native_modules_validate import native_signer_domain_storage, ModuleTransactions
        signers=['0x'+'11'*20,'0x'+'22'*20]
        packed=bytes.fromhex('a9e187375f6dadfc954c886fcb17f2bdd82c3351f15e3aee841ab930ca915ea6'
                             'd1992bd3f48b45f3778dc368ac6020235b3e9c9e6c485c8004feb51fcaa75c23')
        self.assertEqual(base64.b64encode(packed).decode(),native_signer_domain_storage(signers))
        self.assertNotEqual(native_signer_domain_storage(signers),native_signer_domain_storage(signers[::-1]))
        for bad in ([],signers*6,[signers[0]]*2):
            with self.assertRaises(ValidationFailure):native_signer_domain_storage(bad)
        calls=[]
        def rpc(method,args):calls.append((method,args));return base64.b64encode(packed).decode()
        driver=ModuleTransactions(SimpleNamespace(rpc=rpc),'account','other','verifier','hook',{})
        self.assertEqual(base64.b64encode(packed).decode(),driver.signer_domain_storage(signers[0],7))
        self.assertEqual([('getstorage',['verifier',base64.b64encode(bytes.fromhex('a203'+'11'*20+'0700000000000000')).decode()])],calls)

    def test_configuration_clears_only_pending_fields_and_preserves_authority_epoch(self):
        from neoexpress_native_modules_validate import commit_config
        record=[2,bytes(20),bytes(20),bytes(20),None,None,None,0,11,'verifier','hook','address','recovery',7]
        state=[record,3,'verifier-call','hook-call',None,0,False]
        commit_config(state)
        self.assertEqual(14,len(state[0]));self.assertEqual(7,state[0][13]);self.assertEqual(12,state[0][8])
        self.assertEqual([None]*4,state[0][9:13]);self.assertEqual([None,None],state[2:4]);self.assertEqual(3,state[1])

    @contextmanager
    def module_fixture(self):
        from native_module_profile import package
        from test_native_module_profile import manifest
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); contracts = root / 'contracts'; (contracts / 'native').mkdir(parents=True)
            parameters = root / 'docs/proposals/smartaccount-native-profile-v2-parameters.json'
            parameters.parent.mkdir(parents=True)
            parameters.write_bytes((Path(__file__).resolve().parent.parent / parameters.relative_to(root)).read_bytes())
            profiles = {'NeoNativeVerifier': {'project': 'NeoNativeVerifier.Native.csproj', 'role': 'verifier',
                'configurationMethods': ['setConfig'], 'compositeVerifier': False}}
            descriptor = contracts / 'native/profiles.json'; descriptor.write_text(json.dumps(profiles))
            raw = root / 'raw'; raw.mkdir(); artifacts = root / 'artifacts'
            body = b'NEF3' + bytes(64) + bytes(5) + b'\x01\x40'
            (raw / 'NeoNativeVerifier.nef').write_bytes(body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4])
            (raw / 'NeoNativeVerifier.manifest.json').write_text(json.dumps(manifest()))
            package(raw, artifacts, descriptor, parameters)
            source_pins = {n: hashlib.sha256((root / n).read_bytes()).hexdigest() for n in
                ('contracts/native/profiles.json', 'docs/proposals/smartaccount-native-profile-v2-parameters.json')}
            scripts = Path(__file__).parent
            receipt = {'schema': 'smartaccount-native-module-build/v2', 'sourceRoot': 'repository',
                'restoreLockedMode': True, 'packageSourcesPolicy': 'nuget.config', 'status': 'PASS', 'reproducible': True,
                'sourceSha256': source_pins, 'recipeSha256': hashlib.sha256((scripts / 'build_native_modules.py').read_bytes()).hexdigest(),
                'packagingRecipeSha256': hashlib.sha256((scripts / 'native_module_profile.py').read_bytes()).hexdigest()}
            def repin():
                pins = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in artifacts.iterdir()}
                receipt['builds'] = [pins, dict(pins)]
                return pins
            repin()
            with patch('neoexpress_native_modules_validate.collect_inputs', return_value=(profiles, source_pins)):
                yield receipt, artifacts, contracts, repin

    def test_artifact_roster_tracks_explicit_profiles(self):
        with self.module_fixture() as (receipt, artifacts, contracts, repin):
            self.assertEqual(receipt['builds'][0], check_module_build(receipt, artifacts, contracts))
            for key, value in [('schema', 'smartaccount-native-module-build/v1'), ('sourceRoot', 'contracts'),
                    ('restoreLockedMode', False), ('packageSourcesPolicy', 'offline')]:
                wrong = copy.deepcopy(receipt); wrong[key] = value
                with self.assertRaises(ValidationFailure): check_module_build(wrong, artifacts, contracts)
            wrong = copy.deepcopy(receipt); wrong['sourceSha256']['Directory.Build.props'] = 'unexpected'
            with self.assertRaises(ValidationFailure): check_module_build(wrong, artifacts, contracts)

    def test_self_consistent_artifact_hashes_do_not_admit_stale_profile(self):
        for field, value in [('profileDigest', '00' * 32), ('profileParametersSha256', '00' * 32),
                ('descriptorSha256', '00' * 32), ('recipeSha256', '00' * 32), ('nefRewritten', True), ('status', 'FAIL')]:
            with self.subTest(field=field), self.module_fixture() as (receipt, artifacts, contracts, repin):
                path = artifacts / 'native-profile-packaging.json'; cert = json.loads(path.read_text())
                cert[field] = value; path.write_text(json.dumps(cert)); repin()
                with self.assertRaises(ValidationFailure): check_module_build(receipt, artifacts, contracts)

    def test_forged_packaged_metadata_rejected_even_with_rehashed_receipt(self):
        for field, value in [('profileDigest', '00' * 32), ('compositeVerifier', 0),
                ('compositeVerifier', True), ('abiVersion', 1), ('configurationMethods', ['postExecute'])]:
            with self.subTest(field=field, value=value), self.module_fixture() as (receipt, artifacts, contracts, repin):
                path = artifacts / 'NeoNativeVerifier.manifest.json'; manifest = json.loads(path.read_text())
                manifest['extra']['smartAccount'][field] = value; path.write_text(json.dumps(manifest))
                cert_path = artifacts / 'native-profile-packaging.json'; cert = json.loads(cert_path.read_text())
                cert['artifacts']['NeoNativeVerifier']['packagedManifestSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                cert_path.write_text(json.dumps(cert)); repin()
                with self.assertRaises(ValidationFailure): check_module_build(receipt, artifacts, contracts)

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
