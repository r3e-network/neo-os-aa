using System.Numerics;
using System.Reflection;
using System.Security.Cryptography;
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

/// <summary>
/// Read-only diagnostic bridge for actual raw picoGAS instruction charges.
/// Original full NEF/helper/initializer and native implementation remain unchanged.
/// Private helper entry uses a synthetic descriptor; pure entries use original ABI.
/// Trace deltas include all charges between instruction pre/post callbacks, but do
/// not expose each internal AddFee call. This is finite evidence, not a gas-bound
/// theorem for arbitrary inputs or policy configuration. See SA-METHOD-REFINEMENT.md
/// ("ApplicationEngine fee semantics").
/// </summary>
[TestClass]
public class ImplementationRefinementGasRuntimeTests
{
    private const long HostingGas = 100_00000000;
    private const int HelperEntry = 18900, HelperEnd = 19181, InitializeEntry = 29996;
    private sealed record Charge(int Sequence, string ScriptHash, int Pc, string OpCode, string InstructionHex,
        string Method, string BeforePico, string AfterPico, string OpcodePico, string AdditionalPico, bool Completed,
        string? StorageKeyHex = null, int? StorageValueLength = null);
    private sealed record Result(bool Fault, long Datoshi, BigInteger RawPico, IReadOnlyList<Charge> Trace, UInt160 Core,
        StackItem? Value, uint StoragePrice, BigInteger ExecPico, string? Error);

    [TestMethod]
    [DataRow("absent")]
    [DataRow("same")]
    [DataRow("reset")]
    [DataRow("exhausted")]
    [DataRow("zero")]
    public void ActualCompleteHelperHasContiguousRawFeeAccounting(string shape)
    {
        Result r = RunHelper(shape);
        ValidateAccounting(r);
        var helper = r.Trace.Where(c => c.ScriptHash == r.Core.ToString() && c.Pc >= HelperEntry && c.Pc < HelperEnd).ToArray();
        Assert.IsTrue(helper.Length > 40);
        Assert.AreEqual(HelperEntry, helper[0].Pc);
        Assert.IsTrue(r.Trace.Any(c => c.ScriptHash == r.Core.ToString() && c.Pc == InitializeEntry));
        Assert.AreEqual(shape == "exhausted", r.Fault, r.Error);
        if (r.Fault)
        {
            Assert.AreEqual(19076, helper[^1].Pc);
            Assert.IsFalse(helper[^1].Completed);
            Assert.IsFalse(helper.Any(c => c.Pc == 19172));
        }
        else
        {
            Assert.AreEqual(19180, helper[^1].Pc);
            Assert.IsTrue(helper.Any(c => c.Pc == 19172 && c.Completed));
            Assert.AreEqual(new BigInteger(shape == "same" ? 6 : 7), r.Value!.GetInteger());
        }
        bool deserialize = r.Trace.Any(c => c.ScriptHash == NativeContract.StdLib.Hash.ToString() && c.Method == "deserialize");
        Assert.AreEqual(shape != "absent", deserialize);
        // Native codec fees are charged in its actual native SYSCALL frame,
        // not necessarily at the original core CALLT instruction.
        foreach (Charge native in r.Trace.Where(c => c.ScriptHash == NativeContract.StdLib.Hash.ToString() && c.OpCode == "SYSCALL"))
        {
            long cpu = NativeCpuPrice(native.Method);
            Assert.AreEqual((cpu * r.ExecPico).ToString(), native.AdditionalPico);
        }
        foreach (Charge syscall in helper.Where(c => c.OpCode == "SYSCALL" && c.Completed))
        {
            uint hash = System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(Convert.FromHexString(syscall.InstructionHex).AsSpan(1));
            InteropDescriptor descriptor = ApplicationEngine.Services[hash];
            BigInteger expectedFee = descriptor.FixedPrice * r.ExecPico;
            if (syscall.Pc == 19172)
            {
                // Actual value is a 39-byte canonical ledger. The new key is
                // one byte; same-length overwrite charges ceil(39/4)=10 bytes.
                Assert.AreEqual("21", syscall.StorageKeyHex);
                Assert.AreEqual(39, syscall.StorageValueLength);
                long billedBytes = shape == "absent"
                    ? Convert.FromHexString(syscall.StorageKeyHex!).Length + syscall.StorageValueLength!.Value
                    : (syscall.StorageValueLength!.Value - 1) / 4 + 1;
                expectedFee += billedBytes * r.StoragePrice * ApplicationEngine.FeeFactor;
            }
            Assert.AreEqual(expectedFee.ToString(), syscall.AdditionalPico, descriptor.Name);
        }
        WriteReceipt("helper-" + shape, r);
    }

