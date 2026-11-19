using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Testing.Exceptions;
using VmArray = Neo.VM.Types.Array;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Per-instance hook configuration under protocol v4 (docs/SA-MODULE-PROTOCOL.md §9).
///
/// v3 combined several hooks in one <c>MultiHook</c> whose child roster was
/// configured through core-mediated <c>callHook</c> / <c>callHookChild</c> calls
/// with their own pending slot. v4 has no nested composition: every hook is its
/// own module instance, the core owns the <c>hookOrder</c> (§3.6), and instance
/// state is written by the same 24h configuration intent that installs,
/// reconfigures or uninstalls it. The consequences proven here are:
/// <list type="bullet">
/// <item>a hook's allowlist belongs to exactly one <c>(accountId, moduleId)</c> instance;</item>
/// <item>the hook re-authenticates the trusted core on every lifecycle call, so
/// owning the account's witness is not authority over module state;</item>
/// <item><c>hookOrder</c> and <c>moduleId:&lt;id&gt;</c> are disjoint intent
/// resources, so a roster reorder no longer invalidates a matured instance
/// configuration (the v3 combiner invalidated every pending child call);</item>
/// <item>uninstall sweeps the instance's private storage prefix, so a later
/// instance never inherits leaf state.</item>
/// </list>
/// </summary>
[TestClass]
public class HookInstanceConfigurationRuntimeTests
{
    private static readonly UInt160 Stranger =
        UInt160.Parse("0x8282828282828282828282828282828282828282");

    /// <summary>Native ContractManagement, used to read a contract's storage id.</summary>
    private static readonly UInt160 ContractManagement =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    /// <summary>24h module-change delay the every configuration intent waits out.</summary>
    private static readonly TimeSpan Window = TimeSpan.FromHours(24);

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Target { get; }
        public UInt160 Whitelist { get; }
        public UInt160 Restricted { get; }
        public P256SessionKey CustodyKey { get; } = new();
        public UInt160 Custody { get; }
        public UInt160 Account { get; private set; } = UInt160.Zero;

        public Harness()
        {
            Core = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            Whitelist = Fx.Deploy("hooks/WhitelistHook", Core.ToArray());
            Restricted = Fx.Deploy("hooks/TokenRestrictedHook", Core.ToArray());
            Custody = RuntimeFixture.CustodyOf(CustodyKey);
        }

        public void Create(params object[] actions)
        {
            Account = Fx.CreateAccount(Core, Custody, "hook-instance", actions);
        }

        public BigInteger[] HookIds() =>
            Fx.ModuleIds(Core, Account, RuntimeFixture.ModuleTypeNameHook);

        public BigInteger WhitelistId() =>
            Fx.FindModuleId(Core, Account, RuntimeFixture.ModuleTypeNameHook, Whitelist);

        public object AllowTarget(BigInteger moduleId) => Command(moduleId, "allowTarget", Target);

        public object DenyTarget(BigInteger moduleId) => Command(moduleId, "denyTarget", Target);

        public static object Command(BigInteger moduleId, string command, params object?[] args)
        {
            object?[] data = new object?[args.Length + 1];
            data[0] = command;
            for (int i = 0; i < args.Length; i++) data[i + 1] = args[i];
            return RuntimeFixture.ConfigureModule(moduleId, data);
        }

        public BigInteger Propose(params object[] actions) =>
            Fx.ProposeConfiguration(Core, Account, Custody, actions);

        public void Confirm(BigInteger intentId, params object[] actions) =>
            Fx.ConfirmConfiguration(Core, Account, Custody, intentId, actions);

        public void Commit(params object[] actions) =>
            Fx.ConfigureAfterTimelock(Core, Account, Custody, actions);

        public BigInteger[] PendingIds() =>
            ((VmArray)Fx.Call(Core, "getPendingConfigurationIntentIds", Account))
                .Select(item => item.GetInteger()).ToArray();

        /// <summary>Instance-scoped allowlist entry, read through the hook's own storage.</summary>
        public bool Whitelisted(BigInteger moduleId) =>
            Fx.CallBoolean(Whitelist, "isWhitelisted", Account, moduleId, Target);

        /// <summary>0x52 index 7: the instance revision, bumped by every configure.</summary>
        public BigInteger Revision(BigInteger moduleId) =>
            ((VmArray)Fx.Call(Core, "getModule", Account, moduleId))[7].GetInteger();

        /// <summary>
        /// True while the module holds any key under its instance prefix. Hook
        /// instance keys are <c>prefix ‖ accountId(20) ‖ moduleId(8 BE) ‖ tail</c>.
        /// </summary>
        public bool HasInstanceStorage(UInt160 contract, byte prefix, BigInteger moduleId, byte[] tail)
        {
            byte[] key = new byte[] { prefix }
                .Concat(Account.ToArray())
                .Concat(BigEndian(moduleId))
                .Concat(tail)
                .ToArray();
            return Fx.Engine.Storage.Snapshot.TryGet(StorageKeyOf(contract, key)) != null;
        }

