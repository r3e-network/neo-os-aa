#!/usr/bin/env python3
"""Strict typed-source frontend for the direct storage-key getters.

Fails closed on any operation shape outside the pinned grammar below. Only
`inventory.source` and inventory input bytes are read. This declares what the
C# source computes from a storage mapping; the compiled-bytecode region is
bound for identity only and its execution semantics remain unproved.
"""
import hashlib
import json
try:
    from .method_source import require
except ImportError:
    from method_source import require

CONCAT_CALLEE = 'M:Neo.SmartContract.Framework.Helper.Concat(System.Byte[],System.Byte[])'
STORAGE_GET_CALLEE = 'M:Neo.SmartContract.Framework.Services.Storage.Get(Neo.SmartContract.Framework.Services.StorageContext,System.Byte[])'
CURRENT_CONTEXT_SYMBOL = 'P:Neo.SmartContract.Framework.Services.Storage.CurrentContext'
ASSERT_CALLEE = 'M:Neo.SmartContract.Framework.ExecutionEngine.Assert(System.Boolean,System.String)'
DESERIALIZE_CALLEE = 'M:Neo.SmartContract.Framework.Native.StdLib.Deserialize(Neo.SmartContract.Framework.ByteString)'
GET_ACCOUNT_STATE_CALLEE = 'M:SmartAccount.SmartAccount.GetAccountState(Neo.SmartContract.Framework.UInt160)'
GET_PENDING_MODULE_CALL_RECORD_CALLEE = (
    'M:SmartAccount.SmartAccount.GetPendingModuleCallRecord'
    '(System.Byte[],Neo.SmartContract.Framework.UInt160)')
GET_MARKET_ESCROW_OWNER_CANCEL_INITIATED_CALLEE = (
    'M:SmartAccount.SmartAccount.GetMarketEscrowOwnerCancelInitiated'
    '(Neo.SmartContract.Framework.UInt160)')

SHARED_CALLEES = {
    # Private, debug-only method shared by the state projection getters. It
    # carries no ABI entry; the runner binds it through the debug method table
    # and renders its region once per caller program.
    'getAccountState': dict(
        source_id=GET_ACCOUNT_STATE_CALLEE,
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_AccountState'),
    # Private, debug-only record reader shared by the pending-module-call
    # accessors. Its storage prefix is a *parameter* (the caller passes the
    # pinned prefix field), so the callee declares two ABI-less parameters and
    # the runner pins the caller's operand block to them.
    'getPendingModuleCallRecord': dict(
        source_id=GET_PENDING_MODULE_CALL_RECORD_CALLEE,
        prefix_parameter='prefix',
        account_parameter='accountId'),
    # Private, debug-only raw reader shared by the escrow owner-cancel pair.
    # It concatenates its pinned prefix field with the account argument and
    # returns the raw payload verbatim (no deserialize, so the pair consumes
    # no token oracle), the null item included.
    'getMarketEscrowOwnerCancelInitiated': dict(
        source_id=GET_MARKET_ESCROW_OWNER_CANCEL_INITIATED_CALLEE,
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_MarketEscrowCancelInitiated',
        account_parameter='accountId'),
}

TARGETS = {
    'getMarketEscrowContract': dict(
        source_id='M:SmartAccount.SmartAccount.GetMarketEscrowContract(Neo.SmartContract.Framework.UInt160)',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_MarketEscrowContract',
        prefix_length=1, decode='hash160',
        default={'kind': 'bytes', 'value': [0] * 20},
        data_symbol='market'),
    'getMarketEscrowListingId': dict(
        source_id='M:SmartAccount.SmartAccount.GetMarketEscrowListingId(Neo.SmartContract.Framework.UInt160)',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_MarketEscrowListing',
        prefix_length=None, decode='integer',
        default={'kind': 'integer', 'value': 0},
        data_symbol='listing'),
    # State-projection getters: body is a single return of one AccountState
    # field over the shared callee (or its > 0 comparison for isEscapeActive).
    'getVerifier': dict(
        source_id='M:SmartAccount.SmartAccount.GetVerifier(Neo.SmartContract.Framework.UInt160)',
        kind='state-field',
        field_symbol='F:SmartAccount.SmartAccount.AccountState.Verifier'),
    'getHook': dict(
        source_id='M:SmartAccount.SmartAccount.GetHook(Neo.SmartContract.Framework.UInt160)',
        kind='state-field',
        field_symbol='F:SmartAccount.SmartAccount.AccountState.HookId'),
    'getBackupOwner': dict(
        source_id='M:SmartAccount.SmartAccount.GetBackupOwner(Neo.SmartContract.Framework.UInt160)',
        kind='state-field',
        field_symbol='F:SmartAccount.SmartAccount.AccountState.BackupOwner'),
    'getEscapeTimelock': dict(
        source_id='M:SmartAccount.SmartAccount.GetEscapeTimelock(Neo.SmartContract.Framework.UInt160)',
        kind='state-field',
        field_symbol='F:SmartAccount.SmartAccount.AccountState.EscapeTimelock'),
    'getEscapeTriggeredAt': dict(
        source_id='M:SmartAccount.SmartAccount.GetEscapeTriggeredAt(Neo.SmartContract.Framework.UInt160)',
        kind='state-field',
        field_symbol='F:SmartAccount.SmartAccount.AccountState.EscapeTriggeredAt'),
    'isEscapeActive': dict(
        source_id='M:SmartAccount.SmartAccount.IsEscapeActive(Neo.SmartContract.Framework.UInt160)',
        kind='state-gt-zero',
        field_symbol='F:SmartAccount.SmartAccount.AccountState.EscapeTriggeredAt'),
    # Presence getters: return whether the prefixed storage key is bound.
    'hasPendingVerifierUpdate': dict(
        source_id='M:SmartAccount.SmartAccount.HasPendingVerifierUpdate(Neo.SmartContract.Framework.UInt160)',
        kind='presence',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingVerifierUpdate'),
    'hasPendingHookUpdate': dict(
        source_id='M:SmartAccount.SmartAccount.HasPendingHookUpdate(Neo.SmartContract.Framework.UInt160)',
        kind='presence',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingHookUpdate'),
    'isExecutionActive': dict(
        source_id='M:SmartAccount.SmartAccount.IsExecutionActive(Neo.SmartContract.Framework.UInt160)',
        kind='presence',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_ExecutionLock'),
    # Fixed-prefix getters: no parameter, the storage key is the prefix field.
    'getContractAdmin': dict(
        source_id='M:SmartAccount.SmartAccount.GetContractAdmin',
        kind='direct-fixed', prefix_length=1, decode='hash160',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_ContractAdmin',
        default={'kind': 'bytes', 'value': [0] * 20},
        data_symbol='val'),
    'getPendingContractAdmin': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingContractAdmin',
        kind='direct-fixed', prefix_length=1, decode='hash160',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingContractAdmin',
        default={'kind': 'bytes', 'value': [0] * 20},
        data_symbol='val'),
    'getPlatformRegistrar': dict(
        source_id='M:SmartAccount.SmartAccount.GetPlatformRegistrar',
        kind='direct-fixed', prefix_length=1, decode='hash160',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PlatformRegistrar',
        default={'kind': 'bytes', 'value': [0] * 20},
        data_symbol='value'),
    'getPendingPlatformRegistrar': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingPlatformRegistrar',
        kind='direct-fixed', prefix_length=1, decode='hash160',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingPlatformRegistrar',
        default={'kind': 'bytes', 'value': [0] * 20},
        data_symbol='value'),
    # Fixed-prefix timelock getters: the body reads the bare prefix and, on a
    # hit, returns the decoded timestamp plus the pinned delay constant.
    'getAdminTransferAvailableAt': dict(
        source_id='M:SmartAccount.SmartAccount.GetAdminTransferAvailableAt',
        kind='direct-fixed-offset', prefix_length=1, decode='integer',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_AdminTransferTimelock',
        offset_symbol='F:SmartAccount.SmartAccount.MinUpgradeDelayMs',
        default={'kind': 'integer', 'value': 0},
        data_symbol='timelockData'),
    'getPlatformRegistrarAvailableAt': dict(
        source_id='M:SmartAccount.SmartAccount.GetPlatformRegistrarAvailableAt',
        kind='direct-fixed-offset', prefix_length=1, decode='integer',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PlatformRegistrarTimelock',
        offset_symbol='F:SmartAccount.SmartAccount.MinUpgradeDelayMs',
        default={'kind': 'integer', 'value': 0},
        data_symbol='value'),
    # Raw payload getter: key = prefix ++ accountId, the stored payload is
    # returned verbatim (the ByteString-to-string cast is a VM no-op), with the
    # pinned System.String.Empty default on a miss.
    'getMetadataUri': dict(
        source_id='M:SmartAccount.SmartAccount.GetMetadataUri(Neo.SmartContract.Framework.UInt160)',
        kind='direct-raw', prefix_length=1, decode='bytes',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_MetadataUri',
        default={'kind': 'bytes', 'value': []},
        data_symbol='uri'),
    # Delegating presence getters: the body is a single
    # `return GetPendingModuleCallRecord(<prefix>, accountId) != null;`. The
    # storage key is composed inside the shared callee from the prefix the
    # caller passes, so these bind the callee region instead of an inline key.
    'hasPendingVerifierCall': dict(
        source_id='M:SmartAccount.SmartAccount.HasPendingVerifierCall(Neo.SmartContract.Framework.UInt160)',
        kind='presence-call', callee='getPendingModuleCallRecord',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingVerifierCall'),
    'hasPendingHookCall': dict(
        source_id='M:SmartAccount.SmartAccount.HasPendingHookCall(Neo.SmartContract.Framework.UInt160)',
        kind='presence-call', callee='getPendingModuleCallRecord',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingHookCall'),
    # Delegating record projections: the body is
    # `pending = GetPendingModuleCallRecord(<prefix>, accountId); return
    #  pending == null ? <default> : <pending field>;` (the Time pair adds the
    # pinned ConfigUpdateTimelockMs constant). The field ordinal comes from the
    # PendingModuleCall declaration order and is cross-checked against the
    # bytecode PICKITEM index by the runner.
    'getPendingVerifierCallModule': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingVerifierCallModule(Neo.SmartContract.Framework.UInt160)',
        kind='presence-call-item', callee='getPendingModuleCallRecord',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingVerifierCall',
        item_symbol='F:SmartAccount.SmartAccount.PendingModuleCall.ModuleHash',
        decode='hash160', default={'kind': 'bytes', 'value': [0] * 20}),
    'getPendingHookCallModule': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingHookCallModule(Neo.SmartContract.Framework.UInt160)',
        kind='presence-call-item', callee='getPendingModuleCallRecord',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingHookCall',
        item_symbol='F:SmartAccount.SmartAccount.PendingModuleCall.ModuleHash',
        decode='hash160', default={'kind': 'bytes', 'value': [0] * 20}),
    'getPendingVerifierCallTime': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingVerifierCallTime(Neo.SmartContract.Framework.UInt160)',
        kind='presence-call-item', callee='getPendingModuleCallRecord',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingVerifierCall',
        item_symbol='F:SmartAccount.SmartAccount.PendingModuleCall.InitiatedAt',
        decode='integer', default={'kind': 'integer', 'value': 0},
        offset_symbol='F:SmartAccount.SmartAccount.ConfigUpdateTimelockMs'),
    'getPendingHookCallTime': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingHookCallTime(Neo.SmartContract.Framework.UInt160)',
        kind='presence-call-item', callee='getPendingModuleCallRecord',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingHookCall',
        item_symbol='F:SmartAccount.SmartAccount.PendingModuleCall.InitiatedAt',
        decode='integer', default={'kind': 'integer', 'value': 0},
        offset_symbol='F:SmartAccount.SmartAccount.ConfigUpdateTimelockMs'),
    # The CallHash pair returns the second PendingModuleCall field verbatim. It
    # is a ByteString, so the null branch is the compiled `new byte[0]` (a
    # zero-length allocation, not a push literal) and the projection applies no
    # width contract at all.
    'getPendingVerifierCallHash': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingVerifierCallHash(Neo.SmartContract.Framework.UInt160)',
        kind='presence-call-item', callee='getPendingModuleCallRecord',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingVerifierCall',
        item_symbol='F:SmartAccount.SmartAccount.PendingModuleCall.CallHash',
        decode='raw-bytes', default={'kind': 'empty-bytes'}),
    'getPendingHookCallHash': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingHookCallHash(Neo.SmartContract.Framework.UInt160)',
        kind='presence-call-item', callee='getPendingModuleCallRecord',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingHookCall',
        item_symbol='F:SmartAccount.SmartAccount.PendingModuleCall.CallHash',
        decode='raw-bytes', default={'kind': 'empty-bytes'}),
    # Epoch getters: unlike the record projections above these do not delegate.
    # The body inlines the key concatenation, the read and the deserialize, then
    # returns early on a miss before projecting the pending record's InitiatedAt
    # field and adding the pinned ConfigUpdateTimelockMs delay constant, so the
    # storage key and the deserialize call are both pinned directly in the
    # getter's own region.
    'getPendingVerifierUpdateTime': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingVerifierUpdateTime(Neo.SmartContract.Framework.UInt160)',
        kind='inline-record-time',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingVerifierUpdate',
        record_owner='PendingConfigUpdate',
        item_symbol='F:SmartAccount.SmartAccount.PendingConfigUpdate.InitiatedAt',
        offset_symbol='F:SmartAccount.SmartAccount.ConfigUpdateTimelockMs'),
    'getPendingHookUpdateTime': dict(
        source_id='M:SmartAccount.SmartAccount.GetPendingHookUpdateTime(Neo.SmartContract.Framework.UInt160)',
        kind='inline-record-time',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_PendingHookUpdate',
        record_owner='PendingConfigUpdate',
        item_symbol='F:SmartAccount.SmartAccount.PendingConfigUpdate.InitiatedAt',
        offset_symbol='F:SmartAccount.SmartAccount.ConfigUpdateTimelockMs'),
    # GetVerifyScopeTarget is a standard keyed direct getter over its pinned
    # prefix, projecting the raw payload to a UInt160 with the reviewed
    # 20-byte zero default.
    'getVerifyScopeTarget': dict(
        source_id='M:SmartAccount.SmartAccount.GetVerifyScopeTarget(Neo.SmartContract.Framework.UInt160)',
        prefix_symbol='F:SmartAccount.SmartAccount.Prefix_VerifyScopeTarget',
        prefix_length=1, decode='hash160',
        default={'kind': 'bytes', 'value': [0] * 20},
        data_symbol='value'),
    # Escrow owner-cancel accessors. Both delegate the key build and the raw
    # read to the shared private reader above, so neither caller pins a prefix
    # of its own: the presence accessor tests the raw result against null and
    # the epoch accessor casts it and adds the pinned timelock.
    'hasMarketEscrowOwnerCancel': dict(
        source_id='M:SmartAccount.SmartAccount.HasMarketEscrowOwnerCancel(Neo.SmartContract.Framework.UInt160)',
        kind='raw-call-presence', callee='getMarketEscrowOwnerCancelInitiated'),
    'getMarketEscrowOwnerCancelTime': dict(
        source_id='M:SmartAccount.SmartAccount.GetMarketEscrowOwnerCancelTime(Neo.SmartContract.Framework.UInt160)',
        kind='raw-call-offset', callee='getMarketEscrowOwnerCancelInitiated',
        decode='integer', default={'kind': 'integer', 'value': 0},
        offset_symbol='F:SmartAccount.SmartAccount.MarketEscrowOwnerCancelTimelockMs'),
}


