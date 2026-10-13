using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount.Tests.Fixtures
{
    // Private diagnostic only: an explicit router delegation, not a production token.
    [DisplayName("RestrictedOutflowToken")]
    [ManifestExtra("TestOnly", "Restricted-token indirect movement and hostile query diagnostic")]
    public class RestrictedOutflowToken : SmartContract
    {
        private static StorageMap Balances => new(Storage.CurrentContext, 1);
        private static StorageMap Modes => new(Storage.CurrentContext, 2);
        private static readonly byte[] AdminKey = new byte[] { 0xF0 };
        private static readonly byte[] RouterKey = new byte[] { 0xF1 };

        public static void _deploy(object data, bool update)
        {
            ExecutionEngine.Assert(!update, "Diagnostic upgrades forbidden");
            Storage.Put(Storage.CurrentContext, AdminKey, Runtime.Transaction.Sender);
            Seed((UInt160)data);
        }

        private static void Seed(UInt160 account)
        {
            ExecutionEngine.Assert(account.IsValid && account != UInt160.Zero, "Invalid diagnostic account");
            Balances.Put(account, 1000);
            Modes.Put(account, 0);
        }

        private static void RequireAdmin() => ExecutionEngine.Assert(
            Runtime.CheckWitness((UInt160)Storage.Get(Storage.CurrentContext, AdminKey)!), "Diagnostic admin required");

        public static void ConfigureRouter(UInt160 router, UInt160 recipient)
        {
            RequireAdmin();
            ExecutionEngine.Assert(router.IsValid && router != UInt160.Zero, "Invalid diagnostic router");
            ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext, RouterKey) is null, "Router already configured");
            Storage.Put(Storage.CurrentContext, RouterKey, router);
            Seed(recipient);
        }

        private static void ValidateMode(BigInteger mode) => ExecutionEngine.Assert(mode >= 0 && mode <= 7, "Invalid diagnostic balance mode");

        public static void SetBalanceMode(UInt160 account, BigInteger mode)
        {
            RequireAdmin();
            ValidateMode(mode);
            Modes.Put(account, mode);
        }

        [Safe]
        public static BigInteger StoredBalanceOf(UInt160 account)
        {
            ByteString? data = Balances.Get(account);
            return data is null ? 0 : (BigInteger)data;
        }

        [Safe]
        public static object? BalanceOf(UInt160 account)
        {
            ByteString? data = Modes.Get(account);
            BigInteger mode = data is null ? 0 : (BigInteger)data;
            if (mode == 1) return (BigInteger)(-1);
            if (mode == 2) return (ByteString)new byte[] { 1 };
            if (mode == 3) return true;
            if (mode == 4) return null;
            if (mode == 5) return new object[] { BigInteger.Zero };
            if (mode == 6) ExecutionEngine.Assert(false, "Diagnostic balance query failed");
            if (mode == 7) Runtime.BurnGas(300_000_000);
            return StoredBalanceOf(account);
        }

        public static void MoveFromRouter(UInt160 from, UInt160 to, BigInteger amount, BigInteger mode)
        {
            ByteString? router = Storage.Get(Storage.CurrentContext, RouterKey);
            ExecutionEngine.Assert(router != null && Runtime.CallingScriptHash == (UInt160)router!, "Diagnostic router required");
            ValidateMode(mode);
            ExecutionEngine.Assert(from != to && to.IsValid && to != UInt160.Zero && amount >= 0, "Invalid diagnostic movement");
            BigInteger before = StoredBalanceOf(from);
            ExecutionEngine.Assert(before >= amount, "Insufficient diagnostic balance");
            Balances.Put(from, before - amount);
            Balances.Put(to, StoredBalanceOf(to) + amount);
            Modes.Put(from, mode);
        }
    }
}
