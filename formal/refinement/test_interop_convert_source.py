import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock
try:
    from . import interop_convert_source as source
    from . import interop_convert_proofs as proofs
except ImportError:
    import interop_convert_source as source
    import interop_convert_proofs as proofs

COQ = Path(__file__).resolve().parent/'coq/InteropConvert.v'

# The reviewed record, keyed by the *projected* field name. Written once here and
# compared against both the model literal and the renderer.
REVIEWED = [('argument_count',4),('argument_count_from_descriptor',True),
            ('pops_one_item_per_parameter',True),('pop_order_is_reversed',True),
            ('return_pushes_only_for_nonvoid_handler',True),('return_payload_drops_nulls',True),
            ('array_branch_excludes_byte_element',True),
            ('array_element_converter_from_element_type',True),
            ('enum_converter_from_underlying_type',True),('unknown_type_is_interface',True),
            ('identity_converter_for_plain_array',True),
            ('payload_branch_length_is_item_count',True),
            ('payload_branch_fills_in_index_order',True),
            ('counted_branch_fills_in_index_order',True),('counted_branch_pops_the_count',True),
            ('counted_branch_max_length',2048),('null_argument_rejected',True),
            ('null_element_rejected_in_payload_branch',True),
            ('null_element_rejected_in_counted_branch',True)]


class InteropConvertProjectionTests(unittest.TestCase):
    def test_every_reviewed_body_is_accepted_verbatim(self):
        # `CallContract` is pinned as a declaration only: this lane reads its
        # argument list, not its body, so it has no reviewed body to accept.
        self.assertEqual(set(source.TEMPLATES),set(source.METHODS))
        self.assertEqual(set(source.SIGNATURES),set(source.METHODS)|{'CallContract'})
        for name,text in source.TEMPLATES.items():
            with self.subTest(name=name):
                source.accepted_body(name,text)

    def test_one_enumerated_mutation_per_method_is_still_accepted(self):
        # `accepted_body` exists so that exactly one reviewed edit can pass; if a
        # method had no alternate the mutation inventory would be wrong.
        self.assertEqual(set(source.METHODS),set(source.ALTERNATES))
        for name,pairs in source.ALTERNATES.items():
            self.assertTrue(pairs)
            for before,after in pairs:
                with self.subTest(name=name,after=after):
                    source.accepted_body(name,source.TEMPLATES[name].replace(before,after))

    def test_an_unreviewed_body_change_is_rejected(self):
        for name,text in source.TEMPLATES.items():
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'Unrecognised body'):
                source.accepted_body(name,text[:-1]+'AddFee(1,true);}')

    def test_declaration_ambiguity_and_unknown_tokens_reject(self):
        for text in ['public void M() { } public void M() { }','public void M() { `; }',
                     'public void M() {']:
            with self.subTest(text=text),self.assertRaises(ValueError):
                source.body(text,'public void M()')

    def test_parameter_list_reads_the_declared_arguments(self):
        self.assertEqual([['UInt160','contractHash'],['string','method'],
                          ['CallFlags','callFlags'],['Array','args']],
                         source.parameter_list(source.SIGNATURES['CallContract'][1]))
        # A generic argument keeps its angle brackets out of the split.
        self.assertEqual([['Dictionary<int, int>','table'],['int','n']],
                         source.parameter_list('void M(Dictionary<int, int> table, int n)'))
        with self.assertRaisesRegex(ValueError,'Unparsable declaration'):
            source.parameter_list('not a declaration')

    def test_stack_size_limit_is_evaluated_not_matched(self):
        self.assertEqual(2048,source.stack_size_limit(
            'public uint MaxStackSize { get; init; } = 2 * 1024;'))
        self.assertEqual(2097152,source.stack_size_limit(
            'public uint MaxStackSize { get; init; } = 2 * 1024 * 1024;'))
        with self.assertRaisesRegex(ValueError,'Missing MaxStackSize'):
            source.stack_size_limit('nothing here')
        with self.assertRaisesRegex(ValueError,'Unsupported integer term'):
            source.evaluate_integer('2 * ushort.MaxValue')

    def test_array_flag_expression_is_read_from_the_declaration(self):
        self.assertEqual('Type.IsArray&&Type.GetElementType()!=typeof(byte)',
                         source.array_flag_expression(
                             'public bool IsArray => Type.IsArray && '
                             'Type.GetElementType() != typeof(byte);'))
        self.assertEqual('Type.IsArray',source.array_flag_expression(
            'public bool IsArray => Type.IsArray;'))
        with self.assertRaisesRegex(ValueError,'Missing IsArray'):
            source.array_flag_expression('public bool IsArray => ;'.replace('=> ;','= false;'))

    def test_missing_extra_and_duplicate_source_identity_reject(self):
        with self.assertRaises(ValueError):
            source.project_captured({})
        with self.assertRaises(ValueError):
            rows={k:dict(path='/same/file',url=source.source_url(v),sha256=v['sha256'])
                  for k,v in source.SOURCES.items()}
            rows['extra']=rows[next(iter(rows))]
            source.project_captured(rows)

    def test_swapped_url_or_unpinned_hash_or_relative_path_reject(self):
        for field,value in [('url','https://example.invalid/source'),('sha256','0'*64),
                            ('path','relative.cs')]:
            rows={k:dict(path='/missing',url=source.source_url(v),sha256=v['sha256'])
                  for k,v in source.SOURCES.items()}
            rows[next(iter(rows))][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):
                source.project_captured(rows)

    def test_production_enforces_full_file_hashes(self):
        with self.assertRaisesRegex(ValueError,'Pinned source mismatch'):
            source.project_sources({k:'' for k in source.SOURCES})

    def test_the_two_source_repositories_are_pinned_separately(self):
        repositories={row['repository'] for row in source.SOURCES.values()}
        self.assertEqual({'neo','neo-vm'},repositories)
        for row in source.SOURCES.values():
            with self.subTest(key=row['relativePath']):
                self.assertEqual(64,len(row['sha256']))
                self.assertIn('/'+row['commit']+'/',source.source_url(row))


