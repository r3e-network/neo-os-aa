// The actual ApplicationEngine, driven by a reviewed sequence of calls with real
// arguments over established state.
//
// `abi-dispatch` calls every ABI name once with arity-matched zero arguments. That
// answers "does the dispatcher resolve the name", and nothing about what a method
// does: 61 of the 100 methods stop at their first argument guard, so their bodies
// and their declared return types are never reached.
//
// This mode executes a scenario instead: an ordered list of calls, each with
// literal arguments and a named signer, over one deployment. Writes and the reads
// that follow them are both recorded, so a consumer can confront "what the engine
// answered" with "what was written". The scenario is input, not evidence: it says
// what to call, and the dump says what happened.
//
// What this is: a measurement of one artifact, one engine version, and the exact
// call sequence the scenario declares, each call at the block time the scenario
// declares for it. What it is not: a proof about the contract's semantics, a
// statement about calls outside that sequence, or a claim that a fault-free run
// is a correct run. A step that faults is not rolled back in this harness - the
// engines share one storage snapshot - so the scenario must not build on top of
// a step it expected to fail. `abi_scenario` checks that.
//
// Time is per step because every timelock in this contract is a comparison
// against `Runtime.Time`, and a harness frozen at one timestamp can only ever
// reach the refusing side of each of them. The timestamp is *declared* by the
// scenario, not read from a clock, and the receipt records the one each call ran
// at, so a boundary pair - the same call one millisecond before the window and
// exactly at it, faulting and then halting - is evidence that the harness really
// moved rather than a claim that it did.
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using JsonSerializer = System.Text.Json.JsonSerializer;
using Neo;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.SmartContract.Testing;
using Neo.VM;

internal static class AbiScenario
{
    private const int StepLimit = 400_000;
    private const long GasLimit = 100_000_000_000;

