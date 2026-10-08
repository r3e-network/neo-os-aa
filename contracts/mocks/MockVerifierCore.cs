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
        private static readonly byte[] Prefix_BurnGas = new byte[] { 0x02 };
        private static readonly byte[] Prefix_VerifierDependencies = new byte[] { 0x03 };
        private static readonly byte[] Prefix_HookDependencies = new byte[] { 0x04 };
        private static readonly byte[] Prefix_BurnPostGas = new byte[] { 0x05 };
        private static readonly byte[] Prefix_LeafMode = new byte[] { 0x06 };

        // Test-only V3 surface used to model a plugin whose cleanup fails. The production AA
        // core must fail closed rather than silently transferring such a dirty shell.
        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsComposition()
        {
            ByteString? leaf = Storage.Get(Storage.CurrentContext, Prefix_LeafMode);
            return leaf == null || leaf.Length == 0 || leaf[0] != 1;
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId)
        {
            return new ByteString[] { (ByteString)new byte[] {
                0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
                0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x30,
                0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
                0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40
            } };
        }

        public static void SetLeafMode(bool enabled)
        {
            Storage.Put(Storage.CurrentContext, Prefix_LeafMode,
                (ByteString)new byte[] { enabled ? (byte)1 : (byte)0 });
        }

        [Safe]
        public static bool ValidateSignature(UInt160 accountId, object op)
        {
            BurnIfEnabled(Prefix_BurnGas);
            return true;
        }

        public static void SetBurnGas(bool enabled)
        {
            Storage.Put(Storage.CurrentContext, Prefix_BurnGas,
                (ByteString)new byte[] { enabled ? (byte)1 : (byte)0 });
        }

        public static void SetBurnPostGas(bool enabled)
        {
            Storage.Put(Storage.CurrentContext, Prefix_BurnPostGas,
                (ByteString)new byte[] { enabled ? (byte)1 : (byte)0 });
        }

        public static void PostExecute(UInt160 accountId, object op, object result)
        {
            BurnIfEnabled(Prefix_BurnPostGas);
        }

        private static void BurnIfEnabled(byte[] prefix)
        {
            ByteString? enabled = Storage.Get(Storage.CurrentContext, prefix);
            if (enabled == null || enabled.Length == 0 || enabled[0] != 1) return;

            ByteString digest = (ByteString)new byte[] { 0x01, 0x02, 0x03, 0x04 };
            for (int i = 0; i < 2_000_000; i++)
                digest = CryptoLib.Sha256(digest);
            ExecutionEngine.Assert(digest.Length > 0, "unreachable");
        }

        public static void ClearAccount(UInt160 accountId)
        {
            ByteString? leaf = Storage.Get(Storage.CurrentContext, Prefix_LeafMode);
            if (leaf != null && leaf.Length > 0 && leaf[0] == 1) return;
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

        // Test-only dependency registry used to exercise the same composite cleanup
        // contract as UnifiedSmartWallet without deploying a full account fixture.
        public static void SetVerifierDependencies(UInt160 accountId, UInt160[] children)
        {
            byte[] key = Helper.Concat(Prefix_VerifierDependencies, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data != null)
            {
                UInt160[] previous = (UInt160[])StdLib.Deserialize(data!);
                for (int i = 0; i < previous.Length; i++)
                {
                    bool retained = false;
                    for (int j = 0; j < children.Length; j++)
                    {
                        if (previous[i] == children[j])
                        {
                            retained = true;
                            break;
                        }
                    }
                    if (!retained)
                    {
                        Contract.Call(previous[i], "clearAccount", CallFlags.All, new object[] { accountId });
                    }
                }
            }
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(children));
        }

        public static void ClearVerifierDependencies(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_VerifierDependencies, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return;

            UInt160[] children = (UInt160[])StdLib.Deserialize(data!);
            for (int i = 0; i < children.Length; i++)
            {
                Contract.Call(children[i], "clearAccount", CallFlags.All, new object[] { accountId });
            }
            Storage.Delete(Storage.CurrentContext, key);
        }

        public static void SetHookDependencies(UInt160 accountId, UInt160[] children)
        {
            byte[] key = Helper.Concat(Prefix_HookDependencies, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data != null)
            {
                UInt160[] previous = (UInt160[])StdLib.Deserialize(data!);
                for (int i = 0; i < previous.Length; i++)
                {
                    bool retained = false;
                    for (int j = 0; j < children.Length; j++)
                    {
                        if (previous[i] == children[j])
                        {
                            retained = true;
                            break;
                        }
                    }
                    if (!retained)
                    {
                        Contract.Call(previous[i], "clearAccount", CallFlags.All, new object[] { accountId });
                    }
                }
            }
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(children));
        }

        public static void ClearHookDependencies(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_HookDependencies, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return;

            UInt160[] children = (UInt160[])StdLib.Deserialize(data!);
            for (int i = 0; i < children.Length; i++)
            {
                Contract.Call(children[i], "clearAccount", CallFlags.All, new object[] { accountId });
            }
            Storage.Delete(Storage.CurrentContext, key);
        }

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
