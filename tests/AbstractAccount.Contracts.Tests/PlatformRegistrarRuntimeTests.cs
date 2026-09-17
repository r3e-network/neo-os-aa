using System;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

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
        UInt160 wallet = fixture.Deploy("UnifiedSmartWalletV3");
        UInt160 registrar = fixture.Deploy("PlatformRegistrarMock");
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
            "register",
            wallet,
            appBinding,
            AppAdmin,
            EscapeTimelock);

        Assert.AreEqual(expected, accountId);
        Assert.AreEqual(AppAdmin, fixture.CallUInt160(wallet, "getBackupOwner", accountId));
        Assert.AreEqual(UInt160.Zero, fixture.CallUInt160(wallet, "getVerifier", accountId));
        Assert.AreEqual(UInt160.Zero, fixture.CallUInt160(wallet, "getHook", accountId));

        Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            registrar,
            "rotate",
            wallet,
            accountId,
            System.Text.Encoding.UTF8.GetBytes("wrong-binding"),
            RotatedOwner));
        fixture.CallVoid(registrar, "rotate", wallet, accountId, appBinding, RotatedOwner);
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
    public void PlatformRegistryBindingMatchesTheSharedRosterVector()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("UnifiedSmartWalletV3");
        UInt160 registrar = fixture.Deploy("PlatformRegistrarMock");
        byte[] appId = System.Text.Encoding.UTF8.GetBytes("miniapp-jump-rush");
        byte[] appBinding = new byte[PlatformRegistryBindingPrefix.Length + appId.Length];
        Buffer.BlockCopy(PlatformRegistryBindingPrefix, 0, appBinding, 0, PlatformRegistryBindingPrefix.Length);
        Buffer.BlockCopy(appId, 0, appBinding, PlatformRegistryBindingPrefix.Length, appId.Length);

        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");

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
        UInt160 wallet = fixture.Deploy("UnifiedSmartWalletV3");
        UInt160 registrar = fixture.Deploy("PlatformRegistrarMock");
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
            "registerStable",
            wallet,
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
        UInt160 wallet = fixture.Deploy("UnifiedSmartWalletV3");
        UInt160 registrar = fixture.Deploy("PlatformRegistrarMock");
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:proxy-index");

        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");

        UInt160 accountId = fixture.CallUInt160(
            registrar,
            "registerStable",
            wallet,
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
        UInt160 wallet = fixture.Deploy("UnifiedSmartWalletV3");
        UInt160 registrar = fixture.Deploy("PlatformRegistrarMock");
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

        Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "rotatePlatformAccountOwner",
            accountId,
            appBinding,
            AppAdmin));
    }

    [TestMethod]
    public void RegistrarProposalRequiresDeployedContract()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("UnifiedSmartWalletV3");

        TestException exception = Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "proposePlatformRegistrar",
            Stranger));

        StringAssert.Contains(exception.Message, "platform registrar not deployed");
    }
}
