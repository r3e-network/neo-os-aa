using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Modules
{
    /// <summary>
    /// §15 threshold-policy module (skeleton).
    ///
    /// A policy is a member set plus the number of member signatures an
    /// operation needs. The minimal core routes an operation to one validator
    /// instance and requires that instance to answer true or false — it does
    /// not count members itself. So the threshold lives here: the account
    /// installs this module as its validator, publishes a policy, and every
    /// operation is approved only when enough listed members signed it.
    ///
    /// Members are 33-byte compressed secp256r1 keys. The operation carries the
    /// signatures in its validator DTO (operation field 11): the members'
    /// 64-byte <c>r‖s</c> values concatenated in policy order. Each member signs
    /// the domain-separated digest published by
    /// <see cref="GetMemberDigest"/>:
    /// <c>sha256(accountId ‖ moduleId ‖ operationDigest)</c>, so a signature for
    /// one account or one instance never verifies for another.
    ///
    /// Storage is per account:
    ///   <c>0x01 ‖ accountId</c> → serialized [members[], threshold, policyNonce, updatedAt]
    /// </summary>
    [DisplayName("ThresholdPolicyModule")]
    [ContractPermission("*", "getAccount")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ManifestExtra("Description", "Threshold-policy validator module (spec §15)")]
    public class ThresholdPolicyModule : SmartContract
    {
        // Canonical module capability profile (docs/SA-MODULE-PROTOCOL.md §12):
        // keys sorted, no whitespace, no trailing newline. The core hashes these
        // exact bytes into the install-time profile digest. The module is a
        // validator (§15: accounts route operations to it and it counts member
        // approvals) that owns no message domain and — being the policy owner
        // rather than a scalar member — is not itself threshold-member eligible
        // (§15.1: the policy is not a member of another policy); the member roster
        // is keyed by account, so instanceIsolation is false.
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"ThresholdPolicyModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Policy = new byte[] { 0x01 };

        /// <summary>Co-signer ceiling of the protocol (docs/SA-MODULE-PROTOCOL.md §9).</summary>
        private const int MaxPolicyMembers = 10;

        private const int CompressedPublicKeyLength = 33;
        private const int SignatureLength = 64;

        public delegate void ThresholdPolicySetHandler(UInt160 accountId, BigInteger threshold, int memberCount);

        [DisplayName("ThresholdPolicySet")]
        public static event ThresholdPolicySetHandler OnThresholdPolicySet = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);

        // ---- module admission (spec §7.3/§12, core AssertCallbackAbi) ----

        /// <summary><c>getModuleProfile()</c>: the canonical capability profile this deployment publishes.</summary>
        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ModuleSupport.Core();

        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        // ---- lifecycle dispatched by the core (spec §9, Table 10) ----

        /// <summary>
        /// <c>onInstall(accountId, moduleId, moduleType, initData)</c>.
        ///
        /// <c>initData</c> is empty, or <c>[threshold, members[]]</c> to publish
        /// the first policy in the same call that installs the module.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            object[] data = ModuleSupport.Copy(initData);
            if (data.Length == 2) Apply(accountId, (object[])data[1], (BigInteger)data[0]);
            else ExecutionEngine.Assert(data.Length == 0, ModuleProtocol.ErrOperationMalformed);
        }

        /// <summary><c>onUninstall(accountId, moduleId, moduleType, deInitData)</c>: the policy leaves with the instance.</summary>
        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_Policy, accountId));
        }

        // ---- §15 policy ----

        /// <summary>
        /// <c>setThresholdPolicy(accountId, threshold, members[])</c>.
        ///
        /// Account policy, so it takes the account's administration authority.
        /// <c>threshold = 0</c> with an empty roster is allowed and means "this
        /// policy approves nothing"; otherwise the threshold must be reachable
        /// by the roster it names.
        /// </summary>
        public static void SetThresholdPolicy(UInt160 accountId, BigInteger threshold, object[] members)
        {
            ModuleSupport.RequireActiveAccount(accountId);
            ModuleSupport.RequireAccountAdministration(accountId);
            Apply(accountId, members, threshold);
        }

        /// <summary>
        /// <c>getThresholdPolicy(accountId) → [members[], threshold, policyNonce, updatedAt]</c>.
        ///
        /// A never-configured account answers with an empty policy rather than a
        /// fault, so a reader can tell "no policy" from "no account".
        /// </summary>
        [Safe]
        public static object[] GetThresholdPolicy(UInt160 accountId)
        {
            object[] policy;
            if (!TryLoadPolicy(accountId, out policy))
                return new object[] { new object[0], BigInteger.Zero, BigInteger.Zero, BigInteger.Zero };
            return new object[] { StdLib.Deserialize((ByteString)policy[0]!), policy[1], policy[2], policy[3] };
        }

        // ---- §15 validation ----

        /// <summary>
        /// The digest a policy member signs for one operation: the core's
        /// operation digest bound to this account and this instance.
        /// </summary>
        [Safe]
        public static ByteString GetMemberDigest(UInt160 accountId, ByteString operationDigest)
        {
            ExecutionEngine.Assert(operationDigest != null && operationDigest.Length == 32,
                ModuleProtocol.ErrOperationMalformed);
            BigInteger moduleId = (BigInteger)Contract.Call(ModuleSupport.RequireCoreConfigured(),
                "getAuthorizedModuleId", CallFlags.ReadOnly,
                new object[] { accountId, ModuleProtocol.PhaseValidation });
            return MemberDigest(accountId, moduleId, operationDigest!);
        }

        /// <summary>
        /// <c>validateUserOp(accountId, operationDigest, operation)</c>.
        ///
        /// The core calls this on the instance it routed to, read-only. Approval
        /// is exactly Boolean true; every other outcome — no policy, an unrouted
        /// instance, short or malformed signature data, too few valid members —
        /// is false, so a caller can never widen the answer by omission.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ModuleSupport.RequireValidationInstance(accountId);
            ExecutionEngine.Assert(operationDigest != null && operationDigest.Length == 32,
                ModuleProtocol.ErrOperationMalformed);
            object[] view = ModuleSupport.Copy(operation);
            // The routed instance must be the one this call is authenticated for.
            if (view.Length < 12) return false;
            if ((BigInteger)view[7] != moduleId) return false;

            object[] policy;
            if (!TryLoadPolicy(accountId, out policy)) return false;
            object[] members = (object[])StdLib.Deserialize((ByteString)policy[0]!);
            BigInteger threshold = (BigInteger)policy[1];
            if (threshold < 1 || threshold > members.Length) return false;

            object signature = view[11];
            // Field 11 is the validator DTO, declared ByteString by the operation shape.
            // A wrong type is a malformed operation, so the cast is the check.
            byte[] raw = (byte[])(ByteString)signature;
            if (raw.Length < SignatureLength) return false;

            ByteString digest = MemberDigest(accountId, moduleId, operationDigest!);
            int capacity = raw.Length / SignatureLength;
            BigInteger valid = 0;
            for (int i = 0; i < members.Length && i < capacity; i++)
            {
                byte[] part = new byte[SignatureLength];
                for (int k = 0; k < SignatureLength; k++) part[k] = raw[i * SignatureLength + k];
                if (VerifyP256(digest, (ByteString)members[i], (ByteString)part)) valid++;
            }
            return valid >= threshold;
        }

        /// <summary>The core completed the operation this instance approved.</summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result) => ModuleSupport.RequireCore();

        // ---- internals ----

        private static void Apply(UInt160 accountId, object[] members, BigInteger threshold)
        {
            object[] roster = ModuleSupport.Copy(members);
            // R-15-02: member count out of 1–10 is SA_MODULE_LIMIT_MEMBERS;
            // threshold out of range is SA_MODULE_LIMIT_THRESHOLD.
            ExecutionEngine.Assert(roster.Length <= MaxPolicyMembers, ModuleProtocol.ErrModuleLimitMembers);
            ExecutionEngine.Assert(threshold >= 0 && threshold <= roster.Length,
                ModuleProtocol.ErrModuleLimitThreshold);

            for (int i = 0; i < roster.Length; i++)
            {
                ByteString member = (ByteString)roster[i];
                // R-15-03: member shape/duplication faults have no dedicated
                // Table 45 symbol — the nearest existing symbol is the core
                // shape symbol.
                ExecutionEngine.Assert(member.Length == CompressedPublicKeyLength,
                    ModuleProtocol.ErrOperationMalformed + " policy member key");
                for (int j = 0; j < i; j++)
                    ExecutionEngine.Assert(StdLib.MemoryCompare((ByteString)roster[j], member) != 0,
                        ModuleProtocol.ErrOperationMalformed + " duplicate policy member");
            }

            object[] previous;
            BigInteger nonce = TryLoadPolicy(accountId, out previous) ? (BigInteger)previous[2] + 1 : BigInteger.One;
            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_Policy, accountId),
                StdLib.Serialize(new object[] { StdLib.Serialize(roster), threshold, nonce, Runtime.Time }));
            OnThresholdPolicySet(accountId, threshold, roster.Length);
        }

        private static bool TryLoadPolicy(UInt160 accountId, out object[] policy)
        {
            policy = new object[0];
            ByteString? data = Storage.Get(Storage.CurrentContext, ModuleSupport.Key(Prefix_Policy, accountId));
            if (data == null) return false;
            object[] stored = (object[])StdLib.Deserialize(data!);
            ExecutionEngine.Assert(stored.Length == 4, ModuleProtocol.ErrOperationMalformed);
            policy = stored;
            return true;
        }

        /// <summary><c>sha256(accountId ‖ moduleId(8 BE) ‖ operationDigest)</c>.</summary>
        private static ByteString MemberDigest(UInt160 accountId, BigInteger moduleId, ByteString operationDigest)
        {
            ExecutionEngine.Assert(moduleId > 0, ModuleProtocol.ErrOperationMalformed + " module id");
            byte[] bound = Helper.Concat(Helper.Concat((byte[])accountId, ModuleSupport.U64BE(moduleId)),
                (byte[])operationDigest);
            return CryptoLib.Sha256((ByteString)bound);
        }

        /// <summary>
        /// secp256r1 / SHA-256 verification of a 64-byte <c>r‖s</c> signature
        /// against a 33-byte compressed key, matching the repository convention
        /// (ValidatorPayload.VerifyP256).
        /// </summary>
        private static bool VerifyP256(ByteString digest, ByteString compressedPublicKey, ByteString signature)
        {
            if (signature.Length != SignatureLength) return false;
            if (compressedPublicKey.Length != CompressedPublicKeyLength) return false;
            return CryptoLib.VerifyWithECDsa(digest, (ECPoint)compressedPublicKey, signature,
                NamedCurveHash.secp256r1SHA256);
        }
    }
}
