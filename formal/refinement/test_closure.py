"""Fail-closed join/runner checks. Fixtures are not proof evidence."""
import importlib.util
import copy
import json
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
FIXTURE_ROOT = str(Path(Path(__file__).anchor) / 'fixture')
SPEC = importlib.util.spec_from_file_location('closure_under_test', HERE / 'closure.py')


def load():
    result = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(result)
    return result


def fixture(module):
    inventory = {'nef': {'sha256': 'a'*64, 'scriptSha256': 'b'*64, 'scriptHex': '1140'},
                 'manifest': {'sha256': 'c'*64, 'methods': [{'name': '_initialize', 'offset': 1, 'parameters': [], 'returntype': 'Void'},
                     {'name': 'pure', 'offset': 0, 'parameters': [], 'safe': True, 'returntype': 'Boolean'},
                     {'name': 'getValue', 'offset': 0, 'parameters': [], 'safe': True, 'returntype': 'Boolean'},
                     {'name': 'isActive', 'offset': 1, 'parameters': [], 'safe': True, 'returntype': 'Boolean'}]},
                 'source': {}, 'inputs': {}}
    control = {'name': 'valid-mutant', 'definitionsCompiled': True, 'certificateRejected': True}
    receipts = {name: dict(scope=scope, kernelChecked=True, fullImplementationVerified=False,
                          modelSha256={'Model': 'd'*64}, semanticControls=[control])
                for name, scope in module.SCOPES.items()}
    for name in module.ARTIFACT_LANES:
        receipts[name].update(nefSha256='a'*64, scriptSha256='b'*64)
    method_hash = module.sha(bytes.fromhex('11'))
    receipts['method'].update(certificateSha256='e'*64, methodSha256=method_hash,
                              methodRange=[0,1],byteCount=1,instructionCount=1,
                              sourceProjectionSha256='1'*64, referenceRefinementVerified=True)
    init_sha = module.sha(bytes.fromhex('40'))
    receipts['context'].update(initializerSha256=init_sha, initializerRange=[1, 2], instructionCount=1)
    receipts['context'].update(helperContextVerified=True, methodSha256=method_hash,
                               methodRange=[0,1],methodByteCount=1,methodInstructionCount=1)
    receipts['initializer'].update(initializerSha256=init_sha, sourceProjectionSha256='2'*64,
                                   fieldCount=1, sourceProjection={'initializers': [{}]},
                                   sourceFrontendVerified=False, applicationEngineVerified=False)
    receipts['composition'].update(helperCertificateSha256='e'*64, helperMethodSha256=method_hash,
        actualHelperTheoremApplied=True, semanticControls={
            'schema': 'neoos-sa-reimbursement-composition-controls/v1', 'scope': module.SCOPES['composition'],
            'definitionsCompiled': True, 'rejected': ['valid-mutant'],
            'controls': {'valid-mutant': {**control, 'kernelExitCode': 1}}})
    receipts['public'].update(methods={'pure': dict(abi=inventory['manifest']['methods'][1],
        start=0, end=1, bytes=[17], methodSha256=method_hash, instructionCount=1)},
        referenceVerifiedEntrypoints=['pure'], fullUnprovedEntrypointCount=len(inventory['manifest']['methods']),
        vmCorrespondenceProven=False)
    receipts['runtime'].update(productionSourceBound=True, sourceCommit=module.VM_COMMIT,
                               provenOpcodes=['ADD'], runtimeImplementationProven=False, sourceProjectionSha256='3'*64)
    receipts['runtime-collections'].update(productionSourceBound=True,sourceCommit=module.VM_COMMIT,
        runtimeImplementationProven=False,sourceProjectionSha256='3'*64,provenOpcodes=['PICKITEM'],
        supportingProjections=dict(module.COLLECTION_PARTIAL_SCOPES))
    receipts['gas'].update(productionSourceBound=True, sourceCommit=module.CORE_COMMIT,
                           projectionSha256='4'*64, sourceFrontendVerified=False, applicationEngineVerified=False)
    receipts['codec'].update(nativeVectorJoin=None, nativeVectorKernel=None, runtimeSourceSimulationProven=False)
    receipts['codec']['typedNativeSource'] = {'kernelChecked': True, 'scope':module.CODEC_SOURCE_SCOPE,'fullSourceSimulationProven': False,
        'inventorySha256': '1'*64, 'projectionSha256': '2'*64,
        'certificateSha256':'3'*64,'sourceModelSha256':'4'*64,
        'semanticControlBaseline':{'kernelChecked':True,'certificateSha256':'5'*64},
        'closedDeclarations':['serializer','deserializer','roundtrip'],
        **{key:{'kernelChecked':True,'closedDeclarations':[name],'certificateSha256':'3'*64}
           for key,name in [('serializerKernel','serializer'),('deserializerKernel','deserializer'),('sourceRoundtripKernel','roundtrip')]},
        'semanticControls': {'a': {'typedCompilationSucceeded': True,
            'resolvedOperationProjectionSucceeded': True, 'originalBehaviorRejected': True,
            'definitionsKernelCompiled':True,'serializerUniversalTheoremRejected':True,'deserializerUniversalTheoremRejected':True}}}
    receipts['helper-gas'].update(applicationEngineVerified=False,sourceFrontendVerified=False,sourceCommit=module.CORE_COMMIT,
        sourcePricingPinned=True,modelPriceBoundProved=True,actualRuntimeCrossChecked=True,
        artifacts={'nefSha256':'a'*64,'scriptSha256':'b'*64,'manifestSha256':'c'*64,'helperSha256':method_hash})
    receipts['storage-getters'].update(
        schema='neoos-sa-storage-getter-source-refinement/v1', coqchkChecked=True, assumptionsClosed=True,
        vmCorrespondenceProven=True, projectionSha256='7'*64,
        vmCorrespondenceScope='Trace-level bytecode execution of the pinned getter regions',
        referenceVerifiedEntrypoints=[], fullUnprovedEntrypointCount=len(inventory['manifest']['methods']),
        openObligations=['APPLICATION_ENGINE_REFINEMENT', 'ALL_REMAINING_PUBLIC_ENTRYPOINTS'],
        storageGetterSourceVerified=['getValue', 'isActive'],
        dispatchBoundEntrypoints=['getValue', 'isActive'],
        vmTraceCoverage={'getValue': ['miss', 'hit-valid'], 'isActive': ['miss', 'hit']},
        methods={'getValue': dict(abi=inventory['manifest']['methods'][2], start=0, endExclusive=1,
                                  byteCount=1, regionBytesSha256=method_hash, instructionCount=1),
                 'isActive': dict(abi=inventory['manifest']['methods'][3], start=1, endExclusive=2,
                                  byteCount=1, regionBytesSha256=module.sha(bytes.fromhex('40')),
                                  instructionCount=1)},
        sharedCallees=[dict(name=name, regions=[0,1], projectionKinds=['kind-' + name],
                            deserializeTokenIndex=4)
                       for name in module.STORAGE_GETTER_SHARED_CALLEES],
        vmSemanticControls=[dict(name='vm-control', getter='getValue', definitionsAccepted=True,
                                 baselineAccepted=True, proofRejected=True, kernelExitCode=1,
                                 baselineSha256='8'*64, definitionsSha256='9'*64)],
        semanticControls=[control])
    receipts['entry-dispatch'].update(schema='neoos-sa-entry-dispatch-proof/v1',
        entryBoundary='CallContract-after-interop-admission-and-argument-conversion',
        productionSourceBound=True, coqchkChecked=True, assumptionsClosed=True, coreSourceCommit=module.CORE_COMMIT, neoVmSourceCommit=module.VM_COMMIT,
        sourceFrontendVerified=False, applicationEngineVerified=False, vmCorrespondenceProven=False,
        fullUnprovedEntrypointCount=len(inventory['manifest']['methods']), manifestSha256='c'*64, inventorySha256='1'*64,
        sourceProjectionSha256='2'*64, certificateSha256='3'*64,
        referenceVerifiedEntrypoints=['pure'],
        entries={'pure': dict(abi=inventory['manifest']['methods'][1], methodRange=[0,1],
            methodSha256=method_hash, instructionCount=1)},
        initializer=dict(abi=inventory['manifest']['methods'][0], methodRange=[1,2],
            methodSha256=init_sha, instructionCount=1),
        semanticControls=[dict(control, name=name, kernelExitCode=1, definitionLanguage='Coq source projection',
            kernelCounterexampleChecked=True, **{field:'5'*64 for field in
                ('sourceMutationSha256','projectionSha256','definitionsSha256','counterexampleSha256','rejectionLogSha256')})
            for name in module.ENTRY_DISPATCH_CONTROLS],
        pinnedSource={repository: dict(path=FIXTURE_ROOT + '/' + repository + '.cs', sha256='4'*64,
            url='https://raw.githubusercontent.com/neo-project/' + repository + '/' + commit + '/source.cs')
            for repository, commit in (('neo', module.CORE_COMMIT), ('neo-vm', module.VM_COMMIT))},
        **copy.deepcopy(module.ENTRY_DISPATCH_DOMAIN))
    receipts['syscall-dispatch'].update(schema='neoos-sa-syscall-dispatch-proof/v1',
        entryBoundary='CallContractInternal-parameter-tuple', productionSourceBound=True,
        coqchkChecked=True, assumptionsClosed=True, implementationVerified=False,
        coreSourceCommit=module.CORE_COMMIT, neoVmSourceCommit=module.VM_COMMIT,
        sourceFrontendVerified=False, applicationEngineVerified=False, vmCorrespondenceProven=False,
        sourceProjectionSha256='2'*64, certificateSha256='3'*64,
        program=copy.deepcopy(module.SYSCALL_DISPATCH_PROGRAM),
        handlerParameters=copy.deepcopy(module.SYSCALL_DISPATCH_HANDLER_PARAMETERS),
        tokenFields=list(module.SYSCALL_DISPATCH_TOKEN_FIELDS),
        pinnedSource={repository: dict(path=FIXTURE_ROOT + '/' + repository + '.cs', sha256='4'*64,
            url='https://raw.githubusercontent.com/neo-project/' + repository + '/' + commit + '/source.cs')
            for repository, commit in (('neo', module.CORE_COMMIT), ('neo-vm', module.VM_COMMIT))},
        semanticControls=[dict(control, name=name, kernelExitCode=1, kernelCounterexampleChecked=True,
            **{field:'5'*64 for field in ('sourceMutationSha256', 'projectionSha256', 'definitionsSha256',
                                         'counterexampleSha256', 'rejectionLogSha256')})
            for name in module.SYSCALL_DISPATCH_CONTROLS],
        controlProofSha256={name+'/'+filename:'6'*64 for name in module.SYSCALL_DISPATCH_CONTROLS
                            for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')},
        controlLogSha256={name+'/'+filename:'7'*64 for name in module.SYSCALL_DISPATCH_CONTROLS
                          for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                           'counterexample-coqchk.log')},
        closedDeclarations={'SyscallDispatch': ['model-a', 'model-b'],
                            'SyscallDispatchArtifact': ['cert-a']},
        closedAssumptionCount=3, kernelDeclarations=['cert-a'],
        **copy.deepcopy(module.SYSCALL_DISPATCH_DOMAIN))
    receipts['contract-handoff'].update(schema='neoos-sa-contract-handoff-proof/v1',
        entryBoundary='LoadContract-returned-context-before-callee-execution', productionSourceBound=True,
        coqchkChecked=True, assumptionsClosed=True, implementationVerified=False,
        coreSourceCommit=module.CORE_COMMIT, neoVmSourceCommit=module.VM_COMMIT,
        sourceFrontendVerified=False, applicationEngineVerified=False, vmCorrespondenceProven=False,
        sourceProjectionSha256='2'*64, certificateSha256='3'*64,
        program=copy.deepcopy(module.CONTRACT_HANDOFF_PROGRAM),
        reasonOnlyGuards=['contract-absent', 'method-absent', 'arity-equality', 'return-xor'],
        pinnedSource={name: dict(path=FIXTURE_ROOT + '/' + name.replace('/', '-') + '.cs', sha256='4'*64,
            url='https://raw.githubusercontent.com/neo-project/' + repository + '/' + commit + '/src/' + name + '.cs')
            for name, repository, commit in (
                ('core/engine', 'neo', module.CORE_COMMIT), ('core/abi', 'neo', module.CORE_COMMIT),
                ('core/basic', 'neo', module.CORE_COMMIT), ('core/flags', 'neo', module.CORE_COMMIT),
                ('core/method', 'neo', module.CORE_COMMIT),
                ('core/contract-state', 'neo', module.CORE_COMMIT),
                ('core/policy', 'neo', module.CORE_COMMIT),
                ('vm/context', 'neo-vm', module.VM_COMMIT), ('vm/stack', 'neo-vm', module.VM_COMMIT))},
        semanticControls=[dict(name=name, definitionsCompiled=True, certificateRejected=True,
            kernelExitCode=1, kernelCounterexampleChecked=True, timedOut=False,
            **{field:'5'*64 for field in ('sourceMutationSha256', 'projectionSha256', 'definitionsSha256',
                                         'counterexampleSha256', 'rejectionLogSha256')})
            for name in module.CONTRACT_HANDOFF_CONTROLS],
        controlProofSha256={name+'/'+filename:'6'*64 for name in module.CONTRACT_HANDOFF_CONTROLS
                            for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')},
        controlLogSha256={name+'/'+filename:'7'*64 for name in module.CONTRACT_HANDOFF_CONTROLS
                          for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                           'counterexample-coqchk.log')},
        closedDeclarations={'ContractHandoff': ['model-a', 'model-b'],
                            'ContractHandoffArtifact': ['cert-a']},
        closedAssumptionCount=3, kernelDeclarations=['cert-a'],
        **copy.deepcopy(module.CONTRACT_HANDOFF_DOMAIN))
    receipts['interop-conversion'].update(schema='neoos-sa-interop-conversion-proof/v1',
        entryBoundary='OnSysCall-argument-window-to-invoked-handler-parameters',
        productionSourceBound=True, coqchkChecked=True, assumptionsClosed=True,
        implementationVerified=False, coreSourceCommit=module.CORE_COMMIT,
        neoVmSourceCommit=module.VM_COMMIT, sourceFrontendVerified=False,
        applicationEngineVerified=False, vmCorrespondenceProven=False,
        sourceProjectionSha256='2'*64, certificateSha256='3'*64,
        program=copy.deepcopy(module.INTEROP_CONVERSION_PROGRAM),
        parameters=[list(row) for row in module.INTEROP_CONVERSION_ARGUMENTS],
        reasonOnlyGuards=['call-flags', 'descriptor-validators'],
        pinnedSource={name: dict(path=FIXTURE_ROOT + '/' + name.replace('/', '-') + '.cs', sha256='4'*64,
            url='https://raw.githubusercontent.com/neo-project/' + repository + '/' + commit
                + '/' + relative)
            for name, repository, commit, relative in (
                ('core/engine', 'neo', module.CORE_COMMIT,
                 'src/Neo/SmartContract/ApplicationEngine.cs'),
                ('core/contract', 'neo', module.CORE_COMMIT,
                 'src/Neo/SmartContract/ApplicationEngine.Contract.cs'),
                ('core/interop-parameter', 'neo', module.CORE_COMMIT,
                 'src/Neo/SmartContract/InteropParameterDescriptor.cs'),
                ('vm/limits', 'neo-vm', module.VM_COMMIT,
                 'src/Neo.VM/ExecutionEngineLimits.cs'))},
        semanticControls=[dict(name=name, definitionsCompiled=True, certificateRejected=True,
            kernelExitCode=1, kernelCounterexampleChecked=True, timedOut=False,
            **{field:'5'*64 for field in ('sourceMutationSha256', 'projectionSha256',
                                         'definitionsSha256', 'counterexampleSha256',
                                         'rejectionLogSha256')})
            for name in module.INTEROP_CONVERSION_CONTROLS],
        controlProofSha256={name+'/'+filename:'6'*64 for name in module.INTEROP_CONVERSION_CONTROLS
                            for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')},
        controlLogSha256={name+'/'+filename:'7'*64 for name in module.INTEROP_CONVERSION_CONTROLS
                          for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                           'counterexample-coqchk.log')},
        closedDeclarations={'InteropConvert': ['model-a', 'model-b'],
                            'InteropConvertArtifact': ['cert-a']},
        closedAssumptionCount=3, kernelDeclarations=['cert-a'],
        **copy.deepcopy(module.INTEROP_CONVERSION_DOMAIN))
    receipts['interop-fee-order'].update(schema='neoos-sa-interop-charge-proof/v1',
        entryBoundary='OnSysCall-descriptor-charge-to-argument-window-effect',
        productionSourceBound=True, coqchkChecked=True, assumptionsClosed=True,
        implementationVerified=False, coreSourceCommit=module.CORE_COMMIT,
        sourceFrontendVerified=False, applicationEngineVerified=False,
        vmCorrespondenceProven=False,
        sourceProjectionSha256='8'*64, certificateSha256='9'*64,
        program=copy.deepcopy(module.INTEROP_FEE_PROGRAM),
        reasonOnlyGuards=['descriptor-price-identity', 'fee-factor-source'],
        pinnedSource={name: dict(path=FIXTURE_ROOT + '/' + name.replace('/', '-') + '.cs', sha256='4'*64,
            url='https://raw.githubusercontent.com/neo-project/neo/' + module.CORE_COMMIT
                + '/' + relative)
            for name, relative in (
                ('core/engine', 'src/Neo/SmartContract/ApplicationEngine.cs'),
                ('core/descriptor', 'src/Neo/SmartContract/InteropDescriptor.cs'))},
        semanticControls=[dict(name=name, definitionsCompiled=True, certificateRejected=True,
            kernelExitCode=1, kernelCounterexampleChecked=True, timedOut=False,
            **{field:'5'*64 for field in ('sourceMutationSha256', 'projectionSha256',
                                         'definitionsSha256', 'counterexampleSha256',
                                         'rejectionLogSha256')})
            for name in module.INTEROP_FEE_CONTROLS],
        controlProofSha256={name+'/'+filename:'6'*64 for name in module.INTEROP_FEE_CONTROLS
                            for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')},
        controlLogSha256={name+'/'+filename:'7'*64 for name in module.INTEROP_FEE_CONTROLS
                          for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                           'counterexample-coqchk.log')},
        closedDeclarations={'InteropFee': ['model-a', 'model-b'],
                            'InteropFeeArtifact': ['cert-a']},
        closedAssumptionCount=3, kernelDeclarations=['cert-a'],
        **copy.deepcopy(module.INTEROP_FEE_DOMAIN))
    receipts['exception-identity'].update(schema='neoos-sa-exception-identity-proof/v1',
        entryBoundary='ExecuteNext-fault-surfacing-and-catch-admission-effect',
        productionSourceBound=True, coqchkChecked=True, assumptionsClosed=True,
        implementationVerified=False, coreSourceCommit=module.CORE_COMMIT,
        vmSourceCommit=module.VM_COMMIT,
        sourceFrontendVerified=False, applicationEngineVerified=False,
        vmCorrespondenceProven=False,
        sourceProjectionSha256='8'*64, certificateSha256='9'*64,
        program=copy.deepcopy(module.EXCEPTION_IDENTITY_PROGRAM),
        reasonOnlyGuards=['catch-clause-subtyping', 'fault-terminates-the-turn'],
        pinnedSource={name: dict(path=FIXTURE_ROOT + '/' + name.replace('/', '-') + '.cs', sha256='4'*64,
            url='https://raw.githubusercontent.com/neo-project/'
                + ('neo' if name == 'core/engine' else 'neo-vm') + '/'
                + module.EXCEPTION_IDENTITY_SOURCES[name][0] + '/'
                + module.EXCEPTION_IDENTITY_SOURCES[name][1])
            for name in module.EXCEPTION_IDENTITY_SOURCES},
        semanticControls=[dict(name=name, definitionsCompiled=True, certificateRejected=True,
            kernelExitCode=1, kernelCounterexampleChecked=True, timedOut=False,
            **{field:'5'*64 for field in ('sourceMutationSha256', 'projectionSha256',
                                         'definitionsSha256', 'counterexampleSha256',
                                         'rejectionLogSha256')})
            for name in module.EXCEPTION_IDENTITY_CONTROLS],
        controlProofSha256={name+'/'+filename:'6'*64
                            for name in module.EXCEPTION_IDENTITY_CONTROLS
                            for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')},
        controlLogSha256={name+'/'+filename:'7'*64
                          for name in module.EXCEPTION_IDENTITY_CONTROLS
                          for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                           'counterexample-coqchk.log')},
        closedDeclarations={'ExceptionIdentity': ['model-a', 'model-b'],
                            'ExceptionIdentityArtifact': ['cert-a']},
        closedAssumptionCount=3, kernelDeclarations=['cert-a'],
        **copy.deepcopy(module.EXCEPTION_IDENTITY_DOMAIN))
    receipts['load-admission'].update(schema='neoos-sa-load-admission-proof/v1',
        entryBoundary='manifest-parse-and-nef-deserialize-admission-to-exact-arity-resolution',
        productionSourceBound=True, coqchkChecked=True, assumptionsClosed=True,
        implementationVerified=False, deploymentPathVerified=False,
        coreSourceCommit=module.CORE_COMMIT,
        sourceFrontendVerified=False, applicationEngineVerified=False,
        vmCorrespondenceProven=False,
        sourceProjectionSha256='a'*64, certificateSha256='b'*64,
        program=copy.deepcopy(module.LOAD_ADMISSION_PROGRAM),
        reasonOnlyGuards=['exact-lookup-key-is-(name,arity)',
                          'the-checksum-is-last-and-optional'],
        pinnedSource={name: dict(path=FIXTURE_ROOT + '/' + name.replace('/', '-') + '.cs', sha256='4'*64,
            url='https://raw.githubusercontent.com/neo-project/neo/'
                + module.LOAD_ADMISSION_SOURCES[name][0] + '/'
                + module.LOAD_ADMISSION_SOURCES[name][1])
            for name in module.LOAD_ADMISSION_SOURCES},
        semanticControls=[dict(name=name, definitionsCompiled=True, certificateRejected=True,
            kernelExitCode=1, kernelCounterexampleChecked=True, timedOut=False,
            **{field:'5'*64 for field in ('sourceMutationSha256', 'projectionSha256',
                                         'definitionsSha256', 'counterexampleSha256',
                                         'rejectionLogSha256')})
            for name in module.LOAD_ADMISSION_CONTROLS],
        controlProofSha256={name+'/'+filename:'6'*64
                            for name in module.LOAD_ADMISSION_CONTROLS
                            for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')},
        controlLogSha256={name+'/'+filename:'7'*64
                          for name in module.LOAD_ADMISSION_CONTROLS
                          for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                           'counterexample-coqchk.log')},
        closedDeclarations={'LoadAdmission': ['model-a', 'model-b'],
                            'LoadAdmissionArtifact': ['cert-a']},
        closedAssumptionCount=3, kernelDeclarations=['cert-a'],
        **copy.deepcopy(module.LOAD_ADMISSION_DOMAIN))
    return inventory, receipts


