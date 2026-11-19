// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccountEnvelope.cs file belongs to the neo project and is free
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
using Neo.Network.P2P.Payloads;
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

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// The v4 transaction envelope (spec §4.1): the initializer carries exactly
    /// [accountId, payload] and no other authority. The golden bytes come from
    /// generate-smartaccount-v4-vectors.py, an implementation independent of the
    /// kernel, so a drift in the emitted script fails here.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountEnvelope
    {
        private const int BatchMax = SmartAccountModuleProtocol.MaxOperationsPerEnvelope;

        private static readonly JsonElement Vectors = LoadVectors();
        private static readonly UInt160 Account = UInt160.Parse(Vectors.GetProperty("accountId").GetString());
        private static readonly UInt160 Service = UInt160.Parse("0x398dc3f0227d7efac5533ed5ce9937390c158084");
        private static readonly byte[] NonceSubkey = new byte[SmartAccountModuleProtocol.NonceSubkeySize];
        // Any non-empty signature is legal on the wire; the canonical form blanks it.
        private static readonly byte[] Signature = Enumerable.Repeat((byte)0x11, 64).ToArray();

        private static JsonElement LoadVectors()
        {
            string path = Path.Combine(AppContext.BaseDirectory, "SmartContract", "Native", "TestFile",
                "smartaccount-v4-vectors.json");
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            return document.RootElement.Clone();
        }

        private static Array Operation(BigInteger nonce = default) => new([
            new Integer(SmartAccountModuleProtocol.ModuleProtocolVersion), Service.ToArray(), "ping", new Array(),
            nonce, NonceSubkey, new BigInteger(1_700_000_000_000),
            BigInteger.Zero, BigInteger.Zero, BigInteger.One, BigInteger.Zero,
            Signature, new Array(),
        ]);

        private static byte[] Serialized(StackItem item) => BinarySerializer.Serialize(item,
            SmartAccountModuleProtocol.OperationEncodedSizeMax * 4,
            SmartAccountModuleProtocol.OperationEncodedSizeMax * 4);

        /// <summary>The entrypoint call tail of the envelope (everything after the initializer).</summary>
        private static byte[] Tail(bool isBatch, CallFlags flags = CallFlags.All)
        {
            using ScriptBuilder builder = new();
            builder.EmitPush((int)flags).EmitPush(isBatch ? "executeUserOps" : "executeUserOp")
                .EmitPush(Service).EmitSysCall(ApplicationEngine.System_Contract_Call);
            return builder.ToArray();
        }

        private static string ApplicationScript(Array payload, bool isBatch) =>
            Convert.ToHexStringLower(SmartAccountEnvelope.CreateApplicationScript(Account, payload, isBatch));

        [TestMethod]
        public void SingleEnvelopeRoundTripsPreservesTheOperationAndMatchesTheVm()
        {
            Array op = Operation();
            byte[] script = SmartAccountEnvelope.CreateApplicationScript(Account, op, false);
            var envelope = SmartAccountEnvelope.Parse(Account, script);
            Assert.AreEqual(Account, envelope.AccountId);
            Assert.IsFalse(envelope.IsBatch);
            Assert.AreEqual(1, envelope.Count);
            Assert.AreSequenceEqual(Serialized(op), Serialized(envelope.GetOperation(0)));
            Assert.IsTrue(script.AsSpan().EndsWith(Tail(false)));
            AssertInitializerValue(script, op, false);
            // The builder is deterministic and canonical round trips through Parse.
            Assert.AreSequenceEqual(script, SmartAccountEnvelope.CreateApplicationScript(Account, op, false));
        }

        [TestMethod]
        public void BatchEnvelopeRoundTripsPreservesOrderAndMatchesTheVm()
        {
            Array batch = new([Operation(), Operation(1)]);
            byte[] script = SmartAccountEnvelope.CreateApplicationScript(Account, batch, true);
            var envelope = SmartAccountEnvelope.Parse(Account, script);
            Assert.IsTrue(envelope.IsBatch);
            Assert.AreEqual(2, envelope.Count);
            Assert.IsTrue(script.AsSpan().EndsWith(Tail(true)));
            for (int i = 0; i < 2; i++)
                Assert.AreEqual(new BigInteger(i), envelope.GetOperation(i)[SmartAccountModuleProtocol.OpNonce].GetInteger());
            AssertInitializerValue(script, batch, true);
        }

        [TestMethod]
        [DataRow(1)]
        [DataRow(BatchMax)]
        public void BatchPreservesOrder(int count)
        {
            Array batch = new(Enumerable.Range(0, count).Select(n => Operation(n)));
            var envelope = SmartAccountEnvelope.Parse(Account,
                SmartAccountEnvelope.CreateApplicationScript(Account, batch, true));
            Assert.IsTrue(envelope.IsBatch);
            Assert.AreEqual(count, envelope.Count);
            for (int i = 0; i < count; i++)
                Assert.AreEqual(new BigInteger(i), envelope.GetOperation(i)[SmartAccountModuleProtocol.OpNonce].GetInteger());
        }

        [TestMethod]
        [DataRow(0)]
        [DataRow(BatchMax + 1)]
        public void BatchCountOutsideProfileIsRejected(int count)
        {
            Array batch = new(Enumerable.Range(0, count).Select(n => Operation(n)));
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(Account, batch, true));
        }

        [TestMethod]
        public void IndividuallyValidOperationsCanStillExceedTransactionSize()
        {
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = new Array([new ByteString(new byte[4090])]);
            Array batch = new(Enumerable.Repeat(op, BatchMax));
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(Account, batch, true));
        }

        [TestMethod]
        public void InvalidPayloadTypesAndNullHostArgumentsAreRejected()
        {
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(Account, new Struct(Operation()), false));
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(Account, new Array([StackItem.Null]), true));
            Assert.ThrowsExactly<ArgumentNullException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(Account, null, false));
            Assert.ThrowsExactly<ArgumentNullException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(null, Operation(), false));
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(UInt160.Zero, Operation(), false));
            Assert.ThrowsExactly<ArgumentNullException>(() => SmartAccountEnvelope.Parse(null, new byte[] { 1 }));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountEnvelope.Parse(UInt160.Zero, new byte[] { 1 }));
        }

        [TestMethod]
        public void ReturnedOperationsAndSourceBytesCannotRetargetEnvelope()
        {
            Array op = Operation();
            byte[] signature = [1, 2, 3];
            op[SmartAccountModuleProtocol.OpSignature] = signature;
            byte[] script = SmartAccountEnvelope.CreateApplicationScript(Account, op, false);
            var envelope = SmartAccountEnvelope.Parse(Account, script);
            byte[] initial = Serialized(envelope.GetOperation(0));
            System.Array.Fill(script, (byte)0);
            signature[0] ^= 1;
            op[SmartAccountModuleProtocol.OpNonce] = 999;
            var returned = envelope.GetOperation(0);
            returned[SmartAccountModuleProtocol.OpMethod] = "changed";
            ((Array)returned[SmartAccountModuleProtocol.OpArgs]).Add("changed");
            Assert.AreSequenceEqual(initial, Serialized(envelope.GetOperation(0)));
            Assert.ThrowsExactly<ArgumentOutOfRangeException>(() => envelope.GetOperation(-1));
            Assert.ThrowsExactly<ArgumentOutOfRangeException>(() => envelope.GetOperation(1));
        }

        [TestMethod]
        public void AccountIdentityIsAnOwnedSnapshot()
        {
            byte[] script = SmartAccountEnvelope.CreateApplicationScript(Account, Operation(), false);
            UInt160 input = new(Account.ToArray());
            var envelope = SmartAccountEnvelope.Parse(input, script);
            MemoryReader reader = new(Service.ToArray());
            input.Deserialize(ref reader);
            Assert.AreEqual(Account, envelope.AccountId);
            UInt160 returned = envelope.AccountId;
            reader = new(Service.ToArray());
            returned.Deserialize(ref reader);
            Assert.AreEqual(Account, envelope.AccountId);
        }

        [TestMethod]
        [DataRow("wrong-account")]
        [DataRow("zero-account")]
        [DataRow("wrong-flags")]
        [DataRow("wrong-method")]
        [DataRow("wrong-service")]
        [DataRow("wrong-syscall")]
        [DataRow("wrong-count")]
        [DataRow("batch-confusion")]
        [DataRow("prefix-nop")]
        [DataRow("suffix-ret")]
        [DataRow("two-calls")]
        [DataRow("unused-value")]
        public void EnvelopeSubstitutionAndExtraInstructionsAreRejected(string defect)
        {
            byte[] script = SmartAccountEnvelope.CreateApplicationScript(Account, Operation(), false);
            UInt160 expectedAccount = Account;
            byte[] initializer = script[..^Tail(false).Length];
            switch (defect)
            {
                case "wrong-account": expectedAccount = Service; break;
                case "zero-account": expectedAccount = UInt160.Zero; break;
                case "wrong-flags": script = [.. initializer, .. Tail(false, CallFlags.ReadOnly)]; break;
                case "wrong-method": script = [.. initializer, .. Tail(true)]; break;
                case "wrong-service":
                    script = [.. initializer, .. Tail(false)];
                    script[^6] ^= 1;
                    break;
                case "wrong-syscall":
                    script = [.. initializer, .. Tail(false)];
                    script[^1] ^= 1;
                    break;
                case "wrong-count": script[initializer.Length - 1] = (byte)OpCode.PUSH3; break;
                case "batch-confusion": script = [.. initializer, .. Tail(true)]; break;
                case "prefix-nop": script = [(byte)OpCode.NOP, .. script]; break;
                case "suffix-ret": script = [.. script, (byte)OpCode.RET]; break;
                case "two-calls": script = [.. script, .. script]; break;
                case "unused-value": script = [(byte)OpCode.PUSHNULL, .. script]; break;
                default: Assert.Fail(defect); break;
            }
            Assert.ThrowsExactly<FormatException>(() => SmartAccountEnvelope.Parse(expectedAccount, script));
        }

        [TestMethod]
        [DataRow("wide-zero")]
        [DataRow("wide-data")]
        [DataRow("empty-pack")]
        [DataRow("convert")]
        [DataRow("dup")]
        [DataRow("call")]
        [DataRow("syscall")]
        public void EquivalentAndExecutableInitializersAreRejected(string defect)
        {
            byte[] script = SmartAccountEnvelope.CreateApplicationScript(Account, Operation(), false);
            byte[] initializer = script[..^Tail(false).Length];
            byte[] mutated = defect switch
            {
                "wide-zero" => [.. initializer[..2], (byte)OpCode.PUSHINT8, 0, .. initializer[3..]],
                "wide-data" => [(byte)OpCode.PUSHDATA2, 0, 0, .. initializer[2..]],
                "empty-pack" => [.. initializer[..4], (byte)OpCode.PUSH0, (byte)OpCode.PACK, .. initializer[5..]],
                "convert" => [.. initializer, (byte)OpCode.CONVERT, (byte)StackItemType.Array],
                "dup" => [.. initializer, (byte)OpCode.DUP, (byte)OpCode.DROP],
                "call" => [.. initializer, (byte)OpCode.CALL, 0],
                "syscall" => [.. initializer, (byte)OpCode.SYSCALL, 0, 0, 0, 0],
                _ => throw new ArgumentException(defect)
            };
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.Parse(Account, [.. mutated, .. Tail(false)]));
        }

        [TestMethod]
        public void EveryTruncationOfValidEnvelopeIsRejected()
        {
            byte[] script = SmartAccountEnvelope.CreateApplicationScript(Account, Operation(), false);
            for (int i = 0; i < script.Length; i++)
            {
                byte[] truncated = script[..i];
                Assert.ThrowsExactly<FormatException>(() => SmartAccountEnvelope.Parse(Account, truncated), $"Cut at {i}");
            }
        }

        [TestMethod]
        [DataRow("truncated-data1")]
        [DataRow("truncated-data2")]
        [DataRow("oversized-data4")]
        [DataRow("truncated-integer")]
        [DataRow("missing-pack-count")]
        [DataRow("boolean-pack-count")]
        [DataRow("negative-pack-count")]
        [DataRow("excessive-pack-count")]
        [DataRow("incomplete-pack")]
        [DataRow("empty-prefix")]
        [DataRow("non-array-root")]
        [DataRow("oversized-data2")]
        [DataRow("too-deep")]
        [DataRow("too-large")]
        public void MalformedInitializerFailsWithFormatException(string defect)
        {
            byte[] initializer = defect switch
            {
                "truncated-data1" => [(byte)OpCode.PUSHDATA1],
                "truncated-data2" => [(byte)OpCode.PUSHDATA2, 0],
                "oversized-data4" => [(byte)OpCode.PUSHDATA4, 255, 255, 255, 255],
                "truncated-integer" => [(byte)OpCode.PUSHINT256, 1],
                "missing-pack-count" => [(byte)OpCode.PACK],
                "boolean-pack-count" => [(byte)OpCode.PUSHT, (byte)OpCode.PACK],
                "negative-pack-count" => [(byte)OpCode.PUSHM1, (byte)OpCode.PACK],
                "excessive-pack-count" => [(byte)OpCode.PUSHINT32, 255, 255, 255, 127, (byte)OpCode.PACK],
                "incomplete-pack" => [(byte)OpCode.PUSH1, (byte)OpCode.PACK],
                "empty-prefix" => [],
                "non-array-root" => [(byte)OpCode.PUSH1],
                "oversized-data2" => [(byte)OpCode.PUSHDATA2, 1, 16],
                "too-deep" => [(byte)OpCode.PUSHNULL, .. Enumerable.Repeat(
                    new byte[] { (byte)OpCode.PUSH1, (byte)OpCode.PACK }, 20000).SelectMany(x => x)],
                "too-large" => new byte[Transaction.MaxTransactionSize + 1],
                _ => throw new ArgumentException(defect)
            };
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.Parse(Account, [.. initializer, .. Tail(false)]));
        }

        [TestMethod]
        public void CanonicalInitializerMatchesActualVmForAllSupportedTypes()
        {
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = new Array([
                StackItem.Null, true, false, -1, 0, 16, 17, 127, 128, -128, -129,
                short.MaxValue, ushort.MaxValue, int.MaxValue, uint.MaxValue,
                new Integer(long.MinValue), new Integer(long.MaxValue),
                new Integer(BigInteger.One << 100), new Integer((BigInteger.One << 255) - 1),
                new Integer(-(BigInteger.One << 255)),
                ByteString.Empty, new ByteString(new byte[254]), new ByteString(new byte[255]),
                new ByteString(new byte[256]), new Array(), new Array([true, new Array([1, "nested"])]),
                new Array([new Array([new Array([StackItem.Null])])]),
            ]);
            byte[] script = SmartAccountEnvelope.CreateApplicationScript(Account, op, false);
            AssertInitializerValue(script, op, false);
        }

        private static void AssertInitializerValue(byte[] script, StackItem payload, bool batch)
        {
            byte[] tail = Tail(batch);
            using var engine = ApplicationEngine.Run(script[..^tail.Length],
                TestBlockchain.GetTestSnapshotCache(), settings: TestProtocolSettings.Default);
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            Assert.AreEqual(1, engine.ResultStack.Count);
            StackItem pushed = engine.ResultStack.Pop();
            Assert.IsInstanceOfType<Array>(pushed);
            Array arguments = (Array)pushed;
            Assert.AreEqual(2, arguments.Count);
            Assert.AreSequenceEqual(Account.ToArray(), arguments[0].GetSpan().ToArray());
            Assert.AreSequenceEqual(Serialized(payload), Serialized(arguments[1]));

            var parsed = SmartAccountEnvelope.Parse(Account, script);
            StackItem reconstructed = batch
                ? new Array(Enumerable.Range(0, parsed.Count).Select(parsed.GetOperation))
                : parsed.GetOperation(0);
            Assert.AreSequenceEqual(Serialized(payload), Serialized(reconstructed));
        }

        [TestMethod]
        public void DeterministicGeneratedInitializersMatchVmAndRoundTrip()
        {
            Random random = new(742);
            for (int i = 0; i < 64; i++)
            {
                Array op = Operation(i);
                op[SmartAccountModuleProtocol.OpArgs] = new Array([
                    new Integer(random.NextInt64()), random.Next(2) == 1,
                    new ByteString(new byte[random.Next(0, 300)]),
                    new Array([StackItem.Null, random.Next(-20000, 20000)])]);
                op[SmartAccountModuleProtocol.OpSignature] = new ByteString(new byte[random.Next(1, 65)]);
                AssertInitializerValue(SmartAccountEnvelope.CreateApplicationScript(Account, op, false), op, false);
            }
            Array batch = new([Operation(0), Operation(1)]);
            AssertInitializerValue(SmartAccountEnvelope.CreateApplicationScript(Account, batch, true), batch, true);
        }

        [TestMethod]
        public void ArbitraryMutationsEitherRejectOrRemainCanonicalVmInitializers()
        {
            byte[] baseline = SmartAccountEnvelope.CreateApplicationScript(Account, Operation(), false);
            Random random = new(925);
            for (int i = 0; i < 512; i++)
            {
                byte[] mutated = baseline.ToArray();
                mutated[random.Next(mutated.Length)] ^= (byte)(1 << random.Next(8));
                SmartAccountEnvelope parsed;
                try { parsed = SmartAccountEnvelope.Parse(Account, mutated); }
                catch (FormatException) { continue; }
                Assert.IsFalse(parsed.IsBatch);
                Assert.AreSequenceEqual(mutated,
                    SmartAccountEnvelope.CreateApplicationScript(Account, parsed.GetOperation(0), false));
                AssertInitializerValue(mutated, parsed.GetOperation(0), false);
            }
        }

        [TestMethod]
        public void HistoricalSixFieldOperationIsRejected()
        {
            // ABI-2 payloads (six fields) are not operations under v4.
            Array legacy = new([Service.ToArray(), "ping", new Array(), BigInteger.Zero, BigInteger.Zero, ByteString.Empty]);
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(Account, legacy, false));
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(Account, new Array([legacy]), true));
        }

        [TestMethod]
        public void PayloadTypesOutsideTheEnvelopeDomainAreRejected()
        {
            // Struct containers are rejected anywhere in the operation, including
            // nested inside the argument array.
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = new Array([new Struct([true])]);
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountEnvelope.CreateApplicationScript(Account, op, false));
            // A batch is an Array of operations, never an operation itself.
            Assert.AreEqual(1, SmartAccountEnvelope.Parse(Account,
                SmartAccountEnvelope.CreateApplicationScript(Account, Operation(), false)).Count);
            Assert.IsFalse(SmartAccountEnvelope.Parse(Account,
                SmartAccountEnvelope.CreateApplicationScript(Account, Operation(), false)).IsBatch);
        }

        [TestMethod]
        public void EnvelopeScriptAndSingleOperationShareTheSameDigestInput()
        {
            // Whatever the envelope carries is exactly the operation the digest is
            // computed over: the parsed operation re-serialises to the pinned bytes.
            byte[] script = SmartAccountEnvelope.CreateApplicationScript(Account, Operation(), false);
            Array parsed = SmartAccountEnvelope.Parse(Account, script).GetOperation(0);
            Assert.AreEqual(Vectors.GetProperty("operation").GetProperty("canonical").GetString(),
                Convert.ToHexStringLower(SmartAccountProtocol.SerializeCanonicalOperation(parsed)));
            Assert.IsNotEmpty(ApplicationScript(Operation(), false));
            Assert.IsNotEmpty(ApplicationScript(new Array([Operation()]), true));
            var distinct = new HashSet<string>(StringComparer.Ordinal)
            {
                ApplicationScript(Operation(), false),
                ApplicationScript(Operation(1), false),
                ApplicationScript(new Array([Operation()]), true),
            };
            Assert.HasCount(3, distinct);
        }
    }
}
