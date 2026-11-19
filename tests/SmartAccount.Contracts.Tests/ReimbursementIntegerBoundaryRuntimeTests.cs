using System.Numerics;
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

[TestClass]
public class ReimbursementIntegerBoundaryRuntimeTests
{
    private static readonly UInt160 Owner = UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");
    private static readonly UInt160 Relay = UInt160.Parse("0x8888888888888888888888888888888888888888");
    private static readonly BigInteger Maximum = (BigInteger.One << 255) - 1;

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public void ZeroFeePublicReservationClassifiesIntegerBoundary(bool addSecond)
    {
        RuntimeFixture fx = new();
        using P256SessionKey custodyKey = new();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 policy = DeployPolicy(fx, core);
        UInt160 custody = RuntimeFixture.CustodyOf(custodyKey);

        // v4 identity is custody‖salt and the account is created directly.
        // Registration seeds the message subject set with the custody address at
        // subjectRevision 1 (§8), so the owner-only built-in route authorizes
        // exactly one custody subject without installing a validator; adding a
        // setMessageSubjects action here would advance that revision and invalidate
        // the §8 signature envelope.
        UInt160 account = fx.CreateAccount(core, custody, "reimbursement-boundary");

        BigInteger deadline = fx.Now() + 3_600_000;
        BigInteger configurationNonce = fx.AccountConfigurationNonce(core, account);
        BigInteger nonce = fx.PackedNonce(core, account, 0);
        using ScriptBuilder script = new();
        AppendCall(fx, script, core, account, policy, deadline, nonce, Maximum,
            custodyKey, configurationNonce);
        if (addSecond)
        {
            AppendCall(fx, script, core, account, policy, deadline, nonce + 1, BigInteger.One,
                custodyKey, configurationNonce);
        }
        script.Emit(OpCode.RET);
        fx.SetSigners(Relay, custody);
        fx.Engine.Transaction.SystemFee = 0;
        fx.Engine.Transaction.NetworkFee = 0;
        fx.Engine.Transaction.Script = script.ToArray();
        ContractState coreState = NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, core)!;
        StorageKey key = new() { Id = coreState.Id, Key = new byte[] { 0x21 } };
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
        LastInstruction diagnostic = new();
        using ApplicationEngine app = ApplicationEngine.Create(TriggerType.Application, fx.Engine.Transaction,
            transaction, block, fx.Engine.ProtocolSettings, 10_000_000_000, diagnostic);
        Assert.AreEqual(typeof(ApplicationEngine), app.GetType());
        app.LoadScript(new Script(script.ToArray()));
        DataCache pending = app.SnapshotCache;
        VMState state = app.Execute();
        if (state == VMState.HALT) transaction.Commit();
        byte[]? pendingBytes = pending.TryGet(key)?.Value.ToArray();
        byte[]? committedBytes = fx.Engine.Storage.Snapshot.TryGet(key)?.Value.ToArray();
        string? error = app.FaultException?.Message;
        File.WriteAllText(Path.Combine(Path.GetTempPath(), "sa-public-integer-boundary-" + addSecond + ".json"),
            System.Text.Json.JsonSerializer.Serialize(new
            {
                addSecond,
                state = state.ToString(),
                error,
                diagnostic.Offset,
                diagnostic.Opcode,
                successfulPublicNotifications = app.Notifications.Count(n => n.EventName == "SponsoredUserOpExecuted"),
                pendingLedger = pendingBytes is null ? null : Convert.ToHexString(pendingBytes),
                committedLedger = committedBytes is null ? null : Convert.ToHexString(committedBytes),
                neo = typeof(ApplicationEngine).Assembly.FullName,
                vm = typeof(ExecutionEngine).Assembly.FullName
            }, new JsonSerializerOptions { WriteIndented = true }));
        Assert.IsNotNull(pendingBytes, error);
        VmArray ledger = (VmArray)BinarySerializer.Deserialize(pendingBytes, ExecutionEngineLimits.Default);
        Assert.AreEqual(Maximum, ledger[1].GetInteger(), error);
        if (addSecond)
        {
            Assert.AreEqual(VMState.FAULT, state);
            Assert.IsNull(committedBytes);
            // A faulting script's successful-op notifications do not survive the
            // fault: the first call completed (the pending ledger already holds
            // its Maximum reservation) yet the engine reports none, so a rejected
            // sponsored batch must report no success at all.
            Assert.AreEqual(0, app.Notifications.Count(n => n.EventName == "SponsoredUserOpExecuted"));
            // The cumulative range violation is rejected by the contract itself,
            // not by a CLR arithmetic exception escaping the accumulator ADD.
            StringAssert.Contains(error!, "Reimbursement budget exceeds VM integer limit");
        }
        else
        {
            Assert.AreEqual(VMState.HALT, state, error);
            Assert.AreEqual(1, app.Notifications.Count(n => n.EventName == "SponsoredUserOpExecuted"));
            CollectionAssert.AreEqual(pendingBytes, committedBytes);
        }
    }

    private static UInt160 DeployPolicy(RuntimeFixture fx, UInt160 core)
    {
        using ScriptBuilder script = new();
        script.EmitPush(core.ToArray()); script.Emit(OpCode.RET);
        int settle = script.Length;
        script.Emit(OpCode.INITSLOT, new byte[] { 0, 6 }); script.Emit(OpCode.RET);
        int run = script.Length;
        script.EmitPush(true); script.Emit(OpCode.RET);
        NefFile nef = new() { Compiler = "Local integer boundary fixture", Source = "", Tokens = [], Script = script.ToArray() };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        ContractManifest manifest = new()
        {
            Name = "IntegerBoundaryPolicy",
            Groups = [],
            SupportedStandards = [],
            Permissions = [],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
            Abi = new ContractAbi
            {
                Methods = [
                    new ContractMethodDescriptor { Name = "authorizedCore", Offset = 0, Safe = true, Parameters = [], ReturnType = ContractParameterType.Hash160 },
                    new ContractMethodDescriptor { Name = "settleReimbursement", Offset = settle, Safe = false,
                        Parameters = Enumerable.Range(0, 6).Select(i => new ContractParameterDefinition { Name = "a" + i, Type = ContractParameterType.Any }).ToArray(),
                        ReturnType = ContractParameterType.Void },
                    new ContractMethodDescriptor { Name = "run", Offset = run, Safe = false, Parameters = [], ReturnType = ContractParameterType.Boolean }
                ],
                Events = []
            }
        };
        return fx.DeployArtifact(nef.ToArray(), manifest.ToJson().ToString());
    }

    private static ContractParameter Parameter(object? value) => value switch
    {
        BigInteger n => new ContractParameter(ContractParameterType.Integer) { Value = n },
        string s => new ContractParameter(ContractParameterType.String) { Value = s },
        byte[] b => new ContractParameter(ContractParameterType.ByteArray) { Value = b },
        UInt160 h => new ContractParameter(ContractParameterType.Hash160) { Value = h },
        object?[] a => new ContractParameter(ContractParameterType.Array) { Value = a.Select(Parameter).ToList() },
        _ => throw new ArgumentException("Unsupported boundary fixture value")
    };

    private static void AppendCall(RuntimeFixture fx, ScriptBuilder script, UInt160 core, UInt160 account,
        UInt160 policy, BigInteger deadline, BigInteger nonce, BigInteger amount,
        P256SessionKey key, BigInteger configurationNonce)
    {
        object[] op = RuntimeFixture.UserOp(policy, "run", [], nonce, deadline, new byte[] { 0x00 },
            configurationNonce: configurationNonce);
        op[11] = fx.SignBuiltIn(core, account, op, key);
        script.EmitPush(Parameter(new object[] { account, op, policy, Owner, amount }));
        script.EmitPush((BigInteger)(int)CallFlags.All);
        script.EmitPush("executeSponsoredUserOp"); script.EmitPush(core.ToArray());
        script.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash); script.Emit(OpCode.DROP);
    }

    private sealed class LastInstruction : IDiagnostic
    {
        private ApplicationEngine app = null!;
        public int Offset { get; private set; }
        public string Opcode { get; private set; } = "";
        public void Initialized(ApplicationEngine engine) => app = engine;
        public void Disposed() { }
        public void ContextLoaded(Neo.VM.ExecutionContext context) { }
        public void ContextUnloaded(Neo.VM.ExecutionContext context) { }
        public void CallFromNative(UInt160 hash, string method, StackItem[] args) { }
        public void PostExecuteInstruction(Instruction instruction) { }
        public void PreExecuteInstruction(Instruction instruction)
        {
            Offset = app.CurrentContext!.InstructionPointer; Opcode = instruction.OpCode.ToString();
        }
    }
}
