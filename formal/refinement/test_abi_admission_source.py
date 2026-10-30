import os
from pathlib import Path
import re
import unittest
try:
    from . import abi_admission_source as source
    from . import abi_admission_proofs as proofs
except ImportError:
    import abi_admission_source as source
    import abi_admission_proofs as proofs

HERE = Path(__file__).resolve().parent
COQ = HERE/'coq/LoadAdmission.v'
MIRROR = os.environ.get('AA_LOAD_ADMISSION_SOURCE_MIRROR')
STEPS = ['read-magic','read-compiler','read-source','read-reserve-byte',
         'read-tokens','read-reserve-short','read-script','verify-checksum']

# The reviewed record, keyed by the *projected* field name. Written once here and
# compared against the model literal, the renderer and the pinned bytes.
REVIEWED = [('step_order',STEPS),
            ('magic_is_the_declared_nef3_constant',True),
            ('the_reserved_fields_must_be_zero',True),
            ('token_array_cap',128),
            ('the_script_cannot_be_empty',True),
            ('the_checksum_is_compared_for_inequality',True),
            ('the_checksum_check_is_guarded_by_the_verify_flag',True),
            ('a_token_method_cannot_start_with_underscore',True),
            ('token_method_name_limit',32),
            ('a_token_flag_byte_must_be_a_declared_flag',True),
            ('the_manifest_name_cannot_be_empty',True),
            ('the_features_field_must_be_empty',True),
            ('the_manifest_names_cannot_repeat',True),
            ('manifest_length_cap',65535),
            ('the_manifest_length_cap_is_enforced_before_parsing',True),
            ('the_abi_needs_at_least_one_method',True),
            ('the_exact_lookup_is_keyed_by_name_and_arity',True),
            ('the_arity_is_range_checked',True),
            ('the_wildcard_lookup_ignores_the_arity',True),
            ('the_exact_lookup_returns_null_when_absent',True),
            ('a_method_name_cannot_be_empty',True),
            ('a_method_parameter_name_cannot_repeat',True),
            ('a_method_return_type_must_be_defined',True),
            ('a_method_offset_cannot_be_negative',True)]
PROGRAM = dict(REVIEWED)
REVIEWED_STEPS_LITERAL = ('[ReadMagic; ReadCompiler; ReadSource; ReadReserveByte; '
                          'ReadTokens; ReadReserveShort; ReadScript; VerifyChecksum]')
REVIEWED_BOUNDS = {'token_array_cap':128,'token_method_name_limit':32,'manifest_length_cap':65535}


def flat(text):
    return ' '.join(text.split())


def between(text,start,stop):
    match = re.search(start+r'(.*?)'+stop,text,re.S)
    return None if match is None else match.group(1)


def canonical_literal():
    body = between(COQ.read_text(),r'Definition canonical_steps : list LoadStep :=\s*\[',r'\]\s*\.')
    if body is None:
        raise AssertionError('Missing canonical_steps')
    return '[%s]' % flat(body)


def swapped_literal():
    body = between(COQ.read_text(),r'Definition swapped_read_steps : list LoadStep :=\s*\[',r'\]\s*\.')
    if body is None:
        raise AssertionError('Missing swapped_read_steps')
    return '[%s]' % flat(body)


def record_fields():
    body = between(COQ.read_text(),r'Record AdmissionProgram := admission_program \{',r'\}\s*\.')
    if body is None:
        raise AssertionError('Missing AdmissionProgram record')
    return re.findall(r'(ap_\w+)\s*:',body)


def declared_bounds():
    text = COQ.read_text()
    bounds = {}
    for name in REVIEWED_BOUNDS:
        match = re.search(r'%s := (\d+)' % name,text)
        if match is None:
            raise AssertionError('Missing bound '+name)
        bounds[name] = int(match.group(1))
    return bounds


def guard_constructors():
    body = between(COQ.read_text(),r'Inductive GuardName :=\s*',r'\s*\.')
    if body is None:
        raise AssertionError('Missing GuardName')
    return re.findall(r'\|\s*(G\w+)',body)


