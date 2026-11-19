using System.Numerics;
using System.Text.Json;
using SmartAccount.Contracts.Tests;
using Neo;
using Neo.Extensions;
using Neo.IO;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;
using Neo.VM.Types;

// These cases execute compiler-produced protocol v4 production modules (the native
// SMARTACCOUNT_NATIVE profile) in a real public NeoVM against a deliberately permissive
// test-only SmartAccount ABI fixture. They prove the module lifecycle contract of
// docs/SA-MODULE-PROTOCOL.md §9 — caller authentication, per-(accountId, moduleId)
// instance isolation, big-endian instance keys, fail-closed teardown — not native
// recovery authorization or private-chain admission.
if (args.Length != 1) throw new ArgumentException("Pass the artifact directory.");
string artifacts = Path.GetFullPath(args[0]);
// The native profile pins every module to this core hash (NativeAuthority.SmartAccount).
UInt160 core = UInt160.Parse("0x398dc3f0227d7efac5533ed5ce9937390c158084");
UInt160 account = UInt160.Parse("0x1111111111111111111111111111111111111111");
UInt160 other = UInt160.Parse("0x2222222222222222222222222222222222222222");
UInt160 signer = UInt160.Parse("0x3333333333333333333333333333333333333333");
UInt160 secondSigner = UInt160.Parse("0x4444444444444444444444444444444444444444");
// ModulePhase (contracts/plugins/validators/ModuleOperation.cs).
const int ValidationPhase = 1, HookPrePhase = 2, ConfigurationPhase = 6;
List<object> cases = [];
int failures = 0;

void Require(bool value, string message)
{
    if (!value) throw new InvalidOperationException(message);
}

var key1 = new P256SessionKey();
var key2 = new P256SessionKey();

UInt160 Deploy(RuntimeFixture fx, string name) => fx.DeployArtifact(
    File.ReadAllBytes(Path.Combine(artifacts, name + ".nef")),
    File.ReadAllText(Path.Combine(artifacts, name + ".manifest.json")), core.ToArray());

RuntimeFixture Create()
{
    RuntimeFixture fx = new();
    Require(NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, core) is null,
        "The test must use a public runtime without a real native contract at the pinned core address.");
    var state = new ContractState
    {
        Id = 1_000_001, Hash = core,
        Nef = NefFile.Parse(File.ReadAllBytes(Path.Combine(artifacts, "NativeEpochCore.nef")), true),
        Manifest = ContractManifest.Parse(File.ReadAllText(Path.Combine(artifacts, "NativeEpochCore.manifest.json")))
    };
    fx.Engine.Storage.Snapshot.Add(new StorageKey
    {
        Id = NativeContract.ContractManagement.Id, Key = new byte[] { 8 }.Concat(core.ToArray()).ToArray()
    }, new StorageItem(state));
    Require(fx.CallInteger(core, "getAuthorizedModuleId", account, ValidationPhase) == 0,
        "the fixture starts with no authorized module instance");
    return fx;
}

void Run(string label, Action action)
{
    try { action(); cases.Add(new { label, status = "PASS" }); }
    catch (Exception error)
    {
        failures++;
        cases.Add(new { label, status = "FAIL", error = error.Message });
    }
}

string Dump(RuntimeFixture fx, UInt160 module)
{
    int id = ContractId(fx, module);
    return string.Join(";", fx.Engine.Storage.Snapshot.Find(new StorageKey { Id = id })
        .Select(entry => Convert.ToHexString(entry.Key.Key.ToArray()) + "=" +
            Convert.ToHexString(entry.Value.Value.ToArray())));
}

void Authorize(RuntimeFixture fx, UInt160 accountId, int phase, int moduleId)
{
    fx.CallVoid(core, "setAuthorizedModuleId", accountId, phase, moduleId);
    BigInteger observed = fx.CallInteger(core, "getAuthorizedModuleId", accountId, phase);
    Require(observed == moduleId,
        "the fixture authorized instance roundtrip wrote " + moduleId + " but read " + observed + " [" + Dump(fx, core) + "]");
}

// Every module callback is dialled through the fixture so Runtime.CallingScriptHash is the
// core; the module's own caller check is therefore what these cases exercise.
StackItem Forward(RuntimeFixture fx, UInt160 module, string method, params object?[] callArgs) =>
    fx.Call(core, "forward", module, method, callArgs);

