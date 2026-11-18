using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Validators
{
    internal static class NativeCryptoLib
    {
        public static ByteString Keccak256(ByteString data)
        {
            return (ByteString)Contract.Call(CryptoLib.Hash, "keccak256", CallFlags.ReadOnly, new object[] { data });
        }
    }

    /// <summary>
    /// Validator for EVM-style secp256k1 signatures produced through Web3Auth or
    /// compatible wallets.
    /// </summary>
    /// <remarks>
    /// One instance holds one secp256k1 public key. A routed operation carries a
    /// 64-byte compact <c>r‖s</c> signature over the EIP-712-style payload of
    /// docs/SA-EIP-712-SPEC.md: the typed struct shows the wallet the readable
    /// fields (target, method, args hash, nonce, deadline) and commits to the core
    /// operation digest, which binds every remaining protocol v4 field
    /// (docs/SA-MODULE-PROTOCOL.md §4.3, §5). The instance also answers
    /// ERC-1271-style message checks forwarded by the core (§8).
    /// </remarks>
    [DisplayName("Web3AuthValidator")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModule")]
    [ContractPermission("*", "keccak256")]
    [ManifestExtra("Description", "EIP-712-style secp256k1 validator for Neo N3 smart accounts")]
    public class Web3AuthValidator : SmartContract
    {
        // Canonical bytes of Web3AuthValidator.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\",\"isValidSignature\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":true,\"thresholdMemberEligible\":true},\"contractName\":\"Web3AuthValidator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        // (accountId, moduleId) -> 33-byte compressed secp256k1 public key
        private static readonly byte[] Prefix_PublicKey = new byte[] { 0x01 };

        // keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
        private static readonly byte[] Eip712DomainTypeHash = new byte[]
        {
            0x8b, 0x73, 0xc3, 0xc6, 0x9b, 0xb8, 0xfe, 0x3d,
            0x51, 0x2e, 0xcc, 0x4c, 0xf7, 0x59, 0xcc, 0x79,
            0x23, 0x9f, 0x7b, 0x17, 0x9b, 0x0f, 0xfa, 0xca,
            0xa9, 0xa7, 0x5d, 0x52, 0x2b, 0x39, 0x40, 0x0f
        };
        // keccak256("Neo Smart Account")
        private static readonly byte[] Eip712NameHash = new byte[]
        {
            0x4f, 0x42, 0x00, 0x1f, 0xc9, 0x80, 0xd0, 0x8b,
            0xd6, 0xd9, 0xd5, 0x4e, 0x72, 0x87, 0x95, 0xfc,
            0x53, 0xe9, 0x6c, 0x20, 0x1e, 0x9a, 0xac, 0x28,
            0xf0, 0xc9, 0x11, 0x19, 0xe9, 0x8d, 0xc9, 0x21
        };
        // keccak256("4") — the domain version is the module protocol version. Signatures
        // over the version "1" domain of the pre-v4 verifier are invalid here; there is
        // no dual-domain verification.
        private static readonly byte[] Eip712VersionHash = new byte[]
        {
            0x13, 0x60, 0x0b, 0x29, 0x41, 0x91, 0xfc, 0x92,
            0x92, 0x4b, 0xb3, 0xce, 0x4b, 0x96, 0x9c, 0x1e,
            0x7e, 0x2b, 0xab, 0x8f, 0x4c, 0x93, 0xc3, 0xfc,
            0x6d, 0x0a, 0x51, 0x73, 0x3d, 0xf3, 0xc0, 0x60
        };
        // keccak256("UserOperation(bytes20 accountId,bytes20 coreContract,uint64 validatorId,
        //   address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline,
        //   bytes32 operationDigest)")  (one line, no whitespace after the commas)
        private static readonly byte[] UserOperationTypeHash = new byte[]
        {
            0x31, 0x4f, 0xc7, 0x17, 0x92, 0x34, 0xc8, 0xae,
            0x0f, 0xbd, 0x3b, 0xd7, 0xee, 0x3d, 0x30, 0x91,
            0x8f, 0x0f, 0xcb, 0xef, 0x50, 0x10, 0x6f, 0x61,
            0x2d, 0x4e, 0xd8, 0x62, 0x46, 0x53, 0x03, 0x19
        };

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
        /// <c>initData</c>: empty, or <c>["setPublicKey", publicKey]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["setPublicKey", publicKey]</c> (33-byte compressed or
        /// 65-byte uncompressed secp256k1 key).
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_PublicKey, accountId, moduleId));
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(ModuleConfig.Command(data, 1) == "setPublicKey", "Unknown config command");
            Storage.Put(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_PublicKey, accountId, moduleId),
                ValidatorKeys.Compress((ByteString)data[1]));
        }

        /// <summary>The configured 33-byte compressed key, or empty when unconfigured.</summary>
        [Safe]
        public static ByteString GetPublicKey(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_PublicKey, accountId, moduleId));
            return data ?? (ByteString)"";
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId)
        {
            ByteString publicKey = GetPublicKey(accountId, moduleId);
            ExecutionEngine.Assert(publicKey.Length == 33, "No pubkey configured");
            return new ByteString[] { SignerDomain.Secp256k1(publicKey) };
        }

        /// <summary>
        /// Verifies the 64-byte compact secp256k1 signature addressed to this instance
        /// over the EIP-712-style payload. Rejects by returning false; an unconfigured
        /// instance approves nothing.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
            ByteString publicKey = GetPublicKey(accountId, moduleId);
            if (publicKey.Length != 33) return false;

            ByteString signature = ModuleOperation.MemberSignature(operation, moduleId);
            if (signature.Length != 64) return false;

            ByteString digest = ValidatorPayload.SigningDigest(accountId, operationDigest, operation, moduleId);
            return CryptoLib.VerifyWithECDsa(
                BuildSigningPayload(accountId, moduleId, operation, digest),
                (ECPoint)publicKey,
                signature,
                NamedCurveHash.secp256k1Keccak256);
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            ValidatorAuthority.RequireCompletion(accountId, operation);
        }

        /// <summary>
        /// The exact 66-byte <c>0x1901 ‖ domainSeparator ‖ structHash</c> bytes
        /// <see cref="ValidateUserOp"/> verifies for a standalone-routed operation.
        /// Clients sign these bytes with secp256k1 and Keccak-256.
        /// </summary>
        [Safe]
        public static ByteString GetSigningPayload(UInt160 accountId, BigInteger moduleId, ByteString operationDigest, object[] operation)
        {
            ModuleOperation.RequireShape(operation);
            ExecutionEngine.Assert(operationDigest != null && operationDigest.Length == 32, "Invalid operation digest");
            return BuildSigningPayload(accountId, moduleId, operation, operationDigest!);
        }

        /// <summary>
        /// ERC-1271-style message check forwarded by the core (spec §8). <paramref name="hash"/>
        /// is the core's domain-bound module message digest and is verified directly, not
        /// hashed again. <paramref name="signatures"/> holds exactly one pair
        /// <c>[compressedPublicKey, signature]</c>; the key must be the configured one and
        /// the signature is 64-byte EIP-2098 compact or recoverable 65-byte <c>r‖s‖v</c>.
        /// </summary>
        [Safe]
        public static bool IsValidSignature(UInt160 accountId, UInt160 originalSender, BigInteger validatorId,
            BigInteger generation, ByteString hash, object[] signatures)
        {
            ValidatorAuthority.RequireCoreCaller();
            ByteString publicKey = GetPublicKey(accountId, validatorId);
            if (publicKey.Length != 33) return false;
            if (hash == null || hash.Length != 32) return false;
            if (signatures == null || signatures.Length != 1) return false;

            object[] pair = (object[])signatures[0];
            if (pair.Length != 2) return false;
            if ((ByteString)pair[0] != publicKey) return false;
            ByteString signature = (ByteString)pair[1];
            if (signature.Length != 64 && signature.Length != 65) return false;

            ByteString? recovered = CryptoLib.RecoverSecp256K1(hash, signature);
            return recovered is not null && recovered == publicKey;
        }

        private static ByteString BuildSigningPayload(UInt160 accountId, BigInteger moduleId, object[] operation, ByteString digest)
        {
            byte[] structHash = BuildStructHash(accountId, moduleId, operation, digest);
            byte[] domainSeparator = BuildDomainSeparator(Runtime.GetNetwork(), Runtime.ExecutingScriptHash);
            return (ByteString)Helper.Concat(Helper.Concat(new byte[] { 0x19, 0x01 }, domainSeparator), structHash);
        }

        private static byte[] BuildStructHash(UInt160 accountId, BigInteger moduleId, object[] operation, ByteString digest)
        {
            ByteString argsHash = NativeCryptoLib.Keccak256(StdLib.Serialize(operation[ModuleOperation.FieldArgs]));
            ByteString methodHash = NativeCryptoLib.Keccak256((ByteString)operation[ModuleOperation.FieldMethod]);

            byte[] payload = Helper.Concat(UserOperationTypeHash, ToBytes20Word(accountId));
            payload = Helper.Concat(payload, ToBytes20Word(ValidatorAuthority.AuthorizedCore()));
            payload = Helper.Concat(payload, ValidatorPayload.ToUint256Word(moduleId));
            payload = Helper.Concat(payload, ToAddressWord(ModuleOperation.Target(operation)));
            payload = Helper.Concat(payload, (byte[])methodHash);
            payload = Helper.Concat(payload, (byte[])argsHash);
            payload = Helper.Concat(payload, ValidatorPayload.ToUint256Word((BigInteger)operation[ModuleOperation.FieldNonce]));
            payload = Helper.Concat(payload, ValidatorPayload.ToUint256Word(ModuleOperation.Deadline(operation)));
            payload = Helper.Concat(payload, (byte[])digest);
            return (byte[])NativeCryptoLib.Keccak256((ByteString)payload);
        }

        private static byte[] BuildDomainSeparator(uint network, UInt160 verifyingContract)
        {
            byte[] encoded = Helper.Concat(Eip712DomainTypeHash, Eip712NameHash);
            encoded = Helper.Concat(encoded, Eip712VersionHash);
            encoded = Helper.Concat(encoded, ValidatorPayload.ToUint256Word((BigInteger)network));
            encoded = Helper.Concat(encoded, ToAddressWord(verifyingContract));
            return (byte[])NativeCryptoLib.Keccak256((ByteString)encoded);
        }

        // bytes20: the hash in big-endian display order, right-padded with 12 zero bytes.
        private static byte[] ToBytes20Word(UInt160 value)
        {
            byte[] source = (byte[])value;
            ExecutionEngine.Assert(source.Length == 20, "Invalid hash length");
            byte[] result = new byte[32];
            for (int i = 0; i < 20; i++)
            {
                result[i] = source[19 - i];
            }
            return result;
        }

        // address: 12 zero bytes then the hash in big-endian display order.
        private static byte[] ToAddressWord(UInt160 value)
        {
            byte[] address = (byte[])value;
            ExecutionEngine.Assert(address.Length == 20, "Invalid address length");
            byte[] result = new byte[32];
            for (int i = 0; i < 20; i++)
            {
                result[12 + i] = address[19 - i];
            }
            return result;
        }
    }
}