def _children(node):
    return node.get('children', [])


def _symbol(node):
    require(isinstance(node, dict) and node.get('kind') in ('ParameterReference', 'LocalReference',
                                                            'FieldReference', 'PropertyReference'),
            'Expected a bound reference node')
    symbol = node.get('details', {}).get('symbol')
    require(isinstance(symbol, str) and symbol, 'Missing bound symbol')
    return symbol


def _conversion(node, *, identity, nullable):
    require(isinstance(node, dict) and node.get('kind') == 'Conversion', 'Expected conversion node')
    conversion = node.get('details', {}).get('conversion', {})
    require(conversion.get('Exists') is True, 'Missing conversion existence binding')
    require(conversion.get('IsIdentity') is identity, 'Unexpected identity conversion binding')
    require(conversion.get('IsNullable') is nullable, 'Unexpected nullable conversion binding')
    require(node.get('details', {}).get('checked') is False, 'Unexpected checked conversion')
    require(len(_children(node)) == 1, 'Conversion must wrap exactly one operand')
    return _children(node)[0]


def _argument(node, name):
    require(isinstance(node, dict) and node.get('kind') == 'Argument', 'Expected argument node')
    details = node.get('details', {})
    require(details.get('argumentKind') == 'Explicit', 'Unexpected argument kind')
    require(details.get('parameter') == name, 'Unexpected argument parameter binding')
    require(details.get('inConversion', {}).get('Exists') is True, 'Missing argument conversion')
    require(len(_children(node)) == 1, 'Argument must wrap exactly one value')
    return _children(node)[0]


def _literal(node):
    require(isinstance(node, dict) and node.get('kind') == 'Literal', 'Expected literal node')
    constant = node.get('constant')
    require(isinstance(constant, dict) and constant.get('hasValue') is True, 'Literal without value')
    return constant.get('value')


def _concat_binding(node, target):
    """key = Helper.Concat(<prefix field>, (byte[])accountId)."""
    require(isinstance(node, dict) and node.get('kind') == 'Invocation', 'Expected concat invocation')
    require(node.get('details', {}).get('callee') == CONCAT_CALLEE, 'Unexpected concat callee')
    require(node.get('details', {}).get('virtual') is False, 'Unexpected virtual concat dispatch')
    require(len(_children(node)) == 2, 'Concat must have exactly two arguments')
    first = _argument(_children(node)[0], 'first')
    require(_symbol(first) == target['prefix_symbol'], 'Unexpected storage key prefix field')
    second = _argument(_children(node)[1], 'second')
    operand = _conversion(second, identity=False, nullable=False)
    require(_symbol(operand) == 'accountId', 'Concat second operand must be accountId')
    require(isinstance(operand, dict) and operand.get('details', {}).get('ordinal') == 0,
            'AccountId parameter ordinal mismatch')


def _storage_binding(node, key_symbol):
    require(isinstance(node, dict) and node.get('kind') == 'Invocation', 'Expected storage invocation')
    require(node.get('details', {}).get('callee') == STORAGE_GET_CALLEE, 'Unexpected Storage.Get callee')
    require(len(_children(node)) == 2, 'Storage.Get must have exactly two arguments')
    context = _argument(_children(node)[0], 'context')
    require(_symbol(context) == CURRENT_CONTEXT_SYMBOL, 'Storage context must be CurrentContext')
    key = _argument(_children(node)[1], 'key')
    require(_symbol(key) == key_symbol, 'Storage key must be the concatenated local')


UINT160_ZERO_SYMBOL = 'P:Neo.SmartContract.Framework.UInt160.Zero'
BIGINTEGER_ADDITION = ('M:System.Numerics.BigInteger.op_Addition'
                       '(System.Numerics.BigInteger,System.Numerics.BigInteger)')
BYTESTRING_TO_BIGINTEGER = ('M:Neo.SmartContract.Framework.ByteString.op_Explicit'
                            '(Neo.SmartContract.Framework.ByteString)~System.Numerics.BigInteger')
