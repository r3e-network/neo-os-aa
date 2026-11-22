using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using VmArray = Neo.VM.Types.Array;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Real-core harness for the asset regression suites: it deploys the v4 core, the
/// test-only NEP-17/NEP-11 tokens and the plugin modules, registers a custody-owned
/// account and executes canonical 13-field operations through
/// <c>executeUserOp</c>.
/// </summary>
/// <remarks>
/// Every operation runs through the real validation → nonce → hook pre → dispatch →
/// hook post → completion pipeline, so the assertions cover the policy verdict and the
/// core-side rollback together. Asset movement is driven by the account's proxy address
/// (spec §5): the assets live there, so it is the transaction sender for an operation
/// that moves them, which is what makes a native GAS transfer from a virtual account
/// witness-valid in the test engine.
/// </remarks>
internal sealed class AssetRuntimeHarness
{
    /// <summary>Native ContractManagement, used to read a contract's storage id.</summary>
    private static readonly UInt160 ContractManagement =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    public RuntimeFixture Fx { get; } = new();

    public UInt160 Core { get; }

    public P256SessionKey Key { get; } = new();

    public UInt160 Custody { get; }

    public UInt160 AccountId { get; private set; } = UInt160.Zero;

    public AssetRuntimeHarness()
    {
        Core = Fx.Deploy("SmartAccount");
        Custody = RuntimeFixture.CustodyOf(Key);
    }

    /// <summary>Proxy script hash: where a v4 account actually holds its assets (spec §5).</summary>
    public UInt160 Asset => AssetOf(AccountId);

    /// <summary>The proxy script hash of an arbitrary account in this engine.</summary>
    public UInt160 AssetOf(UInt160 accountId) => Fx.CallUInt160(Core, "getProxyScriptHash", accountId);

    public BigInteger ConfigurationNonce => Fx.AccountConfigurationNonce(Core, AccountId);

    /// <summary>Deploys a plugin module bound to this core (the deploy data is the trusted core).</summary>
    public UInt160 DeployModule(string contractPath) => Fx.Deploy(contractPath, Core.ToArray());

    /// <summary>
    /// Deploys a test-only token; the deployer (the genesis validators) becomes its admin. The
    /// signers are pinned first so the admin does not depend on which account registration ran
    /// earlier in the vector (registering an account signs as the custody key).
    /// </summary>
    public UInt160 DeployToken(string contractPath)
    {
        Fx.SetSigners(Fx.Engine.ValidatorsAddress);
        return Fx.Deploy(contractPath);
    }

    /// <summary>
    /// Registers the custody-owned account. Each element of <paramref name="actions"/> is one
    /// action array, installed atomically with the registration so no 24 h wait is needed.
    /// </summary>
    public UInt160 CreateAccount(string label, params object[] actions)
    {
        object[] actionList = NormalizeActions(actions);
        for (int i = 0; i < actionList.Length; i++)
            AssertActionListElement(actionList, i);
        AccountId = Fx.CreateAccount(Core, Custody, RuntimeFixture.Salt("asset-" + label),
            RuntimeFixture.MinRecoveryTimelockMs, actionList);
        return AccountId;
    }

    /// <summary>
    /// <c>params object[]</c> binds a single <c>object[]</c> argument directly to the parameter, so
    /// <c>CreateAccount(label, InstallHook(...))</c> would hand the core one action array whose
    /// opcode it then reads as the first action. An action is always an array whose head is the
    /// opcode string, so a scalar head is re-wrapped into the single-action list it was meant to be.
    /// </summary>
    private static object[] NormalizeActions(object[] actions) =>
        actions.Length == 0 || actions[0] is object[] ? actions : new object[] { actions };

    private static void AssertActionListElement(object[] actions, int i) =>
        Assert.IsTrue(actions[i] is object[],
            "Registration element " + i + " must be an action array, not a scalar field");

    /// <summary>
    /// Registers an additional account for the same custody key without disturbing
    /// <see cref="AccountId"/>. Two such accounts let one vector prove that instance state is
    /// keyed by <c>(accountId, moduleId)</c> (spec §10) rather than by contract alone.
    /// </summary>
    public UInt160 CreateSiblingAccount(string label, params object[] actions)
    {
        object[] actionList = NormalizeActions(actions);
        for (int i = 0; i < actionList.Length; i++)
            AssertActionListElement(actionList, i);
        return Fx.CreateAccount(Core, Custody, RuntimeFixture.Salt("asset-" + label),
            RuntimeFixture.MinRecoveryTimelockMs, actionList);
    }

    /// <summary>Signs as the token admin: the deployer of every mock is the genesis validators.</summary>
    public void AsTokenAdmin() => Fx.SetSigners(Fx.Engine.ValidatorsAddress);

    public BigInteger Generation(BigInteger moduleId) =>
        ((VmArray)Fx.Call(Core, "getModule", AccountId, moduleId))[8].GetInteger();

    public BigInteger ModuleId(UInt160 module, string moduleType) =>
        Fx.FindModuleId(Core, AccountId, moduleType, module);

    public BigInteger ValidatorId(UInt160 module) =>
        ModuleId(module, RuntimeFixture.ModuleTypeNameValidator);

    public BigInteger HookId(UInt160 module) =>
        ModuleId(module, RuntimeFixture.ModuleTypeNameHook);

