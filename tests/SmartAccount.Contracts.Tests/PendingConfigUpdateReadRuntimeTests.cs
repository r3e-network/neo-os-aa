using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;
using Neo.VM.Types;
using VmArray = Neo.VM.Types.Array;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Read-only surface of an unresolved configuration intent (docs/SA-MODULE-PROTOCOL.md §10).
///
/// v3 exposed two single-occupancy pending slots — <c>getPendingVerifierUpdate</c> /
/// <c>getPendingHookUpdate</c> plus their <c>*Time</c> twins — that only described an
/// upgrade of one installed verifier or hook. v4 replaced them with the bounded intent
/// index: <c>getPendingConfigurationIntentIds(accountId)</c> lists every unresolved
/// intent and <c>getPendingConfiguration(accountId, intentId)</c> returns the record
/// <c>[exists, intentId, proposedAt, matureAt, expiresAt, authorityEpoch, actionDigest,
/// actions]</c> (empty array when the intent is gone). Both are <c>[Safe]</c> and need
/// no witness, so any observer can read what a 24h timelock is about to change.
/// </summary>
[TestClass]
public class PendingConfigUpdateReadRuntimeTests
{
    private static readonly UInt160 Stranger =
        UInt160.Parse("0x4545454545454545454545454545454545454545");

    /// <summary>24h module-change delay; maturity plus 7 days is the expiry window.</summary>
    private const long MatureDelayMs = 86_400_000;
    private const long ExpiryWindowMs = 604_800_000;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Target { get; }
        public UInt160 Member { get; }
        public P256SessionKey CustodyKey { get; } = new();
        public P256SessionKey KeyA { get; } = new();
        public P256SessionKey KeyB { get; } = new();
        public UInt160 Custody { get; }
        public UInt160 Account { get; }

        public Harness()
        {
            Core = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            Member = Fx.Deploy("validators/MultiSigValidator", Core.ToArray());
            Custody = RuntimeFixture.CustodyOf(CustodyKey);
            // Two unconfigured member instances: two independent configuration
            // resources (moduleId:1 and moduleId:2).
            Account = Fx.CreateAccount(Core, Custody, "pending-intent-read",
                Fx.InstallValidator(Member), Fx.InstallValidator(Member));
        }

        public object Configure(int moduleId, P256SessionKey key) =>
            RuntimeFixture.ConfigureModule(moduleId, "setMemberKey", key.CompressedPublicKey);

        public BigInteger Propose(params object[] actions) =>
            Fx.ProposeConfiguration(Core, Account, Custody, actions);

        public void Confirm(BigInteger intentId, params object[] actions) =>
            Fx.ConfirmConfiguration(Core, Account, Custody, intentId, actions);

        public BigInteger[] PendingIds() =>
            ((VmArray)Read("getPendingConfigurationIntentIds", Account))
                .Select(item => item.GetInteger()).ToArray();

        public VmArray? Pending(BigInteger intentId, bool asStranger = false)
        {
            if (asStranger) Fx.SetSigners(Stranger);
            VmArray record = (VmArray)Read("getPendingConfiguration", Account, intentId);
            return record.Count == 0 ? null : record;
        }

