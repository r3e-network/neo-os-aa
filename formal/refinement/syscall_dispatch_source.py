"""Strict projection of the System.Contract.Call and CALLT syscall layer.

EntryDispatch.v starts after interop admission and argument conversion. This
lane covers that prefix: which caller flags admit the path, which popped value
becomes the callee's `callFlags`, which order the arguments arrive in, and
where the two paths differ. It ends at the CallContractInternal parameter
tuple, so the projected record is a CallFrame EntryDispatch can consume.

Every field is derived from the pinned C# text. Nothing here is asserted: the
pop count comes from the handler's declared parameter list, the flag slot from
that parameter's declared type, the flag words from the source's own bit and
composite definitions, and the boolean decisions from which statements are
present. `fullImplementationVerified` stays false and no VM correspondence is
claimed.
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
SCOPE = 'system-contract-call-and-callt-admission-bridge'
ENTRY_BOUNDARY = 'CallContractInternal-parameter-tuple'
PRECONDITIONS = [
 'The caller context exists and its own CallFlags word is the one ValidateCallFlags inspects.',
 'For System.Contract.Call the interop descriptor is the pinned registration, the handler is CallContract with its four declared parameters, and the four stack values convert to those parameter types without fault.',
 'The converted Array argument carries the element list and the ABI lookup key (its length); both are supplied as opaque inputs.',
 'For CALLT the token comes from the called contract Nef.Tokens at the instruction token index and satisfies MethodToken.Deserialize, so its method never starts with underscore and its flag word has no bits above CallFlags.All.',
 'AddFee succeeds, Convert preserves the values, and no diagnostic callback observes the projections.',
 'The projected contract and manifest are the ones the caller names; policy, storage and invocation counters do not interfere before the handoff.',
]
UNPROVED = [
 'AddFee, gas metering and every resource exception on both paths; no cost is modelled.',
 'Convert and the Array payload element list; the callee argument vector for System.Contract.Call is an opaque input, not a stack window.',
 'Exception identity: every Rejected constructor is a fault, and whether it surfaces as InvalidOperationException, ArgumentException, ArgumentOutOfRangeException, FormatException or IndexOutOfRangeException is not modelled.',
 'Contract resolution, manifest/ABI storage reads, MethodToken deserialization at NEF load, policy whitelists and invocation counting.',
 'Trusted C# extraction and compiler/CLR correspondence; ApplicationEngine execution after the handoff; all 100 public entrypoints.',
]
TCB = ['Strict complete-method C# grammar and field/symbol binding.',
       'C# object allocation, boxing and framework stack/dictionary APIs.',
       'Externally supplied successful noninterfering environment and exact virtual dispatch.']

def require(condition, message):
    if not condition: raise ValueError(message)
def sha(raw): return hashlib.sha256(raw).hexdigest()
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':')).encode()

SOURCES = {
 'core/contract': {'repository': 'neo',
                   'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                   'relativePath': 'src/Neo/SmartContract/ApplicationEngine.Contract.cs',
                   'sha256': '8958efff155cb407fef140dea11a516b9f08ab10feecf1b3c39d986d79801a96'},
 'core/engine': {'repository': 'neo',
                 'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                 'relativePath': 'src/Neo/SmartContract/ApplicationEngine.cs',
                 'sha256': '97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb'},
 'core/flags': {'repository': 'neo',
                'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                'relativePath': 'src/Neo/SmartContract/CallFlags.cs',
                'sha256': '4f3fc9ded9c32eca754e735337251d0cc5ce3b7ad13aa64551d427b1688d13d1'},
 'core/descriptor': {'repository': 'neo',
                     'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                     'relativePath': 'src/Neo/SmartContract/InteropDescriptor.cs',
                     'sha256': '84c7d8ccc10c2832b7f76d4d4a147a09146524518a5ef81c4d0387443eb494ff'},
 'core/token': {'repository': 'neo',
                'commit': 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                'relativePath': 'src/Neo/SmartContract/MethodToken.cs',
                'sha256': '310d91742a751ed2d285bbf153cbaa838b8ee3433a0b58f68fadd62a77b2946b'},
 'vm/stack': {'repository': 'neo-vm',
              'commit': '004cd6070a940405818d9357638277dd44407e2e',
              'relativePath': 'src/Neo.VM/EvaluationStack.cs',
              'sha256': '7190a363cd8c71010c2a98987f5aadd331adeff4d3551b1bc9e1d8cd7a56ac3e'},
}

# The six pinned declarations whose bodies this lane reads. CallContract is the
# interop handler named by the registration; the five-argument
# CallContractInternal overload is the one OnCallT calls, so its two guards are
# part of this prefix even though the callback it delegates to is not.
SIGNATURES = {
 'CallContract': ('core/contract',
                  'protected internal void CallContract(UInt160 contractHash, string method, '
                  'CallFlags callFlags, Array args)'),
 'OnSysCall': ('core/engine', 'protected virtual void OnSysCall(InteropDescriptor descriptor)'),
 'ValidateCallFlags': ('core/engine',
                       'internal protected void ValidateCallFlags(CallFlags requiredCallFlags)'),
 'OnCallT': ('core/engine',
             'protected static void OnCallT(ExecutionEngine engine, Instruction instruction)'),
 'CallContractInternal': ('core/engine',
                          'private ExecutionContext CallContractInternal(UInt160 contractHash, '
                          'string method, CallFlags flags, bool hasReturnValue, StackItem[] args)'),
 'Register': ('core/engine',
              'protected static InteropDescriptor Register(string name, string handler, long '
              'fixedPrice, CallFlags requiredCallFlags, Hardfork? hardfork = null)'),
}

# The tokenizer is shared with the entry-dispatch lane so both lanes normalize
# C# identically; a divergence there would make the two projections
# incomparable.
from csharp_tokens import TOKENIZER as TOKEN

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

# Each template is the reviewed normalized body of one pinned declaration.
# A patch consumes a complete source expression and records what the
# substitution means for the projection. Flag words are re-derived from the
# matched text, so a widened or narrowed flag expression cannot slip through.
TEMPLATES = {
 'CallContract': "{if(method.StartsWith('_'))thrownewArgumentException($\"Method name '{method}' cannot start with underscore.\",nameof(method));if((callFlags&~CallFlags.All)!=0)thrownewArgumentOutOfRangeException(nameof(callFlags));ContractState?contract=NativeContract.ContractManagement.GetContract(SnapshotCache,contractHash);if(contractisnull)thrownewInvalidOperationException($\"Called Contract Does Not Exist: {contractHash}.{method}\");ContractMethodDescriptor?md=contract.Manifest.Abi.GetMethod(method,args.Count);if(mdisnull)thrownewInvalidOperationException($\"Method \\\"{method}\\\" with {args.Count} parameter(s) doesn't exist in the contract {contractHash}.\");boolhasReturnValue=md.ReturnType!=ContractParameterType.Void;ExecutionContextcontext=CallContractInternal(contract,md,callFlags,hasReturnValue,args);context.GetState<ExecutionContextState>().IsDynamicCall=true;}",
 'OnSysCall': '{ValidateCallFlags(descriptor.RequiredCallFlags);AddFee(descriptor.FixedPrice*_execFeeFactor,false);object?[]parameters=newobject?[descriptor.Parameters.Count];for(inti=0;i<parameters.Length;i++)parameters[i]=Convert(Pop(),descriptor.Parameters[i]);object?returnValue=descriptor.Handler.Invoke(this,parameters);if(descriptor.Handler.ReturnType!=typeof(void))Push(Convert(returnValue));}',
 'ValidateCallFlags': '{ExecutionContextStatestate=CurrentContext!.GetState<ExecutionContextState>();if(!state.CallFlags.HasFlag(requiredCallFlags))thrownewInvalidOperationException($"Cannot call this SYSCALL with the flag {state.CallFlags}.");}',
 'OnCallT': '{if(engineisApplicationEngineapp){uinttokenId=instruction.TokenU16;app.ValidateCallFlags(CallFlags.ReadStates|CallFlags.AllowCall);ContractState?contract=app.CurrentContext!.GetState<ExecutionContextState>().Contract;if(contractisnull||tokenId>=contract.Nef.Tokens.Length)thrownewInvalidOperationException();MethodTokentoken=contract.Nef.Tokens[tokenId];if(token.ParametersCount>app.CurrentContext.EvaluationStack.Count)thrownewInvalidOperationException();StackItem[]args=newStackItem[token.ParametersCount];for(inti=0;i<token.ParametersCount;i++)args[i]=app.Pop();app.CallContractInternal(token.Hash,token.Method,token.CallFlags,token.HasReturnValue,args);}else{thrownewInvalidOperationException();}}',
 'CallContractInternal': '{ContractState?contract=NativeContract.ContractManagement.GetContract(SnapshotCache,contractHash);if(contractisnull)thrownewInvalidOperationException($"Called Contract Does Not Exist: {contractHash}");ContractMethodDescriptor?md=contract.Manifest.Abi.GetMethod(method,args.Length);if(mdisnull)thrownewInvalidOperationException($"Method \\"{method}\\" with {args.Length} parameter(s) doesn\'t exist in the contract {contractHash}.");returnCallContractInternal(contract,md,flags,hasReturnValue,args);}',
 'Register': '{varflags=BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.Static;varmethod=typeof(ApplicationEngine).GetMethod(handler,flags)??typeof(ApplicationEngine).GetProperty(handler,flags)?.GetMethod??thrownewArgumentException($"Handler {handler} is not found.",nameof(handler));vardescriptor=newInteropDescriptor(){Name=name,Handler=method,Hardfork=hardfork,FixedPrice=fixedPrice,RequiredCallFlags=requiredCallFlags};services??=[];services.Add(descriptor.Hash,descriptor);returndescriptor;}',
}

# slot -> {alternate text: field overrides}. Only the alternatives a control
# actually uses are listed; anything else is rejected as an unknown operation.
PATCHES = {
 'CallContract': [
  ("method.StartsWith('_')", {'false': dict(call_rejects_underscore=False)}),
  ('(callFlags&~CallFlags.All)!=0',
   {'(callFlags&~CallFlags.All)==2': dict(call_flag_range_gate=False),
    '(callFlags&~CallFlags.ReadOnly)!=0': {}}),
  ('md.ReturnType!=ContractParameterType.Void', {'false': dict(call_derives_return=False)}),
  ('IsDynamicCall=true;', {'IsDynamicCall=false;': dict(call_marks_dynamic=False)})],
 'OnSysCall': [
  ('ValidateCallFlags(descriptor.RequiredCallFlags);',
   {'descriptor.RequiredCallFlags.GetHashCode();': dict(interop_flag_gate=False)}),
  ('newobject?[descriptor.Parameters.Count]',
   {'newobject?[descriptor.Parameters.Count-1]': dict(interop_pop_delta=-1)}),
  ('descriptor.Parameters[i]);',
   {'descriptor.Parameters[descriptor.Parameters.Count-1-i]);': dict(interop_flag_slot=1)}),
  ('if(descriptor.Handler.ReturnType!=typeof(void))',
   {'if(true)': dict(interop_handler_void=False)})],
 'OnCallT': [
  ('CallFlags.ReadStates|CallFlags.AllowCall', {'CallFlags.None': {}}),
  ('for(inti=0;i<token.ParametersCount;i++)',
   {'for(inti=token.ParametersCount-1;i>=0;i--)': dict(token_pops=False)}),
  ('app.CallContractInternal(token.Hash,token.Method,token.CallFlags,token.HasReturnValue,args);',
   {'app.CallContractInternal(token.Hash,token.Method,token.CallFlags,token.HasReturnValue,args);'
    'app.GetState<ExecutionContextState>().IsDynamicCall=true;': dict(token_marks_dynamic=True)})],
}

# Anchors that must appear exactly once and in this order inside a body. Order
# is checked because the ordering theorems depend on it: a source reordering
# changes which reject a given input produces. Every anchor is invariant under
# the mutations above, otherwise an ordered check would report the mutation
# rather than the order.
ORDER = {
 'CallContract': [
  'thrownewArgumentException(',
  'thrownewArgumentOutOfRangeException(nameof(callFlags))',
  'NativeContract.ContractManagement.GetContract(SnapshotCache,contractHash);',
  'if(contractisnull)thrownewInvalidOperationException(',
  'contract.Manifest.Abi.GetMethod(method,args.Count);',
  'if(mdisnull)thrownewInvalidOperationException(',
  'boolhasReturnValue=',
  '=CallContractInternal(contract,md,callFlags,hasReturnValue,args);',
  'IsDynamicCall='],
 'OnSysCall': [
  'descriptor.RequiredCallFlags',
  'AddFee(descriptor.FixedPrice*_execFeeFactor,false);',
  'object?[]parameters=newobject?[',
  '=Convert(Pop(),',
  'Push(Convert(returnValue));'],
 'ValidateCallFlags': [
  'ExecutionContextStatestate=CurrentContext!.GetState<ExecutionContextState>();',
  'if(!state.CallFlags.HasFlag(requiredCallFlags))'],
 'OnCallT': [
  'app.ValidateCallFlags(',
  'if(contractisnull||tokenId>=contract.Nef.Tokens.Length)',
  'MethodTokentoken=contract.Nef.Tokens[tokenId];',
  'if(token.ParametersCount>app.CurrentContext.EvaluationStack.Count)',
  'StackItem[]args=newStackItem[token.ParametersCount];',
  'app.Pop();',
  'app.CallContractInternal(token.Hash,'],
 'CallContractInternal': [
  'NativeContract.ContractManagement.GetContract(SnapshotCache,contractHash);',
  'if(contractisnull)thrownewInvalidOperationException(',
  'contract.Manifest.Abi.GetMethod(method,args.Length);',
  'returnCallContractInternal(contract,md,flags,hasReturnValue,args);'],
}

# Field and initializer sources the projection depends on but does not model.
# The registration is a pattern rather than a literal because its flag argument
# is one of the mutated slots; the value is re-derived from whatever it says.
REGISTRATION = re.compile(r'Register\("System\.Contract\.Call", nameof\(CallContract\), 1 << 15, '
                          r'(CallFlags\.\w+(?: \| CallFlags\.\w+)*)\)')
FRAGMENTS = {
 'core/descriptor': ['public required MethodInfo Handler { get; init; }',
                     'public CallFlags RequiredCallFlags { get; init; }',
                     'public IReadOnlyList<InteropParameterDescriptor> Parameters => field ??= Handler.GetParameters().Select(p => new InteropParameterDescriptor(p)).ToList().AsReadOnly();'],
 'core/token': ['public ushort ParametersCount;', 'public bool HasReturnValue;',
                'public CallFlags CallFlags;',
                "if (Method.StartsWith('_')) throw new FormatException",
                'ParametersCount = reader.ReadUInt16();',
                'CallFlags = (CallFlags)reader.ReadByte();',
                'if ((CallFlags & ~CallFlags.All) != 0) throw new FormatException'],
 'vm/stack': ['public StackItem Pop()'],
}

FLAG_ENTRY = re.compile(r'^\s*(None|ReadStates|WriteStates|AllowCall|AllowNotify|States|ReadOnly|All)\s*=\s*([^,\n]+),?$',re.M)

def flag_table(text):
    """Resolve CallFlags from its own declaration, including composites."""
    raw = {name: expr.strip() for name, expr in FLAG_ENTRY.findall(text)}
    require(set(raw) == {'None','ReadStates','WriteStates','AllowCall','AllowNotify',
                         'States','ReadOnly','All'}, 'Changed CallFlags member set')
    values, pending = {}, dict(raw)
    for _ in range(len(pending)):
        for name in list(pending):
            if all(tok.strip() in values or re.fullmatch(r'0[bB]?[01]+|\d+', tok.strip())
                   for tok in pending[name].split('|')):
                total = 0
                for tok in [p.strip() for p in pending[name].split('|')]:
                    if tok in values: total |= values[tok]
                    elif re.fullmatch(r'0b[01]+', tok): total |= int(tok, 2)
                    elif re.fullmatch(r'\d+', tok): total |= int(tok)
                    else: raise ValueError('Unresolvable CallFlags expression: '+tok)
                values[name] = total; pending.pop(name)
    require(not pending, 'Unresolved CallFlags members')
    require(values == {'None':0, 'ReadStates':1, 'WriteStates':2, 'AllowCall':4,
                       'AllowNotify':8, 'States':3, 'ReadOnly':5, 'All':15},
            'Changed CallFlags values')
    return values

def eval_flags(expr, table):
    total = 0
    for piece in [p.strip() for p in expr.split('|')]:
        match = re.fullmatch(r'CallFlags\.(\w+)', piece)
        require(match is not None and match.group(1) in table, 'Unknown flag expression: '+piece)
        total |= table[match.group(1)]
    return total

SIGNATURE = re.compile(r'^(?:[A-Za-z]+\s+)*?(?P<ret>[A-Za-z_][A-Za-z_0-9<>?\[\]]*)\s+'
                       r'(?P<name>[A-Za-z_][A-Za-z_0-9]*)\s*\((?P<params>[^)]*)\)$')

def signature_parts(header):
    """Split a declaration into (return type, parameter list) without guessing."""
    match = SIGNATURE.match(header.strip())
    require(match is not None, 'Unparsable declaration: '+header)
    params, depth, item = [], 0, ''
    for char in match.group('params') + ',':
        if char == ',' and depth == 0:
            if item.strip(): params.append(item.strip())
            item = ''
            continue
        depth += int(char == '<') + int(char == '[') + int(char == '(')
        depth -= int(char == '>') + int(char == ']') + int(char == ')')
        item += char
    parsed = []
    for param in params:
        words = param.split('=')[0].split()
        require(len(words) >= 2, 'Unparsable parameter: '+param)
        parsed.append((' '.join(words[:-1]), words[-1]))
    return match.group('ret'), parsed

def parse_method(name, actual):
    baseline = TEMPLATES[name]; slots = PATCHES.get(name, [])
    pattern = re.escape(baseline); choices = []
    for index,(original,alternates) in enumerate(slots):
        require(baseline.count(original) == 1, 'Ambiguous source grammar slot: '+original)
        values = {original:{}, **alternates}; choices.append(values)
        group = '(?P<s'+str(index)+'>'+'|'.join(re.escape(s) for s in sorted(values,key=len,reverse=True))+')'
        pattern = pattern.replace(re.escape(original), group, 1)
    match = re.fullmatch(pattern, actual)
    require(match is not None, 'Unknown/extra complete source operations in '+name)
    updates, texts = {}, {}
    for index,values in enumerate(choices):
        texts[index] = match['s'+str(index)]
        updates.update(values[match['s'+str(index)]])
    return updates, texts

def ordered(body_text, name):
    position = 0
    for needle in ORDER[name]:
        require(body_text.count(needle) == 1, 'Missing/ambiguous pinned statement: '+needle)
        found = body_text.index(needle)
        require(found >= position, 'Pinned statements out of source order in '+name+': '+needle)
        position = found

def project_sources(contents, *, enforce_identity=True):
    require(set(contents) == set(SOURCES), 'Incomplete/extra syscall source set')
    if enforce_identity:
        for key,text in contents.items():
            require(sha(text.encode()) == SOURCES[key]['sha256'], 'Pinned source mismatch: '+key)
    for key,needles in FRAGMENTS.items():
        for needle in needles:
            require(contents[key].count(needle) == 1, 'Changed field/initializer source binding: '+needle)
    registration = REGISTRATION.findall(contents['core/contract'])
    require(len(registration) == 1, 'Missing/ambiguous System.Contract.Call registration')
    table = flag_table(contents['core/flags'])
    methods, slots = {}, {}
    for name,(key,header) in SIGNATURES.items():
        text = body(contents[key],header)
        if name in ORDER: ordered(text,name)
        updates, texts = parse_method(name,text)
        methods[name] = dict(source=key,declaration=header,bodyTokens=text,bodySha256=sha(text.encode()),
                             updates={k:v for k,v in updates.items()})
        slots[name] = texts
    # The descriptor's parameter list *is* the handler's declared parameter
    # list, so the pop count and the CallFlags slot are read off the handler
    # signature instead of being restated.
    return_type, handler_params = signature_parts(SIGNATURES['CallContract'][1])
    flag_slots = [index for index,(kind,_) in enumerate(handler_params) if kind == 'CallFlags']
    require(len(flag_slots) == 1, 'Handler must declare exactly one CallFlags parameter')
    count = len(handler_params)
    require(count > 0, 'Handler must declare at least one parameter')
    restricted = re.fullmatch(r'\(callFlags&~(CallFlags\.\w+)\)[!=]=\w+', slots['CallContract'][1])
    require(restricted is not None, 'Unrecognised call-flag range guard: '+slots['CallContract'][1])
    program = dict(
        interop_flag_gate=methods['OnSysCall']['updates'].get('interop_flag_gate',True),
        # Register's fourth argument is RequiredCallFlags and OnSysCall passes
        # exactly that to ValidateCallFlags, which requires every bit of it.
        interop_required_flags=eval_flags(registration[0], table),
        interop_pop_count=count + methods['OnSysCall']['updates'].get('interop_pop_delta',0),
        interop_flag_slot=methods['OnSysCall']['updates'].get('interop_flag_slot',flag_slots[0]),
        interop_pushes_result=True,
        interop_handler_void=methods['OnSysCall']['updates'].get('interop_handler_void', return_type == 'void'),
        interop_result=0,
        call_rejects_underscore=methods['CallContract']['updates'].get('call_rejects_underscore',True),
        call_flag_range_gate=methods['CallContract']['updates'].get('call_flag_range_gate',True),
        call_all_flags=eval_flags(restricted.group(1), table),
        call_derives_return=methods['CallContract']['updates'].get('call_derives_return',True),
        call_marks_dynamic=methods['CallContract']['updates'].get('call_marks_dynamic',True),
        token_flag_gate=True,
        token_required_flags=eval_flags(slots['OnCallT'][0], table),
        token_pops=methods['OnCallT']['updates'].get('token_pops',True),
        token_marks_dynamic=methods['OnCallT']['updates'].get('token_marks_dynamic',
                                                              'IsDynamicCall' in TEMPLATES['OnCallT']),
    )
    require(program['interop_pushes_result'] is True, 'Reduced descriptor push flag')
    require(('IsDynamicCall' in methods['OnCallT']['bodyTokens']) == program['token_marks_dynamic'],
            'OnCallT dynamic marker no longer matches the projection')
    return dict(schema='neoos-aa-syscall-dispatch-source/v1',scope=SCOPE,entryBoundary=ENTRY_BOUNDARY,
                coreSourceCommit=CORE_COMMIT,neoVmSourceCommit=VM_COMMIT,
                sourceHashes={k:sha(v.encode()) for k,v in contents.items()},
                methods=methods,program=program,handlerParameters=[list(p) for p in handler_params],
                tokenFields=['Hash','Method','ParametersCount:ushort','HasReturnValue','CallFlags:byte'],
                preconditions=PRECONDITIONS,unproved=UNPROVED,tcb=TCB,sourceFrontendVerified=False)

def source_url(row):
    return 'https://raw.githubusercontent.com/neo-project/'+row['repository']+'/'+row['commit']+'/'+row['relativePath']

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
    same pinned value a download would have to reach, so a mirror cannot
    launder a different artifact. This only substitutes for a stalled network.
    """
    mirror=os.environ.get('AA_SYSCALL_DISPATCH_SOURCE_MIRROR')
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

