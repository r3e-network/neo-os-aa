#!/usr/bin/env python3
"""Source-derived handler programs with explicitly bounded kernel correspondence."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import runtime_source as source
ROOT=Path(__file__).resolve().parent
MODULES=('IntegerSemantics','NumericCoercions','CapArithmetic','CapMethodVm','RuntimeInstructionBridge')

def sha(raw): return hashlib.sha256(raw).hexdigest()
def require(condition,message):
    if not condition: raise ValueError(message)
def variable(name): return {'kind':'variable','name':name}
def strip(node):
    while node['kind']=='null-forgiving': node=node['operand']
    return node
class Lower:
    def __init__(self,helpers): self.helpers=helpers;self.names={};self.aliases={};self.next=0
    def fresh(self,name):
        i=self.next;self.next+=1;self.names[name]=i;return i
    def expr(self,node):
        node=strip(node);kind=node['kind']
        if kind=='literal':
            v=node['value']; require(v is not None,'Null only allowed in slot guard')
            return '(ConstantBool '+str(v).lower()+')' if type(v) is bool else f'(ConstantInt {v})'
        if kind=='variable':
            require(node['name'] in self.names,'Unknown expression variable '+node['name'])
            return f'(EVariable {self.names[node["name"]]}%nat)'
        if kind=='unary': return '('+({'!':'Not','-':'Negate'}[node['operator']])+' '+self.expr(node['operand'])+')'
        if kind=='binary':
            op=node['operator']
            if op=='is':
                require(node['right']=={'kind':'literal','value':None},'Unsupported is test')
                return '(SlotIsNull '+self.expr(node['left'])+')'
            operators={'+':'OAdd','-':'OSub','*':'OMul','>':'OGreater','<':'OLess','>=':'OGreaterEqual','<=':'OLessEqual','==':'OEqual','!=':'ONotEqual','||':'OOr','&&':'OAnd'}
            require(op in operators,'Unknown binary operator')
            return f'(Apply {operators[op]} {self.expr(node["left"])} {self.expr(node["right"])})'
        if kind=='index': return f'(SlotRead {self.expr(node["receiver"])} {self.expr(node["index"])})'
        if kind=='member':
            name=node['name'];receiver=strip(node['receiver'])
            if name in ('LocalVariables','Arguments','StaticFields'):
                require(receiver=={'kind':'member','receiver':variable('engine'),'name':'CurrentContext'},'Unknown slot owner')
                return '(SlotReference '+{'LocalVariables':'LocalSlot','Arguments':'ArgumentSlot','StaticFields':'StaticSlot'}[name]+')'
            if name=='EvaluationStack':
                require(receiver=={'kind':'member','receiver':variable('engine'),'name':'CurrentContext'},'Unknown stack owner');return 'StackReference'
            if name=='Count':
                if receiver['kind']=='variable' and self.aliases.get(receiver['name'])=='stack': return 'StackCount'
                return '(SlotCount '+self.expr(receiver)+')'
            if name=='IsNull': return '(IsNull '+self.expr(receiver)+')'
            if name in ('TokenI8','TokenU8'):
                require(receiver==variable('instruction'),'Unknown operand owner');return 'OperandSigned' if name=='TokenI8' else 'OperandUnsigned'
            if name=='InstructionPointer':
                require(receiver=={'kind':'member','receiver':variable('engine'),'name':'CurrentContext'},'Unknown PC owner');return 'CurrentPc'
            if name=='Length':
                require(receiver['kind']=='member' and receiver['name']=='Script','Unknown length owner')
                require(strip(receiver['receiver'])=={'kind':'member','receiver':variable('engine'),'name':'CurrentContext'},'Unknown script owner');return 'ScriptLength'
            raise ValueError('Unknown member '+name)
        if kind=='call':
            target=node['target'];args=node['arguments']
            if target==variable('checked'): require(len(args)==1,'checked arity');return '(CheckedInt32 '+self.expr(args[0])+')'
            require(target['kind']=='member','Unknown expression call')
            owner=strip(target['receiver']);name=target['name']
            if owner==variable('engine') and name in ('Pop','Peek'):
                require(len(args)==(0 if name=='Pop' else 0),'Unsupported Pop/Peek overload')
                return 'PopValue' if name=='Pop' else '(PeekValue (ConstantInt 0))'
            if name in ('GetInteger','GetBoolean'):
                require(not args,'Getter arity');return '('+name+' '+self.expr(owner)+')'
            if owner==variable('BigInteger') and name in ('Min','Max'):
                require(len(args)==2,'Min/Max arity');return f'(Apply O{name} {self.expr(args[0])} {self.expr(args[1])})'
            raise ValueError('Unknown expression call '+name)
        raise ValueError('Unknown expression '+kind)
    def actions(self,body):
        result=[]
        for statement in body:
            kind=statement['kind']
            if kind=='declare':
                name=statement['name'];expression=self.expr(statement['expression']);i=self.fresh(name)
                if expression=='StackReference': self.aliases[name]='stack'
                result.append(f'(Declare {i}%nat {expression})')
            elif kind=='throw': result.append('Raise')
            elif kind=='if':
                condition=self.expr(statement['condition']);yes=self.actions(statement['then']);no=self.actions(statement['otherwise'])
                result.append(f'(IfThenElse {condition} {self.list(yes)} {self.list(no)})')
            elif kind=='assign':
                target=statement['target'];expression=self.expr(statement['expression'])
                if target['kind']=='index': result.append(f'(SetSlot {self.expr(target["receiver"])} {self.expr(target["index"])} {expression})')
                elif target.get('name')=='InstructionPointer': require(self.expr(target)=='CurrentPc','PC target');result.append(f'(SetPc {expression})')
                elif target.get('name')=='isJumping': require(target['receiver']==variable('engine'),'Jumping owner');result.append(f'(SetJumping {expression})')
                else: raise ValueError('Unsupported assignment')
            elif kind=='expression':
                expr=statement['expression'];target=expr.get('target');args=expr.get('arguments',[])
                if expr['kind']=='call' and target['kind']=='variable' and target['name'] in self.helpers:
                    helper=target['name']; parameters={'ExecuteLoadFromSlot':['slot','index'],'ExecuteStoreToSlot':['slot','index'],'ExecuteJump':['position'],'ExecuteJumpOffset':['offset']}[helper]
                    require(len(args)==len(parameters)+1 and args[0]==variable('engine'),'helper call shape')
                    old=dict(self.names)
                    for parameter,arg in zip(parameters,args[1:]):
                        value=self.expr(arg);i=self.fresh(parameter);result.append(f'(Declare {i}%nat {value})')
                    result.extend(self.actions(self.helpers[helper]));self.names=old
                elif expr['kind']=='call' and target['kind']=='member' and target['receiver']==variable('engine') and target['name']=='Push':
                    require(len(args)==1,'Push arity');result.append('(PushValue '+self.expr(args[0])+')')
                elif expr['kind']=='call' and target['kind']=='member' and target['name'] in ('Swap','Insert'):
                    require((target['receiver']['kind']=='variable' and self.aliases.get(target['receiver']['name'])=='stack') or self.expr(target['receiver'])=='StackReference','Stack receiver')
                    require(len(args)==2,'Stack operation arity');result.append('('+{'Swap':'SwapValues','Insert':'InsertValue'}[target['name']]+' '+self.expr(args[0])+' '+self.expr(args[1])+')')
                else: result.append('(Ignore '+self.expr(expr)+')')
            else: raise ValueError('Unknown action '+kind)
        return result
    @staticmethod
    def list(actions): return '['+';'.join(actions)+']'

def lower_inventory(inventory):
    return {name: Lower(inventory['helpers']).list(Lower(inventory['helpers']).actions(item['body'])) for name,item in inventory['handlers'].items()}

CBN='Bool.eqb length nth_error Nat.ltb orb andb negb Nat.eqb option_map pc stack arguments locals heap storage effects statics raw_stack raw_locals raw_arguments raw_statics raw_static_count raw_pc raw_script_length raw_unsigned raw_signed raw_jumping raw_environment snd fst source_step execute initial_frame evaluate bind lookup apply_operator vm_atom integer_atom bool_atom replace_stack replace_environment replace_position replace_slot slot_count slot_read project_success instruction_observation vm_step with_stack with_local change numeric_projection get_integer boolean_projection checked_binary binary_value update_at insert_at'
def arithmetic_certificate(name,body):
    target='Greater' if name=='GT' else '(Binary '+name.title()+')'
    return f'''Definition body_{name} : list Action := {body}.
Theorem bridge_{name} : forall p ar lo hp store ev static rhs lhs rest,
 integer_fits rhs -> integer_fits lhs ->
 source_step body_{name} 1 (state p (VInt rhs::VInt lhs::rest) ar lo hp store ev static) 0 0 0 =
 instruction_observation (vm_step {target} 1 (state p (VInt rhs::VInt lhs::rest) ar lo hp store ev static)).
Proof. intros p ar lo hp store ev static rhs lhs rest Hr Hl.
 unfold source_step, body_{name}. cbn [{CBN}].
 {'rewrite (checked_integer_in_range lhs Hl). cbn ['+CBN+']. rewrite (checked_integer_in_range rhs Hr).' if name=='GT' else 'rewrite (checked_integer_in_range rhs Hr). cbn ['+CBN+']. rewrite (checked_integer_in_range lhs Hl).'}
 cbv [{CBN}]. {'reflexivity.' if name=='GT' else 'destruct (checked_integer ('+{'ADD':'lhs+rhs','SUB':'lhs-rhs','MUL':'lhs*rhs','MIN':'Z.min lhs rhs','MAX':'Z.max lhs rhs'}[name]+')); cbv ['+CBN+']; reflexivity.'}
Qed.
Print Assumptions bridge_{name}.
'''

def plain_certificate(name,body):
    heads={'DUP':['a'],'DROP':['a'],'TUCK':['a','b'],'SWAP':['a','b'],'ROT':['a','b','c']}[name]
    values='::'.join(heads+['rest'])
    target=name.title()
    return f"""Definition body_{name} : list Action := {body}.
