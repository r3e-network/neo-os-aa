import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
try:
    from . import entry_dispatch_source as source
except ImportError:
    import entry_dispatch_source as source


class EntryDispatchSourceTests(unittest.TestCase):
    def test_complete_reviewed_method_templates(self):
        self.assertEqual(len(source.HEADERS),15)
        for name,text in source.TEMPLATES.items():
            with self.subTest(name=name):self.assertEqual(source.parse_method(name,text),{})

    def test_added_side_effect_in_every_method_is_rejected(self):
        for name,text in source.TEMPLATES.items():
            with self.subTest(name=name),self.assertRaises(ValueError):
                source.parse_method(name,text[:-1]+'engine.Push(1);}')

    def test_declaration_ambiguity_and_unknown_tokens_reject(self):
        for text in ['public void M() { } public void M() { }','public void M() { `; }','public void M() {']:
            with self.subTest(text=text),self.assertRaises(ValueError):source.body(text,'public void M()')

    def test_unsupported_field_and_call_bindings_reject(self):
        changes=[('LoadContract','method.Offset','method.Parameters.Length'),('Clone','_sharedStates','otherStates'),('GetState','_sharedStates.States','OtherStates'),('SharedConstructor','new(referenceCounter)','existingStack')]
        for name,before,after in changes:
            with self.subTest(name=name),self.assertRaises(ValueError):
                source.parse_method(name,source.TEMPLATES[name].replace(before,after))

    def test_each_allowed_semantic_change_affects_program(self):
        count=0
        for name,slots in source.PATCHES.items():
            for before,alternates in slots:
                for after,expected in alternates.items():
                    with self.subTest(name=name,after=after):
                        self.assertEqual(source.parse_method(name,source.TEMPLATES[name].replace(before,after)),expected)
                        self.assertTrue(any(source.BASE_PROGRAM[k]!=v for k,v in expected.items()));count+=1
        self.assertEqual(count,len(source.EXPECTED_CONTROLS))

    def test_missing_extra_and_duplicate_source_identity_reject(self):
        with self.assertRaises(ValueError):source.project_captured({})
        rows={k:dict(path='/same/file',url=source.source_url(v),sha256=v['sha256']) for k,v in source.SOURCES.items()}
        rows['extra']=rows[next(iter(rows))]
        with self.assertRaises(ValueError):source.project_captured(rows)

    def test_swapped_url_or_unpinned_hash_reject_before_read(self):
        for field,value in [('url','https://example.invalid/source'),('sha256','0'*64),('path','relative.cs')]:
            rows={k:dict(path='/missing',url=source.source_url(v),sha256=v['sha256']) for k,v in source.SOURCES.items()}
            rows[next(iter(rows))][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):source.project_captured(rows)

    def test_production_enforces_full_file_hashes(self):
        contents={k:'' for k in source.SOURCES}
        with self.assertRaisesRegex(ValueError,'Pinned source mismatch'):source.project_sources(contents)

    @unittest.skipUnless(os.environ.get('ENTRY_DISPATCH_SOURCE_DIR'),'Pinned source fixture is exercised by fresh CLI; optional unit readback needs ENTRY_DISPATCH_SOURCE_DIR')
    def test_actual_pinned_sources_and_every_control(self):
        directory=Path(os.environ['ENTRY_DISPATCH_SOURCE_DIR'])
        contents={k:(directory/(k.replace('/','-')+'.cs')).read_text() for k in source.SOURCES}
        baseline=source.project_sources(contents)
        self.assertEqual(baseline['program'],source.BASE_PROGRAM)
        for name in source.EXPECTED_CONTROLS:
            with self.subTest(name=name):
                mutant,_=source.mutated_projection(contents,name)
                self.assertNotEqual(mutant['program'],baseline['program'])
        with tempfile.TemporaryDirectory() as out:
            rows={}
            for key,spec in source.SOURCES.items():
                p=Path(out)/(key.replace('/','-')+'.cs');p.write_text(contents[key]);rows[key]=dict(path=str(p),url=source.source_url(spec),sha256=spec['sha256'])
            self.assertEqual(source.project_captured(rows),baseline)
            p=Path(rows['vm/shared']['path']);p.write_text(p.read_text()+'// changed\n')
            with self.assertRaisesRegex(ValueError,'bytes mismatch'):source.project_captured(rows)


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
        key=next(iter(source.SOURCES))
        with tempfile.TemporaryDirectory() as out:
            # The offline mirror is an environment fault fallback, not part of
            # this contract: if it is set the download never happens and this
            # test would assert nothing. Neutralise it so the pinned-hash check
            # is what actually rejects the bytes.
            with mock.patch.dict(os.environ,{'SA_ENTRY_DISPATCH_SOURCE_MIRROR':''}):
                with mock.patch.object(source.urllib.request,'urlopen',
                                       lambda url,timeout=None:_Payload(b'not the pinned source')):
                    with self.assertRaisesRegex(ValueError,'Downloaded pinned source mismatch'):
                        source.project_production(out)
            self.assertEqual([],list(Path(out).iterdir()))

    def test_offline_mirror_bytes_still_have_to_match_the_pinned_hash(self):
        key=next(iter(source.SOURCES))
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as mirror:
            (Path(mirror)/(key.replace('/','-')+'.cs')).write_bytes(b'not the pinned source')
            with mock.patch.dict(os.environ,{'SA_ENTRY_DISPATCH_SOURCE_MIRROR':mirror}):
                # A mirror must not launder different bytes: the pin still decides.
                with mock.patch.object(source.urllib.request,'urlopen',
                                       lambda *a,**k:self.fail('mirror hit attempted a download')):
                    with self.assertRaisesRegex(ValueError,'Offline mirror source mismatch'):
                        source.project_production(out)
            self.assertEqual([],list(Path(out).iterdir()))

    def test_absent_mirror_entry_falls_back_to_the_pinned_download(self):
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as mirror:
            def unreachable(url,timeout=None):raise TimeoutError('transport unavailable')
            with mock.patch.dict(os.environ,{'SA_ENTRY_DISPATCH_SOURCE_MIRROR':mirror}):
                with mock.patch.object(source.urllib.request,'urlopen',unreachable):
                    # An empty mirror directory is not evidence of anything, so the
                    # lane must still reach the network path and fail closed there.
                    with self.assertRaises(TimeoutError):
                        source.project_production(out)


class _Payload(object):
    """Minimal stand-in for the object urlopen returns."""

    def __init__(self,body):self.body=body

    def read(self):return self.body


if __name__=='__main__':unittest.main()
