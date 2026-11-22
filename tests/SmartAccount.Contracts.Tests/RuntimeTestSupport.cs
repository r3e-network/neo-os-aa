using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Reflection;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.SmartContract.Testing;
using Neo.SmartContract.Testing.Extensions;
using Neo.VM;
using Neo.VM.Types;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Shared, profile-neutral VM harness for behavioral suites that execute compiled
/// contracts through a real Neo execution engine. It extends the pattern of
/// <c>RuntimeWalletHarness</c> in <c>RuntimeExecutionTests.cs</c> with multi-contract deploys,
/// explicit transaction signers (Global witness scope so witnesses survive nested contract
/// calls), nested-array argument marshalling, and GAS funding/balance helpers.
///
/// The artifact directory is no longer tied to the retired custom profile: a host that
/// built its own artifacts passes them explicitly (<see cref="DeployArtifact"/>), and the
/// repository-relative default points at the native track output. Suites that still deploy
/// a compiled tree by name select it through <c>SMARTACCOUNT_ARTIFACT_DIR</c>, so nothing in
/// this helper requires <c>contracts/bin/public</c> to exist.
/// </summary>
internal sealed class RuntimeFixture
{
    private const string ArtifactDirectoryVariable = "SMARTACCOUNT_ARTIFACT_DIR";

    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledContractsDir = ResolveArtifactDirectory();

    /// <summary>
    /// Default artifact directory when a host passes no path of its own:
    /// <c>contracts/bin/native</c>, the native-profile module output. No script creates that
    /// directory implicitly — <c>scripts/build_native_modules.py</c> and the epoch probe write to the
    /// <c>--output</c> they are given — so a local run points <c>SMARTACCOUNT_ARTIFACT_DIR</c> at a
    /// module build, and the epoch probe hands its own directory to the probe on the command line.
    /// </summary>
    public static string ArtifactDirectory => CompiledContractsDir;

    private static string ResolveArtifactDirectory()
    {
        string? configured = Environment.GetEnvironmentVariable(ArtifactDirectoryVariable);
        if (!string.IsNullOrWhiteSpace(configured))
            return Path.GetFullPath(configured!);
        return Path.Combine(RepoRoot, "contracts", "bin", "native");
    }

    private static readonly FieldInfo FeeAmountField =
        typeof(ApplicationEngine).GetField("_feeAmount", BindingFlags.Instance | BindingFlags.NonPublic)!;

    private static readonly UInt160 ContractManagementHash =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    public TestEngine Engine { get; } = new();

    public UInt160 GasHash { get; } = NativeContract.GAS.Hash;

    public UInt160 StdLibHash { get; } = NativeContract.StdLib.Hash;

    public RuntimeFixture()
    {
        SetSigners(Engine.ValidatorsAddress);
    }

    /// <summary>
    /// Deploys a compiled artifact from <see cref="ArtifactDirectory"/> (the native track
    /// output by default), with logical names such as verifiers/SessionKeyValidator.
    /// </summary>
    public UInt160 Deploy(string baseName, object? data = null)
    {
        NefFile nef = NefFile.Parse(
            File.ReadAllBytes(Path.Combine(CompiledContractsDir, baseName + ".nef")), verify: true);
        string manifestText = File.ReadAllText(Path.Combine(CompiledContractsDir, baseName + ".manifest.json"));
        ContractManifest manifest = ContractManifest.Parse(manifestText);

        UInt160 contractHash = Engine.GetDeployHash(nef, manifest);
        _ = Call(ContractManagementHash, "deploy", nef.ToArray(), manifestText, data);
        return contractHash;
    }

    /// <summary>
    /// Deploys an externally supplied artifact pair (e.g. a byte-for-byte copy of a
    /// deployed contract) so tests execute live bytecode instead of a local build.
    /// </summary>
    public UInt160 DeployArtifact(byte[] nefBytes, string manifestText, object? data = null)
    {
        NefFile nef = NefFile.Parse(nefBytes, verify: true);
        ContractManifest manifest = ContractManifest.Parse(manifestText);
        UInt160 contractHash = Engine.GetDeployHash(nef, manifest);
        _ = Call(ContractManagementHash, "deploy", nef.ToArray(), manifestText, data);
        return contractHash;
    }

