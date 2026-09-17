using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Mocks
{
    /// <summary>
    /// Minimal AA-core stub used by verifier runtime tests.
    /// </summary>
    /// <remarks>
    /// Verifier plugins gate configuration and post-execution effects through
    /// <c>VerifierAuthority</c>, which requires the caller to be the authorized AA core and
    /// asks that core to approve the operation via <c>canConfigureVerifier</c> /
    /// <c>canExecuteVerifier</c>. This stub plays that core role for tests: it approves both
    /// checks and exposes a generic <see cref="Forward"/> so a test can invoke a verifier
    /// method while the verifier observes this contract as <c>Runtime.CallingScriptHash</c>.
    /// It is test-only infrastructure and must never be deployed to a live network.
    /// </remarks>
    [DisplayName("MockVerifierCore")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only AA core stub for verifier authority checks")]
    public class MockVerifierCore : SmartContract
    {
        private static readonly byte[] Prefix_BackupOwner = new byte[] { 0x01 };

        [Safe]
        public static bool CanConfigureVerifier(UInt160 accountId, UInt160 verifier) => true;

        [Safe]
        public static bool CanExecuteVerifier(UInt160 accountId, UInt160 caller, UInt160 verifier) => true;

        public static void SetBackupOwner(UInt160 accountId, UInt160 owner)
        {
            Storage.Put(Storage.CurrentContext, Helper.Concat(Prefix_BackupOwner, (byte[])accountId), (byte[])owner);
        }

        [Safe]
        public static UInt160 GetBackupOwner(UInt160 accountId)
        {
            ByteString? value = Storage.Get(
                Storage.CurrentContext,
                Helper.Concat(Prefix_BackupOwner, (byte[])accountId));
            return value == null ? UInt160.Zero : (UInt160)value;
        }

        /// <summary>
        /// Forwards an arbitrary call so the target observes this contract as its caller.
        /// </summary>
        public static object Forward(UInt160 target, string method, object[] args)
        {
            return Contract.Call(target, method, CallFlags.All, args);
        }

        /// <summary>
        /// Exposes the block time the VM is executing against so tests can compute billing periods exactly.
        /// </summary>
        [Safe]
        public static BigInteger Now() => Runtime.Time;
    }
}
