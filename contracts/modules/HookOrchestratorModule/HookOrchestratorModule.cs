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
    /// Module-owned hook order and planner snapshot (spec §3, §9.4).
    ///
    /// The native core is the host that enforces the hook bracket: it freezes
    /// the order returned by the single <c>hookPlanner</c> instance, runs
    /// <c>preCheck</c> forward, <c>postCheck</c> in reverse over the same set,
    /// pairs each <c>hookData</c> with the bytes its own <c>preCheck</c>
    /// returned, applies veto-only semantics and meters the callbacks only by the
    /// transaction's declared system fee. This module owns only what the core does
    /// not store: the ordered set, the set it was written for, a revision and a
    /// digest over both.
    ///
    /// The order is a snapshot. Writing one is possible only inside the native
    /// configuration frame: <c>setHookOrder</c> and <c>configure</c> both
    /// require the pinned core as caller and
    /// <c>getAuthorizedModuleId(accountId, Configuration)</c> to name this
    /// instance, so an ordinary direct call — custody or any other contract —
    /// cannot bypass the account's configuration nonce. Governance changes the
    /// order by landing a <c>configureModule</c> action, which the core
    /// dispatches as the <c>configure</c> callback.
    ///
    /// Planning rejects a snapshot whose recorded hook set no longer equals the
    /// account's installed hook set (stale snapshot) and rejects hook
    /// instances whose recorded code binding no longer matches the deployed
    /// contract (code drift); it never writes.
    /// </summary>
    [DisplayName("HookOrchestratorModule")]
    [ContractPermission("*", "getAccount")]
    [ContractPermission("*", "getModules")]
    [ContractPermission("*", "getModule")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "revokeModuleCredentials")]
    [ManifestExtra("Description", "Independent hook-order planner and credential-revocation module")]
    public class HookOrchestratorModule : SmartContract
    {
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\",\"planHooks\"],\"capabilities\":{\"compositeLayer\":0,\"hookPlanner\":true,\"instanceIsolation\":true,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"HookOrchestratorModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Order = new byte[] { 0x01 };
        // "NeoSmartAccount/HookOrder"
        private static readonly byte[] OrderDomain = new byte[] { 0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61,
            0x72, 0x74, 0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F, 0x48, 0x6F, 0x6F, 0x6B, 0x4F,
            0x72, 0x64, 0x65, 0x72 };

        private const int MaxHooks = 8;

        // Snapshot record: [order[], hookSet[], revision, digest]
        private const int SnapshotLength = 4;
        private const int FieldOrder = 0;
        private const int FieldSet = 1;
        private const int FieldRevision = 2;
        private const int FieldDigest = 3;

        public delegate void HookOrderUpdatedHandler(UInt160 accountId, BigInteger moduleId, int hookCount,
            BigInteger revision, ByteString digest);
        public delegate void CredentialRevokedHandler(UInt160 accountId, BigInteger moduleId, BigInteger generation);

        [DisplayName("HookOrderUpdated")]
        public static event HookOrderUpdatedHandler OnHookOrderUpdated = default!;
        [DisplayName("CredentialRevoked")]
        public static event CredentialRevokedHandler OnCredentialRevoked = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);
        [Safe] public static string GetModuleProfile() => ModuleProfileJson;
        [Safe] public static UInt160 AuthorizedCore() => ModuleSupport.Core();
        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        /// <summary>
        /// <c>initData</c> is empty or <c>[hookIds[]]</c>. Both forms seed the
        /// snapshot from the account's installed hook set; the explicit form
        /// must name exactly that set in ascending order (protocol §9.3).
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ModuleSupport.BindInstance(accountId, moduleId);

            BigInteger[] installed = HookIds(accountId);
            if (initData.Length == 0)
            {
                StoreSnapshot(accountId, moduleId, ToArray(installed), installed, BigInteger.One);
                return;
            }
            ExecutionEngine.Assert(initData.Length == 1, ModuleProtocol.ErrOperationMalformed);
            object[] supplied = ModuleSupport.Copy((object[])initData[0]);
            ExecutionEngine.Assert(supplied.Length == installed.Length, ModuleProtocol.ErrProofInvalid);
            for (int i = 0; i < supplied.Length; i++)
            {
                ExecutionEngine.Assert(supplied[i] is BigInteger, ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert((BigInteger)supplied[i] == installed[i], ModuleProtocol.ErrProofInvalid);
            }
            StoreSnapshot(accountId, moduleId, supplied, installed, BigInteger.One);
        }

        /// <summary>
        /// <c>configData</c> is empty (reseed from the installed set),
        /// <c>[hookIds[], expectedRevision]</c> or <c>[hookIds[]]</c>. The
        /// expected revision refuses a stale snapshot observation.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            if (configData.Length == 0)
            {
                BigInteger[] installed = HookIds(accountId);
                StoreSnapshot(accountId, moduleId, ToArray(installed), installed,
                    CurrentRevision(accountId, moduleId) + 1);
                return;
            }
            ExecutionEngine.Assert(configData.Length == 1 || configData.Length == 2,
                ModuleProtocol.ErrOperationMalformed);
            BigInteger expected = configData.Length == 2 && configData[1] is BigInteger
                ? (BigInteger)configData[1] : CurrentRevision(accountId, moduleId);
            ApplyOrder(accountId, moduleId, (object[])configData[0], expected);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ModuleSupport.DeleteInstancePrefix(Prefix_Order, accountId, moduleId);
            ModuleSupport.ReleaseInstance(accountId, moduleId);
        }

        /// <summary>
        /// The planner seat never approves spending: authenticating the core
        /// is the whole callback.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            ModuleSupport.RequireValidationInstance(accountId);
            return false;
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
            => ModuleSupport.RequireCore();

        /// <summary>
        /// Returns the frozen snapshot order for this operation. The core
        /// validates the reply itself (exactly one id per installed hook, no
        /// duplicates), then runs the forward/reverse bracket, pairs each
        /// <c>hookData</c> with the instance that produced it, honours vetoes
        /// and sets no per-callback gas budget. A stale snapshot or a drifted hook
        /// code binding is refused instead of being silently re-ordered.
        /// </summary>
        [Safe]
        public static object[] PlanHooks(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            ModuleSupport.RequireCore();
            BigInteger moduleId = ModuleSupport.RequirePlanningInstance(accountId);
            object[]? descriptor = ModuleSupport.TryModuleDescriptor(accountId, moduleId);
            ExecutionEngine.Assert(descriptor != null, ModuleProtocol.ErrUnauthorized);
            object[] self = descriptor!;
            ExecutionEngine.Assert((UInt160)self[ModuleSupport.FieldModuleContractHash]
                == Runtime.ExecutingScriptHash, ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert((bool)self[ModuleSupport.FieldModuleHookPlanner],
                ModuleProtocol.ErrUnauthorized);
            ModuleSupport.RequireLiveCodeBinding(Runtime.ExecutingScriptHash, self);

            BigInteger[] installed = HookIds(accountId);
            object[]? snapshot = TryLoadSnapshot(accountId, moduleId);
            if (snapshot == null) return ToArray(installed);

            object[] order = (object[])snapshot[FieldOrder];
            RequireFreshSnapshot(accountId, moduleId, snapshot, installed);
            object[] plan = new object[order.Length];
            for (int i = 0; i < order.Length; i++) plan[i] = order[i];
            return plan;
        }

        /// <summary>
        /// Configuration-frame-only write of the order. It is unreachable by an
        /// ordinary direct call: <c>RequireConfigurationInstance</c> first
        /// authenticates the pinned core as the caller and then requires the
        /// core to be running the configuration phase for this exact instance.
        /// </summary>
        public static void SetHookOrder(UInt160 accountId, BigInteger moduleId, object[] hookIds,
            BigInteger expectedRevision)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ApplyOrder(accountId, moduleId, hookIds, expectedRevision);
        }

        /// <summary>Immediate, never governance-delayed credential revocation of one validator instance.</summary>
        public static void RevokeCredentials(UInt160 accountId, BigInteger moduleId)
        {
            ModuleSupport.RequireActiveAccount(accountId);
            ModuleSupport.RequireCustody(accountId);
            ExecutionEngine.Assert(moduleId >= 1, ModuleProtocol.ErrOperationMalformed);
            ModuleSupport.RevokeModuleCredentials(accountId, moduleId);
            object[] descriptor = ModuleSupport.ModuleDescriptor(accountId, moduleId);
            BigInteger generation = (BigInteger)descriptor[ModuleSupport.FieldModuleCredentialGeneration];
            OnCredentialRevoked(accountId, moduleId, generation);
        }

        [Safe]
        public static BigInteger GetCredentialGeneration(UInt160 accountId, BigInteger moduleId)
        {
            if (moduleId < 1) return BigInteger.Zero;
            object[]? descriptor = ModuleSupport.TryModuleDescriptor(accountId, moduleId);
            return descriptor == null ? BigInteger.Zero
                : (BigInteger)descriptor[ModuleSupport.FieldModuleCredentialGeneration];
        }

        /// <summary>Stored order of the account's planner instance, or the installed set when none was written.</summary>
        [Safe]
        public static object[] GetHookOrder(UInt160 accountId)
        {
            BigInteger moduleId = ResolvePlanner(accountId);
            if (moduleId == BigInteger.Zero) return new object[0];
            object[]? snapshot = TryLoadSnapshot(accountId, moduleId);
            if (snapshot == null) return ToArray(HookIds(accountId));
            object[] order = (object[])snapshot[FieldOrder];
            object[] copy = new object[order.Length];
            for (int i = 0; i < order.Length; i++) copy[i] = order[i];
            return copy;
        }

        /// <summary>
        /// Opaque snapshot view: <c>[moduleId, revision, digest, order[],
        /// hookSet[]]</c>, or empty when this contract holds no planner seat.
        /// The revision is the value an order write must echo.
        /// </summary>
        [Safe]
        public static object[] GetHookSnapshot(UInt160 accountId)
        {
            BigInteger moduleId = ResolvePlanner(accountId);
            if (moduleId == BigInteger.Zero) return new object[0];
            object[]? snapshot = TryLoadSnapshot(accountId, moduleId);
            if (snapshot == null) return new object[0];
            object[] view = new object[5];
            view[0] = moduleId;
            view[1] = snapshot[FieldRevision];
            view[2] = snapshot[FieldDigest];
            view[3] = snapshot[FieldOrder];
            view[4] = snapshot[FieldSet];
            return view;
        }

        // ---- order writes ----

        private static void ApplyOrder(UInt160 accountId, BigInteger moduleId, object[] hookIds,
            BigInteger expectedRevision)
        {
            ExecutionEngine.Assert(accountId != UInt160.Zero && accountId.IsValid,
                ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(moduleId >= 1, ModuleProtocol.ErrOperationMalformed);

            BigInteger currentRevision = CurrentRevision(accountId, moduleId);
            ExecutionEngine.Assert(expectedRevision == currentRevision,
                ModuleProtocol.ErrProofInvalid + " stale hook snapshot");

            object[] order = ModuleSupport.Copy(hookIds);
            ExecutionEngine.Assert(order.Length <= MaxHooks, ModuleProtocol.ErrOperationMalformed);
            BigInteger[] installed = HookIds(accountId);
            ExecutionEngine.Assert(order.Length == installed.Length, ModuleProtocol.ErrProofInvalid);
            for (int i = 0; i < order.Length; i++)
            {
                ExecutionEngine.Assert(order[i] is BigInteger, ModuleProtocol.ErrOperationMalformed);
                BigInteger hookId = (BigInteger)order[i];
                ExecutionEngine.Assert(hookId >= 1 && Contains(installed, hookId), ModuleProtocol.ErrProofInvalid);
                for (int j = 0; j < i; j++)
                    ExecutionEngine.Assert((BigInteger)order[j] != hookId, ModuleProtocol.ErrOperationMalformed);
                RequireHookBinding(accountId, hookId);
            }
            StoreSnapshot(accountId, moduleId, order, installed, currentRevision + BigInteger.One);
        }

        private static BigInteger CurrentRevision(UInt160 accountId, BigInteger moduleId)
        {
            object[]? snapshot = TryLoadSnapshot(accountId, moduleId);
            return snapshot == null ? BigInteger.Zero : (BigInteger)snapshot[FieldRevision];
        }

        private static void StoreSnapshot(UInt160 accountId, BigInteger moduleId, object[] order,
            BigInteger[] installed, BigInteger revision)
        {
            object[] set = ToArray(installed);
            ByteString digest = SnapshotDigest(accountId, moduleId, revision, order);
            object[] snapshot = new object[SnapshotLength];
            snapshot[FieldOrder] = order;
            snapshot[FieldSet] = set;
            snapshot[FieldRevision] = revision;
            snapshot[FieldDigest] = digest;
            Storage.Put(Storage.CurrentContext, OrderKey(accountId, moduleId), StdLib.Serialize(snapshot));
            OnHookOrderUpdated(accountId, moduleId, order.Length, revision, digest);
        }

        // ---- snapshot reads and checks ----

        private static void RequireFreshSnapshot(UInt160 accountId, BigInteger moduleId, object[] snapshot,
            BigInteger[] installed)
        {
            object[] order = (object[])snapshot[FieldOrder];
            object[] set = (object[])snapshot[FieldSet];
            ExecutionEngine.Assert(set.Length == installed.Length,
                ModuleProtocol.ErrProofInvalid + " stale hook snapshot");
            for (int i = 0; i < installed.Length; i++)
                ExecutionEngine.Assert(Contains(set, installed[i]),
                    ModuleProtocol.ErrProofInvalid + " stale hook snapshot");
            ExecutionEngine.Assert(order.Length == installed.Length,
                ModuleProtocol.ErrProofInvalid + " stale hook snapshot");
            for (int i = 0; i < order.Length; i++)
            {
                BigInteger hookId = (BigInteger)order[i];
                ExecutionEngine.Assert(Contains(installed, hookId),
                    ModuleProtocol.ErrProofInvalid + " stale hook snapshot");
                for (int j = 0; j < i; j++)
                    ExecutionEngine.Assert((BigInteger)order[j] != hookId,
                        ModuleProtocol.ErrProofInvalid + " stale hook snapshot");
            }
            ByteString digest = SnapshotDigest(accountId, moduleId, (BigInteger)snapshot[FieldRevision], order);
            ExecutionEngine.Assert(StdLib.MemoryCompare(digest, (ByteString)snapshot[FieldDigest]) == 0,
                ModuleProtocol.ErrProofInvalid + " hook snapshot digest");
            for (int i = 0; i < installed.Length; i++) RequireHookBinding(accountId, installed[i]);
        }

        private static void RequireHookBinding(UInt160 accountId, BigInteger hookId)
        {
            object[] descriptor = ModuleSupport.ModuleDescriptor(accountId, hookId);
            ExecutionEngine.Assert((BigInteger)descriptor[ModuleSupport.FieldModuleType]
                == ModuleProtocol.ModuleTypeHook, ModuleProtocol.ErrProofInvalid);
            ModuleSupport.RequireLiveCodeBinding((UInt160)descriptor[ModuleSupport.FieldModuleContractHash],
                descriptor);
        }

        /// <summary>Non-throwing snapshot read; a malformed record reads as absent.</summary>
        private static object[]? TryLoadSnapshot(UInt160 accountId, BigInteger moduleId)
        {
            if (accountId == UInt160.Zero || !accountId.IsValid || moduleId < 1) return null;
            ByteString? data = Storage.Get(Storage.CurrentContext, OrderKey(accountId, moduleId));
            if (data == null) return null;
            object value = StdLib.Deserialize(data!);
            if (value == null) return null;
            object[] snapshot = (object[])value;
            if (snapshot.Length != SnapshotLength) return null;
            if (!(snapshot[FieldRevision] is BigInteger) || !(snapshot[FieldDigest] is ByteString)) return null;
            object[] order = (object[])snapshot[FieldOrder];
            object[] set = (object[])snapshot[FieldSet];
            if (order.Length > MaxHooks || set.Length > MaxHooks || order.Length != set.Length) return null;
            for (int i = 0; i < order.Length; i++)
                if (!(order[i] is BigInteger) || !(set[i] is BigInteger)) return null;
            return snapshot;
        }

        private static ByteString SnapshotDigest(UInt160 accountId, BigInteger moduleId, BigInteger revision,
            object[] order)
        {
            byte[] bound = Helper.Concat(Helper.Concat(Helper.Concat(OrderDomain, new byte[] { 4 }),
                ModuleSupport.U32LE(Runtime.GetNetwork())), ModuleSupport.CoreHash());
            bound = Helper.Concat(bound, (byte[])accountId);
            bound = Helper.Concat(bound, ModuleSupport.U64BE(moduleId));
            bound = Helper.Concat(bound, ModuleSupport.U64BE(revision));
            bound = Helper.Concat(bound, ModuleSupport.U64BE(order.Length));
            for (int i = 0; i < order.Length; i++)
                bound = Helper.Concat(bound, ModuleSupport.U64BE((BigInteger)order[i]));
            return CryptoLib.Sha256((ByteString)bound);
        }

        // ---- instance resolution ----

        private static BigInteger[] HookIds(UInt160 accountId) =>
            ModuleSupport.InstalledModuleIds(accountId, "hook", MaxHooks);

        /// <summary>Bounded scan for this contract's planner instance on the account.</summary>
        private static BigInteger ResolvePlanner(UInt160 accountId)
        {
            if (accountId == UInt160.Zero || !accountId.IsValid || ModuleSupport.Core() == UInt160.Zero)
                return BigInteger.Zero;
            BigInteger[] ids = ModuleSupport.InstalledModuleIds(accountId, "validator",
                ModuleProtocol.MaxValidatorInstances);
            for (int i = 0; i < ids.Length; i++)
            {
                object[]? descriptor = ModuleSupport.TryModuleDescriptor(accountId, ids[i]);
                if (descriptor == null) continue;
                if ((UInt160)descriptor[ModuleSupport.FieldModuleContractHash] != Runtime.ExecutingScriptHash)
                    continue;
                if ((bool)descriptor[ModuleSupport.FieldModuleHookPlanner]) return ids[i];
            }
            return BigInteger.Zero;
        }

        private static object[] ToArray(BigInteger[] values)
        {
            object[] result = new object[values.Length];
            for (int i = 0; i < values.Length; i++) result[i] = values[i];
            return result;
        }

        private static bool Contains(BigInteger[] values, BigInteger value)
        {
            for (int i = 0; i < values.Length; i++) if (values[i] == value) return true;
            return false;
        }

        private static bool Contains(object[] values, BigInteger value)
        {
            for (int i = 0; i < values.Length; i++)
                if ((BigInteger)values[i] == value) return true;
            return false;
        }

        private static byte[] OrderKey(UInt160 accountId, BigInteger moduleId) =>
            ModuleSupport.Key(Prefix_Order, accountId, moduleId);
    }
}
