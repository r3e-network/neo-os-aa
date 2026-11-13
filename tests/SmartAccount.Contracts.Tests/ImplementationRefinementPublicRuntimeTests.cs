using System.Numerics;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;
using VmArray = Neo.VM.Types.Array;

namespace SmartAccount.Contracts.Tests;

/// <summary>Original public ABI and native runtime evidence; not a universal proof.</summary>
[TestClass]
public class ImplementationRefinementPublicRuntimeTests
{
    private const long Gas = 100_000_000;
    private const long HostGas = 100 * Gas;
    private static readonly UInt160 Sponsor = UInt160.Parse("0x7777777777777777777777777777777777777777");
    private static readonly UInt160 Relay = UInt160.Parse("0x8888888888888888888888888888888888888888");
    private static readonly UInt160 Owner = UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");
    private static readonly UInt160 Recipient = UInt160.Parse("0x4444444444444444444444444444444444444444");
    private sealed record Observation(string Method, BigInteger Reserved, byte[] Hash, long GasConsumed);
    private sealed record RunResult(bool Fault, string? Error, byte[] Hash, byte[]? Committed, byte[]? Pending,
        IReadOnlyList<Observation> Observations, IReadOnlyList<NotifyEventArgs> Notifications);

    [TestMethod]
    public void NativeCodecExactWireVectors()
    {
        var vectors = new (string Number, string SignedBytes)[]
        {
            ("0", ""), ("1", "01"), ("127", "7f"), ("128", "8000"),
            ("-1", "ff"), ("-128", "80"), ("-129", "7fff"),
            (long.MaxValue.ToString(), "ffffffffffffff7f"),
            (((BigInteger.One << 255) - 1).ToString(), new string('f', 62) + "7f"),
            ((-(BigInteger.One << 255)).ToString(), new string('0', 62) + "80")
        };
        List<object> receipt = [];
        foreach (var v in vectors)
            foreach (bool structure in new[] { false, true })
            {
                string integer = "21" + (v.SignedBytes.Length / 2).ToString("x2") + v.SignedBytes;
                string expected = (structure ? "41" : "40") + "022820" + new string('0', 64) + integer;
                byte[] actual = NativeCodec(BigInteger.Parse(v.Number), structure);
                Assert.AreEqual(expected, Hex(actual));
                receipt.Add(new { shape = structure ? "Struct" : "Array", number = v.Number, wire = Hex(actual) });
            }
        foreach (var v in new[] { ("21020700", "210107"), ("2102ffff", "2101ff"), ("2100", "2100"), ("210100", "2100") })
        {
            byte[] actual = NativeCanonicalize(Convert.FromHexString(v.Item1));
            Assert.AreEqual(v.Item2, Hex(actual));
            receipt.Add(new { input = v.Item1, canonical = Hex(actual) });
        }
        string hash32 = new string('0', 64);
        string canonicalArray = "40022820" + hash32 + "210107";
        var framing = new (string Name, string Input, string Canonical)[]
        {
            ("Buffer hash preserves tag", "40023020" + hash32 + "210107", "40023020" + hash32 + "210107"),
            ("Struct Buffer hash", "41023020" + hash32 + "210107", "41023020" + hash32 + "210107"),
            ("Array count uint16", "40fd02002820" + hash32 + "210107", canonicalArray),
            ("Array count uint32", "40fe020000002820" + hash32 + "210107", canonicalArray),
            ("Array count uint64", "40ff02000000000000002820" + hash32 + "210107", canonicalArray),
            ("Hash length uint16", "400228fd2000" + hash32 + "210107", canonicalArray),
            ("Integer length uint16", "40022820" + hash32 + "21fd010007", canonicalArray),
            ("Positive integer padding", "40022820" + hash32 + "21020700", canonicalArray),
            ("Trailing bytes are ignored", canonicalArray + "deadbeef", canonicalArray)
        };
        foreach (var v in framing)
        {
            byte[] actual = NativeCanonicalize(Convert.FromHexString(v.Input));
            Assert.AreEqual(v.Canonical, Hex(actual), v.Name);
            receipt.Add(new { name = v.Name, input = v.Input, canonical = Hex(actual) });
        }
        File.WriteAllText(Path.Combine(Path.GetTempPath(), "aa-public-native-codec-vectors.json"),
            System.Text.Json.JsonSerializer.Serialize(new { runtime = Identity(), vectors = receipt }, new JsonSerializerOptions { WriteIndented = true }));
    }

