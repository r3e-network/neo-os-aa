using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Behavioral VM tests for the v4 market-escrow lifecycle across <c>SAAddressMarket</c>
/// and <c>SmartAccount</c> (spec §7.5): listing locks the account, execution is
/// blocked while the escrow is armed, settlement pays the seller with real GAS and
/// hands the buyer a callback-free clean shell, cancellation unlocks, and only the
/// escrow market recorded on the account may drive the unwind entries.
/// </summary>
[TestClass]
public class MarketEscrowRuntimeTests
{
    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

    private static int _sequence;

    private sealed class MarketHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public UInt160 Target { get; }

        public P256SessionKey SellerKey { get; } = new();

        public P256SessionKey BuyerKey { get; } = new();

        public P256SessionKey SessionKey { get; } = new();

        /// <summary>The seller's custody script — the market's <c>getAccount</c> custody read.</summary>
        public UInt160 Seller => RuntimeFixture.CustodyOf(SellerKey);

        public UInt160 Buyer => RuntimeFixture.CustodyOf(BuyerKey);

        public UInt160 AccountId { get; private set; } = UInt160.Zero;

        public MarketHarness(bool registerMarketService = true)
        {
            Wallet = Fx.Deploy("SmartAccount");
            Market = Fx.Deploy("SAAddressMarket");
            Target = Fx.Deploy("MockTransferTarget");
            // The market admin allowlists the genuine SA core so listings backed by it
            // are accepted; the core admin registers the market as an escrow service so
            // it may arm escrows. Both gates are required (audit Medium 3).
            Fx.CallVoid(Market, "setAllowedSA", Wallet, true);
            if (registerMarketService) Fx.CallVoid(Wallet, "setMarketService", Market, true);
        }

        /// <summary>Registers the seller's account with the given initial installs.</summary>
        public UInt160 Register(params object[] actions)
        {
            int sequence = System.Threading.Interlocked.Increment(ref _sequence);
            Fx.SetSigners(Seller);
            AccountId = Fx.CreateAccount(
                Wallet, Seller, RuntimeFixture.Salt("market-" + sequence), RuntimeFixture.MinRecoveryTimelockMs, actions);
            return AccountId;
        }

        public BigInteger CreateListing(UInt160 accountId)
        {
            Fx.SetSigners(Seller);
            Fx.CallVoid(Market, "createListing", Wallet, accountId, Price, "SA address", "");
            return Fx.CallInteger(Market, "getListingCount");
        }

        /// <summary>The v4 built-in (validatorId = 0) transfer, signed by the custody key.</summary>
        public object[] SignedTransfer(UInt160 accountId, P256SessionKey key)
        {
            UInt160 custody = RuntimeFixture.CustodyOf(key);
            var record = (Neo.VM.Types.Array)Fx.Call(Wallet, "getAccount", accountId);
            object[] op = RuntimeFixture.UserOp(
                Target, "transfer",
                new object?[] { accountId, Recipient, (BigInteger)1000, null },
                Fx.PackedNonce(Wallet, accountId, 0), Fx.Now() + 3_600_000, new byte[] { 0x00 },
                authorityEpoch: record[4].GetInteger(),
                configurationNonce: record[5].GetInteger());
            op[11] = Fx.SignBuiltIn(Wallet, accountId, op, key);
            Fx.SetSigners(custody);
            return op;
        }

        public void ExecuteTransfer(UInt160 accountId, P256SessionKey key)
        {
            object[] op = SignedTransfer(accountId, key);
            Assert.IsTrue(Fx.CallBoolean(Wallet, "executeUserOp", accountId, op));
        }

        public Neo.VM.Types.Array Modules(UInt160 accountId, string moduleType) =>
            (Neo.VM.Types.Array)((Neo.VM.Types.Array)Fx.Call(Wallet, "getModules", accountId, moduleType, (BigInteger)0, (BigInteger)16))[0];

        public UInt160 Custody(UInt160 accountId)
        {
            var record = (Neo.VM.Types.Array)Fx.Call(Wallet, "getAccount", accountId);
            return new UInt160(record[2].GetSpan());
        }

