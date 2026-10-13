using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount.Tests.Fixtures
{
    [DisplayName("RestrictedOutflowRouter")]
    [ContractPermission("*", "moveFromRouter")]
    [ManifestExtra("TestOnly", "Explicitly delegated diagnostic token router")]
    public class RestrictedOutflowRouter : SmartContract
    {
        private static readonly byte[] TokenKey = new byte[] { 0xF0 };

        public static void _deploy(object data, bool update)
        {
            ExecutionEngine.Assert(!update, "Diagnostic upgrades forbidden");
            UInt160 token = (UInt160)data;
            ExecutionEngine.Assert(token.IsValid && token != UInt160.Zero, "Invalid diagnostic token");
            Storage.Put(Storage.CurrentContext, TokenKey, token);
        }

        public static bool Move(UInt160 from, UInt160 to, BigInteger amount, BigInteger mode, bool result)
        {
            UInt160 token = (UInt160)Storage.Get(Storage.CurrentContext, TokenKey)!;
            Contract.Call(token, "moveFromRouter", CallFlags.All, new object[] { from, to, amount, mode });
            return result;
        }
    }
}
