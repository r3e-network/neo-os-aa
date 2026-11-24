using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

// Test-only protocol v4 SmartAccount core ABI fixture. Installed into an in-memory public
// NeoVM at the pinned native SmartAccount hash (0x398dc3f0...); it is not the SmartAccount
// native contract and proves nothing about native recovery or chain admission.
//
// v4 modules authenticate every callback the same way: they assert
// `Runtime.CallingScriptHash` is the configured core and ask the core
// `getAuthorizedModuleId(accountId, phase)` which of their instances the writer phase
// addresses (docs/SA-MODULE-PROTOCOL.md §9). Threshold members additionally read the
// instance record (`getModule`) for the credential generation, and native builds read
// `getAccountAddress`. This fixture answers exactly those three calls and forwards
// callbacks so the module observes the core as caller.
[ContractPermission("*", "*")]
public class NativeEpochCore : SmartContract
{
    // Test-only bookkeeping, unrelated to the protocol key tables.
    private static readonly byte[] Prefix_AuthorizedInstance = new byte[] { 0x01 };
    private static readonly byte[] Prefix_Generation = new byte[] { 0x02 };

    private static byte[] PhaseKey(UInt160 accountId, int phase) =>
        Helper.Concat(Helper.Concat(Prefix_AuthorizedInstance, (byte[])accountId), new byte[] { (byte)phase });

    private static byte[] GenerationKey(UInt160 accountId, BigInteger moduleId) =>
        Helper.Concat(Helper.Concat(Prefix_Generation, (byte[])accountId), U64BE(moduleId));

    [Safe]
    public static BigInteger GetAuthorizedModuleId(UInt160 accountId, int phase)
    {
        ByteString? value = Storage.Get(Storage.CurrentContext, PhaseKey(accountId, phase));
        if (value == null || value.Length != 8) return 0;
        BigInteger moduleId = 0;
        for (int i = 0; i < 8; i++) moduleId = (moduleId << 8) | value[i];
        return moduleId;
    }

    public static void SetAuthorizedModuleId(UInt160 accountId, int phase, int moduleId) =>
        Storage.Put(Storage.CurrentContext, PhaseKey(accountId, phase), U64BE(moduleId));

    /// <summary>
    /// The nine-field instance record a threshold member reads. Only index 8 (credential
    /// generation) is exercised by the probe; the rest are placeholders.
    /// </summary>
    [Safe]
    public static object[] GetModule(UInt160 accountId, BigInteger moduleId)
    {
        ByteString? data = Storage.Get(Storage.CurrentContext, GenerationKey(accountId, moduleId));
        BigInteger generation = 0;
        if (data != null && data.Length == 8)
            for (int i = 0; i < 8; i++) generation = (generation << 8) | data[i];
        return new object[] { moduleId, accountId, 0, 0, 0, 0, 0, 0, generation };
    }

    public static void SetModuleGeneration(UInt160 accountId, BigInteger moduleId, BigInteger generation) =>
        Storage.Put(Storage.CurrentContext, GenerationKey(accountId, moduleId), U64BE(generation));

    [Safe]
    public static object[] GetModules(UInt160 accountId, string moduleType, BigInteger cursor, BigInteger limit)
    {
        ExecutionEngine.Assert(moduleType == "hook" && cursor == 0 && limit == 8);
        return new object[] { new object[] { 2, 5 }, 0, 0 };
    }

    [Safe]
    public static UInt160 GetAccountAddress(UInt160 accountId) => accountId;

    /// <summary>
    /// Calls a module callback with the core as caller. The host drives every module call
    /// through here, so `Runtime.CallingScriptHash == core` holds and the module's own
    /// caller check is what the cases below actually exercise.
    /// </summary>
    public static object Forward(UInt160 module, string method, object[] args) =>
        Contract.Call(module, method, CallFlags.All, args);

    private static byte[] U64BE(BigInteger value)
    {
        byte[] encoded = new byte[8];
        for (int i = 7; i >= 0; i--)
        {
            encoded[i] = (byte)(value & 255);
            value >>= 8;
        }
        return encoded;
    }
}
