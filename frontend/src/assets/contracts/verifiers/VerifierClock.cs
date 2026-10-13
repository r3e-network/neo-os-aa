using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount.Verifiers
{
    internal static class VerifierClock
    {
        internal static ulong Now()
        {
            if (Runtime.Trigger != TriggerType.Verification) return Runtime.Time;
            var block = Ledger.GetBlock(Ledger.CurrentHash);
            ExecutionEngine.Assert(block != null, "Missing persisted verification timestamp");
            return block!.Timestamp;
        }
    }
}
