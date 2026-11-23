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
    /// <summary>
    /// Operation execution kernel of the native core (spec §4/§5/§6/§3.6/§11).
    ///
    /// Execution order: validate → consume nonce → pre-hooks → close module authorization →
    /// dispatch target → close target authorization → reverse post-hooks → validator completion →
    /// success event. Any validation rejection, lifecycle fault, code-identity
    /// change or gas overrun faults the whole transaction; a target Boolean
    /// false is a normal result and still runs completion.
    ///
    /// Every approved route runs the installed hooks around the target. The
    /// routing validator alone decides credential validity.
    /// </summary>
    public sealed partial class SmartAccount
    {
        private static readonly BigInteger NonceExhaustionSentinel = BigInteger.One << 64;

        /// <summary>Approval bookkeeping of one validation pass.</summary>
        private sealed class ValidationOutcome
        {
            internal ModuleInstance? Module;
            internal BigInteger[] HookIds = [];
        }

        private ValidationOutcome ResolveOperationRouting(IReadOnlyStore snapshot, UInt160 id,
            AccountControl control, BigInteger validatorId, BigInteger generation, Array operation)
        {
            var outcome = ResolveRouting(snapshot, id, control, validatorId, generation);
            outcome.HookIds = [.. EnumerateModuleIds(snapshot, id, SmartAccountModuleProtocol.ModuleTypeCodeHook,
                BigInteger.Zero, SmartAccountModuleProtocol.MaxHookModuleInstances)];
            foreach (Array proof in (Array)operation[SmartAccountModuleProtocol.OpHookProofs])
                Require(System.Array.IndexOf(outcome.HookIds, proof[0].GetInteger()) >= 0,
                    SmartAccountModuleProtocol.ErrorProofInvalid);
            return outcome;
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
            // The cursor domain is exactly [0, 2^64]: negative values and values
            // past the exhaustion sentinel are corrupt records, never a cursor.
            BigInteger sequence = cursor.GetInteger();
            if (sequence < 0 || sequence > NonceExhaustionSentinel)
                throw new FormatException("The nonce cursor record is malformed.");
            return sequence;
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
            AssertOperationNonceNamespace(snapshot, accountId, channel, namespaceDigest);
        }

        private void AssertOperationNonceNamespace(IReadOnlyStore snapshot, UInt160 accountId, byte[] channel,
            ReadOnlySpan<byte> namespaceDigest)
        {
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

        /// <summary>
        /// <c>getNonce(accountId, validatorId, nonceSubkey)</c> — the packed
        /// nonce <c>channel &lt;&lt; 64 | sequence</c> of the channel derived for
        /// the account's current epoch. The spec (§6.1/§9) fixes the packed
        /// encoding only for live channels and leaves <c>getNonce</c>'s reply
        /// for an exhausted channel unspecified (R-06-04 governs consumption,
        /// which is rejected separately). This core therefore answers
        /// conservatively with the exhaustion sentinel itself: packing the
        /// sentinel would yield <c>(channel + 1) &lt;&lt; 64</c>, the exact start
        /// value of the NEXT channel, and a caller could mistake that alias for
        /// a usable nonce. The raw sentinel is not a packed nonce of the
        /// exhausted channel's successor and matches <see
        /// cref="GetNonceSequence"/>, which reports the same cursor verbatim.
        /// </summary>
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
            return ReadNonceCursor(engine.SnapshotCache, accountId, ChannelBytes(channel));
        }

        // ========================================================================
        // 2. Routing resolution (spec §3.5)
        // ========================================================================

        /// <summary>
        /// validatorId 0 is the built-in custody route; any other id must name an
        /// installed validator instance whose credential generation still matches.
        /// </summary>
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
            Require(module is not null, SmartAccountModuleProtocol.ErrorValidatorNotFound);
            Require(module!.IsValidator, SmartAccountModuleProtocol.ErrorModuleNotRoutable);
            Require(credentialGeneration == module.CredentialGeneration,
                SmartAccountModuleProtocol.ErrorCredentialStale);
            outcome.Module = module;
            return outcome;
        }

        /// <summary>
        /// Credential generation of a routing subject: the built-in route has no
        /// rotating credential and always reports 1, a validator instance reports
        /// the generation recorded in its 0x52 row.
        /// </summary>
        private BigInteger ResolveCredentialGeneration(IReadOnlyStore snapshot, UInt160 accountId,
            BigInteger validatorId)
        {
            if (validatorId == BigInteger.Zero) return BigInteger.One;
            ModuleInstance? module = TryModuleInstance(snapshot, accountId, validatorId);
            Require(module is not null, SmartAccountModuleProtocol.ErrorValidatorNotFound);
            Require(module!.IsValidator, SmartAccountModuleProtocol.ErrorValidatorNotFound);
            return module.CredentialGeneration;
        }

        // ========================================================================
        // 3. Built-in operation signature (spec §5/§8)
        // ========================================================================

        // Canonical N3 P-256 verification script shape (40 bytes):
        //   PUSHDATA1(0x0C) 0x21 <33-byte compressed point> SYSCALL(0x41) 56 E7 B3 27
        // where 56e7b327 is the little-endian interop hash of "System.Crypto.CheckSig",
        // i.e. exactly what Contract.CreateSignatureRedeemScript emits on N3.
        private const int CanonicalP256ScriptSize = 40;
        private const int P256SignatureSize = 64;
        private static readonly byte[] CheckSigSyscallHash = [0x56, 0xE7, 0xB3, 0x27];

        /// <summary>
        /// Built-in (validatorId = 0) operation signature: the canonical custody
        /// P-256 script and one 64-byte P-256 signature over the OPERATION digest,
        /// carried as [version, 0, 1, [[script, signature]]]. The subject is the
        /// account's custody address — the only signer the built-in route ever
        /// authorizes — so no stored subject set is consulted.
        /// </summary>
        private static bool VerifyBuiltInOperationSignature(AccountControl control, ReadOnlySpan<byte> digest,
            ReadOnlySpan<byte> encoded)
        {
            if (encoded.Length == 0 || encoded.Length > SmartAccountModuleProtocol.SignatureBytesMax) return false;
            StackItem decoded;
            try
            {
                MemoryReader reader = new(encoded.ToArray());
                decoded = BinarySerializer.Deserialize(ref reader,
                    SmartAccountModuleProtocol.SignatureBytesMax, 8);
            }
            catch
            {
                return false;
            }
            if (decoded is not Array envelope || envelope.Count != 4) return false;
            if (envelope[0] is not Integer version
                || version.GetInteger() != SmartAccountModuleProtocol.ModuleProtocolVersion) return false;
            if (envelope[1] is not Integer validator || validator.GetInteger() != BigInteger.Zero) return false;
            if (envelope[2] is not Integer generation || generation.GetInteger() != BigInteger.One) return false;
            if (envelope[3] is not Array pairs || pairs.Count != 1) return false;
            if (pairs[0] is not Array pair || pair.Count != 2) return false;
            if (pair[0] is not ByteString script || pair[1] is not ByteString signature) return false;
            if (script.Size != CanonicalP256ScriptSize || signature.Size != P256SignatureSize) return false;
            byte[]? point = TryGetCanonicalP256Point(script.GetSpan());
            if (point is null) return false;
            if (Crypto.Hash160(script.GetSpan()) != control.Custody) return false;
            return Crypto.VerifySignature(digest, signature.GetSpan(),
                ECPoint.DecodePoint(point, ECCurve.Secp256r1), HashAlgorithm.SHA256);
        }

        /// <summary>
        /// Extracts the 33-byte compressed point from a canonical N3 P-256
        /// verification script, or null when the script is not the standard
        /// wallet script-builder shape.
        /// </summary>
        private static byte[]? TryGetCanonicalP256Point(ReadOnlySpan<byte> script)
        {
            if (script.Length != CanonicalP256ScriptSize) return null;
            if (script[0] != 0x0C || script[1] != 0x21) return null;
            if (script[2] is not (0x02 or 0x03)) return null;
            if (script[35] != 0x41) return null;
            if (!script.Slice(36, CheckSigSyscallHash.Length).SequenceEqual(CheckSigSyscallHash)) return null;
            return script.Slice(2, 33).ToArray();
        }

        // ========================================================================
        // 4. Validation pass (read-only validator callback)
        // ========================================================================

        private async ContractTask ValidateAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, Array operation, ReadOnlyMemory<byte> digest, ValidationOutcome outcome)
        {
            if (outcome.Module is not null)
            {
                Require(await CallValidatorValidateUserOpAsync(engine, accountId,
                        operation[SmartAccountModuleProtocol.OpValidatorId].GetInteger(),
                        outcome.Module, operation, digest),
                    SmartAccountModuleProtocol.ErrorValidationRejected);
                return;
            }
            // Built-in route (validatorId = 0): the custody key over the digest.
            Require(VerifyBuiltInOperationSignature(control, digest.Span,
                    operation[SmartAccountModuleProtocol.OpSignature].GetSpan()),
                SmartAccountModuleProtocol.ErrorValidationRejected);
        }

        // ========================================================================
        // 5. Read-only preview and digest query (spec §3.3)
        // ========================================================================

        /// <summary>
        /// Public digest query: the exact digest a signer must sign for this
        /// operation on this account under the current core.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
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
        /// NO nonce consumption and NO state changes. Returns
        /// [accepted, operationDigest].
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private async ContractTask<Array> ValidateUserOp(ApplicationEngine engine, UInt160 accountId, Array operation)
        {
            RequireAccountId(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            Array op = SmartAccountProtocol.ValidateUserOperation(operation);
            RequireOperationEncodedSize(op);

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
                    outcome = ResolveOperationRouting(engine.SnapshotCache, accountId, control, validatorId,
                    credentialGeneration, operation);
                }
                catch
                {
                    accepted = false;
                }
            }

            if (accepted && outcome is not null)
            {
                using var locked = Context(engine).EnterAccount(accountId);
                try
                {
                    if (outcome.Module is null)
                    {
                        accepted = VerifyBuiltInOperationSignature(control, digest,
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

            return new Array(new StackItem[] { accepted, digest });
        }

        // ========================================================================
        // 6. Execution entrypoints (spec §3.3/§3.6)
        // ========================================================================

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask<StackItem> ExecuteUserOp(ApplicationEngine engine, UInt160 accountId,
            Array operation)
        {
            RequireApplication(engine);
            return (await ExecuteUserOpCoreAsync(engine, accountId, operation, false))!;
        }

        /// <summary>
        /// Batch execution: ≤ 32 operations, one atomic transaction — a fault on
        /// any operation reverts the whole envelope. The engine-local execution
        /// state is opened once here and inherited by every operation.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask<Array> ExecuteUserOps(ApplicationEngine engine, UInt160 accountId,
            Array operations)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            if (operations is null || operations.Type != StackItemType.Array
                || operations.Count is 0 or > SmartAccountModuleProtocol.MaxOperationsPerEnvelope)
                throw new FormatException(SmartAccountModuleProtocol.ErrorModuleLimitBatch);
            engine.AddNativeCpuFee(1 << 12);
            _ = BinarySerializer.Serialize(operations, SmartAccountModuleProtocol.EnvelopeEncodedSizeMax,
                SmartAccountModuleProtocol.EnvelopeEncodedSizeMax);

            SmartAccountInvocationContext context = Context(engine);
            bool ownsExecution = !context.TryGetExecution(accountId, out _);
            if (ownsExecution) context.OpenExecution(accountId);
            Array results = new();
            try
            {
                foreach (StackItem item in operations)
                {
                    if (item.Type != StackItemType.Array || item is not Array operation)
                        throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
                    results.Add((await ExecuteUserOpCoreAsync(engine, accountId, operation, true))!);
                }
            }
            finally
            {
                if (ownsExecution) context.CloseExecution(accountId);
            }
            return results;
        }

        /// <summary>
        /// Spec §4.1 single-operation encoding bound: the canonical NeoVM
        /// serialization of the WHOLE operation — signature included — must stay
        /// inside OperationEncodedSizeMax (16384 bytes). The proxy envelope
        /// enforces the same bound while decoding its payload
        /// (SmartAccountEnvelope), so the direct native ABI entrypoints must
        /// enforce it themselves; an over-long operation is malformed.
        /// </summary>
        private static void RequireOperationEncodedSize(Array operation)
        {
            try
            {
                _ = BinarySerializer.Serialize(operation,
                    SmartAccountModuleProtocol.OperationEncodedSizeMax,
                    SmartAccountModuleProtocol.OperationEncodedSizeMax);
            }
            catch (Exception exception) when (exception is FormatException or InvalidOperationException)
            {
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed, exception);
            }
        }

        private async ContractTask<StackItem> ExecuteUserOpCoreAsync(ApplicationEngine engine, UInt160 accountId,
            Array operation, bool inheritedEnvelope)
        {
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            SmartAccountInvocationContext context = Context(engine);
            bool ownsExecution = !inheritedEnvelope && !context.TryGetExecution(accountId, out _);
            if (ownsExecution) context.OpenExecution(accountId);
            try
            {
                Array op = SmartAccountProtocol.ValidateUserOperation(operation);
                RequireOperationEncodedSize(op);
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

                ValidationOutcome outcome = ResolveOperationRouting(engine.SnapshotCache, accountId, control, validatorId,
                    credentialGeneration, op);

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

                // ---- Phase: Validation ----
                await ValidateAsync(engine, accountId, control, op, digest, outcome);
                context.ClosePhase(accountId);

                // ---- Nonce consumption (validation passed) ----
                ConsumeOperationNonce(engine, accountId, channel, namespaceDigest, sequence);

                // ---- Phase: HookPre (snapshot order) ----
                int hookCount = outcome.HookIds.Length;
                byte[][] hookData = new byte[hookCount][];
                ModuleInstance[] hookModules = new ModuleInstance[hookCount];
                for (int i = 0; i < hookCount; i++)
                {
                    BigInteger hookId = outcome.HookIds[i];
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
                    await CallHookPostCheckAsync(engine, accountId, outcome.HookIds[i], hookModules[i], op, result,
                        hookData[i]);
                context.ClosePhase(accountId);

                // ---- Phase: Completion (the routed validator only) ----
                if (outcome.Module is not null)
                    await CallValidatorCompletionAsync(engine, accountId, validatorId, outcome.Module, op, result);
                context.ClosePhase(accountId);

                // ---- Code-binding continuity before commit (spec §7.3) ----
                AssertCodeBindingsAtCommit(engine.SnapshotCache, outcome);
                foreach (ModuleInstance hook in hookModules) AssertModuleCodeBinding(engine.SnapshotCache, hook);

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
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadOnly)]
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
            Dictionary<BigInteger, byte[]> namespaces = new();
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
                ValidationOutcome outcome = ResolveOperationRouting(engine.SnapshotCache, accountId, control, validatorId,
                    credentialGeneration, op);

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
                AssertOperationNonceNamespace(engine.SnapshotCache, accountId, channel, namespaceDigest);
                if (namespaces.TryGetValue(channelValue, out byte[]? knownNamespace))
                    Require(knownNamespace.AsSpan().SequenceEqual(namespaceDigest),
                        SmartAccountModuleProtocol.ErrorNonceChannelCollision);
                else
                    namespaces.Add(channelValue, namespaceDigest);
                cursors[channelValue] = cursor + 1;

                byte[] digest = SmartAccountProtocol.ComputeOperationDigest(engine.ProtocolSettings.Network, Hash,
                    accountId, op, validatorId, credentialGeneration, authorityEpoch, configurationNonce);
                await ValidateAsync(engine, accountId, control, op, digest, outcome);
            }
            return true;
        }
    }
}