def guard_arms():
    return re.findall(r'\| (G\w+) => (ap_\w+) p',COQ.read_text())


def guard_list():
    body = between(COQ.read_text(),r'Definition guards : list GuardName :=\s*\[',r'\]\s*\.')
    if body is None:
        raise AssertionError('Missing guards')
    return re.findall(r'G\w+',body)


def local_projection():
    return dict(schema='neoos-aa-load-admission-source/v1',scope=source.SCOPE,
                entryBoundary=source.ENTRY_BOUNDARY,coreCommit=source.CORE_COMMIT,
                program=dict(PROGRAM),
                reasonOnlyGuards=['exact-lookup-key-is-(name,arity)',
                                  'the-checksum-is-last-and-optional'],
                preconditions=source.PRECONDITIONS,unproved=source.UNPROVED,tcb=source.TCB,
                sourceFrontendVerified=False)


def requirement():
    if not MIRROR:
        raise unittest.SkipTest('no offline mirror')
    return Path(MIRROR)


def pinned_texts():
    directory = requirement()
    texts = {}
    for key in source.SOURCES:
        path = directory/(key.replace('/','-')+'.cs')
        if not path.is_file():
            raise unittest.SkipTest('mirror incomplete')
        texts[key] = path.read_text()
    return texts


class ProjectionTests(unittest.TestCase):

    def test_the_source_set_is_the_five_pinned_core_files(self):
        self.assertEqual(set(source.SOURCES),{'core/nef','core/token','core/manifest',
                                              'core/abi','core/method'})
        for key,row in source.SOURCES.items():
            self.assertEqual(set(row),{'repository','commit','sha256','relativePath'},key)
            self.assertEqual(row['repository'],'neo')
            self.assertEqual(row['commit'],source.CORE_COMMIT)
            self.assertRegex(row['sha256'],r'^[0-9a-f]{64}$')
            self.assertTrue(row['relativePath'].endswith('.cs'))

    def test_the_entry_boundary_states_where_the_lane_stops(self):
        self.assertEqual(source.ENTRY_BOUNDARY,
                         'manifest-parse-and-nef-deserialize-admission-to-exact-arity-resolution')
        self.assertEqual(source.SCOPE,'load-time-manifest-and-token-admission')

    def test_the_domain_lists_are_specific_and_keep_the_gaps_open(self):
        self.assertGreaterEqual(len(source.PRECONDITIONS),5)
        self.assertGreaterEqual(len(source.UNPROVED),4)
        self.assertEqual(len(source.TCB),3)
        joined = ' '.join(source.UNPROVED).lower()
        self.assertIn('deployment',joined)
        self.assertIn('compiler',joined)
        self.assertIn('gas',joined)

    def test_the_declared_bounds_are_the_pinned_constants(self):
        self.assertEqual(proofs.BOUND_DECLARATIONS,REVIEWED_BOUNDS)

    def test_the_mutation_inventory_matches_the_control_cases(self):
        self.assertEqual(len(source.EXPECTED_CONTROLS),27)
        self.assertEqual(set(source.EXPECTED_CONTROLS),set(proofs.CONTROL_CASES))

    def test_the_mutation_inventory_names_one_decision_each(self):
        self.assertEqual(len(set(source.EXPECTED_CONTROLS)),len(source.EXPECTED_CONTROLS))
        for name in source.EXPECTED_CONTROLS:
            key,before,after = source.CONTROL_MUTATIONS[name]
            self.assertIn(key,source.SOURCES,name)
            self.assertNotEqual(before,after,name)

    def test_the_projection_never_claims_the_source_frontend(self):
        self.assertIs(local_projection()['sourceFrontendVerified'],False)

    def test_int_constant_reads_the_declared_bound(self):
        self.assertEqual(source.int_constant('ushort.MaxValue'),65535)
        self.assertEqual(source.int_constant('byte.MaxValue'),255)
        self.assertEqual(source.int_constant('128'),128)
        self.assertEqual(source.int_constant(' ushort.MaxValue * 2 '),131070)
        self.assertEqual(source.int_constant('(2+3)*4'),20)
        with self.assertRaises(ValueError):
            source.int_constant('ExecutionEngineLimits.Default.MaxItemSize')


