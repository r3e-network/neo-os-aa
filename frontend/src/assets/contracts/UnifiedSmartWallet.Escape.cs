using System.Numerics;
using System.ComponentModel;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        // Permanent per-account latch. Kept outside AccountState to preserve its
        // deployed five-field serialization layout. No transition clears this key.
        private static readonly byte[] Prefix_OwnerOnlyRecovery = new byte[] { 0x22 };

        [DisplayName("OwnerOnlyRecoveryFinalized")]
        public static event AccountOnlyDelegate OnOwnerOnlyRecoveryFinalized = null!;

        [Safe]
        public static bool IsOwnerOnlyRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            GetAccountState(accountId);
            return HasOwnerOnlyRecovery(accountId);
        }

        private static bool HasOwnerOnlyRecovery(UInt160 accountId)
        {
            return Storage.Get(Storage.CurrentContext,
                Helper.Concat(Prefix_OwnerOnlyRecovery, (byte[])accountId)) != null;
        }

        private static void AssertPluginInstallationAllowed(UInt160 accountId, UInt160 module)
        {
            ExecutionEngine.Assert(module == UInt160.Zero || !HasOwnerOnlyRecovery(accountId),
                "Owner-only recovery is permanent");
        }

        private static void AssertPluginConfigurationAllowed(UInt160 accountId)
        {
            ExecutionEngine.Assert(!HasOwnerOnlyRecovery(accountId), "Owner-only recovery is permanent");
        }

        private static void AssertRecoveryIdle(UInt160 accountId)
        {
            // A callback must not detach an account while its outer invocation can
            // still return and restore old authority or state. Check every context,
            // even if a previous implementation did not set the execution lock.
            ExecutionEngine.Assert(!IsExecutionActive(accountId)
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_VerifyContext, (byte[])accountId)) == null
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_VerifierConfigContext, (byte[])accountId)) == null
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_HookConfigContext, (byte[])accountId)) == null
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_VerifierExecutionContext, (byte[])accountId)) == null
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_HookExecutionContext, (byte[])accountId)) == null,
                "Recovery context active");
        }

        /// <summary>
        /// Recovers to permanent backup-owner authorization without any plugin callback.
        /// Old plugin data can remain, but this account can never install plugins again.
        /// This does not erase plugin data, refund plugin-held funds or revoke external allowances.
        /// </summary>
        public static void FinalizeEscapeToOwner(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            AccountState state = GetAccountState(accountId);
            AssertNoMarketEscrow(accountId);
            AssertRecoveryIdle(accountId);
            ExecutionEngine.Assert(!HasOwnerOnlyRecovery(accountId), "Already recovered to owner-only");
            ExecutionEngine.Assert(state.EscapeTriggeredAt > 0, "Escape not initiated");
            ExecutionEngine.Assert(Runtime.Time >= state.EscapeTriggeredAt + ((BigInteger)state.EscapeTimelock * 1000), "Timelock active");
            ExecutionEngine.Assert(state.BackupOwner != UInt160.Zero && Runtime.CheckWitness(state.BackupOwner), "Only backup owner can finalize");

            UInt160 oldVerifier = state.Verifier;
            UInt160 oldHook = state.HookId;
            Storage.Put(Storage.CurrentContext, Helper.Concat(Prefix_OwnerOnlyRecovery, (byte[])accountId), new byte[] { 1 });
            state.Verifier = UInt160.Zero;
            state.HookId = UInt160.Zero;
            state.EscapeTriggeredAt = 0;
            Storage.Put(Storage.CurrentContext, Helper.Concat(Prefix_AccountState, (byte[])accountId), StdLib.Serialize(state));

            ClearVerifyContext(accountId);
            ClearVerifierConfigContext(accountId);
            ClearHookConfigContext(accountId);
            ClearVerifierExecutionContext(accountId);
            ClearHookExecutionContext(accountId);
            ClearExecutionLock(accountId);
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingVerifierUpdate, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingHookUpdate, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingPlatformOwnerRotation, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingVerifierCall, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingHookCall, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_EscapeLastInitiated, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_MetadataUri, (byte[])accountId));
            ClearMarketEscrow(accountId);

            if (oldVerifier != UInt160.Zero) OnModuleRemoved(accountId, ModuleTypeVerifier, oldVerifier);
            if (oldHook != UInt160.Zero) OnModuleRemoved(accountId, ModuleTypeHook, oldHook);
            OnEscapeFinalized(accountId, UInt160.Zero);
            OnOwnerOnlyRecoveryFinalized(accountId);
        }

        // ========================================================================
        // 6. L1 Escape Hatch (Native Fallback)
        // ========================================================================

        /// <summary>
        /// Starts the backup-owner escape flow. Finalization requires working plugin cleanup.
        /// </summary>
        public static void InitiateEscape(UInt160 accountId)
        {
            AccountState state = GetAccountState(accountId);
            AssertNoMarketEscrow(accountId);
            ExecutionEngine.Assert(state.BackupOwner != UInt160.Zero, "No backup owner");
            ExecutionEngine.Assert(Runtime.CheckWitness(state.BackupOwner), "Only backup owner can initiate");

            byte[] escapeKey = Helper.Concat(Prefix_EscapeLastInitiated, (byte[])accountId);
            ByteString? lastInitiated = Storage.Get(Storage.CurrentContext, escapeKey);
            if (lastInitiated != null)
            {
                BigInteger lastTime = (BigInteger)lastInitiated;
                ExecutionEngine.Assert(Runtime.Time >= lastTime + EscapeCooldownMs, "Escape cooldown active");
            }

            state.EscapeTriggeredAt = Runtime.Time;
            byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(state));
            Storage.Put(Storage.CurrentContext, escapeKey, Runtime.Time);
            OnEscapeInitiated(accountId, state.BackupOwner);
        }

        /// <summary>
        /// Completes the escape flow after the configured timelock and rotates to a new verifier.
        /// </summary>
        /// <remarks>
        /// The escape path is the last line of defence for a compromised account, so it must
        /// hand the backup owner a clean configuration rather than merely swapping the verifier
        /// hash. It therefore (1) clears the old (possibly compromised) verifier's per-account
        /// config, (2) atomically configures the new verifier with <paramref name="verifierParams"/>
        /// exactly as <c>RegisterAccount</c> / <c>ConfirmVerifierUpdate</c> do, and (3) resets the
        /// installed hook — clearing the old hook's per-account config and removing it from state —
        /// so a compromised hook cannot persist across an escape.
        /// Finalization remains dependent on the old verifier and hook successfully executing
        /// clearAccount. A faulty or unavailable plugin can block completion after the timelock;
        /// atomic rollback protects state but does not guarantee recovery liveness.
        /// </remarks>
        public static void FinalizeEscape(UInt160 accountId, UInt160 newVerifier)
        {
            FinalizeEscape(accountId, newVerifier, (ByteString)new byte[0]);
        }

        public static void FinalizeEscape(UInt160 accountId, UInt160 newVerifier, ByteString verifierParams)
        {
            AssertPluginInstallationAllowed(accountId, newVerifier);
            AssertRecoveryIdle(accountId);
            AccountState state = GetAccountState(accountId);
            AssertNoMarketEscrow(accountId);
            ExecutionEngine.Assert(state.EscapeTriggeredAt > 0, "Escape not initiated");
            ExecutionEngine.Assert(Runtime.Time >= state.EscapeTriggeredAt + ((BigInteger)state.EscapeTimelock * 1000), "Timelock active");
            ExecutionEngine.Assert(Runtime.CheckWitness(state.BackupOwner), "Only backup owner can finalize");

            // Apply the same installation contract as normal verifier rotation before calling
            // old plugins or changing any state. Zero explicitly restores backup-owner mode.
            if (newVerifier != UInt160.Zero)
            {
                AssertV3Verifier(newVerifier);
            }

            UInt160 previousVerifier = state.Verifier;
            UInt160 previousHook = state.HookId;

            // Clear the old (possibly compromised) verifier's per-account config before
            // rotating. A cleanup fault must abort the escape finalization rather than leaving
            // an orphaned verifier authority behind the new pointer.
            if (previousVerifier != UInt160.Zero)
            {
                SetVerifierConfigContext(accountId, previousVerifier);
                try
                {
                    Contract.Call(previousVerifier, "clearAccount", CallFlags.All, new object[] { accountId });
                }
                finally
                {
                    ClearVerifierConfigContext(accountId);
                }
            }

            // Reset the installed hook so a compromised hook cannot persist across the escape.
            if (previousHook != UInt160.Zero)
            {
                SetHookConfigContext(accountId, previousHook);
                try
                {
                    Contract.Call(previousHook, "clearAccount", CallFlags.All, new object[] { accountId });
                }
                finally
                {
                    ClearHookConfigContext(accountId);
                }
            }

            state.Verifier = newVerifier;
            state.HookId = UInt160.Zero;
            state.EscapeTriggeredAt = 0;
            byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(state));

            // Atomically configure the new verifier, exactly as RegisterAccount/ConfirmVerifierUpdate do.
            if (newVerifier != UInt160.Zero && verifierParams != null && verifierParams.Length > 0)
            {
                SetVerifierConfigContext(accountId, newVerifier);
                try
                {
                    Contract.Call(newVerifier, "setPublicKey", CallFlags.All, new object[] { accountId, verifierParams });
                }
                finally
                {
                    ClearVerifierConfigContext(accountId);
                }
            }

            byte[] escapeKey = Helper.Concat(Prefix_EscapeLastInitiated, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, escapeKey);

            // Escape is the clean-slate path: clear every stale per-account marker so the rotated
            // configuration is genuinely fresh. Besides the pending plugin *updates*, this also
            // drops any in-flight timelocked plugin *calls* and the off-chain metadata URI left by
            // the prior (possibly compromised) configuration.
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingVerifierUpdate, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingHookUpdate, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingPlatformOwnerRotation, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingVerifierCall, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingHookCall, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_MetadataUri, (byte[])accountId));

            // The old hook is unconditionally removed on escape.
            if (previousHook != UInt160.Zero)
            {
                OnModuleRemoved(accountId, ModuleTypeHook, previousHook);
            }

            if (previousVerifier != newVerifier)
            {
                if (newVerifier == UInt160.Zero)
                {
                    if (previousVerifier != UInt160.Zero)
                    {
                        OnModuleRemoved(accountId, ModuleTypeVerifier, previousVerifier);
                    }
                }
                else if (previousVerifier == UInt160.Zero)
                {
                    OnModuleInstalled(accountId, ModuleTypeVerifier, newVerifier);
                }
                else
                {
                    OnModuleUpdateConfirmed(accountId, ModuleTypeVerifier, newVerifier);
                }
            }
            OnEscapeFinalized(accountId, newVerifier);
        }
    }
}
