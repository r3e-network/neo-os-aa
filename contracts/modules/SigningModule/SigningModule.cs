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
    /// Module-owned message authorization (SA-MODULE-PROTOCOL §8).
    ///
    /// <c>isValidSignature</c> is the only public message entry. It is safe,
    /// read-only and fail-closed: every malformed input, stale generation,
    /// changed epoch, unknown subject or bad signature returns false instead of
    /// throwing, so the answer cannot be used as a state oracle. The companion
    /// <c>validateMessageSignature</c> returns the strict ERC-1271 magic bytes
    /// (<c>0x1626ba7e</c> / <c>0xffffffff</c>) for clients.
    ///
    /// The module owns:
    ///   * the message digest domain
    ///     <c>SHA-256("NeoSmartAccount/Message" ‖ version ‖ network ‖ core ‖
    ///      account ‖ sender ‖ validatorId ‖ generation ‖ epoch ‖ hash)</c>;
    ///   * the subject roster (HASH160 or SHA-256 of a canonical P-256 script);
    ///   * the approval threshold;
    ///   * the credential generation captured when the policy was configured.
    ///
    /// P-256 is verified by the platform's CryptoLib native contract (§14).
    /// Neo 3.10.1 only exposes curve-hash P-256 modes, so the module hands the
    /// native entry the preimage of the §8 digest: the platform's single
    /// SHA-256 is then the digest itself, and the subject's signature over that
    /// digest verifies without any second hash.
    /// </summary>
    [DisplayName("SigningModule")]
    [ContractPermission("*", "getAccount")]
    [ContractPermission("*", "getModule")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getContract")]
    [ManifestExtra("Description", "Module-owned P-256 message subject and quorum policy")]
    public class SigningModule : SmartContract
    {
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\",\"isValidSignature\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":true,\"messageCapability\":true,\"thresholdMemberEligible\":false},\"contractName\":\"SigningModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Policy = new byte[] { 0x01 };
        private static readonly byte[] MessageDomain = new byte[]
        {
            0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74, 0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74,
            0x2F, 0x4D, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65,
        };

        private static readonly byte[] CheckSigSyscallHash = new byte[] { 0x56, 0xE7, 0xB3, 0x27 };
        private static readonly byte[] MagicValid = new byte[] { 0x16, 0x26, 0xBA, 0x7E };
        private static readonly byte[] MagicInvalid = new byte[] { 0xFF, 0xFF, 0xFF, 0xFF };

        private const int MaxSubjects = 16;
        private const int CanonicalScriptSize = 40;
        private const int SignatureSize = 64;
        private const int MessageHashSize = 32;

        private const int FieldSubjects = 0;
        private const int FieldThreshold = 1;
        private const int FieldRevision = 2;
        private const int FieldGeneration = 3;
        private const int PolicyFields = 4;

        public delegate void MessagePolicyUpdatedHandler(UInt160 accountId, BigInteger moduleId,
            int subjectCount, BigInteger threshold, BigInteger revision, BigInteger generation);

        [DisplayName("MessagePolicyUpdated")]
        public static event MessagePolicyUpdatedHandler OnMessagePolicyUpdated = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);
        [Safe] public static string GetModuleProfile() => ModuleProfileJson;
        [Safe] public static UInt160 AuthorizedCore() => ModuleSupport.Core();
        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        // ---- lifecycle ----

        /// <summary><c>initData</c> must be empty; subjects and quorum arrive through a governed configure.</summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert(moduleType == ModuleProtocol.ModuleTypeValidator, ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(initData == null || initData.Length == 0, ModuleProtocol.ErrOperationMalformed);
        }

        /// <summary><c>configData</c> is <c>[subjects[], threshold]</c>.</summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert(moduleType == ModuleProtocol.ModuleTypeValidator, ModuleProtocol.ErrOperationMalformed);
            ApplyPolicy(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            Storage.Delete(Storage.CurrentContext, PolicyKey(accountId, moduleId));
        }

        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            ModuleSupport.RequireValidationInstance(accountId);
            return false;
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
            => ModuleSupport.RequireCore();

        // ---- message entry ----

        /// <summary>
        /// Six-argument message callback. <paramref name="pairs"/> is a flat
        /// <c>[canonicalP256Script0, signature0, canonicalP256Script1,
        /// signature1, ...]</c> array: each element is a ByteString, so the
        /// reply never depends on a nested container type. The call is
        /// answered with false for every failure mode and never asserts; it
        /// only reads state.
        /// </summary>
        [Safe]
        public static bool IsValidSignature(UInt160 accountId, UInt160 originalSender, BigInteger validatorId,
            BigInteger generation, ByteString hash, object[] pairs)
        {
            if (accountId == UInt160.Zero || !accountId.IsValid) return false;
            if (validatorId < 1 || generation < 1) return false;
            if (hash == null || hash.Length != MessageHashSize) return false;
            if (pairs == null || pairs.Length < 2 || pairs.Length > MaxSubjects * 2) return false;
            if ((pairs.Length & 1) != 0) return false;
            if (ModuleSupport.Core() == UInt160.Zero) return false;

            object[]? account = ModuleSupport.TryAccountRecord(accountId);
            if (account == null) return false;
            if ((BigInteger)account![ModuleSupport.FieldStatus] != ModuleProtocol.StatusActive) return false;

            object[]? descriptor = ModuleSupport.TryModuleDescriptor(accountId, validatorId);
            if (descriptor == null) return false;
            if ((UInt160)descriptor![ModuleSupport.FieldModuleContractHash] != Runtime.ExecutingScriptHash)
                return false;
            if ((BigInteger)descriptor[ModuleSupport.FieldModuleType] != ModuleProtocol.ModuleTypeValidator)
                return false;
            if (!(bool)descriptor[ModuleSupport.FieldModuleMessageCapability]) return false;
            if (!ModuleSupport.HasLiveCodeBinding(Runtime.ExecutingScriptHash, descriptor)) return false;
            if (generation != (BigInteger)descriptor[ModuleSupport.FieldModuleCredentialGeneration]) return false;

            object[]? policy = TryLoadPolicy(accountId, validatorId);
            if (policy == null) return false;
            if (generation != (BigInteger)policy![FieldGeneration]) return false;

            BigInteger epoch = (BigInteger)account[ModuleSupport.FieldAuthorityEpoch];
            // The preimage of the §8 digest: the platform hashes it exactly once
            // inside verifyWithECDsa, so the signed bytes are SHA-256(preimage).
            byte[] preimage = MessagePreimage(accountId, originalSender, validatorId, generation, epoch,
                (byte[])hash!);
            object[] subjects = (object[])policy[FieldSubjects];
            BigInteger threshold = (BigInteger)policy[FieldThreshold];
            int approved = 0;

            for (int i = 0; i < pairs!.Length; i += 2)
            {
                if (!(pairs[i] is ByteString)) return false;
                if (!(pairs[i + 1] is ByteString)) return false;
                ByteString script = (ByteString)pairs[i];
                ByteString signature = (ByteString)pairs[i + 1];
                if (script.Length != CanonicalScriptSize || signature.Length != SignatureSize) return false;
                byte[] raw = (byte[])script;
                if (raw[0] != 0x0C || raw[1] != 0x21 || (raw[2] != 0x02 && raw[2] != 0x03)
                    || raw[35] != 0x41 || !RawEqual(raw, 36, CheckSigSyscallHash, 0, 4)) return false;
                for (int j = 0; j < i; j += 2)
                    if (StdLib.MemoryCompare(script, (ByteString)pairs[j]) == 0) return false;

                bool authorized = false;
                for (int j = 0; j < subjects.Length; j++)
                {
                    if (subjects[j] is not ByteString subject) return false;
                    if (subject.Length == 20)
                        authorized = StdLib.MemoryCompare(
                            CryptoLib.Ripemd160(CryptoLib.Sha256(script)), subject) == 0;
                    else if (subject.Length == 32)
                        authorized = StdLib.MemoryCompare(CryptoLib.Sha256(script), subject) == 0;
                    if (authorized) break;
                }
                if (!authorized) return false;

                byte[] point = new byte[33];
                for (int j = 0; j < point.Length; j++) point[j] = raw[j + 2];
                if (P256.VerifyMessage(preimage, point, (byte[])signature))
                    approved++;
            }
            return (BigInteger)approved >= threshold;
        }

        /// <summary>ERC-1271 answer: the strict 4-byte magic value, never a fault.</summary>
        [Safe]
        public static ByteString ValidateMessageSignature(UInt160 accountId, UInt160 originalSender,
            BigInteger validatorId, BigInteger generation, ByteString hash, object[] pairs)
        {
            return IsValidSignature(accountId, originalSender, validatorId, generation, hash, pairs)
                ? (ByteString)MagicValid : (ByteString)MagicInvalid;
        }

        /// <summary>Returns <c>[subjects[], threshold, revision, generation]</c>, or empty.</summary>
        [Safe]
        public static object[] GetMessagePolicy(UInt160 accountId, BigInteger moduleId)
        {
            object[]? policy = TryLoadPolicy(accountId, moduleId);
            return policy == null ? new object[0] : policy!;
        }

        // ---- policy ----

        private static void ApplyPolicy(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(data != null && data!.Length == 2, ModuleProtocol.ErrOperationMalformed);
            object[] subjects = ModuleSupport.Copy((object[])data![0]);
            ExecutionEngine.Assert(subjects.Length >= 1 && subjects.Length <= MaxSubjects,
                ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(data[1] is BigInteger, ModuleProtocol.ErrOperationMalformed);
            BigInteger threshold = (BigInteger)data[1];
            ExecutionEngine.Assert(threshold >= 1 && threshold <= subjects.Length,
                ModuleProtocol.ErrModuleLimitThreshold);

            for (int i = 0; i < subjects.Length; i++)
            {
                ExecutionEngine.Assert(subjects[i] is ByteString, ModuleProtocol.ErrOperationMalformed);
                ByteString subject = (ByteString)subjects[i];
                ExecutionEngine.Assert(subject.Length == 20 || subject.Length == 32,
                    ModuleProtocol.ErrOperationMalformed);
                for (int j = 0; j < i; j++)
                    ExecutionEngine.Assert(StdLib.MemoryCompare(subject, (ByteString)subjects[j]) != 0,
                        ModuleProtocol.ErrOperationMalformed);
            }

            object[] descriptor = ModuleSupport.ModuleDescriptor(accountId, moduleId);
            BigInteger generation = (BigInteger)descriptor[ModuleSupport.FieldModuleCredentialGeneration];
            BigInteger revision = LoadRevision(accountId, moduleId) + 1;
            Storage.Put(Storage.CurrentContext, PolicyKey(accountId, moduleId),
                StdLib.Serialize(new object[] { subjects, threshold, revision, generation }));
            OnMessagePolicyUpdated(accountId, moduleId, subjects.Length, threshold, revision, generation);
        }

        private static object[]? TryLoadPolicy(UInt160 accountId, BigInteger moduleId)
        {
            if (moduleId < 1) return null;
            ByteString? data = Storage.Get(Storage.CurrentContext, PolicyKey(accountId, moduleId));
            if (data == null) return null;
            object value = StdLib.Deserialize(data!);
            if (value == null) return null;
            object[] policy = (object[])value;
            if (policy.Length != PolicyFields) return null;
            if (!(policy[FieldThreshold] is BigInteger) || !(policy[FieldRevision] is BigInteger)
                || !(policy[FieldGeneration] is BigInteger)) return null;
            object[] subjects = (object[])policy[FieldSubjects];
            if (subjects.Length < 1 || subjects.Length > MaxSubjects) return null;
            return policy;
        }

        private static BigInteger LoadRevision(UInt160 accountId, BigInteger moduleId)
        {
            object[]? policy = TryLoadPolicy(accountId, moduleId);
            return policy == null ? BigInteger.Zero : (BigInteger)policy![FieldRevision];
        }

        /// <summary>
        /// The §8 digest preimage: <c>"NeoSmartAccount/Message" ‖ 0x04 ‖
        /// U32LE(network) ‖ coreHash ‖ accountId ‖ originalSender ‖
        /// U64BE(validatorId) ‖ U64BE(generation) ‖ U64BE(epoch) ‖ hash</c>.
        /// The digest itself is SHA-256 of these bytes and is never computed
        /// here: the platform's verify step performs that hash.
        /// </summary>
        private static byte[] MessagePreimage(UInt160 accountId, UInt160 originalSender, BigInteger validatorId,
            BigInteger generation, BigInteger epoch, byte[] hash)
        {
            byte[] domain = Helper.Concat(
                Helper.Concat(Helper.Concat(MessageDomain, new byte[] { 4 }),
                    ModuleSupport.U32LE(Runtime.GetNetwork())),
                ModuleSupport.CoreHash());
            byte[] bound = Helper.Concat(domain, (byte[])accountId);
            bound = Helper.Concat(bound, (byte[])originalSender);
            bound = Helper.Concat(bound, ModuleSupport.U64BE(validatorId));
            bound = Helper.Concat(bound, ModuleSupport.U64BE(generation));
            bound = Helper.Concat(bound, ModuleSupport.U64BE(epoch));
            return Helper.Concat(bound, hash);
        }

        private static bool RawEqual(byte[] left, int leftOffset, byte[] right, int rightOffset, int length)
        {
            for (int i = 0; i < length; i++)
                if (left[leftOffset + i] != right[rightOffset + i]) return false;
            return true;
        }

        private static byte[] PolicyKey(UInt160 accountId, BigInteger moduleId) =>
            ModuleSupport.Key(Prefix_Policy, accountId, moduleId);
    }
}