void ExpectFault(Action action, string fragment)
{
    try
    {
        action();
        throw new InvalidOperationException("expected a fault containing \"" + fragment + "\"");
    }
    catch (TestException error)
    {
        Require(error.Message.Contains(fragment, StringComparison.OrdinalIgnoreCase),
            "unexpected fault: " + error.Message);
    }
}

int ContractId(RuntimeFixture fx, UInt160 module) =>
    NativeContract.ContractManagement.GetContract(fx.Engine.Storage.Snapshot, module)!.Id;

List<byte[]> Keys(RuntimeFixture fx, UInt160 module)
{
    int id = ContractId(fx, module);
    return fx.Engine.Storage.Snapshot.Find(new StorageKey { Id = id })
        .Select(entry => entry.Key.Key.ToArray()).ToList();
}

static bool Contains(byte[] key, byte[] needle)
{
    for (int i = 0; i + needle.Length <= key.Length; i++)
    {
        bool match = true;
        for (int j = 0; j < needle.Length && match; j++) match = key[i + j] == needle[j];
        if (match) return true;
    }
    return false;
}

static byte[] Bytes(BigInteger value, bool bigEndian)
{
    byte[] encoded = new byte[8];
    for (int i = 0; i < 8; i++)
    {
        int index = bigEndian ? 7 - i : i;
        encoded[index] = (byte)(value & 255);
        value >>= 8;
    }
    return encoded;
}

// prefix ‖ accountId (20) ‖ moduleId (8, big endian) — ModuleContext.InstanceKey. The
// leading module prefix is unknown to the probe, so only the instance tail is matched.
static byte[] InstanceTail(UInt160 accountId, BigInteger moduleId) =>
    accountId.ToArray().Concat(Bytes(moduleId, bigEndian: true)).ToArray();

List<ModuleSpec> specs =
[
    new ModuleSpec
    {
        Name = "NeoWitnessValidator",
        Phase = ValidationPhase,
        Config = (fx, variant) => variant == 0
            ? ["setSigners", new object[] { signer }, 1]
            : ["setSigners", new object[] { signer, secondSigner }, 2],
        Live = (fx, module, accountId, moduleId, variant) =>
            fx.CallInteger(module, "getThreshold", accountId, moduleId) == (variant == 0 ? 1 : 2)
    },
    new ModuleSpec
    {
        Name = "SessionKeyValidator",
        Phase = ValidationPhase,
        Config = (fx, variant) =>
        [
            "setSessionKey", (variant == 0 ? key1 : key2).CompressedPublicKey, fx.GasHash, "transfer",
            fx.Now() + 3_600_000, 100, "native module probe"
        ],
        // A session key may not rotate inside the 24h cooldown, so the reconfigure case asserts
        // that the second configuration is rejected instead of silently replacing the grant.
        ReconfigureFault = "cooldown",
        Live = (fx, module, accountId, moduleId, variant) =>
        {
            Neo.VM.Types.Array grant = (Neo.VM.Types.Array)fx.Call(module, "getSessionKey", accountId, moduleId);
            return grant.Count == 7 &&
                grant[0].GetSpan().ToArray().SequenceEqual((variant == 0 ? key1 : key2).CompressedPublicKey);
        }
    },
    new ModuleSpec
    {
        Name = "MultiSigValidator",
        Phase = ValidationPhase,
        Config = (fx, variant) => ["setMemberKey", (variant == 0 ? key1 : key2).CompressedPublicKey],
        Live = (fx, module, accountId, moduleId, variant) =>
            fx.CallBytes(module, "getMemberKey", accountId, moduleId)
                .SequenceEqual((variant == 0 ? key1 : key2).CompressedPublicKey)
    },
    new ModuleSpec
    {
        Name = "WhitelistHook",
        Phase = HookPrePhase,
        Config = (fx, variant) => ["allowTarget", variant == 0 ? fx.GasHash : NativeContract.NEO.Hash],
        Live = (fx, module, accountId, moduleId, variant) =>
            fx.CallBoolean(module, "isWhitelisted", accountId, moduleId,
                variant == 0 ? fx.GasHash : NativeContract.NEO.Hash)
    },
    new ModuleSpec
    {
        Name = "DailyLimitHook",
        Phase = HookPrePhase,
        Config = (fx, variant) => ["setDailyLimit", fx.GasHash, variant == 0 ? 100 : 500, variant == 1],
        Live = (fx, module, accountId, moduleId, variant) =>
            fx.CallInteger(module, "getDailyLimit", accountId, moduleId, fx.GasHash) == (variant == 0 ? 100 : 500)
    },
    new ModuleSpec
    {
        Name = "TokenRestrictedHook",
        Phase = HookPrePhase,
        Config = (fx, variant) => ["restrictToken", variant == 0 ? fx.GasHash : NativeContract.NEO.Hash],
        Live = (fx, module, accountId, moduleId, variant) =>
            fx.CallBoolean(module, "isRestricted", accountId, moduleId,
                variant == 0 ? fx.GasHash : NativeContract.NEO.Hash)
    }
];

