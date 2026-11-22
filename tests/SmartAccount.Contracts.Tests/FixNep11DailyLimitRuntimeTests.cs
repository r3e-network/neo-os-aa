using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression for audit finding #7 (Mark): a daily-limit hook that limits only GAS used
/// to read any <c>transfer</c> operation as a NEP-17 payload, so a non-divisible NEP-11
/// <c>transfer(to, tokenId, data)</c> was parsed as <c>(from, to, amount, data)</c> — the
/// token id became the recipient and the callback data the amount — and the shape
/// assertion fired before the hook had even checked whether that target had a configured
/// limit. Legitimate NFT operations were rejected.
/// </summary>
/// <remarks>
/// The fix resolves the target first and only takes the precise NEP-17 ABI fast path for a
/// token this instance explicitly limits; every other operation keeps the balance-delta
/// metering of the configured assets. These vectors prove both halves: foreign ABIs succeed
/// untouched under a GAS-only limit, and the GAS limit still meters and still rejects.
/// </remarks>
[TestClass]
public class FixNep11DailyLimitRuntimeTests
{
    private static readonly UInt160 Recipient =
        UInt160.Parse("0x5151515151515151515151515151515151515151");

    /// <summary>A one-byte token id: far shorter than an address, so it can never be one.</summary>
    private static byte[] ShortTokenId() => new byte[] { 0x2A };

