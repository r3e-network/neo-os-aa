using System.Numerics;
using System.Text.Json;
using AbstractAccount.Contracts.Tests;
using Neo;
using Neo.Extensions;
using Neo.IO;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;
using Neo.VM.Types;
using Ctx = Neo.VM.ExecutionContext;

// These tests execute compiler-produced production modules in a real public
// NeoVM with a deliberately permissive test service ABI. They prove the module
// key transition, not native recovery authorization or private-chain admission.
if (args.Length == 0 || args.Skip(1).Any(arg => arg is not "--result-isolation-only" and not "--require-boolean-fast-path"))
    throw new ArgumentException("Pass the artifact directory and optional result-isolation flags.");
string artifacts = Path.GetFullPath(args[0]);
bool resultIsolationOnly = args.Contains("--result-isolation-only");
bool requireBooleanFastPath = args.Contains("--require-boolean-fast-path");
UInt160 service = UInt160.Parse("0xd9421d07adf206e9dc4be746a02e8e087fa61741");
UInt160 account = UInt160.Parse("0x1111111111111111111111111111111111111111");
UInt160 other = UInt160.Parse("0x2222222222222222222222222222222222222222");
UInt160 signer = UInt160.Parse("0x3333333333333333333333333333333333333333");
List<object> cases = [];
List<object> resultPaths = [];
int failures = 0;

void Require(bool value, string message)
{
    if (!value) throw new InvalidOperationException(message);
}

UInt160 Deploy(RuntimeFixture fx, string name) => fx.DeployArtifact(
    File.ReadAllBytes(Path.Combine(artifacts, name + ".nef")),
    File.ReadAllText(Path.Combine(artifacts, name + ".manifest.json")), service.ToArray());

RuntimeFixture Create()
{
    RuntimeFixture fx = new();
    Require(NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, service) is null,
        "The test must use a public runtime without a real native service at the fixture address.");
    var state = new ContractState
    {
        Id = 1_000_001, Hash = service,
        Nef = NefFile.Parse(File.ReadAllBytes(Path.Combine(artifacts, "NativeEpochCore.nef")), true),
        Manifest = ContractManifest.Parse(File.ReadAllText(Path.Combine(artifacts, "NativeEpochCore.manifest.json")))
    };
    fx.Engine.Storage.Snapshot.Add(new StorageKey
    {
        Id = NativeContract.ContractManagement.Id, Key = new byte[] { 8 }.Concat(service.ToArray()).ToArray()
    }, new StorageItem(state));
    Require(fx.CallInteger(service, "getAuthorityEpoch", account) == 0, "fixture epoch zero");
    return fx;
}

void Run(string label, Action action)
{
    if (resultIsolationOnly && !label.StartsWith("multisig-result-", StringComparison.Ordinal)) return;
    try { action(); cases.Add(new { label, status = "PASS" }); }
    catch (Exception error)
    {
        failures++;
        cases.Add(new { label, status = "FAIL", error = error.Message });
    }
}

