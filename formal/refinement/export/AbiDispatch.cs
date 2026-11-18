// The actual ApplicationEngine's view of ABI dispatch.
//
// Every projection lane reads the dispatch path out of C# source: which method a
// name resolves to, what the entry does, which syscalls it reaches. This mode
// asks the engine instead. It deploys the pinned NEF into a real ApplicationEngine
// (Neo 3.9.1, the same assemblies the compiler ships), calls each ABI method by
// name with the arity the manifest declares, and records where the engine
// actually entered, which offsets ran, in which state it ended and which syscalls
// it reached.
//
// It also writes the executed instruction-offset set, the script bytes it was
// measured against, and the script hash of every frame depth it entered. Those
// three are what lets a consumer decode the same bytes independently and ask
// whether the project's own static dependency model reaches what the engine ran.
//
// What this is: a measurement of one artifact, one engine version, one set of
// arguments (all-zero, arity-matched). What it is not: a proof about the
// contract's semantics, a statement about calls with real arguments, or anything
// about NEF bytes being the compiler's output - the exporter's existing mode
// already refuses a NEF that differs from a fresh compile, and this mode does
// not repeat that check.
using System.Numerics;
using System.Security.Cryptography;
using System.Text.Json;
using Neo;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.SmartContract.Testing;
using Neo.VM;

internal static class AbiDispatch
{
    private const int StepLimit = 200_000;
    private const long GasLimit = 100_000_000_000;

    private static readonly System.Text.Json.JsonSerializerOptions Options = new() { MaxDepth = 512 };

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    public static int Dump(string destination, string nefPath, string manifestPath)
    {
        byte[] nefBytes = File.ReadAllBytes(nefPath);
        byte[] manifestBytes = File.ReadAllBytes(manifestPath);
        var nef = NefFile.Parse(nefBytes, verify: true);
        var manifest = ContractManifest.Parse(System.Text.Encoding.UTF8.GetString(manifestBytes));

        // The deploy pays a storage deposit out of the gas limit, so the limit
        // is the size of the deposit rather than a plausible execution cost.
        var test = new TestEngine(initializeNativeContracts: true) { Fee = GasLimit, ResetFeeConsumed = true };
        var proxy = test.Deploy<SmartContract>(nef, manifest, null, null);
        var hash = UInt160.Parse(proxy.Hash.ToString());
        var state = NativeContract.ContractManagement.GetContract(test.Storage.Snapshot, hash)
            ?? throw new InvalidDataException("the engine did not store the deployed contract");

        var header = new Header
        {
            Version = 0, PrevHash = UInt256.Zero, MerkleRoot = UInt256.Zero,
            Timestamp = 0, Nonce = 0, Index = 0, PrimaryIndex = 0, NextConsensus = UInt160.Zero,
            Witness = new Witness
            {
                InvocationScript = Array.Empty<byte>(),
                VerificationScript = Array.Empty<byte>()
            }
        };
        var block = new Block { Header = header, Transactions = Array.Empty<Transaction>() };

        var rows = new List<object>();
        foreach (var method in state.Manifest.Abi.Methods)
        {
            var row = new Dictionary<string, object?>
            {
                ["name"] = method.Name,
                ["parameters"] = method.Parameters.Length,
                ["offset"] = method.Offset,
                ["returnType"] = method.ReturnType.ToString(),
                ["safe"] = method.Safe
            };
            var checkpoint = test.Storage.Checkpoint();
            try
            {
                Trace(test, state, hash, block, method, row);
            }
            catch (Exception error)
            {
                row["engineError"] = error.GetType().Name + ": " + error.Message.Split('\n')[0];
            }
            finally
            {
                test.Storage.Restore(checkpoint);
            }
            rows.Add(row);
        }

        var report = new Dictionary<string, object?>
        {
            ["schema"] = "sa-abi-dispatch/v3",
            ["nef"] = new { path = nefPath, sha256 = Sha(nefBytes), scriptLength = nef.Script.Length },
            // The script bytes travel with the dump so that a second reader can
            // decode the same script the engine ran. Without them the consumer
            // has to trust this process's idea of which bytes were executed.
            ["script"] = new
            {
                length = nef.Script.Length,
                hex = Convert.ToHexString(nef.Script.ToArray()).ToLowerInvariant(),
                sha256 = Sha(nef.Script.ToArray())
            },
            ["manifest"] = new { path = manifestPath, sha256 = Sha(manifestBytes), methods = manifest.Abi.Methods.Length },
            ["deployed"] = new { hash = hash.ToString(), gasLimit = GasLimit },
            ["engine"] = new
            {
                neo = typeof(ApplicationEngine).Assembly.GetName().Version?.ToString(),
                vm = typeof(OpCode).Assembly.GetName().Version?.ToString(),
                testing = typeof(TestEngine).Assembly.GetName().Version?.ToString()
            },
            ["initializeOffset"] = state.Manifest.Abi.Methods.FirstOrDefault(m => m.Name == "_initialize")?.Offset,
            ["deployOffset"] = state.Manifest.Abi.Methods.FirstOrDefault(m => m.Name == "_deploy")?.Offset,
            ["methods"] = rows,
            ["boundary"] = Boundary(test, state, hash, block)
        };
        File.WriteAllText(destination, System.Text.Json.JsonSerializer.Serialize(report, Options));
        return 0;
    }

