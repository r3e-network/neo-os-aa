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

namespace AbstractAccount.Contracts.Tests;

/// <summary>Executes only ordinary configuration reads and their existing update lifecycle.</summary>
[TestClass]
public class PendingConfigUpdateReadRuntimeTests
{
    private static readonly UInt160 Owner = UInt160.Parse("0x2323232323232323232323232323232323232323");
    private static readonly UInt160 Stranger = UInt160.Parse("0x4545454545454545454545454545454545454545");
    private static readonly UInt160 NextVerifier = UInt160.Parse("0x6767676767676767676767676767676767676767");
    private static readonly byte[] Parameters = { 0x00, 0x81, 0xff, 0x24 };
    private const long TimelockMs = 86_400_000;
    private static readonly string[] Getters = { "getPendingVerifierUpdate", "getPendingHookUpdate" };

    private static (RuntimeFixture Fx, UInt160 Core, UInt160 Account, UInt160 Verifier, UInt160 Hook) CreateAccount()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 verifier = fx.Deploy("verifiers/NeoNativeVerifier", core.ToArray());
        UInt160 hook = fx.Deploy("hooks/WhitelistHook", core.ToArray());
        UInt160 account = fx.CallUInt160(core, "computeRegistrationAccountId", verifier,
            System.Array.Empty<byte>(), hook, Owner, 604_800u);
        fx.SetSigners(Owner);
        fx.CallVoid(core, "registerAccount", account, verifier, System.Array.Empty<byte>(), hook, Owner, 604_800u);
        return (fx, core, account, verifier, hook);
    }

    private static StackItem ReadOnly(RuntimeFixture fx, UInt160 core, string method, UInt160 account)
    {
        using ScriptBuilder script = new();
        script.EmitDynamicCall(core, method, CallFlags.ReadOnly, account);
        return fx.Engine.Execute(new Script(script.ToArray()));
    }

    private static void AssertRecord(StackItem result, UInt160 module, byte[] parameters, BigInteger initiatedAt)
    {
        Assert.AreEqual(typeof(VmArray), result.GetType(), "Public results must be Array, not the internal Struct");
        VmArray fields = (VmArray)result;
        Assert.AreEqual(4, fields.Count);
        Assert.AreEqual(StackItemType.ByteString, fields[0].Type);
        Assert.AreEqual(StackItemType.ByteString, fields[1].Type);
        CollectionAssert.AreEqual(module.ToArray(), fields[0].GetSpan().ToArray());
        CollectionAssert.AreEqual(parameters, fields[1].GetSpan().ToArray());
        Assert.AreEqual(StackItemType.Integer, fields[2].Type);
        Assert.AreEqual(StackItemType.Integer, fields[3].Type);
        Assert.AreEqual(initiatedAt, fields[2].GetInteger());
        Assert.AreEqual(initiatedAt + TimelockMs, fields[3].GetInteger());
    }

    [TestMethod]
    public void PendingReadAbi_IsSafeArrayWithOneHash160Parameter()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        ContractManifest manifest = ContractManifest.Parse(File.ReadAllText(
            Path.Combine(root, "contracts/bin/v3/UnifiedSmartWalletV3.manifest.json")));
        foreach (string method in Getters)
        {
            ContractMethodDescriptor? descriptor = manifest.Abi.GetMethod(method, 1);
            Assert.IsNotNull(descriptor, $"Missing ABI method: {method}");
            Assert.IsTrue(descriptor.Safe);
            Assert.AreEqual(ContractParameterType.Array, descriptor.ReturnType);
            Assert.AreEqual(ContractParameterType.Hash160, descriptor.Parameters[0].Type);
        }
    }

    [TestMethod]
    public void NoPending_ReturnsNullForRegisteredAndUnknownAccountsWithoutOwnerWitness()
    {
        var (fx, core, account, _, _) = CreateAccount();
        fx.SetSigners(Stranger);
        foreach (string getter in Getters)
        {
            Assert.IsTrue(ReadOnly(fx, core, getter, account).IsNull);
            Assert.IsTrue(ReadOnly(fx, core, getter, Stranger).IsNull);
        }
    }

    [TestMethod]
    public void PendingRecords_SelectCorrectModuleAndExposeExactBytesAndTimesReadOnly()
    {
        var (fx, core, account, verifier, hook) = CreateAccount();
        BigInteger verifierAt = fx.Now();
        fx.CallVoid(core, "updateVerifier", account, NextVerifier, Parameters);
        fx.AdvanceTime(TimeSpan.FromMilliseconds(1234));
        BigInteger hookAt = fx.Now();
        fx.CallVoid(core, "updateHook", account, hook);
        fx.SetSigners(Stranger);

        AssertRecord(ReadOnly(fx, core, Getters[0], account), NextVerifier, Parameters, verifierAt);
        AssertRecord(ReadOnly(fx, core, Getters[1], account), hook, System.Array.Empty<byte>(), hookAt);
        Assert.AreEqual(verifierAt + TimelockMs, fx.CallInteger(core, "getPendingVerifierUpdateTime", account));
        Assert.AreEqual(hookAt + TimelockMs, fx.CallInteger(core, "getPendingHookUpdateTime", account));
        Assert.AreEqual(verifier, fx.CallUInt160(core, "getVerifier", account));
        Assert.AreEqual(hook, fx.CallUInt160(core, "getHook", account));
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(core, "getNonce", account, BigInteger.Zero));
        Assert.IsTrue(ReadOnly(fx, core, Getters[0], Stranger).IsNull);
    }

    [TestMethod]
    public void NullVerifierParameters_AreReadAsEmptyBytes()
    {
        var (fx, core, account, _, _) = CreateAccount();
        BigInteger initiatedAt = fx.Now();
        fx.CallVoid(core, "updateVerifier", account, NextVerifier, null);
        AssertRecord(ReadOnly(fx, core, Getters[0], account), NextVerifier, System.Array.Empty<byte>(), initiatedAt);
    }

    [TestMethod]
    public void Cancellation_ClearsOnlyTheSelectedPendingRecord()
    {
        var (fx, core, account, _, hook) = CreateAccount();
        BigInteger initiatedAt = fx.Now();
        fx.CallVoid(core, "updateVerifier", account, NextVerifier, Parameters);
        fx.CallVoid(core, "updateHook", account, hook);
        fx.CallVoid(core, "cancelVerifierUpdate", account);
        Assert.IsTrue(ReadOnly(fx, core, Getters[0], account).IsNull);
        AssertRecord(ReadOnly(fx, core, Getters[1], account), hook, System.Array.Empty<byte>(), initiatedAt);
        fx.CallVoid(core, "cancelHookUpdate", account);
        Assert.IsTrue(ReadOnly(fx, core, Getters[1], account).IsNull);
    }

    [TestMethod]
    public void SuccessfulConfirmation_ClearsBothPendingRecords()
    {
        var (fx, core, account, _, _) = CreateAccount();
        fx.CallVoid(core, "updateVerifier", account, UInt160.Zero, System.Array.Empty<byte>());
        fx.CallVoid(core, "updateHook", account, UInt160.Zero);
        fx.AdvanceTime(TimeSpan.FromMilliseconds(TimelockMs));
        fx.CallVoid(core, "confirmVerifierUpdate", account);
        fx.CallVoid(core, "confirmHookUpdate", account);
        foreach (string getter in Getters) Assert.IsTrue(ReadOnly(fx, core, getter, account).IsNull);
    }

    [TestMethod]
    public void UnrelatedSigner_CanReadButCannotCancelOrAlterPendingRecords()
    {
        var (fx, core, account, _, hook) = CreateAccount();
        BigInteger initiatedAt = fx.Now();
        fx.CallVoid(core, "updateVerifier", account, NextVerifier, Parameters);
        fx.CallVoid(core, "updateHook", account, hook);
        fx.SetSigners(Stranger);
        Assert.ThrowsExactly<TestException>(() => fx.CallVoid(core, "cancelVerifierUpdate", account));
        Assert.ThrowsExactly<TestException>(() => fx.CallVoid(core, "cancelHookUpdate", account));
        AssertRecord(ReadOnly(fx, core, Getters[0], account), NextVerifier, Parameters, initiatedAt);
        AssertRecord(ReadOnly(fx, core, Getters[1], account), hook, System.Array.Empty<byte>(), initiatedAt);
    }

    [TestMethod]
    public void InvalidAccountIds_FaultWithoutChangingPendingRecords()
    {
        var (fx, core, account, _, hook) = CreateAccount();
        BigInteger initiatedAt = fx.Now();
        fx.CallVoid(core, "updateVerifier", account, NextVerifier, Parameters);
        fx.CallVoid(core, "updateHook", account, hook);
        fx.SetSigners(Stranger);
        foreach (string getter in Getters)
        {
            foreach (object? invalid in new object?[] { null, UInt160.Zero, new byte[19], new byte[21] })
                Assert.ThrowsExactly<TestException>(() => fx.Call(core, getter, invalid));
        }
        AssertRecord(ReadOnly(fx, core, Getters[0], account), NextVerifier, Parameters, initiatedAt);
        AssertRecord(ReadOnly(fx, core, Getters[1], account), hook, System.Array.Empty<byte>(), initiatedAt);
    }
}
