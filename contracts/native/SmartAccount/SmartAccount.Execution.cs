// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccount.Execution.cs file belongs to the neo project and is free
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

#pragma warning disable IDE0051

using Neo.Extensions;
using Neo.IO;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.Numerics;
using Array = Neo.VM.Types.Array;
using Boolean = Neo.VM.Types.Boolean;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// Operation execution kernel of the native core (spec §4/§5/§6/§3.6/§11).
    ///
    /// Execution order (spec §3.6): validate → consume nonce → preCheck in hook
    /// order → close module authorization → dispatch target → close target
    /// authorization → postCheck in reverse order → validator completion
    /// (approved members only) → success event. Any validation rejection, hook
    /// rejection, lifecycle fault, code-identity change or gas overrun faults
    /// the whole transaction; a target Boolean false is a normal result and
    /// still runs every postCheck and completion.
    /// </summary>
    public sealed partial class SmartAccount
    {
        private static readonly BigInteger NonceExhaustionSentinel = BigInteger.One << 64;

        /// <summary>Approval bookkeeping of one validation pass.</summary>
        private sealed class ValidationOutcome
        {
            internal ModuleInstance? Module;
            internal ThresholdPolicyRecord? Policy;
            internal BigInteger[] ApprovedIds = [];
            internal ModuleInstance[] ApprovedModules = [];
        }

        // ========================================================================
        // 1. Nonce cursors (0x56) and namespace digests (0x5C)
        // ========================================================================

        private BigInteger ReadNonceCursor(IReadOnlyStore snapshot, UInt160 accountId, byte[] channel)
        {
            if (!TryRead(snapshot, SmartAccountProtocol.GetNonceCursorKey(accountId, channel), out var value))
                return BigInteger.Zero;
            MemoryReader reader = new(value);
            if (BinarySerializer.Deserialize(ref reader, 32, 8) is not Integer cursor)
                throw new FormatException("The nonce cursor record is malformed.");
            return cursor.GetInteger();
        }

        private void WriteNonceCursor(ApplicationEngine engine, UInt160 accountId, byte[] channel,
            BigInteger cursor) =>
            Write(engine, SmartAccountProtocol.GetNonceCursorKey(accountId, channel),
                BinarySerializer.Serialize(new Integer(cursor), 32, 8));

        /// <summary>
        /// Read-only acceptance check: the channel must not be exhausted, the
        /// sequence must equal the cursor, and a persisted 0x5C derivation must
        /// match this one (truncation collision fails closed).
        /// </summary>
        private void AssertOperationNonceAcceptable(IReadOnlyStore snapshot, UInt160 accountId, byte[] channel,
            ReadOnlySpan<byte> namespaceDigest, BigInteger sequence)
        {
            BigInteger cursor = ReadNonceCursor(snapshot, accountId, channel);
            Require(cursor != NonceExhaustionSentinel, SmartAccountModuleProtocol.ErrorNonceExhausted);
            Require(sequence == cursor, SmartAccountModuleProtocol.ErrorNonceInvalid);
            if (TryRead(snapshot, SmartAccountProtocol.GetNonceNamespaceKey(accountId, channel), out var stored))
                Require(stored.Span.SequenceEqual(namespaceDigest),
                    SmartAccountModuleProtocol.ErrorNonceChannelCollision);
        }

        /// <summary>
        /// Consumes the nonce after successful validation: first use persists
        /// the full 0x5C derivation and emits NonceChannelOpened; reaching the
        /// 2^64 sentinel kills the channel with no wrap-around.
        /// </summary>
        private void ConsumeOperationNonce(ApplicationEngine engine, UInt160 accountId, byte[] channel,
            ReadOnlySpan<byte> namespaceDigest, BigInteger sequence)
        {
            BigInteger cursor = ReadNonceCursor(engine.SnapshotCache, accountId, channel);
            Require(cursor != NonceExhaustionSentinel, SmartAccountModuleProtocol.ErrorNonceExhausted);
            Require(sequence == cursor, SmartAccountModuleProtocol.ErrorNonceInvalid);
            if (!TryRead(engine.SnapshotCache, SmartAccountProtocol.GetNonceNamespaceKey(accountId, channel),
                    out var stored))
            {
                Write(engine, SmartAccountProtocol.GetNonceNamespaceKey(accountId, channel), namespaceDigest.ToArray());
                Notify(engine, SmartAccountModuleProtocol.EventNameNonceChannelOpened, accountId.ToArray(),
                    namespaceDigest.ToArray());
            }
            else
            {
                Require(stored.Span.SequenceEqual(namespaceDigest),
                    SmartAccountModuleProtocol.ErrorNonceChannelCollision);
            }

            BigInteger next = cursor + 1;
            if (next >= NonceExhaustionSentinel)
            {
                next = NonceExhaustionSentinel;
                Notify(engine, SmartAccountModuleProtocol.EventNameNonceChannelExhausted, accountId.ToArray(),
                    namespaceDigest.ToArray());
            }
            WriteNonceCursor(engine, accountId, channel, next);
        }

        private static byte[] ChannelBytes(BigInteger channel)
        {
            Require(channel >= 0 && (channel >> 191) == BigInteger.Zero,
                SmartAccountModuleProtocol.ErrorNonceChannelCollision);
            byte[] encoded = new byte[SmartAccountModuleProtocol.NonceChannelSize];
            for (int i = encoded.Length - 1; i >= 0; i--)
            {
                encoded[i] = (byte)(channel & 0xFF);
                channel >>= 8;
            }
            return encoded;
        }

        /// <summary>The packed nonce of the channel derived for the account's current epoch.</summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private BigInteger GetNonce(ApplicationEngine engine, UInt160 accountId, BigInteger validatorId,
            byte[] nonceSubkey)
        {
            RequireAccountId(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            if (nonceSubkey is null || nonceSubkey.Length != SmartAccountModuleProtocol.NonceSubkeySize)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            BigInteger generation = ResolveCredentialGeneration(engine.SnapshotCache, accountId, validatorId);
            byte[] digest = SmartAccountProtocol.ComputeNonceNamespaceDigest(accountId, Hash,
                new BigInteger(control.AuthorityEpoch), validatorId, generation, nonceSubkey);
            byte[] channel = SmartAccountProtocol.DeriveChannel(digest);
            BigInteger sequence = ReadNonceCursor(engine.SnapshotCache, accountId, channel);
            return (new BigInteger(channel, isUnsigned: true, isBigEndian: true) << 64) | sequence;
        }

        /// <summary>The current sequence cursor of an explicit channel.</summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private BigInteger GetNonceSequence(ApplicationEngine engine, UInt160 accountId, BigInteger channel)
        {
            RequireAccountId(accountId);
            _ = RequireControl(engine.SnapshotCache, accountId);
            return ReadNonceCursor(engine.SnapshotCache, accountId, ChannelBytes(channel));
        }

        // ========================================================================
        // 2. Routing resolution (spec §3.5)
        // ========================================================================

        private ValidationOutcome ResolveRouting(IReadOnlyStore snapshot, UInt160 accountId,
            AccountControl control, BigInteger validatorId, BigInteger credentialGeneration)
        {
            ValidationOutcome outcome = new();
            if (validatorId == BigInteger.Zero)
            {
                // Built-in route: gated by the default operation authorization
                // switch — there is no automatic custody fallback.
                Require(control.DefaultOperationAuthorization, SmartAccountModuleProtocol.ErrorModuleNotRoutable);
                return outcome;
            }
            ModuleInstance? module = TryModuleInstance(snapshot, accountId, validatorId);
            if (module is not null)
            {
                Require(module.IsValidator, SmartAccountModuleProtocol.ErrorModuleNotRoutable);
                // Threshold-policy members are never independently routable.
                Require(!IsMemberOfActivePolicy(module), SmartAccountModuleProtocol.ErrorModuleNotRoutable);
                Require(credentialGeneration == module.CredentialGeneration,
                    SmartAccountModuleProtocol.ErrorCredentialStale);
                outcome.Module = module;
                return outcome;
            }
            ThresholdPolicyRecord? policy = TryThresholdPolicy(snapshot, accountId, validatorId);
            Require(policy is not null && policy.Active, SmartAccountModuleProtocol.ErrorValidatorNotFound);
            Require(credentialGeneration == policy!.CredentialGeneration,
                SmartAccountModuleProtocol.ErrorCredentialStale);
            outcome.Policy = policy;
            return outcome;
        }

        // ========================================================================
        // 3. Built-in operation signature (spec §5/§8)
        // ========================================================================

        /// <summary>
        /// Built-in (validatorId = 0) operation signature: the §8 message profile
        /// reused in operation mode — canonical P-256 scripts and 64-byte
        /// signatures over the OPERATION digest, threshold per 0x57.
        /// </summary>
        private bool VerifyBuiltInOperationSignature(IReadOnlyStore snapshot, UInt160 accountId,
            ReadOnlySpan<byte> digest, ReadOnlySpan<byte> signature)
        {
            MessageSubjectRecord? subjects = TryMessageSubjects(snapshot, accountId);
            if (subjects is null || subjects.Subjects.Length == 0 || subjects.Threshold < 1) return false;
            if (signature.Length == 0 || signature.Length > SmartAccountModuleProtocol.SignatureBytesMax) return false;

            StackItem decoded;
            try
            {
                MemoryReader reader = new(signature.ToArray());
                decoded = BinarySerializer.Deserialize(ref reader,
                    SmartAccountModuleProtocol.SignatureBytesMax, SmartAccountModuleProtocol.MessageSubjectKeysMax + 8);
            }
            catch
            {
                return false;
            }
            if (decoded is not Array envelope || envelope.Count != 4) return false;
            if (envelope[0] is not Integer version
                || version.GetInteger() != SmartAccountModuleProtocol.ModuleProtocolVersion) return false;
            if (envelope[1] is not Integer validator || validator.GetInteger() != BigInteger.Zero) return false;
            if (envelope[2] is not Integer generation
                || generation.GetInteger() != new BigInteger(subjects.SubjectRevision)) return false;
            if (envelope[3] is not Array pairs
                || pairs.Count is < 1 or > SmartAccountModuleProtocol.MessageSubjectKeysMax) return false;
            return (ulong)CountBuiltInApprovals(subjects, digest, pairs) >= subjects.Threshold;
        }

        // ========================================================================
        // 4. Validation pass (read-only callbacks, shared aggregate pool)
        // ========================================================================

        private async ContractTask ValidateAsync(ApplicationEngine engine, UInt160 accountId, Array operation,
            ReadOnlyMemory<byte> digest, ValidationOutcome outcome)
        {
            if (outcome.Policy is not null)
            {
                // Threshold policy: every member is invoked under the shared
                // parent validation budget; approval receipts are kept locally.
                BigInteger[] members = outcome.Policy.MemberIds;
                outcome.ApprovedIds = new BigInteger[members.Length];
                outcome.ApprovedModules = new ModuleInstance[members.Length];
                int approvals = 0;
                for (int i = 0; i < members.Length; i++)
                {
                    ModuleInstance member = RequireActiveValidator(engine.SnapshotCache, accountId, members[i]);
                    if (!await CallValidatorValidateUserOpAsync(engine, accountId, members[i], member, operation,
                            digest)) continue;
                    outcome.ApprovedIds[approvals] = members[i];
                    outcome.ApprovedModules[approvals] = member;
                    approvals++;
                }
                Require(approvals >= (int)outcome.Policy.Threshold,
                    SmartAccountModuleProtocol.ErrorValidationRejected);
                return;
            }
            if (outcome.Module is not null)
            {
                Require(await CallValidatorValidateUserOpAsync(engine, accountId,
                        operation[SmartAccountModuleProtocol.OpValidatorId].GetInteger(),
                        outcome.Module, operation, digest),
                    SmartAccountModuleProtocol.ErrorValidationRejected);
                return;
            }
            // Built-in route (validatorId = 0): §8 profile over the digest.
            Require(VerifyBuiltInOperationSignature(engine.SnapshotCache, accountId, digest.Span,
                    operation[SmartAccountModuleProtocol.OpSignature].GetSpan()),
                SmartAccountModuleProtocol.ErrorValidationRejected);
        }

        /// <summary>
        /// Every hook proof must reference a hook of the execution snapshot;
        /// proofs for hooks that will not run are rejected.
        /// </summary>
        private static void VerifyHookProofsAgainstSnapshot(Array operation, BigInteger[] hookIds)
        {
            if (operation[SmartAccountModuleProtocol.OpHookProofs] is not Array proofs) return;
            foreach (StackItem item in proofs)
            {
                if (item is not Array pair || pair.Count != 2) return;
                BigInteger hookId = pair[0].GetInteger();
                bool found = false;
                foreach (BigInteger id in hookIds)
                {
                    if (id != hookId) continue;
                    found = true;
                    break;
                }
                Require(found, SmartAccountModuleProtocol.ErrorProofInvalid);
            }
        }

        // ========================================================================
        // 5. Read-only preview and digest query (spec §3.3)
        // ========================================================================

        /// <summary>
        /// Public digest query: the exact digest a signer must sign for this
        /// operation on this account under the current core.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private byte[] GetOperationDigest(ApplicationEngine engine, UInt160 accountId, Array operation)
        {
            RequireAccountId(accountId);
            _ = RequireControl(engine.SnapshotCache, accountId);
            Array op = SmartAccountProtocol.ValidateUserOperation(operation);
            return SmartAccountProtocol.ComputeOperationDigest(engine.ProtocolSettings.Network, Hash, accountId, op,
                op[SmartAccountModuleProtocol.OpValidatorId].GetInteger(),
                op[SmartAccountModuleProtocol.OpCredentialGeneration].GetInteger(),
                op[SmartAccountModuleProtocol.OpAuthorityEpoch].GetInteger(),
                op[SmartAccountModuleProtocol.OpConfigurationNonce].GetInteger());
        }

        /// <summary>
        /// Read-only, real-verification preview: full envelope validation,
        /// epoch/nonce/deadline checks and actual signature verification, with
        /// NO nonce consumption, NO hooks and NO state changes. Returns
        /// [accepted, operationDigest]. Threshold policies are not previewed
        /// member-by-member: the endpoint never orchestrates policy members.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private async ContractTask<Array> ValidateUserOp(ApplicationEngine engine, UInt160 accountId, Array operation)
        {
            RequireAccountId(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            Array op = SmartAccountProtocol.ValidateUserOperation(operation);

            BigInteger validatorId = op[SmartAccountModuleProtocol.OpValidatorId].GetInteger();
            BigInteger credentialGeneration =
                op[SmartAccountModuleProtocol.OpCredentialGeneration].GetInteger();
            BigInteger authorityEpoch = op[SmartAccountModuleProtocol.OpAuthorityEpoch].GetInteger();
            BigInteger configurationNonce = op[SmartAccountModuleProtocol.OpConfigurationNonce].GetInteger();
            BigInteger nonce = op[SmartAccountModuleProtocol.OpNonce].GetInteger();

            byte[] digest = SmartAccountProtocol.ComputeOperationDigest(engine.ProtocolSettings.Network, Hash,
                accountId, op, validatorId, credentialGeneration, authorityEpoch, configurationNonce);

            bool accepted = control.Status == SmartAccountStatus.Active
                && new BigInteger(Now(engine)) <= op[SmartAccountModuleProtocol.OpDeadline].GetInteger()
                && authorityEpoch == new BigInteger(control.AuthorityEpoch)
                && configurationNonce == new BigInteger(control.ConfigurationNonce);

            ValidationOutcome? outcome = null;
            if (accepted)
            {
                try
                {
                    byte[] namespaceDigest = SmartAccountProtocol.ComputeNonceNamespaceDigest(accountId, Hash,
                        authorityEpoch, validatorId, credentialGeneration,
                        op[SmartAccountModuleProtocol.OpNonceSubkey].GetSpan());
                    byte[] channel = SmartAccountProtocol.DeriveChannel(namespaceDigest);
                    Require((nonce >> 64) == new BigInteger(channel, isUnsigned: true, isBigEndian: true),
                        SmartAccountModuleProtocol.ErrorNonceInvalid);
                    AssertOperationNonceAcceptable(engine.SnapshotCache, accountId, channel, namespaceDigest,
                        SmartAccountProtocol.SequenceFromNonce(nonce));
                    outcome = ResolveRouting(engine.SnapshotCache, accountId, control, validatorId,
                        credentialGeneration);
                }
                catch
                {
                    accepted = false;
                }
            }

            if (accepted && outcome is not null && outcome.Policy is null)
            {
                using var locked = Context(engine).EnterAccount(accountId);
                try
                {
                    if (outcome.Module is null)
                    {
                        accepted = VerifyBuiltInOperationSignature(engine.SnapshotCache, accountId, digest,
                            op[SmartAccountModuleProtocol.OpSignature].GetSpan());
                    }
                    else
                    {
                        accepted = await CallValidatorValidateUserOpAsync(engine, accountId, validatorId,
                            outcome.Module, op, digest);
                    }
                }
                catch
                {
                    accepted = false;
                }
            }
            else if (outcome?.Policy is not null)
            {
                accepted = false;
            }

            return new Array(new StackItem[] { accepted, digest });
        }

        // ========================================================================
        // 6. Execution entrypoints (spec §3.3/§3.6)
        // ========================================================================

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask<StackItem> ExecuteUserOp(ApplicationEngine engine, UInt160 accountId,
            Array operation)
        {
            RequireApplication(engine);
            return (await ExecuteUserOpCoreAsync(engine, accountId, operation, false))!;
        }

        /// <summary>
        /// Batch execution: ≤ 32 operations, one atomic transaction — a fault on
        /// any operation reverts the whole envelope. One envelope spends ONE
        /// aggregate gas budget, so the execution state is opened here and
        /// inherited by every operation instead of reset per operation.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask<Array> ExecuteUserOps(ApplicationEngine engine, UInt160 accountId,
            Array operations)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            if (operations is null || operations.Type != StackItemType.Array
                || operations.Count is 0 or > SmartAccountModuleProtocol.MaxOperationsPerEnvelope)
                throw new FormatException("A batch must be an exact non-empty Array of at most 32 operations.");
            engine.AddNativeCpuFee(1 << 12);
            _ = BinarySerializer.Serialize(operations, SmartAccountModuleProtocol.EnvelopeEncodedSizeMax,
                SmartAccountModuleProtocol.EnvelopeEncodedSizeMax);

            SmartAccountInvocationContext context = Context(engine);
            bool ownsExecution = !context.TryGetExecution(accountId, out _);
            if (ownsExecution) OpenAggregatePools(context, accountId);
            Array results = new();
            try
            {
                foreach (StackItem item in operations)
                {
                    if (item.Type != StackItemType.Array || item is not Array operation)
                        throw new FormatException("A batch entry must be an operation Array.");
                    results.Add((await ExecuteUserOpCoreAsync(engine, accountId, operation, true))!);
                }
            }
            finally
            {
                if (ownsExecution) context.CloseExecution(accountId);
            }
            return results;
        }

        private static void OpenAggregatePools(SmartAccountInvocationContext context, UInt160 accountId) =>
            context.OpenExecution(accountId,
                SmartAccountModuleProtocol.ValidationAggregateGasLimit,
                SmartAccountModuleProtocol.HookAggregateGasLimit,
                SmartAccountModuleProtocol.CompletionAggregateGasLimit);

        private async ContractTask<StackItem> ExecuteUserOpCoreAsync(ApplicationEngine engine, UInt160 accountId,
            Array operation, bool inheritedEnvelope)
        {
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            SmartAccountInvocationContext context = Context(engine);
            bool ownsExecution = !inheritedEnvelope && !context.TryGetExecution(accountId, out _);
            if (ownsExecution) OpenAggregatePools(context, accountId);
            try
            {
                Array op = SmartAccountProtocol.ValidateUserOperation(operation);
                AccountControl control = RequireControl(engine.SnapshotCache, accountId);
                _ = RequireActive(control);

                BigInteger validatorId = op[SmartAccountModuleProtocol.OpValidatorId].GetInteger();
                BigInteger credentialGeneration =
                    op[SmartAccountModuleProtocol.OpCredentialGeneration].GetInteger();
                BigInteger authorityEpoch = op[SmartAccountModuleProtocol.OpAuthorityEpoch].GetInteger();
                BigInteger configurationNonce = op[SmartAccountModuleProtocol.OpConfigurationNonce].GetInteger();
                BigInteger nonce = op[SmartAccountModuleProtocol.OpNonce].GetInteger();
                Require(new BigInteger(Now(engine)) <= op[SmartAccountModuleProtocol.OpDeadline].GetInteger(),
                    SmartAccountModuleProtocol.ErrorDeadlineExpired);
                Require(authorityEpoch == new BigInteger(control.AuthorityEpoch),
                    SmartAccountModuleProtocol.ErrorEpochStale);
                Require(configurationNonce == new BigInteger(control.ConfigurationNonce),
                    SmartAccountModuleProtocol.ErrorConfigurationNonceStale);

                ValidationOutcome outcome = ResolveRouting(engine.SnapshotCache, accountId, control, validatorId,
                    credentialGeneration);

                byte[] namespaceDigest = SmartAccountProtocol.ComputeNonceNamespaceDigest(accountId, Hash,
                    authorityEpoch, validatorId, credentialGeneration,
                    op[SmartAccountModuleProtocol.OpNonceSubkey].GetSpan());
                byte[] channel = SmartAccountProtocol.DeriveChannel(namespaceDigest);
                Require((nonce >> 64) == new BigInteger(channel, isUnsigned: true, isBigEndian: true),
                    SmartAccountModuleProtocol.ErrorNonceInvalid);
                BigInteger sequence = SmartAccountProtocol.SequenceFromNonce(nonce);
                AssertOperationNonceAcceptable(engine.SnapshotCache, accountId, channel, namespaceDigest, sequence);

                byte[] digest = SmartAccountProtocol.ComputeOperationDigest(engine.ProtocolSettings.Network, Hash,
                    accountId, op, validatorId, credentialGeneration, authorityEpoch, configurationNonce);

                HookOrderRecord order = ReadHookOrder(engine.SnapshotCache, accountId);
                VerifyHookProofsAgainstSnapshot(op, order.HookIds);

                // ---- Phase: Validation ----
                await ValidateAsync(engine, accountId, op, digest, outcome);
                context.ClosePhase(accountId);

                // ---- Nonce consumption (all validations passed) ----
                ConsumeOperationNonce(engine, accountId, channel, namespaceDigest, sequence);

                // ---- Phase: HookPre (snapshot order) ----
                int hookCount = order.HookIds.Length;
                byte[][] hookData = new byte[hookCount][];
                ModuleInstance[] hookModules = new ModuleInstance[hookCount];
                for (int i = 0; i < hookCount; i++)
                {
                    BigInteger hookId = order.HookIds[i];
                    ModuleInstance hook = RequireModuleInstance(engine.SnapshotCache, accountId, hookId);
                    hookModules[i] = hook;
                    hookData[i] = (await CallHookPreCheckAsync(engine, accountId, hookId, hook, op))!;
                }
                context.ClosePhase(accountId);

                // ---- Phase: TargetDispatch (all module authorization closed) ----
                UInt160 target = new(op[SmartAccountModuleProtocol.OpTarget].GetSpan());
                string method = Utility.StrictUTF8.GetString(op[SmartAccountModuleProtocol.OpMethod].GetSpan());
                StackItem[] arguments = [.. (Array)CloneValue(engine, op[SmartAccountModuleProtocol.OpArgs])];
                var task = engine.CallFromNativeContractRawAsync(Hash, target, method, CallFlags.All, false,
                    arguments);
                var anchor = engine.CurrentContext!.GetState<ExecutionContextState>();
                StackItem result;
                using (context.EnterTarget(accountId, target, anchor))
                    result = (await task) ?? StackItem.Null;
                context.ClosePhase(accountId);

                // ---- Phase: HookPost (reverse snapshot order, original set) ----
                for (int i = hookCount - 1; i >= 0; i--)
                    await CallHookPostCheckAsync(engine, accountId, order.HookIds[i], hookModules[i], op, result,
                        hookData[i]);
                context.ClosePhase(accountId);

                // ---- Phase: Completion (approved routing subject only) ----
                if (outcome.Policy is not null)
                {
                    for (int i = 0; i < outcome.ApprovedIds.Length; i++)
                    {
                        if (outcome.ApprovedIds[i] == BigInteger.Zero) break;
                        await CallValidatorCompletionAsync(engine, accountId, outcome.ApprovedIds[i],
                            outcome.ApprovedModules[i], op, result);
                    }
                }
                else if (outcome.Module is not null)
                {
                    await CallValidatorCompletionAsync(engine, accountId, validatorId, outcome.Module, op, result);
                }
                context.ClosePhase(accountId);

                Notify(engine, "UserOpExecuted", accountId.ToArray(), target.ToArray(), method, nonce);
                return result;
            }
            finally
            {
                if (ownsExecution) context.CloseExecution(accountId);
            }
        }

        // ========================================================================
        // 7. Verification-trigger gate (spec §3.6/§5)
        // ========================================================================

        /// <summary>
        /// The account's proxy verification script calls this. Under the
        /// transaction Verification trigger it fully validates every operation
        /// of the envelope — envelope shape, counters, nonces, deadline and
        /// signature — without writing state. Under the Application trigger it
        /// authorizes ONLY the account's own dispatching operation: the caller
        /// must be the proxy script and the proxy must be invoked from inside
        /// that account's target dispatch.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadOnly)]
        private async ContractTask<bool> Verify(ApplicationEngine engine, UInt160 accountId)
        {
            if (engine.ScriptContainer is not Transaction)
                throw new InvalidOperationException("SmartAccount verification requires a transaction.");
            RequireAccountId(accountId);
            UInt160 address = SmartAccountProtocol.GetAccountAddress(accountId);
            SmartAccountInvocationContext context = Context(engine);

            if (engine.Trigger == TriggerType.Application)
            {
                if (engine.CallingScriptHash != address || !context.IsTargetAuthorized(engine, accountId))
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorUnauthorized);
                return true;
            }
            if (engine.Trigger != TriggerType.Verification)
                throw new InvalidOperationException("SmartAccount verification requires a transaction Verification trigger.");
            if (engine.CallingScriptHash != address)
                throw new InvalidOperationException("Verification must originate from the account's exact proxy script.");
            Transaction tx = (Transaction)engine.ScriptContainer;
            if (tx.Sender == address)
                throw new InvalidOperationException("The SmartAccount proxy cannot be the transaction fee payer.");

            using var locked = context.EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            if (control.Status != SmartAccountStatus.Active)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorAccountStatus);
            SmartAccountEnvelope envelope = SmartAccountEnvelope.Parse(accountId, tx.Script.Span);

            Dictionary<BigInteger, BigInteger> cursors = new();
            ulong now = Now(engine);
            for (int i = 0; i < envelope.Count; i++)
            {
                Array op = envelope.GetOperation(i);
                BigInteger validatorId = op[SmartAccountModuleProtocol.OpValidatorId].GetInteger();
                BigInteger credentialGeneration =
                    op[SmartAccountModuleProtocol.OpCredentialGeneration].GetInteger();
                BigInteger authorityEpoch = op[SmartAccountModuleProtocol.OpAuthorityEpoch].GetInteger();
                BigInteger configurationNonce = op[SmartAccountModuleProtocol.OpConfigurationNonce].GetInteger();
                BigInteger nonce = op[SmartAccountModuleProtocol.OpNonce].GetInteger();
                Require(new BigInteger(now) <= op[SmartAccountModuleProtocol.OpDeadline].GetInteger(),
                    SmartAccountModuleProtocol.ErrorDeadlineExpired);
                Require(authorityEpoch == new BigInteger(control.AuthorityEpoch),
                    SmartAccountModuleProtocol.ErrorEpochStale);
                Require(configurationNonce == new BigInteger(control.ConfigurationNonce),
                    SmartAccountModuleProtocol.ErrorConfigurationNonceStale);
                ValidationOutcome outcome = ResolveRouting(engine.SnapshotCache, accountId, control, validatorId,
                    credentialGeneration);

                byte[] namespaceDigest = SmartAccountProtocol.ComputeNonceNamespaceDigest(accountId, Hash,
                    authorityEpoch, validatorId, credentialGeneration,
                    op[SmartAccountModuleProtocol.OpNonceSubkey].GetSpan());
                byte[] channel = SmartAccountProtocol.DeriveChannel(namespaceDigest);
                Require((nonce >> 64) == new BigInteger(channel, isUnsigned: true, isBigEndian: true),
                    SmartAccountModuleProtocol.ErrorNonceInvalid);
                BigInteger channelValue = new(channel, isUnsigned: true, isBigEndian: true);
                BigInteger cursor = cursors.TryGetValue(channelValue, out BigInteger known)
                    ? known
                    : ReadNonceCursor(engine.SnapshotCache, accountId, channel);
                Require(cursor != NonceExhaustionSentinel, SmartAccountModuleProtocol.ErrorNonceExhausted);
                BigInteger sequence = SmartAccountProtocol.SequenceFromNonce(nonce);
                Require(sequence == cursor, SmartAccountModuleProtocol.ErrorNonceInvalid);
                AssertOperationNonceAcceptable(engine.SnapshotCache, accountId, channel, namespaceDigest, sequence);
                cursors[channelValue] = cursor + 1;

                byte[] digest = SmartAccountProtocol.ComputeOperationDigest(engine.ProtocolSettings.Network, Hash,
                    accountId, op, validatorId, credentialGeneration, authorityEpoch, configurationNonce);
                VerifyHookProofsAgainstSnapshot(op, ReadHookOrder(engine.SnapshotCache, accountId).HookIds);
                await ValidateAsync(engine, accountId, op, digest, outcome);
            }
            return true;
        }
    }
}
