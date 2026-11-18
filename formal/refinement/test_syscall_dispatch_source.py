import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock
try:
    from . import syscall_dispatch_source as source
    from . import syscall_dispatch_proofs as proofs
except ImportError:
    import syscall_dispatch_source as source
    import syscall_dispatch_proofs as proofs

COQ = Path(__file__).resolve().parent/'coq/SyscallDispatch.v'

class SyscallProjectionTests(unittest.TestCase):
    def test_reviewed_templates_parse_to_no_overrides(self):
        self.assertEqual(6,len(source.SIGNATURES))
        for name,text in source.TEMPLATES.items():
            with self.subTest(name=name):
                updates,texts=source.parse_method(name,text)
                self.assertEqual({},updates)
                for index,(original,_) in enumerate(source.PATCHES.get(name,[])):
                    self.assertEqual(original,texts[index])

    def test_added_side_effect_in_every_method_is_rejected(self):
        for name,text in source.TEMPLATES.items():
            with self.subTest(name=name),self.assertRaises(ValueError):
                source.parse_method(name,text[:-1]+'engine.Push(1);}')

    def test_declaration_ambiguity_and_unknown_tokens_reject(self):
        for text in ['public void M() { } public void M() { }','public void M() { `; }',
                     'public void M() {']:
            with self.subTest(text=text),self.assertRaises(ValueError):
                source.body(text,'public void M()')

    def test_unsupported_binding_changes_reject(self):
        changes=[('CallContract','NativeContract.ContractManagement.GetContract',
                  'OtherManagement.GetContract'),
                 ('OnSysCall','descriptor.Parameters[i]','other.Parameters[i]'),
                 ('OnCallT','contract.Nef.Tokens[tokenId]','contract.Nef.Methods[tokenId]'),
                 ('ValidateCallFlags','state.CallFlags.HasFlag','this.Flags.Contains')]
        for name,before,after in changes:
            with self.subTest(name=name),self.assertRaises(ValueError):
                source.parse_method(name,source.TEMPLATES[name].replace(before,after))

    def test_every_declared_alternate_is_parsed_and_reported(self):
        for name,slots in source.PATCHES.items():
            for index,(original,alternates) in enumerate(slots):
                for after,expected in alternates.items():
                    with self.subTest(name=name,after=after):
                        updates,texts=source.parse_method(name,
                                                          source.TEMPLATES[name].replace(original,after))
                        self.assertEqual(after,texts[index])
                        self.assertEqual(expected,updates)

    def test_ordered_anchors_reject_a_reordered_body(self):
        body=source.TEMPLATES['CallContract']
        underscore="if(method.StartsWith('_'))thrownewArgumentException("
        flags='thrownewArgumentOutOfRangeException(nameof(callFlags))'
        swapped=body.replace(underscore,'@@A@@').replace(flags,'@@B@@')
        swapped=swapped.replace('@@A@@',flags).replace('@@B@@',underscore)
        self.assertNotEqual(body,swapped)
        with self.assertRaisesRegex(ValueError,'out of source order'):
            source.ordered(swapped,'CallContract')

    def test_flag_table_comes_from_the_source_declaration(self):
        body='\n'.join(['None = 0,','ReadStates = 0b00000001,','WriteStates = 0b00000010,',
                        'AllowCall = 0b00000100,','AllowNotify = 0b00001000,',
                        'States = ReadStates | WriteStates,','ReadOnly = ReadStates | AllowCall,',
                        'All = States | AllowCall | AllowNotify'])
        table=source.flag_table('public enum CallFlags : byte {\n'+body+'\n}')
        self.assertEqual({'None':0,'ReadStates':1,'WriteStates':2,'AllowCall':4,'AllowNotify':8,
                          'States':3,'ReadOnly':5,'All':15},table)
        self.assertEqual(5,source.eval_flags('CallFlags.ReadStates|CallFlags.AllowCall',table))
        self.assertEqual(0,source.eval_flags('CallFlags.None',table))
        with self.assertRaisesRegex(ValueError,'Changed CallFlags member set'):
            source.flag_table('public enum CallFlags : byte {\nNone = 0,\nReadStates = 1,\n'
                              'WriteStates = 2,\nAllowCall = 4,\nAllowNotify = 8,\nStates = 3,\n'
                              'ReadOnly = 5\n}')
        with self.assertRaisesRegex(ValueError,'Changed CallFlags values'):
            source.flag_table('public enum CallFlags : byte {\n'+body.replace(
                '0b00000010','0b00000110')+'\n}')

    def test_signature_split_reads_the_handler_parameters(self):
        return_type,params=source.signature_parts(source.SIGNATURES['CallContract'][1])
        self.assertEqual('void',return_type)
        self.assertEqual([['UInt160','contractHash'],['string','method'],
                          ['CallFlags','callFlags'],['Array','args']],[list(p) for p in params])
        _,registry=source.signature_parts(source.SIGNATURES['Register'][1])
        self.assertEqual(5,len(registry))
        self.assertEqual(['Hardfork?','hardfork'],list(registry[-1]))
        with self.assertRaisesRegex(ValueError,'Unparsable declaration'):
            source.signature_parts('not a declaration')

    def test_missing_extra_and_duplicate_source_identity_reject(self):
        with self.assertRaises(ValueError):source.project_captured({})
        rows={k:dict(path='/same/file',url=source.source_url(v),sha256=v['sha256'])
              for k,v in source.SOURCES.items()}
        rows['extra']=rows[next(iter(rows))]
        with self.assertRaises(ValueError):source.project_captured(rows)

    def test_swapped_url_or_unpinned_hash_reject_before_read(self):
        for field,value in [('url','https://example.invalid/source'),('sha256','0'*64),
                            ('path','relative.cs')]:
            rows={k:dict(path='/missing',url=source.source_url(v),sha256=v['sha256'])
                  for k,v in source.SOURCES.items()}
            rows[next(iter(rows))][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):
                source.project_captured(rows)

    def test_production_enforces_full_file_hashes(self):
        contents={k:'' for k in source.SOURCES}
        with self.assertRaisesRegex(ValueError,'Pinned source mismatch'):
            source.project_sources(contents)


