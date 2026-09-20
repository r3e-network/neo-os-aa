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
}
