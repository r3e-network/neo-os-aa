using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Validators
{
    /// <summary>
    /// Validator for recurring merchant payments.
    /// </summary>
    /// <remarks>
    /// One instance holds any number of subscriptions for one account, each
    /// addressed by a caller-chosen <c>subId</c>. The signature field carries
    /// that identifier; it is not a cryptographic proof, so a pull is only
    /// authorized when the configured merchant witnesses the transaction
    /// (as before, the merchant must scope its signer to this contract).
    /// Replay protection is the core's nonce alone — this module keeps no
    /// sequence counter of its own (docs/SA-MODULE-PROTOCOL.md §5).
    ///
    /// A subscription records the credential generation it was created under.
    /// The core rejects an operation whose generation differs from the
    /// instance's current generation, and this validator additionally requires
    /// the operation to carry the generation recorded per subscription: after
    /// <c>revokeCredentials</c> the same <c>subId</c> must be re-created under
    /// the new generation before it can charge again.
    ///
    /// Within one billing period at most one charge is booked. The last
    /// charged period is keyed by <c>subId</c> and survives a cancel/re-create,
    /// so a re-created subscription cannot bill the same period twice.
    /// </remarks>
    [DisplayName("SubscriptionValidator")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "getAuthorizedModuleId", "getAccountAddress")]
    [ManifestExtra("SmartAccountProfile", "native-v4")]
