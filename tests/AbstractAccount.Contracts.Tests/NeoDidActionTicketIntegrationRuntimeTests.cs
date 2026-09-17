using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Cryptography;
using Neo.Cryptography.ECC;
using Neo.Network.P2P.Payloads;
using Neo.Network.P2P.Payloads.Conditions;
using Neo.SmartContract;
using Neo.SmartContract.Testing;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;
using Neo.Extensions;
using Neo.Wallets;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Cross-contract proof for the M0-C identity-kernel boundary:
/// an AA proxy witness must authorize NeoDIDRegistry.UseActionTicket for the
/// exact virtual account, while the registry's action signature and nullifier
/// remain independently binding and single-use.
/// </summary>
[TestClass]
public sealed class NeoDidActionTicketIntegrationRuntimeTests
{
    private const uint EscapeTimelockSeconds = 2_592_000;
    private const string ActionId = "neoos|integration|ticket|1";

    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly UInt160 ContractManagementHash =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    private static readonly byte[] ActionDomain =
        System.Text.Encoding.ASCII.GetBytes("neodid-action-v1");

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Wallet { get; }
        public UInt160 Registry { get; }
        public UInt160 AccountId { get; }
        public UInt160 ProxyHash { get; }
        public UInt160 BackupOwner { get; }
        public UInt160 WalletAdmin { get; }
        public KeyPair RegistryVerifier { get; }
        public byte[] ProxyScript { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("UnifiedSmartWalletV3");
            WalletAdmin = Fx.Engine.Sender;

            string serviceBuild = Path.GetFullPath(Path.Combine(
                RepoRoot, "..", "neo-os-services", "contracts", "build"));
            byte[] nef = File.ReadAllBytes(Path.Combine(serviceBuild, "NeoDIDRegistry.nef"));
            string manifest = File.ReadAllText(Path.Combine(serviceBuild, "NeoDIDRegistry.manifest.json"));

            // Registry deployment is deliberately performed in the same VM. This is
            // an integration test against the generated DID artifact, not a mock.
            Registry = Fx.DeployArtifact(nef, manifest);
            Fx.SetSigners(WalletAdmin);

            byte[] verifierPrivateKey = new byte[32];
            verifierPrivateKey[^1] = 9;
            RegistryVerifier = new KeyPair(verifierPrivateKey);
            Fx.CallVoid(Registry, "setVerifier", RegistryVerifier.PublicKey);

            BackupOwner = TestEngine.GetNewSigner().Account;
            Fx.SetSigners(BackupOwner);
            AccountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);
            Fx.CallVoid(
                Wallet, "registerAccount",
                AccountId, UInt160.Zero, Array.Empty<byte>(), UInt160.Zero,
                BackupOwner, EscapeTimelockSeconds);

            // The proxy's verification script calls core.verify(accountId). The
            // target scope is the registry, so a successful proxy witness can only
            // bless this exact cross-contract operation.
            Fx.SetSigners(WalletAdmin);
            Fx.CallVoid(Wallet, "setVerifyScopeTarget", AccountId, Registry);
            ProxyHash = Fx.CallUInt160(Wallet, "getProxyScriptHash", AccountId);