# Only mutations whose removal changes an admit/reject outcome or a handed-off
# value are listed. Four further pinned guards (contract absent, method absent,
# token index out of range, parameter count above the stack) are reason
# refinements: the unguarded code faults on the same input, so a mutant of one
# would keep the same outcome and would prove nothing. They are modelled as
# unconditional faults in the Coq record rather than as mutable fields.
CONTROL_MUTATIONS = {
 'drop-interop-flag-gate': ('core/engine', 'ValidateCallFlags(descriptor.RequiredCallFlags);',
                            'descriptor.RequiredCallFlags.GetHashCode();'),
 'weak-interop-required-flags': ('core/contract', '1 << 15, CallFlags.ReadStates | CallFlags.AllowCall)',
                                 '1 << 15, CallFlags.None)'),
 'drop-underscore-guard': ('core/contract', "method.StartsWith('_')", 'false'),
 'drop-flag-range-gate': ('core/contract', '(callFlags & ~CallFlags.All) != 0',
                          '(callFlags & ~CallFlags.All) == 2'),
 'narrow-call-flags': ('core/contract', '(callFlags & ~CallFlags.All) != 0',
                       '(callFlags & ~CallFlags.ReadOnly) != 0'),
 'drop-return-derivation': ('core/contract', 'md.ReturnType != ContractParameterType.Void', 'false'),
 'drop-dynamic-marker': ('core/contract', 'IsDynamicCall = true;', 'IsDynamicCall = false;'),
 'shrink-interop-parameters': ('core/engine', 'new object?[descriptor.Parameters.Count]',
                               'new object?[descriptor.Parameters.Count - 1]'),
 'reverse-interop-binding': ('core/engine', 'descriptor.Parameters[i]);',
                             'descriptor.Parameters[descriptor.Parameters.Count - 1 - i]);'),
 'always-push-interop-result': ('core/engine', 'if (descriptor.Handler.ReturnType != typeof(void))',
                                'if (true)'),
 'weak-token-required-flags': ('core/engine',
                               'ValidateCallFlags(CallFlags.ReadStates | CallFlags.AllowCall)',
                               'ValidateCallFlags(CallFlags.None)'),
 'reverse-token-pops': ('core/engine', 'for (int i = 0; i < token.ParametersCount; i++)',
                        'for (int i = token.ParametersCount - 1; i >= 0; i--)'),
 'mark-callt-dynamic': ('core/engine',
                        'app.CallContractInternal(token.Hash, token.Method, token.CallFlags, token.HasReturnValue, args);',
                        'app.CallContractInternal(token.Hash, token.Method, token.CallFlags, token.HasReturnValue, args);\n                app.GetState<ExecutionContextState>().IsDynamicCall = true;'),
}
EXPECTED_CONTROLS = tuple(CONTROL_MUTATIONS)

def mutated_projection(contents,name):
    require(name in CONTROL_MUTATIONS,'Unknown semantic mutant')
    key,before,after=CONTROL_MUTATIONS[name];changed=dict(contents)
    require(changed[key].count(before)==1,'Ambiguous semantic mutation: '+before)
    changed[key]=changed[key].replace(before,after)
    return project_sources(changed,enforce_identity=False),sha(changed[key].encode())
