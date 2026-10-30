import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock
try:
    from . import contract_handoff_source as source
    from . import contract_handoff_proofs as proofs
except ImportError:
    import contract_handoff_source as source
    import contract_handoff_proofs as proofs

COQ = Path(__file__).resolve().parent/'coq/ContractHandoff.v'
ENUM = ('public enum CallFlags : byte {\n'
        'None = 0,\nReadStates = 0b00000001,\nWriteStates = 0b00000010,\n'
        'AllowCall = 0b00000100,\nAllowNotify = 0b00001000,\n'
        'States = ReadStates | WriteStates,\nReadOnly = ReadStates | AllowCall,\n'
        'All = States | AllowCall | AllowNotify\n    }')

class ContractHandoffProjectionTests(unittest.TestCase):
    def test_reviewed_templates_parse_to_no_overrides(self):
        self.assertEqual(7,len(source.SIGNATURES))
        self.assertEqual(set(source.SIGNATURES),set(source.TEMPLATES))
        for name,text in source.TEMPLATES.items():
            with self.subTest(name=name):
                self.assertEqual(({},text),source.parse_method(name,text))
                for index,(original,_) in enumerate(source.PATCHES.get(name,[])):
                    self.assertEqual(original,source.slot_texts(name,text)[index])

    def test_added_side_effect_in_every_method_is_rejected(self):
        for name,text in source.TEMPLATES.items():
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'Unrecognised body'):
                source.parse_method(name,text[:-1]+'AddFee(1,true);}')

    def test_declaration_ambiguity_and_unknown_tokens_reject(self):
        for text in ['public void M() { } public void M() { }','public void M() { `; }',
                     'public void M() {']:
            with self.subTest(text=text),self.assertRaises(ValueError):
                source.body(text,'public void M()')

    def test_unsupported_binding_changes_reject(self):
        changes=[('CallContractInternal','method.Safe','method.NotSafe'),
                 ('CallContractInternal','CurrentContext!','ParentContext!'),
                 ('CallContractInternal','NativeContract.Policy.IsBlocked(','Policy.IsBlocked('),
                 ('LoadContract','?0:1','?0:2'),
                 ('LoadScript','SnapshotCache?.CloneCache()','SnapshotCache.CloneCache()'),
                 ('GetMethod','Methods.ToDictionary(','Methods.ToArray(')]
        for name,before,after in changes:
            with self.subTest(name=name,before=before),self.assertRaises(ValueError):
                source.parse_method(name,source.TEMPLATES[name].replace(before,after))

    def test_every_declared_alternate_is_parsed_and_reported(self):
        for name,slots in source.PATCHES.items():
            for index,(original,alternates) in enumerate(slots):
                for after,expected in alternates.items():
                    with self.subTest(name=name,after=after):
                        text=source.TEMPLATES[name].replace(original,after)
                        updates,_=source.parse_method(name,text)
                        self.assertEqual(expected,updates)
                        # parse_method reports the body; the slot texts are what
                        # the projection reads the derived constants out of.
                        self.assertEqual(after,source.slot_texts(name,text)[index])

    def test_ordered_anchors_reject_a_reordered_body(self):
        body=source.TEMPLATES['CallContractInternal']
        first='if(method.Safe)'
        second='flags&=~(CallFlags.'
        self.assertEqual(1,body.count(first))
        swapped=body.replace(first,'@@A@@').replace(second,'@@B@@')
        swapped=swapped.replace('@@A@@',second).replace('@@B@@',first)
        self.assertNotEqual(body,swapped)
        with self.assertRaisesRegex(ValueError,'Reordered declarations in CallContractInternal'):
            source.ordered(swapped,'CallContractInternal')

    def test_flag_table_comes_from_the_source_declaration(self):
        table=source.flag_table(ENUM)
        self.assertEqual({'None':0,'ReadStates':1,'WriteStates':2,'AllowCall':4,'AllowNotify':8,
                          'States':3,'ReadOnly':5,'All':15},table.values)
        self.assertEqual(10,table.mask(source.mask_members('~(CallFlags.WriteStates|CallFlags.AllowNotify)')))
        self.assertEqual(15,table.mask(source.mask_members('~(CallFlags.All)')))
        with self.assertRaisesRegex(ValueError,'Changed CallFlags declaration'):
            source.flag_table(ENUM.replace('AllowNotify = 0b00001000','AllowNotify = 0b00011000'))
        with self.assertRaisesRegex(ValueError,'Unrecognised safe-method mask'):
            source.mask_members('~(WriteStates)')

    def test_initializer_constants_come_from_the_basic_method(self):
        text=('    public static string Initialize { get; } = "_initialize";\n'
              '    public static int InitializePCount { get; } = 0;\n')
        self.assertEqual(('_initialize',0),source.initializer_facts(text))
        self.assertEqual(('_init',1),source.initializer_facts(
            text.replace('_initialize','_init').replace('= 0;','= 1;')))
        with self.assertRaisesRegex(ValueError,'Missing initializer constants'):
            source.initializer_facts('nothing here')

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


