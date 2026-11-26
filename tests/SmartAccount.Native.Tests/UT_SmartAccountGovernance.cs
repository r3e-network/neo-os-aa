// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccountGovernance.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

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
using System.Security.Cryptography;
using System.Text;
using System.Numerics;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// The v4.1 administration principal (spec §4, plan line 48 — governance
    /// only): every configuration landing of an account — install, remove,
    /// configure, the built-in switches, the configuration batch, an ordinary
    /// thaw and a credential revocation — belongs to the account's bound,
    /// code-bound governance instance alone. The custody key keeps only the two
    /// emergency writings, freeze and revoke.
    ///
    /// This harness deploys such an instance with a forwarding surface, so a
    /// test presents the module's own contract witness and nothing else, and it
    /// creates accounts whose creation group installs the instance atomically
    /// (creation is the only consent to an initial install).
    /// </summary>
    internal static class UT_SmartAccountGovernance
    {
        /// <summary>The canonical governance validator profile (spec §7.3/§12).</summary>
        internal static byte[] Profile(string name) =>
            Encoding.UTF8.GetBytes(
                "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":"
                + "{\"compositeLayer\":0,\"governance\":true,\"instanceIsolation\":true,"
                + "\"messageCapability\":false,\"thresholdMemberEligible\":false},"
                + "\"contractName\":\"" + name + "\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],"
                + "\"moduleType\":\"validator\",\"profileVersion\":1}");

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
        /// Deploys the governance instance: the profile every module serves, the
        /// lifecycle callbacks, the validation callback admission requires of a
        /// validator, and one forwarding method per landable administration
        /// write. Each forwarder rebuilds the positional argument array (PACK
        /// takes the top of the stack as element 0, so arguments are pushed in
        /// reverse) and re-enters the core, which sees the module's own contract
        /// witness as the calling script.
        /// </summary>
        internal static ContractState Deploy(DataCache snapshot, int number, string name = "Governor")
        {
            byte[] profile = Profile(name);
            using var script = new ScriptBuilder();
            List<ContractMethodDescriptor> methods = new();
            void Method(string methodName, ContractParameterType result, bool safe, Action<ScriptBuilder> body,
                params ContractParameterType[] parameters)
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
            Method("onInstall", ContractParameterType.Void, false, _ => { },
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Integer, ContractParameterType.Array);
            Method("onUninstall", ContractParameterType.Void, false, _ => { },
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Integer, ContractParameterType.Array);
            Method("validateUserOp", ContractParameterType.Boolean, true, b => b.EmitPush(true),
                ContractParameterType.Hash160, ContractParameterType.ByteArray, ContractParameterType.Array);
            Method("onUserOpComplete", ContractParameterType.Void, false, _ => { },
                ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Any);
            // installModule(accountId, moduleType, contractHash, initData)
            Method(GovInstall, ContractParameterType.Integer, false, b =>
            {
                b.Emit(OpCode.LDARG3).Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCall(b, "installModule", 4);
            }, ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Hash160, ContractParameterType.Array);
            // removeModule(accountId, moduleId, data)
            Method(GovRemove, ContractParameterType.Void, false, b =>
            {
                b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "removeModule", 3);
            }, ContractParameterType.Hash160, ContractParameterType.Integer, ContractParameterType.Array);
            // configureModule(accountId, moduleId, data)
            Method(GovConfigure, ContractParameterType.Void, false, b =>
            {
                b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "configureModule", 3);
            }, ContractParameterType.Hash160, ContractParameterType.Integer, ContractParameterType.Array);
            // unfreezeAccount(accountId)
            Method(GovThaw, ContractParameterType.Void, false, b =>
            {
                b.Emit(OpCode.LDARG0);
                CoreCallVoid(b, "unfreezeAccount", 1);
            }, ContractParameterType.Hash160);
            // setBuiltinAuthorization(accountId, operation, message)
            Method(GovBuiltin, ContractParameterType.Void, false, b =>
            {
                b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "setBuiltinAuthorization", 3);
            }, ContractParameterType.Hash160, ContractParameterType.Boolean, ContractParameterType.Boolean);
            // applyConfigurationActions(accountId, actions)
            Method(GovApply, ContractParameterType.Void, false, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "applyConfigurationActions", 2);
            }, ContractParameterType.Hash160, ContractParameterType.Array);
            // revokeModuleCredentials(accountId, moduleId)
            Method(GovRevoke, ContractParameterType.Void, false, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "revokeModuleCredentials", 2);
            }, ContractParameterType.Hash160, ContractParameterType.Integer);
            // resetAccount(accountId, newCustody): the governance instance is never
            // the recovery seat, so this forwarder only ever proves the refusal.
            Method(GovReset, ContractParameterType.Void, false, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "resetAccount", 2);
            }, ContractParameterType.Hash160, ContractParameterType.Hash160);
            // The §12.5 rotation the seat performs: the restricted reset followed by
            // the single-use install-only initialization it opens.
            Method(GovResetInit, ContractParameterType.Void, false, b =>
            {
                b.Emit(OpCode.LDARG1).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "resetAccount", 2);
                b.Emit(OpCode.LDARG2).Emit(OpCode.LDARG0);
                CoreCallVoid(b, "applyConfigurationActions", 2);
            }, ContractParameterType.Hash160, ContractParameterType.Hash160, ContractParameterType.Array);

            ContractState contract = TestUtils.GetContract(script.ToArray());
            contract.Id = number;
            contract.Manifest.Name = name;
            contract.Manifest.Abi.Methods = methods.ToArray();
            snapshot.AddContract(contract.Hash, contract);
            return contract;
        }

        internal const string GovInstall = "govInstall";
        internal const string GovRemove = "govRemove";
        internal const string GovConfigure = "govConfigure";
        internal const string GovThaw = "govThaw";
        internal const string GovBuiltin = "govBuiltin";
        internal const string GovApply = "govApply";
        internal const string GovRevoke = "govRevoke";
        internal const string GovReset = "govReset";
        internal const string GovResetInit = "govResetInit";

        /// <summary>
        /// Creates an account whose single creation action installs the
        /// governance instance: the atomic group is an array of action arrays.
        /// </summary>
        internal static UInt160 Create(DataCache snapshot, ContractState governor, byte seed)
        {
            byte[] salt = new byte[32];
            salt[0] = seed;
            UInt160 id = SmartAccountProtocol.GetAccountId(UT_SmartAccount.Custody, salt);
            object[] action =
            [
                SmartAccountModuleProtocol.ActionInstallModule,
                SmartAccountModuleProtocol.ModuleTypeCodeValidator,
                governor.Hash,
                SHA256.HashData(Profile(governor.Manifest.Name)),
                new object[0],
            ];
            UT_SmartAccount.Success(snapshot, "createAccount",
                [id, UT_SmartAccount.Custody, salt, new object[] { action }]);
            return id;
        }

        /// <summary>Deploys the governance instance and creates the account that owns it.</summary>
        internal static UInt160 Register(DataCache snapshot, int number, out ContractState governor, byte seed = 0)
        {
            governor = Deploy(snapshot, number);
            return Create(snapshot, governor, seed);
        }

        /// <summary>A configuration landing the harness treats as succeeding.</summary>
        internal static StackItem Land(DataCache snapshot, ContractState governor, string method, object[] args) =>
            UT_SmartAccount.Success(snapshot, method, args, signers: [], target: governor.Hash);

        /// <summary>A configuration landing the harness expects to answer a state.</summary>
        internal static ApplicationEngine TryLand(DataCache snapshot, ContractState governor, string method,
            object[] args) =>
            UT_SmartAccount.Invoke(snapshot, method, args, signers: [], target: governor.Hash);

        /// <summary>The install landing shape (spec §7.1 action 1).</summary>
        internal static object[] Install(UInt160 id, int moduleType, UInt160 contractHash, object[] data) =>
            [id, moduleType, contractHash, data];
    }
}