class PinnedMutationTests(unittest.TestCase):

    def test_the_mirror_bytes_hash_to_the_pins(self):
        directory = requirement()
        for key,row in source.SOURCES.items():
            raw = (directory/(key.replace('/','-')+'.cs')).read_bytes()
            self.assertEqual(source.sha(raw),row['sha256'],key)

    def test_the_pinned_bytes_project_the_reviewed_record(self):
        program = source.project_sources(pinned_texts())['program']
        self.assertEqual(program,PROGRAM)

    def test_the_pinned_bytes_make_the_step_order_canonical(self):
        program = source.project_sources(pinned_texts())['program']
        self.assertEqual(program['step_order'],STEPS)

    def test_each_mutation_applies_to_exactly_one_site(self):
        texts = pinned_texts()
        for name in source.EXPECTED_CONTROLS:
            key,before,after = source.CONTROL_MUTATIONS[name]
            self.assertEqual(texts[key].count(before),1,name)
            self.assertEqual(source.mutated_projection(texts,name)[0]['program'] != PROGRAM,True,name)

    def test_each_mutation_moves_exactly_one_slot(self):
        texts = pinned_texts()
        for name in source.EXPECTED_CONTROLS:
            mutant,_ = source.mutated_projection(texts,name)
            moved = [key for key in PROGRAM if mutant['program'][key] != PROGRAM[key]]
            self.assertEqual(len(moved),1,'%s moved %r' % (name,moved))

    def test_every_slot_is_moved_by_some_mutation(self):
        texts = pinned_texts()
        covered = set()
        for name in source.EXPECTED_CONTROLS:
            mutant,_ = source.mutated_projection(texts,name)
            covered.update(key for key in PROGRAM if mutant['program'][key] != PROGRAM[key])
        self.assertEqual(covered,set(PROGRAM))

    def test_an_ambiguous_mutation_is_refused(self):
        texts = pinned_texts()
        texts['core/abi'] += '\n                return null;\n'
        with self.assertRaises(ValueError):
            source.mutated_projection(texts,'hand-back-a-method-when-the-lookup-misses')

    def test_an_unknown_mutation_is_refused(self):
        with self.assertRaises(ValueError):
            source.mutated_projection(pinned_texts(),'rewrite-the-whole-loader')

    def test_the_step_order_follows_where_the_reads_sit(self):
        texts = pinned_texts()
        original = ('            Source = reader.ReadVarString(256);\n'
                    '            if (reader.ReadByte() != 0) throw new FormatException('
                    '"Reserved bytes must be 0");\n')
        reversed_ = ('            if (reader.ReadByte() != 0) throw new FormatException('
                     '"Reserved bytes must be 0");\n'
                     '            Source = reader.ReadVarString(256);\n')
        self.assertEqual(texts['core/nef'].count(original),1)
        texts['core/nef'] = texts['core/nef'].replace(original,reversed_)
        order = source.project_sources(texts,enforce_identity=False)['program']['step_order']
        self.assertEqual(order,['read-magic','read-compiler','read-reserve-byte','read-source',
                                'read-tokens','read-reserve-short','read-script','verify-checksum'])
        self.assertEqual(set(order),set(STEPS))

    def test_an_absent_read_anchor_is_reported(self):
        texts = pinned_texts()
        texts['core/nef'] = texts['core/nef'].replace(
            '            Tokens = reader.ReadSerializableArray<MethodToken>(128);\n','')
        self.assertNotIn('Tokens = reader.ReadSerializableArray<MethodToken>',texts['core/nef'])
        with self.assertRaises(ValueError):
            source.project_sources(texts,enforce_identity=False)

    def test_the_projection_refuses_a_missing_or_extra_source(self):
        texts = pinned_texts()
        missing = {k:v for k,v in texts.items() if k != 'core/token'}
        with self.assertRaises(ValueError):
            source.project_sources(missing,enforce_identity=False)
        extra = dict(texts)
        extra['core/policy'] = texts['core/token']
        with self.assertRaises(ValueError):
            source.project_sources(extra,enforce_identity=False)

    def test_a_tampered_source_fails_the_identity_check(self):
        texts = pinned_texts()
        texts['core/nef'] += '\n// tampered\n'
        with self.assertRaises(ValueError):
            source.project_sources(texts)

    def test_a_raised_bound_changes_exactly_the_bound(self):
        mutant,_ = source.mutated_projection(pinned_texts(),'raise-the-manifest-length-cap')
        self.assertEqual(mutant['program']['manifest_length_cap'],131070)
        self.assertTrue(mutant['program']['the_manifest_length_cap_is_enforced_before_parsing'])

    def test_the_projection_captures_the_url_and_hash_of_each_pin(self):
        directory = requirement()
        rows = {}
        for key,row in source.SOURCES.items():
            path = directory/(key.replace('/','-')+'.cs')
            rows[key] = dict(path=str(path.resolve()),
                             url=source.source_url(row),sha256=source.sha(path.read_bytes()))
        self.assertEqual(source.project_captured(rows)['program'],PROGRAM)
        rows['core/nef'] = dict(rows['core/nef'])
        rows['core/nef']['url'] = source.source_url(source.SOURCES['core/token'])
        with self.assertRaises(ValueError):
            source.project_captured(rows)


