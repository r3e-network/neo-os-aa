"""Tests for the executed-footprint face.

The face asks one thing: is every byte method the engine entered one the static
dependency graph reaches from that entry? Two halves are tested, and they are
different. First, that the face reads a dump and an inventory the way the
documentation says. Second — the half that matters — that it would notice if
either side stopped describing the other, because a face that always returns
zero problems is indistinguishable from no face at all.

Both sides are mutated on purpose. A face that only distrusts the dump would
pass a closure that forgot a method the engine demonstrably entered.

The fixtures are synthetic: sixteen one-byte instructions, three byte methods, one
unmapped range, three ordinary entry points and the two reserved ones. The real
artifact is measured by the gate.
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import dispatch_footprint as fp

# Sixteen PUSH1 instructions: one byte each, no operands, no edges to simplify.
SCRIPT = bytes([0x11] * 16)
INITIALIZE = 12
DEPLOY = 13

METHODS = (('_initialize', 0, INITIALIZE), ('_deploy', 2, DEPLOY),
           ('alpha', 0, 0), ('beta', 2, 4), ('gamma', 1, 8))

FOOTPRINTS = {
    'alpha/0': [0, 1, 2, 3, INITIALIZE, INITIALIZE + 1],
    'beta/2': [4, 5, 6, 7, INITIALIZE],
    'gamma/1': [8, 9, INITIALIZE],
}


class FootprintFaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='aa-footprint-')
        self.addCleanup(shutil.rmtree, self.directory, True)

    # -- fixtures ---------------------------------------------------------

    def _report(self):
        entries = []
        for name, arity, offset in METHODS:
            start = min(12, (offset // 4) * 4) if name not in fp.RESERVED_ENTRY_POINTS else 12
            entries.append({
                'key': name + '/' + str(arity), 'byteStart': start,
                'byteDependencyStarts': [start],
                'initializationDependencyStarts': [INITIALIZE],
            })
        return {
            'schema': 'neoos-aa-entrypoint-closure-inventory/v1',
            'nefSha256': 'n' * 64,
            'scriptSha256': hashlib.sha256(SCRIPT).hexdigest(),
            'byteMethods': [{'start': 0, 'endExclusive': 4},
                            {'start': 4, 'endExclusive': 8},
                            {'start': 8, 'endExclusive': 12}],
            'unmappedRanges': [{'start': 12, 'endExclusive': 16}],
            'entrypoints': entries,
        }

    def _dump(self):
        rows = []
        for name, arity, offset in METHODS:
            key = name + '/' + str(arity)
            reserved = name in fp.RESERVED_ENTRY_POINTS
            rows.append({
                'name': name, 'parameters': arity, 'offset': offset,
                'dispatchOffset': None if reserved else offset,
                'reachedDeclared': not reserved,
                'state': 'FAULT' if reserved else 'HALT',
                'executedForeign': 3,
                'executedInContract': [] if reserved else list(FOOTPRINTS[key]),
                'firstIps': {'1': 0} if reserved else {'1': 0, '2': offset},
                'syscalls': [], 'stepLimitReached': False,
            })
        return {
            'schema': 'aa-abi-dispatch/v2',
            'nef': {'sha256': 'n' * 64, 'scriptLength': len(SCRIPT)},
            'script': {'length': len(SCRIPT), 'hex': SCRIPT.hex(),
                       'sha256': hashlib.sha256(SCRIPT).hexdigest()},
            'manifest': {'sha256': 'm' * 64, 'methods': len(rows)},
            'engine': {'neo': '3.9.1.0', 'vm': '3.9.0.0', 'testing': '3.9.1.0'},
            'initializeOffset': INITIALIZE, 'deployOffset': DEPLOY,
            'methods': rows,
        }

    def _correspond(self, dump=None, report=None):
        dump_path = os.path.join(self.directory, 'dump.json')
        report_path = os.path.join(self.directory, 'entrypoints.json')
        with open(dump_path, 'w', encoding='utf-8') as handle:
            json.dump(dump if dump is not None else self._dump(), handle)
        with open(report_path, 'w', encoding='utf-8') as handle:
            json.dump(report if report is not None else self._report(), handle)
        return fp.correspond(dump_path, report_path, 0)

    # -- the face agrees --------------------------------------------------

    def test_a_matching_footprint_agrees(self):
        receipt = self._correspond()
        self.assertTrue(fp.agrees(receipt), receipt['problems'][:3])
        stats = receipt['stats']
        self.assertEqual(5, stats['methods'])
        self.assertEqual(5, stats['entrypoints'])
        self.assertEqual(3, stats['methodsCompared'])
        self.assertEqual(2, stats['reservedSkipped'])
        self.assertEqual(0, stats['outsideClosure'])
        self.assertEqual(0, stats['entryNotEntered'])
        self.assertEqual(0, stats['unknownOffsets'])
        self.assertEqual(0, stats['unowned'])
        self.assertEqual(3, stats['initializerEntered'])

    def test_the_receipt_never_claims_a_proof(self):
        receipt = self._correspond()
        self.assertTrue(receipt['claims']['executionFootprintMeasured'])
        self.assertFalse(receipt['claims']['staticClosureProven'])
        self.assertFalse(receipt['claims']['semanticsProven'])
        self.assertFalse(receipt['claims']['fullImplementationVerified'])

    def test_reachable_but_not_entered_is_counted_and_is_not_a_failure(self):
        # `reachable` is a may-set. A branch the zero-argument call did not take
        # is a fact about the call. Reporting it as a failure would be reporting
        # a disagreement that does not exist, so it is counted and the face still
        # agrees.
        report = self._report()
        report['entrypoints'][2]['byteDependencyStarts'] = [0, 4]
        receipt = self._correspond(report=report)
        self.assertEqual(1, receipt['stats']['closureNotEntered'])
        self.assertTrue(fp.agrees(receipt), receipt['problems'][:3])

    def test_the_reserved_entry_points_are_not_asked_for_a_footprint(self):
        # A named call to `_initialize` or `_deploy` is refused, so an empty
        # footprint is the honest measurement, not a missing one.
        receipt = self._correspond()
        self.assertEqual(2, receipt['stats']['reservedSkipped'])
        self.assertEqual(0, receipt['stats']['noFootprint'])

    # -- the engine side can be wrong -------------------------------------

    def test_an_offset_that_is_not_an_instruction_is_a_failure(self):
        dump = self._dump()
        dump['methods'][2]['executedInContract'].append(99)
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['unknownOffsets'])
        self.assertFalse(fp.agrees(receipt))

    def test_a_footprint_in_bytes_the_entry_cannot_reach_is_a_failure(self):
        dump = self._dump()
        dump['methods'][2]['executedInContract'] = [8, 9]
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['outsideClosure'])
        self.assertFalse(fp.agrees(receipt))

    def test_an_entry_offset_that_never_ran_is_a_failure(self):
        dump = self._dump()
        dump['methods'][2]['executedInContract'] = [1, 2, INITIALIZE]
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['entryNotEntered'])
        self.assertFalse(fp.agrees(receipt))

    def test_a_method_with_no_footprint_is_a_failure(self):
        dump = self._dump()
        dump['methods'][2]['executedInContract'] = []
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['noFootprint'])
        self.assertFalse(fp.agrees(receipt))

    def test_a_dump_of_other_bytes_is_a_failure(self):
        dump = self._dump()
        dump['script']['sha256'] = '0' * 64
        receipt = self._correspond(dump)
        self.assertFalse(receipt['stats']['bytesMatch'])
        self.assertFalse(fp.agrees(receipt))

    def test_a_dump_without_script_bytes_is_a_failure(self):
        dump = self._dump()
        del dump['script']
        receipt = self._correspond(dump)
        self.assertFalse(receipt['stats']['bytesMatch'])
        self.assertFalse(fp.agrees(receipt))

    def test_a_dump_of_another_contract_is_a_failure(self):
        dump = self._dump()
        dump['nef']['sha256'] = '0' * 64
        receipt = self._correspond(dump)
        self.assertFalse(receipt['stats']['nefShaMatches'])
        self.assertFalse(fp.agrees(receipt))

    # -- the model side can be wrong --------------------------------------

    def test_a_closure_that_forgot_a_method_the_engine_entered_is_a_failure(self):
        report = self._report()
        report['entrypoints'][2]['byteDependencyStarts'] = []
        receipt = self._correspond(report=report)
        self.assertEqual(1, receipt['stats']['outsideClosure'])
        self.assertFalse(fp.agrees(receipt))

    def test_an_inventory_with_a_hole_is_a_failure(self):
        report = self._report()
        report['byteMethods'][1]['endExclusive'] = 7
        receipt = self._correspond(report=report)
        self.assertFalse(receipt['stats']['partitioned'])
        self.assertFalse(fp.agrees(receipt))
        self.assertTrue(any(row[1] == 'hole' for row in receipt['problems']))

    def test_an_instruction_outside_every_range_is_a_failure(self):
        # Byte method `beta` starts one instruction late, so instruction 4 falls
        # into a hole and the footprint that ran there has no owner.
        report = self._report()
        report['byteMethods'][1]['start'] = 5
        receipt = self._correspond(report=report)
        self.assertEqual(1, receipt['stats']['unowned'])
        self.assertFalse(receipt['stats']['partitioned'])
        self.assertFalse(fp.agrees(receipt))

    def test_an_inventory_bound_to_other_bytes_is_a_failure(self):
        report = self._report()
        report['scriptSha256'] = '0' * 64
        receipt = self._correspond(report=report)
        self.assertFalse(receipt['stats']['reportShaMatches'])
        self.assertFalse(fp.agrees(receipt))

    def test_an_inventory_that_lost_an_entry_point_is_a_failure(self):
        # With the inventory short one entry point the pair no longer describes
        # the same method set, so the face fails. One self-test mutant also
        # becomes unbuildable, and that is recorded as skipped rather than
        # quietly shrinking the self test to what still fits.
        report = self._report()
        report['entrypoints'].pop(2)
        receipt = self._correspond(report=report)
        self.assertNotEqual(receipt['stats']['methods'], receipt['stats']['methodsMatched'])
        self.assertTrue(receipt['selfTest']['skipped'])
        self.assertFalse(fp.agrees(receipt))

    def test_a_missing_dump_is_refused_rather_than_reported_as_agreement(self):
        report_path = os.path.join(self.directory, 'entrypoints.json')
        with open(report_path, 'w', encoding='utf-8') as handle:
            json.dump(self._report(), handle)
        with self.assertRaises(ValueError):
            fp.correspond(os.path.join(self.directory, 'absent.json'), report_path, 0)

    def test_a_missing_inventory_is_refused_rather_than_reported_as_agreement(self):
        dump_path = os.path.join(self.directory, 'dump.json')
        with open(dump_path, 'w', encoding='utf-8') as handle:
            json.dump(self._dump(), handle)
        with self.assertRaises(ValueError):
            fp.correspond(dump_path, os.path.join(self.directory, 'absent.json'), 0)

    # -- the face can tell ------------------------------------------------

    def test_the_self_test_catches_its_own_mutants(self):
        receipt = self._correspond()
        self.assertEqual(8, receipt['selfTest']['checks'])
        self.assertEqual([], receipt['selfTest']['failed'])
        self.assertEqual([], receipt['problems'])

    def test_every_self_test_row_is_caught(self):
        # A mutant that the face does not notice records `False`, and a mutant
        # that could not even be built raises. Both are failures of the face,
        # so neither may be silently dropped.
        receipt = self._correspond()
        for label, caught, _ in receipt['selfTest']['rows']:
            self.assertTrue(caught, label)


if __name__ == '__main__':
    unittest.main()
