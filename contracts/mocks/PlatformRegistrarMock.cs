using System.ComponentModel;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount.Contracts.Mocks
{
    [DisplayName("PlatformRegistrarMock")]
    [ContractPermission("*", "computePlatformAccountId")]
    [ContractPermission("*", "registerPlatformAccount")]
    [ContractPermission("*", "computeStablePlatformAccountId")]
    [ContractPermission("*", "registerStablePlatformAccount")]
    [ContractPermission("*", "rotatePlatformAccountOwner")]
    public class PlatformRegistrarMock : SmartContract
    {
        public static UInt160 Register(UInt160 core, ByteString appBinding, UInt160 backupOwner, uint escapeTimelock)
        {
            UInt160 accountId = (UInt160)Contract.Call(
                core,
                "computePlatformAccountId",
                CallFlags.ReadOnly,
                appBinding,
                backupOwner,
                escapeTimelock);
            Contract.Call(
                core,
                "registerPlatformAccount",
                CallFlags.All,
                accountId,
                appBinding,
                backupOwner,
                escapeTimelock);
            return accountId;
        }

        public static UInt160 RegisterStable(UInt160 core, ByteString appBinding, UInt160 backupOwner, uint escapeTimelock)
        {
            UInt160 accountId = (UInt160)Contract.Call(
                core,
                "computeStablePlatformAccountId",
                CallFlags.ReadOnly,
                appBinding,
                escapeTimelock);
            Contract.Call(
                core,
                "registerStablePlatformAccount",
                CallFlags.All,
                accountId,
                appBinding,
                backupOwner,
                escapeTimelock);
            return accountId;
        }

        public static void Rotate(UInt160 core, UInt160 accountId, ByteString appBinding, UInt160 newBackupOwner)
        {
            Contract.Call(
                core,
                "rotatePlatformAccountOwner",
                CallFlags.All,
                accountId,
                appBinding,
                newBackupOwner);
        }
    }
}
