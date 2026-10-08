using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount.Tests.Fixtures
{
    // Deliberately violates NEP-17 success semantics. Private diagnostics only.
    [DisplayName("DailyOutflowToken")]
    [ContractPermission("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer")]
    [ManifestExtra("TestOnly", "Adversarial daily-limit outflow diagnostic")]
    public class DailyOutflowToken : SmartContract
    {
        private static StorageMap Balances => new(Storage.CurrentContext, 1);
        private static StorageMap BalanceModes => new(Storage.CurrentContext, 2);
        private static readonly byte[] AdminKey = new byte[] { 0xF0 };

        public static void _deploy(object data, bool update)
        {
            ExecutionEngine.Assert(!update, "Diagnostic upgrades forbidden");
            UInt160 owner = (UInt160)data;
            ExecutionEngine.Assert(owner.IsValid && owner != UInt160.Zero, "Invalid diagnostic owner");
            Storage.Put(Storage.CurrentContext, AdminKey, Runtime.Transaction.Sender);
            Balances.Put(owner, 1000);
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
            ByteString? data = BalanceModes.Get(account);
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

        public static void SetBalanceMode(UInt160 account, BigInteger mode)
        {
            UInt160 admin = (UInt160)Storage.Get(Storage.CurrentContext, AdminKey)!;
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "Diagnostic admin required");
            ValidateMode(mode);
            BalanceModes.Put(account, mode);
        }

        private static void ValidateMode(BigInteger mode)
        {
            ExecutionEngine.Assert(mode >= 0 && mode <= 7, "Invalid diagnostic balance mode");
        }

        public static bool MoveThenFalse(UInt160 from, UInt160 to, BigInteger amount)
        {
            ExecutionEngine.Assert(from != to && to.IsValid && to != UInt160.Zero, "Invalid recipient");
            ExecutionEngine.Assert(amount > 0 && Runtime.CheckWitness(from), "Source witness required");
            BigInteger before = StoredBalanceOf(from);
            ExecutionEngine.Assert(before >= amount, "Insufficient diagnostic balance");
            Balances.Put(from, before - amount);
            Balances.Put(to, StoredBalanceOf(to) + amount);
            return false;
        }

        public static bool MoveAndSpoof(UInt160 from, UInt160 to, BigInteger amount, BigInteger mode)
        {
            ValidateMode(mode);
            MoveThenFalse(from, to, amount);
            BalanceModes.Put(from, mode);
            return false;
        }

        public static bool ForwardGas(UInt160 from, UInt160 to, BigInteger amount)
        {
            ExecutionEngine.Assert(GAS.Transfer(from, to, amount, null), "Nested GAS transfer failed");
            return false;
        }
    }
}