class ModelProjectionAgreementTests(unittest.TestCase):
    """The Coq record and the projected dict must stay the same shape."""

    def coq_fields(self):
        text=COQ.read_text()
        block=re.search(r'Record ConvertProgram := convert_program \{(.*?)\n\}.',text,re.S)
        self.assertIsNotNone(block)
        return re.findall(r'^\s*(\w+)\s*:',block.group(1),re.M)

    def test_record_order_matches_the_renderer(self):
        self.assertEqual(self.coq_fields(),[name for name,_,_ in proofs.FIELDS])
        self.assertEqual([projected for _,projected,_ in proofs.FIELDS],
                         [name for name,_ in REVIEWED])

    def test_canonical_record_renders_the_reviewed_literal(self):
        # canonical_convert must stay the value the projection is compared to, so
        # the literal in the model and the reviewed fields are checked against
        # each other rather than against a third restatement.
        literal=re.search(r'Definition canonical_convert :=\s*convert_program (.*?)\.',
                          COQ.read_text(),re.S)
        self.assertIsNotNone(literal)
        tokens=literal.group(1).split()
        self.assertEqual(len(REVIEWED),len(tokens))
        for (name,value),token in zip(REVIEWED,tokens):
            with self.subTest(field=name):
                if isinstance(value,bool):
                    self.assertEqual('true' if value else 'false',token)
                else:
                    self.assertEqual(str(value)+('%N' if token.endswith('%N') else ''),token)

    def test_program_expression_round_trips(self):
        program=dict(REVIEWED)
        self.assertEqual('(convert_program 4 true true true true true true true true true '
                         'true true true true true 2048%N true true true)',
                         proofs.program_expression(program))
        with self.assertRaisesRegex(ValueError,'Incomplete/extra projected program'):
            proofs.program_expression({**program,'extra':1})
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'pop_order_is_reversed':'true'})
        # `1 == True` in Python: a same-value integer must not render into a
        # boolean slot, or the certificate would carry a numeric literal there.
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'pop_order_is_reversed':1})
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'counted_branch_max_length':True})
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'argument_count':-1})

    def test_every_control_has_one_concrete_case(self):
        self.assertEqual(set(source.EXPECTED_CONTROLS),set(proofs.CONTROL_CASES))
        self.assertEqual(18,len(proofs.CONTROL_CASES))
        probes=set(proofs.PROBES)
        for name,(expression,expected) in proofs.CONTROL_CASES.items():
            with self.subTest(name=name):
                self.assertIn('mutant_program',expression)
                self.assertTrue(probes & set(re.findall(r'probe_\w+',expression)),name)
                self.assertTrue(expected)
                self.assertNotIn('actual_program',expression)
                self.assertNotIn('canonical_convert',expression)

    def test_every_probe_spells_out_every_call_site_field(self):
        call_site=re.search(r'Record CallSite := call_site \{(.*?)\n\}.',COQ.read_text(),re.S)
        self.assertIsNotNone(call_site)
        fields=re.findall(r'^\s*(\w+)\s*:',call_site.group(1),re.M)
        self.assertEqual(3,len(fields))
        for name,(entries,window,result) in proofs.PROBES.items():
            with self.subTest(probe=name):
                literal='{| cs_entries := '+entries+'; cs_window := '+window+'; cs_result := '+result+' |}'
                self.assertEqual(fields,re.findall(r'(\w+) :=',literal))
                self.assertTrue(entries and window and result)

    def test_every_entry_spells_out_every_descriptor_field(self):
        record=re.search(r'Record Param := param \{(.*?)\n\}.',COQ.read_text(),re.S)
        self.assertIsNotNone(record)
        fields=re.findall(r'^\s*(\w+)\s*:',record.group(1),re.M)
        self.assertEqual(8,len(fields))
        for name,text in proofs.ENTRIES.items():
            with self.subTest(entry=name):
                self.assertEqual(fields,re.findall(r'(\w+) :=\s*',text))
                element=re.search(r'pa_element_type := (\w+);',text)
                self.assertIsNotNone(element)
                self.assertIn(element.group(1),('EByte','EOther'))

    def test_model_has_no_open_proofs(self):
        text=COQ.read_text()
        for word in ('Admitted','Axiom','admit','Abort','Parameter'):
            with self.subTest(word=word):
                self.assertIsNone(re.search(r'\b'+word+r'\b',text))

    def test_every_declaration_is_printed(self):
        text=COQ.read_text()
        declared=re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',text,re.M)
        printed=re.findall(r'^Print Assumptions (\w+)\.$',text,re.M)
        self.assertEqual(declared,printed)
        self.assertEqual(49,len(declared))

    def test_certificate_declares_what_the_lane_counts(self):
        projection=dict(program=dict(REVIEWED),entryBoundary=source.ENTRY_BOUNDARY)
        certificate=proofs.render_certificate(projection)
        names=proofs.declarations(certificate)
        self.assertEqual(35,len(names))
        self.assertEqual(names,re.findall(r'^Print Assumptions (\w+)\.$',certificate,re.M))
        with self.assertRaisesRegex(ValueError,'Unsupported entry boundary'):
            proofs.render_certificate(dict(program=dict(REVIEWED),entryBoundary='somewhere else'))

    def test_certificate_covers_every_reviewed_field(self):
        projection=dict(program=dict(REVIEWED),entryBoundary=source.ENTRY_BOUNDARY)
        certificate=proofs.render_certificate(projection)
        for _,projected,_ in proofs.FIELDS:
            with self.subTest(field=projected):
                self.assertIn(projected.split('_')[0],certificate)
        for name in ('actual_program_matches_reviewed_semantics',
                     'actual_max_length_is_2048',
                     'actual_rejects_a_null_argument',
                     'actual_rejects_a_null_payload_element',
                     'actual_rejects_a_null_counted_element',
                     'actual_counted_length_one_above_the_limit_faults',
                     'the_counted_pop_variant_only_drops_the_pop'):
            with self.subTest(declaration=name):
                self.assertIn(name,proofs.declarations(certificate))


    def test_gate_pins_agree_with_this_lane(self):
        """The gate carries its own reviewed copy; a divergence fails here.

        Otherwise a weakened lane constant would agree with its own receipt and
        with its own regeneration check, and only a full gate run would notice.
        """
        import importlib.util
        here=Path(__file__).resolve().parent
        spec=importlib.util.spec_from_file_location('closure_interop_pin_check',here/'closure.py')
        gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
        self.assertEqual(gate.SCOPES['interop-conversion'],source.SCOPE)
        self.assertEqual(gate.CERTIFICATES['interop-conversion'],
                         ('certificateSha256','InteropConvertArtifact.v'))
        self.assertNotIn('interop-conversion',gate.ARTIFACT_LANES)
        self.assertEqual(list(gate.INTEROP_CONVERSION_CONTROLS),list(source.EXPECTED_CONTROLS))
        self.assertEqual(gate.INTEROP_CONVERSION_DOMAIN,
                         {'preconditions':source.PRECONDITIONS,'unproved':source.UNPROVED,
                          'tcb':source.TCB})
        self.assertEqual([list(row) for row in gate.INTEROP_CONVERSION_ARGUMENTS],
                         source.parameter_list(source.SIGNATURES['CallContract'][1]))
        self.assertEqual(set(gate.INTEROP_CONVERSION_PROGRAM),
                         {projected for _,projected,_ in proofs.FIELDS})
        self.assertEqual(proofs.program_expression(gate.INTEROP_CONVERSION_PROGRAM),
                         '(convert_program 4 true true true true true true true true true '
                         'true true true true true 2048%N true true true)')
        self.assertEqual(22,len(gate.SCOPES))


