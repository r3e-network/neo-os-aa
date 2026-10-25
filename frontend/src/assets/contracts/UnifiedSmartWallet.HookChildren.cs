using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        public static object CallHookChild(UInt160 accountId, UInt160 childHook, string method, object[] args)
        {
            AssertBackupOwner(accountId);
            AssertAccountConfigurationIdle(accountId);
            AssertNoMarketEscrow(accountId);

            AccountState state = GetAccountState(accountId);
            UInt160 root = state.HookId;
            ExecutionEngine.Assert(root != null && root != UInt160.Zero, "Hook not configured");
            ExecutionEngine.Assert(childHook != null && childHook.IsValid
                && childHook != UInt160.Zero && childHook != root, "Invalid child hook");
            ExecutionEngine.Assert(ModuleExposesSafeMethod(root!, "getChildHookConfig", ContractParameterType.Array,
                ContractParameterType.Hash160), "Hook child configuration ABI missing");
            AssertHookCoreBinding(root!);

            object[] children = (object[])CallModuleWithMaintenanceBudget(
                root!, "getChildHookConfig", CallFlags.ReadOnly, new object[] { accountId })!;
            ExecutionEngine.Assert(children != null && children!.Length > 0 && children!.Length <= 8,
                "Invalid child hook configuration");
            bool installed = false;
            for (int i = 0; i < children!.Length; i++)
            {
                UInt160 child = (UInt160)children[i];
                ExecutionEngine.Assert(child != null && child.IsValid && child != UInt160.Zero
                    && child != root, "Invalid child hook configuration");
                for (int j = i + 1; j < children!.Length; j++)
                    ExecutionEngine.Assert(child != (UInt160)children[j], "Duplicate child hook");
                if (child == childHook) installed = true;
            }
            ExecutionEngine.Assert(installed, "Child hook not installed");
            AssertV3Hook(childHook!);
            AssertHookCoreBinding(childHook!);
            AssertChildHookConfigurationCall(accountId, childHook!, method, args);

            ByteString topologyHash = CryptoLib.Sha256(StdLib.Serialize(children));
            byte[] pendingKey = Helper.Concat(Prefix_PendingHookCall, (byte[])accountId);
            if (!TryConfirmPendingModuleCall(pendingKey, root!, "callHookChild",
                new object[] { childHook!, method, args, topologyHash }))
            {
                return false;
            }

            SetHookConfigContext(accountId, childHook!);
            try
            {
                return CallModuleWithMaintenanceBudget(childHook!, method, CallFlags.All, args);
            }
            finally
            {
                ClearHookConfigContext(accountId);
            }
        }

        private static void AssertHookCoreBinding(UInt160 hook)
        {
            ExecutionEngine.Assert(ModuleExposesSafeMethod(hook, "authorizedCore", ContractParameterType.Hash160),
                "Hook core binding ABI missing");
            UInt160 core = (UInt160)CallModuleWithMaintenanceBudget(hook, "authorizedCore", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(core == Runtime.ExecutingScriptHash, "Hook bound to another core");
        }

        private static void AssertChildHookConfigurationCall(UInt160 accountId, UInt160 child, string method, object[] args)
        {
            int expectedArgs;
            ContractParameterType[] parameterTypes;
            if (method == "setWhitelist")
            {
                expectedArgs = 3;
                parameterTypes = new ContractParameterType[] {
                    ContractParameterType.Hash160, ContractParameterType.Hash160, ContractParameterType.Boolean };
            }
            else if (method == "setDailyLimit")
            {
                expectedArgs = 4;
                parameterTypes = new ContractParameterType[] {
                    ContractParameterType.Hash160, ContractParameterType.Hash160,
                    ContractParameterType.Integer, ContractParameterType.Boolean };
            }
            else if (method == "setRestrictedToken")
            {
                expectedArgs = 3;
                parameterTypes = new ContractParameterType[] {
                    ContractParameterType.Hash160, ContractParameterType.Hash160, ContractParameterType.Boolean };
            }
            else
            {
                ExecutionEngine.Assert(method == "requireCredentialCommitmentForContract",
                    "Child hook configuration method not allowed");
                expectedArgs = 5;
                parameterTypes = new ContractParameterType[] {
                    ContractParameterType.Hash160, ContractParameterType.Hash160, ContractParameterType.String,
                    ContractParameterType.String, ContractParameterType.ByteArray };
            }
            ExecutionEngine.Assert(args != null && args.Length == expectedArgs,
                "Invalid child hook configuration arguments");
            ExecutionEngine.Assert((UInt160)args![0] == accountId, "Child hook configuration account mismatch");
            ExecutionEngine.Assert(ModuleExposesMethod(child, method, ContractParameterType.Void, parameterTypes),
                "Child hook configuration method ABI missing");
        }
    }
}
