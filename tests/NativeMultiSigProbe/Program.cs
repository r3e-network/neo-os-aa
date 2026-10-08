using System.Collections.Immutable;
using System.Numerics;
using System.Text.Json;
using Neo;
using Neo.Cryptography;
using Neo.Extensions;
using Neo.IO;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.Persistence.Providers;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;
using Neo.Wallets;
using A = Neo.VM.Types.Array;
using Ctx = Neo.VM.ExecutionContext;

if (args.Length < 1 || args.Length > 2) throw new ArgumentException("Pass the exact native module artifact directory.");
var artifacts = Path.GetFullPath(args[0]);
bool diagnose = args.Length == 2 && args[1] == "--diagnose";
bool allPassed = true;
var rows = new List<object>();
object? pricing = null;
// Execute wrong result shapes in the actual VM before trusting HALT as approval.
using (var control = new Harness())
{
    Require(control.VerifyResultControl([(byte)OpCode.PUSHT]), "Boolean true verification control failed.");
    foreach (byte[] script in new byte[][] { [], [(byte)OpCode.PUSHF], [(byte)OpCode.PUSHT, (byte)OpCode.PUSHT], [(byte)OpCode.PUSH1], [(byte)OpCode.PUSHNULL] })
        Require(!control.VerifyResultControl(script), "Verification result guard accepted false, empty, multiple or non-Boolean results.");
}
var scenarios = new (string Roster, string Slots, bool Maximum, bool BadSignature, bool Malformed)[] {
    ("SN", "11", false, false, false), ("SN", "11", true, false, false),
    ("SS", "11", false, false, false), ("SS", "11", true, false, false),
    ("SSN", "110", false, false, false), ("SSN", "101", false, false, false), ("SSN", "011", false, false, false),
    ("SSN", "111", false, false, false), ("SSN", "111", false, true, false),
    ("SSN", "111", true, false, false), ("SSN", "110", true, false, false), ("SSN", "101", true, false, false), ("SSN", "011", true, false, false),
    ("SSS", "111", true, true, false), ("SSS", "111", true, false, false), ("SSS", "110", true, false, false),
    ("SSN", "100", false, false, false), ("SSN", "111", false, false, true)
};
foreach (var scenario in scenarios)
{
    using var h = new Harness();
    pricing ??= h.Pricing;
    if (scenario.Maximum) h.Time = ulong.MaxValue - 25 * Harness.Delay;
    bool longMethod = scenario.Roster == "SSS" && scenario.Slots == "110";
    string method = longMethod ? new string('m', 128) : "transfer";
    bool growSpent = scenario.Roster == "SSN" && scenario.Maximum && scenario.Slots == "111";
    var children = scenario.Roster.Select((kind, index) => h.Deploy(artifacts, kind == 'S' ? "SessionKeyVerifier" : "NeoNativeVerifier", new UInt160(Enumerable.Repeat((byte)(index + 11), 20).ToArray()))).ToArray();
    var root = h.Deploy(artifacts, "MultiSigVerifier", Harness.Owner);
    var token = h.Token(method);
    UInt160 account = new(h.Call(Harness.Core, "registerAccount", [Harness.Owner, new byte[32], root, UInt160.Zero, UInt160.Zero]).GetSpan());
    UInt160 proxy = new(h.Call(Harness.Core, "getAccountAddress", [account]).GetSpan());
    KeyPair Key(byte marker) { var raw = new byte[32]; raw[^1] = marker; return new(raw); }
    var keys = Enumerable.Range(1, children.Length).Select(i => Key((byte)i)).ToArray();
    BigInteger maximumInteger = (BigInteger.One << 255) - 1;
    BigInteger amount = scenario.Maximum ? maximumInteger - (growSpent ? 1 : 0) : 1_000_000;
    BigInteger cap = longMethod ? 0 : scenario.Maximum ? maximumInteger : amount * 2 - 1;
    for (int i = 0; i < children.Length; i++)
    {
        if (scenario.Roster[i] == 'S') h.Configure(account, children[i], "setSessionKey", [keys[i].PublicKey.EncodePoint(true), token, method, new BigInteger(h.Time + 20 * Harness.Delay), cap, new string('x', scenario.Maximum ? 128 : 16)]);
        else h.Configure(account, children[i], "setConfig", [new object[] { Harness.Other }, 1]);
    }
    h.Configure(account, null, "setConfig", [children.Cast<object>().ToArray(), 2]);
    if (growSpent) for (int i = 0; i < children.Length; i++) if (scenario.Roster[i] == 'S') h.SetModuleValue(children[i], account, 3, [1]);
    var domains = (A)h.Call(children[0], "getSignerDomains", [account]);
    string domainHex = Convert.ToHexString(domains[0].GetSpan()).ToLowerInvariant();
    Require(domains.Count == 1 && domainHex == "95f9b24ea3b055e8bd3bce0bf24c6ec31b68689ad320de2adef18b0719f6f528", "Native P256 canonical domain differs from the independent generator-key vector.");
    var state = (A)h.Call(Harness.Core, "getAccount", [account]);
    // Pack maximum positive amount, description and argument bytes together. The
    // data field uses the remaining canonical 4096-byte argument allowance.
    int dataLength = 0;
    bool deep = scenario.Roster == "SSS" && scenario.Maximum && !scenario.BadSignature;
    object?[] TransferArgs(int length)
    {
        object? data = scenario.Maximum ? new byte[length] : null;
        if (deep) for (int depth = 0; depth < 7; depth++) data = new object?[] { data };
        return [proxy, Harness.Other, amount, data];
    }
    if (scenario.Maximum)
    {
        while (BinarySerializer.Serialize(Stack(TransferArgs(dataLength + 1)), 8192, 8192).Length <= 4096) dataLength++;
        Require(BinarySerializer.Serialize(Stack(TransferArgs(dataLength)), 8192, 8192).Length == 4096, "Boundary arguments are not exactly 4096 bytes.");
    }
    BigInteger nonce = scenario.Maximum ? ((BigInteger.One << 191) - 1) << 64 : BigInteger.Zero;
    object?[] unsignedOp = [token, method, TransferArgs(dataLength), nonce, new BigInteger(h.Time + Harness.Delay), System.Array.Empty<byte>()];
    byte[] domain = h.Call(Harness.Core, "getAuthorizationDomain", [account]).GetSpan().ToArray();
    byte[] preimage = [.. domain, .. BinarySerializer.Serialize(Stack(unsignedOp), 8192, 8192)];
    byte[] digest = h.Call(Harness.Core, "getOperationDigest", [account, unsignedOp]).GetSpan().ToArray();
    Require(System.Security.Cryptography.SHA256.HashData(preimage).SequenceEqual(digest), "Independent operation preimage differs from the core digest.");
    byte[] publicPayload = h.Call(children[0], "getPayload", [account, token, method, TransferArgs(dataLength), nonce, new BigInteger(h.Time + Harness.Delay)]).GetSpan().ToArray();
    Require(preimage.SequenceEqual(publicPayload), "Public Session payload differs from the independently serialized core operation.");
    var bundle = new A();
    for (int i = 0; i < children.Length; i++)
        bundle.Add(scenario.Slots[i] == '0' ? StackItem.Null : scenario.Malformed && i == children.Length - 1 ? new Integer(123) : scenario.Roster[i] == 'S' ? new ByteString(Crypto.Sign(preimage, scenario.BadSignature && i == 0 ? Key(9) : keys[i])) : ByteString.Empty);
    bool maximumBundle = scenario.Roster == "SSN" && scenario.Maximum && scenario.Slots == "111";
    if (maximumBundle)
    {
        int unusedLength = 0;
        while (BinarySerializer.Serialize(bundle, 8192, 8192).Length < 1024) bundle[2] = new ByteString(new byte[++unusedLength]);
        Require(BinarySerializer.Serialize(bundle, 8192, 8192).Length == 1024, "Boundary signature bundle is not exactly 1024 bytes.");
    }
    byte[] signatures = BinarySerializer.Serialize(bundle, 8192, 8192);
    object?[] operation = [token, method, TransferArgs(dataLength), nonce, new BigInteger(h.Time + Harness.Delay), signatures];
    // Independent public inputs keep canonical validation; the internal fast path
    // cannot be reached without the service's exact callback grant.
    h.Call(children[0], "getPayload", [account, token, "", TransferArgs(dataLength), nonce, new BigInteger(h.Time + Harness.Delay)], expectSuccess: false);
    Require(h.LastState == VMState.FAULT, "Public payload accepted a noncanonical empty method.");
    h.Call(root, "validateCompositeSignature", [account, operation], expectSuccess: false);
    Require(h.LastState == VMState.FAULT, "Direct validation obtained a native grant.");
    h.Call(root, "postExecuteComposite", [account, operation, true, new object[] { true, new object[] { children[0], children[1] }, new byte[32] }], expectSuccess: false);
    Require(h.LastState == VMState.FAULT, "Transaction-supplied receipt obtained post authority.");
    if (scenario.Roster == "SN" && !scenario.Maximum)
    {
        byte[] initializedLastUse = h.ModuleValue(children[0], account, 6)!;
        foreach (byte[]? invalidLastUse in new byte[]?[] { null, [0xff], [0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 1] })
        {
            h.SetModuleValue(children[0], account, 6, invalidLastUse);
            var corruptedState = Harness.Storage(h.Snapshot);
            h.Call(Harness.Core, "executeUserOp", [account, operation, state[13].GetInteger(), state[8].GetInteger()], expectSuccess: false, signers: [Harness.Owner, Harness.Other, proxy]);
            Require(h.LastState == VMState.FAULT && System.Text.Json.JsonSerializer.Serialize(h.LastResult).Contains("last-use", StringComparison.Ordinal), "Post callback accepted invalid timestamp state or failed for an unrelated reason.");
            Require(corruptedState.OrderBy(x => x.Key).SequenceEqual(Harness.Storage(h.Snapshot).OrderBy(x => x.Key)), "Post timestamp rejection did not roll back all target/account/module writes.");
            h.SetModuleValue(children[0], account, 6, initializedLastUse);
        }
    }
    var verification = h.Verify(account, operation, state, [Harness.Owner, Harness.Other, proxy]);
    bool expectedVerification = !scenario.Malformed && scenario.Slots.Count(c => c == '1') >= 2;
    Require(h.LastState == (expectedVerification ? VMState.HALT : VMState.FAULT), "Verification result differs from the operation approval predicate.");
    var beforeExecution = Harness.Storage(h.Snapshot);
    var trace = new GasTrace(root); h.Trace = trace;
    h.Call(Harness.Core, "executeUserOp", [account, operation, state[13].GetInteger(), state[8].GetInteger()], expectSuccess: false, signers: [Harness.Owner, Harness.Other, proxy]);
    Console.Error.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { scenario.Roster, scenario.Slots, scenario.Maximum, scenario.BadSignature, scenario.Malformed, result = h.LastResult, verification, phases = trace.Rows }));
    bool expected = !scenario.Malformed && scenario.Slots.Count(c => c == '1') >= 2;
    if (diagnose && h.LastState != (expected ? VMState.HALT : VMState.FAULT)) { allPassed = false; rows.Add(new { scenario.Roster, scenario.Slots, scenario.Maximum, scenario.BadSignature, scenario.Malformed, result = h.LastResult, verification, phases = trace.Rows }); continue; }
    Require(h.LastState == (expected ? VMState.HALT : VMState.FAULT), $"Unexpected {scenario}: {System.Text.Json.JsonSerializer.Serialize(h.LastResult)}");
    if (!expected) Require(beforeExecution.OrderBy(x => x.Key).SequenceEqual(Harness.Storage(h.Snapshot).OrderBy(x => x.Key)), "Failed operation changed persisted storage.");
    var execution = h.LastResult;
    h.Trace = null;
    BigInteger afterNonce = h.Call(Harness.Core, "getNonce", [account, nonce >> 64]).GetInteger();
    Require(afterNonce == (expected ? BigInteger.One : BigInteger.Zero), "Wrong target nonce after execution.");
    int selected = 0;
    for (int i = 0; i < children.Length; i++)
    {
        bool approved = expected && scenario.Slots[i] == '1' && !(scenario.BadSignature && i == 0) && selected < 2;
        if (approved) selected++;
        if (scenario.Roster[i] != 'S') continue;
        BigInteger spent = h.Call(children[i], "getSpentAmount", [account]).GetInteger();
        Require(spent == (approved && !longMethod ? amount + (growSpent ? 1 : 0) : growSpent ? 1 : BigInteger.Zero), "Only the first quorum may consume a Session spending allowance.");
        var metadata = (A)h.Call(children[i], "getSessionKeyMetadata", [account]);
        Require(metadata.Count == 3 && metadata[1].GetInteger() == (approved ? new BigInteger(h.Time) : BigInteger.Zero), "Metadata projection lost its three-field last-use semantics.");
        var storedMetadata = (A)BinarySerializer.Deserialize(h.ModuleValue(children[i], account, 2)!, ExecutionEngineLimits.Default);
        Require(storedMetadata[1].GetInteger() == 0, "Post execution rewrote immutable metadata.");
    }
    if (expected) Require(trace.Budgets.Count == 2 && trace.Budgets.All(x => x.Limit == 100_000_000 && x.Consumed < x.Limit), "Both native callbacks must remain strictly within the unchanged 1 GAS budget.");
    rows.Add(new { scenario.Roster, scenario.Slots, scenario.Maximum, scenario.BadSignature, scenario.Malformed, descriptionBytes = scenario.Maximum ? 128 : 16, amount = amount.ToString(), dataLength, methodBytes = method.Length, timestamp = h.Time.ToString(), priorSpent = growSpent ? "1" : "0", signatureBytes = signatures.Length, lastUsePostRollbackNegativeControls = scenario.Roster == "SN" && !scenario.Maximum ? 4 : 0, argumentDepth = deep ? 8 : 1, canonicalDomain = domainHex, result = execution, verification, phases = trace.Rows });
}
// Same public key through different verifier schemes must never count twice.
foreach (bool uncompressed in new[] { false, true })
{
    using var h = new Harness();
    byte[] rawKey = new byte[32]; rawKey[^1] = 1; var key = new KeyPair(rawKey);
    var session = h.Deploy(artifacts, "SessionKeyVerifier", Harness.Owner);
    var native = h.Deploy(artifacts, "NeoNativeVerifier", Harness.Owner);
    var root = h.Deploy(artifacts, "MultiSigVerifier", Harness.Owner);
    UInt160 account = new(h.Call(Harness.Core, "registerAccount", [Harness.Owner, new byte[32], root, UInt160.Zero, UInt160.Zero]).GetSpan());
    var standard = Contract.CreateSignatureContract(key.PublicKey).ScriptHash;
    Require(standard.ToString() == "0x7efe7ee0d3e349e085388c351955e5172605de66", "Standard-account vector differs.");
    h.Configure(account, session, "setSessionKey", [key.PublicKey.EncodePoint(!uncompressed), NativeContract.GAS.Hash, "transfer", new BigInteger(h.Time + 20 * Harness.Delay), new BigInteger(1000), "domain vector"]);
    var publicSession = (A)h.Call(session, "getSessionKey", [account]);
    Require(publicSession.Count == 5 && publicSession[0].GetSpan().SequenceEqual(key.PublicKey.EncodePoint(true)), "Native session getter must retain five fields and a canonical compressed point.");
    var initialMetadata = (A)h.Call(session, "getSessionKeyMetadata", [account]);
    Require(initialMetadata.Count == 3 && initialMetadata[1].GetInteger() == 0, "Configured last-use timestamp was not zero.");
    byte[] initialLastUse = h.ModuleValue(session, account, 6)!;
    foreach (byte[]? invalidLastUse in new byte[]?[] { null, [0xff], [0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 1] })
    {
        h.SetModuleValue(session, account, 6, invalidLastUse);
        h.Call(session, "getSessionKeyMetadata", [account], expectSuccess: false);
        Require(h.LastState == VMState.FAULT, "Metadata getter accepted missing/noncanonical/negative/overflow last-use state.");
        h.SetModuleValue(session, account, 6, initialLastUse);
    }
    var sessionDomain = (A)h.Call(session, "getSignerDomains", [account]);
    h.Configure(account, native, "setConfig", [new object[] { standard }, 1]);
    var nativeDomain = (A)h.Call(native, "getSignerDomains", [account]);
    Require(sessionDomain[0].GetSpan().SequenceEqual(nativeDomain[0].GetSpan()), "Cross-scheme signer domain alias was not detected.");
    h.Call(Harness.Core, "callVerifier", [account, "setConfig", new object[] { new object[] { session, native }, 2 }]);
    h.Time += Harness.Delay;
    var before = Harness.Storage(h.Snapshot);
    h.Call(Harness.Core, "callVerifier", [account, "setConfig", new object[] { new object[] { session, native }, 2 }], expectSuccess: false);
    Require(h.LastState == VMState.FAULT, "Same P256 key gained two independent votes.");
    Require(before.OrderBy(x => x.Key).SequenceEqual(Harness.Storage(h.Snapshot).OrderBy(x => x.Key)), "Rejected duplicate domain changed account/module storage.");
    h.Call(Harness.Core, "cancelModuleCall", [account, "verifier"]);
    // A malformed uncompressed point cannot partially replace the key/domain.
    byte[] invalidPoint = key.PublicKey.EncodePoint(false).ToArray(); invalidPoint[^1] ^= 1;
    object[] replacement = [invalidPoint, NativeContract.GAS.Hash, "transfer", new BigInteger(h.Time + 10 * Harness.Delay), new BigInteger(1000), "bad point"];
    h.Call(Harness.Core, "callVerifierChild", [account, session, "setSessionKey", replacement]); h.Time += Harness.Delay;
    before = Harness.Storage(h.Snapshot);
    h.Call(Harness.Core, "callVerifierChild", [account, session, "setSessionKey", replacement], expectSuccess: false);
    Require(h.LastState == VMState.FAULT && before.OrderBy(x => x.Key).SequenceEqual(Harness.Storage(h.Snapshot).OrderBy(x => x.Key)), "Invalid point did not atomically reject.");
    h.Call(Harness.Core, "cancelModuleCall", [account, "verifier"]);
    h.Configure(account, session, "clearSessionKey", []);
    Require(h.ModuleValue(session, account, 5) is null && h.ModuleValue(session, account, 6) is null && h.ModuleValue(session, account, 4) is not null, "Revocation must delete domain/last-use and retain cooldown.");
    rows.Add(new { label = "session-native-same-key-rejected", uncompressed, standardAccount = standard.ToString(), domain = Convert.ToHexString(sessionDomain[0].GetSpan()).ToLowerInvariant(), initialLastUseHex = Convert.ToHexString(initialLastUse).ToLowerInvariant(), configurationRollback = true, invalidPointRollback = true, revocationClearsDomainAndLastUse = true });
}
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { schema = "smartaccount-native-multisig-probe/v1", status = allPassed ? "PASS" : "FAIL", publicNetworksTouched = false, execution = "ApplicationEngine host probe; synthetic transaction signers, real module NEFs and P256 operation signatures", pricing, artifactHashes = new[] { "SessionKeyVerifier", "NeoNativeVerifier", "MultiSigVerifier" }.SelectMany(n => new[] { n + ".nef", n + ".manifest.json" }).ToDictionary(n => n, n => Hash(Path.Combine(artifacts, n))), runtimeAssemblyHashes = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && a.GetName().Name!.StartsWith("Neo", StringComparison.Ordinal) && a.Location.Length > 0).ToDictionary(a => Path.GetFileName(a.Location), a => Hash(a.Location)), probeSourceHashes = new[] { "Program.cs", "NativeMultiSigProbe.csproj", "packages.lock.json" }.ToDictionary(n => n, n => Hash(Path.Combine(Directory.GetCurrentDirectory(), "tests", "NativeMultiSigProbe", n))), cases = rows }, new JsonSerializerOptions { WriteIndented = true }));