class ModelProjectionAgreementTests(unittest.TestCase):
    """The Coq record and the projected dict must stay the same shape."""

    def coq_fields(self):
        text=COQ.read_text()
        block=re.search(r'Record HandoffProgram := handoff_program \{(.*?)\n\}.',text,re.S)
        self.assertIsNotNone(block)
        return re.findall(r'^\s*(\w+)\s*:',block.group(1),re.M)

    def test_record_order_matches_the_renderer(self):
        # The model prefixes every field with hp_; the projected dict does not.
        self.assertEqual(self.coq_fields(),['hp_'+name for name,_ in proofs.FIELDS])

    def test_canonical_record_renders_the_reviewed_literal(self):
        # canonical_handoff must stay the value the projection is compared to,
        # so the literal in the model and the rendered fields are checked against
        # each other rather than against a third restatement.
        literal=re.search(r'Definition canonical_handoff :=\s*handoff_program (.*?)\.',
                          COQ.read_text(),re.S)
        self.assertIsNotNone(literal)
        tokens=literal.group(1).split()
        expected=[('blocked_gate',True),('safe_mask_drops',10),('authorization_gate',True),
                  ('authorization_subject_is_caller',True),('increment_step',1),
                  ('caller_flag_intersection',True),('calling_context_set',True),
                  ('fee_from_whitelist',True),('whitelist_sets_flag',True),('push_reversed',True),
                  ('rvcount_from_return',True),('ip_from_method_offset',True),
                  ('contract_copied',True),('snapshot_cloned',True),('initializer_frame',True),
                  ('initializer_name_is_canonical',True),('initializer_pcount',0),
                  ('lookup_is_arity_keyed',True)]
        self.assertEqual([name for name,_ in expected],[name for name,_ in proofs.FIELDS])
        self.assertEqual(len(expected),len(tokens))
        for (name,value),token in zip(expected,tokens):
            with self.subTest(field=name):
                if isinstance(value,bool):
                    self.assertEqual('true' if value else 'false',token)
                else:
                    self.assertEqual(str(value)+('%N' if token.endswith('%N') else ''),token)

    def test_program_expression_round_trips(self):
        program={name:(value if not isinstance(value,bool) else value)
                 for name,value in [('blocked_gate',True),('safe_mask_drops',10),
                    ('authorization_gate',True),('authorization_subject_is_caller',True),
                    ('increment_step',1),('caller_flag_intersection',True),
                    ('calling_context_set',True),('fee_from_whitelist',True),
                    ('whitelist_sets_flag',True),('push_reversed',True),
                    ('rvcount_from_return',True),('ip_from_method_offset',True),
                    ('contract_copied',True),('snapshot_cloned',True),
                    ('initializer_frame',True),('initializer_name_is_canonical',True),
                    ('initializer_pcount',0),('lookup_is_arity_keyed',True)]}
        self.assertEqual('(handoff_program true 10%N true true 1 true true true true true true '
                         'true true true true true 0 true)',proofs.program_expression(program))
        with self.assertRaisesRegex(ValueError,'Incomplete/extra projected program'):
            proofs.program_expression({**program,'extra':1})
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'push_reversed':'true'})
        # `1 == True` in Python: a same-value integer must not render into a
        # boolean slot, or the certificate would carry a numeric literal there.
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'push_reversed':1})
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression({**program,'safe_mask_drops':True})

    def test_every_control_has_one_concrete_case(self):
        self.assertEqual(set(source.EXPECTED_CONTROLS),set(proofs.CONTROL_CASES))
        self.assertEqual(21,len(proofs.CONTROL_CASES))
        probes=set(proofs.PROBES)
        for name,(expression,expected) in proofs.CONTROL_CASES.items():
            with self.subTest(name=name):
                self.assertIn('mutant_program',expression)
                self.assertTrue(probes & set(re.findall(r'probe_\w+',expression)))
                self.assertTrue(expected)
                self.assertNotIn('canonical_handoff',expression)

    def test_every_probe_spells_out_every_call_site_field(self):
        call_site=re.search(r'Record CallSite := call_site \{(.*?)\n\}.',COQ.read_text(),re.S)
        self.assertIsNotNone(call_site)
        fields=re.findall(r'^\s*(\w+)\s*:',call_site.group(1),re.M)
        self.assertEqual(16,len(fields))
        for name,text in proofs.PROBES.items():
            with self.subTest(probe=name):
                self.assertEqual(fields,re.findall(r'(\w+) :=',text))

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
        self.assertEqual(42,len(declared))

    def test_certificate_declares_what_the_lane_counts(self):
        program={name:(value if not isinstance(value,bool) else value)
                 for name,value in [('blocked_gate',True),('safe_mask_drops',10),
                    ('authorization_gate',True),('authorization_subject_is_caller',True),
                    ('increment_step',1),('caller_flag_intersection',True),
                    ('calling_context_set',True),('fee_from_whitelist',True),
                    ('whitelist_sets_flag',True),('push_reversed',True),
                    ('rvcount_from_return',True),('ip_from_method_offset',True),
                    ('contract_copied',True),('snapshot_cloned',True),
                    ('initializer_frame',True),('initializer_name_is_canonical',True),
                    ('initializer_pcount',0),('lookup_is_arity_keyed',True)]}
        projection=dict(program=program,entryBoundary=source.ENTRY_BOUNDARY)
        certificate=proofs.render_certificate(projection)
        names=proofs.declarations(certificate)
        self.assertEqual(19,len(names))
        self.assertEqual(names,re.findall(r'^Print Assumptions (\w+)\.$',certificate,re.M))
        with self.assertRaisesRegex(ValueError,'Unsupported entry boundary'):
            proofs.render_certificate(dict(program=program,entryBoundary='somewhere else'))

    def test_gate_pins_agree_with_this_lane(self):
        """The gate carries its own reviewed copy; a divergence fails here.

        Otherwise a weakened lane constant would agree with its own receipt and
        with its own regeneration check, and only a full gate run would notice.
        """
        import importlib.util
        here=Path(__file__).resolve().parent
        spec=importlib.util.spec_from_file_location('closure_handoff_pin_check',here/'closure.py')
        gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
        self.assertEqual(gate.SCOPES['contract-handoff'],source.SCOPE)
        self.assertEqual(gate.CERTIFICATES['contract-handoff'],
                         ('certificateSha256','ContractHandoffArtifact.v'))
        self.assertNotIn('contract-handoff',gate.ARTIFACT_LANES)
        self.assertEqual(list(gate.CONTRACT_HANDOFF_CONTROLS),list(source.EXPECTED_CONTROLS))
        self.assertEqual(gate.CONTRACT_HANDOFF_DOMAIN,
                         {'preconditions':source.PRECONDITIONS,'unproved':source.UNPROVED,
                          'tcb':source.TCB})
        self.assertEqual(set(gate.CONTRACT_HANDOFF_PROGRAM),{name for name,_ in proofs.FIELDS})
        self.assertEqual(proofs.program_expression(gate.CONTRACT_HANDOFF_PROGRAM),
                         '(handoff_program true 10%N true true 1 true true true true true true '
                         'true true true true true 0 true)')


