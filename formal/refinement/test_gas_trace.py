"""Independent pricing/CFG controls; universal arithmetic belongs to Coq."""
import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path
try:
    from . import gas_trace
except ImportError:  # discovered as a top-level module, not a package member
    import gas_trace


class GasTraceTests(unittest.TestCase):
    def test_exact_116_instruction_cfg_has_all_success_and_abort_paths(self):
        bound = gas_trace.bind_artifact()
        paths = gas_trace.enumerate_paths(bound['instructions'])
        self.assertEqual(116, len(bound['instructions']))
        self.assertEqual(12, len(paths))
        self.assertEqual(4, sum(p['terminal'] == 'RET' for p in paths))
        self.assertEqual(8, sum(p['terminal'] == 'ABORTMSG' for p in paths))
        self.assertEqual({93, 96, 107, 110}, {len(p['pcs']) for p in paths if p['terminal'] == 'RET'})

    def test_storage_put_boundary_sizes(self):
        for old, new, expected in [(None, 0, 1), (None, 70, 71), (38, 70, 42),
                                   (100, 70, 18), (0, 70, 70), (70, 0, 0), (38, 39, 11)]:
            self.assertEqual(expected, gas_trace.put_size(old, new))
        with self.assertRaises(ValueError):
            gas_trace.put_size(-1, 39)

    def test_pinned_source_metadata_includes_native_wrapper_fees(self):
        fees = gas_trace.extract_fees(gas_trace.pinned_sources())
        self.assertEqual(10000, fees['factor'])
        self.assertEqual({'serialize': 4096, 'deserialize': 16384}, fees['nativeCpu'])
        self.assertEqual(1, fees['opcodes']['PUSH0'])
        self.assertEqual(0, fees['opcodes']['SYSCALL'])
        self.assertEqual(32768, fees['syscalls']['System.Storage.Put']['fixed'])
        self.assertEqual(3, len(fees['nativeWrapper']))

    def test_valid_csharp_unknown_price_expression_fails_closed(self):
        source = gas_trace.pinned_sources()['ApplicationEngine.OpCodePrices.cs']
        with self.assertRaises(ValueError):
            gas_trace.opcode_prices(source.replace('[OpCode.PUSH0] = 1 << 0', '[OpCode.PUSH0] = 1 + 0'))

    def test_native_storage_zero_default_is_explicitly_bound(self):
        fees = gas_trace.extract_fees(gas_trace.pinned_sources())
        self.assertEqual({'serialize': 0, 'deserialize': 0}, fees['nativeStorage'])
        self.assertIn('Native/ContractMethodAttribute.cs', fees['sourceHashes'])
        self.assertIn('Native/ContractMethodMetadata.cs', fees['sourceHashes'])

    def test_changed_pinned_source_hash_fails_closed(self):
        sources = gas_trace.pinned_sources()
        sources['Native/StdLib.cs'] = sources['Native/StdLib.cs'].replace('CpuFee = 1 << 12', 'CpuFee = 1 << 13', 1)
        with self.assertRaises(ValueError):
            gas_trace.extract_fees(sources)

    def test_valid_loop_opcode_mutation_rejected_by_cfg(self):
        bound = gas_trace.bind_artifact()
        modified = [dict(i) for i in bound['instructions']]
        last_jump = next(i for i in modified if i['offset'] == 19178)
        last_jump['edges'] = [{'kind': 'branch', 'target': 19178}]
        with self.assertRaises(ValueError):
            gas_trace.enumerate_paths(modified)

    def test_prices_are_independent_of_runtime_observation(self):
        fees = gas_trace.extract_fees(gas_trace.pinned_sources())
        model = gas_trace.derive(gas_trace.bind_artifact(), fees)
        self.assertEqual(12, len(model['paths']))
        self.assertEqual(182, len(model['initializer']))
        self.assertTrue(all(p['executionCoefficient'] > 0 for p in model['paths']))
        self.assertGreater(model['maxExecutionCoefficient'], 32768)
        self.assertEqual(71, model['maxStorageBytes'])


PRE_RENAME_FIXTURE = Path(__file__).with_name('fixtures') / 'helper-gas-runtime-receipts.json.gz'
LIVE_FIXTURE = Path(__file__).with_name('fixtures') / 'helper-gas-runtime-live-receipts.json.gz'
# The pre-rename receipts were captured on 2026-10-13 against the artifact that
# still carried the pre-rename type and assembly names, so their `artifacts`
# block pins that earlier NEF and their traced instruction offsets are absolute
# pcs inside it. The rename changed the script bytes, so the observations no
# longer describe the current artifact and the cross-check refuses them. This
# archive is retained on purpose: it is the record that the stale lane was
# refused rather than silently accepted, and `ArchivedReceiptStalenessTests`
# keeps asserting exactly that.
PRE_RENAME_NEF_SHA = '083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a'
PRE_RENAME_MANIFEST_SHA = 'e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156'

