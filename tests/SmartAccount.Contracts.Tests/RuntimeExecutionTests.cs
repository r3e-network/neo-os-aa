using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Registration identity and v4 account creation (spec §16.1): custody‖salt is
/// the identity, the initial configuration installs atomically, and the legacy
/// registration helper survives only as the platform-registrar identity source.
/// </summary>
[TestClass]
public class RuntimeExecutionTests
{
    private static readonly UInt160 Custody =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Verifier =
        UInt160.Parse("0x5be915aea3ce85e4752d522632f0a9520e377aaf");

    private static readonly BigInteger SevenDaysMs = 7L * 24 * 60 * 60 * 1000;

    [TestMethod]
    public void ComputeRegistrationAccountId_MatchesFrontendVectorInRuntime()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("SmartAccount");

        UInt160 accountId = fx.CallUInt160(
            core, "computeRegistrationAccountId",
            Verifier,
            new byte[] { 0x11, 0x22, 0x33, 0x44 },
            UInt160.Zero,
            Custody,
            2_592_000u);

        Assert.AreEqual(UInt160.Parse("0x27c01243fca45e1b821dc3bb45267a579762d530"), accountId);
    }

    [TestMethod]
    public void CreateAccount_PersistsSelectedAccountStateInRuntime()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("SmartAccount");
        byte[] salt = RuntimeFixture.Salt("runtime-registration");

        UInt160 expected = fx.CallUInt160(core, "computeAccountIdentity", Custody, salt);
        UInt160 accountId = fx.CreateAccount(core, Custody, salt, SevenDaysMs, new object[0]);

        Assert.AreEqual(expected, accountId);
        Assert.IsTrue(fx.AccountControl(core, accountId)[0].GetBoolean(), "The account must exist after creation");
        // 0 = active.
        Assert.AreEqual(BigInteger.Zero, fx.AccountStatus(core, accountId));
        Assert.AreEqual(Custody, fx.AccountCustody(core, accountId));
        Assert.AreEqual(SevenDaysMs, fx.AccountRecoveryTimelockMs(core, accountId));
        Assert.AreEqual(BigInteger.One, fx.AccountAuthorityEpoch(core, accountId));
        Assert.AreEqual(BigInteger.Zero, fx.AccountConfigurationNonce(core, accountId));
        // With no validator installed the built-in route stays authorized.
        Assert.IsTrue(fx.AccountDefaultOperationAuthorization(core, accountId));
        // The custody witness is what authorized creation; nothing is delegated yet.
        Assert.AreNotEqual(Custody, accountId);
    }

    [TestMethod]
    public void CreateAccount_RejectsDuplicateRegistrationInRuntime()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("SmartAccount");
        byte[] salt = RuntimeFixture.Salt("runtime-duplicate");

        fx.CreateAccount(core, Custody, salt, SevenDaysMs, new object[0]);

        TestException exception = Assert.ThrowsExactly<TestException>(() =>
            fx.CreateAccount(core, Custody, salt, SevenDaysMs, new object[0]));

        StringAssert.Contains(exception.Message, "Account already exists");
    }

    [TestMethod]
    public void CreateAccount_RejectsMismatchedAccountIdInRuntime()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("SmartAccount");

        fx.SetSigners(Custody);
        TestException exception = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(
                core, "createAccount",
                UInt160.Parse("0x27c01243fca45e1b821dc3bb45267a579762d530"),
                Custody,
                RuntimeFixture.Salt("runtime-mismatch"),
                SevenDaysMs,
                new object[0]));

        StringAssert.Contains(exception.Message, "Account id does not match registration parameters");
    }

    [TestMethod]
    public void ExecuteUserOp_BuiltInRouteExecutesWithCustodySignature()
    {
        RuntimeFixture fx = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 target = fx.Deploy("MockTransferTarget");
        UInt160 accountId = fx.CreateAccount(core, custody, "exec-builtin");

        BigInteger nonce = fx.PackedNonce(core, accountId, 0);
        object[] op = RuntimeFixture.UserOp(
            target, "supportsV3", new object?[0], nonce, fx.Now() + 60_000, new byte[] { 0x00 });
        op[11] = fx.SignBuiltIn(core, accountId, op, key);

        Assert.IsTrue(fx.CallBoolean(core, "executeUserOp", accountId, op));
        Assert.AreEqual(nonce + 1, fx.PackedNonce(core, accountId, 0),
            "A successful built-in operation consumes exactly one sequence");
    }
}