    /// <summary>
    /// Replaces the transaction signers. Global witness scope is used so that
    /// <c>Runtime.CheckWitness</c> succeeds in nested contract-to-contract calls for test
    /// convenience, not as evidence of production wallet scopes. Scope-sensitive tests
    /// must set explicit signers on Engine. The first account is the transaction sender.
    /// </summary>
    public void SetSigners(params UInt160[] accounts)
    {
        Engine.SetTransactionSigners(accounts
            .Select(account => new Signer { Account = account, Scopes = WitnessScope.Global })
            .ToArray());
    }

    /// <summary>Block time (milliseconds) the VM currently executes against.</summary>
    public BigInteger Now()
    {
        using ScriptBuilder scriptBuilder = new();
        scriptBuilder.EmitSysCall(ApplicationEngine.System_Runtime_GetTime.Hash);
        return Run(scriptBuilder).GetInteger();
    }

    /// <summary>Advances the persisting block timestamp by the given delta.</summary>
    public void AdvanceTime(TimeSpan delta)
    {
        Engine.PersistingBlock.Advance(delta);
    }

    public StackItem Call(UInt160 targetHash, string method, params object?[] args)
    {
        // Build the System.Contract.Call manually: EmitDynamicCall's object marshaller cannot
        // express nested arrays (a UserOperation, or a forwarded arg list), but a
        // ContractParameter(Array) can, so it is assembled here instead.
        ContractParameter argsArray = new(ContractParameterType.Array)
        {
            Value = args.Select(ToParameter).ToList()
        };

        using ScriptBuilder scriptBuilder = new();
        scriptBuilder.EmitPush(argsArray);
        scriptBuilder.EmitPush((BigInteger)(int)CallFlags.All);
        scriptBuilder.EmitPush(method);
        scriptBuilder.EmitPush(targetHash.ToArray());
        scriptBuilder.EmitSysCall(ApplicationEngine.System_Contract_Call.Hash);
        return Run(scriptBuilder);
    }

    public void CallVoid(UInt160 targetHash, string method, params object?[] args)
    {
        _ = Call(targetHash, method, args);
    }

    public bool CallBoolean(UInt160 targetHash, string method, params object?[] args)
    {
        return Call(targetHash, method, args).GetBoolean();
    }

    public BigInteger CallInteger(UInt160 targetHash, string method, params object?[] args)
    {
        return Call(targetHash, method, args).GetInteger();
    }

    public UInt160 CallUInt160(UInt160 targetHash, string method, params object?[] args)
    {
        return (UInt160)TestExtensions.ConvertTo(Call(targetHash, method, args), typeof(UInt160))!;
    }

    public byte[] CallBytes(UInt160 targetHash, string method, params object?[] args)
    {
        return Call(targetHash, method, args).GetSpan().ToArray();
    }

    public BigInteger GasBalanceOf(UInt160 account)
    {
        return CallInteger(GasHash, "balanceOf", account);
    }

    /// <summary>Funds an account with GAS from the genesis validators, restoring the signers afterwards.</summary>
    public void FundGasFromValidators(UInt160 to, BigInteger amount)
    {
        Signer[] previousSigners = Engine.Transaction.Signers;
        SetSigners(Engine.ValidatorsAddress);
        try
        {
            TransferGas(Engine.ValidatorsAddress, to, amount, null);
        }
        finally
        {
            Engine.SetTransactionSigners(previousSigners);
        }
    }

    /// <summary>Performs a NEP-17 GAS transfer and asserts the token accepted it.</summary>
    public void TransferGas(UInt160 from, UInt160 to, BigInteger amount, object? data)
    {
        Assert.IsTrue(CallBoolean(GasHash, "transfer", from, to, amount, data), "GAS transfer rejected");
    }

    /// <summary>
    /// Serializes a value with the native StdLib binary serializer — the exact encoding
    /// contracts read back through <c>StdLib.Deserialize</c> (used for MultiSig signature bundles).
    /// </summary>
    public byte[] StdLibSerialize(object? value)
    {
        return CallBytes(StdLibHash, "serialize", value);
    }

