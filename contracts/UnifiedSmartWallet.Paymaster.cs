using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
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

        // One bounded record shared across all accounts, sponsors and paymasters.
        // Transactions execute serially; a different hash resets the prior transaction's budget.
        private static readonly byte[] Prefix_TransactionReimbursement = new byte[] { 0x21 };

        private class TransactionReimbursement
        {
            public UInt256 TransactionHash = UInt256.Zero;
            public BigInteger Reserved = 0;
        }

        /// <summary>
        /// Caps a relay-supplied reimbursement request to the actual gas cost the relay paid for the
        /// enclosing transaction (system fee + network fee), less every amount already reserved by
        /// this core in that transaction. This binds the aggregate sponsored reimbursement to
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
        /// The fee-cap arithmetic does not return early for estimation. Loading or resetting the
        /// transaction record still has state-dependent cost, so RPC estimates are not an exact
        /// guarantee of persisted execution fees. Callers must retain their normal fee margin and
        /// simulate the complete invocation script; estimation settles each requested amount.
        /// A single bounded storage record avoids accumulating a permanent key per transaction.
        /// Reservation precedes every external callback; application faults roll it back atomically.
        /// </remarks>
        private static BigInteger CapReimbursementToActualCost(BigInteger requested)
        {
            UInt256 transactionHash = Runtime.Transaction.Hash;
            ByteString? data = Storage.Get(Storage.CurrentContext, Prefix_TransactionReimbursement);
            TransactionReimbursement budget = data == null
                ? new TransactionReimbursement()
                : (TransactionReimbursement)StdLib.Deserialize(data);
            if (budget.TransactionHash != transactionHash)
            {
                budget.TransactionHash = transactionHash;
                budget.Reserved = 0;
            }
            BigInteger actualCost = (BigInteger)Runtime.Transaction.SystemFee + (BigInteger)Runtime.Transaction.NetworkFee;
            BigInteger estimationFlag = 1 - BigInteger.Min(actualCost, 1);
            BigInteger cap = BigInteger.Max(actualCost - budget.Reserved, 0) + estimationFlag * requested;
            BigInteger settled = BigInteger.Min(requested, cap);
            ExecutionEngine.Assert(settled > 0, "Reimbursement exceeds actual gas cost");
            // The reservation is persisted and accumulated across the sponsored
            // calls of one transaction, so the sum has to stay inside the VM
            // integer domain. Letting the ADD fault would surface a CLR range
            // error ("Integer size 33 bytes exceeds ...") rather than a contract
            // rejection, so the headroom is checked explicitly here. A persisted
            // transaction caps `settled` by the actual fee and cannot reach the
            // limit; only the zero-fee estimation container can accumulate
            // unbounded requests, and that is exactly the case rejected below.
            BigInteger vmMax = ((BigInteger.One << 254) - 1) + (BigInteger.One << 254);
            ExecutionEngine.Assert(budget.Reserved <= vmMax - settled,
                "Reimbursement budget exceeds VM integer limit");
            budget.Reserved += settled;
            Storage.Put(Storage.CurrentContext, Prefix_TransactionReimbursement, StdLib.Serialize(budget));
            return settled;
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

            // Reserve before every external call, including paymaster discovery.
            BigInteger settledAmount = CapReimbursementToActualCost(reimbursementAmount);

            // Verify the paymaster is trusted: its AuthorizedCore must point back to this contract.
            // Prevents arbitrary contracts from being passed as paymasters.
            UInt160 paymasterCore = (UInt160)Contract.Call(paymaster!, "authorizedCore", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(paymasterCore == Runtime.ExecutingScriptHash, "Paymaster not bound to this core");

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

            // Enforce all ops share the same target/method (policy is checked against these)
            for (int i = 1; i < ops!.Length; i++)
            {
                ExecutionEngine.Assert(ops[i].TargetContract == ops[0].TargetContract, "Batch ops must share target contract");
                ExecutionEngine.Assert(ops[i].Method == ops[0].Method, "Batch ops must share method");
            }

            // Bind the relay-requested reimbursement to the actual gas cost of this transaction
            // (audit MEDIUM-a): a single batch reimbursement cannot exceed the gas actually paid.
            BigInteger settledAmount = CapReimbursementToActualCost(reimbursementAmount);

            // The shared transaction reservation is already visible to reentrant callbacks.
            UInt160 paymasterCore = (UInt160)Contract.Call(paymaster!, "authorizedCore", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(paymasterCore == Runtime.ExecutingScriptHash, "Paymaster not bound to this core");

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
