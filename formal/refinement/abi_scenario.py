"""What the engine does with declared arguments over state the scenario built.

`abi_dispatch` calls every ABI name once with arity-matched zeros. That answers
"does the dispatcher resolve the name", and it stops there: 61 of the 100 methods
halt at their first argument guard, so neither their bodies nor their declared
return types are ever reached.

This module reads the other dump. A scenario declares an ordered list of calls —
literal arguments, a named signer, the block time it runs at, the contract the call
lands on, an expected ending — and the exporter runs them, in order, over one
account deployment and any number of plugin deployments beside it. Eight questions
are asked of the pair:

    encoding    the bytes the engine executed are the bytes this file declares.
                Rebuilt here from the scenario alone, with an encoder written
                against the opcode table rather than against the exporter, and
                compared byte for byte. A dump whose calls are not the scenario's
                calls is measuring something else.
    shape       the dump covers exactly the scenario's steps, in order, by id and
                method. A dump that lost a step cannot pass by having nothing left
                to disagree with.
    time        each call ran at the block time the scenario declares for it, and
                the receipt says which one. Every timelock in this contract is a
                comparison against that value, so a harness frozen at one instant
                can only ever reach the refusing side of each of them.
    ending      each call ended in the state the scenario expects, and a call that
                was expected to fault faulted with the declared reason and the
                declared detail. An expected fault is a control, not a failure; an
                unexpected halt is a failure, not a relaxation. The detail is a
                second, narrower string: the reason is what the target script
                aborted with, the detail is what the host recorded underneath it,
                and a scenario that pins both is pinning two different layers.
    returns     the value handed back is described by the manifest - the same
                rule the dispatch face applies, loaded from it rather than
                restated. A declared reference type may come back null; a declared
                value type may not; and a null return applies no rule, so it does
                not count as having exercised the declared type.
    values      the integers, booleans and array lengths the scenario declares are
                the ones the engine produced, and every declared read link holds:
                what a call returned is the argument that an earlier call was
                given, byte for byte.
    modules     a step that lands on a plugin is compared against that plugin:
                the address the engine deployed is the one the scenario names, and
                the bytes it deployed hash to the file the scenario points at. An
                admission check reads a deployed contract's manifest, so a claim
                about which plugin was deployed is a claim about an artifact, and
                the return type a plugin call must satisfy comes from that
                plugin's manifest rather than from the account's.
    frozen      a step expected to fault is not what any later step reads, because
                this harness shares one storage snapshot and does not roll a
                faulting call back. Building on a fault is not a scenario that
                recovers; it is one that measured a state no chain would have.

What this module will never report: that the contract is correct, that these
calls are the behaviour of the other entries, or that the source means what the
opcodes do. Eight questions, one artifact, one engine version, the declared call
sequence, the declared times, and the declared artifacts. `fullImplementationVerified`
stays false.
"""

import hashlib
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

SCHEMA = 'aa-abi-scenario/v1'
INPUT_SCHEMA = 'aa-abi-scenario-input/v1'
SCOPE = 'actual-vm-calls-with-declared-arguments-over-established-state'

# The opcodes this encoder emits. Values are taken from the audited table in
# `nef_decode`, which was transcribed from the pinned Neo.VM source, so this
# module does not carry a second opinion about what a byte means.
WANTED_OPCODES = ('PUSHINT8', 'PUSHINT16', 'PUSHINT32', 'PUSHINT64', 'PUSHINT128', 'PUSHINT256',
                  'PUSHT', 'PUSHF', 'PUSHNULL', 'PUSHDATA1', 'PUSHDATA2', 'PUSHDATA4',
                  'PUSH0', 'PUSH1', 'PUSH16', 'PUSHM1', 'PACK', 'SYSCALL')

SYSCALL_NAME = 'System.Contract.Call'

# Arguments whose ABI text is an address. Neo stores these little-endian, so the
# bytes on the stack are the reverse of the hex the scenario writes.
REVERSED_HEX_TYPES = {'Hash160': 20, 'Hash256': 32}


