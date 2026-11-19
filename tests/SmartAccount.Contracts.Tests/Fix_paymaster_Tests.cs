using System;
using System.Numerics;
using System.Linq;
using System.Reflection;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.VM;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression tests for the two related paymaster audit findings:
///
/// MEDIUM-a — <c>ExecuteSponsoredUserOp</c> forwarded a fully relay-controlled
/// <c>reimbursementAmount</c> to the paymaster with no relation to the gas actually paid; within
/// policy MaxPerOp the relay could always claim the maximum. The fix caps the settled amount to
/// the enclosing transaction's <c>SystemFee + NetworkFee</c>.
///
/// MEDIUM-b — a global policy (accountId = Zero, sponsoring ANY account) with DailyBudget/TotalBudget
/// left at 0 (= unlimited) let a relay drain the entire sponsor deposit at MaxPerOp per op with no
/// aggregate bound. The fix makes both budgets mandatory for the global scope.
/// </summary>
[TestClass]
public class FixPaymasterTests
{
    private static readonly UInt160 Sponsor =
        UInt160.Parse("0x7777777777777777777777777777777777777777");

    private static readonly UInt160 Relay =
        UInt160.Parse("0x8888888888888888888888888888888888888888");

    private static readonly UInt160 AccountId =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static readonly UInt160 TargetContract =
        UInt160.Parse("0x3333333333333333333333333333333333333333");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private const long OneGas = 100_000_000;

    // ====================================================================
    // MEDIUM-b: global policy must carry explicit finite budgets
    // ====================================================================

    private sealed class PolicyHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Core { get; }

        public UInt160 Paymaster { get; }

        public PolicyHarness()
        {
            Core = Fx.Deploy("MockVerifierCore");
            Paymaster = Fx.Deploy("SAPaymaster", Core.ToArray());
        }

