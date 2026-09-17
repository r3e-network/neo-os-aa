using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    internal static class VerifierAuthority
    {
        private static readonly byte[] Prefix_Admin = new byte[] { 0xE0 };
        private static readonly byte[] Prefix_AuthorizedCore = new byte[] { 0xE1 };
        private static readonly byte[] Prefix_PendingAdmin = new byte[] { 0xE2 };
        private static readonly byte[] Prefix_AdminRotationTimelock = new byte[] { 0xE3 };
        // Audit fix M-7 (parity with HookAuthority): timelocked change of the trusted AA
        // core (repointing it lets the new "core" reconfigure every bound account, so it
        // must not be instant). New prefixes — never written by previous deployments.
        private static readonly byte[] Prefix_PendingCore = new byte[] { 0xE4 };
        private static readonly byte[] Prefix_CoreTimelock = new byte[] { 0xE5 };
        // AA-D-01: timelocked contract upgrade. The admin first proposes the sha256 of the
        // new NEF and manifest, then can only apply that exact artifact pair after the
        // 7-day window. This is one-way: once deployed, every future upgrade waits 7 days.
        private static readonly byte[] Prefix_PendingUpdateNefHash = new byte[] { 0xE6 };
        private static readonly byte[] Prefix_PendingUpdateManifestHash = new byte[] { 0xE7 };
        private static readonly byte[] Prefix_UpdateTimelock = new byte[] { 0xE8 };
        private static readonly BigInteger AdminRotationTimelockMs = 7L * 24 * 60 * 60 * 1000;

        internal static void Initialize(object data, bool update)
        {
            if (update) return;

            Storage.Put(Storage.CurrentContext, Prefix_Admin, Runtime.Transaction.Sender);

            if (data is byte[] rawCore && rawCore.Length == 20)
            {
                Storage.Put(Storage.CurrentContext, Prefix_AuthorizedCore, rawCore);
                return;
            }

            if (data is ByteString rawCoreByteString && rawCoreByteString.Length == 20)
            {
                Storage.Put(Storage.CurrentContext, Prefix_AuthorizedCore, (byte[])rawCoreByteString);
            }
        }

        internal static UInt160 AuthorizedCore()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Prefix_AuthorizedCore);
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        internal static UInt160 Admin()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Prefix_Admin);
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        internal static void SetAuthorizedCore(UInt160 coreContract)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(coreContract != UInt160.Zero && coreContract.IsValid, "Invalid core contract");
            // Audit fix M-7: instant set is permitted ONLY for the initial (unset)
            // configuration. Re-pointing an already-configured core must go through the
            // timelocked Propose/ConfirmAuthorizedCore path so account owners get a
            // 7-day window to react before their verifier bindings could be hijacked.
            ExecutionEngine.Assert(AuthorizedCore() == UInt160.Zero, "core already set; use ProposeAuthorizedCore");
            Storage.Put(Storage.CurrentContext, Prefix_AuthorizedCore, (byte[])coreContract);
        }

        internal static void ProposeAuthorizedCore(UInt160 coreContract)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(coreContract != UInt160.Zero && coreContract.IsValid, "Invalid core contract");
            Storage.Put(Storage.CurrentContext, Prefix_PendingCore, (byte[])coreContract);
            Storage.Put(Storage.CurrentContext, Prefix_CoreTimelock, Runtime.Time);
        }

        internal static void ConfirmAuthorizedCore(UInt160 coreContract)
        {
            ValidateAdmin();
            ByteString? pending = Storage.Get(Storage.CurrentContext, Prefix_PendingCore);
            ExecutionEngine.Assert(pending != null, "No pending core change");
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, Prefix_CoreTimelock);
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)timelockData + AdminRotationTimelockMs, "Core change timelock not expired");
            ExecutionEngine.Assert((UInt160)pending! == coreContract, "Pending core mismatch");
            Storage.Put(Storage.CurrentContext, Prefix_AuthorizedCore, (byte[])coreContract);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingCore);
            Storage.Delete(Storage.CurrentContext, Prefix_CoreTimelock);
        }

        internal static void CancelAuthorizedCoreChange()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, Prefix_PendingCore);
            Storage.Delete(Storage.CurrentContext, Prefix_CoreTimelock);
        }

        // AA-D-01: contract upgrade is timelocked. ProposeUpdate pins the sha256 of the
        // new NEF and manifest; Update/ConfirmUpdate applies exactly that artifact pair
        // only after the 7-day window. There is intentionally no instant upgrade path.
        internal static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(nefHash != UInt256.Zero && nefHash.IsValid, "Invalid NEF hash");
            ExecutionEngine.Assert(manifestHash != UInt256.Zero && manifestHash.IsValid, "Invalid manifest hash");
            Storage.Put(Storage.CurrentContext, Prefix_PendingUpdateNefHash, (byte[])nefHash);
            Storage.Put(Storage.CurrentContext, Prefix_PendingUpdateManifestHash, (byte[])manifestHash);
            Storage.Put(Storage.CurrentContext, Prefix_UpdateTimelock, Runtime.Time);
        }

        internal static void CancelUpdate()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateNefHash);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateManifestHash);
            Storage.Delete(Storage.CurrentContext, Prefix_UpdateTimelock);
        }

        internal static void Update(ByteString nef, string manifest)
        {
            ValidateAdmin();
            ByteString? pendingNef = Storage.Get(Storage.CurrentContext, Prefix_PendingUpdateNefHash);
            ExecutionEngine.Assert(pendingNef != null, "No pending update");
            ByteString? pendingManifest = Storage.Get(Storage.CurrentContext, Prefix_PendingUpdateManifestHash);
            ExecutionEngine.Assert(pendingManifest != null, "No pending update");
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, Prefix_UpdateTimelock);
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)timelockData + AdminRotationTimelockMs, "Update timelock not expired");
            ExecutionEngine.Assert((UInt256)CryptoLib.Sha256(nef) == (UInt256)pendingNef!, "NEF hash mismatch");
            ExecutionEngine.Assert((UInt256)CryptoLib.Sha256(manifest) == (UInt256)pendingManifest!, "Manifest hash mismatch");
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateNefHash);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateManifestHash);
            Storage.Delete(Storage.CurrentContext, Prefix_UpdateTimelock);
            ContractManagement.Update(nef, manifest);
        }

        internal static void ValidateConfigCaller(UInt160 accountId, UInt160 verifierContract)
        {
            UInt160 core = AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "AA core not configured");
            ExecutionEngine.Assert(Runtime.CallingScriptHash == core, "Unauthorized caller");

            bool authorized = (bool)Contract.Call(
                core,
                "canConfigureVerifier",
                CallFlags.ReadOnly,
                new object[] { accountId, verifierContract });
            ExecutionEngine.Assert(authorized, "Unauthorized");
        }

        internal static void ValidateExecutionCaller(UInt160 accountId, UInt160 callerContract, UInt160 verifierContract)
        {
            UInt160 core = AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "AA core not configured");

            bool authorized = (bool)Contract.Call(
                core,
                "canExecuteVerifier",
                CallFlags.ReadOnly,
                new object[] { accountId, callerContract, verifierContract });
            ExecutionEngine.Assert(authorized, "Unauthorized");
        }

        internal static void RotateAdmin(UInt160 newAdmin)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(newAdmin != null && newAdmin.IsValid, "Invalid admin");
            ExecutionEngine.Assert(newAdmin != Admin(), "New admin must differ from current");

            // Initiate timelocked rotation instead of instant swap
            Storage.Put(Storage.CurrentContext, Prefix_PendingAdmin, (byte[])newAdmin!);
            Storage.Put(Storage.CurrentContext, Prefix_AdminRotationTimelock, Runtime.Time);
        }

        internal static void ConfirmAdminRotation(UInt160 newAdmin)
        {
            ByteString? pending = Storage.Get(Storage.CurrentContext, Prefix_PendingAdmin);
            ExecutionEngine.Assert(pending != null, "No pending admin rotation");

            ByteString? timelockData = Storage.Get(Storage.CurrentContext, Prefix_AdminRotationTimelock);
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            BigInteger timelockStart = (BigInteger)timelockData;
            ExecutionEngine.Assert(Runtime.Time >= timelockStart + AdminRotationTimelockMs, "Admin rotation timelock not expired");

            ExecutionEngine.Assert((UInt160)pending! == newAdmin, "Pending admin mismatch");
            ExecutionEngine.Assert(Runtime.CheckWitness(newAdmin), "New admin must confirm rotation");
            Storage.Put(Storage.CurrentContext, Prefix_Admin, (byte[])newAdmin);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingAdmin);
            Storage.Delete(Storage.CurrentContext, Prefix_AdminRotationTimelock);
        }

        internal static void CancelAdminRotation()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, Prefix_PendingAdmin);
            Storage.Delete(Storage.CurrentContext, Prefix_AdminRotationTimelock);
        }

        private static void ValidateAdmin()
        {
            UInt160 admin = Admin();
            ExecutionEngine.Assert(admin != UInt160.Zero && admin.IsValid, "Admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "Unauthorized admin");
        }
    }
}
