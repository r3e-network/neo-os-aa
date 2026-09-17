using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Regression tests for the L1 escape-hatch hardening: <c>finalizeEscape</c> must hand the
/// backup owner a clean configuration rather than merely swapping the verifier hash. It must
/// (1) atomically configure the new verifier with the supplied params, (2) clear the old
/// (possibly compromised) verifier's per-account config, and (3) reset the installed hook —
/// clearing the old hook's per-account config and removing it from state — so a compromised
/// hook cannot persist across an escape.
/// </summary>
[TestClass]
public class Fix_escape_Tests
{
    // 7-day minimum escape timelock (seconds).
    private const uint EscapeTimelockSeconds = 604_800;

    // Verifier/hook config confirmation timelock used by callHook (24h, in ms).
    private static readonly TimeSpan ConfigUpdateWindow = TimeSpan.FromHours(24);

    // Escape timelock advance: the escape timelock is in seconds; convert to a real TimeSpan with margin.
    private static readonly TimeSpan EscapeWindow = TimeSpan.FromSeconds(EscapeTimelockSeconds) + TimeSpan.FromHours(1);

    private static readonly UInt160 BackupOwner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 WhitelistTarget =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    // 65-byte uncompressed secp256k1 public keys accepted by Web3AuthVerifier.SetPublicKey.
    private static byte[] OldPubKey() => MakePubKey(0xA1);
    private static byte[] NewPubKey() => MakePubKey(0xB2);

    private static byte[] MakePubKey(byte tag)
    {
        byte[] pubKey = new byte[65];
        pubKey[0] = 0x04; // uncompressed prefix
        for (int i = 1; i < 65; i++)
        {
            pubKey[i] = (byte)(tag + i);
        }
        return pubKey;
    }

    private sealed class EscapeHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 OldVerifier { get; }

        public UInt160 NewVerifier { get; }

        public UInt160 Hook { get; }

        public EscapeHarness()
        {
            Wallet = Fx.Deploy("UnifiedSmartWalletV3");
            // The verifiers/hook trust this wallet as their AA core (passed as deploy data).
            // Two distinct verifier contracts are used so they have distinct deploy hashes; both
            // accept a 65-byte uncompressed public key through setPublicKey/getPublicKey/clearAccount.
            OldVerifier = Fx.Deploy("verifiers/Web3AuthVerifier", Wallet.ToArray());
            NewVerifier = Fx.Deploy("verifiers/TEEVerifier", Wallet.ToArray());
            Hook = Fx.Deploy("hooks/WhitelistHook", Wallet.ToArray());
        }