# The live receipts were recaptured on 2026-10-17 by running the producer test
# against the current artifact, which is the only way to re-establish the lane:
# a stale receipt cannot be rewritten into evidence about a different build.
# `LiveReceiptArchiveTests` fails loudly if this archive ever stops describing
# the artifact `gas_trace` pins, so drift cannot be mistaken for verification.
PRODUCER = 'tests/SmartAccount.Contracts.Tests/ImplementationRefinementGasRuntimeTests.cs'


def _receipts(path):
    with gzip.open(path, 'rt') as stream:
        return json.load(stream)['receipts']


def pre_rename_receipts():
    return _receipts(PRE_RENAME_FIXTURE)


def live_receipts():
    return _receipts(LIVE_FIXTURE)


RECEIPTS_PIN_PRE_RENAME_ARTIFACT = (
    {r['artifacts']['nefSha256'] for r in pre_rename_receipts().values()}
    != {gas_trace.NEF_SHA})


def live_receipts_pin_the_current_artifact():
    receipts = live_receipts().values()
    return ({r['artifacts']['nefSha256'] for r in receipts} == {gas_trace.NEF_SHA}
            and {r['artifacts']['manifestSha256'] for r in receipts}
            == {gas_trace.MANIFEST_SHA})


class ArchivedReceiptStalenessTests(unittest.TestCase):
    """Record - rather than hide - that one archive pins a superseded build.

    The pre-rename archive must never be upgraded into evidence: its whole value
    is that `crosscheck_runtime` refuses it at the artifact check. If that
    refusal were relaxed, every mutation control below would "pass" for the
    wrong reason, because they would observe the same artifact-mismatch
    ValueError the mutation never caused.
    """

    def test_pre_rename_receipts_name_the_pre_rename_artifact(self):
        receipts = pre_rename_receipts()
        self.assertEqual(5, len(receipts))
        for shape, receipt in receipts.items():
            with self.subTest(shape=shape):
                self.assertEqual(receipt['artifacts']['nefSha256'],
                                 PRE_RENAME_NEF_SHA)
                self.assertEqual(receipt['artifacts']['manifestSha256'],
                                 PRE_RENAME_MANIFEST_SHA)
        self.assertNotEqual(PRE_RENAME_NEF_SHA, gas_trace.NEF_SHA)
        self.assertNotEqual(PRE_RENAME_MANIFEST_SHA, gas_trace.MANIFEST_SHA)

    def test_stale_receipts_are_refused_instead_of_being_silently_accepted(self):
        model = gas_trace.derive(gas_trace.bind_artifact(),
                                 gas_trace.extract_fees(gas_trace.pinned_sources()))
        with tempfile.TemporaryDirectory() as directory:
            for shape, receipt in pre_rename_receipts().items():
                (Path(directory) / ('sa-gas-runtime-helper-' + shape + '.json')
                 ).write_text(json.dumps(receipt))
            with self.assertRaises(ValueError) as caught:
                gas_trace.crosscheck_runtime(model, directory)
            self.assertIn('Runtime artifact mismatch', str(caught.exception))


class LiveReceiptArchiveTests(unittest.TestCase):
    """Guard the recaptured archive against silent drift.

    Unlike the staleness record above, this class is meant to fail: the lane is
    only established while the archived observations still describe the artifact
    pinned by `gas_trace`. A future rebuild must recapture with `PRODUCER`
    rather than edit these expectations.
    """

    def test_live_archive_covers_exactly_the_five_declared_shapes(self):
        self.assertEqual(['absent', 'exhausted', 'reset', 'same', 'zero'],
                         sorted(live_receipts()))

    def test_live_archive_pins_the_current_artifact(self):
        self.assertTrue(live_receipts_pin_the_current_artifact(),
                        'live runtime receipts pin a superseded artifact;'
                        ' recapture with ' + PRODUCER)
        for shape, receipt in live_receipts().items():
            with self.subTest(shape=shape):
                self.assertEqual(receipt['artifacts']['nefSha256'],
                                 gas_trace.NEF_SHA)
                self.assertEqual(receipt['artifacts']['manifestSha256'],
                                 gas_trace.MANIFEST_SHA)
                self.assertEqual('helper-' + shape, receipt['name'])
                self.assertEqual('actual-pinned-AE-instruction-fee-observation',
                                 receipt['scope'])

    def test_live_receipts_are_accepted_by_the_independent_cross_check(self):
        model = gas_trace.derive(gas_trace.bind_artifact(),
                                 gas_trace.extract_fees(gas_trace.pinned_sources()))
        with tempfile.TemporaryDirectory() as directory:
            for shape, receipt in live_receipts().items():
                (Path(directory) / ('sa-gas-runtime-helper-' + shape + '.json')
                 ).write_text(json.dumps(receipt))
            joins = gas_trace.crosscheck_runtime(model, directory)
        self.assertEqual(5, len(joins))
        self.assertEqual(['absent', 'same', 'reset', 'exhausted', 'zero'],
                         [join['shape'] for join in joins])


