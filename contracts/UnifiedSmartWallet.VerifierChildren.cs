using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        // Positional wire shape returned by a root's explicit child-configuration
        // capability. A generic getConfig is ambiguous (e.g. native signer lists).
        private class VerifierChildConfiguration
        {
            public UInt160[] Verifiers = new UInt160[0];
            public BigInteger Threshold = 0;
        }

        /// <summary>
        /// Stages or confirms a timelocked initialization call to a current direct
        /// child of the installed verifier. The core remains the child's caller;
        /// the root never receives a general forwarding capability.
        /// </summary>
        public static object CallVerifierChild(UInt160 accountId, UInt160 childVerifier, string method, object[] args)
        {
            AssertBackupOwner(accountId);
            AssertNoMarketEscrow(accountId);
            ExecutionEngine.Assert(!IsExecutionActive(accountId), "Cannot configure child during execution");
            ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext,
                Helper.Concat(Prefix_VerifierConfigContext, (byte[])accountId)) == null,
                "Verifier configuration already active");

            AccountState state = GetAccountState(accountId);
            UInt160 root = state.Verifier;
            ExecutionEngine.Assert(root != null && root != UInt160.Zero, "Verifier not configured");
            ExecutionEngine.Assert(childVerifier != null && childVerifier.IsValid
                && childVerifier != UInt160.Zero && childVerifier != root, "Invalid child verifier");
            ExecutionEngine.Assert(ModuleExposesSafeMethod(root!, "getChildVerifierConfig", ContractParameterType.Any,
                ContractParameterType.Hash160), "Verifier child configuration ABI missing");
            AssertVerifierCoreBinding(root!);

            VerifierChildConfiguration config = (VerifierChildConfiguration)Contract.Call(
                root!, "getChildVerifierConfig", CallFlags.ReadOnly, new object[] { accountId });
            ExecutionEngine.Assert(config != null && config.Verifiers != null
                && config.Verifiers.Length > 0 && config.Verifiers.Length <= 10,
                "Invalid child verifier configuration");
            ExecutionEngine.Assert(config!.Threshold > 0 && config.Threshold <= config.Verifiers!.Length,
                "Invalid child verifier threshold");

            bool installed = false;
            for (int i = 0; i < config.Verifiers!.Length; i++)
            {
                UInt160 child = config.Verifiers[i];
                ExecutionEngine.Assert(child != null && child.IsValid && child != UInt160.Zero
                    && child != root, "Invalid child verifier configuration");
                for (int j = i + 1; j < config.Verifiers.Length; j++)
                {
                    ExecutionEngine.Assert(child != config.Verifiers[j], "Duplicate child verifier");
                }
                if (child == childVerifier) installed = true;
            }
            ExecutionEngine.Assert(installed, "Child verifier not installed");
            AssertV3Verifier(childVerifier!);
            AssertVerifierCoreBinding(childVerifier!);
            AssertChildConfigurationCall(accountId, childVerifier!, method, args);

            // Share the existing pending slot and readable receipt with root maintenance.
            // Domain-separate this call from ordinary root calls, binding the ordered
            // child list and threshold as well as the exact target, method and arguments.
            ByteString topologyHash = CryptoLib.Sha256(StdLib.Serialize(config));
            byte[] pendingKey = Helper.Concat(Prefix_PendingVerifierCall, (byte[])accountId);
            if (!TryConfirmPendingModuleCall(pendingKey, root!, "callVerifierChild",
                new object[] { childVerifier!, method, args, topologyHash }))
            {
                return false;
            }

            SetVerifierConfigContext(accountId, childVerifier!);
            try
            {
                return Contract.Call(childVerifier!, method, CallFlags.All, args);
            }
            finally
            {
                ClearVerifierConfigContext(accountId);
            }
        }

        private static void AssertVerifierCoreBinding(UInt160 verifier)
        {
            ExecutionEngine.Assert(ModuleExposesSafeMethod(verifier, "authorizedCore", ContractParameterType.Hash160),
                "Verifier core binding ABI missing");
            UInt160 core = (UInt160)Contract.Call(verifier, "authorizedCore", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(core == Runtime.ExecutingScriptHash, "Verifier bound to another core");
        }

        private static void AssertChildConfigurationCall(UInt160 accountId, UInt160 child, string method, object[] args)
        {
            ExecutionEngine.Assert(method == "setPublicKey" || method == "setConfig",
                "Child configuration method not allowed");
            ExecutionEngine.Assert(args != null && args.Length == (method == "setPublicKey" ? 2 : 3),
                "Invalid child configuration arguments");
            ExecutionEngine.Assert((UInt160)args![0] == accountId, "Child configuration account mismatch");
            bool validAbi = method == "setPublicKey"
                ? ModuleExposesMethod(child, method, ContractParameterType.Void,
                    ContractParameterType.Hash160, ContractParameterType.ByteArray)
                : ModuleExposesMethod(child, method, ContractParameterType.Void,
                    ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Integer);
            ExecutionEngine.Assert(validAbi, "Child configuration method ABI missing");
        }
    }
}
