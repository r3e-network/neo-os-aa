using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Native;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Confused-deputy regression suite for <c>SmartAccount.executeUserOp</c> (spec §3.6).
/// </summary>
/// <remarks>
/// One core contract backs every virtual account, so the target of a user operation always
/// observes the same <c>Runtime.CallingScriptHash</c> no matter which account authorized the
/// call. A contract that authorizes on "the caller is the SA core" therefore cannot tell one
/// account from another, and the core must not lend that identity to an operation's target.
///
/// In v4 there is no verifier callback to register: an account is custody‖salt (spec §16.1),
/// its custody key signs the built-in envelope (<c>validatorId = 0</c>, spec §8), and the core
/// refuses protocol-owned native targets up front. Each test below drives a real compiled core
/// with an ordinary, correctly signed operation whose target is one of those caller-identity
/// gates, so a pass means the gate itself held.
/// </remarks>
[TestClass]
public class Fix_confuseddeputy_Tests
{
    private static readonly UInt160 Victim =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 AttackerRelay =
        UInt160.Parse("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    private static readonly UInt160 Sponsor =
        UInt160.Parse("0x7777777777777777777777777777777777777777");

    private const long OneGas = 100_000_000;

    private const byte ListingStatusActive = 1;

    private const int ListingStatusIndex = 7;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        private int _registrations;

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
        }

        /// <summary>
        /// Registers a v4 account (identity = custody‖salt) with the given custody. A plain
        /// address is enough when the account only receives direct, witness-authorized calls;
        /// a key-derived custody is required for built-in user operations.
        /// </summary>
        public UInt160 RegisterAccount(UInt160 custody)
        {
            _registrations += 1;
            return Fx.CreateAccount(Wallet, custody, "deputy-" + _registrations);
        }

        public UInt160 RegisterAccount(P256SessionKey custodyKey) =>
            RegisterAccount(RuntimeFixture.CustodyOf(custodyKey));

        /// <summary>
        /// Submits one fully authorized built-in operation (validatorId 0, spec §8): the
        /// custody key signs the operation digest envelope, exactly as a real owner would.
        /// </summary>
        public void ExecuteAs(
            P256SessionKey custodyKey, UInt160 accountId, UInt160 target, string method, params object?[] args)
        {
            object[] op = RuntimeFixture.UserOp(
                target, method, args,
                Fx.PackedNonce(Wallet, accountId, 0), Fx.Now() + 3_600_000, new byte[] { 0x00 });
            op[11] = Fx.SignBuiltIn(Wallet, accountId, op, custodyKey);
            Fx.SetSigners(RuntimeFixture.CustodyOf(custodyKey));
            Fx.CallVoid(Wallet, "executeUserOp", accountId, op);
        }

        public UInt160 CustodyOf(UInt160 accountId) => Fx.AccountCustody(Wallet, accountId);

