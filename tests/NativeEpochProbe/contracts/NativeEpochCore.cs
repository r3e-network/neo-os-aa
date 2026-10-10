using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

// Test-only service ABI fixture. Installed into an in-memory public NeoVM at the
// private service hash; it is not the native service or recovery implementation.
[ContractPermission("*", "validateCompositeSignature", "postExecuteComposite")]
public class NativeEpochCore : SmartContract
{
    [Safe]
    public static bool HasModuleContext(UInt160 account, string role, UInt160 module, string phase) => true;

    // This deliberately narrow epoch fixture receives only known compressed keys.
    // The production native helper's full 33/65 normalization is covered separately
    // by core NeoVM tests and the real native module probe.
    [Safe]
    public static ByteString CanonicalP256PublicKey(ByteString publicKey)
    {
        ExecutionEngine.Assert(publicKey.Length == 33 && (publicKey[0] == 2 || publicKey[0] == 3),
            "Epoch fixture requires a canonical compressed P-256 key");
        ExecutionEngine.Assert(Contract.CreateStandardAccount((ECPoint)publicKey).IsValid);
        return publicKey;
    }

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
        object[] receipt = (object[])Contract.Call(root, "validateCompositeSignature", CallFlags.ReadOnly, new object[] { account, operation });
        Contract.Call(root, "postExecuteComposite", CallFlags.All, new object[] { account, operation, result, receipt });
        return result;
    }

    public static void CallPostWithIterator(UInt160 root, UInt160 account, object[] operation)
    {
        object result = Storage.Find(Storage.CurrentContext, new byte[] { 0xff }, FindOptions.KeysOnly);
        object[] receipt = (object[])Contract.Call(root, "validateCompositeSignature", CallFlags.ReadOnly, new object[] { account, operation });
        Contract.Call(root, "postExecuteComposite", CallFlags.All, new object[] { account, operation, result, receipt });
    }

    public static object CallPostProbe(UInt160 root, UInt160 account, object[] operation, object result, bool iterator)
    {
        // A write before the callback lets the public VM host independently
        // check transaction rollback when result serialization rejects a graph.
        Storage.Put(Storage.CurrentContext, new byte[] { 0xfe }, 1);
        if (iterator) result = Storage.Find(Storage.CurrentContext, new byte[] { 0xff }, FindOptions.KeysOnly);
        object[] receipt = (object[])Contract.Call(root, "validateCompositeSignature", CallFlags.ReadOnly, new object[] { account, operation });
        Contract.Call(root, "postExecuteComposite", CallFlags.All, new object[] { account, operation, result, receipt });
        return result;
    }
}
