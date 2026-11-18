using System;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;
using VmArray = Neo.VM.Types.Array;

namespace SmartAccount.Contracts.Tests;

[TestClass]
public class PlatformRegistrarRuntimeTests
{
    private static readonly UInt160 AppAdmin =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");
    private static readonly UInt160 Stranger =
        UInt160.Parse("0x8f92a4d8a476a41c2b563c1f07e8f203e2c12345");
    private static readonly UInt160 RotatedOwner =
        UInt160.Parse("0x2233445566778899001122334455667788990011");
    private static readonly byte[] PlatformRegistryBindingPrefix =
        Convert.FromHexString("2bcb98c08b7690d787157dffe3bd1faaef36c05e");

    private const uint EscapeTimelock = 2_592_000;

    [TestMethod]
    public void TimelockedRegistrarCreatesOwnerControlledPlatformAccount()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccount");
        // Phase 1b: the real registrar service is deployed with the core hash as deploy
        // data (its authorized core), replacing the former PlatformRegistrarMock.
        UInt160 registrar = fixture.Deploy("SAPlatformRegistrar", wallet.ToArray());
        UInt160 verifier = fixture.Deploy("verifiers/NeoNativeVerifier");
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:miniapp-jump-rush");

        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        Assert.AreEqual(registrar, fixture.CallUInt160(wallet, "getPendingPlatformRegistrar"));
        Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(wallet, "confirmPlatformRegistrar"));

        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");
        Assert.AreEqual(registrar, fixture.CallUInt160(wallet, "getPlatformRegistrar"));

        UInt160 expected = fixture.CallUInt160(
            wallet,
            "computePlatformAccountId",
            appBinding,
            AppAdmin,
            EscapeTimelock);
        UInt160 accountId = fixture.CallUInt160(
            registrar,
            "registerPlatformAccount",
            appBinding,
            AppAdmin,
            EscapeTimelock);

        Assert.AreEqual(expected, accountId);
        Assert.AreEqual(AppAdmin, fixture.CallUInt160(wallet, "getBackupOwner", accountId));
        Assert.AreEqual(UInt160.Zero, fixture.CallUInt160(wallet, "getVerifier", accountId));
        Assert.AreEqual(UInt160.Zero, fixture.CallUInt160(wallet, "getHook", accountId));

        Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            registrar,
            "proposePlatformAccountOwnerRotation",
            accountId,
            System.Text.Encoding.UTF8.GetBytes("wrong-binding"),
            RotatedOwner));
        fixture.CallVoid(registrar, "proposePlatformAccountOwnerRotation", accountId, appBinding, RotatedOwner);
        Assert.AreEqual(AppAdmin, fixture.CallUInt160(wallet, "getBackupOwner", accountId));
        VmArray pendingRotation = (VmArray)fixture.Call(registrar,
            "getPendingPlatformOwnerRotation", accountId);
        Assert.AreEqual(Neo.VM.Types.StackItemType.ByteString, pendingRotation[0].Type);
        Assert.AreEqual(RotatedOwner, new UInt160(pendingRotation[0].GetSpan().ToArray()));
        Assert.AreEqual(AppAdmin, new UInt160(pendingRotation[1].GetSpan().ToArray()));
        Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            registrar,
            "confirmPlatformAccountOwnerRotation",
            accountId,
            appBinding));
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.SetSigners(AppAdmin);
        Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            registrar,
            "confirmPlatformAccountOwnerRotation",
            accountId,
            appBinding));
        fixture.SetSigners(RotatedOwner);
        fixture.CallVoid(registrar, "confirmPlatformAccountOwnerRotation", accountId, appBinding);
        Assert.AreEqual(RotatedOwner, fixture.CallUInt160(wallet, "getBackupOwner", accountId));

        fixture.SetSigners(Stranger);
        Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "updateVerifier",
            accountId,
            verifier,
            Array.Empty<byte>()));

        fixture.SetSigners(AppAdmin);
        Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "updateVerifier",
            accountId,
            verifier,
            Array.Empty<byte>()));

        fixture.SetSigners(RotatedOwner);
        fixture.CallVoid(wallet, "updateVerifier", accountId, verifier, Array.Empty<byte>());
        Assert.AreEqual(verifier, fixture.CallUInt160(wallet, "getVerifier", accountId));
    }

    [TestMethod]
    public void CurrentOwnerCanCancelPendingPlatformOwnerRotation()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccount");
        UInt160 registrar = fixture.Deploy("SAPlatformRegistrar", wallet.ToArray());
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:rotation-cancel");

        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");
        UInt160 accountId = fixture.CallUInt160(
            registrar,
            "registerPlatformAccount",
            appBinding,
            AppAdmin,
            EscapeTimelock);

        fixture.CallVoid(registrar, "proposePlatformAccountOwnerRotation", accountId, appBinding, RotatedOwner);
        fixture.SetSigners(AppAdmin);
        fixture.CallVoid(registrar, "cancelPlatformAccountOwnerRotation", accountId, appBinding);
        Assert.AreEqual(Neo.VM.Types.StackItemType.Any,
            fixture.Call(registrar, "getPendingPlatformOwnerRotation", accountId).Type);
        Assert.AreEqual(AppAdmin, fixture.CallUInt160(wallet, "getBackupOwner", accountId));
    }

    [TestMethod]
    public void EscapeBlocksRotationConfirmUntilFinalized()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccount");
        UInt160 registrar = fixture.Deploy("SAPlatformRegistrar", wallet.ToArray());
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:rotation-escape");

        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");
        UInt160 accountId = fixture.CallUInt160(
            registrar,
            "registerPlatformAccount",
            appBinding,
            AppAdmin,
            EscapeTimelock);

        fixture.CallVoid(registrar, "proposePlatformAccountOwnerRotation", accountId, appBinding, RotatedOwner);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.SetSigners(AppAdmin);
        fixture.CallVoid(wallet, "initiateEscape", accountId);
        fixture.AdvanceTime(TimeSpan.FromSeconds(EscapeTimelock));

        // While the escape is active the core rejects the registrar's apply outright.
        fixture.SetSigners(RotatedOwner);
        TestException active = Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            registrar,
            "confirmPlatformAccountOwnerRotation",
            accountId,
            appBinding));
        StringAssert.Contains(active.Message, "Platform account escape active");

        // Phase 1b: escape finalization no longer deletes a registrar-owned pending
        // record (the core stopped touching storage it does not own); after
        // finalization the rotation can still complete, and only with the new
        // owner's witness.
        fixture.SetSigners(AppAdmin);
        fixture.CallVoid(wallet, "finalizeEscape", accountId, UInt160.Zero);
        Assert.AreEqual(Neo.VM.Types.StackItemType.Array,
            fixture.Call(registrar, "getPendingPlatformOwnerRotation", accountId).Type);
        fixture.SetSigners(RotatedOwner);
        fixture.CallVoid(registrar, "confirmPlatformAccountOwnerRotation", accountId, appBinding);
        Assert.AreEqual(RotatedOwner, fixture.CallUInt160(wallet, "getBackupOwner", accountId));
    }

    [TestMethod]
    public void PlatformRegistryBindingMatchesTheSharedRosterVector()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccount");
        byte[] appId = System.Text.Encoding.UTF8.GetBytes("miniapp-jump-rush");
        byte[] appBinding = new byte[PlatformRegistryBindingPrefix.Length + appId.Length];
        Buffer.BlockCopy(PlatformRegistryBindingPrefix, 0, appBinding, 0, PlatformRegistryBindingPrefix.Length);
        Buffer.BlockCopy(appId, 0, appBinding, PlatformRegistryBindingPrefix.Length, appId.Length);

        UInt160 accountId = fixture.CallUInt160(
            wallet,
            "computePlatformAccountId",
            appBinding,
            AppAdmin,
            EscapeTimelock);

        Assert.AreEqual(
            UInt160.Parse("0x810ab40316a25958cfef1f3d52d4a3406eade0e1"),
            accountId);
    }

    [TestMethod]
    public void StablePlatformAccountIdIsIndependentOfBackupOwner()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccount");
        UInt160 registrar = fixture.Deploy("SAPlatformRegistrar", wallet.ToArray());
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:stable-app");

        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");

        UInt160 first = fixture.CallUInt160(
            wallet,
            "computeStablePlatformAccountId",
            appBinding,
            EscapeTimelock);
        UInt160 second = fixture.CallUInt160(
            wallet,
            "computeStablePlatformAccountId",
            appBinding,
            EscapeTimelock);
        Assert.AreEqual(first, second);

        UInt160 accountId = fixture.CallUInt160(
            registrar,
            "registerStablePlatformAccount",
            appBinding,
            RotatedOwner,
            EscapeTimelock);
        Assert.AreEqual(first, accountId);
        Assert.AreEqual(RotatedOwner, fixture.CallUInt160(wallet, "getBackupOwner", accountId));
    }

    [TestMethod]
    public void StablePlatformAccountIndexesProxyToAccountId()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccount");
        UInt160 registrar = fixture.Deploy("SAPlatformRegistrar", wallet.ToArray());
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:proxy-index");

        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");

        UInt160 accountId = fixture.CallUInt160(
            registrar,
            "registerStablePlatformAccount",
            appBinding,
            RotatedOwner,
            EscapeTimelock);
        UInt160 proxy = fixture.CallUInt160(wallet, "getProxyScriptHash", accountId);

        Assert.AreEqual(accountId, fixture.CallUInt160(wallet, "getAccountIdByProxy", proxy));
        Assert.AreEqual(UInt160.Zero, fixture.CallUInt160(wallet, "getAccountIdByProxy", Stranger));
    }

    [TestMethod]
    public void DirectCallerCannotUseRegistrarBypass()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccount");
        UInt160 registrar = fixture.Deploy("SAPlatformRegistrar", wallet.ToArray());
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:miniapp-sheep-solitaire");

        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");
        UInt160 accountId = fixture.CallUInt160(
            wallet,
            "computePlatformAccountId",
            appBinding,
            AppAdmin,
            EscapeTimelock);

        fixture.SetSigners(AppAdmin);
        TestException exception = Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "registerPlatformAccount",
            accountId,
            appBinding,
            AppAdmin,
            EscapeTimelock));

        StringAssert.Contains(exception.Message, "Unauthorized platform registrar");

        // Phase 1b: the rotation write moved behind applyPlatformAccountOwnerRotation;
        // a direct (non-registrar) caller is still rejected by the pointer gate.
        Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "applyPlatformAccountOwnerRotation",
            accountId,
            appBinding,
            AppAdmin,
            AppAdmin));
    }

    [TestMethod]
    public void RegistrarProposalRequiresDeployedContract()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccount");

        TestException exception = Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "proposePlatformRegistrar",
            Stranger));

        StringAssert.Contains(exception.Message, "platform registrar not deployed");
    }

    [TestMethod]
    [DataRow("proposePlatformRegistrar")]
    [DataRow("confirmPlatformRegistrar")]
    [DataRow("cancelPlatformRegistrar")]
    public void ExecuteUserOp_TargetCannotReenterPlatformRegistrarConfiguration(string method)
    {
        RuntimeFixture fixture = new();
        fixture.SetSigners(AppAdmin);
        UInt160 wallet = fixture.Deploy("SmartAccount");
        UInt160 target = fixture.Deploy("MockVerifierCore");
        UInt160 registrar = fixture.Deploy("SAPlatformRegistrar", wallet.ToArray());
        UInt160 accountId = fixture.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            UInt160.Zero,
            Array.Empty<byte>(),
            UInt160.Zero,
            AppAdmin,
            EscapeTimelock);
        fixture.CallVoid(
            wallet,
            "registerAccount",
            accountId,
            UInt160.Zero,
            Array.Empty<byte>(),
            UInt160.Zero,
            AppAdmin,
            EscapeTimelock);

        if (method != "proposePlatformRegistrar")
        {
            fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
            if (method == "confirmPlatformRegistrar") fixture.AdvanceTime(TimeSpan.FromDays(7));
        }

        object?[] configArgs = method == "proposePlatformRegistrar"
            ? new object?[] { registrar }
            : Array.Empty<object>();
        object[] op = RuntimeFixture.UserOp(
            target,
            "forward",
            new object?[] { wallet, method, configArgs },
            0,
            fixture.Now() + 60_000,
            Array.Empty<byte>());

        TestException rejected = Assert.ThrowsExactly<TestException>(() =>
            fixture.CallVoid(wallet, "executeUserOp", accountId, op));
        StringAssert.Contains(rejected.Message, "Global configuration context active");
        Assert.AreEqual(System.Numerics.BigInteger.Zero, fixture.CallInteger(wallet, "getNonce", accountId, 0));
        Assert.IsFalse(fixture.CallBoolean(wallet, "isExecutionActive", accountId));
        Assert.AreEqual(UInt160.Zero, fixture.CallUInt160(wallet, "getPlatformRegistrar"));
        Assert.AreEqual(
            method == "proposePlatformRegistrar" ? UInt160.Zero : registrar,
            fixture.CallUInt160(wallet, "getPendingPlatformRegistrar"));

        fixture.CallVoid(wallet, method, configArgs);
        if (method == "confirmPlatformRegistrar")
        {
            Assert.AreEqual(registrar, fixture.CallUInt160(wallet, "getPlatformRegistrar"));
            Assert.AreEqual(UInt160.Zero, fixture.CallUInt160(wallet, "getPendingPlatformRegistrar"));
        }
        else
        {
            Assert.AreEqual(
                method == "proposePlatformRegistrar" ? registrar : UInt160.Zero,
                fixture.CallUInt160(wallet, "getPendingPlatformRegistrar"));
        }
    }

    [TestMethod]
    [DataRow("confirmRotate")]
    [DataRow("cancelRotate")]
    public void ExecuteUserOp_TargetCannotReenterPlatformOwnerRotation(string method)
    {
        RuntimeFixture fixture = new();
        fixture.SetSigners(AppAdmin);
        UInt160 wallet = fixture.Deploy("SmartAccount");
        UInt160 target = fixture.Deploy("MockVerifierCore");
        UInt160 registrar = fixture.Deploy("SAPlatformRegistrar", wallet.ToArray());
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes(
            "neo-miniapps-platform:reentrant-owner-rotation");

        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");
        UInt160 accountId = fixture.CallUInt160(
            registrar,
            "registerPlatformAccount",
            appBinding,
            AppAdmin,
            EscapeTimelock);
        fixture.CallVoid(registrar, "proposePlatformAccountOwnerRotation", accountId, appBinding, RotatedOwner);
        fixture.AdvanceTime(TimeSpan.FromDays(7));

        // Both signers are scoped to the core so the inner registrar call can satisfy
        // the existing backup-owner and proposed-new-owner guards on the core side.
        fixture.Engine.SetTransactionSigners(
            new Neo.Network.P2P.Payloads.Signer
            {
                Account = AppAdmin,
                Scopes = Neo.Network.P2P.Payloads.WitnessScope.CustomContracts,
                AllowedContracts = new[] { wallet },
            },
            new Neo.Network.P2P.Payloads.Signer
            {
                Account = RotatedOwner,
                Scopes = Neo.Network.P2P.Payloads.WitnessScope.CustomContracts,
                AllowedContracts = new[] { wallet },
            });
        object[] op = RuntimeFixture.UserOp(
            target,
            "forward",
            new object?[]
            {
                registrar,
                method == "confirmRotate" ? "confirmPlatformAccountOwnerRotation" : "cancelPlatformAccountOwnerRotation",
                new object?[] { accountId, appBinding },
            },
            0,
            fixture.Now() + 60_000,
            Array.Empty<byte>());

        TestException rejected = Assert.ThrowsExactly<TestException>(() =>
            fixture.CallVoid(wallet, "executeUserOp", accountId, op));
        // Phase 1b: confirm reaches the core's apply entry and is stopped by the
        // account-configuration guard; cancel is stopped earlier because neither the
        // registrar admin nor the current owner witness is in scope for the target.
        StringAssert.Contains(
            rejected.Message,
            method == "confirmRotate" ? "Account configuration context active" : "Unauthorized platform owner rotation cancellation");
        Assert.AreEqual(AppAdmin, fixture.CallUInt160(wallet, "getBackupOwner", accountId));
        Assert.AreEqual(
            Neo.VM.Types.StackItemType.Array,
            fixture.Call(registrar, "getPendingPlatformOwnerRotation", accountId).Type);

        if (method == "confirmRotate") fixture.SetSigners(RotatedOwner);
        else fixture.SetSigners(AppAdmin);
        fixture.CallVoid(
            registrar,
            method == "confirmRotate" ? "confirmPlatformAccountOwnerRotation" : "cancelPlatformAccountOwnerRotation",
            accountId,
            appBinding);
        if (method == "confirmRotate")
        {
            Assert.AreEqual(RotatedOwner, fixture.CallUInt160(wallet, "getBackupOwner", accountId));
        }
        else
        {
            Assert.AreEqual(AppAdmin, fixture.CallUInt160(wallet, "getBackupOwner", accountId));
            Assert.AreEqual(
                Neo.VM.Types.StackItemType.Any,
                fixture.Call(registrar, "getPendingPlatformOwnerRotation", accountId).Type);
        }
    }
}