Theorem bridge_{name} : forall p ar lo hp store ev static {' '.join(heads)} rest,
 source_step body_{name} 1 (state p ({values}) ar lo hp store ev static) 0 0 0 =
 instruction_observation (vm_step {target} 1 (state p ({values}) ar lo hp store ev static)).
Proof. intros.
 {'assert (Hg : (Z.of_nat (length ('+values+')) <? '+str(len(heads))+') = false) by (apply Z.ltb_ge; cbn [length]; rewrite !Nat2Z.inj_succ; lia). cbn [length] in Hg.' if name in ('SWAP','ROT') else ''}
 unfold source_step, body_{name}. cbn [{CBN}]. {'rewrite Hg; cbv ['+CBN+'].' if name in ('SWAP','ROT') else ''} cbv [{CBN}]. reflexivity. Qed.
Print Assumptions bridge_{name}.
"""

def slot_certificate(name,body):
    index=int(name[-1]); values=[f'v{i}' for i in range(index+1)]
    shape='::'.join(values+['tail']);kind='Argument' if name.startswith('LDARG') else 'Local'
    store=name.startswith('STLOC');stack='value::st' if store else 'st'
    ar=shape if kind=='Argument' else 'ar';lo=shape if kind=='Local' else 'lo'
    binders='p st '+('lo' if kind=='Argument' else 'ar')+' hp storage0 ev static '+' '.join(values)+' tail'+(' value' if store else '')
    target=f'({"StoreLocal" if store else "Load"+kind} {index}%nat)'
    state=f'(state p ({stack}) ({ar}) ({lo}) hp storage0 ev static)'
    return f"""Definition body_{name} : list Action := {body}.
