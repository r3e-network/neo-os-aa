using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
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

        // Test-only V3 surface used to model a plugin whose cleanup fails. The production AA
        // core must fail closed rather than silently transferring such a dirty shell.
        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool ValidateSignature(UInt160 accountId, object op) => true;

        public static void PostExecute(UInt160 accountId, object op, object result)
        {
        }

        public static void ClearAccount(UInt160 accountId)
        {
            ExecutionEngine.Assert(false, "Mock plugin cleanup failure");
        }

        [Safe]
        public static bool CanConfigureVerifier(UInt160 accountId, UInt160 verifier) => true;

        [Safe]
        public static bool CanConfigureHook(UInt160 accountId, UInt160 hook) => true;

        // Proxy verification script layout, byte-for-byte the core's UnifiedSmartWallet.Proxy.cs:
        //   PUSHDATA1 20 <accountId> | PUSH1 PACK PUSH15 | PUSHDATA1 6 "verify" |
        //   PUSHDATA1 20 <core> | SYSCALL System.Contract.Call
        private static readonly byte[] ProxyScriptPushData20 = new byte[] { 0x0C, 0x14 };
        private static readonly byte[] ProxyScriptVerifyCall = new byte[]
        {
            0x11, 0xC0, 0x1F, 0x0C, 0x06, 0x76, 0x65, 0x72, 0x69, 0x66, 0x79, 0x0C, 0x14
        };
        private static readonly byte[] SyscallSystemContractCall = new byte[] { 0x41, 0x62, 0x7D, 0x5B, 0x52 };

        /// <summary>
        /// Address that holds a virtual account's assets when this stub plays the core: the same
        /// pure derivation as the real core's <c>getProxyScriptHash</c>, so verifier and hook
        /// vectors that meter or gate on the asset address see a value that differs from the
        /// account id exactly as they would on chain.
        /// </summary>
        [Safe]
        public static UInt160 GetProxyScriptHash(UInt160 accountId)
        {
            ExecutionEngine.Assert(accountId != null && accountId != UInt160.Zero, "account id required");
            ByteString script = (ByteString)ProxyScriptPushData20;
            script = Helper.Concat(script, (ByteString)(byte[])accountId!);
            script = Helper.Concat(script, (ByteString)ProxyScriptVerifyCall);
            script = Helper.Concat(script, (ByteString)(byte[])Runtime.ExecutingScriptHash);
            script = Helper.Concat(script, (ByteString)SyscallSystemContractCall);
            return (UInt160)CryptoLib.Ripemd160(CryptoLib.Sha256(script));
        }

        [Safe]
        public static bool CanExecuteVerifier(UInt160 accountId, UInt160 caller, UInt160 verifier) => true;

        [Safe]
        public static bool CanExecuteHook(UInt160 accountId, UInt160 caller, UInt160 hook) => true;

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
