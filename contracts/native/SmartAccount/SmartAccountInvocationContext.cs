// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountInvocationContext.cs file belongs to the neo project and is free software distributed under the MIT
// software license, see the accompanying file LICENSE in the main directory of the repository or
// http://www.opensource.org/licenses/mit-license.php for more details.
//
// Redistribution and use in source and binary forms with or without modifications are permitted.

// TRUE SOURCE: this is the only editable copy of this SmartAccount native
// contract file. The neo-native-core checkout carries a generated copy —
// regenerate it via scripts/sync_native_smartaccount.py.

using System;
using System.Collections.Generic;
using System.Numerics;

namespace Neo.SmartContract.Native
{
    /// <summary> Writer phases of the v4 execution state machine (spec §7.1/§9). A module callback is authorized only
    /// while the recorded phase is the one that callback belongs to, for the exact active module instance. </summary>
    internal enum SmartAccountCallbackPhase : byte
    {
        None = 0,
        Validation = 1,
        HookPre = 2,
        TargetDispatch = 3,
        HookPost = 4,
        Completion = 5,
        Configuration = 6,
        MemberValidation = 8,
        HookPlanning = 9,
    }

    /// <summary>Engine-local state of the native core while an entry of one account is in progress: the entered account,
    /// the module callback and the target dispatch in progress, the composite validation in progress and the post-reset
    /// initialization credential. Every grant lives exactly as long as the native call that opened it: that call restores
    /// the previous state in its own finally block, and a FAULT ends the engine, so nothing is revoked or carried over.
    /// </summary>
    internal sealed class SmartAccountInvocationContext
    {
        // ---- 1. The entered account: the re-entrancy lock, and the proxy IsAccountProxyActive answers for ----
        private UInt160? _account;
        private UInt160 _accountAddress = UInt160.Zero;

        // ---- 2. The module callback in progress, authorized for its own caller frame only ----
        private ExecutionContextState? _callbackAnchor;
        private UInt160 _callbackContract = UInt160.Zero;
        private BigInteger _callbackModuleId = BigInteger.Zero;
        private SmartAccountCallbackPhase _callbackPhase = SmartAccountCallbackPhase.None;

        // ---- 3. The target dispatch in progress: its frame is the only one that may act as the account ----
        private ExecutionContextState? _targetAnchor;

        // ---- 4. The composite validation in progress: written by the validation pass, read by validateMember ----
        internal OperationValidation? Validation;

        /// <summary> The operation of record of one validation pass and the members its routed composite has approved. </summary>
        internal sealed class OperationValidation(BigInteger validatorId, BigInteger credentialGeneration,
            ReadOnlyMemory<byte> signedBytes, ReadOnlyMemory<byte> digest)
        {
            internal readonly BigInteger ValidatorId = validatorId;
            internal readonly BigInteger CredentialGeneration = credentialGeneration;
            internal readonly byte[] SignedBytes = signedBytes.ToArray();
            internal readonly byte[] Digest = digest.ToArray();
            internal readonly HashSet<BigInteger> ValidatedMembers = new();
            internal readonly List<BigInteger> ApprovedIds = new();
            internal readonly List<ModuleInstance> ApprovedModules = new();
        }

        // ---- 5. v4.1 restricted post-reset initialization (spec §12): the reset landing alone removes every instance, so the
        // same recovery seat must be able to land one install-only composition in the same transaction. The initialization is
        // engine-local and single-use: it is bound to the seat that reset, the account and the post-reset authority epoch, and
        // it is only reachable through applyConfigurationActions. Excluding custody, plain-validator, configure and uninstall
        // actions is enforced at the entry, not at the module callback.
        // One record serves both the claim and the end-of-execution check, so no second state exists: the row of an account
        // stays for the whole engine, and a landing only consumes the claim by clearing its epoch. The row therefore says
        // "this engine reset the account" even after the landing, which is what the engine asks for when the script halts
        // (SmartAccount.AssertResetsLanded): a transaction that ends on a reset with no governance validator left faults as a
        // whole. Without that rule the seat could reset and stop, and the account would have no governance caller left for any
        // later configuration. It is also what refuses a second reset of the same account in the engine.
        private readonly Dictionary<UInt160, (UInt160 Seat, ulong? AuthorityEpoch)> _resetInitializations = new();