Environment.ExitCode = allPassed ? 0 : 1;

static string Hash(string path) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
static StackItem Stack(object? value) => value switch
{
    null => StackItem.Null,
    UInt160 hash => new ByteString(hash.ToArray()),
    object?[] values => new A(values.Select(Stack)),
    byte[] bytes => new ByteString(bytes),
    string text => new ByteString(System.Text.Encoding.UTF8.GetBytes(text)),
    BigInteger integer => new Integer(integer),
    _ => throw new ArgumentException("Unsupported probe value.")
};

sealed class GasTrace(UInt160 root) : IDiagnostic
{
    private ApplicationEngine engine = null!;
    private string? phase;
    private readonly Dictionary<object, string> budgets = new(ReferenceEqualityComparer.Instance);
    private static BigInteger Scale => ApplicationEngine.FeeFactor * ApplicationEngine.OpcodePriceMultiplier;
    private static BigInteger Value(object budget, string property) => (BigInteger)budget.GetType()
        .GetProperty(property, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)!.GetValue(budget)!;

    // Keep the actual budget objects until execution completes, including the
    // final RET charge. Convert from the engine's units, not from an assumed cap.
    public List<(BigInteger Limit, BigInteger Consumed)> Budgets => budgets.Keys
        .Select(budget => (Value(budget, "Limit") / Scale, (Value(budget, "Consumed") + Scale - 1) / Scale)).ToList();
    public object[] Rows => budgets.Select(pair => (object)new
    {
        phase = pair.Value,
        limitDatoshi = (Value(pair.Key, "Limit") / Scale).ToString(),
        consumedDatoshi = ((Value(pair.Key, "Consumed") + Scale - 1) / Scale).ToString(),
        remainingDatoshi = ((Value(pair.Key, "Limit") - Value(pair.Key, "Consumed")) / Scale).ToString()
    }).ToArray();

