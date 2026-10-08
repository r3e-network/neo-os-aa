using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

// Test-only service ABI fixture. Installed into an in-memory public NeoVM at the
// private service hash; it is not the native service or recovery implementation.
[ContractPermission("*", "postExecute")]
public class NativeEpochCore : SmartContract
{
    [Safe]
    public static bool HasModuleContext(UInt160 account, string role, UInt160 module, string phase) => true;

    [Safe]
    public static object GetAuthorityEpoch(UInt160 account)
    {
        ByteString? value = Storage.Get(Storage.CurrentContext, (byte[])account);
        return value == null ? 0 : StdLib.Deserialize(value);
    }

    public static void SetEpoch(UInt160 account, object epoch) =>
        Storage.Put(Storage.CurrentContext, (byte[])account, StdLib.Serialize(epoch));

    [Safe]
    public static UInt160 GetAccountAddress(UInt160 account) => account;

    public static void SetVerifierDependencies(UInt160 account, UInt160[] children) { }
    public static void ClearVerifierDependencies(UInt160 account) { }

    public static object CallPostAndReturn(UInt160 root, UInt160 account, object[] operation, object result)
    {
        Contract.Call(root, "postExecute", CallFlags.All, new object[] { account, operation, result });
        return result;
    }

    public static void CallPostWithIterator(UInt160 root, UInt160 account, object[] operation)
    {
        object result = Storage.Find(Storage.CurrentContext, new byte[] { 0xff }, FindOptions.KeysOnly);
        Contract.Call(root, "postExecute", CallFlags.All, new object[] { account, operation, result });
    }
}
