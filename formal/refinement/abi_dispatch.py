"""What the actual ApplicationEngine does with the pinned artifact.

The trustworthy half of `SOURCE_FRONTEND_AND_COMPILER_CORRESPONDENCE` is a claim
about text: two readers, and Microsoft's lexer, read the pinned C# the same way.
None of that touches the other leg of the same trust item — what the compiled
bytes mean. A projection lane can read the dispatch path out of C# correctly and
still describe a contract nobody deployed.

This module looks at the deployed bytes instead. `export` grew a mode that
deploys the pinned NEF into a real `ApplicationEngine` (Neo 3.9.1, the assemblies
the compiler ships) and calls every ABI method by name with the arity the manifest
declares. What comes back is a measurement, not an argument:

    * which offset the engine entered, per method;
    * whether the declared entry point was executed at all;
    * in which state the call ended, and with which fault message;
    * which syscalls the contract reached, in order.

Four questions are asked of that measurement, and a fifth of the values it left
behind, and nothing else:

    shape        the dump covers exactly the manifest's methods: same count,
                 same name/arity set. A dump that quietly lost a method cannot
                 pass by having nothing to disagree with.
    dispatch     for every method that is not an engine entry point, the offset
                 the engine entered is the offset the manifest declares, and the
                 dump's copy of that offset is the manifest's.
    reach        the instruction at the declared offset was executed, not merely
                 loaded. This is the difference between "the dispatcher resolved
                 the name" and "the method ran".
    reserved     `_deploy` and `_initialize` are invoked by the engine, never by
                 name. A named call to either must be refused, and the refusal is
                 recorded as a fact about this engine rather than as an excuse for
                 a missing measurement.
    returned     the item the call left on the result stack is described by the
                 declared return type, including its width where the type has one.
                 A null return is allowed for a reference type - the manifest has
                 no way to say "may be null" - but it is counted separately and
                 never counted as having exercised the declared type.

A sixth question is asked of the other half of a dispatch rule - what the engine
does with a call that does *not* match the manifest:

    boundary     a call whose parameter count no overload of that name declares,
                 and a call whose name nobody declares, are refused by the
                 boundary before the callee's first instruction runs, with the
                 engine's own message. A call whose parameter count *is* declared
                 by a sibling overload lands on that sibling's offset, which is
                 what makes "name and arity select" a measurement rather than a
                 reading of the source. And an argument whose shape the manifest
                 says cannot arrive is measured rather than decreed: on this
                 engine it is not refused at the boundary at all - the callee
                 receives it and either throws in the VM or answers - so the
                 receipt records `shapeEnforcedAtBoundary: false` instead of
                 assuming a rule the engine does not have.

What this module will never report: that the contract is correct, that a call
with real arguments behaves as intended, that the C# in `contracts/` means what
the opcodes do, or that the artifact is the compiler's output. The exporter's
compile-and-compare mode covers the last one; this module does not repeat it.
`fullImplementationVerified` stays false.
"""

import hashlib
import json
import os

SCHEMA = 'aa-abi-dispatch/v3'
BOUNDARY_SCHEMA = 'aa-abi-boundary/v1'
SCOPE = 'actual-vm-application-engine-abi-dispatch'

# The one text that identifies a refusal made by the boundary rather than by the
# callee: ContractManagement answering a (name, arity) pair the manifest does not
# declare. It is quoted from the measurement, not paraphrased.
NOT_DECLARED_MARKER = "doesn't exist in the contract"

# The other boundary refusal, and the one that comes first: a name beginning with
# an underscore is rejected before the arity is even looked at, which is why the
# arity probes for `_deploy` and `_initialize` carry this text rather than the
# one above.
UNDERSCORE_MARKER = "cannot start with underscore"

# Both are refusals the boundary makes. A call that did not enter a callee frame
# and carries neither of these is a refusal this face cannot classify, and it
# says so instead of filing it under "measured".
BOUNDARY_REFUSAL_MARKERS = (NOT_DECLARED_MARKER, UNDERSCORE_MARKER)

# Kinds of probe the boundary face measures, and what each one is for.
#   control   the arity-matched call the dispatch face makes; the positive anchor
#             for every refusal recorded beside it
#   arity     a parameter count no overload of this name declares
#   overload  a parameter count a sibling overload declares
#   type      an argument whose shape the manifest says cannot arrive
#   absent    a name no method declares
BOUNDARY_KINDS = ('control', 'arity', 'overload', 'type', 'absent')