#else
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getProxyScriptHash")]
#endif
    [ManifestExtra("Description", "Time-based subscription auto-payment validator")]
    public class SubscriptionValidator : SmartContract
    {
        // Canonical bytes of SubscriptionValidator.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"SubscriptionValidator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        // (accountId, moduleId) ‖ subId -> serialized
        //   [merchant, token, amount, periodSeconds, credentialGeneration]
        private static readonly byte[] Prefix_Subscription = new byte[] { 0x01 };
        // (accountId, moduleId) ‖ subId -> last charged billing period
        private static readonly byte[] Prefix_LastChargedPeriod = new byte[] { 0x02 };

        private const int RecordFieldCount = 5;
        private const int MaxSubIdLength = 255;

        public static void _deploy(object data, bool update) => ValidatorAuthority.Initialize(data, update);

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ValidatorAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with hooks): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => ValidatorAuthority.CancelAuthorizedCoreChange();

        // SA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => ValidatorAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);

        public static void CancelUpdate() => ValidatorAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);

        /// <summary>
        /// <c>initData</c>: empty, or one <c>createSubscription</c> command.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, generation, initData);
        }

        /// <summary>
        /// <c>configData</c>:
        /// <c>["createSubscription", subId, merchant, token, amount, periodSeconds]</c>
        /// or <c>["cancelSubscription", subId]</c>.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, generation, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ModuleContext.DeleteInstancePrefix(Prefix_Subscription, accountId, moduleId);
            ModuleContext.DeleteInstancePrefix(Prefix_LastChargedPeriod, accountId, moduleId);
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] data)
        {
            string command = ModuleConfig.Name(data);
            if (command == "createSubscription")
            {
                ModuleConfig.RequireArgs(data, 5);
                CreateSubscription(accountId, moduleId, generation, (ByteString)data[1], (UInt160)data[2],
                    (UInt160)data[3], (BigInteger)data[4], (BigInteger)data[5]);
                return;
            }
            if (command == "cancelSubscription")
            {
                ModuleConfig.RequireArgs(data, 1);
                ByteString subId = (ByteString)data[1];
                RequireSubId(subId);
                Storage.Delete(Storage.CurrentContext, RecordKey(Prefix_Subscription, accountId, moduleId, subId));
                Storage.Delete(Storage.CurrentContext, RecordKey(Prefix_LastChargedPeriod, accountId, moduleId, subId));
                return;
            }
            ExecutionEngine.Assert(false, "Unknown config command");
        }

        private static void CreateSubscription(UInt160 accountId, BigInteger moduleId, BigInteger generation,
            ByteString subId, UInt160 merchant, UInt160 token, BigInteger amount, BigInteger periodSeconds)
        {
            RequireSubId(subId);
            ExecutionEngine.Assert(merchant != null && merchant.IsValid && merchant != UInt160.Zero, "Invalid merchant");
            ExecutionEngine.Assert(token != null && token.IsValid && token != UInt160.Zero, "Invalid token");
            ExecutionEngine.Assert(amount > 0, "Subscription amount must be positive");
            ExecutionEngine.Assert(periodSeconds > 0, "Invalid subscription period");

            // The last charged period is deliberately preserved: re-creating a
            // subId must not permit a second charge in the period already booked.
            Storage.Put(Storage.CurrentContext, RecordKey(Prefix_Subscription, accountId, moduleId, subId),
                StdLib.Serialize(new object[] { merchant!, token!, amount, periodSeconds, generation }));
        }

        /// <summary>
        /// <c>[merchant, token, amount, periodSeconds, credentialGeneration, lastChargedPeriod]</c>,
        /// or an empty array when the instance holds no such subscription.
        /// </summary>
        [Safe]
        public static object[] GetSubscription(UInt160 accountId, BigInteger moduleId, ByteString subId)
        {
            if (subId == null || subId.Length == 0 || subId.Length > MaxSubIdLength) return new object[0];
            object[] record = ReadRecord(accountId, moduleId, subId);
            if (record.Length != RecordFieldCount) return new object[0];
            ByteString? last = Storage.Get(Storage.CurrentContext,
                RecordKey(Prefix_LastChargedPeriod, accountId, moduleId, subId));
            object[] result = new object[RecordFieldCount + 1];
            for (int i = 0; i < RecordFieldCount; i++) result[i] = record[i];
            result[RecordFieldCount] = last == null ? BigInteger.Zero : (BigInteger)last;
            return result;
        }

        [Safe]
        public static BigInteger GetLastChargedPeriod(UInt160 accountId, BigInteger moduleId, ByteString subId)
        {
            if (subId == null || subId.Length == 0 || subId.Length > MaxSubIdLength) return 0;
            ByteString? last = Storage.Get(Storage.CurrentContext,
                RecordKey(Prefix_LastChargedPeriod, accountId, moduleId, subId));
            return last == null ? 0 : (BigInteger)last;
        }

        // Subscription authorization is a merchant witness selected dynamically by the
        // operation's subId, so the instance has no static signer commitment to publish.
        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId) => new ByteString[] { };

        /// <summary>
        /// Checks the pull against the stored subscription and the billing
        /// period. Every mismatch returns false; this module is never a
        /// threshold-policy member, so a rejected pull must not abort a policy.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
            // Standalone route only: on a policy route the signature field is a
            // member list, not a subscription id.
            if (ModuleOperation.ValidatorId(operation) != moduleId) return false;
            if (operationDigest == null || operationDigest.Length != 32) return false;

            ByteString subId = ModuleOperation.Signature(operation);
            if (subId == null || subId.Length == 0 || subId.Length > MaxSubIdLength) return false;

            object[] record = ReadRecord(accountId, moduleId, subId);
            if (record.Length != RecordFieldCount) return false;
            // The subscription dies with the credential generation it was created under.
            if ((BigInteger)operation[ModuleOperation.FieldCredentialGeneration] != (BigInteger)record[4]) return false;

            UInt160 merchant = (UInt160)record[0];
            // Audit fix M-8: the signature field carries no cryptographic proof, so without
            // this check ANY third party who observes the subId could trigger the
            // owner-authorized charge. Only the merchant the owner authorized can collect,
            // within the owner-set token/amount/period.
            if (!Runtime.CheckWitness(merchant)) return false;
            if (ModuleOperation.Target(operation) != (UInt160)record[1]) return false;
            if (ModuleOperation.Method(operation) != "transfer") return false;

            // NEP-17: exactly [from, to, integer amount, data]. Never coerce a
            // Boolean or byte string amount into an integer accepted by an
            // arbitrary token ABI.
            object[] args = ModuleOperation.Args(operation);
            if (args == null || args.Length != 4) return false;
            if (!(args[0] is ByteString) || ((ByteString)args[0]).Length != 20) return false;
            if (!(args[1] is ByteString) || ((ByteString)args[1]).Length != 20) return false;
            if (!(args[2] is BigInteger)) return false;
            BigInteger amount = (BigInteger)args[2];
            if (amount <= 0 || amount > (BigInteger)record[2]) return false;
            // A virtual account never holds a balance at its accountId: assets sit
            // at the asset address the core derives for it.
            if ((UInt160)args[0] != ValidatorAuthority.AssetAddress(accountId)) return false;
            if ((UInt160)args[1] != merchant) return false;

            BigInteger periodSeconds = (BigInteger)record[3];
            if (periodSeconds <= 0) return false;
            BigInteger currentPeriod = Now() / (periodSeconds * 1000);
            if (currentPeriod <= 0) return false;
            ByteString? last = Storage.Get(Storage.CurrentContext,
                RecordKey(Prefix_LastChargedPeriod, accountId, moduleId, subId));
            return currentPeriod > (last == null ? BigInteger.Zero : (BigInteger)last);
        }

        /// <summary>
        /// Books the billing period of an accepted pull. A failed or malformed
        /// NEP-17 result faults here and reverts the whole user operation,
        /// including its nonce, so a period is never consumed by a transfer
        /// that did not happen.
        /// </summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            BigInteger moduleId = ValidatorAuthority.RequireCompletion(accountId, operation);
            ExecutionEngine.Assert(ModuleOperation.ValidatorId(operation) == moduleId, "Subscription is not a policy member");

            ByteString subId = ModuleOperation.Signature(operation);
            ExecutionEngine.Assert(subId != null && subId.Length > 0 && subId.Length <= MaxSubIdLength, "Invalid subscription id");
            object[] record = ReadRecord(accountId, moduleId, subId!);
            ExecutionEngine.Assert(record.Length == RecordFieldCount, "Subscription not found");

            ExecutionEngine.Assert(result is bool accepted && accepted, "NEP-17 transfer failed");

            BigInteger periodSeconds = (BigInteger)record[3];
            ExecutionEngine.Assert(periodSeconds > 0, "Invalid subscription period");
            BigInteger currentPeriod = Now() / (periodSeconds * 1000);
            Storage.Put(Storage.CurrentContext, RecordKey(Prefix_LastChargedPeriod, accountId, moduleId, subId!),
                currentPeriod);
        }

        private static object[] ReadRecord(UInt160 accountId, BigInteger moduleId, ByteString subId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, RecordKey(Prefix_Subscription, accountId, moduleId, subId));
            if (data == null) return new object[0];
            return (object[])StdLib.Deserialize(data);
        }

        private static void RequireSubId(ByteString subId)
        {
            ExecutionEngine.Assert(subId != null && subId.Length > 0 && subId.Length <= MaxSubIdLength, "Invalid subscription id");
        }

        private static byte[] RecordKey(byte[] prefix, UInt160 accountId, BigInteger moduleId, ByteString subId)
        {
            return Helper.Concat(ValidatorAuthority.InstanceKey(prefix, accountId, moduleId), (byte[])subId);
        }

        private static BigInteger Now()
        {
#if SMARTACCOUNT_NATIVE
            return ValidatorClock.Now();
#else
            return Runtime.Time;
#endif
        }
    }
}
