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
    /// Module-owned configuration governance (SA-MODULE-PROTOCOL §10).
    ///
    /// The native core executes generic configuration actions atomically but
    /// stores no delay, intent, window or conflict state. This module owns all
    /// of it:
    ///
    ///   propose  — pin the exact serialized actions, the authority epoch, the
    ///              configuration nonce and a derived resource set;
    ///   confirm  — after the uniform 24 h delay, resubmit the exact bytes in
    ///              the 7-day window and land them through the core's narrow
    ///              <c>applyConfigurationActions</c> (or <c>unfreezeAccount</c>)
    ///              sink, which advances the nonce exactly once;
    ///   cancel   — custody may withdraw an unexpired intent; anyone may clean
    ///              an expired one.
    ///
    /// Freeze and credential revocation stay on their immediate native paths
    /// and never wait for this module. Storage is per account and per module
    /// instance: <c>prefix ‖ accountId ‖ moduleId</c>. The instance pointer
    /// stored by <see cref="ModuleSupport.BindInstance"/> makes a reset (which
    /// allocates a new module id) leave the old namespace unreachable.
    /// </summary>
    [DisplayName("GovernanceModule")]
    [ContractPermission("*", "getAccount")]
    [ContractPermission("*", "getModules")]
    [ContractPermission("*", "getModule")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModuleProfile")]
    [ContractPermission("*", "getContract")]
    [ContractPermission("*", "applyConfigurationActions")]
    [ContractPermission("*", "unfreezeAccount")]
    [ManifestExtra("Description", "Module-owned configuration-intent governance")]
    public class GovernanceModule : SmartContract
    {
        // Governance is a validator instance; it publishes the optional
        // governance capability so the core resolves it as an administration
        // caller. It has no configure callback: its policy is fixed and its
        // only mutable state is the intent set.
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"governance\":true,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"GovernanceModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Intent = new byte[] { 0x01 };
        private static readonly byte[] Prefix_IntentCount = new byte[] { 0x02 };
        private static readonly byte[] Prefix_Completion = new byte[] { 0x03 };

        private const long MaturityMs = 24L * 60 * 60 * 1000;
        private const long ExpiryWindowMs = 7L * 24 * 60 * 60 * 1000;

        private const int MaxPendingIntents = 16;
        private const int MaxActionsPerIntent = 16;
        private const int MaxReadSetEntries = 16;
        private const int MaxResourceKeyLength = 64;
        private const int MaxDataEntries = 64;

        private const string KindConfigure = "configure";
        private const string KindUnfreeze = "unfreeze";
        private const string ResourceBuiltinPolicy = "builtinPolicy";
        private const string ResourceRequiredValidator = "requiredValidator";
        private const string ResourceUnfreeze = "unfreeze";

        private static readonly byte[] ResourceModulePrefix = new byte[]
        {
            0x6D, 0x6F, 0x64, 0x75, 0x6C, 0x65, 0x3A,
        };

        private static readonly byte[] ResourceModuleIdPrefix = new byte[]
        {
            0x6D, 0x6F, 0x64, 0x75, 0x6C, 0x65, 0x49, 0x64, 0x3A,
        };

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
        public delegate void ConfigurationInvalidatedHandler(UInt160 accountId, BigInteger intentId, BigInteger reason);

        [DisplayName("ConfigurationProposed")]
        public static event ConfigurationProposedHandler OnConfigurationProposed = default!;
        [DisplayName("ConfigurationConfirmed")]
        public static event ConfigurationConfirmedHandler OnConfigurationConfirmed = default!;
        [DisplayName("ConfigurationCancelled")]
        public static event ConfigurationCancelledHandler OnConfigurationCancelled = default!;
        [DisplayName("ConfigurationExpired")]
        public static event ConfigurationExpiredHandler OnConfigurationExpired = default!;
        [DisplayName("ConfigurationInvalidated")]
        public static event ConfigurationInvalidatedHandler OnConfigurationInvalidated = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;
        [Safe]
        public static UInt160 AuthorizedCore() => ModuleSupport.Core();
        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        /// <summary>The uniform review delay, in milliseconds.</summary>
        [Safe]
        public static BigInteger ConfigurationMaturity() => MaturityMs;

        /// <summary>The post-maturity confirmation window, in milliseconds.</summary>
        [Safe]
        public static BigInteger ConfigurationExpiryWindow() => ExpiryWindowMs;

        // ---- lifecycle ----

        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert(moduleType == ModuleProtocol.ModuleTypeValidator, ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(initData == null || initData.Length == 0, ModuleProtocol.ErrOperationMalformed);
            ModuleSupport.BindInstance(accountId, moduleId);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ModuleSupport.DeleteInstancePrefix(Prefix_Intent, accountId, moduleId);
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_IntentCount, accountId, moduleId));
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_Completion, accountId, moduleId));
            ModuleSupport.ReleaseInstance(accountId, moduleId);
        }

        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            ModuleSupport.RequireValidationInstance(accountId);
            return false;
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            ModuleSupport.RequireCore();
            BigInteger moduleId = ModuleSupport.Instance(accountId);
            if (moduleId < 1) return;
            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_Completion, accountId, moduleId),
                StdLib.Serialize(new object[] { Runtime.Time }));
        }

        [Safe]
        public static object[] GetLastCompletion(UInt160 accountId)
        {
            BigInteger moduleId = ModuleSupport.Instance(accountId);
            if (moduleId < 1) return new object[0];
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ModuleSupport.Key(Prefix_Completion, accountId, moduleId));
            return data == null ? new object[0] : (object[])StdLib.Deserialize(data!);
        }

        // ---- proposal path ----

        /// <summary>
        /// Proposes one to sixteen configuration actions. Action 11 is the sole
        /// unfreeze action and must travel alone; core actions form one
        /// consecutive group. The exact bytes, epoch, nonce and resource set are
        /// pinned until maturity and expiry.
        /// </summary>
        public static BigInteger ProposeConfiguration(UInt160 accountId, object[] actions, object[] readSet)
        {
            ModuleSupport.RequireCustody(accountId);
            BigInteger moduleId = RequireBoundInstance(accountId);
            ExecutionEngine.Assert(actions != null && actions.Length > 0, ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(actions!.Length <= MaxActionsPerIntent, ModuleProtocol.ErrModuleLimitActions);
            bool unfreeze = ValidateActions(actions);
            object[] account = ModuleSupport.AccountRecord(accountId);
            RequireProposalStatus((BigInteger)account[ModuleSupport.FieldStatus], unfreeze);

            CleanupExpired(accountId, moduleId);
            ByteString encoded = StdLib.Serialize(ModuleSupport.Copy(actions));
            object[] resources = Resources(actions, readSet);
            BigInteger epoch = (BigInteger)account[ModuleSupport.FieldAuthorityEpoch];
            BigInteger nonce = (BigInteger)account[ModuleSupport.FieldConfigurationNonce];
            ByteString digest = Commitment(accountId, moduleId, epoch, nonce, encoded);
            RequireCapacityAndUnique(accountId, moduleId, digest, resources);

            BigInteger proposedAt = Runtime.Time;
            BigInteger matureAt = proposedAt + MaturityMs;
            BigInteger intentId = AllocateIntentId(accountId, moduleId);
            string kind = unfreeze ? KindUnfreeze : KindConfigure;
            object[] record = new object[RecordFields];
            record[FieldId] = intentId;
            record[FieldKind] = kind;
            record[FieldProposedAt] = proposedAt;
            record[FieldMatureAt] = matureAt;
            record[FieldExpiresAt] = matureAt + ExpiryWindowMs;
            record[FieldAuthorityEpoch] = epoch;
            record[FieldConfigurationNonce] = nonce;
            record[FieldDigest] = digest;
            record[FieldActions] = encoded;
            record[FieldReadSet] = StdLib.Serialize(resources);
            Storage.Put(Storage.CurrentContext, IntentKey(accountId, moduleId, intentId),
                StdLib.Serialize(record));

            OnConfigurationProposed(accountId, intentId, kind, matureAt, actions!.Length);
            return intentId;
        }

        /// <summary>Confirms and atomically executes the exact reviewed actions.</summary>
        public static void ConfirmConfiguration(UInt160 accountId, BigInteger intentId, object[] actions)
        {
            ModuleSupport.RequireCustody(accountId);
            BigInteger moduleId = RequireBoundInstance(accountId);
            object[] record = RequireIntent(accountId, moduleId, intentId);
            bool unfreeze = (string)record[FieldKind] == KindUnfreeze;
            object[] account = ModuleSupport.AccountRecord(accountId);
            RequireProposalStatus((BigInteger)account[ModuleSupport.FieldStatus], unfreeze);

            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)record[FieldMatureAt], ModuleProtocol.ErrIntentImmature);
            ExecutionEngine.Assert(Runtime.Time <= (BigInteger)record[FieldExpiresAt], ModuleProtocol.ErrIntentExpired);
            ExecutionEngine.Assert((BigInteger)account[ModuleSupport.FieldAuthorityEpoch]
                == (BigInteger)record[FieldAuthorityEpoch], ModuleProtocol.ErrEpochStale);
            ExecutionEngine.Assert((BigInteger)account[ModuleSupport.FieldConfigurationNonce]
                == (BigInteger)record[FieldConfigurationNonce], ModuleProtocol.ErrConfigurationNonceStale);

            ExecutionEngine.Assert(actions != null, ModuleProtocol.ErrOperationMalformed);
            ByteString submitted = StdLib.Serialize(ModuleSupport.Copy(actions));
            ExecutionEngine.Assert(StdLib.MemoryCompare((ByteString)record[FieldActions]!, submitted) == 0,
                ModuleProtocol.ErrOperationMalformed);
            bool submittedUnfreeze = ValidateActions(actions!);
            ExecutionEngine.Assert(submittedUnfreeze == unfreeze, ModuleProtocol.ErrIntentConflict);
            object[] committed = (object[])StdLib.Deserialize((ByteString)record[FieldActions]!);
            object[] resources = (object[])StdLib.Deserialize((ByteString)record[FieldReadSet]!);

            // The record is consumed before the landing write: a replayed
            // confirmation finds no intent instead of landing twice.
            Storage.Delete(Storage.CurrentContext, IntentKey(accountId, moduleId, intentId));
            if (unfreeze) ModuleSupport.UnfreezeAccount(accountId);
            else
                Contract.Call(ModuleSupport.RequireCoreConfigured(), "applyConfigurationActions", CallFlags.All,
                    new object[] { accountId, committed });

            object[] after = ModuleSupport.AccountRecord(accountId);
            ExecutionEngine.Assert((BigInteger)after[ModuleSupport.FieldConfigurationNonce]
                == (BigInteger)account[ModuleSupport.FieldConfigurationNonce] + 1,
                ModuleProtocol.ErrConfigurationNonceStale);
            if (unfreeze)
                ExecutionEngine.Assert((BigInteger)after[ModuleSupport.FieldAuthorityEpoch]
                    == (BigInteger)account[ModuleSupport.FieldAuthorityEpoch] + 1,
                    ModuleProtocol.ErrEpochStale);
            else
                ExecutionEngine.Assert((BigInteger)after[ModuleSupport.FieldAuthorityEpoch]
                    == (BigInteger)account[ModuleSupport.FieldAuthorityEpoch],
                    ModuleProtocol.ErrEpochStale);

            InvalidateStaleAndConflicting(accountId, moduleId, resources);
            OnConfigurationConfirmed(accountId, intentId);
        }

        /// <summary>Cancels an intent, or lets anyone clean an expired one.</summary>
        public static void CancelConfiguration(UInt160 accountId, BigInteger intentId)
        {
            BigInteger moduleId = ModuleSupport.Instance(accountId);
            ExecutionEngine.Assert(moduleId >= 1, ModuleProtocol.ErrModuleNotInstalled);
            object[] record = RequireIntent(accountId, moduleId, intentId);
            if (Runtime.Time > (BigInteger)record[FieldExpiresAt])
            {
                Storage.Delete(Storage.CurrentContext, IntentKey(accountId, moduleId, intentId));
                OnConfigurationExpired(accountId, intentId);
                return;
            }

            ModuleSupport.RequireCustody(accountId);
            if (ModuleSupport.AccountStatus(accountId) == ModuleProtocol.StatusFrozen)
                ExecutionEngine.Assert((string)record[FieldKind] == KindUnfreeze, ModuleProtocol.ErrAccountFrozen);
            Storage.Delete(Storage.CurrentContext, IntentKey(accountId, moduleId, intentId));
            OnConfigurationCancelled(accountId, intentId);
        }

        /// <summary>Convenience wrapper for the single-action unfreeze intent.</summary>
        public static BigInteger UnfreezeAccount(UInt160 accountId) =>
            ProposeConfiguration(accountId, new object[] { new object[] { ModuleProtocol.ActionUnfreeze } }, new object[0]);

        // ---- reads ----

        [Safe]
        public static object[] GetPendingConfiguration(UInt160 accountId, BigInteger intentId)
        {
            BigInteger moduleId = ModuleSupport.Instance(accountId);
            if (moduleId < 1) return new object[0];
            ByteString? data = Storage.Get(Storage.CurrentContext, IntentKey(accountId, moduleId, intentId));
            if (data == null) return new object[0];
            object[] record = DecodeIntent(data!);
            object[] actions = (object[])StdLib.Deserialize((ByteString)record[FieldActions]!);
            return new object[]
            {
                record[FieldId], record[FieldKind], record[FieldProposedAt], record[FieldMatureAt],
                record[FieldExpiresAt], record[FieldAuthorityEpoch], record[FieldConfigurationNonce],
                record[FieldDigest], actions.Length,
            };
        }

        [Safe]
        public static object[] GetPendingConfigurationIntentIds(UInt160 accountId)
        {
            BigInteger moduleId = ModuleSupport.Instance(accountId);
            if (moduleId < 1) return new object[0];
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                ModuleSupport.Key(Prefix_Intent, accountId, moduleId), FindOptions.ValuesOnly);
            object[] ids = new object[MaxPendingIntents];
            int count = 0;
            while (iterator.Next())
            {
                ExecutionEngine.Assert(count < MaxPendingIntents, ModuleProtocol.ErrIntentLimit);
                ids[count++] = DecodeIntent((ByteString)iterator.Value)[FieldId];
            }
            object[] result = new object[count];
            for (int i = 0; i < count; i++) result[i] = ids[i];
            return result;
        }

        // ---- validation ----

        private static bool ValidateActions(object[] actions)
        {
            bool unfreeze = false;
            bool nonCoreSeen = false;
            for (int i = 0; i < actions.Length; i++)
            {
                object[] action = (object[])actions[i];
                ExecutionEngine.Assert(action.Length >= 1, ModuleProtocol.ErrOperationMalformed);
                BigInteger code = (BigInteger)action[0];
                bool coreAction = code == ModuleProtocol.ActionInstallModule
                    || code == ModuleProtocol.ActionUninstallModule
                    || code == ModuleProtocol.ActionConfigureModule
                    || code == ModuleProtocol.ActionSetBuiltinAuthorization
                    || code == ModuleProtocol.ActionSetRequiredValidator;
                if (coreAction)
                {
                    // Core writes must stay one consecutive group; a module
                    // action may precede or follow it but not split it.
                    ExecutionEngine.Assert(!nonCoreSeen, ModuleProtocol.ErrOperationMalformed);
                }
                else nonCoreSeen = true;

                if (code == ModuleProtocol.ActionInstallModule)
                {
                    ExecutionEngine.Assert(action.Length == 5, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[1] is BigInteger, ModuleProtocol.ErrOperationMalformed);
                    BigInteger moduleType = (BigInteger)action[1];
                    ExecutionEngine.Assert(moduleType == ModuleProtocol.ModuleTypeValidator
                        || moduleType == ModuleProtocol.ModuleTypeHook
                        || moduleType == ModuleProtocol.ModuleTypeRecovery, ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[2] is ByteString, ModuleProtocol.ErrOperationMalformed);
                    UInt160 contractHash = (UInt160)action[2];
                    ExecutionEngine.Assert(contractHash != UInt160.Zero && contractHash.IsValid,
                        ModuleProtocol.ErrOperationMalformed);
                    ExecutionEngine.Assert(action[3] is ByteString profileDigest && profileDigest.Length == 32,
                        ModuleProtocol.ErrOperationMalformed);
                    object[] initData = (object[])action[4];
                    ExecutionEngine.Assert(initData.Length <= MaxDataEntries, ModuleProtocol.ErrOperationMalformed);
                }
                else if (code == ModuleProtocol.ActionUninstallModule)
                {
                    ExecutionEngine.Assert(action.Length == 3, ModuleProtocol.ErrOperationMalformed);
                    RequireModuleId(action[1]);
                    object[] deInitData = (object[])action[2];
                    ExecutionEngine.Assert(deInitData.Length <= MaxDataEntries, ModuleProtocol.ErrOperationMalformed);
                }
                else if (code == ModuleProtocol.ActionConfigureModule)
                {
                    ExecutionEngine.Assert(action.Length == 3, ModuleProtocol.ErrOperationMalformed);
                    RequireModuleId(action[1]);
                    object[] configData = (object[])action[2];
                    ExecutionEngine.Assert(configData.Length <= MaxDataEntries, ModuleProtocol.ErrOperationMalformed);
                }
                else if (code == ModuleProtocol.ActionSetBuiltinAuthorization)
                {
                    ExecutionEngine.Assert(action.Length == 3 && action[1] is bool && action[2] is bool,
                        ModuleProtocol.ErrOperationMalformed);
                }
                else if (code == ModuleProtocol.ActionSetRequiredValidator)
                {
                    ExecutionEngine.Assert(action.Length == 3 && action[2] is bool,
                        ModuleProtocol.ErrOperationMalformed);
                    RequireModuleId(action[1]);
                }
                else if (code == ModuleProtocol.ActionUnfreeze)
                {
                    ExecutionEngine.Assert(action.Length == 1 && actions.Length == 1,
                        ModuleProtocol.ErrOperationMalformed);
                    unfreeze = true;
                }
                else
                {
                    ExecutionEngine.Assert(false, ModuleProtocol.ErrOperationMalformed);
                }
            }
            return unfreeze;
        }

        private static void RequireModuleId(object value)
        {
            ExecutionEngine.Assert(value is BigInteger, ModuleProtocol.ErrOperationMalformed);
            BigInteger moduleId = (BigInteger)value;
            ExecutionEngine.Assert(moduleId >= 1 && moduleId < (BigInteger.One << 64),
                ModuleProtocol.ErrOperationMalformed);
        }

        private static object[] Resources(object[] actions, object[] readSet)
        {
            ExecutionEngine.Assert(readSet != null && readSet.Length <= MaxReadSetEntries,
                ModuleProtocol.ErrOperationMalformed);
            object[] collected = new object[MaxActionsPerIntent * 2 + MaxReadSetEntries];
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
                    || code == ModuleProtocol.ActionConfigureModule)
                {
                    collected[count++] = InstanceResourceKey((BigInteger)action[1]);
                }
                else if (code == ModuleProtocol.ActionSetBuiltinAuthorization)
                {
                    collected[count++] = (ByteString)ResourceBuiltinPolicy;
                }
                else if (code == ModuleProtocol.ActionSetRequiredValidator)
                {
                    collected[count++] = (ByteString)ResourceRequiredValidator;
                    collected[count++] = InstanceResourceKey((BigInteger)action[1]);
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

        private static ByteString ContractResourceKey(UInt160 contractHash) =>
            (ByteString)Helper.Concat(ResourceModulePrefix, (byte[])contractHash);
        private static ByteString InstanceResourceKey(BigInteger moduleId) =>
            (ByteString)Helper.Concat(ResourceModuleIdPrefix, ModuleSupport.U64BE(moduleId));

        private static ByteString Commitment(UInt160 accountId, BigInteger moduleId, BigInteger epoch,
            BigInteger nonce, ByteString encoded)
        {
            byte[] domain = Helper.Concat(
                Helper.Concat(Helper.Concat(new byte[] { 0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74,
                    0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F, 0x47, 0x6F, 0x76, 0x65, 0x72, 0x6E,
                    0x61, 0x6E, 0x63, 0x65 }, new byte[] { 4 }), ModuleSupport.CoreHash()),
                Helper.Concat((byte[])accountId, ModuleSupport.U64BE(moduleId)));
            byte[] bound = Helper.Concat(domain,
                Helper.Concat(Helper.Concat(ModuleSupport.U64BE(epoch), ModuleSupport.U64BE(nonce)), (byte[])encoded));
            return CryptoLib.Sha256((ByteString)bound);
        }

        private static void RequireCapacityAndUnique(UInt160 accountId, BigInteger moduleId, ByteString digest,
            object[] resources)
        {
            Map<ByteString, bool> indexed = ResourceSet(resources);
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                ModuleSupport.Key(Prefix_Intent, accountId, moduleId), FindOptions.ValuesOnly);
            int pending = 0;
            while (iterator.Next())
            {
                pending++;
                ExecutionEngine.Assert(pending <= MaxPendingIntents, ModuleProtocol.ErrIntentLimit);
                object[] record = DecodeIntent((ByteString)iterator.Value);
                ExecutionEngine.Assert(StdLib.MemoryCompare((ByteString)record[FieldDigest]!, digest) != 0,
                    ModuleProtocol.ErrIntentConflict);
                object[] theirs = (object[])StdLib.Deserialize((ByteString)record[FieldReadSet]!);
                ExecutionEngine.Assert(!Intersects(theirs, indexed), ModuleProtocol.ErrIntentConflict);
            }
            ExecutionEngine.Assert(pending < MaxPendingIntents, ModuleProtocol.ErrIntentLimit);
        }

        private static Map<ByteString, bool> ResourceSet(object[] resources)
        {
            Map<ByteString, bool> indexed = new();
            for (int i = 0; i < resources.Length; i++) indexed[(ByteString)resources[i]] = true;
            return indexed;
        }

        private static bool Intersects(object[] pending, Map<ByteString, bool> indexed)
        {
            for (int i = 0; i < pending.Length; i++)
                if (indexed.HasKey((ByteString)pending[i])) return true;
            return false;
        }

        private static void CleanupExpired(UInt160 accountId, BigInteger moduleId)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                ModuleSupport.Key(Prefix_Intent, accountId, moduleId), FindOptions.ValuesOnly);
            while (iterator.Next())
            {
                object[] record = DecodeIntent((ByteString)iterator.Value);
                if (Runtime.Time > (BigInteger)record[FieldExpiresAt])
                {
                    Storage.Delete(Storage.CurrentContext,
                        IntentKey(accountId, moduleId, (BigInteger)record[FieldId]));
                    OnConfigurationExpired(accountId, (BigInteger)record[FieldId]);
                }
            }
        }

        private static void InvalidateStaleAndConflicting(UInt160 accountId, BigInteger moduleId, object[] resources)
        {
            object[] account = ModuleSupport.AccountRecord(accountId);
            BigInteger epoch = (BigInteger)account[ModuleSupport.FieldAuthorityEpoch];
            BigInteger nonce = (BigInteger)account[ModuleSupport.FieldConfigurationNonce];
            Map<ByteString, bool> indexed = ResourceSet(resources);
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                ModuleSupport.Key(Prefix_Intent, accountId, moduleId), FindOptions.ValuesOnly);
            while (iterator.Next())
            {
                object[] record = DecodeIntent((ByteString)iterator.Value);
                BigInteger reason = BigInteger.Zero;
                if ((BigInteger)record[FieldAuthorityEpoch] != epoch
                    || (BigInteger)record[FieldConfigurationNonce] != nonce)
                {
                    reason = BigInteger.One;
                }
                else if (Intersects((object[])StdLib.Deserialize((ByteString)record[FieldReadSet]!), indexed))
                {
                    reason = BigInteger.One + BigInteger.One;
                }
                if (reason == BigInteger.Zero) continue;
                Storage.Delete(Storage.CurrentContext, IntentKey(accountId, moduleId, (BigInteger)record[FieldId]));
                OnConfigurationInvalidated(accountId, (BigInteger)record[FieldId], reason);
            }
        }

        private static void RequireProposalStatus(BigInteger status, bool unfreeze)
        {
            if (unfreeze)
            {
                ExecutionEngine.Assert(status == ModuleProtocol.StatusActive || status == ModuleProtocol.StatusFrozen,
                    ModuleProtocol.ErrAccountStatus);
                return;
            }
            if (status == ModuleProtocol.StatusFrozen)
                ExecutionEngine.Assert(false, ModuleProtocol.ErrAccountFrozen);
            ExecutionEngine.Assert(status == ModuleProtocol.StatusActive, ModuleProtocol.ErrAccountStatus);
        }

        // ---- instance binding ----

        /// <summary>The instance bound to this account, asserted to be this contract's live governance seat.</summary>
        private static BigInteger RequireBoundInstance(UInt160 accountId)
        {
            BigInteger moduleId = ModuleSupport.RequireInstanceBinding(accountId);
            object[] descriptor = ModuleSupport.ModuleDescriptor(accountId, moduleId);
            ExecutionEngine.Assert((UInt160)descriptor[ModuleSupport.FieldModuleContractHash]
                == Runtime.ExecutingScriptHash, ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert((BigInteger)descriptor[ModuleSupport.FieldModuleType]
                == ModuleProtocol.ModuleTypeValidator, ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert((bool)descriptor[ModuleSupport.FieldModuleGovernance],
                ModuleProtocol.ErrUnauthorized);
            ModuleSupport.RequireLiveCodeBinding(Runtime.ExecutingScriptHash, descriptor);
            return moduleId;
        }

        // ---- storage ----

        private static BigInteger AllocateIntentId(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ModuleSupport.Key(Prefix_IntentCount, accountId, moduleId));
            BigInteger next = data == null ? BigInteger.One : (BigInteger)data! + 1;
            ExecutionEngine.Assert(next < (BigInteger.One << 64), ModuleProtocol.ErrIntentLimit);
            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_IntentCount, accountId, moduleId), next);
            return next;
        }

        private static byte[] IntentKey(UInt160 accountId, BigInteger moduleId, BigInteger intentId) =>
            ModuleSupport.Key(Prefix_Intent, accountId, moduleId, intentId);

        private static object[] RequireIntent(UInt160 accountId, BigInteger moduleId, BigInteger intentId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, IntentKey(accountId, moduleId, intentId));
            ExecutionEngine.Assert(data != null, ModuleProtocol.ErrIntentNotFound);
            return DecodeIntent(data!);
        }

        private static object[] DecodeIntent(ByteString data)
        {
            object[] record = (object[])StdLib.Deserialize(data);
            ExecutionEngine.Assert(record.Length == RecordFields, ModuleProtocol.ErrOperationMalformed);
            return record;
        }
    }
}
