// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccount.Execution.cs file belongs to the neo project and is free software distributed under the MIT software
// license, see the accompanying file LICENSE in the main directory of the repository or
// http://www.opensource.org/licenses/mit-license.php for more details.
//
// Redistribution and use in source and binary forms with or without modifications are permitted.

// TRUE SOURCE: this is the only editable copy of this SmartAccount native
// contract file. The neo-native-core checkout carries a generated copy —
// regenerate it via scripts/sync_native_smartaccount.py.

#pragma warning disable IDE0051

using Neo.Cryptography;
using Neo.Cryptography.ECC;
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
using ECCurve = Neo.Cryptography.ECC.ECCurve;
using ECPoint = Neo.Cryptography.ECC.ECPoint;
using HashAlgorithm = Neo.Cryptography.HashAlgorithm;

namespace Neo.SmartContract.Native
{
    /// <summary>Operation execution kernel of the native core (spec §4/§5/§6/§3.6). Execution order: validate → consume nonce →
    /// pre-hooks → close module authorization → dispatch target → close target authorization → reverse post-hooks → validator
    /// completion → success event. Any validation rejection, lifecycle fault or code-identity change faults the whole transaction; a target Boolean false is a normal result and still runs completion. Every approved route runs its installed
    /// hooks; the routing validator alone decides credential validity.</summary>
    public sealed partial class SmartAccount
    {
        private static readonly BigInteger NonceExhaustionSentinel = BigInteger.One << 64;

        /// <summary>Approval bookkeeping of one validation pass.</summary>
        private sealed class ValidationOutcome
        {
            internal ModuleInstance? Module;
            internal BigInteger PlannerId;
            internal ModuleInstance? Planner;
            internal BigInteger[] ApprovedIds = [];
            internal ModuleInstance[] ApprovedModules = [];
            internal BigInteger[] HookIds = [];
        }

        private (BigInteger Id, ModuleInstance Module)? FindHookPlanner(IReadOnlyStore snapshot, UInt160 accountId)
        {
            (BigInteger Id, ModuleInstance Module)? found = null;
            foreach (var (moduleId, module) in EnumerateValidatorModules(snapshot, accountId))
            {
                if (!module.HookPlanner) continue;
                Require(module.IsValidator, SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
                Require(found is null, SmartAccountModuleProtocol.ErrorModuleLimitPlanner);
                found = (moduleId, module);
            }
            return found;
        }

        private static BigInteger[] RequireHookPlan(StackItem reply, BigInteger[] installed)
        {
            if (reply is not Array plan || plan.Count != installed.Length)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorProofInvalid);
            BigInteger[] result = new BigInteger[plan.Count];
            HashSet<BigInteger> seen = new();
            for (int i = 0; i < plan.Count; i++)
            {
                if (plan[i] is not Integer id || id.GetInteger() < 1 || id.GetInteger() >> 64 != BigInteger.Zero
                    || !seen.Add(id.GetInteger()) || System.Array.IndexOf(installed, id.GetInteger()) < 0)
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorProofInvalid);
                result[i] = id.GetInteger();
            }
            return result;
        }

        // ======================================================================== 1. Nonce cursors (0x56) and
        // namespace digests (0x5C) ========================================================================

        private BigInteger ReadNonceCursor(IReadOnlyStore snapshot, UInt160 accountId, byte[] channel)
        {
            if (!TryRead(snapshot, Key(SmartAccountModuleProtocol.PrefixNonceCursor).Add(accountId).Add(channel),
                    out var value))
                return BigInteger.Zero;
            MemoryReader reader = new(value);
            if (BinarySerializer.Deserialize(ref reader, 32, 8) is not Integer cursor
                || reader.Position != value.Length)
                throw new FormatException("The nonce cursor record is malformed.");
            // The cursor domain is exactly [0, 2^64]: negative values and values
            // past the exhaustion sentinel are corrupt records, never a cursor.
            // Re-encoding proves the stored row is the one canonical Integer.
            BigInteger sequence = cursor.GetInteger();
            if (sequence < 0 || sequence > NonceExhaustionSentinel
                || !BinarySerializer.Serialize(new Integer(sequence), 32, 8).AsSpan().SequenceEqual(value.Span))
                throw new FormatException("The nonce cursor record is malformed.");
            return sequence;
        }

