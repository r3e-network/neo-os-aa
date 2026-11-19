// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountModulePolicy.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

// TRUE SOURCE: this is the only editable copy of this SmartAccount native
// contract file. The neo-native-core checkout carries a generated copy —
// regenerate it via scripts/sync_native_smartaccount.py.

using Neo.Cryptography;
using Neo.Extensions;
using Neo.IO;
using Neo.Json;
using Neo.Persistence;
using Neo.SmartContract.Manifest;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Array = Neo.VM.Types.Array;
using Boolean = Neo.VM.Types.Boolean;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// Exact module admission for the native profile (spec §9/§12): deployed
    /// non-protocol contract, canonical profile bound by digest, complete v4
    /// callback ABI and code-identity continuity.
    /// </summary>
    internal static class SmartAccountModulePolicy
    {
        internal const long MaintenanceBudget = SmartAccountModuleProtocol.LifecycleCallbackGasLimit;

        internal static ContractState RequireDeployed(IReadOnlyStore snapshot, UInt160 module)
        {
            ArgumentNullException.ThrowIfNull(snapshot);
            ArgumentNullException.ThrowIfNull(module);
            if (module == UInt160.Zero || module == SmartAccountProtocol.ServiceHash || NativeContract.IsNative(module)
                || NativeContract.Policy.IsBlocked(snapshot, module))
                throw new InvalidOperationException("The module is zero, native or blocked.");
            return NativeContract.ContractManagement.GetContract(snapshot, module)
                ?? throw new InvalidOperationException("The module is not deployed.");
        }

        /// <summary>A module address must be a deployed, non-protocol contract.</summary>
        internal static void RequireModuleContractAddress(IReadOnlyStore snapshot, UInt160 module)
        {
            ArgumentNullException.ThrowIfNull(module);
            if (module == UInt160.Zero) throw new FormatException("The module contract address is zero.");
            if (module == SmartAccountProtocol.ServiceHash || NativeContract.IsNative(module))
                throw new FormatException("The module contract address identifies a native or protocol contract.");
        }

        internal static UInt256 CodeHash(ContractState contract)
        {
            ArgumentNullException.ThrowIfNull(contract);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(contract.Nef.ToArray());
            hash.AppendData([0]);
            hash.AppendData(SmartAccountCanonicalJson.Serialize(contract.Manifest.ToJson()));
            return new UInt256(hash.GetHashAndReset());
        }

        private static ContractMethodDescriptor? FindMethod(ContractState contract, string name, int arguments) =>
            contract.Manifest.Abi.Methods.FirstOrDefault(m => m.Name == name && m.Parameters.Length == arguments);

        private static void RequireMethod(ContractState contract, string name, ContractParameterType result,
            bool? safe, params ContractParameterType[] parameters)
        {
            var method = FindMethod(contract, name, parameters.Length)
                ?? throw new InvalidOperationException($"The module must expose {name}/{parameters.Length}.");
            if (method.ReturnType != result || (safe.HasValue && method.Safe != safe.Value)
                || method.Offset < 0 || method.Offset >= contract.Script.Length
                || !method.Parameters.Select(p => p.Type).SequenceEqual(parameters))
                throw new InvalidOperationException($"The module has an invalid {name} callback ABI.");
        }

        /// <summary>
        /// The complete v4 callback surface of a module type (spec §9). A
        /// missing-method fault is not catchable, so the whole shape is checked
        /// before the instance is bound. Validation and message callbacks must
        /// be declared safe: they can then never write, whatever call flags a
        /// caller passes.
        /// </summary>
        internal static void AssertCallbackAbi(ContractState contract, ModuleInstance module)
        {
            RequireMethod(contract, "onInstall", ContractParameterType.Void, null,
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Integer, ContractParameterType.Array);
            RequireMethod(contract, "onUninstall", ContractParameterType.Void, null,
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Integer, ContractParameterType.Array);
            RequireMethod(contract, "configure", ContractParameterType.Void, null,
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Integer, ContractParameterType.Array);
            if (module.IsValidator)
            {
                RequireMethod(contract, "validateUserOp", ContractParameterType.Boolean, true,
                    ContractParameterType.Hash160, ContractParameterType.ByteArray, ContractParameterType.Array);
                RequireMethod(contract, "onUserOpComplete", ContractParameterType.Void, null,
                    ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Any);
                if (module.MessageCapability)
                    RequireMethod(contract, "isValidSignature", ContractParameterType.Boolean, true,
                        ContractParameterType.Hash160, ContractParameterType.Hash160,
                        ContractParameterType.Integer, ContractParameterType.Integer,
                        ContractParameterType.ByteArray, ContractParameterType.Array);
            }
            else
            {
                RequireMethod(contract, "preCheck", ContractParameterType.ByteArray, null,
                    ContractParameterType.Hash160, ContractParameterType.Array);
                RequireMethod(contract, "postCheck", ContractParameterType.Void, null,
                    ContractParameterType.Hash160, ContractParameterType.Array,
                    ContractParameterType.Any, ContractParameterType.ByteArray);
            }
        }

        /// <summary>
        /// Canonical-profile binding (spec §7.3/§12). The module's own read-only
        /// <c>getModuleProfile()</c> must return exactly the bytes whose SHA-256
        /// the configuration action committed to; the capability flags recorded
        /// in 0x52 are then READ from that profile, never declared by the
        /// installer. The read is bounded like a lifecycle callback and carries
        /// no write permission.
        /// </summary>
        internal static async ContractTask BindProfileAsync(ApplicationEngine engine, ModuleInstance module,
            ContractState contract, byte[] profileDigest)
        {
            if (profileDigest.Length != 32)
                throw new FormatException("The profile digest must be exactly 32 bytes.");
            RequireMethod(contract, "getModuleProfile", ContractParameterType.String, true);

            engine.AddNativeCpuFee(1 << 15);
            StackItem reply = (await engine.CallFromNativeContractWithGasLimitAsync(SmartAccountProtocol.ServiceHash,
                contract.Hash, "getModuleProfile", CallFlags.ReadStates, MaintenanceBudget))!;
            // The declared ABI is String and the core does not coerce (§11): the
            // bytes hashed below are the ones the profile call actually returned.
            if (reply is not ByteString profileBytes || profileBytes.Size is 0 or > SmartAccountModuleProtocol.ModuleProfileBytesMax)
                throw new InvalidOperationException("getModuleProfile must return a bounded String.");
            byte[] json = profileBytes.GetSpan().ToArray();
            if (!SHA256.HashData(json).AsSpan().SequenceEqual(profileDigest))
                throw new InvalidOperationException("The module profile does not match the committed digest.");
            string profileJson = Encoding.UTF8.GetString(json);

            JObject profile;
            try
            {
                profile = JObject.Parse(profileJson) as JObject
                    ?? throw new FormatException("The module profile is not a JSON object.");
            }
            catch (Exception exception) when (exception is not InvalidOperationException)
            {
                throw new FormatException("The module profile is not canonical JSON.", exception);
            }
            if (profile["profileVersion"] is not JNumber version
                || version.Value != SmartAccountModuleProtocol.ModuleProfileVersion)
                throw new InvalidOperationException("The module profile version is not supported.");
            if (profile["moduleType"] is not JString moduleType
                || moduleType.GetString() != SmartAccountModuleTypeName(module.ModuleType))
                throw new InvalidOperationException("The module profile declares a different module type.");
            if (profile["contractName"] is not JString name || name.GetString() != contract.Manifest.Name)
                throw new InvalidOperationException("The module profile names a different contract.");
            if (profile["capabilities"] is not JObject capabilities)
                throw new InvalidOperationException("The module profile has no capability object.");
            bool instanceIsolation = RequireCapability(capabilities, "instanceIsolation");
            bool messageCapability = RequireCapability(capabilities, "messageCapability");
            bool thresholdMemberEligible = RequireCapability(capabilities, "thresholdMemberEligible");
            if (capabilities["compositeLayer"] is not JNumber layer
                || layer.Value < 0 || layer.Value > SmartAccountModuleProtocol.ModuleCompositeLayerMax)
                throw new InvalidOperationException("The module profile composite layer is outside the profile bound.");
            if (module.IsHook && (messageCapability || thresholdMemberEligible))
                throw new InvalidOperationException("A hook profile cannot declare validator capabilities.");

            module.InstanceIsolation = instanceIsolation;
            module.MessageCapability = messageCapability;
            module.ThresholdMemberEligible = thresholdMemberEligible;
            AssertCallbackAbi(contract, module);
        }

        private static bool RequireCapability(JObject capabilities, string name)
        {
            if (capabilities[name] is not JBoolean value)
                throw new InvalidOperationException($"The module profile must declare the {name} capability.");
            return value.Value;
        }

        internal static string SmartAccountModuleTypeName(byte moduleType) =>
            moduleType == SmartAccountModuleProtocol.ModuleTypeCodeValidator ? "validator" : "hook";

        /// <summary>
        /// Code-identity continuity (spec §3.6): the deployment id is the global
        /// deployment slot (a destroy-and-redeploy at the same script hash cannot
        /// reuse it) and every code or manifest update of that slot bumps the
        /// counter, so an equal pair names exactly the revision whose Nef hash
        /// the instance record captured at install.
        /// </summary>
        internal static void AssertCodeBinding(ContractState? contract, ModuleInstance module)
        {
            if (contract is null || (ulong)contract.Id != module.ContractId ||
                contract.UpdateCounter != module.UpdateCounter)
                throw new InvalidOperationException("The module code binding has changed.");
        }

        internal static void CaptureCodeBinding(ModuleInstance module, ContractState contract)
        {
            module.ContractHash = contract.Hash;
            module.ContractId = (ulong)contract.Id;
            module.UpdateCounter = contract.UpdateCounter;
            module.NefSha256 = CodeHash(contract).ToArray();
        }
    }
}
