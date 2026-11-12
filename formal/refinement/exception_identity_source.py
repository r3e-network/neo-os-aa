"""Pinned projection of exception identity and catchability.

Four lanes refer to "it throws" without recording *which* exception reaches whom.
This lane reads the surfacing mechanism out of the pinned sources and stops at the
fault-state effect:

* the VM's instruction loop catches **only** `CatchableException`, and only when
  `Limits.CatchEngineExceptions` lets the filter through;
* that guarded handler hands the contract `ex.Message` -- a string -- never the
  exception object;
* every other exception skips the guarded handler and reaches the untyped outer
  handler, which faults without any value being pushed for the contract;
* `ApplicationEngine.OnFault` records the exception object host-side and clears
  the notification set, so the host can tell failures apart while the contract
  cannot.

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

# The conditional-compilation reading is shared rather than copied: two
# lane-local copies of it would be two chances to drift. `csharp_directives`
# evaluates `#if` conditions instead of dropping the lines, so the two `VMPERF`
# tracing regions in the pinned engine file are disabled text here exactly as
# they are for the compiler. The raw bytes are still what the pin hashes, and
# the projection reports the same program on either reading — only the recorded
# method bodies change, by no longer quoting code the compiler never sees.
from csharp_directives import strip_directives

VM_COMMIT = '004cd6070a940405818d9357638277dd44407e2e'
CORE_COMMIT = 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d'
SCOPE = 'exception-identity-and-catchability'
ENTRY_BOUNDARY = 'ExecuteNext-fault-surfacing-and-catch-admission-effect'

SOURCES = {
    'vm/engine': dict(repository='neo-vm', commit=VM_COMMIT,
                      sha256='ea906436ec48408abe92826547041859fb6195553f8e585816f1d96695663445',
                      relativePath='src/Neo.VM/ExecutionEngine.cs'),
    'vm/control': dict(repository='neo-vm', commit=VM_COMMIT,
                       sha256='a0ac51ff220abbfcf8fb8c19bb0f2b8be4680169ba8ba33f6ededfc5e5e6a2ec',
                       relativePath='src/Neo.VM/JumpTable/JumpTable.Control.cs'),
    'vm/limits': dict(repository='neo-vm', commit=VM_COMMIT,
                      sha256='b8353f47f18aec5093426b550a231c7ce1e2201e636e806f177ffcb9043374b4',
                      relativePath='src/Neo.VM/ExecutionEngineLimits.cs'),
    'vm/catchable': dict(repository='neo-vm', commit=VM_COMMIT,
                         sha256='c6fbc18fc7e213db672dbd1a241834d30d04f77561114d466526708f4d90bc0e',
                         relativePath='src/Neo.VM/CatchableException.cs'),
    'vm/unhandled': dict(repository='neo-vm', commit=VM_COMMIT,
                         sha256='71cd4912a35eb34fa89b65b4d7ce0c83e107748e8ae89db86372bf92950e1ea0',
                         relativePath='src/Neo.VM/VMUnhandledException.cs'),
    'core/engine': dict(repository='neo', commit=CORE_COMMIT,
                        sha256='97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb',
                        relativePath='src/Neo/SmartContract/ApplicationEngine.cs'),
}

SIGNATURES = {
    'ExecuteNext': ('vm/engine', 'protected internal void ExecuteNext()'),
    'OnFaultVm': ('vm/engine', 'protected virtual void OnFault(Exception ex)'),
    'ExecuteThrow': ('vm/control',
                     'public virtual void ExecuteThrow(ExecutionEngine engine, StackItem? ex)'),
    'OnFaultEngine': ('core/engine', 'protected override void OnFault(Exception ex)'),
}

PRECONDITIONS = [
    'The instruction being executed is the one the loop read, and its handler is the only thing '
    'inside the inner guarded block; this lane records the surfacing of whatever that handler '
    'throws, not the individual instruction semantics.',
    'The limit flag `CatchEngineExceptions` is engine configuration supplied as an input; the lane '
    'records where the guard sits and what its declared default is, not how a host overrides it.',
    'The invocation stack, the TRY stack and their states are supplied as inputs; this lane does '
    'not model how a frame or a handler context reached its state.',
    'Preprocessor-conditional diagnostic blocks (`VMPERF`) are removed before projection; they '
    'contain console output only and no state assignment.',
    'The contract-visible effect recorded here is the value handed to the catch handler; the '
    'execute-and-catch protocol itself (jump targets, TRY stack bookkeeping) is out of scope.',
    'Host-side observation stops at `FaultException` and the cleared notification set; the '
    'transaction layer that consumes them is a separate obligation.'
]
UNPROVED = [
    'Which concrete exception type each individual engine operation throws; this lane records the '
    'catch clause identity and the surfacing rule, not the throw sites of every opcode.',
    'Whether a host ever constructs an engine with the catch limit off; only the declared default '
    'and the guard position are recorded.',
    'The fault-message text and any client-visible diagnostic derived from it.',
    'Rollback of ledger and storage effects after a fault, and the transaction composition that '
    'decides whether a faulted execution is committed or discarded.',
    'Trusted C# extraction and compiler/CLR correspondence; all 105 public entrypoints.'
]
TCB = ['C# catch-clause matching and exception-subtyping of `catch (T)` against a thrown value.',
       'The tokenizer keeps string and character literals opaque; preprocessor lines carry no '
       'state and are dropped before projection.',
       'Externally supplied engine limits, invocation-stack shape and TRY-stack states.']


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


# The ordered steps of one instruction turn. Each anchor survives every mutation
# this lane enumerates, so only the reordering mutant can move them.
STEP_ANCHORS = [
    ('read-instruction', 'Instruction?currentInstruction=context.CurrentInstruction;'),
    ('guarded-catch', 'JumpTable.ExecuteThrow(this,'),
    ('post-hook', 'PostExecuteInstruction(instruction);'),
    ('advance-pointer', 'context.InstructionPointer+=instruction.Size;'),
    ('fault-handler', 'OnFault(e);'),
]

# name -> (source key, before, after), applied to the raw pinned text. Every
# mutation must move exactly one projected field; the tests assert that.
CONTROL_MUTATIONS = {
    'drop-the-limit-guard':
        ('vm/engine', 'catch (CatchableException ex) when (Limits.CatchEngineExceptions)',
         'catch (CatchableException ex)'),
    'name-the-base-type-in-the-guarded-clause':
        ('vm/engine', 'catch (CatchableException ex)', 'catch (EngineException ex)'),
    'throw-the-exception-object-instead-of-its-message':
        ('vm/engine', 'JumpTable.ExecuteThrow(this, ex.Message);',
         'JumpTable.ExecuteThrow(this, ex);'),
    'make-the-outer-handler-typed':
        ('vm/engine', 'catch (Exception e)', 'catch (InvalidOperationException e)'),
    'fault-without-setting-the-state':
        ('vm/engine', 'State = VMState.FAULT;', 'State = VMState.NONE;'),
    'skip-recording-the-thrown-value':
        ('vm/control', '        engine.UncaughtException = ex;',
         '        engine.UncaughtException = null;'),
    'never-clear-the-recorded-value':
        ('vm/control', '                        engine.UncaughtException = null;',
         '                        engine.UncaughtException = ex;'),
    'push-a-null-instead-of-the-thrown-value':
        ('vm/control', 'engine.Push(engine.UncaughtException!);', 'engine.Push(StackItem.Null);'),
    'treat-the-finally-frame-as-a-catch':
        ('vm/control', 'if (tryContext.State == ExceptionHandlingState.Finally || (',
         'if (('),
    'let-the-unhandled-value-escape-unwrapped':
        ('vm/control', 'throw new VMUnhandledException(engine.UncaughtException!);',
         'throw new InvalidOperationException();'),
    'give-the-catchable-exception-no-dedicated-type':
        ('vm/catchable', 'public class CatchableException : Exception',
         'public class EngineException : Exception'),
    'drop-the-wrapped-object':
        ('vm/unhandled', 'ExceptionObject = ex;', 'ExceptionObject = null;'),
    'fault-without-recording-the-exception':
        ('core/engine', 'FaultException = ex;', 'FaultException = null;'),
    'keep-the-notifications-on-fault':
        ('core/engine', '            notifications = null;\n', ''),
    'default-the-limit-to-off':
        ('vm/limits', 'public bool CatchEngineExceptions { get; init; } = true;',
         'public bool CatchEngineExceptions { get; init; } = false;'),
    'swap-the-hook-and-the-pointer-advance':
        ('vm/engine',
         '                PostExecuteInstruction(instruction);\n'
         '                if (!isJumping && currentInstruction != null)\n'
         '                    context.InstructionPointer += instruction.Size;',
         '                if (!isJumping && currentInstruction != null)\n'
         '                    context.InstructionPointer += instruction.Size;\n'
         '                PostExecuteInstruction(instruction);'),
}
EXPECTED_CONTROLS = tuple(CONTROL_MUTATIONS)


def step_order(execute_next):
    """Return the ordered step names, read from where each anchor sits."""
    placed = []
    for name, anchor in STEP_ANCHORS:
        require(anchor in execute_next, 'Missing step anchor: ' + anchor)
        placed.append((execute_next.index(anchor), name))
    return [name for _, name in sorted(placed)]


def project_sources(contents, *, enforce_identity=True):
    require(set(contents) == set(SOURCES), 'Incomplete/extra exception identity source set')
    if enforce_identity:
        for key, text in contents.items():
            require(sha(text.encode()) == SOURCES[key]['sha256'], 'Pinned source mismatch: ' + key)

    engine_raw = contents['vm/engine']
    control_raw = contents['vm/control']
    limits_raw = contents['vm/limits']
    catchable_raw = contents['vm/catchable']
    unhandled_raw = contents['vm/unhandled']
    core_raw = contents['core/engine']

    engine = strip_directives(engine_raw)
    control = strip_directives(control_raw)
    limits = strip_directives(limits_raw)
    catchable = strip_directives(catchable_raw)
    unhandled = strip_directives(unhandled_raw)
    core = strip_directives(core_raw)

    execute_next = body(engine, SIGNATURES['ExecuteNext'][1])
    on_fault_vm = body(engine, SIGNATURES['OnFaultVm'][1])
    execute_throw = body(control, SIGNATURES['ExecuteThrow'][1])
    on_fault_engine = body(core, SIGNATURES['OnFaultEngine'][1])

    program = dict(
        step_order=step_order(execute_next),
        catch_names_the_catchable_type='catch(CatchableExceptionex)' in execute_next,
        catch_is_guarded_by_the_limit='when(Limits.CatchEngineExceptions)' in execute_next,
        the_generic_handler_is_untyped='catch(Exceptione)' in execute_next,
        the_caught_value_is_the_message='ExecuteThrow(this,ex.Message);' in execute_next,
        the_fault_sets_the_state='State=VMState.FAULT;' in on_fault_vm,
        the_thrown_value_is_recorded_at_entry=execute_throw.startswith(
            '{engine.UncaughtException=ex;'),
        a_handler_clears_the_recorded_value='engine.UncaughtException=null;' in execute_throw,
        the_handler_receives_the_thrown_value=(
            'engine.Push(engine.UncaughtException!);' in execute_throw),
        the_walk_skips_the_finally_and_consumed_catch=(
            'tryContext.State==ExceptionHandlingState.Finally||' in execute_throw),
        an_absent_handler_wraps_the_value=(
            'thrownewVMUnhandledException(engine.UncaughtException!);' in execute_throw),
        a_dedicated_catchable_type_exists=(
            'publicclassCatchableException:Exception' in normalize(catchable)),
        the_wrapper_keeps_the_thrown_object=(
            'publicStackItemExceptionObject{get;}' in normalize(unhandled)
            and 'ExceptionObject=ex;' in normalize(unhandled)),
        the_engine_records_the_fault='FaultException=ex;' in on_fault_engine,
        the_engine_clears_the_notifications='notifications=null;' in on_fault_engine,
        the_limit_defaults_to_catching=(
            'publicboolCatchEngineExceptions{get;init;}=true;' in normalize(limits)),
    )
    return dict(schema='neoos-aa-exception-identity-source/v1', scope=SCOPE,
                entryBoundary=ENTRY_BOUNDARY, vmCommit=VM_COMMIT, coreCommit=CORE_COMMIT,
                sourceHashes={k: sha(v.encode()) for k, v in contents.items()},
                methods=dict(executeNext=execute_next, onFaultVm=on_fault_vm,
                             executeThrow=execute_throw, onFaultEngine=on_fault_engine),
                program=program,
                reasonOnlyGuards=['catch-clause-subtyping', 'fault-terminates-the-turn'],
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
    mirror = os.environ.get('AA_EXCEPTION_IDENTITY_SOURCE_MIRROR')
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
