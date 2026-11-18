"""Fresh scoped proof orchestration. Full public-entrypoint closure stays NO-GO.

Snapshot tool/model bytes once, hash those bytes and execute their copies. The
original source/input membership is rechecked at completion. Never accept an
external receipt in place of a fresh prover invocation.
"""
import argparse
import ast
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
VM_COMMIT = '004cd6070a940405818d9357638277dd44407e2e'
CORE_COMMIT = 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d'
CODEC_SOURCE_SCOPE = 'Resolved core source AST for a two-field ledger, canonical framing, hash length 32, payload length at most 32, arbitrary suffix; fixed 2048-item/131070-byte core arguments and explicit VM/.NET primitive contracts'
# Independently reviewed scope taxonomy; changing it requires an explicit gate update.
ENTRY_DISPATCH_CONTROLS = ('drop-safe-mask',
 'caller-flags-union',
 'wrong-return-count',
 'wrong-entry-offset',
 'reverse-argument-order',
 'initializer-after-method',
 'fresh-initializer-state',
 'wrong-initializer-return-count',
 'drop-calling-context',
 'drop-dynamic-marker',
 'drop-underscore-guard',
 'wrong-arity-bound')
ENTRY_DISPATCH_DOMAIN = {'preconditions': ['Entry is after interop flag admission, fee charging, argument conversion and stack pops.',
                   'The deployed unblocked ordinary contract has the exact bound script and immutable unique '
                   'ABI; ABI dictionary cache is coherent and the initializer projection equals its _initialize/0 lookup.',
                   'Selected descriptor is safe and nonvoid; argument count equals arity and is at most '
                   '65535; flags use only the four declared bits.',
                   'A current caller exists and invocation capacity accommodates method plus optional '
                   'initializer; fresh frame/shared-state identities are supplied.',
                   'Diagnostics are disabled and virtual calls use exactly the pinned ordinary Core/VM '
                   'implementations without subclass/provider overrides.',
                   'Policy, cache, fee, allocation and reference-counter operations succeed and do not '
                   'interfere with projected frames; their other effects are outside the projection.'],
 'unproved': ['Interop syscall admission, fees, conversions, argument popping and input reachability.',
              'Trusted C# extraction, compiler/CLR correspondence, API bindings and deployed-state readback.',
              'Initializer/body execution, absolute-PC opcode composition, shared and distinct-stack RET, '
              'ContextUnloaded and caller continuation.',
              'Gas, resources, all exceptions, transaction rollback, host callbacks and aliased '
              'mutable-object effects.',
              'Whole ApplicationEngine execution and all 109 complete public entrypoints.'],
 'tcb': ['Strict complete-method C# grammar and field/symbol binding.',
         'C# object allocation/default-field semantics and framework dictionary/stack APIs.',
         'Externally supplied successful noninterfering environment, freshness, immutable manifest and exact '
         'virtual dispatch.']}
# The syscall lane's own reviewed taxonomy. Pinned here, not merely read back
# from its receipt: if the lane's constants were weakened, its report and its
# regeneration check would agree with each other and the gate would still pass.
# Changing any of these requires an explicit gate update.
SYSCALL_DISPATCH_CONTROLS = ('drop-interop-flag-gate', 'weak-interop-required-flags',
 'drop-underscore-guard', 'drop-flag-range-gate', 'narrow-call-flags',
 'drop-return-derivation', 'drop-dynamic-marker', 'shrink-interop-parameters',
 'reverse-interop-binding', 'always-push-interop-result', 'weak-token-required-flags',
 'reverse-token-pops', 'mark-callt-dynamic')
# The projected record is a claim about the pinned C#, so its derived values are
# restated here for independent review: 5 = ReadStates|AllowCall, 15 = CallFlags.All,
# 4 = CallContract's declared parameter count, 2 = its CallFlags parameter slot.
SYSCALL_DISPATCH_PROGRAM = {
    'interop_flag_gate': True, 'interop_required_flags': 5, 'interop_pop_count': 4,
    'interop_flag_slot': 2, 'interop_pushes_result': True, 'interop_handler_void': True,
    'interop_result': 0, 'call_rejects_underscore': True, 'call_flag_range_gate': True,
    'call_all_flags': 15, 'call_derives_return': True, 'call_marks_dynamic': True,
    'token_flag_gate': True, 'token_required_flags': 5, 'token_pops': True,
    'token_marks_dynamic': False}
SYSCALL_DISPATCH_HANDLER_PARAMETERS = [['UInt160', 'contractHash'], ['string', 'method'],
                                       ['CallFlags', 'callFlags'], ['Array', 'args']]
SYSCALL_DISPATCH_TOKEN_FIELDS = ['Hash', 'Method', 'ParametersCount:ushort',
                                 'HasReturnValue', 'CallFlags:byte']
SYSCALL_DISPATCH_DOMAIN = {
 'preconditions': ['The caller context exists and its own CallFlags word is the one ValidateCallFlags inspects.',
                   'For System.Contract.Call the interop descriptor is the pinned registration, the handler is '
                   'CallContract with its four declared parameters, and the four stack values convert to those '
                   'parameter types without fault.',
                   'The converted Array argument carries the element list and the ABI lookup key (its length); '
                   'both are supplied as opaque inputs.',
                   'For CALLT the token comes from the called contract Nef.Tokens at the instruction token index '
                   'and satisfies MethodToken.Deserialize, so its method never starts with underscore and its '
                   'flag word has no bits above CallFlags.All.',
                   'AddFee succeeds, Convert preserves the values, and no diagnostic callback observes the '
                   'projections.',
                   'The projected contract and manifest are the ones the caller names; policy, storage and '
                   'invocation counters do not interfere before the handoff.'],
 'unproved': ['AddFee, gas metering and every resource exception on both paths; no cost is modelled.',
              'Convert and the Array payload element list; the callee argument vector for System.Contract.Call '
              'is an opaque input, not a stack window.',
              'Exception identity: every Rejected constructor is a fault, and whether it surfaces as '
              'InvalidOperationException, ArgumentException, ArgumentOutOfRangeException, FormatException or '
              'IndexOutOfRangeException is not modelled.',
              'Contract resolution, manifest/ABI storage reads, MethodToken deserialization at NEF load, policy '
              'whitelists and invocation counting.',
              'Trusted C# extraction and compiler/CLR correspondence; ApplicationEngine execution after the '
              'handoff; all 109 public entrypoints.'],
 'tcb': ['Strict complete-method C# grammar and field/symbol binding.',
         'C# object allocation, boxing and framework stack/dictionary APIs.',
         'Externally supplied successful noninterfering environment and exact virtual dispatch.']}
# The contract-handoff lane's own reviewed taxonomy, pinned here for the same
# reason as the syscall lane's: a weakened lane constant would agree with its own
# receipt and with its own regeneration check, and only an explicit gate update
# would notice.
CONTRACT_HANDOFF_CONTROLS = ('drop-blocked-gate', 'mask-nothing', 'mask-read-states',
 'mask-everything', 'drop-authorization-gate', 'authorize-the-callee', 'increment-twice',
 'skip-increment', 'hand-off-raw-flags', 'drop-calling-context', 'drop-whitelisted-fee',
 'whitelist-keeps-flag-false', 'push-in-order', 'swap-rvcount', 'zero-offset',
 'share-the-contract', 'drop-initializer-frame', 'drop-snapshot-clone',
 'lookup-by-name-only', 'initializer-pcount-one', 'initializer-renamed')
# 10 = WriteStates | AllowNotify, read off the CallFlags declaration; 1 = the
# invocationCounter increment; 0 = _initialize's declared parameter count.
CONTRACT_HANDOFF_PROGRAM = {
    'blocked_gate': True, 'safe_mask_drops': 10, 'authorization_gate': True,
    'authorization_subject_is_caller': True, 'increment_step': 1,
    'caller_flag_intersection': True, 'calling_context_set': True,
    'fee_from_whitelist': True, 'whitelist_sets_flag': True, 'push_reversed': True,
    'rvcount_from_return': True, 'ip_from_method_offset': True, 'contract_copied': True,
    'snapshot_cloned': True, 'initializer_frame': True,
    'initializer_name_is_canonical': True, 'initializer_pcount': 0,
    'lookup_is_arity_keyed': True}
CONTRACT_HANDOFF_DOMAIN = {
 'preconditions': ['The caller context exists, its ExecutionContextState carries the CallFlags word this '
                   'handoff narrows, and CurrentScriptHash names it.',
                   'The callee ContractState and its ContractMethodDescriptor came from a successful '
                   'arity-keyed GetMethod(name, args.Count) on a manifest that the caller named.',
                   'Policy.IsBlocked and Policy.IsWhitelistFeeContract answer from storage that the caller '
                   'does not modify during the handoff; both are supplied as opaque booleans and one fee.',
                   'ContractState.CanCall answers from the calling contract manifest permissions and is '
                   'supplied as an opaque boolean.',
                   'The Domovoi hardfork is active, so the authorization subject is state.Contract rather '
                   'than a re-read of CurrentScriptHash; the Faun hardfork is the one that enables '
                   'whitelisted fees.',
                   'AddFee succeeds, no resource exception is raised, and no diagnostic callback observes '
                   'the constructed frame.'],
 'unproved': ['AddFee, gas metering, resource limits and every exception type; no cost is modelled and a '
              'rejection is a fault, not a .NET exception identity.',
              'Instruction execution inside the constructed context; this lane ends at the context that '
              'LoadContract returns, before the callee runs.',
              'Storage reads behind IsBlocked, IsWhitelistFeeContract, GetContract and manifest/ABI loading; '
              'only their answers are inputs.',
              'EvaluationStack sharing, static-field sharing, reference counters and Dispose ordering inside '
              'LoadScript/CreateContext.',
              'Trusted C# extraction and compiler/CLR correspondence; ApplicationEngine execution after the '
              'handoff; all 109 public entrypoints.'],
 'tcb': ['Strict complete-method C# grammar and field/symbol binding.',
         'C# object allocation, reference vs copy semantics and framework dictionary APIs.',
         'Externally supplied successful noninterfering environment and exact virtual dispatch.']}
# The interop argument-conversion lane's own reviewed taxonomy, pinned here for
# the same reason as the two lanes above: a weakened lane constant would agree
# with its own receipt and with its own regeneration check, and only an explicit
# gate update would notice.
INTEROP_CONVERSION_CONTROLS = ('read-arg-count-from-the-stack', 'pop-twice-per-parameter',
 'fill-parameters-backwards', 'push-void-return', 'keep-null-return-elements',
 'include-byte-arrays', 'convert-elements-with-the-array-converter',
 'convert-enums-as-integers', 'unknown-types-are-not-interfaces',
 'copy-plain-array-elements', 'payload-length-is-not-the-item-count',
 'fill-payload-elements-backwards', 'fill-counted-elements-backwards',
 'keep-the-counted-items-on-the-stack', 'weaken-the-stack-size-limit',
 'allow-a-null-argument', 'allow-a-null-payload-element',
 'allow-a-null-counted-element')
INTEROP_CONVERSION_PROGRAM = {
    'argument_count': 4, 'argument_count_from_descriptor': True,
    'pops_one_item_per_parameter': True, 'pop_order_is_reversed': True,
    'return_pushes_only_for_nonvoid_handler': True, 'return_payload_drops_nulls': True,
    'array_branch_excludes_byte_element': True,
    'array_element_converter_from_element_type': True,
    'enum_converter_from_underlying_type': True, 'unknown_type_is_interface': True,
    'identity_converter_for_plain_array': True,
    'payload_branch_length_is_item_count': True,
    'payload_branch_fills_in_index_order': True,
    'counted_branch_fills_in_index_order': True, 'counted_branch_pops_the_count': True,
    'counted_branch_max_length': 2048, 'null_argument_rejected': True,
    'null_element_rejected_in_payload_branch': True,
    'null_element_rejected_in_counted_branch': True}
# 2048 = 2 * 1024 read off ExecutionEngineLimits.MaxStackSize; the four entries
# are the CallContract declaration's own arguments, in order.
INTEROP_CONVERSION_ARGUMENTS = (['UInt160', 'contractHash'], ['string', 'method'],
                                ['CallFlags', 'callFlags'], ['Array', 'args'])
INTEROP_CONVERSION_DOMAIN = {
 'preconditions': ['The descriptor is the pinned System.Contract.Call registration, whose parameters are the '
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
                   'this lane.'],
 'unproved': ['The per-type converter functions, their BigInteger narrowing and every FormatException they '
              'may raise; only their results are inputs.',
              'The handler body, its return value and its continuation; this lane ends at the converted '
              'argument vector.',
              'Gas metering and descriptor pricing; only the absence of an add-fee step inside this window is '
              'recorded.',
              'Reference counting, disposables added by Convert(object?), and payload aliasing between the '
              'caller and the handler.',
              'Trusted C# extraction and compiler/CLR correspondence; all 109 public entrypoints.'],
 'tcb': ['Strict complete-method C# grammar and field/symbol binding.',
         'C# switch-expression dispatch, reflection over the handler signature and LINQ OfType/Select.',
         'Externally supplied well-formed stack window and exact virtual dispatch of the handler.']}

# The interop descriptor-charge lane's own reviewed taxonomy, pinned here for the
# same reason as the lanes above: a weakened lane constant would agree with its
# own receipt and with its own regeneration check, and only an explicit gate
# update would notice.
INTEROP_FEE_CONTROLS = ('charge-before-the-flag-check', 'charge-after-the-conversion-loop',
 'charge-reads-another-price-member', 'charge-multiplies-by-the-base-factor',
 'ask-add-fee-to-apply-the-factor-again', 'size-the-vector-from-a-constant',
 'convert-every-parameter-from-the-first-descriptor',
 'take-the-arity-from-an-empty-signature', 'narrow-the-declared-price-to-int',
 'declare-the-price-always-nonzero', 'accept-a-negative-fee',
 'charge-a-whitelisted-context', 'always-apply-the-factor-branch',
 'check-the-limit-before-counting-the-charge', 'reject-a-call-at-exactly-the-limit',
 'charge-a-fee-inside-the-conversion-window')
INTEROP_FEE_PROGRAM = {
    'step_order': ['validate-call-flags', 'charge', 'allocate-vector',
                   'pop-and-convert', 'invoke-handler', 'push-result'],
    'charge_reads_the_declared_price': True, 'charge_uses_the_exec_factor': True,
    'charge_skips_the_inner_factor': True, 'vector_length_from_descriptor': True,
    'pops_one_item_per_parameter': True, 'arity_from_the_handler_signature': True,
    'declared_price_type_is_long': True, 'declared_price_may_be_zero': True,
    'negative_fee_is_rejected': True, 'whitelist_bypasses_the_charge': True,
    'factor_applied_only_when_requested': True,
    'consumed_incremented_before_the_limit_check': True,
    'limit_check_is_strict': True, 'no_fee_inside_the_conversion_window': True}
INTEROP_FEE_DOMAIN = {
 'preconditions': ['The descriptor is the pinned registration for the invoked syscall, resolved once, and '
                   'RequiredCallFlags, FixedPrice and Parameters are that descriptor\'s own members.',
                   'ValidateCallFlags has already run inside the window; this lane records only where it sits '
                   'relative to the charge, not what it accepts.',
                   'The fee limit, the consumed counter and the whitelist bit are engine state supplied as '
                   'inputs; this lane does not model how any of them reached their values.',
                   "AddFee's own rejection paths are modelled by the boolean outcome of the charge call, not by "
                   're-deriving the exception type or the arithmetic overflow behaviour of add.',
                   'The fixed price is a non-negative `long` and the execution fee factor is a non-negative '
                   'integer; a negative product is out of scope.',
                   'The handler body does not run in this lane, and no diagnostic callback observes the charge.'],
 'unproved': ['The arithmetic of `_feeConsumed + gas` at BigInteger width, and whether a specific rejected '
              'charge surfaces as OutOfGas or as the generic Insufficient GAS invalid operation.',
              'How `_execFeeFactor` is obtained per hardfork path (policy read, pico factor, default value); '
              'only the identity of the member the charge multiplies by is recorded.',
              'Which descriptors actually declare a zero fixed price; the lane records only that the '
              'declaration permits zero.',
              'The conversion itself, the handler body and its return value; those stay in the '
              'interop-conversion lane.',
              'Trusted C# extraction and compiler/CLR correspondence; all 109 public entrypoints.'],
 'tcb': ['Strict complete-method C# grammar and field/symbol binding.',
         'C# init-only property semantics and the reflection call that builds Parameters.',
         'Externally supplied engine fee state and exact virtual dispatch of the handler.']}

# The exception identity lane's own reviewed taxonomy, pinned here for the same
# reason as the lanes above: a weakened lane constant would agree with its own
# receipt and with its own regeneration check, and only an explicit gate update
# would notice.
EXCEPTION_IDENTITY_CONTROLS = ('drop-the-limit-guard',
 'name-the-base-type-in-the-guarded-clause',
 'throw-the-exception-object-instead-of-its-message', 'make-the-outer-handler-typed',
 'fault-without-setting-the-state', 'skip-recording-the-thrown-value',
 'never-clear-the-recorded-value', 'push-a-null-instead-of-the-thrown-value',
 'treat-the-finally-frame-as-a-catch', 'let-the-unhandled-value-escape-unwrapped',
 'give-the-catchable-exception-no-dedicated-type', 'drop-the-wrapped-object',
 'fault-without-recording-the-exception', 'keep-the-notifications-on-fault',
 'default-the-limit-to-off', 'swap-the-hook-and-the-pointer-advance')
EXCEPTION_IDENTITY_PROGRAM = {
    'step_order': ['read-instruction', 'guarded-catch', 'post-hook',
                   'advance-pointer', 'fault-handler'],
    'catch_names_the_catchable_type': True, 'catch_is_guarded_by_the_limit': True,
    'the_generic_handler_is_untyped': True, 'the_caught_value_is_the_message': True,
    'the_fault_sets_the_state': True, 'the_thrown_value_is_recorded_at_entry': True,
    'a_handler_clears_the_recorded_value': True,
    'the_handler_receives_the_thrown_value': True,
    'the_walk_skips_the_finally_and_consumed_catch': True,
    'an_absent_handler_wraps_the_value': True, 'a_dedicated_catchable_type_exists': True,
    'the_wrapper_keeps_the_thrown_object': True, 'the_engine_records_the_fault': True,
    'the_engine_clears_the_notifications': True, 'the_limit_defaults_to_catching': True}
EXCEPTION_IDENTITY_DOMAIN = {
 'preconditions': ['The instruction being executed is the one the loop read, and its handler is the only thing '
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
                   'transaction layer that consumes them is a separate obligation.'],
 'unproved': ['Which concrete exception type each individual engine operation throws; this lane records the '
              'catch clause identity and the surfacing rule, not the throw sites of every opcode.',
              'Whether a host ever constructs an engine with the catch limit off; only the declared default '
              'and the guard position are recorded.',
              'The fault-message text and any client-visible diagnostic derived from it.',
              'Rollback of ledger and storage effects after a fault, and the transaction composition that '
              'decides whether a faulted execution is committed or discarded.',
              'Trusted C# extraction and compiler/CLR correspondence; all 109 public entrypoints.'],
 'tcb': ['C# catch-clause matching and exception-subtyping of `catch (T)` against a thrown value.',
         'The tokenizer keeps string and character literals opaque; preprocessor lines carry no '
         'state and are dropped before projection.',
         'Externally supplied engine limits, invocation-stack shape and TRY-stack states.']}
EXCEPTION_IDENTITY_SOURCES = {
    'vm/engine': (VM_COMMIT, 'src/Neo.VM/ExecutionEngine.cs'),
    'vm/control': (VM_COMMIT, 'src/Neo.VM/JumpTable/JumpTable.Control.cs'),
    'vm/limits': (VM_COMMIT, 'src/Neo.VM/ExecutionEngineLimits.cs'),
    'vm/catchable': (VM_COMMIT, 'src/Neo.VM/CatchableException.cs'),
    'vm/unhandled': (VM_COMMIT, 'src/Neo.VM/VMUnhandledException.cs'),
    'core/engine': (CORE_COMMIT, 'src/Neo/SmartContract/ApplicationEngine.cs')}
