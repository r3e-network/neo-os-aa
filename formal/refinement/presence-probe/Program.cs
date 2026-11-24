using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.SmartContract.Testing;
using Neo.VM;
using VmBoolean = Neo.VM.Types.Boolean;

bool checkDispatch = args.Length == 4 && args[3] == "--dispatch-refusals";
bool checkReturn = args.Length == 4 && args[3] == "--pure-returns";
bool checkMaxRate = args.Length == 4 && args[3] == "--pure-fees-max";
bool checkPico = checkMaxRate || args.Length == 4 && args[3] == "--pure-fees-pico";
bool checkFixed = args.Length == 4 && args[3] == "--pure-fees-fixed";
bool checkFees = checkFixed || checkPico || args.Length == 4 && args[3] == "--pure-fees";
bool checkIntegers = args.Length == 4 && args[3] == "--stored-integers";
bool checkReferences = args.Length == 4 && args[3] == "--query-references";
bool checkDepth = args.Length == 4 && args[3] == "--entry-depth";
bool checkRollback = args.Length == 4 && args[3] == "--block-rollback";
bool checkNested = args.Length == 4 && args[3] == "--nested-fees";
bool checkPure = checkReturn || checkFees || args.Length == 4 && args[3] == "--pure";
if (args.Length != 3 && !checkDispatch && !checkPure && !checkDepth && !checkRollback && !checkNested && !checkReferences && !checkIntegers) throw new ArgumentException("invalid probe mode or arguments");
if (args.Take(2).Any(p => Path.GetFullPath(p) == Path.GetFullPath(args[2])))
    throw new ArgumentException("receipt must not overwrite an input");
File.WriteAllText(args[2], "{\"status\":\"INCOMPLETE\",\"implementationVerified\":false}\n");
string engineHash = Hash(File.ReadAllBytes(typeof(ApplicationEngine).Assembly.Location));
string vmHash = Hash(File.ReadAllBytes(typeof(ExecutionEngine).Assembly.Location));
Check(engineHash == "cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a" &&
    vmHash == "cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9", "runtime drift");
byte[] nef = File.ReadAllBytes(args[0]), manifest = File.ReadAllBytes(args[1]);
bool mainQueries = (checkReferences || checkIntegers) && Hash(nef) == "c634ab9821c83bdb53b342d64359183cff2b917ac2dc5bdd9b57613494d09b4b";
Check(mainQueries || Hash(nef) == "083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a", "NEF drift");
Check(Hash(manifest) == (mainQueries ? "24c4710a8ac00a3df236d2a08509726dbe2745174abf833dd52e26d89b03b1b4" : "e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156"), "manifest drift");
var test = new TestEngine();
if (checkRollback)
{
    var result = BlockRollback.Run(test.ProtocolSettings, nef, Encoding.UTF8.GetString(manifest));
    File.WriteAllText(args[2], System.Text.Json.JsonSerializer.Serialize(new { status = "PASS_SAMPLED", implementationVerified = false,
        nefSha256 = Hash(nef), manifestSha256 = Hash(manifest), engineSha256 = engineHash, vmSha256 = vmHash, result },
        new JsonSerializerOptions { WriteIndented = true }));
    return;
}
test.SetTransactionSigners(new Signer { Account = test.ValidatorsAddress, Scopes = WitnessScope.Global });
var descriptor = Encoding.UTF8.GetString(manifest);
var hash = test.GetDeployHash(NefFile.Parse(nef), ContractManifest.Parse(descriptor));
var block = new Block { Header = new Header { Index = test.PersistingBlock.Index,
    Timestamp = (ulong)test.PersistingBlock.Timestamp.TotalMilliseconds,
    PrevHash = UInt256.Zero, MerkleRoot = UInt256.Zero, NextConsensus = test.ValidatorsAddress,
    Witness = new Witness { InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = ReadOnlyMemory<byte>.Empty } },
    Transactions = [] };
