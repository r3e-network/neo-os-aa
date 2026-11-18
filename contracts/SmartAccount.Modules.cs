using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Module collection kernel (protocol v4, spec §3.1/§3.2/§7/§16.1):
    /// 0x51 account control, 0x52 module instances, 0x53 enumeration index,
    /// 0x54 core-owned hook order, 0x5B core-owned threshold policies, the
    /// shared never-reusing moduleId allocator, on-chain code binding, the
    /// lifecycle action executors shared by configuration intents and v4
    /// registration, and the module callback adaptation layer (TODO(26)).
    ///
    /// New code NEVER routes through the legacy 0x01 Verifier/HookId pointers;
    /// those rows survive only as migration input (SmartAccount.Migration.cs).
    /// </summary>
    public partial class SmartAccount
    {
        // ========================================================================
        // 1. Account control (0x51)
        // ========================================================================

        private static AccountControl? GetAccountControl(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, AccountControlKey(accountId));
            return data == null ? null : (AccountControl)StdLib.Deserialize(data!);
        }

        private static AccountControl RequireAccountControl(UInt160 accountId)
        {
            AccountControl? control = GetAccountControl(accountId);
            ExecutionEngine.Assert(control != null, ErrorAccountNotFound);
            return control!;
        }

        /// <summary>
        /// Configuration and execution executors require the Active status: a
        /// frozen account allows only escape/unfreeze paths, and a
        /// MigrationRequired account allows only queries, freeze and
        /// callback-free recovery (spec §13).
        /// </summary>
        private static AccountControl RequireAccountActive(UInt160 accountId)
        {
            AccountControl control = RequireAccountControl(accountId);
            ExecutionEngine.Assert(control.Status == AccountStatusActive, ErrorAccountStatus);
            return control;
        }

        private static void PutAccountControl(UInt160 accountId, AccountControl control)
        {
            Storage.Put(Storage.CurrentContext, AccountControlKey(accountId), StdLib.Serialize(control));
        }

        /// <summary>Custody is the witness-bearing controller of configuration.</summary>
        private static void RequireCustodyWitness(AccountControl control)
        {
            ExecutionEngine.Assert(control.Custody != null && control.Custody != UInt160.Zero, ErrorUnauthorized);
            ExecutionEngine.Assert(Runtime.CheckWitness(control.Custody!), ErrorUnauthorized);
        }

        // ========================================================================
        // 2. Shared moduleId allocator (spec §3.1)
        //    moduleId 0 is reserved for built-in authorization; every other id
        //    is allocated monotonically per account and never reused — not for
        //    validator instances, not for threshold policy ids.
        // ========================================================================

        private static BigInteger AllocateModuleId(AccountControl control)
        {
            BigInteger next = control.NextModuleId;
            if (next < BigInteger.One) next = BigInteger.One;
            ExecutionEngine.Assert((next >> 64) == BigInteger.Zero, ErrorModuleIdInvalid);
            control.NextModuleId = next + 1;
            return next;
        }

        /// <summary>Fixed-width 8-byte big-endian encoding of a moduleId key suffix.</summary>
        private static byte[] ModuleIdKeyBytes(BigInteger moduleId)
        {
            ExecutionEngine.Assert(moduleId > 0 && (moduleId >> 64) == BigInteger.Zero, ErrorModuleIdInvalid);
            byte[] encoded = new byte[8];
            for (int i = 0; i < 8; i++)
            {
                encoded[i] = (byte)((moduleId >> (8 * (7 - i))) & 0xFF);
            }
            return encoded;
        }

        private static BigInteger ModuleIdFromKeyBytes(byte[] keyBytes)
        {
            ExecutionEngine.Assert(keyBytes != null && keyBytes.Length == 8, ErrorModuleIdInvalid);
            BigInteger value = BigInteger.Zero;
            for (int i = 0; i < 8; i++)
            {
                value = (value << 8) | (BigInteger)keyBytes![i];
            }
            return value;
        }

        // ========================================================================
        // 3. Module instances (0x52 record + 0x53 enumeration index)
        // ========================================================================

        private static ModuleInstance? GetModuleInstance(UInt160 accountId, BigInteger moduleId)
        {
            if (moduleId <= 0 || (moduleId >> 64) != BigInteger.Zero) return null;
            byte[] key = Helper.Concat(
                Helper.Concat(Prefix_ModuleInstance, (byte[])accountId), ModuleIdKeyBytes(moduleId));
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data == null ? null : (ModuleInstance)StdLib.Deserialize(data!);
        }

        private static ModuleInstance RequireModuleInstance(UInt160 accountId, BigInteger moduleId)
        {
            ModuleInstance? module = GetModuleInstance(accountId, moduleId);
            ExecutionEngine.Assert(module != null, ErrorModuleNotInstalled);
            return module!;
        }

        private static void PutModuleInstance(UInt160 accountId, BigInteger moduleId, ModuleInstance module)
        {
            byte[] idBytes = ModuleIdKeyBytes(moduleId);
            Storage.Put(Storage.CurrentContext,
                Helper.Concat(Helper.Concat(Prefix_ModuleInstance, (byte[])accountId), idBytes),
                StdLib.Serialize(module));
            // Enumeration index: key presence == installed for (account, type).
            Storage.Put(Storage.CurrentContext,
                Helper.Concat(
                    Helper.Concat(Helper.Concat(Prefix_ModuleIndex, (byte[])accountId), new byte[] { module.ModuleType }),
                    idBytes),
                new byte[] { 1 });
        }

        private static void DeleteModuleInstance(UInt160 accountId, BigInteger moduleId, ModuleInstance module)
        {
            byte[] idBytes = ModuleIdKeyBytes(moduleId);
            Storage.Delete(Storage.CurrentContext,
                Helper.Concat(Helper.Concat(Prefix_ModuleInstance, (byte[])accountId), idBytes));
            Storage.Delete(Storage.CurrentContext,
                Helper.Concat(
                    Helper.Concat(Helper.Concat(Prefix_ModuleIndex, (byte[])accountId), new byte[] { module.ModuleType }),
                    idBytes));
        }

        private static BigInteger CountModulesOfType(UInt160 accountId, int moduleType)
        {
            byte[] prefix = Helper.Concat(
                Helper.Concat(Prefix_ModuleIndex, (byte[])accountId), new byte[] { (byte)moduleType });
            BigInteger count = BigInteger.Zero;
            Iterator it = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (it.Next()) count += BigInteger.One;
            return count;
        }

        /// <summary>First installed moduleId of the given type whose contract hash matches, or 0.</summary>
        private static BigInteger FindModuleIdByContract(UInt160 accountId, int moduleType, UInt160 contractHash)
        {
            byte[] prefix = Helper.Concat(
                Helper.Concat(Prefix_ModuleIndex, (byte[])accountId), new byte[] { (byte)moduleType });
            Iterator it = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (it.Next())
            {
                BigInteger moduleId = ModuleIdFromKeyBytes((byte[])(ByteString)it.Value);
                ModuleInstance? module = GetModuleInstance(accountId, moduleId);
                if (module != null && module.ContractHash == contractHash) return moduleId;
            }
            return BigInteger.Zero;
        }

        /// <summary>
        /// Ascending module ids of the given type strictly greater than
        /// <paramref name="cursor"/>, up to <paramref name="limit"/> entries
        /// (spec §3.3: cursor is a non-reusable moduleId, never an array index).
        /// Returns [ids[], nextCursor] where nextCursor is 0 when exhausted.
        /// </summary>
        private static object[] EnumerateModuleIds(UInt160 accountId, int moduleType, BigInteger cursor, BigInteger limit)
        {
            ExecutionEngine.Assert(limit >= MinEnumerationLimit && limit <= MaxEnumerationLimit, ErrorOperationMalformed);
            ExecutionEngine.Assert(cursor >= 0, ErrorModuleIdInvalid);
            int max = (int)limit;
            BigInteger[] found = new BigInteger[max];
            int count = 0;
            byte[] prefix = Helper.Concat(
                Helper.Concat(Prefix_ModuleIndex, (byte[])accountId), new byte[] { (byte)moduleType });
            Iterator it = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (it.Next())
            {
                BigInteger moduleId = ModuleIdFromKeyBytes((byte[])(ByteString)it.Value);
                if (moduleId <= cursor) continue;
                if (count == max) break;
                found[count] = moduleId;
                count++;
            }
            BigInteger[] page = new BigInteger[count];
            for (int i = 0; i < count; i++) page[i] = found[i];
            BigInteger nextCursor = count == max ? page[count - 1] : BigInteger.Zero;
            return new object[] { page, nextCursor };
        }

        // ========================================================================
        // 4. Core-owned hook order (0x54)
        // ========================================================================

        private static HookOrderRecord GetHookOrder(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, HookOrderKey(accountId));
            if (data == null)
            {
                return new HookOrderRecord { HookIds = new BigInteger[0], Revision = BigInteger.Zero };
            }
            return (HookOrderRecord)StdLib.Deserialize(data!);
        }

        /// <summary>
        /// The hook order must be exactly the set of installed hooks (spec §3.6:
        /// every installed hook runs — a signature scheme cannot bypass account
        /// policy by omitting hooks from the order), pairwise distinct.
        /// </summary>
        private static void ValidateHookOrder(UInt160 accountId, BigInteger[] hookIds)
        {
            ExecutionEngine.Assert(hookIds != null && hookIds.Length <= MaxHookModuleInstances, ErrorModuleLimitHook);
            for (int i = 0; i < hookIds!.Length; i++)
            {
                ModuleInstance module = RequireModuleInstance(accountId, hookIds[i]);
                ExecutionEngine.Assert(module.ModuleType == ModuleTypeCodeHook, ErrorOperationMalformed);
                for (int j = 0; j < i; j++)
                {
                    ExecutionEngine.Assert(hookIds[j] != hookIds[i], ErrorOperationMalformed);
                }
            }
            ExecutionEngine.Assert(
                (BigInteger)hookIds.Length == CountModulesOfType(accountId, ModuleTypeCodeHook),
                ErrorModuleLimitHook);
        }

        private static void PutHookOrder(UInt160 accountId, HookOrderRecord order)
        {
            ValidateHookOrder(accountId, order.HookIds);
            Storage.Put(Storage.CurrentContext, HookOrderKey(accountId), StdLib.Serialize(order));
            // Every hook-order transition (install append, uninstall removal,
            // explicit reorder) emits exactly one event (spec §18).
            OnHookOrderSet(accountId, order.Revision, order.HookIds);
        }

        private static HookOrderRecord AppendHookToOrder(UInt160 accountId, BigInteger hookId)
        {
            HookOrderRecord order = GetHookOrder(accountId);
            BigInteger[] updated = new BigInteger[order.HookIds.Length + 1];
            for (int i = 0; i < order.HookIds.Length; i++) updated[i] = order.HookIds[i];
            updated[order.HookIds.Length] = hookId;
            order.HookIds = updated;
            order.Revision += 1;
            PutHookOrder(accountId, order);
            return order;
        }

        private static HookOrderRecord RemoveHookFromOrder(UInt160 accountId, BigInteger hookId)
        {
            HookOrderRecord order = GetHookOrder(accountId);
            int length = order.HookIds.Length;
            BigInteger[] updated = new BigInteger[length - 1 < 0 ? 0 : length - 1];
            int write = 0;
            bool removed = false;
            for (int i = 0; i < length; i++)
            {
                if (!removed && order.HookIds[i] == hookId)
                {
                    removed = true;
                    continue;
                }
                ExecutionEngine.Assert(write < updated.Length, ErrorModuleNotInstalled);
                updated[write] = order.HookIds[i];
                write++;
            }
            ExecutionEngine.Assert(removed, ErrorModuleNotInstalled);
            order.HookIds = updated;
            order.Revision += 1;
            PutHookOrder(accountId, order);
            return order;
        }

        // ========================================================================
        // 5. Core-owned threshold policies (0x5B)
        // ========================================================================

        private static ThresholdPolicyRecord? GetThresholdPolicy(UInt160 accountId, BigInteger policyId)
        {
            if (policyId <= 0 || (policyId >> 64) != BigInteger.Zero) return null;
            byte[] key = Helper.Concat(
                Helper.Concat(Prefix_ThresholdPolicy, (byte[])accountId), ModuleIdKeyBytes(policyId));
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data == null ? null : (ThresholdPolicyRecord)StdLib.Deserialize(data!);
        }

        private static void PutThresholdPolicy(UInt160 accountId, BigInteger policyId, ThresholdPolicyRecord policy)
        {
            // Every rewrite bumps the policy generation: member reshapes kill
            // the policy's old nonce channels and signature bindings.
            policy.CredentialGeneration += 1;
            byte[] key = Helper.Concat(
                Helper.Concat(Prefix_ThresholdPolicy, (byte[])accountId), ModuleIdKeyBytes(policyId));
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(policy));
        }

        private static bool PolicyContainsMember(ThresholdPolicyRecord policy, BigInteger moduleId)
        {
            for (int i = 0; i < policy.MemberIds.Length; i++)
            {
                if (policy.MemberIds[i] == moduleId) return true;
            }
            return false;
        }

        /// <summary>
        /// True while <paramref name="moduleId"/> is a member of any ACTIVE
        /// threshold policy. Active-policy members are never independently
        /// routable (spec §3.5) and cannot be uninstalled while referenced.
        /// </summary>
        private static bool IsMemberOfActivePolicy(UInt160 accountId, BigInteger moduleId)
        {
            byte[] prefix = Helper.Concat(Prefix_ThresholdPolicy, (byte[])accountId);
            Iterator it = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (it.Next())
            {
                BigInteger policyId = ModuleIdFromKeyBytes((byte[])(ByteString)it.Value);
                ThresholdPolicyRecord? policy = GetThresholdPolicy(accountId, policyId);
                if (policy != null && policy.Active && PolicyContainsMember(policy!, moduleId)) return true;
            }
            return false;
        }

        private static void AssertNotMemberOfOtherActivePolicy(UInt160 accountId, BigInteger moduleId, BigInteger policyId)
        {
            byte[] prefix = Helper.Concat(Prefix_ThresholdPolicy, (byte[])accountId);
            Iterator it = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (it.Next())
            {
                BigInteger otherId = ModuleIdFromKeyBytes((byte[])(ByteString)it.Value);
                if (otherId == policyId) continue;
                ThresholdPolicyRecord? other = GetThresholdPolicy(accountId, otherId);
                if (other != null && other!.Active && PolicyContainsMember(other, moduleId))
                {
                    ExecutionEngine.Assert(false, ErrorIntentConflict);
                }
            }
        }

        /// <summary>
        /// Routing eligibility (spec §3.5): the explicitly selected validator
        /// must be an installed validator instance and must not be a member of
        /// an active threshold policy (a single-member entry must never bypass
        /// the threshold).
        /// </summary>
        private static ModuleInstance RequireRoutableValidator(UInt160 accountId, BigInteger validatorId)
        {
            ModuleInstance module = RequireModuleInstance(accountId, validatorId);
            ExecutionEngine.Assert(module.ModuleType == ModuleTypeCodeValidator, ErrorModuleNotRoutable);
            ExecutionEngine.Assert(!IsMemberOfActivePolicy(accountId, validatorId), ErrorModuleNotRoutable);
            return module;
        }

        // ========================================================================
        // 6. Code binding (spec §7.3)
        // ========================================================================

        /// <summary>
        /// A module must be a deployed, non-protocol contract: the SA core
        /// itself, the natives that mutate on their caller's behalf and the
        /// asset/crypto natives are all invalid module addresses.
        /// </summary>
        private static void AssertModuleContractAddress(UInt160 contractHash)
        {
            ExecutionEngine.Assert(contractHash != null && contractHash != UInt160.Zero && contractHash.IsValid,
                ErrorOperationMalformed);
            ExecutionEngine.Assert(contractHash != Runtime.ExecutingScriptHash, ErrorOperationMalformed);
            AssertTargetIsNotProtocolOwned(contractHash!);
            ExecutionEngine.Assert(contractHash != NEO.Hash && contractHash != GAS.Hash,
                ErrorOperationMalformed);
            ExecutionEngine.Assert(contractHash != CryptoLib.Hash && contractHash != StdLib.Hash,
                ErrorOperationMalformed);
        }

        private static void CaptureCodeBinding(ModuleInstance module, Contract contract, ByteString profileDigest)
        {
            module.ContractHash = contract.Hash;
            module.ContractId = contract.Id;
            module.UpdateCounter = contract.UpdateCounter;
            module.NefSha256 = CryptoLib.Sha256(contract.Nef);
            // TODO(26): pin the digest of the module's canonical profile JSON
            // once modules ship profiles; until then it is installer-declared.
            module.ProfileSha256 = profileDigest;
        }

        /// <summary>
        /// Code-identity continuity: a callback whose module contract was
        /// destroyed, replaced or updated since installation fails the whole
        /// transaction (spec §3.6 failure rules).
        /// </summary>
        private static void AssertCodeBindingUnchanged(ModuleInstance module)
        {
            Contract? contract = ContractManagement.GetContract(module.ContractHash);
            ExecutionEngine.Assert(contract != null, ErrorModuleCodeBindingMismatch);
            ExecutionEngine.Assert(contract!.Id == module.ContractId
                && contract.UpdateCounter == module.UpdateCounter
                && CryptoLib.Sha256(contract.Nef) == module.NefSha256,
                ErrorModuleCodeBindingMismatch);
        }

        // ========================================================================
        // 7. Lifecycle action executors (spec §9)
        //    Action arrays are positional; element 0 is the action code. These
        //    executors run at intent confirmation (24h timelock served) and at
        //    atomic v4 registration (fresh account, no timelock). They mutate
        //    the passed AccountControl (module ids, default switches); the
        //    caller persists it once after the whole intent executed.
        // ========================================================================

        private static void ExecuteInstallModuleAction(UInt160 accountId, AccountControl control, object[] action)
        {
            // [ActionInstallModule, type, contractHash, profileDigest32, instanceIsolation, messageCapability, thresholdMemberEligible]
            ExecutionEngine.Assert(action.Length == 7, ErrorOperationMalformed);
            int moduleType = (int)(BigInteger)action[1];
            UInt160 contractHash = (UInt160)action[2];
            ByteString profileDigest = (ByteString)action[3];
            bool instanceIsolation = (bool)action[4];
            bool messageCapability = (bool)action[5];
            bool thresholdMemberEligible = (bool)action[6];

            ExecutionEngine.Assert(moduleType == ModuleTypeCodeValidator || moduleType == ModuleTypeCodeHook,
                ErrorModuleTypeUnsupported);
            AssertModuleContractAddress(contractHash);
            ExecutionEngine.Assert(profileDigest != null && profileDigest.Length == 32, ErrorOperationMalformed);

            BigInteger existingCount = CountModulesOfType(accountId, moduleType);
            if (moduleType == ModuleTypeCodeValidator)
            {
                ExecutionEngine.Assert(existingCount < MaxValidatorModuleInstances, ErrorModuleLimitValidator);
            }
            else
            {
                ExecutionEngine.Assert(existingCount < MaxHookModuleInstances, ErrorModuleLimitHook);
            }
            if (!instanceIsolation)
            {
                // A second instance of the same contract requires the declared
                // instance-isolation capability (spec §3.1).
                ExecutionEngine.Assert(FindModuleIdByContract(accountId, moduleType, contractHash) == 0,
                    ErrorModuleInstanceIsolationRequired);
            }

            Contract? contract = ContractManagement.GetContract(contractHash);
            ExecutionEngine.Assert(contract != null, ErrorModuleCodeBindingMismatch);
            // Install-time code binding (spec §3.1/§9): the deployed contract at
            // the requested hash must be a live, non-empty contract, and
            // CaptureCodeBinding records contractHash + updateCounter + NEF hash
            // so every later callback re-verifies the very same code
            // (AssertCodeBindingUnchanged, also re-run after onInstall).
            ExecutionEngine.Assert(contract!.Nef != null && contract!.Nef.Length > 0,
                ErrorModuleCodeBindingMismatch);
            ExecutionEngine.Assert(contract!.Manifest.Name != null && contract!.Manifest.Name.Length > 0,
                ErrorModuleCodeBindingMismatch);

            bool firstValidator = moduleType == ModuleTypeCodeValidator && existingCount == 0;

            ModuleInstance module = new ModuleInstance();
            module.ModuleType = (byte)moduleType;
            CaptureCodeBinding(module, contract!, profileDigest!);
            module.ModuleRevision = BigInteger.One;
            module.CredentialGeneration = BigInteger.One;
            module.InstanceIsolation = instanceIsolation;
            module.MessageCapability = messageCapability;
            module.ThresholdMemberEligible = thresholdMemberEligible;

            BigInteger moduleId = AllocateModuleId(control);
            PutModuleInstance(accountId, moduleId, module);

            if (moduleType == ModuleTypeCodeHook)
            {
                AppendHookToOrder(accountId, moduleId);
            }
            if (firstValidator)
            {
                // Spec §8/§15: installing the first validator disables the
                // built-in operation routing by default. There is no automatic
                // custody fallback; only emergency recovery can remove the
                // validator set afterwards.
                control.DefaultOperationAuthorization = false;
            }

            CallModuleOnInstall(accountId, moduleId, module);
            OnModuleInstanceInstalled(accountId, moduleId, module.ModuleType, contractHash, module.CredentialGeneration);
            // §18 reused-event mirror: legacy indexers keep their
            // ModuleInstalled feed across the v4 transition.
            OnModuleInstalled(accountId, ModuleTypeNameFromCode((int)module.ModuleType), contractHash!);
        }

        private static void ExecuteUninstallModuleAction(UInt160 accountId, AccountControl control, object[] action)
        {
            // [ActionUninstallModule, moduleId]
            ExecutionEngine.Assert(action.Length == 2, ErrorOperationMalformed);
            BigInteger moduleId = (BigInteger)action[1];
            ModuleInstance module = RequireModuleInstance(accountId, moduleId);

            if (module.ModuleType == ModuleTypeCodeValidator)
            {
                // A member of an active threshold policy cannot be uninstalled
                // while the policy still references it (spec §3.5).
                ExecutionEngine.Assert(!IsMemberOfActivePolicy(accountId, moduleId), ErrorIntentConflict);
                // Callback first, while the instance is still installed and its
                // phase authorization (0x58) is meaningful; a callback fault
                // reverts the whole action.
                CallModuleOnUninstall(accountId, moduleId, module);
                DeleteModuleInstance(accountId, moduleId, module);
            }
            else
            {
                CallModuleOnUninstall(accountId, moduleId, module);
                // Delete first so the order validator sees the post-removal
                // installed set.
                DeleteModuleInstance(accountId, moduleId, module);
                RemoveHookFromOrder(accountId, moduleId);
            }

            // Uninstall is callback-bound through the adaptation layer; the
            // callback-free emergency removal path (spec §6.7/§6.8) lives in
            // SmartAccount.Escape.cs and never reaches this executor.
            OnModuleInstanceRemoved(accountId, moduleId);
            // §18 reused-event mirror (fires AFTER the deletion commits — a
            // failed uninstall reverts and never emits).
            OnModuleRemoved(accountId, ModuleTypeNameFromCode((int)module.ModuleType), module.ContractHash!);
        }

        private static void ExecuteConfigureModuleAction(UInt160 accountId, AccountControl control, object[] action)
        {
            // [ActionConfigureModule, moduleId, args]
            ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
            BigInteger moduleId = (BigInteger)action[1];
            object[] configureArgs = (object[])action[2];
            ExecutionEngine.Assert(configureArgs != null && configureArgs.Length <= ArgsCountMax, ErrorOperationMalformed);

            ModuleInstance module = RequireModuleInstance(accountId, moduleId);
            AssertCodeBindingUnchanged(module);
            CallModuleConfigure(accountId, moduleId, module, configureArgs!);
            module.ModuleRevision += 1;
            PutModuleInstance(accountId, moduleId, module);
            OnModuleInstanceConfigured(accountId, moduleId, module.CredentialGeneration);
            // §18 reused-event mirror: an in-place instance reconfiguration is
            // a module update taking effect.
            OnModuleUpdateConfirmed(accountId, ModuleTypeNameFromCode((int)module.ModuleType), module.ContractHash!);
        }

        private static void ExecuteSetHookOrderAction(UInt160 accountId, AccountControl control, object[] action)
        {
            // [ActionSetHookOrder, hookIds[]]
            ExecutionEngine.Assert(action.Length == 2, ErrorOperationMalformed);
            BigInteger[] hookIds = ToBigIntegerArray(action[1]);
            HookOrderRecord order = GetHookOrder(accountId);
            order.HookIds = hookIds;
            order.Revision += 1;
            PutHookOrder(accountId, order);
        }

        private static void ExecuteRebindModuleCodeAction(UInt160 accountId, AccountControl control, object[] action)
        {
            // [ActionRebindModuleCode, moduleId, profileDigest32]
            ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
            BigInteger moduleId = (BigInteger)action[1];
            ByteString profileDigest = (ByteString)action[2];
            ExecutionEngine.Assert(profileDigest != null && profileDigest.Length == 32, ErrorOperationMalformed);

            ModuleInstance module = RequireModuleInstance(accountId, moduleId);
            Contract? contract = ContractManagement.GetContract(module.ContractHash);
            ExecutionEngine.Assert(contract != null, ErrorModuleCodeBindingMismatch);
            CaptureCodeBinding(module, contract!, profileDigest!);
            module.ModuleRevision += 1;
            PutModuleInstance(accountId, moduleId, module);
            OnModuleCodeRebound(accountId, moduleId, module.NefSha256);
            // §18 reused-event mirror: a code rebind is a module update
            // taking effect on the new contract binding.
            OnModuleUpdateConfirmed(accountId, ModuleTypeNameFromCode((int)module.ModuleType), module.ContractHash!);
        }

        private static void ExecuteSetThresholdPolicyAction(UInt160 accountId, AccountControl control, object[] action)
        {
            // [ActionSetThresholdPolicy, policyId, threshold, memberIds[], active]
            //
            // policyId == 0 requests a NEW policy: the core allocates it from the
            // SAME monotonic allocator as module instances (spec §3.1/§3.5), so a
            // policy id is never a caller-chosen number and can never alias a
            // module id. A non-zero policyId must name an existing policy of this
            // account and is only ever treated as an update.
            ExecutionEngine.Assert(action.Length == 5, ErrorOperationMalformed);
            BigInteger requestedId = (BigInteger)action[1];
            BigInteger threshold = (BigInteger)action[2];
            BigInteger[] memberIds = ToBigIntegerArray(action[3]);
            bool active = (bool)action[4];

            ThresholdPolicyRecord? existing = null;
            BigInteger policyId;
            if (requestedId == BigInteger.Zero)
            {
                // A fresh allocation must be a live policy: deactivating an id
                // that does not exist yet is not a meaningful action.
                ExecutionEngine.Assert(active, ErrorOperationMalformed);
                policyId = AllocateModuleId(control);
            }
            else
            {
                ExecutionEngine.Assert(requestedId > 0 && (requestedId >> 64) == BigInteger.Zero,
                    ErrorModuleIdInvalid);
                existing = GetThresholdPolicy(accountId, requestedId);
                ExecutionEngine.Assert(existing != null, ErrorModuleNotInstalled);
                policyId = requestedId;
            }

            ThresholdPolicyRecord policy = new ThresholdPolicyRecord();
            policy.Threshold = threshold;
            policy.MemberIds = memberIds;
            policy.Active = active;
            // Credential generation is monotonic (spec §3.5/§8): an update
            // carries the previous generation forward and the write bumps it; a
            // brand-new policy starts at the first generation. It never resets
            // to 1, so replaying an old envelope after a reshape stays dead.
            policy.CredentialGeneration = existing == null
                ? BigInteger.Zero
                : existing!.CredentialGeneration;

            if (active)
            {
                ExecutionEngine.Assert(threshold >= MinThresholdPolicyValue && threshold <= MaxThresholdPolicyValue,
                    ErrorModuleLimitThreshold);
                ExecutionEngine.Assert(memberIds.Length > 0 && memberIds.Length <= MaxThresholdPolicyMembers,
                    ErrorModuleLimitMembers);
                ExecutionEngine.Assert(threshold <= memberIds.Length, ErrorModuleLimitThreshold);
                for (int i = 0; i < memberIds.Length; i++)
                {
                    ModuleInstance member = RequireModuleInstance(accountId, memberIds[i]);
                    ExecutionEngine.Assert(member.ModuleType == ModuleTypeCodeValidator, ErrorModuleTypeUnsupported);
                    // Members must be declared threshold-member-eligible scalars.
                    ExecutionEngine.Assert(member.ThresholdMemberEligible, ErrorOperationMalformed);
                    for (int j = 0; j < i; j++)
                    {
                        ExecutionEngine.Assert(memberIds[j] != memberIds[i], ErrorOperationMalformed);
                    }
                    // No member of two active policies (spec §3.5).
                    AssertNotMemberOfOtherActivePolicy(accountId, memberIds[i], policyId);
                }
            }
            else
            {
                // Deactivation carries no members: canonical empty form.
                ExecutionEngine.Assert(memberIds.Length == 0, ErrorOperationMalformed);
            }

            PutThresholdPolicy(accountId, policyId, policy);
            OnThresholdPolicySet(accountId, policyId, policy.Threshold, policy.MemberIds);
        }

        // ========================================================================
        // 8. Action shape validation and resource keys (consumed by
        //    SmartAccount.Intents.cs at propose time)
        // ========================================================================

        private static void ValidateActionShape(object[] action)
        {
            try
            {
                ValidateActionShapeCore(action);
            }
            catch
            {
                // Propose-time shape failures map uniformly to SA_OPERATION_MALFORMED;
                // executors re-validate precisely at confirmation time.
                ExecutionEngine.Assert(false, ErrorOperationMalformed);
            }
        }

        private static void ValidateActionShapeCore(object[] action)
        {
            bool _b = false;
            string _s = string.Empty;
            ExecutionEngine.Assert(action != null && action.Length >= 1, ErrorOperationMalformed);
            int code = (int)(BigInteger)action![0];
            switch (code)
            {
                case ActionInstallModule:
                    ExecutionEngine.Assert(action.Length == 7, ErrorOperationMalformed);
                    int moduleType = (int)(BigInteger)action[1];
                    ExecutionEngine.Assert(moduleType == ModuleTypeCodeValidator || moduleType == ModuleTypeCodeHook,
                        ErrorModuleTypeUnsupported);
                    UInt160 contractHash = (UInt160)action[2];
                    ExecutionEngine.Assert(contractHash != null && contractHash != UInt160.Zero, ErrorOperationMalformed);
                    ByteString profileDigest = (ByteString)action[3];
                    ExecutionEngine.Assert(profileDigest != null && profileDigest.Length == 32, ErrorOperationMalformed);
                    _b = ExpectBool(action[4]);
                    _b = ExpectBool(action[5]);
                    _b = ExpectBool(action[6]);
                    break;
                case ActionUninstallModule:
                    ExecutionEngine.Assert(action.Length == 2, ErrorOperationMalformed);
                    BigInteger uninstallId = (BigInteger)action[1];
                    ExecutionEngine.Assert(uninstallId > 0, ErrorModuleIdInvalid);
                    break;
                case ActionRebindModuleCode:
                    ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
                    ByteString rebindDigest = (ByteString)action[2];
                    ExecutionEngine.Assert(rebindDigest != null && rebindDigest.Length == 32, ErrorOperationMalformed);
                    BigInteger rebindId = (BigInteger)action[1];
                    ExecutionEngine.Assert(rebindId > 0, ErrorModuleIdInvalid);
                    break;
                case ActionConfigureModule:
                    ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
                    BigInteger configureId = (BigInteger)action[1];
                    ExecutionEngine.Assert(configureId > 0, ErrorModuleIdInvalid);
                    object[] configureArgs = (object[])action[2];
                    ExecutionEngine.Assert(configureArgs != null && configureArgs.Length <= ArgsCountMax,
                        ErrorOperationMalformed);
                    break;
                case ActionSetHookOrder:
                    ExecutionEngine.Assert(action.Length == 2, ErrorOperationMalformed);
                    BigInteger[] hookIds = ToBigIntegerArray(action[1]);
                    ExecutionEngine.Assert(hookIds.Length <= MaxHookModuleInstances, ErrorModuleLimitHook);
                    for (int i = 0; i < hookIds.Length; i++)
                    {
                        ExecutionEngine.Assert(hookIds[i] > 0, ErrorModuleIdInvalid);
                        for (int j = 0; j < i; j++)
                        {
                            ExecutionEngine.Assert(hookIds[j] != hookIds[i], ErrorOperationMalformed);
                        }
                    }
                    break;
                case ActionSetDefaultPolicy:
                    ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
                    _b = ExpectBool(action[1]);
                    _b = ExpectBool(action[2]);
                    break;
                case ActionSetThresholdPolicy:
                    ExecutionEngine.Assert(action.Length == 5, ErrorOperationMalformed);
                    BigInteger policyId = (BigInteger)action[1];
                    // 0 = "allocate a fresh id from the shared allocator"; any
                    // other value must be a positive allocator-range id.
                    ExecutionEngine.Assert(policyId >= 0 && (policyId >> 64) == BigInteger.Zero,
                        ErrorModuleIdInvalid);
                    BigInteger threshold = (BigInteger)action[2];
                    BigInteger[] members = ToBigIntegerArray(action[3]);
                    bool activePolicy = (bool)action[4];
                    // An allocation (0) is only meaningful for a live policy.
                    ExecutionEngine.Assert(policyId > 0 || activePolicy, ErrorOperationMalformed);
                    if (activePolicy)
                    {
                        ExecutionEngine.Assert(threshold >= MinThresholdPolicyValue && threshold <= MaxThresholdPolicyValue,
                            ErrorModuleLimitThreshold);
                        ExecutionEngine.Assert(members.Length > 0 && members.Length <= MaxThresholdPolicyMembers,
                            ErrorModuleLimitMembers);
                        for (int i = 0; i < members.Length; i++)
                        {
                            for (int j = 0; j < i; j++)
                            {
                                ExecutionEngine.Assert(members[j] != members[i], ErrorOperationMalformed);
                            }
                        }
                    }
                    else
                    {
                        ExecutionEngine.Assert(members.Length == 0, ErrorOperationMalformed);
                    }
                    break;
                case ActionSetRecoveryPolicy:
                    ExecutionEngine.Assert(action.Length == 4, ErrorOperationMalformed);
                    UInt160 recoveryAuthority = (UInt160)action[1];
                    ExecutionEngine.Assert(recoveryAuthority != null, ErrorOperationMalformed);
                    BigInteger timelock = (BigInteger)action[2];
                    ExecutionEngine.Assert(timelock >= RecoveryTimelockMinMs && timelock <= RecoveryTimelockMaxMs,
                        ErrorOperationMalformed);
                    _b = ExpectBool(action[3]);
                    break;
                case ActionSetMessageSubjects:
                    ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
                    ByteString[] subjects = ToByteStringArray(action[1]);
                    ExecutionEngine.Assert(subjects.Length <= MessageSubjectKeysMax, ErrorOperationMalformed);
                    for (int i = 0; i < subjects.Length; i++)
                    {
                        // 32 bytes = SHA256 of the signer verification script;
                        // 20 bytes = the signer's N3 address (script hash).
                        ExecutionEngine.Assert(subjects[i].Length == 20 || subjects[i].Length == 32,
                            ErrorOperationMalformed);
                        for (int j = 0; j < i; j++)
                        {
                            ExecutionEngine.Assert(subjects[j] != subjects[i], ErrorOperationMalformed);
                        }
                    }
                    BigInteger subjectThreshold = (BigInteger)action[2];
                    ExecutionEngine.Assert(subjectThreshold >= 1 && subjectThreshold <= subjects.Length,
                        ErrorOperationMalformed);
                    break;
                case ActionMigrateAccount:
                    // Migration action shape is refined by SmartAccount.Migration.cs.
                    ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
                    ByteString manifestDigest = (ByteString)action[1];
                    ExecutionEngine.Assert(manifestDigest != null && manifestDigest.Length == 32, ErrorOperationMalformed);
                    _s = ExpectString(action[2]);
                    break;
                default:
                    ExecutionEngine.Assert(false, ErrorOperationMalformed);
                    break;
            }
        }

        // Resource keys for intent conflict detection (spec §10): two pending
        // intents are in conflict when their resource key sets intersect.
        private static readonly byte[] ResourceTagModuleContract = new byte[]
            { 0x6D, 0x6F, 0x64, 0x75, 0x6C, 0x65, 0x3A };                 // "module:"
        private static readonly byte[] ResourceTagModuleId = new byte[]
            { 0x6D, 0x6F, 0x64, 0x75, 0x6C, 0x65, 0x49, 0x64, 0x3A };     // "moduleId:"
        private static readonly byte[] ResourceTagPolicy = new byte[]
            { 0x70, 0x6F, 0x6C, 0x69, 0x63, 0x79, 0x3A };                 // "policy:"
        private static readonly byte[] ResourceTagHookOrder = new byte[]
            { 0x68, 0x6F, 0x6F, 0x6B, 0x4F, 0x72, 0x64, 0x65, 0x72 };     // "hookOrder"
        private static readonly byte[] ResourceTagDefaultPolicy = new byte[]
            { 0x64, 0x65, 0x66, 0x61, 0x75, 0x6C, 0x74, 0x50, 0x6F, 0x6C, 0x69, 0x63, 0x79 }; // "defaultPolicy"
        private static readonly byte[] ResourceTagRecovery = new byte[]
            { 0x72, 0x65, 0x63, 0x6F, 0x76, 0x65, 0x72, 0x79 };          // "recovery"
        private static readonly byte[] ResourceTagMessageSubjects = new byte[]
            { 0x6D, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x53, 0x75, 0x62, 0x6A, 0x65, 0x63, 0x74, 0x73 }; // "messageSubjects"
        private static readonly byte[] ResourceTagMigration = new byte[]
            { 0x6D, 0x69, 0x67, 0x72, 0x61, 0x74, 0x69, 0x6F, 0x6E };    // "migration"

        private static ByteString ModuleContractResource(UInt160 contractHash) =>
            (ByteString)Helper.Concat(ResourceTagModuleContract, (byte[])contractHash);

        private static ByteString ModuleIdResource(BigInteger moduleId) =>
            (ByteString)Helper.Concat(ResourceTagModuleId, ModuleIdKeyBytes(moduleId));

        private static ByteString PolicyResource(BigInteger policyId) =>
            (ByteString)Helper.Concat(ResourceTagPolicy, ModuleIdKeyBytes(policyId));

        /// <summary>Bounded resource keys a configuration action reads or writes.</summary>
        private static ByteString[] ResourceKeysForAction(object[] action)
        {
            int code = (int)(BigInteger)action[0];
            switch (code)
            {
                case ActionInstallModule:
                    return new ByteString[] { ModuleContractResource((UInt160)action[2]) };
                case ActionUninstallModule:
                case ActionConfigureModule:
                case ActionRebindModuleCode:
                    return new ByteString[] { ModuleIdResource((BigInteger)action[1]) };
                case ActionSetHookOrder:
                    return new ByteString[] { (ByteString)ResourceTagHookOrder };
                case ActionSetDefaultPolicy:
                    return new ByteString[] { (ByteString)ResourceTagDefaultPolicy };
                case ActionSetThresholdPolicy:
                {
                    BigInteger policyId = (BigInteger)action[1];
                    BigInteger[] members = ToBigIntegerArray(action[3]);
                    ByteString[] keys = new ByteString[members.Length + 1];
                    keys[0] = PolicyResource(policyId);
                    for (int i = 0; i < members.Length; i++) keys[i + 1] = ModuleIdResource(members[i]);
                    return keys;
                }
                case ActionSetRecoveryPolicy:
                    return new ByteString[] { (ByteString)ResourceTagRecovery };
                case ActionSetMessageSubjects:
                    return new ByteString[] { (ByteString)ResourceTagMessageSubjects };
                case ActionMigrateAccount:
                    return new ByteString[] { (ByteString)ResourceTagMigration };
                default:
                    ExecutionEngine.Assert(false, ErrorOperationMalformed);
                    return new ByteString[0];
            }
        }

        // ========================================================================
        // 9. Credential revocation (spec §10 exception list)
        //    Callback-free, immediate, core-defined one-way revocation: bumps
        //    the module's credential generation so all previously issued
        //    validator credentials fail their credentialGeneration binding.
        // ========================================================================

        public static void revokeCredentials(UInt160 accountId, BigInteger moduleId)
        {
            ValidateAccountId(accountId);
            AccountControl control = RequireAccountActive(accountId);
            RequireCustodyWitness(control);

            ModuleInstance module = RequireModuleInstance(accountId, moduleId);
            ExecutionEngine.Assert(module.ModuleType == ModuleTypeCodeValidator, ErrorModuleNotRoutable);

            module.CredentialGeneration += 1;
            PutModuleInstance(accountId, moduleId, module);
            // Credential revocation is a security configuration commit.
            control.ConfigurationNonce += 1;
            PutAccountControl(accountId, control);

            OnCredentialRevoked(accountId, moduleId, module.CredentialGeneration);
        }

        // ========================================================================
        // 10. Application context and F-7 phase gates (0x58)
        // ========================================================================

        private static ApplicationContextRecord? GetApplicationContext(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ApplicationContextKey(accountId));
            return data == null ? null : (ApplicationContextRecord)StdLib.Deserialize(data!);
        }

        private static ApplicationContextRecord RequireApplicationContext(UInt160 accountId)
        {
            ApplicationContextRecord? ctx = GetApplicationContext(accountId);
            ExecutionEngine.Assert(ctx != null, ErrorPhaseViolation);
            return ctx!;
        }

        private static void SaveApplicationContext(UInt160 accountId, ApplicationContextRecord ctx)
        {
            Storage.Put(Storage.CurrentContext, ApplicationContextKey(accountId), StdLib.Serialize(ctx));
        }

        /// <summary>
        /// Opens the 0x58 context for an execution or configuration sequence.
        /// The per-account execution lock / idle-configuration assertions are
        /// the caller's responsibility; a leftover context from a faulted prior
        /// transaction is simply replaced.
        /// </summary>
        /// <summary>
        /// Opens the 0x58 application context. The gas pools are envelope
        /// scoped: when a context already exists (batch execution or a phase
        /// re-entry) its remaining budgets are carried forward and never reset,
        /// so a batch of N operations shares ONE budget instead of receiving a
        /// fresh one per operation.
        /// </summary>
        private static ApplicationContextRecord OpenApplicationContext(UInt160 accountId, out bool created)
        {
            ApplicationContextRecord? existing = GetApplicationContext(accountId);
            if (existing != null)
            {
                // Same envelope: keep the pools, close the writer phase.
                existing!.Phase = PhaseNone;
                existing.ActiveModuleId = BigInteger.Zero;
                SaveApplicationContext(accountId, existing);
                created = false;
                return existing;
            }

            ApplicationContextRecord ctx = new ApplicationContextRecord();
            ctx.Phase = PhaseNone;
            ctx.ActiveModuleId = BigInteger.Zero;
            ctx.ValidationBudgetRemaining = ValidationAggregateGasLimit;
            ctx.CompletionBudgetRemaining = ValidatorCompletionGasLimit;
            ctx.HookBudgetRemaining = HookAggregateGasBudget();
            EnterConfigurationContext();
            SaveApplicationContext(accountId, ctx);
            created = true;
            return ctx;
        }

        private static ApplicationContextRecord BeginApplicationContext(UInt160 accountId)
        {
            bool ignored;
            return OpenApplicationContext(accountId, out ignored);
        }

        private static void EndApplicationContext(UInt160 accountId)
        {
            if (GetApplicationContext(accountId) == null) return;
            Storage.Delete(Storage.CurrentContext, ApplicationContextKey(accountId));
            ExitConfigurationContext();
        }

        private static void EnterModulePhase(UInt160 accountId, ApplicationContextRecord ctx, byte phase, BigInteger moduleId)
        {
            ctx.Phase = phase;
            ctx.ActiveModuleId = moduleId;
            SaveApplicationContext(accountId, ctx);
        }

        /// <summary>
        /// Phase-exact module authorization (F-7). A plugin callback into the
        /// core is authorized only while the recorded writer phase matches AND
        /// the caller IS the contract of the recorded active module instance.
        /// Returns the authorized moduleId, or -1. This replaces the retired
        /// stage-blind canConfigureVerifier/canExecuteVerifier/canExecuteHook
        /// root/child parameters.
        /// </summary>
        [Safe]
        public static BigInteger getAuthorizedModuleId(UInt160 accountId, byte phase)
        {
            ApplicationContextRecord? ctx = GetApplicationContext(accountId);
            if (ctx == null || ctx.Phase != phase || ctx.ActiveModuleId <= 0) return BigInteger.MinusOne;
            ModuleInstance? module = GetModuleInstance(accountId, ctx.ActiveModuleId);
            if (module == null) return BigInteger.MinusOne;
            if (Runtime.CallingScriptHash != module.ContractHash) return BigInteger.MinusOne;
            return ctx.ActiveModuleId;
        }

        // ========================================================================
        // 11. Gas budget (spec §11)
        //     Plan B (a hard per-call cap via System.Contract.CallWithGasLimit) is
        //     only reachable from the PLATFORM build — see the PLAN A
        //     DEGRADATION note on CallModuleGasCapped. Either way EVERY module
        //     callback — validation, preExecute, postExecute, onInstall,
        //     onUninstall, configure/cleanup — runs inside the same fail-closed
        //     envelope: a pre-call GasLeft/pool gate and a post-call
        //     measured-delta charge against the per-call cap plus that callback's
        //     own transaction-scoped pool. Validation, hooks and completion hold
        //     separate pools (hook spend never counts against validation).
        // ========================================================================

        // Public-network aggregate hook pool: the per-call cap times the
        // maximum hook multiplicity of one envelope. Kept as a computed value
        // because Neo C# static initializers must stay constant expressions.
        private static BigInteger HookAggregateGasBudget()
        {
            return (BigInteger)HookCallbackGasLimit * MaxHookModuleInstances;
        }

        // Gas pool selectors. Hooks are deliberately their own pool: a
        // preCheck/postCheck overrun must never be paid for by, or starve,
        // signature validation (spec §11).
        private const int GasPoolNone = -1;
        private const int GasPoolValidation = 0;
        private const int GasPoolHook = 1;
        private const int GasPoolCompletion = 2;

        private static BigInteger PoolRemaining(ApplicationContextRecord ctx, int pool)
        {
            if (pool == GasPoolValidation) return ctx.ValidationBudgetRemaining;
            if (pool == GasPoolHook) return ctx.HookBudgetRemaining;
            if (pool == GasPoolCompletion) return ctx.CompletionBudgetRemaining;
            return BigInteger.Zero;
        }

        private static void SetPoolRemaining(ApplicationContextRecord ctx, int pool, BigInteger remaining)
        {
            if (pool == GasPoolValidation) ctx.ValidationBudgetRemaining = remaining;
            else if (pool == GasPoolHook) ctx.HookBudgetRemaining = remaining;
            else if (pool == GasPoolCompletion) ctx.CompletionBudgetRemaining = remaining;
        }

        /// <summary>Fail-closed pre-call budget gate.</summary>
        private static void AssertCallbackGasBudget(long budget)
        {
            ExecutionEngine.Assert(Runtime.GasLeft >= budget, ErrorGasBudgetExceeded);
        }

        /// <summary>
        /// Pre-call half of the soft budget: the callback may only start when
        /// the remaining invocation gas covers the per-call cap and the pool it
        /// is charged to still has budget left.
        /// </summary>
        private static long PrepareCallbackBudget(ApplicationContextRecord? ctx, int pool, long perCallCap)
        {
            long budget = perCallCap;
            if (ctx != null && pool != GasPoolNone)
            {
                BigInteger remaining = PoolRemaining(ctx, pool);
                ExecutionEngine.Assert(remaining > BigInteger.Zero, ErrorGasBudgetExceeded);
                if (remaining < (BigInteger)budget) budget = (long)remaining;
            }
            AssertCallbackGasBudget(budget);
            return Runtime.GasLeft;
        }

        /// <summary>
        /// Post-call half of the soft budget: the measured spend must fit the
        /// per-call cap and is then charged against the callback's own pool.
        /// An overrun faults the whole transaction.
        /// </summary>
        private static void ChargeCallbackGas(ApplicationContextRecord? ctx, int pool, long gasBefore, long perCallCap)
        {
            long spent = gasBefore - Runtime.GasLeft;
            if (spent < 0) spent = 0;
            ExecutionEngine.Assert(spent <= perCallCap, ErrorGasBudgetExceeded);
            if (ctx == null || pool == GasPoolNone) return;
            BigInteger remaining = PoolRemaining(ctx!, pool) - spent;
            ExecutionEngine.Assert(remaining >= BigInteger.Zero, ErrorGasBudgetExceeded);
            SetPoolRemaining(ctx!, pool, remaining);
        }