# The two names the engine dispatches itself. A named `System.Contract.Call` to
# either is refused by ContractManagement, which is why the measurement records
# them as refused rather than as dispatched-with-a-different-offset.
RESERVED_ENTRY_POINTS = ('_deploy', '_initialize')

UNKNOWN_SYSCALL_PREFIX = '0x'

# What the manifest declares, against what the stack holds. `Void` is `Any`
# rather than "nothing": `System.Contract.Call` pushes the callee's result
# whatever it is, so a named call to a void method leaves one Null item. That is
# measured on the pinned artifact, not decreed - the first draft assumed zero
# items and the artifact disagreed on two methods.
RETURN_STACK_TYPES = {
    'Void': 'Any', 'Any': '*',
    'Boolean': 'Boolean', 'Integer': 'Integer',
    'ByteArray': 'ByteString', 'String': 'ByteString', 'ByteString': 'ByteString',
    'Buffer': 'Buffer', 'Array': 'Array', 'Struct': 'Struct', 'Map': 'Map',
    'Hash160': 'ByteString', 'Hash256': 'ByteString',
    'PublicKey': 'ByteString', 'Signature': 'ByteString',
    'InteropInterface': 'InteropInterface',
}

# The fixed-width types are a length in the manifest's own terms: a Hash160 that
# comes back as 32 bytes is not a Hash160.
RETURN_FIXED_BYTES = {'Hash160': 20, 'Hash256': 32, 'PublicKey': 33, 'Signature': 64}

# The stack type of a null item. NeoVM calls it `Any` because a null carries no
# type of its own.
NULL_STACK_TYPE = 'Any'

# Declared types the ABI cannot distinguish from a null return. Neo's manifest
# has no nullability: a method whose C# signature says `object[]?` still declares
# `Array`, and the artifact is right to answer null. Requiring a value here would
# fail a correct contract, so null satisfies a reference declaration - and is
# counted, because a null return applied no rule and must not look like one that
# did. Value types are deliberately absent: a call that declares an Integer and
# answers null answered with something other than what it declared.
NULLABLE_RETURN_TYPES = {'Any', 'Array', 'Struct', 'Map', 'ByteString', 'String', 'Buffer',
                         'InteropInterface', 'Hash160', 'Hash256', 'PublicKey', 'Signature'}


def return_shape(declared, count, observed):
    """(status, expected, observed) for one returned item against its declaration.

    One rule, used by the dispatch face and by the scenario face, so "the manifest
    describes what came back" is not decided twice in two places.

    status:
        'match'    a value of the declared type, and the type was exercised
        'null'     null where a reference type was declared: allowed, not applied
        'count'    the wrong number of items on the result stack
        'type'     a value of another type, including null for a value type
        'unknown'  a declared type this face has no rule for
    """
    expected = RETURN_STACK_TYPES.get(declared)
    if declared is None or expected is None:
        return 'unknown', declared, observed
    if count != 1:
        return 'count', declared, count
    if expected != '*' and observed == NULL_STACK_TYPE and declared in NULLABLE_RETURN_TYPES:
        return 'null', expected, observed
    if expected != '*' and observed != expected:
        return 'type', expected, observed
    return 'match', expected, observed


def return_width(declared, observed_bytes):
    """(fixed, observed) when a fixed-width declaration came back the wrong size."""
    fixed = RETURN_FIXED_BYTES.get(declared)
    if fixed is None:
        return None
    return None if observed_bytes == fixed else (fixed, observed_bytes)


def _sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def manifest_methods(path):
    """Return ({name/arity: offset}, {name/arity: returntype}, sha256) for a pinned manifest.

    Read as JSON rather than through the lanes' projection code on purpose: this
    face must not inherit a reading of the manifest that the lanes are the ones
    being measured on.
    """
    with open(path, 'rb') as handle:
        raw = handle.read()
    manifest = json.loads(raw.decode('utf-8'))
    methods, returns = {}, {}
    for row in manifest.get('abi', {}).get('methods', []):
        key = row['name'] + '/' + str(len(row.get('parameters', [])))
        methods[key] = row['offset']
        returns[key] = row.get('returntype')
    return methods, returns, _sha256(raw)


