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
    /// §12 recovery module (recovery seat).
    ///
    /// A recovery is a three-step conversation the account itself cannot hold:
    ///
    ///   beginRecovery   — the custodian or the recorded recovery authority
    ///                     starts it (R-12-02), optionally naming the custody
    ///                     the matured reset should rotate to (a zero newCustody
    ///                     keeps the current one), and the start time is the
    ///                     clock the account's own <c>recoveryTimelockMs</c>
    ///                     runs against (the module never invents a delay);
    ///   cancelRecovery  — the custodian or the recorded recovery authority
    ///                     withdraws it before execution;
    ///   executeRecovery — permissionless, because by then the delay the
    ///                     account committed to has passed and there is nothing
    ///                     left to decide: the module hands the recorded
    ///                     newCustody to the core's §12.5 <c>resetAccount</c>,
    ///                     the only transition that can re-land the account at
    ///                     its registration defaults.
    ///
    /// The module owns the conversation only: the core keeps custody, the
    /// recovery authority and the timelock as account state, and
    /// <see cref="ExecuteRecovery"/> is the wiring point that hands the
    /// finished decision to the core through
    /// <c>ModuleSupport.ResetAccount</c> — the reset's trigger right is pinned
    /// to this module's installed recovery seat (R-12-12), so no other contract
    /// (validator, hook or governance) can reach a custody rotation through it.
    ///
    /// The module is a <b>non-routing recovery seat</b>: nothing in §12 ever
    /// routes an operation to it, so it is installed with module type code 5
    /// (recovery-kind: the core dispatches only <c>onInstall</c>/
    /// <c>onUninstall</c> to it and never the routing pair, per
    /// SmartAccountModulePolicy.AssertCallbackAbi). The admission gate
    /// therefore requires the <c>getModuleProfile</c> reader and the two
    /// lifecycle callbacks only, and a recovery-kind profile may not claim
    /// message or threshold capabilities — this module has neither.
    ///
    /// Storage is per account:
    ///   <c>0x01 ‖ accountId</c>        → serialized recovery record
    ///   <c>0x02 ‖ accountId</c>        → last executed recovery nonce
    /// </summary>
    [DisplayName("RecoveryModule")]
    [ContractPermission("*", "getAccount")]
    [ContractPermission("*", "resetAccount")]
    [ManifestExtra("Description", "Delayed account-recovery module (spec §12)")]
    public class RecoveryModule : SmartContract
    {
        // Canonical module capability profile (docs/SA-MODULE-PROTOCOL.md §12):
        // keys sorted, no whitespace, no trailing newline. The core hashes these
        // exact bytes into the install-time profile digest. Non-routing
        // recovery seat (type code 5, capacity 1 per account, R-12-12) with no
        // message or threshold capability; the recovery record is keyed by
        // account, so a second instance of the same contract on one account is
        // refused by the core (instanceIsolation false).
        private const string ModuleProfileJson =
            "{\"callbacks\":[],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"RecoveryModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"recovery\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Recovery = new byte[] { 0x01 };
        private static readonly byte[] Prefix_Nonce = new byte[] { 0x02 };

        // Recovery record layout (StdLib.Serialize of an object[]). The
        // trailing authorityEpochAtInit is the R-12-05 snapshot: the authority
        // epoch the account held when the recovery began, re-verified at
        // execution so a recovery proposed against an old permission epoch
        // cannot execute against a new one.
        private const int FieldNonce = 0;
        private const int FieldCustodian = 1;
        private const int FieldStartedAt = 2;
        private const int FieldExecutableAt = 3;
        private const int FieldStatus = 4;
        private const int FieldNewCustody = 5;
        private const int FieldAuthorityEpochAtInit = 6;
        private const int RecordFields = 7;

        private const int StatusNone = 0;
        private const int StatusPending = 1;
        private const int StatusExecuted = 2;

        public delegate void RecoveryStartedHandler(UInt160 accountId, BigInteger nonce, BigInteger executableAt);

        public delegate void RecoveryCancelledHandler(UInt160 accountId, BigInteger nonce);

        public delegate void RecoveryExecutedHandler(UInt160 accountId, BigInteger nonce, UInt160 recoveryAuthority);

        [DisplayName("RecoveryStarted")]
        public static event RecoveryStartedHandler OnRecoveryStarted = default!;

        [DisplayName("RecoveryCancelled")]
        public static event RecoveryCancelledHandler OnRecoveryCancelled = default!;

        [DisplayName("RecoveryExecuted")]
        public static event RecoveryExecutedHandler OnRecoveryExecuted = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);

        // ---- module admission (spec §7.3/§12, core AssertCallbackAbi) ----

        /// <summary><c>getModuleProfile()</c>: the canonical capability profile this deployment publishes.</summary>
        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ModuleSupport.Core();

        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        // ---- lifecycle dispatched by the core (spec §9, Table 10) ----

        /// <summary><c>onInstall(accountId, moduleId, moduleType, initData)</c>: a recovery module carries no install-time policy.</summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(initData.Length == 0, ModuleProtocol.ErrOperationMalformed);
        }

        /// <summary><c>onUninstall(accountId, moduleId, moduleType, deInitData)</c>: an unfinished recovery leaves with the instance.</summary>
        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_Recovery, accountId));
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_Nonce, accountId));
        }

        // ---- §12 recovery lifecycle ----

        /// <summary>
        /// <c>beginRecovery(accountId, newCustody)</c>: the custodian, or the
        /// recovery authority the account recorded in the core (R-12-02 —
        /// read through <see cref="ModuleSupport.RecoveryAuthority"/>, so a
        /// policy the core's <c>setRecoveryPolicy</c> landed is the one that
        /// witnesses). A non-zero <paramref name="newCustody"/> — the custody
        /// the matured reset will rotate to — must itself witness (R-12-02); a
        /// zero value keeps the current custody and needs no extra witness.
        /// The delay is the account's own recovery timelock, read from the core
        /// at the moment the recovery starts, so a later account change cannot
        /// shorten a recovery that is already running.
        ///
        /// R-12-14 (frozen escape): the begin gate accepts <c>Active</c> or
        /// <c>Frozen</c> — freezing must never seal an account shut, and a
        /// frozen account is exactly the one that needs recovery;
        /// <c>MigrationRequired</c> is refused (<c>SA_ACCOUNT_STATUS</c>),
        /// because a recovery reset must not buy execution capability past the
        /// migration gate. R-12-05: the record snapshots the account's current
        /// <c>authorityEpoch</c> as <c>authorityEpochAtInit</c>, which
        /// <see cref="ExecuteRecovery"/> re-verifies before the reset.
        /// </summary>
        public static BigInteger BeginRecovery(UInt160 accountId, UInt160 newCustody)
        {
            ModuleSupport.RequireActiveOrFrozenAccount(accountId);
            ModuleSupport.RequireCustodyOrRecovery(accountId);
            if (newCustody != UInt160.Zero)
            {
                ExecutionEngine.Assert(newCustody.IsValid, ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert(Runtime.CheckWitness(newCustody), ModuleProtocol.ErrUnauthorized);
            }

            object[] existing = LoadRecord(accountId);
            ExecutionEngine.Assert((int)(BigInteger)existing[FieldStatus] != StatusPending,
                ModuleProtocol.ErrRecoveryPending);

            BigInteger nonce = (BigInteger)existing[FieldNonce] + 1;
            BigInteger startedAt = Runtime.Time;
            BigInteger executableAt = startedAt + ModuleSupport.RecoveryTimelockMs(accountId);

            object[] record = new object[RecordFields];
            record[FieldNonce] = nonce;
            record[FieldCustodian] = ModuleSupport.Custody(accountId);
            record[FieldStartedAt] = startedAt;
            record[FieldExecutableAt] = executableAt;
            record[FieldStatus] = StatusPending;
            record[FieldNewCustody] = newCustody;
            record[FieldAuthorityEpochAtInit] = ModuleSupport.AccountAuthorityEpoch(accountId);
            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_Recovery, accountId), StdLib.Serialize(record));

            OnRecoveryStarted(accountId, nonce, executableAt);
            return nonce;
        }

        /// <summary>
        /// <c>cancelRecovery(accountId)</c>: the custodian, or the recovery
        /// authority the account recorded. A pending recovery is the only one
        /// that can be cancelled. R-12-14: the cancel gate accepts
        /// <c>Active</c> or <c>Frozen</c> and refuses <c>MigrationRequired</c>.
        /// </summary>
        public static void CancelRecovery(UInt160 accountId)
        {
            ModuleSupport.RequireActiveOrFrozenAccount(accountId);
            ModuleSupport.RequireCustodyOrRecovery(accountId);
            object[] record = RequirePending(accountId);
            BigInteger nonce = (BigInteger)record[FieldNonce];
            record[FieldStatus] = StatusNone;
            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_Recovery, accountId), StdLib.Serialize(record));
            OnRecoveryCancelled(accountId, nonce);
        }

        /// <summary>
        /// <c>executeRecovery(accountId)</c>: permissionless once the account's
        /// recovery timelock has elapsed. Waiting is the only thing that can
        /// authorize it, which is why the caller needs no witness at all.
        /// R-12-05: the account's current <c>authorityEpoch</c> must still
        /// equal the <c>authorityEpochAtInit</c> the record snapshotted at
        /// begin time — a freeze, thaw or recovery in between advanced the
        /// epoch, meaning the configuration this recovery was proposed
        /// against is gone, so the recovery must be restarted
        /// (<c>SA_EPOCH_STALE</c>). R-12-14: the gate accepts <c>Active</c> or
        /// <c>Frozen</c>; <c>MigrationRequired</c> is refused.
        /// The matured decision lands through the core's §12.5
        /// <c>resetAccount(accountId, newCustody)</c>: this contract's installed
        /// recovery seat is the one caller the core's reset entry accepts
        /// (R-12-12), which is what makes the permissionless trigger safe —
        /// anyone may finish a reset the control subjects already proposed,
        /// nobody but the seat can start one. The reset removes every module
        /// instance of the account (this seat included, without onUninstall),
        /// so the local record written here survives only as inert history
        /// (R-12-13: a residual module key is no installation fact).
        /// </summary>
        public static void ExecuteRecovery(UInt160 accountId)
        {
            ModuleSupport.RequireActiveOrFrozenAccount(accountId);
            object[] record = RequirePending(accountId);
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)record[FieldExecutableAt],
                ModuleProtocol.ErrRecoveryLocked);

            // R-12-05: the epoch the recovery was proposed against must still
            // be the account's current epoch.
            ExecutionEngine.Assert(
                ModuleSupport.AccountAuthorityEpoch(accountId) == (BigInteger)record[FieldAuthorityEpochAtInit],
                ModuleProtocol.ErrEpochStale);

            BigInteger nonce = (BigInteger)record[FieldNonce];
            UInt160 recoveryAuthority = ModuleSupport.RecoveryAuthority(accountId);
            ExecutionEngine.Assert(recoveryAuthority != UInt160.Zero && recoveryAuthority.IsValid,
                ModuleProtocol.ErrAccountStatus);

            record[FieldStatus] = StatusExecuted;
            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_Recovery, accountId), StdLib.Serialize(record));
            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_Nonce, accountId), nonce);

            // The operative transition: the core's six-step §12.5 reset (every
            // instance removed, nonce channels and migration state cleared,
            // custody rotated to the declared target, registration defaults
            // restored, epoch/nonce/revision advanced, AccountReset notified).
            // Any fault inside it reverts this whole transaction with the
            // module-side writes above (R-12-08).
            ModuleSupport.ResetAccount(accountId, (UInt160)record[FieldNewCustody]);

            OnRecoveryExecuted(accountId, nonce, recoveryAuthority);
        }

        /// <summary>
        /// <c>getRecoveryStatus(accountId) → [nonce, custodian, startedAt,
        /// executableAt, status, newCustody, authorityEpochAtInit]</c>, or an
        /// empty array when no recovery was ever started. The trailing
        /// newCustody is the custody the matured reset would rotate to (zero
        /// keeps the current one); authorityEpochAtInit is the R-12-05 epoch
        /// snapshot the execution re-verifies.
        /// </summary>
        [Safe]
        public static object[] GetRecoveryStatus(UInt160 accountId)
        {
            object[] record = LoadRecord(accountId);
            if ((int)(BigInteger)record[FieldStatus] == StatusNone) return new object[0];
            return new object[]
            {
                record[FieldNonce], record[FieldCustodian], record[FieldStartedAt],
                record[FieldExecutableAt], record[FieldStatus], record[FieldNewCustody],
                record[FieldAuthorityEpochAtInit],
            };
        }

        // Bind a reviewed transaction to this instance's record and current core
        // configuration. A cancellation/replacement or reinstallation must force a new review.
        public static void CancelReviewedRecovery(UInt160 accountId, BigInteger nonce, BigInteger configurationNonce)
        {
            RequireReviewedRecord(accountId, nonce, configurationNonce);
            CancelRecovery(accountId);
        }

        public static void ExecuteReviewedRecovery(UInt160 accountId, BigInteger nonce, BigInteger configurationNonce)
        {
            RequireReviewedRecord(accountId, nonce, configurationNonce);
            ExecuteRecovery(accountId);
        }

        private static void RequireReviewedRecord(UInt160 accountId, BigInteger nonce, BigInteger configurationNonce)
        {
            ExecutionEngine.Assert(ModuleSupport.AccountConfigurationNonce(accountId) == configurationNonce,
                ModuleProtocol.ErrEpochStale);
            ExecutionEngine.Assert((BigInteger)RequirePending(accountId)[FieldNonce] == nonce, ModuleProtocol.ErrEpochStale);
        }

        /// <summary>The nonce of the last executed recovery, or 0.</summary>
        [Safe]
        public static BigInteger GetExecutedRecoveryNonce(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ModuleSupport.Key(Prefix_Nonce, accountId));
            return data == null ? BigInteger.Zero : (BigInteger)data!;
        }

        // ---- internals ----

        private static object[] LoadRecord(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ModuleSupport.Key(Prefix_Recovery, accountId));
            if (data == null) return EmptyRecord();
            object[] record = (object[])StdLib.Deserialize(data!);
            ExecutionEngine.Assert(record.Length == RecordFields, ModuleProtocol.ErrOperationMalformed);
            return record;
        }

        private static object[] EmptyRecord()
        {
            object[] record = new object[RecordFields];
            record[FieldNonce] = BigInteger.Zero;
            record[FieldCustodian] = UInt160.Zero;
            record[FieldStartedAt] = BigInteger.Zero;
            record[FieldExecutableAt] = BigInteger.Zero;
            record[FieldStatus] = StatusNone;
            record[FieldNewCustody] = UInt160.Zero;
            record[FieldAuthorityEpochAtInit] = BigInteger.Zero;
            return record;
        }

        private static object[] RequirePending(UInt160 accountId)
        {
            object[] record = LoadRecord(accountId);
            ExecutionEngine.Assert((int)(BigInteger)record[FieldStatus] == StatusPending,
                ModuleProtocol.ErrRecoveryPending);
            return record;
        }
    }
}