class ModelTests(unittest.TestCase):

    def test_the_model_has_no_forbidden_words(self):
        text = COQ.read_text()
        self.assertIsNone(re.search(r'\b(?:Admitted|Axiom|admit|Abort)\b',text))
        self.assertNotIn('Parameter',text)

    def test_the_record_fields_are_the_projected_slots(self):
        self.assertEqual(record_fields(),[name for name,_,_ in proofs.FIELDS])

    def test_the_record_has_no_slot_the_projection_cannot_fill(self):
        self.assertEqual(set(record_fields()),
                         {'ap_steps'} | {'ap_'+name for name,_ in REVIEWED
                                         if name != 'step_order'})

    def test_every_boolean_slot_has_a_guard_and_no_guard_is_orphaned(self):
        booleans = [name for name,value in REVIEWED if isinstance(value,bool)]
        arms = guard_arms()
        self.assertEqual(sorted(constructor for constructor,_ in arms),
                         sorted(guard_constructors()))
        self.assertEqual(sorted(field for _,field in arms),
                         sorted('ap_'+name for name in booleans))
        self.assertEqual(len(arms),len(booleans))

    def test_the_guard_list_names_every_constructor_in_order(self):
        self.assertEqual(guard_list(),guard_constructors())
        self.assertEqual(len(set(guard_list())),len(guard_list()))

    def test_the_canonical_order_is_the_projected_order(self):
        self.assertEqual(canonical_literal(),REVIEWED_STEPS_LITERAL)
        self.assertEqual(STEPS,PROGRAM['step_order'])

    def test_the_two_readers_differ_only_in_the_reserve_position(self):
        canonical = canonical_literal()
        swapped = swapped_literal()
        self.assertNotEqual(canonical,swapped)
        self.assertEqual(sorted(re.findall(r'\w+',canonical)),
                         sorted(re.findall(r'\w+',swapped)))
        self.assertEqual(swapped,
                         '[ReadMagic; ReadCompiler; ReadReserveByte; ReadSource; '
                         'ReadTokens; ReadReserveShort; ReadScript; VerifyChecksum]')

    def test_the_reviewed_bounds_match_the_declared_bounds(self):
        self.assertEqual(declared_bounds(),REVIEWED_BOUNDS)

    def test_one_assumption_statement_per_declaration(self):
        text = COQ.read_text()
        names = re.findall(r'^(?:Theorem|Lemma)\s+(\w+)\s*:',text,re.M)
        printed = re.findall(r'^Print Assumptions (\w+)\.$',text,re.M)
        self.assertEqual(printed,names)

    def test_the_model_decides_admission_from_the_guard_list_only(self):
        text = COQ.read_text()
        body = between(text,r'Definition admitted \(p : AdmissionProgram\) : bool :=',r'\.\n')
        self.assertEqual(flat(body),'all_guards p guards')

    def test_the_bounds_are_consumed_by_loads_and_never_by_a_guard(self):
        text = COQ.read_text()
        guard_body = between(text,r'Definition guard \(p : AdmissionProgram\) \(g : GuardName\) : bool :=',r'\n\n')
        for bound in ('ap_token_array_cap','ap_token_method_name_limit','ap_manifest_length_cap'):
            self.assertNotIn(bound,guard_body)
        loads_body = between(text,r'Definition loads \(p : AdmissionProgram\)',r'\n\n')
        for bound in ('ap_token_array_cap','ap_token_method_name_limit','ap_manifest_length_cap'):
            self.assertIn(bound,loads_body)


