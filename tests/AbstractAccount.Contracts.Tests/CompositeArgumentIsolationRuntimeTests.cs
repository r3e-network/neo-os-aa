using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

/// <summary>Real VM regression vectors for untrusted children mutating shared VM arrays.</summary>
[TestClass]
public class CompositeArgumentIsolationRuntimeTests
{
    private static readonly UInt160 Account = UInt160.Parse("0x7171717171717171717171717171717171717171");
    private static readonly UInt160 Recipient = UInt160.Parse("0x7272727272727272727272727272727272727272");

    private static UInt160 Leaf(RuntimeFixture fx, string name, Action<ScriptBuilder> validate, Action<ScriptBuilder> post)
    {
        using ScriptBuilder script = new();
        List<ContractMethodDescriptor> methods = new();
        void Method(string method, ContractParameterType result, bool safe, params ContractParameterType[] parameters)
        {
            methods.Add(new ContractMethodDescriptor
            {
                Name = method,
                Offset = script.Length,
                ReturnType = result,
                Safe = safe,
                Parameters = parameters.Select((type, index) => new ContractParameterDefinition { Name = "p" + index, Type = type }).ToArray()
            });
        }
        Method("supportsV3", ContractParameterType.Boolean, true);
        script.EmitPush(true).Emit(OpCode.RET);
        Method("validateSignature", ContractParameterType.Boolean, true, ContractParameterType.Hash160, ContractParameterType.Any);
        validate(script); script.Emit(OpCode.RET);
        Method("postExecute", ContractParameterType.Void, false, ContractParameterType.Hash160, ContractParameterType.Any, ContractParameterType.Any);
        post(script); script.Emit(OpCode.RET);
        Method("clearAccount", ContractParameterType.Void, false, ContractParameterType.Hash160);
        script.Emit(OpCode.DROP).Emit(OpCode.RET);
        NefFile nef = new() { Compiler = "Composite aliasing test fixture", Source = "", Tokens = [], Script = script.ToArray() };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        ContractManifest manifest = new()
        {
            Name = name,
            Groups = [],
            SupportedStandards = [],
            Permissions = [],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
            Abi = new ContractAbi { Methods = methods.ToArray(), Events = [] }
        };
        return fx.DeployArtifact(nef.ToArray(), manifest.ToJson().ToString());
    }

