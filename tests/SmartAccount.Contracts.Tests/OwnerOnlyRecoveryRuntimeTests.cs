using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

[TestClass]
public class OwnerOnlyRecoveryRuntimeTests
{
    private const uint Delay = 604800;
    private static readonly UInt160 Stranger = UInt160.Parse("0x8181818181818181818181818181818181818181");
    private static readonly TimeSpan ConfigDelay = TimeSpan.FromHours(24);

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Faulting { get; }
        public UInt160 Hook { get; }
        public UInt160 Target { get; }
        public UInt160 Root { get; }
        public UInt160 Account { get; }
        public UInt160 Owner => Fx.Engine.ValidatorsAddress;
        public int CoreId { get; }

        public Harness(bool composite = false)
        {
            Core = Fx.Deploy("SmartAccountV3");
            Faulting = Fx.Deploy("MockVerifierCore");
            Hook = Fx.Deploy("hooks/WhitelistHook", Core.ToArray());
            Target = Fx.Deploy("MockTransferTarget");
            Root = composite ? Fx.Deploy("verifiers/MultiSigVerifier", Core.ToArray()) : Faulting;
            Account = Fx.CallUInt160(Core, "computeRegistrationAccountId", Root, Array.Empty<byte>(), Hook, Owner, Delay);
            Fx.CallVoid(Core, "registerAccount", Account, Root, Array.Empty<byte>(), Hook, Owner, Delay);
            var record = (Neo.VM.Types.Array)Fx.Call(UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"), "getContract", Core);
            CoreId = (int)record[0].GetInteger();
        }

        public StorageKey Key(byte prefix) => new() { Id = CoreId, Key = new[] { prefix }.Concat(Account.ToArray()).ToArray() };
        public void Seed(byte prefix, byte[] value) => Fx.Engine.Storage.Snapshot.Add(Key(prefix), new StorageItem(value));
        public StorageKey GlobalKey(byte prefix) => new() { Id = CoreId, Key = new[] { prefix } };
        public void SeedGlobal(byte prefix, byte[] value) => Fx.Engine.Storage.Snapshot.Add(GlobalKey(prefix), new StorageItem(value));
        public void Mature()
        {
            Fx.SetSigners(Owner);
            Fx.CallVoid(Core, "initiateEscape", Account);
            Fx.AdvanceTime(TimeSpan.FromSeconds(Delay));
        }
        public void Recover() => Fx.CallVoid(Core, "finalizeEscapeToOwner", Account);
        public void AssertLatched()
        {
            Assert.IsTrue(Fx.CallBoolean(Core, "isOwnerOnlyRecovery", Account));
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Core, "getVerifier", Account));
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Core, "getHook", Account));
        }
    }

    [TestMethod]
    public void OwnerOnlyRecovery_DetachesFaultingPluginWithoutCleanupAndPreservesNonceIdentity()
    {
        Harness h = new();
        UInt160 proxy = h.Fx.CallUInt160(h.Core, "getProxyScriptHash", h.Account);
        object[] whitelist = { h.Account, h.Target, true };
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "callHook", h.Account, "setWhitelist", whitelist));
        h.Fx.AdvanceTime(ConfigDelay);
        h.Fx.CallVoid(h.Core, "callHook", h.Account, "setWhitelist", whitelist);
        object[] op = RuntimeFixture.UserOp(h.Target, "transfer", new object?[] { proxy, Stranger, 1, null }, (BigInteger)7 << 64, h.Fx.Now() + 600000, Array.Empty<byte>());
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "executeUserOp", h.Account, op));
        h.Fx.CallVoid(h.Core, "setMetadataUri", h.Account, "ipfs://old-policy");
        h.Mature();
        TestException blocked = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "finalizeEscape", h.Account, UInt160.Zero));
        StringAssert.Contains(blocked.Message, "Mock plugin cleanup failure");
        h.Recover();
        h.AssertLatched();
        Assert.AreEqual(proxy, h.Fx.CallUInt160(h.Core, "getProxyScriptHash", h.Account));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Core, "getNonce", h.Account, 7));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Core, "getNonce", h.Account, 0));
        Assert.AreEqual(h.Owner, h.Fx.CallUInt160(h.Core, "getBackupOwner", h.Account));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Core, "getEscapeTriggeredAt", h.Account));
        Assert.AreEqual(string.Empty, h.Fx.Call(h.Core, "getMetadataUri", h.Account).GetString());
        Assert.IsTrue(h.Fx.CallBoolean(h.Hook, "isWhitelisted", h.Account, h.Target), "Old hook bytes may remain; it is detached permanently, not called during recovery.");
        h.Fx.SetSigners(Stranger);
        TestException denied = Assert.ThrowsExactly<TestException>(() => h.Fx.CallBoolean(h.Core, "executeUserOp", h.Account,
            RuntimeFixture.UserOp(h.Target, "transfer", new object?[] { proxy, Stranger, 1, null }, ((BigInteger)7 << 64) + 1, h.Fx.Now() + 600000, Array.Empty<byte>())));
        StringAssert.Contains(denied.Message, "Native witness failed");
        h.Fx.SetSigners(h.Owner);
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "executeUserOp", h.Account,
            RuntimeFixture.UserOp(h.Target, "transfer", new object?[] { proxy, Stranger, 1, null }, ((BigInteger)7 << 64) + 1, h.Fx.Now() + 600000, Array.Empty<byte>())));
    }

    [TestMethod]
    public void OwnerOnlyRecovery_PermanentlyRejectsRootsChildrenAndLegacyEscapeReplacement()
    {
        Harness h = new(composite: true);
        h.Mature();
        h.Recover();
        h.AssertLatched();
        foreach (UInt160 verifier in new[] { h.Root, h.Faulting })
        {
            TestException fault = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "updateVerifier", h.Account, verifier, Array.Empty<byte>()));
            StringAssert.Contains(fault.Message, "Owner-only recovery is permanent");
        }
        TestException hook = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "updateHook", h.Account, h.Hook));
        StringAssert.Contains(hook.Message, "Owner-only recovery is permanent");
        TestException child = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "callVerifierChild", h.Account, h.Faulting, "setPublicKey", new object[] { h.Account, Array.Empty<byte>() }));
        StringAssert.Contains(child.Message, "Owner-only recovery is permanent");
        h.Fx.CallVoid(h.Core, "updateVerifier", h.Account, UInt160.Zero, Array.Empty<byte>());
        h.Fx.CallVoid(h.Core, "updateHook", h.Account, UInt160.Zero);
        h.Mature();
        TestException legacy = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "finalizeEscape", h.Account, h.Root));
        StringAssert.Contains(legacy.Message, "Owner-only recovery is permanent");
        h.Fx.CallVoid(h.Core, "finalizeEscape", h.Account, UInt160.Zero);
        h.AssertLatched();
    }

    [TestMethod]
    public void OwnerOnlyRecovery_ClearsEveryPendingIntentAndRejectsRepeat()
    {
        Harness h = new();
        h.Fx.CallVoid(h.Core, "updateVerifier", h.Account, h.Faulting, Array.Empty<byte>());
        h.Fx.CallVoid(h.Core, "updateHook", h.Account, h.Hook);
        h.Fx.CallBoolean(h.Core, "callVerifier", h.Account, "clearAccount", new object[] { h.Account });
        h.Fx.CallBoolean(h.Core, "callHook", h.Account, "clearAccount", new object[] { h.Account });
        // Phase 1b: pending platform owner rotations moved to the registrar service's
        // storage, so a raw 0x20 row is no longer core-owned state to sweep.
        h.Seed(0x06, UInt160.Zero.ToArray());
        h.Seed(0x07, new byte[] { 1 });
        h.Seed(0x1D, new byte[] { 1 });
        h.Seed(0x13, new byte[] { 1 });
        h.Mature();
        h.Recover();
        foreach (byte prefix in new byte[] { 0x02, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x1D, 0x13 })
            Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key(prefix)), $"Stale account marker {prefix:X2}");
        TestException repeat = Assert.ThrowsExactly<TestException>(() => h.Recover());
        StringAssert.Contains(repeat.Message, "Already recovered to owner-only");
        h.AssertLatched();
    }

    [TestMethod]
    [DataRow(0x02)]
    [DataRow(0x04)]
    [DataRow(0x05)]
    [DataRow(0x0B)]
    [DataRow(0x0D)]
    [DataRow(0x0E)]
    public void OwnerOnlyRecovery_RejectsEveryActiveContext(int prefix)
    {
        Harness h = new();
        h.Mature();
        h.Seed((byte)prefix, new byte[] { 1 });
        TestException locked = Assert.ThrowsExactly<TestException>(() => h.Recover());
        StringAssert.Contains(locked.Message, "Recovery context active");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", h.Account));
        Assert.AreEqual(h.Root, h.Fx.CallUInt160(h.Core, "getVerifier", h.Account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isEscapeActive", h.Account));
        Assert.IsNotNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key((byte)prefix)));
    }

    [TestMethod]
    public void OwnerOnlyRecovery_RejectsGlobalConfigurationContext()
    {
        Harness h = new();
        h.Mature();
        h.SeedGlobal(0x26, new byte[] { 1 });
        TestException locked = Assert.ThrowsExactly<TestException>(() => h.Recover());
        StringAssert.Contains(locked.Message, "Recovery context active");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", h.Account));
        Assert.AreEqual(h.Root, h.Fx.CallUInt160(h.Core, "getVerifier", h.Account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isEscapeActive", h.Account));
        Assert.IsNotNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.GlobalKey(0x26)));
    }

    [TestMethod]
    public void OwnerOnlyRecovery_RejectsMissingInitiationImmatureAndUnauthorizedCalls()
    {
        Harness h = new();
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", h.Account));
        TestException unarmed = Assert.ThrowsExactly<TestException>(() => h.Recover());
        StringAssert.Contains(unarmed.Message, "Escape not initiated");
        h.Fx.CallVoid(h.Core, "initiateEscape", h.Account);
        h.Fx.AdvanceTime(TimeSpan.FromSeconds(Delay) - TimeSpan.FromMilliseconds(1));
        TestException early = Assert.ThrowsExactly<TestException>(() => h.Recover());
        StringAssert.Contains(early.Message, "Timelock active");
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(1));
        h.Fx.SetSigners(Stranger);
        TestException denied = Assert.ThrowsExactly<TestException>(() => h.Recover());
        StringAssert.Contains(denied.Message, "Only backup owner can finalize");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", h.Account));
        h.Fx.SetSigners(h.Owner);
        h.Recover();
        h.AssertLatched();
    }

    [TestMethod]
    public void OwnerOnlyRecovery_RejectsEscrowAndPreservesBinding()
    {
        Harness h = new();
        h.Mature();
        UInt160 market = h.Fx.Deploy("AAAddressMarket");
        h.Fx.CallVoid(market, "setAllowedAA", h.Core, true);
        // Phase 1b: the core admin (the deploying validators account) registers the
        // market as an approved escrow service.
        h.Fx.CallVoid(h.Core, "setMarketService", market, true);
        h.Fx.CallVoid(market, "createListing", h.Core, h.Account, 100000000, "account", "");
        TestException locked = Assert.ThrowsExactly<TestException>(() => h.Recover());
        StringAssert.Contains(locked.Message, "Account locked in market escrow");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", h.Account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isMarketEscrowActive", h.Account));
    }

    [TestMethod]
    public void OwnerOnlyRecovery_RejectsCleanupCallbackReentryAndRollsBackOuterRotation()
    {
        Harness h = new();
        h.Fx.CallVoid(h.Core, "updateVerifier", h.Account, UInt160.Zero, Array.Empty<byte>());
        h.Mature();
        h.Fx.CallVoid(h.Faulting, "setCleanupRecoveryTarget", h.Core);
        TestException reentry = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "confirmVerifierUpdate", h.Account));
        StringAssert.Contains(reentry.Message, "Recovery context active");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", h.Account));
        Assert.AreEqual(h.Faulting, h.Fx.CallUInt160(h.Core, "getVerifier", h.Account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "hasPendingVerifierUpdate", h.Account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isEscapeActive", h.Account));
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key(0x04)), "Faulted config grant must roll back.");
        h.Recover();
        h.AssertLatched();
    }

    [TestMethod]
    public void OwnerOnlyRecovery_RejectsForgedLegacyContextsPendingConfirmationAndMaintenance()
    {
        Harness h = new();
        h.Mature();
        h.Recover();
        foreach (byte prefix in new byte[] { 0x04, 0x05, 0x0D, 0x0E }) h.Seed(prefix, h.Faulting.ToArray());
        foreach (string method in new[] { "canConfigureVerifier", "canConfigureHook" })
            Assert.IsFalse(h.Fx.CallBoolean(h.Faulting, "forward", h.Core, method, new object[] { h.Account, h.Faulting }));
        foreach (string method in new[] { "canExecuteVerifier", "canExecuteHook" })
            Assert.IsFalse(h.Fx.CallBoolean(h.Faulting, "forward", h.Core, method, new object[] { h.Account, h.Core, h.Faulting }));
        foreach (string method in new[] { "callVerifier", "callHook" })
        {
            TestException fault = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, method, h.Account, "clearAccount", new object[] { h.Account }));
            StringAssert.Contains(fault.Message, "Owner-only recovery is permanent");
        }
        byte[] pending = h.Fx.StdLibSerialize(new object[] { h.Faulting, h.Hook, Array.Empty<byte>(), 1 });
        h.Seed(0x09, pending);
        h.Seed(0x0A, pending);
        foreach (string method in new[] { "confirmVerifierUpdate", "confirmHookUpdate" })
        {
            TestException fault = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, method, h.Account));
            StringAssert.Contains(fault.Message, "Owner-only recovery is permanent");
        }
        h.AssertLatched();
    }

    [TestMethod]
    public void OwnerOnlyRecovery_MarketBuyerInheritsPermanentRestriction()
    {
        Harness h = new();
        h.Mature();
        h.Recover();
        UInt160 market = h.Fx.Deploy("AAAddressMarket");
        h.Fx.CallVoid(market, "setAllowedAA", h.Core, true);
        // Phase 1b: the core admin (the deploying validators account) registers the
        // market as an approved escrow service.
        h.Fx.CallVoid(h.Core, "setMarketService", market, true);
        h.Fx.CallVoid(market, "createListing", h.Core, h.Account, 100000000, "account", "");
        BigInteger listing = h.Fx.CallInteger(market, "getListingCount");
        h.Fx.FundGasFromValidators(Stranger, 200000000);
        h.Fx.SetSigners(Stranger);
        h.Fx.TransferGas(Stranger, market, 100000000, listing);
        h.Fx.CallVoid(market, "settleListing", listing, Stranger, Stranger);
        Assert.AreEqual(Stranger, h.Fx.CallUInt160(h.Core, "getBackupOwner", h.Account));
        TestException fault = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "updateVerifier", h.Account, h.Faulting, Array.Empty<byte>()));
        StringAssert.Contains(fault.Message, "Owner-only recovery is permanent");
        h.AssertLatched();
    }

    [TestMethod]
    public void OwnerOnlyRecovery_DoesNotChangeOtherAccountAuthority()
    {
        Harness h = new();
        UInt160 peer = h.Fx.CallUInt160(h.Core, "computeRegistrationAccountId", h.Faulting, Array.Empty<byte>(), UInt160.Zero, h.Owner, Delay);
        h.Fx.CallVoid(h.Core, "registerAccount", peer, h.Faulting, Array.Empty<byte>(), UInt160.Zero, h.Owner, Delay);
        h.Mature();
        h.Recover();
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", peer));
        Assert.AreEqual(h.Faulting, h.Fx.CallUInt160(h.Core, "getVerifier", peer));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Core, "getNonce", peer, 0));
        UInt160 proxy = h.Fx.CallUInt160(h.Core, "getProxyScriptHash", peer);
        h.Fx.SetSigners(Stranger);
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "executeUserOp", peer,
            RuntimeFixture.UserOp(h.Target, "transfer", new object?[] { proxy, Stranger, 1, null }, 0, h.Fx.Now() + 600000, Array.Empty<byte>())));
        h.AssertLatched();
    }

    [TestMethod]
    public void OwnerOnlyRecovery_PlatformRotationSurvivesEscapeAndInheritsRestriction()
    {
        Harness h = new();
        UInt160 registrar = h.Fx.Deploy("AAPlatformRegistrar", h.Core.ToArray());
        byte[] binding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:owner-only-recovery");
        h.Fx.CallVoid(h.Core, "proposePlatformRegistrar", registrar);
        h.Fx.AdvanceTime(TimeSpan.FromDays(7));
        h.Fx.CallVoid(h.Core, "confirmPlatformRegistrar");
        UInt160 account = h.Fx.CallUInt160(registrar, "registerStablePlatformAccount", binding, h.Owner, Delay);
        h.Fx.CallVoid(h.Core, "updateVerifier", account, h.Faulting, Array.Empty<byte>());
        UInt160 proxy = h.Fx.CallUInt160(h.Core, "getProxyScriptHash", account);
        h.Fx.CallVoid(registrar, "proposePlatformAccountOwnerRotation", account, binding, Stranger);
        h.Fx.CallVoid(h.Core, "initiateEscape", account);
        h.Fx.AdvanceTime(TimeSpan.FromSeconds(Delay));
        h.Fx.CallVoid(h.Core, "finalizeEscapeToOwner", account);
        // Phase 1b: the registrar service owns the pending rotation record, so escape
        // finalization no longer clears it; completing it still needs the new owner's
        // witness through the core's registrar-gated apply.
        Assert.AreEqual(Neo.VM.Types.StackItemType.Array,
            h.Fx.Call(registrar, "getPendingPlatformOwnerRotation", account).Type);
        h.Fx.AdvanceTime(TimeSpan.FromDays(7));
        h.Fx.SetSigners(Stranger);
        h.Fx.CallVoid(registrar, "confirmPlatformAccountOwnerRotation", account, binding);
        Assert.AreEqual(Stranger, h.Fx.CallUInt160(h.Core, "getBackupOwner", account));
        Assert.AreEqual(proxy, h.Fx.CallUInt160(h.Core, "getProxyScriptHash", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", account));
        TestException denied = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "updateHook", account, h.Hook));
        StringAssert.Contains(denied.Message, "Owner-only recovery is permanent");
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallUInt160(registrar, "registerStablePlatformAccount", binding, Stranger, Delay));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", account));
    }

    [TestMethod]
    public void OwnerOnlyRecovery_RejectsMalformedAndUnknownAccountIds()
    {
        Harness h = new();
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "finalizeEscapeToOwner", new byte[19]));
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", new byte[19]));
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Core, "finalizeEscapeToOwner", UInt160.Zero));
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", Stranger));
    }
}