        public void SetPolicy(UInt160 accountId, BigInteger maxPerOp, BigInteger dailyBudget, BigInteger totalBudget)
        {
            Fx.SetSigners(Sponsor);
            Fx.CallVoid(Paymaster, "setPolicy",
                accountId, UInt160.Zero, "", maxPerOp, dailyBudget, totalBudget, BigInteger.Zero);
        }
    }

    [TestMethod]
    public void SetPolicy_GlobalPolicy_RejectsZeroDailyBudget()
    {
        PolicyHarness h = new();

        TestException ex = Assert.ThrowsExactly<TestException>(
            () => h.SetPolicy(UInt160.Zero, maxPerOp: OneGas, dailyBudget: 0, totalBudget: 2 * OneGas));
        StringAssert.Contains(ex.Message, "DailyBudget required for global policy");
    }

    [TestMethod]
    public void SetPolicy_GlobalPolicy_RejectsZeroTotalBudget()
    {
        PolicyHarness h = new();

        TestException ex = Assert.ThrowsExactly<TestException>(
            () => h.SetPolicy(UInt160.Zero, maxPerOp: OneGas, dailyBudget: 2 * OneGas, totalBudget: 0));
        StringAssert.Contains(ex.Message, "TotalBudget required for global policy");
    }

    [TestMethod]
    public void SetPolicy_GlobalPolicy_AcceptsExplicitFiniteBudgets()
    {
        PolicyHarness h = new();

        // Both budgets positive: the global policy is accepted and stored.
        h.SetPolicy(UInt160.Zero, maxPerOp: OneGas, dailyBudget: 2 * OneGas, totalBudget: 5 * OneGas);

        // ValidatePaymasterOp resolves the stored global policy for an arbitrary account.
        bool valid = h.Fx.CallBoolean(h.Paymaster, "validatePaymasterOp",
            Sponsor, AccountId, TargetContract, "transfer", (BigInteger)OneGas);
        // Deposit is zero so it fails deposit backing, but a non-null policy was resolved
        // (a missing policy also returns false, so assert the policy persisted via getPolicy).
        Assert.IsFalse(valid, "No deposit yet, so validation fails on deposit backing");

        // The global policy must be readable back (proves SetPolicy succeeded, not reverted).
        // getPolicy returns a struct; a missing policy would deserialize to null -> the call
        // returns Null. We assert the round trip does not fault and the policy is present by
        // re-running SetPolicy with the same finite budgets (idempotent, must not throw).
        h.SetPolicy(UInt160.Zero, maxPerOp: OneGas, dailyBudget: 2 * OneGas, totalBudget: 5 * OneGas);
    }

    [TestMethod]
    public void SetPolicy_AccountSpecificPolicy_StillAllowsUnlimitedBudgets()
    {
        PolicyHarness h = new();

        // Account-specific policies remain inherently bounded to one account; 0 = unlimited is
        // still permitted (must not throw). This preserves legitimate per-account sponsorship.
        h.SetPolicy(AccountId, maxPerOp: OneGas, dailyBudget: 0, totalBudget: 0);
    }

    // ====================================================================
    // MEDIUM-a: sponsored reimbursement is capped to actual gas cost
    // ====================================================================

    private sealed class SponsoredHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Target { get; }

        public UInt160 Paymaster { get; }

        /// <summary>The P-256 custody key that signs the account's built-in operations.</summary>
        public P256SessionKey OwnerKey { get; } = new();

        public UInt160 Custody { get; }

        public UInt160 ExecAccount { get; }

        public SponsoredHarness(BigInteger depositAmount)
        {
            Wallet = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            // The paymaster's authorizedCore must point back at the wallet so the wallet's
            // ExecuteSponsoredUserOp passes the "Paymaster not bound to this core" check and the
            // paymaster's settlement accepts the wallet as the authorized caller.
            Paymaster = Fx.Deploy("SAPaymaster", Wallet.ToArray());

            // Register a v4 account whose custody key signs the built-in operation profile.
            Custody = RuntimeFixture.CustodyOf(OwnerKey);
            ExecAccount = Fx.CreateAccount(Wallet, Custody, "paymaster-exec");

            // Fund the sponsor and deposit GAS into the paymaster.
            Fx.FundGasFromValidators(Sponsor, depositAmount * 2);
            Fx.SetSigners(Sponsor);
            Fx.TransferGas(Sponsor, Paymaster, depositAmount, null);
        }

        /// <summary>Registers another account under the same custody with a distinct salt.</summary>
        public UInt160 RegisterSecond() =>
            Fx.CreateAccount(Wallet, Custody, "paymaster-second");

        /// <summary>The relay sends the transaction; the custody co-signs the account operation.</summary>
        public void SetSponsoredSigners() => Fx.SetSigners(Relay, Custody);

        public void SetWalletAccountPolicy(BigInteger maxPerOp, BigInteger dailyBudget, BigInteger totalBudget)
        {
            // Account-specific policy keyed to the executing account (target wildcard, any method).
            Fx.SetSigners(Sponsor);
            Fx.CallVoid(Paymaster, "setPolicy",
                ExecAccount, UInt160.Zero, "", maxPerOp, dailyBudget, totalBudget, BigInteger.Zero);
        }

        /// <summary>
        /// Builds a signed built-in operation (validatorId 0, spec §8). <paramref name="sequence"/> is
        /// the low 64-bit sequence of the packed nonce, so same-transaction vectors stay in order.
        /// </summary>
        public object[] SignedOp(
            UInt160 ownerAccount,
            UInt160 target,
            string method,
            object?[] args,
            BigInteger sequence,
            BigInteger deadline)
        {
            BigInteger mask = (BigInteger.One << 64) - 1;
            BigInteger packed = Fx.PackedNonce(Wallet, ownerAccount, 0);
            object[] op = RuntimeFixture.UserOp(target, method, args,
                (packed & ~mask) | sequence, deadline, new byte[] { 0x00 });
            op[11] = Fx.SignBuiltIn(Wallet, ownerAccount, op, OwnerKey);
            return op;
        }

        public object[] TransferOp(BigInteger sequence, BigInteger deadline, UInt160? account = null)
        {
            UInt160 ownerAccount = account ?? ExecAccount;
            return SignedOp(ownerAccount, Target, "transfer",
                new object?[] { ownerAccount, Recipient, (BigInteger)1000, null }, sequence, deadline);
        }

        public BigInteger Deposit() => Fx.CallInteger(Paymaster, "getSponsorDeposit", Sponsor);

        public BigInteger RelayBalance() => Fx.GasBalanceOf(Relay);
    }

    [TestMethod]
    public void ExecuteSponsoredUserOp_CapsReimbursementToActualGasCost()
    {
        SponsoredHarness h = new(depositAmount: 50 * OneGas);
        // Generous per-op cap and budgets so the only binding constraint under test is the
        // actual-gas-cost cap introduced by the fix.
        h.SetWalletAccountPolicy(maxPerOp: 50 * OneGas, dailyBudget: 50 * OneGas, totalBudget: 50 * OneGas);

        BigInteger depositBefore = h.Deposit();
        BigInteger relayBefore = h.RelayBalance();

        // The relay is the transaction sender; it requests an inflated reimbursement equal to the
        // whole per-op cap, far above the real transaction fee.
        BigInteger inflatedRequest = 50 * OneGas;
        // Relay is the transaction sender (first signer); the backup owner co-signs so the
        // account's native-fallback verification passes. This mirrors a real sponsored submission
        // where the relay sends the tx and the user's witness authorizes the operation.
        h.SetSponsoredSigners();
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        h.Fx.CallVoid(h.Wallet, "executeSponsoredUserOp",
            h.ExecAccount, h.TransferOp(0, deadline), h.Paymaster, Sponsor, inflatedRequest);

        BigInteger settled = depositBefore - h.Deposit();
        BigInteger relayGain = h.RelayBalance() - relayBefore;

        // The relay must NOT be able to extract the inflated request: it can only be reimbursed up
        // to the actual transaction cost (system + network fee), which is strictly less.
        Assert.IsTrue(settled > 0, "Relay is reimbursed something for the real cost");
        Assert.IsTrue(settled < inflatedRequest,
            $"Reimbursement {settled} must be capped below the inflated request {inflatedRequest}");
        Assert.AreEqual(settled, relayGain, "Relay receives exactly the capped, deposit-deducted amount");
    }

    [TestMethod]
    public void ExecuteSponsoredUserOp_ZeroFeeEstimationContainerStillSettles()
    {
        // Wallets and relays price a transaction through invokescript, whose container carries no
        // fees. A persisted transaction always pays a positive total fee, so the zero-fee container
        // is unambiguously an estimation and must not fault the sponsored path; it is settled at
        // the request so the estimate stays representative.
        SponsoredHarness h = new(depositAmount: 50 * OneGas);
        h.SetWalletAccountPolicy(maxPerOp: 50 * OneGas, dailyBudget: 50 * OneGas, totalBudget: 50 * OneGas);
        BigInteger depositBefore = h.Deposit();
        BigInteger request = 3 * OneGas;
        h.SetSponsoredSigners();
        h.Fx.Engine.Transaction.SystemFee = 0;
        h.Fx.Engine.Transaction.NetworkFee = 0;
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        h.Fx.CallVoid(h.Wallet, "executeSponsoredUserOp",
            h.ExecAccount, h.TransferOp(0, deadline), h.Paymaster, Sponsor, request);
        Assert.AreEqual(request, depositBefore - h.Deposit(),
            "An estimation container settles the requested amount instead of faulting");
    }

    [TestMethod]
    public void ExecuteSponsoredUserOp_HonoursRequestWhenBelowActualCost()
    {
        SponsoredHarness h = new(depositAmount: 50 * OneGas);
        h.SetWalletAccountPolicy(maxPerOp: 50 * OneGas, dailyBudget: 50 * OneGas, totalBudget: 50 * OneGas);

        BigInteger depositBefore = h.Deposit();

        // A tiny request below the actual gas cost is honoured verbatim (min(request, actualCost)).
        BigInteger smallRequest = 1;
        h.SetSponsoredSigners();
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        h.Fx.CallVoid(h.Wallet, "executeSponsoredUserOp",
            h.ExecAccount, h.TransferOp(0, deadline), h.Paymaster, Sponsor, smallRequest);

        BigInteger settled = depositBefore - h.Deposit();
        Assert.AreEqual(smallRequest, settled,
            "When the request is below the actual cost, the relay is reimbursed only what it asked for");
    }

    private static ContractParameter Parameter(object? value) => value switch
    {
        UInt160 hash => new(ContractParameterType.Hash160) { Value = hash },
        BigInteger number => new(ContractParameterType.Integer) { Value = number },
        string text => new(ContractParameterType.String) { Value = text },
        byte[] bytes => new(ContractParameterType.ByteArray) { Value = bytes },
        object?[] array => new(ContractParameterType.Array) { Value = array.Select(Parameter).ToList() },
        null => new(ContractParameterType.Any),
        _ => throw new NotSupportedException()
    };

    private static void AppendCall(ScriptBuilder script, UInt160 core, string method, params object?[] args)
    {
        script.EmitPush(Parameter(args));
        script.EmitPush((BigInteger)(int)CallFlags.All);
        script.EmitPush(method);
        script.EmitPush(core.ToArray());
        script.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
        script.Emit(OpCode.DROP);
    }

    private static void RunCombined(SponsoredHarness h, ScriptBuilder script)
    {
        h.Fx.Engine.Execute(new Script(script.ToArray()), 0, engine =>
            typeof(ApplicationEngine).GetField("_feeAmount", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(engine, new BigInteger(long.MaxValue)));
    }

    [TestMethod]
    public void SameTransaction_SingleOperationsShareOneActualCostBudget()
    {
        SponsoredHarness h = new(50 * OneGas);
        h.SetWalletAccountPolicy(50 * OneGas, 50 * OneGas, 50 * OneGas);
        BigInteger before = h.Deposit(), relayBefore = h.RelayBalance();
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        h.SetSponsoredSigners();
        h.Fx.Engine.Transaction.SystemFee = 4 * OneGas;
        h.Fx.Engine.Transaction.NetworkFee = OneGas;
        using ScriptBuilder script = new();
        AppendCall(script, h.Wallet, "executeSponsoredUserOp", h.ExecAccount,
            h.TransferOp(0, deadline), h.Paymaster, Sponsor, (BigInteger)(3 * OneGas));
        AppendCall(script, h.Wallet, "executeSponsoredUserOp", h.ExecAccount,
            h.TransferOp(1, deadline), h.Paymaster, Sponsor, (BigInteger)(3 * OneGas));
        script.EmitPush(true);
        RunCombined(h, script);
        Assert.AreEqual((BigInteger)(5 * OneGas), before - h.Deposit(), "Aggregate reimbursement must equal one transaction cost");
        Assert.AreEqual((BigInteger)(5 * OneGas), h.RelayBalance() - relayBefore);
        Assert.AreEqual((BigInteger)2, h.Fx.CurrentNonceSequence(h.Wallet, h.ExecAccount, 0));
    }

    private static void SetFees(SponsoredHarness h, long system = 4 * OneGas, long network = OneGas)
    {
        h.SetSponsoredSigners();
        h.Fx.Engine.Transaction.SystemFee = system;
        h.Fx.Engine.Transaction.NetworkFee = network;
    }

    [TestMethod]
    public void SameTransaction_SingleAndBatchShareOneBudget()
    {
        SponsoredHarness h = new(50 * OneGas);
        h.SetWalletAccountPolicy(50 * OneGas, 50 * OneGas, 50 * OneGas);
        BigInteger before = h.Deposit(), deadline = h.Fx.Now() + 3_600_000;
        SetFees(h);
        using ScriptBuilder script = new();
        AppendCall(script, h.Wallet, "executeSponsoredUserOp", h.ExecAccount,
            h.TransferOp(0, deadline), h.Paymaster, Sponsor, (BigInteger)(3 * OneGas));
        AppendCall(script, h.Wallet, "executeSponsoredUserOps", h.ExecAccount,
            new object[] { h.TransferOp(1, deadline), h.TransferOp(2, deadline) },
            h.Paymaster, Sponsor, (BigInteger)(3 * OneGas));
        script.EmitPush(true);
        RunCombined(h, script);
        Assert.AreEqual((BigInteger)(5 * OneGas), before - h.Deposit());
        Assert.AreEqual((BigInteger)3, h.Fx.CurrentNonceSequence(h.Wallet, h.ExecAccount, 0));
    }

    [TestMethod]
    public void SameTransaction_DifferentAccountsAndPaymastersShareCoreBudget()
    {
        SponsoredHarness h = new(50 * OneGas);
        h.SetWalletAccountPolicy(50 * OneGas, 50 * OneGas, 50 * OneGas);
        UInt160 second = h.RegisterSecond();
        h.Fx.SetSigners(Recipient); // A distinct deployer produces a second contract hash.
        UInt160 secondPaymaster = h.Fx.Deploy("SAPaymaster", h.Wallet.ToArray());
        Assert.AreNotEqual(h.Paymaster, secondPaymaster);
        h.Fx.SetSigners(Sponsor);
        h.Fx.TransferGas(Sponsor, secondPaymaster, 50 * OneGas, null);
        h.Fx.CallVoid(secondPaymaster, "setPolicy", second, UInt160.Zero, "",
            (BigInteger)(50 * OneGas), (BigInteger)(50 * OneGas), (BigInteger)(50 * OneGas), BigInteger.Zero);
        BigInteger relayBefore = h.RelayBalance(), deadline = h.Fx.Now() + 3_600_000;
        SetFees(h);
        using ScriptBuilder script = new();
        AppendCall(script, h.Wallet, "executeSponsoredUserOp", h.ExecAccount,
            h.TransferOp(0, deadline), h.Paymaster, Sponsor, (BigInteger)(3 * OneGas));
        AppendCall(script, h.Wallet, "executeSponsoredUserOp", second,
            h.TransferOp(0, deadline, second), secondPaymaster, Sponsor, (BigInteger)(3 * OneGas));
        script.EmitPush(true);
        RunCombined(h, script);
        Assert.AreEqual((BigInteger)(5 * OneGas), h.RelayBalance() - relayBefore);
        Assert.AreEqual((BigInteger)(47 * OneGas), h.Deposit());
        Assert.AreEqual((BigInteger)(48 * OneGas), h.Fx.CallInteger(secondPaymaster, "getSponsorDeposit", Sponsor));
    }

    [TestMethod]
    public void NewTransaction_ResetsTheSharedBudget()
    {
        SponsoredHarness h = new(50 * OneGas);
        h.SetWalletAccountPolicy(50 * OneGas, 50 * OneGas, 50 * OneGas);
        BigInteger before = h.Deposit(), deadline = h.Fx.Now() + 3_600_000;
        SetFees(h);
        UInt256? previousHash = null;
        for (int nonce = 0; nonce < 2; nonce++)
        {
            using ScriptBuilder script = new();
            AppendCall(script, h.Wallet, "executeSponsoredUserOp", h.ExecAccount,
                h.TransferOp(nonce, deadline), h.Paymaster, Sponsor, (BigInteger)(3 * OneGas));
            script.EmitPush(true);
            RunCombined(h, script); // Distinct signed script => distinct transaction hash.
            UInt256 currentHash = h.Fx.Engine.Transaction.Hash;
            if (previousHash is not null) Assert.AreNotEqual(previousHash, currentHash);
            previousHash = currentHash;
        }
        Assert.AreEqual((BigInteger)(6 * OneGas), before - h.Deposit());
    }

    [TestMethod]
    public void SameTransaction_ZeroFeeRpcEstimationPreservesConservativeRequests()
    {
        SponsoredHarness h = new(50 * OneGas);
        h.SetWalletAccountPolicy(50 * OneGas, 50 * OneGas, 50 * OneGas);
        BigInteger before = h.Deposit(), deadline = h.Fx.Now() + 3_600_000;
        SetFees(h, 0, 0);
        using ScriptBuilder script = new();
        for (int nonce = 0; nonce < 2; nonce++)
            AppendCall(script, h.Wallet, "executeSponsoredUserOp", h.ExecAccount,
                h.TransferOp(nonce, deadline), h.Paymaster, Sponsor, (BigInteger)(3 * OneGas));
        script.EmitPush(true);
        RunCombined(h, script);
        Assert.AreEqual((BigInteger)(6 * OneGas), before - h.Deposit(),
            "RPC estimation follows both settlements; this is not a zero-fee block transaction.");
    }

    [TestMethod]
    public void SameTransaction_ExhaustedBudgetFaultRollsBackReservationAndAllEffects()
    {
        SponsoredHarness h = new(50 * OneGas);
        h.SetWalletAccountPolicy(50 * OneGas, 50 * OneGas, 50 * OneGas);
        var state = (Neo.VM.Types.Array)h.Fx.Call(
            UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"), "getContract", h.Wallet);
        StorageKey key = new() { Id = (int)state[0].GetInteger(), Key = new byte[] { 0x21 } };
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(key));
        BigInteger before = h.Deposit(), relayBefore = h.RelayBalance(), deadline = h.Fx.Now() + 3_600_000;
        SetFees(h);
        using ScriptBuilder script = new();
        AppendCall(script, h.Wallet, "executeSponsoredUserOp", h.ExecAccount,
            h.TransferOp(0, deadline), h.Paymaster, Sponsor, (BigInteger)(5 * OneGas));
        AppendCall(script, h.Wallet, "executeSponsoredUserOp", h.ExecAccount,
            h.TransferOp(1, deadline), h.Paymaster, Sponsor, BigInteger.One);
        script.EmitPush(true);
        var error = Assert.ThrowsExactly<TestException>(() => RunCombined(h, script));
        StringAssert.Contains(error.Message, "Reimbursement exceeds actual gas cost");
        Assert.AreEqual(before, h.Deposit());
        Assert.AreEqual(relayBefore, h.RelayBalance());
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Wallet, h.ExecAccount, 0));
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(key), "Failed invocation must not retain its reservation slot.");
    }

    [TestMethod]
    public void NestedSponsoredExecution_SettlementRefusedWhileOuterFrameInFlight()
    {
        // Audit Low 6 (depth-counted in-flight marker): a nested executeSponsoredUserOp
        // unwinds to depth 1, not to an absent marker, while the outer operation still
        // executes. IsUserOpExecutionActive therefore stays true and the paymaster's
        // deputy guard refuses the nested settlement instead of reimbursing a fee from
        // inside another account's operation. The whole invocation faults and every
        // nested effect (nonce, transfer, reservation) rolls back.
        SponsoredHarness h = new(50 * OneGas);
        h.SetWalletAccountPolicy(50 * OneGas, 50 * OneGas, 50 * OneGas);
        UInt160 second = h.RegisterSecond();
        h.Fx.SetSigners(Sponsor);
        h.Fx.CallVoid(h.Paymaster, "setPolicy", second, UInt160.Zero, "",
            (BigInteger)(50 * OneGas), (BigInteger)(50 * OneGas), (BigInteger)(50 * OneGas), BigInteger.Zero);
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        using ScriptBuilder callback = new();
        AppendCall(callback, h.Wallet, "executeSponsoredUserOp", second,
            h.TransferOp(0, deadline, second), h.Paymaster, Sponsor, (BigInteger)(3 * OneGas));
        callback.EmitPush(true);
        callback.Emit(OpCode.RET);
        NefFile nef = new() { Compiler = "Sponsored nesting regression", Source = "", Tokens = [], Script = callback.ToArray() };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        ContractManifest manifest = new()
        {
            Name = "SponsoredNestedTarget",
            Groups = [],
            SupportedStandards = [],
            Permissions = [ContractPermission.DefaultPermission],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
            Abi = new ContractAbi
            {
                Methods = [new ContractMethodDescriptor { Name = "run", Offset = 0,
                    ReturnType = ContractParameterType.Boolean, Parameters = [], Safe = false }],
                Events = []
            }
        };
        UInt160 target = h.Fx.DeployArtifact(nef.ToArray(), manifest.ToJson().ToString());
        BigInteger before = h.Deposit(), relayBefore = h.RelayBalance();
        SetFees(h);
        TestException refused = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Wallet, "executeSponsoredUserOp", h.ExecAccount,
            h.SignedOp(h.ExecAccount, target, "run", Array.Empty<object?>(), 0, deadline),
            h.Paymaster, Sponsor, (BigInteger)(3 * OneGas)));
        StringAssert.Contains(refused.Message, "Settlement must follow a completed sponsored execution");
        Assert.AreEqual(before, h.Deposit(),
            "The refused nested settlement must not spend sponsor deposit");
        Assert.AreEqual(relayBefore, h.RelayBalance());
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Wallet, h.ExecAccount, 0));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Wallet, second, 0));
    }
}
