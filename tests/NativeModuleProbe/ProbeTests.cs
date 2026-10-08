using Neo;
using Neo.Extensions;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.VM;

internal static class ProbeTests
{
    internal static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    internal static List<object> PostBalanceTypes(ProbeHarness h, UInt160 hook, UInt160 account, ContractState token)
    {
        List<object> vectors = [];
        HashSet<Neo.VM.Types.StackItemType> types = [];
        ProbeHarness.SetMode(h.Snapshot, token, 1);
        h.Configure(account, token.Hash, true);
        for (int mode = 0; mode < ProbeHarness.BalanceKinds.Length; mode++)
        {
            string kind = ProbeHarness.BalanceKinds[mode];
            ProbeHarness.SetMode(h.Snapshot, token, mode);
            var value = h.Call("post-query-" + kind, token.Hash, "balanceOf", [account], commit: false);
            types.Add(value.Type);
            Require(value.Type.ToString().ToLowerInvariant() == (kind switch
            {
                "zero" or "positive" or "negative" => "integer",
                "bytes" => "bytestring",
                "null" => "any",
                "interop" => "interopinterface",
                _ => kind
            }), "Wrong post-phase diagnostic type: " + kind);
            if (kind is "zero" or "positive" or "negative")
                Require(value.GetInteger() == (kind == "zero" ? 0 : kind == "positive" ? 1000 : -1), "Wrong diagnostic integer.");
            ProbeHarness.SetMode(h.Snapshot, token, 1);
            int injections = 0;
            h.Trace!.NativeCall = (engine, target, method, _) =>
            {
                if (target != hook || method != "postExecute") return;
                ProbeHarness.SetMode(engine.SnapshotCache, token, mode);
                injections++;
            };
            try
            {
                h.Execute(account, "post-balance-" + kind, kind switch
                {
                    "positive" => null,
                    "zero" => "Restricted token outflow (incl. via intermediary) is forbidden",
                    _ => "Invalid restricted token balance"
                });
            }
            finally { h.Trace.NativeCall = null; }
            Require(injections == 1, "Post-phase mode must be injected exactly once.");
            Require(new System.Numerics.BigInteger(h.Snapshot[new StorageKey { Id = token.Id, Key = new byte[] { 1 } }].Value.Span) == 1,
                "Failed post-phase mode must not be persisted.");
            int hookId = Neo.SmartContract.Native.NativeContract.ContractManagement.GetContract(h.Snapshot, hook)!.Id;
            Require(!h.Snapshot.Contains(ProbeHarness.Key(hookId, 2, account, token.Hash)),
                "Post-phase execution must not persist a transient balance snapshot.");
            vectors.Add(new
            {
                kind,
                vmType = value.Type.ToString(),
                injections,
                nefSha256 = ProbeHarness.Hash(token.Nef.ToArray()),
                scriptHex = Convert.ToHexStringLower(token.Nef.Script.Span)
            });
        }
        Require(types.SetEquals(Enum.GetValues<Neo.VM.Types.StackItemType>()), "Every VM type must be observed in the post phase.");
        h.Execute(account, "positive-after-post-type-faults");
        h.Configure(account, token.Hash, false);
        h.Snapshot.Delete(new StorageKey { Id = token.Id, Key = new byte[] { 1 } });
        h.DeleteToken(token);
        return vectors;
    }

    internal static List<object> CallbackShapes(ProbeHarness h, UInt160 hook, UInt160 account)
    {
        const string noContext = "Missing native module invocation context";
        h.Call("direct-config-denied", hook, "setRestrictedToken", [account, Neo.SmartContract.Native.NativeContract.GAS.Hash, true], noContext);
        h.Call("direct-pre-denied", hook, "preExecute", [account, System.Array.Empty<object>()], noContext);
        h.Call("direct-post-denied", hook, "postExecute", [account, System.Array.Empty<object>(), null], noContext);
        h.Call("direct-cleanup-denied", hook, "clearAccount", [account], noContext);
        List<object> cases = [];
        foreach (string kind in new[] { "short-array", "integer-target", "short-target", "buffer-target" })
        {
            int injections = 0;
            h.Trace!.NativeCall = (_, target, method, arguments) =>
            {
                if (target != hook || method != "preExecute") return;
                var original = (Neo.VM.Types.Array)arguments[1];
                Require(original.Count == 6, "Native service must supply the canonical six-field operation.");
                var replacement = new Neo.VM.Types.Array(original.Take(kind == "short-array" ? 5 : 6));
                if (kind != "short-array") replacement[0] = kind switch
                {
                    "integer-target" => new Neo.VM.Types.Integer(1),
                    "short-target" => new Neo.VM.Types.ByteString(new byte[19]),
                    "buffer-target" => new Neo.VM.Types.Buffer(new byte[20]),
                    _ => throw new InvalidOperationException("Unknown diagnostic shape.")
                };
                arguments[1] = replacement;
                injections++;
            };
            try { h.Execute(account, "callback-" + kind, "Invalid native operation shape"); }
            finally { h.Trace.NativeCall = null; }
            Require(injections == 1, "Callback shape injection must occur exactly once.");
            cases.Add(new { kind, injections });
        }
        h.Execute(account, "positive-after-callback-faults");
        return cases;
    }

