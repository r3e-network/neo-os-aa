"""Adversarial structural closure tests; no theorem is inferred from green tests."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


decoder = load('nef_decode')


def fixture(script='103403401140', ranges=((0, 3), (4, 5))):
    raw = bytes.fromhex(script)
    methods, sources, abi = [], [], []
    for index, (start, last) in enumerate(ranges):
        name = chr(65 + index)
        descriptor = dict(name=name.lower(), parameters=[], returntype='Integer', offset=start, safe=True)
        methods.append(dict(id='C.' + name + '()', range=f'{start}-{last}', abi=descriptor))
        sources.append(dict(id='M:C.' + name, displayName='C.' + name + '()', origin='repository-source',
                            location=dict(path='/fixture/C.cs', startLine=index + 1), operations=[], exportIssue=None))
        abi.append(descriptor)
    return dict(nef=dict(scriptHex=script, scriptSha256=hashlib.sha256(raw).hexdigest(), sha256='0'*64,
                         tokens=[], instructions=decoder.decode_script(raw, 0)), manifest=dict(methods=abi),
                sourceMap=dict(exactByteMatch=True, exactManifestMatch=True, debug=dict(methods=methods)),
                source=dict(methods=sources), inputs={'/fixture/C.cs': '1'*64})


class ClosureTests(unittest.TestCase):
    def setUp(self):
        self.module = load('entrypoint_inventory')

    def test_every_instruction_and_static_call_accounted(self):
        result = self.module.build_entrypoint_inventory(fixture())
        self.assertEqual(result['instructionCount'], 5)
        self.assertEqual(result['entrypoints'][0]['byteDependencyStarts'], [0, 4])
        self.assertEqual(result['fullUnprovedCount'], 2)
        self.assertFalse(result['implementationVerified'])

    def test_omitted_edge_fails(self):
        data = fixture()
        data['nef']['instructions'][1]['edges'] = []
        with self.assertRaisesRegex(ValueError, 'independent instruction'):
            self.module.build_entrypoint_inventory(data)

    def test_wrong_valid_entry_fails(self):
        data = fixture()
        data['manifest']['methods'][0] = dict(data['manifest']['methods'][0], offset=4)
        with self.assertRaisesRegex(ValueError, 'ABI'):
            self.module.build_entrypoint_inventory(data)

    def test_entry_inside_operand_fails(self):
        data = fixture()
        data['manifest']['methods'][0] = dict(data['manifest']['methods'][0], offset=2)
        with self.assertRaises(ValueError):
            self.module.build_entrypoint_inventory(data)

    def test_unknown_indirect_call_is_explicit_and_blocks_claim(self):
        result = self.module.build_entrypoint_inventory(fixture('364040', ((0, 1),)))
        self.assertEqual(result['indirectCalls'], [{'offset': 0, 'kind': 'unresolved-indirect-call', 'target': None}])
        self.assertTrue(any('indirect' in key for key in result['entrypoints'][0]['unclosedDependencies']))
        self.assertEqual(result['unmappedRanges'][0]['reachability'], 'unknown-indirect-call')
        with self.assertRaisesRegex(ValueError, 'unclosed'):
            self.module.require_closed_entrypoint(result, 'a/0')

    def test_omit_indirect_gap_fails(self):
        data = fixture('3640', ((0, 1),))
        data['nef']['instructions'][0]['edges'][0]['target'] = 1
        with self.assertRaises(ValueError):
            self.module.build_entrypoint_inventory(data)

    def test_cfg_loop_and_call_scc(self):
        result = self.module.build_entrypoint_inventory(fixture('1022ff40', ((0, 3),)))
        self.assertEqual(result['controlFlowLoops'], [[0, 1]])
        result = self.module.build_entrypoint_inventory(fixture('103403401034fb40', ((0, 3), (4, 7))))
        self.assertEqual(result['callCycles'], [[0, 4]])

    def test_unmapped_branch_target_is_reachable(self):
        result = self.module.build_entrypoint_inventory(fixture('220240', ((0, 1),)))
        self.assertEqual(result['unmappedRanges'][0]['reachability'], 'structurallyReachable')

    def test_pointer_target_is_conservative_root(self):
        result = self.module.build_entrypoint_inventory(fixture('0a060000004040', ((0, 5),)))
        self.assertEqual(result['addressTakenRoots'], [6])
        self.assertEqual(result['unmappedRanges'][0]['reachability'], 'structurallyReachable')

    def test_orphan_only_structurally_unreachable(self):
        result = self.module.build_entrypoint_inventory(fixture('114040', ((0, 1),)))
        self.assertEqual(result['unmappedRanges'][0]['reachability'], 'structurallyUnreachable')
        self.assertFalse(result['unmappedRanges'][0]['semanticDead'])

    def test_typed_source_and_snapshot_membership_required(self):
        data = fixture()
        del data['inputs']['/fixture/C.cs']
        with self.assertRaisesRegex(ValueError, 'source input'):
            self.module.build_entrypoint_inventory(data)
        data = fixture()
        data['source']['methods'][0]['displayName'] = 'C.Wrong()'
        with self.assertRaisesRegex(ValueError, 'typed source'):
            self.module.build_entrypoint_inventory(data)

    def test_overlap_or_partial_range_fails(self):
        for text in ('0-4', '0-1'):
            data = fixture()
            data['sourceMap']['debug']['methods'][0]['range'] = text
            with self.assertRaises(ValueError):
                self.module.build_entrypoint_inventory(data)

    def test_forged_opcode_or_size_fails(self):
        for field, value in (('name', 'RET'), ('size', 1)):
            data = fixture()
            data['nef']['instructions'][1][field] = value
            with self.assertRaises(ValueError):
                self.module.build_entrypoint_inventory(data)

    def test_source_calls_and_loop_inventory(self):
        data = fixture()
        data['source']['methods'][0]['operations'] = [{'kind': 'Loop', 'details': {}, 'children': [
            {'kind': 'Invocation', 'details': {'callee': 'M:C.B'}, 'children': []}]}]
        result = self.module.build_entrypoint_inventory(data)
        self.assertEqual(result['sourceMethods'][0]['calls'], ['M:C.B'])
        self.assertEqual(result['sourceMethods'][0]['loopCount'], 1)

    def test_source_less_manifest_initializer_stays_open(self):
        data = fixture('114040', ((0, 1),))
        data['manifest']['methods'].append(dict(name='_initialize', offset=2, parameters=[], returntype='Void', safe=False))
        result = self.module.build_entrypoint_inventory(data)
        self.assertEqual(result['entrypoints'][1]['sourceMethod'], None)
        self.assertEqual(result['unmappedRanges'][0]['reachability'], 'structurallyReachable')
        self.assertEqual(result['fullUnprovedCount'], 2)

    def test_initializer_is_shared_full_scope_dependency(self):
        data = fixture('114040', ((0, 1),))
        data['manifest']['methods'].append(dict(name='_initialize', offset=2, parameters=[], returntype='Void', safe=False))
        result = self.module.build_entrypoint_inventory(data)
        self.assertEqual(result['entrypoints'][0]['initializationDependencyStarts'], [2])
        self.assertIn('byte:2', result['entrypoints'][0]['unclosedDependencies'])
        self.assertIn('source:unmapped:2', result['entrypoints'][0]['unclosedDependencies'])

    def test_source_metadata_gap_remains_open(self):
        data = fixture()
        data['source']['methods'][0]['operations'] = [
            {'kind': 'DynamicInvocation', 'unexportedMetadata': ['Dynamic.Arguments'], 'children': []}]
        result = self.module.build_entrypoint_inventory(data)
        self.assertEqual(result['sourceMethods'][0]['unresolvedInvocationCount'], 1)
        self.assertIn('source-export-gap:M:C.A', result['entrypoints'][0]['unclosedDependencies'])

    def test_transitive_source_call_not_equated_with_byte_calls(self):
        data = fixture('11401240', ((0, 1), (2, 3)))
        data['source']['methods'][0]['operations'] = [
            {'kind': 'Invocation', 'details': {'callee': 'M:C.B'}, 'children': []}]
        data['source']['methods'][1]['operations'] = [
            {'kind': 'Invocation', 'details': {'callee': 'M:External.Unknown'}, 'children': []}]
        result = self.module.build_entrypoint_inventory(data)
        self.assertEqual(result['entrypoints'][0]['byteDependencyStarts'], [0])
        self.assertEqual(result['entrypoints'][0]['sourceDependencyMethods'], ['M:C.A', 'M:C.B', 'M:External.Unknown'])
        self.assertIn('source:M:External.Unknown', result['entrypoints'][0]['unclosedDependencies'])

    def test_large_graph_does_not_use_recursive_dfs(self):
        graph = {i: {i+1} for i in range(9000)}
        graph[9000] = {8999}
        self.assertEqual(self.module.cyclic_components(graph), [[8999, 9000]])

    def test_edited_flags_or_body_receipt_cannot_establish_full_closure(self):
        result = self.module.build_entrypoint_inventory(fixture())
        result['entrypoints'][0]['unclosedDependencies'] = []
        result['entrypoints'][0]['bodyScopedEvidence'] = [{'regionProved': True}]
        result['entrypoints'][0]['fullEntrypointVerified'] = True
        with self.assertRaisesRegex(ValueError, 'cannot authenticate'):
            self.module.require_closed_entrypoint(result, 'a/0')
        self.assertEqual(result['fullUnprovedCount'], 2)

    def test_initializer_effects_explicit_in_full_scope_only(self):
        data = fixture('1140560140', ((0, 1),))
        data['manifest']['methods'].append(dict(name='_initialize', offset=2, parameters=[], returntype='Void', safe=False))
        result = self.module.build_entrypoint_inventory(data)
        entry = result['entrypoints'][0]
        self.assertEqual(entry['bodyStaticFieldEffects'], [])
        self.assertEqual(len(entry['initializationStaticFieldEffects']), 1)
        self.assertEqual(len(entry['staticFieldEffects']), 1)
        self.assertIn('static:2', entry['unclosedDependencies'])
        self.assertTrue(result['pureCandidates'])


if __name__ == '__main__':
    unittest.main()