foreach (string profile in new[] { "NeoNativeVerifier", "SessionKeyVerifier", "MultiSigVerifier", "WhitelistHook", "DailyLimitHook", "TokenRestrictedHook" })
{
    Run(profile + "-epoch-isolation-and-cleanup", () =>
    {
        RuntimeFixture fx = Create();
        UInt160 module = Deploy(fx, profile);
        UInt160 token = fx.GasHash;
        using P256SessionKey session = new();
        UInt160 child = profile == "MultiSigVerifier" ? Deploy(fx, "NeoNativeVerifier") : UInt160.Zero;
        object[] op = RuntimeFixture.UserOp(token, "balanceOf", new object?[] { account }, 0, 9999999999999L, System.Array.Empty<byte>());
        void Configure(UInt160 id)
        {
            switch (profile)
            {
                case "NeoNativeVerifier": fx.CallVoid(module, "setConfig", id, new[] { signer }, 1); break;
                case "SessionKeyVerifier": fx.CallVoid(module, "setSessionKey", id, session.CompressedPublicKey, token, "transfer", fx.Now() + 86400000, 100, "epoch probe"); break;
                case "MultiSigVerifier":
                    fx.CallVoid(child, "setConfig", id, new[] { signer }, 1);
                    fx.CallVoid(module, "setConfig", id, new[] { child }, 1); break;
                case "WhitelistHook": fx.CallVoid(module, "setWhitelist", id, token, true); break;
                case "DailyLimitHook": fx.CallVoid(module, "setDailyLimit", id, token, 100, false); break;
                case "TokenRestrictedHook": fx.CallVoid(module, "setRestrictedToken", id, token, true); break;
            }
        }
        bool IsLive(UInt160 id)
        {
            switch (profile)
            {
                case "NeoNativeVerifier": return fx.CallInteger(module, "getThreshold", id) == 1;
                case "SessionKeyVerifier":
                    StackItem current = fx.Call(module, "getSessionKey", id);
                    if (current.IsNull) return false;
                    Require(current is Neo.VM.Types.Array fields && fields.Count == 5, "Public session record must remain five fields");
                    StackItem metadata = fx.Call(module, "getSessionKeyMetadata", id);
                    Require(metadata is Neo.VM.Types.Array metadataFields && metadataFields.Count == 3,
                        "Public session metadata must remain three fields");
                    return true;
                case "MultiSigVerifier": return !fx.Call(module, "getConfig", id).IsNull;
                case "WhitelistHook": return fx.CallBoolean(module, "isWhitelisted", id, token);
                case "DailyLimitHook": return fx.CallInteger(module, "getDailyLimit", id, token) == 100;
                case "TokenRestrictedHook":
                    try { fx.CallVoid(module, "preExecute", id, op); return false; }
                    catch (TestException error)
                    {
                        Require(error.Message.Contains("restricted", StringComparison.OrdinalIgnoreCase), "wrong restriction fault: " + error.Message);
                        return true;
                    }
                default: throw new InvalidOperationException(profile);
            }
        }
        StorageKey Key(UInt160 id, ulong epoch, byte prefix = 1)
        {
            byte[] suffix = profile.EndsWith("Hook", StringComparison.Ordinal) ? token.ToArray() : [];
            byte[] epochBytes = new byte[8];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt64LittleEndian(epochBytes, epoch);
            return new StorageKey
            {
                Id = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, module)!.Id,
                Key = new byte[] { 0xA2, prefix }.Concat(id.ToArray()).Concat(epochBytes).Concat(suffix).ToArray()
            };
        }
        Configure(account); Configure(other);
        Require(IsLive(account) && IsLive(other), "configured policy must be live before transition");
        if (profile == "NeoNativeVerifier")
            Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 0, 3))?.Value.Length == 32,
                "Native signer domains must occupy their packed 03 epoch key");
        if (profile == "SessionKeyVerifier")
        {
            Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 0, 5))?.Value.Length == 32,
                "Native session signer domain must occupy its separate 05 epoch key");
            Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 0, 6)) is not null,
                "Native session last-used timestamp must be atomically initialized at 06");
        }
        fx.CallVoid(service, "setEpoch", account, 1);
        Require(fx.CallInteger(service, "getAuthorityEpoch", account) == 1, "fixture epoch did not advance");
        Require(!IsLive(account), "old configured policy resurrected in authority epoch 1");
        Require(IsLive(other), "epoch change crossed account boundary");
        Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 0)) is not null, "epoch zero storage must remain isolated, not implicitly erased");
        Configure(account);
        Require(IsLive(account), "fresh policy must work at epoch 1");
        Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 1)) is not null, "new policy has wrong A2/account/LE64 key");
        fx.CallVoid(module, "clearAccount", account);
        Require(!IsLive(account) && IsLive(other), "cleanup must clear only current account and epoch");
        Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 0)) is not null, "cleanup erased a different epoch");
        if (profile == "NeoNativeVerifier")
        {
            Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 0, 3)) is not null, "cleanup erased another epoch native signer domains");
            Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 1, 3)) is null, "cleanup left current native signer domains live");
        }
        if (profile == "SessionKeyVerifier")
        {
            Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 0, 5)) is not null, "cleanup erased another epoch signer domain");
            Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 1, 5)) is null, "cleanup left the current signer domain live");
            Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 0, 6)) is not null, "cleanup erased another epoch timestamp");
            Require(fx.Engine.Storage.Snapshot.TryGet(Key(account, 1, 6)) is null, "cleanup left the current timestamp live");
        }
    });
}

