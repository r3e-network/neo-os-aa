using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.IO;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;
using VmArray = Neo.VM.Types.Array;
using VmBuffer = Neo.VM.Types.Buffer;
using VmMap = Neo.VM.Types.Map;

namespace AbstractAccount.Contracts.Tests;

/// <summary>Actual complete private-method execution, not public ABI or universal proof.</summary>
[TestClass]
public class ImplementationRefinementMethodRuntimeTests
{
    private static readonly BigInteger VmMax = (BigInteger.One << 255) - 1;
    private const long HostGas = 100_00000000;
    private sealed record Result(bool Fault, BigInteger? Value, byte[]? Committed, byte[]? Pending, string? Error);

    private sealed class Harness
    {
        private const int MethodPc = 13557;
        private const string NefHash = "083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a";
        private const string ManifestHash = "e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156";
        private readonly RuntimeFixture fx = new();
        private readonly ContractState core;
        private readonly StorageKey key;
        private readonly Script parentScript;

        public Harness(long systemFee, long networkFee, bool outerFault = false)
        {
            string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
            byte[] nefBytes = File.ReadAllBytes(Path.Combine(root, "contracts/bin/v3/UnifiedSmartWalletV3.nef"));
            byte[] manifestBytes = File.ReadAllBytes(Path.Combine(root, "contracts/bin/v3/UnifiedSmartWalletV3.manifest.json"));
            Assert.AreEqual(NefHash, Convert.ToHexString(SHA256.HashData(nefBytes)).ToLowerInvariant());
            Assert.AreEqual(ManifestHash, Convert.ToHexString(SHA256.HashData(manifestBytes)).ToLowerInvariant());
            Assert.AreEqual(new Version(3, 10, 1, 0), typeof(ApplicationEngine).Assembly.GetName().Version);
            Assert.AreEqual(new Version(3, 10, 1, 0), typeof(ExecutionEngine).Assembly.GetName().Version);
            UInt160 hash = fx.DeployArtifact(nefBytes, System.Text.Encoding.UTF8.GetString(manifestBytes));
            core = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, hash)!;
            CollectionAssert.AreEqual(new byte[] { (byte)OpCode.INITSLOT, 7, 1 }, core.Nef.Script.Span.Slice(MethodPc, 3).ToArray());
            Assert.AreEqual("serialize", core.Nef.Tokens[3].Method);
            Assert.AreEqual("deserialize", core.Nef.Tokens[4].Method);
            key = new StorageKey { Id = core.Id, Key = new byte[] { 0x21 } };
            using ScriptBuilder outer = new();
            if (outerFault)
            {
                outer.EmitPush("refinement parent failure");
                outer.Emit(OpCode.ABORTMSG);
            }
            else outer.Emit(OpCode.RET);
            parentScript = new Script(outer.ToArray());
            fx.Engine.Transaction.SystemFee = systemFee;
            fx.Engine.Transaction.NetworkFee = networkFee;
            fx.Engine.Transaction.Script = parentScript;
        }

