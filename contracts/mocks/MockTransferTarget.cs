using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Mocks
{
    /// <summary>
    /// Minimal mock target used by validation suites for transfer-like calls.
    /// </summary>
    /// <remarks>
    /// This contract is not meant for production value storage. It gives plugin and AA tests a
    /// stable target that exposes <c>symbol</c>, <c>balanceOf</c>, and <c>transfer</c> without
    /// depending on external token balances or live third-party contracts.
    /// </remarks>
    [DisplayName("MockTransferTarget")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Minimal transfer-capable test target for AA V3 validation")]
    public class MockTransferTarget : SmartContract
    {
        private static readonly byte[] Prefix_Admin = new byte[] { 0xF0 };
        private static readonly byte[] Prefix_BurnGas = new byte[] { 0xF1 };
        private static readonly byte[] Prefix_BurnPostGas = new byte[] { 0xF2 };
        private static readonly byte[] Prefix_BurnClearGas = new byte[] { 0xF3 };

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, Prefix_Admin, Runtime.Transaction.Sender);
        }

        [Safe]
        public static UInt160 Admin()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Prefix_Admin);
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        public static void Update(ByteString nef, string manifest)
        {
            ValidateAdmin();
            ContractManagement.Update(nef, manifest);
        }

        // Test-only hook surface. The target doubles as a burning application
        // callback so the AA runtime can verify the independent hook budget
        // without introducing another deployable artifact.
        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsComposition() => false;

        public static void PreExecute(UInt160 accountId, object[] opParams) => BurnIfEnabled(Prefix_BurnGas);

        public static void PostExecute(UInt160 accountId, object[] opParams, object result) => BurnIfEnabled(Prefix_BurnPostGas);

        public static void ClearAccount(UInt160 accountId)
        {
            BurnIfEnabled(Prefix_BurnClearGas);
        }

        public static void SetBurnGas(bool enabled)
        {
            ValidateAdmin();
            Storage.Put(Storage.CurrentContext, Prefix_BurnGas,
                (ByteString)new byte[] { enabled ? (byte)1 : (byte)0 });
        }

        public static void SetBurnPostGas(bool enabled)
        {
            ValidateAdmin();
            Storage.Put(Storage.CurrentContext, Prefix_BurnPostGas,
                (ByteString)new byte[] { enabled ? (byte)1 : (byte)0 });
        }

        public static void SetBurnClearGas(bool enabled)
        {
            ValidateAdmin();
            Storage.Put(Storage.CurrentContext, Prefix_BurnClearGas,
                (ByteString)new byte[] { enabled ? (byte)1 : (byte)0 });
        }

        [Safe]
        public static string Symbol()
        {
            return "MOCK";
        }

        [Safe]
        public static BigInteger BalanceOf(UInt160 account)
        {
            return 0;
        }

        public static bool Transfer(UInt160 from, UInt160 to, BigInteger amount, object data)
        {
            ExecutionEngine.Assert(from != null && from != UInt160.Zero, "from required");
            ExecutionEngine.Assert(to != null && to != UInt160.Zero, "to required");
            ExecutionEngine.Assert(amount >= 0, "amount must be non-negative");
            return true;
        }

        private static void BurnIfEnabled(byte[] prefix)
        {
            ByteString? enabled = Storage.Get(Storage.CurrentContext, prefix);
            if (enabled == null || enabled.Length == 0 || enabled[0] != 1) return;

            ByteString digest = (ByteString)new byte[] { 0x01, 0x02, 0x03, 0x04 };
            for (int i = 0; i < 2_000_000; i++)
                digest = CryptoLib.Sha256(digest);
            ExecutionEngine.Assert(digest.Length > 0, "unreachable");
        }

        private static void ValidateAdmin()
        {
            UInt160 admin = Admin();
            ExecutionEngine.Assert(admin != UInt160.Zero && admin.IsValid, "Admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "Unauthorized admin");
        }
    }
}
