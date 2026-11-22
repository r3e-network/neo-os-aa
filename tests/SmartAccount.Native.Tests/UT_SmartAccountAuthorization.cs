// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccountAuthorization.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

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
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using Array = Neo.VM.Types.Array;
using ByteString = Neo.VM.Types.ByteString;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// Authority of the administration family of the minimal core (spec
    /// §7.1/§8): <c>installModule</c>/<c>removeModule</c>, the simplified
    /// <c>unfreezeAccount</c> and the restricted landing writes
    /// <c>setRecoveryPolicy</c>/<c>setBuiltinAuthorization</c>/
    /// <c>revokeModuleCredentials</c> accept the custody witness OR the
    /// witness of an already installed validator instance, and nothing else;
    /// <c>resetAccount</c> accepts only the account's recovery seat (R-12-12).
    /// </summary>
    [TestClass]
    public class UT_SmartAccountAuthorization
    {
        private static readonly UInt160 ForeignCustody = UInt160.Parse("0x0404040404040404040404040404040404040404");

        private static byte[] ProfileBytes(string name, bool isolation, bool hook) =>
            ProfileBytes(name, isolation, hook ? "hook" : "validator");

        private static byte[] ProfileBytes(string name, bool isolation, string moduleType) =>
            Encoding.UTF8.GetBytes(
                $"{{\"profileVersion\":{SmartAccountModuleProtocol.ModuleProfileVersion}," +
                $"\"moduleType\":\"{moduleType}\",\"contractName\":\"{name}\"," +
                $"\"capabilities\":{{\"instanceIsolation\":{isolation.ToString().ToLowerInvariant()}}}}}");

        /// <summary>
        /// A deployed module: the profile and lifecycle callbacks every instance
        /// kind must expose, the two routing callbacks when it is a validator,
        /// and a governance surface that re-enters the core so the module's own
        /// contract witness is the only authority those calls present.
        /// </summary>
        private static ContractState DeployModule(DataCache snapshot, int number, bool isolation = true,
            bool hook = false, bool brokenReply = false, bool recovery = false, bool poisonAfterReset = false)
        {
            string name = $"Module{number}";
            byte[] profile = ProfileBytes(name, isolation, recovery ? "recovery" : hook ? "hook" : "validator");

            using var script = new ScriptBuilder();
            List<ContractMethodDescriptor> methods = new();
            void Method(string methodName, ContractParameterType result, bool safe,
                Action<ScriptBuilder> body, params ContractParameterType[] parameters)
            {
                methods.Add(new ContractMethodDescriptor
                {
                    Name = methodName,
                    ReturnType = result,
                    Safe = safe,
                    Offset = script.Length,
                    Parameters = parameters.Select((type, index) => new ContractParameterDefinition
                    {
                        Name = $"p{index}",
                        Type = type,
                    }).ToArray(),
                });
                if (parameters.Length != 0)
                    script.Emit(OpCode.INITSLOT, new byte[] { 0, (byte)parameters.Length });
                body(script);
                script.Emit(OpCode.RET);
            }
            static void CoreCall(ScriptBuilder builder, string method, int count)
            {
                builder.EmitPush(count).Emit(OpCode.PACK)
                    .EmitPush((int)CallFlags.All).EmitPush(method)
                    .EmitPush(NativeContract.SmartAccount.Hash)
                    .EmitSysCall(ApplicationEngine.System_Contract_Call);
            }
            // A void core method still answers with the call result on the stack,
            // so the forwarding method has to consume it before returning nothing.
            static void CoreCallVoid(ScriptBuilder builder, string method, int count)
            {
                CoreCall(builder, method, count);
                builder.Emit(OpCode.DROP);
            }

            Method("getModuleProfile", ContractParameterType.String, true, builder => builder.EmitPush(profile));
            foreach (string lifecycle in new[] { "onInstall", "onUninstall" })
                Method(lifecycle, ContractParameterType.Void, false, _ => { },
                    ContractParameterType.Hash160, ContractParameterType.Integer,
                    ContractParameterType.Integer, ContractParameterType.Array);
            if (!hook && !recovery)
            {
                // The routing callbacks belong to validators only; a hook — and
                // likewise a recovery seat (§7.1/§12.5) — must install without
                // them (spec §7.1 table 10). A broken validator
                // answers the validation callback outside the Boolean domain:
                // its manifest still declares Boolean, so admission passes and
                // only the runtime reply exposes the defect.
                Action<ScriptBuilder> reply = brokenReply
                    ? builder => builder.EmitPush(5)
                    : builder => builder.EmitPush(true);
                Method("validateUserOp", ContractParameterType.Boolean, true, reply,
                    ContractParameterType.Hash160, ContractParameterType.ByteArray, ContractParameterType.Array);
                Method("onUserOpComplete", ContractParameterType.Void, false, _ => { },
                    ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Any);
            }
            // PACK takes the top of the stack as element 0, so the arguments are
            // pushed in reverse to rebuild the positional call array.
            Method("admin", ContractParameterType.Integer, false, builder =>
            {
                builder.Emit(OpCode.LDARG3).Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCall(builder, "installModule", 4);
            }, ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Hash160, ContractParameterType.Array);
            Method("adminRemove", ContractParameterType.Void, false, builder =>
            {
                builder.Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(builder, "removeModule", 3);
            }, ContractParameterType.Hash160, ContractParameterType.Integer, ContractParameterType.Array);
            Method("adminThaw", ContractParameterType.Void, false, builder =>
            {
                builder.Emit(OpCode.LDARG0);
                CoreCallVoid(builder, "unfreezeAccount", 1);
            }, ContractParameterType.Hash160);
            Method("adminRecoveryPolicy", ContractParameterType.Void, false, builder =>
            {
                builder.Emit(OpCode.LDARG3).Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(builder, "setRecoveryPolicy", 4);
            }, ContractParameterType.Hash160, ContractParameterType.Hash160,
                ContractParameterType.Integer, ContractParameterType.Boolean);
            Method("adminBuiltinAuthorization", ContractParameterType.Void, false, builder =>
            {
                builder.Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(builder, "setBuiltinAuthorization", 3);
            }, ContractParameterType.Hash160, ContractParameterType.Boolean,
                ContractParameterType.Boolean);
            Method("adminRevoke", ContractParameterType.Void, false, builder =>
            {
                builder.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(builder, "revokeModuleCredentials", 2);
            }, ContractParameterType.Hash160, ContractParameterType.Integer);
            Method("adminReset", ContractParameterType.Void, false, builder =>
            {
                builder.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(builder, "resetAccount", 2);
                // The deliberate post-reset fault the atomicity test needs: the
                // reset itself completes, and the fault right after it must
                // revert the whole rotation with the faulting script.
                if (poisonAfterReset) builder.EmitPush(false).Emit(OpCode.ASSERT);
            }, ContractParameterType.Hash160, ContractParameterType.Hash160);

            ContractState contract = TestUtils.GetContract(script.ToArray());
            contract.Id = number;
            contract.Manifest.Name = name;
            contract.Manifest.Abi.Methods = methods.ToArray();
            snapshot.AddContract(contract.Hash, contract);
            return contract;
        }

        private static Array Descriptor(DataCache snapshot, UInt160 id, BigInteger moduleId) =>
            (Array)UT_SmartAccount.Success(snapshot, "getModule", [id, moduleId]);

        private static Array Control(DataCache snapshot, UInt160 id) =>
            (Array)UT_SmartAccount.Success(snapshot, "getAccount", [id]);

        /// <summary>
        /// Simulates the deployed module being updated: the deployment slot
        /// keeps its address and id, but the update counter drifts past the
        /// code binding the instance record captured at install (spec §3.6).
        /// </summary>
        private static void UpdateDeployedContract(DataCache snapshot, ContractState contract)
        {
            var key = new KeyBuilder(NativeContract.ContractManagement.Id, 8).Add(contract.Hash);
            snapshot.GetAndChange(key)!.GetInteroperable<ContractState>().UpdateCounter++;
        }

        [TestMethod]
        public void InstallModuleIsCustodyGatedAndHandsValidationToTheInstance()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            ContractState module = DeployModule(snapshot, 900);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;

            using (var foreign = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, validatorType, module.Hash, new object[0]], signers: [ForeignCustody]))
                Assert.AreEqual(VMState.FAULT, foreign.State, "Only the custody witness may install a module.");

            BigInteger moduleId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, validatorType, module.Hash, new object[0]], signers: [UT_SmartAccount.Custody]).GetInteger();
            Assert.AreEqual(BigInteger.One, moduleId);

            Array descriptor = Descriptor(snapshot, id, moduleId);
            Assert.HasCount(12, descriptor);
            Assert.AreEqual(validatorType, descriptor[1].GetInteger());
            Assert.AreEqual(module.Hash, new UInt160(descriptor[2].GetSpan()));
            Assert.AreEqual(new BigInteger(module.Id), descriptor[3].GetInteger(), "contractId");
            Assert.AreEqual(BigInteger.One, descriptor[7].GetInteger(), "moduleRevision");
            Assert.AreEqual(BigInteger.One, descriptor[8].GetInteger(), "credentialGeneration");
            Assert.AreEqual(SHA256.HashData(ProfileBytes("Module900", true, false)).ToHexString(),
                descriptor[6].GetSpan().ToArray().ToHexString(),
                "the recorded profile digest is the digest of the deployed profile");
            Assert.IsTrue(descriptor[9].GetBoolean(), "instanceIsolation comes from the module profile");
            Assert.IsFalse(descriptor[10].GetBoolean(), "the core negotiates no message capability");
            Assert.IsFalse(descriptor[11].GetBoolean(), "the core negotiates no threshold membership");

            var page = (Array)UT_SmartAccount.Success(snapshot, "getModules", [id, "validator", 0, 8]);
            Assert.AreEqual(moduleId, ((Array)page[0])[0].GetInteger());
            Assert.AreEqual(BigInteger.Zero, page[1].GetInteger(), "a single page has no further cursor");
            Assert.AreEqual(BigInteger.One, page[2].GetInteger(), "the install advanced the configuration nonce");
            Assert.IsTrue(UT_SmartAccount.Success(snapshot, "isModuleInstalled",
                [id, "validator", module.Hash, new byte[0]]).GetBoolean());
            Assert.IsFalse(UT_SmartAccount.Success(snapshot, "isModuleInstalled",
                [id, "hook", module.Hash, new byte[0]]).GetBoolean(),
                "the instance is registered under exactly one module type");

            // R-07-14: installing the first validator never rewrites the
            // built-in switches — closing them is reserved to the explicit
            // setBuiltinAuthorization landing write (or the recovery reset).
            Assert.IsTrue(Control(snapshot, id)[7].GetBoolean(),
                "installing the first validator keeps the built-in custody route open");
            Assert.IsInstanceOfType<ByteString>(UT_SmartAccount.Success(snapshot, "executeUserOp",
                [id, UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7])]),
                "the built-in custody route stays usable after the install");

            BigInteger routedNonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, moduleId, new byte[32]]).GetInteger();
            var routed = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: routedNonce, sign: false, validatorId: moduleId);
            Assert.IsInstanceOfType<ByteString>(UT_SmartAccount.Success(snapshot, "executeUserOp", [id, routed]));

            UT_SmartAccount.Success(snapshot, "removeModule", [id, moduleId, new object[0]],
                signers: [UT_SmartAccount.Custody]);
            Assert.HasCount(0, Descriptor(snapshot, id, moduleId));
            // R-07-14/R-08-08: the switch never answered to installs or
            // removals, so with the last validator gone the built-in route is
            // simply still open — closing it takes setBuiltinAuthorization,
            // which the last-route guard refuses while no validator remains.
            Assert.IsTrue(Control(snapshot, id)[7].GetBoolean(),
                "removing the last validator never closes the built-in custody route");
            Assert.IsInstanceOfType<ByteString>(UT_SmartAccount.Success(snapshot, "executeUserOp",
                [id, UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7])]),
                "the built-in route stays usable after the last validator is removed");
            using (var twice = UT_SmartAccount.Invoke(snapshot, "removeModule", [id, moduleId, new object[0]],
                signers: [UT_SmartAccount.Custody]))
                Assert.AreEqual(VMState.FAULT, twice.State, "A missing instance cannot be removed twice.");
        }

        [TestMethod]
        public void AnInstalledModuleWitnessAdministersTheModuleModelAndTheThaw()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;
            ContractState governance = DeployModule(snapshot, 901);
            BigInteger governanceId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, validatorType, governance.Hash, new object[0]], signers: [UT_SmartAccount.Custody]).GetInteger();

            ContractState second = DeployModule(snapshot, 902);
            using (var bare = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, validatorType, second.Hash, new object[0]], signers: []))
                Assert.AreEqual(VMState.FAULT, bare.State, "A caller with no witness installs nothing.");

            // The governance module is the caller, so its contract witness is the
            // only authority presented: no custody signer takes part.
            BigInteger secondId = UT_SmartAccount.Success(snapshot, "admin",
                [id, validatorType, second.Hash, new object[0]], signers: [],
                target: governance.Hash).GetInteger();
            Assert.AreEqual(new BigInteger(2), secondId);
            Assert.IsTrue(UT_SmartAccount.Success(snapshot, "isModuleInstalled",
                [id, "validator", second.Hash, new byte[0]]).GetBoolean());

            // The same witness removes an instance the custody key installed.
            UT_SmartAccount.Success(snapshot, "adminRemove", [id, governanceId, new object[0]],
                signers: [], target: second.Hash);
            Assert.HasCount(0, Descriptor(snapshot, id, governanceId));

            // Freeze under custody, then thaw with the module witness alone: the
            // core holds no thaw timelock of its own.
            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], signers: [UT_SmartAccount.Custody]);
            Assert.AreEqual((int)SmartAccountStatus.Frozen, Control(snapshot, id)[1].GetInteger());
            UT_SmartAccount.Success(snapshot, "adminThaw", [id], signers: [], target: second.Hash);
            Assert.AreEqual((int)SmartAccountStatus.Active, Control(snapshot, id)[1].GetInteger());
            Assert.AreEqual(BigInteger.MinusOne,
                UT_SmartAccount.Success(snapshot, "getAuthorizedModuleId", [id, 1]).GetInteger(),
                "Outside a callback no module instance is authorized.");
        }

        /// <summary>
        /// The action-5 landing write (spec §7.1/§7.5, R-07-14): both built-in
        /// switches change only through <c>setBuiltinAuthorization</c> (or the
        /// §12.5 recovery reset). The state gate precedes the administration
        /// re-check, the configuration nonce and the control revision advance
        /// exactly once per landed call, event 14 carries the landed pair, and
        /// the last-route guard keeps an account with no validator from
        /// closing its only routing subject.
        /// </summary>
        [TestMethod]
        public void SetBuiltinAuthorizationLandsTheSwitchesThroughTheAdministrationGate()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            Array before = Control(snapshot, id);
            Assert.IsTrue(before[7].GetBoolean());
            Assert.IsTrue(before[8].GetBoolean());

            using (var foreign = UT_SmartAccount.Invoke(snapshot, "setBuiltinAuthorization",
                [id, true, false], signers: [ForeignCustody]))
            {
                Assert.AreEqual(VMState.FAULT, foreign.State, "an unrelated witness lands nothing");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    foreign.FaultException!.ToString());
            }

            // Custody happy path: the message switch closes while the operation
            // switch stays open (the last-route guard below owns that one); the
            // nonce and the control revision each advance exactly once and
            // event 14 reports the landed pair.
            using (var engine = UT_SmartAccount.Invoke(snapshot, "setBuiltinAuthorization",
                [id, true, false], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
                NotifyEventArgs landed = engine.Notifications.FirstOrDefault(
                    notification => notification.EventName
                        == SmartAccountModuleProtocol.EventNameBuiltinAuthorizationSet);
                Assert.IsNotNull(landed, "the landing write emits BuiltinAuthorizationSet");
                Array payload = (Array)landed!.State;
                Assert.HasCount(3, payload);
                Assert.AreEqual(id, new UInt160(payload[0].GetSpan()));
                Assert.IsTrue(payload[1].GetBoolean());
                Assert.IsFalse(payload[2].GetBoolean());
                engine.SnapshotCache.Commit();
            }
            Array landedControl = Control(snapshot, id);
            Assert.IsTrue(landedControl[7].GetBoolean(), "the operation switch keeps its own witness");
            Assert.IsFalse(landedControl[8].GetBoolean(), "the message switch landed closed");
            Assert.AreEqual(before[5].GetInteger() + 1, landedControl[5].GetInteger(),
                "the configuration nonce advanced exactly once");
            Assert.AreEqual(before[11].GetInteger() + 1, landedControl[11].GetInteger(),
                "the control revision advanced exactly once");

            // Last-route guard (R-07-14/R-08-08): with no validator installed
            // the operation switch refuses to close, and the refused call
            // advances nothing.
            using (var lastRoute = UT_SmartAccount.Invoke(snapshot, "setBuiltinAuthorization",
                [id, false, false], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, lastRoute.State,
                    "closing the operation switch without a validator is refused");
                Assert.Contains(SmartAccountModuleProtocol.ErrorBuiltinRouteRequired,
                    lastRoute.FaultException!.ToString());
            }
            Assert.AreEqual(landedControl[5].GetInteger(), Control(snapshot, id)[5].GetInteger(),
                "the refused call advanced no nonce");
            Assert.AreEqual(landedControl[11].GetInteger(), Control(snapshot, id)[11].GetInteger(),
                "the refused call advanced no revision");

            // An installed validator's contract witness administers the same
            // write with no custody signer — and may close the operation
            // switch, because it is itself the routing subject.
            ContractState validator = DeployModule(snapshot, 950);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;
            BigInteger validatorId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, validatorType, validator.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            UT_SmartAccount.Success(snapshot, "adminBuiltinAuthorization", [id, false, false],
                signers: [], target: validator.Hash);
            Array witnessed = Control(snapshot, id);
            Assert.IsFalse(witnessed[7].GetBoolean(), "the validator witness closed the operation switch");
            Assert.IsFalse(witnessed[8].GetBoolean(), "the validator witness closed the message switch");

            // With the validator removed the guard is back; closing the
            // message switch still needs no routing subject.
            UT_SmartAccount.Success(snapshot, "removeModule", [id, validatorId, new object[0]],
                signers: [UT_SmartAccount.Custody]);
            using (var lastRouteAgain = UT_SmartAccount.Invoke(snapshot, "setBuiltinAuthorization",
                [id, false, true], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, lastRouteAgain.State,
                    "after the removal the operation switch refuses to close again");
                Assert.Contains(SmartAccountModuleProtocol.ErrorBuiltinRouteRequired,
                    lastRouteAgain.FaultException!.ToString());
            }
            UT_SmartAccount.Success(snapshot, "setBuiltinAuthorization", [id, true, false],
                signers: [UT_SmartAccount.Custody]);
            Assert.IsFalse(Control(snapshot, id)[8].GetBoolean(),
                "closing the message switch carries no last-route guard");

            // R-07-11: the witnessing validator's code binding must stay
            // continuous. The same contract installs again (instance isolation)
            // and the deployment then drifts — the module witness loses the
            // administration authority and can no longer rewrite the switches.
            BigInteger reinstalled = UT_SmartAccount.Success(snapshot, "installModule",
                [id, validatorType, validator.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            Assert.AreEqual(validatorId + BigInteger.One, reinstalled,
                "the reinstall allocated the next module id (R-12-09 allocator continuity)");
            UpdateDeployedContract(snapshot, validator);
            using (var stale = UT_SmartAccount.Invoke(snapshot, "adminBuiltinAuthorization",
                [id, true, true], signers: [], target: validator.Hash))
            {
                Assert.AreEqual(VMState.FAULT, stale.State,
                    "a drifted code binding loses the administration witness");
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    stale.FaultException!.ToString());
            }

            // The state gate precedes the administration re-check: a frozen
            // account refuses the write before any witness question.
            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], signers: [UT_SmartAccount.Custody]);
            using (var frozen = UT_SmartAccount.Invoke(snapshot, "setBuiltinAuthorization",
                [id, true, true], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, frozen.State, "a frozen account refuses the landing write");
                Assert.Contains(SmartAccountModuleProtocol.ErrorAccountFrozen,
                    frozen.FaultException!.ToString());
            }
            UT_SmartAccount.Success(snapshot, "unfreezeAccount", [id], signers: [UT_SmartAccount.Custody]);

            // Migration is answered with the generic account-status error: the
            // account must be Active to re-route. No public write path reaches
            // this state, so the 0x51 record is planted directly.
            var controlKey = new StorageKey { Id = NativeContract.SmartAccount.Id,
                Key = SmartAccountProtocol.GetAccountControlKey(id) };
            AccountControl planted = AccountControl.Decode(snapshot.GetAndChange(controlKey)!.Value);
            planted.Status = SmartAccountStatus.MigrationRequired;
            snapshot.GetAndChange(controlKey)!.Value = planted.Serialize();
            using (var migrating = UT_SmartAccount.Invoke(snapshot, "setBuiltinAuthorization",
                [id, true, true], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, migrating.State,
                    "a migration-required account refuses the landing write");
                Assert.Contains(SmartAccountModuleProtocol.ErrorAccountStatus,
                    migrating.FaultException!.ToString());
            }
        }

        /// <summary>
        /// Registration installs modules atomically through the pinned action
        /// shape <c>[1, moduleType, contractHash, profileDigest, initData]</c>
        /// (spec §7.1/§11.1). The declared digest must be the digest of the
        /// profile the deployed code actually returns.
        /// </summary>
        [TestMethod]
        public void RegistrationInstallsModulesAtomicallyAgainstTheDeclaredDigest()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            ContractState module = DeployModule(snapshot, 905);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;
            byte[] digest = SHA256.HashData(ProfileBytes("Module905", true, false));
            object[] action = [SmartAccountModuleProtocol.ActionInstallModule, validatorType,
                module.Hash, digest, new object[0]];

            UInt160 id = SmartAccountProtocol.GetAccountId(UT_SmartAccount.Custody, UT_SmartAccount.Salt);
            UT_SmartAccount.Success(snapshot, "createAccount",
                [id, UT_SmartAccount.Custody, UT_SmartAccount.Salt, 0, new object[] { action }]);

            Assert.AreEqual(BigInteger.One, Descriptor(snapshot, id, BigInteger.One)[7].GetInteger(),
                "the registration action installed the module with revision 1");
            Assert.IsTrue(Control(snapshot, id)[7].GetBoolean(),
                "a validator installed at registration leaves the built-in custody route open (R-07-14)");
            BigInteger packed = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, BigInteger.One, new byte[32]]).GetInteger();
            Assert.AreEqual(BigInteger.Zero, packed & ((BigInteger.One << 64) - 1),
                "the installed validator owns a fresh channel with an empty sequence");

            // A digest that does not match the deployed profile aborts the whole
            // registration: no account, no instance.
            ContractState other = DeployModule(snapshot, 906);
            byte[] salt = new byte[32];
            salt[0] = 1;
            UInt160 otherId = SmartAccountProtocol.GetAccountId(UT_SmartAccount.Custody, salt);
            object[] wrongAction = [SmartAccountModuleProtocol.ActionInstallModule, validatorType,
                other.Hash, new byte[32], new object[0]];
            using (var mismatch = UT_SmartAccount.Invoke(snapshot, "createAccount",
                [otherId, UT_SmartAccount.Custody, salt, 0, new object[] { wrongAction }]))
            {
                Assert.AreEqual(VMState.FAULT, mismatch.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    mismatch.FaultException!.Message);
            }
            Assert.IsFalse(((Array)UT_SmartAccount.Success(snapshot, "getAccount", [otherId]))[0].GetBoolean(),
                "a failed registration action leaves no account behind");
        }

        /// <summary>
        /// R-07-11: a module witness administers the module model only while
        /// its recorded code binding is continuous. A validator contract that
        /// has since been updated (NEF or UpdateCounter drift) loses that
        /// authority for install, remove and thaw alike; the custody witness,
        /// which does not ride on a code binding, is unaffected.
        /// </summary>
        [TestMethod]
        public void AnUpdatedValidatorContractLosesItsModuleAdministrationWitness()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;
            ContractState governance = DeployModule(snapshot, 910);
            UT_SmartAccount.Success(snapshot, "installModule",
                [id, validatorType, governance.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();

            ContractState second = DeployModule(snapshot, 911);
            BigInteger secondId = UT_SmartAccount.Success(snapshot, "admin",
                [id, validatorType, second.Hash, new object[0]], signers: [],
                target: governance.Hash).GetInteger();
            Assert.IsTrue(UT_SmartAccount.Success(snapshot, "isModuleInstalled",
                [id, "validator", second.Hash, new byte[0]]).GetBoolean(),
                "the module witness administers while its code binding holds");

            // The validator contract is updated after install: the recorded
            // binding no longer names the deployed code.
            UpdateDeployedContract(snapshot, governance);

            using (var install = UT_SmartAccount.Invoke(snapshot, "admin",
                [id, validatorType, second.Hash, new object[0]], signers: [], target: governance.Hash))
            {
                Assert.AreEqual(VMState.FAULT, install.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    install.FaultException!.Message);
            }
            using (var removal = UT_SmartAccount.Invoke(snapshot, "adminRemove",
                [id, secondId, new object[0]], signers: [], target: governance.Hash))
            {
                Assert.AreEqual(VMState.FAULT, removal.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    removal.FaultException!.Message);
            }

            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], signers: [UT_SmartAccount.Custody]);
            using (var thaw = UT_SmartAccount.Invoke(snapshot, "adminThaw", [id],
                signers: [], target: governance.Hash))
            {
                Assert.AreEqual(VMState.FAULT, thaw.State);
                // unfreezeAccount is a synchronous native method, so its fault
                // arrives wrapped in a TargetInvocationException; the symbol
                // check must read the whole chain.
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    thaw.FaultException!.ToString());
            }
            UT_SmartAccount.Success(snapshot, "unfreezeAccount", [id], signers: [UT_SmartAccount.Custody]);

            // The custody witness still administers: it never depended on a
            // code binding.
            UT_SmartAccount.Success(snapshot, "removeModule", [id, secondId, new object[0]],
                signers: [UT_SmartAccount.Custody]);
            Assert.HasCount(0, Descriptor(snapshot, id, secondId));
            Assert.HasCount(1, (Array)((Array)UT_SmartAccount.Success(snapshot, "getModules",
                [id, "validator", 0, 8]))[0],
                "the updated validator instance itself stays installed; only its witness lost authority");
        }

        /// <summary>
        /// The validation callback is Boolean or nothing (audit L-1): a reply
        /// outside the Boolean domain is a callback contract violation with its
        /// own symbol, not a module-type error.
        /// </summary>
        [TestMethod]
        public void AValidatorReplyOutsideTheBooleanDomainFaultsWithItsOwnSymbol()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            ContractState module = DeployModule(snapshot, 913, brokenReply: true);
            BigInteger moduleId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeValidator, module.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();

            BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, moduleId, new byte[32]]).GetInteger();
            var routed = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: nonce, sign: false, validatorId: moduleId);
            using (var reply = UT_SmartAccount.Invoke(snapshot, "executeUserOp", [id, routed]))
            {
                Assert.AreEqual(VMState.FAULT, reply.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorCallbackReturnType,
                    reply.FaultException!.Message);
            }
        }

        [TestMethod]
        public void ModuleAdministrationAcceptsOnlyTheV4TypesAndKnownAccounts()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            ContractState validator = DeployModule(snapshot, 903);
            ContractState hookModule = DeployModule(snapshot, 904, hook: true);

            // 0 names nothing, 2 is the retired display alias, and 3 and 6
            // never existed as v4 install codes; 5 is the recovery seat
            // (spec §7.1/§12.5).
            foreach (int undefinedType in new[] { 0, 2, 3, 6 })
                using (var undefined = UT_SmartAccount.Invoke(snapshot, "installModule",
                    [id, undefinedType, validator.Hash, new object[0]], signers: [UT_SmartAccount.Custody]))
                    Assert.AreEqual(VMState.FAULT, undefined.State,
                        $"type {undefinedType} is not a v4 install code");

            // A hook installs as type 4 and needs no routing callbacks: the core
            // never routes a hook, so it must not demand validateUserOp.
            BigInteger hookId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeHook, hookModule.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            Assert.AreEqual(SmartAccountModuleProtocol.ModuleTypeCodeHook,
                Descriptor(snapshot, id, hookId)[1].GetInteger());
            Assert.IsTrue(Control(snapshot, id)[7].GetBoolean(),
                "a hook owns no validation, so the built-in custody route stays open");
            using (var hookNonce = UT_SmartAccount.Invoke(snapshot, "getNonce", [id, hookId, new byte[32]]))
                Assert.AreEqual(VMState.FAULT, hookNonce.State, "A hook has no routing credential.");
            using (var routedHook = UT_SmartAccount.Invoke(snapshot, "executeUserOp",
                [id, UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                    sign: false, validatorId: hookId)]))
                Assert.AreEqual(VMState.FAULT, routedHook.State, "A hook is never a routing target.");

            // Eight hooks per account is the cap; the ninth is refused with the
            // hook limit, not the validator limit.
            for (int i = 1; i < SmartAccountModuleProtocol.MaxHookModuleInstances; i++)
                UT_SmartAccount.Success(snapshot, "installModule",
                    [id, SmartAccountModuleProtocol.ModuleTypeCodeHook, hookModule.Hash, new object[0]],
                    signers: [UT_SmartAccount.Custody]);
            var full = (Array)UT_SmartAccount.Success(snapshot, "getModules", [id, "hook", 0, 8]);
            Assert.HasCount(SmartAccountModuleProtocol.MaxHookModuleInstances, (Array)full[0]);
            var overLimit = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeHook, hookModule.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]);
            using (overLimit)
            {
                Assert.AreEqual(VMState.FAULT, overLimit.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleLimitHook,
                    overLimit.FaultException!.Message);
            }

            using (var native = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeValidator, NativeContract.Ledger.Hash,
                    new object[0]], signers: [UT_SmartAccount.Custody]))
                Assert.AreEqual(VMState.FAULT, native.State, "A native contract is never a module.");
            using (var missing = UT_SmartAccount.Invoke(snapshot, "removeModule", [id, 77, new object[0]],
                signers: [UT_SmartAccount.Custody]))
                Assert.AreEqual(VMState.FAULT, missing.State, "An unknown module id is not removable.");
            using (var unknown = UT_SmartAccount.Invoke(snapshot, "installModule",
                [ForeignCustody, SmartAccountModuleProtocol.ModuleTypeCodeValidator, validator.Hash,
                    new object[0]], signers: [UT_SmartAccount.Custody]))
                Assert.AreEqual(VMState.FAULT, unknown.State, "An unregistered account has no module model.");

            var emptyPage = (Array)UT_SmartAccount.Success(snapshot, "getModules", [id, "validator", 0, 8]);
            Assert.HasCount(0, (Array)emptyPage[0]);
        }

        /// <summary>Core-owned rows under one prefix for one account.</summary>
        private static int CountUnder(DataCache snapshot, UInt160 accountId, byte prefix)
        {
            byte[] seek = new byte[1 + UInt160.Length];
            seek[0] = prefix;
            accountId.ToArray().CopyTo(seek, 1);
            int count = 0;
            foreach (var _ in snapshot.Find(new StorageKey { Id = NativeContract.SmartAccount.Id, Key = seek })) count++;
            return count;
        }

        /// <summary>
        /// H-4(a): the action-8 landing write (spec §7.1/§12.5). The state gate
        /// answers before the authorization gate (R-09-02); the authority and
        /// timelock domains are re-checked in the core because it is the only
        /// writer of the 0x51 record; the write advances the configuration
        /// nonce with the rest of the configuration family, and the governance
        /// module's own contract witness lands the same write.
        /// </summary>
        [TestMethod]
        public void TheRecoveryPolicyLandingWriteChecksItsDomainAndAdvancesTheControl()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            UInt160 authority = UInt160.Parse("0x0505050505050505050505050505050505050505");
            BigInteger min = AccountControl.RecoveryTimelockMinMs;
            BigInteger max = AccountControl.RecoveryTimelockMaxMs;
            object[] Args(BigInteger timelock, bool ownerOnly) => [id, authority, timelock, ownerOnly];

            using (var foreign = UT_SmartAccount.Invoke(snapshot, "setRecoveryPolicy",
                Args(min, true), signers: [ForeignCustody]))
            {
                Assert.AreEqual(VMState.FAULT, foreign.State,
                    "Only the administration family writes the recovery policy.");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    foreign.FaultException!.ToString());
            }

            // The state gate answers before the authorization gate, so even a
            // witnessless caller learns the account is frozen, not unauthorized.
            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], signers: [UT_SmartAccount.Custody]);
            using (var frozen = UT_SmartAccount.Invoke(snapshot, "setRecoveryPolicy",
                Args(min, true), signers: [ForeignCustody]))
            {
                Assert.AreEqual(VMState.FAULT, frozen.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorAccountFrozen,
                    frozen.FaultException!.ToString());
            }
            UT_SmartAccount.Success(snapshot, "unfreezeAccount", [id], signers: [UT_SmartAccount.Custody]);

            foreach (BigInteger outside in new[] { min - 1, max + 1 })
                using (var domain = UT_SmartAccount.Invoke(snapshot, "setRecoveryPolicy",
                    Args(outside, false), signers: [UT_SmartAccount.Custody]))
                {
                    Assert.AreEqual(VMState.FAULT, domain.State,
                        $"the 7..90-day timelock domain is closed ({outside} ms)");
                    Assert.Contains(SmartAccountModuleProtocol.ErrorOperationMalformed,
                        domain.FaultException!.ToString());
                }
            using (var zero = UT_SmartAccount.Invoke(snapshot, "setRecoveryPolicy",
                [id, UInt160.Zero, min, false], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, zero.State, "A zero authority names nobody.");
                Assert.Contains(SmartAccountModuleProtocol.ErrorOperationMalformed,
                    zero.FaultException!.ToString());
            }

            BigInteger nonceBefore = Control(snapshot, id)[5].GetInteger();
            UT_SmartAccount.Success(snapshot, "setRecoveryPolicy", Args(min, true),
                signers: [UT_SmartAccount.Custody]);
            Array landed = Control(snapshot, id);
            Assert.AreEqual(authority, new UInt160(landed[3].GetSpan()));
            Assert.AreEqual(min, landed[6].GetInteger());
            Assert.IsTrue(landed[9].GetBoolean(), "ownerOnlyRecovery is recorded verbatim");
            Assert.AreEqual(nonceBefore + 1, landed[5].GetInteger(),
                "the landing write advances the configuration nonce");

            // The governance-module witness lands the same write: an installed
            // validator contract presents its own witness, no custody signer.
            ContractState governance = DeployModule(snapshot, 920);
            UT_SmartAccount.Success(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeValidator, governance.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]);
            UT_SmartAccount.Success(snapshot, "adminRecoveryPolicy",
                [id, authority, max, false], signers: [], target: governance.Hash);
            Array relayed = Control(snapshot, id);
            Assert.AreEqual(max, relayed[6].GetInteger(),
                "the module witness lands the action-8 write too");
            Assert.IsFalse(relayed[9].GetBoolean());
        }

        /// <summary>
        /// H-3: the credential-revocation landing write (spec §7.1/§14.2,
        /// R-11-13/R-14-11). Bumping the generation retires every outstanding
        /// credential of the instance immediately, and the instance itself
        /// stays installed — revocation is not uninstall.
        /// </summary>
        [TestMethod]
        public void CredentialRevocationBumpsValidatorsOnlyAndRetiresOutstandingCredentials()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            ContractState validator = DeployModule(snapshot, 921);
            ContractState hookModule = DeployModule(snapshot, 922, hook: true);
            ContractState seat = DeployModule(snapshot, 923, recovery: true);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;

            BigInteger validatorId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, validatorType, validator.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            BigInteger hookId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeHook, hookModule.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            BigInteger seatId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeRecovery, seat.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            Assert.AreEqual(new BigInteger(1), validatorId);
            Assert.AreEqual(new BigInteger(2), hookId);
            Assert.AreEqual(new BigInteger(3), seatId);

            using (var foreign = UT_SmartAccount.Invoke(snapshot, "revokeModuleCredentials",
                [id, validatorId], signers: [ForeignCustody]))
            {
                Assert.AreEqual(VMState.FAULT, foreign.State,
                    "Only the administration family revokes credentials.");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    foreign.FaultException!.ToString());
            }

            foreach (BigInteger nonValidator in new[] { hookId, seatId })
                using (var byType = UT_SmartAccount.Invoke(snapshot, "revokeModuleCredentials",
                    [id, nonValidator], signers: [UT_SmartAccount.Custody]))
                {
                    Assert.AreEqual(VMState.FAULT, byType.State,
                        "a hook or recovery seat carries no routable credential");
                    Assert.Contains(SmartAccountModuleProtocol.ErrorModuleTypeUnsupported,
                        byType.FaultException!.ToString());
                }
            using (var missing = UT_SmartAccount.Invoke(snapshot, "revokeModuleCredentials",
                [id, 77], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, missing.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleNotInstalled,
                    missing.FaultException!.ToString());
            }

            BigInteger nonceBefore = Control(snapshot, id)[5].GetInteger();
            UT_SmartAccount.Success(snapshot, "revokeModuleCredentials",
                [id, validatorId], signers: [UT_SmartAccount.Custody]);
            Array revoked = Descriptor(snapshot, id, validatorId);
            Assert.HasCount(12, revoked, "the revoked instance stays installed");
            Assert.AreEqual(new BigInteger(2), revoked[8].GetInteger(),
                "revocation bumps the recorded generation");
            Assert.AreEqual(nonceBefore + 1, Control(snapshot, id)[5].GetInteger(),
                "revocation advances the account configuration nonce");

            // The bumped generation retires the outstanding credential of the
            // routed channel: an operation replayed with the old generation is
            // stale even though the validator would still approve it.
            BigInteger routedNonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, validatorId, new byte[32]]).GetInteger();
            var routed = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: routedNonce, sign: false, validatorId: validatorId);
            using (var stale = UT_SmartAccount.Invoke(snapshot, "executeUserOp", [id, routed]))
            {
                Assert.AreEqual(VMState.FAULT, stale.State,
                    "the revoked generation retires every outstanding credential");
                Assert.Contains(SmartAccountModuleProtocol.ErrorCredentialStale,
                    stale.FaultException!.ToString());
            }

            // The validator's own contract witness lands the same bump (the
            // HookOrchestratorModule landing path, spec §14.2).
            UT_SmartAccount.Success(snapshot, "adminRevoke", [id, validatorId],
                signers: [], target: validator.Hash);
            Assert.AreEqual(new BigInteger(3), Descriptor(snapshot, id, validatorId)[8].GetInteger(),
                "the module witness revokes the generation too");
        }

        /// <summary>
        /// H-4(b): the §12.5 reset belongs to the recovery seat alone
        /// (R-12-12). It spends the recovery authority, removes every module
        /// instance and nonce channel without a single callback, rotates the
        /// custody and restores the registration defaults — but keeps the id
        /// allocator (R-12-09).
        /// </summary>
        [TestMethod]
        public void TheAccountResetBelongsToTheRecoverySeatAlone()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            BigInteger min = AccountControl.RecoveryTimelockMinMs;
            UInt160 authority = UInt160.Parse("0x0505050505050505050505050505050505050505");

            using (var unconfigured = UT_SmartAccount.Invoke(snapshot, "resetAccount",
                [id, UInt160.Zero], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, unconfigured.State,
                    "an authority that was never configured names no recovery to finish");
                Assert.Contains(SmartAccountModuleProtocol.ErrorAccountStatus,
                    unconfigured.FaultException!.ToString());
            }

            UT_SmartAccount.Success(snapshot, "setRecoveryPolicy", [id, authority, min, false],
                signers: [UT_SmartAccount.Custody]);
            using (var early = UT_SmartAccount.Invoke(snapshot, "resetAccount",
                [id, UInt160.Zero], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, early.State,
                    "the custody may configure recovery but never execute it");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    early.FaultException!.ToString());
            }

            ContractState hookModule = DeployModule(snapshot, 930, hook: true);
            ContractState seat = DeployModule(snapshot, 931, recovery: true);
            ContractState secondSeat = DeployModule(snapshot, 932, recovery: true);
            ContractState validator = DeployModule(snapshot, 933);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;

            BigInteger hookId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeHook, hookModule.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            BigInteger seatId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeRecovery, seat.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            Assert.IsTrue(Control(snapshot, id)[7].GetBoolean(),
                "the recovery seat owns no validation; the built-in route stays open");
            using (var overSeat = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeRecovery, secondSeat.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, overSeat.State, "one recovery seat per account");
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleLimitRecovery,
                    overSeat.FaultException!.ToString());
            }

            BigInteger validatorId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, validatorType, validator.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            Assert.AreEqual(new BigInteger(3), validatorId);

            // A routed operation and a channel leave nonce state behind; the
            // reset must take the cursors and channel digests with it.
            BigInteger routedNonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, validatorId, new byte[32]]).GetInteger();
            var routed = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: routedNonce, sign: false, validatorId: validatorId);
            Assert.IsInstanceOfType<ByteString>(UT_SmartAccount.Success(snapshot, "executeUserOp", [id, routed]));
            byte[] legacy = new byte[1 + UInt160.Length];
            legacy[0] = SmartAccountModuleProtocol.PrefixMigrationState;
            id.ToArray().CopyTo(legacy, 1);
            snapshot.Add(new StorageKey { Id = NativeContract.SmartAccount.Id, Key = legacy },
                new StorageItem(new byte[16]));
            // Positive controls: the routed operation left a nonce cursor and
            // the channel left a namespace digest — the reset must take both.
            Assert.IsGreaterThan(0, CountUnder(snapshot, id, 0x56));
            Assert.IsGreaterThan(0, CountUnder(snapshot, id, 0x5C));

            // Every witness but the seat is refused: the validator contract, the
            // hook contract and the custody all fail the seat gate.
            foreach (ContractState caller in new[] { validator, hookModule })
                using (var refused = UT_SmartAccount.Invoke(snapshot, "adminReset", [id, ForeignCustody],
                    signers: [], target: caller.Hash))
                {
                    Assert.AreEqual(VMState.FAULT, refused.State,
                        "only the recovery seat may trigger the reset");
                    Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                        refused.FaultException!.ToString());
                }

            Array before = Control(snapshot, id);
            UT_SmartAccount.Success(snapshot, "adminReset", [id, ForeignCustody],
                signers: [], target: seat.Hash);

            Array after = Control(snapshot, id);
            Assert.AreEqual(ForeignCustody, new UInt160(after[2].GetSpan()),
                "custody rotated to the reset target");
            Assert.AreEqual(UInt160.Zero, new UInt160(after[3].GetSpan()),
                "the reset spends the recovery authority");
            Assert.AreEqual(before[4].GetInteger() + 1, after[4].GetInteger(),
                "the reset advances the authority epoch");
            Assert.AreEqual(before[5].GetInteger() + 1, after[5].GetInteger(),
                "the reset advances the configuration nonce");
            Assert.IsTrue(after[7].GetBoolean(), "the registration defaults are restored");
            Assert.IsTrue(after[8].GetBoolean());
            Assert.IsFalse(after[9].GetBoolean(), "the reset clears ownerOnlyRecovery");

            foreach (string type in new[] { "validator", "hook", "recovery" })
            {
                var page = (Array)UT_SmartAccount.Success(snapshot, "getModules", [id, type, 0, 8]);
                Assert.HasCount(0, (Array)page[0], $"the reset removed every {type} instance");
            }
            using (var channel = UT_SmartAccount.Invoke(snapshot, "getNonce",
                [id, validatorId, new byte[32]]))
            {
                Assert.AreEqual(VMState.FAULT, channel.State,
                    "the reset removed the routed channel together with its module");
                Assert.Contains(SmartAccountModuleProtocol.ErrorValidatorNotFound,
                    channel.FaultException!.ToString());
            }
            Assert.IsNull(snapshot.TryGet(new StorageKey { Id = NativeContract.SmartAccount.Id, Key = legacy }));
            Assert.AreEqual(0, CountUnder(snapshot, id, 0x52), "no module record survives the reset");
            Assert.AreEqual(0, CountUnder(snapshot, id, 0x53), "no index row survives the reset");
            Assert.AreEqual(0, CountUnder(snapshot, id, 0x56), "the nonce cursors are gone");
            Assert.AreEqual(0, CountUnder(snapshot, id, 0x5C), "the namespace digests are gone");

            // The retired custody no longer witnesses administration; the new
            // one does, and the allocator continues where it stopped (R-12-09).
            using (var retired = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, validatorType, validator.Hash, new object[0]], signers: [UT_SmartAccount.Custody]))
                Assert.AreEqual(VMState.FAULT, retired.State,
                    "the rotated-out custody lost its administration witness");
            BigInteger fresh = UT_SmartAccount.Success(snapshot, "installModule",
                [id, validatorType, validator.Hash, new object[0]],
                signers: [ForeignCustody]).GetInteger();
            Assert.AreEqual(new BigInteger(4), fresh, "the id allocator survives the reset (R-12-09)");
        }

        /// <summary>
        /// R-12-08: the reset is atomic against the whole calling script. The
        /// seat here faults AFTER the core call returns — the seat's own
        /// post-reset bookkeeping is where every real fault lands — so the
        /// completed rotation must revert with the script, leaving no half
        /// reset behind.
        /// </summary>
        [TestMethod]
        public void AFaultAfterTheResetRevertsTheWholeRotation()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            BigInteger min = AccountControl.RecoveryTimelockMinMs;
            UInt160 authority = UInt160.Parse("0x0505050505050505050505050505050505050505");
            UT_SmartAccount.Success(snapshot, "setRecoveryPolicy", [id, authority, min, false],
                signers: [UT_SmartAccount.Custody]);

            ContractState validator = DeployModule(snapshot, 940);
            BigInteger validatorId = UT_SmartAccount.Success(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeValidator, validator.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]).GetInteger();
            ContractState poison = DeployModule(snapshot, 941, recovery: true, poisonAfterReset: true);
            UT_SmartAccount.Success(snapshot, "installModule",
                [id, SmartAccountModuleProtocol.ModuleTypeCodeRecovery, poison.Hash, new object[0]],
                signers: [UT_SmartAccount.Custody]);

            BigInteger epochBefore = Control(snapshot, id)[4].GetInteger();
            using (var faulted = UT_SmartAccount.Invoke(snapshot, "adminReset", [id, ForeignCustody],
                signers: [], target: poison.Hash))
            {
                Assert.AreEqual(VMState.FAULT, faulted.State);
                // The fault must be the seat's own post-reset fault, not an SA
                // gate: that is what proves the core reset completed first.
                Assert.DoesNotContain("SA_", faulted.FaultException!.ToString());
            }

            Assert.HasCount(12, Descriptor(snapshot, id, validatorId), "the validator instance survived");
            var seatPage = (Array)UT_SmartAccount.Success(snapshot, "getModules", [id, "recovery", 0, 8]);
            Assert.HasCount(1, (Array)seatPage[0], "the seat itself is still installed");
            Array intact = Control(snapshot, id);
            Assert.AreEqual(UT_SmartAccount.Custody, new UInt160(intact[2].GetSpan()),
                "the custody never rotated");
            Assert.AreEqual(authority, new UInt160(intact[3].GetSpan()),
                "the recovery authority is unspent");
            Assert.AreEqual(epochBefore, intact[4].GetInteger(), "the authority epoch never advanced");
            Assert.IsTrue(intact[7].GetBoolean(),
                "the built-in route was never closed: installs do not rewrite switches (R-07-14)");
        }
    }
}
