using System.Collections.Immutable;
using System.Numerics;
using System.Security.Cryptography;
using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.Persistence.Providers;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;

internal sealed class ProbeHarness : IDisposable
{
    internal static readonly UInt160 Custody = UInt160.Parse("0x0101010101010101010101010101010101010101");
    internal static UInt160 Core => NativeContract.AccountManagement.Hash;
    internal const ulong Delay = 86_400_000;
    internal static readonly string[] BalanceKinds = ["zero", "positive", "negative", "boolean", "bytes", "null", "array", "struct", "map", "buffer", "pointer", "interop"];
    internal ulong Time { get; set; } = 1000;
    internal ProtocolSettings Settings { get; } = ProtocolSettings.Default with
    {
        Network = 0x4E50524F,
        SeedList = [],
        // Public curve generator only; no signing key is loaded or used by this host probe.
        StandbyCommittee = [Neo.Cryptography.ECC.ECPoint.Parse("036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", Neo.Cryptography.ECC.ECCurve.Secp256r1)],
        ValidatorsCount = 1,
        Hardforks = Enum.GetValues<Hardfork>().ToImmutableDictionary(value => value, _ => 0u)
    };
    private readonly NeoSystem system;
    internal StoreCache Snapshot { get; }
    internal NefTrace? Trace { get; set; }
    private int hookId;
    internal List<object> Cases { get; } = [];

    internal ProbeHarness()
    {
        system = new NeoSystem(Settings, new MemoryStoreProvider());
        Snapshot = system.GetSnapshotCache();
    }

    internal static Block Block(ulong time) => new()
    {
        Header = new Header
        {
            Index = 1,
            Timestamp = time,
            PrevHash = UInt256.Zero,
            MerkleRoot = UInt256.Zero,
            NextConsensus = UInt160.Zero,
            Witness = new Witness { InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = ReadOnlyMemory<byte>.Empty }
        },
        Transactions = []
    };

    private static void Push(ScriptBuilder builder, object? value)
    {
        if (value is object[] values)
        {
            if (values.Length == 0) builder.Emit(OpCode.NEWARRAY0);
            else
            {
                for (int i = values.Length - 1; i >= 0; i--) Push(builder, values[i]);
                builder.EmitPush(values.Length).Emit(OpCode.PACK);
            }
        }
        else builder.EmitPush(value);
    }

    internal static Dictionary<string, string> Storage(DataCache snapshot) => snapshot.Find((byte[]?)null)
        .ToDictionary(pair => Convert.ToHexString(pair.Key.ToArray()), pair => Convert.ToHexString(pair.Value.Value.Span));

    internal StackItem Call(string label, UInt160 target, string method, object?[] args, string? fault = null, bool commit = true, UInt160[]? signers = null)
    {
        Dictionary<string, string> before = Storage(Snapshot);
        using ScriptBuilder builder = new();
        Push(builder, args);
        builder.EmitPush(CallFlags.All).EmitPush(method).EmitPush(target).EmitSysCall(ApplicationEngine.System_Contract_Call);
        Transaction transaction = new()
        {
            Script = builder.ToArray(),
            Signers = (signers ?? [Custody]).Select(account => new Signer { Account = account, Scopes = WitnessScope.Global }).ToArray(),
            Attributes = [],
            Witnesses = []
        };
        // Match Blockchain persistence: commit a per-transaction clone on HALT only.
        // A faulted execution may still expose staged writes in its current frame.
        DataCache transactionSnapshot = Snapshot.CloneCache();
        using var engine = ApplicationEngine.Create(TriggerType.Application, transaction, transactionSnapshot, Block(Time), Settings,
            gas: 10_000_000_000, diagnostic: Trace);
        engine.LoadScript(transaction.Script);
        VMState state = engine.Execute();
        ProbeTests.Require(state == (fault is null ? VMState.HALT : VMState.FAULT), label + ": " + engine.FaultException);
        if (fault is not null)
        {
            ProbeTests.Require(engine.FaultException!.ToString().Contains(fault, StringComparison.Ordinal), label + ": wrong FAULT: " + engine.FaultException);
            // FAULT discards the transaction clone; it does not erase every frame cache.
            ProbeTests.Require(before.OrderBy(x => x.Key).SequenceEqual(Storage(Snapshot).OrderBy(x => x.Key)), label + ": external storage changed");
        }
        else if (commit) transactionSnapshot.Commit();
        Cases.Add(new { label, vmState = state.ToString(), expectedFault = fault, wholeStoreRollbackChecked = fault is not null, gasConsumedDatoshi = engine.FeeConsumed });
        return state == VMState.HALT && engine.ResultStack.Count > 0 ? engine.ResultStack.Peek() : StackItem.Null;
    }

