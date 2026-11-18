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
        /// <summary>
        /// The executor of the account's currently valid action session, or
        /// <see cref="UInt160.Zero"/>. A caller that authorizes an operation by the
        /// session must still check that executor's witness itself: the service
        /// is a non-module service and never decides a user operation.
        /// </summary>
        [Safe]
        public static UInt160 GetAuthorizedSessionExecutor(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            ActiveSession session = GetActiveSession(accountId);
            if (!session.Active || session.ExpiresAt <= Runtime.Time || !IsActiveActionSessionAuthorized(accountId))
            {
                return UInt160.Zero;
            }
            return session.Executor;
        }

        [Safe]
        public static UInt160 GetOwner(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_OWNER, accountId));
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        [Safe]
        public static UInt160 GetSAContract(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_SA_CONTRACT, accountId));
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        [Safe]
        public static UInt160 GetAccountAddress(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_ACCOUNT_ADDRESS, accountId));
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        [Safe]
        public static UInt160 GetMorpheusOracle(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_MORPHEUS_ORACLE, accountId));
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        [Safe]
        public static string GetNetwork(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_NETWORK, accountId));
            return data == null ? string.Empty : (string)data;
        }

        [Safe]
        public static string GetAccountIdText(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_ACCOUNT_ID_TEXT, accountId));
            return data == null ? string.Empty : (string)data;
        }

        [Safe]
        public static BigInteger GetThreshold(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_THRESHOLD, accountId));
            return data == null ? 0 : (BigInteger)data;
        }

        [Safe]
        public static ulong GetTimelock(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_TIMELOCK, accountId));
            return data == null ? 0 : (ulong)(BigInteger)data;
        }

        [Safe]
        public static BigInteger GetRecoveryNonce(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_RECOVERY_NONCE, accountId));
            return data == null ? 0 : (BigInteger)data;
        }

        [Safe]
        public static BigInteger GetSessionNonce(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_SESSION_NONCE, accountId));
            return data == null ? 0 : (BigInteger)data;
        }

        [Safe]
        public static ECPoint GetMorpheusVerifier(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_MORPHEUS_VERIFIER, accountId));
            return data == null ? null! : (ECPoint)(byte[])data;
        }

        [Safe]
        public static ByteString[] GetMasterNullifiers(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_FACTORS, accountId));
            if (data == null) return new ByteString[] { };
            return (ByteString[])StdLib.Deserialize(data);
        }

        [Safe]
        public static bool IsAllowedMasterNullifier(UInt160 accountId, ByteString masterNullifier)
        {
            if (masterNullifier == null || masterNullifier.Length != FIXED_HASH_LENGTH) return false;
            ByteString[] factors = GetMasterNullifiers(accountId);
            for (int i = 0; i < factors.Length; i++)
            {
                if (factors[i].Equals(masterNullifier)) return true;
            }
            return false;
        }

        [Safe]
        public static bool IsActionNullifierUsed(UInt160 accountId, ByteString actionNullifier)
        {
            if (actionNullifier == null || actionNullifier.Length != FIXED_HASH_LENGTH) return false;
            return Storage.Get(Storage.CurrentContext, UsedActionKey(accountId, actionNullifier)) != null;
        }

        [Safe]
        public static PendingRecovery GetPendingRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            ByteString? active = Storage.Get(Storage.CurrentContext, Key(PREFIX_PENDING_ACTIVE, accountId));
            if (active == null)
            {
                return new PendingRecovery
                {
                    NewOwner = UInt160.Zero,
                    RecoveryNonce = -1,
                    ApprovedCount = 0,
                    InitiatedAt = 0,
                    ExecutableAt = 0,
                    Active = false
                };
            }
            return new PendingRecovery
            {
                NewOwner = (UInt160)Storage.Get(Storage.CurrentContext, Key(PREFIX_PENDING_NEW_OWNER, accountId)),
                RecoveryNonce = (BigInteger)Storage.Get(Storage.CurrentContext, Key(PREFIX_PENDING_NONCE, accountId)),
                ApprovedCount = (BigInteger)Storage.Get(Storage.CurrentContext, Key(PREFIX_PENDING_APPROVED, accountId)),
                InitiatedAt = (ulong)(BigInteger)Storage.Get(Storage.CurrentContext, Key(PREFIX_PENDING_INITIATED, accountId)),
                ExecutableAt = (ulong)(BigInteger)Storage.Get(Storage.CurrentContext, Key(PREFIX_PENDING_EXECUTABLE, accountId)),
                Active = (BigInteger)active != 0
            };
        }

        [Safe]
        public static ActiveSession GetActiveSession(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_ACTIVE_SESSION, accountId));
            if (data == null)
            {
                return new ActiveSession
                {
                    Executor = UInt160.Zero,
                    ActionId = string.Empty,
                    ActionNullifier = (ByteString)"",
                    ExpiresAt = 0,
                    Active = false
                };
            }
            return (ActiveSession)StdLib.Deserialize(data);
        }
    }
}
