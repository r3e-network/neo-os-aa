using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Reflection;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.Network.P2P.Payloads.Conditions;
using Neo.SmartContract;
using Neo.VM;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Behavioral tests for the SA proxy witness path used by virtual accounts: the
/// proxy address is the hash of a script that calls <c>core.verify(accountId)</c>,
/// and it authorizes an operation only through its own restricted signer.
/// </summary>
/// <remarks>
/// The proxy is deliberately never the fee payer. A proxy that paid its own fees
/// would turn a shaped-but-faulting transaction into a GAS leak from the virtual
/// account, so the contract rejects that arrangement outright. The transaction
/// script must also be exactly one call on the core for this account — one of the
/// two direct entry points with two arguments or one of the two sponsored
/// wrappers with five — which is what ties the witness to a real
/// account-authorized operation instead of an arbitrary script that merely lists
/// the proxy as a signer.
///
/// The sponsored wrappers matter for exactly this witness: when the executor is a
/// virtual account, a sponsored operation moves the account's own GAS out of the
/// proxy address, and the native token's <c>CheckWitness(proxy)</c> resolves
/// against this witness because the token's direct caller is the core
/// (<c>CalledByContract(core)</c>). Refusing the five-argument envelope therefore
/// also refused legitimate sponsored transfers; the shape is now bound at its own
/// arity instead of being refused outright.
/// </remarks>
[TestClass]
public class ProxyWitnessRuntimeTests
{
    private static readonly UInt160 AccountId = UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static byte[] SenderScript() => new byte[] { (byte)OpCode.PUSH1 };

    /// <summary>
    /// Data pushes followed by exactly one `core.&lt;method&gt;(accountId, op)` call, the
    /// only transaction shape the proxy witness accepts.
    /// </summary>
    private static byte[] AccountBoundScript(UInt160 core, string method, int opBytes, UInt160? accountId = null, int argumentCount = 2)
    {
        using ScriptBuilder sb = new();
        if (argumentCount == 5)
        {
            sb.EmitPush(100); // reimbursement
            sb.EmitPush(AccountId.GetSpan().ToArray()); // sponsor
            sb.EmitPush(core.GetSpan().ToArray()); // paymaster (validated during Application)
        }
        sb.EmitPush(new byte[opBytes]);
        sb.EmitPush((accountId ?? AccountId).GetSpan().ToArray());
        sb.EmitPush(argumentCount);
        sb.Emit(OpCode.PACK);
        sb.EmitPush((byte)CallFlags.All);
        sb.EmitPush(method);
        sb.EmitPush(core.GetSpan().ToArray());
        sb.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
        return sb.ToArray();
    }

    private static byte[] WithPrefix(byte prefix, byte[] script)
    {
        byte[] result = new byte[script.Length + 1];
        result[0] = prefix;
        Buffer.BlockCopy(script, 0, result, 1, script.Length);
        return result;
    }

    private static byte[] WithSuffix(byte[] script, byte suffix)
    {
        byte[] result = new byte[script.Length + 1];
        Buffer.BlockCopy(script, 0, result, 0, script.Length);
        result[^1] = suffix;
        return result;
    }

    /// <summary>
    /// F-1 (protocol v4): the only witness rule shape a proxy may carry is exactly one
    /// Allow whose condition is CalledByContract(this core). The retired
    /// Or(CalledByContract(core), CalledByContract(admin-configured target)) form is
    /// deleted together with the per-account scope target.
    /// </summary>
    private static WitnessRule[] ExactRules(UInt160 wallet) => new[]
    {
        new WitnessRule
        {
            Action = WitnessRuleAction.Allow,
            Condition = new CalledByContractCondition { Hash = wallet },
        },
    };

    private sealed class ProxyHarness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Wallet { get; }
        public UInt160 Target { get; }
        public byte[] ProxyScript { get; }
        public UInt160 ProxyHash => ProxyScript.ToScriptHash();

        public ProxyHarness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");