def manifest_parameters(path):
    """Return {name/arity: [declared parameter types]} for a pinned manifest.

    Read separately from `manifest_methods` so that the signatures the boundary
    face reasons about are the manifest's own declarations and not something a
    dump supplied. Two reads of one small file cost less than a shared mutable
    view of it.
    """
    with open(path, encoding='utf-8') as handle:
        manifest = json.load(handle)
    return {row['name'] + '/' + str(len(row.get('parameters', []))):
            [str(parameter.get('type')) for parameter in row.get('parameters', [])]
            for row in manifest.get('abi', {}).get('methods', [])}


def _key(row):
    return row.get('name', '?') + '/' + str(row.get('parameters', '?'))


def expected_probes(declared, parameters, undeclared_name):
    """The probe set the manifest implies, as a set of (name, kind, arity, shapes).

    Derived here rather than taken from the dump, so that a probe the exporter
    stopped emitting is a disagreement instead of a smaller measurement, and a
    probe relabelled from `arity` to `overload` cannot pass by describing itself.
    """
    arities = {}
    for key in declared:
        name, arity = key.rsplit('/', 1)
        arities.setdefault(name, set()).add(int(arity))
    probes = set()
    for key, types in parameters.items():
        name, arity = key.rsplit('/', 1)
        arity = int(arity)
        probes.add((name, 'control', arity, 'zeros'))
        for candidate in (arity - 1, arity + 1):
            if candidate < 0:
                continue
            kind = 'overload' if candidate in arities.get(name, ()) else 'arity'
            probes.add((name, kind, candidate, 'zeros'))
        if types and types[0] != 'Any':
            # A compound where a scalar was declared, and the reverse. `Any`
            # accepts either shape, so a mismatch there would not be one.
            shapes = 'scalar-for-compound' if types[0] in ('Array', 'Map') else 'compound-for-scalar'
            probes.add((name, 'type', arity, shapes))
    probes.add((undeclared_name, 'absent', 0, 'zeros'))
    return probes


