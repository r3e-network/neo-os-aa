using System.Buffers.Binary;
using Neo;
using Neo.SmartContract;
using Neo.VM;
using Neo.VM.Types;
using Context = Neo.VM.ExecutionContext;

internal sealed class NefTrace : IDiagnostic
{
    private readonly UInt160 hash;
    private readonly HashSet<int> instructions = [];
    private readonly HashSet<(int From, int To)> possibleEdges = [];
    private ApplicationEngine engine = null!;
    private (Context Context, int Offset)? pending;
    private bool completed;
    internal HashSet<int> Visited { get; } = [];
    internal HashSet<(int From, int To)> Edges { get; } = [];
    internal Action<ApplicationEngine, UInt160, string, StackItem[]>? NativeCall { get; set; }
    internal int InstructionCount => instructions.Count;
    internal int EdgeCount => possibleEdges.Count;

    internal NefTrace(UInt160 hash, ReadOnlyMemory<byte> bytes)
    {
        this.hash = hash;
        Script script = new(bytes);
        for (int offset = 0; offset < bytes.Length;)
        {
            Instruction instruction = script.GetInstruction(offset);
            instructions.Add(offset);
            if (IsConditional(instruction.OpCode))
            {
                int delta = instruction.Operand.Length == 1
                    ? unchecked((sbyte)instruction.Operand.Span[0])
                    : BinaryPrimitives.ReadInt32LittleEndian(instruction.Operand.Span);
                possibleEdges.Add((offset, offset + instruction.Size));
                possibleEdges.Add((offset, offset + delta));
            }
            offset += instruction.Size;
            ProbeTests.Require(offset <= bytes.Length, "Truncated bytecode cannot be a coverage denominator.");
        }
        ProbeTests.Require(possibleEdges.All(edge => instructions.Contains(edge.To)), "Conditional target must be an instruction boundary.");
    }

    private static bool IsConditional(OpCode opcode) => opcode is >= OpCode.JMPIF and <= OpCode.JMPLE_L;

    public void Initialized(ApplicationEngine value) { engine = value; pending = null; completed = false; }
    public void Disposed() { pending = null; }
    public void ContextLoaded(Context context) { }
    public void ContextUnloaded(Context context) { }
    public void CallFromNative(UInt160 target, string method, StackItem[] args) => NativeCall?.Invoke(engine, target, method, args);

    public void PreExecuteInstruction(Instruction instruction)
    {
        // The VM advances a fall-through instruction pointer after its post hook.
        // Observe the successor at the next pre hook, only if the branch completed.
        if (pending is { } branch && completed)
        {
            var edge = (branch.Offset, branch.Context.InstructionPointer);
            ProbeTests.Require(possibleEdges.Contains(edge), "Observed branch edge is not decoded from this NEF.");
            Edges.Add(edge);
        }
        pending = null;
        completed = false;
        if (engine.CurrentScriptHash != hash) return;
        Context context = engine.CurrentContext!;
        ProbeTests.Require(instructions.Contains(context.InstructionPointer), "Unrecognized instruction offset.");
        Visited.Add(context.InstructionPointer);
        if (IsConditional(instruction.OpCode)) pending = (context, context.InstructionPointer);
    }

    public void PostExecuteInstruction(Instruction instruction)
    {
        completed = pending is not null;
    }

    internal object Report() => new
    {
        denominator = "Entire unchanged NEF script, including administration and defensive paths",
        instructionCount = InstructionCount,
        attemptedInstructions = Visited.Count,
        instructionPercent = Math.Round(100.0 * Visited.Count / InstructionCount, 2),
        conditionalEdges = EdgeCount,
        completedConditionalEdges = Edges.Count,
        conditionalEdgePercent = EdgeCount == 0 ? 100 : Math.Round(100.0 * Edges.Count / EdgeCount, 2),
        missingInstructionOffsets = instructions.Except(Visited).Order().ToArray(),
        missingConditionalEdges = possibleEdges.Except(Edges).Order().Select(edge => new { from = edge.From, to = edge.To }).ToArray(),
        sourceLineCoverageMeasured = false,
        fullRefinementProven = false
    };
}