def dispatch_control_artifacts(root, module):
    """Deliberately non-proof fixture bytes for identity-validation tests only."""
    rows = copy.deepcopy(fixture(module)[1]['entry-dispatch']['semanticControls'])
    files, logs = {}, {}
    for row in rows:
        case = root/row['name']; case.mkdir()
        for filename in ('Definitions.v','OriginalBehavior.v','Counterexample.v'):
            raw = (row['name'] + '/' + filename + '\n').encode()
            (case/filename).write_bytes(raw)
            files[row['name']+'/'+filename] = module.sha(raw)
        for filename in ('definitions.log','rejection.log','counterexample.log','counterexample-coqchk.log'):
            log = ('fixture ' + filename + '\n').encode()
            (case/filename).write_bytes(log)
            logs[row['name']+'/'+filename] = module.sha(log)
        row.update(definitionsSha256=files[row['name']+'/Definitions.v'],
                   counterexampleSha256=files[row['name']+'/Counterexample.v'],
                   rejectionLogSha256=logs[row['name']+'/rejection.log'])
    return {'controlProofSha256':files, 'controlLogSha256':logs, 'semanticControls':rows}


class FrontendCorrespondenceRegistrationTests(unittest.TestCase):
    def test_the_correspondence_harness_is_a_frozen_gate_input(self):
        module = load()
        names = {path.name for path in module.tool_paths()}
        self.assertIn('frontend_correspondence.py', names)
        self.assertIn('test_frontend_correspondence.py', names)
        # The declaration it reads out of the lanes and the reader it executes
        # are inputs too, so a lane that quietly stops sharing the scanner
        # cannot pass unnoticed.
        for lane in ('abi_admission_source.py', 'syscall_dispatch_source.py',
                     'exception_identity_source.py'):
            self.assertIn(lane, names)

    def test_a_correspondence_mismatch_is_a_gate_failure_not_a_warning(self):
        text = (HERE / 'closure.py').read_text()
        self.assertIn('source frontend correspondence mismatch', text)
        self.assertIn("correspondence.agrees(frontend_receipt)", text)

    def test_the_reader_that_judges_the_front_end_has_to_be_confirmed(self):
        text = (HERE / 'closure.py').read_text()
        self.assertIn("strict_face['filesIdentical'] == strict_face['filesCompared']", text)
        self.assertIn('no confirmed reader to judge the front end with', text)

    def test_a_gap_in_a_sliced_file_is_a_gate_failure(self):
        text = (HERE / 'closure.py').read_text()
        self.assertIn("knownGaps']['slicedGaps']", text)
        self.assertIn('lands in a file a lane slices bodies from', text)

    def test_a_moved_unique_anchor_is_a_gate_failure(self):
        text = (HERE / 'closure.py').read_text()
        self.assertIn("knownGaps']['anchorsAffectedUnique'] == 0", text)
        self.assertIn('a uniquely located anchor moved', text)

    def test_the_known_gap_list_is_frozen_in_the_gate(self):
        module = load()
        # Empty, and that is the point: the front end now reads the pinned corpus
        # the way the compiler does, so there is no gap left to excuse. A run that
        # grows one fails here.
        self.assertEqual((), tuple(module.KNOWN_FRONT_END_GAPS))
        # Retiring a gap is a record, not a silent shrink. Both retirements were
        # made on purpose and by hand: the engine file was read through a
        # disabled region until the lanes learned `#if`, and the stack file was
        # read through an interpolation hole until the lanes shared a scanner.
        for retired in ('vm-engine.cs', 'vm-stack.cs'):
            self.assertNotIn(retired, module.KNOWN_FRONT_END_GAPS)
        names = {path.name for path in module.tool_paths()}
        self.assertIn('csharp_directives.py', names)
        self.assertIn('csharp_tokens.py', names)
        text = (HERE / 'closure.py').read_text()
        self.assertIn("knownGaps']['files'] == list(KNOWN_FRONT_END_GAPS)", text)

    def test_a_front_end_that_stops_reading_the_corpus_is_a_gate_failure(self):
        # The reader the seven lanes share is what the whole face set measures,
        # so it has to be a frozen gate input like the harness that judges it.
        module = load()
        names = {path.name for path in module.tool_paths()}
        self.assertIn('csharp_tokens.py', names)
        self.assertIn('csharp_directives.py', names)

    def test_the_gate_refuses_a_needle_face_that_looks_at_nothing(self):
        # Agreement on an empty question is not agreement. The gate asks the
        # face what it saw, because the anchor floor means these literals are
        # the ones nothing else in the run looks at.
        text = (HERE / 'closure.py').read_text()
        self.assertIn("needles_face['shortOfAnchorThreshold'] > 0", text)
        self.assertIn('the needle face is empty rather than agreeing', text)

    def test_the_abi_dispatch_face_is_a_frozen_gate_input(self):
        # The engine measurement is only worth something if the code that judges
        # it cannot change between the run that produced it and the run that
        # reads it.
        module = load()
        names = {path.name for path in module.tool_paths()}
        self.assertIn('abi_dispatch.py', names)
        self.assertIn('test_abi_dispatch.py', names)
        self.assertIn('AbiDispatch.cs', names)

    def test_an_engine_that_does_not_dispatch_to_the_manifest_is_a_gate_failure(self):
        text = (HERE / 'closure.py').read_text()
        self.assertIn('dispatch.agrees(abi_receipt)', text)
        self.assertIn('actual ApplicationEngine ABI dispatch mismatch', text)
        self.assertIn("'--abi-dispatch'", text)
        # A dump measured against some other manifest has to be refused, so the
        # count is compared with the inventory the rest of the gate trusts.
        self.assertIn("abi_receipt['stats']['declared'] == len(inventory['manifest']['methods'])", text)

    def test_the_gate_requires_the_returned_shape_to_match_the_manifest(self):
        text = (HERE / 'closure.py').read_text()
        self.assertIn("abi_receipt['stats']['returnsChecked'] == abi_receipt['stats']['halted']", text)
        self.assertIn("abi_receipt['stats']['returnsMatch'] == abi_receipt['stats']['returnsChecked']", text)
        self.assertIn('the returned value shape was not checked for every completed call', text)

    def test_the_footprint_face_is_a_frozen_gate_input(self):
        # The executed offsets and the static closures are two documents that can
        # drift apart. The code that joins them is part of the frozen input for
        # the same reason as the dispatch face: a reader that can change between
        # the run and the audit has measured nothing.
        module = load()
        names = {path.name for path in module.tool_paths()}
        self.assertIn('dispatch_footprint.py', names)
        self.assertIn('test_dispatch_footprint.py', names)

    def test_the_gate_requires_the_footprint_to_stay_inside_the_closure(self):
        text = (HERE / 'closure.py').read_text()
        self.assertIn('footprint.agrees(footprint_receipt)', text)
        self.assertIn('the engine executed bytes the static graph does not reach', text)
        # The face has to be confronted with the inventory it is measuring, not
        # with a dump of its own making.
        self.assertIn("footprint.correspond(\n            dispatch_dump, output/'entrypoint-inventory.json'",
                      text)
        self.assertIn("footprint_receipt['stats']['insideClosure'] > 0", text)