        private void WriteNonceCursor(ApplicationEngine engine, UInt160 accountId, byte[] channel,
            BigInteger cursor) => Write(engine, Key(SmartAccountModuleProtocol.PrefixNonceCursor).Add(accountId).Add(channel),
                BinarySerializer.Serialize(new Integer(cursor), 32, 8));

        /// <summary> A persisted 0x5C derivation of a channel must match this one (truncation collision fails closed). </summary>
        private void AssertOperationNonceNamespace(IReadOnlyStore snapshot, UInt160 accountId, byte[] channel,
            ReadOnlySpan<byte> namespaceDigest)
        {
            if (TryRead(snapshot, Key(SmartAccountModuleProtocol.PrefixNonceNamespace).Add(accountId).Add(channel),
                    out var stored))
                Require(stored.Span.SequenceEqual(namespaceDigest),
                    SmartAccountModuleProtocol.ErrorNonceChannelCollision);
        }

        /// <summary> Epoch/configuration freshness plus the packed nonce→channel binding of one operation (§4.1/§6). </summary>
        private (byte[] Namespace, byte[] Channel, BigInteger Sequence) RequireNonceChannel(UInt160 accountId,
            AccountControl control, SmartAccountProtocol.ValidatedOperation operation)
        {
            SmartAccountProtocol.OperationFields fields = operation.Fields;
            Require(fields.AuthorityEpoch == new BigInteger(control.AuthorityEpoch),
                SmartAccountModuleProtocol.ErrorEpochStale);
            Require(fields.ConfigurationNonce == new BigInteger(control.ConfigurationNonce),
                SmartAccountModuleProtocol.ErrorConfigurationNonceStale);
            byte[] namespaceDigest = SmartAccountProtocol.ComputeNonceNamespaceDigest(accountId, Hash,
                fields.AuthorityEpoch, fields.ValidatorId, fields.CredentialGeneration, operation.NonceSubkey);
            byte[] channel = SmartAccountProtocol.DeriveChannel(namespaceDigest);
            Require((fields.Nonce >> 64) == new BigInteger(channel, isUnsigned: true, isBigEndian: true),
                SmartAccountModuleProtocol.ErrorNonceInvalid);
            return (namespaceDigest, channel, SmartAccountProtocol.SequenceFromNonce(fields.Nonce));
        }

        /// <summary> Admissibility of one operation for the account it names (§4.1/§6): its deadline has not passed, it was
        /// issued for the account's current authority epoch and configuration nonce, its nonce is the current sequence of a
        /// channel that is not exhausted, and a persisted channel derivation matches. Returns the channel derivation and the
        /// operation digest. The account status is left to the entry: an execution and a witness check answer it differently. </summary>
        private (byte[] NamespaceDigest, byte[] Channel, BigInteger Sequence, byte[] Digest) AdmitOperation(
            ApplicationEngine engine, UInt160 accountId, AccountControl control, SmartAccountProtocol.ValidatedOperation operation)
        {
            Require(new BigInteger(Now(engine)) <= operation.Deadline, SmartAccountModuleProtocol.ErrorDeadlineExpired);
            var (namespaceDigest, channel, sequence) = RequireNonceChannel(accountId, control, operation);
            BigInteger cursor = ReadNonceCursor(engine.SnapshotCache, accountId, channel);
            Require(cursor != NonceExhaustionSentinel, SmartAccountModuleProtocol.ErrorNonceExhausted);
            Require(sequence == cursor, SmartAccountModuleProtocol.ErrorNonceInvalid);
            AssertOperationNonceNamespace(engine.SnapshotCache, accountId, channel, namespaceDigest);
            return (namespaceDigest, channel, sequence,
                operation.ComputeDigest(engine.ProtocolSettings.Network, Hash, accountId));
        }

        /// <summary> Consumes the nonce after successful validation: first use persists the full 0x5C derivation and
        /// emits NonceChannelOpened; reaching the 2^64 sentinel kills the channel with no wrap-around. The admission proved the
        /// cursor and the channel derivation, and validation runs read-only, so neither is read again. </summary>
        private void ConsumeOperationNonce(ApplicationEngine engine, UInt160 accountId, byte[] channel,
            ReadOnlySpan<byte> namespaceDigest, BigInteger sequence)
        {
            // The 0x5C namespace row of the channel: first use persists the full derivation (spec §7.1).
            StorageKey namespaceKey = Key(SmartAccountModuleProtocol.PrefixNonceNamespace).Add(accountId).Add(channel);
            if (!TryRead(engine.SnapshotCache, namespaceKey, out _))
            {
                Write(engine, namespaceKey, namespaceDigest.ToArray());
                Notify(engine, SmartAccountModuleProtocol.EventNameNonceChannelOpened, accountId.ToArray(),
                    namespaceDigest.ToArray());
            }
            BigInteger next = sequence + 1;
            if (next >= NonceExhaustionSentinel)
            {
                next = NonceExhaustionSentinel;
                Notify(engine, SmartAccountModuleProtocol.EventNameNonceChannelExhausted, accountId.ToArray(),
                    namespaceDigest.ToArray());
            }
            WriteNonceCursor(engine, accountId, channel, next);
        }