BYTESTRING_TO_STRING = ('M:Neo.SmartContract.Framework.ByteString.op_Implicit'
                        '(Neo.SmartContract.Framework.ByteString)~System.String')
STRING_EMPTY_SYMBOL = 'F:System.String.Empty'


def _conditional_return_raw(node, target):
    """return data == null ? string.Empty : ((string)data);"""
    require(isinstance(node, dict) and node.get('kind') == 'Return', 'Expected return statement')
    require(len(_children(node)) == 1, 'Return must wrap one value')
    conditional = _children(node)[0]
    require(isinstance(conditional, dict) and conditional.get('kind') == 'Conditional',
            'Expected null-coalescing conditional return')
    require(len(_children(conditional)) == 3, 'Conditional must have three branches')
    condition, when_true, when_false = _children(conditional)
    _null_comparison(condition, 'Equals', target['data_symbol'])
    require(isinstance(when_true, dict) and when_true.get('kind') == 'FieldReference' and
            _symbol(when_true) == STRING_EMPTY_SYMBOL,
            'Raw getter default must be System.String.Empty')
    require(isinstance(when_false, dict) and when_false.get('kind') == 'Conversion' and
            len(_children(when_false)) == 1, 'Raw getter else branch must be a conversion')
    conversion = when_false.get('details', {}).get('conversion', {})
    require(conversion.get('Exists') is True and conversion.get('method') == BYTESTRING_TO_STRING,
            'Raw getter else cast must be the pinned ByteString-to-string conversion')
    require(_symbol(_children(when_false)[0]) == target['data_symbol'],
            'Raw getter else branch must return the stored local')


def _offset_addition(node, target, data_symbol):
    """Validate `(BigInteger)data + <pinned offset field>`."""
    require(isinstance(node, dict) and node.get('kind') == 'Binary', 'Expected offset addition')
    details = node.get('details', {})
    require(details.get('operator') == 'Add', 'Offset must be an addition')
    require(details.get('checked') is False and details.get('lifted') is False,
            'Unexpected checked/lifted offset addition')
    require(details.get('operatorMethod') == BIGINTEGER_ADDITION,
            'Offset addition must be the pinned BigInteger addition')
    require(len(_children(node)) == 2, 'Offset addition must have two operands')
    cast = _children(node)[0]
    require(isinstance(cast, dict) and cast.get('kind') == 'Conversion' and
            len(_children(cast)) == 1, 'Offset left operand must be a conversion')
    conversion = cast.get('details', {}).get('conversion', {})
    require(conversion.get('Exists') is True and conversion.get('method') == BYTESTRING_TO_BIGINTEGER,
            'Offset cast must be the pinned ByteString-to-BigInteger conversion')
    require(_symbol(_children(cast)[0]) == data_symbol, 'Offset cast must wrap the stored local')
    offset = _children(node)[1]
    require(_symbol(offset) == target['offset_symbol'], 'Offset field mismatch')


def _conditional_return_offset(node, target):
    """return data == null ? 0 : ((BigInteger)data + <offset field>);"""
    require(isinstance(node, dict) and node.get('kind') == 'Return', 'Expected return statement')
    require(len(_children(node)) == 1, 'Return must wrap one value')
    conditional = _children(node)[0]
    require(isinstance(conditional, dict) and conditional.get('kind') == 'Conditional',
            'Expected null-coalescing conditional return')
    require(len(_children(conditional)) == 3, 'Conditional must have three branches')
    condition, when_true, when_false = _children(conditional)
    _null_comparison(condition, 'Equals', target['data_symbol'])
    default_node = when_true
    if isinstance(default_node, dict) and default_node.get('kind') == 'Conversion':
        require(len(_children(default_node)) == 1, 'Default conversion must wrap one literal')
        default_node = _children(default_node)[0]
    default = _literal(default_node)
    require(isinstance(default, dict) and default.get('runtimeType') == 'System.Int32',
            'Offset getter default must be an Int32 literal')
    require(str(default.get('value')) == str(target['default']['value']),
            'Unexpected offset getter default value')
    _offset_addition(when_false, target, target['data_symbol'])


def resolve_integer_field(inventory, symbol):
    """Evaluate `private static readonly BigInteger <Name> = <int expr>;` from inputs.

    The expression grammar is restricted to decimal literals with an optional
    `L` suffix, parentheses, `+`, `-` and `*`, so the value is an exact integer
    constant with no division, identifier or method reference. Anything else
    aborts the lane (fail closed).
    """
    import re
    from pathlib import Path
    require(symbol.startswith('F:SmartAccount.SmartAccount.'), 'Unexpected integer field owner')
    name = symbol[len('F:SmartAccount.SmartAccount.'):]
    matches = []
    for filename in inventory['inputs']:
        if not filename.endswith('.cs'):
            continue
        try:
            raw = Path(filename).read_text()
        except (OSError, UnicodeDecodeError):
            continue
        here = []
        for match in re.finditer(r'private static readonly BigInteger ' + re.escape(name) +
                                 r' = ([^;]+);', raw):
            expression = match.group(1).strip()
            require(re.fullmatch(r'[0-9L\s()+*-]+', expression) is not None,
                    'Unsupported BigInteger constant expression: ' + expression)
            here.append(eval(expression.replace('L', ''), {'__builtins__': {}}, {}))
        require(len(here) <= 1, 'Ambiguous integer field declaration: ' + name)
        here and matches.append((filename, here[0]))
    require(len(matches) == 1, 'Missing or duplicated integer field declaration: ' + name)
    return matches[0][1]


def _conditional_return(node, target):
    """return data == null ? <default> : ((T)data);"""
    require(isinstance(node, dict) and node.get('kind') == 'Return', 'Expected return statement')
    require(len(_children(node)) == 1, 'Return must wrap one value')
    conditional = _children(node)[0]
    require(isinstance(conditional, dict) and conditional.get('kind') == 'Conditional',
            'Expected null-coalescing conditional return')
    require(len(_children(conditional)) == 3, 'Conditional must have three branches')
    condition, when_true, when_false = _children(conditional)
    require(isinstance(condition, dict) and condition.get('kind') == 'Binary', 'Expected binary condition')
    require(condition.get('details', {}).get('operator') == 'Equals', 'Condition must be equality')
    require(condition.get('details', {}).get('checked') is False, 'Unexpected checked condition')
    require(condition.get('details', {}).get('operatorMethod') is None, 'Unexpected user-defined equality')
    require(len(_children(condition)) == 2, 'Condition must have two operands')
    lhs = _children(condition)[0]
    require(isinstance(lhs, dict) and lhs.get('kind') == 'Conversion' and
            len(_children(lhs)) == 1 and _symbol(_children(lhs)[0]) == target['data_symbol'],
            'Condition must test the stored local')
    rhs = _children(condition)[1]
    require(isinstance(rhs, dict) and rhs.get('kind') == 'Conversion' and len(_children(rhs)) == 1 and
            _literal(_children(rhs)[0]) is None, 'Condition must compare against null')
    if target['decode'] == 'integer':
        default_node = when_true
        if isinstance(default_node, dict) and default_node.get('kind') == 'Conversion':
            require(len(_children(default_node)) == 1, 'Default conversion must wrap one literal')
            default_node = _children(default_node)[0]
        default = _literal(default_node)
        require(isinstance(default, dict) and default.get('runtimeType') == 'System.Int32',
                'Integer getter default must be an Int32 literal')
        value = default.get('value')
        require(isinstance(value, str) and value.lstrip('-').isdigit(), 'Unexpected default literal format')
        require(int(value) == target['default']['value'], 'Unexpected default value')
    else:
        require(isinstance(when_true, dict) and when_true.get('kind') == 'PropertyReference' and
                _symbol(when_true) == UINT160_ZERO_SYMBOL,
                'Hash160 getter default must be UInt160.Zero')
    data = _conversion(when_false, identity=False, nullable=False)
    require(_symbol(data) == target['data_symbol'], 'Else branch must return the stored local')
    return target['default']


def resolve_record_field_index(inventory, owner, field_symbol):
    """Derive a model-class field ordinal from its declaration order.

    The compiled record projections read the field with PICKITEM <i> from the
    deserialized array; the source-side index is derived from the public field
    declaration order of the owner class and the runner cross-checks it against
    the bytecode index, so neither side can drift alone.
    """
    import re
    from pathlib import Path
    prefix = 'F:SmartAccount.SmartAccount.%s.' % owner
    require(field_symbol.startswith(prefix), 'Unexpected record field symbol: ' + field_symbol)
    field_name = field_symbol[len(prefix):]
    require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', field_name) is not None,
            'Unexpected record field name: ' + field_name)
    declaration = r'public class ' + re.escape(owner) + r'\b'
    owners = []
    for filename in inventory['inputs']:
        if not filename.endswith('.cs'):
            continue
        try:
            raw = Path(filename).read_text()
        except (OSError, UnicodeDecodeError):
            continue
        for match in re.finditer(declaration, raw):
            owners.append((filename, match.start()))
    require(len(owners) == 1, 'Missing or ambiguous %s declaration' % owner)
    raw = Path(owners[0][0]).read_text()
    body_start = raw.index('{', owners[0][1])
    depth, cursor = 0, body_start
    for cursor in range(body_start, len(raw)):
        if raw[cursor] == '{':
            depth += 1
        elif raw[cursor] == '}':
            depth -= 1
            if depth == 0:
                break
    require(depth == 0, 'Unterminated %s class body' % owner)
    body = raw[body_start:cursor]
    names = re.findall(r'public\s+[\w<>?\[\].]+\s+(\w+)\s*(?:;|=)', body)
    require(field_name in names, 'Record field not declared in %s: %s' % (owner, field_name))
    require(len(set(names)) == len(names), 'Duplicate %s field name' % owner)
    return names.index(field_name)


