using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Text;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing.Exceptions;
using Neo.SmartContract.Testing.Extensions;
using Neo.VM;
using Neo.VM.Types;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Spec §7.3 (R-03-04, R-07-03) code-binding continuity: the
/// (<c>ContractId</c>, <c>UpdateCounter</c>) pair captured when an instance was
/// installed must still resolve to the same revision when a writable callback
/// returns and again before commit.
/// </summary>
/// <remarks>
/// Every writable callback runs with <c>CallFlags.All</c>, so a module can
/// re-deploy itself from inside its own callback through
/// <c>ContractManagement.update</c>. That advances the deployment's
/// <c>UpdateCounter</c> without changing its script hash, which is exactly the
/// case the pair has to catch: the core must fault the whole attempt with
/// <c>SA_MODULE_CODE_BINDING_MISMATCH</c> instead of continuing on code it never
/// authorized at install time.
/// </remarks>
[TestClass]
public class CodeBindingContinuityRuntimeTests
{
    private static readonly UInt160 Recipient =
        UInt160.Parse("0x7272727272727272727272727272727272727272");

    private static readonly UInt160 ContractManagementHash =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    private const string ModuleName = "CodeBindingContinuityHook";

    private static string Profile(string name, string moduleType, string callbacks) =>
        "{\"callbacks\":[" + callbacks + "],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":true,"
        + "\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"" + name
        + "\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"" + moduleType
        + "\",\"profileVersion\":1}";

    /// <summary>
    /// A hook whose <c>preCheck</c> re-deploys the given artifact pair onto itself
    /// (or does nothing, for the control case) before returning its hookData.
    /// </summary>
    private static (byte[] Nef, string Manifest) BuildHook(byte[] pushedNef, string pushedManifest, bool selfUpdate)
    {
        using ScriptBuilder script = new();
        List<ContractMethodDescriptor> methods = new();
        void Method(string name, ContractParameterType result, bool safe, params ContractParameterType[] parameters)
        {
            methods.Add(new ContractMethodDescriptor
            {
                Name = name,
                Offset = script.Length,
                ReturnType = result,
                Safe = safe,
                Parameters = parameters.Select((type, index) =>
                    new ContractParameterDefinition { Name = "p" + index, Type = type }).ToArray()
            });
        }

        Method("getModuleProfile", ContractParameterType.String, true);
        script.EmitPush(Encoding.UTF8.GetBytes(Profile(ModuleName, "hook", "\"preCheck\",\"postCheck\"")))
            .Emit(OpCode.RET);

        foreach (string lifecycle in new[] { "onInstall", "onUninstall", "configure" })
        {
            Method(lifecycle, ContractParameterType.Void, false, ContractParameterType.Hash160,
                ContractParameterType.Integer, ContractParameterType.Integer, ContractParameterType.Array);
            script.Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.RET);
        }

        Method("preCheck", ContractParameterType.ByteArray, false,
            ContractParameterType.Hash160, ContractParameterType.Array);
        script.Emit(OpCode.DROP).Emit(OpCode.DROP);              // accountId, operation
        if (selfUpdate)
        {
            // ContractManagement.update(nef, manifest) with the module's own pair:
            // the deployment slot keeps its script hash while UpdateCounter moves,
            // so only the pair can notice the code under the account changed.
            ContractParameter args = new(ContractParameterType.Array)
            {
                Value = new List<ContractParameter>
                {
                    new(ContractParameterType.ByteArray) { Value = pushedNef },
                    new(ContractParameterType.String) { Value = pushedManifest }
                }
            };
            script.EmitPush(args);
            script.EmitPush((BigInteger)(int)CallFlags.All);
            script.EmitPush("update");
            script.EmitPush(ContractManagementHash.ToArray());
            script.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
            script.Emit(OpCode.DROP);                            // Boolean reply
        }

        script.EmitPush(System.Array.Empty<byte>()).Emit(OpCode.RET);   // hookData

