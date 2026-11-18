#!/usr/bin/env python3
"""Deliberately bounded typed grammar for pinned runtime collection handlers."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tempfile
import urllib.request
COMMIT='004cd6070a940405818d9357638277dd44407e2e'
SOURCE_HASHES={
'JumpTable/JumpTable.Compound.cs':'9555a7be345de34892158b0233c20323f7acadad3b38e6f7fa2be96849d69962',
'JumpTable/JumpTable.Types.cs':'7bb02e6489940b7022fa1efdf463ec33e0f46923dd9fe5cebe14ea9979233950',
'JumpTable/JumpTable.Push.cs':'118827fa0713de99236eb0669e4df6368cab57e969c7f67f254e7e9a1d1e44a8',
'JumpTable/JumpTable.Slot.cs':'771273cbcfc23aa28207494539fe1e994e5f360a21b1c356a070499aaa48175a',
'JumpTable/JumpTable.Control.cs':'a0ac51ff220abbfcf8fb8c19bb0f2b8be4680169ba8ba33f6ededfc5e5e6a2ec',
'Types/Array.cs':'6a100285b620ed1fca6eac4ebd91abecab5ddfa6b84ab1d65feaf50e463d6cf4',
'Types/Struct.cs':'12cb52e04fe9aba281798d1997ec347c6bea789f053e7dc4b8ec017fffdf8eba',
'Types/StackItem.cs':'3f80a40ab7b98352a92788da018c1ff168a7251340b1410661f7bcbfeaadff95',
'ExecutionEngine.cs':'ea906436ec48408abe92826547041859fb6195553f8e585816f1d96695663445',
'ExecutionContext.cs':'c2b7809e7306d3ea3ae68f15267ab4a2994cc0e0dea0b84bd9153e9003d4a197',
'Types/StackItemType.cs':'5f84ba615857815350c46a93eb8c1400d548baa6138a2fa0e0a9242b77f28d16',
'Types/PrimitiveType.cs':'ba8e9cb00fbcedbe5ce67bb9b11e59e59c6cff9e676c08e17d611ca0469fae37',
'Types/ByteString.cs':'1f06948358fcb638bffd14429a3d0ea50916da88c68c2de8933dea734aec0f52',
'Types/Buffer.cs':'ca517919538c03e134c1c53b9ab6394ab0dab59738eab6352c15df97c43ea755',
'Slot.cs':'4f017425c8b649ad2a2eddb4d405af85d2d78c0b868bcf243f492cbd33b82014'}
TOKEN=re.compile(r'\s+|//[^\n]*|/\*[\s\S]*?\*/|\$?"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|==|!=|<=|>=|&&|\|\||\+\+|--|=>|[{}()\[\];,.!+*\-/<>=?:@]')
def require(condition,message):
 if not condition: raise ValueError(message)
def sha(raw): return hashlib.sha256(raw).hexdigest()
def capture_sources(cache=None):
 root=Path(cache) if cache else Path(tempfile.gettempdir())/'sa-pinned-neovm-collection-004cd607';result={}
 for name,expected in SOURCE_HASHES.items():
  path=root/name
  if not path.exists():
   raw=urllib.request.urlopen(f'https://raw.githubusercontent.com/neo-project/neo-vm/{COMMIT}/src/Neo.VM/{name}',timeout=30).read()
   require(sha(raw)==expected,'Downloaded source mismatch '+name);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
  raw=path.read_bytes();require(sha(raw)==expected,'Source identity mismatch '+name);result[name]=raw.decode('utf-8')
 return result

def tokenize(text):
 items=[];end=0
 for m in TOKEN.finditer(text):
  require(m.start()==end,'Unknown token '+text[end:end+30]);end=m.end();v=m.group()
  if not v.isspace() and not v.startswith(('//','/*')): items.append(v)
 require(end==len(text),'Unknown source tail');return items

def method_tokens(text,method):
 require('namespace Neo.VM;' in text,'Unknown namespace')
 matches=list(re.finditer(r'public virtual void\s+'+re.escape(method)+r'\(ExecutionEngine engine, Instruction instruction\)\s*\{',text))
 require(len(matches)==1,'Handler declaration missing/duplicate '+method)
 tail=text[matches[0].end()-1:];items=[];depth=0;position=0
 while position<len(tail):
  m=TOKEN.match(tail,position);require(m is not None,'Unknown handler token');position=m.end();v=m.group()
  if v.isspace() or v.startswith(('//','/*')): continue
  if v=='{': depth+=1
  if v=='}': depth-=1
  items.append(v)
  if depth==0: return items[1:-1]
 raise ValueError('Unterminated handler')
def compact(items): return ''.join(items)
STRING=r'\$?"(?:\\.|[^"\\])*"'
THROW=r'thrownew(?:InvalidOperationException|CatchableException)\('+STRING+r'\);'
CMP=r'(<|>|<=|>=|==|!=)'
def matched(pattern,text,label):
 m=re.fullmatch(pattern,text);require(m is not None,'Unknown/extra '+label+' source operations');return m

def switch_array(items):
 marker=['switch','(','x',')','{'];position=next((i for i in range(len(items)) if items[i:i+5]==marker),None)
 require(position is not None,'Missing receiver switch');prefix=items[:position];parts={};i=position+5
 while i<len(items)-1:
  if items[i]=='case':
   typ,name,colon=items[i+1:i+4];require(colon==':','Unknown case declaration');i+=4
   require(items[i]=='{','Case block required');i+=1;depth=1;body=[]
   while depth:
    t=items[i];i+=1
    if t=='{':depth+=1
    if t=='}':depth-=1
    if depth:body.append(t)
   require(typ not in parts,'Duplicate switch type');parts[typ]={'binding':name,'tokens':body}
  elif items[i]=='default':
   require(items[i+1]==':','Default case');parts['default']={'tokens':items[i+2:-1]};i=len(items)-1
  else: raise ValueError('Unknown switch structure')
 require(i==len(items)-1 and items[-1]=='}','Additional operations after switch')
 return prefix,parts

def parse_collection(text,method):
 items=method_tokens(text,method);body=compact(items)
 if method in ('PickItem','SetItem'):
  prefix,cases=switch_array(items);p=compact(prefix)
  expected=['VMArray','Map','PrimitiveType','Buffer','default'] if method=='PickItem' else ['VMArray','Map','Buffer','default']
  require(list(cases)==expected and cases['VMArray']['binding']=='array','Unknown receiver switch bindings')
  unsupported={k:{'kind':'unsupported-source-branch','tokens':v['tokens']} for k,v in cases.items() if k!='VMArray'}
  a=compact(cases['VMArray']['tokens']);guard=r'varindex=key.GetInteger\(\);if\(index'+CMP+r'([0-9]+)\|\|index'+CMP+r'array.Count\)'+THROW
  if method=='PickItem':
   require(p=='varkey=engine.Pop<PrimitiveType>();varx=engine.Pop();','Unknown PICKITEM prefix')
   m=matched(guard+r'engine.Push\(array\[\(int\)index(?:([+-])([0-9]+))?\]\);break;',a,'Array PICKITEM')
   offset=(int(m[5])*(1 if m[4]=='+' else -1)) if m[4] else 0
   return dict(kind='ArrayPickProgram',popOrder=['key:PrimitiveType','receiver:StackItem'],lowerComparison=m[1],lowerBound=int(m[2]),upperComparison=m[3],indexOffset=offset,unsupportedBranches=unsupported,sourceTokens=items)
  require(p=='varvalue=engine.Pop();if(valueisStructs)value=s.Clone(engine.Limits);varkey=engine.Pop<PrimitiveType>();varx=engine.Pop();','Unknown SETITEM prefix')
  tail=r'vari=\(int\)index;if\(array.IsStackReferenced\)engine.ReferenceCounter.RemoveStackReference\(array\[i\]\);array\[i(?:([+-])([0-9]+))?\]=(value|key);if\(array.IsStackReferenced\)engine.ReferenceCounter.AddStackReference\(value\);break;'
  m=matched(guard+tail,a,'Array SETITEM');offset=(int(m[5])*(1 if m[4]=='+' else -1)) if m[4] else 0
  return dict(kind='ArraySetProgram',popOrder=['assigned:StackItem','key:PrimitiveType','receiver:StackItem'],cloneStructBeforeKeyPop=True,lowerComparison=m[1],lowerBound=int(m[2]),upperComparison=m[3],indexOffset=offset,valueSource=m[6],unsupportedBranches=unsupported,sourceTokens=items)
 if method=='Pack':
  pattern=r'varsize=\(int\)engine.Pop\(\).GetInteger\(\);if\(size'+CMP+r'([0-9]+)\|\|size'+CMP+r'engine.CurrentContext!.EvaluationStack.Count\)'+THROW+r'(VMArray|Struct)array=new\(\);for\(vari=([0-9]+);i'+CMP+r'size;i(\+\+|--)\)\{varitem=engine.Pop\(\);array.Add\(item\);\}engine.Push\(array\);'
  m=matched(pattern,body,'PACK');return dict(kind='CountedPackProgram',countCast='checked-int32',lowerComparison=m[1],lowerBound=int(m[2]),upperComparison=m[3],allocationType=m[4],loopStart=int(m[5]),loopComparison=m[6],loopStep=1 if m[7]=='++' else -1,sourceTokens=items)
 if method in ('NewStruct0','NewArray0'):
  m=matched(r'engine.Push\(new(Struct|VMArray)\(\)\);',body,'fresh allocation');return dict(kind='EmptyAllocationProgram',allocationType=m[1],sourceTokens=items)
 if method.startswith('Push'):
  m=re.fullmatch(r'engine.Push\(([0-9]+|StackItem.Null)\);',body)
  if m: return dict(kind='PushLiteralProgram',value=None if m[1]=='StackItem.Null' else int(m[1]),sourceTokens=items)
  m=matched(r'engine.Limits.AssertMaxItemSize\(instruction.Operand.Length\);engine.Push\(instruction.Operand\);',body,'PUSHDATA1')
  return dict(kind='PushOperandProgram',limit='MaxItemSize',sourceTokens=items)
 if method=='IsType':
  pattern=r'varx=engine.Pop\(\);vartype=\(StackItemType\)instruction.TokenU8;if\(type==StackItemType.Any\|\|!Enum.IsDefined\(type\)\)'+THROW+r'engine.Push\(x.Type(==|!=)type\);'
  m=matched(pattern,body,'ISTYPE');return dict(kind='ArrayTypeProjectionProgram',comparison=m[1],sourceTokens=items)
 if method=='Convert':
  matched(r'varx=engine.Pop\(\);engine.Push\(x.ConvertTo\(\(StackItemType\)instruction.TokenU8\)\);',body,'CONVERT')
  return dict(kind='ByteBufferConversionProjectionProgram',sourceTokens=items)
 if method=='Size':
  pattern=r'varx=engine.Pop\(\);switch\(x\)\{caseCompoundTypecompound:engine.Push\(compound.Count\);break;casePrimitiveTypeprimitive:engine.Push\(primitive.Size\);break;caseBufferbuffer:engine.Push\(buffer.Size\);break;default:'+THROW+r'\}'
  matched(pattern,body,'SIZE');return dict(kind='ArraySizeProjectionProgram',sourceTokens=items,unsupportedBranches=['Integer/Boolean encoded size','Map count','Buffer/ByteString size handled by opaque API outside this projection'])
 if method=='Ret':
  pattern=r'varcontext_pop=engine.InvocationStack.Pop\(\);varstack_eval=engine.InvocationStack.Count==0\?engine.ResultStack:engine.InvocationStack.Peek\(\).EvaluationStack;if\(context_pop.EvaluationStack(==|!=)stack_eval\)\{if\(context_pop.RVCount>=0&&context_pop.EvaluationStack.Count!=context_pop.RVCount\)'+THROW+r'context_pop.EvaluationStack.CopyTo\(stack_eval\);\}if\(engine.InvocationStack.Count==0\)engine.State=VMState.HALT;engine.ContextUnloaded\(context_pop\);engine.isJumping=(true|false);'
  m=matched(pattern,body,'RET');return dict(kind='SharedReturnProgram',copyComparison=m[1],jumping=m[2]=='true',unsupportedBranches=['distinct evaluation stacks CopyTo/RVCount validation','terminal HALT/result stack','ContextUnloaded overrides and caller continuation'],sourceTokens=items)
 if method=='InitSlot':
  pattern=r'if\(engine.CurrentContext!.LocalVariables!=null\|\|engine.CurrentContext.Arguments!=null\)'+THROW+r'if\(instruction.TokenU16==([0-9]+)\)'+THROW+r'if\(instruction.TokenU8>0\)\{engine.CurrentContext.LocalVariables=newSlot\(instruction.(TokenU8(?:_1)?),engine.ReferenceCounter\);\}if\(instruction.TokenU8_1>0\)\{varitems=newStackItem\[instruction.TokenU8_1\];for\(vari=([0-9]+);i'+CMP+r'instruction.TokenU8_1;i(\+\+|--)\)\{items\[i\]=engine.Pop\(\);\}engine.CurrentContext.Arguments=newSlot\(items,engine.ReferenceCounter\);\}'
  m=matched(pattern,body,'INITSLOT');return dict(kind='EntryInitSlotProgram',rejectOperand=int(m[1]),localCountOperand=m[2],loopStart=int(m[3]),loopComparison=m[4],loopStep=1 if m[5]=='++' else -1,requiresAbsentSlots=True,sourceTokens=items)
 raise ValueError('Unsupported handler grammar '+method)

def api_method_tokens(text,declaration):
 m=re.search(re.escape(declaration)+r'\s*\{',text);require(m is not None,'Missing typed API declaration')
 position=m.end()-1;depth=0;items=[]
 while position<len(text):
  token=TOKEN.match(text,position);require(token is not None,'Unknown typed API token');position=token.end();t=token.group()
  if t.isspace() or t.startswith(('//','/*')):continue
  if t=='{':depth+=1
  if t=='}':depth-=1
  items.append(t)
  if depth==0:return items[1:-1]
 raise ValueError('Unclosed API')
def parse_primitive_buffer_api(text):
 items=api_method_tokens(text,'public override StackItem ConvertTo(StackItemType type)')
 pattern=r'if\(type==Type\)returnthis;returntypeswitch\{StackItemType.Integer=>GetInteger\(\),StackItemType.ByteString=>Memory,StackItemType.Buffer=>newBuffer\(GetSpan\(\)(?:.Slice\(([0-9]+)\))?\),_=>base.ConvertTo\(type\)\};'
 m=matched(pattern,compact(items),'PrimitiveType.ConvertTo')
 span=api_method_tokens(text,'public sealed override ReadOnlySpan<byte> GetSpan()')
 matched(r'returnMemory.Span;',compact(span),'PrimitiveType.GetSpan')
 return dict(kind='PrimitiveBufferCopyProjection',spanDrop=0 if m[1] is None else int(m[1]),sourceTokens=items,getSpanTokens=span,unsupportedBranches=['Integer and ByteString conversion branches','base converter other targets'])

def parse_array_api(text):
 require('namespace Neo.VM.Types;' in text,'Unknown array namespace')
 count=matched(r'InnerList.Count',re.search(r'public override int Count => ([^;]+);',text)[1],'Array.Count')
 begin=text.index('public StackItem this[int index]');opening=text.index('{',begin);cursor=opening;depth=0;items=[]
 while cursor<len(text):
  token=TOKEN.match(text,cursor);require(token is not None,'Unknown array indexer token');cursor=token.end();t=token.group()
  if t.isspace() or t.startswith(('//','/*')):continue
  if t=='{':depth+=1
  if t=='}':depth-=1
  items.append(t)
  if depth==0:break
 body=compact(items[1:-1])
 body=re.sub(r'\[MethodImpl\(MethodImplOptions.AggressiveInlining\)\]','',body)
 pattern=r'get=>InnerList\[index(?:([+-])([0-9]+))?\];set\{if\(IsReadOnly\)'+THROW+r'InnerList\[index\]=value;\}'
 m=matched(pattern,body,'Array indexer')
 offset=(int(m[2])*(1 if m[1]=='+' else -1)) if m[1] else 0
 add_match=re.search(r'public void Add\(StackItem item\)\s*\{([\s\S]*?)\n    \}',text);require(add_match is not None,'Array.Add missing')
 matched(r'if\(IsReadOnly\)'+THROW+r'InnerList.Add\(item\);',compact(tokenize(add_match[1])),'Array.Add')
 return dict(kind='MutableArrayApiProjection',getterIndexOffset=offset,setterReadonlyGuard=True,setterValue='value',countSource='InnerList.Count',appendOperation='InnerList.Add',sourceTokens=items)

HANDLERS={'SIZE':('Compound','Size'),'ISTYPE':('Types','IsType'),'CONVERT':('Types','Convert'),'RET':('Control','Ret'),'PICKITEM':('Compound','PickItem'),'SETITEM':('Compound','SetItem'),'PACK':('Compound','Pack'),'NEWSTRUCT0':('Compound','NewStruct0'),'NEWARRAY0':('Compound','NewArray0'),'INITSLOT':('Slot','InitSlot'),'PUSHDATA1':('Push','PushData1'),'PUSHNULL':('Push','PushNull')}
HANDLERS.update({f'PUSH{i}':('Push',f'Push{i}') for i in (0,1,2,4,5)})
def extract(cache=None):
 texts=capture_sources(cache)
 api=parse_array_api(texts['Types/Array.cs'])
 enum=dict((name,int(code,16)) for name,code in re.findall(r'(\w+)\s*=\s*0x([0-9A-Fa-f]+)',texts['Types/StackItemType.cs']))
 require(enum=={'Any':0,'Pointer':16,'Boolean':32,'Integer':33,'ByteString':40,'Buffer':48,'Array':64,'Struct':65,'Map':72,'InteropInterface':96},'Type enum mapping drift')
 require(re.search(r'public override StackItemType Type => StackItemType.Array;',texts['Types/Array.cs']) is not None,'Unknown Array type projection')
 primitiveApi=parse_primitive_buffer_api(texts['Types/PrimitiveType.cs'])
 base=compact(api_method_tokens(texts['Types/StackItem.cs'],'public virtual StackItem ConvertTo(StackItemType type)'))
 matched(r'if\(type==Type\)returnthis;if\(type==StackItemType.Boolean\)returnGetBoolean\(\);thrownewInvalidCastException\(\);',base,'StackItem same-type converter')
 buffer=compact(api_method_tokens(texts['Types/Buffer.cs'],'public override StackItem ConvertTo(StackItemType type)'))
 matched(r'switch\(type\)\{caseStackItemType.Integer:if\(InnerBuffer.Length>Integer.MaxSize\)thrownewInvalidCastException\(\);returnnewBigInteger\(InnerBuffer.Span\);caseStackItemType.ByteString:byte\[\]clone=GC.AllocateUninitializedArray<byte>\(InnerBuffer.Length\);InnerBuffer.CopyTo\(clone\);returnclone;default:returnbase.ConvertTo\(type\);\}',buffer,'Buffer default same-type converter')
 require('public override StackItemType Type => StackItemType.Struct;' in texts['Types/Struct.cs'],'Struct type binding drift')
 programs={opcode:parse_collection(texts[f'JumpTable/JumpTable.{group}.cs'],method) for opcode,(group,method) in HANDLERS.items()}
 programs['PICKITEM']['indexOffset']+=api['getterIndexOffset']
 programs['CONVERT']['spanDrop']=primitiveApi['spanDrop']
 return dict(primitiveBufferApi=primitiveApi,typeEnum=enum,arrayApi=api,schema='neoos-sa-runtime-collection-source/v1',sourceCommit=COMMIT,sourceSha256=SOURCE_HASHES,programs=programs,unsupported=['RET caller continuation/unload and distinct result stack contracts','ISTYPE only Array/Struct; CONVERT only ByteString/Buffer to Buffer contents; SIZE only Array/Struct count; other typed runtime APIs unsupported','Map/PrimitiveType/Buffer switch branches','Struct-valued SETITEM cloning','readonly and reference-counter/resource semantics','C# extraction and compiled DLL binding'])
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source-cache',type=Path);a=p.parse_args();print(json.dumps(extract(a.source_cache),separators=(',',':')))
if __name__=='__main__':main()
