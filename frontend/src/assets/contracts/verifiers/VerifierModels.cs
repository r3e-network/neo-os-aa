using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;

namespace AbstractAccount.Verifiers
{
    public class UserOperation
    {
        public UInt160 TargetContract = UInt160.Zero;
        public string Method = string.Empty;
        public object[] Args = new object[0];
        public BigInteger Nonce;
        public BigInteger Deadline;
        public ByteString Signature = (ByteString)new byte[0];
    }
}