    private static void Approve(ScriptBuilder script) => script.Emit(OpCode.DROP).Emit(OpCode.DROP).EmitPush(true);
    private static void NoPost(ScriptBuilder script) => script.Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP);
    private static void Arguments(ScriptBuilder script, bool nested)
    {
        script.Emit(OpCode.DROP).EmitPush(2).Emit(OpCode.PICKITEM); // Drop account; op.Args.
        if (nested) script.EmitPush(3).Emit(OpCode.PICKITEM);      // Nested transfer data.
    }
    private static void MutateArguments(ScriptBuilder script, bool nested)
    {
        Arguments(script, nested);
        script.EmitPush(nested ? 0 : 2).EmitPush(1).Emit(OpCode.SETITEM);
    }

    [TestMethod]
    [DataRow(false, false)]
    [DataRow(false, true)]
    [DataRow(true, false)]
    [DataRow(true, true)]
    public void ReadOnlyChildCannotChangeAnotherChildsSignedArguments(bool post, bool nested)
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");
        UInt160 target = fx.Deploy("MockTransferTarget");
        UInt160 mutator = Leaf(fx, "ArgumentMutatingLeaf", s => { MutateArguments(s, nested); s.EmitPush(true); }, NoPost);
        UInt160 session = fx.Deploy("verifiers/SessionKeyVerifier", core.ToArray());
        UInt160 root = fx.Deploy("verifiers/MultiSigVerifier", core.ToArray());
        using P256SessionKey key = new();
        fx.CallVoid(core, "forward", session, "setSessionKey", new object?[]
            { Account, key.CompressedPublicKey, target, "transfer", fx.Now() + 600000, 0, "argument isolation" });
        fx.CallVoid(core, "forward", root, "setConfig", new object?[] { Account, new object?[] { mutator, session }, 2 });
        UInt160 asset = fx.CallUInt160(core, "getProxyScriptHash", Account);
        BigInteger deadline = fx.Now() + 600000;
        object?[] Args(int changed) => new object?[] { asset, Recipient, nested ? 1 : changed, new object?[] { nested ? changed : 1 } };
        byte[] signature = key.Sign(fx.CallBytes(session, "getPayload", Account, target, "transfer", Args(1), 0, deadline));
        object[] Op(int changed, byte[] proof) => RuntimeFixture.UserOp(target, "transfer", Args(changed), 0, deadline, proof);
        Assert.IsTrue(fx.CallBoolean(session, "validateSignature", Account, Op(1, signature)));
        Assert.IsFalse(fx.CallBoolean(session, "validateSignature", Account, Op(1000, signature)));
        byte[] bundle = fx.StdLibSerialize(new object?[] { Array.Empty<byte>(), signature });
        Assert.IsTrue(fx.CallBoolean(root, "validateSignature", Account, Op(1, bundle)), "Positive control must retain the signed arguments.");
        if (post)
        {
            TestException failure = Assert.ThrowsExactly<TestException>(() =>
                fx.CallVoid(core, "forward", root, "postExecute", new object?[] { Account, Op(1000, bundle), true }));
            StringAssert.Contains(failure.Message, "Verifier rejected signature");
        }
        else
        {
            Assert.IsFalse(fx.CallBoolean(root, "validateSignature", Account, Op(1000, bundle)), "ReadOnly is not an array ownership boundary.");
        }
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public void IntegerReplyCannotCountAsBooleanApproval(bool post)
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");
        UInt160 numeric = Leaf(fx, "NonBooleanApprover", s => s.Emit(OpCode.DROP).Emit(OpCode.DROP).EmitPush(BigInteger.One), NoPost);
        UInt160 boolean = Leaf(fx, "BooleanApprover", Approve, NoPost);
        UInt160 root = fx.Deploy("verifiers/MultiSigVerifier", core.ToArray());
        object[] op = RuntimeFixture.UserOp(core, "business", Array.Empty<object?>(), 0, 0, fx.StdLibSerialize(new object?[] { Array.Empty<byte>() }));
        fx.CallVoid(core, "forward", root, "setConfig", new object?[] { Account, new object?[] { boolean }, 1 });
        Assert.IsTrue(fx.CallBoolean(root, "validateSignature", Account, op));
        fx.CallVoid(core, "forward", root, "setConfig", new object?[] { Account, new object?[] { numeric }, 1 });
        if (post)
        {
            TestException fault = Assert.ThrowsExactly<TestException>(() => fx.CallVoid(core, "forward", root, "postExecute", new object?[] { Account, op, true }));
            StringAssert.Contains(fault.Message, "Verifier rejected signature");
        }
        else Assert.IsFalse(fx.CallBoolean(root, "validateSignature", Account, op));
    }

    [TestMethod]
    public void PostCallbackCannotChangeTheNextChildsNestedArguments()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");
        UInt160 mutator = Leaf(fx, "PostArgumentMutator", Approve, s => { MutateArguments(s, true); s.Emit(OpCode.DROP); });
        UInt160 observer = Leaf(fx, "PostArgumentObserver", Approve, s =>
        {
            Arguments(s, true);
            s.EmitPush(0).Emit(OpCode.PICKITEM).EmitPush(1000).Emit(OpCode.EQUAL).Emit(OpCode.ASSERT).Emit(OpCode.DROP);
        });
        UInt160 root = fx.Deploy("verifiers/MultiSigVerifier", core.ToArray());
        void Configure(params UInt160[] children) => fx.CallVoid(core, "forward", root, "setConfig", new object?[] { Account, children.Cast<object?>().ToArray(), children.Length });
        object[] Op(int slots) => RuntimeFixture.UserOp(core, "business", new object?[] { Account, Recipient, 1, new object?[] { 1000 } }, 0, 0,
            fx.StdLibSerialize(Enumerable.Range(0, slots).Select(_ => (object?)Array.Empty<byte>()).ToArray()));
        Configure(observer);
        fx.CallVoid(core, "forward", root, "postExecute", new object?[] { Account, Op(1), true }); // Baseline observer is valid.
        Configure(mutator, observer);
        fx.CallVoid(core, "forward", root, "postExecute", new object?[] { Account, Op(2), true });
    }

    [TestMethod]
    public void PostCallbackCannotChangeTheNextChildsNestedBusinessResult()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");
        UInt160 mutator = Leaf(fx, "PostResultMutator", Approve, s =>
            s.Emit(OpCode.DROP).Emit(OpCode.DROP).EmitPush(0).Emit(OpCode.PICKITEM).EmitPush(0).EmitPush(1).Emit(OpCode.SETITEM));
        UInt160 observer = Leaf(fx, "PostResultObserver", Approve, s =>
            s.Emit(OpCode.DROP).Emit(OpCode.DROP).EmitPush(0).Emit(OpCode.PICKITEM).EmitPush(0).Emit(OpCode.PICKITEM).EmitPush(1000).Emit(OpCode.EQUAL).Emit(OpCode.ASSERT));
        UInt160 root = fx.Deploy("verifiers/MultiSigVerifier", core.ToArray());
        void Configure(params UInt160[] children) => fx.CallVoid(core, "forward", root, "setConfig", new object?[] { Account, children.Cast<object?>().ToArray(), children.Length });
        object[] Op(int slots) => RuntimeFixture.UserOp(core, "business", Array.Empty<object?>(), 0, 0,
            fx.StdLibSerialize(Enumerable.Range(0, slots).Select(_ => (object?)Array.Empty<byte>()).ToArray()));
        object?[] Result() => new object?[] { new object?[] { 1000 } };
        Configure(observer);
        fx.CallVoid(core, "forward", root, "postExecute", new object?[] { Account, Op(1), Result() });
        Configure(mutator, observer);
        fx.CallVoid(core, "forward", root, "postExecute", new object?[] { Account, Op(2), Result() });
    }
}
