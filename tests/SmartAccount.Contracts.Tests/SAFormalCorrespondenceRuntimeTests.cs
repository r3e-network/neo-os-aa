using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Concrete counterchecks for the abstractions in formal/coq and formal/tla.
/// These run local compiled NEFs in Neo's test VM. They are regression evidence,
/// not a proof of C#-to-NEF refinement or live deployment equivalence.
/// </summary>
/// <remarks>
/// Protocol v4 moved the boundary the formal models describe: the envelope is the 13-field
/// canonical operation (spec §4.1), the nonce channel is derived from
/// (authorityEpoch, validatorId, credentialGeneration, nonceSubkey) instead of being chosen by
/// the caller (spec §6), and the executor is signature-bound. The assertions below keep the
/// original formal intent — accept-once, roll back on fault, bounded envelopes, no cross-lane
/// aliasing — and pin the v4 shape of each rule.
/// </remarks>
[TestClass]
public class SAFormalCorrespondenceRuntimeTests
{
    /// <summary>Distinct 32-byte nonce subkeys: one derived channel each (spec §6).</summary>
    private static byte[] Lane(byte index)
    {
        byte[] subkey = new byte[32];
        subkey[31] = index;
        return subkey;
    }

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Account { get; }

        public UInt160 Target { get; }

        public P256SessionKey Key { get; } = new();

        public UInt160 Custody { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            Custody = RuntimeFixture.CustodyOf(Key);
            Account = Fx.CreateAccount(Wallet, Custody, "formal");
        }

        public BigInteger PackedNonce(byte[] subkey) => Fx.PackedNonce(Wallet, Account, 0, subkey);

        public BigInteger Sequence(byte[] subkey) => Fx.CurrentNonceSequence(Wallet, Account, 0, subkey);

        /// <summary>
        /// A signed built-in operation at an explicit nonce. The signature covers whatever
        /// nonce is supplied, so a wrongly-addressed nonce is still a correctly signed
        /// operation — exactly the case the nonce rule must reject on its own.
        /// </summary>
        public object[] OpAt(BigInteger nonce, byte[] subkey, UInt160? target = null,
            string method = "balanceOf", object?[]? args = null)
        {
            object[] op = RuntimeFixture.UserOp(target ?? Target, method,
                args ?? new object?[] { Account }, nonce, Fx.Now() + 3_600_000,
                new byte[] { 0x00 }, nonceSubkey: subkey);
            op[11] = Fx.SignBuiltIn(Wallet, Account, op, Key);
            return op;
        }

        /// <summary>A signed operation at (derived channel ‖ <paramref name="sequence"/>).</summary>
        public object[] Op(BigInteger sequence, byte[] subkey, UInt160? target = null,
            string method = "balanceOf", object?[]? args = null)
        {
            BigInteger mask = (BigInteger.One << 64) - 1;
            return OpAt((PackedNonce(subkey) & ~mask) | sequence, subkey, target, method, args);
        }

        public bool ExecutionActive() => Fx.CallBoolean(Wallet, "isExecutionActive", Account);

        public int RecoveryStatusLength() =>
            ((Neo.VM.Types.Array)Fx.Call(Wallet, "getRecoveryStatus", Account)).Count;