    // ========================================================================
    // v4 protocol helpers (spec §4.1 envelope, §6 nonce, §9 actions)
    // ========================================================================

    public const int ModuleTypeValidator = 1;

    public const int ModuleTypeHook = 4;

    public const int ActionInstallModule = 1;

    public const int ActionUninstallModule = 2;

    public const int ActionConfigureModule = 3;

    public const int ActionSetHookOrder = 4;

    public const int ActionSetThresholdPolicy = 7;

    public const int ActionSetRecoveryPolicy = 8;

    public const int ActionMigrateAccount = 10;

    /// <summary>Protocol version carried in envelope field 0.</summary>
    public const int ModuleProtocolVersion = 4;

    /// <summary>Shortest registration identity salt the core accepts.</summary>
    public static readonly BigInteger MinRecoveryTimelockMs = 7L * 24 * 60 * 60 * 1000;

    /// <summary>Deterministic registration salt; distinct labels give distinct accounts.</summary>
    public static byte[] Salt(string label) => System.Text.Encoding.UTF8.GetBytes(label);

    /// <summary>32-byte zero nonce subkey: the default channel for a routing subject.</summary>
    public static byte[] DefaultNonceSubkey() => new byte[32];

    /// <summary>
    /// Registers a v4 account: identity is custody‖salt (spec §16.1) and the
    /// initial actions install atomically with the registration, so no 24 h
    /// wait is needed to reach the configured state under test.
    /// </summary>
    public UInt160 CreateAccount(UInt160 core, UInt160 custody, string saltLabel, params object[] actions)
    {
        return CreateAccount(core, custody, Salt(saltLabel), MinRecoveryTimelockMs, actions);
    }

    public UInt160 CreateAccount(UInt160 core, UInt160 custody, byte[] salt, BigInteger recoveryTimelockMs, params object[] actions)
    {
        UInt160 accountId = CallUInt160(core, "computeAccountIdentity", custody, salt);
        SetSigners(custody);
        CallVoid(core, "createAccount", accountId, custody, salt, recoveryTimelockMs, actions);
        return accountId;
    }

    /// <summary>The SHA-256 of the deployed module's <c>getModuleProfile()</c> text.</summary>
    public byte[] ModuleProfileDigest(UInt160 module)
    {
        byte[] profile = CallBytes(module, "getModuleProfile");
        return System.Security.Cryptography.SHA256.HashData(profile);
    }

    /// <summary>[ActionInstallModule, type, contractHash, profileDigest32, initData[]]</summary>
    public object[] InstallModule(UInt160 module, int moduleType, params object?[] initData)
    {
        return new object[]
        {
            ActionInstallModule, moduleType, module, ModuleProfileDigest(module), initData
        };
    }

    public object[] InstallValidator(UInt160 module, params object?[] initData) => InstallModule(module, ModuleTypeValidator, initData);

    public object[] InstallHook(UInt160 module, params object?[] initData) => InstallModule(module, ModuleTypeHook, initData);

    /// <summary>[ActionUninstallModule, moduleId, deInitData[]]</summary>
    public static object[] UninstallModule(BigInteger moduleId, params object?[] deInitData)
    {
        return new object[] { ActionUninstallModule, moduleId, deInitData };
    }

    /// <summary>[ActionConfigureModule, moduleId, configData[]]</summary>
    public static object[] ConfigureModule(BigInteger moduleId, params object?[] configData)
    {
        return new object[] { ActionConfigureModule, moduleId, configData };
    }

    /// <summary>[ActionSetHookOrder, hookIds[]] in pre-check order.</summary>
    public static object[] SetHookOrder(params BigInteger[] hookIds)
    {
        object?[] ids = new object?[hookIds.Length];
        for (int i = 0; i < hookIds.Length; i++) ids[i] = hookIds[i];
        return new object[] { ActionSetHookOrder, ids };
    }

    /// <summary>[ActionSetThresholdPolicy, policyId, threshold, memberIds[], active]</summary>
    public static object[] SetThresholdPolicy(BigInteger policyId, BigInteger threshold, BigInteger[] memberIds, bool active)
    {
        object?[] members = new object?[memberIds.Length];
        for (int i = 0; i < memberIds.Length; i++) members[i] = memberIds[i];
        return new object[] { ActionSetThresholdPolicy, policyId, threshold, members, active };
    }

