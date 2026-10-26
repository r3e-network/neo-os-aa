using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

// Test-source preparation only. Run against freshly generated exact269
// UnifiedSmartWalletV3 and SocialRecoveryVerifier artifacts in contracts/bin/v3.
// RuntimeFixture loads actual NEFs into TestEngine; no authorization model is
// substituted. The protocol-version check rejects pre-v4 artifacts, but does
// not replace an external source/compiler/NEF hash provenance receipt.
public partial class FixRecoveryTests
{
    private sealed record IdentityGrantTicket(
        string ActionId, ulong ExpiresAt, byte[] Master, BigInteger Epoch,
        byte[] Nullifier, byte[] Signature);

    private static RecoveryHarness IdentityGrantHarness()
    {
        RecoveryHarness h = new();
        Assert.AreEqual(new BigInteger(4), h.Fx.CallInteger(h.Verifier, "getActionProtocolVersion"),
            "Fresh exact269 recovery NEF is required; do not substitute contracts/build artifacts.");
        return h;
    }

    private static IdentityGrantTicket IdentityGrantTicketFor(
        RecoveryHarness h, P256SessionKey key, byte[] account, string text,
        byte[] master, byte tag, BigInteger? epoch = null, ulong? expiry = null)
    {
        BigInteger generation = epoch ?? h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account);
        ulong expiresAt = expiry ?? (ulong)(h.Fx.Now() + 600_000);
        string actionId = h.BuildActionId(account, Executor, expiresAt);
        byte[] nullifier = Enumerable.Repeat(tag, 32).ToArray();
        byte[] signature = key.Sign(h.ComputeActionDigestV4(
            account, text, Executor, actionId, expiresAt, master, generation, nullifier));
        return new(actionId, expiresAt, master, generation, nullifier, signature);
    }

    private static void SubmitIdentityGrantTicket(RecoveryHarness h, byte[] account, IdentityGrantTicket ticket)
    {
        h.Fx.CallVoid(h.Verifier, "submitActionTicketV4", account, Executor,
            ticket.ActionId, ticket.ExpiresAt, ticket.Master, ticket.Epoch, ticket.Nullifier, ticket.Signature);
    }

    // Snapshot the real contract's public authorization/session state. This is
    // observation of VM state, not a model of grant or epoch transitions.
    private static object[] IdentityGrantState(
        RecoveryHarness h, byte[] account, byte[] master, byte[] nullifier)
    {
        var session = (Neo.VM.Types.Array)h.Fx.Call(h.Verifier, "getActiveSession", account);
        var identities = (Neo.VM.Types.Array)h.Fx.Call(h.Verifier, "getActionIdentities", account);
        return new object[]
        {
            h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account),
            h.Fx.CallInteger(h.Verifier, "getSessionNonce", account),
            h.Fx.CallInteger(h.Verifier, "getRecoveryNonce", account),
            h.Fx.CallUInt160(h.Verifier, "getOwner", account).ToString(),
            h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, master),
            h.Fx.CallBoolean(h.Verifier, "isActionNullifierUsed", account, nullifier),
            h.Fx.CallBoolean(h.Verifier, "isActionSessionAuthorized", account),
            Convert.ToHexString(session[0].GetSpan()), session[1].GetString() ?? string.Empty,
            Convert.ToHexString(session[2].GetSpan()), session[3].GetInteger(), session[4].GetBoolean(),
            string.Join(",", identities.Select(value => Convert.ToHexString(value.GetSpan())))
        };
    }

    private static void AssertIdentityGrantTicketRejected(
        RecoveryHarness h, byte[] account, IdentityGrantTicket ticket, string reason)
    {
        object[] before = IdentityGrantState(h, account, ticket.Master, ticket.Nullifier);
        TestException error = Assert.ThrowsExactly<TestException>(() => SubmitIdentityGrantTicket(h, account, ticket));
        StringAssert.Contains(error.Message, reason);
        CollectionAssert.AreEqual(before, IdentityGrantState(h, account, ticket.Master, ticket.Nullifier),
            "A rejected ticket changed public grant/epoch/owner/session/nullifier state.");
    }

    private static void CompleteIdentityGrantRecovery(
        RecoveryHarness h, P256SessionKey key, byte[] account, string text, byte tag)
    {
        string nonce = h.Fx.CallInteger(h.Verifier, "getRecoveryNonce", account).ToString();
        string expiresAt = (h.Fx.Now() + 600_000).ToString();
        string actionId = h.BuildRecoveryActionId(account, OwnerB, nonce);
        byte[] nullifier = Enumerable.Repeat(tag, 32).ToArray();
        byte[] signature = key.Sign(h.ComputeRecoveryDigest(
            account, text, OwnerB, nonce, expiresAt, actionId, Factor(), nullifier));
        h.Fx.SetSigners(Executor);
        h.Fx.CallVoid(h.Verifier, "submitRecoveryTicket", account, OwnerB, nonce,
            expiresAt, actionId, Factor(), nullifier, signature);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(MinRecoveryTimelockMs));
        h.Fx.CallVoid(h.Verifier, "finalizeRecovery", account);
        Assert.AreEqual(OwnerB, h.Fx.CallUInt160(h.Verifier, "getOwner", account));
    }

    [TestMethod]
    [TestCategory("DID-R1-IdentityGrantV4")]
    public void IdentityGrantV4_RecoveryFactorWithoutActionGrantDeniesWithoutConsumption()
    {
        RecoveryHarness h = IdentityGrantHarness(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("grant-required", OwnerA, key.CompressedPublicKey), master = Factor();
        IdentityGrantTicket denied = IdentityGrantTicketFor(h, key, account, "grant-required", master, 0x21);
        h.Fx.SetSigners(Executor);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isAllowedMasterNullifier", account, master));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, master));
        AssertIdentityGrantTicketRejected(h, account, denied, "Action identity not enrolled");

        h.Fx.SetSigners(OwnerA); h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        IdentityGrantTicket admitted = IdentityGrantTicketFor(h, key, account, "grant-required", master, 0x21);
        h.Fx.SetSigners(Executor); SubmitIdentityGrantTicket(h, account, admitted);
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Verifier, "getSessionNonce", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isActionNullifierUsed", account, denied.Nullifier));
    }

    [TestMethod]
    [TestCategory("DID-R1-IdentityGrantV4")]
    public void IdentityGrantV4_OnlyOwnerEnrollsThenExecutorActivatesWithoutOwnerWitness()
    {
        RecoveryHarness h = IdentityGrantHarness(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("ownerless", OwnerA, key.CompressedPublicKey), master = Factor();
        byte[] nullifier = Enumerable.Repeat((byte)0x22, 32).ToArray();
        h.Fx.SetSigners(Executor);
        object[] before = IdentityGrantState(h, account, master, nullifier);
        TestException notOwner = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true));
        StringAssert.Contains(notOwner.Message, "Not owner");
        CollectionAssert.AreEqual(before, IdentityGrantState(h, account, master, nullifier));
        h.Fx.SetSigners(OwnerA); h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        IdentityGrantTicket ticket = IdentityGrantTicketFor(h, key, account, "ownerless", master, 0x22);
        h.Fx.SetSigners(Executor);
        Assert.AreEqual(1, h.Fx.Engine.Transaction.Signers.Length);
        Assert.AreEqual(Executor, h.Fx.Engine.Transaction.Signers.Single().Account);
        SubmitIdentityGrantTicket(h, account, ticket);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isActionSessionAuthorized", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecutionMetaTx", account, new object?[] { Executor }));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyAdmin", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyAdminMetaTx", account, new object?[] { Executor }));
        AssertIdentityGrantTicketRejected(h, account, ticket, "Action nullifier already used");
    }

    [TestMethod]
    [TestCategory("DID-R1-IdentityGrantV4")]
    public void IdentityGrantV4_ConfigEpochChangeRejectsUnusedOldTicketAndAcceptsFreshEpoch()
    {
        RecoveryHarness h = IdentityGrantHarness(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("epoch", OwnerA, key.CompressedPublicKey), master = Factor();
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        IdentityGrantTicket old = IdentityGrantTicketFor(h, key, account, "epoch", master, 0x23);
        h.Fx.CallVoid(h.Verifier, "updateRecoveryConfig", account, Oracle,
            new object?[] { master }, BigInteger.One, MinRecoveryTimelockMs, key.CompressedPublicKey);
        Assert.IsTrue(h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account) > old.Epoch);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, master));
        h.Fx.SetSigners(Executor);
        AssertIdentityGrantTicketRejected(h, account, old, "Stale action authorization epoch");
        IdentityGrantTicket fresh = IdentityGrantTicketFor(h, key, account, "epoch", master, 0x23);
        SubmitIdentityGrantTicket(h, account, fresh);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
    }

    [TestMethod]
    [TestCategory("DID-R1-IdentityGrantV4")]
    public void IdentityGrantV4_RecoveryAndEveryRevocationInvalidateSessionAndUnusedTicket()
    {
        foreach (string operation in new[] { "recovery", "identity", "all", "session" })
        {
            RecoveryHarness h = IdentityGrantHarness(); using P256SessionKey key = new();
            byte[] account = h.SetupAccount("invalidate", OwnerA, key.CompressedPublicKey), master = Factor();
            h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
            ulong expiry = (ulong)(h.Fx.Now() + MinRecoveryTimelockMs + 600_000);
            IdentityGrantTicket active = IdentityGrantTicketFor(h, key, account, "invalidate", master, 0x24, expiry: expiry);
            h.Fx.SetSigners(Executor); SubmitIdentityGrantTicket(h, account, active);
            IdentityGrantTicket unused = IdentityGrantTicketFor(h, key, account, "invalidate", master, 0x25, expiry: expiry);
            h.Fx.SetSigners(OwnerA);
            if (operation == "recovery") CompleteIdentityGrantRecovery(h, key, account, "invalidate", 0x26);
            else if (operation == "identity") h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, false);
            else if (operation == "all") h.Fx.CallVoid(h.Verifier, "revokeAllActionIdentities", account);
            else h.Fx.CallVoid(h.Verifier, "revokeActionSession", account);
            Assert.IsTrue((ulong)h.Fx.Now() < expiry, "This must test invalidation, not natural expiry.");
            Assert.IsTrue(h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account) > unused.Epoch);
            h.Fx.SetSigners(Executor);
            Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isActionSessionAuthorized", account), operation);
            Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account), operation);
            Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecutionMetaTx", account, new object?[] { Executor }), operation);
            AssertIdentityGrantTicketRejected(h, account, unused, "Stale action authorization epoch");
            Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isActionNullifierUsed", account, unused.Nullifier));
        }
    }

    [TestMethod]
    [TestCategory("DID-R1-IdentityGrantV4")]
    public void IdentityGrantV4_IdempotentGrantPreservesSessionAndSeventeenthIdentityRollsBack()
    {
        RecoveryHarness h = IdentityGrantHarness(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("capacity", OwnerA, key.CompressedPublicKey), master = Factor();
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        IdentityGrantTicket ticket = IdentityGrantTicketFor(h, key, account, "capacity", master, 0x27);
        h.Fx.SetSigners(Executor); SubmitIdentityGrantTicket(h, account, ticket);
        object[] before = IdentityGrantState(h, account, master, ticket.Nullifier);
        h.Fx.SetSigners(OwnerA); h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        CollectionAssert.AreEqual(before, IdentityGrantState(h, account, master, ticket.Nullifier));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isActionSessionAuthorized", account));
        for (byte i = 1; i < 16; i++)
            h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, Enumerable.Repeat(i, 32).ToArray(), true);
        Assert.AreEqual(16, ((Neo.VM.Types.Array)h.Fx.Call(h.Verifier, "getActionIdentities", account)).Count);
        before = IdentityGrantState(h, account, master, ticket.Nullifier);
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        CollectionAssert.AreEqual(before, IdentityGrantState(h, account, master, ticket.Nullifier));
        TestException full = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, Enumerable.Repeat((byte)0x70, 32).ToArray(), true));
        StringAssert.Contains(full.Message, "Too many action identities");
        CollectionAssert.AreEqual(before, IdentityGrantState(h, account, master, ticket.Nullifier));
    }

    [TestMethod]
    [TestCategory("DID-R1-IdentityGrantV4")]
    public void IdentityGrantV4_UnmarkedSessionRequiresExactCurrentRecoveredOwnerConsent()
    {
        RecoveryHarness h = IdentityGrantHarness(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("old-session", OwnerA, key.CompressedPublicKey), master = Factor();
        CompleteIdentityGrantRecovery(h, key, account, "old-session", 0x28);
        ulong expiry = (ulong)(h.Fx.Now() + 600_000); string id = h.BuildActionId(account, Executor, expiry);
        byte[] nullifier = Enumerable.Repeat((byte)0x29, 32).ToArray();
        byte[] signature = key.Sign(h.ComputeActionDigest(account, "old-session", Executor, id, expiry, nullifier));
        h.Fx.SetSigners(OwnerB, Executor);
        h.Fx.CallVoid(h.Verifier, "submitActionTicket", account, Executor, id, expiry, nullifier, signature);
        // Synthetic pre-v4 storage shape in the real VM, not an old deployed NEF.
        h.DeleteNewActionStorage(account, 0x1A); h.DeleteNewActionStorage(account, 0x1C);
        h.Fx.SetSigners(Executor);
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        object[] before = IdentityGrantState(h, account, master, nullifier);
        foreach (UInt160 unauthorized in new[] { OwnerA, Executor, Attacker })
        {
            h.Fx.SetSigners(unauthorized);
            TestException error = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier,
                "reauthorizeActiveActionSession", account, Executor, id, expiry, nullifier));
            StringAssert.Contains(error.Message, "Not owner");
            CollectionAssert.AreEqual(before, IdentityGrantState(h, account, master, nullifier));
        }
        h.Fx.SetSigners(OwnerB);
        foreach (object?[] expected in new[]
        {
            new object?[] { Attacker, id, expiry, nullifier },
            new object?[] { Executor, id + "-changed", expiry, nullifier },
            new object?[] { Executor, id, expiry + 1, nullifier },
            new object?[] { Executor, id, expiry, Enumerable.Repeat((byte)0x2a, 32).ToArray() }
        })
        {
            TestException error = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier,
                "reauthorizeActiveActionSession", account, expected[0], expected[1], expected[2], expected[3]));
            StringAssert.Contains(error.Message, "Active session changed");
            CollectionAssert.AreEqual(before, IdentityGrantState(h, account, master, nullifier));
        }
        h.Fx.CallVoid(h.Verifier, "reauthorizeActiveActionSession", account, Executor, id, expiry, nullifier);
        Assert.IsTrue(h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account) > 0);
        h.Fx.SetSigners(Executor); Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isActionSessionAuthorized", account));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Verifier, "getSessionNonce", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, master));
        IdentityGrantTicket next = IdentityGrantTicketFor(h, key, account, "old-session", master, 0x2b);
        AssertIdentityGrantTicketRejected(h, account, next, "Action identity not enrolled");
    }

    [TestMethod]
    [TestCategory("DID-R1-IdentityGrantV4")]
    public void IdentityGrantV4_SameDisplayIdentityAndVerifierKeyDoNotAuthorizeAnotherAccount()
    {
        RecoveryHarness h = IdentityGrantHarness(); using P256SessionKey key = new();
        byte[] a = h.SetupAccount("same-display", OwnerA, key.CompressedPublicKey);
        byte[] b = h.SetupAccount("same-display", OwnerB, key.CompressedPublicKey), master = Factor();
        h.Fx.SetSigners(OwnerA); h.Fx.CallVoid(h.Verifier, "setActionIdentity", a, master, true);
        IdentityGrantTicket ticketB = IdentityGrantTicketFor(h, key, b, "same-display", master, 0x2c);
        object[] originalA = IdentityGrantState(h, a, master, ticketB.Nullifier);
        h.Fx.SetSigners(Executor); AssertIdentityGrantTicketRejected(h, b, ticketB, "Action identity not enrolled");
        CollectionAssert.AreEqual(originalA, IdentityGrantState(h, a, master, ticketB.Nullifier));
        h.Fx.SetSigners(OwnerB); h.Fx.CallVoid(h.Verifier, "setActionIdentity", b, master, true);
        IdentityGrantTicket ticketA = IdentityGrantTicketFor(h, key, a, "same-display", master, 0x2d);
        ticketB = IdentityGrantTicketFor(h, key, b, "same-display", master, 0x2d, expiry: ticketA.ExpiresAt);
        Assert.AreEqual(ticketA.Epoch, ticketB.Epoch);
        h.Fx.SetSigners(Executor);
        AssertIdentityGrantTicketRejected(h, b, ticketB with { Signature = ticketA.Signature }, "Invalid Morpheus action signature");
        SubmitIdentityGrantTicket(h, a, ticketA);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", a));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecution", b));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Verifier, "getSessionNonce", b));
    }

    [TestMethod]
    [TestCategory("DID-R1-IdentityGrantV4")]
    public void IdentityGrantV4_SignatureBindsNetworkVerifierAndGrantedIdentity()
    {
        RecoveryHarness h = IdentityGrantHarness(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("domains", OwnerA, key.CompressedPublicKey), master = Factor();
        byte[] otherMaster = Enumerable.Repeat((byte)0x6e, 32).ToArray();
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, otherMaster, true);
        IdentityGrantTicket ticket = IdentityGrantTicketFor(h, key, account, "domains", master, 0x2e);
        byte[][] wrongDomainSignatures =
        {
            key.Sign(h.ComputeActionDigestV4(account, "domains", Executor, ticket.ActionId,
                ticket.ExpiresAt, master, ticket.Epoch, ticket.Nullifier, signingNetwork: "neo3-mainnet")),
            key.Sign(h.ComputeActionDigestV4(account, "domains", Executor, ticket.ActionId,
                ticket.ExpiresAt, master, ticket.Epoch, ticket.Nullifier, signingVerifier: h.Core)),
            key.Sign(h.ComputeActionDigestV4(account, "domains", Executor, ticket.ActionId,
                ticket.ExpiresAt, otherMaster, ticket.Epoch, ticket.Nullifier))
        };
        h.Fx.SetSigners(Executor);
        foreach (byte[] signature in wrongDomainSignatures)
            AssertIdentityGrantTicketRejected(h, account, ticket with { Signature = signature }, "Invalid Morpheus action signature");
        SubmitIdentityGrantTicket(h, account, ticket);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
    }
}
