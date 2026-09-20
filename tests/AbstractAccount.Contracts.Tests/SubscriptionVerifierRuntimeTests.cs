using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;
using Neo.VM.Types;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Behavioral VM tests for <c>SubscriptionVerifier</c> exercised through a real Neo execution
/// engine. Unlike the source-text invariant suites, these execute the compiled contract so the
/// billing-period throttle is validated by actual VM behavior rather than by reading the source.
/// </summary>
[TestClass]
public class SubscriptionVerifierRuntimeTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledDir = Path.Combine(RepoRoot, "contracts", "bin", "v3");
    private static readonly string VerifiersDir = Path.Combine(CompiledDir, "verifiers");

    private static readonly FieldInfo FeeAmountField =
        typeof(ApplicationEngine).GetField("_feeAmount", BindingFlags.Instance | BindingFlags.NonPublic)!;

    private static readonly UInt160 ContractManagementHash =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    private static readonly NefFile VerifierNef =
        NefFile.Parse(File.ReadAllBytes(Path.Combine(VerifiersDir, "SubscriptionVerifier.nef")), verify: true);

    private static readonly string VerifierManifestText =
        File.ReadAllText(Path.Combine(VerifiersDir, "SubscriptionVerifier.manifest.json"));

    private static readonly ContractManifest VerifierManifest = ContractManifest.Parse(VerifierManifestText);

    private static readonly NefFile CoreNef =
        NefFile.Parse(File.ReadAllBytes(Path.Combine(CompiledDir, "MockVerifierCore.nef")), verify: true);

    private static readonly string CoreManifestText =
        File.ReadAllText(Path.Combine(CompiledDir, "MockVerifierCore.manifest.json"));

    private static readonly ContractManifest CoreManifest = ContractManifest.Parse(CoreManifestText);

    private static readonly UInt160 AccountId =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static readonly UInt160 Merchant =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly UInt160 Token =
        UInt160.Parse("0x3333333333333333333333333333333333333333");

    private static readonly byte[] SubId = { 0xAB, 0xCD, 0xEF, 0x01 };

    private const long Amount = 1000;
    private const long PeriodSeconds = 2_592_000;            // 30 days
    private static readonly BigInteger PeriodMs = (BigInteger)PeriodSeconds * 1000;

    /// <summary>
    /// The merchant-pull throttle must allow at most one charge per billing period. A second
    /// charge inside the same period is rejected; the next period accepts a fresh charge.
    /// </summary>
    [TestMethod]
    public void ValidateSignature_RejectsSecondChargeInSamePeriod_AllowsChargeInNextPeriod()
    {
        Harness h = new();

        // Move at least one full billing period past genesis so currentPeriod > 0 always holds.
        h.Engine.PersistingBlock.Advance(TimeSpan.FromMilliseconds((double)PeriodMs));

        h.CreateSubscription(AccountId, SubId, Merchant, Token, Amount, PeriodSeconds);

        // --- Charge #1 in period P (nonce counter 0): must validate. ---
        BigInteger period1 = h.Now() / PeriodMs;
        Assert.IsTrue(period1 > 0, "Precondition: billing period must be greater than zero.");
        object[] charge1 = BuildTransferOp(ExpectedNonce(SubId, period1, nonceCounter: 0), h.AssetAddress);
        Assert.IsTrue(h.ValidateSignature(AccountId, charge1), "First charge in the period should be accepted.");

        // Apply post-execution effects: records the charged period and advances the nonce counter.
        h.PostExecute(AccountId, charge1);

        // --- Charge #2 in the SAME period P (nonce counter 1): must be rejected by the period gate. ---
        object[] charge2SamePeriod = BuildTransferOp(ExpectedNonce(SubId, period1, nonceCounter: 1), h.AssetAddress);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.ValidateSignature(AccountId, charge2SamePeriod),
            "A second charge within the same billing period must be rejected.");
        StringAssert.Contains(rejected.Message, "already charged this period");

        // --- Advance to the next billing period: a fresh charge must be accepted. ---
        h.Engine.PersistingBlock.Advance(TimeSpan.FromMilliseconds((double)PeriodMs));
        BigInteger period2 = h.Now() / PeriodMs;
        Assert.IsTrue(period2 > period1, "Precondition: time must advance into a later billing period.");
        object[] charge2NextPeriod = BuildTransferOp(ExpectedNonce(SubId, period2, nonceCounter: 1), h.AssetAddress);
        Assert.IsTrue(
            h.ValidateSignature(AccountId, charge2NextPeriod),
            "A charge in the next billing period should be accepted.");
    }

    /// <summary>
    /// Audit fix M-8: <c>op.Signature</c> carries no cryptographic proof (it is the public
    /// subscription id), so a charge presented without the configured merchant's witness must
    /// be rejected — otherwise any observer of the subId could trigger the pull.
    /// </summary>
    [TestMethod]
    public void ValidateSignature_RequiresMerchantWitness()
    {
        Harness h = new(merchantSigns: false);

        h.Engine.PersistingBlock.Advance(TimeSpan.FromMilliseconds((double)PeriodMs));
        h.CreateSubscription(AccountId, SubId, Merchant, Token, Amount, PeriodSeconds);

        BigInteger period = h.Now() / PeriodMs;
        object[] charge = BuildTransferOp(ExpectedNonce(SubId, period, nonceCounter: 0), h.AssetAddress);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.ValidateSignature(AccountId, charge),
            "A charge without the merchant's witness must be rejected.");
        StringAssert.Contains(rejected.Message, "merchant authorization required");
    }

    /// <summary>
    /// The account id never holds a balance: the core keeps a virtual account's assets at its
    /// proxy script hash, which is also the only <c>from</c> a token's <c>CheckWitness</c> accepts
    /// during <c>executeUserOp</c>. A pull that names the account id as the source could never
    /// move funds and must be rejected up front rather than silently consuming a billing period.
    /// </summary>
    [TestMethod]
    public void ValidateSignature_RejectsTransferSourcedFromTheAccountId()
    {
        Harness h = new();
        h.Engine.PersistingBlock.Advance(TimeSpan.FromMilliseconds((double)PeriodMs));
        h.CreateSubscription(AccountId, SubId, Merchant, Token, Amount, PeriodSeconds);
        Assert.AreNotEqual(AccountId, h.AssetAddress, "Precondition: the asset address differs from the account id");

        BigInteger period = h.Now() / PeriodMs;
        object[] charge = BuildTransferOp(ExpectedNonce(SubId, period, nonceCounter: 0), AccountId);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.ValidateSignature(AccountId, charge),
            "A pull sourced from the account id must be rejected.");
        StringAssert.Contains(rejected.Message, "Transfer source must be the account asset address");
    }

    /// <summary>
    /// Builds the UserOperation array (positional struct layout) for a subscription transfer.
    /// Field order matches <c>AbstractAccount.Verifiers.UserOperation</c>:
    /// [TargetContract, Method, Args, Nonce, Deadline, Signature].
    /// </summary>
    private static object[] BuildTransferOp(BigInteger nonce, UInt160 from) => new object[]
    {
        Token,                                              // TargetContract
        "transfer",                                         // Method
        new object[] { from, Merchant, (BigInteger)Amount }, // Args: [from, to, amount]
        nonce,                                              // Nonce
        BigInteger.Zero,                                    // Deadline (unused by this verifier)
        SubId                                               // Signature carries the subscription id
    };

    /// <summary>
    /// Reproduces the verifier's canonical ERC-4337 2D nonce derivation:
    /// (subTag &lt;&lt; 64) + nonceCounter, where subTag is the first eight bytes of SHA-256(subId)
    /// read big-endian and forms the per-subscription channel, and nonceCounter is the in-channel
    /// sequence. The billing period is enforced separately and is not encoded in the nonce.
    /// </summary>
    private static BigInteger ExpectedNonce(byte[] subId, BigInteger currentPeriod, BigInteger nonceCounter)
    {
        _ = currentPeriod;
        byte[] digest = SHA256.HashData(subId);
        BigInteger subTag = 0;
        for (int i = 0; i < 8 && i < digest.Length; i++)
        {
            subTag = (subTag << 8) + digest[i];
        }
        return (subTag << 64) + nonceCounter;
    }

    private sealed class Harness
    {
        public TestEngine Engine { get; } = new();

        public UInt160 VerifierHash { get; }

        public UInt160 CoreHash { get; }

        public UInt160 AssetAddress { get; }

        public Harness(bool merchantSigns = true)
        {
            // Audit fix M-8: validateSignature requires the configured merchant to witness the
            // pull, so charge validations sign as the merchant alongside the validators. The
            // validators stay first so they remain the transaction sender for the deploys.
            if (merchantSigns)
            {
                Engine.SetTransactionSigners(
                    new Signer { Account = Engine.ValidatorsAddress, Scopes = WitnessScope.Global },
                    new Signer { Account = Merchant, Scopes = WitnessScope.Global });
            }
            else
            {
                Engine.SetTransactionSigners(Engine.ValidatorsAddress);
            }

            CoreHash = Engine.GetDeployHash(CoreNef, CoreManifest);
            VerifierHash = Engine.GetDeployHash(VerifierNef, VerifierManifest);

            // Deploy the stub core first, then deploy the verifier bound to it as the authorized core.
            ExecuteRaw(ContractManagementHash, "deploy", CoreNef.ToArray(), CoreManifestText, null!);
            ExecuteRaw(ContractManagementHash, "deploy", VerifierNef.ToArray(), VerifierManifestText, CoreHash.ToArray());

            // A virtual account's assets live at the core-derived proxy script hash, never at the
            // account id; a subscription pull must name that address as the transfer source.
            AssetAddress = new UInt160(ExecuteRaw(CoreHash, "getProxyScriptHash", AccountId).GetSpan());
        }

        public void CreateSubscription(UInt160 accountId, byte[] subId, UInt160 merchant, UInt160 token, BigInteger amount, BigInteger periodSeconds)
        {
            // Routed through the core stub so the verifier observes the core as Runtime.CallingScriptHash.
            _ = ExecuteRaw(
                CoreHash,
                "forward",
                VerifierHash,
                "createSubscription",
                new object[] { accountId, subId, merchant, token, amount, periodSeconds });
        }

        public bool ValidateSignature(UInt160 accountId, object[] op)
        {
            return ExecuteRaw(VerifierHash, "validateSignature", accountId, op).GetBoolean();
        }

        public void PostExecute(UInt160 accountId, object[] op)
        {
            _ = ExecuteRaw(
                CoreHash,
                "forward",
                VerifierHash,
                "postExecute",
                new object[] { accountId, op, true });
        }

        public BigInteger Now() => ExecuteRaw(CoreHash, "now").GetInteger();

        private StackItem ExecuteRaw(UInt160 targetHash, string method, params object?[] args)
        {
            // Build the System.Contract.Call manually: EmitDynamicCall's object marshaller cannot
            // express nested arrays (a UserOperation, or the forwarded arg list), but a
            // ContractParameter(Array) can, so it is assembled here instead.
            ContractParameter argsArray = new(ContractParameterType.Array)
            {
                Value = args.Select(ToParameter).ToList()
            };

            using ScriptBuilder scriptBuilder = new();
            scriptBuilder.EmitPush(argsArray);
            scriptBuilder.EmitPush((BigInteger)(int)CallFlags.All);
            scriptBuilder.EmitPush(method);
            scriptBuilder.EmitPush(targetHash.ToArray());
            scriptBuilder.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);

            return Engine.Execute(
                new Script(scriptBuilder.ToArray()),
                0,
                applicationEngine => FeeAmountField.SetValue(applicationEngine, new BigInteger(long.MaxValue)));
        }

        private static ContractParameter ToParameter(object? value) => value switch
        {
            null => new ContractParameter(ContractParameterType.Any),
            ContractParameter parameter => parameter,
            bool b => new ContractParameter(ContractParameterType.Boolean) { Value = b },
            BigInteger bi => new ContractParameter(ContractParameterType.Integer) { Value = bi },
            int i => new ContractParameter(ContractParameterType.Integer) { Value = (BigInteger)i },
            long l => new ContractParameter(ContractParameterType.Integer) { Value = (BigInteger)l },
            string s => new ContractParameter(ContractParameterType.String) { Value = s },
            byte[] bytes => new ContractParameter(ContractParameterType.ByteArray) { Value = bytes },
            UInt160 hash => new ContractParameter(ContractParameterType.Hash160) { Value = hash },
            object[] array => new ContractParameter(ContractParameterType.Array) { Value = array.Select(ToParameter).ToList() },
            _ => throw new NotSupportedException($"Unsupported argument type: {value.GetType()}")
        };
    }
}