@unittest.skipUnless(os.environ.get('SA_INTEROP_CONVERSION_SOURCE_DIR'),
                     'Pinned source fixture is exercised by fresh CLI; '
                     'optional unit readback needs SA_INTEROP_CONVERSION_SOURCE_DIR')
class PinnedSourceReadbackTests(unittest.TestCase):
    def contents(self):
        directory=Path(os.environ['SA_INTEROP_CONVERSION_SOURCE_DIR'])
        return {k:(directory/(k.replace('/','-')+'.cs')).read_text() for k in source.SOURCES}

    def test_projection_derives_the_reviewed_record(self):
        projection=source.project_sources(self.contents())
        self.assertEqual(dict(REVIEWED),projection['program'])
        self.assertEqual(['call-flags','descriptor-validators'],projection['reasonOnlyGuards'])
        self.assertIs(projection['sourceFrontendVerified'],False)
        self.assertEqual([['UInt160','contractHash'],['string','method'],
                          ['CallFlags','callFlags'],['Array','args']],projection['parameters'])

    def test_every_control_changes_exactly_one_projected_field(self):
        contents=self.contents()
        baseline=source.project_sources(contents)['program']
        changed={}
        for name in source.EXPECTED_CONTROLS:
            with self.subTest(name=name):
                mutant,digest=source.mutated_projection(contents,name)
                fields=[k for k in baseline if baseline[k]!=mutant['program'][k]]
                self.assertEqual(1,len(fields),'control must change exactly one field: '+name)
                changed.setdefault(fields[0],[]).append(name)
                self.assertEqual(64,len(digest))
        # Eighteen of the nineteen projected fields are mutation-covered. The
        # arity is the exception on purpose: it is pinned by the `CallContract`
        # declaration header, which `body()` requires to appear exactly once, so
        # deleting an argument makes the projection fail to parse instead of
        # yielding a weaker record.
        self.assertEqual({name for name,_ in REVIEWED}-{'argument_count'},set(changed))
        self.assertEqual(18,sum(map(len,changed.values())))
        self.assertEqual(['include-byte-arrays'],
                         changed['array_branch_excludes_byte_element'])
        self.assertEqual(['weaken-the-stack-size-limit'],
                         changed['counted_branch_max_length'])

    def test_captured_rows_reject_changed_bytes(self):
        contents=self.contents()
        baseline=source.project_sources(contents)
        with tempfile.TemporaryDirectory() as out:
            rows={}
            for key,spec in source.SOURCES.items():
                path=Path(out)/(key.replace('/','-')+'.cs');path.write_text(contents[key])
                rows[key]=dict(path=str(path),url=source.source_url(spec),sha256=spec['sha256'])
            self.assertEqual(source.project_captured(rows),baseline)
            path=Path(rows['vm/limits']['path'])
            path.write_text(path.read_text()+'// changed\n')
            with self.assertRaisesRegex(ValueError,'bytes mismatch'):
                source.project_captured(rows)