        public StackItem Read(string method, params object?[] args)
        {
            using ScriptBuilder script = new();
            script.EmitDynamicCall(Core, method, CallFlags.ReadOnly, args);
            return Fx.Engine.Execute(new Script(script.ToArray()));
        }
    }

    [TestMethod]
    public void PendingReadAbi_IsSafeArraySurface()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        ContractManifest manifest = ContractManifest.Parse(File.ReadAllText(
            Path.Combine(root, "contracts/bin/public/SmartAccount.manifest.json")));

        ContractMethodDescriptor? record = manifest.Abi.GetMethod("getPendingConfiguration", 2);
        Assert.IsNotNull(record, "Missing ABI method: getPendingConfiguration");
        Assert.IsTrue(record.Safe, "Reading an intent must never need a writer phase");
        Assert.AreEqual(ContractParameterType.Array, record.ReturnType);
        Assert.AreEqual(ContractParameterType.Hash160, record.Parameters[0].Type);
        Assert.AreEqual(ContractParameterType.Integer, record.Parameters[1].Type);

        ContractMethodDescriptor? index = manifest.Abi.GetMethod("getPendingConfigurationIntentIds", 1);
        Assert.IsNotNull(index, "Missing ABI method: getPendingConfigurationIntentIds");
        Assert.IsTrue(index.Safe);
        Assert.AreEqual(ContractParameterType.Array, index.ReturnType);
        Assert.AreEqual(ContractParameterType.Hash160, index.Parameters[0].Type);
    }

    [TestMethod]
    public void NoPendingIntent_ReturnsEmptyResultsForRegisteredAndUnknownAccounts()
    {
        Harness h = new();
        h.Fx.SetSigners(Stranger);

        Assert.AreEqual(0, h.PendingIds().Length);
        Assert.IsNull(h.Pending(1), "An unknown intent id reports an empty array, never a fault");
        // An account that was never created has no index and no record either.
        Assert.AreEqual(0,
            ((VmArray)h.Read("getPendingConfigurationIntentIds", Stranger)).Count);
        Assert.AreEqual(0,
            ((VmArray)h.Read("getPendingConfiguration", Stranger, (BigInteger)1)).Count);
    }

    [TestMethod]
    public void PendingRecord_ExposesExactActionsAndTimesReadOnly()
    {
        Harness h = new();
        object configure = h.Configure(1, h.KeyA);
        BigInteger proposedAt = h.Fx.Now();
        BigInteger intentId = h.Propose((object)configure);

        // A stranger can describe the pending change without any witness.
        VmArray record = h.Pending(intentId, asStranger: true)!;
        Assert.IsNotNull(record);
        Assert.AreEqual(8, record.Count);
        Assert.IsTrue(record[0].GetBoolean());
        Assert.AreEqual(intentId, record[1].GetInteger());
        Assert.AreEqual(proposedAt, record[2].GetInteger());
        Assert.AreEqual(proposedAt + MatureDelayMs, record[3].GetInteger(),
            "Every intent matures after the uniform 24h module-change delay");
        Assert.AreEqual(proposedAt + MatureDelayMs + ExpiryWindowMs, record[4].GetInteger());
        Assert.AreEqual(h.Fx.AccountAuthorityEpoch(h.Core, h.Account), record[5].GetInteger(),
            "The intent records the authority epoch it must still match at confirmation");

        Assert.AreEqual(32, record[6].GetSpan().Length, "actionDigest is a SHA-256 over the action array");
        VmArray actions = (VmArray)record[7];
        Assert.AreEqual(1, actions.Count);
        VmArray action = (VmArray)actions[0];
        Assert.AreEqual(new BigInteger(RuntimeFixture.ActionConfigureModule), action[0].GetInteger());
        Assert.AreEqual(BigInteger.One, action[1].GetInteger());
        VmArray configData = (VmArray)action[2];
        Assert.AreEqual("setMemberKey", configData[0].GetString());

        CollectionAssert.AreEqual(new[] { intentId }, h.PendingIds());
        Assert.AreEqual(0,
            h.Fx.CallBytes(h.Member, "getMemberKey", h.Account, BigInteger.One).Length,
            "A pending intent changes nothing until it is confirmed");
    }

    [TestMethod]
    public void Cancellation_ClearsOnlyTheSelectedIntent()
    {
        Harness h = new();
        object first = h.Configure(1, h.KeyA);
        object second = h.Configure(2, h.KeyB);
        BigInteger firstId = h.Propose((object)first);
        BigInteger secondId = h.Propose((object)second);
        CollectionAssert.AreEquivalent(new[] { firstId, secondId }, h.PendingIds(),
            "Independent resources may be pending at the same time");

        h.Fx.CallVoid(h.Core, "cancelConfiguration", h.Account, firstId);
        Assert.IsNull(h.Pending(firstId));
        Assert.IsNotNull(h.Pending(secondId), "Cancelling one intent must not disturb another");
        CollectionAssert.AreEqual(new[] { secondId }, h.PendingIds());

        h.Fx.CallVoid(h.Core, "cancelConfiguration", h.Account, secondId);
        Assert.IsNull(h.Pending(secondId));
        Assert.AreEqual(0, h.PendingIds().Length);
    }

    [TestMethod]
    public void SuccessfulConfirmation_ClearsThePendingRecord()
    {
        Harness h = new();
        object configure = h.Configure(1, h.KeyA);
        BigInteger intentId = h.Propose((object)configure);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(MatureDelayMs) + TimeSpan.FromMinutes(1));
        h.Confirm(intentId, (object)configure);

        Assert.IsNull(h.Pending(intentId));
        Assert.AreEqual(0, h.PendingIds().Length);
        CollectionAssert.AreEqual(h.KeyA.CompressedPublicKey,
            h.Fx.CallBytes(h.Member, "getMemberKey", h.Account, BigInteger.One));
    }

    [TestMethod]
    public void UnrelatedSigner_CanReadButCannotCancelOrAlter()
    {
        Harness h = new();
        object configure = h.Configure(1, h.KeyA);
        BigInteger intentId = h.Propose((object)configure);

        h.Fx.SetSigners(Stranger);
        Assert.IsNotNull(h.Pending(intentId), "Reads stay permissionless");
        TestException denied = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Core, "cancelConfiguration", h.Account, intentId));
        StringAssert.Contains(denied.Message, "SA_UNAUTHORIZED");

        VmArray record = h.Pending(intentId)!;
        Assert.AreEqual(intentId, record[1].GetInteger());
        Assert.AreEqual(0,
            h.Fx.CallBytes(h.Member, "getMemberKey", h.Account, BigInteger.One).Length);
    }

    [TestMethod]
    public void ExpiredIntent_IsCleanedWithoutAWitness()
    {
        Harness h = new();
        object configure = h.Configure(1, h.KeyA);
        BigInteger intentId = h.Propose((object)configure);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(MatureDelayMs + ExpiryWindowMs)
            + TimeSpan.FromMinutes(1));

        // Past its expiry window the record is explicit garbage: anyone may
        // clear it, and no confirmation can ever commit it.
        h.Fx.SetSigners(Stranger);
        h.Fx.CallVoid(h.Core, "cancelConfiguration", h.Account, intentId);
        Assert.IsNull(h.Pending(intentId));
        Assert.AreEqual(0, h.PendingIds().Length);
        Assert.AreEqual(0,
            h.Fx.CallBytes(h.Member, "getMemberKey", h.Account, BigInteger.One).Length);
    }

    [TestMethod]
    public void InvalidAccountIds_FaultWithoutChangingPendingRecords()
    {
        Harness h = new();
        object configure = h.Configure(1, h.KeyA);
        BigInteger intentId = h.Propose((object)configure);
        h.Fx.SetSigners(Stranger);

        foreach (object? invalid in new object?[] { UInt160.Zero, new byte[19], new byte[21] })
        {
            Assert.ThrowsExactly<TestException>(() =>
                h.Read("getPendingConfiguration", invalid, intentId));
            Assert.ThrowsExactly<TestException>(() =>
                h.Read("getPendingConfigurationIntentIds", invalid));
        }

        VmArray record = h.Pending(intentId)!;
        Assert.AreEqual(intentId, record[1].GetInteger());
        CollectionAssert.AreEqual(new[] { intentId }, h.PendingIds());
    }
}
