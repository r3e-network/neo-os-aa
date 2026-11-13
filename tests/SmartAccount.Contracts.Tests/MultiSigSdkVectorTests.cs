using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Cross-language vectors: bytes emitted by the shipped JavaScript MultiSig builder must be
/// identical to Neo StdLib.Serialize and accepted only in the configured child verifier order.
/// Two separately deployed SessionKey verifiers use distinct real P-256 keys so a copied proof
/// cannot count as a second child's authorization. No secret key is passed to Node.js.
/// </summary>
[TestClass]
public class MultiSigSdkVectorTests
{
    private static readonly string RepoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
    private static readonly UInt160 OtherDeployer = UInt160.Parse("0x6262626262626262626262626262626262626262");
    private static readonly UInt160 Recipient = UInt160.Parse("0x6363636363636363636363636363636363636363");

    private sealed class Harness : IDisposable
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Account { get; }
        public UInt160 Target { get; }
        public UInt160 MultiSig { get; }
        public UInt160[] Children { get; }
        public object?[] Args { get; }
        public BigInteger Deadline { get; }
        private readonly bool reuseSigner;
        private readonly P256SessionKey firstKey = new();
        private readonly P256SessionKey secondKey = new();

        public Harness(int threshold, bool reuseSigner = false)
        {
            this.reuseSigner = reuseSigner;
            Core = Fx.Deploy("SmartAccountV3");
            Target = Fx.Deploy("MockTransferTarget");
            UInt160 first = Fx.Deploy("verifiers/SessionKeyVerifier", Core.ToArray());
            // Deployment identity includes the sender; obtain two distinct contract instances.
            Fx.SetSigners(OtherDeployer);
            UInt160 second = Fx.Deploy("verifiers/SessionKeyVerifier", Core.ToArray());
            Fx.SetSigners(Fx.Engine.ValidatorsAddress);
            Assert.AreNotEqual(first, second);
            Children = new[] { first, second };
            MultiSig = Fx.Deploy("verifiers/MultiSigVerifier", Core.ToArray());
            UInt160 owner = Fx.Engine.ValidatorsAddress;
            Account = Fx.CallUInt160(Core, "computeRegistrationAccountId", MultiSig, Array.Empty<byte>(), UInt160.Zero, owner, 2592000u);
            Fx.CallVoid(Core, "registerAccount", Account, MultiSig, Array.Empty<byte>(), UInt160.Zero, owner, 2592000u);
            object?[] configArgs = { Account, Children.Cast<object?>().ToArray(), threshold };
            Assert.IsFalse(Fx.CallBoolean(Core, "callVerifier", Account, "setConfig", configArgs));
            Fx.AdvanceTime(TimeSpan.FromHours(24));
            Fx.CallVoid(Core, "callVerifier", Account, "setConfig", configArgs);
            byte[] secondPublicKey = reuseSigner ? firstKey.CompressedPublicKey : secondKey.CompressedPublicKey;
            // Audit fix M-1: each SessionKey child is configured through the core's timelocked
            // callVerifierChild path (stage, 24h, confirm); direct child configuration is
            // rejected. The key must outlive the two timelock advances below.
            BigInteger sessionValidUntil = Fx.Now() + 25L * 24 * 60 * 60 * 1000;
            ConfigureChildSessionKey(first, firstKey.CompressedPublicKey, sessionValidUntil);
            ConfigureChildSessionKey(second, secondPublicKey, sessionValidUntil);
            UInt160 asset = Fx.CallUInt160(Core, "getProxyScriptHash", Account);
            Args = new object?[] { asset, Recipient, 25, null };
            Deadline = Fx.Now() + 600000;
            byte[] payload1 = Fx.CallBytes(Children[0], "getPayload", Account, Target, "transfer", Args, 0, Deadline);
            byte[] payload2 = Fx.CallBytes(Children[1], "getPayload", Account, Target, "transfer", Args, 0, Deadline);
            CollectionAssert.AreNotEqual(payload1, payload2, "The same operation must remain domain-separated by child verifier identity.");
        }

        public BigInteger Nonce() => Fx.CallInteger(Core, "getNonce", Account, 0);

        /// <summary>Signs each child's canonical transfer payload at the given sequence.</summary>
        public byte[][] SignChildren(BigInteger nonce)
        {
            byte[] payload1 = Fx.CallBytes(Children[0], "getPayload", Account, Target, "transfer", Args, nonce, Deadline);
            byte[] payload2 = Fx.CallBytes(Children[1], "getPayload", Account, Target, "transfer", Args, nonce, Deadline);
            return new[] { firstKey.Sign(payload1), reuseSigner ? firstKey.Sign(payload2) : secondKey.Sign(payload2) };
        }

        /// <summary>
        /// Routes the bundle through the real core's executeUserOp. Direct
        /// MultiSig.validateSignature invocations are rejected by the audit fix M-6
        /// execution gate: only the core's execution context may validate.
        /// </summary>
        public bool Execute(byte[] bundle) => Fx.CallBoolean(Core, "executeUserOp", Account,
            RuntimeFixture.UserOp(Target, "transfer", Args, Nonce(), Deadline, bundle));

        private void ConfigureChildSessionKey(UInt160 child, byte[] pubKey, BigInteger validUntil)
        {
            object?[] config = { Account, pubKey, Target, "transfer", validUntil, 100, "child session key" };
            Assert.IsFalse(Fx.CallBoolean(Core, "callVerifierChild", Account, child, "setSessionKey", config),
                "The first callVerifierChild invocation must only stage the pending child call");
            Fx.AdvanceTime(TimeSpan.FromHours(24));
            Fx.CallVoid(Core, "callVerifierChild", Account, child, "setSessionKey", config);
        }

