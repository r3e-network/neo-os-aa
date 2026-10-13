using System;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

[TestClass]
public class ZkLoginConfigRuntimeTests
{
    private static readonly UInt160 Owner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private const uint EscapeTimelock = 2_592_000;

    [TestMethod]
    public void ConfigBlobRejectsTrailingBytesAtTheVerifierBoundary()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("UnifiedSmartWalletV3");
        UInt160 verifier = fixture.Deploy("verifiers/ZkLoginVerifier", wallet.ToArray());

        byte[] canonical = BuildConfigBlob();
        byte[] trailing = new byte[canonical.Length + 1];
        Buffer.BlockCopy(canonical, 0, trailing, 0, canonical.Length);
        trailing[^1] = 0xA5;

        UInt160 accountId = fixture.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            verifier,
            trailing,
            UInt160.Zero,
            Owner,
            EscapeTimelock);

        fixture.SetSigners(Owner);
        TestException exception = Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "registerAccount",
            accountId,
            verifier,
            trailing,
            UInt160.Zero,
            Owner,
            EscapeTimelock));

        StringAssert.Contains(exception.Message, "Invalid zklogin config length");
    }

    [TestMethod]
    public void SetConfigRejectsProviderLongerThanTheWireLengthPrefix()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("UnifiedSmartWalletV3");
        UInt160 verifier = fixture.Deploy("verifiers/ZkLoginVerifier", wallet.ToArray());
        byte[] canonical = BuildConfigBlob();
        UInt160 accountId = fixture.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            verifier,
            canonical,
            UInt160.Zero,
            Owner,
            EscapeTimelock);

        fixture.SetSigners(Owner);
        fixture.CallVoid(
            wallet,
            "registerAccount",
            accountId,
            verifier,
            canonical,
            UInt160.Zero,
            Owner,
            EscapeTimelock);

        string oversizedProvider = new('p', 256);
        byte[] signerPublicKey = new byte[33];
        signerPublicKey[0] = 0x02;
        byte[] masterNullifier = new byte[32];

        // CallVerifier uses a two-phase, one-day timelock.  The first call only
        // commits the exact configuration hash; the second reaches SetConfig.
        fixture.CallBoolean(
            wallet,
            "callVerifier",
            accountId,
            "setConfig",
            new object[] { accountId, signerPublicKey, oversizedProvider, masterNullifier });
        fixture.AdvanceTime(TimeSpan.FromDays(1));

        TestException exception = Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "callVerifier",
            accountId,
            "setConfig",
            new object[] { accountId, signerPublicKey, oversizedProvider, masterNullifier }));

        StringAssert.Contains(exception.Message, "Provider must be 1-255 bytes");
    }

    private static byte[] BuildConfigBlob()
    {
        byte[] provider = System.Text.Encoding.UTF8.GetBytes("google");
        byte[] blob = new byte[1 + 1 + 33 + 1 + provider.Length + 32];
        int cursor = 0;
        blob[cursor++] = 0x01;
        blob[cursor++] = 33;
        blob[cursor++] = 0x02;
        cursor += 32;
        blob[cursor++] = (byte)provider.Length;
        Buffer.BlockCopy(provider, 0, blob, cursor, provider.Length);
        cursor += provider.Length;
        for (int i = 0; i < 32; i++) blob[cursor + i] = (byte)(i + 1);
        return blob;
    }
}