Run("epoch-wire-type-range-and-LE64", () =>
{
    RuntimeFixture fx = Create();
    UInt160 module = Deploy(fx, "NeoNativeVerifier");
    foreach (object epoch in new object[] { -1, BigInteger.One << 64, true, new byte[] { 1 } })
    {
        fx.CallVoid(service, "setEpoch", account, epoch);
        try { fx.CallInteger(module, "getThreshold", account); throw new InvalidOperationException("invalid epoch accepted: " + epoch); }
        catch (TestException error) { Require(error.Message.Contains("authority epoch", StringComparison.OrdinalIgnoreCase), "wrong epoch rejection: " + error.Message); }
    }
    fx.CallVoid(service, "setEpoch", account, (BigInteger)ulong.MaxValue);
    fx.CallVoid(module, "setConfig", account, new[] { signer }, 1);
    int id = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, module)!.Id;
    var key = new StorageKey { Id = id, Key = new byte[] { 0xA2, 1 }.Concat(account.ToArray()).Concat(Enumerable.Repeat((byte)255, 8)).ToArray() };
    Require(fx.Engine.Storage.Snapshot.TryGet(key) is not null, "UInt64 maximum must occupy exactly eight LE bytes");
});

Run("untagged-keys-cannot-contaminate-epoch-zero-prefix-scans", () =>
{
    RuntimeFixture fx = Create();
    UInt160 module = Deploy(fx, "TokenRestrictedHook");
    int id = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, module)!.Id;
    // In the old layout this token begins with eight zero bytes in storage.
    // Without A2, a new epoch-zero prefix would select this shorter old record.
    UInt160 oldToken = new(new byte[8].Concat(Enumerable.Repeat((byte)0x77, 12)).ToArray());
    var stale = new StorageKey { Id = id, Key = new byte[] { 1 }.Concat(account.ToArray()).Concat(oldToken.ToArray()).ToArray() };
    fx.Engine.Storage.Snapshot.Add(stale, new StorageItem(new byte[] { 1 }));
    object[] op = RuntimeFixture.UserOp(fx.StdLibHash, "serialize", new object?[] { 7 }, 0, 9999999999999L, System.Array.Empty<byte>());
    fx.CallVoid(module, "preExecute", account, op);
    fx.CallVoid(module, "postExecute", account, op, true);
    fx.CallVoid(module, "clearAccount", account);
    Require(fx.Engine.Storage.Snapshot.TryGet(stale) is not null, "A2 cleanup must not reinterpret old untagged keys");
});

