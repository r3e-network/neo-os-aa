import os
from pathlib import Path
import re
import unittest
try:
    from . import exception_identity_source as source
    from . import exception_identity_proofs as proofs
except ImportError:
    import exception_identity_source as source
    import exception_identity_proofs as proofs

HERE = Path(__file__).resolve().parent
COQ = HERE/'coq/ExceptionIdentity.v'
STEPS = ['read-instruction','guarded-catch','post-hook','advance-pointer','fault-handler']

# The reviewed record, keyed by the *projected* field name. Written once here and
# compared against both the model literal and the renderer.
REVIEWED = [('step_order',STEPS),
            ('catch_names_the_catchable_type',True),
            ('catch_is_guarded_by_the_limit',True),
            ('the_generic_handler_is_untyped',True),
            ('the_caught_value_is_the_message',True),
            ('the_fault_sets_the_state',True),
            ('the_thrown_value_is_recorded_at_entry',True),
            ('a_handler_clears_the_recorded_value',True),
            ('the_handler_receives_the_thrown_value',True),
            ('the_walk_skips_the_finally_and_consumed_catch',True),
            ('an_absent_handler_wraps_the_value',True),
            ('a_dedicated_catchable_type_exists',True),
            ('the_wrapper_keeps_the_thrown_object',True),
            ('the_engine_records_the_fault',True),
            ('the_engine_clears_the_notifications',True),
            ('the_limit_defaults_to_catching',True)]
REVIEWED_STEPS_LITERAL = '[ReadInstruction; GuardedCatch; PostHook; AdvancePointer; FaultHandler]'


def canonical_literal():
    text = COQ.read_text()
    match = re.search(r'Definition reviewed_program : CatchProgram :=\s*\{\|(.*?)\|\}\.',text,re.S)
    if match is None:
        raise AssertionError('Missing reviewed record literal')
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


def steps_definition():
    """The step list the reviewed record points at, as one spaced line."""
    match = re.search(r'Definition canonical_steps : list ExecStep :=\s*(.*?)\.',
                      COQ.read_text(),re.S)
    if match is None:
        raise AssertionError('Missing canonical step list')
    return ' '.join(match.group(1).split())


def pinned_contents(directory):
    contents = {}
    for key in source.SOURCES:
        path = Path(directory)/(key.replace('/','-')+'.cs')
        contents[key] = path.read_text()
    return contents


