import os
from pathlib import Path
import re
import unittest
try:
    from . import interop_fee_source as source
    from . import interop_fee_proofs as proofs
except ImportError:
    import interop_fee_source as source
    import interop_fee_proofs as proofs

HERE = Path(__file__).resolve().parent
COQ = HERE/'coq/InteropFee.v'
STEPS = ['validate-call-flags','charge','allocate-vector','pop-and-convert',
         'invoke-handler','push-result']

# The reviewed record, keyed by the *projected* field name. Written once here and
# compared against both the model literal and the renderer.
REVIEWED = [('step_order',STEPS),
            ('charge_reads_the_declared_price',True),('charge_uses_the_exec_factor',True),
            ('charge_skips_the_inner_factor',True),('vector_length_from_descriptor',True),
            ('pops_one_item_per_parameter',True),('arity_from_the_handler_signature',True),
            ('declared_price_type_is_long',True),('declared_price_may_be_zero',True),
            ('negative_fee_is_rejected',True),('whitelist_bypasses_the_charge',True),
            ('factor_applied_only_when_requested',True),
            ('consumed_incremented_before_the_limit_check',True),
            ('limit_check_is_strict',True),('no_fee_inside_the_conversion_window',True)]
REVIEWED_STEPS_LITERAL = '[ValidateFlags; Charge; Allocate; ConvertArgs; Invoke; Push]'


def canonical_literal():
    text = COQ.read_text()
    match = re.search(r'Definition canonical_fee : FeeProgram :=\s*\{\|(.*?)\|\}\.',text,re.S)
    if match is None:
        raise AssertionError('Missing canonical record literal')
    # Split on top-level semicolons only: the step list carries its own.
    parts, depth, current = [], 0, ''
    for character in match.group(1):
        depth += int(character in '{[(') - int(character in '}])')
        if character == ';' and depth == 0:
            parts.append(current)
            current = ''
        else:
            current += character
    parts.append(current)
    return [tuple(piece.strip() for piece in part.split(':=',1))
            for part in parts if ':=' in part]


def pinned_contents(directory):
    contents = {}
    for key,row in source.SOURCES.items():
        path = Path(directory)/(key.replace('/','-')+'.cs')
        contents[key] = path.read_text()
    return contents


class InteropFeeProjectionTests(unittest.TestCase):
    def test_the_reviewed_body_is_accepted_verbatim(self):
        self.assertEqual(set(source.SIGNATURES),
                         {'OnSysCall','AddFee','ConvertParameter','ConvertObject'})
        source.accepted_body(source.ON_SYSCALL)

    def test_each_order_mutation_is_still_accepted(self):
        # Seven mutants rewrite OnSysCall -- the two order moves plus five that
        # edit a statement inside it -- so each needs an enumerated alternate. A
        # mutation that touched OnSysCall without one would be rejected by
        # `accepted_body` before the lane could run.
        self.assertEqual(7,len(source.ALTERNATES))
        for before,after in source.ALTERNATES:
            with self.subTest(after=after[:40]):
                source.accepted_body(source.ON_SYSCALL.replace(before,after))
        self.assertEqual(
            {name for name,(key,_,_) in source.CONTROL_MUTATIONS.items() if key == 'core/engine'
             and source.normalize(source.CONTROL_MUTATIONS[name][1]) in source.ON_SYSCALL},
            {'charge-before-the-flag-check','charge-after-the-conversion-loop',
             'charge-reads-another-price-member','charge-multiplies-by-the-base-factor',
             'ask-add-fee-to-apply-the-factor-again','size-the-vector-from-a-constant',
             'convert-every-parameter-from-the-first-descriptor'})

    def test_an_unreviewed_body_change_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'Unrecognised OnSysCall body'):
            source.accepted_body(source.ON_SYSCALL[:-1]+'Refund();}')

    def test_declaration_ambiguity_and_unknown_tokens_reject(self):
        for text in ['public void M() { } public void M() { }','public void M() { `; }',
                     'public void M() {']:
            with self.subTest(text=text),self.assertRaises(ValueError):
                source.body(text,'public void M()')

    def test_charge_arguments_are_split_at_the_top_level(self):
        arguments = source.charge_arguments(
            '{AddFee(descriptor.FixedPrice*_execFeeFactor,false);}')
        self.assertEqual(['descriptor.FixedPrice*_execFeeFactor','false'],arguments)
        self.assertEqual(['N.mul(a,b)','true'],
                         source.charge_arguments('{AddFee(N.mul(a,b),true);}'))

    def test_step_order_is_read_from_where_the_anchors_sit(self):
        self.assertEqual(STEPS,source.step_order(source.ON_SYSCALL))
        swapped = source.ON_SYSCALL.replace(
            'ValidateCallFlags(descriptor.RequiredCallFlags);AddFee(',
            'AddFee(').replace(',false);object?[]',',false);ValidateCallFlags(descriptor.RequiredCallFlags);object?[]')
        self.assertEqual(['charge','validate-call-flags','allocate-vector',
                          'pop-and-convert','invoke-handler','push-result'],
                         source.step_order(swapped))

    def test_missing_extra_and_duplicate_source_identity_reject(self):
        with self.assertRaises(ValueError):
            source.project_captured({})
        with self.assertRaises(ValueError):
            rows = {k:dict(path='/same/file',url=source.source_url(v),sha256=v['sha256'])
                    for k,v in source.SOURCES.items()}
            rows['extra'] = rows[next(iter(rows))]
            source.project_captured(rows)

    def test_swapped_url_or_unpinned_hash_or_relative_path_reject(self):
        for field,value in [('url','https://example.invalid/source'),('sha256','0'*64),
                            ('path','relative.cs')]:
            rows = {k:dict(path='/missing',url=source.source_url(v),sha256=v['sha256'])
                    for k,v in source.SOURCES.items()}
            rows[next(iter(rows))][field] = value
            with self.subTest(field=field),self.assertRaises(ValueError):
                source.project_captured(rows)

    def test_production_enforces_full_file_hashes(self):
        with self.assertRaisesRegex(ValueError,'Pinned source mismatch'):
            source.project_sources({k:'' for k in source.SOURCES})

    def test_both_pins_live_in_the_same_core_repository(self):
        self.assertEqual({'neo'},{row['repository'] for row in source.SOURCES.values()})
        for row in source.SOURCES.values():
            with self.subTest(key=row['relativePath']):
                self.assertEqual(64,len(row['sha256']))
                self.assertIn('/'+row['commit']+'/',source.source_url(row))