    private static readonly JsonSerializerOptions Options = new() { MaxDepth = 512 };

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    public static int Dump(string destination, string scenarioPath, string nefPath, string manifestPath)
    {
        byte[] nefBytes = File.ReadAllBytes(nefPath);
        byte[] manifestBytes = File.ReadAllBytes(manifestPath);
        byte[] scenarioBytes = File.ReadAllBytes(scenarioPath);
        var nef = NefFile.Parse(nefBytes, verify: true);
        var manifest = ContractManifest.Parse(Encoding.UTF8.GetString(manifestBytes));

        var root = JsonDocument.Parse(scenarioBytes).RootElement;
        if (root.GetProperty("schema").GetString() != "sa-abi-scenario-input/v1")
            throw new InvalidDataException("unsupported scenario schema");
        string name = root.GetProperty("name").GetString()!;
        ulong blockTimestamp = root.GetProperty("blockTimestamp").GetUInt64();
        var defaultSigner = UInt160.Parse(root.GetProperty("defaultSigner").GetString()!);
        var deploySigner = root.TryGetProperty("deploySigner", out var deploy)
            ? UInt160.Parse(deploy.GetString()!)
            : defaultSigner;

        var test = new TestEngine(initializeNativeContracts: true) { Fee = GasLimit, ResetFeeConsumed = true };
        // The transaction sender is the account `_deploy` records as the contract
        // admin, so the deployment signer is part of the scenario rather than a
        // property of the harness.
        test.SetTransactionSigners(new Signer { Account = deploySigner, Scopes = WitnessScope.Global });
        var proxy = test.Deploy<SmartContract>(nef, manifest, null, null);
        var hash = UInt160.Parse(proxy.Hash.ToString());
        var state = NativeContract.ContractManagement.GetContract(test.Storage.Snapshot, hash)
            ?? throw new InvalidDataException("the engine did not store the deployed contract");

        // Other contracts the calls are made against. Most of this contract is only
        // reachable once a plugin it admits is actually deployed: a verifier body
        // cannot run without a verifier, and the admission check reads the deployed
        // manifest rather than a source file. Each module is named here, pinned by
        // the sha256 of the bytes that were deployed, and addressable as a step
        // target, so the receipt can say which artifacts the run installed.
        var modules = new List<object>();
        var moduleAddresses = new Dictionary<string, UInt160>(StringComparer.Ordinal);
        if (root.TryGetProperty("modules", out var declaredModules))
        {
            string scenarioDirectory = Path.GetDirectoryName(Path.GetFullPath(scenarioPath))!;
            foreach (var module in declaredModules.EnumerateArray())
            {
                string moduleName = module.GetProperty("name").GetString()!;
                string moduleNef = Path.GetFullPath(Path.Combine(scenarioDirectory,
                    module.GetProperty("nef").GetString()!));
                string moduleManifest = Path.GetFullPath(Path.Combine(scenarioDirectory,
                    module.GetProperty("manifest").GetString()!));
                byte[] moduleNefBytes = File.ReadAllBytes(moduleNef);
                byte[] moduleManifestBytes = File.ReadAllBytes(moduleManifest);
                var moduleNefFile = NefFile.Parse(moduleNefBytes, verify: true);
                var moduleContractManifest = ContractManifest.Parse(Encoding.UTF8.GetString(moduleManifestBytes));
                var moduleSigner = UInt160.Parse(module.GetProperty("signer").GetString()!);
                test.SetTransactionSigners(new Signer { Account = moduleSigner, Scopes = WitnessScope.Global });
                var moduleProxy = test.Deploy<SmartContract>(moduleNefFile, moduleContractManifest, null, null);
                var moduleAddress = UInt160.Parse(moduleProxy.Hash.ToString());
                moduleAddresses[moduleName] = moduleAddress;
                modules.Add(new
                {
                    name = moduleName,
                    address = moduleAddress.ToString(),
                    signer = moduleSigner.ToString(),
                    admin = moduleSigner.ToString(),
                    nef = module.GetProperty("nef").GetString(),
                    manifest = module.GetProperty("manifest").GetString(),
                    nefSha256 = Sha(moduleNefBytes),
                    manifestSha256 = Sha(moduleManifestBytes),
                    scriptLength = moduleNefFile.Script.Length,
                    scriptSha256 = Sha(moduleNefFile.Script.ToArray()),
                    methods = moduleContractManifest.Abi.Methods.Length
                });
            }
        }

        var steps = new List<object>();
        var timestamps = new SortedSet<ulong>();
        foreach (var step in root.GetProperty("steps").EnumerateArray())
        {
            var row = new Dictionary<string, object?>
            {
                ["id"] = step.GetProperty("id").GetString(),
                ["method"] = step.GetProperty("method").GetString(),
            };
            // The block time this call runs at. Declared per step, defaulting to the
            // scenario's base time, and recorded in the receipt so that a consumer can
            // see which side of a timelock each call was on.
            ulong timestamp = step.TryGetProperty("timestamp", out var declaredTime)
                ? declaredTime.GetUInt64()
                : blockTimestamp;
            row["timestamp"] = timestamp;
            timestamps.Add(timestamp);
            byte[] script;
            int argumentCount;
            string target = "account";
            UInt160 targetAddress;
            try
            {
                if (step.TryGetProperty("target", out var declaredTarget))
                    target = declaredTarget.GetString()!;
                targetAddress = Target(hash, moduleAddresses, target);
                script = Frame(step, targetAddress, out argumentCount);
            }
            catch (Exception error)
            {
                row["buildError"] = error.GetType().Name + ": " + error.Message.Split('\n')[0];
                steps.Add(row);
                continue;
            }
            row["target"] = target;
            row["argumentCount"] = argumentCount;
            row["scriptHex"] = Convert.ToHexString(script).ToLowerInvariant();
            row["scriptSha256"] = Sha(script);

            var signer = step.TryGetProperty("signer", out var signerText) && signerText.ValueKind == JsonValueKind.String
                ? UInt160.Parse(signerText.GetString()!)
                : defaultSigner;
            row["signer"] = signer.ToString();
            test.SetTransactionSigners(new Signer { Account = signer, Scopes = WitnessScope.Global });

            try
            {
                // `Runtime.Time` is the persisting block's timestamp, so a step that
                // declares a later time is given a block at that time. Storage is the
                // same snapshot across steps, which is what a later transaction on a
                // later block would also see.
                var engine = ApplicationEngine.Create(TriggerType.Application, test.Transaction, test.Storage.Snapshot,
                    BlockAt(timestamp), test.ProtocolSettings, GasLimit, null);
                engine.LoadScript(new Script(script), -1, 0);
                var observation = VmRun.Step(engine, targetAddress, StepLimit);
                row["state"] = observation.State;
                row["fault"] = observation.Fault;
                row["faultDetail"] = observation.FaultDetail;
                row["steps"] = observation.Steps;
                row["stepLimitReached"] = observation.StepLimitReached;
                row["executedOffsets"] = observation.ExecutedInContract.Count;
                row["executedForeign"] = observation.ExecutedForeign;
                row["firstIps"] = observation.FirstIps;
                row["syscalls"] = observation.Syscalls;
                row["syscallsTruncated"] = observation.SyscallsTruncated;
                foreach (var pair in observation.Result) row["result" + char.ToUpperInvariant(pair.Key[0]) + pair.Key[1..]] = pair.Value;
            }
            catch (Exception error)
            {
                row["engineError"] = error.GetType().Name + ": " + error.Message.Split('\n')[0];
            }
            steps.Add(row);
        }

        var declarations = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (var method in state.Manifest.Abi.Methods)
            declarations[method.Name + '/' + method.Parameters.Length] = method.Offset;

        var report = new Dictionary<string, object?>
        {
            ["schema"] = "sa-abi-scenario/v1",
            ["scenario"] = new { path = scenarioPath, sha256 = Sha(scenarioBytes), name, steps = steps.Count },
            ["nef"] = new { path = nefPath, sha256 = Sha(nefBytes), scriptLength = nef.Script.Length },
            ["script"] = new
            {
                length = nef.Script.Length,
                sha256 = Sha(nef.Script.ToArray())
            },
            ["manifest"] = new { path = manifestPath, sha256 = Sha(manifestBytes), methods = manifest.Abi.Methods.Length },
            ["deployed"] = new { hash = hash.ToString(), deploySigner = deploySigner.ToString(),
                                 admin = deploySigner.ToString(), gasLimit = GasLimit },
            ["block"] = new { timestamp = blockTimestamp, index = 1,
                              timestamps = timestamps.Select(value => (object)value).ToArray() },
            ["engine"] = new
            {
                neo = typeof(ApplicationEngine).Assembly.GetName().Version?.ToString(),
                vm = typeof(OpCode).Assembly.GetName().Version?.ToString(),
                testing = typeof(TestEngine).Assembly.GetName().Version?.ToString()
            },
            ["declaredOffsets"] = declarations,
            ["modules"] = modules,
            ["steps"] = steps
        };
        File.WriteAllText(destination, JsonSerializer.Serialize(report, Options));
        return 0;
    }

