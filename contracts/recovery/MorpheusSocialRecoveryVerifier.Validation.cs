using System;
using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace Neo.SmartContract.Examples
{
    public partial class SocialRecoveryVerifier
    {
        private static ByteString ComputeRecoveryDigest(
            string network,
            UInt160 aaContract,
            UInt160 accountAddress,
            string accountIdText,
            UInt160 newOwner,
            string recoveryNonceText,
            string expiresAtText,
            string actionId,
            ByteString masterNullifier,
            ByteString actionNullifier)
        {
            ByteString payload = (ByteString)RECOVERY_DOMAIN;
            payload = Helper.Concat(payload, EncodeSegment(network));
            payload = Helper.Concat(payload, (ByteString)(byte[])aaContract);
            payload = Helper.Concat(payload, (ByteString)(byte[])Runtime.ExecutingScriptHash);
            payload = Helper.Concat(payload, (ByteString)(byte[])accountAddress);
            payload = Helper.Concat(payload, EncodeSegment(accountIdText));
            payload = Helper.Concat(payload, (ByteString)(byte[])newOwner);
            payload = Helper.Concat(payload, EncodeSegment(recoveryNonceText));
            payload = Helper.Concat(payload, EncodeSegment(expiresAtText));
            payload = Helper.Concat(payload, EncodeSegment(actionId));
            payload = Helper.Concat(payload, masterNullifier);
            payload = Helper.Concat(payload, actionNullifier);
            return CryptoLib.Sha256(payload);
        }

        private static ByteString ComputeActionDigest(
            UInt160 accountId,
            UInt160 executor,
            string actionId,
            ulong expiresAt,
            ByteString actionNullifier)
        {
            // Bind the domain, this verifier contract, the network and the target account so an
            // action signature cannot be replayed across contracts, networks or accounts; bind
            // expiresAt so it cannot be replayed past its intended lifetime.
            ByteString payload = (ByteString)ACTION_DOMAIN;
            payload = Helper.Concat(payload, EncodeSegment(GetNetwork(accountId)));
            payload = Helper.Concat(payload, (ByteString)(byte[])Runtime.ExecutingScriptHash);
            payload = Helper.Concat(payload, EncodeSegment(GetAccountIdText(accountId)));
            payload = Helper.Concat(payload, (ByteString)(byte[])executor);
            payload = Helper.Concat(payload, EncodeSegment(actionId));
            payload = Helper.Concat(payload, EncodeSegment(expiresAt.ToString()));
            payload = Helper.Concat(payload, actionNullifier);
            return CryptoLib.Sha256(payload);
        }

        private static string BuildActionId(UInt160 accountId, UInt160 executor, BigInteger sessionNonce, ulong expiresAt)
        {
            ByteString material = (ByteString)GetNetwork(accountId);
            material = Helper.Concat(material, (ByteString)new byte[] { 0x1f });
            material = Helper.Concat(material, (ByteString)(byte[])GetAAContract(accountId));
            material = Helper.Concat(material, (ByteString)new byte[] { 0x1f });
            material = Helper.Concat(material, (ByteString)(byte[])accountId);
            material = Helper.Concat(material, (ByteString)new byte[] { 0x1f });
            material = Helper.Concat(material, (ByteString)(byte[])executor);
            material = Helper.Concat(material, (ByteString)new byte[] { 0x1f });
            material = Helper.Concat(material, (ByteString)sessionNonce.ToString());
            material = Helper.Concat(material, (ByteString)new byte[] { 0x1f });
            material = Helper.Concat(material, (ByteString)expiresAt.ToString());
            return "aa_proxy:" + BytesToHex(CryptoLib.Sha256(material));
        }

        private static string BuildRecoveryActionId(UInt160 accountId, UInt160 newOwner, string recoveryNonceText)
        {
            ByteString material = (ByteString)GetNetwork(accountId);
            material = Helper.Concat(material, (ByteString)new byte[] { 0x1f });
            material = Helper.Concat(material, (ByteString)(byte[])GetAAContract(accountId));
            material = Helper.Concat(material, (ByteString)new byte[] { 0x1f });
            material = Helper.Concat(material, (ByteString)(byte[])accountId);
            material = Helper.Concat(material, (ByteString)new byte[] { 0x1f });
            material = Helper.Concat(material, (ByteString)(byte[])newOwner);
            material = Helper.Concat(material, (ByteString)new byte[] { 0x1f });
            material = Helper.Concat(material, (ByteString)recoveryNonceText);
            return "aa_recovery:" + BytesToHex(CryptoLib.Sha256(material));
        }

        private static ByteString EncodeSegment(string value)
        {
            ValidateShortText(value, "segment");
            ExecutionEngine.Assert(value.Length <= 255, "segment too long");
            ByteString body = (ByteString)value;
            return Helper.Concat((ByteString)new byte[] { (byte)value.Length }, body);
        }

        private static BigInteger ParsePositiveDecimal(string value, string fieldName)
        {
            ValidateShortText(value, fieldName);
            BigInteger result = 0;
            for (int i = 0; i < value.Length; i++)
            {
                char current = value[i];
                ExecutionEngine.Assert(current >= '0' && current <= '9', fieldName + " must be decimal");
                result = (result * 10) + (current - '0');
            }
            return result;
        }

        private static byte[] Key(byte prefix, UInt160 accountId) =>
            Helper.Concat(new byte[] { prefix }, (ByteString)(byte[])accountId);

        private static string HashToHex(UInt160 value)
        {
            return "0x" + BytesToHex((ByteString)(byte[])value);
        }

        private static string BytesToHex(ByteString value)
        {
            byte[] data = (byte[])value;
            string hex = "";
            for (int i = 0; i < data.Length; i++)
            {
                hex += NibbleToHex((byte)(data[i] >> 4));
                hex += NibbleToHex((byte)(data[i] & 0x0F));
            }
            return hex;
        }

        private static string NibbleToHex(byte value)
        {
            if (value < 10) return ((char)('0' + value)).ToString();
            return ((char)('a' + (value - 10))).ToString();
        }

        private static byte[] UsedActionKey(UInt160 accountId, ByteString actionNullifier)
        {
            byte[] key = Key(PREFIX_USED_ACTION, accountId);
            return Helper.Concat(key, actionNullifier);
        }

        private static byte[] ApprovalKey(UInt160 accountId, BigInteger recoveryNonce, ByteString masterNullifier)
        {
            byte[] key = Key(PREFIX_APPROVAL, accountId);
            key = Helper.Concat(key, recoveryNonce.ToByteArray());
            return Helper.Concat(key, masterNullifier);
        }

        private static byte[] OracleRequestKey(BigInteger requestId)
        {
            return Helper.Concat(new byte[] { PREFIX_ORACLE_REQUEST }, requestId.ToByteArray());
        }

        private static byte[] OracleActionRequestKey(BigInteger requestId)
        {
            return Helper.Concat(new byte[] { PREFIX_ORACLE_ACTION_REQUEST }, requestId.ToByteArray());
        }

        private static void ValidateAccountId(UInt160 accountId, string name)
        {
            ExecutionEngine.Assert(accountId != null && accountId.IsValid && accountId != UInt160.Zero, name + " is invalid");
        }

        private static void ValidateAddress(UInt160 address, string name)
        {
            ExecutionEngine.Assert(address != null && address.IsValid && address != UInt160.Zero, name + " is invalid");
        }

        private static void ValidateShortText(string value, string name)
        {
            ExecutionEngine.Assert(value != null && value.Length > 0 && value.Length <= MAX_TEXT_LENGTH, name + " is invalid");
        }

        private static void ValidateLongText(string value, int maxLength, string name)
        {
            ExecutionEngine.Assert(value != null && value.Length > 0 && value.Length <= maxLength, name + " is invalid");
        }

        private static void ValidateVerifier(ECPoint morpheusVerifier)
        {
            ExecutionEngine.Assert(morpheusVerifier != null && morpheusVerifier.IsValid, "invalid Morpheus verifier");
        }

        private static void ValidateMasterNullifiers(ByteString[] masterNullifiers, BigInteger threshold)
        {
            ByteString[] factors = masterNullifiers ?? new ByteString[] { };
            ExecutionEngine.Assert(factors.Length > 0, "master nullifiers required");
            ExecutionEngine.Assert(factors.Length <= MAX_FACTORS, "too many recovery factors");
            ExecutionEngine.Assert(threshold > 0 && threshold <= factors.Length, "invalid threshold");
            for (int i = 0; i < factors.Length; i++)
            {
                ValidateFixedHash(factors[i], "invalid master nullifier");
                for (int j = i + 1; j < factors.Length; j++)
                {
                    ExecutionEngine.Assert(!factors[i].Equals(factors[j]), "duplicate master nullifier");
                }
            }
        }

        private static void ValidateFixedHash(ByteString value, string message)
        {
            ExecutionEngine.Assert(value != null && value.Length == FIXED_HASH_LENGTH, message);
        }

        private static void ValidateSignature(ByteString value)
        {
            ExecutionEngine.Assert(value != null && value.Length == FIXED_SIGNATURE_LENGTH, "invalid verification signature");
        }

        private static void AssertOwner(UInt160 accountId)
        {
            UInt160 owner = GetOwner(accountId);
            ExecutionEngine.Assert(owner != UInt160.Zero && Runtime.CheckWitness(owner), "Not owner");
        }

        private static void AssertContractAdmin()
        {
            UInt160 admin = GetContractAdmin();
            ExecutionEngine.Assert(admin != UInt160.Zero && Runtime.CheckWitness(admin), "Not contract admin");
        }
    }
}
