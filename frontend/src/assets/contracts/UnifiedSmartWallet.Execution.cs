using System.Numerics;
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
        // 3. Core Routing: Validation and Execution (aligned with 4337 Validate & Call)
        // ========================================================================

        /// <summary>
        /// Canonical execution entrypoint for a single V3 user operation.
        /// </summary>
        /// <remarks>
        /// This path consumes the nonce, checks the verifier or backup-owner witness,
        /// runs the pre-hook, executes the target contract call, and then runs the post-hook.
        /// </remarks>
        public static object ExecuteUserOp(UInt160 accountId, UserOperation op)
        {
            ExecutionEngine.Assert(!IsExecutionActive(accountId), "Reentrant call rejected");

            AccountState state = GetAccountState(accountId);
            AssertNoMarketEscrow(accountId);

            SetExecutionLock(accountId);
            if (state.Verifier != UInt160.Zero)
            {
                SetVerifierExecutionContext(accountId, state.Verifier);
            }

            try
            {
                // [ValidateUserOp phase]
                ExecutionEngine.Assert(Runtime.Time <= op.Deadline, "UserOp expired");

                // Step 1: Validate nonce WITHOUT consuming (read-only check)
                ExecutionEngine.Assert(IsNonceAcceptable(accountId, op.Nonce), "Invalid sequence for channel");

                // Step 2: Verify signature
                if (state.Verifier != UInt160.Zero)
                {
                    // Delegate to plugin for signature verification (e.g., ecrecover or TEE hardware)
                    bool isValid = (bool)Contract.Call(state.Verifier, "validateSignature", CallFlags.ReadOnly, new object[] { accountId, op });
                    ExecutionEngine.Assert(isValid, "Verifier rejected signature");
                }
                else
                {
                    // No plugin: fall back to backup owner direct authorization.
                    // accountId is still used as virtual account identity,
                    // but actual control comes from BackupOwner's native N3 witness.
                    ExecutionEngine.Assert(state.BackupOwner != null && state.BackupOwner != UInt160.Zero, "Native fallback requires backup owner");
                    ExecutionEngine.Assert(Runtime.CheckWitness(state.BackupOwner!), "Native witness failed");
                }

                // Step 3: Security defense — escape check
                // NOTE: Only the backup owner can cancel an active escape to prevent attackers
                // from repeatedly executing operations to indefinitely delay the escape hatch.
                if (state.EscapeTriggeredAt > 0)
                {
                    // BackupOwner is validated to be non-null on line 50, but add redundant check for compiler
                    ExecutionEngine.Assert(state.BackupOwner != null && state.BackupOwner != UInt160.Zero, "No backup owner");
                    ExecutionEngine.Assert(Runtime.CheckWitness(state.BackupOwner!), "Only backup owner can cancel escape");
                    state.EscapeTriggeredAt = 0;
                    byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
                    Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(state));
                    OnEscapeCancelled(accountId);
                }

                // Step 4: NOW consume nonce (all validations passed)
                ConsumeNonce(accountId, op.Nonce);

                // [Hook phase] pre-execution hook
                if (state.HookId != UInt160.Zero)
                {
                    SetHookExecutionContext(accountId, state.HookId);
                    try
                    {
                        Contract.Call(state.HookId, "preExecute", CallFlags.All, new object[] { accountId, op });
                    }
                    catch
                    {
                        ClearHookExecutionContext(accountId);
                        throw;
                    }
                }

                // [Execution phase]
                // Write context lock to allow TargetContract to do reverse CheckWitness verification
                SetVerifyContext(accountId, op.TargetContract);
                try
                {
                    // Dynamically call target contract
                    object result = Contract.Call(op.TargetContract, op.Method, CallFlags.All, op.Args);

                    // [Hook phase] post-execution hook
                    if (state.HookId != UInt160.Zero)
                    {
                        Contract.Call(state.HookId, "postExecute", CallFlags.All, new object[] { accountId, op, result });
                    }
                    if (state.Verifier != UInt160.Zero)
                    {
                        Contract.Call(state.Verifier, "postExecute", CallFlags.All, new object[] { accountId, op, result });
                    }

                    OnUserOpExecuted(accountId, op.TargetContract, op.Method, op.Nonce);
                    return result;
                }
                finally
                {
                    ClearVerifyContext(accountId);
                    if (state.HookId != UInt160.Zero)
                    {
                        ClearHookExecutionContext(accountId);
                    }
                }
            }
            finally
            {
                if (state.Verifier != UInt160.Zero)
                {
                    ClearVerifierExecutionContext(accountId);
                }
                ClearExecutionLock(accountId);
            }
        }

        /// <summary>
        /// Read-only preview of the core validation checks for a single user operation.
        /// This intentionally excludes signature verification and hook execution.
        /// </summary>
        [Safe]
        public static object[] PreviewUserOpValidation(UInt160 accountId, UserOperation op)
        {
            AccountState state = GetAccountState(accountId);
            return new object[]
            {
                Runtime.Time <= op.Deadline,
                IsNonceAcceptable(accountId, op.Nonce),
                state.Verifier != UInt160.Zero,
                state.Verifier,
                state.HookId
            };
        }

        // ========================================================================
        // 3.1 Intent Engine: Batch Execution
        // ========================================================================

        /// <summary>
        /// Executes multiple user operations sequentially inside one Neo application invocation.
        /// Because Neo contract execution is transactional, a failure on any operation faults
        /// the invocation and reverts the whole batch.
        /// </summary>
        public static object[] ExecuteUserOps(UInt160 accountId, UserOperation[] ops)
        {
            object[] results = new object[ops.Length];
            for (int i = 0; i < ops.Length; i++)
            {
                results[i] = ExecuteUserOp(accountId, ops[i]);
            }
            return results;
        }

        // ========================================================================
        // 4. Replay Protection (ERC-4337 2D Nonce spec)
        // ========================================================================

        // Canonical ERC-4337 2D nonce: the full nonce is split into a 192-bit channel (the
        // parallel lane) and a 64-bit sequence (the strictly incrementing cursor within that
        // lane). Every lane is independent and each starts at sequence 0, so a fresh, randomly
        // chosen channel with sequence 0 yields one-shot ("salt") semantics for free without a
        // separate code path. There is no value threshold: channel = nonce >> 64 is always the
        // lane, which makes every channel (including channel >= 1) reachable.
        private static bool IsNonceAcceptable(UInt160 accountId, BigInteger nonce)
        {
            if (nonce < 0) return false;

            BigInteger channel = nonce >> 64;
            BigInteger sequence = nonce & 0xFFFFFFFFFFFFFFFF;

            byte[] key = Helper.Concat(Prefix_Nonce, (byte[])accountId);
            key = Helper.Concat(key, channel.ToByteArray());

            ByteString? currentData = Storage.Get(Storage.CurrentContext, key);
            BigInteger currentSeq = currentData == null ? 0 : (BigInteger)currentData;
            return sequence == currentSeq;
        }

        private static void ConsumeNonce(UInt160 accountId, BigInteger nonce)
        {
            ExecutionEngine.Assert(nonce >= 0, "Invalid sequence for channel");

            // Strictly follow ERC-4337 channel incrementing mode (Key = Channel, Seq = Sequence)
            BigInteger channel = nonce >> 64;
            BigInteger sequence = nonce & 0xFFFFFFFFFFFFFFFF;

            byte[] key = Helper.Concat(Prefix_Nonce, (byte[])accountId);
            key = Helper.Concat(key, channel.ToByteArray());

            ByteString? currentData = Storage.Get(Storage.CurrentContext, key);
            BigInteger currentSeq = currentData == null ? 0 : (BigInteger)currentData;

            // Replay protection: a (channel, sequence) pair is only valid when the sequence is the
            // current cursor; consuming advances it by one, so the same pair can never be replayed
            // and out-of-order sequences within a channel are rejected.
            ExecutionEngine.Assert(sequence == currentSeq, "Invalid sequence for channel");
            Storage.Put(Storage.CurrentContext, key, currentSeq + 1);
        }
    }
}
