"""Tests for the actual-engine ABI dispatch face.

Two things are checked, and they are different. First, that the face reads a dump
the way the documentation says. Second — and this is the half that matters — that
it would notice if the engine's measurement stopped matching the manifest, since a
face that always returns zero problems is indistinguishable from no face at all.

The dumps here are synthetic on purpose: they are cheap, they run offline, and
each one is a specific defect. The real artifact is measured by the gate, and by
`test_the_pinned_artifact_dump_agrees` when this host can run the exporter.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import abi_dispatch as ad

REPO = os.path.dirname(os.path.dirname(HERE))
NEF = os.path.join(REPO, 'contracts', 'bin', 'public', 'SmartAccount.nef')
MANIFEST = os.path.join(REPO, 'contracts', 'bin', 'public', 'SmartAccount.manifest.json')
EXPORTER = os.path.join(HERE, 'export', 'bin', 'Debug', 'net10.0', 'RefinementExport.dll')

# Small enough to read, structured like the artifact: two reserved entry points,
# three ordinary methods, one of each shape the face cares about. `beta` declares
# a fixed-width value so the byte-length branch is exercised, not just the type.
# `gamma` is declared twice on purpose: a name with two arities is what makes the
# boundary face's `overload` probe possible, and without one the "name and arity
# select" half of the dispatch rule would be measured nowhere.
METHODS = (('_initialize', 0, 900, 'Void'), ('_deploy', 2, 800, 'Void'),
           ('alpha', 0, 10, 'Void'), ('beta', 2, 40, 'Hash160'), ('gamma', 1, 70, 'Boolean'),
           ('gamma', 2, 90, 'Boolean'))

# What the stack holds after each call: one item for a completed call (a void one
# is Null), none for a call the engine refused.
RETURNS = {'alpha/0': {'resultCount': 1, 'resultType': 'Any'},
           'beta/2': {'resultCount': 1, 'resultType': 'ByteString', 'resultBytes': 20},
           'gamma/1': {'resultCount': 1, 'resultType': 'Boolean', 'resultBytes': 1},
           'gamma/2': {'resultCount': 1, 'resultType': 'Boolean', 'resultBytes': 1}}

UNDECLARED = 'abiBoundaryProbeNotDeclared'


class DispatchFaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='sa-abi-')
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.manifest_path = os.path.join(self.directory, 'manifest.json')
        with open(self.manifest_path, 'w', encoding='utf-8') as handle:
            json.dump(self._manifest(), handle)
        with open(self.manifest_path, 'rb') as handle:
            self.manifest_sha = hashlib.sha256(handle.read()).hexdigest()

    def _manifest(self):
        return {'name': 'T', 'abi': {'methods': [
            {'name': name,
             'parameters': [{'name': 'a' + str(index), 'type': 'Integer'} for index in range(arity)],
             'returntype': returntype, 'offset': offset, 'safe': False}
            for name, arity, offset, returntype in METHODS]}}

    def _boundary(self):
        """The probes the exporter emits, with the outcomes this engine returns.

        Written here as data rather than as a call into the exporter, so that the
        face's expectations stay a statement about the manifest and the dump, and
        the synthetic dump can be mutated one probe at a time.
        """
        offsets = {name + '/' + str(arity): offset
                   for name, arity, offset, _ in METHODS}
        arities = {}
        for name, arity, _, _ in METHODS:
            arities.setdefault(name, set()).add(arity)
        probes = []

        def refused(name, arity, detail):
            return {'kind': None, 'name': name, 'arity': arity, 'argShapes': 'zeros',
                    'entered': False, 'enteredOffset': None, 'state': 'FAULT',
                    'fault': 'Exception has been thrown by the target of an invocation.',
                    'faultDetail': detail, 'steps': 6, 'stepLimitReached': False,
                    'syscalls': ['System.Contract.Call']}

        for name, arity, offset, _ in METHODS:
            reserved = name in ad.RESERVED_ENTRY_POINTS
            underscore = ("System.ArgumentException: Method name '" + name
                          + "' cannot start with underscore. (Parameter 'method')")
            if reserved:
                row = refused(name, arity, underscore)
            else:
                row = {'kind': 'control', 'name': name, 'arity': arity, 'argShapes': 'zeros',
                       'entered': True, 'enteredOffset': offset, 'state': 'HALT',
                       'fault': None, 'faultDetail': None, 'steps': 120,
                       'stepLimitReached': False, 'syscalls': ['System.Contract.Call']}
            row['kind'] = 'control'
            probes.append(row)
            for candidate in (arity - 1, arity + 1):
                if candidate < 0:
                    continue
                key = name + '/' + str(candidate)
                if key in offsets:
                    probes.append({'kind': 'overload', 'name': name, 'arity': candidate,
                                   'argShapes': 'zeros', 'entered': True,
                                   'enteredOffset': offsets[key], 'state': 'FAULT',
                                   'fault': 'ABORTMSG is executed. Reason: Account not found',
                                   'faultDetail': 'Neo.VM.ExecutionEngine',
                                   'steps': 40, 'stepLimitReached': False,
                                   'syscalls': ['System.Contract.Call']})
                else:
                    detail = underscore if reserved else (
                        'System.InvalidOperationException: Method "' + name + '" with '
                        + str(candidate) + " parameter(s) doesn't exist in the contract 0x1.")
                    row = refused(name, candidate, detail)
                    row['kind'] = 'arity'
                    probes.append(row)
            if arity > 0:
                probes.append({'kind': 'type', 'name': name, 'arity': arity,
                               'argShapes': 'compound-for-scalar', 'entered': True,
                               'enteredOffset': offset, 'state': 'FAULT',
                               'fault': 'Specified cast is not valid.',
                               'faultDetail': 'Neo.VM.Types.StackItem.GetInteger()',
                               'steps': 30, 'stepLimitReached': False,
                               'syscalls': ['System.Contract.Call']})
        row = refused(UNDECLARED, 0,
                      'System.InvalidOperationException: Method "' + UNDECLARED
                      + "\" with 0 parameter(s) doesn't exist in the contract 0x1.")
        row['kind'] = 'absent'
        probes.append(row)
        return {'schema': ad.BOUNDARY_SCHEMA, 'undeclaredName': UNDECLARED, 'probes': probes}

    def _dump(self):
        rows = []
        for name, arity, offset, returntype in METHODS:
            reserved = name in ad.RESERVED_ENTRY_POINTS
            rows.append({
                'name': name, 'parameters': arity, 'offset': offset,
                'returnType': returntype, 'safe': False,
                'dispatchOffset': None if reserved else offset,
                'dispatchMatchesDeclared': not reserved,
                'reachedDeclared': not reserved,
                'state': 'FAULT' if reserved else 'HALT',
                'fault': 'Exception has been thrown by the target of an invocation.'
                         if reserved else None,
                'steps': 8 if reserved else 120,
                'stepLimitReached': False,
                'executedOffsets': 0 if reserved else 40,
                'firstIps': {'1': 0} if reserved else {'1': 0, '2': offset},
                'syscalls': ['System.Contract.Call'],
                'syscallsTruncated': False,
                **({} if reserved else RETURNS[name + '/' + str(arity)]),
                **({'resultCount': 0} if reserved else {}),
            })
        return {'schema': ad.SCHEMA,
                'nef': {'sha256': 'n' * 64, 'scriptLength': 1000},
                'manifest': {'sha256': self.manifest_sha, 'methods': len(rows)},
                'deployed': {'hash': '0x' + '1' * 40, 'gasLimit': 100000000000},
                'engine': {'neo': '3.9.1.0', 'vm': '3.9.0.0', 'testing': '3.9.1.0'},
                'initializeOffset': 900, 'deployOffset': 800,
                'methods': rows,
                'boundary': self._boundary()}

    def _correspond(self, dump):
        path = os.path.join(self.directory, 'dump.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(dump, handle)
        return ad.correspond(path, self.manifest_path)

    def test_a_matching_dump_agrees(self):
        receipt = self._correspond(self._dump())
        self.assertTrue(ad.agrees(receipt), receipt['problems'][:3])
        stats = receipt['stats']
        self.assertEqual(6, stats['declared'])
        self.assertEqual(6, stats['methods'])
        self.assertEqual(4, stats['dispatched'])
        self.assertEqual(2, stats['reservedRefused'])
        self.assertEqual(0, stats['dispatchMismatch'])

    def test_the_receipt_never_claims_a_proof(self):
        receipt = self._correspond(self._dump())
        self.assertTrue(receipt['claims']['abiDispatchMeasured'])
        self.assertFalse(receipt['claims']['abiDispatchProven'])
        self.assertFalse(receipt['claims']['semanticsProven'])
        self.assertFalse(receipt['claims']['fullImplementationVerified'])

    def test_an_offset_the_dump_moved_is_a_failure(self):
        dump = self._dump()
        dump['methods'][2]['offset'] = 11
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['dispatchMismatch'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_dispatch_that_lands_elsewhere_is_a_failure(self):
        dump = self._dump()
        dump['methods'][2]['dispatchOffset'] = 11
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['dispatchMismatch'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_declared_entry_that_never_ran_is_a_failure(self):
        dump = self._dump()
        dump['methods'][2]['reachedDeclared'] = False
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['unreached'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_method_that_went_missing_is_a_failure(self):
        dump = self._dump()
        dump['methods'].pop(2)
        receipt = self._correspond(dump)
        self.assertFalse(receipt['stats']['shapeMatches'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_method_added_to_the_dump_is_a_failure(self):
        dump = self._dump()
        extra = dict(dump['methods'][2])
        extra['name'] = 'delta'
        dump['methods'].append(extra)
        receipt = self._correspond(dump)
        self.assertFalse(receipt['stats']['shapeMatches'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_reserved_entry_that_claims_to_be_callable_is_a_failure(self):
        # `_deploy` and `_initialize` are dispatched by the engine, not by name.
        # A dump that says one of them was dispatched is describing an engine
        # that does not exist, so the face refuses it rather than smoothing it.
        dump = self._dump()
        dump['methods'][0]['dispatchOffset'] = 900
        dump['methods'][0]['reachedDeclared'] = True
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['reservedRefused'])
        self.assertFalse(ad.agrees(receipt))

    def test_an_unknown_syscall_is_a_failure(self):
        dump = self._dump()
        dump['methods'][2]['syscalls'] = ['0xdeadbeef']
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['unknownSyscalls'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_dump_from_another_manifest_is_a_failure(self):
        dump = self._dump()
        dump['manifest']['sha256'] = '0' * 64
        receipt = self._correspond(dump)
        self.assertFalse(receipt['stats']['manifestSha256Matches'])
        self.assertFalse(ad.agrees(receipt))

    def test_an_engine_error_is_a_failure(self):
        dump = self._dump()
        dump['methods'][2]['engineError'] = 'InvalidOperationException: boom'
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['engineErrors'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_missing_dump_is_refused_rather_than_reported_as_agreement(self):
        with self.assertRaises(ValueError):
            ad.correspond(os.path.join(self.directory, 'absent.json'), self.manifest_path)

    # -- what the call left on the stack ----------------------------------

    def test_a_call_that_returns_the_wrong_type_is_a_failure(self):
        # `gamma` declares Boolean and returns one. Reporting an Integer means the
        # manifest and the artifact disagree about the method's own signature.
        dump = self._dump()
        dump['methods'][4]['resultType'] = 'Integer'
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['resultTypeMismatch'])
        self.assertEqual(3, receipt['stats']['returnsMatch'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_hash160_that_comes_back_at_the_wrong_width_is_a_failure(self):
        # A 32-byte value returned for a Hash160 is a different value, not a
        # different type, so the type check alone cannot see it.
        dump = self._dump()
        dump['methods'][3]['resultBytes'] = 32
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['resultBytesMismatch'])
        self.assertEqual(0, receipt['stats']['resultTypeMismatch'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_completed_call_must_leave_exactly_one_result(self):
        dump = self._dump()
        dump['methods'][4]['resultCount'] = 0
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['resultCountMismatch'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_fault_must_not_leave_a_result_behind(self):
        # A fault unwinds the frame. A result next to a fault is a measurement
        # describing a run other than the one it reports.
        dump = self._dump()
        dump['methods'][0]['resultCount'] = 1
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['faultsWithResult'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_void_call_leaves_null_rather_than_nothing(self):
        # Measured on the pinned artifact, not assumed: `System.Contract.Call`
        # pushes the callee's result whatever it is, so a void method leaves one
        # Null item. An earlier draft required zero items and the artifact
        # disagreed on two methods.
        receipt = self._correspond(self._dump())
        self.assertEqual('Any', ad.RETURN_STACK_TYPES['Void'])
        self.assertEqual(0, receipt['stats']['resultCountMismatch'])
        self.assertEqual(4, receipt['stats']['returnsChecked'])

    def test_a_declared_type_no_completed_call_reached_is_not_counted_as_tested(self):
        # `beta` declares Hash160 and is the only method that would exercise that
        # rule. Make it fault and the rule is never applied, so the receipt has to
        # move the type to "unexercised" instead of listing it as covered. On the
        # pinned artifact this is what happens to `Any` and `Array`: every method
        # declaring them faults on zero arguments, so those mappings are untested.
        dump = self._dump()
        dump['methods'][3].update({'state': 'FAULT', 'resultCount': 0})
        dump['methods'][3].pop('resultType', None)
        dump['methods'][3].pop('resultBytes', None)
        receipt = self._correspond(dump)
        self.assertIn('Hash160', receipt['stats']['declaredTypesUnexercised'])
        self.assertNotIn('Hash160', receipt['stats']['declaredTypesExercised'])
        self.assertEqual(3, receipt['stats']['returnsChecked'])

    def test_the_self_test_catches_its_own_mutants(self):
        receipt = self._correspond(self._dump())
        self.assertEqual(17, receipt['selfTest']['checks'])
        self.assertEqual([], receipt['selfTest']['failed'])
        self.assertEqual([], receipt['problems'])

    def test_a_null_for_a_reference_type_is_allowed_but_not_counted_as_exercised(self):
        # The manifest cannot say "may be null", so a null where a reference type
        # is declared is not a disagreement with the artifact. It applies no rule,
        # so it must not look like a mapping that was tested either.
        dump = self._dump()
        row = next(item for item in dump['methods'] if item.get('resultType') == 'ByteString')
        row['resultType'] = 'Any'
        row.pop('resultBytes', None)
        receipt = self._correspond(dump)
        self.assertEqual([], receipt['problems'])
        self.assertEqual(1, receipt['stats']['nullReturns'])
        self.assertLess(receipt['stats']['returnsMatch'], receipt['stats']['returnsChecked'])
        self.assertIn('Hash160', receipt['stats']['declaredTypesUnexercised'])

    def test_a_null_for_a_value_type_is_a_failure(self):
        dump = self._dump()
        row = next(item for item in dump['methods'] if item.get('resultType') == 'Boolean')
        row['resultType'] = 'Any'
        row.pop('resultInteger', None)
        receipt = self._correspond(dump)
        self.assertIn('result-type', [problem[1] for problem in receipt['problems']])

    # -- the boundary: calls the manifest does not describe --------------------

    def test_the_boundary_counts_what_the_engine_did(self):
        # Six controls (one per declared method, two of them reserved), eight
        # arity probes - every method's count minus one and plus one, minus the
        # two counts a sibling overload declares - four type probes, two
        # overloads and one undeclared name.
        receipt = self._correspond(self._dump())
        stats = receipt['stats']
        self.assertTrue(stats['boundaryProbesMatch'])
        self.assertEqual(stats['boundaryProbes'], stats['boundaryProbesExpected'])
        self.assertEqual(6, stats['boundaryControls'])
        self.assertEqual(4, stats['boundaryControlsEntered'])
        self.assertEqual(2, stats['boundaryControlsRefused'])
        self.assertEqual(8, stats['boundaryArityProbes'])
        self.assertEqual(8, stats['boundaryArityRefused'])
        self.assertEqual(0, stats['boundaryArityEntered'])
        self.assertEqual(2, stats['boundaryOverloadProbes'])
        self.assertEqual(2, stats['boundaryOverloadLandedOnSibling'])
        self.assertEqual(4, stats['boundaryTypeProbes'])
        self.assertTrue(stats['boundaryAbsentRefused'])

    def test_a_probe_that_went_missing_is_a_failure(self):
        # An exporter that stopped emitting a probe would otherwise look like a
        # face with nothing to disagree with.
        dump = self._dump()
        dump['boundary']['probes'].pop(0)
        receipt = self._correspond(dump)
        self.assertFalse(receipt['stats']['boundaryProbesMatch'])
        self.assertFalse(ad.agrees(receipt))

    def test_the_undeclared_name_probe_is_required_not_optional(self):
        # Asked of the face directly: the self test cannot build its own mutation
        # for a probe that is not in the dump, so this property is pinned here.
        dump = self._dump()
        dump['boundary']['probes'] = [row for row in dump['boundary']['probes']
                                      if row['kind'] != 'absent']
        declared, _, _ = ad.manifest_methods(self.manifest_path)
        parameters = ad.manifest_parameters(self.manifest_path)
        summary, problems = ad.boundary_face(dump, declared, parameters)
        self.assertFalse(summary['boundaryAbsentRefused'])
        self.assertIn('boundary-probe-missing', [problem[1] for problem in problems])

    def test_an_arity_refusal_that_claims_to_have_entered_is_a_failure(self):
        dump = self._dump()
        row = next(item for item in dump['boundary']['probes'] if item['kind'] == 'arity')
        row.update({'entered': True, 'enteredOffset': 1, 'state': 'HALT'})
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['boundaryArityEntered'])
        self.assertFalse(ad.agrees(receipt))

    def test_an_overload_that_lands_on_the_wrong_sibling_is_a_failure(self):
        dump = self._dump()
        row = next(item for item in dump['boundary']['probes'] if item['kind'] == 'overload')
        row['enteredOffset'] = row['enteredOffset'] + 1
        receipt = self._correspond(dump)
        self.assertEqual(1, receipt['stats']['boundaryOverloadProbes']
                         - receipt['stats']['boundaryOverloadLandedOnSibling'])
        self.assertFalse(ad.agrees(receipt))

    def test_a_refusal_whose_reason_is_the_callee_is_a_failure(self):
        # A call that never entered a frame and carries an ABORTMSG from the
        # contract is not a boundary refusal; it is a measurement that does not
        # add up, and filing it under "measured" would be the quiet option.
        dump = self._dump()
        row = next(item for item in dump['boundary']['probes'] if item['kind'] == 'arity')
        row['fault'] = 'ABORTMSG is executed. Reason: Account not found'
        row['faultDetail'] = 'Neo.VM.ExecutionEngine'
        receipt = self._correspond(dump)
        self.assertIn('boundary-refusal-unclassified',
                      [problem[1] for problem in receipt['problems']])
        self.assertFalse(ad.agrees(receipt))

    def test_a_wrong_shaped_argument_is_recorded_rather_than_required(self):
        # The engine does not refuse a wrong-shaped argument at the boundary: it
        # is measured entering the callee and failing there, or answering. The
        # receipt reports that as a fact about the engine instead of failing a
        # contract for not having a rule the engine never applied. Making it
        # *refused with an unclassified reason* is still a failure.
        dump = self._dump()
        row = next(item for item in dump['boundary']['probes'] if item['kind'] == 'type')
        row.update({'entered': False, 'enteredOffset': None})
        receipt = self._correspond(dump)
        self.assertIn('boundary-refusal-unclassified',
                      [problem[1] for problem in receipt['problems']])
        self.assertFalse(ad.agrees(receipt))

    def test_the_shape_flag_reports_the_engine_and_not_a_requirement(self):
        # A boundary that did refuse the shape would still be agreement - it is
        # another engine, not a defect - and the flag is what says which one was
        # measured. Nothing in the receipt may read as a claim about correctness.
        dump = self._dump()
        # The last one, so the self test's own "refused for a reason nobody named"
        # mutation still has a probe to change.
        row = [item for item in dump['boundary']['probes'] if item['kind'] == 'type'][-1]
        row.update({'entered': False, 'enteredOffset': None, 'state': 'FAULT',
                    'fault': 'Exception has been thrown by the target of an invocation.',
                    'faultDetail': 'System.InvalidOperationException: Method "x" with 1 '
                                   'parameter(s) doesn\'t exist in the contract 0x1.'})
        receipt = self._correspond(dump)
        self.assertEqual([], receipt['problems'])
        self.assertTrue(ad.agrees(receipt))
        self.assertTrue(receipt['stats']['shapeEnforcedAtBoundary'])
        self.assertTrue(receipt['boundary']['claims']['shapeEnforcedAtBoundary'])
        self.assertFalse(receipt['claims']['semanticsProven'])


class PinnedArtifactTests(unittest.TestCase):
    """End to end, when this host has dotnet and the exporter built."""

    def test_the_pinned_artifact_dump_agrees(self):
        if not (os.path.isfile(NEF) and os.path.isfile(MANIFEST) and os.path.isfile(EXPORTER)):
            self.skipTest('no built exporter or pinned artifact on this host')
        if shutil.which('dotnet') is None:
            self.skipTest('dotnet is not on PATH')
        with tempfile.TemporaryDirectory() as scratch:
            dump_path = os.path.join(scratch, 'abi-dispatch.json')
            result = subprocess.run(
                ['dotnet', EXPORTER, '--abi-dispatch', dump_path,
                 '--nef', NEF, '--manifest', MANIFEST],
                capture_output=True, text=True, timeout=600)
            self.assertEqual(0, result.returncode, result.stderr[-400:])
            receipt = ad.correspond(dump_path, MANIFEST, NEF)
        self.assertTrue(receipt['nef']['sha256Matches'])
        self.assertEqual(0, receipt['stats']['dispatchMismatch'])
        self.assertEqual(0, receipt['stats']['unreached'])
        self.assertEqual(0, receipt['stats']['unknownSyscalls'])
        self.assertTrue(ad.agrees(receipt), receipt['problems'][:3])
        self.assertEqual(receipt['stats']['declared'] - 2, receipt['stats']['dispatched'])


if __name__ == '__main__':
    unittest.main()