#if PLATFORM
        private static object CallModuleGasCapped(UInt160 scriptHash, string method, CallFlags flags, long gasLimit, object[] args) =>
            PlatformSyscalls.CallWithGasLimit(scriptHash, method, flags, gasLimit, args);
#else
        // =====================================================================
        // PLAN A DEGRADATION — NOT the approved Plan B.
        //
        // The pinned Neo.SmartContract.Framework 3.10.1 (and the 3.10.1 VM)
        // does NOT declare System.Contract.CallWithGasLimit, so an ordinary
        // build has no way to pass a hard per-call gas cap down to a module
        // callback. Every callback is therefore bounded SOFTLY, fail-closed:
        //
        //   1. before the call PrepareCallbackBudget asserts the remaining
        //      invocation gas covers the per-call cap and that the callback's
        //      own pool still holds budget;
        //   2. after the call ChargeCallbackGas measures the real GasLeft delta,
        //      asserts it fits the per-call cap, and charges it against that
        //      pool — an overrun FAULTs and rolls back the whole transaction.
        //
        // Residual gap versus Plan B: a runaway callback can consume the rest
        // of the transaction GAS limit before the post-call check aborts it.
        // It can never commit state and can never borrow another pool. Replace
        // this branch with the single CallWithGasLimit call once the syscall
        // ships in the public framework.
        // =====================================================================
        private static object CallModuleGasCapped(UInt160 scriptHash, string method, CallFlags flags, long gasLimit, object[] args) =>
            Contract.Call(scriptHash, method, flags, args);