        Method("postCheck", ContractParameterType.Void, false, ContractParameterType.Hash160,
            ContractParameterType.Array, ContractParameterType.Any, ContractParameterType.ByteArray);
        script.Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.RET);

        NefFile nef = new()
        {
            Compiler = "Code binding continuity fixture",
            Source = string.Empty,
            Tokens = [],
            Script = script.ToArray()
        };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        ContractManifest manifest = new()
        {
            Name = ModuleName,
            Groups = [],
            SupportedStandards = [],
            // A wildcard grant is what lets the fixture reach ContractManagement at
            // all; the core's binding rules, not the permission list, are the gate
            // this suite probes.
            Permissions = [ContractPermission.DefaultPermission],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
            Abi = new ContractAbi { Methods = methods.ToArray(), Events = [] }
        };
        return (nef.ToArray(), manifest.ToJson().ToString());
    }

    /// <summary>
    /// The replacement pair the writable callback deploys onto itself. It is a
    /// single RET instruction and a one-method ABI, kept under the module's own
    /// name because <c>ContractManagement.update</c> refuses a name change. The
    /// payload is static, so it cannot be a quine: the fixture never has to embed
    /// its own artifacts.
    /// </summary>
    private static (byte[] Nef, string Manifest) ReplacementArtifact()
    {
        NefFile nef = new()
        {
            Compiler = "code binding replacement",
            Source = string.Empty,
            Tokens = [],
            Script = new byte[] { (byte)OpCode.RET }
        };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        ContractManifest manifest = new()
        {
            Name = ModuleName,
            Groups = [],
            SupportedStandards = [],
            Permissions = [],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
            Abi = new ContractAbi
            {
                Methods =
                [
                    new ContractMethodDescriptor
                    {
                        Name = "replacement",
                        Offset = 0,
                        ReturnType = ContractParameterType.Void,
                        Safe = false,
                        Parameters = []
                    }
                ],
                Events = []
            }
        };
        return (nef.ToArray(), manifest.ToJson().ToString());
    }

    private static (UInt160 Module, BigInteger UpdateCounter) DeployHook(RuntimeFixture fx, bool selfUpdate)
    {
        (byte[] replacementNef, string replacementManifest) = ReplacementArtifact();
        (byte[] nef, string manifest) = BuildHook(replacementNef, replacementManifest, selfUpdate);
        UInt160 module = fx.DeployArtifact(nef, manifest);
        StackItem state = fx.Call(ContractManagementHash, "getContract", module);
        return (module, ((Neo.VM.Types.Array)state)[1].GetInteger());
    }

    private sealed class Harness : IDisposable
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Probe { get; }
        public P256SessionKey Key { get; } = new();
        public UInt160 Custody { get; }
        public UInt160 AccountId { get; private set; } = UInt160.Zero;

        public Harness()
        {
            Core = Fx.Deploy("SmartAccount");
            Probe = Fx.Deploy("PolicyExecutionProbe");
            Custody = RuntimeFixture.CustodyOf(Key);
        }

        public UInt160 Create(string label, params object[] actions)
        {
            AccountId = Fx.CreateAccount(Core, Custody, label, actions);
            return AccountId;
        }

        /// <summary>Signed built-in (validatorId 0) operation on this account.</summary>
        public object[] Operation(UInt160 target, string method, object?[] args, BigInteger sequence)
        {
            BigInteger mask = (BigInteger.One << 64) - 1;
            BigInteger packed = Fx.PackedNonce(Core, AccountId, 0);
            object[] op = RuntimeFixture.UserOp(target, method, args, (packed & ~mask) | sequence,
                Fx.Now() + 3_600_000, new byte[] { 0x00 },
                configurationNonce: Fx.AccountConfigurationNonce(Core, AccountId));
            op[11] = Fx.SignBuiltIn(Core, AccountId, op, Key);
            return op;
        }

        public StackItem Execute(object[] op) => Fx.Call(Core, "executeUserOp", AccountId, (object)op);

        public void Dispose() => Key.Dispose();
    }

    private static object?[] TransferArguments(UInt160 account) =>
        new object?[] { account, Recipient, (BigInteger)5, new object?[] { (BigInteger)5, new object?[] { (BigInteger)1000 } } };

    [TestMethod]
    public void WritableCallbackCannotRedeployTheCodeUnderTheAccount()
    {
        using Harness h = new();
        (UInt160 module, BigInteger installedCounter) = DeployHook(h.Fx, selfUpdate: true);
        Assert.AreEqual(BigInteger.Zero, installedCounter, "a fresh deployment starts at update counter 0");
        UInt160 account = h.Create("code-binding-self-update", (object)h.Fx.InstallHook(module));

        h.Fx.CallVoid(h.Probe, "setBalance", account, (BigInteger)1000);

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(h.Operation(h.Probe, "transfer", TransferArguments(account), 0)));

        // preCheck ran with CallFlags.All and advanced UpdateCounter, so the pair
        // recorded at install no longer names the code the account authorized.
        StringAssert.Contains(fault.Message, "SA_MODULE_CODE_BINDING_MISMATCH",
            "a writable callback that re-deploys its own revision must fault the attempt");
        Assert.AreEqual(new BigInteger(1000), h.Fx.CallInteger(h.Probe, "balanceOf", account),
            "the refusal happens before the target runs");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Core, account, 0),
            "the refused attempt consumes no nonce");
    }

    [TestMethod]
    public void InstalledRecordPinsSha256OfTheNefAlone()
    {
        using Harness h = new();
        const string artifact = "hooks/WhitelistHook";
        UInt160 module = h.Fx.Deploy(artifact, h.Core.ToArray());
        UInt160 account = h.Create("nef-code-identity", (object)h.Fx.InstallHook(module));

        BigInteger moduleId = h.Fx.FindModuleId(h.Core, account, RuntimeFixture.ModuleTypeNameHook, module);
        Assert.AreNotEqual(BigInteger.Zero, moduleId, "the hook is installed");
        Neo.VM.Types.Array record = (Neo.VM.Types.Array)h.Fx.Call(h.Core, "getModule", account, moduleId);
        byte[] recorded = record[5].GetSpan().ToArray();

        // Spec §3.6/§7.3: the instance pins SHA-256 over the deployed NEF bytes and
        // nothing else. The native kernel computes the same 32 bytes in
        // SmartAccountModulePolicy.CodeHash, so the two kernels agree on the code
        // identity of one artifact; the manifest is bound separately by the 0x52
        // profile digest, which is why appending it here must not be the answer.
        byte[] nefBytes = System.IO.File.ReadAllBytes(
            System.IO.Path.Combine(RuntimeFixture.ArtifactDirectory, artifact + ".nef"));
        byte[] expected = System.Security.Cryptography.SHA256.HashData(nefBytes);
        CollectionAssert.AreEqual(expected, recorded, "NefSha256 is SHA-256 of the NEF bytes alone");
        CollectionAssert.AreNotEqual(
            System.Security.Cryptography.SHA256.HashData(
                nefBytes.Concat(System.Text.Encoding.UTF8.GetBytes(" ")).ToArray()),
            recorded,
            "the digest is not defined over NEF plus anything else");
    }

    [TestMethod]
    public void WritableCallbackThatLeavesItsCodeAloneStillRuns()
    {
        using Harness h = new();
        (UInt160 module, BigInteger installedCounter) = DeployHook(h.Fx, selfUpdate: false);
        Assert.AreEqual(BigInteger.Zero, installedCounter);
        UInt160 account = h.Create("code-binding-control", (object)h.Fx.InstallHook(module));

        h.Fx.CallVoid(h.Probe, "setBalance", account, (BigInteger)1000);
        h.Execute(h.Operation(h.Probe, "transfer", TransferArguments(account), 0));

        // The continuity check is not a blanket refusal: an unchanged binding passes.
        Assert.AreEqual(new BigInteger(995), h.Fx.CallInteger(h.Probe, "balanceOf", account));
        Assert.AreEqual(BigInteger.One, h.Fx.CurrentNonceSequence(h.Core, account, 0));
    }
}