    [TestMethod]
    public void SingleReservesBeforeDiscoveryAndTargetAndSettlesRealGas()
    {
        Harness h = new();
        RunResult r = h.Run([(false, h.Account, h.Transfer(0), 3 * Gas)]);
        Assert.IsFalse(r.Fault, r.Error);
        AssertObservations(r, 3 * Gas, 3 * Gas, 3 * Gas);
        h.CheckCommitted(r, 3 * Gas, 1);
    }

    [TestMethod]
    public void SingleThenBatchShareOneTransactionBudgetAndAdvanceAllNonces()
    {
        Harness h = new();
        RunResult r = h.Run([(false, h.Account, h.Transfer(0), 3 * Gas),
            (true, h.Account, new object[] { h.Transfer(1), h.Transfer(2) }, 3 * Gas)]);
        Assert.IsFalse(r.Fault, r.Error);
        AssertDiscovery(r, 3 * Gas, 5 * Gas);
        h.CheckCommitted(r, 5 * Gas, 3);
    }

    [TestMethod]
    public void DifferentAccountNestedPublicCallCannotReimburseOneFeeTwice()
    {
        Harness h = new();
        UInt160 second = h.SecondAccount();
        UInt160 callback = h.Callback(second, h.Transfer(0, second), 3 * Gas);
        RunResult r = h.Run([(false, h.Account, h.CallbackOp(callback), 3 * Gas)]);
        Assert.IsFalse(r.Fault, r.Error);
        AssertDiscovery(r, 3 * Gas, 5 * Gas);
        h.CheckCommitted(r, 5 * Gas, 1);
        Assert.AreEqual(BigInteger.One, h.Nonce(second));
        CollectionAssert.AreEqual(new BigInteger[] { 2 * Gas, 3 * Gas }, r.Notifications
            .Where(n => n.EventName == "SponsoredUserOpExecuted").Select(n => n.State[^1].GetInteger()).ToArray());
    }

    [TestMethod]
    public void SameAccountNestedPublicCallFaultsActualLockAndDiscardsReservations()
    {
        Harness h = new();
        UInt160 callback = h.Callback(h.Account, h.Transfer(1), 3 * Gas);
        RunResult r = h.Run([(false, h.Account, h.CallbackOp(callback), 3 * Gas)]);
        Assert.IsTrue(r.Fault);
        StringAssert.Contains(r.Error!, "Reentrant call rejected");
        AssertDiscovery(r, 3 * Gas, 5 * Gas);
        h.CheckUnchanged(r);
        Assert.IsNull(r.Pending, "Faulted first contract frame must not commit to its parent");
    }

    [TestMethod]
    [DataRow("cap")]
    [DataRow("nonce")]
    [DataRow("settlement")]
    [DataRow("parent")]
    public void LaterFaultDiscardsSuccessfulEarlierPublicCall(string fault)
    {
        Harness h = new();
        var calls = new List<(bool, UInt160, object[], long)> { (false, h.Account, h.Transfer(0), 3 * Gas) };
        if (fault != "parent") calls.Add((false, h.Account, h.Transfer(fault == "nonce" ? 7 : 1),
            fault == "cap" ? 3 * Gas : Gas));
        if (fault == "settlement") h.RestrictPolicy(3 * Gas);
        RunResult r = h.Run(calls.ToArray(), outerAbort: fault == "parent", systemFee: fault == "cap" ? 2 * Gas : 4 * Gas);
        Assert.IsTrue(r.Fault);
        StringAssert.Contains(r.Error!, fault switch
        {
            "cap" => "Reimbursement exceeds actual gas cost",
            "nonce" => "Invalid sequence for channel",
            "settlement" => "Total budget exceeded",
            _ => "public refinement outer abort"
        });
        h.CheckUnchanged(r);
        Assert.IsNotNull(r.Pending, "First HALT child writes exist in the discarded outer application snapshot");
        CheckLedger(r.Pending, r.Hash, 3 * Gas);
    }

    [TestMethod]
    public void ReadOnlyPublicInvocationCannotReserveAndNoCallbackRuns()
    {
        Harness h = new();
        RunResult r = h.Run([(false, h.Account, h.Transfer(0), Gas)], flags: CallFlags.ReadOnly);
        Assert.IsTrue(r.Fault);
        Assert.AreEqual(0, r.Observations.Count);
        h.CheckUnchanged(r);
    }

