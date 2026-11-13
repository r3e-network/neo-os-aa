// Copyright (C) 2015-2026 The Neo Project.
//
// NativeContract.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

using Neo.Cryptography.ECC;
using Neo.SmartContract.Manifest;
using Neo.VM;
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Collections.ObjectModel;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace Neo.SmartContract.Native
{
    /// <summary>The base class of all native contracts.</summary>
    public abstract class NativeContract
    {
        private class NativeContractsCache
        {
            public record CacheEntry(Dictionary<int, ContractMethodMetadata> Methods, byte[] Script);

            internal Dictionary<int, CacheEntry> NativeContracts { get; set; } = new();

            public CacheEntry GetAllowedMethods(NativeContract native, ApplicationEngine engine)
            {
                if (NativeContracts.TryGetValue(native.Id, out var value)) return value;

                uint index = engine.PersistingBlock is null ? Ledger.CurrentIndex(engine.SnapshotCache) : engine.PersistingBlock.Index;
                CacheEntry methods = native.GetAllowedMethods(engine.ProtocolSettings.IsHardforkEnabled, index);
                NativeContracts[native.Id] = methods;
                return methods;
            }
        }

        public delegate bool IsHardforkEnabledDelegate(Hardfork hf, uint blockHeight);
        private static readonly List<NativeContract> s_contractsList = [];
        private static readonly Dictionary<UInt160, NativeContract> s_contractsDictionary = new();
        private readonly ImmutableHashSet<Hardfork> _usedHardforks;
        private readonly ReadOnlyCollection<ContractMethodMetadata> _methodDescriptors;
        private readonly ReadOnlyCollection<ContractEventAttribute> _eventsDescriptors;
        private static int idCounter = 0;

        #region Named Native Contracts

        public static ContractManagement ContractManagement { get; } = new();
        public static StdLib StdLib { get; } = new();
        public static CryptoLib CryptoLib { get; } = new();
        public static LedgerContract Ledger { get; } = new();
        public static NeoToken NEO { get; } = new();
        public static GasToken GAS { get; } = new();
        public static PolicyContract Policy { get; } = new();
        public static RoleManagement RoleManagement { get; } = new();
        public static OracleContract Oracle { get; } = new();
        public static Notary Notary { get; } = new();
        public static Treasury Treasury { get; } = new();
        public static TemporaryStorage TemporaryStorage { get; } = new();

        /// <summary>Gets the independently activated SmartAccount native service.</summary>
        public static SmartAccount SmartAccount { get; } = new();

        #endregion

        public static IReadOnlyCollection<NativeContract> Contracts { get; } = s_contractsList;
        public string Name => GetType().Name;
        public Hardfork? ActiveIn => Activations.FirstOrDefault();
        public virtual ImmutableHashSet<Hardfork?> Activations { get; } = [];
        public UInt160 Hash { get; }
        public int Id { get; } = --idCounter;

        protected NativeContract()
        {
            Hash = Helper.GetContractHash(UInt160.Zero, 0, Name);

            List<ContractMethodMetadata> listMethods = [];
            foreach (var member in GetType().GetMembers(BindingFlags.Instance | BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public))
            {
                foreach (var attribute in member.GetCustomAttributes<ContractMethodAttribute>())
                    listMethods.Add(new ContractMethodMetadata(member, attribute));
            }
            _methodDescriptors = listMethods.OrderBy(p => p.Name, StringComparer.Ordinal).ThenBy(p => p.Parameters.Length).ToList().AsReadOnly();

            _eventsDescriptors =
                GetType().GetConstructor(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public, null, Array.Empty<Type>(), null)!.
                GetCustomAttributes<ContractEventAttribute>().
                Concat(GetType().BaseType?.GetConstructor(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public, null, Array.Empty<Type>(), null)!.
                GetCustomAttributes<ContractEventAttribute>() ?? []).
                OrderBy(p => p.Order).ToList().AsReadOnly();

            _usedHardforks =
                _methodDescriptors.Select(u => u.ActiveIn)
                    .Concat(_methodDescriptors.Select(u => u.DeprecatedIn))
                    .Concat(_eventsDescriptors.Select(u => u.DeprecatedIn))
                    .Concat(_eventsDescriptors.Select(u => u.ActiveIn))
                    .Concat(Activations)
                    .Where(u => u.HasValue)
                    .Select(u => u!.Value)
                    .OrderBy(u => (byte)u)
                    .Cast<Hardfork>().ToImmutableHashSet();
            s_contractsList.Add(this);
            s_contractsDictionary.Add(Hash, this);
        }

        private NativeContractsCache.CacheEntry GetAllowedMethods(IsHardforkEnabledDelegate hfChecker, uint blockHeight)
        {
            Dictionary<int, ContractMethodMetadata> methods = new();

            byte[] script;
            using (ScriptBuilder sb = new())
            {
                foreach (ContractMethodMetadata method in _methodDescriptors.Where(u => IsActive(u, hfChecker, blockHeight)))
                {
                    method.Descriptor.Offset = sb.Length;
                    sb.EmitPush(0);
                    methods.Add(sb.Length, method);
                    sb.EmitSysCall(ApplicationEngine.System_Contract_CallNative);
                    sb.Emit(OpCode.RET);
                }
                script = sb.ToArray();
            }

            return new NativeContractsCache.CacheEntry(methods, script);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public ContractState GetContractState(ProtocolSettings settings, uint blockHeight) => GetContractState(settings.IsHardforkEnabled, blockHeight);

        internal static bool IsActive(IHardforkActivable u, IsHardforkEnabledDelegate hfChecker, uint blockHeight)
        {
            return (u.ActiveIn is null || hfChecker(u.ActiveIn.Value, blockHeight)) && (u.DeprecatedIn is null || !hfChecker(u.DeprecatedIn.Value, blockHeight));
        }

        public ContractState GetContractState(IsHardforkEnabledDelegate hfChecker, uint blockHeight)
        {
            var allowedMethods = GetAllowedMethods(hfChecker, blockHeight);

            var nef = new NefFile()
            {
                Compiler = "neo-core-v3.0",
                Source = string.Empty,
                Tokens = [],
                Script = allowedMethods.Script
            };
            nef.CheckSum = NefFile.ComputeChecksum(nef);

            var manifest = new ContractManifest()
            {
                Name = Name,
                Groups = [],
                SupportedStandards = [],
                Abi = new ContractAbi
                {
                    Events = _eventsDescriptors
                        .Where(u => IsActive(u, hfChecker, blockHeight))
                        .Select(p => p.Descriptor).ToArray(),
                    Methods = allowedMethods.Methods.Values
                        .Select(p => p.Descriptor).ToArray()
                },
                Permissions = [ContractPermission.DefaultPermission],
                Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
                Extra = null
            };

            OnManifestCompose(hfChecker, blockHeight, manifest);

            return new ContractState
            {
                Id = Id,
                Nef = nef,
                Hash = Hash,
                Manifest = manifest
            };
        }

        protected virtual void OnManifestCompose(IsHardforkEnabledDelegate hfChecker, uint blockHeight, ContractManifest manifest) { }

        internal bool IsInitializeBlock(ProtocolSettings settings, uint index, [NotNullWhen(true)] out Hardfork[]? hardforks)
        {
            var hfs = new List<Hardfork>();

            foreach (var hf in _usedHardforks)
            {
                if (!settings.Hardforks.TryGetValue(hf, out var activeIn))
                    continue;

                if (activeIn == index)
                    hfs.Add(hf);
            }

            if (hfs.Count > 0)
            {
                hardforks = hfs.ToArray();
                return true;
            }

            if (index == 0 && ActiveIn is null)
            {
                hardforks = hfs.ToArray();
                return true;
            }

            hardforks = null;
            return false;
        }

        public bool IsActive(ProtocolSettings settings, uint blockHeight)
        {
            if (ActiveIn is null) return true;

            if (!settings.Hardforks.TryGetValue(ActiveIn.Value, out var activeIn))
            {
                if (ActiveIn == Hardfork.HF_SmartAccountV1)
                    return false;
                activeIn = 0;
            }

            return activeIn <= blockHeight;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        protected static bool CheckCommittee(ApplicationEngine engine)
        {
            var committeeMultiSigAddr = NEO.GetCommitteeAddress(engine.SnapshotCache);
            return engine.CheckWitnessInternal(committeeMultiSigAddr);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        protected static void AssertCommittee(ApplicationEngine engine)
        {
            if (!CheckCommittee(engine))
                throw new InvalidOperationException("Invalid committee signature. It should be a multisig(len(committee) - (len(committee) - 1) / 2)).");
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        protected static UInt160 AssertAlmostFullCommittee(ApplicationEngine engine)
        {
            UInt160 committeeMultiSigAddr;
            var committees = NativeContract.NEO.GetCommittee(engine.SnapshotCache);

            var min = Math.Max(1, committees.Length - (committees.Length - 1) / 2);
            committeeMultiSigAddr = Contract.CreateMultiSigRedeemScript(Math.Max(min, committees.Length - 2), committees).ToScriptHash();

            if (!engine.CheckWitnessInternal(committeeMultiSigAddr))
                throw new InvalidOperationException("Invalid committee signature. It should be a multisig(max(1,len(committee) - 2))).");

            return committeeMultiSigAddr;
        }

        #region Storage keys

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix) => StorageKey.Create(Id, prefix);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, byte data) => StorageKey.Create(Id, prefix, data);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, int bigEndianKey) => StorageKey.Create(Id, prefix, bigEndianKey);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, uint bigEndianKey) => StorageKey.Create(Id, prefix, bigEndianKey);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, long bigEndianKey) => StorageKey.Create(Id, prefix, bigEndianKey);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, ulong bigEndianKey) => StorageKey.Create(Id, prefix, bigEndianKey);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, ReadOnlySpan<byte> content) => StorageKey.Create(Id, prefix, content);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, UInt160 hash) => StorageKey.Create(Id, prefix, hash);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, UInt256 hash) => StorageKey.Create(Id, prefix, hash);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, ECPoint pubKey) => StorageKey.Create(Id, prefix, pubKey);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, UInt256 hash, UInt160 signer) => StorageKey.Create(Id, prefix, hash, signer);
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private protected StorageKey CreateStorageKey(byte prefix, UInt160 hash, int bigEndian) => StorageKey.Create(Id, prefix, hash, bigEndian);

        #endregion

        public static NativeContract? GetContract(UInt160 hash)
        {
            s_contractsDictionary.TryGetValue(hash, out var contract);
            return contract;
        }

        internal Dictionary<int, ContractMethodMetadata> GetContractMethods(ApplicationEngine engine)
        {
            var nativeContracts = engine.GetState(() => new NativeContractsCache());
            var currentAllowedMethods = nativeContracts.GetAllowedMethods(this, engine);
            return currentAllowedMethods.Methods;
        }

        internal async void Invoke(ApplicationEngine engine, byte version)
        {
            try
            {
                if (version != 0)
                    throw new InvalidOperationException($"The native contract of version {version} is not active.");
                var currentAllowedMethods = GetContractMethods(engine);
                var context = engine.CurrentContext!;
                var method = currentAllowedMethods[context.InstructionPointer];
                if (method.ActiveIn is not null && !engine.IsHardforkEnabled(method.ActiveIn.Value))
                    throw new InvalidOperationException($"Cannot call this method before hardfork {method.ActiveIn}.");
                if (method.DeprecatedIn is not null && engine.IsHardforkEnabled(method.DeprecatedIn.Value))
                    throw new InvalidOperationException($"Cannot call this method after hardfork {method.DeprecatedIn}.");
                var state = context.GetState<ExecutionContextState>();
                if (!state.CallFlags.HasFlag(method.RequiredCallFlags))
                    throw new InvalidOperationException($"Cannot call this method with the flag {state.CallFlags}.");
                if (!engine.IsHardforkEnabled(Hardfork.HF_Faun) ||
                    !Policy.IsWhitelistFeeContract(engine.SnapshotCache, Hash, method.Descriptor, out var fixedFee))
                {
                    engine.AddFee(
                        (method.CpuFee * engine.ExecFeePicoFactor) +
                        (method.StorageFee * engine.StoragePrice * ApplicationEngine.FeeFactor), false);
                }
                List<object?> parameters = new();
                if (method.NeedApplicationEngine) parameters.Add(engine);
                if (method.NeedSnapshot) parameters.Add(engine.SnapshotCache);
                for (int i = 0; i < method.Parameters.Length; i++)
                    parameters.Add(engine.Convert(context.EvaluationStack.Peek(i), method.Parameters[i]));
                object? returnValue = method.Handler.Invoke(this, parameters.ToArray());
                if (returnValue is ContractTask task)
                {
                    await task;
                    returnValue = task.GetResult();
                }
                for (int i = 0; i < method.Parameters.Length; i++)
                    context.EvaluationStack.Pop();
                if (method.Handler.ReturnType != typeof(void) && method.Handler.ReturnType != typeof(ContractTask))
                    context.EvaluationStack.Push(engine.Convert(returnValue));
            }
            catch (Exception ex)
            {
                engine.Throw(ex);
            }
        }

        public static bool IsNative(UInt160 hash)
        {
            return s_contractsDictionary.ContainsKey(hash);
        }

        internal virtual ContractTask InitializeAsync(ApplicationEngine engine, Hardfork? hardFork)
        {
            return ContractTask.CompletedTask;
        }

        internal virtual ContractTask OnPersistAsync(ApplicationEngine engine)
        {
            return ContractTask.CompletedTask;
        }

        internal virtual ContractTask PostPersistAsync(ApplicationEngine engine)
        {
            return ContractTask.CompletedTask;
        }
    }
}
