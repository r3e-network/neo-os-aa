import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
try:
    from . import entry_dispatch_proofs as proofs, entry_dispatch_source as source
except ImportError:
    import entry_dispatch_proofs as proofs, entry_dispatch_source as source


class EntryDispatchProofTests(unittest.TestCase):
    def test_program_record_rejects_missing_extra_and_wrong_types(self):
        for mutation in ['missing','extra','bool-as-int','negative']:
            program=dict(source.BASE_PROGRAM)
            if mutation=='missing':program.pop('clone_shared')
            if mutation=='extra':program['ignored']=True
            if mutation=='bool-as-int':program['clone_rv']=False
            if mutation=='negative':program['clone_rv']=-1
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):proofs.program_expression(program)

    def test_semantic_witnesses_use_actual_behavior(self):
        self.assertEqual(len(proofs.EXPECTED_CONTROLS),12)
        for name in proofs.EXPECTED_CONTROLS:
            lhs,rhs=proofs.control_expression(name)
            self.assertIn('source_call mutant_program',lhs)
            self.assertNotIn('canonical_program',lhs+rhs)
            if name!='drop-underscore-guard':self.assertIn('spec_success',rhs)
        self.assertIn('dispatch_fixture_args',proofs.control_expression('reverse-argument-order')[0])

    def test_unsupported_name_encoding_rejects(self):
        for name in ['a"b','a\\b','a\nb','']:
            with self.subTest(name=name),self.assertRaises(ValueError):proofs.coq_string(name)

    @unittest.skipUnless(os.environ.get('ENTRY_DISPATCH_INVENTORY'),'Actual artifact fixture is exercised by fresh CLI; optional unit readback needs ENTRY_DISPATCH_INVENTORY')
    def test_actual_binding_and_manifest_drift(self):
        inventory=json.loads(Path(os.environ['ENTRY_DISPATCH_INVENTORY']).read_text())
        bound=proofs.bind_inventory(inventory)
        self.assertEqual(bound['fullUnprovedEntrypointCount'],100)
        self.assertEqual(set(bound['entries']),{'getAccountImplementationId','supportsExecutionMode','supportsModuleType'})
        self.assertEqual(len(bound['dispatchBoundEntrypoints']),100)
        self.assertEqual(sum(1 for d in bound['dispatchBoundEntrypoints'] if d['safe'] and d['nonvoid']),55)
        for field in ['offset','safe','returntype']:
            bad=copy.deepcopy(inventory);row=next(x for x in bad['manifest']['methods'] if x['name']=='getAccountImplementationId')
            row[field]={'offset':row['offset']+1,'safe':False,'returntype':'Void'}[field]
            with self.subTest(field=field),self.assertRaises(ValueError):proofs.bind_inventory(bad)
        certificate=proofs.render_certificate(bound,dict(entryBoundary=source.ENTRY_BOUNDARY,program=source.BASE_PROGRAM))
        self.assertIn('source_call actual_program actual_manifest',certificate)
        self.assertIn('eapply source_bound_safe_call_frame_refines_spec',certificate)
        # 3 base theorems + one lookup per entry (100) + one frame refinement
        # per safe/nonvoid entry (55); duplicate ABI names carry arity suffixes.
        self.assertEqual(len(proofs.declarations(certificate)),158)
        self.assertIn('finalizeEscape_2_actual_abi_lookup',certificate)
        self.assertIn('finalizeEscape_3_actual_abi_lookup',certificate)
        self.assertNotIn('finalizeEscape_actual_abi_lookup',certificate)
        self.assertIn('Theorem getVerifier_actual_entry_frame',certificate)
        self.assertIn('Theorem registerAccount_actual_abi_lookup',certificate)
        self.assertNotIn('Theorem registerAccount_actual_entry_frame',certificate)

@unittest.skipUnless(os.environ.get('ENTRY_DISPATCH_SOURCE_DIR'),
    'Pinned source readback needs ENTRY_DISPATCH_SOURCE_DIR; these are synthetic unit receipts, not kernel evidence')