    [TestMethod]
    [DataRow("getAccountImplementationId", "", "id")]
    [DataRow("supportsExecutionMode", "batch-atomic", "true")]
    [DataRow("supportsModuleType", "hook", "true")]
    public void ActualPublicPureMethodsAndInitializerUseRawOpcodePrices(string method, string argument, string expected)
    {
        Result r = RunPublic(method, argument);
        Assert.IsFalse(r.Fault, r.Error);
        ValidateAccounting(r);
        Assert.IsTrue(r.Trace.Any(c => c.ScriptHash == r.Core.ToString() && c.Method == "_initialize"));
        Charge[] pure = r.Trace.Where(c => c.ScriptHash == r.Core.ToString() && c.Method == method).ToArray();
        Assert.IsTrue(pure.Length >= 2);
        Assert.IsTrue(pure.All(c => c.AdditionalPico == "0"), "Pure body must have no hidden native/syscall charge");
        if (expected == "true") Assert.IsTrue(r.Value!.GetBoolean());
        else Assert.AreEqual("org.r3e.neo.smart-account.v3", System.Text.Encoding.UTF8.GetString(r.Value!.GetSpan()));
        WriteReceipt("public-" + method, r);
    }

    [TestMethod]
    public void ActualBudgetAtMeasuredCeilingHaltsAndOneDatoshiLessFaults()
    {
        Result baseline = RunHelper("absent");
        Result exact = RunHelper("absent", baseline.Datoshi);
        Assert.IsFalse(exact.Fault, exact.Error);
        Assert.AreEqual(baseline.RawPico, exact.RawPico);
        Result exhausted = RunHelper("absent", baseline.Datoshi - 1);
        Assert.IsTrue(exhausted.Fault);
        StringAssert.Contains(exhausted.Error!, "Insufficient GAS");
        ValidateAccounting(exhausted);
        Assert.IsFalse(exhausted.Trace[^1].Completed);
        Assert.IsTrue(exhausted.RawPico > (baseline.Datoshi - 1) * ApplicationEngine.FeeFactor);
        WriteReceipt("helper-exact-budget", exact);
        WriteReceipt("helper-insufficient-budget", exhausted);
    }