@unittest.skipIf(not live_receipts_pin_the_current_artifact(),
                 'live runtime receipts pin a superseded artifact; the lane needs'
                 ' a recapture with ' + PRODUCER + ' before these controls verify'
                 ' anything')
class RuntimeReceiptTests(unittest.TestCase):
    """Recheck archived observations; these tests do not rerun the engine."""

    @classmethod
    def setUpClass(cls):
        cls.receipts = live_receipts()
        cls.model = gas_trace.derive(gas_trace.bind_artifact(), gas_trace.extract_fees(gas_trace.pinned_sources()))

    def check(self, receipts):
        with tempfile.TemporaryDirectory() as directory:
            for shape, receipt in receipts.items():
                (Path(directory) / ('sa-gas-runtime-helper-' + shape + '.json')).write_text(json.dumps(receipt))
            return gas_trace.crosscheck_runtime(self.model, directory)

    def reject_change(self, change, shape='same'):
        receipts = copy.deepcopy(self.receipts)
        change(receipts[shape])
        with self.assertRaises(ValueError):
            self.check(receipts)

    def test_all_five_live_runtime_receipts_remain_accepted(self):
        self.assertEqual(5, len(self.check(self.receipts)))

    def test_missing_native_invocation_cannot_pass_as_runtime_evidence(self):
        for method in ('serialize', 'deserialize', 'both'):
            with self.subTest(method=method):
                self.reject_change(lambda r: r.update(trace=[row for row in r['trace']
                    if row['Method'] not in (('serialize', 'deserialize') if method == 'both' else (method,))]))

    def test_every_native_wrapper_event_is_required_exactly_once(self):
        indices = [i for i, row in enumerate(self.receipts['same']['trace']) if row['Method'] in ('serialize', 'deserialize')]
        for index in indices:
            for action in ('delete', 'duplicate'):
                with self.subTest(index=index, action=action):
                    def mutate(r):
                        if action == 'delete': r['trace'].pop(index)
                        else: r['trace'].insert(index, copy.deepcopy(r['trace'][index]))
                    self.reject_change(mutate)

    def test_native_call_must_follow_its_actual_helper_call(self):
        def reorder(r):
            rows = r['trace']
            start = next(i for i, row in enumerate(rows) if row['Method'] == 'deserialize')
            rows[start - 1:start + 3] = rows[start:start + 3] + [rows[start - 1]]
            for i, row in enumerate(rows): row['Sequence'] = i
        self.reject_change(reorder)

    def test_native_event_identity_and_fee_tampering_rejected(self):
        for field, value in [('ScriptHash', '0x' + '00' * 20), ('Method', 'serialize'),
                             ('OpCode', 'PUSH1'), ('InstructionHex', '11'), ('Pc', 900),
                             ('Completed', False), ('OpcodePico', '1'), ('AdditionalPico', '1'),
                             ('BeforePico', '0'), ('AfterPico', '0'), ('Sequence', 0)]:
            with self.subTest(field=field):
                self.reject_change(lambda r: next(row for row in r['trace']
                    if row['Method'] == 'deserialize' and row['OpCode'] == 'SYSCALL').update({field: value}))

    def test_redistributed_charges_rejected_even_with_unchanged_total(self):
        def redistribute(r):
            index = next(i for i, row in enumerate(r['trace'])
                         if row['Method'] == 'deserialize' and row['OpCode'] == 'PUSH0')
            push, syscall = r['trace'][index:index + 2]
            push['AfterPico'] = str(int(push['AfterPico']) + 1)
            push['AdditionalPico'] = '1'
            syscall['BeforePico'] = str(int(syscall['BeforePico']) + 1)
            syscall['AdditionalPico'] = str(int(syscall['AdditionalPico']) - 1)
        self.reject_change(redistribute)

    def test_core_events_and_final_accounting_cannot_be_forged(self):
        for field, value in [('InstructionHex', '40'), ('ScriptHash', '0x' + '00' * 20),
                             ('Completed', False), ('OpcodePico', '1'), ('AdditionalPico', '1')]:
            with self.subTest(field=field):
                self.reject_change(lambda r: r['trace'][0].update({field: value}))
        for field, value in [('scope', 'unrelated'), ('name', 'helper-reset'), ('fault', True),
                             ('error', 'forged failure'), ('feeConsumedDatoshi', 0), ('rawConsumedPico', '0')]:
            with self.subTest(field=field):
                self.reject_change(lambda r: r.update({field: value}))

    def test_success_trace_cannot_replace_reset_or_fault_coverage(self):
        for shape in ('reset', 'exhausted'):
            receipts = copy.deepcopy(self.receipts)
            receipts[shape] = copy.deepcopy(receipts['same'])
            receipts[shape]['name'] = 'helper-' + shape
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                self.check(receipts)

    def test_fault_requires_incomplete_abort_and_no_return(self):
        self.reject_change(lambda r: r['trace'][-1].update(Completed=True), 'exhausted')
        self.reject_change(lambda r: r.update(fault=False, error=None), 'exhausted')


if __name__ == '__main__':
    unittest.main()