        internal bool HasResetInitialization(UInt160 accountId) => _resetInitializations.ContainsKey(accountId);

        internal void OpenResetInitialization(UInt160 accountId, UInt160 seat, ulong authorityEpoch) =>
            _resetInitializations.Add(accountId, (seat, authorityEpoch));

        internal bool IsResetInitialization(UInt160 accountId, UInt160 caller, ulong authorityEpoch) =>
            _resetInitializations.TryGetValue(accountId, out var claim) && claim == (caller, (ulong?)authorityEpoch);

        /// <summary> Consumes the claim of a landed initialization; the row stays as the record of the reset. </summary>
        internal void CloseResetInitialization(UInt160 accountId) =>
            _resetInitializations[accountId] = (_resetInitializations[accountId].Seat, null);

        /// <summary> Every account this engine has reset, whether or not its initialization landed. </summary>
        internal IEnumerable<UInt160> ResetAccounts => _resetInitializations.Keys;

        // ---- 6. Entry, callback and target grants -------------------------------------------------------------------------------

        /// <summary> Enters an account for the duration of the returned scope. </summary>
        /// <exception cref="InvalidOperationException"> SA_REENTRANCY_FORBIDDEN: while an account is entered, entering the same
        /// account is direct re-entry and entering another is cross-account recursion (spec §3.6). An entry holds the
        /// account for one operation and releases it when that operation ends. </exception>
        internal IDisposable EnterAccount(UInt160 accountId)
        {
            RequireIdentity(accountId);
            if (_account is not null)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorReentrancyForbidden);
            _account = accountId;
            _accountAddress = SmartAccountProtocol.GetAccountAddress(accountId);
            return new AccountEntry(this);
        }

        private sealed class AccountEntry(SmartAccountInvocationContext owner) : IDisposable
        {
            public void Dispose()
            {
                owner._account = null;
                owner._accountAddress = UInt160.Zero;
            }
        }

        private void RequireAccount(UInt160 accountId)
        {
            if (_account != accountId)
                throw new InvalidOperationException(
                    $"{SmartAccountModuleProtocol.ErrorPhaseViolation} A grant requires the entered SmartAccount.");
        }

        /// <summary> Opens a module callback of the entered account and returns the callback it suspends, if any (a leaf member
        /// validated through its composite parent). <see cref="ExitCallback"/> restores it. </summary>
        internal (BigInteger ModuleId, UInt160 Contract, SmartAccountCallbackPhase Phase, ExecutionContextState? Anchor) EnterCallback(
            UInt160 accountId, BigInteger moduleId, UInt160 contract, SmartAccountCallbackPhase phase, ExecutionContextState anchor)
        {
            RequireAccount(accountId);
            var suspended = (_callbackModuleId, _callbackContract, _callbackPhase, _callbackAnchor);
            _callbackModuleId = moduleId;
            _callbackContract = contract;
            _callbackPhase = phase;
            _callbackAnchor = anchor;
            return suspended;
        }

        internal void ExitCallback((BigInteger ModuleId, UInt160 Contract, SmartAccountCallbackPhase Phase, ExecutionContextState? Anchor) suspended)
        {
            (_callbackModuleId, _callbackContract, _callbackPhase, _callbackAnchor) = suspended;
        }

        internal BigInteger CallbackModuleId => _callbackModuleId;
        internal UInt160 CallbackContract => _callbackContract;

        /// <summary> Opens the target dispatch of the entered account: until the returned scope is closed the only open
        /// authorization of the account is its dispatched target. The core itself is never a target; any other contract,
        /// native ones included, may be. </summary>
        internal IDisposable EnterTarget(UInt160 accountId, UInt160 target, ExecutionContextState anchor)
        {
            RequireAccount(accountId);
            if (target == SmartAccountProtocol.ServiceHash)
                throw new ArgumentException(
                    $"{SmartAccountModuleProtocol.ErrorPhaseViolation} The dispatch target identity is invalid.");
            _targetAnchor = anchor;
            return new TargetEntry(this);
        }

