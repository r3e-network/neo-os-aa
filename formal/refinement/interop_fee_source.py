"""Pinned projection of the interop descriptor charge.

The `interop-conversion` lane starts after the charge: its preconditions say the
fixed descriptor price "has already been charged", and its `unproved` list admits
that only the *absence* of an add-fee step inside the conversion window is
recorded. This lane covers that admitted hole. It reads the charge out of the
pinned `ApplicationEngine.OnSysCall` / `AddFee` bodies and the pinned
`InteropDescriptor` declaration, and it stops at the argument-window effect: the
charge is fixed before any parameter is popped, so nothing the conversion does
can change it.

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
SCOPE = 'interop-descriptor-charge-order'
ENTRY_BOUNDARY = 'OnSysCall-descriptor-charge-to-argument-window-effect'

SOURCES = {
    'core/engine': dict(repository='neo', commit=CORE_COMMIT,
                        sha256='97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb',
                        relativePath='src/Neo/SmartContract/ApplicationEngine.cs'),
    'core/descriptor': dict(
        repository='neo', commit=CORE_COMMIT,
        sha256='84c7d8ccc10c2832b7f76d4d4a147a09146524518a5ef81c4d0387443eb494ff',
        relativePath='src/Neo/SmartContract/InteropDescriptor.cs'),
}

SIGNATURES = {
    'OnSysCall': ('core/engine',
                  'protected virtual void OnSysCall(InteropDescriptor descriptor)'),
    'AddFee': ('core/engine', 'protected internal void AddFee(BigInteger gas, bool applyFactor)'),
    'ConvertParameter': ('core/engine',
                         'protected internal object? Convert(StackItem item, '
                         'InteropParameterDescriptor descriptor)'),
    'ConvertObject': ('core/engine', 'protected internal StackItem Convert(object? value)'),
}

PRECONDITIONS = [
    'The descriptor is the pinned registration for the invoked syscall, resolved once, and '
    'RequiredCallFlags, FixedPrice and Parameters are that descriptor\'s own members.',
    'ValidateCallFlags has already run inside the window; this lane records only where it sits '
    'relative to the charge, not what it accepts.',
    'The fee limit, the consumed counter and the whitelist bit are engine state supplied as '
    'inputs; this lane does not model how any of them reached their values.',
    'AddFee\'s own rejection paths are modelled by the boolean outcome of the charge call, not by '
    're-deriving the exception type or the arithmetic overflow behaviour of add.',
    'The fixed price is a non-negative `long` and the execution fee factor is a non-negative '
    'integer; a negative product is out of scope.',
    'The handler body does not run in this lane, and no diagnostic callback observes the charge.'
]
UNPROVED = [
    'The arithmetic of `_feeConsumed + gas` at BigInteger width, and whether a specific rejected '
    'charge surfaces as OutOfGas or as the generic Insufficient GAS invalid operation.',
    'How `_execFeeFactor` is obtained per hardfork path (policy read, pico factor, default value); '
    'only the identity of the member the charge multiplies by is recorded.',
    'Which descriptors actually declare a zero fixed price; the lane records only that the '
    'declaration permits zero.',
    'The conversion itself, the handler body and its return value; those stay in the '
    'interop-conversion lane.',
    'Trusted C# extraction and compiler/CLR correspondence; all 100 public entrypoints.'
]
TCB = ['Strict complete-method C# grammar and field/symbol binding.',
       'C# init-only property semantics and the reflection call that builds Parameters.',
       'Externally supplied engine fee state and exact virtual dispatch of the handler.']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


# The tokenizer is the one every other refinement lane uses, so all lanes
# normalize C# identically; a divergence would make projections incomparable.
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


# The reviewed normalized OnSysCall body. It is accepted only as exactly this
# text or as exactly one enumerated mutation of it, so a re-pin cannot absorb an
# order change silently.
ON_SYSCALL = ('{ValidateCallFlags(descriptor.RequiredCallFlags);'
              'AddFee(descriptor.FixedPrice*_execFeeFactor,false);'
              'object?[]parameters=newobject?[descriptor.Parameters.Count];'
              'for(inti=0;i<parameters.Length;i++)'
              'parameters[i]=Convert(Pop(),descriptor.Parameters[i]);'
              'object?returnValue=descriptor.Handler.Invoke(this,parameters);'
              'if(descriptor.Handler.ReturnType!=typeof(void))Push(Convert(returnValue));}')

# The ordered steps this lane orders. Each anchor below is stable under every
# mutation the lane enumerates, so only the two order mutants can move them.
STEP_ANCHORS = [
    ('validate-call-flags', 'ValidateCallFlags('),
    ('charge', 'AddFee('),
    ('allocate-vector', 'newobject?['),
    ('pop-and-convert', 'Convert(Pop()'),
    ('invoke-handler', 'descriptor.Handler.Invoke('),
    ('push-result', 'Push(Convert(returnValue))'),
]

# name -> (source key, before, after), applied to the raw pinned text. Every
# mutation must move exactly one projected field; the tests assert that.
CONTROL_MUTATIONS = {
 'charge-before-the-flag-check':
    ('core/engine',
     '            ValidateCallFlags(descriptor.RequiredCallFlags);\n'
     '            AddFee(descriptor.FixedPrice * _execFeeFactor, false);',
     '            AddFee(descriptor.FixedPrice * _execFeeFactor, false);\n'
     '            ValidateCallFlags(descriptor.RequiredCallFlags);'),
 'charge-after-the-conversion-loop':
    ('core/engine',
     '            AddFee(descriptor.FixedPrice * _execFeeFactor, false);\n'
     '\n'
     '            object?[] parameters = new object?[descriptor.Parameters.Count];\n'
     '            for (int i = 0; i < parameters.Length; i++)\n'
     '                parameters[i] = Convert(Pop(), descriptor.Parameters[i]);',
     '            object?[] parameters = new object?[descriptor.Parameters.Count];\n'
     '            for (int i = 0; i < parameters.Length; i++)\n'
     '                parameters[i] = Convert(Pop(), descriptor.Parameters[i]);\n'
     '\n'
     '            AddFee(descriptor.FixedPrice * _execFeeFactor, false);'),
 'charge-reads-another-price-member':
    ('core/engine', 'AddFee(descriptor.FixedPrice * _execFeeFactor, false);',
     'AddFee(descriptor.Price * _execFeeFactor, false);'),
 'charge-multiplies-by-the-base-factor':
    ('core/engine', 'AddFee(descriptor.FixedPrice * _execFeeFactor, false);',
     'AddFee(descriptor.FixedPrice * FeeFactor, false);'),
 'ask-add-fee-to-apply-the-factor-again':
    ('core/engine', 'AddFee(descriptor.FixedPrice * _execFeeFactor, false);',
     'AddFee(descriptor.FixedPrice * _execFeeFactor, true);'),
 'size-the-vector-from-a-constant':
    ('core/engine', 'new object?[descriptor.Parameters.Count]', 'new object?[4]'),
 'convert-every-parameter-from-the-first-descriptor':
    ('core/engine', 'parameters[i] = Convert(Pop(), descriptor.Parameters[i]);',
     'parameters[i] = Convert(Pop(), descriptor.Parameters[0]);'),
 'take-the-arity-from-an-empty-signature':
    ('core/descriptor',
     'Handler.GetParameters().Select(p => new InteropParameterDescriptor(p)).ToList().AsReadOnly()',
     'System.Array.Empty<InteropParameterDescriptor>()'),
 'narrow-the-declared-price-to-int':
    ('core/descriptor', 'public long FixedPrice { get; init; }',
     'public int FixedPrice { get; init; }'),
 'declare-the-price-always-nonzero':
    ('core/descriptor',
     '/// The fixed price for calling the interoperable service. It can be 0 if the '
     'interoperable service has a variable price.',
     '/// The fixed price for calling the interoperable service. It is always positive.'),
 'accept-a-negative-fee':
    ('core/engine', 'if (gas < 0)', 'if (gas < -1)'),
 'charge-a-whitelisted-context':
    ('core/engine', '?.WhiteListed == true)', '?.WhiteListed == false)'),
 'always-apply-the-factor-branch':
    ('core/engine', 'if (applyFactor)', 'if (true)'),
 'check-the-limit-before-counting-the-charge':
    ('core/engine',
     '            _feeConsumed = _feeConsumed + gas;\n'
     '            if (_feeConsumed > _feeAmount)\n'
     '                throw new InvalidOperationException("Insufficient GAS.");',
     '            if (_feeConsumed > _feeAmount)\n'
     '                throw new InvalidOperationException("Insufficient GAS.");\n'
     '            _feeConsumed = _feeConsumed + gas;'),
 'reject-a-call-at-exactly-the-limit':
    ('core/engine', 'if (_feeConsumed > _feeAmount)', 'if (_feeConsumed >= _feeAmount)'),
 'charge-a-fee-inside-the-conversion-window':
    ('core/engine',
     'protected internal object? Convert(StackItem item, InteropParameterDescriptor descriptor)\n'
     '        {',
     'protected internal object? Convert(StackItem item, InteropParameterDescriptor descriptor)\n'
     '        {\n'
     '            AddFee(0, false);'),
}
EXPECTED_CONTROLS = tuple(CONTROL_MUTATIONS)


def alternates():
    """Normalized (before, after) pairs that the OnSysCall template accepts."""
    table = []
    for name, (key, before, after) in CONTROL_MUTATIONS.items():
        if key != 'core/engine':
            continue
        normalized_before, normalized_after = normalize(before), normalize(after)
        require(normalized_before != normalized_after, 'Empty semantic mutation: ' + name)
        if normalized_before in ON_SYSCALL:
            table.append((normalized_before, normalized_after))
    return table


ALTERNATES = alternates()
for _before, _after in ALTERNATES:
    require(ON_SYSCALL.count(_before) == 1, 'Ambiguous mutation anchor: ' + _before)


def accepted_body(actual):
    if actual == ON_SYSCALL:
        return
    for before, after in ALTERNATES:
        if actual == ON_SYSCALL.replace(before, after):
            return
    raise ValueError('Unrecognised OnSysCall body')


def unique(text, needle, label):
    require(text.count(needle) == 1, 'Missing/ambiguous ' + label + ': ' + needle)
    return text.index(needle)


def step_order(on):
    """Return the ordered step names, read from where each anchor sits."""
    placed = [(on.index(anchor), name) for name, anchor in STEP_ANCHORS]
    return [name for _, name in sorted(placed)]


def charged_by_whitelist(text):
    """True when the whitelist branch tests `true` and returns before the counter.

    Written without raising on absence: the mutant that inverts the comparison
    must yield `false`, not a projector error.
    """
    guard = text.find('?.WhiteListed == true)')
    consumed = text.find('_feeConsumed = _feeConsumed + gas;')
    require(consumed >= 0, 'Missing counter increment')
    return 0 <= guard < consumed


def charge_arguments(on):
    """Return the argument texts of the single AddFee call in OnSysCall."""
    start = on.index('AddFee(') + len('AddFee(')
    end = on.index(');', start)
    arguments, depth, current = [], 0, ''
    for character in on[start:end]:
        depth += int(character == '(') - int(character == ')')
        if character == ',' and depth == 0:
            arguments.append(current)
            current = ''
        else:
            current += character
    arguments.append(current)
    return arguments


def project_sources(contents, *, enforce_identity=True):
    require(set(contents) == set(SOURCES), 'Incomplete/extra interop charge source set')
    if enforce_identity:
        for key, text in contents.items():
            require(sha(text.encode()) == SOURCES[key]['sha256'], 'Pinned source mismatch: ' + key)
    engine, descriptor = contents['core/engine'], contents['core/descriptor']
    on = body(engine, SIGNATURES['OnSysCall'][1])
    accepted_body(on)
    add_fee = body(engine, SIGNATURES['AddFee'][1])
    converted = body(engine, SIGNATURES['ConvertParameter'][1])
    converted_object = body(engine, SIGNATURES['ConvertObject'][1])
    # The window that must not charge: from the vector allocation to the handler
    # call, plus both Convert bodies.
    loop_start = on.index('newobject?[')
    loop_end = on.index('descriptor.Handler.Invoke(')
    require(loop_start < loop_end, 'Unrecognised conversion window')
    arguments = charge_arguments(on)
    require(len(arguments) == 2, 'Unrecognised charge call')

    program = dict(
        step_order=step_order(on),
        charge_reads_the_declared_price='descriptor.FixedPrice' in on,
        charge_uses_the_exec_factor='_execFeeFactor' in on,
        charge_skips_the_inner_factor=arguments[1] == 'false',
        vector_length_from_descriptor='newobject?[descriptor.Parameters.Count]' in on,
        pops_one_item_per_parameter='Convert(Pop(),descriptor.Parameters[i])' in on,
        arity_from_the_handler_signature=(
            'Handler.GetParameters().Select(p=>newInteropParameterDescriptor(p))'
            in normalize(descriptor)),
        declared_price_type_is_long='public long FixedPrice { get; init; }' in descriptor,
        declared_price_may_be_zero=(
            'It can be 0 if the interoperable service has a variable price.' in descriptor),
        negative_fee_is_rejected=(
            'if (gas < 0)' in engine
            and "throw new InvalidOperationException(\"AddFee can't be negative.\");" in engine),
        whitelist_bypasses_the_charge=charged_by_whitelist(engine),
        factor_applied_only_when_requested=(
            'if (applyFactor)' in engine and 'gas *= FeeFactor;' in engine),
        consumed_incremented_before_the_limit_check=(
            unique(add_fee, '_feeConsumed=_feeConsumed+gas;', 'counter increment')
            < unique(add_fee, 'if(_feeConsumed>', 'limit check')),
        limit_check_is_strict='if(_feeConsumed>_feeAmount)' in add_fee,
        no_fee_inside_the_conversion_window=(
            'AddFee' not in converted and 'FeeFactor' not in converted_object),
    )
    return dict(schema='neoos-aa-interop-charge-source/v1', scope=SCOPE,
                entryBoundary=ENTRY_BOUNDARY, coreSourceCommit=CORE_COMMIT,
                sourceHashes={k: sha(v.encode()) for k, v in contents.items()},
                methods=dict(onSysCall=on, addFee=add_fee),
                program=program,
                reasonOnlyGuards=['descriptor-price-identity', 'fee-factor-source'],
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
    same pinned value a download would have to reach, so a mirror cannot launder
    a different artifact. This only substitutes for a stalled network.
    """
    mirror = os.environ.get('AA_INTEROP_CHARGE_SOURCE_MIRROR')
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
