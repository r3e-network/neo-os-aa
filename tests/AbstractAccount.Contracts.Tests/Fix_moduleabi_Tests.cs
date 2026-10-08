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
    public void CompositeCanProvisionLeafBeforePublishingChildRoster()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 child = fx.Deploy("verifiers/SessionKeyVerifier", wallet.ToArray());
        UInt160 multiSig = fx.Deploy("verifiers/MultiSigVerifier", wallet.ToArray());

        UInt160 account = fx.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            multiSig,
            Array.Empty<byte>(),
            UInt160.Zero,
            Owner,
            EscapeTimelockSeconds);

        fx.SetSigners(Owner);
        fx.CallVoid(wallet, "registerAccount", account, multiSig, Array.Empty<byte>(),
            UInt160.Zero, Owner, EscapeTimelockSeconds);

        byte[] compressedKey = new byte[33];
        compressedKey[0] = 0x02;
        var validUntil = fx.Now() + 172_800_000;
        Assert.IsFalse(fx.CallBoolean(
            wallet, "callVerifierChild", account, child, "setSessionKey",
            new object?[] { account, compressedKey, UInt160.Parse("0x4444444444444444444444444444444444444444"),
                "transfer", validUntil, 0, "child" }));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        _ = fx.Call(wallet, "callVerifierChild", account, child, "setSessionKey",
            new object?[] { account, compressedKey, UInt160.Parse("0x4444444444444444444444444444444444444444"),
                "transfer", validUntil, 0, "child" });

        Assert.IsFalse(fx.CallBoolean(
            wallet, "callVerifier", account, "setConfig",
            new object?[] { account, new UInt160[] { child }, 1 }));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        _ = fx.Call(wallet, "callVerifier", account, "setConfig",
            new object?[] { account, new UInt160[] { child }, 1 });

        Assert.IsFalse(fx.Call(multiSig, "getConfig", account).IsNull,
            "The composite must publish a roster after child configuration succeeds");
    }

    [TestMethod]
    public void PendingLeafConfigurationIsInvalidatedWhenVerifierRootChanges()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 child = fx.Deploy("verifiers/SessionKeyVerifier", wallet.ToArray());
        UInt160 firstRoot = fx.Deploy("verifiers/MultiSigVerifier", wallet.ToArray());
        UInt160 secondRoot = fx.Deploy("MockVerifierCore");
        UInt160 account = fx.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            firstRoot,
            Array.Empty<byte>(),
            UInt160.Zero,
            Owner,
            EscapeTimelockSeconds);

        fx.SetSigners(Owner);
        fx.CallVoid(wallet, "registerAccount", account, firstRoot, Array.Empty<byte>(),
            UInt160.Zero, Owner, EscapeTimelockSeconds);

        byte[] compressedKey = new byte[33];
        compressedKey[0] = 0x02;
        var validUntil = fx.Now() + 172_800_000;
        Assert.IsFalse(fx.CallBoolean(
            wallet, "callVerifierChild", account, child, "setSessionKey",
            new object?[] { account, compressedKey, UInt160.Parse("0x4444444444444444444444444444444444444444"),
                "transfer", validUntil, 0, "orphan" }));

        fx.CallVoid(wallet, "updateVerifier", account, secondRoot, Array.Empty<byte>());
        fx.AdvanceTime(TimeSpan.FromDays(1));
        fx.CallVoid(wallet, "confirmVerifierUpdate", account);

        Assert.IsFalse(fx.CallBoolean(
            wallet, "callVerifierChild", account, child, "setSessionKey",
            new object?[] { account, compressedKey, UInt160.Parse("0x4444444444444444444444444444444444444444"),
                "transfer", validUntil, 0, "orphan" }),
            "A child call armed under the replaced root must not be confirmed under the new root");
        Assert.ThrowsExactly<TestException>(() => fx.Call(child, "getSignerDomains", account));
    }

    [TestMethod]
    public void SuccessfulLeafMutationInvalidatesFailedRootConfigurationIntent()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 session = fx.Deploy("verifiers/SessionKeyVerifier", wallet.ToArray());
        UInt160 webAuthn = fx.Deploy("verifiers/WebAuthnVerifier", wallet.ToArray());
        UInt160 multiSig = fx.Deploy("verifiers/MultiSigVerifier", wallet.ToArray());
        UInt160 target = UInt160.Parse("0x4444444444444444444444444444444444444444");
        UInt160 account = fx.CallUInt160(
            wallet, "computeRegistrationAccountId", multiSig, Array.Empty<byte>(),
            UInt160.Zero, Owner, EscapeTimelockSeconds);

        fx.SetSigners(Owner);
        fx.CallVoid(wallet, "registerAccount", account, multiSig, Array.Empty<byte>(),
            UInt160.Zero, Owner, EscapeTimelockSeconds);

        byte[] firstKey = new byte[33];
        firstKey[0] = 0x02;
        firstKey[32] = 0x11;
        var validUntil = fx.Now() + 7 * 86_400_000;
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifierChild", account, session, "setSessionKey",
            new object?[] { account, firstKey, target, "transfer", validUntil, 0, "root-replay" }));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        _ = fx.Call(wallet, "callVerifierChild", account, session, "setSessionKey",
            new object?[] { account, firstKey, target, "transfer", validUntil, 0, "root-replay" });

        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifierChild", account, webAuthn, "setPublicKey",
            new object?[] { account, firstKey }));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        _ = fx.Call(wallet, "callVerifierChild", account, webAuthn, "setPublicKey",
            new object?[] { account, firstKey });

        UInt160[] children = new[] { session, webAuthn };
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifier", account, "setConfig",
            new object?[] { account, children, 2 }));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        TestException duplicate = Assert.ThrowsExactly<TestException>(() =>
            fx.Call(wallet, "callVerifier", account, "setConfig",
                new object?[] { account, children, 2 }));
        StringAssert.Contains(duplicate.Message, "Duplicate signer domain");

        byte[] secondKey = new byte[33];
        secondKey[0] = 0x02;
        secondKey[32] = 0x22;
        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifierChild", account, webAuthn, "setPublicKey",
            new object?[] { account, secondKey }));
        fx.AdvanceTime(TimeSpan.FromDays(1));
        _ = fx.Call(wallet, "callVerifierChild", account, webAuthn, "setPublicKey",
            new object?[] { account, secondKey });

        Assert.IsFalse(fx.CallBoolean(wallet, "callVerifier", account, "setConfig",
            new object?[] { account, children, 2 }),
            "A successful child mutation must invalidate the failed root intent and require a fresh root timelock");
    }
}
