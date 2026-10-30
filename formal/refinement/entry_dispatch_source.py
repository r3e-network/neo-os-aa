"""Strict complete-method projection of ordinary ABI admission/frame creation.

The bounded C# frontend and CLR/API/virtual-dispatch correspondence remain TCB.
No initializer/body/RET is executed and no deployed state is authenticated.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request
CORE_COMMIT = 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d'
VM_COMMIT = '004cd6070a940405818d9357638277dd44407e2e'
SCOPE = 'ordinary-safe-public-abi-entry-frame-source-bridge'
ENTRY_BOUNDARY = 'CallContract-after-interop-admission-and-argument-conversion'
PRECONDITIONS = [
 'Entry is after interop flag admission, fee charging, argument conversion and stack pops.',
 'The deployed unblocked ordinary contract has the exact bound script and immutable unique ABI; ABI dictionary cache is coherent and the initializer projection equals its _initialize/0 lookup.',
 'Selected descriptor is safe and nonvoid; argument count equals arity and is at most 65535; flags use only the four declared bits.',
 'A current caller exists and invocation capacity accommodates method plus optional initializer; fresh frame/shared-state identities are supplied.',
 'Diagnostics are disabled and virtual calls use exactly the pinned ordinary Core/VM implementations without subclass/provider overrides.',
 'Policy, cache, fee, allocation and reference-counter operations succeed and do not interfere with projected frames; their other effects are outside the projection.'
]
UNPROVED = [
 'Interop syscall admission, fees, conversions, argument popping and input reachability.',
 'Trusted C# extraction, compiler/CLR correspondence, API bindings and deployed-state readback.',
 'Initializer/body execution, absolute-PC opcode composition, shared and distinct-stack RET, ContextUnloaded and caller continuation.',
 'Gas, resources, all exceptions, transaction rollback, host callbacks and aliased mutable-object effects.',
 'Whole ApplicationEngine execution and all 100 complete public entrypoints.'
]
TCB = ['Strict complete-method C# grammar and field/symbol binding.',
       'C# object allocation/default-field semantics and framework dictionary/stack APIs.',
       'Externally supplied successful noninterfering environment, freshness, immutable manifest and exact virtual dispatch.']

def require(condition, message):
    if not condition: raise ValueError(message)
def sha(raw): return hashlib.sha256(raw).hexdigest()
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':')).encode()

SOURCES = {'core/engine': {'repository': 'neo',
                 'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                 'relativePath': 'src/Neo/SmartContract/ApplicationEngine.cs',
                 'sha256': '97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb'},
 'core/contract': {'repository': 'neo',
                   'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                   'relativePath': 'src/Neo/SmartContract/ApplicationEngine.Contract.cs',
                   'sha256': '8958efff155cb407fef140dea11a516b9f08ab10feecf1b3c39d986d79801a96'},
 'core/abi': {'repository': 'neo',
              'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
              'relativePath': 'src/Neo/SmartContract/Manifest/ContractAbi.cs',
              'sha256': '9313d6709261c83ce19371d3e46dc29adee143c2032433d2b607e84b95865ed2'},
 'core/flags': {'repository': 'neo',
                'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                'relativePath': 'src/Neo/SmartContract/CallFlags.cs',
                'sha256': '4f3fc9ded9c32eca754e735337251d0cc5ce3b7ad13aa64551d427b1688d13d1'},
 'core/basic': {'repository': 'neo',
                'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                'relativePath': 'src/Neo/SmartContract/ContractBasicMethod.cs',
                'sha256': '51a8e0949784ec536f69a69ada6f98088ac38c27468696edef3420a65e1e757b'},
 'core/state': {'repository': 'neo',
                'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                'relativePath': 'src/Neo/SmartContract/ExecutionContextState.cs',
                'sha256': 'd08d47dc43f00070b5a2248556efa8afc7ff5f24db2d96d9a8712101eaa925d8'},
 'vm/context': {'repository': 'neo-vm',
                'commit': '004cd6070a940405818d9357638277dd44407e2e',
                'relativePath': 'src/Neo.VM/ExecutionContext.cs',
                'sha256': 'c2b7809e7306d3ea3ae68f15267ab4a2994cc0e0dea0b84bd9153e9003d4a197'},
 'vm/shared': {'repository': 'neo-vm',
               'commit': '004cd6070a940405818d9357638277dd44407e2e',
               'relativePath': 'src/Neo.VM/ExecutionContext.SharedStates.cs',
               'sha256': '82b9c8e71b38117eb2cb658bd5ca7b42cad682eaa38a53d32109052dece6bdda'},
 'vm/engine': {'repository': 'neo-vm',
               'commit': '004cd6070a940405818d9357638277dd44407e2e',
               'relativePath': 'src/Neo.VM/ExecutionEngine.cs',
               'sha256': 'ea906436ec48408abe92826547041859fb6195553f8e585816f1d96695663445'},
 'vm/stack': {'repository': 'neo-vm',
              'commit': '004cd6070a940405818d9357638277dd44407e2e',
              'relativePath': 'src/Neo.VM/EvaluationStack.cs',
              'sha256': '7190a363cd8c71010c2a98987f5aadd331adeff4d3551b1bc9e1d8cd7a56ac3e'}}

HEADERS = {'CallContract': ('core/contract',
                  'protected internal void CallContract(UInt160 contractHash, string method, CallFlags '
                  'callFlags, Array args)'),
 'CallContractInternal': ('core/engine',
                          'private ExecutionContext CallContractInternal(ContractState contract, '
                          'ContractMethodDescriptor method, CallFlags flags, bool hasReturnValue, '
                          'IReadOnlyList<StackItem> args)'),
 'LoadContract': ('core/engine',
                  'public ExecutionContext LoadContract(ContractState contract, ContractMethodDescriptor '
                  'method, CallFlags callFlags)'),
 'LoadScript': ('core/engine',
                'public ExecutionContext LoadScript(Script script, int rvcount = -1, int initialPosition = '
                '0, Action<ExecutionContextState>? configureState = null)'),
 'CoreLoadContext': ('core/engine', 'public override void LoadContext(ExecutionContext context)'),
 'GetMethod': ('core/abi', 'public ContractMethodDescriptor? GetMethod(string name, int pcount)'),
 'Clone': ('vm/context', 'public ExecutionContext Clone(int initialPosition)'),
 'ContextConstructor': ('vm/context',
                        'private ExecutionContext(SharedStates sharedStates, int rvcount, int '
                        'initialPosition)'),
 'FreshContextConstructor': ('vm/context',
                             'internal ExecutionContext(Script script, int rvcount, IReferenceCounter '
                             'referenceCounter)\n'
                             '        : this(new SharedStates(script, referenceCounter), rvcount, 0)'),
 'GetState': ('vm/context', 'public T GetState<T>(Func<T>? factory = null) where T : class, new()'),
 'SharedConstructor': ('vm/shared', 'public SharedStates(Script script, IReferenceCounter referenceCounter)'),
 'VmLoadContext': ('vm/engine', 'public virtual void LoadContext(ExecutionContext context)'),
 'CreateContext': ('vm/engine',
                   'protected ExecutionContext CreateContext(Script script, int rvcount, int '
                   'initialPosition)'),
 'StackConstructor': ('vm/stack', 'internal EvaluationStack(IReferenceCounter referenceCounter)'),
 'Push': ('vm/stack', 'public void Push(StackItem item)')}

TEMPLATES = {'CallContract': '{if(method.StartsWith(\'_\'))thrownewArgumentException($"Method name \'{method}\' cannot '
                 'start with '
                 'underscore.",nameof(method));if((callFlags&~CallFlags.All)!=0)thrownewArgumentOutOfRangeException(nameof(callFlags));ContractState?contract=NativeContract.ContractManagement.GetContract(SnapshotCache,contractHash);if(contractisnull)thrownewInvalidOperationException($"Called '
                 'Contract Does Not Exist: '
                 '{contractHash}.{method}");ContractMethodDescriptor?md=contract.Manifest.Abi.GetMethod(method,args.Count);if(mdisnull)thrownewInvalidOperationException($"Method '
                 '\\"{method}\\" with {args.Count} parameter(s) doesn\'t exist in the contract '
                 '{contractHash}.");boolhasReturnValue=md.ReturnType!=ContractParameterType.Void;ExecutionContextcontext=CallContractInternal(contract,md,callFlags,hasReturnValue,args);context.GetState<ExecutionContextState>().IsDynamicCall=true;}',
 'CallContractInternal': '{if(NativeContract.Policy.IsBlocked(SnapshotCache,contract.Hash))thrownewInvalidOperationException($"The '
                         'contract {contract.Hash} has been '
                         'blocked.");ExecutionContextcurrentContext=CurrentContext!;ExecutionContextStatestate=currentContext.GetState<ExecutionContextState>();if(method.Safe){flags&=~(CallFlags.WriteStates|CallFlags.AllowNotify);}else{varexecutingContract=IsHardforkEnabled(Hardfork.HF_Domovoi)?state.Contract:NativeContract.ContractManagement.GetContract(SnapshotCache,CurrentScriptHash!);if(executingContract?.CanCall(contract,method.Name)==false)thrownewInvalidOperationException($"Cannot '
                         'Call Method {method.Name} Of Contract {contract.Hash} From Contract '
                         '{CurrentScriptHash}");}if(invocationCounter.TryGetValue(contract.Hash,outvarcounter)){invocationCounter[contract.Hash]=counter+1;}else{invocationCounter[contract.Hash]=1;}CallFlagscallingFlags=state.CallFlags;if(args.Count!=method.Parameters.Length)thrownewInvalidOperationException($"Method '
                         '{method} Expects {method.Parameters.Length} Arguments But Receives {args.Count} '
                         'Arguments");if(hasReturnValue^(method.ReturnType!=ContractParameterType.Void))thrownewInvalidOperationException("The '
                         'return value type does not '
                         'match.");varcontextNew=LoadContract(contract,method,flags&callingFlags);state=contextNew.GetState<ExecutionContextState>();state.CallingContext=currentContext;if(IsHardforkEnabled(Hardfork.HF_Faun)&&NativeContract.Policy.IsWhitelistFeeContract(SnapshotCache,contract.Hash,method,outvarfixedFee)){AddFee(fixedFee.Value,true);state.WhiteListed=true;}for(inti=args.Count-1;i>=0;i--)contextNew.EvaluationStack.Push(args[i]);returncontextNew;}',
 'LoadContract': '{ExecutionContextcontext=LoadScript(contract.Script,rvcount:method.ReturnType==ContractParameterType.Void?0:1,initialPosition:method.Offset,configureState:p=>{p.CallFlags=callFlags;p.ScriptHash=contract.Hash;p.Contract=newContractState{Id=contract.Id,UpdateCounter=contract.UpdateCounter,Hash=contract.Hash,Nef=contract.Nef,Manifest=contract.Manifest};});varinit=contract.Manifest.Abi.GetMethod(ContractBasicMethod.Initialize,ContractBasicMethod.InitializePCount);if(initisnotnull){LoadContext(context.Clone(init.Offset));}returncontext;}',
 'LoadScript': '{ExecutionContextcontext=CreateContext(script,rvcount,initialPosition);ExecutionContextStatestate=context.GetState<ExecutionContextState>();state.SnapshotCache=SnapshotCache?.CloneCache();configureState?.Invoke(state);LoadContext(context);returncontext;}',
 'CoreLoadContext': '{varstate=context.GetState<ExecutionContextState>();state.ScriptHash??=((ReadOnlyMemory<byte>)context.Script).Span.ToScriptHash();invocationCounter.TryAdd(state.ScriptHash,1);base.LoadContext(context);Diagnostic?.ContextLoaded(context);}',
 'GetMethod': '{if(pcount<-1||pcount>ushort.MaxValue)thrownewArgumentOutOfRangeException(nameof(pcount),$"`pcount` '
              'must be between [-1, '
              '{ushort.MaxValue}]");if(pcount>=0){methodDictionary??=Methods.ToDictionary(p=>(p.Name,p.Parameters.Length));if(methodDictionary.TryGetValue((name,pcount),outvarmethod))returnmethod;returnnull;}else{returnMethods.FirstOrDefault(p=>p.Name==name);}}',
 'Clone': '{returnnewExecutionContext(_sharedStates,0,initialPosition);}',
 'ContextConstructor': '{if(rvcount<-1||rvcount>ushort.MaxValue)thrownewArgumentOutOfRangeException(nameof(rvcount),$"Out '
                       'of range: '
                       '{rvcount}");_sharedStates=sharedStates;RVCount=rvcount;InstructionPointer=initialPosition;}',
 'FreshContextConstructor': '{}',
 'GetState': '{if(!_sharedStates.States.TryGetValue(typeof(T),outvarvalue)){value=factoryisnull?newT():factory();_sharedStates.States[typeof(T)]=value;}return(T)value;}',
 'SharedConstructor': '{Script=script;EvaluationStack=new(referenceCounter);States=new();}',
 'VmLoadContext': '{if(InvocationStack.Count>=Limits.MaxInvocationStackSize)thrownewInvalidOperationException($"MaxInvocationStackSize '
                  'exceed: '
                  '{InvocationStack.Count}");InvocationStack.Push(context);EntryContext??=context;CurrentContext=context;}',
 'CreateContext': '{returnnewExecutionContext(script,rvcount,ReferenceCounter){InstructionPointer=initialPosition};}',
 'StackConstructor': '{_referenceCounter=referenceCounter;}',
 'Push': '{_innerList.Add(item);_referenceCounter.AddStackReference(item);}'}

from csharp_tokens import TOKENIZER as TOKEN

BASE_PROGRAM = dict(exact_arity=True, reject_underscore=True, check_count=True, check_return=True,
    allowed_flags=15, safe_clear_mask=10, intersect_flags=True, nonvoid_rv=1, void_rv=0,
    offset_delta=0, reverse_push=True, initializer_first=True, clone_shared=True, clone_rv=0,
    record_caller=True, dynamic=True, max_arity=65535)
# Each accepted alternate consumes a complete valid source expression/statement.
# Only the production file hashes are admitted by project_production; alternates
# are used to test the source projection and kernel rejection of changed behavior.
PATCHES = {
 'CallContract': [
  ("method.StartsWith('_')", {"false":dict(reject_underscore=False)}),
  ('IsDynamicCall=true', {'IsDynamicCall=false':dict(dynamic=False)})],
 'CallContractInternal': [
  ('flags&=~(CallFlags.WriteStates|CallFlags.AllowNotify);', {'flags&=~CallFlags.None;':dict(safe_clear_mask=0)}),
  ('LoadContract(contract,method,flags&callingFlags)', {'LoadContract(contract,method,flags|callingFlags)':dict(intersect_flags=False)}),
  ('state.CallingContext=currentContext;', {'state.CallingContext=null;':dict(record_caller=False)}),
  ('for(inti=args.Count-1;i>=0;i--)', {'for(inti=0;i<args.Count;i++)':dict(reverse_push=False)})],
 'LoadContract': [
  ('rvcount:method.ReturnType==ContractParameterType.Void?0:1', {'rvcount:method.ReturnType==ContractParameterType.Void?1:0':dict(nonvoid_rv=0,void_rv=1)}),
  ('initialPosition:method.Offset,', {'initialPosition:method.Offset+1,':dict(offset_delta=1)}),
  ('LoadContext(context.Clone(init.Offset));', {'InvocationStack.Pop();LoadContext(context.Clone(init.Offset));LoadContext(context);':dict(initializer_first=False)})],
 'Clone': [
  ('newExecutionContext(_sharedStates,0,initialPosition)', {
   'newExecutionContext(_sharedStates,1,initialPosition)':dict(clone_rv=1),
   'newExecutionContext(newSharedStates(Script,EvaluationStack.ReferenceCounter),0,initialPosition)':dict(clone_shared=False)})],
 'GetMethod': [('pcount>ushort.MaxValue', {'pcount>0':dict(max_arity=0)})]}
CONTROL_MUTATIONS = {
 'drop-safe-mask': ('core/engine', 'flags &= ~(CallFlags.WriteStates | CallFlags.AllowNotify);', 'flags &= ~CallFlags.None;'),
 'caller-flags-union': ('core/engine', 'LoadContract(contract, method, flags & callingFlags)', 'LoadContract(contract, method, flags | callingFlags)'),
 'wrong-return-count': ('core/engine', 'rvcount: method.ReturnType == ContractParameterType.Void ? 0 : 1', 'rvcount: method.ReturnType == ContractParameterType.Void ? 1 : 0'),
 'wrong-entry-offset': ('core/engine', 'initialPosition: method.Offset,', 'initialPosition: method.Offset + 1,'),
 'reverse-argument-order': ('core/engine', 'for (int i = args.Count - 1; i >= 0; i--)', 'for (int i = 0; i < args.Count; i++)'),
 'initializer-after-method': ('core/engine', 'LoadContext(context.Clone(init.Offset));', 'InvocationStack.Pop(); LoadContext(context.Clone(init.Offset)); LoadContext(context);'),
 'fresh-initializer-state': ('vm/context', 'new ExecutionContext(_sharedStates, 0, initialPosition)', 'new ExecutionContext(new SharedStates(Script, EvaluationStack.ReferenceCounter), 0, initialPosition)'),
 'wrong-initializer-return-count': ('vm/context', 'new ExecutionContext(_sharedStates, 0, initialPosition)', 'new ExecutionContext(_sharedStates, 1, initialPosition)'),
 'drop-calling-context': ('core/engine', 'state.CallingContext = currentContext;', 'state.CallingContext = null;'),
 'drop-dynamic-marker': ('core/contract', 'IsDynamicCall = true;', 'IsDynamicCall = false;'),
 'drop-underscore-guard': ('core/contract', "method.StartsWith('_')", 'false'),
 'wrong-arity-bound': ('core/abi', 'pcount > ushort.MaxValue', 'pcount > 0')}
EXPECTED_CONTROLS = tuple(CONTROL_MUTATIONS)

def body(text, header):
    require(text.count(header) == 1, 'Missing/ambiguous complete method declaration: '+header)
    tail = text[text.index(header)+len(header):]
    position = depth = 0; items = []
    while position < len(tail):
        match = TOKEN.match(tail, position)
        require(match is not None, 'Unsupported source token')
        position = match.end(); token = match.group()
        if token.isspace() or token.startswith(('//','/*')): continue
        require(items or token == '{', 'Expected complete method block')
        items.append(token); depth += int(token == '{') - int(token == '}')
        if depth == 0: return ''.join(items)
    raise ValueError('Unterminated method body')

def parse_method(name, actual):
    baseline = TEMPLATES[name]; slots = PATCHES.get(name, [])
    pattern = re.escape(baseline); choices = []
    for index,(original,alternates) in enumerate(slots):
        require(baseline.count(original) == 1, 'Ambiguous source grammar slot')
        values = {original:{}, **alternates}; choices.append(values)
        group = '(?P<s'+str(index)+'>'+ '|'.join(re.escape(s) for s in sorted(values,key=len,reverse=True))+')'
        pattern = pattern.replace(re.escape(original), group, 1)
    match = re.fullmatch(pattern, actual)
    require(match is not None, 'Unknown/extra complete source operations in '+name)
    updates = {}
    for index,values in enumerate(choices): updates.update(values[match['s'+str(index)]])
    return updates

def project_sources(contents, *, enforce_identity=True):
    require(set(contents) == set(SOURCES), 'Incomplete/extra ordinary source set')
    if enforce_identity:
        for key,text in contents.items(): require(sha(text.encode()) == SOURCES[key]['sha256'], 'Pinned source mismatch: '+key)
    # SharedStates allocation, shared custom state, stack allocation/defaults,
    # ABI initialization names and enum bits are explicit reviewed dependencies.
    fragments = {
     'vm/shared':['public readonly EvaluationStack EvaluationStack;','public Slot? StaticFields;','public readonly Dictionary<Type, object> States;'],
     'vm/context':['public EvaluationStack EvaluationStack => _sharedStates.EvaluationStack;', 'get => _sharedStates.StaticFields;', 'set => _sharedStates.StaticFields = value;', 'public Slot? LocalVariables { get; internal set; }', 'public Slot? Arguments { get; internal set; }'],
     'vm/stack':['private readonly List<StackItem> _innerList = [];'],
     'core/basic':['public static string Initialize { get; } = "_initialize";', 'public static int InitializePCount { get; } = 0;']}
    for key,needles in fragments.items():
        for needle in needles: require(contents[key].count(needle)==1, 'Changed field/initializer source binding: '+needle)
    flags = {name:int(value,0) for name,value in re.findall(r'^\s*(ReadStates|WriteStates|AllowCall|AllowNotify)\s*=\s*(0b[01]+)', contents['core/flags'],re.M)}
    require(flags == dict(ReadStates=1,WriteStates=2,AllowCall=4,AllowNotify=8), 'Changed call flag definitions')
    require(all(contents['core/flags'].count(x)==1 for x in ['None = 0,','States = ReadStates | WriteStates,','All = States | AllowCall | AllowNotify']), 'Changed CallFlags combined definitions')
    program = dict(BASE_PROGRAM); methods = {}
    for name,(key,header) in HEADERS.items():
        text = body(contents[key],header); program.update(parse_method(name,text))
        methods[name] = dict(source=key,declaration=header,bodyTokens=text,bodySha256=sha(text.encode()))
    result = dict(schema='neoos-aa-entry-dispatch-source/v1',scope=SCOPE,entryBoundary=ENTRY_BOUNDARY,
        coreSourceCommit=CORE_COMMIT,neoVmSourceCommit=VM_COMMIT,
        sourceHashes={k:sha(v.encode()) for k,v in contents.items()},methods=methods,program=program,
        initializationName='_initialize',initializationArity=0,preconditions=PRECONDITIONS,
        unproved=UNPROVED,tcb=TCB,sourceFrontendVerified=False)
    return result

def source_url(row):
    return 'https://raw.githubusercontent.com/neo-project/'+row['repository']+'/'+row['commit']+'/'+row['relativePath']

# Transport-level retry for the pinned-source download. A stalled connection
# raises the socket timeout before any bytes arrive, which is an environment
# fault rather than evidence about the source. Retrying cannot launder a wrong
# artifact: the caller still requires the downloaded bytes to hash to the pinned
# sha256, an HTTP status is never retried, and an exhausted retry set raises the
# last transport error so the lane still fails closed.
DOWNLOAD_ATTEMPT_TIMEOUTS = (30, 45, 60, 90)


def download_pinned(url):
    last_error = None
    for timeout in DOWNLOAD_ATTEMPT_TIMEOUTS:
        try:
            return urllib.request.urlopen(url,timeout=timeout).read()
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
            last_error = exc
    raise last_error


def mirror_source(key,row):
    """Return pinned bytes from a local mirror directory, or None.

    The pin, not the transport, is the evidence: mirror bytes must hash to the
    same pinned value a download would have to reach, so a mirror cannot launder
    a different artifact. This only substitutes for a stalled network, which is
    an environment fault rather than a fact about the source. Point
    AA_ENTRY_DISPATCH_SOURCE_MIRROR at a directory of previously fetched
    `<key>.cs` files to run the lane offline.
    """
    mirror=os.environ.get('AA_ENTRY_DISPATCH_SOURCE_MIRROR')
    if not mirror: return None
    candidate=Path(mirror)/(key.replace('/','-')+'.cs')
    if not candidate.is_file(): return None
    raw=candidate.read_bytes();require(sha(raw)==row['sha256'],'Offline mirror source mismatch')
    return raw


def project_production(directory):
    directory=Path(directory); directory.mkdir(parents=True,exist_ok=True)
    contents={}; rows={}
    for key,row in SOURCES.items():
        path=directory/(key.replace('/','-')+'.cs')
        if not path.exists():
            raw=mirror_source(key,row)
            if raw is None: raw=download_pinned(source_url(row))
            require(sha(raw)==row['sha256'],'Downloaded pinned source mismatch');path.write_bytes(raw)
        raw=path.read_bytes();require(sha(raw)==row['sha256'],'Pinned source file drift')
        contents[key]=raw.decode('utf-8');rows[key]=dict(path=str(path.resolve()),url=source_url(row),sha256=sha(raw))
    return project_sources(contents),rows

def project_captured(rows):
    require(isinstance(rows,dict) and set(rows)==set(SOURCES),'Missing/extra pinned source dependencies')
    paths=[];contents={}
    for key,expected in SOURCES.items():
        row=rows[key];require(set(row)=={'path','url','sha256'},'Malformed pinned source identity')
        path=Path(row['path']);require(path.is_absolute(),'Relative pinned source path');paths.append(str(path.resolve()))
        require(row['url']==source_url(expected) and row['sha256']==expected['sha256'],'Swapped/unpinned source URL/hash')
        raw=path.read_bytes();require(sha(raw)==expected['sha256'],'Pinned source bytes mismatch');contents[key]=raw.decode()
    require(len(paths)==len(set(paths)),'Duplicate pinned source paths')
    return project_sources(contents)

def mutated_projection(contents,name):
    require(name in CONTROL_MUTATIONS,'Unknown semantic mutant')
    key,before,after=CONTROL_MUTATIONS[name];changed=dict(contents)
    require(changed[key].count(before)==1,'Ambiguous semantic mutation')
    changed[key]=changed[key].replace(before,after)
    return project_sources(changed,enforce_identity=False),sha(changed[key].encode())