        /// <summary>
        /// The writer-phase row (0x58) records which module instance a callback may
        /// address; it must never outlive the configuration transaction.
        /// </summary>
        public void AssertNoApplicationContext()
        {
            byte[] key = new byte[] { 0x58 }.Concat(Account.ToArray()).ToArray();
            Assert.IsNull(Fx.Engine.Storage.Snapshot.TryGet(StorageKeyOf(Core, key)),
                "The writer-phase row must not outlive the configuration transaction");
        }

        private StorageKey StorageKeyOf(UInt160 contract, byte[] key)
        {
            VmArray state = (VmArray)Fx.Call(ContractManagement, "getContract", contract);
            Assert.IsTrue(state.Count > 0, "Contract is not deployed");
            return new StorageKey { Id = (int)state[0].GetInteger(), Key = key };
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

    // ------------------------------------------------------------------
    // Instance configuration goes through the core's 24h intent
    // ------------------------------------------------------------------

    [TestMethod]
    public void HookInstanceIsConfiguredOnlyThroughAMaturedIntent()
    {
        Harness h = new();
        h.Create((object)h.Fx.InstallHook(h.Whitelist));
        BigInteger hookId = h.WhitelistId();

        Assert.AreEqual(BigInteger.One, hookId, "The first hook instance is allocated id 1");
        Assert.AreEqual(BigInteger.One, h.Revision(hookId), "Install is the instance's first revision");
        Assert.IsFalse(h.Whitelisted(hookId), "An install with empty initData leaves the instance unconfigured");
        CollectionAssert.AreEqual(new[] { hookId }, h.Fx.HookOrderIds(h.Core, h.Account),
            "Installing a hook appends it to the core-owned order");

        object configure = h.AllowTarget(hookId);
        BigInteger intentId = h.Propose((object)configure);
        Assert.IsFalse(h.Whitelisted(hookId), "A pending intent changes nothing");
        Assert.AreEqual(BigInteger.One, h.Revision(hookId));

        // The 24h module-change delay is the same gate the retired
        // callHook/callHookChild round trip enforced, but it is one intent.
        TestException immature = Assert.ThrowsExactly<TestException>(() =>
            h.Confirm(intentId, (object)configure));
        StringAssert.Contains(immature.Message, "SA_INTENT_IMMATURE");
        Assert.IsFalse(h.Whitelisted(hookId));

        h.Fx.AdvanceTime(Window);
        h.Confirm(intentId, (object)configure);
        Assert.IsTrue(h.Whitelisted(hookId));
        Assert.AreEqual(new BigInteger(2), h.Revision(hookId),
            "configure bumps the instance revision installed at 1");
        Assert.AreEqual(0, h.PendingIds().Length, "A committed intent leaves no pending record");
        h.AssertNoApplicationContext();
    }

    // ------------------------------------------------------------------
    // Only the trusted core writes module state
    // ------------------------------------------------------------------

    [TestMethod]
    public void HookConfigurationRejectsDirectUnauthorizedAndMalformedCalls()
    {
        Harness h = new();
        h.Create((object)h.Fx.InstallHook(h.Whitelist));
        BigInteger hookId = h.WhitelistId();
        object allow = h.AllowTarget(hookId);

        // Every lifecycle entry point requires the trusted core as the caller
        // (ModuleContext.RequireCoreCaller): owning the account's witness is not
        // authority over module state.
        var calls = new (string Method, object?[] Args)[]
        {
            ("configure", new object?[] { h.Account, hookId, BigInteger.One, new object[] { "allowTarget", h.Target } }),
            ("onInstall", new object?[] { h.Account, hookId, BigInteger.One, Array.Empty<object>() }),
            ("onUninstall", new object?[] { h.Account, hookId, BigInteger.One, Array.Empty<object>() }),
        };
        foreach (var call in calls)
        {
            TestException denied = Assert.ThrowsExactly<TestException>(() =>
                h.Fx.CallVoid(h.Whitelist, call.Method, call.Args));
            StringAssert.Contains(denied.Message, "Unauthorized caller",
                call.Method + " must reject a caller that is not the configured core");
        }

        // The core no longer hard-codes a per-hook child method allowlist; the
        // module decodes configData itself, and the core refuses to dispatch to
        // an instance id that was never installed.
        var rejected = new (object Action, string Message)[]
        {
            (Harness.Command(99, "allowTarget", h.Target), "SA_MODULE_NOT_INSTALLED"),
            (Harness.Command(hookId, "allowTarget"), "Invalid config arguments"),
            (Harness.Command(hookId, "update", h.Target), "Unknown config command"),
        };
        foreach (var test in rejected)
        {
            BigInteger intentId = h.Propose((object)test.Action);
            h.Fx.AdvanceTime(Window);
            TestException fault = Assert.ThrowsExactly<TestException>(() =>
                h.Confirm(intentId, (object)test.Action));
            StringAssert.Contains(fault.Message, test.Message);
            Assert.IsFalse(h.Whitelisted(hookId), "A faulting configure must leave the instance untouched");
            Assert.AreEqual(BigInteger.One, h.Revision(hookId));
            Assert.IsTrue(h.PendingIds().Contains(intentId), "A faulted confirmation keeps the proposal");
            h.Fx.CallVoid(h.Core, "cancelConfiguration", h.Account, intentId);
        }
        Assert.AreEqual(0, h.PendingIds().Length);

        h.Fx.SetSigners(Stranger);
        TestException unauthorized = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallInteger(h.Core, "proposeConfiguration", h.Account,
                new object[] { allow }, new object[0]));
        StringAssert.Contains(unauthorized.Message, "SA_UNAUTHORIZED");
        Assert.AreEqual(0, h.PendingIds().Length);
    }

