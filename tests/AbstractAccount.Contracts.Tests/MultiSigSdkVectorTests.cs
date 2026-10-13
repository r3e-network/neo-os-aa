using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;

namespace AbstractAccount.Contracts.Tests;

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
        public byte[][] Signatures { get; }
        private readonly P256SessionKey firstKey = new();
        private readonly P256SessionKey secondKey = new();

        public Harness(int threshold)
        {
            Core = Fx.Deploy("UnifiedSmartWalletV3");
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
            // Each SessionKey child supports direct backup-owner configuration; no mock authority.
            Fx.CallVoid(first, "setSessionKey", Account, firstKey.CompressedPublicKey, Target, "transfer", Fx.Now() + 600000, 100, "first child");
            Fx.CallVoid(second, "setSessionKey", Account, secondKey.CompressedPublicKey, Target, "transfer", Fx.Now() + 600000, 100, "second child");
            UInt160 asset = Fx.CallUInt160(Core, "getProxyScriptHash", Account);
            Args = new object?[] { asset, Recipient, 25, null };
            Deadline = Fx.Now() + 600000;
            byte[] payload1 = Fx.CallBytes(first, "getPayload", Account, Target, "transfer", Args, 0, Deadline);
            byte[] payload2 = Fx.CallBytes(second, "getPayload", Account, Target, "transfer", Args, 0, Deadline);
            CollectionAssert.AreNotEqual(payload1, payload2, "The same operation must remain domain-separated by child verifier identity.");
            Signatures = new[] { firstKey.Sign(payload1), secondKey.Sign(payload2) };
        }

        public bool Validate(byte[] bundle) => Fx.CallBoolean(MultiSig, "validateSignature", Account,
            RuntimeFixture.UserOp(Target, "transfer", Args, 0, Deadline, bundle));

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
        Assert.IsTrue(h.Validate(h.Bundle(h.Signatures[0], h.Signatures[1])));
        Assert.IsFalse(h.Validate(h.Bundle(h.Signatures[1], h.Signatures[0])), "Moving valid proofs into different child slots must fail.");
        Assert.IsFalse(h.Validate(h.Bundle(h.Signatures[0], h.Signatures[0])), "One child's proof cannot satisfy two independent keys.");
        Assert.IsFalse(h.Validate(h.Bundle(h.Signatures[0], null)), "One proof cannot meet a two-child threshold.");
    }

    [TestMethod]
    public void JavaScriptBundle_ThresholdOnePreservesEmptyChildSlots()
    {
        using Harness h = new(threshold: 1);
        Assert.IsTrue(h.Validate(h.Bundle(h.Signatures[0], null)));
        Assert.IsTrue(h.Validate(h.Bundle(null, h.Signatures[1])));
        Assert.IsFalse(h.Validate(h.Bundle(null, null)), "Empty slots are abstentions, not approval proofs.");
        Assert.IsFalse(h.Validate(h.Bundle(null, h.Signatures[0])), "An empty earlier slot must not shift the remaining proof to another verifier.");
    }

    [TestMethod]
    public void JavaScriptBundle_ExecutesThroughRealCoreAndUpdatesBothChildSpendMeters()
    {
        using Harness h = new(threshold: 2);
        byte[] bundle = h.Bundle(h.Signatures[0], h.Signatures[1]);
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