    public void Initialized(ApplicationEngine value) => engine = value;
    public void Disposed() { }
    public void CallFromNative(UInt160 target, string method, StackItem[] arguments)
    {
        if (target == root && method is "validateCompositeSignature" or "postExecuteComposite") phase = method;
    }
    public void ContextLoaded(Ctx context) { }
    public void ContextUnloaded(Ctx context) { }
    public void PreExecuteInstruction(Instruction instruction)
    {
        if (phase is null || engine.CurrentScriptHash != root) return;
        var state = engine.CurrentContext!.GetState<ExecutionContextState>();
        var budget = typeof(ExecutionContextState).GetProperty("ContractCallGasBudget",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)!.GetValue(state);
        if (budget is not null) budgets.TryAdd(budget, phase);
    }
    public void PostExecuteInstruction(Instruction instruction) { }
}

sealed class Harness : IDisposable
{
    internal static readonly UInt160 Owner = UInt160.Parse("0x0101010101010101010101010101010101010101");
    internal static readonly UInt160 Other = UInt160.Parse("0x0202020202020202020202020202020202020202");
    internal static UInt160 Core => NativeContract.AccountManagement.Hash;
    internal const ulong Delay = 86_400_000;
    internal ulong Time;
    internal IDiagnostic? Trace;
    internal object? LastResult;
    internal VMState LastState;
    private readonly NeoSystem system;
    internal StoreCache Snapshot;
    private readonly ProtocolSettings settings = ProtocolSettings.Default with
    {
        Network = 0x4E50524F,
        SeedList = [],
        StandbyCommittee = [Neo.Cryptography.ECC.ECPoint.Parse("036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", Neo.Cryptography.ECC.ECCurve.Secp256r1)],
        ValidatorsCount = 1,
        Hardforks = Enum.GetValues<Hardfork>().ToImmutableDictionary(value => value, _ => 0u)
    };

