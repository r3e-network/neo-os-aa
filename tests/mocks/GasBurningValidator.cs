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
    /// Test-only protocol-v4 validator with the canonical callback surface that approves every
    /// operation and, when enabled, burns a known amount of gas inside <c>validateUserOp</c>.
    /// </summary>
    /// <remarks>
    /// The core charges validator callbacks against <c>ValidationPerCallGasLimit</c>
    /// (100_000_000 datoshi), a budget separate from the hook pool. Burning 150_000_000 proves the
    /// validation envelope fails closed on its own accounting instead of leaning on the hook
    /// meter. The validator is a rubber stamp by design: its only job is to spend gas.
    /// </remarks>
    /// <remarks>
    /// nccs compiles every source file under <c>tests/mocks</c> as its own contract, so a mock may
    /// not link the plugin helper sources (<c>ValidatorAuthority</c>, <c>ModuleContext</c>, ...).
    /// This file is therefore self-contained: the authority and instance-key helpers at the bottom
    /// are the same checks as <c>contracts/plugins/validators/ValidatorAuthority.cs</c>, inlined.
    /// </remarks>
    [DisplayName("GasBurningValidator")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only v4 validator that overruns its callback gas budget")]
    public class GasBurningValidator : SmartContract
    {
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":true,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"GasBurningValidator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        /// <summary>Strictly above the per-callback validation cap of 100_000_000 datoshi.</summary>
        private const long OverrunGas = 150_000_000;

        // Contract-global authority rows; the instance key below starts at 0xF1 and never collides.
        private static readonly byte[] Prefix_Admin = new byte[] { 0x01 };
        private static readonly byte[] Prefix_AuthorizedCore = new byte[] { 0x02 };

        // Writer phases recorded by the core (docs/SA-MODULE-PROTOCOL.md §10).
        private const byte PhaseValidation = 1;
        private const byte PhaseCompletion = 5;
        private const byte PhaseConfiguration = 6;
        // Canonical 13-field operation; field 7 carries the routed validator instance (§4.1).
        private const int OperationFieldCount = 13;
        private const int OperationFieldValidatorId = 7;

        private static readonly byte[] Prefix_Burn = new byte[] { 0xF1 };

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

        /// <summary><c>initData</c>/<c>configData</c>: <c>["setBurn", enabled]</c>.</summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyBurnFlag(accountId, moduleId, initData);
        }

        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            RequireLifecycle(accountId, moduleId);
            ApplyBurnFlag(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            RequireLifecycle(accountId, moduleId);
            Storage.Delete(Storage.CurrentContext, Key(accountId, moduleId));
        }

        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = RequireValidation(accountId, operation);
            if (Storage.Get(Storage.CurrentContext, Key(accountId, moduleId)) != null) Runtime.BurnGas(OverrunGas);
            return true;
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            RequireCompletion(accountId, operation);
        }

        private static byte[] Key(UInt160 accountId, BigInteger moduleId) =>
            InstanceKey(Prefix_Burn, accountId, moduleId);

        private static void ApplyBurnFlag(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(data != null && data.Length == 2, "Invalid burn command");
            ExecutionEngine.Assert((string)data[0] == "setBurn", "Unknown burn command");
            ExecutionEngine.Assert(data[1] is bool, "Invalid burn flag");
            byte[] key = Key(accountId, moduleId);
            if (!(bool)data[1])
            {
                Storage.Delete(Storage.CurrentContext, key);
                return;
            }
            Storage.Put(Storage.CurrentContext, key, (BigInteger)1);
        }

        // ---- Inlined authority surface (parity with contracts/plugins/validators/ValidatorAuthority.cs) ----
        // A mock cannot link the plugin helper sources, so the checks the canonical modules make are
        // reproduced here: the caller must be the trusted core, and the instance is the one the core
        // says it is validating / completing (<c>getAuthorizedModuleId</c>, spec §10).

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

        /// <summary>
        /// validateUserOp: during execution the core records the validation phase; the read-only
        /// preview records none and only ever calls the instance named by field 7.
        /// </summary>
        private static BigInteger RequireValidation(UInt160 accountId, object[] operation)
        {
            ExecutionEngine.Assert(operation != null && operation.Length == OperationFieldCount,
                "Invalid operation shape");
            BigInteger moduleId = AuthorizedId(accountId, PhaseValidation);
            if (moduleId > 0) return moduleId;
            moduleId = (BigInteger)operation[OperationFieldValidatorId];
            ExecutionEngine.Assert(moduleId > 0, "Unauthorized");
            return moduleId;
        }

        /// <summary>onUserOpComplete: completion phase, only the authorized instance.</summary>
        private static void RequireCompletion(UInt160 accountId, object[] operation)
        {
            ExecutionEngine.Assert(operation != null && operation.Length == OperationFieldCount,
                "Invalid operation shape");
            ExecutionEngine.Assert(AuthorizedId(accountId, PhaseCompletion) > 0, "Unauthorized");
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
    }
}
