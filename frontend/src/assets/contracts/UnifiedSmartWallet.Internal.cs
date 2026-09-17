using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
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

        private static readonly BigInteger MaxMetadataUriLength = 240;

        private static readonly BigInteger EscapeCooldownMs = 60L * 60 * 1000;
        private static readonly BigInteger ConfigUpdateTimelockMs = 24L * 60 * 60 * 1000;

        private static void SetVerifyContext(UInt160 accountId, UInt160 targetContract)
        {
            byte[] key = Helper.Concat(Prefix_VerifyContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])targetContract);
        }

        private static void ClearVerifyContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_VerifyContext, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, key);
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
        }

        private static void ClearExecutionLock(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_ExecutionLock, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, key);
        }

        private static void SetVerifierConfigContext(UInt160 accountId, UInt160 verifierContract)
        {
            byte[] key = Helper.Concat(Prefix_VerifierConfigContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])verifierContract);
        }

        private static void ClearVerifierConfigContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_VerifierConfigContext, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, key);
        }

        private static void SetHookConfigContext(UInt160 accountId, UInt160 hookContract)
        {
            byte[] key = Helper.Concat(Prefix_HookConfigContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])hookContract);
        }

        private static void ClearHookConfigContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_HookConfigContext, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, key);
        }

        private static void SetHookExecutionContext(UInt160 accountId, UInt160 hookContract)
        {
            byte[] key = Helper.Concat(Prefix_HookExecutionContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])hookContract);
        }

        private static void ClearHookExecutionContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_HookExecutionContext, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, key);
        }

        private static void SetVerifierExecutionContext(UInt160 accountId, UInt160 verifierContract)
        {
            byte[] key = Helper.Concat(Prefix_VerifierExecutionContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])verifierContract);
        }

        private static void ClearVerifierExecutionContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_VerifierExecutionContext, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, key);
        }

        private static void AssertBackupOwner(UInt160 accountId)
        {
            AccountState state = GetAccountState(accountId);
            ExecutionEngine.Assert(state.BackupOwner != null && state.BackupOwner != UInt160.Zero, "No backup owner");
            ExecutionEngine.Assert(Runtime.CheckWitness(state.BackupOwner!), "Unauthorized");
        }
    }
}
