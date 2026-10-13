using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>Real-core initialization of children that only trust exact core configuration context.</summary>
[TestClass]
public class MultiSigChildConfigurationRuntimeTests
{
    private static readonly UInt160 NativeSigner = UInt160.Parse("0x8181818181818181818181818181818181818181");
    private static readonly UInt160 Stranger = UInt160.Parse("0x8282828282828282828282828282828282828282");
    private static readonly TimeSpan Window = TimeSpan.FromHours(24);

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Root { get; }
        public UInt160 Web { get; }
        public UInt160 Native { get; }
        public UInt160 Target { get; }
        public UInt160 Account { get; }
        public UInt160 Owner => Fx.Engine.ValidatorsAddress;

        public Harness(bool foreignChildCore = false)
        {
            Core = Fx.Deploy("UnifiedSmartWalletV3");
            Target = Fx.Deploy("MockTransferTarget");
            Root = Fx.Deploy("verifiers/MultiSigVerifier", Core.ToArray());
            Web = Fx.Deploy("verifiers/Web3AuthVerifier", Core.ToArray());
            Native = Fx.Deploy("verifiers/NeoNativeVerifier", (foreignChildCore ? Target : Core).ToArray());
            Account = Fx.CallUInt160(Core, "computeRegistrationAccountId", Root, Array.Empty<byte>(), UInt160.Zero, Owner, 604800u);
            Fx.CallVoid(Core, "registerAccount", Account, Root, Array.Empty<byte>(), UInt160.Zero, Owner, 604800u);
            SetTopology(new[] { Web, Native }, 1);
        }

        public void SetTopology(UInt160[] children, int threshold)
        {
            object[] args = { Account, children, threshold };
            Assert.IsFalse(Fx.CallBoolean(Core, "callVerifier", Account, "setConfig", args));
            Fx.AdvanceTime(Window);
            Fx.CallVoid(Core, "callVerifier", Account, "setConfig", args);
        }

        public object[] KeyArgs(byte tag = 1)
        {
            byte[] key = new byte[65];
            key[0] = 4;
            for (int i = 1; i < key.Length; i++) key[i] = (byte)(tag + i);
            return new object[] { Account, key };
        }

        public object[] NativeArgs() => new object[] { Account, new[] { NativeSigner }, 1 };

        public bool Stage(UInt160 child, string method, object[] args) =>
            Fx.CallBoolean(Core, "callVerifierChild", Account, child, method, args);

        public void Apply(UInt160 child, string method, object[] args) =>
            Fx.CallVoid(Core, "callVerifierChild", Account, child, method, args);

        public StorageKey AccountStorageKey(UInt160 contract, byte prefix)
        {
            var state = (Neo.VM.Types.Array)Fx.Call(
                UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"), "getContract", contract);
            return new StorageKey { Id = (int)state[0].GetInteger(), Key = new[] { prefix }.Concat(Account.ToArray()).ToArray() };
        }

        public void AssertNoConfigContext() =>
            Assert.IsNull(Fx.Engine.Storage.Snapshot.TryGet(AccountStorageKey(Core, 0x04)), "No exact child authority may outlive the call.");
    }