UInt160 Leaf(RuntimeFixture fx, byte domain, Action<ScriptBuilder> validate, Action<ScriptBuilder> post, Action<ScriptBuilder>? signerDomains = null)
{
    using ScriptBuilder script = new();
    List<ContractMethodDescriptor> methods = [];
    void Method(string name, ContractParameterType result, bool safe, params ContractParameterType[] parameters)
    {
        methods.Add(new ContractMethodDescriptor
        {
            Name = name, Offset = script.Length, ReturnType = result, Safe = safe,
            Parameters = parameters.Select((type, index) => new ContractParameterDefinition { Name = "p" + index, Type = type }).ToArray()
        });
        if (parameters.Length > 0) script.Emit(OpCode.INITSLOT, new byte[] { 0, (byte)parameters.Length });
    }
    Method("supportsV3", ContractParameterType.Boolean, true); script.EmitPush(true).Emit(OpCode.RET);
    Method("supportsComposition", ContractParameterType.Boolean, true); script.EmitPush(false).Emit(OpCode.RET);
    Method("getSignerDomains", ContractParameterType.Array, true, ContractParameterType.Hash160);
    if (signerDomains is null) script.EmitPush(Enumerable.Repeat(domain, 32).ToArray()).EmitPush(1).Emit(OpCode.PACK);
    else signerDomains(script);
    script.Emit(OpCode.RET);
    foreach (string method in new[] { "validateSignature", "validateSignatureForPostExecute" })
    {
        Method(method, ContractParameterType.Boolean, true, ContractParameterType.Hash160, ContractParameterType.Array);
        validate(script); script.Emit(OpCode.RET);
    }
    Method("postExecute", ContractParameterType.Void, false, ContractParameterType.Hash160, ContractParameterType.Array, ContractParameterType.Any);
    post(script); script.Emit(OpCode.RET);
    Method("clearAccount", ContractParameterType.Void, false, ContractParameterType.Hash160); script.Emit(OpCode.RET);
    NefFile nef = new() { Compiler = "Native epoch probe diagnostic leaf", Source = "", Tokens = [], Script = script.ToArray() };
    nef.CheckSum = NefFile.ComputeChecksum(nef);
    ContractManifest manifest = new()
    {
        Name = "EpochDiagnosticLeaf" + domain, Groups = [], SupportedStandards = [], Permissions = [],
        Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(), Abi = new ContractAbi { Methods = methods.ToArray(), Events = [] }
    };
    return fx.DeployArtifact(nef.ToArray(), manifest.ToJson().ToString());
}
void Approve(ScriptBuilder script) => script.EmitPush(true);
void NoPost(ScriptBuilder script) { }
void NestedArgument(ScriptBuilder script) => script.Emit(OpCode.LDARG1).EmitPush(2).Emit(OpCode.PICKITEM).EmitPush(0).Emit(OpCode.PICKITEM);
void MutateArguments(ScriptBuilder script)
{
    NestedArgument(script); script.EmitPush(0).EmitPush(999).Emit(OpCode.SETITEM).EmitPush(true);
}
void CheckArguments(ScriptBuilder script)
{
    NestedArgument(script); script.EmitPush(0).Emit(OpCode.PICKITEM).EmitPush(7).Emit(OpCode.NUMEQUAL);
}
void MutateResult(ScriptBuilder script) => script.Emit(OpCode.LDARG2).EmitPush(0).Emit(OpCode.PICKITEM).EmitPush(0).EmitPush(999).Emit(OpCode.SETITEM);
void CheckResult(ScriptBuilder script) => script.Emit(OpCode.LDARG2).EmitPush(0).Emit(OpCode.PICKITEM).EmitPush(0).Emit(OpCode.PICKITEM).EmitPush(7).Emit(OpCode.NUMEQUAL).Emit(OpCode.ASSERT);
object[] CompositeOperation(RuntimeFixture fx, int children) => RuntimeFixture.UserOp(fx.StdLibHash, "serialize",
    new object?[] { new object[] { 7 } }, 0, 9999999999999L,
    fx.StdLibSerialize(Enumerable.Range(0, children).Select(_ => (object)System.Array.Empty<byte>()).ToArray()));
StackItem CompositePost(RuntimeFixture fx, UInt160 root, object[] op) => fx.Call(service, "callPostAndReturn", root, account, op, new object[] { new object[] { 7 } });
void RequireOriginalResult(StackItem item) => Require(item is Neo.VM.Types.Array result && result[0] is Neo.VM.Types.Array nested && nested[0].GetInteger() == 7,
    "child mutation escaped into the original target result");