# The load admission lane's reviewed taxonomy, pinned here for the same reason
# as the lanes above: a weakened lane constant would agree with its own
# receipt and with its own regeneration check.
LOAD_ADMISSION_CONTROLS = (
    'accept-a-foreign-magic', 'accept-a-nonzero-reserve-byte',
    'accept-a-nonzero-reserve-short', 'raise-the-token-array-cap', 'accept-an-empty-script',
    'compare-the-checksum-for-equality', 'verify-past-the-declared-flag',
    'allow-a-underscore-method', 'raise-the-method-name-limit',
    'mask-the-flag-byte-against-one-flag', 'accept-an-empty-manifest-name',
    'accept-a-populated-features-field', 'accept-repeated-standards',
    'accept-repeated-permission-subjects', 'accept-repeated-trusts',
    'raise-the-manifest-length-cap', 'accept-an-empty-abi',
    'key-the-exact-lookup-by-the-name-only', 'drop-the-arity-range-check',
    'make-the-wildcard-respect-the-arity', 'accept-an-empty-method-name',
    'accept-repeated-parameter-names', 'accept-an-undeclared-return-type',
    'read-the-reserve-before-the-source', 'accept-a-zero-length-manifest',
    'hand-back-a-method-when-the-lookup-misses', 'accept-a-negative-offset')
LOAD_ADMISSION_PROGRAM = {
    'step_order': ['read-magic',
     'read-compiler',
     'read-source',
     'read-reserve-byte',
     'read-tokens',
     'read-reserve-short',
     'read-script',
     'verify-checksum'],
    'magic_is_the_declared_nef3_constant': True,
    'the_reserved_fields_must_be_zero': True,
    'token_array_cap': 128,
    'the_script_cannot_be_empty': True,
    'the_checksum_is_compared_for_inequality': True,
    'the_checksum_check_is_guarded_by_the_verify_flag': True,
    'a_token_method_cannot_start_with_underscore': True,
    'token_method_name_limit': 32,
    'a_token_flag_byte_must_be_a_declared_flag': True,
    'the_manifest_name_cannot_be_empty': True,
    'the_features_field_must_be_empty': True,
    'the_manifest_names_cannot_repeat': True,
    'manifest_length_cap': 65535,
    'the_manifest_length_cap_is_enforced_before_parsing': True,
    'the_abi_needs_at_least_one_method': True,
    'the_exact_lookup_is_keyed_by_name_and_arity': True,
    'the_arity_is_range_checked': True,
    'the_wildcard_lookup_ignores_the_arity': True,
    'the_exact_lookup_returns_null_when_absent': True,
    'a_method_name_cannot_be_empty': True,
    'a_method_parameter_name_cannot_repeat': True,
    'a_method_return_type_must_be_defined': True,
    'a_method_offset_cannot_be_negative': True
}
LOAD_ADMISSION_DOMAIN = {
 'preconditions': [
  'The bytes handed to `NefFile.Deserialize` are supplied as an input; this lane records the check order and the admitted shapes, not the transport that produced the bytes.',
  '`NefFile.Parse` is read with the default `verify: true`; the lane records that the checksum comparison is guarded by the flag and what the declared default is, not how a host overrides it.',
  'The manifest JSON is supplied as an input; this lane records which declarations are refused, not the JSON reader or the length accounting of the enclosing envelope.',
  'Contract deployment, storage of an admitted manifest and its update path are out of scope: the lane stops at the value `FromJson` returns.',
  'The permission table and its runtime decision are modelled by the contract-handoff lane; this lane only records that a permission entry is a subject plus a method selector.',
  'Exact-arity resolution is recorded as a table keyed by (name, arity); the dictionary implementation that throws on a repeated key is a stated consequence, not a modelled throw.'
  ],
 'unproved': [
  'Whether the deployment path ever stores a manifest whose ABI declares two methods with the same name and arity; the loader admits it and the exact lookup is where it stops being resolvable.',
  'Every rejection message and any client-visible diagnostic derived from it.',
  'The wildcard container reader that turns the JSON string `*` into a wildcard; only the selector that consumes it is recorded.',
  'Gas, storage growth and every resource limit on the admission path; no cost is modelled.',
  'Trusted C# extraction and compiler/CLR correspondence; all 109 public entrypoints.'
  ],
 'tcb': [
  'Strict complete-method C# grammar and field/symbol binding.',
  'The tokenizer keeps string and character literals opaque; preprocessor lines carry no state and are dropped before projection.',
  'Externally supplied nef bytes, manifest JSON and the JSON reader that produced them.'
  ]}
LOAD_ADMISSION_SOURCES = {
    'core/nef': (CORE_COMMIT, 'src/Neo/SmartContract/NefFile.cs'),
    'core/token': (CORE_COMMIT, 'src/Neo/SmartContract/MethodToken.cs'),
    'core/manifest': (CORE_COMMIT, 'src/Neo/SmartContract/Manifest/ContractManifest.cs'),
    'core/abi': (CORE_COMMIT, 'src/Neo/SmartContract/Manifest/ContractAbi.cs'),
    'core/method': (CORE_COMMIT, 'src/Neo/SmartContract/Manifest/ContractMethodDescriptor.cs')
}

COLLECTION_PARTIAL_SCOPES = {
    'RET': 'shared evaluation stack preservation and jumping flag only',
    'SIZE': 'Array/Struct count with int32 size',
    'ISTYPE': 'Array/Struct kind on admitted enum target; other types unproved',
    'CONVERT': 'ByteString/Buffer to Buffer contents only; allocation identity unproved'}
# The storage-getter lane's shared private readers. Pinned here so a lane
# receipt cannot silently drop or add one: every one of them is a separate
# certificate obligation (its own frame, statics and storage reads).
STORAGE_GETTER_SHARED_CALLEES = ('getAccountState', 'getMarketEscrowOwnerCancelInitiated',
                                 'getPendingModuleCallRecord')
# The files in the pinned corpus where the front end reads different characters
# than the C# lexer. Frozen rather than merely reported: a run that grows a new
# gap is a new defect, and a run that closes one has to say so here, which is the
# only way a defect leaves this record. What keeps the list safe is the separate
# check that no uniquely located anchor moved.
#
# Empty, and it had to be emptied twice, each time on purpose:
#
# `vm-engine.cs` on 2026-10-19 — the lanes now evaluate `#if` conditions through
# `csharp_directives` instead of dropping the line and keeping the disabled body,
# so the 214-character `VMPERF` region is no longer read.
#
# `vm-stack.cs` on 2026-10-19 — the seven canonical lanes now share
# `csharp_tokens.TOKENIZER` instead of a regular expression, which reads an
# interpolation hole as one token. The swap was measured before it was made: on
# the pinned corpus it changes the token stream of that one file and no other,
# and the projection of all seven lanes is byte-identical before and after.
KNOWN_FRONT_END_GAPS = ()
SCOPES = {
    'arithmetic': 'arithmetic-region', 'numeric': 'numeric-coercions', 'reservation': 'reservation-arithmetic',
    'method': 'complete-helper-reference-refinement', 'context': 'complete-helper-context-and-initializer-reference-refinement',
    'initializer': 'source-to-complete-initializer-reference-refinement', 'composition': 'caller-ledger-composition',
    'public': 'public-pure-reference-refinement', 'runtime': 'runtime-instruction-source-bridge',
    'codec': 'ledger-codec', 'gas': 'source-derived-add-fee-and-metered-traces',
    'helper-gas': 'exact-CFG-parameterized-helper-price-bound',
    'hook': 'private-hook-params-reference-refinement',
    'runtime-collections': 'runtime-collection-source-bridge',
    'storage-getters': 'storage-getter-source-refinement',
    'entry-dispatch': 'ordinary-safe-public-abi-entry-frame-source-bridge',
    'syscall-dispatch': 'system-contract-call-and-callt-admission-bridge',
    'contract-handoff': 'contract-internal-handoff-and-frame-construction',
    'interop-conversion': 'interop-argument-conversion',
    'interop-fee-order': 'interop-descriptor-charge-order',
    'exception-identity': 'exception-identity-and-catchability',
    'load-admission': 'load-time-manifest-and-token-admission'}
ARTIFACT_LANES = {'arithmetic', 'method', 'context', 'initializer', 'public', 'hook', 'entry-dispatch',
                  'storage-getters'}
CERTIFICATES = {'method': ('certificateSha256', 'CapMethodArtifact.v'),
                'context': ('certificateSha256', 'CapContextArtifact.v'),
                'initializer': ('certificateSha256', 'InitializerSourceArtifact.v'),
                'public': ('certificateSha256', 'PublicPureArtifact.v'),
                'runtime': ('generatedCertificateSha256', 'RuntimeSourceCertificate.v'),
                'gas': ('certificateSha256', 'GasArtifact.v'),
                'helper-gas': ('certificateSha256', 'HelperGasArtifact.v'),
                'hook': ('certificateSha256', 'HookArtifact.v'),
                'runtime-collections': ('generatedCertificateSha256', 'RuntimeCollectionCertificate.v'),
                'entry-dispatch': ('certificateSha256', 'EntryDispatchArtifact.v'),
                'syscall-dispatch': ('certificateSha256', 'SyscallDispatchArtifact.v'),
                'contract-handoff': ('certificateSha256', 'ContractHandoffArtifact.v'),
                'interop-conversion': ('certificateSha256', 'InteropConvertArtifact.v'),
                'interop-fee-order': ('certificateSha256', 'InteropFeeArtifact.v'),
                'exception-identity': ('certificateSha256', 'ExceptionIdentityArtifact.v'),
                'load-admission': ('certificateSha256', 'LoadAdmissionArtifact.v')}