    /// <summary>
    /// The call frame for one step: the arguments in declared order, packed into
    /// the ABI array, then `System.Contract.Call(All, method, contract)`.
    ///
    /// PACK fills index 0 from the top of the stack, so the arguments are pushed
    /// in reverse and the first declared argument comes back as element 0. That
    /// ordering is invisible in the dispatch mode, which pushes arity-matched
    /// zeros, and it was measured here rather than assumed: the first draft
    /// pushed in declared order and every call arrived with its arguments
    /// rotated, which the register step reported as a missing backup owner.
    ///
    /// The bytes are built with the same ScriptBuilder the dispatch mode uses, so
    /// an independent reader has one encoding to reproduce rather than two.
    /// </summary>
    private static byte[] Frame(JsonElement step, UInt160 contract, out int argumentCount)
    {
        var arguments = step.TryGetProperty("args", out var args)
            ? args.EnumerateArray().Select(argument => argument.Clone()).ToList()
            : new List<JsonElement>();
        var builder = new ScriptBuilder();
        for (int index = arguments.Count - 1; index >= 0; index--) Push(builder, arguments[index]);
        builder.EmitPush(arguments.Count);
        builder.Emit(OpCode.PACK);
        builder.EmitPush((byte)CallFlags.All);
        builder.EmitPush(step.GetProperty("method").GetString()!);
        builder.EmitPush(contract.GetSpan());
        builder.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
        argumentCount = arguments.Count;
        return builder.ToArray();
    }