            using ScriptBuilder proxy = new();
            proxy.EmitDynamicCall(Wallet, "verify", AccountId);
            ProxyScript = proxy.ToArray();
        }

        public bool Verify(bool globalProxy, bool decoy, byte[] script, bool proxyPaysFees = false)
        {
            var proxySigner = new Signer
            {
                Account = ProxyHash,
                Scopes = globalProxy ? WitnessScope.Global : WitnessScope.WitnessRules,
                Rules = globalProxy ? Array.Empty<WitnessRule>() : ExactRules(Wallet),
            };
            var proxyWitness = new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = ProxyScript };
            var senderScript = SenderScript();
            var senderSigner = new Signer { Account = senderScript.ToScriptHash(), Scopes = WitnessScope.CalledByEntry };
            var senderWitness = new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = senderScript };

            Signer[] signers;
            Witness[] witnesses;
            if (proxyPaysFees)
            {
                signers = new[] { proxySigner };
                witnesses = new[] { proxyWitness };
            }
            else if (decoy)
            {
                // The decoy carries matching rules but no secret; only the proxy's own
                // signer may grant the proxy's scope.
                var decoyScript = new byte[] { (byte)OpCode.PUSH1 };
                signers = new[]
                {
                    senderSigner,
                    proxySigner,
                    new Signer { Account = decoyScript.ToScriptHash(), Scopes = WitnessScope.WitnessRules, Rules = ExactRules(Wallet) },
                };
                witnesses = new[]
                {
                    senderWitness,
                    proxyWitness,
                    new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = decoyScript },
                };
            }
            else
            {
                signers = new[] { senderSigner, proxySigner };
                witnesses = new[] { senderWitness, proxyWitness };
            }

            var tx = new Transaction
            {
                Script = script,
                Attributes = Array.Empty<TransactionAttribute>(),
                Signers = signers,
                Witnesses = witnesses,
            };
            return Helper.VerifyWitnesses(tx, Fx.Engine.ProtocolSettings, Fx.Engine.Storage.Snapshot, 50_00000000);
        }
    }

    [TestMethod]
    [DataRow(false, false, true)]
    [DataRow(true, false, false)]
    [DataRow(true, true, false)]
    // A decoy signer is only decisive when the proxy itself is unrestricted: a proxy
    // holding its own exact WitnessRules authorizes the call regardless of the decoy.
    [DataRow(false, true, true)]
    public void ProxyWitnessMustUseItsOwnRestrictedSigner(bool globalProxy, bool decoy, bool expected)
    {
        ProxyHarness h = new();
        bool accepted = h.Verify(globalProxy, decoy, AccountBoundScript(h.Wallet, "executeUserOp", 16));
        Assert.AreEqual(expected, accepted);
    }

    [TestMethod]
    public void ProxyWitnessIsBoundToAnAccountExecutionScript()
    {
        ProxyHarness h = new();
        Assert.IsTrue(h.Verify(false, false, AccountBoundScript(h.Wallet, "executeUserOp", 16)),
            "A shaped executeUserOp call on the core must be accepted");
        Assert.IsTrue(h.Verify(false, false, AccountBoundScript(h.Wallet, "executeUserOps", 16)),
            "A shaped executeUserOps call on the core must be accepted");
        Assert.IsFalse(h.Verify(false, false, new byte[] { (byte)OpCode.RET }),
            "An arbitrary script that only lists the proxy as a signer must be rejected");
    }

    [TestMethod]
    public void ProxyWitnessRejectsWrongAccountAndNonDataScriptPrefixOrSuffix()
    {
        ProxyHarness h = new();
        UInt160 otherAccount = UInt160.Parse("0x2222222222222222222222222222222222222222");
        byte[] shaped = AccountBoundScript(h.Wallet, "executeUserOp", 16);

        Assert.IsFalse(
            h.Verify(false, false, AccountBoundScript(h.Wallet, "executeUserOp", 16, otherAccount)),
            "A call shaped for another account must not satisfy this proxy witness");
        Assert.IsFalse(
            h.Verify(false, false, WithPrefix(0x21, shaped)),
            "A non-data instruction before the core call must be rejected");
        Assert.IsFalse(
            h.Verify(false, false, WithSuffix(shaped, 0x21)),
            "A non-data instruction after the core call must be rejected");
    }

    [TestMethod]
    public void ProxyWitnessMayNotPayItsOwnFees()
    {
        ProxyHarness h = new();
        Assert.IsFalse(h.Verify(false, false, AccountBoundScript(h.Wallet, "executeUserOp", 16), proxyPaysFees: true),
            "A proxy funding its own witness must be rejected so a faulting transaction cannot burn account GAS");
    }

    [TestMethod]
    [DataRow("executeSponsoredUserOp")]
    [DataRow("executeSponsoredUserOps")]
    public void SponsoredProxyWitnessAcceptsTheExactFiveArgumentEnvelope(string method)
    {
        ProxyHarness h = new();
        UInt160 other = UInt160.Parse("0x2222222222222222222222222222222222222222");
        byte[] shaped = AccountBoundScript(h.Wallet, method, 16, argumentCount: 5);

        // A sponsored wrapper is the only way a relay moves a virtual account's assets
        // while a sponsor pays, so its five-argument call on this core is exactly the
        // transaction the proxy witness has to authorize.
        Assert.IsTrue(h.Verify(false, false, shaped),
            "A shaped five-argument sponsored call on the core must authorize the proxy witness");

        // The two sponsored wrappers are bound at five-argument arity and the two direct
        // entry points at two, so neither arity can stand in for the other.
        Assert.IsFalse(h.Verify(false, false, AccountBoundScript(h.Wallet, method, 16)),
            "Two arguments cannot authorize sponsored execution");
        Assert.IsFalse(h.Verify(false, false, AccountBoundScript(h.Wallet, "executeUserOp", 16, argumentCount: 5)),
            "A five-argument call to executeUserOp must be rejected");
        Assert.IsFalse(h.Verify(false, false, AccountBoundScript(h.Wallet, "executeUserOps", 16, argumentCount: 5)),
            "A five-argument call to executeUserOps must be rejected");

        // The rest of the envelope is unchanged: this account, this core, the proxy's own
        // restricted rule, no fee payment, and no executable bytes around the call.
        Assert.IsFalse(h.Verify(false, false, AccountBoundScript(h.Wallet, method, 16, other, 5)),
            "A sponsored call shaped for another account must not satisfy this proxy witness");
        Assert.IsFalse(h.Verify(false, false, AccountBoundScript(other, method, 16, argumentCount: 5)),
            "A sponsored call on another core must not satisfy this proxy witness");
        Assert.IsFalse(h.Verify(true, false, shaped), "Global scope must stay rejected");
        Assert.IsFalse(h.Verify(false, false, shaped, proxyPaysFees: true),
            "The proxy must never pay its own fees, sponsored or not");
        Assert.IsFalse(h.Verify(false, false, WithPrefix((byte)OpCode.NOP, shaped)),
            "An executable prefix must be rejected");
        Assert.IsFalse(h.Verify(false, false, WithSuffix(shaped, (byte)OpCode.RET)),
            "An executable suffix must be rejected");
    }

    [TestMethod]
    public void SponsoredProxyWitnessRejectsAnAppendedCall()
    {
        ProxyHarness h = new();
        byte[] shaped = AccountBoundScript(h.Wallet, "executeSponsoredUserOp", 16, argumentCount: 5);

        // The exploit shape: keep the sponsored call and append a transfer the operation
        // never signed, hoping one witness covers both. The envelope must be the whole
        // transaction, so a trailing unrelated call is refused.
        byte[] withTransfer = Concat(shaped, AccountBoundScript(h.Target, "transfer", 16));
        Assert.IsFalse(h.Verify(false, false, withTransfer),
            "A call appended after the sponsored envelope must be rejected");

        // Appending a second shaped sponsored call moves the accepted tail to the second
        // call, and the first call's SYSCALL then sits inside the data-push prefix.
        byte[] withSecondCall = Concat(shaped, shaped);
        Assert.IsFalse(h.Verify(false, false, withSecondCall),
            "Only one core call may occupy the transaction script");
    }

    private static byte[] Concat(byte[] first, byte[] second)
    {
        byte[] result = new byte[first.Length + second.Length];
        Buffer.BlockCopy(first, 0, result, 0, first.Length);
        Buffer.BlockCopy(second, 0, result, first.Length, second.Length);
        return result;
    }

    // ============================================================================
    // End-to-end: the real proxy witness verifies, then the sponsored GAS transfer
    // actually moves the virtual account's assets and settles the reimbursement.
    // ============================================================================

    private const long OneGas = 100_000_000;

    private static readonly BigInteger TransferAmount = OneGas / 10;

    private static readonly BigInteger DepositAmount = 50 * OneGas;

    private static readonly UInt160 Sponsor = UInt160.Parse("0x7777777777777777777777777777777777777777");

    private static readonly UInt160 Relay = UInt160.Parse("0x8888888888888888888888888888888888888888");

    private static readonly UInt160 Recipient = UInt160.Parse("0x6666666666666666666666666666666666666666");

    private static ContractParameter Parameter(object? value) => value switch
    {
        UInt160 hash => new(ContractParameterType.Hash160) { Value = hash },
        BigInteger number => new(ContractParameterType.Integer) { Value = number },
        string text => new(ContractParameterType.String) { Value = text },
        byte[] bytes => new(ContractParameterType.ByteArray) { Value = bytes },
        object?[] array => new(ContractParameterType.Array) { Value = array.Select(Parameter).ToList() },
        null => new(ContractParameterType.Any),
        _ => throw new NotSupportedException(),
    };

    private sealed class SponsoredGasHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Paymaster { get; }

        /// <summary>The P-256 custody key that signs the account's built-in operations.</summary>
        public P256SessionKey OwnerKey { get; } = new();

        public UInt160 Custody { get; }

        public UInt160 Account { get; }

        /// <summary>The virtual-account address that holds this account's GAS.</summary>
        public UInt160 Proxy { get; }

        public byte[] ProxyScript { get; }

        public SponsoredGasHarness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            // The paymaster's authorizedCore must point back at this core, so the sponsored
            // entry passes its "Paymaster not bound to this core" check and settlement accepts
            // the core as the caller.
            Paymaster = Fx.Deploy("SAPaymaster", Wallet.ToArray());

            Custody = RuntimeFixture.CustodyOf(OwnerKey);
            Account = Fx.CreateAccount(Wallet, Custody, "sponsored-proxy");

            Proxy = Fx.CallUInt160(Wallet, "getProxyScriptHash", Account);
            using ScriptBuilder proxy = new();
            proxy.EmitDynamicCall(Wallet, "verify", Account);
            ProxyScript = proxy.ToArray();
            Assert.AreEqual(Proxy, ProxyScript.ToScriptHash(),
                "The derived proxy address must be the address of the witness script it describes");

            // A virtual account keeps its assets at the proxy address; the account id holds nothing.
            Fx.FundGasFromValidators(Proxy, 10 * OneGas);
            Assert.AreEqual(BigInteger.Zero, Fx.GasBalanceOf(Account));

            Fx.FundGasFromValidators(Sponsor, DepositAmount * 2);
            Fx.SetSigners(Sponsor);
            Fx.TransferGas(Sponsor, Paymaster, DepositAmount, null);
            Fx.CallVoid(Paymaster, "setPolicy", Account, UInt160.Zero, "",
                (BigInteger)(5 * OneGas), (BigInteger)(10 * OneGas), (BigInteger)(20 * OneGas), BigInteger.Zero);
        }

        /// <summary>A built-in (validatorId 0) operation that moves the proxy's own GAS.</summary>
        public object[] GasTransferOp(BigInteger sequence)
        {
            BigInteger mask = (BigInteger.One << 64) - 1;
            BigInteger packed = Fx.PackedNonce(Wallet, Account, 0);
            object[] op = RuntimeFixture.UserOp(
                Fx.GasHash, "transfer",
                new object?[] { Proxy, Recipient, TransferAmount, null },
                (packed & ~mask) | sequence, Fx.Now() + 3_600_000, new byte[] { 0x00 });
            op[11] = Fx.SignBuiltIn(Wallet, Account, op, OwnerKey);
            return op;
        }

        /// <summary>
        /// Exactly one <c>executeSponsoredUserOp</c> call: the five arguments are pushed
        /// last-to-first, so the account id stays the push immediately before PUSH5/PACK.
        /// </summary>
        public byte[] SponsoredScript(object[] op, BigInteger reimbursement)
        {
            ContractParameter args = new(ContractParameterType.Array)
            {
                Value = new List<ContractParameter>
                {
                    Parameter(Account),
                    Parameter(op),
                    Parameter(Paymaster),
                    Parameter(Sponsor),
                    Parameter(reimbursement),
                },
            };

            using ScriptBuilder script = new();
            script.EmitPush(args);
            script.EmitPush((BigInteger)(int)CallFlags.All);
            script.EmitPush("executeSponsoredUserOp");
            script.EmitPush(Wallet.ToArray());
            script.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
            return script.ToArray();
        }

        /// <summary>Runs the proxy's real verification script against the transaction.</summary>
        public bool VerifyProxyWitness(byte[] script)
        {
            // The caller is a throwaway always-true script: only the proxy's witness matters.
            byte[] callerScript = new[] { (byte)OpCode.PUSH1 };
            var tx = new Transaction
            {
                Script = script,
                Attributes = Array.Empty<TransactionAttribute>(),
                Signers = new[]
                {
                    new Signer { Account = callerScript.ToScriptHash(), Scopes = WitnessScope.CalledByEntry },
                    new Signer { Account = Proxy, Scopes = WitnessScope.WitnessRules, Rules = ExactRules(Wallet) },
                },
                Witnesses = new[]
                {
                    new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = callerScript },
                    new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = ProxyScript },
                },
            };
            return Helper.VerifyWitnesses(tx, Fx.Engine.ProtocolSettings, Fx.Engine.Storage.Snapshot, 50_00000000);
        }

        /// <summary>
        /// Executes the verified bytes. The proxy carries its own restricted WitnessRules
        /// signer, so the native token's <c>CheckWitness(proxy)</c> succeeds only because the
        /// token's direct caller is the core — the property under test.
        /// </summary>
        public void Execute(byte[] script)
        {
            Fx.Engine.SetTransactionSigners(
                new Signer { Account = Relay, Scopes = WitnessScope.Global },
                new Signer { Account = Custody, Scopes = WitnessScope.Global },
                new Signer { Account = Proxy, Scopes = WitnessScope.WitnessRules, Rules = ExactRules(Wallet) });
            // A persisted transaction always carries a positive total fee; the reimbursement
            // cap is derived from it, so it has to be present before the call runs.
            Fx.Engine.Transaction.SystemFee = 4 * OneGas;
            Fx.Engine.Transaction.NetworkFee = OneGas;
            Fx.Engine.Execute(new Script(script), 0, engine =>
                typeof(ApplicationEngine).GetField("_feeAmount", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .SetValue(engine, new BigInteger(long.MaxValue)));
        }
    }

    [TestMethod]
    public void SponsoredGasTransfer_MovesTheProxyAssetsOnlyUnderTheRealWitness()
    {
        SponsoredGasHarness h = new();
        BigInteger proxyBefore = h.Fx.GasBalanceOf(h.Proxy);
        BigInteger recipientBefore = h.Fx.GasBalanceOf(Recipient);
        BigInteger depositBefore = h.Fx.CallInteger(h.Paymaster, "getSponsorDeposit", Sponsor);
        BigInteger relayBefore = h.Fx.GasBalanceOf(Relay);
        const long reimbursement = 2 * OneGas;

        object[] op = h.GasTransferOp(0);
        byte[] script = h.SponsoredScript(op, (BigInteger)reimbursement);

        // 1. The transaction is exactly the sponsored envelope, so the proxy's real
        //    verification script accepts it (a two-argument envelope never could).
        Assert.IsTrue(h.VerifyProxyWitness(script),
            "The exact five-argument sponsored envelope must pass the proxy's witness verification");

        // 2. Executing the same bytes moves the account's assets and settles the sponsor.
        h.Execute(script);

        Assert.AreEqual(proxyBefore - TransferAmount, h.Fx.GasBalanceOf(h.Proxy),
            "The virtual account pays exactly the signed amount out of its proxy address");
        Assert.AreEqual(recipientBefore + TransferAmount, h.Fx.GasBalanceOf(Recipient),
            "The signed recipient receives the transfer");
        Assert.AreEqual(BigInteger.One, h.Fx.CurrentNonceSequence(h.Wallet, h.Account, 0),
            "The executed operation consumes the account nonce");
        Assert.AreEqual(depositBefore - reimbursement,
            h.Fx.CallInteger(h.Paymaster, "getSponsorDeposit", Sponsor),
            "The sponsor deposit pays the relay reimbursement");
        Assert.AreEqual(relayBefore + reimbursement, h.Fx.GasBalanceOf(Relay),
            "The relay is reimbursed from the sponsor's deposit, not from the account");
    }
}
