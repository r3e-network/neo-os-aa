using System.Diagnostics;
using System.Numerics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Cryptography;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing;
using Neo.SmartContract.Testing.Exceptions;
using Neo.SmartContract.Testing.Extensions;
using Neo.VM;
using Neo.VM.Types;
using NeoArray = Neo.VM.Types.Array;

namespace SmartAccount.Module.Tests;

/// <summary>
/// Execution harness for the five standard modules: a real Neo engine, the
/// module NEFs produced by the module build, and a purpose-built core double
/// that reproduces the v4.1 seams the modules consume.
///
/// The harness never touches the native core: that contract belongs to another
/// lane, and its own suite already proves its semantics. Everything here proves
/// module behaviour against the published contracts.
/// </summary>
internal sealed class ModuleHarness : IDisposable
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    /// <summary>The checkout root, so a suite can drive a script that lives in the repository.</summary>
    internal static string RepositoryRoot => RepoRoot;

    private static readonly UInt160 ContractManagementHash =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    private static readonly FieldInfo FeeAmountField =
        typeof(ApplicationEngine).GetField("_feeAmount", BindingFlags.Instance | BindingFlags.NonPublic)!;

    private static readonly object BuildLock = new();
    private static bool _mockArtifactsChecked;

    private static readonly string ModuleArtifactDirectory =
        Environment.GetEnvironmentVariable("SMARTACCOUNT_MODULE_ARTIFACT_DIR") is { Length: > 0 } configured
            ? Path.GetFullPath(configured)
            : Path.Combine(RepoRoot, "contracts", "bin", "public", "modules");

    private static readonly string MockArtifactDirectory =
        Path.Combine(RepoRoot, "tests", "SmartAccount.Module.Tests", "artifacts", "mock");

    /// <summary>
    /// The compiled validator plugin artifacts. A validator test deploys the very
    /// NEF the project ships, so the preimage path under test is the deployed code.
    /// </summary>
    private static readonly string ValidatorArtifactDirectory =
        Environment.GetEnvironmentVariable("SMARTACCOUNT_VALIDATOR_ARTIFACT_DIR") is { Length: > 0 } configuredValidators
            ? Path.GetFullPath(configuredValidators)
            : Path.Combine(RepoRoot, "contracts", "bin", "public", "validators");

    internal static readonly string[] ModuleNames =
    {
        "GovernanceModule", "RecoveryModule", "SigningModule", "ThresholdPolicyModule", "HookOrchestratorModule",
    };

    private readonly Dictionary<string, UInt160> _contracts = new(StringComparer.Ordinal);

    public ModuleHarness()
    {
        EnsureMockArtifacts();
        SetSigners(Owner);
        Core = Step("deploy core", () => Deploy(MockArtifactDirectory, "MockModuleCore"));
        foreach (string name in ModuleNames)
            _contracts[name] = Step("deploy " + name, () => Deploy(ModuleArtifactDirectory, name));
        TestHook = Step("deploy hook", () => Deploy(MockArtifactDirectory, "TestHook"));
        foreach (UInt160 module in _contracts.Values)
            Step("authorize " + module, () => { CallVoid(module, "setAuthorizedCore", Core); return module; });
    }

    private static T Step<T>(string label, Func<T> action)
    {
        try
        {
            return action();
        }
        catch (Exception error)
        {
            throw new InvalidOperationException("harness step failed: " + label + Environment.NewLine + error, error);
        }
    }

    public TestEngine Engine { get; } = new();

    public UInt160 Owner => Engine.ValidatorsAddress;

    public UInt160 Core { get; }

    public UInt160 TestHook { get; }

    public UInt160 Contract(string name) => _contracts[name];

    /// <summary>
    /// Deploys one real validator plugin artifact (from
    /// <c>contracts/bin/public/validators</c>) once and authorizes the core
    /// double for it, so validator suites exercise the shipped code.
    /// </summary>
    public UInt160 DeployValidator(string baseName)
    {
        if (_contracts.TryGetValue(baseName, out UInt160? deployed)) return deployed!;
        EnsureValidatorArtifact(baseName);
        UInt160 module = Step("deploy " + baseName, () => Deploy(ValidatorArtifactDirectory, baseName));
        Step("authorize " + baseName, () => { CallVoid(module, "setAuthorizedCore", Core); return module; });
        _contracts[baseName] = module;
        return module;
    }

    /// <summary>The ABI method names a module publishes, read from its generated manifest.</summary>
    public static IReadOnlyList<string> ModuleAbiMethods(string baseName)
    {
        string path = Path.Combine(ModuleArtifactDirectory, baseName + ".manifest.json");
        ContractManifest manifest = ContractManifest.Parse(File.ReadAllText(path));
        return manifest.Abi.Methods.Select(method => method.Name).ToArray();
    }

    /// <summary>Whether one ABI method is declared <c>Safe</c> in the generated manifest.</summary>
    public static bool ModuleAbiMethodIsSafe(string baseName, string method)
    {
        string path = Path.Combine(ModuleArtifactDirectory, baseName + ".manifest.json");
        ContractManifest manifest = ContractManifest.Parse(File.ReadAllText(path));
        var entry = manifest.Abi.Methods.FirstOrDefault(m => m.Name == method);
        Assert.IsNotNull(entry, baseName + "." + method + " is not in the ABI");
        return entry!.Safe;
    }

    public void Dispose() { }

    /// <summary>The generated NEF of one module, parsed for native-token inspection.</summary>
    public static NefFile ModuleNef(string baseName) =>
        NefFile.Parse(File.ReadAllBytes(Path.Combine(ModuleArtifactDirectory, baseName + ".nef")));

    // ---- deployment ----

    private UInt160 Deploy(string directory, string baseName)
    {
        byte[] nefBytes = File.ReadAllBytes(Path.Combine(directory, baseName + ".nef"));
        string manifestText = File.ReadAllText(Path.Combine(directory, baseName + ".manifest.json"));
        NefFile nef = NefFile.Parse(nefBytes, verify: true);
        ContractManifest manifest = ContractManifest.Parse(manifestText);
        UInt160 hash = Engine.GetDeployHash(nef, manifest);
        _ = Call(ContractManagementHash, "deploy", nef.ToArray(), manifestText, null);
        return hash;
    }

    /// <summary>
    /// Builds the test doubles once per process when their NEFs are absent, so
    /// <c>dotnet test</c> is self-sufficient after the module build.
    /// </summary>
    private static void EnsureMockArtifacts()
    {
        lock (BuildLock)
        {
            if (_mockArtifactsChecked) return;
            _mockArtifactsChecked = true;
            foreach (string project in new[] { "MockModuleCore", "TestHook" })
            {
                string directory = Path.Combine(RepoRoot, "tests", "SmartAccount.Module.Tests", "Contracts", project);
                string csproj = Path.Combine(directory, project + ".csproj");
                string nef = Path.Combine(MockArtifactDirectory, project + ".nef");
                if (File.Exists(nef)) continue;
                using Process process = Process.Start(new ProcessStartInfo
                {
                    FileName = "dotnet",
                    Arguments = $"build \"{csproj}\" -p:RunNccsAfterBuild=true -v q",
                    WorkingDirectory = directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                })!;
                string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                process.WaitForExit();
                Assert.AreEqual(0, process.ExitCode, "Building the test double failed:\n" + output);
                Assert.IsTrue(File.Exists(nef), "The test double NEF was not produced: " + nef);
            }
        }
    }

    /// <summary>
    /// Builds a validator plugin once per process when its NEF is absent, using
    /// the same <c>nccs</c> target as the module build, so the suite is
    /// self-sufficient on a clean tree.
    /// </summary>
    private static void EnsureValidatorArtifact(string baseName)
    {
        lock (BuildLock)
        {
            string nef = Path.Combine(ValidatorArtifactDirectory, baseName + ".nef");
            if (File.Exists(nef)) return;
            string directory = Path.Combine(RepoRoot, "contracts", "plugins", "validators");
            string csproj = Path.Combine(directory, baseName + ".csproj");
            using Process process = Process.Start(new ProcessStartInfo
            {
                FileName = "dotnet",
                Arguments = $"build \"{csproj}\" -p:RunNccsAfterBuild=true -v q",
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            })!;
            string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
            process.WaitForExit();
            Assert.AreEqual(0, process.ExitCode, "Building " + baseName + " failed:\n" + output);
            Assert.IsTrue(File.Exists(nef), "The validator NEF was not produced: " + nef);
        }
    }

    // ---- account fixtures ----

    public static UInt160 AccountId(string label) => new(Crypto.Hash160(Encoding.UTF8.GetBytes(label)));

    public UInt160 CreateAccount(string label, UInt160 custody)
    {
        UInt160 accountId = AccountId(label);
        SetSigners(Owner);
        CallVoid(Core, "createAccount", accountId, custody);
        return accountId;
    }

    public BigInteger AccountField(UInt160 accountId, int index) =>
        ((NeoArray)Call(Core, "getAccount", accountId))[index].GetInteger();

    public BigInteger Status(UInt160 accountId) => AccountField(accountId, 1);

    public UInt160 Custody(UInt160 accountId) =>
        (UInt160)TestExtensions.ConvertTo(((NeoArray)Call(Core, "getAccount", accountId))[2], typeof(UInt160))!;

    public BigInteger Epoch(UInt160 accountId) => AccountField(accountId, 3);

    public BigInteger ConfigurationNonce(UInt160 accountId) => AccountField(accountId, 4);

    public void SetStatus(UInt160 accountId, int status)
    {
        SetSigners(Owner);
        CallVoid(Core, "setStatus", accountId, (BigInteger)status);
    }

    public void SetEpoch(UInt160 accountId, BigInteger epoch)
    {
        SetSigners(Owner);
        CallVoid(Core, "setEpoch", accountId, epoch);
    }

    public void SetConfigurationNonce(UInt160 accountId, BigInteger nonce)
    {
        SetSigners(Owner);
        CallVoid(Core, "setConfigurationNonce", accountId, nonce);
    }

    // ---- module installation ----

    public readonly record struct Flags(
        bool Isolation = false,
        bool Message = false,
        bool Eligible = false,
        bool Composite = false,
        bool Governance = false,
        bool Planner = false);

    /// <summary>
    /// The seat bits the native core derives from the module's own canonical
    /// profile (<c>BindProfileAsync</c>). Reading them from the deployed getter
    /// instead of a per-module table keeps this double honest: a profile that
    /// stops declaring a seat makes its routed callback unauthenticated here for
    /// the same reason it would be on chain.
    /// </summary>
    private Flags ProfileFlags(UInt160 module)
    {
        string raw = ((ByteString)Call(module, "getModuleProfile")).GetString()
            ?? throw new InvalidOperationException("getModuleProfile returned no text");
        using System.Text.Json.JsonDocument document = System.Text.Json.JsonDocument.Parse(raw);
        System.Text.Json.JsonElement caps = document.RootElement.GetProperty("capabilities");

        bool Flag(string name) => caps.TryGetProperty(name, out System.Text.Json.JsonElement value)
            && value.ValueKind == System.Text.Json.JsonValueKind.True;

        return new Flags(
            Isolation: Flag("instanceIsolation"),
            Message: Flag("messageCapability"),
            Eligible: Flag("thresholdMemberEligible"),
            Composite: caps.TryGetProperty("compositeLayer", out System.Text.Json.JsonElement layer)
                && layer.GetInt32() != 0,
            Governance: Flag("governance"),
            Planner: Flag("hookPlanner"));
    }

    public BigInteger Install(UInt160 accountId, string moduleName, int moduleType, object[]? initData = null,
        Flags? flags = null)
    {
        SetSigners(Owner);
        BigInteger moduleId = CallInteger(Core, "installModule", accountId, (BigInteger)moduleType,
            Contract(moduleName), initData ?? System.Array.Empty<object>());
        Flags effective = flags ?? ProfileFlags(Contract(moduleName));
        CallVoid(Core, "setModuleFlags", accountId, moduleId, effective.Isolation, effective.Message,
            effective.Eligible, effective.Composite, effective.Governance, effective.Planner);
        return moduleId;
    }

    public BigInteger InstallHook(UInt160 accountId)
    {
        SetSigners(Owner);
        return CallInteger(Core, "installModule", accountId, (BigInteger)4, TestHook,
            System.Array.Empty<object>());
    }

    public void Configure(UInt160 accountId, BigInteger moduleId, object[] configData)
    {
        SetSigners(Owner);
        CallVoid(Core, "configureModule", accountId, moduleId, configData);
    }

    public BigInteger ModuleIdOf(UInt160 accountId, string moduleType, UInt160 contract)
    {
        foreach (BigInteger id in ModuleIds(accountId, moduleType))
            if (DescriptorField(accountId, id, 2) == contract) return id;
        return BigInteger.Zero;
    }

    public BigInteger[] ModuleIds(UInt160 accountId, string moduleType)
    {
        NeoArray page = (NeoArray)Call(Core, "getModules", accountId, moduleType, (BigInteger)0, (BigInteger)32);
        NeoArray ids = (NeoArray)page[0];
        BigInteger[] result = new BigInteger[ids.Count];
        for (int i = 0; i < ids.Count; i++) result[i] = ids[i].GetInteger();
        return result;
    }

    public UInt160 DescriptorField(UInt160 accountId, BigInteger moduleId, int index) =>
        (UInt160)TestExtensions.ConvertTo(((NeoArray)Call(Core, "getModule", accountId, moduleId))[index],
            typeof(UInt160))!;

    public BigInteger DescriptorInteger(UInt160 accountId, BigInteger moduleId, int index) =>
        ((NeoArray)Call(Core, "getModule", accountId, moduleId))[index].GetInteger();

    // ---- callback drivers (phase is routed by the core double) ----

    public bool InvokeBool(UInt160 accountId, BigInteger moduleId, int phase, string method, params object?[] args)
    {
        SetSigners(Owner);
        return CallBoolean(Core, "invokeBool", accountId, moduleId, (BigInteger)phase, method, args);
    }

    public BigInteger InvokeInteger(UInt160 accountId, BigInteger moduleId, int phase, string method,
        params object?[] args)
    {
        SetSigners(Owner);
        return CallInteger(Core, "invokeInt", accountId, moduleId, (BigInteger)phase, method, args);
    }

    public byte[] InvokeBytes(UInt160 accountId, BigInteger moduleId, int phase, string method,
        params object?[] args)
    {
        SetSigners(Owner);
        return CallBytes(Core, "invokeBytes", accountId, moduleId, (BigInteger)phase, method, args);
    }

    public NeoArray InvokeArray(UInt160 accountId, BigInteger moduleId, int phase, string method,
        params object?[] args)
    {
        SetSigners(Owner);
        return (NeoArray)Call(Core, "invokeArray", accountId, moduleId, (BigInteger)phase, method, args);
    }

    public void InvokeVoid(UInt160 accountId, BigInteger moduleId, int phase, string method, params object?[] args)
    {
        SetSigners(Owner);
        CallVoid(Core, "invokeVoid", accountId, moduleId, (BigInteger)phase, method, args);
    }

    /// <summary>Dispatches a composite validator with phase 1 and the phase 8 leaf route live.</summary>
    public bool InvokeComposite(UInt160 accountId, BigInteger moduleId, string method, params object?[] args)
    {
        SetSigners(Owner);
        return CallBoolean(Core, "invokeCompositeBool", accountId, moduleId, method, args);
    }

    /// <summary>Test fixture: records that a module's code was updated after install.</summary>
    public void DriftModuleCode(UInt160 accountId, BigInteger moduleId)
    {
        SetSigners(Owner);
        CallVoid(Core, "driftModuleCode", accountId, moduleId);
    }

    /// <summary>Test fixture: advances one instance's credential generation.</summary>
    public void BumpModuleGeneration(UInt160 accountId, BigInteger moduleId)
    {
        SetSigners(Owner);
        CallVoid(Core, "bumpModuleGeneration", accountId, moduleId);
    }

    // ---- composite observations ----

    public void SetMemberApproval(UInt160 accountId, BigInteger memberId, bool approves)
    {
        SetSigners(Owner);
        CallVoid(Core, "setMemberApproval", accountId, memberId, approves);
    }

    // ---- time, signers, assertions ----

    public void SetSigners(params UInt160[] accounts)
    {
        Engine.SetTransactionSigners(accounts
            .Select(account => new Signer { Account = account, Scopes = WitnessScope.Global })
            .ToArray());
    }

    public void AdvanceTime(TimeSpan delta) => Engine.PersistingBlock.Advance(delta);

    public BigInteger Now()
    {
        using ScriptBuilder script = new();
        script.EmitSysCall(ApplicationEngine.System_Runtime_GetTime.Hash);
        return Execute(script).GetInteger();
    }

    public static void AssertFault(string fragment, Action action)
    {
        TestException fault = Assert.ThrowsExactly<TestException>(action);
        StringAssert.Contains(fault.Message, fragment);
    }

    // ---- message digest (spec §8) ----

    public byte[] MessageDigest(UInt160 accountId, UInt160 originalSender, BigInteger validatorId,
        BigInteger generation, BigInteger epoch, byte[] hash)
    {
        using MemoryStream stream = new();
        byte[] domain = Encoding.UTF8.GetBytes("NeoSmartAccount/Message");
        stream.Write(domain, 0, domain.Length);
        stream.WriteByte(4);
        WriteU32Le(stream, Engine.ProtocolSettings.Network);
        Write(stream, Core.ToArray());
        Write(stream, accountId.ToArray());
        Write(stream, originalSender.ToArray());
        WriteU64Be(stream, validatorId);
        WriteU64Be(stream, generation);
        WriteU64Be(stream, epoch);
        Write(stream, hash);
        return SHA256.HashData(stream.ToArray());
    }

    // ---- operation digest (spec §4.3) ----

    /// <summary>
    /// The §4.3 digest preimage of one operation, byte for byte what the native
    /// core hashes: <c>UTF8("NeoSmartAccount/UserOperation") ‖ 0x04 ‖
    /// U32LE(network) ‖ core(20) ‖ accountId(20) ‖ U64BE(validatorId) ‖
    /// U64BE(credentialGeneration) ‖ U64BE(epoch) ‖ U64BE(configurationNonce) ‖
    /// canonical operation</c>, where the canonical view replaces the signature
    /// field with an empty ByteString and serializes the whole 13-field array.
    /// </summary>
    public byte[] OperationPreimage(UInt160 accountId, object?[] operation, uint? network = null)
    {
        using MemoryStream stream = new();
        byte[] domain = Encoding.UTF8.GetBytes("NeoSmartAccount/UserOperation");
        Write(stream, domain);
        stream.WriteByte(4);
        WriteU32Le(stream, network ?? Engine.ProtocolSettings.Network);
        Write(stream, Core.ToArray());
        Write(stream, accountId.ToArray());
        WriteU64Be(stream, (BigInteger)operation[7]!);
        WriteU64Be(stream, (BigInteger)operation[8]!);
        WriteU64Be(stream, (BigInteger)operation[9]!);
        WriteU64Be(stream, (BigInteger)operation[10]!);
        Write(stream, CanonicalOperation(operation));
        return stream.ToArray();
    }

    /// <summary>
    /// The 80-byte threshold member preimage of spec §5
    /// (<c>UTF8("NeoSmartAccount/ThresholdMember") ‖ 0x04 ‖ D ‖ U64BE(memberId) ‖
    /// U64BE(memberCredentialGeneration)</c>).
    /// </summary>
    public static byte[] ThresholdMemberPreimage(byte[] operationDigest, BigInteger memberId,
        BigInteger credentialGeneration)
    {
        using MemoryStream stream = new();
        Write(stream, Encoding.UTF8.GetBytes("NeoSmartAccount/ThresholdMember"));
        stream.WriteByte(4);
        Write(stream, operationDigest);
        WriteU64Be(stream, memberId);
        WriteU64Be(stream, credentialGeneration);
        return stream.ToArray();
    }

    /// <summary>
    /// The delegated-identity preimage of spec §5:
    /// <c>UTF8("NeoSmartAccount/DelegatedIdentity") ‖ 0x04 ‖ signingDigest ‖
    /// U8(providerLength) ‖ provider ‖ masterNullifier ‖ actionNullifier</c>.
    /// </summary>
    public static byte[] IdentityPreimage(byte[] signingDigest, byte[] provider, byte[] masterNullifier,
        byte[] actionNullifier)
    {
        using MemoryStream stream = new();
        Write(stream, Encoding.UTF8.GetBytes("NeoSmartAccount/DelegatedIdentity"));
        stream.WriteByte(4);
        Write(stream, signingDigest);
        stream.WriteByte((byte)provider.Length);
        Write(stream, provider);
        Write(stream, masterNullifier);
        Write(stream, actionNullifier);
        return stream.ToArray();
    }

    /// <summary>
    /// A complete v4 operation exactly as a client submits it; the signature
    /// field is replaced by <paramref name="signature"/>, which is either the
    /// raw 64-byte member signature (standalone route) or the serialized member
    /// list (threshold route).
    /// </summary>
    public static object?[] Operation(UInt160 target, string method, object?[] args,
        BigInteger nonce, BigInteger validatorId, BigInteger credentialGeneration, BigInteger epoch,
        BigInteger configurationNonce, byte[] signature, object?[]? hookProofs = null) =>
    [
        (BigInteger)4, target, method, args, nonce, new byte[32], (BigInteger)long.MaxValue,
        validatorId, credentialGeneration, epoch, configurationNonce, signature,
        hookProofs ?? System.Array.Empty<object>(),
    ];

    private static byte[] CanonicalOperation(object?[] operation)
    {
        NeoArray canonical = new();
        for (int i = 0; i < operation.Length; i++)
            canonical.Add(i == 11
                ? new Neo.VM.Types.ByteString(System.Array.Empty<byte>())
                : ToStackItem(operation[i]));
        return BinarySerializer.Serialize(canonical, ExecutionEngineLimits.Default);
    }

    private static StackItem ToStackItem(object? value) => value switch
    {
        null => StackItem.Null,
        StackItem item => item,
        BigInteger number => new Integer(number),
        int number => new Integer(number),
        long number => new Integer(number),
        uint number => new Integer(number),
        bool flag => flag ? StackItem.True : StackItem.False,
        string text => new Neo.VM.Types.ByteString(Encoding.UTF8.GetBytes(text)),
        UInt160 hash => new Neo.VM.Types.ByteString(hash.ToArray()),
        byte[] bytes => new Neo.VM.Types.ByteString(bytes),
        object?[] items => ToArray(items),
        _ => throw new NotSupportedException($"Unsupported operation field: {value.GetType()}"),
    };

    private static NeoArray ToArray(object?[] items)
    {
        NeoArray array = new();
        foreach (object? item in items) array.Add(ToStackItem(item));
        return array;
    }

    private static void Write(Stream stream, byte[] value) => stream.Write(value, 0, value.Length);

    private static void WriteU32Le(Stream stream, uint value)
    {
        for (int i = 0; i < 4; i++) stream.WriteByte((byte)(value >> (8 * i)));
    }

    private static void WriteU64Be(Stream stream, BigInteger value)
    {
        for (int i = 7; i >= 0; i--) stream.WriteByte((byte)((value >> (8 * i)) & 255));
    }

    // ---- VM plumbing ----

    public StackItem Call(UInt160 target, string method, params object?[] args)
    {
        ContractParameter argsArray = new(ContractParameterType.Array)
        {
            Value = args.Select(ToParameter).ToList(),
        };
        using ScriptBuilder script = new();
        script.EmitPush(argsArray);
        script.EmitPush((BigInteger)(int)CallFlags.All);
        script.EmitPush(method);
        script.EmitPush(target.ToArray());
        script.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
        return Execute(script);
    }

    public void CallVoid(UInt160 target, string method, params object?[] args) => _ = Call(target, method, args);

    public bool CallBoolean(UInt160 target, string method, params object?[] args) =>
        Call(target, method, args).GetBoolean();

    public BigInteger CallInteger(UInt160 target, string method, params object?[] args) =>
        Call(target, method, args).GetInteger();

    public byte[] CallBytes(UInt160 target, string method, params object?[] args) =>
        Call(target, method, args).GetSpan().ToArray();

    private StackItem Execute(ScriptBuilder script) => ExecuteScript(script.ToArray());

    /// <summary>
    /// Runs raw script bytes in the same engine that holds the deployed
    /// contracts, so a suite can execute a script an external builder produced
    /// (the shared wallet client) instead of re-encoding the call itself.
    /// </summary>
    public StackItem ExecuteScript(byte[] script)
    {
        return Engine.Execute(
            new Script(script),
            0,
            applicationEngine => FeeAmountField.SetValue(applicationEngine, new BigInteger(long.MaxValue)));
    }

    private static ContractParameter ToParameter(object? value) => value switch
    {
        null => new ContractParameter(ContractParameterType.Any),
        ContractParameter parameter => parameter,
        bool b => new ContractParameter(ContractParameterType.Boolean) { Value = b },
        BigInteger bi => new ContractParameter(ContractParameterType.Integer) { Value = bi },
        int i => new ContractParameter(ContractParameterType.Integer) { Value = (BigInteger)i },
        long l => new ContractParameter(ContractParameterType.Integer) { Value = (BigInteger)l },
        uint u => new ContractParameter(ContractParameterType.Integer) { Value = (BigInteger)u },
        string s => new ContractParameter(ContractParameterType.String) { Value = s },
        byte[] bytes => new ContractParameter(ContractParameterType.ByteArray) { Value = bytes },
        UInt160 hash => new ContractParameter(ContractParameterType.Hash160) { Value = hash },
        object?[] array => new ContractParameter(ContractParameterType.Array) { Value = array.Select(ToParameter).ToList() },
        _ => throw new NotSupportedException($"Unsupported argument type: {value.GetType()}"),
    };
}

