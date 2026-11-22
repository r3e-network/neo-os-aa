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
    /// §13 message-signing module (skeleton).
    ///
    /// The minimal core authorizes operations; it says nothing about whether a
    /// message was signed by the account. This module answers exactly that
    /// question in the EIP-1271 shape every verifier already understands:
    /// 4 bytes of magic for a valid signature, 4 bytes of refusal otherwise.
    ///
    /// The module is a <b>validator-type</b> instance (spec §13.1: installed with
    /// module type code 1) that owns the account's message domain and subject
    /// roster, so the core admission gate requires the <c>getModuleProfile</c>
    /// reader plus the <c>validateUserOp</c>/<c>onUserOpComplete</c> routing pair.
    /// The routing callbacks stay fail-closed here: message signatures and
    /// operation signatures are different domains and never interchange
    /// (R-13-15), so this module approves no operation — its authorization
    /// surface is <see cref="IsValidSignature"/>, not the routed operation path.
    ///
    /// Subjects are P-256 public keys and the threshold is how many of them
    /// must sign. A signature is the subjects' 64-byte <c>r‖s</c> values
    /// concatenated in subject order, so one message may carry one signature or
    /// many and the module never guesses which subject signed what. A missing
    /// or malformed entry counts as a non-signature.
    ///
    /// Storage is per account:
    ///   <c>0x01 ‖ accountId</c> → serialized [subjects[], threshold]
    /// </summary>
    [DisplayName("SigningModule")]
    [ContractPermission("*", "getAccount")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ManifestExtra("Description", "Threshold message-signature module (spec §13)")]
    public class SigningModule : SmartContract
    {
        // Canonical module capability profile (docs/SA-MODULE-PROTOCOL.md §12):
        // keys sorted, no whitespace, no trailing newline. The core hashes these
        // exact bytes into the install-time profile digest. The module declares
        // messageCapability: it owns the §13 message domain and answers the
        // ERC-1271 question through its own read-only isValidSignature entry (the
        // core's six-argument message callback is a reserved surface in this
        // deployment). The subject roster is keyed by account, so a second
        // instance of the same contract on one account is refused by the core
        // (instanceIsolation false).
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":true,\"thresholdMemberEligible\":false},\"contractName\":\"SigningModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Subjects = new byte[] { 0x01 };

        /// <summary>EIP-1271 <c>isValidSignature(bytes32,bytes)</c> magic value.</summary>
        private static readonly byte[] MagicValid = new byte[] { 0x16, 0x26, 0xba, 0x7e };

        /// <summary>Anything that is not <see cref="MagicValid"/>; the 1271 failure value.</summary>
        private static readonly byte[] MagicFailed = new byte[] { 0xff, 0xff, 0xff, 0xff };

        private const int CompressedPublicKeyLength = 33;
        private const int SignatureLength = 64;

        public delegate void MessageSubjectsUpdatedHandler(UInt160 accountId, int subjectCount, BigInteger threshold);

        [DisplayName("MessageSubjectsUpdated")]
        public static event MessageSubjectsUpdatedHandler OnMessageSubjectsUpdated = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);

        // ---- module admission (spec §7.3/§12, core AssertCallbackAbi) ----

        /// <summary><c>getModuleProfile()</c>: the canonical capability profile this deployment publishes.</summary>
        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ModuleSupport.Core();

        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        // ---- §13 routing callbacks (validator-type admission, fail-closed) ----

        /// <summary>
        /// <c>validateUserOp(accountId, operationDigest, operation)</c>: the core
        /// calls this when an operation is routed to this instance. The module
        /// owns the <b>message</b> domain (§13.4), and message signatures never
        /// authorize operations (R-13-15 domain separation), so the skeleton
        /// refuses every operation — fail-closed, an account that needs an
        /// operation validator routes to a validator that implements one.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ModuleSupport.RequireValidationInstance(accountId);
            object[] view = ModuleSupport.Copy(operation);
            if (view.Length < 12) return false;
            if ((BigInteger)view[7] != moduleId) return false;
            // The message module approves no operation (R-13-15).
            return false;
        }

        /// <summary>
        /// <c>onUserOpComplete(accountId, operation, result)</c>: caller-validated
        /// no-op. The module signs no operations, so nothing it approved can
        /// reach completion; the gate stays so future state writes are guarded
        /// by construction.
        /// </summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
            => ModuleSupport.RequireCore();

        // ---- lifecycle dispatched by the core (spec §9, Table 10) ----

        /// <summary>
        /// <c>onInstall(accountId, moduleId, moduleType, initData)</c>.
        ///
        /// <c>initData</c> is empty, or <c>[subjects[], threshold]</c> to publish the
        /// first roster in the same call that installs the module.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            object[] data = ModuleSupport.Copy(initData);
            if (data.Length == 2) Apply(accountId, (object[])data[0], (BigInteger)data[1]);
            else ExecutionEngine.Assert(data.Length == 0, ModuleProtocol.ErrOperationMalformed);
        }

        /// <summary><c>onUninstall(accountId, moduleId, moduleType, deInitData)</c>: the roster leaves with the instance.</summary>
        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_Subjects, accountId));
        }

        // ---- §13 message signatures ----

        /// <summary>
        /// <c>isValidSignature(accountId, hash, signature) → 0x1626ba7e | 0xffffffff</c>.
        ///
        /// Read-only and witness-free: a verifier has to be able to ask this
        /// of any node. <paramref name="hash"/> is the 32-byte digest the
        /// subjects signed.
        /// </summary>
        [Safe]
        public static ByteString IsValidSignature(UInt160 accountId, ByteString hash, ByteString signature)
        {
            ExecutionEngine.Assert(accountId != UInt160.Zero && accountId.IsValid, ModuleProtocol.ErrOperationMalformed);
            if (hash == null || hash.Length != 32 || signature == null) return (ByteString)MagicFailed;

            object[] record;
            if (!TryLoadSubjects(accountId, out record)) return (ByteString)MagicFailed;
            object[] subjects = (object[])StdLib.Deserialize((ByteString)record[0]!);
            BigInteger threshold = (BigInteger)record[1];
            if (threshold < 1) return (ByteString)MagicFailed;

            byte[] raw = (byte[])signature;
            BigInteger valid = 0;
            int capacity = raw.Length / SignatureLength;
            for (int i = 0; i < subjects.Length && i < capacity; i++)
            {
                byte[] part = new byte[SignatureLength];
                for (int k = 0; k < SignatureLength; k++) part[k] = raw[i * SignatureLength + k];
                if (VerifyP256(hash, (ByteString)subjects[i], (ByteString)part)) valid++;
            }
            return valid >= threshold ? (ByteString)MagicValid : (ByteString)MagicFailed;
        }

        /// <summary>
        /// <c>updateMessageSubject(accountId, subjects[], threshold)</c>.
        ///
        /// The subject roster and its threshold are account policy, so they take
        /// the account's administration authority. An empty roster with
        /// threshold 0 is allowed and means "this account signs no messages".
        /// </summary>
        public static void UpdateMessageSubject(UInt160 accountId, object[] subjects, BigInteger threshold)
        {
            ModuleSupport.RequireActiveAccount(accountId);
            ModuleSupport.RequireAccountAdministration(accountId);
            Apply(accountId, subjects, threshold);
        }

        /// <summary><c>getMessageSubjects(accountId) → [subjects[], threshold]</c>.</summary>
        [Safe]
        public static object[] GetMessageSubjects(UInt160 accountId)
        {
            object[] record;
            // An account that never configured subjects answers with an empty
            // roster, not with a fault.
            if (!TryLoadSubjects(accountId, out record)) return new object[] { new object[0], BigInteger.Zero };
            return new object[] { StdLib.Deserialize((ByteString)record[0]!), record[1] };
        }

        // ---- internals ----

        /// <summary>Validates and stores one roster; the install callback and the ABI share it.</summary>
        private static void Apply(UInt160 accountId, object[] subjects, BigInteger threshold)
        {
            object[] roster = ModuleSupport.Copy(subjects);
            // Table 45 has no SigningModule symbol for roster-shape faults
            // (SA_MESSAGE_INVALID is the isValidSignature folding rule), so
            // the nearest existing symbol is the core shape symbol.
            ExecutionEngine.Assert(threshold >= 0 && threshold <= roster.Length,
                ModuleProtocol.ErrOperationMalformed + " message threshold");

            for (int i = 0; i < roster.Length; i++)
            {
                ByteString subject = (ByteString)roster[i];
                ExecutionEngine.Assert(subject.Length == CompressedPublicKeyLength,
                    ModuleProtocol.ErrOperationMalformed + " message subject key");
                for (int j = 0; j < i; j++)
                    ExecutionEngine.Assert(StdLib.MemoryCompare((ByteString)roster[j], subject) != 0,
                        ModuleProtocol.ErrOperationMalformed + " duplicate message subject");
            }

            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_Subjects, accountId),
                StdLib.Serialize(new object[] { StdLib.Serialize(roster), threshold }));
            OnMessageSubjectsUpdated(accountId, roster.Length, threshold);
        }

        /// <summary>Subjects are stored serialized so a roster read never re-encodes policy.</summary>
        private static bool TryLoadSubjects(UInt160 accountId, out object[] record)
        {
            record = new object[0];
            ByteString? data = Storage.Get(Storage.CurrentContext, ModuleSupport.Key(Prefix_Subjects, accountId));
            if (data == null) return false;
            object[] stored = (object[])StdLib.Deserialize(data!);
            ExecutionEngine.Assert(stored.Length == 2, ModuleProtocol.ErrOperationMalformed);
            record = stored;
            return true;
        }

        /// <summary>
        /// secp256r1 / SHA-256 verification of a 64-byte <c>r‖s</c> signature
        /// against a 33-byte compressed key, matching the validator convention
        /// of this repository (ValidatorPayload.VerifyP256).
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
