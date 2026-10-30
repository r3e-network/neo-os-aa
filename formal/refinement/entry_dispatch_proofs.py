#!/usr/bin/env python3
"""Kernel certificates for the bounded ordinary post-interop entry projection."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
try:
    from . import entry_dispatch_source as source, public_pure_proofs, nef_decode
except ImportError:
    import entry_dispatch_source as source, public_pure_proofs, nef_decode
HERE = Path(__file__).resolve().parent
MODULE = 'EntryDispatch'
EXPECTED_CONTROLS = source.EXPECTED_CONTROLS
PRECONDITIONS, UNPROVED, TCB = source.PRECONDITIONS, source.UNPROVED, source.TCB
require, sha, canonical = source.require, source.sha, source.canonical
PRELUDE = 'From Coq Require Import NArith PeanoNat List Bool Lia String Ascii.\nRequire Import EntryDispatch.\nImport ListNotations.\nOpen Scope string_scope.\n'


def declarations(text):
    return re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',text,re.M)


def bind_inventory(inventory):
    bound = public_pure_proofs.bind_methods(inventory)
    manifest = inventory['manifest']['methods']; script=bytes.fromhex(inventory['nef']['scriptHex'])
    offsets={i['offset'] for i in inventory['nef']['instructions']};keys=set()
    for abi in manifest:
        require(isinstance(abi['name'],str) and abi['name'] and type(abi['safe']) is bool,'Invalid ABI descriptor')
        require(type(abi['offset']) is int and abi['offset'] in offsets,'ABI offset not an instruction boundary')
        require(isinstance(abi['parameters'],list) and len(abi['parameters'])<=65535,'Invalid ABI arity')
        key=(abi['name'],len(abi['parameters']));require(key not in keys,'Duplicate ABI lookup key');keys.add(key)
    init=[a for a in manifest if a['name']=='_initialize' and len(a['parameters'])==0]
    require(len(init)==1 and init[0]['returntype']=='Void','Missing/invalid initializer ABI')
    start=init[0]['offset'];region=[x for x in inventory['nef']['instructions'] if x['offset']>=start]
    require(region and region[-1]['opcode']==64 and region[-1]['offset']+region[-1]['size']==len(script),'Incomplete initializer range')
    entries={n:dict(abi=m['abi'],methodRange=[m['start'],m['end']],methodSha256=m['methodSha256'],instructionCount=m['instructionCount']) for n,m in bound['methods'].items()}
    require(set(entries)=={'getAccountImplementationId','supportsExecutionMode','supportsModuleType'},'Wrong public entry subset')
    # Dispatch-level certificates cover every manifest descriptor; only the
    # three entries above carry a body-level reference refinement today.
    dispatch=[dict(name=a['name'],arity=len(a['parameters']),safe=a['safe'],
                   nonvoid=a['returntype']!='Void',offset=a['offset']) for a in manifest]
    return dict(nefSha256=bound['nefSha256'],scriptSha256=bound['scriptSha256'],manifestSha256=inventory['manifest']['sha256'],
        manifest=manifest,entries=entries,dispatchBoundEntrypoints=dispatch,initializer=dict(abi=init[0],methodRange=[start,len(script)],methodSha256=sha(script[start:]),instructionCount=len(region)),
        fullUnprovedEntrypointCount=len(manifest),referenceVerifiedEntrypoints=sorted(entries))


def coq_string(value):
    require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',value) is not None,'Unsupported ABI name encoding')
    return '"'+value+'"'


def descriptor(abi):
    return '(descriptor '+coq_string(abi['name'])+' '+str(len(abi['parameters']))+' '+str(abi['offset'])+' '+str(abi['safe']).lower()+' '+str(abi['returntype']!='Void').lower()+')'


def program_expression(program):
    require(set(program)==set(source.BASE_PROGRAM),'Incomplete/extra source program')
    fields=list(source.BASE_PROGRAM)
    for name,value in program.items():require(type(value) is type(source.BASE_PROGRAM[name]) and (type(value) is bool or value>=0),'Invalid source program field')
    return '(dispatch_program '+' '.join(str(program[k]).lower()+('%N' if k in {'allowed_flags','safe_clear_mask'} else '') for k in fields)+')'


def render_certificate(bound,projection):
    require(projection['entryBoundary']==source.ENTRY_BOUNDARY,'Unsupported entry boundary')
    lines=[PRELUDE,'Definition actual_program := '+program_expression(projection['program'])+'.',
      'Definition actual_manifest : list Descriptor := ['+';'.join(descriptor(a) for a in bound['manifest'])+'].',
      'Definition actual_initializer : option nat := Some '+str(bound['initializer']['abi']['offset'])+'.',
      'Theorem actual_initializer_lookup : actual_initializer = option_map descriptor_offset (abi_select actual_manifest "_initialize" 0).\nProof. vm_compute. reflexivity. Qed.',
      'Theorem actual_program_matches_reviewed_semantics : actual_program = canonical_program.\nProof. reflexivity. Qed.',
      'Theorem actual_source_frame_semantics : forall env abi name d args requested caller tail ids init,\n'
      ' projection_ready env d tail init ->\n'
      ' init = option_map descriptor_offset (abi_select abi "_initialize" 0) -> fresh_dispatch_ids ids caller tail ->\n'
      ' descriptor_safe d = true -> descriptor_nonvoid d = true -> starts_underscore name = false ->\n'
      ' valid_flags requested -> valid_flags (frame_flags caller) -> (List.length args <= 65535)%nat ->\n'
      ' abi_select abi name (List.length args) = Some d ->\n'
      ' source_call actual_program abi name args requested caller tail ids init = Some (spec_success d args requested caller tail ids init).\n'
      'Proof. intros. eapply source_bound_safe_call_frame_refines_spec; eauto using actual_program_matches_reviewed_semantics. Qed.']
    seen_names={}
    for abi in sorted(bound['manifest'],key=lambda a:a['offset']):
        seen_names[abi['name']]=seen_names.get(abi['name'],0)+1
    def entry_identifier(name,arity):
        # Only duplicate ABI names need an arity suffix to stay unique.
        return name if seen_names[name]==1 else name+'_'+str(arity)
    rendered_names=set()
    for abi in sorted(bound['manifest'],key=lambda a:a['offset']):
        name=abi['name'];arity=len(abi['parameters']);ident=entry_identifier(name,arity)
        require(ident not in rendered_names,'Duplicate certificate identifier: '+ident)
        rendered_names.add(ident)
        d=ident+'_descriptor'
        lines += ['Definition '+d+' := '+descriptor(abi)+'.',
         'Theorem '+ident+'_actual_abi_lookup : abi_select actual_manifest '+coq_string(name)+' '+str(arity)+' = Some '+d+'.\nProof. vm_compute. reflexivity. Qed.']
        if abi['safe'] and abi['returntype']!='Void':
            lines += ['Theorem '+ident+'_actual_entry_frame : forall env args requested caller tail ids,\n'
             ' projection_ready env '+d+' tail actual_initializer -> fresh_dispatch_ids ids caller tail ->\n'
             ' valid_flags requested -> valid_flags (frame_flags caller) -> List.length args = '+str(arity)+' ->\n'
             ' source_call actual_program actual_manifest '+coq_string(name)+' args requested caller tail ids actual_initializer =\n'
             ' Some (spec_success '+d+' args requested caller tail ids actual_initializer).\n'
             'Proof. intros env args requested caller tail ids Hr Hfresh Hflags Hcaller Hlen.\n'
             ' eapply actual_source_frame_semantics.\n'
             ' - exact Hr.\n - exact actual_initializer_lookup.\n - exact Hfresh.\n'
             ' - reflexivity.\n - reflexivity.\n - reflexivity.\n - exact Hflags.\n - exact Hcaller.\n'
             ' - rewrite Hlen. apply Nat.leb_le. vm_compute. reflexivity.\n - rewrite Hlen. exact '+ident+'_actual_abi_lookup. Qed.']
    text='\n'.join(lines)+'\n'
    return text+'\n'.join('Print Assumptions '+n+'.' for n in declarations(text))+'\n'


def run_command(command,directory,log,*,expect_rejection=False):
    try:
        result=subprocess.run(command,cwd=directory,text=True,capture_output=True,timeout=600)
    except subprocess.TimeoutExpired as error:
        Path(log).write_text(str(error));raise ValueError('Kernel command timed out') from error
    Path(log).write_text(result.stdout+result.stderr)
    require(result.returncode>0 if expect_rejection else result.returncode==0,'Unexpected kernel exit '+str(result.returncode)+': '+str(log))
    return result.returncode


def input_paths():
    return [HERE/'entry_dispatch_source.py',HERE/'entry_dispatch_proofs.py',HERE/'coq/EntryDispatch.v',
            HERE/'public_pure_proofs.py',HERE/'public_source.py',HERE/'method_source.py',HERE/'verify.py',HERE/'nef_decode.py']


def control_expression(name):
    if name=='drop-underscore-guard':
        return 'source_call mutant_program [descriptor "_probe" 2 101 true true; descriptor "_initialize" 0 109 false false] "_probe" dispatch_fixture_args 15%N dispatch_fixture_caller [] dispatch_fixture_ids (Some 109)', 'None'
    return ('source_call mutant_program [dispatch_fixture_descriptor; descriptor "_initialize" 0 109 false false] "probe" dispatch_fixture_args 15%N dispatch_fixture_caller [] dispatch_fixture_ids (Some 109)',
            'Some (spec_success dispatch_fixture_descriptor dispatch_fixture_args 15%N dispatch_fixture_caller [] dispatch_fixture_ids (Some 109))')


CONTROL_PROOF_FILES = ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')
CONTROL_LOG_FILES = ('definitions.log', 'rejection.log', 'counterexample.log', 'counterexample-coqchk.log')


def render_control_sources(name, mutant):
    lhs, rhs = control_expression(name)
    return {
        'Definitions.v': PRELUDE+'Definition mutant_program := '+program_expression(mutant['program'])+'.\n',
        'OriginalBehavior.v': PRELUDE+'Require Import Definitions.\nExample original_behavior : '+lhs+' = '+rhs+'.\nProof. vm_compute. reflexivity. Qed.\n',
        'Counterexample.v': PRELUDE+'Require Import Definitions.\nExample changed_behavior : '+lhs+' <> '+rhs+'.\nProof. vm_compute. discriminate. Qed.\nPrint Assumptions changed_behavior.\n',
    }


def regenerate_controls(report, evidence_dir):
    # Re-derive mutations from the same complete pinned C# input, then compare
    # every Coq source and each preserved kernel log by its exact filename.
    source.project_captured(report['pinnedSource'])
    contents={k:Path(v['path']).read_text() for k,v in report['pinnedSource'].items()}
    rows=report.get('semanticControls')
    require(isinstance(rows,list) and len(rows)==len(EXPECTED_CONTROLS), 'Incomplete semantic controls')
    require([row.get('name') for row in rows]==list(EXPECTED_CONTROLS), 'Wrong semantic control inventory')
    expected={};logs={};directory=Path(evidence_dir)
    for name,row in zip(EXPECTED_CONTROLS,rows):
        mutant,mutation_hash=source.mutated_projection(contents,name)
        require(row.get('sourceMutationSha256')==mutation_hash, 'Changed source mutation: '+name)
        require(row.get('projectionSha256')==sha(canonical(mutant)), 'Changed mutant projection: '+name)
        sources=render_control_sources(name,mutant)
        for filename,text in sources.items():
            data=text.encode();require((directory/name/filename).read_bytes()==data, 'Changed control proof: '+name+'/'+filename)
            expected[name+'/'+filename]=sha(data)
        require(row.get('definitionsSha256')==expected[name+'/Definitions.v'], 'Wrong definitions hash')
        require(row.get('counterexampleSha256')==expected[name+'/Counterexample.v'], 'Wrong counterexample hash')
        for filename in CONTROL_LOG_FILES:
            logs[name+'/'+filename]=sha((directory/name/filename).read_bytes())
        require(row.get('rejectionLogSha256')==logs[name+'/rejection.log'], 'Wrong rejection log hash')
    require(report.get('controlProofSha256')==expected, 'Incomplete/changed control proof hash inventory')
    require(report.get('controlLogSha256')==logs, 'Incomplete/changed control log hash inventory')
    return expected


def semantic_controls(projection,rows,directory):
    contents={k:Path(v['path']).read_text() for k,v in rows.items()};reports=[];generated={};logs={}
    for name in EXPECTED_CONTROLS:
        mutant,source_hash=source.mutated_projection(contents,name);case=directory/name;case.mkdir()
        shutil.copy2(directory/'EntryDispatch.vo',case/'EntryDispatch.vo')
        rendered=render_control_sources(name,mutant)
        for filename,body in rendered.items():(case/filename).write_text(body)
        definitions=rendered['Definitions.v'];counter=rendered['Counterexample.v']
        run_command(['coqc','-q','Definitions.v'],case,case/'definitions.log')
        rejection=run_command(['coqc','-q','OriginalBehavior.v'],case,case/'rejection.log',expect_rejection=True)
        run_command(['coqc','-q','Counterexample.v'],case,case/'counterexample.log')
        run_command(['coqchk','-silent','Counterexample'],case,case/'counterexample-coqchk.log')
        require((case/'counterexample.log').read_text().count('Closed under the global context')==1,'Open semantic counterexample')
        reports.append(dict(name=name,definitionsCompiled=True,definitionLanguage='Coq source projection',certificateRejected=True,
            kernelExitCode=rejection,kernelCounterexampleChecked=True,timedOut=False,sourceMutationSha256=source_hash,
            projectionSha256=sha(canonical(mutant)),definitionsSha256=sha(definitions.encode()),counterexampleSha256=sha(counter.encode()),
            rejectionLogSha256=sha((case/'rejection.log').read_bytes())))
        for filename in CONTROL_PROOF_FILES:
            generated[name+'/'+filename]=sha((case/filename).read_bytes())
        for filename in CONTROL_LOG_FILES:
            logs[name+'/'+filename]=sha((case/filename).read_bytes())
    return reports,generated,logs


def regenerate_certificate(inventory,report,evidence_dir):
    projection=source.project_captured(report['pinnedSource']);bound=bind_inventory(inventory)
    require((Path(evidence_dir)/'source-projection.json').read_bytes()==canonical(projection),'Source projection bytes differ from actual complete sources')
    require(report['sourceProjectionSha256']==sha(canonical(projection)),'Source projection hash mismatch')
    for field in ['nefSha256','scriptSha256','manifestSha256','entries','dispatchBoundEntrypoints','initializer','referenceVerifiedEntrypoints','fullUnprovedEntrypointCount']:
        require(report.get(field)==bound[field],'Dispatch artifact join differs: '+field)
    for field,value in [('preconditions',PRECONDITIONS),('unproved',UNPROVED),('tcb',TCB),('entryBoundary',source.ENTRY_BOUNDARY)]:
        require(report.get(field)==value,'Changed dispatch domain: '+field)
    require(report.get('coreSourceCommit')==source.CORE_COMMIT and report.get('neoVmSourceCommit')==source.VM_COMMIT,'Wrong ordinary source pins')
    require(report.get('modelSha256')=={'EntryDispatch':sha((HERE/'coq/EntryDispatch.v').read_bytes())},'Wrong model inventory')
    expected_declarations={MODULE:declarations((HERE/'coq/EntryDispatch.v').read_text()),'EntryDispatchArtifact':declarations(render_certificate(bound,projection))}
    require(report.get('closedDeclarations')==expected_declarations,'Wrong declaration inventory')
    return render_certificate(bound,projection).encode()


def run(inventory_path,output,report_path):
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    raw=Path(inventory_path).read_bytes();inventory=json.loads(raw);bound=bind_inventory(inventory)
    inputs={str(p.resolve()):sha(p.read_bytes()) for p in input_paths()}
    projection,rows=source.project_production(output/'source')
    (output/'source-projection.json').write_bytes(canonical(projection))
    model=(HERE/'coq/EntryDispatch.v').read_bytes();require(not re.search(rb'\b(?:Admitted|Axiom|admit)\b',model),'Unclosed dispatch model')
    (output/'EntryDispatch.v').write_bytes(model)
    certificate=render_certificate(bound,projection);(output/'EntryDispatchArtifact.v').write_text(certificate)
    run_command(['coqc','-q','EntryDispatch.v'],output,output/'model.log')
    run_command(['coqc','-q','EntryDispatchArtifact.v'],output,output/'certificate.log')
    run_command(['coqchk','-silent','EntryDispatchArtifact'],output,output/'coqchk.log')
    closed={MODULE:declarations(model.decode()),'EntryDispatchArtifact':declarations(certificate)}
    for filename,names in [('model.log',closed[MODULE]),('certificate.log',closed['EntryDispatchArtifact'])]:
        text=(output/filename).read_text();require(text.count('Closed under the global context')==len(names) and 'Axioms:' not in text,'Assumption inventory not closed')
    controls,generated,logs=semantic_controls(projection,rows,output)
    require(sha(Path(inventory_path).read_bytes())==sha(raw),'Inventory changed during proof')
    for path,expected in inputs.items():require(sha(Path(path).read_bytes())==expected,'Tool/model changed during proof')
    require(source.project_captured(rows)==projection,'Source changed during proof')
    result=dict(schema='neoos-aa-entry-dispatch-proof/v1',scope=source.SCOPE,entryBoundary=source.ENTRY_BOUNDARY,
        kernelChecked=True,coqchkChecked=True,assumptionsClosed=True,productionSourceBound=True,
        implementationVerified=False,fullImplementationVerified=False,sourceFrontendVerified=False,applicationEngineVerified=False,vmCorrespondenceProven=False,
        coreSourceCommit=source.CORE_COMMIT,neoVmSourceCommit=source.VM_COMMIT,pinnedSource=rows,
        **{k:v for k,v in bound.items() if k!='manifest'},inventorySha256=sha(raw),sourceProjectionSha256=sha(canonical(projection)),
        certificateSha256=sha(certificate.encode()),modelSha256={MODULE:sha(model)},inputSha256=inputs,
        closedDeclarations=closed,closedAssumptionCount=sum(map(len,closed.values())),kernelDeclarations=declarations(certificate),
        semanticControls=controls,controlProofSha256=generated,controlLogSha256=logs,preconditions=PRECONDITIONS,unproved=UNPROVED,tcb=TCB,
        outputDirectory=str(output.resolve()))
    require(regenerate_certificate(inventory,result,output)==certificate.encode(),'Regenerated certificate mismatch')
    regenerate_controls(result,output)
    Path(report_path).write_text(json.dumps(result,indent=2)+'\n');return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory',type=Path,required=True);parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--json-report',type=Path,required=True);parser.add_argument('--controls',action='store_true',help='Controls are always required.')
    args=parser.parse_args(argv);args.json_report.parent.mkdir(parents=True,exist_ok=True)
    failure=dict(schema='neoos-aa-entry-dispatch-proof/v1',scope=source.SCOPE,status='FAIL',kernelChecked=False,fullImplementationVerified=False)
    args.json_report.write_text(json.dumps(failure)+'\n')
    try:run(args.inventory,args.output_dir,args.json_report);return 0
    except Exception as error:
        failure['error']=str(error);args.json_report.write_text(json.dumps(failure,indent=2)+'\n');print(str(error),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
