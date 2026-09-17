using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        // ========================================================================
        // 5. N3 Magic: Native Witness Verification Support
        // ========================================================================

        // This section enables Neo's native witness/verification script system to work
        // seamlessly with Abstract Accounts, making Neo's AA fundamentally different from
        // Ethereum's ERC-4337 approach.

        /// <summary>
        /// Bridge that enables native Neo multisig verification scripts to work with AA.
        /// </summary>
        /// <remarks>
        /// <para>
        /// This method enables a key Neo N3 advantage over Ethereum's AA:
        /// Neo's native CheckWitness API can verify ECDSA signatures against the
        /// transaction's verification scripts without any external cryptographic calls.
        /// </para>
        /// <para>
        /// <b>How it works:</b>
        /// <list type="bullet">
        ///   <item>During ExecuteUserOp, SetVerifyContext stores the target contract</item>
        ///   <item>The target contract can call CheckWitness(accountId) to verify authorization</item>
        ///   <item>Neo's runtime checks if the transaction includes a valid witness for accountId</item>
        ///   <item>This supports Neo's native M-of-N multisig verification scripts</item>
        /// </list>
        /// </para>
        /// <para>
        /// <b>Integration with NeoNativeVerifier:</b>
        /// When using NeoNativeVerifier, the UserOperation's Signature field is ignored.
        /// Instead, verification relies entirely on Neo's native transaction witnesses:
        /// <list type="bullet">
        ///   <item>User includes the required signers in their Neo transaction</item>
        ///   <item>Each signer provides their verification script (or multisig contract script)</item>
        ///   <item>NeoNativeVerifier calls Runtime.CheckWitness for each authorized signer</item>
        ///   <item>The operation succeeds only when M-of-N signers have valid witnesses</item>
        /// </list>
        /// This is the most gas-efficient verification method as it leverages Neo's
        /// built-in signature checking without any external crypto libraries.
        /// </para>
        /// <para>
        /// <b>Neo vs Ethereum AA difference:</b>
        /// Ethereum's ERC-4337 requires bundlers and complex signature aggregation.
        /// Neo's native witness system eliminates the need for bundlers - the blockchain
        /// itself handles signature verification through its transaction witnesses.
        /// </para>
        /// </remarks>
        /// <param name="accountId">The AA account identifier to verify</param>
        /// <returns>True if the calling contract is the current execution target for this account</returns>
        [Safe]
        public static bool Verify(UInt160 accountId)
        {
            if (Runtime.Trigger == TriggerType.Verification)
            {
                return VerifyScopedTransactionSigner(accountId);
            }

            if (Runtime.Trigger == TriggerType.Application)
            {
                byte[] key = Helper.Concat(Prefix_VerifyContext, (byte[])accountId);
                ByteString? expectedTarget = Storage.Get(Storage.CurrentContext, key);
                if (expectedTarget == null) return VerifyScopedTransactionSigner(accountId);
                UInt160 activeTarget = (UInt160)expectedTarget;
                if (activeTarget == Runtime.CallingScriptHash) return true;

                // The active user operation may legitimately move native NEO/GAS, in which case
                // the native asset contract (not the op target) performs the nested witness check
                // and calls back here with NEO.Hash / GAS.Hash as the calling script.
                //
                // Security (audit fix): authorizing ANY native NEO/GAS call by calling-script
                // hash alone lets a target authorized only for a single non-financial method move
                // the account's full NEO/GAS, defeating session-key/method scoping. The native
                // callback is therefore only honored when the user-signed operation explicitly
                // targeted that same native asset (op.TargetContract == NEO/GAS) — i.e. the exact
                // value transfer the owner authorized. A target authorized for some other contract
                // can no longer pull the account's native assets.
                if (Runtime.CallingScriptHash == NEO.Hash) return activeTarget == NEO.Hash;
                if (Runtime.CallingScriptHash == GAS.Hash) return activeTarget == GAS.Hash;
                return false;
            }

            return false;
        }

        [Safe]
        public static UInt160 GetVerifyScopeTarget(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_VerifyScopeTarget, (byte[])accountId);
            ByteString? value = Storage.Get(Storage.CurrentContext, key);
            if (value == null)
            {
                byte[] legacyKey = Helper.Concat(LegacyStoragePrefix12, (byte[])accountId);
                value = Storage.Get(Storage.CurrentContext, legacyKey);
            }
            return value == null ? UInt160.Zero : (UInt160)value;
        }

        public static void SetVerifyScopeTarget(UInt160 accountId, UInt160 targetContract)
        {
            AssertContractAdmin();
            SetVerifyScopeTargetCore(accountId, targetContract);
        }

        public static void SetVerifyScopeTargets(UInt160[] accountIds, UInt160 targetContract)
        {
            AssertContractAdmin();
            ExecutionEngine.Assert(accountIds != null && accountIds.Length > 0 && accountIds.Length <= 128, "invalid account batch");
            UInt160[] accounts = accountIds!;
            for (int i = 0; i < accounts.Length; i++)
            {
                SetVerifyScopeTargetCore(accounts[i], targetContract);
            }
        }

        private static void SetVerifyScopeTargetCore(UInt160 accountId, UInt160 targetContract)
        {
            ExecutionEngine.Assert(accountId != null && accountId != UInt160.Zero, "account id required");
            ExecutionEngine.Assert(targetContract != null && targetContract != UInt160.Zero, "target required");
            byte[] key = Helper.Concat(Prefix_VerifyScopeTarget, (byte[])accountId!);
            Storage.Put(Storage.CurrentContext, key, (byte[])targetContract!);
            Storage.Delete(Storage.CurrentContext, Helper.Concat(LegacyStoragePrefix12, (byte[])accountId!));
        }

        private static void AssertContractAdmin()
        {
            ByteString? admin = Storage.Get(Storage.CurrentContext, Prefix_ContractAdmin);
            ExecutionEngine.Assert(admin != null, "No admin set");
            UInt160 adminHash = (UInt160)admin!;
            ExecutionEngine.Assert(Runtime.CheckWitness(adminHash), "Not admin");
        }

        private static bool VerifyScopedTransactionSigner(UInt160 accountId)
        {
            UInt160 targetContract = GetVerifyScopeTarget(accountId);
            if (targetContract == UInt160.Zero) return false;

            Signer[] signers = Runtime.CurrentSigners();
            for (int i = 0; i < signers.Length; i++)
            {
                if (HasExactAaWitnessRules(signers[i], Runtime.ExecutingScriptHash, targetContract))
                {
                    return true;
                }
            }
            return false;
        }

        private static bool HasExactAaWitnessRules(Signer signer, UInt160 proxyContract, UInt160 targetContract)
        {
            if (signer.Scopes != WitnessScope.WitnessRules) return false;
            if (signer.Rules == null || signer.Rules.Length != 1) return false;
            WitnessRule rule = signer.Rules[0];
            if (rule.Action != WitnessRuleAction.Allow) return false;
            if (rule.Condition == null || rule.Condition.Type != WitnessConditionType.Or) return false;

            OrCondition condition = (OrCondition)rule.Condition;
            if (condition.Expressions == null || condition.Expressions.Length != 2) return false;

            bool hasProxy = false;
            bool hasTarget = false;
            for (int i = 0; i < condition.Expressions.Length; i++)
            {
                WitnessCondition expression = condition.Expressions[i];
                if (expression == null || expression.Type != WitnessConditionType.CalledByContract) return false;
                CalledByContractCondition calledBy = (CalledByContractCondition)expression;
                if (calledBy.Hash == proxyContract) hasProxy = true;
                else if (calledBy.Hash == targetContract) hasTarget = true;
                else return false;
            }
            return hasProxy && hasTarget;
        }

        /// <summary>
        /// Authorizes a verifier plugin to configure itself for an account.
        /// </summary>
        /// <remarks>
        /// This enables verifiers like NeoNativeVerifier, Web3AuthVerifier, and others to
        /// store their configuration data without exposing it to arbitrary callers.
        /// </remarks>
        /// <param name="accountId">The AA account being configured</param>
        /// <param name="verifierContract">The verifier contract seeking authorization</param>
        /// <returns>True if caller is the expected verifier for this configuration</returns>
        [Safe]
        public static bool CanConfigureVerifier(UInt160 accountId, UInt160 verifierContract)
        {
            byte[] key = Helper.Concat(Prefix_VerifierConfigContext, (byte[])accountId);
            ByteString? expectedVerifier = Storage.Get(Storage.CurrentContext, key);
            return expectedVerifier != null
                && Runtime.CallingScriptHash == verifierContract
                && (UInt160)expectedVerifier == verifierContract;
        }

        /// <summary>
        /// Authorizes a hook plugin to configure itself for an account.
        /// </summary>
        /// <remarks>
        /// This enables hooks like DailyLimitHook, WhitelistHook, and NeoDIDCredentialHook
        /// to store their configuration data securely.
        /// </remarks>
        /// <param name="accountId">The AA account being configured</param>
        /// <param name="hookContract">The hook contract seeking authorization</param>
        /// <returns>True if caller is the expected hook for this configuration</returns>
        [Safe]
        public static bool CanConfigureHook(UInt160 accountId, UInt160 hookContract)
        {
            byte[] key = Helper.Concat(Prefix_HookConfigContext, (byte[])accountId);
            ByteString? expectedHook = Storage.Get(Storage.CurrentContext, key);
            return expectedHook != null
                && Runtime.CallingScriptHash == hookContract
                && (UInt160)expectedHook == hookContract;
        }

        /// <summary>
        /// Authorizes a verifier plugin to apply post-execution effects during the verifier phase.
        /// </summary>
        [Safe]
        public static bool CanExecuteVerifier(UInt160 accountId, UInt160 callerContract, UInt160 verifierContract)
        {
            byte[] key = Helper.Concat(Prefix_VerifierExecutionContext, (byte[])accountId);
            ByteString? expectedRoot = Storage.Get(Storage.CurrentContext, key);
            if (expectedRoot == null) return false;
            if (Runtime.CallingScriptHash != verifierContract) return false;

            UInt160 activeRootVerifier = (UInt160)expectedRoot;
            if (callerContract == Runtime.ExecutingScriptHash)
            {
                return activeRootVerifier == verifierContract;
            }

            return callerContract == activeRootVerifier;
        }

        /// <summary>
        /// Authorizes a hook plugin to execute during the hook phase of UserOperation execution.
        /// </summary>
        /// <remarks>
        /// This validates that a hook plugin is the active hook for an account and that
        /// it's being called from the proper execution context (either directly from the
        /// AA core or from the root hook in a nested hook chain).
        /// </remarks>
        /// <param name="accountId">The AA account being executed</param>
        /// <param name="callerContract">The contract that initiated this hook call</param>
        /// <param name="hookContract">The hook contract being invoked</param>
        /// <returns>True if the hook is authorized to execute for this account</returns>
        [Safe]
        public static bool CanExecuteHook(UInt160 accountId, UInt160 callerContract, UInt160 hookContract)
        {
            byte[] key = Helper.Concat(Prefix_HookExecutionContext, (byte[])accountId);
            ByteString? expectedRoot = Storage.Get(Storage.CurrentContext, key);
            if (expectedRoot == null) return false;
            if (Runtime.CallingScriptHash != hookContract) return false;

            UInt160 activeRootHook = (UInt160)expectedRoot;
            if (callerContract == Runtime.ExecutingScriptHash)
            {
                return activeRootHook == hookContract;
            }

            return callerContract == activeRootHook;
        }
    }
}