#endif

        // ========================================================================
        // 12. Module callback adaptation layer (TODO(26))
        //     The v4 kernel routes callbacks through the LEGACY plugin ABI
        //     until task 26 ships the v4 module-side ABI. Each site carries an
        //     explicit TODO(26) marker naming the v4 replacement:
        //       supportsV3        -> onInstall(moduleType, additionalContext)
        //       clearAccount      -> onUninstall(accountId, moduleId)
        //       configure         -> configure(accountId, moduleId, args)  [new ABI name]
        //       validateSignature -> validateUserOp(accountId, operationDigest, operation)
        //       postExecute (validator) -> onUserOpComplete(accountId, operation, result)
        //       preExecute        -> preCheck(accountId, operation) -> hookData
        //       postExecute (hook) -> postCheck(accountId, operation, result, hookData)
        //
        //     Validation is dispatched by manifest probe: a module that DECLARES
        //     validateUserOp(hash160, byte[], array) receives the operation digest
        //     plus the full 13-field canonical operation, so epoch, credential
        //     generation, configuration nonce and hook proofs are all bound into
        //     what it verifies. A module that only declares the legacy
        //     validateSignature gets the legacy six-field view — that gap is
        //     exactly what TODO(26) removes, and it is why the built-in route and
        //     every v4 module check the digest.
        // ========================================================================

        /// <summary>
        /// Legacy 6-field operation view [target, method, args, nonce,
        /// deadline, signature] of the canonical v4 operation, deep-copied so
        /// callbacks can never mutate signed content (spec §3.6).
        /// </summary>
        private static object[] BuildLegacyOperationView(object[] operation)
        {
            object[] args = (object[])operation[OpArgs];
            return new object[]
            {
                operation[OpTarget],
                operation[OpMethod],
                CloneOperationArguments(args),
                operation[OpNonce],
                operation[OpDeadline],
                operation[OpSignature]
            };
        }

        /// <summary>
        /// Canonical v4 operation view: all 13 fields in protocol order,
        /// deep-copied (spec §4.1). This is what a v4 validator receives, so
        /// every signed/bound field is visible to it.
        /// </summary>
        private static object[] BuildCanonicalOperationView(object[] operation)
        {
            return new object[]
            {
                operation[OpVersion],
                operation[OpTarget],
                operation[OpMethod],
                CloneOperationArguments((object[])operation[OpArgs]),
                operation[OpNonce],
                operation[OpNonceSubkey],
                operation[OpDeadline],
                operation[OpValidatorId],
                operation[OpCredentialGeneration],
                operation[OpAuthorityEpoch],
                operation[OpConfigurationNonce],
                operation[OpSignature],
                CloneOperationArguments((object[])operation[OpHookProofs])
            };
        }

        /// <summary>Name/arity probe over the deployed module manifest.</summary>
        private static bool ModuleDeclaresMethod(UInt160 module, string methodName, int parameterCount)
        {
            Contract? deployed = ContractManagement.GetContract(module);
            if (deployed == null) return false;
            ContractMethodDescriptor[] methods = deployed.Manifest.Abi.Methods;
            for (int i = 0; i < methods.Length; i++)
            {
                if (methods[i].Name == methodName && methods[i].Parameters.Length == parameterCount) return true;
            }
            return false;
        }

        /// <summary>v4 validation ABI: validateUserOp(accountId, operationDigest, operation).</summary>
        private static bool ModuleSupportsV4Validation(ModuleInstance module)
        {
            return ModuleDeclaresMethod(module.ContractHash!, "validateUserOp", 3);
        }

        private static void CallModuleOnInstall(UInt160 accountId, BigInteger moduleId, ModuleInstance module)
        {
            // TODO(26): v4 onInstall lifecycle callback. Legacy plugins expose
            // no install callback; the transition probe is the legacy
            // capability declaration supportsV3().
            AssertCodeBindingUnchanged(module);
            ApplicationContextRecord ctx = BeginApplicationContext(accountId);
            long gasBefore = PrepareCallbackBudget(ctx, GasPoolNone, LifecycleCallbackGasLimit);
            EnterModulePhase(accountId, ctx, PhaseConfiguration, moduleId);
            try
            {
                bool supported = (bool)CallModuleGasCapped(
                    module.ContractHash, "supportsV3", CallFlags.ReadOnly, LifecycleCallbackGasLimit, new object[] { });
                ChargeCallbackGas(ctx, GasPoolNone, gasBefore, LifecycleCallbackGasLimit);
                ExecutionEngine.Assert(supported, ErrorModuleTypeUnsupported);
                // The install callback must not have swapped the code under the
                // account: the recorded hash/updateCounter/NEF hash still bind.
                AssertCodeBindingUnchanged(module);
            }
            finally
            {
                EndApplicationContext(accountId);
            }
        }

        private static void CallModuleOnUninstall(UInt160 accountId, BigInteger moduleId, ModuleInstance module)
        {
            // TODO(26): v4 onUninstall(accountId, moduleId). The legacy
            // per-account cleanup callback is clearAccount.
            AssertCodeBindingUnchanged(module);
            ApplicationContextRecord ctx = BeginApplicationContext(accountId);
            long gasBefore = PrepareCallbackBudget(ctx, GasPoolNone, LifecycleCallbackGasLimit);
            EnterModulePhase(accountId, ctx, PhaseConfiguration, moduleId);
            try
            {
                CallModuleGasCapped(module.ContractHash, "clearAccount", CallFlags.All, LifecycleCallbackGasLimit,
                    new object[] { accountId });
                ChargeCallbackGas(ctx, GasPoolNone, gasBefore, LifecycleCallbackGasLimit);
            }
            finally
            {
                EndApplicationContext(accountId);
            }
        }

        private static void CallModuleConfigure(UInt160 accountId, BigInteger moduleId, ModuleInstance module, object[] configureArgs)
        {
            // TODO(26): v4 configure(accountId, moduleId, args). Legacy plugins
            // have no generic configure entrypoint; a module that does not
            // expose "configure" faults here — fail-closed by design, and the
            // configuration intent is not applied.
            AssertCodeBindingUnchanged(module);
            ApplicationContextRecord ctx = BeginApplicationContext(accountId);
            long gasBefore = PrepareCallbackBudget(ctx, GasPoolNone, LifecycleCallbackGasLimit);
            EnterModulePhase(accountId, ctx, PhaseConfiguration, moduleId);
            try
            {
                CallModuleGasCapped(module.ContractHash, "configure", CallFlags.All, LifecycleCallbackGasLimit,
                    new object[] { accountId, moduleId, CloneOperationArguments(configureArgs) });
                ChargeCallbackGas(ctx, GasPoolNone, gasBefore, LifecycleCallbackGasLimit);
            }
            finally
            {
                EndApplicationContext(accountId);
            }
        }

        /// <summary>
        /// Signature validation by the routed validator instance. Read-only
        /// (F-7: validation callbacks never receive write permissions),
        /// budget-charged against the transaction validation aggregate.
        /// A v4 module receives the operation digest and the full 13-field
        /// canonical operation; only a legacy module falls back to the
        /// six-field view.
        /// </summary>
        private static bool CallValidatorValidateUserOp(
            UInt160 accountId, BigInteger moduleId, ModuleInstance module, object[] operation,
            ByteString operationDigest)
        {
            // TODO(26): v4 validateUserOp(accountId, operationDigest, operation)
            // with a structured validation result replacing the Boolean.
            ApplicationContextRecord ctx = RequireApplicationContext(accountId);
            ExecutionEngine.Assert(ctx.Phase == PhaseValidation && ctx.ActiveModuleId == moduleId, ErrorPhaseViolation);
            AssertCodeBindingUnchanged(module);
            long gasBefore = PrepareCallbackBudget(ctx, GasPoolValidation, ValidationAggregateGasLimit);
            bool accepted;
            if (ModuleSupportsV4Validation(module))
            {
                accepted = (bool)CallModuleGasCapped(
                    module.ContractHash, "validateUserOp", CallFlags.ReadOnly, ValidationAggregateGasLimit,
                    new object[]
                    {
                        accountId,
                        operationDigest,
                        BuildCanonicalOperationView(operation)
                    });
            }
            else
            {
                accepted = (bool)CallModuleGasCapped(
                    module.ContractHash, "validateSignature", CallFlags.ReadOnly, ValidationAggregateGasLimit,
                    new object[] { accountId, BuildLegacyOperationView(operation) });
            }
            ChargeCallbackGas(ctx, GasPoolValidation, gasBefore, ValidationAggregateGasLimit);
            SaveApplicationContext(accountId, ctx);
            return accepted;
        }

        /// <summary>
        /// Validator completion callback (also invoked per threshold-approved
        /// member). Budget-charged against the completion aggregate.
        /// </summary>
        private static void CallValidatorOnUserOpComplete(
            UInt160 accountId, BigInteger moduleId, ModuleInstance module, object[] operation, object result)
        {
            // TODO(26): v4 onUserOpComplete(accountId, operation, result).
            ApplicationContextRecord ctx = RequireApplicationContext(accountId);
            ExecutionEngine.Assert(ctx.Phase == PhaseCompletion && ctx.ActiveModuleId == moduleId, ErrorPhaseViolation);
            AssertCodeBindingUnchanged(module);
            long gasBefore = PrepareCallbackBudget(ctx, GasPoolCompletion, ValidatorCompletionGasLimit);
            CallModuleGasCapped(
                module.ContractHash, "postExecute", CallFlags.All, ValidatorCompletionGasLimit,
                new object[] { accountId, BuildLegacyOperationView(operation), CloneCallbackValue(result)! });
            ChargeCallbackGas(ctx, GasPoolCompletion, gasBefore, ValidatorCompletionGasLimit);
            SaveApplicationContext(accountId, ctx);
        }

        /// <summary>
        /// Hook preCheck. Returns per-instance hookData (empty in the legacy
        /// adaptation) that is handed only to the same instance's postCheck.
        /// Charged to the hook pool, never to validation (spec §11).
        /// </summary>
        private static ByteString CallHookPreCheck(
            UInt160 accountId, BigInteger moduleId, ModuleInstance module, object[] operation)
        {
            // TODO(26): v4 preCheck(accountId, operation) -> hookData (<= 512
            // bytes). Legacy hooks return no hookData.
            ApplicationContextRecord ctx = RequireApplicationContext(accountId);
            ExecutionEngine.Assert(ctx.Phase == PhaseHookPre && ctx.ActiveModuleId == moduleId, ErrorPhaseViolation);
            AssertCodeBindingUnchanged(module);
            long gasBefore = PrepareCallbackBudget(ctx, GasPoolHook, HookCallbackGasLimit);
            CallModuleGasCapped(
                module.ContractHash, "preExecute", CallFlags.All, HookCallbackGasLimit,
                new object[] { accountId, BuildLegacyOperationView(operation) });
            ChargeCallbackGas(ctx, GasPoolHook, gasBefore, HookCallbackGasLimit);
            SaveApplicationContext(accountId, ctx);
            return (ByteString)new byte[0];
        }

        /// <summary>
        /// Hook postCheck over the ORIGINAL pre-approved hook snapshot. A
        /// postCheck only ever runs for hooks whose preCheck succeeded.
        /// Charged to the hook pool, never to validation (spec §11).
        /// </summary>
        private static void CallHookPostCheck(
            UInt160 accountId, BigInteger moduleId, ModuleInstance module, object[] operation, object result, ByteString hookData)
        {
            // TODO(26): v4 postCheck(accountId, operation, result, hookData).
            ApplicationContextRecord ctx = RequireApplicationContext(accountId);
            ExecutionEngine.Assert(ctx.Phase == PhaseHookPost && ctx.ActiveModuleId == moduleId, ErrorPhaseViolation);
            AssertCodeBindingUnchanged(module);
            long gasBefore = PrepareCallbackBudget(ctx, GasPoolHook, HookCallbackGasLimit);
            // TODO(26): hookData is not forwarded to legacy postExecute; the
            // adaptation layer drops it because legacy hooks return none.
            CallModuleGasCapped(
                module.ContractHash, "postExecute", CallFlags.All, HookCallbackGasLimit,
                new object[] { accountId, BuildLegacyOperationView(operation), CloneCallbackValue(result)! });
            ChargeCallbackGas(ctx, GasPoolHook, gasBefore, HookCallbackGasLimit);
            SaveApplicationContext(accountId, ctx);
        }

        // ========================================================================
        // 13. Small VM conversion helpers
        // ========================================================================

        private static bool ExpectBool(object value)
        {
            return (bool)value;
        }

        private static string ExpectString(object value)
        {
            return (string)value;
        }

        private static BigInteger[] ToBigIntegerArray(object value)
        {
            object[] items = (object[])value;
            BigInteger[] result = new BigInteger[items.Length];
            for (int i = 0; i < items.Length; i++)
            {
                result[i] = (BigInteger)items[i];
            }
            return result;
        }

        private static ByteString[] ToByteStringArray(object value)
        {
            object[] items = (object[])value;
            ByteString[] result = new ByteString[items.Length];
            for (int i = 0; i < items.Length; i++)
            {
                result[i] = (ByteString)items[i];
            }
            return result;
        }
    }
}