        public UInt160 RegisterAccount(byte[] verifierParams)
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                OldVerifier, verifierParams, Hook, BackupOwner, EscapeTimelockSeconds);

            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, OldVerifier, verifierParams, Hook, BackupOwner, EscapeTimelockSeconds);
            return accountId;
        }

        /// <summary>Seeds per-account hook state via the two-phase timelocked callHook path.</summary>
        public void SeedHookWhitelist(UInt160 accountId, UInt160 target)
        {
            Fx.SetSigners(BackupOwner);
            object[] args = new object[] { accountId, target, true };
            // First call records the pending module call; second (after the window) applies it.
            Assert.IsFalse(Fx.CallBoolean(Wallet, "callHook", accountId, "setWhitelist", args),
                "First callHook only schedules the pending module call");
            Fx.AdvanceTime(ConfigUpdateWindow);
            Fx.CallVoid(Wallet, "callHook", accountId, "setWhitelist", args);
        }

        public void InitiateAndAdvancePastTimelock(UInt160 accountId)
        {
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "initiateEscape", accountId);
            Fx.AdvanceTime(EscapeWindow);
        }
    }

    [TestMethod]
    public void FinalizeEscape_ConfiguresNewVerifierClearsOldAndResetsHook()
    {
        EscapeHarness h = new();
        byte[] oldKey = OldPubKey();
        byte[] newKey = NewPubKey();

        UInt160 accountId = h.RegisterAccount(oldKey);

        // Preconditions: old verifier configured, hook installed and holding per-account state.
        CollectionAssert.AreEqual(oldKey, h.Fx.CallBytes(h.OldVerifier, "getPublicKey", accountId),
            "Old verifier holds the registered public key");
        Assert.AreEqual(h.Hook, h.Fx.CallUInt160(h.Wallet, "getHook", accountId), "Hook installed at registration");

        h.SeedHookWhitelist(accountId, WhitelistTarget);
        Assert.IsTrue(h.Fx.CallBoolean(h.Hook, "isWhitelisted", accountId, WhitelistTarget),
            "Hook holds per-account whitelist state before escape");

        h.InitiateAndAdvancePastTimelock(accountId);

        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(h.Wallet, "finalizeEscape", accountId, h.NewVerifier, newKey);

        // 1. The new verifier is rotated in AND configured with the supplied params atomically.
        Assert.AreEqual(h.NewVerifier, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId),
            "Verifier rotated to the new verifier");
        CollectionAssert.AreEqual(newKey, h.Fx.CallBytes(h.NewVerifier, "getPublicKey", accountId),
            "New verifier is configured with the supplied params");

        // 2. The old (possibly compromised) verifier's per-account config is cleared.
        CollectionAssert.AreEqual(Array.Empty<byte>(), h.Fx.CallBytes(h.OldVerifier, "getPublicKey", accountId),
            "Old verifier config is cleared so a compromised verifier cannot still validate");

        // 3. The installed hook is reset: removed from state and its per-account config cleared.
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getHook", accountId),
            "Hook is removed from account state on escape");
        Assert.IsFalse(h.Fx.CallBoolean(h.Hook, "isWhitelisted", accountId, WhitelistTarget),
            "Compromised hook's per-account config is cleared on escape");

        // Escape state is reset so the flow can be re-armed.
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Wallet, "getEscapeTriggeredAt", accountId),
            "Escape trigger is reset after finalize");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId));
    }

    [TestMethod]
    public void FinalizeEscape_LegacyTwoArgumentPathRemainsAvailable()
    {
        EscapeHarness h = new();
        UInt160 accountId = h.RegisterAccount(OldPubKey());
        h.InitiateAndAdvancePastTimelock(accountId);

        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(h.Wallet, "finalizeEscape", accountId, h.NewVerifier);

        Assert.AreEqual(h.NewVerifier, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId));
        CollectionAssert.AreEqual(
            Array.Empty<byte>(),
            h.Fx.CallBytes(h.NewVerifier, "getPublicKey", accountId),
            "The legacy entrypoint preserves its historical no-verifier-params behavior");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId));
    }

    [TestMethod]
    public void FinalizeEscape_WithoutInitiation_Faults()
    {
        EscapeHarness h = new();
        UInt160 accountId = h.RegisterAccount(OldPubKey());

        h.Fx.SetSigners(BackupOwner);
        TestException notInitiated = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "finalizeEscape", accountId, h.NewVerifier, NewPubKey()));
        StringAssert.Contains(notInitiated.Message, "Escape not initiated");
    }

    [TestMethod]
    public void FinalizeEscape_BeforeTimelock_Faults()
    {
        EscapeHarness h = new();
        UInt160 accountId = h.RegisterAccount(OldPubKey());

        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(h.Wallet, "initiateEscape", accountId);

        TestException locked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "finalizeEscape", accountId, h.NewVerifier, NewPubKey()));
        StringAssert.Contains(locked.Message, "Timelock active");
    }

    [TestMethod]
    public void FinalizeEscape_OnlyBackupOwnerMayFinalize()
    {
        EscapeHarness h = new();
        UInt160 accountId = h.RegisterAccount(OldPubKey());
        h.InitiateAndAdvancePastTimelock(accountId);

        h.Fx.SetSigners(WhitelistTarget); // some other account, not the backup owner
        TestException unauthorized = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "finalizeEscape", accountId, h.NewVerifier, NewPubKey()));
        StringAssert.Contains(unauthorized.Message, "Only backup owner can finalize");
    }
}
