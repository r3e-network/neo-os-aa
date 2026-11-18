using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Minimal protocol-v4 SA-core stub used by module runtime tests.
    /// </summary>
    /// <remarks>
    /// A v4 module never trusts a caller-declared instance. It authenticates the caller,
    /// then asks the core which of its instances the current writer phase addresses
    /// (<c>getAuthorizedModuleId(accountId, phase)</c>), reads the recorded instance
    /// through <c>getModule(accountId, moduleId)</c> (index 8 is the credential
    /// generation) and resolves the asset-holding script hash through
    /// <c>getProxyScriptHash</c> / <c>getAccountAddress</c>. This stub answers those
    /// reads from storage so tests can drive the same code paths as the real core,
    /// and relays calls through <see cref="Forward"/> so a plugin observes this
    /// contract as <c>Runtime.CallingScriptHash</c>. It is test-only infrastructure
    /// and must never be deployed to a live network.
    /// </remarks>
    [DisplayName("MockVerifierCore")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only protocol-v4 SA core stub for module authority checks")]
    public class MockVerifierCore : SmartContract
    {
        private static readonly byte[] Prefix_AuthorizedModule = new byte[] { 0x01 };
        private static readonly byte[] Prefix_Module = new byte[] { 0x02 };
        private static readonly byte[] Prefix_AccountAddress = new byte[] { 0x03 };

        // Proxy verification script layout, byte-for-byte the core's SmartAccount.Proxy.cs:
        //   PUSHDATA1 20 <accountId> | PUSH1 PACK PUSH15 | PUSHDATA1 6 "verify" |
        //   PUSHDATA1 20 <core> | SYSCALL System.Contract.Call
        private static readonly byte[] ProxyScriptPushData20 = new byte[] { 0x0C, 0x14 };
        private static readonly byte[] ProxyScriptVerifyCall = new byte[]
        {
            0x11, 0xC0, 0x1F, 0x0C, 0x06, 0x76, 0x65, 0x72, 0x69, 0x66, 0x79, 0x0C, 0x14
        };
        private static readonly byte[] SyscallSystemContractCall = new byte[] { 0x41, 0x62, 0x7D, 0x5B, 0x52 };

        private static byte[] U64BE(BigInteger value)
        {
            ExecutionEngine.Assert(value >= 0 && value < (BigInteger.One << 64), "Invalid uint64");
            byte[] encoded = new byte[8];
            for (int i = 7; i >= 0; i--)
            {
                encoded[i] = (byte)(value & 255);
                value >>= 8;
            }
            return encoded;
        }

        private static byte[] InstanceKey(byte[] prefix, UInt160 accountId, BigInteger moduleId)
        {
            return Helper.Concat(Helper.Concat(prefix, (byte[])accountId), U64BE(moduleId));
        }

        /// <summary>
        /// Records the instance the core addresses in one writer phase, exactly the value
        /// the real core returns from <c>getAuthorizedModuleId</c>.
        /// </summary>
        public static void SetAuthorizedModuleId(UInt160 accountId, BigInteger phase, BigInteger moduleId)
        {
            ExecutionEngine.Assert(phase >= 1 && phase <= 6, "Unknown phase");
            Storage.Put(Storage.CurrentContext, InstanceKey(Prefix_AuthorizedModule, accountId, phase), moduleId);
        }

        [Safe]
        public static BigInteger GetAuthorizedModuleId(UInt160 accountId, BigInteger phase)
        {
            ByteString? value = Storage.Get(Storage.CurrentContext,
                InstanceKey(Prefix_AuthorizedModule, accountId, phase));
            return value == null ? BigInteger.Zero : (BigInteger)value;
        }

        /// <summary>
        /// Installs a stub module instance with the fields modules actually read, so
        /// <see cref="GetModule"/> can answer with the real 12-element descriptor layout.
        /// </summary>
        public static void SetModule(UInt160 accountId, BigInteger moduleId, BigInteger moduleType,
            BigInteger credentialGeneration, bool instanceIsolation, bool messageCapability,
            bool thresholdMemberEligible)
        {
            ExecutionEngine.Assert(moduleId > 0 && moduleType >= 1 && moduleType <= 2, "Invalid module");
            Storage.Put(Storage.CurrentContext, InstanceKey(Prefix_Module, accountId, moduleId),
                StdLib.Serialize(new object[]
                {
                    moduleId, moduleType, credentialGeneration, instanceIsolation,
                    messageCapability, thresholdMemberEligible
                }));
        }

        /// <summary>
        /// Descriptor layout of the real core (SmartAccount.State.cs):
        /// [moduleId, moduleType, contractHash, contractId, updateCounter, nefSha256,
        ///  profileSha256, moduleRevision, credentialGeneration, instanceIsolation,
        ///  messageCapability, thresholdMemberEligible]; empty when not installed.
        /// </summary>
        [Safe]
        public static object[] GetModule(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? value = Storage.Get(Storage.CurrentContext,
                InstanceKey(Prefix_Module, accountId, moduleId));
            if (value == null) return new object[0];
            object[] stored = (object[])StdLib.Deserialize(value!);
            return new object[]
            {
                (BigInteger)stored[0],
                (BigInteger)stored[1],
                Runtime.ExecutingScriptHash,
                BigInteger.Zero,
                BigInteger.Zero,
                (ByteString)new byte[32],
                (ByteString)new byte[32],
                BigInteger.One,
                (BigInteger)stored[2],
                (bool)stored[3],
                (bool)stored[4],
                (bool)stored[5]
            };
        }

        /// <summary>Native-core asset address override; defaults to the account id itself.</summary>
        public static void SetAccountAddress(UInt160 accountId, UInt160 address)
        {
            Storage.Put(Storage.CurrentContext, Helper.Concat(Prefix_AccountAddress, (byte[])accountId), (byte[])address);
        }

        [Safe]
        public static UInt160 GetAccountAddress(UInt160 accountId)
        {
            ByteString? value = Storage.Get(Storage.CurrentContext,
                Helper.Concat(Prefix_AccountAddress, (byte[])accountId));
            return value == null ? accountId : (UInt160)value;
        }

        /// <summary>
        /// Address that holds a virtual account's assets when this stub plays the custom
        /// core: the same pure derivation as the real core's <c>getProxyScriptHash</c>, so
        /// verifier and hook vectors that meter or gate on the asset address see a value
        /// that differs from the account id exactly as they would on chain.
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

        // The core exposes this marker so protocol paymasters can close the
        // confused-deputy window on settlement; this stub reports that no user
        // operation is in flight.
        [Safe]
        public static bool IsUserOpExecutionActive() => false;

        /// <summary>
        /// Forwards an arbitrary call so the target observes this contract as its caller.
        /// </summary>
        public static object Forward(UInt160 target, string method, object[] args)
        {
            return Contract.Call(target, method, CallFlags.All, args);
        }

        public static object ForwardAfter(UInt160 firstTarget, string firstMethod, object[] firstArgs,
            UInt160 target, string method, object[] args)
        {
            Contract.Call(firstTarget, firstMethod, CallFlags.All, firstArgs);
            return Contract.Call(target, method, CallFlags.All, args);
        }

        /// <summary>Block time the VM is executing against, so tests compute periods exactly.</summary>
        [Safe]
        public static BigInteger Now() => Runtime.Time;
    }
}