using (var deploy = new ScriptBuilder())
{
    deploy.EmitDynamicCall(NativeContract.ContractManagement.Hash, "deploy", nef, descriptor);
    test.Transaction.Script = deploy.ToArray();
    var setup = test.Storage.Snapshot.CloneCache();
    using var engine = ApplicationEngine.Create(TriggerType.Application, test.Transaction, setup, block,
        test.ProtocolSettings, 5000_00000000);
    engine.LoadScript(new Script(test.Transaction.Script));
    Check(engine.Execute() == VMState.HALT, $"deployment failed: {engine.FaultException}");
    setup.Commit();
}
int id = NativeContract.ContractManagement.GetContract(test.Storage.Snapshot, hash)!.Id;
if (checkIntegers)
{
    var rows = StoredIntegerCalls.Run(test, block, hash, id);
    File.WriteAllText(args[2], System.Text.Json.JsonSerializer.Serialize(new { status = "SAMPLED", implementationVerified = false,
        nefSha256 = Hash(nef), manifestSha256 = Hash(manifest), engineSha256 = engineHash, vmSha256 = vmHash, rows }));
    return;
}
if (checkReferences)
{
    var rows = QueryReferenceCalls.Run(test, block, hash, mainQueries ? 64 : 67);
    File.WriteAllText(args[2], System.Text.Json.JsonSerializer.Serialize(new { status = "PASS_SAMPLED", implementationVerified = false,
        nefSha256 = Hash(nef), manifestSha256 = Hash(manifest), engineSha256 = engineHash, vmSha256 = vmHash, rows }));
    return;
}
if (checkNested)
{
    var rows = NestedFees.Run(test, block, hash);
    File.WriteAllText(args[2], System.Text.Json.JsonSerializer.Serialize(new { status = "PASS_SAMPLED", implementationVerified = false,
        nefSha256 = Hash(nef), manifestSha256 = Hash(manifest), engineSha256 = engineHash, vmSha256 = vmHash, rows },
        new JsonSerializerOptions { WriteIndented = true }));
    return;
}
if (checkDepth)
{
    var rows = new List<object>();
    var abi = ContractManifest.Parse(descriptor).Abi;
    int initOffset = abi.GetMethod("_initialize", 0)!.Offset;
    foreach (var method in abi.Methods.Where(m => !m.Name.StartsWith('_')))
    foreach (int free in method.Name is "getAccountImplementationId" or "supportsExecutionMode" or "supportsModuleType"
        ? new[] { 0, 1, 2 } : new[] { 0, 1 })
    {
        string name = method.Name;
        object[] values = name switch { "supportsExecutionMode" => ["batch"], "supportsModuleType" => ["hook"],
            _ => Enumerable.Repeat<object>(0, method.Parameters.Length).ToArray() };
        int methodOffset = method.Offset;
        using var driver = new ScriptBuilder();
        driver.EmitDynamicCall(hash, name, CallFlags.None, values);
        driver.Emit(OpCode.RET);
        test.Transaction.Script = driver.ToArray();
        var trace = new StorageTrace(hash, checkDepth: true);
        using var app = ApplicationEngine.Create(TriggerType.Application, test.Transaction,
            test.Storage.Snapshot.CloneCache(), block, test.ProtocolSettings, 100_00000000, diagnostic: trace);
        int limit = (int)app.Limits.MaxInvocationStackSize;
        var inert = new Script(new byte[]{(byte)OpCode.RET});
        for (int i = 1; i < limit-free; i++) app.LoadScript(inert);
        app.LoadScript(new Script(test.Transaction.Script));
        Check(app.InvocationStack.Count == limit-free, "incorrect prepared depth");
        var state = app.Execute();
        string? error = app.FaultException?.GetBaseException().Message;
        int executed = trace.Points.Count(p => p.target);
        int[] expected = free == 0 ? [] : free == 1 ? [methodOffset] : [methodOffset, initOffset];
        Check(trace.Loads.SequenceEqual(expected) && app.Notifications.Count == 0, "unexpected target frame load");
        if (free < 2)
            Check(state == VMState.FAULT && error == $"MaxInvocationStackSize exceed: {limit}" && executed == 0,
                $"{name}/{free}: {state}: {error}");
        else
        {
            Check(state == VMState.HALT && executed > 170 && app.ResultStack.Count == 1, "target did not return");
            var v = app.ResultStack.Peek();
            Check(values.Length == 0 ? v is Neo.VM.Types.ByteString && v.GetString() == "org.r3e.neo.aa.unified-smart-wallet.v3"
                : v is VmBoolean && v.GetBoolean(), "wrong method result");
        }
        rows.Add(new { name, arity = values.Length, limit, free, loaded = trace.Loads, executed, state = state.ToString(), error });
    }
    File.WriteAllText(args[2], System.Text.Json.JsonSerializer.Serialize(new { status = "PASS_SAMPLED",
        implementationVerified = false, nefSha256 = Hash(nef), manifestSha256 = Hash(manifest),
        engineSha256 = engineHash, vmSha256 = vmHash, rows }, new JsonSerializerOptions { WriteIndented = true }));
    return;
}
if (checkPure)
{
    if (checkFixed)
    {
        test.SetTransactionSigners(new Signer { Account = test.CommitteeAddress, Scopes = WitnessScope.Global });
        using var policy = new ScriptBuilder();
        foreach (var (method, arity, flat) in new[] {
            ("getAccountImplementationId", 0, 0), ("supportsExecutionMode", 1, 12345), ("supportsModuleType", 1, 54321) })
            policy.EmitDynamicCall(NativeContract.Policy.Hash, "setWhitelistFeeContract", hash, method, arity, flat);
        test.Transaction.Script = policy.ToArray();
        var setup = test.Storage.Snapshot.CloneCache();
        using var engine = ApplicationEngine.Create(TriggerType.Application, test.Transaction, setup, block,
            test.ProtocolSettings, 5000_00000000);
        engine.LoadScript(new Script(test.Transaction.Script));
        Check(engine.Execute() == VMState.HALT, $"cannot configure fixed prices: {engine.FaultException}");
        setup.Commit();
        test.SetTransactionSigners(new Signer { Account = test.ValidatorsAddress, Scopes = WitnessScope.Global });
    }
    if (checkPico)
    {
        Check(test.ProtocolSettings.IsHardforkEnabled(Hardfork.HF_Faun, block.Index), "fractional policy rate requires Faun");
        var key = StorageKey.Create(NativeContract.Policy.Id, 18);
        test.Storage.Snapshot.GetAndChange(key)!.Set(checkMaxRate ? 1000000 : 300001);
    }
    var rows = new List<object>();
    void Query(string name, string label, object[] values, object? expected)
    {
        using var script = new ScriptBuilder();
        if (checkReturn)
        {
            script.EmitPush(731);
            script.Emit(OpCode.NEWARRAY0);
            script.Emit(OpCode.DUP);
        }
        script.EmitDynamicCall(hash, name, CallFlags.None, values);
        if (checkFees) script.Emit(OpCode.RET);
        int continuation = script.Length;
        if (checkReturn)
        {
            script.Emit(OpCode.NOP);
            script.Emit(OpCode.RET);
        }
        test.Transaction.Script = script.ToArray();
        var trace = new StorageTrace(hash, checkReturn);
        using var app = ApplicationEngine.Create(TriggerType.Application, test.Transaction,
            test.Storage.Snapshot.CloneCache(), block, test.ProtocolSettings, 100_00000000, diagnostic: trace);
        app.LoadScript(new Script(test.Transaction.Script));
        var state = app.Execute();
        var error = app.FaultException?.GetBaseException().Message;
        var last = trace.Points.Last(p => p.target);
        Check(app.Notifications.Count == 0, "unexpected notification");
        if (expected is null)
            Check(state == VMState.FAULT && last.opcode == (byte)OpCode.EQUAL &&
                last.pc == (name == "supportsExecutionMode" ? 17961 : 18015) &&
                error?.Contains("maximum comparable size, 65537/65536", StringComparison.Ordinal) == true,
                $"{name}/{label}: {state}/{error}");
        else
        {
            Check(state == VMState.HALT && last.opcode == (byte)OpCode.RET &&
                last.pc == (name == "supportsExecutionMode" ? 17999 : name == "supportsModuleType" ? 18048 : 17948) &&
                app.ResultStack.Count == (checkReturn ? 4 : 1), $"{name}/{label}: {state}/{error}");
            var value = app.ResultStack.Peek();
            Check(expected is bool b ? value is VmBoolean actual && actual.GetBoolean() == b :
                value is Neo.VM.Types.ByteString && value.GetString() == (string)expected, $"{name}/{label}: unexpected return");
        }
        if (checkFees)
        {
            using var compressed = new MemoryStream();
            using (var zip = new System.IO.Compression.GZipStream(compressed, System.IO.Compression.CompressionLevel.Optimal, true))
                zip.Write(test.Transaction.Script.Span);
            var samples = new List<object>();
            string Points(StorageTrace t) => Hash(Encoding.ASCII.GetBytes(string.Join(";", t.Points.Select(p =>
                FormattableString.Invariant($"{(p.target ? 1 : 0)},{p.pc},{p.opcode},{p.feeBefore}")))));
            foreach (long budget in new[] { app.FeeConsumed, app.FeeConsumed-1, 0L })
            {
                var observed = new StorageTrace(hash);
                using var limited = ApplicationEngine.Create(TriggerType.Application, test.Transaction,
                    test.Storage.Snapshot.CloneCache(), block, test.ProtocolSettings, budget, diagnostic: observed);
                limited.LoadScript(new Script(test.Transaction.Script));
                var actual = limited.Execute();
                var reason = limited.FaultException?.GetBaseException().Message;
                Check(limited.Notifications.Count == 0 &&
                    (budget == app.FeeConsumed ? actual == state && reason == error :
                     actual == VMState.FAULT && reason?.Contains("Insufficient GAS", StringComparison.Ordinal) == true),
                    $"{name}/{label}/{budget}: {actual}/{reason}");
                if (actual == VMState.HALT)
                    Check(limited.ResultStack.Count == 1 && limited.ResultStack.Peek().Equals(app.ResultStack.Peek()), "return differs at exact budget");
                samples.Add(new { budget, fee = limited.FeeConsumed, state = actual.ToString(), error = reason, trace = Points(observed) });
            }
            rows.Add(new { name, label, scriptGzip = Convert.ToBase64String(compressed.ToArray()), expected,
                fee = app.FeeConsumed, trace = Points(trace), state = state.ToString(), error, samples });
            return;
        }
        if (checkReturn)
        {
            Check(trace.Returns.Count == (expected is null ? 1 : 2) && trace.Returns[0].Shared &&
                trace.Returns[0].Count == values.Length && trace.Returns[0].Rv == 0,
                "initializer did not preserve its shared argument stack");
            bool resumed = trace.Points.Any(p => !p.target && p.pc == continuation && p.opcode == (byte)OpCode.NOP);
            Check(resumed == (expected is not null), "incorrect continuation after method exit");
            if (expected is not null)
                Check(!trace.Returns[1].Shared && trace.Returns[1].Rv == 1 && trace.Returns[1].Count == 1 &&
                    app.ResultStack.Peek(3).GetInteger() == 731 && app.ResultStack.Peek(1) is Neo.VM.Types.Array &&
                    ReferenceEquals(app.ResultStack.Peek(1), app.ResultStack.Peek(2)), "caller continuation changed");
        }
        if (checkReturn)
            rows.Add(new { name, label, expected, state = state.ToString(), error, last.pc, continuation,
                fee = app.FeeConsumed, returns = trace.Returns });
        else
            rows.Add(new { name, label, expected, state = state.ToString(), error, last.pc, fee = app.FeeConsumed });
    }
    Query("getAccountImplementationId", "no argument", [], "org.r3e.neo.aa.unified-smart-wallet.v3");
    foreach (var (name, words) in new[] { ("supportsExecutionMode", new[]{"single","batch","batch-atomic"}),
        ("supportsModuleType", new[]{"validator","verifier","hook"}) })
    {
        foreach (string word in words) Query(name, word, [word], true);
        Query(name, "empty", [""], false);
        Query(name, "unknown", ["other"], false);
        Query(name, "integer", [7], false);
        if (checkFees)
            foreach (int size in new[] { 255, 256, 65535 })
                Query(name, "bytes" + size, [new byte[size]], false);
        Query(name, "limit", [new byte[65536]], false);
        Query(name, "over limit", [new byte[65537]], null);
    }
    File.WriteAllText(args[2], System.Text.Json.JsonSerializer.Serialize(new { status = "PASS_SAMPLED", implementationVerified = false,
        nefSha256 = Hash(nef), manifestSha256 = Hash(manifest), engineSha256 = engineHash, vmSha256 = vmHash, rows },
        new JsonSerializerOptions { WriteIndented = true }));
    return;
}
if (checkDispatch)
{
    var abi = ContractManifest.Parse(descriptor).Abi.Methods;
    var rows = new List<object>();
    foreach (var group in abi.GroupBy(m => m.Name))
    {
        var listed = group.Select(m => m.Parameters.Length).Order().ToArray();
        var tested = new List<int>();
        foreach (int arity in Enumerable.Range(0, abi.Max(m => m.Parameters.Length) + 2))
        {
            bool reserved = group.Key.StartsWith('_');
            if (!reserved && listed.Contains(arity)) continue;
            var (state, error, instructions, notifications) = Observe(group.Key, Enumerable.Repeat<object>(0, arity).ToArray());
            string reason = reserved ? "cannot start with underscore" : $"with {arity} parameter(s) doesn't exist";
            Check(state == VMState.FAULT && error.Contains(reason, StringComparison.Ordinal) &&
                instructions == 0 && notifications == 0, $"{group.Key}/{arity}: {state}, {error}");
            tested.Add(arity);
        }
        rows.Add(new { name = group.Key, listed, rejected = tested });
    }
    var positive = Observe("isExecutionActive", [new byte[20]]);
    Check(positive.state == VMState.HALT && positive.instructions > 0, "positive control did not enter target");
    File.WriteAllText(args[2], System.Text.Json.JsonSerializer.Serialize(new { status = "PASS_SAMPLED", implementationVerified = false,
        nefSha256 = Hash(nef), manifestSha256 = Hash(manifest), engineSha256 = engineHash, vmSha256 = vmHash,
        methods = abi.Length, maxTestedArity = abi.Max(m => m.Parameters.Length) + 1,
        positiveControlInstructions = positive.instructions, rows }, new JsonSerializerOptions { WriteIndented = true }));
    return;

    (VMState state, string error, int instructions, int notifications) Observe(string name, object[] values)
    {
        using var script = new ScriptBuilder();
        script.EmitDynamicCall(hash, name, CallFlags.All, values);
        test.Transaction.Script = script.ToArray();
        var trace = new StorageTrace(hash);
        using var call = ApplicationEngine.Create(TriggerType.Application, test.Transaction,
            test.Storage.Snapshot.CloneCache(), block, test.ProtocolSettings, 100_00000000, diagnostic: trace);
        call.LoadScript(new Script(test.Transaction.Script));
        var state = call.Execute();
        return (state, call.FaultException?.GetBaseException().Message ?? "", trace.Points.Count(p => p.target), call.Notifications.Count);
    }
}
var observations = new List<object>();
var feeRuns = new List<object>();
var traces = new Dictionary<string, List<FeePoint>>();
var permissions = new List<object>();
int calls = 0;
foreach (var (method, prefix) in new (string, byte)[] { ("isExecutionActive", 11),
             ("hasPendingVerifierUpdate", 9), ("hasPendingHookUpdate", 10) })
{
    byte[] account = Enumerable.Range(1, 20).Select(i => (byte)i).ToArray();
    foreach (var (label, payload) in new (string, byte[]?)[] { ("missing", null), ("empty", []), ("nonempty", [0x80, 0]),
        ("backing", [0x20]), ("deleted", null) })
    {
        (long Fee, string? Error, StorageTrace Trace) Run(long budget, bool expectFault, CallFlags flags = CallFlags.ReadOnly)
        {
            calls++;
            using var script = new ScriptBuilder();
            script.EmitDynamicCall(hash, method, flags, account);
            script.Emit(OpCode.RET);
            test.Transaction.Script = script.ToArray();
            DataCache parent = test.Storage.Snapshot.CloneCache();
            var key = new StorageKey { Id = id, Key = new byte[] { prefix }.Concat(account).ToArray() };
            if (label is "backing" or "deleted") parent.Add(key, new StorageItem(new byte[] { 0x20 }));
            var snapshot = parent.CloneCache();
            if (label == "deleted") snapshot.Delete(key);
            else if (label != "backing" && payload is not null) snapshot.Add(key, new StorageItem(payload));
            snapshot.Add(new StorageKey { Id = id + 1, Key = key.Key }, new StorageItem(new byte[] { 3 }));
            snapshot.Add(new StorageKey { Id = id, Key = new byte[] { (byte)(prefix ^ 0x80) }.Concat(account).ToArray() }, new StorageItem(new byte[] { 1 }));
            snapshot.Add(new StorageKey { Id = id, Key = new byte[] { prefix }.Concat(account.Reverse()).ToArray() }, new StorageItem(new byte[] { 2 }));
            var trace = new StorageTrace(hash);
            using var app = ApplicationEngine.Create(TriggerType.Application, test.Transaction, snapshot,
                block, test.ProtocolSettings, budget, trace);
            Check(app.GetType() == typeof(ApplicationEngine), "non-production engine");
            app.LoadScript(new Script(test.Transaction.Script, strictMode: true));
            var state = app.Execute();
            Check(state == (expectFault ? VMState.FAULT : VMState.HALT), $"{method} {label}: {state} {app.FaultException}");
            if (!expectFault)
                Check(app.ResultStack.Count == 1 && app.ResultStack.Peek() is VmBoolean b && b.GetBoolean() == (payload is not null),
                    $"{method} {label}: wrong return type or value");
            Check(app.Notifications.Count == 0 && (payload is null ? snapshot.TryGet(key) is null :
                snapshot.TryGet(key)!.Value.Span.SequenceEqual(payload)), "unexpected effects");
            if (!expectFault)
                Check(trace.Starts.Count == 2 && trace.Starts[0] == ApplicationEngine.System_Storage_GetContext.Hash &&
                      trace.Starts[1] == ApplicationEngine.System_Storage_Get.Hash &&
                      trace.Charges.SequenceEqual(new long[] { 16 * 30, 32768 * 30 }), "unexpected syscall path/charge");
            var traceId = Hash(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(trace.Points));
            traces.TryAdd(traceId, trace.Points);
            feeRuns.Add(new { method, label, flags = (int)flags, budget,
                script = Convert.ToHexStringLower(test.Transaction.Script.Span), traceId,
                fee = app.FeeConsumed, state = state.ToString(), error = app.FaultException?.GetBaseException().Message });
            return (app.FeeConsumed, app.FaultException?.GetBaseException().Message, trace);
        }
        var funded = Run(100_00000000, false);
        long fee = funded.Fee;
        Check(Run(fee, false).Fee == fee, "exact budget mismatch");
        var shortfall = Run(fee - 1, true);
        Check(shortfall.Fee == fee && shortfall.Error?.Contains("GAS", StringComparison.OrdinalIgnoreCase) == true,
            $"unexpected fault: {shortfall.Error}");
        observations.Add(new { method, label, result = payload is not null, fee, shortfall.Error });
        if (label == "missing")
            foreach (long boundary in funded.Trace.Points.Select(p => p.feeBefore).Append(fee)
                .SelectMany(f => new[] { f, f - 1 }).Where(f => f >= 0).Distinct())
                Run(boundary, boundary < fee);
        if (label == "empty")
            for (int bits = 0; bits <= (int)CallFlags.All; bits++)
            {
                bool deny = (bits & (int)CallFlags.ReadStates) == 0;
                var r = Run(100_00000000, deny, (CallFlags)bits);
                if (deny)
                    Check(r.Trace.Starts.SequenceEqual(new[] { ApplicationEngine.System_Storage_GetContext.Hash }) &&
                          r.Trace.Charges.Count == 0 && r.Fee == r.Trace.StartFee &&
                          r.Error?.Contains("Cannot call this SYSCALL", StringComparison.Ordinal) == true, "unexpected rejection");
                permissions.Add(new { method, flags = bits, admitted = !deny, fee = r.Fee,
                    storageSyscallFees = r.Trace.Charges });
            }
    }
}
var receipt = new { status = "PASS_SAMPLED", implementationVerified = false, calls,
    nefSha256 = Hash(nef), manifestSha256 = Hash(manifest),
    engineSha256 = engineHash, vmSha256 = vmHash, observations, permissions, feeRuns, traces };
