using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Services;
using AbstractAccount.Verifiers;

namespace AbstractAccount
{
    internal static class NativeOperation
    {
        internal static UserOperation Decode(object[] fields)
        {
            ExecutionEngine.Assert(fields.Length == 6, "Invalid native operation shape");
            return new UserOperation
            {
                TargetContract = (UInt160)fields[0],
                Method = (string)fields[1],
                Args = (object[])fields[2],
                Nonce = (BigInteger)fields[3],
                Deadline = (BigInteger)fields[4],
                Signature = (ByteString)fields[5]
            };
        }
    }
}