class ClosureTests(unittest.TestCase):
    def setUp(self): self.module = load()

    def test_entry_dispatch_retains_scoped_reference_boundary(self):
        result = self.module.join_scopes(*fixture(self.module))
        claim = result['scopedClaims']['entry-dispatch']
        self.assertEqual(claim['referenceFrameEntrypoints'], ['pure'])
        self.assertFalse(claim['applicationEngineVerified'])
        self.assertFalse(claim['sourceFrontendVerified'])
        self.assertFalse(claim['vmCorrespondenceProven'])
        self.assertEqual(claim['unproved'], self.module.ENTRY_DISPATCH_DOMAIN['unproved'])
        self.assertEqual(result['verifiedEntrypoints'], [])
        self.assertEqual(result['fullUnprovedCount'], len(fixture(self.module)[0]['manifest']['methods']))

    def test_entry_dispatch_cannot_be_omitted_or_replace_an_existing_lane(self):
        inventory, receipts = fixture(self.module)
        del receipts['entry-dispatch']
        with self.assertRaisesRegex(ValueError, 'missing/extra'):
            self.module.join_scopes(inventory, receipts)

    def test_entry_dispatch_rejects_missing_or_forged_required_fields(self):
        fields = {'schema': 'other', 'entryBoundary': 'System.Contract.Call', 'productionSourceBound': False,
            'coqchkChecked': False, 'assumptionsClosed': False,
            'coreSourceCommit': 'other', 'neoVmSourceCommit': 'other',
            'sourceFrontendVerified': True, 'applicationEngineVerified': True,
            'vmCorrespondenceProven': True, 'fullUnprovedEntrypointCount': 0,
            'manifestSha256': '0'*64, 'inventorySha256': 'bad',
            'sourceProjectionSha256': 'bad', 'certificateSha256': 'bad',
            'entries': {}, 'referenceVerifiedEntrypoints': [], 'initializer': {},
            'semanticControls': [], 'preconditions': [], 'unproved': [], 'tcb': [],
            'pinnedSource': {}}
        for field, forged in fields.items():
            for missing in (False, True):
                inventory, receipts = fixture(self.module)
                if missing: receipts['entry-dispatch'].pop(field)
                else: receipts['entry-dispatch'][field] = forged
                with self.subTest(field=field, missing=missing), self.assertRaises(ValueError):
                    self.module.join_scopes(inventory, receipts)

    def test_entry_dispatch_cannot_join_wrong_abi_body_or_initializer(self):
        cases = [('entries', 'abi', {}), ('entries', 'methodRange', [0,2]),
            ('entries', 'methodSha256', '0'*64), ('entries', 'instructionCount', 2), ('entries', 'instructionCount', True),
            ('initializer', 'abi', {}), ('initializer', 'methodRange', [0,2]),
            ('initializer', 'methodSha256', '0'*64), ('initializer', 'instructionCount', 0),
            ('initializer', 'instructionCount', 2), ('initializer', 'instructionCount', True)]
        for location, field, value in cases:
            inventory, receipts = fixture(self.module)
            target = receipts['entry-dispatch'][location]
            if location == 'entries': target = target['pure']
            target[field] = value
            with self.subTest(location=location, field=field), self.assertRaisesRegex(ValueError, 'entry-dispatch'):
                self.module.join_scopes(inventory, receipts)

    def test_entry_dispatch_controls_require_real_positive_kernel_rejection(self):
        changes = ({'name': ''}, {'name': None}, {'definitionsCompiled': False},
            {'certificateRejected': False}, {'kernelExitCode': 0}, {'kernelExitCode': -15},
            {'kernelExitCode': True}, {'timedOut': True}, {'timeout': True},
            {'definitionLanguage':'C#'}, {'kernelCounterexampleChecked':False})
        for change in changes:
            inventory, receipts = fixture(self.module)
            receipts['entry-dispatch']['semanticControls'][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.module.join_scopes(inventory, receipts)
        inventory, receipts = fixture(self.module)
        receipts['entry-dispatch']['semanticControls'] *= 2
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.module.join_scopes(inventory, receipts)

    def test_entry_dispatch_cannot_omit_any_required_control_or_add_an_unreviewed_one(self):
        for name in self.module.ENTRY_DISPATCH_CONTROLS:
            inventory, receipts = fixture(self.module)
            controls = receipts['entry-dispatch']['semanticControls']
            receipts['entry-dispatch']['semanticControls'] = [row for row in controls if row['name'] != name]
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'incomplete/extra'):
                self.module.join_scopes(inventory, receipts)
        inventory, receipts = fixture(self.module)
        controls = receipts['entry-dispatch']['semanticControls']
        controls.append(dict(controls[0], name='unreviewed-control'))
        with self.assertRaisesRegex(ValueError, 'incomplete/extra'):
            self.module.join_scopes(inventory, receipts)

    def test_entry_dispatch_domain_cannot_be_weakened_with_nonempty_lists(self):
        for field, expected in self.module.ENTRY_DISPATCH_DOMAIN.items():
            for index in range(len(expected)):
                inventory, receipts = fixture(self.module)
                receipts['entry-dispatch'][field].pop(index)
                with self.subTest(field=field, index=index), self.assertRaisesRegex(ValueError, 'omitted/changed'):
                    self.module.join_scopes(inventory, receipts)

    def test_entry_dispatch_controls_cannot_omit_source_or_proof_identity(self):
        for field in ('sourceMutationSha256','projectionSha256','definitionsSha256',
                      'counterexampleSha256','rejectionLogSha256'):
            inventory, receipts = fixture(self.module)
            receipts['entry-dispatch']['semanticControls'][0].pop(field)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'control identities'):
                self.module.join_scopes(inventory, receipts)

    def test_entry_dispatch_requires_both_core_and_vm_source_pins(self):
        for repository in ('neo', 'neo-vm'):
            inventory, receipts = fixture(self.module)
            del receipts['entry-dispatch']['pinnedSource'][repository]
            with self.subTest(repository=repository), self.assertRaisesRegex(ValueError, 'pinned'):
                self.module.join_scopes(inventory, receipts)

    def test_entry_dispatch_projection_and_declarations_bind_exact_generated_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            certificate = b'Theorem actual_initializer_lookup : True. Proof. exact I. Qed.\n'
            projection = json.dumps(dict(self.module.ENTRY_DISPATCH_DOMAIN,
                entryBoundary='CallContract-after-interop-admission-and-argument-conversion')).encode()
            (root/'EntryDispatchArtifact.v').write_bytes(certificate)
            (root/'source-projection.json').write_bytes(projection)
            report = {'certificateSha256': self.module.sha(certificate),
                      'sourceProjectionSha256': self.module.sha(projection),
                      'kernelDeclarations': ['actual_initializer_lookup']}
            report.update(dispatch_control_artifacts(root, self.module))
            self.module.validate_provenance('entry-dispatch', report, {}, root)
            for field, value in [('sourceProjectionSha256', '0'*64),
                                 ('kernelDeclarations', []), ('kernelDeclarations', ['other'])]:
                forged = dict(report, **{field: value})
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    self.module.validate_provenance('entry-dispatch', forged, {}, root)
            weaker = json.loads(projection)
            weaker['preconditions'].pop()
            weaker_raw = json.dumps(weaker).encode()
            (root/'source-projection.json').write_bytes(weaker_raw)
            with self.assertRaisesRegex(ValueError, 'changed domain'):
                self.module.validate_provenance('entry-dispatch',
                    dict(report, sourceProjectionSha256=self.module.sha(weaker_raw)), {}, root)
            (root/'source-projection.json').write_bytes(projection)
            renamed = certificate.replace(b'actual_initializer_lookup', b'other')
            (root/'EntryDispatchArtifact.v').write_bytes(renamed)
            with self.assertRaisesRegex(ValueError, 'actual initializer lookup'):
                self.module.validate_provenance('entry-dispatch', dict(report,
                    certificateSha256=self.module.sha(renamed), kernelDeclarations=['other']), {}, root)
            (root/'EntryDispatchArtifact.v').write_bytes(certificate.replace(b'True', b'False'))
            with self.assertRaisesRegex(ValueError, 'certificate'):
                self.module.validate_provenance('entry-dispatch', report, {}, root)

    def test_entry_dispatch_control_files_and_row_hashes_cannot_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = dispatch_control_artifacts(root, self.module)
            self.module.validate_entry_dispatch_control_files(report, root)
            name = self.module.ENTRY_DISPATCH_CONTROLS[0]
            for change in ('missing', 'extra', 'row', 'proof', 'log', 'missing-log'):
                candidate = copy.deepcopy(report)
                if change == 'missing': candidate['controlProofSha256'].pop(name+'/Definitions.v')
                elif change == 'extra': candidate['controlProofSha256']['other.v'] = '0'*64
                elif change == 'row': candidate['semanticControls'][0]['definitionsSha256'] = '0'*64
                elif change == 'missing-log': candidate['controlLogSha256'].pop(name+'/counterexample-coqchk.log')
                else:
                    path = root/name/('Definitions.v' if change == 'proof' else 'rejection.log')
                    previous = path.read_bytes();path.write_bytes(b'changed')
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'entry-dispatch'):
                    self.module.validate_entry_dispatch_control_files(candidate, root)
                if change in ('proof','log'): path.write_bytes(previous)

    def test_syscall_dispatch_pins_the_admission_record_not_just_a_scope_name(self):
        result = self.module.join_scopes(*fixture(self.module))
        claim = result['scopedClaims']['syscall-dispatch']
        self.assertEqual(claim['scope'], 'system-contract-call-and-callt-admission-bridge')
        self.assertEqual(claim['entryBoundary'], 'CallContractInternal-parameter-tuple')
        self.assertEqual(claim['projectedProgram'], self.module.SYSCALL_DISPATCH_PROGRAM)
        self.assertEqual(claim['semanticControlCount'], len(self.module.SYSCALL_DISPATCH_CONTROLS))
        self.assertFalse(claim['applicationEngineVerified'])
        self.assertFalse(claim['sourceFrontendVerified'])
        self.assertFalse(claim['vmCorrespondenceProven'])
        self.assertEqual(claim['unproved'], self.module.SYSCALL_DISPATCH_DOMAIN['unproved'])
        self.assertEqual(result['verifiedEntrypoints'], [])
        self.assertEqual(result['fullUnprovedCount'], 4)

    def test_syscall_dispatch_cannot_be_omitted_or_overclaim_execution(self):
        inventory, receipts = fixture(self.module)
        del receipts['syscall-dispatch']
        with self.assertRaisesRegex(ValueError, 'missing/extra'):
            self.module.join_scopes(inventory, receipts)
        for field in ('sourceFrontendVerified', 'applicationEngineVerified',
                      'vmCorrespondenceProven', 'implementationVerified', 'fullImplementationVerified'):
            for forged in (True, None):
                inventory, receipts = fixture(self.module)
                receipts['syscall-dispatch'][field] = forged
                with self.subTest(field=field, forged=forged), self.assertRaisesRegex(ValueError, 'syscall-dispatch'):
                    self.module.join_scopes(inventory, receipts)

    def test_syscall_dispatch_program_fields_cannot_drift_one_at_a_time(self):
        for field, value in (('interop_flag_gate', False), ('interop_required_flags', 1),
                             ('interop_pop_count', 3), ('interop_flag_slot', 1),
                             ('interop_pushes_result', False), ('interop_handler_void', False),
                             ('interop_result', 1), ('call_rejects_underscore', False),
                             ('call_flag_range_gate', False), ('call_all_flags', 5),
                             ('call_derives_return', False), ('call_marks_dynamic', False),
                             ('token_flag_gate', False), ('token_required_flags', 1),
                             ('token_pops', False), ('token_marks_dynamic', True)):
            inventory, receipts = fixture(self.module)
            receipts['syscall-dispatch']['program'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'syscall-dispatch'):
                self.module.join_scopes(inventory, receipts)
        # `1 == True` in Python, so a same-value integer in a boolean slot has to
        # be rejected by type, not by value.
        for field in ('interop_flag_gate', 'token_marks_dynamic'):
            inventory, receipts = fixture(self.module)
            receipts['syscall-dispatch']['program'][field] = 1
            with self.subTest(field=field, forged=1), self.assertRaisesRegex(
                    ValueError, 'syscall-dispatch'):
                self.module.join_scopes(inventory, receipts)

    def test_syscall_dispatch_cannot_drop_reorder_or_weaken_its_controls_and_domain(self):
        self.assertEqual(len(self.module.SYSCALL_DISPATCH_CONTROLS), 13)
        for change in ('drop', 'reorder', 'duplicate'):
            inventory, receipts = fixture(self.module)
            rows = receipts['syscall-dispatch']['semanticControls']
            if change == 'drop': rows.pop()
            elif change == 'reorder': rows.reverse()
            else: rows[-1] = copy.deepcopy(rows[0])
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'syscall-dispatch'):
                self.module.join_scopes(inventory, receipts)
        for field in ('preconditions', 'unproved', 'tcb'):
            for change in ('drop', 'empty', 'text'):
                inventory, receipts = fixture(self.module)
                values = receipts['syscall-dispatch'][field]
                if change == 'drop': receipts['syscall-dispatch'].pop(field)
                elif change == 'empty': receipts['syscall-dispatch'][field] = []
                else: receipts['syscall-dispatch'][field] = values[:-1] + ['weakened']
                with self.subTest(field=field, change=change), self.assertRaisesRegex(ValueError, 'syscall-dispatch'):
                    self.module.join_scopes(inventory, receipts)

    def test_syscall_dispatch_requires_both_source_pins_and_exact_identities(self):
        for change in ('one-repository', 'unpinned-url', 'bad-hash', 'relative-path',
                       'projection', 'certificate', 'tokens', 'parameters', 'boundary'):
            inventory, receipts = fixture(self.module)
            row = receipts['syscall-dispatch']
            if change == 'one-repository':
                row['pinnedSource'].pop('neo-vm')
            elif change == 'unpinned-url':
                next(iter(row['pinnedSource'].values()))['url'] = 'https://example.invalid/source.cs'
            elif change == 'bad-hash':
                next(iter(row['pinnedSource'].values()))['sha256'] = 'not-a-hash'
            elif change == 'relative-path':
                next(iter(row['pinnedSource'].values()))['path'] = 'source.cs'
            elif change == 'projection': row['sourceProjectionSha256'] = 'bad'
            elif change == 'certificate': row['certificateSha256'] = 'bad'
            elif change == 'tokens': row['tokenFields'] = row['tokenFields'][:-1]
            elif change == 'parameters': row['handlerParameters'] = row['handlerParameters'][:-1]
            else: row['entryBoundary'] = 'CallContract-after-interop-admission-and-argument-conversion'
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'syscall-dispatch'):
                self.module.join_scopes(inventory, receipts)

    def test_syscall_dispatch_control_files_and_closure_logs_cannot_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = copy.deepcopy(fixture(self.module)[1]['syscall-dispatch'])
            name = self.module.SYSCALL_DISPATCH_CONTROLS[0]
            for control in self.module.SYSCALL_DISPATCH_CONTROLS:
                case = root/control; case.mkdir()
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v'):
                    raw = (control + '/' + filename + '\n').encode()
                    (case/filename).write_bytes(raw)
                    report['controlProofSha256'][control+'/'+filename] = self.module.sha(raw)
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log'):
                    (case/filename).write_bytes(('fixture ' + filename + '\n').encode())
                    report['controlLogSha256'][control+'/'+filename] = self.module.sha((case/filename).read_bytes())
                row = report['semanticControls'][self.module.SYSCALL_DISPATCH_CONTROLS.index(control)]
                row.update(definitionsSha256=report['controlProofSha256'][control+'/Definitions.v'],
                           counterexampleSha256=report['controlProofSha256'][control+'/Counterexample.v'],
                           rejectionLogSha256=report['controlLogSha256'][control+'/rejection.log'])
            for module, count in (('SyscallDispatch', 2), ('SyscallDispatchArtifact', 1)):
                (root/(('model' if module == 'SyscallDispatch' else 'certificate') + '.log')).write_text(
                    'Closed under the global context\n'*count)
            self.module.validate_syscall_dispatch_control_files(report, root)
            for change in ('missing', 'extra', 'row', 'proof', 'log', 'open-model', 'axiom'):
                candidate = copy.deepcopy(report)
                if change == 'missing': candidate['controlProofSha256'].pop(name+'/Definitions.v')
                elif change == 'extra': candidate['controlLogSha256']['other.log'] = '0'*64
                elif change == 'row': candidate['semanticControls'][0]['rejectionLogSha256'] = '0'*64
                elif change == 'open-model': (root/'model.log').write_text('Closed under the global context\n')
                elif change == 'axiom': (root/'certificate.log').write_text(
                    'Closed under the global context\nAxioms:\nfoo : True\n')
                else:
                    path = root/name/('Definitions.v' if change == 'proof' else 'rejection.log')
                    previous = path.read_bytes(); path.write_bytes(b'changed')
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'syscall-dispatch'):
                    self.module.validate_syscall_dispatch_control_files(candidate, root)
                if change in ('proof', 'log'): path.write_bytes(previous)
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n'*2)
                elif change == 'axiom':
                    (root/'certificate.log').write_text('Closed under the global context\n')

    def test_contract_handoff_pins_the_handoff_record_not_just_a_scope_name(self):
        result = self.module.join_scopes(*fixture(self.module))
        claim = result['scopedClaims']['contract-handoff']
        self.assertEqual(claim['scope'], 'contract-internal-handoff-and-frame-construction')
        self.assertEqual(claim['entryBoundary'],
                         'LoadContract-returned-context-before-callee-execution')
        self.assertEqual(claim['projectedProgram'], self.module.CONTRACT_HANDOFF_PROGRAM)
        self.assertEqual(claim['semanticControlCount'], len(self.module.CONTRACT_HANDOFF_CONTROLS))
        self.assertFalse(claim['applicationEngineVerified'])
        self.assertFalse(claim['sourceFrontendVerified'])
        self.assertFalse(claim['vmCorrespondenceProven'])
        self.assertEqual(claim['unproved'], self.module.CONTRACT_HANDOFF_DOMAIN['unproved'])
        self.assertEqual(result['verifiedEntrypoints'], [])
        self.assertEqual(result['fullUnprovedCount'], 4)

    def test_contract_handoff_cannot_be_omitted_or_overclaim_execution(self):
        inventory, receipts = fixture(self.module)
        del receipts['contract-handoff']
        with self.assertRaisesRegex(ValueError, 'missing/extra'):
            self.module.join_scopes(inventory, receipts)
        for field in ('sourceFrontendVerified', 'applicationEngineVerified',
                      'vmCorrespondenceProven', 'implementationVerified', 'fullImplementationVerified'):
            for forged in (True, None):
                inventory, receipts = fixture(self.module)
                receipts['contract-handoff'][field] = forged
                with self.subTest(field=field, forged=forged), self.assertRaisesRegex(
                        ValueError, 'contract-handoff'):
                    self.module.join_scopes(inventory, receipts)

    def test_contract_handoff_program_fields_cannot_drift_one_at_a_time(self):
        fields = (('blocked_gate', False), ('safe_mask_drops', 5), ('authorization_gate', False),
                  ('authorization_subject_is_caller', False), ('increment_step', 2),
                  ('caller_flag_intersection', False), ('calling_context_set', False),
                  ('fee_from_whitelist', False), ('whitelist_sets_flag', False),
                  ('push_reversed', False), ('rvcount_from_return', False),
                  ('ip_from_method_offset', False), ('contract_copied', False),
                  ('snapshot_cloned', False), ('initializer_frame', False),
                  ('initializer_name_is_canonical', False), ('initializer_pcount', 1),
                  ('lookup_is_arity_keyed', False))
        self.assertEqual({name for name, _ in fields}, set(self.module.CONTRACT_HANDOFF_PROGRAM))
        for field, value in fields:
            inventory, receipts = fixture(self.module)
            receipts['contract-handoff']['program'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'contract-handoff'):
                self.module.join_scopes(inventory, receipts)
        for field, value in (('safe_mask_drops', True), ('increment_step', False),
                             ('push_reversed', 1)):
            inventory, receipts = fixture(self.module)
            receipts['contract-handoff']['program'][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(
                    ValueError, 'contract-handoff'):
                self.module.join_scopes(inventory, receipts)

    def test_contract_handoff_cannot_drop_reorder_or_weaken_its_controls_and_domain(self):
        self.assertEqual(len(self.module.CONTRACT_HANDOFF_CONTROLS), 21)
        for change in ('drop', 'reorder', 'duplicate'):
            inventory, receipts = fixture(self.module)
            rows = receipts['contract-handoff']['semanticControls']
            if change == 'drop': rows.pop()
            elif change == 'reorder': rows.reverse()
            else: rows[-1] = copy.deepcopy(rows[0])
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'contract-handoff'):
                self.module.join_scopes(inventory, receipts)
        for field in ('preconditions', 'unproved', 'tcb'):
            for change in ('drop', 'empty', 'text'):
                inventory, receipts = fixture(self.module)
                values = receipts['contract-handoff'][field]
                if change == 'drop': receipts['contract-handoff'].pop(field)
                elif change == 'empty': receipts['contract-handoff'][field] = []
                else: receipts['contract-handoff'][field] = values[:-1] + ['weakened']
                with self.subTest(field=field, change=change), self.assertRaisesRegex(
                        ValueError, 'contract-handoff'):
                    self.module.join_scopes(inventory, receipts)
        for change in ('drop', 'text'):
            inventory, receipts = fixture(self.module)
            guards = receipts['contract-handoff']['reasonOnlyGuards']
            receipts['contract-handoff']['reasonOnlyGuards'] = (
                guards[:-1] if change == 'drop' else guards[:-1] + ['weakened'])
            with self.subTest(guards=change), self.assertRaisesRegex(ValueError, 'contract-handoff'):
                self.module.join_scopes(inventory, receipts)

    def test_contract_handoff_requires_both_source_pins_and_exact_identities(self):
        for change in ('one-repository', 'drop-one-source', 'unpinned-url', 'bad-hash',
                       'relative-path', 'projection', 'certificate', 'boundary', 'declarations'):
            inventory, receipts = fixture(self.module)
            row = receipts['contract-handoff']
            if change == 'one-repository':
                for value in row['pinnedSource'].values():
                    value['url'] = value['url'].replace('/neo-vm/', '/neo/')
            elif change == 'drop-one-source':
                row['pinnedSource'].pop(next(iter(row['pinnedSource'])))
            elif change == 'unpinned-url':
                next(iter(row['pinnedSource'].values()))['url'] = 'https://example.invalid/source.cs'
            elif change == 'bad-hash':
                next(iter(row['pinnedSource'].values()))['sha256'] = 'not-a-hash'
            elif change == 'relative-path':
                next(iter(row['pinnedSource'].values()))['path'] = 'source.cs'
            elif change == 'projection': row['sourceProjectionSha256'] = 'bad'
            elif change == 'certificate': row['certificateSha256'] = 'bad'
            else:
                row['entryBoundary'] = 'CallContract-internal-return-value'
                if change == 'declarations':
                    row['closedAssumptionCount'] = 4
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'contract-handoff'):
                self.module.join_scopes(inventory, receipts)

    def test_contract_handoff_control_files_and_closure_logs_cannot_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = copy.deepcopy(fixture(self.module)[1]['contract-handoff'])
            name = self.module.CONTRACT_HANDOFF_CONTROLS[0]
            for control in self.module.CONTRACT_HANDOFF_CONTROLS:
                case = root/control; case.mkdir()
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v'):
                    raw = (control + '/' + filename + '\n').encode()
                    (case/filename).write_bytes(raw)
                    report['controlProofSha256'][control+'/'+filename] = self.module.sha(raw)
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log'):
                    (case/filename).write_bytes(('fixture ' + filename + '\n').encode())
                    report['controlLogSha256'][control+'/'+filename] = self.module.sha(
                        (case/filename).read_bytes())
                row = report['semanticControls'][self.module.CONTRACT_HANDOFF_CONTROLS.index(control)]
                row.update(definitionsSha256=report['controlProofSha256'][control+'/Definitions.v'],
                           counterexampleSha256=report['controlProofSha256'][control+'/Counterexample.v'],
                           rejectionLogSha256=report['controlLogSha256'][control+'/rejection.log'])
            for module, count in (('ContractHandoff', 2), ('ContractHandoffArtifact', 1)):
                (root/(('model' if module == 'ContractHandoff' else 'certificate') + '.log')).write_text(
                    'Closed under the global context\n'*count)
            self.module.validate_contract_handoff_control_files(report, root)
            for change in ('missing', 'extra', 'row', 'proof', 'log', 'open-model', 'axiom'):
                candidate = copy.deepcopy(report)
                if change == 'missing': candidate['controlProofSha256'].pop(name+'/Definitions.v')
                elif change == 'extra': candidate['controlLogSha256']['other.log'] = '0'*64
                elif change == 'row': candidate['semanticControls'][0]['rejectionLogSha256'] = '0'*64
                elif change == 'open-model': (root/'model.log').write_text('Closed under the global context\n')
                elif change == 'axiom': (root/'certificate.log').write_text(
                    'Closed under the global context\nAxioms:\nfoo : True\n')
                else:
                    path = root/name/('Definitions.v' if change == 'proof' else 'rejection.log')
                    previous = path.read_bytes(); path.write_bytes(b'changed')
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'contract-handoff'):
                    self.module.validate_contract_handoff_control_files(candidate, root)
                if change in ('proof', 'log'): path.write_bytes(previous)
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n'*2)
                elif change == 'axiom':
                    (root/'certificate.log').write_text('Closed under the global context\n')

    def test_interop_conversion_pins_the_argument_vector_not_just_a_scope_name(self):
        result = self.module.join_scopes(*fixture(self.module))
        claim = result['scopedClaims']['interop-conversion']
        self.assertEqual(claim['scope'], 'interop-argument-conversion')
        self.assertEqual(claim['entryBoundary'],
                         'OnSysCall-argument-window-to-invoked-handler-parameters')
        self.assertEqual(claim['projectedProgram'], self.module.INTEROP_CONVERSION_PROGRAM)
        self.assertEqual(claim['declaredArguments'],
                         [list(row) for row in self.module.INTEROP_CONVERSION_ARGUMENTS])
        self.assertEqual(claim['semanticControlCount'],
                         len(self.module.INTEROP_CONVERSION_CONTROLS))
        self.assertFalse(claim['applicationEngineVerified'])
        self.assertFalse(claim['sourceFrontendVerified'])
        self.assertFalse(claim['vmCorrespondenceProven'])
        self.assertEqual(claim['unproved'], self.module.INTEROP_CONVERSION_DOMAIN['unproved'])
        self.assertEqual(result['verifiedEntrypoints'], [])
        self.assertEqual(result['fullUnprovedCount'], 4)

    def test_interop_conversion_cannot_be_omitted_or_overclaim_execution(self):
        inventory, receipts = fixture(self.module)
        del receipts['interop-conversion']
        with self.assertRaisesRegex(ValueError, 'missing/extra'):
            self.module.join_scopes(inventory, receipts)
        for field in ('sourceFrontendVerified', 'applicationEngineVerified',
                      'vmCorrespondenceProven', 'implementationVerified',
                      'fullImplementationVerified'):
            for forged in (True, None):
                inventory, receipts = fixture(self.module)
                receipts['interop-conversion'][field] = forged
                with self.subTest(field=field, forged=forged), self.assertRaisesRegex(
                        ValueError, 'interop-conversion'):
                    self.module.join_scopes(inventory, receipts)

    def test_interop_conversion_program_fields_cannot_drift_one_at_a_time(self):
        fields = [('argument_count', 3)]
        for name in self.module.INTEROP_CONVERSION_PROGRAM:
            if name == 'argument_count':
                continue
            fields.append((name, 4096 if name == 'counted_branch_max_length' else False))
        self.assertEqual({name for name, _ in fields},
                         set(self.module.INTEROP_CONVERSION_PROGRAM))
        self.assertEqual(19, len(fields))
        for field, value in fields:
            inventory, receipts = fixture(self.module)
            receipts['interop-conversion']['program'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError,
                                                                   'interop-conversion'):
                self.module.join_scopes(inventory, receipts)
        # `1 == True` and `4 == 4.0` in Python: a same-value literal of the wrong
        # type must not slip past the record comparison.
        for field, value in (('pop_order_is_reversed', 1),
                             ('counted_branch_max_length', True),
                             ('argument_count', 4.0)):
            inventory, receipts = fixture(self.module)
            receipts['interop-conversion']['program'][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(
                    ValueError, 'interop-conversion'):
                self.module.join_scopes(inventory, receipts)

    def test_interop_conversion_cannot_drop_reorder_or_weaken_controls_and_arguments(self):
        self.assertEqual(len(self.module.INTEROP_CONVERSION_CONTROLS), 18)
        for change in ('drop', 'reorder', 'duplicate'):
            inventory, receipts = fixture(self.module)
            rows = receipts['interop-conversion']['semanticControls']
            if change == 'drop': rows.pop()
            elif change == 'reorder': rows.reverse()
            else: rows[-1] = copy.deepcopy(rows[0])
            with self.subTest(change=change), self.assertRaisesRegex(ValueError,
                                                                     'interop-conversion'):
                self.module.join_scopes(inventory, receipts)
        for field in ('preconditions', 'unproved', 'tcb'):
            for change in ('drop', 'empty', 'text'):
                inventory, receipts = fixture(self.module)
                values = receipts['interop-conversion'][field]
                if change == 'drop': receipts['interop-conversion'].pop(field)
                elif change == 'empty': receipts['interop-conversion'][field] = []
                else: receipts['interop-conversion'][field] = values[:-1] + ['weakened']
                with self.subTest(field=field, change=change), self.assertRaisesRegex(
                        ValueError, 'interop-conversion'):
                    self.module.join_scopes(inventory, receipts)
        for change in ('drop', 'text'):
            inventory, receipts = fixture(self.module)
            guards = receipts['interop-conversion']['reasonOnlyGuards']
            receipts['interop-conversion']['reasonOnlyGuards'] = (
                guards[:-1] if change == 'drop' else guards[:-1] + ['weakened'])
            with self.subTest(guards=change), self.assertRaisesRegex(ValueError,
                                                                     'interop-conversion'):
                self.module.join_scopes(inventory, receipts)
        # The declared argument list is part of the record the lane projects.
        for change in ('drop', 'rename', 'append'):
            inventory, receipts = fixture(self.module)
            row = receipts['interop-conversion']
            if change == 'drop': row.pop('parameters')
            elif change == 'rename': row['parameters'][2][0] = 'byte'
            else: row['parameters'].append(['int', 'extra'])
            with self.subTest(arguments=change), self.assertRaisesRegex(ValueError,
                                                                        'interop-conversion'):
                self.module.join_scopes(inventory, receipts)

    def test_interop_conversion_requires_both_source_pins_and_exact_identities(self):
        for change in ('one-repository', 'drop-one-source', 'unpinned-url', 'bad-hash',
                       'relative-path', 'projection', 'certificate', 'boundary', 'declarations'):
            inventory, receipts = fixture(self.module)
            row = receipts['interop-conversion']
            if change == 'one-repository':
                for value in row['pinnedSource'].values():
                    value['url'] = value['url'].replace('/neo-vm/', '/neo/')
            elif change == 'drop-one-source':
                row['pinnedSource'].pop(next(iter(row['pinnedSource'])))
            elif change == 'unpinned-url':
                next(iter(row['pinnedSource'].values()))['url'] = 'https://example.invalid/source.cs'
            elif change == 'bad-hash':
                next(iter(row['pinnedSource'].values()))['sha256'] = 'not-a-hash'
            elif change == 'relative-path':
                next(iter(row['pinnedSource'].values()))['path'] = 'source.cs'
            elif change == 'projection': row['sourceProjectionSha256'] = 'bad'
            elif change == 'certificate': row['certificateSha256'] = 'bad'
            elif change == 'boundary':
                row['entryBoundary'] = 'OnSysCall-return-value-to-handler-return'
            else: row['closedAssumptionCount'] = 4
            with self.subTest(change=change), self.assertRaisesRegex(ValueError,
                                                                     'interop-conversion'):
                self.module.join_scopes(inventory, receipts)

    def test_interop_conversion_control_files_and_closure_logs_cannot_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = copy.deepcopy(fixture(self.module)[1]['interop-conversion'])
            name = self.module.INTEROP_CONVERSION_CONTROLS[0]
            for control in self.module.INTEROP_CONVERSION_CONTROLS:
                case = root/control; case.mkdir()
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v'):
                    raw = (control + '/' + filename + '\n').encode()
                    (case/filename).write_bytes(raw)
                    report['controlProofSha256'][control+'/'+filename] = self.module.sha(raw)
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log'):
                    (case/filename).write_bytes(('fixture ' + filename + '\n').encode())
                    report['controlLogSha256'][control+'/'+filename] = self.module.sha(
                        (case/filename).read_bytes())
                row = report['semanticControls'][
                    self.module.INTEROP_CONVERSION_CONTROLS.index(control)]
                row.update(definitionsSha256=report['controlProofSha256'][control+'/Definitions.v'],
                           counterexampleSha256=report['controlProofSha256'][control+'/Counterexample.v'],
                           rejectionLogSha256=report['controlLogSha256'][control+'/rejection.log'])
            for module, count in (('InteropConvert', 2), ('InteropConvertArtifact', 1)):
                (root/(('model' if module == 'InteropConvert' else 'certificate')
                      + '.log')).write_text('Closed under the global context\n'*count)
            self.module.validate_interop_conversion_control_files(report, root)
            for change in ('missing', 'extra', 'row', 'proof', 'log', 'open-model', 'axiom'):
                candidate = copy.deepcopy(report)
                if change == 'missing': candidate['controlProofSha256'].pop(name+'/Definitions.v')
                elif change == 'extra': candidate['controlLogSha256']['other.log'] = '0'*64
                elif change == 'row': candidate['semanticControls'][0]['rejectionLogSha256'] = '0'*64
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n')
                elif change == 'axiom':
                    (root/'certificate.log').write_text(
                        'Closed under the global context\nAxioms:\nfoo : True\n')
                else:
                    path = root/name/('Definitions.v' if change == 'proof' else 'rejection.log')
                    previous = path.read_bytes(); path.write_bytes(b'changed')
                with self.subTest(change=change), self.assertRaisesRegex(
                        ValueError, 'interop-conversion'):
                    self.module.validate_interop_conversion_control_files(candidate, root)
                if change in ('proof', 'log'): path.write_bytes(previous)
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n'*2)
                elif change == 'axiom':
                    (root/'certificate.log').write_text('Closed under the global context\n')

    def test_interop_fee_pins_the_charge_record_not_just_a_scope_name(self):
        result = self.module.join_scopes(*fixture(self.module))
        claim = result['scopedClaims']['interop-fee-order']
        self.assertEqual(claim['scope'], 'interop-descriptor-charge-order')
        self.assertEqual(claim['entryBoundary'],
                         'OnSysCall-descriptor-charge-to-argument-window-effect')
        self.assertEqual(claim['projectedProgram'], self.module.INTEROP_FEE_PROGRAM)
        self.assertEqual(claim['semanticControlCount'], len(self.module.INTEROP_FEE_CONTROLS))
        self.assertFalse(claim['applicationEngineVerified'])
        self.assertFalse(claim['sourceFrontendVerified'])
        self.assertFalse(claim['vmCorrespondenceProven'])
        self.assertEqual(claim['unproved'], self.module.INTEROP_FEE_DOMAIN['unproved'])
        self.assertEqual(result['verifiedEntrypoints'], [])
        self.assertEqual(result['fullUnprovedCount'], 4)

    def test_interop_fee_cannot_be_omitted_or_overclaim_execution(self):
        inventory, receipts = fixture(self.module)
        del receipts['interop-fee-order']
        with self.assertRaisesRegex(ValueError, 'missing/extra'):
            self.module.join_scopes(inventory, receipts)
        for field in ('sourceFrontendVerified', 'applicationEngineVerified',
                      'vmCorrespondenceProven', 'implementationVerified',
                      'fullImplementationVerified'):
            for forged in (True, None):
                inventory, receipts = fixture(self.module)
                receipts['interop-fee-order'][field] = forged
                with self.subTest(field=field, forged=forged), self.assertRaisesRegex(
                        ValueError, 'interop-fee-order'):
                    self.module.join_scopes(inventory, receipts)

    def test_interop_fee_program_fields_cannot_drift_one_at_a_time(self):
        fields = []
        for name in self.module.INTEROP_FEE_PROGRAM:
            if name == 'step_order':
                fields.append((name, list(reversed(self.module.INTEROP_FEE_PROGRAM[name]))))
            else:
                fields.append((name, False))
        self.assertEqual({name for name, _ in fields}, set(self.module.INTEROP_FEE_PROGRAM))
        self.assertEqual(15, len(fields))
        for field, value in fields:
            inventory, receipts = fixture(self.module)
            receipts['interop-fee-order']['program'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError,
                                                                  'interop-fee-order'):
                self.module.join_scopes(inventory, receipts)
        # `1 == True` in Python, and a same-value literal of the wrong type must
        # not slip past the record comparison.
        for field, value in (('limit_check_is_strict', 1),
                             ('step_order', 'validate-call-flags'),
                             ('charge_skips_the_inner_factor', 'true')):
            inventory, receipts = fixture(self.module)
            receipts['interop-fee-order']['program'][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(
                    ValueError, 'interop-fee-order'):
                self.module.join_scopes(inventory, receipts)

    def test_interop_fee_cannot_drop_reorder_or_weaken_controls(self):
        self.assertEqual(len(self.module.INTEROP_FEE_CONTROLS), 16)
        for change in ('drop', 'reorder', 'duplicate', 'rename'):
            inventory, receipts = fixture(self.module)
            rows = receipts['interop-fee-order']['semanticControls']
            if change == 'drop': rows.pop()
            elif change == 'reorder': rows.reverse()
            elif change == 'duplicate': rows[-1] = copy.deepcopy(rows[0])
            else: rows[0]['name'] = 'charge-at-the-end'
            with self.subTest(change=change), self.assertRaisesRegex(ValueError,
                                                                    'interop-fee-order'):
                self.module.join_scopes(inventory, receipts)
        for row_field, forged in (('certificateRejected', False), ('kernelExitCode', 0),
                                  ('kernelCounterexampleChecked', False), ('timedOut', True),
                                  ('definitionsCompiled', False)):
            inventory, receipts = fixture(self.module)
            receipts['interop-fee-order']['semanticControls'][0][row_field] = forged
            with self.subTest(row_field=row_field), self.assertRaisesRegex(
                    ValueError, 'interop-fee-order'):
                self.module.join_scopes(inventory, receipts)
        for field in ('preconditions', 'unproved', 'tcb'):
            for change in ('drop', 'empty', 'text'):
                inventory, receipts = fixture(self.module)
                values = receipts['interop-fee-order'][field]
                if change == 'drop': receipts['interop-fee-order'].pop(field)
                elif change == 'empty': receipts['interop-fee-order'][field] = []
                else: receipts['interop-fee-order'][field] = values[:-1] + ['weakened']
                with self.subTest(field=field, change=change), self.assertRaisesRegex(
                        ValueError, 'interop-fee-order'):
                    self.module.join_scopes(inventory, receipts)
        for change in ('drop', 'text'):
            inventory, receipts = fixture(self.module)
            row = receipts['interop-fee-order']
            if change == 'drop': row.pop('reasonOnlyGuards')
            else: row['reasonOnlyGuards'] = ['descriptor-price-identity']
            with self.subTest(guards=change), self.assertRaisesRegex(ValueError,
                                                                     'interop-fee-order'):
                self.module.join_scopes(inventory, receipts)

    def test_interop_fee_requires_both_pins_and_exact_identities(self):
        for change in ('drop-one-source', 'extra-source', 'other-commit', 'unpinned-url',
                       'bad-hash', 'relative-path', 'projection', 'certificate',
                       'boundary', 'declarations', 'certificate-declarations'):
            inventory, receipts = fixture(self.module)
            row = receipts['interop-fee-order']
            if change == 'drop-one-source':
                row['pinnedSource'].pop(next(iter(row['pinnedSource'])))
            elif change == 'extra-source':
                row['pinnedSource']['core/extra'] = dict(
                    path=FIXTURE_ROOT + '/core-extra.cs', sha256='4'*64,
                    url='https://raw.githubusercontent.com/neo-project/neo/' + self.module.CORE_COMMIT
                        + '/src/Neo/SmartContract/InteropParameterDescriptor.cs')
            elif change == 'other-commit':
                for value in row['pinnedSource'].values():
                    value['url'] = value['url'].replace(self.module.CORE_COMMIT, 'f'*40)
            elif change == 'unpinned-url':
                next(iter(row['pinnedSource'].values()))['url'] = 'https://example.invalid/source.cs'
            elif change == 'bad-hash':
                next(iter(row['pinnedSource'].values()))['sha256'] = 'not-a-hash'
            elif change == 'relative-path':
                next(iter(row['pinnedSource'].values()))['path'] = 'source.cs'
            elif change == 'projection': row['sourceProjectionSha256'] = 'bad'
            elif change == 'certificate': row['certificateSha256'] = 'bad'
            elif change == 'boundary':
                row['entryBoundary'] = 'OnSysCall-descriptor-charge-to-handler-return'
            elif change == 'declarations': row['closedAssumptionCount'] = 4
            else: row['kernelDeclarations'] = ['cert-b']
            with self.subTest(change=change), self.assertRaisesRegex(ValueError,
                                                                     'interop-fee-order'):
                self.module.join_scopes(inventory, receipts)

    def test_interop_fee_control_files_and_closure_logs_cannot_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = copy.deepcopy(fixture(self.module)[1]['interop-fee-order'])
            name = self.module.INTEROP_FEE_CONTROLS[0]
            for control in self.module.INTEROP_FEE_CONTROLS:
                case = root/control; case.mkdir()
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v'):
                    raw = (control + '/' + filename + '\n').encode()
                    (case/filename).write_bytes(raw)
                    report['controlProofSha256'][control+'/'+filename] = self.module.sha(raw)
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log'):
                    (case/filename).write_bytes(('fixture ' + filename + '\n').encode())
                    report['controlLogSha256'][control+'/'+filename] = self.module.sha(
                        (case/filename).read_bytes())
                row = report['semanticControls'][
                    self.module.INTEROP_FEE_CONTROLS.index(control)]
                row.update(definitionsSha256=report['controlProofSha256'][control+'/Definitions.v'],
                           counterexampleSha256=report['controlProofSha256'][control+'/Counterexample.v'],
                           rejectionLogSha256=report['controlLogSha256'][control+'/rejection.log'])
            for module_name, count in (('InteropFee', 2), ('InteropFeeArtifact', 1)):
                (root/(('model' if module_name == 'InteropFee' else 'certificate')
                      + '.log')).write_text('Closed under the global context\n'*count)
            self.module.validate_interop_fee_control_files(report, root)
            for change in ('missing', 'extra', 'row', 'proof', 'log', 'open-model', 'axiom'):
                candidate = copy.deepcopy(report)
                if change == 'missing': candidate['controlProofSha256'].pop(name+'/Definitions.v')
                elif change == 'extra': candidate['controlLogSha256']['other.log'] = '0'*64
                elif change == 'row': candidate['semanticControls'][0]['rejectionLogSha256'] = '0'*64
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n')
                elif change == 'axiom':
                    (root/'certificate.log').write_text(
                        'Closed under the global context\nAxioms:\nfoo : True\n')
                else:
                    path = root/name/('Definitions.v' if change == 'proof' else 'rejection.log')
                    previous = path.read_bytes(); path.write_bytes(b'changed')
                with self.subTest(change=change), self.assertRaisesRegex(
                        ValueError, 'interop-fee-order'):
                    self.module.validate_interop_fee_control_files(candidate, root)
                if change in ('proof', 'log'): path.write_bytes(previous)
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n'*2)
                elif change == 'axiom':
                    (root/'certificate.log').write_text('Closed under the global context\n')

    def test_load_admission_pins_the_declaration_record_not_just_a_scope_name(self):
        result = self.module.join_scopes(*fixture(self.module))
        claim = result['scopedClaims']['load-admission']
        self.assertEqual(claim['scope'], 'load-time-manifest-and-token-admission')
        self.assertEqual(claim['entryBoundary'],
                         'manifest-parse-and-nef-deserialize-admission-to-exact-arity-resolution')
        self.assertEqual(claim['projectedProgram'], self.module.LOAD_ADMISSION_PROGRAM)
        self.assertEqual(claim['semanticControlCount'],
                         len(self.module.LOAD_ADMISSION_CONTROLS))
        self.assertFalse(claim['applicationEngineVerified'])
        self.assertFalse(claim['sourceFrontendVerified'])
        self.assertFalse(claim['vmCorrespondenceProven'])
        self.assertEqual(claim['unproved'], self.module.LOAD_ADMISSION_DOMAIN['unproved'])
        self.assertEqual(result['verifiedEntrypoints'], [])
        self.assertEqual(result['fullUnprovedCount'], 4)

    def test_load_admission_cannot_be_omitted_or_overclaim_execution(self):
        inventory, receipts = fixture(self.module)
        del receipts['load-admission']
        with self.assertRaisesRegex(ValueError, 'missing/extra'):
            self.module.join_scopes(inventory, receipts)
        for field in ('sourceFrontendVerified', 'applicationEngineVerified',
                      'vmCorrespondenceProven', 'deploymentPathVerified',
                      'implementationVerified', 'fullImplementationVerified'):
            for forged in (True, None):
                inventory, receipts = fixture(self.module)
                receipts['load-admission'][field] = forged
                with self.subTest(field=field, forged=forged), self.assertRaisesRegex(
                        ValueError, 'load-admission'):
                    self.module.join_scopes(inventory, receipts)

    def test_load_admission_program_fields_cannot_drift_one_at_a_time(self):
        fields = []
        for name, value in self.module.LOAD_ADMISSION_PROGRAM.items():
            if name == 'step_order':
                fields.append((name, list(reversed(value))))
            elif isinstance(value, int):
                fields.append((name, value + 1))
            else:
                fields.append((name, False))
        self.assertEqual({name for name, _ in fields}, set(self.module.LOAD_ADMISSION_PROGRAM))
        self.assertEqual(24, len(fields))
        for field, value in fields:
            inventory, receipts = fixture(self.module)
            receipts['load-admission']['program'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError,
                                                                  'load-admission'):
                self.module.join_scopes(inventory, receipts)
        # `1 == True` in Python, and a same-value literal of the wrong type must
        # not slip past the record comparison.
        for field, value in (('the_features_field_must_be_empty', 1),
                             ('step_order', 'read-magic'),
                             ('token_array_cap', '128'),
                             ('manifest_length_cap', True)):
            inventory, receipts = fixture(self.module)
            receipts['load-admission']['program'][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(
                    ValueError, 'load-admission'):
                self.module.join_scopes(inventory, receipts)

    def test_load_admission_cannot_drop_reorder_or_weaken_controls(self):
        self.assertEqual(len(self.module.LOAD_ADMISSION_CONTROLS), 27)
        for change in ('drop', 'reorder', 'duplicate', 'rename'):
            inventory, receipts = fixture(self.module)
            rows = receipts['load-admission']['semanticControls']
            if change == 'drop': rows.pop()
            elif change == 'reorder': rows.reverse()
            elif change == 'duplicate': rows[-1] = copy.deepcopy(rows[0])
            else: rows[0]['name'] = 'accept-everything'
            with self.subTest(change=change), self.assertRaisesRegex(ValueError,
                                                                    'load-admission'):
                self.module.join_scopes(inventory, receipts)
        for row_field, forged in (('certificateRejected', False), ('kernelExitCode', 0),
                                  ('kernelCounterexampleChecked', False), ('timedOut', True),
                                  ('definitionsCompiled', False)):
            inventory, receipts = fixture(self.module)
            receipts['load-admission']['semanticControls'][0][row_field] = forged
            with self.subTest(row_field=row_field), self.assertRaisesRegex(
                    ValueError, 'load-admission'):
                self.module.join_scopes(inventory, receipts)
        for field in ('preconditions', 'unproved', 'tcb'):
            for change in ('drop', 'empty', 'weaken'):
                inventory, receipts = fixture(self.module)
                values = receipts['load-admission'][field]
                if change == 'drop': receipts['load-admission'].pop(field)
                elif change == 'empty': receipts['load-admission'][field] = []
                else: receipts['load-admission'][field] = values[:-1] + ['weakened']
                with self.subTest(field=field, change=change), self.assertRaisesRegex(
                        ValueError, 'load-admission'):
                    self.module.join_scopes(inventory, receipts)
        for change in ('drop', 'weaken'):
            inventory, receipts = fixture(self.module)
            row = receipts['load-admission']
            if change == 'drop': row.pop('reasonOnlyGuards')
            else: row['reasonOnlyGuards'] = ['exact-lookup-key-is-(name,arity)']
            with self.subTest(guards=change), self.assertRaisesRegex(ValueError,
                                                                     'load-admission'):
                self.module.join_scopes(inventory, receipts)

    def test_load_admission_requires_every_pin_and_exact_identities(self):
        for change in ('drop-one-source', 'extra-source', 'other-commit', 'unpinned-url',
                       'bad-hash', 'relative-path', 'projection', 'certificate',
                       'boundary', 'declarations', 'certificate-declarations', 'core-commit'):
            inventory, receipts = fixture(self.module)
            row = receipts['load-admission']
            if change == 'drop-one-source':
                row['pinnedSource'].pop(next(iter(row['pinnedSource'])))
            elif change == 'extra-source':
                row['pinnedSource']['core/extra'] = dict(
                    path=FIXTURE_ROOT + '/core-extra.cs', sha256='4'*64,
                    url='https://raw.githubusercontent.com/neo-project/neo/'
                        + self.module.CORE_COMMIT + '/src/Neo/SmartContract/NefFile.cs')
            elif change == 'other-commit':
                for value in row['pinnedSource'].values():
                    value['url'] = value['url'].replace(self.module.CORE_COMMIT, 'f'*40)
            elif change == 'unpinned-url':
                next(iter(row['pinnedSource'].values()))['url'] = 'https://example.invalid/source.cs'
            elif change == 'bad-hash':
                next(iter(row['pinnedSource'].values()))['sha256'] = 'not-a-hash'
            elif change == 'relative-path':
                next(iter(row['pinnedSource'].values()))['path'] = 'source.cs'
            elif change == 'projection': row['sourceProjectionSha256'] = 'bad'
            elif change == 'certificate': row['certificateSha256'] = 'bad'
            elif change == 'boundary':
                row['entryBoundary'] = 'manifest-parse-admission'
            elif change == 'declarations': row['closedAssumptionCount'] = 4
            elif change == 'core-commit': row['coreSourceCommit'] = 'f'*40
            else: row['kernelDeclarations'] = ['cert-b']
            with self.subTest(change=change), self.assertRaisesRegex(ValueError,
                                                                     'load-admission'):
                self.module.join_scopes(inventory, receipts)

    def test_load_admission_control_files_and_closure_logs_cannot_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = copy.deepcopy(fixture(self.module)[1]['load-admission'])
            name = self.module.LOAD_ADMISSION_CONTROLS[0]
            for control in self.module.LOAD_ADMISSION_CONTROLS:
                case = root/control; case.mkdir()
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v'):
                    raw = (control + '/' + filename + '\n').encode()
                    (case/filename).write_bytes(raw)
                    report['controlProofSha256'][control+'/'+filename] = self.module.sha(raw)
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log'):
                    (case/filename).write_bytes(('fixture ' + filename + '\n').encode())
                    report['controlLogSha256'][control+'/'+filename] = self.module.sha(
                        (case/filename).read_bytes())
                row = report['semanticControls'][
                    self.module.LOAD_ADMISSION_CONTROLS.index(control)]
                row.update(definitionsSha256=report['controlProofSha256'][control+'/Definitions.v'],
                           counterexampleSha256=report['controlProofSha256'][control+'/Counterexample.v'],
                           rejectionLogSha256=report['controlLogSha256'][control+'/rejection.log'])
            for module_name, count in (('LoadAdmission', 2), ('LoadAdmissionArtifact', 1)):
                (root/(('model' if module_name == 'LoadAdmission' else 'certificate')
                      + '.log')).write_text('Closed under the global context\n'*count)
            self.module.validate_load_admission_control_files(report, root)
            for change in ('missing', 'extra', 'row', 'proof', 'log', 'open-model', 'axiom'):
                candidate = copy.deepcopy(report)
                if change == 'missing': candidate['controlProofSha256'].pop(name+'/Definitions.v')
                elif change == 'extra': candidate['controlLogSha256']['other.log'] = '0'*64
                elif change == 'row': candidate['semanticControls'][0]['rejectionLogSha256'] = '0'*64
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n')
                elif change == 'axiom':
                    (root/'certificate.log').write_text(
                        'Closed under the global context\nAxioms:\nfoo : True\n')
                else:
                    path = root/name/('Definitions.v' if change == 'proof' else 'rejection.log')
                    previous = path.read_bytes(); path.write_bytes(b'changed')
                with self.subTest(change=change), self.assertRaisesRegex(
                        ValueError, 'load-admission'):
                    self.module.validate_load_admission_control_files(candidate, root)
                if change in ('proof', 'log'): path.write_bytes(previous)
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n'*2)
                elif change == 'axiom':
                    (root/'certificate.log').write_text('Closed under the global context\n')

    def test_exception_identity_pins_the_surfacing_record_not_just_a_scope_name(self):
        result = self.module.join_scopes(*fixture(self.module))
        claim = result['scopedClaims']['exception-identity']
        self.assertEqual(claim['scope'], 'exception-identity-and-catchability')
        self.assertEqual(claim['entryBoundary'],
                         'ExecuteNext-fault-surfacing-and-catch-admission-effect')
        self.assertEqual(claim['projectedProgram'], self.module.EXCEPTION_IDENTITY_PROGRAM)
        self.assertEqual(claim['semanticControlCount'],
                         len(self.module.EXCEPTION_IDENTITY_CONTROLS))
        self.assertFalse(claim['applicationEngineVerified'])
        self.assertFalse(claim['sourceFrontendVerified'])
        self.assertFalse(claim['vmCorrespondenceProven'])
        self.assertEqual(claim['unproved'], self.module.EXCEPTION_IDENTITY_DOMAIN['unproved'])
        self.assertEqual(result['verifiedEntrypoints'], [])
        self.assertEqual(result['fullUnprovedCount'], 4)

    def test_exception_identity_cannot_be_omitted_or_overclaim_execution(self):
        inventory, receipts = fixture(self.module)
        del receipts['exception-identity']
        with self.assertRaisesRegex(ValueError, 'missing/extra'):
            self.module.join_scopes(inventory, receipts)
        for field in ('sourceFrontendVerified', 'applicationEngineVerified',
                      'vmCorrespondenceProven', 'implementationVerified',
                      'fullImplementationVerified'):
            for forged in (True, None):
                inventory, receipts = fixture(self.module)
                receipts['exception-identity'][field] = forged
                with self.subTest(field=field, forged=forged), self.assertRaisesRegex(
                        ValueError, 'exception-identity'):
                    self.module.join_scopes(inventory, receipts)

    def test_exception_identity_program_fields_cannot_drift_one_at_a_time(self):
        fields = []
        for name in self.module.EXCEPTION_IDENTITY_PROGRAM:
            if name == 'step_order':
                fields.append((name, list(reversed(self.module.EXCEPTION_IDENTITY_PROGRAM[name]))))
            else:
                fields.append((name, False))
        self.assertEqual({name for name, _ in fields}, set(self.module.EXCEPTION_IDENTITY_PROGRAM))
        self.assertEqual(16, len(fields))
        for field, value in fields:
            inventory, receipts = fixture(self.module)
            receipts['exception-identity']['program'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError,
                                                                  'exception-identity'):
                self.module.join_scopes(inventory, receipts)
        # `1 == True` in Python, and a same-value literal of the wrong type must
        # not slip past the record comparison.
        for field, value in (('the_fault_sets_the_state', 1),
                             ('step_order', 'guarded-catch'),
                             ('the_caught_value_is_the_message', 'true')):
            inventory, receipts = fixture(self.module)
            receipts['exception-identity']['program'][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(
                    ValueError, 'exception-identity'):
                self.module.join_scopes(inventory, receipts)

    def test_exception_identity_cannot_drop_reorder_or_weaken_controls(self):
        self.assertEqual(len(self.module.EXCEPTION_IDENTITY_CONTROLS), 16)
        for change in ('drop', 'reorder', 'duplicate', 'rename'):
            inventory, receipts = fixture(self.module)
            rows = receipts['exception-identity']['semanticControls']
            if change == 'drop': rows.pop()
            elif change == 'reorder': rows.reverse()
            elif change == 'duplicate': rows[-1] = copy.deepcopy(rows[0])
            else: rows[0]['name'] = 'catch-everything'
            with self.subTest(change=change), self.assertRaisesRegex(ValueError,
                                                                    'exception-identity'):
                self.module.join_scopes(inventory, receipts)
        for row_field, forged in (('certificateRejected', False), ('kernelExitCode', 0),
                                  ('kernelCounterexampleChecked', False), ('timedOut', True),
                                  ('definitionsCompiled', False)):
            inventory, receipts = fixture(self.module)
            receipts['exception-identity']['semanticControls'][0][row_field] = forged
            with self.subTest(row_field=row_field), self.assertRaisesRegex(
                    ValueError, 'exception-identity'):
                self.module.join_scopes(inventory, receipts)
        for field in ('preconditions', 'unproved', 'tcb'):
            for change in ('drop', 'empty', 'text'):
                inventory, receipts = fixture(self.module)
                values = receipts['exception-identity'][field]
                if change == 'drop': receipts['exception-identity'].pop(field)
                elif change == 'empty': receipts['exception-identity'][field] = []
                else: receipts['exception-identity'][field] = values[:-1] + ['weakened']
                with self.subTest(field=field, change=change), self.assertRaisesRegex(
                        ValueError, 'exception-identity'):
                    self.module.join_scopes(inventory, receipts)
        for change in ('drop', 'text'):
            inventory, receipts = fixture(self.module)
            row = receipts['exception-identity']
            if change == 'drop': row.pop('reasonOnlyGuards')
            else: row['reasonOnlyGuards'] = ['catch-clause-subtyping']
            with self.subTest(guards=change), self.assertRaisesRegex(ValueError,
                                                                     'exception-identity'):
                self.module.join_scopes(inventory, receipts)

    def test_exception_identity_requires_every_pin_and_exact_identities(self):
        for change in ('drop-one-source', 'extra-source', 'other-commit', 'unpinned-url',
                       'bad-hash', 'relative-path', 'projection', 'certificate',
                       'boundary', 'declarations', 'certificate-declarations', 'vm-commit'):
            inventory, receipts = fixture(self.module)
            row = receipts['exception-identity']
            if change == 'drop-one-source':
                row['pinnedSource'].pop(next(iter(row['pinnedSource'])))
            elif change == 'extra-source':
                row['pinnedSource']['vm/extra'] = dict(
                    path=FIXTURE_ROOT + '/vm-extra.cs', sha256='4'*64,
                    url='https://raw.githubusercontent.com/neo-project/neo-vm/'
                        + self.module.VM_COMMIT + '/src/Neo.VM/CatchableException.cs')
            elif change == 'other-commit':
                for value in row['pinnedSource'].values():
                    value['url'] = (value['url'].replace(self.module.CORE_COMMIT, 'f'*40)
                                    .replace(self.module.VM_COMMIT, 'f'*40))
            elif change == 'unpinned-url':
                next(iter(row['pinnedSource'].values()))['url'] = 'https://example.invalid/source.cs'
            elif change == 'bad-hash':
                next(iter(row['pinnedSource'].values()))['sha256'] = 'not-a-hash'
            elif change == 'relative-path':
                next(iter(row['pinnedSource'].values()))['path'] = 'source.cs'
            elif change == 'projection': row['sourceProjectionSha256'] = 'bad'
            elif change == 'certificate': row['certificateSha256'] = 'bad'
            elif change == 'boundary':
                row['entryBoundary'] = 'ExecuteNext-fault-surfacing-to-handler-entry'
            elif change == 'declarations': row['closedAssumptionCount'] = 4
            elif change == 'vm-commit': row['vmSourceCommit'] = 'f'*40
            else: row['kernelDeclarations'] = ['cert-b']
            with self.subTest(change=change), self.assertRaisesRegex(ValueError,
                                                                     'exception-identity'):
                self.module.join_scopes(inventory, receipts)

    def test_exception_identity_control_files_and_closure_logs_cannot_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = copy.deepcopy(fixture(self.module)[1]['exception-identity'])
            name = self.module.EXCEPTION_IDENTITY_CONTROLS[0]
            for control in self.module.EXCEPTION_IDENTITY_CONTROLS:
                case = root/control; case.mkdir()
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v'):
                    raw = (control + '/' + filename + '\n').encode()
                    (case/filename).write_bytes(raw)
                    report['controlProofSha256'][control+'/'+filename] = self.module.sha(raw)
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log'):
                    (case/filename).write_bytes(('fixture ' + filename + '\n').encode())
                    report['controlLogSha256'][control+'/'+filename] = self.module.sha(
                        (case/filename).read_bytes())
                row = report['semanticControls'][
                    self.module.EXCEPTION_IDENTITY_CONTROLS.index(control)]
                row.update(definitionsSha256=report['controlProofSha256'][control+'/Definitions.v'],
                           counterexampleSha256=report['controlProofSha256'][control+'/Counterexample.v'],
                           rejectionLogSha256=report['controlLogSha256'][control+'/rejection.log'])
            for module_name, count in (('ExceptionIdentity', 2), ('ExceptionIdentityArtifact', 1)):
                (root/(('model' if module_name == 'ExceptionIdentity' else 'certificate')
                      + '.log')).write_text('Closed under the global context\n'*count)
            self.module.validate_exception_identity_control_files(report, root)
            for change in ('missing', 'extra', 'row', 'proof', 'log', 'open-model', 'axiom'):
                candidate = copy.deepcopy(report)
                if change == 'missing': candidate['controlProofSha256'].pop(name+'/Definitions.v')
                elif change == 'extra': candidate['controlLogSha256']['other.log'] = '0'*64
                elif change == 'row': candidate['semanticControls'][0]['rejectionLogSha256'] = '0'*64
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n')
                elif change == 'axiom':
                    (root/'certificate.log').write_text(
                        'Closed under the global context\nAxioms:\nfoo : True\n')
                else:
                    path = root/name/('Definitions.v' if change == 'proof' else 'rejection.log')
                    previous = path.read_bytes(); path.write_bytes(b'changed')
                with self.subTest(change=change), self.assertRaisesRegex(
                        ValueError, 'exception-identity'):
                    self.module.validate_exception_identity_control_files(candidate, root)
                if change in ('proof', 'log'): path.write_bytes(previous)
                elif change == 'open-model':
                    (root/'model.log').write_text('Closed under the global context\n'*2)
                elif change == 'axiom':
                    (root/'certificate.log').write_text('Closed under the global context\n')

    def test_scoped_pass_never_becomes_full_entrypoint_pass(self):
        report = self.module.join_scopes(*fixture(self.module))
        self.assertEqual(report['status'], 'NO-GO')
        self.assertEqual(report['selectedScopeStatus'], 'PASS')
        self.assertEqual(report['fullUnprovedCount'], 4)
        self.assertEqual(report['verifiedEntrypoints'], [])
        self.assertEqual(report['entrypointCoverage']['fullyClosed'], 0)
        self.assertEqual(report['entrypointCoverage']['bodyLevelRefined'], 3)
        self.assertEqual(report['entrypointCoverage']['dispatchLevelOnly'], 1)

    def test_missing_lane_rejected(self):
        inventory, receipts = fixture(self.module); del receipts['context']
        with self.assertRaises(ValueError): self.module.join_scopes(inventory, receipts)

    def test_wrong_scope_rejected(self):
        inventory, receipts = fixture(self.module); receipts['context']['scope'] = 'full-implementation'
        with self.assertRaisesRegex(ValueError, 'scope'): self.module.join_scopes(inventory, receipts)

    def test_kernel_flag_alone_rejected(self):
        inventory, receipts = fixture(self.module); receipts['public']['semanticControls'] = []
        with self.assertRaisesRegex(ValueError, 'controls'): self.module.join_scopes(inventory, receipts)

    def test_full_claim_rejected(self):
        inventory, receipts = fixture(self.module); receipts['method']['fullImplementationVerified'] = True
        with self.assertRaisesRegex(ValueError, 'full'): self.module.join_scopes(inventory, receipts)

    def test_stale_nef_rejected(self):
        inventory, receipts = fixture(self.module); receipts['public']['nefSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'NEF'): self.module.join_scopes(inventory, receipts)

    def test_stale_script_rejected(self):
        inventory, receipts = fixture(self.module); receipts['context']['scriptSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'script'): self.module.join_scopes(inventory, receipts)

    def test_wrong_helper_certificate_rejected(self):
        inventory, receipts = fixture(self.module); receipts['composition']['helperCertificateSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'helper'): self.module.join_scopes(inventory, receipts)

    def test_wrong_helper_method_rejected(self):
        inventory, receipts = fixture(self.module); receipts['composition']['helperMethodSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'helper'): self.module.join_scopes(inventory, receipts)

    def test_wrong_initializer_hash_rejected(self):
        inventory, receipts = fixture(self.module); receipts['initializer']['initializerSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'initializer'): self.module.join_scopes(inventory, receipts)

    def test_initializer_source_field_count_rejected(self):
        inventory, receipts = fixture(self.module); receipts['initializer']['fieldCount'] = 2
        with self.assertRaisesRegex(ValueError, 'field'): self.module.join_scopes(inventory, receipts)

    def test_runtime_must_bind_pinned_production_source(self):
        inventory, receipts = fixture(self.module); receipts['runtime']['sourceCommit'] = 'other'
        with self.assertRaisesRegex(ValueError, 'runtime'): self.module.join_scopes(inventory, receipts)

    def test_gas_cannot_use_test_supplied_source(self):
        inventory, receipts = fixture(self.module); receipts['gas']['productionSourceBound'] = False
        with self.assertRaisesRegex(ValueError, 'gas'): self.module.join_scopes(inventory, receipts)

    def test_timeout_or_invalid_definition_not_negative_evidence(self):
        for change in ({'definitionsCompiled': False}, {'certificateRejected': False}, {'timedOut': True}):
            inventory, receipts = fixture(self.module)
            receipts['context']['semanticControls'] = [{**receipts['context']['semanticControls'][0], **change}]
            with self.assertRaisesRegex(ValueError, 'control'): self.module.join_scopes(inventory, receipts)

    def test_codec_vector_join_remains_concrete_only(self):
        inventory, receipts = fixture(self.module)
        receipts['codec'].update(nativeVectorJoin={'sha256': '5'*64}, nativeVectorKernel={'kernelChecked': True, 'corruptedArtifactByteRejected': True})
        result = self.module.join_scopes(inventory, receipts, native_vector_sha='5'*64)
        self.assertEqual(result['nativeVectorScope'], 'finite-concrete-vectors-only')
        self.assertFalse(result['implementationVerified'])

    def test_wrong_native_vector_hash_rejected(self):
        inventory, receipts = fixture(self.module)
        receipts['codec'].update(nativeVectorJoin={'sha256': '5'*64}, nativeVectorKernel={'kernelChecked': True, 'corruptedArtifactByteRejected': True})
        with self.assertRaises(ValueError): self.module.join_scopes(inventory, receipts, native_vector_sha='6'*64)

    def test_snapshot_compiles_copied_bytes_and_detects_original_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root/'original.py'; source.write_bytes(b'print(1)\n')
            snapshot = self.module.capture_files([source], root/'copy')
            item = snapshot[str(source.resolve())]
            self.assertEqual(Path(item['copy']).read_bytes(), b'print(1)\n')
            self.module.check_snapshot(snapshot)
            source.write_bytes(b'print(2)\n')
            with self.assertRaisesRegex(ValueError, 'drift'): self.module.check_snapshot(snapshot)

    def test_modified_copy_fails_even_if_original_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root/'original.py'; source.write_bytes(b'print(1)\n')
            snapshot = self.module.capture_files([source], root/'copy')
            Path(snapshot[str(source.resolve())]['copy']).write_bytes(b'print(2)\n')
            with self.assertRaisesRegex(ValueError, 'drift'): self.module.check_snapshot(snapshot)

    def test_process_failure_and_timeout_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.module.run_command([sys.executable, '-c', 'raise SystemExit(7)'], root/'fail.log', 2)
            self.assertEqual(result['exitCode'], 7)
            result = self.module.run_command([sys.executable, '-c', 'import time;time.sleep(10)'], root/'timeout.log', .1)
            self.assertTrue(result['timedOut'])
            self.assertNotEqual(result['exitCode'], 0)

    def test_stale_existing_output_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'stale.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'empty'): self.module.prepare_output(root)

    def test_cross_lane_same_public_source_bytes_must_match(self):
        inventory, receipts = fixture(self.module)
        url = 'https://raw.githubusercontent.com/neo-project/neo-vm/' + self.module.VM_COMMIT + '/src/Neo.VM/Types/Integer.cs'
        receipts['numeric']['pinnedSource'] = {'Integer': {'url': url, 'sha256': '1'*64}}
        receipts['codec']['pinnedSource'] = {'Integer': {'url': url, 'sha256': '2'*64}}
        with self.assertRaisesRegex(ValueError, 'cross-lane'): self.module.join_scopes(inventory, receipts)

    def test_initializer_or_public_frontend_runtime_overclaim_rejected(self):
        for lane, key in (('initializer', 'sourceFrontendVerified'), ('public', 'vmCorrespondenceProven')):
            inventory, receipts = fixture(self.module); receipts[lane][key] = True
            with self.assertRaises(ValueError): self.module.join_scopes(inventory, receipts)

    def test_unpinned_source_url_rejected(self):
        inventory, receipts = fixture(self.module)
        receipts['codec']['pinnedSource'] = {'Integer': {'url': 'https://example.com/Integer.cs', 'sha256': '1'*64}}
        with self.assertRaisesRegex(ValueError, 'unpinned'): self.module.join_scopes(inventory, receipts)

    def test_generated_certificate_must_match_actual_output_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); file = root/'CapMethodArtifact.v'; file.write_bytes(b'actual')
            report = {'certificateSha256': self.module.sha(b'forged')}
            with self.assertRaisesRegex(ValueError, 'certificate'): self.module.validate_provenance('method', report, {}, root)

    def test_model_hash_must_be_a_captured_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); file = root/'Model.v'; file.write_bytes(b'actual')
            snapshot = self.module.capture_files([file], root/'copy')
            report = {'modelSha256': {'Model': self.module.sha(b'forged')}}
            with self.assertRaisesRegex(ValueError, 'model'): self.module.validate_provenance('numeric', report, snapshot, root)

    def test_control_dictionary_details_cannot_omit_rejected_names(self):
        value = {'definitionsCompiled': True, 'rejected': ['a', 'b'], 'controls': {'a': {}}}
        with self.assertRaisesRegex(ValueError, 'omitted'): self.module.checked_controls(value, 'test')

    def test_composition_control_summary_rejects_invalid_kernel_evidence(self):
        control = {'definitionsCompiled': True, 'certificateRejected': True, 'kernelExitCode': 1}
        value = {'definitionsCompiled': True, 'rejected': ['a'], 'controls': {'a': control}}
        self.assertEqual(self.module.checked_controls(value, 'composition'), 1)
        for change in ({'timedOut': True}, {'definitionsCompiled': False}, {'certificateRejected': False},
                       {'kernelExitCode': 0}, {'kernelExitCode': -15}, {'kernelExitCode': True}):
            candidate = {**value, 'controls': {'a': {**control, **change}}}
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.module.checked_controls(candidate, 'composition')
        with self.assertRaises(ValueError):
            self.module.checked_controls(value['rejected'], 'composition')
        with self.assertRaises(ValueError):
            self.module.checked_controls({k: v for k, v in value.items() if k != 'controls'}, 'composition')
        for key in ('definitionsCompiled', 'certificateRejected', 'kernelExitCode'):
            candidate = {**value, 'controls': {'a': {k: v for k, v in control.items() if k != key}}}
            with self.subTest(missing=key), self.assertRaises(ValueError):
                self.module.checked_controls(candidate, 'composition')

    def test_composition_join_requires_canonical_control_schema(self):
        for kind in ('schema', 'scope', 'names-only', 'rows-only'):
            inventory, receipts = fixture(self.module)
            controls = receipts['composition']['semanticControls']
            if kind in ('schema', 'scope'): controls.pop(kind)
            elif kind == 'names-only': receipts['composition']['semanticControls'] = controls['rejected']
            else: receipts['composition']['semanticControls'] = list(controls['controls'].values())
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.module.join_scopes(inventory, receipts)

    def test_control_summary_rejects_malformed_names_and_details(self):
        for names in ([['a']], [None], [1], [''], ['a', 'a']):
            with self.subTest(names=names), self.assertRaises(ValueError):
                self.module.checked_controls({'definitionsCompiled': True, 'rejected': names}, 'composition')
        with self.assertRaises(ValueError):
            self.module.checked_controls({'definitionsCompiled': True, 'rejected': ['a'], 'controls': ['a']}, 'composition')

    def test_runtime_controls_require_kernel_checked_counterexample(self):
        row = {'sourceDefinitionCompiled': True, 'correspondenceRejected': True, 'kernelCounterexampleChecked': True}
        self.assertEqual(self.module.checked_controls([row], 'runtime'), 1)
        row['kernelCounterexampleChecked'] = False
        with self.assertRaises(ValueError): self.module.checked_controls([row], 'runtime')

    def test_generated_arithmetic_proof_bytes_are_joined(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'CapArtifact.v').write_bytes(b'actual')
            report = {'generatedProofSha256': {'CapArtifact.v': self.module.sha(b'forged')}}
            with self.assertRaisesRegex(ValueError, 'proof byte'): self.module.validate_provenance('arithmetic', report, {}, root)

    def test_codec_typed_sub_layer_never_inherits_model_kernel_pass(self):
        inventory, receipts = fixture(self.module)
        typed = receipts['codec']['typedNativeSource']
        result = self.module.join_scopes(inventory, receipts)
        self.assertFalse(result['scopedClaims']['codec']['typedNativeSource']['fullSourceSimulationProven'])
        typed['scope'] = 'complete-production-runtime'
        with self.assertRaisesRegex(ValueError, 'overclaimed'): self.module.join_scopes(inventory, receipts)

    def test_missing_selected_codec_source_sub_layer_rejected(self):
        inventory, receipts = fixture(self.module); del receipts['codec']['typedNativeSource']
        with self.assertRaisesRegex(ValueError, 'missing'): self.module.join_scopes(inventory, receipts)

    def test_helper_gas_cannot_mix_artifact_or_claim_application_engine(self):
        inventory, receipts = fixture(self.module)
        receipts['helper-gas']['artifacts']['helperSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'artifact'): self.module.join_scopes(inventory, receipts)
        inventory, receipts = fixture(self.module); receipts['helper-gas']['applicationEngineVerified'] = True
        with self.assertRaisesRegex(ValueError, 'scope'): self.module.join_scopes(inventory, receipts)

    def test_selected_dependency_graph_ignores_unrelated_new_lane(self):
        paths = self.module.tool_paths()
        self.assertIn(HERE/'gas_trace_proofs.py', paths)
        self.assertIn(HERE/'coq/HelperGasBound.v', paths)
        self.assertIn(HERE/'entry_dispatch_proofs.py', paths)
        self.assertIn(HERE/'entry_dispatch_source.py', paths)
        self.assertIn(HERE/'coq/EntryDispatch.v', paths)
        self.assertNotIn(HERE/'hook_proofs.py', paths)

    def test_helper_context_cannot_omit_range_and_instruction_coverage(self):
        inventory, receipts = fixture(self.module); del receipts['context']['methodInstructionCount']
        with self.assertRaisesRegex(ValueError, 'coverage'): self.module.join_scopes(inventory, receipts)

    def test_helper_method_hash_is_bound_to_raw_inventory_script(self):
        inventory, receipts = fixture(self.module); receipts['method']['methodSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'coverage'): self.module.join_scopes(inventory, receipts)

    def test_retired_hook_lane_is_not_joined(self):
        self.assertNotIn('hook', self.module.SCOPES)
        self.assertNotIn('hook', self.module.ARTIFACT_LANES)
        self.assertNotIn('hook', self.module.CERTIFICATES)
        inventory, receipts = fixture(self.module)
        result = self.module.join_scopes(inventory, receipts)
        self.assertEqual(result['verifiedEntrypoints'], [])
        self.assertEqual(result['fullUnprovedCount'], 4)

    def test_runtime_collection_partial_projection_is_preserved(self):
        report = self.module.join_scopes(*fixture(self.module))
        self.assertEqual(report['scopedClaims']['runtime-collections']['supportingProjections'], self.module.COLLECTION_PARTIAL_SCOPES)
        self.assertNotIn('RET', report['scopedClaims']['runtime-collections']['provenOpcodes'])

    def test_runtime_collection_partial_projection_cannot_be_complete(self):
        inventory, receipts = fixture(self.module)
        receipts['runtime-collections']['provenOpcodes'].append('RET')
        with self.assertRaisesRegex(ValueError,'partial'): self.module.join_scopes(inventory,receipts)

    def test_relative_tool_hash_requires_unique_captured_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);tool=root/'runner.py';tool.write_bytes(b'actual')
            snapshot=self.module.capture_files([tool],root/'copy')
            report={'toolInputSha256':{'runner.py':self.module.sha(b'actual')}}
            self.module.validate_provenance('numeric',report,snapshot,root)
            report['toolInputSha256']['runner.py']=self.module.sha(b'forged')
            with self.assertRaisesRegex(ValueError,'relative tool'):self.module.validate_provenance('numeric',report,snapshot,root)

    def test_relative_tool_path_cannot_escape_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError,'relative input'):
                self.module.validate_provenance('numeric',{'toolInputSha256':{'../runner.py':'a'*64}}, {},Path(directory))

    def test_repository_relative_tool_path_uses_exact_captured_member(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); repo = root / 'repo'
            selected = repo / 'formal/refinement/prove.py'
            selected.parent.mkdir(parents=True); selected.write_bytes(b'proof tool')
            other = repo / 'other/prove.py'
            other.parent.mkdir(); other.write_bytes(b'proof tool')
            snapshot = self.module.capture_files([selected, other], root / 'snapshot', repo)
            with patch.object(self.module, 'REPO', repo):
                for field in ('toolInputSha256', 'inputSha256', 'sourceInputSha256'):
                    report = {field: {'formal/refinement/prove.py': self.module.sha(b'proof tool')}}
                    with self.subTest(field=field):
                        self.module.validate_provenance('arithmetic', report, snapshot, root)
                        missing = {key: value for key, value in snapshot.items() if key != str(selected)}
                        with self.assertRaisesRegex(ValueError, 'relative'):
                            self.module.validate_provenance('arithmetic', report, missing, root)
                        report[field]['formal/refinement/prove.py'] = self.module.sha(b'forged')
                        with self.assertRaisesRegex(ValueError, 'relative'):
                            self.module.validate_provenance('arithmetic', report, snapshot, root)

    def test_external_proof_input_resolves_only_inside_the_fresh_evidence_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory).resolve()
            evidence = output / 'composition'
            base = output / 'base'
            evidence.mkdir()
            base.mkdir()
            helper = base / 'method-proof.json'
            helper.write_bytes(b'fresh helper proof')
            report = {'inputSha256': {
                'external/method-proof.json': self.module.sha(helper.read_bytes())}}

            self.module.validate_provenance('numeric', report, {}, evidence)

            duplicate = evidence / helper.name
            duplicate.write_bytes(helper.read_bytes())
            with self.assertRaisesRegex(ValueError, 'relative tool/input identity'):
                self.module.validate_provenance('numeric', report, {}, evidence)

            duplicate.unlink()
            report['inputSha256']['external/method-proof.json'] = self.module.sha(b'forged')
            with self.assertRaisesRegex(ValueError, 'relative tool/input identity'):
                self.module.validate_provenance('numeric', report, {}, evidence)

    def test_repository_relative_tools_reject_escaping_noncanonical_and_unbound_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); repo = root / 'repo'
            selected = repo / 'formal/refinement/prove.py'
            selected.parent.mkdir(parents=True); selected.write_bytes(b'proof tool')
            outside = root / 'outside.py'; outside.write_bytes(b'proof tool')
            (repo / 'outside-link').symlink_to(root, target_is_directory=True)
            (repo / 'inside-link').symlink_to(selected.parent, target_is_directory=True)
            snapshot = self.module.capture_files([selected, outside], root / 'snapshot')
            names = ('../outside.py', './formal/refinement/prove.py', 'formal//refinement/prove.py',
                     'formal/refinement/../refinement/prove.py', 'missing/prove.py',
                     'outside-link/outside.py', 'inside-link/prove.py')
            with patch.object(self.module, 'REPO', repo):
                for field in ('toolInputSha256', 'inputSha256', 'sourceInputSha256'):
                    for name in names:
                        report = {field: {name: self.module.sha(b'proof tool')}}
                        with self.subTest(field=field, name=name), self.assertRaisesRegex(ValueError, 'relative'):
                            self.module.validate_provenance('arithmetic', report, snapshot, root)
                for field in ('inputSha256', 'sourceInputSha256'):
                    report = {field: {'prove.py': self.module.sha(b'proof tool')}}
                    with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'relative'):
                        self.module.validate_provenance('arithmetic', report, snapshot, root)

    def test_actual_decoded_container_must_match_inventory_even_with_same_script(self):
        inventory,_ = fixture(self.module)
        self.module.require_bound_artifact({'nefSha256':'a'*64,'scriptSha256':'b'*64},inventory,'helper')
        with self.assertRaisesRegex(ValueError,'actual decoded'):
            self.module.require_bound_artifact({'nefSha256':'c'*64,'scriptSha256':'b'*64},inventory,'helper')

    def test_selected_dependency_snapshot_excludes_generated_build_outputs(self):
        paths=self.module.tool_paths()
        self.assertFalse([p for p in paths if HERE in p.parents and any(part in {'bin','obj'} for part in p.relative_to(HERE).parts)])
        self.assertIn(HERE/'export/Program.cs',paths)
        self.assertIn(HERE/'native_export/Program.cs',paths)

    def test_runtime_collection_omitted_partial_key_cannot_promote_RET(self):
        inventory,receipts=fixture(self.module)
        receipts['runtime-collections']['supportingProjections'].pop('RET')
        receipts['runtime-collections']['provenOpcodes'].append('RET')
        with self.assertRaisesRegex(ValueError,'partial'):self.module.join_scopes(inventory,receipts)

    def test_runtime_opcode_claims_must_follow_actual_source_projection(self):
        projection={'sourceCommit':self.module.VM_COMMIT,'sourceSha256':{'source.cs':'a'*64},
                    'programs':{'PICKITEM':{},'RET':{}},'unsupported':['caller continuation']}
        report={'sourceCommit':self.module.VM_COMMIT,'sourceSha256':{'source.cs':'a'*64},
                'supportedOpcodes':['PICKITEM','RET'],'provenOpcodes':['PICKITEM'],'unproved':['caller continuation']}
        self.module.validate_runtime_projection('runtime-collections',report,projection)
        report['provenOpcodes'].append('CALLT')
        with self.assertRaisesRegex(ValueError,'actual source'):self.module.validate_runtime_projection('runtime-collections',report,projection)

    def test_runtime_source_exclusions_cannot_be_erased(self):
        projection={'sourceCommit':self.module.VM_COMMIT,'sourceSha256':{},'handlers':{'ADD':{}},'unsupported':['partial pop state']}
        report={'sourceCommit':self.module.VM_COMMIT,'sourceSha256':{},'supportedOpcodes':['ADD'],'provenOpcodes':['ADD'],'unproved':[]}
        with self.assertRaisesRegex(ValueError,'exclusions'):self.module.validate_runtime_projection('runtime',report,projection)

    def test_runtime_certificate_declarations_derive_from_hashed_raw_bytes(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);raw=b'Theorem bridge_ADD : True. Proof. exact I. Qed.\n'
            (root/'RuntimeSourceCertificate.v').write_bytes(raw)
            projection={'sourceCommit':self.module.VM_COMMIT,'sourceSha256':{},'handlers':{'ADD':{}},'unsupported':[]}
            projection_raw=json.dumps(projection).encode();(root/'source-projection.json').write_bytes(projection_raw)
            report={'generatedCertificateSha256':self.module.sha(raw),'sourceProjectionSha256':self.module.sha(projection_raw),
                    'sourceCommit':self.module.VM_COMMIT,'sourceSha256':{},'supportedOpcodes':['ADD'],
                    'provenOpcodes':['ADD'],'unproved':[],'kernelDeclarations':['bridge_ADD']}
            with patch.object(Path,'read_text',side_effect=AssertionError('Certificate reopened instead of reusing hashed raw')):
                self.module.validate_provenance('runtime',report,{},root)


    def test_storage_getter_lane_cannot_be_omitted(self):
        inventory, receipts = fixture(self.module)
        del receipts['storage-getters']
        with self.assertRaisesRegex(ValueError, 'missing/extra'):
            self.module.join_scopes(inventory, receipts)

    def test_storage_getter_lane_scope_and_no_full_claim_enforced(self):
        for field, forged in (('scope', 'complete-production-runtime'),
                              ('fullImplementationVerified', True),
                              ('implementationVerified', True)):
            inventory, receipts = fixture(self.module)
            receipts['storage-getters'][field] = forged
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.module.join_scopes(inventory, receipts)

    def test_storage_getters_cannot_claim_entrypoint_closure(self):
        fields = {'schema': 'other', 'coqchkChecked': False, 'assumptionsClosed': False,
                  'vmCorrespondenceProven': False, 'vmCorrespondenceScope': '',
                  'projectionSha256': 'bad', 'referenceVerifiedEntrypoints': ['pure'],
                  'fullUnprovedEntrypointCount': 0,
                  'openObligations': ['APPLICATION_ENGINE_REFINEMENT']}
        for field, forged in fields.items():
            for missing in (False, True):
                inventory, receipts = fixture(self.module)
                if missing: receipts['storage-getters'].pop(field)
                else: receipts['storage-getters'][field] = forged
                with self.subTest(field=field, missing=missing), self.assertRaises(ValueError):
                    self.module.join_scopes(inventory, receipts)

    def test_storage_getter_inventories_must_agree(self):
        cases = [('storageGetterSourceVerified', []),
                 ('storageGetterSourceVerified', ['getValue', 'getValue']),
                 ('storageGetterSourceVerified', ['getValue', 'pure']),
                 ('dispatchBoundEntrypoints', ['pure']),
                 ('vmTraceCoverage', {}),
                 ('vmTraceCoverage', {'getValue': []}),
                 ('methods', {}),
                 ('methods', {'geValue': fixture(self.module)[1]['storage-getters']['methods']['getValue']})]
        for field, value in cases:
            inventory, receipts = fixture(self.module)
            receipts['storage-getters'][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, 'storage getter'):
                self.module.join_scopes(inventory, receipts)

    def test_storage_getter_lane_cannot_absorb_a_mutating_or_unknown_entrypoint(self):
        for name in ('pure', '_initialize', 'ghost'):
            inventory, receipts = fixture(self.module)
            abis = [entry for entry in inventory['manifest']['methods'] if entry['name'] == name]
            row = dict(abi=abis[0] if abis else {'name': name, 'offset': 0}, start=0, endExclusive=1,
                       byteCount=1, regionBytesSha256=self.module.sha(bytes.fromhex('11')),
                       instructionCount=1)
            for key in ('storageGetterSourceVerified', 'dispatchBoundEntrypoints'):
                receipts['storage-getters'][key] = [name]
            receipts['storage-getters']['methods'] = {name: row}
            receipts['storage-getters']['vmTraceCoverage'] = {name: ['miss', 'hit']}
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'storage getter'):
                self.module.join_scopes(inventory, receipts)

    def test_storage_getter_body_regions_bind_the_actual_script_bytes(self):
        cases = [('start', 1), ('endExclusive', 3), ('endExclusive', 0), ('byteCount', 2),
                 ('regionBytesSha256', '0'*64), ('instructionCount', 0), ('instructionCount', True)]
        for field, value in cases:
            inventory, receipts = fixture(self.module)
            receipts['storage-getters']['methods']['getValue'][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, 'ABI/region'):
                self.module.join_scopes(inventory, receipts)
        inventory, receipts = fixture(self.module)
        receipts['storage-getters']['methods']['getValue']['abi'] = {'name': 'getValue', 'offset': 0}
        with self.assertRaisesRegex(ValueError, 'ABI/region'):
            self.module.join_scopes(inventory, receipts)

    def test_storage_getter_shared_callee_inventory_is_pinned(self):
        callees = fixture(self.module)[1]['storage-getters']['sharedCallees']
        cases = [callees[:-1], [dict(row, name='GetOther') for row in callees],
                 [dict(row, regions=[0, 3]) for row in callees],
                 [dict(row, regions=[0]) for row in callees],
                 [dict(row, projectionKinds=[]) for row in callees],
                 [dict(row, deserializeTokenIndex='4') for row in callees]]
        for value in cases:
            inventory, receipts = fixture(self.module)
            receipts['storage-getters']['sharedCallees'] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'storage getter'):
                self.module.join_scopes(inventory, receipts)

    def test_storage_getter_bytecode_controls_require_kernel_rejection(self):
        changes = ({'definitionsAccepted': False}, {'baselineAccepted': False}, {'proofRejected': False},
                   {'kernelExitCode': 0}, {'kernelExitCode': -15}, {'kernelExitCode': True},
                   {'timedOut': True}, {'timeout': True}, {'getter': 'unknown'},
                   {'baselineSha256': 'bad'}, {'definitionsSha256': 'bad'})
        for change in changes:
            inventory, receipts = fixture(self.module)
            receipts['storage-getters']['vmSemanticControls'][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.module.join_scopes(inventory, receipts)
        inventory, receipts = fixture(self.module)
        receipts['storage-getters']['vmSemanticControls'] *= 2
        with self.assertRaisesRegex(ValueError, 'duplicated'):
            self.module.join_scopes(inventory, receipts)
        inventory, receipts = fixture(self.module)
        receipts['storage-getters']['vmSemanticControls'] = []
        with self.assertRaisesRegex(ValueError, 'controls missing'):
            self.module.join_scopes(inventory, receipts)

    def test_storage_getter_files_and_declarations_are_hashed(self):
        with tempfile.TemporaryDirectory() as directory:
            outer = Path(directory).resolve()
            root = outer/'evidence'; kernel = root/'kernel'; kernel.mkdir(parents=True)
            artifact = b'Lemma getter_body : True. Proof. exact I. Qed.\n'
            model = b'Definition model := 0.\n'
            control = b'Lemma control_body : True.\n'
            (kernel/'StorageGetterArtifact.v').write_bytes(artifact)
            (kernel/'StorageGetter.v').write_bytes(model)
            (kernel/'Control.v').write_bytes(control)
            report = {'kernelDirectory': str(kernel),
                      'closedDeclarations': {'StorageGetterArtifact': ['getter_body'], 'StorageGetter': []},
                      'modelSha256': {'StorageGetter': self.module.sha(model)},
                      'semanticControls': [{'definitionsSha256': self.module.sha(control),
                                            'assertionSha256': self.module.sha(control)}],
                      'vmSemanticControls': [{'baselineSha256': self.module.sha(control),
                                              'definitionsSha256': self.module.sha(control)}]}
            self.module.validate_storage_getter_files(report, root)
            sibling = outer/'elsewhere'; sibling.mkdir()
            for field, value in (('kernelDirectory', str(sibling)),
                                 ('kernelDirectory', str(root/'absent')),
                                 ('closedDeclarations', {'Absent': []}),
                                 ('closedDeclarations', {'StorageGetterArtifact': ['other']}),
                                 ('modelSha256', {'StorageGetter': '0'*64}),
                                 ('semanticControls', [{'definitionsSha256': '0'*64}]),
                                 ('vmSemanticControls', [{'baselineSha256': '0'*64}])):
                forged = dict(report, **{field: value})
                with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, 'storage getter'):
                    self.module.validate_storage_getter_files(forged, root)

    def test_body_level_accounting_never_closes_an_entrypoint(self):
        inventory, receipts = fixture(self.module)
        coverage = self.module.entrypoint_coverage(inventory, receipts)
        self.assertEqual(coverage['total'], 4)
        self.assertEqual(coverage['fullyClosed'] + coverage['bodyLevelRefined']
                         + coverage['dispatchLevelOnly'], coverage['total'])
        self.assertEqual(coverage['fullyClosedEntrypoints'], [])
        self.assertEqual(coverage['referenceBodyEntrypoints'], ['pure'])
        self.assertEqual(coverage['dispatchBoundBodyEntrypoints'], ['getValue', 'isActive'])
        self.assertEqual(coverage['bodyLevelEntrypoints'], ['getValue', 'isActive', 'pure'])
        receipts['public']['referenceVerifiedEntrypoints'] = ['getValue']
        with self.assertRaisesRegex(ValueError, 'overlapping'):
            self.module.entrypoint_coverage(inventory, receipts)
        receipts['public']['referenceVerifiedEntrypoints'] = ['ghost']
        with self.assertRaisesRegex(ValueError, 'unknown ABI'):
            self.module.entrypoint_coverage(inventory, receipts)

    def test_selected_dependency_graph_covers_the_storage_getter_lane(self):
        paths = self.module.tool_paths()
        self.assertIn(HERE/'storage_getter_proofs.py', paths)
        self.assertIn(HERE/'storage_getter_source.py', paths)
        self.assertIn(HERE/'coq/StorageGetter.v', paths)
        self.assertIn(HERE/'coq/StorageGetterVm.v', paths)


if __name__ == '__main__': unittest.main()