class ModelProjectionAgreementTests(unittest.TestCase):
    """The Coq record and the projected dict must stay the same shape."""

    def coq_fields(self):
        text=COQ.read_text()
        block=re.search(r'Record SyscallProgram := syscall_program \{(.*?)\n\}.',text,re.S)
        self.assertIsNotNone(block)
        return re.findall(r'^\s*(\w+)\s*:',block.group(1),re.M)

    def test_record_order_matches_the_renderer(self):
        # The model prefixes every field with sp_; the projected dict does not.
        self.assertEqual(self.coq_fields(),["sp_"+name for name,_ in proofs.FIELDS])

    def test_canonical_record_renders_the_reviewed_literal(self):
        # canonical_syscall must stay the value the projection is compared to,
        # so the literal in the model and the rendered fields are checked against
        # each other rather than against a third restatement.
        text=COQ.read_text()
        literal=re.search(r'Definition canonical_syscall :=\s*syscall_program (.*?)\.',text,re.S)
        self.assertIsNotNone(literal)
        tokens=literal.group(1).split()
        expected=[('interop_flag_gate',True),('interop_required_flags',5),('interop_pop_count',4),
                  ('interop_flag_slot',2),('interop_pushes_result',True),
                  ('interop_handler_void',True),('interop_result',0),
                  ('call_rejects_underscore',True),('call_flag_range_gate',True),
                  ('call_all_flags',15),('call_derives_return',True),
                  ('call_marks_dynamic',True),('token_flag_gate',True),
                  ('token_required_flags',5),('token_pops',True),
                  ('token_marks_dynamic',False)]
        self.assertEqual([name for name,_ in expected],[name for name,_ in proofs.FIELDS])
        self.assertEqual(len(expected),len(tokens))
        for (name,value),token in zip(expected,tokens):
            with self.subTest(field=name):
                if isinstance(value,bool):
                    self.assertEqual('true' if value else 'false',token)
                else:
                    self.assertEqual(str(value)+('%N' if token.endswith('%N') else ''),token)

    def test_program_expression_round_trips(self):
        program={'interop_flag_gate':True,'interop_required_flags':5,'interop_pop_count':4,
                 'interop_flag_slot':2,'interop_pushes_result':True,'interop_handler_void':True,
                 'interop_result':0,'call_rejects_underscore':True,'call_flag_range_gate':True,
                 'call_all_flags':15,'call_derives_return':True,'call_marks_dynamic':True,
                 'token_flag_gate':True,'token_required_flags':5,'token_pops':True,
                 'token_marks_dynamic':False}
        self.assertEqual('(syscall_program true 5%N 4 2 true true 0 true true 15%N true true '
                         'true 5%N true false)',proofs.program_expression(program))
        broken=dict(program);broken['extra']=1
        with self.assertRaisesRegex(ValueError,'Incomplete/extra projected program'):
            proofs.program_expression(broken)
        broken=dict(program);broken['token_pops']='true'
        with self.assertRaisesRegex(ValueError,'Unsupported field value'):
            proofs.program_expression(broken)

    def test_every_control_has_one_concrete_case(self):
        self.assertEqual(set(source.EXPECTED_CONTROLS),set(proofs.CONTROL_CASES))
        for name,(expression,expected) in proofs.CONTROL_CASES.items():
            with self.subTest(name=name):
                self.assertIn('mutant_program',expression)
                self.assertTrue(expected)

    def test_model_has_no_open_proofs(self):
        text=COQ.read_text()
        for word in ('Admitted','Axiom','admit','Abort','Parameter'):
            with self.subTest(word=word):
                self.assertIsNone(re.search(r'\b'+word+r'\b',text))

    def test_every_declaration_is_printed(self):
        text=COQ.read_text()
        declared=re.findall(r'^(?:Theorem|Lemma)\s+(\w+)\s*:',text,re.M)
        printed=re.findall(r'^Print Assumptions (\w+)\.$',text,re.M)
        self.assertEqual(declared,printed)
        self.assertEqual(35,len(declared))

    def test_gate_pins_agree_with_this_lane(self):
        """The gate carries its own reviewed copy; a divergence fails here.

        Otherwise a weakened lane constant would agree with its own receipt and
        with its own regeneration check, and only a full gate run would notice.
        """
        import importlib.util
        here=Path(__file__).resolve().parent
        spec=importlib.util.spec_from_file_location('closure_pin_check',here/'closure.py')
        gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
        self.assertEqual(gate.SCOPES['syscall-dispatch'],source.SCOPE)
        self.assertEqual(gate.CERTIFICATES['syscall-dispatch'],
                         ('certificateSha256','SyscallDispatchArtifact.v'))
        self.assertNotIn('syscall-dispatch',gate.ARTIFACT_LANES)
        self.assertEqual(list(gate.SYSCALL_DISPATCH_CONTROLS),list(source.EXPECTED_CONTROLS))
        self.assertEqual(gate.SYSCALL_DISPATCH_DOMAIN,
                         {'preconditions':source.PRECONDITIONS,'unproved':source.UNPROVED,
                          'tcb':source.TCB})
        self.assertEqual(gate.SYSCALL_DISPATCH_TOKEN_FIELDS,
                         ['Hash','Method','ParametersCount:ushort','HasReturnValue','CallFlags:byte'])
        self.assertEqual(set(gate.SYSCALL_DISPATCH_PROGRAM),
                         {name for name,_ in proofs.FIELDS})
        self.assertEqual(len(gate.SYSCALL_DISPATCH_HANDLER_PARAMETERS),
                         gate.SYSCALL_DISPATCH_PROGRAM['interop_pop_count'])
        self.assertEqual(gate.SYSCALL_DISPATCH_HANDLER_PARAMETERS[
                             gate.SYSCALL_DISPATCH_PROGRAM['interop_flag_slot']][0],'CallFlags')
        self.assertEqual(proofs.program_expression(gate.SYSCALL_DISPATCH_PROGRAM),
                         '(syscall_program true 5%N 4 2 true true 0 true true 15%N true true '
                         'true 5%N true false)')


