using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Configuration intents (protocol v4, spec §10): 0x55 intent records and
    /// the bounded 0x5E unresolved-intent index. Every normal configuration
    /// change is one atomic, 24h-timelocked intent — there is no timelock
    /// bypass through batching. Registration (fresh accounts), emergency
    /// freeze, callback-free credential revocation and callback-free recovery
    /// are the only immediate paths and never route through this file.
    ///
    /// Slot model (design report §6.3): the installer/configurator/recovery
    /// pending slots are realized as (a) recovery never being a configuration
    /// intent — it owns 0x59 — and (b) module-lifecycle vs account-policy
    /// intents conflicting through their resource keys, so only truly
    /// independent proposals run in parallel.
    /// </summary>
    public partial class SmartAccount
    {
        // ========================================================================
        // 1. Intent record + bounded index access (0x55 / 0x5E)
        // ========================================================================

        private static ConfigurationIntentRecord? GetConfigurationIntent(UInt160 accountId, BigInteger intentId)
        {
            if (intentId <= 0 || (intentId >> 64) != BigInteger.Zero) return null;
            byte[] key = Helper.Concat(
                Helper.Concat(Prefix_ConfigIntent, (byte[])accountId), ModuleIdKeyBytes(intentId));
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data == null ? null : (ConfigurationIntentRecord)StdLib.Deserialize(data!);
        }

        private static void PutConfigurationIntent(UInt160 accountId, ConfigurationIntentRecord intent)
        {
            byte[] key = Helper.Concat(
                Helper.Concat(Prefix_ConfigIntent, (byte[])accountId), ModuleIdKeyBytes(intent.IntentId));
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(intent));
        }

        /// <summary>Deletes an intent record and removes it from the 0x5E index.</summary>
        private static void DropConfigurationIntent(UInt160 accountId, BigInteger intentId)
        {
            byte[] key = Helper.Concat(
                Helper.Concat(Prefix_ConfigIntent, (byte[])accountId), ModuleIdKeyBytes(intentId));
            Storage.Delete(Storage.CurrentContext, key);

            BigInteger[] index = GetIntentIndex(accountId);
            int write = 0;
            for (int i = 0; i < index.Length; i++)
            {
                if (index[i] == intentId) continue;
                index[write] = index[i];
                write++;
            }
            if (write == index.Length) return;
            BigInteger[] updated = new BigInteger[write];
            for (int i = 0; i < write; i++) updated[i] = index[i];
            PutIntentIndex(accountId, updated);
        }

        private static BigInteger[] GetIntentIndex(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ConfigIntentIndexKey(accountId));
            if (data == null) return new BigInteger[0];
            return (BigInteger[])StdLib.Deserialize(data!);
        }

        private static void PutIntentIndex(UInt160 accountId, BigInteger[] intentIds)
        {
            if (intentIds.Length == 0)
            {
                Storage.Delete(Storage.CurrentContext, ConfigIntentIndexKey(accountId));
                return;
            }
            Storage.Put(Storage.CurrentContext, ConfigIntentIndexKey(accountId), StdLib.Serialize(intentIds));
        }

        // ========================================================================
        // 2. Digest and resource helpers
        // ========================================================================

        /// <summary>
        /// The exact action digest an intent is bound to: SHA256 over the
        /// canonical serialization of the action array. Confirmation re-binds
        /// the submitted actions by recomputing this digest, so a matured
        /// intent can never be covertly replaced.
        /// </summary>
        private static ByteString ComputeActionsDigest(object[] actions)
        {
            return CryptoLib.Sha256(StdLib.Serialize(actions));
        }

        private static ByteString[] CollectActionResources(object[] actions, ByteString[] readSet)
        {
            // Union of the per-action write keys and the caller-declared read
            // set; duplicates are harmless (intersection checks are pairwise).
            int total = readSet.Length;
            for (int i = 0; i < actions.Length; i++)
            {
                ByteString[] keys = ResourceKeysForAction((object[])actions[i]);
                total += keys.Length;
            }
            ByteString[] resources = new ByteString[total];
            int write = 0;
            for (int i = 0; i < readSet.Length; i++)
            {
                ExecutionEngine.Assert(readSet[i] != null && readSet[i].Length <= 64, ErrorOperationMalformed);
                resources[write] = readSet[i];
                write++;
            }
            for (int i = 0; i < actions.Length; i++)
            {
                ByteString[] keys = ResourceKeysForAction((object[])actions[i]);
                for (int j = 0; j < keys.Length; j++)
                {
                    resources[write] = keys[j];
                    write++;
                }
            }
            return resources;
        }

        private static bool ResourcesIntersect(ByteString[] left, ByteString[] right)
        {
            for (int i = 0; i < left.Length; i++)
            {
                for (int j = 0; j < right.Length; j++)
                {
                    if (left[i] == right[j]) return true;
                }
            }
            return false;
        }

        /// <summary>
        /// Permissionless housekeeping: intents past their expiry window are
        /// explicitly cleaned (spec §10). Returns the pruned index.
        /// </summary>
        private static BigInteger[] PruneExpiredIntents(UInt160 accountId, BigInteger now)
        {
            BigInteger[] index = GetIntentIndex(accountId);
            int write = 0;
            for (int i = 0; i < index.Length; i++)
            {
                ConfigurationIntentRecord? intent = GetConfigurationIntent(accountId, index[i]);
                if (intent != null && intent!.ExpiresAt < now)
                {
                    DropConfigurationIntent(accountId, index[i]);
                    OnConfigurationIntentExpired(accountId, index[i]);
                    continue;
                }
                index[write] = index[i];
                write++;
            }
            if (write == index.Length) return index;
            BigInteger[] remaining = new BigInteger[write];
            for (int i = 0; i < write; i++) remaining[i] = index[i];
            return remaining;
        }

        // ========================================================================
        // 3. Public lifecycle API (spec §3.3)
        // ========================================================================

        /// <summary>
        /// Proposes one atomic configuration intent. The intent matures after
        /// the uniform 24h module-change delay and expires 7 days after
        /// maturity. Same-resource conflicts with an unresolved intent are
        /// rejected up front, so conflicting proposals never run in parallel.
        /// Returns the allocated intentId.
        /// </summary>
        public static BigInteger proposeConfiguration(UInt160 accountId, object[] actions, ByteString[] readSet)
        {
            ValidateAccountId(accountId);
            AccountControl control = RequireConfigurationIntentControl(accountId, actions);
            RequireCustodyWitness(control);

            if (readSet == null) readSet = new ByteString[0];
            ExecutionEngine.Assert(actions != null
                && actions.Length > 0 && actions.Length <= MaxActionsPerConfigurationIntent,
                ErrorModuleLimitActions);
            // Proposals are rejected up front on permanently owner-only
            // accounts when they touch the module model, so an owner never
            // waits 24h for an intent that cannot confirm.
            if (control.OwnerOnlyRecovery)
            {
                for (int i = 0; i < actions!.Length; i++)
                {
                    AssertActionPermitted(accountId, control, (object[])actions[i]);
                }
            }
            ExecutionEngine.Assert(readSet.Length <= MaxActionsPerConfigurationIntent, ErrorModuleLimitActions);
            for (int i = 0; i < actions!.Length; i++)
            {
                ValidateActionShape((object[])actions[i]);
            }

            ByteString[] resources = CollectActionResources(actions, readSet);

            BigInteger now = Runtime.Time;
            PruneExpiredIntents(accountId, now);
            BigInteger[] pending = GetIntentIndex(accountId);
            ExecutionEngine.Assert(pending.Length < MaxActiveConfigurationIntents, ErrorIntentLimit);
            for (int i = 0; i < pending.Length; i++)
            {
                ConfigurationIntentRecord? other = GetConfigurationIntent(accountId, pending[i]);
                if (other != null && ResourcesIntersect(other!.Resources, resources))
                {
                    ExecutionEngine.Assert(false, ErrorIntentConflict);
                }
            }

            BigInteger intentId = control.NextIntentId;
            if (intentId < BigInteger.One) intentId = BigInteger.One;
            ExecutionEngine.Assert((intentId >> 64) == BigInteger.Zero, ErrorModuleIdInvalid);
            control.NextIntentId = intentId + 1;
            PutAccountControl(accountId, control);

            ConfigurationIntentRecord intent = new ConfigurationIntentRecord();
            intent.IntentId = intentId;
            intent.ProposedAt = now;
            intent.MatureAt = now + ModuleChangeDelayMs;
            intent.ExpiresAt = intent.MatureAt + ConfigurationIntentExpiryMs;
            intent.AuthorityEpoch = control.AuthorityEpoch;
            intent.ActionDigest = ComputeActionsDigest(actions);
            intent.Actions = actions;
            intent.Resources = resources;
            PutConfigurationIntent(accountId, intent);

            BigInteger[] updatedIndex = new BigInteger[pending.Length + 1];
            for (int i = 0; i < pending.Length; i++) updatedIndex[i] = pending[i];
            updatedIndex[pending.Length] = intentId;
            PutIntentIndex(accountId, updatedIndex);

            OnConfigurationIntentProposed(accountId, intentId, actions.Length, intent.ActionDigest);
            // §18 reused-event mirror: a module-affecting intent is the v4
            // form of the legacy "module update initiated" proposal.
            EmitModuleUpdateMirror(accountId, actions, true);
            return intentId;
        }

        /// <summary>
        /// Confirms a matured intent. Re-requires the custody witness, the
        /// recorded authorityEpoch, and an exact action-digest match; executes
        /// the actions atomically; advances configurationNonce once per commit;
        /// then invalidates only the stale/conflicting remaining intents.
        /// </summary>
        public static void confirmConfiguration(UInt160 accountId, BigInteger intentId, object[] actions)
        {
            ValidateAccountId(accountId);
            AccountControl control = RequireConfigurationIntentControl(accountId, actions);
            RequireCustodyWitness(control);
            AssertAccountConfigurationIdle(accountId);

            ConfigurationIntentRecord? record = GetConfigurationIntent(accountId, intentId);
            ExecutionEngine.Assert(record != null, ErrorIntentNotFound);

            BigInteger now = Runtime.Time;
            ExecutionEngine.Assert(now >= record!.MatureAt, ErrorIntentImmature);
            ExecutionEngine.Assert(now <= record.ExpiresAt, ErrorIntentExpired);
            ExecutionEngine.Assert(record.AuthorityEpoch == control.AuthorityEpoch, ErrorEpochStale);
            ExecutionEngine.Assert(actions != null, ErrorOperationMalformed);
            ExecutionEngine.Assert(ComputeActionsDigest(actions!) == record.ActionDigest, ErrorOperationMalformed);

            ExecuteConfigurationActions(accountId, control, actions!);

            // Last-validator rule (spec §10): with no validator installed the
            // built-in route MUST have been enabled within this same intent —
            // there is no automatic owner fallback.
            if (CountModulesOfType(accountId, ModuleTypeCodeValidator) == 0)
            {
                ExecutionEngine.Assert(control.DefaultOperationAuthorization, ErrorOperationMalformed);
            }

            control.ConfigurationNonce += 1;
            PutAccountControl(accountId, control);

            ByteString[] committedResources = record.Resources;
            DropConfigurationIntent(accountId, intentId);

            // Committing invalidates only the conflicting/stale intents, never
            // every pending intent (spec §10).
            BigInteger[] remaining = GetIntentIndex(accountId);
            for (int i = 0; i < remaining.Length; i++)
            {
                ConfigurationIntentRecord? other = GetConfigurationIntent(accountId, remaining[i]);
                if (other == null) continue;
                bool stale = other!.AuthorityEpoch != control.AuthorityEpoch;
                bool conflicting = ResourcesIntersect(other.Resources, committedResources);
                if (stale || conflicting)
                {
                    DropConfigurationIntent(accountId, remaining[i]);
                    OnConfigurationIntentCancelled(accountId, remaining[i]);
                }
            }

            OnConfigurationIntentConfirmed(accountId, intentId, control.ConfigurationNonce);
        }

        /// <summary>
        /// Status gate shared by propose and confirm. Configuration intents are
        /// normally Active-only, with exactly one exemption (spec §14): the
        /// migration import action is the ONLY way out of MigrationRequired, so
        /// an intent whose action set carries <see cref="ActionMigrateAccount"/>,
        /// may be proposed AND confirmed while the account is in that status.
        /// Every other action set stays Active-only (a MigrationRequired account
        /// otherwise allows queries, freeze and callback-free recovery only).
        /// </summary>
        private static AccountControl RequireConfigurationIntentControl(UInt160 accountId, object[] actions)
        {
            AccountControl control = RequireAccountControl(accountId);
            if (control.Status == AccountStatusActive) return control;
            ExecutionEngine.Assert(
                control.Status == AccountStatusMigrationRequired && ContainsMigrateAction(actions),
                ErrorAccountStatus);
            return control;
        }

        private static bool ContainsMigrateAction(object[] actions)
        {
            if (actions == null) return false;
            for (int i = 0; i < actions.Length; i++)
            {
                object[] action;
                try
                {
                    action = (object[])actions[i];
                }
                catch
                {
                    // Malformed elements are reported by ValidateActionShape;
                    // they never open the MigrationRequired exemption.
                    continue;
                }
                if (action != null && action.Length >= 1 && (BigInteger)action[0] == ActionMigrateAccount) return true;
            }
            return false;
        }

        /// <summary>
        /// Derives the §18 reused-event mirror payload for a module-affecting
        /// intent: the first install action names its type and contract hash
        /// directly; uninstall/configure/rebind actions resolve the same pair
        /// from the recorded 0x52 instance. Intents without any module action
        /// (policy/message/migration-only) emit no legacy mirror.
        /// </summary>
        private static void EmitModuleUpdateMirror(UInt160 accountId, object[] actions, bool initiated)
        {
            for (int i = 0; i < actions.Length; i++)
            {
                object[] action = (object[])actions[i]!;
                BigInteger code = (BigInteger)action[0];
                BigInteger typeCode;
                UInt160 contractHash;
                if (code == ActionInstallModule)
                {
                    typeCode = (BigInteger)action[1];
                    contractHash = (UInt160)action[2]!;
                }
                else if (code == ActionUninstallModule || code == ActionConfigureModule || code == ActionRebindModuleCode)
                {
                    ModuleInstance? module = GetModuleInstance(accountId, (BigInteger)action[1]);
                    if (module == null) continue;
                    typeCode = module!.ModuleType;
                    contractHash = module.ContractHash!;
                }
                else
                {
                    continue;
                }
                if (initiated)
                {
                    OnModuleUpdateInitiated(accountId, ModuleTypeNameFromCode((int)typeCode), contractHash);
                }
                else
                {
                    OnModuleUpdateCancelled(accountId, ModuleTypeNameFromCode((int)typeCode), contractHash);
                }
                return;
            }
        }

        /// <summary>
        /// Cancels an unresolved intent. A live intent requires the custody
        /// witness on an active account; an expired intent may be cleaned by
        /// anyone (explicit expiry cleanup).
        /// </summary>
        public static void cancelConfiguration(UInt160 accountId, BigInteger intentId)
        {
            ValidateAccountId(accountId);
            ConfigurationIntentRecord? record = GetConfigurationIntent(accountId, intentId);
            ExecutionEngine.Assert(record != null, ErrorIntentNotFound);

            bool expired = record!.ExpiresAt < Runtime.Time;
            if (!expired)
            {
                AccountControl control = RequireAccountActive(accountId);
                RequireCustodyWitness(control);
                DropConfigurationIntent(accountId, intentId);
                OnConfigurationIntentCancelled(accountId, intentId);
                // §18 reused-event mirror for a cancelled module-affecting intent.
                EmitModuleUpdateMirror(accountId, record.Actions, false);
                return;
            }
            DropConfigurationIntent(accountId, intentId);
            OnConfigurationIntentExpired(accountId, intentId);
        }

        // ========================================================================
        // 4. Intent queries
        // ========================================================================

        /// <summary>
        /// Returns [exists, intentId, proposedAt, matureAt, expiresAt,
        /// authorityEpoch, actionDigest, actions[]]; an empty array when the
        /// intent does not exist.
        /// </summary>
        [Safe]
        public static object[] getPendingConfiguration(UInt160 accountId, BigInteger intentId)
        {
            ValidateAccountId(accountId);
            ConfigurationIntentRecord? record = GetConfigurationIntent(accountId, intentId);
            if (record == null) return new object[0];
            return new object[]
            {
                true,
                record!.IntentId,
                record.ProposedAt,
                record.MatureAt,
                record.ExpiresAt,
                record.AuthorityEpoch,
                record.ActionDigest,
                record.Actions
            };
        }

        /// <summary>Unresolved intent ids (bounded by MaxActiveConfigurationIntents).</summary>
        [Safe]
        public static BigInteger[] getPendingConfigurationIntentIds(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            return GetIntentIndex(accountId);
        }

        // ========================================================================
        // 5. Action dispatch (spec §9)
        // ========================================================================

        /// <summary>
        /// True for actions that change the module model (install, uninstall,
        /// configure, hook order, code rebinding, threshold policies). On a
        /// permanently owner-only account these are rejected — the legacy
        /// constraint is monotonic and survives migration (replaces the
        /// retired AssertPluginInstallationAllowed / AssertPluginConfigurationAllowed).
        /// </summary>
        private static bool ActionTouchesModuleModel(object[] action)
        {
            int code = (int)(BigInteger)action[0];
            return code == ActionInstallModule
                || code == ActionUninstallModule
                || code == ActionConfigureModule
                || code == ActionSetHookOrder
                || code == ActionRebindModuleCode
                || code == ActionSetThresholdPolicy;
        }

        private static void AssertActionPermitted(UInt160 accountId, AccountControl control, object[] action)
        {
            if (!control.OwnerOnlyRecovery) return;
            ExecutionEngine.Assert(!ActionTouchesModuleModel(action), "Owner-only recovery is permanent");
        }

        private static void ExecuteConfigurationActions(UInt160 accountId, AccountControl control, object[] actions)
        {
            for (int i = 0; i < actions.Length; i++)
            {
                object[] action = (object[])actions[i];
                AssertActionPermitted(accountId, control, action);
                int code = (int)(BigInteger)action[0];
                switch (code)
                {
                    case ActionInstallModule:
                        ExecuteInstallModuleAction(accountId, control, action);
                        break;
                    case ActionUninstallModule:
                        ExecuteUninstallModuleAction(accountId, control, action);
                        break;
                    case ActionConfigureModule:
                        ExecuteConfigureModuleAction(accountId, control, action);
                        break;
                    case ActionSetHookOrder:
                        ExecuteSetHookOrderAction(accountId, control, action);
                        break;
                    case ActionRebindModuleCode:
                        ExecuteRebindModuleCodeAction(accountId, control, action);
                        break;
                    case ActionSetThresholdPolicy:
                        ExecuteSetThresholdPolicyAction(accountId, control, action);
                        break;
                    case ActionSetDefaultPolicy:
                        ExecuteSetDefaultPolicyAction(accountId, control, action);
                        break;
                    case ActionSetRecoveryPolicy:
                        ExecuteSetRecoveryPolicyAction(accountId, control, action);
                        break;
                    case ActionSetMessageSubjects:
                        // Implemented in SmartAccount.Message.cs (0x57 subjects).
                        ExecuteSetMessageSubjectsAction(accountId, control, action);
                        break;
                    case ActionMigrateAccount:
                        // Implemented in SmartAccount.Migration.cs (§14).
                        ExecuteMigrateAccountAction(accountId, control, action);
                        break;
                    default:
                        ExecutionEngine.Assert(false, ErrorOperationMalformed);
                        break;
                }
            }
        }

        // [ActionSetDefaultPolicy, defaultOperationAuthorization, defaultMessageAuthorization]
        private static void ExecuteSetDefaultPolicyAction(UInt160 accountId, AccountControl control, object[] action)
        {
            ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
            control.DefaultOperationAuthorization = (bool)action[1];
            control.DefaultMessageAuthorization = (bool)action[2];
            control.DefaultPolicyRevision += 1;
        }

        // [ActionSetRecoveryPolicy, recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery]
        private static void ExecuteSetRecoveryPolicyAction(UInt160 accountId, AccountControl control, object[] action)
        {
            ExecutionEngine.Assert(action.Length == 4, ErrorOperationMalformed);
            UInt160 newAuthority = (UInt160)action[1];
            BigInteger timelockMs = (BigInteger)action[2];
            bool ownerOnly = (bool)action[3];
            ExecutionEngine.Assert(timelockMs >= RecoveryTimelockMinMs && timelockMs <= RecoveryTimelockMaxMs,
                ErrorOperationMalformed);

            // A NEW non-zero control subject additionally requires that
            // subject's witness at confirmation time (spec §10).
            if (newAuthority != UInt160.Zero && newAuthority != control.RecoveryAuthority)
            {
                ExecutionEngine.Assert(Runtime.CheckWitness(newAuthority), ErrorUnauthorized);
            }

            control.RecoveryAuthority = newAuthority;
            control.RecoveryTimelockMs = timelockMs;
            // Legacy permanent owner-only constraint is monotonic: once set it
            // survives every later change and migration.
            control.OwnerOnlyRecovery = control.OwnerOnlyRecovery || ownerOnly;
        }
    }
}
