using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Verifiers
{
    internal static class NativeCryptoLib
    {
        public static ByteString Keccak256(ByteString data)
        {
            return (ByteString)Contract.Call(Neo.SmartContract.Framework.Native.CryptoLib.Hash, "keccak256", CallFlags.ReadOnly, new object[] { data });
        }
    }

    /// <summary>
    /// Verifier for EVM-style secp256k1 signatures produced through Web3Auth or compatible wallets.
    /// </summary>
    /// <remarks>
    /// This plugin verifies an EIP-712-style user operation payload inside Neo N3 so a V3 AA
    /// account can be controlled by an EVM identity without changing the AA core contract.
    /// Public-key setup is still routed through the AA core authorization boundary.
    /// </remarks>
    [DisplayName("Web3AuthVerifier")]
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ContractPermission("*", "keccak256")]
    [ManifestExtra("Description", "EIP-712 MetaTransaction Verifier Plugin for Neo N3")]
    public class Web3AuthVerifier : SmartContract
    {
        // Setup: AccountId -> Uncompressed Secp256k1 PublicKey (65 bytes)
        private static readonly byte[] Prefix_AccountPubKey = new byte[] { 0x01 };
        private static readonly byte[] Eip712DomainTypeHash = new byte[]
        {
            0x8b, 0x73, 0xc3, 0xc6, 0x9b, 0xb8, 0xfe, 0x3d,
            0x51, 0x2e, 0xcc, 0x4c, 0xf7, 0x59, 0xcc, 0x79,
            0x23, 0x9f, 0x7b, 0x17, 0x9b, 0x0f, 0xfa, 0xca,
            0xa9, 0xa7, 0x5d, 0x52, 0x2b, 0x39, 0x40, 0x0f
        };
        private static readonly byte[] Eip712NameHash = new byte[]
        {
            0x2e, 0x3d, 0x38, 0xea, 0x00, 0x55, 0xad, 0x99,
            0xb5, 0x57, 0x2e, 0x06, 0x66, 0x58, 0x43, 0x1f,
            0xf4, 0xc4, 0x0d, 0xba, 0xf3, 0xe1, 0x6e, 0x21,
            0x54, 0x63, 0x9d, 0xc6, 0xe2, 0x63, 0x48, 0x03
        };
        private static readonly byte[] Eip712VersionHash = new byte[]
        {
            0xc8, 0x9e, 0xfd, 0xaa, 0x54, 0xc0, 0xf2, 0x0c,
            0x7a, 0xdf, 0x61, 0x28, 0x82, 0xdf, 0x09, 0x50,
            0xf5, 0xa9, 0x51, 0x63, 0x7e, 0x03, 0x07, 0xcd,
            0xcb, 0x4c, 0x67, 0x2f, 0x29, 0x8b, 0x8b, 0xc6
        };
        private static readonly byte[] UserOperationTypeHash = new byte[]
        {
            0x57, 0x7a, 0x3a, 0x6b, 0xd9, 0x16, 0x83, 0xe3,
            0x00, 0xe8, 0x14, 0xcd, 0x25, 0xff, 0x62, 0x47,
            0xab, 0x7c, 0xa2, 0x73, 0xdd, 0xd0, 0x15, 0x3a,
            0x99, 0x91, 0x9d, 0x72, 0xdd, 0xf9, 0xfa, 0x04
        };

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsMessageSignatures() => true;

        [Safe]
        public static UInt160 AuthorizedCore() => VerifierAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => VerifierAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with hooks): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => VerifierAuthority.CancelAuthorizedCoreChange();

        // AA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => VerifierAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        public static void CancelUpdate() => VerifierAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        /// <summary>
        /// Stores the 65-byte uncompressed secp256k1 public key for an account.
        /// </summary>
        public static void SetPublicKey(UInt160 accountId, ByteString uncompressedPubKey)
        {
            ExecutionEngine.Assert(uncompressedPubKey.Length == 65, "Invalid pubkey");
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            byte[] key = Helper.Concat(Prefix_AccountPubKey, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, uncompressedPubKey);
        }

        [Safe]
        public static ByteString GetPublicKey(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_AccountPubKey, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data ?? (ByteString)"";
        }

        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
        }

        public static void ClearAccount(UInt160 accountId)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_AccountPubKey, (byte[])accountId));
        }

        [Safe]
        /// <summary>
        /// Verifies the EIP-712-style user operation signature for the configured account key.
        /// </summary>
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
            ByteString pubKey = GetPublicKey(accountId);
            ExecutionEngine.Assert(pubKey.Length == 65, "No pubkey configured");

            ExecutionEngine.Assert(op.Signature != null && op.Signature.Length == 64, "Invalid signature");
            ByteString signature = op.Signature!;

            byte[] structHash = BuildMetaTxStructHash(accountId, op);
            
            byte[] domainSeparator = BuildDomainSeparator(Runtime.GetNetwork(), Runtime.ExecutingScriptHash);
            
            // 0x19 0x01 ...
            byte[] typedDataPayload = Helper.Concat(Helper.Concat(new byte[] { 0x19, 0x01 }, domainSeparator), structHash);
            
            ECPoint compressedPubKey = CompressPubKey(pubKey);
            return CryptoLib.VerifyWithECDsa(
                (ByteString)typedDataPayload,
                compressedPubKey,
                signature,
                NamedCurveHash.secp256k1Keccak256
            );
        }

        /// <summary>
        /// Validates a fixed 32-byte message digest for the ERC-1271 adapter.
        /// Neo's verifier ABI uses the configured public key and a compact 64-byte
        /// r||s signature; the core maps the result to ERC-1271's bytes4 magic.
        /// </summary>
        [Safe]
        public static bool IsValidSignature(UInt160 accountId, ByteString hash, ByteString signature)
        {
            ByteString pubKey = GetPublicKey(accountId);
            ExecutionEngine.Assert(pubKey.Length == 65, "No pubkey configured");
            ExecutionEngine.Assert(hash != null && hash.Length == 32, "Invalid message hash");
            ExecutionEngine.Assert(
                signature != null && (signature.Length == 64 || signature.Length == 65),
                "Invalid message signature");
            ByteString compactSignature = signature!;
            if (signature!.Length == 65)
            {
                byte recoveryId = signature[64];
                ExecutionEngine.Assert(
                    recoveryId == 0 || recoveryId == 1 || recoveryId == 27 || recoveryId == 28,
                    "Invalid recovery id");
                byte[] compact = new byte[64];
                for (int i = 0; i < 64; i++) compact[i] = signature[i];
                compactSignature = (ByteString)compact;
            }
            return CryptoLib.VerifyWithECDsa(
                hash,
                CompressPubKey(pubKey),
                compactSignature,
                NamedCurveHash.secp256k1Keccak256);
        }

        private static byte[] BuildMetaTxStructHash(UInt160 accountId, UserOperation op)
        {
            byte[] argsSerialized = (byte[])StdLib.Serialize(op.Args);
            ByteString argsHash = NativeCryptoLib.Keccak256((ByteString)argsSerialized);
            byte[] methodHash = (byte[])NativeCryptoLib.Keccak256((ByteString)op.Method);
            byte[] payload = Helper.Concat(
                Helper.Concat(
                    Helper.Concat(
                        Helper.Concat(
                            Helper.Concat(
                                Helper.Concat(UserOperationTypeHash, ToBytes20Word(accountId)),
                                ToBytes20Word(VerifierAuthority.AuthorizedCore())
                            ),
                            ToAddressWord(op.TargetContract)
                        ),
                        methodHash
                    ),
                    (byte[])argsHash
                ),
                Helper.Concat(ToUint256Word(op.Nonce), ToUint256Word(op.Deadline))
            );
            return (byte[])NativeCryptoLib.Keccak256((ByteString)payload);
        }

        private static byte[] BuildDomainSeparator(uint network, UInt160 verifyingContract)
        {
            byte[] encoded = Helper.Concat(
                Helper.Concat(
                    Helper.Concat(
                        Helper.Concat(Eip712DomainTypeHash, Eip712NameHash),
                        Eip712VersionHash
                    ),
                    ToUint256Word((BigInteger)network)
                ),
                ToAddressWord(verifyingContract)
            );
            return (byte[])NativeCryptoLib.Keccak256((ByteString)encoded);
        }

        private static byte[] ToBytes20Word(UInt160 value)
        {
            byte[] source = (byte[])value;
            ExecutionEngine.Assert(source.Length == 20, "Invalid accountId length");
            byte[] result = new byte[32];
            for (int i = 0; i < 20; i++)
            {
                result[i] = source[19 - i];
            }
            return result;
        }

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

        private static byte[] ToUint256Word(BigInteger value)
        {
            ExecutionEngine.Assert(value >= 0, "Invalid uint256");
            byte[] little = value.ToByteArray();
            int length = little.Length;
            if (length > 0 && little[length - 1] == 0)
            {
                length--;
            }
            ExecutionEngine.Assert(length <= 32, "Uint256 overflow");

            byte[] result = new byte[32];
            for (int i = 0; i < length; i++)
            {
                result[31 - i] = little[i];
            }
            return result;
        }

        private static ECPoint CompressPubKey(ByteString uncompressedPubKey)
        {
            byte[] pk = (byte[])uncompressedPubKey;
            byte[] compressed = new byte[33];
            compressed[0] = (pk[64] % 2 == 0) ? (byte)0x02 : (byte)0x03;
            for (int i = 0; i < 32; i++) compressed[i + 1] = pk[i + 1];

            return (ECPoint)(ByteString)compressed;
        }
    }
}
