using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>Policy behavior against compiled NEFs, including real token storage rollback on FAULT.</summary>
[TestClass]
public class PolicySemanticsRuntimeTests
{
    private static readonly UInt160 Account = UInt160.Parse("0x1111111111111111111111111111111111111111");
    private static readonly UInt160 Merchant = UInt160.Parse("0x2222222222222222222222222222222222222222");
    private static readonly byte[] SubId = { 0x71, 0x72 };

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Token { get; }
        public UInt160 Asset { get; }
        public Harness()
        {
            Core = Fx.Deploy("MockVerifierCore");
            Token = Fx.Deploy("PolicyExecutionProbe");
            Asset = Fx.CallUInt160(Core, "getProxyScriptHash", Account);
            Fx.CallVoid(Token, "setBalance", Asset, 1000);
        }
        public UInt160 Deploy(string name) => Fx.Deploy(name, Core.ToArray());
        public void Forward(UInt160 policy, string method, params object?[] args) => Fx.CallVoid(Core, "forward", policy, method, args);
        public BigInteger Balance => Fx.CallInteger(Token, "balanceOf", Asset);
        public object?[] Args(BigInteger declared, BigInteger debit, object? result) => new object?[] { Asset, Merchant, declared, new object?[] { debit, result } };
        public object[] Op(object?[] args, byte[]? signature = null, BigInteger nonce = default) => RuntimeFixture.UserOp(Token, "transfer", args, nonce, Fx.Now() + 600000, signature ?? System.Array.Empty<byte>());
    }

    [TestMethod]
    public void DailyLimit_FalseAndZeroReturnCannotHideIndirectOutflow()
    {
        foreach (object result in new object[] { false, BigInteger.Zero })
            foreach (bool rolling in new[] { false, true })
            {
                Harness h = new();
                UInt160 hook = h.Deploy("hooks/DailyLimitHook");
                h.Forward(hook, "setDailyLimit", Account, h.Token, 50, rolling);
                object[] op = RuntimeFixture.UserOp(h.Token, "move", new object?[] { h.Asset, 60, result }, 0, 0, null);
                TestException fault = Assert.ThrowsExactly<TestException>(() => h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, op));
                StringAssert.Contains(fault.Message, "Daily limit exceeded");
                Assert.AreEqual(new BigInteger(1000), h.Balance, "Post-execution policy failure must roll back the token debit.");
            }
    }

    [TestMethod]
    public void DailyLimit_DirectTransferMetersExtraDebitAndDoesNotDoubleCount()
    {
        foreach (bool rolling in new[] { false, true })
        {
            Harness h = new();
            UInt160 hook = h.Deploy("hooks/DailyLimitHook");
            h.Forward(hook, "setDailyLimit", Account, h.Token, 50, rolling);
            object[] first = h.Op(h.Args(20, 40, true));
            h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, first);
            Assert.AreEqual(new BigInteger(960), h.Balance);
            object[] second = h.Op(h.Args(10, 11, true));
            TestException fault = Assert.ThrowsExactly<TestException>(() => h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, second));
            StringAssert.Contains(fault.Message, "Daily limit exceeded");
            Assert.AreEqual(new BigInteger(960), h.Balance);
            h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, h.Op(h.Args(10, 10, true)));
            Assert.AreEqual(new BigInteger(950), h.Balance, "Declared and actual spend must not be added twice.");
        }
    }

    [TestMethod]
    public void DailyLimit_FalseDirectTransferMetersOnlyActualOutflow()
    {
        Harness h = new();
        UInt160 hook = h.Deploy("hooks/DailyLimitHook");
        h.Forward(hook, "setDailyLimit", Account, h.Token, 50, false);
        h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, h.Op(h.Args(40, 20, false)));
        h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, h.Op(h.Args(30, 30, true)));
        Assert.AreEqual(new BigInteger(950), h.Balance);
        Assert.ThrowsExactly<TestException>(() => h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, h.Op(h.Args(1, 1, true))));
    }

    [TestMethod]
    public void DailyLimit_FixedWindowResetsFromFirstSpend()
    {
        Harness h = new();
        UInt160 hook = h.Deploy("hooks/DailyLimitHook");
        h.Forward(hook, "setDailyLimit", Account, h.Token, 50, false);
        h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, h.Op(h.Args(30, 30, true)));
        h.Fx.AdvanceTime(System.TimeSpan.FromHours(23));
        h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, h.Op(h.Args(20, 20, true)));
        h.Fx.AdvanceTime(System.TimeSpan.FromHours(2));
        h.Fx.Call(h.Token, "executeHook", h.Core, hook, Account, h.Op(h.Args(50, 50, true)));
        Assert.AreEqual(new BigInteger(900), h.Balance);
    }

    private static UInt160 Session(Harness h, P256SessionKey key, int cap = 100)
    {
        UInt160 verifier = h.Deploy("verifiers/SessionKeyVerifier");
        h.Forward(verifier, "setSessionKey", Account, key.CompressedPublicKey, h.Token, "transfer", h.Fx.Now() + 600000, cap, "policy semantics");
        return verifier;
    }

    private static object[] Sign(Harness h, UInt160 verifier, P256SessionKey key, object?[] args)
    {
        object[] op = h.Op(args);
        op[5] = key.Sign(h.Fx.CallBytes(verifier, "getPayload", Account, h.Token, "transfer", args, op[3], op[4]));
        return op;
    }

    [TestMethod]
    public void SessionKey_RejectsNonCanonicalTransferEvenWithValidSignature()
    {
        foreach (int cap in new[] { 0, 100 })
            foreach (int variant in new[] { 0, 1, 2, 3, 4, 5 })
            {
                Harness h = new();
                using P256SessionKey key = new();
                UInt160 verifier = Session(h, key, cap);
                object?[] args = variant switch
                {
                    0 => new object?[] { h.Asset, Merchant, 1 },
                    1 => new object?[] { h.Asset, Merchant, 1, null, null },
                    2 => new object?[] { Account, Merchant, 1, null },
                    3 => new object?[] { h.Asset, Merchant, -1, null },
                    4 => new object?[] { h.Asset, Merchant, new byte[] { 1 }, null },
                    _ => new object?[] { h.Asset, Merchant, true, null }
                };
                object[] op = Sign(h, verifier, key, args);
                Assert.ThrowsExactly<TestException>(() => h.Fx.CallBoolean(verifier, "validateSignature", Account, op), $"Malformed transfer variant {variant}, cap {cap} must fail closed.");
            }
    }

    [TestMethod]
    public void SessionKey_FalseOrNonBooleanTransferRollsBackTokenAndMeter()
    {
        foreach (object? result in new object?[] { false, BigInteger.Zero, BigInteger.One, null })
        {
            Harness h = new();
            using P256SessionKey key = new();
            UInt160 verifier = Session(h, key);
            object[] op = Sign(h, verifier, key, h.Args(30, 30, result));
            Assert.ThrowsExactly<TestException>(() => h.Fx.Call(h.Token, "executeVerifier", h.Core, verifier, Account, op));
            Assert.AreEqual(new BigInteger(1000), h.Balance);
            Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(verifier, "getSpentAmount", Account));
            object[] valid = Sign(h, verifier, key, h.Args(30, 30, true));
            h.Fx.Call(h.Token, "executeVerifier", h.Core, verifier, Account, valid);
            Assert.AreEqual(new BigInteger(970), h.Balance);
            Assert.AreEqual(new BigInteger(30), h.Fx.CallInteger(verifier, "getSpentAmount", Account));
        }
    }

    [TestMethod]
    public void SessionKey_ZeroValueTransferIsValidAndNonTransferFalseRetainsBusinessSemantics()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = Session(h, key);
        h.Fx.Call(h.Token, "executeVerifier", h.Core, verifier, Account, Sign(h, verifier, key, h.Args(0, 0, true)));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(verifier, "getSpentAmount", Account));

        Harness generic = new();
        UInt160 genericVerifier = generic.Deploy("verifiers/SessionKeyVerifier");
        generic.Forward(genericVerifier, "setSessionKey", Account, key.CompressedPublicKey, generic.Token, "move", generic.Fx.Now() + 600000, 0, "generic return value");
        object?[] args = { generic.Asset, 0, false };
        object[] op = RuntimeFixture.UserOp(generic.Token, "move", args, 0, generic.Fx.Now() + 600000, null);
        op[5] = key.Sign(generic.Fx.CallBytes(genericVerifier, "getPayload", Account, generic.Token, "move", args, op[3], op[4]));
        Assert.IsFalse(generic.Fx.CallBoolean(generic.Token, "executeVerifier", generic.Core, genericVerifier, Account, op));
        Assert.AreEqual(new BigInteger(1000), generic.Balance);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public void RealCore_FailedTransferRollsBackNonceTokenAndPolicyState(bool subscription)
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 token = fx.Deploy("PolicyExecutionProbe");
        UInt160 verifier = fx.Deploy("verifiers/" + (subscription ? "SubscriptionVerifier" : "SessionKeyVerifier"), wallet.ToArray());
        UInt160 owner = fx.Engine.ValidatorsAddress;
        UInt160 account = fx.CallUInt160(wallet, "computeRegistrationAccountId", verifier, System.Array.Empty<byte>(), UInt160.Zero, owner, 2592000u);
        fx.CallVoid(wallet, "registerAccount", account, verifier, System.Array.Empty<byte>(), UInt160.Zero, owner, 2592000u);
        UInt160 asset = fx.CallUInt160(wallet, "getProxyScriptHash", account);
        fx.CallVoid(token, "setBalance", asset, 1000);
        using P256SessionKey key = new();
        if (subscription)
        {
            object?[] configuration = { account, SubId, Merchant, token, 100, 60 };
            Assert.IsFalse(fx.CallBoolean(wallet, "callVerifier", account, "createSubscription", configuration));
            fx.AdvanceTime(System.TimeSpan.FromHours(24));
            fx.CallVoid(wallet, "callVerifier", account, "createSubscription", configuration);
        }
        else
        {
            fx.CallVoid(verifier, "setSessionKey", account, key.CompressedPublicKey, token, "transfer", fx.Now() + 600000, 100, "real core");
        }
        fx.SetSigners(Merchant); // The backup owner is absent; the configured verifier authorizes.
        BigInteger nonce = subscription ? SubscriptionNonce() : BigInteger.Zero;
        object[] Operation(bool accepted)
        {
            object?[] args = { asset, Merchant, 30, new object?[] { 30, accepted } };
            object[] op = RuntimeFixture.UserOp(token, "transfer", args, nonce, fx.Now() + 600000, SubId);
            if (!subscription)
                op[5] = key.Sign(fx.CallBytes(verifier, "getPayload", account, token, "transfer", args, nonce, op[4]));
            return op;
        }
        TestException fault = Assert.ThrowsExactly<TestException>(() => fx.Call(wallet, "executeUserOp", account, Operation(false)));
        StringAssert.Contains(fault.Message, "NEP-17 transfer failed");
        Assert.AreEqual(new BigInteger(1000), fx.CallInteger(token, "balanceOf", asset));
        Assert.AreEqual(BigInteger.Zero, fx.CallInteger(wallet, "getNonce", account, nonce >> 64));
        Assert.IsFalse(fx.CallBoolean(wallet, "isExecutionActive", account));
        Assert.IsTrue(fx.CallBoolean(wallet, "executeUserOp", account, Operation(true)));
        Assert.AreEqual(new BigInteger(970), fx.CallInteger(token, "balanceOf", asset));
        Assert.AreEqual(BigInteger.One, fx.CallInteger(wallet, "getNonce", account, nonce >> 64));
        Assert.IsFalse(fx.CallBoolean(wallet, "isExecutionActive", account));
        if (!subscription) Assert.AreEqual(new BigInteger(30), fx.CallInteger(verifier, "getSpentAmount", account));
    }

    private static UInt160 Subscription(Harness h)
    {
        UInt160 verifier = h.Deploy("verifiers/SubscriptionVerifier");
        h.Fx.SetSigners(h.Fx.Engine.ValidatorsAddress, Merchant);
        h.Forward(verifier, "createSubscription", Account, SubId, Merchant, h.Token, 100, 60);
        return verifier;
    }

    private static BigInteger SubscriptionNonce()
    {
        byte[] digest = SHA256.HashData(SubId);
        BigInteger tag = 0;
        for (int i = 0; i < 8; i++) tag = (tag << 8) + digest[i];
        return tag << 64;
    }

    [TestMethod]
    public void Subscription_FalseOrNonBooleanTransferPreservesBillingPeriodAndToken()
    {
        foreach (object? result in new object?[] { false, BigInteger.Zero, BigInteger.One, null })
        {
            Harness h = new();
            UInt160 verifier = Subscription(h);
            object[] op = h.Op(h.Args(30, 30, result), SubId, SubscriptionNonce());
            Assert.ThrowsExactly<TestException>(() => h.Fx.Call(h.Token, "executeVerifier", h.Core, verifier, Account, op));
            Assert.AreEqual(new BigInteger(1000), h.Balance);
            object[] retry = h.Op(h.Args(30, 30, true), SubId, SubscriptionNonce());
            h.Fx.Call(h.Token, "executeVerifier", h.Core, verifier, Account, retry);
            Assert.AreEqual(new BigInteger(970), h.Balance);
            Assert.ThrowsExactly<TestException>(() => h.Fx.CallBoolean(verifier, "validateSignature", Account, retry));
        }
    }

    [TestMethod]
    public void Subscription_RejectsMalformedAndNonPositiveAmounts()
    {
        foreach (object?[] args in new object?[][] {
            new object?[] { Account, Merchant, 1 },
            new object?[] { Account, Merchant, 1, null, null },
            new object?[] { Account, Merchant, -1, null },
            new object?[] { Account, Merchant, 0, null },
            new object?[] { Account, Merchant, new byte[] { 1 }, null },
            new object?[] { Account, Merchant, true, null } })
        {
            Harness h = new();
            UInt160 verifier = Subscription(h);
            args[0] = h.Asset;
            object[] op = h.Op(args, SubId, SubscriptionNonce());
            Assert.ThrowsExactly<TestException>(() => h.Fx.CallBoolean(verifier, "validateSignature", Account, op));
        }
    }
}
