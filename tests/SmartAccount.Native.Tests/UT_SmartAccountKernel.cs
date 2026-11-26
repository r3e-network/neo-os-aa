// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccountKernel.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

using Microsoft.VisualStudio.TestTools.UnitTesting;
using Moq;
using Neo.Cryptography;
using Neo.Extensions;
using Neo.Network.P2P;
using Neo.Network.P2P.Payloads;
using Neo.Ledger;
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
using HashAlgorithm = Neo.Cryptography.HashAlgorithm;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// The current interpretation of the native core: the closed 26-method
    /// ABI, the governance-only configuration matrix, the single-advance
    /// configuration nonce, the recovery-seat reset and the prehashed P-256
    /// custody signature. Every test here runs the one current SmartAccount
    /// profile and deploys its own modules.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountKernel
    {
        private const int Validator = SmartAccountModuleProtocol.ModuleTypeCodeValidator;
        private const int Hook = SmartAccountModuleProtocol.ModuleTypeCodeHook;
        private const int Recovery = SmartAccountModuleProtocol.ModuleTypeCodeRecovery;

        private static ProtocolSettings Current => UT_SmartAccount.Settings;

        private static readonly UInt160 ForeignCustody =
            UInt160.Parse("0x0505050505050505050505050505050505050505");

        private sealed record Module(ContractState State, byte[] Profile);

        private delegate void MethodAdder(string name, ContractParameterType result, Action<ScriptBuilder> body,
            ContractParameterType[] parameters);

        /// <summary>
        /// The canonical module profile grammar (spec §7.3/§12): token order,
        /// numeric composite layer and the true-only optional capabilities.
        /// The returned bytes are what the module serves and what the installer
        /// declares as its digest.
        /// </summary>
        private static byte[] Profile(string name, string moduleType, bool governance = false,
            bool composite = false, bool member = false, bool planner = false, bool configure = false)
        {
            string callbacks = moduleType switch
            {
                "validator" => "\"validateUserOp\",\"onUserOpComplete\"" + (planner ? ",\"planHooks\"" : ""),
                "hook" => "\"preCheck\",\"postCheck\"",
                _ => "",
            };
            string profile = "{\"callbacks\":[" + callbacks + "],\"capabilities\":{\"compositeLayer\":"
                + (composite ? 1 : 0)
                + (governance ? ",\"governance\":true" : "")
                + (planner ? ",\"hookPlanner\":true" : "")
                + ",\"instanceIsolation\":true,\"messageCapability\":false,\"thresholdMemberEligible\":"
                + (member ? "true" : "false")
                + "},\"contractName\":\"" + name + "\",\"lifecycle\":[\"onInstall\",\"onUninstall\""
                + (configure ? ",\"configure\"" : "") + "],\"moduleType\":\"" + moduleType
                + "\",\"profileVersion\":1}";
            return Encoding.UTF8.GetBytes(profile);
        }

        private static void CoreCall(ScriptBuilder builder, string method, int count) =>
            builder.EmitPush(count).Emit(OpCode.PACK)
                .EmitPush((int)CallFlags.All).EmitPush(method)
                .EmitPush(NativeContract.SmartAccount.Hash)
                .EmitSysCall(ApplicationEngine.System_Contract_Call);

        private static void CoreCallVoid(ScriptBuilder builder, string method, int count)
        {
            CoreCall(builder, method, count);
            builder.Emit(OpCode.DROP);
        }

        /// <summary>
        /// Deploys a module contract with the callback surface its profile
        /// declares and the forwarding surface a test needs. The forwarding
        /// methods re-enter the core so the module's own contract witness is
        /// the only authority the core sees. A test may also script the bodies
        /// of the lifecycle install and of the hook callbacks.
        /// </summary>
        private static Module Deploy(DataCache snapshot, int number, string moduleType,
            bool governance = false, bool composite = false, bool member = false, bool planner = false,
            Action<ScriptBuilder> validate = null, Action<ScriptBuilder> plan = null,
            Action<MethodAdder> extra = null, Action<ScriptBuilder> install = null,
            Action<ScriptBuilder> preCheck = null, Action<ScriptBuilder> postCheck = null,
            Action<ScriptBuilder> complete = null)
        {
            string name = $"Module{number}";
            byte[] profile = Profile(name, moduleType, governance, composite, member, planner);
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

            Method("getModuleProfile", ContractParameterType.String, true, b => b.EmitPush(profile));
            Method("onInstall", ContractParameterType.Void, false, install ?? (_ => { }),
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Integer, ContractParameterType.Array);
            Method("onUninstall", ContractParameterType.Void, false, _ => { },
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Integer, ContractParameterType.Array);
            if (moduleType == "validator")
            {
                Method("validateUserOp", ContractParameterType.Boolean, true,
                    validate ?? (b => b.EmitPush(true)),
                    ContractParameterType.Hash160, ContractParameterType.ByteArray, ContractParameterType.Array);
                Method("onUserOpComplete", ContractParameterType.Void, false, complete ?? (_ => { }),
                    ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Any);
                if (planner)
                    Method("planHooks", ContractParameterType.Array, true,
                        plan ?? (b => b.Emit(OpCode.NEWARRAY0)),
                        ContractParameterType.Hash160, ContractParameterType.ByteArray, ContractParameterType.Array);
            }
            if (moduleType == "hook")
            {
                Method("preCheck", ContractParameterType.ByteArray, false,
                    preCheck ?? (b => b.EmitPush(new byte[] { 17 })), ContractParameterType.Hash160, ContractParameterType.Array);
                Method("postCheck", ContractParameterType.Void, false, postCheck ?? (_ => { }),
                    ContractParameterType.Hash160, ContractParameterType.Array,
                    ContractParameterType.Any, ContractParameterType.ByteArray);
            }
            extra?.Invoke((methodName, result, body, parameters) =>
                Method(methodName, result, false, body, parameters));

            ContractState contract = TestUtils.GetContract(script.ToArray());
            contract.Id = number;
            contract.Manifest.Name = name;
            contract.Manifest.Abi.Methods = methods.ToArray();
            snapshot.AddContract(contract.Hash, contract);
            return new Module(contract, profile);
        }

        /// <summary>The governance surface: every landable administration transition.</summary>
        private static Action<MethodAdder> GovernanceSurface => add =>
        {
            add("govInstall", ContractParameterType.Integer, b =>
            {
                b.Emit(OpCode.LDARG3).Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCall(b, "installModule", 4);
            }, new[] { ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Hash160, ContractParameterType.Array });
            add("govApply", ContractParameterType.Void, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "applyConfigurationActions", 2);
            }, new[] { ContractParameterType.Hash160, ContractParameterType.Array });
            add("govThaw", ContractParameterType.Void, b =>
            {
                b.Emit(OpCode.LDARG0);
                CoreCallVoid(b, "unfreezeAccount", 1);
            }, new[] { ContractParameterType.Hash160 });
            add("govRevoke", ContractParameterType.Void, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "revokeModuleCredentials", 2);
            }, new[] { ContractParameterType.Hash160, ContractParameterType.Integer });
            add("govReset", ContractParameterType.Void, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "resetAccount", 2);
            }, new[] { ContractParameterType.Hash160, ContractParameterType.Hash160 });
        };

        /// <summary>The recovery seat's only authority: the restricted reset, and the single-use
        /// install-only initialization the reset opens in the same engine.</summary>
        private static Action<MethodAdder> RecoverySurface => add =>
        {
            add("recReset", ContractParameterType.Void, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "resetAccount", 2);
            }, new[] { ContractParameterType.Hash160, ContractParameterType.Hash160 });
            add("recResetInit", ContractParameterType.Void, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "resetAccount", 2);
                b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "applyConfigurationActions", 2);
            }, new[] { ContractParameterType.Hash160, ContractParameterType.Hash160,
                ContractParameterType.Array });
            add("recResetTwice", ContractParameterType.Void, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "resetAccount", 2);
                b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "applyConfigurationActions", 2);
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "resetAccount", 2);
            }, new[] { ContractParameterType.Hash160, ContractParameterType.Hash160,
                ContractParameterType.Array });
            add("recApply", ContractParameterType.Void, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "applyConfigurationActions", 2);
            }, new[] { ContractParameterType.Hash160, ContractParameterType.Array });
            add("recApplyTwice", ContractParameterType.Void, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "resetAccount", 2);
                b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "applyConfigurationActions", 2);
                b.Emit(OpCode.LDARG3).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "applyConfigurationActions", 2);
            }, new[] { ContractParameterType.Hash160, ContractParameterType.Hash160,
                ContractParameterType.Array, ContractParameterType.Array });
        };

        /// <summary>A composite parent that asks the core to validate a member.</summary>
        private static Action<ScriptBuilder> MemberCall(int memberId, int times = 1) => b =>
        {
            for (int i = 0; i < times; i++)
            {
                if (i > 0) b.Emit(OpCode.DROP);
                b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).EmitPush(memberId).Emit(OpCode.LDARG0);
                b.EmitPush(4).Emit(OpCode.PACK)
                    .EmitPush((int)CallFlags.All).EmitPush("validateMember")
                    .EmitPush(NativeContract.SmartAccount.Hash)
                    .EmitSysCall(ApplicationEngine.System_Contract_Call);
            }
        };

        /// <summary>
        /// A callback body that burns <paramref name="datoshi"/> through
        /// System.Runtime.BurnGas, fee table independent, and leaves the stack as
        /// it found it.
        /// </summary>
        private static Action<ScriptBuilder> Burn(long datoshi) => b =>
            b.EmitPush(datoshi).EmitSysCall(ApplicationEngine.System_Runtime_BurnGas);

        private static object[] Install(Module module, int moduleType) =>
            [SmartAccountModuleProtocol.ActionInstallModule, moduleType, module.State.Hash,
                SHA256.HashData(module.Profile), new object[0]];

        private static UInt160 Create(DataCache snapshot, byte seed, params object[] actions)
        {
            // C# passes a lone object[] argument straight through as the params
            // array, so a single registration action would arrive as the action
            // itself. The atomic group is always an array of action arrays.
            object[] group = actions.Length > 0 && actions[0] is not object[] ? [actions] : actions;
            byte[] salt = new byte[32];
            salt[0] = seed;
            UInt160 id = SmartAccountProtocol.GetAccountId(UT_SmartAccount.Custody, salt);
            UT_SmartAccount.Success(snapshot, "createAccount",
                [id, UT_SmartAccount.Custody, salt, group], settings: Current);
            return id;
        }

        private static Array Account(DataCache snapshot, UInt160 id) =>
            (Array)UT_SmartAccount.Success(snapshot, "getAccount", [id], settings: Current);

        private static Array Descriptor(DataCache snapshot, UInt160 id, BigInteger moduleId) =>
            (Array)UT_SmartAccount.Success(snapshot, "getModule", [id, moduleId], settings: Current);

        private static int ModuleCount(DataCache snapshot, UInt160 id, string type) =>
            ((Array)((Array)UT_SmartAccount.Success(snapshot, "getModules", [id, type, 0, 8],
                settings: Current))[0]).Count;

        private static ApplicationEngine Call(DataCache snapshot, string method, object[] args,
            UInt160 target = null, UInt160[] signers = null) =>
            UT_SmartAccount.Invoke(snapshot, method, args, signers: signers, target: target, settings: Current);

        private static StackItem Item(object value) => value switch
        {
            object[] items => new Array(items.Select(Item).ToArray()),
            BigInteger number => new Integer(number),
            int number => new Integer(number),
            long number => new Integer(number),
            string text => new ByteString(Encoding.UTF8.GetBytes(text)),
            byte[] bytes => new ByteString(bytes),
            bool flag => flag ? StackItem.True : StackItem.False,
            UInt160 hash => new ByteString(hash.ToArray()),
            StackItem item => item,
            null => StackItem.Null,
            _ => throw new ArgumentException(value.GetType().Name),
        };

        /// <summary>
        /// A transaction whose script is the application script of each operation
        /// in sequence, each built the way a client builds it.
        /// </summary>
        private static Transaction Envelopes(UInt160 id, params object[][] operations) => new()
        {
            Version = 0,
            Script = operations.SelectMany(operation => SmartAccountTestSupport.ExecuteUserOp(id, Item(operation))
                .Concat(new[] { (byte)OpCode.DROP })).ToArray(),
            Signers = [new Signer { Account = UT_SmartAccount.Custody, Scopes = WitnessScope.Global }],
            Attributes = [],
            Witnesses = [],
        };

        /// <summary>
        /// Creation is the account's consent to install modules only: remove,
        /// configure, the built-in switches and the required-validator pin are
        /// governance landings after creation, never part of the atomic group.
        /// </summary>
        [TestMethod]
        public void CreationAcceptsOnlyTheInitialInstall()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1001, "validator", governance: true,
                extra: GovernanceSurface);
            var member = Deploy(snapshot, 1002, "validator", member: true);

            foreach (int code in new[] { 2, 3, 5, 7 })
            {
                byte[] salt = new byte[32];
                salt[0] = (byte)(40 + code);
                UInt160 id = SmartAccountProtocol.GetAccountId(UT_SmartAccount.Custody, salt);
                object[] action = code is 2 or 3
                    ? [code, 1, new object[0]]
                    : [code, 1, true];
                using var refused = UT_SmartAccount.Invoke(snapshot, "createAccount",
                    [id, UT_SmartAccount.Custody, salt, new object[] { action }], settings: Current);
                Assert.AreEqual(VMState.FAULT, refused.State, $"action code {code} is not an initial install");
                Assert.Contains(SmartAccountModuleProtocol.ErrorOperationMalformed,
                    refused.FaultException!.ToString());
                Assert.IsFalse(((Array)UT_SmartAccount.Success(snapshot, "getAccount", [id],
                    settings: Current))[0].GetBoolean(), "a refused group leaves no account behind");
            }

            UInt160 accountId = Create(snapshot, 41,
                Install(governance, Validator), Install(member, Validator));
            Assert.AreEqual(2, ModuleCount(snapshot, accountId, "validator"));
            Assert.AreEqual(BigInteger.One, Account(snapshot, accountId)[4].GetInteger(),
                "the atomic group advances the configuration nonce once");
        }

        /// <summary>
        /// The permission matrix: custody still freezes and revokes at
        /// once, but install and an ordinary thaw are governance landings. A
        /// custody witness that is not the bound governance contract cannot
        /// write either, and the governance contract cannot be impersonated by
        /// a bare signer.
        /// </summary>
        [TestMethod]
        public void CustodyCannotLandGovernanceConfiguration()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1101, "validator", governance: true,
                extra: GovernanceSurface);
            var member = Deploy(snapshot, 1102, "validator", member: true);
            UInt160 id = Create(snapshot, 51, Install(governance, Validator));

            using (var custodyInstall = Call(snapshot, "installModule",
                [id, Validator, member.State.Hash, new object[0]]))
            {
                Assert.AreEqual(VMState.FAULT, custodyInstall.State,
                    "a custody witness never lands an install under the current profile");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    custodyInstall.FaultException!.ToString());
            }
            Assert.AreEqual(1, ModuleCount(snapshot, id, "validator"));

            // Freeze is custody-immediate, so the account can always be stopped.
            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], settings: Current);
            Assert.AreEqual((int)SmartAccountStatus.Frozen, Account(snapshot, id)[1].GetInteger());
            using (var custodyThaw = Call(snapshot, "unfreezeAccount", [id]))
            {
                Assert.AreEqual(VMState.FAULT, custodyThaw.State,
                    "an ordinary thaw is a governance landing under the current profile");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    custodyThaw.FaultException!.ToString());
            }
            UT_SmartAccount.Success(snapshot, "govThaw", [id], signers: [],
                target: governance.State.Hash, settings: Current);
            Assert.AreEqual((int)SmartAccountStatus.Active, Account(snapshot, id)[1].GetInteger());

            // Emergency revocation stays immediate, but only the custody
            // witness or the bound governance contract may revoke.
            using (var foreignRevoke = Call(snapshot, "revokeModuleCredentials", [id, 1],
                signers: [ForeignCustody]))
                Assert.AreEqual(VMState.FAULT, foreignRevoke.State);
            UT_SmartAccount.Success(snapshot, "revokeModuleCredentials", [id, 1], settings: Current);
            Assert.AreEqual(new BigInteger(2), Descriptor(snapshot, id, 1)[8].GetInteger(),
                "the custody witness may revoke a credential generation immediately");

            // The bound governance contract lands the install.
            UT_SmartAccount.Success(snapshot, "govInstall", [id, Validator, member.State.Hash, new object[0]],
                signers: [], target: governance.State.Hash, settings: Current);
            Assert.AreEqual(2, ModuleCount(snapshot, id, "validator"));
            Assert.AreEqual(new BigInteger(5), Account(snapshot, id)[4].GetInteger(),
                "each landing advances the configuration nonce exactly once");
            Assert.AreEqual(new BigInteger(3), Account(snapshot, id)[3].GetInteger(),
                "only the thaw advanced the authority epoch");
        }

        /// <summary>
        /// ApplyConfigurationActions is one landing: the batch advances the
        /// configuration nonce once at settlement, never once per action.
        /// </summary>
        [TestMethod]
        public void ApplyConfigurationActionsAdvancesTheNonceOnce()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1201, "validator", governance: true,
                extra: GovernanceSurface);
            var member = Deploy(snapshot, 1202, "validator", member: true);
            var recovery = Deploy(snapshot, 1203, "recovery", extra: RecoverySurface);
            UInt160 id = Create(snapshot, 61, Install(governance, Validator));
            BigInteger before = Account(snapshot, id)[4].GetInteger();

            using (var custodyBatch = Call(snapshot, "applyConfigurationActions",
                [id, new object[] { Install(member, Validator), Install(recovery, Recovery) }]))
            {
                Assert.AreEqual(VMState.FAULT, custodyBatch.State,
                    "a batch is a governance landing too");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    custodyBatch.FaultException!.ToString());
            }

            UT_SmartAccount.Success(snapshot, "govApply",
                [id, new object[] { Install(member, Validator), Install(recovery, Recovery) }],
                signers: [], target: governance.State.Hash, settings: Current);
            Assert.AreEqual(before + 1, Account(snapshot, id)[4].GetInteger(),
                "two actions in one batch consume one configuration step");
            Assert.AreEqual(2, ModuleCount(snapshot, id, "validator"));
            Assert.AreEqual(1, ModuleCount(snapshot, id, "recovery"));
        }

        /// <summary>
        /// Only the installed recovery seat may reset, and only in the epoch it
        /// observed. Custody and the governance contract are not reset
        /// principals; a reset clears every module and nonce row, advances the
        /// epoch and the nonce once, and lands the next governance in the same
        /// transaction.
        /// </summary>
        [TestMethod]
        public void AResetRequiresTheRecoverySeat()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1301, "validator", governance: true,
                extra: GovernanceSurface);
            var recovery = Deploy(snapshot, 1302, "recovery", extra: RecoverySurface);
            UInt160 id = Create(snapshot, 71,
                Install(governance, Validator), Install(recovery, Recovery));
            BigInteger epoch = Account(snapshot, id)[3].GetInteger();
            BigInteger nonce = Account(snapshot, id)[4].GetInteger();

            using (var custody = Call(snapshot, "resetAccount", [id, UInt160.Zero]))
            {
                Assert.AreEqual(VMState.FAULT, custody.State, "custody is not a reset principal");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, custody.FaultException!.ToString());
            }
            using (var governanceReset = Call(snapshot, "govReset", [id, UInt160.Zero],
                target: governance.State.Hash))
            {
                Assert.AreEqual(VMState.FAULT, governanceReset.State,
                    "governance is not a reset principal either");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    governanceReset.FaultException!.ToString());
            }

            // The reset is one transaction: the seat resets and lands the next governance in the same
            // script. A script that ends on the bare reset faults the engine (see
            // AResetWhoseTransactionEndsWithoutAGovernanceFaults).
            UT_SmartAccount.Success(snapshot, "recResetInit", [id, UInt160.Zero,
                new object[] { Install(governance, Validator) }], signers: [],
                target: recovery.State.Hash, settings: Current);
            Array control = Account(snapshot, id);
            Assert.AreEqual((int)SmartAccountStatus.Active, control[1].GetInteger());
            Assert.AreEqual(epoch + 1, control[3].GetInteger(), "the reset advanced the authority epoch");
            Assert.AreEqual(nonce + 1, control[4].GetInteger(), "the reset advanced the nonce exactly once");
            Assert.IsTrue(control[5].GetBoolean() && control[6].GetBoolean());
            // The landing restored the governance under a fresh instance id; the seat itself is not back.
            Assert.IsEmpty(Descriptor(snapshot, id, 1), "the old governance instance is gone");
            Assert.IsEmpty(Descriptor(snapshot, id, 2), "the old recovery instance is gone");
            Assert.AreEqual(1, ModuleCount(snapshot, id, "validator"));
            Assert.AreEqual(0, ModuleCount(snapshot, id, "recovery"));
            Assert.AreEqual(BigInteger.Zero, UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 0, new byte[32]], settings: Current).GetInteger() & ((BigInteger.One << 64) - 1),
                "the reset cleared every nonce row");
        }

        /// <summary>
        /// P-256 is prehashed over the 32-byte digest: the digest is verified
        /// with VerifyHash and never hashed a second time. A signature over the
        /// historical hash-then-sign shape is rejected.
        /// </summary>
        [TestMethod]
        public void TheCustodySignatureIsPrehashedOnly()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            UInt160 id = Create(snapshot, 81);
            object[] unsigned = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], sign: false, settings: Current);
            byte[] digest = UT_SmartAccount.Success(snapshot, "getOperationDigest", [id, unsigned],
                settings: Current).GetSpan().ToArray();
            var key = UT_SmartAccount.CustodyKey;

            byte[] prehashed = UT_SmartAccount.SignPrehashed(key, digest);
            byte[] doubled = Crypto.Sign(digest, key, HashAlgorithm.SHA256);
            Assert.IsTrue(Crypto.CreateECDsa(key.PublicKey).VerifyHash(digest, prehashed),
                "the prehashed vector verifies over the exact digest");
            Assert.IsFalse(Crypto.VerifySignature(digest, prehashed, key.PublicKey, HashAlgorithm.SHA256),
                "the prehashed vector is not a signature over SHA-256(digest)");
            Assert.IsTrue(Crypto.VerifySignature(digest, doubled, key.PublicKey, HashAlgorithm.SHA256),
                "the double-hashed vector is the historical consensus shape");

            using (var accepted = Call(snapshot, "executeUserOp",
                [id, WithSignature(unsigned, UT_SmartAccount.SignatureOver(id, digest, prehashed: true))],
                signers: []))
                Assert.AreEqual(VMState.HALT, accepted.State, accepted.FaultException?.ToString());

            // The accepted call consumed the nonce, so the negative attempt is a
            // fresh operation over the current nonce carrying the historical
            // double-hash signature: the core rejects that signature itself.
            object[] doubleHashed = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], sign: false, settings: Current);
            byte[] doubleDigest = UT_SmartAccount.Success(snapshot, "getOperationDigest", [id, doubleHashed],
                settings: Current).GetSpan().ToArray();
            using (var rejected = Call(snapshot, "executeUserOp",
                [id, WithSignature(doubleHashed,
                    UT_SmartAccount.SignatureOver(id, doubleDigest, prehashed: false))], signers: []))
            {
                Assert.AreEqual(VMState.FAULT, rejected.State,
                    "the historical double-hash signature is not a v4 signature");
                Assert.Contains(SmartAccountModuleProtocol.ErrorValidationRejected,
                    rejected.FaultException!.ToString());
            }
        }

        private static object[] WithSignature(object[] operation, byte[] signature)
        {
            object[] copy = (object[])operation.Clone();
            copy[SmartAccountModuleProtocol.OpSignature] = signature;
            return copy;
        }

        /// <summary>
        /// A configuration landing changes the account model, so every
        /// operation that signed against the previous snapshot is stale: its
        /// configuration nonce no longer matches and it fails closed before
        /// any validation callback runs.
        /// </summary>
        [TestMethod]
        public void AConfigurationChangeInvalidatesThePreviousOperationSnapshot()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1401, "validator", governance: true,
                extra: GovernanceSurface);
            var member = Deploy(snapshot, 1402, "validator", member: true);
            UInt160 id = Create(snapshot, 91, Install(governance, Validator));
            object[] stale = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], prehashed: true, settings: Current);

            UT_SmartAccount.Success(snapshot, "govInstall", [id, Validator, member.State.Hash, new object[0]],
                signers: [], target: governance.State.Hash, settings: Current);

            using (var refused = Call(snapshot, "executeUserOp", [id, stale], signers: []))
            {
                Assert.AreEqual(VMState.FAULT, refused.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorConfigurationNonceStale,
                    refused.FaultException!.ToString());
            }
            object[] fresh = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], prehashed: true, settings: Current);
            using (var accepted = Call(snapshot, "executeUserOp", [id, fresh], signers: []))
                Assert.AreEqual(VMState.HALT, accepted.State, accepted.FaultException?.ToString());
        }

        /// <summary>
        /// The hook plan is a snapshot of the installed hook set taken during
        /// validation: it must name exactly those hooks once. A planner reply
        /// with an id that is not in the snapshot is stale and faults.
        /// </summary>
        [TestMethod]
        public void AStaleHookPlanIsRejected()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1501, "validator", governance: true,
                extra: GovernanceSurface);
            var hook = Deploy(snapshot, 1502, "hook");
            var planner = Deploy(snapshot, 1503, "validator", planner: true,
                plan: b => b.EmitPush(99).EmitPush(1).Emit(OpCode.PACK));
            UInt160 id = Create(snapshot, 101,
                Install(governance, Validator), Install(hook, Hook), Install(planner, Validator));
            BigInteger plannerId = 3;
            BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, plannerId, new byte[32]], settings: Current).GetInteger();
            object[] operation = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], nonce: nonce, sign: false, validatorId: plannerId, settings: Current);
            using var refused = Call(snapshot, "executeUserOp", [id, operation], signers: []);
            Assert.AreEqual(VMState.FAULT, refused.State);
            Assert.Contains(SmartAccountModuleProtocol.ErrorProofInvalid, refused.FaultException!.ToString());
        }

        /// <summary>
        /// ValidateMember is callable only by the routed composite parent. A
        /// direct caller, a validator that is not the active parent and a
        /// non-composite routed validator are all refused, and the parent may
        /// address each member once per operation.
        /// </summary>
        [TestMethod]
        public void ValidateMemberRejectsCallersOutsideTheRoutedComposite()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1601, "validator", governance: true,
                extra: GovernanceSurface);
            var member = Deploy(snapshot, 1602, "validator", member: true);
            var composite = Deploy(snapshot, 1603, "validator", composite: true,
                validate: MemberCall(2));
            var impostor = Deploy(snapshot, 1604, "validator", validate: MemberCall(2));
            UInt160 id = Create(snapshot, 111,
                Install(governance, Validator), Install(member, Validator),
                Install(composite, Validator), Install(impostor, Validator));

            // A bare caller has no operation and no phase grant at all.
            using (var direct = Call(snapshot, "validateMember",
                [id, 2, new byte[32], new object[0]], signers: [UT_SmartAccount.Custody]))
            {
                Assert.AreEqual(VMState.FAULT, direct.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized,
                    direct.FaultException!.ToString());
            }

            // A routed validator that is not composite may not address members.
            BigInteger impostorNonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 4, new byte[32]], settings: Current).GetInteger();
            object[] impostorOp = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], nonce: impostorNonce, sign: false, validatorId: 4, settings: Current);
            using (var refused = Call(snapshot, "executeUserOp", [id, impostorOp], signers: []))
            {
                Assert.AreEqual(VMState.FAULT, refused.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, refused.FaultException!.ToString());
            }

            // The routed composite parent validates its leaf member once.
            BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 3, new byte[32]], settings: Current).GetInteger();
            object[] operation = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], nonce: nonce, sign: false, validatorId: 3, settings: Current);
            using (var accepted = Call(snapshot, "executeUserOp", [id, operation], signers: []))
                Assert.AreEqual(VMState.HALT, accepted.State, accepted.FaultException?.ToString());

            // A second landing for the same member in one operation is refused.
            var twice = Deploy(snapshot, 1605, "validator", composite: true, validate: MemberCall(2, times: 2));
            UInt160 twiceId = Create(snapshot, 112,
                Install(governance, Validator), Install(member, Validator), Install(twice, Validator));
            BigInteger twiceNonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [twiceId, 3, new byte[32]], settings: Current).GetInteger();
            object[] twiceOp = UT_SmartAccount.Operation(snapshot, twiceId, NativeContract.StdLib.Hash,
                "serialize", [7], nonce: twiceNonce, sign: false, validatorId: 3, settings: Current);
            using (var refused = Call(snapshot, "executeUserOp", [twiceId, twiceOp], signers: []))
            {
                Assert.AreEqual(VMState.FAULT, refused.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorOperationMalformed,
                    refused.FaultException!.ToString());
            }
        }

        /// <summary>
        /// The declared system fee is the envelope of every callback. A validator that spends past it — a leaf
        /// member, or the composite it is routed through — is cut off by the engine. The overrun fails the
        /// operation closed on the validation query and the execution entry alike, and nothing moves: neither the
        /// nonce nor a success event.
        /// </summary>
        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void AValidatorThatExhaustsTheDeclaredFeeFailsClosed(bool overspendingComposite)
        {
            const long declared = 1_000_000_000;
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1611, "validator", governance: true, extra: GovernanceSurface);
            Module leaf = Deploy(snapshot, 1612, "validator", member: true, validate: Burn(2 * declared));
            Module composite = Deploy(snapshot, 1613, "validator", composite: true,
                validate: overspendingComposite ? Burn(2 * declared) : MemberCall(2));
            List<object[]> installs = [Install(governance, Validator)];
            if (!overspendingComposite) installs.Add(Install(leaf, Validator));
            installs.Add(Install(composite, Validator));
            UInt160 id = Create(snapshot, 113, installs.ToArray());
            // The routed composite is instance 2 without the leaf, 3 with it.
            BigInteger routed = overspendingComposite ? 2 : 3;
            BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, routed, new byte[32]], settings: Current).GetInteger();
            object[] operation = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], nonce: nonce, sign: false, validatorId: routed, settings: Current);

            foreach (string entry in new[] { "validateUserOp", "executeUserOp" })
            {
                using var faulted = UT_SmartAccount.Invoke(snapshot, entry, [id, operation], signers: [], gas: declared);
                Assert.AreEqual(VMState.FAULT, faulted.State, $"{entry} consumed {faulted.FeeConsumed} result={faulted.ResultStack[0]}");
                Assert.AreEqual("Insufficient GAS.", faulted.FaultException!.GetBaseException().Message);
                Assert.AreEqual(0, faulted.Notifications.Count(n => n.EventName == "UserOpExecuted"));
            }
            Assert.AreEqual(nonce, UT_SmartAccount.Success(snapshot, "getNonce",
                [id, routed, new byte[32]], settings: Current).GetInteger(), "the nonce did not move");
        }

        /// <summary>
        /// One operation is one consensus unit: a failing operation reverts every
        /// write it made, including the nonce it was about to consume, and no
        /// success event escapes.
        /// </summary>
        [TestMethod]
        public void AFaultingOperationRollsBackEveryWrite()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            UInt160 id = Create(snapshot, 121);
            BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 0, new byte[32]], settings: Current).GetInteger();
            object[] operation = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], nonce: nonce, sign: false, settings: Current);
            operation[SmartAccountModuleProtocol.OpSignature] = new byte[] { 0x01 };

            using var failed = Call(snapshot, "executeUserOp", [id, operation], signers: []);
            Assert.AreEqual(VMState.FAULT, failed.State);
            Assert.Contains(SmartAccountModuleProtocol.ErrorValidationRejected,
                failed.FaultException!.ToString());
            Assert.AreEqual(nonce, UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 0, new byte[32]], settings: Current).GetInteger(),
                "the fault reverted the nonce the operation was going to consume");
            Assert.AreEqual(0, failed.Notifications.Count(n => n.EventName == "UserOpExecuted"));
        }

        /// <summary>
        /// The account lease is non-reentrant: a target that calls back into
        /// executeUserOp for the account it is running under faults the whole
        /// operation, whether the reentry names the same or another account.
        /// </summary>
        [TestMethod]
        public void ATargetReentryIsRejected()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            UInt160 id = Create(snapshot, 131);
            UInt160 reenter = DeployReentry(snapshot);
            object[] inner = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], prehashed: true, settings: Current);
            object[] operation = UT_SmartAccount.Operation(snapshot, id, reenter, "reenter",
                [id, inner], prehashed: true, settings: Current);
            using var refused = Call(snapshot, "executeUserOp", [id, operation], signers: []);
            Assert.AreEqual(VMState.FAULT, refused.State);
            Assert.Contains(SmartAccountModuleProtocol.ErrorReentrancyForbidden,
                refused.FaultException!.ToString());
        }

        /// <summary>
        /// A legal ten-member composite previews and executes: the routed composite validates its ten nested leaf
        /// members through validateMember, and the preview leaves the nonce cursor alone while the execution
        /// advances it exactly once.
        /// </summary>
        [TestMethod]
        public void ALegalTenMemberCompositePreviewsAndExecutes()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1631, "validator", governance: true, extra: GovernanceSurface);
            List<object[]> installs = [Install(governance, Validator)];
            for (int i = 0; i < 10; i++)
                installs.Add(Install(Deploy(snapshot, 1632 + i, "validator", member: true), Validator));
            Action<ScriptBuilder> tenMembers = b =>
            {
                for (int member = 2; member <= 11; member++)
                {
                    if (member > 2) b.Emit(OpCode.DROP);
                    b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).EmitPush(member).Emit(OpCode.LDARG0);
                    b.EmitPush(4).Emit(OpCode.PACK)
                        .EmitPush((int)CallFlags.All).EmitPush("validateMember")
                        .EmitPush(NativeContract.SmartAccount.Hash)
                        .EmitSysCall(ApplicationEngine.System_Contract_Call);
                }
            };
            Module composite = Deploy(snapshot, 1642, "validator", composite: true, validate: tenMembers);
            installs.Add(Install(composite, Validator));
            UInt160 id = Create(snapshot, 152, installs.ToArray());
            Assert.HasCount(12, (Array)((Array)UT_SmartAccount.Success(snapshot, "getModules",
                [id, "validator", 0, 32], settings: Current))[0]);
            BigInteger routed = 12;
            BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, routed, new byte[32]], settings: Current).GetInteger();
            object[] operation = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], nonce: nonce, sign: false, validatorId: routed, settings: Current);

            var preview = (Array)UT_SmartAccount.Success(snapshot, "validateUserOp", [id, operation],
                settings: Current);
            Assert.IsTrue(preview[0].GetBoolean(), "the ten-member composite is a legal preview");
            Assert.AreEqual(nonce, UT_SmartAccount.Success(snapshot, "getNonce",
                [id, routed, new byte[32]], settings: Current).GetInteger(), "the preview left the shadow cursor alone");

            using (var executed = Call(snapshot, "executeUserOp", [id, operation], signers: []))
            {
                Assert.AreEqual(VMState.HALT, executed.State, executed.FaultException?.ToString());
                Assert.HasCount(1, executed.Notifications.Where(n => n.EventName == "UserOpExecuted"));
            }
            Assert.AreEqual(nonce + 1, UT_SmartAccount.Success(snapshot, "getNonce",
                [id, routed, new byte[32]], settings: Current).GetInteger(),
                "the execution advanced the cursor exactly once");
        }

        /// <summary>
        /// The restricted post-reset initialization: the seat that reset lands one
        /// install-only composition in the same transaction, which restores a
        /// usable module set under fresh instance ids — including the seat and a
        /// code-bound governance validator — while the reset alone advanced the
        /// epoch, the configuration nonce and the control revision, each once.
        /// </summary>
        [TestMethod]
        public void AResetInitializationLandsOneUsableComposition()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 2201, "validator", governance: true, extra: GovernanceSurface);
            var member = Deploy(snapshot, 2202, "validator", member: true);
            var hook = Deploy(snapshot, 2203, "hook");
            var recovery = Deploy(snapshot, 2204, "recovery", extra: RecoverySurface);
            var extra = Deploy(snapshot, 2205, "validator", member: true);
            UInt160 id = Create(snapshot, 171,
                Install(governance, Validator), Install(recovery, Recovery));
            Array before = Account(snapshot, id);
            BigInteger epoch = before[3].GetInteger();
            BigInteger nonce = before[4].GetInteger();
            BigInteger revision = before[8].GetInteger();
            BigInteger channel = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 0, new byte[32]], settings: Current).GetInteger() >> 64;

            object[] composition =
            [
                Install(governance, Validator), Install(member, Validator),
                Install(hook, Hook), Install(recovery, Recovery),
            ];
            UT_SmartAccount.Success(snapshot, "recResetInit", [id, ForeignCustody, composition],
                signers: [], target: recovery.State.Hash, settings: Current);

            Array after = Account(snapshot, id);
            Assert.AreEqual((int)SmartAccountStatus.Active, after[1].GetInteger());
            Assert.AreEqual(ForeignCustody, new UInt160(after[2].GetSpan()), "the reset installed the new custody");
            Assert.AreEqual(epoch + 1, after[3].GetInteger(), "the reset advanced the authority epoch exactly once");
            Assert.AreEqual(nonce + 1, after[4].GetInteger(),
                "the restricted landing consumed no second configuration step");
            Assert.AreEqual(revision + 1, after[8].GetInteger(),
                "the control revision moved exactly once");
            Assert.IsTrue(after[5].GetBoolean() && after[6].GetBoolean());
            Assert.AreEqual(BigInteger.Zero, after[7].GetInteger());

            // Every old instance id is retired; the composition landed under fresh ids.
            Assert.IsEmpty(Descriptor(snapshot, id, 1), "the old governance instance is gone");
            Assert.IsEmpty(Descriptor(snapshot, id, 2), "the old recovery instance is gone");
            Assert.AreEqual(governance.State.Hash, new UInt160(Descriptor(snapshot, id, 3)[2].GetSpan()));
            Assert.AreEqual((BigInteger)Validator, Descriptor(snapshot, id, 3)[1].GetInteger());
            Assert.IsTrue(Descriptor(snapshot, id, 3)[13].GetBoolean(), "the restored governance keeps its capability");
            Assert.AreEqual(BigInteger.One, Descriptor(snapshot, id, 3)[8].GetInteger(),
                "a reinstalled instance starts at credential generation 1");
            Assert.AreEqual(member.State.Hash, new UInt160(Descriptor(snapshot, id, 4)[2].GetSpan()));
            Assert.AreEqual(hook.State.Hash, new UInt160(Descriptor(snapshot, id, 5)[2].GetSpan()));
            Assert.AreEqual(recovery.State.Hash, new UInt160(Descriptor(snapshot, id, 6)[2].GetSpan()));
            Assert.AreEqual(2, ModuleCount(snapshot, id, "validator"));
            Assert.AreEqual(1, ModuleCount(snapshot, id, "hook"));
            Assert.AreEqual(1, ModuleCount(snapshot, id, "recovery"));

            // The reset cleared every nonce row: the old channel restarts at sequence 0.
            Assert.AreEqual(BigInteger.Zero, UT_SmartAccount.Success(snapshot, "getNonceSequence",
                [id, channel], settings: Current).GetInteger(), "the reset deleted every nonce cursor row");

            // The account is immediately governable through the restored composition.
            UT_SmartAccount.Success(snapshot, "govInstall",
                [id, Validator, extra.State.Hash, new object[0]],
                signers: [], target: governance.State.Hash, settings: Current);
            Assert.AreEqual(3, ModuleCount(snapshot, id, "validator"));
            Assert.AreEqual(nonce + 2, Account(snapshot, id)[4].GetInteger(),
                "the restored governance lands one ordinary configuration per step");
        }

        /// <summary>
        /// The restricted initialization cannot be widened: non-install actions are
        /// refused at the entry, a composition without a governance-capable
        /// validator is refused at the landing, the claim never outlives its single
        /// use, and any refusal rolls the reset back with the whole transaction.
        /// </summary>
        [TestMethod]
        public void ARestrictedInitializationCannotLandAnythingButInstalls()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 2301, "validator", governance: true, extra: GovernanceSurface);
            var member = Deploy(snapshot, 2302, "validator", member: true);
            var recovery = Deploy(snapshot, 2303, "recovery", extra: RecoverySurface);
            UInt160 id = Create(snapshot, 181,
                Install(governance, Validator), Install(recovery, Recovery));
            Array before = Account(snapshot, id);
            BigInteger epoch = before[3].GetInteger();
            BigInteger nonce = before[4].GetInteger();

            object[][] refused =
            [
                [2, 1, new object[0]],                                          // uninstall
                [3, 1, new object[0]],                                          // configure
                [5, true, true],                                                // built-in switches
                [7, 1, true],                                                   // required-validator pin
                Install(member, Validator),                                    // no governance left
            ];
            foreach (object[] action in refused)
            {
                using var landed = Call(snapshot, "recResetInit",
                    [id, ForeignCustody, new object[] { action }], signers: [], target: recovery.State.Hash);
                Assert.AreEqual(VMState.FAULT, landed.State, $"action {action[0]} must not land after a reset");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, landed.FaultException!.ToString(),
                    $"action {action[0]} must be refused as unauthorized: {landed.FaultException}");
                Array after = Account(snapshot, id);
                Assert.AreEqual(epoch, after[3].GetInteger(), "the refused landing rolled the reset back");
                Assert.AreEqual(nonce, after[4].GetInteger());
                Assert.AreEqual(UT_SmartAccount.Custody, new UInt160(after[2].GetSpan()));
                Assert.AreEqual(1, ModuleCount(snapshot, id, "validator"), "the old composition survives the fault");
                Assert.AreEqual(1, ModuleCount(snapshot, id, "recovery"));
            }

            // Without a preceding reset in this engine there is no claim at all.
            using (var noClaim = Call(snapshot, "recApply",
                [id, new object[] { Install(member, Validator) }], signers: [], target: recovery.State.Hash))
            {
                Assert.AreEqual(VMState.FAULT, noClaim.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, noClaim.FaultException!.ToString());
            }

            // The claim is single-use inside the engine: the second landing is ordinary
            // configuration and the seat is not a governance caller.
            using (var twice = Call(snapshot, "recApplyTwice",
                [id, ForeignCustody, new object[] { Install(member, Validator) },
                    new object[] { Install(member, Validator) }],
                signers: [], target: recovery.State.Hash))
            {
                Assert.AreEqual(VMState.FAULT, twice.State, "a single reset opens a single initialization");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, twice.FaultException!.ToString());
            }
            Assert.AreEqual(epoch, Account(snapshot, id)[3].GetInteger());
        }

        /// <summary>
        /// The reset is one transaction. The seat removes every instance, including the
        /// governance one every later configuration entry needs, so a script that ends
        /// on the bare reset faults when it halts and nothing of the reset survives: no
        /// custody rotation, no epoch or nonce step, no lost instance and no event. The
        /// same seat with the landing in the same script is the designed flow and
        /// commits; the account is governable again right after it.
        /// </summary>
        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void AResetWhoseTransactionEndsWithoutAGovernanceFaults(bool huyao)
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var settings = Engine(huyao);
            var governance = Deploy(snapshot, 2401, "validator", governance: true, extra: GovernanceSurface);
            var member = Deploy(snapshot, 2402, "validator", member: true);
            var recovery = Deploy(snapshot, 2403, "recovery", extra: RecoverySurface);
            UInt160 id = Create(snapshot, 191, Install(governance, Validator), Install(recovery, Recovery));
            Array before = Account(snapshot, id);

            // The platform commits the snapshot of an engine only for a halting run; here
            // that layer is a clone, so the base is what the chain would keep.
            using (var bare = UT_SmartAccount.Invoke(snapshot.CloneCache(), "recReset", [id, ForeignCustody],
                signers: [], target: recovery.State.Hash, settings: settings))
            {
                Assert.AreEqual(VMState.FAULT, bare.State, "a transaction that ends on a reset has no governance left");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, bare.FaultException!.ToString());
                Assert.IsEmpty(bare.Notifications, "no event of the rolled-back reset escapes");
            }
            Array rolled = Account(snapshot, id);
            Assert.AreEqual(new UInt160(before[2].GetSpan()), new UInt160(rolled[2].GetSpan()),
                "the custody rotation was rolled back");
            Assert.AreEqual(before[3].GetInteger(), rolled[3].GetInteger(), "the authority epoch was rolled back");
            Assert.AreEqual(before[4].GetInteger(), rolled[4].GetInteger(), "the nonce was rolled back");
            Assert.AreEqual(1, ModuleCount(snapshot, id, "validator"), "the old governance survived");
            Assert.AreEqual(1, ModuleCount(snapshot, id, "recovery"), "the old seat survived");

            UT_SmartAccount.Success(snapshot, "recResetInit", [id, ForeignCustody,
                new object[] { Install(governance, Validator) }], signers: [], target: recovery.State.Hash,
                settings: settings);
            Array landed = Account(snapshot, id);
            Assert.AreEqual(ForeignCustody, new UInt160(landed[2].GetSpan()), "the landed reset rotated the custody");
            Assert.AreEqual(before[3].GetInteger() + 1, landed[3].GetInteger(),
                "the reset and its landing are one authority step");
            Assert.AreEqual(before[4].GetInteger() + 1, landed[4].GetInteger(),
                "the reset and its landing are one configuration step");
            Assert.AreEqual(1, ModuleCount(snapshot, id, "validator"), "the landed governance is the only instance");
            UT_SmartAccount.Success(snapshot, "govApply", [id, new object[] { Install(member, Validator) }],
                signers: [], target: governance.State.Hash, settings: settings);
            Assert.AreEqual(2, ModuleCount(snapshot, id, "validator"), "the landed governance configures the account");
        }

        /// <summary>
        /// The governance validator has to be there when the script ends, not only
        /// when the landing passes: a governance contract that the landed composition
        /// removes again in the same transaction leaves the same dead end, so the
        /// engine faults there as well. A second reset of the account in one engine is
        /// refused up front.
        /// </summary>
        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void AGovernanceRemovedAfterTheLandingFaultsTheTransaction(bool huyao)
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var settings = Engine(huyao);
            var governance = Deploy(snapshot, 2411, "validator", governance: true, extra: GovernanceSurface);
            var recovery = Deploy(snapshot, 2412, "recovery", extra: RecoverySurface);
            UInt160 id = Create(snapshot, 201, Install(governance, Validator), Install(recovery, Recovery));
            Array before = Account(snapshot, id);

            // One script, two calls: the seat lands the governance as instance 3, then that
            // governance uninstalls itself. The landing passes; the end of the script does not.
            var tx = new Transaction
            {
                Version = 0, Signers = [], Attributes = [], Witnesses = [],
                Script = Script(
                    (recovery.State.Hash, "recResetInit", [id, UInt160.Zero,
                        new object[] { Install(governance, Validator) }]),
                    (governance.State.Hash, "govApply", [id, new object[]
                    {
                        new object[] { SmartAccountModuleProtocol.ActionUninstallModule, 3, new object[0] },
                    }])),
            };
            using var emptied = Run(snapshot.CloneCache(), tx, settings, 10_000_000_000);
            Assert.AreEqual(VMState.FAULT, emptied.State,
                $"the governance left with the script still running: {emptied.FaultException}");
            Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, emptied.FaultException!.ToString());
            Array after = Account(snapshot, id);
            Assert.AreEqual(before[3].GetInteger(), after[3].GetInteger(), "the reset was rolled back");
            Assert.AreEqual(before[4].GetInteger(), after[4].GetInteger());
            Assert.AreEqual(1, ModuleCount(snapshot, id, "validator"), "the old governance survived");
            Assert.AreEqual(1, ModuleCount(snapshot, id, "recovery"), "the old seat survived");

            using (var twice = Call(snapshot, "recResetTwice", [id, UInt160.Zero,
                new object[] { Install(governance, Validator), Install(recovery, Recovery) }],
                signers: [], target: recovery.State.Hash))
            {
                Assert.AreEqual(VMState.FAULT, twice.State, "one reset per account and engine");
                Assert.Contains(SmartAccountModuleProtocol.ErrorPhaseViolation, twice.FaultException!.ToString());
            }
            Assert.AreEqual(before[3].GetInteger(), Account(snapshot, id)[3].GetInteger(),
                "the refused second reset rolled the first one back");
        }

        /// <summary>The application script of consecutive contract calls, arguments pushed as a client pushes them.</summary>
        private static byte[] Script(params (UInt160 Target, string Method, object[] Arguments)[] calls)
        {
            using ScriptBuilder builder = new();
            foreach (var (target, method, arguments) in calls)
            {
                Push(builder, arguments);
                builder.EmitPush((int)CallFlags.All).EmitPush(method).EmitPush(target)
                    .EmitSysCall(ApplicationEngine.System_Contract_Call);
            }
            return builder.ToArray();
        }

        private static void Push(ScriptBuilder builder, object value)
        {
            if (value is object[] items)
            {
                for (int i = items.Length - 1; i >= 0; i--) Push(builder, items[i]);
                builder.EmitPush(items.Length).Emit(OpCode.PACK);
            }
            else builder.EmitPush(value);
        }

        /// <summary>
        /// After activation one ordinary configuration lane exists: the currently
        /// installed, code-bound governance contract. Custody is not that lane, a
        /// plain (non-governance) validator instance is not that lane, a governance
        /// contract whose code binding drifted is not that lane, and a frozen
        /// account refuses the write before any of them.
        /// </summary>
        [TestMethod]
        public void AnOrdinaryLandingNeedsTheBoundCodeGovernanceCaller()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 2401, "validator", governance: true, extra: GovernanceSurface);
            var plain = Deploy(snapshot, 2402, "validator", extra: GovernanceSurface);
            var hook = Deploy(snapshot, 2403, "hook");
            UInt160 id = Create(snapshot, 191,
                Install(governance, Validator), Install(plain, Validator));

            using (var custody = Call(snapshot, "govInstall",
                [id, Validator, hook.State.Hash, new object[0]], target: plain.State.Hash))
            {
                Assert.AreEqual(VMState.FAULT, custody.State, "a plain validator instance is not the governance lane");
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, custody.FaultException!.ToString());
            }
            using (var plainApply = Call(snapshot, "govApply",
                [id, new object[] { Install(hook, Hook) }], target: plain.State.Hash))
            {
                Assert.AreEqual(VMState.FAULT, plainApply.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, plainApply.FaultException!.ToString());
            }
            Assert.AreEqual(0, ModuleCount(snapshot, id, "hook"));

            // A governance contract that was updated after install no longer binds.
            var key = new KeyBuilder(NativeContract.ContractManagement.Id, 8).Add(governance.State.Hash);
            snapshot.GetAndChange(key)!.GetInteroperable<ContractState>().UpdateCounter++;
            using (var stale = Call(snapshot, "govInstall",
                [id, Validator, hook.State.Hash, new object[0]], target: governance.State.Hash))
            {
                Assert.AreEqual(VMState.FAULT, stale.State, "a drifted governance binding loses the lane");
                Assert.Contains(SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch,
                    stale.FaultException!.ToString());
            }

            // A frozen account refuses the landing before the caller question.
            UT_SmartAccount.Success(snapshot, "freezeAccount", [id], settings: Current);
            using (var frozen = Call(snapshot, "govApply",
                [id, new object[] { Install(hook, Hook) }], target: governance.State.Hash))
            {
                Assert.AreEqual(VMState.FAULT, frozen.State, "a frozen account accepts no configuration");
                Assert.Contains(SmartAccountModuleProtocol.ErrorAccountFrozen, frozen.FaultException!.ToString());
            }
            Assert.AreEqual(0, ModuleCount(snapshot, id, "hook"));
        }

        /// <summary>
        /// A validator is asked to approve an operation from a read-only frame inside the account it
        /// validates. A validator that tries to execute the operation it is approving is refused before
        /// the core runs it: nothing is executed and no nonce moves. The proxy witness is admissibility
        /// only, so it neither runs the validator nor depends on it: the transaction carrying the operation
        /// passes the witness verification of the node under the platform cap.
        /// </summary>
        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void AValidatorCannotExecuteTheOperationItValidates(bool witnessCheck)
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            Module greedy = Deploy(snapshot, 1661, "validator", validate: b =>
            {
                b.Emit(OpCode.LDARG0).Emit(OpCode.LDARG2);
                CoreCallVoid(b, "executeUserOp", 2);
                b.EmitPush(true);
            });
            UInt160 id = Create(snapshot, 141, Install(greedy, Validator));
            BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 1, new byte[32]], settings: Current).GetInteger();
            object[] operation = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], nonce: nonce, sign: false, validatorId: 1, settings: Current,
                deadline: BigInteger.One << 62);
            Transaction tx = Envelope(snapshot, id, operation);

            if (witnessCheck)
                PassesWitnessVerification(snapshot, tx, id, Current);
            using var engine = UT_SmartAccount.Invoke(snapshot, tx);
            Assert.AreEqual(VMState.FAULT, engine.State, "the validator executed the operation itself");
            Assert.Contains("Cannot call this method with the flag", engine.FaultException!.GetBaseException().Message);
            Assert.AreEqual(0, engine.Notifications.Count(n => n.EventName == "UserOpExecuted"));
            Assert.AreEqual(nonce, UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 1, new byte[32]], settings: Current).GetInteger(), "no operation ran");
        }

        /// <summary>
        /// A lifecycle callback runs while its entry holds the account: an install whose own onInstall
        /// tries to land a second module is re-entry and fails with SA_REENTRANCY_FORBIDDEN, taking
        /// the outer landing down with it.
        /// </summary>
        [TestMethod]
        public void ALifecycleCallbackCannotLandAConfiguration()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1662, "validator", governance: true, extra: GovernanceSurface);
            Module hook = Deploy(snapshot, 1663, "hook");
            Module greedy = Deploy(snapshot, 1664, "validator", install: b =>
            {
                b.Emit(OpCode.LDARG3).EmitPush(hook.State.Hash.ToArray()).EmitPush(Hook).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "installModule", 4);
            });
            UInt160 id = Create(snapshot, 142, Install(governance, Validator));

            using var refused = Call(snapshot, "govInstall",
                [id, Validator, greedy.State.Hash, new object[0]], signers: [], target: governance.State.Hash);
            Assert.AreEqual(VMState.FAULT, refused.State);
            Assert.Contains(SmartAccountModuleProtocol.ErrorReentrancyForbidden,
                refused.FaultException!.ToString());
            Assert.AreEqual(1, ModuleCount(snapshot, id, "validator"), "neither the module nor its nested install landed");
            Assert.AreEqual(0, ModuleCount(snapshot, id, "hook"));
        }

        /// <summary>
        /// Two operations of one account in one entry script. Each releases the account before the next
        /// one enters, so both execute and each consumes its own nonce. The declared system fee is one
        /// envelope for the whole transaction: once the callbacks of both operations spend past it, the
        /// second one faults and the whole transaction, the first operation included, is rolled back.
        /// </summary>
        [TestMethod]
        public void TwoSequentialOperationsEachConsumeANonceAndShareTheDeclaredFee()
        {
            // Every hook burns the same amount in its pre and its post callback: 2 GAS per callback.
            const long perCallback = 2_000_000_000;
            const long declared = 40_000_000_000;
            // 4 hooks: 16 callbacks, 32 GAS in all, inside the declared fee. 8 hooks: the second
            // operation reaches the declared fee after the first one spent 32 GAS on its own.
            foreach (var (hooks, lands) in new[] { (4, true), (8, false) })
            {
                var snapshot = UT_SmartAccount.Snapshot(Current);
                List<object[]> installs = [];
                for (int i = 0; i < hooks; i++)
                    installs.Add(Install(Deploy(snapshot, 1670 + i, "hook",
                        preCheck: b => { Burn(perCallback)(b); b.EmitPush(new byte[] { 17 }); },
                        postCheck: Burn(perCallback)), Hook));
                UInt160 id = Create(snapshot, 143, installs.ToArray());
                BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                    [id, 0, new byte[32]], settings: Current).GetInteger();
                object[] first = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                    "serialize", [7], settings: Current);
                object[] second = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                    "serialize", [8], nonce: nonce + 1, settings: Current);

                using var engine = UT_SmartAccount.Invoke(snapshot, Envelopes(id, first, second), gas: declared);
                int executed = engine.Notifications.Count(n => n.EventName == "UserOpExecuted");
                BigInteger after = UT_SmartAccount.Success(snapshot, "getNonce",
                    [id, 0, new byte[32]], settings: Current).GetInteger();
                if (lands)
                {
                    Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
                    Assert.AreEqual(2, executed);
                    Assert.AreEqual(nonce + 2, after, "each operation consumed exactly one nonce");
                    Assert.IsLessThan(declared, engine.FeeConsumed, "the transaction is charged what it consumed");
                    continue;
                }
                Assert.AreEqual(VMState.FAULT, engine.State, "the hooks of the second operation exhausted the declared fee");
                Assert.AreEqual("Insufficient GAS.", engine.FaultException!.GetBaseException().Message);
                Assert.AreEqual(0, executed);
                // The platform counts the refused callback itself in what it reports, then stops: nothing follows it.
                Assert.IsLessThan(declared + perCallback + 100_000_000L, engine.FeeConsumed,
                    "the engine stopped once the declared system fee was spent");
                Assert.AreEqual(nonce, after, "the fault rolled both operations back");
            }
        }

        /// <summary>
        /// A target that faults ends the operation where it stands: the nonce the operation had
        /// consumed is rolled back with it and no success event escapes.
        /// </summary>
        [TestMethod]
        public void ATargetFaultEmitsNoUserOpExecuted()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            Module failing = Deploy(snapshot, 1691, "recovery",
                extra: add => add("boom", ContractParameterType.Void, b => b.Emit(OpCode.ABORT), []));
            UInt160 id = Create(snapshot, 144);
            BigInteger nonce = UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 0, new byte[32]], settings: Current).GetInteger();
            object[] operation = UT_SmartAccount.Operation(snapshot, id, failing.State.Hash, "boom", [],
                nonce: nonce, settings: Current);

            using var faulted = Call(snapshot, "executeUserOp", [id, operation], signers: []);
            Assert.AreEqual(VMState.FAULT, faulted.State);
            Assert.Contains("ABORT is executed.", faulted.FaultException!.GetBaseException().Message);
            Assert.IsEmpty(faulted.Notifications, "a fault publishes nothing, UserOpExecuted included");
            Assert.AreEqual(nonce, UT_SmartAccount.Success(snapshot, "getNonce",
                [id, 0, new byte[32]], settings: Current).GetInteger(),
                "the nonce consumed before the dispatch was rolled back");
        }

        // ===================================================================== 11. The declared system fee and the
        // witness check ==========================================================================

        private static ProtocolSettings Engine(bool huyao) => Current with
        {
            Hardforks = Current.Hardforks.SetItem(Hardfork.HF_Huyao, huyao ? 0U : uint.MaxValue)
        };

        private static readonly UInt160 Gas = NativeContract.GAS.Hash;
        private static readonly UInt160 Recipient = UInt160.Parse("0x0505050505050505050505050505050505050505");

        private static ApplicationEngine Run(DataCache snapshot, Transaction tx, ProtocolSettings settings, long gas,
            IDiagnostic diagnostic = null)
        {
            var engine = ApplicationEngine.Create(TriggerType.Application, tx, snapshot, new Block
            {
                Header = new Header
                {
                    Index = 1,
                    Timestamp = 1000,
                    PrevHash = UInt256.Zero,
                    MerkleRoot = UInt256.Zero,
                    NextConsensus = UInt160.Zero,
                    Witness = new Witness { InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = ReadOnlyMemory<byte>.Empty }
                },
                Transactions = []
            }, settings, gas: gas, diagnostic: diagnostic);
            engine.LoadScript(tx.Script);
            engine.Execute();
            return engine;
        }

        /// <summary> Funds the proxy address of the account with 7 GAS from the committee. </summary>
        private static void Fund(DataCache snapshot, UInt160 id)
        {
            UInt160 funder = Contract.GetBFTAddress(Current.StandbyValidators);
            UT_SmartAccount.Success(snapshot, "transfer",
                [funder, SmartAccountProtocol.GetAccountAddress(id), 7, null], signers: [funder], target: Gas);
        }

        private static BigInteger Balance(DataCache snapshot, UInt160 owner) =>
            UT_SmartAccount.Success(snapshot, "balanceOf", [owner], target: Gas).GetInteger();

        private static BigInteger Nonce(DataCache snapshot, UInt160 id, BigInteger routed) =>
            UT_SmartAccount.Success(snapshot, "getNonce", [id, routed, new byte[32]], settings: Current).GetInteger();

        /// <summary> The transaction a client sends: the payer wallet first, the account proxy second with the proxy
        /// witness; the script is the canonical envelope. </summary>
        private static Transaction Envelope(DataCache snapshot, UInt160 id, object[] operation)
        {
            Transaction tx = Envelopes(id, operation);
            tx.Script = SmartAccountTestSupport.ExecuteUserOp(id, Item(operation));
            tx.Signers =
            [
                tx.Signers[0],
                new Signer { Account = SmartAccountProtocol.GetAccountAddress(id), Scopes = WitnessScope.Global },
            ];
            Sign(tx, id);
            return tx;
        }

        /// <summary> The custody witness of the payer and the proxy witness of the account. </summary>
        private static void Sign(Transaction tx, UInt160 id)
        {
            using var builder = new ScriptBuilder();
            builder.EmitPush(Neo.Cryptography.Crypto.Sign(tx.GetSignData(Current.Network), UT_SmartAccount.CustodyKey,
                Neo.Cryptography.HashAlgorithm.SHA256));
            tx.Witnesses =
            [
                new Witness
                {
                    InvocationScript = builder.ToArray(),
                    VerificationScript = Contract.CreateSignatureRedeemScript(UT_SmartAccount.CustodyKey.PublicKey).ToArray(),
                },
                new Witness
                {
                    InvocationScript = ReadOnlyMemory<byte>.Empty,
                    VerificationScript = SmartAccountProtocol.CreateVerificationScript(id).ToArray(),
                },
            ];
        }

        /// <summary>
        /// The real witness path of a node with its default settings. A wallet quotes the network fee by
        /// executing every witness under the platform verification cap; the fee is part of the signing data,
        /// so the payer signs last. The state-independent verification then runs both witnesses through
        /// <see cref="Transaction.VerifyWitnesses"/> under the same cap. Returns the GAS of the proxy witness
        /// engine.
        /// </summary>
        private static long PassesWitnessVerification(DataCache snapshot, Transaction tx, UInt160 id, ProtocolSettings settings)
        {
            tx.NetworkFee = Neo.Wallets.Helper.CalculateNetworkFee(tx, snapshot, settings);
            Sign(tx, id);
            Assert.AreEqual(VerifyResult.Succeed, tx.VerifyStateIndependent(settings));
            Assert.IsTrue(tx.VerifyWitnesses(settings, snapshot, Neo.SmartContract.Helper.MaxVerificationGas),
                "the node accepts both witnesses under the platform cap");
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            Assert.IsTrue(Neo.SmartContract.Helper.VerifyWitness(tx, settings, snapshot, address, tx.Witnesses[1],
                Neo.SmartContract.Helper.MaxVerificationGas, out long fee), "the proxy witness passes under the platform cap");
            Assert.IsLessThan(Neo.SmartContract.Helper.MaxVerificationGas, fee);
            return fee;
        }

        private static void AssertTransferRolledBack(DataCache snapshot, UInt160 id, BigInteger routed, BigInteger nonce,
            ApplicationEngine engine)
        {
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            Assert.AreEqual(0, Balance(snapshot, Recipient));
            Assert.AreEqual(7, Balance(snapshot, address));
            Assert.AreEqual(nonce, Nonce(snapshot, id, routed), "the nonce did not move");
            Assert.AreEqual(0, engine.Notifications.Count(n => n.EventName == "UserOpExecuted"));
        }

        /// <summary>
        /// A module-routed account passes the proxy witness verification of the node under the default platform
        /// cap, on both engines, and the operation then executes. The witness check is admissibility only, so its
        /// cost does not grow with the number of members behind the routed validator.
        /// </summary>
        [TestMethod]
        [DataRow(1, 1, false)]
        [DataRow(3, 2, false)]
        [DataRow(10, 10, false)]
        [DataRow(1, 1, true)]
        [DataRow(3, 2, true)]
        [DataRow(10, 10, true)]
        public void AModuleRoutedAccountPassesTheProxyWitnessUnderThePlatformCapAndExecutes(int members, int threshold, bool huyao)
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var settings = Engine(huyao);
            var governance = Deploy(snapshot, 1801, "validator", governance: true, extra: GovernanceSurface);
            List<object[]> installs = [Install(governance, Validator)];
            // The member instances are 2 .. members + 1.
            for (int i = 0; i < members; i++)
                installs.Add(Install(Deploy(snapshot, 1810 + i, "validator", member: true), Validator));
            // The threshold composite: the routed instance asks the core to validate every member and
            // approves once at least the threshold of them did.
            Action<ScriptBuilder> thresholdComposite = b =>
            {
                b.Emit(OpCode.PUSH0);
                for (int member = 2; member <= members + 1; member++)
                {
                    b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).EmitPush(member).Emit(OpCode.LDARG0);
                    b.EmitPush(4).Emit(OpCode.PACK)
                        .EmitPush((int)CallFlags.All).EmitPush("validateMember")
                        .EmitPush(NativeContract.SmartAccount.Hash)
                        .EmitSysCall(ApplicationEngine.System_Contract_Call);
                    b.Emit(OpCode.ADD);
                }
                b.EmitPush(threshold).Emit(OpCode.GE);
            };
            installs.Add(Install(Deploy(snapshot, 1820, "validator", composite: true, validate: thresholdComposite), Validator));
            UInt160 id = Create(snapshot, 151, installs.ToArray());
            Fund(snapshot, id);
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            BigInteger routed = installs.Count;
            BigInteger nonce = Nonce(snapshot, id, routed);
            object[] operation = UT_SmartAccount.Operation(snapshot, id, Gas, "transfer", [address, Recipient, 3, null],
                nonce: nonce, sign: false, validatorId: routed, settings: Current, deadline: BigInteger.One << 62);
            Transaction tx = Envelope(snapshot, id, operation);

            long witness = PassesWitnessVerification(snapshot, tx, id, settings);
            using var engine = Run(snapshot, tx, settings, ApplicationEngine.TestModeGas);
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            Assert.IsTrue(engine.ResultStack.Peek().GetBoolean());
            Assert.HasCount(1, engine.Notifications.Where(n => n.EventName == "UserOpExecuted"));
            Assert.AreEqual(3, Balance(snapshot, Recipient));
            Assert.AreEqual(4, Balance(snapshot, address));
            Assert.AreEqual(nonce + 1, Nonce(snapshot, id, routed));
            Console.WriteLine($"huyao={huyao} {threshold}-of-{members}: envelope {engine.FeeConsumed} datoshi, proxy witness {witness} datoshi");
            // Measured 2026-11: at most 4.6 GAS for ten members on either engine, witness about 0.001 GAS.
            // Pinned loosely, as a ceiling: no per-callback allowance is added to what the callbacks consume.
            Assert.IsLessThan(8_000_000_000L, engine.FeeConsumed);
        }

        /// <summary>
        /// A callback that spends past the declared system fee — a validator in its completion callback, a hook in its
        /// post check, both after the nonce was consumed and the target moved GAS — faults the operation and the platform
        /// rolls every write back.
        /// </summary>
        [TestMethod]
        [DataRow("validator")]
        [DataRow("hook")]
        public void ACallbackThatExhaustsTheDeclaredFeeFaultsTheOperationAndRollsBack(string moduleType)
        {
            const long declared = 1_000_000_000;
            bool validator = moduleType == "validator";
            var snapshot = UT_SmartAccount.Snapshot(Current);
            Module greedy = validator
                ? Deploy(snapshot, 1831, "validator", complete: Burn(2 * declared))
                : Deploy(snapshot, 1832, "hook", postCheck: Burn(2 * declared));
            UInt160 id = Create(snapshot, 152, Install(greedy, validator ? Validator : Hook));
            Fund(snapshot, id);
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            BigInteger routed = validator ? BigInteger.One : BigInteger.Zero;
            BigInteger nonce = Nonce(snapshot, id, routed);
            object[] operation = UT_SmartAccount.Operation(snapshot, id, Gas, "transfer", [address, Recipient, 3, null],
                nonce: nonce, sign: !validator, validatorId: routed, settings: Current, deadline: BigInteger.One << 62);
            Transaction tx = Envelope(snapshot, id, operation);
            PassesWitnessVerification(snapshot, tx, id, Current);

            using var engine = Run(snapshot, tx, Current, declared);
            Assert.AreEqual(VMState.FAULT, engine.State);
            Assert.AreEqual("Insufficient GAS.", engine.FaultException!.GetBaseException().Message);
            // The platform counts the refused callback itself in what it reports, then stops: nothing follows it.
            Assert.IsLessThan(declared + 2 * declared + 100_000_000L, engine.FeeConsumed,
                "the engine stopped once the declared system fee was spent");
            AssertTransferRolledBack(snapshot, id, routed, nonce, engine);
        }

        /// <summary>
        /// Authorisation happens once, in executeUserOp. A wrong signature passes the witness check, which is
        /// admissibility only, through the real witness path of the node, and is then rejected by executeUserOp with no
        /// state change.
        /// </summary>
        [TestMethod]
        public void AnInvalidSignaturePassesTheWitnessCheckAndIsRejectedByExecuteUserOp()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            UInt160 id = Create(snapshot, 153);
            Fund(snapshot, id);
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            BigInteger nonce = Nonce(snapshot, id, BigInteger.Zero);
            // The witness engines see no block, so the deadline is far in the future rather than the
            // default of the application engine.
            object[] operation = UT_SmartAccount.Operation(snapshot, id, Gas, "transfer", [address, Recipient, 3, null],
                nonce: nonce, settings: Current, deadline: BigInteger.One << 62);
            // A well-formed signature of the custody key, over a digest that is not the operation's.
            byte[] digest = UT_SmartAccount.Success(snapshot, "getOperationDigest", [id, operation], settings: Current)
                .GetSpan().ToArray();
            digest[0] ^= 0xFF;
            operation[SmartAccountModuleProtocol.OpSignature] = UT_SmartAccount.SignatureOver(id, digest);
            Transaction tx = Envelope(snapshot, id, operation);

            PassesWitnessVerification(snapshot, tx, id, Current);
            using var engine = Run(snapshot, tx, Current, ApplicationEngine.TestModeGas);
            Assert.AreEqual(VMState.FAULT, engine.State);
            Assert.Contains(SmartAccountModuleProtocol.ErrorValidationRejected, engine.FaultException!.ToString());
            AssertTransferRolledBack(snapshot, id, BigInteger.Zero, nonce, engine);
        }

        /// <summary>
        /// A push-only envelope whose literal is larger than any legal operation is refused by the witness check
        /// before the literal is decoded.
        /// </summary>
        [TestMethod]
        public void AnOversizedOperationLiteralIsRefusedBeforeItIsDecoded()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            UInt160 id = Create(snapshot, 154);
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            byte[] proxy = SmartAccountProtocol.CreateVerificationScript(id);
            using var script = new ScriptBuilder();
            // 440 pushes of 75 bytes: 33,880 bytes of push-only script, none of it a serialized
            // operation, and past twice the operation size bound (32,768 bytes). What follows is the
            // account push and the fixed call tail of a legitimate entry script.
            for (int i = 0; i < 440; i++)
                script.EmitPush(new byte[75]);
            script.EmitPush(id.ToArray()).EmitPush(2).Emit(OpCode.PACK).EmitPush((int)CallFlags.All)
                .EmitPush("executeUserOp").EmitPush(SmartAccountProtocol.ServiceHash.ToArray())
                .EmitSysCall(ApplicationEngine.System_Contract_Call);
            Assert.IsGreaterThan(2 * SmartAccountModuleProtocol.OperationEncodedSizeMax, script.Length);
            Assert.IsLessThanOrEqualTo(Transaction.MaxTransactionSize, script.Length);
            var tx = new Transaction
            {
                Version = 0, Attributes = [],
                Script = script.ToArray(),
                Signers = [new Signer { Account = UT_SmartAccount.Custody, Scopes = WitnessScope.None }],
                Witnesses = [],
            };
            Assert.IsFalse(Neo.SmartContract.Helper.VerifyWitness(tx, Current, snapshot, address,
                new Witness { InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = proxy },
                Neo.SmartContract.Helper.MaxVerificationGas, out _));
            using var engine = ApplicationEngine.Create(TriggerType.Verification, tx, snapshot, null, Current,
                gas: Neo.SmartContract.Helper.MaxVerificationGas);
            engine.LoadScript(new Script(proxy, true), configureState: state =>
            {
                state.CallFlags = CallFlags.ReadOnly;
                state.ScriptHash = address;
            });
            Assert.AreEqual(VMState.FAULT, engine.Execute());
            FormatException refusal = Assert.IsInstanceOfType<FormatException>(engine.FaultException!.GetBaseException());
            Assert.AreEqual("The operation literal is outside the operation size bound.", refusal.Message);
        }

        /// <summary>
        /// validateMember refuses an operation that differs from the operation of record, byte for byte. A composite
        /// that forwards the real operation inside another array, with the digest of the real one, is refused instead
        /// of being ignored: the operation is not authorized and nothing moves.
        /// </summary>
        [TestMethod]
        public void ACompositeForwardingAnotherOperationToValidateMemberIsRefused()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var governance = Deploy(snapshot, 1851, "validator", governance: true, extra: GovernanceSurface);
            Module member = Deploy(snapshot, 1852, "validator", member: true);
            // validateMember(accountId, memberId, operationDigest, operation): the digest is the one of
            // the operation, the operation is not: it is another array that holds the real one.
            Module composite = Deploy(snapshot, 1853, "validator", composite: true, validate: b =>
            {
                b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG2).EmitPush(2).Emit(OpCode.PACK)
                    .Emit(OpCode.LDARG1).EmitPush(2).Emit(OpCode.LDARG0);
                b.EmitPush(4).Emit(OpCode.PACK)
                    .EmitPush((int)CallFlags.All).EmitPush("validateMember")
                    .EmitPush(NativeContract.SmartAccount.Hash)
                    .EmitSysCall(ApplicationEngine.System_Contract_Call);
            });
            UInt160 id = Create(snapshot, 155, Install(governance, Validator), Install(member, Validator),
                Install(composite, Validator));
            BigInteger routed = 3;
            BigInteger nonce = Nonce(snapshot, id, routed);
            object[] operation = UT_SmartAccount.Operation(snapshot, id, NativeContract.StdLib.Hash,
                "serialize", [7], nonce: nonce, sign: false, validatorId: routed, settings: Current);

            using (var refused = Call(snapshot, "executeUserOp", [id, operation], signers: []))
            {
                Assert.AreEqual(VMState.FAULT, refused.State, refused.FaultException?.ToString());
                Assert.Contains(SmartAccountModuleProtocol.ErrorOperationMalformed, refused.FaultException!.ToString());
                Assert.AreEqual(0, refused.Notifications.Count(n => n.EventName == "UserOpExecuted"));
            }
            using var preview = Call(snapshot, "validateUserOp", [id, operation]);
            Assert.AreEqual(VMState.FAULT, preview.State, "the read-only preview is refused the same way");
            Assert.Contains(SmartAccountModuleProtocol.ErrorOperationMalformed, preview.FaultException!.ToString());
            Assert.AreEqual(nonce, Nonce(snapshot, id, routed), "nothing was consumed");
        }

        /// <summary>
        /// The core itself is never a dispatch target: an operation whose target is the core hash faults before any
        /// target frame is loaded.
        /// </summary>
        [TestMethod]
        public void TheCoreIsRefusedAsATargetBeforeAnyTargetFrameIsLoaded()
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            UInt160 id = Create(snapshot, 156);
            BigInteger nonce = Nonce(snapshot, id, BigInteger.Zero);
            object[] operation = UT_SmartAccount.Operation(snapshot, id, NativeContract.SmartAccount.Hash,
                "getAccountImplementationId", [], nonce: nonce, settings: Current, deadline: BigInteger.One << 62);
            Transaction tx = Envelope(snapshot, id, operation);
            var diagnostic = new Moq.Mock<IDiagnostic>();
            PassesWitnessVerification(snapshot, tx, id, Current);
            using var engine = Run(snapshot, tx, Current, ApplicationEngine.TestModeGas, diagnostic.Object);
            Assert.AreEqual(VMState.FAULT, engine.State);
            Assert.Contains(SmartAccountModuleProtocol.ErrorPhaseViolation, engine.FaultException!.ToString());
            diagnostic.Verify(d => d.CallFromNative(NativeContract.SmartAccount.Hash, "getAccountImplementationId",
                It.IsAny<StackItem[]>()), Moq.Times.Never);
            Assert.AreEqual(0, engine.Notifications.Count(n => n.EventName == "UserOpExecuted"));
            Assert.AreEqual(nonce, Nonce(snapshot, id, BigInteger.Zero), "the nonce did not move");
        }

        /// <summary>
        /// The custodial single-key transfer is charged what it consumes, on both engines. The system fee a wallet
        /// declares is exactly the consumed GAS — one datoshi less faults, exactly this amount halts and leaves no
        /// datoshi unspent — and the proxy witness engine is paid from the network fee: the quoted network fee is
        /// the custody signature at the chain's price, the consumption the proxy witness engine reports and the
        /// byte fee of the signed transaction, nothing beside, so the node's witness check passes on exactly that
        /// fee and fails one datoshi lower.
        /// </summary>
        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void ACustodialTransferIsChargedItsConsumedGasWithNoBudgetMargin(bool huyao)
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var settings = Engine(huyao);
            UInt160 id = Create(snapshot, 157);
            Fund(snapshot, id);
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            object[] operation = UT_SmartAccount.Operation(snapshot, id, Gas, "transfer", [address, Recipient, 3, null],
                settings: Current, deadline: BigInteger.One << 62);
            Transaction tx = Envelope(snapshot, id, operation);

            long witness = PassesWitnessVerification(snapshot, tx, id, settings);
            // Each engine runs on its own clone of the snapshot: the first execution consumes the nonce.
            using var engine = Run(snapshot.CloneCache(), tx, settings, ApplicationEngine.TestModeGas);
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            long consumed = engine.FeeConsumed;
            Console.WriteLine($"huyao={huyao} custodial transfer: envelope {consumed} datoshi, proxy witness {witness} datoshi, network fee {tx.NetworkFee}");
            // Recorded, not pinned: measured 2026-11 at about 0.12 GAS on either engine. The ceiling is a
            // third of the platform verification cap; a callback budget margin would be a multiple of it.
            Assert.IsLessThan(500_000_000L, consumed);
            // The declared system fee is the consumption of the execution engine: a replay under exactly that
            // limit halts, spends all of it and transfers the GAS; one datoshi less faults.
            tx.SystemFee = consumed;
            foreach (long declared in new[] { consumed, consumed - 1 })
            {
                using var replay = Run(snapshot.CloneCache(), tx, settings, declared);
                Assert.AreEqual(declared == consumed ? VMState.HALT : VMState.FAULT, replay.State, replay.FaultException?.ToString());
                if (declared == consumed)
                    Assert.AreEqual(declared, replay.FeeConsumed, "no margin: the declared system fee is consumed to the datoshi");
                else
                    Assert.AreEqual("Insufficient GAS.", replay.FaultException!.GetBaseException().Message);
            }
            // The network fee is what the node hands to the witnesses. The custody signature is charged the
            // platform price the node charges it (Transaction.VerifyStateDependent), the proxy witness what its
            // engine consumed in the quote, and the rest is the byte fee of the signed transaction.
            UInt160 proxy = SmartAccountProtocol.GetAccountAddress(id);
            long byteFee = tx.Size * NativeContract.Policy.GetFeePerByte(snapshot);
            long custodyCost = NativeContract.Policy.GetExecFeeFactor(settings, snapshot, NativeContract.Ledger.CurrentIndex(snapshot))
                * Neo.SmartContract.Helper.SignatureContractCost();
            Assert.AreEqual(custodyCost + witness + byteFee, tx.NetworkFee, "the quoted network fee carries no margin");
            // The same arithmetic as the node: it passes on exactly this amount and fails one datoshi lower.
            long witnessGas = tx.NetworkFee - byteFee - custodyCost;
            Assert.AreEqual(witness, witnessGas, "the proxy witness engine is charged what it consumed as network fee");
            Assert.IsTrue(Neo.SmartContract.Helper.VerifyWitness(tx, settings, snapshot, proxy, tx.Witnesses[1], witnessGas, out _),
                "the node's witness check passes on the quoted network fee");
            Assert.IsFalse(Neo.SmartContract.Helper.VerifyWitness(tx, settings, snapshot, proxy, tx.Witnesses[1], witnessGas - 1, out _),
                "and fails one datoshi lower");
        }

        /// <summary>
        /// The wallet path: a wallet that holds the custody key and the proxy verification script builds the envelope
        /// transaction itself, on both engines. It dry-runs the script, declares the consumed GAS as the system fee and
        /// quotes the network fee by running both witnesses. Signed, the transaction replays on exactly the system
        /// fee the wallet set and halts, and the node's witness check passes on exactly the quoted network fee.
        /// </summary>
        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void AWalletBuiltEnvelopeReplaysWithTheSystemFeeTheWalletSet(bool huyao)
        {
            var snapshot = UT_SmartAccount.Snapshot(Current);
            var settings = Engine(huyao);
            UInt160 id = Create(snapshot, 158);
            Fund(snapshot, id);
            UInt160 proxy = SmartAccountProtocol.GetAccountAddress(id);
            object[] operation = UT_SmartAccount.Operation(snapshot, id, Gas, "transfer", [proxy, Recipient, 3, null],
                settings: Current, deadline: BigInteger.One << 62);
            // An in-memory wallet: no file is written. It holds the custody key of the payer and the proxy
            // verification script of the account, which is what the quote of both witnesses needs. The payer
            // has no GAS in the ledger yet: the wallet requires the balance, in datoshi, for both fees.
            var wallet = new Neo.Wallets.NEP6.NEP6Wallet(null, "test-only", settings);
            wallet.CreateAccount(UT_SmartAccount.CustodyKey.PrivateKey);
            wallet.CreateAccount(Contract.Create([], SmartAccountProtocol.CreateVerificationScript(id)));
            snapshot.GetAndChange(NativeContract.GAS.CreateStorageKey(20, UT_SmartAccount.Custody), () => new StorageItem(new AccountState()))
                .GetInteroperable<AccountState>().Balance = 10_000_000_000;
            Transaction tx = wallet.MakeTransaction(snapshot, SmartAccountTestSupport.ExecuteUserOp(id, Item(operation)),
                UT_SmartAccount.Custody, [new Signer { Account = proxy, Scopes = WitnessScope.Global }]);

            // What the wallet declared: the payer first, the account second, and the GAS its dry run consumed.
            Assert.HasCount(2, tx.Signers);
            Assert.AreEqual(UT_SmartAccount.Custody, tx.Sender);
            Assert.AreEqual(proxy, tx.Signers[1].Account);
            Assert.IsGreaterThan(0, tx.SystemFee);
            Assert.IsLessThan(500_000_000L, tx.SystemFee);
            BigInteger nonce = Nonce(snapshot, id, BigInteger.Zero);
            Sign(tx, id);
            Assert.AreEqual(VerifyResult.Succeed, tx.VerifyStateIndependent(settings));

            // The witness checks read the nonce, so they run before the replay consumes it. The network fee the
            // wallet quoted, before it held any witness, is the quote of the signed transaction too: the wallet
            // sized the witnesses it expected. It admits the proxy witness on the node, to the datoshi.
            Assert.AreEqual(tx.NetworkFee, Neo.Wallets.Helper.CalculateNetworkFee(tx, snapshot, settings),
                "the wallet sized the witnesses before signing");
            long byteFee = tx.Size * NativeContract.Policy.GetFeePerByte(snapshot);
            long custodyCost = NativeContract.Policy.GetExecFeeFactor(settings, snapshot, NativeContract.Ledger.CurrentIndex(snapshot))
                * Neo.SmartContract.Helper.SignatureContractCost();
            long witnessGas = tx.NetworkFee - byteFee - custodyCost;
            Assert.IsTrue(Neo.SmartContract.Helper.VerifyWitness(tx, settings, snapshot, proxy, tx.Witnesses[1], witnessGas, out _),
                "the node's witness check passes on the quoted network fee");
            Assert.IsFalse(Neo.SmartContract.Helper.VerifyWitness(tx, settings, snapshot, proxy, tx.Witnesses[1], witnessGas - 1, out _),
                "and fails one datoshi lower");
            Assert.IsTrue(tx.VerifyWitnesses(settings, snapshot, Neo.SmartContract.Helper.MaxVerificationGas));

            // The replay: on exactly the system fee the wallet set the envelope halts, spends all of it and moves
            // the GAS.
            using var engine = Run(snapshot, tx, settings, tx.SystemFee);
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            Assert.IsTrue(engine.ResultStack.Peek().GetBoolean());
            Assert.AreEqual(tx.SystemFee, engine.FeeConsumed, "the system fee the wallet set is what the envelope consumes");
            Assert.AreEqual(3, Balance(snapshot, Recipient));
            Assert.AreEqual(nonce + 1, Nonce(snapshot, id, BigInteger.Zero));
        }


        private static UInt160 DeployReentry(DataCache snapshot)
        {
            using var script = new ScriptBuilder();
            script.Emit(OpCode.INITSLOT, new byte[] { 0, 2 });
            script.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
            CoreCallVoid(script, "executeUserOp", 2);
            script.Emit(OpCode.RET);
            ContractState contract = TestUtils.GetContract(script.ToArray());
            contract.Id = 1701;
            contract.Manifest.Abi.Methods =
            [
                new ContractMethodDescriptor
                {
                    Name = "reenter",
                    ReturnType = ContractParameterType.Void,
                    Safe = false,
                    Offset = 0,
                    Parameters =
                    [
                        new ContractParameterDefinition { Name = "p0", Type = ContractParameterType.Hash160 },
                        new ContractParameterDefinition { Name = "p1", Type = ContractParameterType.Array },
                    ],
                },
            ];
            snapshot.AddContract(contract.Hash, contract);
            return contract.Hash;
        }
    }
}
