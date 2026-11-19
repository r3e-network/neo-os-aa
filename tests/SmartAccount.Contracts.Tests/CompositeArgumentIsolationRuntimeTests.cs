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
using Neo.VM;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Real VM regression vectors for untrusted callbacks mutating shared VM values.
/// </summary>
/// <remarks>
/// The v3 suite drove a mock core stub that owned a composite root verifier with a
/// child roster (<c>setConfig</c> / <c>setHooks</c>). v4 retired that layer: hooks
/// are independent instances in the core-owned <c>hookOrder</c> and validators are
/// routed per instance or through a core-owned threshold policy, so the callbacks
/// that can mutate shared VM state are exercised through the real core here.
/// <para>
/// The invariant is unchanged and now lives in the core: every module callback
/// receives <c>BuildCanonicalOperationView(operation)</c> — a fresh array whose
/// argument list and <c>hookProofs</c> are deep-cloned — and the completion and
/// hook-post callbacks each receive their own <c>CloneCallbackValue(result)</c>.
/// A callback can therefore mutate everything it can reach without touching the
/// authenticated operation, the target's dispatch arguments, a sibling callback
/// or the result the caller receives.
/// </para>
/// </remarks>
[TestClass]
public class CompositeArgumentIsolationRuntimeTests
{
    private static readonly UInt160 Recipient = UInt160.Parse("0x7272727272727272727272727272727272727272");

    // ========================================================================
    // Hand-built module artifacts (hookOrder instances and one routed validator)
    // ========================================================================

    private static string Profile(string name, string moduleType, string callbacks) =>
        "{\"callbacks\":[" + callbacks + "],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":true,"
        + "\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"" + name
        + "\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"" + moduleType
        + "\",\"profileVersion\":1}";

    private static UInt160 DeployModule(RuntimeFixture fx, string name, string moduleType, string callbacks,
        Action<ModuleBuilder> build)
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

        Method("getModuleProfile", ContractParameterType.String, true);
        script.EmitPush(Encoding.UTF8.GetBytes(Profile(name, moduleType, callbacks))).Emit(OpCode.RET);