File.WriteAllText(args[2], System.Text.Json.JsonSerializer.Serialize(receipt, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static string Hash(byte[] b) => Convert.ToHexStringLower(SHA256.HashData(b));
static void Check(bool ok, string msg) { if (!ok) throw new InvalidOperationException(msg); }

sealed record FeePoint(bool target, int pc, int opcode, long feeBefore);
sealed record ReturnPoint(bool Shared, int Rv, int Count);
sealed class StorageTrace(UInt160 target, bool checkReturns = false, bool checkDepth = false) : IDiagnostic
{
    private ApplicationEngine engine = null!;
    public List<uint> Starts { get; } = [];
    public List<long> Charges { get; } = [];
    public List<FeePoint> Points { get; } = [];
    public List<ReturnPoint> Returns { get; } = [];
    public List<int> Loads { get; } = [];
    private Neo.VM.Types.StackItem[]? expectedReceiver;
    private Neo.VM.ExecutionContext? receiver;
    public long StartFee { get; private set; }
    private bool storage;
    public void Initialized(ApplicationEngine app) => engine = app;
    public void Disposed() { }
    public void ContextLoaded(Neo.VM.ExecutionContext context)
    {
        if (checkDepth && engine.CurrentScriptHash == target) Loads.Add(context.InstructionPointer);
    }
    public void ContextUnloaded(Neo.VM.ExecutionContext context)
    {
        if (receiver is null) return;
        if (!ReferenceEquals(receiver, engine.CurrentContext) || receiver.EvaluationStack.Count != expectedReceiver!.Length ||
            expectedReceiver.Where((v, i) => !ReferenceEquals(v, receiver.EvaluationStack.Peek(i))).Any())
            throw new InvalidOperationException("RET changed the caller stack or item identity");
        expectedReceiver = null;
        receiver = null;
    }
    public void CallFromNative(UInt160 hash, string method, Neo.VM.Types.StackItem[] args) { }
    public void PreExecuteInstruction(Instruction i)
    {
        bool inTarget = engine.CurrentScriptHash == target;
        if (checkReturns && inTarget && i.OpCode == OpCode.RET)
        {
            var frame = engine.CurrentContext!;
            receiver = engine.InvocationStack.ElementAt(1);
            var src = frame.EvaluationStack;
            var dst = receiver.EvaluationStack;
            bool shared = ReferenceEquals(src, dst);
            Returns.Add(new(shared, frame.RVCount, src.Count));
            var original = Enumerable.Range(0, dst.Count).Select(j => dst.Peek(j));
            expectedReceiver = (shared ? original : Enumerable.Range(0, src.Count).Select(j => src.Peek(j)).Concat(original)).ToArray();
        }
        Points.Add(new(inTarget, engine.CurrentContext!.InstructionPointer, (byte)i.OpCode, engine.FeeConsumed));
        storage = i.OpCode == OpCode.SYSCALL && inTarget;
        if (!storage) return;
        Starts.Add(i.TokenU32);
        StartFee = engine.FeeConsumed;
    }
    public void PostExecuteInstruction(Instruction i)
    {
        if (storage) Charges.Add(engine.FeeConsumed - StartFee);
    }
}