Run("multisig-single-child-positive-control", () =>
{
    RuntimeFixture fx = Create(); UInt160 root = Deploy(fx, "MultiSigVerifier");
    UInt160 child = Leaf(fx, 1, Approve, CheckResult);
    fx.CallVoid(root, "setConfig", account, new[] { child }, 1);
    RequireOriginalResult(CompositePost(fx, root, CompositeOperation(fx, 1)));
});
Run("multisig-nested-result-isolated-between-children", () =>
{
    RuntimeFixture fx = Create(); UInt160 root = Deploy(fx, "MultiSigVerifier");
    UInt160 first = Leaf(fx, 1, Approve, MutateResult), second = Leaf(fx, 2, Approve, CheckResult);
    fx.CallVoid(root, "setConfig", account, new[] { first, second }, 2);
    RequireOriginalResult(CompositePost(fx, root, CompositeOperation(fx, 2)));
});
Run("multisig-single-mutator-cannot-alter-original-result", () =>
{
    RuntimeFixture fx = Create(); UInt160 root = Deploy(fx, "MultiSigVerifier");
    UInt160 child = Leaf(fx, 1, Approve, MutateResult);
    fx.CallVoid(root, "setConfig", account, new[] { child }, 1);
    RequireOriginalResult(CompositePost(fx, root, CompositeOperation(fx, 1)));
});
Run("multisig-nested-arguments-isolated-through-receipt-path", () =>
{
    RuntimeFixture fx = Create(); UInt160 root = Deploy(fx, "MultiSigVerifier");
    UInt160 first = Leaf(fx, 1, MutateArguments, script => { MutateArguments(script); script.Emit(OpCode.DROP); }),
        second = Leaf(fx, 2, CheckArguments, script => { CheckArguments(script); script.Emit(OpCode.ASSERT); });
    fx.CallVoid(root, "setConfig", account, new[] { first, second }, 2);
    object[] op = CompositeOperation(fx, 2);
    StackItem receipt = fx.Call(root, "validateCompositeSignature", account, op);
    Require(receipt is Neo.VM.Types.Array values && values.Count == 3 && values[0] is Neo.VM.Types.Boolean && values[0].GetBoolean()
        && values[1] is Neo.VM.Types.Array approved && approved.Count == 2,
        "child argument mutation changed another approval receipt");
    RequireOriginalResult(CompositePost(fx, root, op));
});
Run("multisig-only-exact-Boolean-true-votes", () =>
{
    RuntimeFixture fx = Create(); UInt160 root = Deploy(fx, "MultiSigVerifier");
    UInt160 child = Leaf(fx, 1, script => script.EmitPush(1), NoPost);
    fx.CallVoid(root, "setConfig", account, new[] { child }, 1);
    object[] op = CompositeOperation(fx, 1);
    try { fx.Call(root, "validateCompositeSignature", account, op); throw new InvalidOperationException("Integer 1 counted as an approval"); }
    catch (TestException error) { Require(error.Message.Contains("Verifier rejected signature"), "wrong strict-vote fault: " + error.Message); }
    try { CompositePost(fx, root, op); throw new InvalidOperationException("Integer 1 produced a post approval receipt"); }
    catch (TestException error) { Require(error.Message.Contains("Verifier rejected signature"), "wrong strict-vote post-path fault: " + error.Message); }
});
Run("multisig-rejects-unserializable-Interop-result", () =>
{
    RuntimeFixture fx = Create(); UInt160 root = Deploy(fx, "MultiSigVerifier");
    UInt160 child = Leaf(fx, 1, Approve, NoPost);
    fx.CallVoid(root, "setConfig", account, new[] { child }, 1);
    try { fx.CallVoid(service, "callPostWithIterator", root, account, CompositeOperation(fx, 1)); throw new InvalidOperationException("Interop result crossed the ownership boundary"); }
    catch (TestException error) { Require(error.ToString().Contains("serialize", StringComparison.OrdinalIgnoreCase) || error.ToString().Contains("Interop", StringComparison.OrdinalIgnoreCase), "wrong Interop rejection: " + error); }
});

foreach (bool buffer in new[] { false, true })
{
    Run(buffer ? "multisig-rejects-Buffer-signer-domain" : "multisig-rejects-Struct-signer-domain-array", () =>
    {
        RuntimeFixture fx = Create(); UInt160 root = Deploy(fx, "MultiSigVerifier");
        UInt160 child = Leaf(fx, 1, Approve, NoPost, script =>
        {
            if (buffer) script.EmitPush(32).Emit(OpCode.NEWBUFFER).EmitPush(1).Emit(OpCode.PACK);
            else script.EmitPush(1).Emit(OpCode.NEWSTRUCT).Emit(OpCode.DUP).EmitPush(0)
                .EmitPush(new byte[32]).Emit(OpCode.SETITEM);
        });
        try { fx.CallVoid(root, "setConfig", account, new[] { child }, 1); throw new InvalidOperationException("Malformed signer domains were admitted"); }
        catch (TestException error)
        {
            Require(error.Message.Contains(buffer ? "Invalid signer domain" : "Signer domains must be an Array"),
                "wrong malformed-domain rejection: " + error.Message);
        }
        Require(fx.Call(root, "getConfig", account).IsNull, "Failed configuration published a partial root");
    });
}

void PushValue(ScriptBuilder script, object? value)
{
    if (value is object?[] values)
    {
        for (int i = values.Length - 1; i >= 0; i--) PushValue(script, values[i]);
        script.EmitPush(values.Length).Emit(OpCode.PACK);
    }
    else script.EmitPush(value);
}

