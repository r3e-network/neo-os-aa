using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.SmartContract;
using Neo.VM;
using Neo.VM.Types;
using VmArray = Neo.VM.Types.Array;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Concrete execution checks for one original NEF region, not a universal refinement proof.
/// The prestate deliberately projects past transaction/storage reads. The Coq arithmetic
/// domain is nonnegative signed-256 cost/reserved and positive signed-256 requested;
/// actual nonnegative Int64 fee sums are its narrower chain subdomain. Assertions and
/// reservation updates below are separately tested suffixes, outside that certificate.
/// No syscall, storage, transaction rollback, or ApplicationEngine gas theorem is inferred.
/// </summary>
[TestClass]
public class ImplementationRefinementRuntimeTests
{
    private const string NefHash = "6c347dac40bd562edda3216e40c7007fad3a2bb24020013e730c58bd4ceed1c3";
    private const string RegionHex = "11116bb99f74106b6a11ce9fba6c78a09e756d78b976";
    private const int MethodEntry = 17762;
    private const int RegionStart = 17872;
    private const int RegionEnd = 17894;
    private const int AssertionEnd = 17939;
    // The explicit VM-range guard is emitted after AssertionEnd; this is the
    // offset just past the reservation SETITEM/DROP it protects.
    private const int ReservationEnd = 18023;
    private static readonly BigInteger VmMax = (BigInteger.One << 255) - 1;
    private static readonly BigInteger VmMin = -(BigInteger.One << 255);
    private static readonly BigInteger ChainFeeMax = 2 * (BigInteger)long.MaxValue;
    private static readonly string RepoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private sealed record Outcome(bool Fault, int Pc, BigInteger? Settled,
        BigInteger? Flag, BigInteger? Cap, BigInteger Reserved, int StackCount, int[] Trace);

    // Coq source_charge, deliberately distinct from the branchless compiler expression.
    private static BigInteger Charge(BigInteger cost, BigInteger reserved, BigInteger requested) =>
        cost.IsZero ? requested : BigInteger.Min(requested, BigInteger.Max(cost - reserved, 0));

