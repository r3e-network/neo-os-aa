// One single-stepped ApplicationEngine run, observed.
//
// Two modes ask the engine questions: `abi-dispatch` (what does each ABI name
// resolve to, with arity-matched zero arguments) and `abi-scenario` (what does
// a sequence of calls with real arguments and established state do). Both need
// the same facts about a run — which offsets executed, in which script, which
// syscalls were reached, how the run ended, what was left on the stack — and
// two copies of that loop would be two different answers to the same question.
// So the loop lives here, once.
//
// What a run is not: a proof about the contract. `state` is a VM state, `fault`
// is a message, the executed set is an empirical footprint on one engine
// version. Nothing here judges whether any of it is correct.
using System.Security.Cryptography;
using Neo;
using Neo.SmartContract;
using Neo.VM;

internal sealed class VmObservation
{
    /// <summary>First instruction pointer seen at each invocation-stack depth.</summary>
    public SortedDictionary<int, int> FirstIps { get; } = new();

    /// <summary>Script hash that named each depth. A native call pushes its own.</summary>
    public SortedDictionary<int, string> FirstScripts { get; } = new();

    /// <summary>Every offset executed inside the observed contract, sorted.</summary>
    public List<int> ExecutedInContract { get; } = new();

    /// <summary>Count of offsets executed in frames belonging to other scripts.</summary>
    public int ExecutedForeign;

    public List<string> Syscalls { get; } = new();
    public bool SyscallsTruncated;
    public int Steps;
    public bool StepLimitReached;
    public string State = "";
    public string? Fault;

    /// <summary>
    /// The fault's own first lines. `Fault` is the message the VM reports, which
    /// for a wrapped host exception is the wrapper's text and nothing else; the
    /// type and the inner frames are what say where it came from.
    /// </summary>
    public string? FaultDetail;

    /// <summary>What the call left on the result stack, recorded and never judged.</summary>
    public Dictionary<string, object?> Result { get; } = new();
}

internal static class VmRun
{
    private const int SyscallLimit = 256;

    private static string Sha(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>
    /// Single-step until the engine halts, faults, or runs out of budget.
    ///
    /// Membership is decided by the running script's hash, not by the stack
    /// depth. A native contract call pushes its own context too, and its
    /// instruction pointers are numbered from zero in a different script, so a
    /// depth-only rule could credit this contract with an offset it never ran.
    /// </summary>
    public static VmObservation Step(ApplicationEngine engine, UInt160 contract, int stepLimit)
    {
        var observation = new VmObservation();
        var executed = new HashSet<int>();
        var foreign = new HashSet<int>();
        var debugger = new Debugger(engine);
        int steps = 0;
        while (engine.State != VMState.HALT && engine.State != VMState.FAULT && steps < stepLimit)
        {
            var context = engine.CurrentContext;
            if (context is not null)
            {
                int depth = engine.InvocationStack.Count;
                var scriptHash = engine.CurrentScriptHash;
                if (!observation.FirstIps.ContainsKey(depth)) observation.FirstIps[depth] = context.InstructionPointer;
                if (!observation.FirstScripts.ContainsKey(depth)) observation.FirstScripts[depth] = scriptHash?.ToString() ?? "null";
                if (scriptHash == contract) executed.Add(context.InstructionPointer);
                else foreign.Add(context.InstructionPointer);
                var instruction = context.CurrentInstruction;
                if (instruction is not null && instruction.OpCode == OpCode.SYSCALL)
                {
                    if (observation.Syscalls.Count < SyscallLimit)
                        observation.Syscalls.Add(ApplicationEngine.GetInteropDescriptor(instruction.TokenU32)?.Name
                                                 ?? "0x" + instruction.TokenU32.ToString("x8"));
                    else
                        observation.SyscallsTruncated = true;
                }
            }
            debugger.StepInto();
            steps++;
        }

        observation.Steps = steps;
        observation.StepLimitReached = steps >= stepLimit;
        observation.State = engine.State.ToString();
        observation.Fault = engine.FaultException?.Message.Split('\n')[0];
        observation.FaultDetail = engine.FaultException is null
            ? null
            : string.Join(" | ", engine.FaultException.ToString().Split('\n')
                .Select(line => line.Trim()).Where(line => line.Length > 0).Take(6));
        observation.ExecutedInContract.AddRange(executed.OrderBy(offset => offset));
        observation.ExecutedForeign = foreign.Count;

        // What the call left behind. A dispatch that lands on the right offset and
        // hands back the wrong shape is a manifest the artifact does not honour,
        // and no question about offsets can see it. The value is recorded, never
        // judged here: the shape rules live in the Python faces, where they can be
        // read and mutated without recompiling.
        var results = engine.ResultStack;
        observation.Result["count"] = results.Count;
        if (results.Count > 0)
        {
            var item = results.Peek();
            observation.Result["type"] = item.Type.ToString();
            try
            {
                if (item is Neo.VM.Types.CompoundType compound)
                {
                    observation.Result["items"] = compound.Count;
                    // Item types only: enough to state what the call answered with,
                    // and short enough that a batch result cannot bloat the dump.
                    var types = new List<string>();
                    if (compound is Neo.VM.Types.Array array)
                        foreach (var child in array)
                            if (types.Count < 32) types.Add(child.Type.ToString());
                    observation.Result["itemTypes"] = types;
                }
                else
                {
                    var raw = item.GetSpan().ToArray();
                    observation.Result["bytes"] = raw.Length;
                    observation.Result["sha256"] = Sha(raw);
                    // Bounded content, so a consumer can compare a short value it
                    // declares without the dump becoming a transcript of state.
                    if (raw.Length <= 128)
                        observation.Result["hex"] = Convert.ToHexString(raw).ToLowerInvariant();
                }
                if (item.Type == Neo.VM.Types.StackItemType.Integer)
                    observation.Result["integer"] = item.GetInteger().ToString();
            }
            catch (Exception error)
            {
                // An interop interface has no byte representation. Recording the
                // refusal is honest; inventing a value would not be.
                observation.Result["error"] = error.GetType().Name + ": " + error.Message.Split('\n')[0];
            }
        }
        return observation;
    }
}