@unittest.skipUnless(os.environ.get('AA_CONTRACT_HANDOFF_SOURCE_DIR'),
                     'Pinned source fixture is exercised by fresh CLI; '
                     'optional unit readback needs AA_CONTRACT_HANDOFF_SOURCE_DIR')
class PinnedSourceReadbackTests(unittest.TestCase):
    def contents(self):
        directory=Path(os.environ['AA_CONTRACT_HANDOFF_SOURCE_DIR'])
        return {k:(directory/(k.replace('/','-')+'.cs')).read_text() for k in source.SOURCES}

    def test_projection_derives_the_reviewed_record(self):
        projection=source.project_sources(self.contents())
        self.assertEqual({'blocked_gate':True,'safe_mask_drops':10,'authorization_gate':True,
                          'authorization_subject_is_caller':True,'increment_step':1,
                          'caller_flag_intersection':True,'calling_context_set':True,
                          'fee_from_whitelist':True,'whitelist_sets_flag':True,
                          'push_reversed':True,'rvcount_from_return':True,
                          'ip_from_method_offset':True,'contract_copied':True,
                          'snapshot_cloned':True,'initializer_frame':True,
                          'initializer_name_is_canonical':True,'initializer_pcount':0,
                          'lookup_is_arity_keyed':True},projection['program'])
        self.assertEqual(['contract-absent','method-absent','arity-equality','return-xor'],
                         projection['reasonOnlyGuards'])
        self.assertIs(projection['sourceFrontendVerified'],False)

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
        # Every projected field is exercised, and the only fields two controls
        # share are the mask word and the increment step, which differ in value.
        self.assertEqual({name for name,_ in proofs.FIELDS},set(changed))
        self.assertEqual(21,sum(map(len,changed.values())))
        self.assertEqual(['mask-nothing','mask-read-states','mask-everything'],
                         changed['safe_mask_drops'])
        self.assertEqual(['increment-twice','skip-increment'],changed['increment_step'])

    def test_captured_rows_reject_changed_bytes(self):
        contents=self.contents()
        baseline=source.project_sources(contents)
        with tempfile.TemporaryDirectory() as out:
            rows={}
            for key,spec in source.SOURCES.items():
                path=Path(out)/(key.replace('/','-')+'.cs');path.write_text(contents[key])
                rows[key]=dict(path=str(path),url=source.source_url(spec),sha256=spec['sha256'])
            self.assertEqual(source.project_captured(rows),baseline)
            path=Path(rows['vm/context']['path'])
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
            with mock.patch.dict(os.environ,{'AA_CONTRACT_HANDOFF_SOURCE_MIRROR':''}):
                with mock.patch.object(source.urllib.request,'urlopen',
                                       lambda url,timeout=None:_Payload(b'not the pinned source')):
                    with self.assertRaisesRegex(ValueError,'Downloaded pinned source mismatch'):
                        source.project_production(out)
            self.assertEqual([],list(Path(out).iterdir()))

    def test_offline_mirror_bytes_still_have_to_match_the_pinned_hash(self):
        key=next(iter(source.SOURCES))
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as mirror:
            (Path(mirror)/(key.replace('/','-')+'.cs')).write_bytes(b'not the pinned source')
            with mock.patch.dict(os.environ,{'AA_CONTRACT_HANDOFF_SOURCE_MIRROR':mirror}):
                with mock.patch.object(source.urllib.request,'urlopen',
                                       lambda *a,**k:self.fail('mirror hit attempted a download')):
                    with self.assertRaisesRegex(ValueError,'Offline mirror source mismatch'):
                        source.project_production(out)
            self.assertEqual([],list(Path(out).iterdir()))

    def test_absent_mirror_entry_falls_back_to_the_pinned_download(self):
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as mirror:
            def unreachable(url,timeout=None):raise TimeoutError('transport unavailable')
            with mock.patch.dict(os.environ,{'AA_CONTRACT_HANDOFF_SOURCE_MIRROR':mirror}):
                with mock.patch.object(source.urllib.request,'urlopen',unreachable):
                    with self.assertRaises(TimeoutError):
                        source.project_production(out)


class _Payload(object):
    """Minimal stand-in for the object urlopen returns."""

    def __init__(self,body):self.body=body

    def read(self):return self.body


if __name__=='__main__':unittest.main()
