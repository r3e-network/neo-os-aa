using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Mocks
{
    /// <summary>Test-only stateful adversarial token and atomic policy lifecycle driver.</summary>
    [DisplayName("PolicyExecutionProbe")]
    [ContractPermission("*", "*")]
    public class PolicyExecutionProbe : SmartContract
    {
        public static void SetBalance(UInt160 account, BigInteger amount) => Storage.Put(Storage.CurrentContext, account, amount);

        [Safe]
        public static BigInteger BalanceOf(UInt160 account)
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, account);
            return value == null ? 0 : (BigInteger)value;
        }

        // data = [actual debit, return value]. Deliberately violates NEP-17 semantics.
        public static object Transfer(UInt160 from, UInt160 to, BigInteger amount, object[] data)
        {
            return Move(from, (BigInteger)data[0], data[1]);
        }

        public static object Move(UInt160 from, BigInteger debit, object result)
        {
            Storage.Put(Storage.CurrentContext, from, BalanceOf(from) - debit);
            return result;
        }

        public static object ExecuteHook(UInt160 core, UInt160 hook, UInt160 accountId, object[] op)
        {
            Contract.Call(core, "forward", CallFlags.All, hook, "preExecute", new object[] { accountId, op });
            object result = Contract.Call((UInt160)op[0], (string)op[1], CallFlags.All, (object[])op[2]);
            Contract.Call(core, "forward", CallFlags.All, hook, "postExecute", new object[] { accountId, op, result });
            return result;
        }

        public static object ExecuteVerifier(UInt160 core, UInt160 verifier, UInt160 accountId, object[] op)
        {
            ExecutionEngine.Assert((bool)Contract.Call(verifier, "validateSignature", CallFlags.All, accountId, op));
            object result = Contract.Call((UInt160)op[0], (string)op[1], CallFlags.All, (object[])op[2]);
            Contract.Call(core, "forward", CallFlags.All, verifier, "postExecute", new object[] { accountId, op, result });
            return result;
        }
    }
}