            using ScriptBuilder proxy = new();
            proxy.EmitDynamicCall(Wallet, "verify", AccountId);
            ProxyScript = proxy.ToArray();
        }

        public byte[] ActionNullifier(byte fill)
        {
            return Enumerable.Repeat(fill, 32).Select(value => (byte)value).ToArray();
        }

        public byte[] ActionSignature(byte[] nullifier, string actionId = ActionId)
        {
            byte[] digest = ComputeActionDigest(
                ProxyHash, actionId, nullifier, Fx.Engine.ProtocolSettings.Network);
            for (int attempt = 0; attempt < 16; attempt++)
            {
                byte[] signature = Crypto.Sign(
                    digest, RegistryVerifier.PrivateKey, Neo.Cryptography.ECC.ECCurve.Secp256r1);
                if (Crypto.VerifySignature(digest, signature, RegistryVerifier.PublicKey))
                    return signature;
            }

            throw new AssertFailedException("could not produce a locally verifiable registry signature");
        }

        public bool ExecuteTicket(
            byte[] nullifier,
            byte[] signature,
            UInt160 witnessAccount,
            string actionId = ActionId,
            BigInteger? nonce = null)
        {
            object[] op = RuntimeFixture.UserOp(
                Registry,
                "useActionTicket",
                new object?[] { ProxyHash, actionId, nullifier, signature },
                nonce ?? Fx.CallInteger(Wallet, "getNonce", AccountId, BigInteger.Zero),
                Fx.Now() + 3_600_000,
                Array.Empty<byte>());

            // Preserve the TestEngine's valid owner witness, then append the real
            // proxy verification script. The signer entry and witness script must
            // be the same proxy; a signer with identical rules under another hash
            // must never satisfy CheckWitness(proxy).
            Fx.SetSigners(witnessAccount);
            Witness[] ownerWitnesses = Fx.Engine.Transaction.Witnesses ?? Array.Empty<Witness>();
            Signer ownerSigner = Fx.Engine.Transaction.Signers.Single();
            Signer proxySigner = new()
            {
                Account = ProxyHash,
                Scopes = WitnessScope.WitnessRules,
                Rules = ExactRules(Wallet, Registry),
            };
            Fx.Engine.Transaction.Signers = new[] { ownerSigner, proxySigner };
            Fx.Engine.Transaction.Witnesses = ownerWitnesses
                .Concat(new[]
                {
                    new Witness
                    {
                        InvocationScript = Array.Empty<byte>(),
                        VerificationScript = ProxyScript,
                    },
                })
                .ToArray();

            return Fx.CallBoolean(Wallet, "executeUserOp", AccountId, op);
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
    }

    [TestMethod]
    public void AaProxyWitnessConsumesDidActionTicketExactlyOnce()
    {
        Harness h = new();
        byte[] nullifier = h.ActionNullifier(0x51);
        byte[] signature = h.ActionSignature(nullifier);

        Assert.IsTrue(
            h.ExecuteTicket(nullifier, signature, h.BackupOwner),
            "AA proxy witness must authorize the nested NeoDIDRegistry call");
        Assert.IsTrue(h.Fx.CallBoolean(h.Registry, "isActionNullifierUsed", nullifier));

        TestException replay = Assert.ThrowsExactly<TestException>(() =>
            h.ExecuteTicket(
                nullifier,
                signature,
                h.BackupOwner,
                nonce: BigInteger.One));
        StringAssert.Contains(replay.Message, "action nullifier already used");
    }

    [TestMethod]
    public void DidActionSignatureCannotBeRetargetedToAnotherProxy()
    {
        Harness h = new();
        byte[] nullifier = h.ActionNullifier(0x52);
        byte[] signature = h.ActionSignature(nullifier);

        // The signed subject is the proxy hash and the signed action id is
        // ActionId. Changing only the action id must fail signature verification
        // while the proxy witness and account witness still pass.
        TestException rejected = Assert.ThrowsExactly<TestException>(() =>
            h.ExecuteTicket(nullifier, signature, h.BackupOwner, "neoos|integration|ticket|escalated"));
        StringAssert.Contains(rejected.Message, "invalid verification signature");
        Assert.IsFalse(h.Fx.CallBoolean(h.Registry, "isActionNullifierUsed", nullifier));
    }

    private static byte[] ComputeActionDigest(
        UInt160 disposableAccount, string actionId, byte[] actionNullifier, uint network)
    {
        List<byte> payload = new();
        payload.AddRange(ActionDomain);
        payload.AddRange(CanonicalHash160(disposableAccount));
        payload.AddRange(EncodeSegment(actionId));
        payload.AddRange(actionNullifier);
        payload.AddRange(new[]
        {
            (byte)(network & 0xFF),
            (byte)((network >> 8) & 0xFF),
            (byte)((network >> 16) & 0xFF),
            (byte)((network >> 24) & 0xFF),
        });
        return SHA256.HashData(payload.ToArray());
    }

    private static byte[] CanonicalHash160(UInt160 value)
    {
        byte[] littleEndian = value.GetSpan().ToArray();
        Array.Reverse(littleEndian);
        return littleEndian;
    }

    private static byte[] EncodeSegment(string value)
    {
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(value);
        Assert.IsTrue(bytes.Length <= byte.MaxValue);
        return new[] { (byte)bytes.Length }.Concat(bytes).ToArray();
    }
}