    // ------------------------------------------------------------------
    // Roster and instance are independent intent resources
    // ------------------------------------------------------------------

    [TestMethod]
    public void RosterReorderAndInstanceConfigurationAreDisjointResources()
    {
        Harness h = new();
        h.Create((object)h.Fx.InstallHook(h.Whitelist), (object)h.Fx.InstallHook(h.Restricted));
        BigInteger[] hooks = h.HookIds();
        Assert.AreEqual(2, hooks.Length);
        CollectionAssert.AreEqual(hooks, h.Fx.HookOrderIds(h.Core, h.Account),
            "The hook order starts in install order");

        object reorder = RuntimeFixture.SetHookOrder(hooks[1], hooks[0]);
        object configure = h.AllowTarget(hooks[0]);

        BigInteger orderIntent = h.Propose((object)reorder);
        BigInteger configureIntent = h.Propose((object)configure);
        Assert.AreEqual(2, h.PendingIds().Length,
            "hookOrder and moduleId:<id> are disjoint resources and propose in parallel");

        h.Fx.AdvanceTime(Window);
        h.Confirm(orderIntent, (object)reorder);
        CollectionAssert.AreEqual(new[] { hooks[1], hooks[0] }, h.Fx.HookOrderIds(h.Core, h.Account));
        Assert.IsTrue(h.PendingIds().Contains(configureIntent),
            "A roster reorder must not invalidate a matured instance configuration");

        h.Confirm(configureIntent, (object)configure);
        Assert.IsTrue(h.Whitelisted(hooks[0]),
            "Each instance keeps its own allowlist: reordering the order does not move state");
        Assert.AreEqual(0, h.PendingIds().Length);
        h.AssertNoApplicationContext();
    }

    // ------------------------------------------------------------------
    // Reconfigure and uninstall own the instance's private state
    // ------------------------------------------------------------------

    [TestMethod]
    public void ReconfigureThenUninstallClearHookInstanceState()
    {
        Harness h = new();
        // initData configures the instance atomically with the install, so no
        // 24h wait is needed to reach the configured state under test.
        h.Create((object)h.Fx.InstallHook(h.Whitelist, "allowTarget", h.Target));
        BigInteger hookId = h.WhitelistId();
        Assert.IsTrue(h.Whitelisted(hookId));
        Assert.IsTrue(h.HasInstanceStorage(h.Whitelist, 0x01, hookId, h.Target.ToArray()),
            "The allowlist entry lives under the instance prefix");

        h.Commit((object)h.DenyTarget(hookId));
        Assert.IsFalse(h.Whitelisted(hookId), "Reconfiguring rewrites only this instance's allowlist");
        Assert.AreEqual(new BigInteger(2), h.Revision(hookId));
        Assert.IsFalse(h.HasInstanceStorage(h.Whitelist, 0x01, hookId, h.Target.ToArray()),
            "denyTarget deletes the entry instead of tombstoning it");

        h.Commit((object)h.DenyTarget(hookId), (object)h.AllowTarget(hookId));
        Assert.IsTrue(h.Whitelisted(hookId), "One intent may carry several instance commands atomically");
        Assert.AreEqual(new BigInteger(4), h.Revision(hookId),
            "Each configure action bumps the instance revision exactly once");

        h.Commit((object)RuntimeFixture.UninstallModule(hookId));
        Assert.AreEqual(0, h.HookIds().Length);
        Assert.AreEqual(0, h.Fx.HookOrderIds(h.Core, h.Account).Length,
            "Uninstall removes the core-owned hook-order entry");
        Assert.IsFalse(h.HasInstanceStorage(h.Whitelist, 0x01, hookId, h.Target.ToArray()),
            "Uninstall sweeps every key under the instance prefix");
        Assert.IsFalse(h.Whitelisted(hookId), "A detached instance holds no leaf state");
        h.AssertNoApplicationContext();
    }
}