def boundary_face(dump, declared, parameters):
    """(summary, problems) for the calls that do *not* match the manifest.

    The rules are asymmetric on purpose, because the measurements are:

    * a parameter count no overload of the name declares, and a name nobody
      declares, must be refused by the boundary before a callee frame exists -
      that is what "the manifest is the admission rule" means;
    * a parameter count a sibling overload declares must land on *that* sibling's
      offset, which is the positive half of the same claim;
    * an argument of the wrong shape is *recorded*, never judged: on this engine
      the boundary does not enforce declared parameter types, so what happens
      afterwards is the callee's business. The receipt says
      `shapeEnforcedAtBoundary: false` rather than asserting a rule the engine
      does not have, and a refusal it cannot classify is a problem, not a pass.
    """
    boundary = dump.get('boundary') or {}
    probes = boundary.get('probes') or []
    undeclared_name = boundary.get('undeclaredName')
    summary = {
        'boundarySchema': boundary.get('schema') == BOUNDARY_SCHEMA,
        'boundaryProbes': 0, 'boundaryProbesExpected': 0, 'boundaryProbesMatch': False,
        'boundaryControls': 0, 'boundaryControlsEntered': 0, 'boundaryControlsRefused': 0,
        'boundaryArityProbes': 0, 'boundaryArityRefused': 0, 'boundaryArityEntered': 0,
        'boundaryOverloadProbes': 0, 'boundaryOverloadLandedOnSibling': 0,
        'boundaryTypeProbes': 0, 'boundaryTypeEntered': 0, 'boundaryTypeRefused': 0,
        'boundaryTypeCompleted': 0, 'boundaryTypeFaultedInside': 0,
        'boundaryAbsentRefused': False,
        'shapeEnforcedAtBoundary': False,
    }
    problems = []
    if not probes:
        problems.append(['boundary', 'missing', 'the dump carries no boundary probes'])
        return summary, problems
    summary['boundaryProbes'] = len(probes)

    expected = expected_probes(declared, parameters, undeclared_name)
    summary['boundaryProbesExpected'] = len(expected)
    seen = set()
    for row in probes:
        key = (row.get('name'), row.get('kind'), row.get('arity'), row.get('argShapes'))
        if key in seen:
            problems.append([str(row.get('name')) + '/' + str(row.get('arity')),
                             'boundary-duplicate', str(row.get('kind'))])
            continue
        seen.add(key)
    label = lambda row: (str(row.get('kind')) + ':' + str(row.get('name'))
                         + '/' + str(row.get('arity')))
    if seen != expected:
        summary['boundaryProbesMatch'] = False
        for key in sorted(expected - seen):
            problems.append([str(key[0]) + '/' + str(key[2]), 'boundary-probe-missing',
                             str(key[1]) + ' ' + str(key[3])])
        for key in sorted(seen - expected):
            problems.append([str(key[0]) + '/' + str(key[2]), 'boundary-probe-unexpected',
                             str(key[1]) + ' ' + str(key[3])])
    else:
        summary['boundaryProbesMatch'] = True

    def detail(row):
        return ' '.join(str(row.get(part) or '') for part in ('fault', 'faultDetail'))

    def refused(row):
        return row.get('entered') is False

    def refusal_marker(row):
        text = detail(row)
        for marker in BOUNDARY_REFUSAL_MARKERS:
            if marker in text:
                return marker
        return None

    for row in probes:
        if row.get('engineError'):
            problems.append([label(row), 'boundary-engine-error', str(row['engineError'])[:120]])
            continue
        if row.get('stepLimitReached'):
            problems.append([label(row), 'boundary-step-limit', str(row.get('steps'))])
        kind = row.get('kind')
        name = row.get('name')
        key = str(name) + '/' + str(row.get('arity'))
        if kind == 'control':
            summary['boundaryControls'] += 1
            if name in RESERVED_ENTRY_POINTS:
                if refused(row) and refusal_marker(row) == UNDERSCORE_MARKER:
                    summary['boundaryControlsRefused'] += 1
                else:
                    problems.append([label(row), 'boundary-reserved-entered',
                                     'entered ' + str(row.get('enteredOffset'))])
            elif row.get('entered') is True and row.get('enteredOffset') == declared.get(key):
                summary['boundaryControlsEntered'] += 1
            else:
                problems.append([label(row), 'boundary-control-lost',
                                 'declared ' + str(declared.get(key))
                                 + ' entered ' + str(row.get('enteredOffset'))])
            continue
        if kind == 'arity':
            summary['boundaryArityProbes'] += 1
            if row.get('entered') is True:
                summary['boundaryArityEntered'] += 1
                problems.append([label(row), 'boundary-arity-entered',
                                 'entered ' + str(row.get('enteredOffset'))])
                continue
            marker = refusal_marker(row)
            wanted = UNDERSCORE_MARKER if name in RESERVED_ENTRY_POINTS else NOT_DECLARED_MARKER
            if marker == wanted:
                summary['boundaryArityRefused'] += 1
            elif marker is None:
                problems.append([label(row), 'boundary-refusal-unclassified', detail(row)[:120]])
            else:
                problems.append([label(row), 'boundary-refusal-other', marker])
            continue
        if kind == 'overload':
            summary['boundaryOverloadProbes'] += 1
            if key not in declared:
                problems.append([label(row), 'boundary-overload-not-declared', key])
            elif row.get('enteredOffset') == declared[key]:
                summary['boundaryOverloadLandedOnSibling'] += 1
            else:
                problems.append([label(row), 'boundary-overload-elsewhere',
                                 'sibling declares ' + str(declared[key])
                                 + ' entered ' + str(row.get('enteredOffset'))])
            continue
        if kind == 'type':
            summary['boundaryTypeProbes'] += 1
            if key not in declared:
                problems.append([label(row), 'boundary-type-not-declared', key])
                continue
            if row.get('entered') is True:
                summary['boundaryTypeEntered'] += 1
                if row.get('enteredOffset') != declared[key]:
                    problems.append([label(row), 'boundary-type-elsewhere',
                                     'declared ' + str(declared[key])
                                     + ' entered ' + str(row.get('enteredOffset'))])
                if row.get('state') == 'HALT':
                    summary['boundaryTypeCompleted'] += 1
                else:
                    summary['boundaryTypeFaultedInside'] += 1
            elif refusal_marker(row) is not None:
                summary['boundaryTypeRefused'] += 1
            else:
                problems.append([label(row), 'boundary-refusal-unclassified', detail(row)[:120]])
            continue
        if kind == 'absent':
            if undeclared_name not in {k.rsplit('/', 1)[0] for k in declared} and refused(row) \
                    and refusal_marker(row) == NOT_DECLARED_MARKER:
                summary['boundaryAbsentRefused'] = True
            else:
                problems.append([label(row), 'boundary-absent-not-refused',
                                 detail(row)[:120]])
            continue
        problems.append([label(row), 'boundary-unknown-kind', str(kind)])

    summary['shapeEnforcedAtBoundary'] = summary['boundaryTypeRefused'] > 0
    touched = set()
    for row in probes:
        touched.add(row.get('kind'))
    for kind in BOUNDARY_KINDS:
        if kind not in touched:
            problems.append(['boundary', 'boundary-kind-missing', kind])
    return summary, problems


