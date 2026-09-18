using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Concrete counterchecks for the abstractions in formal/coq and formal/tla.
/// These run local compiled NEFs in Neo's test VM. They are regression evidence,
/// not a proof of C#-to-NEF refinement or live deployment equivalence.
/// </summary>
[TestClass]
public class AAFormalCorrespondenceRuntimeTests
{
    private static readonly UInt160 Owner =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static (RuntimeFixture Fx, UInt160 Wallet, UInt160 Account) Register()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        fx.SetSigners(Owner);
        const uint timelock = 604_800;
        byte[] parameters = Array.Empty<byte>();
        UInt160 account = fx.CallUInt160(wallet, "computeRegistrationAccountId",
            UInt160.Zero, parameters, UInt160.Zero, Owner, timelock);
        fx.CallVoid(wallet, "registerAccount", account, UInt160.Zero, parameters,
            UInt160.Zero, Owner, timelock);
        return (fx, wallet, account);
    }

    private static object[] Op(RuntimeFixture fx, UInt160 wallet, UInt160 account,
        BigInteger nonce, string method = "isEscapeActive", object?[]? args = null) =>
        RuntimeFixture.UserOp(wallet, method, args ?? new object?[] { account },
            nonce, fx.Now(), Array.Empty<byte>());

    [TestMethod]
    [DataRow(0)]
    [DataRow(1)]
    [DataRow(7)]
    public void NormalFalseResultAtDeadline_ConsumesOnceAndRejectsReplayOrGap(int channel)
    {
        var (fx, wallet, account) = Register();
        BigInteger lane = (BigInteger)channel << 64;
        // A normal Boolean false is NOT a FAULT and MUST consume the nonce.
        for (int sequence = 0; sequence < 2; sequence++)
        {
            Assert.IsFalse(fx.CallBoolean(wallet, "executeUserOp", account,
                Op(fx, wallet, account, lane + sequence)));
            Assert.AreEqual((BigInteger)(sequence + 1), fx.CallInteger(wallet, "getNonce", account, channel));
            Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, channel + 1));
            Assert.IsFalse(fx.CallBoolean(wallet, "isExecutionActive", account));
        }
        foreach (BigInteger badNonce in new[] { lane, lane + 3, -BigInteger.One })
        {
            TestException fault = Assert.ThrowsExactly<TestException>(() =>
                fx.Call(wallet, "executeUserOp", account, Op(fx, wallet, account, badNonce)));
            StringAssert.Contains(fault.Message, "Invalid sequence for channel");
            Assert.AreEqual((BigInteger)2, fx.CallInteger(wallet, "getNonce", account, channel));
        }
    }

    [TestMethod]
    public void UnhandledTargetFault_RollsBackNonceAndEscapeCancellation()
    {
        var (fx, wallet, account) = Register();
        fx.CallVoid(wallet, "initiateEscape", account);
        Assert.IsTrue(fx.CallBoolean(wallet, "isEscapeActive", account));
        Assert.ThrowsExactly<TestException>(() => fx.Call(wallet, "executeUserOp", account,
            Op(fx, wallet, account, 0, "doesNotExist")));
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));
        Assert.IsTrue(fx.CallBoolean(wallet, "isEscapeActive", account));
        Assert.IsFalse(fx.CallBoolean(wallet, "isExecutionActive", account));
    }

    [TestMethod]
    public void BatchFault_RollsBackEarlierSuccessfulOperation()
    {
        var (fx, wallet, account) = Register();
        object[] first = Op(fx, wallet, account, 0);
        object[] replay = Op(fx, wallet, account, 0);
        Assert.ThrowsExactly<TestException>(() => fx.Call(wallet, "executeUserOps", account,
            new object?[] { first, replay }));
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));
        Assert.IsFalse(fx.CallBoolean(wallet, "isExecutionActive", account));
        Assert.IsFalse(fx.CallBoolean(wallet, "executeUserOp", account, first));
        Assert.AreEqual(BigInteger.One, fx.CallInteger(wallet, "getNonce", account, 0));
    }

    [TestMethod]
    public void SameAccountReentrancy_IsRejectedAndTopLevelFaultRollsBack()
    {
        var (fx, wallet, account) = Register();
        object[] inner = Op(fx, wallet, account, 1);
        object[] outer = Op(fx, wallet, account, 0, "executeUserOp", new object?[] { account, inner });
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "executeUserOp", account, outer));
        StringAssert.Contains(fault.Message, "Reentrant call rejected");
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));
        Assert.IsFalse(fx.CallBoolean(wallet, "isExecutionActive", account));
    }

    [TestMethod]
    public void OperationBoundary_RejectsNegativeNonceAndDeadline()
    {
        var (fx, wallet, account) = Register();

        TestException nonceFault = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "executeUserOp", account, Op(fx, wallet, account, -BigInteger.One)));
        StringAssert.Contains(nonceFault.Message, "Invalid sequence for channel");
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));

        object[] deadlineOp = Op(fx, wallet, account, 0);
        deadlineOp[4] = -BigInteger.One;
        TestException deadlineFault = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "executeUserOp", account, deadlineOp));
        StringAssert.Contains(deadlineFault.Message, "Deadline outside uint256 domain");
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));
    }

    [TestMethod]
    public void OperationBoundary_AcceptsHighestVmRepresentableChannelWithoutCrossLaneAlias()
    {
        var (fx, wallet, account) = Register();
        // Neo VM integer literals are signed 256-bit values. The AA wire-level
        // uint256 bound is checked by the core/formal gate; this runtime vector
        // exercises the highest positive integer directly representable by the VM.
        BigInteger maxChannel = (BigInteger.One << 191) - BigInteger.One;
        BigInteger laneZero = maxChannel << 64;

        Assert.IsFalse(fx.CallBoolean(wallet, "executeUserOp", account,
            Op(fx, wallet, account, laneZero)));
        Assert.AreEqual(BigInteger.One, fx.CallInteger(wallet, "getNonce", account, maxChannel));

        Assert.IsFalse(fx.CallBoolean(wallet, "executeUserOp", account,
            Op(fx, wallet, account, laneZero + 1)));
        Assert.AreEqual((BigInteger)2, fx.CallInteger(wallet, "getNonce", account, maxChannel));
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));
    }

    [TestMethod]
    public void OperationBoundary_RejectsMalformedFieldsWithoutSideEffects()
    {
        var (fx, wallet, account) = Register();
        var cases = new (int Index, object? Value, string Message)[]
        {
            (0, UInt160.Zero, "Target contract required"),
            (0, null, "Target contract required"),
            (1, "", "Invalid method"),
            (1, new string('a', 129), "Invalid method"),
            (1, new string('界', 43), "Invalid method"), // 129 UTF-8 bytes
            (1, null, "Invalid method"),
            (2, null, "Arguments exceed protocol limit"),
            (2, new object[65], "Arguments exceed protocol limit"),
            (2, new object[] { new byte[4097] }, "Serialized arguments exceed protocol limit"),
            (5, null, "Signature required"),
            (5, new byte[1025], "Signature exceeds protocol limit"),
        };
        foreach (var test in cases)
        {
            object[] op = Op(fx, wallet, account, 0);
            op[test.Index] = test.Value!;
            TestException fault = Assert.ThrowsExactly<TestException>(() =>
                fx.Call(wallet, "executeUserOp", account, op));
            StringAssert.Contains(fault.Message, test.Message);
            Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));
            Assert.IsFalse(fx.CallBoolean(wallet, "isExecutionActive", account));
        }

        object[] preview = Op(fx, wallet, account, 0);
        preview[1] = string.Empty;
        TestException previewFault = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "previewUserOpValidation", account, preview));
        StringAssert.Contains(previewFault.Message, "Invalid method");
    }

    [TestMethod]
    public void NonceQuery_RejectsInvalidAccountAndChannelDomain()
    {
        var (fx, wallet, account) = Register();
        TestException accountFault = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "getNonce", UInt160.Zero, 0));
        StringAssert.Contains(accountFault.Message, "Account id required");
        foreach (BigInteger channel in new[] { -BigInteger.One, BigInteger.One << 192 })
        {
            TestException fault = Assert.ThrowsExactly<TestException>(() =>
                fx.Call(wallet, "getNonce", account, channel));
            StringAssert.Contains(fault.Message, "Invalid channel");
        }
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));
    }

    [TestMethod]
    public void OperationBoundary_MaximumBatchSucceedsAndConsumesEachNonce()
    {
        var (fx, wallet, account) = Register();
        object[] operations = new object[32];
        for (int i = 0; i < operations.Length; i++)
            operations[i] = Op(fx, wallet, account, i);
        fx.Call(wallet, "executeUserOps", account, operations);
        Assert.AreEqual((BigInteger)32, fx.CallInteger(wallet, "getNonce", account, 0));
        Assert.IsFalse(fx.CallBoolean(wallet, "isExecutionActive", account));
    }

    [TestMethod]
    public void OperationBoundary_RejectsEmptyAndOversizedBatchesBeforeExecution()
    {
        var (fx, wallet, account) = Register();
        TestException empty = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "executeUserOps", account, Array.Empty<object>()));
        StringAssert.Contains(empty.Message, "Operations required");
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));

        object[] one = Op(fx, wallet, account, 0);
        object[] oversized = new object[33];
        for (int i = 0; i < oversized.Length; i++) oversized[i] = one;
        TestException tooLarge = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "executeUserOps", account, oversized));
        StringAssert.Contains(tooLarge.Message, "Batch exceeds protocol limit");
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, 0));
    }
}
