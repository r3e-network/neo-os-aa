#!/usr/bin/env python3
"""Kernel correspondence of captured collection programs; no full VM acceptance."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import runtime_collection_source as source
ROOT=Path(__file__).resolve().parent
MODULES=('IntegerSemantics','NumericCoercions','CapArithmetic','CapMethodVm','RuntimeInstructionBridge','RuntimeCollectionBridge')
PRELUDE='From Coq Require Import ZArith List Bool Lia.\nRequire Import IntegerSemantics NumericCoercions CapMethodVm RuntimeInstructionBridge RuntimeCollectionBridge.\nImport ListNotations.\nOpen Scope Z_scope.\n'
COMPARE={'<':'CLt','<=':'CLe','>':'CGt','>=':'CGe','==':'CEq','!=':'CNe'}
def require(condition,message):
 if not condition:raise ValueError(message)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def bounds(p):return f'(bounds {COMPARE[p["lowerComparison"]]} {p["lowerBound"]} {COMPARE[p["upperComparison"]]})'
def lower_program(p):
 kind=p['kind'];allocation=lambda name:'StructKind' if name=='Struct' else 'ArrayKind'
 if kind=='ArrayPickProgram':return f'(ArrayGet {bounds(p)} {p["indexOffset"]})'
 if kind=='ArraySetProgram':return f'(ArrayPut {bounds(p)} {p["indexOffset"]} {str(p["valueSource"]=="key").lower()})'
 if kind=='CountedPackProgram':return f'(CountedPack {bounds(p)} {allocation(p["allocationType"])} {p["loopStart"]}%nat {COMPARE[p["loopComparison"]]} {p["loopStep"]})'
 if kind=='EmptyAllocationProgram':return f'(EmptyAllocation {allocation(p["allocationType"])})'
 if kind=='PushLiteralProgram':return '(LiteralPush VNull)' if p['value'] is None else f'(LiteralPush (VInt {p["value"]}))'
 if kind=='PushOperandProgram':return 'OperandPush'
 if kind=='EntryInitSlotProgram':return f'(EntryInitSlots {p["rejectOperand"]}%nat {str(p["localCountOperand"]=="TokenU8_1").lower()} {p["loopStart"]}%nat {COMPARE[p["loopComparison"]]} {p["loopStep"]})'
 if kind=='ArraySizeProjectionProgram':return 'tt'
 if kind=='ArrayTypeProjectionProgram':return COMPARE[p['comparison']]
 if kind=='ByteBufferConversionProjectionProgram':return str(p['spanDrop'])+'%nat'
 if kind=='SharedReturnProgram':return f'({str(p["copyComparison"]=="==").lower()}, {str(p["jumping"]).lower()})'
 raise ValueError('Unknown source program '+kind)
def lower(inventory):return {name:lower_program(p) for name,p in inventory['programs'].items()}
def command(args,out,log,positive=True):
 result=subprocess.run(args,cwd=out,capture_output=True,text=True,timeout=600)
 Path(log).write_text(result.stdout+result.stderr)
 if positive:require(result.returncode==0,'Kernel command rejected '+str(args)+'\n'+(result.stdout+result.stderr)[-2800:])
 return result

def certificate(name,term,model):
 canonical={'PICKITEM':('array_get_refines','(ArrayGet array_bounds 0)'), 'SETITEM':('array_put_refines','(ArrayPut array_bounds 0 false)'), 'PACK':('counted_pack_refines','(CountedPack pack_bounds ArrayKind 0 CLt 1)'), 'INITSLOT':('entry_slot_refines','(EntryInitSlots 0 false 0 CLt 1)')}
 if name in canonical:
  lemma,pattern=canonical[name];m=re.search(r'Theorem '+lemma+r' : ([\s\S]*?)\nProof\.',model);require(m is not None,'Missing universal correspondence type')
  statement=m[1].replace(pattern,'actual_'+name)
  return f'Definition actual_{name} : CollectionProgram := {term}.\nTheorem corresponding_{name} : {statement}\nProof. intros; unfold actual_{name}; eapply {lemma}; eassumption. Qed.\nPrint Assumptions corresponding_{name}.\n'
 if name=='SIZE':
  return f"""Definition actual_SIZE : unit := {term}.
