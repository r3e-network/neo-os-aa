using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    public partial class SmartAccount
    {
        // ========================================================================
        // 5. N3 Magic: Native Witness Verification Support
        // ========================================================================

        // This section enables Neo's native witness/verification script system to work
        // seamlessly with Smart Accounts, making Neo's SA fundamentally different from
        // Ethereum's ERC-4337 approach.
        //
        // F-1 (audit fix, protocol v4): the retired per-account scope-target grant
        // (prefix 0x1C, admin-configured) is DELETED. The proxy witness
        // now authorizes ONLY the core call path: the witness rule must be exactly
        // one Allow rule with condition CalledByContract(core). An admin can no
        // longer bless an arbitrary target contract to pull witness authorization
        // from the account, and a target rejected by the account's policy cannot
        // come back through a target-side CheckWitness.

        /// <summary>
        /// Bridge that enables native Neo verification scripts to work with SA.
        /// </summary>
        /// <remarks>
        /// <para>
        /// <b>How it works:</b>
        /// <list type="bullet">
        ///   <item>During executeUserOp the core stores the active op target (0x02)</item>
        ///   <item>The target contract can call CheckWitness(accountId) to verify authorization</item>
        ///   <item>Neo's runtime checks if the transaction includes a valid witness for accountId</item>
        /// </list>
        /// </para>
        /// <para>
        /// <b>Authorization surface (F-1):</b> the proxy witness only ever
        /// authorizes the core call path. In the Verification trigger the whole
        /// transaction must be a single bound <c>executeUserOp</c>/<c>executeUserOps</c>
        /// call on this core, and the signer's witness rule must be exactly
        /// CalledByContract(this core). In the Application trigger the caller must
        /// be the currently dispatched operation target (or the NEO/GAS native
        /// contract when the operation itself targets that asset). No
        /// admin-configured target forwarding exists anymore.
        /// </para>
        /// </remarks>
        /// <param name="accountId">The SA account identifier to verify</param>
        /// <returns>True if the calling contract is authorized for this account's current execution</returns>
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
                // Audit SEV-0: outside an active user operation there is nothing to
                // bind a caller to; the signer-shape fallback must not stand in for
                // an execution context in the application phase.
                if (expectedTarget == null) return false;
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

        // -----------------------------------------------------------------------
        // Audit note — outbound permission convergence (#25, design report 6.12):
        //
        // The core performs an arbitrary-target dispatch for executed operations
        // (Contract.Call(target, method, CallFlags.All, args) in Execution.cs).
        // This is the ONE intentional wildcard-equivalent surface of the core: it
        // is the operation pipeline itself, and it is gated by the 13-field
        // envelope, explicit validator routing, the full §3.6 phase pipeline and
        // AssertTargetIsNotProtocolOwned. This authorization NEVER extends to
        // module callbacks: every module call in the adaptation layer
        // (Modules.cs §12) targets the specific module instance's contract hash
        // recorded in 0x52 — no plugin or service call ever uses a wildcard
        // target, and the wildcard-equivalent dispatch above never propagates to
        // descendants (module callbacks during an operation are addressed to the
        // recorded instances only, and the 0x58 phase gates keep them mutually
        // exclusive with the target dispatch authorization).
        // -----------------------------------------------------------------------

        // ------------------------------------------------------------------------
        // Verification-trigger proxy witness binding (audit SEV-0 + F-1)
        // ------------------------------------------------------------------------
        //
        // The proxy verification script (`PUSH accountId; CALL core.verify`) carries
        // no secret: the witness has an empty invocation script and nothing to sign.
        // The witness is bound to the account's own execution: the transaction
        // script must consist solely of data pushes followed by exactly one
        // `core.executeUserOp(accountId, op)` (or `executeUserOps(accountId, ops)`)
        // call for THIS accountId, the proxy must not be the fee-paying sender, and
        // the signer's witness rule must authorize exactly the core call path
        // (CalledByContract(core), F-1). Because the whole script is that single
        // call, the operation's signature — verified by the account's validator or
        // built-in P-256 profile inside executeUserOp — is the only thing that can
        // make the transaction succeed; any other script shape is rejected at
        // verification.

        private static readonly byte[] ScriptPushData20 = new byte[] { 0x0C, 0x14 };
        private static readonly byte[] ScriptPush2Pack = new byte[] { 0x12, 0xC0 };
        // PUSHDATA1 13 "executeUserOp"
        private static readonly byte[] ScriptPushExecuteUserOp = new byte[]
        {
            0x0C, 0x0D, 0x65, 0x78, 0x65, 0x63, 0x75, 0x74, 0x65, 0x55, 0x73, 0x65, 0x72, 0x4F, 0x70
        };
        // PUSHDATA1 14 "executeUserOps"
        private static readonly byte[] ScriptPushExecuteUserOps = new byte[]
        {
            0x0C, 0x0E, 0x65, 0x78, 0x65, 0x63, 0x75, 0x74, 0x65, 0x55, 0x73, 0x65, 0x72, 0x4F, 0x70, 0x73
        };
        // SYSCALL System.Contract.Call
        private static readonly byte[] ScriptSyscallContractCall = new byte[] { 0x41, 0x62, 0x7D, 0x5B, 0x52 };

        private static bool VerifyScopedTransactionSigner(UInt160 accountId)
        {
            UInt160 proxy = Runtime.CallingScriptHash;
            if (!TransactionIsBoundToAccountExecution(accountId, proxy)) return false;

            Signer[] signers = Runtime.CurrentSigners();
            for (int i = 0; i < signers.Length; i++)
            {
                // Only the calling verification script's own signer can grant
                // its scope. Another signer must not bless a Global proxy.
                if (signers[i].Account == proxy &&
                    HasCoreOnlyWitnessRule(signers[i], Runtime.ExecutingScriptHash))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// True when the current transaction's script is exactly one
        /// <c>executeUserOp</c>/<c>executeUserOps</c> call on this core for
        /// <paramref name="accountId"/>, preceded only by data pushes, and the proxy
        /// is not the fee payer.
        /// </summary>
        private static bool TransactionIsBoundToAccountExecution(UInt160 accountId, UInt160 proxy)
        {
            Transaction tx = Runtime.Transaction;
            if (tx == null) return false;
            // The proxy witness never pays fees: a shaped-but-faulting transaction
            // must not be able to burn the account's GAS as system fee.
            if (tx.Sender == proxy) return false;

            byte[] script = (byte[])tx.Script;
            if (script == null || script.Length == 0) return false;

            return ScriptIsSingleExecuteCall(script, accountId, ScriptPushExecuteUserOp)
                || ScriptIsSingleExecuteCall(script, accountId, ScriptPushExecuteUserOps);
        }

        private static bool ScriptIsSingleExecuteCall(byte[] script, UInt160 accountId, byte[] methodPush)
        {
            // tail = PUSHDATA1 20 accountId | PUSH2 PACK | PUSH<flags> | PUSHDATA1 n method | PUSHDATA1 20 core | SYSCALL
            int accountPushLength = 2 + 20;
            int flagsLength = 1;
            int corePushLength = 2 + 20;
            int tailLength = accountPushLength + 2 + flagsLength + methodPush.Length + corePushLength + ScriptSyscallContractCall.Length;
            if (script.Length < tailLength) return false;

            int tailStart = script.Length - tailLength;
            int cursor = tailStart;

            if ((ByteString)Helper.Range(script, cursor, 2) != (ByteString)ScriptPushData20) return false;
            cursor += 2;
            if ((ByteString)Helper.Range(script, cursor, 20) != (ByteString)(byte[])accountId) return false;
            cursor += 20;
            if ((ByteString)Helper.Range(script, cursor, 2) != (ByteString)ScriptPush2Pack) return false;
            cursor += 2;
            // CallFlags is a small integer push (PUSH0..PUSH15). Any subset of flags is
            // acceptable: weaker flags only make the call fail, never widen it.
            byte flags = script[cursor];
            if (flags < 0x10 || flags > 0x1F) return false;
            cursor += 1;
            if ((ByteString)Helper.Range(script, cursor, methodPush.Length) != (ByteString)methodPush) return false;
            cursor += methodPush.Length;
            if ((ByteString)Helper.Range(script, cursor, 2) != (ByteString)ScriptPushData20) return false;
            cursor += 2;
            if ((ByteString)Helper.Range(script, cursor, 20) != (ByteString)(byte[])Runtime.ExecutingScriptHash) return false;
            cursor += 20;
            if ((ByteString)Helper.Range(script, cursor, ScriptSyscallContractCall.Length) != (ByteString)ScriptSyscallContractCall) return false;

            // Everything before the tail must be data pushes that land exactly on the
            // tail boundary; no other calls, jumps, or try/catch may precede the call.
            return ScriptPrefixIsDataPushes(script, tailStart);
        }

        private static bool ScriptPrefixIsDataPushes(byte[] script, int end)
        {
            int i = 0;
            while (i < end)
            {
                int size = DataPushInstructionSize(script, i, end);
                if (size <= 0) return false;
                i += size;
            }
            return i == end;
        }

        /// <summary>
        /// Size of the instruction at <paramref name="index"/> if it is a pure
        /// stack-data instruction (constant push, PACK/PACKSTRUCT/PACKMAP, empty
        /// array/struct/map, CONVERT); 0 otherwise or if it overruns <paramref name="end"/>.
        /// </summary>
        private static int DataPushInstructionSize(byte[] script, int index, int end)
        {
            byte op = script[index];
            int size;
            if (op == 0x00) size = 2;                       // PUSHINT8
            else if (op == 0x01) size = 3;                  // PUSHINT16
            else if (op == 0x02) size = 5;                  // PUSHINT32
            else if (op == 0x03) size = 9;                  // PUSHINT64
            else if (op == 0x04) size = 17;                 // PUSHINT128
            else if (op == 0x05) size = 33;                 // PUSHINT256
            else if (op == 0x08 || op == 0x09 || op == 0x0B) size = 1; // PUSHT PUSHF PUSHNULL
            else if (op == 0x0C)                            // PUSHDATA1
            {
                if (index + 1 >= end) return 0;
                size = 2 + script[index + 1];
            }
            else if (op == 0x0D)                            // PUSHDATA2
            {
                if (index + 2 >= end) return 0;
                size = 3 + script[index + 1] + script[index + 2] * 256;
            }
            else if (op == 0x0E)                            // PUSHDATA4
            {
                if (index + 4 >= end) return 0;
                size = 5 + script[index + 1] + script[index + 2] * 256
                    + script[index + 3] * 65536 + script[index + 4] * 16777216;
            }
            else if (op >= 0x0F && op <= 0x20) size = 1;    // PUSHM1, PUSH0..PUSH16
            else if (op == 0xBE || op == 0xBF || op == 0xC0) size = 1; // PACKMAP PACKSTRUCT PACK
            else if (op == 0xC2 || op == 0xC5 || op == 0xC8) size = 1; // NEWARRAY0 NEWSTRUCT0 NEWMAP
            else if (op == 0xDB) size = 2;                  // CONVERT <type>
            else return 0;

            if (index + size > end) return 0;
            return size;
        }

        /// <summary>
        /// F-1 witness rule shape: exactly ONE Allow rule whose condition is
        /// exactly CalledByContract(core). The retired Or(CalledByContract(core),
        /// CalledByContract(&lt;admin-configured target&gt;)) structure — which let an
        /// admin bless arbitrary target forwarding and let policy-rejected targets
        /// come back through a target-side CheckWitness — is deleted.
        /// </summary>
        private static bool HasCoreOnlyWitnessRule(Signer signer, UInt160 coreContract)
        {
            if (signer.Scopes != WitnessScope.WitnessRules) return false;
            if (signer.Rules == null || signer.Rules.Length != 1) return false;
            WitnessRule rule = signer.Rules[0];
            if (rule.Action != WitnessRuleAction.Allow) return false;
            if (rule.Condition == null) return false;
            if (rule.Condition.Type != WitnessConditionType.CalledByContract) return false;
            CalledByContractCondition calledBy = (CalledByContractCondition)rule.Condition;
            return calledBy.Hash == coreContract;
        }

        // ========================================================================
        // F-7 phase-exact module authorization adapters
        // ========================================================================
        //
        // The legacy stage-blind canConfigureVerifier / canConfigureHook /
        // canExecuteVerifier / canExecuteHook entry points — which trusted a
        // root/child caller parameter chain and an open per-account context row —
        // are replaced by thin adapters over the 0x58 phase-exact authorization
        // (getAuthorizedModuleId): a plugin callback is authorized only while the
        // recorded writer phase matches AND the caller IS the contract of the
        // recorded active module instance. The stage-blind caller parameters are
        // accepted (legacy ABI) but ignored for authorization.
        //
        // TODO(26): remove these adapters when the plugin batch migrates to
        // getAuthorizedModuleId(accountId, phase); the v4 forward ABI is
        // [Safe] BigInteger getAuthorizedModuleId(UInt160 accountId, byte phase).

        /// <summary>
        /// Legacy adapter: a module may write its configuration only while it is
        /// the active module of the PhaseConfiguration writer phase (inside a
        /// confirmed configuration-intent callback or module lifecycle callback).
        /// </summary>
        [Safe]
        public static bool CanConfigureVerifier(UInt160 accountId, UInt160 verifierContract)
        {
            return IsModulePhaseCaller(accountId, verifierContract, PhaseConfiguration);
        }

        /// <summary>Legacy adapter, hook flavor of <see cref="CanConfigureVerifier"/>.</summary>
        [Safe]
        public static bool CanConfigureHook(UInt160 accountId, UInt160 hookContract)
        {
            return IsModulePhaseCaller(accountId, hookContract, PhaseConfiguration);
        }

        /// <summary>
        /// Read-only validation-phase adapter: while the core runs the
        /// PhaseValidation writer phase it calls exactly one validator with
        /// <c>CallFlags.ReadOnly</c>. A validator that checks its caller before
        /// verifying uses this entry instead of the completion-phase one, so a
        /// validation callback is authorized without granting any write right.
        /// </summary>
        [Safe]
        public static bool CanValidateVerifier(UInt160 accountId, UInt160 verifierContract)
        {
            return IsModulePhaseCaller(accountId, verifierContract, PhaseValidation);
        }

        /// <summary>
        /// Legacy adapter: a validator may apply post-execution effects only in
        /// the PhaseCompletion writer phase. The stage-blind
        /// <paramref name="callerContract"/> parameter is ignored: a nested
        /// contract claiming to be the "root verifier" grants nothing anymore.
        /// </summary>
        [Safe]
        public static bool CanExecuteVerifier(UInt160 accountId, UInt160 callerContract, UInt160 verifierContract)
        {
            return IsModulePhaseCaller(accountId, verifierContract, PhaseCompletion);
        }

        /// <summary>
        /// Legacy adapter: a hook may run only while it is the active module of
        /// the PhaseHookPre or PhaseHookPost writer phase. The stage-blind
        /// <paramref name="callerContract"/> parameter is ignored.
        /// </summary>
        [Safe]
        public static bool CanExecuteHook(UInt160 accountId, UInt160 callerContract, UInt160 hookContract)
        {
            return IsModulePhaseCaller(accountId, hookContract, PhaseHookPre)
                || IsModulePhaseCaller(accountId, hookContract, PhaseHookPost);
        }

        /// <summary>
        /// Phase-exact authorization core (F-7): the caller must self-declare the
        /// module contract it speaks for (matching its own calling script hash)
        /// and be the recorded active module instance of the exact writer phase.
        /// </summary>
        private static bool IsModulePhaseCaller(UInt160 accountId, UInt160 selfDeclaredContract, byte phase)
        {
            if (accountId == null || accountId == UInt160.Zero) return false;
            if (selfDeclaredContract == null || selfDeclaredContract == UInt160.Zero) return false;
            // The self-declared contract must be the actual caller; the stage-blind
            // root/child chain is not consulted at all.
            if (selfDeclaredContract != Runtime.CallingScriptHash) return false;
            if (HasOwnerOnlyRecovery(accountId)) return false;
            return getAuthorizedModuleId(accountId, phase) >= 0;
        }
    }
}