def _face(dump, declared, returns, manifest_sha256, nef_sha256=None, parameters=None):
    """Compare the engine's measurement against the manifest. Returns (summary, problems)."""
    summary = {
        'methods': 0, 'declared': len(declared), 'shapeMatches': False,
        'dispatched': 0, 'dispatchMismatch': 0, 'unreached': 0,
        'reservedExpected': len(RESERVED_ENTRY_POINTS), 'reservedRefused': 0,
        'halted': 0, 'faulted': 0, 'noState': 0,
        'syscalls': 0, 'unknownSyscalls': 0,
        'engineErrors': 0, 'stepLimitReached': 0,
        'lazyInitializerInvocations': 0,
        'returnsChecked': 0, 'returnsMatch': 0, 'nullReturns': 0,
        'resultCountMismatch': 0, 'resultTypeMismatch': 0, 'resultBytesMismatch': 0,
        'faultsWithResult': 0, 'declaredTypesExercised': [], 'declaredTypesUnexercised': [],
        'manifestSha256Matches': dump.get('manifest', {}).get('sha256') == manifest_sha256,
        'nefSha256Matches': None,
    }
    if nef_sha256 is not None:
        summary['nefSha256Matches'] = dump.get('nef', {}).get('sha256') == nef_sha256
    problems = []
    exercised = set()

    rows = dump.get('methods') or []
    summary['methods'] = len(rows)
    seen = {}
    for row in rows:
        seen[_key(row)] = row
    summary['shapeMatches'] = (len(rows) == len(declared)
                               and set(seen) == set(declared))
    for key in sorted(set(declared) - set(seen)):
        problems.append([key, 'missing', 'in the manifest, absent from the dump'])
    for key in sorted(set(seen) - set(declared)):
        problems.append([key, 'extra', 'in the dump, absent from the manifest'])
    if len(rows) != len(seen):
        problems.append(['dump', 'duplicate', str(len(rows) - len(seen)) + ' repeated name/arity'])

    initialize_offset = dump.get('initializeOffset')
    for key in sorted(set(seen) & set(declared)):
        row = seen[key]
        name = row.get('name')
        if row.get('engineError'):
            summary['engineErrors'] += 1
            problems.append([key, 'engine-error', str(row['engineError'])[:120]])
            continue
        state = row.get('state')
        if state == 'HALT':
            summary['halted'] += 1
        elif state == 'FAULT':
            summary['faulted'] += 1
        else:
            summary['noState'] += 1
            problems.append([key, 'no-state', str(state)])
        if row.get('stepLimitReached'):
            summary['stepLimitReached'] += 1
            problems.append([key, 'step-limit', str(row.get('steps'))])
        for call in row.get('syscalls') or []:
            summary['syscalls'] += 1
            if str(call).startswith(UNKNOWN_SYSCALL_PREFIX):
                summary['unknownSyscalls'] += 1
                problems.append([key, 'unknown-syscall', str(call)])
        # The return shape, asked before the dispatch questions so that a dispatch
        # disagreement cannot hide it. What the manifest declares versus what the
        # stack holds is a different claim from "the right offset ran", and a call
        # that lands correctly and returns the wrong shape is a contract the
        # manifest does not describe.
        declared_return = returns.get(key)
        counted = row.get('resultCount')
        if state == 'HALT':
            summary['returnsChecked'] += 1
            status, expected, observed = return_shape(declared_return, counted, row.get('resultType'))
            if status == 'match':
                exercised.add(declared_return)
                summary['returnsMatch'] += 1
                width = return_width(declared_return, row.get('resultBytes'))
                if width is not None:
                    summary['resultBytesMismatch'] += 1
                    problems.append([key, 'result-bytes', str(width[0]), str(width[1])])
            elif status == 'null':
                # Allowed, and not counted as having applied the rule: nothing of
                # the declared type came back to apply it to.
                summary['nullReturns'] += 1
            elif status == 'count':
                summary['resultCountMismatch'] += 1
                problems.append([key, 'result-count', str(observed),
                                 'declares ' + str(declared_return)])
            elif status == 'unknown':
                summary['resultTypeMismatch'] += 1
                problems.append([key, 'unknown-return-type', str(declared_return)])
            else:
                summary['resultTypeMismatch'] += 1
                problems.append([key, 'result-type',
                                 str(declared_return) + '->' + str(expected), str(observed)])
        elif state == 'FAULT':
            # Deliberately not recorded as exercised: a fault returns nothing, so
            # the rule for that declared type was never applied. Counting it would
            # let an untested mapping look tested.
            if counted != 0:
                summary['faultsWithResult'] += 1
                problems.append([key, 'fault-with-result', str(counted)])
        if initialize_offset is not None and initialize_offset in (row.get('firstIps') or {}).values():
            summary['lazyInitializerInvocations'] += 1

        declared_offset = declared[key]
        if name in RESERVED_ENTRY_POINTS:
            if row.get('dispatchOffset') is None and row.get('reachedDeclared') is False:
                summary['reservedRefused'] += 1
            else:
                problems.append([key, 'reserved-dispatched',
                                 'declared ' + str(declared_offset)
                                 + ' dispatched ' + str(row.get('dispatchOffset'))])
            continue
        if row.get('offset') != declared_offset:
            summary['dispatchMismatch'] += 1
            problems.append([key, 'dump-offset', str(row.get('offset')), str(declared_offset)])
            continue
        if row.get('dispatchOffset') != declared_offset:
            summary['dispatchMismatch'] += 1
            problems.append([key, 'dispatch', 'declared ' + str(declared_offset),
                             'entered ' + str(row.get('dispatchOffset'))])
            continue
        summary['dispatched'] += 1
        if not row.get('reachedDeclared'):
            summary['unreached'] += 1
            problems.append([key, 'unreached', str(declared_offset)])
    declared_types = {value for value in returns.values() if value}
    summary['declaredTypesExercised'] = sorted(exercised)
    summary['declaredTypesUnexercised'] = sorted(declared_types - exercised)
    if parameters is not None:
        # The other half of a dispatch rule: what happens to a call the manifest
        # does not describe. Merged into the same summary so that one mutated
        # probe is caught by the same self test as a mutated method row.
        boundary_summary, boundary_problems = boundary_face(dump, declared, parameters)
        summary.update(boundary_summary)
        problems.extend(boundary_problems)
    return summary, problems