    internal UInt160 Deploy(string artifacts)
    {
        byte[] bytes = File.ReadAllBytes(Path.Combine(artifacts, "TokenRestrictedHook.nef"));
        string manifest = File.ReadAllText(Path.Combine(artifacts, "TokenRestrictedHook.manifest.json"));
        NefFile nef = NefFile.Parse(bytes, true);
        UInt160 expected = Neo.SmartContract.Helper.GetContractHash(Custody, nef.CheckSum, ContractManifest.Parse(manifest).Name);
        Trace = new NefTrace(expected, nef.Script);
        var value = (Neo.VM.Types.Array)Call("deploy-production-hook", NativeContract.ContractManagement.Hash, "deploy", [bytes, manifest, Core]);
        UInt160 hash = new(value[2].GetSpan());
        ProbeTests.Require(hash == expected, "Deployment identity differs from the traced contract.");
        ContractState state = NativeContract.ContractManagement.GetContract(Snapshot, hash)!;
        hookId = state.Id;
        ProbeTests.Require(state.Nef.ToArray().SequenceEqual(bytes), "Production NEF changed during deployment.");
        ProbeTests.Require(state.Manifest.ToJson().ToString() == ContractManifest.Parse(manifest).ToJson().ToString(), "Production manifest changed.");
        return hash;
    }

    internal UInt160 Register(UInt160 hook, byte salt) => new(Call("register-" + salt, Core, "registerAccount",
        [Custody, Enumerable.Repeat(salt, 32).ToArray(), UInt160.Zero, hook, UInt160.Zero]).GetSpan());

    internal void Configure(UInt160 account, UInt160 token, bool restricted)
    {
        object[] args = [account, "setRestrictedToken", new object[] { token, restricted }];
        StackItem proposal = Call("configuration-proposal", Core, "callHook", args);
        ProbeTests.Require(proposal.Type == StackItemType.Boolean && !proposal.GetBoolean(), "Configuration proposal must return exact Boolean false.");
        Time += Delay;
        ProbeTests.Require(Call("configuration-confirm", Core, "callHook", args).IsNull, "A Void configuration callback must return Null.");
        StorageKey key = Key(hookId, 1, account, token);
        ProbeTests.Require(restricted ? Snapshot[key].Value.Span.SequenceEqual(new byte[] { 1 }) : !Snapshot.Contains(key), "Delayed configuration storage mismatch.");
    }

    internal void Execute(UInt160 account, string label, string? fault = null)
    {
        BigInteger nonce = Call("read-nonce", Core, "getNonce", [account, BigInteger.Zero], commit: false).GetInteger();
        object[] operation = [NativeContract.StdLib.Hash, "serialize", new object[] { 7 }, nonce, new BigInteger(long.MaxValue), System.Array.Empty<byte>()];
        Call(label, Core, "executeUserOp", [account, operation], fault);
        BigInteger after = Call("read-nonce-after", Core, "getNonce", [account, BigInteger.Zero], commit: false).GetInteger();
        ProbeTests.Require(after == nonce + (fault is null ? 1 : 0), label + ": wrong nonce transition");
    }

    internal ContractState Token(string kind, int id)
    {
        using ScriptBuilder builder = new();
        builder.Emit(OpCode.DROP);
        EmitBalance(builder, kind);
        builder.Emit(OpCode.RET);
        return InstallToken(kind, id, builder.ToArray());
    }