Theorem bridge_{name} : forall {binders},
 source_step body_{name} 1 {state} 0 0 0 =
 instruction_observation (vm_step {target} 1 {state}).
Proof. intros.
 assert (Hg : (Z.of_nat (length ({shape})) <=? {index}) = false).
 {{ apply Z.leb_gt. cbn [length]. rewrite !Nat2Z.inj_succ. lia. }}
 cbn [length] in Hg. unfold source_step, body_{name}. cbn [{CBN}].
 rewrite Hg. cbv [{CBN}]. reflexivity.
Qed.
Print Assumptions bridge_{name}.
"""

def static_certificate(body):
    return f"""Definition body_LDSFLD : list Action := {body}.
Theorem bridge_LDSFLD : forall p st ar lo hp store ev static index count value,
 (index < count)%nat -> static index = Some value ->
 source_step body_LDSFLD 2 (state p st ar lo hp store ev static) index 0 count =
 instruction_observation (vm_step (LoadStatic index) 2 (state p st ar lo hp store ev static)).
Proof. intros p st ar lo hp store ev static index count value Hindex Hvalue.
 assert (Hn : (Z.of_nat index <? 0) = false) by (apply Z.ltb_ge; lia).
 assert (Hg : (Z.of_nat count <=? Z.of_nat index) = false) by (apply Z.leb_gt; lia).
 assert (Hpositive : (0 <=? Z.of_nat index) = true) by (apply Z.leb_le; lia).
 unfold source_step, body_LDSFLD; cbn [{CBN}].
 rewrite Hn; cbn [{CBN}]. rewrite Hg; cbn [{CBN}].
 rewrite Hpositive; cbn [{CBN}]. rewrite Nat2Z.id, Hvalue.
 cbv [{CBN}]. reflexivity.