/// <summary>Local P-256 key used to build real signatures and canonical scripts.</summary>
internal sealed class P256Key : IDisposable
{
    private static readonly byte[] CheckSigSyscallHash = { 0x56, 0xE7, 0xB3, 0x27 };

    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public byte[] CompressedPublicKey
    {
        get
        {
            ECParameters parameters = _key.ExportParameters(includePrivateParameters: false);
            byte[] compressed = new byte[33];
            compressed[0] = (byte)((parameters.Q.Y![^1] & 1) == 1 ? 0x03 : 0x02);
            System.Array.Copy(parameters.Q.X!, 0, compressed, 1, 32);
            return compressed;
        }
    }

    /// <summary>40-byte canonical script: <c>[PUSHDATA1 0x21 point SYSCALL CheckSig]</c>.</summary>
    public byte[] CanonicalScript()
    {
        byte[] script = new byte[40];
        script[0] = 0x0C;
        script[1] = 0x21;
        System.Array.Copy(CompressedPublicKey, 0, script, 2, 33);
        script[35] = 0x41;
        System.Array.Copy(CheckSigSyscallHash, 0, script, 36, 4);
        return script;
    }

    /// <summary>64-byte IEEE P1363 <c>r ‖ s</c> signature over the exact digest.</summary>
    public byte[] SignDigest(byte[] digest) => _key.SignHash(digest);

    public void Dispose() => _key.Dispose();
}