    internal Harness()
    {
        system = new(settings, new MemoryStoreProvider());
        Snapshot = system.GetSnapshotCache();
        Time = NativeContract.Ledger.GetBlock(Snapshot, NativeContract.Ledger.CurrentHash(Snapshot))!.Timestamp + 1000;
    }

    private static void Push(ScriptBuilder builder, object? value)
    {
        if (value is not object[] values) { builder.EmitPush(value); return; }
        if (values.Length == 0) { builder.Emit(OpCode.NEWARRAY0); return; }
        for (int i = values.Length - 1; i >= 0; i--) Push(builder, values[i]);
        builder.EmitPush(values.Length).Emit(OpCode.PACK);
    }

    private static Transaction Transaction(UInt160 target, string method, object?[] arguments, UInt160[] signers)
    {
        using var builder = new ScriptBuilder();
        Push(builder, arguments);
        builder.EmitPush(CallFlags.All).EmitPush(method).EmitPush(target).EmitSysCall(ApplicationEngine.System_Contract_Call);
        return new Transaction
        {
            Script = builder.ToArray(),
            Signers = signers.Select(account => new Signer { Account = account, Scopes = WitnessScope.Global }).ToArray(),
            Attributes = [],
            Witnesses = []
        };
    }

    internal StackItem Call(UInt160 target, string method, object?[] arguments, bool expectSuccess = true, UInt160[]? signers = null)
    {
        var transaction = Transaction(target, method, arguments, signers ?? [Owner]);
        var working = Snapshot.CloneCache();
        var block = new Block
        {
            Header = new Header
            {
                Index = 1,
                Timestamp = Time,
                PrevHash = UInt256.Zero,
                MerkleRoot = UInt256.Zero,
                NextConsensus = UInt160.Zero,
                Witness = new Witness { InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = ReadOnlyMemory<byte>.Empty }
            },
            Transactions = []
        };
        using var engine = ApplicationEngine.Create(TriggerType.Application, transaction, working, block, settings,
            gas: 10_000_000_000, diagnostic: Trace);
        engine.LoadScript(transaction.Script);
        LastState = engine.Execute();
        LastResult = new
        {
            state = LastState.ToString(),
            gas = engine.FeeConsumed,
            minimum = engine.MinimumRequiredFee,
            error = engine.FaultException?.Message,
            notifications = engine.Notifications.Count
        };
        if (expectSuccess && LastState != VMState.HALT) throw new Exception(method + ": " + engine.FaultException);
        // Match persistence: a FAULT discards the entire transaction's clone.
        if (LastState == VMState.HALT) working.Commit();
        return LastState == VMState.HALT && engine.ResultStack.Count > 0 ? engine.ResultStack.Peek() : StackItem.Null;
    }

