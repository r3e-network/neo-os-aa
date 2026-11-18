using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    public partial class SmartAccount
    {
        // Storage key prefixes
        // 0x01 legacy five-field account row: migration input only (spec §7.4).
        // New code never routes through the old Verifier/HookId pointers; the
        // only authorized consumers are the legacy decoders in
        // SmartAccount.Migration.cs / Escape.cs / MarketEscrow.cs.
        private static readonly byte[] Prefix_AccountState = new byte[] { 0x01 };
        // 0x02 verify-context: the dispatched operation's target, written
        // around the core's Contract.Call so a target-side CheckWitness of
        // the account resolves to THIS operation only (F-1).
        private static readonly byte[] Prefix_VerifyContext = new byte[] { 0x02 };
        // 0x03 legacy nonce channel: migration input; the v4 channels
        // (0x56/0x5C) merge with it at consumption time in Nonce.cs.
        private static readonly byte[] Prefix_Nonce = new byte[] { 0x03 };
        // 0x04/0x05 legacy verifier/hook config-context pointers and
        // 0x0D/0x0E legacy execution-context pointers: RETIRED with the v4
        // module model — the F-7 phase gates live in the 0x58 application
        // context. The bytes are permanently reserved and never re-allocated;
        // any surviving legacy rows are inert evidence.
        // 0x06/0x07 market escrow physical markers: Market-owned writes only
        // (spec §7.5 minimal-lock model; see SmartAccount.MarketEscrow.cs).
        private static readonly byte[] Prefix_MarketEscrowContract = new byte[] { 0x06 };
        private static readonly byte[] Prefix_MarketEscrowListing = new byte[] { 0x07 };
        // 0x08/0x09/0x0A/0x0F/0x10 legacy pending-update, escape-cooldown and
        // pending-call slots: RETIRED with the old single-pointer model —
        // pending configuration now lives in the 0x55/0x5E intent slots and
        // recovery in the 0x59 records. Bytes permanently reserved; surviving
        // legacy rows are cleaned by the market settle sweep and are
        // otherwise inert evidence.
        private static readonly byte[] Prefix_EscapeLastInitiated = new byte[] { 0x08 };
        private static readonly byte[] Prefix_PendingVerifierUpdate = new byte[] { 0x09 };
        private static readonly byte[] Prefix_PendingHookUpdate = new byte[] { 0x0A };
        private static readonly byte[] Prefix_ExecutionLock = new byte[] { 0x0B };
        private static readonly byte[] Prefix_MetadataUri = new byte[] { 0x0C };
        private static readonly byte[] Prefix_HookExecutionContext = new byte[] { 0x0D };
        private static readonly byte[] Prefix_VerifierExecutionContext = new byte[] { 0x0E };
        private static readonly byte[] Prefix_PendingVerifierCall = new byte[] { 0x0F };
        private static readonly byte[] Prefix_PendingHookCall = new byte[] { 0x10 };
        // 0x1C (the retired per-account scope-target grant) is RETIRED with the
        // F-1 fix (protocol v4): permanently reserved, never re-allocated; legacy
        // rows remain as migration-input evidence only (SA-MODULE-PROTOCOL.md §7.4).
        // 0x23/0x24/0x25 legacy composite dependency registry: RETIRED with
        // the v4 module model — module children are core-owned 0x52/0x53
        // instances now, and the callback-free sweep replaces cascaded
        // clearAccount. Bytes permanently reserved; surviving rows are
        // inert evidence.
        private static readonly byte[] Prefix_HookDependencies = new byte[] { 0x23 };
        private static readonly byte[] Prefix_VerifierDependencies = new byte[] { 0x24 };
        private static readonly byte[] Prefix_DependencyMaintenance = new byte[] { 0x25 };
        private static readonly byte[] Prefix_ConfigurationContextDepth = new byte[] { 0x26 };
        // Transaction-scoped marker for the confused-deputy boundary: while present, the core
        // is mid-execution of a user operation for some account, so the operation's target
        // observes the core itself as Runtime.CallingScriptHash. Callees that act on that
        // identity — paymaster settlement, market listing retirement — query
        // IsUserOpExecutionActive() and refuse to run meanwhile, because one core backs every
        // virtual account and "the caller is the SA core" alone cannot identify an authorization.
        // The marker is a depth counter (audit Low 6): the value records the transaction hash
        // plus the number of active execution frames, so the unwind of a nested frame decrements
        // it instead of deleting the slot while an outer frame still executes.
        private static readonly byte[] Prefix_UserOperationInFlight = new byte[] { 0x28 };

        private static readonly BigInteger MaxMetadataUriLength = 240;

        private static BigInteger GetConfigurationContextDepth()
        {
            ByteString? depth = Storage.Get(Storage.CurrentContext, Prefix_ConfigurationContextDepth);
            return depth == null ? BigInteger.Zero : (BigInteger)depth;
        }

        private static void EnterConfigurationContext()
        {
            Storage.Put(Storage.CurrentContext, Prefix_ConfigurationContextDepth, GetConfigurationContextDepth() + 1);
        }

        private static void ExitConfigurationContext()
        {
            BigInteger depth = GetConfigurationContextDepth();
            ExecutionEngine.Assert(depth > 0, "Account configuration context underflow");
            if (depth == 1)
            {
                Storage.Delete(Storage.CurrentContext, Prefix_ConfigurationContextDepth);
            }
            else
            {
                Storage.Put(Storage.CurrentContext, Prefix_ConfigurationContextDepth, depth - 1);
            }
        }

        private static void SetVerifyContext(UInt160 accountId, UInt160 targetContract)
        {
            byte[] key = Helper.Concat(Prefix_VerifyContext, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, (byte[])targetContract);
            EnterConfigurationContext();
        }

        private static void ClearVerifyContext(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_VerifyContext, (byte[])accountId);
            if (Storage.Get(Storage.CurrentContext, key) == null) return;
            Storage.Delete(Storage.CurrentContext, key);
            ExitConfigurationContext();
        }

        [Safe]
        public static bool IsExecutionActive(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_ExecutionLock, (byte[])accountId);
            return Storage.Get(Storage.CurrentContext, key) != null;
        }

        private static void SetExecutionLock(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_ExecutionLock, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
            EnterConfigurationContext();
        }

        private static void ClearExecutionLock(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_ExecutionLock, (byte[])accountId);
            if (Storage.Get(Storage.CurrentContext, key) == null) return;
            Storage.Delete(Storage.CurrentContext, key);
            ExitConfigurationContext();
        }

        /// <summary>
        /// True while the core is executing a user operation for any account in this transaction.
        /// Sponsored settlement and market escrow unwind happen outside that window, so a callee
        /// that observes the core as its caller can distinguish the protocol's own callbacks from
        /// an ordinary operation routed to it through <c>executeUserOp</c>.
        /// </summary>
        /// <remarks>
        /// The marker is written and cleared inside a single <c>executeUserOp</c> invocation and a
        /// faulting transaction rolls storage back, so a persisted marker can only be a leftover
        /// of an earlier transaction; its recorded hash no longer matches and it therefore
        /// reports "not in flight". The recorded value carries a depth counter: a nested
        /// <c>executeUserOp</c> for a different account (the per-account lock only rejects
        /// same-account re-entry) increments it and its unwind decrements it, so the slot is
        /// deleted only when the outermost execution frame closes.
        /// </remarks>
        [Safe]
        public static bool IsUserOpExecutionActive()
        {
            ByteString? marker = Storage.Get(Storage.CurrentContext, Prefix_UserOperationInFlight);
            if (marker == null) return false;
            object[] record = (object[])StdLib.Deserialize(marker);
            UInt256 recorded = (UInt256)(byte[])(ByteString)record[0];
            return recorded == Runtime.Transaction.Hash;
        }

        // Depth invariants: 0 (absent) -> 1 marks the outermost execution; a nested frame
        // for another account increments; each unwind decrements; 0 clears the slot. A
        // single-slot write would let a nested frame's unwind delete the marker while the
        // outer frame still executes, silently re-opening the deputy window for the rest
        // of that outer operation (audit Low 6, defense-in-depth: no direct exploit).
        private static void MarkUserOperationInFlight()
        {
            BigInteger depth = BigInteger.Zero;
            ByteString? marker = Storage.Get(Storage.CurrentContext, Prefix_UserOperationInFlight);
            if (marker != null)
            {
                object[] record = (object[])StdLib.Deserialize(marker);
                // A leftover from an earlier transaction does not count: the new
                // transaction's outermost frame restarts the depth at one.
                if ((UInt256)(byte[])(ByteString)record[0] == Runtime.Transaction.Hash)
                {
                    depth = (BigInteger)record[1];
                }
            }
            Storage.Put(Storage.CurrentContext, Prefix_UserOperationInFlight,
                StdLib.Serialize(new object[] { Runtime.Transaction.Hash, depth + 1 }));
        }

        private static void UnmarkUserOperationInFlight()
        {
            ByteString? marker = Storage.Get(Storage.CurrentContext, Prefix_UserOperationInFlight);
            if (marker == null) return;
            object[] record = (object[])StdLib.Deserialize(marker);
            // A stale leftover (an earlier transaction's fault) is simply dropped.
            if ((UInt256)(byte[])(ByteString)record[0] != Runtime.Transaction.Hash)
            {
                Storage.Delete(Storage.CurrentContext, Prefix_UserOperationInFlight);
                return;
            }
            BigInteger depth = (BigInteger)record[1];
            if (depth <= BigInteger.One)
            {
                Storage.Delete(Storage.CurrentContext, Prefix_UserOperationInFlight);
                return;
            }
            Storage.Put(Storage.CurrentContext, Prefix_UserOperationInFlight,
                StdLib.Serialize(new object[] { Runtime.Transaction.Hash, depth - 1 }));
        }

        private static void AssertGlobalConfigurationIdle()
        {
            ExecutionEngine.Assert(GetConfigurationContextDepth() == 0, "Global configuration context active");
        }

        /// <summary>
        /// Idle gate for every account state change: no open configuration
        /// frame, no execution lock, no verify context and no 0x58
        /// application context. The legacy 0x04/0x05/0x0D/0x0E context
        /// pointers are retired with the old model.
        /// </summary>
        private static void AssertAccountConfigurationIdle(UInt160 accountId)
        {
            ExecutionEngine.Assert(GetConfigurationContextDepth() == 0
                && !IsExecutionActive(accountId)
                && Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_VerifyContext, (byte[])accountId)) == null
                && GetApplicationContext(accountId) == null,
                "Account configuration context active");
        }
    }
}
