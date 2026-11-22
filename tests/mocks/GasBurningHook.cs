using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Test-only protocol-v4 hook with the canonical callback surface that burns a known amount of
    /// gas inside <c>preCheck</c> and/or <c>postCheck</c>.
    /// </summary>
    /// <remarks>
    /// The core charges every module callback against a per-call budget measured as a GasLeft
    /// delta (<c>HookCallbackGasLimit</c> = 250_000_000 datoshi). Burning 300_000_000 therefore
    /// exercises the fail-closed budget check rather than a business rule, which is the only way
    /// to prove the envelope is bounded without shipping a runaway module.
    /// </remarks>
    /// <remarks>
    /// nccs compiles every source file under <c>tests/mocks</c> as its own contract, so a mock may
    /// not link the plugin helper sources (<c>HookAuthority</c>, <c>ModuleContext</c>, ...). This
    /// file is therefore self-contained: the authority and instance-key helpers at the bottom are
    /// the same checks as <c>contracts/plugins/hooks/HookAuthority.cs</c>, inlined.
    /// </remarks>
    [DisplayName("GasBurningHook")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only v4 hook that overruns its callback gas budget")]
    public class GasBurningHook : SmartContract
    {
        private const string ModuleProfileJson = "{\"callbacks\":[\"preCheck\",\"postCheck\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":true,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"GasBurningHook\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"hook\",\"profileVersion\":1}";

        /// <summary>Strictly above the per-callback hook cap of 250_000_000 datoshi.</summary>
        private const long OverrunGas = 300_000_000;

        // Contract-global authority rows; the instance keys below start at 0xF1 and never collide.
        private static readonly byte[] Prefix_Admin = new byte[] { 0x01 };
        private static readonly byte[] Prefix_AuthorizedCore = new byte[] { 0x02 };

        // Writer phases recorded by the core (docs/SA-MODULE-PROTOCOL.md §10).
        private const byte PhaseHookPre = 2;
        private const byte PhaseHookPost = 4;
        private const byte PhaseConfiguration = 6;
        // Canonical 13-field operation (docs/SA-MODULE-PROTOCOL.md §4.1).
        private const int OperationFieldCount = 13;

        private static readonly byte[] Prefix_BurnPre = new byte[] { 0xF1 };
        private static readonly byte[] Prefix_BurnPost = new byte[] { 0xF2 };
        // Optional expiry of the armed burn: burning only applies while Runtime.Time <= expiry.
        private static readonly byte[] Prefix_BurnUntil = new byte[] { 0xF5 };
        // Callback log shared by every instance on one account (moduleId 0), so a suite can
        // observe the core's forward preCheck / reverse postCheck order directly.
        private static readonly byte[] Prefix_LogCount = new byte[] { 0xF3 };
        private static readonly byte[] Prefix_Log = new byte[] { 0xF4 };

        /// <summary>Deploy data is the trusted core's script hash, exactly like a plugin module.</summary>
        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, Prefix_Admin, Runtime.Transaction.Sender);
            if (data is byte[] rawCore && rawCore.Length == 20)
            {
                Storage.Put(Storage.CurrentContext, Prefix_AuthorizedCore, rawCore);
                return;
            }
            if (data is ByteString rawCoreByteString && rawCoreByteString.Length == 20)
            {
                Storage.Put(Storage.CurrentContext, Prefix_AuthorizedCore, (byte[])rawCoreByteString);
            }
        }

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        /// <summary><c>initData</c>/<c>configData</c>: <c>["setBurn", pre, post]</c>.</summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyBurnCommand(accountId, moduleId, initData);
        }

        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            RequireLifecycle(accountId, moduleId);
            ApplyBurnCommand(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            RequireLifecycle(accountId, moduleId);
            DeleteInstancePrefix(Prefix_BurnPre, accountId, moduleId);
            DeleteInstancePrefix(Prefix_BurnPost, accountId, moduleId);
            DeleteInstancePrefix(Prefix_BurnUntil, accountId, moduleId);
        }

        public static ByteString PreCheck(UInt160 accountId, object[] operation)
        {
            BigInteger moduleId = RequireHookCheck(accountId, operation, PhaseHookPre);
            AppendLog(accountId, moduleId, PhaseHookPre);
            if (Burns(Prefix_BurnPre, accountId, moduleId)) Runtime.BurnGas(OverrunGas);
            return (ByteString)new byte[0];
        }

        public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
        {
            BigInteger moduleId = RequireHookCheck(accountId, operation, PhaseHookPost);
            AppendLog(accountId, moduleId, PhaseHookPost);
            if (Burns(Prefix_BurnPost, accountId, moduleId)) Runtime.BurnGas(OverrunGas);
        }

        /// <summary>
        /// Callback order observed on one account: <c>[[moduleId, phase], ...]</c> in call order,
        /// where phase 2 is <c>preCheck</c> and 4 is <c>postCheck</c>.
        /// </summary>
        [Safe]
        public static object[] GetCallbackLog(UInt160 accountId)
        {
            BigInteger count = LogCount(accountId);
            object[] entries = new object[(int)count];
            for (int i = 0; i < (int)count; i++)
            {
                ByteString? entry = Storage.Get(Storage.CurrentContext, LogKey(accountId, i + 1));
                entries[i] = entry == null ? (object)new object[0] : (object[])StdLib.Deserialize(entry!);
            }
            return entries;
        }

        /// <summary>
        /// <c>["setBurn", pre, post]</c> arms the burn for good; <c>["setBurnUntil", pre, post, expiryMs]</c>
        /// arms it only until <c>expiryMs</c>. The bounded form lets a suite disarm a budget fault by
        /// letting time pass instead of committing a 24 h configuration intent, which would also roll
        /// a fixed-window daily limit over.
        /// </summary>
        private static void ApplyBurnCommand(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(data != null && data.Length >= 3, "Invalid burn command");
            string command = (string)data[0];
            ExecutionEngine.Assert(command == "setBurn" || command == "setBurnUntil", "Unknown burn command");
            ExecutionEngine.Assert(data[1] is bool && data[2] is bool, "Invalid burn flags");
            // Instance-scoped flags keep two instances of this module independent.
            SetFlag(Prefix_BurnPre, accountId, moduleId, (bool)data[1]);
            SetFlag(Prefix_BurnPost, accountId, moduleId, (bool)data[2]);
            byte[] untilKey = InstanceKey(Prefix_BurnUntil, accountId, moduleId);
            if (command == "setBurnUntil")
            {
                ExecutionEngine.Assert(data.Length == 4 && data[3] is BigInteger, "Invalid burn expiry");
                Storage.Put(Storage.CurrentContext, untilKey, (BigInteger)data[3]);
                return;
            }
            ExecutionEngine.Assert(data.Length == 3, "Invalid burn command");
            Storage.Delete(Storage.CurrentContext, untilKey);
        }

        private static void SetFlag(byte[] prefix, UInt160 accountId, BigInteger moduleId, bool enabled)
        {
            byte[] key = InstanceKey(prefix, accountId, moduleId);
            if (!enabled)
            {
                Storage.Delete(Storage.CurrentContext, key);
                return;
            }
            Storage.Put(Storage.CurrentContext, key, (BigInteger)1);
        }

        private static bool IsSet(byte[] prefix, UInt160 accountId, BigInteger moduleId) =>
            Storage.Get(Storage.CurrentContext, InstanceKey(prefix, accountId, moduleId)) != null;

        /// <summary>True while the callback on <paramref name="prefix"/> is armed and not expired.</summary>
        private static bool Burns(byte[] prefix, UInt160 accountId, BigInteger moduleId)
        {
            if (!IsSet(prefix, accountId, moduleId)) return false;
            ByteString? untilData = Storage.Get(Storage.CurrentContext,
                InstanceKey(Prefix_BurnUntil, accountId, moduleId));
            // No stored expiry (the plain "setBurn" form) arms the burn for good.
            BigInteger until = untilData == null ? 0 : (BigInteger)untilData;
            return until <= 0 || Runtime.Time <= until;
        }

        private static BigInteger LogCount(UInt160 accountId)
        {
            ByteString? value = Storage.Get(Storage.CurrentContext,
                InstanceKey(Prefix_LogCount, accountId, BigInteger.Zero));
            return value == null ? 0 : (BigInteger)value;
        }

        // The counter serialization is self-delimiting, so no two entries can collide.
        private static byte[] LogKey(UInt160 accountId, BigInteger index) =>
            Helper.Concat(InstanceKey(Prefix_Log, accountId, BigInteger.Zero),
                (byte[])StdLib.Serialize(index));

        private static void AppendLog(UInt160 accountId, BigInteger moduleId, BigInteger phase)
        {
            BigInteger index = LogCount(accountId) + 1;
            Storage.Put(Storage.CurrentContext,
                InstanceKey(Prefix_LogCount, accountId, BigInteger.Zero), index);
            Storage.Put(Storage.CurrentContext, LogKey(accountId, index),
                StdLib.Serialize(new object[] { moduleId, phase }));
        }

        // ---- Inlined authority surface (parity with contracts/plugins/hooks/HookAuthority.cs) ----
        // A mock cannot link the plugin helper sources, so the checks the canonical modules make are
        // reproduced here: the caller must be the trusted core, and the instance is the one the core
        // says it is addressing in this writer phase (<c>getAuthorizedModuleId</c>, spec §10).

        private static UInt160 AuthorizedCore()
        {
            ByteString? stored = Storage.Get(Storage.CurrentContext, Prefix_AuthorizedCore);
            return stored == null ? UInt160.Zero : (UInt160)stored;
        }

        private static UInt160 RequireCore()
        {
            UInt160 core = AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "SA core not configured");
            ExecutionEngine.Assert(Runtime.CallingScriptHash == core, "Unauthorized caller");
            return core;
        }

        private static BigInteger AuthorizedId(UInt160 accountId, byte phase)
        {
            return (BigInteger)Contract.Call(RequireCore(), "getAuthorizedModuleId", CallFlags.ReadOnly,
                new object[] { accountId, phase });
        }

        /// <summary>onInstall / onUninstall / configure: configuration phase, exact instance.</summary>
        private static void RequireLifecycle(UInt160 accountId, BigInteger moduleId)
        {
            BigInteger active = AuthorizedId(accountId, PhaseConfiguration);
            ExecutionEngine.Assert(active > 0, "Unauthorized");
            ExecutionEngine.Assert(active == moduleId, "Module instance mismatch");
        }

        /// <summary>preCheck / postCheck: the instance the core is running, or fail closed.</summary>
        private static BigInteger RequireHookCheck(UInt160 accountId, object[] operation, byte phase)
        {
            ExecutionEngine.Assert(operation != null && operation.Length == OperationFieldCount,
                "Invalid operation shape");
            BigInteger moduleId = AuthorizedId(accountId, phase);
            ExecutionEngine.Assert(moduleId > 0, "Unauthorized");
            return moduleId;
        }

        /// <summary>prefix ‖ accountId (20) ‖ moduleId (8 bytes, big-endian) — spec §10.</summary>
        private static byte[] InstanceKey(byte[] prefix, UInt160 accountId, BigInteger moduleId)
        {
            return Helper.Concat(Helper.Concat(prefix, (byte[])accountId), U64BE(moduleId));
        }

        private static byte[] U64BE(BigInteger value)
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

        private static void DeleteInstancePrefix(byte[] prefix, UInt160 accountId, BigInteger moduleId)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext, InstanceKey(prefix, accountId, moduleId),
                FindOptions.KeysOnly);
            while (iterator.Next()) Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
        }
    }
}
