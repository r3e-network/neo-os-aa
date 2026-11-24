using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Read accessors for the canonical 13-field protocol v4 operation the core
    /// hands to every execution callback (docs/SA-MODULE-PROTOCOL.md §4.1). The
    /// core has already validated the envelope; modules only re-check the field
    /// count so a foreign caller cannot smuggle a different shape.
    /// </summary>
    internal static class ModuleOperation
    {
        internal const int FieldCount = 13;
        internal const int FieldTarget = 1;
        internal const int FieldMethod = 2;
        internal const int FieldArgs = 3;
        internal const int FieldNonce = 4;
        internal const int FieldDeadline = 6;
        internal const int FieldValidatorId = 7;
        internal const int FieldCredentialGeneration = 8;
        internal const int FieldSignature = 11;
        internal const int FieldHookProofs = 12;

        internal static void RequireShape(object[] operation)
        {
            ExecutionEngine.Assert(operation != null && operation!.Length == FieldCount, "Invalid operation shape");
        }

        internal static UInt160 Target(object[] operation) => (UInt160)operation[FieldTarget];

        internal static string Method(object[] operation) => (string)operation[FieldMethod];

        internal static object[] Args(object[] operation) => (object[])operation[FieldArgs];

        internal static BigInteger Deadline(object[] operation) => (BigInteger)operation[FieldDeadline];

        internal static BigInteger ValidatorId(object[] operation) => (BigInteger)operation[FieldValidatorId];

        internal static ByteString Signature(object[] operation) => (ByteString)operation[FieldSignature];

        /// <summary>
        /// The signature bytes addressed to one validator instance. On a
        /// standalone route (<c>validatorId == moduleId</c>) that is the whole
        /// signature field. On a threshold route the field is the serialized
        /// member list <c>[[memberModuleId, memberSignature], ...]</c>, strictly
        /// ascending by member id (spec §5); the member picks its own entry.
        /// Returns an empty ByteString when no entry is addressed to it.
        /// </summary>
        internal static ByteString MemberSignature(object[] operation, BigInteger moduleId)
        {
            ByteString signature = Signature(operation);
            if (ValidatorId(operation) == moduleId) return signature;

            object[] entries = (object[])StdLib.Deserialize(signature);
            ExecutionEngine.Assert(entries.Length >= 1 && entries.Length <= 10, "Invalid member signature list");
            ByteString found = (ByteString)new byte[0];
            BigInteger previous = BigInteger.Zero;
            for (int i = 0; i < entries.Length; i++)
            {
                object[] entry = (object[])entries[i];
                ExecutionEngine.Assert(entry.Length == 2, "Invalid member signature entry");
                BigInteger memberId = (BigInteger)entry[0];
                ExecutionEngine.Assert(memberId > previous, "Member signatures not strictly ascending");
                previous = memberId;
                if (memberId == moduleId) found = (ByteString)entry[1];
            }
            return found;
        }

        /// <summary>
        /// The proof a signer attached for one hook instance, or an empty
        /// ByteString. The core already checked the proof list against the
        /// hook-order snapshot.
        /// </summary>
        internal static ByteString HookProof(object[] operation, BigInteger hookId)
        {
            object[] proofs = (object[])operation[FieldHookProofs];
            for (int i = 0; i < proofs.Length; i++)
            {
                object[] pair = (object[])proofs[i];
                if ((BigInteger)pair[0] == hookId) return (ByteString)pair[1];
            }
            return (ByteString)new byte[0];
        }
    }

    /// <summary>Writer phases recorded by the core (spec §10).</summary>
    internal static class ModulePhase
    {
        internal const byte Validation = 1;
        internal const byte HookPre = 2;
        internal const byte HookPost = 4;
        internal const byte Completion = 5;
        internal const byte Configuration = 6;
    }

    /// <summary>
    /// Core authentication and per-instance storage keys shared by validators
    /// and hooks. A module never trusts a caller-declared instance: it asks
    /// the core which of its instances the current writer phase addresses.
    /// </summary>
    internal static class ModuleContext
    {
        internal static void RequireCoreCaller(UInt160 core)
        {
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "SA core not configured");
            ExecutionEngine.Assert(Runtime.CallingScriptHash == core, "Unauthorized caller");
        }

        private static BigInteger AuthorizedId(UInt160 core, UInt160 accountId, byte phase)
        {
            RequireCoreCaller(core);
            return (BigInteger)Contract.Call(core, "getAuthorizedModuleId", CallFlags.ReadOnly,
                new object[] { accountId, phase });
        }

        /// <summary>The instance of this contract the core addresses in <paramref name="phase"/>.</summary>
        internal static BigInteger RequireInstance(UInt160 core, UInt160 accountId, byte phase)
        {
            BigInteger moduleId = AuthorizedId(core, accountId, phase);
            ExecutionEngine.Assert(moduleId > 0, "Unauthorized");
            return moduleId;
        }

        /// <summary>Lifecycle callbacks carry the instance id; it must be the authorized one.</summary>
        internal static void RequireLifecycle(UInt160 core, UInt160 accountId, BigInteger moduleId)
        {
            ExecutionEngine.Assert(RequireInstance(core, accountId, ModulePhase.Configuration) == moduleId,
                "Module instance mismatch");
        }

        /// <summary>
        /// Instance for <c>validateUserOp</c>. During execution the core records
        /// the validation phase and this returns the authorized instance (the
        /// module itself, or a threshold member). The read-only preview records
        /// no phase; it only ever calls the instance named by
        /// <c>operation[validatorId]</c>, so that id is used. Either way the
        /// caller must be the trusted core.
        /// </summary>
        internal static BigInteger ResolveValidationInstance(UInt160 core, UInt160 accountId, object[] operation)
        {
            BigInteger moduleId = AuthorizedId(core, accountId, ModulePhase.Validation);
            if (moduleId > 0) return moduleId;
            moduleId = ModuleOperation.ValidatorId(operation);
            ExecutionEngine.Assert(moduleId > 0, "Unauthorized");
            return moduleId;
        }

        /// <summary>prefix ‖ accountId (20) ‖ moduleId (8 bytes, big-endian).</summary>
        internal static byte[] InstanceKey(byte[] prefix, UInt160 accountId, BigInteger moduleId)
        {
            return Helper.Concat(Helper.Concat(prefix, (byte[])accountId), U64BE(moduleId));
        }

        internal static byte[] U64BE(BigInteger value)
        {
            ExecutionEngine.Assert(value >= 0 && value < (BigInteger.One << 64), "Invalid uint64");
            byte[] encoded = new byte[8];
            for (int i = 7; i >= 0; i--)
            {
                encoded[i] = (byte)(value & 255);
                value >>= 8;
            }
            return encoded;
        }

        /// <summary>Deletes every key under one instance-scoped prefix.</summary>
        internal static void DeleteInstancePrefix(byte[] prefix, UInt160 accountId, BigInteger moduleId)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext, InstanceKey(prefix, accountId, moduleId),
                FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }
    }

    /// <summary>
    /// Reads a named configuration command: <c>[command, ...args]</c>.
    /// Configurable modules may also accept one command as install data.
    /// Ordinary removal of an enabled named module uses an empty array.
    /// </summary>
    internal static class ModuleConfig
    {
        internal static string Command(object[] data, int argumentCount)
        {
            ExecutionEngine.Assert(data != null && data.Length == argumentCount + 1, "Invalid config arguments");
            return (string)data![0];
        }

        internal static string Name(object[] data)
        {
            ExecutionEngine.Assert(data != null && data.Length >= 1, "Missing config command");
            return (string)data![0];
        }

        internal static void RequireArgs(object[] data, int argumentCount)
        {
            ExecutionEngine.Assert(data.Length == argumentCount + 1, "Invalid config arguments");
        }
    }
}
