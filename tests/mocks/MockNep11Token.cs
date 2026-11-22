using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Test-only non-divisible NEP-11 token: one owner per token id, the canonical three-argument
    /// <c>transfer(to, tokenId, data)</c> and the NEP-11 payment callback for contract recipients.
    /// </summary>
    /// <remarks>
    /// The three-argument transfer is the shape that must never be read as a NEP-17 payload
    /// (Mark finding #7): its second argument is a token id, not an address. <c>balanceOf(owner)</c>
    /// returns the number of tokens held, which is the balance the daily-limit hook observes when
    /// the NFT itself is a configured token.
    /// </remarks>
    [DisplayName("MockNep11Token")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only non-divisible NEP-11 token")]
    public class MockNep11Token : SmartContract
    {
        private static StorageMap Owners => new(Storage.CurrentContext, 1);
        private static StorageMap Balances => new(Storage.CurrentContext, 2);

        private static readonly byte[] Prefix_Admin = new byte[] { 0xF0 };
        private static readonly byte[] Prefix_TrustedCaller = new byte[] { 0xF2 };
        private static readonly byte[] Prefix_PaymentReceiver = new byte[] { 0xF3 };

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, Prefix_Admin, Runtime.Transaction.Sender);
        }

        // ---- NEP-11 surface ----

        [Safe]
        public static string Symbol() => "MN11";

        [Safe]
        public static BigInteger Decimals() => 0;

        [Safe]
        public static BigInteger TotalSupply() => 0;

        [Safe]
        public static UInt160 OwnerOf(ByteString tokenId)
        {
            ByteString? owner = Owners.Get(tokenId);
            return owner == null ? UInt160.Zero : (UInt160)owner;
        }

        [Safe]
        public static BigInteger BalanceOf(UInt160 owner)
        {
            ByteString? value = Balances.Get(owner);
            return value == null ? 0 : (BigInteger)value;
        }

        public static bool Transfer(UInt160 to, ByteString tokenId, object data)
        {
            ExecutionEngine.Assert(to != null && to.IsValid && to != UInt160.Zero, "Invalid mock recipient");
            ExecutionEngine.Assert(tokenId != null && tokenId.Length > 0, "Invalid mock token id");

            UInt160 from = OwnerOf(tokenId);
            ExecutionEngine.Assert(from != UInt160.Zero, "Unknown mock token id");
            ExecutionEngine.Assert(
                Runtime.CheckWitness(from) || Runtime.CallingScriptHash == TrustedCaller(),
                "Mock owner witness required");

            Owners.Put(tokenId, to);
            Balances.Put(from, BalanceOf(from) - 1);
            Balances.Put(to, BalanceOf(to) + 1);
            NotifyPayment(from, to, tokenId, data);
            return true;
        }

        // ---- Test configuration (admin = deployer) ----

        public static void Mint(UInt160 to, ByteString tokenId)
        {
            RequireAdmin();
            ExecutionEngine.Assert(to != null && to.IsValid && to != UInt160.Zero, "Invalid mock recipient");
            ExecutionEngine.Assert(tokenId != null && tokenId.Length > 0, "Invalid mock token id");
            ExecutionEngine.Assert(OwnerOf(tokenId) == UInt160.Zero, "Mock token id already minted");
            Owners.Put(tokenId, to);
            Balances.Put(to, BalanceOf(to) + 1);
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

        private static UInt160 TrustedCaller()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_TrustedCaller);
            return value == null ? UInt160.Zero : (UInt160)value;
        }

        /// <summary>NEP-11 tells a contract recipient about the token it received.</summary>
        private static void NotifyPayment(UInt160 from, UInt160 to, ByteString tokenId, object data)
        {
            ByteString? configured = Storage.Get(Storage.CurrentContext, Prefix_PaymentReceiver);
            if (configured == null || (UInt160)configured! != to) return;
            Contract.Call(to, "onNEP11Payment", CallFlags.All,
                new object[] { from, (BigInteger)1, tokenId, data });
        }

        private static void RequireAdmin()
        {
            ByteString? admin = Storage.Get(Storage.CurrentContext, Prefix_Admin);
            ExecutionEngine.Assert(admin != null && (UInt160)admin! != UInt160.Zero, "Mock admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness((UInt160)admin!), "Mock admin required");
        }
    }
}