    // One named call, single-stepped. The engine's own dispatch answers
    // `firstIps[2]`: the first offset it executed inside the callee context.
    // `executed` records every offset the contract ran, so "the declared entry
    // point was executed" is a fact about instructions rather than about intent.
    //
    // Membership is decided by the running script's hash, not by the stack
    // depth. A native contract call pushes its own context too, and its
    // instruction pointers are numbered from zero in a different script, so a
    // depth-only rule could credit this contract with an offset it never ran.
    private static void Trace(TestEngine test, ContractState state, UInt160 hash, Block block,
                              ContractMethodDescriptor method, Dictionary<string, object?> row)
    {
        var builder = new ScriptBuilder();
        for (int index = 0; index < method.Parameters.Length; index++)
            builder.EmitPush(BigInteger.Zero);
        builder.EmitPush(method.Parameters.Length);
        builder.Emit(OpCode.PACK);
        builder.EmitPush((byte)CallFlags.All);
        builder.EmitPush(method.Name);
        builder.EmitPush(hash.GetSpan());
        builder.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);

        var engine = ApplicationEngine.Create(TriggerType.Application, test.Transaction, test.Storage.Snapshot,
            block, test.ProtocolSettings, GasLimit, null);
        engine.LoadScript(new Script(builder.ToArray()), -1, 0);

        var observation = VmRun.Step(engine, hash, StepLimit);

        int? dispatchOffset = observation.FirstIps.TryGetValue(2, out var entered) ? entered : null;
        row["dispatchOffset"] = dispatchOffset;
        row["dispatchMatchesDeclared"] = dispatchOffset == method.Offset;
        row["reachedDeclared"] = observation.ExecutedInContract.Contains(method.Offset);
        row["state"] = observation.State;
        row["fault"] = observation.Fault;
        row["steps"] = observation.Steps;
        row["stepLimitReached"] = observation.StepLimitReached;
        row["executedOffsets"] = observation.ExecutedInContract.Count;
        row["executedInContract"] = observation.ExecutedInContract;
        row["executedForeign"] = observation.ExecutedForeign;
        row["firstIps"] = observation.FirstIps;
        row["firstScripts"] = observation.FirstScripts;
        row["syscalls"] = observation.Syscalls;
        row["syscallsTruncated"] = observation.SyscallsTruncated;

