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
/// Cross-language vectors for the protocol v4 threshold-policy signature DTO
/// (docs/SA-MODULE-PROTOCOL.md §5): bytes emitted by the shipped JavaScript
/// encoder must be identical to Neo StdLib.Serialize, and the real core must
/// accept them only in strictly ascending member-id order with the configured
/// threshold of distinct members approving.
///
/// The v3 suite pinned a root MultiSig verifier that owned a child roster, a
/// single-occupancy pending child call and a per-child spend meter. v4 retired
/// that layer: the account installs one <c>MultiSigValidator</c> instance per
/// co-signer, the core owns the threshold policy (§3.5), and field 11 is the
/// serialized member list <c>[[memberId, signature], ...]</c>. The vector below
/// pins that DTO, so a JavaScript client and the VM agree byte-for-byte before
/// the chain ever sees the signature.
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
        public UInt160 Target { get; }
        public UInt160 MemberA { get; }
        public UInt160 MemberB { get; }
        public P256SessionKey CustodyKey { get; } = new();
        public P256SessionKey KeyA { get; } = new();
        public P256SessionKey KeyB { get; } = new();
        public UInt160 Custody { get; }
        public UInt160 Account { get; }
        public BigInteger IdA { get; }
        public BigInteger IdB { get; }
        public BigInteger PolicyId { get; }
        public object?[] Args { get; }
        public BigInteger Deadline { get; }

        public Harness(int threshold)
        {
            Core = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            MemberA = Fx.Deploy("validators/MultiSigValidator", Core.ToArray());
            // Deployment identity includes the sender; obtain two distinct instances.
            Fx.SetSigners(OtherDeployer);
            MemberB = Fx.Deploy("validators/MultiSigValidator", Core.ToArray());
            Fx.SetSigners(Fx.Engine.ValidatorsAddress);
            Assert.AreNotEqual(MemberA, MemberB);

            Custody = RuntimeFixture.CustodyOf(CustodyKey);
            Account = Fx.CreateAccount(Core, Custody, "multisig-sdk-vector",
                Fx.InstallValidator(MemberA, "setMemberKey", KeyA.CompressedPublicKey),
                Fx.InstallValidator(MemberB, "setMemberKey", KeyB.CompressedPublicKey));

            BigInteger[] ids = Fx.ModuleIds(Core, Account, RuntimeFixture.ModuleTypeNameValidator);
            Assert.AreEqual(2, ids.Length, "Both co-signer instances must be installed");
            IdA = ids[0];
            IdB = ids[1];
            Assert.IsTrue(IdA < IdB, "Member ids follow core allocation order");

            // The policy id comes from the same monotonic allocator as module
            // instances, so it is IdB + 1 for a fresh account.
            PolicyId = IdB + 1;
            Fx.ConfigureAfterTimelock(Core, Account, Custody,
                (object)RuntimeFixture.SetThresholdPolicy(0, threshold, ids, true));

            UInt160 asset = Fx.CallUInt160(Core, "getProxyScriptHash", Account);
            Args = new object?[] { asset, Recipient, (BigInteger)25, null };
            Deadline = Fx.Now() + 3_600_000;
        }

        public BigInteger ConfigurationNonce() => Fx.AccountConfigurationNonce(Core, Account);

        /// <summary>The policy route's packed channel‖sequence nonce at the current cursor.</summary>
        public BigInteger Nonce() => Fx.PackedNonce(Core, Account, PolicyId);

        public object[] ThresholdOp(BigInteger sequence)
        {
            BigInteger mask = (BigInteger.One << 64) - 1;
            return RuntimeFixture.UserOp(Target, "transfer", Args,
                (Nonce() & ~mask) | sequence, Deadline, new byte[] { 0x00 },
                validatorId: PolicyId, credentialGeneration: 1,
                configurationNonce: ConfigurationNonce());
        }

        public byte[] OperationDigest(object[] op)
        {
            object[] probe = (object[])op.Clone();
            probe[11] = new byte[] { 0x00 };
            return Fx.CallBytes(Core, "getOperationDigest", Account, probe);
        }

        /// <summary>One member's 64-byte signature over the §5 member digest.</summary>
        public byte[] Sign(BigInteger memberId, UInt160 member, P256SessionKey key, byte[] operationDigest)
        {
            byte[] digest = Fx.CallBytes(member, "getMemberDigest", Account, memberId, operationDigest);
            return key.Sign(digest);
        }

        /// <summary>
        /// The JavaScript encoder's bytes for the signed member list, asserted to be
        /// exactly what the native serializer produces for the same list.
        /// </summary>
        public byte[] Bundle(params (BigInteger MemberId, byte[] Signature)[] entries)
        {
            object?[] native = new object?[entries.Length];
            object?[] javascript = new object?[entries.Length];
            for (int i = 0; i < entries.Length; i++)
            {
                native[i] = new object?[] { entries[i].MemberId, entries[i].Signature };
                javascript[i] = new object?[] { entries[i].MemberId.ToString(), Convert.ToHexString(entries[i].Signature).ToLowerInvariant() };
            }

            byte[] encoded = RunSerializer("member", javascript, expectSuccess: true, out _);
            CollectionAssert.AreEqual(Fx.StdLibSerialize(native), encoded,
                "The JavaScript member list must match the real Neo native serializer byte-for-byte.");
            return encoded;
        }

        /// <summary>Executes a policy-routed transfer at <paramref name="sequence"/> with the given member list.</summary>
        public bool Execute(BigInteger sequence, byte[] bundle)
        {
            object[] op = ThresholdOp(sequence);
            op[11] = bundle;
            return Fx.CallBoolean(Core, "executeUserOp", Account, (object)op);
        }

        public void Dispose()
        {
            CustodyKey.Dispose();
            KeyA.Dispose();
            KeyB.Dispose();
        }
    }

    [TestMethod]
    public void JavaScriptMemberListVectorIsByteIdenticalToTheNativeSerializer()
    {
        // A 64-byte member signature and two member ids whose little-endian
        // integer form differs in width, so the vector pins the Integer encoding.
        string signature = new('1', 128);
        byte[] native = new RuntimeFixture().StdLibSerialize(new object?[]
        {
            new object?[] { (BigInteger)1, Convert.FromHexString(signature) },
            new object?[] { (BigInteger)300, Convert.FromHexString(signature) }
        });
        byte[] javascript = RunSerializer("member", new object?[]
        {
            new object?[] { "1", signature },
            new object?[] { "300", signature }
        }, expectSuccess: true, out _);

        CollectionAssert.AreEqual(native, javascript,
            "The JavaScript member-list encoder must reproduce StdLib.Serialize exactly");
        string hex = Convert.ToHexString(javascript).ToLowerInvariant();
        StringAssert.Contains(hex, "21022c01", "Member id 300 must serialize as a two-byte little-endian integer");
        StringAssert.Contains(hex, "2840" + signature, "A member signature is a 64-byte ByteString");
    }

    [TestMethod]
    public void JavaScriptBundle_ThresholdTwoAcceptsOrderedProofsAndRejectsShiftedOrPartialEntries()
    {
        using Harness h = new(threshold: 2);

        // Ordered: each entry carries the signature of the member that owns it.
        byte[] digest = h.OperationDigest(h.ThresholdOp(0));
        byte[] first = h.Sign(h.IdA, h.MemberA, h.KeyA, digest);
        byte[] second = h.Sign(h.IdB, h.MemberB, h.KeyB, digest);
        Assert.IsTrue(h.Execute(0, h.Bundle((h.IdA, first), (h.IdB, second))));
        Assert.AreEqual(BigInteger.One, h.Nonce() & ((BigInteger.One << 64) - 1),
            "An accepted policy operation consumes exactly one sequence");

        // Shifted: ids stay ascending, but each signature is addressed to the
        // other member, so neither member approves.
        byte[] nextDigest = h.OperationDigest(h.ThresholdOp(1));
        byte[] nextFirst = h.Sign(h.IdA, h.MemberA, h.KeyA, nextDigest);
        byte[] nextSecond = h.Sign(h.IdB, h.MemberB, h.KeyB, nextDigest);
        TestException shifted = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(1, h.Bundle((h.IdA, nextSecond), (h.IdB, nextFirst))));
        StringAssert.Contains(shifted.Message, "SA_VALIDATION_REJECTED");

        // Partial: one approving member cannot reach a threshold of two.
        TestException partial = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(1, h.Bundle((h.IdA, nextFirst))));
        StringAssert.Contains(partial.Message, "SA_VALIDATION_REJECTED");

        Assert.AreEqual(BigInteger.One, h.Nonce() & ((BigInteger.One << 64) - 1),
            "Rejected bundles must not consume the sequence");
    }

    [TestMethod]
    public void JavaScriptEncoderRefusesAndTheCoreRejectsDuplicateMemberIds()
    {
        using Harness h = new(threshold: 2);
        byte[] digest = h.OperationDigest(h.ThresholdOp(0));
        byte[] first = h.Sign(h.IdA, h.MemberA, h.KeyA, digest);

        // The §5 list is strictly ascending by member id, so a duplicated id is
        // unrepresentable: the encoder refuses to build it.
        RunSerializer("member", new object?[]
        {
            new object?[] { h.IdA.ToString(), Convert.ToHexString(first).ToLowerInvariant() },
            new object?[] { h.IdA.ToString(), Convert.ToHexString(first).ToLowerInvariant() }
        }, expectSuccess: false, out string encoderError);
        StringAssert.Contains(encoderError, "strictly ascending");

        // And the core enforces the same rule on the wire, whatever produced the bytes.
        byte[] duplicated = h.Fx.StdLibSerialize(new object?[]
        {
            new object?[] { h.IdA, first },
            new object?[] { h.IdA, first }
        });
        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.Execute(0, duplicated));
        StringAssert.Contains(rejected.Message, "Member signatures not strictly ascending");
    }

    [TestMethod]
    public void JavaScriptBundle_ThresholdOneAcceptsEitherSingleMemberEntry()
    {
        using Harness h = new(threshold: 1);

        byte[] first = h.OperationDigest(h.ThresholdOp(0));
        Assert.IsTrue(h.Execute(0, h.Bundle((h.IdB, h.Sign(h.IdB, h.MemberB, h.KeyB, first)))));

        byte[] second = h.OperationDigest(h.ThresholdOp(1));
        Assert.IsTrue(h.Execute(1, h.Bundle((h.IdA, h.Sign(h.IdA, h.MemberA, h.KeyA, second)))));

        // A member entry that approves nothing still cannot reach the threshold,
        // and the failure leaves the sequence untouched.
        byte[] third = h.OperationDigest(h.ThresholdOp(2));
        TestException empty = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(2, h.Bundle((h.IdA, h.Sign(h.IdB, h.MemberB, h.KeyB, third)))));
        StringAssert.Contains(empty.Message, "SA_VALIDATION_REJECTED");

        Assert.AreEqual(new BigInteger(2), h.Nonce() & ((BigInteger.One << 64) - 1));
    }

    [TestMethod]
    public void PolicyMemberIsNeverIndependentlyRoutable()
    {
        using Harness h = new(threshold: 2);

        // v3 refused a bundle that reused one signer across two children. v4 has
        // no child roster to duplicate; the equivalent guard is that a policy
        // member can never stand in for the policy itself, so one member key can
        // never approve an operation on its own.
        BigInteger mask = (BigInteger.One << 64) - 1;
        BigInteger packed = h.Fx.PackedNonce(h.Core, h.Account, h.IdA);
        object[] op = RuntimeFixture.UserOp(h.Target, "transfer", h.Args, packed & ~mask,
            h.Deadline, new byte[] { 0x00 }, validatorId: h.IdA, credentialGeneration: 1,
            configurationNonce: h.ConfigurationNonce());
        byte[] digest = h.OperationDigest(op);
        op[11] = h.Sign(h.IdA, h.MemberA, h.KeyA, digest);

        TestException failure = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallBoolean(h.Core, "executeUserOp", h.Account, (object)op));
        StringAssert.Contains(failure.Message, "SA_MODULE_NOT_ROUTABLE");
        Assert.AreEqual(BigInteger.Zero, h.Nonce() & ((BigInteger.One << 64) - 1),
            "A rejected routing must not consume the policy sequence");
    }

    [TestMethod]
    public void PolicyMemberCannotBeUninstalledWhileThePolicyReferencesIt()
    {
        using Harness h = new(threshold: 2);

        // The reference is enforced where it matters: removal is refused and the
        // installed set is unchanged, so a policy can never be hollowed out by
        // removing one of its members.
        TestException rejected = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.ConfigureAfterTimelock(h.Core, h.Account, h.Custody,
                (object)RuntimeFixture.UninstallModule(h.IdA)));
        StringAssert.Contains(rejected.Message, "SA_INTENT_CONFLICT");
        Assert.IsTrue(h.Fx.ModuleIds(h.Core, h.Account, RuntimeFixture.ModuleTypeNameValidator).Contains(h.IdA),
            "A refused uninstall leaves the referencing policy and its member intact");
    }

    [TestMethod]
    public void DeactivatingAPolicyReleasesItsMembers()
    {
        using Harness h = new(threshold: 2);

        // The member back-pointer the routing check reads is written by the
        // policy executor, so this vector drives that index through both edges:
        // live policy (refused) and deactivated policy (released).
        object[] MemberOp(BigInteger memberId)
        {
            BigInteger mask = (BigInteger.One << 64) - 1;
            BigInteger packed = h.Fx.PackedNonce(h.Core, h.Account, memberId);
            object[] op = RuntimeFixture.UserOp(h.Target, "transfer", h.Args, packed & ~mask,
                h.Fx.Now() + 3_600_000, new byte[] { 0x00 }, validatorId: memberId, credentialGeneration: 1,
                configurationNonce: h.ConfigurationNonce());
            op[11] = h.Sign(memberId, h.MemberA, h.KeyA, h.OperationDigest(op));
            return op;
        }

        TestException routed = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallBoolean(h.Core, "executeUserOp", h.Account, (object)MemberOp(h.IdA)));
        StringAssert.Contains(routed.Message, "SA_MODULE_NOT_ROUTABLE");

        // Deactivation carries no members (§5); the executor clears the stale
        // back-pointers of the previous roster as part of the same action.
        h.Fx.ConfigureAfterTimelock(h.Core, h.Account, h.Custody,
            (object)RuntimeFixture.SetThresholdPolicy(h.PolicyId, 0, new BigInteger[0], false));

        // The routing gate no longer refuses the released instance: the call
        // reaches the module. It still cannot approve anything on its own —
        // MultiSigValidator reports false whenever it is the routed validator
        // (§3.5) — so releasing a policy never turns one co-signing key into a
        // wallet.
        TestException released = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallBoolean(h.Core, "executeUserOp", h.Account, (object)MemberOp(h.IdA)));
        StringAssert.Contains(released.Message, "SA_VALIDATION_REJECTED");
        Assert.IsFalse(released.Message.Contains("SA_MODULE_NOT_ROUTABLE", StringComparison.Ordinal),
            released.Message);

        h.Fx.ConfigureAfterTimelock(h.Core, h.Account, h.Custody,
            (object)RuntimeFixture.UninstallModule(h.IdA));
        Assert.IsFalse(h.Fx.ModuleIds(h.Core, h.Account, RuntimeFixture.ModuleTypeNameValidator).Contains(h.IdA),
            "Nothing references the released member, so its slot is removable");
    }

    [TestMethod]
    public void JavaScriptBundle_ExecutesThroughRealCoreWithoutCustodyWitness()
    {
        using Harness h = new(threshold: 2);
        byte[] digest = h.OperationDigest(h.ThresholdOp(0));
        byte[] bundle = h.Bundle(
            (h.IdA, h.Sign(h.IdA, h.MemberA, h.KeyA, digest)),
            (h.IdB, h.Sign(h.IdB, h.MemberB, h.KeyB, digest)));

        object[] op = h.ThresholdOp(0);
        op[11] = bundle;
        h.Fx.SetSigners(Recipient); // No custody witness: the policy is the authority.
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "executeUserOp", h.Account, (object)op));
        Assert.AreEqual(BigInteger.One, h.Nonce() & ((BigInteger.One << 64) - 1));
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isExecutionActive", h.Account));
    }

    /// <summary>Runs the shipped JavaScript encoder and returns the bytes it produced.</summary>
    private static byte[] RunSerializer(string kind, object?[] entries, bool expectSuccess, out string error)
    {
        // The script imports the production encoder, never an independent test serializer.
        const string script = """
            import fs from 'node:fs';
            import multisig from './sdk/js/src/multisig.js';
            const input = JSON.parse(fs.readFileSync(0, 'utf8'));
            const encode = input.kind === 'member' ? multisig.serializeMemberSignatures : multisig.serializeMultiSigSignatures;
            process.stdout.write(encode(input.entries));
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
        process.StandardInput.Write(JsonSerializer.Serialize(new { kind, entries }));
        process.StandardInput.Close();
        var output = process.StandardOutput.ReadToEndAsync();
        var diagnostics = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(15000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail("JavaScript signature builder did not finish within 15 seconds.");
        }

        string stderr = diagnostics.GetAwaiter().GetResult();
        error = stderr;
        if (!expectSuccess)
        {
            Assert.AreNotEqual(0, process.ExitCode, "The JavaScript encoder must refuse this member list");
            return Array.Empty<byte>();
        }

        Assert.AreEqual(0, process.ExitCode, stderr);
        string hex = output.GetAwaiter().GetResult().Trim();
        Assert.IsFalse(string.IsNullOrEmpty(hex), "JavaScript builder returned no signature bytes.");
        return Convert.FromHexString(hex);
    }
}