    /// <summary>[ActionSetRecoveryPolicy, recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery]</summary>
    public static object[] SetRecoveryPolicy(UInt160 recoveryAuthority, BigInteger recoveryTimelockMs, bool ownerOnlyRecovery = false)
    {
        return new object[] { ActionSetRecoveryPolicy, recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery };
    }

    /// <summary>The AccountControl projection returned by <c>getAccount</c>.</summary>
    public Neo.VM.Types.Array AccountControl(UInt160 core, UInt160 accountId)
    {
        return (Neo.VM.Types.Array)Call(core, "getAccount", accountId);
    }

    public BigInteger AccountAuthorityEpoch(UInt160 core, UInt160 accountId) => AccountControl(core, accountId)[4].GetInteger();

    public BigInteger AccountConfigurationNonce(UInt160 core, UInt160 accountId) => AccountControl(core, accountId)[5].GetInteger();

    public BigInteger AccountStatus(UInt160 core, UInt160 accountId) => AccountControl(core, accountId)[1].GetInteger();

    public BigInteger AccountRecoveryTimelockMs(UInt160 core, UInt160 accountId) => AccountControl(core, accountId)[6].GetInteger();

    public bool AccountDefaultOperationAuthorization(UInt160 core, UInt160 accountId) => AccountControl(core, accountId)[7].GetBoolean();

    public UInt160 AccountCustody(UInt160 core, UInt160 accountId) =>
        (UInt160)TestExtensions.ConvertTo(AccountControl(core, accountId)[2], typeof(UInt160))!;

    // ------------------------------------------------------------------------
    // Canonical P-256 signer scripts (spec §8): the 41-byte wallet script
    // [PUSHDATA1 33 <point> SYSCALL CheckSig]. A custody backed by such a
    // script can authorize the built-in (validatorId = 0) route.
    // ------------------------------------------------------------------------

    /// <summary>SYSCALL hash of <c>System.Crypto.CheckSig</c> (0x27B3E756 little-endian).</summary>
    private static readonly byte[] CheckSigSyscallHash = { 0x56, 0xE7, 0xB3, 0x27 };

    public static byte[] CanonicalP256Script(byte[] compressedPublicKey)
    {
        if (compressedPublicKey.Length != 33)
            throw new ArgumentException("A compressed P-256 point is 33 bytes", nameof(compressedPublicKey));
        // [PUSHDATA1 33 <point> SYSCALL CheckSig] = 2 + 33 + 1 + 4 = 40 bytes.
        byte[] script = new byte[40];
        script[0] = 0x0C;
        script[1] = 0x21;
        System.Array.Copy(compressedPublicKey, 0, script, 2, 33);
        script[35] = 0x41;
        System.Array.Copy(CheckSigSyscallHash, 0, script, 36, CheckSigSyscallHash.Length);
        return script;
    }

    public static UInt160 ScriptHashOf(byte[] script)
    {
        // N3 address of the script: RIPEMD160(SHA256(script)) kept in raw
        // (little-endian) order, the same byte order the core stores in
        // AccountControl.Custody and compares against in SubjectMatches.
        return new UInt160(Neo.Cryptography.Crypto.Hash160(script));
    }

    /// <summary>The custody address that owns the canonical P-256 script of <paramref name="key"/>.</summary>
    public static UInt160 CustodyOf(P256SessionKey key) => ScriptHashOf(CanonicalP256Script(key.CompressedPublicKey));

