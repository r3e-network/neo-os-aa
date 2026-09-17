using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace Neo.SmartContract.Examples
{
    public partial class SocialRecoveryVerifier
    {
        /// <summary>
        /// ABI-compatible operation shape used by UnifiedSmartWalletV3 verifier plugins.
        /// The recovery verifier authorizes the transaction witness rather than this payload's
        /// signature bytes, but it must still accept the canonical operation structure.
        /// </summary>
        public class UserOperation
        {
            public UInt160 TargetContract = UInt160.Zero;
            public string Method = string.Empty;
            public object[] Args = new object[0];
            public BigInteger Nonce;
            public BigInteger Deadline;
            public ByteString Signature = (ByteString)new byte[0];
        }

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsMessageSignatures() => false;

        /// <summary>
        /// Authorizes an AA operation with either the current recovery owner witness or an
        /// unexpired Morpheus action-session executor witness.
        /// </summary>
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
            AssertV3ExecutionCaller(accountId);
            return VerifyExecution(accountId);
        }

        /// <summary>
        /// Recovery authorization has no post-execution accounting, but the no-op remains
        /// caller-gated so future stateful behavior cannot inherit an unprotected entrypoint.
        /// </summary>
        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
            AssertV3ExecutionCaller(accountId);
        }

        private static void AssertV3ExecutionCaller(UInt160 accountId)
        {
            ExecutionEngine.Assert(accountId != UInt160.Zero && accountId.IsValid, "Invalid account id");

            UInt160 core = AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "Authorized AA core not configured");
            ExecutionEngine.Assert(Runtime.CallingScriptHash == core, "Unauthorized AA core caller");

            bool authorized = (bool)Contract.Call(
                core,
                "canExecuteVerifier",
                CallFlags.ReadOnly,
                new object[] { accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash });
            ExecutionEngine.Assert(authorized, "Unauthorized verifier execution context");
        }
    }
}
