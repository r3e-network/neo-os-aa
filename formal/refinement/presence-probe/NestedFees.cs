using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.SmartContract.Testing;
using Neo.VM;

internal static class NestedFees
{
    public static List<object> Run(TestEngine test, Block block, UInt160 wallet)
    {
        const string query = "getAccountImplementationId";
        const long outerPrice = 12345, innerPrice = 54321, rate = 30;
        using var body = new ScriptBuilder();
        body.EmitDynamicCall(wallet, query, CallFlags.ReadOnly);
        body.Emit(OpCode.PUSH1).Emit(OpCode.DROP).Emit(OpCode.RET);
        var nef = new NefFile { Compiler = "FeeFixture", Source = "", Tokens = [], Script = body.ToArray() };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        var manifest = new ContractManifest {
            Name = "NestedFeeFixture", Groups = [], SupportedStandards = [], Permissions = [ContractPermission.DefaultPermission],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
            Abi = new ContractAbi { Events = [], Methods = [new ContractMethodDescriptor {
                Name = "query", Offset = 0, Safe = true, Parameters = [], ReturnType = ContractParameterType.String }] }
        };
        var wrapper = test.GetDeployHash(nef, manifest);
        using var deployment = new ScriptBuilder();
        deployment.EmitDynamicCall(NativeContract.ContractManagement.Hash, "deploy", nef.ToArray(), manifest.ToJson().ToString());
        var baseline = test.Storage.Snapshot.CloneCache();
        void Setup(DataCache cache, ScriptBuilder script)
        {
            test.Transaction.Script = script.ToArray();
            using var app = ApplicationEngine.Create(TriggerType.Application, test.Transaction, cache, block, test.ProtocolSettings, 5000_00000000);
            app.LoadScript(new Script(test.Transaction.Script));
            if (app.Execute() != VMState.HALT) throw new InvalidOperationException("fee fixture setup", app.FaultException);
        }
        Setup(baseline, deployment);
        using var driver = new ScriptBuilder();
        driver.EmitDynamicCall(wrapper, "query", CallFlags.ReadOnly);
        driver.Emit(OpCode.PUSH1).Emit(OpCode.DROP).Emit(OpCode.RET);
        var rows = new List<object>();
        foreach (bool fixedOuter in new[] { false, true })
        foreach (bool fixedInner in new[] { false, true })
        {
            var snapshot = baseline.CloneCache();
            test.SetTransactionSigners(new Signer { Account = test.CommitteeAddress, Scopes = WitnessScope.Global });
            using var policy = new ScriptBuilder();
            if (fixedOuter) policy.EmitDynamicCall(NativeContract.Policy.Hash, "setWhitelistFeeContract", wrapper, "query", 0, outerPrice);
            if (fixedInner) policy.EmitDynamicCall(NativeContract.Policy.Hash, "setWhitelistFeeContract", wallet, query, 0, innerPrice);
            if (policy.Length > 0) Setup(snapshot, policy);
            test.SetTransactionSigners(new Signer { Account = test.ValidatorsAddress, Scopes = WitnessScope.Global });
            test.Transaction.Script = driver.ToArray();
            long total = 0;
            foreach (var limit in new Func<long>[] { () => 100_00000000, () => total, () => total - 1 })
            {
                var budget = limit();
                var trace = new Meter(wallet, wrapper, fixedInner, fixedOuter);
                using var app = ApplicationEngine.Create(TriggerType.Application, test.Transaction, snapshot.CloneCache(), block,
                    test.ProtocolSettings, budget, diagnostic: trace);
                app.LoadScript(new Script(test.Transaction.Script));
                var state = app.Execute();
                if (total == 0) total = trace.Units * rate + (fixedOuter ? outerPrice : 0) + (fixedInner ? innerPrice : 0);
                bool ok = budget >= total;
                if (ok ? state != VMState.HALT || app.ResultStack.Count != 1 || app.ResultStack.Peek().GetString() != "org.r3e.neo.aa.unified-smart-wallet.v3"
                      || app.FeeConsumed != total || trace.WalletSteps != 173 || !trace.ResumedOuter :
                      state != VMState.FAULT || app.FaultException?.GetBaseException().Message != "Insufficient GAS." || app.FeeConsumed <= budget)
                    throw new InvalidOperationException($"nested fee mismatch {fixedOuter}/{fixedInner}, budget {budget}, expected {total}, actual {app.FeeConsumed}, {trace.WalletSteps}, {state}: {app.FaultException}");
                rows.Add(new { fixedOuter, fixedInner, budget, total, state = state.ToString(), consumed = app.FeeConsumed, trace.WalletSteps, trace.ResumedOuter });
            }
        }
        return rows;
    }

    private sealed class Meter(UInt160 wallet, UInt160 wrapper, bool fixedInner, bool fixedOuter) : IDiagnostic
    {
        private ApplicationEngine app = null!;
        public long Units;
        public int WalletSteps;
        public bool ResumedOuter;
        public void Initialized(ApplicationEngine engine) => app = engine;
        public void PreExecuteInstruction(Instruction i)
        {
            bool inner = app.CurrentScriptHash == wallet, outer = app.CurrentScriptHash == wrapper;
            if (inner) WalletSteps++;
            if (outer && WalletSteps > 0) ResumedOuter = true;
            if (inner && fixedInner || outer && fixedOuter) return;
            Units += ApplicationEngine.OpCodePriceTable[(byte)i.OpCode];
            if (i.OpCode == OpCode.SYSCALL)
            {
                if (i.TokenU32 != ApplicationEngine.System_Contract_Call.Hash) throw new InvalidOperationException("unexpected syscall");
                Units += ApplicationEngine.System_Contract_Call.FixedPrice;
            }
        }
        public void PostExecuteInstruction(Instruction i) { }
        public void ContextLoaded(Neo.VM.ExecutionContext c) { }
        public void ContextUnloaded(Neo.VM.ExecutionContext c) { }
        public void CallFromNative(UInt160 h, string m, Neo.VM.Types.StackItem[] args) { }
        public void Disposed() { }
    }
}
