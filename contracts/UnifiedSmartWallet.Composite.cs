using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        private static readonly byte[] Prefix_VerifierDependencies = new byte[] { 0x22 };
        private static readonly byte[] Prefix_HookDependencies = new byte[] { 0x23 };
        private static readonly byte[] Prefix_DependencyMaintenance = new byte[] { 0x24 };

        public static void SetVerifierDependencies(UInt160 accountId, UInt160[] children) =>
            SetDependencies(accountId, children, true);

        public static void ClearVerifierDependencies(UInt160 accountId) =>
            ClearDependencies(accountId, true);

        public static void SetHookDependencies(UInt160 accountId, UInt160[] children) =>
            SetDependencies(accountId, children, false);

        public static void ClearHookDependencies(UInt160 accountId) =>
            ClearDependencies(accountId, false);

        private static byte[] DependencyKey(UInt160 accountId, bool verifier) =>
            verifier
                ? Helper.Concat(Prefix_VerifierDependencies, (byte[])accountId)
                : Helper.Concat(Prefix_HookDependencies, (byte[])accountId);

        private static void SetDependencies(UInt160 accountId, UInt160[] children, bool verifier)
        {
            UInt160 root = ValidateDependencyCall(accountId, verifier, false);
            ValidateDependencyChildren(children, root, verifier);
            byte[] lockKey = Helper.Concat(Prefix_DependencyMaintenance, (byte[])accountId);
            AcquireDependencyMaintenance(lockKey, accountId);
            try
            {
                byte[] key = DependencyKey(accountId, verifier);
                ByteString? data = Storage.Get(Storage.CurrentContext, key);
                if (data != null)
                {
                    UInt160[] previous = (UInt160[])StdLib.Deserialize(data!);
                    for (int i = 0; i < previous.Length; i++)
                    {
                        bool retained = false;
                        for (int j = 0; j < children.Length; j++)
                        {
                            if (previous[i] == children[j])
                            {
                                retained = true;
                                break;
                            }
                        }
                        if (!retained) CleanupDependency(accountId, previous[i], verifier);
                    }
                }
                Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(children));
            }
            finally
            {
                Storage.Delete(Storage.CurrentContext, lockKey);
            }
        }

        private static void ClearDependencies(UInt160 accountId, bool verifier)
        {
            UInt160 root = ValidateDependencyCall(accountId, verifier, true);
            byte[] lockKey = Helper.Concat(Prefix_DependencyMaintenance, (byte[])accountId);
            AcquireDependencyMaintenance(lockKey, accountId);
            try
            {
                UInt160[] children = ReadDependencyChildren(accountId, root, verifier);
                ValidateDependencyChildren(children, root, verifier);
                for (int i = 0; i < children.Length; i++) CleanupDependency(accountId, children[i], verifier);
                Storage.Delete(Storage.CurrentContext, DependencyKey(accountId, verifier));
            }
            finally
            {
                Storage.Delete(Storage.CurrentContext, lockKey);
            }
        }

        private static void EnsureLegacyDependencies(UInt160 accountId, UInt160 root, bool verifier)
        {
            byte[] key = DependencyKey(accountId, verifier);
            if (Storage.Get(Storage.CurrentContext, key) != null) return;
            byte[] lockKey = Helper.Concat(Prefix_DependencyMaintenance, (byte[])accountId);
            AcquireDependencyMaintenance(lockKey, accountId);
            try
            {
                UInt160[] children = ReadDependencyChildren(accountId, root, verifier);
                if (children.Length == 0) return;
                ValidateDependencyChildren(children, root, verifier);
                Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(children));
            }
            finally
            {
                Storage.Delete(Storage.CurrentContext, lockKey);
            }
        }

        private static UInt160[] ReadDependencyChildren(UInt160 accountId, UInt160 root, bool verifier)
        {
            byte[] key = DependencyKey(accountId, verifier);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data != null) return (UInt160[])StdLib.Deserialize(data!)!;

            string method = verifier ? "getChildVerifierConfig" : "getChildHookConfig";
            ContractParameterType result = verifier ? ContractParameterType.Any : ContractParameterType.Array;
            if (!ModuleExposesSafeMethod(root, method, result, ContractParameterType.Hash160)) return new UInt160[0];
            if (verifier)
            {
                VerifierChildConfiguration config = (VerifierChildConfiguration)CallModuleWithMaintenanceBudget(
                    root, method, CallFlags.ReadOnly, new object[] { accountId });
                if (config == null || config.Verifiers == null) return new UInt160[0];
                return config.Verifiers!;
            }
            object[] raw = (object[])CallModuleWithMaintenanceBudget(
                root, method, CallFlags.ReadOnly, new object[] { accountId })!;
            UInt160[] children = new UInt160[raw!.Length];
            for (int i = 0; i < raw.Length; i++) children[i] = (UInt160)raw[i]!;
            return children;
        }

        private static UInt160 ValidateDependencyCall(UInt160 accountId, bool verifier, bool clearing)
        {
            ValidateAccountId(accountId);
            ExecutionEngine.Assert(!IsExecutionActive(accountId)
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_VerifyContext, (byte[])accountId)) == null,
                "Cannot maintain dependencies during execution");
            AccountState state = GetAccountState(accountId);
            UInt160 root = (verifier ? state.Verifier : state.HookId)!;
            ExecutionEngine.Assert(root != null && root != UInt160.Zero && Runtime.CallingScriptHash == root,
                "Dependency caller is not installed root");
            byte[] configKey = Helper.Concat(
                verifier ? Prefix_VerifierConfigContext : Prefix_HookConfigContext, (byte[])accountId);
            ByteString? configuredRoot = Storage.Get(Storage.CurrentContext, configKey);
            BigInteger depth = GetConfigurationContextDepth();
            bool rootContext = depth == 1 && configuredRoot != null && (UInt160)configuredRoot! == root;
            ExecutionEngine.Assert(depth == 0 || rootContext, "Cannot maintain dependencies during execution");
            // Only authenticated settlement establishes this exact root context while escrowed.
            // It may clear dependencies, never replace them or delegate to another account/role.
            if (!clearing || !rootContext) AssertNoMarketEscrow(accountId);
            return root!;
        }

        private static void ValidateDependencyChildren(UInt160[] children, UInt160 root, bool verifier)
        {
            ExecutionEngine.Assert(children != null && children.Length <= 10, "Invalid dependency count");
            for (int i = 0; i < children!.Length; i++)
            {
                UInt160 child = children[i]!;
                ExecutionEngine.Assert(child != null && child!.IsValid && child != UInt160.Zero
                    && child != root && child != Runtime.ExecutingScriptHash, "Invalid dependency child");
                for (int j = i + 1; j < children.Length; j++)
                    ExecutionEngine.Assert(child != children[j], "Duplicate dependency child");
                ExecutionEngine.Assert(ModuleExposesMethod(child!, "clearAccount", ContractParameterType.Void,
                    ContractParameterType.Hash160), "Child cleanup ABI missing");
            }
        }

        private static void CleanupDependency(UInt160 accountId, UInt160 child, bool verifier)
        {
            if (verifier) SetVerifierConfigContext(accountId, child);
            else SetHookConfigContext(accountId, child);
            try
            {
                CallModuleWithMaintenanceBudget(child, "clearAccount", CallFlags.All, new object[] { accountId });
            }
            finally
            {
                if (verifier) ClearVerifierConfigContext(accountId);
                else ClearHookConfigContext(accountId);
            }
        }

        private static void AcquireDependencyMaintenance(byte[] lockKey, UInt160 accountId)
        {
            ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext, lockKey) == null,
                "Dependency maintenance already active");
            Storage.Put(Storage.CurrentContext, lockKey, (byte[])accountId);
        }
    }
}
