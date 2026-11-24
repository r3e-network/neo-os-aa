using System.Globalization;
using System.Numerics;
using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Testing;
using Neo.VM;
using Neo.VM.Types;

internal static class StoredIntegerCalls
{
    internal static List<object> Run(TestEngine test, Block block, UInt160 hash, int id)
    {
        List<object> rows = [];
        byte[] account = Enumerable.Range(1, 20).Select(x => (byte)x).ToArray();
        var max = (BigInteger.One << 255) - 1;
        BigInteger delay = 604800000;
        byte[]?[] inputs = [null, [], [1,0], [0,1], [0,128], [128,0], [255,255],
            new byte[32], max.ToByteArray(), (~max).ToByteArray(), (max-delay).ToByteArray(),
            (max-delay+1).ToByteArray(), new byte[33], Enumerable.Repeat((byte)255,33).ToArray()];
        foreach (var (name, prefix) in new[] { ("getMarketEscrowListingId",7), ("getAdminTransferAvailableAt",22),
                                              ("getPlatformRegistrarAvailableAt",25) })
        foreach (byte[]? payload in inputs)
        {
            byte[] keyBytes = prefix == 7 ? [(byte)prefix, ..account] : [(byte)prefix];
            var key = new StorageKey { Id = id, Key = keyBytes };
            var state = test.Storage.Snapshot.CloneCache();
            if (payload is null) state.Delete(key);
            else state.GetAndChange(key, () => new StorageItem()).Value = payload;
            using var script = new ScriptBuilder();
            script.EmitDynamicCall(hash, name, CallFlags.ReadOnly, prefix == 7 ? [account] : []);
            test.Transaction.Script = script.ToArray();
            using var app = ApplicationEngine.Create(TriggerType.Application, test.Transaction, state, block,
                test.ProtocolSettings, 100_00000000);
            app.LoadScript(new Script(test.Transaction.Script));
            var exit = app.Execute();
            string? value = null;
            if (exit == VMState.HALT)
            {
                if (app.ResultStack.Count != 1 || app.ResultStack.Peek() is not Integer n)
                    throw new InvalidDataException("not one returned Integer");
                value = n.GetInteger().ToString(CultureInfo.InvariantCulture);
            }
            if (app.Notifications.Count != 0 || (payload is null ? state.TryGet(key) is not null :
                !state.TryGet(key)!.Value.Span.SequenceEqual(payload))) throw new InvalidDataException("unexpected effects");
            rows.Add(new { name, input = payload is null ? null : Convert.ToHexStringLower(payload),
                state = exit.ToString(), value, error = app.FaultException?.GetBaseException().Message,
                pc = app.CurrentContext?.InstructionPointer });
        }
        return rows;
    }
}
