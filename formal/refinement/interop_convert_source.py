"""Pinned projection of the interop argument-conversion layer.

This lane covers what the `syscall-dispatch` lane excludes backward: `OnSysCall`
turns the caller's stack window into the invoked handler's argument vector, one
`Convert(Pop(), descriptor.Parameters[i])` per declared parameter. It stops at
the converted argument vector, before the handler body runs.

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
SCOPE = 'interop-argument-conversion'
ENTRY_BOUNDARY = 'OnSysCall-argument-window-to-invoked-handler-parameters'

SOURCES = {
    'core/engine': dict(repository='neo', commit=CORE_COMMIT,
                        sha256='97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb',
                        relativePath='src/Neo/SmartContract/ApplicationEngine.cs'),
    'core/contract': dict(repository='neo', commit=CORE_COMMIT,
                          sha256='8958efff155cb407fef140dea11a516b9f08ab10feecf1b3c39d986d79801a96',
                          relativePath='src/Neo/SmartContract/ApplicationEngine.Contract.cs'),
    'core/interop-parameter': dict(
        repository='neo', commit=CORE_COMMIT,
        sha256='1493ad1814a7cff9705270e256434b0746d076f7d674fe4aecec4c293aaff318',
        relativePath='src/Neo/SmartContract/InteropParameterDescriptor.cs'),
    'vm/limits': dict(repository='neo-vm', commit=VM_COMMIT,
                      sha256='b8353f47f18aec5093426b550a231c7ce1e2201e636e806f177ffcb9043374b4',
                      relativePath='src/Neo.VM/ExecutionEngineLimits.cs'),
}

SIGNATURES = {
    'OnSysCall': ('core/engine',
                  'protected virtual void OnSysCall(InteropDescriptor descriptor)'),
    'ConvertObject': ('core/engine', 'protected internal StackItem Convert(object? value)'),
    'ConvertParameter': ('core/engine',
                         'protected internal object? Convert(StackItem item, '
                         'InteropParameterDescriptor descriptor)'),
    'CallContract': ('core/contract',
                     'protected internal void CallContract(UInt160 contractHash, string method, '
                     'CallFlags callFlags, Array args)'),
}

PRECONDITIONS = [
    'The descriptor is the pinned System.Contract.Call registration, whose parameters are the '
    'four declared parameters of CallContract, and the handler is resolved exactly once.',
    'ValidateCallFlags has already accepted the caller context and the fixed descriptor price has '
    'already been charged; neither is modelled here.',
    'Every StackItem in the window is well formed, and GetInteger on a non-integer item is out of '
    'scope, so the counted branch only receives an integer length.',
    'The stack holds at least the items the conversion pops, and Pop on an empty stack is out of '
    'scope.',
    'The element converters themselves (BigInteger, string, UInt160, byte span, payload identity) '
    'are CLR conversion functions supplied as opaque results.',
    'No diagnostic callback observes the converted arguments, and the handler body does not run in '
    'this lane.',
]
UNPROVED = [
    'The per-type converter functions, their BigInteger narrowing and every FormatException they '
    'may raise; only their results are inputs.',
    'The handler body, its return value and its continuation; this lane ends at the converted '
    'argument vector.',
    'Gas metering and descriptor pricing; only the absence of an add-fee step inside this window is '
    'recorded.',
    'Reference counting, disposables added by Convert(object?), and payload aliasing between the '
    'caller and the handler.',
    'Trusted C# extraction and compiler/CLR correspondence; all 109 public entrypoints.',
]
TCB = ['Strict complete-method C# grammar and field/symbol binding.',
       'C# switch-expression dispatch, reflection over the handler signature and LINQ OfType/Select.',
       'Externally supplied well-formed stack window and exact virtual dispatch of the handler.']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


# The tokenizer is the one the entry-dispatch, syscall and contract-handoff lanes
# use, so every lane normalizes C# identically; a divergence would make the
# projections incomparable.
from csharp_tokens import TOKENIZER as TOKEN

def normalize(text):
    """Join the tokens of a fragment the way a whole body is joined."""
    items = []
    position = 0
    while position < len(text):
        match = TOKEN.match(text, position)
        require(match is not None, 'Unsupported fragment token')
        position = match.end()
        token = match.group()
        if token.isspace() or token.startswith(('//', '/*')):
            continue
        items.append(token)
    return ''.join(items)


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


# Reviewed normalized bodies. A body is accepted only as exactly this text or as
# exactly one enumerated mutation of it, so a source edit cannot be absorbed.
TEMPLATES = {
 'OnSysCall': '{ValidateCallFlags(descriptor.RequiredCallFlags);AddFee(descriptor.FixedPrice*_execFeeFactor,false);object?[]parameters=newobject?[descriptor.Parameters.Count];for(inti=0;i<parameters.Length;i++)parameters[i]=Convert(Pop(),descriptor.Parameters[i]);object?returnValue=descriptor.Handler.Invoke(this,parameters);if(descriptor.Handler.ReturnType!=typeof(void))Push(Convert(returnValue));}',
 'ConvertObject': '{if(valueisIDisposabledisposable)Disposables.Add(disposable);returnvalueswitch{null=>StackItem.Null,boolb=>b,sbytei=>i,bytei=>(BigInteger)i,shorti=>i,ushorti=>(BigInteger)i,inti=>i,uinti=>i,longi=>i,ulongi=>i,Enume=>Convert(System.Convert.ChangeType(e,e.GetTypeCode())),byte[]data=>data,ReadOnlyMemory<byte>m=>m,strings=>s,BigIntegeri=>i,JObjecto=>o.ToByteArray(false),IInteroperableinteroperable=>interoperable.ToStackItem(),ISerializablei=>i.ToArray(),StackItemitem=>item,(objecta,objectb)=>newStruct(){Convert(a),Convert(b)},Arrayarray=>newVMArray(array.OfType<object>().Select(p=>Convert(p))),_=>StackItem.FromInterface(value)};}',
 'ConvertParameter': '{if(item.IsNull&&!descriptor.IsNullable&&descriptor.Type!=typeof(StackItem))thrownewInvalidOperationException($"The argument `{descriptor.Name}` can\'t be null.");descriptor.Validate(item);if(descriptor.IsArray){Arrayav;if(itemisVMArrayarray){av=Array.CreateInstance(descriptor.Type.GetElementType()!,array.Count);for(inti=0;i<av.Length;i++){if(array[i].IsNull&&!descriptor.IsElementNullable)thrownewInvalidOperationException($"The element of `{descriptor.Name}` can\'t be null.");av.SetValue(descriptor.Converter(array[i]),i);}}else{intcount=(int)item.GetInteger();if(count>Limits.MaxStackSize)thrownewInvalidOperationException();av=Array.CreateInstance(descriptor.Type.GetElementType()!,count);for(inti=0;i<av.Length;i++){StackItempopped=Pop();if(popped.IsNull&&!descriptor.IsElementNullable)thrownewInvalidOperationException($"The element of `{descriptor.Name}` can\'t be null.");av.SetValue(descriptor.Converter(popped),i);}}returnav;}else{object?value=descriptor.Converter(item);if(descriptor.IsEnum)value=Enum.ToObject(descriptor.Type,value!);elseif(descriptor.IsInterface)value=((InteropInterface?)value)?.GetInterface<object>();returnvalue;}}',
}

METHODS = {'OnSysCall': ('core/engine', SIGNATURES['OnSysCall'][1]),
           'ConvertObject': ('core/engine', SIGNATURES['ConvertObject'][1]),
           'ConvertParameter': ('core/engine', SIGNATURES['ConvertParameter'][1])}

# The descriptor's derived flags and the converter table are read from the
# declaration text rather than through the tokenizer: they are single-line
# members and the exact text is the claim.

# slot -> (before, after) in raw file text. Removing either reason-only guard
# still faults on the same input, so neither is mutated.
CONTROL_MUTATIONS = {
 'read-arg-count-from-the-stack':
    ('core/engine', 'object?[] parameters = new object?[descriptor.Parameters.Count];',
     'object?[] parameters = new object?[(int)Pop().GetInteger()];'),
 'pop-twice-per-parameter':
    ('core/engine', 'parameters[i] = Convert(Pop(), descriptor.Parameters[i]);',
     'parameters[i] = Convert(Pop(Pop()), descriptor.Parameters[i]);'),
 'fill-parameters-backwards':
    ('core/engine', 'parameters[i] = Convert(Pop(), descriptor.Parameters[i]);',
     'parameters[parameters.Length - 1 - i] = Convert(Pop(), descriptor.Parameters[i]);'),
 'push-void-return':
    ('core/engine', 'if (descriptor.Handler.ReturnType != typeof(void))',
     'if (true)'),
 'keep-null-return-elements':
    ('core/engine', 'new VMArray(array.OfType<object>().Select(p => Convert(p)))',
     'new VMArray(array.Select(p => Convert(p)))'),
 'include-byte-arrays':
    ('core/interop-parameter', 'Type.IsArray && Type.GetElementType() != typeof(byte)',
     'Type.IsArray'),
 'convert-elements-with-the-array-converter':
    ('core/interop-parameter', 'Converter = converters[type.GetElementType()!];',
     'Converter = converters[type];'),
 'convert-enums-as-integers':
    ('core/interop-parameter', 'Converter = converters[type.GetEnumUnderlyingType()];',
     'Converter = converters[type];'),
 'unknown-types-are-not-interfaces':
    ('core/interop-parameter', 'IsInterface = true;', 'IsInterface = false;'),
 'copy-plain-array-elements':
    ('core/interop-parameter', '[typeof(Array)] = p => p,', '[typeof(Array)] = p => p.GetBoolean(),'),
 'payload-length-is-not-the-item-count':
    ('core/engine', 'av = Array.CreateInstance(descriptor.Type.GetElementType()!, array.Count);',
     'av = Array.CreateInstance(descriptor.Type.GetElementType()!, Limits.MaxStackSize);'),
 'fill-payload-elements-backwards':
    ('core/engine', 'av.SetValue(descriptor.Converter(array[i]), i);',
     'av.SetValue(descriptor.Converter(array[av.Length - 1 - i]), i);'),
 'fill-counted-elements-backwards':
    ('core/engine', 'av.SetValue(descriptor.Converter(popped), i);',
     'av.SetValue(descriptor.Converter(popped), av.Length - 1 - i);'),
 'keep-the-counted-items-on-the-stack':
    ('core/engine', 'StackItem popped = Pop();', 'StackItem popped = item;'),
 'weaken-the-stack-size-limit':
    ('vm/limits', 'public uint MaxStackSize { get; init; } = 2 * 1024;',
     'public uint MaxStackSize { get; init; } = 2 * 1024 * 1024;'),
 'allow-a-null-argument':
    ('core/engine',
     'if (item.IsNull && !descriptor.IsNullable && descriptor.Type != typeof(StackItem))',
     'if (false)'),
 'allow-a-null-payload-element':
    ('core/engine', 'if (array[i].IsNull && !descriptor.IsElementNullable)', 'if (false)'),
 'allow-a-null-counted-element':
    ('core/engine', 'if (popped.IsNull && !descriptor.IsElementNullable)', 'if (false)'),
}
EXPECTED_CONTROLS = tuple(CONTROL_MUTATIONS)


def alternates():
    """Normalized (before, after) pairs, one per mutation, keyed by method."""
    table = {}
    for name, (key, before, after) in CONTROL_MUTATIONS.items():
        if key not in ('core/engine',):
            continue
        for method, (method_key, _) in METHODS.items():
            if method_key != key:
                continue
            normalized_before, normalized_after = normalize(before), normalize(after)
            require(normalized_before != normalized_after, 'Empty semantic mutation: ' + name)
            if normalized_before in TEMPLATES[method]:
                table.setdefault(method, []).append((normalized_before, normalized_after))
    return table


ALTERNATES = alternates()
require(set(ALTERNATES) == set(METHODS), 'A method has no accepted mutation alternate')
for _method, _pairs in ALTERNATES.items():
    for _before, _after in _pairs:
        require(TEMPLATES[_method].count(_before) == 1, 'Ambiguous mutation anchor: ' + _before)


def accepted_body(name, actual):
    template = TEMPLATES[name]
    if actual == template:
        return
    for before, after in ALTERNATES[name]:
        if actual == template.replace(before, after):
            return
    raise ValueError('Unrecognised body for ' + name)


def parameter_list(signature):
    """Return [[type, name], ...] for the declared parameters of a signature."""
    match = re.fullmatch(r'[\w<>?\[\], ]+?\s(\w+)\((.*)\)', signature)
    require(match is not None, 'Unparsable declaration: ' + signature)
    parameters = []
    for item in split_top_level(match.group(2)):
        # Split on the last space: a generic argument type keeps its own spaces
        # inside the angle brackets.
        parts = item.strip().rsplit(' ',1)
        require(len(parts) == 2, 'Unparsable parameter: ' + item)
        parameters.append([parts[0], parts[1]])
    return parameters


def split_top_level(text):
    parts, depth, current = [], 0, ''
    for character in text:
        depth += int(character == '<') - int(character == '>')
        if character == ',' and depth == 0:
            parts.append(current)
            current = ''
        else:
            current += character
    if current.strip():
        parts.append(current)
    return parts


def stack_size_limit(text):
    declaration = re.search(r'public\s+uint\s+MaxStackSize\s*\{\s*get;\s*init;\s*\}\s*=\s*([^;]+);',
                            text)
    require(declaration is not None, 'Missing MaxStackSize declaration')
    return evaluate_integer(declaration.group(1))


def evaluate_integer(expression):
    total = 0
    for term in expression.split('+'):
        product = 1
        for factor in term.split('*'):
            factor = factor.strip()
            require(re.fullmatch(r'\d+', factor) is not None, 'Unsupported integer term: ' + factor)
            product *= int(factor)
        total += product
    return total


def array_flag_expression(text):
    """Return the normalized predicate of the `IsArray` derived member."""
    match = re.search(r'public\s+bool\s+IsArray\s*=>\s*([^;]+);', text)
    require(match is not None, 'Missing IsArray declaration')
    return normalize(match.group(1))


def project_sources(contents, *, enforce_identity=True):
    require(set(contents) == set(SOURCES), 'Incomplete/extra interop conversion source set')
    if enforce_identity:
        for key, text in contents.items():
            require(sha(text.encode()) == SOURCES[key]['sha256'], 'Pinned source mismatch: ' + key)
    methods = {}
    for name, (key, header) in METHODS.items():
        methods[name] = body(contents[key], header)
        accepted_body(name, methods[name])
    on, converted, converted_object = (methods['OnSysCall'], methods['ConvertParameter'],
                                       methods['ConvertObject'])
    descriptor = contents['core/interop-parameter']
    # `argument_count` is the arity of the pinned `CallContract` declaration.
    # Unlike the other eighteen fields it has no textual mutant: the header is
    # what `body()` requires to appear exactly once, so deleting a parameter
    # makes the projector fail to parse instead of yielding a weaker record.
    # The number itself is asserted in the certificate.
    parameters = parameter_list(SIGNATURES['CallContract'][1])
    require(len(parameters) > 0, 'Unparsable CallContract parameter list')

    def has(text, snippet):
        return snippet in text

    program = dict(
        argument_count=len(parameters),
        argument_count_from_descriptor=has(
            on, 'newobject?[descriptor.Parameters.Count];'),
        pops_one_item_per_parameter=has(
            on, 'Convert(Pop(),descriptor.Parameters[i])'),
        pop_order_is_reversed=has(
            on, 'parameters[i]=Convert('),
        return_pushes_only_for_nonvoid_handler=has(
            on, 'if(descriptor.Handler.ReturnType!=typeof(void))Push(Convert(returnValue));'),
        return_payload_drops_nulls=has(
            converted_object, 'Arrayarray=>newVMArray(array.OfType<object>().Select(p=>Convert(p)))'),
        array_branch_excludes_byte_element=(
            array_flag_expression(descriptor)
            == 'Type.IsArray&&Type.GetElementType()!=typeof(byte)'),
        array_element_converter_from_element_type=has(
            descriptor, 'Converter = converters[type.GetElementType()!];'),
        enum_converter_from_underlying_type=has(
            descriptor, 'Converter = converters[type.GetEnumUnderlyingType()];'),
        unknown_type_is_interface=has(descriptor, 'IsInterface = true;'),
        identity_converter_for_plain_array=has(descriptor, '[typeof(Array)] = p => p,'),
        payload_branch_length_is_item_count=has(
            converted, 'av=Array.CreateInstance(descriptor.Type.GetElementType()!,array.Count);'),
        payload_branch_fills_in_index_order=has(
            converted, 'av.SetValue(descriptor.Converter(array[i]),i);'),
        counted_branch_fills_in_index_order=has(
            converted, 'av.SetValue(descriptor.Converter(popped),i);'),
        counted_branch_pops_the_count=has(
            converted, 'intcount=(int)item.GetInteger();')
            and has(converted, 'StackItempopped=Pop();'),
        counted_branch_max_length=stack_size_limit(contents['vm/limits']),
        null_argument_rejected=has(
            converted,
            'if(item.IsNull&&!descriptor.IsNullable&&descriptor.Type!=typeof(StackItem))'
            'thrownewInvalidOperationException('),
        null_element_rejected_in_payload_branch=has(
            converted,
            'if(array[i].IsNull&&!descriptor.IsElementNullable)thrownewInvalidOperationException('),
        null_element_rejected_in_counted_branch=has(
            converted,
            'if(popped.IsNull&&!descriptor.IsElementNullable)thrownewInvalidOperationException('),
    )
    # Reason refinements, never mutated: removing either still faults on the same
    # input, so a mutant would keep the same outcome and prove nothing.
    for guard in ('ValidateCallFlags(descriptor.RequiredCallFlags);',
                  'descriptor.Validate(item);'):
        require(on.count(guard) == 1 or converted.count(guard) == 1,
                'Missing unconditional guard: ' + guard)
    return dict(schema='neoos-aa-interop-conversion-source/v1', scope=SCOPE,
                entryBoundary=ENTRY_BOUNDARY, coreSourceCommit=CORE_COMMIT,
                neoVmSourceCommit=VM_COMMIT,
                sourceHashes={k: sha(v.encode()) for k, v in contents.items()},
                methods=methods, program=program, parameters=parameters,
                reasonOnlyGuards=['call-flags', 'descriptor-validators'],
                preconditions=PRECONDITIONS, unproved=UNPROVED, tcb=TCB,
                sourceFrontendVerified=False)


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
    mirror = os.environ.get('AA_INTEROP_CONVERSION_SOURCE_MIRROR')
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
