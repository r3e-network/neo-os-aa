using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Test-only divisible NEP-11 token: per-(owner, tokenId) balances, the canonical five-argument
    /// <c>transfer(from, to, amount, tokenId, data)</c> and the NEP-11 payment callback carrying the
    /// transferred amount.
    /// </summary>
    /// <remarks>
    /// A divisible NEP-11 transfer is neither a NEP-17 payload nor the non-divisible three-argument
    /// form, so it must reach the account as an ordinary foreign-ABI operation. Its own balance
    /// view is the standard two-argument <c>balanceOf(owner, tokenId)</c>.
    /// </remarks>
    [DisplayName("MockDivisibleNep11Token")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only divisible NEP-11 token")]
    public class MockDivisibleNep11Token : SmartContract
    {
        private static StorageMap Balances => new(Storage.CurrentContext, 1);
        private static StorageMap Supplies => new(Storage.CurrentContext, 2);

        private static readonly byte[] Prefix_Admin = new byte[] { 0xF0 };
        private static readonly byte[] Prefix_TrustedCaller = new byte[] { 0xF2 };
        private static readonly byte[] Prefix_PaymentReceiver = new byte[] { 0xF3 };

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, Prefix_Admin, Runtime.Transaction.Sender);
        }

        // ---- NEP-11 (divisible) surface ----

        [Safe]
        public static string Symbol() => "MD11";

        [Safe]
        public static BigInteger Decimals() => 0;

        [Safe]
        public static BigInteger TotalSupply() => 0;

        [Safe]
        public static BigInteger BalanceOf(UInt160 owner, ByteString tokenId)
        {
            ByteString? value = Balances.Get(HolderKey(owner, tokenId));
            return value == null ? 0 : (BigInteger)value;
        }

        [Safe]
        public static BigInteger OwnerOf(ByteString tokenId)
        {
            ByteString? value = Supplies.Get(tokenId);
            return value == null ? 0 : (BigInteger)value;
        }

        public static bool Transfer(UInt160 from, UInt160 to, BigInteger amount, ByteString tokenId, object data)
        {
            ExecutionEngine.Assert(from != null && from.IsValid && from != UInt160.Zero, "Invalid mock source");
            ExecutionEngine.Assert(to != null && to.IsValid && to != UInt160.Zero, "Invalid mock recipient");
            ExecutionEngine.Assert(tokenId != null && tokenId.Length > 0, "Invalid mock token id");
            ExecutionEngine.Assert(amount >= 0, "Negative mock amount");
            ExecutionEngine.Assert(
                Runtime.CheckWitness(from) || Runtime.CallingScriptHash == TrustedCaller(),
                "Mock source witness required");

            BigInteger before = BalanceOf(from, tokenId);
            ExecutionEngine.Assert(before >= amount, "Insufficient mock balance");
            Balances.Put(HolderKey(from, tokenId), before - amount);
            Balances.Put(HolderKey(to, tokenId), BalanceOf(to, tokenId) + amount);
            NotifyPayment(from, to, amount, tokenId, data);
            return true;
        }

        // ---- Test configuration (admin = deployer) ----

        public static void Mint(UInt160 to, ByteString tokenId, BigInteger amount)
        {
            RequireAdmin();
            ExecutionEngine.Assert(to != null && to.IsValid && to != UInt160.Zero, "Invalid mock recipient");
            ExecutionEngine.Assert(tokenId != null && tokenId.Length > 0, "Invalid mock token id");
            ExecutionEngine.Assert(amount > 0, "Negative mock amount");
            Balances.Put(HolderKey(to, tokenId), BalanceOf(to, tokenId) + amount);
            Supplies.Put(tokenId, OwnerOf(tokenId) + amount);
        }

        public static void SetTrustedCaller(UInt160 caller)
        {
            RequireAdmin();
            ExecutionEngine.Assert(caller != null && caller.IsValid && caller != UInt160.Zero, "Invalid mock caller");
            Storage.Put(Storage.CurrentContext, Prefix_TrustedCaller, caller);
        }

        public static void SetPaymentReceiver(UInt160 receiver)
        {
            RequireAdmin();
            ExecutionEngine.Assert(receiver != null && receiver.IsValid && receiver != UInt160.Zero, "Invalid mock receiver");
            Storage.Put(Storage.CurrentContext, Prefix_PaymentReceiver, receiver);
        }

        // ---- Internals ----

        private static byte[] HolderKey(UInt160 owner, ByteString tokenId) =>
            Helper.Concat((byte[])owner, (byte[])tokenId);

        private static UInt160 TrustedCaller()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_TrustedCaller);
            return value == null ? UInt160.Zero : (UInt160)value;
        }

        /// <summary>NEP-11 tells a contract recipient about the amount it received.</summary>
        private static void NotifyPayment(UInt160 from, UInt160 to, BigInteger amount, ByteString tokenId, object data)
        {
            ByteString? configured = Storage.Get(Storage.CurrentContext, Prefix_PaymentReceiver);
            if (configured == null || (UInt160)configured! != to) return;
            Contract.Call(to, "onNEP11Payment", CallFlags.All, new object[] { from, amount, tokenId, data });
        }

        private static void RequireAdmin()
        {
            ByteString? admin = Storage.Get(Storage.CurrentContext, Prefix_Admin);
            ExecutionEngine.Assert(admin != null && (UInt160)admin! != UInt160.Zero, "Mock admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness((UInt160)admin!), "Mock admin required");
        }
    }
}
