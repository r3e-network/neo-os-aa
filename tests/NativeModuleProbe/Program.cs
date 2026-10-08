using System.Text.Json;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Native;
using Neo.VM.Types;

if (args.Length != 2) throw new ArgumentException("Expected native artifact directory and output file.");
string artifacts = args[0], output = args[1];
var report = new Dictionary<string, object?>
{
    ["schema"] = "smartaccount-native-nef-probe/v1",
    ["status"] = "RUNNING",
    ["publicNetworksTouched"] = false,
    ["boundary"] = "In-memory ApplicationEngine probes using unsigned host transactions. Fault injection is not an on-chain attack or cryptographic evidence."
};
void Write() => File.WriteAllText(output, System.Text.Json.JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Write();
try
{
    using var harness = new ProbeHarness();
    ProbeTests.Collector(harness.Snapshot, harness.Settings);
    report["collectorControls"] = new[] { "both-directions", "fault-before-completion", "coincident-successor", "all-conditional-opcodes" };
    UInt160 hook = harness.Deploy(artifacts);
    UInt160 account = harness.Register(hook, 1), other = harness.Register(hook, 2);
    int hookId = NativeContract.ContractManagement.GetContract(harness.Snapshot, hook)!.Id;
    List<object> tokens = [];
    HashSet<StackItemType> observedTypes = [];
    int tokenId = 1000;
    foreach (string kind in ProbeHarness.BalanceKinds)
    {
        ContractState token = harness.Token(kind, tokenId++);
        StackItem observed = harness.Call("query-" + kind, token.Hash, "balanceOf", [account], commit: false);
        observedTypes.Add(observed.Type);
        ProbeTests.Require(observed.Type.ToString().ToLowerInvariant() == (kind switch
        {
            "zero" or "positive" or "negative" => "integer",
            "bytes" => "bytestring",
            "null" => "any",
            "interop" => "interopinterface",
            _ => kind
        }), "Unexpected diagnostic VM type: " + kind + ": " + observed.Type);
        tokens.Add(new { kind, vmType = observed.Type.ToString(), scriptHex = Convert.ToHexStringLower(token.Nef.Script.Span), nefSha256 = ProbeHarness.Hash(token.Nef.ToArray()) });
        harness.Configure(account, token.Hash, true);
        harness.Execute(account, "pre-balance-" + kind, kind is "zero" or "positive" ? null : "Invalid restricted token balance");
        harness.Configure(account, token.Hash, false);
        harness.DeleteToken(token);
    }
    ProbeTests.Require(observedTypes.SetEquals(Enum.GetValues<StackItemType>()), "Balance probes must cover every defined VM stack-item type.");
    report["balanceTypes"] = tokens;
    report["postBalanceTypes"] = ProbeTests.PostBalanceTypes(harness, hook, account, harness.ModeToken(tokenId++));
    report["allVmTypesPreAndPostVerified"] = true;
    report["malformedCallbackCases"] = ProbeTests.CallbackShapes(harness, hook, account);
    report["directPhaseAndMalformedCallbacksVerified"] = true;
    ContractState valid = harness.Token("positive", tokenId++);
    harness.Configure(account, valid.Hash, true);
    StorageKey snapshot = ProbeHarness.Key(hookId, 2, account, valid.Hash);
    int deleted = 0;
    harness.Trace!.NativeCall = (engine, target, method, args) =>
    {
        if (target != hook || method != "postExecute") return;
        ProbeTests.Require(engine.SnapshotCache.Contains(snapshot), "Snapshot injection must remove an actual snapshot.");
        engine.SnapshotCache.Delete(snapshot);
        deleted++;
    };
    harness.Execute(account, "missing-snapshot-injection", "Missing restricted balance snapshot");
    ProbeTests.Require(deleted == 1, "Missing-snapshot injection must occur exactly once.");
    harness.Trace.NativeCall = null;
    harness.Execute(account, "positive-after-snapshot-fault");
    // Seed deliberate stale snapshots, including an unrelated account, only in the host probe.
    harness.Snapshot.Add(snapshot, new StorageItem(new byte[] { 42 }));
    StorageKey isolated = ProbeHarness.Key(hookId, 2, other, valid.Hash);
    harness.Snapshot.Add(isolated, new StorageItem(new byte[] { 43 }));
    harness.Configure(account, valid.Hash, false);
    ProbeTests.Require(!harness.Snapshot.Contains(snapshot) && harness.Snapshot[isolated].Value.Span.SequenceEqual(new byte[] { 43 }), "Removal must clear its snapshot and isolate other accounts.");
    harness.Configure(account, valid.Hash, true);
    harness.Snapshot.Add(snapshot, new StorageItem(new byte[] { 44 }));
    harness.Call("remove-hook-proposal", ProbeHarness.Core, "proposeHook", [account, UInt160.Zero]);
    harness.Time += ProbeHarness.Delay;
    harness.Call("remove-hook-confirm", ProbeHarness.Core, "activateHook", [account]);
    ProbeTests.Require(!harness.Snapshot.Contains(snapshot) && !harness.Snapshot.Contains(ProbeHarness.Key(hookId, 1, account, valid.Hash)), "Cleanup must clear both prefixes.");
    ProbeTests.Require(harness.Snapshot[isolated].Value.Span.SequenceEqual(new byte[] { 43 }), "Cleanup must preserve another account's stale snapshot.");
    report["faultInjectionCount"] = deleted;
    report["staleSnapshotRemovalAndIsolation"] = true;
    report["staleSnapshotCleanupAndIsolation"] = true;
    ProbeTests.Administration(harness, hook, artifacts);
    report["administrationAndIdenticalArtifactUpdate"] = true;
    report["cases"] = harness.Cases;
    report["coverage"] = harness.Trace.Report();
    report["productionArtifacts"] = new[] { "TokenRestrictedHook.nef", "TokenRestrictedHook.manifest.json" }
        .ToDictionary(name => name, name => ProbeHarness.Hash(File.ReadAllBytes(Path.Combine(artifacts, name))));
    report["loadedAssemblies"] = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
        .Where(assembly => Path.GetDirectoryName(assembly.Location) == AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar))
        .ToDictionary(assembly => Path.GetFileName(assembly.Location), assembly => ProbeHarness.Hash(File.ReadAllBytes(assembly.Location)));
    report["status"] = "PASS";
}
catch (Exception error)
{
    report["status"] = "FAIL";
    report["failureType"] = error.GetType().Name;
    throw;
}
finally { Write(); }