string InnerKind(string kind) => kind.StartsWith("nested-", StringComparison.Ordinal) ? kind[7..] : kind;
StackItemType ResultType(string kind) => kind.StartsWith("nested-", StringComparison.Ordinal) ? StackItemType.Array : kind switch
{
    "true" or "false" => StackItemType.Boolean,
    "null" => StackItemType.Any,
    "integer" or "integer-zero" or "integer-one" => StackItemType.Integer,
    "bytes" => StackItemType.ByteString,
    "buffer" => StackItemType.Buffer,
    "array" => StackItemType.Array,
    "struct" => StackItemType.Struct,
    "map" => StackItemType.Map,
    _ => throw new ArgumentException(kind)
};
void EmitResult(ScriptBuilder script, string kind)
{
    if (kind.StartsWith("nested-", StringComparison.Ordinal))
    {
        EmitResult(script, InnerKind(kind)); script.EmitPush(1).Emit(OpCode.PACK); return;
    }
    switch (kind)
    {
        case "true": script.EmitPush(true); break;
        case "false": script.EmitPush(false); break;
        case "null": script.Emit(OpCode.PUSHNULL); break;
        case "integer": script.EmitPush(7); break;
        case "integer-zero": script.EmitPush(0); break;
        case "integer-one": script.EmitPush(1); break;
        case "bytes": script.EmitPush(new byte[] { 7 }); break;
        case "buffer": script.EmitPush(1).Emit(OpCode.NEWBUFFER).Emit(OpCode.DUP).EmitPush(0).EmitPush(7).Emit(OpCode.SETITEM); break;
        case "array": script.EmitPush(7).EmitPush(1).Emit(OpCode.PACK); break;
        case "struct": script.EmitPush(1).Emit(OpCode.NEWSTRUCT).Emit(OpCode.DUP).EmitPush(0).EmitPush(7).Emit(OpCode.SETITEM); break;
        case "map": script.Emit(OpCode.NEWMAP).Emit(OpCode.DUP).EmitPush("k").EmitPush(7).Emit(OpCode.SETITEM); break;
        case "cycle": script.Emit(OpCode.NEWARRAY0).Emit(OpCode.DUP).Emit(OpCode.DUP).Emit(OpCode.APPEND); break;
        default: throw new ArgumentException(kind);
    }
}
void ResultInner(ScriptBuilder script, string kind)
{
    script.Emit(OpCode.LDARG2);
    if (kind.StartsWith("nested-", StringComparison.Ordinal)) script.EmitPush(0).Emit(OpCode.PICKITEM);
}
void AssertResult(ScriptBuilder script, string kind, int number = 7)
{
    script.Emit(OpCode.LDARG2);
    if (kind == "null") { script.Emit(OpCode.ISNULL).Emit(OpCode.ASSERT); return; }
    script.Emit(OpCode.ISTYPE, new byte[] { (byte)ResultType(kind) }).Emit(OpCode.ASSERT);
    ResultInner(script, kind);
    string inner = InnerKind(kind);
    if (kind.StartsWith("nested-", StringComparison.Ordinal))
        script.Emit(OpCode.DUP).Emit(OpCode.ISTYPE, new byte[] { (byte)ResultType(inner) }).Emit(OpCode.ASSERT);
    if (inner is "true" or "false") { script.EmitPush(inner == "true").Emit(OpCode.EQUAL).Emit(OpCode.ASSERT); return; }
    if (inner is "array" or "struct" or "bytes" or "buffer") script.EmitPush(0).Emit(OpCode.PICKITEM);
    else if (inner == "map") script.EmitPush("k").Emit(OpCode.PICKITEM);
    script.EmitPush(inner == "integer-zero" ? 0 : inner == "integer-one" ? 1 : number).Emit(OpCode.NUMEQUAL).Emit(OpCode.ASSERT);
}
void PostMarker(ScriptBuilder script) => script.EmitPush(1).EmitPush(new byte[] { 0xd0 })
    .EmitSysCall(ApplicationEngine.System_Storage_GetContext.Hash).EmitSysCall(ApplicationEngine.System_Storage_Put.Hash);
void MutateTypedResult(ScriptBuilder script, string kind)
{
    string inner = InnerKind(kind);
    if (inner is not ("array" or "struct" or "map" or "buffer")) return;
    ResultInner(script, kind);
    if (inner == "map") script.EmitPush("k"); else script.EmitPush(0);
    script.EmitPush(9).Emit(OpCode.SETITEM);
    AssertResult(script, kind, 9);
}
Dictionary<string, string> SnapshotBytes(DataCache snapshot) => snapshot.Find((byte[]?)null)
    .ToDictionary(pair => Convert.ToHexString(pair.Key.ToArray()), pair => Convert.ToHexString(pair.Value.Value.Span));