Qed.
Print Assumptions bridge_LDSFLD.
"""

def branch_certificate(name,body):
    conditional=name!='JMP';positive='true' if name=='JMPIF' else 'false'
    stack='VBool condition::rest' if conditional else 'rest'
    target=f'(JumpIf {positive} (signed_byte operand))' if conditional else '(Jump (signed_byte operand))'
    state=f'(state p ({stack}) ar lo hp store ev static)'
    return f"""Definition body_{name} : list Action := {body}.
Theorem bridge_{name} : forall p ar lo hp store ev static rest operand script_length {'condition' if conditional else ''},
 0 <= Z.of_nat p + signed_byte operand < Z.of_nat script_length ->
 Z.of_nat script_length <= 2^31 ->
 source_step body_{name} 2 {state} operand script_length 0 =
 instruction_observation (vm_step {target} 2 {state}).
Proof. intros p ar lo hp store ev static rest operand script_length {'condition' if conditional else ''} Hrange Hlength.
 assert (H32 : ((-2^31 <=? Z.of_nat p + signed_byte operand) && (Z.of_nat p + signed_byte operand <? 2^31)) = true).
 {{ apply andb_true_iff. split; [apply Z.leb_le|apply Z.ltb_lt]; lia. }}
 assert (Hnegative : (Z.of_nat p + signed_byte operand <? 0) = false) by (apply Z.ltb_ge; lia).
 assert (Hupper : (Z.of_nat script_length <=? Z.of_nat p + signed_byte operand) = false) by (apply Z.leb_gt; lia).
 {'destruct condition;' if conditional else ''} unfold source_step, body_{name}; cbn [{CBN}].
 {'all: try reflexivity.' if conditional else ''}
 all: rewrite H32; cbn [{CBN}]; rewrite Hnegative, Hupper; cbn [{CBN} jump_target]; reflexivity.
