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
        private static void StoreConfig(
            UInt160 accountId,
            string accountIdText,
            string network,
            UInt160 owner,
            UInt160 saContract,
            UInt160 accountAddress,
            UInt160 morpheusOracle,
            ByteString[] masterNullifiers,
            BigInteger threshold,
            ulong timelock,
            ECPoint morpheusVerifier)
        {
            Storage.Put(Storage.CurrentContext, Key(PREFIX_OWNER, accountId), owner);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_SA_CONTRACT, accountId), saContract);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_ACCOUNT_ADDRESS, accountId), accountAddress);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_MORPHEUS_ORACLE, accountId), morpheusOracle);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_NETWORK, accountId), network);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_ACCOUNT_ID_TEXT, accountId), accountIdText);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_FACTORS, accountId), StdLib.Serialize(masterNullifiers));
            Storage.Put(Storage.CurrentContext, Key(PREFIX_THRESHOLD, accountId), threshold);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_TIMELOCK, accountId), (BigInteger)timelock);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_MORPHEUS_VERIFIER, accountId), (byte[])morpheusVerifier);
        }

        private static void SavePendingRecovery(UInt160 accountId, PendingRecovery pending)
        {
            Storage.Put(Storage.CurrentContext, Key(PREFIX_PENDING_NEW_OWNER, accountId), pending.NewOwner);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_PENDING_NONCE, accountId), pending.RecoveryNonce);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_PENDING_APPROVED, accountId), pending.ApprovedCount);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_PENDING_INITIATED, accountId), (BigInteger)pending.InitiatedAt);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_PENDING_EXECUTABLE, accountId), (BigInteger)pending.ExecutableAt);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_PENDING_ACTIVE, accountId), pending.Active ? 1 : 0);
        }

        private static void DeletePendingRecovery(UInt160 accountId)
        {
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_PENDING_NEW_OWNER, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_PENDING_NONCE, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_PENDING_APPROVED, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_PENDING_INITIATED, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_PENDING_EXECUTABLE, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_PENDING_ACTIVE, accountId));
            // The core-recovery binding belongs to exactly one service pending. Clearing it
            // here keeps both ledgers in lockstep: a cancelled, settled or reconciled
            // recovery can never leave a stale generation that a later reconciliation
            // would mistake for the current one.
            ClearRecoveryBinding(accountId);
        }

        /// <summary>
        /// Records which core recovery generation this service approved: the core's
        /// <c>authorityEpoch</c> at <c>beginRecovery</c> time and the custody it targets.
        /// </summary>
        private static void SaveRecoveryBinding(UInt160 accountId, BigInteger authorityEpoch, UInt160 target)
        {
            Storage.Put(Storage.CurrentContext, Key(PREFIX_RECOVERY_BINDING_EPOCH, accountId), authorityEpoch);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_RECOVERY_BINDING_TARGET, accountId), target);
        }

        private static bool HasRecoveryBinding(UInt160 accountId)
        {
            return Storage.Get(Storage.CurrentContext, Key(PREFIX_RECOVERY_BINDING_EPOCH, accountId)) != null;
        }

        private static BigInteger GetRecoveryBindingEpoch(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_RECOVERY_BINDING_EPOCH, accountId));
            return data == null ? 0 : (BigInteger)data;
        }

        private static UInt160 GetRecoveryBindingTarget(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_RECOVERY_BINDING_TARGET, accountId));
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        private static void ClearRecoveryBinding(UInt160 accountId)
        {
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_RECOVERY_BINDING_EPOCH, accountId));
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_RECOVERY_BINDING_TARGET, accountId));
        }

        /// <summary>
        /// Records the owner this service adopted when a core recovery completed. Durable: it
        /// survives the pending record that the adoption consumes, which is what lets a
        /// repeated settlement recognise "already done" instead of faulting on the empty
        /// pending. Only the adopt path writes it.
        /// </summary>
        private static void SaveRecoveryCompletion(UInt160 accountId, UInt160 target)
        {
            Storage.Put(Storage.CurrentContext, Key(PREFIX_RECOVERY_COMPLETION, accountId), target);
        }

        private static UInt160 GetRecoveryCompletionTarget(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_RECOVERY_COMPLETION, accountId));
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        private static void ClearRecoveryCompletion(UInt160 accountId)
        {
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_RECOVERY_COMPLETION, accountId));
        }

        private static void SaveActiveSession(UInt160 accountId, ActiveSession session)
        {
            Storage.Put(Storage.CurrentContext, Key(PREFIX_ACTIVE_SESSION, accountId), StdLib.Serialize(session));
        }

        private static void SaveOracleRecoveryRequest(BigInteger requestId, OracleRecoveryRequest request)
        {
            Storage.Put(Storage.CurrentContext, OracleRequestKey(requestId), StdLib.Serialize(request));
        }

        private static OracleRecoveryRequest GetOracleRecoveryRequest(BigInteger requestId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, OracleRequestKey(requestId));
            if (data == null) return new OracleRecoveryRequest();
            return (OracleRecoveryRequest)StdLib.Deserialize(data);
        }

        private static void DeleteOracleRecoveryRequest(BigInteger requestId)
        {
            Storage.Delete(Storage.CurrentContext, OracleRequestKey(requestId));
        }

        private static void SaveOracleActionRequest(BigInteger requestId, OracleActionRequest request)
        {
            Storage.Put(Storage.CurrentContext, OracleActionRequestKey(requestId), StdLib.Serialize(request));
        }

        private static OracleActionRequest GetOracleActionRequest(BigInteger requestId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, OracleActionRequestKey(requestId));
            if (data == null) return new OracleActionRequest();
            return (OracleActionRequest)StdLib.Deserialize(data);
        }

        private static void DeleteOracleActionRequest(BigInteger requestId)
        {
            Storage.Delete(Storage.CurrentContext, OracleActionRequestKey(requestId));
        }

        private static void MarkFactorApproved(UInt160 accountId, BigInteger recoveryNonce, ByteString masterNullifier)
        {
            Storage.Put(Storage.CurrentContext, ApprovalKey(accountId, recoveryNonce, masterNullifier), 1);
        }

        private static bool HasApprovedFactor(UInt160 accountId, BigInteger recoveryNonce, ByteString masterNullifier)
        {
            return Storage.Get(Storage.CurrentContext, ApprovalKey(accountId, recoveryNonce, masterNullifier)) != null;
        }

        private static void MarkActionNullifierUsed(UInt160 accountId, ByteString actionNullifier)
        {
            Storage.Put(Storage.CurrentContext, UsedActionKey(accountId, actionNullifier), 1);
        }

        private static void ActivateActionSessionInternal(
            UInt160 accountId,
            UInt160 executor,
            string actionId,
            ulong expiresAt,
            ByteString actionNullifier,
            ByteString verificationSignature,
            ByteString masterNullifier, BigInteger authorizationEpoch)
        {
            ValidateFixedHash(masterNullifier, "masterNullifier");
            ExecutionEngine.Assert(authorizationEpoch > 0 && authorizationEpoch == GetActionAuthorizationEpoch(accountId), "Stale action authorization epoch");
            ExecutionEngine.Assert(IsAllowedActionIdentity(accountId, masterNullifier), "Action identity not enrolled");
            ValidateAddress(executor, "executor");
            ValidateShortText(actionId, "actionId");
            ValidateFixedHash(actionNullifier, "actionNullifier");
            ValidateSignature(verificationSignature);
            ExecutionEngine.Assert(expiresAt > Runtime.Time, "Session already expired");
            ExecutionEngine.Assert(!IsActionNullifierUsed(accountId, actionNullifier), "Action nullifier already used");
            ExecutionEngine.Assert(actionId == BuildActionId(accountId, executor, GetSessionNonce(accountId), expiresAt),
                "Action session does not match the account");

            ByteString digest = ComputeActionDigest(accountId, executor, actionId, expiresAt, masterNullifier, authorizationEpoch, actionNullifier);
            bool validSignature = CryptoLib.VerifyWithECDsa(
                digest,
                GetMorpheusVerifier(accountId),
                verificationSignature,
                NamedCurveHash.secp256r1SHA256);
            ExecutionEngine.Assert(validSignature, "Invalid Morpheus action signature");

            SaveActionSessionAuthorization(accountId, masterNullifier, GetActionAuthorizationEpoch(accountId), false, GetSessionNonce(accountId) + 1);
            MarkActionNullifierUsed(accountId, actionNullifier);
            SaveActiveSession(accountId, new ActiveSession
            {
                Executor = executor,
                ActionId = actionId,
                ActionNullifier = actionNullifier,
                ExpiresAt = expiresAt,
                Active = true
            });
            Storage.Put(Storage.CurrentContext, Key(PREFIX_SESSION_NONCE, accountId), GetSessionNonce(accountId) + 1);
            OnActionSessionActivated(accountId, executor, actionId, actionNullifier, expiresAt);
        }

        private static CompactRecoveryTicket DecodeCompactRecoveryTicket(ByteString payload)
        {
            string[] segments = SplitCompactPayload(payload, 4);
            ExecutionEngine.Assert(segments[0] == COMPACT_TICKET_VERSION.ToString(), "Unsupported recovery ticket version");

            ByteString masterNullifier = DecodeBase64Field(segments[1], FIXED_HASH_LENGTH, "masterNullifier");
            ByteString actionNullifier = DecodeBase64Field(segments[2], FIXED_HASH_LENGTH, "actionNullifier");
            ByteString signature = DecodeBase64Field(segments[3], FIXED_SIGNATURE_LENGTH, "signature");

            return new CompactRecoveryTicket
            {
                MasterNullifier = masterNullifier,
                ActionNullifier = actionNullifier,
                Signature = signature
            };
        }

        private static CompactActionTicket DecodeCompactActionTicket(ByteString payload)
        {
            string[] segments = SplitCompactPayload(payload, 5);
            ExecutionEngine.Assert(segments[0] == COMPACT_ACTION_VERSION.ToString(), "Unsupported action ticket version");
            BigInteger epoch = ParsePositiveDecimal(segments[2], "authorizationEpoch");
            ExecutionEngine.Assert(epoch > 0 && segments[2] == epoch.ToString(), "Noncanonical action epoch");
            return new CompactActionTicket
            {
                MasterNullifier = DecodeBase64Field(segments[1], FIXED_HASH_LENGTH, "masterNullifier"),
                AuthorizationEpoch = epoch,
                ActionNullifier = DecodeBase64Field(segments[3], FIXED_HASH_LENGTH, "actionNullifier"),
                Signature = DecodeBase64Field(segments[4], FIXED_SIGNATURE_LENGTH, "signature")
            };
        }

        private static ByteString DecodeBase64Field(string value, int expectedLength, string fieldName)
        {
            ByteString decoded = StdLib.Base64Decode(value);
            ExecutionEngine.Assert(decoded != null && decoded.Length == expectedLength, fieldName + " invalid length");
            return decoded;
        }

        private static string[] SplitCompactPayload(ByteString payload, int expectedSegments)
        {
            byte[] bytes = (byte[])payload;
            ExecutionEngine.Assert(bytes != null && bytes.Length > 0, "Compact payload required");
            string[] segments = new string[expectedSegments];
            int segmentIndex = 0;
            int start = 0;

            for (int index = 0; index <= bytes.Length; index++)
            {
                bool atSeparator = index < bytes.Length && bytes[index] == (byte)'|';
                bool atEnd = index == bytes.Length;
                if (!atSeparator && !atEnd) continue;

                ExecutionEngine.Assert(segmentIndex < expectedSegments, "Too many compact payload segments");
                byte[] output = new byte[index - start];
                for (int i = 0; i < output.Length; i++)
                {
                    output[i] = bytes[start + i];
                }
                segments[segmentIndex] = (string)(ByteString)output;
                segmentIndex += 1;
                start = index + 1;
            }

            ExecutionEngine.Assert(segmentIndex == expectedSegments, "Invalid compact payload segment count");
            return segments;
        }

        private static byte[] ReadFixedBytes(byte[] bytes, ref int offset, int length)
        {
            ExecutionEngine.Assert(offset + length <= bytes.Length, "Compact ticket overflow");
            byte[] output = new byte[length];
            for (int i = 0; i < length; i++)
            {
                output[i] = bytes[offset + i];
            }
            offset += length;
            return output;
        }

        private static string ReadLengthPrefixedText(byte[] bytes, ref int offset, string fieldName)
        {
            ExecutionEngine.Assert(offset < bytes.Length, "Compact ticket overflow");
            int length = bytes[offset];
            offset += 1;
            ExecutionEngine.Assert(offset + length <= bytes.Length, fieldName + " overflow");
            byte[] output = new byte[length];
            for (int i = 0; i < length; i++)
            {
                output[i] = bytes[offset + i];
            }
            offset += length;
            return (string)(ByteString)output;
        }
    }
}