class ExceptionIdentityProjectionTests(unittest.TestCase):
    def test_the_lane_reads_four_declarations(self):
        self.assertEqual(set(source.SIGNATURES),
                         {'ExecuteNext','OnFaultVm','ExecuteThrow','OnFaultEngine'})
        self.assertEqual([source.SIGNATURES[name][0] for name in
                          ('ExecuteNext','OnFaultVm','ExecuteThrow','OnFaultEngine')],
                         ['vm/engine','vm/engine','vm/control','core/engine'])

    def test_a_disabled_region_is_not_read_at_all(self):
        # The shared tokenizer has no `#` token, but dropping the directive line
        # and keeping the body was still a reading the compiler does not share:
        # with `VMPERF` undefined the region is disabled text. Both VMPERF
        # regions in the pinned engine file only print, which is why this
        # changes no field — and precisely why it has to be read correctly
        # rather than conveniently.
        text = 'a\n#if VMPERF\n  b\n#endif\nc\n'
        self.assertEqual('a\nc\n', source.strip_directives(text))
        # The same lines are kept when the symbol is defined, so the rule is a
        # reading of the condition and not a blanket deletion.
        self.assertEqual('a\n  b\nc\n', source.strip_directives(text, ('VMPERF',)))
        # A directive that does not control text keeps the text beneath it.
        self.assertEqual('a\n  b\nc\n', source.strip_directives('a\n#region R\n  b\n#endregion\nc\n'))

    def test_declaration_ambiguity_and_unknown_tokens_reject(self):
        for text in ['void M() { } void M() { }','void M() { `; }','void M() {']:
            with self.subTest(text=text),self.assertRaises(ValueError):
                source.body(text,'void M()')

    def test_step_order_is_read_from_where_the_anchors_sit(self):
        body = ('{Instruction?currentInstruction=context.CurrentInstruction;'
                'JumpTable.ExecuteThrow(this,ex.Message);'
                'PostExecuteInstruction(instruction);'
                'context.InstructionPointer+=instruction.Size;'
                'OnFault(e);}')
        self.assertEqual(STEPS,source.step_order(body))
        swapped = body.replace(
            'PostExecuteInstruction(instruction);context.InstructionPointer+=instruction.Size;',
            'context.InstructionPointer+=instruction.Size;PostExecuteInstruction(instruction);')
        self.assertEqual(['read-instruction','guarded-catch','advance-pointer','post-hook',
                          'fault-handler'],source.step_order(swapped))

    def test_a_missing_anchor_rejects(self):
        with self.assertRaisesRegex(ValueError,'Missing step anchor'):
            source.step_order('{OnFault(e);}')

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

    def test_the_pins_span_both_repositories_and_five_vm_files(self):
        self.assertEqual({'neo','neo-vm'},{row['repository'] for row in source.SOURCES.values()})
        vm = [row for row in source.SOURCES.values() if row['repository'] == 'neo-vm']
        self.assertEqual(5,len(vm))
        self.assertEqual({source.VM_COMMIT},{row['commit'] for row in vm})
        for row in source.SOURCES.values():
            with self.subTest(key=row['relativePath']):
                self.assertEqual(64,len(row['sha256']))
                self.assertIn('/'+row['commit']+'/',source.source_url(row))

    def test_the_two_reused_pins_carry_the_identities_other_lanes_already_recorded(self):
        # The limits and the jump table were already pinned by other lanes; a
        # different hash here would mean the lane read a different file.
        self.assertEqual('b8353f47f18aec5093426b550a231c7ce1e2201e636e806f177ffcb9043374b4',
                         source.SOURCES['vm/limits']['sha256'])
        self.assertEqual('a0ac51ff220abbfcf8fb8c19bb0f2b8be4680169ba8ba33f6ededfc5e5e6a2ec',
                         source.SOURCES['vm/control']['sha256'])
        self.assertEqual('97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb',
                         source.SOURCES['core/engine']['sha256'])


class PinnedMutantTests(unittest.TestCase):
    """Each mutant must move exactly one field; that is the projection's claim."""

    mirror = os.environ.get('SA_EXCEPTION_IDENTITY_SOURCE_MIRROR','')

    def setUp(self):
        if not self.mirror:
            self.skipTest('SA_EXCEPTION_IDENTITY_SOURCE_MIRROR is not set')
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

    def test_the_swap_mutant_lands_on_a_different_order(self):
        mutant,_ = source.mutated_projection(self.contents,'swap-the-hook-and-the-pointer-advance')
        self.assertEqual(['read-instruction','guarded-catch','advance-pointer','post-hook',
                          'fault-handler'],mutant['program']['step_order'])

    def test_an_unknown_mutant_rejects(self):
        with self.assertRaisesRegex(ValueError,'Unknown semantic mutant'):
            source.mutated_projection(self.contents,'not-a-mutant')


