using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Module binding under protocol v4 (docs/SA-MODULE-PROTOCOL.md §7.3, §9, §10, §12).
///
/// The v3 suite pinned a "V3 marker" capability claim plus the retired verifier/hook call
/// surfaces (<c>registerAccount</c>, <c>callVerifier</c>, <c>callVerifierChild</c>,
/// <c>hasPendingVerifierCall</c>). v4 replaced that whole layer:
/// <list type="bullet">
///   <item>a module instance binds only when its own <c>getModuleProfile()</c> hashes to the
///   32-byte digest the configuration action committed to AND its manifest exposes the
///   complete callback surface of its module type;</item>
///   <item>composition lives in the core (one hook order, core-owned threshold policies), so
///   <c>MultiHook</c> is retired and a composite validator no longer calls children;</item>
///   <item>every post-registration change is one atomic, 24h-timelocked configuration intent
///   with per-resource conflicts instead of a single overwritable pending slot.</item>
/// </list>
/// These tests pin the v4 replacements of those guarantees, and the v4 rules that carry the
/// same intent where the mechanism changed shape.
/// </summary>
[TestClass]
public class Fix_ModuleAbi_Tests
{
    private static readonly UInt160 Owner =
        UInt160.Parse("0x2323232323232323232323232323232323232323");

    private static readonly TimeSpan IntentWindow =
        TimeSpan.FromHours(24) + TimeSpan.FromMinutes(1);

    private static readonly byte[] WrongDigest =
        Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();

    /// <summary>
    /// A raw install action with a caller-chosen digest, so a module that cannot even answer
    /// <c>getModuleProfile()</c> can be offered to the core.
    /// </summary>
    private static object[] RawInstall(int moduleType, UInt160 module, byte[] digest) =>
        new object[]
        {
            RuntimeFixture.ActionInstallModule, (BigInteger)moduleType, module,
            digest, (object[])Array.Empty<object?>()
        };

    // ------------------------------------------------------------------
    // Profile + callback ABI binding happens before any instance exists
    // ------------------------------------------------------------------