        public bool EscrowActive(UInt160 accountId) => Fx.CallBoolean(Wallet, "isMarketEscrowActive", accountId);
    }

    [TestMethod]
    public void MarketEscrow_Enter_LocksAccountAndBlocksExecution()
    {
        MarketHarness h = new();
        UInt160 accountId = h.Register();
        BigInteger listingId = h.CreateListing(accountId);

        Assert.IsTrue(h.EscrowActive(accountId), "A listing arms the escrow on the account");
        Assert.AreEqual(h.Market, h.Fx.CallUInt160(h.Wallet, "getMarketEscrowContract", accountId));
        Assert.AreEqual(listingId, h.Fx.CallInteger(h.Wallet, "getMarketEscrowListingId", accountId));

        // An escrowed account refuses user operations even from its own custody.
        object[] op = h.SignedTransfer(accountId, h.SellerKey);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(h.Wallet, "executeUserOp", accountId, op));
        StringAssert.Contains(blocked.Message, "market escrow");
    }

    [TestMethod]
    public void MarketEscrow_Settle_PaysSellerAndTransfersCleanShellToBuyer()
    {
        MarketHarness h = new();
        UInt160 accountId = h.Register();
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.FundGasFromValidators(h.Buyer, Price * 2);
        BigInteger sellerBefore = h.Fx.GasBalanceOf(h.Seller);
        BigInteger buyerBefore = h.Fx.GasBalanceOf(h.Buyer);

        // The buyer locks the exact price into the market with the listing id as data.
        h.Fx.SetSigners(h.Buyer);
        h.Fx.TransferGas(h.Buyer, h.Market, Price, listingId);
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, h.Buyer));
        Assert.AreEqual(Price, h.Fx.GasBalanceOf(h.Market), "The market escrows the payment until settlement");

        h.Fx.CallVoid(h.Market, "settleListing", listingId, h.Buyer, h.Buyer);

        Assert.AreEqual(sellerBefore + Price, h.Fx.GasBalanceOf(h.Seller), "The seller is paid the listing price");
        Assert.AreEqual(buyerBefore - Price, h.Fx.GasBalanceOf(h.Buyer), "The buyer paid exactly the listing price");
        Assert.AreEqual(BigInteger.Zero, h.Fx.GasBalanceOf(h.Market), "The market retains no GAS after settlement");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, h.Buyer));

        // The buyer received a clean shell: custody transferred, escrow cleared.
        Assert.AreEqual(h.Buyer, h.Custody(accountId), "Settlement hands the shell to the buyer");
        Assert.IsFalse(h.EscrowActive(accountId));
        Assert.AreEqual(0, h.Modules(accountId, RuntimeFixture.ModuleTypeNameValidator).Count);
        Assert.AreEqual(0, h.Modules(accountId, RuntimeFixture.ModuleTypeNameHook).Count);

        // Built-in authorization is restored, so the buyer operates immediately.
        h.ExecuteTransfer(accountId, h.BuyerKey);
    }

    [TestMethod]
    [DataRow(true, false)]
    [DataRow(false, true)]
    [DataRow(true, true)]
    public void MarketEscrow_SettleSweepsInstalledModulesAndHookOrder(bool validator, bool hook)
    {
        MarketHarness h = new();
        object[] installs = new object[0];
        if (validator)
        {
            UInt160 session = h.Fx.Deploy("validators/SessionKeyValidator", h.Wallet.ToArray());
            object?[] grant =
            {
                "setSessionKey", h.SessionKey.CompressedPublicKey, h.Target, "transfer",
                h.Fx.Now() + 3_600_000, (BigInteger)0, "market sweep"
            };
            installs = new object[] { h.Fx.InstallValidator(session, grant) };
        }
        if (hook)
        {
            UInt160 whitelist = h.Fx.Deploy("hooks/WhitelistHook", h.Wallet.ToArray());
            installs = installs.Concat(new object[] { h.Fx.InstallHook(whitelist, "allowTarget", h.Target) }).ToArray();
        }

        UInt160 accountId = h.Register(installs);
        Assert.AreEqual(validator ? 1 : 0, h.Modules(accountId, RuntimeFixture.ModuleTypeNameValidator).Count);
        Assert.AreEqual(hook ? 1 : 0, h.Modules(accountId, RuntimeFixture.ModuleTypeNameHook).Count);

        BigInteger listingId = h.CreateListing(accountId);
        h.Fx.FundGasFromValidators(h.Buyer, Price * 2);
        h.Fx.SetSigners(h.Buyer);
        h.Fx.TransferGas(h.Buyer, h.Market, Price, listingId);
        BigInteger sellerBefore = h.Fx.GasBalanceOf(h.Seller);

        h.Fx.CallVoid(h.Market, "settleListing", listingId, h.Buyer, h.Buyer);

        Assert.AreEqual(sellerBefore + Price, h.Fx.GasBalanceOf(h.Seller));
        Assert.AreEqual(h.Buyer, h.Custody(accountId));
        Assert.IsFalse(h.EscrowActive(accountId));
        // The sweep is complete: no instance survives, and the hook order is gone.
        Assert.AreEqual(0, h.Modules(accountId, RuntimeFixture.ModuleTypeNameValidator).Count,
            "No validator instance may survive settlement");
        Assert.AreEqual(0, h.Modules(accountId, RuntimeFixture.ModuleTypeNameHook).Count,
            "No hook instance may survive settlement");
        Assert.AreEqual(0, ((Neo.VM.Types.Array)((Neo.VM.Types.Array)h.Fx.Call(h.Wallet, "getHookOrder", accountId))[0]).Count,
            "The hook order must not survive settlement");
        h.ExecuteTransfer(accountId, h.BuyerKey);
    }

    [TestMethod]
    public void MarketEscrow_SettleIsCallbackFreeSoAFaultingModuleCannotBlockIt()
    {
        // The retired escrow unwind called every leaf module's cleanup callback, so one
        // faulty child could block a sale (and the payment with it). The v4 sweep is
        // callback-free by construction: a hook that rejects every routed operation
        // must not be able to veto the settlement.
        MarketHarness h = new();
        UInt160 whitelist = h.Fx.Deploy("hooks/WhitelistHook", h.Wallet.ToArray());
        // The hook is installed and armed for a different target only, so a routed
        // operation to the transfer target is refused by the hook's preCheck.
        UInt160 accountId = h.Register(new object[] { h.Fx.InstallHook(whitelist, "allowTarget", h.Market) });

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(h.Wallet, "executeUserOp", accountId, h.SignedTransfer(accountId, h.SellerKey)));
        StringAssert.Contains(rejected.Message, "Target contract not in whitelist");

        BigInteger listingId = h.CreateListing(accountId);
        h.Fx.FundGasFromValidators(h.Buyer, Price * 2);
        BigInteger sellerBefore = h.Fx.GasBalanceOf(h.Seller);
        h.Fx.SetSigners(h.Buyer);
        h.Fx.TransferGas(h.Buyer, h.Market, Price, listingId);

        h.Fx.CallVoid(h.Market, "settleListing", listingId, h.Buyer, h.Buyer);

        Assert.AreEqual(sellerBefore + Price, h.Fx.GasBalanceOf(h.Seller));
        Assert.AreEqual(h.Buyer, h.Custody(accountId));
        Assert.AreEqual(0, h.Modules(accountId, RuntimeFixture.ModuleTypeNameHook).Count,
            "The rejecting hook is swept, not consulted");
        h.ExecuteTransfer(accountId, h.BuyerKey);
    }

    [TestMethod]
    public void MarketEscrow_Cancel_UnlocksAccountForSeller()
    {
        MarketHarness h = new();
        UInt160 accountId = h.Register();
        BigInteger listingId = h.CreateListing(accountId);
        Assert.IsTrue(h.EscrowActive(accountId));

        h.Fx.SetSigners(h.Seller);
        h.Fx.CallVoid(h.Market, "cancelListing", listingId);

        Assert.IsFalse(h.EscrowActive(accountId));
        Assert.AreEqual(h.Seller, h.Custody(accountId), "Cancellation keeps the seller in control");
        h.ExecuteTransfer(accountId, h.SellerKey);
    }

    [TestMethod]
    public void MarketEscrow_SettleWithoutLockedPayment_Faults()
    {
        MarketHarness h = new();
        UInt160 accountId = h.Register();
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.SetSigners(h.Buyer);
        TestException mismatch = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "settleListing", listingId, h.Buyer, h.Buyer));
        StringAssert.Contains(mismatch.Message, "Pending payment mismatch");
    }

    [TestMethod]
    public void MarketEscrow_OnlyEscrowMarketMayCancelOrSettleOnWallet()
    {
        MarketHarness h = new();
        UInt160 accountId = h.Register();
        BigInteger listingId = h.CreateListing(accountId);

        // Direct calls to the wallet from anyone but the recorded escrow market must
        // fault, even with the custody witness attached.
        h.Fx.SetSigners(h.Seller);
        TestException cancelBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "cancelMarketEscrow", accountId, listingId));
        StringAssert.Contains(cancelBlocked.Message, "Only escrow market");

        TestException settleBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "settleMarketEscrow", accountId, listingId, h.Buyer));
        StringAssert.Contains(settleBlocked.Message, "Only escrow market");
    }

    [TestMethod]
    public void MarketEscrow_Enter_RejectsMarketNeverRegisteredByTheCoreAdmin()
    {
        // Audit Medium 3: the 0x29 registration gate must be reachable as a rejection.
        // The market allowlists the core on its own side, but the core admin never
        // registers the market, so createListing must be refused before any escrow
        // state is armed.
        MarketHarness h = new(registerMarketService: false);
        UInt160 accountId = h.Register();

        TestException unregistered = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "createListing", h.Wallet, accountId, Price, "SA address", ""));
        StringAssert.Contains(unregistered.Message, "Market service not registered");
        Assert.IsFalse(h.EscrowActive(accountId), "An unregistered market must not be able to arm an escrow");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getListingCount"));
    }

    [TestMethod]
    public void MarketEscrow_Enter_RejectsCoreAsMarketContractRoutedByUserOp()
    {
        // Audit Medium 3: an ordinary user operation cannot lend the core's calling
        // identity to arm an escrow naming the core itself as the market contract.
        // The configuration boundary fires first: executeUserOp pins the account's
        // execution context for the whole operation, so EnterMarketEscrow is refused
        // there before any escrow state is written.
        MarketHarness h = new();
        UInt160 accountId = h.Register();

        object[] op = RuntimeFixture.UserOp(
            h.Wallet, "enterMarketEscrow",
            new object?[] { accountId, h.Wallet, (BigInteger)1 },
            h.Fx.PackedNonce(h.Wallet, accountId, 0), h.Fx.Now() + 3_600_000, new byte[] { 0x00 },
            configurationNonce: h.Fx.AccountConfigurationNonce(h.Wallet, accountId));
        op[11] = h.Fx.SignBuiltIn(h.Wallet, accountId, op, h.SellerKey);
        h.Fx.SetSigners(h.Seller);

        TestException routed = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "executeUserOp", accountId, op));
        StringAssert.Contains(routed.Message, "Account configuration context active",
            "A user operation is mid-execution and must not be able to arm an escrow on its own account");
        Assert.IsFalse(h.EscrowActive(accountId), "The core itself must never be armable as an escrow market");
        Assert.AreEqual(BigInteger.Zero,
            RuntimeFixture.NonceSequence(h.Fx.PackedNonce(h.Wallet, accountId, 0)),
            "A rejected escrow arm must not consume the sequence");

        // On the idle path (no operation in flight) the caller gate refuses the same
        // payload: the invocation's caller is not the core.
        TestException direct = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "enterMarketEscrow", accountId, h.Wallet, (BigInteger)1));
        StringAssert.Contains(direct.Message, "Caller is not the market");
        Assert.IsFalse(h.EscrowActive(accountId));
    }
}