class ModelProjectionAgreementTests(unittest.TestCase):
    """The Coq record and the projected dict must stay the same shape."""

    def coq_fields(self):
        block = re.search(r'Record CatchProgram := catch_program \{(.*?)\n\}\.',COQ.read_text(),re.S)
        self.assertIsNotNone(block)
        return re.findall(r'^\s*(\w+)\s*:',block.group(1),re.M)

    def test_record_order_matches_the_renderer(self):
        self.assertEqual(self.coq_fields(),[name for name,_,_ in proofs.FIELDS])
        self.assertEqual([projected for _,projected,_ in proofs.FIELDS],
                         [name for name,_ in REVIEWED])

    def test_reviewed_record_holds_the_reviewed_literal(self):
        # reviewed_program must stay the value the projection is compared to, so
        # the literal in the model and the reviewed fields are checked against
        # each other rather than against a third restatement.
        pairs = canonical_literal()
        self.assertEqual([name for name,_,_ in proofs.FIELDS],[name for name,_ in pairs])
        for (_,projected,_),(_,token) in zip(proofs.FIELDS,pairs):
            value = dict(REVIEWED)[projected]
            with self.subTest(field=projected):
                if isinstance(value,bool):
                    self.assertEqual('true' if value else 'false',token)
                else:
                    # The record points at the named list; the list itself is
                    # what has to hold the reviewed order.
                    self.assertEqual('canonical_steps',token)
                    self.assertEqual(REVIEWED_STEPS_LITERAL,steps_definition())

    def test_program_expression_round_trips(self):
        program = dict(REVIEWED)
        expected = ('(catch_program '+REVIEWED_STEPS_LITERAL+' '
                    +' '.join('true' for _ in range(15))+')')
        self.assertEqual(expected,proofs.program_expression(program))
        with self.assertRaisesRegex(ValueError,'Incomplete/extra projected program'):
            proofs.program_expression({**program,'extra':1})
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'the_fault_sets_the_state':'true'})
        # `1 == True` in Python: a same-value integer must not render into a
        # boolean slot, or the certificate would carry a numeric literal there.
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'the_fault_sets_the_state':1})
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'step_order':REVIEWED_STEPS_LITERAL})
        with self.assertRaisesRegex(ValueError,'Unknown step name'):
            proofs.program_expression({**program,'step_order':['fault-handler','refund']})
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
                self.assertNotIn('reviewed_program',expression)

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
        self.assertEqual(29,len(declared))

    def test_certificate_declares_what_the_lane_counts(self):
        projection = dict(program=dict(REVIEWED),entryBoundary=source.ENTRY_BOUNDARY)
        certificate = proofs.render_certificate(projection)
        names = proofs.declarations(certificate)
        self.assertEqual(30,len(names))
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
                     'actual_the_caught_value_is_the_message',
                     'actual_the_catch_sits_before_the_fault_handler',
                     'actual_turning_the_limit_off_removes_catchability',
                     'actual_an_uncatchable_exception_never_reaches_a_handler',
                     'actual_the_contract_receives_the_message',
                     'actual_the_fault_path_clears_the_notifications',
                     'actual_failures_the_engine_does_not_catch_are_indistinguishable',
                     'actual_the_reviewed_record_admits_a_catchable_throw'):
            with self.subTest(declaration=name):
                self.assertIn(name,proofs.declarations(certificate))


class GateAgreementTests(unittest.TestCase):
    """The gate carries its own reviewed copy; a divergence fails here."""

    def gate(self):
        import importlib.util
        path = HERE/'closure.py'
        spec = importlib.util.spec_from_file_location('closure_exception_identity',path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_gate_pins_agree_with_this_lane(self):
        gate = self.gate()
        self.assertEqual(gate.SCOPES['exception-identity'],source.SCOPE)
        self.assertEqual(len(gate.SCOPES),22)
        self.assertEqual(gate.CERTIFICATES['exception-identity'],
                         ('certificateSha256','ExceptionIdentityArtifact.v'))
        self.assertEqual(tuple(gate.EXCEPTION_IDENTITY_CONTROLS),source.EXPECTED_CONTROLS)
        self.assertEqual(gate.EXCEPTION_IDENTITY_PROGRAM,dict(REVIEWED))
        self.assertEqual(gate.EXCEPTION_IDENTITY_DOMAIN['preconditions'],source.PRECONDITIONS)
        self.assertEqual(gate.EXCEPTION_IDENTITY_DOMAIN['unproved'],source.UNPROVED)
        self.assertEqual(gate.EXCEPTION_IDENTITY_DOMAIN['tcb'],source.TCB)
        self.assertNotIn('exception-identity',gate.ARTIFACT_LANES)
        self.assertIn('exception_identity_proofs.py',[Path(p).name for p in gate.tool_paths()])

    def test_gate_sources_agree_with_this_lane(self):
        # The gate keeps its own copy of the pin set, so a lane that quietly
        # swapped a file for a sibling would not agree on repository or path.
        gate = self.gate()
        self.assertEqual(set(gate.EXCEPTION_IDENTITY_SOURCES),set(source.SOURCES))
        for key,row in source.SOURCES.items():
            with self.subTest(key=key):
                commit,path = gate.EXCEPTION_IDENTITY_SOURCES[key]
                self.assertEqual((row['commit'],row['relativePath']),(commit,path))

    def test_gate_program_types_are_exact(self):
        # The gate joins by type as well as by value, so a lane that started
        # emitting `1` for a boolean would be rejected rather than accepted.
        gate = self.gate()
        for key,value in gate.EXCEPTION_IDENTITY_PROGRAM.items():
            with self.subTest(field=key):
                self.assertIs(type(value),type(dict(REVIEWED)[key]))


if __name__ == '__main__':
    unittest.main()
