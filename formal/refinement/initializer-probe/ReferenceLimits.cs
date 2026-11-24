using System.Security.Cryptography;
using System.Text.Json;
using Neo.VM;
using Neo.VM.Types;
using VmArray = Neo.VM.Types.Array;

internal static class ReferenceLimits
{
    internal static void Measure(byte[] bytes, byte[] manifest)
    {
        using var doc = JsonDocument.Parse(manifest);
        var methods = doc.RootElement.GetProperty("abi").GetProperty("methods").EnumerateArray().ToArray();
        int init = methods.Single(m => m.GetProperty("name").GetString() == "_initialize").GetProperty("offset").GetInt32();
        var script = new Script(bytes, strictMode: true);
        int limit = (int)ExecutionEngineLimits.Default.MaxStackSize;
        var rows = new List<object>();
        foreach (var m in methods.Where(m => !m.GetProperty("name").GetString()!.StartsWith('_')))
        {
            string name = m.GetProperty("name").GetString()!;
            int arity = m.GetProperty("parameters").GetArrayLength();
            foreach (int free in name == "getAccountImplementationId" ? Enumerable.Range(0, 70) : new[] { 67, 68 })
            {
                using var vm = new Probe();
                var outer = vm.LoadScript(script);
                var method = vm.LoadScript(script, initialPosition: m.GetProperty("offset").GetInt32());
                var arg = new VmArray(new StackItem[] { new Integer(7) });
                for (int i = 0; i < arity; i++) vm.Push(arg);
                int padding = limit - free - vm.ReferenceCounter.Count;
                for (int i = 0; i < padding; i++) outer.EvaluationStack.Push(StackItem.Null);
                var initializer = method.Clone(init);
                vm.Enter(initializer);
                int start = vm.ReferenceCounter.Count;
                if (limit - start != free) throw new InvalidDataException("Unexpected initial reference count");
                var deltas = new List<int>();
                int last = -1;
                while (ReferenceEquals(vm.CurrentContext, initializer) && !vm.State.HasFlag(VMState.FAULT))
                {
                    if (deltas.Count >= 170) throw new InvalidDataException("Initializer did not terminate");
                    last = initializer.InstructionPointer - init;
                    vm.Step();
                    deltas.Add(vm.ReferenceCounter.Count - start);
                }
                bool returned = vm.Failure == null && !vm.State.HasFlag(VMState.FAULT) && ReferenceEquals(vm.CurrentContext, method);
                rows.Add(new { name, arity, free, last, deltas, returned, error = vm.Failure?.Message });
            }
        }
        static string Hash(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
        Console.WriteLine(JsonSerializer.Serialize(new { limit, scriptSha256 = Hash(bytes), manifestSha256 = Hash(manifest),
            vmSha256 = Hash(File.ReadAllBytes(typeof(ExecutionEngine).Assembly.Location)), rows }));
    }
}
