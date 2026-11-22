// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountInvocationContext.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

// TRUE SOURCE: this is the only editable copy of this SmartAccount native
// contract file. The neo-native-core checkout carries a generated copy —
// regenerate it via scripts/sync_native_smartaccount.py.

using Neo.Extensions;
using System;
using System.Collections.Generic;
using System.Numerics;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// Writer phases of the v4 execution state machine (spec §7.1/§9). A
    /// module callback is authorized only while the recorded phase is the one
    /// that callback belongs to, for the exact active module instance.
    ///
    /// The minimal core runs one validator callback per phase, so no aggregate
    /// gas pool is tracked here: every callback carries its own hard VM gas
    /// limit instead.
    /// </summary>
    internal enum SmartAccountCallbackPhase : byte
    {
        None = 0,
        Validation = 1,
        // 2 and 4 were the hook pre/post phases. The minimal core runs no
        // hooks, so those values are retired and never defined again: a module
        // asking for them is rejected instead of being granted an unused phase.
        TargetDispatch = 3,
        Completion = 5,
        Configuration = 6,
        Cleanup = 7,
    }

    /// <summary>Engine-local account locks, execution state and phase grants.</summary>
    internal sealed class SmartAccountInvocationContext
    {
        private readonly Dictionary<UInt160, AccountLease> _accounts = new();
        private readonly Dictionary<UInt160, AccountExecution> _executions = new();
        private readonly Stack<Lease> _scopes = new();
        private object _generation = new();

        internal sealed class AccountExecution
        {
            internal byte Phase;
            internal BigInteger ActiveModuleId = BigInteger.Zero;
            internal UInt160 ActiveModuleContract = UInt160.Zero;
        }

        private abstract class Lease(SmartAccountInvocationContext owner) : IDisposable
        {
            internal readonly object Generation = owner._generation;
            private bool _disposed;
            internal abstract UInt160 Account { get; }
            public void Dispose()
            {
                if (_disposed) return;
                owner.Release(this);
                _disposed = true;
            }
        }

        private sealed class AccountLease(SmartAccountInvocationContext owner, UInt160 identity) : Lease(owner)
        {
            internal readonly UInt160 Identity = Copy(identity);
            internal readonly UInt160 Address = SmartAccountProtocol.GetAccountAddress(identity);
            internal override UInt160 Account => Identity;
        }

        private sealed class GrantLease(SmartAccountInvocationContext owner, UInt160 account,
            BigInteger moduleId, UInt160 contract, SmartAccountCallbackPhase phase, ExecutionContextState anchor)
            : Lease(owner)
        {
            internal override UInt160 Account => account;
            internal readonly BigInteger ModuleId = moduleId;
            internal readonly UInt160 Contract = Copy(contract);
            internal readonly SmartAccountCallbackPhase Phase = phase;
            internal readonly ExecutionContextState Anchor = anchor;
        }

        private sealed class TargetLease(SmartAccountInvocationContext owner, UInt160 account,
            UInt160 target, ExecutionContextState anchor) : Lease(owner)
        {
            internal override UInt160 Account => account;
            internal readonly UInt160 Target = Copy(target);
            internal readonly ExecutionContextState Anchor = anchor;
        }

        private static UInt160 Copy(UInt160 value) => new(value.ToArray());

        private static void RequireIdentity(UInt160 identity)
        {
            ArgumentNullException.ThrowIfNull(identity);
            if (identity == UInt160.Zero)
                throw new ArgumentException("An invocation identity cannot be zero.", nameof(identity));
        }

        private static bool MatchesContract(ExecutionContextState? state, UInt160 contract) =>
            state?.Contract is not null && state.ScriptHash == contract && state.Contract.Hash == contract;

        internal IDisposable EnterAccount(UInt160 accountId)
        {
            RequireIdentity(accountId);
            // One authorized transition at a time (spec §3.6): while any account
            // lease is open, entering the same account is direct re-entry and
            // entering a different account is cross-account recursion. Both are
            // reentrancy and fault with the shared code. A batch is unaffected:
            // its operations run sequentially on one account and every lease is
            // released before the next operation enters.
            if (_accounts.Count > 0)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorReentrancyForbidden);
            var lease = new AccountLease(this, accountId);
            _accounts.Add(lease.Identity, lease);
            _scopes.Push(lease);
            return lease;
        }

        private AccountLease RequireAccount(UInt160 accountId)
        {
            RequireIdentity(accountId);
            if (!_accounts.TryGetValue(accountId, out var account) ||
                !_scopes.TryPeek(out var active) || active.Account != accountId)
                throw new InvalidOperationException("A grant requires the currently locked SmartAccount.");
            return account;
        }

        /// <summary>Engine-local execution state of an account (phase and active grant).</summary>
        internal AccountExecution Execution(UInt160 accountId)
        {
            if (!_executions.TryGetValue(accountId, out var execution))
                throw new InvalidOperationException("The SmartAccount has no open execution context.");
            return execution;
        }

        internal bool TryGetExecution(UInt160 accountId, out AccountExecution execution) =>
            _executions.TryGetValue(accountId, out execution!);

        internal void OpenExecution(UInt160 accountId)
        {
            if (_executions.ContainsKey(accountId))
                throw new InvalidOperationException("The SmartAccount already has an open execution context.");
            _executions.Add(accountId, new AccountExecution());
        }

        internal void CloseExecution(UInt160 accountId) => _executions.Remove(accountId);

        private static void RequireAnchor(UInt160 contract, ExecutionContextState anchor)
        {
            RequireIdentity(contract);
            ArgumentNullException.ThrowIfNull(anchor);
            if (!MatchesContract(anchor, contract))
                throw new ArgumentException("The grant must identify its loaded contract invocation.", nameof(anchor));
        }

        internal void AssertModuleEntry(UInt160 accountId, UInt160 contract, SmartAccountCallbackPhase phase)
        {
            _ = RequireAccount(accountId);
            RequireIdentity(contract);
            if (phase == SmartAccountCallbackPhase.None || phase > SmartAccountCallbackPhase.Cleanup
                || !Enum.IsDefined(phase)
                || NativeContract.IsNative(contract) || contract == SmartAccountProtocol.ServiceHash)
                throw new ArgumentException("The callback phase or module identity is invalid.");
        }

        internal IDisposable EnterModule(UInt160 accountId, BigInteger moduleId, UInt160 contract,
            SmartAccountCallbackPhase phase, ExecutionContextState anchor)
        {
            AssertModuleEntry(accountId, contract, phase);
            AccountLease account = RequireAccount(accountId);
            RequireAnchor(contract, anchor);
            AccountExecution execution = Execution(accountId);
            execution.Phase = (byte)phase;
            execution.ActiveModuleId = moduleId;
            execution.ActiveModuleContract = Copy(contract);
            var lease = new GrantLease(this, account.Identity, moduleId, contract, phase, anchor);
            _scopes.Push(lease);
            return lease;
        }

        /// <summary>
        /// Opens the target-dispatch scope: from here until the scope is closed
        /// the ONLY open authorization of the account is its dispatched target.
        /// </summary>
        internal IDisposable EnterTarget(UInt160 accountId, UInt160 target, ExecutionContextState anchor)
        {
            AccountLease account = RequireAccount(accountId);
            RequireAnchor(target, anchor);
            // Only the core itself is excluded: a dispatched target may be any
            // contract, native ones included (transfers, registration, ...).
            if (target == SmartAccountProtocol.ServiceHash)
                throw new ArgumentException("The dispatch target identity is invalid.");
            AccountExecution execution = Execution(accountId);
            execution.Phase = (byte)SmartAccountCallbackPhase.TargetDispatch;
            execution.ActiveModuleId = BigInteger.Zero;
            execution.ActiveModuleContract = Copy(target);
            var lease = new TargetLease(this, account.Identity, target, anchor);
            _scopes.Push(lease);
            return lease;
        }

        /// <summary>
        /// Trigger gate of a writer phase: an application invocation may address
        /// every phase it runs (validation preview, completion, lifecycle), a
        /// verification invocation may only address the validation phase, and
        /// the native persist triggers never address account state at all.
        /// </summary>
        private static bool AllowsPhase(ApplicationEngine engine, SmartAccountCallbackPhase phase) =>
            engine.Trigger == TriggerType.Application
            || (engine.Trigger == TriggerType.Verification && phase == SmartAccountCallbackPhase.Validation);

        /// <summary>
        /// True while the account's proxy script is invoking the core from
        /// inside that account's own target dispatch — the only window in which
        /// an account witness may be granted without a transaction witness.
        /// </summary>
        internal bool IsTargetAuthorized(ApplicationEngine engine, UInt160 accountId)
        {
            if (engine.State == Neo.VM.VMState.FAULT || engine.Trigger != TriggerType.Application) return false;
            if (!_scopes.TryPeek(out var active) || active is not TargetLease target || target.Account != accountId)
                return false;
            var proxy = engine.CurrentContext?.GetState<ExecutionContextState>();
            var caller = proxy?.CallingContext?.GetState<ExecutionContextState>();
            return ReferenceEquals(caller, target.Anchor);
        }

        /// <summary>Closes the writer phase of an account.</summary>
        internal void ClosePhase(UInt160 accountId)
        {
            AccountExecution execution = Execution(accountId);
            execution.Phase = (byte)SmartAccountCallbackPhase.None;
            execution.ActiveModuleId = BigInteger.Zero;
            execution.ActiveModuleContract = UInt160.Zero;
        }

        private static ExecutionContextState? QueryCaller(ApplicationEngine engine) =>
            engine.State != Neo.VM.VMState.FAULT && engine.CurrentScriptHash == SmartAccountProtocol.ServiceHash
                ? engine.CurrentContext!.GetState<ExecutionContextState>().CallingContext?.GetState<ExecutionContextState>()
                : null;

        /// <summary>
        /// True when the caller of this core invocation is the module instance
        /// that the current phase addresses. Used by the module-facing
        /// <c>getAuthorizedModuleId</c> query.
        /// </summary>
        internal bool IsModuleAuthorized(ApplicationEngine engine, UInt160 accountId, SmartAccountCallbackPhase phase)
        {
            if (!_scopes.TryPeek(out var active) || active is not GrantLease grant
                || grant.Account != accountId || grant.Phase != phase)
                return false;
            if (!AllowsPhase(engine, phase)) return false;
            ExecutionContextState? caller = QueryCaller(engine);
            return ReferenceEquals(caller, grant.Anchor) && MatchesContract(caller, grant.Contract);
        }

        /// <summary>
        /// Whether the account address may witness from the current frame. Only
        /// the account's own dispatched target acts as the account: either the
        /// target frame itself, or the core invoked directly by that frame. A
        /// module callback never carries the account witness, and anything the
        /// target calls in turn (nested contracts, dynamic scripts) is excluded.
        /// </summary>
        internal bool IsWitnessAuthorized(ApplicationEngine engine, UInt160 accountAddress)
        {
            if (engine.State == Neo.VM.VMState.FAULT || engine.Trigger != TriggerType.Application || accountAddress is null)
                return false;
            if (!_scopes.TryPeek(out var active) || active is not TargetLease target)
                return false;
            if (accountAddress != SmartAccountProtocol.GetAccountAddress(target.Account)) return false;
            ExecutionContextState? current = engine.CurrentContext?.GetState<ExecutionContextState>();
            if (ReferenceEquals(current, target.Anchor)) return true;
            return engine.CurrentScriptHash == SmartAccountProtocol.ServiceHash
                && ReferenceEquals(current?.CallingContext?.GetState<ExecutionContextState>(), target.Anchor);
        }

        /// <summary>
        /// Whether the address is the proxy of an account this invocation is
        /// currently executing. Such a proxy must never become a witness
        /// principal through the legacy signer fast path: the only way it
        /// authorizes anything is its own verified execution (spec §3.6).
        /// </summary>
        internal bool IsAccountProxyActive(UInt160 address)
        {
            if (address is null) return false;
            foreach (AccountLease account in _accounts.Values)
            {
                if (account.Address == address) return true;
            }
            return false;
        }

        private void Release(Lease lease)
        {
            if (!ReferenceEquals(lease.Generation, _generation)) return;
            if (!_scopes.TryPeek(out var active) || !ReferenceEquals(active, lease))
                throw new InvalidOperationException("Invocation scopes must be released in reverse order.");
            _scopes.Pop();
            if (lease is AccountLease account) _accounts.Remove(account.Identity);
        }

        internal void Reset()
        {
            _scopes.Clear();
            _accounts.Clear();
            _executions.Clear();
            _generation = new();
        }
    }
}