    /// <summary>
    /// One declared argument. The type names are the wire vocabulary, not the C#
    /// parameter types, so a `Hash160` argument and a 20-byte `ByteString`
    /// argument are the same bytes on the stack and different words here.
    /// </summary>
    private static void Push(ScriptBuilder builder, JsonElement argument)
    {
        string type = argument.GetProperty("type").GetString()
            ?? throw new InvalidDataException("argument without a type");
        switch (type)
        {
            case "Hash160":
                builder.EmitPush(UInt160.Parse(Value(argument)).GetSpan());
                break;
            case "Hash256":
                builder.EmitPush(UInt256.Parse(Value(argument)).GetSpan());
                break;
            case "ByteString":
                builder.EmitPush(Convert.FromHexString(Value(argument)));
                break;
            case "Integer":
                builder.EmitPush(BigInteger.Parse(Value(argument)));
                break;
            case "String":
                builder.EmitPush(Value(argument));
                break;
            case "Boolean":
                builder.EmitPush(argument.GetProperty("value").GetBoolean());
                break;
            case "Null":
                builder.Emit(OpCode.PUSHNULL);
                break;
            case "Array":
                var items = argument.TryGetProperty("items", out var declared)
                    ? declared.EnumerateArray().Select(item => item.Clone()).ToList()
                    : new List<JsonElement>();
                for (int index = items.Count - 1; index >= 0; index--) Push(builder, items[index]);
                builder.EmitPush(items.Count);
                builder.Emit(OpCode.PACK);
                break;
            default:
                throw new InvalidDataException("unsupported argument type: " + type);
        }
    }

    private static string Value(JsonElement argument) =>
        argument.GetProperty("value").GetString()
        ?? throw new InvalidDataException("argument without a value");

    /// <summary>
    /// Which contract a step calls. The default is the account under test; a module
    /// name reaches one of the extra deployments this scenario declared. An unknown
    /// name is refused rather than silently calling the account, because a step that
    /// quietly aimed somewhere else would still look like a call to the account in
    /// the receipt.
    /// </summary>
    private static UInt160 Target(UInt160 account, Dictionary<string, UInt160> modules, string name)
    {
        if (name == "account") return account;
        if (modules.TryGetValue(name, out var address)) return address;
        throw new InvalidDataException("no deployed module named " + name);
    }

    /// <summary>
    /// The persistent block a call runs in, at the declared time. Nothing else about
    /// the block varies: the harness is not modelling a chain, only the one field
    /// `Runtime.Time` reads.
    /// </summary>
    private static Block BlockAt(ulong timestamp) => new()
    {
        Header = new Header
        {
            Version = 0, PrevHash = UInt256.Zero, MerkleRoot = UInt256.Zero,
            Timestamp = timestamp, Nonce = 0, Index = 1, PrimaryIndex = 0, NextConsensus = UInt160.Zero,
            Witness = new Witness
            {
                InvocationScript = Array.Empty<byte>(),
                VerificationScript = Array.Empty<byte>()
            }
        },
        Transactions = Array.Empty<Transaction>()
    };
}
