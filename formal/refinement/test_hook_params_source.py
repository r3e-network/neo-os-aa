"""Source-only controls for the complete hook parameter-array builder."""
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

    def test_projection_retains_record_layout_and_array_element_order(self):
        p = hook_params_source.project_method(self.inventory)
        self.assertEqual(p['expression'], ['ENew', 'ArrayKind', [
            ['EField', ['EArg', 0], 0], ['EField', ['EArg', 0], 1], ['EArg', 1],
            ['EField', ['EArg', 0], 3], ['EField', ['EArg', 0], 4], ['EField', ['EArg', 0], 5]]])
        self.assertEqual(len(p['recordFields']), 6)
        self.assertEqual(hook_params_source.project_method({'source': self.inventory['source']}), p)

    def test_reordered_actual_source_elements_change_projection(self):
        data = copy.deepcopy(self.inventory)
        m = next(m for m in data['source']['methods'] if '.BuildHookOperationParams(' in m['id'])
        initializer = m['operations'][0]['children'][0]['children'][0]['children'][0]['children'][1]
        initializer['children'][0], initializer['children'][1] = initializer['children'][1], initializer['children'][0]
        self.assertNotEqual(hook_params_source.project_method(data)['expression'],
                            hook_params_source.project_method(self.inventory)['expression'])

    def test_hidden_metadata_and_array_dimension_fail_closed(self):
        for mutation in ['metadata', 'dimension']:
            data = copy.deepcopy(self.inventory)
            m = next(m for m in data['source']['methods'] if '.BuildHookOperationParams(' in m['id'])
            creation = m['operations'][0]['children'][0]['children'][0]['children'][0]
            if mutation == 'metadata': creation['unexportedMetadata'].append('UnknownArrayContract')
            else: creation['children'][0]['constant']['value']['value'] = '7'
            with self.assertRaises(hook_params_source.SourceProjectionError): hook_params_source.project_method(data)
