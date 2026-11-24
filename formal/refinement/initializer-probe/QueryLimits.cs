using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Neo.VM;
using Neo.VM.Types;
using VmBoolean = Neo.VM.Types.Boolean;

internal static class QueryLimits
{
    internal static void Measure(byte[] bytes, byte[] manifest, int firstFree)
    {
        using var doc = JsonDocument.Parse(manifest);
        var methods = doc.RootElement.GetProperty("abi").GetProperty("methods").EnumerateArray().ToArray();
        int Offset(string name) => methods.Single(m => m.GetProperty("name").GetString() == name)
            .GetProperty("offset").GetInt32();
        var script = new Script(bytes, strictMode: true);
        int limit = (int)ExecutionEngineLimits.Default.MaxStackSize;
        var rows = new List<object>();
        foreach (var (name, args) in new (string, string?[])[] {
            ("getAccountImplementationId", [null]),
            ("supportsExecutionMode", ["single", "batch", "batch-atomic", "", null, "bytes:65536", "bytes:65537"]),
            ("supportsModuleType", ["validator", "verifier", "hook", "", null, "bytes:65536", "bytes:65537"]) })
        foreach (var arg in args)
        foreach (int free in Enumerable.Range(firstFree, 4))
        {
            using var vm = new Probe();
            var outer = vm.LoadScript(new Script(new byte[] { (byte)OpCode.RET }, strictMode: true));
            var method = vm.LoadScript(script, rvcount: 1, initialPosition: Offset(name));
            if (name != "getAccountImplementationId")
                vm.Push(arg switch {
                    null => StackItem.Null,
                    "bytes:65536" => (StackItem)new byte[65536],
                    "bytes:65537" => (StackItem)new byte[65537],
                    _ => (StackItem)Encoding.UTF8.GetBytes(arg) });
            int padding = limit - free - vm.ReferenceCounter.Count;
            for (int i = 0; i < padding; i++) outer.EvaluationStack.Push(StackItem.Null);
            var init = method.Clone(Offset("_initialize"));
            vm.Enter(init);
            int baseline = vm.ReferenceCounter.Count;
            if (baseline != limit - free) throw new InvalidDataException("invalid reference baseline");
            var points = new List<int[]>();
            while (vm.Failure is null && !ReferenceEquals(vm.CurrentContext, outer))
            {
                var ctx = vm.CurrentContext ?? throw new InvalidDataException("early termination");
                if (points.Count >= 200 || !(ReferenceEquals(ctx, method) || ReferenceEquals(ctx, init)))
                    throw new InvalidDataException("unexpected execution path");
                int ip = ctx.InstructionPointer;
                vm.Step();
                points.Add([ip, vm.ReferenceCounter.Count - baseline]);
            }
            string? result = null;
            if (vm.Failure is null)
            {
                if (outer.EvaluationStack.Count != padding + 1) throw new InvalidDataException("incorrect caller stack");
                result = outer.EvaluationStack.Peek() switch {
                    VmBoolean x => x.GetBoolean() ? "true" : "false",
                    ByteString x => Encoding.UTF8.GetString(x.GetSpan()),
                    _ => throw new InvalidDataException("unexpected result type") };
            }
            rows.Add(new {name, arg, free, points, result, error = vm.Failure?.Message});
        }
        static string Hash(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
        Console.WriteLine(JsonSerializer.Serialize(new { limit, scriptSha256=Hash(bytes), manifestSha256=Hash(manifest),
            vmSha256=Hash(File.ReadAllBytes(typeof(ExecutionEngine).Assembly.Location)), rows }));
    }
}
