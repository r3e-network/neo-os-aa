using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Modules
{
    /// <summary>
    /// §11 configuration-governance module (skeleton).
    ///
    /// The minimal native core executes four things: registration, freeze,
    /// unfreeze and module administration. Everything a change-control policy
    /// adds on top of that — a proposal, a maturity window, a confirmation that
    /// must carry the same actions the proposal named — is this module's state,
    /// not the core's.
    ///
    /// The module is deliberately dull: an intent is a record, a digest and a
    /// deadline. <see cref="ConfirmConfiguration"/> is the only writer that
    /// reaches the core or a target module, and it reaches it through the
    /// landing paths of spec §11.5 Table 19 —
    /// <c>installModule</c>/<c>removeModule</c>/<c>unfreezeAccount</c>, the
    /// target instance's own <c>configure</c> callback, the hook
    /// orchestrator's <c>setHookOrder</c>, the core's
    /// <c>setRecoveryPolicy</c>/<c>setBuiltinAuthorization</c> restricted
    /// entries and the §13/§15 module writes — so the account's own
    /// module-administration authority decides whether the transition may
    /// happen at all.
    ///
    /// The module is a <b>validator-type</b> instance (spec §11.1: installed with
    /// module type code 1 and registered as the account's governance-authorized
    /// module): it uses this type for administration, never for operation approval. The core admission gate therefore requires the
    /// <c>getModuleProfile</c> reader plus the
    /// <c>validateUserOp</c>/<c>onUserOpComplete</c> routing pair of the module
    /// ABI, and this contract exposes all three.
    ///
    /// Storage is per account, so two accounts sharing this deployment never
    /// see each other's intents:
    ///   <c>0x01 ‖ accountId ‖ intentId(8 BE)</c> → serialized intent record
    ///   <c>0x02 ‖ accountId</c>                  → last allocated intent id
    ///   <c>0x03 ‖ accountId</c>                  → last recorded completion
    /// </summary>
    [DisplayName("GovernanceModule")]
    [ContractPermission("*", "getAccount")]
    [ContractPermission("*", "getModules")]
    [ContractPermission("*", "getModule")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModuleProfile")]
    [ContractPermission("*", "installModule")]
    [ContractPermission("*", "removeModule")]
    [ContractPermission("*", "unfreezeAccount")]
    [ContractPermission("*", "setRecoveryPolicy")]
    [ContractPermission("*", "setBuiltinAuthorization")]
    [ContractPermission("*", "configure")]
    [ContractPermission("*", "setHookOrder")]
    [ContractPermission("*", "setThresholdPolicy")]
    [ContractPermission("*", "updateMessageSubject")]
    [ManifestExtra("Description", "Configuration-intent governance module (spec §11)")]
    public class GovernanceModule : SmartContract
    {
        // Canonical module capability profile (docs/SA-MODULE-PROTOCOL.md §12):
        // keys sorted, no whitespace, no trailing newline. The core hashes these
        // exact bytes into the install-time profile digest. The module is a
        // validator (spec §11.1) that owns no message domain, is not a threshold
        // member and composes nothing; its policy state is keyed by account, so a
        // second instance of the same contract on one account is refused by the
        // core (instanceIsolation false).
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"GovernanceModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Intent = new byte[] { 0x01 };
        private static readonly byte[] Prefix_IntentCount = new byte[] { 0x02 };
        private static readonly byte[] Prefix_Completion = new byte[] { 0x03 };

        /// <summary>§11: a configuration intent matures 24 hours after it is proposed.</summary>
        private const long ConfigurationMaturityMs = 24L * 60 * 60 * 1000;

        /// <summary>§11 R-11-03: a matured intent stays confirmable for 7 days, then expires.</summary>
        private const long ConfigurationExpiryMs = 7L * 24 * 60 * 60 * 1000;

        /// <summary>§11 R-11-04: at most 16 pending intents per account.</summary>
        private const int MaxPendingIntents = 16;

        /// <summary>§11 R-11-04: at most 16 actions in one intent.</summary>
        private const int MaxActionsPerIntent = 16;

        /// <summary>§11 R-11-04: at most 16 declared read-set entries per intent.</summary>
        private const int MaxReadSetEntries = 16;

        /// <summary>§11 Table 16, action 4: a hook order lists at most 8 hook ids.</summary>
        private const int MaxHookOrderEntries = 8;

        /// <summary>§11 Table 16, action 9: a subject roster lists at most 16 subjects.</summary>
        private const int MaxSubjectEntries = 16;

        /// <summary>§15 R-15-02: a threshold policy has 1—10 members.</summary>
        private const int MaxPolicyMembers = 10;

        /// <summary>§11 Table 16: every readSet entry is a ByteString of at most 64 bytes.</summary>
        private const int MaxResourceKeyLength = 64;

        /// <summary>§11 Table 16, action 10: a migration classification is at most 64 bytes of UTF-8.</summary>
        private const int MaxClassificationLength = 64;

        /// <summary>§11 Table 16, action 1: an install payload carries at most 64 initData items.</summary>
        private const int MaxInitDataEntries = 64;

        private const string KindConfigure = "configure";
        private const string KindUnfreeze = "unfreeze";

        // R-11-05 fixed resource labels: the manuscript fixes that hook order,
        // the builtin switches, the recovery policy, the subject roster,
        // migration and unfreeze each declare one fixed label, without fixing
        // the label bytes; these readable spellings are the implementation's
        // choice (task report item).
        private const string ResourceHookOrder = "hookOrder";
        private const string ResourceBuiltinPolicy = "builtinPolicy";
        private const string ResourceRecoveryPolicy = "recoveryPolicy";
        private const string ResourceMessageSubjects = "messageSubjects";
        private const string ResourceMigration = "migration";
        private const string ResourceUnfreeze = "unfreeze";

        /// <summary>
        /// ASCII <c>"compositeLayer":1,</c> — the profile marker of the
        /// account's orchestration instance (§14.1), used to find the hook
        /// orchestrator that owns the account-level hook order. The trailing
        /// comma pins the match to the value 1 (other profiles publish 0).
        /// </summary>
        private static readonly byte[] CompositeLayerOne = new byte[]
        {
            0x22, 0x63, 0x6F, 0x6D, 0x70, 0x6F, 0x73, 0x69, 0x74, 0x65, 0x4C, 0x61, 0x79,
            0x65, 0x72, 0x22, 0x3A, 0x31, 0x2C,
        };

        /// <summary>ASCII <c>"contractName":"ThresholdPolicyModule"</c> — the §15 instance marker.</summary>
        private static readonly byte[] ThresholdPolicyModuleMarker = new byte[]
        {
            0x22, 0x63, 0x6F, 0x6E, 0x74, 0x72, 0x61, 0x63, 0x74, 0x4E, 0x61, 0x6D, 0x65, 0x22, 0x3A, 0x22,
            0x54, 0x68, 0x72, 0x65, 0x73, 0x68, 0x6F, 0x6C, 0x64, 0x50, 0x6F, 0x6C, 0x69, 0x63, 0x79, 0x4D,
            0x6F, 0x64, 0x75, 0x6C, 0x65, 0x22,
        };

        /// <summary>ASCII <c>"contractName":"SigningModule"</c> — the §13 instance marker.</summary>
        private static readonly byte[] SigningModuleMarker = new byte[]
        {
            0x22, 0x63, 0x6F, 0x6E, 0x74, 0x72, 0x61, 0x63, 0x74, 0x4E, 0x61, 0x6D, 0x65, 0x22, 0x3A, 0x22,
            0x53, 0x69, 0x67, 0x6E, 0x69, 0x6E, 0x67, 0x4D, 0x6F, 0x64, 0x75, 0x6C, 0x65, 0x22,
        };

        // R-11-05 resource-key spellings, ASCII: "module:", "moduleId:", "policy:".
        private static readonly byte[] ResourceModulePrefix = new byte[]
        {
            0x6D, 0x6F, 0x64, 0x75, 0x6C, 0x65, 0x3A,
        };

        private static readonly byte[] ResourceModuleIdPrefix = new byte[]
        {
            0x6D, 0x6F, 0x64, 0x75, 0x6C, 0x65, 0x49, 0x64, 0x3A,
        };

        private static readonly byte[] ResourcePolicyPrefix = new byte[]
        {
            0x70, 0x6F, 0x6C, 0x69, 0x63, 0x79, 0x3A,
        };

        // Intent record layout (StdLib.Serialize of an object[]). FieldReadSet
        // holds the merged resource set of R-11-05 — the action-derived keys
        // ∪ the declared readSet — as the record the conflict rules use.
        private const int FieldId = 0;
        private const int FieldKind = 1;
        private const int FieldProposedAt = 2;
        private const int FieldMatureAt = 3;
        private const int FieldExpiresAt = 4;
        private const int FieldAuthorityEpoch = 5;
        private const int FieldConfigurationNonce = 6;
        private const int FieldDigest = 7;
        private const int FieldActions = 8;
        private const int FieldReadSet = 9;
        private const int RecordFields = 10;

        public delegate void ConfigurationProposedHandler(UInt160 accountId, BigInteger intentId, string kind,
            BigInteger matureAt, int actionCount);

        public delegate void ConfigurationConfirmedHandler(UInt160 accountId, BigInteger intentId);

        public delegate void ConfigurationCancelledHandler(UInt160 accountId, BigInteger intentId);

        public delegate void ConfigurationExpiredHandler(UInt160 accountId, BigInteger intentId);

        /// <summary>Reason codes of <c>ConfigurationInvalidated</c>: 1 = authority epoch went stale, 2 = resource conflict.</summary>
        public delegate void ConfigurationInvalidatedHandler(UInt160 accountId, BigInteger intentId,
            BigInteger reason);

        [DisplayName("ConfigurationProposed")]
        public static event ConfigurationProposedHandler OnConfigurationProposed = default!;

        [DisplayName("ConfigurationConfirmed")]
        public static event ConfigurationConfirmedHandler OnConfigurationConfirmed = default!;

        [DisplayName("ConfigurationCancelled")]
        public static event ConfigurationCancelledHandler OnConfigurationCancelled = default!;

        /// <summary>
        /// R-11-15: an expired record leaves the pending table through a cleanup,
        /// not through a withdrawal — the two events let an observer tell natural
        /// expiry from an active cancel.
        /// </summary>
        [DisplayName("ConfigurationExpired")]
        public static event ConfigurationExpiredHandler OnConfigurationExpired = default!;

        /// <summary>R-11-11: an intent invalidated after a confirm (epoch-stale or resource-conflicting).</summary>
        [DisplayName("ConfigurationInvalidated")]
        public static event ConfigurationInvalidatedHandler OnConfigurationInvalidated = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);

        // ---- module admission (spec §7.3/§12, core AssertCallbackAbi) ----

        /// <summary><c>getModuleProfile()</c>: the canonical capability profile this deployment publishes.</summary>
        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ModuleSupport.Core();

        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        // ---- lifecycle dispatched by the core (spec §9, Table 10) ----

        /// <summary><c>onInstall(accountId, moduleId, moduleType, initData)</c>: a governance module carries no install-time policy.</summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(initData.Length == 0, ModuleProtocol.ErrOperationMalformed);
        }

        /// <summary><c>onUninstall(accountId, moduleId, moduleType, deInitData)</c>: every intent leaves with the instance.</summary>
        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            byte[] intents = Helper.Concat(Prefix_Intent, (byte[])accountId);
            ModuleSupport.DeletePrefix(intents);
            ModuleSupport.DeletePrefix(Helper.Concat(Prefix_Completion, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_IntentCount, accountId));
        }

        /// <summary>§11: the maturity window this deployment enforces, in milliseconds.</summary>
        [Safe]
        public static BigInteger ConfigurationMaturity() => ConfigurationMaturityMs;

        /// <summary>§11 R-11-03: the confirmation window after maturity, in milliseconds (fixed, not extendable).</summary>
        [Safe]
        public static BigInteger ConfigurationExpiryWindow() => ConfigurationExpiryMs;

        // ---- §11 validation (the module is a validator-type instance, spec §11.1) ----

        /// <summary>Configuration intents are authorized at proposal and confirmation.
        /// This administration module never authorizes an ordinary operation.</summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            ModuleSupport.RequireValidationInstance(accountId);
            return false;
        }

        /// <summary>
        /// <c>onUserOpComplete(accountId, operation, result)</c>: the core calls
        /// this on the instance that approved the operation. The skeleton records
        /// the completion (time and routed instance) so an observer can tell a
        /// routed governance operation completed; it changes no decision.
        /// </summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            ModuleSupport.RequireCore();
            object[] view = ModuleSupport.Copy(operation);
            BigInteger moduleId = view.Length > 7 ? (BigInteger)view[7] : BigInteger.Zero;
            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_Completion, accountId),
                StdLib.Serialize(new object[] { Runtime.Time, moduleId }));
        }

        /// <summary><c>getLastCompletion(accountId) → [completedAt, moduleId]</c>, or an empty array when nothing completed yet.</summary>
        [Safe]
        public static object[] GetLastCompletion(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ModuleSupport.Key(Prefix_Completion, accountId));
            if (data == null) return new object[0];
            return (object[])StdLib.Deserialize(data!);
        }

        // ---- §11 intents ----

        /// <summary>
        /// <c>proposeConfiguration(accountId, actions[], readSet[]) → intentId</c>.
        ///
        /// <paramref name="actions"/> are core configuration actions — the
        /// shapes of spec §10/§11 Table 16 — and <paramref name="readSet"/>
        /// names extra state the proposal was made against, so a later
        /// confirmation shows what it was reviewed on; per R-11-07 the read set
        /// only widens the conflict surface, it never grants anything. The
        /// proposal writes state and touches no module: nothing can change
        /// between proposal and maturity.
        ///
        /// R-11-04: at most <see cref="MaxPendingIntents"/> intents may be
        /// pending; a full table refuses new proposals until one is confirmed,
        /// cancelled or cleaned as expired. R-11-05: the intent's resource set
        /// (action-derived keys ∪ declared readSet) is compared against every
        /// pending intent's set, and any intersection — or an identical action
        /// digest — is a conflict, refused, never queued or merged. R-11-09:
        /// the intent is bound to the authority epoch and configuration nonce
        /// the account holds at proposal time. R-11-08: the unfreeze action
        /// [11] may only travel alone, and only <c>Active</c> or <c>Frozen</c>
        /// accounts may propose it; every other intent is <c>Active</c>-only,
        /// and a <c>MigrationRequired</c> account only accepts an intent that
        /// carries the migration action (10).
        /// </summary>
        public static BigInteger ProposeConfiguration(UInt160 accountId, object[] actions, object[] readSet)
        {
            ModuleSupport.RequireAccountAdministration(accountId);
            ExecutionEngine.Assert(actions != null && actions.Length > 0, ModuleProtocol.ErrOperationMalformed);
            // The null-forgiving operators below are compile-time only: the
            // Assert on the line above demotes the compiler-side null-state of
            // its checked argument, so the bounds checks re-assert it without
            // changing any runtime behaviour (the null check already ran).
            ExecutionEngine.Assert(actions!.Length <= MaxActionsPerIntent, ModuleProtocol.ErrModuleLimitActions);
            bool unfreeze = ValidateActions(actions);
            RequireProposalStatus(accountId, actions, unfreeze);

            // R-11-15: expired records keep occupying their slots until someone
            // cleans them; the next proposal is one of the two cleaning
            // triggers (the other is the explicit cancel/cleanup entry).
            CleanupExpired(accountId);

            ByteString encoded = StdLib.Serialize(ModuleSupport.Copy(actions));
            object[] resources = Resources(actions, readSet);
            ByteString digest = CryptoLib.Sha256(encoded);
            RequireCapacityAndUnique(accountId, digest, resources);

            BigInteger proposedAt = Runtime.Time;
            BigInteger matureAt = proposedAt + ConfigurationMaturityMs;
            BigInteger intentId = AllocateIntentId(accountId);
            string kind = unfreeze ? KindUnfreeze : KindConfigure;

            object[] record = new object[RecordFields];
            record[FieldId] = intentId;
            record[FieldKind] = kind;
            record[FieldProposedAt] = proposedAt;
            record[FieldMatureAt] = matureAt;
            record[FieldExpiresAt] = matureAt + ConfigurationExpiryMs;
            record[FieldAuthorityEpoch] = ModuleSupport.AccountAuthorityEpoch(accountId);
            record[FieldConfigurationNonce] = ModuleSupport.AccountConfigurationNonce(accountId);
            record[FieldDigest] = digest;
            record[FieldActions] = encoded;
            record[FieldReadSet] = StdLib.Serialize(resources);
            Storage.Put(Storage.CurrentContext, IntentKey(accountId, intentId), StdLib.Serialize(record));

            OnConfigurationProposed(accountId, intentId, kind, matureAt, actions!.Length);
            return intentId;
        }

        /// <summary>
        /// <c>confirmConfiguration(accountId, intentId, actions[])</c>.
        ///
        /// The confirmation re-submits the actions, and only the exact set the
        /// proposal pinned is accepted: an intent cannot be replaced between
        /// proposal and maturity. Once mature — and before the §11 confirmation
        /// window closes — the actions are executed against their Table 19
        /// landing paths and the record is deleted (spec §11.4: a committed
        /// intent leaves the table, so the pending bound never counts executed
        /// intents). R-11-11: after the commit, only the intents whose authority
        /// epoch went stale or whose resources intersect this submission are
        /// invalidated; unrelated intents keep their slots untouched.
        /// </summary>
        public static void ConfirmConfiguration(UInt160 accountId, BigInteger intentId, object[] actions)
        {
            ModuleSupport.RequireAccountAdministration(accountId);
            object[] record = RequireIntent(accountId, intentId);
            bool unfreeze = (string)record[FieldKind] == KindUnfreeze;

            // H-2/R-11-08: the unfreeze path is usable by the only account
            // state that needs it — a frozen account can confirm its thaw
            // intent, and an Active account faults in the core's unfreeze
            // gate without state effect. Every other intent keeps the Active
            // gate (Frozen → SA_ACCOUNT_FROZEN), and a MigrationRequired
            // account only confirms an intent carrying the migration action.
            RequireConfirmStatus(accountId, record, unfreeze);

            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)record[FieldMatureAt], ModuleProtocol.ErrIntentImmature);
            ExecutionEngine.Assert(Runtime.Time <= (BigInteger)record[FieldExpiresAt], ModuleProtocol.ErrIntentExpired);

            // R-11-09: the intent is bound to the authority epoch and
            // configuration nonce it was proposed under. A freeze, thaw, module
            // change or recovery in between advances them, and an old intent
            // must not confirm against the new permission state.
            ExecutionEngine.Assert(
                ModuleSupport.AccountAuthorityEpoch(accountId) == (BigInteger)record[FieldAuthorityEpoch],
                ModuleProtocol.ErrEpochStale);
            ExecutionEngine.Assert(
                ModuleSupport.AccountConfigurationNonce(accountId) == (BigInteger)record[FieldConfigurationNonce],
                ModuleProtocol.ErrEpochStale + " configurationNonce");

            // The confirmation re-submits the actions, and only the exact bytes
            // the proposal pinned are accepted (Table 18: SA_OPERATION_MALFORMED):
            // an intent cannot be replaced between proposal and maturity.
            ExecutionEngine.Assert(actions != null, ModuleProtocol.ErrOperationMalformed);
            ByteString submitted = StdLib.Serialize(ModuleSupport.Copy(actions));
            ExecutionEngine.Assert(
                StdLib.MemoryCompare((ByteString)record[FieldActions]!, submitted) == 0,
                ModuleProtocol.ErrOperationMalformed);

            object[] committed = (object[])StdLib.Deserialize((ByteString)record[FieldActions]!);
            object[] resources = (object[])StdLib.Deserialize((ByteString)record[FieldReadSet]!);

            // Committed (§11.4): the record leaves the pending table before the
            // actions run, so a fault inside the actions cannot leave a
            // half-executed intent behind — the transaction reverts as a whole.
            Storage.Delete(Storage.CurrentContext, IntentKey(accountId, intentId));

            if (unfreeze) ModuleSupport.UnfreezeAccount(accountId);
            else Execute(accountId, committed);

            // R-11-11: invalidate only the epoch-stale or resource-conflicting
            // intents of the same account; unrelated ones keep their state.
            InvalidateStaleAndConflicting(accountId, resources);

            OnConfigurationConfirmed(accountId, intentId);
        }

        /// <summary>
        /// <c>cancelConfiguration(accountId, intentId)</c> (R-11-15): the
        /// withdrawal of an unexpired intent needs the custody witness, a
        /// frozen account can only withdraw its own unfreeze intent, and an
        /// expired record can be cleaned by <b>anyone</b> —
        /// <c>SA_INTENT_EXPIRED</c> refuses confirmations, never cleanups.
        /// Withdrawal and expiry-cleanup emit distinct events so an observer
        /// can tell “active withdrawal” from “natural expiry”.
        /// </summary>
        public static void CancelConfiguration(UInt160 accountId, BigInteger intentId)
        {
            object[] record = RequireIntent(accountId, intentId);

            // R-11-15: an expired record is open to anyone, witness-free.
            if (Runtime.Time > (BigInteger)record[FieldExpiresAt])
            {
                Storage.Delete(Storage.CurrentContext, IntentKey(accountId, intentId));
                OnConfigurationExpired(accountId, intentId);
                return;
            }

            ModuleSupport.RequireCustody(accountId);

            // A frozen account can only withdraw its own unfreeze intent.
            if (ModuleSupport.AccountStatus(accountId) == ModuleProtocol.StatusFrozen)
                ExecutionEngine.Assert((string)record[FieldKind] == KindUnfreeze, ModuleProtocol.ErrAccountFrozen);

            Storage.Delete(Storage.CurrentContext, IntentKey(accountId, intentId));
            OnConfigurationCancelled(accountId, intentId);
        }

        /// <summary>
        /// <c>getPendingConfiguration(accountId, intentId) → [intentId, kind, proposedAt,
        /// matureAt, expiresAt, authorityEpoch, configurationNonce, digest, actionCount]</c>,
        /// or an empty array when the id is unknown.
        /// </summary>
        [Safe]
        public static object[] GetPendingConfiguration(UInt160 accountId, BigInteger intentId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, IntentKey(accountId, intentId));
            if (data == null) return new object[0];
            object[] record = (object[])StdLib.Deserialize(data!);
            object[] actions = (object[])StdLib.Deserialize((ByteString)record[FieldActions]!);
            return new object[]
            {
                record[FieldId], record[FieldKind], record[FieldProposedAt], record[FieldMatureAt],
                record[FieldExpiresAt], record[FieldAuthorityEpoch], record[FieldConfigurationNonce],
                record[FieldDigest], actions.Length,
            };
        }

        /// <summary>
        /// <c>getPendingConfigurationIntentIds(accountId) → intentIds[]</c>
        /// (§11.2 Table 15, R-11-18): read-only enumeration of the pending
        /// intent ids, ascending. It writes nothing, cleans no expired record
        /// and advances no counter — cleanup happens only in the explicit
        /// cancel/cleanup entry or at the next proposal. The answer is bounded
        /// by the pending cap (expired-but-uncleaned records still occupy slots
        /// and are listed).
        /// </summary>
        [Safe]
        public static object[] GetPendingConfigurationIntentIds(UInt160 accountId)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                Helper.Concat(Prefix_Intent, (byte[])accountId), FindOptions.ValuesOnly);
            object[] ids = new object[MaxPendingIntents];
            int count = 0;
            while (iterator.Next())
            {
                ExecutionEngine.Assert(count < MaxPendingIntents, ModuleProtocol.ErrIntentLimit);
                object[] record = (object[])StdLib.Deserialize((ByteString)iterator.Value);
                ids[count++] = record[FieldId];
            }
            object[] result = new object[count];
            for (int i = 0; i < count; i++) result[i] = ids[i];
            return result;
        }

        /// <summary>
        /// <c>unfreezeAccount(accountId) → intentId</c>: §11 asks for an unfreeze
        /// to travel the same proposal/maturity/confirmation path as any other
        /// configuration change, so the whole thaw is reviewable before it runs.
        ///
        /// H-2: the proposal is open to a <c>Frozen</c> account as well — the
        /// thaw path is otherwise unusable by the only account state that needs
        /// it. <c>MigrationRequired</c> is still refused (R-11-14).
        /// </summary>
        public static BigInteger UnfreezeAccount(UInt160 accountId)
        {
            ModuleSupport.RequireActiveOrFrozenAccount(accountId);
            ModuleSupport.RequireAccountAdministration(accountId);

            // R-11-15: a proposal also cleans the expired records first.
            CleanupExpired(accountId);

            ByteString empty = StdLib.Serialize(new object[0]);
            object[] resources = new object[] { (ByteString)ResourceUnfreeze };
            RequireCapacityAndUnique(accountId, CryptoLib.Sha256(empty), resources);

            BigInteger intentId = AllocateIntentId(accountId);
            BigInteger proposedAt = Runtime.Time;
            BigInteger matureAt = proposedAt + ConfigurationMaturityMs;
            object[] record = new object[RecordFields];
            record[FieldId] = intentId;
            record[FieldKind] = KindUnfreeze;
            record[FieldProposedAt] = proposedAt;
            record[FieldMatureAt] = matureAt;
            record[FieldExpiresAt] = matureAt + ConfigurationExpiryMs;
            record[FieldAuthorityEpoch] = ModuleSupport.AccountAuthorityEpoch(accountId);
            record[FieldConfigurationNonce] = ModuleSupport.AccountConfigurationNonce(accountId);
            record[FieldDigest] = CryptoLib.Sha256(empty);
            record[FieldActions] = empty;
            record[FieldReadSet] = StdLib.Serialize(resources);
            Storage.Put(Storage.CurrentContext, IntentKey(accountId, intentId), StdLib.Serialize(record));

            OnConfigurationProposed(accountId, intentId, KindUnfreeze, matureAt, 0);
            return intentId;
        }

        // ---- internals ----

        private static BigInteger AllocateIntentId(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ModuleSupport.Key(Prefix_IntentCount, accountId));
            BigInteger next = data == null ? BigInteger.One : (BigInteger)data! + 1;
            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_IntentCount, accountId), next);
            return next;
        }

        private static byte[] IntentKey(UInt160 accountId, BigInteger intentId) =>
            ModuleSupport.Key(Prefix_Intent, accountId, intentId);

        private static object[] RequireIntent(UInt160 accountId, BigInteger intentId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, IntentKey(accountId, intentId));
            ExecutionEngine.Assert(data != null, ModuleProtocol.ErrIntentNotFound);
            return (object[])StdLib.Deserialize(data!);
        }

        /// <summary>
        /// R-11-04/R-11-05, checked before a new record is written: the pending
        /// table must have a free slot (<c>SA_INTENT_LIMIT</c>), and no pending
        /// intent may carry the same action digest or an intersecting resource
        /// set as the one being proposed — a conflict is refused, never queued
        /// or merged. The scan is bounded by the pending cap: committed and
        /// cancelled intents are deleted, not flagged.
        /// </summary>
        private static void RequireCapacityAndUnique(UInt160 accountId, ByteString digest, object[] resources)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                Helper.Concat(Prefix_Intent, (byte[])accountId), FindOptions.ValuesOnly);
            int pending = 0;
            while (iterator.Next())
            {
                pending++;
                ExecutionEngine.Assert(pending <= MaxPendingIntents, ModuleProtocol.ErrIntentLimit);
                object[] record = (object[])StdLib.Deserialize((ByteString)iterator.Value);
                // An identical action digest re-submits an intent that is
                // already pending — refused like any other conflict.
                ExecutionEngine.Assert(
                    StdLib.MemoryCompare((ByteString)record[FieldDigest]!, digest) != 0,
                    ModuleProtocol.ErrIntentConflict);
                object[] theirs = (object[])StdLib.Deserialize((ByteString)record[FieldReadSet]!);
                if (Intersects(theirs, resources))
                    ExecutionEngine.Assert(false, ModuleProtocol.ErrIntentConflict);
            }
            ExecutionEngine.Assert(pending < MaxPendingIntents, ModuleProtocol.ErrIntentLimit);
        }

        /// <summary>Byte-for-byte intersection of two stored resource sets (R-11-05).</summary>
        private static bool Intersects(object[] pending, object[] proposed)
        {
            for (int i = 0; i < pending.Length; i++)
            {
                ByteString theirs = (ByteString)pending[i];
                for (int j = 0; j < proposed.Length; j++)
                {
                    ByteString mine = (ByteString)proposed[j];
                    if (theirs!.Length == mine!.Length && StdLib.MemoryCompare(theirs, mine) == 0)
                        return true;
                }
            }
            return false;
        }

        /// <summary>
        /// R-11-06: every action must match its Table 16 shape at proposal
        /// time — unknown codes, wrong arity and wrong types are
        /// <c>SA_OPERATION_MALFORMED</c>, never silently ignored. The reply is
        /// the R-11-08 unfreeze flag: <c>true</c> exactly when the intent is
        /// the single-action <c>[11]</c> unfreeze intent.
        /// </summary>
        private static bool ValidateActions(object[] actions)
        {
            bool unfreeze = false;
            for (int i = 0; i < actions.Length; i++)
            {
                // nccs supports `is` patterns only for scalar VM types, so the
                // array shape itself is a plain VM cast: a non-array element
                // faults the call (fail-closed) instead of emitting the symbol.
                object[] action = (object[])actions[i];
                ExecutionEngine.Assert(action.Length >= 1, ModuleProtocol.ErrOperationMalformed);
                BigInteger code = (BigInteger)action[0];
                if (code == ModuleProtocol.ActionUnfreeze)
                {
                    // [11]: no parameters, and R-11-08 pins it to a
                    // single-action intent.
                    ExecutionEngine.Assert(action.Length == 1, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(actions.Length == 1, ModuleProtocol.ErrOperationMalformed);
                    unfreeze = true;
                }
                else if (code == ModuleProtocol.ActionInstallModule)
                {
                    // [1, moduleType, contractHash, profileDigest, initData[]]
                    ExecutionEngine.Assert(action.Length == 5, ModuleProtocol.ErrOperationMalformed);
                    bool moduleTypeOk = action[1] is BigInteger moduleType
                        && (moduleType == ModuleProtocol.ModuleTypeValidator
                            || moduleType == ModuleProtocol.ModuleTypeHook
                            || moduleType == ModuleProtocol.ModuleTypeRecovery);
                    ExecutionEngine.Assert(moduleTypeOk, ModuleProtocol.ErrOperationMalformed);
                    bool hashOk = action[2] is ByteString hashBytes && hashBytes.Length == 20;
                    ExecutionEngine.Assert(hashOk, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[3] is ByteString profileDigest && profileDigest.Length == 32,
                        ModuleProtocol.ErrOperationMalformed);
                    object[] initData = (object[])action[4];
                    ExecutionEngine.Assert(initData.Length <= MaxInitDataEntries,
                        ModuleProtocol.ErrOperationMalformed);
                }
                else if (code == ModuleProtocol.ActionUninstallModule)
                {
                    // [2, moduleId, deInitData[]]
                    ExecutionEngine.Assert(action.Length == 3, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[1] is BigInteger uninstallId && uninstallId >= 1,
                        ModuleProtocol.ErrOperationMalformed);
                    object[] deInitData = (object[])action[2];
                }
                else if (code == ModuleProtocol.ActionConfigureModule)
                {
                    // [3, moduleId, configData]: the core only relays — the
                    // target instance interprets configData itself (Table 19).
                    ExecutionEngine.Assert(action.Length == 3, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[1] is BigInteger configureId && configureId >= 1,
                        ModuleProtocol.ErrOperationMalformed);
                    object[] configData = (object[])action[2];
                }
                else if (code == ModuleProtocol.ActionSetHookOrder)
                {
                    // [4, hookIds[]]: ≥1, pairwise distinct, ≤8 and ascending —
                    // the §14 order the orchestrator's own entry will accept.
                    // The permutation must equal the installed hook set; that
                    // check is a landing-time state check (R-14-01), because the
                    // installed set may change between proposal and maturity.
                    object[] hookIds = (object[])action[1];
                    ExecutionEngine.Assert(action.Length == 2
                        && hookIds.Length >= 1 && hookIds.Length <= MaxHookOrderEntries,
                        ModuleProtocol.ErrOperationMalformed);
                    BigInteger previous = BigInteger.Zero;
                    for (int j = 0; j < hookIds.Length; j++)
                    {
                        ExecutionEngine.Assert(hookIds[j] is BigInteger, ModuleProtocol.ErrOperationMalformed);
                        BigInteger hookId = (BigInteger)hookIds[j];
                        ExecutionEngine.Assert(hookId >= 1, ModuleProtocol.ErrOperationMalformed);
                        ExecutionEngine.Assert(hookId > previous, ModuleProtocol.ErrOperationMalformed);
                        previous = hookId;
                    }
                }
                else if (code == ModuleProtocol.ActionSetBuiltinAuthorization)
                {
                    // [5, defaultOperationAuthorization, defaultMessageAuthorization]
                    ExecutionEngine.Assert(action.Length == 3
                        && action[1] is bool && action[2] is bool, ModuleProtocol.ErrOperationMalformed);
                }
                else if (code == ModuleProtocol.ActionRebindModule)
                {
                    // [6, moduleId, profileDigest]
                    ExecutionEngine.Assert(action.Length == 3, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[1] is BigInteger rebindId && rebindId >= 1,
                        ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[2] is ByteString rebindDigest && rebindDigest.Length == 32,
                        ModuleProtocol.ErrOperationMalformed);
                }
                else if (code == ModuleProtocol.ActionSetThresholdPolicy)
                {
                    // [7, policyId, threshold, memberIds[], active]: §15 bounds —
                    // 1–10 members (SA_MODULE_LIMIT_MEMBERS), threshold 1..n
                    // (SA_MODULE_LIMIT_THRESHOLD), a new policy must be active.
                    ExecutionEngine.Assert(action.Length == 5, ModuleProtocol.ErrOperationMalformed);
                    object[] memberIds = (object[])action[3];
                    ExecutionEngine.Assert(action[1] is BigInteger, ModuleProtocol.ErrOperationMalformed);
                    BigInteger policyId = (BigInteger)action[1];
                    ExecutionEngine.Assert(action[2] is BigInteger, ModuleProtocol.ErrOperationMalformed);
                    BigInteger policyThreshold = (BigInteger)action[2];
                    ExecutionEngine.Assert(action[4] is bool, ModuleProtocol.ErrOperationMalformed);
                    bool policyActive = (bool)action[4];
                    ExecutionEngine.Assert(policyId >= 0, ModuleProtocol.ErrOperationMalformed);
                    if (policyId == 0) ExecutionEngine.Assert(policyActive, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(memberIds.Length >= 1 && memberIds.Length <= MaxPolicyMembers,
                        ModuleProtocol.ErrModuleLimitMembers);
                    ExecutionEngine.Assert(policyThreshold >= 1 && policyThreshold <= memberIds.Length,
                        ModuleProtocol.ErrModuleLimitThreshold);
                    for (int j = 0; j < memberIds.Length; j++)
                    {
                        ExecutionEngine.Assert(memberIds[j] is BigInteger && (BigInteger)memberIds[j] >= 1,
                            ModuleProtocol.ErrOperationMalformed);
                        for (int k = 0; k < j; k++)
                            ExecutionEngine.Assert((BigInteger)memberIds[k] != (BigInteger)memberIds[j],
                                ModuleProtocol.ErrOperationMalformed);
                    }
                }
                else if (code == ModuleProtocol.ActionSetRecoveryPolicy)
                {
                    // [8, recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery]
                    // (spec §10/§11.5): the same four values the core's
                    // setRecoveryPolicy landing entry re-validates, so a
                    // proposal can never pin a shape or a domain the core
                    // would refuse.
                    ExecutionEngine.Assert(action.Length == 4, ModuleProtocol.ErrOperationMalformed);
                    bool authorityOk = action[1] is ByteString authorityBytes
                        && authorityBytes.Length == 20;
                    ExecutionEngine.Assert(authorityOk, ModuleProtocol.ErrOperationMalformed);
                    bool timelockOk = action[2] is BigInteger timelock
                        && timelock >= (BigInteger)ModuleProtocol.RecoveryTimelockMinMs
                        && timelock <= (BigInteger)ModuleProtocol.RecoveryTimelockMaxMs;
                    ExecutionEngine.Assert(timelockOk, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[3] is bool, ModuleProtocol.ErrOperationMalformed);
                }
                else if (code == ModuleProtocol.ActionSetMessageSubjects)
                {
                    // [9, subjects[], threshold]: each subject 20 or 32 bytes,
                    // pairwise distinct, ≤16; 1 ≤ t ≤ n (Table 16/§13).
                    object[] subjects = (object[])action[1];
                    ExecutionEngine.Assert(action.Length == 3
                        && subjects.Length >= 1 && subjects.Length <= MaxSubjectEntries,
                        ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[2] is BigInteger, ModuleProtocol.ErrOperationMalformed);
                    BigInteger subjectThreshold = (BigInteger)action[2];
                    ExecutionEngine.Assert(subjectThreshold >= 1 && subjectThreshold <= subjects.Length,
                        ModuleProtocol.ErrOperationMalformed);
                    for (int j = 0; j < subjects.Length; j++)
                    {
                        bool widthOk = subjects[j] is ByteString subject
                            && (subject.Length == 20 || subject.Length == 32);
                        ExecutionEngine.Assert(widthOk, ModuleProtocol.ErrOperationMalformed);
                        for (int k = 0; k < j; k++)
                            ExecutionEngine.Assert(
                                StdLib.MemoryCompare((ByteString)subjects[k], (ByteString)subjects[j]) != 0,
                                ModuleProtocol.ErrOperationMalformed);
                    }
                }
                else if (code == ModuleProtocol.ActionMigrateImport)
                {
                    // [10, manifestDigest, classification]
                    ExecutionEngine.Assert(action.Length == 3, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[1] is ByteString manifestDigest && manifestDigest.Length == 32,
                        ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[2] is ByteString classification
                        && classification.Length <= MaxClassificationLength, ModuleProtocol.ErrOperationMalformed);
                }
                else
                {
                    ExecutionEngine.Assert(false, ModuleProtocol.ErrOperationMalformed);
                }
            }
            return unfreeze;
        }

        /// <summary>
        /// Replays the reviewed actions against their Table 19 landing paths.
        /// The module-model actions go through the core transitions
        /// (<c>installModule</c>/<c>removeModule</c>); governance action 8 goes
        /// through the core's <c>setRecoveryPolicy</c> restricted entry and
        /// action 5 through <c>setBuiltinAuthorization</c>; action 3 relays to
        /// the target instance's own <c>configure</c> callback; actions 4, 7
        /// and 9 land in the orchestrator/threshold/message module's own write
        /// entries. Actions 6 and 10 have no core entry yet — they are
        /// refused here rather than invented (blocking items of the task
        /// report). The install action's declared profile digest (audit M-2)
        /// is handed through to the core transition, so the profile the
        /// proposal reviewed is the profile that is installed.
        /// </summary>
        private static void Execute(UInt160 accountId, object[] actions)
        {
            for (int i = 0; i < actions.Length; i++)
            {
                object[] action = (object[])actions[i];
                ExecutionEngine.Assert(action.Length >= 1, ModuleProtocol.ErrOperationMalformed);
                BigInteger code = (BigInteger)action[0];
                if (code == ModuleProtocol.ActionInstallModule)
                {
                    // [1, moduleType, contractHash, profileDigest, initData[]]
                    ModuleSupport.InstallModule(accountId, (int)(BigInteger)action[1], (UInt160)action[2],
                        (ByteString)action[3], (object[])action[4]);
                    continue;
                }
                if (code == ModuleProtocol.ActionUninstallModule)
                {
                    // [2, moduleId, deInitData[]]
                    ModuleSupport.RemoveModule(accountId, (BigInteger)action[1], (object[])action[2]);
                    continue;
                }
                if (code == ModuleProtocol.ActionConfigureModule)
                {
                    // [3, moduleId, configData]: Table 19 — the target
                    // instance's own configure callback (Table 10:
                    // Hash160, Integer, Integer, Array → Void); the core has
                    // no entry and never interprets configData.
                    object[] descriptor = ModuleSupport.ModuleDescriptor(accountId, (BigInteger)action[1]);
                    Contract.Call((UInt160)descriptor[ModuleSupport.FieldModuleContractHash], "configure",
                        CallFlags.All,
                        new object[] { accountId, action[1], descriptor[ModuleSupport.FieldModuleType], action[2] });
                    continue;
                }
                if (code == ModuleProtocol.ActionSetHookOrder)
                {
                    // [4, hookIds[]]: Table 19 — the order lands in the
                    // orchestrator's own 0x54 key through its setHookOrder
                    // entry; the orchestrator itself checks the permutation
                    // equals the installed hook set (R-14-01).
                    Contract.Call(RequireValidatorByProfile(accountId, CompositeLayerOne, "hook orchestrator"),
                        "setHookOrder", CallFlags.All, new object[] { accountId, action[1] });
                    continue;
                }
                if (code == ModuleProtocol.ActionSetBuiltinAuthorization)
                {
                    // [5, defaultOperationAuthorization, defaultMessageAuthorization]:
                    // the core's restricted landing entry (C-24/§7.1, R-07-14);
                    // the core re-checks authority, account state and the
                    // last-route guard (SA_BUILTIN_ROUTE_REQUIRED).
                    ModuleSupport.SetBuiltinAuthorization(accountId, (bool)action[1], (bool)action[2]);
                    continue;
                }
                if (code == ModuleProtocol.ActionRebindModule)
                {
                    // [6, moduleId, profileDigest]: the core's
                    // code-rebinding entry does not exist yet — refuse rather
                    // than invent a landing path (task-report blocking item).
                    ExecutionEngine.Assert(false,
                        ModuleProtocol.ErrPhaseViolation + " module rebind entry not deployed");
                    continue;
                }
                if (code == ModuleProtocol.ActionSetThresholdPolicy)
                {
                    // [7, policyId, threshold, memberIds[], active]: Table 19 —
                    // the §15 write lands in the threshold module's own
                    // setThresholdPolicy entry, which re-validates members and
                    // threshold. The threshold and member list are handed
                    // through as the confirmed intent named them.
                    Contract.Call(
                        RequireValidatorByProfile(accountId, ThresholdPolicyModuleMarker, "threshold policy module"),
                        "setThresholdPolicy", CallFlags.All,
                        new object[] { accountId, action[2], action[3] });
                    continue;
                }
                if (code == ModuleProtocol.ActionSetRecoveryPolicy)
                {
                    // [8, recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery]
                    // The core re-verifies the authority domain, the timelock
                    // window and the account state; this governance contract's
                    // own witness is the installed-validator arm of that check.
                    ModuleSupport.SetRecoveryPolicy(accountId, (UInt160)action[1],
                        (BigInteger)action[2], (bool)action[3]);
                    continue;
                }
                if (code == ModuleProtocol.ActionSetMessageSubjects)
                {
                    // [9, subjects[], threshold]: Table 19 — the §13 write
                    // lands in the message module's own updateMessageSubject
                    // entry, which re-validates the roster.
                    Contract.Call(
                        RequireValidatorByProfile(accountId, SigningModuleMarker, "message signing module"),
                        "updateMessageSubject", CallFlags.All,
                        new object[] { accountId, action[1], action[2] });
                    continue;
                }
                if (code == ModuleProtocol.ActionMigrateImport)
                {
                    // [10, manifestDigest, classification]: the core's
                    // migration import entry does not exist yet (C-15: the
                    // executor is a later batch) — refuse rather than invent a
                    // landing path (task-report blocking item).
                    ExecutionEngine.Assert(false,
                        ModuleProtocol.ErrPhaseViolation + " migration import entry not deployed");
                    continue;
                }
                // [11] never reaches Execute: an unfreeze-kind intent lands
                // through the core's unfreezeAccount entry in
                // ConfirmConfiguration itself.
                ExecutionEngine.Assert(false, ModuleProtocol.ErrOperationMalformed);
            }
        }

        // ---- R-11-05 / R-11-08 / R-11-11 / R-11-15 helpers ----

        /// <summary>
        /// R-11-08 status gate, shared by proposal and confirmation: the
        /// unfreeze kind accepts <c>Active</c> or <c>Frozen</c>
        /// (<c>MigrationRequired</c> is refused, R-11-14); every other intent is
        /// <c>Active</c>-only (<c>Frozen</c> → <c>SA_ACCOUNT_FROZEN</c>), and a
        /// <c>MigrationRequired</c> account only accepts an intent that carries
        /// the migration action (10).
        /// </summary>
        private static void RequireProposalStatus(UInt160 accountId, object[] actions, bool unfreeze)
        {
            BigInteger status = ModuleSupport.AccountStatus(accountId);
            if (unfreeze)
            {
                ExecutionEngine.Assert(
                    status == ModuleProtocol.StatusActive || status == ModuleProtocol.StatusFrozen,
                    ModuleProtocol.ErrAccountStatus);
                return;
            }
            if (status == ModuleProtocol.StatusFrozen)
                ExecutionEngine.Assert(false, ModuleProtocol.ErrAccountFrozen);
            if (status == ModuleProtocol.StatusMigrationRequired)
                ExecutionEngine.Assert(ContainsMigration(actions), ModuleProtocol.ErrAccountStatus);
        }

        private static void RequireConfirmStatus(UInt160 accountId, object[] record, bool unfreeze)
        {
            object[] committed = (object[])StdLib.Deserialize((ByteString)record[FieldActions]!);
            RequireProposalStatus(accountId, committed, unfreeze);
        }

        private static bool ContainsMigration(object[] actions)
        {
            for (int i = 0; i < actions.Length; i++)
            {
                object[] action = (object[])actions[i];
                if (action.Length >= 1
                    && action[0] is BigInteger code && code == ModuleProtocol.ActionMigrateImport)
                    return true;
            }
            return false;
        }

        /// <summary>
        /// R-11-05: the intent's resource set — the action-derived keys ∪ the
        /// declared readSet — computed at proposal time and stored with the
        /// record. Installs declare the target contract
        /// (<c>module: ‖ contractHash</c>); uninstall, configure and rebind
        /// declare the instance (<c>moduleId: ‖ U64BE</c>); hook order, the
        /// builtin switches, the recovery policy, the subject roster, migration
        /// and unfreeze each declare one fixed label; a threshold policy
        /// declares <c>policy: ‖ U64BE</c> plus every member instance key.
        /// readSet entries are validated (ByteString ≤ 64 bytes) — the read set
        /// only widens the conflict surface (R-11-07), it never grants
        /// anything.
        /// </summary>
        private static object[] Resources(object[] actions, object[] readSet)
        {
            ExecutionEngine.Assert(readSet != null && readSet.Length <= MaxReadSetEntries,
                ModuleProtocol.ErrOperationMalformed);
            // Upper bound: every action contributes at most 1 + MaxPolicyMembers
            // keys (action 7: the policy key plus every member instance key).
            object[] collected = new object[MaxActionsPerIntent * (MaxPolicyMembers + 1) + MaxReadSetEntries];
            int count = 0;
            for (int i = 0; i < actions.Length; i++)
            {
                object[] action = (object[])actions[i];
                BigInteger code = (BigInteger)action[0];
                if (code == ModuleProtocol.ActionInstallModule)
                {
                    collected[count++] = ContractResourceKey((UInt160)action[2]);
                }
                else if (code == ModuleProtocol.ActionUninstallModule
                    || code == ModuleProtocol.ActionConfigureModule
                    || code == ModuleProtocol.ActionRebindModule)
                {
                    collected[count++] = InstanceResourceKey((BigInteger)action[1]);
                }
                else if (code == ModuleProtocol.ActionSetHookOrder)
                {
                    collected[count++] = (ByteString)ResourceHookOrder;
                }
                else if (code == ModuleProtocol.ActionSetBuiltinAuthorization)
                {
                    collected[count++] = (ByteString)ResourceBuiltinPolicy;
                }
                else if (code == ModuleProtocol.ActionSetThresholdPolicy)
                {
                    collected[count++] = PolicyResourceKey((BigInteger)action[1]);
                    object[] memberIds = (object[])action[3];
                    for (int j = 0; j < memberIds.Length; j++)
                        collected[count++] = InstanceResourceKey((BigInteger)memberIds[j]);
                }
                else if (code == ModuleProtocol.ActionSetRecoveryPolicy)
                {
                    collected[count++] = (ByteString)ResourceRecoveryPolicy;
                }
                else if (code == ModuleProtocol.ActionSetMessageSubjects)
                {
                    collected[count++] = (ByteString)ResourceMessageSubjects;
                }
                else if (code == ModuleProtocol.ActionMigrateImport)
                {
                    collected[count++] = (ByteString)ResourceMigration;
                }
                else if (code == ModuleProtocol.ActionUnfreeze)
                {
                    collected[count++] = (ByteString)ResourceUnfreeze;
                }
            }
            for (int i = 0; i < readSet!.Length; i++)
            {
                ExecutionEngine.Assert(readSet[i] is ByteString, ModuleProtocol.ErrOperationMalformed);
                ByteString declared = (ByteString)readSet[i];
                ExecutionEngine.Assert(declared.Length >= 1 && declared.Length <= MaxResourceKeyLength,
                    ModuleProtocol.ErrOperationMalformed);
                collected[count++] = declared;
            }
            object[] result = new object[count];
            for (int i = 0; i < count; i++) result[i] = collected[i];
            return result;
        }

        private static ByteString InstanceResourceKey(BigInteger moduleId) =>
            (ByteString)Helper.Concat(ResourceModuleIdPrefix, ModuleSupport.U64BE(moduleId));

        private static ByteString ContractResourceKey(UInt160 contractHash) =>
            (ByteString)Helper.Concat(ResourceModulePrefix, (byte[])contractHash);

        private static ByteString PolicyResourceKey(BigInteger policyId) =>
            (ByteString)Helper.Concat(ResourcePolicyPrefix, ModuleSupport.U64BE(policyId));

        /// <summary>
        /// R-11-15: expired records keep occupying their slots until someone
        /// cleans them; a proposal (and the dedicated unfreeze entry) cleans
        /// them first so the slots they free are immediately reusable. The
        /// cleanup emits <c>ConfigurationExpired</c> per removed record so an
        /// observer can tell natural expiry from an active withdrawal.
        /// </summary>
        private static void CleanupExpired(UInt160 accountId)
        {
            // ValuesOnly plus a key rebuilt from the record's own intent id: the
            // devpack Iterator exposes no key side, and the id is part of the
            // record, so the delete addresses exactly the scanned entry.
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                Helper.Concat(Prefix_Intent, (byte[])accountId), FindOptions.ValuesOnly);
            while (iterator.Next())
            {
                object[] record = (object[])StdLib.Deserialize((ByteString)iterator.Value);
                if (Runtime.Time > (BigInteger)record[FieldExpiresAt])
                {
                    Storage.Delete(Storage.CurrentContext,
                        IntentKey(accountId, (BigInteger)record[FieldId]));
                    OnConfigurationExpired(accountId, (BigInteger)record[FieldId]);
                }
            }
        }

        /// <summary>
        /// R-11-11: after a committed intent, invalidate only the same
        /// account's intents whose authority epoch went stale (reason 1) or
        /// whose resource set intersects the committed one (reason 2);
        /// unrelated intents keep their slots, numbers and maturity untouched.
        /// The committed record itself is already deleted when this runs.
        /// </summary>
        private static void InvalidateStaleAndConflicting(UInt160 accountId, object[] resources)
        {
            BigInteger epoch = ModuleSupport.AccountAuthorityEpoch(accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                Helper.Concat(Prefix_Intent, (byte[])accountId), FindOptions.ValuesOnly);
            while (iterator.Next())
            {
                object[] record = (object[])StdLib.Deserialize((ByteString)iterator.Value);
                BigInteger reason = BigInteger.Zero;
                if ((BigInteger)record[FieldAuthorityEpoch] != epoch)
                {
                    reason = BigInteger.One;
                }
                else if (Intersects((object[])StdLib.Deserialize((ByteString)record[FieldReadSet]!), resources))
                {
                    reason = BigInteger.One + BigInteger.One;
                }
                else
                {
                    continue;
                }
                Storage.Delete(Storage.CurrentContext,
                    IntentKey(accountId, (BigInteger)record[FieldId]));
                OnConfigurationInvalidated(accountId, (BigInteger)record[FieldId], reason);
            }
        }

        /// <summary>
        /// Finds the account's installed validator instance whose capability
        /// profile contains <paramref name="marker"/> — the discovery the
        /// Table 19 landings of actions 4, 7 and 9 need, because the core has
        /// no entry for them and the spec fixes no discovery protocol. The
        /// scan is bounded by the validator instance limit.
        /// </summary>
        private static UInt160 RequireValidatorByProfile(UInt160 accountId, byte[] marker, string what)
        {
            BigInteger[] ids = ModuleSupport.InstalledModuleIds(accountId, "validator",
                ModuleProtocol.MaxValidatorInstances);
            for (int i = 0; i < ids.Length; i++)
            {
                object[] descriptor = ModuleSupport.ModuleDescriptor(accountId, ids[i]);
                UInt160 contractHash = (UInt160)descriptor[ModuleSupport.FieldModuleContractHash];
                ByteString profile = (ByteString)Contract.Call(contractHash, "getModuleProfile",
                    CallFlags.ReadOnly, new object[0]);
                if (profile != null && ContainsBytes((byte[])profile, marker)) return contractHash;
            }
            ExecutionEngine.Assert(false, ModuleProtocol.ErrModuleNotInstalled + " " + what);
            return UInt160.Zero;
        }

        /// <summary>Plain byte-substring test over a ≤2048-byte profile.</summary>
        private static bool ContainsBytes(byte[] haystack, byte[] needle)
        {
            if (needle.Length == 0 || haystack.Length < needle.Length) return false;
            for (int i = 0; i + needle.Length <= haystack.Length; i++)
            {
                bool matched = true;
                for (int j = 0; j < needle.Length; j++)
                {
                    if (haystack[i + j] != needle[j])
                    {
                        matched = false;
                        break;
                    }
                }
                if (matched) return true;
            }
            return false;
        }
    }
}