def resolve_prefix(inventory, symbol):
    """Parse `private static readonly byte[] <Name> = new byte[] { 0x.., };` from inputs."""
    require(symbol.startswith('F:SmartAccount.SmartAccount.'), 'Unexpected prefix field owner')
    name = symbol[len('F:SmartAccount.SmartAccount.'):]
    matches = []
    for filename in inventory['inputs']:
        if not filename.endswith('.cs'):
            continue
        text = None
        matches_here = []
        try:
            from pathlib import Path
            raw = Path(filename).read_text()
        except (OSError, UnicodeDecodeError):
            continue
        import re
        for match in re.finditer(r'private static readonly byte\[\] ' + re.escape(name) +
                                 r' = new byte\[\] \{ ([0-9xXa-fA-F, ]+) \};', raw):
            parts = [part.strip() for part in match.group(1).split(',') if part.strip()]
            values = []
            for part in parts:
                require(re.fullmatch(r'0x[0-9a-fA-F]{1,2}', part) is not None,
                        'Unsupported prefix byte literal: ' + part)
                values.append(int(part, 16))
            matches_here.append(values)
        require(len(matches_here) <= 1, 'Ambiguous prefix declaration: ' + name)
        matches_here and matches.append((filename, matches_here[0]))
    require(len(matches) == 1, 'Missing or duplicated prefix declaration: ' + name)
    return matches[0][1]


def resolve_state_field_index(inventory, field_symbol):
    """Derive the AccountState field ordinal from its declaration order.

    The compiled state-projection getters read the field with PICKITEM <i>
    from the deserialized state array; the source-side index is derived here
    from the public field declaration order of the AccountState class and the
    runner cross-checks it against the bytecode index.
    """
    import re
    from pathlib import Path
    require(field_symbol.startswith('F:SmartAccount.SmartAccount.AccountState.'),
            'Unexpected state field symbol: ' + field_symbol)
    field_name = field_symbol.rsplit('.', 1)[1]
    owners = []
    for filename in inventory['inputs']:
        if not filename.endswith('.cs'):
            continue
        try:
            raw = Path(filename).read_text()
        except (OSError, UnicodeDecodeError):
            continue
        for match in re.finditer(r'public class AccountState\b', raw):
            owners.append((filename, match.start()))
    require(len(owners) == 1, 'Missing or ambiguous AccountState declaration')
    raw = Path(owners[0][0]).read_text()
    body_start = raw.index('{', owners[0][1])
    depth, cursor = 0, body_start
    for cursor in range(body_start, len(raw)):
        if raw[cursor] == '{':
            depth += 1
        elif raw[cursor] == '}':
            depth -= 1
            if depth == 0:
                break
    require(depth == 0, 'Unterminated AccountState class body')
    body = raw[body_start:cursor]
    names = re.findall(r'public\s+[\w<>?\[\].]+\s+(\w+)\s*(?:;|=)', body)
    require(field_name in names, 'State field not declared in AccountState: ' + field_name)
    require(len(set(names)) == len(names), 'Duplicate AccountState field name')
    return names.index(field_name)


def _key_concat_statement(statement, target):
    """Validate `byte[] key = Helper.Concat(<prefix field>, (byte[])accountId);`."""
    require(statement.get('kind') == 'VariableDeclarationGroup',
            'Expected key declaration group')
    require(len(_children(statement)) == 1, 'Single key declarator expected')
    declaration = _children(statement)[0]
    require(declaration.get('kind') == 'VariableDeclaration', 'Expected variable declaration')
    require(len(_children(declaration)) == 1, 'Single key declarator expected')
    declarator = _children(declaration)[0]
    require(declarator.get('kind') == 'VariableDeclarator', 'Expected declarator')
    require(len(_children(declarator)) == 1, 'Declarator without initializer')
    initializer = _children(declarator)[0]
    require(initializer.get('kind') == 'VariableInitializer' and
            len(_children(initializer)) == 1, 'Expected single initializer value')
    require(declarator.get('details', {}).get('symbol') == 'key', 'Key local must be named key')
    _concat_binding(_children(_children(declarator)[0])[0], target)


def _null_comparison(node, target, data_symbol):
    """Validate Binary(<op>)(Conversion(<data local>), Conversion(Literal null))."""
    require(isinstance(node, dict) and node.get('kind') == 'Binary', 'Expected binary condition')
    require(node.get('details', {}).get('operator') == target, 'Condition must be ' + target)
    require(node.get('details', {}).get('checked') is False, 'Unexpected checked condition')
    require(node.get('details', {}).get('operatorMethod') is None, 'Unexpected user-defined equality')
    require(len(_children(node)) == 2, 'Condition must have two operands')
    lhs = _children(node)[0]
    require(isinstance(lhs, dict) and lhs.get('kind') == 'Conversion' and
            len(_children(lhs)) == 1 and _symbol(_children(lhs)[0]) == data_symbol,
            'Condition must test the stored local')
    rhs = _children(node)[1]
    require(isinstance(rhs, dict) and rhs.get('kind') == 'Conversion' and len(_children(rhs)) == 1 and
            _literal(_children(rhs)[0]) is None, 'Condition must compare against null')


def _account_state_projection(inventory, target):
    """Project the shared GetAccountState callee.

    Grammar: key concat, Storage.Get read, ExecutionEngine.Assert(data !=
    null, message), return (AccountState)StdLib.Deserialize(data). The
    deserialized object is modeled as the token oracle applied to the read
    payload; its internal shape stays abstract (see the lane TCB).
    """
    candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
    require(len(candidates) == 1, 'Missing or ambiguous source method: getAccountState')
    method = candidates[0]
    require(method.get('origin') == 'repository-source', 'Non-repository getter source')
    require(len(method.get('parameters', [])) == 1 and
            method['parameters'][0]['name'] == 'accountId' and
            method['parameters'][0]['ordinal'] == 0, 'Unexpected getter signature')
    body = method['operations'][0]['children'][0]
    require(isinstance(body, dict) and body.get('kind') == 'Block', 'Expected method body block')
    statements = _children(body)
    require(len(statements) == 4, 'Callee body must be key/data/assert/return')
    _key_concat_statement(statements[0], target)
    # data local: Storage.Get(CurrentContext, key)
    statement = statements[1]
    require(statement.get('kind') == 'VariableDeclarationGroup',
            'Expected data declaration group')
    require(len(_children(statement)) == 1, 'Single data declarator expected')
    declaration = _children(statement)[0]
    require(declaration.get('kind') == 'VariableDeclaration', 'Expected variable declaration')
    require(len(_children(declaration)) == 1, 'Single declarator expected')
    declarator = _children(declaration)[0]
    require(declarator.get('kind') == 'VariableDeclarator', 'Expected declarator')
    require(len(_children(declarator)) == 1, 'Declarator without initializer')
    initializer = _children(declarator)[0]
    require(initializer.get('kind') == 'VariableInitializer' and
            len(_children(initializer)) == 1, 'Expected single initializer value')
    require(declarator.get('details', {}).get('symbol') == 'data', 'Data local must be named data')
    _storage_binding(_children(_children(declarator)[0])[0], 'key')
    # assert: ExecutionEngine.Assert(data != null, "message")
    assert_statement = statements[2]
    require(assert_statement.get('kind') == 'ExpressionStatement', 'Expected assert statement')
    require(len(_children(assert_statement)) == 1, 'Assert statement must wrap one expression')
    assert_invocation = _children(assert_statement)[0]
    require(isinstance(assert_invocation, dict) and assert_invocation.get('kind') == 'Invocation',
            'Expected assert invocation')
    require(assert_invocation.get('details', {}).get('callee') == ASSERT_CALLEE,
            'Unexpected assert callee')
    require(len(_children(assert_invocation)) == 2, 'Assert must have condition and message')
    condition = _argument(_children(assert_invocation)[0], 'condition')
    _null_comparison(condition, 'NotEquals', 'data')
    message = _argument(_children(assert_invocation)[1], 'message')
    message_value = _literal(message)
    require(isinstance(message_value, dict) and message_value.get('runtimeType') == 'System.String'
            and isinstance(message_value.get('value'), str) and message_value['value'],
            'Assert message must be a nonempty string literal')
    # return (AccountState)StdLib.Deserialize(data)
    return_statement = statements[3]
    require(return_statement.get('kind') == 'Return', 'Expected return statement')
    require(len(_children(return_statement)) == 1, 'Return must wrap one value')
    conversion = _children(return_statement)[0]
    require(isinstance(conversion, dict) and conversion.get('kind') == 'Conversion',
            'Expected conversion on deserialize result')
    require(conversion.get('details', {}).get('checked') is False, 'Unexpected checked cast')
    require(len(_children(conversion)) == 1, 'Conversion must wrap one operand')
    deserialize = _children(conversion)[0]
    require(isinstance(deserialize, dict) and deserialize.get('kind') == 'Invocation',
            'Expected deserialize invocation')
    require(deserialize.get('details', {}).get('callee') == DESERIALIZE_CALLEE,
            'Unexpected deserialize callee')
    require(deserialize.get('details', {}).get('virtual') is False, 'Unexpected virtual deserialize')
    require(len(_children(deserialize)) == 1, 'Deserialize must have one argument')
    source = _argument(_children(deserialize)[0], 'source')
    require(_symbol(source) == 'data', 'Deserialize source must be the stored local')
    prefix = resolve_prefix(inventory, target['prefix_symbol'])
    return dict(sourceId=target['source_id'], kind='account-state',
                prefixSymbol=target['prefix_symbol'], prefixBytes=prefix,
                assertMessage=message_value['value'])