        public byte[] DeployedScript(UInt160 contract)
        {
            ContractState? state = NativeContract.ContractManagement.GetContract(Fx.Engine.Storage.Snapshot, contract);
            Assert.IsNotNull(state, "Contract must remain deployed");
            return state!.Script.ToArray();
        }
    }

    /// <summary>
    /// A replacement artifact that keeps the core's manifest name (the only identity
    /// <c>ContractManagement.update</c> enforces) and answers <c>verify</c> with true for
    /// every account, which is the proxy witness that guards each account's assets.
    /// </summary>
    private static (byte[] Nef, string Manifest) BuildAlwaysTrueVerifyArtifact()
    {
        NefFile nef = new()
        {
            Compiler = "confused-deputy-probe",
            Source = string.Empty,
            Tokens = System.Array.Empty<MethodToken>(),
            Script = new byte[] { (byte)OpCode.DROP, (byte)OpCode.PUSHT, (byte)OpCode.RET },
        };
        nef.CheckSum = NefFile.ComputeChecksum(nef);

        const string manifest =
            "{\"name\":\"SmartAccount\",\"groups\":[],\"features\":{},\"supportedstandards\":[],"
            + "\"abi\":{\"methods\":[{\"name\":\"verify\",\"parameters\":[{\"name\":\"accountId\",\"type\":\"Hash160\"}],"
            + "\"returntype\":\"Boolean\",\"offset\":0,\"safe\":true}],\"events\":[]},"
            + "\"permissions\":[{\"contract\":\"*\",\"methods\":\"*\"}],\"trusts\":[],\"extra\":null}";

        return (nef.ToArray(), manifest);
    }

    [TestMethod]
    public void ExecuteUserOp_CannotReplaceCoreBytecodeThroughContractManagement()
    {
        using P256SessionKey attacker = new();
        Harness h = new();
        UInt160 victimAccount = h.RegisterAccount(Victim);
        UInt160 attackerAccount = h.RegisterAccount(attacker);
        byte[] scriptBefore = h.DeployedScript(h.Wallet);
        (byte[] nef, string manifest) = BuildAlwaysTrueVerifyArtifact();

        TestException ex = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteAs(attacker, attackerAccount, NativeContract.ContractManagement.Hash, "update", nef, manifest),
            "An account operation must not be able to upgrade the shared core");
        StringAssert.Contains(ex.Message, "Operation target cannot be ContractManagement");

        CollectionAssert.AreEqual(scriptBefore, h.DeployedScript(h.Wallet),
            "The core bytecode must only change through the timelocked admin upgrade");
        Assert.AreEqual(Victim, h.CustodyOf(victimAccount),
            "Unrelated accounts must keep their recorded custody");
    }

    [TestMethod]
    public void ExecuteUserOp_CannotDestroyCoreThroughContractManagement()
    {
        using P256SessionKey attacker = new();
        Harness h = new();
        UInt160 victimAccount = h.RegisterAccount(Victim);
        UInt160 attackerAccount = h.RegisterAccount(attacker);
        byte[] scriptBefore = h.DeployedScript(h.Wallet);

        TestException ex = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteAs(attacker, attackerAccount, NativeContract.ContractManagement.Hash, "destroy"),
            "An account operation must not be able to destroy the shared core");
        StringAssert.Contains(ex.Message, "Operation target cannot be ContractManagement");

        CollectionAssert.AreEqual(scriptBefore, h.DeployedScript(h.Wallet));
        Assert.AreEqual(Victim, h.CustodyOf(victimAccount));
    }

    [TestMethod]
    public void ExecuteUserOp_CannotSettlePaymasterReimbursementWithoutSponsoredExecution()
    {
        using P256SessionKey attacker = new();
        Harness h = new();
        UInt160 paymaster = h.Fx.Deploy("SAPaymaster", h.Wallet.ToArray());
        BigInteger deposit = 5 * OneGas;
        h.Fx.FundGasFromValidators(Sponsor, deposit * 2);
        h.Fx.SetSigners(Sponsor);
        h.Fx.TransferGas(Sponsor, paymaster, deposit, null);
        // A global policy: the sponsor offers to cover any account's operations, bounded per
        // operation and by finite daily and lifetime budgets.
        h.Fx.CallVoid(paymaster, "setPolicy",
            UInt160.Zero, UInt160.Zero, "", (BigInteger)OneGas, deposit, deposit, BigInteger.Zero);

        UInt160 attackerAccount = h.RegisterAccount(attacker);
        BigInteger relayBefore = h.Fx.GasBalanceOf(AttackerRelay);

        TestException ex = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteAs(attacker, attackerAccount, paymaster, "settleReimbursement",
                Sponsor, attackerAccount, UInt160.Zero, "", AttackerRelay, (BigInteger)OneGas),
            "Settlement must only follow a sponsored execution, never an ordinary operation");
        // The core's execution-in-flight marker is what the paymaster reads: a core-routed
        // operation is indistinguishable from the sponsored unwind on caller identity alone.
        StringAssert.Contains(ex.Message, "Settlement must follow a completed sponsored execution");

        Assert.AreEqual(deposit, h.Fx.CallInteger(paymaster, "getSponsorDeposit", Sponsor),
            "The sponsor deposit must be untouched");
        Assert.AreEqual(relayBefore, h.Fx.GasBalanceOf(AttackerRelay),
            "No reimbursement may reach an address the operation named itself");
    }

    [TestMethod]
    public void ExecuteUserOp_CannotAbandonAnotherAccountsMarketListing()
    {
        using P256SessionKey attacker = new();
        Harness h = new();
        UInt160 market = h.Fx.Deploy("SAAddressMarket");
        h.Fx.CallVoid(market, "setAllowedSA", h.Wallet, true);
        // Phase 1b: the core admin (the deploying validators account) registers the
        // market as an approved escrow service.
        h.Fx.CallVoid(h.Wallet, "setMarketService", market, true);

        UInt160 victimAccount = h.RegisterAccount(Victim);
        h.Fx.SetSigners(Victim);
        h.Fx.CallVoid(market, "createListing", h.Wallet, victimAccount, (BigInteger)OneGas, "SA address", "");
        BigInteger listingId = h.Fx.CallInteger(market, "getListingCount");

        UInt160 attackerAccount = h.RegisterAccount(attacker);

        TestException ex = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteAs(attacker, attackerAccount, market, "abandonListing", victimAccount, listingId),
            "Only the core's own escrow unwind may retire a listing");
        StringAssert.Contains(ex.Message, "Account is still locked in market escrow");

        Neo.VM.Types.Array listing = (Neo.VM.Types.Array)h.Fx.Call(market, "getListing", listingId);
        Assert.AreEqual((BigInteger)ListingStatusActive, listing[ListingStatusIndex].GetInteger(),
            "The victim's listing must stay Active");
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", victimAccount));
    }

    [TestMethod]
    public void NestedDifferentAccountExecutionIsRefusedBeforeTheMarkerCanBeCleared()
    {
        // §3.6: an account lease is exclusive for the whole invocation, so a
        // nested executeUserOp for a different account is cross-account recursion
        // and faults with SA_REENTRANCY_FORBIDDEN. The outer frame never reaches
        // its marker probe, the inner account never opens an execution, and no
        // nonce is consumed on either account.
        using P256SessionKey custody = new();
        Harness h = new();
        UInt160 probe = h.Fx.Deploy("MockVerifierCore");
        UInt160 outerAccount = h.RegisterAccount(custody);
        UInt160 innerAccount = h.RegisterAccount(custody);

        // The inner operation is a benign read on the core itself; the outer
        // operation's target (MockVerifierCore.forwardAfter) tries that nested
        // execution and then queries the marker.
        object[] innerOp = RuntimeFixture.UserOp(
            h.Wallet, "isExecutionActive", new object?[] { innerAccount },
            h.Fx.PackedNonce(h.Wallet, innerAccount, 0), h.Fx.Now() + 3_600_000, new byte[] { 0x00 });
        innerOp[11] = h.Fx.SignBuiltIn(h.Wallet, innerAccount, innerOp, custody);

        object[] outerOp = RuntimeFixture.UserOp(
            probe, "forwardAfter",
            new object?[]
            {
                h.Wallet, "executeUserOp", new object?[] { innerAccount, innerOp },
                h.Wallet, "isUserOpExecutionActive", Array.Empty<object>()
            },
            h.Fx.PackedNonce(h.Wallet, outerAccount, 0), h.Fx.Now() + 3_600_000, new byte[] { 0x00 });
        outerOp[11] = h.Fx.SignBuiltIn(h.Wallet, outerAccount, outerOp, custody);

        h.Fx.SetSigners(RuntimeFixture.CustodyOf(custody));
        TestException ex = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallBoolean(h.Wallet, "executeUserOp", outerAccount, outerOp),
            "A nested frame for another account must be refused, not granted a depth");
        StringAssert.Contains(ex.Message, "SA_REENTRANCY_FORBIDDEN");

        // The refused nested frame rolls the whole invocation back: the marker is
        // clear again and neither sequence advanced.
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isUserOpExecutionActive"));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isExecutionActive", outerAccount));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isExecutionActive", innerAccount));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Wallet, outerAccount, 0));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Wallet, innerAccount, 0));
    }
}
