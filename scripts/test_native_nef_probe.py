"""The bytecode probe is a separate, provenance-checked local validation target."""
import importlib
import json
from pathlib import Path
import tempfile
import unittest
from copy import deepcopy
from unittest.mock import patch
from types import SimpleNamespace


class NativeNefProbeTests(unittest.TestCase):
    def test_missing_post_phase_vectors_are_not_success(self):
        module = importlib.import_module('native_nef_probe')
        sample = self.sample()
        sample.pop('allVmTypesPreAndPostVerified', None)
        with self.assertRaises(ValueError):
            module.check_result(sample)

    def test_missing_probe_sources_fail_before_build(self):
        module = importlib.import_module('native_nef_probe')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = root / 'build.json'; receipt.write_text('{}')
            with patch.object(module, 'check_runtime_receipt'), patch.object(module, 'check_module_build', return_value={}), \
                 patch.object(Path, 'glob', return_value=[]):
                with self.assertRaisesRegex(ValueError, 'four probe source files'):
                    module.validate(root, root, receipt, receipt, root / 'out.json')

    def test_relative_module_path_reaches_toolchain_validation(self):
        import os
        module = importlib.import_module('native_nef_probe')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = root / 'build.json'; receipt.write_text('{}')
            with patch.object(module, '__file__', os.path.relpath(module.__file__)), \
                 patch.object(module, 'check_runtime_receipt'), patch.object(module, 'check_module_build', return_value={}), \
                 patch.object(module.shutil, 'which', return_value=None):
                with self.assertRaisesRegex(RuntimeError, 'local dotnet SDK'):
                    module.validate(root, root, receipt, receipt, root / 'out.json')

    def sample(self):
        kinds = ['zero', 'positive', 'negative', 'boolean', 'bytes', 'null', 'array', 'struct', 'map', 'buffer', 'pointer', 'interop']
        labels = ['missing-snapshot-injection', 'positive-after-snapshot-fault', 'remove-hook-confirm', 'update-confirm-same-artifact'] + ['pre-balance-' + kind for kind in kinds]
        shapes = ['short-array', 'integer-target', 'short-target', 'buffer-target']
        labels += ['post-balance-' + kind for kind in kinds] + ['callback-' + kind for kind in shapes]
        labels += ['direct-config-denied', 'direct-pre-denied', 'direct-post-denied', 'direct-cleanup-denied',
                   'positive-after-post-type-faults', 'positive-after-callback-faults']
        types = ['Integer', 'Integer', 'Integer', 'Boolean', 'ByteString', 'Any', 'Array', 'Struct', 'Map', 'Buffer', 'Pointer', 'InteropInterface']
        sample = {'status': 'PASS', 'publicNetworksTouched': False, 'faultInjectionCount': 1,
                  'staleSnapshotRemovalAndIsolation': True, 'staleSnapshotCleanupAndIsolation': True,
                  'administrationAndIdenticalArtifactUpdate': True,
                  'allVmTypesPreAndPostVerified': True, 'directPhaseAndMalformedCallbacksVerified': True,
                  'productionArtifacts': {'TokenRestrictedHook.nef': 'a' * 64, 'TokenRestrictedHook.manifest.json': 'b' * 64},
                  'collectorControls': ['both-directions', 'fault-before-completion', 'coincident-successor', 'all-conditional-opcodes'],
                  'balanceTypes': [{'kind': kind, 'vmType': vm_type} for kind, vm_type in zip(kinds, types)],
                  'postBalanceTypes': [{'kind': kind, 'vmType': vm_type, 'injections': 1} for kind, vm_type in zip(kinds, types)],
                  'malformedCallbackCases': [{'kind': kind, 'injections': 1} for kind in shapes],
                  'cases': [{'label': label, 'vmState': 'HALT', 'expectedFault': None} for label in labels] +
                           [{'label': 'expected-fault', 'vmState': 'FAULT', 'expectedFault': 'reason', 'wholeStoreRollbackChecked': True}],
                  'coverage': {'instructionCount': 10, 'attemptedInstructions': 9, 'missingInstructionOffsets': [8],
                               'conditionalEdges': 4, 'completedConditionalEdges': 3, 'missingConditionalEdges': [{'from': 0, 'to': 8}],
                               'sourceLineCoverageMeasured': False, 'fullRefinementProven': False}}
        for case in sample['cases']:
            label = case['label']
            if label == 'missing-snapshot-injection' or (label.startswith('pre-balance-') and label not in ('pre-balance-zero', 'pre-balance-positive')):
                case.update(vmState='FAULT', expectedFault='Missing restricted balance snapshot' if label == 'missing-snapshot-injection' else 'Invalid restricted token balance', wholeStoreRollbackChecked=True)
            if label.startswith('post-balance-') and label != 'post-balance-positive':
                case.update(vmState='FAULT', expectedFault='Restricted token outflow (incl. via intermediary) is forbidden' if label == 'post-balance-zero' else 'Invalid restricted token balance', wholeStoreRollbackChecked=True)
            if label.startswith('callback-') or label.startswith('direct-'):
                case.update(vmState='FAULT', expectedFault='Invalid native operation shape' if label.startswith('callback-') else 'Missing native module invocation context', wholeStoreRollbackChecked=True)
        return sample

    def test_phase_matrix_rejects_missing_duplicate_wrong_type_or_wrong_reason(self):
        module = importlib.import_module('native_nef_probe')
        for field in ['balanceTypes', 'postBalanceTypes', 'malformedCallbackCases']:
            for mutation in ['delete', 'duplicate', 'type', 'injection']:
                if (field == 'balanceTypes' and mutation == 'injection') or (field == 'malformedCallbackCases' and mutation == 'type'):
                    continue
                broken = self.sample()
                if mutation == 'delete': broken[field].pop()
                if mutation == 'duplicate': broken[field][-1] = deepcopy(broken[field][0])
                if mutation == 'type': broken[field][0]['vmType'] = 'Boolean'
                if mutation == 'injection': broken[field][0]['injections'] = 2
                with self.subTest(field=field, mutation=mutation), self.assertRaises(ValueError):
                    module.check_result(broken)
        for label in ['post-balance-zero', 'post-balance-null', 'callback-short-target', 'direct-pre-denied']:
            broken = self.sample()
            next(case for case in broken['cases'] if case['label'] == label)['expectedFault'] = 'unrelated error'
            with self.subTest(label=label), self.assertRaises(ValueError): module.check_result(broken)

    def test_result_shape_and_negative_controls(self):
        module = importlib.import_module('native_nef_probe')
        sample = self.sample()
        module.check_result(sample)
        for field, value in [('vmState', 'HALT'), ('expectedFault', 'unrelated rejection')]:
            broken = deepcopy(sample); broken['cases'][0][field] = value
            with self.assertRaises(ValueError): module.check_result(broken)

        for key in ['productionArtifacts', 'collectorControls', 'balanceTypes', 'cases', 'coverage']:
            broken = deepcopy(sample); del broken[key]
            with self.assertRaises(ValueError): module.check_result(broken)
        for field, value in [('instructionCount', 0), ('attemptedInstructions', 11), ('missingConditionalEdges', []),
                             ('sourceLineCoverageMeasured', True), ('fullRefinementProven', True)]:
            broken = deepcopy(sample); broken['coverage'][field] = value
            with self.assertRaises(ValueError): module.check_result(broken)
        for field, value in [('vmState', 'BREAK'), ('expectedFault', None), ('wholeStoreRollbackChecked', False)]:
            broken = deepcopy(sample); broken['cases'][-1][field] = value
            with self.assertRaises(ValueError): module.check_result(broken)

    def test_launcher_success_and_fail_closed_controls(self):
        module = importlib.import_module('native_nef_probe')
        for mode, reason in [('success', None), ('build', 'build failed'), ('execute', 'execution failed'),
                             ('artifact', 'artifact differs'), ('missing-assembly', 'Missing loaded'),
                             ('assembly', 'assembly differs'), ('source', 'inputs changed'), ('receipt', 'receipts changed')]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                for name in ['Neo.dll', 'Neo.VM.dll']:
                    (root / name).write_bytes(name.encode())
                receipt = root / 'build.json'; receipt.write_text('{}')
                report = self.sample()
                pins = dict(report['productionArtifacts'])
                original_hash = module.sha256
                completed = [False]
                build_output = [None]

                def run(command, **options):
                    if command[1] == 'build':
                        build_output[0] = Path(command[command.index('-o') + 1]); build_output[0].mkdir()
                        (build_output[0] / 'NativeModuleProbe.dll').write_bytes(b'unit-test-only-executable')
                        code = 1 if mode == 'build' else 0
                    else:
                        report['loadedAssemblies'] = {name: original_hash(root / name) for name in ['Neo.dll', 'Neo.VM.dll']}
                        report['loadedAssemblies']['NativeModuleProbe.dll'] = original_hash(build_output[0] / 'NativeModuleProbe.dll')
                        if mode == 'artifact': report['productionArtifacts']['TokenRestrictedHook.nef'] = 'c' * 64
                        if mode == 'missing-assembly': del report['loadedAssemblies']['Neo.dll']
                        if mode == 'assembly': report['loadedAssemblies']['Neo.dll'] = 'd' * 64
                        Path(command[-1]).write_text(json.dumps(report))
                        completed[0] = True
                        code = 1 if mode == 'execute' else 0
                    return SimpleNamespace(returncode=code, stdout='', stderr='')

                def digest(path):
                    if completed[0] and ((mode == 'receipt' and path == receipt) or (mode == 'source' and path.name == 'native_nef_probe.py')):
                        return 'e' * 64
                    return original_hash(path)

                with patch.object(module, 'check_runtime_receipt'), patch.object(module, 'check_module_build', return_value=pins), \
                     patch.object(module.shutil, 'which', return_value='dotnet'), patch.object(module.subprocess, 'run', side_effect=run), \
                     patch.object(module, 'sha256', side_effect=digest):
                    output = root / 'out.json'
                    if reason:
                        with self.assertRaisesRegex((RuntimeError, ValueError), reason):
                            module.validate(root, root, receipt, receipt, output)
                        self.assertEqual('FAIL', json.loads(output.read_text())['status'])
                    else:
                        self.assertEqual('PASS', module.validate(root, root, receipt, receipt, output)['status'])

    def test_incomplete_probe_success_is_rejected(self):
        module = importlib.import_module('native_nef_probe')
        for report in ({}, {'status': 'PASS', 'publicNetworksTouched': False},
                       {'status': 'PASS', 'publicNetworksTouched': True}):
            with self.assertRaises(ValueError):
                module.check_result(report)

    def test_missing_provenance_invalidates_earlier_success(self):
        module = importlib.import_module('native_nef_probe')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'receipt.json'
            output.write_text('{"status":"PASS"}')
            with self.assertRaises(FileNotFoundError):
                module.validate(root, root, root / 'runtime.json', root / 'modules.json', output)
            self.assertEqual('FAIL', json.loads(output.read_text())['status'])

    def test_runtime_project_requires_explicit_local_assemblies(self):
        import xml.etree.ElementTree as ET
        root = Path(__file__).resolve().parent.parent
        project = ET.parse(root / 'tests/NativeModuleProbe/NativeModuleProbe.csproj')
        self.assertEqual([], project.findall('.//PackageReference'))
        self.assertTrue(any('NativeRuntimeDirectory' in item.attrib.get('Include', '') for item in project.findall('.//Reference')))
        self.assertTrue(project.findall('.//Error'))


if __name__ == '__main__':
    unittest.main()
