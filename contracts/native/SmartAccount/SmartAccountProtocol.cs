// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountProtocol.cs file belongs to the neo project and is free
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
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using Array = Neo.VM.Types.Array;
using Boolean = Neo.VM.Types.Boolean;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// State-independent identity, signing, envelope and key encoding for the
    /// native SmartAccount kernel under SA module protocol v4.
    ///
    /// Everything in this file is byte-for-byte shared with the custom kernel
    /// (docs/SA-MODULE-PROTOCOL.md §4.2/§4.3/§6/§7.1): the operation digest,
    /// the canonical unsigned operation bytes, the derived 191-bit nonce
    /// channel and the 0x50–0x5E storage keys. The two kernels must produce the
    /// same bytes for the same inputs; a divergence here is a protocol defect,
    /// not an implementation choice.
    /// </summary>
    internal static class SmartAccountProtocol
    {
        internal const byte Version = SmartAccountModuleProtocol.ModuleProtocolVersion;

        // ------------------------------------------------------------------
        // 1. Account identity (spec §16.1: custody + salt)
        // ------------------------------------------------------------------

        /// <summary>
        /// v4 account identity domain, identical to the custom kernel's
        /// AccountIdentityDomainV4 so both kernels derive the same account id
        /// for the same (custody, salt).
        /// </summary>
        internal static readonly byte[] AccountIdentityDomain = { 0xAA, 0x52, 0x47, 0x04 };
        internal const int SaltMinBytes = 1;
        internal const int SaltMaxBytes = 128;

        private static readonly byte[] ServiceHashBytes =
            Helper.GetContractHash(UInt160.Zero, 0, "SmartAccount").ToArray();
        internal static UInt160 ServiceHash => new(ServiceHashBytes);

        /// <summary>
        /// Deterministic v4 identity: the raw UInt160 bytes are
        /// RIPEMD160(SHA256(domain ‖ custody ‖ salt)) reversed — exactly the
        /// custom kernel's ComputeAccountIdentity.
        /// </summary>
        internal static UInt160 GetAccountId(UInt160 custody, ReadOnlySpan<byte> salt)
        {
            RequireIdentity(custody);
            if (salt.Length < SaltMinBytes || salt.Length > SaltMaxBytes)
                throw new FormatException("The registration salt must contain 1 through 128 bytes.");
            byte[] payload = new byte[AccountIdentityDomain.Length + UInt160.Length + salt.Length];
            AccountIdentityDomain.CopyTo(payload, 0);
            custody.ToArray().CopyTo(payload, AccountIdentityDomain.Length);
            salt.CopyTo(payload.AsSpan(AccountIdentityDomain.Length + UInt160.Length));
            byte[] digest = payload.Sha256().RIPEMD160();
            byte[] raw = new byte[UInt160.Length];
            for (int i = 0; i < UInt160.Length; i++) raw[i] = digest[UInt160.Length - 1 - i];
            UInt160 result = new(raw);
            RequireIdentity(result);
            return result;
        }

        /// <summary>
        /// The fixed proxy verification script of an account:
        /// PUSHDATA1 20 accountId, PUSH1 PACK PUSH15, PUSHDATA1 "verify",
        /// PUSHDATA1 core, SYSCALL System.Contract.Call. Byte-identical to the
        /// custom kernel's BuildProxyVerificationScript.
        /// </summary>
        internal static byte[] CreateVerificationScript(UInt160 accountId)
        {
            RequireIdentity(accountId);
            using ScriptBuilder builder = new();
            builder.EmitDynamicCall(ServiceHash, "verify", CallFlags.ReadOnly, accountId);
            return builder.ToArray();
        }

        internal static UInt160 GetAccountAddress(UInt160 accountId) =>
            CreateVerificationScript(accountId).ToScriptHash();

        /// <summary>
        /// Recognizes the fixed proxy verification script of an account
        /// (spec §3.6). An account proxy is authorized only by its own verified
        /// dispatch, never by transaction signer scopes, so the node must be able
        /// to tell a proxy witness script apart without a reverse index.
        /// </summary>
        internal static bool IsProxyVerificationScript(ReadOnlySpan<byte> script)
        {
            if (script.Length < 2 + UInt160.Length) return false;
            if (script[0] != 0x0C || script[1] != UInt160.Length) return false;
            UInt160 accountId = new(script.Slice(2, UInt160.Length).ToArray());
            try
            {
                return CreateVerificationScript(accountId).AsSpan().SequenceEqual(script);
            }
            catch
            {
                return false;
            }
        }

        // ------------------------------------------------------------------
        // 2. Canonical operation and digest (spec §4.2/§4.3)
        // ------------------------------------------------------------------

        internal static readonly byte[] UserOperationDomain =
            "NeoSmartAccount/UserOperation"u8.ToArray();

        /// <summary>
        /// §4.3 operation digest: SHA256( domain ‖ canonical unsigned operation )
        /// with domain = UTF8("NeoSmartAccount/UserOperation") ‖ U1(version) ‖
        /// U32LE(network) ‖ coreHash ‖ accountId ‖ U64BE(validatorId) ‖
        /// U64BE(credentialGeneration) ‖ U64BE(authorityEpoch) ‖
        /// U64BE(configurationNonce). The core hash is the ACTUAL executing core.
        /// </summary>
        internal static byte[] ComputeOperationDigest(uint network, UInt160 coreHash, UInt160 accountId,
            StackItem operation, BigInteger validatorId, BigInteger credentialGeneration,
            BigInteger authorityEpoch, BigInteger configurationNonce)
        {
            byte[] domain = Concat(
                UserOperationDomain, new[] { Version }, UInt32Le(network), coreHash.ToArray(),
                accountId.ToArray(), UInt64Be(validatorId), UInt64Be(credentialGeneration),
                UInt64Be(authorityEpoch), UInt64Be(configurationNonce));
            return SHA256.HashData(Concat(domain, SerializeCanonicalOperation(operation)));
        }

        /// <summary>
        /// NeoVM binary serialization of the 13-field operation with field 11
        /// replaced by the empty ByteString (§4.2).
        /// </summary>
        internal static byte[] SerializeCanonicalOperation(StackItem operation)
        {
            Array op = ValidateUserOperation(operation);
            Array canonical = new();
            for (int i = 0; i < SmartAccountModuleProtocol.UserOperationFieldCount; i++)
                canonical.Add(i == SmartAccountModuleProtocol.OpSignature ? ByteString.Empty : op[i]);
            return BinarySerializer.Serialize(canonical,
                SmartAccountModuleProtocol.OperationEncodedSizeMax,
                SmartAccountModuleProtocol.OperationEncodedSizeMax);
        }

        /// <summary>
        /// Strict 13-field v4 envelope validation (§4.1): exact Array shape, no
        /// Struct, every field inside its declared domain, hook proofs unique
        /// and strictly ascending. Returns the same Array for chaining.
        /// </summary>
        internal static Array ValidateUserOperation(StackItem operation)
        {
            if (operation.Type != StackItemType.Array || operation is not Array op
                || op.Count != SmartAccountModuleProtocol.UserOperationFieldCount)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationFieldCount);
            if (op[SmartAccountModuleProtocol.OpVersion] is not Integer version
                || version.GetInteger() != SmartAccountModuleProtocol.ModuleProtocolVersion)
                throw new FormatException(SmartAccountModuleProtocol.ErrorProtocolVersion);
            if (op[SmartAccountModuleProtocol.OpTarget] is not ByteString target
                || target.Size != UInt160.Length || new UInt160(target.GetSpan()) == UInt160.Zero)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            if (op[SmartAccountModuleProtocol.OpMethod] is not ByteString method
                || method.Size is 0 or > SmartAccountModuleProtocol.MethodBytesMax)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            try
            {
                _ = Utility.StrictUTF8.GetCharCount(method.GetSpan());
            }
            catch (DecoderFallbackException exception)
            {
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed, exception);
            }
            if (op[SmartAccountModuleProtocol.OpArgs].Type != StackItemType.Array
                || op[SmartAccountModuleProtocol.OpArgs] is not Array args
                || args.Count > SmartAccountModuleProtocol.ArgsCountMax)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            _ = ValidateArgument(args, 0, new HashSet<Array>(ReferenceEqualityComparer.Instance), 0);
            // [4] nonce — 191-bit channel ‖ 64-bit sequence, non-negative < 2^255
            // (§4.1). The channel is derived, never chosen (§6), so the field is
            // a packed 255-bit value, not a plain 64-bit sequence.
            if (op[SmartAccountModuleProtocol.OpNonce] is not Integer packed
                || packed.GetInteger() < 0 || packed.GetInteger() >= MaxNonce)
                throw new FormatException(SmartAccountModuleProtocol.ErrorNonceInvalid);
            if (op[SmartAccountModuleProtocol.OpNonceSubkey] is not ByteString subkey
                || subkey.Size != SmartAccountModuleProtocol.NonceSubkeySize)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            if (op[SmartAccountModuleProtocol.OpDeadline] is not Integer deadline
                || deadline.GetInteger() < 0 || deadline.GetInteger() >= BigInteger.One << 255)
                throw new FormatException(SmartAccountModuleProtocol.ErrorDeadlineExpired);
            RequireUnsigned64(op[SmartAccountModuleProtocol.OpValidatorId]);
            RequireCredentialGeneration(op[SmartAccountModuleProtocol.OpCredentialGeneration]);
            RequireUnsigned64(op[SmartAccountModuleProtocol.OpAuthorityEpoch]);
            RequireUnsigned64(op[SmartAccountModuleProtocol.OpConfigurationNonce]);
            if (op[SmartAccountModuleProtocol.OpSignature] is not ByteString signature
                || signature.Size is 0 or > SmartAccountModuleProtocol.SignatureBytesMax)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            // Field 12 is module-defined and core-carried (§4.2 R-04-03): the
            // core checks the shape only and never interprets a proof, so the
            // field stays digest-covered and a routing module reads it verbatim.
            ValidateHookProofs(op[SmartAccountModuleProtocol.OpHookProofs]);
            return op;
        }

        /// <summary>
        /// Shape of <c>hookProofs</c> (§4.2 R-04-03): an Array of 0—8 entries,
        /// each a two-element Array of a positive strictly ascending UInt64
        /// <c>hookId</c> and a ByteString proof, with all proofs together inside
        /// the 4096-byte bound. What a proof means is the routing module's
        /// business, so the core admits the field without reading it.
        /// </summary>
        private static void ValidateHookProofs(StackItem item)
        {
            if (item.Type != StackItemType.Array || item is not Array proofs
                || proofs.Count > SmartAccountModuleProtocol.HookProofsEntriesMax)
                throw new FormatException(SmartAccountModuleProtocol.ErrorProofInvalid);
            BigInteger previous = BigInteger.MinusOne;
            int total = 0;
            foreach (StackItem entry in proofs)
            {
                if (entry.Type != StackItemType.Array || entry is not Array pair || pair.Count != 2)
                    throw new FormatException(SmartAccountModuleProtocol.ErrorProofInvalid);
                if (pair[0] is not Integer hookId)
                    throw new FormatException(SmartAccountModuleProtocol.ErrorProofInvalid);
                BigInteger id = hookId.GetInteger();
                if (id < BigInteger.One || id >> 64 != BigInteger.Zero || id <= previous)
                    throw new FormatException(SmartAccountModuleProtocol.ErrorProofInvalid);
                previous = id;
                if (pair[1] is not ByteString proof)
                    throw new FormatException(SmartAccountModuleProtocol.ErrorProofInvalid);
                total += proof.Size;
                if (total > SmartAccountModuleProtocol.HookProofBytesMax)
                    throw new FormatException(SmartAccountModuleProtocol.ErrorProofInvalid);
            }
        }

        /// <summary>
        /// Bounds nested argument arrays (§4.1): Null/Boolean/Integer/ByteString/
        /// Array only, depth ≤ 8, unique container references, serialized ≤ 4096
        /// bytes. Containers must be strict Arrays — a Struct anywhere is
        /// rejected. Returns the accumulated serialized size.
        /// </summary>
        private static int ValidateArgument(StackItem item, int depth, HashSet<Array> seen, int size)
        {
            switch (item)
            {
                case Null:
                    return Charge(size, 1);
                case Boolean:
                    return Charge(size, 2);
                case Integer:
                case ByteString:
                    int length = item.GetSpan().Length;
                    return Charge(size, 1 + VarIntSize(length) + length);
                case Array array:
                    if (item.Type != StackItemType.Array
                        || depth >= SmartAccountModuleProtocol.ArgsDepthMax || !seen.Add(array))
                        throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
                    size = Charge(size, 1 + VarIntSize(array.Count));
                    foreach (StackItem child in array)
                        size = ValidateArgument(child, depth + 1, seen, size);
                    return size;
                default:
                    throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            }
        }

        private static int VarIntSize(int value) => value < 0xfd ? 1 : value <= ushort.MaxValue ? 3 : 5;

        private static int Charge(int size, int bytes)
        {
            if (bytes > SmartAccountModuleProtocol.ArgsSerializedSizeMax - size)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            return size + bytes;
        }

        // ------------------------------------------------------------------
        // 3. Derived nonce namespace and 191-bit channel (spec §6)
        // ------------------------------------------------------------------

        internal static readonly BigInteger UInt64Mask = (BigInteger.One << 64) - 1;
        /// <summary>The 191-bit channel mask: a packed nonce keeps the channel in bits 64..254.</summary>
        internal static readonly BigInteger ChannelMask = (BigInteger.One << 191) - 1;
        /// <summary>The exclusive upper bound of a packed nonce and of a deadline.</summary>
        internal static readonly BigInteger MaxNonce = BigInteger.One << 255;

        /// <summary>
        /// Full 256-bit nonce-namespace derivation (§6), persisted under 0x5C so
        /// a channel truncation collision fails closed instead of merging two
        /// signers' sequences.
        /// </summary>
        internal static byte[] ComputeNonceNamespaceDigest(UInt160 accountId, UInt160 coreHash,
            BigInteger authorityEpoch, BigInteger validatorId, BigInteger credentialGeneration,
            ReadOnlySpan<byte> nonceSubkey)
        {
            return SHA256.HashData(Concat(
                new[] { Version }, coreHash.ToArray(), accountId.ToArray(),
                UInt64Be(authorityEpoch), UInt64Be(validatorId), UInt64Be(credentialGeneration),
                nonceSubkey.ToArray()));
        }

        /// <summary>
        /// Derived 191-bit channel bytes (24 bytes, top bit zero): the low 191
        /// bits of the namespace digest, i.e. digest bytes 8..31 with the most
        /// significant bit of byte 8 cleared (spec §6, figure 13). Signers never
        /// choose a channel.
        /// </summary>
        internal static byte[] DeriveChannel(ReadOnlySpan<byte> namespaceDigest)
        {
            if (namespaceDigest.Length != 32)
                throw new FormatException("A namespace digest is exactly 32 bytes.");
            byte[] channel = new byte[SmartAccountModuleProtocol.NonceChannelSize];
            const int Offset = 32 - SmartAccountModuleProtocol.NonceChannelSize;
            channel[0] = (byte)(namespaceDigest[Offset] & 0x7F);
            for (int i = 1; i < channel.Length; i++)
                channel[i] = namespaceDigest[Offset + i];
            return channel;
        }

        /// <summary>The 256-bit nonce: channel in the high 191 bits, sequence in the low 64.</summary>
        internal static BigInteger EncodeNonce(ReadOnlySpan<byte> channel, ulong sequence)
        {
            BigInteger value = BigInteger.Zero;
            for (int i = 0; i < channel.Length; i++)
                value = (value << 8) | channel[i];
            value &= ChannelMask;
            return (value << 64) | sequence;
        }

        internal static byte[] ChannelFromNonce(BigInteger nonce)
        {
            RequireNonceValue(nonce, "nonce");
            BigInteger channel = nonce >> 64;
            byte[] encoded = new byte[SmartAccountModuleProtocol.NonceChannelSize];
            for (int i = encoded.Length - 1; i >= 0; i--)
            {
                encoded[i] = (byte)(channel & 0xFF);
                channel >>= 8;
            }
            return encoded;
        }

        internal static ulong SequenceFromNonce(BigInteger nonce)
        {
            RequireNonceValue(nonce, "nonce");
            return (ulong)(nonce & UInt64Mask);
        }

        /// <summary>A packed nonce is non-negative and below 2^255 (§4.1).</summary>
        internal static void RequireNonceValue(BigInteger value, string field)
        {
            if (value < 0 || value >= MaxNonce)
                throw new FormatException($"The {field} must be a non-negative 255-bit Integer.");
        }

        // ------------------------------------------------------------------
        // 4. Canonical storage keys (spec §7.1)
        //    The content builders live in SmartAccountModuleProtocol (paired
        //    with the custom kernel); every full key is one prefix byte plus
        //    that content.
        // ------------------------------------------------------------------

        internal static byte[] GetProtocolKey() => new byte[] { SmartAccountModuleProtocol.PrefixProtocolInfo };
        internal static byte[] GetAccountControlKey(UInt160 accountId) =>
            Prefixed(SmartAccountModuleProtocol.PrefixAccountControl, SmartAccountModuleProtocol.AccountControlKeyContent(accountId));
        internal static byte[] GetModuleInstanceKey(UInt160 accountId, BigInteger moduleId) =>
            Prefixed(SmartAccountModuleProtocol.PrefixModuleInstance,
                SmartAccountModuleProtocol.ModuleInstanceKeyContent(accountId, UInt64(moduleId)));
        internal static byte[] GetModuleIndexKey(UInt160 accountId, byte moduleType, BigInteger moduleId) =>
            Prefixed(SmartAccountModuleProtocol.PrefixModuleIndex,
                SmartAccountModuleProtocol.ModuleIndexKeyContent(accountId, moduleType, UInt64(moduleId)));
        internal static byte[] GetNonceCursorKey(UInt160 accountId, ReadOnlySpan<byte> channel) =>
            Prefixed(SmartAccountModuleProtocol.PrefixNonceCursor,
                SmartAccountModuleProtocol.NonceCursorKeyContent(accountId, channel));
        internal static byte[] GetNonceNamespaceKey(UInt160 accountId, ReadOnlySpan<byte> channel) =>
            Prefixed(SmartAccountModuleProtocol.PrefixNonceNamespace,
                SmartAccountModuleProtocol.NonceNamespaceKeyContent(accountId, channel));

        private static byte[] Prefixed(byte prefix, byte[] content)
        {
            byte[] result = new byte[content.Length + 1];
            result[0] = prefix;
            content.CopyTo(result, 1);
            return result;
        }

        // ------------------------------------------------------------------
        // 5. Encoding helpers shared by the record codecs
        // ------------------------------------------------------------------

        internal static byte[] UInt64Be(BigInteger value)
        {
            RequireUnsigned64Value(value, "integer");
            return SmartAccountModuleProtocol.UInt64ToBigEndian((ulong)value);
        }

        internal static ulong UInt64(BigInteger value)
        {
            RequireUnsigned64Value(value, "integer");
            return (ulong)value;
        }

        internal static void RequireUnsigned64Value(BigInteger value, string field)
        {
            if (value < 0 || (value >> 64) != BigInteger.Zero)
                throw new FormatException($"The {field} must be an unsigned 64-bit Integer.");
        }

        private static void RequireUnsigned64(StackItem item)
        {
            if (item is not Integer value) throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            BigInteger integer = value.GetInteger();
            if (integer < 0 || (integer >> 64) != BigInteger.Zero)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
        }

        /// <summary>
        /// [8] credentialGeneration is an unsigned 64-bit Integer with a lower
        /// bound of 1 (spec §7.3): revision zero names no live credential, so it
        /// is rejected exactly like the custom kernel's envelope assertion.
        /// </summary>
        private static void RequireCredentialGeneration(StackItem item)
        {
            RequireUnsigned64(item);
            if (item.GetInteger() < 1)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
        }

        internal static byte[] UInt32Le(uint value)
        {
            byte[] encoded = new byte[4];
            BinaryPrimitives.WriteUInt32LittleEndian(encoded, value);
            return encoded;
        }

        internal static byte[] Concat(params byte[][] parts)
        {
            int length = 0;
            foreach (byte[] part in parts) length += part.Length;
            byte[] result = new byte[length];
            int offset = 0;
            foreach (byte[] part in parts)
            {
                part.CopyTo(result, offset);
                offset += part.Length;
            }
            return result;
        }

        internal static void RequireIdentity(UInt160 identity)
        {
            if (identity is null || identity == UInt160.Zero)
                throw new FormatException("A zero account or custody identity is not permitted.");
        }
    }
}
