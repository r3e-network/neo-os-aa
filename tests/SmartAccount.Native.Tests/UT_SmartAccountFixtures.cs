//
// UT_SmartAccountFixtures.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//

using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using Array = Neo.VM.Types.Array;
using ByteString = Neo.VM.Types.ByteString;
using Integer = Neo.VM.Types.Integer;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// The native half of <c>tests/fixtures/sa-module-protocol/</c>. The custom
    /// kernel asserts the same files from
    /// <c>SmartAccount.Contracts.Tests/ProtocolFixtureTests.cs</c>; a vector only
    /// closes when both kernels reproduce it (§1 rule 2 of the fixture README).
    /// The files are produced by <c>generate-vectors.py</c> from the
    /// specification alone, so nothing here is derived from the kernel.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountFixtures
    {
        private static readonly string RepoRoot =
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

        private static readonly string GoldenRoot = Path.Combine(
            RepoRoot, "tests", "fixtures", "sa-module-protocol", "golden-vectors");

        private static JsonElement Load(string name)
        {
            string path = Path.Combine(GoldenRoot, name + ".json");
            Assert.IsTrue(File.Exists(path), $"missing fixture {path}");
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            return document.RootElement.Clone();
        }

        private static string Hex(JsonElement element, string name) =>
            element.GetProperty(name).GetString();

        private static byte[] Raw(JsonElement element, string name) =>
            UInt160.Parse(Hex(element, name)).ToArray();

        private static BigInteger Integer(JsonElement element, string name) =>
            element.GetProperty(name).GetInt64();

        [TestMethod]
        public void OperationEnvelopeMatchesThePinnedBytesAndDigest()
        {
            JsonElement vector = Load("operation-envelope");
            JsonElement input = vector.GetProperty("input");
            JsonElement operation = input.GetProperty("operation");
            JsonElement expected = vector.GetProperty("expected");
            JsonElement native = expected.GetProperty("native");

            UInt160 account = UInt160.Parse(Hex(input, "accountId"));
            UInt160 core = UInt160.Parse(Hex(native, "coreHash"));

            Array args = new(operation.GetProperty("args").EnumerateArray()
                .Select(argument => argument.ValueKind == JsonValueKind.String
                    ? (StackItem)new ByteString(Convert.FromHexString(argument.GetString()))
                    : new Integer(argument.GetInt64()))
                .ToArray());
            Array op = new([
                new Integer(Integer(operation, "version")),
                new ByteString(UInt160.Parse(Hex(operation, "target")).ToArray()),
                Hex(operation, "method"),
                args,
                new Integer(Integer(operation, "nonce")),
                new ByteString(Convert.FromHexString(Hex(operation, "nonceSubkey"))),
                new Integer(Integer(operation, "deadline")),
                new Integer(Integer(operation, "validatorId")),
                new Integer(Integer(operation, "credentialGeneration")),
                new Integer(Integer(operation, "authorityEpoch")),
                new Integer(Integer(operation, "configurationNonce")),
                new ByteString(Convert.FromHexString(Hex(operation, "signature"))),
                new Array(),
            ]);

            Assert.AreEqual(Hex(expected, "canonicalUnsignedOperationHex"),
                Convert.ToHexStringLower(SmartAccountTestSupport.Canonical(op)),
                "native canonical operation bytes drifted from the shared vector");
            // The same claim through the plain serialiser, on the blanked form:
            // §4.2 removes the signature before anything is hashed or signed.
            Array blanked = new(op) { [SmartAccountModuleProtocol.OpSignature] = ByteString.Empty };
            Assert.AreEqual(Hex(expected.GetProperty("equality"), "nativeBinarySerializerHex"),
                Convert.ToHexStringLower(BinarySerializer.Serialize(blanked, ExecutionEngineLimits.Default)));

            byte[] digest = SmartAccountProtocol.ComputeOperationDigest(
                (uint)Integer(native, "network"), core, account,
                new SmartAccountProtocol.OperationFields(
                    Integer(operation, "validatorId"), Integer(operation, "credentialGeneration"),
                    Integer(operation, "authorityEpoch"), Integer(operation, "configurationNonce"),
                    Integer(operation, "nonce")),
                SmartAccountTestSupport.Canonical(op));
            Assert.AreEqual(Hex(native, "digestHex"), Convert.ToHexStringLower(digest),
                "native §4.3 digest drifted from the shared vector");
        }

        [TestMethod]
        public void NonceChannelMatchesThePinnedDerivation()
        {
            JsonElement vector = Load("nonce-channel");
            JsonElement input = vector.GetProperty("input");
            JsonElement expected = vector.GetProperty("expected").GetProperty("native");

            UInt160 account = UInt160.Parse(Hex(input, "accountId"));
            byte[] subkey = Convert.FromHexString(Hex(input, "nonceSubkey"));

            byte[] digest = SmartAccountProtocol.ComputeNonceNamespaceDigest(
                account, UInt160.Parse(Hex(expected, "coreHash")),
                (BigInteger)Integer(input, "authorityEpoch"), Integer(input, "validatorId"),
                Integer(input, "credentialGeneration"), subkey);
            Assert.AreEqual(Hex(expected, "fullDigestHex"), Convert.ToHexStringLower(digest));

            byte[] channel = SmartAccountProtocol.DeriveChannel(digest);
            Assert.AreEqual(Hex(expected, "channelBytesHex"), Convert.ToHexStringLower(channel));
            // The keys are the platform KeyBuilder layout the kernel builds; the pinned bytes prove it.
            Assert.AreEqual(Hex(expected, "nonceCursorKeyBytes"), Convert.ToHexStringLower(
                ((StorageKey)NativeContract.SmartAccount.Key(SmartAccountModuleProtocol.PrefixNonceCursor).Add(account).Add(channel)).Key.ToArray()));
            Assert.AreEqual(Hex(expected, "nonceNamespaceKeyBytes"), Convert.ToHexStringLower(
                ((StorageKey)NativeContract.SmartAccount.Key(SmartAccountModuleProtocol.PrefixNonceNamespace).Add(account).Add(channel)).Key.ToArray()));
            // §4.1: the packed nonce is channel ‖ sequence, both unsigned big-endian.
            Assert.AreEqual(expected.GetProperty("packedNonce").GetString(),
                (new BigInteger(channel, isUnsigned: true, isBigEndian: true) << 64).ToString());
        }

        [TestMethod]
        public void StorageKeysFollowThePinnedTable()
        {
            JsonElement vector = Load("storage-keys");
            JsonElement expected = vector.GetProperty("expected");
            JsonElement keys = expected.GetProperty("keys");
            JsonElement lengths = expected.GetProperty("lengths");
            JsonElement input = vector.GetProperty("input");

            UInt160 account = UInt160.Parse(Hex(input, "accountId"));
            byte[] accountRaw = account.ToArray();
            byte[] channel = Convert.FromHexString(Hex(input, "channelBytesHex"));
            BigInteger moduleId = Integer(input, "moduleId");

            SmartAccount core = NativeContract.SmartAccount;
            var builders = new Dictionary<string, Func<byte[]>>
            {
                ["0x50"] = () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixProtocolInfo)).Key.ToArray(),
                ["0x51"] = () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixAccountControl).Add(account)).Key.ToArray(),
                ["0x52"] = () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixModuleInstance).Add(account).AddBigEndian(SmartAccountProtocol.UInt64(moduleId))).Key.ToArray(),
                ["0x53"] = () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixModuleIndex).Add(account)
                    .Add(SmartAccountModuleProtocol.ModuleTypeCodeValidator).AddBigEndian(SmartAccountProtocol.UInt64(moduleId))).Key.ToArray(),
                ["0x56"] = () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixNonceCursor).Add(account).Add(channel)).Key.ToArray(),
                ["0x5C"] = () => ((StorageKey)core.Key(SmartAccountModuleProtocol.PrefixNonceNamespace).Add(account).Add(channel)).Key.ToArray(),
            };

            // The shared table also pins the prefixes of the features the
            // minimal core no longer owns (hook order, configuration intents,
            // message subjects, recovery, migration, threshold policy). Every
            // prefix this core still declares must reproduce the pinned bytes;
            // the retired ones are simply not built any more.
            Assert.HasCount(15, keys.EnumerateObject().ToArray());
            Assert.HasCount(6, builders);
            foreach (JsonProperty property in keys.EnumerateObject())
            {
                if (!builders.TryGetValue(property.Name, out Func<byte[]> build)) continue;
                byte[] built = build();
                Assert.AreEqual(property.Value.GetString(), Convert.ToHexStringLower(built),
                    $"{property.Name} key bytes drifted from the shared vector");
                Assert.HasCount(lengths.GetProperty(property.Name).GetInt32(), built,
                    $"{property.Name} width drifted from the shared vector");
                if (property.Name != "0x50")
                    Assert.AreEqual(Convert.ToHexStringLower(accountRaw),
                        Convert.ToHexStringLower(built[1..21]));
            }
        }
    }
}