    /// <summary>
    /// Signs a v4 operation for the built-in route: the digest comes from the
    /// core itself, and the signature is the §8 envelope
    /// [4, 0, subjectRevision, [[script, 64-byte signature]]] serialized with
    /// the native serializer.
    /// </summary>
    public byte[] SignBuiltIn(UInt160 core, UInt160 accountId, object[] op, P256SessionKey key, BigInteger subjectRevision = default)
    {
        object[] probe = (object[])op.Clone();
        probe[11] = new byte[] { 0x00 };
        byte[] digest = CallBytes(core, "getOperationDigest", accountId, probe);
        byte[] signature = key.Sign(digest);
        object?[] pairs = { new object?[] { CanonicalP256Script(key.CompressedPublicKey), signature } };
        object?[] envelope =
        {
            (BigInteger)ModuleProtocolVersion,
            (BigInteger)0,
            subjectRevision == BigInteger.Zero ? BigInteger.One : subjectRevision,
            pairs
        };
        return StdLibSerialize(envelope);
    }

    /// <summary>Packed channel‖sequence nonce for the current routing subject state.</summary>
    public BigInteger PackedNonce(UInt160 core, UInt160 accountId, BigInteger validatorId) => PackedNonce(core, accountId, validatorId, DefaultNonceSubkey());

    public BigInteger PackedNonce(UInt160 core, UInt160 accountId, BigInteger validatorId, byte[] nonceSubkey)
    {
        return CallInteger(core, "getNonce", accountId, validatorId, nonceSubkey);
    }

    /// <summary>
    /// Sequence part of a packed nonce (spec §6: 191-bit channel ‖ 64-bit
    /// sequence). getNonce returns the packed value; behavioural assertions
    /// about consumption must mask down to the sequence.
    /// </summary>
    public static BigInteger NonceSequence(BigInteger packedNonce) => packedNonce & ((BigInteger.One << 64) - 1);

    public BigInteger CurrentNonceSequence(UInt160 core, UInt160 accountId, BigInteger validatorId)
    {
        return NonceSequence(PackedNonce(core, accountId, validatorId));
    }

    public BigInteger CurrentNonceSequence(UInt160 core, UInt160 accountId, BigInteger validatorId, byte[] nonceSubkey)
    {
        return NonceSequence(PackedNonce(core, accountId, validatorId, nonceSubkey));
    }

    // ------------------------------------------------------------------------
    // v4 replacements for the retired v3 registration / callVerifier / callHook
    // surfaces. Suites keep their historical argument shapes where the v4
    // mechanism still exists, so the behavioural intent survives the move.
    // ------------------------------------------------------------------------

    public const string ModuleTypeNameValidator = "validator";

    public const string ModuleTypeNameHook = "hook";

    private int _registrationSequence;

    /// <summary>
    /// Registers an account the way the retired <c>registerAccount</c> did:
    /// <paramref name="custody"/> authorizes the registration, an optional
    /// validator and hook module install atomically with the account, and the
    /// recovery timelock keeps its historical second-based argument.
    /// </summary>
    public UInt160 RegisterAccount(UInt160 core, UInt160 verifier, UInt160 hook, UInt160 custody, uint timelockSeconds)
    {
        _registrationSequence += 1;
        byte[] salt = Salt("reg-" + _registrationSequence + "-" + custody);
        List<object> actions = new();
        if (verifier != UInt160.Zero) actions.Add(InstallValidator(verifier));
        if (hook != UInt160.Zero) actions.Add(InstallHook(hook));
        return CreateAccount(core, custody, salt, new BigInteger(timelockSeconds) * 1000, actions.ToArray());
    }

    /// <summary>One atomic configuration intent proposal; returns its intentId.</summary>
    public BigInteger ProposeConfiguration(UInt160 core, UInt160 accountId, UInt160 custody, params object[] actions)
    {
        AssertActionList(actions);
        SetSigners(custody);
        return CallInteger(core, "proposeConfiguration", accountId, actions, new object[0]);
    }

    public void ConfirmConfiguration(UInt160 core, UInt160 accountId, UInt160 custody, BigInteger intentId, params object[] actions)
    {
        AssertActionList(actions);
        SetSigners(custody);
        CallVoid(core, "confirmConfiguration", accountId, intentId, actions);
    }

    /// <summary>
    /// Guards the one shape mistake the <c>params object[]</c> signatures make easy:
    /// passing a single action array directly turns its fields into separate
    /// "actions" and the core rejects the intent as SA_OPERATION_MALFORMED.
    /// </summary>
    private static void AssertActionList(object[] actions)
    {
        Assert.IsTrue(actions.Length > 0, "A configuration intent carries at least one action");
        for (int i = 0; i < actions.Length; i++)
        {
            Assert.IsTrue(actions[i] is object[],
                "Intent element " + i + " must be an action array, not a scalar field");
        }
    }

