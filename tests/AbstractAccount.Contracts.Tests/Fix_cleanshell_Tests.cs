using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the "clean shell" finding: both ownership-handoff paths —
/// <c>settleMarketEscrow</c> (sale to a buyer) and <c>finalizeEscape</c> (backup-owner escape) —
/// advertise that the resulting account is a genuinely fresh shell. They must therefore wipe the
/// stale per-account markers the prior owner could have left behind: in-flight timelocked plugin
/// calls (<c>Prefix_PendingVerifierCall</c>/<c>Prefix_PendingHookCall</c>), the escape-cooldown
/// stamp (<c>Prefix_EscapeLastInitiated</c>) that would otherwise lock the new owner out of
/// <c>initiateEscape</c>, and the off-chain metadata URI (<c>Prefix_MetadataUri</c>).
/// </summary>
[TestClass]
public class Fix_CleanShell_Tests
{
    private const uint EscapeTimelockSeconds = 604_800;

    // Verifier/hook config confirmation timelock used by callHook/callVerifier (24h, in ms).
    private static readonly TimeSpan ConfigUpdateWindow = TimeSpan.FromHours(24);

    private static readonly TimeSpan EscapeWindow =
        TimeSpan.FromSeconds(EscapeTimelockSeconds) + TimeSpan.FromHours(1);

    private static readonly UInt160 Seller =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Buyer =
        UInt160.Parse("0x6666666666666666666666666666666666666666");

    private static readonly UInt160 WhitelistTarget =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

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

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public UInt160 OldVerifier { get; }

        public UInt160 NewVerifier { get; }

        public UInt160 Hook { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("UnifiedSmartWalletV3");
            Market = Fx.Deploy("AAAddressMarket");
            // The verifiers/hook trust this wallet as their AA core (passed as deploy data). Two
            // distinct verifier contracts give distinct deploy hashes; both accept a 65-byte
            // uncompressed public key through setPublicKey/getPublicKey/clearAccount.
            OldVerifier = Fx.Deploy("verifiers/Web3AuthVerifier", Wallet.ToArray());
            NewVerifier = Fx.Deploy("verifiers/TEEVerifier", Wallet.ToArray());
            Hook = Fx.Deploy("hooks/WhitelistHook", Wallet.ToArray());
            Fx.CallVoid(Market, "setAllowedAA", Wallet, true);
        }

