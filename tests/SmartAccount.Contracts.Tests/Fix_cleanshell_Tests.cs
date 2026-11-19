using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the "clean shell" finding under the v4 handoff paths:
/// <c>settleMarketEscrow</c> (sale to a buyer) and <c>executeRecovery</c> (custody
/// rotation) both advertise that the resulting account is a genuinely fresh shell.
/// </summary>
/// <remarks>
/// Protocol v4 deleted the verifier/hook cleanup callback entirely: the handoff runs
/// <c>SweepAccountModulesAndPolicies</c> in-core, so a "cleanup failure" cannot strand
/// a dirty shell. These tests therefore pin two things instead: (1) the stale
/// per-account state the previous owner could leave behind — installed module
/// instances, pending configuration intents, the metadata URI and the 0x57 message
/// subjects — is gone for the new custody; and (2) the sweep never calls a plugin,
/// which is exactly why no plugin can veto or half-complete the handoff.
/// </remarks>
[TestClass]
public class Fix_CleanShell_Tests
{
    private static readonly UInt160 Seller =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Buyer =
        UInt160.Parse("0x6666666666666666666666666666666666666666");

    private static readonly UInt160 WhitelistTarget =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

    private static readonly TimeSpan RecoveryWindow =
        TimeSpan.FromMilliseconds((long)RuntimeFixture.MinRecoveryTimelockMs) + TimeSpan.FromMinutes(1);

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public UInt160 Validator { get; }

        public UInt160 Hook { get; }

        public UInt160 SpareValidator { get; }

