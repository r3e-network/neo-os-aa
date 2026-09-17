using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        // ========================================================================
        // Virtual-account proxy address
        // ========================================================================
        //
        // A virtual AA account holds its on-chain assets at the script hash of a
        // fixed "proxy" verification script (devpack `deriveVirtualAAAccount`):
        //
        //   PUSHDATA1 20 <accountId>
        //   PUSH1 PACK PUSH15
        //   PUSHDATA1 6 "verify"
        //   PUSHDATA1 20 <core>
        //   SYSCALL System.Contract.Call
        //
        // Hooks, verifiers and consumers must meter and restrict against this
        // address, not against the accountId (which never holds a balance).
        // The derivation is pure, so it is computed rather than stored.

        private static readonly byte[] ProxyScriptPushData20 = new byte[] { 0x0C, 0x14 };

        // PUSH1 PACK PUSH15 PUSHDATA1 6 "verify" PUSHDATA1 20
        private static readonly byte[] ProxyScriptVerifyCall = new byte[]
        {
            0x11, 0xC0, 0x1F, 0x0C, 0x06, 0x76, 0x65, 0x72, 0x69, 0x66, 0x79, 0x0C, 0x14
        };

        // SYSCALL System.Contract.Call
        private static readonly byte[] SyscallSystemContractCall = new byte[] { 0x41, 0x62, 0x7D, 0x5B, 0x52 };

        /// <summary>
        /// Script hash of the proxy verification script that funds are sent to for
        /// <paramref name="accountId"/> on this core. Pure function of (core, accountId).
        /// </summary>
        [Safe]
        public static UInt160 GetProxyScriptHash(UInt160 accountId)
        {
            ExecutionEngine.Assert(accountId != null && accountId != UInt160.Zero, "account id required");
            ByteString script = BuildProxyVerificationScript(accountId!);
            return (UInt160)CryptoLib.Ripemd160(CryptoLib.Sha256(script));
        }

        private static ByteString BuildProxyVerificationScript(UInt160 accountId)
        {
            ByteString script = (ByteString)ProxyScriptPushData20;
            script = Helper.Concat(script, (ByteString)(byte[])accountId);
            script = Helper.Concat(script, (ByteString)ProxyScriptVerifyCall);
            script = Helper.Concat(script, (ByteString)(byte[])Runtime.ExecutingScriptHash);
            script = Helper.Concat(script, (ByteString)SyscallSystemContractCall);
            return script;
        }
    }
}