        // What the call left behind, recorded by the shared loop. The shape rules
        // live in the Python face, where they can be read and mutated without
        // recompiling.
        var results = observation.Result;
        row["resultCount"] = results["count"];
        if (Convert.ToInt32(results["count"]) > 0)
        {
            row["resultType"] = results["type"];
            foreach (var key in new[] { "items", "itemTypes", "bytes", "sha256", "hex", "integer", "error" })
                if (results.TryGetValue(key, out var value)) row["result" + char.ToUpperInvariant(key[0]) + key[1..]] = value;
        }
    }

    // ---- ABI boundary -------------------------------------------------------
    //
    // Everything above asks what the engine does with a call that matches the
    // manifest. That is half a dispatch rule. The other half is what it does with
    // a call that does not: a name nobody declared, a parameter count that no
    // overload of that name has, an argument whose shape no conversion can
    // produce. A contract that answered such a call anyway would be dispatching
    // on something other than its own manifest, and every arity-matched
    // measurement above is blind to that.
    //
    // Each probe records only what happened - did a callee frame appear, at which
    // offset, in which state, with which message. What *should* have happened is
    // worked out in the Python face from the manifest, so the expectation cannot
    // be smuggled in with the measurement.
    //
    // `control` repeats the call the dispatch face makes, as the positive anchor
    // for every refusal recorded beside it: a refusal means nothing unless the
    // same machinery enters when it should.
    private sealed record Probe(string Kind, string Name, int Arity, string ArgShapes);

    private const string UndeclaredProbeName = "abiBoundaryProbeNotDeclared";

    private static Dictionary<string, object?> Boundary(TestEngine test, ContractState state,
                                                       UInt160 hash, Block block)
    {
        var methods = state.Manifest.Abi.Methods;
        var arities = methods.GroupBy(method => method.Name)
                             .ToDictionary(group => group.Key,
                                           group => group.Select(method => method.Parameters.Length)
                                                         .Distinct().OrderBy(count => count).ToList());
        var probes = new List<Probe>();
        var seen = new HashSet<string>();
        void Add(Probe probe)
        {
            if (seen.Add(probe.Kind + '|' + probe.Name + '|' + probe.Arity + '|' + probe.ArgShapes))
                probes.Add(probe);
        }

        foreach (var method in methods)
        {
            int arity = method.Parameters.Length;
            Add(new Probe("control", method.Name, arity, "zeros"));
            foreach (int candidate in new[] { arity - 1, arity + 1 })
            {
                if (candidate < 0) continue;
                // A count that another overload of the same name declares is not a
                // mismatch, it is a dispatch to that overload. Counting it as a
                // refusal would be wrong, and refusing to measure it would leave
                // the interesting half of name resolution unmeasured.
                Add(new Probe(arities[method.Name].Contains(candidate) ? "overload" : "arity",
                              method.Name, candidate, "zeros"));
            }
            var first = method.Parameters.FirstOrDefault();
            if (first is not null && first.Type != ContractParameterType.Any)
            {
                bool compound = first.Type is ContractParameterType.Array
                                           or ContractParameterType.Map;
                Add(new Probe("type", method.Name, arity,
                              compound ? "scalar-for-compound" : "compound-for-scalar"));
            }
        }
        Add(new Probe("absent", UndeclaredProbeName, 0, "zeros"));

        var rows = new List<object>();
        foreach (var probe in probes)
        {
            var row = new Dictionary<string, object?>
            {
                ["kind"] = probe.Kind,
                ["name"] = probe.Name,
                ["arity"] = probe.Arity,
                ["argShapes"] = probe.ArgShapes
            };
            var checkpoint = test.Storage.Checkpoint();
            try
            {
                var engine = ApplicationEngine.Create(TriggerType.Application, test.Transaction,
                    test.Storage.Snapshot, block, test.ProtocolSettings, GasLimit, null);
                engine.LoadScript(new Script(ProbeScript(probe, hash)), -1, 0);
                var observation = VmRun.Step(engine, hash, StepLimit);
                int? entered = observation.FirstIps.TryGetValue(2, out var pointer) ? pointer : null;
                row["entered"] = entered is not null;
                row["enteredOffset"] = entered;
                row["state"] = observation.State;
                row["fault"] = observation.Fault;
                row["faultDetail"] = observation.FaultDetail;
                row["steps"] = observation.Steps;
                row["stepLimitReached"] = observation.StepLimitReached;
                row["syscalls"] = observation.Syscalls;
            }
            catch (Exception error)
            {
                row["engineError"] = error.GetType().Name + ": " + error.Message.Split('\n')[0];
            }
            finally
            {
                test.Storage.Restore(checkpoint);
            }
            rows.Add(row);
        }

        return new Dictionary<string, object?>
        {
            ["schema"] = "sa-abi-boundary/v1",
            ["undeclaredName"] = UndeclaredProbeName,
            ["probes"] = rows
        };
    }

    // The script the probe runs. `compound-for-scalar` puts an empty array where
    // the first parameter was declared to be a scalar; `scalar-for-compound` puts
    // an integer where a compound was declared. Both are shapes the manifest says
    // cannot arrive, so a call that accepts one is answering a question the
    // manifest never asked.
    private static byte[] ProbeScript(Probe probe, UInt160 hash)
    {
        var builder = new ScriptBuilder();
        for (int index = 0; index < probe.Arity; index++)
        {
            if (index == 0 && probe.ArgShapes == "compound-for-scalar")
            {
                builder.EmitPush(0);
                builder.Emit(OpCode.PACK);
            }
            else
            {
                builder.EmitPush(BigInteger.Zero);
            }
        }
        builder.EmitPush(probe.Arity);
        builder.Emit(OpCode.PACK);
        builder.EmitPush((byte)CallFlags.All);
        builder.EmitPush(probe.Name);
        builder.EmitPush(hash.GetSpan());
        builder.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
        return builder.ToArray();
    }
}
