"""Actual pinned handlers, complete body parsing and source semantic controls."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent


def extractor():
    spec = importlib.util.spec_from_file_location('runtime_source_extractor', ROOT / 'runtime_source.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class RuntimeSourceTests(unittest.TestCase):
    def test_actual_arithmetic_order_is_extracted(self):
        module = extractor(); report = module.extract_runtime()
        body = report['handlers']['SUB']['body']
        self.assertEqual(body[0]['name'], 'x2')
        self.assertEqual(body[1]['name'], 'x1')
        expression = body[2]['expression']['arguments'][0]
        self.assertEqual(expression['operator'], '-')
        self.assertEqual(expression['left']['name'], 'x1')
        self.assertEqual(expression['right']['name'], 'x2')
        self.assertFalse(report['runtimeImplementationProven'])

    def test_valid_source_operator_mutation_changes_ir(self):
        module = extractor(); original = module.pinned_sources()['JumpTable/JumpTable.Numeric.cs']
        changed = original.replace('engine.Push(x1 - x2);', 'engine.Push(x1 + x2);', 1)
        body = module.parse_handler(changed, 'Sub')
        self.assertEqual(body[2]['expression']['arguments'][0]['operator'], '+')

    def test_extra_action_and_unknown_syntax_cannot_be_ignored(self):
        module = extractor(); original = module.pinned_sources()['JumpTable/JumpTable.Numeric.cs']
        changed = original.replace('engine.Push(x1 - x2);', 'engine.Push(x1 - x2); engine.Reset();', 1)
        with self.assertRaises(ValueError):
            module.parse_handler(changed, 'Sub')
        changed = original.replace('engine.Push(x1 - x2);', 'while (true) engine.Pop();', 1)
        with self.assertRaises(ValueError):
            module.parse_handler(changed, 'Sub')

    def test_actual_stack_guards_and_swap_order_are_retained(self):
        report = extractor().extract_runtime()
        body = report['handlers']['ROT']['body']
        self.assertEqual(body[1]['kind'], 'if')
        self.assertEqual(body[1]['condition']['operator'], '<')
        self.assertEqual(body[2]['expression']['arguments'][0]['value'], 1)
        self.assertEqual(body[3]['expression']['arguments'][0]['value'], 0)


if __name__ == '__main__':
    unittest.main()