        // Lifecycle callbacks only have to tolerate the core's configuration phase.
        foreach (string lifecycle in new[] { "onInstall", "onUninstall", "configure" })
        {
            Method(lifecycle, ContractParameterType.Void, false, ContractParameterType.Hash160,
                ContractParameterType.Integer, ContractParameterType.Integer, ContractParameterType.Array);
            script.Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.RET);
        }

        ModuleBuilder builder = new(script, Method);
        build(builder);

        NefFile nef = new() { Compiler = "Argument isolation fixture", Source = "", Tokens = [], Script = script.ToArray() };
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

    private sealed class ModuleBuilder(ScriptBuilder script, Action<string, ContractParameterType, bool, ContractParameterType[]> method)
    {
        public ScriptBuilder Script { get; } = script;

        public void Method(string name, ContractParameterType result, params ContractParameterType[] parameters) =>
            method(name, result, false, parameters);

        /// <summary>Safe callback (spec §9: validation and message callbacks are read-only).</summary>
        public void SafeMethod(string name, ContractParameterType result, params ContractParameterType[] parameters) =>
            method(name, result, true, parameters);
    }

    /// <summary>Hook whose pre/post callback bodies are supplied by the caller.</summary>
    private static UInt160 HookModule(RuntimeFixture fx, string name,
        Action<ScriptBuilder> pre, Action<ScriptBuilder> post)
    {
        return DeployModule(fx, name, "hook", "\"preCheck\",\"postCheck\"", builder =>
        {
            builder.Method("preCheck", ContractParameterType.ByteArray,
                ContractParameterType.Hash160, ContractParameterType.Array);
            pre(builder.Script);
            builder.Script.Emit(OpCode.RET);

            builder.Method("postCheck", ContractParameterType.Void,
                ContractParameterType.Hash160, ContractParameterType.Array,
                ContractParameterType.Any, ContractParameterType.ByteArray);
            post(builder.Script);
            builder.Script.Emit(OpCode.RET);
        });
    }

    /// <summary>Validator whose validateUserOp body is supplied by the caller.</summary>
    private static UInt160 ValidatorModule(RuntimeFixture fx, string name, Action<ScriptBuilder> validate)
    {
        return DeployModule(fx, name, "validator", "\"validateUserOp\",\"onUserOpComplete\"", builder =>
        {
            // The ABI declares Boolean and pins the callback safe; the body below can
            // still answer with another type.
            builder.SafeMethod("validateUserOp", ContractParameterType.Boolean,
                ContractParameterType.Hash160, ContractParameterType.ByteArray, ContractParameterType.Array);
            validate(builder.Script);
            builder.Script.Emit(OpCode.RET);

            builder.Method("onUserOpComplete", ContractParameterType.Void,
                ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Any);
            builder.Script.Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.RET);
        });
    }

    // ========================================================================
    // Callback bodies. Neo pushes a call's arguments so that argument 0 is on TOP
    // of the evaluation stack, so preCheck(accountId, operation) reaches operation
    // with a single DROP and postCheck(accountId, operation, result, hookData)
    // with two. A Void callback must leave the stack empty; preCheck returns its
    // hookData as the only remaining item.
    // ========================================================================

    private static void Approve(ScriptBuilder script) =>
        script.Emit(OpCode.DROP).Emit(OpCode.DROP).EmitPush(Array.Empty<byte>());

    private static void NoOp(ScriptBuilder script) =>
        script.Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP);

    /// <summary>
    /// preCheck that rewrites operation[3][3][0] (the token's actual debit) in the
    /// callback's own copy of the canonical operation view.
    /// </summary>
    private static void MutateArguments(ScriptBuilder script)
    {
        script.Emit(OpCode.DROP);                          // accountId
        script.EmitPush(3).Emit(OpCode.PICKITEM);          // operation[3] = args
        script.EmitPush(3).Emit(OpCode.PICKITEM);          // args[3] = nested transfer data
        script.EmitPush(0).EmitPush(9999).Emit(OpCode.SETITEM);
        script.EmitPush(Array.Empty<byte>());              // hookData
    }

    /// <summary>postCheck that rewrites result[0] in its own copy.</summary>
    private static void MutateResult(ScriptBuilder script)
    {
        script.Emit(OpCode.DROP).Emit(OpCode.DROP);        // accountId, operation
        script.EmitPush(0).EmitPush(9999).Emit(OpCode.SETITEM);  // result[0] = 9999
        script.Emit(OpCode.DROP);                          // hookData
    }

    /// <summary>postCheck that asserts result[0] is still the business value it accepted.</summary>
    private static void ObserveResult(ScriptBuilder script, int expected)
    {
        script.Emit(OpCode.DROP).Emit(OpCode.DROP);        // accountId, operation
        script.EmitPush(0).Emit(OpCode.PICKITEM);          // result[0]
        script.EmitPush(expected).Emit(OpCode.EQUAL).Emit(OpCode.ASSERT);
        script.Emit(OpCode.DROP);                          // hookData
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

        /// <summary>
        /// Operation routed to one installed validator. Installing the first
        /// validator disables the built-in route, so the routing subject must be
        /// the module id and the channel follows the module credential.
        /// </summary>
        public object[] RoutedOperation(BigInteger moduleId, UInt160 target, string method, object?[] args)
        {
            BigInteger mask = (BigInteger.One << 64) - 1;
            BigInteger packed = Fx.PackedNonce(Core, AccountId, moduleId);
            return RuntimeFixture.UserOp(target, method, args, packed & ~mask,
                Fx.Now() + 3_600_000, new byte[] { 0x00 },
                validatorId: moduleId, credentialGeneration: 1,
                configurationNonce: Fx.AccountConfigurationNonce(Core, AccountId));
        }

        public Neo.VM.Types.StackItem Execute(object[] op) =>
            Fx.Call(Core, "executeUserOp", AccountId, (object)op);

        public void Dispose() => Key.Dispose();
    }

    [TestMethod]
    public void HookCannotChangeTheTargetsAuthenticatedArguments()
    {
        using Harness h = new();
        UInt160 mutator = HookModule(h.Fx, "ArgumentMutatingHook", MutateArguments, NoOp);
        UInt160 account = h.Create("argument-isolation", (object)h.Fx.InstallHook(mutator));

        // The adversarial token debits data[0], not the declared amount, so the
        // target's observable state proves exactly which argument list it ran with.
        h.Fx.CallVoid(h.Probe, "setBalance", account, (BigInteger)1000);
        object?[] args = { account, Recipient, (BigInteger)5, new object?[] { (BigInteger)5, new object?[] { (BigInteger)1000 } } };

        h.Execute(h.Operation(h.Probe, "transfer", args, 0));

        Assert.AreEqual(new BigInteger(995), h.Fx.CallInteger(h.Probe, "balanceOf", account),
            "The target must debit the authenticated argument list, not the hook's copy");
        Assert.AreEqual(BigInteger.One, h.Fx.CurrentNonceSequence(h.Core, account, 0));
    }

    [TestMethod]
    public void HookPostCheckCannotChangeTheNextHooksResult()
    {
        using Harness h = new();
        UInt160 observer = HookModule(h.Fx, "ResultObservingHook", Approve, script => ObserveResult(script, 1000));
        UInt160 mutator = HookModule(h.Fx, "ResultMutatingHook", Approve, MutateResult);

        // Hook order = install order, so postCheck runs in reverse: the mutator
        // runs first and the observer must still see the untouched business value.
        UInt160 account = h.Create("result-isolation",
            (object)h.Fx.InstallHook(observer), (object)h.Fx.InstallHook(mutator));
        h.Fx.CallVoid(h.Probe, "setBalance", account, (BigInteger)1000);

        object?[] args = { account, Recipient, (BigInteger)5, new object?[] { (BigInteger)5, new object?[] { (BigInteger)1000 } } };
        Neo.VM.Types.StackItem result = h.Execute(h.Operation(h.Probe, "transfer", args, 0));

        Assert.AreEqual(new BigInteger(1000), ((Neo.VM.Types.Array)result)[0].GetInteger(),
            "The caller must observe the business result, not the mutating hook's edit");
        Assert.AreEqual(new BigInteger(995), h.Fx.CallInteger(h.Probe, "balanceOf", account));
    }

    [TestMethod]
    public void IntegerReplyCannotCountAsBooleanApproval()
    {
        using Harness h = new();
        // validateUserOp answers Integer 1 while its manifest pins Boolean. v3 drove
        // the reply through a mock core that type-checked it; v4 pins the callback
        // surface at install and the core refuses anything but a Boolean reply, so a
        // truthy non-boolean can never be coerced into an approval.
        UInt160 numeric = ValidatorModule(h.Fx, "NonBooleanApprover",
            script => script.Emit(OpCode.DROP).Emit(OpCode.DROP).Emit(OpCode.DROP).EmitPush(BigInteger.One));
        UInt160 account = h.Create("non-boolean-approval", (object)h.Fx.InstallValidator(numeric));
        BigInteger moduleId = h.Fx.ModuleIds(h.Core, account, RuntimeFixture.ModuleTypeNameValidator)[0];

        // The target method exists, so the only refusal left is the reply type.
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(h.RoutedOperation(moduleId, h.Probe, "balanceOf", new object?[] { account })));

        // Fail-closed: the reply approved nothing and consumed no nonce.
        StringAssert.Contains(fault.Message, "SA_MODULE_TYPE_UNSUPPORTED");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Core, account, moduleId));
    }
}
