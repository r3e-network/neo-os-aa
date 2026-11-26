// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccountInvocationContext.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms, with or without
// modifications are permitted.

using Microsoft.VisualStudio.TestTools.UnitTesting;
using Moq;
using Neo.Extensions;
using Neo.IO;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.UnitTests.Extensions;
using Neo.VM;
using System;
using System.Linq;
using System.Numerics;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// The engine-local state of the native core: the account lock and the proxy it covers, and the caller-frame binding
    /// of a module grant and of the target grant.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountInvocationContext
    {
        private static UInt160 Address(byte value) => new(Enumerable.Repeat(value, 20).ToArray());
        private static readonly UInt160 Account = Address(1), OtherAccount = Address(2), Root = Address(3), Child = Address(4);
        private static ApplicationEngine Engine(TriggerType trigger = TriggerType.Application) =>
            ApplicationEngine.Create(trigger, null, TestBlockchain.GetTestSnapshotCache(), settings: TestProtocolSettings.Default, gas: 1_000_000);
        private static SmartAccountInvocationContext Authority(ApplicationEngine engine) => engine.GetState(() => new SmartAccountInvocationContext());
        private static ExecutionContext Context(ApplicationEngine engine, UInt160 hash, ExecutionContext parent = null, bool deployed = true) =>
            engine.LoadScript(new byte[] { (byte)OpCode.RET }, configureState: s =>
            {
                s.ScriptHash = hash;
                var contract = TestUtils.GetContract(new byte[] { (byte)OpCode.RET }, TestUtils.CreateManifest("call", ContractParameterType.Void));
                contract.Hash = hash;
                s.Contract = deployed ? contract : null;
                s.CallingContext = parent;
            });
        private static void Query(ApplicationEngine engine, ExecutionContext caller) => Context(engine, SmartAccountProtocol.ServiceHash, caller);
        private static bool Module(SmartAccountInvocationContext authority, ApplicationEngine engine, UInt160 account = null,
            SmartAccountCallbackPhase phase = SmartAccountCallbackPhase.Validation) =>
            authority.IsModuleAuthorized(engine, account ?? Account, phase);
        private static readonly BigInteger ModuleId = new(7);

        [TestMethod]
        public void AccountLockRejectsReentryAndCoversOnlyTheEnteredProxy()
        {
            var authority = new SmartAccountInvocationContext();
            UInt160 proxy = SmartAccountProtocol.GetAccountAddress(Account);
            UInt160 otherProxy = SmartAccountProtocol.GetAccountAddress(OtherAccount);
            Assert.IsFalse(authority.IsAccountProxyActive(proxy));
            var outer = authority.EnterAccount(Account);
            // §3.6: while an account is entered, entering the same account is
            // direct re-entry and entering another account is cross-account
            // recursion. Both fault with the shared code.
            foreach (UInt160 nested in new[] { Account, OtherAccount })
            {
                var refused = Assert.ThrowsExactly<InvalidOperationException>(() => authority.EnterAccount(nested));
                Assert.AreEqual(SmartAccountModuleProtocol.ErrorReentrancyForbidden, refused.Message);
            }
            // A refused entry installs nothing: the proxy of no second account
            // can become a principal of this invocation.
            Assert.IsTrue(authority.IsAccountProxyActive(proxy));
            Assert.IsFalse(authority.IsAccountProxyActive(otherProxy));
            Assert.IsFalse(authority.IsAccountProxyActive(Account));
            Assert.IsFalse(authority.IsAccountProxyActive(null));
            outer.Dispose();
            Assert.IsFalse(authority.IsAccountProxyActive(proxy));
            // The next entry, of either account, starts from an empty lock.
            using var next = authority.EnterAccount(OtherAccount);
            Assert.IsTrue(authority.IsAccountProxyActive(otherProxy));
            Assert.IsFalse(authority.IsAccountProxyActive(proxy));
        }

        [TestMethod]
        public void AModuleGrantNeedsTheAccountThePhaseAndTheCallbackCallerFrame()
        {
            using var engine = Engine(); var authority = Authority(engine);
            var callback = Context(engine, Root);
            var anchor = callback.GetState<ExecutionContextState>();
            // No grant without the entered account, and none for another account.
            Assert.ThrowsExactly<InvalidOperationException>(() => authority.EnterCallback(OtherAccount, ModuleId, Root,
                SmartAccountCallbackPhase.Validation, anchor));
            using var account = authority.EnterAccount(Account);
            var grant = authority.EnterCallback(Account, ModuleId, Root, SmartAccountCallbackPhase.Validation, anchor);
            Assert.AreEqual(ModuleId, authority.CallbackModuleId);
            Assert.AreEqual(Root, authority.CallbackContract);
            Assert.IsFalse(Module(authority, engine), "The callback frame itself is not the core query.");
            Assert.IsFalse(authority.IsWitnessAuthorized(engine, SmartAccountProtocol.GetAccountAddress(Account)));
            Query(engine, callback);
            Assert.IsTrue(Module(authority, engine));
            Assert.IsFalse(Module(authority, engine, account: OtherAccount));
            Assert.IsFalse(Module(authority, engine, phase: SmartAccountCallbackPhase.TargetDispatch));
            Assert.IsFalse(Module(authority, engine, phase: (SmartAccountCallbackPhase)99));
            Assert.IsFalse(authority.IsTargetAuthorized(engine, Account));
            authority.ExitCallback(grant);
            Assert.IsFalse(Module(authority, engine));
            Assert.AreEqual(BigInteger.Zero, authority.CallbackModuleId);
        }

        [TestMethod]
        public void ModuleGrantNeverInheritsToNestedCalls()
        {
            using var engine = Engine(); var authority = Authority(engine);
            using var account = authority.EnterAccount(Account);
            var original = Context(engine, Root);
            var grant = authority.EnterCallback(Account, ModuleId, Root,
                SmartAccountCallbackPhase.Validation, original.GetState<ExecutionContextState>());
            Query(engine, original.Clone(0));
            Assert.IsTrue(Module(authority, engine), "An internal call frame of the anchored module keeps the phase grant.");
            Query(engine, Context(engine, Root, original));
            Assert.IsFalse(Module(authority, engine), "A fresh call into the same code is a different invocation.");
            Query(engine, Context(engine, Child, original));
            Assert.IsFalse(Module(authority, engine), "A sibling contract of the module never inherits the grant.");
            Query(engine, original);
            Assert.IsTrue(Module(authority, engine));
            authority.ExitCallback(grant);
            Query(engine, original);
            Assert.IsFalse(Module(authority, engine));
        }

        [TestMethod]
        public void ALeafCallbackSuspendsTheCompositeGrantAndExitRestoresIt()
        {
            using var engine = Engine(); var authority = Authority(engine);
            using var account = authority.EnterAccount(Account);
            var composite = Context(engine, Root);
            var parent = authority.EnterCallback(Account, ModuleId, Root,
                SmartAccountCallbackPhase.Validation, composite.GetState<ExecutionContextState>());
            var leafFrame = Context(engine, Child, composite);
            var leaf = authority.EnterCallback(Account, ModuleId + 1, Child,
                SmartAccountCallbackPhase.MemberValidation, leafFrame.GetState<ExecutionContextState>());
            Query(engine, leafFrame);
            Assert.IsTrue(Module(authority, engine, phase: SmartAccountCallbackPhase.MemberValidation));
            Assert.AreEqual(ModuleId + 1, authority.CallbackModuleId);
            Assert.AreEqual(Child, authority.CallbackContract);
            Query(engine, composite);
            Assert.IsFalse(Module(authority, engine), "The composite frame is not the leaf callback's caller.");
            authority.ExitCallback(leaf);
            Query(engine, composite);
            Assert.IsTrue(Module(authority, engine));
            Assert.AreEqual(ModuleId, authority.CallbackModuleId);
            Assert.AreEqual(Root, authority.CallbackContract);
            authority.ExitCallback(parent);
            Query(engine, composite);
            Assert.IsFalse(Module(authority, engine));
        }

        [TestMethod]
        public void TargetGrantIsNotAModuleGrantOrADescendantWitness()
        {
            using var engine = Engine(); var authority = Authority(engine);
            using var account = authority.EnterAccount(Account);
            var target = Context(engine, Root);
            Assert.ThrowsExactly<InvalidOperationException>(() => authority.EnterTarget(OtherAccount, Root,
                target.GetState<ExecutionContextState>()));
            // The core itself is never a target: the identity is refused before any frame is entered.
            var selfTarget = Assert.ThrowsExactly<ArgumentException>(() => authority.EnterTarget(Account,
                SmartAccountProtocol.ServiceHash, target.GetState<ExecutionContextState>()));
            Assert.Contains(SmartAccountModuleProtocol.ErrorPhaseViolation, selfTarget.Message);
            using var grant = authority.EnterTarget(Account, Root, target.GetState<ExecutionContextState>());
            UInt160 proxy = SmartAccountProtocol.GetAccountAddress(Account);
            // The target frame itself answers for the account witness, and for nothing else.
            Assert.IsTrue(authority.IsWitnessAuthorized(engine, proxy));
            Assert.IsFalse(authority.IsWitnessAuthorized(engine, null));
            Assert.IsFalse(authority.IsWitnessAuthorized(engine, SmartAccountProtocol.GetAccountAddress(OtherAccount)));
            Assert.IsFalse(authority.IsTargetAuthorized(engine, Account), "the target frame is not the proxy script");
            // A core query made by the target is not the target frame: it never answers for the account witness.
            Query(engine, target);
            Assert.IsTrue(authority.IsTargetAuthorized(engine, Account));
            Assert.IsFalse(authority.IsTargetAuthorized(engine, OtherAccount));
            Assert.IsFalse(authority.IsWitnessAuthorized(engine, proxy));
            Assert.IsFalse(Module(authority, engine));
            Assert.AreEqual(BigInteger.Zero, authority.CallbackModuleId);
            var nested = Context(engine, Root, target);
            Query(engine, nested);
            Assert.IsFalse(authority.IsTargetAuthorized(engine, Account));
            Assert.IsFalse(authority.IsWitnessAuthorized(engine, proxy));
            Query(engine, target);
            grant.Dispose();
            Assert.IsFalse(authority.IsTargetAuthorized(engine, Account));
            Assert.IsFalse(authority.IsWitnessAuthorized(engine, proxy));
        }

        [TestMethod]
        public void VerificationOnlyPermitsValidationContext()
        {
            foreach (var trigger in new[] { TriggerType.Verification, TriggerType.OnPersist, TriggerType.PostPersist })
            {
                using var engine = Engine(trigger); var authority = Authority(engine);
                using var account = authority.EnterAccount(Account);
                var caller = Context(engine, Root);
                foreach (var phase in new[] { SmartAccountCallbackPhase.Validation, SmartAccountCallbackPhase.Completion, SmartAccountCallbackPhase.Configuration })
                {
                    var grant = authority.EnterCallback(Account, ModuleId, Root,
                        phase, caller.GetState<ExecutionContextState>());
                    Query(engine, caller);
                    Assert.AreEqual(trigger == TriggerType.Verification && phase == SmartAccountCallbackPhase.Validation,
                        Module(authority, engine, phase: phase));
                    authority.ExitCallback(grant);
                }
                using var target = authority.EnterTarget(Account, Root, caller.GetState<ExecutionContextState>());
                Query(engine, caller);
                Assert.IsFalse(authority.IsTargetAuthorized(engine, Account));
                Assert.IsFalse(authority.IsWitnessAuthorized(engine, SmartAccountProtocol.GetAccountAddress(Account)));
            }
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void RealVmTargetGrantExcludesNestedContractsAndDynamicScripts(bool huyao)
        {
            var snapshot = TestBlockchain.GetTestSnapshotCache();
            UInt160 proxy = SmartAccountProtocol.GetAccountAddress(Account);
            // Every frame below asks the real System.Runtime.CheckWitness syscall for the account proxy and asserts
            // that the answer is false. The target frame itself asserts the opposite.
            byte[] Deny()
            {
                using var script = new ScriptBuilder();
                script.EmitPush(proxy).EmitSysCall(ApplicationEngine.System_Runtime_CheckWitness).Emit(OpCode.NOT).Emit(OpCode.ASSERT);
                return script.ToArray();
            }
            var leaf = TestUtils.GetContract(Deny(), TestUtils.CreateManifest("call", ContractParameterType.Void));
            snapshot.AddContract(leaf.Hash, leaf);
            using var code = new ScriptBuilder();
            code.EmitPush(proxy).EmitSysCall(ApplicationEngine.System_Runtime_CheckWitness).Emit(OpCode.ASSERT).EmitDynamicCall(leaf.Hash, "call")
                .Emit(OpCode.DROP).Emit(OpCode.NEWARRAY0).EmitPush(CallFlags.ReadOnly).EmitPush(Deny())
                .EmitSysCall(ApplicationEngine.System_Runtime_LoadScript).Emit(OpCode.DROP).Emit(OpCode.RET);
            var target = TestUtils.GetContract(code.ToArray(), TestUtils.CreateManifest("call", ContractParameterType.Void));
            snapshot.AddContract(target.Hash, target);
            var diagnostic = new Mock<IDiagnostic>();
            var hardforks = TestProtocolSettings.Default.Hardforks.SetItem(Hardfork.HF_SmartAccountV1, 0)
                .SetItem(Hardfork.HF_Huyao, huyao ? 0U : uint.MaxValue);
            using var engine = ApplicationEngine.Create(TriggerType.Application, null, snapshot,
                settings: TestProtocolSettings.Default with { Hardforks = hardforks }, gas: 100_000_000, diagnostic: diagnostic.Object);
            var authority = Authority(engine);
            using var account = authority.EnterAccount(Account);
            var actual = engine.LoadContract(target, target.Manifest.Abi.Methods[0], CallFlags.All).GetState<ExecutionContextState>();
            using var grant = authority.EnterTarget(Account, target.Hash, actual);
            int rootSteps = 0, leafSteps = 0, dynamicSteps = 0;
            diagnostic.Setup(d => d.PreExecuteInstruction(It.IsAny<Instruction>())).Callback<Instruction>(_ =>
            {
                var state = engine.CurrentContext.GetState<ExecutionContextState>();
                if (ReferenceEquals(state, actual)) rootSteps++;
                else if (state.Contract is null) dynamicSteps++;
                else leafSteps++;
            });
            // HALT proves the target frame was answered true and every frame it called in turn false.
            Assert.AreEqual(VMState.HALT, engine.Execute(), engine.FaultException?.ToString());
            Assert.IsGreaterThan(0, rootSteps); Assert.IsGreaterThan(0, leafSteps); Assert.IsGreaterThan(0, dynamicSteps);
        }
    }
}
