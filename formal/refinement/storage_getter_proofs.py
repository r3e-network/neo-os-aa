#!/usr/bin/env python3
"""Kernel certificate lane: source-level storage-key getter refinement.

Binds the pinned read-only getters to their exact manifest/debug/byte
regions. The pinned entries are: the three keyed direct storage getters
(getMarketEscrowContract, getMarketEscrowListingId, getVerifyScopeTarget);
the four fixed-prefix getters that take no ABI argument (getContractAdmin,
getPendingContractAdmin, getPlatformRegistrar,
getPendingPlatformRegistrar); the two fixed-prefix timelock getters
(getAdminTransferAvailableAt, getPlatformRegistrarAvailableAt); the raw
payload getter (getMetadataUri); the five AccountState field projections
(getVerifier, getHook, getBackupOwner, getEscapeTimelock,
getEscapeTriggeredAt); the escape predicate (isEscapeActive); the three
inline presence getters (hasPendingVerifierUpdate, hasPendingHookUpdate,
isExecutionActive); the two delegating presence getters
(hasPendingVerifierCall, hasPendingHookCall); the six delegating
PendingModuleCall record projections (the Module, Time and Hash pairs); the
two inline epoch getters (getPendingVerifierUpdateTime,
getPendingHookUpdateTime); and the two escrow owner-cancel accessors that
delegate a raw single-key read to their shared private reader
(hasMarketEscrowOwnerCancel, getMarketEscrowOwnerCancelTime). The state
projections are certified together with their shared private callee
GetAccountState (storage read, null assert, StdLib.Deserialize), the
delegating presence getters and record projections with the shared private
callee GetPendingModuleCallRecord (parameterised key concat, storage read,
null-on-miss, StdLib.Deserialize), and the escrow owner-cancel accessors
with the shared private callee GetMarketEscrowOwnerCancelInitiated
(single-key read, raw payload returned verbatim - it performs no
deserialize, so that family consumes no token oracle).
The lane renders a Coq certificate pinning
prefix/default/decode semantics over an abstract storage map, models
every pinned region at the bytecode level (StorageGetterVm: decoded
instruction sequences, branch-slot targets, call/return frames, callee
parameter bindings, syscall pop order, cast widths) and proves every
reachable behavior class of each getter in the kernel to agree with the
source-level outcome.
StdLib.Deserialize is a pinned token index whose behavior is a
universally quantified oracle - the certificates state agreement relative
to that oracle and assume nothing about it in the kernel. Full
implementation verification is never claimed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
try:
    from . import storage_getter_source as getter_source, nef_decode
except ImportError:
    import storage_getter_source as getter_source, nef_decode

HERE = Path(__file__).resolve().parent
MODULE = 'StorageGetter'
VM_MODULE = 'StorageGetterVm'
PRELUDE = ('From Coq Require Import ZArith List Bool Lia PeanoNat.\n'
           'Require Import IntegerSemantics StorageGetter.\n'
           'Import ListNotations. Open Scope Z_scope.\n')
SCHEMA = 'neoos-sa-storage-getter-source-refinement/v1'
SCOPE = 'storage-getter-source-refinement'
GETCONTEXT_HASH = 0xce67f69b
STORAGE_GET_HASH = 0x31e85d92
CONVERT_INTEGER = 0x21
CONVERT_BUFFER = 0x30
CONVERT_BYTESTRING = 0x28
# NEF token table identity for StdLib.deserialize, pinned by hash and name.
STDLIB_HASH = '0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0'
DESERIALIZE_METHOD = 'deserialize'
DESERIALIZE_TOKEN_INDEX = 4
# Projection kinds that delegate to a shared private callee, and the debug
# method-table name each callee is bound through. A target may override the
# kind's default callee by naming its own (`row['callee']`), which is how the
# escrow owner-cancel accessors bind the raw reader while the
# pending-module-call accessors keep binding the record reader.
CALLEE_KINDS = {
    'state-field': 'getAccountState',
    'state-gt-zero': 'getAccountState',
    'presence-call': 'getPendingModuleCallRecord',
    'presence-call-item': 'getPendingModuleCallRecord',
    'raw-call-presence': 'getMarketEscrowOwnerCancelInitiated',
    'raw-call-offset': 'getMarketEscrowOwnerCancelInitiated',
}
SHARED_CALLEE_DEBUG_NAMES = {
    'getAccountState': 'SmartAccount.SmartAccount,GetAccountState',
    'getPendingModuleCallRecord': 'SmartAccount.SmartAccount,GetPendingModuleCallRecord',
    'getMarketEscrowOwnerCancelInitiated':
        'SmartAccount.SmartAccount,GetMarketEscrowOwnerCancelInitiated',
}
# Projection kinds whose traced machine carries the universally quantified
# deserialize oracle as its `mtokens` field (the entry state of every such
# getter is built with the same oracle as its successor machines). The
# escrow owner-cancel accessors return the raw payload and consume no token,
# so they are deliberately absent.
ORACLE_KINDS = ('state-field', 'state-gt-zero', 'presence-call',
                'presence-call-item', 'inline-record-time')
UNPROVED = [
    'ApplicationEngine correspondence for the getter regions (syscall'
    ' argument marshalling, gas, per-instruction engine state).',
    'The behavior of StdLib.Deserialize itself: the certificates quantify'
    ' universally over the token oracle and pin only its NEF token identity.',
    'Framework BigInteger/UInt160 cast internals beyond the pinned little-endian'
    ' and 20-byte contracts. The delegating record projections return the'
    ' deserialized array item verbatim: their compiled regions carry no runtime'
    ' width check on that item, so the UInt160 typing of the Module pair stays a'
    ' source-level type assertion and is not re-established at bytecode level here.',
    'All storage writes, all remaining public entrypoints and the full implementation.',
]
TCB = [
    'Strict typed-source grammar over the exported Roslyn operation trees.',
    'Pinned framework callee symbols (Helper.Concat, Storage.Get,'
    ' ExecutionEngine.Assert, StdLib.Deserialize) and the reviewed'
    ' UInt160.Zero / Int32-literal / zero-length-byte-string defaults.',
    'Abstract storage map: single-key lookup with no aliasing, iteration or'
    ' read-size semantics; each prefix is resolved from its own declaration'
    ' in the inputs.',
    'VM model in StorageGetterVm: one instruction per slot, the decoded'
    ' interop pop order for System.Storage.Get (context handle then key),'
    ' structural equality including null, and little-endian integer decode;'
    ' slot/target correspondence is pinned by the runner from the decoded'
    ' region bytes.',
    'Call/return frames share one evaluation stack and the local/argument'
    ' slots; the certified regions have disjoint local usage (the callers'
    ' declare no locals and never read an argument after the certified CALL),'
    ' pinned by the runner. A callee declaring more than one parameter takes'
    ' its arguments from the operand block the caller pushes immediately'
    ' before the certified CALL, whose shape the runner checks and whose'
    ' values it places in the traced argument vector.',
    'AccountState, PendingModuleCall and PendingConfigUpdate field ordinals are'
    ' derived from the class declaration order in the inputs and cross-checked'
    ' against the bytecode PICKITEM index rendered from the pinned regions.',
    'The shared escrow owner-cancel reader is delegated through the debug-only'
    ' method table and returns the stored payload verbatim (or the null item),'
    ' performing no deserialize: its callers apply the pinned null test and the'
    ' little-endian cast plus pinned timelock themselves. Its pinned prefix is'
    ' resolved from its own declaration in the inputs.',
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def declarations(text):
    return re.findall(r'^(?:Lemma|Theorem|Example)\s+(\w+)\s*:', text, re.MULTILINE)


def render_vm_program(region_rows, *, callee_start=None, token_index=None,
                      call_args=None):
    """Map the decoded region instructions onto VM-model slots, fail closed.

    Slot i is the i-th decoded instruction of the region; branch operands are
    rewritten from real pcs to slot indices (every target must itself be a
    decoded instruction boundary of the region). Any opcode outside the
    pinned model set aborts the lane instead of being silently dropped.
    CALL/CALL_L is allowed only when callee_start is given and the target
    equals it (rendered as a 'Call CALLEE' placeholder patched by the
    combiner); CALLT is allowed only when token_index is given and matches
    the decoded token index.

    call_args, when given, is the lane-derived parameter binding of a callee
    region: element k is the rendered read of the caller operand that the
    certified CALL passes as parameter k. LDARGk in the region is then
    rendered as that read instead of the default slot-0 read, so a callee
    declaring more than one parameter takes each argument from the operand
    block the caller actually pushes. Without call_args only LDARG0 is
    modeled; any other LDARGk fails closed.
    """
    offsets = [row['offset'] for row in region_rows]
    slot_of = {off: index for index, off in enumerate(offsets)}
    parts = []
    meta = {'nlocals': None, 'nparams': None, 'static_slots': set(),
            'branch_slots': {}, 'cast_width': None, 'calls': [],
            'token_calls': []}
    branch_names = {'JMP': 'Jump', 'JMPIF': 'JumpIf',
                    'JMPIFNOT': 'JumpIfNot', 'JMPEQ': 'JumpEq'}
    push_match = re.compile(r'PUSH(?:([0-9])|1([0-6]))$')
    for row in region_rows:
        name = row['name']
        operand = bytes.fromhex(row['operandHex']) if row['operandHex'] else b''
        if name == 'INITSLOT':
            require(len(operand) == 2 and meta['nlocals'] is None,
                    'Unexpected INITSLOT shape')
            meta['nlocals'], meta['nparams'] = operand[0], operand[1]
            parts.append('InitSlot %d %d' % (operand[0], operand[1]))
        elif name == 'LDSFLD':
            require(len(operand) == 1, 'Unexpected LDSFLD operand')
            meta['static_slots'].add(operand[0])
            parts.append('LdStatic %d' % operand[0])
        elif re.fullmatch(r'LDSFLD[0-6]', name):
            meta['static_slots'].add(int(name[-1]))
            parts.append('LdStatic ' + name[-1])
        elif name == 'LDARG0':
            parts.append(call_args[0] if call_args else 'LdArg')
        elif re.fullmatch(r'LDARG[1-6]', name):
            index = int(name[len('LDARG'):])
            require(call_args is not None and index < len(call_args),
                    'LDARG%d outside the pinned callee parameter binding' % index)
            parts.append(call_args[index])
        elif re.fullmatch(r'LDLOC[0-6]', name):
            parts.append('LdLoc ' + name[-1])
        elif re.fullmatch(r'STLOC[0-6]', name):
            parts.append('StLoc ' + name[-1])
        elif name == 'SYSCALL':
            require(len(operand) == 4, 'Unexpected SYSCALL operand')
            syscall = int.from_bytes(operand, 'little')
            if syscall == GETCONTEXT_HASH:
                parts.append('GetContext')
            elif syscall == STORAGE_GET_HASH:
                parts.append('StorageGet')
            else:
                raise ValueError('Unexpected syscall in getter region: %08x' % syscall)
        elif name == 'CAT':
            parts.append('Concat')
        elif name == 'NEWBUFFER':
            parts.append('NewBuffer')
        elif name == 'CONVERT':
            require(len(operand) == 1 and operand[0] in (CONVERT_INTEGER, CONVERT_BUFFER,
                                                         CONVERT_BYTESTRING),
                    'Unexpected CONVERT type in getter region: %02x' % (operand[0] if operand else -1))
            parts.append('Convert %d' % operand[0])
        elif name == 'EQUAL':
            parts.append('EqualIns')
        elif name == 'NOTEQUAL':
            parts.append('NotEqualIns')
        elif name == 'PICKITEM':
            parts.append('PickItem')
        elif name == 'GT':
            parts.append('Greater')
        elif name == 'ADD':
            parts.append('AddIns')
        elif name == 'PACK':
            parts.append('Pack')
        elif name == 'ISTYPE':
            require(len(operand) == 1 and operand[0] == 0x28,
                    'Unexpected ISTYPE marker in getter region: %02x'
                    % (operand[0] if operand else -1))
            parts.append('IsType 40')
        elif name == 'NUMEQUAL':
            parts.append('NumEquals')
        elif name == 'CALLT':
            require(len(operand) == 2, 'Unexpected CALLT operand')
            token = int.from_bytes(operand, 'little')
            require(token_index is not None and token == token_index,
                    'CALLT token %d outside the pinned token identity' % token)
            meta['token_calls'].append(token)
            parts.append('CallToken %d' % token)
        elif name in ('CALL', 'CALL_L'):
            width = 1 if name == 'CALL' else 4
            require(len(operand) == width, 'Unexpected %s operand' % name)
            target = row['offset'] + int.from_bytes(operand, 'little', signed=True)
            require(callee_start is not None and target == callee_start,
                    '%s target %d is not the pinned shared callee' % (name, target))
            meta['calls'].append(row['offset'])
            parts.append('Call CALLEE')
        elif name in branch_names:
            require(len(operand) == 1, 'Only short branch forms are modeled')
            target = row['offset'] + int.from_bytes(operand, 'little', signed=True)
            require(target in slot_of, 'Branch target %d is not a region boundary' % target)
            slot = slot_of[target]
            parts.append(branch_names[name] + ' %d' % slot)
            meta['branch_slots'][row['offset']] = slot
        elif name == 'PUSHNULL':
            parts.append('Push GNull')
        elif name == 'PUSHF':
            parts.append('Push (GBool false)')
        elif name == 'PUSHDATA1':
            # A zero-length PUSHDATA1 is the compiled string.Empty constant
            # (getMetadataUri); longer operands are inlined verbatim.
            parts.append('Push (GBytes [' + ';'.join('%d%%nat' % b for b in operand) + '])')
        elif name == 'PUSH0':
            parts.append('Push (GInt 0)')
        elif push_match.fullmatch(name):
            value = int(push_match.match(name).group(1) or ('1' + push_match.match(name).group(2)))
            parts.append('Push (GInt %d)' % value)
        elif name == 'PUSHINT8':
            require(len(operand) == 1, 'Unexpected PUSHINT8 operand')
            parts.append('Push (GInt %d%%Z)' % int.from_bytes(operand, 'little', signed=True))
        elif name == 'DUP':
            parts.append('Dup')
        elif name == 'DROP':
            parts.append('Drop')
        elif name == 'ISNULL':
            parts.append('IsNull')
        elif name == 'SIZE':
            parts.append('SizeIns')
        elif name == 'THROW':
            parts.append('Throw')
        elif name == 'ABORTMSG':
            parts.append('AbortMsg')
        elif name == 'RET':
            parts.append('Ret')
        else:
            raise ValueError('Unsupported opcode in getter region: ' + name)
    require(parts and parts[-1] == 'Ret', 'Region model must end at RET')
    require(parts[0].startswith('InitSlot ') and meta['nlocals'] is not None,
            'Region model must start at INITSLOT')
    require(len(meta['static_slots']) <= 2, 'Region must load at most two static fields')
    require(parts.count('Call CALLEE') == len(meta['calls']),
            'Inconsistent call inventory')
    if any(p.startswith('JumpEq ') for p in parts):
        # width witness: the PUSHINT8 checked against SIZE in the UInt160 cast
        widths = [int(p[len('Push (GInt '):-3]) for p in parts
                  if p.startswith('Push (GInt ') and p.endswith('%Z)')]
        require(len(widths) == 1, 'Expected exactly one cast width witness')
        meta['cast_width'] = widths[0]
    return parts, meta


def combine_program(caller_parts, caller_meta, callee_parts, callee_meta,
                    static_limit=1):
    """Append the callee region to a caller program and patch the frames.

    The single 'Call CALLEE' placeholder is bound to the callee entry slot
    (len(caller_parts)); callee-internal branch targets shift by the caller
    length. Returns (parts, max_locals, static_slots). Both frames read one
    shared static field table (the model's mstatics), so a slot number used
    by both frames is refused instead of being silently aliased; the union is
    then cross-checked against static_limit, which allows the two-slot
    callers (the fixed-prefix delay getters and the delegating record Time
    getters, which additionally load the pinned timelock constant after the
    call).
    """
    require(len(caller_meta['calls']) == 1 and caller_parts.count('Call CALLEE') == 1,
            'Combined program expects exactly one call')
    entry = len(caller_parts)
    parts = [p.replace('Call CALLEE', 'Call %d' % entry) if p == 'Call CALLEE' else p
             for p in caller_parts]
    shift = entry

    def shift_target(text):
        return text.split()[0] + ' %d' % (int(text.split()[1]) + shift)

    for part in callee_parts:
        if part.split()[0] in ('Jump', 'JumpIf', 'JumpIfNot', 'JumpEq'):
            parts.append(shift_target(part))
        else:
            parts.append(part)
    require(not (set(caller_meta['static_slots']) & set(callee_meta['static_slots'])),
            'Caller and callee must not share a static field slot number')
    statics = set(caller_meta['static_slots']) | set(callee_meta['static_slots'])
    require(len(statics) <= static_limit,
            'Combined program must share at most %d static field(s)' % static_limit)
    locals_count = max(caller_meta['nlocals'], callee_meta['nlocals'])
    return parts, locals_count, statics


def _bind_region(inventory, decoded, start, end, callee_start=None):
    """Decode and validate one pinned [start, end) region ending at RET.

    CALL edges targeting exactly the pinned shared callee are allowed (they
    are re-validated against the callee start during program rendering).
    """
    script = bytes.fromhex(inventory['nef']['scriptHex'])
    require(0 < start < end <= len(script), 'Invalid getter region')
    region = [row for row in decoded if start <= row['offset'] < end]
    require(region and region[-1]['offset'] + region[-1]['size'] == end and
            region[-1]['opcode'] == 0x40, 'Region must end at the method RET')
    require(all(edge['target'] is None or start <= edge['target'] < end or
                (callee_start is not None and edge['kind'] == 'call' and
                 edge['target'] == callee_start)
                for row in region for edge in row.get('edges', [])
                if edge['kind'] != 'fallthrough' or row['opcode'] != 64),
            'Getter region escapes its certified range')
    return region


def bind_entries(inventory, projection, callees):
    """Bind each getter to its ABI descriptor and exact debug byte region.

    State-projection getters call the pinned shared callee GetAccountState, the
    delegating presence getters and record projections call the pinned shared
    callee GetPendingModuleCallRecord, and the escrow owner-cancel accessors
    call the pinned shared callee GetMarketEscrowOwnerCancelInitiated; every
    shared callee is bound separately from
    the debug-only method table (it carries no ABI entry) and each caller's
    CALL edges are validated against its own callee region start. A region
    that calls is required to name the callee its kind binds, and a region
    that names a callee is required to call. The NEF token table entry for
    the pinned deserialize index is checked against the StdLib hash and
    method name.
    """
    script = bytes.fromhex(inventory['nef']['scriptHex'])
    require(sha(script) == inventory['nef']['scriptSha256'], 'Script identity mismatch')
    tokens = inventory['nef']['tokens']
    require(len(tokens) > DESERIALIZE_TOKEN_INDEX, 'Missing pinned NEF token entry')
    token = tokens[DESERIALIZE_TOKEN_INDEX]
    require(token.get('hash') == STDLIB_HASH and token.get('method') == DESERIALIZE_METHOD,
            'Token table drift at the pinned deserialize index')
    decoded = nef_decode.decode_script(script, len(tokens))
    require(len(decoded) == len(inventory['nef']['instructions']), 'Instruction inventory mismatch')
    offsets = {row['offset'] for row in decoded}

    # Shared callees: debug-only bindings (no ABI entries).
    bound_callees = {}
    for callee_name in sorted(callees):
        debug_name = SHARED_CALLEE_DEBUG_NAMES[callee_name]
        debug_methods = inventory['sourceMap']['debug']['methods']
        callee_debug = [d for d in debug_methods if d.get('name') == debug_name]
        require(len(callee_debug) == 1,
                'Missing/ambiguous shared callee binding: ' + callee_name)
        cstart, clast = map(int, callee_debug[0]['range'].split('-'))
        cend = clast + 1
        require(cstart in offsets, 'Callee start is not an instruction boundary: ' + callee_name)
        callee_region = _bind_region(inventory, decoded, cstart, cend)
        bound_callees[callee_name] = dict(
            name=callee_name, debugName=debug_name,
            start=cstart, endExclusive=cend, byteCount=cend - cstart,
            instructionCount=len(callee_region),
            nparams=_callee_nparams(callee_region),
            regionBytesSha256=sha(script[cstart:cend]),
            projection=callees[callee_name])
    require('getAccountState' in bound_callees, 'Missing the pinned state callee')

    methods = {}
    for name, projection_row in projection.items():
        abis = [m for m in inventory['manifest']['methods'] if m['name'] == name]
        require(len(abis) == 1, 'Missing/ambiguous ABI entry: ' + name)
        abi = abis[0]
        require(abi['safe'] is True and abi['returntype'] != 'Void', 'Getter must be safe and nonvoid')
        kind = projection_row.get('kind', 'direct')
        expected_params = 0 if kind in ('direct-fixed', 'direct-fixed-offset') else 1
        require(len(abi['parameters']) == expected_params,
                'Getter must take exactly the %s ABI parameter(s)'
                % ('zero fixed-prefix' if expected_params == 0 else 'account'))
        require(abi['offset'] in offsets, 'ABI offset is not an instruction boundary')
        debug = [d for d in inventory['sourceMap']['debug']['methods']
                 if d.get('abi') == abi]
        require(len(debug) == 1, 'Missing/ambiguous debug binding: ' + name)
        start, last = map(int, debug[0]['range'].split('-'))
        end = last + 1
        require(start == abi['offset'], 'ABI/debug offset mismatch')
        callee_name = projection_row.get('callee') or CALLEE_KINDS.get(kind)
        if kind in CALLEE_KINDS:
            require(callee_name in bound_callees,
                    'Delegating getter must name a bound shared callee: ' + name)
        else:
            require(projection_row.get('callee') is None,
                    'Non-delegating getter must not name a callee: ' + name)
            callee_name = None
        callee = bound_callees[callee_name] if callee_name is not None else None
        region = _bind_region(inventory, decoded, start, end,
                              callee_start=callee['start'] if callee else None)
        calls_region = any(row['name'] in ('CALL', 'CALL_L') for row in region)
        require(calls_region == (callee is not None),
                'Unexpected call discipline in region: ' + name)
        methods[name] = dict(abi=abi, kind=kind, calleeName=callee_name,
                             start=start, endExclusive=end,
                             byteCount=end - start, instructionCount=len(region),
                             regionBytesSha256=sha(script[start:end]),
                             projection=projection_row)
    return dict(nefSha256=inventory['nef']['sha256'], scriptSha256=inventory['nef']['scriptSha256'],
                methods=methods,
                callees=bound_callees,
                callee=bound_callees['getAccountState'])


def _prefix_literal(values):
    """Render a pinned prefix byte list as a Coq `bytes` literal."""
    return '[' + ';'.join(str(b) + '%nat' for b in values) + ']'


def render_certificate(bound):
    methods = bound['methods']
    kinds = {name: entry['projection'].get('kind', 'direct')
             for name, entry in methods.items()}
    out = [PRELUDE]
    if any(k in kinds.values() for k in ('presence-call', 'raw-call-presence')):
        # The delegating presence outcomes test the deserialize oracle result
        # (and, for the escrow owner-cancel presence getter, the raw reader
        # result) with the VM model's structural null equality, so the
        # source-level outcome and the traced NOTEQUAL step are literally the
        # same term.
        out.append('Require Import %s.\n' % VM_MODULE)
    # Shared outcome definitions for the state-projection family. The
    # deserialize token is the universally quantified oracle `tok`; the
    # certificate only claims agreement relative to it.
    if any(k in ('state-field', 'state-gt-zero') for k in kinds.values()):
        callee_row = bound['callee']['projection']
        prefix = '[' + ';'.join(str(b) + '%nat' for b in callee_row['prefixBytes']) + ']'
        out.append(f'Definition account_state_prefix : bytes := {prefix}.\n'
                   'Definition account_state_outcome (tok : nat -> GVal -> GVal) (i : nat)\n'
                   '  (sto : storage) (account : bytes) : Outcome :=\n'
                   '  match sto (account_state_prefix ++ account) with\n'
                   '  | None => Fault\n'
                   '  | Some payload =>\n'
                   f'      match tok {DESERIALIZE_TOKEN_INDEX}%nat (GBytes payload) with\n'
                   '      | GArray xs => match nth_error xs i with\n'
                   '                     | Some v => OK v\n'
                   '                     | None => Fault\n'
                   '                     end\n'
                   '      | _ => Fault\n'
                   '      end\n'
                   '  end.\n')
    for name in sorted(methods):
        entry = methods[name]
        row = entry['projection']
        kind = row.get('kind', 'direct')
        if kind in ('direct', 'direct-fixed'):
            prefix = '[' + ';'.join(str(b) + '%nat' for b in row['prefixBytes']) + ']'
            decode = 'decode_integer' if row['decode'] == 'integer' else 'decode_hash160'
            if row['decode'] == 'integer':
                default = '(GInt ' + str(row['default']['value']) + '%Z)'
            else:
                default = '(GBytes hash160_default)'
            if kind == 'direct-fixed':
                # Fixed-prefix getters have no ABI argument: the storage key is
                # the prefix constant itself, so the binding is stated at the
                # empty account suffix (pfx ++ [] = pfx).
                key = name + '_prefix'
                quant = 'sto'
                ac_arg = '[]'
                src_rw = 'app_nil_r, '
            else:
                key = name + '_prefix ++ account'
                quant = 'sto account'
                ac_arg = 'account'
                src_rw = ''
            out.append(f'Definition {name}_prefix : bytes := {prefix}.\n'
                       f'Definition {name}_binding (sto : storage) (account : bytes) : Outcome :=\n'
                       f' getter_outcome {name}_prefix {default} {decode} sto account.\n')
            out.append(f'''Theorem {name}_missing_key_default : forall {quant},
 sto ({key}) = None ->
 {name}_binding sto {ac_arg} = OK {default}.
Proof. intros {quant} H. unfold {name}_binding, getter_outcome. rewrite {src_rw}H. reflexivity. Qed.
Print Assumptions {name}_missing_key_default.
Theorem {name}_present_key_decodes : forall {quant} payload,
 sto ({key}) = Some payload ->
 {name}_binding sto {ac_arg} = match {decode} payload with OK v => OK v | Fault => Fault end.
Proof. intros {quant} payload H. unfold {name}_binding, getter_outcome. rewrite {src_rw}H. reflexivity. Qed.
Print Assumptions {name}_present_key_decodes.
''')
            if row['decode'] == 'hash160':
                out.append(f'''Theorem {name}_short_payload_faults : forall {quant} payload,
 sto ({key}) = Some payload ->
 (length payload <> 20)%nat ->
 {name}_binding sto {ac_arg} = Fault.
Proof. intros {quant} payload Hstore Hlen.
 unfold {name}_binding, getter_outcome, decode_hash160. rewrite {src_rw}Hstore.
 destruct (valid_bytes payload); simpl.
 - apply Nat.eqb_neq in Hlen. rewrite Hlen. reflexivity.
 - reflexivity. Qed.
Print Assumptions {name}_short_payload_faults.
''')
            else:
                out.append(f'''Theorem {name}_zero_payload_is_zero : forall {quant},
 sto ({key}) = Some [] ->
 {name}_binding sto {ac_arg} = OK (GInt 0).
Proof. intros {quant} H. unfold {name}_binding, getter_outcome, decode_integer.
 rewrite {src_rw}H. simpl. reflexivity. Qed.
Print Assumptions {name}_zero_payload_is_zero.
''')
        elif kind == 'direct-fixed-offset':
            offset_txt = '%d%%Z' % row['offset']
            prefix = '[' + ';'.join(str(b) + '%nat' for b in row['prefixBytes']) + ']'
            out.append(f'Definition {name}_prefix : bytes := {prefix}.\n'
                       f'Definition {name}_decode (b : bytes) : Outcome :=\n'
                       ' match decode_integer b with\n'
                       f' | OK (GInt v) => OK (GInt (v + {offset_txt}))\n'
                       ' | OK _ => Fault\n'
                       ' | Fault => Fault\n'
                       ' end.\n'
                       f'Definition {name}_binding (sto : storage) (account : bytes) : Outcome :=\n'
                       f' getter_outcome {name}_prefix (GInt 0%Z) {name}_decode sto account.\n')
            out.append(f'''Theorem {name}_missing_key_default : forall sto account,
 sto ({name}_prefix ++ account) = None ->
 {name}_binding sto account = OK (GInt 0%Z).
Proof. intros sto account H. unfold {name}_binding, getter_outcome.
 rewrite H. reflexivity. Qed.
Print Assumptions {name}_missing_key_default.
Theorem {name}_present_key_offsets : forall sto account payload value,
 sto ({name}_prefix ++ account) = Some payload ->
 decode_integer payload = OK (GInt value) ->
 {name}_binding sto account = OK (GInt (value + {offset_txt})).
Proof. intros sto account payload value Hstore Hdecode.
 unfold {name}_binding, getter_outcome, {name}_decode.
 rewrite Hstore, Hdecode. reflexivity. Qed.
Print Assumptions {name}_present_key_offsets.
''')
        elif kind == 'direct-raw':
            prefix = '[' + ';'.join(str(b) + '%nat' for b in row['prefixBytes']) + ']'
            out.append(f'Definition {name}_prefix : bytes := {prefix}.\n'
                       f'Definition {name}_decode (b : bytes) : Outcome := OK (GBytes b).\n'
                       f'Definition {name}_binding (sto : storage) (account : bytes) : Outcome :=\n'
                       f' getter_outcome {name}_prefix (GBytes []) {name}_decode sto account.\n')
            out.append(f'''Theorem {name}_missing_key_default : forall sto account,
 sto ({name}_prefix ++ account) = None ->
 {name}_binding sto account = OK (GBytes []).
Proof. intros sto account H. unfold {name}_binding, getter_outcome.
 rewrite H. reflexivity. Qed.
Print Assumptions {name}_missing_key_default.
Theorem {name}_present_key_verbatim : forall sto account payload,
 sto ({name}_prefix ++ account) = Some payload ->
 {name}_binding sto account = OK (GBytes payload).
Proof. intros sto account payload H. unfold {name}_binding, getter_outcome, {name}_decode.
 rewrite H. reflexivity. Qed.
Print Assumptions {name}_present_key_verbatim.
''')
        elif kind == 'state-field':
            index = row['fieldIndex']
            out.append(f'''Theorem {name}_source_miss : forall tok sto account,
 sto (account_state_prefix ++ account) = None ->
 account_state_outcome tok %(i)d sto account = Fault.
Proof. intros tok sto account H. unfold account_state_outcome. rewrite H. reflexivity. Qed.
Print Assumptions {name}_source_miss.
Theorem {name}_source_hit : forall tok sto account payload xs v,
 sto (account_state_prefix ++ account) = Some payload ->
 tok %(t)d%%nat (GBytes payload) = GArray xs ->
 nth_error xs %(i)d = Some v ->
 account_state_outcome tok %(i)d sto account = OK v.
Proof. intros tok sto account payload xs v H Htok Hnth.
 unfold account_state_outcome. rewrite H, Htok, Hnth. reflexivity. Qed.
Print Assumptions {name}_source_hit.
''' % {'i': index, 't': DESERIALIZE_TOKEN_INDEX})
        elif kind == 'state-gt-zero':
            index = row['fieldIndex']
            out.append(f'''Definition escape_active_outcome (tok : nat -> GVal -> GVal)
  (sto : storage) (account : bytes) : Outcome :=
 match account_state_outcome tok {index} sto account with
 | OK (GInt z) => OK (GBool (Z.ltb 0 z))
 | OK _ => Fault
 | Fault => Fault
 end.
Theorem {name}_source_miss : forall tok sto account,
 sto (account_state_prefix ++ account) = None ->
 escape_active_outcome tok sto account = Fault.
Proof. intros tok sto account H. unfold escape_active_outcome,
 account_state_outcome. rewrite H. reflexivity. Qed.
Print Assumptions {name}_source_miss.
Theorem {name}_source_hit : forall tok sto account payload xs z,
 sto (account_state_prefix ++ account) = Some payload ->
 tok %(t)d%%nat (GBytes payload) = GArray xs ->
 nth_error xs %(i)d = Some (GInt z) ->
 escape_active_outcome tok sto account = OK (GBool (Z.ltb 0 z)).
Proof. intros tok sto account payload xs z H Htok Hnth.
 unfold escape_active_outcome, account_state_outcome.
 rewrite H, Htok, Hnth. reflexivity. Qed.
Print Assumptions {name}_source_hit.
''' % {'i': index, 't': DESERIALIZE_TOKEN_INDEX})
        elif kind == 'presence':
            prefix = '[' + ';'.join(str(b) + '%nat' for b in row['prefixBytes']) + ']'
            out.append(f'Definition {name}_prefix : bytes := {prefix}.\n'
                       f'Definition {name}_binding (sto : storage) (account : bytes) : Outcome :=\n'
                       f' match sto ({name}_prefix ++ account) with\n'
                       ' | None => OK (GBool false)\n'
                       ' | Some _ => OK (GBool true)\n'
                       ' end.\n')
            out.append(f'''Theorem {name}_source_miss : forall sto account,
 sto ({name}_prefix ++ account) = None ->
 {name}_binding sto account = OK (GBool false).
Proof. intros sto account H. unfold {name}_binding. rewrite H. reflexivity. Qed.
Print Assumptions {name}_source_miss.
Theorem {name}_source_hit : forall sto account payload,
 sto ({name}_prefix ++ account) = Some payload ->
 {name}_binding sto account = OK (GBool true).
Proof. intros sto account payload H. unfold {name}_binding. rewrite H. reflexivity. Qed.
Print Assumptions {name}_source_hit.
''')
        elif kind == 'presence-call':
            # Delegating presence getters: `return
            # GetPendingModuleCallRecord(<prefix>, accountId) != null;`. The
            # callee returns the null item when the key is unbound and
            # otherwise the deserialize oracle applied to the payload, so the
            # outcome is the presence predicate over the same key, with the
            # null test written as the VM's structural equality. The oracle is
            # universally quantified, exactly as in the state projections.
            prefix = '[' + ';'.join(str(b) + '%nat' for b in row['prefixBytes']) + ']'
            out.append(f'Definition {name}_prefix : bytes := {prefix}.\n'
                       f'Definition {name}_binding (tok : nat -> GVal -> GVal)\n'
                       '  (sto : storage) (account : bytes) : Outcome :=\n'
                       f' match sto ({name}_prefix ++ account) with\n'
                       ' | None => OK (GBool false)\n'
                       ' | Some payload =>\n'
                       '     OK (GBool (negb (gval_eqb GNull'
                       f' (tok {DESERIALIZE_TOKEN_INDEX}%nat (GBytes payload)))))\n'
                       ' end.\n')
            out.append(f'''Theorem {name}_source_miss : forall tok sto account,
 sto ({name}_prefix ++ account) = None ->
 {name}_binding tok sto account = OK (GBool false).
Proof. intros tok sto account H. unfold {name}_binding. rewrite H. reflexivity. Qed.
Print Assumptions {name}_source_miss.
Theorem {name}_source_hit : forall tok sto account payload,
 sto ({name}_prefix ++ account) = Some payload ->
 gval_eqb GNull (tok {DESERIALIZE_TOKEN_INDEX}%nat (GBytes payload)) = false ->
 {name}_binding tok sto account = OK (GBool true).
Proof. intros tok sto account payload Hstore Hne.
 unfold {name}_binding. rewrite Hstore, Hne. reflexivity. Qed.
Print Assumptions {name}_source_hit.
''')
        elif kind == 'presence-call-item':
            # Delegating record projections: `pending =
            # GetPendingModuleCallRecord(<prefix>, accountId); return pending
            # == null ? <default> : pending.<field> [ + timelock ];`. The
            # shared callee returns the null item when the key is unbound and
            # otherwise the deserialize oracle applied to the payload, so the
            # binding is one field projection of the deserialized record over
            # the same key, relative to the universally quantified oracle,
            # exactly as in the state projections. The ordinal is the one
            # extracted from the PendingModuleCall declaration and
            # cross-checked against the rendered PICKITEM index.
            #
            # Note the projected field is returned verbatim: the compiled
            # delegation performs no runtime width check on it (unlike the
            # direct hash160 getters, whose regions carry the SIZE/JMPEQ
            # witness), so for the Module pair the UInt160 typing stays a
            # source-level type assertion rather than a bytecode-checked
            # property of this lane.
            index = row['itemIndex']
            prefix = '[' + ';'.join(str(b) + '%nat' for b in row['prefixBytes']) + ']'
            if row['decode'] in ('hash160', 'raw-bytes'):
                if row['decode'] == 'hash160':
                    default = 'OK (GBytes hash160_default)'
                    require('offset' not in row,
                            'Hash160 record projection must not carry a delay constant: '
                            + name)
                else:
                    # `(ByteString)new byte[0]`: the pinned empty byte string.
                    require(row['default'] == {'kind': 'empty-bytes'} and 'offset' not in row,
                            'Unsupported record empty-bytes default: ' + name)
                    default = 'OK (GBytes [])'
                project = ('match nth_error xs %d with\n'
                           '                     | Some v => OK v\n'
                           '                     | None => Fault\n'
                           '                     end' % index)
                hit_decl = 'payload xs v'
                hit_extra = ('tok {t}%nat (GBytes payload) = GArray xs ->\n'
                             ' nth_error xs {i} = Some v ->'.format(i=index, t=DESERIALIZE_TOKEN_INDEX))
                hit_value = 'v'
            else:
                require(row['decode'] == 'integer' and 'offset' in row,
                        'Unsupported record projection decode: ' + name)
                offset_txt = '%d%%Z' % row['offset']
                default = 'OK (GInt 0%Z)'
                project = ('match nth_error xs %d with\n'
                           '                     | Some (GInt z) => OK (GInt (z + %s))\n'
                           '                     | Some _ => Fault\n'
                           '                     | None => Fault\n'
                           '                     end' % (index, offset_txt))
                hit_decl = 'payload xs z'
                hit_extra = ('tok {t}%nat (GBytes payload) = GArray xs ->\n'
                             ' nth_error xs {i} = Some (GInt z) ->'.format(i=index, t=DESERIALIZE_TOKEN_INDEX))
                hit_value = '(GInt (z + %s))' % offset_txt
            out.append(f'Definition {name}_prefix : bytes := {prefix}.\n'
                       f'Definition {name}_binding (tok : nat -> GVal -> GVal)\n'
                       '  (sto : storage) (account : bytes) : Outcome :=\n'
                       f' match sto ({name}_prefix ++ account) with\n'
                       f' | None => {default}\n'
                       ' | Some payload =>\n'
                       f'     match tok {DESERIALIZE_TOKEN_INDEX}%nat (GBytes payload) with\n'
                       f'     | GArray xs => {project}\n'
                       '     | _ => Fault\n'
                       '     end\n'
                       ' end.\n')
            out.append(f'''Theorem {name}_source_miss : forall tok sto account,
 sto ({name}_prefix ++ account) = None ->
 {name}_binding tok sto account = {default}.
Proof. intros tok sto account H. unfold {name}_binding. rewrite H. reflexivity. Qed.
Print Assumptions {name}_source_miss.
Theorem {name}_source_hit : forall tok sto account {hit_decl},
 sto ({name}_prefix ++ account) = Some payload ->
 {hit_extra}
 {name}_binding tok sto account = OK {hit_value}.
Proof. intros tok sto account {hit_decl} H Htok Hnth.
 unfold {name}_binding. rewrite H, Htok, Hnth. reflexivity. Qed.
Print Assumptions {name}_source_hit.
''')
        elif kind == 'inline-record-time':
            # Inline epoch getters: the body concatenates its own key, reads it,
            # returns the pinned integer default on a miss and otherwise
            # deserializes the pending-config-update record, projecting
            # InitiatedAt and adding the pinned timelock. The key expression is
            # therefore the same one the delegating Time pair reads through its
            # callee, and the outcome is the same field projection relative to the
            # universally quantified deserialize oracle. The ordinal comes from
            # the PendingConfigUpdate declaration order and is cross-checked
            # against the rendered PICKITEM index.
            index = row['itemIndex']
            prefix = '[' + ';'.join(str(b) + '%nat' for b in row['prefixBytes']) + ']'
            require(row['decode'] == 'integer' and 'offset' in row,
                    'Unsupported inline epoch decode: ' + name)
            offset_txt = '%d%%Z' % row['offset']
            default = 'OK (GInt 0%Z)'
            project = ('match nth_error xs %d with\n'
                       '                     | Some (GInt z) => OK (GInt (z + %s))\n'
                       '                     | Some _ => Fault\n'
                       '                     | None => Fault\n'
                       '                     end' % (index, offset_txt))
            hit_decl = 'payload xs z'
            hit_extra = ('tok {t}%nat (GBytes payload) = GArray xs ->\n'
                         ' nth_error xs {i} = Some (GInt z) ->'.format(
                             i=index, t=DESERIALIZE_TOKEN_INDEX))
            hit_value = '(GInt (z + %s))' % offset_txt
            out.append(f'Definition {name}_prefix : bytes := {prefix}.\n'
                       f'Definition {name}_binding (tok : nat -> GVal -> GVal)\n'
                       '  (sto : storage) (account : bytes) : Outcome :=\n'
                       f' match sto ({name}_prefix ++ account) with\n'
                       f' | None => {default}\n'
                       ' | Some payload =>\n'
                       f'     match tok {DESERIALIZE_TOKEN_INDEX}%nat (GBytes payload) with\n'
                       f'     | GArray xs => {project}\n'
                       '     | _ => Fault\n'
                       '     end\n'
                       ' end.\n')
            out.append(f'''Theorem {name}_source_miss : forall tok sto account,
 sto ({name}_prefix ++ account) = None ->
 {name}_binding tok sto account = {default}.
Proof. intros tok sto account H. unfold {name}_binding. rewrite H. reflexivity. Qed.
Print Assumptions {name}_source_miss.
Theorem {name}_source_hit : forall tok sto account {hit_decl},
 sto ({name}_prefix ++ account) = Some payload ->
 {hit_extra}
 {name}_binding tok sto account = OK {hit_value}.
Proof. intros tok sto account {hit_decl} H Htok Hnth.
 unfold {name}_binding. rewrite H, Htok, Hnth. reflexivity. Qed.
Print Assumptions {name}_source_hit.
''')
        elif kind == 'raw-call-presence':
            # Delegating raw presence getter: `return
            # GetMarketEscrowOwnerCancelInitiated(accountId) != null;`. The
            # shared reader returns the null item when the key is unbound and
            # otherwise the stored payload verbatim (it performs no
            # deserialize, so this family consumes no token oracle), and the
            # caller's null test is the VM model's structural equality. The
            # reader owns the prefix, so the binding names the caller's own
            # copy of that one constant.
            require('offset' not in row and 'decode' not in row,
                    'Raw presence projection must carry no decode contract: ' + name)
            source = bound['callees'][row.get('callee')
                                          or CALLEE_KINDS[kind]]['projection']
            require('prefixBytes' in source,
                    'Raw presence reader must pin its prefix: ' + name)
            out.append(f'Definition {name}_prefix : bytes := '
                       f'{_prefix_literal(source["prefixBytes"])}.\n'
                       f'Definition {name}_reader (sto : storage) (account : bytes) : GVal :=\n'
                       f' match sto ({name}_prefix ++ account) with\n'
                       ' | None => GNull\n'
                       ' | Some payload => GBytes payload\n'
                       ' end.\n'
                       f'Definition {name}_binding (sto : storage) (account : bytes) : Outcome :=\n'
                       f' OK (GBool (negb (gval_eqb GNull ({name}_reader sto account)))).\n')
            out.append(f'''Theorem {name}_source_miss : forall sto account,
 sto ({name}_prefix ++ account) = None ->
 {name}_binding sto account = OK (GBool false).
Proof. intros sto account Hstore.
 unfold {name}_binding, {name}_reader. rewrite Hstore. reflexivity. Qed.
Print Assumptions {name}_source_miss.
Theorem {name}_source_hit : forall sto account payload,
 sto ({name}_prefix ++ account) = Some payload ->
 {name}_binding sto account = OK (GBool true).
Proof. intros sto account payload Hstore.
 unfold {name}_binding, {name}_reader. rewrite Hstore. reflexivity. Qed.
Print Assumptions {name}_source_hit.
''')
        elif kind == 'raw-call-offset':
            # Delegating raw epoch getter: `initiated =
            # GetMarketEscrowOwnerCancelInitiated(accountId); return initiated
            # == null ? 0 : (BigInteger)initiated + <pinned delay>;`. The
            # shared reader returns the raw payload, so the decode is the
            # framework reference cast followed by the pinned delay constant,
            # written as a named decode exactly as the fixed-prefix timelock
            # getters do; the miss value is the pinned integer default.
            require(row['decode'] == 'integer' and 'offset' in row and
                    row['default'] == {'kind': 'integer', 'value': 0},
                    'Unsupported raw epoch projection: ' + name)
            offset_txt = '%d%%Z' % row['offset']
            source = bound['callees'][row.get('callee')
                                          or CALLEE_KINDS[kind]]['projection']
            require('prefixBytes' in source,
                    'Raw epoch reader must pin its prefix: ' + name)
            out.append(f'Definition {name}_prefix : bytes := '
                       f'{_prefix_literal(source["prefixBytes"])}.\n'
                       f'Definition {name}_decode (b : bytes) : Outcome :=\n'
                       ' match decode_integer b with\n'
                       f' | OK (GInt v) => OK (GInt (v + {offset_txt}))\n'
                       ' | OK _ => Fault\n'
                       ' | Fault => Fault\n'
                       ' end.\n'
                       f'Definition {name}_binding (sto : storage) (account : bytes) : Outcome :=\n'
                       f' getter_outcome {name}_prefix (GInt 0%Z) {name}_decode sto account.\n')
            out.append(f'''Theorem {name}_source_miss : forall sto account,
 sto ({name}_prefix ++ account) = None ->
 {name}_binding sto account = OK (GInt 0%Z).
Proof. intros sto account H. unfold {name}_binding, getter_outcome.
 rewrite H. reflexivity. Qed.
Print Assumptions {name}_source_miss.
Theorem {name}_source_hit : forall sto account payload value,
 sto ({name}_prefix ++ account) = Some payload ->
 decode_integer payload = OK (GInt value) ->
 {name}_binding sto account = OK (GInt (value + {offset_txt})).
Proof. intros sto account payload value Hstore Hdecode.
 unfold {name}_binding, getter_outcome, {name}_decode.
 rewrite Hstore, Hdecode. reflexivity. Qed.
Print Assumptions {name}_source_hit.
''')
        else:
            raise ValueError('Unknown projection kind: ' + kind)
    # The distinctness theorem is stated over the pinned prefix constants as a
    # set: several getters deliberately share one key prefix (the delegating
    # presence getters and their record projections read the same
    # PendingModuleCall key), so the definition list is deduplicated by byte
    # value and the kernel still checks that every distinct constant differs
    # from every other one.
    prefix_defs, seen_prefixes = [], set()

    def add_prefix(label, value):
        if tuple(value) in seen_prefixes:
            return
        seen_prefixes.add(tuple(value))
        prefix_defs.append((label, value))

    for name in sorted(methods):
        row = methods[name]['projection']
        value = row.get('prefixBytes')
        if value is not None:
            add_prefix('%s_prefix' % name, value)
        if row.get('kind', 'direct') in ('raw-call-presence', 'raw-call-offset'):
            # A delegating raw getter pins no prefix itself: the prefix is read
            # out of the shared reader's projection, and the binding defines it
            # under the caller's own name.
            callee = bound['callees'][row.get('callee') or CALLEE_KINDS[row['kind']]]
            add_prefix('%s_prefix' % name, callee['projection']['prefixBytes'])
    if 'state-field' in kinds.values() or 'state-gt-zero' in kinds.values():
        add_prefix('account_state_prefix',
                   bound['callee']['projection']['prefixBytes'])
    conj = ' /\\ '.join('%s ++ account <> %s ++ account' % (a, b)
                        for i, (a, _) in enumerate(prefix_defs)
                        for (b, _) in prefix_defs[i + 1:])
    if prefix_defs:
        out.append(f'Theorem getter_prefixes_distinct : forall account,\n {conj}.\n'
                   'Proof. intros account. repeat split; discriminate. Qed.\n'
                   'Print Assumptions getter_prefixes_distinct.\n')
    return ''.join(out)


VM_STEP_DELTA = ('nth Nat.eqb step storage_lookup pop popn pushv set_stack '
                 'set_locals set_statics set_calls mstack mlocals margs '
                 'mstatics msto mcalls mtokens gval_eqb gbytes_eqb '
                 'firstn skipn')

# Definitions a step lemma must keep folded when the compared value is the
# stuck deserialize-oracle application (see _record_step).
_FOLDED_BOOL_COMPARE = ('gval_eqb', 'gbytes_eqb')


class _Val(object):
    """A Coq GVal term on the simulated evaluation stack.

    term is the full GVal expression; inner is the bytes expression when
    term is a GBytes application (needed by CONCAT), else None.
    """

    def __init__(self, term, inner=None):
        self.term = term
        self.inner = inner


def _parse_z_literal(text):
    """'3%Z' / '3%nat' / '3' -> 3, else None."""
    t = text.strip()
    for suffix in ('%Z', '%nat'):
        if t.endswith(suffix):
            t = t[:-len(suffix)]
            break
    try:
        return int(t)
    except ValueError:
        return None


def _concrete_eqb(a, b):
    """'true'/'false' when gval_eqb a b is constructor-decidable, else None."""
    def head(t):
        return t.split(' ', 1)[0].split('(')[0]
    ha, hb = head(a), head(b)
    sorts = ('GBytes', 'GInt', 'GBool', 'GArray', 'GNull')
    if ha in sorts and hb in sorts and ha != hb:
        return 'false'
    if a == b:
        return 'true'
    if ha == 'GInt' == hb:
        xa = _parse_z_literal(a[len('GInt '):])
        xb = _parse_z_literal(b[len('GInt '):])
        if xa is not None and xb is not None:
            return 'true' if xa == xb else 'false'
    if ha == 'GBool' == hb:
        return 'false'
    if ha == 'GBytes' == hb:
        ya, yb = a[len('GBytes '):], b[len('GBytes '):]
        if ya.startswith('[') and yb.startswith('['):
            return 'true' if ya == yb else 'false'
    return None


def _decode_le(payload):
    """Pinned little-endian signed decode matching IntegerSemantics."""
    z = 0
    for i, b in enumerate(payload):
        z |= b << (8 * i)
    if payload and payload[-1] & 0x80:
        z -= 1 << (8 * len(payload))
    return z


def _stack_lit(stack):
    """Render the simulated stack as a Coq list: the head is the TOP.

    The VM model pops from the head of mstack, while the simulator appends
    pushes to the end of its Python list, so the emission reverses.
    """
    return '[' + '; '.join(v.term for v in reversed(stack)) + ']'


def _record_step(pc, nxt, needs, end, stack, locs, calls, opaque=None):
    """Snapshot one simulated step, including the full post-state.

    `opaque` names definitions the step lemma must NOT unfold. EQ/NEQ on the
    deserialize oracle are the only such steps: the model computes
    `gval_eqb a b` with `b` a stuck `tok` application, so normalizing
    `gval_eqb` would turn the hypothesis into an unlisted `match` that the
    caller's stated `gval_eqb ... = false` can no longer rewrite. Leaving
    `gval_eqb` (and `gbytes_eqb`) folded keeps the goal literal equal to the
    hypothesis, and the final `reflexivity` still computes the bool.
    """
    return dict(pc=pc, nxt=nxt, needs=needs, end=end, opaque=tuple(opaque or ()),
                post=dict(stack=[v.term for v in reversed(stack)],
                          locals=[v.term for v in locs],
                          calls=list(calls)))


def _simulate_trace(parts, static_term, seed, static_terms=None):
    """Walk one execution path of the rendered program.

    seed fixes the outcome of the hypothesis-dependent steps; each entry is
    (hyp_name, statement, pushed _Val) and its step lemma must rewrite the
    hypothesis before closing by reflexivity:
      storage    - System.Storage.Get result (miss GNull / hit GBytes payload).
      calltoken  - StdLib.Deserialize oracle result (hit GArray xs)
      pick       - PICKITEM projection result (hit v / GInt z)
      convert    - CONVERT 0x21 on a symbolic payload (decode contract)
      jmpeq      - JMPEQ on an undecidable width comparison (true/false)
    Every opcode must be covered; anything unexpected raises (fail closed).
    Returns (steps, end) with steps a list of dicts
    {pc, nxt, needs [(hyp, stmt)], setters [(kind, term)], end} and end
    None on intermediate steps, ('thrown',), or ('done', value_term).
    """
    pc, stack, locs, calls = 0, [], [], []
    lookups = [0]
    steps = []
    guard = 0
    while True:
        guard += 1
        require(guard <= 8 * len(parts) + 8, 'Trace simulation did not terminate')
        bits = parts[pc].split(' ', 1)
        op = bits[0]
        arg = bits[1] if len(bits) > 1 else ''
        needs = []
        setters = []
        nxt = pc + 1
        end = None
        opaque = ()
        old_terms = [v.term for v in stack]

        def stack_changed():
            return [v.term for v in stack] != old_terms

        if op == 'InitSlot':
            n = int(arg.split()[0])
            locs = [_Val('GNull')] * n
            setters.append(('locals', '[' + '; '.join(v.term for v in locs) + ']'))
        elif op == 'Push':
            inner = arg
            if inner.startswith('(') and inner.endswith(')'):
                inner = inner[1:-1]
            if inner.startswith('GInt ') and not inner.endswith('%Z'):
                inner += '%Z'
            if inner.startswith('GBytes ['):
                bytes_inner = inner[len('GBytes '):]
                payload = [_parse_z_literal(x)
                           for x in bytes_inner[1:-1].split(';')]
                if payload == [0] * 20:
                    # the pinned UInt160 default (hash160_default := zeros 20)
                    stack.append(_Val('GBytes hash160_default'))
                else:
                    stack.append(_Val(inner, bytes_inner))
            else:
                stack.append(_Val(inner))
        elif op == 'LdStatic':
            slot = int(arg)
            if static_terms and slot in static_terms:
                term, inner = static_terms[slot]
                stack.append(_Val(term, inner))
            else:
                stack.append(_Val('GBytes %s' % static_term, static_term))
        elif op == 'LdArg':
            stack.append(_Val('GBytes account', 'account'))
        elif op == 'LdArgN':
            # Only slot 1 is reachable: the lane places the pinned prefix
            # constant the caller passes at the certified CALL in that slot
            # (see _derive_call_args / build_program).
            index = int(arg)
            require(index == 1,
                    'Machine argument slot %d is outside the pinned call binding' % index)
            stack.append(_Val('GBytes %s' % static_term, static_term))
        elif op == 'LdLoc':
            stack.append(locs[int(arg)])
        elif op == 'StLoc':
            v = stack.pop()
            locs[int(arg)] = v
            setters.append(('stack', _stack_lit(stack)))
            setters.append(('locals', '[' + '; '.join(v.term for v in locs) + ']'))
        elif op == 'Concat':
            a = stack.pop()
            b = stack.pop()
            require(a.inner is not None and b.inner is not None,
                    'Concat on non-byte values')
            inner = '%s ++ %s' % (b.inner, a.inner)
            stack.append(_Val('GBytes (%s)' % inner, inner))
        elif op == 'Convert':
            v = stack.pop()
            if int(arg) == CONVERT_INTEGER:
                if v.inner is not None and v.inner.startswith('['):
                    payload = [_parse_z_literal(x) for x in v.inner[1:-1].split(';')]
                    require(all(x is not None for x in payload),
                            'Convert 21 on malformed concrete bytes')
                    stack.append(_Val('GInt %d%%Z' % _decode_le(payload)))
                else:
                    require('convert' in seed, 'Convert 21 without a decode seed')
                    needs.append(seed['convert'][:2])
                    stack.append(seed['convert'][2])
            else:
                require(v.inner is not None, 'Convert on a non-byte value')
                stack.append(_Val('GBytes %s' % v.inner, v.inner))
        elif op == 'NewBuffer':
            v = stack.pop()
            # Only the pinned zero-length allocation is reachable in the
            # certified regions: it is the compiled `(ByteString)new byte[0]`
            # empty default of the record-hash getters. Any other length would
            # be a different default, so it fails closed here instead of being
            # silently modelled.
            require(v.term == 'GInt 0%Z',
                    'NewBuffer is only modelled at the pinned zero-length default')
            stack.append(_Val('GBytes []', '[]'))
        elif op == 'GetContext':
            stack.append(_Val('GBytes [33%nat]', '[33%nat]'))
        elif op == 'StorageGet':
            ctx = stack.pop()
            stack.pop()  # key
            require(ctx.inner == '[33%nat]', 'Storage.Get context handle mismatch')
            require('storage' in seed, 'StorageGet without a seed')
            hyp, stmt, val = seed['storage']
            lookups[0] += 1
            require(lookups[0] == 1, 'Program performs more than one storage read')
            needs.append((hyp, stmt))
            stack.append(val)
        elif op == 'EqualIns':
            a = stack.pop()
            b = stack.pop()
            r = _concrete_eqb(a.term, b.term)
            if r is None:
                require('jmpeq' in seed or 'equal' in seed,
                        'EQUAL on an undecidable comparison without a seed')
                hyp, stmt, boolean = seed.get('equal') or seed['jmpeq']
                needs.append((hyp, stmt))
                opaque = _FOLDED_BOOL_COMPARE
                stack.append(_Val('GBool %s' % boolean))
            else:
                stack.append(_Val('GBool %s' % r))
        elif op == 'NotEqualIns':
            a = stack.pop()
            b = stack.pop()
            r = _concrete_eqb(a.term, b.term)
            if r is None:
                # Symbolic disequality (the deserialize oracle against null):
                # the step is fixed by a seed hypothesis the caller's theorem
                # carries, exactly like the EQUAL case.
                require('notequal' in seed,
                        'NOTEQUAL on an undecidable comparison without a seed')
                hyp, stmt, boolean = seed['notequal']
                needs.append((hyp, stmt))
                opaque = _FOLDED_BOOL_COMPARE
                stack.append(_Val('GBool %s' % boolean))
            else:
                stack.append(_Val('GBool %s' % ('true' if r == 'false' else 'false')))
        elif op == 'PickItem':
            idx = stack.pop()
            arr = stack.pop()
            require(arr.term.startswith('GArray'),
                    'PICKITEM on a non-array value')
            require('pick' in seed, 'PICKITEM without a seed')
            hyp, stmt, val = seed['pick']
            needs.append((hyp, stmt))
            stack.append(val)
        elif op == 'Greater':
            b = stack.pop()
            a = stack.pop()
            require(a.term.startswith('GInt') and b.term.startswith('GInt'),
                    'GT on non-integer values')
            za, zb = _parse_z_literal(a.term[len('GInt '):]), \
                _parse_z_literal(b.term[len('GInt '):])
            if za is not None and zb is not None:
                stack.append(_Val('GBool %s' % ('true' if zb < za else 'false')))
            else:
                za_txt = a.term[len('GInt '):]
                zb_txt = b.term[len('GInt '):]
                if za_txt.endswith('%Z'):
                    za_txt = za_txt[:-2]
                if zb_txt.endswith('%Z'):
                    zb_txt = zb_txt[:-2]
                stack.append(_Val('GBool (Z.ltb %s %s)' % (zb_txt, za_txt)))
        elif op == 'AddIns':
            b = stack.pop()
            a = stack.pop()
            require(a.term.startswith('GInt') and b.term.startswith('GInt'),
                    'ADD on non-integer values')
            za, zb = _parse_z_literal(a.term[len('GInt '):]), \
                _parse_z_literal(b.term[len('GInt '):])
            if za is not None and zb is not None:
                stack.append(_Val('GInt %d%%Z' % (za + zb)))
            elif za is None and zb is not None:
                stack.append(_Val('GInt (%s + %d%%Z)' % (_z_text(a.term), zb)))
            elif za is not None and zb is None:
                stack.append(_Val('GInt (%d%%Z + %s)' % (za, _z_text(b.term))))
            else:
                raise ValueError('ADD on two symbolic integers is not modeled')
        elif op == 'Pack':
            # PACK pops the count first and then that many values, each popped
            # value becoming the next array element — the value pushed last is
            # element 0. The compiled array literals push in reverse source
            # order, so element 0 of the result is the source's first element.
            # Only a concrete non-negative count is modelled; a symbolic count
            # would make the array shape depend on an unknown, so it fails
            # closed instead of being approximated.
            n = stack.pop()
            require(n.term.startswith('GInt'), 'PACK count is not an integer')
            count = _parse_z_literal(n.term[len('GInt '):])
            require(count is not None and count >= 0,
                    'PACK is only modelled on a concrete non-negative count')
            require(count <= len(stack),
                    'PACK pops more values than the stack holds')
            items = [stack.pop().term for _ in range(count)]
            stack.append(_Val('GArray [' + '; '.join(items) + ']'))
        elif op == 'IsType':
            # Only the pinned ByteString marker (0x28 = 40) is rendered by
            # render_vm_program. A value is a ByteString exactly when the model
            # carries it as GBytes: the symbolic account argument, every
            # storage payload and every concatenated key are GBytes, and each
            # other constructor is a different stack item type.
            require(arg == '40',
                    'ISTYPE marker outside the pinned ByteString contract: ' + arg)
            v = stack.pop()
            stack.append(_Val('GBool %s'
                              % ('true' if v.term.startswith('GBytes') else 'false')))
        elif op == 'NumEquals':
            b = stack.pop()
            a = stack.pop()
            require(a.term.startswith('GInt') and b.term.startswith('GInt'),
                    'NUMEQUAL on non-integer values')
            za, zb = _parse_z_literal(a.term[len('GInt '):]), \
                _parse_z_literal(b.term[len('GInt '):])
            if za is not None and zb is not None:
                stack.append(_Val('GBool %s' % ('true' if za == zb else 'false')))
            else:
                # A symbolic length against a pinned literal. Like the JMPEQ
                # width witness, the branch is fixed by a seed hypothesis the
                # generated theorem carries, never assumed silently.
                require('numequal' in seed,
                        'NUMEQUAL on an undecidable comparison without a seed')
                hyp, stmt, boolean = seed['numequal']
                require(stmt.startswith('Z.eqb %s %s ='
                                        % (a.term[len('GInt '):],
                                           b.term[len('GInt '):])),
                        'NUMEQUAL seed does not match the simulated comparison')
                needs.append((hyp, stmt))
                stack.append(_Val('GBool %s' % boolean))
        elif op == 'CallToken':
            value = stack.pop()
            require('calltoken' in seed, 'CALLT without a seed')
            entry = seed['calltoken']
            if entry[0] is None:
                # The oracle result is already the term the model computes
                # (mtokens is the `tok` parameter), so no rewrite is needed.
                stack.append(entry[1])
            else:
                hyp, stmt, val = entry
                needs.append((hyp, stmt))
                stack.append(val)
        elif op == 'Dup':
            stack.append(stack[-1])
        elif op == 'Drop':
            stack.pop()
        elif op == 'IsNull':
            v = stack.pop()
            require(v.term in ('GNull',) or v.term.startswith('GBytes'),
                    'ISNULL on an unmodeled value')
            stack.append(_Val('GBool %s' % ('true' if v.term == 'GNull' else 'false')))
        elif op == 'SizeIns':
            v = stack.pop()
            if v.inner is not None and v.inner.startswith('['):
                n = len([x for x in v.inner[1:-1].split(';') if x])
                stack.append(_Val('GInt %d%%Z' % n))
            elif v.term == 'GBytes payload':
                stack.append(_Val('GInt (Z.of_nat (length payload))'))
            elif v.term.startswith('GBytes ') and v.inner is not None:
                # Any other symbolic byte value (the account argument, a
                # concatenated key): its length stays symbolic, and a
                # comparison against a pinned width is decided by a seed
                # instead of being assumed.
                stack.append(_Val('GInt (Z.of_nat (length %s))' % v.inner))
            else:
                raise ValueError('SIZE on an unmodeled value: ' + v.term)
        elif op == 'Jump':
            nxt = int(arg)
        elif op == 'JumpIfNot':
            b = stack.pop()
            require(b.term in ('GBool true', 'GBool false'),
                    'JMPIFNOT on an undecidable condition')
            nxt = int(arg) if b.term == 'GBool false' else pc + 1
        elif op == 'JumpIf':
            b = stack.pop()
            require(b.term in ('GBool true', 'GBool false'),
                    'JMPIF on an undecidable condition')
            nxt = int(arg) if b.term == 'GBool true' else pc + 1
        elif op == 'JumpEq':
            b = stack.pop()
            a = stack.pop()
            require(a.term.startswith('GInt') and b.term.startswith('GInt'),
                    'JMPEQ on non-integer values')
            za, zb = _parse_z_literal(a.term[len('GInt '):]), \
                _parse_z_literal(b.term[len('GInt '):])
            if za is not None and zb is not None:
                taken = za == zb
            else:
                require('jmpeq' in seed, 'JMPEQ without a width seed')
                hyp, stmt, boolean = seed['jmpeq']
                require(stmt.startswith('Z.eqb %s %s =' % (a.term[len('GInt '):],
                                                           b.term[len('GInt '):])),
                        'JMPEQ seed does not match the simulated comparison')
                needs.append((hyp, stmt))
                taken = boolean == 'true'
            nxt = int(arg) if taken else pc + 1
        elif op == 'Call':
            calls.append(pc + 1)
            nxt = int(arg)
        elif op == 'Ret':
            if calls:
                nxt = calls.pop()
            else:
                end = ('done', stack[-1].term)
                steps.append(_record_step(pc, nxt, needs, end, stack, locs,
                                          calls))
                break
        elif op in ('Throw', 'AbortMsg'):
            end = ('thrown',)
            steps.append(_record_step(pc, nxt, needs, end, stack, locs,
                                      calls))
            break
        elif op == 'Unsupported':
            end = ('thrown',)
            steps.append(_record_step(pc, nxt, needs, end, stack, locs,
                                      calls))
            break
        else:
            raise ValueError('Unhandled opcode in trace simulation: ' + op)
        steps.append(_record_step(pc, nxt, needs, None, stack, locs, calls,
                                  opaque=opaque))
        pc = nxt

    return steps, (steps[-1]['end'] if steps else None)


def _fold_state(prev, setters):
    term = prev
    for kind, text in setters:
        fn = {'stack': 'set_stack', 'locals': 'set_locals',
              'calls': 'set_calls'}[kind]
        term = '%s %s (%s)' % (fn, text, term)
    return term


def _compose_apps(apps):
    t = apps[-1]
    for a in reversed(apps[:-1]):
        t = 'eq_trans (%s) (%s)' % (a, t)
    return t


def _z_text(term):
    """'GInt 3%Z' -> '3'; the term body of an integer stack value."""
    text = term[len('GInt '):]
    return text[:-len('%Z')] if text.endswith('%Z') else text


def _wrap_done(value):
    if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', value):
        return 'Done %s' % value
    return 'Done (%s)' % value


def _render_trace_chain(ident, tag, parts, static_term, params_decl, params,
                        init_args, seed, machine_args='[GBytes account]',
                        static_terms=None):
    """Render one trace as a chain of per-step definitions and lemmas.

    Each step becomes a top-level machine definition (M_i, shared by the
    kernel) plus a one-step equation lemma (t_i). Simple steps close by
    reflexivity over a single run unfolding; steps whose outcome is fixed
    only by a hypothesis rewrite run_S once, normalize within a delta that
    excludes run and the rewrite target, rewrite, and close. Returns
    (module_text, lemma_applications, end_value_term).
    """
    steps, end = _simulate_trace(parts, static_term, seed, static_terms)
    require(steps and end is not None, 'Empty trace for ' + ident)
    fuel = len(parts) + 2
    base = '%s_%s' % (ident, tag)
    mnames = ['M%d_%s' % (i, base) for i in range(len(steps) + 1)]
    tnames = ['t%d_%s' % (i, base) for i in range(len(steps))]
    mtok = 'tok' if '(tok :' in params_decl else '(fun _ _ => GNull)'
    out = []
    out.append('Definition %s %s : Machine :=\n %s %s.\n'
               % (mnames[0], params_decl, ident + '_init', init_args))
    # Successor machines are emitted as FLAT records (every field a literal
    # or a parameter): projections are O(1) and never cascade through a
    # set_wrapper chain, which is what made the chained representation
    # super-linear for the kernel.
    for i, st in enumerate(steps):
        post = st['post']
        mcalls = '[' + '; '.join('%d%%nat' % c for c in post['calls']) + ']'
        out.append('Definition %s %s : Machine :=\n'
                   ' {| mstack := %s; mlocals := %s; margs := %s;\n'
                   '    mstatics := %s_statics; msto := sto; mcalls := %s;\n'
                   '    mtokens := %s |}.\n'
                   % (mnames[i + 1], params_decl,
                      '[' + '; '.join(post['stack']) + ']',
                      '[' + '; '.join(post['locals']) + ']',
                      machine_args,
                      ident, mcalls, mtok))
    apps = []
    for i, st in enumerate(steps):
        f = fuel - i
        lhs = 'run %d %d %s_code (%s)' % (f, st['pc'], ident, '%s %s' % (mnames[i], params))
        if st['end'] is None:
            rhs = 'run %d %d %s_code (%s)' % (
                f - 1, st['nxt'], ident, '%s %s' % (mnames[i + 1], params))
            eq = '%s =\n %s' % (lhs, rhs)
        elif st['end'][0] == 'thrown':
            eq = '%s = Thrown' % lhs
        else:
            eq = '%s = %s' % (lhs, _wrap_done(st['end'][1]))
        # Every step lemma unfolds exactly one run level via run_S and
        # normalizes within a delta that names only the CURRENT (flat)
        # machine, never run itself. A bare reflexivity on the raw equation
        # makes the unifier chase both sides in lockstep through the whole
        # trace (the fuels differ by one, so it never locks onto matching
        # arguments) and hangs.
        delta = VM_STEP_DELTA
        if st.get('opaque'):
            kept = [d for d in delta.split() if d not in st['opaque']]
            require(len(kept) == len(delta.split()) - len(st['opaque']),
                    'Opaque step names a delta entry that is not present')
            delta = ' '.join(kept)
        close = (' rewrite run_S.\n'
                 ' cbn [%s %s_init %s_code %s_program %s].\n'
                 % (mnames[i], ident, ident, ident, delta))
        if st['needs']:
            close += ''.join(' rewrite %s.\n' % h for h, _ in st['needs'])
        close += ' reflexivity.'
        binders = params_decl
        for h, s in st['needs']:
            binders += ' (%s : %s)' % (h, s)
        intro = params + ''.join(' %s' % h for h, _ in st['needs'])
        out.append('Lemma %s : forall %s,\n %s.\nProof.\n intros %s.\n%s\nQed.\n'
                   'Print Assumptions %s.\n'
                   % (tnames[i], binders, eq, intro, close, tnames[i]))
        applied = '%s %s%s' % (tnames[i], params,
                               ''.join(' %s' % h for h, _ in st['needs']))
        apps.append(applied)
    end_val = 'Thrown' if end[0] == 'thrown' else _wrap_done(end[1])
    return '\n'.join(out), apps, end_val



VM_DRIVE_MUT = '''Ltac vm_drive_mut :=
  repeat (first
    [ progress (rewrite run_S)
    | progress cbn [{codes} {programs} {statics} fixture_storage bytes_eqb
                    tok nth Nat.eq_dec Nat.eqb step storage_lookup pop popn
                    pushv set_stack set_locals set_statics set_calls mstack
                    mlocals margs mstatics msto mcalls mtokens gval_eqb
                    gbytes_eqb gval_size repeat firstn skipn nth_error app
                    Z.eqb Z.ltb Z.to_nat negb andb] ]).
'''


def _vm_ident(name):
    return re.sub(r'[^A-Za-z0-9_]', '_', name) + '_vm'


def _region_rows(bound, decoded_rows, entry):
    return [r for r in decoded_rows
            if entry['start'] <= r['offset'] < entry['endExclusive']]


def _callee_nparams(callee_rows):
    """Read the parameter count a callee region declares in its INITSLOT."""
    require(callee_rows and callee_rows[0]['name'] == 'INITSLOT',
            'Callee region must start at its INITSLOT')
    operand = bytes.fromhex(callee_rows[0]['operandHex'])
    require(len(operand) == 2, 'Unexpected callee INITSLOT shape')
    return operand[1]


def _derive_call_args(parts, nparams):
    """Bind a callee's parameters to the caller's pre-CALL operand block.

    The certified CALL passes exactly the `nparams` operand values the caller
    pushes immediately before it. NeoVM assigns parameter j the (nparams-1-j)-th
    of those pushes (the top of the stack is parameter 0), so the binding is
    read off the caller program and never guessed: LDARG0 supplies machine
    argument slot 0 (the ABI account argument) and LDSFLD supplies the pinned
    prefix constant, which the tracer places in machine argument slot 1. Any
    other operand shape (a computed key, a literal, a second call) fails
    closed instead of being approximated.
    """
    require(parts.count('Call CALLEE') == 1, 'Expected exactly one certified CALL')
    index = parts.index('Call CALLEE')
    require(nparams >= 1 and index >= nparams,
            'Callee parameter block does not fit the caller program')
    sources = []
    for part in parts[index - nparams:index]:
        if part == 'LdArg':
            sources.append('LdArg')
        elif part.startswith('LdStatic '):
            sources.append('LdArgN 1')
        else:
            raise ValueError('Unmodeled call operand before the certified CALL: ' + part)
    return [sources[nparams - 1 - j] for j in range(nparams)]


def build_program(bound, decoded_rows, name):
    """Render (parts, nlocals, static_slots, cast_width) for one getter program.

    Callee-delegating getters (state projections and delegating presence
    getters) are combined with the program of the callee their kind binds;
    the caller's operand block before the CALL is pinned to the callee's
    parameter list (_derive_call_args). The runner cross-checks the rendered
    bytecode against the source-level field ordinal (PICKITEM index),
    comparison shape and null test here, fail closed. cast_width is the
    PUSHINT8 witness of the UInt160 cast (direct hash160 getters only).
    """
    entry = bound['methods'][name]
    row = entry['projection']
    kind = row.get('kind', 'direct')
    rows = _region_rows(bound, decoded_rows, entry)
    require(rows, 'Empty region for ' + name)
    cast_width = None
    if kind in CALLEE_KINDS:
        callee_name = row.get('callee') or CALLEE_KINDS[kind]
        callee_entry = bound['callees'][callee_name]
        callee_rows = _region_rows(bound, decoded_rows, callee_entry)
        caller_parts, caller_meta = render_vm_program(
            rows, callee_start=callee_entry['start'])
        call_args = _derive_call_args(caller_parts, _callee_nparams(callee_rows))
        callee_parts, callee_meta = render_vm_program(
            callee_rows, token_index=DESERIALIZE_TOKEN_INDEX, call_args=call_args)
        # The combined table holds the caller's own prefix field (when its
        # projection pins one), the delay constant it adds (same condition) and
        # the callee's own prefix field, so the bound is derived from the two
        # projections and the disjointness of the frames is still enforced by
        # combine_program.
        static_limit = ((1 if 'prefixBytes' in row else 0)
                        + (1 if 'offset' in row else 0)
                        + (1 if 'prefixBytes' in callee_entry['projection'] else 0))
        parts, nlocals, statics = combine_program(
            caller_parts, caller_meta, callee_parts, callee_meta,
            static_limit=static_limit)
        call_indices = [i for i, p in enumerate(parts) if p.startswith('Call ')]
        require(len(call_indices) == 1, 'Expected exactly one call in ' + name)
        ci = call_indices[0]
        if kind == 'state-field':
            require(parts[ci + 1] == 'Push (GInt %d)' % row['fieldIndex'] and
                    parts[ci + 2] == 'PickItem',
                    'Bytecode field projection disagrees with the source ordinal: ' + name)
            require(parts[ci + 3] != 'Greater', 'Unexpected comparison: ' + name)
        elif kind == 'state-gt-zero':
            require(parts[ci + 1] == 'Push (GInt %d)' % row['fieldIndex'] and
                    parts[ci + 2] == 'PickItem',
                    'Bytecode field projection disagrees with the source ordinal: ' + name)
            require(parts[ci + 3] == 'Push (GInt 0)' and parts[ci + 4] == 'Greater',
                    'Expected the > 0 comparison shape: ' + name)
        elif kind == 'presence-call':
            require(parts[ci + 1] == 'Push GNull' and parts[ci + 2] == 'NotEqualIns',
                    'Delegating presence region must test the callee result against null: '
                    + name)
        elif kind == 'raw-call-presence':
            # `return <raw reader>(accountId) != null;`: the same null test
            # as the pending-module-call presence getters, but the shared
            # reader owns the prefix and the caller declares no static field
            # at all.
            require(not caller_meta['static_slots'],
                    'Delegating raw presence getter must pin no static field'
                    ' of its own: ' + name)
            # The prefix lives in the shared reader, so the caller's own
            # projection must claim neither a prefix nor a decode contract.
            # Claiming one would make the pinned static inventory disagree
            # with the region the projection is read as.
            require(not any(key in row for key in ('prefixBytes', 'offset', 'decode')),
                    'Delegating raw presence getter must declare no prefix or'
                    ' decode of its own: ' + name)
            require(parts[ci + 1] == 'Push GNull' and parts[ci + 2] == 'NotEqualIns',
                    'Delegating raw presence region must test the callee result'
                    ' against null: ' + name)
        elif kind == 'raw-call-offset':
            # `initiated = <raw reader>(accountId); return initiated == null
            #  ? 0 : (BigInteger)initiated + <pinned delay>;`. The hit arm is the
            # framework reference cast of the raw payload, so the checked shape is
            # the null test, the pinned integer miss arm, the cast sequence and
            # the trailing static load the region ADDs. No PICKITEM appears: the
            # reader returns the payload itself rather than a record.
            require(row['decode'] == 'integer' and
                    row['default'] == {'kind': 'integer', 'value': 0},
                    'Raw epoch projection must default to the pinned integer: ' + name)
            # As for the presence delegator, the prefix belongs to the shared
            # reader: the caller owns the decode and the delay constant only.
            require('prefixBytes' not in row,
                    'Delegating raw epoch getter must declare no prefix of its'
                    ' own: ' + name)
            require(parts[ci + 1:ci + 5] == ['StLoc 0', 'LdLoc 0', 'Push GNull',
                                            'EqualIns'],
                    'Raw epoch region must store the reader result and test it'
                    ' against null: ' + name)
            require(parts[ci + 5].startswith('JumpIfNot '),
                    'Raw epoch region must branch on the null test: ' + name)
            arm = int(parts[ci + 5].split()[1])
            require(parts[ci + 6] == 'Push (GInt 0)',
                    'Raw epoch miss arm must be the pinned integer default: ' + name)
            require(parts[arm:arm + 3] == ['LdLoc 0', 'Dup', 'IsNull'],
                    'Raw epoch hit arm must cast the raw payload: ' + name)
            adds = [i for i, p in enumerate(parts) if p == 'AddIns']
            require('offset' in row and len(adds) == 1 and
                    parts[adds[0] - 1].startswith('LdStatic ') and
                    parts[adds[0] - 2] == 'Convert %d' % CONVERT_INTEGER,
                    'Raw epoch region must add the pinned delay to the decoded'
                    ' payload: ' + name)
        else:
            require(kind == 'presence-call-item', 'Unknown callee kind: ' + kind)
            # `pending = callee(...); return pending == null ? <default> :
            #  pending.<field> [ + <pinned delay> ];` compiles to a store of
            # the callee result, a null test and a two-arm branch. Every arm
            # claim is checked against the extracted projection: the null test
            # opcode, the source field ordinal against the PICKITEM index, the
            # source default against the branch literal, and the pinned delay
            # against the trailing static load plus ADD.
            require(parts[ci + 1:ci + 5] == ['StLoc 0', 'LdLoc 0', 'Push GNull',
                                            'EqualIns'],
                    'Delegating record region must store the callee result and test it'
                    ' against null: ' + name)
            require(parts[ci + 5].startswith('JumpIfNot '),
                    'Delegating record region must branch on the null test: ' + name)
            arm = int(parts[ci + 5].split()[1])
            require(parts[arm:arm + 3] == ['LdLoc 0',
                                           'Push (GInt %d)' % row['itemIndex'],
                                           'PickItem'],
                    'Bytecode record projection disagrees with the source field ordinal: '
                    + name)
            if row['decode'] == 'hash160':
                require(row['default'] == {'kind': 'bytes', 'value': [0] * 20} and
                        parts[ci + 6] == 'Push (GBytes ['
                        + ';'.join(['0%nat'] * 20) + '])',
                        'Record default disagrees with the extracted default: ' + name)
                require('offset' not in row,
                        'Hash160 record projection must not carry a delay constant: ' + name)
            elif row['decode'] == 'raw-bytes':
                # `(ByteString)new byte[0]` compiles to PUSH0; NEWBUFFER;
                # CONVERT 0x28 (Buffer -> ByteString), i.e. a zero-length
                # allocation followed by the identity cast, so the null branch
                # is three instructions rather than one push literal.
                require(row['default'] == {'kind': 'empty-bytes'} and
                        parts[ci + 6:ci + 9] == ['Push (GInt 0)', 'NewBuffer',
                                                 'Convert %d' % CONVERT_BYTESTRING],
                        'Record empty-bytes default disagrees with the extracted default: '
                        + name)
                require('offset' not in row,
                        'Empty-bytes record projection must not carry a delay constant: '
                        + name)
            else:
                require(row['decode'] == 'integer' and
                        row['default'] == {'kind': 'integer', 'value': 0} and
                        parts[ci + 6] == 'Push (GInt 0)',
                        'Record default disagrees with the extracted default: ' + name)
                require('offset' in row and parts[arm + 3].startswith('LdStatic ') and
                        parts[arm + 4] == 'AddIns',
                        'Record Time projection must add the pinned delay constant: '
                        + name)
    else:
        # Only the inline epoch getters carry a CALLT without delegating: their
        # region deserializes in place, so the pinned token index is passed for
        # that kind alone and every other non-delegating region keeps failing
        # closed on any token call it should not contain.
        parts, meta = render_vm_program(
            rows,
            token_index=(DESERIALIZE_TOKEN_INDEX
                         if kind == 'inline-record-time' else None))
        require(not meta['calls'], 'Unexpected call in a non-projection region: ' + name)
        nlocals = meta['nlocals']
        statics = meta['static_slots']
        cast_width = meta['cast_width']
        if kind == 'presence':
            require('NotEqualIns' in parts, 'Presence region must test against null: ' + name)
        if kind == 'direct-fixed-offset':
            require(sum(1 for p in parts if p.startswith('LdStatic ')) == 2 and
                    'AddIns' in parts,
                    'Offset getter region must add the pinned delay constant: ' + name)
        if kind == 'inline-record-time':
            # The inline twin of the delegating Time getters: the region builds
            # the key itself, reads once, guards with an early return of the
            # pinned integer default, deserializes through the pinned token and
            # projects one record field, then adds the pinned delay constant in
            # that field arm. Every claim the source-level projection asserts is
            # re-checked here against the rendered program: the single
            # concatenation and read, the single null test, the single token
            # call, the PICKITEM ordinal derived from the record declaration and
            # the delay static the region adds.
            require('offset' in row,
                    'Inline epoch projection must carry a delay constant: ' + name)
            require(parts.count('Concat') == 1 and parts.count('StorageGet') == 1 and
                    parts.count('CallToken %d' % DESERIALIZE_TOKEN_INDEX) == 1,
                    'Inline epoch region must concat, read and deserialize exactly once: '
                    + name)
            require(parts.count('EqualIns') == 1 and parts.count('Push GNull') == 1,
                    'Inline epoch region must test the read result against null once: ' + name)
            picks = [i for i, p in enumerate(parts) if p == 'PickItem']
            require(len(picks) == 1 and
                    parts[picks[0] - 1] == 'Push (GInt %d)' % row['itemIndex'],
                    'Bytecode record projection disagrees with the source field ordinal: '
                    + name)
            adds = [i for i, p in enumerate(parts) if p == 'AddIns']
            require(len(adds) == 1 and adds[0] == picks[0] + 2 and
                    parts[adds[0] - 1].startswith('LdStatic ') and
                    parts[adds[0] + 1].startswith('Jump '),
                    'Inline epoch region must add the pinned delay in its field arm: ' + name)
    return parts, nlocals, statics, cast_width


def _static_plan(bound, name, parts):
    """Return [(slot, role), ...] for one program's pinned static fields.

    Roles are assigned per frame, never by raw program position:
      delay   the load the program ADDs (so a delay that drifted into another
              slot is refused instead of being relabelled);
      prefix  the caller's own prefix field, or the callee's one.
    The expected role set is read off the projections (caller and, when the
    kind delegates, callee), and the number of loads must match it exactly, so
    an unmodelled extra static fails closed instead of being ignored. The
    delegating epoch kinds place the caller's delay *ahead* of the callee
    region, which is why the delay role is located by what the load feeds
    into rather than by where it appears.
    """
    entry = bound['methods'][name]
    row = entry['projection']
    kind = row.get('kind', 'direct')
    callee = bound['callees'].get(entry['calleeName']) if entry['calleeName'] else None
    loads = [i for i, p in enumerate(parts) if p.startswith('LdStatic ')]
    calls = [i for i, p in enumerate(parts) if p.startswith('Call ')]
    split = int(parts[calls[0]][len('Call '):]) if calls else len(parts)
    delays = [i for i in loads if i + 1 < len(parts) and parts[i + 1] == 'AddIns']
    require(len(delays) <= 1, 'Program must add at most one pinned delay: ' + name)
    expected = 0
    for source in (row, callee['projection'] if callee else None):
        if source is None:
            continue
        expected += 1 if 'prefixBytes' in source else 0
    if 'offset' in row:
        expected += 1
    require(len(loads) == expected,
            'Program must load exactly %d pinned static field(s): %s' % (expected, name))
    if 'offset' in row:
        require(len(delays) == 1, 'Offset projection must load an added delay: ' + name)
    else:
        require(not delays, 'Program must not add an unmodelled delay: ' + name)
    roles = []
    delay_slot = delays[0] if 'offset' in row else None
    if delay_slot is not None:
        roles.append((int(parts[delay_slot][len('LdStatic '):]), 'delay'))
    caller = [i for i in loads if i < split and i != delay_slot]
    if 'prefixBytes' in row:
        require(len(caller) == 1, 'Caller frame must load exactly its own prefix: ' + name)
        roles.append((int(parts[caller[0]][len('LdStatic '):]), 'prefix'))
    else:
        # The caller pins no prefix of its own: the frame the certified CALL
        # enters owns the key, either from the pinned constant the caller
        # passes as an operand (the record reader) or from its own static
        # field (the state reader, the escrow owner-cancel reader).
        require(callee is not None and 'prefixBytes' in callee['projection'],
                'Missing the prefix load: ' + name)
        require(not caller, 'Caller frame must not load a prefix it does not pin: ' + name)
        callee_loads = [i for i in loads if i >= split and i != delay_slot]
        require(len(callee_loads) == 1,
                'Callee frame must load exactly its own prefix: ' + name)
        roles.append((int(parts[callee_loads[0]][len('LdStatic '):]), 'prefix'))
    slots = [slot for slot, _ in roles]
    require(len(set(slots)) == len(slots), 'Pinned static roles must use distinct slots: ' + name)
    require(set(slots) == set(int(p[len('LdStatic '):]) for p in parts
                             if p.startswith('LdStatic ')),
            'Unassigned static load in ' + name)
    # Canonical role order: the rendered table must depend on WHICH roles a
    # program pins, not on the order its loads happen to appear in (the
    # delegating epoch getter loads its own delay ahead of the callee region),
    # so the roles are re-emitted prefix first, delay second.
    slot_of = {role: slot for slot, role in roles}
    return [(slot_of[role], role) for role in ('prefix', 'delay')
            if role in slot_of]


def _static_term(bound, name, role):
    """Coq term for one static role of a program, from the pinned projections."""
    entry = bound['methods'][name]
    row = entry['projection']
    kind = row.get('kind', 'direct')
    if role == 'delay':
        return 'GInt %d%%Z' % row['offset']
    if kind in ('state-field', 'state-gt-zero'):
        return 'GBytes account_state_prefix'
    return 'GBytes %s_prefix' % name


def _statics_definition(ident, roles, terms):
    """Render the pinned static-field table for one program.

    The first arm sits on the `fun i =>` line and every further arm continues
    an indented `else if`, so a program pinning a single prefix renders on one
    line and the two-role timelock getters render both arms. The arm order is
    the canonical role order `_static_plan` returns, never a program's load
    order.
    """
    require(roles, 'A program must pin at least one static field')
    lines = ['Definition %s_statics : nat -> option GVal :=' % ident]
    for index, (slot, role) in enumerate(roles):
        intro = ' fun i => ' if index == 0 else ' ' * 10
        keyword = 'if' if index == 0 else 'else if'
        lines.append('%s%s Nat.eqb i %d then Some (%s)'
                     % (intro, keyword, slot, terms[role]))
    lines[-1] += ' else None.'
    return '\n'.join(lines) + '\n'


def render_vm_certificate(bound, decoded_rows):
    """Render the bytecode-level trace certificate for all pinned getters.

    Programs are rendered from the decoded instructions (slot discipline,
    see render_vm_program; state projections embed the shared callee
    program, see build_program). Each reachable behavior class is simulated
    in Python (_simulate_trace) and rendered as a chain of per-step machine
    definitions and one-step equation lemmas composed with eq_trans, so the
    kernel checks many small conversions instead of one ever-growing
    rewrite chain (a single vm_drive_all chain did not compile past ~30
    steps: Qed re-checks each eq_ind link against the symbolic machine and
    the cost explodes). Every theorem additionally asserts agreement
    between the VM execution result and the source-level outcome; the
    deserialize token is universally quantified.
    """
    definitions, theorems = [], []
    vm_modules = []
    for name in sorted(bound['methods']):
        entry = bound['methods'][name]
        row = entry['projection']
        kind = row.get('kind', 'direct')
        parts, nlocals, static_slots, cast_width = build_program(bound, decoded_rows, name)
        ident = _vm_ident(name)
        fuel = len(parts) + 2
        definitions.append(
            'Definition %s_program : list Ins :=\n [%s].\n'
            % (ident, '; '.join(parts)))
        definitions.append(
            'Definition %s_code (pc : nat) : Ins := nth pc %s_program Unsupported.\n'
            % (ident, ident))
        roles = _static_plan(bound, name, parts)
        require(set(static_slots) == set(slot for slot, _ in roles),
                'Rendered static inventory disagrees with the bound region: ' + name)
        terms = {role: _static_term(bound, name, role) for _, role in roles}
        prefix_name = terms['prefix'][len('GBytes '):]
        static_terms = {}
        for slot, role in roles:
            inner = None
            if role == 'prefix':
                inner = prefix_name
            static_terms[slot] = (terms[role], inner)
        definitions.append(_statics_definition(ident, roles, terms))
        init_args = '(sto : storage) (account : bytes)'
        init_apply = 'sto account'
        init_margs = '[GBytes account]'
        if kind in ('direct-fixed', 'direct-fixed-offset'):
            # Fixed-prefix getters take no ABI parameter: the traced entry
            # state has an empty argument array, matching the runner's bind.
            init_args = '(sto : storage)'
            init_apply = 'sto'
            init_margs = '[]'
        if kind in ORACLE_KINDS:
            init_args = ('(tok : nat -> GVal -> GVal) (sto : storage)'
                         ' (account : bytes)')
            init_apply = 'tok sto account'
        if kind in CALLEE_KINDS:
            # The traced entry state carries the argument vector the caller
            # actually builds at the certified CALL. A two-parameter callee
            # (the record reader) is bound to [account; pinned prefix] exactly
            # as before; a one-parameter callee (the raw owner-cancel reader)
            # takes the ABI account argument alone and pins its own prefix
            # itself.
            nparams = bound['callees'][row.get('callee') or CALLEE_KINDS[kind]]['nparams']
            require(nparams in (1, 2), 'Unsupported shared callee arity: ' + name)
            if nparams == 2:
                init_margs = '[GBytes account; GBytes %s]' % prefix_name
        definitions.append(
            'Definition %s_init %s : Machine :=\n'
            ' machine [] (repeat GNull %d) %s %s_statics sto [] %s.\n'
            % (ident, init_args, nlocals, init_margs, ident,
               'tok' if kind in ORACLE_KINDS
               else '(fun _ _ => GNull)'))
        chain_defs = []

        def render_chain(tag, extra_decl, extra_params, seed, expected_end):
            decl = init_args + (' ' + extra_decl if extra_decl else '')
            prm = init_apply + (' ' + extra_params if extra_params else '')
            text, apps, end_val = _render_trace_chain(
                ident, tag, parts, prefix_name, decl, prm, init_apply, seed,
                machine_args=init_margs, static_terms=static_terms)
            require(end_val == expected_end,
                    'Simulated %s end %r disagrees with the pinned end %r for %s'
                    % (tag, end_val, expected_end, name))
            chain_defs.append(text)
            return _compose_apps(apps)

        offset_kind = kind == 'direct-fixed-offset'
        if kind in ('direct', 'direct-fixed', 'direct-fixed-offset', 'direct-raw'):
            if kind in ('direct-fixed', 'direct-fixed-offset'):
                # No ABI parameter: the key is the prefix constant itself, and
                # the source-side outcome is instantiated at an empty account
                # suffix (pfx ++ [] = pfx).
                key_expr = prefix_name
                quant = 'sto'
                init_call = '(%s_init sto)' % ident
                ac_arg = '[]'
                src_rw = 'app_nil_r, '
            else:
                key_expr = prefix_name + ' ++ account'
                quant = 'sto account'
                init_call = '(%s_init sto account)' % ident
                ac_arg = 'account'
                src_rw = ''
            if offset_kind:
                # The artifact defines <name>_decode as the integer decode
                # followed by the pinned delay constant, so the shared
                # getter_outcome keeps its meaning.
                offset_txt = '%d%%Z' % row['offset']
                default_val = '(GInt 0%Z)'
                decode = name + '_decode'
            elif kind == 'direct-raw':
                # The artifact defines <name>_decode as the verbatim payload
                # cast; the pinned default is the empty string constant.
                default_val = '(GBytes [])'
                decode = name + '_decode'
            elif row['decode'] == 'hash160':
                default_val = '(GBytes hash160_default)'
                decode = 'decode_hash160'
            else:
                default_val = '(GInt %d%%Z)' % row['default']['value']
                decode = 'decode_integer'
            miss_chain = render_chain(
                'miss', '', '',
                {'storage': ('Hstore', 'sto (%s) = None' % key_expr,
                             _Val('GNull'))},
                'Done ' + default_val)
            theorems.append(
                'Theorem %(n)s_vm_miss : forall %(q)s,\n'
                ' sto (%(k)s) = None ->\n'
                ' run %(f)d 0 %(id)s_code %(ic)s = Done %(dv)s /\\\n'
                ' getter_outcome %(p)s %(dv)s %(dec)s sto %(ac)s = OK %(dv)s.\n'
                'Proof.\n'
                ' intros %(q)s Hstore. split.\n'
                ' - exact (%(chain)s).\n'
                ' - unfold getter_outcome. rewrite %(srw)sHstore. reflexivity.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_miss.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   'dv': default_val, 'dec': decode, 'chain': miss_chain,
                   'q': quant, 'k': key_expr, 'ic': init_call,
                   'ac': ac_arg, 'srw': src_rw})
            if offset_kind:
                hit_chain = render_chain(
                    'hitoff', '(payload : bytes) (value : Z)', 'payload value',
                    {'storage': ('Hstore', 'sto (%s) = Some payload' % key_expr,
                                 _Val('GBytes payload', 'payload')),
                     'convert': ('Hdecode', 'decode_integer payload = OK (GInt value)',
                                 _Val('GInt value'))},
                    'Done (GInt (value + %s))' % offset_txt)
                theorems.append(
                    'Theorem %(n)s_vm_hit_offset : forall %(q)s payload value,\n'
                    ' sto (%(k)s) = Some payload ->\n'
                    ' decode_integer payload = OK (GInt value) ->\n'
                    ' run %(f)d 0 %(id)s_code %(ic)s'
                    ' = Done (GInt (value + %(o)s)) /\\\n'
                    ' getter_outcome %(p)s %(dv)s %(dec)s sto %(ac)s'
                    ' = OK (GInt (value + %(o)s)).\n'
                    'Proof.\n'
                    ' intros %(q)s payload value Hstore Hdecode. split.\n'
                    ' - exact (%(chain)s).\n'
                    ' - unfold getter_outcome, %(dec)s.\n'
                    '   rewrite %(srw)sHstore, Hdecode. reflexivity.\n'
                    'Qed.\n'
                    'Print Assumptions %(n)s_vm_hit_offset.\n'
                    % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                       'dv': default_val, 'dec': decode, 'o': offset_txt,
                       'chain': hit_chain, 'q': quant, 'k': key_expr,
                       'ic': init_call, 'ac': ac_arg, 'srw': src_rw})
            elif kind == 'direct-raw':
                hit_chain = render_chain(
                    'hitraw', '(payload : bytes)', 'payload',
                    {'storage': ('Hstore', 'sto (%s) = Some payload' % key_expr,
                                 _Val('GBytes payload', 'payload'))},
                    'Done (GBytes payload)')
                theorems.append(
                    'Theorem %(n)s_vm_hit : forall %(q)s payload,\n'
                    ' sto (%(k)s) = Some payload ->\n'
                    ' run %(f)d 0 %(id)s_code %(ic)s = Done (GBytes payload) /\\\n'
                    ' getter_outcome %(p)s %(dv)s %(dec)s sto %(ac)s'
                    ' = OK (GBytes payload).\n'
                    'Proof.\n'
                    ' intros %(q)s payload Hstore. split.\n'
                    ' - exact (%(chain)s).\n'
                    ' - unfold getter_outcome, %(dec)s.\n'
                    '   rewrite %(srw)sHstore. reflexivity.\n'
                    'Qed.\n'
                    'Print Assumptions %(n)s_vm_hit.\n'
                    % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                       'dv': default_val, 'dec': decode, 'chain': hit_chain,
                       'q': quant, 'k': key_expr, 'ic': init_call,
                       'ac': ac_arg, 'srw': src_rw})
            elif row['decode'] == 'hash160':
                width = cast_width
                require(width is not None, 'Missing cast width for hash160 getter')
                hit_valid_chain = render_chain(
                    'hitvalid', '(payload : bytes)', 'payload',
                    {'storage': ('Hstore',
                                 'sto (%s) = Some payload' % key_expr,
                                 _Val('GBytes payload', 'payload')),
                     'jmpeq': ('Hz', 'Z.eqb (Z.of_nat (length payload)) %d%%Z = true'
                               % width, 'true')},
                    'Done (GBytes payload)')
                theorems.append(
                    'Theorem %(n)s_vm_hit_valid : forall %(q)s payload,\n'
                    ' sto (%(k)s) = Some payload ->\n'
                    ' valid_bytes payload = true ->\n'
                    ' (length payload = %(w)d)%%nat ->\n'
                    ' run %(f)d 0 %(id)s_code %(ic)s'
                    ' = Done (GBytes payload) /\\\n'
                    ' getter_outcome %(p)s %(dv)s %(dec)s sto %(ac)s = OK (GBytes payload).\n'
                    'Proof.\n'
                    ' intros %(q)s payload Hstore Hvalid Hlen.\n'
                    ' assert (Hz : Z.eqb (Z.of_nat (length payload)) %(w)d = true).\n'
                    ' { apply Z.eqb_eq. rewrite Hlen. reflexivity. }\n'
                    ' split.\n'
                    ' - exact (%(chain)s).\n'
                    ' - unfold getter_outcome, decode_hash160.\n'
                    '   rewrite %(srw)sHstore, Hvalid, Hlen. reflexivity.\n'
                    'Qed.\n'
                    'Print Assumptions %(n)s_vm_hit_valid.\n'
                    % {'n': name, 'p': prefix_name, 'w': width, 'f': fuel,
                       'id': ident, 'dv': default_val, 'dec': decode,
                       'chain': hit_valid_chain, 'q': quant, 'k': key_expr,
                       'ic': init_call, 'ac': ac_arg, 'srw': src_rw})
                hit_bad_chain = render_chain(
                    'hitinvalid', '(payload : bytes)', 'payload',
                    {'storage': ('Hstore',
                                 'sto (%s) = Some payload' % key_expr,
                                 _Val('GBytes payload', 'payload')),
                     'jmpeq': ('Hz', 'Z.eqb (Z.of_nat (length payload)) %d%%Z = false'
                               % width, 'false')},
                    'Thrown')
                theorems.append(
                    'Theorem %(n)s_vm_hit_invalid_size : forall %(q)s payload,\n'
                    ' sto (%(k)s) = Some payload ->\n'
                    ' (length payload <> %(w)d)%%nat ->\n'
                    ' run %(f)d 0 %(id)s_code %(ic)s = Thrown /\\\n'
                    ' getter_outcome %(p)s %(dv)s %(dec)s sto %(ac)s = Fault.\n'
                    'Proof.\n'
                    ' intros %(q)s payload Hstore Hlen.\n'
                    ' assert (Hz : Z.eqb (Z.of_nat (length payload)) %(w)d = false).\n'
                    ' { apply Z.eqb_neq. intro He. apply Hlen.\n'
                    '   apply (Nat2Z.inj (length payload) %(w)d He). }\n'
                    ' split.\n'
                    ' - exact (%(chain)s).\n'
                    ' - unfold getter_outcome, decode_hash160. rewrite %(srw)sHstore.\n'
                    '   apply Nat.eqb_neq in Hlen. rewrite Hlen, andb_false_r. reflexivity.\n'
                    'Qed.\n'
                    'Print Assumptions %(n)s_vm_hit_invalid_size.\n'
                    % {'n': name, 'p': prefix_name, 'w': width, 'f': fuel,
                       'id': ident, 'dv': default_val, 'dec': decode,
                       'chain': hit_bad_chain, 'q': quant, 'k': key_expr,
                       'ic': init_call, 'ac': ac_arg, 'srw': src_rw})
            else:
                hit_chain = render_chain(
                    'hitint', '(payload : bytes) (value : Z)', 'payload value',
                    {'storage': ('Hstore',
                                 'sto (%s) = Some payload' % key_expr,
                                 _Val('GBytes payload', 'payload')),
                     'convert': ('Hdecode', 'decode_integer payload = OK (GInt value)',
                                 _Val('GInt value'))},
                    'Done (GInt value)')
                theorems.append(
                    'Theorem %(n)s_vm_hit_integer : forall %(q)s payload value,\n'
                    ' sto (%(k)s) = Some payload ->\n'
                    ' decode_integer payload = OK (GInt value) ->\n'
                    ' run %(f)d 0 %(id)s_code %(ic)s = Done (GInt value) /\\\n'
                    ' getter_outcome %(p)s %(dv)s %(dec)s sto %(ac)s = OK (GInt value).\n'
                    'Proof.\n'
                    ' intros %(q)s payload value Hstore Hdecode. split.\n'
                    ' - exact (%(chain)s).\n'
                    ' - unfold getter_outcome. rewrite %(srw)sHstore, Hdecode. reflexivity.\n'
                    'Qed.\n'
                    'Print Assumptions %(n)s_vm_hit_integer.\n'
                    % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                       'dv': default_val, 'dec': decode, 'chain': hit_chain,
                       'q': quant, 'k': key_expr, 'ic': init_call,
                       'ac': ac_arg, 'srw': src_rw})
        elif kind in ('state-field', 'state-gt-zero'):
            index = row['fieldIndex']
            if kind == 'state-field':
                src = 'account_state_outcome'
                end_hit = 'Done v'
            else:
                src = 'escape_active_outcome'
                end_hit = 'Done (GBool (Z.ltb 0 z))'
            miss_conj = ('%(src)s tok %(i)d sto account = Fault.'
                         if kind == 'state-field'
                         else '%(src)s tok sto account = Fault.')
            miss_conj = miss_conj % {'src': src, 'i': index}
            miss_chain = render_chain(
                'miss', '', '',
                {'storage': ('H', 'sto (%s ++ account) = None' % prefix_name,
                             _Val('GNull'))},
                'Thrown')
            theorems.append(
                'Theorem %(n)s_vm_miss : forall (tok : nat -> GVal -> GVal) sto account,\n'
                ' sto (%(p)s ++ account) = None ->\n'
                ' run %(f)d 0 %(id)s_code (%(id)s_init tok sto account) = Thrown /\\\n'
                ' %(conj)s\n'
                'Proof.\n'
                ' intros tok sto account H. split.\n'
                ' - exact (%(chain)s).\n'
                ' - apply %(n)s_source_miss with (sto := sto) (account := account)\n'
                '     (tok := tok). exact H.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_miss.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   'conj': miss_conj, 'chain': miss_chain})
            if kind == 'state-field':
                extra_decl = '(payload : bytes) (xs : list GVal) (v : GVal)'
                extra_params = 'payload xs v'
                pick_stmt = 'nth_error xs (Z.to_nat %d%%Z) = Some v' % index
                pick_val = _Val('v')
                hit_end = 'Done v'
                hit_conj = (' account_state_outcome tok %(i)d sto account = OK v.'
                            % {'i': index})
                hit_src = (' apply %(n)s_source_hit with (payload := payload)'
                           ' (xs := xs)\n     (v := v); assumption.')
                quant = ('forall (tok : nat -> GVal -> GVal) sto account payload'
                         ' xs v,')
                hit_prem = (
                    ' sto (account_state_prefix ++ account) = Some payload ->\n'
                    ' tok %(t)d%%nat (GBytes payload) = GArray xs ->\n'
                    ' nth_error xs %(i)d%%nat = Some v ->\n'
                    % {'t': DESERIALIZE_TOKEN_INDEX, 'i': index})
                hit_intro = 'intros tok sto account payload xs v H Htok Hnth.'
                hit_apply = (' - apply %(n)s_source_hit with (payload := payload)'
                             ' (xs := xs) (v := v); assumption.')
            else:
                extra_decl = '(payload : bytes) (xs : list GVal) (z : Z)'
                extra_params = 'payload xs z'
                pick_stmt = 'nth_error xs (Z.to_nat %d%%Z) = Some (GInt z)' % index
                pick_val = _Val('GInt z')
                hit_end = 'Done (GBool (Z.ltb 0 z))'
                hit_conj = (' escape_active_outcome tok sto account'
                            ' = OK (GBool (Z.ltb 0 z)).')
                quant = ('forall (tok : nat -> GVal -> GVal) sto account payload'
                         ' xs z,')
                hit_prem = (
                    ' sto (account_state_prefix ++ account) = Some payload ->\n'
                    ' tok %(t)d%%nat (GBytes payload) = GArray xs ->\n'
                    ' nth_error xs %(i)d%%nat = Some (GInt z) ->\n'
                    % {'t': DESERIALIZE_TOKEN_INDEX, 'i': index})
                hit_intro = 'intros tok sto account payload xs z H Htok Hnth.'
                hit_apply = (' - apply %(n)s_source_hit with (payload := payload)'
                             ' (xs := xs) (z := z); assumption.')
            hit_chain = render_chain(
                'hit', extra_decl, extra_params,
                {'storage': ('H', 'sto (%s ++ account) = Some payload' % prefix_name,
                             _Val('GBytes payload', 'payload')),
                 'calltoken': ('Htok', 'tok %d%%nat (GBytes payload) = GArray xs'
                               % DESERIALIZE_TOKEN_INDEX, _Val('GArray xs')),
                 'pick': ('Hnth', pick_stmt, pick_val)},
                hit_end)
            theorems.append(
                'Theorem %(n)s_vm_hit : %(q)s\n'
                '%(prem)s'
                ' run %(f)d 0 %(id)s_code (%(id)s_init tok sto account)'
                ' = %(end)s /\\\n'
                '%(conj)s\n'
                'Proof.\n'
                ' %(intro)s split.\n'
                ' - exact (%(chain)s).\n'
                '%(src)s\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_hit.\n'
                % {'n': name, 'q': quant, 'prem': hit_prem, 'f': fuel,
                   'id': ident, 'end': hit_end, 'conj': hit_conj,
                   'intro': hit_intro, 'chain': hit_chain, 'src': hit_apply
                   % {'n': name}})
        elif kind == 'presence':
            miss_chain = render_chain(
                'miss', '', '',
                {'storage': ('Hstore', 'sto (%s ++ account) = None' % prefix_name,
                             _Val('GNull'))},
                'Done (GBool false)')
            hit_chain = render_chain(
                'hit', '(payload : bytes)', 'payload',
                {'storage': ('Hstore', 'sto (%s ++ account) = Some payload' % prefix_name,
                             _Val('GBytes payload', 'payload'))},
                'Done (GBool true)')
            theorems.append(
                'Theorem %(n)s_vm_miss : forall sto account,\n'
                ' sto (%(p)s ++ account) = None ->\n'
                ' run %(f)d 0 %(id)s_code (%(id)s_init sto account)'
                ' = Done (GBool false) /\\\n'
                ' %(n)s_binding sto account = OK (GBool false).\n'
                'Proof.\n'
                ' intros sto account Hstore. split.\n'
                ' - exact (%(miss)s).\n'
                ' - apply %(n)s_source_miss. exact Hstore.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_miss.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   'miss': miss_chain})
            theorems.append(
                'Theorem %(n)s_vm_hit : forall sto account payload,\n'
                ' sto (%(p)s ++ account) = Some payload ->\n'
                ' run %(f)d 0 %(id)s_code (%(id)s_init sto account)'
                ' = Done (GBool true) /\\\n'
                ' %(n)s_binding sto account = OK (GBool true).\n'
                'Proof.\n'
                ' intros sto account payload Hstore. split.\n'
                ' - exact (%(chain)s).\n'
                ' - apply %(n)s_source_hit with (payload := payload). exact Hstore.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_hit.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   'chain': hit_chain})
        elif kind == 'presence-call':
            # Delegating presence getters: the callee region performs the
            # storage read and returns the null item on a miss; the caller
            # region tests the callee result against null. The hit case is
            # relative to the universally quantified deserialize oracle, and
            # the null test is the same gval_eqb term the source-level binding
            # uses, so both sides of the conjunction are one statement.
            oracle = 'tok %d%%nat (GBytes payload)' % DESERIALIZE_TOKEN_INDEX
            miss_chain = render_chain(
                'miss', '', '',
                {'storage': ('Hstore', 'sto (%s ++ account) = None' % prefix_name,
                             _Val('GNull'))},
                'Done (GBool false)')
            hit_chain = render_chain(
                'hit', '(payload : bytes)', 'payload',
                {'storage': ('Hstore',
                             'sto (%s ++ account) = Some payload' % prefix_name,
                             _Val('GBytes payload', 'payload')),
                 'calltoken': (None, _Val(oracle)),
                 'notequal': ('Hne', 'gval_eqb GNull (%s) = false' % oracle, 'true')},
                'Done (GBool true)')
            theorems.append(
                'Theorem %(n)s_vm_miss : forall (tok : nat -> GVal -> GVal) sto account,\n'
                ' sto (%(p)s ++ account) = None ->\n'
                ' run %(f)d 0 %(id)s_code (%(id)s_init tok sto account)'
                ' = Done (GBool false) /\\\n'
                ' %(n)s_binding tok sto account = OK (GBool false).\n'
                'Proof.\n'
                ' intros tok sto account Hstore. split.\n'
                ' - exact (%(miss)s).\n'
                ' - apply %(n)s_source_miss. exact Hstore.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_miss.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   'miss': miss_chain})
            theorems.append(
                'Theorem %(n)s_vm_hit : forall (tok : nat -> GVal -> GVal)'
                ' sto account payload,\n'
                ' sto (%(p)s ++ account) = Some payload ->\n'
                ' gval_eqb GNull (tok %(t)d%%nat (GBytes payload)) = false ->\n'
                ' run %(f)d 0 %(id)s_code (%(id)s_init tok sto account)'
                ' = Done (GBool true) /\\\n'
                ' %(n)s_binding tok sto account = OK (GBool true).\n'
                'Proof.\n'
                ' intros tok sto account payload Hstore Hne. split.\n'
                ' - exact (%(chain)s).\n'
                ' - apply %(n)s_source_hit with (payload := payload); assumption.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_hit.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   't': DESERIALIZE_TOKEN_INDEX, 'chain': hit_chain})
        elif kind == 'presence-call-item':
            # Delegating record projections: the shared callee performs the
            # storage read and returns the deserialized record (the null item
            # on a miss); the caller region stores that value, tests it
            # against null and reads one field of it, and the Time pair then
            # adds the pinned delay constant. The hit case is relative to the
            # universally quantified deserialize oracle: the theorem fixes
            # `tok` on the stored payload to an array, which is the shape the
            # source-level binding matches on, so the field read is literally
            # the same `nth_error` projection on both sides of the
            # conjunction. The traced PICKITEM index is the ordinal extracted
            # from the PendingModuleCall declaration, cross-checked against
            # the rendered program by build_program. The seed hypothesis is
            # stated at the model's own index term `Z.to_nat <i>%Z` (the
            # interpreted PUSHINT operand the step normalizes to), not at the
            # nat literal: `nth_error xs <i>` is a different subterm and the
            # rewrite would not fire.
            index = row['itemIndex']
            key_expr = prefix_name + ' ++ account'
            if row['decode'] in ('hash160', 'raw-bytes'):
                record_decl = '(payload : bytes) (xs : list GVal) (v : GVal)'
                record_prm = 'payload xs v'
                pick_stmt = 'nth_error xs (Z.to_nat %d%%Z) = Some v' % index
                pick_val = _Val('v')
                hit_val = 'v'
                if row['decode'] == 'hash160':
                    default_val = '(GBytes hash160_default)'
                else:
                    # `(ByteString)new byte[0]`: the compiled null branch is
                    # PUSH0; NEWBUFFER; CONVERT 40, which the model evaluates to
                    # the empty byte string, so the miss result is `GBytes []`.
                    require(row['default'] == {'kind': 'empty-bytes'},
                            'Unsupported record empty-bytes default: ' + name)
                    default_val = '(GBytes [])'
                src_with = '(payload := payload) (xs := xs) (v := v)'
            else:
                offset_txt = '%d%%Z' % row['offset']
                record_decl = '(payload : bytes) (xs : list GVal) (z : Z)'
                record_prm = 'payload xs z'
                pick_stmt = 'nth_error xs (Z.to_nat %d%%Z) = Some (GInt z)' % index
                pick_val = _Val('GInt z')
                hit_val = '(GInt (z + %s))' % offset_txt
                default_val = '(GInt 0%Z)'
                src_with = '(payload := payload) (xs := xs) (z := z)'
            hit_end = 'Done ' + hit_val
            miss_chain = render_chain(
                'miss', '', '',
                {'storage': ('Hstore', 'sto (%s) = None' % key_expr,
                             _Val('GNull'))},
                'Done ' + default_val)
            hit_chain = render_chain(
                'hit', record_decl, record_prm,
                {'storage': ('Hstore', 'sto (%s) = Some payload' % key_expr,
                             _Val('GBytes payload', 'payload')),
                 'calltoken': ('Htok', 'tok %d%%nat (GBytes payload) = GArray xs'
                               % DESERIALIZE_TOKEN_INDEX, _Val('GArray xs')),
                 'pick': ('Hnth', pick_stmt, pick_val)},
                hit_end)
            theorems.append(
                'Theorem %(n)s_vm_miss : forall (tok : nat -> GVal -> GVal)'
                ' sto account,\n'
                ' sto (%(p)s ++ account) = None ->\n'
                ' run %(f)d 0 %(id)s_code (%(id)s_init tok sto account)'
                ' = Done %(dv)s /\\\n'
                ' %(n)s_binding tok sto account = OK %(dv)s.\n'
                'Proof.\n'
                ' intros tok sto account Hstore. split.\n'
                ' - exact (%(chain)s).\n'
                ' - apply %(n)s_source_miss. exact Hstore.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_miss.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   'dv': default_val, 'chain': miss_chain})
            theorems.append(
                'Theorem %(n)s_vm_hit : forall (tok : nat -> GVal -> GVal)'
                ' sto account %(decl)s,\n'
                ' sto (%(p)s ++ account) = Some payload ->\n'
                ' tok %(t)d%%nat (GBytes payload) = GArray xs ->\n'
                ' %(pick)s ->\n'
                ' run %(f)d 0 %(id)s_code (%(id)s_init tok sto account)'
                ' = %(end)s /\\\n'
                ' %(n)s_binding tok sto account = OK %(hv)s.\n'
                'Proof.\n'
                ' intros tok sto account %(prm)s Hstore Htok Hnth. split.\n'
                ' - exact (%(chain)s).\n'
                ' - apply %(n)s_source_hit with %(with)s; assumption.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_hit.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   't': DESERIALIZE_TOKEN_INDEX, 'chain': hit_chain,
                   'decl': record_decl, 'prm': record_prm, 'pick': pick_stmt,
                   'end': hit_end, 'hv': hit_val, 'with': src_with})
        elif kind == 'inline-record-time':
            # Inline epoch getters: the region performs the key concatenation and
            # the storage read itself, guards with an early return of the pinned
            # integer default and only then deserializes through the pinned token
            # and projects InitiatedAt before adding the pinned timelock. The hit
            # case therefore runs one arm further than the delegating Time pair,
            # which reaches the same field projection through the shared callee;
            # the miss case returns without ever touching the oracle. The seed
            # hypothesis is stated at the model's own index term `Z.to_nat <i>%Z`,
            # the interpreted PUSHINT operand the step normalizes to, so the
            # rewrite fires on exactly the subterm the traced PICKITEM produces.
            index = row['itemIndex']
            require('offset' in row,
                    'Inline epoch projection must carry a delay constant: ' + name)
            offset_txt = '%d%%Z' % row['offset']
            key_expr = prefix_name + ' ++ account'
            default_val = '(GInt 0%Z)'
            hit_val = '(GInt (z + %s))' % offset_txt
            hit_end = 'Done ' + hit_val
            miss_chain = render_chain(
                'miss', '', '',
                {'storage': ('Hstore', 'sto (%s) = None' % key_expr,
                             _Val('GNull'))},
                'Done ' + default_val)
            hit_chain = render_chain(
                'hit', '(payload : bytes) (xs : list GVal) (z : Z)', 'payload xs z',
                {'storage': ('Hstore', 'sto (%s) = Some payload' % key_expr,
                             _Val('GBytes payload', 'payload')),
                 'calltoken': ('Htok', 'tok %d%%nat (GBytes payload) = GArray xs'
                               % DESERIALIZE_TOKEN_INDEX, _Val('GArray xs')),
                 'pick': ('Hnth', 'nth_error xs (Z.to_nat %d%%Z) = Some (GInt z)' % index,
                          _Val('GInt z'))},
                hit_end)
            theorems.append(
                'Theorem %(n)s_vm_miss : forall (tok : nat -> GVal -> GVal)'
                ' sto account,\n'
                ' sto (%(p)s ++ account) = None ->\n'
                ' run %(f)d 0 %(id)s_code (%(id)s_init tok sto account)'
                ' = Done %(dv)s /\\\n'
                ' %(n)s_binding tok sto account = OK %(dv)s.\n'
                'Proof.\n'
                ' intros tok sto account Hstore. split.\n'
                ' - exact (%(chain)s).\n'
                ' - apply %(n)s_source_miss. exact Hstore.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_miss.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   'dv': default_val, 'chain': miss_chain})
            theorems.append(
                'Theorem %(n)s_vm_hit : forall (tok : nat -> GVal -> GVal)'
                ' sto account (payload : bytes) (xs : list GVal) (z : Z),\n'
                ' sto (%(p)s ++ account) = Some payload ->\n'
                ' tok %(t)d%%nat (GBytes payload) = GArray xs ->\n'
                ' nth_error xs (Z.to_nat %(i)d%%Z) = Some (GInt z) ->\n'
                ' run %(f)d 0 %(id)s_code (%(id)s_init tok sto account)'
                ' = %(end)s /\\\n'
                ' %(n)s_binding tok sto account = OK %(hv)s.\n'
                'Proof.\n'
                ' intros tok sto account payload xs z Hstore Htok Hnth. split.\n'
                ' - exact (%(chain)s).\n'
                ' - apply %(n)s_source_hit with (payload := payload) (xs := xs)'
                ' (z := z); assumption.\n'
                'Qed.\n'
                'Print Assumptions %(n)s_vm_hit.\n'
                % {'n': name, 'p': prefix_name, 'f': fuel, 'id': ident,
                   't': DESERIALIZE_TOKEN_INDEX, 'i': index, 'chain': hit_chain,
                   'end': hit_end, 'hv': hit_val})
        elif kind in ('raw-call-presence', 'raw-call-offset'):
            # Delegating raw readers over the escrow owner-cancel latch. The
            # shared reader returns the stored payload verbatim (the null item
            # on a miss) and performs no deserialize, so the traces are the
            # two outcomes of the one pinned key: the miss, answered with the
            # pinned default, and the hit, whose payload the caller tests
            # against null or casts and offsets in its own frame.
            key_expr = prefix_name + ' ++ account'
            miss_seed = {'storage': ('Hstore', 'sto (%s) = None' % key_expr,
                                     _Val('GNull'))}
            hit_seed = {'storage': ('Hstore', 'sto (%s) = Some payload' % key_expr,
                                    _Val('GBytes payload', 'payload'))}
            if kind == 'raw-call-presence':
                # The reader's raw result makes the caller's null test
                # decidable on both sides: a bound key yields the payload
                # itself and an unbound key yields the null item.
                miss_chain = render_chain('miss', '', '', miss_seed,
                                          'Done (GBool false)')
                hit_chain = render_chain('hit', '(payload : bytes)', 'payload',
                                         hit_seed, 'Done (GBool true)')
                theorems.append(
                    'Theorem %(n)s_vm_miss : forall sto account,\n'
                    ' sto (%(k)s) = None ->\n'
                    ' run %(f)d 0 %(id)s_code (%(id)s_init sto account)'
                    ' = Done (GBool false) /\\\n'
                    ' %(n)s_binding sto account = OK (GBool false).\n'
                    'Proof.\n'
                    ' intros sto account Hstore. split.\n'
                    ' - exact (%(chain)s).\n'
                    ' - exact (%(n)s_source_miss sto account Hstore).\n'
                    'Qed.\n'
                    'Print Assumptions %(n)s_vm_miss.\n'
                    % {'n': name, 'k': key_expr, 'f': fuel, 'id': ident,
                       'chain': miss_chain})
                theorems.append(
                    'Theorem %(n)s_vm_hit : forall sto account payload,\n'
                    ' sto (%(k)s) = Some payload ->\n'
                    ' run %(f)d 0 %(id)s_code (%(id)s_init sto account)'
                    ' = Done (GBool true) /\\\n'
                    ' %(n)s_binding sto account = OK (GBool true).\n'
                    'Proof.\n'
                    ' intros sto account payload Hstore. split.\n'
                    ' - exact (%(chain)s).\n'
                    ' - exact (%(n)s_source_hit sto account payload Hstore).\n'
                    'Qed.\n'
                    'Print Assumptions %(n)s_vm_hit.\n'
                    % {'n': name, 'k': key_expr, 'f': fuel, 'id': ident,
                       'chain': hit_chain})
            else:
                # The delegating epoch getter: the reader's raw payload is cast
                # with the pinned little-endian decode and the pinned delay is
                # added inside the caller's field arm, so the observable result
                # carries the constant on the hit path.
                require(row['decode'] == 'integer' and 'offset' in row,
                        'Raw epoch projection must carry the delay constant: ' + name)
                offset_txt = '%d%%Z' % row['offset']
                default_val = '(GInt 0%Z)'
                hit_end = 'Done (GInt (value + %s))' % offset_txt
                hit_seed['convert'] = (
                    'Hdecode', 'decode_integer payload = OK (GInt value)',
                    _Val('GInt value'))
                miss_chain = render_chain('miss', '', '', miss_seed,
                                          'Done ' + default_val)
                hit_chain = render_chain(
                    'hit', '(payload : bytes) (value : Z)', 'payload value',
                    hit_seed, hit_end)
                theorems.append(
                    'Theorem %(n)s_vm_miss : forall sto account,\n'
                    ' sto (%(k)s) = None ->\n'
                    ' run %(f)d 0 %(id)s_code (%(id)s_init sto account)'
                    ' = Done %(dv)s /\\\n'
                    ' %(n)s_binding sto account = OK %(dv)s.\n'
                    'Proof.\n'
                    ' intros sto account Hstore. split.\n'
                    ' - exact (%(chain)s).\n'
                    ' - exact (%(n)s_source_miss sto account Hstore).\n'
                    'Qed.\n'
                    'Print Assumptions %(n)s_vm_miss.\n'
                    % {'n': name, 'k': key_expr, 'f': fuel, 'id': ident,
                       'dv': default_val, 'chain': miss_chain})
                theorems.append(
                    'Theorem %(n)s_vm_hit : forall sto account payload value,\n'
                    ' sto (%(k)s) = Some payload ->\n'
                    ' decode_integer payload = OK (GInt value) ->\n'
                    ' run %(f)d 0 %(id)s_code (%(id)s_init sto account)'
                    ' = %(end)s /\\\n'
                    ' %(n)s_binding sto account = OK (GInt (value + %(o)s)).\n'
                    'Proof.\n'
                    ' intros sto account payload value Hstore Hdecode. split.\n'
                    ' - exact (%(chain)s).\n'
                    ' - exact (%(n)s_source_hit sto account payload value'
                    ' Hstore Hdecode).\n'
                    'Qed.\n'
                    'Print Assumptions %(n)s_vm_hit.\n'
                    % {'n': name, 'k': key_expr, 'f': fuel, 'id': ident,
                       'end': hit_end, 'o': offset_txt, 'chain': hit_chain})
        else:
            raise ValueError('Unknown projection kind: ' + kind)
        code_names = [ident + '_code']
        program_names = [ident + '_program']
        statics_names = [ident + '_statics']
        # One kernel module per getter: its program definitions, its trace
        # chains (per-step machine definitions and one-step equation lemmas)
        # and its trace theorems, so a single coqc run stays small. Each
        # chain lemma is closed by reflexivity over one run unfolding (or one
        # run_S rewrite plus a hypothesis rewrite), so the kernel checks many
        # small conversions instead of one unbounded chain.
        module_name = 'VmCert_' + ident
        text = (PRELUDE
                + 'Require Import %s.\nRequire Import StorageGetterArtifact.\n\n' % VM_MODULE
                + ''.join(definitions) + '\n'
                + ''.join(chain_defs) + '\n'
                + ''.join(theorems))
        vm_modules.append((module_name, text))
        definitions, theorems = [], []
    return vm_modules


VM_MUTANTS = [
    # name -> (getter, fixture storage lambda, asserted VM result, account,
    #          tok definition or None). Single-region mutants cover the two
    # direct storage getters; combined mutants cover the shared callee
    # frames, the field projection and the presence test.
    ('vm-contract-jmpeq-target',
     'getMarketEscrowContract',
     'fun key => if bytes_eqb key [6%nat;1%nat] then Some (repeat 0%nat 20) else None',
     '[1%nat]',
     'Done (GBytes (repeat 0%nat 20))',
     None),
    ('vm-contract-default-width',
     'getMarketEscrowContract',
     'fun _ => None',
     '[1%nat]',
     'Done (GBytes hash160_default)',
     None),
    ('vm-contract-drop-null-check',
     'getMarketEscrowContract',
     'fun _ => None',
     '[1%nat]',
     'Done (GBytes hash160_default)',
     None),
    ('vm-listing-convert-identity',
     'getMarketEscrowListingId',
     'fun key => if bytes_eqb key [7%nat;1%nat] then Some [5%nat] else None',
     '[1%nat]',
     'Done (GInt 5)',
     None),
    ('vm-verifier-field-index',
     'getVerifier',
     'fun key => if bytes_eqb key [1%nat;1%nat] then Some [5%nat] else None',
     '[1%nat]',
     'Done (GBytes (repeat 0%nat 20))',
     'Definition tok (i : nat) (v : GVal) : GVal :=\n'
     ' match v with\n'
     ' | GBytes _ => GArray [GBytes (repeat 0%nat 20); GBytes (repeat 1%nat 20)]\n'
     ' | _ => GNull\n'
     ' end.\n'),
    ('vm-state-null-check-invert',
     'getVerifier',
     'fun key => if bytes_eqb key [1%nat;1%nat] then Some [5%nat] else None',
     '[1%nat]',
     'Done (GBytes (repeat 0%nat 20))',
     'Definition tok (i : nat) (v : GVal) : GVal :=\n'
     ' match v with\n'
     ' | GBytes _ => GArray [GBytes (repeat 0%nat 20)]\n'
     ' | _ => GNull\n'
     ' end.\n'),
    ('vm-state-call-target',
     'getVerifier',
     'fun key => if bytes_eqb key [1%nat;1%nat] then Some [5%nat] else None',
     '[1%nat]',
     'Done (GBytes (repeat 0%nat 20))',
     'Definition tok (i : nat) (v : GVal) : GVal :=\n'
     ' match v with\n'
     ' | GBytes _ => GArray [GBytes (repeat 0%nat 20)]\n'
     ' | _ => GNull\n'
     ' end.\n'),
    ('vm-presence-equality-flip',
     'hasPendingVerifierUpdate',
     'fun _ => None',
     '[1%nat]',
     'Done (GBool false)',
     None),
    # Delegating record projections. The fixture binds the same key the
    # caller builds (prefix [15] ++ account [1]) and the oracle returns a
    # record whose fields are distinguishable, so a drifted field ordinal or
    # a dropped timelock changes the observed result.
    ('vm-record-item-index',
     'getPendingVerifierCallModule',
     'fun key => if bytes_eqb key [15%nat;1%nat] then Some [5%nat] else None',
     '[1%nat]',
     'Done (GBytes (repeat 0%nat 20))',
     'Definition tok (i : nat) (v : GVal) : GVal :=\n'
     ' match v with\n'
     ' | GBytes _ => GArray [GBytes (repeat 0%nat 20); GBytes (repeat 1%nat 20)]\n'
     ' | _ => GNull\n'
     ' end.\n'),
    ('vm-record-time-delay',
     'getPendingVerifierCallTime',
     'fun key => if bytes_eqb key [15%nat;1%nat] then Some [5%nat] else None',
     '[1%nat]',
     'Done (GInt 86400005)',
     'Definition tok (i : nat) (v : GVal) : GVal :=\n'
     ' match v with\n'
     ' | GBytes _ =>\n'
     '     GArray [GBytes (repeat 0%nat 20); GBytes (repeat 1%nat 20); GInt 5%Z]\n'
     ' | _ => GNull\n'
     ' end.\n'),
    # The empty-bytes default is a *three-instruction* branch, so the control
    # exercises the miss path (unbound key) where the allocation length is the
    # only thing that decides the result: growing it to one byte makes the
    # asserted `GBytes []` unprovable.
    ('vm-record-hash-default',
     'getPendingVerifierCallHash',
     'fun _ => None',
     '[1%nat]',
     'Done (GBytes [])',
     None),
    # The inline epoch getters build their own key (prefix [9] ++ account [1])
    # and add the pinned timelock inside the field arm of the getter's own
    # region, not inside a shared callee. The fixture binds exactly that key and
    # the oracle returns a record whose InitiatedAt is 5, so the observable
    # result is 86400005; replacing the delay static with a literal zero makes
    # that assertion unprovable, which is what the control measures.
    ('vm-inline-record-delay',
     'getPendingVerifierUpdateTime',
     'fun key => if bytes_eqb key [9%nat;1%nat] then Some [5%nat] else None',
     '[1%nat]',
     'Done (GInt 86400005)',
     'Definition tok (i : nat) (v : GVal) : GVal :=\n'
     ' match v with\n'
     ' | GBytes _ =>\n'
     '     GArray [GBytes (repeat 0%nat 20); GBytes (repeat 1%nat 20);\n'
     '             GBytes (repeat 0%nat 20); GInt 5%Z]\n'
     ' | _ => GNull\n'
     ' end.\n'),
    # Escrow owner-cancel raw readers: the delegating presence test and the
    # delegating epoch getter's pinned delay, both on the reader's single
    # prefix ([29]) so the mutation is what the control isolates.
    ('vm-raw-presence-flip',
     'hasMarketEscrowOwnerCancel',
     'fun key => if bytes_eqb key [29%nat;1%nat] then Some [5%nat] else None',
     '[1%nat]',
     'Done (GBool true)',
     None),
    ('vm-raw-offset-delay',
     'getMarketEscrowOwnerCancelTime',
     'fun key => if bytes_eqb key [29%nat;1%nat] then Some [5%nat] else None',
     '[1%nat]',
     'Done (GInt 604800005)',
     None),
]


def _vm_mutant_program(name, getter, parts):
    """Return (mutant parts, description) for each program-level mutation."""
    if name == 'vm-contract-jmpeq-target':
        originals = [i for i, p in enumerate(parts) if p.startswith('JumpEq ')]
        require(len(originals) == 1, 'Ambiguous JumpEq for mutation')
        slot = int(parts[originals[0]][len('JumpEq '):])
        throw_slots = [i for i, p in enumerate(parts) if p == 'Throw']
        require(len(throw_slots) == 1, 'Ambiguous Throw slot')
        mutated = list(parts)
        mutated[originals[0]] = 'JumpEq %d' % throw_slots[0]
        return mutated, 'JumpEq %d -> JumpEq %d' % (slot, throw_slots[0])
    if name == 'vm-contract-default-width':
        originals = [i for i, p in enumerate(parts) if p.startswith('Push (GBytes [')]
        require(len(originals) == 1, 'Ambiguous default push for mutation')
        mutated = list(parts)
        mutated[originals[0]] = 'Push (GBytes (zeros 19))'
        return mutated, 'default PUSHDATA -> 19 zero bytes'
    if name == 'vm-contract-drop-null-check':
        originals = [i for i, p in enumerate(parts) if p == 'EqualIns']
        require(len(originals) == 1, 'Ambiguous EqualIns for mutation')
        mutated = list(parts)
        mutated[originals[0]] = 'Unsupported'
        return mutated, 'EQUAL -> unsupported opcode'
    if name == 'vm-listing-convert-identity':
        originals = [i for i, p in enumerate(parts) if p == 'Convert %d' % CONVERT_INTEGER]
        require(len(originals) == 1, 'Ambiguous Convert 21 for mutation')
        mutated = list(parts)
        mutated[originals[0]] = 'Convert %d' % CONVERT_BUFFER
        return mutated, 'Convert 21 -> Convert 48'
    if name == 'vm-verifier-field-index':
        call_indices = [i for i, p in enumerate(parts) if p.startswith('Call ')]
        require(len(call_indices) == 1, 'Ambiguous call for mutation')
        ci = call_indices[0]
        require(parts[ci + 1] == 'Push (GInt 0)', 'Expected field index 0 for mutation')
        mutated = list(parts)
        mutated[ci + 1] = 'Push (GInt 1)'
        return mutated, 'PICKITEM index 0 -> 1'
    if name == 'vm-state-null-check-invert':
        originals = [i for i, p in enumerate(parts) if p == 'NotEqualIns']
        require(len(originals) == 1, 'Ambiguous NotEqualIns for mutation')
        mutated = list(parts)
        mutated[originals[0]] = 'EqualIns'
        return mutated, 'NOTEQUAL -> EQUAL in the shared callee'
    if name == 'vm-state-call-target':
        call_indices = [i for i, p in enumerate(parts) if p.startswith('Call ')]
        require(len(call_indices) == 1, 'Ambiguous call for mutation')
        ci = call_indices[0]
        entry = int(parts[ci][len('Call '):])
        msg_slots = [i for i, p in enumerate(parts)
                     if i >= entry and p.startswith('Push (GBytes [')]
        require(len(msg_slots) == 1, 'Ambiguous abort message slot')
        mutated = list(parts)
        mutated[ci] = 'Call %d' % msg_slots[0]
        return mutated, 'CALL target -> abort message push (skips the null check)'
    if name == 'vm-presence-equality-flip':
        originals = [i for i, p in enumerate(parts) if p == 'NotEqualIns']
        require(len(originals) == 1, 'Ambiguous NotEqualIns for mutation')
        mutated = list(parts)
        mutated[originals[0]] = 'EqualIns'
        return mutated, 'NOTEQUAL -> EQUAL in the presence test'
    if name == 'vm-record-item-index':
        call_indices = [i for i, p in enumerate(parts) if p.startswith('Call ')]
        require(len(call_indices) == 1, 'Ambiguous call for mutation')
        ci = call_indices[0]
        picks = [i for i, p in enumerate(parts)
                 if i > ci and p.startswith('Push (GInt ')]
        require(len(picks) >= 1, 'Missing record field index for mutation')
        picked = picks[-1]
        require(parts[picked + 1] == 'PickItem', 'Expected the record PICKITEM')
        index = int(parts[picked][len('Push (GInt '):-1])
        mutated = list(parts)
        mutated[picked] = 'Push (GInt %d)' % (index + 1)
        return mutated, 'record PICKITEM index %d -> %d' % (index, index + 1)
    if name in ('vm-record-time-delay', 'vm-inline-record-delay',
                'vm-raw-offset-delay'):
        originals = [i for i, p in enumerate(parts)
                     if p.startswith('LdStatic ') and parts[i + 1] == 'AddIns']
        require(len(originals) == 1, 'Ambiguous delay static for mutation')
        mutated = list(parts)
        mutated[originals[0]] = 'Push (GInt 0)'
        description = {'vm-record-time-delay': 'record timelock static -> literal zero',
                       'vm-inline-record-delay': 'inline epoch timelock static -> literal zero',
                       'vm-raw-offset-delay':
                           'raw reader epoch timelock static -> literal zero'}[name]
        return mutated, description
    if name == 'vm-raw-presence-flip':
        # `return <raw reader>(accountId) != null;`: inverting the caller's
        # null test flips the observable presence bit on every bound key.
        call_indices = [i for i, p in enumerate(parts) if p.startswith('Call ')]
        require(len(call_indices) == 1, 'Ambiguous call for mutation')
        ci = call_indices[0]
        require(parts[ci + 1] == 'Push GNull' and parts[ci + 2] == 'NotEqualIns',
                'Expected the delegating raw null test for mutation')
        mutated = list(parts)
        mutated[ci + 2] = 'EqualIns'
        return mutated, 'NOTEQUAL -> EQUAL in the delegating raw presence test'
    if name == 'vm-record-hash-default':
        originals = [i for i, p in enumerate(parts)
                     if p == 'Push (GInt 0)' and i + 1 < len(parts)
                     and parts[i + 1] == 'NewBuffer']
        require(len(originals) == 1, 'Ambiguous empty-buffer length for mutation')
        mutated = list(parts)
        mutated[originals[0]] = 'Push (GInt 1)'
        return mutated, 'record empty-bytes default NEWBUFFER length 0 -> 1'
    raise ValueError('Unknown VM mutant: ' + name)


def _mutant_static_term(bound, name, role):
    """Static term for a mutant module: byte literals, not the artifact's names.

    The mutant modules import the VM model only (they are compiled and rejected
    before the artifact is in scope for them), so the pinned constants are
    written out as literals - the same values the certified tables' named
    constants stand for.
    """
    entry = bound['methods'][name]
    row = entry['projection']
    kind = row.get('kind', 'direct')
    if role == 'delay':
        return 'GInt %d%%Z' % row['offset']
    if kind in ('raw-call-presence', 'raw-call-offset'):
        source = bound['callees'][row.get('callee') or CALLEE_KINDS[kind]]['projection']
    else:
        source = row
    if kind in ('state-field', 'state-gt-zero'):
        return ('GBytes '
                + _prefix_literal(bound['callee']['projection']['prefixBytes']))
    return 'GBytes ' + _prefix_literal(source['prefixBytes'])


def vm_mutant_controls(bound, decoded_rows, work):
    """Kernel rejection of mutated bytecode programs.

    Each control renders the original program with exactly one instruction
    mutated and asserts, in the kernel, that the mutated machine still
    produces the original result on a distinguishing fixture. Every such
    assertion must fail to compile (the kernel rejects it), so a mutation
    that is behaviorally invisible would fail the lane. The mutant machines
    are built with the same static table and argument vector the certified
    run uses, so a control is rejected for the mutated instruction and not
    for a malformed frame.

    Each control is compiled twice against the same fixture and expected
    value: the unmutated program must be ACCEPTED and the mutated one
    REJECTED. The accepted twin is what makes the rejection evidence about
    the mutation: without it a wrong fixture or a mistyped expected value
    would also produce a "rejected" mutant while proving nothing.
    """
    require(len(VM_MUTANTS) >= 4, 'Insufficient VM mutant controls')
    reports = []
    for index, (name, getter, fixture, account, expected, tok_def) in enumerate(VM_MUTANTS):
        parts, nlocals, static_slots, _ = build_program(bound, decoded_rows, getter)
        mutated, description = _vm_mutant_program(name, getter, parts)
        ident = _vm_ident(getter)
        row = bound['methods'][getter]['projection']
        kind = row.get('kind', 'direct')
        roles = _static_plan(bound, getter, parts)
        require(set(static_slots) == set(slot for slot, _ in roles),
                'Mutant static inventory disagrees with the bound region: ' + getter)
        terms = {r: _mutant_static_term(bound, getter, r) for _, r in roles}
        if kind in CALLEE_KINDS:
            # The traced entry state carries the argument vector the caller
            # builds at the certified CALL; only the two-parameter record reader
            # takes a second operand (the pinned prefix) beside the ABI account,
            # and the two kinds that bind it both pin that prefix themselves.
            nparams = bound['callees'][row.get('callee') or CALLEE_KINDS[kind]]['nparams']
            require(nparams in (1, 2), 'Unsupported shared callee arity: ' + getter)
            if nparams == 2:
                require('prefixBytes' in row,
                        'Two-parameter callee must be fed the caller prefix: ' + getter)
                margs = '[GBytes account; GBytes %s]' % _prefix_literal(row['prefixBytes'])
            else:
                margs = '[GBytes account]'
        else:
            margs = '[GBytes account]'
        fuel = len(parts) + 2
        tok_definition = tok_def or ('Definition tok (i : nat) (v : GVal) : GVal := GNull.\n')

        def render(program):
            return (PRELUDE + 'Require Import %s.\n' % VM_MODULE +
                    'Definition bytes_eqb (a b : bytes) : bool :=\n'
                    '  match list_eq_dec Nat.eq_dec a b with'
                    ' left _ => true | right _ => false end.\n'
                    'Definition fixture_storage : storage := %s.\n' % fixture +
                    tok_definition +
                    'Definition mutant_program : list Ins :=\n [%s].\n' % '; '.join(program) +
                    'Definition mutant_code (pc : nat) : Ins :='
                    ' nth pc mutant_program Unsupported.\n'
                    + _statics_definition('mutant', roles, terms) +
                    'Definition mutant_init (sto : storage) (account : bytes) : Machine :=\n'
                    ' machine [] (repeat GNull %d) %s mutant_statics sto [] tok.\n'
                    % (nlocals, margs) +
                    VM_DRIVE_MUT.format(codes='mutant_code', programs='mutant_program',
                                        statics='mutant_statics') +
                    'Example mutant_vm_matches_original :\n'
                    ' run %d 0 mutant_code (mutant_init fixture_storage %s) = %s.\n'
                    'Proof.\n'
                    ' vm_drive_mut. reflexivity.\n'
                    'Qed.\n' % (fuel, account, expected))

        module = 'VmMutant' + str(index)
        twin = render(parts)
        (work / (module + 'Baseline.v')).write_bytes(twin.encode())
        code, out = kernel(['coqc', '-q', module + 'Baseline.v'], work,
                           work / (module + 'Baseline.log'))
        require(code == 0, 'VM mutant baseline was not accepted: ' + name)
        text = render(mutated)
        (work / (module + '.v')).write_bytes(text.encode())
        code, out = kernel(['coqc', '-q', module + '.v'], work,
                           work / (module + '.log'), success=False)
        require(code != 0 and 'Error' in out, 'VM mutant was not rejected: ' + name)
        reports.append(dict(name=name, getter=getter, mutation=description,
                            definitionsAccepted=True, baselineAccepted=True,
                            proofRejected=True, kernelExitCode=code,
                            baselineSha256=sha(twin.encode()),
                            definitionsSha256=sha(text.encode())))
    return reports


def kernel(command, directory, log, success=True, timeout=3600):
    """Run a kernel command; the timeout is a liveness guard only, not a
    soundness property (the full certificate now carries the VM trace
    theorems of every pinned getter plus a shared callee and can legitimately
    take far longer than the old two-getter lane)."""
    result = subprocess.run(command, cwd=directory, capture_output=True, text=True,
                            timeout=timeout)
    text = result.stdout + result.stderr
    Path(log).write_text(text)
    if success:
        require(result.returncode == 0, 'Kernel command failed: ' + ' '.join(command) + '\n' + text[-3000:])
    return result.returncode, text


MUTANTS = {
    # name -> (method, mutant prefix, mutant default, distinguishing account)
    'swapped-prefix-contract': ('getMarketEscrowContract', '[7%nat]', None, '[1%nat]'),
    'short-default-contract': ('getMarketEscrowContract', None, '(GBytes (zeros 19))', '[1%nat]'),
    'swapped-prefix-listing': ('getMarketEscrowListingId', '[6%nat]', None, '[1%nat]'),
    'wrong-default-listing': ('getMarketEscrowListingId', None, '(GInt 1%Z)', '[3%nat]'),
}


def semantic_controls(bound, work):
    """Kernel rejection of mutated bindings against the original binding.

    The fixture stores payload [5] under key [7;1]. Each control defines both
    the original and the mutated binding and asserts equality on a concrete
    account chosen so the mutation is behavior-distinguishing. Under the
    original binding the assertion compiles (definitional); a distinguishing
    mutant must fail, which the runner requires, so a vacuous or identical
    mutant would compile and fail the lane.
    """
    fixture = ('Definition bytes_eqb (a b : bytes) : bool :=\n'
               '  match list_eq_dec Nat.eq_dec a b with left _ => true | right _ => false end.\n'
               'Definition fixture_storage : storage := fun key =>\n'
               '  if bytes_eqb key [7%nat;1%nat] then Some [5%nat] else None.\n')
    reports = []
    for index, (name, (method, prefix, default, account)) in enumerate(sorted(MUTANTS.items())):
        row = bound['methods'][method]['projection']
        decode = 'decode_integer' if row['decode'] == 'integer' else 'decode_hash160'
        original_prefix = '[' + ';'.join(str(b) + '%nat' for b in row['prefixBytes']) + ']'
        original_default = ('(GInt ' + str(row['default']['value']) + '%Z)'
                            if row['decode'] == 'integer' else '(GBytes hash160_default)')
        module = 'StorageMutant' + str(index)
        definitions = (PRELUDE + fixture +
                       'Definition original_binding (sto : storage) (acct : bytes) : Outcome :=\n'
                       ' getter_outcome ' + original_prefix + ' ' + original_default + ' ' + decode + ' sto acct.\n'
                       'Definition mutant_binding (sto : storage) (acct : bytes) : Outcome :=\n'
                       ' getter_outcome ' + (prefix or original_prefix) + ' '
                       + (default or original_default) + ' ' + decode + ' sto acct.\n')
        (work / (module + '.v')).write_bytes(definitions.encode())
        kernel(['coqc', '-q', module + '.v'], work, work / (module + '.log'))
        reject_module = 'StorageCounterexample' + str(index)
        assertion = (PRELUDE + 'Require Import ' + module + '.\n'
                     'Example mutant_matches_original : mutant_binding fixture_storage ' + account
                     + ' =\n original_binding fixture_storage ' + account + '.\n'
                     'Proof. reflexivity. Qed.\n')
        (work / (reject_module + '.v')).write_bytes(assertion.encode())
        code, text = kernel(['coqc', '-q', reject_module + '.v'], work,
                            work / (reject_module + '.log'), success=False)
        require(code != 0 and 'Error' in text, 'Mutant was not rejected: ' + name)
        reports.append(dict(name=name, method=method, definitionsAccepted=True, proofRejected=True,
                            kernelExitCode=code,
                            definitionsSha256=sha(definitions.encode()),
                            assertionSha256=sha(assertion.encode())))
    require(len(reports) == len(MUTANTS),
            'Every source-level binding mutant must run its control')
    return reports


def run_proofs(inventory, output_dir):
    require(shutil.which('coqc') and shutil.which('coqchk'), 'coqc and coqchk are required')
    tool_paths = [HERE / p for p in ('storage_getter_proofs.py', 'storage_getter_source.py',
                                     'method_source.py', 'nef_decode.py', 'verify.py')]
    tools = {str(p): sha(p.read_bytes()) for p in tool_paths}
    projection = getter_source.project(inventory)
    callee_projection = getter_source.project_callee(inventory)
    bound = bind_entries(inventory, projection, callee_projection)
    script = bytes.fromhex(inventory['nef']['scriptHex'])
    decoded_rows = nef_decode.decode_script(script, len(inventory['nef']['tokens']))
    directory = Path(output_dir)
    require(not directory.exists() or not any(directory.iterdir()),
            'Output directory must be new or empty')
    directory.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='storage-getter-kernel-', dir=directory))
    model_modules = ('IntegerSemantics', MODULE, VM_MODULE)
    models, names = {}, {}
    for module_name in model_modules:
        model = (HERE / 'coq' / (module_name + '.v')).read_bytes()
        require(not re.search(rb'\b(?:Admitted|Axiom|admit|Parameter)\b', model),
                'Model proof escape: ' + module_name)
        models[module_name] = sha(model)
        names[module_name] = declarations(model.decode())
        (work / (module_name + '.v')).write_bytes(model)
        kernel(['coqc', '-q', module_name + '.v'], work, work / (module_name + '.log'))
    model = models[MODULE]
    certificate = render_certificate(bound)
    (work / (MODULE + 'Artifact.v')).write_bytes(certificate.encode())
    artifact = MODULE + 'Artifact'
    names[artifact] = declarations(certificate)
    kernel(['coqc', '-q', artifact + '.v'], work, work / 'artifact.log')
    vm_modules = render_vm_certificate(bound, decoded_rows)
    for module_name, text in vm_modules:
        (work / (module_name + '.v')).write_bytes(text.encode())
        names[module_name] = declarations(text)
        kernel(['coqc', '-q', module_name + '.v'], work,
               work / (module_name + '.log'))
        kernel(['coqchk', '-silent', module_name], work,
               work / (module_name + '.chk.log'))
    full_certificate = certificate + ''.join(text for _, text in vm_modules)
    kernel(['coqchk', '-silent', artifact], work, work / 'coqchk.log')
    closed = names
    checks = ([(module_name + '.log', module_name) for module_name in models]
              + [('artifact.log', artifact)]
              + [(module_name + '.log', module_name) for module_name, _ in vm_modules])
    for filename, module_name in checks:
        text = (work / filename).read_text()
        require(text.count('Closed under the global context') == len(closed[module_name])
                and 'Axioms:' not in text,
                'Assumption inventory not closed: ' + filename)
    controls = semantic_controls(bound, work)
    vm_controls = vm_mutant_controls(bound, decoded_rows, work)
    require(getter_source.project(inventory) == projection, 'Projection changed during proof')
    require(getter_source.project_callee(inventory) == callee_projection,
            'Callee projection changed during proof')
    require(all(sha(Path(p).read_bytes()) == h for p, h in tools.items()), 'Tool changed during proof')
    trace_coverage = {}
    for name, entry in sorted(bound['methods'].items()):
        kind = entry['projection'].get('kind', 'direct')
        if kind in ('direct', 'direct-fixed'):
            trace_coverage[name] = (['miss', 'hit-valid', 'hit-invalid-width']
                                    if entry['projection']['decode'] == 'hash160'
                                    else ['miss', 'hit-integer'])
        elif kind == 'direct-fixed-offset':
            trace_coverage[name] = ['miss', 'hit-offset']
        elif kind == 'direct-raw':
            trace_coverage[name] = ['miss', 'hit']
        elif kind == 'state-field':
            trace_coverage[name] = ['miss-abort', 'hit-projection']
        elif kind == 'state-gt-zero':
            trace_coverage[name] = ['miss-abort', 'hit-projection-compare']
        elif kind == 'presence':
            trace_coverage[name] = ['miss', 'hit']
        elif kind == 'presence-call':
            trace_coverage[name] = ['miss', 'hit']
        elif kind == 'presence-call-item':
            trace_coverage[name] = ['miss', 'hit-projection'
                                    + ('-offset' if 'offset' in entry['projection'] else '')]
        elif kind == 'inline-record-time':
            trace_coverage[name] = ['miss-early-return', 'hit-projection-offset']
        elif kind == 'raw-call-presence':
            trace_coverage[name] = ['miss', 'hit']
        elif kind == 'raw-call-offset':
            trace_coverage[name] = ['miss', 'hit-offset']
    kinds_seen = {}
    for name in bound['methods']:
        total_kind = bound['methods'][name]['projection'].get('kind', 'direct')
        kinds_seen[total_kind] = kinds_seen.get(total_kind, 0) + 1
    kind_labels = {
        'direct': 'keyed storage getters (miss + hit-valid/hit-invalid-width for'
                  ' hash160, miss + hit-integer for integer decode)',
        'direct-fixed': 'fixed-prefix getters with no ABI argument, the key being'
                        ' the pinned prefix itself (miss + hit-valid/'
                        'hit-invalid-width)',
        'direct-fixed-offset': 'fixed-prefix timelock getters with no ABI'
                               ' argument (miss + hit-offset, the decoded'
                               ' timestamp plus the pinned delay constant)',
        'direct-raw': 'raw payload getters (miss + hit, the stored payload'
                      ' returned verbatim with the pinned empty default)',
        'state-field': 'shared GetAccountState field projections'
                       ' (miss-abort + hit-projection)',
        'state-gt-zero': 'the escape predicate (miss-abort +'
                         ' hit-projection-compare)',
        'presence': 'presence getters (miss + hit)',
        'presence-call': 'delegating presence getters reading through the'
                         ' shared GetPendingModuleCallRecord callee (miss + hit)',
        'presence-call-item': 'delegating record projections reading one'
                              ' PendingModuleCall field through the same shared'
                              ' callee (miss + hit-projection; the Time pair'
                              ' additionally adds the pinned timelock, the Hash'
                              ' pair returns the stored CallHash under the pinned'
                              ' zero-length default)',
        'inline-record-time': 'inline epoch getters building their own key and'
                              ' deserializing in place: a miss returns the pinned'
                              ' integer default through the early-return guard, a'
                              ' hit projects one PendingConfigUpdate field and adds'
                              ' the pinned timelock (miss-early-return +'
                              ' hit-projection-offset)',
        'raw-call-presence': 'the delegating raw presence getter'
                             ' (hasMarketEscrowOwnerCancel), which tests the'
                             ' shared reader\'s raw result against null'
                             ' (miss + hit)',
        'raw-call-offset': 'the delegating raw epoch getter'
                           ' (getMarketEscrowOwnerCancelTime), which casts the'
                           ' shared reader\'s raw payload with the pinned'
                           ' decode and adds the pinned timelock'
                           ' (miss + hit-offset)',
    }
    scope_detail = '; '.join('%d %s' % (kinds_seen[k], kind_labels[k])
                             for k in sorted(kinds_seen))
    return dict(schema=SCHEMA, scope=SCOPE, kernelChecked=True, coqchkChecked=True,
                assumptionsClosed=True, fullImplementationVerified=False,
                vmCorrespondenceProven=True,
                vmCorrespondenceScope=(
                    'Trace-level bytecode execution of the %d pinned getter'
                    ' regions plus the shared private callees GetAccountState,'
                    ' GetPendingModuleCallRecord and'
                    ' GetMarketEscrowOwnerCancelInitiated: every reachable behavior'
                    ' class agrees with the source-level outcome in the kernel'
                    ' (%s). Programs, slot targets, call/return frames, callee'
                    ' parameter bindings, syscall pop order and cast widths are'
                    ' rendered from the decoded region bytes; StdLib.Deserialize'
                    ' is a pinned token index whose behavior is a universally'
                    ' quantified oracle, and the escrow owner-cancel accessors'
                    ' (which read their payload verbatim through the shared raw'
                    ' reader and perform no deserialize of their own) consume no'
                    ' token.'
                    ' %d semantic and %d bytecode mutation'
                    ' controls, each bytecode control compiled with an accepted'
                    ' unmutated twin, are rejected by the kernel.'
                    % (len(bound['methods']), scope_detail, len(controls),
                       len(vm_controls))),
                vmTraceCoverage=trace_coverage,
                sharedCallees=[
                    dict(name=entry['name'],
                         regions=[entry['start'], entry['endExclusive']],
                         projectionKinds=sorted(k for k, v in CALLEE_KINDS.items()
                                                if v == entry['name']),
                         deserializeTokenIndex=DESERIALIZE_TOKEN_INDEX)
                    for entry in [bound['callees'][k] for k in sorted(bound['callees'])]],
                dispatchBoundEntrypoints=sorted(bound['methods']),
                referenceVerifiedEntrypoints=[], storageGetterSourceVerified=sorted(bound['methods']),
                fullUnprovedEntrypointCount=len(inventory['manifest']['methods']),
                nefSha256=bound['nefSha256'], scriptSha256=bound['scriptSha256'],
                methods=bound['methods'],
                projectionSha256=getter_source.projection_hash(projection),
                certificateSha256=sha(full_certificate.encode()),
                modelSha256=models, toolInputSha256=tools,
                sourceInputSha256=inventory['inputs'],
                closedDeclarations=closed, semanticControls=controls,
                vmSemanticControls=vm_controls,
                kernelDirectory=str(work), preconditions=[], unproved=UNPROVED, tcb=TCB,
                openObligations=['APPLICATION_ENGINE_REFINEMENT',
                                 'ALL_REMAINING_PUBLIC_ENTRYPOINTS'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--json-report', type=Path, required=True)
    args = parser.parse_args()
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    failure = dict(schema=SCHEMA, scope=SCOPE, kernelChecked=False, status='FAIL',
                   fullImplementationVerified=False, error='Verification has not completed')
    args.json_report.write_text(json.dumps(failure, indent=2) + '\n')
    try:
        raw = args.inventory.read_bytes()
        result = run_proofs(json.loads(raw), args.output_dir)
        require(args.inventory.read_bytes() == raw, 'Inventory changed during proof')
        result['inventorySha256'] = sha(raw)
        args.json_report.write_text(json.dumps(result, indent=2) + '\n')
        return 0
    except Exception as exc:
        failure['error'] = str(exc)
        args.json_report.write_text(json.dumps(failure, indent=2) + '\n')
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