def _load(name):
    spec = importlib.util.spec_from_file_location('scenario_' + name,
                                                  os.path.join(HERE, name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DECODER = _load('nef_decode')
DISPATCH = _load('abi_dispatch')

OPCODES = {name: code for code, (name, _fixed, _prefix) in DECODER.OPCODES.items()}


def _sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def _opcode(name):
    if name not in OPCODES:
        raise AssertionError('the audited opcode table has no ' + name)
    return OPCODES[name]


PUSHDATA1 = _opcode('PUSHDATA1')
PUSHDATA2 = _opcode('PUSHDATA2')
PUSHDATA4 = _opcode('PUSHDATA4')
PACK = _opcode('PACK')
SYSCALL = _opcode('SYSCALL')
PUSHNULL = _opcode('PUSHNULL')
PUSHT = _opcode('PUSHT')
PUSHF = _opcode('PUSHF')


def syscall_operand(name):
    """The four bytes a SYSCALL for `name` carries. Derived, not transcribed."""
    return hashlib.sha256(name.encode('utf-8')).digest()[:4]


def minimal_signed_le(value):
    """BigInteger.ToByteArray(): two's complement, little-endian, minimal length."""
    length = 1
    while True:
        try:
            return int(value).to_bytes(length, 'little', signed=True)
        except OverflowError:
            length += 1


def push_integer(value):
    """PUSHINT8/16/32/64/128/256 for a value, with the width the VM requires.

    Neo pads a 3-byte two's complement value to four and calls it PUSHINT32; the
    instruction's operand width is fixed, so the padding is part of the encoding
    rather than a property of the number.
    """
    value = int(value)
    if value == -1:
        return bytes([_opcode('PUSHM1')])
    if value == 0:
        return bytes([_opcode('PUSH0')])
    if 1 <= value <= 16:
        return bytes([_opcode('PUSH1') + value - 1])
    raw = minimal_signed_le(value)
    for width, name in ((1, 'PUSHINT8'), (2, 'PUSHINT16'), (4, 'PUSHINT32'),
                        (8, 'PUSHINT64'), (16, 'PUSHINT128'), (32, 'PUSHINT256')):
        if len(raw) <= width:
            pad = b'\xff' if value < 0 else b'\x00'
            return bytes([_opcode(name)]) + raw + pad * (width - len(raw))
    raise AssertionError('integer outside the 256-bit domain: ' + str(value))


def push_bytes(raw):
    """PUSHDATA1/2/4, which is what this VM uses for every byte string.

    Neo N3 has no PUSHBYTES opcodes: opcodes 0x00..0x05 are PUSHINT8..PUSHINT256,
    so a twenty-byte push cannot be encoded as a length prefix. Measured on the
    pinned artifact, including the zero-length case.
    """
    if len(raw) < 0x100:
        return bytes([PUSHDATA1, len(raw)]) + raw
    if len(raw) < 0x10000:
        return bytes([PUSHDATA2]) + len(raw).to_bytes(2, 'little') + raw
    return bytes([PUSHDATA4]) + len(raw).to_bytes(4, 'little') + raw


def argument_bytes(argument):
    """The stack item one declared argument becomes."""
    kind = argument.get('type')
    if kind in REVERSED_HEX_TYPES:
        text = argument.get('value') or ''
        raw = bytes.fromhex(text[2:] if text.startswith('0x') else text)
        if len(raw) != REVERSED_HEX_TYPES[kind]:
            raise AssertionError(kind + ' must be ' + str(REVERSED_HEX_TYPES[kind]) + ' bytes')
        return bytes(reversed(raw))
    if kind == 'ByteString':
        return bytes.fromhex(argument.get('value') or '')
    if kind == 'String':
        return (argument.get('value') or '').encode('utf-8')
    raise AssertionError('an argument this encoder does not model: ' + str(kind))


def push_argument(argument):
    """The bytes that put one argument on the stack."""
    kind = argument.get('type')
    if kind == 'Integer':
        return push_integer(argument.get('value'))
    if kind == 'Boolean':
        return bytes([PUSHT if argument.get('value') else PUSHF])
    if kind == 'Null':
        return bytes([PUSHNULL])
    if kind == 'Array':
        items = argument.get('items') or []
        # PACK fills index 0 from the top of the stack, so the elements are pushed
        # in reverse and come back as the scenario declared them.
        body = b''.join(push_argument(item) for item in reversed(items))
        return body + push_integer(len(items)) + bytes([PACK])
    return push_bytes(argument_bytes(argument))


def step_script(step, contract_address):
    """The whole call frame for one step, from the scenario alone."""
    arguments = step.get('args') or []
    body = b''.join(push_argument(argument) for argument in reversed(arguments))
    return (body
            + push_integer(len(arguments)) + bytes([PACK])
            + push_integer(15)                                  # CallFlags.All
            + push_bytes(step['method'].encode('utf-8'))
            + push_bytes(bytes(reversed(bytes.fromhex(contract_address[2:]))))
            + bytes([SYSCALL]) + syscall_operand(SYSCALL_NAME))


def _declared(scenario):
    """Types whose declared return the scenario is allowed to talk about."""
    problems = []
    if scenario.get('schema') != INPUT_SCHEMA:
        problems.append(['scenario', 'schema', str(scenario.get('schema'))])
    if not isinstance(scenario.get('steps'), list) or not scenario['steps']:
        problems.append(['scenario', 'steps', 'no steps declared'])
    if not str(scenario.get('contractAddress', '')).startswith('0x'):
        problems.append(['scenario', 'contractAddress', str(scenario.get('contractAddress'))])
    return problems


def _expected_integer(step, block_timestamp):
    value = step.get('integer')
    if value == '@blockTimestamp':
        return str(block_timestamp)
    return value


def _expected_timestamp(step, block_timestamp):
    """The block time this step declares, defaulting to the scenario's base time."""
    return int(step.get('timestamp', block_timestamp))


def load_modules(scenario, scenario_path):
    """Read the artifacts the scenario declares beside the account, and their manifests.

    A step that lands on a plugin is measured against that plugin's manifest, not
    against the account's: the declared return type of `authorizedCore` belongs to
    the verifier's ABI, and reading it out of the account's manifest would be a
    claim about the wrong artifact. Returns ({name: {...}}, problems).

    Paths are resolved against the scenario file's own directory, which is what the
    exporter does, so both sides agree on which file a relative name means without
    either of them being told the repository layout.
    """
    directory = os.path.dirname(os.path.abspath(scenario_path))
    modules, problems = {}, []
    declared = scenario.get('modules')
    if declared is None:
        return modules, problems
    if not isinstance(declared, list):
        return modules, [['modules', 'shape', 'not a list']]
    for entry in declared:
        if not isinstance(entry, dict):
            problems.append(['modules', 'entry', 'not an object'])
            continue
        name = str(entry.get('name') or '')
        if not name or name == 'account':
            problems.append(['modules', 'name', repr(name)[:40]])
            continue
        if name in modules:
            problems.append(['modules', 'duplicate', name])
            continue
        record = {'address': str(entry.get('address') or '').lower(),
                  'signer': str(entry.get('signer') or '').lower(),
                  'declaredNef': str(entry.get('nef') or ''),
                  'declaredManifest': str(entry.get('manifest') or '')}
        for key, flag in (('declaredNef', 'nef'), ('declaredManifest', 'manifest')):
            path = os.path.join(directory, record[key])
            if not os.path.isfile(path):
                problems.append([name, 'artifact-missing', record[key]])
                record['sha256'] = None
                continue
            with open(path, 'rb') as handle:
                raw = handle.read()
            record['sha256' if flag == 'nef' else 'manifestSha256'] = _sha256(raw)
            if flag == 'manifest':
                record['declared'] = DISPATCH.manifest_methods(path)[1]
        if record.get('declared') is None:
            record['declared'] = {}
        modules[name] = record
    return modules, problems


def step_target(step, contract_address, modules):
    """The address and the return-type map a step is measured against.

    A step names the contract it calls; the default is the account under test. An
    unknown name is refused rather than falling back to the account, because a
    silent fallback would measure a plugin call against the account's ABI and
    report the mismatch as a return-type problem instead of as the wrong contract.
    """
    name = str(step.get('target') or 'account')
    if name == 'account':
        return contract_address, None
    module = modules.get(name)
    if module is None:
        raise AssertionError('no module named ' + name + ' is deployed by this scenario')
    return module['address'], module.get('declared') or {}


def _face(scenario, dump, declared, manifest_sha256, nef_sha256=None, scenario_sha256=None,
          modules=None):
    """Compare the dump against the scenario. Returns (stats, problems)."""
    modules = modules or {}
    stats = {
        'steps': 0, 'declaredSteps': len(scenario.get('steps') or []),
        'halted': 0, 'faulted': 0, 'faultsAsExpected': 0, 'unexpectedEnding': 0,
        'scriptBytesCompared': 0, 'scriptBytesMatched': 0,
        'declaredReturnChecked': 0, 'declaredReturnMatched': 0,
        'declaredReturnNull': 0, 'declaredReturnMismatch': 0, 'declaredReturnUnknown': 0,
        'integerClaims': 0, 'integerClaimsMatched': 0,
        'booleanClaims': 0, 'booleanClaimsMatched': 0,
        'itemClaims': 0, 'itemClaimsMatched': 0,
        'linksChecked': 0, 'linksMatched': 0, 'linksToFaultedStep': 0,
        'timestampsChecked': 0, 'timestampsMatched': 0, 'distinctTimestamps': 0,
        'signersChecked': 0, 'signersMatched': 0,
        'timeSensitivePairs': 0, 'timeSensitiveSteps': [],
        'moduleSteps': 0,
        'modulesDeclared': len(scenario.get('modules') or []),
        'modulesDeployed': 0, 'moduleAddressChecked': 0, 'moduleAddressMatched': 0,
        'moduleArtifactChecked': 0, 'moduleArtifactMatched': 0,
        'moduleSignerMatched': 0,
        'distinctMethods': 0, 'distinctTargets': 0,
        'declaredTypesExercised': [], 'declaredTypesUnexercised': [],
        'nullReturnSteps': [],
        'contractAddressMatches': False, 'scenarioSha256Matches': False,
        'manifestSha256Matches': False, 'nefSha256Matches': None,
        'engineErrors': 0, 'stepLimitReached': 0, 'noState': 0, 'missingSteps': 0,
        'reorderedSteps': 0,
    }
    problems = []
    exercised = set()

    if scenario_sha256 is not None:
        stats['scenarioSha256Matches'] = dump.get('scenario', {}).get('sha256') == scenario_sha256
    stats['manifestSha256Matches'] = dump.get('manifest', {}).get('sha256') == manifest_sha256
    if nef_sha256 is not None:
        stats['nefSha256Matches'] = dump.get('nef', {}).get('sha256') == nef_sha256
    contract_address = str(scenario.get('contractAddress') or '')
    stats['contractAddressMatches'] = dump.get('deployed', {}).get('hash') == contract_address

    # modules: the plugins the scenario declared, against the ones the engine says
    # it deployed. Two separate facts, and conflating them would let either pass
    # for the other: the address is a function of the NEF, the manifest name and
    # the deploy signer, and the bytes are what the admission check will read.
    deployed_modules = {str(entry.get('name')): entry for entry in dump.get('modules') or []}
    stats['modulesDeployed'] = len(deployed_modules)
    for name, module in modules.items():
        entry = deployed_modules.get(name)
        if entry is None:
            problems.append([name, 'module-not-deployed',
                             'the scenario declares it, the dump does not report it'])
            continue
        stats['moduleAddressChecked'] += 1
        if str(entry.get('address') or '').lower() == module['address']:
            stats['moduleAddressMatched'] += 1
        else:
            problems.append([name, 'module-address',
                             str(entry.get('address') or '').lower(), module['address']])
        if module.get('sha256') is not None:
            stats['moduleArtifactChecked'] += 1
            if entry.get('nefSha256') == module['sha256']:
                stats['moduleArtifactMatched'] += 1
            else:
                problems.append([name, 'module-nef-sha256', str(entry.get('nefSha256'))[:16],
                                 module['sha256'][:16]])
        if module.get('manifestSha256') is not None:
            stats['moduleArtifactChecked'] += 1
            if entry.get('manifestSha256') == module['manifestSha256']:
                stats['moduleArtifactMatched'] += 1
            else:
                problems.append([name, 'module-manifest-sha256',
                                 str(entry.get('manifestSha256'))[:16],
                                 module['manifestSha256'][:16]])
        if str(entry.get('signer') or '').lower() == module['signer']:
            stats['moduleSignerMatched'] += 1
        else:
            problems.append([name, 'module-signer', str(entry.get('signer') or '').lower(),
                             module['signer']])
    for name in sorted(set(deployed_modules) - set(modules)):
        problems.append([name, 'module-undeclared',
                         'the engine deployed it, the scenario does not name it'])

    block_timestamp = scenario.get('blockTimestamp')
    if dump.get('block', {}).get('timestamp') != block_timestamp:
        problems.append(['block', 'timestamp', str(dump.get('block', {}).get('timestamp')),
                         str(block_timestamp)])

    steps = scenario.get('steps') or []
    rows = dump.get('steps') or []
    stats['steps'] = len(rows)
    if len(rows) != len(steps):
        stats['missingSteps'] = abs(len(steps) - len(rows))
        problems.append(['steps', 'count', str(len(rows)), str(len(steps))])
    for index, step in enumerate(steps):
        if index >= len(rows):
            break
        row = rows[index]
        if row.get('id') != step.get('id') or row.get('method') != step.get('method'):
            stats['reorderedSteps'] += 1
            problems.append([str(step.get('id')), 'order', str(row.get('id')),
                             str(row.get('method'))])
            continue
        name = str(step.get('id'))
        if row.get('engineError') or row.get('buildError'):
            stats['engineErrors'] += 1
            problems.append([name, 'engine-error',
                             str(row.get('engineError') or row.get('buildError'))[:120]])
            continue

        # time: did this call run at the block time the scenario declares? Every
        # timelock in this contract compares against that value, so a dump that
        # ran at other times is a different measurement wearing this one's id.
        stats['timestampsChecked'] += 1
        want_time = _expected_timestamp(step, block_timestamp)
        if row.get('timestamp') is None:
            problems.append([name, 'no-timestamp', 'the dump does not say when this call ran'])
        elif int(row['timestamp']) != want_time:
            problems.append([name, 'timestamp', str(row['timestamp']), str(want_time)])
        else:
            stats['timestampsMatched'] += 1

        # signature: the call was made by the account the scenario names.
        stats['signersChecked'] += 1
        want_signer = str(step.get('signer') or scenario.get('defaultSigner') or '').lower()
        observed_signer = str(row.get('signer') or '').lower()
        if observed_signer and observed_signer == want_signer:
            stats['signersMatched'] += 1
        else:
            problems.append([name, 'signer', observed_signer or 'none', want_signer])

        # encoding: is the call the engine ran the call the scenario declares?
        # The frame carries the address of whichever contract the step names, so a
        # step aimed at a plugin is rebuilt against that plugin's address and its
        # manifest, not against the account's.
        step_manifest = declared
        try:
            target_address, module_declared = step_target(step, contract_address, modules)
        except AssertionError as error:
            stats['scriptBytesCompared'] += 0
            problems.append([name, 'unknown-target', str(error)[:120]])
            continue
        if module_declared is not None:
            step_manifest = module_declared
            stats['moduleSteps'] += 1
        if row.get('target') != str(step.get('target') or 'account'):
            problems.append([name, 'target', str(row.get('target')),
                             str(step.get('target') or 'account')])
        stats['scriptBytesCompared'] += 1
        try:
            expected = step_script(step, target_address)
        except AssertionError as error:
            problems.append([name, 'unencodable', str(error)[:120]])
            continue
        if row.get('scriptHex') != expected.hex():
            problems.append([name, 'script-bytes', row.get('scriptHex', '')[:64], expected.hex()[:64]])
        elif row.get('scriptSha256') != _sha256(expected):
            problems.append([name, 'script-sha256', str(row.get('scriptSha256'))])
        else:
            stats['scriptBytesMatched'] += 1

        # ending: the state the scenario expects, with the reason it expects.
        state = row.get('state')
        if state == 'HALT':
            stats['halted'] += 1
        elif state == 'FAULT':
            stats['faulted'] += 1
        else:
            stats['noState'] += 1
            problems.append([name, 'no-state', str(state)])
        if row.get('stepLimitReached'):
            stats['stepLimitReached'] += 1
            problems.append([name, 'step-limit', str(row.get('steps'))])
        expect = step.get('expect')
        if state != expect:
            stats['unexpectedEnding'] += 1
            problems.append([name, 'ending', str(state), str(expect),
                             str(row.get('fault') or '')[:80]])
        elif state == 'FAULT':
            reason = str(step.get('reason') or '')
            detail = str(step.get('detail') or '')
            if not reason and not detail:
                problems.append([name, 'fault-without-reason', 'the scenario expects a fault '
                                 'and does not say which one'])
            elif reason and reason not in str(row.get('fault') or ''):
                problems.append([name, 'fault-reason', str(row.get('fault') or '')[:120], reason])
            elif detail and detail not in str(row.get('faultDetail') or ''):
                problems.append([name, 'fault-detail',
                                 str(row.get('faultDetail') or '')[:160], detail])
            else:
                stats['faultsAsExpected'] += 1

        # returns: does the manifest describe what came back? Read from the manifest
        # of the contract the step called, for the reason given above.
        declaration = step_manifest.get(_key(step))
        if declaration is None:
            problems.append([name, 'not-in-manifest', _key(step)])
        elif state == 'FAULT':
            # A faulting call returned nothing, so no shape rule applies to it;
            # what it must not do is leave a value behind. Same rule the dispatch
            # face applies to the same fact.
            if row.get('resultCount') not in (0, None):
                stats['declaredReturnMismatch'] += 1
                problems.append([name, 'fault-with-result', str(row.get('resultCount'))])
        elif state == 'HALT':
            stats['declaredReturnChecked'] += 1
            status, expected, observed = DISPATCH.return_shape(
                declaration, row.get('resultCount'), row.get('resultType'))
            if status == 'match':
                stats['declaredReturnMatched'] += 1
                exercised.add(declaration)
                width = DISPATCH.return_width(declaration, row.get('resultBytes'))
                if width is not None:
                    stats['declaredReturnMismatch'] += 1
                    problems.append([name, 'return-bytes', str(width[0]), str(width[1])])
            elif status == 'null':
                stats['declaredReturnNull'] += 1
                stats['nullReturnSteps'].append(name)
            elif status == 'unknown':
                stats['declaredReturnUnknown'] += 1
                problems.append([name, 'unknown-return-type', str(declaration)])
            else:
                stats['declaredReturnMismatch'] += 1
                problems.append([name, 'return-' + status,
                                 str(declaration) + '->' + str(expected), str(observed)])

        # values: the literals the scenario declares.
        if 'integer' in step:
            stats['integerClaims'] += 1
            want = _expected_integer(step, block_timestamp)
            if str(row.get('resultInteger')) == str(want):
                stats['integerClaimsMatched'] += 1
            else:
                problems.append([name, 'integer', str(row.get('resultInteger')), str(want)])
        if 'boolean' in step:
            stats['booleanClaims'] += 1
            want = 'True' if step['boolean'] else 'False'
            raw = str(row.get('resultHex') or '')
            observed = {'01': 'True', '00': 'False'}.get(raw)
            if observed == want:
                stats['booleanClaimsMatched'] += 1
            else:
                problems.append([name, 'boolean', raw or 'no item', want])
        if 'items' in step:
            stats['itemClaims'] += 1
            if row.get('resultItems') == step['items']:
                stats['itemClaimsMatched'] += 1
            else:
                problems.append([name, 'items', str(row.get('resultItems')), str(step['items'])])

    # time sensitivity: the same call, at two declared times, ending differently.
    # Nothing else in the receipt can produce that pair, so a scenario that
    # declares several instants and has no such pair has declared a dimension it
    # did not measure. The gate asks for the pair when the times are not all one.
    by_frame = {}
    for index, step in enumerate(steps):
        if index >= len(rows):
            break
        key = (str(step.get('method')), str(rows[index].get('scriptSha256')))
        by_frame.setdefault(key, []).append(
            (_expected_timestamp(step, block_timestamp), str(step.get('expect')),
             str(step.get('id'))))
    stats['distinctTimestamps'] = len({_expected_timestamp(step, block_timestamp)
                                       for step in steps})
    sensitive = []
    for entries in by_frame.values():
        if len({entry[0] for entry in entries}) > 1 and len({entry[1] for entry in entries}) > 1:
            stats['timeSensitivePairs'] += 1
            sensitive.extend(entry[2] for entry in entries if entry[2] not in sensitive)
    stats['timeSensitiveSteps'] = sensitive[:12]

    # links: what a call returned is the argument another call was given.
    index = {str(step.get('id')): position for position, step in enumerate(steps)}
    endings = {str(row.get('id')): row.get('state') for row in rows}
    for position, step in enumerate(steps):
        for link in ('readsBack', 'readsForward'):
            if link not in step:
                continue
            name = str(step.get('id'))
            target = str(step[link].get('step'))
            which = step[link].get('arg')
            if target not in index:
                problems.append([name, link, 'no step ' + target])
                continue
            if endings.get(target) == 'FAULT':
                stats['linksToFaultedStep'] += 1
                problems.append([name, link, 'reads a call that faulted: ' + target])
                continue
            other = steps[index[target]]
            try:
                wanted = argument_bytes((other.get('args') or [])[which])
            except (AssertionError, IndexError) as error:
                problems.append([name, link, 'unreadable argument: ' + str(error)[:100]])
                continue
            stats['linksChecked'] += 1
            if position >= len(rows):
                continue
            observed = rows[position].get('resultHex')
            if observed == wanted.hex():
                stats['linksMatched'] += 1
            else:
                problems.append([name, link, str(observed)[:64], wanted.hex()[:64]])

    # frozen: a step expected to fault is not what any later step builds on. The
    # harness shares one storage snapshot, so a faulting step's partial writes
    # survive; a scenario that reads them measured a state no chain would reach.
    faulted = {str(step.get('id')) for step in steps if step.get('expect') == 'FAULT'}
    for position, step in enumerate(steps):
        if str(step.get('id')) not in faulted:
            continue
        for later in steps[position + 1:]:
            targets = {str(later[link].get('step')) for link in ('readsBack', 'readsForward')
                       if link in later}
            if str(step.get('id')) in targets:
                problems.append([str(later.get('id')), 'built-on-a-fault', str(step.get('id'))])

    stats['distinctMethods'] = len({_key(step) for step in steps})
    stats['distinctTargets'] = len({str(step.get('target') or 'account') for step in steps})
    declared_types = {value for value in declared.values() if value}
    stats['declaredTypesExercised'] = sorted(exercised)
    stats['declaredTypesUnexercised'] = sorted(declared_types - exercised)
    if not stats['contractAddressMatches']:
        problems.append(['deployed', 'contract', str(dump.get('deployed', {}).get('hash')),
                         contract_address])
    if not stats['scenarioSha256Matches'] and scenario_sha256 is not None:
        problems.append(['scenario', 'sha256', str(dump.get('scenario', {}).get('sha256'))])
    if not stats['manifestSha256Matches']:
        problems.append(['manifest', 'sha256', str(dump.get('manifest', {}).get('sha256'))])
    if stats['nefSha256Matches'] is False:
        problems.append(['nef', 'sha256', str(dump.get('nef', {}).get('sha256'))])
    return stats, problems


def _key(step):
    return str(step.get('method', '?')) + '/' + str(len(step.get('args') or []))


def _agrees_core(receipt):
    stats = receipt['stats']
    return (receipt['schema'] == SCHEMA
            and stats['declaredSteps'] > 0
            and stats['steps'] == stats['declaredSteps']
            and stats['reorderedSteps'] == 0
            and stats['missingSteps'] == 0
            and stats['scriptBytesCompared'] == stats['declaredSteps']
            and stats['scriptBytesMatched'] == stats['declaredSteps']
            and stats['timestampsChecked'] == stats['declaredSteps']
            and stats['timestampsMatched'] == stats['declaredSteps']
            and stats['signersMatched'] == stats['signersChecked']
            and stats['halted'] > 0 and stats['faulted'] > 0
            and stats['faultsAsExpected'] == stats['faulted']
            and stats['unexpectedEnding'] == 0
            and stats['declaredReturnChecked'] == stats['halted']
            and stats['declaredReturnMismatch'] == 0
            and stats['declaredReturnUnknown'] == 0
            and stats['integerClaimsMatched'] == stats['integerClaims']
            and stats['booleanClaimsMatched'] == stats['booleanClaims']
            and stats['itemClaimsMatched'] == stats['itemClaims']
            and stats['linksChecked'] > 0
            and stats['linksMatched'] == stats['linksChecked']
            and stats['linksToFaultedStep'] == 0
            and stats['engineErrors'] == 0
            and stats['stepLimitReached'] == 0
            and stats['noState'] == 0
            and stats['contractAddressMatches']
            and stats['modulesDeployed'] == stats['modulesDeclared']
            and stats['moduleAddressMatched'] == stats['moduleAddressChecked']
            and stats['moduleArtifactMatched'] == stats['moduleArtifactChecked']
            and stats['moduleSignerMatched'] == stats['modulesDeclared']
            and stats['scenarioSha256Matches']
            and stats['manifestSha256Matches']
            and stats['nefSha256Matches'] in (True, None)
            and not receipt['problems'])


def correspond(scenario_path, dump_path, manifest_path, nef_path=None):
    """Build the receipt for one scenario dump."""
    if not os.path.isfile(scenario_path):
        raise ValueError('no scenario at ' + str(scenario_path))
    if not os.path.isfile(dump_path):
        raise ValueError('no scenario dump at ' + str(dump_path))
    with open(scenario_path, 'rb') as handle:
        scenario_raw = handle.read()
    scenario = json.loads(scenario_raw.decode('utf-8'))
    with open(dump_path, encoding='utf-8') as handle:
        dump = json.load(handle)
    # The declared return types only. The dispatch face owns the offsets question;
    # this face asks what came back, so it reads the other half of the same map.
    _offsets, declared, manifest_sha256 = DISPATCH.manifest_methods(manifest_path)
    nef_sha256 = None
    if nef_path is not None:
        with open(nef_path, 'rb') as handle:
            nef_sha256 = _sha256(handle.read())
    scenario_sha256 = _sha256(scenario_raw)
    modules, module_problems = load_modules(scenario, scenario_path)

    problems = _declared(scenario) + module_problems
    stats, face_problems = _face(scenario, dump, declared, manifest_sha256, nef_sha256,
                                 scenario_sha256, modules)
    problems += face_problems
    rows = self_test(scenario, dump, declared, manifest_sha256, nef_sha256, scenario_sha256,
                     modules)
    failed = [label for label, ok, _ in rows if not ok]
    receipt = {
        'schema': SCHEMA,
        'scope': SCOPE,
        'engine': dump.get('engine', {}),
        'scenario': {'name': scenario.get('name'), 'sha256': scenario_sha256,
                     'declared': len(scenario.get('steps') or [])},
        'nef': {'sha256': dump.get('nef', {}).get('sha256'),
                'scriptLength': dump.get('nef', {}).get('scriptLength'),
                'sha256Matches': stats['nefSha256Matches']},
        'manifest': {'sha256': manifest_sha256, 'declared': len(declared)},
        'deployed': dump.get('deployed', {}),
        'block': dump.get('block', {}),
        'modules': [
            {'name': name,
             'address': module['address'], 'signer': module['signer'],
             'nef': module['declaredNef'], 'manifest': module['declaredManifest'],
             'nefSha256': module.get('sha256'), 'manifestSha256': module.get('manifestSha256'),
             'declaredMethods': len(module.get('declared') or {})}
            for name, module in sorted(modules.items())],
        'stats': stats,
        'problems': problems[:40],
        'selfTest': {'checks': len(rows), 'failed': failed,
                     'skipped': [label for label, ok, skipped in rows if skipped]},
        'claims': {
            'scenarioMeasured': True,
            'scenarioBehavioursProven': False,
            'semanticsProven': False,
            'fullImplementationVerified': False,
        },
    }
    receipt['receiptSha256'] = _sha256(
        json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode())
    return receipt


def agrees(receipt):
    """True when the engine did what the scenario declares, and the face can tell.

    A mutation that could not be built counts as a failure, not as an absence: a
    self test that shrinks to what still fits would certify the input it did not
    examine.
    """
    return (_agrees_core(receipt)
            and not receipt['selfTest']['failed']
            and not receipt['selfTest']['skipped'])


def self_test(scenario, dump, declared, manifest_sha256, nef_sha256=None, scenario_sha256=None,
              modules=None):
    """Mutate the dump or the scenario and require the face to notice each mutation.

    Sixteen ways the pair can be wrong. If any mutation still passes, the face is
    reporting agreement it cannot distinguish from a failure, and the run says so
    rather than returning zero problems.
    """
    modules = modules or {}
    rows = []

    def check(label, mutate):
        copy_scenario = json.loads(json.dumps(scenario))
        copy_dump = json.loads(json.dumps(dump))
        try:
            mutate(copy_scenario, copy_dump)
        except (AssertionError, IndexError, KeyError, TypeError):
            rows.append([label, False, True])
            return
        stats, problems = _face(copy_scenario, copy_dump, declared, manifest_sha256,
                                nef_sha256, scenario_sha256, modules)
        caught = bool(problems) or stats != _face(scenario, dump, declared, manifest_sha256,
                                                  nef_sha256, scenario_sha256, modules)[0]
        rows.append([label, caught, False])

    def _halted_row(copy_dump):
        for row in copy_dump.get('steps') or []:
            if row.get('state') == 'HALT':
                return row
        raise AssertionError('no completed call to mutate')

    def _faulted_row(copy_dump):
        for row in copy_dump.get('steps') or []:
            if row.get('state') == 'FAULT':
                return row
        raise AssertionError('no faulted call to mutate')

    def _linked_row(copy_dump):
        for row in copy_dump.get('steps') or []:
            if row.get('resultHex'):
                return row
        raise AssertionError('no returned value to mutate')

    def _byte(copy_scenario, copy_dump):
        _halted_row(copy_dump)['scriptHex'] = _halted_row(copy_dump)['scriptHex'] + '00'

    check('a call whose bytes are not the scenario', _byte)

    def _state(copy_scenario, copy_dump):
        row = _halted_row(copy_dump)
        row['state'] = 'FAULT'
        row['fault'] = 'ABORTMSG is executed. Reason: invented'

    check('a call that did not end where the scenario says', _state)

    def _when(copy_scenario, copy_dump):
        row = _halted_row(copy_dump)
        row['timestamp'] = int(row['timestamp']) + 1

    check('a call that ran at another time', _when)

    def _who(copy_scenario, copy_dump):
        # A value that is not what the row already carries: a mutation that rewrites
        # a signer with the same signer changes nothing and would certify a check
        # that cannot fail.
        row = _halted_row(copy_dump)
        current = str(row.get('signer') or '').lower()
        row['signer'] = ('0x' + '77' * 20) if current != '0x' + '77' * 20 else '0x' + '88' * 20

    check('a call signed by another account', _who)

    def _reason(copy_scenario, copy_dump):
        row = _faulted_row(copy_dump)
        row['fault'] = 'ABORTMSG is executed. Reason: a different refusal'

    check('a fault with a reason the scenario does not declare', _reason)

    def _integer(copy_scenario, copy_dump):
        for row in copy_scenario.get('steps') or []:
            if 'integer' not in row:
                continue
            for observed in copy_dump.get('steps') or []:
                if observed.get('id') == row.get('id'):
                    observed['resultInteger'] = str(int(observed.get('resultInteger') or 0) + 1)
                    return
        raise AssertionError('no integer claim to mutate')

    check('a value the scenario does not declare', _integer)

    def _value(copy_scenario, copy_dump):
        for row in copy_scenario.get('steps') or []:
            if 'readsBack' not in row and 'readsForward' not in row:
                continue
            observed = next(item for item in copy_dump['steps'] if item.get('id') == row.get('id'))
            observed['resultHex'] = ('ff' * 20)
            return
        raise AssertionError('no read link to mutate')

    check('a value that is not what was written', _value)

    def _missing(copy_scenario, copy_dump):
        copy_dump['steps'].pop()

    check('a step that went missing', _missing)

    def _reordered(copy_scenario, copy_dump):
        copy_dump['steps'][0], copy_dump['steps'][1] = copy_dump['steps'][1], copy_dump['steps'][0]

    check('a dump that reordered the calls', _reordered)

    def _module_address(copy_scenario, copy_dump):
        # A scenario that deploys plugins has its first one moved; one that declares
        # none gets an undeclared plugin reported instead, which is the same defect
        # seen from the other side: the dump and the scenario disagree about which
        # artifacts are in play.
        entries = copy_dump.setdefault('modules', [])
        if entries:
            entries[0]['address'] = '0x' + '33' * 20
        else:
            entries.append({'name': 'undeclared', 'address': '0x' + '33' * 20,
                            'signer': '0x' + '44' * 20, 'nefSha256': '0' * 64,
                            'manifestSha256': '0' * 64})

    check('a plugin deployed somewhere other than the scenario says', _module_address)

    def _module_artifact(copy_scenario, copy_dump):
        entries = copy_dump.setdefault('modules', [])
        if entries:
            entries[0]['nefSha256'] = 'f' * 64
        else:
            entries.append({'name': 'undeclared', 'address': '0x' + '33' * 20,
                            'signer': '0x' + '44' * 20, 'nefSha256': '0' * 64,
                            'manifestSha256': '0' * 64})

    check('a plugin deployed from different bytes', _module_artifact)

    def _module_target(copy_scenario, copy_dump):
        # The step still names the account, but the frame the engine ran names some
        # other contract. Only the encoding question can see this one, which is the
        # point: the address is inside the bytes.
        row = _halted_row(copy_dump)
        row['scriptHex'] = step_script({'method': row['method'], 'args': []},
                                       '0x' + '44' * 20).hex()

    check('a call aimed at a contract the step does not name', _module_target)

    def _type(copy_scenario, copy_dump):
        row = _halted_row(copy_dump)
        row['resultType'] = 'Integer' if row.get('resultType') != 'Integer' else 'Map'

    check('a value the manifest does not describe', _type)

    def _contract(copy_scenario, copy_dump):
        copy_dump['deployed']['hash'] = '0x' + '11' * 20

    check('a deployment other than the one the scenario names', _contract)

    def _scenario(copy_scenario, copy_dump):
        copy_dump['scenario']['sha256'] = '0' * 64

    check('a dump produced from another scenario', _scenario)

    def _fault_dependency(copy_scenario, copy_dump):
        faulted = [row for row in copy_scenario['steps'] if row.get('expect') == 'FAULT']
        if not faulted:
            raise AssertionError('no expected fault to build on')
        target = faulted[0]['id']
        reader = {'id': 'built-on-a-fault', 'method': faulted[0]['method'],
                  'args': [], 'expect': 'HALT',
                  'readsBack': {'step': target, 'arg': 0}}
        copy_scenario['steps'].append(reader)
        copy_dump['steps'].append({'id': 'built-on-a-fault', 'method': faulted[0]['method'],
                                   'state': 'HALT', 'resultCount': 1, 'resultType': 'Any'})
    check('a step that builds on a call that faulted', _fault_dependency)
    return rows
