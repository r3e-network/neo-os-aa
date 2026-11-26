using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.ModuleTests
{
    /// <summary>
    /// Minimal, purpose-built stand-in for the v4.1 native SmartAccount core,
    /// used only by the module test suite.
    ///
    /// It reproduces exactly the seams the five standard modules consume and
    /// nothing else: the <c>getAccount</c> / <c>getModule</c> / <c>getModules</c>
    /// projections, the phase router (<c>getAuthorizedModuleId</c>), the
    /// composite sink (<c>validateMember</c>), the configuration landing
    /// (<c>applyConfigurationActions</c>, <c>setBuiltinAuthorization</c>,
    /// <c>unfreezeAccount</c>, <c>revokeModuleCredentials</c>) and the recovery
    /// landing (<c>resetAccount</c>).
    ///
    /// The mock exists so module behaviour can be proven without rebuilding the
    /// native contract (which is owned by another lane). It is a test double:
    /// the native core's own semantics are covered by the native suite.
    /// </summary>
    [DisplayName("MockModuleCore")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test double for the v4.1 SmartAccount core seams")]
    public class MockModuleCore : SmartContract
    {
        private static readonly byte[] Prefix_Account = new byte[] { 0x01 };
        private static readonly byte[] Prefix_Module = new byte[] { 0x02 };
        private static readonly byte[] Prefix_Index = new byte[] { 0x03 };
        private static readonly byte[] Prefix_Phase = new byte[] { 0x04 };
        private static readonly byte[] Prefix_Verdict = new byte[] { 0x08 };
        private static readonly byte[] Prefix_ModuleCount = new byte[] { 0x09 };
        private static readonly byte[] Prefix_Actions = new byte[] { 0x0A };
        private static readonly byte[] Prefix_Resets = new byte[] { 0x0B };
        private static readonly byte[] Prefix_Owner = new byte[] { 0xF0 };

        // Account record (getAccount): spec §7.2 indices.
        private const int AccountFields = 9;
        private const int FieldExists = 0;
        private const int FieldStatus = 1;
        private const int FieldCustody = 2;
        private const int FieldEpoch = 3;
        private const int FieldNonce = 4;
        private const int FieldDefaultOperation = 5;
        private const int FieldDefaultMessage = 6;
        private const int FieldRequiredValidator = 7;
        private const int FieldControlRevision = 8;

        // Module descriptor (getModule): spec §9 indices.
        private const int DescriptorFields = 15;
        private const int FieldModuleType = 1;
        private const int FieldContractHash = 2;
        private const int FieldContractId = 3;
        private const int FieldUpdateCounter = 4;
        private const int FieldNefSha = 5;
        private const int FieldProfileSha = 6;
        private const int FieldRevision = 7;
        private const int FieldGeneration = 8;
        private const int FieldIsolation = 9;
        private const int FieldMessageCapability = 10;
        private const int FieldEligible = 11;
        private const int FieldComposite = 12;
        private const int FieldGovernance = 13;
        private const int FieldHookPlanner = 14;

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, Prefix_Owner, (byte[])Runtime.Transaction.Sender);
        }

        // ---- owner-only test fixtures ----

        public static void CreateAccount(UInt160 accountId, UInt160 custody)
        {
            RequireOwner();
            ExecutionEngine.Assert(accountId != UInt160.Zero && accountId.IsValid, "SA_OPERATION_MALFORMED");
            ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext, Key(Prefix_Account, accountId)) == null,
                "SA_ACCOUNT_EXISTS");
            object[] record = new object[AccountFields];
            record[FieldExists] = true;
            record[FieldStatus] = ModuleStatusActive();
            record[FieldCustody] = custody;
            record[FieldEpoch] = BigInteger.One;
            record[FieldNonce] = BigInteger.Zero;
            record[FieldDefaultOperation] = false;
            record[FieldDefaultMessage] = false;
            record[FieldRequiredValidator] = BigInteger.Zero;
            record[FieldControlRevision] = BigInteger.One;
            PutAccount(accountId, record);
        }

        public static void SetStatus(UInt160 accountId, BigInteger status)
        {
            RequireOwner();
            object[] record = RequireAccount(accountId);
            record[FieldStatus] = status;
            PutAccount(accountId, record);
        }

        public static void SetCustody(UInt160 accountId, UInt160 custody)
        {
            RequireOwner();
            object[] record = RequireAccount(accountId);
            record[FieldCustody] = custody;
            PutAccount(accountId, record);
        }

        public static void SetEpoch(UInt160 accountId, BigInteger epoch)
        {
            RequireOwner();
            object[] record = RequireAccount(accountId);
            record[FieldEpoch] = epoch;
            PutAccount(accountId, record);
        }

        public static void SetConfigurationNonce(UInt160 accountId, BigInteger nonce)
        {
            RequireOwner();
            object[] record = RequireAccount(accountId);
            record[FieldNonce] = nonce;
            PutAccount(accountId, record);
        }

        public static void SetRequiredValidator(UInt160 accountId, BigInteger validatorId)
        {
            RequireOwner();
            object[] record = RequireAccount(accountId);
            record[FieldRequiredValidator] = validatorId;
            PutAccount(accountId, record);
        }

        /// <summary>Pre-set the verdict a leaf member returns from <c>validateMember</c>.</summary>
        public static void SetMemberApproval(UInt160 accountId, BigInteger memberId, bool approves)
        {
            RequireOwner();
            Storage.Put(Storage.CurrentContext, MemberKey(accountId, memberId), approves ? 1 : 0);
        }

        /// <summary>
        /// Installs a module instance the way the core does: allocate an id,
        /// record the deployment identity, run <c>onInstall</c> inside the
        /// configuration frame (phase 6 routed to the new instance).
        /// </summary>
        public static BigInteger InstallModule(UInt160 accountId, BigInteger moduleType, UInt160 contractHash,
            object[] initData)
        {
            RequireOwner();
            RequireAccount(accountId);
            ExecutionEngine.Assert(moduleType == 1 || moduleType == 4 || moduleType == 5, "SA_MODULE_TYPE_UNSUPPORTED");
            Contract deployed = ContractManagement.GetContract(contractHash);
            ExecutionEngine.Assert(deployed != null, "SA_MODULE_NOT_INSTALLED");

            BigInteger moduleId = NextModuleId(accountId);
            object[] descriptor = new object[DescriptorFields];
            descriptor[0] = moduleId;
            descriptor[FieldModuleType] = moduleType;
            descriptor[FieldContractHash] = contractHash;
            descriptor[FieldContractId] = (BigInteger)deployed!.Id;
            descriptor[FieldUpdateCounter] = (BigInteger)deployed.UpdateCounter;
            descriptor[FieldNefSha] = new byte[32];
            descriptor[FieldProfileSha] = new byte[32];
            descriptor[FieldRevision] = BigInteger.One;
            descriptor[FieldGeneration] = BigInteger.One;
            descriptor[FieldIsolation] = false;
            descriptor[FieldMessageCapability] = false;
            descriptor[FieldEligible] = false;
            descriptor[FieldComposite] = false;
            descriptor[FieldGovernance] = false;
            descriptor[FieldHookPlanner] = false;
            PutDescriptor(accountId, moduleId, descriptor);
            Storage.Put(Storage.CurrentContext, IndexKey(accountId, TypeName(moduleType), moduleId), 1);

            Storage.Put(Storage.CurrentContext, Key(Prefix_Phase, accountId, ModulePhaseConfiguration()), moduleId);
            Contract.Call(contractHash, "onInstall", CallFlags.All,
                new object[] { accountId, moduleId, moduleType, initData });
            Storage.Put(Storage.CurrentContext, Key(Prefix_Phase, accountId, ModulePhaseConfiguration()), BigInteger.Zero);
            return moduleId;
        }

        /// <summary>Writes the profile-derived capability flags the core parsed at install.</summary>
        public static void SetModuleFlags(UInt160 accountId, BigInteger moduleId, bool instanceIsolation,
            bool messageCapability, bool thresholdMemberEligible, bool compositeLayer, bool governance,
            bool hookPlanner)
        {
            RequireOwner();
            object[] descriptor = RequireDescriptor(accountId, moduleId);
            descriptor[FieldIsolation] = instanceIsolation;
            descriptor[FieldMessageCapability] = messageCapability;
            descriptor[FieldEligible] = thresholdMemberEligible;
            descriptor[FieldComposite] = compositeLayer;
            descriptor[FieldGovernance] = governance;
            descriptor[FieldHookPlanner] = hookPlanner;
            PutDescriptor(accountId, moduleId, descriptor);
        }

        public static void ConfigureModule(UInt160 accountId, BigInteger moduleId, object[] configData)
        {
            RequireOwner();
            object[] descriptor = RequireDescriptor(accountId, moduleId);
            Storage.Put(Storage.CurrentContext, Key(Prefix_Phase, accountId, ModulePhaseConfiguration()), moduleId);
            Contract.Call((UInt160)descriptor[FieldContractHash], "configure", CallFlags.All,
                new object[] { accountId, moduleId, (BigInteger)descriptor[FieldModuleType], configData });
            Storage.Put(Storage.CurrentContext, Key(Prefix_Phase, accountId, ModulePhaseConfiguration()), BigInteger.Zero);
        }

        public static void RemoveModule(UInt160 accountId, BigInteger moduleId, object[] deInitData)
        {
            RequireOwner();
            object[] descriptor = RequireDescriptor(accountId, moduleId);
            Storage.Put(Storage.CurrentContext, Key(Prefix_Phase, accountId, ModulePhaseConfiguration()), moduleId);
            Contract.Call((UInt160)descriptor[FieldContractHash], "onUninstall", CallFlags.All,
                new object[] { accountId, moduleId, (BigInteger)descriptor[FieldModuleType], deInitData });
            Storage.Put(Storage.CurrentContext, Key(Prefix_Phase, accountId, ModulePhaseConfiguration()), BigInteger.Zero);
            Storage.Delete(Storage.CurrentContext, ModuleKey(accountId, moduleId));
            Storage.Delete(Storage.CurrentContext,
                IndexKey(accountId, TypeName((BigInteger)descriptor[FieldModuleType]), moduleId));
        }

        // ---- typed callback drivers ----

        /// <summary>
        /// A caller hop: the double forwards one call to another contract, the
        /// shape of the native core delivering a callback. A suite uses it to
        /// observe a module's answer from a caller other than its own script and
        /// prove the answer does not depend on who asked.
        /// </summary>
        public static object Forward(UInt160 target, string method, object[] args)
        {
            return Contract.Call(target, method, CallFlags.All, args);
        }

        public static bool InvokeBool(UInt160 accountId, BigInteger moduleId, BigInteger phase, string method,
            object[] args)
        {
            return (bool)Invoke(accountId, moduleId, phase, method, args);
        }

        public static BigInteger InvokeInt(UInt160 accountId, BigInteger moduleId, BigInteger phase, string method,
            object[] args)
        {
            return (BigInteger)Invoke(accountId, moduleId, phase, method, args);
        }

        public static ByteString InvokeBytes(UInt160 accountId, BigInteger moduleId, BigInteger phase, string method,
            object[] args)
        {
            return (ByteString)Invoke(accountId, moduleId, phase, method, args);
        }

        public static object[] InvokeArray(UInt160 accountId, BigInteger moduleId, BigInteger phase, string method,
            object[] args)
        {
            return (object[])Invoke(accountId, moduleId, phase, method, args);
        }

        public static void InvokeVoid(UInt160 accountId, BigInteger moduleId, BigInteger phase, string method,
            object[] args)
        {
            Invoke(accountId, moduleId, phase, method, args);
        }

        // ---- core ABI consumed by the modules ----

        public static object[] GetAccount(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(Prefix_Account, accountId));
            if (data == null) return new object[0];
            return (object[])StdLib.Deserialize(data!);
        }

        public static UInt160 GetAccountAddress(UInt160 accountId) => accountId;

        public static object[] GetModules(UInt160 accountId, string moduleType, BigInteger offset, BigInteger limit)
        {
            ExecutionEngine.Assert(limit >= 1 && limit <= 32, "SA_OPERATION_MALFORMED");
            object[] all = TypeIndex(accountId, moduleType);
            int total = all.Length;
            int start = offset < 0 ? 0 : (int)offset;
            if (start > total) start = total;
            int end = start + (int)limit;
            if (end > total) end = total;
            object[] page = new object[end - start];
            for (int i = start; i < end; i++) page[i - start] = all[i];
            return new object[] { page, total };
        }

        /// <summary>Empty when the id is not installed; a short reply is what modules probe for.</summary>
        public static object[] GetModule(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ModuleKey(accountId, moduleId));
            if (data == null) return new object[0];
            return (object[])StdLib.Deserialize(data!);
        }

        /// <summary>The instance the core is currently running for a phase, or zero.</summary>
        public static BigInteger GetAuthorizedModuleId(UInt160 accountId, BigInteger phase)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(Prefix_Phase, accountId, phase));
            return data == null ? BigInteger.Zero : (BigInteger)data!;
        }

        /// <summary>
        /// Composite leaf sink. The routed composite may ask for any installed,
        /// threshold-eligible leaf of this account; the reply is that member's
        /// fixture verdict.
        ///
        /// The method is <c>[Safe]</c> on purpose. The native
        /// <c>validateMember</c> is a safe entry whose approval record lives in
        /// engine-local invocation state, never in storage (IDL: "no persistent
        /// write"), and Neo strips the write and notify flags of a safe callee —
        /// so this double cannot persist a visit even if it tried. A suite
        /// therefore observes a dispatch through the guards below (a foreign,
        /// ineligible or unknown leaf faults); it never reads a visit counter
        /// back. Duplicate suppression is the roster's job, not the sink's: the
        /// composite refuses a duplicate member before it dispatches one.
        /// </summary>
        [Safe]
        public static bool ValidateMember(UInt160 accountId, BigInteger memberId, ByteString operationDigest,
            object[] operation)
        {
            ExecutionEngine.Assert(operationDigest != null && operationDigest.Length == 32, "SA_OPERATION_MALFORMED");
            ExecutionEngine.Assert(operation != null, "SA_OPERATION_MALFORMED");

            BigInteger routed = GetAuthorizedModuleId(accountId, ModulePhaseMemberValidation());
            ExecutionEngine.Assert(routed > 0, "SA_UNAUTHORIZED");
            object[] composite = RequireDescriptor(accountId, routed);
            ExecutionEngine.Assert((UInt160)composite[FieldContractHash] == Runtime.CallingScriptHash,
                "SA_UNAUTHORIZED");

            object[] member = GetModule(accountId, memberId);
            ExecutionEngine.Assert(member.Length == DescriptorFields, "SA_MODULE_NOT_INSTALLED");
            ExecutionEngine.Assert((BigInteger)member[FieldModuleType] == 1, "SA_MODULE_TYPE_UNSUPPORTED");
            ExecutionEngine.Assert((bool)member[FieldEligible] && !(bool)member[FieldComposite],
                "SA_MODULE_LIMIT_MEMBERS");

            ByteString? verdict = Storage.Get(Storage.CurrentContext, MemberKey(accountId, memberId));
            return verdict == null || (BigInteger)verdict! == 1;
        }

        /// <summary>Configuration landing: one nonce advance per landing (spec §9).</summary>
        public static void ApplyConfigurationActions(UInt160 accountId, object[] actions)
        {
            RequireGovernanceCaller(accountId);
            ExecutionEngine.Assert(actions != null && actions.Length > 0, "SA_OPERATION_MALFORMED");
            object[] record = RequireAccount(accountId);
            record[FieldNonce] = (BigInteger)record[FieldNonce] + 1;
            record[FieldControlRevision] = (BigInteger)record[FieldControlRevision] + 1;
            PutAccount(accountId, record);
            BumpCounter(Prefix_Actions, accountId);
        }

        public static void SetBuiltinAuthorization(UInt160 accountId, bool defaultOperation, bool defaultMessage)
        {
            RequireGovernanceCaller(accountId);
            object[] record = RequireAccount(accountId);
            record[FieldDefaultOperation] = defaultOperation;
            record[FieldDefaultMessage] = defaultMessage;
            record[FieldNonce] = (BigInteger)record[FieldNonce] + 1;
            PutAccount(accountId, record);
            BumpCounter(Prefix_Actions, accountId);
        }

        /// <summary>Leaving Frozen: immediate, one nonce and one epoch advance.</summary>
        public static void UnfreezeAccount(UInt160 accountId)
        {
            RequireInstalledValidatorCaller(accountId);
            object[] record = RequireAccount(accountId);
            ExecutionEngine.Assert((BigInteger)record[FieldStatus] != ModuleStatusActive(), "SA_ACCOUNT_STATUS");
            record[FieldStatus] = ModuleStatusActive();
            record[FieldEpoch] = (BigInteger)record[FieldEpoch] + 1;
            record[FieldNonce] = (BigInteger)record[FieldNonce] + 1;
            PutAccount(accountId, record);
        }

        public static void RevokeModuleCredentials(UInt160 accountId, BigInteger moduleId)
        {
            RequireInstalledValidatorCaller(accountId);
            object[] descriptor = RequireDescriptor(accountId, moduleId);
            descriptor[FieldGeneration] = (BigInteger)descriptor[FieldGeneration] + 1;
            PutDescriptor(accountId, moduleId, descriptor);
            object[] record = RequireAccount(accountId);
            record[FieldNonce] = (BigInteger)record[FieldNonce] + 1;
            PutAccount(accountId, record);
        }

        /// <summary>
        /// The §10 reset landing. Only the account's installed recovery seat may
        /// call it; it re-lands custody, advances the authority epoch and drops
        /// every module instance in the same frame.
        /// </summary>
        public static void ResetAccount(UInt160 accountId, UInt160 newCustody)
        {
            RequireRecoveryCaller(accountId);
            object[] record = RequireAccount(accountId);
            if (newCustody != UInt160.Zero) record[FieldCustody] = newCustody;
            record[FieldStatus] = ModuleStatusActive();
            record[FieldEpoch] = (BigInteger)record[FieldEpoch] + 1;
            record[FieldNonce] = (BigInteger)record[FieldNonce] + 1;
            record[FieldDefaultOperation] = false;
            record[FieldDefaultMessage] = false;
            record[FieldRequiredValidator] = BigInteger.Zero;
            record[FieldControlRevision] = (BigInteger)record[FieldControlRevision] + 1;
            PutAccount(accountId, record);

            Iterator descriptors = Storage.Find(Storage.CurrentContext, Key(Prefix_Module, accountId),
                FindOptions.KeysOnly);
            while (descriptors.Next())
                Storage.Delete(Storage.CurrentContext, (ByteString)descriptors.Value);
            Iterator index = Storage.Find(Storage.CurrentContext, Key(Prefix_Index, accountId),
                FindOptions.KeysOnly);
            while (index.Next())
                Storage.Delete(Storage.CurrentContext, (ByteString)index.Value);

            BumpCounter(Prefix_Resets, accountId);
        }

        public static BigInteger GetAppliedActionCount(UInt160 accountId) => Counter(Prefix_Actions, accountId);

        public static BigInteger GetResetCount(UInt160 accountId) => Counter(Prefix_Resets, accountId);

        /// <summary>
        /// Composite dispatch: the routed composite is both the validation
        /// instance (phase 1) and the member-validation route (phase 8), which
        /// is what the core establishes before it asks a composite validator
        /// to walk its leaves.
        /// </summary>
        public static bool InvokeCompositeBool(UInt160 accountId, BigInteger moduleId, string method, object[] args)
        {
            RequireOwner();
            object[] descriptor = RequireDescriptor(accountId, moduleId);
            byte[] routedKey = Key(Prefix_Phase, accountId, ModulePhaseMemberValidation());
            byte[] instanceKey = Key(Prefix_Phase, accountId, ModulePhaseValidation());
            Storage.Put(Storage.CurrentContext, routedKey, moduleId);
            Storage.Put(Storage.CurrentContext, instanceKey, moduleId);
            object result = Contract.Call((UInt160)descriptor[FieldContractHash], method, CallFlags.All, args);
            Storage.Put(Storage.CurrentContext, routedKey, BigInteger.Zero);
            Storage.Put(Storage.CurrentContext, instanceKey, BigInteger.Zero);
            return (bool)result;
        }

        /// <summary>Test fixture: bumps a descriptor's update counter, i.e. the module code was updated.</summary>
        public static void DriftModuleCode(UInt160 accountId, BigInteger moduleId)
        {
            RequireOwner();
            object[] descriptor = RequireDescriptor(accountId, moduleId);
            descriptor[FieldUpdateCounter] = (BigInteger)descriptor[FieldUpdateCounter] + 1;
            PutDescriptor(accountId, moduleId, descriptor);
        }

        /// <summary>
        /// Test fixture: advances one instance's credential generation by exactly
        /// what <c>revokeModuleCredentials</c> advances, so a suite can observe
        /// the generation binding without installing a validator that revokes.
        /// </summary>
        public static void BumpModuleGeneration(UInt160 accountId, BigInteger moduleId)
        {
            RequireOwner();
            object[] descriptor = RequireDescriptor(accountId, moduleId);
            descriptor[FieldGeneration] = (BigInteger)descriptor[FieldGeneration] + 1;
            PutDescriptor(accountId, moduleId, descriptor);
        }

        // ---- internals ----

        private static object Invoke(UInt160 accountId, BigInteger moduleId, BigInteger phase, string method,
            object[] args)
        {
            RequireOwner();
            object[] descriptor = RequireDescriptor(accountId, moduleId);
            Storage.Put(Storage.CurrentContext, Key(Prefix_Phase, accountId, phase), moduleId);
            object result = Contract.Call((UInt160)descriptor[FieldContractHash], method, CallFlags.All, args);
            Storage.Put(Storage.CurrentContext, Key(Prefix_Phase, accountId, phase), BigInteger.Zero);
            return result;
        }

        private static void RequireOwner()
        {
            ByteString? owner = Storage.Get(Storage.CurrentContext, Prefix_Owner);
            ExecutionEngine.Assert(owner != null, "SA_UNAUTHORIZED");
            ExecutionEngine.Assert(Runtime.CheckWitness((UInt160)owner!), "SA_UNAUTHORIZED");
        }

        private static void RequireGovernanceCaller(UInt160 accountId)
        {
            UInt160 caller = Runtime.CallingScriptHash;
            object[] ids = TypeIndex(accountId, "validator");
            for (int i = 0; i < ids.Length; i++)
            {
                object[] descriptor = GetModule(accountId, (BigInteger)ids[i]);
                if (descriptor.Length != DescriptorFields) continue;
                if ((UInt160)descriptor[FieldContractHash] != caller) continue;
                ExecutionEngine.Assert((bool)descriptor[FieldGovernance], "SA_UNAUTHORIZED");
                return;
            }
            ExecutionEngine.Assert(false, "SA_UNAUTHORIZED");
        }

        private static void RequireInstalledValidatorCaller(UInt160 accountId)
        {
            UInt160 caller = Runtime.CallingScriptHash;
            object[] ids = TypeIndex(accountId, "validator");
            for (int i = 0; i < ids.Length; i++)
            {
                object[] descriptor = GetModule(accountId, (BigInteger)ids[i]);
                if (descriptor.Length != DescriptorFields) continue;
                if ((UInt160)descriptor[FieldContractHash] != caller) continue;
                return;
            }
            ExecutionEngine.Assert(false, "SA_UNAUTHORIZED");
        }

        private static void RequireRecoveryCaller(UInt160 accountId)
        {
            UInt160 caller = Runtime.CallingScriptHash;
            object[] ids = TypeIndex(accountId, "recovery");
            for (int i = 0; i < ids.Length; i++)
            {
                object[] descriptor = GetModule(accountId, (BigInteger)ids[i]);
                if (descriptor.Length != DescriptorFields) continue;
                if ((UInt160)descriptor[FieldContractHash] != caller) continue;
                return;
            }
            ExecutionEngine.Assert(false, "SA_UNAUTHORIZED");
        }

        private static object[] RequireAccount(UInt160 accountId)
        {
            ExecutionEngine.Assert(accountId != UInt160.Zero && accountId.IsValid, "SA_OPERATION_MALFORMED");
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(Prefix_Account, accountId));
            ExecutionEngine.Assert(data != null, "SA_ACCOUNT_NOT_FOUND");
            return (object[])StdLib.Deserialize(data!);
        }

        private static void PutAccount(UInt160 accountId, object[] record)
            => Storage.Put(Storage.CurrentContext, Key(Prefix_Account, accountId), StdLib.Serialize(record));

        private static object[] RequireDescriptor(UInt160 accountId, BigInteger moduleId)
        {
            object[] descriptor = GetModule(accountId, moduleId);
            ExecutionEngine.Assert(descriptor.Length == DescriptorFields, "SA_MODULE_NOT_INSTALLED");
            return descriptor;
        }

        private static void PutDescriptor(UInt160 accountId, BigInteger moduleId, object[] descriptor)
            => Storage.Put(Storage.CurrentContext, ModuleKey(accountId, moduleId), StdLib.Serialize(descriptor));

        private static BigInteger NextModuleId(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(Prefix_ModuleCount, accountId));
            BigInteger next = data == null ? BigInteger.One : (BigInteger)data! + 1;
            Storage.Put(Storage.CurrentContext, Key(Prefix_ModuleCount, accountId), next);
            return next;
        }

        private static object[] TypeIndex(UInt160 accountId, string moduleType)
        {
            byte[] prefix = Helper.Concat(Key(Prefix_Index, accountId), TypeTag(moduleType));
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            object[] ids = new object[32];
            int count = 0;
            while (iterator.Next())
            {
                ByteString item = (ByteString)iterator.Value;
                byte[] key = (byte[])item;
                ids[count++] = ReadU64(key, key.Length - 8);
                ExecutionEngine.Assert(count <= 32, "SA_OPERATION_MALFORMED");
            }
            object[] result = new object[count];
            for (int i = 0; i < count; i++) result[i] = ids[i];
            return result;
        }

        private static string TypeName(BigInteger moduleType)
        {
            if (moduleType == 1) return "validator";
            if (moduleType == 4) return "hook";
            return "recovery";
        }

        /// <summary>One-byte type tag used inside module-list index keys.</summary>
        private static byte[] TypeTag(string moduleType)
        {
            if (moduleType == "validator") return new byte[] { 0x01 };
            if (moduleType == "hook") return new byte[] { 0x04 };
            return new byte[] { 0x05 };
        }

        private static BigInteger ModuleStatusActive() => BigInteger.Zero;
        private static BigInteger ModulePhaseValidation() => (BigInteger)1;
        private static BigInteger ModulePhaseConfiguration() => (BigInteger)6;
        private static BigInteger ModulePhaseMemberValidation() => (BigInteger)8;

        private static void BumpCounter(byte[] prefix, UInt160 accountId)
        {
            BigInteger limit = ((BigInteger)1) << 62;
            BigInteger next = Counter(prefix, accountId) + 1;
            ExecutionEngine.Assert(next < limit, "SA_OPERATION_MALFORMED");
            Storage.Put(Storage.CurrentContext, Key(prefix, accountId), next);
        }

        private static BigInteger Counter(byte[] prefix, UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(prefix, accountId));
            return data == null ? BigInteger.Zero : (BigInteger)data!;
        }

        private static byte[] Key(byte[] prefix, UInt160 accountId) =>
            Helper.Concat(prefix, (byte[])accountId);

        private static byte[] Key(byte[] prefix, UInt160 accountId, BigInteger id) =>
            Helper.Concat(Key(prefix, accountId), U64(id));

        private static byte[] Key(byte[] prefix, UInt160 accountId, byte[] id) =>
            Helper.Concat(Key(prefix, accountId), id);

        private static byte[] ModuleKey(UInt160 accountId, BigInteger moduleId) =>
            Key(Prefix_Module, accountId, moduleId);

        private static byte[] IndexKey(UInt160 accountId, string moduleType, BigInteger moduleId) =>
            Helper.Concat(Helper.Concat(Key(Prefix_Index, accountId), TypeTag(moduleType)), U64(moduleId));

        private static byte[] MemberKey(UInt160 accountId, BigInteger memberId) =>
            Key(Prefix_Verdict, accountId, memberId);

        private static byte[] U64(BigInteger value)
        {
            ExecutionEngine.Assert(value >= BigInteger.Zero, "SA_OPERATION_MALFORMED");
            byte[] encoded = new byte[8];
            for (int i = 7; i >= 0; i--)
            {
                encoded[i] = (byte)(value & 255);
                value >>= 8;
            }
            return encoded;
        }

        private static BigInteger ReadU64(byte[] source, int offset)
        {
            BigInteger value = BigInteger.Zero;
            for (int i = 0; i < 8; i++) value = (value << 8) + source[offset + i];
            return value;
        }
    }
}