        private int _registrations;

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Market = Fx.Deploy("SAAddressMarket");
            Validator = Fx.Deploy("validators/SessionKeyValidator", Wallet.ToArray());
            SpareValidator = Fx.Deploy("validators/P256Validator", Wallet.ToArray());
            Hook = Fx.Deploy("hooks/WhitelistHook", Wallet.ToArray());
            Fx.CallVoid(Market, "setAllowedSA", Wallet, true);
            // Phase 1b: the core admin registers the market as an approved escrow service.
            Fx.CallVoid(Wallet, "setMarketService", Market, true);
        }

        /// <summary>
        /// Registers an account owned by <paramref name="custody"/> with one validator and one
        /// configured hook installed atomically, so the handoff has modules to sweep.
        /// </summary>
        public UInt160 RegisterAccount(UInt160 custody)
        {
            _registrations += 1;
            return Fx.CreateAccount(
                Wallet,
                custody,
                RuntimeFixture.Salt("clean-shell-" + _registrations),
                RuntimeFixture.MinRecoveryTimelockMs,
                (object)Fx.InstallValidator(Validator),
                (object)Fx.InstallHook(Hook, "allowTarget", WhitelistTarget));
        }

        public BigInteger[] ValidatorIds(UInt160 accountId) =>
            Fx.ModuleIds(Wallet, accountId, RuntimeFixture.ModuleTypeNameValidator);

        public BigInteger[] HookIds(UInt160 accountId) =>
            Fx.ModuleIds(Wallet, accountId, RuntimeFixture.ModuleTypeNameHook);

        public BigInteger[] PendingIntentIds(UInt160 accountId)
        {
            Neo.VM.Types.Array ids = (Neo.VM.Types.Array)Fx.Call(
                Wallet, "getPendingConfigurationIntentIds", accountId);
            BigInteger[] result = new BigInteger[ids.Count];
            for (int i = 0; i < ids.Count; i++) result[i] = ids[i].GetInteger();
            return result;
        }

        /// <summary>
        /// Leaves an unconfirmed configuration intent behind: the v4 form of the retired
        /// pending verifier/hook call marker.
        /// </summary>
        public BigInteger ArmPendingIntent(UInt160 accountId)
        {
            return Fx.ProposeConfiguration(
                Wallet, accountId, Seller, (object)Fx.InstallValidator(SpareValidator));
        }

        public BigInteger CreateListing(UInt160 accountId)
        {
            Fx.SetSigners(Seller);
            Fx.CallVoid(Market, "createListing", Wallet, accountId, Price, "SA address", "");
            return Fx.CallInteger(Market, "getListingCount");
        }

        public void Buy(BigInteger listingId, UInt160 buyer)
        {
            Fx.FundGasFromValidators(buyer, Price * 2);
            Fx.SetSigners(buyer);
            Fx.TransferGas(buyer, Market, Price, listingId);
            Fx.CallVoid(Market, "settleListing", listingId, buyer, buyer);
        }

        public string Metadata(UInt160 accountId) =>
            Fx.Call(Wallet, "getMetadataUri", accountId).GetString();
    }

    [TestMethod]
    public void SettleMarketEscrow_HandsBuyerShellWithNoStaleMarkers()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller);

        // The seller leaves behind every kind of stale per-account marker before listing.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "setMetadataUri", accountId, "ipfs://seller-private-metadata");
        Assert.AreEqual("ipfs://seller-private-metadata", h.Metadata(accountId));
        BigInteger intentId = h.ArmPendingIntent(accountId);
        CollectionAssert.AreEqual(new[] { intentId }, h.PendingIntentIds(accountId),
            "A pending configuration intent must be armed for the test to be meaningful");
        Assert.AreEqual(1, h.ValidatorIds(accountId).Length);
        Assert.AreEqual(1, h.HookIds(accountId).Length);

        BigInteger listingId = h.CreateListing(accountId);
        h.Buy(listingId, Buyer);

        Assert.AreEqual(Buyer, h.Fx.AccountCustody(h.Wallet, accountId));

        // The buyer receives a genuinely clean shell: no inherited configuration.
        Assert.AreEqual(0, h.ValidatorIds(accountId).Length,
            "Installed validators must not survive the sale");
        Assert.AreEqual(0, h.HookIds(accountId).Length,
            "Installed hooks must not survive the sale");
        Assert.AreEqual(0, h.PendingIntentIds(accountId).Length,
            "A pending configuration intent must not survive the sale");
        Assert.AreEqual(string.Empty, h.Metadata(accountId),
            "The seller's metadata URI must not survive the sale");
        Assert.AreEqual(0, ((Neo.VM.Types.Array)h.Fx.Call(h.Wallet, "getRecoveryStatus", accountId)).Count,
            "No recovery record may be inherited");

        // And crucially the buyer is not locked out of their own recovery by the seller's
        // leftover state: the new custody can open a recovery immediately after the sale.
        h.Fx.SetSigners(Buyer);
        h.Fx.CallVoid(h.Wallet, "beginRecovery", accountId, UInt160.Zero);
        Assert.AreEqual(5, ((Neo.VM.Types.Array)h.Fx.Call(h.Wallet, "getRecoveryStatus", accountId)).Count,
            "The buyer can arm recovery with no stale-state lockout");

        // A stale intent id can never be confirmed against the swept account.
        h.Fx.SetSigners(Buyer);
        Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "confirmConfiguration", accountId, intentId,
                new object[] { (object)h.Fx.InstallValidator(h.SpareValidator) }),
            "The seller's pending intent must not be confirmable by the buyer");
    }

    [TestMethod]
    public void ExecuteRecovery_LeavesNoStaleIntentsOrMetadata()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller);

        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "setMetadataUri", accountId, "ipfs://stale-metadata");
        BigInteger intentId = h.ArmPendingIntent(accountId);
        Assert.AreEqual(1, h.PendingIntentIds(accountId).Length);

        // Run the recovery to completion. The new custody must witness its own election.
        h.Fx.SetSigners(Seller, Buyer);
        h.Fx.CallVoid(h.Wallet, "beginRecovery", accountId, Buyer);
        h.Fx.AdvanceTime(RecoveryWindow);
        h.Fx.SetSigners(Buyer);
        h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId);

        Assert.AreEqual(Buyer, h.Fx.AccountCustody(h.Wallet, accountId));
        Assert.AreEqual(0, h.ValidatorIds(accountId).Length,
            "Installed validators must be swept by recovery");
        Assert.AreEqual(0, h.HookIds(accountId).Length,
            "Installed hooks must be swept by recovery");
        Assert.AreEqual(0, h.PendingIntentIds(accountId).Length,
            "A pending configuration intent must be swept by recovery");
        Assert.AreEqual(string.Empty, h.Metadata(accountId),
            "Stale metadata URI must be cleared by recovery");

        h.Fx.SetSigners(Buyer);
        Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "confirmConfiguration", accountId, intentId,
                new object[] { (object)h.Fx.InstallValidator(h.SpareValidator) }),
            "The pre-recovery intent must not survive the sweep");
    }

    [TestMethod]
    public void Handoff_DoesNotInvokeAnyPluginCallback()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller);
        BigInteger hookId = h.HookIds(accountId)[0];
        Assert.IsTrue(h.Fx.CallBoolean(h.Hook, "isWhitelisted", accountId, hookId, WhitelistTarget),
            "The hook instance holds account-scoped state before the handoff");

        BigInteger listingId = h.CreateListing(accountId);
        h.Buy(listingId, Buyer);

        // The core's instance record is gone, but the plugin was never asked to clean up:
        // the sweep is callback-free, so no plugin can veto or half-complete the handoff.
        Assert.AreEqual(0, h.HookIds(accountId).Length);
        Assert.IsTrue(h.Fx.CallBoolean(h.Hook, "isWhitelisted", accountId, hookId, WhitelistTarget),
            "A callback-free sweep leaves plugin-owned storage untouched");
    }
}