    internal static void Collector(DataCache snapshot, ProtocolSettings settings)
    {
        byte[] script = [(byte)OpCode.JMPIF, 4, (byte)OpCode.PUSH0, (byte)OpCode.RET, (byte)OpCode.PUSH1, (byte)OpCode.RET];
        var trace = new NefTrace(script.ToScriptHash(), script);
        foreach (bool value in new[] { false, true })
        {
            using var engine = ApplicationEngine.Create(TriggerType.Application, null, snapshot, ProbeHarness.Block(1), settings, diagnostic: trace);
            engine.LoadScript(script);
            engine.CurrentContext!.EvaluationStack.Push(value);
            Require(engine.Execute() == VMState.HALT, "Collector branch control must HALT: " + engine.FaultException);
        }
        Require(trace.InstructionCount == 5 && trace.Visited.Count == 5, "Collector must retain the exact instruction denominator.");
        Require(trace.EdgeCount == 2 && trace.Edges.Count == 2, "Both completed branch edges must be counted.");
        var failure = new NefTrace(script.ToScriptHash(), script);
        using (var engine = ApplicationEngine.Create(TriggerType.Application, null, snapshot, ProbeHarness.Block(1), settings, diagnostic: failure))
        {
            engine.LoadScript(script);
            Require(engine.Execute() == VMState.FAULT, "An empty conditional stack must fault.");
        }
        Require(failure.Visited.Count == 1 && failure.Edges.Count == 0, "A faulting branch must not count as a completed edge.");
        byte[] sameSuccessor = [(byte)OpCode.PUSH1, (byte)OpCode.JMPIF, 2, (byte)OpCode.RET];
        var unique = new NefTrace(sameSuccessor.ToScriptHash(), sameSuccessor);
        Require(unique.EdgeCount == 1, "Coincident successors represent one edge, not two observations.");
        foreach (OpCode opcode in Enum.GetValues<OpCode>().Where(op => op is >= OpCode.JMPIF and <= OpCode.JMPLE_L))
        {
            bool wide = opcode.ToString().EndsWith("_L", StringComparison.Ordinal);
            byte[] operand = wide ? BitConverter.GetBytes(7) : new byte[] { 4 };
            byte[] program = new byte[] { (byte)opcode }.Concat(operand)
                .Concat(new byte[] { (byte)OpCode.PUSH0, (byte)OpCode.RET, (byte)OpCode.PUSH1, (byte)OpCode.RET }).ToArray();
            var both = new NefTrace(program.ToScriptHash(), program);
            bool unary = opcode is OpCode.JMPIF or OpCode.JMPIF_L or OpCode.JMPIFNOT or OpCode.JMPIFNOT_L;
            foreach (bool alternative in new[] { false, true })
            {
                using var engine = ApplicationEngine.Create(TriggerType.Application, null, snapshot, ProbeHarness.Block(1), settings, diagnostic: both);
                engine.LoadScript(program);
                if (unary) engine.CurrentContext!.EvaluationStack.Push(alternative);
                else
                {
                    engine.CurrentContext!.EvaluationStack.Push(1);
                    engine.CurrentContext!.EvaluationStack.Push(alternative ? 1 : (opcode is OpCode.JMPGT or OpCode.JMPGT_L or OpCode.JMPLE or OpCode.JMPLE_L ? 0 : 2));
                }
                Require(engine.Execute() == VMState.HALT, "Conditional collector control failed: " + opcode + ": " + engine.FaultException);
            }
            Require(both.EdgeCount == 2 && both.Edges.Count == 2, "Missing conditional edge for " + opcode);
        }
    }