        public UInt160 RegisterAccount(byte[] verifierParams)
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                OldVerifier, verifierParams, Hook, Seller, EscapeTimelockSeconds);

            Fx.SetSigners(Seller);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, OldVerifier, verifierParams, Hook, Seller, EscapeTimelockSeconds);
            return accountId;
        }

        /// <summary>
        /// Records an in-flight (not yet confirmed) timelocked hook call without completing it,
        /// leaving a stale <c>Prefix_PendingHookCall</c> marker.
        /// </summary>
        public void ArmPendingHookCall(UInt160 accountId)
        {
            Fx.SetSigners(Seller);
            object[] args = new object[] { accountId, WhitelistTarget, true };
            Assert.IsFalse(Fx.CallBoolean(Wallet, "callHook", accountId, "setWhitelist", args),
                "First callHook only schedules the pending module call");
            Assert.IsTrue(Fx.CallBoolean(Wallet, "hasPendingHookCall", accountId),
                "A pending hook call must be armed for the test to be meaningful");
        }

        /// <summary>
        /// Records an in-flight (not yet confirmed) timelocked verifier call without completing it,
        /// leaving a stale <c>Prefix_PendingVerifierCall</c> marker.
        /// </summary>
        public void ArmPendingVerifierCall(UInt160 accountId)
        {
            Fx.SetSigners(Seller);
            // clearAccount is on the verifier allowlist and is a no-op-shaped call that needs no extra args.
            object[] args = new object[] { accountId };
            Assert.IsFalse(Fx.CallBoolean(Wallet, "callVerifier", accountId, "clearAccount", args),
                "First callVerifier only schedules the pending module call");
            Assert.IsTrue(Fx.CallBoolean(Wallet, "hasPendingVerifierCall", accountId),
                "A pending verifier call must be armed for the test to be meaningful");
        }

        public BigInteger CreateListing(UInt160 accountId)
        {
            Fx.SetSigners(Seller);
            Fx.CallVoid(Market, "createListing", Wallet, accountId, Price, "AA address", "");
            return Fx.CallInteger(Market, "getListingCount");
        }
    }

    [TestMethod]
    public void SettleMarketEscrow_HandsBuyerShellWithNoStaleMarkers()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(OldPubKey());

        // The seller leaves behind every kind of stale per-account marker before listing.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "setMetadataUri", accountId, "ipfs://seller-private-metadata");
        Assert.AreEqual("ipfs://seller-private-metadata", h.Fx.Call(h.Wallet, "getMetadataUri", accountId).GetString());

        h.ArmPendingVerifierCall(accountId);
        h.ArmPendingHookCall(accountId);

        // A still-armed escape stamp from before the listing would otherwise impose the
        // 1-hour escape cooldown on the buyer.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "initiateEscape", accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId));

        BigInteger listingId = h.CreateListing(accountId);

        // Buyer pays the price and settles, taking ownership of the shell.
        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);
        h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer);

        Assert.AreEqual(Buyer, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId));

        // The buyer receives a genuinely clean shell: no inherited markers.
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "hasPendingVerifierCall", accountId),
            "Stale pending verifier call must not survive the sale");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "hasPendingHookCall", accountId),
            "Stale pending hook call must not survive the sale");
        Assert.AreEqual(string.Empty, h.Fx.Call(h.Wallet, "getMetadataUri", accountId).GetString(),
            "Seller's metadata URI must not survive the sale");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Wallet, "getEscapeTriggeredAt", accountId),
            "Escape trigger must be reset for the buyer");

        // And crucially the buyer is not locked out of their own escape hatch by the seller's
        // stale escape-cooldown stamp: initiateEscape succeeds immediately after the sale.
        h.Fx.SetSigners(Buyer);
        h.Fx.CallVoid(h.Wallet, "initiateEscape", accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId),
            "Buyer can arm escape with no stale-cooldown lockout");
    }

    [TestMethod]
    public void FinalizeEscape_LeavesNoStalePendingCallsOrMetadata()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(OldPubKey());

        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "setMetadataUri", accountId, "ipfs://stale-metadata");

        h.ArmPendingVerifierCall(accountId);
        h.ArmPendingHookCall(accountId);

        // Run the escape to completion.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "initiateEscape", accountId);
        h.Fx.AdvanceTime(EscapeWindow);
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "finalizeEscape", accountId, h.NewVerifier, NewPubKey());

        // The rotated account is a clean slate.
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "hasPendingVerifierCall", accountId),
            "Stale pending verifier call must be cleared on escape");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "hasPendingHookCall", accountId),
            "Stale pending hook call must be cleared on escape");
        Assert.AreEqual(string.Empty, h.Fx.Call(h.Wallet, "getMetadataUri", accountId).GetString(),
            "Stale metadata URI must be cleared on escape");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Wallet, "getEscapeTriggeredAt", accountId),
            "Escape trigger is reset after finalize");
    }

    [TestMethod]
    public void SettleMarketEscrow_CleanupFailureDoesNotTransferDirtyShell()
    {
        Harness h = new();
        UInt160 failingVerifier = h.Fx.Deploy("MockVerifierCore");
        UInt160 accountId = h.RegisterAccount(Array.Empty<byte>());

        // Replace the normal verifier with a test-only V3 plugin whose clearAccount always faults.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "updateVerifier", accountId, failingVerifier, Array.Empty<byte>());
        h.Fx.AdvanceTime(ConfigUpdateWindow);
        h.Fx.CallVoid(h.Wallet, "confirmVerifierUpdate", accountId);

        BigInteger listingId = h.CreateListing(accountId);
        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer));
        StringAssert.Contains(rejected.Message, "Mock plugin cleanup failure");

        // The failed nested call faults the enclosing transaction: escrow, ownership and the
        // market's active listing remain unchanged, so no buyer receives a dirty shell.
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.AreEqual(failingVerifier, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId));
        Neo.VM.Types.Array listing = (Neo.VM.Types.Array)h.Fx.Call(h.Market, "getListing", listingId);
        Assert.AreEqual((BigInteger)1, listing[7].GetInteger(), "Failed settlement leaves listing Active");
    }

    [TestMethod]
    public void ConfirmVerifierUpdate_CleanupFailurePreservesOldVerifier()
    {
        Harness h = new();
        UInt160 failingVerifier = h.Fx.Deploy("MockVerifierCore");
        UInt160 accountId = h.RegisterAccount(OldPubKey());

        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "updateVerifier", accountId, failingVerifier, Array.Empty<byte>());
        h.Fx.AdvanceTime(ConfigUpdateWindow);
        h.Fx.CallVoid(h.Wallet, "confirmVerifierUpdate", accountId);

        h.Fx.CallVoid(h.Wallet, "updateVerifier", accountId, h.NewVerifier, NewPubKey());
        h.Fx.AdvanceTime(ConfigUpdateWindow);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "confirmVerifierUpdate", accountId));
        StringAssert.Contains(rejected.Message, "Mock plugin cleanup failure");
        Assert.AreEqual(failingVerifier, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId));
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "hasPendingVerifierUpdate", accountId));
    }

    [TestMethod]
    public void FinalizeEscape_CleanupFailurePreservesOldVerifierAndEscape()
    {
        Harness h = new();
        UInt160 failingVerifier = h.Fx.Deploy("MockVerifierCore");
        UInt160 accountId = h.RegisterAccount(OldPubKey());

        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "updateVerifier", accountId, failingVerifier, Array.Empty<byte>());
        h.Fx.AdvanceTime(ConfigUpdateWindow);
        h.Fx.CallVoid(h.Wallet, "confirmVerifierUpdate", accountId);

        h.Fx.CallVoid(h.Wallet, "initiateEscape", accountId);
        h.Fx.AdvanceTime(EscapeWindow);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "finalizeEscape", accountId, h.NewVerifier, NewPubKey()));
        StringAssert.Contains(rejected.Message, "Mock plugin cleanup failure");
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId));
        Assert.AreEqual(failingVerifier, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId));
    }
}