    /// <summary>
    /// propose → mature → confirm in one step: the v4 form of the retired
    /// <c>callVerifier</c> / <c>callHook</c> two-phase configuration calls.
    /// </summary>
    public void ConfigureAfterTimelock(UInt160 core, UInt160 accountId, UInt160 custody, params object[] actions)
    {
        BigInteger intentId = ProposeConfiguration(core, accountId, custody, actions);
        AdvanceTime(TimeSpan.FromHours(24) + TimeSpan.FromMinutes(1));
        ConfirmConfiguration(core, accountId, custody, intentId, actions);
    }

    /// <summary>Module ids of one type, in core allocation order.</summary>
    public BigInteger[] ModuleIds(UInt160 core, UInt160 accountId, string moduleType)
    {
        // Spec §3.3 page size is bounded to 1..32 (MaxEnumerationLimit).
        Neo.VM.Types.Array page = (Neo.VM.Types.Array)Call(
            core, "getModules", accountId, moduleType, (BigInteger)0, (BigInteger)32);
        Neo.VM.Types.Array ids = (Neo.VM.Types.Array)page[0];
        BigInteger[] result = new BigInteger[ids.Count];
        for (int i = 0; i < ids.Count; i++) result[i] = ids[i].GetInteger();
        return result;
    }

    /// <summary>The contract hash of an installed module instance.</summary>
    public UInt160 ModuleContractHash(UInt160 core, UInt160 accountId, BigInteger moduleId)
    {
        Neo.VM.Types.Array module = (Neo.VM.Types.Array)Call(core, "getModule", accountId, moduleId);
        Assert.IsTrue(module.Count > 2, "Module instance " + moduleId + " is not installed");
        return (UInt160)TestExtensions.ConvertTo(module[2], typeof(UInt160))!;
    }

    /// <summary>First installed module id of the type bound to the contract, or 0.</summary>
    public BigInteger FindModuleId(UInt160 core, UInt160 accountId, string moduleType, UInt160 contractHash)
    {
        BigInteger[] ids = ModuleIds(core, accountId, moduleType);
        for (int i = 0; i < ids.Length; i++)
        {
            if (ModuleContractHash(core, accountId, ids[i]) == contractHash) return ids[i];
        }
        return BigInteger.Zero;
    }

    /// <summary>The core-owned hook order: [hookIds[], revision].</summary>
    public BigInteger[] HookOrderIds(UInt160 core, UInt160 accountId)
    {
        Neo.VM.Types.Array order = (Neo.VM.Types.Array)Call(core, "getHookOrder", accountId);
        Neo.VM.Types.Array ids = (Neo.VM.Types.Array)order[0];
        BigInteger[] result = new BigInteger[ids.Count];
        for (int i = 0; i < ids.Count; i++) result[i] = ids[i].GetInteger();
        return result;
    }

    /// <summary>
    /// Builds the 13-field canonical v4 UserOperation (spec §4.1):
    /// [version, target, method, args, nonce, nonceSubkey, deadline,
    ///  validatorId, credentialGeneration, authorityEpoch, configurationNonce,
    ///  signature, hookProofs].
    /// </summary>
    public static object[] UserOp(
        UInt160 targetContract,
        string method,
        object?[] args,
        BigInteger nonce,
        BigInteger deadline,
        object? signature,
        BigInteger validatorId = default,
        BigInteger credentialGeneration = default,
        BigInteger authorityEpoch = default,
        BigInteger configurationNonce = default,
        byte[]? nonceSubkey = null,
        object[]? hookProofs = null)
    {
        return new object[]
        {
            (BigInteger)ModuleProtocolVersion,
            targetContract,
            method,
            args,
            nonce,
            nonceSubkey ?? DefaultNonceSubkey(),
            deadline,
            validatorId,
            credentialGeneration == BigInteger.Zero ? BigInteger.One : credentialGeneration,
            authorityEpoch == BigInteger.Zero ? BigInteger.One : authorityEpoch,
            configurationNonce,
            signature ?? new byte[0],
            hookProofs ?? new object[0]
        };
    }

