using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Delegated-identity configuration boundary (docs/SA-MODULE-PROTOCOL.md §9, §5).
///
/// v3 carried the identity config as a length-prefixed credential blob on
/// <c>registerAccount</c> and re-pointed it through <c>callVerifier</c>. v4 has no
/// registration blob: the identity is custody‖salt (§16.1) and the validator is
/// configured like any other module, by an exact-arity command array either as
/// <c>initData</c> at install or through a 24h configuration intent. The invariants
/// kept here are the ones that mattered: no trailing payload may ride along with a
/// config, and the provider must fit the one-byte wire length prefix the proof
/// format uses (§5).
/// </summary>
[TestClass]
public class ZkLoginConfigRuntimeTests
{
    private static readonly byte[] SignerPublicKey = BuildSignerKey();
    private static readonly byte[] MasterNullifier = BuildMasterNullifier();

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Verifier { get; }
        public P256SessionKey CustodyKey { get; } = new();
        public UInt160 Custody { get; }

        public Harness()
        {
            Core = Fx.Deploy("SmartAccount");
            Verifier = Fx.Deploy("validators/DelegatedIdentityValidator", Core.ToArray());
            Custody = RuntimeFixture.CustodyOf(CustodyKey);
        }

        public UInt160 Create(params object?[] configData)
        {
            object[] install = configData.Length == 0
                ? Fx.InstallValidator(Verifier)
                : Fx.InstallValidator(Verifier, configData);
            return Fx.CreateAccount(Core, Custody, "zklogin", (object)install);
        }

        public BigInteger ModuleId(UInt160 accountId) =>
            Fx.FindModuleId(Core, accountId, RuntimeFixture.ModuleTypeNameValidator, Verifier);

        public string Provider(UInt160 accountId) =>
            Fx.Call(Verifier, "getProvider", accountId, ModuleId(accountId)).GetString();

        public BigInteger Propose(UInt160 accountId, params object[] actions) =>
            Fx.ProposeConfiguration(Core, accountId, Custody, actions);

        public void Confirm(UInt160 accountId, BigInteger intentId, params object[] actions) =>
            Fx.ConfirmConfiguration(Core, accountId, Custody, intentId, actions);
    }

    [TestMethod]
    public void TrailingArgumentBeyondTheVerifierWireShapeIsRejected()
    {
        Harness h = new();

        // A config command array is exact-arity: an element beyond the four canonical
        // fields is a shape fault, not a silently ignored payload.
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            h.Create("setConfig", SignerPublicKey, "google", MasterNullifier, new byte[] { 0xA5 }));
        StringAssert.Contains(fault.Message, "Invalid config arguments");

        Assert.AreEqual(0,
            h.Fx.ModuleIds(h.Core, h.Fx.CallUInt160(h.Core, "computeAccountIdentity", h.Custody,
                RuntimeFixture.Salt("zklogin")), RuntimeFixture.ModuleTypeNameValidator).Length,
            "A rejected install must not allocate an instance");
    }

    [TestMethod]
    public void SetConfigRejectsProviderLongerThanTheWireLengthPrefix()
    {
        Harness h = new();
        UInt160 accountId = h.Create("setConfig", SignerPublicKey, "google", MasterNullifier);
        BigInteger moduleId = h.ModuleId(accountId);

        // Positive control: a provider that fits the one-byte length prefix configures.
        Assert.AreEqual("google", h.Provider(accountId));
        CollectionAssert.AreEqual(MasterNullifier,
            h.Fx.CallBytes(h.Verifier, "getMasterNullifier", accountId, moduleId));

        // 256 bytes cannot be encoded by the U8 length prefix the proof format uses,
        // so the command is rejected and the instance keeps its previous config.
        byte[] oversized = new byte[256];
        for (int i = 0; i < oversized.Length; i++) oversized[i] = (byte)'p';
        object action = RuntimeFixture.ConfigureModule(moduleId,
            new object?[] { "setConfig", SignerPublicKey, oversized, MasterNullifier });

        BigInteger intentId = h.Propose(accountId, action);
        h.Fx.AdvanceTime(TimeSpan.FromHours(24) + TimeSpan.FromMinutes(1));
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            h.Confirm(accountId, intentId, action));
        StringAssert.Contains(fault.Message, "Provider must be 1-255 bytes");
        Assert.AreEqual("google", h.Provider(accountId),
            "A rejected configure must leave the committed identity untouched");
    }

    private static byte[] BuildSignerKey()
    {
        byte[] key = new byte[33];
        key[0] = 0x02;
        for (int i = 1; i < key.Length; i++) key[i] = (byte)i;
        return key;
    }

    private static byte[] BuildMasterNullifier()
    {
        byte[] nullifier = new byte[32];
        for (int i = 0; i < nullifier.Length; i++) nullifier[i] = (byte)(i + 1);
        return nullifier;
    }
}
