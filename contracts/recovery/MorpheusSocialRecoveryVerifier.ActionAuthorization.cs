using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace Neo.SmartContract.Examples
{
    public partial class SocialRecoveryVerifier
    {
        // Never delete the epoch, including ClearAccount. Re-setup must not revive
        // unused tickets or delayed Oracle callbacks from a prior account generation.
        private const byte PREFIX_ACTION_EPOCH = 0x1A;
        private const byte PREFIX_ACTION_IDENTITIES = 0x1B;
        private const byte PREFIX_SESSION_AUTHORIZATION = 0x1C;
        private const byte PREFIX_ACTION_REQUEST_EPOCH = 0x1D;

        public class ActionAuthorization
        {
            public BigInteger ProtocolVersion = 4;
            public UInt160 AAContract = UInt160.Zero;
            public UInt160 Verifier = UInt160.Zero;
            public UInt160 Owner = UInt160.Zero;
            public string Network = string.Empty;
            public string AccountIdText = string.Empty;
            public BigInteger AuthorizationEpoch;
            public BigInteger SessionNonce;
            public bool Allowed;
        }

        private class SessionAuthorization
        {
            public ByteString MasterNullifier = (ByteString)"";
            public BigInteger Epoch;
            public BigInteger SessionNonce;
            public bool OwnerConsent;
        }

        [Safe]
        public static BigInteger GetActionProtocolVersion() => 4;

        [Safe]
        public static BigInteger GetActionAuthorizationEpoch(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_ACTION_EPOCH, accountId));
            return data == null ? 0 : (BigInteger)data;
        }

        [Safe]
        public static ByteString[] GetActionIdentities(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_ACTION_IDENTITIES, accountId));
            return data == null ? new ByteString[] { } : (ByteString[])StdLib.Deserialize(data);
        }

        [Safe]
        public static bool IsAllowedActionIdentity(UInt160 accountId, ByteString masterNullifier)
        {
            if (masterNullifier == null || masterNullifier.Length != FIXED_HASH_LENGTH || GetOwner(accountId) == UInt160.Zero) return false;
            ByteString[] identities = GetActionIdentities(accountId);
            for (int i = 0; i < identities.Length; i++)
                if (identities[i].Equals(masterNullifier)) return true;
            return false;
        }

        [Safe]
        public static ActionAuthorization GetActionAuthorization(UInt160 accountId, ByteString masterNullifier)
        {
            ValidateAccountId(accountId, "accountId");
            return new ActionAuthorization
            {
                AAContract = GetAAContract(accountId),
                Verifier = Runtime.ExecutingScriptHash,
                Owner = GetOwner(accountId),
                Network = GetNetwork(accountId),
                AccountIdText = GetAccountIdText(accountId),
                AuthorizationEpoch = GetActionAuthorizationEpoch(accountId),
                SessionNonce = GetSessionNonce(accountId),
                Allowed = IsAllowedActionIdentity(accountId, masterNullifier)
            };
        }

        public static void SetActionIdentity(UInt160 accountId, ByteString masterNullifier, bool enabled)
        {
            ValidateAccountId(accountId, "accountId");
            ValidateFixedHash(masterNullifier, "masterNullifier");
            // Current verifier owner, which may have changed through recovery.
            // Recovery factors and registry bindings are not action grants.
            AssertOwner(accountId);
            ByteString[] old = GetActionIdentities(accountId);
            int found = -1;
            for (int i = 0; i < old.Length; i++)
                if (old[i].Equals(masterNullifier)) found = i;
            if (enabled && found >= 0) return;
            ExecutionEngine.Assert(enabled || found >= 0, "Action identity not enrolled");
            ExecutionEngine.Assert(!enabled || old.Length < MAX_FACTORS, "Too many action identities");
            ByteString[] next = new ByteString[enabled ? old.Length + 1 : old.Length - 1];
            int cursor = 0;
            for (int i = 0; i < old.Length; i++)
                if (enabled || i != found) next[cursor++] = old[i];
            if (enabled) next[cursor] = masterNullifier;
            AdvanceActionAuthorizationEpoch(accountId);
            Storage.Put(Storage.CurrentContext, Key(PREFIX_ACTION_IDENTITIES, accountId), StdLib.Serialize(next));
        }

        public static void RevokeAllActionIdentities(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            AssertOwner(accountId);
            ResetActionAuthorization(accountId);
        }

        public static void ReauthorizeActiveActionSession(UInt160 accountId, UInt160 expectedExecutor,
            string expectedActionId, ulong expectedExpiresAt, ByteString expectedActionNullifier)
        {
            ValidateAccountId(accountId, "accountId");
            AssertOwner(accountId);
            ActiveSession session = GetActiveSession(accountId);
            ExecutionEngine.Assert(session.Active && session.ExpiresAt > Runtime.Time, "No unexpired active session");
            ExecutionEngine.Assert(session.Executor == expectedExecutor && session.ActionId == expectedActionId
                && session.ExpiresAt == expectedExpiresAt && session.ActionNullifier.Equals(expectedActionNullifier), "Active session changed");
            if (GetActionAuthorizationEpoch(accountId) == 0) AdvanceActionAuthorizationEpoch(accountId);
            SaveActionSessionAuthorization(accountId, (ByteString)"", GetActionAuthorizationEpoch(accountId), true, GetSessionNonce(accountId));
        }

        private static void AdvanceActionAuthorizationEpoch(UInt160 accountId)
        {
            BigInteger current = GetActionAuthorizationEpoch(accountId);
            ExecutionEngine.Assert(current >= 0, "Invalid action epoch");
            // Neo's bounded BigInteger overflow faults atomically, never wraps.
            BigInteger next = current + 1;
            ExecutionEngine.Assert(next > current, "Action epoch exhausted");
            Storage.Put(Storage.CurrentContext, Key(PREFIX_ACTION_EPOCH, accountId), next);
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_SESSION_AUTHORIZATION, accountId));
        }

        private static void ResetActionAuthorization(UInt160 accountId)
        {
            AdvanceActionAuthorizationEpoch(accountId);
            Storage.Delete(Storage.CurrentContext, Key(PREFIX_ACTION_IDENTITIES, accountId));
        }

        private static void SaveActionSessionAuthorization(UInt160 accountId, ByteString masterNullifier,
            BigInteger epoch, bool ownerConsent, BigInteger sessionNonce)
        {
            Storage.Put(Storage.CurrentContext, Key(PREFIX_SESSION_AUTHORIZATION, accountId), StdLib.Serialize(new SessionAuthorization
            {
                MasterNullifier = masterNullifier, Epoch = epoch, SessionNonce = sessionNonce, OwnerConsent = ownerConsent
            }));
        }

        [Safe]
        public static bool IsActionSessionAuthorized(UInt160 accountId)
        {
            ValidateAccountId(accountId, "accountId");
            ActiveSession session = GetActiveSession(accountId);
            return session.Active && session.ExpiresAt > Runtime.Time && IsActiveActionSessionAuthorized(accountId);
        }

        private static bool IsActiveActionSessionAuthorized(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(PREFIX_SESSION_AUTHORIZATION, accountId));
            if (data == null) return false; // Legacy state requires explicit owner consent.
            SessionAuthorization auth = (SessionAuthorization)StdLib.Deserialize(data);
            if (auth.Epoch <= 0 || auth.Epoch != GetActionAuthorizationEpoch(accountId) || auth.SessionNonce != GetSessionNonce(accountId)) return false;
            return auth.OwnerConsent || IsAllowedActionIdentity(accountId, auth.MasterNullifier);
        }

        private static byte[] ActionRequestEpochKey(BigInteger requestId) =>
            Helper.Concat(new byte[] { PREFIX_ACTION_REQUEST_EPOCH }, requestId.ToByteArray());
    }
}