        public byte[] Bundle(params byte[]?[] slots)
        {
            byte[] javascript = SerializeWithJavaScript(Children, slots);
            byte[] native = Fx.StdLibSerialize(slots.Cast<object?>().ToArray());
            CollectionAssert.AreEqual(native, javascript, "JavaScript bundle must match the real Neo native serializer byte-for-byte.");
            return javascript;
        }

        public void Dispose()
        {
            firstKey.Dispose();
            secondKey.Dispose();
        }
    }

    [TestMethod]
    public void JavaScriptBundle_ThresholdTwoAcceptsOrderedProofsAndRejectsShiftedOrDuplicateProofs()
    {
        using Harness h = new(threshold: 2);
        byte[][] proofs = h.SignChildren(h.Nonce());
        Assert.IsTrue(h.Execute(h.Bundle(proofs[0], proofs[1])));

        // Every rejected bundle faults at the current sequence without consuming it.
        byte[][] next = h.SignChildren(h.Nonce());
        TestException shifted = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(h.Bundle(next[1], next[0])));
        StringAssert.Contains(shifted.Message, "Verifier rejected signature");

        TestException duplicate = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(h.Bundle(next[0], next[0])));
        StringAssert.Contains(duplicate.Message, "Verifier rejected signature");

        TestException partial = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(h.Bundle(next[0], null)));
        StringAssert.Contains(partial.Message, "Verifier rejected signature");

        Assert.AreEqual(BigInteger.One, h.Nonce(), "Rejected bundles must not consume the sequence.");
    }

    [TestMethod]
    public void JavaScriptBundle_ReusedSignerAcrossChildrenCannotMeetThreshold()
    {
        using Harness h = new(threshold: 2, reuseSigner: true);
        byte[][] proofs = h.SignChildren(h.Nonce());
        TestException failure = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(h.Bundle(proofs[0], proofs[1])));
        StringAssert.Contains(failure.Message, "Duplicate signer domain");
        Assert.AreEqual(BigInteger.Zero, h.Nonce(), "A rejected bundle must not consume the sequence.");
    }

    [TestMethod]
    public void JavaScriptBundle_ThresholdOnePreservesEmptyChildSlots()
    {
        using Harness h = new(threshold: 1);
        byte[][] first = h.SignChildren(h.Nonce());
        Assert.IsTrue(h.Execute(h.Bundle(first[0], null)));

        byte[][] second = h.SignChildren(h.Nonce());
        Assert.IsTrue(h.Execute(h.Bundle(null, second[1])));

        // Empty slots are abstentions, not approval proofs, and a proof placed in the
        // wrong child slot must fail as well. Both faults leave the sequence untouched.
        TestException empty = Assert.ThrowsExactly<TestException>(() => h.Execute(h.Bundle(null, null)));
        StringAssert.Contains(empty.Message, "Verifier rejected signature");

        byte[][] third = h.SignChildren(h.Nonce());
        TestException shifted = Assert.ThrowsExactly<TestException>(() => h.Execute(h.Bundle(null, third[0])));
        StringAssert.Contains(shifted.Message, "Verifier rejected signature");

        Assert.AreEqual(new BigInteger(2), h.Nonce());
    }

    [TestMethod]
    public void JavaScriptBundle_ExecutesThroughRealCoreAndUpdatesBothChildSpendMeters()
    {
        using Harness h = new(threshold: 2);
        byte[][] proofs = h.SignChildren(0);
        byte[] bundle = h.Bundle(proofs[0], proofs[1]);
        h.Fx.SetSigners(Recipient); // The backup owner does not sign this execution.
        object[] op = RuntimeFixture.UserOp(h.Target, "transfer", h.Args, 0, h.Deadline, bundle);
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "executeUserOp", h.Account, op));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Core, "getNonce", h.Account, 0));
        foreach (UInt160 child in h.Children)
            Assert.AreEqual(new BigInteger(25), h.Fx.CallInteger(child, "getSpentAmount", h.Account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isExecutionActive", h.Account));
    }

    private static byte[] SerializeWithJavaScript(UInt160[] children, byte[]?[] signatures)
    {
        // The script imports the production builder, never an independent test serializer.
        const string script = """
            import fs from 'node:fs';
            import multisig from './sdk/js/src/multisig.js';
            const input = JSON.parse(fs.readFileSync(0, 'utf8'));
            process.stdout.write(multisig.serializeMultiSigSignatures(input.signatures));
            """;
        ProcessStartInfo start = new("node")
        {
            WorkingDirectory = RepoRoot,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add("--input-type=module");
        start.ArgumentList.Add("-e");
        start.ArgumentList.Add(script);
        using Process process = Process.Start(start) ?? throw new InvalidOperationException("Could not start Node.js for SDK/VM vector.");
        process.StandardInput.Write(JsonSerializer.Serialize(new
        {
            children = children.Select(c => c.ToString()).ToArray(),
            signatures = signatures.Select(s => s == null ? null : Convert.ToHexString(s).ToLowerInvariant()).ToArray()
        }));
        process.StandardInput.Close();
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(15000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail("JavaScript signature builder did not finish within 15 seconds.");
        }
        Assert.AreEqual(0, process.ExitCode, error.GetAwaiter().GetResult());
        string hex = output.GetAwaiter().GetResult().Trim();
        Assert.IsFalse(string.IsNullOrEmpty(hex), "JavaScript builder returned no signature bytes.");
        return Convert.FromHexString(hex);
    }
}