    internal object Pricing => new
    {
        executionFeeFactor = NativeContract.Policy.GetExecFeeFactor(settings, Snapshot, 1),
        storagePriceDatoshi = NativeContract.Policy.GetStoragePrice(Snapshot),
        globalVerificationLimitDatoshi = Neo.SmartContract.Helper.MaxVerificationGas,
        rootCallbackLimitDatoshi = 100_000_000,
        internalFeeScale = (ApplicationEngine.FeeFactor * ApplicationEngine.OpcodePriceMultiplier).ToString()
    };

    internal object Verify(UInt160 account, object?[] operation, A accountState, UInt160[] signers)
    {
        var transaction = Transaction(Core, "executeUserOp", [account, operation, accountState[13].GetInteger(), accountState[8].GetInteger()], signers);
        using var proxy = new ScriptBuilder();
        proxy.EmitDynamicCall(Core, "verify", CallFlags.ReadOnly, account);
        var before = Storage(Snapshot);
        using var engine = ApplicationEngine.Create(TriggerType.Verification, transaction, Snapshot.CloneCache(), null, settings,
            gas: Neo.SmartContract.Helper.MaxVerificationGas);
        engine.LoadScript(proxy.ToArray(), configureState: state => state.CallFlags = CallFlags.ReadOnly);
        LastState = engine.Execute();
        if (LastState == VMState.HALT && !IsVerificationAuthorized(engine))
            throw new InvalidOperationException("Verification HALT must return exactly one Boolean true.");
        if (!before.OrderBy(pair => pair.Key).SequenceEqual(Storage(Snapshot).OrderBy(pair => pair.Key)))
            throw new InvalidOperationException("Verification changed committed state.");
        return new
        {
            state = LastState.ToString(),
            authorized = IsVerificationAuthorized(engine),
            resultCount = engine.ResultStack.Count,
            resultType = engine.ResultStack.Count == 1 ? engine.ResultStack.Peek().Type.ToString() : null,
            booleanResult = engine.ResultStack.Count == 1 && engine.ResultStack.Peek() is Neo.VM.Types.Boolean value ? (bool?)value.GetBoolean() : null,
            gasConsumedDatoshi = engine.FeeConsumed,
            gasLimitDatoshi = Neo.SmartContract.Helper.MaxVerificationGas,
            exception = engine.FaultException?.Message
        };
    }