def _agrees_core(receipt):
    stats = receipt['stats']
    return (receipt['schema'] == SCHEMA
            and stats['declared'] > 0
            and stats['methods'] == stats['declared']
            and stats['shapeMatches']
            and stats['dispatched'] == stats['declared'] - stats['expectedReserved']
            and stats['dispatchMismatch'] == 0
            and stats['unreached'] == 0
            and stats['reservedRefused'] == stats['expectedReserved']
            and stats['unknownSyscalls'] == 0
            and stats['engineErrors'] == 0
            and stats['stepLimitReached'] == 0
            and stats['noState'] == 0
            and stats['manifestSha256Matches']
            and stats['nefSha256Matches'] in (True, None)
            # Five questions, and the fifth is about values: a call that lands on
            # the declared offset and hands back the wrong shape is a manifest the
            # artifact does not honour, and every other counter above is blind to it.
            # A null return is neither a value nor a failure: the manifest cannot
            # express nullability, so it is counted apart and never counted as a
            # rule applied.
            and stats['returnsChecked'] > 0
            and stats['returnsMatch'] + stats['nullReturns'] == stats['returnsChecked']
            and stats['resultCountMismatch'] == 0
            and stats['resultTypeMismatch'] == 0
            and stats['resultBytesMismatch'] == 0
            and stats['faultsWithResult'] == 0
            # The sixth question is the other half of the dispatch rule, and it
            # cannot be answered by any counter above: they all describe calls
            # that match the manifest. A name nobody declares and a parameter
            # count no overload has must be refused by the boundary, and a count
            # a sibling declares must land on that sibling. A wrong-shaped
            # argument is recorded rather than required to be refused, because on
            # this engine it is not.
            and stats['boundarySchema']
            and stats['boundaryProbesMatch']
            and stats['boundaryProbes'] == stats['boundaryProbesExpected'] > 0
            and stats['boundaryControls'] > 0
            and stats['boundaryControlsEntered'] > 0
            and stats['boundaryControlsRefused'] == stats['expectedReserved']
            and stats['boundaryArityProbes'] > 0
            and stats['boundaryArityRefused'] == stats['boundaryArityProbes']
            and stats['boundaryArityEntered'] == 0
            and stats['boundaryOverloadProbes'] > 0
            and stats['boundaryOverloadLandedOnSibling'] == stats['boundaryOverloadProbes']
            and stats['boundaryTypeProbes'] > 0
            and stats['boundaryTypeEntered'] + stats['boundaryTypeRefused'] == stats['boundaryTypeProbes']
            and stats['boundaryAbsentRefused']
            and not receipt['problems'])