        public void SignAsCustody() => Fx.SetSigners(Custody);
    }

    [TestMethod]
    [DataRow(0)]
    [DataRow(1)]
    [DataRow(7)]
    public void NormalZeroResultAtDeadline_ConsumesOnceAndRejectsReplayOrGap(int lane)
    {
        Harness h = new();
        byte[] subkey = Lane((byte)lane);
        byte[] otherLane = Lane((byte)(lane + 32));
        // getNonce returns the packed (channel ‖ cursor) value, so the lane's own base —
        // channel ‖ sequence 0 — must be captured before anything is consumed.
        BigInteger laneBase = h.PackedNonce(subkey);

        // A normal zero result is NOT a fault and MUST consume the nonce.
        for (int sequence = 0; sequence < 2; sequence++)
        {
            Assert.AreEqual(BigInteger.Zero,
                h.Fx.CallInteger(h.Wallet, "executeUserOp", h.Account, h.Op(sequence, subkey)));
            Assert.AreEqual((BigInteger)(sequence + 1), h.Sequence(subkey));
            Assert.AreEqual(BigInteger.Zero, h.Sequence(otherLane),
                "Consuming one derived channel must never advance another lane");
            Assert.IsFalse(h.ExecutionActive());
        }

        BigInteger cursor = h.Sequence(subkey);
        foreach (BigInteger badNonce in new[]
        {
            laneBase,                                                // replay
            laneBase + cursor + 1,                                   // gap
            h.PackedNonce(otherLane),                                // foreign channel
            -BigInteger.One                                          // out of domain
        })
        {
            TestException fault = Assert.ThrowsExactly<TestException>(() =>
                h.Fx.Call(h.Wallet, "executeUserOp", h.Account, h.OpAt(badNonce, subkey)));
            StringAssert.Contains(fault.Message, "SA_NONCE_INVALID");
            Assert.AreEqual(cursor, h.Sequence(subkey),
                "A rejected nonce must not consume the cursor");
        }
    }

    [TestMethod]
    public void UnhandledTargetFault_RollsBackNonceAndPendingRecovery()
    {
        Harness h = new();
        h.SignAsCustody();
        h.Fx.CallVoid(h.Wallet, "beginRecovery", h.Account, UInt160.Zero);
        Assert.AreEqual(5, h.RecoveryStatusLength(), "The recovery record must be armed");

        Assert.ThrowsExactly<TestException>(() => h.Fx.Call(h.Wallet, "executeUserOp", h.Account,
            h.Op(0, Lane(0), h.Wallet, "doesNotExist")));

        Assert.AreEqual(BigInteger.Zero, h.Sequence(Lane(0)));
        Assert.AreEqual(5, h.RecoveryStatusLength(),
            "A faulting operation must not disturb the armed recovery record");
        Assert.IsFalse(h.ExecutionActive());
    }

    [TestMethod]
    public void BatchFault_RollsBackEarlierSuccessfulOperation()
    {
        Harness h = new();
        object[] first = h.Op(0, Lane(0));
        object[] replay = h.Op(0, Lane(0));

        Assert.ThrowsExactly<TestException>(() => h.Fx.Call(h.Wallet, "executeUserOps", h.Account,
            new object?[] { first, replay }));
        Assert.AreEqual(BigInteger.Zero, h.Sequence(Lane(0)),
            "One envelope is atomic: the first operation must roll back with the second");
        Assert.IsFalse(h.ExecutionActive());

        h.Fx.Call(h.Wallet, "executeUserOp", h.Account, first);
        Assert.AreEqual(BigInteger.One, h.Sequence(Lane(0)));
    }

    [TestMethod]
    public void SameAccountReentrancy_IsRejectedAndTopLevelFaultRollsBack()
    {
        Harness h = new();
        object[] inner = h.Op(1, Lane(0));
        object[] outer = h.Op(0, Lane(0), h.Wallet, "executeUserOp",
            new object?[] { h.Account, inner });

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Wallet, "executeUserOp", h.Account, outer));
        StringAssert.Contains(fault.Message, "SA_REENTRANCY_FORBIDDEN");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(Lane(0)));
        Assert.IsFalse(h.ExecutionActive());
    }

    [TestMethod]
    public void OperationBoundary_RejectsNegativeNonceAndDeadline()
    {
        Harness h = new();

        TestException nonceFault = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Wallet, "executeUserOp", h.Account, h.OpAt(-BigInteger.One, Lane(0))));
        StringAssert.Contains(nonceFault.Message, "SA_NONCE_INVALID");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(Lane(0)));

        object[] deadlineOp = h.Op(0, Lane(0));
        deadlineOp[6] = -BigInteger.One;
        TestException deadlineFault = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Wallet, "executeUserOp", h.Account, deadlineOp));
        StringAssert.Contains(deadlineFault.Message, "SA_DEADLINE_EXPIRED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(Lane(0)));
    }

    [TestMethod]
    public void OperationBoundary_NonceMustMatchTheDerivedChannel()
    {
        Harness h = new();
        byte[] laneZero = Lane(0);
        byte[] laneOne = Lane(1);

        // The caller can no longer choose a channel: the nonce's high bits must equal the
        // channel derived from (authorityEpoch, validatorId, generation, nonceSubkey).
        TestException aliased = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Wallet, "executeUserOp", h.Account,
                h.OpAt(h.PackedNonce(laneOne), laneZero)));
        StringAssert.Contains(aliased.Message, "SA_NONCE_INVALID");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(laneZero));

        Assert.AreEqual(BigInteger.Zero,
            h.Fx.CallInteger(h.Wallet, "executeUserOp", h.Account, h.Op(0, laneZero)),
            "The correctly addressed operation executes normally");
        Assert.AreEqual(BigInteger.One, h.Sequence(laneZero));
        Assert.AreEqual(BigInteger.Zero, h.Sequence(laneOne));
    }

    [TestMethod]
    public void OperationBoundary_RejectsMalformedFieldsWithoutSideEffects()
    {
        Harness h = new();
        // v4 envelope: [0]=version [1]=target [2]=method [3]=args [4]=nonce [5]=nonceSubkey
        // [6]=deadline [7]=validatorId [8]=credentialGeneration [9]=authorityEpoch
        // [10]=configurationNonce [11]=signature [12]=hookProofs.
        var cases = new (int Index, object? Value, string? Message)[]
        {
            (1, UInt160.Zero, "SA_OPERATION_MALFORMED"),
            (1, null, null),
            (2, "", "SA_OPERATION_MALFORMED"),
            (2, new string('a', 129), "SA_OPERATION_MALFORMED"),
            (2, new string('界', 43), "SA_OPERATION_MALFORMED"), // 129 UTF-8 bytes
            (3, null, null),
            (3, new object[65], "SA_OPERATION_MALFORMED"),
            (3, new object[] { new byte[4097] }, "SA_OPERATION_MALFORMED"),
            (5, null, null),
            (5, new byte[31], "SA_OPERATION_MALFORMED"),
            (11, null, null),
            (11, new byte[8193], "SA_OPERATION_MALFORMED"),
            (0, (BigInteger)3, "SA_PROTOCOL_VERSION"),
            (7, -BigInteger.One, "SA_OPERATION_MALFORMED"),
            (8, BigInteger.Zero, "SA_OPERATION_MALFORMED"),
        };
        foreach (var test in cases)
        {
            object[] op = h.Op(0, Lane(0));
            op[test.Index] = test.Value!;
            TestException fault = Assert.ThrowsExactly<TestException>(() =>
                h.Fx.Call(h.Wallet, "executeUserOp", h.Account, op));
            // A VM Null cannot be widened into Hash160/ByteString/Array, so those rows fault
            // while unwrapping instead of on an explicit protocol assert; either way the wire
            // boundary rejects them before any state is touched.
            if (test.Message != null) StringAssert.Contains(fault.Message, test.Message);
            Assert.AreEqual(BigInteger.Zero, h.Sequence(Lane(0)));
            Assert.IsFalse(h.ExecutionActive());
        }

        object[] preview = h.Op(0, Lane(0));
        preview[2] = string.Empty;
        TestException previewFault = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Wallet, "getOperationDigest", h.Account, preview));
        StringAssert.Contains(previewFault.Message, "SA_OPERATION_MALFORMED");
    }

    [TestMethod]
    public void OperationBoundary_RejectsNestedArgumentsBeyondProtocolDepth()
    {
        Harness h = new();

        object nested = "leaf";
        for (int i = 0; i < 8; i++)
            nested = new object[] { nested };

        // The top-level Args vector is excluded from the depth count, so eight nested
        // arrays remain valid at the protocol boundary.
        h.Fx.Call(h.Wallet, "getOperationDigest", h.Account,
            h.Op(0, Lane(0), args: new object?[] { nested }));

        nested = new object[] { nested };
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Wallet, "getOperationDigest", h.Account,
                h.Op(0, Lane(0), args: new object?[] { nested })));
        StringAssert.Contains(fault.Message, "SA_OPERATION_MALFORMED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(Lane(0)));
    }

    [TestMethod]
    public void NonceQuery_RejectsInvalidAccountAndValidatorDomain()
    {
        Harness h = new();
        byte[] subkey = Lane(0);

        TestException accountFault = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Wallet, "getNonce", UInt160.Zero, BigInteger.Zero, subkey));
        StringAssert.Contains(accountFault.Message, "Account id required");

        // There is no caller-chosen channel in v4: the query names a routing subject and a
        // nonce subkey, and both must be in domain.
        foreach (BigInteger validatorId in new[] { -BigInteger.One, (BigInteger)99 })
        {
            TestException subjectFault = Assert.ThrowsExactly<TestException>(() =>
                h.Fx.Call(h.Wallet, "getNonce", h.Account, validatorId, subkey));
            StringAssert.Contains(subjectFault.Message, "SA_VALIDATOR_NOT_FOUND");
        }

        foreach (byte[]? badSubkey in new byte[]?[] { null, new byte[31], new byte[33] })
        {
            TestException subkeyFault = Assert.ThrowsExactly<TestException>(() =>
                h.Fx.Call(h.Wallet, "getNonce", h.Account, BigInteger.Zero, badSubkey!));
            StringAssert.Contains(subkeyFault.Message, "SA_OPERATION_MALFORMED");
        }

        Assert.AreEqual(BigInteger.Zero, h.Sequence(subkey));
    }

    [TestMethod]
    public void OperationBoundary_MaximumBatchSucceedsAndConsumesEachNonce()
    {
        Harness h = new();
        byte[] subkey = Lane(0);
        object[] operations = new object[32];
        for (int i = 0; i < operations.Length; i++)
            operations[i] = h.Op(i, subkey);
        h.Fx.Call(h.Wallet, "executeUserOps", h.Account, operations);
        Assert.AreEqual((BigInteger)32, h.Sequence(subkey));
        Assert.IsFalse(h.ExecutionActive());
    }

    [TestMethod]
    public void OperationBoundary_RejectsEmptyAndOversizedBatchesBeforeExecution()
    {
        Harness h = new();
        byte[] subkey = Lane(0);

        TestException empty = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Wallet, "executeUserOps", h.Account, Array.Empty<object>()));
        StringAssert.Contains(empty.Message, "SA_OPERATION_MALFORMED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(subkey));

        object[] one = h.Op(0, subkey);
        object[] oversized = new object[33];
        for (int i = 0; i < oversized.Length; i++) oversized[i] = one;
        TestException tooLarge = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Wallet, "executeUserOps", h.Account, oversized));
        StringAssert.Contains(tooLarge.Message, "SA_MODULE_LIMIT_BATCH");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(subkey));
    }
}
