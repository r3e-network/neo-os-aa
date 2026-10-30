"""Actual typed source controls for public pure methods."""
import copy
import json
from pathlib import Path
import sys
import unittest
# `formal` is a namespace package, so the package-relative imports below need the
# repository root on sys.path. Discovery run from inside this directory puts only
# this directory there, which used to turn these modules into import errors.
if str(Path(__file__).resolve().parents[2]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from formal.refinement import public_source

import formal.refinement.export.test_export as export_tests


class PublicSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        export_tests.ExportTests.setUpClass()
        cls.inventory = export_tests.ExportTests().actual_inventory()

    def test_source_projection_has_three_complete_returns(self):
        projections = public_source.project_methods(self.inventory)
        self.assertEqual(set(projections), {'getAccountImplementationId', 'supportsExecutionMode', 'supportsModuleType'})
        self.assertEqual(projections['getAccountImplementationId']['expression'][0], 'PBytes')
        self.assertEqual(projections['supportsExecutionMode']['expression'][0], 'POr')
        self.assertEqual(projections['supportsModuleType']['expression'][0], 'POr')
        stripped = {'source': self.inventory['source']}
        self.assertEqual(public_source.project_methods(stripped), projections)

    def test_unmodeled_metadata_or_type_fail_closed(self):
        for mutation in ('type', 'metadata', 'parameter'):
            data = copy.deepcopy(self.inventory)
            method = next(m for m in data['source']['methods'] if '.SupportsExecutionMode(' in m['id'])
            expression = method['operations'][0]['children'][0]['children'][0]['children'][0]
            if mutation == 'type': expression['type'] = 'int'
            elif mutation == 'metadata': expression['boundMetadata']['unexpected'] = True
            else: method['parameters'][0]['refKind'] = 'Ref'
            with self.assertRaises(public_source.SourceProjectionError): public_source.project_methods(data)

    def test_typed_literal_mutation_changes_source_program(self):
        data = copy.deepcopy(self.inventory)
        method = next(m for m in data['source']['methods'] if '.SupportsExecutionMode(' in m['id'])
        def walk(node):
            yield node
            for child in node['children']: yield from walk(child)
        literal = next(n for n in walk(method['operations'][0]) if n['kind'] == 'Literal')
        literal['constant']['value']['value'] = 'mutated'
        self.assertNotEqual(public_source.project_methods(data), public_source.project_methods(self.inventory))

    def test_constant_field_and_reference_must_agree(self):
        data = copy.deepcopy(self.inventory)
        for type_ in data['source']['types']:
            for field in type_['fields']:
                if field['name'] == 'AccountImplementationId': field['constant']['value'] = 'mutated'
        with self.assertRaises(public_source.SourceProjectionError): public_source.project_methods(data)