Qed.
Print Assumptions bridge_{name}.
"""

def command(args,directory,log,expected=True):
    result=subprocess.run(args,cwd=directory,capture_output=True,text=True,timeout=600)
    Path(log).write_text(result.stdout+result.stderr)
    if expected: require(result.returncode==0,'Kernel command failed '+str(args)+'\n'+(result.stdout+result.stderr)[-2800:])
    return result

PRELUDE='From Coq Require Import ZArith List Bool Lia.\nRequire Import IntegerSemantics NumericCoercions CapMethodVm RuntimeInstructionBridge.\nImport ListNotations.\nOpen Scope Z_scope.\n'
MUTATIONS=(
 ('sub-add','SUB','x1 - x2','x1 + x2','Numeric',None),
 ('min-max','MIN','BigInteger.Min(x1, x2)','BigInteger.Max(x1, x2)','Numeric',None),
 ('gt-ge','GT','x1.GetInteger() > x2.GetInteger()','x1.GetInteger() >= x2.GetInteger()','Numeric',None),
 ('tuck-depth','TUCK','Insert(2, engine.Peek())','Insert(1, engine.Peek())','Stack',None),
 ('rot-order','ROT','stack.Swap(1, 2)','stack.Swap(0, 2)','Stack',None),
 ('local-index','LDLOC0','LocalVariables, 0)','LocalVariables, 1)','Slot',None),
 ('jump-direction','JMP','InstructionPointer + offset','InstructionPointer - offset','Control','ExecuteJumpOffset'),
 ('jumpifnot-condition','JMPIFNOT','!engine.Pop().GetBoolean()','engine.Pop().GetBoolean()','Control',None))
def concrete_state(name):
    stack={'SUB':'[VInt 2;VInt 5]','MIN':'[VInt 2;VInt 5]','GT':'[VInt 2;VInt 2]','TUCK':'[VInt 1;VInt 2]','ROT':'[VInt 1;VInt 2;VInt 3]','LDLOC0':'[]','JMP':'[]','JMPIFNOT':'[VBool true]'}[name]
    return f'(state 5 {stack} [] [VInt 1;VInt 2] [] VNull [] (fun _ => None))'
def certificate_for(name,body):
    if name in ('ADD','SUB','MUL','MIN','MAX','GT'): return arithmetic_certificate(name,body)
    if name in ('DROP','DUP','TUCK','SWAP','ROT'): return plain_certificate(name,body)
    if name.startswith(('LDLOC','STLOC','LDARG')): return slot_certificate(name,body)
    if name=='LDSFLD': return static_certificate(body)
    return branch_certificate(name,body)
def semantic_controls(output,inventory,cache):
    # Mutations bypass the production hash pin ONLY here; actual C# syntax is
    # parsed/lowered and the emitted program is definition-compiled first.
    captured=source.pinned_sources(cache);receipts=[];modules=[]
    for identifier,name,before,after,group,helper in MUTATIONS:
        path=f'JumpTable/JumpTable.{group}.cs';text=captured[path]
        require(before in text,'Missing mutation source anchor '+identifier)
        changed=text.replace(before,after,1);mutant=copy.deepcopy(inventory)
        if helper: mutant['helpers'][helper]=source.parse_handler(changed,helper,True)
        else: mutant['handlers'][name]['body']=source.parse_handler(changed,source.HANDLERS[name][1])
        body=lower_inventory(mutant)[name];require(body!=lower_inventory(inventory)[name],'Semantic control did not change emitted program')
        folder=output/identifier;folder.mkdir(exist_ok=True)
        (folder/'mutated.cs').write_bytes(changed.encode())
        definition=f'Definition mutant : list Action := {body}.\n'
        name_module='Control_'+identifier.replace('-','_')
        source_file=output/(name_module+'.v');source_file.write_text(PRELUDE+definition)
        command(['coqc','-q',source_file.name],output,folder/'definition.log')
        st=concrete_state(name);width=2 if name.startswith('JMP') else 1;operand=3 if name.startswith('JMP') else 0
        target={'SUB':'(Binary Sub)','MIN':'(Binary Min)','GT':'Greater','TUCK':'Tuck','ROT':'Rot','LDLOC0':'(LoadLocal 0)','JMP':'(Jump (signed_byte 3))','JMPIFNOT':'(JumpIf false (signed_byte 3))'}[name]
        example=f'Example counterexample : source_step mutant {width} {st} {operand} 20 0 <> instruction_observation (vm_step {target} {width} {st}).\nProof. vm_compute. discriminate. Qed.\nPrint Assumptions counterexample.\n'
        source_file.write_text(PRELUDE+definition+example)
        command(['coqc','-q',source_file.name],output,folder/'counterexample.log')
        modules.append(name_module)
        false_file=output/(name_module+'_false.v');false_file.write_text(PRELUDE+certificate_for(name,body))
        rejected=command(['coqc','-q',false_file.name],output,folder/'rejected.log',False)
        require(rejected.returncode!=0 and 'Error:' in rejected.stderr,'Semantic mutant incorrectly certified '+identifier)
        receipts.append(dict(name=identifier,opcode=name,sourceSha256=sha(changed.encode()),programSha256=sha(body.encode()),kernelCounterexampleChecked=True,sourceDefinitionCompiled=True,correspondenceRejected=True))
    command(['coqchk','-silent']+modules,output,output/'controls-coqchk.log')
    return receipts

def _run(output,report,cache=None):
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    inventory=source.extract_runtime(cache);programs=lower_inventory(inventory)
    models={};captured={}
    for module in MODULES:
        path=ROOT/'coq'/(module+'.v');raw=path.read_bytes();captured[path]=raw
        require(not re.search(r'\b(?:Admitted|Axiom|admit)\b',raw.decode()),'Unclosed model')
        models[module]=sha(raw);(output/(module+'.v')).write_bytes(raw)
    tools={}
    for name in ('runtime_source.py','runtime_bridge_proofs.py'):
        path=ROOT/name;raw=path.read_bytes();captured[path]=raw;tools[name]=sha(raw)
    projection=json.dumps(inventory,sort_keys=True,separators=(',',':')).encode();(output/'source-projection.json').write_bytes(projection)
    for module in MODULES: command(['coqc','-q',module+'.v'],output,output/(module+'.log'))
    certificate='From Coq Require Import ZArith List Bool Lia.\nRequire Import IntegerSemantics NumericCoercions CapMethodVm RuntimeInstructionBridge.\nImport ListNotations.\nOpen Scope Z_scope.\n'
    certificate+=''.join(arithmetic_certificate(name,programs[name]) for name in ('ADD','SUB','MUL','MIN','MAX','GT'))
    certificate+=''.join(plain_certificate(name,programs[name]) for name in ('DROP','DUP','TUCK','SWAP','ROT'))
    certificate+=''.join(slot_certificate(name,programs[name]) for name in programs if name.startswith(('LDLOC','STLOC','LDARG')))
    certificate+=static_certificate(programs['LDSFLD'])
    certificate+=''.join(branch_certificate(name,programs[name]) for name in ('JMP','JMPIF','JMPIFNOT'))
    (output/'RuntimeSourceCertificate.v').write_text(certificate)
    command(['coqc','-q','RuntimeSourceCertificate.v'],output,output/'certificate.log')
    command(['coqchk','-silent','RuntimeSourceCertificate'],output,output/'coqchk.log')
    controls=semantic_controls(output,inventory,cache)
    for path,raw in captured.items(): require(path.read_bytes()==raw,'Input changed during proof '+str(path))
    source.pinned_sources(cache)
    receipt=dict(schema='neoos-aa-runtime-source-bridge/v1',scope='runtime-instruction-source-bridge',kernelChecked=True,productionSourceBound=True,sourceCommit=source.COMMIT,sourceSha256=source.SOURCE_HASHES,sourceProjectionSha256=sha(projection),generatedCertificateSha256=sha(certificate.encode()),modelSha256=models,toolInputSha256=tools,supportedOpcodes=sorted(programs),provenOpcodes=sorted(programs),semanticControls=controls,runtimeImplementationProven=False,fullImplementationVerified=False,boundSourceScope='selected opcode handler and invoked helper bodies',kernelDeclarations=re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',certificate,re.MULTILINE),preconditions=['admitted Integer-tag arithmetic operands','Boolean-tag conditional branch conditions','initialized slots and selected in-range index','signed32 representable in-script jump target','default opcode dispatch and intact active frame'],faultObservationBoundary='Fault classification only; partial pop state, exception payload, resources and unwinding erased',tcb=['strict C# parser and API binding/lowering','engine stack/slot API primitives and value identity projection','.NET BigInteger semantics','compiled VM DLL/source and opcode dispatch binding'],unproved=inventory['unsupported'])
    Path(report).write_text(json.dumps(receipt,indent=2)+'\n');return receipt

def run(output,report,cache=None):
    output=Path(output);report=Path(report);report.parent.mkdir(parents=True,exist_ok=True)
    failure=dict(scope='runtime-instruction-source-bridge',kernelChecked=False,productionSourceBound=False,runtimeImplementationProven=False,fullImplementationVerified=False)
    try:
        existing=list(output.iterdir()) if output.exists() else []
        report.write_text(json.dumps(failure)+'\n')
        require(not existing,'Output directory must be new or empty')
        result=_run(output,report,cache);return result
    except Exception as error:
        failure['error']=str(error);report.write_text(json.dumps(failure,indent=2)+'\n');raise

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output-dir',type=Path,required=True);p.add_argument('--json-report',type=Path,required=True);p.add_argument('--source-cache',type=Path)
    args=p.parse_args();print(json.dumps(run(args.output_dir,args.json_report,args.source_cache)))
if __name__=='__main__': main()
