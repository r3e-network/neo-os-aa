using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Validators
{
    /// <summary>
    /// Validator for short-lived delegated session keys.
    /// </summary>
    /// <remarks>
    /// Intended for constrained delegation, such as a bot or game session that may
    /// call only one contract and one method until a fixed expiry time. One
    /// instance holds exactly one session grant; an account that needs several
    /// concurrent sessions installs several instances of this contract
    /// (<c>instanceIsolation</c>, docs/SA-MODULE-PROTOCOL.md §3.2), each with its
    /// own storage, nonce channels and credential generation.
    /// A grant is bound to the credential generation it was configured under:
    /// <c>revokeCredentials</c> on the core bumps the generation and the stored
    /// grant stops validating immediately, without any callback into this
    /// contract.
    /// Signature DTO (spec §5), 96 bytes: <c>grantDigest(32) ‖ r‖s(64)</c>. The
    /// grant digest names the session credential, its scope and its expiry and
    /// must equal the instance's current grant; the signature is secp256r1 over
    /// the core operation digest. A session key never answers message checks and
    /// is never a threshold-policy member.
    /// </remarks>
    [DisplayName("SessionKeyValidator")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "getAuthorizedModuleId", "getModule", "getAccountAddress")]
    [ManifestExtra("SmartAccountProfile", "native-v4")]
#else
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModule")]
    [ContractPermission("*", "getProxyScriptHash")]
