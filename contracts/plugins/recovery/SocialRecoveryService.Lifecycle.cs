using System;
using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace Neo.SmartContract.Examples
{
    public partial class SocialRecoveryService
    {
        // Per-account GAS earmarked for funding that account's Morpheus oracle. Funded via
        // OnNEP17Payment (memo = accountId) and spent only by the account owner through
        // DepositOracleCredits. Prevents draining the shared pool across accounts.
        private const byte PREFIX_ORACLE_CREDIT = 0x19;

        [Safe]
        public static BigInteger GetOracleCredit(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_ORACLE_CREDIT, accountId));
            return data == null ? 0 : (BigInteger)data;
        }

        public static void SubmitRecoveryTicket(
            UInt160 accountId,
            UInt160 newOwner,
            string recoveryNonceText,
            string expiresAtText,
            string actionId,
            ByteString masterNullifier,
            ByteString actionNullifier,
            ByteString verificationSignature)
        {
            ValidateAccountId(accountId, "accountId");
            ValidateAddress(newOwner, "newOwner");
            ValidateShortText(recoveryNonceText, "recoveryNonce");
            ValidateShortText(expiresAtText, "expiresAt");
            ValidateShortText(actionId, "actionId");
            ValidateFixedHash(masterNullifier, "masterNullifier");
            ValidateFixedHash(actionNullifier, "actionNullifier");
            ValidateSignature(verificationSignature);

            SubmitRecoveryTicketInternal(
                accountId,
                newOwner,
                recoveryNonceText,
                expiresAtText,
                actionId,
                masterNullifier,
                actionNullifier,
                verificationSignature);
        }

        public static void SubmitActionTicket(
            UInt160 accountId, UInt160 executor, string actionId, ulong expiresAt,
            ByteString masterNullifier, BigInteger authorizationEpoch,
            ByteString actionNullifier, ByteString verificationSignature)
        {
            ValidateAccountId(accountId, "accountId");
            ExecutionEngine.Assert(Runtime.CheckWitness(executor), "Executor witness required");
            ActivateActionSessionInternal(accountId, executor, actionId, expiresAt,
                actionNullifier, verificationSignature, masterNullifier, authorizationEpoch);
        }

        public static void DepositOracleCredits(UInt160 accountId, BigInteger amount)
        {
            ValidateAccountId(accountId, "accountId");
            UInt160 oracle = GetMorpheusOracle(accountId);
            ExecutionEngine.Assert(oracle != UInt160.Zero, "Morpheus oracle not configured");
            ExecutionEngine.Assert(amount > 0, "invalid amount");

            // Only the account owner may spend that account's earmarked credits, and only up to
            // the balance funded for it. This closes the cross-account pool-drain.
            ExecutionEngine.Assert(Runtime.CheckWitness(GetOwner(accountId)), "Not owner");

            byte[] creditKey = Key(PREFIX_ORACLE_CREDIT, accountId);
            ByteString? creditData = Storage.Get(Storage.CurrentContext, creditKey);
            BigInteger credited = creditData == null ? 0 : (BigInteger)creditData;
            ExecutionEngine.Assert(credited >= amount, "Insufficient oracle credit");

            BigInteger remaining = credited - amount;
            if (remaining == 0)
            {
                Storage.Delete(Storage.CurrentContext, creditKey);
            }
            else
            {
                Storage.Put(Storage.CurrentContext, creditKey, remaining);
            }

            ExecutionEngine.Assert(
                GAS.Transfer(Runtime.ExecutingScriptHash, oracle, amount, null),
                "gas transfer failed");
        }

        public static void OnNEP17Payment(UInt160 from, BigInteger amount, object data)
        {
            ExecutionEngine.Assert(Runtime.CallingScriptHash == GAS.Hash, "only GAS accepted");
            ExecutionEngine.Assert(amount > 0, "invalid amount");

            // The payment must earmark which account it funds (memo = accountId), and that
            // account must already be configured. The GAS is credited to that account only,
            // so it can never be spent on behalf of a different account.
            UInt160 accountId = (UInt160)data;
            ValidateAccountId(accountId, "accountId");
            ExecutionEngine.Assert(
                Storage.Get(Storage.CurrentContext, Key(PREFIX_OWNER, accountId)) != null,
                "Recovery not setup");

            byte[] creditKey = Key(PREFIX_ORACLE_CREDIT, accountId);
            ByteString? creditData = Storage.Get(Storage.CurrentContext, creditKey);
            BigInteger credited = creditData == null ? 0 : (BigInteger)creditData;
            Storage.Put(Storage.CurrentContext, creditKey, credited + amount);
        }

        public static void OnOracleResult(BigInteger requestId, string requestType, bool success, ByteString result, string error)
        {
            if (requestType == "neodid_recovery_ticket")
            {
                OracleRecoveryRequest context = GetOracleRecoveryRequest(requestId);
                ExecutionEngine.Assert(context.AccountId != null && context.AccountId.Length > 0, "Unknown recovery oracle request");
                ExecutionEngine.Assert(Runtime.CallingScriptHash == GetMorpheusOracle(context.AccountId), "Unauthorized oracle");

                DeleteOracleRecoveryRequest(requestId);
                ExecutionEngine.Assert(success, error == null || error == string.Empty ? "Recovery oracle request failed" : error);

                CompactRecoveryTicket ticket = DecodeCompactRecoveryTicket(result);

                SubmitRecoveryTicketInternal(
                    context.AccountId,
                    context.NewOwner,
                    context.RecoveryNonceText,
                    context.ExpiresAtText,
                    context.ActionId,
                    ticket.MasterNullifier,
                    ticket.ActionNullifier,
                    ticket.Signature);
                return;
            }

            if (requestType == "neodid_action_ticket")
            {
                OracleActionRequest context = GetOracleActionRequest(requestId);
                ExecutionEngine.Assert(context.AccountId != null && context.AccountId.Length > 0, "Unknown action oracle request");
                ExecutionEngine.Assert(Runtime.CallingScriptHash == GetMorpheusOracle(context.AccountId), "Unauthorized oracle");

                DeleteOracleActionRequest(requestId);
                ExecutionEngine.Assert(success, error == null || error == string.Empty ? "Action oracle request failed" : error);

                CompactActionTicket ticket = DecodeCompactActionTicket(result);
                ByteString? requestEpoch = Storage.Get(Storage.CurrentContext, ActionRequestEpochKey(requestId));
                ExecutionEngine.Assert(requestEpoch != null && (BigInteger)requestEpoch == ticket.AuthorizationEpoch, "Stale action request epoch");
                Storage.Delete(Storage.CurrentContext, ActionRequestEpochKey(requestId));

                ActivateActionSessionInternal(
                    context.AccountId,
                    context.Executor,
                    context.ActionId,
                    context.ExpiresAt,
                    ticket.ActionNullifier,
                    ticket.Signature,
                    ticket.MasterNullifier,
                    ticket.AuthorizationEpoch);
                return;
            }

            ExecutionEngine.Assert(false, "Unexpected request type");
        }

        private static void SubmitRecoveryTicketInternal(
            UInt160 accountId,
            UInt160 newOwner,
            string recoveryNonceText,
            string expiresAtText,
            string actionId,
            ByteString masterNullifier,
            ByteString actionNullifier,
            ByteString verificationSignature)
        {
            ValidateAccountId(accountId, "accountId");
            ValidateAddress(newOwner, "newOwner");
            ValidateShortText(recoveryNonceText, "recoveryNonce");
            ValidateShortText(expiresAtText, "expiresAt");
            ValidateShortText(actionId, "actionId");
            ValidateFixedHash(masterNullifier, "masterNullifier");
            ValidateFixedHash(actionNullifier, "actionNullifier");
            ValidateSignature(verificationSignature);

            ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext, Key(PREFIX_OWNER, accountId)) != null, "Recovery not setup");
            ExecutionEngine.Assert(IsAllowedMasterNullifier(accountId, masterNullifier), "Unknown recovery factor");
            ExecutionEngine.Assert(!IsActionNullifierUsed(accountId, actionNullifier), "Action nullifier already used");

            BigInteger currentNonce = GetRecoveryNonce(accountId);
            BigInteger ticketNonce = ParsePositiveDecimal(recoveryNonceText, "recoveryNonce");
            ExecutionEngine.Assert(ticketNonce == currentNonce, "Invalid recovery nonce");
            ExecutionEngine.Assert(actionId == BuildRecoveryActionId(accountId, newOwner, recoveryNonceText),
                "Recovery action does not match the account");

            BigInteger expiresAt = ParsePositiveDecimal(expiresAtText, "expiresAt");
            ExecutionEngine.Assert(expiresAt >= Runtime.Time, "Recovery ticket expired");
            ExecutionEngine.Assert(!HasApprovedFactor(accountId, currentNonce, masterNullifier), "Recovery factor already approved");

            PendingRecovery pending = GetPendingRecovery(accountId);
            if (pending.Active)
            {
                ExecutionEngine.Assert(pending.RecoveryNonce == currentNonce, "Unexpected pending recovery nonce");
                ExecutionEngine.Assert(pending.NewOwner == newOwner, "Pending recovery targets a different owner");
                ExecutionEngine.Assert(pending.ExecutableAt == 0, "Recovery already ready for execution");
            }
            else
            {
                pending = new PendingRecovery
                {
                    NewOwner = newOwner,
                    RecoveryNonce = currentNonce,
                    ApprovedCount = 0,
                    InitiatedAt = Runtime.Time,
                    ExecutableAt = 0,
                    Active = true
                };
            }

            ByteString digest = ComputeRecoveryDigest(
                GetNetwork(accountId),
                GetSAContract(accountId),
                accountId,
                GetAccountAddress(accountId),
                GetAccountIdText(accountId),
                newOwner,
                recoveryNonceText,
                expiresAtText,
                actionId,
                masterNullifier,
                actionNullifier);

            bool validSignature = CryptoLib.VerifyWithECDsa(
                digest,
                GetMorpheusVerifier(accountId),
                verificationSignature,
                NamedCurveHash.secp256r1SHA256);
            ExecutionEngine.Assert(validSignature, "Invalid Morpheus recovery signature");

            MarkFactorApproved(accountId, currentNonce, masterNullifier);
            MarkActionNullifierUsed(accountId, actionNullifier);
            pending.ApprovedCount += 1;

            BigInteger threshold = GetThreshold(accountId);
            if (pending.ApprovedCount >= threshold && pending.ExecutableAt == 0)
            {
                pending.ExecutableAt = (ulong)(Runtime.Time + GetTimelock(accountId));
                OnRecoveryReady(accountId, pending.NewOwner, pending.RecoveryNonce, pending.ExecutableAt);
            }

            SavePendingRecovery(accountId, pending);
            OnRecoveryTicketAccepted(accountId, pending.NewOwner, masterNullifier, actionNullifier, pending.ApprovedCount);
        }

        /// <summary>
        /// Starts the core recovery once the threshold and the service timelock have
        /// both matured. This service is the account's recorded recovery authority, so
        /// as the immediate caller of <c>beginRecovery</c> it satisfies the core's
        /// recovery-authority witness without any additional proof. The core then
        /// enforces its own account recovery timelock before the custody rotates.
        /// </summary>
        public static void FinalizeRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");

            PendingRecovery pending = GetPendingRecovery(accountId);
            ExecutionEngine.Assert(pending.Active, "No pending recovery");
            ExecutionEngine.Assert(pending.ExecutableAt > 0, "Recovery threshold not met");
            ExecutionEngine.Assert(Runtime.Time >= pending.ExecutableAt, "Recovery timelock not expired");

            UInt160 core = GetSAContract(accountId);
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "SA core not configured");
            Contract.Call(core, "beginRecovery", CallFlags.All, new object[] { accountId, pending.NewOwner });
        }

        /// <summary>
        /// Settles a matured core recovery. Permissionless: the core's own
        /// <c>executeRecovery</c> enforces the account recovery timelock and performs the
        /// callback-free sweep. Only after it succeeds does this service advance its own
        /// record to the new owner.
        /// </summary>
        public static void SettleRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");

            PendingRecovery pending = GetPendingRecovery(accountId);
            ExecutionEngine.Assert(pending.Active, "No pending recovery");

            UInt160 core = GetSAContract(accountId);
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "SA core not configured");
            Contract.Call(core, "executeRecovery", CallFlags.All, new object[] { accountId });

            UInt160 oldOwner = GetOwner(accountId);
            ResetActionAuthorization(accountId);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_OWNER, accountId), pending.NewOwner);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_RECOVERY_NONCE, accountId), pending.RecoveryNonce + 1);
            DeletePendingRecovery(accountId);
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_ACTIVE_SESSION, accountId));

            OnRecoveryFinalized(accountId, oldOwner, pending.NewOwner, pending.RecoveryNonce + 1);
        }

        public static void CancelRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            AssertOwner(accountId);

            PendingRecovery pending = GetPendingRecovery(accountId);
            ExecutionEngine.Assert(pending.Active, "No pending recovery");

            // The core keeps its own recovery record; cancel it first so the two ledgers
            // cannot diverge. This service is the account's recovery authority and is the
            // immediate caller, so the core accepts its witness.
            CancelCoreRecoveryIfPending(accountId);

            DeletePendingRecovery(accountId);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_RECOVERY_NONCE, accountId), pending.RecoveryNonce + 1);

            OnRecoveryCancelled(accountId, pending.RecoveryNonce);
        }

        public static void RevokeActionSession(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            AssertOwner(accountId);

            ActiveSession session = GetActiveSession(accountId);
            ExecutionEngine.Assert(session.Active, "No active session");
            AdvanceActionAuthorizationEpoch(accountId);
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_ACTIVE_SESSION, accountId));
            OnActionSessionRevoked(accountId, session.Executor, session.ActionId);
        }

        /// <summary>
        /// Removes every account-scoped record and refunds any GAS still earmarked for the
        /// account's Morpheus oracle to the current owner. Owner-gated: this service is not
        /// an SA module, so no core lifecycle callback reaches it. Consumed action-nullifier
        /// markers and the action epoch are deliberately retained — they are replay
        /// protection, and a later re-setup must not accept an already-executed ticket.
        /// </summary>
        public static void ClearAccount(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            AssertOwner(accountId);

            CancelCoreRecoveryIfPending(accountId);

            UInt160 previousOwner = GetOwner(accountId);
            ResetActionAuthorization(accountId);
            BigInteger refundedCredit = 0;
            byte[] creditKey = Key(PREFIX_ORACLE_CREDIT, accountId);
            ByteString? creditData = Storage.Get(Storage.CurrentContext, creditKey);
            if (creditData != null)
            {
                refundedCredit = (BigInteger)creditData;
                Storage.Delete(Storage.CurrentContext, creditKey);
                if (refundedCredit > 0)
                {
                    ExecutionEngine.Assert(
                        GAS.Transfer(Runtime.ExecutingScriptHash, previousOwner, refundedCredit, null),
                        "Oracle credit refund failed");
                }
            }

            Storage.Delete(Storage.CurrentContext, Key(PREFIX_OWNER, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_SA_CONTRACT, accountId));
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

        private static void CancelCoreRecoveryIfPending(UInt160 accountId)
        {
            UInt160 core = GetSAContract(accountId);
            if (core == UInt160.Zero || !core.IsValid) return;
            object[] status = (object[])Contract.Call(core, "getRecoveryStatus", CallFlags.ReadOnly,
                new object[] { accountId });
            if (status.Length == 0 || !(bool)status[0]) return;
            Contract.Call(core, "cancelRecovery", CallFlags.All, new object[] { accountId });
        }

        private static void DeleteAccountPrefixFamily(byte[] prefix)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }
    }
}
