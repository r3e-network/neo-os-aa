using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Operation execution kernel (protocol v4, spec §4/§5/§3.6/§11):
    /// the strict 13-field canonical UserOperation, the
    /// NeoSmartAccount/UserOperation signing domain, explicit validatorId
    /// routing (built-in / module / threshold policy), hook snapshots in
    /// forward-pre / reverse-post order over the pre-approved set, the 0x58
    /// phase gates around every module callback, and the Plan B gas budget
    /// wrapping.
    ///
    /// Execution order (spec §3.6): validate → consume nonce → preCheck in
    /// hook order → close module authorization → dispatch target → close
    /// target authorization → postCheck in reverse order → validator
    /// completion (approved members only) → success event. Any validation
    /// rejection, hook rejection, lifecycle fault, code-identity change or
    /// gas overrun faults the whole transaction; target Boolean false is a
    /// normal result and still runs every postCheck and completion.
    /// </summary>
    public partial class SmartAccount
    {
        // UTF8("NeoSmartAccount/UserOperation") — 29 bytes.
        private static readonly byte[] UserOperationDomainPrefix = new byte[]
        {
            0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74,
            0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F,
            0x55, 0x73, 0x65, 0x72, 0x4F, 0x70, 0x65, 0x72,
            0x61, 0x74, 0x69, 0x6F, 0x6E
        };

        private static readonly BigInteger UInt64Mask = (BigInteger.One << 64) - BigInteger.One;

#if PLATFORM
        // System.Contract.CallWithGasLimit is a platform syscall that no published
        // Neo.SmartContract.Framework declares, so this contract declares it. The attribute
        // emits a SYSCALL only a private Neo core can execute. Public builds exclude it.
        private static class PlatformSyscalls
        {
            [Syscall("System.Contract.CallWithGasLimit")]
            public static extern object CallWithGasLimit(
                UInt160 scriptHash, string method, CallFlags flags, long gasLimit, params object?[]? args);
        }
#endif

        // ========================================================================
        // 1. Canonical envelope validation (spec §4.1)
        // ========================================================================

        /// <summary>
        /// Strict validation of the 13-field canonical UserOperation. Returns
        /// the operation as a VM Array; a Struct anywhere the spec requires an
        /// Array is rejected (canonical serialization of an Array begins with
        /// 0x40, of a Struct with 0x41).
        /// </summary>
        private static object[] ValidateOperationEnvelope(object operation)
        {
            object[] op;
            try
            {
                op = (object[])operation;
            }
            catch
            {
                ExecutionEngine.Assert(false, ErrorOperationMalformed);
                return new object[0];
            }
            ExecutionEngine.Assert(op != null && op.Length == UserOperationFieldCount, ErrorOperationFieldCount);

            // Top-level must be an Array, never a Struct.
            byte[] rawHeader = (byte[])StdLib.Serialize(op!);
            ExecutionEngine.Assert(rawHeader.Length > 0 && rawHeader[0] == 0x40, ErrorOperationMalformed);

            // [0] version
            ExecutionEngine.Assert((BigInteger)op![OpVersion] == ModuleProtocolVersion, ErrorProtocolVersion);
            // [1] target
            UInt160 target = (UInt160)op[OpTarget];
            ExecutionEngine.Assert(target != null && target != UInt160.Zero && target.IsValid,
                ErrorOperationMalformed);
            AssertTargetIsNotProtocolOwned(target!);
            // [2] method
            ByteString method = (ByteString)op[OpMethod];
            ExecutionEngine.Assert(method != null && method.Length >= 1 && method.Length <= MethodBytesMax,
                ErrorOperationMalformed);
            // [3] args
            object[] args = (object[])op[OpArgs];
            ExecutionEngine.Assert(args != null && args.Length <= ArgsCountMax, ErrorOperationMalformed);
            for (int i = 0; i < args!.Length; i++)
            {
                ValidateOperationArgument(args[i], 0);
            }
            byte[] serializedArgs = (byte[])StdLib.Serialize(args);
            ExecutionEngine.Assert(serializedArgs.Length <= ArgsSerializedSizeMax, ErrorOperationMalformed);
            // [4] nonce — 191-bit channel ‖ 64-bit sequence, non-negative < 2^255
            BigInteger nonce = (BigInteger)op[OpNonce];
            ExecutionEngine.Assert(nonce >= 0 && IsUnsignedIntegerWithinBytes(nonce, 32), ErrorNonceInvalid);
            // [5] nonceSubkey
            ByteString nonceSubkey = (ByteString)op[OpNonceSubkey];
            ExecutionEngine.Assert(nonceSubkey != null && nonceSubkey.Length == NonceSubkeySize,
                ErrorOperationMalformed);
            // [6] deadline
            BigInteger deadline = (BigInteger)op[OpDeadline];
            ExecutionEngine.Assert(deadline >= 0 && IsUnsignedIntegerWithinBytes(deadline, 32), ErrorDeadlineExpired);
            // [7] validatorId
            BigInteger validatorId = (BigInteger)op[OpValidatorId];
            ExecutionEngine.Assert(validatorId >= 0 && (validatorId >> 64) == BigInteger.Zero,
                ErrorOperationMalformed);
            // [8] credentialGeneration
            BigInteger credentialGeneration = (BigInteger)op[OpCredentialGeneration];
            ExecutionEngine.Assert(credentialGeneration >= 1 && (credentialGeneration >> 64) == BigInteger.Zero,
                ErrorOperationMalformed);
            // [9] authorityEpoch
            BigInteger authorityEpoch = (BigInteger)op[OpAuthorityEpoch];
            ExecutionEngine.Assert(authorityEpoch >= 0 && (authorityEpoch >> 64) == BigInteger.Zero,
                ErrorOperationMalformed);
            // [10] configurationNonce
            BigInteger configurationNonce = (BigInteger)op[OpConfigurationNonce];
            ExecutionEngine.Assert(configurationNonce >= 0 && (configurationNonce >> 64) == BigInteger.Zero,
                ErrorOperationMalformed);
            // [11] signature
            ByteString signature = (ByteString)op[OpSignature];
            ExecutionEngine.Assert(signature != null && signature.Length >= 1 && signature.Length <= SignatureBytesMax,
                ErrorOperationMalformed);
            // [12] hookProofs
            ValidateHookProofs(op[OpHookProofs]);

            // Single-operation encoding bound.
            byte[] serialized = (byte[])StdLib.Serialize(op);
            ExecutionEngine.Assert(serialized.Length <= OperationEncodedSizeMax, ErrorOperationMalformed);
            return op;
        }

        /// <summary>
        /// Bounds nested argument arrays: entries may be Null/Boolean/Integer/
        /// ByteString/Array only, depth ≤ 8, and every nested container must be
        /// a strict Array (never a Struct).
        /// </summary>
        private static void ValidateOperationArgument(object? value, int depth)
        {
            if (value == null || value is bool || value is string
                || value is byte[] || value is ByteString || value is BigInteger)
                return;

            object[] nested;
            try
            {
                nested = (object[])value!;
            }
            catch
            {
                ExecutionEngine.Assert(false, ErrorOperationMalformed);
                return;
            }
            // Strict Array (0x40), never Struct (0x41).
            byte[] header = (byte[])StdLib.Serialize(nested);
            ExecutionEngine.Assert(header.Length > 0 && header[0] == 0x40, ErrorOperationMalformed);

            int nestedDepth = depth + 1;
            ExecutionEngine.Assert(nestedDepth <= ArgsDepthMax, ErrorOperationMalformed);
            for (int i = 0; i < nested.Length; i++)
            {
                ValidateOperationArgument(nested[i], nestedDepth);
            }
        }

        private static void ValidateHookProofs(object hookProofsValue)
        {
            object[] proofs = (object[])hookProofsValue;
            ExecutionEngine.Assert(proofs != null && proofs.Length <= HookProofsEntriesMax, ErrorOperationMalformed);
            BigInteger aggregateProofBytes = BigInteger.Zero;
            BigInteger previousHookId = BigInteger.Zero;
            for (int i = 0; i < proofs!.Length; i++)
            {
                object[] pair = (object[])proofs[i];
                ExecutionEngine.Assert(pair != null && pair.Length == 2, ErrorProofInvalid);
                BigInteger hookId = (BigInteger)pair![0];
                ExecutionEngine.Assert(hookId > 0 && (hookId >> 64) == BigInteger.Zero, ErrorProofInvalid);
                // Unique and strictly ascending.
                ExecutionEngine.Assert(i == 0 || hookId > previousHookId, ErrorProofInvalid);
                previousHookId = hookId;
                ByteString proof = (ByteString)pair[1];
                ExecutionEngine.Assert(proof != null, ErrorProofInvalid);
                aggregateProofBytes += proof!.Length;
            }
            ExecutionEngine.Assert(aggregateProofBytes <= HookProofBytesMax, ErrorProofInvalid);
        }

        /// <summary>
        /// Every hook proof must reference a hook of the execution snapshot;
        /// proofs for hooks that will not run are rejected.
        /// </summary>
        private static void VerifyHookProofsAgainstSnapshot(object hookProofsValue, BigInteger[] snapshotHookIds)
        {
            object[] proofs = (object[])hookProofsValue;
            for (int i = 0; i < proofs!.Length; i++)
            {
                object[] pair = (object[])proofs[i];
                BigInteger hookId = (BigInteger)pair![0];
                bool found = false;
                for (int j = 0; j < snapshotHookIds.Length; j++)
                {
                    if (snapshotHookIds[j] == hookId)
                    {
                        found = true;
                        break;
                    }
                }
                ExecutionEngine.Assert(found, ErrorProofInvalid);
            }
        }

        // ========================================================================
        // 2. Canonical serialization and operation digest (spec §4.2/§4.3)
        // ========================================================================

        private static ByteString ComputeOperationDigest(
            UInt160 accountId, object[] op, BigInteger validatorId, BigInteger credentialGeneration,
            BigInteger authorityEpoch, BigInteger configurationNonce)
        {
            object[] canonical = new object[UserOperationFieldCount];
            for (int i = 0; i < UserOperationFieldCount; i++)
            {
                canonical[i] = op[i];
            }
            canonical[OpSignature] = (ByteString)new byte[0];
            ByteString canonicalBytes = StdLib.Serialize(canonical);

            byte[] domain = Helper.Concat(UserOperationDomainPrefix, new byte[] { (byte)ModuleProtocolVersion });
            domain = Helper.Concat(domain, U32LEBytes(Runtime.GetNetwork()));
            domain = Helper.Concat(domain, (byte[])Runtime.ExecutingScriptHash);
            domain = Helper.Concat(domain, (byte[])accountId);
            domain = Helper.Concat(domain, UInt64DomainBytes(validatorId));
            domain = Helper.Concat(domain, UInt64DomainBytes(credentialGeneration));
            domain = Helper.Concat(domain, UInt64DomainBytes(authorityEpoch));
            domain = Helper.Concat(domain, UInt64DomainBytes(configurationNonce));
            return CryptoLib.Sha256((ByteString)Helper.Concat(domain, (byte[])canonicalBytes));
        }

        /// <summary>
        /// Public digest query (spec §3.3): the exact digest a signer must
        /// sign for this operation on this account under the current core.
        /// </summary>
        [Safe]
        public static ByteString getOperationDigest(UInt160 accountId, object operation)
        {
            ValidateAccountId(accountId);
            // Migration-aware gate (spec §14): an unmigrated legacy account
            // fails closed with SA_MIGRATION_REQUIRED instead of the generic
            // not-found error; queries stay open through other endpoints.
            RequireV4AccountControl(accountId);
            object[] op = ValidateOperationEnvelope(operation);
            return ComputeOperationDigest(
                accountId, op,
                (BigInteger)op[OpValidatorId],
                (BigInteger)op[OpCredentialGeneration],
                (BigInteger)op[OpAuthorityEpoch],
                (BigInteger)op[OpConfigurationNonce]);
        }

        // ========================================================================
        // 3. Routing resolution (spec §3.5)
        // ========================================================================

        private static ModuleInstance? ResolveValidatorRouting(
            UInt160 accountId, AccountControl control, BigInteger validatorId, BigInteger credentialGeneration)
        {
            if (validatorId == 0)
            {
                // Built-in route: gated by the default operation authorization
                // switch — there is no automatic custody fallback.
                ExecutionEngine.Assert(control.DefaultOperationAuthorization, ErrorModuleNotRoutable);
                return null;
            }
            ModuleInstance? module = GetModuleInstance(accountId, validatorId);
            if (module != null)
            {
                ExecutionEngine.Assert(module.ModuleType == ModuleTypeCodeValidator, ErrorModuleNotRoutable);
                // Threshold-policy members are never independently routable.
                ExecutionEngine.Assert(!IsMemberOfActivePolicy(accountId, validatorId), ErrorModuleNotRoutable);
                ExecutionEngine.Assert(credentialGeneration == module.CredentialGeneration, ErrorCredentialStale);
                return module;
            }
            // Threshold policy routing: resolved by the caller through the
            // policy record; reaching here without a policy is an error.
            ThresholdPolicyRecord? policy = GetThresholdPolicy(accountId, validatorId);
            ExecutionEngine.Assert(policy != null && policy.Active, ErrorValidatorNotFound);
            ExecutionEngine.Assert(credentialGeneration == policy!.CredentialGeneration, ErrorCredentialStale);
            return null;
        }

        // ========================================================================
        // 4. Built-in operation signature (spec §5/§8)
        // ========================================================================

        /// <summary>
        /// Built-in (validatorId = 0) operation signature: the §8 message
        /// profile reused in operation mode — canonical P-256 scripts +
        /// 64-byte signatures over the OPERATION digest, threshold per 0x57.
        /// </summary>
        private static bool VerifyBuiltInOperationSignature(
            UInt160 accountId, ByteString operationDigest, ByteString signature)
        {
            MessageSubjectRecord? subjects = GetMessageSubjects(accountId);
            if (subjects == null || subjects.Subjects.Length == 0 || subjects.Threshold < 1) return false;

            object[] envelope;
            try
            {
                envelope = (object[])StdLib.Deserialize(signature);
            }
            catch
            {
                return false;
            }
            if (envelope.Length != 4) return false;
            if ((BigInteger)envelope[0] != ModuleProtocolVersion) return false;
            if ((BigInteger)envelope[1] != 0) return false;
            if ((BigInteger)envelope[2] != subjects.SubjectRevision) return false;
            object[] pairs = (object[])envelope[3];
            if (pairs.Length < 1 || pairs.Length > MessageSubjectKeysMax) return false;

            BigInteger approvals = BigInteger.Zero;
            for (int i = 0; i < pairs.Length; i++)
            {
                object[] pair = (object[])pairs[i];
                if (pair.Length != 2) return false;
                ByteString script = (ByteString)pair[0];
                ByteString memberSignature = (ByteString)pair[1];
                if (memberSignature.Length != P256SignatureSize) return false;

                byte[]? point = TryGetCanonicalP256Point(script);
                if (point == null) return false;

                ByteString scriptSha256 = CryptoLib.Sha256(script);
                bool authorized = false;
                for (int j = 0; j < subjects.Subjects.Length; j++)
                {
                    // 20-byte (custody address) and 32-byte (script hash)
                    // subjects both bind the signer script — see SubjectMatches.
                    if (SubjectMatches(subjects.Subjects[j], script, scriptSha256))
                    {
                        authorized = true;
                        break;
                    }
                }
                if (!authorized) return false;

                for (int j = 0; j < i; j++)
                {
                    object[] previous = (object[])pairs[j];
                    if ((ByteString)previous[0] == script) return false;
                }

                if (!CryptoLib.VerifyWithECDsa(
                        operationDigest, (ECPoint)point!, memberSignature,
                        NamedCurveHash.secp256r1SHA256))
                {
                    return false;
                }
                approvals += 1;
            }
            return approvals >= subjects.Threshold;
        }

        // ========================================================================
        // 5. Read-only validation preview (spec §3.3 validateUserOp)
        // ========================================================================

        /// <summary>
        /// Read-only, real-verification preview: full envelope validation,
        /// epoch/nonce/deadline checks and actual signature verification, with
        /// NO nonce consumption, NO hooks and NO state changes. Returns
        /// [accepted, operationDigest].
        /// </summary>
        [Safe]
        public static object[] validateUserOp(UInt160 accountId, object operation)
        {
            ValidateAccountId(accountId);
            AccountControl control = RequireV4AccountControl(accountId);
            object[] op = ValidateOperationEnvelope(operation);

            BigInteger validatorId = (BigInteger)op[OpValidatorId];
            BigInteger credentialGeneration = (BigInteger)op[OpCredentialGeneration];
            BigInteger authorityEpoch = (BigInteger)op[OpAuthorityEpoch];
            BigInteger configurationNonce = (BigInteger)op[OpConfigurationNonce];
            ByteString nonceSubkey = (ByteString)op[OpNonceSubkey];
            BigInteger nonce = (BigInteger)op[OpNonce];

            ByteString operationDigest = ComputeOperationDigest(
                accountId, op, validatorId, credentialGeneration, authorityEpoch, configurationNonce);

            bool accepted = control.Status == AccountStatusActive
                && Runtime.Time <= (BigInteger)op[OpDeadline]
                && authorityEpoch == control.AuthorityEpoch
                && configurationNonce == control.ConfigurationNonce;

            if (accepted)
            {
                ByteString namespaceDigest = ComputeNonceNamespaceDigest(
                    accountId, authorityEpoch, validatorId, credentialGeneration, nonceSubkey);
                byte[] channel = ChannelBytesFromDigest(namespaceDigest);
                BigInteger sequence = nonce & UInt64Mask;
                if ((nonce >> 64) != BytesToBigInteger(channel))
                {
                    accepted = false;
                }
                else
                {
                    try
                    {
                        AssertOperationNonceAcceptable(accountId, channel, namespaceDigest, sequence);
                    }
                    catch
                    {
                        accepted = false;
                    }
                }
            }

            if (accepted)
            {
                if (validatorId == 0)
                {
                    accepted = VerifyBuiltInOperationSignature(
                        accountId, operationDigest, (ByteString)op[OpSignature]);
                }
                else
                {
                    ModuleInstance? module = GetModuleInstance(accountId, validatorId);
                    if (module != null
                        && module.ModuleType == ModuleTypeCodeValidator
                        && !IsMemberOfActivePolicy(accountId, validatorId)
                        && credentialGeneration == module.CredentialGeneration)
                    {
                        accepted = CallValidatorValidateStandalone(accountId, module, op, operationDigest);
                    }
                    else
                    {
                        // Threshold policies are not previewed member-by-member:
                        // the read-only endpoint never orchestrates policy
                        // members (no receipts, no shared-budget invocation).
                        accepted = false;
                    }
                }
            }

            return new object[] { accepted, operationDigest };
        }

        /// <summary>
        /// Standalone read-only validator invocation for validateUserOp: no
        /// 0x58 phase context exists (the preview never mutates state), but
        /// the Plan A/Plan B per-call budget and code-binding continuity still
        /// apply. The module receives the same digest and 13-field canonical
        /// operation as in execution; because no writer phase is recorded it
        /// resolves its instance from <c>operation[validatorId]</c>, which the
        /// preview has already matched to this very instance (spec §9).
        /// </summary>
        private static bool CallValidatorValidateStandalone(
            UInt160 accountId, ModuleInstance module, object[] operation, ByteString operationDigest)
        {
            AssertCodeBindingUnchanged(module);
            long gasBefore = PrepareCallbackBudget(null, GasPoolNone, ValidationAggregateGasLimit);
            bool accepted = (bool)CallModuleGasCapped(
                module.ContractHash, "validateUserOp", CallFlags.ReadOnly, ValidationAggregateGasLimit,
                new object[] { accountId, operationDigest, BuildCanonicalOperationView(operation) });
            ChargeCallbackGas(null, GasPoolNone, gasBefore, ValidationAggregateGasLimit);
            return accepted;
        }

        // ========================================================================
        // 6. Execution entrypoints (spec §3.3/§3.6)
        // ========================================================================

        /// <summary>
        /// Canonical v4 execution entrypoint: explicit validatorId routing,
        /// derived nonce channel, hook snapshot in forward-pre/reverse-post
        /// order over the pre-approved set, phase-gated callbacks and
        /// completion for the approved routing subject only.
        /// </summary>
        public static object executeUserOp(UInt160 accountId, object operation)
        {
            return ExecuteUserOpCore(accountId, operation);
        }

        /// <summary>
        /// Execution core shared by the single and the batch entrypoints. The
        /// 0x58 application context is inherited when an enclosing envelope
        /// already opened it (executeUserOps), so one batch spends ONE budget
        /// instead of getting a fresh one per operation.
        /// </summary>
        private static object ExecuteUserOpCore(UInt160 accountId, object operation)
        {
            ValidateAccountId(accountId);
            object[] op = ValidateOperationEnvelope(operation);

            AccountControl control = RequireV4AccountControl(accountId);
            if (control.Status == AccountStatusFrozen)
            {
                ExecutionEngine.Assert(false, ErrorAccountFrozen);
            }
            if (control.Status == AccountStatusMigrationRequired)
            {
                ExecutionEngine.Assert(false, ErrorMigrationRequired);
            }
            AssertNoMarketEscrow(accountId);
            ExecutionEngine.Assert(!IsExecutionActive(accountId), ErrorReentrancyForbidden);

            BigInteger validatorId = (BigInteger)op[OpValidatorId];
            BigInteger credentialGeneration = (BigInteger)op[OpCredentialGeneration];
            BigInteger authorityEpoch = (BigInteger)op[OpAuthorityEpoch];
            BigInteger configurationNonce = (BigInteger)op[OpConfigurationNonce];
            BigInteger deadline = (BigInteger)op[OpDeadline];
            BigInteger nonce = (BigInteger)op[OpNonce];
            ByteString nonceSubkey = (ByteString)op[OpNonceSubkey];
            UInt160 target = (UInt160)op[OpTarget];
            ByteString method = (ByteString)op[OpMethod];

            BigInteger now = Runtime.Time;
            ExecutionEngine.Assert(now <= deadline, ErrorDeadlineExpired);
            ExecutionEngine.Assert(authorityEpoch == control.AuthorityEpoch, ErrorEpochStale);
            ExecutionEngine.Assert(configurationNonce == control.ConfigurationNonce, ErrorConfigurationNonceStale);

            // ---- Routing resolution (read-only, before any callback) ----
            ModuleInstance? validatorModule = null;
            ThresholdPolicyRecord? policy = null;
            if (validatorId == 0)
            {
                ExecutionEngine.Assert(control.DefaultOperationAuthorization, ErrorModuleNotRoutable);
            }
            else
            {
                validatorModule = GetModuleInstance(accountId, validatorId);
                if (validatorModule != null)
                {
                    ExecutionEngine.Assert(validatorModule.ModuleType == ModuleTypeCodeValidator, ErrorModuleNotRoutable);
                    ExecutionEngine.Assert(!IsMemberOfActivePolicy(accountId, validatorId), ErrorModuleNotRoutable);
                    ExecutionEngine.Assert(credentialGeneration == validatorModule.CredentialGeneration,
                        ErrorCredentialStale);
                }
                else
                {
                    policy = GetThresholdPolicy(accountId, validatorId);
                    ExecutionEngine.Assert(policy != null && policy.Active, ErrorValidatorNotFound);
                    ExecutionEngine.Assert(credentialGeneration == policy!.CredentialGeneration, ErrorCredentialStale);
                }
            }

            // ---- Derived nonce channel (read-only acceptance) ----
            ByteString namespaceDigest = ComputeNonceNamespaceDigest(
                accountId, authorityEpoch, validatorId, credentialGeneration, nonceSubkey);
            byte[] channel = ChannelBytesFromDigest(namespaceDigest);
            BigInteger sequence = nonce & UInt64Mask;
            ExecutionEngine.Assert((nonce >> 64) == BytesToBigInteger(channel), ErrorNonceInvalid);
            AssertOperationNonceAcceptable(accountId, channel, namespaceDigest, sequence);

            // ---- Operation digest ----
            ByteString operationDigest = ComputeOperationDigest(
                accountId, op, validatorId, credentialGeneration, authorityEpoch, configurationNonce);

            // ---- Hook snapshot (spec §3.6: pre over snapshot, post over the
            //      SAME pre-approved set, in reverse) ----
            HookOrderRecord hookOrder = GetHookOrder(accountId);
            VerifyHookProofsAgainstSnapshot(op[OpHookProofs], hookOrder.HookIds);

            SetExecutionLock(accountId);
            MarkUserOperationInFlight();
            bool ownsContext;
            ApplicationContextRecord ctx = OpenApplicationContext(accountId, out ownsContext);
            try
            {
                // ---- Phase: Validation ----
                BigInteger[] approvedMembers = new BigInteger[0];
                if (policy != null)
                {
                    // Threshold policy: every member is invoked under the
                    // shared parent validation budget; approval receipts are
                    // kept in core-local invocation state.
                    BigInteger[] members = policy.MemberIds;
                    approvedMembers = new BigInteger[members.Length];
                    int approvals = 0;
                    for (int i = 0; i < members.Length; i++)
                    {
                        ModuleInstance memberModule = RequireModuleInstance(accountId, members[i]);
                        ExecutionEngine.Assert(memberModule.ModuleType == ModuleTypeCodeValidator,
                            ErrorValidatorNotFound);
                        bool memberAccepted = CallValidatorValidateUserOp(
                            accountId, ctx, members[i], memberModule, op, operationDigest);
                        if (memberAccepted)
                        {
                            approvedMembers[approvals] = members[i];
                            approvals++;
                        }
                    }
                    ExecutionEngine.Assert(approvals >= policy.Threshold, ErrorValidationRejected);
                }
                else if (validatorModule != null)
                {
                    bool accepted = CallValidatorValidateUserOp(
                        accountId, ctx, validatorId, validatorModule, op, operationDigest);
                    ExecutionEngine.Assert(accepted, ErrorValidationRejected);
                }
                else
                {
                    // Built-in route (validatorId = 0): §8 profile over the
                    // operation digest; no module callback exists.
                    ExecutionEngine.Assert(
                        VerifyBuiltInOperationSignature(accountId, operationDigest, (ByteString)op[OpSignature]),
                        ErrorValidationRejected);
                }

                // ---- Nonce consumption (all validations passed) ----
                // Validation is closed before any core write: no module holds
                // a writer phase while the nonce is consumed.
                EnterModulePhase(accountId, ctx, PhaseNone, BigInteger.Zero);
                ConsumeOperationNonce(accountId, channel, namespaceDigest, sequence);

                // Deep-copied arguments: a hook or callback must never mutate
                // the authenticated operation content the target executes.
                object[] executionArgs = CloneOperationArguments((object[])op[OpArgs]);

                // ---- Phase: HookPre (snapshot order) ----
                // hookData is invocation-local: slot i belongs to the hook
                // instance at snapshot position i and is handed back only to
                // that same instance's postCheck.
                int hookCount = hookOrder.HookIds.Length;
                ByteString[] hookData = new ByteString[hookCount];
                for (int i = 0; i < hookCount; i++)
                {
                    BigInteger hookId = hookOrder.HookIds[i];
                    ModuleInstance hookModule = RequireModuleInstance(accountId, hookId);
                    hookData[i] = CallHookPreCheck(accountId, ctx, hookId, hookModule, op);
                }

                // ---- Phase: TargetDispatch (all module authorization closed;
                //      the only open authorization is the target call itself) ----
                EnterModulePhase(accountId, ctx, PhaseTargetDispatch, BigInteger.Zero);
                // Bind the 0x02 verify context so the dispatched target can resolve
                // CheckWitness(accountId) / core.Verify back to THIS operation only
                // (application-trigger path; F-1: no admin-configured scope target
                // exists anymore — only the actual dispatched target, or NEO/GAS
                // when the operation itself targets that native asset).
                SetVerifyContext(accountId, target);
                object result = Contract.Call(target, (string)method, CallFlags.All, executionArgs);
                ClearVerifyContext(accountId);

                // ---- Phase: HookPost (reverse snapshot order, original set) ----
                for (int i = hookCount - 1; i >= 0; i--)
                {
                    BigInteger hookId = hookOrder.HookIds[i];
                    ModuleInstance hookModule = RequireModuleInstance(accountId, hookId);
                    CallHookPostCheck(accountId, ctx, hookId, hookModule, op, result, hookData[i]);
                }

                // ---- Phase: Completion (approved routing subject only) ----
                if (policy != null)
                {
                    for (int i = 0; i < approvedMembers.Length; i++)
                    {
                        if (approvedMembers[i] == 0) break;
                        ModuleInstance memberModule = RequireModuleInstance(accountId, approvedMembers[i]);
                        CallValidatorOnUserOpComplete(accountId, ctx, approvedMembers[i], memberModule, op, result);
                    }
                }
                else if (validatorModule != null)
                {
                    CallValidatorOnUserOpComplete(accountId, ctx, validatorId, validatorModule, op, result);
                }
                EnterModulePhase(accountId, ctx, PhaseNone, BigInteger.Zero);

                OnUserOpExecuted(accountId, target, (string)method, nonce);
                return result;
            }
            finally
            {
                ClearVerifyContext(accountId);
                if (ownsContext)
                {
                    EndApplicationContext(accountId);
                }
                else
                {
                    // Enclosing envelope: keep the row and its gas pools alive,
                    // close only the phase writer.
                    ctx.Phase = PhaseNone;
                    ctx.ActiveModuleId = BigInteger.Zero;
                    SaveApplicationContext(accountId, ctx);
                }
                ClearExecutionLock(accountId);
                UnmarkUserOperationInFlight();
            }
        }

        /// <summary>
        /// Batch execution: ≤ 32 operations, one atomic transaction — a fault
        /// on any operation reverts the whole envelope.
        /// </summary>
        public static object[] executeUserOps(UInt160 accountId, object[] operations)
        {
            ValidateAccountId(accountId);
            ExecutionEngine.Assert(operations != null && operations.Length > 0, ErrorOperationMalformed);
            ExecutionEngine.Assert(operations!.Length <= MaxOperationsPerEnvelope, ErrorModuleLimitBatch);
            byte[] serialized = (byte[])StdLib.Serialize(operations);
            ExecutionEngine.Assert(serialized.Length <= EnvelopeEncodedSizeMax, ErrorOperationMalformed);

            // One envelope, one budget: the application context (and therefore
            // the validation / hook / completion gas pools) is opened exactly
            // once here and inherited by every operation in the batch. A batch
            // must never reset the aggregate budget per operation.
            ApplicationContextRecord envelope;
            bool ownsEnvelope;
            envelope = OpenApplicationContext(accountId, out ownsEnvelope);
            object[] results = new object[operations!.Length];
            try
            {
                for (int i = 0; i < operations.Length; i++)
                {
                    results[i] = ExecuteUserOpCore(accountId, operations[i]);
                }
            }
            finally
            {
                if (ownsEnvelope)
                {
                    EndApplicationContext(accountId);
                }
                else
                {
                    envelope.Phase = PhaseNone;
                    envelope.ActiveModuleId = BigInteger.Zero;
                    SaveApplicationContext(accountId, envelope);
                }
            }
            return results;
        }

        // ========================================================================
        // 7. Shared helpers (kept from the legacy kernel)
        // ========================================================================

        private static object[] CloneOperationArguments(object[] args)
        {
            return (object[])StdLib.Deserialize(StdLib.Serialize(args));
        }

        // Callback modules are extension points. Pass a serialized copy of the
        // target result so a post hook/validator cannot rewrite the value returned
        // to the caller or mutate an object later consumed by settlement logic.
        private static object? CloneCallbackValue(object? value)
        {
            return value == null ? null : StdLib.Deserialize(StdLib.Serialize(value));
        }

        private static void ValidateAccountId(UInt160 accountId)
        {
            ExecutionEngine.Assert(accountId != null && accountId != UInt160.Zero && accountId.IsValid, "Account id required");
        }

        /// <summary>
        /// Refuses operations whose target is a native contract that would be changed by the
        /// core's own identity.
        /// </summary>
        /// <remarks>
        /// One core contract backs every virtual account, so a target always observes the same
        /// <c>Runtime.CallingScriptHash</c> regardless of which account authorized the operation.
        /// Protocol-management contracts act on their caller: <c>ContractManagement.update</c>
        /// upgrades the calling contract and <c>destroy</c> removes it, while <c>RoleManagement</c>
        /// and <c>PolicyContract</c> grant roles and network-wide policy.
        /// Routing an operation to them would therefore let any single account owner rewrite or
        /// destroy the shared core, or act as the core in protocol governance. Asset and utility
        /// natives stay reachable because an account legitimately transfers NEO and GAS and reads
        /// through <c>StdLib</c>/<c>CryptoLib</c>; those contracts never mutate state on their
        /// caller's behalf.
        /// The core itself remains a legitimate target: its entry points are individually
        /// defended — the per-account execution lock rejects re-entrant execution, module
        /// configuration entries assert an idle configuration context, ownership and admin
        /// entries are witness-gated, and escrow entries require the recorded escrow market as
        /// their caller, which a core-routed operation is not. Callees that authorize on the
        /// core's calling identity close their own deputy window by querying
        /// <see cref="IsUserOpExecutionActive"/> or the core's escrow state, exactly as the
        /// paymaster settlement and the market listing retirement do.
        /// </remarks>
        private static void AssertTargetIsNotProtocolOwned(UInt160 target)
        {
            ExecutionEngine.Assert(target != ContractManagement.Hash,
                "Operation target cannot be ContractManagement");
            ExecutionEngine.Assert(target != RoleManagement.Hash,
                "Operation target cannot be RoleManagement");
            ExecutionEngine.Assert(target != Policy.Hash,
                "Operation target cannot be Policy");
            ExecutionEngine.Assert(target != Ledger.Hash,
                "Operation target cannot be Ledger");
            ExecutionEngine.Assert(target != Oracle.Hash,
                "Operation target cannot be Oracle");
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