    private static bool IsVerificationAuthorized(ApplicationEngine engine) => engine.State == VMState.HALT
        && engine.ResultStack.Count == 1 && engine.ResultStack.Peek() is Neo.VM.Types.Boolean value && value.GetBoolean();

    internal bool VerifyResultControl(byte[] script)
    {
        using var engine = ApplicationEngine.Create(TriggerType.Verification, null, Snapshot.CloneCache(), null, settings,
            gas: Neo.SmartContract.Helper.MaxVerificationGas);
        engine.LoadScript(script);
        engine.Execute();
        return IsVerificationAuthorized(engine);
    }

    private StorageKey ModuleKey(UInt160 module, UInt160 account, byte prefix) => new()
    {
        Id = NativeContract.ContractManagement.GetContract(Snapshot, module)!.Id,
        Key = new byte[] { 0xa2, prefix }.Concat(account.ToArray()).Concat(new byte[8]).ToArray()
    };
    internal void SetModuleValue(UInt160 module, UInt160 account, byte prefix, byte[]? value)
    {
        var key = ModuleKey(module, account, prefix);
        Snapshot.Delete(key);
        if (value is not null) Snapshot.Add(key, new StorageItem(value));
    }
    internal byte[]? ModuleValue(UInt160 module, UInt160 account, byte prefix) => Snapshot.TryGet(ModuleKey(module, account, prefix))?.Value.ToArray();
    internal static Dictionary<string, string> Storage(DataCache snapshot) => snapshot.Find((byte[]?)null)
        .ToDictionary(pair => Convert.ToHexString(pair.Key.ToArray()), pair => Convert.ToHexString(pair.Value.Value.Span));

