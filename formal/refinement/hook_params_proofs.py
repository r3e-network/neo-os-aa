#!/usr/bin/env python3
"""Exact private hook-tuple helper source/heap reference refinement."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
try:
    from . import hook_params_source, nef_decode
except ImportError:
    import hook_params_source, nef_decode

ROOT = Path(__file__).resolve().parent
MODULES = ('IntegerSemantics','CapArithmetic','CapMethodVm','HookParams')


def require(ok, message):
    if not ok: raise ValueError(message)


def sha(raw): return hashlib.sha256(raw).hexdigest()


def bind_method(inventory):
    snapshots = {name:Path(name).read_bytes() for name in inventory['inputs']}
    require(all(sha(snapshots[name]) == expected for name,expected in inventory['inputs'].items()), 'Inventory input drift')
    nef_names = [n for n,h in inventory['inputs'].items() if n.endswith('SmartAccountV3.nef') and h == inventory['nef']['sha256']]
    manifest_names = [n for n,h in inventory['inputs'].items() if n.endswith('SmartAccountV3.manifest.json') and h == inventory['manifest']['sha256']]
    require(len(nef_names) == len(manifest_names) == 1, 'Ambiguous artifact inputs')
    raw = snapshots[nef_names[0]]
    require(sha(raw) == inventory['nef']['sha256'], 'Actual NEF container identity mismatch')
    spec = importlib.util.spec_from_file_location('hook_nef_binding', ROOT/'verify.py')
    gate = importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
    decoded = gate.decode_nef(raw); script = decoded['script']
    require(script.hex() == inventory['nef']['scriptHex'] and sha(script) == inventory['nef']['scriptSha256'], 'Actual script differs')
    require(json.loads(snapshots[manifest_names[0]])['abi']['methods'] == inventory['manifest']['methods'], 'Actual manifest differs')
    instructions = nef_decode.decode_script(script,len(decoded['tokens']))
    require(len(instructions)==len(inventory['nef']['instructions']) and
            all(all(record.get(k)==v for k,v in actual.items()) for actual,record in zip(instructions,inventory['nef']['instructions'])),
            'Actual decoded instructions differ')
    require(inventory['sourceMap']['exactByteMatch'] is True and inventory['sourceMap']['exactManifestMatch'] is True,
            'Source rebuild correspondence unavailable')
    projection = hook_params_source.project_method(inventory)
    matches = [m for m in inventory['sourceMap']['debug']['methods'] if m['id'] == projection['displayName']]
    require(len(matches)==1 and 'abi' not in matches[0], 'Private helper source/debug binding mismatch')
    start,last=map(int,matches[0]['range'].split('-'));end=last+1
    region=[i for i in instructions if start<=i['offset']<end]
    require(region and region[0]['offset']==start and region[-1]['offset']+region[-1]['size']==end and region[-1]['opcode']==64,
            'Complete helper boundary unavailable')
    require(all(i['opcode'] in {16,17,19,20,21,22,34,64,87,120,121,192,206} for i in region),
            'Unsupported helper opcode or effect dependency')
    return dict(start=start,end=end,bytes=list(script[start:end]),instructionCount=len(region),
                methodSha256=sha(script[start:end]),nefSha256=sha(raw),scriptSha256=sha(script),projection=projection)


NORMALIZE = r'''Ltac hook_norm := cbv [hook_observe hook_expected hook_tuple hook_vm_initial hook_source_initial
 decode vm_step eval_expr eval_args run_source bind allocate read_field with_stack change with_heap
 pc stack arguments locals heap storage effects statics object_kind fields jump_target signed_byte
 firstn skipn nth_error length app repeat Nat.add Nat.sub Nat.mul Nat.eqb Nat.leb Nat.ltb
 andb orb negb Z.leb Z.ltb Z.compare Pos.compare Pos.compare_cont].
Ltac hook_drive := repeat first [progress hook_norm
 | multimatch goal with H : ?lhs = ?rhs |- _ => progress (fold (@nth_error Object); rewrite H) end
 | match goal with |- context[checked_integer ?z] => let value := eval vm_compute in (checked_integer z) in progress change (checked_integer z) with value end
 | match goal with |- context[Z.to_nat ?z] => let n := eval vm_compute in (Z.to_nat z) in progress change (Z.to_nat z) with n end
 | rewrite run_vm_one_step].
'''


def render_certificate(bound, projection=None):
    source = projection or bound['projection']
    code='['+';'.join(str(b)+'%nat' for b in bound['bytes'])+']'
    expression=hook_params_source.render_expr(source['expression'])
    return (r'''From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics CapArithmetic CapMethodVm HookParams.
Import ListNotations. Open Scope Z_scope.
'''+NORMALIZE+f'Definition hook_code := {code}.\nDefinition hook_source := [SReturn {expression}].\n'+r'''
Theorem source_hook_complete : forall objects operation_ref kind target method unused nonce deadline signature tail args stored static_values,
 nth_error objects operation_ref = Some (obj kind ([target;method;unused;nonce;deadline;signature] ++ tail)) ->
 run_source 2 hook_source (hook_source_initial (VRef operation_ref) args objects stored static_values) =
 Halt (VRef (length objects))
 (state 0 [] [VRef operation_ref;args] []
 (objects ++ [hook_tuple target method args nonce deadline signature]) stored [] static_values).
Proof. intros. unfold hook_source. hook_drive. reflexivity. Qed.
Print Assumptions source_hook_complete.
Theorem vm_hook_complete : forall objects operation_ref kind target method unused nonce deadline signature tail args stored static_values,
 nth_error objects operation_ref = Some (obj kind ([target;method;unused;nonce;deadline;signature] ++ tail)) ->
 run_vm 24 hook_code (hook_vm_initial (VRef operation_ref) args objects stored static_values) =
 Halt (VRef (length objects))
 (state 24 [] [VRef operation_ref;args] []
 (objects ++ [hook_tuple target method args nonce deadline signature]) stored [] static_values).
Proof. intros. unfold hook_code. hook_drive. reflexivity. Qed.
Print Assumptions vm_hook_complete.
Theorem complete_hook_reference_refinement : forall objects operation_ref kind target method unused nonce deadline signature tail args stored static_values,
 nth_error objects operation_ref = Some (obj kind ([target;method;unused;nonce;deadline;signature] ++ tail)) ->
 hook_observe (run_vm 24 hook_code (hook_vm_initial (VRef operation_ref) args objects stored static_values)) =
 hook_observe (run_source 2 hook_source (hook_source_initial (VRef operation_ref) args objects stored static_values)).
Proof. intros. rewrite (vm_hook_complete objects operation_ref kind target method unused nonce deadline signature tail args stored static_values H). rewrite (source_hook_complete objects operation_ref kind target method unused nonce deadline signature tail args stored static_values H). reflexivity. Qed.
Print Assumptions complete_hook_reference_refinement.
Theorem hook_existing_heap_and_frame : forall objects operation_ref kind target method unused nonce deadline signature tail args stored static_values,
 nth_error objects operation_ref = Some (obj kind ([target;method;unused;nonce;deadline;signature] ++ tail)) ->
 exists after, run_vm 24 hook_code (hook_vm_initial (VRef operation_ref) args objects stored static_values) = Halt (VRef (length objects)) after /\
 heap after = objects ++ [hook_tuple target method args nonce deadline signature] /\
 storage after = stored /\ effects after = [] /\ statics after = static_values /\
 stack after = [] /\ locals after = [] /\ arguments after = [VRef operation_ref;args].
Proof. intros. rewrite (vm_hook_complete objects operation_ref kind target method unused nonce deadline signature tail args stored static_values H). eexists. repeat split; reflexivity. Qed.
Print Assumptions hook_existing_heap_and_frame.
Theorem hook_null_operation_fault : forall args objects stored static_values,
 hook_observe (run_vm 24 hook_code (hook_vm_initial VNull args objects stored static_values)) = HookFaulted objects stored [] /\
 hook_observe (run_source 2 hook_source (hook_source_initial VNull args objects stored static_values)) = HookFaulted objects stored [].
Proof. intros. unfold hook_code,hook_source. hook_drive. split; reflexivity. Qed.
Print Assumptions hook_null_operation_fault.
Theorem hook_missing_arguments_fault : forall objects stored static_values,
 run_vm 24 hook_code (state 0 [] [] [] objects stored [] static_values) = Fault (state 0 [] [] [] objects stored [] static_values).
Proof. intros. unfold hook_code. rewrite run_vm_one_step. hook_norm. reflexivity. Qed.
Print Assumptions hook_missing_arguments_fault.
Theorem hook_short_record_fault : forall objects operation_ref kind record args stored static_values,
 (length record < 6)%nat -> nth_error objects operation_ref = Some (obj kind record) ->
 hook_observe (run_vm 24 hook_code (hook_vm_initial (VRef operation_ref) args objects stored static_values)) = HookFaulted objects stored [] /\
 hook_observe (run_source 2 hook_source (hook_source_initial (VRef operation_ref) args objects stored static_values)) = HookFaulted objects stored [].
Proof. intros objects operation_ref kind record args stored static_values Small Bound.
 destruct record as [|a [|b [|c [|d [|e [|f tail]]]]]]; simpl in Small; try lia;
 unfold hook_code,hook_source; hook_drive; split; reflexivity. Qed.
Print Assumptions hook_short_record_fault.
Theorem hook_dangling_operation_fault : forall objects operation_ref args stored static_values,
 nth_error objects operation_ref = None ->
 hook_observe (run_vm 24 hook_code (hook_vm_initial (VRef operation_ref) args objects stored static_values)) = HookFaulted objects stored [] /\
 hook_observe (run_source 2 hook_source (hook_source_initial (VRef operation_ref) args objects stored static_values)) = HookFaulted objects stored [].
Proof. intros. unfold hook_code,hook_source. hook_drive. split; reflexivity. Qed.
Print Assumptions hook_dangling_operation_fault.
Theorem hook_success_has_no_timeout : forall objects operation_ref kind target method unused nonce deadline signature tail args stored static_values,
 nth_error objects operation_ref = Some (obj kind ([target;method;unused;nonce;deadline;signature] ++ tail)) ->
 match run_vm 24 hook_code (hook_vm_initial (VRef operation_ref) args objects stored static_values) with
 | Halt _ _ => True | _ => False end /\
 match run_source 2 hook_source (hook_source_initial (VRef operation_ref) args objects stored static_values) with
 | Halt _ _ => True | _ => False end.
Proof. intros. rewrite (vm_hook_complete objects operation_ref kind target method unused nonce deadline signature tail args stored static_values H).
 rewrite (source_hook_complete objects operation_ref kind target method unused nonce deadline signature tail args stored static_values H). split; exact I. Qed.
Print Assumptions hook_success_has_no_timeout.
''')


def kernel(command, work, log, success=True):
    result=subprocess.run(command,cwd=work,capture_output=True,text=True,timeout=600)
    text=result.stdout+result.stderr;Path(log).write_text(text)
    if success: require(result.returncode==0,'Kernel command failed: '+' '.join(command)+'\n'+text[-3200:])
    return result.returncode,text


def declarations(text): return re.findall(r'^(?:Lemma|Theorem|Example)\s+(\w+)\s*:',text,re.MULTILINE)


def run_proofs(inventory,output_dir):
    require(shutil.which('coqc') and shutil.which('coqchk'),'coqc and coqchk are required')
    tools={str(ROOT/p):sha((ROOT/p).read_bytes()) for p in ('hook_params_proofs.py','hook_params_source.py','method_source.py','nef_decode.py','verify.py')}
    bound=bind_method(inventory);output=Path(output_dir)
    require(not output.exists() or(output.is_dir() and not any(output.iterdir())),'Output directory must be new or empty')
    output.mkdir(parents=True,exist_ok=True);work=Path(tempfile.mkdtemp(prefix='hook-params-kernel-',dir=output))
    models,names={},{}
    for module in MODULES:
        path=ROOT/'coq'/(module+'.v');raw=path.read_bytes();text=raw.decode()
        require(not re.search(r'\b(?:Admitted|Axiom|Axioms|admit|Parameter|Parameters|Abort)\b',text),'Proof escape')
        models[str(path)]=sha(raw);names[module]=declarations(text);(work/path.name).write_bytes(raw)
        kernel(['coqc','-q',path.name],work,work/(module+'.log'))
    certificate=render_certificate(bound);(work/'HookArtifact.v').write_text(certificate);names['HookArtifact']=declarations(certificate)
    kernel(['coqc','-q','HookArtifact.v'],work,work/'artifact.log')
    kernel(['coqchk','-silent','HookArtifact'],work,work/'coqchk.log')
    audit='Require Import '+' '.join(names)+'.\n'+'\n'.join('Print Assumptions '+m+'.'+n+'.' for m,ns in names.items() for n in ns)
    (work/'Assumptions.v').write_text(audit);_,log=kernel(['coqc','-q','Assumptions.v'],work,work/'assumptions.log')
    require(log.count('Closed under the global context')==sum(map(len,names.values())),'Incomplete assumption audit')
    controls=semantic_controls(bound,inventory,work)
    require(bind_method(inventory)==bound,'Artifact drift during proof')
    require(all(sha(Path(p).read_bytes())==h for p,h in {**models,**tools}.items()),'Model/tool drift during proof')
    return dict(schema='neoos-aa-hook-params-refinement/v1',scope='private-hook-params-reference-refinement',kernelChecked=True,
                referenceRefinementVerified=True,fullImplementationVerified=False,vmCorrespondenceProven=False,
                fullUnprovedEntrypointCount=len(inventory['manifest']['methods']),methodRange=[bound['start'],bound['end']],
                byteCount=len(bound['bytes']),instructionCount=bound['instructionCount'],methodSha256=bound['methodSha256'],
                nefSha256=bound['nefSha256'],scriptSha256=bound['scriptSha256'],sourceProjection=bound['projection'],
                sourceInputSha256=inventory['inputs'],
                sourceTreeSha256=sha(json.dumps(inventory['source'],sort_keys=True,separators=(',',':')).encode()),
                modelSha256=models,toolInputSha256=tools,certificateSha256=sha(certificate.encode()),
                closedDeclarations=names,semanticControls=controls,kernelDirectory=str(work),
                openObligations=['SOURCE_FRONTEND_AND_RECORD_TYPE_CORRESPONDENCE','CALLER_ADMISSION_AND_HEAP_RELATION',
                                 'MALFORMED_MAP_AND_PRIMITIVE_PICKITEM','HOST_EXCEPTIONS_GAS_AND_RESOURCES',
                                 'CLONE_OPERATION_ARGUMENTS_NATIVE_CODEC','ALL_PUBLIC_ENTRYPOINTS'])


def semantic_controls(bound,inventory,work):
    cases=[]
    for name,index,value in [('signature-field-index',4,20),('argument-alias-substitution',12,120),
                             ('array-size',19,21),('target-field-index',17,17)]:
        altered=copy.deepcopy(bound);altered['bytes'][index]=value
        nef_decode.decode_script(bytes(altered['bytes']),0)
        cases.append((name,altered,None))
    for name in ['source-element-order','source-operation-args']:
        altered=copy.deepcopy(inventory)
        m=next(m for m in altered['source']['methods'] if m['id']==hook_params_source.METHOD)
        items=m['operations'][0]['children'][0]['children'][0]['children'][0]['children'][1]['children']
        if name=='source-element-order':items[0],items[1]=items[1],items[0]
        else:
            field=copy.deepcopy(items[0]['children'][0]);field['type']='object[]'
            identifier='F:SmartAccount.SmartAccount.UserOperation.Args'
            field['details']['symbol']=identifier
            field['boundMetadata']['IMemberReferenceOperation.Member']['id']=identifier
            field['boundMetadata']['IFieldReferenceOperation.Field']['id']=identifier
            items[2]['children'][0]=field
        projection=hook_params_source.project_method(altered)
        cases.append((name,bound,projection))
    reports=[]
    for index,(name,altered,projection) in enumerate(cases):
        certificate=render_certificate(altered,projection)
        definitions='From Coq Require Import ZArith List.\nRequire Import CapMethodVm HookParams.\nImport ListNotations. Open Scope Z_scope.\n'
        definitions+='\n'.join(line for line in certificate.splitlines() if line.startswith('Definition '))+'\n'
        module='HookDefinitions'+str(index);(work/(module+'.v')).write_text(definitions)
        kernel(['coqc','-q',module+'.v'],work,work/(module+'.log'))
        counter='HookCounterexample'+str(index)
        text=(f'From Coq Require Import ZArith List.\nRequire Import CapMethodVm HookParams {module}.\n'
              'Import ListNotations. Open Scope Z_scope.\n'
              'Definition objects := [obj ArrayKind [VBytes (repeat 1%nat 20);VBytes [109%nat];VNull;VInt 3;VInt 4;VBytes []];\n'
              'obj StructKind [VInt 7]].\n'
              'Example original_semantics : hook_observe (run_vm 24 hook_code (hook_vm_initial (VRef 0) (VRef 1) objects VNull (fun _=>None))) =\n'
              'hook_observe (run_source 2 hook_source (hook_source_initial (VRef 0) (VRef 1) objects VNull (fun _=>None))).\n'
              'Proof. vm_compute. reflexivity. Qed.\n')
        (work/(counter+'.v')).write_text(text)
        code,log=kernel(['coqc','-q',counter+'.v'],work,work/(counter+'.log'),success=False)
        require(code!=0 and 'Error: Unable to unify' in log,
                'Semantic control did not reject the concrete result equality: '+name)
        reports.append(dict(name=name,definitionsAccepted=True,proofRejected=True,kernelExitCode=code,
                            definitionSha256=sha(definitions.encode()),assertionSha256=sha(text.encode()),
                            mutatedMethodSha256=sha(bytes(altered['bytes'])),
                            sourceProjectionSha256=(projection or bound['projection'])['sourceProjectionSha256']))
    require(len(reports)>=4,'Insufficient controls')
    return reports


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory',type=Path,required=True);parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--json-report',type=Path,required=True);args=parser.parse_args()
    failure=dict(schema='neoos-aa-hook-params-refinement/v1',scope='private-hook-params-reference-refinement',kernelChecked=False,
                 referenceRefinementVerified=False,fullImplementationVerified=False,error='Verification has not completed')
    args.json_report.parent.mkdir(parents=True,exist_ok=True);args.json_report.write_text(json.dumps(failure,indent=2)+'\n')
    try:
        raw=args.inventory.read_bytes();receipt=run_proofs(json.loads(raw),args.output_dir)
        require(args.inventory.read_bytes()==raw,'Inventory drift during proof');receipt['inventorySha256']=sha(raw)
        args.json_report.write_text(json.dumps(receipt,indent=2)+'\n');return 0
    except Exception as exc:
        failure['error']=str(exc);args.json_report.write_text(json.dumps(failure,indent=2)+'\n');print(str(exc),file=sys.stderr);return 1


if __name__=='__main__': sys.exit(main())
