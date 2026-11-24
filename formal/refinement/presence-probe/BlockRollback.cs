using Akka.Actor;
using Neo;
using Neo.Cryptography;
using Neo.Extensions;
using Neo.Ledger;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.VM;

internal static class BlockRollback
{
    public static object Run(ProtocolSettings settings, byte[] nef, string manifest)
    {
        using var system = new NeoSystem(settings);
        var previous = system.GenesisBlock;
        var sender = previous.NextConsensus;
        var marker = UInt160.Parse("0x1234567890abcdef1234567890abcdef12345678");
        var wallet = Neo.SmartContract.Helper.GetContractHash(sender, NefFile.Parse(nef).CheckSum,
            ContractManifest.Parse(manifest).Name);
        var observed = new Dictionary<UInt256, Blockchain.ApplicationExecuted>();
        var rows = new List<object>();
        uint nonce = 0;
        void Capture(NeoSystem source, Block block, DataCache state, IReadOnlyList<Blockchain.ApplicationExecuted> events)
        {
            if (source != system) return;
            foreach (var e in events)
                if (e.Transaction != null) observed.Add(e.Transaction.Hash, e);
        }
        Transaction Tx(ScriptBuilder script, long fee) => new()
        {
            Script = script.ToArray(), Nonce = ++nonce, SystemFee = fee, NetworkFee = 0, ValidUntilBlock = 100,
            Signers = [new Signer { Account = sender, Scopes = WitnessScope.Global }], Attributes = [],
            Witnesses = [new Witness { InvocationScript = default, VerificationScript = default }]
        };
        void Import(params Transaction[] txs)
        {
            var block = new Block { Header = new Header { Index = previous.Index + 1, PrevHash = previous.Hash,
                Timestamp = previous.Timestamp + 15000, MerkleRoot = MerkleTree.ComputeRoot(txs.Select(t => t.Hash).ToArray()),
                NextConsensus = sender, Witness = new Witness { InvocationScript = default, VerificationScript = default } },
                Transactions = txs };
            system.Blockchain.Ask<Blockchain.ImportCompleted>(new Blockchain.Import([block], Verify: false),
                TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
            previous = block;
        }
        void Expect(Transaction tx, VMState state, string? fault = null)
        {
            var e = observed[tx.Hash];
            string? error = e.Exception?.GetBaseException().Message;
            var ledger = NativeContract.Ledger.GetTransactionState(system.StoreView, tx.Hash);
            if (e.VMState != state || ledger?.BlockIndex != previous.Index || ledger.Transaction?.Hash != tx.Hash ||
                (fault == null ? error != null : error?.Contains(fault, StringComparison.OrdinalIgnoreCase) != true))
                throw new InvalidDataException($"tx {tx.Nonce}: expected {state}/{fault}, event={e.VMState}/{error}, ledger={ledger?.State}, height={ledger?.BlockIndex}");
        }
        void Balance(ScriptBuilder script, int amount)
        {
            script.EmitDynamicCall(NativeContract.GAS.Hash, "balanceOf", marker);
            script.EmitPush(amount);
            script.Emit(OpCode.NUMEQUAL);
            script.Emit(OpCode.ASSERT);
        }
        Transaction Query(string name, int before, int increment, string outcome)
        {
            using var sb = new ScriptBuilder();
            Balance(sb, before);
            sb.EmitDynamicCall(NativeContract.GAS.Hash, "transfer", sender, marker, increment, null!);
            sb.Emit(OpCode.ASSERT);
            Balance(sb, before + increment);
            object[] values = name switch
            {
                "getAccountImplementationId" => [],
                _ when outcome == "unsupported" => ["unsupported"],
                "supportsExecutionMode" => ["batch"],
                "supportsModuleType" => ["hook"],
                _ => throw new ArgumentException(name)
            };
            if (outcome == "comparison")
            {
                sb.EmitPush(65537);
                sb.Emit(OpCode.NEWBUFFER);
                sb.Emit(OpCode.CONVERT, [(byte)Neo.VM.Types.StackItemType.ByteString]);
                sb.EmitPush(1);
                sb.Emit(OpCode.PACK);
                sb.EmitPush((int)CallFlags.None);
                sb.EmitPush(name);
                sb.EmitPush(wallet.ToArray());
                sb.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
            }
            else sb.EmitDynamicCall(wallet, name, CallFlags.None, values);
            if (name == "getAccountImplementationId")
            {
                sb.EmitPush("org.r3e.neo.aa.unified-smart-wallet.v3");
                sb.Emit(OpCode.EQUAL);
            }
            if (outcome == "unsupported")
            {
                sb.EmitPush("unsupported result rejected by caller");
                sb.Emit(OpCode.ASSERTMSG);
            }
            else sb.Emit(OpCode.ASSERT);
            if (outcome == "abort") sb.Emit(OpCode.ABORT);
            return Tx(sb, 10_00000000);
        }
        Blockchain.Committing += Capture;
        try
        {
            using var deploy = new ScriptBuilder();
            deploy.EmitDynamicCall(NativeContract.ContractManagement.Hash, "deploy", nef, manifest);
            var setup = Tx(deploy, 5000_00000000);
            Import(setup);
            Expect(setup, VMState.HALT);
            int baseline = 0;
            foreach (var name in new[] { "getAccountImplementationId", "supportsExecutionMode", "supportsModuleType" })
            {
                var cases = new List<(Transaction tx, string outcome, string? error)>
                {
                    (Query(name, baseline, 3, "halt"), "halt", null),
                    (Query(name, baseline + 3, 11, "abort"), "abort", "ABORT")
                };
                if (name != "getAccountImplementationId")
                {
                    cases.Add((Query(name, baseline + 3, 11, "unsupported"), "unsupported", "unsupported result rejected by caller"));
                    cases.Add((Query(name, baseline + 3, 11, "comparison"), "comparison", "maximum comparable size, 65537/65536"));
                }
                cases.Add((Query(name, baseline + 3, 5, "halt"), "halt", null));
                Import(cases.Select(c => c.tx).ToArray());
                foreach (var c in cases) Expect(c.tx, c.error == null ? VMState.HALT : VMState.FAULT, c.error);
                int after = (int)NativeContract.GAS.BalanceOf(system.StoreView, marker);
                if (after != baseline + 8) throw new InvalidDataException($"block {previous.Index}: marker balance {after}");
                rows.Add(new { name, block = previous.Index, before = baseline, after, transactions = cases.Select(c =>
                    new { hash = c.tx.Hash.ToString(), c.outcome, state = observed[c.tx.Hash].VMState.ToString(),
                        ledgerState = NativeContract.Ledger.GetTransactionState(system.StoreView, c.tx.Hash)!.State.ToString(),
                        fault = observed[c.tx.Hash].Exception?.GetBaseException().Message,
                        gasConsumed = observed[c.tx.Hash].GasConsumed }).ToArray() });
                baseline = after;
            }
            return new { verificationOfImportedBlocks = false, marker = marker.ToString(),
                eventLedgerStateAgreement = rows.Count != 0 && observed.All(pair =>
                    pair.Value.VMState == NativeContract.Ledger.GetTransactionState(system.StoreView, pair.Key)?.State), rows };
        }
        finally { Blockchain.Committing -= Capture; }
    }
}
