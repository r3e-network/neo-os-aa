using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Test-only stateful adversarial token: <c>transfer</c> accepts a data array that
    /// lets a test debit a different amount than it declares and return an arbitrary
    /// value, so policy hooks can be probed against NEP-17 violations.
    /// </summary>
    /// <remarks>
    /// Protocol v4 drives hook and validator callbacks from the account core
    /// (preCheck/postCheck in the core-owned hookOrder, validateUserOp/
    /// onUserOpComplete in the validation phase), so this mock no longer carries a
    /// <c>forward</c>-style callback driver: tests exercise callbacks through the real
    /// core instead of a stub relay.
    /// </remarks>
    [DisplayName("PolicyExecutionProbe")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only adversarial token for policy semantics")]
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
    }
}