class PinnedDownloadRetryTests(unittest.TestCase):
    """A stalled connection is retried; a wrong artifact still fails closed."""

    def test_transport_timeout_is_retried_until_it_succeeds(self):
        attempts=[]
        def fake(url,timeout=None):
            attempts.append(timeout)
            if len(attempts)<3:raise TimeoutError('The read operation timed out')
            return _Payload(b'ok')
        with mock.patch.object(source.urllib.request,'urlopen',fake):
            self.assertEqual(source.download_pinned('https://example.invalid/x'),b'ok')
        self.assertEqual(attempts,list(source.DOWNLOAD_ATTEMPT_TIMEOUTS[:3]))

    def test_exhausted_retries_fail_closed_with_the_transport_error(self):
        def always(url,timeout=None):raise TimeoutError('The read operation timed out')
        with mock.patch.object(source.urllib.request,'urlopen',always):
            with self.assertRaises(TimeoutError):
                source.download_pinned('https://example.invalid/x')

    def test_http_status_is_reported_without_retrying(self):
        calls=[]
        def status(url,timeout=None):
            calls.append(url)
            raise source.urllib.error.HTTPError(url,404,'Not Found',None,None)
        with mock.patch.object(source.urllib.request,'urlopen',status):
            with self.assertRaises(source.urllib.error.HTTPError):
                source.download_pinned('https://example.invalid/x')
        self.assertEqual(1,len(calls))

    def test_retried_bytes_still_have_to_match_the_pinned_hash(self):
        with tempfile.TemporaryDirectory() as out:
            # The offline mirror is an environment fault fallback, not part of
            # this contract: if it is set the download never happens and this
            # test would assert nothing.
            with mock.patch.dict(os.environ,{'SA_INTEROP_CONVERSION_SOURCE_MIRROR':''}):
                with mock.patch.object(source.urllib.request,'urlopen',
                                       lambda url,timeout=None:_Payload(b'not the pinned source')):
                    with self.assertRaisesRegex(ValueError,'Downloaded pinned source mismatch'):
                        source.project_production(out)
            self.assertEqual([],list(Path(out).iterdir()))

    def test_offline_mirror_bytes_still_have_to_match_the_pinned_hash(self):
        key=next(iter(source.SOURCES))
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as mirror:
            (Path(mirror)/(key.replace('/','-')+'.cs')).write_bytes(b'not the pinned source')
            with mock.patch.dict(os.environ,{'SA_INTEROP_CONVERSION_SOURCE_MIRROR':mirror}):
                with mock.patch.object(source.urllib.request,'urlopen',
                                       lambda *a,**k:self.fail('mirror hit attempted a download')):
                    with self.assertRaisesRegex(ValueError,'Offline mirror source mismatch'):
                        source.project_production(out)
            self.assertEqual([],list(Path(out).iterdir()))

    def test_absent_mirror_entry_falls_back_to_the_pinned_download(self):
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as mirror:
            def unreachable(url,timeout=None):raise TimeoutError('transport unavailable')
            with mock.patch.dict(os.environ,{'SA_INTEROP_CONVERSION_SOURCE_MIRROR':mirror}):
                with mock.patch.object(source.urllib.request,'urlopen',unreachable):
                    with self.assertRaises(TimeoutError):
                        source.project_production(out)


class _Payload(object):
    """Minimal stand-in for the object urlopen returns."""

    def __init__(self,body):self.body=body

    def read(self):return self.body


if __name__=='__main__':unittest.main()