def _declaration_value(statement, symbol):
    """Unwrap `var <symbol> = <value>;` and return the initializer expression."""
    require(isinstance(statement, dict) and statement.get('kind') == 'VariableDeclarationGroup',
            'Expected local declaration group')
    require(len(_children(statement)) == 1, 'Single declarator expected')
    declaration = _children(statement)[0]
    require(declaration.get('kind') == 'VariableDeclaration', 'Expected variable declaration')
    require(len(_children(declaration)) == 1, 'Single declarator expected')
    declarator = _children(declaration)[0]
    require(declarator.get('kind') == 'VariableDeclarator', 'Expected declarator')
    require(len(_children(declarator)) == 1, 'Declarator without initializer')
    initializer = _children(declarator)[0]
    require(initializer.get('kind') == 'VariableInitializer' and
            len(_children(initializer)) == 1, 'Expected single initializer value')
    require(declarator.get('details', {}).get('symbol') == symbol,
            'Local symbol mismatch: ' + symbol)
    return _children(initializer)[0]


def _parameter_concat_binding(node, target):
    """key = Helper.Concat(<prefix parameter>, (byte[])<account parameter>)."""
    require(isinstance(node, dict) and node.get('kind') == 'Invocation', 'Expected concat invocation')
    require(node.get('details', {}).get('callee') == CONCAT_CALLEE, 'Unexpected concat callee')
    require(node.get('details', {}).get('virtual') is False, 'Unexpected virtual concat dispatch')
    require(len(_children(node)) == 2, 'Concat must have exactly two arguments')
    first = _argument(_children(node)[0], 'first')
    require(_symbol(first) == target['prefix_parameter'] and
            first.get('details', {}).get('ordinal') == 0,
            'Concat prefix operand must be the first callee parameter')
    second = _argument(_children(node)[1], 'second')
    operand = _conversion(second, identity=False, nullable=False)
    require(_symbol(operand) == target['account_parameter'],
            'Concat second operand must be the account parameter')
    require(operand.get('details', {}).get('ordinal') == 1,
            'Concat account parameter ordinal mismatch')


def _pending_module_call_record_projection(inventory, target):
    """Project the shared GetPendingModuleCallRecord callee.

    Grammar: key = Helper.Concat(prefix, (byte[])accountId); data =
    Storage.Get(CurrentContext, key); if (data == null) return null; return
    (PendingModuleCall)StdLib.Deserialize(data). Both operands of the key
    concat are callee parameters, so this callee carries no pinned prefix of
    its own; the caller's operand block is pinned to the parameter list by
    the runner. The deserialized record is modeled as the token oracle
    applied to the read payload; its internal shape stays abstract (see the
    lane TCB), so the callee's observable behavior is exactly
    "key bound => deserialize payload, key unbound => null".
    """
    candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
    require(len(candidates) == 1,
            'Missing or ambiguous source method: getPendingModuleCallRecord')
    method = candidates[0]
    require(method.get('origin') == 'repository-source', 'Non-repository callee source')
    parameters = method.get('parameters', [])
    require(len(parameters) == 2 and
            parameters[0]['name'] == target['prefix_parameter'] and
            parameters[0]['ordinal'] == 0 and
            parameters[1]['name'] == target['account_parameter'] and
            parameters[1]['ordinal'] == 1, 'Unexpected callee signature')
    body = method['operations'][0]['children'][0]
    require(isinstance(body, dict) and body.get('kind') == 'Block', 'Expected method body block')
    statements = _children(body)
    require(len(statements) == 4, 'Callee body must be key/data/guard/return')
    _parameter_concat_binding(_declaration_value(statements[0], 'key'), target)
    _storage_binding(_declaration_value(statements[1], 'data'), 'key')
    guard = statements[2]
    require(isinstance(guard, dict) and guard.get('kind') == 'Conditional',
            'Expected the callee null guard')
    require(len(_children(guard)) == 2, 'Callee guard must be a single-branch if')
    condition, when_true = _children(guard)
    _null_comparison(condition, 'Equals', 'data')
    require(isinstance(when_true, dict) and when_true.get('kind') == 'Return' and
            len(_children(when_true)) == 1, 'Callee guard must return the null default')
    guard_value = _children(when_true)[0]
    require(isinstance(guard_value, dict) and guard_value.get('kind') == 'Conversion' and
            len(_children(guard_value)) == 1 and _literal(_children(guard_value)[0]) is None,
            'Callee guard must return null')
    return_statement = statements[3]
    require(return_statement.get('kind') == 'Return', 'Expected return statement')
    require(len(_children(return_statement)) == 1, 'Return must wrap one value')
    conversion = _children(return_statement)[0]
    require(isinstance(conversion, dict) and conversion.get('kind') == 'Conversion' and
            conversion.get('details', {}).get('checked') is False and
            len(_children(conversion)) == 1, 'Expected conversion on deserialize result')
    deserialize = _children(conversion)[0]
    require(isinstance(deserialize, dict) and deserialize.get('kind') == 'Invocation',
            'Expected deserialize invocation')
    require(deserialize.get('details', {}).get('callee') == DESERIALIZE_CALLEE,
            'Unexpected deserialize callee')
    require(deserialize.get('details', {}).get('virtual') is False, 'Unexpected virtual deserialize')
    require(len(_children(deserialize)) == 1, 'Deserialize must have one argument')
    source = _argument(_children(deserialize)[0], 'source')
    require(_symbol(source) == 'data', 'Deserialize source must be the read local')
    return dict(sourceId=target['source_id'], kind='module-call-record',
                prefixParameter=target['prefix_parameter'],
                accountParameter=target['account_parameter'],
                nullOnMissingKey=True)


def _pending_module_call_invocation(node, target):
    """`GetPendingModuleCallRecord(<prefix field>, accountId)` argument binding."""
    require(isinstance(node, dict) and node.get('kind') == 'Invocation',
            'Expected the shared record callee invocation')
    require(node.get('details', {}).get('callee') ==
            SHARED_CALLEES[target['callee']]['source_id'], 'Unexpected record callee')
    require(node.get('details', {}).get('virtual') is False,
            'Unexpected virtual record callee dispatch')
    require(len(_children(node)) == 2, 'Record callee must take two arguments')
    prefix = _argument(_children(node)[0], 'prefix')
    require(isinstance(prefix, dict) and prefix.get('kind') == 'FieldReference' and
            _symbol(prefix) == target['prefix_symbol'], 'Unexpected record prefix field')
    account = _argument(_children(node)[1], 'accountId')
    require(_symbol(account) == 'accountId' and account.get('details', {}).get('ordinal') == 0,
            'AccountId parameter ordinal mismatch')
    return node


def _pending_module_call_guard(node, target):
    """`return GetPendingModuleCallRecord(<prefix field>, accountId) != null;`."""
    require(isinstance(node, dict) and node.get('kind') == 'Return', 'Expected return statement')
    require(len(_children(node)) == 1, 'Return must wrap one value')
    condition = _children(node)[0]
    require(isinstance(condition, dict) and condition.get('kind') == 'Binary',
            'Expected presence binary condition')
    require(condition.get('details', {}).get('operator') == 'NotEquals',
            'Presence condition must be NotEquals')
    require(condition.get('details', {}).get('checked') is False,
            'Unexpected checked condition')
    require(condition.get('details', {}).get('operatorMethod') is None,
            'Unexpected user-defined equality')
    require(len(_children(condition)) == 2, 'Condition must have two operands')
    lhs = _children(condition)[0]
    require(isinstance(lhs, dict) and lhs.get('kind') == 'Conversion' and
            len(_children(lhs)) == 1, 'Presence lhs must be a conversion')
    _pending_module_call_invocation(_children(lhs)[0], target)
    rhs = _children(condition)[1]
    require(isinstance(rhs, dict) and rhs.get('kind') == 'Conversion' and
            len(_children(rhs)) == 1 and
            _literal(_children(rhs)[0]) is None, 'Presence rhs must be null')


def _record_default(node, target):
    """Validate the record projection's null-branch default."""
    if target['decode'] == 'hash160':
        require(target['default'] == {'kind': 'bytes', 'value': [0] * 20},
                'Record hash160 default table mismatch')
        require(isinstance(node, dict) and node.get('kind') == 'PropertyReference' and
                _symbol(node) == UINT160_ZERO_SYMBOL,
                'Record hash160 default must be UInt160.Zero')
        return
    if target['decode'] == 'raw-bytes':
        # `(ByteString)new byte[0]`: an explicit ByteString cast of a
        # zero-length array allocation, so the node is a Conversion wrapping
        # an ArrayCreation whose single child is the Int32 length literal.
        require(target['default'] == {'kind': 'empty-bytes'},
                'Record empty-bytes default table mismatch')
        require(isinstance(node, dict) and node.get('kind') == 'Conversion' and
                len(_children(node)) == 1, 'Empty-bytes default must be a conversion')
        allocation = _children(node)[0]
        require(isinstance(allocation, dict) and allocation.get('kind') == 'ArrayCreation' and
                len(_children(allocation)) == 1,
                'Empty-bytes default must be a zero-length array allocation')
        value = _literal(_children(allocation)[0])
        require(isinstance(value, dict) and value.get('runtimeType') == 'System.Int32' and
                str(value.get('value')) == '0',
                'Empty-bytes default must allocate exactly zero bytes')
        return
    require(target['decode'] == 'integer', 'Unsupported record projection decode')
    literal_node = node
    if isinstance(literal_node, dict) and literal_node.get('kind') == 'Conversion':
        require(len(_children(literal_node)) == 1, 'Default conversion must wrap one literal')
        literal_node = _children(literal_node)[0]
    value = _literal(literal_node)
    require(isinstance(value, dict) and value.get('runtimeType') == 'System.Int32',
            'Record integer default must be an Int32 literal')
    require(str(value.get('value')) == str(target['default']['value']),
            'Unexpected record integer default value')