Theorem corresponding_SIZE_array_count : forall objects reference object,
 nth_error objects reference = Some object -> Z.of_nat (length (fields object)) < 2^31 ->
 source_array_size objects reference = reference_array_size objects reference.
Proof. intros. eapply source_size_refines_view; eassumption. Qed.
Print Assumptions corresponding_SIZE_array_count.
"""
 if name=='ISTYPE':
  return f"""Definition actual_ISTYPE : Compare := {term}.
Theorem corresponding_ISTYPE_array_kind : forall objects reference target,
 source_array_tag actual_ISTYPE objects reference target = reference_array_tag objects reference target.
Proof. intros. apply source_type_refines_view. Qed.
Print Assumptions corresponding_ISTYPE_array_kind.
"""
 if name=='CONVERT':
  return f"""Definition actual_CONVERT : nat := {term}.
Theorem corresponding_CONVERT_buffer_contents : forall value,
 source_buffer_view actual_CONVERT value = reference_buffer_view value.
Proof. intros. apply source_buffer_refines_view. Qed.
Print Assumptions corresponding_CONVERT_buffer_contents.
"""
 if name=='RET':
  return f'''Definition actual_RET : bool * bool := {term}.
Theorem corresponding_RET_shared_stack : forall values remaining,
 (0 < remaining)%nat -> shared_return_boundary (fst actual_RET) (snd actual_RET) values true remaining = Some (values,true).
Proof. intros. apply shared_return_preserves_all_values. assumption. Qed.
Print Assumptions corresponding_RET_shared_stack.
'''
 if name in ('NEWSTRUCT0','NEWARRAY0'):
  expected='StructKind' if name=='NEWSTRUCT0' else 'ArrayKind'
  return f'''Definition actual_{name} : CollectionProgram := {term}.
Theorem corresponding_{name} : forall width s,
 source_collection actual_{name} width s [] false false =
 let '(reference,allocated) := allocate s {expected} [] in
 Some (with_stack allocated (pc s+width)%nat (reference::stack s)).
Proof. intros. reflexivity. Qed.
Print Assumptions corresponding_{name}.
'''
 if name=='PUSHDATA1':
  return f'''Definition actual_{name} : CollectionProgram := {term}.
Theorem corresponding_{name} : forall width s bytes,
 (length bytes <= 131070)%nat -> source_collection actual_{name} width s bytes false false =
 instruction_observation (vm_step (Push (VBytes bytes)) width s).
Proof. intros width s bytes H. unfold source_collection, actual_{name}.
 assert (Hlength : (length bytes <=? 131070)%nat = true) by (apply Nat.leb_le;assumption).
 rewrite Hlength. reflexivity. Qed.
Print Assumptions corresponding_{name}.
'''
 expected='VNull' if name=='PUSHNULL' else f'(VInt {int(name[4:])})'
 return f'''Definition actual_{name} : CollectionProgram := {term}.
Theorem corresponding_{name} : forall width s,
 source_collection actual_{name} width s [] false false =
 instruction_observation (vm_step (Push {expected}) width s).
Proof. intros. reflexivity. Qed.
Print Assumptions corresponding_{name}.
'''

CONTROLS=(
 ('pick-index','PICKITEM','Compound','array[(int)index]','array[(int)index + 1]'),
 ('set-key','SETITEM','Compound','array[i] = value;','array[i] = key;'),
 ('pack-loop','PACK','Compound','for (var i = 0; i < size; i++)','for (var i = 1; i < size; i++)'),
 ('allocation-kind','NEWSTRUCT0','Compound','new Struct()','new VMArray()'),
 ('slot-count','INITSLOT','Slot','new Slot(instruction.TokenU8, engine.ReferenceCounter)','new Slot(instruction.TokenU8_1, engine.ReferenceCounter)'),
 ('push-value','PUSH1','Push','engine.Push(1);','engine.Push(2);'),
 ('ret-jump','RET','Control','engine.isJumping = true;','engine.isJumping = false;'),
 ('type-comparison','ISTYPE','Types','engine.Push(x.Type == type);','engine.Push(x.Type != type);'),
 ('buffer-span','CONVERT','PrimitiveType','new Buffer(GetSpan())','new Buffer(GetSpan().Slice(1))'))
def concrete(name):
 common='[] [] [obj ArrayKind [VInt 11;VInt 22]] VNull [] (fun _ => None)'
 stack={'PICKITEM':'[VInt 0;VRef 0]','SETITEM':'[VInt 9;VInt 0;VRef 0]','PACK':'[VInt 2;VInt 11;VInt 22]','NEWSTRUCT0':'[]','PUSH1':'[]'}
 if name=='INITSLOT':return '(state 0 [VInt 9] [] [] [] VNull [] (fun _ => None))'
 return f'(state 0 {stack[name]} {common})'
def semantic_controls(out,inventory,model,cache):
 texts=source.capture_sources(cache);records=[];modules=[]
 for identifier,name,group,before,after in CONTROLS:
  path='Types/PrimitiveType.cs' if group=='PrimitiveType' else f'JumpTable/JumpTable.{group}.cs';text=texts[path]
  method=source.HANDLERS[name][1]
  if group=='PrimitiveType':
   require(before in text,'Missing typed converter control anchor');changed=text.replace(before,after,1)
   p=dict(inventory['programs'][name]);p['spanDrop']=source.parse_primitive_buffer_api(changed)['spanDrop']
  else:
   begin=text.index('public virtual void '+method+'(');opening=text.index('{',begin);position=opening;depth=0
   while position<len(text):
    token=source.TOKEN.match(text,position);require(token is not None,'Unknown mutation span token');position=token.end();value=token.group()
    if value=='{':depth+=1
    if value=='}':
     depth-=1
     if depth==0:break
   body=text[begin:position];require(before in body,'Missing handler-specific mutation anchor '+identifier)
   changed=text[:begin]+body.replace(before,after,1)+text[position:];p=source.parse_collection(changed,method)
  term=lower_program(p);require(term!=lower_program(inventory['programs'][name]),'Control unchanged')
  folder=out/identifier;folder.mkdir();(folder/'mutated.cs').write_bytes(changed.encode());module='CollectionControl_'+identifier.replace('-','_');modules.append(module)
  definition=f'Definition mutant : {"nat" if name=="CONVERT" else "Compare" if name=="ISTYPE" else "bool * bool" if name=="RET" else "CollectionProgram"} := {term}.\n'
  file=out/(module+'.v');file.write_text(PRELUDE+definition);command(['coqc','-q',file.name],out,folder/'definition.log')
  if name=='CONVERT':example='source_buffer_view mutant (VBytes [1%nat;2%nat]) <> reference_buffer_view (VBytes [1%nat;2%nat])'
  elif name=='ISTYPE':example='source_array_tag mutant [obj ArrayKind []] 0 64 <> reference_array_tag [obj ArrayKind []] 0 64'
  elif name=='RET':example='shared_return_boundary (fst mutant) (snd mutant) [VInt 9] true 1 <> Some ([VInt 9],true)'
  else:
   operand='[2%nat;1%nat]' if name=='INITSLOT' else '[]';absent='true' if name=='INITSLOT' else 'false'
   original=lower_program(inventory['programs'][name]);st=concrete(name)
   example=f'source_collection mutant 1 {st} {operand} false {absent} <> source_collection {original} 1 {st} {operand} false {absent}'
  example=f'Example counterexample : {example}.\nProof. vm_compute. discriminate. Qed.\nPrint Assumptions counterexample.\n'
  file.write_text(PRELUDE+definition+example);command(['coqc','-q',file.name],out,folder/'counterexample.log')
  rejected=out/(module+'_false.v');rejected.write_text(PRELUDE+certificate(name,term,model));result=command(['coqc','-q',rejected.name],out,folder/'rejected.log',False)
  require(result.returncode!=0 and 'Error:' in result.stderr,'Mutant correspondence accepted')
  records.append(dict(name=identifier,opcode=name,sourceSha256=sha(changed.encode()),programSha256=sha(term.encode()),sourceDefinitionCompiled=True,kernelCounterexampleChecked=True,correspondenceRejected=True))
 command(['coqchk','-silent']+modules,out,out/'controls-coqchk.log');return records

def _run(out,report,cache):
 inventory=source.extract(cache);programs=lower(inventory);captured={};models={};tools={}
 for module in MODULES:
  path=ROOT/'coq'/(module+'.v');raw=path.read_bytes();captured[path]=raw
  require(not re.search(r'\b(?:Admitted|Axiom|admit)\b',raw.decode()),'Unclosed model '+module)
  models[module]=sha(raw);(out/(module+'.v')).write_bytes(raw)
 for name in ('runtime_collection_source.py','runtime_collection_proofs.py'):
  path=ROOT/name;raw=path.read_bytes();captured[path]=raw;tools[name]=sha(raw)
 model=captured[ROOT/'coq'/'RuntimeCollectionBridge.v'].decode()
 projection=json.dumps(inventory,sort_keys=True,separators=(',',':')).encode();(out/'source-projection.json').write_bytes(projection)
 for module in MODULES:command(['coqc','-q',module+'.v'],out,out/(module+'.log'))
 cert=PRELUDE+''.join(certificate(name,term,model) for name,term in programs.items())
 (out/'RuntimeCollectionCertificate.v').write_bytes(cert.encode());command(['coqc','-q','RuntimeCollectionCertificate.v'],out,out/'certificate.log');command(['coqchk','-silent','RuntimeCollectionCertificate'],out,out/'coqchk.log')
 controls=semantic_controls(out,inventory,model,cache)
 for path,raw in captured.items():require(path.read_bytes()==raw,'Input changed during proof '+str(path))
 source.capture_sources(cache)
 return dict(schema='neoos-sa-runtime-collection-bridge/v1',scope='runtime-collection-source-bridge',kernelChecked=True,productionSourceBound=True,sourceCommit=source.COMMIT,sourceSha256=source.SOURCE_HASHES,sourceProjectionSha256=sha(projection),generatedCertificateSha256=sha(cert.encode()),modelSha256=models,toolInputSha256=tools,supportedOpcodes=sorted(programs),provenOpcodes=sorted(n for n in programs if n not in ('RET','SIZE','ISTYPE','CONVERT')),supportingProjections={'RET':'shared evaluation stack preservation and jumping flag only','SIZE':'Array/Struct count with int32 size','ISTYPE':'Array/Struct kind on admitted enum target; other types unproved','CONVERT':'ByteString/Buffer to Buffer contents only; allocation identity unproved'},kernelDeclarations=re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',cert,re.MULTILINE),semanticControls=controls,runtimeImplementationProven=False,fullImplementationVerified=False,preconditions=['Array/Struct receiver, admitted Integer index, valid index and int32 collection count','SETITEM scalar assigned value, mutable receiver and erased refcounter effects','PACK valid int32 count and enough items','INITSLOT actually absent local/argument slots, nonzero operand, enough args','PUSHDATA1 admitted MaxItemSize','RET shared caller stack, remaining invocation context, erased unload effects; caller PC is not projected'],tcb=['typed C# grammar/extraction','source runtime API and mutable-object identity projection','reference counter/resources/readonly abstraction','.NET arithmetic and compiled DLL/dispatch correspondence'],unproved=inventory['unsupported'])
def run(output,report,cache=None):
 out=Path(output);report=Path(report);report.parent.mkdir(parents=True,exist_ok=True)
 failure=dict(scope='runtime-collection-source-bridge',kernelChecked=False,productionSourceBound=False,runtimeImplementationProven=False,fullImplementationVerified=False)
 try:
  existing=list(out.iterdir()) if out.exists() else []
  report.write_text(json.dumps(failure)+'\n')
  require(not existing,'Output directory must be new or empty')
  out.mkdir(parents=True,exist_ok=True);receipt=_run(out,report,cache);report.write_text(json.dumps(receipt,indent=2)+'\n');return receipt
 except Exception as error:
  failure['error']=str(error);report.write_text(json.dumps(failure,indent=2)+'\n');raise

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output-dir',type=Path,required=True);p.add_argument('--json-report',type=Path,required=True);p.add_argument('--source-cache',type=Path);a=p.parse_args();print(json.dumps(run(a.output_dir,a.json_report,a.source_cache)))
if __name__=='__main__':main()
