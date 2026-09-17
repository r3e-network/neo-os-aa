using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        // ========================================================================
        // 1. Data Structures (aligned with ERC-4337 UserOperation)
        // ========================================================================

        public class AccountState
        {
            // ERC-4337 account-level authorization verifier (e.g., Web3Auth, TEE)
            public UInt160 Verifier = UInt160.Zero;

            // Policy and risk control plugin ecosystem
            public UInt160 HookId = UInt160.Zero;

            // --- L1 Native Escape Hatch ---

            // Bound underlying N3 EOA wallet (must be valid pubkey hash)
            public UInt160 BackupOwner = UInt160.Zero;

            // Escape lock time in seconds
            public uint EscapeTimelock;

            public BigInteger EscapeTriggeredAt;
        }

        // ERC-4337 UserOperation struct
        public class UserOperation
        {
            // callData target
            public UInt160 TargetContract = UInt160.Zero;

            // callData method
            public string Method = string.Empty;

            // callData params
            public object[] Args = new object[0];

            // ERC-4337 2D nonce: high 192 bits = channel, low 64 bits = sequence
            public BigInteger Nonce;

            // Replay protection expiry
            public BigInteger Deadline;

            // EIP-712 / TEE signature
            public ByteString Signature = (ByteString)new byte[0];
        }

        public class PendingConfigUpdate
        {
            public UInt160 NewVerifier = UInt160.Zero;
            public UInt160 NewHookId = UInt160.Zero;
            public ByteString VerifierParams = (ByteString)new byte[0];
            public BigInteger InitiatedAt;
        }

        public class PendingModuleCall
        {
            public UInt160 ModuleHash = UInt160.Zero;
            public ByteString CallHash = (ByteString)new byte[0];
            public BigInteger InitiatedAt;
        }
    }
}