def correspond(dump_path, manifest_path, nef_path=None):
    """Build the receipt for one dump of one artifact.

    `dump_path` is what the exporter wrote; `manifest_path` is the pinned
    manifest the lanes and the deployment both use, read here independently so
    that a dump produced against some other manifest cannot pass.
    """
    if not os.path.isfile(dump_path):
        raise ValueError('no ABI dispatch dump at ' + str(dump_path))
    with open(dump_path, encoding='utf-8') as handle:
        dump = json.load(handle)
    declared, returns, manifest_sha256 = manifest_methods(manifest_path)
    parameters = manifest_parameters(manifest_path)
    nef_sha256 = None
    if nef_path is not None:
        with open(nef_path, 'rb') as handle:
            nef_sha256 = _sha256(handle.read())
    summary, problems = _face(dump, declared, returns, manifest_sha256, nef_sha256, parameters)
    summary['expectedReserved'] = sum(1 for key in declared
                                     if key.split('/')[0] in RESERVED_ENTRY_POINTS)
    rows = self_test(dump, declared, returns, manifest_sha256, nef_sha256, parameters)
    failed = [label for label, ok, _ in rows if not ok]
    boundary_summary, boundary_problems = boundary_face(dump, declared, parameters)
    receipt = {
        'schema': SCHEMA,
        'scope': SCOPE,
        'engine': dump.get('engine', {}),
        'nef': {'sha256': dump.get('nef', {}).get('sha256'),
                'scriptLength': dump.get('nef', {}).get('scriptLength'),
                'sha256Matches': summary['nefSha256Matches']},
        'manifest': {'sha256': manifest_sha256, 'declared': len(declared)},
        'deployed': dump.get('deployed', {}),
        'reservedEntryPoints': list(RESERVED_ENTRY_POINTS),
        'initializeOffset': dump.get('initializeOffset'),
        'deployOffset': dump.get('deployOffset'),
        'boundary': {
            'schema': dump.get('boundary', {}).get('schema'),
            'undeclaredName': dump.get('boundary', {}).get('undeclaredName'),
            'stats': boundary_summary,
            'problems': boundary_problems[:20],
            'claims': {
                # A measurement of this engine, not a requirement of the ABI: the
                # boundary does not refuse a wrong-shaped argument here, so a
                # receipt that said otherwise would be describing another engine.
                'shapeEnforcedAtBoundary': boundary_summary['shapeEnforcedAtBoundary'],
                'boundaryRefusalsAreStructural': (
                    boundary_summary['boundaryArityEntered'] == 0
                    and boundary_summary['boundaryAbsentRefused']),
            },
        },
        'stats': summary,
        'problems': problems[:40],
        'selfTest': {'checks': len(rows), 'failed': failed},
        'claims': {
            'abiDispatchMeasured': True,
            'abiDispatchProven': False,
            'semanticsProven': False,
            'fullImplementationVerified': False,
        },
    }
    receipt['receiptSha256'] = _sha256(
        json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode())
    return receipt


def agrees(receipt):
    """True when the engine did what the manifest declares, and the face can tell."""
    return _agrees_core(receipt) and not receipt['selfTest']['failed']