byte[] ExpectedResultBytes(string kind)
{
    using ScriptBuilder script = new(); EmitResult(script, kind);
    using var engine = new ExecutionEngine(); engine.LoadScript(script.ToArray());
    Require(engine.Execute() == VMState.HALT, "Result construction failed");
    return BinarySerializer.Serialize(engine.ResultStack.Peek(), 8192, 8192).ToArray();
}

foreach (string kind in new[] { "true", "false", "null", "integer", "integer-zero", "integer-one", "bytes", "buffer", "array", "struct", "map", "nested-array", "nested-buffer", "nested-struct", "nested-map", "interop", "cycle" })
{
    Run("multisig-result-" + kind + "-type-ownership-and-path", () =>
    {
        RuntimeFixture fx = Create(); UInt160 root = Deploy(fx, "MultiSigVerifier");
        bool rejection = kind is "interop" or "cycle";
        UInt160 first = Leaf(fx, 1, Approve, script =>
        {
            PostMarker(script);
            if (!rejection) { AssertResult(script, kind); MutateTypedResult(script, kind); }
        });
        UInt160 second = Leaf(fx, 2, Approve, script =>
        {
            PostMarker(script);
            if (!rejection) AssertResult(script, kind);
        });
        fx.CallVoid(root, "setConfig", account, new[] { first, second }, 2);
        object[] operation = CompositeOperation(fx, 2);
        var block = new Block
        {
            Header = new Header
            {
                Index = 1, Timestamp = checked((ulong)fx.Now()), PrevHash = UInt256.Zero,
                MerkleRoot = UInt256.Zero, NextConsensus = UInt160.Zero,
                Witness = new Witness { InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = ReadOnlyMemory<byte>.Empty }
            },
            Transactions = []
        };
        var before = SnapshotBytes(fx.Engine.Storage.Snapshot);
        using ScriptBuilder entry = new();
        entry.EmitPush(kind == "interop");
        EmitResult(entry, kind == "interop" ? "null" : kind);
        PushValue(entry, operation); entry.EmitPush(account).EmitPush(root).EmitPush(5).Emit(OpCode.PACK);
        entry.EmitPush(CallFlags.All).EmitPush("callPostProbe").EmitPush(service).EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
        var working = fx.Engine.Storage.Snapshot.CloneCache();
        var trace = new ResultPathTrace(root, first, second, service);
        using var engine = ApplicationEngine.Create(TriggerType.Application, fx.Engine.Transaction, working,
            block, fx.Engine.ProtocolSettings, gas: 10_000_000_000, diagnostic: trace);
        engine.LoadScript(entry.ToArray());
        VMState state = engine.Execute();
        int fixtureId = NativeContract.ContractManagement.GetContract(working, service)!.Id;
        var marker = new StorageKey { Id = fixtureId, Key = new byte[] { 0xfe } };
        Require(trace.FixtureWriteObserved, "The fixture write did not execute before the result callback");
        Require(before.OrderBy(pair => pair.Key).SequenceEqual(SnapshotBytes(fx.Engine.Storage.Snapshot).OrderBy(pair => pair.Key)),
            "An uncommitted result invocation changed persisted storage");
        resultPaths.Add(new { kind, state = state.ToString(), trace.SerializeCalls, trace.DeserializeCalls,
            trace.FirstPostEntries, trace.SecondPostEntries, trace.FixtureWriteObserved, rollback = rejection,
            error = engine.FaultException?.ToString() });
        if (rejection)
        {
            Require(state == VMState.FAULT, "Unserializable result was accepted");
            Require(trace.FirstPostEntries == 0 && trace.SecondPostEntries == 0, "A post child ran before unsupported result rejection");
            Require(trace.SerializeCalls == 4 && trace.DeserializeCalls == 2, "Rejection did not reach the original result serialization boundary");
            string error = engine.FaultException?.ToString() ?? "";
            Require(error.Contains("serializ", StringComparison.OrdinalIgnoreCase) || error.Contains("Interop", StringComparison.OrdinalIgnoreCase)
                || error.Contains("circular", StringComparison.OrdinalIgnoreCase), "Unexpected rejection: " + error);
            // The diagnostic observed the write before the callback. After
            // FAULT, the VM has reverted it in both working and base snapshots,
            // before this host discards the transaction clone.
            Require(fx.Engine.Storage.Snapshot.TryGet(marker) is null, "Rejected result retained its pre-callback write");
            Require(before.OrderBy(pair => pair.Key).SequenceEqual(SnapshotBytes(working).OrderBy(pair => pair.Key)),
                "FAULT did not revert the fixture invocation's storage writes");
            return;
        }
        Require(state == VMState.HALT, "Result propagation failed: " + engine.FaultException);
        Require(trace.FirstPostEntries == 1 && trace.SecondPostEntries == 1, "Both approved children must observe the result exactly once");
        Require(engine.ResultStack.Count == 1, "Result fixture must return one original result");
        StackItem original = engine.ResultStack.Peek();
        Require(original.Type == ResultType(kind) && BinarySerializer.Serialize(original, 8192, 8192).AsSpan().SequenceEqual(ExpectedResultBytes(kind)),
            "Child mutation changed the original result type or contents");
        bool boolean = kind is "true" or "false";
        bool originalPath = trace.SerializeCalls == 5 && trace.DeserializeCalls == 7;
        bool booleanPath = trace.SerializeCalls == 4 && trace.DeserializeCalls == 5;
        Require(boolean ? (requireBooleanFastPath ? booleanPath : originalPath || booleanPath) : originalPath,
            $"Wrong result path for {kind}: serialize={trace.SerializeCalls}, deserialize={trace.DeserializeCalls}");
        working.Commit();
        foreach (UInt160 child in new[] { first, second })
        {
            int childId = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, child)!.Id;
            Require(fx.Engine.Storage.Snapshot.TryGet(new StorageKey { Id = childId, Key = new byte[] { 0xd0 } }) is not null,
                "Successful child result assertion did not persist its marker");
        }
    });
}

Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { status = failures == 0 ? "PASS" : "FAIL", publicNetworksTouched = false,
    evidence = "Real public NeoVM executes production module NEFs against a test-only epoch service ABI; no native recovery/admission claim.",
    resultIsolationOnly, requireBooleanFastPath, resultPaths, cases }, new JsonSerializerOptions { WriteIndented = true }));