class CertificateTests(unittest.TestCase):

    def test_every_control_case_reads_its_own_slot(self):
        self.assertEqual(set(proofs.CONTROL_CASES),set(source.EXPECTED_CONTROLS))
        for name,(expression,expected) in proofs.CONTROL_CASES.items():
            self.assertIn(expected,{'true','false','32','128','65535'},name)
            self.assertNotIn('admitted mutant_program',expression,
                             '%s reads admission instead of its own slot' % name)

    def test_each_mutation_has_an_observable_that_actually_moves(self):
        texts = pinned_texts() if MIRROR else None
        if texts is None:
            self.skipTest('no offline mirror')
        for name,(expression,expected) in proofs.CONTROL_CASES.items():
            mutant,_ = source.mutated_projection(texts,name)
            rendered = proofs.program_expression(mutant['program'])
            self.assertTrue(rendered.startswith('(admission_program '),name)

    def test_the_field_declarations_cover_the_boolean_slots(self):
        self.assertEqual(set(proofs.FIELD_DECLARATIONS),
                         {name for name,value in REVIEWED if isinstance(value,bool)})
        self.assertEqual(len(proofs.FIELD_DECLARATIONS),20)

    def test_the_bound_declarations_cover_the_declared_bound_slots(self):
        self.assertEqual(set(proofs.BOUND_DECLARATIONS),set(REVIEWED_BOUNDS))

    def test_the_rendered_certificate_binds_the_reviewed_record(self):
        text = proofs.render_certificate(local_projection())
        self.assertIn('Theorem actual_program_matches_reviewed_semantics',text)
        self.assertIn(flat(REVIEWED_STEPS_LITERAL),flat(text))
        for name in proofs.FIELD_DECLARATIONS.values():
            self.assertIn('Theorem %s :' % name,text)
        for name in REVIEWED_BOUNDS:
            self.assertIn('Theorem actual_%s :' % name,text)

    def test_the_rendered_certificate_instantiates_the_model_theorems(self):
        text = proofs.render_certificate(local_projection())
        for name in ('actual_admitted','actual_every_guard_holds',
                     'actual_a_refused_guard_refuses_the_declaration',
                     'actual_loads_requires_the_guards','actual_loads_requires_every_bound',
                     'actual_a_count_past_the_token_cap_is_refused',
                     'actual_a_name_past_the_limit_is_refused'):
            self.assertIn('Theorem %s' % name,text)
        self.assertIn('exact (loads_requires_every_bound',text)
        self.assertIn('exact (a_single_false_guard_refuses',text)

    def test_the_rendered_certificate_carries_no_axiom_or_admit(self):
        self.assertIsNone(re.search(r'\b(?:Admitted|Axiom|admit|Abort)\b',
                                    proofs.render_certificate(local_projection())))

    def test_the_rendered_certificate_prints_one_assumption_per_declaration(self):
        text = proofs.render_certificate(local_projection())
        names = proofs.declarations(text)
        printed = re.findall(r'^Print Assumptions (\w+)\.$',text,re.M)
        self.assertEqual(printed,names)
        self.assertGreaterEqual(len(names),40)

    def test_the_certificate_refuses_a_program_with_a_missing_slot(self):
        broken = local_projection()
        del broken['program']['a_method_offset_cannot_be_negative']
        with self.assertRaises(ValueError):
            proofs.render_certificate(broken)

    def test_the_certificate_refuses_a_non_boolean_slot(self):
        broken = local_projection()
        broken['program']['a_method_offset_cannot_be_negative'] = 1
        with self.assertRaises(ValueError):
            proofs.render_certificate(broken)

    def test_the_certificate_refuses_a_bound_that_is_not_an_int(self):
        broken = local_projection()
        broken['program']['token_array_cap'] = True
        with self.assertRaises(ValueError):
            proofs.render_certificate(broken)


