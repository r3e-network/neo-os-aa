using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Verifiers
{
    /// <summary>
    /// Verifier for recurring merchant payments with period-bound replay protection.
    /// </summary>
    /// <remarks>
    /// The signature field carries the subscription identifier, and the nonce must encode the
    /// current billing period so the AA core replay checks prevent duplicate charges.
    /// </remarks>
    [DisplayName("SubscriptionVerifier")]
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "canExecuteVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ContractPermission("*", "getProxyScriptHash")]
    [ManifestExtra("Description", "Time-based Subscription Auto-Payment Verifier")]
    public class SubscriptionVerifier : SmartContract
    {
        private static readonly byte[] Prefix_Subscription = new byte[] { 0x01 };
        private static readonly byte[] Prefix_SubscriptionNonceCounter = new byte[] { 0x02 };
        private static readonly byte[] Prefix_SubscriptionLastPeriod = new byte[] { 0x03 };

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsMessageSignatures() => false;

        [Safe]
        public static UInt160 AuthorizedCore() => VerifierAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => VerifierAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with hooks): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => VerifierAuthority.CancelAuthorizedCoreChange();

        // AA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => VerifierAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        public static void CancelUpdate() => VerifierAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        public class SubscriptionConfig
        {
            public UInt160 Merchant;
            public UInt160 Token;
            public BigInteger Amount;
            public BigInteger PeriodSeconds;
            public BigInteger LastChargeTime;
        }

        /// <summary>
        /// Creates or overwrites a subscription configuration for an account and subscription id.
        /// </summary>
        public static void CreateSubscription(UInt160 accountId, ByteString subId, UInt160 merchant, UInt160 token, BigInteger amount, BigInteger periodSeconds)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

            SubscriptionConfig config = new SubscriptionConfig
            {
                Merchant = merchant,
                Token = token,
                Amount = amount,
                PeriodSeconds = periodSeconds,
                LastChargeTime = 0
            };
            
            byte[] key = Helper.Concat(Helper.Concat(Prefix_Subscription, (byte[])accountId), (byte[])subId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(config));
        }

        /// <summary>
        /// Validates that the claimed subscription payment matches the configured merchant, token, amount, and billing period.
        /// </summary>
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
            // Signature field acts as the Subscription ID being claimed by the merchant
            ByteString subId = op.Signature;
            byte[] key = Helper.Concat(Helper.Concat(Prefix_Subscription, (byte[])accountId), (byte[])subId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "Subscription not found");

            SubscriptionConfig config = (SubscriptionConfig)StdLib.Deserialize(data!);

            // Audit fix M-8: ExecuteUserOp is permissionless and op.Signature carries no
            // cryptographic proof (it is just the public subscription id), so without this
            // check ANY third party who observes the subId could trigger the owner-authorized
            // charge. Require the configured merchant to witness (sign) the pull, so only the
            // merchant the owner authorized can collect — within the owner-set token/amount/period.
            ExecutionEngine.Assert(Runtime.CheckWitness(config.Merchant), "merchant authorization required");

            ExecutionEngine.Assert(op.TargetContract == config.Token, "Target must be the subscription token");
            ExecutionEngine.Assert(op.Method == "transfer", "Method must be transfer");

            // Expected args: [from, to, amount, ...]
            ExecutionEngine.Assert(op.Args.Length >= 3, "Invalid transfer args");
            // A virtual AA account never holds a balance at its accountId: its assets sit at the
            // core's proxy script hash, which is also the only "from" the token's CheckWitness can
            // accept during executeUserOp (UnifiedSmartWallet.Proxy.cs). Pinning the source to the
            // accountId therefore authorized a transfer that could never move funds; the source
            // must be the asset address the core derives for this account.
            ExecutionEngine.Assert((UInt160)op.Args[0] == AssetAddressOf(accountId), "Transfer source must be the account asset address");
            ExecutionEngine.Assert((UInt160)op.Args[1] == config.Merchant, "Transfer destination must be merchant");
            ExecutionEngine.Assert((BigInteger)op.Args[2] <= config.Amount, "Transfer amount exceeds subscription");

            ExecutionEngine.Assert(config.PeriodSeconds > 0, "Invalid subscription period");
            BigInteger billingPeriodMs = config.PeriodSeconds * 1000;
            BigInteger currentPeriod = Runtime.Time / billingPeriodMs;
            ExecutionEngine.Assert(currentPeriod > 0, "Subscription period not yet elapsed");

            // Authoritative throttle: at most one charge per billing period. The last charged period
            // is persisted in PostExecute; a charge is only allowed once the clock has advanced into a
            // period strictly later than the last one charged. (0 = never charged; real periods are > 0.)
            byte[] lastPeriodKey = Helper.Concat(Helper.Concat(Prefix_SubscriptionLastPeriod, (byte[])accountId), (byte[])subId);
            ByteString? lastPeriodData = Storage.Get(Storage.CurrentContext, lastPeriodKey);
            BigInteger lastChargedPeriod = lastPeriodData == null ? 0 : (BigInteger)lastPeriodData;
            ExecutionEngine.Assert(currentPeriod > lastChargedPeriod, "Subscription already charged this period");

            // Get per-subscription nonce counter to prevent replay within the same billing period
            byte[] counterKey = Helper.Concat(Helper.Concat(Prefix_SubscriptionNonceCounter, (byte[])accountId), (byte[])subId);
            ByteString? counterData = Storage.Get(Storage.CurrentContext, counterKey);
            BigInteger nonceCounter = counterData == null ? 0 : (BigInteger)counterData;

            // Replay protection via the AA core's canonical ERC-4337 2D nonce: each subscription
            // gets its own parallel channel (derived from the subscription id) and the per-charge
            // counter is the strictly incrementing sequence within that channel (starts at 0). The
            // AA core enforces sequence == cursor and advances it, so a charge can never be replayed
            // and charges from other subscriptions never collide. The billing-period gate above is
            // the authoritative throttle; the nonce only fixes the in-channel ordering.
            ByteString digest = CryptoLib.Sha256(subId);
            byte[] digestBytes = (byte[])digest;
            BigInteger subTag = 0;
            for (int i = 0; i < 8 && i < digestBytes.Length; i++)
            {
                subTag = (subTag << 8) + digestBytes[i];
            }
            BigInteger expectedNonce = (subTag << 64) + nonceCounter;
            ExecutionEngine.Assert(op.Nonce == expectedNonce, "Subscription nonce mismatch");

            return true;
        }

        /// <summary>
        /// Address that actually holds this account's assets on chain: the authorized core's
        /// proxy script hash for the account, never the accountId itself.
        /// </summary>
        private static UInt160 AssetAddressOf(UInt160 accountId)
        {
            UInt160 core = VerifierAuthority.AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "AA core not configured");
            return (UInt160)Contract.Call(core, "getProxyScriptHash", CallFlags.ReadOnly, new object[] { accountId });
        }

        public static void ClearAccount(UInt160 accountId)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

            byte[] prefix = Helper.Concat(Prefix_Subscription, (byte[])accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }

            // Clear nonce counters
            byte[] counterPrefix = Helper.Concat(Prefix_SubscriptionNonceCounter, (byte[])accountId);
            iterator = Storage.Find(Storage.CurrentContext, counterPrefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }

            // Clear last-charged-period markers
            byte[] lastPeriodPrefix = Helper.Concat(Prefix_SubscriptionLastPeriod, (byte[])accountId);
            iterator = Storage.Find(Storage.CurrentContext, lastPeriodPrefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }

        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
            ByteString subId = op.Signature;
            byte[] key = Helper.Concat(Helper.Concat(Prefix_Subscription, (byte[])accountId), (byte[])subId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "Subscription not found");

            SubscriptionConfig config = (SubscriptionConfig)StdLib.Deserialize(data!);
            config.LastChargeTime = Runtime.Time;
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(config));

            // Persist the billing period just charged. This is the authoritative throttle enforced by
            // ValidateSignature (currentPeriod > lastChargedPeriod), independent of the free-running nonce.
            ExecutionEngine.Assert(config.PeriodSeconds > 0, "Invalid subscription period");
            BigInteger billingPeriodMs = config.PeriodSeconds * 1000;
            BigInteger currentPeriod = Runtime.Time / billingPeriodMs;
            byte[] lastPeriodKey = Helper.Concat(Helper.Concat(Prefix_SubscriptionLastPeriod, (byte[])accountId), (byte[])subId);
            Storage.Put(Storage.CurrentContext, lastPeriodKey, currentPeriod);

            byte[] counterKey = Helper.Concat(Helper.Concat(Prefix_SubscriptionNonceCounter, (byte[])accountId), (byte[])subId);
            ByteString? counterData = Storage.Get(Storage.CurrentContext, counterKey);
            BigInteger nonceCounter = counterData == null ? 0 : (BigInteger)counterData;
            Storage.Put(Storage.CurrentContext, counterKey, nonceCounter + 1);
        }
    }
}