def _record_field_access(node, target):
    """`pending.<field>` read off the deserialized record local."""
    require(isinstance(node, dict) and node.get('kind') == 'FieldReference',
            'Record projection must read a field')
    require(_symbol(node) == target['item_symbol'], 'Record projection field mismatch')
    require(len(_children(node)) == 1, 'Record field must wrap its instance')
    inner = _children(node)[0]
    require(isinstance(inner, dict) and inner.get('kind') == 'LocalReference' and
            inner.get('details', {}).get('symbol') == 'pending',
            'Record field must be read from the deserialized local')


def _record_offset_addition(node, target):
    """`pending.<field> + <pinned offset field>`; returns the field read."""
    require(isinstance(node, dict) and node.get('kind') == 'Binary',
            'Expected record offset addition')
    details = node.get('details', {})
    require(details.get('operator') == 'Add', 'Record offset must be an addition')
    require(details.get('checked') is False and details.get('lifted') is False,
            'Unexpected checked/lifted record offset addition')
    require(details.get('operatorMethod') == BIGINTEGER_ADDITION,
            'Record offset addition must be the pinned BigInteger addition')
    require(len(_children(node)) == 2, 'Record offset addition must have two operands')
    left, right = _children(node)
    require(_symbol(right) == target['offset_symbol'], 'Record offset field mismatch')
    return left


def _conditional_return_item(node, target):
    """`return pending == null ? <default> : <pending field> [ + offset ];`"""
    require(isinstance(node, dict) and node.get('kind') == 'Return', 'Expected return statement')
    require(len(_children(node)) == 1, 'Return must wrap one value')
    conditional = _children(node)[0]
    require(isinstance(conditional, dict) and conditional.get('kind') == 'Conditional',
            'Expected null-coalescing conditional return')
    require(len(_children(conditional)) == 3, 'Conditional must have three branches')
    condition, when_true, when_false = _children(conditional)
    _null_comparison(condition, 'Equals', 'pending')
    _record_default(when_true, target)
    projection = when_false
    if target.get('offset_symbol'):
        projection = _record_offset_addition(when_false, target)
    _record_field_access(projection, target)


def _early_return_default(node, target):
    """`if (data == null) return 0;` — the compiled two-child Conditional.

    The source guard is written without braces and without an else branch, so
    the node carries exactly the condition and one Return. The returned value
    is the pinned integer default: the source writes a bare Int32 literal and
    the compiler wraps it in the implicit BigInteger conversion, so the check
    accepts the optional conversion and then requires the literal itself.
    """
    require(isinstance(node, dict) and node.get('kind') == 'Conditional',
            'Expected the early-return guard')
    require(len(_children(node)) == 2, 'Early-return guard must have no else branch')
    condition, when_true = _children(node)
    _null_comparison(condition, 'Equals', 'data')
    require(isinstance(when_true, dict) and when_true.get('kind') == 'Return',
            'Guard branch must return')
    require(len(_children(when_true)) == 1, 'Return must wrap one value')
    value = _children(when_true)[0]
    if isinstance(value, dict) and value.get('kind') == 'Conversion':
        require(len(_children(value)) == 1, 'Default conversion must wrap one literal')
        value = _children(value)[0]
    literal = _literal(value)
    require(isinstance(literal, dict) and literal.get('runtimeType') == 'System.Int32' and
            str(literal.get('value')) == str(target['default']['value']),
            'Early-return default must be the pinned Int32 literal')


def _record_deserialize(node):
    """`pending = (Owner)StdLib.Deserialize(data);` — the pinned record binding.

    The reference conversion of the framework deserialize call. The
    null-forgiving `data!` the source writes produces no operation node (it is
    a compile-time suppression), so the call argument is the bare stored local.
    """
    require(isinstance(node, dict) and node.get('kind') == 'Conversion' and
            len(_children(node)) == 1, 'Record binding must be a conversion')
    conversion = node.get('details', {}).get('conversion', {})
    require(conversion.get('Exists') is True and conversion.get('IsUserDefined') is False and
            conversion.get('IsReference') is True,
            'Record binding must be the pinned reference conversion')
    require(node.get('details', {}).get('checked') is False, 'Unexpected checked conversion')
    invocation = _children(node)[0]
    require(isinstance(invocation, dict) and invocation.get('kind') == 'Invocation' and
            invocation.get('details', {}).get('callee') == DESERIALIZE_CALLEE,
            'Record binding must call the pinned deserialize')
    require(invocation.get('details', {}).get('virtual') is False,
            'Unexpected virtual deserialize dispatch')
    require(len(_children(invocation)) == 1, 'Deserialize must take exactly one argument')
    source = _argument(_children(invocation)[0], 'source')
    require(_symbol(source) == 'data', 'Deserialize source must be the stored local')


def _record_offset_return(node, target):
    """`return pending.<field> + <pinned delay field>;`"""
    require(isinstance(node, dict) and node.get('kind') == 'Return', 'Expected return statement')
    require(len(_children(node)) == 1, 'Return must wrap one value')
    addition = _children(node)[0]
    require(isinstance(addition, dict) and addition.get('kind') == 'Binary',
            'Expected the record offset addition')
    details = addition.get('details', {})
    require(details.get('operator') == 'Add', 'Record offset must be an addition')
    require(details.get('checked') is False and details.get('lifted') is False,
            'Unexpected checked/lifted record offset addition')
    require(details.get('operatorMethod') == BIGINTEGER_ADDITION,
            'Record offset addition must be the pinned BigInteger addition')
    require(len(_children(addition)) == 2, 'Record offset addition must have two operands')
    left, right = _children(addition)
    require(_symbol(right) == target['offset_symbol'], 'Record offset field mismatch')
    _record_field_access(left, target)


def _state_projection_statement(statement, target):
    """Validate `return GetAccountState(accountId)<suffix>` statement trees."""
    require(statement.get('kind') == 'Return', 'Expected single return statement')
    require(len(_children(statement)) == 1, 'Return must wrap one value')
    return _children(statement)[0]


def _state_field_access(node, target):
    """Validate FieldReference(<field>) wrapping GetAccountState(accountId)."""
    require(isinstance(node, dict) and node.get('kind') == 'FieldReference',
            'Expected field access on the account state')
    require(_symbol(node) == target['field_symbol'], 'Unexpected account state field')
    require(len(_children(node)) == 1, 'Field access must wrap the callee call')
    invocation = _children(node)[0]
    require(isinstance(invocation, dict) and invocation.get('kind') == 'Invocation',
            'Expected callee invocation')
    require(invocation.get('details', {}).get('callee') == GET_ACCOUNT_STATE_CALLEE,
            'Unexpected account state callee')
    require(invocation.get('details', {}).get('virtual') is False, 'Unexpected virtual callee dispatch')
    require(len(_children(invocation)) == 1, 'Callee must receive exactly the account argument')
    account = _children(invocation)[0]
    require(account.get('kind') == 'Argument', 'Expected argument node')
    require(account.get('details', {}).get('parameter') == 'accountId', 'Unexpected callee argument')
    require(len(_children(account)) == 1, 'Argument must wrap one value')
    operand = _children(account)[0]
    require(_symbol(operand) == 'accountId' and operand.get('details', {}).get('ordinal') == 0,
            'AccountId parameter ordinal mismatch')


def _single_argument_callee(node, target):
    """`GetMarketEscrowOwnerCancelInitiated(accountId)` argument binding."""
    require(isinstance(node, dict) and node.get('kind') == 'Invocation',
            'Expected the shared raw reader invocation')
    require(node.get('details', {}).get('callee') == SHARED_CALLEES[target['callee']]['source_id'],
            'Unexpected shared raw reader')
    require(node.get('details', {}).get('virtual') is False,
            'Unexpected virtual raw reader dispatch')
    require(len(_children(node)) == 1, 'Shared raw reader takes exactly the account argument')
    account = _children(node)[0]
    require(account.get('kind') == 'Argument' and
            account.get('details', {}).get('parameter') == 'accountId',
            'Unexpected raw reader argument')
    require(len(_children(account)) == 1, 'Argument must wrap one value')
    operand = _children(account)[0]
    require(_symbol(operand) == 'accountId' and operand.get('details', {}).get('ordinal') == 0,
            'AccountId parameter ordinal mismatch')


def _market_escrow_owner_cancel_projection(inventory, target):
    """Project the shared GetMarketEscrowOwnerCancelInitiated callee.

    Grammar: key = Helper.Concat(<prefix field>, (byte[])accountId); return
    Storage.Get(CurrentContext, key). The raw payload is returned verbatim,
    the null item included (no guard, no deserialize), so this callee consumes
    no token oracle: its observable behavior is exactly "the stored payload
    when the key is bound, otherwise null".
    """
    candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
    require(len(candidates) == 1,
            'Missing or ambiguous source method: getMarketEscrowOwnerCancelInitiated')
    method = candidates[0]
    require(method.get('origin') == 'repository-source', 'Non-repository callee source')
    parameters = method.get('parameters', [])
    require(len(parameters) == 1 and parameters[0]['name'] == target['account_parameter'] and
            parameters[0]['ordinal'] == 0, 'Unexpected callee signature')
    body = method['operations'][0]['children'][0]
    require(isinstance(body, dict) and body.get('kind') == 'Block', 'Expected method body block')
    statements = _children(body)
    require(len(statements) == 2, 'Callee body must be key/return')
    _concat_binding(_declaration_value(statements[0], 'key'), target)
    return_statement = statements[1]
    require(return_statement.get('kind') == 'Return', 'Expected the raw read return')
    require(len(_children(return_statement)) == 1, 'Return must wrap one value')
    _storage_binding(_children(return_statement)[0], 'key')
    return dict(sourceId=target['source_id'], kind='raw-reader',
                prefixSymbol=target['prefix_symbol'],
                prefixBytes=resolve_prefix(inventory, target['prefix_symbol']),
                accountParameter=target['account_parameter'],
                nullOnMissingKey=True)