        public byte[] Hash => fx.Engine.Transaction.Hash.ToArray();
        public byte[] OtherHash
        {
            get { byte[] other = Hash; other[0] ^= 1; return other; }
        }
        public void Seed(StackItem record) => SeedBytes(BinarySerializer.Serialize(record, ExecutionEngineLimits.Default));
        public void SeedBytes(byte[] bytes)
        {
            StorageItem? prior = fx.Engine.Storage.Snapshot.GetAndChange(key);
            if (prior is null) fx.Engine.Storage.Snapshot.Add(key, new StorageItem(bytes));
            else prior.Value = bytes;
        }
        public void ValidateTransactionFeeEncoding()
        {
            using MemoryStream stream = new();
            using BinaryWriter writer = new(stream);
            ((IVerifiable)fx.Engine.Transaction).SerializeUnsigned(writer);
            var reader = new MemoryReader(stream.ToArray());
            new Transaction { Signers = [], Attributes = [], Witnesses = [] }.DeserializeUnsigned(ref reader);
        }
        public Result Run(StackItem requested, CallFlags flags = CallFlags.All, long gas = HostGas)
        {
            // Use the genuine ApplicationEngine factory, not TestingApplicationEngine:
            // TestEngine.Fee aliases Transaction.NetworkFee and would change the oracle
            // inputs/hash. Hosting GAS is a separate explicit RPC-style allowance.
            DataCache transactionSnapshot = fx.Engine.Storage.Snapshot.CloneCache();
            Block block = new()
            {
                Header = new Header
                {
                    Index = fx.Engine.PersistingBlock.Index,
                    Timestamp = (ulong)fx.Engine.PersistingBlock.Timestamp.TotalMilliseconds,
                    Nonce = fx.Engine.PersistingBlock.Nonce,
                    PrevHash = UInt256.Zero, MerkleRoot = UInt256.Zero,
                    NextConsensus = fx.Engine.ValidatorsAddress,
                    Witness = new Witness { InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = ReadOnlyMemory<byte>.Empty }
                },
                Transactions = []
            };
            using ApplicationEngine app = ApplicationEngine.Create(TriggerType.Application,
                fx.Engine.Transaction, transactionSnapshot, block, fx.Engine.ProtocolSettings, gas);
            Assert.AreEqual(typeof(ApplicationEngine), app.GetType(), "An unexpected provider replaced the pinned engine");
            app.LoadScript(parentScript);
            DataCache pending = app.SnapshotCache;
            // Only the descriptor is synthetic. Original NEF/manifest, tokens,
            // static initializer and native functions are unchanged.
            Neo.VM.ExecutionContext methodContext = app.LoadContract(core, new ContractMethodDescriptor
            {
                Name = "refinement_private_cap",
                Offset = MethodPc,
                Parameters = new[] { new ContractParameterDefinition { Name = "requested", Type = ContractParameterType.Integer } },
                ReturnType = ContractParameterType.Integer,
                Safe = false
            }, flags);
            // LoadContract has put the real initializer above this frame;
            // push into the method frame, not the initializer's stack.
            methodContext.EvaluationStack.Push(requested);
            VMState state = app.Execute();
            bool fault = state.HasFlag(VMState.FAULT);
            BigInteger? value = null;
            if (!fault)
            {
                Assert.AreEqual(VMState.HALT, state);
                Assert.IsNotNull(methodContext.StaticFields);
                Assert.AreEqual(StackItemType.Buffer, methodContext.StaticFields![34].Type,
                    "Actual readonly byte[] initializer uses a Buffer, not an invented integer/byte value");
                CollectionAssert.AreEqual(new byte[] { 0x21 }, methodContext.StaticFields![34].GetSpan().ToArray(),
                    "Original initializer must bind static slot 34 to the actual storage key");
                value = app.ResultStack.Pop().GetInteger();
                // Explicit outer persistence policy, matching pinned HALT-only
                // application snapshot commit. Native block fee burning is absent.
                transactionSnapshot.Commit();
            }
            return new Result(fault, value, fx.Engine.Storage.Snapshot.TryGet(key)?.Value.ToArray(),
                pending.TryGet(key)?.Value.ToArray(), app.FaultException?.Message);
        }

    }

    private static StackItem Ledger(byte[] hash, StackItem reserved, string shape = "array") => shape switch
    {
        "array" => new VmArray(new StackItem[] { new ByteString(hash), reserved }),
        "struct" => new Struct(new StackItem[] { new ByteString(hash), reserved }),
        "map" => new VmMap { [new Integer(0)] = new ByteString(hash), [new Integer(1)] = reserved },
        _ => throw new ArgumentException(shape)
    };
    private static StackItem Decode(byte[] bytes) => BinarySerializer.Deserialize(bytes, ExecutionEngineLimits.Default);
    private static StackItem Field(StackItem row, int index) => row switch
    {
        VmArray array => array[index],
        VmMap map => map[new Integer(index)],
        _ => throw new ArgumentException("Unexpected test record")
    };
    private static BigInteger ProtocolCharge(BigInteger cost, BigInteger requested, BigInteger reserved) =>
        cost.IsZero ? requested : BigInteger.Min(requested, BigInteger.Max(cost - reserved, 0));
    private static void CheckLedger(byte[]? raw, byte[] hash, BigInteger reserved)
    {
        Assert.IsNotNull(raw);
        StackItem row = Decode(raw);
        CollectionAssert.AreEqual(hash, Field(row, 0).GetSpan().ToArray());
        Assert.AreEqual(reserved, Field(row, 1).GetInteger());
    }

    [TestMethod]
    public void AbsentBudgetUsesOriginalInitializationAndPersistsBothFields()
    {
        Harness h = new(7, 3);
        Result result = h.Run(new Integer(17));
        Assert.IsFalse(result.Fault, result.Error);
        Assert.AreEqual(ProtocolCharge(10, 17, 0), result.Value);
        CheckLedger(result.Committed, h.Hash, 10);
        Assert.AreEqual(StackItemType.Array, Decode(result.Committed!).Type);
    }

    [TestMethod]
    public void ExistingSameTransactionSettlesOnlyTheRemainingPaidFee()
    {
        Harness h = new(7, 3);
        h.Seed(Ledger(h.Hash, new Integer(6)));
        Result result = h.Run(new Integer(8));
        Assert.IsFalse(result.Fault, result.Error);
        Assert.AreEqual(ProtocolCharge(10, 8, 6), result.Value);
        CheckLedger(result.Committed, h.Hash, 10);
    }

    [TestMethod]
    public void DifferentTransactionResetsMaximumPriorReservationBeforeArithmetic()
    {
        Harness h = new(7, 3);
        h.Seed(Ledger(h.OtherHash, new Integer(VmMax)));
        Result result = h.Run(new Integer(4));
        Assert.IsFalse(result.Fault, result.Error);
        Assert.AreEqual(new BigInteger(4), result.Value);
        CheckLedger(result.Committed, h.Hash, 4);
    }

    [TestMethod]
    public void ExhaustedPaidFeeAbortsAndKeepsCommittedRecordBytes()
    {
        Harness h = new(7, 3);
        StackItem before = Ledger(h.Hash, new Integer(10));
        h.Seed(before);
        Result result = h.Run(new Integer(1));
        Assert.IsTrue(result.Fault);
        StringAssert.Contains(result.Error!, "Reimbursement exceeds actual gas cost");
        CollectionAssert.AreEqual(BinarySerializer.Serialize(before, ExecutionEngineLimits.Default), result.Committed);
    }

    [TestMethod]
    public void ZeroFeeEstimationAccumulatesQuoteButOverflowDoesNotPersist()
    {
        Harness h = new(0, 0);
        h.Seed(Ledger(h.Hash, new Integer(17)));
        Result result = h.Run(new Integer(53));
        Assert.IsFalse(result.Fault, result.Error);
        Assert.AreEqual(new BigInteger(53), result.Value);
        CheckLedger(result.Committed, h.Hash, 70);
        Harness overflow = new(0, 0);
        StackItem before = Ledger(overflow.Hash, new Integer(VmMax));
        overflow.Seed(before);
        Result failed = overflow.Run(new Integer(1));
        Assert.IsTrue(failed.Fault);
        CollectionAssert.AreEqual(BinarySerializer.Serialize(before, ExecutionEngineLimits.Default), failed.Committed);
        Harness boundary = new(0, 0);
        boundary.Seed(Ledger(boundary.Hash, new Integer(VmMax - 1)));
        Result valid = boundary.Run(new Integer(1));
        Assert.IsFalse(valid.Fault, valid.Error);
        CheckLedger(valid.Committed, boundary.Hash, VmMax);
    }

    [TestMethod]
    public void LongMaxPaidCostIsReadAndFeeParserRejectsSignedLongSumOverflow()
    {
        Harness h = new(long.MaxValue - 3, 3);
        h.ValidateTransactionFeeEncoding();
        Result result = h.Run(new Integer(VmMax));
        Assert.IsFalse(result.Fault, result.Error);
        Assert.AreEqual(new BigInteger(long.MaxValue), result.Value);
        CheckLedger(result.Committed, h.Hash, long.MaxValue);
        Harness invalid = new(long.MaxValue, 1);
        Assert.ThrowsExactly<FormatException>(() => invalid.ValidateTransactionFeeEncoding());
    }

    [TestMethod]
    [DataRow("integer", true, 7)]
    [DataRow("true", true, 1)]
    [DataRow("false", false, 0)]
    [DataRow("bytes", true, 7)]
    [DataRow("buffer", false, 0)]
    [DataRow("null", false, 0)]
    [DataRow("oversizedBytes", false, 0)]
    [DataRow("paddedPositive", true, 7)]
    [DataRow("paddedNegative", false, 0)]
    [DataRow("signed32Min", false, 0)]
    [DataRow("signed32Max", true, 10)]
    [DataRow("oversizedNegative", false, 0)]
    public void RequestedTagsFollowActualGetIntegerCoercion(string tag, bool success, int amount)
    {
        Harness h = new(7, 3);
        StackItem requested = tag switch
        {
            "integer" => new Integer(7), "true" => (StackItem)true, "false" => (StackItem)false,
            "bytes" => new ByteString(new byte[] { 7 }), "buffer" => new VmBuffer(new byte[] { 7 }),
            "null" => StackItem.Null, "oversizedBytes" => new ByteString(new byte[33]),
            "paddedPositive" => new ByteString(new byte[] { 7, 0 }),
            "paddedNegative" => new ByteString(new byte[] { 0xff, 0xff }),
            "signed32Min" => new ByteString((-(BigInteger.One << 255)).ToByteArray()),
            "signed32Max" => new ByteString(VmMax.ToByteArray()),
            "oversizedNegative" => new ByteString(Enumerable.Repeat((byte)0xff, 33).ToArray()),
            _ => throw new ArgumentException(tag)
        };
        Result result = h.Run(requested);
        Assert.AreEqual(!success, result.Fault, result.Error);
        if (success)
        {
            Assert.AreEqual(new BigInteger(amount), result.Value);
            CheckLedger(result.Committed, h.Hash, amount);
        }
        else Assert.IsNull(result.Committed);
    }

    [TestMethod]
    [DataRow("array")]
    [DataRow("struct")]
    [DataRow("map")]
    public void InjectedArrayStructAndMapFieldsExecuteWithoutClassShapeGuard(string shape)
    {
        // Struct/Map are deliberate probes outside the produced Array ledger invariant.
        Harness h = new(7, 3);
        h.Seed(Ledger(h.Hash, new Integer(2), shape));
        Result result = h.Run(new Integer(3));
        Assert.IsFalse(result.Fault, result.Error);
        CheckLedger(result.Committed, h.Hash, 5);
        StackItemType expected = shape switch { "array" => StackItemType.Array, "struct" => StackItemType.Struct, _ => StackItemType.Map };
        Assert.AreEqual(expected, Decode(result.Committed!).Type);
        Assert.AreEqual(StackItemType.Integer, Field(Decode(result.Committed!), 1).Type);
    }

    [TestMethod]
    [DataRow("badEncoding")]
    [DataRow("arrayShort")]
    [DataRow("structShort")]
    [DataRow("nullReserved")]
    [DataRow("nestedReserved")]
    [DataRow("mapMissingReserved")]
    [DataRow("mapWrongKeys")]
    public void InjectedMalformedStorageFaultsWithoutCommittingReplacement(string kind)
    {
        Harness h = new(7, 3);
        byte[] raw = kind == "badEncoding" ? new byte[] { 0xff } : BinarySerializer.Serialize(kind switch
        {
            "arrayShort" => new VmArray(new StackItem[] { new ByteString(h.Hash) }),
            "structShort" => new Struct(new StackItem[] { new ByteString(h.Hash) }),
            "nullReserved" => Ledger(h.Hash, StackItem.Null),
            "nestedReserved" => Ledger(h.Hash, new VmArray()),
            "mapMissingReserved" => new VmMap { [new Integer(0)] = new ByteString(h.Hash) },
            "mapWrongKeys" => new VmMap { [new ByteString(new byte[] { 0 })] = new ByteString(h.Hash) },
            _ => throw new ArgumentException(kind)
        }, ExecutionEngineLimits.Default);
        h.SeedBytes(raw);
        Result result = h.Run(new Integer(3));
        Assert.IsTrue(result.Fault);
        CollectionAssert.AreEqual(raw, result.Committed);
    }

    [TestMethod]
    public void MismatchedHashRepairsMapWithMissingReservationKey()
    {
        Harness h = new(7, 3);
        h.Seed(new VmMap { [new Integer(0)] = new ByteString(h.OtherHash) });
        Result result = h.Run(new Integer(3));
        Assert.IsFalse(result.Fault, result.Error);
        CheckLedger(result.Committed, h.Hash, 3);
    }

    [TestMethod]
    public void ExtraStoredArrayFieldIsPreservedAsAnOutOfInvariantProbe()
    {
        Harness h = new(7, 3);
        h.Seed(new VmArray(new StackItem[] { new ByteString(h.Hash), new Integer(2), new Integer(99) }));
        Result result = h.Run(new Integer(3));
        Assert.IsFalse(result.Fault, result.Error);
        CheckLedger(result.Committed, h.Hash, 5);
        Assert.AreEqual(new BigInteger(99), Field(Decode(result.Committed!), 2).GetInteger());
    }

    [TestMethod]
    public void InjectedNegativeReservationShowsWhyReachableLedgerInvariantIsRequired()
    {
        Harness h = new(7, 3);
        h.Seed(Ledger(h.Hash, new Integer(-5)));
        Result result = h.Run(new Integer(15));
        Assert.IsFalse(result.Fault, result.Error);
        Assert.AreEqual(new BigInteger(15), result.Value, "Injected corruption is not a reachable production defect claim");
        CheckLedger(result.Committed, h.Hash, 10);
    }

    [TestMethod]
    [DataRow("bytes")]
    [DataRow("true")]
    public void InjectedReservedCoercionsNormalizeToIntegerOnHeapUpdate(string tag)
    {
        Harness h = new(7, 3);
        h.Seed(Ledger(h.Hash, tag == "true" ? (StackItem)true : new ByteString(new byte[] { 1 })));
        Result result = h.Run(new Integer(10));
        Assert.IsFalse(result.Fault, result.Error);
        Assert.AreEqual(new BigInteger(9), result.Value);
        CheckLedger(result.Committed, h.Hash, 10);
        Assert.AreEqual(StackItemType.Integer, Field(Decode(result.Committed!), 1).Type);
    }

    [TestMethod]
    public void ReadOnlyCallFlagsDenyTheRealStoragePutWithoutCommit()
    {
        Harness h = new(7, 3);
        StackItem before = Ledger(h.Hash, new Integer(2));
        h.Seed(before);
        Result result = h.Run(new Integer(3), CallFlags.ReadOnly);
        Assert.IsTrue(result.Fault);
        CollectionAssert.AreEqual(BinarySerializer.Serialize(before, ExecutionEngineLimits.Default), result.Committed);
    }

    [TestMethod]
    public void InsufficientHostGasDoesNotCommitAReservation()
    {
        Harness h = new(7, 3);
        Result result = h.Run(new Integer(3), gas: 1);
        Assert.IsTrue(result.Fault);
        Assert.IsNull(result.Committed);
    }

    [TestMethod]
    public void LaterParentAbortLeavesPendingWriteButNoOuterSnapshotCommit()
    {
        Harness h = new(7, 3, outerFault: true);
        StackItem before = Ledger(h.Hash, new Integer(2));
        h.Seed(before);
        Result result = h.Run(new Integer(3));
        Assert.IsTrue(result.Fault);
        StringAssert.Contains(result.Error!, "refinement parent failure");
        CheckLedger(result.Pending, h.Hash, 5);
        CollectionAssert.AreEqual(BinarySerializer.Serialize(before, ExecutionEngineLimits.Default), result.Committed);
    }

    [TestMethod]
    [DataRow("buffer")]
    [DataRow("null")]
    public void ExplicitVmConvertIsDistinctFromImplicitHelperArithmetic(string tag)
    {
        // A separate primitive-opcode check, not a replacement helper script.
        StackItem source = tag == "buffer" ? new VmBuffer(new byte[] { 7 }) : StackItem.Null;
        StackItem converted = ExecuteIntegerConversion(source);
        if (tag == "buffer")
        {
            Assert.AreEqual(StackItemType.Integer, converted.Type);
            Assert.AreEqual(new BigInteger(7), converted.GetInteger());
        }
        else Assert.AreSame(StackItem.Null, converted);
        Assert.IsTrue(new Harness(7, 3).Run(source).Fault,
            "The original helper has no argument CONVERT and uses GetInteger directly");
    }

    private static StackItem ExecuteIntegerConversion(StackItem source)
    {
        using ExecutionEngine engine = new();
        Neo.VM.ExecutionContext context = engine.LoadScript(new Script(new byte[]
            { (byte)OpCode.CONVERT, (byte)StackItemType.Integer, (byte)OpCode.RET }, strictMode: true));
        context.EvaluationStack.Push(source);
        Assert.AreEqual(VMState.HALT, engine.Execute());
        return engine.ResultStack.Pop();
    }
}
