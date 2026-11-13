// Copyright (C) 2015-2026 The Neo Project.
//
// ApplicationEngine.Runtime.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

using Neo.Cryptography.ECC;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using Array = Neo.VM.Types.Array;

namespace Neo.SmartContract
{
    partial class ApplicationEngine
    {
        /// <summary>The maximum length of event name.</summary>
        public const int MaxEventName = 32;
        /// <summary>The maximum size of notification objects.</summary>
        public const int MaxNotificationSize = 1024;
        /// <summary>The maximum number of notifications per application execution.</summary>
        public const int MaxNotificationCount = 512;

        private uint randomTimes = 0;

        public static readonly InteropDescriptor System_Runtime_Platform = Register("System.Runtime.Platform", nameof(GetPlatform), 1 << 3, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetNetwork = Register("System.Runtime.GetNetwork", nameof(GetNetwork), 1 << 3, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetAddressVersion = Register("System.Runtime.GetAddressVersion", nameof(GetAddressVersion), 1 << 3, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetTrigger = Register("System.Runtime.GetTrigger", nameof(Trigger), 1 << 3, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetTime = Register("System.Runtime.GetTime", nameof(GetTime), 1 << 3, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetScriptContainer = Register("System.Runtime.GetScriptContainer", nameof(GetScriptContainer), 1 << 3, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetExecutingScriptHash = Register("System.Runtime.GetExecutingScriptHash", nameof(CurrentScriptHash), 1 << 4, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetCallingScriptHash = Register("System.Runtime.GetCallingScriptHash", nameof(CallingScriptHash), 1 << 4, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetEntryScriptHash = Register("System.Runtime.GetEntryScriptHash", nameof(EntryScriptHash), 1 << 4, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_LoadScript = Register("System.Runtime.LoadScript", nameof(RuntimeLoadScript), 1 << 15, CallFlags.AllowCall);
        public static readonly InteropDescriptor System_Runtime_CheckWitness = Register("System.Runtime.CheckWitness", nameof(CheckWitness), 1 << 10, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetInvocationCounter = Register("System.Runtime.GetInvocationCounter", nameof(GetInvocationCounter), 1 << 4, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GetRandom = Register("System.Runtime.GetRandom", nameof(GetRandom), 0, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_Log = Register("System.Runtime.Log", nameof(RuntimeLog), 1 << 15, CallFlags.AllowNotify);
        public static readonly InteropDescriptor System_Runtime_Notify = Register("System.Runtime.Notify", nameof(RuntimeNotify), 1 << 15, CallFlags.AllowNotify);
        public static readonly InteropDescriptor System_Runtime_GetNotifications = Register("System.Runtime.GetNotifications", nameof(GetNotifications), 1 << 12, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_GasLeft = Register("System.Runtime.GasLeft", nameof(GasLeft), 1 << 4, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_BurnGas = Register("System.Runtime.BurnGas", nameof(BurnGas), 1 << 4, CallFlags.None);
        public static readonly InteropDescriptor System_Runtime_CurrentSigners = Register("System.Runtime.CurrentSigners", nameof(GetCurrentSigners), 1 << 4, CallFlags.None);

        internal protected static string GetPlatform() => "NEO";
        internal protected uint GetNetwork() => ProtocolSettings.Network;
        internal protected byte GetAddressVersion() => ProtocolSettings.AddressVersion;

        protected internal ulong GetTime()
        {
            if (PersistingBlock is null)
                throw new InvalidOperationException("GetTime can only be called with Application trigger.");
            return PersistingBlock.Timestamp;
        }

        protected internal StackItem GetScriptContainer()
        {
            if (ScriptContainer is not IInteroperable interop) throw new InvalidOperationException();
            return interop.ToStackItem();
        }

        protected internal void RuntimeLoadScript(byte[] script, CallFlags callFlags, Array args)
        {
            if ((callFlags & ~CallFlags.All) != 0)
                throw new ArgumentOutOfRangeException(nameof(callFlags), $"Invalid call flags: {callFlags}");

            ExecutionContextState state = CurrentContext!.GetState<ExecutionContextState>();
            ExecutionContext context = LoadScript(new Script(script, true), configureState: p =>
            {
                p.CallingContext = CurrentContext;
                p.CallFlags = callFlags & state.CallFlags & CallFlags.ReadOnly;
                p.IsDynamicCall = true;
                p.ContractCallGasBudget = state.ContractCallGasBudget;
            });

            for (int i = args.Count - 1; i >= 0; i--)
                context.EvaluationStack.Push(args[i]);
        }

        protected internal bool CheckWitness(byte[] hashOrPubkey)
        {
            UInt160 hash = hashOrPubkey.Length switch
            {
                20 => new UInt160(hashOrPubkey),
                33 => Contract.CreateSignatureRedeemScript(ECPoint.DecodePoint(hashOrPubkey, ECCurve.Secp256r1)).ToScriptHash(),
                _ => throw new ArgumentException("Invalid hashOrPubkey length", nameof(hashOrPubkey))
            };
            return CheckWitnessInternal(hash);
        }

        protected internal bool CheckWitnessInternal(UInt160 hash)
        {
            // Native dispatch is permissionless and never supplies a user witness.
            if (IsHardforkEnabled(Hardfork.HF_SmartAccountV1) && hash == NativeContract.SmartAccount.Hash)
                return false;
            if (Trigger == TriggerType.Application && IsHardforkEnabled(Hardfork.HF_SmartAccountV1) &&
                NativeContract.SmartAccount.IsRegisteredProxy(SnapshotCache, hash) &&
                !(GetState<SmartAccountInvocationContext>()?.IsWitnessAuthorized(this, hash) ?? false))
                return false;
            if (hash.Equals(CallingScriptHash)) return true;

            if (ScriptContainer is Transaction tx)
            {
                Signer[] signers;
                OracleResponse? response = tx.GetAttribute<OracleResponse>();
                if (response is null)
                {
                    signers = tx.Signers;
                }
                else
                {
                    OracleRequest request = NativeContract.Oracle.GetRequest(SnapshotCache, response.Id)!;
                    signers = NativeContract.Ledger.GetTransaction(SnapshotCache, request.OriginalTxid)!.Signers;
                }
                Signer? signer = signers.FirstOrDefault(p => p.Account.Equals(hash));
                if (signer is null) return false;
                foreach (WitnessRule rule in signer.GetAllRules())
                {
                    if (rule.Condition.Match(this))
                        return rule.Action == WitnessRuleAction.Allow;
                }
                return false;
            }

            if (ScriptContainer is null) return false;
            ValidateCallFlags(CallFlags.ReadStates);
            return ScriptContainer.GetScriptHashesForVerifying(SnapshotCache).Contains(hash);
        }

        protected internal int GetInvocationCounter()
        {
            if (!invocationCounter.TryGetValue(CurrentScriptHash!, out var counter))
            {
                invocationCounter[CurrentScriptHash!] = counter = 1;
            }
            return counter;
        }

        protected internal BigInteger GetRandom()
        {
            byte[] buffer;
            long price;
            if (IsHardforkEnabled(Hardfork.HF_Aspidochelone))
            {
                buffer = Cryptography.Helper.Murmur128(nonceData, ProtocolSettings.Network + randomTimes++);
                price = 1 << 13;
            }
            else
            {
                buffer = nonceData = Cryptography.Helper.Murmur128(nonceData, ProtocolSettings.Network);
                price = 1 << 4;
            }
            AddFee(price * _execFeeFactor, false);
            return new BigInteger(buffer, isUnsigned: true);
        }

        protected internal void RuntimeLog(byte[] state)
        {
            if (state.Length > MaxNotificationSize)
                throw new ArgumentException($"Notification size {state.Length} exceeds maximum allowed size of {MaxNotificationSize} bytes", nameof(state));
            try
            {
                string message = state.ToStrictUtf8String();
                Log?.Invoke(this, new LogEventArgs(ScriptContainer, CurrentScriptHash!, message));
            }
            catch
            {
                throw new ArgumentException("Failed to convert byte array to string: Invalid UTF-8 sequence", nameof(state));
            }
        }

        protected internal void RuntimeNotify(byte[] eventName, Array state)
        {
            if (!IsHardforkEnabled(Hardfork.HF_Basilisk))
            {
                RuntimeNotifyV1(eventName, state);
                return;
            }
            if (eventName.Length > MaxEventName)
                throw new ArgumentException($"Event name size {eventName.Length} exceeds maximum allowed size of {MaxEventName} bytes", nameof(eventName));

            string name = eventName.ToStrictUtf8String();
            ContractState? contract = CurrentContext!.GetState<ExecutionContextState>().Contract;
            if (contract is null)
                throw new InvalidOperationException("Notifications are not allowed in dynamic scripts.");
            var @event = contract.Manifest.Abi.Events.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.Ordinal));
            if (@event is null)
                throw new InvalidOperationException($"Event `{name}` does not exist.");
            if (@event.Parameters.Length != state.Count)
                throw new InvalidOperationException("The number of the arguments does not match the formal parameters of the event.");
            for (int i = 0; i < @event.Parameters.Length; i++)
            {
                var p = @event.Parameters[i];
                if (!CheckItemType(state[i], p.Type))
                    throw new InvalidOperationException($"The type of the argument `{p.Name}` does not match the formal parameter.");
            }
            using MemoryStream ms = new(MaxNotificationSize);
            using BinaryWriter writer = new(ms, Utility.StrictUTF8, true);
            BinarySerializer.Serialize(writer, state, MaxNotificationSize, Limits.MaxStackSize);
            SendNotification(CurrentScriptHash!, name, state);
        }

        protected internal void RuntimeNotifyV1(byte[] eventName, Array state)
        {
            if (eventName.Length > MaxEventName)
                throw new ArgumentException($"Event name size {eventName.Length} exceeds maximum allowed size of {MaxEventName} bytes", nameof(eventName));
            if (CurrentContext!.GetState<ExecutionContextState>().Contract is null)
                throw new InvalidOperationException("Notifications are not allowed in dynamic scripts.");
            using MemoryStream ms = new(MaxNotificationSize);
            using BinaryWriter writer = new(ms, Utility.StrictUTF8, true);
            BinarySerializer.Serialize(writer, state, MaxNotificationSize, Limits.MaxStackSize);
            SendNotification(CurrentScriptHash!, eventName.ToStrictUtf8String(), state);
        }

        protected internal void SendNotification(UInt160 hash, string eventName, Array state)
        {
            notifications ??= new List<NotifyEventArgs>();
            if (IsHardforkEnabled(Hardfork.HF_Echidna) && Trigger == TriggerType.Application && notifications.Count >= MaxNotificationCount)
            {
                throw new InvalidOperationException($"Maximum number of notifications `{MaxNotificationCount}` is reached.");
            }
            NotifyEventArgs notification = new(ScriptContainer, hash, eventName, (Array)state.DeepCopy(asImmutable: true));
            Notify?.Invoke(this, notification);
            notifications.Add(notification);
            CurrentContext!.GetState<ExecutionContextState>().NotificationCount++;
        }

        protected internal Array GetNotifications(UInt160? hash)
        {
            IEnumerable<NotifyEventArgs> notifications = Notifications;
            if (hash != null)
                notifications = notifications.Where(p => p.ScriptHash == hash);
            var array = notifications.ToArray();
            if (array.Length > Limits.MaxStackSize) throw new InvalidOperationException();
            Array notifyArray = new();
            foreach (var notify in array)
            {
                notifyArray.Add(notify.ToStackItem(this));
            }
            return notifyArray;
        }

        protected internal void BurnGas(long datoshi)
        {
            if (datoshi <= 0)
                throw new InvalidOperationException("GAS must be positive.");
            AddFee(datoshi, true);
        }

        protected internal Signer[]? GetCurrentSigners()
        {
            if (ScriptContainer is Transaction tx)
                return tx.Signers;
            return null;
        }

        private static bool CheckItemType(StackItem item, ContractParameterType type)
        {
            StackItemType aType = item.Type;
            if (aType == StackItemType.Pointer) return false;
            switch (type)
            {
                case ContractParameterType.Any:
                    return true;
                case ContractParameterType.Boolean:
                    return aType == StackItemType.Boolean;
                case ContractParameterType.Integer:
                    return aType == StackItemType.Integer;
                case ContractParameterType.ByteArray:
                    return aType is StackItemType.Any or StackItemType.ByteString or StackItemType.Buffer;
                case ContractParameterType.String:
                    {
                        if (aType is StackItemType.ByteString or StackItemType.Buffer)
                        {
                            try
                            {
                                _ = item.GetSpan().ToStrictUtf8String();
                                return true;
                            }
                            catch { }
                        }
                        return false;
                    }
                case ContractParameterType.Hash160:
                    if (aType == StackItemType.Any) return true;
                    if (aType != StackItemType.ByteString && aType != StackItemType.Buffer) return false;
                    return item.GetSpan().Length == UInt160.Length;
                case ContractParameterType.Hash256:
                    if (aType == StackItemType.Any) return true;
                    if (aType != StackItemType.ByteString && aType != StackItemType.Buffer) return false;
                    return item.GetSpan().Length == UInt256.Length;
                case ContractParameterType.PublicKey:
                    if (aType == StackItemType.Any) return true;
                    if (aType != StackItemType.ByteString && aType != StackItemType.Buffer) return false;
                    return item.GetSpan().Length == 33;
                case ContractParameterType.Signature:
                    if (aType == StackItemType.Any) return true;
                    if (aType != StackItemType.ByteString && aType != StackItemType.Buffer) return false;
                    return item.GetSpan().Length == 64;
                case ContractParameterType.Array:
                    return aType is StackItemType.Any or StackItemType.Array or StackItemType.Struct;
                case ContractParameterType.Map:
                    return aType is StackItemType.Any or StackItemType.Map;
                case ContractParameterType.InteropInterface:
                    return aType is StackItemType.Any or StackItemType.InteropInterface;
                default:
                    return false;
            }
        }
    }
}
