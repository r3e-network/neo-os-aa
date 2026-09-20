using System;
using System.IO;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the recovery verifier's V3 lifecycle cleanup. The AA core calls
/// <c>clearAccount</c> on the outgoing verifier from <c>confirmVerifierUpdate</c>,
/// <c>finalizeEscape</c> and <c>settleMarketEscrow</c>, and a nested call to a missing method
/// faults the enclosing transaction uncatchably. <c>SocialRecoveryVerifier</c> is bound as an
/// account verifier (see <c>RegisterAccount_AcceptsRecoveryVerifierWithV3Marker</c>) but had no
/// <c>clearAccount</c>, so an account bound to it could never rotate away, complete an escape or
/// be sold. It now implements the method: core-gated through <c>canConfigureVerifier</c>, wipes
/// every account-scoped recovery record, refunds any GAS still earmarked for the account's
/// oracle to the recovery owner, and is idempotent for accounts that never completed setup.
/// </summary>
[TestClass]
public class Fix_RecoveryCleanup_Tests
{
    private static readonly UInt160 Owner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Oracle =
        UInt160.Parse("0x5555555555555555555555555555555555555555");

    private static readonly UInt160 AccountAddress =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private const uint EscapeTimelockSeconds = 2_592_000;

    private const ulong RecoveryTimelockMs = 604_800_000;

    // Must exceed the core's 24h ConfigUpdateTimelockMs.
    private static readonly TimeSpan ConfigUpdateWindow = TimeSpan.FromHours(24);

    private static readonly TimeSpan EscapeWindow = TimeSpan.FromSeconds(EscapeTimelockSeconds);

    private static readonly BigInteger OracleCredit = 250_000_000; // 2.5 GAS

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Recovery { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("UnifiedSmartWalletV3");
            Recovery = Fx.Deploy("SocialRecoveryVerifier");
            Fx.CallVoid(Recovery, "setAuthorizedCore", Wallet);
        }