# 'storage-getters' is deliberately absent from CERTIFICATES: its
# certificateSha256 is the digest of the source certificate composed with the
# per-region VM certificates, so it is no single file's digest. The lane is
# joined instead by hashing every member module in closedDeclarations against
# its own file, and by regenerating the composed bytes from the fresh inventory
# in main().


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw): return hashlib.sha256(raw).hexdigest()


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def identity(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def literal_equal(actual, expected):
    """Compare a projected record by type as well as by value.

    `1 == True` in Python, so a plain `==` accepts an integer where the reviewed
    record has a boolean.  The projection's types are part of the claim: a
    mistyped field is a different record, not the reviewed one.
    """
    if isinstance(expected, dict):
        return (isinstance(actual, dict) and set(actual) == set(expected)
                and all(literal_equal(actual[key], value) for key, value in expected.items()))
    if isinstance(expected, list):
        return (isinstance(actual, list) and len(actual) == len(expected)
                and all(literal_equal(one, other) for one, other in zip(actual, expected)))
    return type(actual) is type(expected) and actual == expected


def capture_files(paths, destination, relative_root=None):
    """Exactly one original read feeds both its hash and its executable copy."""
    destination = Path(destination)
    snapshot = {}
    for index, path in enumerate(sorted(set(Path(p).resolve() for p in paths))):
        raw = path.read_bytes()
        target = destination / (path.relative_to(relative_root) if relative_root else str(index) + '-' + path.name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        snapshot[str(path)] = {'sha256': sha(raw), 'copy': str(target.resolve())}
    return snapshot


def check_snapshot(snapshot):
    for original, item in snapshot.items():
        require(sha(Path(original).read_bytes()) == item['sha256'], 'original input drift: ' + original)
        require(sha(Path(item['copy']).read_bytes()) == item['sha256'], 'copied input drift: ' + item['copy'])


def tool_paths():
    """Selected lane imports/literal resources plus compiler project membership.

    Exclude unrelated new proof lanes, while detecting new .cs build inputs in
    selected exporter projects and changed dependencies of selected Python/Coq.
    Dynamic module/model lists in these runners are literal strings; new
    nonliteral loaders need an explicit dependency declaration here.
    """
    entries = ['closure.py', 'test_closure.py', 'verify.py', 'entrypoint_inventory.py',
               'prove.py', 'numeric_proofs.py', 'reservation_proofs.py', 'method_proofs.py',
               'context_proofs.py', 'initializer_proofs.py', 'composition_proofs.py',
               'public_pure_proofs.py', 'runtime_bridge_proofs.py', 'codec_proofs.py',
               'gas_proofs.py', 'gas_trace_proofs.py', 'hook_params_proofs.py', 'runtime_collection_proofs.py',
               'storage_getter_proofs.py',
               'entry_dispatch_proofs.py', 'syscall_dispatch_proofs.py',
               'contract_handoff_proofs.py', 'interop_convert_proofs.py',
               'interop_fee_proofs.py', 'exception_identity_proofs.py',
               'abi_admission_proofs.py',
               'frontend_correspondence.py', 'test_frontend_correspondence.py',
               'abi_dispatch.py', 'test_abi_dispatch.py',
               'dispatch_footprint.py', 'test_dispatch_footprint.py',
               'abi_scenario.py', 'test_abi_scenario.py',
               'scenarios/sa-account-roundtrip.json',
               'scenarios/sa-account-windows.json',
               'scenarios/sa-account-plugins.json',
               'scenarios/sa-account-registrar.json',
               'plugins/MultiSigVerifier.nef', 'plugins/MultiSigVerifier.manifest.json',
               'plugins/NeoDIDCredentialHook.nef', 'plugins/NeoDIDCredentialHook.manifest.json',
               'plugins/MultiHook.nef', 'plugins/MultiHook.manifest.json',
               'plugins/SAPlatformRegistrar.nef', 'plugins/SAPlatformRegistrar.manifest.json',
               'plugins/MockVerifierCore.nef', 'plugins/MockVerifierCore.manifest.json',
               'plugins/SAPaymaster.nef', 'plugins/SAPaymaster.manifest.json',
               'plugins/provenance.json',
               'csharp_directives.py']
    pending, seen = [HERE/name for name in entries], set()
    while pending:
        path = pending.pop().resolve()
        if path in seen: continue
        require(path.is_file(), 'selected dependency missing: ' + str(path))
        seen.add(path)
        raw = path.read_bytes()
        if path.suffix == '.py':
            tree = ast.parse(raw)
            strings = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
            names = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import): names.update(alias.name.split('.')[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom):
                    if node.module: names.add(node.module.split('.')[0])
                    names.update(alias.name for alias in node.names)
            pending.extend(HERE/(name+'.py') for name in names if (HERE/(name+'.py')).is_file())
            for text in strings:
                if not re.fullmatch(r'[A-Za-z0-9_/.-]{1,180}', text) or text.startswith('/'):
                    continue
                candidates = [HERE/text, HERE/'coq'/text, HERE/'coq'/(text+'.v'), HERE/'fixtures'/text]
                if text.endswith(('.py','.json','.gz','.txt')):
                    candidates.extend((HERE/'fixtures').rglob(Path(text).name))
                pending.extend(p for p in candidates if p.is_file() and HERE in p.resolve().parents
                               and not any(part in {'bin','obj'} for part in p.resolve().relative_to(HERE).parts))
        elif path.suffix == '.v':
            for statement in re.findall(r'(?:Require Import|Require Export)\s+([^.]*)\.', raw.decode('utf-8')):
                for name in statement.split():
                    candidate = HERE/'coq'/(name+'.v')
                    if candidate.is_file(): pending.append(candidate)
    seen.add((REPO/'formal/coq/OrdinarySponsorship.v').resolve())
    for project in ('export','native_export'):
        directory = HERE/project
        require(directory.is_dir(), 'selected compiler project missing: ' + project)
        seen.update(p.resolve() for p in directory.rglob('*') if p.is_file()
                    and p.suffix in {'.cs','.csproj','.props','.targets','.json','.config'}
                    and not any(part in {'bin','obj'} for part in p.relative_to(directory).parts))
    return sorted(seen)


def prepare_output(directory):
    directory = Path(directory).resolve()
    require(directory != HERE and HERE not in directory.parents, 'output must be outside refinement source')
    require(not directory.exists() or (directory.is_dir() and not any(directory.iterdir())), 'output must be new or empty')
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def run_command(command, log, timeout):
    log = Path(log); log.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    with log.open('wb') as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        timed_out = False
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            if hasattr(os, 'killpg'):
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
            try: process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                if hasattr(os, 'killpg'):
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.wait()
    return {'command': command, 'log': str(log), 'exitCode': process.returncode,
            'timedOut': timed_out, 'elapsedSeconds': round(time.monotonic()-start, 3), 'logSha256': sha(log.read_bytes())}


def checked_controls(value, label):
    require(value, label + ' missing semantic controls')
    if isinstance(value, dict) and 'rejected' in value:
        require(value.get('definitionsCompiled') is True and isinstance(value['rejected'], list)
                and value['rejected'] and all(isinstance(name, str) and name for name in value['rejected'])
                and len(value['rejected']) == len(set(value['rejected'])), label + ' invalid control summary')
        if label == 'composition':
            require('controls' in value, 'composition missing control details')
        if 'controls' in value:
            require(isinstance(value['controls'], dict) and set(value['controls']) == set(value['rejected']),
                    label + ' omitted control details')
            for row in value['controls'].values(): checked_controls([row], label)
        return len(value['rejected'])
    rows = list(value.values()) if isinstance(value, dict) else value
    require(isinstance(rows, list) and rows, label + ' invalid controls')
    for row in rows:
        require(isinstance(row, dict) and not row.get('timedOut') and not row.get('timeout'), label + ' timed out/invalid control')
        if label == 'composition':
            require(row.get('definitionsCompiled') is True and row.get('certificateRejected') is True
                    and type(row.get('kernelExitCode')) is int and row['kernelExitCode'] > 0,
                    'composition missing definitions or kernel rejection evidence')
        defined = any(row.get(k) is True for k in ('definitionsCompiled', 'definitionsAccepted', 'sourceDefinitionCompiled'))
        rejected = any(row.get(k) is True for k in ('certificateRejected', 'proofRejected', 'counterexampleRejected', 'originalBehaviorRejected', 'correspondenceRejected'))
        if 'sourceDefinitionCompiled' in row:
            require(row.get('kernelCounterexampleChecked') is True, label + ' unverified runtime counterexample')
        require(defined and rejected, label + ' invalid definitions or rejected control')
        if 'kernelExitCode' in row:
            require(type(row['kernelExitCode']) is int and row['kernelExitCode'] > 0, label + ' negative control lacked kernel rejection')
    return len(rows)


def entrypoint_coverage(inventory, receipts):
    """Honest, non-overlapping accounting of what each entry body has today.

    Only a closed entrypoint clears its row from unprovedEntrypoints. A
    body-level refinement is a strict sub-scope of that, so it is reported in
    its own bucket and can never be read as a closed public entrypoint.
    """
    total = len(inventory['manifest']['methods'])
    reference = receipts['public'].get('referenceVerifiedEntrypoints', [])
    dispatch = receipts['storage-getters'].get('storageGetterSourceVerified', [])
    require(isinstance(reference, list) and isinstance(dispatch, list)
            and len(set(reference)) == len(reference) and len(set(dispatch)) == len(dispatch)
            and not set(reference) & set(dispatch), 'overlapping body-level refinement claims')
    known = {entry['name'] for entry in inventory['manifest']['methods']}
    require(set(reference) | set(dispatch) <= known, 'body-level refinement on an unknown ABI entry')
    refined = sorted(set(reference) | set(dispatch))
    return {'total': total, 'fullyClosed': 0, 'bodyLevelRefined': len(refined),
            'dispatchLevelOnly': total - len(refined),
            'fullyClosedEntrypoints': [], 'bodyLevelEntrypoints': refined,
            'referenceBodyEntrypoints': sorted(reference),
            'dispatchBoundBodyEntrypoints': sorted(dispatch),
            'note': ('Only fullyClosed counts toward closing a public entrypoint. Every bodyLevelRefined '
                     'entry has a kernel-checked refinement of its own body (source semantics, and for '
                     'the storage getters additionally trace-level bytecode correspondence), yet still '
                     'carries the ApplicationEngine, compiler-correspondence, gas, exception and '
                     'transaction-composition obligations, so the whole-contract status stays NO-GO.')}


def join_scopes(inventory, receipts, native_vector_sha=None):
    """Join already freshly executed receipts, never authenticate arbitrary JSON."""
    require(set(receipts) == set(SCOPES), 'missing/extra scoped receipt')
    summaries = {}
    for name, scope in SCOPES.items():
        report = receipts[name]
        require(isinstance(report, dict) and report.get('scope') == scope, name + ' wrong scope')
        require(report.get('kernelChecked') is True, name + ' kernel unchecked')
        require(report.get('fullImplementationVerified') is False, name + ' missing/forged full implementation claim')
        require(report.get('implementationVerified', False) is False, name + ' forged full implementation claim')
        controls = report.get('semanticControls')
        if name == 'composition':
            require(isinstance(controls, dict)
                    and controls.get('schema') == 'neoos-sa-reimbursement-composition-controls/v1'
                    and controls.get('scope') == scope, 'composition invalid control receipt schema/scope')
        control_count = checked_controls(controls, name)
        require(report.get('modelSha256') or report.get('inputSha256'), name + ' missing model/source identity')
        if name in ARTIFACT_LANES:
            require(report.get('nefSha256') == inventory['nef']['sha256'], name + ' NEF identity mismatch')
            require(report.get('scriptSha256') == inventory['nef']['scriptSha256'], name + ' script identity mismatch')
        summaries[name] = {'scope': scope, 'kernelChecked': True, 'semanticControlCount': control_count,
                           'fullImplementationVerified': False, 'canonicalJoinedReceiptSha256': sha(canonical(report)),
                           'modelSha256': report.get('modelSha256', {}),
                           'sourceProjectionSha256': report.get('sourceProjectionSha256', report.get('projectionSha256')),
                           'established': report.get('established', report.get('covered', report.get('proven', report.get('conclusions', [])))),
                           'unproved': report.get('unproved', report.get('excludedCorrespondence', report.get('excluded', report.get('openObligations', []))))}
        declarations = report.get('closedDeclarations', report.get('assumptionDeclarations', report.get('kernelDeclarations')))
        if declarations:
            summaries[name]['declarationsByModule'] = declarations
            summaries[name]['declarationCountingScope'] = 'This lane only; imported declarations are not added across lanes'
        if name in {'runtime','runtime-collections'}:
            summaries[name]['provenOpcodes'] = report.get('provenOpcodes', [])
            summaries[name]['supportingProjections'] = report.get('supportingProjections', {})
            summaries[name]['preconditions'] = report.get('preconditions', [])
            summaries[name]['tcb'] = report.get('tcb', [])
        if name == 'public': summaries[name]['referenceBodyEntrypoints'] = report.get('referenceVerifiedEntrypoints', [])
    method = receipts['method']
    require(method.get('referenceRefinementVerified') is True and identity(method.get('certificateSha256'))
            and identity(method.get('sourceProjectionSha256')), 'missing exact helper certificate/source binding')
    raw = bytes.fromhex(inventory['nef']['scriptHex'])
    span = method.get('methodRange')
    require(isinstance(span, list) and len(span) == 2 and all(type(v) is int for v in span)
            and 0 <= span[0] < span[1] <= len(raw) and method.get('byteCount') == span[1]-span[0]
            and type(method.get('instructionCount')) is int and method['instructionCount'] > 0
            and method.get('methodSha256') == sha(raw[span[0]:span[1]]), 'helper range/bytes coverage mismatch')
    composition = receipts['composition']
    require(composition.get('actualHelperTheoremApplied') is True and
            composition.get('helperCertificateSha256') == method['certificateSha256'] and
            composition.get('helperMethodSha256') == method.get('methodSha256'), 'composition mixed helper identity')
    context, initializer = receipts['context'], receipts['initializer']
    require(context.get('helperContextVerified') is True and context.get('methodSha256') == method.get('methodSha256'),
            'context helper identity/scope mismatch')
    require(context.get('methodRange') == method.get('methodRange') and
            context.get('methodInstructionCount') == method.get('instructionCount') and
            context.get('methodByteCount') == method.get('byteCount'), 'context helper range/coverage mismatch')
    entries = [e for e in inventory['manifest']['methods'] if e['name'] == '_initialize']
    require(len(entries) == 1, 'missing/ambiguous initializer ABI')
    start = entries[0]['offset']
    require(context.get('initializerRange') == [start, len(raw)], 'incomplete initializer range')
    expected = sha(raw[start:])
    require(context.get('initializerSha256') == initializer.get('initializerSha256') == expected, 'initializer bytes mismatch')
    require(initializer.get('sourceFrontendVerified') is False and initializer.get('applicationEngineVerified') is False,
            'initializer overclaimed frontend/runtime scope')
    require(identity(initializer.get('sourceProjectionSha256')) and
            initializer.get('fieldCount') == len(initializer.get('sourceProjection', {}).get('initializers', [])), 'initializer source field/projection mismatch')
    public = receipts['public']
    require(public.get('vmCorrespondenceProven') is False, 'public overclaimed VM correspondence')
    require(public.get('fullUnprovedEntrypointCount') == len(inventory['manifest']['methods']), 'public body scope reduced full count')
    require(set(public.get('methods', {})) == set(public.get('referenceVerifiedEntrypoints', [])), 'public method inventory mismatch')
    for name, row in public['methods'].items():
        abis = [e for e in inventory['manifest']['methods'] if e['name'] == name]
        require(len(abis) == 1 and row.get('abi') == abis[0] and row.get('start') == abis[0]['offset'], 'public wrong ABI entry')
        end = row.get('end')
        require(type(end) is int and row['start'] < end <= len(raw) and
                row.get('bytes') == list(raw[row['start']:end]) and row.get('methodSha256') == sha(raw[row['start']:end]), 'public method byte mismatch')
    getters = receipts['storage-getters']
    require(getters.get('schema') == 'neoos-sa-storage-getter-source-refinement/v1'
            and getters.get('coqchkChecked') is True and getters.get('assumptionsClosed') is True
            and getters.get('vmCorrespondenceProven') is True
            and identity(getters.get('projectionSha256'))
            and isinstance(getters.get('vmCorrespondenceScope'), str)
            and getters['vmCorrespondenceScope'],
            'storage getter kernel/coqchk/scope evidence missing')
    # The lane proves region bodies and their trace-level VM correspondence. It
    # must never be read as closing a public entrypoint, so it has to keep its
    # full reference inventory empty and the whole-contract count intact.
    require(getters.get('referenceVerifiedEntrypoints') == [],
            'storage getters forged full reference-refinement entrypoints')
    require(getters.get('fullUnprovedEntrypointCount') == len(inventory['manifest']['methods']),
            'storage getters reduced the full unproved entrypoint count')
    require(getters.get('openObligations') == ['APPLICATION_ENGINE_REFINEMENT',
                                              'ALL_REMAINING_PUBLIC_ENTRYPOINTS'],
            'storage getters omitted/changed open obligations')
    verified = getters.get('storageGetterSourceVerified')
    require(isinstance(verified, list) and verified and len(set(verified)) == len(verified)
            and verified == sorted(verified) and getters.get('dispatchBoundEntrypoints') == verified,
            'storage getters missing/duplicated dispatch-bound verified inventory')
    require(set(getters.get('methods', {})) == set(verified)
            and set(getters.get('vmTraceCoverage', {})) == set(verified),
            'storage getters method/trace inventories disagree with its verified entrypoints')
    for name in verified:
        abis = [entry for entry in inventory['manifest']['methods'] if entry['name'] == name]
        require(len(abis) == 1 and abis[0].get('safe') is True and abis[0].get('returntype') != 'Void'
                and name.startswith(('get', 'has', 'is')),
                'storage getter unsupported/mutating ABI entry: ' + name)
        row = getters['methods'][name]
        require(row.get('abi') == abis[0] and row.get('start') == abis[0]['offset']
                and type(row.get('endExclusive')) is int and row['start'] < row['endExclusive'] <= len(raw)
                and row.get('byteCount') == row['endExclusive'] - row['start']
                and row.get('regionBytesSha256') == sha(raw[row['start']:row['endExclusive']])
                and type(row.get('instructionCount')) is int and row['instructionCount'] > 0,
                'storage getter ABI/region byte mismatch: ' + name)
        trace = getters['vmTraceCoverage'][name]
        require(isinstance(trace, list) and trace and len(set(trace)) == len(trace)
                and all(isinstance(value, str) and value for value in trace),
                'storage getter trace coverage missing/duplicated: ' + name)
    callees = getters.get('sharedCallees')
    require(isinstance(callees, list)
            and tuple(row.get('name') for row in callees if isinstance(row, dict))
                == STORAGE_GETTER_SHARED_CALLEES,
            'storage getter shared callee inventory mismatch')
    for row in callees:
        span = row.get('regions')
        require(isinstance(row.get('projectionKinds'), list) and row['projectionKinds']
                and isinstance(span, list) and len(span) == 2 and all(type(value) is int for value in span)
                and 0 <= span[0] < span[1] <= len(raw)
                and type(row.get('deserializeTokenIndex')) is int,
                'storage getter shared callee region/kind mismatch: ' + str(row.get('name')))
    vm_controls = getters.get('vmSemanticControls')
    require(isinstance(vm_controls, list) and vm_controls, 'storage getter bytecode controls missing')
    for row in vm_controls:
        require(isinstance(row, dict) and row.get('definitionsAccepted') is True
                and row.get('baselineAccepted') is True and row.get('proofRejected') is True
                and type(row.get('kernelExitCode')) is int and row['kernelExitCode'] > 0
                and not row.get('timedOut') and not row.get('timeout')
                and row.get('getter') in set(verified)
                and all(identity(row.get(field)) for field in ('baselineSha256', 'definitionsSha256')),
                'storage getter invalid bytecode semantic control')
    require(len({row['name'] for row in vm_controls}) == len(vm_controls),
            'storage getter duplicated bytecode semantic control')
    summaries['storage-getters']['vmCorrespondenceProven'] = True
    summaries['storage-getters']['vmCorrespondenceScope'] = getters['vmCorrespondenceScope']
    summaries['storage-getters']['vmTraceCoverage'] = getters['vmTraceCoverage']
    summaries['storage-getters']['sharedCallees'] = callees
    summaries['storage-getters']['bodyLevelEntrypoints'] = verified
    summaries['storage-getters']['referenceBodyEntrypoints'] = []
    summaries['storage-getters']['vmSemanticControlCount'] = len(vm_controls)
    summaries['storage-getters']['established'] = [
        'Trace-level bytecode/source outcome agreement for the ' + str(len(verified))
        + ' pinned read-only storage getter regions and their shared private callees '
        + ', '.join(STORAGE_GETTER_SHARED_CALLEES)]
    summaries['storage-getters']['unproved'] = getters.get('unproved', [])
    summaries['storage-getters']['openObligations'] = getters['openObligations']
    hook = receipts['hook']
    hook_span = hook.get('methodRange')
    require(hook.get('referenceRefinementVerified') is True and hook.get('vmCorrespondenceProven') is False
            and hook.get('fullUnprovedEntrypointCount') == len(inventory['manifest']['methods'])
            and identity(hook.get('sourceProjection', {}).get('sourceProjectionSha256')),
            'private hook overclaimed/missing source scope')
    require(isinstance(hook_span,list) and len(hook_span)==2 and all(type(v) is int for v in hook_span)
            and 0 <= hook_span[0] < hook_span[1] <= len(raw) and hook.get('byteCount') == hook_span[1]-hook_span[0]
            and type(hook.get('instructionCount')) is int and hook['instructionCount'] > 0
            and hook.get('methodSha256') == sha(raw[hook_span[0]:hook_span[1]]), 'private hook range/bytes mismatch')
    summaries['hook']['methodRange'] = hook_span
    summaries['hook']['sourceProjectionSha256'] = hook['sourceProjection']['sourceProjectionSha256']
    runtime, gas = receipts['runtime'], receipts['gas']
    require(runtime.get('productionSourceBound') is True and runtime.get('sourceCommit') == VM_COMMIT
            and runtime.get('runtimeImplementationProven') is False and identity(runtime.get('sourceProjectionSha256')),
            'runtime source/scope mismatch')
    collection = receipts['runtime-collections']
    require(collection.get('productionSourceBound') is True and collection.get('sourceCommit') == VM_COMMIT
            and collection.get('runtimeImplementationProven') is False and identity(collection.get('sourceProjectionSha256')),
            'runtime collections source/scope mismatch')
    require(collection.get('supportingProjections') == COLLECTION_PARTIAL_SCOPES
            and not set(collection.get('provenOpcodes',[])) & set(COLLECTION_PARTIAL_SCOPES),
            'runtime collections partial projections omitted/promoted to complete')
    require(gas.get('productionSourceBound') is True and gas.get('sourceCommit') == CORE_COMMIT
            and gas.get('sourceFrontendVerified') is False and gas.get('applicationEngineVerified') is False
            and identity(gas.get('projectionSha256')), 'gas source/scope mismatch')
    codec = receipts['codec']
    require(codec.get('runtimeSourceSimulationProven') is False, 'codec forged universal runtime claim')
    typed_native = codec.get('typedNativeSource')
    require(typed_native is not None, 'codec typed source layer missing')
    if typed_native is not None:
        require(isinstance(typed_native, dict) and typed_native.get('kernelChecked') is True
                and typed_native.get('scope') == CODEC_SOURCE_SCOPE and typed_native.get('fullSourceSimulationProven') is False,
                'codec typed source overclaimed kernel/simulation scope')
        require(identity(typed_native.get('inventorySha256')) and identity(typed_native.get('projectionSha256')),
                'codec typed source identity missing')
        controls = typed_native.get('semanticControls')
        require(isinstance(controls, dict) and controls, 'codec typed source controls missing')
        require(all(isinstance(row, dict) and row.get('typedCompilationSucceeded') is True
                    and row.get('resolvedOperationProjectionSucceeded') is True and row.get('originalBehaviorRejected') is True
                    and not row.get('timedOut') for row in controls.values()), 'codec typed source controls invalid')
        summaries['codec']['typedNativeSource'] = typed_native
        declarations = set()
        for key in ('serializerKernel','deserializerKernel','sourceRoundtripKernel'):
            child = typed_native.get(key)
            require(isinstance(child,dict) and child.get('kernelChecked') is True and child.get('closedDeclarations')
                    and child.get('certificateSha256') == typed_native.get('certificateSha256'), 'codec source subset proof missing/mixed')
            require(not declarations & set(child['closedDeclarations']), 'codec duplicated source declarations')
            declarations.update(child['closedDeclarations'])
        require(declarations == set(typed_native.get('closedDeclarations', [])), 'codec source declaration join mismatch')
        baseline = typed_native.get('semanticControlBaseline')
        require(isinstance(baseline,dict) and baseline.get('kernelChecked') is True and identity(baseline.get('certificateSha256')),
                'codec source control baseline missing')
        require(identity(typed_native.get('sourceModelSha256')) and identity(typed_native.get('certificateSha256')),
                'codec source certificate/model identity missing')
        require(any(row.get('definitionsKernelCompiled') is True and row.get('serializerUniversalTheoremRejected') is True for row in controls.values())
                and any(row.get('definitionsKernelCompiled') is True and row.get('deserializerUniversalTheoremRejected') is True for row in controls.values()),
                'codec source kernel controls missing')
        summaries['codec']['typedSourceCountingScope'] = CODEC_SOURCE_SCOPE + '; not full source/runtime simulation'
    if native_vector_sha is not None:
        join, kernel = codec.get('nativeVectorJoin'), codec.get('nativeVectorKernel')
        require(isinstance(join, dict) and join.get('sha256') == native_vector_sha
                and isinstance(kernel, dict) and kernel.get('kernelChecked') is True
                and kernel.get('corruptedArtifactByteRejected') is True, 'native vector identity/controls mismatch')
    else:
        require(codec.get('nativeVectorJoin') is None and codec.get('nativeVectorKernel') is None, 'unselected native evidence')
    summaries['entry-dispatch'].update(validate_entry_dispatch_join(inventory, receipts))
    summaries['syscall-dispatch'].update(validate_syscall_dispatch_join(receipts))
    summaries['contract-handoff'].update(validate_contract_handoff_join(receipts))
    summaries['interop-conversion'].update(validate_interop_conversion_join(receipts))
    summaries['interop-fee-order'].update(validate_interop_fee_join(receipts))
    summaries['exception-identity'].update(validate_exception_identity_join(receipts))
    summaries['load-admission'].update(validate_load_admission_join(receipts))
    helper_gas = receipts['helper-gas']
    artifacts = helper_gas.get('artifacts', {})
    require(helper_gas.get('applicationEngineVerified') is False and helper_gas.get('sourceFrontendVerified') is False
            and helper_gas.get('sourceCommit') == CORE_COMMIT and helper_gas.get('sourcePricingPinned') is True
            and helper_gas.get('modelPriceBoundProved') is True and helper_gas.get('actualRuntimeCrossChecked') is True,
            'helper gas source/scope mismatch')
    require(artifacts.get('nefSha256') == inventory['nef']['sha256']
            and artifacts.get('scriptSha256') == inventory['nef']['scriptSha256']
            and artifacts.get('manifestSha256') == inventory['manifest']['sha256']
            and artifacts.get('helperSha256') == method.get('methodSha256'), 'helper gas artifact identity mismatch')
    return {'schema': 'neoos-sa-integrated-closure/v1', 'status': 'NO-GO', 'selectedScopeStatus': 'PASS',
            'implementationVerified': False, 'fullImplementationVerified': False, 'verifiedEntrypoints': [],
            'abiEntryCount': len(inventory['manifest']['methods']), 'fullUnprovedCount': len(inventory['manifest']['methods']),
            'entrypointCoverage': entrypoint_coverage(inventory, receipts),
            'unprovedEntrypoints': [e['name'] + '/' + str(len(e['parameters'])) for e in inventory['manifest']['methods']],
            'scopedClaims': summaries, 'nefSha256': inventory['nef']['sha256'], 'scriptSha256': inventory['nef']['scriptSha256'],
            'nativeVectorScope': 'finite-concrete-vectors-only' if native_vector_sha else 'NOT_SELECTED',
            'pinnedSourceIdentityJoin': source_identity_join(receipts),
            'openObligations': ['SOURCE_FRONTEND_AND_COMPILER_CORRESPONDENCE', 'ACTUAL_VM_APPLICATION_ENGINE_ABI_DISPATCH',
                                'GAS_RESOURCE_EXCEPTION_AND_TRANSACTION_COMPOSITION', 'ALL_PUBLIC_ENTRYPOINT_DEPENDENCY_CLOSURES']}


def require_bound_artifact(bound, inventory, label):
    require(bound.get('nefSha256') == inventory['nef']['sha256']
            and bound.get('scriptSha256') == inventory['nef']['scriptSha256'], label + ' actual decoded artifact identity mismatch')


def validate_entry_dispatch_join(inventory, receipts):
    """Join the admission/frame slice without promoting it to complete execution."""
    report = receipts['entry-dispatch']
    require(report.get('schema') == 'neoos-sa-entry-dispatch-proof/v1'
            and report.get('entryBoundary') == 'CallContract-after-interop-admission-and-argument-conversion'
            and report.get('productionSourceBound') is True
            and report.get('coqchkChecked') is True and report.get('assumptionsClosed') is True
            and report.get('coreSourceCommit') == CORE_COMMIT
            and report.get('neoVmSourceCommit') == VM_COMMIT,
            'entry-dispatch source/schema mismatch')
    require(all(report.get(field) is False for field in
                ('sourceFrontendVerified', 'applicationEngineVerified', 'vmCorrespondenceProven'))
            and report.get('fullUnprovedEntrypointCount') == len(inventory['manifest']['methods']),
            'entry-dispatch overclaimed frontend/runtime/public closure')
    require(report.get('manifestSha256') == inventory['manifest']['sha256']
            and identity(report.get('inventorySha256'))
            and identity(report.get('sourceProjectionSha256'))
            and identity(report.get('certificateSha256')),
            'entry-dispatch missing/mixed artifact or projection identity')
    pinned = report.get('pinnedSource')
    require(isinstance(pinned, dict) and pinned
            and all(isinstance(row, dict) and isinstance(row.get('path'), str)
                    and row['path'] and identity(row.get('sha256'))
                    and isinstance(row.get('url'), str) for row in pinned.values())
            and all(any('/' + repository + '/' + commit + '/' in row['url']
                        for row in pinned.values())
                    for repository, commit in (('neo', CORE_COMMIT), ('neo-vm', VM_COMMIT))),
            'entry-dispatch missing pinned core/VM source')
    public = receipts['public']['methods']
    entries = report.get('entries')
    require(isinstance(entries, dict) and entries and set(entries) == set(public)
            and report.get('referenceVerifiedEntrypoints') == sorted(entries),
            'entry-dispatch missing/extra public reference entry')
    raw = bytes.fromhex(inventory['nef']['scriptHex'])
    for name, entry in entries.items():
        body = public[name]
        require(isinstance(entry, dict) and entry.get('abi') == body['abi']
                and entry.get('methodRange') == [body['start'], body['end']]
                and entry.get('methodSha256') == body['methodSha256']
                and type(entry.get('instructionCount')) is int and entry['instructionCount'] > 0
                and entry.get('instructionCount') == body['instructionCount'],
                'entry-dispatch public ABI/body identity mismatch')
        abi = entry['abi']
        require(abi.get('safe') is True and abi.get('returntype') != 'Void'
                and not name.startswith('_') and abi.get('name') == name
                and body['start'] == abi.get('offset')
                and body['methodSha256'] == sha(raw[body['start']:body['end']]),
                'entry-dispatch unsupported/wrong public ABI')
    initializer = report.get('initializer')
    abis = [entry for entry in inventory['manifest']['methods'] if entry['name'] == '_initialize']
    context = receipts['context']
    require(isinstance(initializer, dict) and len(abis) == 1
            and initializer.get('abi') == abis[0]
            and abis[0].get('parameters') == [] and abis[0].get('returntype') == 'Void'
            and initializer.get('methodRange') == context['initializerRange']
            and initializer.get('methodSha256') == context['initializerSha256']
            and type(initializer.get('instructionCount')) is int and initializer['instructionCount'] > 0
            and initializer['instructionCount'] == context.get('instructionCount'),
            'entry-dispatch initializer identity mismatch')
    controls = report.get('semanticControls')
    require(isinstance(controls, list) and controls,
            'entry-dispatch missing detailed semantic controls')
    names = []
    for row in controls:
        require(isinstance(row, dict) and isinstance(row.get('name'), str) and row['name']
                and row.get('definitionsCompiled') is True and row.get('certificateRejected') is True
                and row.get('definitionLanguage') == 'Coq source projection'
                and row.get('kernelCounterexampleChecked') is True
                and type(row.get('kernelExitCode')) is int and row['kernelExitCode'] > 0
                and not row.get('timedOut') and not row.get('timeout'),
                'entry-dispatch invalid semantic control')
        require(all(identity(row.get(field)) for field in ('sourceMutationSha256', 'projectionSha256',
                    'definitionsSha256', 'counterexampleSha256', 'rejectionLogSha256')),
                'entry-dispatch missing semantic control identities')
        names.append(row['name'])
    require(len(set(names)) == len(names), 'entry-dispatch duplicate semantic control')
    require(set(names) == set(ENTRY_DISPATCH_CONTROLS), 'entry-dispatch incomplete/extra semantic controls')
    for field in ('preconditions', 'unproved', 'tcb'):
        require(report.get(field) == ENTRY_DISPATCH_DOMAIN[field],
                'entry-dispatch omitted/changed ' + field)
    return {'referenceFrameEntrypoints': sorted(entries),
            'entryBoundary': report['entryBoundary'],
            'fullUnprovedEntrypointCount': report['fullUnprovedEntrypointCount'],
            'manifestSha256': report['manifestSha256'],
            'preconditions': report['preconditions'], 'tcb': report['tcb'],
            'unproved': report['unproved'], 'applicationEngineVerified': False,
            'sourceFrontendVerified': False, 'vmCorrespondenceProven': False}


def validate_syscall_dispatch_join(receipts):
    """Join the interop admission bridge without promoting it to execution.

    This lane covers what the entry-dispatch lane explicitly excludes: the
    System.Contract.Call / CALLT admission and the handoff into
    CallContractInternal. It stops at the handed-off argument vector, so it
    cannot close an entrypoint either.
    """
    report = receipts['syscall-dispatch']
    require(report.get('schema') == 'neoos-sa-syscall-dispatch-proof/v1'
            and report.get('entryBoundary') == 'CallContractInternal-parameter-tuple'
            and report.get('productionSourceBound') is True
            and report.get('kernelChecked') is True
            and report.get('coqchkChecked') is True and report.get('assumptionsClosed') is True
            and report.get('coreSourceCommit') == CORE_COMMIT
            and report.get('neoVmSourceCommit') == VM_COMMIT,
            'syscall-dispatch source/schema mismatch')
    require(all(report.get(field) is False for field in
                ('sourceFrontendVerified', 'applicationEngineVerified', 'vmCorrespondenceProven',
                 'implementationVerified', 'fullImplementationVerified')),
            'syscall-dispatch overclaimed frontend/runtime/public closure')
    require(identity(report.get('sourceProjectionSha256')) and identity(report.get('certificateSha256')),
            'syscall-dispatch missing/mixed projection or certificate identity')
    pinned = report.get('pinnedSource')
    require(isinstance(pinned, dict) and pinned
            and all(isinstance(row, dict) and isinstance(row.get('path'), str) and row['path']
                    and Path(row['path']).is_absolute()
                    and identity(row.get('sha256')) and isinstance(row.get('url'), str)
                    for row in pinned.values())
            and all(any('/' + repository + '/' + commit + '/' in row['url'] for row in pinned.values())
                    for repository, commit in (('neo', CORE_COMMIT), ('neo-vm', VM_COMMIT))),
            'syscall-dispatch missing pinned core/VM source')
    require(literal_equal(report.get('program'), SYSCALL_DISPATCH_PROGRAM),
            'syscall-dispatch changed the projected admission record')
    require(report.get('handlerParameters') == SYSCALL_DISPATCH_HANDLER_PARAMETERS,
            'syscall-dispatch changed the handler parameter list')
    require(report.get('tokenFields') == SYSCALL_DISPATCH_TOKEN_FIELDS,
            'syscall-dispatch changed the method token fields')
    controls = report.get('semanticControls')
    require(isinstance(controls, list)
            and [row.get('name') for row in controls] == list(SYSCALL_DISPATCH_CONTROLS),
            'syscall-dispatch missing/reordered semantic controls')
    for row in controls:
        require(row.get('definitionsCompiled') is True and row.get('certificateRejected') is True
                and row.get('kernelCounterexampleChecked') is True
                and type(row.get('kernelExitCode')) is int and row['kernelExitCode'] > 0
                and not row.get('timedOut') and not row.get('timeout'),
                'syscall-dispatch invalid semantic control: ' + str(row.get('name')))
        require(all(identity(row.get(field)) for field in
                    ('sourceMutationSha256', 'projectionSha256', 'definitionsSha256',
                     'counterexampleSha256', 'rejectionLogSha256')),
                'syscall-dispatch missing semantic control identities: ' + str(row.get('name')))
    require(isinstance(report.get('controlProofSha256'), dict)
            and set(report['controlProofSha256']) == {name + '/' + filename
                for name in SYSCALL_DISPATCH_CONTROLS
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and isinstance(report.get('controlLogSha256'), dict)
            and set(report['controlLogSha256']) == {name + '/' + filename
                for name in SYSCALL_DISPATCH_CONTROLS
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log')}
            and all(identity(value) for value in
                    list(report['controlProofSha256'].values()) + list(report['controlLogSha256'].values())),
            'syscall-dispatch incomplete/changed control file inventory')
    for field, values in SYSCALL_DISPATCH_DOMAIN.items():
        require(report.get(field) == values, 'syscall-dispatch omitted/changed ' + field)
    declarations = report.get('closedDeclarations')
    require(isinstance(declarations, dict)
            and set(declarations) == {'SyscallDispatch', 'SyscallDispatchArtifact'}
            and all(isinstance(names, list) and names and len(set(names)) == len(names)
                    for names in declarations.values())
            and report.get('closedAssumptionCount') == sum(len(names) for names in declarations.values()),
            'syscall-dispatch declaration inventory mismatch')
    require(report.get('kernelDeclarations') == declarations['SyscallDispatchArtifact'],
            'syscall-dispatch certificate declaration inventory mismatch')
    return {'entryBoundary': report['entryBoundary'], 'projectedProgram': report['program'],
            'closedAssumptionCount': report['closedAssumptionCount'],
            'preconditions': report['preconditions'], 'tcb': report['tcb'], 'unproved': report['unproved'],
            'sourceFrontendVerified': False, 'applicationEngineVerified': False,
            'vmCorrespondenceProven': False}


def validate_syscall_dispatch_control_files(report, evidence_directory):
    root = Path(evidence_directory).resolve()
    files, logs = report.get('controlProofSha256'), report.get('controlLogSha256')
    require(isinstance(files, dict) and isinstance(logs, dict)
            and set(files) == {name + '/' + filename for name in SYSCALL_DISPATCH_CONTROLS
                               for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and set(logs) == {name + '/' + filename for name in SYSCALL_DISPATCH_CONTROLS
                              for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                               'counterexample-coqchk.log')},
            'syscall-dispatch missing/extra control file identities')
    for name, expected in list(files.items()) + list(logs.items()):
        path = root/name
        require(root in path.resolve().parents and identity(expected)
                and sha(path.read_bytes()) == expected,
                'syscall-dispatch control proof byte mismatch: ' + name)
    rows = report.get('semanticControls')
    require(isinstance(rows, list)
            and [row.get('name') for row in rows] == list(SYSCALL_DISPATCH_CONTROLS),
            'syscall-dispatch control file row inventory mismatch')
    for row in rows:
        name = row['name']
        require(row.get('definitionsSha256') == files[name + '/Definitions.v']
                and row.get('counterexampleSha256') == files[name + '/Counterexample.v']
                and row.get('rejectionLogSha256') == logs[name + '/rejection.log'],
                'syscall-dispatch control row/file identity mismatch: ' + name)
    # Independently re-read the closure claims instead of trusting the receipt.
    for filename, module in (('model.log', 'SyscallDispatch'),
                             ('certificate.log', 'SyscallDispatchArtifact')):
        text = (root/filename).read_text()
        require(text.count('Closed under the global context') == len(report['closedDeclarations'][module])
                and 'Axioms:' not in text,
                'syscall-dispatch ' + filename + ' did not close every declaration')


def validate_contract_handoff_join(receipts):
    """Join the handoff into the caller's frame without promoting it to execution.

    This lane starts where the entry-dispatch lane stops forward and where the
    syscall lane stops: the second CallContractInternal overload and the frame
    LoadContract returns.  It ends before the callee's first instruction, so it
    cannot close an entrypoint either.
    """
    report = receipts['contract-handoff']
    require(report.get('schema') == 'neoos-sa-contract-handoff-proof/v1'
            and report.get('entryBoundary') == 'LoadContract-returned-context-before-callee-execution'
            and report.get('productionSourceBound') is True
            and report.get('kernelChecked') is True
            and report.get('coqchkChecked') is True and report.get('assumptionsClosed') is True
            and report.get('coreSourceCommit') == CORE_COMMIT
            and report.get('neoVmSourceCommit') == VM_COMMIT,
            'contract-handoff source/schema mismatch')
    require(all(report.get(field) is False for field in
                ('sourceFrontendVerified', 'applicationEngineVerified', 'vmCorrespondenceProven',
                 'implementationVerified', 'fullImplementationVerified')),
            'contract-handoff overclaimed frontend/runtime/public closure')
    require(identity(report.get('sourceProjectionSha256')) and identity(report.get('certificateSha256')),
            'contract-handoff missing/mixed projection or certificate identity')
    pinned = report.get('pinnedSource')
    require(isinstance(pinned, dict) and len(pinned) == 9
            and all(isinstance(row, dict) and isinstance(row.get('path'), str) and row['path']
                    and Path(row['path']).is_absolute()
                    and identity(row.get('sha256')) and isinstance(row.get('url'), str)
                    for row in pinned.values())
            and all(any('/' + repository + '/' + commit + '/' in row['url'] for row in pinned.values())
                    for repository, commit in (('neo', CORE_COMMIT), ('neo-vm', VM_COMMIT))),
            'contract-handoff missing pinned core/VM source')
    require(literal_equal(report.get('program'), CONTRACT_HANDOFF_PROGRAM),
            'contract-handoff changed the projected handoff record')
    require(report.get('reasonOnlyGuards') == ['contract-absent', 'method-absent',
                                               'arity-equality', 'return-xor'],
            'contract-handoff changed the reason-only guard list')
    controls = report.get('semanticControls')
    require(isinstance(controls, list)
            and [row.get('name') for row in controls] == list(CONTRACT_HANDOFF_CONTROLS),
            'contract-handoff missing/reordered semantic controls')
    for row in controls:
        require(row.get('definitionsCompiled') is True and row.get('certificateRejected') is True
                and row.get('kernelCounterexampleChecked') is True
                and type(row.get('kernelExitCode')) is int and row['kernelExitCode'] > 0
                and not row.get('timedOut') and not row.get('timeout'),
                'contract-handoff invalid semantic control: ' + str(row.get('name')))
        require(all(identity(row.get(field)) for field in
                    ('sourceMutationSha256', 'projectionSha256', 'definitionsSha256',
                     'counterexampleSha256', 'rejectionLogSha256')),
                'contract-handoff missing semantic control identities: ' + str(row.get('name')))
    require(isinstance(report.get('controlProofSha256'), dict)
            and set(report['controlProofSha256']) == {name + '/' + filename
                for name in CONTRACT_HANDOFF_CONTROLS
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and isinstance(report.get('controlLogSha256'), dict)
            and set(report['controlLogSha256']) == {name + '/' + filename
                for name in CONTRACT_HANDOFF_CONTROLS
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log')}
            and all(identity(value) for value in
                    list(report['controlProofSha256'].values()) + list(report['controlLogSha256'].values())),
            'contract-handoff incomplete/changed control file inventory')
    for field, values in CONTRACT_HANDOFF_DOMAIN.items():
        require(report.get(field) == values, 'contract-handoff omitted/changed ' + field)
    declarations = report.get('closedDeclarations')
    require(isinstance(declarations, dict)
            and set(declarations) == {'ContractHandoff', 'ContractHandoffArtifact'}
            and all(isinstance(names, list) and names and len(set(names)) == len(names)
                    for names in declarations.values())
            and report.get('closedAssumptionCount') == sum(len(names) for names in declarations.values()),
            'contract-handoff declaration inventory mismatch')
    require(report.get('kernelDeclarations') == declarations['ContractHandoffArtifact'],
            'contract-handoff certificate declaration inventory mismatch')
    return {'entryBoundary': report['entryBoundary'], 'projectedProgram': report['program'],
            'closedAssumptionCount': report['closedAssumptionCount'],
            'preconditions': report['preconditions'], 'tcb': report['tcb'], 'unproved': report['unproved'],
            'sourceFrontendVerified': False, 'applicationEngineVerified': False,
            'vmCorrespondenceProven': False}


def validate_contract_handoff_control_files(report, evidence_directory):
    root = Path(evidence_directory).resolve()
    files, logs = report.get('controlProofSha256'), report.get('controlLogSha256')
    require(isinstance(files, dict) and isinstance(logs, dict)
            and set(files) == {name + '/' + filename for name in CONTRACT_HANDOFF_CONTROLS
                               for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and set(logs) == {name + '/' + filename for name in CONTRACT_HANDOFF_CONTROLS
                              for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                               'counterexample-coqchk.log')},
            'contract-handoff missing/extra control file identities')
    for name, expected in list(files.items()) + list(logs.items()):
        path = root/name
        require(root in path.resolve().parents and identity(expected)
                and sha(path.read_bytes()) == expected,
                'contract-handoff control proof byte mismatch: ' + name)
    rows = report.get('semanticControls')
    require(isinstance(rows, list)
            and [row.get('name') for row in rows] == list(CONTRACT_HANDOFF_CONTROLS),
            'contract-handoff control file row inventory mismatch')
    for row in rows:
        name = row['name']
        require(row.get('definitionsSha256') == files[name + '/Definitions.v']
                and row.get('counterexampleSha256') == files[name + '/Counterexample.v']
                and row.get('rejectionLogSha256') == logs[name + '/rejection.log'],
                'contract-handoff control row/file identity mismatch: ' + name)
    # Independently re-read the closure claims instead of trusting the receipt.
    for filename, module in (('model.log', 'ContractHandoff'),
                             ('certificate.log', 'ContractHandoffArtifact')):
        text = (root/filename).read_text()
        require(text.count('Closed under the global context') == len(report['closedDeclarations'][module])
                and 'Axioms:' not in text,
                'contract-handoff ' + filename + ' did not close every declaration')


def validate_interop_conversion_join(receipts):
    """Join the converted argument vector without promoting it to handler execution.

    This lane starts where the syscall lane stops: OnSysCall turns the caller's
    stack window into the invoked handler's arguments.  It ends at that vector,
    before the handler body runs, so it cannot close an entrypoint either.
    """
    report = receipts['interop-conversion']
    require(report.get('schema') == 'neoos-sa-interop-conversion-proof/v1'
            and report.get('entryBoundary') == 'OnSysCall-argument-window-to-invoked-handler-parameters'
            and report.get('productionSourceBound') is True
            and report.get('kernelChecked') is True
            and report.get('coqchkChecked') is True and report.get('assumptionsClosed') is True
            and report.get('coreSourceCommit') == CORE_COMMIT
            and report.get('neoVmSourceCommit') == VM_COMMIT,
            'interop-conversion source/schema mismatch')
    require(all(report.get(field) is False for field in
                ('sourceFrontendVerified', 'applicationEngineVerified', 'vmCorrespondenceProven',
                 'implementationVerified', 'fullImplementationVerified')),
            'interop-conversion overclaimed frontend/runtime/public closure')
    require(identity(report.get('sourceProjectionSha256')) and identity(report.get('certificateSha256')),
            'interop-conversion missing/mixed projection or certificate identity')
    pinned = report.get('pinnedSource')
    require(isinstance(pinned, dict) and len(pinned) == 4
            and all(isinstance(row, dict) and isinstance(row.get('path'), str) and row['path']
                    and Path(row['path']).is_absolute()
                    and identity(row.get('sha256')) and isinstance(row.get('url'), str)
                    for row in pinned.values())
            and all(any('/' + repository + '/' + commit + '/' in row['url'] for row in pinned.values())
                    for repository, commit in (('neo', CORE_COMMIT), ('neo-vm', VM_COMMIT))),
            'interop-conversion missing pinned core/VM source')
    require(literal_equal(report.get('program'), INTEROP_CONVERSION_PROGRAM),
            'interop-conversion changed the projected conversion record')
    require(report.get('reasonOnlyGuards') == ['call-flags', 'descriptor-validators'],
            'interop-conversion changed the reason-only guard list')
    require(report.get('parameters') == [list(row) for row in INTEROP_CONVERSION_ARGUMENTS],
            'interop-conversion changed the declared argument list')
    controls = report.get('semanticControls')
    require(isinstance(controls, list)
            and [row.get('name') for row in controls] == list(INTEROP_CONVERSION_CONTROLS),
            'interop-conversion missing/reordered semantic controls')
    for row in controls:
        require(row.get('definitionsCompiled') is True and row.get('certificateRejected') is True
                and row.get('kernelCounterexampleChecked') is True
                and type(row.get('kernelExitCode')) is int and row['kernelExitCode'] > 0
                and not row.get('timedOut') and not row.get('timeout'),
                'interop-conversion invalid semantic control: ' + str(row.get('name')))
        require(all(identity(row.get(field)) for field in
                    ('sourceMutationSha256', 'projectionSha256', 'definitionsSha256',
                     'counterexampleSha256', 'rejectionLogSha256')),
                'interop-conversion missing semantic control identities: ' + str(row.get('name')))
    require(isinstance(report.get('controlProofSha256'), dict)
            and set(report['controlProofSha256']) == {name + '/' + filename
                for name in INTEROP_CONVERSION_CONTROLS
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and isinstance(report.get('controlLogSha256'), dict)
            and set(report['controlLogSha256']) == {name + '/' + filename
                for name in INTEROP_CONVERSION_CONTROLS
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log')}
            and all(identity(value) for value in
                    list(report['controlProofSha256'].values()) + list(report['controlLogSha256'].values())),
            'interop-conversion incomplete/changed control file inventory')
    for field, values in INTEROP_CONVERSION_DOMAIN.items():
        require(report.get(field) == values, 'interop-conversion omitted/changed ' + field)
    declarations = report.get('closedDeclarations')
    require(isinstance(declarations, dict)
            and set(declarations) == {'InteropConvert', 'InteropConvertArtifact'}
            and all(isinstance(names, list) and names and len(set(names)) == len(names)
                    for names in declarations.values())
            and report.get('closedAssumptionCount') == sum(len(names) for names in declarations.values()),
            'interop-conversion declaration inventory mismatch')
    require(report.get('kernelDeclarations') == declarations['InteropConvertArtifact'],
            'interop-conversion certificate declaration inventory mismatch')
    return {'entryBoundary': report['entryBoundary'], 'projectedProgram': report['program'],
            'declaredArguments': report['parameters'],
            'closedAssumptionCount': report['closedAssumptionCount'],
            'preconditions': report['preconditions'], 'tcb': report['tcb'],
            'unproved': report['unproved'], 'sourceFrontendVerified': False,
            'applicationEngineVerified': False, 'vmCorrespondenceProven': False}


def validate_interop_conversion_control_files(report, evidence_directory):
    root = Path(evidence_directory).resolve()
    files, logs = report.get('controlProofSha256'), report.get('controlLogSha256')
    require(isinstance(files, dict) and isinstance(logs, dict)
            and set(files) == {name + '/' + filename for name in INTEROP_CONVERSION_CONTROLS
                               for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and set(logs) == {name + '/' + filename for name in INTEROP_CONVERSION_CONTROLS
                              for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                               'counterexample-coqchk.log')},
            'interop-conversion missing/extra control file identities')
    for name, expected in list(files.items()) + list(logs.items()):
        path = root/name
        require(root in path.resolve().parents and identity(expected)
                and sha(path.read_bytes()) == expected,
                'interop-conversion control proof byte mismatch: ' + name)
    rows = report.get('semanticControls')
    require(isinstance(rows, list)
            and [row.get('name') for row in rows] == list(INTEROP_CONVERSION_CONTROLS),
            'interop-conversion control file row inventory mismatch')
    for row in rows:
        name = row['name']
        require(row.get('definitionsSha256') == files[name + '/Definitions.v']
                and row.get('counterexampleSha256') == files[name + '/Counterexample.v']
                and row.get('rejectionLogSha256') == logs[name + '/rejection.log'],
                'interop-conversion control row/file identity mismatch: ' + name)
    # Independently re-read the closure claims instead of trusting the receipt.
    for filename, module in (('model.log', 'InteropConvert'),
                             ('certificate.log', 'InteropConvertArtifact')):
        text = (root/filename).read_text()
        require(text.count('Closed under the global context') == len(report['closedDeclarations'][module])
                and 'Axioms:' not in text,
                'interop-conversion ' + filename + ' did not close every declaration')


def validate_interop_fee_join(receipts):
    """Join the descriptor charge without promoting it to conversion or gas.

    This lane covers what the conversion lane excludes backward: the fixed
    descriptor price is read and charged before the first value is popped, so no
    conversion fault can move it.  It stops at that window effect; it does not
    model the conversion, the handler, or how the fee factor was obtained.
    """
    report = receipts['interop-fee-order']
    require(report.get('schema') == 'neoos-sa-interop-charge-proof/v1'
            and report.get('entryBoundary') == 'OnSysCall-descriptor-charge-to-argument-window-effect'
            and report.get('productionSourceBound') is True
            and report.get('kernelChecked') is True
            and report.get('coqchkChecked') is True and report.get('assumptionsClosed') is True
            and report.get('coreSourceCommit') == CORE_COMMIT,
            'interop-fee-order source/schema mismatch')
    require(all(report.get(field) is False for field in
                ('sourceFrontendVerified', 'applicationEngineVerified', 'vmCorrespondenceProven',
                 'implementationVerified', 'fullImplementationVerified')),
            'interop-fee-order overclaimed frontend/runtime/public closure')
    require(identity(report.get('sourceProjectionSha256')) and identity(report.get('certificateSha256')),
            'interop-fee-order missing/mixed projection or certificate identity')
    pinned = report.get('pinnedSource')
    require(isinstance(pinned, dict) and len(pinned) == 2
            and set(pinned) == {'core/engine', 'core/descriptor'}
            and all(isinstance(row, dict) and isinstance(row.get('path'), str) and row['path']
                    and Path(row['path']).is_absolute()
                    and identity(row.get('sha256')) and isinstance(row.get('url'), str)
                    for row in pinned.values())
            and all('/neo/' + CORE_COMMIT + '/' in row['url'] for row in pinned.values()),
            'interop-fee-order missing pinned core source')
    require(literal_equal(report.get('program'), INTEROP_FEE_PROGRAM),
            'interop-fee-order changed the projected charge record')
    require(report.get('reasonOnlyGuards') == ['descriptor-price-identity', 'fee-factor-source'],
            'interop-fee-order changed the reason-only guard list')
    controls = report.get('semanticControls')
    require(isinstance(controls, list)
            and [row.get('name') for row in controls] == list(INTEROP_FEE_CONTROLS),
            'interop-fee-order missing/reordered semantic controls')
    for row in controls:
        require(row.get('definitionsCompiled') is True and row.get('certificateRejected') is True
                and row.get('kernelCounterexampleChecked') is True
                and type(row.get('kernelExitCode')) is int and row['kernelExitCode'] > 0
                and not row.get('timedOut') and not row.get('timeout'),
                'interop-fee-order invalid semantic control: ' + str(row.get('name')))
        require(all(identity(row.get(field)) for field in
                    ('sourceMutationSha256', 'projectionSha256', 'definitionsSha256',
                     'counterexampleSha256', 'rejectionLogSha256')),
                'interop-fee-order missing semantic control identities: ' + str(row.get('name')))
    require(isinstance(report.get('controlProofSha256'), dict)
            and set(report['controlProofSha256']) == {name + '/' + filename
                for name in INTEROP_FEE_CONTROLS
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and isinstance(report.get('controlLogSha256'), dict)
            and set(report['controlLogSha256']) == {name + '/' + filename
                for name in INTEROP_FEE_CONTROLS
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log')}
            and all(identity(value) for value in
                    list(report['controlProofSha256'].values()) + list(report['controlLogSha256'].values())),
            'interop-fee-order incomplete/changed control file inventory')
    for field, values in INTEROP_FEE_DOMAIN.items():
        require(report.get(field) == values, 'interop-fee-order omitted/changed ' + field)
    declarations = report.get('closedDeclarations')
    require(isinstance(declarations, dict)
            and set(declarations) == {'InteropFee', 'InteropFeeArtifact'}
            and all(isinstance(names, list) and names and len(set(names)) == len(names)
                    for names in declarations.values())
            and report.get('closedAssumptionCount') == sum(len(names) for names in declarations.values()),
            'interop-fee-order declaration inventory mismatch')
    require(report.get('kernelDeclarations') == declarations['InteropFeeArtifact'],
            'interop-fee-order certificate declaration inventory mismatch')
    return {'entryBoundary': report['entryBoundary'], 'projectedProgram': report['program'],
            'closedAssumptionCount': report['closedAssumptionCount'],
            'preconditions': report['preconditions'], 'tcb': report['tcb'],
            'unproved': report['unproved'], 'sourceFrontendVerified': False,
            'applicationEngineVerified': False, 'vmCorrespondenceProven': False}


def validate_interop_fee_control_files(report, evidence_directory):
    root = Path(evidence_directory).resolve()
    files, logs = report.get('controlProofSha256'), report.get('controlLogSha256')
    require(isinstance(files, dict) and isinstance(logs, dict)
            and set(files) == {name + '/' + filename for name in INTEROP_FEE_CONTROLS
                               for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and set(logs) == {name + '/' + filename for name in INTEROP_FEE_CONTROLS
                              for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                               'counterexample-coqchk.log')},
            'interop-fee-order missing/extra control file identities')
    for name, expected in list(files.items()) + list(logs.items()):
        path = root/name
        require(root in path.resolve().parents and identity(expected)
                and sha(path.read_bytes()) == expected,
                'interop-fee-order control proof byte mismatch: ' + name)
    rows = report.get('semanticControls')
    require(isinstance(rows, list)
            and [row.get('name') for row in rows] == list(INTEROP_FEE_CONTROLS),
            'interop-fee-order control file row inventory mismatch')
    for row in rows:
        name = row['name']
        require(row.get('definitionsSha256') == files[name + '/Definitions.v']
                and row.get('counterexampleSha256') == files[name + '/Counterexample.v']
                and row.get('rejectionLogSha256') == logs[name + '/rejection.log'],
                'interop-fee-order control row/file identity mismatch: ' + name)
    # Independently re-read the closure claims instead of trusting the receipt.
    for filename, module in (('model.log', 'InteropFee'),
                             ('certificate.log', 'InteropFeeArtifact')):
        text = (root/filename).read_text()
        require(text.count('Closed under the global context') == len(report['closedDeclarations'][module])
                and 'Axioms:' not in text,
                'interop-fee-order ' + filename + ' did not close every declaration')


def validate_exception_identity_join(receipts):
    """Join the exception identity lane: which failure reaches whom, and how.

    The lane records the VM instruction loop's guarded clause, the untyped outer
    handler, the throw walk and the two engine fault hooks. It stops at the
    fault-state effect: it does not model instruction semantics, the TRY-stack
    protocol, or any transaction composition.
    """
    report = receipts['exception-identity']
    require(report.get('schema') == 'neoos-sa-exception-identity-proof/v1'
            and report.get('entryBoundary')
                == 'ExecuteNext-fault-surfacing-and-catch-admission-effect'
            and report.get('productionSourceBound') is True
            and report.get('kernelChecked') is True
            and report.get('coqchkChecked') is True and report.get('assumptionsClosed') is True
            and report.get('coreSourceCommit') == CORE_COMMIT
            and report.get('vmSourceCommit') == VM_COMMIT,
            'exception-identity source/schema mismatch')
    require(all(report.get(field) is False for field in
                ('sourceFrontendVerified', 'applicationEngineVerified', 'vmCorrespondenceProven',
                 'implementationVerified', 'fullImplementationVerified')),
            'exception-identity overclaimed frontend/runtime/public closure')
    require(identity(report.get('sourceProjectionSha256')) and identity(report.get('certificateSha256')),
            'exception-identity missing/mixed projection or certificate identity')
    pinned = report.get('pinnedSource')
    require(isinstance(pinned, dict) and set(pinned) == set(EXCEPTION_IDENTITY_SOURCES)
            and all(isinstance(row, dict) and isinstance(row.get('path'), str) and row['path']
                    and Path(row['path']).is_absolute()
                    and identity(row.get('sha256')) and isinstance(row.get('url'), str)
                    for row in pinned.values())
            and all(row['url'] == 'https://raw.githubusercontent.com/neo-project/'
                        + ('neo' if key == 'core/engine' else 'neo-vm') + '/'
                        + EXCEPTION_IDENTITY_SOURCES[key][0] + '/'
                        + EXCEPTION_IDENTITY_SOURCES[key][1]
                    for key, row in pinned.items()),
            'exception-identity missing/swapped pinned source')
    require(literal_equal(report.get('program'), EXCEPTION_IDENTITY_PROGRAM),
            'exception-identity changed the projected catch record')
    require(report.get('reasonOnlyGuards') == ['catch-clause-subtyping',
                                               'fault-terminates-the-turn'],
            'exception-identity changed the reason-only guard list')
    controls = report.get('semanticControls')
    require(isinstance(controls, list)
            and [row.get('name') for row in controls] == list(EXCEPTION_IDENTITY_CONTROLS),
            'exception-identity missing/reordered semantic controls')
    for row in controls:
        require(row.get('definitionsCompiled') is True and row.get('certificateRejected') is True
                and row.get('kernelCounterexampleChecked') is True
                and type(row.get('kernelExitCode')) is int and row['kernelExitCode'] > 0
                and not row.get('timedOut') and not row.get('timeout'),
                'exception-identity invalid semantic control: ' + str(row.get('name')))
        require(all(identity(row.get(field)) for field in
                    ('sourceMutationSha256', 'projectionSha256', 'definitionsSha256',
                     'counterexampleSha256', 'rejectionLogSha256')),
                'exception-identity missing semantic control identities: ' + str(row.get('name')))
    require(isinstance(report.get('controlProofSha256'), dict)
            and set(report['controlProofSha256']) == {name + '/' + filename
                for name in EXCEPTION_IDENTITY_CONTROLS
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and isinstance(report.get('controlLogSha256'), dict)
            and set(report['controlLogSha256']) == {name + '/' + filename
                for name in EXCEPTION_IDENTITY_CONTROLS
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log')}
            and all(identity(value) for value in
                    list(report['controlProofSha256'].values()) + list(report['controlLogSha256'].values())),
            'exception-identity incomplete/changed control file inventory')
    for field, values in EXCEPTION_IDENTITY_DOMAIN.items():
        require(report.get(field) == values, 'exception-identity omitted/changed ' + field)
    declarations = report.get('closedDeclarations')
    require(isinstance(declarations, dict)
            and set(declarations) == {'ExceptionIdentity', 'ExceptionIdentityArtifact'}
            and all(isinstance(names, list) and names and len(set(names)) == len(names)
                    for names in declarations.values())
            and report.get('closedAssumptionCount') == sum(len(names) for names in declarations.values()),
            'exception-identity declaration inventory mismatch')
    require(report.get('kernelDeclarations') == declarations['ExceptionIdentityArtifact'],
            'exception-identity certificate declaration inventory mismatch')
    return {'entryBoundary': report['entryBoundary'], 'projectedProgram': report['program'],
            'closedAssumptionCount': report['closedAssumptionCount'],
            'preconditions': report['preconditions'], 'tcb': report['tcb'],
            'unproved': report['unproved'], 'sourceFrontendVerified': False,
            'applicationEngineVerified': False, 'vmCorrespondenceProven': False}


def validate_exception_identity_control_files(report, evidence_directory):
    root = Path(evidence_directory).resolve()
    files, logs = report.get('controlProofSha256'), report.get('controlLogSha256')
    require(isinstance(files, dict) and isinstance(logs, dict)
            and set(files) == {name + '/' + filename for name in EXCEPTION_IDENTITY_CONTROLS
                               for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and set(logs) == {name + '/' + filename for name in EXCEPTION_IDENTITY_CONTROLS
                              for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                               'counterexample-coqchk.log')},
            'exception-identity missing/extra control file identities')
    for name, expected in list(files.items()) + list(logs.items()):
        path = root/name
        require(root in path.resolve().parents and identity(expected)
                and sha(path.read_bytes()) == expected,
                'exception-identity control proof byte mismatch: ' + name)
    rows = report.get('semanticControls')
    require(isinstance(rows, list)
            and [row.get('name') for row in rows] == list(EXCEPTION_IDENTITY_CONTROLS),
            'exception-identity control file row inventory mismatch')
    for row in rows:
        name = row['name']
        require(row.get('definitionsSha256') == files[name + '/Definitions.v']
                and row.get('counterexampleSha256') == files[name + '/Counterexample.v']
                and row.get('rejectionLogSha256') == logs[name + '/rejection.log'],
                'exception-identity control row/file identity mismatch: ' + name)
    # Independently re-read the closure claims instead of trusting the receipt.
    for filename, module in (('model.log', 'ExceptionIdentity'),
                             ('certificate.log', 'ExceptionIdentityArtifact')):
        text = (root/filename).read_text()
        require(text.count('Closed under the global context') == len(report['closedDeclarations'][module])
                and 'Axioms:' not in text,
                'exception-identity ' + filename + ' did not close every declaration')


def validate_load_admission_join(receipts):
    """Join the load admission lane: what a manifest or token may declare.

    The lane records the two admission surfaces the dispatch lanes start after:
    the nef read order with its structural checks, and the manifest/ABI
    declarations the loader refuses together with the exact-arity lookup. It
    stops at the value the loader returns: no deployment path, no gas, no
    compiler correspondence.
    """
    report = receipts['load-admission']
    require(report.get('schema') == 'neoos-sa-load-admission-proof/v1'
            and report.get('entryBoundary')
                == 'manifest-parse-and-nef-deserialize-admission-to-exact-arity-resolution'
            and report.get('productionSourceBound') is True
            and report.get('kernelChecked') is True
            and report.get('coqchkChecked') is True and report.get('assumptionsClosed') is True
            and report.get('coreSourceCommit') == CORE_COMMIT,
            'load-admission source/schema mismatch')
    require(all(report.get(field) is False for field in
                ('sourceFrontendVerified', 'applicationEngineVerified', 'vmCorrespondenceProven',
                 'deploymentPathVerified', 'implementationVerified', 'fullImplementationVerified')),
            'load-admission overclaimed frontend/runtime/deployment closure')
    require(identity(report.get('sourceProjectionSha256')) and identity(report.get('certificateSha256')),
            'load-admission missing/mixed projection or certificate identity')
    pinned = report.get('pinnedSource')
    require(isinstance(pinned, dict) and set(pinned) == set(LOAD_ADMISSION_SOURCES)
            and all(isinstance(row, dict) and isinstance(row.get('path'), str) and row['path']
                    and Path(row['path']).is_absolute()
                    and identity(row.get('sha256')) and isinstance(row.get('url'), str)
                    for row in pinned.values())
            and all(row['url'] == 'https://raw.githubusercontent.com/neo-project/neo/'
                        + LOAD_ADMISSION_SOURCES[key][0] + '/'
                        + LOAD_ADMISSION_SOURCES[key][1]
                    for key, row in pinned.items()),
            'load-admission missing/swapped pinned source')
    require(literal_equal(report.get('program'), LOAD_ADMISSION_PROGRAM),
            'load-admission changed the projected declaration record')
    require(report.get('reasonOnlyGuards') == ['exact-lookup-key-is-(name,arity)',
                                               'the-checksum-is-last-and-optional'],
            'load-admission changed the reason-only guard list')
    controls = report.get('semanticControls')
    require(isinstance(controls, list)
            and [row.get('name') for row in controls] == list(LOAD_ADMISSION_CONTROLS),
            'load-admission missing/reordered semantic controls')
    for row in controls:
        require(row.get('definitionsCompiled') is True and row.get('certificateRejected') is True
                and row.get('kernelCounterexampleChecked') is True
                and type(row.get('kernelExitCode')) is int and row['kernelExitCode'] > 0
                and not row.get('timedOut') and not row.get('timeout'),
                'load-admission invalid semantic control: ' + str(row.get('name')))
        require(all(identity(row.get(field)) for field in
                    ('sourceMutationSha256', 'projectionSha256', 'definitionsSha256',
                     'counterexampleSha256', 'rejectionLogSha256')),
                'load-admission missing semantic control identities: ' + str(row.get('name')))
    require(isinstance(report.get('controlProofSha256'), dict)
            and set(report['controlProofSha256']) == {name + '/' + filename
                for name in LOAD_ADMISSION_CONTROLS
                for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and isinstance(report.get('controlLogSha256'), dict)
            and set(report['controlLogSha256']) == {name + '/' + filename
                for name in LOAD_ADMISSION_CONTROLS
                for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                 'counterexample-coqchk.log')}
            and all(identity(value) for value in
                    list(report['controlProofSha256'].values()) + list(report['controlLogSha256'].values())),
            'load-admission incomplete/changed control file inventory')
    for field, values in LOAD_ADMISSION_DOMAIN.items():
        require(report.get(field) == values, 'load-admission omitted/changed ' + field)
    declarations = report.get('closedDeclarations')
    require(isinstance(declarations, dict)
            and set(declarations) == {'LoadAdmission', 'LoadAdmissionArtifact'}
            and all(isinstance(names, list) and names and len(set(names)) == len(names)
                    for names in declarations.values())
            and report.get('closedAssumptionCount') == sum(len(names) for names in declarations.values()),
            'load-admission declaration inventory mismatch')
    require(report.get('kernelDeclarations') == declarations['LoadAdmissionArtifact'],
            'load-admission certificate declaration inventory mismatch')
    return {'entryBoundary': report['entryBoundary'], 'projectedProgram': report['program'],
            'closedAssumptionCount': report['closedAssumptionCount'],
            'preconditions': report['preconditions'], 'tcb': report['tcb'],
            'unproved': report['unproved'], 'sourceFrontendVerified': False,
            'applicationEngineVerified': False, 'vmCorrespondenceProven': False}


def validate_load_admission_control_files(report, evidence_directory):
    root = Path(evidence_directory).resolve()
    files, logs = report.get('controlProofSha256'), report.get('controlLogSha256')
    require(isinstance(files, dict) and isinstance(logs, dict)
            and set(files) == {name + '/' + filename for name in LOAD_ADMISSION_CONTROLS
                               for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
            and set(logs) == {name + '/' + filename for name in LOAD_ADMISSION_CONTROLS
                              for filename in ('definitions.log', 'rejection.log', 'counterexample.log',
                                               'counterexample-coqchk.log')},
            'load-admission missing/extra control file identities')
    for name, expected in list(files.items()) + list(logs.items()):
        path = root/name
        require(root in path.resolve().parents and identity(expected)
                and sha(path.read_bytes()) == expected,
                'load-admission control proof byte mismatch: ' + name)
    rows = report.get('semanticControls')
    require(isinstance(rows, list)
            and [row.get('name') for row in rows] == list(LOAD_ADMISSION_CONTROLS),
            'load-admission control file row inventory mismatch')
    for row in rows:
        name = row['name']
        require(row.get('definitionsSha256') == files[name + '/Definitions.v']
                and row.get('counterexampleSha256') == files[name + '/Counterexample.v']
                and row.get('rejectionLogSha256') == logs[name + '/rejection.log'],
                'load-admission control row/file identity mismatch: ' + name)
    # Independently re-read the closure claims instead of trusting the receipt.
    for filename, module in (('model.log', 'LoadAdmission'),
                             ('certificate.log', 'LoadAdmissionArtifact')):
        text = (root/filename).read_text()
        require(text.count('Closed under the global context') == len(report['closedDeclarations'][module])
                and 'Axioms:' not in text,
                'load-admission ' + filename + ' did not close every declaration')


def source_identity_join(receipts):
    sources = {}

    def add(url, expected, lane):
        require(identity(expected) and isinstance(url, str) and any(
            url.startswith('https://raw.githubusercontent.com/neo-project/' + repo + '/' + commit + '/')
            for repo, commit in (('neo', CORE_COMMIT), ('neo-vm', VM_COMMIT))), lane + ' unpinned source identity')
        row = sources.setdefault(url, {'sha256': expected, 'lanes': []})
        require(row['sha256'] == expected, 'cross-lane pinned source hash mismatch')
        row['lanes'].append(lane)

    for lane, report in receipts.items():
        for row in report.get('pinnedSource', {}).values():
            if isinstance(row, dict) and 'url' in row: add(row['url'], row.get('sha256'), lane)
        if lane in {'runtime','runtime-collections'}:
            for name, expected in report.get('sourceSha256', {}).items():
                add('https://raw.githubusercontent.com/neo-project/neo-vm/' + VM_COMMIT + '/src/Neo.VM/' + name, expected, lane)
        if lane == 'gas' and report.get('sourceUrl'):
            add(report['sourceUrl'], report.get('sourceSha256'), lane)
        if lane == 'helper-gas':
            for name, expected in report.get('sourceHashes', {}).items():
                add('https://raw.githubusercontent.com/neo-project/neo/' + CORE_COMMIT + '/src/Neo/SmartContract/' + name, expected, lane)
    return sources


def receipt_file(path):
    raw = Path(path).read_bytes()
    return json.loads(raw), sha(raw)


def validate_runtime_projection(name, report, projection):
    require(projection.get('sourceCommit') == report.get('sourceCommit') == VM_COMMIT
            and projection.get('sourceSha256') == report.get('sourceSha256'), name + ' source projection identity mismatch')
    programs = projection.get('handlers' if name == 'runtime' else 'programs')
    require(isinstance(programs,dict) and programs, name + ' source program inventory missing')
    expected = sorted(programs)
    proven = sorted(set(programs)-set(COLLECTION_PARTIAL_SCOPES)) if name == 'runtime-collections' else expected
    require(report.get('supportedOpcodes') == expected and report.get('provenOpcodes') == proven,
            name + ' opcode claims differ from actual source projection')
    require(report.get('unproved') == projection.get('unsupported'), name + ' omitted source exclusions')


def validate_provenance(name, report, snapshot, evidence_directory):
    """Hash-join source/model maps and generated certificate bytes to fresh output."""
    copied = {item['copy']: item['sha256'] for item in snapshot.values()}
    originals = {path: item['sha256'] for path, item in snapshot.items()}
    stems = {}
    for path, value in copied.items():
        if Path(path).suffix == '.v': stems.setdefault(Path(path).stem, set()).add(value)
    model_map = report.get('modelSha256', {})
    for key, expected in model_map.items():
        require(identity(expected), name + ' malformed model hash')
        candidates = stems.get(Path(key).stem, set())
        require(expected in candidates, name + ' model not in captured snapshot: ' + key)
    for field in ('inputSha256', 'toolInputSha256', 'sourceInputSha256'):
        for path, expected in report.get(field, {}).items():
            require(identity(expected), name + ' malformed input hash')
            candidate = Path(path)
            if not candidate.is_absolute():
                require(candidate.parts and candidate.as_posix() == path and '..' not in candidate.parts,
                        name + ' undeclared relative input path')
                if candidate.parts[0] == 'external' and len(candidate.parts) == 2:
                    evidence = Path(evidence_directory).resolve()
                    search_paths = (evidence / candidate.name,
                                    evidence.parent / 'base' / candidate.name)
                    matches = [path for path in search_paths
                               if path.is_file() and sha(path.read_bytes()) == expected]
                elif candidate.name == path:
                    require(field == 'toolInputSha256', name + ' undeclared relative input path')
                    matches = [Path(item['copy']) for original,item in snapshot.items()
                               if Path(original).name == path and item['sha256'] == expected]
                else:
                    root = REPO.resolve()
                    original_path = root / candidate
                    require(root in original_path.resolve().parents, name + ' relative input escapes repository')
                    matches = [Path(item['copy']) for original,item in snapshot.items()
                               if Path(original) == original_path and item['sha256'] == expected]
                require(len(matches) == 1, name + ' relative tool/input identity missing/ambiguous')
                candidate = matches[0]
            require(candidate.is_absolute() and candidate.is_file() and sha(candidate.read_bytes()) == expected,
                    name + ' source/tool hash mismatch: ' + path)
            if path in copied or path in originals:
                require((copied.get(path) or originals.get(path)) == expected, name + ' mixed captured input')
    for row in report.get('pinnedSource', {}).values():
        if isinstance(row, dict) and 'path' in row:
            require(identity(row.get('sha256')) and sha(Path(row['path']).read_bytes()) == row['sha256'], name + ' pinned source file mismatch')
    certificate_raw = None
    if name in CERTIFICATES:
        field, filename = CERTIFICATES[name]
        expected = report.get(field)
        require(identity(expected), name + ' missing certificate identity')
        matches = []
        for path in Path(evidence_directory).rglob(filename):
            raw = path.read_bytes()
            if sha(raw) == expected: matches.append((path,raw))
        require(len(matches) == 1, name + ' generated certificate hash mismatch/ambiguous')
        certificate_raw = matches[0][1]
    for filename, expected in report.get('generatedProofSha256', {}).items():
        require(identity(expected) and Path(filename).name == filename, name + ' malformed generated proof identity')
        matches = [p for p in Path(evidence_directory).rglob(filename) if sha(p.read_bytes()) == expected]
        require(len(matches) == 1, name + ' generated proof byte mismatch')
    for module_name, expected in report.get('contextArtifactSha256', {}).items():
        require(identity(expected), 'context malformed artifact hash')
        matches = [p for p in Path(evidence_directory).rglob(module_name+'.v') if sha(p.read_bytes()) == expected]
        require(len(matches) == 1, 'context artifact byte mismatch')
    for row in report.get('runtimeReceiptJoins', []):
        require(identity(row.get('sha256')) and sha(Path(row['path']).read_bytes()) == row['sha256'], 'helper gas runtime receipt drift')
    native_kernel = report.get('nativeVectorKernel')
    if native_kernel:
        expected = native_kernel.get('certificateSha256')
        require(identity(expected) and sha((Path(evidence_directory) / 'NativeLedgerVectors.v').read_bytes()) == expected,
                'native vector certificate byte mismatch')
    typed_native = report.get('typedNativeSource')
    if typed_native:
        require(typed_native.get('sourceModelSha256') in stems.get('NativeCodecSource', set()), 'codec source model not in captured snapshot')
        for expected in [typed_native.get('certificateSha256'), typed_native.get('semanticControlBaseline', {}).get('certificateSha256')]:
            require(identity(expected), 'codec source artifact identity missing')
            require(any(sha(path.read_bytes()) == expected for path in Path(evidence_directory).rglob('*.v')), 'codec source artifact bytes mismatch')
    if name in {'runtime','runtime-collections'}:
        projection_raw = (Path(evidence_directory) / 'source-projection.json').read_bytes()
        require(sha(projection_raw) == report['sourceProjectionSha256'], 'runtime projection byte mismatch')
        validate_runtime_projection(name, report, json.loads(projection_raw))
        actual_declarations = re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:', certificate_raw.decode('utf-8'), re.MULTILINE)
        require(actual_declarations == report.get('kernelDeclarations'), name + ' certificate declaration inventory mismatch')
    if name == 'gas':
        require(sha((Path(evidence_directory) / 'source.cs').read_bytes()) == report.get('sourceSha256'), 'gas pinned source mismatch')
        projection = json.loads((Path(evidence_directory) / 'projection.json').read_bytes())
        require(projection.get('projectionSha256') == report['projectionSha256'], 'gas projection identity mismatch')
    if name == 'entry-dispatch':
        projection_raw = (Path(evidence_directory) / 'source-projection.json').read_bytes()
        require(sha(projection_raw) == report.get('sourceProjectionSha256'),
                'entry-dispatch source projection byte mismatch')
        projection = json.loads(projection_raw)
        require(all(projection.get(field) == values for field, values in ENTRY_DISPATCH_DOMAIN.items()),
                'entry-dispatch source projection changed domain')
        require(projection.get('entryBoundary') == 'CallContract-after-interop-admission-and-argument-conversion',
                'entry-dispatch source projection changed boundary')
        actual_declarations = re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',
                                         certificate_raw.decode('utf-8'), re.MULTILINE)
        require(actual_declarations and actual_declarations == report.get('kernelDeclarations'),
                'entry-dispatch certificate declaration inventory mismatch')
        require('actual_initializer_lookup' in actual_declarations,
                'entry-dispatch missing actual initializer lookup certificate')
        validate_entry_dispatch_control_files(report, evidence_directory)
    if name == 'syscall-dispatch':
        projection_raw = (Path(evidence_directory) / 'source-projection.json').read_bytes()
        require(sha(projection_raw) == report.get('sourceProjectionSha256'),
                'syscall-dispatch source projection byte mismatch')
        projection = json.loads(projection_raw)
        require(projection.get('scope') == SCOPES['syscall-dispatch']
                and projection.get('entryBoundary') == 'CallContractInternal-parameter-tuple'
                and literal_equal(projection.get('program'), SYSCALL_DISPATCH_PROGRAM)
                and projection.get('handlerParameters') == SYSCALL_DISPATCH_HANDLER_PARAMETERS
                and projection.get('tokenFields') == SYSCALL_DISPATCH_TOKEN_FIELDS
                and all(projection.get(field) == values
                        for field, values in SYSCALL_DISPATCH_DOMAIN.items()),
                'syscall-dispatch source projection changed domain')
        actual_declarations = re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',
                                         certificate_raw.decode('utf-8'), re.MULTILINE)
        require(actual_declarations and actual_declarations == report.get('kernelDeclarations'),
                'syscall-dispatch certificate declaration inventory mismatch')
        require('actual_interop_accepts' in actual_declarations
                and 'actual_token_accepts' in actual_declarations,
                'syscall-dispatch missing actual admission certificates')
        validate_syscall_dispatch_control_files(report, evidence_directory)
    if name == 'contract-handoff':
        projection_raw = (Path(evidence_directory) / 'source-projection.json').read_bytes()
        require(sha(projection_raw) == report.get('sourceProjectionSha256'),
                'contract-handoff source projection byte mismatch')
        projection = json.loads(projection_raw)
        require(projection.get('scope') == SCOPES['contract-handoff']
                and projection.get('entryBoundary') == 'LoadContract-returned-context-before-callee-execution'
                and literal_equal(projection.get('program'), CONTRACT_HANDOFF_PROGRAM)
                and projection.get('reasonOnlyGuards') == report.get('reasonOnlyGuards')
                and all(projection.get(field) == values
                        for field, values in CONTRACT_HANDOFF_DOMAIN.items()),
                'contract-handoff source projection changed domain')
        actual_declarations = re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',
                                         certificate_raw.decode('utf-8'), re.MULTILINE)
        require(actual_declarations and actual_declarations == report.get('kernelDeclarations'),
                'contract-handoff certificate declaration inventory mismatch')
        require('actual_accepts_when_the_guards_pass' in actual_declarations
                and 'actual_safe_mask_drops' in actual_declarations,
                'contract-handoff missing actual handoff certificates')
        validate_contract_handoff_control_files(report, evidence_directory)
    if name == 'interop-conversion':
        projection_raw = (Path(evidence_directory) / 'source-projection.json').read_bytes()
        require(sha(projection_raw) == report.get('sourceProjectionSha256'),
                'interop-conversion source projection byte mismatch')
        projection = json.loads(projection_raw)
        require(projection.get('scope') == SCOPES['interop-conversion']
                and projection.get('entryBoundary') == 'OnSysCall-argument-window-to-invoked-handler-parameters'
                and literal_equal(projection.get('program'), INTEROP_CONVERSION_PROGRAM)
                and projection.get('reasonOnlyGuards') == report.get('reasonOnlyGuards')
                and projection.get('parameters') == [list(row) for row in INTEROP_CONVERSION_ARGUMENTS]
                and all(projection.get(field) == values
                        for field, values in INTEROP_CONVERSION_DOMAIN.items()),
                'interop-conversion source projection changed domain')
        actual_declarations = re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',
                                         certificate_raw.decode('utf-8'), re.MULTILINE)
        require(actual_declarations and actual_declarations == report.get('kernelDeclarations'),
                'interop-conversion certificate declaration inventory mismatch')
        require('actual_max_length_is_2048' in actual_declarations
                and 'actual_rejects_a_null_counted_element' in actual_declarations,
                'interop-conversion missing actual conversion certificates')
        validate_interop_conversion_control_files(report, evidence_directory)
    if name == 'interop-fee-order':
        projection_raw = (Path(evidence_directory) / 'source-projection.json').read_bytes()
        require(sha(projection_raw) == report.get('sourceProjectionSha256'),
                'interop-fee-order source projection byte mismatch')
        projection = json.loads(projection_raw)
        require(projection.get('scope') == SCOPES['interop-fee-order']
                and projection.get('entryBoundary') == 'OnSysCall-descriptor-charge-to-argument-window-effect'
                and literal_equal(projection.get('program'), INTEROP_FEE_PROGRAM)
                and projection.get('reasonOnlyGuards') == report.get('reasonOnlyGuards')
                and all(projection.get(field) == values
                        for field, values in INTEROP_FEE_DOMAIN.items()),
                'interop-fee-order source projection changed domain')
        actual_declarations = re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',
                                         certificate_raw.decode('utf-8'), re.MULTILINE)
        require(actual_declarations and actual_declarations == report.get('kernelDeclarations'),
                'interop-fee-order certificate declaration inventory mismatch')
        require('actual_charge_skips_the_inner_factor' in actual_declarations
                and 'actual_a_rejected_call_charges_nothing' in actual_declarations,
                'interop-fee-order missing actual charge certificates')
        validate_interop_fee_control_files(report, evidence_directory)
    if name == 'exception-identity':
        projection_raw = (Path(evidence_directory) / 'source-projection.json').read_bytes()
        require(sha(projection_raw) == report.get('sourceProjectionSha256'),
                'exception-identity source projection byte mismatch')
        projection = json.loads(projection_raw)
        require(projection.get('scope') == SCOPES['exception-identity']
                and projection.get('entryBoundary')
                    == 'ExecuteNext-fault-surfacing-and-catch-admission-effect'
                and projection.get('vmCommit') == VM_COMMIT
                and projection.get('coreCommit') == CORE_COMMIT
                and literal_equal(projection.get('program'), EXCEPTION_IDENTITY_PROGRAM)
                and projection.get('reasonOnlyGuards') == report.get('reasonOnlyGuards')
                and all(projection.get(field) == values
                        for field, values in EXCEPTION_IDENTITY_DOMAIN.items()),
                'exception-identity source projection changed domain')
        actual_declarations = re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',
                                         certificate_raw.decode('utf-8'), re.MULTILINE)
        require(actual_declarations and actual_declarations == report.get('kernelDeclarations'),
                'exception-identity certificate declaration inventory mismatch')
        require('actual_the_caught_value_is_the_message' in actual_declarations
                and 'actual_an_uncatchable_exception_never_reaches_a_handler' in actual_declarations,
                'exception-identity missing actual surfacing certificates')
        validate_exception_identity_control_files(report, evidence_directory)
    if name == 'load-admission':
        projection_raw = (Path(evidence_directory) / 'source-projection.json').read_bytes()
        require(sha(projection_raw) == report.get('sourceProjectionSha256'),
                'load-admission source projection byte mismatch')
        projection = json.loads(projection_raw)
        require(projection.get('scope') == SCOPES['load-admission']
                and projection.get('entryBoundary')
                    == 'manifest-parse-and-nef-deserialize-admission-to-exact-arity-resolution'
                and projection.get('coreCommit') == CORE_COMMIT
                and literal_equal(projection.get('program'), LOAD_ADMISSION_PROGRAM)
                and projection.get('reasonOnlyGuards') == report.get('reasonOnlyGuards')
                and all(projection.get(field) == values
                        for field, values in LOAD_ADMISSION_DOMAIN.items()),
                'load-admission source projection changed domain')
        actual_declarations = re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',
                                         certificate_raw.decode('utf-8'), re.MULTILINE)
        require(actual_declarations and actual_declarations == report.get('kernelDeclarations'),
                'load-admission certificate declaration inventory mismatch')
        require('actual_the_exact_lookup_is_keyed_by_name_and_arity' in actual_declarations
                and 'actual_the_token_cap_is_inclusive' in actual_declarations,
                'load-admission missing actual admission certificates')
        validate_load_admission_control_files(report, evidence_directory)
    if name == 'storage-getters':
        validate_storage_getter_files(report, evidence_directory)


def validate_storage_getter_files(report, evidence_directory):
    """Hash-join every written module, model and control fixture to its bytes."""
    root = Path(evidence_directory).resolve()
    directory = Path(str(report.get('kernelDirectory', '')))
    require(directory.is_absolute() and directory.is_dir() and root in directory.resolve().parents,
            'storage getter kernel directory missing/outside its evidence directory')
    written = {}
    for path in directory.rglob('*'):
        if path.is_file():
            written.setdefault(sha(path.read_bytes()), []).append(path)
    declarations = report.get('closedDeclarations')
    require(isinstance(declarations, dict) and declarations, 'storage getter closed declarations missing')
    for module_name, names in declarations.items():
        require(isinstance(module_name, str) and module_name and Path(module_name).name == module_name
                and isinstance(names, list)
                and all(isinstance(entry, str) and entry for entry in names)
                and len(set(names)) == len(names), 'storage getter malformed closed declaration entry')
        path = directory/(module_name + '.v')
        require(path.is_file(), 'storage getter closed module missing: ' + module_name)
        actual = re.findall(r'^(?:Lemma|Theorem|Example)\s+(\w+)\s*:', path.read_text(), re.MULTILINE)
        require(actual == names, 'storage getter certificate declaration inventory mismatch: ' + module_name)
    for module_name, expected in report.get('modelSha256', {}).items():
        require(identity(expected) and expected in written
                and any(path.suffix == '.v' and path.stem == module_name for path in written[expected]),
                'storage getter model bytes missing from its kernel output')
    for field, label in (('semanticControls', 'source'), ('vmSemanticControls', 'bytecode')):
        rows = report.get(field)
        require(isinstance(rows, list) and rows, 'storage getter ' + label + ' controls missing')
        for row in rows:
            for key in ('definitionsSha256', 'assertionSha256', 'baselineSha256'):
                if key not in row: continue
                expected = row[key]
                require(identity(expected) and expected in written
                        and any(path.suffix == '.v' for path in written[expected]),
                        'storage getter ' + label + ' control bytes missing/ambiguous')


def validate_entry_dispatch_control_files(report, evidence_directory):
    root = Path(evidence_directory).resolve()
    expected_files = {name + '/' + filename for name in ENTRY_DISPATCH_CONTROLS
                      for filename in ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')}
    files = report.get('controlProofSha256')
    require(isinstance(files, dict) and set(files) == expected_files,
            'entry-dispatch missing/extra control proof files')
    for name, expected in files.items():
        path = root/name
        require(root in path.resolve().parents and identity(expected)
                and sha(path.read_bytes()) == expected,
                'entry-dispatch control proof byte mismatch')
    expected_logs = {name + '/' + filename for name in ENTRY_DISPATCH_CONTROLS
                     for filename in ('definitions.log', 'rejection.log', 'counterexample.log', 'counterexample-coqchk.log')}
    logs = report.get('controlLogSha256')
    require(isinstance(logs, dict) and set(logs) == expected_logs,
            'entry-dispatch missing/extra control log files')
    for name, expected in logs.items():
        path = root/name
        require(root in path.resolve().parents and identity(expected)
                and sha(path.read_bytes()) == expected,
                'entry-dispatch control log byte mismatch')
    rows = report.get('semanticControls')
    require(isinstance(rows, list) and len(rows) == len(ENTRY_DISPATCH_CONTROLS)
            and {row.get('name') for row in rows} == set(ENTRY_DISPATCH_CONTROLS),
            'entry-dispatch control file row inventory mismatch')
    for row in rows:
        name = row['name']
        require(row.get('definitionsSha256') == files[name+'/Definitions.v']
                and row.get('counterexampleSha256') == files[name+'/Counterexample.v']
                and identity(row.get('rejectionLogSha256'))
                and row['rejectionLogSha256'] == logs[name+'/rejection.log'],
                'entry-dispatch control row/file identity mismatch')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--timeout-seconds', type=int, default=1800, help='Positive per-subprocess time limit')
    parser.add_argument('--allow-partial', action='store_true', help='Exit zero for all selected scoped proofs; full status stays NO-GO')
    parser.add_argument('--native-vectors', type=Path, help='Optional supplied finite native vectors; does not rerun ApplicationEngine')
    parser.add_argument('--helper-gas-runtime-receipts', type=Path, default=Path('/tmp/sa-gas-runtime-evidence'),
                        help='Reviewed 5-shape runtime receipt directory (default local reviewed evidence path)')
    args = parser.parse_args(argv)
    output = None
    results = {}
    try:
        require(args.timeout_seconds > 0, 'timeout must be positive')
        require(args.helper_gas_runtime_receipts is not None, 'helper gas runtime receipts directory is required')
        output = prepare_output(args.output_dir)
        paths = tool_paths()
        snapshot = capture_files(paths, output/'snapshot', REPO)
        stage = output/'snapshot/formal/refinement'
        gate = load_module(stage/'verify.py', 'closure_verifier')
        project_before = gate.project_snapshot(REPO)
        native_sha = None
        native_path = None
        if args.native_vectors:
            native = capture_files([args.native_vectors], output/'native-input')
            snapshot.update(native)
            native_sha = next(iter(native.values()))['sha256']
            native_path = Path(next(iter(native.values()))['copy'])
        gas_runtime_paths = [args.helper_gas_runtime_receipts/('sa-gas-runtime-helper-'+shape+'.json')
                             for shape in ('absent','same','reset','exhausted','zero')]
        gas_runtime_dir = output/'helper-gas-runtime'
        gas_runtime_snapshot = capture_files(gas_runtime_paths, gas_runtime_dir, args.helper_gas_runtime_receipts.resolve())
        snapshot.update(gas_runtime_snapshot)
        snapshot.update(capture_files([REPO/'contracts/bin/v3/SmartAccountV3.nef',
                                       REPO/'contracts/bin/v3/SmartAccountV3.manifest.json'], output/'snapshot', REPO))
        (output/'snapshot.json').write_text(json.dumps(snapshot, indent=2)+'\n')
        base = output/'base'
        results['base'] = run_command([sys.executable, str(stage/'verify.py'), '--source-root', str(REPO),
                                      '--output-dir', str(base), '--timeout-seconds', str(args.timeout_seconds), '--allow-partial'],
                                     output/'base.log', args.timeout_seconds)
        require(results['base']['exitCode'] == 0 and not results['base']['timedOut'], 'fresh base verifier failed')
        inventory, inventory_sha = receipt_file(base/'inventory.json')
        gate.validate_inventory(inventory, REPO/'contracts/bin/v3/SmartAccountV3.nef',
                                REPO/'contracts/bin/v3/SmartAccountV3.manifest.json', REPO)
        receipts = {}
        raw_receipt_hashes = {}
        receipt_paths = {'arithmetic': base/'proof.json', **{name: base/(name+'-proof.json') for name in ('numeric','reservation','method')}}
        evidence_dirs = {'arithmetic': base/'proofs', **{name: base/(name+'-proofs') for name in ('numeric','reservation','method')}}
        for name, path in receipt_paths.items(): receipts[name], raw_receipt_hashes[name] = receipt_file(path)
        jobs = {}
        for name, filename in (('context','context_proofs.py'), ('initializer','initializer_proofs.py'),
                               ('composition','composition_proofs.py'), ('public','public_pure_proofs.py'),
                               ('runtime','runtime_bridge_proofs.py'), ('codec','codec_proofs.py'), ('gas','gas_proofs.py'),
                               ('hook','hook_params_proofs.py'), ('runtime-collections','runtime_collection_proofs.py'),
                               ('entry-dispatch','entry_dispatch_proofs.py'),
                               ('syscall-dispatch','syscall_dispatch_proofs.py'),
                               ('contract-handoff','contract_handoff_proofs.py'),
                               ('interop-conversion','interop_convert_proofs.py'),
                               ('interop-fee-order','interop_fee_proofs.py'),
                               ('exception-identity','exception_identity_proofs.py'),
                               ('load-admission','abi_admission_proofs.py'),
                               ('storage-getters','storage_getter_proofs.py')):
            work, report = output/name, output/(name+'-proof.json')
            command = [sys.executable, str(stage/filename), '--output-dir', str(work), '--json-report', str(report)]
            if name in {'context','initializer','public','hook','entry-dispatch','storage-getters'}:
                command += ['--inventory', str(base/'inventory.json')]
            if name in {'context','composition'}: command.append('--controls')
            if name == 'composition': command += ['--helper-proof-report', str(base/'method-proof.json')]
            if name == 'codec' and native_path: command += ['--native-vectors', str(native_path)]
            jobs[name] = (command, report, work)
            receipt_paths[name], evidence_dirs[name] = report, work
        helper_gas_report, helper_gas_work = output/'helper-gas-proof.json', output/'helper-gas'
        jobs['helper-gas'] = ([sys.executable,str(stage/'gas_trace_proofs.py'),'--runtime-receipts',str(gas_runtime_dir),
                             '--output-dir',str(helper_gas_work),'--json-report',str(helper_gas_report)],helper_gas_report,helper_gas_work)
        receipt_paths['helper-gas'], evidence_dirs['helper-gas'] = helper_gas_report, helper_gas_work
        reservation_controls = output/'reservation-controls.json'
        jobs['reservation-controls'] = ([sys.executable, str(stage/'reservation_proofs.py'), '--controls',
            '--output-dir', str(output/'reservation-controls'), '--json-report', str(reservation_controls)], reservation_controls, output/'reservation-controls')
        arithmetic_controls = output/'arithmetic-controls.json'
        # The original arithmetic runner exposes controls as an API, not a CLI.
        # Execute its captured module in an isolated child, retaining its logs.
        bootstrap = ('import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import prove;'
                     'r=prove.run_semantic_controls(Path(sys.argv[2]));'
                     'Path(sys.argv[3]).write_text(json.dumps(r,indent=2)+"\\n")')
        jobs['arithmetic-controls'] = ([sys.executable,'-c',bootstrap,str(stage),str(output/'arithmetic-controls'),str(arithmetic_controls)],
                                       arithmetic_controls, output/'arithmetic-controls')
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {pool.submit(run_command, command, output/(name+'.log'), args.timeout_seconds): name
                       for name, (command, _, _) in jobs.items()}
            for future in as_completed(futures):
                name = futures[future]
                try: results[name] = future.result()
                except Exception as error: results[name] = {'exitCode': None, 'timedOut': False, 'failure': str(error)}
                (output/'commands.json').write_text(json.dumps(results, indent=2)+'\n')
        require(all(r.get('exitCode') == 0 and not r.get('timedOut') for r in results.values()), 'one or more fresh proof/control subprocesses failed')
        for name in SCOPES:
            if name not in receipts: receipts[name], raw_receipt_hashes[name] = receipt_file(receipt_paths[name])
            validate_provenance(name, receipts[name], snapshot, evidence_dirs[name])
        receipts['arithmetic']['semanticControls'], raw_receipt_hashes['arithmetic-controls'] = receipt_file(arithmetic_controls)
        reservation_control_report, raw_receipt_hashes['reservation-controls'] = receipt_file(reservation_controls)
        require(reservation_control_report.get('scope') == SCOPES['reservation'], 'reservation controls scope mismatch')
        receipts['reservation']['semanticControls'] = reservation_control_report
        report = join_scopes(inventory, receipts, native_sha)
        projector = load_module(stage/'method_source.py', 'closure_method_projector')
        source_projection = projector.project_method(inventory)
        require(source_projection['sourceProjectionSha256'] == receipts['method']['sourceProjectionSha256'], 'helper source projection mismatch')
        helper_runner = load_module(stage/'method_proofs.py', 'closure_helper_binding')
        helper_bound = helper_runner.bind_method(inventory)
        require_bound_artifact(helper_bound, inventory, 'helper')
        require(helper_runner.digest(helper_runner.render_certificate(helper_bound, source_projection).encode())
                == receipts['method']['certificateSha256'], 'helper generated certificate/data mismatch')
        context_runner = load_module(stage/'context_proofs.py', 'closure_context_binding')
        initializer_bound = context_runner.bind_initializer(inventory)
        require(sha(context_runner.render_certificate(initializer_bound).encode()) == receipts['context']['certificateSha256'], 'context generated certificate/data mismatch')
        context_artifacts = {'CapContextIsolatedArtifact': context_runner.render_isolated_certificate(helper_bound),
                             'CapContextHelperArtifact': context_runner.render_context_certificate(helper_bound)
                                 + context_runner.COUNTER_DEFINITIONS + context_runner.COUNTER_PROOF}
        require({name:sha(text.encode()) for name,text in context_artifacts.items()} == receipts['context'].get('contextArtifactSha256'),
                'complete context helper generated certificate/data mismatch')
        initializer_source = load_module(stage/'initializer_source.py', 'closure_initializer_projector')
        require(initializer_source.project_source(inventory) == receipts['initializer']['sourceProjection'], 'initializer typed source projection mismatch')
        initializer_runner = load_module(stage/'initializer_proofs.py', 'closure_initializer_binding')
        require(sha(initializer_runner.render(initializer_runner.bind(inventory)).encode()) == receipts['initializer']['certificateSha256'], 'initializer generated certificate/data mismatch')
        public_source = load_module(stage/'public_source.py', 'closure_public_projector')
        pure_projection = public_source.project_methods(inventory)
        require(set(pure_projection) == set(receipts['public']['methods']) and all(
            receipts['public']['methods'][name]['source'] == value for name, value in pure_projection.items()), 'public typed source projection mismatch')
        require(public_source.projection_hash(pure_projection) == receipts['public']['sourceProjectionSha256'], 'public source projection hash mismatch')
        public_runner = load_module(stage/'public_pure_proofs.py', 'closure_public_binding')
        public_bound = public_runner.bind_methods(inventory)
        require(public_bound['methods'] == receipts['public']['methods'], 'public complete method binding mismatch')
        require(sha(public_runner.render_certificate(public_bound).encode()) == receipts['public']['certificateSha256'], 'public generated certificate/data mismatch')
        dispatch = receipts['entry-dispatch']
        require(dispatch.get('inventorySha256') == inventory_sha,
                'entry-dispatch fresh inventory identity mismatch')
        dispatch_runner = load_module(stage/'entry_dispatch_proofs.py', 'closure_entry_dispatch_binding')
        regenerated = dispatch_runner.regenerate_certificate(inventory, dispatch, evidence_dirs['entry-dispatch'])
        require(isinstance(regenerated, bytes) and sha(regenerated) == dispatch['certificateSha256'],
                'entry-dispatch regenerated certificate/data mismatch')
        require(dispatch_runner.regenerate_controls(dispatch, evidence_dirs['entry-dispatch'])
                == dispatch.get('controlProofSha256'),
                'entry-dispatch regenerated control inventory mismatch')
        syscall = receipts['syscall-dispatch']
        syscall_runner = load_module(stage/'syscall_dispatch_proofs.py', 'closure_syscall_dispatch_binding')
        require(sha(syscall_runner.regenerate_certificate(syscall, evidence_dirs['syscall-dispatch']))
                == syscall['certificateSha256'], 'syscall-dispatch regenerated certificate/data mismatch')
        require(syscall_runner.regenerate_controls(syscall, evidence_dirs['syscall-dispatch'])
                == syscall.get('controlProofSha256'),
                'syscall-dispatch regenerated control inventory mismatch')
        handoff = receipts['contract-handoff']
        handoff_runner = load_module(stage/'contract_handoff_proofs.py',
                                     'closure_contract_handoff_binding')
        require(sha(handoff_runner.regenerate_certificate(handoff, evidence_dirs['contract-handoff']))
                == handoff['certificateSha256'], 'contract-handoff regenerated certificate/data mismatch')
        require(handoff_runner.regenerate_controls(handoff, evidence_dirs['contract-handoff'])
                == handoff.get('controlProofSha256'),
                'contract-handoff regenerated control inventory mismatch')
        conversion = receipts['interop-conversion']
        conversion_runner = load_module(stage/'interop_convert_proofs.py',
                                        'closure_interop_conversion_binding')
        require(sha(conversion_runner.regenerate_certificate(conversion,
                                                             evidence_dirs['interop-conversion']))
                == conversion['certificateSha256'],
                'interop-conversion regenerated certificate/data mismatch')
        require(conversion_runner.regenerate_controls(conversion,
                                                      evidence_dirs['interop-conversion'])
                == conversion.get('controlProofSha256'),
                'interop-conversion regenerated control inventory mismatch')
        fee = receipts['interop-fee-order']
        fee_runner = load_module(stage/'interop_fee_proofs.py',
                                 'closure_interop_fee_binding')
        require(sha(fee_runner.regenerate_certificate(fee, evidence_dirs['interop-fee-order']))
                == fee['certificateSha256'],
                'interop-fee-order regenerated certificate/data mismatch')
        require(fee_runner.regenerate_controls(fee, evidence_dirs['interop-fee-order'])
                == fee.get('controlProofSha256'),
                'interop-fee-order regenerated control inventory mismatch')
        identity_lane = receipts['exception-identity']
        identity_runner = load_module(stage/'exception_identity_proofs.py',
                                      'closure_exception_identity_binding')
        require(sha(identity_runner.regenerate_certificate(
                        identity_lane, evidence_dirs['exception-identity']))
                == identity_lane['certificateSha256'],
                'exception-identity regenerated certificate/data mismatch')
        require(identity_runner.regenerate_controls(
                    identity_lane, evidence_dirs['exception-identity'])
                == identity_lane.get('controlProofSha256'),
                'exception-identity regenerated control inventory mismatch')
        admission_lane = receipts['load-admission']
        admission_runner = load_module(stage/'abi_admission_proofs.py',
                                       'closure_load_admission_binding')
        require(sha(admission_runner.regenerate_certificate(
                        admission_lane, evidence_dirs['load-admission']))
                == admission_lane['certificateSha256'],
                'load-admission regenerated certificate/data mismatch')
        require(admission_runner.regenerate_controls(
                    admission_lane, evidence_dirs['load-admission'])
                == admission_lane.get('controlProofSha256'),
                'load-admission regenerated control inventory mismatch')
        hook_source = load_module(stage/'hook_params_source.py', 'closure_hook_projector')
        hook_projection = hook_source.project_method(inventory)
        require(hook_projection == receipts['hook']['sourceProjection'], 'private hook typed source projection mismatch')
        hook_runner = load_module(stage/'hook_params_proofs.py', 'closure_hook_binding')
        hook_bound = hook_runner.bind_method(inventory)
        require(hook_bound['methodSha256'] == receipts['hook']['methodSha256']
                and [hook_bound['start'],hook_bound['end']] == receipts['hook']['methodRange']
                and hook_bound['instructionCount'] == receipts['hook']['instructionCount'], 'private hook complete method binding mismatch')
        require(sha(hook_runner.render_certificate(hook_bound).encode()) == receipts['hook']['certificateSha256'],
                'private hook generated certificate/data mismatch')
        getter_receipt = receipts['storage-getters']
        require(getter_receipt.get('inventorySha256') == inventory_sha,
                'storage getter fresh inventory identity mismatch')
        getter_runner = load_module(stage/'storage_getter_proofs.py', 'closure_storage_getter_binding')
        getter_source = getter_runner.getter_source
        getter_projection = getter_source.project(inventory)
        getter_callees = getter_source.project_callee(inventory)
        require(getter_source.projection_hash(getter_projection) == getter_receipt['projectionSha256'],
                'storage getter source projection hash mismatch')
        getter_bound = getter_runner.bind_entries(inventory, getter_projection, getter_callees)
        require(getter_bound['methods'] == getter_receipt['methods'],
                'storage getter decoded region binding mismatch')
        require([row['name'] for row in getter_receipt['sharedCallees']] == list(STORAGE_GETTER_SHARED_CALLEES)
                and all(getter_bound['callees'][row['name']]['start'] == row['regions'][0]
                        and getter_bound['callees'][row['name']]['endExclusive'] == row['regions'][1]
                        and sorted(key for key, value in getter_runner.CALLEE_KINDS.items()
                                   if value == row['name']) == row['projectionKinds']
                        for row in getter_receipt['sharedCallees']),
                'storage getter shared callee region binding mismatch')
        require_bound_artifact(getter_bound, inventory, 'storage getter')
        getter_rows = getter_runner.nef_decode.decode_script(bytes.fromhex(inventory['nef']['scriptHex']),
                                                            len(inventory['nef']['tokens']))
        getter_certificate = getter_runner.render_certificate(getter_bound) + ''.join(
            text for _, text in getter_runner.render_vm_certificate(getter_bound, getter_rows))
        require(sha(getter_certificate.encode()) == getter_receipt['certificateSha256'],
                'storage getter regenerated certificate/data mismatch')
        # The correspondence receipt is evidence about the front end itself:
        # the corpus is exactly the pinned C# the lanes downloaded, and the
        # shared table is read out of the captured modules rather than copied.
        # A disagreement fails the gate; agreement does not claim a proof.
        correspondence = load_module(stage/'frontend_correspondence.py',
                                     'closure_frontend_correspondence')
        corpus_roots = sorted(str(path) for path in output.glob('*/source')
                              if path.is_dir())
        require(corpus_roots, 'no pinned C# corpus left behind by any lane')
        # The C# lexer itself is the authority the front end is measured against,
        # and the exporter already carries Roslyn, so no new tool is introduced.
        lexer_dump = output/'lexer-tokens.json'
        lexer_result = run_command(
            ['dotnet', str(stage/'export/bin/Debug/net10.0/RefinementExport.dll'),
             '--token-dump', str(lexer_dump)],
            output/'lexer-tokens.log', args.timeout_seconds)
        require(lexer_result['exitCode'] == 0 and not lexer_result['timedOut'],
                'C# lexer token dump failed')
        results['lexer-tokens'] = lexer_result
        frontend_receipt = correspondence.correspond(stage, corpus_roots,
                                                     lexer_dump=lexer_dump)
        require(correspondence.agrees(frontend_receipt),
                'source frontend correspondence mismatch: '
                + json.dumps(frontend_receipt['problems'][:3]
                             or frontend_receipt['selfTest']['failed'])[:400])
        require(frontend_receipt['faces']['lexer']['available']
                and frontend_receipt['faces']['lexer']['filesCompared'] > 0,
                'C# lexer comparison is missing rather than passing')
        require(frontend_receipt['corpus']['tokens'] > 0
                and frontend_receipt['faces']['bodies']['methods'] > 0,
                'source frontend correspondence corpus is empty')
        # The anchor face has a ten-character floor, and a field is read with
        # whatever literal the projection code uses — often shorter. A needle
        # face that finds no needle would agree with itself forever, so it has
        # to report what it looked at, not only that it found nothing wrong.
        needles_face = frontend_receipt['faces']['needles']
        require(needles_face['candidates'] > 0
                and needles_face['readable'] > 0
                and needles_face['shortOfAnchorThreshold'] > 0,
                'the needle face is empty rather than agreeing: '
                + json.dumps(needles_face, sort_keys=True)[:300])
        # The lexer face above says the front end may differ on a whole file. That
        # is only safe to record if a reader the compiler confirms stands beside
        # it, so the strict reader has to reproduce the lexer on every file
        # before its disagreement with the front end means anything.
        strict_face = frontend_receipt['faces']['strict']
        require(strict_face['available'] and strict_face['filesCompared'] > 0,
                'no confirmed reader to judge the front end with')
        require(strict_face['filesIdentical'] == strict_face['filesCompared'],
                'the independent reader does not reproduce the C# lexer on %d file(s): %s'
                % (strict_face['filesCompared'] - strict_face['filesIdentical'],
                   json.dumps(strict_face['fileDivergences'][:3])[:400]))
        require(frontend_receipt['knownGaps']['anchorsAffectedUnique'] == 0,
                'a uniquely located anchor moved under the compiler reading: '
                + json.dumps(frontend_receipt['knownGaps']['affectedAnchors'][:3])[:300])
        # A divergence that lands in a file some lane takes a whole method body
        # out of is not a footnote: the body is what the fields are read from.
        # Every remaining gap has to be in text no body slicer touches, and that
        # is recomputed from the modules rather than remembered.
        require(not frontend_receipt['knownGaps']['slicedGaps'],
                'a front-end divergence lands in a file a lane slices bodies from: '
                + json.dumps([row for row in frontend_receipt['knownGaps']['rows']
                              if row['slicedBy']])[:400])
        require(frontend_receipt['knownGaps']['files'] == list(KNOWN_FRONT_END_GAPS),
                'front-end known-gap set changed to %r; a new gap is a defect, and a '
                'closed one is recorded by editing KNOWN_FRONT_END_GAPS on purpose'
                % (frontend_receipt['knownGaps']['files'],))
        # The other leg of the same trust item. Everything above measures text:
        # two readers, and Microsoft's lexer, agreeing about the pinned C#. This
        # measures the artifact — a real ApplicationEngine deploys the pinned NEF
        # and calls every ABI method by name, and the receipt says which offset
        # the engine entered for each one.
        dispatch = load_module(stage/'abi_dispatch.py', 'closure_abi_dispatch')
        dispatch_dump = output/'abi-dispatch.json'
        dispatch_result = run_command(
            ['dotnet', str(stage/'export/bin/Debug/net10.0/RefinementExport.dll'),
             '--abi-dispatch', str(dispatch_dump),
             '--nef', str(REPO/'contracts/bin/v3/SmartAccountV3.nef'),
             '--manifest', str(REPO/'contracts/bin/v3/SmartAccountV3.manifest.json')],
            output/'abi-dispatch.log', args.timeout_seconds)
        require(dispatch_result['exitCode'] == 0 and not dispatch_result['timedOut'],
                'ABI dispatch dump failed')
        results['abi-dispatch'] = dispatch_result
        abi_receipt = dispatch.correspond(dispatch_dump,
                                          REPO/'contracts/bin/v3/SmartAccountV3.manifest.json',
                                          REPO/'contracts/bin/v3/SmartAccountV3.nef')
        require(dispatch.agrees(abi_receipt),
                'actual ApplicationEngine ABI dispatch mismatch: '
                + json.dumps(abi_receipt['problems'][:3]
                             or abi_receipt['selfTest']['failed'])[:400])
        require(abi_receipt['stats']['declared'] == len(inventory['manifest']['methods']),
                'ABI dispatch measured %d methods against a manifest with %d'
                % (abi_receipt['stats']['declared'], len(inventory['manifest']['methods'])))
        require(abi_receipt['stats']['dispatched'] > 0
                and abi_receipt['stats']['methods'] == abi_receipt['stats']['declared'],
                'ABI dispatch measured nothing: ' + json.dumps(abi_receipt['stats'])[:300])
        # The fifth question about the same dump, and the first one about values: a
        # call that lands on the declared offset and hands back the wrong shape is a
        # manifest the artifact does not honour, and every dispatch counter is blind
        # to it. The face has to have applied that rule to every completed call —
        # a receipt that quietly skipped them would report the same zero problems.
        require(abi_receipt['stats']['returnsChecked'] > 0
                and abi_receipt['stats']['returnsChecked'] == abi_receipt['stats']['halted']
                and abi_receipt['stats']['returnsMatch'] == abi_receipt['stats']['returnsChecked'],
                'the returned value shape was not checked for every completed call: '
                + json.dumps({key: abi_receipt['stats'][key] for key in
                              ('halted', 'returnsChecked', 'returnsMatch', 'resultCountMismatch',
                               'resultTypeMismatch', 'resultBytesMismatch', 'faultsWithResult')})[:300])
        entries = load_module(stage/'entrypoint_inventory.py', 'closure_entries')
        entry_report = entries.build_entrypoint_inventory(inventory)
        (output/'entrypoint-inventory.json').write_text(json.dumps(entry_report, indent=2)+'\n')
        require(entry_report['fullUnprovedCount'] == report['fullUnprovedCount'], 'entrypoint full-scope accounting mismatch')
        # The dispatch face above says the engine entered the offset the manifest
        # declares. That is a fact about a dispatcher: everything the body then ran
        # is unexamined by it. This joins the executed instruction offsets back to
        # the project's own static byte-dependency closures, so "reachable" and
        # "ran" are confronted instead of asserted. Containment is the direction
        # that has to hold; the may-set direction is counted, never required.
        footprint = load_module(stage/'dispatch_footprint.py', 'closure_dispatch_footprint')
        footprint_receipt = footprint.correspond(
            dispatch_dump, output/'entrypoint-inventory.json', len(inventory['nef']['tokens']))
        require(footprint.agrees(footprint_receipt),
                'the engine executed bytes the static graph does not reach: '
                + json.dumps(footprint_receipt['problems'][:3]
                             or footprint_receipt['selfTest']['failed']
                             or footprint_receipt['selfTest']['skipped'])[:400])
        require(footprint_receipt['stats']['entrypoints'] == len(inventory['manifest']['methods']),
                'footprint compared against %d entrypoints, the manifest declares %d'
                % (footprint_receipt['stats']['entrypoints'], len(inventory['manifest']['methods'])))
        require(footprint_receipt['stats']['methodsCompared'] + footprint_receipt['stats']['reservedSkipped']
                == footprint_receipt['stats']['entrypoints'],
                'footprint accounted for %d compared plus %d reserved of %d entrypoints'
                % (footprint_receipt['stats']['methodsCompared'],
                   footprint_receipt['stats']['reservedSkipped'],
                   footprint_receipt['stats']['entrypoints']))
        # Non-vacuity: a face that compared nothing, or found nothing inside a
        # closure, would report the same zero problems as a sound model.
        require(footprint_receipt['stats']['methodsCompared'] > 0
                and footprint_receipt['stats']['insideClosure'] > 0
                and footprint_receipt['stats']['distinctExecuted'] > 0
                and footprint_receipt['stats']['initializerEntered'] > 0,
                'the footprint face looked at nothing: '
                + json.dumps(footprint_receipt['stats'])[:300])
        # The layer under the dispatch, and the layer under the footprint. The two
        # faces above ask what the engine did with arity-matched zeros: where it
        # entered, and which bytes it ran. Neither asks what a method does when it
        # is given values, so a body that refuses every zero argument is measured
        # as faithfully as one that works. This drives the same engine through a
        # reviewed sequence of calls with literal arguments over state built by
        # earlier steps in the same sequence.
        scenario_face = load_module(stage/'abi_scenario.py', 'closure_abi_scenario')
        # Four reviewed sequences, and they answer different halves of one question.
        # The first builds an account, registers it, writes through it and reads back,
        # all at one block time. The second drives the timelocks: every one of them is
        # a comparison against `Runtime.Time`, so a harness frozen at a single instant
        # can show only that a call before a window refuses, never that the same call
        # at the window succeeds. The third deploys real plugin contracts and calls
        # into them, because a verifier body cannot run without a verifier and the
        # admission check reads a deployed manifest rather than a source file - so
        # that part of the surface is only reachable with artifacts beside the account.
        # The fourth deploys callers rather than plugins, because the platform-registrar
        # channel and the market escrow both assert that their caller is a contract and
        # refuse every call that a step could make directly.
        # All four have to agree, and none stands in for another - which is why the
        # union at the end is taken over every face that ran.
        scenario_runs = (
            ('abiScenario', 'sa-account-roundtrip.json', 'abi-scenario.json'),
            ('abiScenarioWindows', 'sa-account-windows.json', 'abi-scenario-windows.json'),
            ('abiScenarioPlugins', 'sa-account-plugins.json', 'abi-scenario-plugins.json'),
            ('abiScenarioRegistrar', 'sa-account-registrar.json', 'abi-scenario-registrar.json'),
        )
        scenario_receipts = {}
        for scenario_key, scenario_file, dump_name in scenario_runs:
            scenario_path = stage/'scenarios'/scenario_file
            scenario_dump = output/dump_name
            scenario_result = run_command(
                ['dotnet', str(stage/'export/bin/Debug/net10.0/RefinementExport.dll'),
                 '--abi-scenario', str(scenario_dump),
                 '--scenario', str(scenario_path),
                 '--nef', str(REPO/'contracts/bin/v3/SmartAccountV3.nef'),
                 '--manifest', str(REPO/'contracts/bin/v3/SmartAccountV3.manifest.json')],
                output/(dump_name[:-len('.json')] + '.log'), args.timeout_seconds)
            require(scenario_result['exitCode'] == 0 and not scenario_result['timedOut'],
                    'ABI scenario dump failed: ' + scenario_file)
            results[dump_name[:-len('.json')]] = scenario_result
            receipt = scenario_face.correspond(
                scenario_path, scenario_dump,
                REPO/'contracts/bin/v3/SmartAccountV3.manifest.json',
                REPO/'contracts/bin/v3/SmartAccountV3.nef')
            require(scenario_face.agrees(receipt),
                    'the engine did not do what ' + scenario_file + ' declares: '
                    + json.dumps(receipt['problems'][:3]
                                 or receipt['selfTest']['failed']
                                 or receipt['selfTest']['skipped'])[:400])
            # Non-vacuity, in the shape this face can be vacuous: a scenario that
            # calls one method, or that never reads anything back, would report the
            # same zero problems while proving nothing about values.
            require(receipt['stats']['halted'] > 0
                    and receipt['stats']['faulted'] > 0
                    and receipt['stats']['distinctMethods'] > 1
                    and receipt['stats']['linksChecked'] > 0
                    and receipt['stats']['declaredReturnChecked'] == receipt['stats']['halted'],
                    'the scenario face looked at nothing: '
                    + scenario_file + ' ' + json.dumps(receipt['stats'])[:400])
            # A scenario that declares several block times has declared a dimension.
            # If no call's ending depends on which time it ran at, that dimension was
            # declared and not measured, and the receipt says so instead of passing.
            require(receipt['stats']['distinctTimestamps'] == 1
                    or receipt['stats']['timeSensitivePairs'] > 0,
                    'block times declared and no call whose ending depends on one: '
                    + scenario_file + ' ' + json.dumps(
                        {'distinctTimestamps': receipt['stats']['distinctTimestamps'],
                         'timeSensitivePairs': receipt['stats']['timeSensitivePairs']}))
            scenario_receipts[scenario_key] = receipt
            # A scenario that declares plugin artifacts has made a claim about which
            # bytes were deployed. A face that compared nothing there would report the
            # same zero problems, so the claim has to come with a measurement: every
            # declared plugin deployed at the declared address, from the declared file,
            # by the declared signer, and at least one step actually landed on one.
            declared_plugins = receipt['stats']['modulesDeclared']
            if declared_plugins:
                require(receipt['stats']['modulesDeployed'] == declared_plugins
                        and receipt['stats']['moduleAddressMatched'] == declared_plugins
                        and receipt['stats']['moduleArtifactMatched']
                        == receipt['stats']['moduleArtifactChecked']
                        and receipt['stats']['moduleArtifactChecked'] == 2 * declared_plugins
                        and receipt['stats']['moduleSignerMatched'] == declared_plugins
                        and receipt['stats']['moduleSteps'] > 0
                        and receipt['stats']['distinctTargets'] > 1,
                        'a scenario declared plugins and measured nothing about them: '
                        + scenario_file + ' ' + json.dumps(receipt['stats'])[:400])
                # The artifacts themselves are pinned inputs, not something this run
                # rebuilds: the recorded provenance is what says which compiler turned
                # which sources into them. Their paths are read the same way the
                # exporter and the face read them - relative to the scenario file's own
                # directory - because a relative path means nothing without the
                # directory it is relative to, and that directory is the scenario's.
                for plugin in receipt['modules']:
                    for kind, sha_key in (('nef', 'nefSha256'), ('manifest', 'manifestSha256')):
                        artifact = (scenario_path.parent / plugin[kind]).resolve()
                        require(artifact.is_file(),
                                'the plugin artifact the receipt names is not in the snapshot: '
                                + str(artifact))
                        require(hashlib.sha256(artifact.read_bytes()).hexdigest()
                                == plugin[sha_key],
                                'the plugin bytes on disk are not the ones the receipt names: '
                                + str(artifact))
        # The fifth question has now been asked five times, of five different call
        # sets, and the answers have to join: every return type the manifest declares
        # is described by what one of them observed. Before the scenarios existed the
        # set was short by exactly the types whose declaring methods fault on zeros -
        # `Any` and `Array` - and a union is the only way to see that they are now
        # covered rather than merely counted. No single scenario covers all eight: the
        # roundtrip answers without a fault for `Array`, the windows scenario answers
        # without one for `Any`, and each is short of what the others have.
        declared_returns = (set(abi_receipt['stats']['declaredTypesExercised'])
                            | set(abi_receipt['stats']['declaredTypesUnexercised']))
        measured_returns = set(abi_receipt['stats']['declaredTypesExercised'])
        for receipt in scenario_receipts.values():
            measured_returns |= set(receipt['stats']['declaredTypesExercised'])
        require(declared_returns <= measured_returns,
                'return types the manifest declares and no measured call produced: '
                + json.dumps(sorted(declared_returns - measured_returns)))
        gate.validate_inventory(inventory, REPO/'contracts/bin/v3/SmartAccountV3.nef',
                                REPO/'contracts/bin/v3/SmartAccountV3.manifest.json', REPO)
        require(gate.project_snapshot(REPO) == project_before, 'compilation input membership drift')
        require(tool_paths() == paths, 'tool/model input membership drift')
        require(sha((base/'inventory.json').read_bytes()) == inventory_sha, 'fresh inventory drift')
        check_snapshot(snapshot)
        all_receipt_paths = {**receipt_paths, 'arithmetic-controls': arithmetic_controls, 'reservation-controls': reservation_controls}
        require(all(sha(path.read_bytes()) == raw_receipt_hashes[name] for name,path in all_receipt_paths.items()), 'fresh receipt drift')
        report.update(frontendCorrespondence=frontend_receipt,
                      abiDispatch=abi_receipt,
                      dispatchFootprint=footprint_receipt,
                      inventorySha256=inventory_sha, inputSha256=inventory['inputs'], toolSnapshot=snapshot,
                      projectInputSha256=project_before, commands=results,
                      rawReceiptSha256=raw_receipt_hashes,
                      maximumConcurrentLanes=2, publicNetworkWritesPerformed=False,
                      evidenceScope='Fresh host compiler inventory and scoped reference proofs; full implementation remains unverified',
                      **scenario_receipts)
        (output/'result.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps({key:report[key] for key in ('status','selectedScopeStatus','fullUnprovedCount')}))
        return 0 if args.allow_partial else 2
    except Exception as error:
        if output is not None:
            (output/'result.json').write_text(json.dumps({'schema':'neoos-sa-integrated-closure/v1', 'status':'FAIL',
                'selectedScopeStatus':'FAIL', 'implementationVerified':False, 'fullImplementationVerified':False,
                'verifiedEntrypoints':[], 'commands':results, 'failure':type(error).__name__+': '+str(error)}, indent=2)+'\n')
        print(str(error), file=sys.stderr)
        return 1


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(Path(path).parent))
    try: spec.loader.exec_module(result)
    finally: sys.path.pop(0)
    return result


if __name__ == '__main__': raise SystemExit(main())
