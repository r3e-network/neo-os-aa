using System;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.Network.P2P.Payloads.Conditions;
using Neo.SmartContract;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Behavioral tests for the AA proxy witness path used by virtual accounts: the
/// proxy address is the hash of a script that calls <c>core.verify(accountId)</c>,
/// and it authorizes an operation only through its own restricted signer.
/// </summary>
/// <remarks>
/// The proxy is deliberately never the fee payer. A proxy that paid its own fees
/// would turn a shaped-but-faulting transaction into a GAS leak from the virtual
/// account, so the contract rejects that arrangement outright. The transaction
/// script must also be exactly one <c>executeUserOp</c>/<c>executeUserOps</c> call
/// on the core for this account, which is what ties the witness to a real
/// account-authorized operation instead of an arbitrary script that merely lists
/// the proxy as a signer.
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
    private static byte[] AccountBoundScript(UInt160 core, string method, int opBytes, UInt160? accountId = null)
    {
        using ScriptBuilder sb = new();
        sb.EmitPush(new byte[opBytes]);
        sb.EmitPush((accountId ?? AccountId).GetSpan().ToArray());
        sb.EmitPush(2);
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

    private static WitnessRule[] ExactRules(UInt160 wallet, UInt160 target) => new[]
    {
        new WitnessRule
        {
            Action = WitnessRuleAction.Allow,
            Condition = new OrCondition
            {
                Expressions = new WitnessCondition[]
                {
                    new CalledByContractCondition { Hash = wallet },
                    new CalledByContractCondition { Hash = target },
                },
            },
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
            Wallet = Fx.Deploy("UnifiedSmartWalletV3");
            Target = Fx.Deploy("MockTransferTarget");
            Fx.CallVoid(Wallet, "setVerifyScopeTarget", AccountId, Target);
            Assert.AreEqual(Target, Fx.CallUInt160(Wallet, "getVerifyScopeTarget", AccountId),
                "Scope target must be configured for this path to apply");

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
                Rules = globalProxy ? Array.Empty<WitnessRule>() : ExactRules(Wallet, Target),
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
                    new Signer { Account = decoyScript.ToScriptHash(), Scopes = WitnessScope.WitnessRules, Rules = ExactRules(Wallet, Target) },
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
}
