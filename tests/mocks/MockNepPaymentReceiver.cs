using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Test-only payment receiver: records the NEP-17 and NEP-11 payment callbacks a token makes
    /// when an account pays a contract, so a suite can prove the callback fired with the exact
    /// payer, amount and token id of the transfer it accompanied.
    /// </summary>
    [DisplayName("MockNepPaymentReceiver")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only NEP-17/NEP-11 payment callback recorder")]
    public class MockNepPaymentReceiver : SmartContract
    {
        private static readonly byte[] Prefix_Calls = new byte[] { 0x01 };
        private static readonly byte[] Prefix_Kind = new byte[] { 0x02 };
        private static readonly byte[] Prefix_From = new byte[] { 0x03 };
        private static readonly byte[] Prefix_Amount = new byte[] { 0x04 };
        private static readonly byte[] Prefix_TokenId = new byte[] { 0x05 };

        public static void OnNEP17Payment(UInt160 from, BigInteger amount, object data) =>
            Record("nep17", from, amount, (ByteString)new byte[0]);

        public static void OnNEP11Payment(UInt160 from, BigInteger amount, ByteString tokenId, object data) =>
            Record("nep11", from, amount, tokenId);

        [Safe]
        public static BigInteger Calls()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_Calls);
            return value == null ? 0 : (BigInteger)value;
        }

        [Safe]
        public static string LastKind()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_Kind);
            return value == null ? string.Empty : (string)value;
        }

        [Safe]
        public static UInt160 LastFrom()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_From);
            return value == null ? UInt160.Zero : (UInt160)value;
        }

        [Safe]
        public static BigInteger LastAmount()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_Amount);
            return value == null ? 0 : (BigInteger)value;
        }

        [Safe]
        public static ByteString LastTokenId()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_TokenId);
            return value == null ? (ByteString)new byte[0] : value;
        }

        private static void Record(string kind, UInt160 from, BigInteger amount, ByteString tokenId)
        {
            ExecutionEngine.Assert(from != null && from.IsValid, "Invalid mock payer");
            ExecutionEngine.Assert(amount >= 0, "Negative mock amount");
            Storage.Put(Storage.CurrentContext, Prefix_Calls, Calls() + 1);
            Storage.Put(Storage.CurrentContext, Prefix_Kind, kind);
            Storage.Put(Storage.CurrentContext, Prefix_From, from);
            Storage.Put(Storage.CurrentContext, Prefix_Amount, amount);
            Storage.Put(Storage.CurrentContext, Prefix_TokenId, tokenId);
        }
    }
}