class PinnedMutantTests(unittest.TestCase):
    """Each mutant must move exactly one field; that is the projection's claim."""

    mirror = os.environ.get('SA_INTEROP_CHARGE_SOURCE_MIRROR','')

    def setUp(self):
        if not self.mirror:
            self.skipTest('SA_INTEROP_CHARGE_SOURCE_MIRROR is not set')
        self.contents = pinned_contents(self.mirror)
        self.base = source.project_sources(self.contents)

    def test_every_mutant_moves_exactly_one_field(self):
        covered = set()
        for name in source.EXPECTED_CONTROLS:
            mutant,_ = source.mutated_projection(self.contents,name)
            changed = [key for key in self.base['program']
                       if mutant['program'][key] != self.base['program'][key]]
            with self.subTest(mutant=name):
                self.assertEqual(1,len(changed),changed)
            covered.update(changed)
        self.assertEqual(set(self.base['program']),covered)

    def test_the_projection_matches_the_reviewed_record(self):
        self.assertEqual([name for name,_ in REVIEWED],
                         list(self.base['program']))
        for name,value in REVIEWED:
            with self.subTest(field=name):
                self.assertEqual(value,self.base['program'][name])
                self.assertIs(type(value),type(self.base['program'][name]))

    def test_the_two_order_mutants_land_on_different_orders(self):
        first,_ = source.mutated_projection(self.contents,'charge-before-the-flag-check')
        second,_ = source.mutated_projection(self.contents,'charge-after-the-conversion-loop')
        self.assertEqual(['charge','validate-call-flags','allocate-vector',
                          'pop-and-convert','invoke-handler','push-result'],
                         first['program']['step_order'])
        self.assertEqual(['validate-call-flags','allocate-vector','pop-and-convert',
                          'charge','invoke-handler','push-result'],
                         second['program']['step_order'])

    def test_an_unknown_mutant_rejects(self):
        with self.assertRaisesRegex(ValueError,'Unknown semantic mutant'):
            source.mutated_projection(self.contents,'not-a-mutant')


