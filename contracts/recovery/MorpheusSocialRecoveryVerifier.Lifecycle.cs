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
    public partial class SocialRecoveryVerifier
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
            UInt160 accountId,
            UInt160 executor,
            string actionId,
            ulong expiresAt,
            ByteString actionNullifier,
            ByteString verificationSignature)
        {
            ValidateAccountId(accountId, "accountId");
            ValidateAddress(executor, "executor");
            ValidateShortText(actionId, "actionId");
            ValidateFixedHash(actionNullifier, "actionNullifier");
            ValidateSignature(verificationSignature);
            ExecutionEngine.Assert(expiresAt > Runtime.Time, "Session already expired");
            ExecutionEngine.Assert(Runtime.CheckWitness(executor), "Executor witness required");

            ActivateActionSessionInternal(accountId, executor, actionId, expiresAt, actionNullifier, verificationSignature);
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

                ActivateActionSessionInternal(
                    context.AccountId,
                    context.Executor,
                    context.ActionId,
                    context.ExpiresAt,
                    ticket.ActionNullifier,
                    ticket.Signature);
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
                GetAAContract(accountId),
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

        public static void FinalizeRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");

            PendingRecovery pending = GetPendingRecovery(accountId);
            ExecutionEngine.Assert(pending.Active, "No pending recovery");
            ExecutionEngine.Assert(pending.ExecutableAt > 0, "Recovery threshold not met");
            ExecutionEngine.Assert(Runtime.Time >= pending.ExecutableAt, "Recovery timelock not expired");

            UInt160 oldOwner = GetOwner(accountId);
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
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_ACTIVE_SESSION, accountId));
            OnActionSessionRevoked(accountId, session.Executor, session.ActionId);
        }
    }
}