    private static byte[] ActualScript()
    {
        Assert.AreEqual(new Version(3, 10, 1, 0), typeof(ExecutionEngine).Assembly.GetName().Version,
            "Execution must use the locked Neo.VM 3.10.1 runtime");
        byte[] bytes = File.ReadAllBytes(Path.Combine(RepoRoot, "contracts/bin/v3/SmartAccountV3.nef"));
        Assert.AreEqual(NefHash, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), "Unreviewed NEF identity");
        byte[] script = NefFile.Parse(bytes, verify: true).Script.ToArray();
        CollectionAssert.AreEqual(new byte[] { (byte)OpCode.INITSLOT, 8, 1 }, script[MethodEntry..(MethodEntry + 3)]);
        Assert.AreEqual(RegionHex, Convert.ToHexString(script[RegionStart..RegionEnd]).ToLowerInvariant(), "Wrong certified region");
        return script;
    }

    private static Outcome Run(BigInteger cost, BigInteger reserved, BigInteger requested,
        int stop = RegionEnd, int? mutationPc = null, OpCode mutation = OpCode.NOP)
    {
        byte[] bytes = ActualScript();
        if (mutationPc is int pc)
        {
            Assert.IsTrue(pc >= RegionStart && pc < RegionEnd);
            Assert.AreNotEqual(bytes[pc], (byte)mutation);
            bytes[pc] = (byte)mutation;
        }
        var script = new Script(bytes, strictMode: true);
        // These are actual original offsets; no region relocation or synthetic RET.
        using var engine = new RegionEngine();
        var context = engine.LoadScript(script, rvcount: 1, initialPosition: RegionStart);
        engine.Push(new Integer(requested));
        // Dispatch the original method's INITSLOT to construct its real 8-local,
        // 1-argument frame. Transaction/storage prefix execution is not simulated.
        JumpTable.Default.InitSlot(engine, script.GetInstruction(MethodEntry));
        var budget = new VmArray(new StackItem[] { new ByteString(new byte[32]), new Integer(reserved) });
        engine.Push(budget);
        JumpTable.Default.ExecuteStoreToSlot(engine, context.LocalVariables!, 2);
        engine.Push(new Integer(cost));
        JumpTable.Default.ExecuteStoreToSlot(engine, context.LocalVariables!, 3);
        Assert.AreEqual(8, context.LocalVariables!.Count);
        Assert.AreEqual(1, context.Arguments!.Count);
        Assert.AreEqual(requested, context.Arguments[0].GetInteger());
        Assert.AreEqual(0, context.EvaluationStack.Count);
        var trace = new List<int>();
        int lastExecuted = RegionStart;
        while (context.InstructionPointer != stop && !engine.State.HasFlag(VMState.FAULT))
        {
            Assert.IsTrue(context.InstructionPointer >= RegionStart && context.InstructionPointer < stop,
                "Execution escaped the selected region/suffix");
            Assert.IsTrue(trace.Count < 64, "Region instruction limit exceeded");
            lastExecuted = context.InstructionPointer;
            trace.Add(lastExecuted);
            engine.Step();
        }
        return new Outcome(engine.State.HasFlag(VMState.FAULT),
            engine.State.HasFlag(VMState.FAULT) ? lastExecuted : context.InstructionPointer,
            ReadInteger(context.LocalVariables[6]), ReadInteger(context.LocalVariables[4]),
            ReadInteger(context.LocalVariables[5]), budget[1].GetInteger(),
            context.EvaluationStack.Count, trace.ToArray());

        static BigInteger? ReadInteger(StackItem item) => item is Integer integer ? integer.GetInteger() : null;
    }

    private sealed class RegionEngine : ExecutionEngine
    {
        public void Step() => ExecuteNext();
    }

    [TestMethod]
    public void NonnegativeVmAndChainDomainMatchesChargeOnActualBytes()
    {
        BigInteger[] edges = [0, 1, 2, long.MaxValue, ChainFeeMax, VmMax - 1, VmMax];
        int checkedStates = 0;
        foreach (BigInteger cost in edges)
            foreach (BigInteger reserved in edges)
                foreach (BigInteger requested in edges.Where(n => n > 0))
                {
                    Check(cost, reserved, requested);
                    checkedStates++;
                }
        var random = new Random(0xAA2026);
        for (int sample = 0; sample < 512; sample++)
        {
            byte[] bytes = new byte[32];
            BigInteger Next()
            {
                random.NextBytes(bytes);
                bytes[31] &= 0x7f;
                return new BigInteger(bytes, isUnsigned: true, isBigEndian: false);
            }
            BigInteger cost = sample % 2 == 0 ? Next() : Next() % (ChainFeeMax + 1);
            Check(cost, Next(), BigInteger.Max(Next(), 1));
            checkedStates++;
        }
        Assert.AreEqual(806, checkedStates);

        static void Check(BigInteger cost, BigInteger reserved, BigInteger requested)
        {
            Outcome result = Run(cost, reserved, requested);
            Assert.IsFalse(result.Fault, $"({cost},{reserved},{requested}) fault at PC {result.Pc}");
            Assert.AreEqual(Charge(cost, reserved, requested), result.Settled);
            Assert.AreEqual(1 - BigInteger.Min(cost, 1), result.Flag);
            Assert.AreEqual(BigInteger.Max(cost - reserved, 0) + (1 - BigInteger.Min(cost, 1)) * requested, result.Cap);
            Assert.AreEqual(reserved, result.Reserved, "Arithmetic region must not reserve or mutate storage");
            Assert.AreEqual(0, result.StackCount);
            CollectionAssert.AreEqual(Enumerable.Range(RegionStart, RegionEnd - RegionStart).ToArray(), result.Trace,
                "Must execute each original PC once without a synthetic return");
        }
    }

    [TestMethod]
    public void ZeroFeeEstimateUsesRequestedEvenWithPriorReservation()
    {
        foreach (BigInteger reserved in new BigInteger[] { 0, 17, VmMax })
            foreach (BigInteger requested in new BigInteger[] { 1, 53, VmMax })
            {
                Outcome result = Run(0, reserved, requested, AssertionEnd);
                Assert.IsFalse(result.Fault);
                Assert.AreEqual(requested, result.Settled);
                Assert.AreEqual(BigInteger.One, result.Flag);
                Assert.AreEqual(reserved, result.Reserved);
                Assert.IsFalse(result.Trace.Contains(17938), "Positive estimation must bypass real ABORTMSG");
            }
    }

    [TestMethod]
    public void ExhaustedFeeCapProducesZeroThenRealSuffixAborts()
    {
        foreach (BigInteger reserved in new BigInteger[] { 5, 6, VmMax })
        {
            Outcome arithmetic = Run(5, reserved, 10);
            Assert.IsFalse(arithmetic.Fault);
            Assert.AreEqual(BigInteger.Zero, arithmetic.Settled);
            Outcome assertion = Run(5, reserved, 10, AssertionEnd);
            Assert.IsTrue(assertion.Fault);
            Assert.AreEqual(17938, assertion.Pc, "The actual ABORTMSG must execute, not a host-side substitute");
            Assert.AreEqual(reserved, assertion.Reserved);
        }
        Assert.IsTrue(Run(1, 0, 0, AssertionEnd).Fault, "Zero requests fail the same actual suffix");
    }

    [TestMethod]
    public void ReservationOverflowIsOutsideArithmeticCertificateAndFaultsInActualSuffix()
    {
        Outcome arithmetic = Run(0, VmMax, 1);
        Assert.IsFalse(arithmetic.Fault);
        Assert.AreEqual(BigInteger.One, arithmetic.Settled);
        Outcome update = Run(0, VmMax, 1, ReservationEnd);
        Assert.IsTrue(update.Fault);
        // The overflow is rejected by the explicit margin assertion, before the
        // signed-256 ADD is reached, so the failure is a contract rejection and
        // not a CLR integer-size exception escaping the accumulator.
        Assert.AreEqual(18011, update.Pc, "The margin ABORTMSG must reject the overflow before the ADD");
        Assert.AreEqual(VmMax, update.Reserved, "Rejection occurs before SETITEM");
        Outcome boundary = Run(0, VmMax - 1, 1, ReservationEnd);
        Assert.IsFalse(boundary.Fault);
        Assert.AreEqual(VmMax, boundary.Reserved);
        Assert.AreEqual(0, boundary.StackCount);
    }

    [TestMethod]
    public void SignedInputsOutsideProofDomainHaveConcreteOverflowAndNegativeBehavior()
    {
        foreach (var (cost, reserved, requested, pc) in new[] {
            (VmMin, BigInteger.One, BigInteger.One, 17876),
            (VmMax, VmMin, BigInteger.One, 17883),
            (-BigInteger.One, BigInteger.Zero, VmMax, 17887) })
        {
            Outcome result = Run(cost, reserved, requested);
            Assert.IsTrue(result.Fault);
            Assert.AreEqual(pc, result.Pc);
        }
        Outcome negative = Run(0, 0, VmMin);
        Assert.IsFalse(negative.Fault);
        Assert.AreEqual(VmMin, negative.Settled);
        Assert.IsTrue(Run(0, 0, VmMin, AssertionEnd).Fault);
    }

    [TestMethod]
    public void IntegerConstructionRejectsOutsideSigned256InsteadOfReducingModulo()
    {
        Assert.AreEqual(32, Integer.MaxSize);
        Assert.AreEqual(VmMin, new Integer(VmMin).GetInteger());
        Assert.AreEqual(VmMax, new Integer(VmMax).GetInteger());
        Assert.ThrowsExactly<ArgumentException>(() => new Integer(VmMax + 1));
        Assert.ThrowsExactly<ArgumentException>(() => new Integer(VmMin - 1));
    }

    [TestMethod]
    public void ValidOpcodeMutationsAreExecutedAndSemanticallyRejected()
    {
        foreach (var (pc, opcode, cost, reserved, requested) in new[] {
            (17875, OpCode.MAX, 5, 0, 10),
            (17876, OpCode.ADD, 5, 0, 10),
            (17883, OpCode.ADD, 11, 2, 13),
            (17884, OpCode.MIN, 5, 2, 10),
            (17887, OpCode.ADD, 5, 0, 10),
            (17888, OpCode.SUB, 0, 0, 7),
            (17892, OpCode.MAX, 5, 0, 10),
            (17881, OpCode.PUSH2, 5, 0, 10),
            (17893, OpCode.STLOC5, 5, 0, 10),
            (17891, OpCode.LDLOC3, 7, 2, 3),
            (17879, OpCode.LDLOC4, 5, 0, 10) })
        {
            Outcome original = Run(cost, reserved, requested);
            Assert.IsFalse(original.Fault);
            Assert.AreEqual(Charge(cost, reserved, requested), original.Settled);
            Outcome mutant = Run(cost, reserved, requested, mutationPc: pc, mutation: opcode);
            Assert.IsTrue(mutant.Trace.Contains(pc), $"Mutation must execute at PC {pc}");
            Assert.IsTrue(mutant.Fault || mutant.Settled != Charge(cost, reserved, requested),
                $"Well-formed {opcode} mutation at PC {pc} escaped semantic detection");
        }
    }
}
