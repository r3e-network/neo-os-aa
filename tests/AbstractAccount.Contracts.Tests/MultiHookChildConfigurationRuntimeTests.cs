using System;
using System.Linq;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

[TestClass]
public class MultiHookChildConfigurationRuntimeTests
{
    private static readonly UInt160 Stranger = UInt160.Parse("0x8282828282828282828282828282828282828282");
    private static readonly TimeSpan Window = TimeSpan.FromHours(24);

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Root { get; }
        public UInt160 Whitelist { get; }
        public UInt160 Restricted { get; }
        public UInt160 Target { get; }
        public UInt160 Account { get; }
        public UInt160 Owner => Fx.Engine.ValidatorsAddress;

        public Harness()
        {
            Core = Fx.Deploy("UnifiedSmartWalletV3");
            Target = Fx.Deploy("MockTransferTarget");
            Root = Fx.Deploy("hooks/MultiHook", Core.ToArray());
            Whitelist = Fx.Deploy("hooks/WhitelistHook", Core.ToArray());
            Restricted = Fx.Deploy("hooks/TokenRestrictedHook", Core.ToArray());
            Account = Fx.CallUInt160(Core, "computeRegistrationAccountId", UInt160.Zero,
                Array.Empty<byte>(), Root, Owner, 604800u);
            Fx.CallVoid(Core, "registerAccount", Account, UInt160.Zero, Array.Empty<byte>(), Root, Owner, 604800u);
            SetChildren(new[] { Whitelist, Restricted });
        }

        public object[] WhitelistArgs() => new object[] { Account, Target, true };

        public void SetChildren(UInt160[] children)
        {
            object[] args = { Account, children };
            Assert.IsFalse(Fx.CallBoolean(Core, "callHook", Account, "setHooks", args));
            Fx.AdvanceTime(Window);
            Fx.CallVoid(Core, "callHook", Account, "setHooks", args);
        }

        public bool Stage(string method, object[] args, UInt160? child = null) =>
            Fx.CallBoolean(Core, "callHookChild", Account, child ?? Whitelist, method, args);

        public void Apply(string method, object[] args, UInt160? child = null) =>
            Fx.CallVoid(Core, "callHookChild", Account, child ?? Whitelist, method, args);

        public StorageKey CoreStorageKey(byte prefix)
        {
            var state = (Neo.VM.Types.Array)Fx.Call(
                UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"), "getContract", Core);
            return new StorageKey { Id = (int)state[0].GetInteger(), Key = new[] { prefix }.Concat(Account.ToArray()).ToArray() };
        }

        public void AssertNoConfigContext() =>
            Assert.IsNull(Fx.Engine.Storage.Snapshot.TryGet(CoreStorageKey(0x05)));
    }