class ModelProjectionAgreementTests(unittest.TestCase):
    """The Coq record and the projected dict must stay the same shape."""

    def coq_fields(self):
        block = re.search(r'Record FeeProgram := fee_program \{(.*?)\n\}\.',COQ.read_text(),re.S)
        self.assertIsNotNone(block)
        return re.findall(r'^\s*(\w+)\s*:',block.group(1),re.M)

    def test_record_order_matches_the_renderer(self):
        self.assertEqual(self.coq_fields(),[name for name,_,_ in proofs.FIELDS])
        self.assertEqual([projected for _,projected,_ in proofs.FIELDS],
                         [name for name,_ in REVIEWED])

    def test_canonical_record_holds_the_reviewed_literal(self):
        # canonical_fee must stay the value the projection is compared to, so the
        # literal in the model and the reviewed fields are checked against each
        # other rather than against a third restatement.
        pairs = canonical_literal()
        self.assertEqual([name for name,_,_ in proofs.FIELDS],[name for name,_ in pairs])
        for (_,projected,_),(_,token) in zip(proofs.FIELDS,pairs):
            value = dict(REVIEWED)[projected]
            with self.subTest(field=projected):
                if isinstance(value,bool):
                    self.assertEqual('true' if value else 'false',token)
                else:
                    self.assertEqual(REVIEWED_STEPS_LITERAL,token)

    def test_program_expression_round_trips(self):
        program = dict(REVIEWED)
        self.assertEqual('(fee_program '+REVIEWED_STEPS_LITERAL+' true true true true true '
                         'true true true true true true true true true)',
                         proofs.program_expression(program))
        with self.assertRaisesRegex(ValueError,'Incomplete/extra projected program'):
            proofs.program_expression({**program,'extra':1})
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'limit_check_is_strict':'true'})
        # `1 == True` in Python: a same-value integer must not render into a
        # boolean slot, or the certificate would carry a numeric literal there.
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'limit_check_is_strict':1})
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'step_order':REVIEWED_STEPS_LITERAL})
        with self.assertRaisesRegex(ValueError,'Unknown step name'):
            proofs.program_expression({**program,'step_order':['charge','refund']})
        with self.assertRaisesRegex(ValueError,'Empty step order'):
            proofs.program_expression({**program,'step_order':[]})

    def test_every_control_has_one_concrete_case(self):
        self.assertEqual(set(source.EXPECTED_CONTROLS),set(proofs.CONTROL_CASES))
        self.assertEqual(16,len(proofs.CONTROL_CASES))
        for name,(expression,expected) in proofs.CONTROL_CASES.items():
            with self.subTest(name=name):
                self.assertIn('mutant_program',expression)
                self.assertTrue(expected)
                self.assertNotIn('actual_program',expression)
                self.assertNotIn('canonical_fee',expression)

    def test_model_has_no_open_proofs(self):
        text = COQ.read_text()
        for word in ('Admitted','Axiom','admit','Abort'):
            with self.subTest(word=word):
                self.assertIsNone(re.search(r'\b'+word+r'\b',text))
        # The gate rejects the literal capitalised word; the model must not carry
        # one even inside a comment.
        self.assertNotIn('Parameter',text)

    def test_every_declaration_is_printed(self):
        text = COQ.read_text()
        declared = re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',text,re.M)
        printed = re.findall(r'^Print Assumptions (\w+)\.$',text,re.M)
        self.assertEqual(declared,printed)
        self.assertEqual(35,len(declared))

    def test_certificate_declares_what_the_lane_counts(self):
        projection = dict(program=dict(REVIEWED),entryBoundary=source.ENTRY_BOUNDARY)
        certificate = proofs.render_certificate(projection)
        names = proofs.declarations(certificate)
        self.assertEqual(26,len(names))
        self.assertEqual(names,re.findall(r'^Print Assumptions (\w+)\.$',certificate,re.M))
        with self.assertRaisesRegex(ValueError,'Unsupported entry boundary'):
            proofs.render_certificate(dict(program=dict(REVIEWED),entryBoundary='somewhere else'))

    def test_certificate_asserts_every_model_field(self):
        projection = dict(program=dict(REVIEWED),entryBoundary=source.ENTRY_BOUNDARY)
        certificate = proofs.render_certificate(projection)
        for name,_,_ in proofs.FIELDS:
            with self.subTest(field=name):
                self.assertIn(name,certificate)
        for name in ('actual_program_matches_reviewed_semantics',
                     'actual_step_order',
                     'actual_charge_skips_the_inner_factor',
                     'actual_charge_precedes_the_first_pop',
                     'actual_a_faulting_conversion_charges_the_same',
                     'actual_a_rejected_call_charges_nothing',
                     'actual_a_zero_price_charges_nothing',
                     'actual_a_call_one_above_the_limit_is_refused'):
            with self.subTest(declaration=name):
                self.assertIn(name,proofs.declarations(certificate))


class GateAgreementTests(unittest.TestCase):
    """The gate carries its own reviewed copy; a divergence fails here."""

    def gate(self):
        import importlib.util
        path = HERE/'closure.py'
        spec = importlib.util.spec_from_file_location('closure_interop_fee',path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_gate_pins_agree_with_this_lane(self):
        gate = self.gate()
        self.assertEqual(gate.SCOPES['interop-fee-order'],source.SCOPE)
        self.assertEqual(len(gate.SCOPES),22)
        self.assertEqual(gate.CERTIFICATES['interop-fee-order'],
                         ('certificateSha256','InteropFeeArtifact.v'))
        self.assertEqual(tuple(gate.INTEROP_FEE_CONTROLS),source.EXPECTED_CONTROLS)
        self.assertEqual(gate.INTEROP_FEE_PROGRAM,dict(REVIEWED))
        self.assertEqual(gate.INTEROP_FEE_DOMAIN['preconditions'],source.PRECONDITIONS)
        self.assertEqual(gate.INTEROP_FEE_DOMAIN['unproved'],source.UNPROVED)
        self.assertEqual(gate.INTEROP_FEE_DOMAIN['tcb'],source.TCB)
        self.assertNotIn('interop-fee-order',gate.ARTIFACT_LANES)
        self.assertIn('interop_fee_proofs.py',[Path(p).name for p in gate.tool_paths()])

    def test_gate_program_types_are_exact(self):
        # The gate joins by type as well as by value, so a lane that started
        # emitting `1` for a boolean would be rejected rather than accepted.
        gate = self.gate()
        for key,value in gate.INTEROP_FEE_PROGRAM.items():
            with self.subTest(field=key):
                self.assertIs(type(value),type(dict(REVIEWED)[key]))


if __name__ == '__main__':
    unittest.main()
