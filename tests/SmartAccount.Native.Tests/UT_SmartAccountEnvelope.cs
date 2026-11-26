// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccountEnvelope.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for details.
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
    /// [accountId, payload] where payload is one canonical UserOperation, and the
    /// tail is exactly <c>executeUserOp</c>. The golden bytes come from
    /// generate-smartaccount-v4-vectors.py, an implementation independent of the
    /// kernel, so a drift in the emitted script fails here.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountEnvelope
    {
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
            // §4.1 [8]: the credential generation is 1-based; 0 is malformed.
            BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero,
            Signature, new Array(),
        ]);

        private static byte[] Serialized(StackItem item) => BinarySerializer.Serialize(item,
            SmartAccountModuleProtocol.OperationEncodedSizeMax * 4,
            SmartAccountModuleProtocol.OperationEncodedSizeMax * 4);

        /// <summary>The entrypoint call tail of the envelope (everything after the initializer).</summary>
        private static byte[] Tail(CallFlags flags = CallFlags.All)
        {
            using ScriptBuilder builder = new();
            builder.EmitPush((int)flags).EmitPush("executeUserOp")
                .EmitPush(Service).EmitSysCall(ApplicationEngine.System_Contract_Call);
            return builder.ToArray();
        }

        /// <summary>
        /// The client envelope, byte-identical to the shared SDK's <c>codec.dynamicCall(core, "executeUserOp",
        /// [accountId, operation])</c>. Transaction construction is the client's job, so the test builds it with the
        /// platform's ScriptBuilder and the kernel only recognizes it.
        /// </summary>
        private static byte[] CanonicalScript(UInt160 accountId, StackItem payload) =>
            CanonicalScript(accountId, SmartAccountProtocol.ValidateOperation(payload));

        private static byte[] CanonicalScript(UInt160 accountId,
            SmartAccountProtocol.ValidatedOperation operation)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            if (accountId == UInt160.Zero)
                throw new FormatException("The envelope requires a nonzero account identifier.");
            return SmartAccountTestSupport.ExecuteUserOp(accountId, operation.Operation);
        }

        private static string EnvelopeHex(Array payload) =>
            Convert.ToHexStringLower(CanonicalScript(Account, payload));

        private static string Hex(byte[] bytes) => Convert.ToHexStringLower(bytes);

        /// <summary>
        /// Everything after the operation literal is the fixed tail the shared SDK's <c>dynamicCall(core,
        /// "executeUserOp", [accountId, operation])</c> appends (shared/nativeSmartAccount.mjs): the account as
        /// PUSHDATA1, PUSH2, PACK, PUSH15 (CallFlags.All), PUSHDATA1 "executeUserOp", PUSHDATA1 core, SYSCALL
        /// 627d5b52 (System.Contract.Call) and no RET. The kernel compares these bytes; a client that emits
        /// anything else here is not recognized.
        /// </summary>
        [TestMethod]
        public void CallTailIsTheSharedSdkDynamicCallTail()
        {
            byte[] script = CanonicalScript(Account, Operation());
            string expected = "0c14" + Hex(Account.ToArray())
                + "12c0" + "1f" + "0c0d" + Hex("executeUserOp"u8.ToArray())
                + "0c14" + Hex(Service.ToArray()) + "41627d5b52";
            Assert.AreEqual(expected, Hex(script[^(expected.Length / 2)..]));
        }

        /// <summary>
        /// The proxy script and the entry script are defined by one layout: an account push, then the dynamic
        /// call tail of this core. The proxy bytes are the shared SDK's <c>nativeProxyVerificationScript</c>.
        /// </summary>
        [TestMethod]
        public void ProxyScriptIsTheAccountPushAndTheVerifyCallTail()
        {
            const string Tail = "11c0150c06"; // PUSH1 PACK PUSH5 PUSHDATA1 6
            foreach (UInt160 id in new[] { Account, Service })
            {
                byte[] script = SmartAccountProtocol.CreateVerificationScript(id);
                Assert.AreEqual("0c14" + Hex(id.ToArray()) + Tail + Hex("verify"u8.ToArray())
                    + "0c14" + Hex(Service.ToArray()) + "41627d5b52", Hex(script));
                Assert.IsTrue(SmartAccountProtocol.IsProxyVerificationScript(script));
            }
            string method = Hex("verify"u8.ToArray()), call = "0c14" + Hex(Service.ToArray()) + "41627d5b52";
            string account = "0c14" + Hex(Account.ToArray());
            string proxy = account + Tail + method + call;
            Assert.IsTrue(SmartAccountProtocol.IsProxyVerificationScript(Convert.FromHexString(proxy)));
            // The proxy is exactly that script: no zero account, other flag set, other method or trailing byte.
            foreach ((string label, string candidate) in new[]
            {
                ("zero account", "0c14" + new string('0', 40) + Tail + method + call),
                ("other flags", account + "11c01f0c06" + method + call),
                ("other method", account + Tail + "0c06" + Hex("verifyx"u8.ToArray()) + call),
                ("trailing byte", proxy + "40"),
                ("truncated", proxy[..^2]),
                ("wider account push", "0d1400" + proxy[4..]),
            })
                Assert.IsFalse(SmartAccountProtocol.IsProxyVerificationScript(Convert.FromHexString(candidate)), label);
            Assert.IsFalse(SmartAccountProtocol.IsProxyVerificationScript(
                CanonicalScript(Account, Operation())), "an entry script is not a proxy");
        }

        [TestMethod]
        public void SingleEnvelopeRoundTripsPreservesTheOperationAndMatchesTheVm()
        {
            Array op = Operation();
            byte[] script = CanonicalScript(Account, op);
            Array envelope = SmartAccountProtocol.ValidateEntryScript(Account, script).Operation;
            Assert.AreEqual(SmartAccountModuleProtocol.UserOperationFieldCount, envelope.Count);
            Assert.AreSequenceEqual(Serialized(op), Serialized(envelope));
            Assert.IsTrue(script.AsSpan().EndsWith(Tail()));
            AssertInitializerValue(script, op);
            // The builder is deterministic and canonical round trips through Parse.
            Assert.AreSequenceEqual(script, CanonicalScript(Account, op));
        }

        /// <summary>
        /// There is no second entrypoint: an Array of operations is not an
        /// operation, so both the batch shape and the batch tail are rejected.
        /// </summary>
        [TestMethod]
        public void BatchShapesAreRejected()
        {
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, new Array([Operation(), Operation(1)])));
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, new Array()));
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, new Array([Operation()])));

            byte[] script = CanonicalScript(Account, Operation());
            byte[] initializer = script[..^Tail().Length];
            byte[] batchTail;
            using (ScriptBuilder builder = new())
            {
                batchTail = [.. initializer, .. builder.EmitPush((int)CallFlags.All).EmitPush("executeUserOps")
                    .EmitPush(Service).EmitSysCall(ApplicationEngine.System_Contract_Call).ToArray()];
            }
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account, batchTail));
        }

        [TestMethod]
        public void OversizedOperationIsRejected()
        {
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] =
                new Array([new ByteString(new byte[SmartAccountModuleProtocol.ArgsSerializedSizeMax])]);
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, op));
        }

        [TestMethod]
        public void InvalidPayloadTypesAndNullHostArgumentsAreRejected()
        {
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, new Struct(Operation())));
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, new Array([StackItem.Null])));
            Assert.ThrowsExactly<ArgumentNullException>(() =>
                CanonicalScript(Account, (StackItem)null));
            Assert.ThrowsExactly<ArgumentNullException>(() =>
                CanonicalScript(null, Operation()));
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(UInt160.Zero, Operation()));
            Assert.ThrowsExactly<ArgumentNullException>(() => SmartAccountProtocol.ValidateEntryScript(null, new byte[] { 1 }));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(UInt160.Zero, new byte[] { 1 }));
        }

        [TestMethod]
        public void ReturnedOperationAndSourceBytesCannotRetargetEnvelope()
        {
            Array op = Operation();
            byte[] signature = [1, 2, 3];
            op[SmartAccountModuleProtocol.OpSignature] = signature;
            byte[] script = CanonicalScript(Account, op);
            Array envelope = SmartAccountProtocol.ValidateEntryScript(Account, script).Operation;
            byte[] initial = Serialized(envelope);
            System.Array.Fill(script, (byte)0);
            signature[0] ^= 1;
            op[SmartAccountModuleProtocol.OpNonce] = 999;
            Assert.AreSequenceEqual(initial, Serialized(envelope),
                "the parsed operation is an independent copy of the script bytes");
        }

        [TestMethod]
        [DataRow("wrong-account")]
        [DataRow("zero-account")]
        [DataRow("wrong-flags")]
        [DataRow("wrong-method")]
        [DataRow("wrong-service")]
        [DataRow("wrong-syscall")]
        [DataRow("wrong-count")]
        [DataRow("prefix-nop")]
        [DataRow("suffix-ret")]
        [DataRow("two-calls")]
        [DataRow("unused-value")]
        [DataRow("jump")]
        [DataRow("appended-call")]
        [DataRow("appended-push")]
        [DataRow("wide-flags")]
        [DataRow("wide-method")]
        [DataRow("ret-inside-tail")]
        public void EnvelopeSubstitutionAndExtraInstructionsAreRejected(string defect)
        {
            byte[] script = CanonicalScript(Account, Operation());
            UInt160 expectedAccount = Account;
            byte[] initializer = script[..^Tail().Length];
            switch (defect)
            {
                case "wrong-account": expectedAccount = Service; break;
                case "zero-account": expectedAccount = UInt160.Zero; break;
                case "wrong-flags": script = [.. initializer, .. Tail(CallFlags.ReadOnly)]; break;
                case "wrong-method":
                    using (ScriptBuilder builder = new())
                    {
                        script = [.. initializer, .. builder.EmitPush((int)CallFlags.All)
                            .EmitPush("executeUserOps").EmitPush(Service)
                            .EmitSysCall(ApplicationEngine.System_Contract_Call).ToArray()];
                    }
                    break;
                case "wrong-service":
                    script = [.. initializer, .. Tail()];
                    script[^6] ^= 1;
                    break;
                case "wrong-syscall":
                    script = [.. initializer, .. Tail()];
                    script[^1] ^= 1;
                    break;
                case "wrong-count": script[initializer.Length - 1] = (byte)OpCode.PUSH3; break;
                case "jump": script = [.. initializer, (byte)OpCode.JMP, 0, .. Tail()]; break;
                case "appended-call": script = [.. script, .. Tail()]; break;
                case "appended-push": script = [.. script, (byte)OpCode.PUSHNULL]; break;
                // The same call in a noncanonical spelling: a wide integer literal for the flags, a wide data
                // literal for the method, or a RET between the arguments and the call.
                case "wide-flags": script = [.. initializer, (byte)OpCode.PUSHINT8, 15, .. Tail()[1..]]; break;
                case "wide-method": script = [.. initializer, (byte)OpCode.PUSHDATA2, 12, 0,
                    .. "executeUserOp"u8.ToArray(), .. Tail()[16..]]; break;
                case "ret-inside-tail": script = [.. initializer, (byte)OpCode.RET, .. Tail()]; break;
                case "prefix-nop": script = [(byte)OpCode.NOP, .. script]; break;
                case "suffix-ret": script = [.. script, (byte)OpCode.RET]; break;
                case "two-calls": script = [.. script, .. script]; break;
                case "unused-value": script = [(byte)OpCode.PUSHNULL, .. script]; break;
                default: Assert.Fail(defect); break;
            }
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(expectedAccount, script));
        }

        [TestMethod]
        [DataRow("wide-zero")]
        [DataRow("wide-data")]
        [DataRow("wide-account")]
        [DataRow("empty-pack")]
        [DataRow("convert")]
        [DataRow("dup")]
        [DataRow("call")]
        [DataRow("syscall")]
        public void EquivalentAndExecutableInitializersAreRejected(string defect)
        {
            byte[] script = CanonicalScript(Account, Operation());
            byte[] initializer = script[..^Tail().Length];
            byte[] mutated = defect switch
            {
                "wide-zero" => [.. initializer[..2], (byte)OpCode.PUSHINT8, 0, .. initializer[3..]],
                "wide-data" => [(byte)OpCode.PUSHDATA2, 0, 0, .. initializer[2..]],
                "wide-account" => [.. initializer[..^22], (byte)OpCode.PUSHDATA2, 0x14, 0x00, .. initializer[^20..]],
                "empty-pack" => [.. initializer[..4], (byte)OpCode.PUSH0, (byte)OpCode.PACK, .. initializer[5..]],
                "convert" => [.. initializer, (byte)OpCode.CONVERT, (byte)StackItemType.Array],
                "dup" => [.. initializer, (byte)OpCode.DUP, (byte)OpCode.DROP],
                "call" => [.. initializer, (byte)OpCode.CALL, 0],
                "syscall" => [.. initializer, (byte)OpCode.SYSCALL, 0, 0, 0, 0],
                _ => throw new ArgumentException(defect)
            };
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountProtocol.ValidateEntryScript(Account, (byte[])[.. mutated, .. Tail()]));
        }

        /// <summary>
        /// The kernel obtains the operation by recognizing the transaction script's canonical end state; it never
        /// executes that script and never rebuilds it. These are the ways an envelope could otherwise smuggle
        /// authority past the proxy witness: a second call, a branch, bytes after the single call, or another
        /// account, entrypoint or payload than the one the witness names.
        /// </summary>
        [TestMethod]
        public void RecognitionRejectsExtraCallsControlFlowTrailingBytesAndSubstitutions()
        {
            Array operation = Operation();
            byte[] script = CanonicalScript(Account, operation);
            byte[] initializer = script[..^Tail().Length];
            byte[] tail = Tail();

            // A second call before or after the canonical one, with or without its own arguments.
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account,
                (byte[])[.. tail, .. script]));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account,
                (byte[])[.. script, .. tail]));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account,
                (byte[])[.. initializer, .. tail, .. tail]));

            // Control flow anywhere in the program, even one that would jump over nothing.
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account,
                (byte[])[.. initializer, (byte)OpCode.JMP, 0, .. tail]));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account,
                (byte[])[(byte)OpCode.NOP, .. script]));

            // Trailing bytes after the single System.Contract.Call.
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account,
                (byte[])[.. script, (byte)OpCode.RET]));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account,
                (byte[])[.. script, 0x00]));

            // Parameter substitution: another account, another flag set, another operation.
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Service, script));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account,
                (byte[])[.. initializer, .. Tail(CallFlags.ReadOnly)]));
            Array substituted = SmartAccountProtocol.ValidateEntryScript(Account,
                CanonicalScript(Account, Operation(1))).Operation;
            Assert.AreSequenceEqual(SmartAccountTestSupport.Canonical(Operation(1)),
                SmartAccountTestSupport.Canonical(substituted));
            Assert.AreNotEqual(
                Convert.ToHexStringLower(SmartAccountTestSupport.Canonical(operation)),
                Convert.ToHexStringLower(SmartAccountTestSupport.Canonical(substituted)),
                "a substituted payload is a different operation, so it cannot reuse the signed digest");
        }

        /// <summary>
        /// A PACK count written with a wider integer literal is semantically identical, passes the
        /// opcode whitelist and executes to the same array, yet is still rejected: only the canonical literal
        /// width is accepted, so no byte can be hidden in a wider operand.
        /// </summary>
        [TestMethod]
        public void SemanticallyIdenticalWiderPackCountIsRejected()
        {
            byte[] script = CanonicalScript(Account, Operation());
            byte[] initializer = script[..^Tail().Length];
            Assert.AreEqual((byte)OpCode.PUSH2, initializer[^2]);
            Assert.AreEqual((byte)OpCode.PACK, initializer[^1]);
            byte[] widened =
            [
                .. initializer[..^2], (byte)OpCode.PUSHINT8, 0x02, (byte)OpCode.PACK, .. Tail(),
            ];
            // The VM itself accepts it: the initializer is still a valid data constructor.
            using (var engine = ApplicationEngine.Run(widened[..^Tail().Length],
                TestBlockchain.GetTestSnapshotCache(), settings: TestProtocolSettings.Default))
            {
                Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
                Assert.AreEqual(1, engine.ResultStack.Count);
            }
            Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account, widened));
        }

        [TestMethod]
        public void EveryTruncationOfValidEnvelopeIsRejected()
        {
            byte[] script = CanonicalScript(Account, Operation());
            for (int i = 0; i < script.Length; i++)
            {
                byte[] truncated = script[..i];
                Assert.ThrowsExactly<FormatException>(() => SmartAccountProtocol.ValidateEntryScript(Account, truncated), $"Cut at {i}");
            }
        }

        /// <summary>
        /// The operation profile owns reference identity, not just values: a container that
        /// contains itself, or the same container twice, has no canonical serialization.
        /// </summary>
        [TestMethod]
        public void CyclicAndRepeatedPayloadContainersAreRejected()
        {
            Array cyclic = new();
            cyclic.Add(cyclic);
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = cyclic;
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, op));

            Array shared = new([BigInteger.One]);
            op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = new Array([shared, shared]);
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, op));
        }

        /// <summary>
        /// A container count can never exceed the values pushed for it, and whatever an initializer packs that is
        /// not one 13-field operation is refused: an array past the VM stack limit is not an operation.
        /// </summary>
        [TestMethod]
        public void InitializerBeyondTheMaximumStackSizeIsRejected()
        {
            var count = (int)ExecutionEngineLimits.Default.MaxStackSize + 1;
            using ScriptBuilder builder = new();
            for (var i = 0; i < count; i++) builder.Emit(OpCode.PUSHNULL);
            builder.EmitPush(count).Emit(OpCode.PACK);
            Assert.ThrowsExactly<FormatException>(() =>
                SmartAccountProtocol.ValidateEntryScript(Account, (byte[])[.. builder.ToArray(), .. Tail()]));
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
                SmartAccountProtocol.ValidateEntryScript(Account, (byte[])[.. initializer, .. Tail()]));
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
            byte[] script = CanonicalScript(Account, op);
            AssertInitializerValue(script, op);
        }

        private static void AssertInitializerValue(byte[] script, StackItem payload)
        {
            byte[] tail = Tail();
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

            Array parsed = SmartAccountProtocol.ValidateEntryScript(Account, script).Operation;
            Assert.AreSequenceEqual(Serialized(payload), Serialized(parsed));
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
                AssertInitializerValue(CanonicalScript(Account, op), op);
            }
        }

        [TestMethod]
        public void ArbitraryMutationsEitherRejectOrRemainCanonicalVmInitializers()
        {
            byte[] baseline = CanonicalScript(Account, Operation());
            Random random = new(925);
            for (int i = 0; i < 512; i++)
            {
                byte[] mutated = baseline.ToArray();
                mutated[random.Next(mutated.Length)] ^= (byte)(1 << random.Next(8));
                SmartAccountProtocol.ValidatedOperation parsed;
                try { parsed = SmartAccountProtocol.ValidateEntryScript(Account, mutated); }
                catch (FormatException) { continue; }
                Assert.AreSequenceEqual(mutated,
                    CanonicalScript(Account, parsed));
                AssertInitializerValue(mutated, parsed.Operation);
            }
        }

        [TestMethod]
        public void HistoricalSixFieldOperationIsRejected()
        {
            // ABI-2 payloads (six fields) are not operations under v4.
            Array legacy = new([Service.ToArray(), "ping", new Array(), BigInteger.Zero, BigInteger.Zero, ByteString.Empty]);
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, legacy));
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, new Array([legacy])));
        }

        [TestMethod]
        public void PayloadTypesOutsideTheEnvelopeDomainAreRejected()
        {
            // Struct containers are rejected anywhere in the operation, including
            // nested inside the argument array.
            Array op = Operation();
            op[SmartAccountModuleProtocol.OpArgs] = new Array([new Struct([true])]);
            Assert.ThrowsExactly<FormatException>(() =>
                CanonicalScript(Account, op));
            // The parsed payload is one operation, never a collection of them.
            Array parsed = SmartAccountProtocol.ValidateEntryScript(Account,
                CanonicalScript(Account, Operation())).Operation;
            Assert.AreEqual(SmartAccountModuleProtocol.UserOperationFieldCount, parsed.Count);
        }

        [TestMethod]
        public void EnvelopeScriptAndSingleOperationShareTheSameDigestInput()
        {
            // Whatever the envelope carries is exactly the operation the digest is
            // computed over: the parsed operation re-serialises to the pinned bytes.
            byte[] script = CanonicalScript(Account, Operation());
            Array parsed = SmartAccountProtocol.ValidateEntryScript(Account, script).Operation;
            Assert.AreEqual(Vectors.GetProperty("operation").GetProperty("canonical").GetString(),
                Convert.ToHexStringLower(SmartAccountTestSupport.Canonical(parsed)));
            Assert.IsNotEmpty(EnvelopeHex(Operation()));
            var distinct = new HashSet<string>(StringComparer.Ordinal)
            {
                EnvelopeHex(Operation()),
                EnvelopeHex(Operation(1)),
            };
            Assert.HasCount(2, distinct);
        }
    }
}