    private static void EmitBalance(ScriptBuilder builder, string kind)
    {
        switch (kind)
        {
            case "zero": builder.EmitPush(BigInteger.Zero); break;
            case "positive": builder.EmitPush(new BigInteger(1000)); break;
            case "negative": builder.EmitPush(new BigInteger(-1)); break;
            case "boolean": builder.EmitPush(true); break;
            case "bytes": builder.EmitPush(new byte[] { 1 }); break;
            case "null": builder.Emit(OpCode.PUSHNULL); break;
            case "array": builder.Emit(OpCode.NEWARRAY0); break;
            case "struct": builder.Emit(OpCode.NEWSTRUCT0); break;
            case "map": builder.Emit(OpCode.NEWMAP); break;
            case "buffer": builder.EmitPush(1).Emit(OpCode.NEWBUFFER); break;
            case "pointer": builder.Emit(OpCode.PUSHA, BitConverter.GetBytes(5)); break;
            case "interop": builder.EmitSysCall(ApplicationEngine.System_Storage_GetReadOnlyContext); break;
            default: throw new ArgumentException("Unknown test token kind.", nameof(kind));
        }
    }

    internal ContractState ModeToken(int id)
    {
        using ScriptBuilder builder = new();
        builder.Emit(OpCode.DROP).EmitPush(new byte[] { 1 })
            .EmitSysCall(ApplicationEngine.System_Storage_GetReadOnlyContext)
            .EmitSysCall(ApplicationEngine.System_Storage_Get)
            .Emit(OpCode.CONVERT, new byte[] { (byte)StackItemType.Integer });
        List<int> jumps = [];
        for (int index = 0; index < BalanceKinds.Length; index++)
        {
            builder.Emit(OpCode.DUP).EmitPush(index);
            jumps.Add(builder.ToArray().Length);
            builder.Emit(OpCode.JMPEQ_L, new byte[4]);
        }
        builder.Emit(OpCode.DROP).Emit(OpCode.ABORT);
        List<int> entries = [];
        foreach (string kind in BalanceKinds)
        {
            entries.Add(builder.ToArray().Length);
            builder.Emit(OpCode.DROP);
            EmitBalance(builder, kind);
            builder.Emit(OpCode.RET);
        }
        byte[] script = builder.ToArray();
        for (int index = 0; index < jumps.Count; index++)
            System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(script.AsSpan(jumps[index] + 1, 4), entries[index] - jumps[index]);
        return InstallToken("mode", id, script);
    }

    internal static void SetMode(DataCache snapshot, ContractState token, int mode)
    {
        StorageKey key = new() { Id = token.Id, Key = new byte[] { 1 } };
        snapshot.Delete(key);
        snapshot.Add(key, new StorageItem(new BigInteger(mode)));
    }

    private ContractState InstallToken(string kind, int id, byte[] script)
    {
        NefFile nef = new() { Compiler = "NativeModuleProbe", Source = "", Tokens = [], Script = script };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        var manifest = new ContractManifest
        {
            Name = "DiagnosticBalance-" + kind,
            Groups = [],
            SupportedStandards = [],
            Permissions = [],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
            Abi = new ContractAbi
            {
                Methods = [new ContractMethodDescriptor
                {
                    Name = "balanceOf", Offset = 0, Safe = true, ReturnType = ContractParameterType.Any,
                    Parameters = [new ContractParameterDefinition { Name = "account", Type = ContractParameterType.Hash160 }]
                }],
                Events = []
            }
        };
        var token = new ContractState { Id = id, Hash = nef.Script.ToArray().ToScriptHash(), Nef = nef, Manifest = manifest };
        Snapshot.Add(new KeyBuilder(NativeContract.ContractManagement.Id, 8).Add(token.Hash), new StorageItem(token));
        Snapshot.Add(new KeyBuilder(NativeContract.ContractManagement.Id, 12).AddBigEndian(id), new StorageItem(token.Hash.ToArray()));
        return token;
    }

    internal void DeleteToken(ContractState token)
    {
        Snapshot.Delete(new KeyBuilder(NativeContract.ContractManagement.Id, 8).Add(token.Hash));
        Snapshot.Delete(new KeyBuilder(NativeContract.ContractManagement.Id, 12).AddBigEndian(token.Id));
    }

    internal static StorageKey Key(int id, byte prefix, UInt160 account, UInt160 token) => new()
    { Id = id, Key = new byte[] { prefix }.Concat(account.ToArray()).Concat(token.ToArray()).ToArray() };

    internal static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    public void Dispose() { Snapshot.Dispose(); system.Dispose(); }
}
