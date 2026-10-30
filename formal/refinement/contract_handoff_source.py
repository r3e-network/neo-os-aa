"""Pinned projection of the CallContractInternal handoff and LoadContract frame.

This lane covers what `EntryDispatch.v` excludes forward and what the syscall
lane excludes backward: the second CallContractInternal overload plus the frame
that LoadContract builds. It stops at the constructed context, before any
instruction of the callee runs.

Every field below is *derived* from the pinned declarations, not restated.
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
SCOPE = 'contract-internal-handoff-and-frame-construction'
ENTRY_BOUNDARY = 'LoadContract-returned-context-before-callee-execution'

SOURCES = {
    'core/engine': dict(repository='neo', commit=CORE_COMMIT,
                        sha256='97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb',
                        relativePath='src/Neo/SmartContract/ApplicationEngine.cs'),
    'core/abi': dict(repository='neo', commit=CORE_COMMIT,
                     sha256='9313d6709261c83ce19371d3e46dc29adee143c2032433d2b607e84b95865ed2',
                     relativePath='src/Neo/SmartContract/Manifest/ContractAbi.cs'),
    'core/basic': dict(repository='neo', commit=CORE_COMMIT,
                       sha256='51a8e0949784ec536f69a69ada6f98088ac38c27468696edef3420a65e1e757b',
                       relativePath='src/Neo/SmartContract/ContractBasicMethod.cs'),
    'core/flags': dict(repository='neo', commit=CORE_COMMIT,
                       sha256='4f3fc9ded9c32eca754e735337251d0cc5ce3b7ad13aa64551d427b1688d13d1',
                       relativePath='src/Neo/SmartContract/CallFlags.cs'),
    'core/method': dict(repository='neo', commit=CORE_COMMIT,
                        sha256='8b0c93a42e2cde4dcc81dd3b75115728fe049dec107b0e8e6b07c3f8d8594fa4',
                        relativePath='src/Neo/SmartContract/Manifest/ContractMethodDescriptor.cs'),
    'core/contract-state': dict(repository='neo', commit=CORE_COMMIT,
                                sha256='1cd51b08477accb23383993776026ed86348ae8427d1832939281170c9bac659',
                                relativePath='src/Neo/SmartContract/ContractState.cs'),
    'core/policy': dict(repository='neo', commit=CORE_COMMIT,
                        sha256='bde31f8af6df23a66b563081ef4f866d80ffb318ce4a1b01d7289a12f14fea62',
                        relativePath='src/Neo/SmartContract/Native/PolicyContract.cs'),
    'vm/context': dict(repository='neo-vm', commit=VM_COMMIT,
                       sha256='c2b7809e7306d3ea3ae68f15267ab4a2994cc0e0dea0b84bd9153e9003d4a197',
                       relativePath='src/Neo.VM/ExecutionContext.cs'),
    'vm/stack': dict(repository='neo-vm', commit=VM_COMMIT,
                     sha256='7190a363cd8c71010c2a98987f5aadd331adeff4d3551b1bc9e1d8cd7a56ac3e',
                     relativePath='src/Neo.VM/EvaluationStack.cs'),
}

SIGNATURES = {
    'CallContractInternalLookup': ('core/engine',
        'private ExecutionContext CallContractInternal(UInt160 contractHash, string method, '
        'CallFlags flags, bool hasReturnValue, StackItem[] args)'),
    'CallContractInternal': ('core/engine',
        'private ExecutionContext CallContractInternal(ContractState contract, '
        'ContractMethodDescriptor method, CallFlags flags, bool hasReturnValue, '
        'IReadOnlyList<StackItem> args)'),
    'LoadContract': ('core/engine',
        'public ExecutionContext LoadContract(ContractState contract, '
        'ContractMethodDescriptor method, CallFlags callFlags)'),
    'LoadScript': ('core/engine',
        'public ExecutionContext LoadScript(Script script, int rvcount = -1, '
        'int initialPosition = 0, Action<ExecutionContextState>? configureState = null)'),
    'GetMethod': ('core/abi', 'public ContractMethodDescriptor? GetMethod(string name, int pcount)'),
    'CanCall': ('core/contract-state',
                'public bool CanCall(ContractState targetContract, string targetMethod)'),
    'IsBlocked': ('core/policy', 'public bool IsBlocked(IReadOnlyStore snapshot, UInt160 account)'),
}

PRECONDITIONS = [
    'The caller context exists, its ExecutionContextState carries the CallFlags word this handoff '
    'narrows, and CurrentScriptHash names it.',
    'The callee ContractState and its ContractMethodDescriptor came from a successful '
    'arity-keyed GetMethod(name, args.Count) on a manifest that the caller named.',
    'Policy.IsBlocked and Policy.IsWhitelistFeeContract answer from storage that the caller does '
    'not modify during the handoff; both are supplied as opaque booleans and one fee.',
    'ContractState.CanCall answers from the calling contract manifest permissions and is supplied '
    'as an opaque boolean.',
    'The Domovoi hardfork is active, so the authorization subject is state.Contract rather than a '
    're-read of CurrentScriptHash; the Faun hardfork is the one that enables whitelisted fees.',
    'AddFee succeeds, no resource exception is raised, and no diagnostic callback observes the '
    'constructed frame.',
]
UNPROVED = [
    'AddFee, gas metering, resource limits and every exception type; no cost is modelled and a '
    'rejection is a fault, not a .NET exception identity.',
    'Instruction execution inside the constructed context; this lane ends at the context that '
    'LoadContract returns, before the callee runs.',
    'Storage reads behind IsBlocked, IsWhitelistFeeContract, GetContract and manifest/ABI loading; '
    'only their answers are inputs.',
    'EvaluationStack sharing, static-field sharing, reference counters and Dispose ordering inside '
    'LoadScript/CreateContext.',
    'Trusted C# extraction and compiler/CLR correspondence; ApplicationEngine execution after the '
    'handoff; all 100 public entrypoints.',
]
TCB = ['Strict complete-method C# grammar and field/symbol binding.',
       'C# object allocation, reference vs copy semantics and framework dictionary APIs.',
       'Externally supplied successful noninterfering environment and exact virtual dispatch.']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


# The tokenizer is shared with the entry-dispatch and syscall lanes so every
# lane normalizes C# identically; a divergence would make the projections
# incomparable.
from csharp_tokens import TOKENIZER as TOKEN

def body(text, header):
    require(text.count(header) == 1, 'Missing/ambiguous complete method declaration: ' + header)
    tail = text[text.index(header) + len(header):]
    position = depth = 0
    items = []
    while position < len(tail):
        match = TOKEN.match(tail, position)
        require(match is not None, 'Unsupported source token')
        position = match.end()
        token = match.group()
        if token.isspace() or token.startswith(('//', '/*')):
            continue
        require(items or token == '{', 'Expected complete method block')
        items.append(token)
        depth += int(token == '{') - int(token == '}')
        if depth == 0:
            return ''.join(items)
    raise ValueError('Unterminated method body')


class Flags:
    """CallFlags members read off the pinned enum declaration."""

    MEMBERS = {'None': 0, 'ReadStates': 1, 'WriteStates': 2, 'AllowCall': 4, 'AllowNotify': 8,
               'States': 3, 'ReadOnly': 5, 'All': 15}
    NUMBER = r'0b[01]+|0x[0-9A-Fa-f]+|\d+'

    def __init__(self, text):
        declaration = re.search(r'enum\s+CallFlags[^{]*\{([\s\S]*?)\n    \}', text)
        require(declaration is not None, 'Missing CallFlags enum declaration')
        values = {}
        for name in re.findall(r'^\s*(\w+)\s*=', declaration.group(1), re.MULTILINE):
            expression = re.search(r'^\s*' + name + r'\s*=\s*([^,\r\n]+)', declaration.group(1),
                                   re.MULTILINE)
            require(expression is not None, 'Unreadable CallFlags member: ' + name)
            values[name] = self.evaluate(expression.group(1), values)
        require(values == self.MEMBERS, 'Changed CallFlags declaration: ' + repr(sorted(values)))
        self.values = values

    def evaluate(self, expression, known):
        total = 0
        for term in expression.split('|'):
            term = term.strip()
            if re.fullmatch(self.NUMBER, term):
                total |= int(term, 0)
                continue
            match = re.fullmatch(r'(?:CallFlags\.)?(\w+)', term)
            require(match is not None, 'Unsupported flag term: ' + term)
            name = match.group(1)
            require(name in known or name in self.MEMBERS,
                    'Flag used before its declaration: ' + name)
            total |= known[name] if name in known else self.MEMBERS[name]
        return total

    def mask(self, names):
        total = 0
        for name in names:
            require(name in self.values, 'Unknown flag in mask: ' + name)
            total |= self.values[name]
        return total


def flag_table(text):
    return Flags(text)


def mask_members(expression):
    """Return the flag names a `~(A | B)` mask removes."""
    match = re.fullmatch(r'~\(CallFlags\.(\w+(?:\|CallFlags\.\w+)*)\)', expression)
    require(match is not None, 'Unrecognised safe-method mask: ' + expression)
    return match.group(1).split('|CallFlags.')


# Reviewed normalized bodies. A projection is accepted only if every body is
# either exactly this text or exactly one enumerated alternate below, so a
# source edit cannot be absorbed silently.
TEMPLATES = {
 'CallContractInternalLookup': '{ContractState?contract=NativeContract.ContractManagement.GetContract(SnapshotCache,contractHash);if(contractisnull)thrownewInvalidOperationException($"Called Contract Does Not Exist: {contractHash}");ContractMethodDescriptor?md=contract.Manifest.Abi.GetMethod(method,args.Length);if(mdisnull)thrownewInvalidOperationException($"Method \\"{method}\\" with {args.Length} parameter(s) doesn\'t exist in the contract {contractHash}.");returnCallContractInternal(contract,md,flags,hasReturnValue,args);}',
 'CallContractInternal': '{if(NativeContract.Policy.IsBlocked(SnapshotCache,contract.Hash))thrownewInvalidOperationException($"The contract {contract.Hash} has been blocked.");ExecutionContextcurrentContext=CurrentContext!;ExecutionContextStatestate=currentContext.GetState<ExecutionContextState>();if(method.Safe){flags&=~(CallFlags.WriteStates|CallFlags.AllowNotify);}else{varexecutingContract=IsHardforkEnabled(Hardfork.HF_Domovoi)?state.Contract:NativeContract.ContractManagement.GetContract(SnapshotCache,CurrentScriptHash!);if(executingContract?.CanCall(contract,method.Name)==false)thrownewInvalidOperationException($"Cannot Call Method {method.Name} Of Contract {contract.Hash} From Contract {CurrentScriptHash}");}if(invocationCounter.TryGetValue(contract.Hash,outvarcounter)){invocationCounter[contract.Hash]=counter+1;}else{invocationCounter[contract.Hash]=1;}CallFlagscallingFlags=state.CallFlags;if(args.Count!=method.Parameters.Length)thrownewInvalidOperationException($"Method {method} Expects {method.Parameters.Length} Arguments But Receives {args.Count} Arguments");if(hasReturnValue^(method.ReturnType!=ContractParameterType.Void))thrownewInvalidOperationException("The return value type does not match.");varcontextNew=LoadContract(contract,method,flags&callingFlags);state=contextNew.GetState<ExecutionContextState>();state.CallingContext=currentContext;if(IsHardforkEnabled(Hardfork.HF_Faun)&&NativeContract.Policy.IsWhitelistFeeContract(SnapshotCache,contract.Hash,method,outvarfixedFee)){AddFee(fixedFee.Value,true);state.WhiteListed=true;}for(inti=args.Count-1;i>=0;i--)contextNew.EvaluationStack.Push(args[i]);returncontextNew;}',
 'LoadContract': '{ExecutionContextcontext=LoadScript(contract.Script,rvcount:method.ReturnType==ContractParameterType.Void?0:1,initialPosition:method.Offset,configureState:p=>{p.CallFlags=callFlags;p.ScriptHash=contract.Hash;p.Contract=newContractState{Id=contract.Id,UpdateCounter=contract.UpdateCounter,Hash=contract.Hash,Nef=contract.Nef,Manifest=contract.Manifest};});varinit=contract.Manifest.Abi.GetMethod(ContractBasicMethod.Initialize,ContractBasicMethod.InitializePCount);if(initisnotnull){LoadContext(context.Clone(init.Offset));}returncontext;}',
 'LoadScript': '{ExecutionContextcontext=CreateContext(script,rvcount,initialPosition);ExecutionContextStatestate=context.GetState<ExecutionContextState>();state.SnapshotCache=SnapshotCache?.CloneCache();configureState?.Invoke(state);LoadContext(context);returncontext;}',
 'GetMethod': '{if(pcount<-1||pcount>ushort.MaxValue)thrownewArgumentOutOfRangeException(nameof(pcount),$"`pcount` must be between [-1, {ushort.MaxValue}]");if(pcount>=0){methodDictionary??=Methods.ToDictionary(p=>(p.Name,p.Parameters.Length));if(methodDictionary.TryGetValue((name,pcount),outvarmethod))returnmethod;returnnull;}else{returnMethods.FirstOrDefault(p=>p.Name==name);}}',
 'CanCall': '{returnManifest.Permissions.Any(u=>u.IsAllowed(targetContract,targetMethod));}',
 'IsBlocked': '{returnsnapshot.Contains(CreateStorageKey(Prefix_BlockedAccount,account));}',
}

# slot -> {alternate: field overrides}. Only the alternates a control uses are
# listed; any other text is rejected as an unknown operation.
PATCHES = {
 'CallContractInternal': [
  ('if(NativeContract.Policy.IsBlocked(SnapshotCache,contract.Hash))',
   {'if(NativeContract.Policy.IsBlocked(SnapshotCache,contract.Hash)&&false)':
    dict(blocked_gate=False)}),
  ('flags&=~(CallFlags.WriteStates|CallFlags.AllowNotify);',
   {'flags&=~(CallFlags.None);': {}, 'flags&=~(CallFlags.ReadStates);': {},
    'flags&=~(CallFlags.All);': {}}),
  ('if(executingContract?.CanCall(contract,method.Name)==false)',
   {'if(false)': dict(authorization_gate=False)}),
  ('executingContract?.CanCall(contract,method.Name)',
   {'contract.CanCall(contract,method.Name)': dict(authorization_subject_is_caller=False)}),
  ('invocationCounter[contract.Hash]=counter+1;',
   {'invocationCounter[contract.Hash]=counter+2;': {},
    'invocationCounter[contract.Hash]=counter+0;': {}}),
  ('LoadContract(contract,method,flags&callingFlags)',
   {'LoadContract(contract,method,flags)': dict(caller_flag_intersection=False)}),
  ('state.CallingContext=currentContext;',
   {'state.CallingContext=state.CallingContext;': dict(calling_context_set=False)}),
  ('AddFee(fixedFee.Value,true);',
   {'AddFee(0,true);': dict(fee_from_whitelist=False)}),
  ('state.WhiteListed=true;',
   {'state.WhiteListed=false;': dict(whitelist_sets_flag=False)}),
  ('for(inti=args.Count-1;i>=0;i--)',
   {'for(inti=0;i<args.Count;i++)': dict(push_reversed=False)})],
 'LoadContract': [
  ('rvcount:method.ReturnType==ContractParameterType.Void?0:1',
   {'rvcount:method.ReturnType==ContractParameterType.Void?1:0': dict(rvcount_from_return=False)}),
  ('initialPosition:method.Offset',
   {'initialPosition:0': dict(ip_from_method_offset=False)}),
  ('p.Contract=newContractState{',
   {'p.Contract=contract{': dict(contract_copied=False)}),
  ('LoadContext(context.Clone(init.Offset));',
   {'LoadContext(context);': dict(initializer_frame=False)})],
 'LoadScript': [
  ('state.SnapshotCache=SnapshotCache?.CloneCache();',
   {'state.SnapshotCache=SnapshotCache;': dict(snapshot_cloned=False)})],
 'GetMethod': [
  ('Methods.ToDictionary(p=>(p.Name,p.Parameters.Length))',
   {'Methods.ToDictionary(p=>(p.Name,0))': dict(lookup_is_arity_keyed=False)})],
}

# Anchors that must appear once and in this order inside a body. Ordering is
# checked because the rejection-order theorems depend on it; every anchor is
# invariant under the mutations above so an ordered check reports reordering,
# never a mutation.
ORDER = {
 'CallContractInternal': [
  'if(NativeContract.Policy.IsBlocked(', 'if(method.Safe)', 'flags&=~(CallFlags.',
  'IsHardforkEnabled(Hardfork.HF_Domovoi)', '?state.Contract:', 'if(invocationCounter.TryGetValue(',
  'CallFlagscallingFlags=state.CallFlags;', 'if(args.Count!=method.Parameters.Length)',
  'if(hasReturnValue^(method.ReturnType!=ContractParameterType.Void))',
  'varcontextNew=LoadContract(', 'state.CallingContext=', 'IsWhitelistFeeContract(',
  'AddFee(', 'state.WhiteListed=', 'EvaluationStack.Push(', 'returncontextNew;'],
 'LoadContract': [
  'LoadScript(contract.Script', 'rvcount:', 'initialPosition:', 'p.CallFlags=callFlags;',
  'p.ScriptHash=contract.Hash;', 'p.Contract=', 'ContractBasicMethod.Initialize,',
  'if(initisnotnull)', 'LoadContext(', 'returncontext;'],
 'LoadScript': ['CreateContext(', 'GetState<ExecutionContextState>()', 'state.SnapshotCache=',
                'configureState?.Invoke(state);', 'LoadContext(context);', 'returncontext;'],
}


def ordered(text, name):
    anchors = ORDER.get(name, [])
    positions = []
    for anchor in anchors:
        require(text.count(anchor) == 1, 'Missing/ambiguous ordered anchor: ' + anchor)
        positions.append(text.index(anchor))
    require(positions == sorted(positions), 'Reordered declarations in ' + name)
    return positions


def slot_texts(name, actual):
    """Return the actual slot text for each patch of a method.

    A body is accepted only as the reviewed template or as exactly one
    enumerated alternate, so there is never a partially recognized body.
    """
    template = TEMPLATES[name]
    patches = PATCHES.get(name, [])
    require(actual == template or _single_substitution_matches(name, actual, template, patches),
            'Unrecognised body for ' + name)
    texts = []
    for before, alternates in patches:
        for after in alternates:
            candidate = template.replace(before, after)
            if actual == candidate:
                texts.append(after)
                break
        else:
            texts.append(before)
    return texts


def _single_substitution_matches(name, actual, template, patches):
    for before, alternates in patches:
        require(template.count(before) == 1, 'Ambiguous patch anchor: ' + before)
        for after in alternates:
            if actual == template.replace(before, after):
                return True
    return False


def parse_method(name, actual):
    template = TEMPLATES[name]
    patches = PATCHES.get(name, [])
    for before, alternates in patches:
        require(template.count(before) == 1, 'Ambiguous patch anchor: ' + before)
        if actual == template:
            continue
        for after, overrides in alternates.items():
            if actual == template.replace(before, after):
                return overrides, actual
    require(actual == template, 'Unrecognised body for ' + name)
    return {}, actual


def initializer_facts(text):
    name = re.search(r'static\s+string\s+Initialize\s*\{\s*get;\s*\}\s*=\s*"([^"]+)"', text)
    count = re.search(r'static\s+int\s+InitializePCount\s*\{\s*get;\s*\}\s*=\s*(\d+)', text)
    require(name is not None and count is not None, 'Missing initializer constants')
    return name.group(1), int(count.group(1))


def project_sources(contents, *, enforce_identity=True):
    require(set(contents) == set(SOURCES), 'Incomplete/extra contract handoff source set')
    if enforce_identity:
        for key, text in contents.items():
            require(sha(text.encode()) == SOURCES[key]['sha256'], 'Pinned source mismatch: ' + key)
    table = flag_table(contents['core/flags'])
    methods = {}
    for name, (key, header) in SIGNATURES.items():
        methods[name] = body(contents[key], header)
        if name in ORDER:
            ordered(methods[name], name)
    updates, _ = parse_method('CallContractInternal', methods['CallContractInternal'])
    load_updates, _ = parse_method('LoadContract', methods['LoadContract'])
    script_updates, _ = parse_method('LoadScript', methods['LoadScript'])
    lookup_updates, _ = parse_method('GetMethod', methods['GetMethod'])
    require(parse_method('CanCall', methods['CanCall'])[0] == {}, 'Changed CanCall body')
    require(parse_method('IsBlocked', methods['IsBlocked'])[0] == {}, 'Changed IsBlocked body')
    require(parse_method('CallContractInternalLookup',
                         methods['CallContractInternalLookup'])[0] == {}, 'Changed lookup body')
    require(not set(updates) & set(load_updates), 'Field derived from two bodies')
    combined = {**updates, **load_updates, **script_updates, **lookup_updates}
    slots = slot_texts('CallContractInternal', methods['CallContractInternal'])
    mask_expression = slots[1][len('flags&='):-1]
    drops = table.mask(mask_members(mask_expression))
    increment = re.fullmatch(r'invocationCounter\[contract\.Hash\]=counter\+(\d+);', slots[4])
    require(increment is not None, 'Unrecognised invocation update: ' + slots[4])
    require(slots[4].count('counter+') == 1 and methods['CallContractInternal'].count(
        'invocationCounter[contract.Hash]=1;') == 1,
        'Invocation counter branches no longer agree on +1')
    initializer_name, initializer_count = initializer_facts(contents['core/basic'])
    program = dict(
        blocked_gate=combined.get('blocked_gate', True),
        safe_mask_drops=drops,
        authorization_gate=combined.get('authorization_gate', True),
        authorization_subject_is_caller=combined.get('authorization_subject_is_caller', True),
        increment_step=int(increment.group(1)),
        caller_flag_intersection=combined.get('caller_flag_intersection', True),
        calling_context_set=combined.get('calling_context_set', True),
        fee_from_whitelist=combined.get('fee_from_whitelist', True),
        whitelist_sets_flag=combined.get('whitelist_sets_flag', True),
        push_reversed=combined.get('push_reversed', True),
        rvcount_from_return=combined.get('rvcount_from_return', True),
        ip_from_method_offset=combined.get('ip_from_method_offset', True),
        contract_copied=combined.get('contract_copied', True),
        snapshot_cloned=combined.get('snapshot_cloned', True),
        initializer_frame=combined.get('initializer_frame', True),
        initializer_name_is_canonical=initializer_name == '_initialize',
        initializer_pcount=initializer_count,
        lookup_is_arity_keyed=combined.get('lookup_is_arity_keyed', True),
    )
    # The two remaining guards are reason refinements, not behaviour changes:
    # removing them still faults on the same input, so a mutant of either would
    # keep the same outcome and prove nothing. They are modelled as
    # unconditional faults and deliberately never mutated.
    for guard in ('if(contractisnull)thrownewInvalidOperationException(',
                  'if(mdisnull)thrownewInvalidOperationException('):
        require(methods['CallContractInternalLookup'].count(guard) == 1,
                'Missing unconditional fault guard: ' + guard)
    for guard in ('if(args.Count!=method.Parameters.Length)',
                  'if(hasReturnValue^(method.ReturnType!=ContractParameterType.Void))'):
        require(methods['CallContractInternal'].count(guard) == 1,
                'Missing non-discriminating guard: ' + guard)
    return dict(schema='neoos-aa-contract-handoff-source/v1', scope=SCOPE, entryBoundary=ENTRY_BOUNDARY,
                coreSourceCommit=CORE_COMMIT, neoVmSourceCommit=VM_COMMIT,
                sourceHashes={k: sha(v.encode()) for k, v in contents.items()},
                methods=methods, program=program,
                reasonOnlyGuards=['contract-absent', 'method-absent', 'arity-equality', 'return-xor'],
                preconditions=PRECONDITIONS, unproved=UNPROVED, tcb=TCB, sourceFrontendVerified=False)


# Only gates whose removal changes the constructed frame or the handed-off
# values are mutated. The set below is exactly the set of projected fields.
CONTROL_MUTATIONS = {
 'drop-blocked-gate': ('core/engine', 'NativeContract.Policy.IsBlocked(SnapshotCache, contract.Hash))',
                       'NativeContract.Policy.IsBlocked(SnapshotCache, contract.Hash) && false)'),
 'mask-nothing': ('core/engine', 'flags &= ~(CallFlags.WriteStates | CallFlags.AllowNotify);',
                  'flags &= ~(CallFlags.None);'),
 'mask-read-states': ('core/engine', 'flags &= ~(CallFlags.WriteStates | CallFlags.AllowNotify);',
                      'flags &= ~(CallFlags.ReadStates);'),
 'mask-everything': ('core/engine', 'flags &= ~(CallFlags.WriteStates | CallFlags.AllowNotify);',
                     'flags &= ~(CallFlags.All);'),
 'drop-authorization-gate': ('core/engine',
                             'if (executingContract?.CanCall(contract, method.Name) == false)',
                             'if (false)'),
 'authorize-the-callee': ('core/engine', 'executingContract?.CanCall(contract, method.Name)',
                          'contract.CanCall(contract, method.Name)'),
 'increment-twice': ('core/engine', 'invocationCounter[contract.Hash] = counter + 1;',
                     'invocationCounter[contract.Hash] = counter + 2;'),
 'skip-increment': ('core/engine', 'invocationCounter[contract.Hash] = counter + 1;',
                    'invocationCounter[contract.Hash] = counter + 0;'),
 'hand-off-raw-flags': ('core/engine', 'LoadContract(contract, method, flags & callingFlags)',
                        'LoadContract(contract, method, flags)'),
 'drop-calling-context': ('core/engine', 'state.CallingContext = currentContext;',
                          'state.CallingContext = state.CallingContext;'),
 'drop-whitelisted-fee': ('core/engine', 'AddFee(fixedFee.Value, true);', 'AddFee(0, true);'),
 'whitelist-keeps-flag-false': ('core/engine', 'state.WhiteListed = true;',
                                'state.WhiteListed = false;'),
 'push-in-order': ('core/engine', 'for (int i = args.Count - 1; i >= 0; i--)',
                   'for (int i = 0; i < args.Count; i++)'),
 'swap-rvcount': ('core/engine', 'rvcount: method.ReturnType == ContractParameterType.Void ? 0 : 1',
                  'rvcount: method.ReturnType == ContractParameterType.Void ? 1 : 0'),
 'zero-offset': ('core/engine', 'initialPosition: method.Offset', 'initialPosition: 0'),
 'share-the-contract': ('core/engine', '= new ContractState', '= contract'),
 'drop-initializer-frame': ('core/engine', 'LoadContext(context.Clone(init.Offset));',
                            'LoadContext(context);'),
 'drop-snapshot-clone': ('core/engine', 'state.SnapshotCache = SnapshotCache?.CloneCache();',
                         'state.SnapshotCache = SnapshotCache;'),
 'lookup-by-name-only': ('core/abi', 'Methods.ToDictionary(p => (p.Name, p.Parameters.Length))',
                         'Methods.ToDictionary(p => (p.Name, 0))'),
 'initializer-pcount-one': ('core/basic', 'public static int InitializePCount { get; } = 0;',
                            'public static int InitializePCount { get; } = 1;'),
 'initializer-renamed': ('core/basic', 'public static string Initialize { get; } = "_initialize";',
                         'public static string Initialize { get; } = "_init";'),
}
EXPECTED_CONTROLS = tuple(CONTROL_MUTATIONS)


def mutated_projection(contents, name):
    require(name in CONTROL_MUTATIONS, 'Unknown semantic mutant')
    key, before, after = CONTROL_MUTATIONS[name]
    changed = dict(contents)
    require(changed[key].count(before) == 1, 'Ambiguous semantic mutation: ' + before)
    changed[key] = changed[key].replace(before, after)
    return project_sources(changed, enforce_identity=False), sha(changed[key].encode())


def source_url(row):
    return ('https://raw.githubusercontent.com/neo-project/' + row['repository'] + '/'
            + row['commit'] + '/' + row['relativePath'])


DOWNLOAD_ATTEMPT_TIMEOUTS = (30, 45, 60, 90)


def download_pinned(url):
    last_error = None
    for timeout in DOWNLOAD_ATTEMPT_TIMEOUTS:
        try:
            return urllib.request.urlopen(url, timeout=timeout).read()
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
            last_error = exc
    raise last_error


def mirror_source(key, row):
    """Return pinned bytes from a local mirror directory, or None.

    The pin, not the transport, is the evidence: mirror bytes must hash to the
    same pinned value a download would have to reach, so a mirror cannot
    launder a different artifact. This only substitutes for a stalled network.
    """
    mirror = os.environ.get('AA_CONTRACT_HANDOFF_SOURCE_MIRROR')
    if not mirror:
        return None
    candidate = Path(mirror) / (key.replace('/', '-') + '.cs')
    if not candidate.is_file():
        return None
    raw = candidate.read_bytes()
    require(sha(raw) == row['sha256'], 'Offline mirror source mismatch')
    return raw


def project_production(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    contents = {}
    rows = {}
    for key, row in SOURCES.items():
        path = directory / (key.replace('/', '-') + '.cs')
        if not path.exists():
            raw = mirror_source(key, row)
            if raw is None:
                raw = download_pinned(source_url(row))
            require(sha(raw) == row['sha256'], 'Downloaded pinned source mismatch')
            path.write_bytes(raw)
        raw = path.read_bytes()
        require(sha(raw) == row['sha256'], 'Pinned source file drift')
        contents[key] = raw.decode('utf-8')
        rows[key] = dict(path=str(path.resolve()), url=source_url(row), sha256=sha(raw))
    return project_sources(contents), rows


def project_captured(rows):
    require(isinstance(rows, dict) and set(rows) == set(SOURCES),
            'Missing/extra pinned source dependencies')
    paths = []
    contents = {}
    for key, expected in SOURCES.items():
        row = rows[key]
        require(set(row) == {'path', 'url', 'sha256'}, 'Malformed pinned source identity')
        path = Path(row['path'])
        require(path.is_absolute(), 'Relative pinned source path')
        paths.append(str(path.resolve()))
        require(row['url'] == source_url(expected) and row['sha256'] == expected['sha256'],
                'Swapped/unpinned source URL/hash')
        raw = path.read_bytes()
        require(sha(raw) == expected['sha256'], 'Pinned source bytes mismatch')
        contents[key] = raw.decode()
    require(len(paths) == len(set(paths)), 'Duplicate pinned source paths')
    return project_sources(contents)
