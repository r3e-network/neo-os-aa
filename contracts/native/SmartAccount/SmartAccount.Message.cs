// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccount.Message.cs file belongs to the neo project and is free
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
using Neo.Persistence;
using Neo.VM.Types;
using System;
using System.Numerics;
using System.Security.Cryptography;
using Array = Neo.VM.Types.Array;
using Boolean = Neo.VM.Types.Boolean;
using ECCurve = Neo.Cryptography.ECC.ECCurve;
using ECPoint = Neo.Cryptography.ECC.ECPoint;
using HashAlgorithm = Neo.Cryptography.HashAlgorithm;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// Built-in message signatures (spec §8): core P-256 single/threshold
    /// message verification with no plugin dependency, the 0x57 subject store
    /// and the ERC-1271 entrypoint. Semantics are identical to the custom
    /// kernel; only the execution substrate differs.
    ///
    /// Message validation is READ-ONLY: it never consumes nonces, never runs
    /// stateful quota hooks and a transaction witness can never satisfy it.
    /// </summary>
    public sealed partial class SmartAccount
    {
        // Canonical N3 P-256 verification script shape (40 bytes):
        //   PUSHDATA1(0x0C) 0x21 <33-byte compressed point> SYSCALL(0x41) 56 E7 B3 27
        // where 56e7b327 is the little-endian interop hash of "System.Crypto.CheckSig",
        // i.e. exactly what Contract.CreateSignatureRedeemScript emits on N3.
        private const int CanonicalP256ScriptSize = 40;
        private static readonly byte[] CheckSigSyscallHash = [0x56, 0xE7, 0xB3, 0x27];

        // ========================================================================
        // 1. Subject store (0x57)
        // ========================================================================

        private MessageSubjectRecord? TryMessageSubjects(IReadOnlyStore snapshot, UInt160 accountId) =>
            TryRead(snapshot, SmartAccountProtocol.GetMessageSubjectKey(accountId), out var value)
                ? MessageSubjectRecord.Decode(value)
                : null;

        private void SaveMessageSubjects(ApplicationEngine engine, UInt160 accountId,
            MessageSubjectRecord record) =>
            Write(engine, SmartAccountProtocol.GetMessageSubjectKey(accountId), record.Serialize());

        /// <summary>
        /// Registration default (spec §8): the custody account address is the
        /// single subject, so the custody key can sign built-in messages
        /// immediately after registration instead of waiting 24h for a subject
        /// intent. 32-byte script-hash subjects remain available through the
        /// intent path.
        /// </summary>
        private void InitializeDefaultMessageSubjects(ApplicationEngine engine, UInt160 accountId,
            UInt160 custody) =>
            SaveMessageSubjects(engine, accountId, new MessageSubjectRecord
            {
                Subjects = [custody.ToArray()],
                Threshold = 1,
                SubjectRevision = 1,
            });

        /// <summary>
        /// setMessageSubjects configuration action (spec §9): custody-gated,
        /// 24h-timelocked through the intent path. Every change advances
        /// subjectRevision, which is the built-in credentialGeneration.
        /// </summary>
        private void ExecuteSetMessageSubjectsAction(ApplicationEngine engine, UInt160 accountId, Array action)
        {
            // [ActionSetMessageSubjects, subjects(ByteString[]), threshold]
            Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
            byte[][] subjects = SmartAccountRecordCodec.BytesArray(action[1],
                SmartAccountModuleProtocol.MessageSubjectKeysMax, 32);
            BigInteger threshold = SmartAccountRecordCodec.Unsigned(action[2]);
            Require(threshold >= 1 && threshold <= subjects.Length,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            for (int i = 0; i < subjects.Length; i++)
            {
                // 20-byte account-address subjects and 32-byte script-hash
                // subjects are both accepted (see SubjectMatches).
                Require(subjects[i].Length is 20 or 32, SmartAccountModuleProtocol.ErrorOperationMalformed);
                for (int j = 0; j < i; j++)
                    Require(!subjects[j].AsSpan().SequenceEqual(subjects[i]),
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
            }

            MessageSubjectRecord record = TryMessageSubjects(engine.SnapshotCache, accountId)
                ?? new MessageSubjectRecord { SubjectRevision = 0 };
            record.Subjects = subjects;
            record.Threshold = (ulong)threshold;
            record.SubjectRevision += 1;
            SaveMessageSubjects(engine, accountId, record);
            Notify(engine, SmartAccountModuleProtocol.EventNameMessageSubjectUpdated, accountId.ToArray(),
                new BigInteger(subjects.Length), threshold, new BigInteger(record.SubjectRevision));
        }

        /// <summary>
        /// Subject matching (spec §8). A 20-byte subject is the signer's N3
        /// script hash (RIPEMD160 of the script's SHA256); a 32-byte subject is
        /// the raw SHA256 of the signer's verification script. Both bind the
        /// signer SCRIPT, which is what the ECDSA check verifies.
        /// </summary>
        private static bool SubjectMatches(byte[] subject, ReadOnlySpan<byte> script,
            ReadOnlySpan<byte> scriptSha256) =>
            subject.Length switch
            {
                32 => subject.AsSpan().SequenceEqual(scriptSha256),
                20 => subject.AsSpan().SequenceEqual(Crypto.Hash160(script)),
                _ => false,
            };

        // ========================================================================
        // 2. Message digest domain (spec §8)
        // ========================================================================

        /// <summary>
        /// messageDigest := SHA256( UTF8("NeoSmartAccount/Message") || U1(4) ||
        /// U32LE(network) || coreHash || accountId || originalSender ||
        /// U64BE(validatorId) || U64BE(credentialGeneration) ||
        /// U64BE(authorityEpoch) || hash ).
        /// </summary>
        private byte[] ComputeMessageDigest(ApplicationEngine engine, UInt160 accountId,
            UInt160 originalSender, BigInteger validatorId, BigInteger credentialGeneration,
            BigInteger authorityEpoch, ReadOnlySpan<byte> hash) =>
            SHA256.HashData(SmartAccountProtocol.Concat(
                "NeoSmartAccount/Message"u8.ToArray(), [SmartAccountProtocol.Version],
                SmartAccountProtocol.UInt32Le(engine.ProtocolSettings.Network), Hash.ToArray(),
                accountId.ToArray(), originalSender.ToArray(), SmartAccountProtocol.UInt64Be(validatorId),
                SmartAccountProtocol.UInt64Be(credentialGeneration), SmartAccountProtocol.UInt64Be(authorityEpoch),
                hash.ToArray()));

        // ========================================================================
        // 3. Canonical P-256 script validation
        // ========================================================================

        /// <summary>
        /// Extracts the 33-byte compressed point from a canonical N3 P-256
        /// verification script, or null when the script is not the standard
        /// wallet script-builder shape (off-curve points and non-canonical
        /// scripts are rejected here; curve membership is enforced by the
        /// signature check).
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
        // 4. ERC-1271 entrypoint (spec §8)
        // ========================================================================

        /// <summary>
        /// ERC-1271-style message-signature check. Returns the strict 4-byte
        /// magic: 0x1626ba7e on success, 0xffffffff on ANY failure — throwing
        /// is never the success channel. Read-only: no nonce consumption, no
        /// quota hooks, no witness satisfaction.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private async ContractTask<byte[]> IsValidSignature(ApplicationEngine engine, UInt160 accountId,
            byte[] hash, Array signatureEnvelope)
        {
            try
            {
                return (await IsValidSignatureCoreAsync(engine, accountId, hash, signatureEnvelope))!;
            }
            catch
            {
                return InvalidSignatureMagic();
            }
        }

        private static byte[] MagicBytes(uint magic) =>
        [
            (byte)((magic >> 24) & 0xFF), (byte)((magic >> 16) & 0xFF),
            (byte)((magic >> 8) & 0xFF), (byte)(magic & 0xFF),
        ];

        private static byte[] ValidSignatureMagic() => MagicBytes(SmartAccountModuleProtocol.MagicIsValidSignature);

        private static byte[] InvalidSignatureMagic() => MagicBytes(SmartAccountModuleProtocol.MagicInvalidSignature);

        private async ContractTask<byte[]> IsValidSignatureCoreAsync(ApplicationEngine engine, UInt160 accountId,
            byte[] hash, Array signatureEnvelope)
        {
            RequireAccountId(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            // A frozen (or migration-required) account is fully stopped: message
            // authorization fails closed instead of staying reachable.
            if (control.Status != SmartAccountStatus.Active) return InvalidSignatureMagic();
            if (hash is null || hash.Length != SmartAccountModuleProtocol.MessageHashSize)
                return InvalidSignatureMagic();
            if (signatureEnvelope is null || signatureEnvelope.Count != 4
                || signatureEnvelope[0] is not Integer version
                || version.GetInteger() != SmartAccountModuleProtocol.ModuleProtocolVersion
                || signatureEnvelope[1] is not Integer validatorItem
                || signatureEnvelope[2] is not Integer generationItem)
                return InvalidSignatureMagic();
            BigInteger validatorId = validatorItem.GetInteger();
            BigInteger credentialGeneration = generationItem.GetInteger();
            if (validatorId < 0 || credentialGeneration < 0) return InvalidSignatureMagic();
            if (signatureEnvelope[3] is not Array pairs || pairs.Count is < 1 or > SmartAccountModuleProtocol.MessageSubjectKeysMax)
                return InvalidSignatureMagic();

            UInt160 originalSender = engine.CallingScriptHash ?? UInt160.Zero;

            if (validatorId == BigInteger.Zero)
            {
                // Built-in route: gated by the default message authorization
                // switch and the 0x57 subject set.
                if (!control.DefaultMessageAuthorization) return InvalidSignatureMagic();
                MessageSubjectRecord? subjects = TryMessageSubjects(engine.SnapshotCache, accountId);
                if (subjects is null || subjects.Subjects.Length == 0 || subjects.Threshold < 1)
                    return InvalidSignatureMagic();
                if (credentialGeneration != subjects.SubjectRevision) return InvalidSignatureMagic();

                byte[] digest = ComputeMessageDigest(engine, accountId, originalSender, validatorId,
                    credentialGeneration, control.AuthorityEpoch, hash);
                return (ulong)CountBuiltInApprovals(subjects, digest, pairs) >= subjects.Threshold
                    ? ValidSignatureMagic()
                    : InvalidSignatureMagic();
            }

            // Module route: only validators whose profile declares
            // messageCapability may sign messages.
            ModuleInstance? module = TryModuleInstance(engine.SnapshotCache, accountId, validatorId);
            if (module is null || !module.IsValidator || !module.MessageCapability)
                return InvalidSignatureMagic();
            if (credentialGeneration != module.CredentialGeneration) return InvalidSignatureMagic();

            byte[] moduleDigest = ComputeMessageDigest(engine, accountId, originalSender, validatorId,
                credentialGeneration, control.AuthorityEpoch, hash);
            StackItem reply = (await CallModuleAsync(engine, accountId, validatorId, module, "isValidSignature",
                SmartAccountCallbackPhase.Validation, CallFlags.ReadStates,
                SmartAccountModuleProtocol.ValidationPerCallGasLimit, SmartAccountGasPool.Validation,
                new StackItem[]
                {
                    accountId.ToArray(), originalSender.ToArray(), validatorId,
                    credentialGeneration, moduleDigest,
                    BuildCanonicalOperationView(pairs, engine),
                }))!;
            // ERC-1271 fails closed: a reply that is not Boolean is treated as false.
            return reply is Boolean accepted && accepted.GetBoolean()
                ? ValidSignatureMagic()
                : InvalidSignatureMagic();
        }

        /// <summary>
        /// Counts the distinct, subject-authorized, cryptographically valid
        /// signatures of a built-in message envelope. Any malformed entry
        /// aborts the whole attempt (fail closed, never partial).
        /// </summary>
        private static int CountBuiltInApprovals(MessageSubjectRecord subjects, ReadOnlySpan<byte> digest, Array pairs)
        {
            int approvals = 0;
            for (int i = 0; i < pairs.Count; i++)
            {
                if (pairs[i] is not Array pair || pair.Count != 2
                    || pair[0] is not ByteString script || pair[1] is not ByteString signature
                    || signature.Size != SmartAccountModuleProtocol.P256SignatureSize)
                    return 0;
                if (script.Size != CanonicalP256ScriptSize) return 0;
                byte[]? point = TryGetCanonicalP256Point(script.GetSpan());
                if (point is null) return 0;

                ReadOnlySpan<byte> scriptSha256 = SHA256.HashData(script.GetSpan());
                bool authorized = false;
                foreach (byte[] subject in subjects.Subjects)
                {
                    if (SubjectMatches(subject, script.GetSpan(), scriptSha256))
                    {
                        authorized = true;
                        break;
                    }
                }
                if (!authorized) return 0;

                // Scripts in one envelope must be pairwise distinct.
                for (int j = 0; j < i; j++)
                {
                    if (pairs[j] is not Array previous || previous.Count != 2
                        || previous[0] is not ByteString previousScript)
                        return 0;
                    if (previousScript.GetSpan().SequenceEqual(script.GetSpan())) return 0;
                }

                if (!Crypto.VerifySignature(digest, signature.GetSpan(), ECPoint.DecodePoint(point,
                        ECCurve.Secp256r1), HashAlgorithm.SHA256))
                    return 0;
                approvals++;
            }
            return approvals;
        }
    }
}
