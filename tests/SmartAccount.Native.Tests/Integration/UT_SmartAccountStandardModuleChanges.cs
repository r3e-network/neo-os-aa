using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Extensions;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.UnitTests.Extensions;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using Array = Neo.VM.Types.Array;
using static Neo.UnitTests.SmartContract.Native.UT_SmartAccount;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// Module changes against the v4.1 core and the standard GovernanceModule
    /// and HookOrchestratorModule: the hook order is module state that changes
    /// only through a reviewed <c>configureModule</c> landing (the former
    /// governance action 4 and the direct order entry are closed), the former
    /// recovery action 8 is retired in favour of the recovery module's
    /// configure, and who may administer an account at all.
    /// Every scenario runs with freshly built module artifacts, so none of
    /// these tests depends on a digest pinned in the core.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountStandardModuleChanges
    {
        private const int Validator = 1, Hook = 4, Recovery = 5;
        private const ulong MaturityMs = 24 * 60 * 60 * 1000;
        private const ulong Timelock = 7UL * 24 * 60 * 60 * 1000;
        private const string HookOrderUpdated = "HookOrderUpdated";
        private const string Retired = "doesn't exist in the contract";
        private static readonly UInt160 Guardian = UInt160.Parse("0x0505050505050505050505050505050505050505");
        private static readonly UInt160 Incoming = UInt160.Parse("0x0707070707070707070707070707070707070707");
        private static readonly UInt160 Stranger = UInt160.Parse("0x0909090909090909090909090909090909090909");

        /// <summary>
        /// The orchestrator grammar — validator, isolated, the two operation
        /// callbacks — with a different contract name and, by the v4.1 schema,
        /// no planner seat: the optional <c>hookPlanner</c> flag is absent.
        /// </summary>
        private const string LookalikeProfile =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":true,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"HookOrchestratorLookalike\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private const string RelayProfile =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":true,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"{0}\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        // ---- v4.1 harness ----

        private static ProtocolSettings V41 => Settings;

        private static DataCache Snapshot() => UT_SmartAccount.Snapshot(V41);

        private static ApplicationEngine Invoke(DataCache snapshot, string method, object[] args, ulong time = 1000,
            UInt160[] signers = null, UInt160 target = null) =>
            UT_SmartAccount.Invoke(snapshot, method, args, time, signers, target: target, settings: V41);

        private static StackItem Success(DataCache snapshot, string method, object[] args, ulong time = 1000,
            UInt160[] signers = null, UInt160 target = null) =>
            UT_SmartAccount.Success(snapshot, method, args, time, signers, target: target, settings: V41);

        private static object[] Operation(DataCache snapshot, UInt160 id, UInt160 target, string method, object[] args,
            BigInteger? nonce = null, bool sign = true, BigInteger? validatorId = null) =>
            UT_SmartAccount.Operation(snapshot, id, target, method, args, nonce: nonce, sign: sign,
                validatorId: validatorId, prehashed: true, settings: V41);

        private static UInt160 Deploy(DataCache snapshot, string name)
        {
            string prefix = Path.Combine(AppContext.BaseDirectory, "StandardModules", name);
            var contract = (Array)Success(snapshot, "deploy",
                [File.ReadAllBytes(prefix + ".nef"), File.ReadAllBytes(prefix + ".manifest.json"),
                    NativeContract.SmartAccount.Hash], target: NativeContract.ContractManagement.Hash);
            return new UInt160(contract[2].GetSpan());
        }

        private static byte[] Profile(DataCache snapshot, UInt160 contract) =>
            SHA256.HashData(Success(snapshot, "getModuleProfile", [], target: contract).GetSpan());

        /// <summary>An install action: [1, type, contract, profileDigest, initData].</summary>
        private static object[] Install(DataCache snapshot, UInt160 contract, int type, params object[] initData) =>
            [1, type, contract, Profile(snapshot, contract), initData];

        /// <summary>Registers the account with an install-only initial group (v4.1 creation rule).</summary>
        private static UInt160 Register(DataCache snapshot, params object[][] installs)
        {
            UInt160 id = SmartAccountProtocol.GetAccountId(Custody, Salt);
            Success(snapshot, "createAccount", [id, Custody, Salt, installs]);
            return id;
        }

        /// <summary>Every instance id of one contract and type, ascending (ids are allocated in install order).</summary>
        private static BigInteger[] InstancesOf(DataCache snapshot, UInt160 id, string type, UInt160 contract)
        {
            var ids = (Array)((Array)Success(snapshot, "getModules", [id, type, 0, 32]))[0];
            return ids.Select(item => item.GetInteger())
                .Where(moduleId => new UInt160(((Array)Success(snapshot, "getModule", [id, moduleId]))[2].GetSpan()) == contract)
                .ToArray();
        }

        private static BigInteger InstanceOf(DataCache snapshot, UInt160 id, string type, UInt160 contract)
        {
            BigInteger[] found = InstancesOf(snapshot, id, type, contract);
            Assert.HasCount(1, found);
            return found[0];
        }

        /// <summary>The <c>getModule</c> descriptor of one instance.</summary>
        private static Array Descriptor(DataCache snapshot, UInt160 id, BigInteger moduleId) =>
            (Array)Success(snapshot, "getModule", [id, moduleId]);

        private static Array Account(DataCache snapshot, UInt160 id) => (Array)Success(snapshot, "getAccount", [id]);

        private static Array Pending(DataCache snapshot, UInt160 id, UInt160 governance) =>
            (Array)Success(snapshot, "getPendingConfigurationIntentIds", [id], target: governance);

        private static void Refused(ApplicationEngine engine, string symbol)
        {
            Assert.AreEqual(VMState.FAULT, engine.State);
            Assert.Contains(symbol, engine.FaultException!.ToString());
        }

        /// <summary>
        /// The read-only preview never faults for a rejected operation: it answers
        /// <c>[false, operationDigest]</c>. The rejection reason itself is only
        /// visible on the execution entry.
        /// </summary>
        private static void Rejected(ApplicationEngine engine)
        {
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            var preview = (Array)engine.ResultStack.Peek();
            Assert.HasCount(2, preview);
            Assert.IsFalse(preview[0].GetBoolean());
            Assert.HasCount(32, preview[1].GetSpan().ToArray());
        }

        /// <summary>Asserts that a method is not part of the closed 26-method v4.1 ABI.</summary>
        private static void RetiredEntry(ApplicationEngine engine)
        {
            Assert.AreEqual(VMState.FAULT, engine.State);
            Assert.Contains(Retired, engine.FaultException!.GetBaseException().Message);
        }

        private static ApplicationEngine Propose(DataCache snapshot, UInt160 id, UInt160 governance, object[] actions, ulong now) =>
            Invoke(snapshot, "proposeConfiguration", [id, actions, new object[0]], now, target: governance);

        private static ApplicationEngine Confirm(DataCache snapshot, UInt160 id, UInt160 governance,
            BigInteger intent, object[] actions, ulong time) =>
            Invoke(snapshot, "confirmConfiguration", [id, intent, actions], time, target: governance);

        /// <summary>Proposes at <paramref name="now"/> and confirms at maturity; the clock moves to the landing.</summary>
        private static void Land(DataCache snapshot, UInt160 id, UInt160 governance, object[] actions, ref ulong now)
        {
            using var proposed = Propose(snapshot, id, governance, actions, now);
            Assert.AreEqual(VMState.HALT, proposed.State, proposed.FaultException?.ToString());
            BigInteger intent = proposed.ResultStack.Peek().GetInteger();
            now += MaturityMs;
            using var landed = Confirm(snapshot, id, governance, intent, actions, now);
            Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
            landed.SnapshotCache.Commit();
        }

        private static void Cancel(DataCache snapshot, UInt160 id, UInt160 governance, BigInteger intent, ulong now) =>
            Success(snapshot, "cancelConfiguration", [id, intent], now, target: governance);

        private static bool Emitted(ApplicationEngine engine, UInt160 contract, string name) =>
            engine.Notifications.Any(n => n.ScriptHash == contract && n.EventName == name);

        // ---- action shapes ----

        /// <summary>One reviewed batch out of its action rows.</summary>
        private static object[] Actions(params object[][] rows) => rows;

        private static object[] Configure(BigInteger moduleId, params object[] data) => [3, moduleId, data];
        private static object[] Builtin(bool operation, bool message) => [5, operation, message];
        private static object[] RecoveryData(UInt160[] guardians, ulong timelock) =>
            [guardians.Cast<object>().ToArray(), BigInteger.One, (BigInteger)timelock];
        private static object[] RecoveryData(UInt160[] guardians, ulong timelock, UInt160 authority) =>
            [guardians.Cast<object>().ToArray(), BigInteger.One, (BigInteger)timelock, authority];
        private static object[] ThresholdData(BigInteger threshold, BigInteger[] members) =>
            [threshold, members.Cast<object>().ToArray(), members.Select(_ => (object)BigInteger.One).ToArray(), true];

        /// <summary>A planner order write: <c>[hookIds[]]</c> or <c>[hookIds[], expectedRevision]</c>.</summary>
        private static object[] HookOrder(BigInteger planner, object[] order) => Configure(planner, new object[] { order });

        private static object[] HookOrder(BigInteger planner, object[] order, long expectedRevision) =>
            Configure(planner, new object[] { order, (BigInteger)expectedRevision });

        private static byte[] MemberSignature(BigInteger member, byte[] operationDigest, Neo.Wallets.KeyPair key) =>
            SignPrehashed(key, SHA256.HashData([
                .. "NeoSmartAccount/ThresholdMember"u8, 4, .. operationDigest,
                .. UInt64Be(member), .. UInt64Be(1)]));

        private static byte[] UInt64Be(BigInteger value) =>
            SmartAccountModuleProtocol.UInt64ToBigEndian(SmartAccountProtocol.UInt64(value));

        /// <summary>The serialized member signature list: strictly ascending [memberId, signature] pairs.</summary>
        private static byte[] MemberEntries(params (BigInteger Member, byte[] Signature)[] rows)
        {
            var entries = new Array();
            foreach (var (member, signature) in rows)
                entries.Add(new Array([new Integer(member), new ByteString(signature)]));
            return BinarySerializer.Serialize(entries, 16384, 128);
        }

        private static Neo.Wallets.KeyPair Key(byte fill) => new(Enumerable.Repeat(fill, 32).ToArray());

        // ---- deployed test contracts ----

        /// <summary>
        /// A test-only validator contract whose only extra entry relays a call
        /// to another contract, so that contract sees an installed validator as
        /// its caller instead of the entry script.
        /// </summary>
        private static ContractState DeployRelay(DataCache snapshot, int id, string name, string profile)
        {
            using var script = new ScriptBuilder();
            System.Collections.Generic.List<ContractMethodDescriptor> methods = new();
            void Method(string methodName, ContractParameterType result, bool safe, Action<ScriptBuilder> body,
                params ContractParameterType[] parameters)
            {
                methods.Add(new ContractMethodDescriptor
                {
                    Name = methodName, ReturnType = result, Safe = safe, Offset = script.Length,
                    Parameters = parameters.Select((type, index) => new ContractParameterDefinition { Name = $"p{index}", Type = type }).ToArray(),
                });
                if (parameters.Length > 0) script.Emit(OpCode.INITSLOT, new byte[] { 0, (byte)parameters.Length });
                body(script);
                script.Emit(OpCode.RET);
            }
            Method("getModuleProfile", ContractParameterType.String, true, builder => builder.EmitPush(profile));
            foreach (string lifecycle in new[] { "onInstall", "onUninstall" })
                Method(lifecycle, ContractParameterType.Void, false, _ => { }, ContractParameterType.Hash160,
                    ContractParameterType.Integer, ContractParameterType.Integer, ContractParameterType.Array);
            Method("validateUserOp", ContractParameterType.Boolean, true, builder => builder.EmitPush(false),
                ContractParameterType.Hash160, ContractParameterType.ByteArray, ContractParameterType.Array);
            Method("onUserOpComplete", ContractParameterType.Void, false, _ => { }, ContractParameterType.Hash160,
                ContractParameterType.Array, ContractParameterType.Any);
            // relay(target, method, args): System.Contract.Call reads its parameters
            // hash, method, callFlags, args from the top of the stack down.
            Method("relay", ContractParameterType.Any, false, builder => builder
                .Emit(OpCode.LDARG2).EmitPush((int)CallFlags.All).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0)
                .EmitSysCall(ApplicationEngine.System_Contract_Call),
                ContractParameterType.Hash160, ContractParameterType.String, ContractParameterType.Array);
            ContractState contract = TestUtils.GetContract(script.ToArray());
            contract.Id = (ushort)id;
            contract.Manifest.Name = name;
            contract.Manifest.Abi.Methods = methods.ToArray();
            snapshot.AddContract(contract.Hash, contract);
            return contract;
        }

        /// <summary>Moves the deployed contract's update counter: the account's bound code identity drifts away and back.</summary>
        private static void MoveUpdateCounter(DataCache snapshot, UInt160 contract, int delta)
        {
            var key = new KeyBuilder(NativeContract.ContractManagement.Id, 8).Add(contract);
            snapshot.GetAndChange(key)!.GetInteroperable<ContractState>().UpdateCounter += (ushort)delta;
        }

        private static BigInteger[] Order(DataCache snapshot, UInt160 id, UInt160 orchestrator) =>
            ((Array)Success(snapshot, "getHookOrder", [id], target: orchestrator)).Select(h => h.GetInteger()).ToArray();

        private static Array HookSnapshot(DataCache snapshot, UInt160 id, UInt160 orchestrator) =>
            (Array)Success(snapshot, "getHookSnapshot", [id], target: orchestrator);

        /// <summary>Governance, two hooks and, last, the planner: ids ascending in the order installed.</summary>
        private static (UInt160 Id, UInt160 Governance, UInt160 Orchestrator, BigInteger Planner, BigInteger First, BigInteger Second) Orchestrated(
            DataCache snapshot)
        {
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), first = Deploy(snapshot, "WhitelistHook"),
                second = Deploy(snapshot, "DailyLimitHook"), orchestrator = Deploy(snapshot, "HookOrchestratorModule");
            UInt160 id = Register(snapshot,
            [
                Install(snapshot, governance, Validator), Install(snapshot, first, Hook),
                Install(snapshot, second, Hook), Install(snapshot, orchestrator, Validator),
            ]);
            return (id, governance, orchestrator, InstanceOf(snapshot, id, "validator", orchestrator),
                InstanceOf(snapshot, id, "hook", first), InstanceOf(snapshot, id, "hook", second));
        }

        /// <summary>Governance, the threshold adapter and <paramref name="members"/> fresh member validators.</summary>
        private static (UInt160 Id, UInt160 Governance, UInt160 Adapter, BigInteger AdapterId, BigInteger[] Members) ThresholdAccount(
            DataCache snapshot, int members)
        {
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), adapter = Deploy(snapshot, "ThresholdPolicyModule"),
                member = Deploy(snapshot, "MultiSigValidator");
            var group = new System.Collections.Generic.List<object[]> { Install(snapshot, governance, Validator), Install(snapshot, adapter, Validator) };
            for (int i = 0; i < members; i++)
                group.Add(Install(snapshot, member, Validator, "setMemberKey", Key((byte)(i + 1)).PublicKey.EncodePoint(true)));
            UInt160 id = Register(snapshot, group.ToArray());
            return (id, governance, adapter, InstanceOf(snapshot, id, "validator", adapter), InstancesOf(snapshot, id, "validator", member));
        }

        // ------------------------------------------------------------------
        // Hook order: module state behind a reviewed configure
        // ------------------------------------------------------------------

        [TestMethod]
        public void HookOrderNeedsAnInstalledPlannerAndChangesOnlyThroughAReviewedConfigure()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), first = Deploy(snapshot, "WhitelistHook"),
                second = Deploy(snapshot, "DailyLimitHook"), orchestrator = Deploy(snapshot, "HookOrchestratorModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, first, Hook), Install(snapshot, second, Hook)]);
            BigInteger governanceId = InstanceOf(snapshot, id, "validator", governance), h1 = InstanceOf(snapshot, id, "hook", first),
                h2 = InstanceOf(snapshot, id, "hook", second);
            Assert.IsEmpty((Array)Success(snapshot, "getHookOrder", [id], target: orchestrator), "a deployed contract is not an instance");
            Assert.IsEmpty(HookSnapshot(snapshot, id, orchestrator));
            using (var direct = Invoke(snapshot, "setHookOrder", [id, 0, new object[] { h2, h1 }, 0], target: orchestrator))
                Refused(direct, "SA_UNAUTHORIZED");

            // The former governance action 4 has no landing target anymore.
            using (var retired = Propose(snapshot, id, governance, [new object[] { 4, new object[] { h2, h1 } }], 1000))
                Refused(retired, "SA_OPERATION_MALFORMED");
            Assert.IsEmpty(Pending(snapshot, id, governance));

            ulong now = 1000;
            // A hook instance owns no order: the configure reaches the whitelist,
            // which cannot read the shape and refuses it.
            object[] misplaced = [Configure(h1, new object[] { h2, h1 })];
            BigInteger intent = Success(snapshot, "proposeConfiguration", [id, misplaced, new object[0]], now, target: governance).GetInteger();
            using (var refused = Confirm(snapshot, id, governance, intent, misplaced, now + MaturityMs))
                Assert.AreEqual(VMState.FAULT, refused.State, "the whitelist hook has no order semantics");
            Assert.HasCount(1, Pending(snapshot, id, governance), "the refused landing leaves the intent pending");
            Cancel(snapshot, id, governance, intent, now + MaturityMs);
            now += MaturityMs;

            // Not an instance of this account.
            object[] absent = [Configure(h2 + 100, new object[] { new object[] { h2, h1 } })];
            intent = Success(snapshot, "proposeConfiguration", [id, absent, new object[0]], now, target: governance).GetInteger();
            using (var notInstalled = Confirm(snapshot, id, governance, intent, absent, now + MaturityMs))
                Refused(notInstalled, "SA_MODULE_NOT_INSTALLED");
            Cancel(snapshot, id, governance, intent, now + MaturityMs);
            now += MaturityMs;

            // The governance seat has no configure callback to receive it.
            object[] wrongTarget = [Configure(governanceId, new object[] { new object[] { h2, h1 } })];
            intent = Success(snapshot, "proposeConfiguration", [id, wrongTarget, new object[0]], now, target: governance).GetInteger();
            using (var unbindable = Confirm(snapshot, id, governance, intent, wrongTarget, now + MaturityMs))
                Refused(unbindable, "SA_MODULE_CODE_BINDING_MISMATCH");
            Cancel(snapshot, id, governance, intent, now + MaturityMs);
            now += MaturityMs;
            Assert.IsEmpty(HookSnapshot(snapshot, id, orchestrator), "nothing above wrote an order");

            // Installing the planner is itself a reviewed action; it seeds the
            // installed hook set.
            Land(snapshot, id, governance, [Install(snapshot, orchestrator, Validator)], ref now);
            BigInteger planner = InstanceOf(snapshot, id, "validator", orchestrator);
            Assert.IsGreaterThan(h2, planner, "the planner is the newest instance");
            Assert.AreSequenceEqual(new[] { h1, h2 }, Order(snapshot, id, orchestrator));
            var seeded = HookSnapshot(snapshot, id, orchestrator);
            Assert.HasCount(5, seeded);
            Assert.AreEqual(planner, seeded[0].GetInteger());
            Assert.AreEqual(BigInteger.One, seeded[1].GetInteger());
            Assert.HasCount(32, seeded[2].GetSpan().ToArray());
            Assert.AreSequenceEqual(new[] { h1, h2 }, ((Array)seeded[3]).Select(x => x.GetInteger()));
            Assert.AreSequenceEqual(new[] { h1, h2 }, ((Array)seeded[4]).Select(x => x.GetInteger()));
            Assert.IsTrue(((Array)Descriptor(snapshot, id, planner))[14].GetBoolean(), "the planner seat is the profile flag");

            // The order changes through a configure of the planner instance,
            // reviewed like every other module change.
            object[] change = [Configure(planner, new object[] { h2, h1 }, 1)];
            intent = Success(snapshot, "proposeConfiguration", [id, change, new object[0]], now, target: governance).GetInteger();
            BigInteger nonce = Account(snapshot, id)[4].GetInteger();
            using (var early = Confirm(snapshot, id, governance, intent, change, now + MaturityMs - 1))
                Refused(early, "SA_INTENT_IMMATURE");
            Assert.AreSequenceEqual(new[] { h1, h2 }, Order(snapshot, id, orchestrator));
            using (var landed = Confirm(snapshot, id, governance, intent, change, now + MaturityMs))
            {
                Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
                var updated = landed.Notifications.Single(n => n.EventName == HookOrderUpdated);
                Assert.AreEqual(orchestrator, updated.ScriptHash);
                Assert.AreEqual(id, new UInt160(updated.State[0].GetSpan()));
                Assert.AreEqual(planner, updated.State[1].GetInteger());
                Assert.AreEqual((BigInteger)2, updated.State[2].GetInteger(), "two hooks in the new order");
                Assert.AreEqual((BigInteger)2, updated.State[3].GetInteger(), "the second revision");
                landed.SnapshotCache.Commit();
            }
            now += MaturityMs;
            Assert.AreSequenceEqual(new[] { h2, h1 }, Order(snapshot, id, orchestrator));
            var revised = HookSnapshot(snapshot, id, orchestrator);
            Assert.AreEqual((BigInteger)2, revised[1].GetInteger());
            Assert.AreSequenceEqual(new[] { h2, h1 }, ((Array)revised[3]).Select(x => x.GetInteger()));
            Assert.AreSequenceEqual(new[] { h1, h2 }, ((Array)revised[4]).Select(x => x.GetInteger()), "the installed set is unchanged");
            Assert.AreEqual(nonce + 1, Account(snapshot, id)[4].GetInteger());
            Assert.IsEmpty(Pending(snapshot, id, governance));
            using var replay = Confirm(snapshot, id, governance, intent, change, now);
            Refused(replay, "SA_INTENT_NOT_FOUND");
        }

        [TestMethod]
        public void AValidatorWithTheOrchestratorGrammarButWithoutThePlannerFlagIsNotThePlanner()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), hookContract = Deploy(snapshot, "WhitelistHook"),
                orchestrator = Deploy(snapshot, "HookOrchestratorModule");
            ContractState lookalike = DeployRelay(snapshot, 951, "HookOrchestratorLookalike", LookalikeProfile);
            UInt160 id = Register(snapshot,
            [
                Install(snapshot, governance, Validator), Install(snapshot, hookContract, Hook),
                Install(snapshot, lookalike.Hash, Validator),
            ]);
            BigInteger hook = InstanceOf(snapshot, id, "hook", hookContract), lookalikeId = InstanceOf(snapshot, id, "validator", lookalike.Hash);
            Assert.AreEqual(LookalikeProfile, Success(snapshot, "getModuleProfile", [], target: lookalike.Hash).GetString());

            // Same module type and isolation as the orchestrator, but the
            // planner seat is a profile flag the lookalike does not carry.
            var descriptor = Descriptor(snapshot, id, lookalikeId);
            Assert.HasCount(15, descriptor);
            Assert.AreEqual((BigInteger)Validator, descriptor[1].GetInteger());
            Assert.IsTrue(descriptor[9].GetBoolean(), "instanceIsolation");
            Assert.IsFalse(descriptor[13].GetBoolean(), "governance");
            Assert.IsFalse(descriptor[14].GetBoolean(), "hookPlanner");
            Assert.IsTrue(((Array)Descriptor(snapshot, id, InstanceOf(snapshot, id, "validator", governance)))[13].GetBoolean(),
                "the governance seat is the profile flag too");
            Assert.IsEmpty((Array)Success(snapshot, "getHookOrder", [id], target: orchestrator), "the lookalike holds no planner seat");
            Assert.IsEmpty(HookSnapshot(snapshot, id, orchestrator));

            // Its configure has no landing target: the relay has no configure callback.
            ulong now = 1000;
            object[] actions = [Configure(lookalikeId, new object[] { new object[] { hook } })];
            BigInteger intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], now, target: governance).GetInteger();
            using var refused = Confirm(snapshot, id, governance, intent, actions, now + MaturityMs);
            Refused(refused, "SA_MODULE_CODE_BINDING_MISMATCH");
            Assert.HasCount(1, Pending(snapshot, id, governance));
            Cancel(snapshot, id, governance, intent, now + MaturityMs);
            now += MaturityMs;

            // The real planner lands beside it and owns the snapshot.
            Land(snapshot, id, governance, [Install(snapshot, orchestrator, Validator)], ref now);
            BigInteger planner = InstanceOf(snapshot, id, "validator", orchestrator);
            Assert.AreNotEqual(lookalikeId, planner);
            Assert.AreEqual(planner, HookSnapshot(snapshot, id, orchestrator)[0].GetInteger());
            Assert.AreSequenceEqual(new[] { hook }, Order(snapshot, id, orchestrator));
        }

        [TestMethod]
        public void AnOrderChangeIsCheckedAgainstTheInstalledHooksWhenItLands()
        {
            var snapshot = Snapshot();
            var (id, governance, orchestrator, planner, first, second) = Orchestrated(snapshot);
            Assert.IsGreaterThan(first, second, "instance ids ascend in install order");
            Assert.AreEqual(planner, HookSnapshot(snapshot, id, orchestrator)[0].GetInteger());
            ulong now = 1000;

            // A refused landing is atomic: no order, no revision, no nonce and
            // the intent stays pending for its custody to cancel.
            void RefusedAtLanding(object[] actions, string symbol)
            {
                BigInteger nonce = Account(snapshot, id)[4].GetInteger();
                BigInteger intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], now, target: governance).GetInteger();
                using var refused = Confirm(snapshot, id, governance, intent, actions, now + MaturityMs);
                Refused(refused, symbol);
                Assert.IsFalse(Emitted(refused, orchestrator, HookOrderUpdated));
                Assert.AreEqual(nonce, Account(snapshot, id)[4].GetInteger(), "the refused landing changes nothing");
                Assert.AreSequenceEqual(new[] { first, second }, Order(snapshot, id, orchestrator));
                Assert.AreEqual(BigInteger.One, HookSnapshot(snapshot, id, orchestrator)[1].GetInteger());
                Assert.HasCount(1, Pending(snapshot, id, governance), "the fault rolls the intent back into the pending table");
                Cancel(snapshot, id, governance, intent, now + MaturityMs);
                now += MaturityMs;
            }

            // Ascending, but not the installed set: unknown id.
            RefusedAtLanding([HookOrder(planner, new object[] { first, second + 1 })], "SA_PROOF_INVALID");
            // A different length is not the installed set.
            RefusedAtLanding([HookOrder(planner, new object[] { first })], "SA_PROOF_INVALID");
            // A repeated id is malformed, not merely unknown.
            RefusedAtLanding([HookOrder(planner, new object[] { first, first })], "SA_OPERATION_MALFORMED");
            // The echo of a revision that is not the current one is a stale observation.
            RefusedAtLanding([Configure(planner, new object[] { second, first }, 2)], "SA_PROOF_INVALID stale hook snapshot");
            RefusedAtLanding([Configure(planner, new object[] { second, first }, 0)], "SA_PROOF_INVALID stale hook snapshot");
            // Non-integer entries are malformed.
            RefusedAtLanding([HookOrder(planner, new object[] { "first", "second" })], "SA_OPERATION_MALFORMED");
            // More than eight hooks cannot be an order at all.
            object[] nine = new object[] { first, second }.Concat(Enumerable.Range(3, 7).Select(x => (BigInteger)x).Cast<object>()).ToArray();
            RefusedAtLanding([HookOrder(planner, nine)], "SA_OPERATION_MALFORMED");

            // While one order intent is pending, a second one reads the same
            // instance slot and conflicts at proposal time.
            BigInteger pending = Success(snapshot, "proposeConfiguration",
                [id, new object[] { HookOrder(planner, new object[] { second, first }) }, new object[0]], now, target: governance).GetInteger();
            using (var crowded = Propose(snapshot, id, governance, [HookOrder(planner, new object[] { first, second })], now))
                Refused(crowded, "SA_INTENT_CONFLICT");
            Assert.HasCount(1, Pending(snapshot, id, governance));
            Cancel(snapshot, id, governance, pending, now);

            // The descending order lands once it is the exact installed set.
            object[] descending = [Configure(planner, new object[] { second, first }, 1)];
            Land(snapshot, id, governance, descending, ref now);
            Assert.AreSequenceEqual(new[] { second, first }, Order(snapshot, id, orchestrator));
            var revised = HookSnapshot(snapshot, id, orchestrator);
            Assert.AreEqual((BigInteger)2, revised[1].GetInteger());
            Assert.AreSequenceEqual(new[] { second, first }, ((Array)revised[3]).Select(x => x.GetInteger()));
            Assert.AreSequenceEqual(new[] { first, second }, ((Array)revised[4]).Select(x => x.GetInteger()));
        }

        [TestMethod]
        public void DirectOrderWritesAreClosedToEveryoneOutsideTheConfigurationFrame()
        {
            var snapshot = Snapshot();
            var (id, _, orchestrator, planner, first, second) = Orchestrated(snapshot);
            using (var custody = Invoke(snapshot, "setHookOrder", [id, planner, new object[] { second, first }, 1], target: orchestrator))
                Refused(custody, "SA_UNAUTHORIZED");
            using (var stranger = Invoke(snapshot, "setHookOrder", [id, planner, new object[] { second, first }, 1], signers: [Stranger], target: orchestrator))
                Refused(stranger, "SA_UNAUTHORIZED");
            using (var nativeCustody = Invoke(snapshot, "configureModule", [id, planner, new object[] { new object[] { second, first }, 1 }]))
                Refused(nativeCustody, "SA_UNAUTHORIZED");
            using (var nativeStranger = Invoke(snapshot, "configureModule", [id, planner, new object[] { new object[] { second, first }, 1 }], signers: [Stranger]))
                Refused(nativeStranger, "SA_UNAUTHORIZED");
            using (var nativeOther = Invoke(snapshot, "configureModule", [id, first, new object[] { "allowTarget", NativeContract.GAS.Hash }]))
                Refused(nativeOther, "SA_UNAUTHORIZED");
            Assert.AreSequenceEqual(new[] { first, second }, Order(snapshot, id, orchestrator));
            Assert.AreEqual(BigInteger.One, HookSnapshot(snapshot, id, orchestrator)[1].GetInteger());
        }

        // ------------------------------------------------------------------
        // Recovery policy: a module configure, the native entry is retired
        // ------------------------------------------------------------------

        [TestMethod]
        public void RecoveryPolicyIsAModuleConfigureAndTheNativeEntryIsRetired()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            using (var retired = Invoke(snapshot, "setRecoveryPolicy", [id, Guardian, new BigInteger(Timelock), false])) RetiredEntry(retired);
            using (var retiredAction = Propose(snapshot, id, governance, [new object[] { 8, Guardian, new BigInteger(Timelock), false }], 1000))
                Refused(retiredAction, "SA_OPERATION_MALFORMED");
            using (var reservedBit = Propose(snapshot, id, governance, [new object[] { 8, Guardian, new BigInteger(Timelock), true }], 1000))
                Refused(reservedBit, "SA_OPERATION_MALFORMED");
            Assert.IsEmpty(Pending(snapshot, id, governance));
            Assert.IsEmpty((Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat));

            ulong now = 1000;
            foreach (var (data, symbol) in new[]
            {
                (new object[] { new object[] { Guardian }, BigInteger.One }, "SA_OPERATION_MALFORMED"),
                (new object[] { new object[0], BigInteger.One, (BigInteger)Timelock }, "SA_MODULE_LIMIT_MEMBERS"),
                (new object[] { new object[] { Guardian }, (BigInteger)2, (BigInteger)Timelock }, "SA_MODULE_LIMIT_THRESHOLD"),
                (new object[] { new object[] { Guardian }, BigInteger.One, (BigInteger)(Timelock - 1) }, "SA_OPERATION_MALFORMED"),
                (new object[] { new object[] { Guardian }, BigInteger.One, (BigInteger)Timelock, "not an address" }, "SA_OPERATION_MALFORMED"),
                (new object[] { new object[] { UInt160.Zero }, BigInteger.One, (BigInteger)Timelock }, "SA_OPERATION_MALFORMED"),
                (new object[] { new object[] { Guardian, Guardian }, BigInteger.One, (BigInteger)Timelock }, "SA_OPERATION_MALFORMED"),
            })
            {
                object[] actions = [Configure(seatId, data)];
                BigInteger intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], now, target: governance).GetInteger();
                using var refused = Confirm(snapshot, id, governance, intent, actions, now + MaturityMs);
                Refused(refused, symbol);
                Assert.IsEmpty((Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat), "nothing landed");
                Assert.HasCount(1, Pending(snapshot, id, governance));
                Cancel(snapshot, id, governance, intent, now + MaturityMs);
                now += MaturityMs;
            }

            // The 3-element form lands with no authority; the 4-element form adds one.
            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], Timelock))], ref now);
            var policy = (Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat);
            Assert.HasCount(6, policy);
            Assert.AreEqual(Guardian, new UInt160(((Array)policy[0])[0].GetSpan()));
            Assert.AreEqual(BigInteger.One, policy[1].GetInteger());
            Assert.AreEqual((BigInteger)Timelock, policy[2].GetInteger());
            Assert.IsTrue(policy[3].GetSpan().ToArray().All(x => x == 0), "no authority");
            Assert.AreEqual(BigInteger.One, policy[4].GetInteger());
            Assert.HasCount(32, policy[5].GetSpan().ToArray());

            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], Timelock, Incoming))], ref now);
            policy = (Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat);
            Assert.AreEqual(Incoming, new UInt160(policy[3].GetSpan()));
            Assert.AreEqual((BigInteger)2, policy[4].GetInteger());
            Assert.AreEqual(BigInteger.Zero, Account(snapshot, id)[7].GetInteger(), "the core record carries no recovery field");
        }

        // ------------------------------------------------------------------
        // Administration gates
        // ------------------------------------------------------------------

        [TestMethod]
        public void APinnedRequiredValidatorRoutesOperationsAndNeverDisplacesTheCustodyProposal()
        {
            var snapshot = Snapshot();
            var (id, governance, adapter, adapterId, members) = ThresholdAccount(snapshot, 2);
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(adapterId, ThresholdData(2, members))], ref now);
            Land(snapshot, id, governance, Actions([7, adapterId, true]), ref now);
            Assert.AreEqual(adapterId, Account(snapshot, id)[7].GetInteger());
            BigInteger m = members[0], n = members[1];

            // The pin routes operations; it does not touch who may propose.
            object[] policy = [Builtin(true, false)];
            BigInteger intent = Success(snapshot, "proposeConfiguration", [id, policy, new object[0]], now, target: governance).GetInteger();
            using (var landed = Confirm(snapshot, id, governance, intent, policy, now + MaturityMs))
            {
                Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
                landed.SnapshotCache.Commit();
            }
            now += MaturityMs;
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean(), "operation authorization is on");
            Assert.IsFalse(Account(snapshot, id)[6].GetBoolean(), "message authorization is untouched");

            // The pin routes every operation to the adapter: a custody-signed
            // operation names no route. The preview only declines; the execution
            // entry names the reason.
            var custodyOp = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", []);
            using (var closed = Invoke(snapshot, "validateUserOp", [id, custodyOp], now)) Rejected(closed);
            using (var unexecutable = Invoke(snapshot, "executeUserOp", [id, custodyOp], now)) Refused(unexecutable, "SA_MODULE_NOT_ROUTABLE");

            // The adapter's channel, not the custody one the helper defaults to.
            BigInteger nonce = Success(snapshot, "getNonce", [id, adapterId, new byte[32]]).GetInteger();
            var operation = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: nonce, sign: false, validatorId: adapterId);
            byte[] digest = Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray();
            operation[11] = MemberEntries((m, MemberSignature(m, digest, Key(1))), (n, MemberSignature(n, digest, Key(2))));
            Assert.AreEqual("GAS", Success(snapshot, "executeUserOp", [id, operation], now).GetString());
            Assert.AreEqual(nonce + 1, Success(snapshot, "getNonce", [id, adapterId, new byte[32]]).GetInteger());
        }

        [TestMethod]
        public void APlainValidatorInstanceIsNotAnAdministrationWitness()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule");
            ContractState relay = DeployRelay(snapshot, 950, "RelayValidator", RelayProfile.Replace("{0}", "RelayValidator"));
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, relay.Hash, Validator)]);
            BigInteger relayId = InstanceOf(snapshot, id, "validator", relay.Hash);
            var descriptor = Descriptor(snapshot, id, relayId);
            Assert.IsTrue(descriptor[9].GetBoolean(), "isolated like the governance seat");
            Assert.IsFalse(descriptor[13].GetBoolean(), "but no governance flag");

            object[] actions = [Builtin(true, true)];
            // Installed and code-bound, the relay still lends nobody the custody witness.
            using (var viaRelay = Invoke(snapshot, "relay", [governance, "proposeConfiguration", new object[] { id, actions, new object[0] }],
                1000, signers: [Stranger], target: relay.Hash))
                Refused(viaRelay, "SA_UNAUTHORIZED");
            Assert.IsEmpty(Pending(snapshot, id, governance));

            BigInteger intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], 1000, target: governance).GetInteger();
            using (var confirmViaRelay = Invoke(snapshot, "relay", [governance, "confirmConfiguration", new object[] { id, intent, actions }],
                1000 + MaturityMs, signers: [Stranger], target: relay.Hash))
                Refused(confirmViaRelay, "SA_UNAUTHORIZED");
            Assert.HasCount(1, Pending(snapshot, id, governance));
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean(), "nothing landed");

            // An out-of-band credential revocation advances the configuration
            // nonce the intent pinned: custody itself can no longer land it.
            Success(snapshot, "revokeModuleCredentials", [id, relayId], 1000);
            Assert.AreEqual((BigInteger)2, ((Array)Success(snapshot, "getModule", [id, relayId]))[8].GetInteger());
            using (var stale = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs))
                Refused(stale, "SA_CONFIGURATION_NONCE_STALE");
            Assert.HasCount(1, Pending(snapshot, id, governance));
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean(), "nothing landed");

            // A fresh intent under the new nonce is custody's decision again; the
            // stale one has to make room first because it owns the same resource.
            ulong now = 1000 + MaturityMs;
            Cancel(snapshot, id, governance, intent, now);
            Land(snapshot, id, governance, actions, ref now);
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean());
            Assert.IsTrue(Account(snapshot, id)[6].GetBoolean());
            Assert.IsEmpty(Pending(snapshot, id, governance));
        }

        [TestMethod]
        public void GovernanceCodeDriftRefusesBothWitnessesUntilTheCodeIdentityIsRestored()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
            object[] actions = [Builtin(false, true)];
            BigInteger intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], 1000, target: governance).GetInteger();

            // The governance contract is the validator whose code binding the
            // account pinned: an updated deployment is a different identity.
            MoveUpdateCounter(snapshot, governance, 1);
            using (var proposal = Propose(snapshot, id, governance, [Builtin(true, false)], 1001))
                Refused(proposal, "SA_MODULE_CODE_BINDING_MISMATCH");
            using (var confirmation = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs))
                Refused(confirmation, "SA_MODULE_CODE_BINDING_MISMATCH");
            Assert.HasCount(1, Pending(snapshot, id, governance));
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean(), "nothing landed");

            // Back to the pinned identity: the same intent lands for custody.
            MoveUpdateCounter(snapshot, governance, -1);
            using var landed = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs);
            Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
            landed.SnapshotCache.Commit();
            Assert.IsFalse(Account(snapshot, id)[5].GetBoolean());
            Assert.IsEmpty(Pending(snapshot, id, governance));
        }

        [TestMethod]
        public void AFrozenAccountReviewsOnlyTheUnfreezeIntentAndTheLandingRetiresWhatCameBefore()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
            object[] policy = [Builtin(true, false)], unfreeze = [new object[] { 11 }];
            BigInteger earlier = Success(snapshot, "proposeConfiguration", [id, policy, new object[0]], 1000, target: governance).GetInteger();
            Success(snapshot, "freezeAccount", [id], 1000);
            Array frozen = Account(snapshot, id);
            Assert.AreEqual((BigInteger)(int)SmartAccountStatus.Frozen, frozen[1].GetInteger());

            // Every configure proposal is refused while frozen, whoever signs.
            using (var configure = Propose(snapshot, id, governance, policy, 1001)) Refused(configure, "SA_ACCOUNT_FROZEN");
            using (var earlierStill = Confirm(snapshot, id, governance, earlier, policy, 1000 + MaturityMs))
                Refused(earlierStill, "SA_ACCOUNT_FROZEN");
            using (var mixed = Propose(snapshot, id, governance, Actions([11], Builtin(true, false)), 1001))
                Refused(mixed, "SA_OPERATION_MALFORMED");
            using (var doubled = Propose(snapshot, id, governance, Actions([11], [11]), 1001))
                Refused(doubled, "SA_OPERATION_MALFORMED");
            Assert.HasCount(1, Pending(snapshot, id, governance));
            Assert.AreEqual("configure", ((Array)Success(snapshot, "getPendingConfiguration", [id, earlier], target: governance))[1].GetString());

            // The single-action unfreeze intent is the one proposal a frozen account takes.
            BigInteger intent = Success(snapshot, "proposeConfiguration", [id, unfreeze, new object[0]], 1000 + MaturityMs, target: governance).GetInteger();
            Assert.AreEqual("unfreeze", ((Array)Success(snapshot, "getPendingConfiguration", [id, intent], target: governance))[1].GetString());
            using (var early = Confirm(snapshot, id, governance, intent, unfreeze, 1000 + 2 * MaturityMs - 1))
                Refused(early, "SA_INTENT_IMMATURE");
            using (var landed = Confirm(snapshot, id, governance, intent, unfreeze, 1000 + 2 * MaturityMs))
            {
                Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
                Assert.IsTrue(Emitted(landed, governance, "ConfigurationConfirmed"));
                landed.SnapshotCache.Commit();
            }
            Array thawed = Account(snapshot, id);
            Assert.AreEqual((BigInteger)(int)SmartAccountStatus.Active, thawed[1].GetInteger());
            Assert.AreEqual(frozen[3].GetInteger() + 1, thawed[3].GetInteger(), "unfreezing is an authority change");
            Assert.AreEqual(frozen[4].GetInteger() + 1, thawed[4].GetInteger());
            Assert.IsEmpty(Pending(snapshot, id, governance));
            using var stale = Confirm(snapshot, id, governance, earlier, policy, 1000 + 2 * MaturityMs);
            Refused(stale, "SA_INTENT_NOT_FOUND");

            // Configure proposals are accepted again.
            ulong now = 1000 + 2 * MaturityMs;
            Land(snapshot, id, governance, policy, ref now);
            Assert.IsFalse(Account(snapshot, id)[6].GetBoolean());
        }
    }
}
