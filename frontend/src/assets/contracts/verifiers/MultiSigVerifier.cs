using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Verifiers
{
    /// <summary>
    /// Threshold verifier that composes multiple child verifiers into one approval policy.
    /// </summary>
    /// <remarks>
    /// Each child verifier validates its own signature format. This contract only enforces that a
    /// sufficient number of child verifiers approve the same user operation.
    /// </remarks>
    [DisplayName("MultiSigVerifier")]
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "canExecuteVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ContractPermission("*", "postExecute")]
    [ContractPermission("*", "supportsV3")]
    [ContractPermission("*", "validateSignature")]
    [ManifestExtra("Description", "Heterogeneous Threshold Multi-Sig Verifier")]
    public class MultiSigVerifier : SmartContract
    {
        private static readonly byte[] Prefix_Config = new byte[] { 0x01 };
        private const int MaxChildVerifiers = 10;

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsMessageSignatures() => false;

        [Safe]
        public static UInt160 AuthorizedCore() => VerifierAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => VerifierAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with hooks): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => VerifierAuthority.CancelAuthorizedCoreChange();

        // AA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => VerifierAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        public static void CancelUpdate() => VerifierAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        public class MultiSigConfig
        {
            public UInt160[] Verifiers;
            public int Threshold;
        }

        /// <summary>
        /// Stores the ordered verifier set and threshold for the account.
        /// </summary>
        public static void SetConfig(UInt160 accountId, UInt160[] verifiers, int threshold)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            ExecutionEngine.Assert(verifiers != null && verifiers.Length > 0, "Empty verifier list not allowed");
            ExecutionEngine.Assert(verifiers.Length <= MaxChildVerifiers, $"Maximum {MaxChildVerifiers} child verifiers allowed");
            ExecutionEngine.Assert(threshold > 0 && threshold <= verifiers.Length, "Invalid threshold");

            // Reject duplicate verifiers to prevent single-signature threshold bypass
            for (int i = 0; i < verifiers.Length; i++)
            {
                ExecutionEngine.Assert(verifiers[i] != UInt160.Zero && verifiers[i].IsValid, "Invalid verifier address");
                ExecutionEngine.Assert(verifiers[i] != Runtime.ExecutingScriptHash, "MultiSig verifier cannot contain itself");
                for (int j = i + 1; j < verifiers.Length; j++)
                {
                    ExecutionEngine.Assert(verifiers[i] != verifiers[j], "Duplicate verifier");
                }
                AssertChildVerifier(verifiers[i]);
            }

            MultiSigConfig config = new MultiSigConfig { Verifiers = verifiers, Threshold = threshold };
            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(config));
        }

        private static void AssertChildVerifier(UInt160 verifier)
        {
            Contract? deployed = ContractManagement.GetContract(verifier);
            ExecutionEngine.Assert(deployed != null, "Child verifier is not deployed");

            ContractMethodDescriptor[] methods = deployed.Manifest.Abi.Methods;
            ExecutionEngine.Assert(ExposesSafeMethod(methods, "supportsV3", ContractParameterType.Boolean), "Child verifier V3 marker missing");
            ExecutionEngine.Assert(ExposesMethod(methods, "validateSignature", ContractParameterType.Boolean,
                ContractParameterType.Hash160, ContractParameterType.Any), "Child verifier validation ABI missing");
            ExecutionEngine.Assert(ExposesMethod(methods, "postExecute", ContractParameterType.Void,
                ContractParameterType.Hash160, ContractParameterType.Any, ContractParameterType.Any), "Child verifier post ABI missing");
            ExecutionEngine.Assert(ExposesMethod(methods, "clearAccount", ContractParameterType.Void,
                ContractParameterType.Hash160), "Child verifier cleanup ABI missing");

            bool supported = (bool)Contract.Call(verifier, "supportsV3", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(supported, "Child verifier does not implement V3 interface");
        }

        private static bool ExposesSafeMethod(ContractMethodDescriptor[] methods, string name,
            ContractParameterType returnType, params ContractParameterType[] parameterTypes)
        {
            for (int i = 0; i < methods.Length; i++)
            {
                ContractMethodDescriptor method = methods[i];
                if (!method.Safe || method.Name != name || method.ReturnType != returnType
                    || method.Parameters.Length != parameterTypes.Length) continue;
                bool parametersMatch = true;
                for (int j = 0; j < parameterTypes.Length; j++)
                {
                    if (method.Parameters[j].Type != parameterTypes[j])
                    {
                        parametersMatch = false;
                        break;
                    }
                }
                if (parametersMatch)
                {
                    return true;
                }
            }
            return false;
        }

        private static bool ExposesMethod(ContractMethodDescriptor[] methods, string name,
            ContractParameterType returnType, params ContractParameterType[] parameterTypes)
        {
            for (int i = 0; i < methods.Length; i++)
            {
                ContractMethodDescriptor method = methods[i];
                if (method.Name != name || method.ReturnType != returnType
                    || method.Parameters.Length != parameterTypes.Length) continue;
                bool parametersMatch = true;
                for (int j = 0; j < parameterTypes.Length; j++)
                {
                    if (method.Parameters[j].Type != parameterTypes[j])
                    {
                        parametersMatch = false;
                        break;
                    }
                }
                if (parametersMatch)
                {
                    return true;
                }
            }
            return false;
        }

        [Safe]
        public static MultiSigConfig? GetConfig(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return null;
            return (MultiSigConfig)StdLib.Deserialize(data!);
        }

        /// <summary>
        /// Validates a multi-signature bundle by forwarding to the configured child verifiers.
        /// </summary>
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "No MultiSig config");
            
            MultiSigConfig config = (MultiSigConfig)StdLib.Deserialize(data!);
            
            // Expected that op.Signature is an array of sub-signatures matching the verifier order
            object[] signatures = (object[])StdLib.Deserialize(op.Signature);
            ExecutionEngine.Assert(signatures.Length == config.Verifiers.Length, "Signature array length mismatch");

            int validCount = 0;
            for (int i = 0; i < config.Verifiers.Length; i++)
            {
                if (signatures[i] != null)
                {
                    UserOperation subOp = CreateSubOperation(op, signatures[i]);

                    // Wrap in try-catch so a throwing child verifier doesn't block
                    // the entire multisig when threshold can still be met
                    try
                    {
                        bool isValid = (bool)Contract.Call(config.Verifiers[i], "validateSignature", CallFlags.ReadOnly, new object[] { accountId, subOp });
                        if (isValid) validCount++;
                    }
                    catch { }
                }
            }
            
            return validCount >= config.Threshold;
        }

        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);

            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "No MultiSig config");

            MultiSigConfig config = (MultiSigConfig)StdLib.Deserialize(data!);
            object[] signatures = (object[])StdLib.Deserialize(op.Signature);
            ExecutionEngine.Assert(signatures.Length == config.Verifiers.Length, "Signature array length mismatch");

            int validCount = 0;
            bool[] validChildren = new bool[config.Verifiers.Length];
            for (int i = 0; i < config.Verifiers.Length; i++)
            {
                if (signatures[i] == null) continue;

                UserOperation subOp = CreateSubOperation(op, signatures[i]);
                try
                {
                    bool isValid = (bool)Contract.Call(config.Verifiers[i], "validateSignature", CallFlags.ReadOnly, new object[] { accountId, subOp });
                    if (!isValid) continue;

                    validChildren[i] = true;
                    validCount++;
                }
                catch
                {
                }
            }

            ExecutionEngine.Assert(validCount >= config.Threshold, "Verifier rejected signature");
            for (int i = 0; i < config.Verifiers.Length; i++)
            {
                if (!validChildren[i]) continue;

                UserOperation subOp = CreateSubOperation(op, signatures[i]);
                Contract.Call(config.Verifiers[i], "postExecute", CallFlags.All, new object[] { accountId, subOp, result });
            }
        }

        public static void ClearAccount(UInt160 accountId)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_Config, (byte[])accountId));
        }

        private static UserOperation CreateSubOperation(UserOperation op, object signature)
        {
            return new UserOperation
            {
                TargetContract = op.TargetContract,
                Method = op.Method,
                Args = op.Args,
                Nonce = op.Nonce,
                Deadline = op.Deadline,
                Signature = (ByteString)signature
            };
        }
    }
}