    internal static void Administration(ProbeHarness h, UInt160 hook, string artifacts)
    {
        const ulong delay = 7 * ProbeHarness.Delay;
        UInt160 next = UInt160.Parse("0x0202020202020202020202020202020202020202");
        void Call(string label, string method, object?[] args, string? fault = null, UInt160[]? signers = null) =>
            h.Call(label, hook, method, args, fault, signers: signers);
        Require(h.Call("supports-v3", hook, "supportsV3", []).GetBoolean(), "Version marker must be true.");
        Require(!h.Call("not-composite", hook, "supportsComposition", []).GetBoolean(), "Restriction hook is a leaf.");
        Require(new UInt160(h.Call("read-authority", hook, "authorizedCore", []).GetSpan()) == ProbeHarness.Core, "Wrong initial authority.");
        Call("wrong-admin", "cancelUpdate", [], "Unauthorized admin", [next]);
        Call("set-zero-core", "setAuthorizedCore", [UInt160.Zero], "Invalid core contract");
        Call("set-established-core", "setAuthorizedCore", [ProbeHarness.Core], "core already set");
        Call("confirm-core-without-proposal", "confirmAuthorizedCore", [next], "No pending core change");
        Call("propose-zero-core", "proposeAuthorizedCore", [UInt160.Zero], "Invalid core contract");
        Call("propose-next-core", "proposeAuthorizedCore", [next]);
        Call("core-early", "confirmAuthorizedCore", [next], "Core change timelock not expired");
        h.Time += delay;
        Call("core-mismatch", "confirmAuthorizedCore", [ProbeHarness.Core], "Pending core mismatch");
        Call("core-confirm", "confirmAuthorizedCore", [next]);
        Require(new UInt160(h.Call("read-next-authority", hook, "authorizedCore", []).GetSpan()) == next, "Authority change not persisted.");
        Call("wrong-service-phase", "clearAccount", [next], "Wrong native SmartAccount service");
        Call("core-restore-proposal", "proposeAuthorizedCore", [ProbeHarness.Core]);
        Call("core-cancel", "cancelAuthorizedCoreChange", []);
        Call("core-after-cancel", "confirmAuthorizedCore", [ProbeHarness.Core], "No pending core change");
        Call("core-restore-reproposal", "proposeAuthorizedCore", [ProbeHarness.Core]);
        h.Time += delay;
        Call("core-restore-confirm", "confirmAuthorizedCore", [ProbeHarness.Core]);
        Call("admin-no-proposal", "confirmAdminRotation", [next], "No pending admin rotation");
        Call("admin-same", "rotateAdmin", [ProbeHarness.Custody], "New admin must differ");
        Call("admin-invalid", "rotateAdmin", [new byte[19]], "Invalid admin");
        Call("admin-propose", "rotateAdmin", [next]);
        Call("admin-early", "confirmAdminRotation", [next], "Admin rotation timelock not expired");
        h.Time += delay;
        Call("admin-mismatch", "confirmAdminRotation", [ProbeHarness.Custody], "Pending admin mismatch");
        Call("admin-without-new-witness", "confirmAdminRotation", [next], "New admin must confirm rotation");
        Call("admin-cancel", "cancelAdminRotation", []);
        Call("admin-reproposal", "rotateAdmin", [next]);
        h.Time += delay;
        Call("admin-confirm", "confirmAdminRotation", [next], signers: [next]);
        Call("old-admin-denied", "cancelUpdate", [], "Unauthorized admin");
        Call("admin-restore-proposal", "rotateAdmin", [ProbeHarness.Custody], signers: [next]);
        h.Time += delay;
        Call("admin-restore-confirm", "confirmAdminRotation", [ProbeHarness.Custody]);

        byte[] nef = File.ReadAllBytes(Path.Combine(artifacts, "TokenRestrictedHook.nef"));
        string manifest = File.ReadAllText(Path.Combine(artifacts, "TokenRestrictedHook.manifest.json"));
        UInt256 nefHash = new(System.Security.Cryptography.SHA256.HashData(nef));
        UInt256 manifestHash = new(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(manifest)));
        Call("update-no-proposal", "update", [nef, manifest], "No pending update");
        Call("update-invalid-nef-hash", "proposeUpdate", [UInt256.Zero, manifestHash], "Invalid NEF hash");
        Call("update-invalid-manifest-hash", "proposeUpdate", [nefHash, UInt256.Zero], "Invalid manifest hash");
        Call("update-proposal", "proposeUpdate", [nefHash, manifestHash]);
        Call("update-early", "confirmUpdate", [nef, manifest], "Update timelock not expired");
        h.Time += delay;
        Call("update-nef-mismatch", "confirmUpdate", [new byte[] { 0 }, manifest], "NEF hash mismatch");
        Call("update-manifest-mismatch", "confirmUpdate", [nef, manifest + " "], "Manifest hash mismatch");
        Call("update-cancel", "cancelUpdate", []);
        Call("update-confirm-after-cancel", "confirmUpdate", [nef, manifest], "No pending update");
        Call("update-reproposal", "proposeUpdate", [nefHash, manifestHash]);
        h.Time += delay;
        Call("update-confirm-same-artifact", "confirmUpdate", [nef, manifest]);
        var state = Neo.SmartContract.Native.NativeContract.ContractManagement.GetContract(h.Snapshot, hook)!;
        Require(state.UpdateCounter == 1 && state.Nef.ToArray().SequenceEqual(nef), "Update must change the counter without rewriting NEF.");
    }
}