foreach (ModuleSpec spec in specs)
{
    Run(spec.Name + "-lifecycle-instance-isolation-and-cleanup", () =>
    {
        RuntimeFixture fx = Create();
        UInt160 module = Deploy(fx, spec.Name);
        Authorize(fx, account, ConfigurationPhase, 100);
        Authorize(fx, other, ConfigurationPhase, 200);

        Forward(fx, module, "onInstall", account, (BigInteger)100, (BigInteger)0, spec.Config(fx, 0));
        Require(spec.Live(fx, module, account, 100, 0), "onInstall did not configure the account instance");
        Forward(fx, module, "onInstall", other, (BigInteger)200, (BigInteger)0, spec.Config(fx, 1));
        Require(spec.Live(fx, module, other, 200, 1), "onInstall did not configure the second account instance");
        Require(!spec.Live(fx, module, account, 100, 1), "the second account's configuration leaked into the first");
        Require(!spec.Live(fx, module, other, 200, 0), "the first account's configuration leaked into the second");

        List<byte[]> keys = Keys(fx, module);
        Require(keys.Any(key => Contains(key, InstanceTail(account, 100))),
            "no account ‖ big-endian module id storage key was written");
        Require(keys.Any(key => Contains(key, InstanceTail(other, 200))),
            "the second instance has no account ‖ big-endian module id storage key");
        Require(!keys.Any(key => Contains(key, account.ToArray().Concat(Bytes(100, bigEndian: false)).ToArray())),
            "a v3 little-endian module id key is still written");
        Require(keys.All(key => key[0] != 0xA2), "the retired 0xA2 authority-epoch tag is still written");

        // Owning the account is not authority over module state: a direct call is not the core.
        ExpectFault(() => fx.CallVoid(module, "onInstall", other, (BigInteger)200, (BigInteger)0, spec.Config(fx, 0)),
            "Unauthorized caller");
        // The core may only address the instance it names for the configuration phase.
        Authorize(fx, other, ConfigurationPhase, 300);
        ExpectFault(() => Forward(fx, module, "configure", other, (BigInteger)200, (BigInteger)1, spec.Config(fx, 1)),
            "Module instance mismatch");
        Authorize(fx, other, ConfigurationPhase, 200);

        if (spec.ReconfigureFault is { } fragment)
        {
            ExpectFault(() => Forward(fx, module, "configure", account, (BigInteger)100, (BigInteger)1, spec.Config(fx, 1)),
                fragment);
        }
        else
        {
            Forward(fx, module, "configure", account, (BigInteger)100, (BigInteger)1, spec.Config(fx, 1));
            Require(spec.Live(fx, module, account, 100, 1), "configure did not replace the instance policy");
            Require(spec.Live(fx, module, other, 200, 1), "configure crossed the account boundary");
        }

        // Execution phases resolve the instance through the core too; with no instance
        // authorized for that phase the module fails closed instead of trusting the caller.
        // A validator preview may only fall back to operation[validatorId] when the core did
        // not record a validation phase, so that id is zeroed here as well.
        object[] operation = RuntimeFixture.UserOp(fx.GasHash, "transfer", [account, other, 1],
            new BigInteger(1), fx.Now() + 3_600_000, new byte[0],
            validatorId: spec.Phase == ValidationPhase ? 0 : 100);
        string callback = spec.Phase == ValidationPhase ? "validateUserOp" : "preCheck";
        object?[] phaseArgs = spec.Phase == ValidationPhase
            ? [account, new byte[32], operation]
            : [account, operation];
        Authorize(fx, account, spec.Phase, 0);
        ExpectFault(() => Forward(fx, module, callback, phaseArgs), "Unauthorized");

        Forward(fx, module, "onUninstall", account, (BigInteger)100, (BigInteger)1, new object[0]);
        Require(!Keys(fx, module).Any(key => Contains(key, InstanceTail(account, 100))),
            "onUninstall left account instance state behind");
        Require(spec.Live(fx, module, other, 200, 1), "onUninstall crossed the account boundary");
        Require(Keys(fx, module).Any(key => Contains(key, InstanceTail(other, 200))),
            "onUninstall erased the other account's instance");
    });
}

