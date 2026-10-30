#!/usr/bin/env python3
"""Kernel certificates for the System.Contract.Call and CALLT admission layer.

Binds the record projected from the pinned C# to canonical_syscall, re-derives
the reviewed field constants for that record, and re-checks one semantic
mutant per pinned decision. No VM correspondence and no whole-engine claim.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
try:
    from . import syscall_dispatch_source as source
except ImportError:
    import syscall_dispatch_source as source
HERE = Path(__file__).resolve().parent
MODULE = 'SyscallDispatch'
EXPECTED_CONTROLS = source.EXPECTED_CONTROLS
PRECONDITIONS, UNPROVED, TCB = source.PRECONDITIONS, source.UNPROVED, source.TCB
require, sha, canonical = source.require, source.sha, source.canonical
PRELUDE = ('From Coq Require Import NArith PeanoNat List Bool Lia String Ascii.\n'
           'Require Import EntryDispatch.\nRequire Import SyscallDispatch.\n'
           'Import ListNotations.\nOpen Scope string_scope.\n'
           # list_scope has to be innermost: the model states stack equations
           # with the concatenation operator, and string_scope binds the same
           # token to string concatenation instead.
           'Open Scope list_scope.\n')

# The record's binder order, with the numeric suffix each field needs so that a
# rendered literal still has the field's declared type.
FIELDS = [('interop_flag_gate', ''), ('interop_required_flags', '%N'),
          ('interop_pop_count', ''), ('interop_flag_slot', ''),
          ('interop_pushes_result', ''), ('interop_handler_void', ''),
          ('interop_result', ''), ('call_rejects_underscore', ''),
          ('call_flag_range_gate', ''), ('call_all_flags', '%N'),
          ('call_derives_return', ''), ('call_marks_dynamic', ''),
          ('token_flag_gate', ''), ('token_required_flags', '%N'),
          ('token_pops', ''), ('token_marks_dynamic', '')]

def declarations(text):
    return re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',text,re.M)

def program_expression(program):
    require(set(program) == {name for name,_ in FIELDS}, 'Incomplete/extra projected program')
    rendered = []
    for name, suffix in FIELDS:
        value = program[name]
        if isinstance(value, bool):
            require(suffix == '', 'Boolean field with a numeric suffix: '+name)
            rendered.append('true' if value else 'false')
        else:
            require(type(value) is int and value >= 0, 'Unsupported field value: '+name)
            rendered.append(str(value)+suffix)
    return '(syscall_program '+' '.join(rendered)+')'

ACCEPT_PROBE = '(call_frame "probe" 2 15%N true true)'
ACCEPT_TOKEN = '(call_frame "probe" 2 15%N true false)'
PROBE_CALL = ('interop_admit {p} syscall_fixture_abi "probe" 2 {flags} true '
              'syscall_fixture_array syscall_fixture_stack')
TOKEN_CALL = 'token_admit {p} syscall_fixture_tokens 0 {flags} syscall_fixture_call_stack'

# One concrete instantiation per mutant, chosen so the mutant's outcome or
# handed-off value provably differs from the pinned behaviour. The expression
# is evaluated against `mutant_program` in both control files; `expected` is
# what the pinned program does with the same input.
CONTROL_CASES = {
 'drop-interop-flag-gate': (PROBE_CALL.format(p='mutant_program', flags='0%N'),
                            'Rejected RejectInteropFlags'),
 'weak-interop-required-flags': (PROBE_CALL.format(p='mutant_program', flags='4%N'),
                                 'Rejected RejectInteropFlags'),
 'drop-underscore-guard': ('interop_admit mutant_program '
                           '[descriptor "_probe" 2 101 true true] "_probe" 2 15%N true '
                           'syscall_fixture_array syscall_fixture_stack',
                           'Rejected RejectUnderscore'),
 'drop-flag-range-gate': ('interop_admit mutant_program syscall_fixture_abi "probe" 2 15%N true '
                          'syscall_fixture_array [11; 13; 19; 17; 15]',
                          'Rejected RejectFlagRange'),
 'narrow-call-flags': ('interop_admit mutant_program syscall_fixture_abi "probe" 2 15%N true '
                       'syscall_fixture_array [11; 13; 8; 17; 15]',
                       'Accepted (call_frame "probe" 2 8%N true true) [23; 29] [15]'),
 'drop-return-derivation': (PROBE_CALL.format(p='mutant_program', flags='15%N'),
                            'Accepted '+ACCEPT_PROBE+' [23; 29] [19]'),
 'drop-dynamic-marker': (PROBE_CALL.format(p='mutant_program', flags='15%N'),
                         'Accepted '+ACCEPT_PROBE+' [23; 29] [19]'),
 'shrink-interop-parameters': (PROBE_CALL.format(p='mutant_program', flags='15%N'),
                               'Accepted '+ACCEPT_PROBE+' [23; 29] [19]'),
 'reverse-interop-binding': (PROBE_CALL.format(p='mutant_program', flags='15%N'),
                             'Accepted '+ACCEPT_PROBE+' [23; 29] [19]'),
 'always-push-interop-result': (PROBE_CALL.format(p='mutant_program', flags='15%N'),
                                'Accepted '+ACCEPT_PROBE+' [23; 29] [19]'),
 'weak-token-required-flags': (TOKEN_CALL.format(p='mutant_program', flags='4%N'),
                               'Rejected RejectTokenFlags'),
 'reverse-token-pops': (TOKEN_CALL.format(p='mutant_program', flags='15%N'),
                        'Accepted '+ACCEPT_TOKEN+' [41; 43] [47]'),
 'mark-callt-dynamic': (TOKEN_CALL.format(p='mutant_program', flags='15%N'),
                        'Accepted '+ACCEPT_TOKEN+' [41; 43] [47]'),
}
require(set(CONTROL_CASES) == set(EXPECTED_CONTROLS), 'Control case inventory differs from the mutation set')

def render_certificate(projection):
    require(projection['entryBoundary'] == source.ENTRY_BOUNDARY, 'Unsupported entry boundary')
    lines = [PRELUDE,
     'Definition actual_program := '+program_expression(projection['program'])+'.',
     'Theorem actual_program_matches_reviewed_semantics : actual_program = canonical_syscall.\n'
     'Proof. reflexivity. Qed.',
     # These five are the correspondence claims proper: the numbers read out of
     # the C# must land on the reviewed constants, not merely be well typed.
     'Theorem actual_interop_required_flags :\n'
     '  sp_interop_required_flags actual_program = 5%N.\nProof. reflexivity. Qed.',
     'Theorem actual_token_required_flags :\n'
     '  sp_token_required_flags actual_program = 5%N.\nProof. reflexivity. Qed.',
     'Theorem actual_call_all_flags : sp_call_all_flags actual_program = 15%N.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_parameter_shape :\n'
     '  sp_interop_pop_count actual_program = 4 /\\ sp_interop_flag_slot actual_program = 2.\n'
     'Proof. split; reflexivity. Qed.',
     'Theorem actual_dynamic_markers :\n'
     '  sp_call_marks_dynamic actual_program = true /\\\n'
     '  sp_token_marks_dynamic actual_program = false.\nProof. split; reflexivity. Qed.',
     'Theorem actual_interop_accepts : forall abi name arity caller_flags array stack params leftover d,\n'
     '  flag_gate caller_flags (sp_interop_required_flags actual_program) = true ->\n'
     '  pop_window (sp_interop_pop_count actual_program) stack = Some (params, leftover) ->\n'
     '  negb (starts_underscore name) = true ->\n'
     '  flag_range (N.of_nat (nth (sp_interop_flag_slot actual_program) params 0))\n'
     '    (sp_call_all_flags actual_program) = true ->\n'
     '  abi_select abi name arity = Some d ->\n'
     '  interop_admit actual_program abi name arity caller_flags true array stack =\n'
     '    Accepted (call_frame name arity\n'
     '                (N.of_nat (nth (sp_interop_flag_slot actual_program) params 0))\n'
     '                (descriptor_nonvoid d)\n'
     '                (sp_call_marks_dynamic actual_program))\n'
     '             array (interop_leftover actual_program leftover).\n'
     'Proof. intros. eapply interop_accepts; eauto. Qed.',
     'Theorem actual_interop_rejects_underscore : forall abi name arity caller_flags contract_present array stack params leftover,\n'
     '  flag_gate caller_flags (sp_interop_required_flags actual_program) = true ->\n'
     '  pop_window (sp_interop_pop_count actual_program) stack = Some (params, leftover) ->\n'
     '  starts_underscore name = true ->\n'
     '  interop_admit actual_program abi name arity caller_flags contract_present array stack\n'
     '    = Rejected RejectUnderscore.\n'
     'Proof. intros. eapply interop_rejects_underscore; eauto. Qed.',
     'Theorem actual_token_accepts : forall tokens index caller_flags stack t args leftover,\n'
     '  flag_gate caller_flags (sp_token_required_flags actual_program) = true ->\n'
     '  nth_error tokens index = Some t ->\n'
     '  pop_window (token_arity t) stack = Some (args, leftover) ->\n'
     '  token_admit actual_program tokens index caller_flags stack =\n'
     '    Accepted (call_frame (token_method t) (token_arity t) (token_flags t)\n'
     '                (token_returns t) (sp_token_marks_dynamic actual_program))\n'
     '             (handoff_args actual_program args) leftover.\n'
     'Proof. intros. eapply token_accepts; eauto. Qed.',
     'Theorem actual_token_rejects_short_stack : forall tokens index caller_flags stack t,\n'
     '  flag_gate caller_flags (sp_token_required_flags actual_program) = true ->\n'
     '  nth_error tokens index = Some t ->\n'
     '  (List.length stack < token_arity t)%nat ->\n'
     '  token_admit actual_program tokens index caller_flags stack = Rejected RejectTokenStack.\n'
     'Proof. intros. eapply token_rejects_short_stack; eauto. Qed.',
     'Theorem actual_callt_window_reaches_the_entry_frame :\n'
     '  forall (args leftover stack : list nat),\n'
     '  pop_window (List.length args) stack = Some (args, leftover) ->\n'
     '  stack = args ++ leftover /\\\n'
     '  source_arguments canonical_program (handoff_args actual_program args) = args.\n'
     'Proof. intros. eapply callt_window_reaches_the_entry_frame; eauto. Qed.',
     ]
    text = '\n'.join(lines)+'\n'
    return text+'\n'.join('Print Assumptions '+n+'.' for n in declarations(text))+'\n'

def render_control_sources(name, mutant):
    expression, expected = CONTROL_CASES[name]
    return {
     'Definitions.v': PRELUDE+'Definition mutant_program := '+program_expression(mutant['program'])+'.\n',
     'OriginalBehavior.v': PRELUDE+'Require Import Definitions.\nExample original_behavior : '
                           +expression+' = '+expected+'.\nProof. vm_compute. reflexivity. Qed.\n',
     'Counterexample.v': PRELUDE+'Require Import Definitions.\nExample changed_behavior : '
                         +expression+' <> '+expected+'.\nProof. vm_compute. discriminate. Qed.\n'
                         'Print Assumptions changed_behavior.\n',
    }

CONTROL_PROOF_FILES = ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')
CONTROL_LOG_FILES = ('definitions.log', 'rejection.log', 'counterexample.log', 'counterexample-coqchk.log')

def run_command(command,directory,log,*,expect_rejection=False):
    try:
        result=subprocess.run(command,cwd=directory,text=True,capture_output=True,timeout=600)
    except subprocess.TimeoutExpired as error:
        Path(log).write_text(str(error));raise ValueError('Kernel command timed out') from error
    Path(log).write_text(result.stdout+result.stderr)
    require(result.returncode>0 if expect_rejection else result.returncode==0,
            'Unexpected kernel exit '+str(result.returncode)+': '+str(log))
    return result.returncode

def input_paths():
    return [HERE/'syscall_dispatch_source.py',HERE/'syscall_dispatch_proofs.py',
            HERE/'coq/SyscallDispatch.v',HERE/'coq/EntryDispatch.v']

def regenerate_certificate(report,evidence_dir):
    projection=source.project_captured(report['pinnedSource'])
    require((Path(evidence_dir)/'source-projection.json').read_bytes()==canonical(projection),
            'Source projection bytes differ from actual complete sources')
    require(report['sourceProjectionSha256']==sha(canonical(projection)),'Source projection hash mismatch')
    for field,value in [('preconditions',PRECONDITIONS),('unproved',UNPROVED),('tcb',TCB),
                        ('entryBoundary',source.ENTRY_BOUNDARY),('program',projection['program']),
                        ('handlerParameters',projection['handlerParameters']),
                        ('tokenFields',projection['tokenFields'])]:
        require(report.get(field)==value,'Changed syscall domain: '+field)
    require(report.get('coreSourceCommit')==source.CORE_COMMIT,'Wrong core source pin')
    require(report.get('neoVmSourceCommit')==source.VM_COMMIT,'Wrong vm source pin')
    require(report.get('modelSha256')=={'SyscallDispatch':sha((HERE/'coq/SyscallDispatch.v').read_bytes()),
                                       'EntryDispatch':sha((HERE/'coq/EntryDispatch.v').read_bytes())},
            'Wrong model inventory')
    expected_declarations={MODULE:declarations((HERE/'coq/SyscallDispatch.v').read_text()),
                           'SyscallDispatchArtifact':declarations(render_certificate(projection))}
    require(report.get('closedDeclarations')==expected_declarations,'Wrong declaration inventory')
    return render_certificate(projection).encode()

def regenerate_controls(report,evidence_dir):
    source.project_captured(report['pinnedSource'])
    contents={k:Path(v['path']).read_text() for k,v in report['pinnedSource'].items()}
    rows=report.get('semanticControls')
    require(isinstance(rows,list) and len(rows)==len(EXPECTED_CONTROLS),'Incomplete semantic controls')
    require([row.get('name') for row in rows]==list(EXPECTED_CONTROLS),'Wrong semantic control inventory')
    expected={};logs={};directory=Path(evidence_dir)
    for name,row in zip(EXPECTED_CONTROLS,rows):
        mutant,mutation_hash=source.mutated_projection(contents,name)
        require(row.get('sourceMutationSha256')==mutation_hash,'Changed source mutation: '+name)
        require(row.get('projectionSha256')==sha(canonical(mutant)),'Changed mutant projection: '+name)
        rendered=render_control_sources(name,mutant)
        for filename,text in rendered.items():
            data=text.encode()
            require((directory/name/filename).read_bytes()==data,'Changed control proof: '+name+'/'+filename)
            expected[name+'/'+filename]=sha(data)
        require(row.get('definitionsSha256')==expected[name+'/Definitions.v'],'Wrong definitions hash')
        require(row.get('counterexampleSha256')==expected[name+'/Counterexample.v'],'Wrong counterexample hash')
        for filename in CONTROL_LOG_FILES:
            logs[name+'/'+filename]=sha((directory/name/filename).read_bytes())
        require(row.get('rejectionLogSha256')==logs[name+'/rejection.log'],'Wrong rejection log hash')
    require(report.get('controlProofSha256')==expected,'Incomplete/changed control proof hash inventory')
    require(report.get('controlLogSha256')==logs,'Incomplete/changed control log hash inventory')
    return expected

def semantic_controls(rows,directory):
    contents={k:Path(v['path']).read_text() for k,v in rows.items()};reports=[];generated={};logs={}
    for name in EXPECTED_CONTROLS:
        mutant,source_hash=source.mutated_projection(contents,name)
        case=directory/name;case.mkdir()
        shutil.copy2(directory/'SyscallDispatch.vo',case/'SyscallDispatch.vo')
        shutil.copy2(directory/'EntryDispatch.vo',case/'EntryDispatch.vo')
        rendered=render_control_sources(name,mutant)
        for filename,text in rendered.items():(case/filename).write_text(text)
        definitions=rendered['Definitions.v'];counter=rendered['Counterexample.v']
        run_command(['coqc','-q','Definitions.v'],case,case/'definitions.log')
        rejection=run_command(['coqc','-q','OriginalBehavior.v'],case,case/'rejection.log',
                              expect_rejection=True)
        run_command(['coqc','-q','Counterexample.v'],case,case/'counterexample.log')
        run_command(['coqchk','-silent','Counterexample'],case,case/'counterexample-coqchk.log')
        require((case/'counterexample.log').read_text().count('Closed under the global context')==1,
                'Open semantic counterexample')
        reports.append(dict(name=name,definitionsCompiled=True,definitionLanguage='Coq source projection',
            certificateRejected=True,kernelExitCode=rejection,kernelCounterexampleChecked=True,timedOut=False,
            sourceMutationSha256=source_hash,projectionSha256=sha(canonical(mutant)),
            definitionsSha256=sha(definitions.encode()),counterexampleSha256=sha(counter.encode()),
            rejectionLogSha256=sha((case/'rejection.log').read_bytes())))
        for filename in CONTROL_PROOF_FILES:
            generated[name+'/'+filename]=sha((case/filename).read_bytes())
        for filename in CONTROL_LOG_FILES:
            logs[name+'/'+filename]=sha((case/filename).read_bytes())
    return reports,generated,logs

def run(output,report_path):
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    inputs={str(p.resolve()):sha(p.read_bytes()) for p in input_paths()}
    projection,rows=source.project_production(output/'source')
    (output/'source-projection.json').write_bytes(canonical(projection))
    model=(HERE/'coq/SyscallDispatch.v').read_bytes()
    require(not re.search(rb'\b(?:Admitted|Axiom|admit|Abort)\b',model),'Unclosed syscall model')
    require(b'Parameter' not in model,'Unexpected Parameter declaration in the syscall model')
    shutil.copy2(HERE/'coq/EntryDispatch.v',output/'EntryDispatch.v')
    (output/'SyscallDispatch.v').write_bytes(model)
    certificate=render_certificate(projection);(output/'SyscallDispatchArtifact.v').write_text(certificate)
    # EntryDispatch is a dependency of the model, so it is compiled in place to
    # keep one copy per control case.
    run_command(['coqc','-q','EntryDispatch.v'],output,output/'dependency.log')
    run_command(['coqc','-q','SyscallDispatch.v'],output,output/'model.log')
    run_command(['coqc','-q','SyscallDispatchArtifact.v'],output,output/'certificate.log')
    run_command(['coqchk','-silent','SyscallDispatchArtifact'],output,output/'coqchk.log')
    closed={MODULE:declarations(model.decode()),'SyscallDispatchArtifact':declarations(certificate)}
    for filename,names in [('model.log',closed[MODULE]),('certificate.log',closed['SyscallDispatchArtifact'])]:
        text=(output/filename).read_text()
        require(text.count('Closed under the global context')==len(names) and 'Axioms:' not in text,
                'Assumption inventory not closed')
    controls,generated,logs=semantic_controls(rows,output)
    for path,expected in inputs.items():
        require(sha(Path(path).read_bytes())==expected,'Tool/model changed during proof')
    require(source.project_captured(rows)==projection,'Source changed during proof')
    result=dict(schema='neoos-aa-syscall-dispatch-proof/v1',scope=source.SCOPE,
        entryBoundary=source.ENTRY_BOUNDARY,kernelChecked=True,coqchkChecked=True,assumptionsClosed=True,
        productionSourceBound=True,implementationVerified=False,fullImplementationVerified=False,
        sourceFrontendVerified=False,applicationEngineVerified=False,vmCorrespondenceProven=False,
        coreSourceCommit=source.CORE_COMMIT,neoVmSourceCommit=source.VM_COMMIT,pinnedSource=rows,
        program=projection['program'],handlerParameters=projection['handlerParameters'],
        tokenFields=projection['tokenFields'],
        sourceProjectionSha256=sha(canonical(projection)),
        certificateSha256=sha(certificate.encode()),
        modelSha256={'SyscallDispatch':sha(model),'EntryDispatch':sha((HERE/'coq/EntryDispatch.v').read_bytes())},
        inputSha256=inputs,closedDeclarations=closed,
        closedAssumptionCount=sum(map(len,closed.values())),
        kernelDeclarations=declarations(certificate),
        semanticControls=controls,controlProofSha256=generated,controlLogSha256=logs,
        preconditions=PRECONDITIONS,unproved=UNPROVED,tcb=TCB,outputDirectory=str(output.resolve()))
    require(regenerate_certificate(result,output)==certificate.encode(),'Regenerated certificate mismatch')
    regenerate_controls(result,output)
    Path(report_path).parent.mkdir(parents=True,exist_ok=True)
    Path(report_path).write_text(json.dumps(result,indent=2)+'\n');return result

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--json-report',type=Path,required=True)
    args=parser.parse_args(argv)
    failure=dict(schema='neoos-aa-syscall-dispatch-proof/v1',scope=source.SCOPE,status='FAIL',
                 kernelChecked=False,fullImplementationVerified=False)
    args.json_report.parent.mkdir(parents=True,exist_ok=True)
    args.json_report.write_text(json.dumps(failure)+'\n')
    try:run(args.output_dir,args.json_report);return 0
    except Exception as error:
        failure['error']=str(error);args.json_report.write_text(json.dumps(failure,indent=2)+'\n')
        print(str(error),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