    /// <summary>
    /// Notifications (events) emitted by the most recent <see cref="Call"/>/<see cref="CallVoid"/>
    /// against this fixture. Populated by capturing the executing <see cref="ApplicationEngine"/>,
    /// then read after the call returns so suites can assert on emitted event state.
    /// </summary>
    public IReadOnlyList<NotifyEventArgs> LastNotifications { get; private set; } =
        System.Array.Empty<NotifyEventArgs>();

    /// <summary>
    /// Returns the <c>State</c> array of the single notification with the given event name emitted
    /// by the most recent call, asserting exactly one was emitted by <paramref name="emitter"/>.
    /// </summary>
    public Neo.VM.Types.Array SingleNotificationState(UInt160 emitter, string eventName)
    {
        NotifyEventArgs[] matches = LastNotifications
            .Where(n => n.ScriptHash == emitter && n.EventName == eventName)
            .ToArray();
        Assert.AreEqual(1, matches.Length,
            $"Expected exactly one '{eventName}' notification from {emitter}, saw {matches.Length}.");
        return matches[0].State;
    }

    private StackItem Run(ScriptBuilder scriptBuilder)
    {
        ApplicationEngine? captured = null;
        StackItem result = Engine.Execute(
            new Script(scriptBuilder.ToArray()),
            0,
            applicationEngine =>
            {
                captured = applicationEngine;
                FeeAmountField.SetValue(applicationEngine, new BigInteger(long.MaxValue));
            });
        // The configure callback hands back the same engine instance that runs the script, so its
        // notification list is fully populated once Execute returns.
        LastNotifications = captured?.Notifications ?? (IReadOnlyList<NotifyEventArgs>)System.Array.Empty<NotifyEventArgs>();
        return result;
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
        ulong ul => new ContractParameter(ContractParameterType.Integer) { Value = (BigInteger)ul },
        string s => new ContractParameter(ContractParameterType.String) { Value = s },
        byte[] bytes => new ContractParameter(ContractParameterType.ByteArray) { Value = bytes },
        UInt160 hash => new ContractParameter(ContractParameterType.Hash160) { Value = hash },
        Neo.Cryptography.ECC.ECPoint point => new ContractParameter(ContractParameterType.ByteArray) { Value = point.EncodePoint(true) },
        object?[] array => new ContractParameter(ContractParameterType.Array) { Value = array.Select(ToParameter).ToList() },
        _ => throw new NotSupportedException($"Unsupported argument type: {value.GetType()}")
    };
}

/// <summary>
/// Local secp256r1 (P-256) key pair for SessionKeyValidator vectors. Signatures are produced
/// host-side over the exact payload the verifier exposes via <c>getPayload</c>, in the
/// IEEE P1363 r||s layout that <c>CryptoLib.VerifyWithECDsa(..., secp256r1SHA256)</c> expects.
/// </summary>
internal sealed class P256SessionKey : IDisposable
{
    private readonly System.Security.Cryptography.ECDsa _key =
        System.Security.Cryptography.ECDsa.Create(System.Security.Cryptography.ECCurve.NamedCurves.nistP256);

    /// <summary>33-byte compressed public key, the on-chain <c>ECPoint</c> encoding.</summary>
    public byte[] CompressedPublicKey
    {
        get
        {
            System.Security.Cryptography.ECParameters parameters = _key.ExportParameters(includePrivateParameters: false);
            byte[] x = parameters.Q.X!;
            byte[] y = parameters.Q.Y!;
            byte[] compressed = new byte[33];
            compressed[0] = (byte)((y[^1] & 1) == 1 ? 0x03 : 0x02);
            System.Array.Copy(x, 0, compressed, 1, 32);
            return compressed;
        }
    }

    /// <summary>64-byte r||s signature over SHA-256 of the payload.</summary>
    public byte[] Sign(byte[] payload)
    {
        return _key.SignData(payload, System.Security.Cryptography.HashAlgorithmName.SHA256);
    }

    public void Dispose()
    {
        _key.Dispose();
    }
}
