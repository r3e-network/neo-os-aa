using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;

namespace SmartAccount
{
    public partial class SmartAccount
    {
        // ========================================================================
        // 1. Data structures (module protocol v4 + legacy migration input)
        // ========================================================================

        // Account lifecycle status values stored in AccountControl.Status and
        // MigrationStateRecord.Status.
        private const byte AccountStatusActive = 0;
        private const byte AccountStatusFrozen = 1;
        private const byte AccountStatusMigrationRequired = 2;

        // Writer phases recorded in the 0x58 application context (F-7 phase gates).
        // A module callback is only authorized while the phase recorded here is the
        // one that callback belongs to, for the exact active module instance.
        private const byte PhaseNone = 0;
        private const byte PhaseValidation = 1;
        private const byte PhaseHookPre = 2;
        private const byte PhaseTargetDispatch = 3;
        private const byte PhaseHookPost = 4;
        private const byte PhaseCompletion = 5;
        private const byte PhaseConfiguration = 6;
        private const byte PhaseCleanup = 7;

        // Configuration action codes (spec §9): every action is a positional VM
        // array whose first element is one of these codes. A multi-action intent
        // is one atomic, 24h-timelocked proposal — never a timelock bypass.
        private const int ActionInstallModule = 1;
        private const int ActionUninstallModule = 2;
        private const int ActionConfigureModule = 3;
        private const int ActionSetHookOrder = 4;
        private const int ActionSetDefaultPolicy = 5;
        private const int ActionRebindModuleCode = 6;
        private const int ActionSetThresholdPolicy = 7;
        private const int ActionSetRecoveryPolicy = 8;
        private const int ActionSetMessageSubjects = 9;
        private const int ActionMigrateAccount = 10;

        // ------------------------------------------------------------------------
        // Legacy protocol (<4) record. Kept ONLY as migration input / historical
        // evidence (spec §7.4): new state is written under 0x51 and new code never
        // routes through the old Verifier/HookId pointers. A dedicated legacy
        // decoder in SmartAccount.Migration.cs is the only consumer of the two
        // pointer fields.
        // ------------------------------------------------------------------------
        public class AccountState
        {
            public UInt160 Verifier = UInt160.Zero;
            public UInt160 HookId = UInt160.Zero;
            public UInt160 BackupOwner = UInt160.Zero;
            public uint EscapeTimelock;
            public BigInteger EscapeTriggeredAt;
        }

        /// <summary>
        /// v4 account control metadata (spec §7.2), stored under 0x51 + accountId.
        /// One record per account; created at v4 registration, legacy-account
        /// materialization (freeze / recovery / migration intent) or migration import.
        /// </summary>
        public class AccountControl
        {
            // AccountStatusActive / AccountStatusFrozen / AccountStatusMigrationRequired.
            public byte Status;
            // Custody — the witness-bearing controller of configuration and recovery.
            public UInt160 Custody = UInt160.Zero;
            // Optional recovery authority (zero = custody self-rescue only).
            public UInt160 RecoveryAuthority = UInt160.Zero;
            public BigInteger AuthorityEpoch;
            public BigInteger ConfigurationNonce;
            // Shared monotonic allocator for module ids and threshold policy ids.
            public BigInteger NextModuleId;
            public BigInteger NextIntentId;
            // Built-in (validatorId = 0) authorization switches.
            public bool DefaultOperationAuthorization;
            public bool DefaultMessageAuthorization;
            // Per-account recovery timelock in milliseconds (7–90 days).
            public BigInteger RecoveryTimelockMs;
            public BigInteger HookOrderRevision;
            public BigInteger DefaultPolicyRevision;
            // Bumped on every custody/control-epoch-relevant change (market binding).
            public BigInteger ControlRevision;
            // Legacy permanent owner-only flag: survives migration, never cleared.
            public bool OwnerOnlyRecovery;
        }

        /// <summary>
        /// v4 module instance record (spec §7.2/§7.3), stored under
        /// 0x52 + accountId + moduleId[8 BE].
        /// </summary>
        public class ModuleInstance
        {
            // ModuleTypeCodeValidator (1) or ModuleTypeCodeHook (4).
            public byte ModuleType;
            public UInt160 ContractHash = UInt160.Zero;
            // Code binding (spec §7.3): contractId blocks destroy-and-redeploy,
            // updateCounter catches manifest-only updates, the NEF hash pins code
            // and the profile digest pins the declared capability/interface shape.
            public BigInteger ContractId;
            public BigInteger UpdateCounter;
            public ByteString NefSha256 = (ByteString)new byte[0];
            public ByteString ProfileSha256 = (ByteString)new byte[0];
            public BigInteger ModuleRevision;
            public BigInteger CredentialGeneration;
            // Declared capability profile (installer-declared until modules ship
            // canonical profile JSON — TODO(26): verify against module profile).
            public bool InstanceIsolation;
            public bool MessageCapability;
            public bool ThresholdMemberEligible;
        }

