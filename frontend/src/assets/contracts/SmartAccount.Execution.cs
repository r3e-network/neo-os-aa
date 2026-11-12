using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    public partial class SmartAccount
    {
        // Protocol bounds. These are consensus-visible limits: accepting an unbounded
        // object/array here would make the operation format depend only on VM resource
        // limits. These cardinality bounds do not replace gas or nested-payload limits.
        private const int MaxUserOperationBatchLength = 32;
        private const int MaxUserOperationArgsLength = 64;
        private const int MaxUserOperationArgsDepth = 8;
        private const int MaxUserOperationArgsSerializedLength = 4096;
        private const int MaxUserOperationMethodLength = 128;
        private const int MaxUserOperationSignatureLength = 1024;

#if PLATFORM
        // The platform syscall interprets this value in datoshi. 1,000,000,000
        // datoshi is 10 GAS, the maximum resource budget for each verifier callback,
        // including nested verifier calls; NeoVM enforces the ancestor budget transitively.
        private const long VerifierGasLimit = 1_000_000_000;
        private const long ModuleMaintenanceGasLimit = 250_000_000;
        // A root and its maximum of ten separately bounded leaf cleanups share this parent envelope.
        private const long RootModuleMaintenanceGasLimit = 11 * ModuleMaintenanceGasLimit;

        // System.Contract.CallWithGasLimit is a platform syscall that no published
        // Neo.SmartContract.Framework declares, so this contract declares it. The attribute
        // emits a SYSCALL only a private Neo core can execute. Public builds exclude it.
        private static class PlatformSyscalls
        {
            [Syscall("System.Contract.CallWithGasLimit")]
            public static extern object CallWithGasLimit(
                UInt160 scriptHash, string method, CallFlags flags, long gasLimit, params object?[]? args);
        }

        private static object CallModuleWithMaintenanceBudget(
            UInt160 scriptHash, string method, CallFlags flags, params object[] args) =>
            PlatformSyscalls.CallWithGasLimit(scriptHash, method, flags, ModuleMaintenanceGasLimit, args);
        private static object CallRootWithMaintenanceBudget(
            UInt160 scriptHash, string method, CallFlags flags, params object[] args) =>
            PlatformSyscalls.CallWithGasLimit(scriptHash, method, flags, RootModuleMaintenanceGasLimit, args);

        private static object CallVerifierWithGasLimit(
            UInt160 scriptHash, string method, CallFlags flags, params object[] args) =>
            PlatformSyscalls.CallWithGasLimit(scriptHash, method, flags, VerifierGasLimit, args);
#else
        private static object CallModuleWithMaintenanceBudget(
            UInt160 scriptHash, string method, CallFlags flags, params object[] args) =>
            Contract.Call(scriptHash, method, flags, args);
        private static object CallRootWithMaintenanceBudget(
            UInt160 scriptHash, string method, CallFlags flags, params object[] args) =>
            Contract.Call(scriptHash, method, flags, args);
#endif

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
            ValidateAccountId(accountId);
            ExecutionEngine.Assert(!IsExecutionActive(accountId), "Reentrant call rejected");
            ValidateUserOperation(op);

            AccountState state = GetAccountState(accountId);
            AssertNoMarketEscrow(accountId);

            SetExecutionLock(accountId);
            if (state.Verifier != UInt160.Zero)
            {
                SetVerifierExecutionContext(accountId, state.Verifier);
            }

            object[] executionArgs;

            try
            {
                // [ValidateUserOp phase]
                ExecutionEngine.Assert(Runtime.Time <= op.Deadline, "UserOp expired");

                // Step 1: Validate nonce WITHOUT consuming (read-only check)
                ExecutionEngine.Assert(IsNonceAcceptable(accountId, op.Nonce), "Invalid sequence for channel");

                // Step 2: Verify signature
                if (state.Verifier != UInt160.Zero)
                {
                    UserOperation verificationOp = CloneUserOperation(op);
                    // Delegate to plugin for signature verification (e.g., ecrecover or TEE hardware)
#if PLATFORM
                    bool isValid = (bool)PlatformSyscalls.CallWithGasLimit(
                        state.Verifier,
                        "validateSignature",
                        CallFlags.ReadOnly,
                        VerifierGasLimit,
                        new object[] { accountId, verificationOp });
#else
                    bool isValid = (bool)Contract.Call(
                        state.Verifier,
                        "validateSignature",
                        CallFlags.ReadOnly,
                        new object[] { accountId, verificationOp });
#endif
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

                // Contract.Call passes VM arrays by reference. Keep the operation that was
                // authenticated separate from the arrays exposed to policy hooks: a hook is an
                // extension point, and a malicious/buggy implementation must not be able to
                // rewrite the signed transfer arguments before the target call executes.
                executionArgs = CloneOperationArguments(op.Args);

                // [Hook phase] pre-execution hook
                if (state.HookId != UInt160.Zero)
                {
                    SetHookExecutionContext(accountId, state.HookId);
                    try
                    {
                        object[] hookParams = BuildHookOperationParams(op, executionArgs);
                        ByteString hookSnapshot = StdLib.Serialize(hookParams);
                        CallModuleWithMaintenanceBudget(
                            state.HookId,
                            "preExecute",
                            CallFlags.All,
                            new object[] { accountId, hookParams });
                        ExecutionEngine.Assert(
                            StdLib.MemoryCompare(hookSnapshot, StdLib.Serialize(hookParams)) == 0,
                            "Hook mutated authenticated operation");
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
                    object result = Contract.Call(op.TargetContract, op.Method, CallFlags.All, executionArgs);

                    // [Hook phase] post-execution hook
                    if (state.HookId != UInt160.Zero)
                    {
                        object[] hookParams = BuildHookOperationParams(op, executionArgs);
                        ByteString hookSnapshot = StdLib.Serialize(hookParams);
                        CallModuleWithMaintenanceBudget(
                            state.HookId,
                            "postExecute",
                            CallFlags.All,
                            new object[] { accountId, hookParams, CloneCallbackValue(result)! });
                        ExecutionEngine.Assert(
                            StdLib.MemoryCompare(hookSnapshot, StdLib.Serialize(hookParams)) == 0,
                            "Hook mutated authenticated operation");
                    }
                    if (state.Verifier != UInt160.Zero)
                    {
#if PLATFORM
                        PlatformSyscalls.CallWithGasLimit(
                            state.Verifier,
                            "postExecute",
                            CallFlags.All,
                            VerifierGasLimit,
                            new object[] { accountId, CloneUserOperation(op), CloneCallbackValue(result)! });
#else
                        Contract.Call(
                            state.Verifier,
                            "postExecute",
                            CallFlags.All,
                            new object[] { accountId, CloneUserOperation(op), CloneCallbackValue(result)! });
#endif
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
            ValidateAccountId(accountId);
            ValidateUserOperation(op);
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
            ValidateAccountId(accountId);
            ExecutionEngine.Assert(ops != null && ops.Length > 0, "Operations required");
            ExecutionEngine.Assert(ops!.Length <= MaxUserOperationBatchLength, "Batch exceeds protocol limit");

            object[] results = new object[ops.Length];
            for (int i = 0; i < ops.Length; i++)
            {
                results[i] = ExecuteUserOp(accountId, ops[i]);
            }
            return results;
        }

        /// <summary>
        /// Canonical callback ABI for hook plugins.
        /// </summary>
        /// <remarks>
        /// The first callback argument is the account id; the second is the operation tuple
        /// consumed by the hook family. It is deliberately not the serialized <see cref="UserOperation"/>
        /// object: existing hooks inspect target, method, and call arguments by position. Keeping
        /// this conversion in one helper prevents pre/post callbacks from drifting and makes the
        /// hook refinement boundary explicit:
        /// <c>[TargetContract, Method, Args, Nonce, Deadline, Signature]</c>.
        /// </remarks>
        private static object[] BuildHookOperationParams(UserOperation op, object[] args)
        {
            return new object[]
            {
                op.TargetContract,
                op.Method,
                args,
                op.Nonce,
                op.Deadline,
                op.Signature
            };
        }

        private static object[] CloneOperationArguments(object[] args)
        {
            return (object[])StdLib.Deserialize(StdLib.Serialize(args));
        }

        private static UserOperation CloneUserOperation(UserOperation op)
        {
            return new UserOperation
            {
                TargetContract = op.TargetContract,
                Method = op.Method,
                Args = CloneOperationArguments(op.Args),
                Nonce = op.Nonce,
                Deadline = op.Deadline,
                Signature = op.Signature
            };
        }

        // Callback modules are extension points.  Pass a serialized copy of the
        // target result so a post hook/verifier cannot rewrite the value returned
        // to the caller or mutate an object later consumed by settlement logic.
        private static object? CloneCallbackValue(object? value)
        {
            return value == null ? null : StdLib.Deserialize(StdLib.Serialize(value));
        }

        // ========================================================================
        // 4. Replay Protection (ERC-4337 2D Nonce spec)
        // ========================================================================

        // Canonical ERC-4337 2D nonce: the full signed-VM nonce is split into a 191-bit channel (the
        // parallel lane) and a 64-bit sequence (the strictly incrementing cursor within that
        // lane). Every lane is independent and each starts at sequence 0, so a fresh, randomly
        // chosen channel with sequence 0 yields one-shot semantics without a separate code path.
        // There is no value threshold: channel = nonce >> 64 is always the
        // lane, which makes every channel (including channel >= 1) reachable.
        private static bool IsNonceAcceptable(UInt160 accountId, BigInteger nonce)
        {
            if (nonce < 0 || !IsUnsignedIntegerWithinBytes(nonce, 32)) return false;

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
            ExecutionEngine.Assert(IsUnsignedIntegerWithinBytes(nonce, 32), "Nonce outside uint256 domain");

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

        private static void ValidateAccountId(UInt160 accountId)
        {
            ExecutionEngine.Assert(accountId != null && accountId != UInt160.Zero && accountId.IsValid, "Account id required");
        }

        /// <summary>
        /// Enforces the canonical UserOperation ABI boundary before any external call.
        /// BigInteger is used by Neo's VM, but the AA wire format is deliberately bounded
        /// to the non-negative signed-VM domain (`0 <= value < 2^255`) for nonce and deadline.
        /// </summary>
        private static void ValidateUserOperation(UserOperation op)
        {
            ExecutionEngine.Assert(op != null, "Operation required");
            ExecutionEngine.Assert(op!.TargetContract != null && op.TargetContract != UInt160.Zero && op.TargetContract.IsValid,
                "Target contract required");
            ExecutionEngine.Assert(op.Method != null && op.Method.Length > 0 && op.Method.Length <= MaxUserOperationMethodLength,
                "Invalid method");
            ExecutionEngine.Assert(op.Args != null && op.Args.Length <= MaxUserOperationArgsLength,
                "Arguments exceed protocol limit");
            for (int i = 0; i < op.Args!.Length; i++)
            {
                ValidateUserOperationArgumentDepth(op.Args[i], 0);
            }
            byte[] serializedArgs = (byte[])StdLib.Serialize(op.Args!);
            ExecutionEngine.Assert(serializedArgs.Length <= MaxUserOperationArgsSerializedLength,
                "Serialized arguments exceed protocol limit");
            ExecutionEngine.Assert(op.Deadline >= 0 && IsUnsignedIntegerWithinBytes(op.Deadline, 32),
                "Deadline outside uint256 domain");
            ExecutionEngine.Assert(op.Nonce >= 0, "Invalid sequence for channel");
            ExecutionEngine.Assert(IsUnsignedIntegerWithinBytes(op.Nonce, 32),
                "Nonce outside uint256 domain");
            ExecutionEngine.Assert(op.Signature != null, "Signature required");
            ExecutionEngine.Assert(op.Signature!.Length <= MaxUserOperationSignatureLength,
                "Signature exceeds protocol limit");
        }

        /// <summary>
        /// Bounds nested arrays and structs in the UserOperation argument vector. The top-level
        /// Args array is not counted; every nested VM array is one level. nccs does not support
        /// object[] type patterns, so the cast is isolated in a catchable probe and all recursive
        /// traversal happens only after the VM has confirmed an array value.
        /// </summary>
        private static void ValidateUserOperationArgumentDepth(object? value, int depth)
        {
            if (value == null || value is bool || value is string
                || value is byte[] || value is ByteString || value is BigInteger)
                return;

            object[]? nested;
            try
            {
                nested = (object[]?)value;
            }
            catch
            {
                return;
            }
            if (nested == null) return;
            int nestedDepth = depth + 1;
            ExecutionEngine.Assert(nestedDepth <= MaxUserOperationArgsDepth,
                "Arguments exceed nesting depth");
            for (int i = 0; i < nested.Length; i++)
            {
                ValidateUserOperationArgumentDepth(nested[i], nestedDepth);
            }
        }

        /// <summary>
        /// BigInteger.ToByteArray() is signed little-endian and may include one trailing
        /// sign byte. Trim that byte before applying the unsigned protocol-width bound.
        /// </summary>
        private static bool IsUnsignedIntegerWithinBytes(BigInteger value, int maxBytes)
        {
            if (value < 0) return false;
            byte[] encoded = value.ToByteArray();
            int length = encoded.Length;
            if (length > 0 && encoded[length - 1] == 0) length--;
            // NeoVM integers are signed. A value whose highest retained byte has
            // its sign bit set would require one extra sign byte in canonical
            // serialization, so it is outside the representable non-negative
            // domain even when its magnitude fits the nominal byte width.
            return length <= maxBytes
                && (length < maxBytes || length == 0 || encoded[length - 1] < 0x80);
        }
    }
}