#endif
    [ManifestExtra("Description", "Temporary session-key validator for high-frequency actions")]
    public class SessionKeyValidator : SmartContract
    {
        // Canonical bytes of SessionKeyValidator.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":true,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"SessionKeyValidator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        // (accountId, moduleId) -> serialized
        //   [pubKey(33), targetContract, method, validUntil, spendingLimit, generation, grantDigest(32)]
        private static readonly byte[] Prefix_Grant = new byte[] { 0x01 };
        // (accountId, moduleId) -> serialized [createdAt, description]
        private static readonly byte[] Prefix_Metadata = new byte[] { 0x02 };
        // (accountId, moduleId) -> total spent under the instance's spending limit
        private static readonly byte[] Prefix_SpentAmount = new byte[] { 0x03 };
        // (accountId, moduleId) -> timestamp of the last grant (rotation cooldown)
        private static readonly byte[] Prefix_LastKeyRotation = new byte[] { 0x04 };
        // (accountId, moduleId) -> timestamp of the last completed operation
        private static readonly byte[] Prefix_LastUsedAt = new byte[] { 0x05 };

        private const int GrantFieldCount = 7;
        private const int GrantDigestLength = 32;
        private const int SignatureLength = 64;

        // Key rotation cooldown: 24 hours in milliseconds to match Runtime.Time
        private static readonly BigInteger KeyRotationCooldownMs = 24L * 60 * 60 * 1000;

        // Maximum session key lifetime: 30 days in milliseconds
        private static readonly BigInteger MaxSessionDurationMs = 30L * 24 * 60 * 60 * 1000;

        // UTF8("NeoSmartAccount/SessionGrant")
        private static readonly byte[] GrantDomain = new byte[]
        {
            0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74,
            0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F,
            0x53, 0x65, 0x73, 0x73, 0x69, 0x6F, 0x6E, 0x47,
            0x72, 0x61, 0x6E, 0x74
        };

        // Emitted whenever a session key is configured so off-chain consumers can audit its real
        // scope. The uncapped flag is true when the key carries no enforceable spending cap for its
        // target: a wildcard ("*") method authorizes value movement under any method, and a zero
        // SpendingLimit means no cap is tracked. Either way the key can move the account's whole
        // balance on a value-bearing target, which the one-target/one-method UI does not imply.
        public delegate void SessionKeyGrantedDelegate(
            UInt160 accountId, BigInteger moduleId, ByteString pubKey, UInt160 targetContract, string method,
            BigInteger validUntil, BigInteger spendingLimit, bool uncapped);

        [DisplayName("SessionKeyGranted")]
        public static event SessionKeyGrantedDelegate OnSessionKeyGranted = null!;

        // Revocation is ordered by Neo transaction execution. Consumers can use this event to
        // invalidate cached or pending session-key work; it does not rewrite an operation that
        // was already executed earlier in canonical chain order. A core-side revokeCredentials
        // is callback-free and is observed through the core's CredentialRevoked event instead.
        public delegate void SessionKeyRevokedDelegate(UInt160 accountId, BigInteger moduleId);

        [DisplayName("SessionKeyRevoked")]
        public static event SessionKeyRevokedDelegate OnSessionKeyRevoked = null!;

        public static void _deploy(object data, bool update) => ValidatorAuthority.Initialize(data, update);

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ValidatorAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with hooks): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => ValidatorAuthority.CancelAuthorizedCoreChange();

        // SA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => ValidatorAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);

        public static void CancelUpdate() => ValidatorAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);

        /// <summary>
        /// <c>initData</c>: empty, or one <c>setSessionKey</c> command (see <see cref="Configure"/>).
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, generation, initData);
        }

        /// <summary>
        /// <c>configData</c>:
        /// <c>["setSessionKey", pubKey, targetContract, method, validUntil, spendingLimit, description]</c>
        /// or <c>["clearSessionKey"]</c>.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, generation, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_Grant, accountId, moduleId));
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_Metadata, accountId, moduleId));
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_SpentAmount, accountId, moduleId));
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_LastKeyRotation, accountId, moduleId));
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_LastUsedAt, accountId, moduleId));
            OnSessionKeyRevoked(accountId, moduleId);
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] data)
        {
            string command = ModuleConfig.Name(data);
            if (command == "setSessionKey")
            {
                ModuleConfig.RequireArgs(data, 6);
                SetSessionKey(accountId, moduleId, generation, (ByteString)data[1], (UInt160)data[2], (string)data[3],
                    (BigInteger)data[4], (BigInteger)data[5], (string)data[6]);
                return;
            }
            if (command == "clearSessionKey")
            {
                ModuleConfig.RequireArgs(data, 0);
                ClearSessionKey(accountId, moduleId);
                return;
            }
            ExecutionEngine.Assert(false, "Unknown config command");
        }

        /// <summary>
        /// Configures the instance's session key and its target/method/expiry scope.
        /// </summary>
        private static void SetSessionKey(UInt160 accountId, BigInteger moduleId, BigInteger generation, ByteString pubKey,
            UInt160 targetContract, string method, BigInteger validUntil, BigInteger spendingLimit, string description)
        {
            ByteString sessionKey = ValidatorKeys.Compress(pubKey);
            ExecutionEngine.Assert(targetContract != null && targetContract.IsValid && targetContract != UInt160.Zero, "Invalid target contract");
            ByteString methodBytes = (ByteString)method;
            ExecutionEngine.Assert(methodBytes != null && methodBytes.Length > 0 && methodBytes.Length <= 255, "Invalid session key method");
            ExecutionEngine.Assert(validUntil > Runtime.Time, "Session key must expire in the future");
            ExecutionEngine.Assert(validUntil <= Runtime.Time + MaxSessionDurationMs, "Session key lifetime exceeds maximum of 30 days");
            ExecutionEngine.Assert(spendingLimit >= 0, "Spending limit must be non-negative");
            // Fail closed: the spending limit can only be enforced on the value-moving "transfer"
            // path (see TransferValue). Reject a positive limit on any wildcard or
            // non-transfer session key so the configured cap is never silently unenforced.
            ExecutionEngine.Assert(spendingLimit == 0 || method == "transfer", "Spending limit only enforceable on transfer session keys");
            ExecutionEngine.Assert(description == null || description.Length <= 128, "Description too long (max 128 chars)");

            // Enforce key rotation cooldown to prevent spending limit bypass via rapid key rotation
            byte[] rotationKey = ValidatorAuthority.InstanceKey(Prefix_LastKeyRotation, accountId, moduleId);
            ByteString? lastRotationData = Storage.Get(Storage.CurrentContext, rotationKey);
            if (lastRotationData != null)
            {
                BigInteger lastRotation = (BigInteger)lastRotationData;
                ExecutionEngine.Assert(Runtime.Time >= lastRotation + KeyRotationCooldownMs, "Key rotation cooldown active (24h)");
            }

            ByteString grantDigest = ComputeGrantDigest(accountId, moduleId, generation, sessionKey, targetContract!,
                methodBytes!, validUntil, spendingLimit);
            Storage.Put(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_Grant, accountId, moduleId),
                StdLib.Serialize(new object[] { sessionKey, targetContract!, method, validUntil, spendingLimit, generation, grantDigest }));
            Storage.Put(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_Metadata, accountId, moduleId),
                StdLib.Serialize(new object[] { (BigInteger)Runtime.Time, description ?? string.Empty }));
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_LastUsedAt, accountId, moduleId));

            // Record rotation timestamp for cooldown enforcement
            Storage.Put(Storage.CurrentContext, rotationKey, Runtime.Time);

            // Do NOT reset spending tracking — prevent spending limit bypass via key rotation

            // Surface the key's true value exposure. A wildcard method, or any key with no spending
            // limit, can move the whole balance on a value-bearing target with no on-chain cap; the
            // assert above only blocks a *positive* limit on a non-transfer key.
            bool uncapped = method == "*" || spendingLimit == 0;
            OnSessionKeyGranted(accountId, moduleId, sessionKey, targetContract!, method, validUntil, spendingLimit, uncapped);
        }

        /// <summary>
        /// Removes the instance's delegated session key.
        /// </summary>
        private static void ClearSessionKey(UInt160 accountId, BigInteger moduleId)
        {
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_Grant, accountId, moduleId));
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_Metadata, accountId, moduleId));
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_SpentAmount, accountId, moduleId));
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_LastUsedAt, accountId, moduleId));
            // A successful clear is an explicit revocation command. Emit even when the key was
            // already absent so indexers can converge on the canonical ordering of the command.
            OnSessionKeyRevoked(accountId, moduleId);
        }

        /// <summary>
        /// <c>[pubKey, targetContract, method, validUntil, spendingLimit, generation, grantDigest]</c>,
        /// or an empty array when the instance holds no grant.
        /// </summary>
        [Safe]
        public static object[] GetSessionKey(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_Grant, accountId, moduleId));
            if (data == null) return new object[0];
            return (object[])StdLib.Deserialize(data);
        }

        /// <summary><c>[createdAt, lastUsedAt, description]</c>, or an empty array.</summary>
        [Safe]
        public static object[] GetSessionKeyMetadata(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_Metadata, accountId, moduleId));
            if (data == null) return new object[0];
            object[] stored = (object[])StdLib.Deserialize(data);
            ByteString? lastUsed = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_LastUsedAt, accountId, moduleId));
            return new object[] { stored[0], lastUsed == null ? BigInteger.Zero : (BigInteger)lastUsed, stored[1] };
        }

        /// <summary>The digest a signature DTO must carry, or empty when the instance holds no grant.</summary>
        [Safe]
        public static ByteString GetGrantDigest(UInt160 accountId, BigInteger moduleId)
        {
            object[] grant = GetSessionKey(accountId, moduleId);
            return grant.Length == GrantFieldCount ? (ByteString)grant[6] : (ByteString)"";
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId)
        {
            object[] grant = GetSessionKey(accountId, moduleId);
            ExecutionEngine.Assert(grant.Length == GrantFieldCount, "No session key active");
            return new ByteString[] { SignerDomain.Secp256r1((ByteString)grant[0]) };
        }

        [Safe]
        public static BigInteger GetSpentAmount(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_SpentAmount, accountId, moduleId));
            return data == null ? 0 : (BigInteger)data;
        }

        /// <summary>
        /// Validates the delegated session signature and enforces the grant's
        /// generation, expiry, contract/method scope and spending cap. Rejects by
        /// returning false.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
            // A session key is the routed validator or nothing: never a policy member.
            if (ModuleOperation.ValidatorId(operation) != moduleId) return false;
            if (operationDigest == null || operationDigest.Length != 32) return false;

            object[] grant = GetSessionKey(accountId, moduleId);
            if (grant.Length != GrantFieldCount) return false;
            // The grant dies with the credential generation it was issued under.
            if ((BigInteger)operation[ModuleOperation.FieldCredentialGeneration] != (BigInteger)grant[5]) return false;
            if (Now() > (BigInteger)grant[3]) return false;
            if (ModuleOperation.Target(operation) != (UInt160)grant[1]) return false;
            string method = ModuleOperation.Method(operation);
            string grantedMethod = (string)grant[2];
            // Allow wildcard method if configured
            if (grantedMethod != "*" && method != grantedMethod) return false;

            byte[] dto = (byte[])ModuleOperation.Signature(operation);
            if (dto.Length != GrantDigestLength + SignatureLength) return false;
            if ((ByteString)Helper.Range(dto, 0, GrantDigestLength) != (ByteString)grant[6]) return false;

            // NEP-17 transfers have one precise value-bearing ABI, even for uncapped keys.
            BigInteger operationValue = 0;
            if (method == "transfer")
            {
                operationValue = TransferValue(accountId, operation);
                if (operationValue < 0) return false;
            }
            BigInteger spendingLimit = (BigInteger)grant[4];
            // Audit fix M-2: a lowered cap can already be below historical spending.
            // Zero value must not bypass that policy boundary merely because it adds
            // no debit; the check is unconditional once a cap is configured.
            if (spendingLimit > 0 && GetSpentAmount(accountId, moduleId) + operationValue > spendingLimit) return false;

            return ValidatorPayload.VerifyP256(operationDigest, (ByteString)grant[0],
                (ByteString)Helper.Range(dto, GrantDigestLength, SignatureLength));
        }

        /// <summary>
        /// Books the spend of the completed operation and records the last use. A
        /// failed NEP-17 transfer faults here and reverts the whole user operation,
        /// including its nonce.
        /// </summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            BigInteger moduleId = ValidatorAuthority.RequireCompletion(accountId, operation);
            object[] grant = GetSessionKey(accountId, moduleId);
            ExecutionEngine.Assert(grant.Length == GrantFieldCount, "No session key active");

            BigInteger operationValue = 0;
            if (ModuleOperation.Method(operation) == "transfer")
            {
                // A token rejection must revert the entire user operation, including its
                // nonce and any token writes. Generic non-transfer business values are valid.
                ExecutionEngine.Assert(result is bool accepted && accepted, "NEP-17 transfer failed");
                operationValue = TransferValue(accountId, operation);
                ExecutionEngine.Assert(operationValue >= 0, "Invalid NEP-17 transfer args");
            }

            BigInteger spendingLimit = (BigInteger)grant[4];
            if (spendingLimit > 0)
            {
                // Enforce the cap unconditionally (zero-value operations included); only
                // the debit write itself stays conditional on an actual balance change.
                BigInteger spent = GetSpentAmount(accountId, moduleId);
                ExecutionEngine.Assert(spent + operationValue <= spendingLimit, "Session key spending limit exceeded");
                if (operationValue > 0)
                {
                    Storage.Put(Storage.CurrentContext,
                        ValidatorAuthority.InstanceKey(Prefix_SpentAmount, accountId, moduleId), spent + operationValue);
                }
            }

            // A fixed-size timestamp update avoids rewriting the immutable description.
            Storage.Put(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_LastUsedAt, accountId, moduleId), Runtime.Time);
        }

        /// <summary>
        /// The amount of an exact NEP-17 <c>transfer(from, to, amount, data)</c> whose source
        /// is the account's asset address, or -1 for any other encoding. Ambiguous transfer
        /// encodings are rejected before the session cap is applied.
        /// </summary>
        private static BigInteger TransferValue(UInt160 accountId, object[] operation)
        {
            object[] args = ModuleOperation.Args(operation);
            if (args == null || args.Length != 4) return -1;
            if (!(args[0] is ByteString) || ((ByteString)args[0]).Length != 20) return -1;
            if (!(args[1] is ByteString) || ((ByteString)args[1]).Length != 20) return -1;
            if (!(args[2] is BigInteger)) return -1;
            BigInteger amount = (BigInteger)args[2];
            if (amount < 0) return -1;
            if ((UInt160)args[1] == UInt160.Zero) return -1;
            if ((UInt160)args[0] != ValidatorAuthority.AssetAddress(accountId)) return -1;
            return amount;
        }

        private static BigInteger Now()
        {
#if SMARTACCOUNT_NATIVE
            return ValidatorClock.Now();
#else
            return Runtime.Time;
#endif
        }

        // SHA256("NeoSmartAccount/SessionGrant" ‖ U1(4) ‖ accountId ‖ U64BE(moduleId) ‖
        //   U64BE(generation) ‖ pubKey(33) ‖ targetContract(20) ‖ U8(methodLength) ‖ method ‖
        //   U64BE(validUntil) ‖ U256(spendingLimit))
        private static ByteString ComputeGrantDigest(UInt160 accountId, BigInteger moduleId, BigInteger generation,
            ByteString sessionKey, UInt160 targetContract, ByteString method, BigInteger validUntil, BigInteger spendingLimit)
        {
            byte[] preimage = Helper.Concat(GrantDomain, new byte[] { 4 });
            preimage = Helper.Concat(preimage, (byte[])accountId);
            preimage = Helper.Concat(preimage, ModuleContext.U64BE(moduleId));
            preimage = Helper.Concat(preimage, ModuleContext.U64BE(generation));
            preimage = Helper.Concat(preimage, (byte[])sessionKey);
            preimage = Helper.Concat(preimage, (byte[])targetContract);
            preimage = Helper.Concat(preimage, new byte[] { (byte)method.Length });
            preimage = Helper.Concat(preimage, (byte[])method);
            preimage = Helper.Concat(preimage, ModuleContext.U64BE(validUntil));
            preimage = Helper.Concat(preimage, ValidatorPayload.ToUint256Word(spendingLimit));
            return CryptoLib.Sha256((ByteString)preimage);
        }
    }
}
