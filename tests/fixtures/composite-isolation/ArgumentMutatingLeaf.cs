using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount.Tests.Fixtures
{
    // Disposable private-chain fixture. Never enroll this policy in a real account.
    [DisplayName("ArgumentMutatingLeaf")]
    [ManifestExtra("SmartAccountProfile", "native-v1")]
    [ManifestExtra("TestOnly", "Composite argument ownership regression")]
    [ContractPermission("0xd9421d07adf206e9dc4be746a02e8e087fa61741", "hasModuleContext")]
    public class ArgumentMutatingLeaf : SmartContract
    {
        [InitialValue("0xd9421d07adf206e9dc4be746a02e8e087fa61741", ContractParameterType.Hash160)]
        private static readonly UInt160 Service = default!;
        private static StorageMap Modes => new(Storage.CurrentContext, 1);

        private static void Require(UInt160 account, string phase) => ExecutionEngine.Assert(
            (bool)Contract.Call(Service, "hasModuleContext", CallFlags.ReadOnly,
                new object[] { account, "verifier", Runtime.ExecutingScriptHash, phase }), "Missing diagnostic module context");

        [Safe] public static bool SupportsV3() => true;
        [Safe] public static bool SupportsComposition() => false;
        [Safe] public static ByteString[] GetSignerDomains(UInt160 account) => new ByteString[]
        {
            (ByteString)new byte[] { 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77,
                0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77,
                0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77,
                0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77 }
        };
        [Safe] public static BigInteger GetMode(UInt160 account) => (BigInteger)Modes.Get(account)!;
        public static void SetMode(UInt160 account, BigInteger mode)
        {
            Require(account, "configuration");
            ExecutionEngine.Assert(mode >= 0 && mode <= 5, "Invalid diagnostic mode");
            Modes.Put(account, mode);
        }
        private static void Mutate(object[] operation, bool nested)
        {
            object[] args = (object[])operation[2];
            if (nested) ((object[])args[3])[0] = (BigInteger)7;
            else args[2] = (BigInteger)1;
        }
        public static bool ValidateSignature(UInt160 account, object[] operation)
        {
            Require(account, "validation");
            BigInteger mode = GetMode(account);
            if (mode == 1 || mode == 4 || mode == 5) Mutate(operation, mode == 5);
            if (mode == 4) throw new System.Exception("Diagnostic rejection after mutation");
            return true;
        }
        [Safe] public static bool ValidateSignatureForPostExecute(UInt160 account, object[] operation)
        {
            Require(account, "postExecute");
            BigInteger mode = GetMode(account);
            if (mode == 1 || mode == 3 || mode == 5) Mutate(operation, mode == 5);
            return true;
        }
        public static void PostExecute(UInt160 account, object[] operation, object result)
        {
            Require(account, "postExecute");
            if (GetMode(account) == 2) Mutate(operation, false);
        }
        public static void ClearAccount(UInt160 account)
        {
            Require(account, "cleanup");
            Modes.Delete(account);
        }
    }
}