    /// <summary>A 20-byte token id, the length that used to make the misparse look plausible.</summary>
    private static byte[] LongTokenId() =>
        new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 };

    private static byte[] TokenId(byte seed) => new byte[] { seed, 0x11, 0x22 };

    /// <summary>
    /// A hook that limits only GAS must not touch a NEP-11 transfer: the three-argument
    /// non-divisible form and the five-argument divisible form both execute, the GAS meter
    /// keeps rejecting an over-limit transfer, and metering is unaffected by the foreign ABIs.
    /// </summary>
    [TestMethod]
    public void GasOnlyLimitNeverParsesANep11TransferAsNep17()
    {
        AssetRuntimeHarness h = new();
        UInt160 nft = h.DeployToken("MockNep11Token");
        UInt160 divisible = h.DeployToken("MockDivisibleNep11Token");
        UInt160 hook = h.DeployModule("hooks/DailyLimitHook");
        h.CreateAccount("nep11-vs-gas", new object[]
        {
            h.Fx.InstallHook(hook, new object?[] { "setDailyLimit", h.Fx.GasHash, (BigInteger)50, false })
        });
        BigInteger hookId = h.HookId(hook);
        Assert.AreNotEqual(BigInteger.Zero, hookId, "The GAS-only hook must be installed");
        Assert.AreEqual(new BigInteger(50), h.Fx.CallInteger(hook, "getDailyLimit", h.AccountId, hookId, h.Fx.GasHash));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(hook, "getDailyLimit", h.AccountId, hookId, nft),
            "The NFT target must have no configured limit");

        h.AsTokenAdmin();
        h.Fx.FundGasFromValidators(h.Asset, 1000);
        h.Fx.CallVoid(nft, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(divisible, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(nft, "mint", h.Asset, ShortTokenId());
        h.Fx.CallVoid(divisible, "mint", h.Asset, LongTokenId(), 100);

        // Non-divisible NEP-11: transfer(to, tokenId, data) — a one-byte token id and null data.
        Assert.IsTrue(h.Execute(h.BuiltInOp(nft, "transfer", new object?[] { Recipient, ShortTokenId(), null })),
            "A GAS-only limit must not reject a legitimate NEP-11 transfer");
        Assert.AreEqual(Recipient, h.Fx.CallUInt160(nft, "ownerOf", ShortTokenId()));
        Assert.AreEqual(BigInteger.Zero, h.BuiltInSequence - 1,
            "The nonce advances exactly once per accepted operation");

        // Divisible NEP-11: transfer(from, to, amount, tokenId, data) — five arguments.
        Assert.IsTrue(h.Execute(h.BuiltInOp(divisible, "transfer",
                new object?[] { h.Asset, Recipient, (BigInteger)40, LongTokenId(), null })),
            "The divisible NEP-11 payload is not a NEP-17 payload and must execute");
        Assert.AreEqual(new BigInteger(40),
            h.Fx.CallInteger(divisible, "balanceOf", Recipient, LongTokenId()));
        Assert.AreEqual(new BigInteger(60),
            h.Fx.CallInteger(divisible, "balanceOf", h.Asset, LongTokenId()));

        // The GAS meter is untouched by the NFT operations: an in-limit transfer is accepted…
        Assert.IsTrue(h.Execute(h.BuiltInOp(h.Fx.GasHash, "transfer",
            new object?[] { h.Asset, Recipient, (BigInteger)30, null })));
        Assert.AreEqual(new BigInteger(970), h.Fx.GasBalanceOf(h.Asset));

        // …and a transfer beyond the 50 limit is still rejected, with the whole debit rolled back.
        TestException over = Assert.ThrowsExactly<TestException>(() => h.Execute(h.BuiltInOp(h.Fx.GasHash, "transfer",
            new object?[] { h.Asset, Recipient, (BigInteger)30, null })));
        StringAssert.Contains(over.Message, "Daily limit exceeded");
        Assert.AreEqual(new BigInteger(970), h.Fx.GasBalanceOf(h.Asset));
        Assert.AreEqual(new BigInteger(3), h.BuiltInSequence,
            "A rejected operation must not consume the nonce (three accepted operations before it)");
        Assert.IsFalse(h.ExecutionActive, "The execution lock must be released by the rollback");

        // A 20-byte token id with null data is still an NFT operation, never a NEP-17 transfer.
        h.AsTokenAdmin();
        h.Fx.CallVoid(nft, "mint", h.Asset, LongTokenId());
        Assert.IsTrue(h.Execute(h.BuiltInOp(nft, "transfer", new object?[] { Recipient, LongTokenId(), null })));
        Assert.AreEqual(Recipient, h.Fx.CallUInt160(nft, "ownerOf", LongTokenId()));
    }

    /// <summary>
    /// When the NFT itself is the configured asset the hook cannot use the NEP-17 ABI fast
    /// path either, so it meters the realized <c>balanceOf</c> delta instead: the first token
    /// leaves, the second is rejected and rolled back.
    /// </summary>
    [TestMethod]
    public void ConfiguredNep11TokenIsMeteredByBalanceDelta()
    {
        AssetRuntimeHarness h = new();
        UInt160 nft = h.DeployToken("MockNep11Token");
        UInt160 hook = h.DeployModule("hooks/DailyLimitHook");
        h.CreateAccount("nep11-metered", new object[]
        {
            h.Fx.InstallHook(hook, new object?[] { "setDailyLimit", nft, (BigInteger)1, false })
        });
        h.AsTokenAdmin();
        h.Fx.CallVoid(nft, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(nft, "mint", h.Asset, TokenId(1));
        h.Fx.CallVoid(nft, "mint", h.Asset, TokenId(2));
        Assert.AreEqual(new BigInteger(2), h.Fx.CallInteger(nft, "balanceOf", h.Asset));

        Assert.IsTrue(h.Execute(h.BuiltInOp(nft, "transfer", new object?[] { Recipient, TokenId(1), null })),
            "The first NFT leaves inside a limit of one");
        Assert.AreEqual(Recipient, h.Fx.CallUInt160(nft, "ownerOf", TokenId(1)));
        Assert.AreEqual(new BigInteger(1), h.Fx.CallInteger(nft, "balanceOf", h.Asset));

        TestException second = Assert.ThrowsExactly<TestException>(() => h.Execute(
            h.BuiltInOp(nft, "transfer", new object?[] { Recipient, TokenId(2), null })));
        StringAssert.Contains(second.Message, "Daily limit exceeded");
        Assert.AreEqual(h.Asset, h.Fx.CallUInt160(nft, "ownerOf", TokenId(2)),
            "The rejected NFT transfer must be rolled back");
        Assert.AreEqual(new BigInteger(1), h.Fx.CallInteger(nft, "balanceOf", h.Asset));
    }
}