def self_test(dump, declared, returns, manifest_sha256, nef_sha256=None, parameters=None):
    """Mutate the dump and require the face to notice each mutation.

    Ten ways a dump can be wrong about a call that matches the manifest, and
    seven about the boundary - a probe that vanished, a refusal that claims to
    have entered, an overload sent to the wrong sibling, a refusal whose message
    is the callee's rather than the boundary's. If any mutation still passes, the
    face is reporting agreement it cannot actually distinguish from a failure,
    and the run says so rather than returning zero problems.
    """
    rows = []
    base, base_problems = _face(dump, declared, returns, manifest_sha256, nef_sha256,
                                parameters)

    def check(label, mutate):
        copy = json.loads(json.dumps(dump))
        mutate(copy)
        summary, problems = _face(copy, declared, returns, manifest_sha256, nef_sha256,
                                  parameters)
        caught = bool(problems) or summary != base
        rows.append([label, caught, summary.get('dispatchMismatch', 0)])

    def _first_dispatched(copy):
        for row in copy['methods']:
            if row.get('dispatchOffset') is not None:
                return row
        raise AssertionError('no dispatched method to mutate')

    check('a moved declared offset', lambda copy: _first_dispatched(copy)
          .__setitem__('offset', _first_dispatched(copy)['offset'] + 1))

    def _move_dispatch(copy):
        row = _first_dispatched(copy)
        row['dispatchOffset'] = row['offset'] + 1

    check('a dispatch that lands elsewhere', _move_dispatch)

    def _unreach(copy):
        _first_dispatched(copy)['reachedDeclared'] = False

    check('a declared entry that never ran', _unreach)
    check('a method that went missing', lambda copy: copy['methods'].pop())

    def _reserved(copy):
        for row in copy['methods']:
            if row.get('name') in RESERVED_ENTRY_POINTS:
                row['dispatchOffset'] = row['offset']
                row['reachedDeclared'] = True
                return
        raise AssertionError('no reserved entry point in the dump')

    check('a reserved entry point that claims to be callable', _reserved)

    def _syscall(copy):
        _first_dispatched(copy)['syscalls'] = ['0xdeadbeef']

    check('a syscall the engine does not know', _syscall)
    check('a dump bound to another manifest',
          lambda copy: copy['manifest'].__setitem__('sha256', '0' * 64))

    def _first_completed(copy):
        for row in copy['methods']:
            if row.get('state') == 'HALT':
                return row
        raise AssertionError('no completed call to mutate')

    def _wrong_type(copy):
        row = _first_completed(copy)
        expected = RETURN_STACK_TYPES.get(returns.get(_key(row)))
        row['resultType'] = 'Integer' if expected != 'Integer' else 'Boolean'

    check('a value the manifest does not declare', _wrong_type)

    def _no_value(copy):
        _first_completed(copy)['resultCount'] = 0
        _first_completed(copy).pop('resultType', None)

    check('a call that returns nothing where a value is declared', _no_value)

    def _null_for_a_value(copy):
        for row in copy['methods']:
            if row.get('state') != 'HALT':
                continue
            if returns.get(_key(row)) in ('Integer', 'Boolean'):
                row['resultCount'] = 1
                row['resultType'] = NULL_STACK_TYPE
                return
        raise AssertionError('no completed call that declares a value type')

    check('a null where the manifest declares a value', _null_for_a_value)

    # -- the boundary -------------------------------------------------------
    #
    # These mutate the probes rather than the method rows, and the first one
    # matters most: an exporter that quietly stopped emitting a probe would look
    # like a face with nothing to disagree with.

    def _probe(copy, kind):
        for row in (copy.get('boundary') or {}).get('probes') or []:
            if row.get('kind') == kind:
                return row
        raise AssertionError('no ' + kind + ' probe in the dump to mutate')

    check('a boundary probe that went missing',
          lambda copy: copy['boundary']['probes'].remove(_probe(copy, 'absent')))

    def _arity_entered(copy):
        row = _probe(copy, 'arity')
        row['entered'] = True
        row['enteredOffset'] = 1
        row['state'] = 'HALT'

    check('an arity refusal that claims to have entered', _arity_entered)

    def _relabelled(copy):
        _probe(copy, 'arity')['kind'] = 'overload'

    check('an arity probe relabelled as an overload', _relabelled)

    def _wrong_sibling(copy):
        row = _probe(copy, 'overload')
        row['enteredOffset'] = (row.get('enteredOffset') or 0) + 1

    check('an overload that lands on the wrong sibling', _wrong_sibling)

    def _callee_reason(copy):
        row = _probe(copy, 'arity')
        row['fault'] = 'ABORTMSG is executed. Reason: Account not found'
        row['faultDetail'] = 'Neo.VM.ExecutionEngine'

    check('a refusal whose reason is the callee, not the boundary', _callee_reason)

    def _type_moved(copy):
        row = _probe(copy, 'type')
        row['enteredOffset'] = (row.get('enteredOffset') or 0) + 1

    check('a wrong-shaped argument that landed elsewhere', _type_moved)

    def _type_unclassified(copy):
        row = _probe(copy, 'type')
        row['entered'] = False
        row['enteredOffset'] = None

    check('a wrong-shaped argument refused for a reason nobody named', _type_unclassified)
    return rows
