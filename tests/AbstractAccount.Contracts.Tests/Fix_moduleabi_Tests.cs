using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// The V3 marker is only a capability claim. Binding must also reject a deployed
/// module whose manifest omits the lifecycle methods that the core calls.
/// </summary>
[TestClass]
public class Fix_ModuleAbi_Tests
{
    private const uint EscapeTimelockSeconds = 604_800;

    private static readonly UInt160 Owner =
        UInt160.Parse("0x2323232323232323232323232323232323232323");

    [TestMethod]
    public void MarkerOnlyVerifierIsRejectedBeforeBinding()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 markerOnly = fx.Deploy("MarkerOnlyModule");

        UInt160 account = fx.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            markerOnly,
            Array.Empty<byte>(),
            UInt160.Zero,
            Owner,
            EscapeTimelockSeconds);

        fx.SetSigners(Owner);
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(
                wallet,
                "registerAccount",
                account,
                markerOnly,
                Array.Empty<byte>(),
                UInt160.Zero,
                Owner,
                EscapeTimelockSeconds));

        StringAssert.Contains(fault.Message, "Verifier V3 validation ABI missing");
    }

    [TestMethod]
    public void MarkerOnlyHookIsRejectedBeforeBinding()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 markerOnly = fx.Deploy("MarkerOnlyModule");

        UInt160 account = fx.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            UInt160.Zero,
            Array.Empty<byte>(),
            markerOnly,
            Owner,
            EscapeTimelockSeconds);

        fx.SetSigners(Owner);
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(
                wallet,
                "registerAccount",
                account,
                UInt160.Zero,
                Array.Empty<byte>(),
                markerOnly,
                Owner,
                EscapeTimelockSeconds));

        StringAssert.Contains(fault.Message, "Hook V3 pre ABI missing");
    }

    [TestMethod]
    public void WrongLifecycleReturnTypeIsRejectedBeforeBinding()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 malformed = fx.Deploy("WrongLifecycleAbiModule");

        UInt160 account = fx.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            malformed,
            Array.Empty<byte>(),
            UInt160.Zero,
            Owner,
            EscapeTimelockSeconds);

        fx.SetSigners(Owner);
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(
                wallet,
                "registerAccount",
                account,
                malformed,
                Array.Empty<byte>(),
                UInt160.Zero,
                Owner,
                EscapeTimelockSeconds));

        StringAssert.Contains(fault.Message, "Verifier V3 validation ABI missing");
    }

    [TestMethod]
    public void WrongHookLifecycleReturnTypeIsRejectedBeforeBinding()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 malformed = fx.Deploy("WrongHookLifecycleAbiModule");

        UInt160 account = fx.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            UInt160.Zero,
            Array.Empty<byte>(),
            malformed,
            Owner,
            EscapeTimelockSeconds);

        fx.SetSigners(Owner);
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(
                wallet,
                "registerAccount",
                account,
                UInt160.Zero,
                Array.Empty<byte>(),
                malformed,
                Owner,
                EscapeTimelockSeconds));

        StringAssert.Contains(fault.Message, "Hook V3 pre ABI missing");
    }

    [TestMethod]
    public void MultiHookRejectsIncompleteChildBeforeStorage()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");
        UInt160 multiHook = fx.Deploy("hooks/MultiHook", core.ToArray());
        UInt160 markerOnly = fx.Deploy("MarkerOnlyModule");

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(core, "forward", multiHook, "setHooks", new object[] { Owner, new UInt160[] { markerOnly } }));

        StringAssert.Contains(fault.ToString(), "Child hook pre ABI missing");

        UInt160 validHook = fx.Deploy("hooks/WhitelistHook", core.ToArray());
        fx.CallVoid(core, "forward", multiHook, "setHooks", new object[] { Owner, new UInt160[] { validHook } });
    }

    [TestMethod]
    public void MultiHook_ReconfigurationAndRemoval_CleansLeafChildState()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");
        UInt160 multiHook = fx.Deploy("hooks/MultiHook", core.ToArray());
        UInt160 firstHook = fx.Deploy("hooks/WhitelistHook", core.ToArray());
        UInt160 target = UInt160.Parse("0x4444444444444444444444444444444444444444");

        fx.CallVoid(core, "forward", firstHook, "setWhitelist", new object[] { Owner, target, true });
        fx.CallVoid(core, "forward", multiHook, "setHooks",
            new object[] { Owner, new UInt160[] { firstHook } });

        fx.CallVoid(core, "forward", multiHook, "setHooks",
            new object[] { Owner, Array.Empty<UInt160>() });
        Assert.IsFalse(fx.CallBoolean(firstHook, "isWhitelisted", Owner, target),
            "A removed hook child must be cleaned during reconfiguration");

    }

    [TestMethod]
    public void MultiSigRejectsUndeployedChildBeforeStorage()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");
        UInt160 multiSig = fx.Deploy("verifiers/MultiSigVerifier", core.ToArray());
        UInt160 undeployed = UInt160.Parse("0xabababababababababababababababababababab");

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(core, "forward", multiSig, "setConfig", new object[] { Owner, new UInt160[] { undeployed }, 1 }));

        StringAssert.Contains(fault.ToString(), "Child verifier is not deployed");
    }

    [TestMethod]
    public void CompositeRequiresPublishedRosterBeforeTimelockedLeafConfiguration()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 child = fx.Deploy("verifiers/NeoNativeVerifier", wallet.ToArray());
        UInt160 root = fx.Deploy("verifiers/MultiSigVerifier", wallet.ToArray());
        UInt160 account = fx.CallUInt160(wallet, "computeRegistrationAccountId", root,
            Array.Empty<byte>(), UInt160.Zero, Owner, EscapeTimelockSeconds);
        fx.SetSigners(Owner);
        fx.CallVoid(wallet, "registerAccount", account, root, Array.Empty<byte>(),
            UInt160.Zero, Owner, EscapeTimelockSeconds);

        object[] leafArgs = { account, new UInt160[] { Owner }, 1 };
        TestException unpublished = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "callVerifierChild", account, child, "setConfig", leafArgs));
        StringAssert.Contains(unpublished.Message, "Invalid child verifier configuration");
        Assert.IsFalse(fx.CallBoolean(wallet, "hasPendingVerifierCall", account));
        Assert.IsTrue(fx.Call(child, "getConfig", account).IsNull);

        object[] rootArgs = { account, new UInt160[] { child }, 1 };
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifier", account, "setConfig", rootArgs));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        fx.CallVoid(wallet, "callVerifier", account, "setConfig", rootArgs);
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifierChild", account, child, "setConfig", leafArgs));
        TestException early = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "callVerifierChild", account, child, "setConfig", leafArgs));
        StringAssert.Contains(early.Message, "Timelock not elapsed");
        Assert.IsTrue(fx.Call(child, "getConfig", account).IsNull);
        fx.AdvanceTime(TimeSpan.FromDays(1));
        fx.CallVoid(wallet, "callVerifierChild", account, child, "setConfig", leafArgs);
        Assert.AreEqual(System.Numerics.BigInteger.One, fx.CallInteger(child, "getThreshold", account));
    }

    [TestMethod]
    public void PendingLeafConfigurationIsInvalidatedWhenVerifierRootChanges()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 child = fx.Deploy("verifiers/NeoNativeVerifier", wallet.ToArray());
        UInt160 firstRoot = fx.Deploy("verifiers/MultiSigVerifier", wallet.ToArray());
        UInt160 secondRoot = fx.Deploy("MockVerifierCore");
        UInt160 account = fx.CallUInt160(wallet, "computeRegistrationAccountId", firstRoot,
            Array.Empty<byte>(), UInt160.Zero, Owner, EscapeTimelockSeconds);
        fx.SetSigners(Owner);
        fx.CallVoid(wallet, "registerAccount", account, firstRoot, Array.Empty<byte>(),
            UInt160.Zero, Owner, EscapeTimelockSeconds);

        object[] rootArgs = { account, new UInt160[] { child }, 1 };
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifier", account, "setConfig", rootArgs));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        fx.CallVoid(wallet, "callVerifier", account, "setConfig", rootArgs);
        object[] leafArgs = { account, new UInt160[] { Owner }, 1 };
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifierChild", account, child, "setConfig", leafArgs));
        Assert.IsTrue(fx.CallBoolean(wallet, "hasPendingVerifierCall", account));

        fx.CallVoid(wallet, "updateVerifier", account, secondRoot, Array.Empty<byte>());
        fx.AdvanceTime(TimeSpan.FromDays(1));
        fx.CallVoid(wallet, "confirmVerifierUpdate", account);
        TestException replaced = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "callVerifierChild", account, child, "setConfig", leafArgs));
        StringAssert.Contains(replaced.Message, "Verifier child configuration ABI missing");
        Assert.IsTrue(fx.Call(child, "getConfig", account).IsNull,
            "A child proposal under a replaced root must never initialize the child.");
    }

    [TestMethod]
    public void SuccessfulLeafMutationInvalidatesFailedRootConfigurationIntent()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 child = fx.Deploy("verifiers/NeoNativeVerifier", wallet.ToArray());
        UInt160 root = fx.Deploy("verifiers/MultiSigVerifier", wallet.ToArray());
        UInt160 account = fx.CallUInt160(wallet, "computeRegistrationAccountId", root,
            Array.Empty<byte>(), UInt160.Zero, Owner, EscapeTimelockSeconds);
        fx.SetSigners(Owner);
        fx.CallVoid(wallet, "registerAccount", account, root, Array.Empty<byte>(),
            UInt160.Zero, Owner, EscapeTimelockSeconds);

        object[] rootArgs = { account, new UInt160[] { child }, 1 };
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifier", account, "setConfig", rootArgs));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        fx.CallVoid(wallet, "callVerifier", account, "setConfig", rootArgs);

        // Public V3 rejects duplicate child identities; signer-domain uniqueness belongs
        // to the native profile and is covered by that profile's state-machine suite.
        object[] invalidRootArgs = { account, new UInt160[] { child, child }, 2 };
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifier", account, "setConfig", invalidRootArgs));
        var failedRootProposedAt = fx.CallInteger(wallet, "getPendingVerifierCallTime", account);
        fx.AdvanceTime(TimeSpan.FromDays(1));
        TestException duplicate = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "callVerifier", account, "setConfig", invalidRootArgs));
        StringAssert.Contains(duplicate.Message, "Duplicate verifier");

        object[] leafArgs = { account, new UInt160[] { Owner }, 1 };
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifierChild", account, child, "setConfig", leafArgs));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        fx.CallVoid(wallet, "callVerifierChild", account, child, "setConfig", leafArgs);
        Assert.AreEqual(System.Numerics.BigInteger.One, fx.CallInteger(child, "getThreshold", account));
        Assert.IsFalse(fx.CallBoolean(wallet, "hasPendingVerifierCall", account));

        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifier", account, "setConfig", invalidRootArgs),
            "A successful child mutation must require a fresh root proposal and timelock.");
        Assert.IsTrue(fx.CallInteger(wallet, "getPendingVerifierCallTime", account) > failedRootProposedAt);
        TestException early = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "callVerifier", account, "setConfig", invalidRootArgs));
        StringAssert.Contains(early.Message, "Timelock not elapsed");
        fx.AdvanceTime(TimeSpan.FromDays(1));
        TestException stillInvalid = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "callVerifier", account, "setConfig", invalidRootArgs));
        StringAssert.Contains(stillInvalid.Message, "Duplicate verifier");
    }
}
