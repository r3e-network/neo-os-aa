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
                Convert.ToHexStringLower(SmartAccountProtocol.SerializeCanonicalOperation(op)),
                "native canonical operation bytes drifted from the shared vector");
            // The same claim through the plain serialiser, on the blanked form:
            // §4.2 removes the signature before anything is hashed or signed.
            Array blanked = new(op) { [SmartAccountModuleProtocol.OpSignature] = ByteString.Empty };
            Assert.AreEqual(Hex(expected.GetProperty("equality"), "nativeBinarySerializerHex"),
                Convert.ToHexStringLower(BinarySerializer.Serialize(blanked, ExecutionEngineLimits.Default)));

            byte[] digest = SmartAccountProtocol.ComputeOperationDigest(
                (uint)Integer(native, "network"), core, account, op,
                Integer(operation, "validatorId"), Integer(operation, "credentialGeneration"),
                Integer(operation, "authorityEpoch"), Integer(operation, "configurationNonce"));
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
            Assert.AreEqual(Hex(expected, "nonceCursorKeyBytes"),
                Convert.ToHexStringLower(SmartAccountProtocol.GetNonceCursorKey(account, channel)));
            Assert.AreEqual(Hex(expected, "nonceNamespaceKeyBytes"),
                Convert.ToHexStringLower(SmartAccountProtocol.GetNonceNamespaceKey(account, channel)));
            Assert.AreEqual(expected.GetProperty("packedNonce").GetString(),
                SmartAccountProtocol.EncodeNonce(channel, 0).ToString());
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

            var builders = new Dictionary<string, Func<byte[]>>
            {
                ["0x50"] = () => SmartAccountProtocol.GetProtocolKey(),
                ["0x51"] = () => SmartAccountProtocol.GetAccountControlKey(account),
                ["0x52"] = () => SmartAccountProtocol.GetModuleInstanceKey(account, moduleId),
                ["0x53"] = () => SmartAccountProtocol.GetModuleIndexKey(
                    account, SmartAccountModuleProtocol.ModuleTypeCodeValidator, moduleId),
                ["0x54"] = () => SmartAccountProtocol.GetHookOrderKey(account),
                ["0x55"] = () => SmartAccountProtocol.GetConfigIntentKey(account, Integer(input, "intentId")),
                ["0x56"] = () => SmartAccountProtocol.GetNonceCursorKey(account, channel),
                ["0x57"] = () => SmartAccountProtocol.GetMessageSubjectKey(account),
                // 0x58 and 0x5D have a declared prefix but no named builder yet in
                // this kernel; the shared shape (prefix || raw accountId) is still
                // asserted so the pinned bytes cannot drift unnoticed.
                ["0x58"] = () => [SmartAccountModuleProtocol.PrefixApplicationContext, .. accountRaw],
                ["0x59"] = () => SmartAccountProtocol.GetCoreRecoveryKey(account),
                ["0x5A"] = () => SmartAccountProtocol.GetMigrationStateKey(account),
                ["0x5B"] = () => SmartAccountProtocol.GetThresholdPolicyKey(account, Integer(input, "policyId")),
                ["0x5C"] = () => SmartAccountProtocol.GetNonceNamespaceKey(account, channel),
                ["0x5D"] = () => [SmartAccountModuleProtocol.PrefixMarketControlEpoch, .. accountRaw],
                ["0x5E"] = () => SmartAccountProtocol.GetConfigIntentIndexKey(account),
            };

            Assert.HasCount(15, keys.EnumerateObject().ToArray());
            foreach (JsonProperty property in keys.EnumerateObject())
            {
                Assert.IsTrue(builders.ContainsKey(property.Name), $"unpinned prefix {property.Name}");
                byte[] built = builders[property.Name]();
                Assert.AreEqual(property.Value.GetString(), Convert.ToHexStringLower(built),
                    $"{property.Name} key bytes drifted from the shared vector");
                Assert.HasCount(lengths.GetProperty(property.Name).GetInt32(), built,
                    $"{property.Name} width drifted from the shared vector");
                if (property.Name != "0x50")
                    Assert.AreEqual(Convert.ToHexStringLower(accountRaw),
                        Convert.ToHexStringLower(built[1..21]));
            }
        }
        [TestMethod]
        public void MessageEnvelopeMatchesThePinnedDerivation()
        {
            JsonElement vector = Load("message-envelope");
            JsonElement input = vector.GetProperty("input");
            JsonElement expected = vector.GetProperty("expected");
            JsonElement native = expected.GetProperty("native");

            UInt160 account = UInt160.Parse(Hex(input, "accountId"));
            UInt160 core = UInt160.Parse(Hex(native, "coreHash"));
            Assert.AreEqual(NativeContract.SmartAccount.Hash, core,
                "the pinned native core hash is the kernel's service hash");
            Assert.AreEqual((uint)native.GetProperty("network").GetInt64(),
                UT_SmartAccount.Settings.Network);

            byte[] callerScript = UT_SmartAccount.ForwarderScript();
            Assert.AreEqual(Hex(native, "forwarderScriptHex"),
                Convert.ToHexStringLower(callerScript),
                "the pinned caller is this fixture's forwarder, byte for byte");
            Assert.AreEqual(Hex(native, "originalSender"),
                callerScript.ToScriptHash().ToString());

            // §8 domain, recomputed from the pinned inputs.
            byte[] messageHash = Convert.FromHexString(Hex(input, "messageHash"));
            byte[] domain = SmartAccountProtocol.Concat(
                "NeoSmartAccount/Message"u8.ToArray(),
                [SmartAccountModuleProtocol.ModuleProtocolVersion],
                SmartAccountProtocol.UInt32Le((uint)native.GetProperty("network").GetInt64()),
                core.ToArray(), account.ToArray(), callerScript.ToScriptHash().ToArray(),
                SmartAccountProtocol.UInt64Be(Integer(input, "validatorId")),
                SmartAccountProtocol.UInt64Be(Integer(input, "credentialGeneration")),
                SmartAccountProtocol.UInt64Be(Integer(input, "authorityEpoch")));
            Assert.AreEqual(Hex(native, "messageDomainHex"), Convert.ToHexStringLower(domain),
                "§8 message domain drifted from the pinned vector");
            Assert.AreEqual(Hex(native, "messageDigestHex"), Convert.ToHexStringLower(
                System.Security.Cryptography.SHA256.HashData(domain.Concat(messageHash).ToArray())));

            DataCache snapshot = UT_SmartAccount.Snapshot();
            UInt160 registered = UT_SmartAccount.Register(snapshot);
            Assert.AreEqual(Hex(input, "accountId"), registered.ToString(),
                "the vector account is this fixture's custody + salt");
            UInt160 caller = UT_SmartAccount.Forwarder(snapshot);
            Assert.AreEqual(Hex(native, "originalSender"), caller.ToString(),
                "the deployed forwarder must be the pinned caller");

            object[] envelope = [
                (BigInteger)Integer(input, "envelopeVersion"),
                (BigInteger)Integer(input, "validatorId"),
                (BigInteger)Integer(input, "credentialGeneration"),
                native.GetProperty("signaturePairs").EnumerateArray()
                    .Select(pair => (object)pair.EnumerateArray()
                        .Select(item => (object)Convert.FromHexString(item.GetString())).ToArray())
                    .ToArray(),
            ];

            Assert.AreEqual(Hex(expected, "successMagicHex"), Convert.ToHexStringLower(
                UT_SmartAccount.Success(snapshot, "call", [registered, messageHash, envelope],
                    target: caller).GetSpan().ToArray()),
                "a pinned, subject-authorized P-256 signature must return the strict magic");

            // F-16 negative half: ERC-1271 is a magic surface, never a throw surface.
            Assert.AreEqual(Hex(expected, "failureMagicHex"), Convert.ToHexStringLower(
                UT_SmartAccount.Success(snapshot, "call", [registered, new byte[32], envelope],
                    target: caller).GetSpan().ToArray()),
                "a signature over another message never verifies");
        }
    }
}