    internal UInt160 Deploy(string directory, string name, UInt160 sender)
    {
        byte[] nef = File.ReadAllBytes(Path.Combine(directory, name + ".nef"));
        string manifest = File.ReadAllText(Path.Combine(directory, name + ".manifest.json"));
        var deployed = (A)Call(NativeContract.ContractManagement.Hash, "deploy", [nef, manifest, Core], signers: [sender]);
        UInt160 hash = new(deployed[2].GetSpan());
        var contract = NativeContract.ContractManagement.GetContract(Snapshot, hash)!;
        if (!contract.Nef.ToArray().SequenceEqual(nef) || contract.Manifest.ToJson().ToString() != ContractManifest.Parse(manifest).ToJson().ToString())
            throw new InvalidOperationException("Deployed artifact bytes differ from the supplied production artifacts.");
        return hash;
    }

    internal void Configure(UInt160 account, UInt160? child, string method, object[] arguments)
    {
        string route = child is null ? "callVerifier" : "callVerifierChild";
        object[] parameters = child is null ? [account, method, arguments] : [account, child, method, arguments];
        Call(Core, route, parameters);
        Time += Delay;
        Call(Core, route, parameters);
    }

    // Test-only transfer target: it enforces the real proxy witness but has no
    // token supply. This lets the cost matrix exercise the full integer bounds.
    internal UInt160 Token(string method = "transfer")
    {
        using var builder = new ScriptBuilder();
        builder.Emit(OpCode.INITSLOT, new byte[] { 0, 4 }).Emit(OpCode.LDARG0)
            .EmitSysCall(ApplicationEngine.System_Runtime_CheckWitness).Emit(OpCode.RET);
        var nef = new NefFile { Compiler = "CostProbe", Source = "", Tokens = [], Script = builder.ToArray() };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        var manifest = new ContractManifest
        {
            Name = "CostProbeTransfer",
            Groups = [],
            SupportedStandards = [],
            Permissions = [],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
            Abi = new ContractAbi
            {
                Methods = [new ContractMethodDescriptor
                {
                    Name = method, Offset = 0, Safe = false, ReturnType = ContractParameterType.Boolean,
                    Parameters = new[] { ContractParameterType.Hash160, ContractParameterType.Hash160, ContractParameterType.Integer, ContractParameterType.Any }
                        .Select((type, index) => new ContractParameterDefinition { Name = "a" + index, Type = type }).ToArray()
                }],
                Events = []
            }
        };
        var deployed = (A)Call(NativeContract.ContractManagement.Hash, "deploy", [nef.ToArray(), manifest.ToJson().ToString(), null]);
        return new(deployed[2].GetSpan());
    }
    public void Dispose() { Snapshot.Dispose(); system.Dispose(); }
}