    [TestMethod]
    public void ChildConfiguration_InitializesWebAndNativeWithRealCoreThenExecutes()
    {
        Harness h = new();
        object[] keyArgs = h.KeyArgs();
        Assert.IsFalse(h.Stage(h.Web, "setPublicKey", keyArgs));
        Assert.AreEqual(h.Root, h.Fx.CallUInt160(h.Core, "getPendingVerifierCallModule", h.Account));
        h.Fx.AdvanceTime(Window);
        h.Apply(h.Web, "setPublicKey", keyArgs);
        h.AssertNoConfigContext();
        CollectionAssert.AreEqual((byte[])keyArgs[1], h.Fx.CallBytes(h.Web, "getPublicKey", h.Account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "hasPendingVerifierCall", h.Account));

        Assert.IsFalse(h.Stage(h.Native, "setConfig", h.NativeArgs()));
        h.Fx.AdvanceTime(Window);
        h.Apply(h.Native, "setConfig", h.NativeArgs());
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Native, "getThreshold", h.Account));

        // Native child approves; the configured Web3Auth child explicitly abstains.
        // This execution uses the real root and child callback authorization, not a mock forwarder.
        byte[] bundle = h.Fx.StdLibSerialize(new object?[] { null, Array.Empty<byte>() });
        UInt160 proxy = h.Fx.CallUInt160(h.Core, "getProxyScriptHash", h.Account);
        object[] op = RuntimeFixture.UserOp(h.Target, "transfer", new object?[] { proxy, Stranger, 1, null }, 0, h.Fx.Now() + 600000, bundle);
        h.Fx.SetSigners(NativeSigner);
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "executeUserOp", h.Account, op));
        Console.WriteLine("Two-child MultiSig/native-approval executeUserOp fee (datoshi): "
            + (long)h.Fx.Engine.FeeConsumed);
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Core, "getNonce", h.Account, 0));
    }

    [TestMethod]
    public void ChildConfiguration_RejectsDirectChildAndEarlyConfirmation()
    {
        Harness h = new();
        object[] args = h.KeyArgs();
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Web, "setPublicKey", args));
        Assert.IsFalse(h.Stage(h.Web, "setPublicKey", args));
        TestException early = Assert.ThrowsExactly<TestException>(() => h.Apply(h.Web, "setPublicKey", args));
        StringAssert.Contains(early.Message, "Timelock not elapsed");
        CollectionAssert.AreEqual(Array.Empty<byte>(), h.Fx.CallBytes(h.Web, "getPublicKey", h.Account));
        h.Fx.AdvanceTime(Window);
        h.Apply(h.Web, "setPublicKey", args);
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Web, "setPublicKey", args));
    }

    [TestMethod]
    public void ChildConfiguration_RejectsMissingOwnerWitness()
    {
        Harness h = new();
        h.Fx.SetSigners(Stranger);
        TestException denied = Assert.ThrowsExactly<TestException>(() => h.Stage(h.Web, "setPublicKey", h.KeyArgs()));
        StringAssert.Contains(denied.Message, "Unauthorized");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "hasPendingVerifierCall", h.Account));
    }

    [TestMethod]
    public void ChildConfiguration_RejectsWrongAccountOrArbitraryMethod()
    {
        Harness h = new();
        object[] wrongAccount = h.KeyArgs();
        wrongAccount[0] = Stranger;
        TestException wrong = Assert.ThrowsExactly<TestException>(() => h.Stage(h.Web, "setPublicKey", wrongAccount));
        StringAssert.Contains(wrong.Message, "Child configuration account mismatch");
        TestException method = Assert.ThrowsExactly<TestException>(() => h.Stage(h.Web, "update", h.KeyArgs()));
        StringAssert.Contains(method.Message, "Child configuration method not allowed");
        Assert.ThrowsExactly<TestException>(() => h.Stage(h.Web, "setConfig", h.KeyArgs()));
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "hasPendingVerifierCall", h.Account));
    }

    [TestMethod]
    public void ChildConfiguration_RejectsUnlistedChildAndForeignCoreBinding()
    {
        Harness h = new();
        UInt160 outsider = h.Fx.Deploy("verifiers/TEEVerifier", h.Core.ToArray());
        TestException unlisted = Assert.ThrowsExactly<TestException>(() => h.Stage(outsider, "setPublicKey", h.KeyArgs()));
        StringAssert.Contains(unlisted.Message, "Child verifier not installed");

        Harness foreign = new(foreignChildCore: true);
        TestException binding = Assert.ThrowsExactly<TestException>(() => foreign.Stage(foreign.Native, "setConfig", foreign.NativeArgs()));
        StringAssert.Contains(binding.Message, "Verifier bound to another core");
    }

    [TestMethod]
    public void ChildConfiguration_RejectsMarketEscrow()
    {
        Harness h = new();
        UInt160 market = h.Fx.Deploy("AAAddressMarket");
        h.Fx.CallVoid(market, "setAllowedAA", h.Core, true);
        h.Fx.CallVoid(market, "createListing", h.Core, h.Account, 100000000, "child configuration test", "");

        TestException escrow = Assert.ThrowsExactly<TestException>(() => h.Stage(h.Web, "setPublicKey", h.KeyArgs()));
        StringAssert.Contains(escrow.Message, "Account locked in market escrow");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "hasPendingVerifierCall", h.Account));
    }

    [TestMethod]
    public void ChildConfiguration_RejectsEntryDuringUserOperation()
    {
        Harness h = new();
        Assert.IsFalse(h.Stage(h.Native, "setConfig", h.NativeArgs()));
        h.Fx.AdvanceTime(Window);
        h.Apply(h.Native, "setConfig", h.NativeArgs());
        byte[] bundle = h.Fx.StdLibSerialize(new object?[] { null, Array.Empty<byte>() });
        object[] op = RuntimeFixture.UserOp(h.Core, "callVerifierChild",
            new object?[] { h.Account, h.Web, "setPublicKey", h.KeyArgs() }, 0, h.Fx.Now() + 600000, bundle);
        h.Fx.SetSigners(h.Owner, NativeSigner);

        TestException active = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "executeUserOp", h.Account, op));
        StringAssert.Contains(active.Message, "Cannot configure child during execution");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "hasPendingVerifierCall", h.Account));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Core, "getNonce", h.Account, 0));
    }

    [TestMethod]
    public void ChildConfiguration_ChildFaultRollsBackAndRetainsProposalWithoutLeakingContext()
    {
        Harness h = new();
        object[] invalid = { h.Account, new[] { NativeSigner }, 0 };
        Assert.IsFalse(h.Stage(h.Native, "setConfig", invalid));
        byte[] proposalHash = h.Fx.CallBytes(h.Core, "getPendingVerifierCallHash", h.Account);
        h.Fx.AdvanceTime(Window);
        TestException fault = Assert.ThrowsExactly<TestException>(() => h.Apply(h.Native, "setConfig", invalid));
        StringAssert.Contains(fault.Message, "Invalid threshold");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Native, "getThreshold", h.Account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "hasPendingVerifierCall", h.Account));
        CollectionAssert.AreEqual(proposalHash, h.Fx.CallBytes(h.Core, "getPendingVerifierCallHash", h.Account));
        h.AssertNoConfigContext();
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Native, "setConfig", h.NativeArgs()));

        Assert.IsFalse(h.Stage(h.Native, "setConfig", h.NativeArgs()));
        Assert.ThrowsExactly<TestException>(() => h.Apply(h.Native, "setConfig", h.NativeArgs()));
        h.Fx.AdvanceTime(Window);
        h.Apply(h.Native, "setConfig", h.NativeArgs());
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Native, "getThreshold", h.Account));
        h.AssertNoConfigContext();
    }

    [TestMethod]
    public void ChildConfiguration_ExternalTopologyDriftCannotReuseMaturedProposal()
    {
        Harness h = new();
        Assert.IsFalse(h.Stage(h.Web, "setPublicKey", h.KeyArgs()));
        byte[] before = h.Fx.CallBytes(h.Core, "getPendingVerifierCallHash", h.Account);
        h.Fx.AdvanceTime(Window);

        // Test-only storage mutation models a root upgrade changing its config without
        // touching the core pending slot. Ordinary root setConfig shares that slot and
        // already invalidates the proposal, so it cannot isolate this commitment check.
        byte[] config = h.Fx.StdLibSerialize(new object[] { new[] { h.Native, h.Web }, 2 });
        h.Fx.Engine.Storage.Snapshot.GetAndChange(h.AccountStorageKey(h.Root, 0x01))!.Value = config;

        Assert.IsFalse(h.Stage(h.Web, "setPublicKey", h.KeyArgs()));
        CollectionAssert.AreNotEqual(before, h.Fx.CallBytes(h.Core, "getPendingVerifierCallHash", h.Account));
        Assert.ThrowsExactly<TestException>(() => h.Apply(h.Web, "setPublicKey", h.KeyArgs()));
        CollectionAssert.AreEqual(Array.Empty<byte>(), h.Fx.CallBytes(h.Web, "getPublicKey", h.Account));
    }

    [TestMethod]
    public void ChildConfiguration_ChangedArgumentsRestartTheTimelock()
    {
        Harness h = new();
        Assert.IsFalse(h.Stage(h.Web, "setPublicKey", h.KeyArgs(1)));
        h.Fx.AdvanceTime(Window);
        Assert.IsFalse(h.Stage(h.Web, "setPublicKey", h.KeyArgs(2)));
        Assert.ThrowsExactly<TestException>(() => h.Apply(h.Web, "setPublicKey", h.KeyArgs(2)));
        CollectionAssert.AreEqual(Array.Empty<byte>(), h.Fx.CallBytes(h.Web, "getPublicKey", h.Account));
        h.Fx.AdvanceTime(Window);
        h.Apply(h.Web, "setPublicKey", h.KeyArgs(2));
        CollectionAssert.AreEqual((byte[])h.KeyArgs(2)[1], h.Fx.CallBytes(h.Web, "getPublicKey", h.Account));
    }

    [TestMethod]
    public void ChildConfiguration_ChangedChildCannotUseAnEarlierApproval()
    {
        Harness h = new();
        Assert.IsFalse(h.Stage(h.Web, "setPublicKey", h.KeyArgs()));
        h.Fx.AdvanceTime(Window);
        Assert.IsFalse(h.Stage(h.Native, "setConfig", h.NativeArgs()));
        Assert.ThrowsExactly<TestException>(() => h.Apply(h.Native, "setConfig", h.NativeArgs()));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Native, "getThreshold", h.Account));
    }

    [TestMethod]
    [DataRow(true)]
    [DataRow(false)]
    public void ChildConfiguration_CommitmentIncludesOrderAndThreshold(bool reverseOrder)
    {
        Harness h = new();
        Assert.IsFalse(h.Stage(h.Web, "setPublicKey", h.KeyArgs()));
        byte[] before = h.Fx.CallBytes(h.Core, "getPendingVerifierCallHash", h.Account);
        h.SetTopology(reverseOrder ? new[] { h.Native, h.Web } : new[] { h.Web, h.Native }, reverseOrder ? 1 : 2);

        Assert.IsFalse(h.Stage(h.Web, "setPublicKey", h.KeyArgs()));
        byte[] after = h.Fx.CallBytes(h.Core, "getPendingVerifierCallHash", h.Account);
        CollectionAssert.AreNotEqual(before, after, "The same child call must commit to the current full topology.");
        Assert.ThrowsExactly<TestException>(() => h.Apply(h.Web, "setPublicKey", h.KeyArgs()));
        h.Fx.AdvanceTime(Window);
        h.Apply(h.Web, "setPublicKey", h.KeyArgs());
    }

    [TestMethod]
    public void ChildConfiguration_RootWithoutDelegationAbiIsRejected()
    {
        Harness h = new();
        h.Fx.CallVoid(h.Core, "updateVerifier", h.Account, h.Native, Array.Empty<byte>());
        h.Fx.AdvanceTime(Window);
        h.Fx.CallVoid(h.Core, "confirmVerifierUpdate", h.Account);
        TestException unsupported = Assert.ThrowsExactly<TestException>(() => h.Stage(h.Web, "setPublicKey", h.KeyArgs()));
        StringAssert.Contains(unsupported.Message, "Verifier child configuration ABI missing");
    }
}
