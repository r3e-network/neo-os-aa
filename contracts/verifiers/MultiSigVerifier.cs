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
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0xd9421d07adf206e9dc4be746a02e8e087fa61741", "hasModuleContext", "setVerifierDependencies", "clearVerifierDependencies")]
    [ContractPermission("*", "validateSignatureForPostExecute")]
    [ManifestExtra("SmartAccountProfile", "native-v1")]
#else
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "canExecuteVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ContractPermission("*", "setVerifierDependencies")]
    [ContractPermission("*", "clearVerifierDependencies")]
#endif
    [ContractPermission("*", "postExecute")]
    [ContractPermission("*", "supportsV3")]
    [ContractPermission("*", "validateSignature")]
    [ManifestExtra("Description", "Heterogeneous Threshold Multi-Sig Verifier")]
    public class MultiSigVerifier : SmartContract
    {
        private static readonly byte[] Prefix_Config = new byte[] { 0x01 };
        private const int MaxChildVerifiers = 10;
        private const int MaxDomainsPerChild = 10;

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsComposition() => true;

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

            AssertSignerDomainSeparation(accountId, verifiers);

            MultiSigConfig config = new MultiSigConfig { Verifiers = verifiers, Threshold = threshold };
            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(config));
            UInt160 core = VerifierAuthority.AuthorizedCore();
            Contract.Call(core, "setVerifierDependencies", CallFlags.All,
                new object[] { accountId, verifiers });
        }

        private static void AssertChildVerifier(UInt160 verifier)
        {
            Contract? deployed = ContractManagement.GetContract(verifier);
            ExecutionEngine.Assert(deployed != null, "Child verifier is not deployed");

            ContractMethodDescriptor[] methods = deployed.Manifest.Abi.Methods;
            ExecutionEngine.Assert(ExposesSafeMethod(methods, "supportsV3", ContractParameterType.Boolean), "Child verifier V3 marker missing");
            ExecutionEngine.Assert(ExposesSafeMethod(methods, "supportsComposition", ContractParameterType.Boolean), "Child verifier composition marker missing");
            bool composite = (bool)Contract.Call(verifier, "supportsComposition", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(!composite, "Composite verifier cannot be a child");
#if SMARTACCOUNT_NATIVE
            ExecutionEngine.Assert(ExposesMethod(methods, "validateSignature", ContractParameterType.Boolean,
                ContractParameterType.Hash160, ContractParameterType.Array), "Child verifier validation ABI missing");
            ExecutionEngine.Assert(ExposesMethod(methods, "postExecute", ContractParameterType.Void,
                ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Any), "Child verifier post ABI missing");
            ExecutionEngine.Assert(ExposesSafeMethod(methods, "validateSignatureForPostExecute", ContractParameterType.Boolean,
                ContractParameterType.Hash160, ContractParameterType.Array), "Child verifier post-validation ABI missing");
#else
            ExecutionEngine.Assert(ExposesMethod(methods, "validateSignature", ContractParameterType.Boolean,
                ContractParameterType.Hash160, ContractParameterType.Any), "Child verifier validation ABI missing");
            ExecutionEngine.Assert(ExposesMethod(methods, "postExecute", ContractParameterType.Void,
                ContractParameterType.Hash160, ContractParameterType.Any, ContractParameterType.Any), "Child verifier post ABI missing");
#endif
            ExecutionEngine.Assert(ExposesMethod(methods, "clearAccount", ContractParameterType.Void,
                ContractParameterType.Hash160), "Child verifier cleanup ABI missing");
            ExecutionEngine.Assert(ExposesSafeMethod(methods, "getSignerDomains", ContractParameterType.Array,
                ContractParameterType.Hash160), "Child signer-domain ABI missing");

            bool supported = (bool)Contract.Call(verifier, "supportsV3", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(supported, "Child verifier does not implement V3 interface");
        }

#if SMARTACCOUNT_NATIVE
        private static void AssertSignerDomainSeparation(UInt160 accountId, UInt160[] verifiers) => ReadSignerDomains(accountId, verifiers);

        private static ByteString[] ReadSignerDomains(UInt160 accountId, UInt160[] verifiers)
#else
        private static void AssertSignerDomainSeparation(UInt160 accountId, UInt160[] verifiers)
#endif
        {
            ByteString[] domains = new ByteString[MaxChildVerifiers * MaxDomainsPerChild];
            int domainCount = 0;
            for (int i = 0; i < verifiers.Length; i++)
            {
                ByteString[] childDomains = (ByteString[])Contract.Call(
                    verifiers[i], "getSignerDomains", CallFlags.ReadOnly,
                    new object[] { accountId });
                ExecutionEngine.Assert(childDomains != null && childDomains.Length > 0,
                    "Child signer-domain set is empty");
                ExecutionEngine.Assert(childDomains.Length <= MaxDomainsPerChild,
                    "Child signer-domain set is too large");

                for (int j = 0; j < childDomains.Length; j++)
                {
                    ByteString domain = childDomains[j];
                    ExecutionEngine.Assert(domain != null && domain.Length == 32,
                        "Invalid signer domain");
                    for (int k = 0; k < domainCount; k++)
                    {
                        ExecutionEngine.Assert(!EqualBytes(domains[k], domain),
                            "Duplicate signer domain");
                    }
                    domains[domainCount++] = domain;
                }
            }
#if SMARTACCOUNT_NATIVE
            ByteString[] result = new ByteString[domainCount];
            for (int i = 0; i < domainCount; i++) result[i] = domains[i];
            return result;
#endif
        }

        private static bool EqualBytes(ByteString left, ByteString right)
        {
            if (left.Length != right.Length) return false;
            for (int i = 0; i < left.Length; i++)
            {
                if (left[i] != right[i]) return false;
            }
            return true;
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
#if SMARTACCOUNT_NATIVE
        public static bool ValidateSignature(UInt160 accountId, object[] fields)
        {
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "validation");
            UserOperation op = NativeOperation.Decode(fields);
#else
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
#endif
            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "No MultiSig config");

            MultiSigConfig config = (MultiSigConfig)StdLib.Deserialize(data!);
            AssertSignerDomainSeparation(accountId, config.Verifiers);

            // Expected that op.Signature is an array of sub-signatures matching the verifier order
#if SMARTACCOUNT_NATIVE
            object[] signatures = NativeSignatures(op.Signature);
#else
            object[] signatures = (object[])StdLib.Deserialize(op.Signature);
#endif
            ExecutionEngine.Assert(signatures.Length == config.Verifiers.Length, "Signature array length mismatch");

            // ReadOnly does not prevent mutation of shared VM collections.
            // Capture once, before dispatch; each child receives its own deep copy.
            ByteString argumentSnapshot = StdLib.Serialize(op.Args);
            int validCount = 0;
            for (int i = 0; i < config.Verifiers.Length; i++)
            {
                if (signatures[i] != null)
                {
#if SMARTACCOUNT_NATIVE
                    object[] subOp = CreateNativeSubOperation(op, signatures[i], argumentSnapshot);
#else
                    UserOperation subOp = CreateSubOperation(op, signatures[i], argumentSnapshot);
#endif

                    // Wrap in try-catch so a throwing child verifier doesn't block
                    // the entire multisig when threshold can still be met
                    try
                    {
#if SMARTACCOUNT_NATIVE
                        object approval = Contract.Call(config.Verifiers[i], "validateSignature", CallFlags.ReadOnly, new object[] { accountId, subOp });
                        bool isValid = approval is bool && (bool)approval;
#else
                        bool isValid = (bool)Contract.Call(config.Verifiers[i], "validateSignature", CallFlags.ReadOnly, new object[] { accountId, subOp });
#endif
                        if (isValid) validCount++;
                    }
                    catch { }
                }
            }

            return validCount >= config.Threshold;
        }

#if SMARTACCOUNT_NATIVE
        public static void PostExecute(UInt160 accountId, object[] fields, object result)
        {
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "postExecute");
            UserOperation op = NativeOperation.Decode(fields);
#else
        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
#endif

            byte[] key = Helper.Concat(Prefix_Config, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "No MultiSig config");

            MultiSigConfig config = (MultiSigConfig)StdLib.Deserialize(data!);
            AssertSignerDomainSeparation(accountId, config.Verifiers);
#if SMARTACCOUNT_NATIVE
            object[] signatures = NativeSignatures(op.Signature);
#else
            object[] signatures = (object[])StdLib.Deserialize(op.Signature);
#endif
            ExecutionEngine.Assert(signatures.Length == config.Verifiers.Length, "Signature array length mismatch");

            ByteString argumentSnapshot = StdLib.Serialize(op.Args);
            int validCount = 0;
            bool[] validChildren = new bool[config.Verifiers.Length];
            for (int i = 0; i < config.Verifiers.Length; i++)
            {
                if (signatures[i] == null) continue;

#if SMARTACCOUNT_NATIVE
                object[] subOp = CreateNativeSubOperation(op, signatures[i], argumentSnapshot);
#else
                UserOperation subOp = CreateSubOperation(op, signatures[i], argumentSnapshot);
#endif
                try
                {
#if SMARTACCOUNT_NATIVE
                    object approval = Contract.Call(config.Verifiers[i], "validateSignatureForPostExecute", CallFlags.ReadOnly, new object[] { accountId, subOp });
                    bool isValid = approval is bool && (bool)approval;
#else
                    bool isValid = (bool)Contract.Call(config.Verifiers[i], "validateSignature", CallFlags.ReadOnly, new object[] { accountId, subOp });
#endif
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

#if SMARTACCOUNT_NATIVE
                object[] subOp = CreateNativeSubOperation(op, signatures[i], argumentSnapshot);
#else
                UserOperation subOp = CreateSubOperation(op, signatures[i], argumentSnapshot);
#endif
                Contract.Call(config.Verifiers[i], "postExecute", CallFlags.All, new object[] { accountId, subOp, result });
            }
        }

        public static void ClearAccount(UInt160 accountId)
        {
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "cleanup");
#else
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
#endif
            UInt160 core = VerifierAuthority.AuthorizedCore();
            Contract.Call(core, "clearVerifierDependencies", CallFlags.All, new object[] { accountId });
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_Config, (byte[])accountId));
        }

