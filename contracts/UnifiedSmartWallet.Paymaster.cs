using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        // ========================================================================
        // 8. Paymaster: Sponsored / Gasless Transactions
        // ========================================================================

        // Neo N3 on-chain paymaster flow:
        // 1. Relay calls ExecuteSponsoredUserOp with paymaster + sponsor details
        // 2. Relay may optionally preflight ValidatePaymasterOp off-chain before submission
        // 3. Core executes the UserOp normally (verifier + hooks + target call)
        // 4. Core calls paymaster.settleReimbursement for atomic policy enforcement + relay reimbursement

        /// <summary>
        /// Caps a relay-supplied reimbursement request to the actual gas cost the relay paid for the
        /// enclosing transaction (system fee + network fee). This binds the sponsored reimbursement to
        /// real cost so a relay cannot always claim its policy MaxPerOp regardless of the gas actually
        /// consumed (audit MEDIUM-a). The paymaster still enforces MaxPerOp / budgets / deposit backing.
        /// </summary>
        /// <remarks>
        /// A persisted transaction never has a zero total fee: its system fee must cover the gas the
        /// script consumes and its network fee must cover witness verification, whose execution-fee
        /// factor is at least one. A container whose fees are both zero is therefore an
        /// <c>invokescript</c>/<c>invokefunction</c> estimation, not a chain transaction. Faulting in
        /// that case would make sponsored operations impossible to price with standard wallet and
        /// relay tooling, so the estimation container is capped at the requested amount, the largest
        /// amount the chain could settle; every transaction that reaches a block is capped as before.
        /// The cap is computed without a branch so an estimation and the persisted transaction execute
        /// the same instruction sequence: an early return on the estimation path was measured to
        /// under-estimate the system fee by the instructions it skipped, which made the persisted
        /// transaction fault with "Insufficient GAS". <c>BigInteger.Min</c> compiles to the MIN opcode.
        /// </remarks>
        private static BigInteger CapReimbursementToActualCost(BigInteger requested)
        {
            BigInteger actualCost = (BigInteger)Runtime.Transaction.SystemFee + (BigInteger)Runtime.Transaction.NetworkFee;
            BigInteger estimationFlag = 1 - BigInteger.Min(actualCost, 1);
            BigInteger cap = actualCost + estimationFlag * requested;
            return BigInteger.Min(requested, cap);
        }

        /// <summary>
        /// Executes a single user operation with paymaster sponsorship.
        /// The relay (transaction sender) is reimbursed from the sponsor's deposit
        /// held in the paymaster contract after successful execution.
        /// </summary>
        /// <param name="accountId">The AA account executing the operation</param>
        /// <param name="op">The user operation to execute</param>
        /// <param name="paymaster">The paymaster contract hash</param>
        /// <param name="sponsor">The sponsor address funding the operation</param>
        /// <param name="reimbursementAmount">GAS amount (in fractions) to reimburse the relay</param>
        /// <returns>The result of the target contract call</returns>
        public static object ExecuteSponsoredUserOp(
            UInt160 accountId,
            UserOperation op,
            UInt160 paymaster,
            UInt160 sponsor,
            BigInteger reimbursementAmount)
        {
            ValidateAccountId(accountId);
            ValidateUserOperation(op);
            ExecutionEngine.Assert(paymaster != null && paymaster != UInt160.Zero, "Paymaster required");
            ExecutionEngine.Assert(sponsor != null && sponsor != UInt160.Zero, "Sponsor required");
            ExecutionEngine.Assert(reimbursementAmount > 0, "Reimbursement amount required");

            // Verify the paymaster is trusted: its AuthorizedCore must point back to this contract.
            // Prevents arbitrary contracts from being passed as paymasters.
            UInt160 paymasterCore = (UInt160)Contract.Call(paymaster!, "authorizedCore", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(paymasterCore == Runtime.ExecutingScriptHash, "Paymaster not bound to this core");

            // Bind the relay-requested reimbursement to the actual gas cost of this transaction
            // (audit MEDIUM-a): the relay cannot be reimbursed for more than it actually paid.
            BigInteger settledAmount = CapReimbursementToActualCost(reimbursementAmount);
            ExecutionEngine.Assert(settledAmount > 0, "Reimbursement exceeds actual gas cost");

            // Execute the operation (full validation + execution + hooks)
            object result = ExecuteUserOp(accountId!, op);

            // Settle: deduct from sponsor deposit and reimburse relay.
            // Settlement does full policy validation atomically — no separate pre-check needed.
            Contract.Call(paymaster!, "settleReimbursement", CallFlags.All,
                new object[] { sponsor!, accountId!, op.TargetContract, op.Method,
                               Runtime.Transaction.Sender!, settledAmount });

            OnSponsoredUserOpExecuted(accountId!, paymaster!, sponsor!, Runtime.Transaction.Sender!, settledAmount);
            return result;
        }

        /// <summary>
        /// Executes multiple user operations as an atomic batch with paymaster sponsorship.
        /// A single reimbursement covers the entire batch. The settlement validates the first
        /// op's target/method against the policy; all ops in the batch must target the same
        /// contract and method.
        /// </summary>
        public static object[] ExecuteSponsoredUserOps(
            UInt160 accountId,
            UserOperation[] ops,
            UInt160 paymaster,
            UInt160 sponsor,
            BigInteger reimbursementAmount)
        {
            ValidateAccountId(accountId);
            ExecutionEngine.Assert(paymaster != null && paymaster != UInt160.Zero, "Paymaster required");
            ExecutionEngine.Assert(sponsor != null && sponsor != UInt160.Zero, "Sponsor required");
            ExecutionEngine.Assert(reimbursementAmount > 0, "Reimbursement amount required");
            ExecutionEngine.Assert(ops != null && ops.Length > 0, "Operations required");
            ExecutionEngine.Assert(ops!.Length <= MaxUserOperationBatchLength, "Batch exceeds protocol limit");

            UserOperation[] validatedOps = ops!;
            for (int i = 0; i < validatedOps.Length; i++)
            {
                ValidateUserOperation(validatedOps[i]);
            }

            // Verify the paymaster is trusted
            UInt160 paymasterCore = (UInt160)Contract.Call(paymaster!, "authorizedCore", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(paymasterCore == Runtime.ExecutingScriptHash, "Paymaster not bound to this core");

            // Enforce all ops share the same target/method (policy is checked against these)
            for (int i = 1; i < ops!.Length; i++)
            {
                ExecutionEngine.Assert(ops[i].TargetContract == ops[0].TargetContract, "Batch ops must share target contract");
                ExecutionEngine.Assert(ops[i].Method == ops[0].Method, "Batch ops must share method");
            }

            // Bind the relay-requested reimbursement to the actual gas cost of this transaction
            // (audit MEDIUM-a): a single batch reimbursement cannot exceed the gas actually paid.
            BigInteger settledAmount = CapReimbursementToActualCost(reimbursementAmount);
            ExecutionEngine.Assert(settledAmount > 0, "Reimbursement exceeds actual gas cost");

            // Execute all operations atomically
            object[] results = ExecuteUserOps(accountId!, ops);

            // Single settlement for entire batch
            Contract.Call(paymaster!, "settleReimbursement", CallFlags.All,
                new object[] { sponsor!, accountId!, ops[0].TargetContract, ops[0].Method,
                               Runtime.Transaction.Sender!, settledAmount });

            OnSponsoredUserOpExecuted(accountId!, paymaster!, sponsor!, Runtime.Transaction.Sender!, settledAmount);
            return results;
        }
    }
}