def project(inventory):
    """Project all pinned getters into the lane IR, dispatching on kind."""
    result = {}
    for name, target in TARGETS.items():
        if 'kind' not in target or target['kind'] == 'direct-raw':
            candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
            require(len(candidates) == 1, 'Missing or ambiguous source method: ' + name)
            method = candidates[0]
            require(method.get('origin') == 'repository-source', 'Non-repository getter source')
            require(len(method.get('parameters', [])) == 1 and
                    method['parameters'][0]['name'] == 'accountId' and
                    method['parameters'][0]['ordinal'] == 0, 'Unexpected getter signature')
            body = method['operations'][0]['children'][0]
            require(isinstance(body, dict) and body.get('kind') == 'Block', 'Expected method body block')
            statements = _children(body)
            require(len(statements) == 3, 'Getter body must be key/data/return')
            declarations = []
            for statement in statements[:2]:
                require(statement.get('kind') == 'VariableDeclarationGroup', 'Expected local declaration group')
                require(len(_children(statement)) == 1, 'Single declarator expected')
                declaration = _children(statement)[0]
                require(declaration.get('kind') == 'VariableDeclaration', 'Expected variable declaration')
                require(len(_children(declaration)) == 1, 'Single declarator expected')
                declarations.append(_children(declaration)[0])
            key_declarator, data_declarator = declarations
            for declarator in (key_declarator, data_declarator):
                require(declarator.get('kind') == 'VariableDeclarator', 'Expected declarator')
                require(len(_children(declarator)) == 1, 'Declarator without initializer')
                initializer = _children(declarator)[0]
                require(initializer.get('kind') == 'VariableInitializer' and
                        len(_children(initializer)) == 1, 'Expected single initializer value')

            def declarator_value(declarator):
                return _children(_children(declarator)[0])[0]

            require(key_declarator.get('details', {}).get('symbol') == 'key', 'Key local must be named key')
            require(data_declarator.get('details', {}).get('symbol') == target['data_symbol'],
                    'Data local symbol mismatch')
            _concat_binding(declarator_value(key_declarator), target)
            _storage_binding(declarator_value(data_declarator), 'key')
            if target.get('kind') == 'direct-raw':
                _conditional_return_raw(statements[2], target)
            else:
                _conditional_return(statements[2], target)
            prefix = resolve_prefix(inventory, target['prefix_symbol'])
            require(target['prefix_length'] is None or len(prefix) == target['prefix_length'],
                    'Unexpected prefix width for ' + name)
            projected = dict(sourceId=target['source_id'], prefixSymbol=target['prefix_symbol'],
                             prefixBytes=prefix, decode=target['decode'], default=target['default'])
            if target.get('kind') == 'direct-raw':
                projected['kind'] = 'direct-raw'
            result[name] = projected
        elif target['kind'] in ('state-field', 'state-gt-zero'):
            candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
            require(len(candidates) == 1, 'Missing or ambiguous source method: ' + name)
            method = candidates[0]
            require(method.get('origin') == 'repository-source', 'Non-repository getter source')
            require(len(method.get('parameters', [])) == 1 and
                    method['parameters'][0]['name'] == 'accountId' and
                    method['parameters'][0]['ordinal'] == 0, 'Unexpected getter signature')
            body = method['operations'][0]['children'][0]
            require(isinstance(body, dict) and body.get('kind') == 'Block', 'Expected method body block')
            statements = _children(body)
            require(len(statements) == 1, 'Projection getter body must be a single return')
            expression = _state_projection_statement(statements[0], target)
            if target['kind'] == 'state-gt-zero':
                # EscapeTriggeredAt > 0: right side is a converted zero literal.
                require(expression.get('kind') == 'Binary', 'Expected greater-than-zero comparison')
                require(expression.get('details', {}).get('operator') == 'GreaterThan',
                        'Expected greater-than-zero comparison')
                require(expression.get('details', {}).get('checked') is False,
                        'Unexpected checked comparison')
                require(len(_children(expression)) == 2, 'Comparison must have two operands')
                _state_field_access(_children(expression)[0], target)
                zero = _children(expression)[1]
                require(isinstance(zero, dict) and zero.get('kind') == 'Conversion' and
                        len(_children(zero)) == 1, 'Expected conversion on zero literal')
                zero_value = _literal(_children(zero)[0])
                require(isinstance(zero_value, dict) and
                        zero_value.get('runtimeType') in ('System.Int32', 'System.Int64') and
                        str(zero_value.get('value')) == '0', 'Comparison must be against zero')
            else:
                _state_field_access(expression, target)
            result[name] = dict(sourceId=target['source_id'], kind=target['kind'],
                                callee='getAccountState',
                                fieldSymbol=target['field_symbol'],
                                fieldIndex=resolve_state_field_index(inventory, target['field_symbol']))
        elif target['kind'] in ('direct-fixed', 'direct-fixed-offset'):
            # Fixed-prefix getters: the storage key is the prefix field itself
            # (no accountId concatenation), the body reads it once and returns
            # the decoded value with the pinned default on a miss. The offset
            # variant additionally adds the pinned delay constant on a hit.
            candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
            require(len(candidates) == 1, 'Missing or ambiguous source method: ' + name)
            method = candidates[0]
            require(method.get('origin') == 'repository-source', 'Non-repository getter source')
            require(len(method.get('parameters', [])) == 0,
                    'Fixed-prefix getter must take no parameters')
            body = method['operations'][0]['children'][0]
            require(isinstance(body, dict) and body.get('kind') == 'Block', 'Expected method body block')
            statements = _children(body)
            require(len(statements) == 2, 'Fixed getter body must be data/return')
            statement = statements[0]
            require(statement.get('kind') == 'VariableDeclarationGroup',
                    'Expected data declaration group')
            require(len(_children(statement)) == 1, 'Single data declarator expected')
            declaration = _children(statement)[0]
            require(declaration.get('kind') == 'VariableDeclaration', 'Expected variable declaration')
            require(len(_children(declaration)) == 1, 'Single declarator expected')
            declarator = _children(declaration)[0]
            require(declarator.get('kind') == 'VariableDeclarator', 'Expected declarator')
            require(len(_children(declarator)) == 1, 'Declarator without initializer')
            initializer = _children(declarator)[0]
            require(initializer.get('kind') == 'VariableInitializer' and
                    len(_children(initializer)) == 1, 'Expected single initializer value')
            data_symbol = declarator.get('details', {}).get('symbol')
            require(isinstance(data_symbol, str) and data_symbol, 'Data local must be named')
            _storage_binding(_children(_children(declarator)[0])[0], target['prefix_symbol'])
            shaped = dict(target, data_symbol=data_symbol)
            if target['kind'] == 'direct-fixed-offset':
                _conditional_return_offset(statements[1], shaped)
            else:
                _conditional_return(statements[1], shaped)
            prefix = resolve_prefix(inventory, target['prefix_symbol'])
            require(target.get('prefix_length') is None or len(prefix) == target['prefix_length'],
                    'Unexpected prefix width for ' + name)
            projected = dict(sourceId=target['source_id'], kind=target['kind'],
                             prefixSymbol=target['prefix_symbol'], prefixBytes=prefix,
                             decode=target['decode'], default=target['default'])
            if target['kind'] == 'direct-fixed-offset':
                projected['offset'] = resolve_integer_field(inventory, target['offset_symbol'])
                projected['offsetSymbol'] = target['offset_symbol']
            result[name] = projected
        elif target['kind'] == 'presence':
            candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
            require(len(candidates) == 1, 'Missing or ambiguous source method: ' + name)
            method = candidates[0]
            require(method.get('origin') == 'repository-source', 'Non-repository getter source')
            require(len(method.get('parameters', [])) == 1 and
                    method['parameters'][0]['name'] == 'accountId' and
                    method['parameters'][0]['ordinal'] == 0, 'Unexpected getter signature')
            body = method['operations'][0]['children'][0]
            require(isinstance(body, dict) and body.get('kind') == 'Block', 'Expected method body block')
            statements = _children(body)
            require(len(statements) == 2, 'Presence getter body must be key/return')
            _key_concat_statement(statements[0], target)
            return_statement = statements[1]
            require(return_statement.get('kind') == 'Return', 'Expected return statement')
            require(len(_children(return_statement)) == 1, 'Return must wrap one value')
            condition = _children(return_statement)[0]
            require(isinstance(condition, dict) and condition.get('kind') == 'Binary',
                    'Expected presence binary condition')
            require(condition.get('details', {}).get('operator') == 'NotEquals',
                    'Presence condition must be NotEquals')
            require(condition.get('details', {}).get('checked') is False,
                    'Unexpected checked condition')
            require(condition.get('details', {}).get('operatorMethod') is None,
                    'Unexpected user-defined equality')
            require(len(_children(condition)) == 2, 'Condition must have two operands')
            lhs = _children(condition)[0]
            require(isinstance(lhs, dict) and lhs.get('kind') == 'Conversion' and
                    len(_children(lhs)) == 1, 'Presence lhs must be a conversion')
            _storage_binding(_children(lhs)[0], 'key')
            rhs = _children(condition)[1]
            require(isinstance(rhs, dict) and rhs.get('kind') == 'Conversion' and
                    len(_children(rhs)) == 1 and
                    _literal(_children(rhs)[0]) is None, 'Presence rhs must be null')
            prefix = resolve_prefix(inventory, target['prefix_symbol'])
            result[name] = dict(sourceId=target['source_id'], kind='presence',
                                prefixSymbol=target['prefix_symbol'], prefixBytes=prefix)
        elif target['kind'] == 'presence-call':
            # Delegating presence getters: the body is one
            # `return GetPendingModuleCallRecord(<prefix>, accountId) != null;`.
            # The storage key is composed inside the shared callee, so the
            # projection records the caller's pinned prefix plus the callee it
            # delegates to; the semantics is the same presence predicate as the
            # inline `presence` family, relative to the deserialize oracle.
            candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
            require(len(candidates) == 1, 'Missing or ambiguous source method: ' + name)
            method = candidates[0]
            require(method.get('origin') == 'repository-source', 'Non-repository getter source')
            require(len(method.get('parameters', [])) == 1 and
                    method['parameters'][0]['name'] == 'accountId' and
                    method['parameters'][0]['ordinal'] == 0, 'Unexpected getter signature')
            body = method['operations'][0]['children'][0]
            require(isinstance(body, dict) and body.get('kind') == 'Block', 'Expected method body block')
            statements = _children(body)
            require(len(statements) == 1, 'Delegating presence getter body must be a single return')
            _pending_module_call_guard(statements[0], target)
            prefix = resolve_prefix(inventory, target['prefix_symbol'])
            result[name] = dict(sourceId=target['source_id'], kind='presence-call',
                                callee=target['callee'],
                                prefixSymbol=target['prefix_symbol'], prefixBytes=prefix)
        elif target['kind'] == 'presence-call-item':
            # Delegating record projections: two statements, a local bound to
            # the shared record callee and one null-coalescing return of a
            # record field (plus the pinned timelock for the Time pair). The
            # field ordinal is derived from the PendingModuleCall declaration
            # order; the runner cross-checks it against the bytecode PICKITEM.
            candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
            require(len(candidates) == 1, 'Missing or ambiguous source method: ' + name)
            method = candidates[0]
            require(method.get('origin') == 'repository-source', 'Non-repository getter source')
            require(len(method.get('parameters', [])) == 1 and
                    method['parameters'][0]['name'] == 'accountId' and
                    method['parameters'][0]['ordinal'] == 0, 'Unexpected getter signature')
            body = method['operations'][0]['children'][0]
            require(isinstance(body, dict) and body.get('kind') == 'Block', 'Expected method body block')
            statements = _children(body)
            require(len(statements) == 2,
                    'Delegating record getter body must be pending/return')
            _pending_module_call_invocation(_declaration_value(statements[0], 'pending'), target)
            _conditional_return_item(statements[1], target)
            prefix = resolve_prefix(inventory, target['prefix_symbol'])
            index = resolve_record_field_index(inventory, 'PendingModuleCall',
                                               target['item_symbol'])
            projected = dict(sourceId=target['source_id'], kind='presence-call-item',
                             callee=target['callee'], prefixSymbol=target['prefix_symbol'],
                             prefixBytes=prefix, itemIndex=index,
                             itemSymbol=target['item_symbol'], decode=target['decode'],
                             default=target['default'])
            if target.get('offset_symbol'):
                projected['offset'] = resolve_integer_field(inventory, target['offset_symbol'])
                projected['offsetSymbol'] = target['offset_symbol']
            result[name] = projected
        elif target['kind'] == 'inline-record-time':
            # Inline epoch getters: five statements — the key concatenation, the
            # read, the `if (data == null) return 0;` guard, the deserialize into
            # a local and the offset return. Nothing delegates, so the projection
            # pins the prefix bytes, the record field ordinal derived from the
            # PendingConfigUpdate declaration order and the delay constant; all
            # three are cross-checked against the rendered region by the runner.
            candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
            require(len(candidates) == 1, 'Missing or ambiguous source method: ' + name)
            method = candidates[0]
            require(method.get('origin') == 'repository-source', 'Non-repository getter source')
            require(len(method.get('parameters', [])) == 1 and
                    method['parameters'][0]['name'] == 'accountId' and
                    method['parameters'][0]['ordinal'] == 0, 'Unexpected getter signature')
            body = method['operations'][0]['children'][0]
            require(isinstance(body, dict) and body.get('kind') == 'Block',
                    'Expected method body block')
            statements = _children(body)
            require(len(statements) == 5,
                    'Inline epoch getter body must be key/data/guard/record/return')
            _concat_binding(_declaration_value(statements[0], 'key'), target)
            _storage_binding(_declaration_value(statements[1], 'data'), 'key')
            shaped = dict(target, default={'kind': 'integer', 'value': 0})
            _early_return_default(statements[2], shaped)
            _record_deserialize(_declaration_value(statements[3], 'pending'))
            _record_offset_return(statements[4], shaped)
            prefix = resolve_prefix(inventory, target['prefix_symbol'])
            index = resolve_record_field_index(inventory, target['record_owner'],
                                               target['item_symbol'])
            result[name] = dict(
                sourceId=target['source_id'], kind='inline-record-time',
                prefixSymbol=target['prefix_symbol'], prefixBytes=prefix,
                itemIndex=index, itemSymbol=target['item_symbol'], decode='integer',
                default={'kind': 'integer', 'value': 0},
                offset=resolve_integer_field(inventory, target['offset_symbol']),
                offsetSymbol=target['offset_symbol'])
        elif target['kind'] == 'raw-call-presence':
            # Delegating raw presence getter: the body is one
            # `return GetMarketEscrowOwnerCancelInitiated(accountId) != null;`.
            # The callee owns the prefix and the read, so the projection
            # pins no key material here; the semantics is the null test over
            # the reader's single-key raw result.
            candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
            require(len(candidates) == 1, 'Missing or ambiguous source method: ' + name)
            method = candidates[0]
            require(method.get('origin') == 'repository-source', 'Non-repository getter source')
            require(len(method.get('parameters', [])) == 1 and
                    method['parameters'][0]['name'] == 'accountId' and
                    method['parameters'][0]['ordinal'] == 0, 'Unexpected getter signature')
            body = method['operations'][0]['children'][0]
            require(isinstance(body, dict) and body.get('kind') == 'Block',
                    'Expected method body block')
            statements = _children(body)
            require(len(statements) == 1,
                    'Delegating raw presence getter body must be a single return')
            statement = statements[0]
            require(statement.get('kind') == 'Return' and len(_children(statement)) == 1,
                    'Expected a single return of the presence test')
            condition = _children(statement)[0]
            require(isinstance(condition, dict) and condition.get('kind') == 'Binary' and
                    condition.get('details', {}).get('operator') == 'NotEquals' and
                    condition.get('details', {}).get('checked') is False and
                    condition.get('details', {}).get('operatorMethod') is None and
                    len(_children(condition)) == 2,
                    'Raw presence condition must be a plain NotEquals')
            lhs, rhs = _children(condition)
            require(isinstance(lhs, dict) and lhs.get('kind') == 'Conversion' and
                    len(_children(lhs)) == 1, 'Presence operand must be a conversion')
            _single_argument_callee(_children(lhs)[0], target)
            require(isinstance(rhs, dict) and rhs.get('kind') == 'Conversion' and
                    len(_children(rhs)) == 1 and _literal(_children(rhs)[0]) is None,
                    'Raw presence test must compare against null')
            result[name] = dict(sourceId=target['source_id'],
                                kind='raw-call-presence', callee=target['callee'])
        elif target['kind'] == 'raw-call-offset':
            # Delegating raw epoch getter: the body binds the
            # shared reader's raw payload to a local and returns the pinned
            # integer default on a miss, otherwise the payload's little-endian
            # value plus the pinned owner-cancel timelock. The delay constant is
            # resolved from its declaration and cross-checked against the static
            # the rendered region adds.
            candidates = [m for m in inventory['source']['methods'] if m['id'] == target['source_id']]
            require(len(candidates) == 1, 'Missing or ambiguous source method: ' + name)
            method = candidates[0]
            require(method.get('origin') == 'repository-source', 'Non-repository getter source')
            require(len(method.get('parameters', [])) == 1 and
                    method['parameters'][0]['name'] == 'accountId' and
                    method['parameters'][0]['ordinal'] == 0, 'Unexpected getter signature')
            body = method['operations'][0]['children'][0]
            require(isinstance(body, dict) and body.get('kind') == 'Block',
                    'Expected method body block')
            statements = _children(body)
            require(len(statements) == 2,
                    'Delegating raw epoch getter body must be initiated/return')
            _single_argument_callee(_declaration_value(statements[0], 'initiated'), target)
            shaped = dict(target, data_symbol='initiated')
            _conditional_return_offset(statements[1], shaped)
            result[name] = dict(
                sourceId=target['source_id'], kind='raw-call-offset',
                callee=target['callee'], decode=target['decode'],
                default=target['default'],
                offset=resolve_integer_field(inventory, target['offset_symbol']),
                offsetSymbol=target['offset_symbol'])
        else:
            raise ValueError('Unknown target kind: ' + target['kind'])
    return result


