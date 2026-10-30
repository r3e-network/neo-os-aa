#!/usr/bin/env python3
"""Kernel certificates for the CallContractInternal handoff layer.

Binds the record projected from the pinned C# to canonical_handoff, re-derives
the reviewed field constants for that record, and re-checks one semantic mutant
per pinned decision. No VM correspondence and no callee execution claim.
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
    from . import contract_handoff_source as source
except ImportError:
    import contract_handoff_source as source
HERE = Path(__file__).resolve().parent
MODULE = 'ContractHandoff'
EXPECTED_CONTROLS = source.EXPECTED_CONTROLS
PRECONDITIONS, UNPROVED, TCB = source.PRECONDITIONS, source.UNPROVED, source.TCB
require, sha, canonical = source.require, source.sha, source.canonical
PRELUDE = ('From Coq Require Import NArith PeanoNat List Bool Lia.\n'
           'Require Import ContractHandoff.\nImport ListNotations.\n')

# The record's binder order, with the numeric suffix each field needs so that a
# rendered literal still has the field's declared type.
FIELDS = [('blocked_gate', ''), ('safe_mask_drops', '%N'),
          ('authorization_gate', ''), ('authorization_subject_is_caller', ''),
          ('increment_step', ''), ('caller_flag_intersection', ''),
          ('calling_context_set', ''), ('fee_from_whitelist', ''),
          ('whitelist_sets_flag', ''), ('push_reversed', ''),
          ('rvcount_from_return', ''), ('ip_from_method_offset', ''),
          ('contract_copied', ''), ('snapshot_cloned', ''),
          ('initializer_frame', ''), ('initializer_name_is_canonical', ''),
          ('initializer_pcount', ''), ('lookup_is_arity_keyed', '')]

def declarations(text):
    return re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',text,re.M)

# `1 == True` in Python, so a record whose boolean slot holds an integer would
# render as a numeric literal into a `bool` position and only fail much later.
# The three numeric fields are named here so every other field has to be a bool.
NUMERIC_FIELDS = frozenset(('safe_mask_drops', 'increment_step', 'initializer_pcount'))

def program_expression(program):
    require(set(program) == {name for name,_ in FIELDS}, 'Incomplete/extra projected program')
    rendered = []
    for name, suffix in FIELDS:
        value = program[name]
        if name in NUMERIC_FIELDS:
            require(type(value) is int and value >= 0, 'Unsupported field value: '+name)
            rendered.append(str(value)+suffix)
        else:
            require(suffix == '' and isinstance(value, bool), 'Unsupported field value: '+name)
            rendered.append('true' if value else 'false')
    return '(handoff_program '+' '.join(rendered)+')'

# Four call sites, each chosen so that the fields a control mutates are the ones
# its expression reads. Every field is spelled out: a partially applied record
# literal would let a later field default in silently.
PROBES = {
 # Open call: authorization passes, the caller narrows the word from 15 to 4.
 'probe_open': ('{| cs_requested_flags := 15%N; cs_caller_flags := 4%N; '
                'cs_method_safe := false; cs_return_void := false; cs_has_return := true; '
                'cs_method_offset := 7; cs_init_offset := 3; cs_init_present := true; '
                'cs_parameters := 2; cs_args := [11; 13]; cs_blocked := false; '
                'cs_authorized := true; cs_callee_authorizes_self := true; '
                'cs_whitelisted := true; cs_fixed_fee := 40; cs_counter := 0 |}'),
 # Safe method: the only probe on which the safe-method mask is observable, with
 # the caller word widened to 15 so the intersection cannot mask the difference.
 'probe_safe': ('{| cs_requested_flags := 15%N; cs_caller_flags := 15%N; '
                'cs_method_safe := true; cs_return_void := false; cs_has_return := true; '
                'cs_method_offset := 7; cs_init_offset := 3; cs_init_present := true; '
                'cs_parameters := 2; cs_args := [11; 13]; cs_blocked := false; '
                'cs_authorized := true; cs_callee_authorizes_self := false; '
                'cs_whitelisted := false; cs_fixed_fee := 0; cs_counter := 0 |}'),
 'probe_blocked': ('{| cs_requested_flags := 15%N; cs_caller_flags := 15%N; '
                   'cs_method_safe := false; cs_return_void := false; cs_has_return := true; '
                   'cs_method_offset := 7; cs_init_offset := 3; cs_init_present := true; '
                   'cs_parameters := 2; cs_args := [11; 13]; cs_blocked := true; '
                   'cs_authorized := true; cs_callee_authorizes_self := false; '
                   'cs_whitelisted := false; cs_fixed_fee := 0; cs_counter := 0 |}'),
 # The callee authorizes itself but the caller does not: this is the only probe
 # that separates the authorization subject from the answer.
 'probe_unauthorized': ('{| cs_requested_flags := 15%N; cs_caller_flags := 15%N; '
                        'cs_method_safe := false; cs_return_void := false; cs_has_return := true; '
                        'cs_method_offset := 7; cs_init_offset := 3; cs_init_present := true; '
                        'cs_parameters := 2; cs_args := [11; 13]; cs_blocked := false; '
                        'cs_authorized := false; cs_callee_authorizes_self := true; '
                        'cs_whitelisted := false; cs_fixed_fee := 0; cs_counter := 0 |}'),
}

def render_probes():
    return '\n'.join('Definition '+name+' : CallSite := '+text+'.' for name,text in PROBES.items())+'\n'

# One concrete observation per mutant. The expression reads only the field the
# mutant moves, and `expected` is what the pinned program yields on that same
# probe. Ordering controls observe the whole outcome, so their counterexamples
# are constructor mismatches rather than value mismatches.
CONTROL_CASES = {
 'drop-blocked-gate': ('handoff mutant_program probe_blocked', 'Rejected RejectBlocked 0'),
 'mask-nothing': ('fr_flags (frame_of mutant_program probe_safe)', '5%N'),
 'mask-read-states': ('fr_flags (frame_of mutant_program probe_safe)', '5%N'),
 'mask-everything': ('fr_flags (frame_of mutant_program probe_safe)', '5%N'),
 'drop-authorization-gate': ('handoff mutant_program probe_unauthorized',
                             'Rejected RejectUnauthorized 0'),
 'authorize-the-callee': ('handoff mutant_program probe_unauthorized',
                          'Rejected RejectUnauthorized 0'),
 'increment-twice': ('fr_counter (frame_of mutant_program probe_open)', '1'),
 'skip-increment': ('fr_counter (frame_of mutant_program probe_open)', '1'),
 'hand-off-raw-flags': ('fr_flags (frame_of mutant_program probe_open)', '4%N'),
 'drop-calling-context': ('fr_calling_context_set (frame_of mutant_program probe_open)', 'true'),
 'drop-whitelisted-fee': ('fr_fee (frame_of mutant_program probe_open)', '40'),
 'whitelist-keeps-flag-false': ('fr_whitelisted (frame_of mutant_program probe_open)', 'true'),
 'push-in-order': ('fr_stack (frame_of mutant_program probe_open)', '[13; 11]'),
 'swap-rvcount': ('fr_rvcount (frame_of mutant_program probe_open)', '1'),
 'zero-offset': ('fr_offset (frame_of mutant_program probe_open)', '7'),
 'share-the-contract': ('fr_contract_copied (frame_of mutant_program probe_open)', 'true'),
 'drop-initializer-frame': ('fr_initializer_frames (frame_of mutant_program probe_open)', '1'),
 'drop-snapshot-clone': ('fr_snapshot_cloned (frame_of mutant_program probe_open)', 'true'),
 'lookup-by-name-only': ('fr_initializer_frames (frame_of mutant_program probe_open)', '1'),
 'initializer-pcount-one': ('fr_initializer_frames (frame_of mutant_program probe_open)', '1'),
 'initializer-renamed': ('fr_initializer_frames (frame_of mutant_program probe_open)', '1'),
}
require(set(CONTROL_CASES) == set(EXPECTED_CONTROLS), 'Control case inventory differs from the mutation set')

def render_certificate(projection):
    require(projection['entryBoundary'] == source.ENTRY_BOUNDARY, 'Unsupported entry boundary')
    lines = [PRELUDE,
     'Definition actual_program := '+program_expression(projection['program'])+'.',
     'Theorem actual_program_matches_reviewed_semantics : actual_program = canonical_handoff.\n'
     'Proof. reflexivity. Qed.',
     # These are the correspondence claims proper: the values read out of the C#
     # must land on the reviewed constants, not merely be well typed.
     'Theorem actual_safe_mask_drops : hp_safe_mask_drops actual_program = 10%N.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_increment_step : hp_increment_step actual_program = 1.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_initializer_constants :\n'
     '  hp_initializer_pcount actual_program = 0 /\\\n'
     '  hp_initializer_name_is_canonical actual_program = true /\\\n'
     '  hp_lookup_is_arity_keyed actual_program = true.\n'
     'Proof. repeat split; reflexivity. Qed.',
     'Theorem actual_gates :\n'
     '  hp_blocked_gate actual_program = true /\\\n'
     '  hp_authorization_gate actual_program = true /\\\n'
     '  hp_authorization_subject_is_caller actual_program = true /\\\n'
     '  hp_fee_from_whitelist actual_program = true /\\\n'
     '  hp_whitelist_sets_flag actual_program = true /\\\n'
     '  hp_initializer_frame actual_program = true.\n'
     'Proof. repeat split; reflexivity. Qed.',
     'Theorem actual_frame_inputs :\n'
     '  hp_contract_copied actual_program = true /\\\n'
     '  hp_snapshot_cloned actual_program = true /\\\n'
     '  hp_calling_context_set actual_program = true.\n'
     'Proof. repeat split; reflexivity. Qed.',
     'Theorem actual_handoff_inputs :\n'
     '  hp_caller_flag_intersection actual_program = true /\\\n'
     '  hp_push_reversed actual_program = true /\\\n'
     '  hp_rvcount_from_return actual_program = true /\\\n'
     '  hp_ip_from_method_offset actual_program = true.\n'
     'Proof. repeat split; reflexivity. Qed.',
     # The rejection-order and acceptance theorems, instantiated at the record
     # the source produced rather than at the reviewed one.
     'Theorem actual_blocked_rejects : forall c,\n'
     '  cs_blocked c = true -> handoff actual_program c = Rejected RejectBlocked (cs_counter c).\n'
     'Proof. intros c H. apply blocked_rejects; [reflexivity | exact H]. Qed.',
     'Theorem actual_blocked_leaves_the_counter_alone : forall c,\n'
     '  cs_blocked c = true -> outcome_counter (handoff actual_program c) = cs_counter c.\n'
     'Proof. intros c H. apply blocked_counter_is_untouched; [reflexivity | exact H]. Qed.',
     'Theorem actual_unauthorized_rejects : forall c,\n'
     '  cs_method_safe c = false -> authorized actual_program c = false -> cs_blocked c = false ->\n'
     '  handoff actual_program c = Rejected RejectUnauthorized (cs_counter c).\n'
     'Proof.\n'
     '  intros c Hs Ha Hb. apply unauthorized_rejects; [exact Hb | exact Hs | reflexivity | exact Ha].\n'
     'Qed.',
     'Theorem actual_arity_rejects_after_the_increment : forall c,\n'
     '  cs_method_safe c = true -> cs_blocked c = false ->\n'
     '  Nat.eqb (length (cs_args c)) (cs_parameters c) = false ->\n'
     '  handoff actual_program c = Rejected RejectArity (cs_counter c + hp_increment_step actual_program).\n'
     'Proof. intros c Hs Hb Har. apply arity_rejection_after_the_increment; assumption. Qed.',
     'Theorem actual_return_mismatch_rejects_after_the_increment : forall c,\n'
     '  cs_method_safe c = true -> cs_blocked c = false ->\n'
     '  Nat.eqb (length (cs_args c)) (cs_parameters c) = true ->\n'
     '  Bool.eqb (cs_has_return c) (negb (cs_return_void c)) = false ->\n'
     '  outcome_counter (handoff actual_program c) =\n'
     '    cs_counter c + hp_increment_step actual_program.\n'
     'Proof. intros c Hs Hb Har Hret. apply return_rejection_after_the_increment; assumption. Qed.',
     'Theorem actual_accepts_when_the_guards_pass : forall c,\n'
     '  cs_blocked c = false -> Nat.eqb (length (cs_args c)) (cs_parameters c) = true ->\n'
     '  Bool.eqb (cs_has_return c) (negb (cs_return_void c)) = true ->\n'
     '  (cs_method_safe c = true \\/ authorized actual_program c = true) ->\n'
     '  handoff actual_program c = Accepted (frame_of actual_program c).\n'
     'Proof.\n'
     '  intros c Hb Har Hret Hopen. apply accepted_frame_records_the_call; try assumption.\n'
     '  destruct Hopen as [Hs | Ha].\n'
     '  - left; exact Hs.\n'
     '  - right. intros _. exact Ha.\n'
     'Qed.',
     # Frame-content claims at the projected record.
     'Theorem actual_flags_stay_inside_the_caller : forall c,\n'
     '  (fr_flags (frame_of actual_program c) <= cs_caller_flags c)%N.\n'
     'Proof. intros c. apply handed_flags_do_not_exceed_the_caller. reflexivity. Qed.',
     'Theorem actual_stack_is_the_reverse_of_the_arguments : forall c,\n'
     '  fr_stack (frame_of actual_program c) = rev (cs_args c).\n'
     'Proof. intros c. apply stack_is_the_reverse_of_the_argument_vector. reflexivity. Qed.',
     'Theorem actual_initializer_adds_one_frame : forall c,\n'
     '  cs_init_present c = true -> fr_initializer_frames (frame_of actual_program c) = 1.\n'
     'Proof.\n'
     '  intros c P. apply initializer_adds_one_frame; assumption || reflexivity.\n'
     'Qed.',
     'Theorem actual_whitelisted_fee_is_charged : forall c,\n'
     '  cs_whitelisted c = true -> fr_fee (frame_of actual_program c) = cs_fixed_fee c.\n'
     'Proof. intros c W. apply whitelisted_fee_is_charged; [exact W | reflexivity]. Qed.',
     'Theorem actual_offset_is_the_method_offset : forall c,\n'
     '  fr_offset (frame_of actual_program c) = cs_method_offset c.\n'
     'Proof. intros c. apply offset_is_the_method_offset. reflexivity. Qed.',
     'Theorem actual_rvcount_follows_the_return_type : forall c,\n'
     '  fr_rvcount (frame_of actual_program c) = (if cs_return_void c then 0 else 1).\n'
     'Proof. intros c. reflexivity. Qed.',
     ]
    text = '\n'.join(lines)+'\n'
    return text+'\n'.join('Print Assumptions '+n+'.' for n in declarations(text))+'\n'

def render_control_sources(name, mutant):
    expression, expected = CONTROL_CASES[name]
    header = PRELUDE+render_probes()
    return {
     'Definitions.v': header+'Definition mutant_program := '
                      +program_expression(mutant['program'])+'.\n',
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
    return [HERE/'contract_handoff_source.py',HERE/'contract_handoff_proofs.py',
            HERE/'coq/ContractHandoff.v']

def regenerate_certificate(report,evidence_dir):
    projection=source.project_captured(report['pinnedSource'])
    require((Path(evidence_dir)/'source-projection.json').read_bytes()==canonical(projection),
            'Source projection bytes differ from actual complete sources')
    require(report['sourceProjectionSha256']==sha(canonical(projection)),'Source projection hash mismatch')
    for field,value in [('preconditions',PRECONDITIONS),('unproved',UNPROVED),('tcb',TCB),
                        ('entryBoundary',source.ENTRY_BOUNDARY),('program',projection['program']),
                        ('reasonOnlyGuards',projection['reasonOnlyGuards'])]:
        require(report.get(field)==value,'Changed contract handoff domain: '+field)
    require(report.get('coreSourceCommit')==source.CORE_COMMIT,'Wrong core source pin')
    require(report.get('neoVmSourceCommit')==source.VM_COMMIT,'Wrong vm source pin')
    require(report.get('modelSha256')=={'ContractHandoff':sha((HERE/'coq/ContractHandoff.v').read_bytes())},
            'Wrong model inventory')
    expected_declarations={MODULE:declarations((HERE/'coq/ContractHandoff.v').read_text()),
                           'ContractHandoffArtifact':declarations(render_certificate(projection))}
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
        shutil.copy2(directory/'ContractHandoff.vo',case/'ContractHandoff.vo')
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
    model=(HERE/'coq/ContractHandoff.v').read_bytes()
    require(not re.search(rb'\b(?:Admitted|Axiom|admit|Abort)\b',model),'Unclosed contract handoff model')
    require(b'Parameter' not in model,'Unexpected Parameter declaration in the contract handoff model')
    (output/'ContractHandoff.v').write_bytes(model)
    certificate=render_certificate(projection);(output/'ContractHandoffArtifact.v').write_text(certificate)
    run_command(['coqc','-q','ContractHandoff.v'],output,output/'model.log')
    run_command(['coqc','-q','ContractHandoffArtifact.v'],output,output/'certificate.log')
    run_command(['coqchk','-silent','ContractHandoffArtifact'],output,output/'coqchk.log')
    closed={MODULE:declarations(model.decode()),'ContractHandoffArtifact':declarations(certificate)}
    for filename,names in [('model.log',closed[MODULE]),('certificate.log',closed['ContractHandoffArtifact'])]:
        text=(output/filename).read_text()
        require(text.count('Closed under the global context')==len(names) and 'Axioms:' not in text,
                'Assumption inventory not closed')
    controls,generated,logs=semantic_controls(rows,output)
    for path,expected in inputs.items():
        require(sha(Path(path).read_bytes())==expected,'Tool/model changed during proof')
    require(source.project_captured(rows)==projection,'Source changed during proof')
    result=dict(schema='neoos-aa-contract-handoff-proof/v1',scope=source.SCOPE,
        entryBoundary=source.ENTRY_BOUNDARY,kernelChecked=True,coqchkChecked=True,assumptionsClosed=True,
        productionSourceBound=True,implementationVerified=False,fullImplementationVerified=False,
        sourceFrontendVerified=False,applicationEngineVerified=False,vmCorrespondenceProven=False,
        coreSourceCommit=source.CORE_COMMIT,neoVmSourceCommit=source.VM_COMMIT,pinnedSource=rows,
        program=projection['program'],reasonOnlyGuards=projection['reasonOnlyGuards'],
        sourceProjectionSha256=sha(canonical(projection)),
        certificateSha256=sha(certificate.encode()),
        modelSha256={'ContractHandoff':sha(model)},
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
    failure=dict(schema='neoos-aa-contract-handoff-proof/v1',scope=source.SCOPE,status='FAIL',
                 kernelChecked=False,fullImplementationVerified=False)
    args.json_report.parent.mkdir(parents=True,exist_ok=True)
    args.json_report.write_text(json.dumps(failure)+'\n')
    try:run(args.output_dir,args.json_report);return 0
    except Exception as error:
        failure['error']=str(error);args.json_report.write_text(json.dumps(failure,indent=2)+'\n')
        print(str(error),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
