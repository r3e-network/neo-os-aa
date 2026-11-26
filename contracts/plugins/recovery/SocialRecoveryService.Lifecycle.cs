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

            // Idempotent reconciliation first: if the core recovery this service approved has
            // already completed, the row owner is already the approved custody. A superseded
            // owner must not be able to spend (or later have refunded to it) this account's
            // earmarked GAS merely because the service had not settled yet.
            ReconcileAuthoritativeRecovery(accountId);

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
                // An unknown request id deserializes to the default record (AccountId zero);
                // UInt160 is always 20 bytes, so a length test could never detect it.
                ExecutionEngine.Assert(context.AccountId != UInt160.Zero, "Unknown recovery oracle request");
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
                ExecutionEngine.Assert(context.AccountId != UInt160.Zero, "Unknown action oracle request");
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
        /// <remarks>
        /// Idempotent: a recovery this service already started is never restarted, and a
        /// recovery the core already completed (its <c>executeRecovery</c> is permissionless)
        /// is reconciled instead of being started a second time, which the core would reject.
        /// </remarks>
        public static void FinalizeRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");

            if (ReconcileAuthoritativeRecovery(accountId)) return;

            PendingRecovery pending = GetPendingRecovery(accountId);
            ExecutionEngine.Assert(pending.Active, "No pending recovery");
            ExecutionEngine.Assert(pending.ExecutableAt > 0, "Recovery threshold not met");
            ExecutionEngine.Assert(Runtime.Time >= pending.ExecutableAt, "Recovery timelock not expired");

            UInt160 core = GetSAContract(accountId);
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "SA core not configured");

            if (HasRecoveryBinding(accountId))
            {
                ExecutionEngine.Assert(GetRecoveryBindingTarget(accountId) == pending.NewOwner,
                    "Recovery binding targets a different owner");
                object[] existing = GetCoreRecoveryStatus(core, accountId);
                // The core still holds exactly the recovery this service approved: there is
                // nothing to start, and the binding keeps its original generation.
                if (existing.Length != 0 && (bool)existing[0] && (UInt160)existing[4] == pending.NewOwner)
                {
                    return;
                }
                // The core record is gone (canceled, or superseded by a custody-side
                // beginRecovery): drop the stale binding and start a fresh, correct one.
                ClearRecoveryBinding(accountId);
            }

            Contract.Call(core, "beginRecovery", CallFlags.All, new object[] { accountId, pending.NewOwner });

            // Bind this approval to the core generation it belongs to. The core's own record
            // is the authority; a mismatch here means the core did not record the recovery
            // this service just asked for, so refuse to leave a half-set state.
            object[] status = GetCoreRecoveryStatus(core, accountId);
            ExecutionEngine.Assert(status.Length >= 5 && (bool)status[0], "Core recovery was not started");
            ExecutionEngine.Assert((UInt160)status[4] == pending.NewOwner, "Core recovery targets a different owner");
            SaveRecoveryBinding(accountId, (BigInteger)status[3], pending.NewOwner);
        }

        /// <summary>
        /// Settles a matured core recovery this service approved. Permissionless: the core's
        /// own <c>executeRecovery</c> enforces the account recovery timelock and performs the
        /// callback-free sweep. Only after it succeeds does this service advance its own
        /// record to the new owner.
        /// </summary>
        /// <remarks>
        /// The core entry point is permissionless, so a third party may already have executed
        /// the approved recovery. That authoritative completion is reconciled — service owner,
        /// pending record, action authorization and session all advanced — without a second
        /// <c>executeRecovery</c>, which the core would reject because its pending record is gone.
        /// Settlement is therefore idempotent: once the service has adopted a completion, a
        /// repeated call is a safe no-op, while an account that never had an approved recovery
        /// still faults.
        /// </remarks>
        public static void SettleRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");

            if (ReconcileAuthoritativeRecovery(accountId)) return;

            PendingRecovery pending = GetPendingRecovery(accountId);

            // Idempotency. Adopting a recovery consumes the pending record together with its
            // binding, so settling again afterwards would otherwise fault on the empty pending.
            // Only the durable completion marker the adopt path writes proves "already done":
            // an account that was never approved has none and falls through to the fault below,
            // so repeated settlement can never disguise a missing approval.
            if (!pending.Active && !HasRecoveryBinding(accountId) && IsRecoveryCompletionConfirmed(accountId))
            {
                return;
            }

            ExecutionEngine.Assert(pending.Active, "No pending recovery");

            // Only a recovery this service approved at the core may be settled. Without the
            // binding, executeRecovery would be a service-driven custody rotation that no
            // recovery threshold ever approved.
            ExecutionEngine.Assert(HasRecoveryBinding(accountId), "Recovery not finalized");

            UInt160 core = GetSAContract(accountId);
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "SA core not configured");
            Contract.Call(core, "executeRecovery", CallFlags.All, new object[] { accountId });

            // The core is the authority on who controls the account. If it did not land on the
            // approved custody, the service must not claim the recovery happened.
            ExecutionEngine.Assert(GetCoreCustody(core, accountId) == pending.NewOwner,
                "Core recovery was superseded");

            ApplyRecoveredOwner(accountId, pending);
        }

        /// <summary>
        /// Adopts the authoritative core outcome when the recovery this service approved has
        /// already been executed by someone else. Returns false — changing nothing — while the
        /// approved recovery has not been completed at the core.
        /// </summary>
        /// <remarks>
        /// The core keeps <c>executeRecovery</c> permissionless and callback-free, so this
        /// service can never be the only party that moves its own record. Acceptance needs all
        /// of: a live service pending, the persisted approval binding, a core that now holds the
        /// approved custody, an authority generation at or after the approved one, and a
        /// consumed core recovery record (both a successful executeRecovery and a
        /// cancelRecovery delete it).
        /// </remarks>
        private static bool ReconcileAuthoritativeRecovery(UInt160 accountId)
        {
            PendingRecovery pending = GetPendingRecovery(accountId);
            if (!pending.Active) return false;
            if (!HasRecoveryBinding(accountId)) return false;

            UInt160 target = GetRecoveryBindingTarget(accountId);
            if (target == UInt160.Zero || target != pending.NewOwner) return false;

            UInt160 core = GetSAContract(accountId);
            if (core == UInt160.Zero || !core.IsValid) return false;

            object[] account = (object[])Contract.Call(core, "getAccount", CallFlags.ReadOnly,
                new object[] { accountId });
            if (account.Length <= 4 || !(bool)account[0]) return false;
            if ((UInt160)account[2] != target) return false;

            // The epoch is a lower bound only. Freezing, unfreezing and core custody rotation
            // also advance authorityEpoch, and a superseded owner must not be able to wedge
            // reconciliation by forcing an advance; only a lower epoch would indicate that the
            // account is at a different, older generation than the approval.
            if ((BigInteger)account[4] < GetRecoveryBindingEpoch(accountId)) return false;

            // Both a successful executeRecovery and a cancelRecovery delete the core record,
            // so an empty status alone does not distinguish settlement from cancellation;
            // the custody and authority-generation checks above carry that weight.
            if (GetCoreRecoveryStatus(core, accountId).Length != 0) return false;

            ApplyRecoveredOwner(accountId, pending);
            return true;
        }

        /// <summary>
        /// Moves every service-side record to the recovered owner: owner row, recovery nonce,
        /// pending recovery (with its binding) and the action session and authorization epoch.
        /// </summary>
        private static void ApplyRecoveredOwner(UInt160 accountId, PendingRecovery pending)
        {
            UInt160 oldOwner = GetOwner(accountId);
            ResetActionAuthorization(accountId);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_OWNER, accountId), pending.NewOwner);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_RECOVERY_NONCE, accountId), pending.RecoveryNonce + 1);
            // Remember the adoption: DeletePendingRecovery below removes every trace of the
            // approval, and without this marker a repeated settleRecovery could not tell a
            // completed recovery from one that was never approved.
            SaveRecoveryCompletion(accountId, pending.NewOwner);
            DeletePendingRecovery(accountId);
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_ACTIVE_SESSION, accountId));

            OnRecoveryFinalized(accountId, oldOwner, pending.NewOwner, pending.RecoveryNonce + 1);
        }

        private static object[] GetCoreRecoveryStatus(UInt160 core, UInt160 accountId)
        {
            return (object[])Contract.Call(core, "getRecoveryStatus", CallFlags.ReadOnly,
                new object[] { accountId });
        }

        /// <summary>The core control record's custody (spec §9 index 2), or Zero when unknown.</summary>
        private static UInt160 GetCoreCustody(UInt160 core, UInt160 accountId)
        {
            object[] account = (object[])Contract.Call(core, "getAccount", CallFlags.ReadOnly,
                new object[] { accountId });
            if (account.Length <= 2 || !(bool)account[0]) return UInt160.Zero;
            return (UInt160)account[2];
        }

        /// <summary>
        /// True when this service already adopted a completed recovery for the account and the
        /// adopted owner is still the authoritative custody.
        /// </summary>
        /// <remarks>
        /// The completion marker is written only by <see cref="ApplyRecoveredOwner"/>, i.e. only
        /// after the core actually rotated custody. The remaining guards keep a silent no-op
        /// from masking a divergent state: the service row must still name the adopted owner,
        /// the core must still hold it, and the core must have no recovery in flight.
        /// </remarks>
        private static bool IsRecoveryCompletionConfirmed(UInt160 accountId)
        {
            UInt160 completed = GetRecoveryCompletionTarget(accountId);
            if (completed == UInt160.Zero) return false;
            if (GetOwner(accountId) != completed) return false;

            UInt160 core = GetSAContract(accountId);
            if (core == UInt160.Zero || !core.IsValid) return false;

            object[] account = (object[])Contract.Call(core, "getAccount", CallFlags.ReadOnly,
                new object[] { accountId });
            if (account.Length <= 2 || !(bool)account[0]) return false;
            if ((UInt160)account[2] != completed) return false;

            return GetCoreRecoveryStatus(core, accountId).Length == 0;
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
            ClearRecoveryCompletion(accountId);
            DeleteAccountPrefixFamily(Key(PREFIX_APPROVAL, accountId));

            OnRecoveryCleared(accountId, previousOwner, refundedCredit);
        }

        private static void CancelCoreRecoveryIfPending(UInt160 accountId)
        {
            UInt160 core = GetSAContract(accountId);
            if (core == UInt160.Zero || !core.IsValid) return;
            object[] status = GetCoreRecoveryStatus(core, accountId);
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