        /// <summary>Registers an account whose verifier is the recovery verifier.</summary>
        public UInt160 RegisterRecoveryBoundAccount()
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                Recovery, Array.Empty<byte>(), UInt160.Zero, Owner, EscapeTimelockSeconds);

            Fx.SetSigners(Owner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, Recovery, Array.Empty<byte>(), UInt160.Zero, Owner, EscapeTimelockSeconds);
            Assert.AreEqual(Recovery, Fx.CallUInt160(Wallet, "getVerifier", accountId));
            return accountId;
        }

        public void SetupRecovery(UInt160 accountId, P256SessionKey morpheusKey)
        {
            byte[] factor = new byte[32];
            for (int i = 0; i < factor.Length; i++) factor[i] = (byte)(i + 1);

            Fx.SetSigners(Owner);
            Fx.CallVoid(
                Recovery, "setupRecovery",
                accountId, accountId.ToString(), "neo3-testnet", Owner, Wallet, AccountAddress, Oracle,
                new object?[] { factor }, (BigInteger)1, RecoveryTimelockMs, morpheusKey.CompressedPublicKey);
            Assert.AreEqual(Owner, Fx.CallUInt160(Recovery, "getOwner", accountId), "Precondition: recovery configured");
        }

        public void FundOracleCredit(UInt160 accountId, BigInteger amount)
        {
            Fx.FundGasFromValidators(Owner, amount * 2);
            Fx.SetSigners(Owner);
            Fx.TransferGas(Owner, Recovery, amount, accountId);
            Assert.AreEqual(amount, Fx.CallInteger(Recovery, "getOracleCredit", accountId), "Precondition: credit earmarked");
        }

        public void AssertRecoveryStateCleared(UInt160 accountId)
        {
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Recovery, "getOwner", accountId), "owner cleared");
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Recovery, "getAAContract", accountId), "aa contract cleared");
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Recovery, "getMorpheusOracle", accountId), "oracle cleared");
            Assert.AreEqual(BigInteger.Zero, Fx.CallInteger(Recovery, "getThreshold", accountId), "threshold cleared");
            Assert.AreEqual(BigInteger.Zero, Fx.CallInteger(Recovery, "getTimelock", accountId), "timelock cleared");
            Assert.AreEqual(BigInteger.Zero, Fx.CallInteger(Recovery, "getRecoveryNonce", accountId), "nonce cleared");
            Assert.AreEqual(BigInteger.Zero, Fx.CallInteger(Recovery, "getOracleCredit", accountId), "credit cleared");
            Neo.VM.Types.Array factors = (Neo.VM.Types.Array)Fx.Call(Recovery, "getMasterNullifiers", accountId);
            Assert.AreEqual(0, factors.Count, "factors cleared");
        }
    }

    [TestMethod]
    public void ConfirmVerifierUpdate_ClearsRecoveryStateAndRefundsOracleCredit()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterRecoveryBoundAccount();
        h.SetupRecovery(accountId, morpheusKey);
        h.FundOracleCredit(accountId, OracleCredit);
        BigInteger ownerBefore = h.Fx.GasBalanceOf(Owner);
        BigInteger verifierBefore = h.Fx.GasBalanceOf(h.Recovery);

        // Rotate the account away from the recovery verifier through the timelocked path.
        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "updateVerifier", accountId, UInt160.Zero, Array.Empty<byte>());
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "hasPendingVerifierUpdate", accountId));
        h.Fx.AdvanceTime(ConfigUpdateWindow);
        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "confirmVerifierUpdate", accountId);
        // Notifications are captured per call, so read the cleanup event before any further query.
        Neo.VM.Types.Array cleared = h.Fx.SingleNotificationState(h.Recovery, "RecoveryCleared");
        Assert.AreEqual(accountId, new UInt160(cleared[0].GetSpan()));
        Assert.AreEqual(Owner, new UInt160(cleared[1].GetSpan()));
        Assert.AreEqual(OracleCredit, cleared[2].GetInteger());

        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId),
            "The core must be able to detach the recovery verifier");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "hasPendingVerifierUpdate", accountId));
        h.AssertRecoveryStateCleared(accountId);

        // The earmarked oracle GAS goes back to the recovery owner instead of being orphaned.
        Assert.AreEqual(ownerBefore + OracleCredit, h.Fx.GasBalanceOf(Owner), "credit refunded to owner");
        Assert.AreEqual(verifierBefore - OracleCredit, h.Fx.GasBalanceOf(h.Recovery), "verifier no longer holds the credit");

        // The detached account is controlled by the native backup-owner path again.
        UInt160 target = h.Fx.Deploy("MockTransferTarget");
        h.Fx.SetSigners(Owner);
        object[] op = RuntimeFixture.UserOp(
            target, "transfer",
            new object?[] { accountId, AccountAddress, (BigInteger)1, null },
            0, h.Fx.Now() + 3_600_000, Array.Empty<byte>());
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "executeUserOp", accountId, op));
    }

    [TestMethod]
    public void FinalizeEscape_AwayFromRecoveryVerifier_Succeeds()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterRecoveryBoundAccount();
        h.SetupRecovery(accountId, morpheusKey);

        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "initiateEscape", accountId);
        h.Fx.AdvanceTime(EscapeWindow);
        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "finalizeEscape", accountId, UInt160.Zero);

        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId));
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId));
        h.AssertRecoveryStateCleared(accountId);
    }

    [TestMethod]
    public void ConfirmVerifierUpdate_WithoutRecoverySetup_IsIdempotent()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterRecoveryBoundAccount();

        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "updateVerifier", accountId, UInt160.Zero, Array.Empty<byte>());
        h.Fx.AdvanceTime(ConfigUpdateWindow);
        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "confirmVerifierUpdate", accountId);
        Neo.VM.Types.Array cleared = h.Fx.SingleNotificationState(h.Recovery, "RecoveryCleared");
        Assert.AreEqual(UInt160.Zero, new UInt160(cleared[1].GetSpan()), "no owner was ever configured");
        Assert.AreEqual(BigInteger.Zero, cleared[2].GetInteger(), "nothing to refund");

        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId));
    }

    [TestMethod]
    public void ClearAccount_RejectsCallersOtherThanTheBoundCore()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterRecoveryBoundAccount();
        h.SetupRecovery(accountId, morpheusKey);

        // Even the recovery owner cannot wipe the configuration directly: only the pinned core,
        // inside its per-account configuration context, may.
        h.Fx.SetSigners(Owner);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Recovery, "clearAccount", accountId));
        StringAssert.Contains(rejected.Message, "Unauthorized AA core caller");
        Assert.AreEqual(Owner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId), "configuration untouched");

        // A foreign contract impersonating a core is refused as well.
        UInt160 impostor = h.Fx.Deploy("MockVerifierCore");
        TestException impostorRejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(impostor, "forward", h.Recovery, "clearAccount", new object?[] { accountId }));
        StringAssert.Contains(impostorRejected.Message, "Unauthorized AA core caller");
    }

    [TestMethod]
    public void RecoveryVerifier_DeclaresTheV3CleanupSurface()
    {
        string v3Source = File.ReadAllText(Path.Combine(RepoRoot, "contracts", "recovery", "MorpheusSocialRecoveryVerifier.V3.cs"));
        StringAssert.Contains(v3Source, "public static void ClearAccount(UInt160 accountId)");
        StringAssert.Contains(v3Source, "AssertV3ConfigCaller(accountId);");
        StringAssert.Contains(v3Source, "\"canConfigureVerifier\"");
        // Replay markers survive cleanup on purpose; every other account-scoped family is removed.
        Assert.IsFalse(v3Source.Contains("Key(PREFIX_USED_ACTION, accountId)", StringComparison.Ordinal),
            "consumed action nullifiers are replay protection and must not be cleared");
        StringAssert.Contains(v3Source, "DeleteAccountPrefixFamily(Key(PREFIX_APPROVAL, accountId));");

        string fixedSource = File.ReadAllText(Path.Combine(RepoRoot, "contracts", "recovery", "MorpheusSocialRecoveryVerifier.Fixed.cs"));
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"canConfigureVerifier\")");
        StringAssert.Contains(fixedSource, "[DisplayName(\"RecoveryCleared\")]");
    }
}
