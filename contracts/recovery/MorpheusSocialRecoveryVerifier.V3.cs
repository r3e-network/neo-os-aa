using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
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

        /// <summary>
        /// Mandatory V3 lifecycle cleanup. The AA core calls this before it rotates the account
        /// away from this verifier (<c>confirmVerifierUpdate</c>), completes a backup-owner escape
        /// (<c>finalizeEscape</c>) or hands the shell to a market buyer (<c>settleMarketEscrow</c>).
        /// A verifier without this method faults every one of those transitions uncatchably, so
        /// an account bound to it could never leave it. Every account-scoped recovery record is
        /// removed and any GAS still earmarked for the account's Morpheus oracle is refunded to
        /// the recovery owner rather than orphaned. The consumed action-nullifier markers are
        /// deliberately retained: they are replay protection, and a later re-setup with the same
        /// Morpheus identity must not be able to accept a ticket that already executed.
        /// The call is idempotent for an account that never completed <c>setupRecovery</c>.
        /// </summary>
        public static void ClearAccount(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            AssertV3ConfigCaller(accountId);

            UInt160 previousOwner = GetOwner(accountId);
            BigInteger refundedCredit = 0;
            byte[] creditKey = Key(PREFIX_ORACLE_CREDIT, accountId);
            ByteString? creditData = Storage.Get(Storage.CurrentContext, creditKey);
            if (creditData != null)
            {
                refundedCredit = (BigInteger)creditData;
                Storage.Delete(Storage.CurrentContext, creditKey);
                if (refundedCredit > 0)
                {
                    ExecutionEngine.Assert(previousOwner != UInt160.Zero, "Oracle credit without recovery owner");
                    ExecutionEngine.Assert(
                        GAS.Transfer(Runtime.ExecutingScriptHash, previousOwner, refundedCredit, null),
                        "Oracle credit refund failed");
                }
            }

            Storage.Delete(Storage.CurrentContext, Key(PREFIX_OWNER, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_AA_CONTRACT, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_ACCOUNT_ADDRESS, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_MORPHEUS_ORACLE, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_NETWORK, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_ACCOUNT_ID_TEXT, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_FACTORS, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_THRESHOLD, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_TIMELOCK, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_MORPHEUS_VERIFIER, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_RECOVERY_NONCE, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_SESSION_NONCE, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_ACTIVE_SESSION, accountId));
            DeletePendingRecovery(accountId);
            DeleteAccountPrefixFamily(Key(PREFIX_APPROVAL, accountId));

            OnRecoveryCleared(accountId, previousOwner, refundedCredit);
        }

        private static void DeleteAccountPrefixFamily(byte[] prefix)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }

        /// <summary>
        /// Configuration-phase gate, mirroring <c>VerifierAuthority.ValidateConfigCaller</c>: the
        /// caller must be the pinned AA core and that core must currently hold this verifier in
        /// its per-account configuration context (<c>canConfigureVerifier</c>).
        /// </summary>
        private static void AssertV3ConfigCaller(UInt160 accountId)
        {
            UInt160 core = AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "Authorized AA core not configured");
            ExecutionEngine.Assert(Runtime.CallingScriptHash == core, "Unauthorized AA core caller");

            bool authorized = (bool)Contract.Call(
                core,
                "canConfigureVerifier",
                CallFlags.ReadOnly,
                new object[] { accountId, Runtime.ExecutingScriptHash });
            ExecutionEngine.Assert(authorized, "Unauthorized verifier configuration context");
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