        /// <summary>Core-owned hook order (spec §3), stored under 0x54 + accountId.</summary>
        public class HookOrderRecord
        {
            // Ordered installed hook module ids; preCheck ascending, postCheck
            // reverse over the same snapshot. Length ≤ MaxHookModuleInstances.
            public BigInteger[] HookIds = new BigInteger[0];
            public BigInteger Revision;
        }

        /// <summary>Core-owned threshold policy (spec §3.5), stored under 0x5B + accountId + policyId[8 BE].</summary>
        public class ThresholdPolicyRecord
        {
            public BigInteger Threshold;
            // Installed scalar-validator module ids; members are never independently routable.
            public BigInteger[] MemberIds = new BigInteger[0];
            public bool Active;
            // Bumped on every rewrite so reshaped policies kill their old
            // nonce channels and signature bindings.
            public BigInteger CredentialGeneration;
        }

        /// <summary>Configuration intent (spec §10), stored under 0x55 + accountId + intentId[8 BE].</summary>
        public class ConfigurationIntentRecord
        {
            public BigInteger IntentId;
            public BigInteger ProposedAt;
            public BigInteger MatureAt;
            public BigInteger ExpiresAt;
            public BigInteger AuthorityEpoch;
            public ByteString ActionDigest = (ByteString)new byte[0];
            // The exact action arrays; confirmation re-binds them by digest.
            public object[] Actions = new object[0];
            // Bounded resource read/write set: one key per action (built by
            // ResourceKeysForAction in SmartAccount.Modules.cs — "module:<contractHash>",
            // "moduleId:<id>", "policy:<id>", "hookOrder", "defaultPolicy",
            // "recovery", "messageSubjects", "migration").
            public ByteString[] Resources = new ByteString[0];
        }

        /// <summary>Built-in message signer subjects (spec §8), stored under 0x57 + accountId.</summary>
        public class MessageSubjectRecord
        {
            // SHA256(canonical P-256 verification script) per authorized subject,
            // ≤ MessageSubjectKeysMax entries, pairwise distinct.
            public ByteString[] Subjects = new ByteString[0];
            public BigInteger Threshold;
            public BigInteger SubjectRevision;
        }

        /// <summary>
        /// Application callback/execution context (spec §7.1), stored under
        /// 0x58 + accountId while the core drives an execution or configuration
        /// for that account. Carries the F-7 phase gates and the transaction-scoped
        /// aggregate gas budget counters.
        /// </summary>
        public class ApplicationContextRecord
        {
            public byte Phase;
            // moduleId of the module instance the current callback is addressed to.
            public BigInteger ActiveModuleId;
            // Remaining validation-aggregate budget (datoshi) for this transaction.
            public BigInteger ValidationBudgetRemaining;
            // Remaining validator-completion aggregate budget (datoshi).
            public BigInteger CompletionBudgetRemaining;
            // Remaining hook aggregate budget (datoshi). Hook consumption is a
            // separate pool on purpose: a preCheck/postCheck overrun must never
            // starve (or be paid for by) signature validation.
            public BigInteger HookBudgetRemaining;
        }

        /// <summary>Core recovery / emergency invalidation record (spec §7.5), stored under 0x59 + accountId.</summary>
        public class CoreRecoveryRecord
        {
            public BigInteger InitiatedAt;
            public BigInteger MatureAt;
            // authorityEpoch captured at initiation; execution requires it to still match.
            public BigInteger AuthorityEpochAtInit;
            // Approved new custody (zero = keep current custody).
            public UInt160 NewCustody = UInt160.Zero;
        }

        /// <summary>Migration state (spec §14), stored under 0x5A + accountId.</summary>
        public class MigrationStateRecord
        {
            // 0 = none, 1 = required (fail-closed), 2 = imported.
            public byte Status;
            public ByteString ManifestDigest = (ByteString)new byte[0];
            public string Classification = string.Empty;
            public BigInteger LegacyModuleCount;
            // Explicit invalidation declaration for retired 0x12/0x1C rows.
            public bool LegacyScopeInvalidated;
            public BigInteger ImportedAt;
        }

        /// <summary>Market lock ↔ control-epoch ↔ listing binding (spec §7.5), stored under 0x5D + accountId.</summary>
        public class MarketControlBinding
        {
            public UInt160 Market = UInt160.Zero;
            public BigInteger ListingId;
            // controlRevision of the account at escrow entry; a mismatch voids the lock.
            public BigInteger ControlEpoch;
        }
    }
}