    private static void ValidateAccounting(Result result)
    {
        Assert.IsTrue(result.Trace.Count > 0);
        BigInteger prior = 0;
        foreach (Charge c in result.Trace)
        {
            BigInteger before = BigInteger.Parse(c.BeforePico), after = BigInteger.Parse(c.AfterPico);
            Assert.AreEqual(prior, before, $"Unobserved charge before {c.ScriptHash}@{c.Pc}");
            Assert.IsTrue(after >= before);
            Assert.AreEqual(after - before, BigInteger.Parse(c.OpcodePico) + BigInteger.Parse(c.AdditionalPico));
            if (c.Completed && c.OpCode is not ("CALLT" or "SYSCALL")) Assert.AreEqual("0", c.AdditionalPico,
                "Non-call opcode must match actual OpCodePriceTable times actual exec factor");
            prior = after;
        }
        Assert.AreEqual(result.RawPico, prior);
        Assert.AreEqual((long)((result.RawPico + ApplicationEngine.FeeFactor - 1) / ApplicationEngine.FeeFactor), result.Datoshi);
    }
    private static void WriteReceipt(string name, Result r) => File.WriteAllText(
        Path.Combine(Path.GetTempPath(), "sa-gas-runtime-" + name + ".json"),
        System.Text.Json.JsonSerializer.Serialize(new
        {
            scope = "actual-pinned-AE-instruction-fee-observation",
            name,
            artifacts = new
            {
                nefSha256 = "9f714866c5ba1b6cf31d63036d9805d73058055f325fd412e303356534ba2f76",
                manifestSha256 = "a6533d47d4a72c3c8159923ce54cb136ab02acb0e9a8c5f24cf75bd4ea838e31"
            },
            runtime = new { neo = RuntimeIdentity(typeof(ApplicationEngine)), vm = RuntimeIdentity(typeof(ExecutionEngine)) },
            priceTable = ApplicationEngine.OpCodePriceTable,
            nativeCpuPrices = new { serialize = NativeCpuPrice("serialize"), deserialize = NativeCpuPrice("deserialize") },
            syscallMetadata = ApplicationEngine.Services.Values.OrderBy(d => d.Name).Select(d => new
            { d.Name, d.Hash, d.FixedPrice, requiredCallFlags = d.RequiredCallFlags.ToString() }),
            feeFactor = ApplicationEngine.FeeFactor.ToString(),
            execPicoFactor = r.ExecPico.ToString(),
            storagePriceDatoshi = r.StoragePrice,
            feeConsumedDatoshi = r.Datoshi,
            rawConsumedPico = r.RawPico.ToString(),
            fault = r.Fault,
            error = r.Error,
            trace = r.Trace
        }, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    private static long NativeCpuPrice(string method)
    {
        string clrName = method switch { "serialize" => "Serialize", "deserialize" => "Deserialize", _ => throw new ArgumentException(method) };
        MethodInfo body = NativeContract.StdLib.GetType().GetMethod(clrName, BindingFlags.NonPublic | BindingFlags.Static)!;
        object attribute = body.GetCustomAttributes(false).Single(a => a.GetType().Name == "ContractMethodAttribute");
        return (long)attribute.GetType().GetProperty("CpuFee")!.GetValue(attribute)!;
    }
    private static Result RunHelper(string shape, long gas = HostingGas) => Run(shape, null, null, gas);
    private static Result RunPublic(string method, string argument) => Run(null, method, argument, HostingGas);
    private static readonly FieldInfo ConsumedField = typeof(ApplicationEngine).GetField("_feeConsumed", BindingFlags.NonPublic | BindingFlags.Instance)!;
    private static readonly FieldInfo ExecField = typeof(ApplicationEngine).GetField("_execFeeFactor", BindingFlags.NonPublic | BindingFlags.Instance)!;
    private static readonly FieldInfo StoragePriceField = typeof(ApplicationEngine).GetField("StoragePrice", BindingFlags.NonPublic | BindingFlags.Instance)!;
    private static BigInteger Raw(ApplicationEngine app) => (BigInteger)ConsumedField.GetValue(app)!;
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static object RuntimeIdentity(Type type) => new
    {
        name = type.Assembly.FullName,
        informationalVersion = type.Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion,
        sha256 = Hash(File.ReadAllBytes(type.Assembly.Location))
    };
    private sealed class Inspector(UInt160 core, ContractState coreState, ContractState stdlib) : IDiagnostic
    {
        private ApplicationEngine app = null!;
        private readonly List<Charge> rows = [];
        private Charge? active;
        public IReadOnlyList<Charge> Trace => rows;
        public void Initialized(ApplicationEngine engine) => app = engine;
        public void Disposed() { }
        public void ContextLoaded(Neo.VM.ExecutionContext context) { }
        public void ContextUnloaded(Neo.VM.ExecutionContext context) { }
        public void CallFromNative(UInt160 hash, string method, StackItem[] args) { }
        private string Method(UInt160 scriptHash, int pc)
        {
            if (scriptHash == core && pc >= HelperEntry && pc < HelperEnd) return "CapReimbursementToActualCost";
            ContractState? contract = scriptHash == core ? coreState : scriptHash == NativeContract.StdLib.Hash ? stdlib : null;
            return contract?.Manifest.Abi.Methods.Where(m => m.Offset <= pc).OrderByDescending(m => m.Offset).FirstOrDefault()?.Name ?? "entry-script";
        }
        public void PreExecuteInstruction(Instruction instruction)
        {
            Assert.IsNull(active, "Unexpected nested interpreter step invalidates simple pre/post interval accounting");
            var context = app.CurrentContext!;
            UInt160 hash = app.CurrentScriptHash!;
            int pc = context.InstructionPointer;
            BigInteger opcode = (BigInteger)ExecField.GetValue(app)! * ApplicationEngine.OpCodePriceTable[(byte)instruction.OpCode];
            active = new Charge(rows.Count, hash.ToString(), pc, instruction.OpCode.ToString(),
                Convert.ToHexString(Enumerable.Range(pc, instruction.Size).Select(i => (byte)context.Script[i]).ToArray()).ToLowerInvariant(),
                Method(hash, pc), Raw(app).ToString(), "", opcode.ToString(), "", false);
            if (hash == core && pc == 19172)
            {
                // Read the actual outgoing native Storage.Put arguments; never
                // mutate the stack, contract state, fee amount or fee counter.
                active = active with
                {
                    StorageKeyHex = Convert.ToHexString(context.EvaluationStack.Peek(1).GetSpan()).ToLowerInvariant(),
                    StorageValueLength = context.EvaluationStack.Peek(2).GetSpan().Length
                };
            }
        }
        public void PostExecuteInstruction(Instruction instruction) => Finish(true);
        public void Finish(bool completed)
        {
            if (active is null) return;
            BigInteger after = Raw(app);
            rows.Add(active with
            {
                AfterPico = after.ToString(),
                AdditionalPico = (after - BigInteger.Parse(active.BeforePico) - BigInteger.Parse(active.OpcodePico)).ToString(),
                Completed = completed
            });
            active = null;
        }
    }
    private static Result Run(string? shape, string? publicMethod, string? argument, long gas)
    {
        string dir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../contracts/bin/v3"));
        byte[] rawNef = File.ReadAllBytes(Path.Combine(dir, "SmartAccount.nef"));
        byte[] rawManifest = File.ReadAllBytes(Path.Combine(dir, "SmartAccount.manifest.json"));
        Assert.AreEqual("9f714866c5ba1b6cf31d63036d9805d73058055f325fd412e303356534ba2f76", Hash(rawNef));
        Assert.AreEqual("a6533d47d4a72c3c8159923ce54cb136ab02acb0e9a8c5f24cf75bd4ea838e31", Hash(rawManifest));
        Assert.AreEqual("cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a", Hash(File.ReadAllBytes(typeof(ApplicationEngine).Assembly.Location)));
        Assert.AreEqual("cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9", Hash(File.ReadAllBytes(typeof(ExecutionEngine).Assembly.Location)));
        RuntimeFixture fx = new();
        UInt160 hash = fx.DeployArtifact(rawNef, System.Text.Encoding.UTF8.GetString(rawManifest));
        ContractState core = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, hash)!;
        ContractState stdlib = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, NativeContract.StdLib.Hash)!;
        using ScriptBuilder script = new();
        if (publicMethod is not null)
        {
            if (publicMethod == "getAccountImplementationId") script.EmitDynamicCall(hash, publicMethod, CallFlags.ReadOnly);
            else script.EmitDynamicCall(hash, publicMethod, CallFlags.ReadOnly, argument!);
        }
        script.Emit(OpCode.RET);
        fx.Engine.Transaction.SystemFee = shape == "zero" ? 0 : 7;
        fx.Engine.Transaction.NetworkFee = shape == "zero" ? 0 : 3;
        fx.Engine.Transaction.Script = script.ToArray();
        if (shape is not (null or "absent"))
        {
            byte[] txHash = fx.Engine.Transaction.Hash.ToArray();
            if (shape == "reset") txHash[0] ^= 1;
            BigInteger reserved = shape == "exhausted" ? 10 : 4;
            StorageKey key = new() { Id = core.Id, Key = new byte[] { 0x21 } };
            fx.Engine.Storage.Snapshot.Add(key, new StorageItem(BinarySerializer.Serialize(
                new VmArray(new StackItem[] { new ByteString(txHash), new Integer(reserved) }), ExecutionEngineLimits.Default)));
        }
        DataCache transaction = fx.Engine.Storage.Snapshot.CloneCache();
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
        Inspector inspector = new(hash, core, stdlib);
        using ApplicationEngine app = ApplicationEngine.Create(TriggerType.Application, fx.Engine.Transaction,
            transaction, block, fx.Engine.ProtocolSettings, gas, inspector);
        Assert.AreEqual(typeof(ApplicationEngine), app.GetType());
        Assert.AreEqual(new Version(3, 10, 1, 0), typeof(ApplicationEngine).Assembly.GetName().Version);
        Assert.AreEqual(new Version(3, 10, 1, 0), typeof(ExecutionEngine).Assembly.GetName().Version);
        app.LoadScript(new Script(script.ToArray()));
        if (shape is not null)
        {
            var context = app.LoadContract(core, new ContractMethodDescriptor
            {
                Name = "refinement_private_cap",
                Offset = HelperEntry,
                Safe = false,
                Parameters = [new ContractParameterDefinition { Name = "requested", Type = ContractParameterType.Integer }],
                ReturnType = ContractParameterType.Integer
            }, CallFlags.All);
            context.EvaluationStack.Push(new Integer(7));
        }
        VMState state = app.Execute();
        inspector.Finish(false);
        bool fault = state.HasFlag(VMState.FAULT);
        if (!fault) Assert.AreEqual(VMState.HALT, state);
        // No commit: this lane observes execution and fees, not block persistence.
        return new Result(fault, app.FeeConsumed, Raw(app), inspector.Trace, hash,
            fault ? null : app.ResultStack.Pop(), (uint)StoragePriceField.GetValue(app)!,
            (BigInteger)ExecField.GetValue(app)!, app.FaultException?.Message);
    }
}
