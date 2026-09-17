using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        // ========================================================================
        // 2. Account Initialization / Configuration
        // ========================================================================

        private static readonly byte[] RegistrationAccountIdDomain = new byte[] { 0xAA, 0x52, 0x47, 0x01 };

        [Safe]
        public static UInt160 ComputeRegistrationAccountId(UInt160 verifier, ByteString verifierParams, UInt160 hookId, UInt160 backupOwner, uint escapeTimelock)
        {
            byte[] payload = RegistrationAccountIdDomain;
            payload = Helper.Concat(payload, ToRegistrationHashBytes(backupOwner));
            payload = Helper.Concat(payload, ToRegistrationHashBytes(verifier));
            payload = Helper.Concat(payload, ToRegistrationHashBytes(hookId));
            payload = Helper.Concat(payload, UInt32ToLittleEndianBytes(escapeTimelock));
            if (verifierParams != null && verifierParams.Length > 0)
            {
                payload = Helper.Concat(payload, (byte[])verifierParams);
            }

            byte[] hash = (byte[])CryptoLib.Ripemd160((ByteString)CryptoLib.Sha256((ByteString)payload));
            return (UInt160)(ByteString)ReverseBytes(hash);
        }

        private static byte[] UInt32ToLittleEndianBytes(uint value)
        {
            return new byte[]
            {
                (byte)(value & 0xFF),
                (byte)((value >> 8) & 0xFF),
                (byte)((value >> 16) & 0xFF),
                (byte)((value >> 24) & 0xFF)
            };
        }

        private static byte[] ToRegistrationHashBytes(UInt160 value)
        {
            return ReverseBytes((byte[])value);
        }

        private static byte[] ReverseBytes(byte[] source)
        {
            byte[] reversed = new byte[source.Length];
            for (int i = 0; i < source.Length; i++)
            {
                reversed[i] = source[source.Length - 1 - i];
            }
            return reversed;
        }

        /// <summary>
        /// Creates a new deterministic AA account and optionally configures its initial verifier and hook.
        /// </summary>
        public static void RegisterAccount(UInt160 accountId, UInt160 verifier, ByteString verifierParams, UInt160 hookId, UInt160 backupOwner, uint escapeTimelock)
        {
            RegisterAccountCore(accountId, verifier, verifierParams, hookId, backupOwner, escapeTimelock, true);
        }

        private static void RegisterAccountCore(UInt160 accountId, UInt160 verifier, ByteString verifierParams, UInt160 hookId, UInt160 backupOwner, uint escapeTimelock, bool requireBackupOwnerWitness, UInt160? expectedAccountId = null)
        {
            ExecutionEngine.Assert(accountId != null && accountId != UInt160.Zero, "Account id required");
            ExecutionEngine.Assert(backupOwner != null && backupOwner != UInt160.Zero, "Backup owner required");
            if (requireBackupOwnerWitness)
            {
                ExecutionEngine.Assert(Runtime.CheckWitness(backupOwner!), "Backup owner witness required");
            }
            ExecutionEngine.Assert(escapeTimelock >= 604800, "Escape timelock must be at least 7 days");
            ExecutionEngine.Assert(escapeTimelock <= 7776000, "Escape timelock must not exceed 90 days");
            UInt160 expected = expectedAccountId ?? ComputeRegistrationAccountId(verifier, verifierParams, hookId, backupOwner!, escapeTimelock);
            ExecutionEngine.Assert(accountId == expected, "Account id does not match registration parameters");

            if (verifier != UInt160.Zero)
            {
                AssertV3Verifier(verifier);
            }

            byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId!);
            ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext, key) == null, "Account already exists");

            AccountState state = new AccountState
            {
                Verifier = verifier!,
                HookId = hookId!,
                BackupOwner = backupOwner!,
                EscapeTimelock = escapeTimelock,
                EscapeTriggeredAt = 0
            };
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(state));
            OnAccountRegistered(accountId!, backupOwner!, verifier, hookId);
            if (verifier != UInt160.Zero)
            {
                OnModuleInstalled(accountId!, ModuleTypeVerifier, verifier);
            }
            if (hookId != UInt160.Zero)
            {
                OnModuleInstalled(accountId!, ModuleTypeHook, hookId);
            }

            if (verifier != UInt160.Zero && verifierParams != null && verifierParams.Length > 0)
            {
                SetVerifierConfigContext(accountId!, verifier);
                try
                {
                    Contract.Call(verifier, "setPublicKey", CallFlags.All, new object[] { accountId!, verifierParams });
                }
                finally
                {
                    ClearVerifierConfigContext(accountId!);
                }
            }
        }

        /// <summary>
        /// Registers multiple deterministic AA accounts atomically with shared owner, verifier, hook, and timelock.
        /// Each account remains bound to its own verifier params, so anchors can derive 21 agent accounts from
        /// anchor/app/agent/nonce material without exposing a front-running registration path.
        /// </summary>
        public static void RegisterAccounts(UInt160[] accountIds, UInt160 verifier, ByteString[] verifierParamsList, UInt160 hookId, UInt160 backupOwner, uint escapeTimelock)
        {
            ExecutionEngine.Assert(accountIds != null && verifierParamsList != null, "Account batch required");
            UInt160[] ids = accountIds!;
            ByteString[] paramList = verifierParamsList!;
            ExecutionEngine.Assert(ids.Length > 0 && ids.Length <= 64, "Account batch size must be 1-64");
            ExecutionEngine.Assert(ids.Length == paramList.Length, "Account batch params mismatch");

            for (int i = 0; i < ids.Length; i++)
            {
                RegisterAccount(ids[i]!, verifier, paramList[i], hookId, backupOwner!, escapeTimelock);
            }
        }


        /// <summary>
        /// Initiates a hook plugin replacement with a timelock delay for security.
        /// If no hook is currently set, the hook is updated instantly.
        /// </summary>
        public static void UpdateHook(UInt160 accountId, UInt160 newHookId)
        {
            AssertBackupOwner(accountId);
            AssertNoMarketEscrow(accountId);

            AccountState state = GetAccountState(accountId);

            if (state.HookId == UInt160.Zero)
            {
                state.HookId = newHookId;
                byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
                Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(state));
                if (newHookId != UInt160.Zero)
                {
                    OnModuleInstalled(accountId, ModuleTypeHook, newHookId);
                }
                OnHookUpdateConfirmed(accountId, newHookId);
                return;
            }

            byte[] key2 = Helper.Concat(Prefix_PendingHookUpdate, (byte[])accountId);
            ByteString? existing = Storage.Get(Storage.CurrentContext, key2);
            ExecutionEngine.Assert(existing == null, "Cancel or confirm pending update first");

            PendingConfigUpdate update = new PendingConfigUpdate
            {
                NewHookId = newHookId,
                InitiatedAt = Runtime.Time
            };
            Storage.Put(Storage.CurrentContext, key2, StdLib.Serialize(update));
            OnModuleUpdateInitiated(accountId, ModuleTypeHook, newHookId);
            OnHookUpdateInitiated(accountId, newHookId);
        }

        /// <summary>
        /// Confirms a pending hook update after the timelock has elapsed.
        /// </summary>
        public static void ConfirmHookUpdate(UInt160 accountId)
        {
            AssertBackupOwner(accountId);
            AssertNoMarketEscrow(accountId);

            byte[] key = Helper.Concat(Prefix_PendingHookUpdate, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "No pending hook update");

            PendingConfigUpdate pending = (PendingConfigUpdate)StdLib.Deserialize(data!);
            ExecutionEngine.Assert(Runtime.Time >= pending.InitiatedAt + ConfigUpdateTimelockMs, "Timelock not elapsed");

            AccountState state = GetAccountState(accountId);
            UInt160 previousHook = state.HookId;

            // Clear old plugin's per-account state before replacing it
            // Must set config context so the plugin's ValidateConfigCaller succeeds
            if (previousHook != UInt160.Zero)
            {
                SetHookConfigContext(accountId, previousHook);
                try { Contract.Call(previousHook, "clearAccount", CallFlags.All, new object[] { accountId }); }
                catch { } // Plugin may not implement clearAccount
                finally { ClearHookConfigContext(accountId); }
            }

            state.HookId = pending.NewHookId;
            byte[] stateKey = Helper.Concat(Prefix_AccountState, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, stateKey, StdLib.Serialize(state));
            Storage.Delete(Storage.CurrentContext, key);
            if (pending.NewHookId == UInt160.Zero)
            {
                if (previousHook != UInt160.Zero)
                {
                    OnModuleRemoved(accountId, ModuleTypeHook, previousHook);
                }
            }
            else
            {
                OnModuleUpdateConfirmed(accountId, ModuleTypeHook, pending.NewHookId);
            }
            OnHookUpdateConfirmed(accountId, pending.NewHookId);
        }

        /// <summary>
        /// Initiates a verifier plugin replacement with a timelock delay for security.
        /// If no verifier is currently set, the verifier is updated instantly.
        /// </summary>
        public static void UpdateVerifier(UInt160 accountId, UInt160 newVerifier, ByteString verifierParams)
        {
            AssertBackupOwner(accountId);
            AssertNoMarketEscrow(accountId);

            AccountState state = GetAccountState(accountId);

            if (state.Verifier == UInt160.Zero)
            {
                if (newVerifier != UInt160.Zero)
                {
                    AssertV3Verifier(newVerifier);
                }

                state.Verifier = newVerifier;
                byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
                Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(state));

                if (newVerifier != UInt160.Zero && verifierParams != null && verifierParams.Length > 0)
                {
                    SetVerifierConfigContext(accountId, newVerifier);
                    try
                    {
                        Contract.Call(newVerifier, "setPublicKey", CallFlags.All, new object[] { accountId, verifierParams });
                    }
                    finally
                    {
                        ClearVerifierConfigContext(accountId!);
                    }
                }
                if (newVerifier != UInt160.Zero)
                {
                    OnModuleInstalled(accountId, ModuleTypeVerifier, newVerifier);
                }
                OnVerifierUpdateConfirmed(accountId, newVerifier);
                return;
            }

            byte[] key2 = Helper.Concat(Prefix_PendingVerifierUpdate, (byte[])accountId);
            ByteString? existing = Storage.Get(Storage.CurrentContext, key2);
            ExecutionEngine.Assert(existing == null, "Cancel or confirm pending update first");

            PendingConfigUpdate update = new PendingConfigUpdate
            {
                NewVerifier = newVerifier,
                VerifierParams = verifierParams,
                InitiatedAt = Runtime.Time
            };
            Storage.Put(Storage.CurrentContext, key2, StdLib.Serialize(update));
            OnModuleUpdateInitiated(accountId, ModuleTypeVerifier, newVerifier);
            OnVerifierUpdateInitiated(accountId, newVerifier);
        }

        /// <summary>
        /// Confirms a pending verifier update after the timelock has elapsed.
        /// </summary>
        public static void ConfirmVerifierUpdate(UInt160 accountId)
        {
            AssertBackupOwner(accountId);
            AssertNoMarketEscrow(accountId);

            byte[] key = Helper.Concat(Prefix_PendingVerifierUpdate, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "No pending verifier update");

            PendingConfigUpdate pending = (PendingConfigUpdate)StdLib.Deserialize(data!);
            ExecutionEngine.Assert(Runtime.Time >= pending.InitiatedAt + ConfigUpdateTimelockMs, "Timelock not elapsed");

            if (pending.NewVerifier != UInt160.Zero)
            {
                AssertV3Verifier(pending.NewVerifier);
            }

            AccountState state = GetAccountState(accountId);
            UInt160 previousVerifier = state.Verifier;

            // Clear old plugin's per-account state before replacing it
            // Must set config context so the plugin's ValidateConfigCaller succeeds
            if (previousVerifier != UInt160.Zero)
            {
                SetVerifierConfigContext(accountId, previousVerifier);
                try { Contract.Call(previousVerifier, "clearAccount", CallFlags.All, new object[] { accountId }); }
                catch { } // Plugin may not implement clearAccount
                finally { ClearVerifierConfigContext(accountId!); }
            }

            state.Verifier = pending.NewVerifier;
            byte[] stateKey = Helper.Concat(Prefix_AccountState, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, stateKey, StdLib.Serialize(state));

            if (pending.NewVerifier != UInt160.Zero && pending.VerifierParams != null && pending.VerifierParams.Length > 0)
            {
                SetVerifierConfigContext(accountId, pending.NewVerifier);
                try
                {
                    Contract.Call(pending.NewVerifier, "setPublicKey", CallFlags.All, new object[] { accountId, pending.VerifierParams });
                }
                finally
                {
                    ClearVerifierConfigContext(accountId!);
                }
            }

            Storage.Delete(Storage.CurrentContext, key);
            if (pending.NewVerifier == UInt160.Zero)
            {
                if (previousVerifier != UInt160.Zero)
                {
                    OnModuleRemoved(accountId, ModuleTypeVerifier, previousVerifier);
                }
            }
            else
            {
                OnModuleUpdateConfirmed(accountId, ModuleTypeVerifier, pending.NewVerifier);
            }
            OnVerifierUpdateConfirmed(accountId, pending.NewVerifier);
        }

        private static void AssertV3Verifier(UInt160 verifier)
        {
            bool supported = (bool)Contract.Call(verifier, "supportsV3", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(supported, "Verifier does not implement V3 interface");
        }

        private static readonly string[] AllowedVerifierMethods = new string[]
        {
            "clearAccount",
            "setSessionKey",
            "clearSessionKey",
            "setConfig",
            "createSubscription",
            "setDKIMRegistry"
        };

        private static readonly string[] AllowedHookMethods = new string[]
        {
            "setDailyLimit",
            "setWhitelist",
            "setRestrictedToken",
            "requireCredentialCommitmentForContract",
            "setRegistry",
            "setHooks",
            "setConfig",
            "clearAccount"
        };

        private static bool IsMethodAllowed(string method, string[] allowlist)
        {
            for (int i = 0; i < allowlist.Length; i++)
            {
                if (method == allowlist[i]) return true;
            }
            return false;
        }

        private static ByteString ComputeModuleCallHash(string method, object[] args)
        {
            return CryptoLib.Sha256(StdLib.Serialize(new object[] { method, args }));
        }

        private static void StorePendingModuleCall(byte[] pendingKey, UInt160 moduleHash, ByteString callHash)
        {
            PendingModuleCall pending = new PendingModuleCall
            {
                ModuleHash = moduleHash,
                CallHash = callHash,
                InitiatedAt = Runtime.Time
            };
            Storage.Put(Storage.CurrentContext, pendingKey, StdLib.Serialize(pending));
        }

        private static bool TryConfirmPendingModuleCall(byte[] pendingKey, UInt160 moduleHash, string method, object[] args)
        {
            ByteString callHash = ComputeModuleCallHash(method, args);
            ByteString? data = Storage.Get(Storage.CurrentContext, pendingKey);
            if (data == null)
            {
                StorePendingModuleCall(pendingKey, moduleHash, callHash);
                return false;
            }

            PendingModuleCall pending = (PendingModuleCall)StdLib.Deserialize(data!);
            if (pending.ModuleHash != moduleHash || pending.CallHash != callHash)
            {
                StorePendingModuleCall(pendingKey, moduleHash, callHash);
                return false;
            }

            ExecutionEngine.Assert(Runtime.Time >= pending.InitiatedAt + ConfigUpdateTimelockMs, "Timelock not elapsed");
            Storage.Delete(Storage.CurrentContext, pendingKey);
            return true;
        }

        /// <summary>
        /// Allows the backup owner to call an account verifier for configuration or maintenance tasks.
        /// Only methods in the allowlist may be called to prevent timelock bypass.
        /// </summary>
        public static object CallVerifier(UInt160 accountId, string method, object[] args)
        {
            ExecutionEngine.Assert(IsMethodAllowed(method, AllowedVerifierMethods), "Verifier method not allowed");
            AssertBackupOwner(accountId);
            AssertNoMarketEscrow(accountId);
            AccountState state = GetAccountState(accountId);
            ExecutionEngine.Assert(state.Verifier != null && state.Verifier != UInt160.Zero, "Verifier not configured");

            byte[] pendingKey = Helper.Concat(Prefix_PendingVerifierCall, (byte[])accountId);
            if (!TryConfirmPendingModuleCall(pendingKey, state.Verifier!, method, args))
            {
                return false;
            }

            SetVerifierConfigContext(accountId, state.Verifier!);
            try
            {
                return Contract.Call(state.Verifier!, method, CallFlags.All, args);
            }
            finally
            {
                ClearVerifierConfigContext(accountId!);
            }
        }

        /// <summary>
        /// Allows the backup owner to call an account hook for configuration or maintenance tasks.
        /// Only methods in the allowlist may be called to prevent timelock bypass.
        /// </summary>
        public static object CallHook(UInt160 accountId, string method, object[] args)
        {
            ExecutionEngine.Assert(IsMethodAllowed(method, AllowedHookMethods), "Hook method not allowed");
            AssertBackupOwner(accountId);
            AssertNoMarketEscrow(accountId);
            AccountState state = GetAccountState(accountId);
            ExecutionEngine.Assert(state.HookId != null && state.HookId != UInt160.Zero, "Hook not configured");

            byte[] pendingKey = Helper.Concat(Prefix_PendingHookCall, (byte[])accountId);
            if (!TryConfirmPendingModuleCall(pendingKey, state.HookId!, method, args))
            {
                return false;
            }

            SetHookConfigContext(accountId, state.HookId!);
            try
            {
                return Contract.Call(state.HookId!, method, CallFlags.All, args);
            }
            finally
            {
                ClearHookConfigContext(accountId);
            }
        }
    }
}
