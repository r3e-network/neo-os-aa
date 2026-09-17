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
    public class ZkLoginUserOperation
    {
        public UInt160 TargetContract;
        public string Method;
        public object[] Args;
        public BigInteger Nonce;
        public BigInteger Deadline;
        public ByteString Signature;
    }

    public class ZkCryptoLib
    {
        public static ByteString Keccak256(ByteString data)
        {
            return (ByteString)Contract.Call(
                Neo.SmartContract.Framework.Native.CryptoLib.Hash,
                "keccak256",
                CallFlags.ReadOnly,
                new object[] { data }
            );
        }
    }

    [DisplayName("ZkLoginVerifier")]
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ContractPermission("*", "keccak256")]
    [ContractPermission("*", "sha256")]
    [ManifestExtra("Description", "Morpheus NeoDID delegated-signer verifier with public nullifier binding for Web2-backed AA execution")]
    public class ZkLoginVerifier : SmartContract
    {
        private static readonly byte[] Prefix_Config = new byte[] { 0x01 };
        private static readonly byte[] ZkLoginDomain = new byte[]
        {
            0x7a, 0x6b, 0x6c, 0x6f, 0x67, 0x69, 0x6e, 0x2d,
            0x76, 0x65, 0x72, 0x69, 0x66, 0x69, 0x65, 0x72,
            0x2d, 0x76, 0x31
        };

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsMessageSignatures() => false;

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

        public class ZkLoginConfig
        {
            public ByteString SignerPublicKey;
            public string Provider;
            public ByteString MasterNullifier;
        }

        public class ZkLoginProof
        {
            public string Provider;
            public ByteString MasterNullifier;
            public ByteString ActionNullifier;
            public ByteString Signature;
        }

        public static void SetPublicKey(UInt160 accountId, ByteString configBlob)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

            ZkLoginConfig config = ParseConfigBlob(configBlob);
            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(config));
        }

        public static void SetConfig(UInt160 accountId, ByteString signerPublicKey, string provider, ByteString masterNullifier)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

            ValidateSignerPublicKey(signerPublicKey);
            ValidateProvider(provider);
            ValidateNullifier(masterNullifier, "Invalid master nullifier");

            ZkLoginConfig config = new ZkLoginConfig
            {
                SignerPublicKey = signerPublicKey,
                Provider = provider,
                MasterNullifier = masterNullifier,
            };

            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(config));
        }

        [Safe]
        public static ByteString GetPublicKey(UInt160 accountId)
        {
            return GetConfig(accountId).SignerPublicKey;
        }

        [Safe]
        public static string GetProvider(UInt160 accountId)
        {
            return GetConfig(accountId).Provider;
        }

        [Safe]
        public static ByteString GetMasterNullifier(UInt160 accountId)
        {
            return GetConfig(accountId).MasterNullifier;
        }

        [Safe]
        public static bool ValidateSignature(UInt160 accountId, ZkLoginUserOperation op)
        {
            ZkLoginConfig config = GetConfig(accountId);
            ZkLoginProof proof = ParseProofBlob(op.Signature);

            ExecutionEngine.Assert(config.Provider == proof.Provider, "Provider mismatch");
            ExecutionEngine.Assert((ByteString)config.MasterNullifier == (ByteString)proof.MasterNullifier, "Master nullifier mismatch");

            byte[] payload = BuildPayload(
                accountId,
                op.TargetContract,
                op.Method,
                op.Args,
                op.Nonce,
                op.Deadline,
                proof.Provider,
                proof.MasterNullifier,
                proof.ActionNullifier
            );

            ECPoint pubKey = NormalizePublicKey(config.SignerPublicKey);
            return CryptoLib.VerifyWithECDsa(
                (ByteString)payload,
                pubKey,
                proof.Signature,
                NamedCurveHash.secp256r1SHA256
            );
        }

        [Safe]
        public static ByteString GetPayload(
            UInt160 accountId,
            UInt160 targetContract,
            string method,
            object[] args,
            BigInteger nonce,
            BigInteger deadline,
            string provider,
            ByteString masterNullifier,
            ByteString actionNullifier
        )
        {
            return (ByteString)BuildPayload(
                accountId,
                targetContract,
                method,
                args,
                nonce,
                deadline,
                provider,
                masterNullifier,
                actionNullifier
            );
        }

        public static void PostExecute(UInt160 accountId, ZkLoginUserOperation op, object result)
        {
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
        }

        public static void ClearAccount(UInt160 accountId)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_Config, (byte[])accountId));
        }

        private static ZkLoginConfig GetConfig(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "No zklogin config");
            return (ZkLoginConfig)StdLib.Deserialize(data!);
        }

        private static ZkLoginConfig ParseConfigBlob(ByteString blob)
        {
            byte[] raw = (byte[])blob;
            ExecutionEngine.Assert(raw.Length >= 1 + 1 + 33 + 1 + 32, "Invalid zklogin config");
            ExecutionEngine.Assert(raw[0] == 0x01, "Unsupported zklogin config version");

            int cursor = 1;
            int pubKeyLength = raw[cursor];
            cursor += 1;
            ExecutionEngine.Assert(pubKeyLength == 33 || pubKeyLength == 65, "Invalid signer pubkey length");
            ExecutionEngine.Assert(raw.Length >= cursor + pubKeyLength + 1 + 32, "Invalid zklogin config length");

            byte[] pubKeyBytes = CopyBytes(raw, cursor, pubKeyLength);
            cursor += pubKeyLength;

            int providerLength = raw[cursor];
            cursor += 1;
            ExecutionEngine.Assert(providerLength > 0, "Provider required");
            ExecutionEngine.Assert(raw.Length >= cursor + providerLength + 32, "Invalid provider length");
            byte[] providerBytes = CopyBytes(raw, cursor, providerLength);
            cursor += providerLength;

            byte[] masterNullifier = CopyBytes(raw, cursor, 32);

            ByteString signerPublicKey = (ByteString)pubKeyBytes;
            string provider = (string)(ByteString)providerBytes;
            ByteString masterNullifierValue = (ByteString)masterNullifier;

            ValidateSignerPublicKey(signerPublicKey);
            ValidateProvider(provider);
            ValidateNullifier(masterNullifierValue, "Invalid master nullifier");

            return new ZkLoginConfig
            {
                SignerPublicKey = signerPublicKey,
                Provider = provider,
                MasterNullifier = masterNullifierValue,
            };
        }

        private static ZkLoginProof ParseProofBlob(ByteString blob)
        {
            byte[] raw = (byte[])blob;
            ExecutionEngine.Assert(raw.Length >= 1 + 1 + 32 + 32 + 64, "Invalid zklogin proof");
            ExecutionEngine.Assert(raw[0] == 0x01, "Unsupported zklogin proof version");

            int cursor = 1;
            int providerLength = raw[cursor];
            cursor += 1;
            ExecutionEngine.Assert(providerLength > 0, "Provider required");
            ExecutionEngine.Assert(raw.Length == 1 + 1 + providerLength + 32 + 32 + 64, "Invalid zklogin proof length");

            byte[] providerBytes = CopyBytes(raw, cursor, providerLength);
            cursor += providerLength;
            byte[] masterNullifier = CopyBytes(raw, cursor, 32);
            cursor += 32;
            byte[] actionNullifier = CopyBytes(raw, cursor, 32);
            cursor += 32;
            byte[] signature = CopyBytes(raw, cursor, 64);

            string provider = (string)(ByteString)providerBytes;
            ByteString masterNullifierValue = (ByteString)masterNullifier;
            ByteString actionNullifierValue = (ByteString)actionNullifier;
            ByteString signatureValue = (ByteString)signature;

            ValidateProvider(provider);
            ValidateNullifier(masterNullifierValue, "Invalid master nullifier");
            ValidateNullifier(actionNullifierValue, "Invalid action nullifier");
            ExecutionEngine.Assert(signatureValue.Length == 64, "Invalid zklogin signature length");

            return new ZkLoginProof
            {
                Provider = provider,
                MasterNullifier = masterNullifierValue,
                ActionNullifier = actionNullifierValue,
                Signature = signatureValue,
            };
        }

        private static void ValidateSignerPublicKey(ByteString pubKey)
        {
            ExecutionEngine.Assert(pubKey != null && (pubKey.Length == 33 || pubKey.Length == 65), "Invalid signer pubkey");
        }

        private static void ValidateProvider(string provider)
        {
            ExecutionEngine.Assert(!string.IsNullOrEmpty(provider), "Provider required");
        }

        private static void ValidateNullifier(ByteString value, string message)
        {
            ExecutionEngine.Assert(value != null && value.Length == 32, message);
        }

        private static ECPoint NormalizePublicKey(ByteString value)
        {
            ValidateSignerPublicKey(value);
            if (value.Length == 33)
            {
                return (ECPoint)value;
            }

            byte[] raw = (byte[])value;
            byte[] compressed = new byte[33];
            compressed[0] = (raw[64] % 2 == 0) ? (byte)0x02 : (byte)0x03;
            for (int i = 0; i < 32; i++)
            {
                compressed[i + 1] = raw[i + 1];
            }
            return (ECPoint)(ByteString)compressed;
        }

        private static byte[] BuildPayload(
            UInt160 accountId,
            UInt160 targetContract,
            string method,
            object[] args,
            BigInteger nonce,
            BigInteger deadline,
            string provider,
            ByteString masterNullifier,
            ByteString actionNullifier
        )
        {
            ByteString argsHash = ZkCryptoLib.Keccak256((ByteString)StdLib.Serialize(args));
            byte[] context = Helper.Concat(
                ZkLoginDomain,
                ToUint256Word((BigInteger)Runtime.GetNetwork())
            );
            context = Helper.Concat(context, (byte[])accountId);
            context = Helper.Concat(context, (byte[])Runtime.ExecutingScriptHash);
            context = Helper.Concat(context, (byte[])VerifierAuthority.AuthorizedCore());
            context = Helper.Concat(context, (byte[])targetContract);
            context = Helper.Concat(context, EncodeLengthPrefixedAscii(provider));
            context = Helper.Concat(context, (byte[])masterNullifier);
            context = Helper.Concat(context, (byte[])actionNullifier);

            byte[] operation = Helper.Concat(
                EncodeLengthPrefixedAscii(method),
                (byte[])argsHash
            );
            operation = Helper.Concat(
                operation,
                Helper.Concat(ToUint256Word(nonce), ToUint256Word(deadline))
            );

            return Sha256(Helper.Concat(context, operation));
        }

        private static byte[] Sha256(byte[] data)
        {
            return (byte[])Contract.Call(
                Neo.SmartContract.Framework.Native.CryptoLib.Hash,
                "sha256",
                CallFlags.ReadOnly,
                new object[] { (ByteString)data }
            );
        }

        private static byte[] EncodeLengthPrefixedAscii(string value)
        {
            ByteString text = (ByteString)(value ?? "");
            ExecutionEngine.Assert(text.Length <= 255, "Text too long");
            byte[] result = new byte[text.Length + 1];
            result[0] = (byte)text.Length;
            byte[] body = (byte[])text;
            for (int i = 0; i < body.Length; i++)
            {
                result[i + 1] = body[i];
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

        private static byte[] CopyBytes(byte[] source, int offset, int length)
        {
            byte[] result = new byte[length];
            for (int i = 0; i < length; i++)
            {
                result[i] = source[offset + i];
            }
            return result;
        }
    }
}