// A validator's execution phase reads the authorized instance and approves nothing extra:
// the quorum is evaluated against instance state, not against the caller of the callback.
Run("NeoWitnessValidator-validation-phase-resolves-the-authorized-instance", () =>
{
    RuntimeFixture fx = Create();
    UInt160 module = Deploy(fx, "NeoWitnessValidator");
    Authorize(fx, account, ConfigurationPhase, 100);
    Forward(fx, module, "onInstall", account, (BigInteger)100, (BigInteger)0,
        new object[] { "setSigners", new object[] { signer }, 1 });
    object[] operation = RuntimeFixture.UserOp(fx.GasHash, "transfer", [account, other, 1],
        new BigInteger(1), fx.Now() + 3_600_000, new byte[0], validatorId: 100);
    Authorize(fx, account, ValidationPhase, 100);
    StackItem result = Forward(fx, module, "validateUserOp", account, new byte[32], operation);
    Require(result is not null && result.Type == Neo.VM.Types.StackItemType.Boolean,
        "an authorized validation must answer with a boolean");
    // The core records the completion phase separately; an unauthorized one fails closed.
    Authorize(fx, account, 5, 0);
    ExpectFault(() => Forward(fx, module, "onUserOpComplete", account, operation, true), "Unauthorized");
});

// Threshold members bind their signature domain to the credential generation the core
// records, so the fixture's instance record has to be the authority for it.
Run("MultiSigValidator-member-digest-follows-the-core-credential-generation", () =>
{
    RuntimeFixture fx = Create();
    UInt160 module = Deploy(fx, "MultiSigValidator");
    Authorize(fx, account, ConfigurationPhase, 100);
    Forward(fx, module, "onInstall", account, (BigInteger)100, (BigInteger)0,
        new object[] { "setMemberKey", key1.CompressedPublicKey });
    byte[] digest = new byte[32];
    fx.CallVoid(core, "setModuleGeneration", account, (BigInteger)100, (BigInteger)1);
    byte[] first = fx.CallBytes(module, "getMemberDigest", account, (BigInteger)100, digest);
    Require(first.Length == 32, "a member digest must be 32 bytes");
    fx.CallVoid(core, "setModuleGeneration", account, (BigInteger)100, (BigInteger)2);
    byte[] second = fx.CallBytes(module, "getMemberDigest", account, (BigInteger)100, digest);
    Require(!first.SequenceEqual(second), "the member digest ignored the core credential generation");
    Authorize(fx, account, ConfigurationPhase, 0);
    ExpectFault(() => Forward(fx, module, "configure", account, (BigInteger)100, (BigInteger)1,
        new object[] { "setMemberKey", key2.CompressedPublicKey }), "Unauthorized");
});

Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
{
    status = failures == 0 ? "PASS" : "FAIL",
    publicNetworksTouched = false,
    evidence = "Real public NeoVM executes production v4 module NEFs against a test-only SmartAccount ABI fixture; no native recovery/admission claim.",
    cases
}, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
return failures == 0 ? 0 : 1;

sealed class ModuleSpec
{
    public required string Name { get; init; }
    public required int Phase { get; init; }
    public required Func<RuntimeFixture, int, object[]> Config { get; init; }
    public required Func<RuntimeFixture, UInt160, UInt160, BigInteger, int, bool> Live { get; init; }
    /// <summary>Fault fragment a reconfigure must raise instead of replacing the policy.</summary>
    public string? ReconfigureFault { get; init; }
}