    /// <summary>Module id of a module installed on a specific account (sibling vectors).</summary>
    public BigInteger HookIdFor(UInt160 accountId, UInt160 module) =>
        Fx.FindModuleId(Core, accountId, RuntimeFixture.ModuleTypeNameHook, module);

    /// <summary>Sequence part of the built-in (validatorId = 0) nonce channel.</summary>
    public BigInteger BuiltInSequence => Fx.CurrentNonceSequence(Core, AccountId, 0);

    public BigInteger Sequence(BigInteger moduleId, byte[]? nonceSubkey = null) =>
        nonceSubkey == null
            ? Fx.CurrentNonceSequence(Core, AccountId, moduleId)
            : Fx.CurrentNonceSequence(Core, AccountId, moduleId, nonceSubkey);

    public bool ExecutionActive => Fx.CallBoolean(Core, "isExecutionActive", AccountId);

    /// <summary>Built-in route operation with a placeholder signature filling field 11.</summary>
    public object[] BuiltInOp(UInt160 target, string method, object?[] args) =>
        BuiltInOpFor(AccountId, target, method, args);

    /// <summary>Built-in route operation for a specific account (sibling vectors).</summary>
    public object[] BuiltInOpFor(UInt160 accountId, UInt160 target, string method, object?[] args) =>
        RuntimeFixture.UserOp(target, method, args,
            Fx.PackedNonce(Core, accountId, 0), Fx.Now() + 600_000, new byte[] { 0x00 },
            configurationNonce: Fx.AccountConfigurationNonce(Core, accountId));

    /// <summary>Module-routed operation; the caller signs it afterwards.</summary>
    public object[] RoutedOp(BigInteger moduleId, UInt160 target, string method, object?[] args,
        byte[]? nonceSubkey = null)
    {
        byte[] channel = nonceSubkey ?? RuntimeFixture.DefaultNonceSubkey();
        return RuntimeFixture.UserOp(target, method, args,
            Fx.PackedNonce(Core, AccountId, moduleId, channel), Fx.Now() + 600_000, new byte[] { 0x00 },
            validatorId: moduleId, credentialGeneration: Generation(moduleId),
            configurationNonce: ConfigurationNonce, nonceSubkey: channel);
    }

    /// <summary>
    /// Executes a built-in route operation signed by the custody key, with
    /// <paramref name="sender"/> as the transaction sender (default: the asset address, so a
    /// token that requires the source witness accepts a transfer of the account's funds).
    /// </summary>
    public bool Execute(object[] op, UInt160? sender = null)
    {
        op[11] = Fx.SignBuiltIn(Core, AccountId, op, Key);
        Fx.SetSigners(sender ?? Asset);
        return Fx.CallBoolean(Core, "executeUserOp", AccountId, op);
    }

    /// <summary>Executes a built-in route operation on a specific account (sibling vectors).</summary>
    public bool ExecuteFor(UInt160 accountId, object[] op)
    {
        op[11] = Fx.SignBuiltIn(Core, accountId, op, Key);
        Fx.SetSigners(AssetOf(accountId));
        return Fx.CallBoolean(Core, "executeUserOp", accountId, op);
    }

    /// <summary>Executes a module-routed operation; the module authorizes it, not a signature.</summary>
    public bool ExecuteRouted(object[] op, UInt160 sender)
    {
        Fx.SetSigners(sender);
        return Fx.CallBoolean(Core, "executeUserOp", AccountId, op);
    }

    /// <summary>Commits one module command through the 24 h configuration intent.</summary>
    public void CommitModuleCommand(BigInteger moduleId, params object?[] configData) =>
        Fx.ConfigureAfterTimelock(Core, AccountId, Custody,
            new object[] { RuntimeFixture.ConfigureModule(moduleId, configData) });

    /// <summary>
    /// True while the primary account's module holds any key under its instance prefix.
    /// </summary>
    public bool HasInstanceStorage(UInt160 contract, byte prefix, BigInteger moduleId, byte[] tail) =>
        HasInstanceStorage(AccountId, contract, prefix, moduleId, tail);

    /// <summary>
    /// True while the module holds any key under its instance prefix. Instance keys are
    /// <c>prefix ‖ accountId(20) ‖ moduleId(8 BE) ‖ tail</c> (spec §10).
    /// </summary>
    public bool HasInstanceStorage(UInt160 accountId, UInt160 contract, byte prefix, BigInteger moduleId,
        byte[] tail)
    {
        byte[] key = new byte[] { prefix }
            .Concat(accountId.ToArray())
            .Concat(BigEndian(moduleId))
            .Concat(tail)
            .ToArray();
        VmArray state = (VmArray)Fx.Call(ContractManagement, "getContract", contract);
        Assert.IsTrue(state.Count > 0, "Contract " + contract + " is not deployed");
        StorageKey storageKey = new() { Id = (int)state[0].GetInteger(), Key = key };
        return Fx.Engine.Storage.Snapshot.TryGet(storageKey) != null;
    }

    private static byte[] BigEndian(BigInteger value)
    {
        byte[] encoded = new byte[8];
        for (int i = 7; i >= 0; i--)
        {
            encoded[i] = (byte)(value & 255);
            value >>= 8;
        }
        return encoded;
    }
}