    [TestMethod]
    public void MarkerOnlyValidatorIsRejectedBeforeBinding()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 markerOnly = fx.Deploy("MarkerOnlyModule");

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CreateAccount(wallet, Owner, "abi-marker-validator",
                (object)RawInstall(RuntimeFixture.ModuleTypeValidator, markerOnly, WrongDigest)));

        // No getModuleProfile at all: the canonical-profile binding cannot even read the
        // bytes it must hash, so the instance never materializes.
        StringAssert.Contains(fault.Message, "SA_MODULE_CODE_BINDING_MISMATCH");
    }

    [TestMethod]
    public void MarkerOnlyHookIsRejectedBeforeBinding()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 markerOnly = fx.Deploy("MarkerOnlyModule");

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CreateAccount(wallet, Owner, "abi-marker-hook",
                (object)RawInstall(RuntimeFixture.ModuleTypeHook, markerOnly, WrongDigest)));

        StringAssert.Contains(fault.Message, "SA_MODULE_CODE_BINDING_MISMATCH");
    }

    [TestMethod]
    public void ProfileDigestMismatchIsRejectedBeforeBinding()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 validator = fx.Deploy("validators/P256Validator", wallet.ToArray());

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CreateAccount(wallet, Owner, "abi-digest",
                (object)RawInstall(RuntimeFixture.ModuleTypeValidator, validator, WrongDigest)));

        StringAssert.Contains(fault.Message, "SA_MODULE_CODE_BINDING_MISMATCH",
            "The committed digest must equal SHA-256 of the module's own getModuleProfile()");
    }

    [TestMethod]
    public void WrongValidatorLifecycleReturnTypeIsRejectedBeforeBinding()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 malformed = fx.Deploy("WrongLifecycleAbiModule");

        // The profile is canonical (and hashes correctly), so the failure is the callback
        // ABI shape: onInstall returns Any instead of Void.
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CreateAccount(wallet, Owner, "abi-wrong-validator",
                (object)fx.InstallValidator(malformed)));

        StringAssert.Contains(fault.Message, "SA_MODULE_TYPE_UNSUPPORTED");
    }

    [TestMethod]
    public void WrongHookLifecycleReturnTypeIsRejectedBeforeBinding()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 malformed = fx.Deploy("WrongHookLifecycleAbiModule");

        // preCheck returns Any instead of ByteArray.
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CreateAccount(wallet, Owner, "abi-wrong-hook",
                (object)fx.InstallHook(malformed)));

        StringAssert.Contains(fault.Message, "SA_MODULE_TYPE_UNSUPPORTED");
    }

    [TestMethod]
    public void ValidatorWithoutMessageCapabilityFailsClosed()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 validator = fx.Deploy("validators/NeoWitnessValidator", wallet.ToArray());
        UInt160 account = fx.CreateAccount(wallet, Owner, "abi-message",
            (object)fx.InstallValidator(validator));
        BigInteger moduleId = fx.ModuleIds(wallet, account, RuntimeFixture.ModuleTypeNameValidator)[0];

        // v3 stripped the optional message-signature ABI from the manifest and expected the
        // ERC-1271 entry to fail closed. v4 records the capability from the canonical profile
        // at install, and the module route refuses a validator that did not claim it.
        object[] envelope =
        {
            (BigInteger)RuntimeFixture.ModuleProtocolVersion,
            moduleId,
            (BigInteger)1,
            new object[] { new object[] { new byte[33], new byte[64] } }
        };
        byte[] result = fx.CallBytes(wallet, "isValidSignature", account, new byte[32], envelope);

        // The module route folds the kernel's capability refusal into the ERC-1271
        // magic, so this constant names the rejection row the case encodes.
        const string CapabilityAbsent = "SA_MODULE_MESSAGE_CAPABILITY_ABSENT";
        CollectionAssert.AreEqual(
            new byte[] { 0xFF, 0xFF, 0xFF, 0xFF },
            result,
            CapabilityAbsent + ": a validator whose profile omits messageCapability must fail closed, never fault");
    }

    // ------------------------------------------------------------------
    // Composition is core-owned: MultiHook retired, hook order composed
    // ------------------------------------------------------------------

    [TestMethod]
    public void MultiHookIsNotInstallableInProtocolV4()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 multiHook = fx.Deploy("hooks/MultiHook", wallet.ToArray());

        // The retired combiner still binds (its profile is canonical) but refuses to install:
        // v4 never nests composition, the core owns the hook order.
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CreateAccount(wallet, Owner, "abi-multihook", (object)fx.InstallHook(multiHook)));

        StringAssert.Contains(fault.Message, "MultiHook is not installable in protocol v4",
            "A retired composable hook must be rejected at install, not at execution");
    }

    [TestMethod]
    public void CoreHookOrderComposesInstalledHooks()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 whitelist = fx.Deploy("hooks/WhitelistHook", wallet.ToArray());
        UInt160 dailyLimit = fx.Deploy("hooks/DailyLimitHook", wallet.ToArray());

        UInt160 account = fx.CreateAccount(wallet, Owner, "abi-hook-order",
            (object)fx.InstallHook(whitelist), (object)fx.InstallHook(dailyLimit));

        BigInteger[] hookIds = fx.ModuleIds(wallet, account, RuntimeFixture.ModuleTypeNameHook);
        Assert.AreEqual(2, hookIds.Length);
        CollectionAssert.AreEqual(hookIds, fx.HookOrderIds(wallet, account),
            "The core hook order must list every installed hook in install order");

        // Removing one child of the (retired) combiner became removing one entry of the
        // core-owned order; the survivor keeps its execution slot.
        fx.ConfigureAfterTimelock(wallet, account, Owner,
            (object)RuntimeFixture.UninstallModule(hookIds[0]));
        CollectionAssert.AreEqual(new[] { hookIds[1] }, fx.HookOrderIds(wallet, account),
            "Uninstall must drop the instance from the core hook order");
    }

    [TestMethod]
    public void ThresholdPolicyRejectsUninstalledMember()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");

        // v3 pinned that a composite root validates its children before storing them. v4 has
        // no child-of-verifier roster: the core owns the threshold policy and every member
        // must already be an installed validator instance.
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CreateAccount(wallet, Owner, "abi-policy-member",
                (object)RuntimeFixture.SetThresholdPolicy(0, 1,
                    new[] { new BigInteger(99) }, true)));

        StringAssert.Contains(fault.Message, "SA_MODULE_NOT_INSTALLED");
    }

    // ------------------------------------------------------------------
    // Configuration intents: timelock, digest binding, resource conflicts
    // ------------------------------------------------------------------

    [TestMethod]
    public void ConfigurationIntentRequiresMaturityAndTheExactActionList()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 validator = fx.Deploy("validators/P256Validator", wallet.ToArray());
        UInt160 other = fx.Deploy("validators/SessionKeyValidator", wallet.ToArray());
        UInt160 account = fx.CreateAccount(wallet, Owner, "abi-intent");
        object[] install = fx.InstallValidator(validator);

        BigInteger intentId = fx.ProposeConfiguration(wallet, account, Owner, (object)install);

        TestException immature = Assert.ThrowsExactly<TestException>(() =>
            fx.ConfirmConfiguration(wallet, account, Owner, intentId, (object)install));
        StringAssert.Contains(immature.Message, "SA_INTENT_IMMATURE",
            "A module install must serve the uniform 24h module-change delay");
        Assert.AreEqual(0, fx.ModuleIds(wallet, account, RuntimeFixture.ModuleTypeNameValidator).Length,
            "An immature intent must not bind anything");

        fx.AdvanceTime(IntentWindow);
        TestException swapped = Assert.ThrowsExactly<TestException>(() =>
            fx.ConfirmConfiguration(wallet, account, Owner, intentId,
                (object)fx.InstallValidator(other)));
        StringAssert.Contains(swapped.Message, "SA_OPERATION_MALFORMED",
            "A matured intent is bound to its recorded action digest");

        fx.ConfirmConfiguration(wallet, account, Owner, intentId, (object)install);
        Assert.AreEqual(1, fx.ModuleIds(wallet, account, RuntimeFixture.ModuleTypeNameValidator).Length);
        Assert.IsFalse(fx.AccountDefaultOperationAuthorization(wallet, account),
            "Installing the first validator disables the built-in operation route");
    }

    [TestMethod]
    public void IndependentIntentsCoexistButConflictingOnesAreRejected()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 first = fx.Deploy("validators/NeoWitnessValidator", wallet.ToArray());
        UInt160 second = fx.Deploy("validators/P256Validator", wallet.ToArray());
        UInt160 account = fx.CreateAccount(wallet, Owner, "abi-intent-conflict");

        // v3 had one pending verifier-call slot that could not be overwritten. v4 has a
        // bounded index of intents that conflict per resource: two different modules are
        // independent proposals, the same module contract is one resource.
        BigInteger firstIntent = fx.ProposeConfiguration(wallet, account, Owner, (object)fx.InstallValidator(first));
        BigInteger secondIntent = fx.ProposeConfiguration(wallet, account, Owner, (object)fx.InstallValidator(second));
        Assert.AreNotEqual(firstIntent, secondIntent);
        Assert.AreEqual(2, PendingIntentCount(fx, wallet, account),
            "Independent intents must coexist instead of overwriting each other");

        TestException conflict = Assert.ThrowsExactly<TestException>(() =>
            fx.ProposeConfiguration(wallet, account, Owner, (object)fx.InstallValidator(first)));
        StringAssert.Contains(conflict.Message, "SA_INTENT_CONFLICT",
            "Two unresolved intents must never write the same module resource");
        Assert.AreEqual(2, PendingIntentCount(fx, wallet, account),
            "The rejected proposal must not disturb the pending set");
    }

    [TestMethod]
    public void ExpiredIntentCannotBeConfirmed()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccount");
        UInt160 validator = fx.Deploy("validators/P256Validator", wallet.ToArray());
        UInt160 account = fx.CreateAccount(wallet, Owner, "abi-intent-expiry");
        object[] install = fx.InstallValidator(validator);

        BigInteger intentId = fx.ProposeConfiguration(wallet, account, Owner, (object)install);
        // Maturity plus the 7-day expiry window.
        fx.AdvanceTime(TimeSpan.FromDays(8) + TimeSpan.FromHours(1));

        TestException expired = Assert.ThrowsExactly<TestException>(() =>
            fx.ConfirmConfiguration(wallet, account, Owner, intentId, (object)install));
        StringAssert.Contains(expired.Message, "SA_INTENT_EXPIRED");
        Assert.AreEqual(0, fx.ModuleIds(wallet, account, RuntimeFixture.ModuleTypeNameValidator).Length);
    }

    private static int PendingIntentCount(RuntimeFixture fx, UInt160 core, UInt160 accountId)
    {
        Neo.VM.Types.Array ids =
            (Neo.VM.Types.Array)fx.Call(core, "getPendingConfigurationIntentIds", accountId);
        return ids.Count;
    }
}