@unittest.skipUnless(os.environ.get('SYSCALL_DISPATCH_SOURCE_DIR'),
                     'Pinned source fixture is exercised by fresh CLI; '
                     'optional unit readback needs SYSCALL_DISPATCH_SOURCE_DIR')
class PinnedSourceReadbackTests(unittest.TestCase):
    def contents(self):
        directory=Path(os.environ['SYSCALL_DISPATCH_SOURCE_DIR'])
        return {k:(directory/(k.replace('/','-')+'.cs')).read_text() for k in source.SOURCES}

    def test_projection_derives_the_canonical_record(self):
        projection=source.project_sources(self.contents())
        self.assertEqual({'interop_flag_gate':True,'interop_required_flags':5,
                          'interop_pop_count':4,'interop_flag_slot':2,
                          'interop_pushes_result':True,'interop_handler_void':True,
                          'interop_result':0,'call_rejects_underscore':True,
                          'call_flag_range_gate':True,'call_all_flags':15,
                          'call_derives_return':True,'call_marks_dynamic':True,
                          'token_flag_gate':True,'token_required_flags':5,'token_pops':True,
                          'token_marks_dynamic':False},projection['program'])
        self.assertEqual([['UInt160','contractHash'],['string','method'],
                          ['CallFlags','callFlags'],['Array','args']],
                         projection['handlerParameters'])
        self.assertIs(projection['sourceFrontendVerified'],False)

    def test_every_control_changes_a_projected_field(self):
        contents=self.contents()
        baseline=source.project_sources(contents)['program']
        changed={}
        for name in source.EXPECTED_CONTROLS:
            with self.subTest(name=name):
                mutant,digest=source.mutated_projection(contents,name)
                fields=[k for k in baseline if baseline[k]!=mutant['program'][k]]
                self.assertEqual(1,len(fields),'control must change exactly one field: '+name)
                self.assertNotIn(fields[0],changed,'two controls cover the same field')
                changed[fields[0]]=name
                self.assertEqual(64,len(digest))
        # Every field a control could plausibly own is actually exercised; the
        # derived constants are covered by the three flag-word controls.
        self.assertEqual(len(source.EXPECTED_CONTROLS),len(changed))

    def test_captured_rows_reject_changed_bytes(self):
        contents=self.contents()
        baseline=source.project_sources(contents)
        with tempfile.TemporaryDirectory() as out:
            rows={}
            for key,spec in source.SOURCES.items():
                path=Path(out)/(key.replace('/','-')+'.cs');path.write_text(contents[key])
                rows[key]=dict(path=str(path),url=source.source_url(spec),sha256=spec['sha256'])
            self.assertEqual(source.project_captured(rows),baseline)
            path=Path(rows['core/token']['path'])
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
            with mock.patch.dict(os.environ,{'SA_SYSCALL_DISPATCH_SOURCE_MIRROR':''}):
                with mock.patch.object(source.urllib.request,'urlopen',
                                       lambda url,timeout=None:_Payload(b'not the pinned source')):
                    with self.assertRaisesRegex(ValueError,'Downloaded pinned source mismatch'):
                        source.project_production(out)
            self.assertEqual([],list(Path(out).iterdir()))

    def test_offline_mirror_bytes_still_have_to_match_the_pinned_hash(self):
        key=next(iter(source.SOURCES))
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as mirror:
            (Path(mirror)/(key.replace('/','-')+'.cs')).write_bytes(b'not the pinned source')
            with mock.patch.dict(os.environ,{'SA_SYSCALL_DISPATCH_SOURCE_MIRROR':mirror}):
                with mock.patch.object(source.urllib.request,'urlopen',
                                       lambda *a,**k:self.fail('mirror hit attempted a download')):
                    with self.assertRaisesRegex(ValueError,'Offline mirror source mismatch'):
                        source.project_production(out)
            self.assertEqual([],list(Path(out).iterdir()))

    def test_absent_mirror_entry_falls_back_to_the_pinned_download(self):
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as mirror:
            def unreachable(url,timeout=None):raise TimeoutError('transport unavailable')
            with mock.patch.dict(os.environ,{'SA_SYSCALL_DISPATCH_SOURCE_MIRROR':mirror}):
                with mock.patch.object(source.urllib.request,'urlopen',unreachable):
                    with self.assertRaises(TimeoutError):
                        source.project_production(out)


class _Payload(object):
    """Minimal stand-in for the object urlopen returns."""

    def __init__(self,body):self.body=body

    def read(self):return self.body


if __name__=='__main__':unittest.main()
