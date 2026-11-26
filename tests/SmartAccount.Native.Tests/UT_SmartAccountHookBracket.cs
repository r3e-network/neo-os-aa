//
// UT_SmartAccountHookBracket.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.
//

using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.UnitTests.Extensions;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using Array = Neo.VM.Types.Array;
using static Neo.UnitTests.SmartContract.Native.UT_SmartAccount;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// The generic hook bracket of the kernel around a user operation (spec
    /// §7.3/§11): pre hooks in ascending module order, the target, post hooks
    /// in reverse; the shape bounds of <c>hookProofs</c> and <c>hookData</c>;
    /// the rollback a failing hook forces on the target and the nonce; and the account batch entry. The callbacks
    /// run inside the declared system fee of the transaction; there is no per-call or aggregate budget.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountHookBracket
    {
        private const int ModeNone = 0, ModePostAbort = 1, ModePostFalse = 2, ModePreAbort = 3;
        private const int ModuleTypeHook = 4;
        private const int OpHookProofs = 12;
        private static readonly UInt160 Next = UInt160.Parse("0x0303030303030303030303030303030303030303");
        private static readonly UInt160 Token = NativeContract.GAS.Hash;

        /// <summary>Jump operands are relative to the jump opcode itself.</summary>
        private static void Jump(ScriptBuilder script, OpCode opcode, int from, int target) =>
            script.Emit(opcode, new byte[] { unchecked((byte)(target - from)) });

        /// <summary>Runs <paramref name="body"/> <paramref name="rounds"/> times; the counter is local 0.</summary>
        private static void Loop(ScriptBuilder script, int rounds, Action<ScriptBuilder> body)
        {
            using var probe = new ScriptBuilder();
            body(probe);
            int length = probe.Length;
            script.EmitPush(rounds).Emit(OpCode.STLOC0);
            int start = script.Length;
            script.Emit(OpCode.LDLOC0);
            Jump(script, OpCode.JMPIFNOT, script.Length, start + 1 + 2 + length + 4 + 2);
            body(script);
            script.Emit(OpCode.LDLOC0).Emit(OpCode.PUSH1).Emit(OpCode.SUB).Emit(OpCode.STLOC0);
            Jump(script, OpCode.JMP, script.Length, start);
        }

        /// <summary>
        /// Rewrites one value in the hook's own storage <paramref name="rounds"/> times
        /// (a deterministic GAS cost per round at the default storage price). Value local 1,
        /// key local 2, context local 3; the counter of <see cref="Loop"/> is local 0.
        /// </summary>
        private static void Burn(ScriptBuilder script, int rounds, int size)
        {
            script.EmitPush(new byte[1]).Emit(OpCode.STLOC2);
            script.EmitSysCall(ApplicationEngine.System_Storage_GetContext).Emit(OpCode.STLOC3);
            script.EmitPush(new byte[] { 0 }).Emit(OpCode.LDLOC2).Emit(OpCode.LDLOC3).EmitSysCall(ApplicationEngine.System_Storage_Put);
            script.EmitPush(new byte[size]).Emit(OpCode.STLOC1);
            Loop(script, rounds, body =>
                body.Emit(OpCode.LDLOC1).Emit(OpCode.LDLOC2).Emit(OpCode.LDLOC3).EmitSysCall(ApplicationEngine.System_Storage_Put));
        }

        private static byte[] HookProfile(string name) =>
            System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            {
                callbacks = new[] { "preCheck", "postCheck" },
                capabilities = new { compositeLayer = 0, instanceIsolation = true, messageCapability = false, thresholdMemberEligible = false },
                contractName = name, lifecycle = new[] { "onInstall", "onUninstall" }, moduleType = "hook", profileVersion = 1
            });

        /// <summary>
        /// Notifies <c>Hook</c> with <c>[label, size]</c>: the size of the value on top of
        /// the stack, or zero when <paramref name="sizeOnStack"/> is false.
        /// </summary>
        private static void Trace(ScriptBuilder script, string label, bool sizeOnStack)
        {
            if (sizeOnStack) script.Emit(OpCode.SIZE); else script.EmitPush(0);
            script.EmitPush(label);
            script.EmitPush(2).Emit(OpCode.PACK).EmitPush("Hook").EmitSysCall(ApplicationEngine.System_Runtime_Notify);
        }

        private static ContractEventDescriptor HookEvent() => new()
        {
            Name = "Hook", Parameters = [new ContractParameterDefinition { Name = "tag", Type = ContractParameterType.String },
                new ContractParameterDefinition { Name = "size", Type = ContractParameterType.Integer }]
        };

        /// <summary>
        /// A hook contract that traces its callbacks and spends <paramref name="preRounds"/> /
        /// <paramref name="postRounds"/> storage rounds in them. <paramref name="mode"/> selects the
        /// failure under test: an aborting pre hook, an aborting post hook or a post hook that
        /// returns a value although its ABI is Void.
        /// </summary>
        private static ContractState DeployHook(DataCache snapshot, int number, string label, int preRounds, int postRounds,
            int mode, int dataLength, int size = 400)
        {
            byte[] profile = HookProfile(label);
            using var script = new ScriptBuilder();
            List<ContractMethodDescriptor> methods = new();
            void Method(string methodName, ContractParameterType result, bool safe, Action<ScriptBuilder> body,
                params ContractParameterType[] parameters)
            {
                methods.Add(new ContractMethodDescriptor
                {
                    Name = methodName, ReturnType = result, Safe = safe, Offset = script.Length,
                    Parameters = parameters.Select((type, index) => new ContractParameterDefinition { Name = $"p{index}", Type = type }).ToArray(),
                });
                script.Emit(OpCode.INITSLOT, new byte[] { 4, (byte)parameters.Length });
                body(script);
                script.Emit(OpCode.RET);
            }
            Method("getModuleProfile", ContractParameterType.String, true, builder => builder.EmitPush(profile));
            foreach (string lifecycle in new[] { "onInstall", "onUninstall" })
                Method(lifecycle, ContractParameterType.Void, false, _ => { }, ContractParameterType.Hash160,
                    ContractParameterType.Integer, ContractParameterType.Integer, ContractParameterType.Array);
            Method("preCheck", ContractParameterType.ByteArray, false, builder =>
            {
                Trace(builder, "pre:" + label, false);
                if (mode == ModePreAbort) builder.Emit(OpCode.ABORT);
                Burn(builder, preRounds, size);
                builder.EmitPush(new byte[dataLength]);
            }, ContractParameterType.Hash160, ContractParameterType.Array);
            Method("postCheck", ContractParameterType.Void, false, builder =>
            {
                // hookData (argument 3) travelled from this hook's own preCheck.
                builder.Emit(OpCode.LDARG3);
                Trace(builder, "post:" + label, true);
                Burn(builder, postRounds, size);
                if (mode == ModePostAbort) builder.Emit(OpCode.ABORT);
                if (mode == ModePostFalse) builder.EmitPush(false);
            }, ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Any, ContractParameterType.ByteArray);
            ContractState contract = TestUtils.GetContract(script.ToArray());
            contract.Id = number;
            contract.Manifest.Name = label;
            contract.Manifest.Abi.Methods = methods.ToArray();
            contract.Manifest.Abi.Events = [HookEvent()];
            snapshot.AddContract(contract.Hash, contract);
            return contract;
        }

        /// <summary>A plain contract whose only entry notifies: the observable target of an operation.</summary>
        private static UInt160 DeployTarget(DataCache snapshot)
        {
            using var script = new ScriptBuilder();
            int offset = script.Length;
            script.EmitPush("target").Emit(OpCode.PUSH1).Emit(OpCode.PACK)
                .EmitPush("Tick").EmitSysCall(ApplicationEngine.System_Runtime_Notify).Emit(OpCode.RET);
            ContractState contract = TestUtils.GetContract(script.ToArray());
            contract.Id = 960;
            contract.Manifest.Name = "Target";
            contract.Manifest.Abi.Methods = [new ContractMethodDescriptor
            {
                Name = "tick", ReturnType = ContractParameterType.Void, Offset = offset,
                Parameters = [], Safe = false
            }];
            contract.Manifest.Abi.Events = [new ContractEventDescriptor { Name = "Tick", Parameters = [new ContractParameterDefinition { Name = "tag", Type = ContractParameterType.String }] }];
            snapshot.AddContract(contract.Hash, contract);
            return contract.Hash;
        }

        private static UInt160 RegisterGoverned(DataCache snapshot, out ContractState governor) =>
            UT_SmartAccountGovernance.Register(snapshot, 971, out governor);

        private static BigInteger InstallHook(DataCache snapshot, ContractState governor, UInt160 id,
            ContractState hook) =>
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, ModuleTypeHook, hook.Hash, new object[0])).GetInteger();

        private static BigInteger Sequence(DataCache snapshot, UInt160 id) =>
            Success(snapshot, "getNonce", [id, 0, new byte[32]]).GetInteger() & ((BigInteger.One << 64) - 1);

        private static void Fund(DataCache snapshot, UInt160 address)
        {
            UInt160 funder = Contract.GetBFTAddress(Settings.StandbyValidators);
            Success(snapshot, "transfer", [funder, address, 7, null], signers: [funder], target: Token);
        }

        private static BigInteger Balance(DataCache snapshot, UInt160 owner) =>
            Success(snapshot, "balanceOf", [owner], target: Token).GetInteger();

        /// <summary><c>hookProofs</c> entries as the harness serializes them: <c>[hookId, proof]</c> pairs.</summary>
        private static object[] Proof(params (BigInteger Id, int Bytes)[] entries) =>
            entries.Select(e => (object)new object[] { e.Id, new byte[e.Bytes] }).ToArray();

        [TestMethod]
        public void PreHooksRunInModuleOrderThenTheTargetThenPostHooksInReverse()
        {
            var snapshot = Snapshot();
            UInt160 id = RegisterGoverned(snapshot, out ContractState governor), target = DeployTarget(snapshot);
            // Installed in name order, so module ids and labels agree.
            BigInteger a = InstallHook(snapshot, governor, id, DeployHook(snapshot, 901, "A", 0, 0, ModeNone, 16));
            BigInteger b = InstallHook(snapshot, governor, id, DeployHook(snapshot, 902, "B", 0, 0, ModeNone, 32));
            BigInteger c = InstallHook(snapshot, governor, id, DeployHook(snapshot, 903, "C", 0, 0, ModeNone, 64));
            Assert.AreEqual(a + 1, b);
            Assert.AreEqual(b + 1, c);

            var operation = Operation(snapshot, id, target, "tick", []);
            using var engine = Invoke(snapshot, "executeUserOp", [id, operation]);
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            // Only the hook contracts notify "Hook"; the core's own events are
            // listed by name: the channel digest is emitted before the first pre
            // hook, the execution record after the last post hook.
            Assert.AreSequenceEqual(Trace(engine),
                new[] { "core:NonceChannelOpened", "pre:A", "pre:B", "pre:C", "Tick", "post:C", "post:B", "post:A", "core:UserOpExecuted" });
            // Each post hook received exactly the bytes its own pre hook returned.
            foreach (var (label, size) in new[] { ("post:A", 16), ("post:B", 32), ("post:C", 64) })
                Assert.AreEqual(size, Tagged(engine, label).State[1].GetInteger());
            Assert.AreEqual(1, Sequence(snapshot, id));
        }

        /// <summary>
        /// The observable order of an operation: hook traces by label, the
        /// target's notification, and every notification of the core by name.
        /// </summary>
        private static string[] Trace(ApplicationEngine engine) => engine.Notifications.Select(n => n.EventName switch
        {
            "Hook" => n.State[0].GetString(),
            "Tick" => "Tick",
            _ => "core:" + n.EventName,
        }).ToArray();

        private static NotifyEventArgs Tagged(ApplicationEngine engine, string label) =>
            engine.Notifications.Single(n => n.EventName == "Hook" && n.State[0].GetString() == label);

        [TestMethod]
        public void HookProofsAreBoundedByEntryCountOrderAndTotalBytes()
        {
            var snapshot = Snapshot();
            UInt160 id = RegisterGoverned(snapshot, out ContractState governor), target = DeployTarget(snapshot);
            InstallHook(snapshot, governor, id, DeployHook(snapshot, 901, "A", 0, 0, ModeNone, 0));
            foreach (var (label, proofs) in new (string, object[])[]
            {
                ("nine entries", Proof((1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 1), (8, 1), (9, 1))),
                ("4097 proof bytes", Proof((1, 512), (2, 512), (3, 512), (4, 512), (5, 512), (6, 512), (7, 512), (8, 513))),
                ("descending ids", Proof((2, 1), (1, 1))),
                ("zero id", Proof((0, 1), (1, 1))),
            })
            {
                var operation = Operation(snapshot, id, target, "tick", [], sign: false);
                operation[OpHookProofs] = proofs;
                using var refused = Invoke(snapshot, "executeUserOp", [id, operation]);
                Assert.AreEqual(VMState.FAULT, refused.State, label);
                Assert.Contains("SA_PROOF_INVALID", refused.FaultException!.ToString());
                Assert.IsEmpty(refused.Notifications);
            }
            // 4096 bytes in eight entries is the last accepted shape: the preview
            // reaches the digest (and only the signature is absent).
            var accepted = Operation(snapshot, id, target, "tick", [], sign: false);
            accepted[OpHookProofs] = Proof((1, 512), (2, 512), (3, 512), (4, 512), (5, 512), (6, 512), (7, 512), (8, 512));
            var preview = (Array)Success(snapshot, "validateUserOp", [id, accepted]);
            Assert.IsFalse(preview[0].GetBoolean());
            Assert.HasCount(32, preview[1].GetSpan().ToArray());
            Assert.AreEqual(0, Sequence(snapshot, id));
        }

        [TestMethod]
        public void HookDataIsBoundedByTheProfileLimit()
        {
            var snapshot = Snapshot();
            UInt160 id = RegisterGoverned(snapshot, out ContractState governor), target = DeployTarget(snapshot);
            InstallHook(snapshot, governor, id, DeployHook(snapshot, 901, "Big", 0, 0, ModeNone, 513));
            var operation = Operation(snapshot, id, target, "tick", []);
            using var refused = Invoke(snapshot, "executeUserOp", [id, operation]);
            Assert.AreEqual(VMState.FAULT, refused.State);
            Assert.Contains("SA_HOOK_DATA_TOO_LARGE", refused.FaultException!.ToString());
            Assert.IsEmpty(refused.Notifications, "the fault rolls the notifications of the attempt back");
            Assert.AreEqual(0, Sequence(snapshot, id));

            var other = Snapshot();
            UInt160 second = RegisterGoverned(other, out ContractState otherGovernor), otherTarget = DeployTarget(other);
            InstallHook(other, otherGovernor, second, DeployHook(other, 902, "Edge", 0, 0, ModeNone, 512));
            using var accepted = Invoke(other, "executeUserOp", [second, Operation(other, second, otherTarget, "tick", [])]);
            Assert.AreEqual(VMState.HALT, accepted.State, accepted.FaultException?.ToString());
            Assert.AreEqual(512, Tagged(accepted, "post:Edge").State[1].GetInteger());
        }

        [TestMethod]
        [DataRow(ModePreAbort)]
        [DataRow(ModePostAbort)]
        [DataRow(ModePostFalse)]
        public void AFailingHookRollsBackTheTargetAndTheNonce(int mode)
        {
            var snapshot = Snapshot();
            UInt160 id = RegisterGoverned(snapshot, out ContractState governor), address = SmartAccountProtocol.GetAccountAddress(id);
            Fund(snapshot, address);
            InstallHook(snapshot, governor, id, DeployHook(snapshot, 901, "Failing", 0, 0, mode, 0));
            BigInteger nonce = Success(snapshot, "getNonce", [id, 0, new byte[32]]).GetInteger();
            var operation = Operation(snapshot, id, Token, "transfer", [address, Next, 3, null]);

            using var refused = Invoke(snapshot, "executeUserOp", [id, operation]);
            Assert.AreEqual(VMState.FAULT, refused.State);
            if (mode == ModePostFalse)
                // A Void callback that leaves a value is refused by the VM frame contract.
                Assert.Contains("Return value count mismatch", refused.FaultException!.GetBaseException().Message);
            else
                Assert.Contains("ABORT is executed.", refused.FaultException!.GetBaseException().Message);
            Assert.AreEqual(0, Balance(snapshot, Next), "the target transfer is rolled back with the hook");
            Assert.AreEqual(7, Balance(snapshot, address));
            Assert.AreEqual(nonce, Success(snapshot, "getNonce", [id, 0, new byte[32]]).GetInteger(), "the nonce is not consumed");
            Assert.IsEmpty(refused.Notifications);

            // The same transfer is executable once the hook is gone (a fresh
            // operation: removing the hook advanced the configuration nonce).
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovRemove,
                [id, ((Array)((Array)Success(snapshot, "getModules", [id, "hook", 0, 8]))[0])[0].GetInteger(),
                    new object[0]]);
            Assert.IsTrue(Success(snapshot, "executeUserOp", [id, Operation(snapshot, id, Token, "transfer", [address, Next, 3, null])]).GetBoolean());
            Assert.AreEqual(3, Balance(snapshot, Next));
        }

        [TestMethod]
        public void AccountBatchIsBoundedAndAtomic()
        {
            var snapshot = Snapshot();
            UInt160[] ids = Enumerable.Range(1, 66).Select(i => SmartAccountProtocol.GetAccountId(Custody, Salt(i))).ToArray();
            object[] Salts(int count) => Enumerable.Range(1, count).Select(i => (object)Salt(i)).ToArray();
            object[] Ids(int count) => ids.Take(count).Cast<object>().ToArray();
            void Refused(string label, object[] accountIds, object[] salts)
            {
                using var refused = Invoke(snapshot, "createAccounts", [accountIds, Custody, salts]);
                Assert.AreEqual(VMState.FAULT, refused.State, label);
                Assert.Contains("SA_MODULE_LIMIT_BATCH", refused.FaultException!.ToString());
            }
            Refused("empty batch", [], []);
            Refused("sixty-five pairs", Ids(65), Salts(65));
            Refused("length mismatch", Ids(3), Salts(2));

            // A duplicate inside the batch faults after the first write: nothing of the batch survives.
            using (var duplicate = Invoke(snapshot, "createAccounts", [new object[] { ids[0], ids[1], ids[0] }, Custody, new object[] { Salt(1), Salt(2), Salt(1) }]))
            {
                Assert.AreEqual(VMState.FAULT, duplicate.State);
                Assert.Contains("SA_OPERATION_MALFORMED", duplicate.FaultException!.ToString());
            }
            Assert.IsFalse(((Array)Success(snapshot, "getAccount", [ids[0]]))[0].GetBoolean());
            Assert.IsFalse(((Array)Success(snapshot, "getAccount", [ids[1]]))[0].GetBoolean());

            Success(snapshot, "createAccounts", [Ids(64), Custody, Salts(64)]);
            for (int i = 0; i < 64; i++)
            {
                var account = (Array)Success(snapshot, "getAccount", [ids[i]]);
                Assert.IsTrue(account[0].GetBoolean());
                Assert.AreEqual(Custody, new UInt160(account[2].GetSpan()));
            }
            Assert.IsFalse(((Array)Success(snapshot, "getAccount", [ids[64]]))[0].GetBoolean(), "the sixty-fifth pair was never created");
        }

        private static byte[] Salt(int i)
        {
            byte[] salt = new byte[32];
            salt[28] = (byte)(i >> 24); salt[29] = (byte)(i >> 16); salt[30] = (byte)(i >> 8); salt[31] = (byte)i;
            return salt;
        }

        [TestMethod]
        public void NonceSequenceIsVisiblePerAccountAndBoundedToTheChannelDomain()
        {
            var snapshot = Snapshot();
            UInt160 first = Register(snapshot);
            UInt160 second = SmartAccountProtocol.GetAccountId(Custody, Salt(2));
            Success(snapshot, "createAccount", [second, Custody, Salt(2), new object[0]]);
            BigInteger Channel(UInt160 id) => Success(snapshot, "getNonce", [id, 0, new byte[32]]).GetInteger() >> 64;
            BigInteger channel = Channel(first);
            Assert.AreEqual(BigInteger.Zero, Success(snapshot, "getNonceSequence", [first, channel]).GetInteger());
            Assert.AreEqual(BigInteger.Zero, Success(snapshot, "getNonceSequence", [second, Channel(second)]).GetInteger());

            // One operation moves only its own account's cursor.
            Success(snapshot, "executeUserOp", [first, Operation(snapshot, first, Token, "symbol", [])]);
            Assert.AreEqual(1, Success(snapshot, "getNonceSequence", [first, channel]).GetInteger());
            Assert.AreEqual(1, Success(snapshot, "getNonce", [first, 0, new byte[32]]).GetInteger() & ((BigInteger.One << 64) - 1));
            Assert.AreEqual(0, Success(snapshot, "getNonceSequence", [second, Channel(second)]).GetInteger());

            // A channel nobody derived reads the same cursor table: zero, never a fault.
            Assert.AreEqual(0, Success(snapshot, "getNonceSequence", [first, channel + 1]).GetInteger());

            UInt160 unknown = SmartAccountProtocol.GetAccountId(Custody, Salt(3));
            using var missing = Invoke(snapshot, "getNonceSequence", [unknown, channel]);
            Assert.Contains("SA_ACCOUNT_NOT_FOUND", missing.FaultException!.ToString());
            using var outside = Invoke(snapshot, "getNonceSequence", [first, BigInteger.One << 191]);
            Assert.Contains("SA_NONCE_CHANNEL_COLLISION", outside.FaultException!.ToString());
        }
    }
}
