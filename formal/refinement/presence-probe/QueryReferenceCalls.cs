using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Testing;
using Neo.VM;
using Neo.VM.Types;
using VmBoolean = Neo.VM.Types.Boolean;
using VmContext = Neo.VM.ExecutionContext;

internal static class QueryReferenceCalls
{
    private sealed class Trace(UInt160 target) : IDiagnostic
    {
        private ApplicationEngine engine = null!;
        internal readonly List<int[]> Before = [];
        internal int? Resumed { get; private set; }
        public void Initialized(ApplicationEngine app) => engine = app;
        public void Disposed() { }
        public void ContextLoaded(VmContext context) { }
        public void ContextUnloaded(VmContext context) { }
        public void CallFromNative(UInt160 hash, string method, StackItem[] args) { }
        public void PreExecuteInstruction(Instruction i)
        {
            if (engine.CurrentScriptHash == target)
                Before.Add([engine.CurrentContext!.InstructionPointer, engine.ReferenceCounter.Count]);
            else if (Before.Count != 0) Resumed ??= engine.ReferenceCounter.Count;
        }
        public void PostExecuteInstruction(Instruction i) { }
    }

    internal static List<object> Run(TestEngine test, Block block, UInt160 hash, int firstFree)
    {
        var rows = new List<object>();
        foreach (var (name, cases) in new (string, string?[])[] {
            ("getAccountImplementationId", [null]),
            ("supportsExecutionMode", ["single", "batch", "batch-atomic", "", null, "bytes:65536", "bytes:65537"]),
            ("supportsModuleType", ["validator", "verifier", "hook", "", null, "bytes:65536", "bytes:65537"]) })
        foreach (var arg in cases)
        foreach (int free in Enumerable.Range(firstFree, 4))
        {
            int arity = name == "getAccountImplementationId" ? 0 : 1;
            int pad = (int)ExecutionEngineLimits.Default.MaxStackSize - free - arity;
            using var driver = new ScriptBuilder();
            for (int i = 0; i < pad; i++) driver.Emit(OpCode.PUSHNULL);
            object? value = arg switch { "bytes:65536" => new byte[65536], "bytes:65537" => new byte[65537], _ => arg };
            driver.EmitDynamicCall(hash, name, CallFlags.None, arity == 0 ? [] : new object[] { value! });
            driver.Emit(OpCode.RET);
            test.Transaction.Script = driver.ToArray();
            var trace = new Trace(hash);
            using var app = ApplicationEngine.Create(TriggerType.Application, test.Transaction,
                test.Storage.Snapshot.CloneCache(), block, test.ProtocolSettings, 100_00000000, diagnostic: trace);
            app.LoadScript(new Script(test.Transaction.Script));
            var state = app.Execute();
            if (trace.Before.Count == 0 || trace.Before[0][1] != pad + arity)
                throw new InvalidDataException("target never started with the intended baseline");
            bool returned = state == VMState.HALT;
            if (returned != trace.Resumed.HasValue || returned && app.ResultStack.Count != pad+1)
                throw new InvalidDataException("unexpected continuation or return stack");
            string? result = returned ? app.ResultStack.Peek() switch {
                VmBoolean b => b.GetBoolean() ? "true" : "false",
                ByteString s => s.GetString(),
                _ => throw new InvalidDataException("incorrect result type") } : null;
            rows.Add(new { name, arg, free, before = trace.Before, terminalCount = trace.Resumed ?? app.ReferenceCounter.Count,
                result, error = app.FaultException?.GetBaseException().Message });
        }
        return rows;
    }
}
