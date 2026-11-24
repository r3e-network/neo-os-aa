using System;
using System.Numerics;
using System.Security.Cryptography;
using Neo;
using Neo.Extensions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Module-level harness for protocol-v4 plugin suites. A v4 module never trusts a
/// caller-declared instance: it authenticates the caller as the bound core and then asks
/// the core which of its instances the current writer phase addresses (spec §10). This
/// harness deploys a plugin against <c>MockVerifierCore</c> and drives exactly those
/// phases, so plugin vectors execute the same code paths the real core dispatches.
/// </summary>
/// <remarks>
/// Core-level behaviour (routing, threshold policies, nonces, hooks) belongs in the real
/// core suites — this harness deliberately covers only the module side of the ABI.
/// </remarks>
internal sealed class PluginModuleHarness
{
    public const int PhaseValidation = 1;

    public const int PhaseCompletion = 5;

    public const int PhaseConfiguration = 6;

    public RuntimeFixture Fx { get; } = new();

    public UInt160 AccountId { get; }

    public UInt160 Core { get; }

    public UInt160 Target { get; }

    public UInt160 Module { get; }

    public BigInteger ModuleId { get; } = 1;

    public BigInteger Generation { get; private set; } = 1;

    private readonly int _moduleType;

    private readonly bool _instanceIsolation;

    private readonly bool _messageCapability;

    private readonly bool _thresholdMemberEligible;

    public PluginModuleHarness(
        string contractPath,
        UInt160? accountId = null,
        int moduleType = 1,
        bool instanceIsolation = true,
        bool messageCapability = false,
        bool thresholdMemberEligible = false)
    {
        AccountId = accountId ?? UInt160.Parse("0x1111111111111111111111111111111111111111");
        _moduleType = moduleType;
        _instanceIsolation = instanceIsolation;
        _messageCapability = messageCapability;
        _thresholdMemberEligible = thresholdMemberEligible;

        Core = Fx.Deploy("MockVerifierCore");
        Target = Fx.Deploy("MockTransferTarget");
        Module = Fx.Deploy(contractPath, Core.ToArray());
        RecordDescriptor();
    }

    private void RecordDescriptor()
    {
        Fx.CallVoid(Core, "setModule", AccountId, ModuleId, (BigInteger)_moduleType, Generation,
            _instanceIsolation, _messageCapability, _thresholdMemberEligible);
    }

    /// <summary>Re-records the instance at a new credential generation (revocation, reshape).</summary>
    public void SetGeneration(BigInteger generation)
    {
        Generation = generation;
        RecordDescriptor();
    }

    /// <summary>Runs <c>configure</c> under the Configuration writer phase (§10).</summary>
    public void Configure(params object?[] configData)
    {
        Fx.CallVoid(Core, "setAuthorizedModuleId", AccountId, (BigInteger)PhaseConfiguration, ModuleId);
        Fx.CallVoid(Core, "forward", Module, "configure",
            new object?[] { AccountId, ModuleId, (BigInteger)_moduleType, configData });
    }

    /// <summary>Runs <c>onInstall</c> under the Configuration writer phase (§10).</summary>
    public void Install(params object?[] initData)
    {
        Fx.CallVoid(Core, "setAuthorizedModuleId", AccountId, (BigInteger)PhaseConfiguration, ModuleId);
        Fx.CallVoid(Core, "forward", Module, "onInstall",
            new object?[] { AccountId, ModuleId, (BigInteger)_moduleType, initData });
    }

    /// <summary>Runs <c>onUninstall</c> under the Configuration writer phase (§10).</summary>
    public void Uninstall(params object?[] deInitData)
    {
        Fx.CallVoid(Core, "setAuthorizedModuleId", AccountId, (BigInteger)PhaseConfiguration, ModuleId);
        Fx.CallVoid(Core, "forward", Module, "onUninstall",
            new object?[] { AccountId, ModuleId, (BigInteger)_moduleType, deInitData });
    }

    /// <summary>Runs <c>validateUserOp</c> under the Validation writer phase (§10).</summary>
    public bool Validate(byte[] operationDigest, object[] op)
    {
        Fx.CallVoid(Core, "setAuthorizedModuleId", AccountId, (BigInteger)PhaseValidation, ModuleId);
        return Fx.CallBoolean(Core, "forward", Module, "validateUserOp",
            new object?[] { AccountId, operationDigest, op });
    }

    /// <summary>Runs <c>onUserOpComplete</c> under the Completion writer phase (§10).</summary>
    public void Complete(object[] op, object result)
    {
        Fx.CallVoid(Core, "setAuthorizedModuleId", AccountId, (BigInteger)PhaseCompletion, ModuleId);
        Fx.CallVoid(Core, "forward", Module, "onUserOpComplete",
            new object?[] { AccountId, op, result });
    }

    /// <summary>Calls a module method directly, outside any core dispatcher phase.</summary>
    public object? CallDirect(string method, params object?[] args) =>
        Fx.Call(Module, method, args);

    /// <summary>Asset address the core derives for the account (§5).</summary>
    public UInt160 AssetAddress => Fx.CallUInt160(Core, "getProxyScriptHash", AccountId);

    public object?[] TransferArgs(BigInteger amount, UInt160 recipient) =>
        new object?[] { AssetAddress, recipient, amount, null };

    public object[] TransferOp(UInt160 target, BigInteger amount, UInt160 recipient, byte[] signature,
        BigInteger nonce = default) =>
        RuntimeFixture.UserOp(target, "transfer", TransferArgs(amount, recipient), nonce,
            Fx.Now() + 600_000, signature, validatorId: ModuleId, credentialGeneration: Generation);

    public byte[] Grant() => Fx.CallBytes(Module, "getGrantDigest", AccountId, ModuleId);

    /// <summary>
    /// Operation digest for a vector: the stub core exposes no digest query, so the
    /// vector binds every unsigned field (nonce included) the way the core's digest
    /// does — a signature produced for one nonce never validates another.
    /// </summary>
    public static byte[] Digest(RuntimeFixture fx, object[] op)
    {
        object[] probe = (object[])op.Clone();
        probe[11] = new byte[] { 0x00 };
        return SHA256.HashData(fx.StdLibSerialize(probe));
    }
}