        /// <summary><c>getNonce(accountId, validatorId, nonceSubkey)</c> — the packed nonce <c>channel &lt;&lt; 64 |
        /// sequence</c> of the channel derived for the account's current epoch. The spec (§6.1/§9) fixes the packed
        /// encoding only for live channels and leaves an exhausted channel's reply unspecified (R-06-04 governs
        /// consumption, which is rejected separately), so this core answers conservatively with the exhaustion sentinel
        /// itself: packing it would yield <c>(channel + 1) &lt;&lt; 64</c>, the next channel's start value, and a caller
        /// could mistake that alias for a usable nonce. The raw sentinel matches <see cref="GetNonceSequence"/>.</summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
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
            if (sequence == NonceExhaustionSentinel) return NonceExhaustionSentinel;
            return (new BigInteger(channel, isUnsigned: true, isBigEndian: true) << 64) | sequence;
        }

        /// <summary>The current sequence cursor of an explicit channel.</summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private BigInteger GetNonceSequence(ApplicationEngine engine, UInt160 accountId, BigInteger channel)
        {
            RequireAccountId(accountId);
            _ = RequireControl(engine.SnapshotCache, accountId);
            return ReadNonceCursor(engine.SnapshotCache, accountId, SmartAccountProtocol.EncodeChannel(channel));
        }

        // ======================================================================== 2. Routing resolution (spec §3.5)
        // ========================================================================

        /// <summary> validatorId 0 is the built-in custody route; any other id must name an installed validator
        /// instance whose credential generation still matches. </summary>
        private ValidationOutcome ResolveRouting(IReadOnlyStore snapshot, UInt160 accountId,
            AccountControl control, BigInteger validatorId, BigInteger credentialGeneration)
        {
            Require(control.RequiredValidatorId == 0 || validatorId == control.RequiredValidatorId,
                SmartAccountModuleProtocol.ErrorModuleNotRoutable);
            ValidationOutcome outcome = new();
            if (validatorId == BigInteger.Zero)
            {
                // Built-in route: gated by the default operation authorization switch — there is no automatic custody fallback.
                Require(control.DefaultOperationAuthorization, SmartAccountModuleProtocol.ErrorModuleNotRoutable);
                Require(credentialGeneration.IsOne, SmartAccountModuleProtocol.ErrorCredentialStale);
                return outcome;
            }
            ModuleInstance? module = TryModuleInstance(snapshot, accountId, validatorId);
            if (module is not null)
            {
                Require(module.IsValidator, SmartAccountModuleProtocol.ErrorModuleNotRoutable);
                Require(credentialGeneration == module.CredentialGeneration,
                    SmartAccountModuleProtocol.ErrorCredentialStale);
                outcome.Module = module;
                return outcome;
            }
            throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorValidatorNotFound);
        }

        /// <summary> Credential generation of a routing subject: the built-in route has no rotating credential and
        /// always reports 1, a validator instance reports the generation recorded in its 0x52 row. </summary>
        private BigInteger ResolveCredentialGeneration(IReadOnlyStore snapshot, UInt160 accountId,
            BigInteger validatorId)
        {
            if (validatorId == BigInteger.Zero) return BigInteger.One;
            ModuleInstance? module = TryModuleInstance(snapshot, accountId, validatorId);
            if (module is not null)
            {
                Require(module.IsValidator, SmartAccountModuleProtocol.ErrorValidatorNotFound);
                return module.CredentialGeneration;
            }
            throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorValidatorNotFound);
        }

        // ======================================================================== 3. Built-in operation signature
        // (spec §5/§8) ========================================================================

        // Canonical N3 P-256 verification script shape: PUSHDATA1 33-byte compressed point +
        // System.Crypto.CheckSig, as recognized by Helper.IsSignatureContract.
        private const int P256SignatureSize = 64;

        /// <summary> Built-in (validatorId = 0) operation signature: the canonical custody P-256 script and one 64-byte P-256
        /// signature over the OPERATION digest, carried as [version, 0, 1, [[script, signature]]]. The subject is the account's
        /// custody address — the only signer the built-in route ever authorizes — so no stored subject set is consulted.
        /// The verification is charged the price of a contract <c>System.Crypto.CheckSig</c>, on the same basis (the platform
        /// price times the execution fee factor): a caller of the read-only <c>validateUserOp</c> pays for it like a caller of
        /// <c>executeUserOp</c>. </summary>
        private static bool VerifyBuiltInOperationSignature(ApplicationEngine engine, AccountControl control,
            ReadOnlySpan<byte> digest, ReadOnlySpan<byte> encoded)
        {
            if (encoded.Length == 0 || encoded.Length > SmartAccountModuleProtocol.SignatureBytesMax) return false;
            StackItem decoded;
            try
            {
                MemoryReader reader = new(encoded.ToArray());
                decoded = BinarySerializer.Deserialize(ref reader, SmartAccountModuleProtocol.SignatureBytesMax, 8);
                if (reader.Position != encoded.Length) return false;
            }
            catch
            {
                return false;
            }
            if (decoded is not Array envelope || envelope.Type != StackItemType.Array || envelope.Count != 4) return false;
            if (envelope[0] is not Integer version
                || version.GetInteger() != SmartAccountModuleProtocol.ModuleProtocolVersion) return false;
            if (envelope[1] is not Integer validator || validator.GetInteger() != BigInteger.Zero) return false;
            if (envelope[2] is not Integer generation || generation.GetInteger() != BigInteger.One) return false;
            if (envelope[3] is not Array pairs || pairs.Type != StackItemType.Array || pairs.Count != 1) return false;
            if (pairs[0] is not Array pair || pair.Type != StackItemType.Array || pair.Count != 2) return false;
            if (pair[0] is not ByteString script || pair[1] is not ByteString signature) return false;
            if (signature.Size != P256SignatureSize) return false;
            // One signature is about to be verified: charged here, once, where the built-in signature is verified.
            engine.AddNativeCpuFee(ApplicationEngine.CheckSigPrice);
            return VerifyCustodySignature(script.GetSpan(), control.Custody, digest, signature.GetSpan());
        }

        /// <summary> P-256 verification of a digest (spec §14) by the account's custody key. The signer is bound to the
        /// custody address the way the platform binds it for <c>Runtime.CheckWitness</c>: the hash of the canonical N3
        /// signature script of the decoded point (<see cref="Contract.CreateSignatureRedeemScript"/>) must equal the custody
        /// address, so only the canonical compressed script is accepted. The 32-byte digest is verified PREHASHED —
        /// VerifyHash over the exact digest, no second SHA-256 — so a signature over the digest and a signature over
        /// SHA-256(digest) are not interchangeable. </summary>
        private static bool VerifyCustodySignature(ReadOnlySpan<byte> script, UInt160 custody, ReadOnlySpan<byte> digest,
            ReadOnlySpan<byte> signature)
        {
            Require(digest.Length == 32, SmartAccountModuleProtocol.ErrorOperationMalformed);
            if (!Helper.IsSignatureContract(script)) return false;
            ECPoint key;
            try
            {
                key = ECPoint.DecodePoint(script[2..35], ECCurve.Secp256r1);
            }
            catch (Exception exception) when (exception is FormatException or ArithmeticException)
            {
                // Not a compressed point on the curve.
                return false;
            }
            return Contract.CreateSignatureRedeemScript(key).ToScriptHash() == custody
                && Crypto.CreateECDsa(key).VerifyHash(digest.ToArray(), signature.ToArray());
        }

        // ======================================================================== 4. Validation pass (read-only
        // validator callback) ========================================================================

        private async ContractTask ValidateAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, SmartAccountProtocol.ValidatedOperation operation, ReadOnlyMemory<byte> digest,
            ValidationOutcome outcome)
        {
            if (outcome.Module is not null)
            {
                Require(await CallValidatorValidateUserOpAsync(engine, accountId, operation.Fields.ValidatorId,
                        outcome.Module, operation.SignedBytes, digest, SmartAccountCallbackPhase.Validation),
                    SmartAccountModuleProtocol.ErrorValidationRejected);
                if (outcome.Module.CompositeLayer)
                {
                    SmartAccountInvocationContext.OperationValidation state = Context(engine).Validation!;
                    outcome.ApprovedIds = [.. state.ApprovedIds];
                    outcome.ApprovedModules = [.. state.ApprovedModules];
                }
                return;
            }
            // Built-in route (validatorId = 0): the custody key over the digest.
            Require(VerifyBuiltInOperationSignature(engine, control, digest.Span,
                    operation.Operation[SmartAccountModuleProtocol.OpSignature].GetSpan()),
                SmartAccountModuleProtocol.ErrorValidationRejected);
        }

        private async ContractTask<ValidationOutcome> ValidateOperationAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, SmartAccountProtocol.ValidatedOperation operation, ReadOnlyMemory<byte> digest)
        {
            SmartAccountInvocationContext context = Context(engine);
            SmartAccountProtocol.OperationFields fields = operation.Fields;
            // The one signed encoding validated for this operation is shared with every callback; each
            // callback deserializes its own tree, so no mutable Array is shared between frames.
            context.Validation = new SmartAccountInvocationContext.OperationValidation(fields.ValidatorId,
                fields.CredentialGeneration, operation.SignedBytes, digest);
            try
            {
                ValidationOutcome outcome = ResolveRouting(engine.SnapshotCache, accountId, control,
                    fields.ValidatorId, fields.CredentialGeneration);
                BigInteger[] installedHooks = [.. EnumerateModuleIds(engine.SnapshotCache, accountId,
                    SmartAccountModuleProtocol.ModuleTypeCodeHook, BigInteger.Zero,
                    SmartAccountModuleProtocol.MaxHookModuleInstances)];
                foreach (Array proof in (Array)operation.Operation[SmartAccountModuleProtocol.OpHookProofs])
                    Require(System.Array.IndexOf(installedHooks, proof[0].GetInteger()) >= 0,
                        SmartAccountModuleProtocol.ErrorProofInvalid);
                await ValidateAsync(engine, accountId, control, operation, digest, outcome);

                // Planning is independent of operation approval. A dedicated planner may
                // order hooks for operations routed to any other validator.
                outcome.HookIds = installedHooks;
                var planner = FindHookPlanner(engine.SnapshotCache, accountId);
                if (planner is { } selected)
                {
                    outcome.PlannerId = selected.Id;
                    outcome.Planner = selected.Module;
                    StackItem reply = (await CallHookPlannerAsync(engine, accountId, selected.Id,
                        selected.Module, operation.SignedBytes, digest))!;
                    outcome.HookIds = RequireHookPlan(reply, installedHooks);
                }
                return outcome;
            }
            finally
            {
                context.Validation = null;
            }
        }

        /// <summary> Authenticated composite dispatch. Only the currently routed composite validator may call this
        /// entry. Members are leaf validators; nested composition and duplicate member checks are rejected. The member is given
        /// its signed bytes and digest, never the tree the parent forwards. </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private async ContractTask<bool> ValidateMember(ApplicationEngine engine, UInt160 accountId,
            BigInteger memberId, byte[] operationDigest, Array operation)
        {
            RequireAccountId(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            SmartAccountInvocationContext context = Context(engine);
            if (!context.IsModuleAuthorized(engine, accountId, SmartAccountCallbackPhase.Validation)
                || context.Validation is not { } state)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorUnauthorized);
            Require(operationDigest is { Length: 32 } && operationDigest.AsSpan().SequenceEqual(state.Digest),
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            // The operation the parent forwards must be the operation of record, byte for byte: a different tree is
            // refused, never ignored. Its encoding is bounded exactly like the operation of record.
            Require(SmartAccountProtocol.RequireOperationEncoding(operation, SmartAccountModuleProtocol.OperationEncodedSizeMax,
                    SmartAccountModuleProtocol.OperationEncodedItemsMax).AsSpan().SequenceEqual(state.SignedBytes),
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            Require(context.CallbackModuleId == state.ValidatorId, SmartAccountModuleProtocol.ErrorUnauthorized);
            // The caller must be the routed instance itself, not merely a module that happens to hold the validation
            // grant: the phase grant names the exact contract, so the CallingScriptHash comparison is the binding
            // between the request and the installed instance record.
            Require(engine.CallingScriptHash is not null
                && engine.CallingScriptHash == context.CallbackContract,
                SmartAccountModuleProtocol.ErrorUnauthorized);
            ModuleInstance parent = RequireModuleInstance(engine.SnapshotCache, accountId, state.ValidatorId);
            Require(parent.ContractHash == engine.CallingScriptHash, SmartAccountModuleProtocol.ErrorUnauthorized);
            Require(parent.IsValidator && parent.CompositeLayer, SmartAccountModuleProtocol.ErrorUnauthorized);
            // The parent's credential generation is captured with the operation: a generation bump can never be used to swap the
            // composite instance mid-validation; its code identity is asserted when its callback returns and before the commit.
            Require(parent.CredentialGeneration == state.CredentialGeneration,
                SmartAccountModuleProtocol.ErrorCredentialStale);
            ModuleInstance member = RequireModuleInstance(engine.SnapshotCache, accountId, memberId);
            Require(member.IsValidator, SmartAccountModuleProtocol.ErrorValidatorNotFound);
            Require(member.ContractHash != parent.ContractHash, SmartAccountModuleProtocol.ErrorOperationMalformed);
            Require(member.ThresholdMemberEligible && !member.CompositeLayer,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            Require(state.ValidatedMembers.Count < SmartAccountModuleProtocol.MaxCompositeMemberValidators,
                SmartAccountModuleProtocol.ErrorModuleLimitValidator);
            Require(state.ValidatedMembers.Add(memberId), SmartAccountModuleProtocol.ErrorOperationMalformed);
            bool approved = await CallValidatorValidateUserOpAsync(engine, accountId, memberId, member,
                state.SignedBytes, state.Digest, SmartAccountCallbackPhase.MemberValidation);
            if (approved)
            {
                state.ApprovedIds.Add(memberId);
                state.ApprovedModules.Add(member);
            }
            return approved;
        }

        // ======================================================================== 5. Read-only validation and digest
        // query (spec §3.3) ========================================================================

        /// <summary> Public digest query: the exact digest a signer must sign for this operation on this account
        /// under the current core. </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private byte[] GetOperationDigest(ApplicationEngine engine, UInt160 accountId, Array operation)
        {
            RequireAccountId(accountId);
            _ = RequireControl(engine.SnapshotCache, accountId);
            return SmartAccountProtocol.ValidateOperation(operation)
                .ComputeDigest(engine.ProtocolSettings.Network, Hash, accountId);
        }

        /// <summary> Read-only validation query of one operation: its encoding, the admission checks of an execution
        /// (deadline, authority epoch, configuration nonce, nonce channel and cursor), the module validation and the
        /// actual signature verification, with NO nonce consumption and NO state changes. Returns [accepted,
        /// operationDigest]. </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private async ContractTask<Array> ValidateUserOp(ApplicationEngine engine, UInt160 accountId, Array operation)
        {
            RequireAccountId(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            SmartAccountProtocol.ValidatedOperation validated = SmartAccountProtocol.ValidateOperation(operation);
            byte[] digest = validated.ComputeDigest(engine.ProtocolSettings.Network, Hash, accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            try
            {
                if (control.Status != SmartAccountStatus.Active) return new Array(new StackItem[] { false, digest });
                _ = AdmitOperation(engine, accountId, control, validated);
                _ = await ValidateOperationAsync(engine, accountId, control, validated, digest);
                return new Array(new StackItem[] { true, digest });
            }
            catch
            {
                // Every rejection answers false; the digest of the operation is still reported.
                return new Array(new StackItem[] { false, digest });
            }
        }

        // ======================================================================== 6. Execution entrypoints (spec
        // §3.3/§3.6) ========================================================================

        /// <summary> Spec §4.1 single-operation encoding bound: the canonical NeoVM serialization of the WHOLE
        /// operation — signature included — must stay inside OperationEncodedSizeMax (16384 bytes).
        /// SmartAccountProtocol.ValidateOperation produces the signed encoding under this bound, so every native ABI
        /// entrypoint inherits it; an over-long operation is malformed. </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask<StackItem> ExecuteUserOp(ApplicationEngine engine, UInt160 accountId,
            Array operation)
        {
            // 1. Trigger and account: an application entry holds the account until this operation ends.
            RequireApplication(engine);
            RequireAccountId(accountId);
            SmartAccountInvocationContext context = Context(engine);
            using var locked = context.EnterAccount(accountId);

            // 2. The operation is well formed, the account exists and is active.
            SmartAccountProtocol.ValidatedOperation validated = SmartAccountProtocol.ValidateOperation(operation);
            SmartAccountProtocol.OperationFields fields = validated.Fields;
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);

            // 3. Admitted for this account: deadline, authority epoch, configuration nonce, nonce channel and cursor.
            var (namespaceDigest, channel, sequence, digest) = AdmitOperation(engine, accountId, control, validated);

            // 4. Authorization, the only place it happens: the built-in operation signature, or the routed validator
            //    module, which also plans the hooks.
            ValidationOutcome outcome = (await ValidateOperationAsync(engine, accountId, control, validated, digest))!;

            // 5. The nonce is consumed once the operation is authorized, whatever the target answers.
            ConsumeOperationNonce(engine, accountId, channel, namespaceDigest, sequence);

            // 6. Pre hooks, in snapshot order.
            (byte[][] Data, ModuleInstance[] Modules) hooks =
                await CallHookPreChecksAsync(engine, accountId, outcome.HookIds, validated.SignedBytes);

            // 7. Target dispatch: no module authorization is open while the target acts.
            UInt160 target = new(validated.Operation[SmartAccountModuleProtocol.OpTarget].GetSpan());
            // The core itself is never a target. Refusing it here keeps the core's own frame from ever being loaded as
            // the target; EnterTarget keeps the same refusal as a second line of defence.
            Require(target != SmartAccountProtocol.ServiceHash, SmartAccountModuleProtocol.ErrorPhaseViolation);
            string method = validated.Method;
            // A callee receives its arguments by reference, so the target gets an isolated copy of the
            // validated tree: it can never edit the operation of record the hooks still read.
            StackItem[] arguments = [.. (Array)validated.Operation[SmartAccountModuleProtocol.OpArgs].DeepCopy()];
            var task = engine.CallFromNativeContractRawAsync(Hash, target, method, CallFlags.All, arguments);
            var anchor = engine.CurrentContext!.GetState<ExecutionContextState>();
            StackItem result;
            using (context.EnterTarget(accountId, target, anchor))
                result = (await task) ?? StackItem.Null;

            // 8. Post hooks, in reverse snapshot order.
            await CallHookPostChecksAsync(engine, accountId, outcome.HookIds, hooks.Modules, validated.SignedBytes,
                result, hooks.Data);

            // 9. Completion: the approved composite members, then the routed validator.
            await CallValidatorCompletionsAsync(engine, accountId, fields.ValidatorId, outcome,
                validated.SignedBytes, result);

            // 10. The code of every module that approved or ran this operation is still the installed one (spec §7.3).
            AssertCodeBindingsAtCommit(engine.SnapshotCache, accountId, fields.ValidatorId, outcome);
            Notify(engine, "UserOpExecuted", accountId.ToArray(), target.ToArray(), method, fields.Nonce);
            return result;
        }

        /// <summary> Phase HookPre: every planned hook answers in snapshot order to the signed wire bytes and returns
        /// the data its own HookPost receives later. The resolved modules are returned with it: HookPost calls those
        /// same instances. </summary>
        private async ContractTask<(byte[][] Data, ModuleInstance[] Modules)> CallHookPreChecksAsync(
            ApplicationEngine engine, UInt160 accountId, BigInteger[] hookIds, byte[] signedBytes)
        {
            int hookCount = hookIds.Length;
            byte[][] hookData = new byte[hookCount][];
            ModuleInstance[] hookModules = new ModuleInstance[hookCount];
            for (int i = 0; i < hookCount; i++)
            {
                ModuleInstance hook = RequireModuleInstance(engine.SnapshotCache, accountId, hookIds[i]);
                hookModules[i] = hook;
                hookData[i] = (await CallHookPreCheckAsync(engine, accountId, hookIds[i], hook,
                    signedBytes))!;
            }
            return (hookData, hookModules);
        }

        /// <summary> Phase HookPost: the original hook set answers in reverse snapshot order, each with the target's
        /// result and the data its own HookPre returned. </summary>
        private async ContractTask CallHookPostChecksAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger[] hookIds, ModuleInstance[] hookModules, byte[] signedBytes, StackItem result,
            byte[][] hookData)
        {
            for (int i = hookIds.Length - 1; i >= 0; i--)
            {
                await CallHookPostCheckAsync(engine, accountId, hookIds[i], hookModules[i],
                    signedBytes, result, hookData[i]);
            }
        }

        /// <summary> Phase Completion: the approved composite members first, then the routed validator. </summary>
        private async ContractTask CallValidatorCompletionsAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger validatorId, ValidationOutcome outcome, byte[] signedBytes, StackItem result)
        {
            if (outcome.Module?.CompositeLayer == true)
            {
                for (int i = 0; i < outcome.ApprovedIds.Length; i++)
                {
                    await CallValidatorCompletionAsync(engine, accountId, outcome.ApprovedIds[i],
                        outcome.ApprovedModules[i], signedBytes, result);
                }
            }
            if (outcome.Module is not null)
            {
                await CallValidatorCompletionAsync(engine, accountId, validatorId, outcome.Module,
                    signedBytes, result);
            }
        }

        // ======================================================================== 7. Verification-trigger gate (spec
        // §3.6/§5) ========================================================================

        /// <summary> The account's proxy verification script calls this. Under the transaction Verification trigger it decides
        /// only whether the envelope's single operation is admissible for this account — proxy caller, payer, account status,
        /// envelope shape, deadline, counters and nonce availability — without verifying a signature, without a module callback
        /// and without writing state: authorisation happens once, in executeUserOp. Under the Application trigger it authorizes
        /// ONLY the account's own dispatching operation: the caller must be the proxy script and the proxy must be invoked
        /// from inside that account's target dispatch. </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadOnly)]
        private bool Verify(ApplicationEngine engine, UInt160 accountId)
        {
            if (engine.ScriptContainer is not Transaction container)
                throw new InvalidOperationException(
                    $"{SmartAccountModuleProtocol.ErrorUnauthorized} SmartAccount verification requires a transaction.");
            RequireAccountId(accountId);
            UInt160 address = SmartAccountProtocol.GetAccountAddress(accountId);
            SmartAccountInvocationContext context = Context(engine);

            // 1. Only the account's own proxy may ask. Under the Application trigger that is the whole proof: the
            //    dispatch is already authorized, so nothing is read or validated here.
            if (engine.Trigger == TriggerType.Application)
            {
                RequireProxyFrameCalledByTargetDispatch(engine, accountId, address);
                return true;
            }

            // 2. Otherwise this is the witness check, run for the proxy script of a transaction it does not pay for.
            RequireProxyWitnessOfTransaction(engine, address, container);
            using var locked = context.EnterAccount(accountId);

            // 3. The account exists and is active.
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            if (control.Status != SmartAccountStatus.Active)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorAccountStatus);

            // 4. The transaction does exactly one thing under this account: executeUserOp(accountId, operation).
            //    The script is recognized, never built or executed.
            SmartAccountProtocol.ValidatedOperation operation =
                SmartAccountProtocol.ValidateEntryScript(accountId, container.Script);

            // 5. The operation is admitted for this account: deadline, counters, nonce channel and sequence. Nothing is
            //    consumed here; the same admission is repeated, and the credentials verified, by executeUserOp.
            _ = AdmitOperation(engine, accountId, control, operation);
            return true;
        }

        /// <summary> Under the Application trigger the proxy frame is accepted only when it is called directly by the
        /// target frame of this account's authorized dispatch (spec §3.6/§5), so the proxy never answers a bare witness
        /// request of any other caller. </summary>
        private static void RequireProxyFrameCalledByTargetDispatch(ApplicationEngine engine, UInt160 accountId,
            UInt160 address)
        {
            if (engine.CallingScriptHash != address || !Context(engine).IsTargetAuthorized(engine, accountId))
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorUnauthorized);
        }

        /// <summary> The witness check runs only under the Verification trigger, asked by the account's exact proxy
        /// script, for a transaction the proxy does not pay for. </summary>
        private static void RequireProxyWitnessOfTransaction(ApplicationEngine engine, UInt160 address,
            Transaction tx)
        {
            if (engine.Trigger != TriggerType.Verification)
                throw new InvalidOperationException(
                    $"{SmartAccountModuleProtocol.ErrorUnauthorized} SmartAccount verification requires a transaction Verification trigger.");
            if (engine.CallingScriptHash != address)
                throw new InvalidOperationException(
                    $"{SmartAccountModuleProtocol.ErrorUnauthorized} Verification must originate from the account's exact proxy script.");
            if (tx.Sender == address)
                throw new InvalidOperationException(
                    $"{SmartAccountModuleProtocol.ErrorUnauthorized} The SmartAccount proxy cannot be the transaction fee payer.");
        }
    }
}
