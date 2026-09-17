using System;
using System.IO;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.Network.P2P.Payloads.Conditions;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Executes the byte-for-byte mainnet artifact against the proxy-signer witness path.
/// </summary>
/// <remarks>
/// The fixture at fixtures/deployed-mainnet was read back from the live contract through
/// ContractManagement.getContract and its SHA-256 is asserted below, so these tests cannot
/// silently drift onto a different build. Mainnet runs updateCounter 4. The final case
/// asserts the *current deployed* behaviour, which is the vulnerability reported in
/// docs/AA-PROXY-SIGNER-SCOPE-20260912.md; after a governed upgrade it must be flipped to
/// assert rejection. No chain write, key use or deployment is performed here.
/// </remarks>
[TestClass]
public class DeployedMainnetProxyWitnessTests
{
    private const string MainnetNefSha256 = "009b1b499a87dab1c17c5ed732717af294ae615fc05e1fc958fe712eb443c3ba";

    private static string FixtureDir => Path.Combine(
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../")),
        "tests", "AbstractAccount.Contracts.Tests", "fixtures", "deployed-mainnet");

    private static byte[] FixtureNef()
    {
        byte[] nef = File.ReadAllBytes(Path.Combine(FixtureDir, "UnifiedSmartWalletV3.nef"));
        Assert.AreEqual(MainnetNefSha256, Convert.ToHexString(SHA256.HashData(nef)).ToLowerInvariant(),
            "The pinned mainnet artifact changed; re-read it from chain and update the finding.");
        return nef;
    }

    private static string FixtureManifest() =>
        File.ReadAllText(Path.Combine(FixtureDir, "UnifiedSmartWalletV3.manifest.json"));

    private static UInt160 DeployMainnetWallet(RuntimeFixture fx)
    {
        byte[] nef = FixtureNef();
        string manifest = FixtureManifest();
        ContractManifest parsed = ContractManifest.Parse(manifest);
        UInt160 hash = fx.Engine.GetDeployHash(NefFile.Parse(nef, verify: true), parsed);
        Assert.AreEqual(hash, fx.DeployArtifact(nef, manifest), "deployed hash mismatch");
        return hash;
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

    private static bool VerifyWitness(RuntimeFixture fx, UInt160 wallet, UInt160 target,
        UInt160 accountId, bool globalProxy, bool decoy)
    {
        using ScriptBuilder proxy = new();
        proxy.EmitDynamicCall(wallet, "verify", accountId);
        byte[] proxyScript = proxy.ToArray();
        byte[] decoyScript = { (byte)OpCode.PUSH1 };

        var proxySigner = new Signer
        {
            Account = proxyScript.ToScriptHash(),
            Scopes = globalProxy ? WitnessScope.Global : WitnessScope.WitnessRules,
            Rules = globalProxy ? Array.Empty<WitnessRule>() : ExactRules(wallet, target),
        };
        var proxyWitness = new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = proxyScript };

        Transaction tx = new()
        {
            Script = new byte[] { (byte)OpCode.RET },
            Attributes = Array.Empty<TransactionAttribute>(),
            Signers = decoy
                ? new[]
                {
                    proxySigner,
                    new Signer { Account = decoyScript.ToScriptHash(), Scopes = WitnessScope.WitnessRules, Rules = ExactRules(wallet, target) },
                }
                : new[] { proxySigner },
            Witnesses = decoy
                ? new[]
                {
                    proxyWitness,
                    new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = decoyScript },
                }
                : new[] { proxyWitness },
        };

        return Helper.VerifyWitnesses(tx, fx.Engine.ProtocolSettings, fx.Engine.Storage.Snapshot, 50_00000000);
    }

    private static (RuntimeFixture Fx, UInt160 Wallet, UInt160 Target, UInt160 AccountId) Prepare()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = DeployMainnetWallet(fx);
        UInt160 target = fx.Deploy("MockTransferTarget");
        UInt160 accountId = UInt160.Parse("0x1111111111111111111111111111111111111111");
        // _deploy records Runtime.Transaction.Sender as contract admin.
        fx.CallVoid(wallet, "setVerifyScopeTarget", accountId, target);
        Assert.AreEqual(target, fx.CallUInt160(wallet, "getVerifyScopeTarget", accountId),
            "Scope target must be configured for the vulnerability to apply");
        return (fx, wallet, target, accountId);
    }

    [TestMethod]
    public void CandidateBuild_EmitsVerifyScopeTargetEvent()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 target = fx.Deploy("MockTransferTarget");
        UInt160 accountId = UInt160.Parse("0x1111111111111111111111111111111111111111");
        fx.CallVoid(wallet, "setVerifyScopeTarget", accountId, target);
        var state = fx.SingleNotificationState(wallet, "VerifyScopeTargetSet");
        Assert.AreEqual(accountId, (UInt160)TestExtensions.ConvertTo(((Neo.VM.Types.Array)state)[0], typeof(UInt160))!);
        Assert.AreEqual(target, (UInt160)TestExtensions.ConvertTo(((Neo.VM.Types.Array)state)[1], typeof(UInt160))!);
    }

    [TestMethod]
    public void DeployedMainnet_ExactProxyRules_AreAccepted()
    {
        var (fx, wallet, target, accountId) = Prepare();
        Assert.IsTrue(VerifyWitness(fx, wallet, target, accountId, globalProxy: false, decoy: false));
    }

    [TestMethod]
    public void DeployedMainnet_GlobalProxyAlone_IsRejected()
    {
        var (fx, wallet, target, accountId) = Prepare();
        Assert.IsFalse(VerifyWitness(fx, wallet, target, accountId, globalProxy: true, decoy: false));
    }

    [TestMethod]
    public void DeployedMainnet_GlobalProxyWithDecoySigner_IsAccepted_VulnerabilityPinned()
    {
        var (fx, wallet, target, accountId) = Prepare();
        Assert.IsTrue(VerifyWitness(fx, wallet, target, accountId, globalProxy: true, decoy: true),
            "Live mainnet artifact still accepts a Global proxy backed by an unrelated decoy signer");
    }
}
