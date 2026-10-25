using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Behavioral VM tests for the market-escrow lifecycle across <c>AAAddressMarket</c> and
/// <c>UnifiedSmartWalletV3</c>: listing locks the account, escrow blocks execution, settlement
/// pays the seller with real GAS and hands the buyer a clean shell, cancellation unlocks, and
/// only the escrow market contract may drive the wallet's escrow transitions.
/// </summary>
[TestClass]
public class MarketEscrowRuntimeTests
{
    private static readonly UInt160 Seller =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Buyer =
        UInt160.Parse("0x6666666666666666666666666666666666666666");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

    private sealed class MarketHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public UInt160 Target { get; }

        public MarketHarness()
        {
            Wallet = Fx.Deploy("UnifiedSmartWalletV3");
            Market = Fx.Deploy("AAAddressMarket");
            Target = Fx.Deploy("MockTransferTarget");
            // The market admin (the deploying validators account) allowlists the genuine AA core
            // so escrow listings backed by it are accepted. Signers are the validators by default.
            Fx.CallVoid(Market, "setAllowedAA", Wallet, true);
        }

        public UInt160 RegisterAccount(UInt160 backupOwner, uint escapeTimelock)
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, backupOwner, escapeTimelock);

            Fx.SetSigners(backupOwner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, backupOwner, escapeTimelock);
            return accountId;
        }

        public BigInteger CreateListing(UInt160 accountId)
        {
            Fx.SetSigners(Seller);
            Fx.CallVoid(Market, "createListing", Wallet, accountId, Price, "AA address", "");
            return Fx.CallInteger(Market, "getListingCount");
        }

        public void ExecuteTransferOp(UInt160 accountId, UInt160 owner, BigInteger nonce)
        {
            Fx.SetSigners(owner);
            object[] op = RuntimeFixture.UserOp(
                Target, "transfer",
                new object?[] { accountId, Recipient, (BigInteger)1000, null },
                nonce, Fx.Now() + 3_600_000, Array.Empty<byte>());
            Assert.IsTrue(Fx.CallBoolean(Wallet, "executeUserOp", accountId, op));
        }
    }

    [TestMethod]
    public void MarketEscrow_Enter_LocksAccountAndBlocksExecution()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.AreEqual(h.Market, h.Fx.CallUInt160(h.Wallet, "getMarketEscrowContract", accountId));
        Assert.AreEqual(listingId, h.Fx.CallInteger(h.Wallet, "getMarketEscrowListingId", accountId));

        // Escrowed accounts must refuse user operations even from the backup owner.
        h.Fx.SetSigners(Seller);
        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer",
            new object?[] { accountId, Recipient, (BigInteger)1000, null },
            0, h.Fx.Now() + 3_600_000, Array.Empty<byte>());
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(h.Wallet, "executeUserOp", accountId, op));
        StringAssert.Contains(blocked.Message, "Account locked in market escrow");
    }

    [TestMethod]
    public void MarketEscrow_Settle_PaysSellerAndTransfersCleanShellToBuyer()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        BigInteger sellerBefore = h.Fx.GasBalanceOf(Seller);
        BigInteger buyerBefore = h.Fx.GasBalanceOf(Buyer);

        // Buyer locks the exact price into the market with the listing id as transfer data.
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));
        Assert.AreEqual(Price, h.Fx.GasBalanceOf(h.Market), "Market escrows the payment until settlement");

        h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer);

        // Balances: the seller received exactly the price, the market keeps nothing.
        Assert.AreEqual(sellerBefore + Price, h.Fx.GasBalanceOf(Seller), "Seller is paid the listing price");
        Assert.AreEqual(buyerBefore - Price, h.Fx.GasBalanceOf(Buyer), "Buyer paid exactly the listing price");
        Assert.AreEqual(BigInteger.Zero, h.Fx.GasBalanceOf(h.Market), "Market retains no GAS after settlement");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));

        // The buyer received a clean shell: new backup owner, no inherited modules, unlocked.
        Assert.AreEqual(Buyer, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId));
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId));
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getHook", accountId));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));

        // And the buyer controls it through the native fallback path.
        h.ExecuteTransferOp(accountId, Buyer, nonce: 0);
    }

    [TestMethod]
    [DataRow(true, false, false)]
    [DataRow(false, true, false)]
    [DataRow(true, true, false)]
    [DataRow(true, false, true)]
    [DataRow(false, true, true)]
    [DataRow(true, true, true)]
    public void MarketEscrow_SettleCompositeRoots_CleansLeavesAndTransfersShell(bool verifier, bool hook, bool legacy)
    {
        MarketHarness h = new();
        UInt160 rootVerifier = verifier ? h.Fx.Deploy("verifiers/MultiSigVerifier", h.Wallet.ToArray()) : UInt160.Zero;
        UInt160 rootHook = hook ? h.Fx.Deploy("hooks/MultiHook", h.Wallet.ToArray()) : UInt160.Zero;
        UInt160 native = verifier ? h.Fx.Deploy("verifiers/NeoNativeVerifier", h.Wallet.ToArray()) : UInt160.Zero;
        UInt160 whitelist = hook ? h.Fx.Deploy("hooks/WhitelistHook", h.Wallet.ToArray()) : UInt160.Zero;
        UInt160 account = h.Fx.CallUInt160(h.Wallet, "computeRegistrationAccountId",
            rootVerifier, Array.Empty<byte>(), rootHook, Seller, 604800u);
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "registerAccount", account, rootVerifier, Array.Empty<byte>(), rootHook, Seller, 604800u);

        void Configure(string entry, params object[] args)
        {
            Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, entry, args));
            h.Fx.AdvanceTime(TimeSpan.FromHours(24));
            h.Fx.CallVoid(h.Wallet, entry, args);
        }
        if (verifier)
        {
            Configure("callVerifier", account, "setConfig", new object[] { account, new[] { native }, 1 });
            Configure("callVerifierChild", account, native, "setConfig", new object[] { account, new[] { Seller }, 1 });
            Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(native, "getThreshold", account));
        }
        if (hook)
        {
            Configure("callHook", account, "setHooks", new object[] { account, new[] { whitelist } });
            Configure("callHookChild", account, whitelist, "setWhitelist", new object[] { account, h.Target, true });
            Assert.IsTrue(h.Fx.CallBoolean(whitelist, "isWhitelisted", account, h.Target));
        }

        var state = (Neo.VM.Types.Array)h.Fx.Call(UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"), "getContract", h.Wallet);
        StorageKey Key(byte prefix) => new() { Id = (int)state[0].GetInteger(), Key = new[] { prefix }.Concat(account.ToArray()).ToArray() };
        if (legacy)
        {
            h.Fx.Engine.Storage.Snapshot.Delete(Key(0x22));
            h.Fx.Engine.Storage.Snapshot.Delete(Key(0x23));
        }

        BigInteger listing = h.CreateListing(account);
        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listing);
        BigInteger sellerBefore = h.Fx.GasBalanceOf(Seller);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", account));
        TestException stranger = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Wallet, "settleMarketEscrow", account, listing, Buyer));
        StringAssert.Contains(stranger.Message, "Only escrow market");
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listing, Buyer));

        h.Fx.CallVoid(h.Market, "settleListing", listing, Buyer, Buyer);

        Assert.AreEqual(sellerBefore + Price, h.Fx.GasBalanceOf(Seller));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listing, Buyer));
        Assert.AreEqual(Buyer, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", account));
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getVerifier", account));
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getHook", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", account));
        if (verifier)
        {
            Assert.IsTrue(h.Fx.Call(rootVerifier, "getConfig", account).IsNull);
            Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(native, "getThreshold", account));
        }
        if (hook)
        {
            Assert.AreEqual(0, ((Neo.VM.Types.Array)h.Fx.Call(rootHook, "getHooks", account)).Count);
            Assert.IsFalse(h.Fx.CallBoolean(whitelist, "isWhitelisted", account, h.Target));
        }
        foreach (byte prefix in new byte[] { 0x04, 0x05, 0x22, 0x23, 0x24 })
            Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(Key(prefix)), "No dependency or configuration authority may survive settlement.");
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(new StorageKey { Id = (int)state[0].GetInteger(), Key = new byte[] { 0x20 } }));
        h.ExecuteTransferOp(account, Buyer, 0);
    }

    [TestMethod]
    public void MarketEscrow_CompositeLeafCleanupFault_RollsBackEarlierCleanupAndPayment()
    {
        MarketHarness h = new();
        UInt160 root = h.Fx.Deploy("verifiers/MultiSigVerifier", h.Wallet.ToArray());
        UInt160 native = h.Fx.Deploy("verifiers/NeoNativeVerifier", h.Wallet.ToArray());
        // The wrong core binding deliberately faults the second leaf cleanup, after the first leaf was cleared.
        UInt160 foreign = h.Fx.Deploy("verifiers/Web3AuthVerifier", h.Target.ToArray());
        UInt160 account = h.Fx.CallUInt160(h.Wallet, "computeRegistrationAccountId", root, Array.Empty<byte>(), UInt160.Zero, Seller, 604800u);
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "registerAccount", account, root, Array.Empty<byte>(), UInt160.Zero, Seller, 604800u);
        object[] topology = { account, new[] { native, foreign }, 1 };
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "callVerifier", account, "setConfig", topology));
        h.Fx.AdvanceTime(TimeSpan.FromHours(24));
        h.Fx.CallVoid(h.Wallet, "callVerifier", account, "setConfig", topology);
        object[] config = { account, new[] { Seller }, 1 };
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "callVerifierChild", account, native, "setConfig", config));
        h.Fx.AdvanceTime(TimeSpan.FromHours(24));
        h.Fx.CallVoid(h.Wallet, "callVerifierChild", account, native, "setConfig", config);
        BigInteger listing = h.CreateListing(account);
        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listing);
        BigInteger sellerBefore = h.Fx.GasBalanceOf(Seller), marketBefore = h.Fx.GasBalanceOf(h.Market);

        TestException fault = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Market, "settleListing", listing, Buyer, Buyer));
        StringAssert.Contains(fault.Message, "Unauthorized caller");
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(native, "getThreshold", account));
        var restored = (Neo.VM.Types.Array)h.Fx.Call(root, "getConfig", account);
        Assert.AreEqual(2, ((Neo.VM.Types.Array)restored[0]).Count);
        Assert.AreEqual(root, h.Fx.CallUInt160(h.Wallet, "getVerifier", account));
        Assert.AreEqual(Seller, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", account));
        Assert.AreEqual(sellerBefore, h.Fx.GasBalanceOf(Seller));
        Assert.AreEqual(marketBefore, h.Fx.GasBalanceOf(h.Market));
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listing, Buyer));
        var state = (Neo.VM.Types.Array)h.Fx.Call(UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"), "getContract", h.Wallet);
        StorageKey Key(byte prefix) => new() { Id = (int)state[0].GetInteger(), Key = new[] { prefix }.Concat(account.ToArray()).ToArray() };
        Assert.IsNotNull(h.Fx.Engine.Storage.Snapshot.TryGet(Key(0x22)), "Rollback must preserve the old dependency registry.");
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(Key(0x04)));
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(Key(0x24)));
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(new StorageKey { Id = (int)state[0].GetInteger(), Key = new byte[] { 0x20 } }));
        h.Fx.CallVoid(h.Market, "refundPendingPayment", listing, Buyer);
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listing, Buyer));
    }

    [TestMethod]
    public void MarketEscrow_Cancel_UnlocksAccountForSeller()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));

        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Market, "cancelListing", listingId);

        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.AreEqual(Seller, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId), "Cancel keeps the seller in control");
        h.ExecuteTransferOp(accountId, Seller, nonce: 0);
    }

    [TestMethod]
    public void MarketEscrow_SettleWithoutLockedPayment_Faults()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.SetSigners(Buyer);
        TestException mismatch = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer));
        StringAssert.Contains(mismatch.Message, "Pending payment mismatch");
    }

    [TestMethod]
    public void MarketEscrow_OnlyEscrowMarketMayCancelOrSettleOnWallet()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        // Direct calls to the wallet from anyone other than the escrow market must fault,
        // even with the seller's witness attached.
        h.Fx.SetSigners(Seller);
        TestException cancelBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "cancelMarketEscrow", accountId, listingId));
        StringAssert.Contains(cancelBlocked.Message, "Only escrow market");

        TestException settleBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "settleMarketEscrow", accountId, listingId, Buyer));
        StringAssert.Contains(settleBlocked.Message, "Only escrow market");
    }
}