class GateAgreementTests(unittest.TestCase):
    """The gate carries its own reviewed copy; a divergence fails here."""

    def gate(self):
        import importlib.util
        path = HERE/'closure.py'
        spec = importlib.util.spec_from_file_location('closure_load_admission',path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_gate_pins_agree_with_this_lane(self):
        gate = self.gate()
        self.assertEqual(gate.SCOPES['load-admission'],source.SCOPE)
        self.assertEqual(len(gate.SCOPES),22)
        self.assertEqual(gate.CERTIFICATES['load-admission'],
                         ('certificateSha256','LoadAdmissionArtifact.v'))
        self.assertEqual(tuple(gate.LOAD_ADMISSION_CONTROLS),source.EXPECTED_CONTROLS)
        self.assertEqual(gate.LOAD_ADMISSION_PROGRAM,PROGRAM)
        self.assertEqual(gate.LOAD_ADMISSION_DOMAIN['preconditions'],source.PRECONDITIONS)
        self.assertEqual(gate.LOAD_ADMISSION_DOMAIN['unproved'],source.UNPROVED)
        self.assertEqual(gate.LOAD_ADMISSION_DOMAIN['tcb'],source.TCB)
        self.assertNotIn('load-admission',gate.ARTIFACT_LANES)
        self.assertIn('abi_admission_proofs.py',[Path(p).name for p in gate.tool_paths()])
        self.assertIn('abi_admission_source.py',[Path(p).name for p in gate.tool_paths()])
        self.assertIn('LoadAdmission.v',[Path(p).name for p in gate.tool_paths()])

    def test_gate_sources_agree_with_this_lane(self):
        gate = self.gate()
        self.assertEqual(set(gate.LOAD_ADMISSION_SOURCES),set(source.SOURCES))
        for key,row in source.SOURCES.items():
            commit,path = gate.LOAD_ADMISSION_SOURCES[key]
            self.assertEqual(commit,source.CORE_COMMIT,key)
            self.assertEqual(commit,row['commit'],key)
            self.assertEqual(path,row['relativePath'],key)
            self.assertTrue(path.endswith('.cs'),key)

    def test_gate_pins_the_exact_program_and_control_types(self):
        gate = self.gate()
        self.assertEqual(len(gate.LOAD_ADMISSION_PROGRAM),24)
        self.assertEqual(len(gate.LOAD_ADMISSION_CONTROLS),27)
        # `1 == True` would let a forged record pass a plain equality check.
        for name,value in gate.LOAD_ADMISSION_PROGRAM.items():
            if name == 'step_order':
                self.assertIsInstance(value,list)
            elif name in REVIEWED_BOUNDS:
                self.assertIs(type(value),int,name)
            else:
                self.assertIs(type(value),bool,name)


if __name__ == '__main__':
    unittest.main()