class EntryDispatchControlRegenerationTests(unittest.TestCase):
    """Exercise receipt integrity using real sources and clearly synthetic logs.

    No kernel status is inferred from these fixtures. Fresh kernel execution is
    the proof runner's responsibility; these tests cover exact regeneration and
    the preserved byte/hash inventories consumed after that execution.
    """

    @classmethod
    def setUpClass(cls):
        directory=Path(os.environ['ENTRY_DISPATCH_SOURCE_DIR']).resolve()
        cls.contents={key:(directory/(key.replace('/','-')+'.cs')).read_text()
                      for key in source.SOURCES}
        cls.pinned_source={key:dict(path=str(directory/(key.replace('/','-')+'.cs')),
                                   url=source.source_url(spec),sha256=spec['sha256'])
                           for key,spec in source.SOURCES.items()}
        # Establish that all fixtures start from the complete actual pinned
        # source set, rather than mocking the source projector or its hashes.
        source.project_captured(cls.pinned_source)

    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='entry-dispatch-synthetic-unit-')
        self.addCleanup(temporary.cleanup)
        self.directory=Path(temporary.name)
        kernel_guard=mock.patch.object(proofs.subprocess,'run',
            side_effect=AssertionError('Synthetic regeneration units must not run the kernel'))
        kernel_guard.start()
        self.addCleanup(kernel_guard.stop)
        self.report=dict(fixtureKind='synthetic-unit-control-evidence-no-kernel-execution',
                         pinnedSource=copy.deepcopy(self.pinned_source),semanticControls=[],
                         controlProofSha256={},controlLogSha256={})
        for name in proofs.EXPECTED_CONTROLS:
            mutant,mutation_hash=source.mutated_projection(self.contents,name)
            case=self.directory/name
            case.mkdir()
            rendered=proofs.render_control_sources(name,mutant)
            for filename,text in rendered.items():
                data=text.encode()
                (case/filename).write_bytes(data)
                self.report['controlProofSha256'][name+'/'+filename]=source.sha(data)
            for filename in proofs.CONTROL_LOG_FILES:
                data=('SYNTHETIC UNIT FIXTURE; no kernel executed.\n'+name+'/'+filename+'\n').encode()
                (case/filename).write_bytes(data)
                self.report['controlLogSha256'][name+'/'+filename]=source.sha(data)
            self.report['semanticControls'].append(dict(name=name,
                sourceMutationSha256=mutation_hash,projectionSha256=source.sha(source.canonical(mutant)),
                definitionsSha256=self.report['controlProofSha256'][name+'/Definitions.v'],
                counterexampleSha256=self.report['controlProofSha256'][name+'/Counterexample.v'],
                rejectionLogSha256=self.report['controlLogSha256'][name+'/rejection.log']))

    def test_regeneration_returns_exact_expected_proof_inventory(self):
        expected_names={name+'/'+filename for name in proofs.EXPECTED_CONTROLS
                        for filename in proofs.CONTROL_PROOF_FILES}
        actual=proofs.regenerate_controls(self.report,self.directory)
        self.assertEqual(set(actual),expected_names)
        self.assertEqual(actual,{name:source.sha((self.directory/name).read_bytes())
                                 for name in expected_names})
        self.assertEqual(actual,self.report['controlProofSha256'])
        self.assertEqual(set(self.report['controlLogSha256']),
                         {name+'/'+filename for name in proofs.EXPECTED_CONTROLS
                          for filename in proofs.CONTROL_LOG_FILES})

    def test_missing_extra_or_changed_hash_inventory_row_rejects(self):
        for field,message in [('controlProofSha256','control proof hash inventory'),
                              ('controlLogSha256','control log hash inventory')]:
            for mutation in ['missing','extra','changed']:
                bad=copy.deepcopy(self.report)
                key=next(iter(bad[field]))
                if mutation=='missing':bad[field].pop(key)
                elif mutation=='extra':bad[field]['unexpected/extra.log']='0'*64
                else:bad[field][key]='0'*64
                with self.subTest(field=field,mutation=mutation),self.assertRaisesRegex(ValueError,message):
                    proofs.regenerate_controls(bad,self.directory)

    def test_missing_extra_duplicate_or_reordered_control_rejects(self):
        for mutation in ['missing','extra','duplicate','reordered']:
            bad=copy.deepcopy(self.report)
            rows=bad['semanticControls']
            if mutation=='missing':rows.pop()
            elif mutation=='extra':rows.append(copy.deepcopy(rows[0]))
            elif mutation=='duplicate':rows[1]=copy.deepcopy(rows[0])
            else:rows[0],rows[1]=rows[1],rows[0]
            with self.subTest(mutation=mutation),self.assertRaisesRegex(ValueError,'semantic control'):
                proofs.regenerate_controls(bad,self.directory)

    def test_changed_proof_rejects_even_when_receipt_hashes_are_rewritten(self):
        name=proofs.EXPECTED_CONTROLS[0]
        for filename in proofs.CONTROL_PROOF_FILES:
            path=self.directory/name/filename
            original=path.read_bytes()
            changed=original+b'\n(* Synthetic unit tamper. *)\n'
            path.write_bytes(changed)
            bad=copy.deepcopy(self.report)
            bad['controlProofSha256'][name+'/'+filename]=source.sha(changed)
            if filename=='Definitions.v':bad['semanticControls'][0]['definitionsSha256']=source.sha(changed)
            if filename=='Counterexample.v':bad['semanticControls'][0]['counterexampleSha256']=source.sha(changed)
            try:
                with self.subTest(filename=filename),self.assertRaisesRegex(ValueError,'Changed control proof'):
                    proofs.regenerate_controls(bad,self.directory)
            finally:path.write_bytes(original)

    def test_changed_preserved_log_rejects(self):
        name=proofs.EXPECTED_CONTROLS[0]
        for filename in proofs.CONTROL_LOG_FILES:
            path=self.directory/name/filename
            original=path.read_bytes()
            path.write_bytes(original+b'Changed synthetic unit log.\n')
            try:
                with self.subTest(filename=filename),self.assertRaisesRegex(ValueError,'log hash'):
                    proofs.regenerate_controls(self.report,self.directory)
            finally:path.write_bytes(original)

    def test_changed_source_mutation_or_projection_hash_rejects(self):
        for field,message in [('sourceMutationSha256','Changed source mutation'),
                              ('projectionSha256','Changed mutant projection')]:
            bad=copy.deepcopy(self.report)
            bad['semanticControls'][0][field]='0'*64
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,message):
                proofs.regenerate_controls(bad,self.directory)

    def test_changed_per_control_hash_rejects(self):
        for field,message in [('definitionsSha256','Wrong definitions hash'),
                              ('counterexampleSha256','Wrong counterexample hash'),
                              ('rejectionLogSha256','Wrong rejection log hash')]:
            bad=copy.deepcopy(self.report)
            bad['semanticControls'][0][field]='0'*64
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,message):
                proofs.regenerate_controls(bad,self.directory)


if __name__=='__main__':unittest.main()
