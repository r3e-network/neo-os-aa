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
/// Confused-deputy regression suite for <c>SmartAccountV3.ExecuteUserOp</c>.
/// </summary>
/// <remarks>
/// One core contract backs every virtual account, so the target of a user operation always
/// observes the same <c>Runtime.CallingScriptHash</c> no matter which account authorized the
/// call. A contract that authorizes on "the caller is the AA core" therefore cannot tell one
/// account from another, and the core must not lend that identity to an operation's target.
/// Each test drives a real compiled core with an ordinary, correctly authorized user
/// operation whose target is one of those caller-identity gates.
/// </remarks>
[TestClass]
public class Fix_confuseddeputy_Tests
{
    private static readonly UInt160 Victim =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Attacker =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly UInt160 AttackerRelay =
        UInt160.Parse("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    private static readonly UInt160 Sponsor =
        UInt160.Parse("0x7777777777777777777777777777777777777777");

    private const uint EscapeTimelockSeconds = 2_592_000;

    private const long OneGas = 100_000_000;

    private const byte ListingStatusActive = 1;

    private const int ListingStatusIndex = 7;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccountV3");
        }

        /// <summary>Registers a verifier-less account, so the backup owner's witness authorizes operations.</summary>
        public UInt160 RegisterAccount(UInt160 backupOwner)
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, backupOwner, EscapeTimelockSeconds);

            Fx.SetSigners(backupOwner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, backupOwner, EscapeTimelockSeconds);
            return accountId;
        }

        /// <summary>Submits one fully authorized user operation for <paramref name="owner"/>'s own account.</summary>
        public void ExecuteAs(UInt160 owner, UInt160 accountId, UInt160 target, string method, params object?[] args)
        {
            Fx.SetSigners(owner);
            BigInteger nonce = Fx.CallInteger(Wallet, "getNonce", accountId, BigInteger.Zero);
            object[] op = RuntimeFixture.UserOp(
                target, method, args, nonce, Fx.Now() + 3_600_000, Array.Empty<byte>());
            Fx.CallVoid(Wallet, "executeUserOp", accountId, op);
        }

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
            "{\"name\":\"SmartAccountV3\",\"groups\":[],\"features\":{},\"supportedstandards\":[],"
            + "\"abi\":{\"methods\":[{\"name\":\"verify\",\"parameters\":[{\"name\":\"accountId\",\"type\":\"Hash160\"}],"
            + "\"returntype\":\"Boolean\",\"offset\":0,\"safe\":true}],\"events\":[]},"
            + "\"permissions\":[{\"contract\":\"*\",\"methods\":\"*\"}],\"trusts\":[],\"extra\":null}";

        return (nef.ToArray(), manifest);
    }

    [TestMethod]
    public void ExecuteUserOp_CannotReplaceCoreBytecodeThroughContractManagement()
    {
        Harness h = new();
        UInt160 victimAccount = h.RegisterAccount(Victim);
        UInt160 attackerAccount = h.RegisterAccount(Attacker);
        byte[] scriptBefore = h.DeployedScript(h.Wallet);
        (byte[] nef, string manifest) = BuildAlwaysTrueVerifyArtifact();

        Assert.ThrowsExactly<TestException>(
            () => h.ExecuteAs(Attacker, attackerAccount, NativeContract.ContractManagement.Hash, "update", nef, manifest),
            "An account operation must not be able to upgrade the shared core");

        CollectionAssert.AreEqual(scriptBefore, h.DeployedScript(h.Wallet),
            "The core bytecode must only change through the timelocked admin upgrade");
        Assert.AreEqual(Victim, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", victimAccount),
            "Unrelated accounts must keep their recorded authority");
    }

    [TestMethod]
    public void ExecuteUserOp_CannotDestroyCoreThroughContractManagement()
    {
        Harness h = new();
        UInt160 victimAccount = h.RegisterAccount(Victim);
        UInt160 attackerAccount = h.RegisterAccount(Attacker);
        byte[] scriptBefore = h.DeployedScript(h.Wallet);

        Assert.ThrowsExactly<TestException>(
            () => h.ExecuteAs(Attacker, attackerAccount, NativeContract.ContractManagement.Hash, "destroy"),
            "An account operation must not be able to destroy the shared core");

        CollectionAssert.AreEqual(scriptBefore, h.DeployedScript(h.Wallet));
        Assert.AreEqual(Victim, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", victimAccount));
    }

    [TestMethod]
    public void ExecuteUserOp_CannotSettlePaymasterReimbursementWithoutSponsoredExecution()
    {
        Harness h = new();
        UInt160 paymaster = h.Fx.Deploy("AAPaymaster", h.Wallet.ToArray());
        BigInteger deposit = 5 * OneGas;
        h.Fx.FundGasFromValidators(Sponsor, deposit * 2);
        h.Fx.SetSigners(Sponsor);
        h.Fx.TransferGas(Sponsor, paymaster, deposit, null);
        // A global policy: the sponsor offers to cover any account's operations, bounded per
        // operation and by finite daily and lifetime budgets.
        h.Fx.CallVoid(paymaster, "setPolicy",
            UInt160.Zero, UInt160.Zero, "", (BigInteger)OneGas, deposit, deposit, BigInteger.Zero);

        UInt160 attackerAccount = h.RegisterAccount(Attacker);
        BigInteger relayBefore = h.Fx.GasBalanceOf(AttackerRelay);

        Assert.ThrowsExactly<TestException>(
            () => h.ExecuteAs(Attacker, attackerAccount, paymaster, "settleReimbursement",
                Sponsor, attackerAccount, UInt160.Zero, "", AttackerRelay, (BigInteger)OneGas),
            "Settlement must only follow a sponsored execution, never an ordinary operation");

        Assert.AreEqual(deposit, h.Fx.CallInteger(paymaster, "getSponsorDeposit", Sponsor),
            "The sponsor deposit must be untouched");
        Assert.AreEqual(relayBefore, h.Fx.GasBalanceOf(AttackerRelay),
            "No reimbursement may reach an address the operation named itself");
    }

    [TestMethod]
    public void ExecuteUserOp_CannotAbandonAnotherAccountsMarketListing()
    {
        Harness h = new();
        UInt160 market = h.Fx.Deploy("AAAddressMarket");
        h.Fx.CallVoid(market, "setAllowedAA", h.Wallet, true);

        UInt160 victimAccount = h.RegisterAccount(Victim);
        h.Fx.SetSigners(Victim);
        h.Fx.CallVoid(market, "createListing", h.Wallet, victimAccount, (BigInteger)OneGas, "AA address", "");
        BigInteger listingId = h.Fx.CallInteger(market, "getListingCount");

        UInt160 attackerAccount = h.RegisterAccount(Attacker);

        Assert.ThrowsExactly<TestException>(
            () => h.ExecuteAs(Attacker, attackerAccount, market, "abandonListing", victimAccount, listingId),
            "Only the core's own escrow unwind may retire a listing");

        Neo.VM.Types.Array listing = (Neo.VM.Types.Array)h.Fx.Call(market, "getListing", listingId);
        Assert.AreEqual((BigInteger)ListingStatusActive, listing[ListingStatusIndex].GetInteger(),
            "The victim's listing must stay Active");
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", victimAccount));
    }
}
