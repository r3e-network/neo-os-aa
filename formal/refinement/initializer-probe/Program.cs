using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Neo.VM;
using Neo.VM.Types;
using VmArray = Neo.VM.Types.Array;
using VmBuffer = Neo.VM.Types.Buffer;

if (args is ["--query-limits", var queryScript, var queryManifest, var minFree])
{
    QueryLimits.Measure(File.ReadAllBytes(queryScript), File.ReadAllBytes(queryManifest), int.Parse(minFree));
    return;
}
if (args is ["--reference-limits", var rawScript, var rawManifest])
{
    ReferenceLimits.Measure(File.ReadAllBytes(rawScript), File.ReadAllBytes(rawManifest));
    return;
}
if (args.Length != 3) throw new ArgumentException("expected raw script, manifest and expected slots");
var bytes = File.ReadAllBytes(args[0]);
var manifest = File.ReadAllBytes(args[1]);
var methods = JsonDocument.Parse(manifest).RootElement.GetProperty("abi").GetProperty("methods").EnumerateArray().ToArray();
var slots = JsonDocument.Parse(File.ReadAllBytes(args[2])).RootElement.EnumerateArray().ToArray();
var script = new Script(bytes, strictMode: true);
var init = methods.Single(m => m.GetProperty("name").GetString() == "_initialize").GetProperty("offset").GetInt32();
int checkedMethods = 0;
foreach (var m in methods.Where(m => !m.GetProperty("name").GetString()!.StartsWith('_')))
{
    int offset = m.GetProperty("offset").GetInt32();
    using var engine = new Probe();
    var caller = engine.LoadScript(script, rvcount: m.GetProperty("returntype").GetString() == "Void" ? 0 : 1,
        initialPosition: offset);
    var arguments = Enumerable.Range(0, m.GetProperty("parameters").GetArrayLength())
        .Select(i => new VmArray(new StackItem[] { new Integer(i) })).ToArray();
    foreach (var arg in arguments.Reverse()) engine.Push(arg);
    var initializer = caller.Clone(init);
    engine.Enter(initializer);
    int steps = 0;
    while (ReferenceEquals(engine.CurrentContext, initializer))
    {
        Require(steps < 170 && !engine.State.HasFlag(VMState.FAULT), "initializer fault or step limit");
        engine.Step();
        steps++;
    }
    Require(steps == 170 && !engine.State.HasFlag(VMState.FAULT) && engine.InvocationStack.Count == 1
        && ReferenceEquals(engine.CurrentContext, caller) && caller.InstructionPointer == offset, "return context");
    Require(caller.EvaluationStack.Count == arguments.Length && arguments.Select((v,i) =>
        ReferenceEquals(caller.EvaluationStack.Peek(i), v) && v[0].GetInteger() == i).All(x => x), "arguments");
    var fields = caller.StaticFields;
    Require(fields is not null && ReferenceEquals(fields, initializer.StaticFields) && fields.Count == slots.Length,
        "shared static slots");
    for (int i = 0; i < slots.Length; i++)
    {
        var value = slots[i].GetProperty("value");
        var actual = fields![i];
        Require(slots[i].GetProperty("kind").GetString() switch
        {
            "Integer" => actual is Integer integer && integer.GetInteger() == value.GetInt64(),
            "ByteArray" => actual is VmBuffer b && b.GetSpan().SequenceEqual(value.EnumerateArray().Select(x => x.GetByte()).ToArray()),
            "Array" => actual is VmArray a && a.Count == value.GetArrayLength() && value.EnumerateArray()
                .Select((x,j) => a[j] is ByteString s && s.GetSpan().SequenceEqual(Encoding.UTF8.GetBytes(x.GetString()!))).All(x => x),
            _ => false
        }, $"slot {i}: {slots[i].GetProperty("field")}");
    }
    checkedMethods++;
}
Require(methods.Length == 100 && checkedMethods == 98 && slots.Length == 53, "unexpected artifact shape");
Console.WriteLine(JsonSerializer.Serialize(new { checkedMethods, slotsPerMethod = slots.Length, stepsPerMethod = 170,
    vmAssembly = typeof(ExecutionEngine).Assembly.FullName,
    vmAssemblySha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(typeof(ExecutionEngine).Assembly.Location))),
    scriptSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
    manifestSha256 = Convert.ToHexStringLower(SHA256.HashData(manifest)) }));

static void Require(bool ok, string message)
{
    if (!ok) throw new InvalidOperationException(message);
}

sealed class Probe : ExecutionEngine
{
    public void Enter(Neo.VM.ExecutionContext context) => LoadContext(context);
    public Exception? Failure { get; private set; }
    protected override void OnFault(Exception ex) { Failure = ex; base.OnFault(ex); }
    public void Step() => ExecuteNext();
}
