// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccountProtocol.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Extensions;
using Neo.IO;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Buffers.Binary;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text;
using System.Text.Json;
using Array = Neo.VM.Types.Array;
using Buffer = Neo.VM.Types.Buffer;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// Protocol-level invariants of SA module protocol v4 (spec §4.2/§4.3, §6,
    /// §7.1, §16.1). The pinned vectors in TestFile/smartaccount-v4-vectors.json
    /// are produced by generate-smartaccount-v4-vectors.py, which derives them
    /// from the specification only, so these tests fail when the kernel drifts
    /// from the published bytes.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountProtocol
    {
        private static readonly JsonElement Vectors = LoadVectors();
        private static readonly UInt160 Service = UInt160.Parse("0x398dc3f0227d7efac5533ed5ce9937390c158084");
        private static readonly UInt160 Account = UInt160.Parse(Vectors.GetProperty("accountId").GetString());
        private static readonly UInt160 Custody = UInt160.Parse(Vectors.GetProperty("custody").GetString());
        private static readonly byte[] Salt = Convert.FromHexString(Vectors.GetProperty("salt").GetString());
        private static readonly byte[] NonceSubkey = new byte[SmartAccountModuleProtocol.NonceSubkeySize];
        // Any non-empty signature is legal on the wire; the canonical form blanks it.
        private static readonly byte[] Signature = Enumerable.Repeat((byte)0x11, 64).ToArray();
        private const uint Network = 0x12345678;

        private static JsonElement LoadVectors()
        {
            string path = Path.Combine(AppContext.BaseDirectory, "SmartContract", "Native", "TestFile",
                "smartaccount-v4-vectors.json");
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            return document.RootElement.Clone();
        }

        private static string Hex(JsonElement element, string name) => element.GetProperty(name).GetString();

        /// <summary>The canonical thirteen-field v4 operation.</summary>
        private static Array Operation(BigInteger nonce = default) => new([
            new Integer(SmartAccountModuleProtocol.ModuleProtocolVersion), Service.ToArray(), "ping", new Array(),
            nonce, NonceSubkey, new BigInteger(1_700_000_000_000),
            // §4.1 [8]: the credential generation is 1-based; 0 is malformed.
            BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero,
            Signature, new Array(),
        ]);

        /// <summary>Digest exactly as the specification lays it out: the 106-byte domain and the canonical
        /// unsigned operation bytes, hashed once by SHA-256.</summary>
        private static byte[] Digest(Array op, uint network = Network, UInt160 account = null,
            UInt160 core = null)
        {
            byte[] canonical = SmartAccountTestSupport.Canonical(op);
            byte[] preimage = new byte[29 + 1 + 4 + UInt160.Length + UInt160.Length + 4 * 8 + canonical.Length];
            "NeoSmartAccount/UserOperation"u8.CopyTo(preimage);
            preimage[29] = SmartAccountProtocol.Version;
            BinaryPrimitives.WriteUInt32LittleEndian(preimage.AsSpan(30), network);
            (core ?? Service).GetSpan().CopyTo(preimage.AsSpan(34));
            (account ?? Account).GetSpan().CopyTo(preimage.AsSpan(54));
            WriteUInt64Be(preimage.AsSpan(74), op[SmartAccountModuleProtocol.OpValidatorId].GetInteger());
            WriteUInt64Be(preimage.AsSpan(82), op[SmartAccountModuleProtocol.OpCredentialGeneration].GetInteger());
            WriteUInt64Be(preimage.AsSpan(90), op[SmartAccountModuleProtocol.OpAuthorityEpoch].GetInteger());
            WriteUInt64Be(preimage.AsSpan(98), op[SmartAccountModuleProtocol.OpConfigurationNonce].GetInteger());
            canonical.CopyTo(preimage.AsSpan(106));
            return System.Security.Cryptography.SHA256.HashData(preimage);
        }

        private static void WriteUInt64Be(Span<byte> destination, BigInteger value) =>
            BinaryPrimitives.WriteUInt64BigEndian(destination, (ulong)value);

        private static string DigestHex(Array op) => Convert.ToHexStringLower(Digest(op));

        [TestMethod]
        public void PublishedIdentityAndProxyScriptMatchIndependentDerivation()
        {
            Assert.AreEqual(Service, SmartAccountProtocol.ServiceHash);
            Assert.AreEqual(Network, (uint)Vectors.GetProperty("network").GetInt64());
            Assert.AreEqual(Account, SmartAccountProtocol.GetAccountId(Custody, Salt));
            Assert.AreEqual(Hex(Vectors, "accountId"), Account.ToString());
            Assert.AreEqual(UInt160.Parse(Hex(Vectors, "proxyAddress")),
                SmartAccountProtocol.GetAccountAddress(Account));
            Assert.AreEqual(Hex(Vectors, "verificationScript"),
                Convert.ToHexStringLower(SmartAccountProtocol.CreateVerificationScript(Account)));
        }

        [TestMethod]
        public void NativeServiceIdentityCannotBeRetargetedThroughReturnedHash()
        {
            UInt160 exposed = SmartAccountProtocol.ServiceHash;
            MemoryReader reader = new(Account.ToArray());
            exposed.Deserialize(ref reader);
            Assert.AreEqual(Service, SmartAccountProtocol.ServiceHash);
            Assert.AreEqual(Account, SmartAccountProtocol.GetAccountId(Custody, Salt));
        }

        [TestMethod]
        public void IdentityCommitsToCustodyAndSalt()
        {
            Assert.AreNotEqual(Account, SmartAccountProtocol.GetAccountId(Service, Salt));
            byte[] changed = Salt.ToArray();
            changed[^1] ^= 1;
            Assert.AreNotEqual(Account, SmartAccountProtocol.GetAccountId(Custody, changed));
            // The v4 identity domain is network independent: the same custody and
            // salt always derive the same account id on every network.
            Assert.AreEqual(Account, SmartAccountProtocol.GetAccountId(Custody, Salt));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.GetAccountId(UInt160.Zero, Salt));
        }

        [TestMethod]
        [DataRow(0)]
        [DataRow(129)]
        public void SaltOutsideTheProfileIsRejected(int length) =>
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.GetAccountId(Custody, new byte[length]));

        [TestMethod]
        public void SaltBoundsAreInclusive()
        {
            Assert.AreNotEqual(UInt160.Zero, SmartAccountProtocol.GetAccountId(Custody, new byte[1]));
            Assert.AreNotEqual(UInt160.Zero, SmartAccountProtocol.GetAccountId(Custody, new byte[128]));
        }

        [TestMethod]
        public void ZeroAccountIdentityIsRejected()
        {
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.CreateVerificationScript(UInt160.Zero));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.GetAccountAddress(UInt160.Zero));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.CreateVerificationScript(null));
        }

        [TestMethod]
        public void PublishedOperationBytesAndDigestMatch()
        {
            Array op = Operation();
            string canonical = Convert.ToHexStringLower(SmartAccountTestSupport.Canonical(op));
            Assert.AreEqual(Hex(Vectors.GetProperty("operation"), "canonical"), canonical, canonical);
            Assert.AreEqual(Hex(Vectors.GetProperty("operation"), "digest"), DigestHex(op));
            Assert.AreEqual(Hex(Vectors.GetProperty("digests"), "epoch2"),
                DigestHex(Mutate(op, SmartAccountModuleProtocol.OpAuthorityEpoch, new Integer(2))));
            Assert.AreEqual(Hex(Vectors.GetProperty("digests"), "nonce1"),
                DigestHex(Mutate(op, SmartAccountModuleProtocol.OpConfigurationNonce, new Integer(1))));
            Assert.AreEqual(Hex(Vectors.GetProperty("digests"), "validator1"),
                DigestHex(Mutate(op, SmartAccountModuleProtocol.OpValidatorId, new Integer(1))));
        }

        private static Array Mutate(Array op, int field, StackItem value)
        {
            Array copy = new(op);
            copy[field] = value;
            return copy;
        }

        [TestMethod]
        public void SignatureIsExcludedWithoutMutatingInputOrReturningAliases()
        {
            Array op = Operation();
            byte[] signature = [1, 2, 3];
            op[SmartAccountModuleProtocol.OpSignature] = signature;
            byte[] serialized = SmartAccountTestSupport.Canonical(op);
            Assert.AreEqual(Hex(Vectors.GetProperty("operation"), "canonical"), Convert.ToHexStringLower(serialized));
            Assert.AreSequenceEqual(signature, op[SmartAccountModuleProtocol.OpSignature].GetSpan().ToArray());
            serialized[0] ^= 1;
            Assert.AreEqual(Hex(Vectors.GetProperty("operation"), "canonical"),
                Convert.ToHexStringLower(SmartAccountTestSupport.Canonical(op)));
            Array decoded = (Array)BinarySerializer.Deserialize(
                SmartAccountTestSupport.Canonical(op), ExecutionEngineLimits.Default);
            Assert.AreEqual(ByteString.Empty, decoded[SmartAccountModuleProtocol.OpSignature]);
        }

        [TestMethod]
        public void EverySignedFieldIsCommitted()
        {
            string baseline = DigestHex(Operation());
            var mutations = new (int Field, StackItem Value)[]
            {
                (1, Custody.ToArray()),
                (2, "balanceOf"),
                (3, new Array([Account.ToArray(), 43])),
                (4, new Integer(1)),
                (5, new ByteString(Enumerable.Repeat((byte)1, 32).ToArray())),
                (6, new BigInteger(1_700_000_000_001)),
                (7, new Integer(1)),
                // The baseline generation is 1, so a committed-field probe must
                // move it to a different legal value (2), not to 0.
                (8, new Integer(2)),
                (9, new Integer(2)),
                (10, new Integer(1)),
                // Field 12 is module-defined but core-carried: the core checks the
                // shape only, so a shape-valid proof array is digest-committed
                // even though no hook runs in this core (§4.2 R-04-03).
                (12, new Array([new Array([new Integer(1), new ByteString(new byte[] { 1 })])])),
            };
            foreach (var (field, value) in mutations)
                Assert.AreNotEqual(baseline, DigestHex(Mutate(Operation(), field, value)), $"field {field}");
            // The signature is excluded from the digest by construction (§4.2).
            Assert.AreEqual(baseline,
                DigestHex(Mutate(Operation(), SmartAccountModuleProtocol.OpSignature, new ByteString(new byte[64]))));
        }

        [TestMethod]
        public void DigestDomainSeparatesNetworksAccountsAndCores()
        {
            string baseline = DigestHex(Operation());
            Assert.AreNotEqual(baseline, Convert.ToHexStringLower(Digest(Operation(), Network + 1)));
            Assert.AreNotEqual(baseline, Convert.ToHexStringLower(Digest(Operation(), account: Custody)));
            Assert.AreNotEqual(baseline, Convert.ToHexStringLower(Digest(Operation(), core: Account)));
        }

        [TestMethod]
        [DataRow("null")]
        [DataRow("struct")]
        [DataRow("short")]
        [DataRow("long")]
        [DataRow("version")]
        [DataRow("target-zero")]
        [DataRow("target-short")]
        [DataRow("target-buffer")]
        [DataRow("method-empty")]
        [DataRow("method-long")]
        [DataRow("method-utf8")]
        [DataRow("method-buffer")]
        [DataRow("args-struct")]
        [DataRow("args-count")]
        [DataRow("nonce-negative")]
        [DataRow("nonce-bytes")]
        [DataRow("nonce-bool")]
        [DataRow("subkey-short")]
        [DataRow("subkey-long")]
        [DataRow("subkey-buffer")]
        [DataRow("deadline-negative")]
        [DataRow("deadline-bytes")]
        [DataRow("validator-negative")]
        [DataRow("generation-overflow")]
        [DataRow("generation-zero")]
        [DataRow("epoch-bytes")]
        [DataRow("configuration-negative")]
        [DataRow("signature-long")]
        [DataRow("signature-empty")]
        [DataRow("signature-buffer")]
        [DataRow("signature-null")]
        [DataRow("hooks-struct")]
        [DataRow("hooks-oversize")]
        [DataRow("hooks-pair-shape")]
        [DataRow("hooks-zero-id")]
        [DataRow("hooks-unsorted")]
        [DataRow("hooks-proof-type")]
        public void MalformedOperationIsRejectedBeforeDigest(string defect)
        {
            Array op = Operation();
            StackItem value = op;
            switch (defect)
            {
                case "null": value = StackItem.Null; break;
                case "struct": value = new Struct(op); break;
                case "short": value = new Array(op.Take(12)); break;
                case "long": op.Add(0); break;
                case "version": op[SmartAccountModuleProtocol.OpVersion] = new Integer(3); break;
                case "target-zero": op[SmartAccountModuleProtocol.OpTarget] = new byte[20]; break;
                case "target-short": op[SmartAccountModuleProtocol.OpTarget] = new byte[19]; break;
                case "target-buffer": op[SmartAccountModuleProtocol.OpTarget] = new Buffer(Service.ToArray()); break;
                case "method-empty": op[SmartAccountModuleProtocol.OpMethod] = ByteString.Empty; break;
                case "method-long": op[SmartAccountModuleProtocol.OpMethod] = new byte[129]; break;
                case "method-utf8": op[SmartAccountModuleProtocol.OpMethod] = new byte[] { 0xc0, 0xaf }; break;
                case "method-buffer": op[SmartAccountModuleProtocol.OpMethod] = new Buffer(new byte[] { 0x61 }); break;
                case "args-struct": op[SmartAccountModuleProtocol.OpArgs] = new Struct(); break;
                case "args-count": op[SmartAccountModuleProtocol.OpArgs] = new Array(Enumerable.Repeat(StackItem.Null, 65)); break;
                case "nonce-negative": op[SmartAccountModuleProtocol.OpNonce] = -1; break;
                case "nonce-bytes": op[SmartAccountModuleProtocol.OpNonce] = new byte[] { 1 }; break;
                case "nonce-bool": op[SmartAccountModuleProtocol.OpNonce] = true; break;
                case "subkey-short": op[SmartAccountModuleProtocol.OpNonceSubkey] = new byte[31]; break;
                case "subkey-long": op[SmartAccountModuleProtocol.OpNonceSubkey] = new byte[33]; break;
                case "subkey-buffer": op[SmartAccountModuleProtocol.OpNonceSubkey] = new Buffer(NonceSubkey); break;
                case "deadline-negative": op[SmartAccountModuleProtocol.OpDeadline] = -1; break;
                case "deadline-bytes": op[SmartAccountModuleProtocol.OpDeadline] = new byte[] { 1 }; break;
                case "validator-negative": op[SmartAccountModuleProtocol.OpValidatorId] = -1; break;
                case "generation-overflow": op[SmartAccountModuleProtocol.OpCredentialGeneration] = BigInteger.One << 64; break;
                // §4.1 [8]: the generation is 1-based, so 0 is malformed even
                // though it fits the unsigned 64-bit range.
                case "generation-zero": op[SmartAccountModuleProtocol.OpCredentialGeneration] = BigInteger.Zero; break;
                case "epoch-bytes": op[SmartAccountModuleProtocol.OpAuthorityEpoch] = new byte[] { 1 }; break;
                case "configuration-negative": op[SmartAccountModuleProtocol.OpConfigurationNonce] = -1; break;
                case "signature-long": op[SmartAccountModuleProtocol.OpSignature] = new byte[SmartAccountModuleProtocol.SignatureBytesMax + 1]; break;
                case "signature-empty": op[SmartAccountModuleProtocol.OpSignature] = ByteString.Empty; break;
                case "signature-buffer": op[SmartAccountModuleProtocol.OpSignature] = new Buffer(1); break;
                case "signature-null": op[SmartAccountModuleProtocol.OpSignature] = StackItem.Null; break;
                // Field 12 is module-defined but core-carried: the core checks
                // the shape of hookProofs and never interprets a proof (§4.2
                // R-04-03), so every violation here is a shape defect.
                case "hooks-struct": op[SmartAccountModuleProtocol.OpHookProofs] = new Struct(); break;
                case "hooks-oversize": op[SmartAccountModuleProtocol.OpHookProofs] = new Array(
                    Enumerable.Range(1, SmartAccountModuleProtocol.HookProofsEntriesMax + 1)
                        .Select(id => (StackItem)new Array([new Integer(id), ByteString.Empty]))); break;
                case "hooks-pair-shape": op[SmartAccountModuleProtocol.OpHookProofs] =
                    new Array([new Array([new Integer(1)])]); break;
                case "hooks-zero-id": op[SmartAccountModuleProtocol.OpHookProofs] =
                    new Array([new Array([new Integer(0), ByteString.Empty])]); break;
                case "hooks-unsorted": op[SmartAccountModuleProtocol.OpHookProofs] = new Array([
                    new Array([new Integer(2), ByteString.Empty]),
                    new Array([new Integer(1), ByteString.Empty])]); break;
                case "hooks-proof-type": op[SmartAccountModuleProtocol.OpHookProofs] =
                    new Array([new Array([new Integer(1), new Integer(7)])]); break;
                default: Assert.Fail(defect); break;
            }
            FormatException fault = Assert.ThrowsExactly<FormatException>(() => SmartAccountTestSupport.Canonical(value));
            // Every rejection names a protocol symbol rather than prose, so the
            // executor and the SDK can map the fault without parsing English.
            Assert.StartsWith("SA_", fault.Message);
            string symbol = defect switch
            {
                "short" or "long" => SmartAccountModuleProtocol.ErrorOperationFieldCount,
                "version" => SmartAccountModuleProtocol.ErrorProtocolVersion,
                "generation-zero" => SmartAccountModuleProtocol.ErrorOperationMalformed,
                _ when defect.StartsWith("hooks-", StringComparison.Ordinal)
                    => SmartAccountModuleProtocol.ErrorProofInvalid,
                _ => null,
            };
            if (symbol != null) Assert.AreEqual(symbol, fault.Message);
            if (value is Array operation)
                Assert.ThrowsExactly<FormatException>(() => Digest(operation));
        }

        [TestMethod]
        public void ModuleCodeIdentityIsSha256OfTheNefAlone()
        {
            NefFile nef = new()
            {
                Compiler = "code identity fixture",
                Source = string.Empty,
                Tokens = [],
                Script = new byte[] { (byte)OpCode.RET }
            };
            nef.CheckSum = NefFile.ComputeChecksum(nef);
            byte[] bytes = nef.ToArray();
            byte[] digest = System.Security.Cryptography.SHA256.HashData(bytes);

            ContractState first = new()
            {
                Id = 1,
                UpdateCounter = 0,
                Hash = UInt160.Zero,
                Nef = NefFile.Parse(bytes, verify: true),
                Manifest = ContractManifest.Parse("{\"name\":\"identity\",\"groups\":[],\"features\":{},\"supportedstandards\":[],\"abi\":{\"methods\":[{\"name\":\"probe\",\"parameters\":[],\"returntype\":\"Void\",\"safe\":false,\"offset\":0}],\"events\":[]},\"permissions\":[],\"trusts\":\"*\"}")
            };
            // Spec §3.6/§7.3: the module code identity is SHA-256 over the deployed
            // NEF bytes only — the same 32 bytes the custom kernel records as
            // CryptoLib.Sha256(contract.Nef). Manifest continuity is carried by the
            // 0x52 profile digest, so a manifest change must not move this value.
            Assert.AreSequenceEqual(digest, SmartAccountModulePolicy.CodeHash(first).ToArray());

            ContractState second = new()
            {
                Id = 2,
                UpdateCounter = 9,
                Hash = UInt160.Parse("0x0101010101010101010101010101010101010101"),
                Nef = NefFile.Parse(bytes, verify: true),
                Manifest = ContractManifest.Parse("{\"name\":\"identity\",\"groups\":[],\"features\":{},\"supportedstandards\":[],\"abi\":{\"methods\":[{\"name\":\"other\",\"parameters\":[],\"returntype\":\"Void\",\"safe\":false,\"offset\":0}],\"events\":[]},\"permissions\":[],\"trusts\":\"*\"}")
            };
            Assert.AreSequenceEqual(digest, SmartAccountModulePolicy.CodeHash(second).ToArray(),
                "the manifest is outside the code identity");
        }

        [TestMethod]
        public void ExactScalarBoundsAndMultibyteUtf8AreAccepted()
        {
            Array op = Operation();
            string method = string.Concat(Enumerable.Repeat("é", 64));
            op[SmartAccountModuleProtocol.OpMethod] = Encoding.UTF8.GetBytes(method);
            Assert.HasCount(128, Encoding.UTF8.GetBytes(method));
            op[SmartAccountModuleProtocol.OpArgs] = new Array(Enumerable.Repeat(StackItem.Null, 64));
            op[SmartAccountModuleProtocol.OpNonce] = (BigInteger.One << 254) - 1;
            op[SmartAccountModuleProtocol.OpDeadline] = (BigInteger.One << 255) - 1;
            op[SmartAccountModuleProtocol.OpValidatorId] = ulong.MaxValue;
            op[SmartAccountModuleProtocol.OpCredentialGeneration] = ulong.MaxValue;
            op[SmartAccountModuleProtocol.OpAuthorityEpoch] = ulong.MaxValue;
            op[SmartAccountModuleProtocol.OpConfigurationNonce] = ulong.MaxValue;
            op[SmartAccountModuleProtocol.OpSignature] = new byte[SmartAccountModuleProtocol.SignatureBytesMax];
            Array decoded = (Array)BinarySerializer.Deserialize(
                SmartAccountTestSupport.Canonical(op), ExecutionEngineLimits.Default);
            Assert.AreEqual(new Integer((BigInteger.One << 254) - 1), decoded[SmartAccountModuleProtocol.OpNonce]);
            Assert.AreEqual(op[SmartAccountModuleProtocol.OpDeadline], decoded[SmartAccountModuleProtocol.OpDeadline]);
            Assert.AreEqual(ByteString.Empty, decoded[SmartAccountModuleProtocol.OpSignature]);
        }

        [TestMethod]
        [DataRow(7, true)]
        [DataRow(8, false)]
        public void NestedArrayDepthIsBoundedAndStructsAreRejected(int depth, bool valid)
        {
            StackItem item = StackItem.Null;
            for (int i = 0; i < depth; i++)
                item = new Array([item]);
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = new Array([item]);
            if (valid)
                Assert.IsNotEmpty(SmartAccountTestSupport.Canonical(op));
            else
                Assert.ThrowsExactly<FormatException>(() => SmartAccountTestSupport.Canonical(op));

            Array withStruct = Operation();
            withStruct[SmartAccountModuleProtocol.OpArgs] = new Array([new Struct([true])]);
            Assert.ThrowsExactly<FormatException>(() => SmartAccountTestSupport.Canonical(withStruct));
        }

        [TestMethod]
        [DataRow(4090, true)]
        [DataRow(4091, false)]
        public void SerializedArgumentSizeIncludesArrayAndVarBytesHeaders(int length, bool valid)
        {
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = new Array([new ByteString(new byte[length])]);
            if (valid)
                Assert.IsNotEmpty(SmartAccountTestSupport.Canonical(op));
            else
                Assert.ThrowsExactly<FormatException>(() => SmartAccountTestSupport.Canonical(op));
        }

        [TestMethod]
        public void ArgumentSizeCountsNestedHeadersAndFanOut()
        {
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = new Array(
                Enumerable.Range(0, SmartAccountModuleProtocol.ArgsCountMax).Select(_ => (StackItem)new Array()));
            Assert.IsNotEmpty(SmartAccountTestSupport.Canonical(op));

            Array deep = Operation();
            deep[SmartAccountModuleProtocol.OpArgs] = new Array([new Array(Enumerable.Repeat(
                (StackItem)new ByteString(new byte[128]), 32))]);
            Assert.ThrowsExactly<FormatException>(() => SmartAccountTestSupport.Canonical(deep));
        }

        [TestMethod]
        [DataRow("buffer")]
        [DataRow("map")]
        [DataRow("interop")]
        [DataRow("pointer")]
        [DataRow("cycle")]
        [DataRow("alias")]
        public void UnsupportedOrSharedArgumentValuesAreRejected(string kind)
        {
            Array child = new([1]);
            Array args = new([child]);
            switch (kind)
            {
                case "buffer": args[0] = new Buffer(1); break;
                case "map": args[0] = new Map(); break;
                case "interop": args[0] = new InteropInterface(new object()); break;
                case "pointer": args[0] = new Pointer(new Script(new byte[] { (byte)OpCode.RET }), 0); break;
                case "cycle": child.Add(args); break;
                case "alias": args.Add(child); break;
                default: Assert.Fail(kind); break;
            }
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = args;
            Assert.ThrowsExactly<FormatException>(() => SmartAccountTestSupport.Canonical(op));
        }

        [TestMethod]
        public void EqualButIndependentArraysAndAllLeafTypesStayCanonical()
        {
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = new Array([
                new Array([1]), new Array([1]),
                new Array([StackItem.Null, true, -1, ByteString.Empty])]);
            Array decoded = (Array)BinarySerializer.Deserialize(
                SmartAccountTestSupport.Canonical(op), ExecutionEngineLimits.Default);
            Assert.AreSequenceEqual(
                BinarySerializer.Serialize(op[SmartAccountModuleProtocol.OpArgs], ExecutionEngineLimits.Default),
                BinarySerializer.Serialize(decoded[SmartAccountModuleProtocol.OpArgs], ExecutionEngineLimits.Default));
        }

        [TestMethod]
        public void StorageKeysArePrefixedFixedWidthAndDomainSeparated()
        {
            BigInteger[] ids = [BigInteger.One, new BigInteger(7), ulong.MaxValue];
            byte[] channel = Enumerable.Repeat((byte)0x5A, SmartAccountModuleProtocol.NonceChannelSize).ToArray();
            // The keys are the platform KeyBuilder layout (prefix ‖ account ‖ optional type ‖ fixed-width
            // big-endian id), built exactly as the kernel builds them.
            SmartAccount core = NativeContract.SmartAccount;
            (byte Prefix, Func<byte[]> Build, int Length)[] keys =
            [
                (SmartAccountModuleProtocol.PrefixProtocolInfo, () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixProtocolInfo)).Key.ToArray(), 1),
                (SmartAccountModuleProtocol.PrefixAccountControl, () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixAccountControl).Add(Account)).Key.ToArray(), 21),
                (SmartAccountModuleProtocol.PrefixModuleInstance, () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixModuleInstance).Add(Account).AddBigEndian(SmartAccountProtocol.UInt64(ids[0]))).Key.ToArray(), 29),
                (SmartAccountModuleProtocol.PrefixModuleIndex, () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixModuleIndex).Add(Account).Add(SmartAccountModuleProtocol.ModuleTypeCodeValidator).AddBigEndian(SmartAccountProtocol.UInt64(ids[0]))).Key.ToArray(), 30),
                (SmartAccountModuleProtocol.PrefixNonceCursor, () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixNonceCursor).Add(Account).Add(channel)).Key.ToArray(), 45),
                (SmartAccountModuleProtocol.PrefixNonceNamespace, () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixNonceNamespace).Add(Account).Add(channel)).Key.ToArray(), 45),
            ];
            var seen = new System.Collections.Generic.HashSet<byte>();
            byte[] protocolKey = keys[0].Build();
            Assert.AreSequenceEqual([SmartAccountModuleProtocol.PrefixProtocolInfo], protocolKey);
            seen.Add(protocolKey[0]);
            foreach (var (prefix, build, length) in keys[1..])
            {
                byte[] key = build();
                Assert.AreEqual(prefix, key[0]);
                Assert.HasCount(length, key);
                Assert.AreSequenceEqual(Account.ToArray(), key[1..21]);
                Assert.IsTrue(seen.Add(prefix), $"duplicate prefix {prefix:X2}");
            }
            Assert.HasCount(6, seen);
            // The id tail is big-endian and fixed width.
            byte[] ModuleInstanceKey(BigInteger moduleId) =>
                ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixModuleInstance).Add(Account).AddBigEndian(SmartAccountProtocol.UInt64(moduleId))).Key.ToArray();
            byte[] ModuleIndexKey(byte type) => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixModuleIndex).Add(Account).Add(type)
                .AddBigEndian(SmartAccountProtocol.UInt64(BigInteger.One))).Key.ToArray();
            Assert.AreSequenceEqual(new byte[] { 0, 0, 0, 0, 0, 0, 0, 1 }, ModuleInstanceKey(BigInteger.One)[21..]);
            Assert.AreSequenceEqual(Enumerable.Repeat((byte)0xFF, 8).ToArray(), ModuleInstanceKey(ulong.MaxValue)[21..]);
            // Module index keys carry the type code between the account and the id.
            Assert.AreEqual((byte)SmartAccountModuleProtocol.ModuleTypeCodeValidator,
                ModuleIndexKey(SmartAccountModuleProtocol.ModuleTypeCodeValidator)[21]);
            Assert.AreEqual((byte)SmartAccountModuleProtocol.ModuleTypeCodeHook,
                ModuleIndexKey(SmartAccountModuleProtocol.ModuleTypeCodeHook)[21]);
            // A module id is range-checked to UInt64 before it reaches any key.
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.UInt64(BigInteger.One << 64));
        }

        [TestMethod]
        public void NonceChannelsAreDerivedBoundedAndRoundTrip()
        {
            byte[] digest = SmartAccountProtocol.ComputeNonceNamespaceDigest(Account, Service,
                BigInteger.One, BigInteger.Zero, BigInteger.Zero, NonceSubkey);
            Assert.HasCount(32, digest);
            Assert.AreSequenceEqual(digest, SmartAccountProtocol.ComputeNonceNamespaceDigest(Account, Service,
                BigInteger.One, BigInteger.Zero, BigInteger.Zero, NonceSubkey));
            foreach (var other in new[]
            {
                SmartAccountProtocol.ComputeNonceNamespaceDigest(Account, Service, new BigInteger(2), BigInteger.Zero, BigInteger.Zero, NonceSubkey),
                SmartAccountProtocol.ComputeNonceNamespaceDigest(Account, Service, BigInteger.One, BigInteger.One, BigInteger.Zero, NonceSubkey),
                SmartAccountProtocol.ComputeNonceNamespaceDigest(Account, Service, BigInteger.One, BigInteger.Zero, BigInteger.One, NonceSubkey),
                SmartAccountProtocol.ComputeNonceNamespaceDigest(Account, Custody, BigInteger.One, BigInteger.Zero, BigInteger.Zero, NonceSubkey),
                SmartAccountProtocol.ComputeNonceNamespaceDigest(Custody, Service, BigInteger.One, BigInteger.Zero, BigInteger.Zero, NonceSubkey),
                SmartAccountProtocol.ComputeNonceNamespaceDigest(Account, Service, BigInteger.One, BigInteger.Zero, BigInteger.Zero, Enumerable.Repeat((byte)0xEE, 32).ToArray()),
            })
                Assert.AreNotEqual(Convert.ToHexString(digest), Convert.ToHexString(other));

            byte[] channel = SmartAccountProtocol.DeriveChannel(digest);
            Assert.HasCount(SmartAccountModuleProtocol.NonceChannelSize, channel);
            Assert.AreEqual(0, channel[0] & 0x80);
            Assert.AreEqual((byte)(digest[8] & 0x7F), channel[0]);
            Assert.AreSequenceEqual(digest[9..32], channel[1..]);
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.DeriveChannel(new byte[31]));

            foreach (BigInteger sequence in new BigInteger[] { 0, 1, ulong.MaxValue })
            {
                // channel ‖ sequence, packed exactly as §4.1 defines the field.
                BigInteger nonce = (new BigInteger(channel, isUnsigned: true, isBigEndian: true) << 64) | sequence;
                Assert.AreSequenceEqual(channel, SmartAccountProtocol.EncodeChannel(nonce >> 64));
                Assert.AreEqual((ulong)sequence, SmartAccountProtocol.SequenceFromNonce(nonce));
            }
            // The largest encodable channel has a clear top bit (2^191 - 1); its packed nonce is the largest
            // legal nonce below the 2^255 field bound.
            byte[] widest = SmartAccountProtocol.EncodeChannel((BigInteger.One << 191) - 1);
            Assert.AreEqual(((BigInteger.One << 191) - 1) << 64 | ulong.MaxValue,
                (new BigInteger(widest, isUnsigned: true, isBigEndian: true) << 64) | ulong.MaxValue);
            Assert.AreEqual((BigInteger.One << 255) - 1,
                (new BigInteger(widest, isUnsigned: true, isBigEndian: true) << 64) | ulong.MaxValue);
            Assert.ThrowsExactly<InvalidOperationException>(() => SmartAccountProtocol.EncodeChannel(-1));
            Assert.ThrowsExactly<InvalidOperationException>(() => SmartAccountProtocol.EncodeChannel(BigInteger.One << 191));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.SequenceFromNonce(-1));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.SequenceFromNonce(BigInteger.One << 255));
        }

        [TestMethod]
        public void EncodingHelpersPinNetworkAndCounterEndianness()
        {
            Span<byte> counter = stackalloc byte[8];
            SmartAccountProtocol.WriteUInt64Be(counter, BigInteger.One);
            Assert.AreEqual("0000000000000001", Convert.ToHexStringLower(counter.ToArray()));
            SmartAccountProtocol.WriteUInt64Be(counter, ulong.MaxValue);
            Assert.AreEqual("ffffffffffffffff", Convert.ToHexStringLower(counter.ToArray()));
            Assert.AreEqual(ulong.MaxValue, SmartAccountProtocol.UInt64(ulong.MaxValue));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.WriteUInt64Be(new byte[8], -1));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.WriteUInt64Be(new byte[8], BigInteger.One << 64));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.UInt64(-1));
        }
    }
}
