using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    public partial class SmartAccount
    {
        // Storage key prefixes
        private static readonly byte[] Prefix_AccountState = new byte[] { 0x01 };
        private static readonly byte[] Prefix_VerifyContext = new byte[] { 0x02 };
        private static readonly byte[] Prefix_Nonce = new byte[] { 0x03 };
        private static readonly byte[] Prefix_VerifierConfigContext = new byte[] { 0x04 };
        private static readonly byte[] Prefix_HookConfigContext = new byte[] { 0x05 };
        private static readonly byte[] Prefix_MarketEscrowContract = new byte[] { 0x06 };
        private static readonly byte[] Prefix_MarketEscrowListing = new byte[] { 0x07 };
        private static readonly byte[] Prefix_EscapeLastInitiated = new byte[] { 0x08 };
        private static readonly byte[] Prefix_PendingVerifierUpdate = new byte[] { 0x09 };
        private static readonly byte[] Prefix_PendingHookUpdate = new byte[] { 0x0A };
        private static readonly byte[] Prefix_ExecutionLock = new byte[] { 0x0B };
        private static readonly byte[] Prefix_MetadataUri = new byte[] { 0x0C };
        private static readonly byte[] Prefix_HookExecutionContext = new byte[] { 0x0D };
        private static readonly byte[] Prefix_VerifierExecutionContext = new byte[] { 0x0E };
        private static readonly byte[] Prefix_PendingVerifierCall = new byte[] { 0x0F };
        private static readonly byte[] Prefix_PendingHookCall = new byte[] { 0x10 };
        private static readonly byte[] Prefix_VerifyScopeTarget = new byte[] { 0x1C };
        // Audit fix 2026-10-24: composite module dependency registry. A composite
        // module (MultiHook, the native MultiSig profile) reports its per-account
        // children so the core can cascade clearAccount to children that were
        // dropped or when the account is cleared.
        private static readonly byte[] Prefix_HookDependencies = new byte[] { 0x23 };
        private static readonly byte[] Prefix_VerifierDependencies = new byte[] { 0x24 };
        private static readonly byte[] Prefix_DependencyMaintenance = new byte[] { 0x25 };
        private static readonly byte[] Prefix_ConfigurationContextDepth = new byte[] { 0x26 };

        private static readonly BigInteger MaxMetadataUriLength = 240;

        private static readonly BigInteger EscapeCooldownMs = 60L * 60 * 1000;
        private static readonly BigInteger ConfigUpdateTimelockMs = 24L * 60 * 60 * 1000;

        private static BigInteger GetConfigurationContextDepth()
        {
            ByteString? depth = Storage.Get(Storage.CurrentContext, Prefix_ConfigurationContextDepth);
            return depth == null ? BigInteger.Zero : (BigInteger)depth;
        }

        private static void EnterConfigurationContext()
        {
            Storage.Put(Storage.CurrentContext, Prefix_ConfigurationContextDepth, GetConfigurationContextDepth() + 1);
        }

        private static void ExitConfigurationContext()
        {
            BigInteger depth = GetConfigurationContextDepth();
            ExecutionEngine.Assert(depth > 0, "Account configuration context underflow");
            if (depth == 1)
            {
                Storage.Delete(Storage.CurrentContext, Prefix_ConfigurationContextDepth);
            }
            else
            {
                Storage.Put(Storage.CurrentContext, Prefix_ConfigurationContextDepth, depth - 1);
            }
        }

        private static void SetVerifyContext(UInt160 accountId, UInt160 targetContract)
        {
            byte[] key = Helper.Concat(Prefix_VerifyContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])targetContract);
            EnterConfigurationContext();
        }

        private static void ClearVerifyContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_VerifyContext, (byte[])accountId);
            if (Storage.Get(Storage.CurrentContext, key) == null) return;
            Storage.Delete(Storage.CurrentContext, key);
            ExitConfigurationContext();
        }

        [Safe]
        public static bool IsExecutionActive(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_ExecutionLock, (byte[])accountId);
            return Storage.Get(Storage.CurrentContext, key) != null;
        }

        private static void SetExecutionLock(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_ExecutionLock, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
            EnterConfigurationContext();
        }

        private static void ClearExecutionLock(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_ExecutionLock, (byte[])accountId);
            if (Storage.Get(Storage.CurrentContext, key) == null) return;
            Storage.Delete(Storage.CurrentContext, key);
            ExitConfigurationContext();
        }

        private static void SetVerifierConfigContext(UInt160 accountId, UInt160 verifierContract)
        {
            byte[] key = Helper.Concat(Prefix_VerifierConfigContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])verifierContract);
            EnterConfigurationContext();
        }

        private static void ClearVerifierConfigContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_VerifierConfigContext, (byte[])accountId);
            if (Storage.Get(Storage.CurrentContext, key) == null) return;
            Storage.Delete(Storage.CurrentContext, key);
            ExitConfigurationContext();
        }

        private static void SetHookConfigContext(UInt160 accountId, UInt160 hookContract)
        {
            byte[] key = Helper.Concat(Prefix_HookConfigContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])hookContract);
            EnterConfigurationContext();
        }

        private static void ClearHookConfigContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_HookConfigContext, (byte[])accountId);
            if (Storage.Get(Storage.CurrentContext, key) == null) return;
            Storage.Delete(Storage.CurrentContext, key);
            ExitConfigurationContext();
        }

        private static void SetHookExecutionContext(UInt160 accountId, UInt160 hookContract)
        {
            byte[] key = Helper.Concat(Prefix_HookExecutionContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])hookContract);
            EnterConfigurationContext();
        }

        private static void ClearHookExecutionContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_HookExecutionContext, (byte[])accountId);
            if (Storage.Get(Storage.CurrentContext, key) == null) return;
            Storage.Delete(Storage.CurrentContext, key);
            ExitConfigurationContext();
        }

        private static void SetVerifierExecutionContext(UInt160 accountId, UInt160 verifierContract)
        {
            byte[] key = Helper.Concat(Prefix_VerifierExecutionContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])verifierContract);
            EnterConfigurationContext();
        }

        private static void ClearVerifierExecutionContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_VerifierExecutionContext, (byte[])accountId);
            if (Storage.Get(Storage.CurrentContext, key) == null) return;
            Storage.Delete(Storage.CurrentContext, key);
            ExitConfigurationContext();
        }

        private static void AssertGlobalConfigurationIdle()
        {
            ExecutionEngine.Assert(GetConfigurationContextDepth() == 0, "Global configuration context active");
        }

        private static void AssertAccountConfigurationIdle(UInt160 accountId)
        {
            ExecutionEngine.Assert(GetConfigurationContextDepth() == 0
                && !IsExecutionActive(accountId)
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_VerifyContext, (byte[])accountId)) == null
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_VerifierConfigContext, (byte[])accountId)) == null
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_HookConfigContext, (byte[])accountId)) == null
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_VerifierExecutionContext, (byte[])accountId)) == null
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_HookExecutionContext, (byte[])accountId)) == null,
                "Account configuration context active");
        }

        private static void AssertBackupOwner(UInt160 accountId)
        {
            AccountState state = GetAccountState(accountId);
            ExecutionEngine.Assert(state.BackupOwner != null && state.BackupOwner != UInt160.Zero, "No backup owner");
            ExecutionEngine.Assert(Runtime.CheckWitness(state.BackupOwner!), "Unauthorized");
        }
    }
}