#if SMARTACCOUNT_NATIVE
        private static object[] NativeSignatures(ByteString encoded)
        {
            // The canonical Neo binary serializer tags an exact Array with 0x40.
            ExecutionEngine.Assert(encoded.Length > 0 && encoded[0] == 0x40, "MultiSig signature bundle must be an Array");
            object decoded = StdLib.Deserialize(encoded);
            object[] signatures = (object[])decoded;
            ExecutionEngine.Assert(StdLib.Serialize(signatures) == encoded, "Noncanonical MultiSig signature bundle");
            for (int i = 0; i < signatures.Length; i++)
                ExecutionEngine.Assert(signatures[i] == null || signatures[i] is ByteString, "Invalid child signature type");
            return signatures;
        }

        private static object[] CreateNativeSubOperation(UserOperation op, object signature, ByteString argumentSnapshot) =>
            new object[] { op.TargetContract, op.Method, (object[])StdLib.Deserialize(argumentSnapshot), op.Nonce, op.Deadline, (ByteString)signature };

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId)
        {
            MultiSigConfig? config = GetConfig(accountId);
            ExecutionEngine.Assert(config != null, "No MultiSig config");
            return ReadSignerDomains(accountId, config!.Verifiers);
        }
#endif

        private static UserOperation CreateSubOperation(UserOperation op, object signature, ByteString argumentSnapshot)
        {
            return new UserOperation
            {
                TargetContract = op.TargetContract,
                Method = op.Method,
                Args = (object[])StdLib.Deserialize(argumentSnapshot),
                Nonce = op.Nonce,
                Deadline = op.Deadline,
                Signature = (ByteString)signature
            };
        }
    }
}
