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

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Executes the byte-for-byte mainnet artifact against the proxy-signer witness path.
/// </summary>
/// <remarks>
/// The fixture at fixtures/deployed-mainnet is pinned to the tracked byte anchor used by
/// the recorded read-back report, and its SHA-256 is asserted below, so these tests cannot
/// silently drift onto a different build. The final case verifies that the anchored build
/// rejects a global proxy backed by an unrelated decoy signer. No chain write, key use or
/// deployment is performed here.
/// </remarks>
[TestClass]
public class DeployedMainnetProxyWitnessTests
{
    private const string MainnetNefSha256 = "c634ab9821c83bdb53b342d64359183cff2b917ac2dc5bdd9b57613494d09b4b";

    private static string FixtureDir => Path.Combine(
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../")),
        "tests", "SmartAccount.Contracts.Tests", "fixtures", "deployed-mainnet");

    private static string ContractsBuildDir => Path.Combine(
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../")),
        "contracts", "build");

    private static byte[] FixtureNef()
    {
        // The checked-in file follows the repository's current contract name, but
        // its bytes are the immutable mainnet deployment: the on-chain manifest
        // still declares `UnifiedSmartWalletV3`, and renaming a source tree cannot
        // rename a deployed contract. The pinned hash below is the real identity.
        byte[] nef = File.ReadAllBytes(Path.Combine(FixtureDir, "SmartAccountV3.nef"));
        Assert.AreEqual(MainnetNefSha256, Convert.ToHexString(SHA256.HashData(nef)).ToLowerInvariant(),
            "The pinned mainnet artifact changed; re-read it from chain and update the finding.");
        return nef;
    }

    private static string FixtureManifest() =>
        File.ReadAllText(Path.Combine(FixtureDir, "SmartAccountV3.manifest.json"));

    [TestMethod]
    public void DeployedMainnet_FixtureMatchesTrackedBuildAnchor()
    {
        CollectionAssert.AreEqual(
            File.ReadAllBytes(Path.Combine(ContractsBuildDir, "SmartAccount.nef")),
            File.ReadAllBytes(Path.Combine(FixtureDir, "SmartAccountV3.nef")),
            "The deployed-mainnet fixture must be the tracked byte anchor used by the read-back report.");
        CollectionAssert.AreEqual(
            File.ReadAllBytes(Path.Combine(ContractsBuildDir, "SmartAccount.manifest.json")),
            File.ReadAllBytes(Path.Combine(FixtureDir, "SmartAccountV3.manifest.json")),
            "The deployed-mainnet manifest must match the tracked byte anchor used by the read-back report.");
    }

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

    private static byte[] AccountBoundExecutionScript(UInt160 wallet, UInt160 accountId)
    {
        using ScriptBuilder scriptBuilder = new();
        scriptBuilder.EmitPush(new byte[16]);
        scriptBuilder.EmitPush(accountId.ToArray());
        scriptBuilder.EmitPush(2);
        scriptBuilder.Emit(OpCode.PACK);
        scriptBuilder.EmitPush((byte)CallFlags.All);
        scriptBuilder.EmitPush("executeUserOp");
        scriptBuilder.EmitPush(wallet.ToArray());
        scriptBuilder.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
        return scriptBuilder.ToArray();
    }

    private static bool VerifyWitness(RuntimeFixture fx, UInt160 wallet, UInt160 target,
        UInt160 accountId, bool globalProxy, bool decoy)
    {
        using ScriptBuilder proxy = new();
        proxy.EmitDynamicCall(wallet, "verify", accountId);
        byte[] proxyScript = proxy.ToArray();
        byte[] senderScript = { (byte)OpCode.PUSH1 };
        byte[] decoyScript = { (byte)OpCode.PUSH0 };

        var proxySigner = new Signer
        {
            Account = proxyScript.ToScriptHash(),
            Scopes = globalProxy ? WitnessScope.Global : WitnessScope.WitnessRules,
            Rules = globalProxy ? Array.Empty<WitnessRule>() : ExactRules(wallet, target),
        };
        var proxyWitness = new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = proxyScript };

        Transaction tx = new()
        {
            Script = AccountBoundExecutionScript(wallet, accountId),
            Attributes = Array.Empty<TransactionAttribute>(),
            Signers = decoy
                ? new[]
                {
                    new Signer { Account = senderScript.ToScriptHash(), Scopes = WitnessScope.CalledByEntry },
                    proxySigner,
                    new Signer { Account = decoyScript.ToScriptHash(), Scopes = WitnessScope.WitnessRules, Rules = ExactRules(wallet, target) },
                }
                : new[]
                {
                    new Signer { Account = senderScript.ToScriptHash(), Scopes = WitnessScope.CalledByEntry },
                    proxySigner,
                },
            Witnesses = decoy
                ? new[]
                {
                    new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = senderScript },
                    proxyWitness,
                    new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = decoyScript },
                }
                : new[]
                {
                    new Witness { InvocationScript = Array.Empty<byte>(), VerificationScript = senderScript },
                    proxyWitness,
                },
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
        UInt160 wallet = fx.Deploy("SmartAccount");
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
    public void DeployedMainnet_GlobalProxyWithDecoySigner_IsRejected()
    {
        var (fx, wallet, target, accountId) = Prepare();
        Assert.IsFalse(VerifyWitness(fx, wallet, target, accountId, globalProxy: true, decoy: true),
            "The tracked mainnet anchor must reject a Global proxy backed by an unrelated decoy signer");
    }
}