    [TestMethod]
    public void ChildConfiguration_InitializesWhitelistWithTwoPhaseAuthority()
    {
        Harness h = new();
        object[] args = h.WhitelistArgs();
        Assert.IsFalse(h.Stage("setWhitelist", args));
        Assert.IsFalse(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target));
        TestException early = Assert.ThrowsExactly<TestException>(() => h.Apply("setWhitelist", args));
        StringAssert.Contains(early.Message, "Timelock not elapsed");
        h.Fx.AdvanceTime(Window);
        h.Apply("setWhitelist", args);
        Assert.IsTrue(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target));
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "hasPendingHookCall", h.Account));
        h.AssertNoConfigContext();
    }

    [TestMethod]
    public void ChildConfiguration_RejectsUnauthorizedArbitraryAndMalformedCalls()
    {
        Harness h = new();
        object[] args = h.WhitelistArgs();
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Whitelist, "setWhitelist", args));
        TestException unlisted = Assert.ThrowsExactly<TestException>(() => h.Stage("setWhitelist", args, h.Target));
        StringAssert.Contains(unlisted.Message, "Child hook not installed");
        TestException method = Assert.ThrowsExactly<TestException>(() => h.Stage("update", args));
        StringAssert.Contains(method.Message, "Child hook configuration method not allowed");
        TestException malformed = Assert.ThrowsExactly<TestException>(() =>
            h.Stage("setWhitelist", new object[] { h.Account, h.Target }));
        StringAssert.Contains(malformed.Message, "Invalid child hook configuration arguments");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "hasPendingHookCall", h.Account));
        h.Fx.SetSigners(Stranger);
        TestException owner = Assert.ThrowsExactly<TestException>(() => h.Stage("setWhitelist", args));
        StringAssert.Contains(owner.Message, "Unauthorized");
    }

    [TestMethod]
    public void ChildConfiguration_TopologyChangeInvalidatesMaturedProposal()
    {
        Harness h = new();
        object[] args = h.WhitelistArgs();
        Assert.IsFalse(h.Stage("setWhitelist", args));
        h.Fx.AdvanceTime(Window);
        h.SetChildren(new[] { h.Restricted, h.Whitelist });
        Assert.IsFalse(h.Stage("setWhitelist", args));
        TestException stale = Assert.ThrowsExactly<TestException>(() => h.Apply("setWhitelist", args));
        StringAssert.Contains(stale.Message, "Timelock not elapsed");
        Assert.IsFalse(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target));
        h.Fx.AdvanceTime(Window);
        h.Apply("setWhitelist", args);
        Assert.IsTrue(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target));
    }

    [TestMethod]
    public void ChildConfiguration_ReconfigureAndDetachClearLeafState()
    {
        Harness h = new();
        object[] args = h.WhitelistArgs();
        Assert.IsFalse(h.Stage("setWhitelist", args));
        h.Fx.AdvanceTime(Window);
        h.Apply("setWhitelist", args);
        h.SetChildren(new[] { h.Restricted });
        Assert.IsFalse(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target));
        Assert.IsNotNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.CoreStorageKey(0x23)));
        h.AssertNoConfigContext();

        h.SetChildren(new[] { h.Whitelist });
        Assert.IsFalse(h.Stage("setWhitelist", args));
        h.Fx.AdvanceTime(Window);
        h.Apply("setWhitelist", args);
        Assert.IsTrue(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target));
        h.Fx.CallVoid(h.Core, "updateHook", h.Account, UInt160.Zero);
        h.Fx.AdvanceTime(Window);
        h.Fx.CallVoid(h.Core, "confirmHookUpdate", h.Account);
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Core, "getHook", h.Account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target));
        Assert.AreEqual(0, ((Neo.VM.Types.Array)h.Fx.Call(h.Root, "getHooks", h.Account)).Count);
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.CoreStorageKey(0x23)));
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.CoreStorageKey(0x24)));
        h.AssertNoConfigContext();
    }

    [TestMethod]
    public void ChildConfiguration_LegacyUnregisteredChildrenAreCleaned()
    {
        Harness h = new();
        object[] args = h.WhitelistArgs();
        Assert.IsFalse(h.Stage("setWhitelist", args));
        h.Fx.AdvanceTime(Window);
        h.Apply("setWhitelist", args);
        Assert.IsTrue(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target));

        h.Fx.Engine.Storage.Snapshot.Delete(h.CoreStorageKey(0x23));
        h.SetChildren(new[] { h.Restricted });
        Assert.IsFalse(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target),
            "A pre-registry account must enroll its old topology before removing a child.");

        h.SetChildren(new[] { h.Whitelist });
        Assert.IsFalse(h.Stage("setWhitelist", args));
        h.Fx.AdvanceTime(Window);
        h.Apply("setWhitelist", args);
        h.Fx.Engine.Storage.Snapshot.Delete(h.CoreStorageKey(0x23));
        h.Fx.CallVoid(h.Core, "updateHook", h.Account, UInt160.Zero);
        h.Fx.AdvanceTime(Window);
        h.Fx.CallVoid(h.Core, "confirmHookUpdate", h.Account);
        Assert.IsFalse(h.Fx.CallBoolean(h.Whitelist, "isWhitelisted", h.Account, h.Target));
        Assert.AreEqual(0, ((Neo.VM.Types.Array)h.Fx.Call(h.Root, "getHooks", h.Account)).Count);
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.CoreStorageKey(0x23)));
        h.AssertNoConfigContext();
    }
}
