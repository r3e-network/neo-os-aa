using System.Numerics;
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
        private const string AccountImplementationId = "org.r3e.neo.aa.unified-smart-wallet.v3";
        private static readonly byte[] ERC1271_MAGIC_VALUE = new byte[] { 0x16, 0x26, 0xBA, 0x7E };
        private static readonly byte[] ERC1271_INVALID_VALUE = new byte[] { 0xFF, 0xFF, 0xFF, 0xFF };

        private static AccountState GetAccountState(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "Account not found");
            return (AccountState)StdLib.Deserialize(data!);
        }

        [Safe]
        public static string GetAccountImplementationId()
        {
            return AccountImplementationId;
        }

        [Safe]
        public static bool SupportsExecutionMode(string mode)
        {
            return mode == "single" || mode == "batch" || mode == "batch-atomic";
        }

        [Safe]
        public static bool SupportsModuleType(string moduleType)
        {
            return moduleType == "validator" || moduleType == "verifier" || moduleType == "hook";
        }

        [Safe]
        public static bool IsModuleInstalled(UInt160 accountId, string moduleType, UInt160 moduleHash)
        {
            if (moduleHash == null || moduleHash == UInt160.Zero) return false;

            AccountState state = GetAccountState(accountId);
            if (moduleType == "validator" || moduleType == "verifier")
            {
                return state.Verifier == moduleHash;
            }

            if (moduleType == "hook")
            {
                return state.HookId == moduleHash;
            }

            return false;
        }

        [Safe]
        public static ByteString IsValidSignature(UInt160 accountId, ByteString hash, ByteString signature)
        {
            ExecutionEngine.Assert(hash != null && hash.Length == 32, "Invalid message hash");
            ExecutionEngine.Assert(
                signature != null && (signature.Length == 64 || signature.Length == 65),
                "Invalid message signature");
            AccountState state = GetAccountState(accountId);
            if (state.Verifier == UInt160.Zero) return (ByteString)ERC1271_INVALID_VALUE;
            bool supported = (bool)Contract.Call(
                state.Verifier, "supportsMessageSignatures", CallFlags.ReadOnly, new object[] { });
            if (!supported) return (ByteString)ERC1271_INVALID_VALUE;
            bool valid = (bool)Contract.Call(
                state.Verifier, "isValidSignature", CallFlags.ReadOnly,
                new object[] { accountId, hash!, signature! });
            return valid ? (ByteString)ERC1271_MAGIC_VALUE : (ByteString)ERC1271_INVALID_VALUE;
        }

        [Safe]
        public static UInt160 GetVerifier(UInt160 accountId)
        {
            return GetAccountState(accountId).Verifier;
        }

        [Safe]
        public static UInt160 GetHook(UInt160 accountId)
        {
            return GetAccountState(accountId).HookId;
        }

        [Safe]
        public static UInt160 GetBackupOwner(UInt160 accountId)
        {
            return GetAccountState(accountId).BackupOwner;
        }

        [Safe]
        public static uint GetEscapeTimelock(UInt160 accountId)
        {
            return GetAccountState(accountId).EscapeTimelock;
        }

        [Safe]
        public static BigInteger GetEscapeTriggeredAt(UInt160 accountId)
        {
            return GetAccountState(accountId).EscapeTriggeredAt;
        }

        [Safe]
        public static UInt160 GetMarketEscrowContract(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_MarketEscrowContract, (byte[])accountId);
            ByteString? market = Storage.Get(Storage.CurrentContext, key);
            return market == null ? UInt160.Zero : (UInt160)market;
        }

        [Safe]
        public static BigInteger GetMarketEscrowListingId(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_MarketEscrowListing, (byte[])accountId);
            ByteString? listing = Storage.Get(Storage.CurrentContext, key);
            return listing == null ? 0 : (BigInteger)listing;
        }

        [Safe]
        public static bool IsMarketEscrowActive(UInt160 accountId)
        {
            return GetMarketEscrowContract(accountId) != UInt160.Zero && GetMarketEscrowListingId(accountId) > 0;
        }

        [Safe]
        public static bool IsEscapeActive(UInt160 accountId)
        {
            return GetAccountState(accountId).EscapeTriggeredAt > 0;
        }

        [Safe]
        public static BigInteger GetNonce(UInt160 accountId, BigInteger channel)
        {
            byte[] key = Helper.Concat(Prefix_Nonce, (byte[])accountId);
            key = Helper.Concat(key, channel.ToByteArray());

            ByteString? currentData = Storage.Get(Storage.CurrentContext, key);
            return currentData == null ? 0 : (BigInteger)currentData;
        }

        [Safe]
        public static ByteString ComputeArgsHash(object[] args)
        {
            ByteString serialized = (ByteString)StdLib.Serialize(args);
            return (ByteString)Contract.Call(
                Neo.SmartContract.Framework.Native.CryptoLib.Hash,
                "keccak256",
                CallFlags.ReadOnly,
                new object[] { serialized });
        }

        [Safe]
        public static bool HasPendingVerifierUpdate(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_PendingVerifierUpdate, (byte[])accountId);
            return Storage.Get(Storage.CurrentContext, key) != null;
        }

        [Safe]
        public static bool HasPendingHookUpdate(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_PendingHookUpdate, (byte[])accountId);
            return Storage.Get(Storage.CurrentContext, key) != null;
        }

        [Safe]
        public static BigInteger GetPendingVerifierUpdateTime(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_PendingVerifierUpdate, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return 0;
            PendingConfigUpdate pending = (PendingConfigUpdate)StdLib.Deserialize(data!);
            return pending.InitiatedAt + ConfigUpdateTimelockMs;
        }

        [Safe]
        public static BigInteger GetPendingHookUpdateTime(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_PendingHookUpdate, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return 0;
            PendingConfigUpdate pending = (PendingConfigUpdate)StdLib.Deserialize(data!);
            return pending.InitiatedAt + ConfigUpdateTimelockMs;
        }

        private static PendingModuleCall? GetPendingModuleCallRecord(byte[] prefix, UInt160 accountId)
        {
            byte[] key = Helper.Concat(prefix, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return null;
            return (PendingModuleCall)StdLib.Deserialize(data!);
        }

        [Safe]
        public static bool HasPendingVerifierCall(UInt160 accountId)
        {
            return GetPendingModuleCallRecord(Prefix_PendingVerifierCall, accountId) != null;
        }

        [Safe]
        public static bool HasPendingHookCall(UInt160 accountId)
        {
            return GetPendingModuleCallRecord(Prefix_PendingHookCall, accountId) != null;
        }

        [Safe]
        public static UInt160 GetPendingVerifierCallModule(UInt160 accountId)
        {
            PendingModuleCall? pending = GetPendingModuleCallRecord(Prefix_PendingVerifierCall, accountId);
            return pending == null ? UInt160.Zero : pending.ModuleHash;
        }

        [Safe]
        public static UInt160 GetPendingHookCallModule(UInt160 accountId)
        {
            PendingModuleCall? pending = GetPendingModuleCallRecord(Prefix_PendingHookCall, accountId);
            return pending == null ? UInt160.Zero : pending.ModuleHash;
        }

        [Safe]
        public static ByteString GetPendingVerifierCallHash(UInt160 accountId)
        {
            PendingModuleCall? pending = GetPendingModuleCallRecord(Prefix_PendingVerifierCall, accountId);
            return pending == null ? (ByteString)new byte[0] : pending.CallHash;
        }

        [Safe]
        public static ByteString GetPendingHookCallHash(UInt160 accountId)
        {
            PendingModuleCall? pending = GetPendingModuleCallRecord(Prefix_PendingHookCall, accountId);
            return pending == null ? (ByteString)new byte[0] : pending.CallHash;
        }

        [Safe]
        public static BigInteger GetPendingVerifierCallTime(UInt160 accountId)
        {
            PendingModuleCall? pending = GetPendingModuleCallRecord(Prefix_PendingVerifierCall, accountId);
            return pending == null ? 0 : pending.InitiatedAt + ConfigUpdateTimelockMs;
        }

        [Safe]
        public static BigInteger GetPendingHookCallTime(UInt160 accountId)
        {
            PendingModuleCall? pending = GetPendingModuleCallRecord(Prefix_PendingHookCall, accountId);
            return pending == null ? 0 : pending.InitiatedAt + ConfigUpdateTimelockMs;
        }

        /// <summary>
        /// Cancels a pending verifier update.
        /// </summary>
        public static void CancelVerifierUpdate(UInt160 accountId)
        {
            AssertBackupOwner(accountId);
            byte[] key = Helper.Concat(Prefix_PendingVerifierUpdate, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            Storage.Delete(Storage.CurrentContext, key);
            if (data != null)
            {
                PendingConfigUpdate pending = (PendingConfigUpdate)StdLib.Deserialize(data!);
                OnModuleUpdateCancelled(accountId, ModuleTypeVerifier, pending.NewVerifier);
            }
            OnVerifierUpdateCancelled(accountId);
        }

        /// <summary>
        /// Cancels a pending hook update.
        /// </summary>
        public static void CancelHookUpdate(UInt160 accountId)
        {
            AssertBackupOwner(accountId);
            byte[] key = Helper.Concat(Prefix_PendingHookUpdate, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            Storage.Delete(Storage.CurrentContext, key);
            if (data != null)
            {
                PendingConfigUpdate pending = (PendingConfigUpdate)StdLib.Deserialize(data!);
                OnModuleUpdateCancelled(accountId, ModuleTypeHook, pending.NewHookId);
            }
            OnHookUpdateCancelled(accountId);
        }

        /// <summary>
        /// Sets the off-chain metadata URI for an account. Deletes the key if cleared.
        /// </summary>
        public static void SetMetadataUri(UInt160 accountId, string metadataUri)
        {
            AssertBackupOwner(accountId);
            byte[] key = Helper.Concat(Prefix_MetadataUri, (byte[])accountId);
            if (metadataUri == null || metadataUri.Length == 0)
            {
                Storage.Delete(Storage.CurrentContext, key);
                return;
            }

            ExecutionEngine.Assert(metadataUri.Length <= MaxMetadataUriLength, "MetadataUri too long");
            Storage.Put(Storage.CurrentContext, key, metadataUri);
            OnMetadataUriUpdated(accountId, metadataUri);
        }

        /// <summary>
        /// Returns the off-chain metadata URI for an account, or empty string if unset.
        /// </summary>
        [Safe]
        public static string GetMetadataUri(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_MetadataUri, (byte[])accountId);
            ByteString? uri = Storage.Get(Storage.CurrentContext, key);
            return uri == null ? string.Empty : (string)uri;
        }
    }
}
