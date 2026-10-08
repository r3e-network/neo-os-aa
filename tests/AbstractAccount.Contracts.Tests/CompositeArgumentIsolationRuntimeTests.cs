using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

/// <summary>Real bytecode regressions for ownership across untrusted child calls.</summary>
[TestClass]
public class CompositeArgumentIsolationRuntimeTests
{
    private static readonly UInt160 Account = UInt160.Parse("0x1111111111111111111111111111111111111111");
    private static readonly UInt160 Recipient = UInt160.Parse("0x4444444444444444444444444444444444444444");

    // This test-only leaf changes the transfer amount seen by subsequent children.
    // The production root and signature verifier are loaded without bytecode changes.
    private static UInt160 MutatingLeaf(RuntimeFixture fx)
    {
        using ScriptBuilder script = new();
        List<ContractMethodDescriptor> methods = [];
        void Method(string name, ContractParameterType result, bool safe, params ContractParameterType[] parameters)
        {
            methods.Add(new ContractMethodDescriptor
            {
                Name = name, Offset = script.Length, ReturnType = result, Safe = safe,
                Parameters = parameters.Select((type, index) => new ContractParameterDefinition { Name = "p" + index, Type = type }).ToArray()
            });
        }
        Method("supportsV3", ContractParameterType.Boolean, true);
        script.EmitPush(true).Emit(OpCode.RET);
        Method("supportsComposition", ContractParameterType.Boolean, true);
        script.EmitPush(false).Emit(OpCode.RET);
        Method("getSignerDomains", ContractParameterType.Array, true, ContractParameterType.Hash160);
        script.Emit(OpCode.DROP).EmitPush(Enumerable.Repeat((byte)0x77, 32).ToArray()).EmitPush(1).Emit(OpCode.PACK).Emit(OpCode.RET);
        Method("validateSignature", ContractParameterType.Boolean, true, ContractParameterType.Hash160, ContractParameterType.Any);
        script.Emit(OpCode.DROP).EmitPush(2).Emit(OpCode.PICKITEM).EmitPush(2).EmitPush(1).Emit(OpCode.SETITEM)
            .EmitPush(true).Emit(OpCode.RET);
        Method("postExecute", ContractParameterType.Void, false, ContractParameterType.Hash160, ContractParameterType.Any, ContractParameterType.Any);
        script.Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.RET);
        Method("clearAccount", ContractParameterType.Void, false, ContractParameterType.Hash160);
        script.Emit(OpCode.DROP).Emit(OpCode.RET);
        NefFile nef = new() { Compiler = "Argument isolation fixture", Source = "", Tokens = [], Script = script.ToArray() };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        ContractManifest manifest = new()
        {
            Name = "ArgumentMutatingLeaf", Groups = [], SupportedStandards = [], Permissions = [],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(), Abi = new ContractAbi { Methods = methods.ToArray(), Events = [] }
        };
        return fx.DeployArtifact(nef.ToArray(), manifest.ToJson().ToString());
    }

    [TestMethod]
    public void MultiSig_ReadOnlyChildCannotReplaceAnotherChildsSignedAmount()
    {
        Run(post: false);
    }

    [TestMethod]
    public void MultiSig_PostRevalidationCannotReplaceAnotherChildsSignedAmount()
    {
        Run(post: true);
    }

    private static void Run(bool post)
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore"), target = fx.Deploy("MockTransferTarget");
        UInt160 mutator = MutatingLeaf(fx);
        UInt160 session = fx.Deploy("verifiers/SessionKeyVerifier", core.ToArray());
        UInt160 root = fx.Deploy("verifiers/MultiSigVerifier", core.ToArray());
        using P256SessionKey key = new();
        fx.CallVoid(core, "forward", session, "setSessionKey", new object?[]
            { Account, key.CompressedPublicKey, target, "transfer", fx.Now() + 86_400_000, 0, "isolation regression" });
        fx.CallVoid(core, "forward", root, "setConfig", new object?[] { Account, new object?[] { mutator, session }, 2 });
        BigInteger deadline = fx.Now() + 600_000;
        object?[] Args(int amount) => [Account, Recipient, amount, null];
        byte[] signature = key.Sign(fx.CallBytes(session, "getPayload", Account, target, "transfer", Args(1), 0, deadline));
        object[] Op(int amount, byte[] sig) => RuntimeFixture.UserOp(target, "transfer", Args(amount), 0, deadline, sig);
        Assert.IsTrue(fx.CallBoolean(session, "validateSignature", Account, Op(1, signature)));
        Assert.IsFalse(fx.CallBoolean(session, "validateSignature", Account, Op(1000, signature)));
        byte[] bundle = fx.StdLibSerialize(new object?[] { System.Array.Empty<byte>(), signature });
        Assert.IsTrue(fx.CallBoolean(root, "validateSignature", Account, Op(1, bundle)), "Positive control must accept identical signed bytes.");
        if (post)
        {
            TestException error = Assert.ThrowsExactly<TestException>(() =>
                fx.CallVoid(core, "forward", root, "postExecute", new object?[] { Account, Op(1000, bundle), true }));
            StringAssert.Contains(error.Message, "Verifier rejected signature");
        }
        else
            Assert.IsFalse(fx.CallBoolean(root, "validateSignature", Account, Op(1000, bundle)),
                "A read-only child must not change the operation approved by another child.");
    }
}
