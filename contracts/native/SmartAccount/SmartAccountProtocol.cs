// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountProtocol.cs file belongs to the neo project and is free software distributed under the MIT software
// license, see the accompanying file LICENSE in the main directory of the repository or
// http://www.opensource.org/licenses/mit-license.php for more details.
//
// Redistribution and use in source and binary forms with or without modifications are permitted.

// TRUE SOURCE: this is the only editable copy of this SmartAccount native
// contract file. The neo-native-core checkout carries a generated copy —
// regenerate it via scripts/sync_native_smartaccount.py.

using Neo.Cryptography;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
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
    /// <summary> State-independent identity, digest and nonce-channel derivation for the native SmartAccount
    /// kernel (spec §4/§6). </summary>
    internal static class SmartAccountProtocol
    {
        internal const byte Version = SmartAccountModuleProtocol.ModuleProtocolVersion;

        // 1. Account identity (spec §16.1: custody + salt)
        internal static readonly byte[] AccountIdentityDomain = { 0xAA, 0x52, 0x47, 0x04 };
        internal const int SaltMinBytes = 1;
        internal const int SaltMaxBytes = 128;

        private static readonly byte[] ServiceHashBytes =
            Helper.GetContractHash(UInt160.Zero, 0, "SmartAccount").ToArray();
        internal static UInt160 ServiceHash => new(ServiceHashBytes);

        // The two pinned scripts of an account (spec §3.6/§4.1) are each one dynamic call to this core that pushes
        // the account as a single PUSHDATA1 literal: the proxy verification script calls verify(accountId) with
        // ReadOnly, the transaction entry script calls executeUserOp(accountId, operation) with CallFlags.All. What
        // follows the arguments is defined once, by the platform emitter both scripts are created with, and is the
        // same bytes the shared SDK's dynamicCall appends.
        private static ReadOnlySpan<byte> AccountPushHeader =>
            [(byte)OpCode.PUSHDATA1, (byte)UInt160.Length];

        private const int AccountPushLength = 2 + UInt160.Length; // the header and the twenty account bytes

        /// <summary>Everything one dynamic call ends with once its arguments are on the stack: their count and PACK,
        /// the call flags, the method name, this core and SYSCALL System.Contract.Call.</summary>
        private static byte[] CreateCallTail(int argumentCount, CallFlags flags, string method)
        {
            using ScriptBuilder builder = new();
            builder.EmitPush(argumentCount).Emit(OpCode.PACK).EmitPush((int)flags).EmitPush(method)
                .EmitPush(ServiceHashBytes).EmitSysCall(ApplicationEngine.System_Contract_Call);
            return builder.ToArray();
        }

        // The proxy script is exactly: account push, then its tail (PUSH1 PACK, PUSH5 = CallFlags.ReadOnly,
        // PUSHDATA1 "verify", PUSHDATA1 core, SYSCALL Contract.Call).
        private static readonly byte[] ProxyTail = CreateCallTail(1, CallFlags.ReadOnly, "verify");

        // The transaction entry script (spec §3.6/§4.1) ends with the account push and its own tail. The witness
        // design keeps verify(accountId) argument-free, so the operation travels in tx.Script and the core reads it
        // back from there. For the arguments [accountId, operation] the shared SDK (shared/nativeSmartAccount.mjs
        // dynamicCall) emits the operation literal, then the account push, then this tail and nothing after it.
        private static readonly byte[] EntryTail = CreateCallTail(2, CallFlags.All, "executeUserOp");

        // Deterministic v4 identity: RIPEMD160(SHA256(domain ‖ custody ‖ salt)) reversed.
        internal static UInt160 GetAccountId(UInt160 custody, ReadOnlySpan<byte> salt)
        {
            RequireIdentity(custody);
            if (salt.Length < SaltMinBytes || salt.Length > SaltMaxBytes)
                throw new FormatException("The registration salt must contain 1 through 128 bytes.");
            byte[] payload = new byte[AccountIdentityDomain.Length + UInt160.Length + salt.Length];
            AccountIdentityDomain.CopyTo(payload, 0);
            custody.GetSpan().CopyTo(payload.AsSpan(AccountIdentityDomain.Length));
            salt.CopyTo(payload.AsSpan(AccountIdentityDomain.Length + UInt160.Length));
            // The platform Hash160 is the identity primitive; the fixed little-endian reversal is the only
            // SmartAccount step, applied in place instead of copying into a second buffer.
            byte[] digest = Crypto.Hash160(payload);
            digest.AsSpan().Reverse();
            UInt160 result = new(digest);
            RequireIdentity(result);
            return result;
        }

        internal static byte[] CreateVerificationScript(UInt160 accountId)
        {
            RequireIdentity(accountId);
            using ScriptBuilder builder = new();
            builder.EmitDynamicCall(ServiceHash, "verify", CallFlags.ReadOnly, accountId);
            return builder.ToArray();
        }

        internal static UInt160 GetAccountAddress(UInt160 accountId) =>
            CreateVerificationScript(accountId).ToScriptHash();

        // Recognizes that fixed proxy script (spec §3.6) without a reverse index: the account push is read off the
        // same header the entry script is recognized with and the rest is compared to the cached tail, so no script
        // is rebuilt per call.
        internal static bool IsProxyVerificationScript(ReadOnlySpan<byte> script)
        {
            if (script.Length != AccountPushLength + ProxyTail.Length
                || !script[..AccountPushHeader.Length].SequenceEqual(AccountPushHeader))
                return false;
            if (new UInt160(script.Slice(AccountPushHeader.Length, UInt160.Length)) == UInt160.Zero)
                return false;
            return script[AccountPushLength..].SequenceEqual(ProxyTail);
        }

        /// <summary>Recognizes the transaction entry script, the inverse of the SDK layout above: the tail and the
        /// account are compared by bytes and only the pure literal instructions before them are decoded. Returns the
        /// validated operation, or throws <see cref="FormatException"/>: the script must be exactly one
        /// <c>executeUserOp(accountId, operation)</c> call on this core. A second call, another account, entrypoint,
        /// core, flag set or syscall, any control flow, any byte before the operation literal or after the call is
        /// refused.</summary>
        internal static ValidatedOperation ValidateEntryScript(UInt160 accountId, ReadOnlyMemory<byte> script)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            RequireIdentity(accountId);
            if (script.IsEmpty || script.Length > Transaction.MaxTransactionSize)
                throw new FormatException("The entry script length is outside the transaction domain.");
            ReadOnlySpan<byte> program = script.Span;
            // The fixed call tail, then the account it names: both are matched, never decoded.
            if (program.Length < EntryTail.Length + AccountPushLength || !program.EndsWith(EntryTail))
                throw new FormatException(
                    "The entry script must end with the single executeUserOp System.Contract.Call of this core.");
            ReadOnlySpan<byte> accountPush = program[^(EntryTail.Length + AccountPushLength)..^EntryTail.Length];
            if (!accountPush[..AccountPushHeader.Length].SequenceEqual(AccountPushHeader)
                || !accountPush[AccountPushHeader.Length..].SequenceEqual(accountId.GetSpan()))
                throw new FormatException("The entry script must call executeUserOp for this account.");
            // Only what precedes the account push is data to decode: the operation literal itself. Its length is bounded
            // before anything is parsed: the literal of a legitimate operation is never larger than twice its serialized
            // size, and that size is bounded by OperationEncodedSizeMax. A longer one cannot be a legitimate operation.
            ReadOnlyMemory<byte> literal = script[..^(EntryTail.Length + AccountPushLength)];
            if (literal.Length > 2 * SmartAccountModuleProtocol.OperationEncodedSizeMax)
                throw new FormatException("The operation literal is outside the operation size bound.");
            return ValidateOperation(DecodeOperationLiteral(literal));
        }

        /// <summary>Decodes the literal instructions before the account push into the one operation Array they must
        /// build. Only pushes and the two array constructors are literal; every other opcode is refused, so no byte
        /// of the script is ever executed, jumped or called. Operands are copied: the tree never aliases the script.</summary>
        private static Array DecodeOperationLiteral(ReadOnlyMemory<byte> literal)
        {
            Script program;
            try
            {
                // Strict mode validates every operand boundary once, so a truncated push fails here instead of
                // yielding a partial value later.
                program = new Script(literal, true);
            }
            catch (BadScriptException exception)
            {
                throw new FormatException("The operation literal is not a well formed program.", exception);
            }
            List<StackItem> stack = [];
            for (int ip = 0; ip < program.Length;)
            {
                Instruction instruction = program.GetInstruction(ip);
                ip += instruction.Size;
                switch (instruction.OpCode)
                {
                    case OpCode.PUSHNULL:
                        stack.Add(StackItem.Null);
                        break;
                    case OpCode.PUSHT:
                        stack.Add(StackItem.True);
                        break;
                    case OpCode.PUSHF:
                        stack.Add(StackItem.False);
                        break;
                    // PUSHM1 sits directly below PUSH0, PUSH16 directly above PUSH1.
                    case >= OpCode.PUSHM1 and <= OpCode.PUSH16:
                        stack.Add(new Integer((int)instruction.OpCode - (int)OpCode.PUSH0));
                        break;
                    case >= OpCode.PUSHINT8 and <= OpCode.PUSHINT256:
                        stack.Add(ReadInteger(instruction));
                        break;
                    case OpCode.PUSHDATA1:
                    case OpCode.PUSHDATA2:
                    case OpCode.PUSHDATA4:
                        stack.Add(ReadData(instruction));
                        break;
                    case OpCode.NEWARRAY0:
                        stack.Add(new Array());
                        break;
                    case OpCode.PACK:
                        Pack(stack);
                        break;
                    default:
                        throw new FormatException(
                            "The entry script carries an instruction outside the operation literal.");
                }
            }
            if (stack.Count != 1 || stack[0] is not Array operation)
                throw new FormatException("The entry script must carry exactly one operation.");
            return operation;
        }

        /// <summary>One PACK: its count is the Integer literal on top and the values below it are exactly what it
        /// counts, so nothing larger than the script is ever materialized. A zero count is refused because NEWARRAY0
        /// is the only canonical empty container. PACK pops, so the stack top becomes element 0; the SDK pushes the
        /// elements in reverse for that reason.</summary>
        private static void Pack(List<StackItem> stack)
        {
            if (stack.Count < 2 || stack[^1] is not Integer count)
                throw new FormatException("The entry script container count must be an Integer literal.");
            BigInteger size = count.GetInteger();
            if (size < 1 || size >= stack.Count)
                throw new FormatException("The entry script container count is outside the pushed values.");
            var itemCount = (int)size;
            StackItem[] items = new StackItem[itemCount];
            for (int i = 0; i < itemCount; i++)
                items[i] = stack[stack.Count - 2 - i];
            stack.RemoveRange(stack.Count - 1 - itemCount, itemCount + 1);
            stack.Add(new Array(items));
        }

        /// <summary>One integer literal, accepted only in the exact width the canonical encoder emits for its value:
        /// the smallest 8/16/32/64/128/256-bit slot holding the minimal two's complement form, and never a wider
        /// spelling of a value that PUSHM1/PUSH0..PUSH16 would carry.</summary>
        private static Integer ReadInteger(Instruction instruction)
        {
            BigInteger value = new(instruction.Operand.Span, isUnsigned: false, isBigEndian: false);
            if (value >= -1 && value <= 16)
                throw new FormatException("The entry script uses a noncanonical integer literal.");
            int minimal = value.ToByteArray().Length;
            int slot = minimal switch { 1 => 1, 2 => 2, <= 4 => 4, <= 8 => 8, <= 16 => 16, _ => 32 };
            int width = instruction.OpCode switch
            {
                OpCode.PUSHINT8 => 1,
                OpCode.PUSHINT16 => 2,
                OpCode.PUSHINT32 => 4,
                OpCode.PUSHINT64 => 8,
                OpCode.PUSHINT128 => 16,
                _ => 32,
            };
            if (width != slot || instruction.Operand.Length != width)
                throw new FormatException("The entry script uses a noncanonical integer literal.");
            return new Integer(value);
        }

        /// <summary>One data literal, accepted only at its minimal PUSHDATA width so no byte can hide in a wider
        /// operand, and copied so it never aliases the transaction script. Its size is left to the operation
        /// validation, which bounds every field it can be part of.</summary>
        private static ByteString ReadData(Instruction instruction)
        {
            int length = instruction.Operand.Length;
            bool minimal = instruction.OpCode switch
            {
                OpCode.PUSHDATA1 => length <= byte.MaxValue,
                OpCode.PUSHDATA2 => length > byte.MaxValue,
                _ => length > ushort.MaxValue,
            };
            if (!minimal)
                throw new FormatException("The entry script uses a noncanonical data literal.");
            return new ByteString(instruction.Operand.ToArray());
        }

        // 2. Canonical operation and digest (spec §4.2/§4.3)
        internal static readonly byte[] UserOperationDomain =
            "NeoSmartAccount/UserOperation"u8.ToArray();

        // §4.3 digest domain, one fixed 106-byte layout:
        // UTF8("NeoSmartAccount/UserOperation")(29) ‖ U1(version) ‖ U32LE(network) ‖ coreHash(20) ‖
        // accountId(20) ‖ U64BE(validatorId) ‖ U64BE(credentialGeneration) ‖ U64BE(authorityEpoch) ‖
        // U64BE(configurationNonce). SHA-256 runs exactly once over domain ‖ canonical unsigned operation.
        private const int OperationDigestDomainSize = 106;

        internal static byte[] ComputeOperationDigest(uint network, UInt160 coreHash, UInt160 accountId,
            OperationFields fields, ReadOnlySpan<byte> canonicalUnsigned)
        {
            Span<byte> domain = stackalloc byte[OperationDigestDomainSize];
            UserOperationDomain.CopyTo(domain);
            int offset = UserOperationDomain.Length;
            domain[offset++] = Version;
            BinaryPrimitives.WriteUInt32LittleEndian(domain[offset..], network);
            offset += sizeof(uint);
            coreHash.GetSpan().CopyTo(domain[offset..]);
            offset += UInt160.Length;
            accountId.GetSpan().CopyTo(domain[offset..]);
            offset += UInt160.Length;
            WriteUInt64Be(domain[offset..], fields.ValidatorId);
            offset += sizeof(ulong);
            WriteUInt64Be(domain[offset..], fields.CredentialGeneration);
            offset += sizeof(ulong);
            WriteUInt64Be(domain[offset..], fields.AuthorityEpoch);
            offset += sizeof(ulong);
            WriteUInt64Be(domain[offset..], fields.ConfigurationNonce);
            // One SHA-256 over the two spans; the operation bytes are never copied into the domain buffer.
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(domain);
            hash.AppendData(canonicalUnsigned);
            return hash.GetHashAndReset();
        }

        // §4.2 canonical unsigned operation (field 11 blanked) is ValidatedOperation.UnsignedBytes.

        /// <summary>The authenticated routing fields of one validated operation (spec §4.1).</summary>
        internal readonly record struct OperationFields(BigInteger ValidatorId, BigInteger CredentialGeneration,
            BigInteger AuthorityEpoch, BigInteger ConfigurationNonce, BigInteger Nonce);

        /// <summary>Everything one validation pass proves about one operation (spec §4.1/§4.2): the shape-checked
        /// tree, its authenticated fields, the strictly decoded method, the signed wire bytes and the canonical
        /// unsigned bytes the digest commits to. One caller-side validation yields all of it, so no call chain
        /// re-validates or re-serialises the same operation.</summary>
        internal sealed class ValidatedOperation
        {
            internal ValidatedOperation(Array operation, OperationFields fields, string method,
                byte[] signedBytes, byte[] unsignedBytes)
            {
                Operation = operation;
                Fields = fields;
                Method = method;
                SignedBytes = signedBytes;
                UnsignedBytes = unsignedBytes;
            }

            internal Array Operation { get; }
            internal OperationFields Fields { get; }
            /// <summary>The strictly decoded UTF-8 method name, decoded once per validation.</summary>
            internal string Method { get; }
            /// <summary>The canonical 13-field wire bytes, signature included.</summary>
            internal byte[] SignedBytes { get; }
            /// <summary>The canonical 13-field bytes with field 11 blanked (§4.2).</summary>
            internal byte[] UnsignedBytes { get; }

            internal ReadOnlySpan<byte> NonceSubkey =>
                Operation[SmartAccountModuleProtocol.OpNonceSubkey].GetSpan();

            internal BigInteger Deadline => Operation[SmartAccountModuleProtocol.OpDeadline].GetInteger();

            internal byte[] ComputeDigest(uint network, UInt160 coreHash, UInt160 accountId) =>
                SmartAccountProtocol.ComputeOperationDigest(network, coreHash, accountId, Fields, UnsignedBytes);
        }

        // Strict 13-field v4 envelope validation (§4.1): exact Array shape, no
        // Struct, every field in domain, hook proofs unique and ascending. The
        // signed and canonical unsigned serializations are produced here, once.
        internal static ValidatedOperation ValidateOperation(StackItem operation)
        {
            ArgumentNullException.ThrowIfNull(operation);
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
            string methodName;
            try
            {
                // Utility.StrictUTF8 decodes once; the dispatcher reuses this string verbatim.
                methodName = Utility.StrictUTF8.GetString(method.GetSpan());
            }
            catch (DecoderFallbackException exception)
            {
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed, exception);
            }
            if (op[SmartAccountModuleProtocol.OpArgs].Type != StackItemType.Array
                || op[SmartAccountModuleProtocol.OpArgs] is not Array args
                || args.Count > SmartAccountModuleProtocol.ArgsCountMax)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            ValidateArgument(args, 0);
            // The wire size is the core serializer's own measure, bounded at the profile size:
            // VarInt widths, item count and canonical encoding are never recomputed here. The same
            // serializer bound also rejects aliased containers, so no separate seen set is needed.
            RequireOperationEncoding(args, SmartAccountModuleProtocol.ArgsSerializedSizeMax,
                SmartAccountModuleProtocol.ArgsSerializedItemsMax);
            // [4] nonce — 191-bit channel ‖ 64-bit sequence, non-negative < 2^255 (§4.1). The channel is derived,
            // never chosen (§6), so the field is a packed 255-bit value, not a plain 64-bit sequence.
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
            // Field 12 is module-defined and core-carried (§4.2 R-04-03): the core checks the shape only and never
            // interprets a proof, so the field stays digest-covered and a routing module reads it verbatim.
            ValidateHookProofs(op[SmartAccountModuleProtocol.OpHookProofs]);
            Array canonical = new();
            for (int i = 0; i < SmartAccountModuleProtocol.UserOperationFieldCount; i++)
                canonical.Add(i == SmartAccountModuleProtocol.OpSignature ? ByteString.Empty : op[i]);
            byte[] unsignedBytes = RequireOperationEncoding(canonical,
                SmartAccountModuleProtocol.OperationEncodedSizeMax,
                SmartAccountModuleProtocol.OperationEncodedItemsMax);
            byte[] signedBytes = RequireOperationEncoding(op, SmartAccountModuleProtocol.OperationEncodedSizeMax,
                SmartAccountModuleProtocol.OperationEncodedItemsMax);
            OperationFields fields = new(
                op[SmartAccountModuleProtocol.OpValidatorId].GetInteger(),
                op[SmartAccountModuleProtocol.OpCredentialGeneration].GetInteger(),
                op[SmartAccountModuleProtocol.OpAuthorityEpoch].GetInteger(),
                op[SmartAccountModuleProtocol.OpConfigurationNonce].GetInteger(),
                op[SmartAccountModuleProtocol.OpNonce].GetInteger());
            return new ValidatedOperation(op, fields, methodName, signedBytes, unsignedBytes);
        }

        /// <summary>The canonical NeoVM serialization of an item, inside the given byte and item bounds, or
        /// <see cref="FormatException"/> with the operation error code.</summary>
        internal static byte[] RequireOperationEncoding(StackItem item, int maxBytes, int maxItems)
        {
            try
            {
                return BinarySerializer.Serialize(item, (uint)maxItems, maxBytes);
            }
            catch (Exception exception) when (exception is FormatException or InvalidOperationException
                or NotSupportedException)
            {
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed, exception);
            }
        }

        // Shape of hookProofs (§4.2 R-04-03): 0-8 entries, each [ascending UInt64 hookId, ByteString proof], 4096
        // bytes total. The meaning of a proof belongs to the routing module, so the core never reads it.
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

        // Bounds nested argument arrays (§4.1): Null/Boolean/Integer/ByteString/
        // Array only and depth ≤ 8. Cycles stop at the depth bound and aliased
        // containers are rejected by the bounded serializer above, so this walk
        // only carries the type whitelist and the depth profile.
        private static void ValidateArgument(StackItem item, int depth)
        {
            switch (item)
            {
                case Null:
                case Boolean:
                case Integer:
                case ByteString:
                    return;
                case Array array:
                    // A Struct inherits Array, so the exact item type is still required here.
                    if (item.Type != StackItemType.Array || depth >= SmartAccountModuleProtocol.ArgsDepthMax)
                        throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
                    foreach (StackItem child in array)
                        ValidateArgument(child, depth + 1);
                    return;
                default:
                    throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            }
        }

        // 3. Derived nonce namespace and 191-bit channel (spec §6)
        internal static readonly BigInteger UInt64Mask = (BigInteger.One << 64) - 1;
        /// <summary>The 191-bit channel mask: a packed nonce keeps the channel in bits 64..254.</summary>
        internal static readonly BigInteger ChannelMask = (BigInteger.One << 191) - 1;
        /// <summary>The exclusive upper bound of a packed nonce and of a deadline.</summary>
        internal static readonly BigInteger MaxNonce = BigInteger.One << 255;

        // Full 256-bit nonce-namespace derivation (§6), persisted under 0x5C so a channel truncation collision fails
        // closed. One fixed 97-byte layout: U1 ‖ coreHash ‖ accountId ‖ 3 × U64BE ‖ nonceSubkey(32), one SHA-256.
        private const int NonceNamespaceDomainSize = 97;

        internal static byte[] ComputeNonceNamespaceDigest(UInt160 accountId, UInt160 coreHash,
            BigInteger authorityEpoch, BigInteger validatorId, BigInteger credentialGeneration,
            ReadOnlySpan<byte> nonceSubkey)
        {
            Span<byte> domain = stackalloc byte[NonceNamespaceDomainSize];
            int offset = 0;
            domain[offset++] = Version;
            coreHash.GetSpan().CopyTo(domain[offset..]);
            offset += UInt160.Length;
            accountId.GetSpan().CopyTo(domain[offset..]);
            offset += UInt160.Length;
            WriteUInt64Be(domain[offset..], authorityEpoch);
            offset += sizeof(ulong);
            WriteUInt64Be(domain[offset..], validatorId);
            offset += sizeof(ulong);
            WriteUInt64Be(domain[offset..], credentialGeneration);
            offset += sizeof(ulong);
            nonceSubkey.CopyTo(domain[offset..]);
            return domain.Sha256();
        }

        // 191-bit channel (24 bytes, top bit zero): digest bytes 8..31 with the
        // MSB of byte 8 cleared (§6, figure 13). Signers never choose a channel.
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

        /// <summary>The single 24-byte channel encoder; the top bit of byte 0 stays clear (§6).</summary>
        internal static byte[] EncodeChannel(BigInteger channel)
        {
            if (channel < 0 || (channel >> 191) != BigInteger.Zero)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorNonceChannelCollision);
            byte[] encoded = new byte[SmartAccountModuleProtocol.NonceChannelSize];
            // Fixed-width big-endian through the platform writer, right-aligned in the 24-byte window.
            if (!channel.TryWriteBytes(encoded.AsSpan(), out int written, isUnsigned: true, isBigEndian: true))
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorNonceChannelCollision);
            if (written < encoded.Length)
            {
                Span<byte> window = encoded;
                window[..written].CopyTo(window[(window.Length - written)..]);
                window[..(window.Length - written)].Clear();
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

        // 4. Encoding helpers shared by the record codecs
        /// <summary>The single unsigned-64 conversion: every UInt64 field is range-checked here before any layout.</summary>
        internal static ulong UInt64(BigInteger value)
        {
            if (!IsUInt64(value))
                throw new FormatException("The integer must be an unsigned 64-bit Integer.");
            return (ulong)value;
        }

        private static bool IsUInt64(BigInteger value) => value >= 0 && (value >> 64) == BigInteger.Zero;

        /// <summary>Thin fixed-width big-endian write of one UInt64 field into a caller-owned span.</summary>
        internal static void WriteUInt64Be(Span<byte> destination, BigInteger value) =>
            BinaryPrimitives.WriteUInt64BigEndian(destination, UInt64(value));

        // [8] credentialGeneration is an unsigned 64-bit Integer ≥ 1 (spec §7.3): revision zero names no live credential.
        private static void RequireCredentialGeneration(StackItem item)
        {
            RequireUnsigned64(item);
            if (item.GetInteger() < 1)
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
        }

        private static void RequireUnsigned64(StackItem item)
        {
            if (item is not Integer value || !IsUInt64(value.GetInteger()))
                throw new FormatException(SmartAccountModuleProtocol.ErrorOperationMalformed);
        }

        internal static void RequireIdentity(UInt160 identity)
        {
            if (identity is null || identity == UInt160.Zero)
                throw new FormatException("A zero account or custody identity is not permitted.");
        }
    }
}