def project_callee(inventory):
    """Project every shared private callee (debug-only, no ABI entry)."""
    return {name: _shared_callee_projection(inventory, name) for name in SHARED_CALLEES}


def _shared_callee_projection(inventory, name):
    target = SHARED_CALLEES[name]
    if name == 'getAccountState':
        return _account_state_projection(inventory, target)
    if name == 'getMarketEscrowOwnerCancelInitiated':
        return _market_escrow_owner_cancel_projection(inventory, target)
    require(name == 'getPendingModuleCallRecord', 'Unknown shared callee: ' + name)
    return _pending_module_call_record_projection(inventory, target)


def project_shared(inventory, name):
    return {name: _shared_callee_projection(inventory, name)}


def projection_hash(projection):
    return hashlib.sha256(json.dumps(projection, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def render_expr(projection):
    """Coq source term: (prefix, default, decode) triple consumed by StorageGetter."""
    prefix = '[' + ';'.join(str(b) + '%nat' for b in projection['prefixBytes']) + ']'
    if projection['decode'] == 'integer':
        default = '(GInt ' + str(projection['default']['value']) + '%Z)'
        decode = 'decode_integer'
    else:
        default = '(GBytes [' + ';'.join(str(b) + '%nat' for b in projection['default']['value']) + '])'
        decode = 'decode_hash160'
    return '(' + prefix + ', ' + default + ', ' + decode + ')'