return failures == 0 ? 0 : 1;

sealed class ResultPathTrace(UInt160 root, UInt160 first, UInt160 second, UInt160 fixture) : IDiagnostic
{
    private ApplicationEngine engine = null!;
    private Ctx? rootPost;
    private bool pendingFixtureWrite;
    internal bool FixtureWriteObserved;
    internal int SerializeCalls, DeserializeCalls, FirstPostEntries, SecondPostEntries;
    public void Initialized(ApplicationEngine value) => engine = value;
    public void Disposed() { }
    public void CallFromNative(UInt160 target, string method, StackItem[] arguments) { }
    public void ContextLoaded(Ctx context)
    {
        UInt160 hash = context.GetScriptHash();
        var contract = NativeContract.ContractManagement.GetContract(engine.SnapshotCache, hash);
        string? method = contract?.Manifest.Abi.Methods.FirstOrDefault(value => value.Offset == context.InstructionPointer)?.Name;
        if (hash == root && method == "postExecuteComposite") rootPost = context;
        if (method == "postExecute")
        {
            if (hash == first) FirstPostEntries++;
            if (hash == second) SecondPostEntries++;
        }
    }
    public void ContextUnloaded(Ctx context) { if (ReferenceEquals(context, rootPost)) rootPost = null; }
    public void PreExecuteInstruction(Instruction instruction)
    {
        pendingFixtureWrite = engine.CurrentScriptHash == fixture && instruction.OpCode == OpCode.SYSCALL
            && instruction.TokenU32 == ApplicationEngine.System_Storage_Put.Hash;
        if (rootPost is null || engine.CurrentScriptHash != root || instruction.OpCode != OpCode.CALLT) return;
        var contract = NativeContract.ContractManagement.GetContract(engine.SnapshotCache, root)!;
        var token = contract.Nef.Tokens[instruction.TokenU16];
        if (token.Hash != NativeContract.StdLib.Hash) return;
        if (token.Method == "serialize") SerializeCalls++;
        if (token.Method == "deserialize") DeserializeCalls++;
    }
    public void PostExecuteInstruction(Instruction instruction)
    {
        if (!pendingFixtureWrite) return;
        var contract = NativeContract.ContractManagement.GetContract(engine.SnapshotCache, fixture)!;
        FixtureWriteObserved |= engine.SnapshotCache.TryGet(new StorageKey { Id = contract.Id, Key = new byte[] { 0xfe } }) is not null;
        pendingFixtureWrite = false;
    }
}
