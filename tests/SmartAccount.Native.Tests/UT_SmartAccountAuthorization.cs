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
    /// §7.1/§8): <c>installModule</c>/<c>removeModule</c>/<c>configureModule</c>,
    /// the simplified <c>unfreezeAccount</c> and the restricted landing writes
    /// <c>setBuiltinAuthorization</c>/<c>revokeModuleCredentials</c> accept a
    /// code-bound governance caller, else the custody witness OR the witness
    /// of an installed validator instance while no mandatory route exists;
    /// <c>resetAccount</c> accepts only the account's installed recovery seat
    /// (R-12-12). Recovery, threshold and message policy live in modules.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountAuthorization
    {
        private static readonly UInt160 ForeignCustody = UInt160.Parse("0x0404040404040404040404040404040404040404");

        private static byte[] ProfileBytes(string name, bool isolation, bool hook) =>
            ProfileBytes(name, isolation, hook ? "hook" : "validator");

        private static byte[] ProfileBytes(string name, bool isolation, string moduleType, bool message = false) =>
            System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            {
                callbacks = moduleType switch
                {
                    "validator" => message
                        ? new[] { "validateUserOp", "onUserOpComplete", "isValidSignature" }
                        : new[] { "validateUserOp", "onUserOpComplete" },
                    "hook" => new[] { "preCheck", "postCheck" },
                    _ => System.Array.Empty<string>()
                },
                capabilities = new { compositeLayer = 0, instanceIsolation = isolation, messageCapability = message, thresholdMemberEligible = false },
                contractName = name, lifecycle = new[] { "onInstall", "onUninstall" }, moduleType, profileVersion = 1
            });

        /// <summary>
        /// A deployed module: the profile and lifecycle callbacks every instance
        /// kind must expose, the two routing callbacks when it is a validator,
        /// and a governance surface that re-enters the core so the module's own
        /// contract witness is the only authority those calls present.
        /// </summary>
        private static ContractState DeployModule(DataCache snapshot, int number, bool isolation = true,
            bool hook = false, bool brokenReply = false, bool recovery = false, bool poisonAfterReset = false,
            Func<byte[], byte[]> alterProfile = null, int configureArity = 0, string manifestName = null, bool message = false,
            Action<ScriptBuilder, string> customize = null)
        {
            string name = manifestName ?? $"Module{number}";
            byte[] profile = ProfileBytes(name, isolation, recovery ? "recovery" : hook ? "hook" : "validator",
                message && !hook && !recovery);
            if (alterProfile != null) profile = alterProfile(profile);

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
                customize?.Invoke(script, methodName);
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
            if (configureArity > 0)
                Method("configure", ContractParameterType.Void, false, _ => { },
                    new[] { ContractParameterType.Hash160, ContractParameterType.Integer,
                        ContractParameterType.Integer, ContractParameterType.Array }.Take(configureArity).ToArray());
            foreach (string lifecycle in new[] { "onInstall", "onUninstall" })
                Method(lifecycle, ContractParameterType.Void, false, _ => { },
                    ContractParameterType.Hash160, ContractParameterType.Integer,
                    ContractParameterType.Integer, ContractParameterType.Array);
            if (hook)
            {
                Method("preCheck", ContractParameterType.ByteArray, false,
                    builder => builder.EmitPush(new byte[] { 17 }), ContractParameterType.Hash160, ContractParameterType.Array);
                Method("postCheck", ContractParameterType.Void, false,
                    builder => builder.Emit(OpCode.LDARG3).EmitPush(new byte[] { 17 }).Emit(OpCode.EQUAL).Emit(OpCode.ASSERT),
                    ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Any, ContractParameterType.ByteArray);
            }
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
                if (message)
                {
                    // Message route (§8): the reply is true only while the core
                    // addresses this instance in its Validation phase (§9.2), so
                    // a magic-valid answer proves the account lease AND the
                    // phase grant were established before the callback.
                    Method("isValidSignature", ContractParameterType.Boolean, true, builder =>
                    {
                        // PACK takes the top of the stack as element 0, so the
                        // arguments are pushed in reverse.
                        builder.EmitPush((int)SmartAccountCallbackPhase.Validation).Emit(OpCode.LDARG0)
                            .EmitPush(2).Emit(OpCode.PACK)
                            .EmitPush((int)CallFlags.ReadOnly).EmitPush("getAuthorizedModuleId")
                            .EmitPush(NativeContract.SmartAccount.Hash)
                            .EmitSysCall(ApplicationEngine.System_Contract_Call);
                        builder.EmitPush(0).Emit(OpCode.GT);
                    }, ContractParameterType.Hash160, ContractParameterType.Hash160, ContractParameterType.Integer,
                        ContractParameterType.Integer, ContractParameterType.ByteArray, ContractParameterType.Array);
                }
            }
            // PACK takes the top of the stack as element 0, so the arguments are
            // pushed in reverse to rebuild the positional call array.
            Method("admin", ContractParameterType.Integer, false, builder =>
            {
                builder.Emit(OpCode.LDARG3).Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCall(builder, "installModule", 4);
            }, ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Hash160, ContractParameterType.Array);
            Method("adminReset", ContractParameterType.Void, false, builder =>
            {
                builder.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(builder, "resetAccount", 2);
                // The deliberate post-reset fault the atomicity test needs: the
                // reset itself completes, and the fault right after it must
                // revert the whole rotation with the faulting script.
                if (poisonAfterReset) builder.EmitPush(false).Emit(OpCode.ASSERT);
            }, ContractParameterType.Hash160, ContractParameterType.Hash160);
            // The seat's atomic rotation: the restricted reset and the
            // single-use install-only initialization it opens, in one script.
            Method("adminResetInit", ContractParameterType.Void, false, builder =>
            {
                builder.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(builder, "resetAccount", 2);
                builder.Emit(OpCode.LDARG2).Emit(OpCode.LDARG0);
                CoreCallVoid(builder, "applyConfigurationActions", 2);
            }, ContractParameterType.Hash160, ContractParameterType.Hash160, ContractParameterType.Array);

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
        [DataRow("\"compositeLayer\":0,", "")]
        [DataRow("\"compositeLayer\":0", "\"compositeLayer\":2")]
        [DataRow("\"messageCapability\":false", "\"messageCapability\":true")]
        [DataRow("\"thresholdMemberEligible\":false", "\"thresholdMemberEligible\":true")]
        [DataRow("\"postCheck\"", "\"preCheck\"")]
        [DataRow("\"onUninstall\"", "\"onUninstall\",\"configure\"")]
        [DataRow("\"profileVersion\":1", "\"profileVersion\":1.0")]
        [DataRow("\"callbacks\":", "\"callbacks\": ")]
        [DataRow("\"compositeLayer\":0", "\"compositeLayer\":0,\"compositeLayer\":0")]
        public void InstallRefusesNonconformingHookWithoutConsumingAnInstance(string before, string after)
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 970, out ContractState governor);
            var invalid = DeployModule(snapshot, 960, hook: true, alterProfile: bytes =>
            {
                string original = Encoding.UTF8.GetString(bytes);
                string changed = original.Replace(before, after, StringComparison.Ordinal);
                Assert.AreNotEqual(original, changed);
                return Encoding.UTF8.GetBytes(changed);
            });
            int type = SmartAccountModuleProtocol.ModuleTypeCodeHook;
            using var rejected = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, type, invalid.Hash, new object[0]));
            Assert.AreEqual(VMState.FAULT, rejected.State);
            Assert.DoesNotContain("ModuleInstanceInstalled", rejected.Notifications.Select(n => n.EventName));
            var valid = DeployModule(snapshot, 961, hook: true);
            Assert.AreEqual(new BigInteger(2), UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, type, valid.Hash, new object[0])).GetInteger(),
                "the governance instance owns module id 1, so the refused install consumed no id");
        }

        [TestMethod]
        public void InstallAgreesWithPublishedDiscoveryVectors()
        {
            var path = System.IO.Path.Combine(AppContext.BaseDirectory, "module-profile-vectors.json");
            using var cases = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllBytes(path));
            foreach (var vector in cases.RootElement.EnumerateArray())
            {
                var snapshot = UT_SmartAccount.Snapshot();
                UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 972, out ContractState governor);
                string label = vector.GetProperty("case").GetString();
                string name = vector.GetProperty("manifestName").GetString();
                byte[] wire = Encoding.UTF8.GetBytes(vector.GetProperty("profileText").GetString());
                bool isHook = vector.GetProperty("role").GetString() == "hook";
                bool accepted = vector.GetProperty("expectedAccepted").GetBoolean();
                var module = DeployModule(snapshot, 963, hook: isHook, configureArity: 4,
                    alterProfile: _ => wire, manifestName: name);
                int type = isHook ? SmartAccountModuleProtocol.ModuleTypeCodeHook : SmartAccountModuleProtocol.ModuleTypeCodeValidator;
                using var install = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                    UT_SmartAccountGovernance.GovInstall,
                    UT_SmartAccountGovernance.Install(id, type, module.Hash, new object[0]));
                Assert.AreEqual(accepted ? VMState.HALT : VMState.FAULT, install.State, label + ": " + install.FaultException);
                Assert.AreEqual(accepted ? 1 : 0, install.Notifications.Count(n => n.EventName == "ModuleInstanceInstalled"), label);
                if (!accepted) continue;
                var instance = install.ResultStack.Peek().GetInteger();
                install.SnapshotCache.Commit();
                Assert.AreEqual(vector.GetProperty("sha256").GetString(),
                    Convert.ToHexStringLower(Descriptor(snapshot, id, instance)[6].GetSpan()), label);
            }
        }

        [TestMethod]
        [DataRow(false, 4, false)]
        [DataRow(true, 4, true)]
        [DataRow(false, 3, true)]
        [DataRow(true, 3, false)]
        public void InstallMatchesConfigurationDeclarationToDispatchArity(bool declared, int arity, bool accepted)
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 973, out ContractState governor);
            var hook = DeployModule(snapshot, 962, hook: true, configureArity: arity,
                alterProfile: bytes => declared ? Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes)
                    .Replace("\"onUninstall\"", "\"onUninstall\",\"configure\"", StringComparison.Ordinal)) : bytes);
            using var install = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeHook,
                    hook.Hash, new object[0]));
            Assert.AreEqual(accepted ? VMState.HALT : VMState.FAULT, install.State, install.FaultException?.ToString());
            Assert.AreEqual(accepted ? 1 : 0, install.Notifications.Count(n => n.EventName == "ModuleInstanceInstalled"));
        }

        [TestMethod]
        public void InstallIsGovernanceGatedAndHandsValidationToTheInstance()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 974, out ContractState governor);
            ContractState module = DeployModule(snapshot, 900);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;

            using (var foreign = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, validatorType, module.Hash, new object[0]], signers: [ForeignCustody]))
                Assert.AreEqual(VMState.FAULT, foreign.State,
                    "Only the bound governance instance may install a module.");
            using (var custody = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, validatorType, module.Hash, new object[0]]))
                Assert.AreEqual(VMState.FAULT, custody.State,
                    "The custody key is not a module-administration principal.");

            using var install = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, validatorType, module.Hash, new object[0]));
            Assert.AreEqual(VMState.HALT, install.State, install.FaultException?.ToString());
            var installed = install.Notifications.Single(n => n.EventName == "ModuleInstanceInstalled").State;
            Assert.HasCount(5, installed);
            Assert.AreEqual(StackItemType.Integer, installed[4].Type);
            Assert.AreEqual(BigInteger.One, installed[4].GetInteger(),
                "a fresh instance starts at credential generation 1");
            BigInteger moduleId = install.ResultStack.Peek().GetInteger();
            install.SnapshotCache.Commit();
            Assert.AreEqual(new BigInteger(2), moduleId, "the governance instance owns the first id");

            Array descriptor = Descriptor(snapshot, id, moduleId);
            Assert.HasCount(15, descriptor,
                "the descriptor carries the three negotiated composition capabilities too");
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
            Assert.AreEqual(moduleId, ((Array)page[0])[1].GetInteger(),
                "the page lists the creation install first, then this landing");
            Assert.AreEqual(BigInteger.Zero, page[1].GetInteger(), "a single page has no further cursor");
            Assert.AreEqual(new BigInteger(2), page[2].GetInteger(),
                "the creation group and the install each advanced the configuration nonce once");
            Assert.IsTrue(UT_SmartAccount.Success(snapshot, "isModuleInstalled",
                [id, "validator", module.Hash, new byte[0]]).GetBoolean());
            Assert.IsFalse(UT_SmartAccount.Success(snapshot, "isModuleInstalled",
                [id, "hook", module.Hash, new byte[0]]).GetBoolean(),
                "the instance is registered under exactly one module type");

            // R-07-14: installing the first validator never rewrites the
            // built-in switches — closing them is reserved to the explicit
            // setBuiltinAuthorization landing write (or the recovery reset).
            Assert.IsTrue(Control(snapshot, id)[5].GetBoolean(),
                "installing the first validator keeps the built-in custody route open");
            Assert.IsInstanceOfType<ByteString>(UT_SmartAccount.Success(snapshot, "executeUserOp",
                [id, UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7])]),
                "the built-in custody route stays usable after the install");

            BigInteger routedNonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, moduleId, new byte[32]]).GetInteger();
            var routed = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: routedNonce, sign: false, validatorId: moduleId);
            Assert.IsInstanceOfType<ByteString>(UT_SmartAccount.Success(snapshot, "executeUserOp", [id, routed]));

            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovRemove,
                [id, moduleId, new object[0]]);
            Assert.HasCount(0, Descriptor(snapshot, id, moduleId));
            // R-07-14/R-08-08: the switch never answered to installs or
            // removals, so with the removable validator gone the built-in route
            // is simply still open — the governance instance itself keeps the
            // last-route guard satisfied.
            Assert.IsTrue(Control(snapshot, id)[5].GetBoolean(),
                "removing a validator never closes the built-in custody route");
            Assert.IsInstanceOfType<ByteString>(UT_SmartAccount.Success(snapshot, "executeUserOp",
                [id, UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7])]),
                "the built-in route stays usable after the validator is removed");
            using (var twice = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovRemove, [id, moduleId, new object[0]]))
                Assert.AreEqual(VMState.FAULT, twice.State, "A missing instance cannot be removed twice.");
        }

        [TestMethod]
        public void TheGovernanceInstanceAdministersTheModuleModelAndTheThaw()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 975, out ContractState governor);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;

            ContractState second = DeployModule(snapshot, 902);
            using (var bare = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, validatorType, second.Hash, new object[0]]))
                Assert.AreEqual(VMState.FAULT, bare.State, "A caller with no witness installs nothing.");
            using (var plain = UT_SmartAccount.Invoke(snapshot, "admin",
                [id, validatorType, second.Hash, new object[0]], signers: [], target: second.Hash))
                Assert.AreEqual(VMState.FAULT, plain.State,
                    "an installed validator without the governance capability administers nothing");

            // The governance instance is the caller, so its contract witness is
            // the only authority presented: no custody signer takes part.
            BigInteger secondId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, validatorType, second.Hash, new object[0])).GetInteger();
            Assert.AreEqual(new BigInteger(2), secondId);
            Assert.IsTrue(UT_SmartAccount.Success(snapshot, "isModuleInstalled",
                [id, "validator", second.Hash, new byte[0]]).GetBoolean());

            // The same witness removes an instance it installed.
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovRemove,
                [id, secondId, new object[0]]);
            Assert.HasCount(0, Descriptor(snapshot, id, secondId));

            // Freeze under custody, then thaw with the governance witness alone:
            // the core holds no thaw timelock of its own, so a user-space
            // governance module owns any delay.
            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], signers: [UT_SmartAccount.Custody]);
            Assert.AreEqual((int)SmartAccountStatus.Frozen, Control(snapshot, id)[1].GetInteger());
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovThaw, [id]);
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
        public void SetBuiltinAuthorizationLandsTheSwitchesThroughTheGovernanceGate()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 976, out ContractState governor);
            Array before = Control(snapshot, id);
            Assert.IsTrue(before[5].GetBoolean(), "the operation switch starts open");
            Assert.IsTrue(before[6].GetBoolean(), "the message switch starts open");

            using (var foreign = UT_SmartAccount.Invoke(snapshot, "setBuiltinAuthorization",
                [id, true, false], signers: [ForeignCustody]))
            {
                Assert.AreEqual(VMState.FAULT, foreign.State, "an unrelated witness lands nothing");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    foreign.FaultException!.ToString());
            }
            using (var custody = UT_SmartAccount.Invoke(snapshot, "setBuiltinAuthorization",
                [id, true, false], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, custody.State,
                    "the custody key is not a module-administration principal");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    custody.FaultException!.ToString());
            }

            // Governance happy path: the message switch closes while the
            // operation switch stays open (the last-route guard below owns that
            // one); the nonce and the control revision each advance exactly once
            // and event 14 reports the landed pair.
            using (var engine = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovBuiltin, [id, true, false]))
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
            Assert.IsTrue(landedControl[5].GetBoolean(), "the operation switch keeps its own witness");
            Assert.IsFalse(landedControl[6].GetBoolean(), "the message switch landed closed");
            Assert.AreEqual(before[4].GetInteger() + 1, landedControl[4].GetInteger(),
                "the configuration nonce advanced exactly once");
            Assert.AreEqual(before[8].GetInteger() + 1, landedControl[8].GetInteger(),
                "the control revision advanced exactly once");

            // The last-route guard (R-07-14/R-08-08): the operation switch may
            // close while a validator is installed, and the governance instance
            // cannot then remove itself — it is the last routing subject.
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovBuiltin,
                [id, false, false]);
            Assert.IsFalse(Control(snapshot, id)[5].GetBoolean(),
                "an installed validator satisfies the last-route guard");
            Array closed = Control(snapshot, id);
            using (var stranded = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovRemove, [id, 1, new object[0]]))
            {
                Assert.AreEqual(VMState.FAULT, stranded.State,
                    "removing the last validator while the route is closed is refused");
                Assert.Contains(SmartAccountModuleProtocol.ErrorBuiltinRouteRequired,
                    stranded.FaultException!.ToString());
            }
            Assert.AreEqual(closed[4].GetInteger(), Control(snapshot, id)[4].GetInteger(),
                "the refused removal advanced no nonce");
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovBuiltin,
                [id, true, false]);

            // The state gate precedes the administration re-check: a frozen
            // account refuses the write before any witness question.
            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], signers: [UT_SmartAccount.Custody]);
            using (var frozen = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovBuiltin, [id, true, true]))
            {
                Assert.AreEqual(VMState.FAULT, frozen.State, "a frozen account refuses the landing write");
                Assert.Contains(SmartAccountModuleProtocol.ErrorAccountFrozen,
                    frozen.FaultException!.ToString());
            }
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovThaw, [id]);

            // R-07-11: the governance authority rides on its recorded code
            // binding. Once the deployment drifts, the same contract can no
            // longer land any configuration.
            UpdateDeployedContract(snapshot, governor);
            using (var stale = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovBuiltin, [id, true, true]))
            {
                Assert.AreEqual(VMState.FAULT, stale.State,
                    "a drifted code binding loses the administration witness");
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    stale.FaultException!.ToString());
            }

            // An undefined stored status must fail decoding before authorization.
            var controlKey = NativeContract.SmartAccount.Key(SmartAccountModuleProtocol.PrefixAccountControl).Add(id);
            AccountControl planted = AccountControl.Decode(snapshot.GetAndChange(controlKey)!.Value);
            planted.Status = (SmartAccountStatus)2;
            snapshot.GetAndChange(controlKey)!.Value = planted.Serialize();
            using (var migrating = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovBuiltin, [id, true, true]))
            {
                Assert.AreEqual(VMState.FAULT, migrating.State,
                    "an undefined status refuses the landing write");
                Assert.Contains("account status is not defined",
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
                [id, UT_SmartAccount.Custody, UT_SmartAccount.Salt, new object[] { action }]);

            Assert.AreEqual(BigInteger.One, Descriptor(snapshot, id, BigInteger.One)[7].GetInteger(),
                "the registration action installed the module with revision 1");
            Assert.IsTrue(Control(snapshot, id)[5].GetBoolean(),
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
                [otherId, UT_SmartAccount.Custody, salt, new object[] { wrongAction }]))
            {
                Assert.AreEqual(VMState.FAULT, mismatch.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    mismatch.FaultException!.Message);
            }
            Assert.IsFalse(((Array)UT_SmartAccount.Success(snapshot, "getAccount", [otherId]))[0].GetBoolean(),
                "a failed registration action leaves no account behind");
        }

        /// <summary>
        /// R-07-11: the governance instance administers the module model only
        /// while its recorded code binding is continuous. A governance contract
        /// that has since been updated (NEF or UpdateCounter drift) loses that
        /// authority for install, remove and thaw alike, and the custody key —
        /// which is not an administration principal — cannot stand in for it.
        /// </summary>
        [TestMethod]
        public void AnUpdatedGovernanceContractLosesItsModuleAdministrationWitness()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 977, out ContractState governor);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;

            ContractState second = DeployModule(snapshot, 911);
            BigInteger secondId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, validatorType, second.Hash, new object[0])).GetInteger();
            Assert.IsTrue(UT_SmartAccount.Success(snapshot, "isModuleInstalled",
                [id, "validator", second.Hash, new byte[0]]).GetBoolean(),
                "the governance instance administers while its code binding holds");

            // The governance contract is updated after install: the recorded
            // binding no longer names the deployed code.
            UpdateDeployedContract(snapshot, governor);

            using (var install = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, validatorType, second.Hash, new object[0])))
            {
                Assert.AreEqual(VMState.FAULT, install.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    install.FaultException!.Message);
            }
            using (var removal = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovRemove, [id, secondId, new object[0]]))
            {
                Assert.AreEqual(VMState.FAULT, removal.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    removal.FaultException!.Message);
            }

            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], signers: [UT_SmartAccount.Custody]);
            using (var thaw = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovThaw, [id]))
            {
                Assert.AreEqual(VMState.FAULT, thaw.State);
                // unfreezeAccount is a synchronous native method, so its fault
                // arrives wrapped in a TargetInvocationException; the symbol
                // check must read the whole chain.
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    thaw.FaultException!.ToString());
            }

            // The custody key is not an administration principal: it cannot
            // thaw the account either, and the drift leaves the composition
            // intact until the recovery seat rotates it.
            using (var custodyThaw = UT_SmartAccount.Invoke(snapshot, "unfreezeAccount", [id]))
            {
                Assert.AreEqual(VMState.FAULT, custodyThaw.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    custodyThaw.FaultException!.ToString());
            }
            Assert.AreEqual((int)SmartAccountStatus.Frozen, Control(snapshot, id)[1].GetInteger());
            Assert.IsTrue(UT_SmartAccount.Success(snapshot, "isModuleInstalled",
                [id, "validator", second.Hash, new byte[0]]).GetBoolean(),
                "the module instance stays installed; only the witness lost authority");
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
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 978, out ContractState governor);
            ContractState module = DeployModule(snapshot, 913, brokenReply: true);
            BigInteger moduleId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeValidator,
                    module.Hash, new object[0])).GetInteger();

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

        /// <summary>
        /// A module owns only the tree it is called with. The routed validator appends to the argument
        /// list of its callback operation; the native dispatches and completes on its own validated
        /// encoding, so the hooks and the completion callback that follow still read one argument and
        /// the target is called with exactly the signed arguments.
        /// </summary>
        [TestMethod]
        public void AModuleEditingItsCallbackOperationCannotReachLaterCallbacksOrTheTarget()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 986, out ContractState governor);
            // validateUserOp receives the operation as argument 2; every other callback as argument 1.
            void Edits(ScriptBuilder builder, string method)
            {
                if (method is not ("validateUserOp" or "onUserOpComplete" or "preCheck" or "postCheck")) return;
                builder.Emit(method == "validateUserOp" ? OpCode.LDARG2 : OpCode.LDARG1)
                    .EmitPush(SmartAccountModuleProtocol.OpArgs).Emit(OpCode.PICKITEM);
                if (method == "validateUserOp") builder.EmitPush(999).Emit(OpCode.APPEND);
                else builder.Emit(OpCode.SIZE).EmitPush(1).Emit(OpCode.EQUAL).Emit(OpCode.ASSERT);
            }
            ContractState validator = DeployModule(snapshot, 987, customize: Edits);
            ContractState hook = DeployModule(snapshot, 988, hook: true, customize: Edits);
            BigInteger validatorId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeValidator,
                    validator.Hash, new object[0])).GetInteger();
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeHook,
                    hook.Hash, new object[0]));

            BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, validatorId, new byte[32]]).GetInteger();
            var routed = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: nonce, sign: false, validatorId: validatorId);
            // StdLib.serialize of the signed argument list: a second argument would change the reply.
            Assert.AreSequenceEqual(
                UT_SmartAccount.Success(snapshot, "serialize", [7], signers: [], target: NativeContract.StdLib.Hash).GetSpan().ToArray(),
                UT_SmartAccount.Success(snapshot, "executeUserOp", [id, routed]).GetSpan().ToArray(),
                "the target received the signed arguments, not the edited tree");
        }

        [TestMethod]
        public void ModuleAdministrationAcceptsOnlyTheV4TypesAndKnownAccounts()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 979, out ContractState governor);
            ContractState validator = DeployModule(snapshot, 903);
            ContractState hookModule = DeployModule(snapshot, 904, hook: true);

            // 0 names nothing, 2 is the retired display alias, and 3 and 6
            // never existed as v4 install codes; 5 is the recovery seat
            // (spec §7.1/§12.5).
            foreach (int undefinedType in new[] { 0, 2, 3, 6 })
                using (var undefined = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                    UT_SmartAccountGovernance.GovInstall,
                    UT_SmartAccountGovernance.Install(id, undefinedType, validator.Hash, new object[0])))
                    Assert.AreEqual(VMState.FAULT, undefined.State,
                        $"type {undefinedType} is not a v4 install code");

            // A hook installs as type 4 and needs no routing callbacks: the core
            // never routes a hook, so it must not demand validateUserOp.
            BigInteger hookId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeHook,
                    hookModule.Hash, new object[0])).GetInteger();
            Assert.AreEqual(SmartAccountModuleProtocol.ModuleTypeCodeHook,
                Descriptor(snapshot, id, hookId)[1].GetInteger());
            Assert.IsTrue(Control(snapshot, id)[5].GetBoolean(),
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
                UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovInstall,
                    UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeHook,
                        hookModule.Hash, new object[0]));
            var full = (Array)UT_SmartAccount.Success(snapshot, "getModules", [id, "hook", 0, 8]);
            Assert.HasCount(SmartAccountModuleProtocol.MaxHookModuleInstances, (Array)full[0]);
            var overLimit = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeHook,
                    hookModule.Hash, new object[0]));
            using (overLimit)
            {
                Assert.AreEqual(VMState.FAULT, overLimit.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleLimitHook,
                    overLimit.FaultException!.Message);
            }

            using (var native = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeValidator,
                    NativeContract.Ledger.Hash, new object[0])))
                Assert.AreEqual(VMState.FAULT, native.State, "A native contract is never a module.");
            using (var missing = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovRemove, [id, 77, new object[0]]))
                Assert.AreEqual(VMState.FAULT, missing.State, "An unknown module id is not removable.");
            using (var unknown = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(ForeignCustody,
                    SmartAccountModuleProtocol.ModuleTypeCodeValidator, validator.Hash, new object[0])))
                Assert.AreEqual(VMState.FAULT, unknown.State, "An unregistered account has no module model.");

            var emptyPage = (Array)UT_SmartAccount.Success(snapshot, "getModules", [id, "validator", 0, 8]);
            Assert.HasCount(1, (Array)emptyPage[0], "only the governance instance is a validator here");
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
        /// H-3: the credential-revocation landing write (spec §7.1/§14.2,
        /// R-11-13/R-14-11). Bumping the generation retires every outstanding
        /// credential of the instance immediately, and the instance itself
        /// stays installed — revocation is not uninstall.
        /// </summary>
        [TestMethod]
        public void CredentialRevocationBumpsValidatorsOnlyAndRetiresOutstandingCredentials()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 981, out ContractState governor);
            ContractState validator = DeployModule(snapshot, 921);
            ContractState hookModule = DeployModule(snapshot, 922, hook: true);
            ContractState seat = DeployModule(snapshot, 923, recovery: true);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;

            BigInteger validatorId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, validatorType, validator.Hash, new object[0])).GetInteger();
            BigInteger hookId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeHook,
                    hookModule.Hash, new object[0])).GetInteger();
            BigInteger seatId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
                    seat.Hash, new object[0])).GetInteger();
            Assert.AreEqual(new BigInteger(2), validatorId);
            Assert.AreEqual(new BigInteger(3), hookId);
            Assert.AreEqual(new BigInteger(4), seatId);

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

            BigInteger nonceBefore = Control(snapshot, id)[4].GetInteger();
            // The routed nonce is taken while generation 1 is still live, so the
            // replayed envelope still resolves its channel; the fresh control
            // fields let it pass the epoch and configuration gates, and the
            // retirement surfaces at the credential gate itself.
            BigInteger routedNonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, validatorId, new byte[32]]).GetInteger();
            UT_SmartAccount.Success(snapshot, "revokeModuleCredentials",
                [id, validatorId], signers: [UT_SmartAccount.Custody]);
            Array revoked = Descriptor(snapshot, id, validatorId);
            Assert.HasCount(15, revoked, "the revoked instance stays installed");
            Assert.AreEqual(new BigInteger(2), revoked[8].GetInteger(),
                "revocation bumps the recorded generation");
            Assert.AreEqual(nonceBefore + 1, Control(snapshot, id)[4].GetInteger(),
                "revocation advances the account configuration nonce");

            // The bumped generation retires the outstanding credential of the
            // routed channel: an operation replayed with the old generation is
            // stale even though the validator would still approve it.
            var routed = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: routedNonce, sign: false, validatorId: validatorId);
            using (var stale = UT_SmartAccount.Invoke(snapshot, "executeUserOp", [id, routed]))
            {
                Assert.AreEqual(VMState.FAULT, stale.State,
                    "the revoked generation retires every outstanding credential");
                Assert.Contains(SmartAccountModuleProtocol.ErrorCredentialStale,
                    stale.FaultException!.ToString());
            }

            // The governance instance lands the same bump (the
            // HookOrchestratorModule landing path, spec §14.2).
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovRevoke,
                [id, validatorId]);
            Assert.AreEqual(new BigInteger(3), Descriptor(snapshot, id, validatorId)[8].GetInteger(),
                "the governance witness revokes the generation too");
        }

        /// <summary>
        /// H-4(b): the §12.5 reset belongs to the installed recovery seat alone
        /// (R-12-12). It removes every module instance and nonce channel
        /// without a single callback, rotates the custody and restores the
        /// registration defaults — but keeps the id allocator (R-12-09).
        /// </summary>
        [TestMethod]
        public void TheAccountResetBelongsToTheRecoverySeatAlone()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 982, out ContractState governor);

            using (var unconfigured = UT_SmartAccount.Invoke(snapshot, "resetAccount",
                [id, UInt160.Zero], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, unconfigured.State,
                    "an account with no installed seat has no recovery to finish");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    unconfigured.FaultException!.ToString());
            }

            ContractState hookModule = DeployModule(snapshot, 930, hook: true);
            ContractState seat = DeployModule(snapshot, 931, recovery: true);
            ContractState secondSeat = DeployModule(snapshot, 932, recovery: true);
            ContractState validator = DeployModule(snapshot, 933);
            int validatorType = SmartAccountModuleProtocol.ModuleTypeCodeValidator;

            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeHook,
                    hookModule.Hash, new object[0]));
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
                    seat.Hash, new object[0]));
            Assert.IsTrue(Control(snapshot, id)[5].GetBoolean(),
                "the recovery seat owns no validation; the built-in route stays open");
            using (var overSeat = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
                    secondSeat.Hash, new object[0])))
            {
                Assert.AreEqual(VMState.FAULT, overSeat.State, "one recovery seat per account");
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleLimitRecovery,
                    overSeat.FaultException!.ToString());
            }

            BigInteger validatorId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, validatorType, validator.Hash, new object[0])).GetInteger();
            Assert.AreEqual(new BigInteger(4), validatorId);

            // A routed operation and a channel leave nonce state behind; the
            // reset must take the cursors and channel digests with it.
            BigInteger routedNonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, validatorId, new byte[32]]).GetInteger();
            var routed = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: routedNonce, sign: false, validatorId: validatorId);
            Assert.IsInstanceOfType<ByteString>(UT_SmartAccount.Success(snapshot, "executeUserOp", [id, routed]));
            // Positive controls: the routed operation left a nonce cursor and
            // the channel left a namespace digest — the reset must take both.
            Assert.IsGreaterThan(0, CountUnder(snapshot, id, 0x56));
            Assert.IsGreaterThan(0, CountUnder(snapshot, id, 0x5C));

            // Every caller but the seat is refused: the validator contract, the
            // hook contract and the custody all fail the seat gate. The custody
            // may install the seat but never execute the reset itself.
            foreach (ContractState caller in new[] { validator, hookModule })
                using (var refused = UT_SmartAccount.Invoke(snapshot, "adminReset", [id, ForeignCustody],
                    signers: [], target: caller.Hash))
                {
                    Assert.AreEqual(VMState.FAULT, refused.State,
                        "only the recovery seat may trigger the reset");
                    Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                        refused.FaultException!.ToString());
                }
            using (var custody = UT_SmartAccount.Invoke(snapshot, "resetAccount",
                [id, ForeignCustody], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, custody.State,
                    "the custody witness is never the recovery seat");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    custody.FaultException!.ToString());
            }

            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], signers: [UT_SmartAccount.Custody]);
            Array before = Control(snapshot, id);

            // The rotation is one script: the restricted reset only the seat may
            // claim, immediately followed by the single-use install-only group
            // that opens the next composition. A plain reset without the group
            // could never be followed by one — the reset removes the seat itself.
            ContractState successor = UT_SmartAccountGovernance.Deploy(snapshot, 934, "Successor");
            UT_SmartAccount.Success(snapshot, "adminResetInit",
                [id, ForeignCustody, new object[]
                {
                    new object[] { SmartAccountModuleProtocol.ActionInstallModule, validatorType,
                        successor.Hash, SHA256.HashData(UT_SmartAccountGovernance.Profile("Successor")),
                        new object[0] },
                }], signers: [], target: seat.Hash);

            Array after = Control(snapshot, id);
            Assert.AreEqual(ForeignCustody, new UInt160(after[2].GetSpan()),
                "custody rotated to the reset target");
            Assert.AreEqual(before[3].GetInteger() + 1, after[3].GetInteger(),
                "the reset advances the authority epoch");
            Assert.AreEqual(before[4].GetInteger() + 1, after[4].GetInteger(),
                "the reset advances the configuration nonce");
            Assert.IsTrue(after[5].GetBoolean(), "the registration defaults are restored");
            Assert.IsTrue(after[6].GetBoolean());
            Assert.AreEqual(BigInteger.Zero, after[7].GetInteger(),
                "the reset clears the generic mandatory route");

            var validatorPage = (Array)UT_SmartAccount.Success(snapshot, "getModules", [id, "validator", 0, 8]);
            Assert.HasCount(1, (Array)validatorPage[0],
                "the reset removed the old composition and the initialization installed the successor");
            Assert.AreEqual(new BigInteger(5), ((Array)validatorPage[0])[0].GetInteger(),
                "the id allocator survives the reset (R-12-09)");
            foreach (string type in new[] { "hook", "recovery" })
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
            Assert.AreEqual(1, CountUnder(snapshot, id, 0x52),
                "only the successor's module record survives the reset");
            Assert.AreEqual(1, CountUnder(snapshot, id, 0x53),
                "only the successor's index row survives the reset");
            Assert.AreEqual(0, CountUnder(snapshot, id, 0x56), "the nonce cursors are gone");
            Assert.AreEqual(0, CountUnder(snapshot, id, 0x5C), "the namespace digests are gone");

            // The rotation leaves the account without any administration
            // principal: the retired custody, the rotated-in custody and an
            // outsider all fail, because none of them is a bound governance
            // instance.
            using (var retired = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, validatorType, validator.Hash, new object[0]], signers: [UT_SmartAccount.Custody]))
                Assert.AreEqual(VMState.FAULT, retired.State,
                    "the rotated-out custody has no administration authority");
            using (var rotated = UT_SmartAccount.Invoke(snapshot, "installModule",
                [id, validatorType, validator.Hash, new object[0]], signers: [ForeignCustody]))
                Assert.AreEqual(VMState.FAULT, rotated.State,
                    "the rotated-in custody is not an administration principal either");

            // The successor is now the account's only administration principal,
            // and the allocator continues where it stopped (R-12-09).
            Assert.AreEqual(new BigInteger(6),
                UT_SmartAccountGovernance.Land(snapshot, successor, UT_SmartAccountGovernance.GovInstall,
                    UT_SmartAccountGovernance.Install(id, validatorType, validator.Hash,
                        new object[0])).GetInteger(),
                "the successor governs the account and the allocator continues after the reset");
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
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 983, out ContractState governor);

            ContractState validator = DeployModule(snapshot, 940);
            BigInteger validatorId = UT_SmartAccountGovernance.Land(snapshot, governor,
                UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeValidator,
                    validator.Hash, new object[0])).GetInteger();
            ContractState poison = DeployModule(snapshot, 941, recovery: true, poisonAfterReset: true);
            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovInstall,
                UT_SmartAccountGovernance.Install(id, SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
                    poison.Hash, new object[0]));

            Array before = Control(snapshot, id);
            using (var faulted = UT_SmartAccount.Invoke(snapshot, "adminReset", [id, ForeignCustody],
                signers: [], target: poison.Hash))
            {
                Assert.AreEqual(VMState.FAULT, faulted.State);
                // The fault must be the seat's own post-reset fault, not an SA
                // gate: that is what proves the core reset completed first.
                Assert.DoesNotContain("SA_", faulted.FaultException!.ToString());
            }

            Assert.HasCount(15, Descriptor(snapshot, id, validatorId), "the validator instance survived");
            var seatPage = (Array)UT_SmartAccount.Success(snapshot, "getModules", [id, "recovery", 0, 8]);
            Assert.HasCount(1, (Array)seatPage[0], "the seat itself is still installed");
            Array intact = Control(snapshot, id);
            Assert.AreEqual(UT_SmartAccount.Custody, new UInt160(intact[2].GetSpan()),
                "the custody never rotated");
            Assert.AreEqual(before[3].GetInteger(), intact[3].GetInteger(), "the authority epoch never advanced");
            Assert.AreEqual(before[4].GetInteger(), intact[4].GetInteger(), "the configuration nonce never advanced");
            Assert.IsTrue(intact[5].GetBoolean(),
                "the built-in route was never closed: installs do not rewrite switches (R-07-14)");
        }
    }
}
