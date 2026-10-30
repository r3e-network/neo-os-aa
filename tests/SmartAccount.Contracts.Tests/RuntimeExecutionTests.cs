using System.IO;
using System.Numerics;
using System.Reflection;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing;
using Neo.SmartContract.Testing.Exceptions;
using Neo.SmartContract.Testing.Extensions;
using Neo.VM;
using Neo.VM.Types;

namespace SmartAccount.Contracts.Tests;

[TestClass]
public class RuntimeExecutionTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledContractsDir = Path.Combine(RepoRoot, "contracts", "bin", "v3");

    private static readonly FieldInfo FeeAmountField =
        typeof(ApplicationEngine).GetField("_feeAmount", BindingFlags.Instance | BindingFlags.NonPublic)!;

    private static readonly UInt160 ContractManagementHash =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    private static readonly NefFile WalletNef =
        NefFile.Parse(File.ReadAllBytes(Path.Combine(CompiledContractsDir, "SmartAccountV3.nef")), verify: true);

    private static readonly string WalletManifestText =
        File.ReadAllText(Path.Combine(CompiledContractsDir, "SmartAccountV3.manifest.json"));

    private static readonly ContractManifest WalletManifest = ContractManifest.Parse(WalletManifestText);

    [TestMethod]
    public void ComputeRegistrationAccountId_MatchesFrontendVectorInRuntime()
    {
        RuntimeWalletHarness harness = new();

        UInt160 accountId = harness.GetUInt160(
            "computeRegistrationAccountId",
            UInt160.Parse("0x5be915aea3ce85e4752d522632f0a9520e377aaf"),
            new byte[] { 0x11, 0x22, 0x33, 0x44 },
            UInt160.Zero,
            UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a"),
            2_592_000u);

        Assert.AreEqual(UInt160.Parse("0x27c01243fca45e1b821dc3bb45267a579762d530"), accountId);
    }

    [TestMethod]
    public void RegisterAccount_PersistsSelectedAccountStateInRuntime()
    {
        RuntimeWalletHarness harness = new();
        UInt160 backupOwner = UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");
        uint escapeTimelock = 2_592_000;
        UInt160 accountId = harness.GetUInt160(
            "computeRegistrationAccountId",
            UInt160.Zero,
            System.Array.Empty<byte>(),
            UInt160.Zero,
            backupOwner,
            escapeTimelock);

        harness.SetSigner(backupOwner);
        harness.ExecuteVoid(
            "registerAccount",
            accountId,
            UInt160.Zero,
            System.Array.Empty<byte>(),
            UInt160.Zero,
            backupOwner,
            escapeTimelock);

        Assert.AreEqual(backupOwner, harness.GetUInt160("getBackupOwner", accountId));
        Assert.AreEqual(UInt160.Zero, harness.GetUInt160("getVerifier", accountId));
        Assert.AreEqual(UInt160.Zero, harness.GetUInt160("getHook", accountId));
        Assert.AreEqual(escapeTimelock, harness.GetUInt32("getEscapeTimelock", accountId));
    }

    [TestMethod]
    public void RegisterAccount_RejectsDuplicateRegistrationInRuntime()
    {
        RuntimeWalletHarness harness = new();
        UInt160 backupOwner = UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");
        UInt160 accountId = harness.GetUInt160(
            "computeRegistrationAccountId",
            UInt160.Zero,
            System.Array.Empty<byte>(),
            UInt160.Zero,
            backupOwner,
            2_592_000u);

        harness.SetSigner(backupOwner);
        harness.ExecuteVoid(
            "registerAccount",
            accountId,
            UInt160.Zero,
            System.Array.Empty<byte>(),
            UInt160.Zero,
            backupOwner,
            2_592_000u);

        TestException exception = Assert.ThrowsExactly<TestException>(() =>
            harness.ExecuteVoid(
                "registerAccount",
                accountId,
                UInt160.Zero,
                System.Array.Empty<byte>(),
                UInt160.Zero,
                backupOwner,
                2_592_000u));

        StringAssert.Contains(exception.Message, "Account already exists");
    }

    [TestMethod]
    public void RegisterAccount_RejectsMismatchedAccountIdInRuntime()
    {
        RuntimeWalletHarness harness = new();
        UInt160 backupOwner = UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

        harness.SetSigner(backupOwner);

        TestException exception = Assert.ThrowsExactly<TestException>(() =>
            harness.ExecuteVoid(
                "registerAccount",
                UInt160.Parse("0x27c01243fca45e1b821dc3bb45267a579762d530"),
                UInt160.Zero,
                System.Array.Empty<byte>(),
                UInt160.Zero,
                backupOwner,
                2_592_000u));

        StringAssert.Contains(exception.Message, "Account id does not match registration parameters");
    }

    private sealed class RuntimeWalletHarness
    {
        public TestEngine Engine { get; } = new();

        public UInt160 ContractHash { get; }

        public RuntimeWalletHarness()
        {
            Engine.SetTransactionSigners(Engine.ValidatorsAddress);
            ContractHash = Engine.GetDeployHash(WalletNef, WalletManifest);
            ExecuteRaw(ContractManagementHash, "deploy", WalletNef.ToArray(), WalletManifestText, null!);
        }

        public void SetSigner(UInt160 signer)
        {
            Engine.SetTransactionSigners(signer);
        }

        public void ExecuteVoid(string method, params object[] args)
        {
            _ = ExecuteRaw(ContractHash, method, args);
        }

        public UInt160 GetUInt160(string method, params object[] args)
        {
            return (UInt160)TestExtensions.ConvertTo(ExecuteRaw(ContractHash, method, args), typeof(UInt160))!;
        }

        public uint GetUInt32(string method, params object[] args)
        {
            return (uint)TestExtensions.ConvertTo(ExecuteRaw(ContractHash, method, args), typeof(uint))!;
        }

        private StackItem ExecuteRaw(UInt160 targetHash, string method, params object[] args)
        {
            using ScriptBuilder scriptBuilder = new();
            scriptBuilder.EmitDynamicCall(targetHash, method, args);
            return Engine.Execute(
                new Script(scriptBuilder.ToArray()),
                0,
                applicationEngine => FeeAmountField.SetValue(applicationEngine, new BigInteger(long.MaxValue)));
        }
    }
}