    [TestMethod]
    public void InsufficientHostingGasFaultsWithoutCommittingPublicState()
    {
        Harness h = new();
        RunResult r = h.Run([(false, h.Account, h.Transfer(0), Gas)], gas: 1);
        Assert.IsTrue(r.Fault);
        Assert.AreEqual(0, r.Observations.Count);
        h.CheckUnchanged(r);
    }

    [TestMethod]
    public void ZeroFeeRpcPublicExecutionSettlesEachRequestedQuote()
    {
        Harness h = new();
        RunResult r = h.Run([(false, h.Account, h.Transfer(0), 3 * Gas),
            (false, h.Account, h.Transfer(1), 3 * Gas)], systemFee: 0, networkFee: 0);
        Assert.IsFalse(r.Fault, r.Error);
        AssertDiscovery(r, 3 * Gas, 6 * Gas);
        h.CheckCommitted(r, 6 * Gas, 2);
    }

    private static void AssertDiscovery(RunResult r, params long[] reserved) =>
        CollectionAssert.AreEqual(reserved.Select(v => (BigInteger)v).ToArray(), r.Observations
            .Where(o => o.Method == "authorizedCore").Select(o => o.Reserved).ToArray());
    private static void AssertObservations(RunResult r, params long[] reserved) =>
        CollectionAssert.AreEqual(reserved.Select(v => (BigInteger)v).ToArray(), r.Observations.Select(o => o.Reserved).ToArray());
    private static void CheckLedger(byte[]? raw, byte[] hash, BigInteger reserved)
    {
        Assert.IsNotNull(raw);
        VmArray row = (VmArray)BinarySerializer.Deserialize(raw!, ExecutionEngineLimits.Default);
        CollectionAssert.AreEqual(hash, row[0].GetSpan().ToArray());
        Assert.AreEqual(reserved, row[1].GetInteger());
    }
    private static string Hex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();
    private static object AssemblyIdentity(Type type) => new
    {
        fullName = type.Assembly.FullName,
        informationalVersion = type.Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
            .Cast<System.Reflection.AssemblyInformationalVersionAttribute>().Single().InformationalVersion,
        sha256 = Hex(SHA256.HashData(File.ReadAllBytes(type.Assembly.Location)))
    };
    private static object Identity() => new
    {
        neo = AssemblyIdentity(typeof(ApplicationEngine)),
        vm = AssemblyIdentity(typeof(ExecutionEngine)),
        neoSourceCommit = "d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d",
        vmSourceCommit = "004cd6070a940405818d9357638277dd44407e2e"
    };
    private static byte[] NativeCodec(BigInteger value, bool structure)
    {
        using ScriptBuilder script = new();
        script.EmitPush(value);
        script.EmitPush(new byte[32]);
        script.EmitPush(2);
        script.Emit(OpCode.PACK);
        if (structure) script.Emit(OpCode.CONVERT, new byte[] { (byte)StackItemType.Struct });
        NativeCallTop(script, "serialize");
        return ExecuteNative(script.ToArray());
    }
    private static byte[] NativeCanonicalize(byte[] wire)
    {
        using ScriptBuilder script = new();
        script.EmitPush(wire);
        NativeCallTop(script, "deserialize");
        NativeCallTop(script, "serialize");
        return ExecuteNative(script.ToArray());
    }
    private static void NativeCallTop(ScriptBuilder script, string method)
    {
        script.EmitPush(1);
        script.Emit(OpCode.PACK);
        script.EmitPush((BigInteger)(int)CallFlags.ReadOnly);
        script.EmitPush(method);
        script.EmitPush(NativeContract.StdLib.Hash.ToArray());
        script.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
    }
    private static byte[] ExecuteNative(byte[] script)
    {
        RuntimeFixture fx = new();
        fx.Engine.Transaction.Script = script;
        using ApplicationEngine app = CreateEngine(fx, fx.Engine.Storage.Snapshot.CloneCache(), HostGas);
        app.LoadScript(new Script(script));
        Assert.AreEqual(VMState.HALT, app.Execute(), app.FaultException?.Message);
        return app.ResultStack.Pop().GetSpan().ToArray();
    }
    private static ApplicationEngine CreateEngine(RuntimeFixture fx, DataCache snapshot, long gas, IDiagnostic? diagnostic = null)
    {
        Block block = new()
        {
            Header = new Header
            {
                Index = fx.Engine.PersistingBlock.Index,
                Timestamp = (ulong)fx.Engine.PersistingBlock.Timestamp.TotalMilliseconds,
                Nonce = fx.Engine.PersistingBlock.Nonce,
                PrevHash = UInt256.Zero,
                MerkleRoot = UInt256.Zero,
                NextConsensus = fx.Engine.ValidatorsAddress,
                Witness = new Witness { InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = ReadOnlyMemory<byte>.Empty }
            },
            Transactions = []
        };
        ApplicationEngine app = ApplicationEngine.Create(TriggerType.Application,
            fx.Engine.Transaction, snapshot, block, fx.Engine.ProtocolSettings, gas, diagnostic);
        Assert.AreEqual(typeof(ApplicationEngine), app.GetType());
        Assert.AreEqual(new Version(3, 10, 1, 0), typeof(ApplicationEngine).Assembly.GetName().Version);
        Assert.AreEqual(new Version(3, 10, 1, 0), typeof(ExecutionEngine).Assembly.GetName().Version);
        Assert.AreEqual("cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a",
            Hex(SHA256.HashData(File.ReadAllBytes(typeof(ApplicationEngine).Assembly.Location))));
        Assert.AreEqual("cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9",
            Hex(SHA256.HashData(File.ReadAllBytes(typeof(ExecutionEngine).Assembly.Location))));
        return app;
    }
    private static ContractParameter Parameter(object? value) => value switch
    {
        null => new ContractParameter(ContractParameterType.Any),
        BigInteger n => new ContractParameter(ContractParameterType.Integer) { Value = n },
        long n => new ContractParameter(ContractParameterType.Integer) { Value = (BigInteger)n },
        string v => new ContractParameter(ContractParameterType.String) { Value = v },
        byte[] v => new ContractParameter(ContractParameterType.ByteArray) { Value = v },
        UInt160 v => new ContractParameter(ContractParameterType.Hash160) { Value = v },
        object?[] v => new ContractParameter(ContractParameterType.Array) { Value = v.Select(Parameter).ToList() },
        _ => throw new ArgumentException($"Unsupported invocation value {value?.GetType()}")
    };
    private static void AppendCall(ScriptBuilder script, UInt160 target, string method, CallFlags flags, params object?[] args)
    {
        script.EmitPush(Parameter(args));
        script.EmitPush((BigInteger)(int)flags);
        script.EmitPush(method);
        script.EmitPush(target.ToArray());
        script.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
        script.Emit(OpCode.DROP);
    }
    private sealed class Observer(StorageKey key, Dictionary<UInt160, Dictionary<int, string>> entries) : IDiagnostic
    {
        private ApplicationEngine app = null!;
        public List<Observation> Observations { get; } = [];
        public void Initialized(ApplicationEngine engine) => app = engine;
        public void Disposed() { }
        public void ContextLoaded(Neo.VM.ExecutionContext context) { }
        public void ContextUnloaded(Neo.VM.ExecutionContext context) { }
        public void CallFromNative(UInt160 hash, string method, StackItem[] args) { }
        public void PostExecuteInstruction(Instruction instruction) { }
        public void PreExecuteInstruction(Instruction instruction)
        {
            var context = app.CurrentContext!;
            UInt160? hash = context.GetState<ExecutionContextState>().ScriptHash;
            if (hash is null || !entries.TryGetValue(hash, out var methods) ||
                !methods.TryGetValue(context.InstructionPointer, out string? method)) return;
            byte[]? raw = app.SnapshotCache.TryGet(key)?.Value.ToArray();
            Assert.IsNotNull(raw, "Actual reservation must already exist at the external callback entry");
            VmArray row = (VmArray)BinarySerializer.Deserialize(raw!, ExecutionEngineLimits.Default);
            Observations.Add(new Observation(method, row[1].GetInteger(), row[0].GetSpan().ToArray(), app.FeeConsumed));
        }
    }
    private sealed class Harness
    {
        private readonly RuntimeFixture fx = new();
        private readonly UInt160 core, target, paymaster;
        private readonly StorageKey budget;
        private readonly BigInteger deadline;
        private readonly BigInteger initialDeposit, initialRelay;
        private readonly Dictionary<UInt160, Dictionary<int, string>> entries = [];
        public UInt160 Account { get; }
        public Harness()
        {
            VerifyArtifact("SmartAccountV3", "8faca1113b8b2e7386643b3086be372e15f67651e462c04e96dea49c16a18d28",
                "2cabbdb72bb8be1f4062ff41ba3ecb1fe8a2a4f88c94d48d1efe1db4fcb9ae3c");
            VerifyArtifact("AAPaymaster", "07e6ad3983aa4f3e7d3ead0effd789edf8fcb7063a501c76365506a6b2492de1",
                "a066faf3ee31e9c1e716bf26f0ccfab74f1c9639adacb1adab0502b20918ca54");
            VerifyArtifact("MockTransferTarget", "97d853d1f076abda4a1d6e44aa88ebdca01d390594a77ae03df2e164a7e181c0",
                "3760aefced22c045b98414368e4c3eac5a6d9dc866a1b6f017c49c01518d401c");
            core = fx.Deploy("SmartAccountV3");
            target = fx.Deploy("MockTransferTarget");
            paymaster = fx.Deploy("AAPaymaster", core.ToArray());
            ContractState state = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, core)!;
            budget = new StorageKey { Id = state.Id, Key = new byte[] { 0x21 } };
            Account = Register(2_592_000);
            fx.FundGasFromValidators(Sponsor, 100 * Gas);
            fx.SetSigners(Sponsor);
            fx.TransferGas(Sponsor, paymaster, 50 * Gas, null);
            Policy(Account, 50 * Gas);
            initialDeposit = Deposit(); initialRelay = fx.GasBalanceOf(Relay);
            deadline = fx.Now() + 3_600_000;
            Observe(paymaster, "authorizedCore", "settleReimbursement");
            Observe(target, "transfer");
        }
        private static void VerifyArtifact(string name, string nef, string manifest)
        {
            string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../contracts/bin/v3"));
            Assert.AreEqual(nef, Hex(SHA256.HashData(File.ReadAllBytes(Path.Combine(root, name + ".nef")))));
            Assert.AreEqual(manifest, Hex(SHA256.HashData(File.ReadAllBytes(Path.Combine(root, name + ".manifest.json")))));
        }
        private UInt160 Register(uint delay)
        {
            UInt160 account = fx.CallUInt160(core, "computeRegistrationAccountId", UInt160.Zero,
                System.Array.Empty<byte>(), UInt160.Zero, Owner, delay);
            fx.SetSigners(Owner);
            fx.CallVoid(core, "registerAccount", account, UInt160.Zero, System.Array.Empty<byte>(), UInt160.Zero, Owner, delay);
            return account;
        }
        private void Policy(UInt160 account, long total)
        {
            fx.SetSigners(Sponsor);
            fx.CallVoid(paymaster, "setPolicy", account, UInt160.Zero, "", (BigInteger)(50 * Gas),
                (BigInteger)(50 * Gas), (BigInteger)total, BigInteger.Zero);
        }
        public void RestrictPolicy(long total) => Policy(Account, total);
        public UInt160 SecondAccount()
        {
            UInt160 second = Register(2_592_001);
            Policy(second, 50 * Gas);
            return second;
        }
        public object[] Transfer(BigInteger nonce, UInt160? account = null) => RuntimeFixture.UserOp(target, "transfer",
            new object?[] { account ?? Account, Recipient, (BigInteger)1000, null }, nonce, deadline, System.Array.Empty<byte>());
        public object[] CallbackOp(UInt160 callback) => RuntimeFixture.UserOp(callback, "run", [], 0, deadline, System.Array.Empty<byte>());
        public UInt160 Callback(UInt160 account, object[] op, long request)
        {
            // This test-only adversary calls the unchanged public entry. There is
            // no synthetic core method or bypass of real account validation.
            using ScriptBuilder script = new();
            AppendCall(script, core, "executeSponsoredUserOp", CallFlags.All,
                account, op, paymaster, Sponsor, (BigInteger)request);
            script.EmitPush(true); script.Emit(OpCode.RET);
            NefFile nef = new() { Compiler = "Public refinement adversary", Source = "", Tokens = [], Script = script.ToArray() };
            nef.CheckSum = NefFile.ComputeChecksum(nef);
            ContractManifest manifest = new()
            {
                Name = "PublicRefinementAdversary",
                Groups = [],
                SupportedStandards = [],
                Permissions = [ContractPermission.DefaultPermission],
                Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
                Abi = new ContractAbi
                {
                    Methods = [new ContractMethodDescriptor { Name = "run", Offset = 0, Safe = false,
                        Parameters = [], ReturnType = ContractParameterType.Boolean }],
                    Events = []
                }
            };
            UInt160 callback = fx.DeployArtifact(nef.ToArray(), manifest.ToJson().ToString());
            Observe(callback, "run");
            return callback;
        }
        private void Observe(UInt160 hash, params string[] methods)
        {
            ContractState state = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, hash)!;
            entries[hash] = methods.ToDictionary(m => state.Manifest.Abi.GetMethod(m, -1)!.Offset, m => m);
        }
        private BigInteger Deposit() => fx.CallInteger(paymaster, "getSponsorDeposit", Sponsor);
        public BigInteger Nonce(UInt160 account) => fx.CallInteger(core, "getNonce", account, BigInteger.Zero);
        public void CheckCommitted(RunResult r, long reserved, int nonce)
        {
            CheckLedger(r.Committed, r.Hash, reserved);
            Assert.AreEqual((BigInteger)reserved, initialDeposit - Deposit());
            Assert.AreEqual((BigInteger)reserved, fx.GasBalanceOf(Relay) - initialRelay);
            Assert.AreEqual((BigInteger)nonce, Nonce(Account));
        }
        public void CheckUnchanged(RunResult r)
        {
            Assert.IsNull(r.Committed);
            Assert.AreEqual(initialDeposit, Deposit());
            Assert.AreEqual(initialRelay, fx.GasBalanceOf(Relay));
            Assert.AreEqual(BigInteger.Zero, Nonce(Account));
            Assert.AreEqual(BigInteger.Zero, fx.CallInteger(paymaster, "getTotalSpent", Sponsor, Account));
        }
        public RunResult Run((bool Batch, UInt160 Account, object[] Op, long Request)[] calls, bool outerAbort = false,
            long systemFee = 4 * Gas, long networkFee = Gas, CallFlags flags = CallFlags.All, long gas = HostGas)
        {
            using ScriptBuilder script = new();
            foreach (var call in calls) AppendCall(script, core,
                call.Batch ? "executeSponsoredUserOps" : "executeSponsoredUserOp", flags,
                call.Account, call.Op, paymaster, Sponsor, (BigInteger)call.Request);
            if (outerAbort) { script.EmitPush("public refinement outer abort"); script.Emit(OpCode.ABORTMSG); }
            else script.Emit(OpCode.RET);
            fx.SetSigners(Relay, Owner);
            fx.Engine.Transaction.SystemFee = systemFee;
            fx.Engine.Transaction.NetworkFee = networkFee;
            fx.Engine.Transaction.Script = script.ToArray();
            byte[] hash = fx.Engine.Transaction.Hash.ToArray();
            DataCache transaction = fx.Engine.Storage.Snapshot.CloneCache();
            Observer observer = new(budget, entries);
            using ApplicationEngine app = CreateEngine(fx, transaction, gas, observer);
            app.LoadScript(new Script(script.ToArray()));
            DataCache pending = app.SnapshotCache;
            VMState state = app.Execute();
            bool fault = state.HasFlag(VMState.FAULT);
            if (!fault) { Assert.AreEqual(VMState.HALT, state); transaction.Commit(); }
            foreach (var o in observer.Observations) CollectionAssert.AreEqual(hash, o.Hash,
                "Every callback must observe the same enclosing transaction identity");
            RunResult result = new(fault, app.FaultException?.Message, hash,
                fx.Engine.Storage.Snapshot.TryGet(budget)?.Value.ToArray(), pending.TryGet(budget)?.Value.ToArray(),
                observer.Observations, app.Notifications.ToArray());
            File.WriteAllText(Path.Combine(Path.GetTempPath(), "aa-public-run-" + Hex(hash) + "-" + flags + "-" + gas + ".json"),
                System.Text.Json.JsonSerializer.Serialize(new
                {
                    runtime = Identity(),
                    transactionHash = Hex(hash),
                    systemFee,
                    networkFee,
                    hostingGas = gas,
                    actualFeeConsumed = app.FeeConsumed,
                    callFlags = flags.ToString(),
                    vmState = state.ToString(),
                    error = result.Error,
                    committedLedger = result.Committed is null ? null : Hex(result.Committed),
                    pendingLedger = result.Pending is null ? null : Hex(result.Pending),
                    callbacks = result.Observations.Select(o => new
                    {
                        method = o.Method,
                        reserved = o.Reserved.ToString(),
                        transactionHash = Hex(o.Hash),
                        feeConsumed = o.GasConsumed
                    })
                }, new JsonSerializerOptions { WriteIndented = true }));
            return result;
        }
    }
}