        private sealed class TargetEntry(SmartAccountInvocationContext owner) : IDisposable
        {
            public void Dispose() => owner._targetAnchor = null;
        }

        // ---- 7. Queries of the core entry points -------------------------------------------------------------------------------

        /// <summary> Trigger gate of a writer phase: an application invocation may address every phase it runs (validation,
        /// completion, lifecycle), a verification invocation may only address the validation phase of a read-only
        /// validateUserOp call, and the native persist triggers never address account state at all. </summary>
        private static bool AllowsPhase(ApplicationEngine engine, SmartAccountCallbackPhase phase) =>
            engine.Trigger == TriggerType.Application
            || (engine.Trigger == TriggerType.Verification && phase is
                SmartAccountCallbackPhase.Validation or SmartAccountCallbackPhase.MemberValidation
                or SmartAccountCallbackPhase.HookPlanning);

        private static ExecutionContextState? QueryCaller(ApplicationEngine engine) =>
            engine.State != Neo.VM.VMState.FAULT && engine.CurrentScriptHash == SmartAccountProtocol.ServiceHash
                ? engine.CurrentContext!.GetState<ExecutionContextState>().CallingContext?.GetState<ExecutionContextState>()
                : null;

        /// <summary> True when the caller of this core invocation is the module instance of the callback in progress, which
        /// must belong to the phase asked for. Used by the module-facing <c>getAuthorizedModuleId</c> query and by
        /// <c>validateMember</c>. </summary>
        internal bool IsModuleAuthorized(ApplicationEngine engine, UInt160 accountId, SmartAccountCallbackPhase phase) =>
            _callbackAnchor is not null && _account == accountId && _callbackPhase == phase
            && AllowsPhase(engine, phase) && ReferenceEquals(QueryCaller(engine), _callbackAnchor);

        /// <summary> True while the account's proxy script is invoking the core from inside that account's own target dispatch —
        /// the only window in which an account witness may be granted without a transaction witness. </summary>
        internal bool IsTargetAuthorized(ApplicationEngine engine, UInt160 accountId)
        {
            if (engine.State == Neo.VM.VMState.FAULT || engine.Trigger != TriggerType.Application || _account != accountId
                || _targetAnchor is not { } target || _callbackAnchor is not null)
                return false;
            var proxy = engine.CurrentContext?.GetState<ExecutionContextState>();
            var caller = proxy?.CallingContext?.GetState<ExecutionContextState>();
            return ReferenceEquals(caller, target);
        }

        /// <summary> Whether the account address may witness from the current frame. Only the account's own dispatched target
        /// frame acts as the account. The core never evaluates the account proxy as a witness: every witness check it makes
        /// names a custody address, and a custody address is never an account proxy. A module callback never carries the account
        /// witness, and anything the target calls in turn (nested contracts, native ones included, dynamic scripts) is
        /// excluded. </summary>
        internal bool IsWitnessAuthorized(ApplicationEngine engine, UInt160 accountAddress)
        {
            if (engine.State == Neo.VM.VMState.FAULT || engine.Trigger != TriggerType.Application || accountAddress is null
                || _account is null || _targetAnchor is not { } target || _callbackAnchor is not null
                || accountAddress != _accountAddress)
                return false;
            return ReferenceEquals(engine.CurrentContext?.GetState<ExecutionContextState>(), target);
        }

        /// <summary> Whether the address is the proxy of the account this engine is currently executing. Such a proxy must
        /// never become a witness principal through the legacy signer fast path: the only way it authorizes anything is its own
        /// verified execution (spec §3.6). </summary>
        internal bool IsAccountProxyActive(UInt160 address) =>
            address is not null && _account is not null && _accountAddress == address;

        private static void RequireIdentity(UInt160 identity)
        {
            ArgumentNullException.ThrowIfNull(identity);
            if (identity == UInt160.Zero)
                throw new ArgumentException(
                    $"{SmartAccountModuleProtocol.ErrorOperationMalformed} An invocation identity cannot be zero.", nameof(identity));
        }
    }
}
