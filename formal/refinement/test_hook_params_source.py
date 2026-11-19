"""Source-only controls for the complete v4 hook/validator argument view."""
import copy
from pathlib import Path
import sys
import unittest
# `formal` is a namespace package, so the package-relative imports below need the
# repository root on sys.path. Discovery run from inside this directory puts only
# this directory there, which used to turn these modules into import errors.
if str(Path(__file__).resolve().parents[2]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from formal.refinement import hook_params_source
import formal.refinement.export.test_export as export_tests


class HookParamsSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        export_tests.ExportTests.setUpClass()
        cls.inventory = export_tests.ExportTests().actual_inventory()

    @staticmethod
    def method(inventory):
        return next(m for m in inventory['source']['methods'] if m['id'] == hook_params_source.METHOD)

    @staticmethod
    def initializer(inventory):
        return HookParamsSourceTests.method(inventory)['operations'][0]['children'][0]['children'][0]['children'][0]['children'][1]

    def test_projection_retains_protocol_order_and_copy_sites(self):
        p = hook_params_source.project_method(self.inventory)
        self.assertEqual(p['viewFields'], list(hook_params_source.VIEW_FIELDS))
        self.assertEqual(p['deepCopiedFields'], [3, 12])
        self.assertEqual(p['expression'][:2], ['ENew', 'ArrayKind'])
        self.assertEqual(p['expression'][2],
                         [['EField', ['EArg', 0], index] for index in range(13)])
        self.assertEqual(hook_params_source.project_method({'source': self.inventory['source']}), p)
        rendered = hook_params_source.render_expr(p['expression'])
        self.assertEqual(rendered.count('(EField (EArg 0%nat) '), 13)
        self.assertTrue(rendered.startswith('(ENew ArrayKind ['))

    def test_reordered_actual_source_elements_are_rejected(self):
        data = copy.deepcopy(self.inventory)
        items = self.initializer(data)['children']
        items[0], items[1] = items[1], items[0]
        with self.assertRaises(hook_params_source.SourceProjectionError):
            hook_params_source.project_method(data)

    def test_missing_element_fails_closed(self):
        data = copy.deepcopy(self.inventory)
        del self.initializer(data)['children'][-1]
        with self.assertRaises(hook_params_source.SourceProjectionError):
            hook_params_source.project_method(data)

    def test_field_symbol_drift_fails_closed(self):
        data = copy.deepcopy(self.inventory)
        key = self.initializer(data)['children'][2]['children'][1]
        drifted = hook_params_source.FIELD_PREFIX + 'OpTarget'
        key['details']['symbol'] = drifted
        key['boundMetadata']['IMemberReferenceOperation.Member']['id'] = drifted
        key['boundMetadata']['IFieldReferenceOperation.Field']['id'] = drifted
        with self.assertRaises(hook_params_source.SourceProjectionError):
            hook_params_source.project_method(data)

    def test_field_index_drift_fails_closed(self):
        data = copy.deepcopy(self.inventory)
        self.initializer(data)['children'][2]['children'][1]['constant']['value']['value'] = '3'
        with self.assertRaises(hook_params_source.SourceProjectionError):
            hook_params_source.project_method(data)

    def test_non_constant_index_fails_closed(self):
        data = copy.deepcopy(self.inventory)
        self.initializer(data)['children'][2]['children'][1]['constant'] = None
        with self.assertRaises(hook_params_source.SourceProjectionError):
            hook_params_source.project_method(data)

    def test_missing_copy_at_an_array_field_fails_closed(self):
        data = copy.deepcopy(self.inventory)
        items = self.initializer(data)['children']
        items[3] = copy.deepcopy(items[2])
        with self.assertRaises(hook_params_source.SourceProjectionError):
            hook_params_source.project_method(data)

    def test_copy_at_a_scalar_field_fails_closed(self):
        data = copy.deepcopy(self.inventory)
        items = self.initializer(data)['children']
        items[4] = copy.deepcopy(items[3])
        with self.assertRaises(hook_params_source.SourceProjectionError):
            hook_params_source.project_method(data)

    def test_clone_callee_drift_fails_closed(self):
        data = copy.deepcopy(self.inventory)
        invocation = self.initializer(data)['children'][3]['children'][0]
        drifted = 'M:SmartAccount.SmartAccount.BuildCanonicalOperationView(System.Object[])'
        invocation['details']['callee'] = drifted
        invocation['boundMetadata']['IInvocationOperation.TargetMethod']['id'] = drifted
        with self.assertRaises(hook_params_source.SourceProjectionError):
            hook_params_source.project_method(data)

    def test_hidden_metadata_and_array_dimension_fail_closed(self):
        for mutation in ['metadata', 'dimension']:
            data = copy.deepcopy(self.inventory)
            creation = self.method(data)['operations'][0]['children'][0]['children'][0]['children'][0]
            if mutation == 'metadata':
                creation['unexportedMetadata'].append('UnknownArrayContract')
            else:
                creation['children'][0]['constant']['value']['value'] = '7'
            with self.assertRaises(hook_params_source.SourceProjectionError):
                hook_params_source.project_method(data)
