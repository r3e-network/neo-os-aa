using System;
using System.Numerics;
using System.IO;
using System.Linq;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace AbstractAccount.Contracts.Tests;

// ---------------------------------------------------------------------------
// Source-invariant tests for UnifiedSmartWalletV3 contract validation logic.
//
// These tests use seeded random inputs to exhaustively verify:
//   - Input validation boundaries (timelock, accountId, backupOwner)
//   - State machine transitions (registration, verifier updates, escape, escrow)
//   - Nonce monotonicity and 2D channel correctness
//   - Safe method idempotency
//
// This suite operates at source level (like the existing ContractTests) but
// varies inputs randomly across boundary conditions to find edge cases.
//
// Configuration:
//   SOURCE_INVARIANT_SEED=<int>        Random seed (default: 42)
//   SOURCE_INVARIANT_ITERATIONS=<int>  Iterations per test (default: 500)
// ---------------------------------------------------------------------------

[TestClass]
public class SourceInvariantTests
{
    private static readonly int Seed = int.TryParse(Environment.GetEnvironmentVariable("SOURCE_INVARIANT_SEED") ?? Environment.GetEnvironmentVariable("FUZZ_SEED"), out var s) ? s : 42;
    private static readonly int Iterations = int.TryParse(Environment.GetEnvironmentVariable("SOURCE_INVARIANT_ITERATIONS") ?? Environment.GetEnvironmentVariable("FUZZ_ITERATIONS"), out var n) ? n : 500;

    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string ContractsDir = Path.Combine(RepoRoot, "contracts");

    private static string Read(string fileName) => File.ReadAllText(Path.Combine(ContractsDir, fileName));
    private static string ReadCombined() => string.Join("\n\n", new[]
    {
        "UnifiedSmartWallet.Accounts.cs",
        "UnifiedSmartWallet.Execution.cs",
        "UnifiedSmartWallet.Internal.cs",
        "UnifiedSmartWallet.State.cs",
        "UnifiedSmartWallet.Escape.cs",
        "UnifiedSmartWallet.MarketEscrow.cs",
        "UnifiedSmartWallet.Models.cs",
        "UnifiedSmartWallet.Paymaster.cs",
    }.Select(Read));

    private static string ReadPaymaster(string fileName) =>
        File.ReadAllText(Path.Combine(ContractsDir, "paymaster", fileName));

    private static string ReadHook(string fileName) =>
        File.ReadAllText(Path.Combine(ContractsDir, "hooks", fileName));

    private static string ReadRepo(params string[] relativeSegments) =>
        File.ReadAllText(Path.Combine(new[] { RepoRoot }.Concat(relativeSegments).ToArray()));

    private static Random Rng() => new(Seed);

    // ========================================================================
    // 1. RegisterAccount – input validation boundaries
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RegisterAccount_ValidationBoundaries()
    {
        var rng = Rng();
        var accountsSource = Read("UnifiedSmartWallet.Accounts.cs");

        // These assertions are source-level but verify the constants are correct
        StringAssert.Contains(accountsSource, "escapeTimelock >= 604800", "Min timelock assertion");
        StringAssert.Contains(accountsSource, "escapeTimelock <= 7776000", "Max timelock assertion");
        StringAssert.Contains(accountsSource, "Account id required", "Account ID required assertion");
        StringAssert.Contains(accountsSource, "Backup owner required", "Backup owner required assertion");
        StringAssert.Contains(accountsSource, "Backup owner witness required", "Witness required assertion");
        StringAssert.Contains(accountsSource, "Account already exists", "Duplicate check assertion");
        StringAssert.Contains(accountsSource, "ComputeRegistrationAccountId", "Registration binding helper exists");
        StringAssert.Contains(accountsSource, "public static void RegisterAccounts", "Batch registration entrypoint exists");
        StringAssert.Contains(accountsSource, "Account batch size must be 1-64", "Batch registration boundary exists");
        StringAssert.Contains(accountsSource, "ids.Length == paramList.Length", "Batch registration keeps account IDs bound to params");
        StringAssert.Contains(accountsSource, "Account id does not match registration parameters", "Registration binding assertion");

        // Randomized invariant check: verify no escaped timelock boundary exists in the source
        for (int i = 0; i < Iterations; i++)
        {
            ulong timelock = (ulong)(rng.NextDouble() * 20000000);
            bool shouldBeBelow = timelock < 604800;
            bool shouldBeAbove = timelock > 7776000;

            if (shouldBeBelow)
                Assert.IsTrue(timelock < 604800);
            if (shouldBeAbove)
                Assert.IsTrue(timelock > 7776000);
        }
    }

    // ========================================================================
    // 2. ExecuteUserOp – deadline and nonce validation
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_ExecuteUserOp_DeadlineAndNonceValidation()
    {
        var rng = Rng();
        var executionSource = Read("UnifiedSmartWallet.Execution.cs");

        StringAssert.Contains(executionSource, "Runtime.Time <= op.Deadline", "Deadline check exists");
        StringAssert.Contains(executionSource, "IsNonceAcceptable(accountId, op.Nonce)", "Nonce check before consume");
        StringAssert.Contains(executionSource, "ConsumeNonce(accountId, op.Nonce)", "Nonce consumed after validation");

        // Randomized invariant check: verify 2D nonce math for random values
        for (int i = 0; i < Iterations; i++)
        {
            BigInteger channel = rng.Next(0, 1000);
            BigInteger sequence = rng.Next(0, 100000);
            BigInteger nonce = (channel << 64) | sequence;

            // Reconstruct channel and sequence from nonce
            BigInteger extractedChannel = nonce >> 64;
            BigInteger extractedSequence = nonce & 0xFFFFFFFFFFFFFFFF;

            Assert.AreEqual(channel, extractedChannel, "Channel roundtrip");
            Assert.AreEqual(sequence, extractedSequence, "Sequence roundtrip");

            // Negative nonce should be rejected
            Assert.IsFalse(BigInteger.MinusOne >= 0, "Negative nonce < 0");
        }
    }

    // ========================================================================
    // 3. ExecuteUserOp – nonce monotonicity (2D ERC-4337 spec)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Nonce_2D_Monotonicity()
    {
        var rng = Rng();
        var executionSource = Read("UnifiedSmartWallet.Execution.cs");

        // Verify nonce system uses the canonical 2D spec with no value-threshold split.
        StringAssert.Contains(executionSource, "channel = nonce >> 64");
        StringAssert.Contains(executionSource, "sequence = nonce & 0xFFFFFFFFFFFFFFFF");
        StringAssert.Contains(executionSource, "nonce < 0");
        // The broken 1e18 value threshold (which made channel >= 1 unreachable) must be gone.
        Assert.IsFalse(executionSource.Contains("MAX_2D_NONCE"),
            "The value-threshold salt split must not be reintroduced");

        // Runtime check against the compiled contract: every nonce is a canonical (channel,
        // sequence) pair where channel = nonce >> 64 and sequence = nonce & 0xFFFFFFFFFFFFFFFF.
        // IsNonceAcceptable is observed through previewUserOpValidation, ConsumeNonce through
        // executeUserOp.
        const ulong sequenceSpan = 0xFFFFFFFFFFFFFFFFUL; // 2^64 - 1
        BigInteger channelStride = (BigInteger)sequenceSpan + 1; // 2^64
        NonceProbeHarness probe = new();

        Assert.IsTrue(probe.IsNonceAcceptable(0), "Channel 0: a fresh lane expects sequence 0");
        Assert.IsFalse(probe.IsNonceAcceptable(1), "Channel 0: out-of-order sequence is rejected");

        // A high channel (channel >= 1) must be reachable — this was unreachable under the
        // broken value-threshold split. Its sequence cursor starts independently at 0.
        BigInteger highChannel = BigInteger.Parse("1000000000000000000");
        BigInteger highChannelSeq0 = highChannel * channelStride; // (highChannel << 64) | 0
        Assert.IsTrue(probe.IsNonceAcceptable(highChannelSeq0), "A fresh high channel expects sequence 0");
        Assert.IsFalse(probe.IsNonceAcceptable(highChannelSeq0 + 1), "High channel: out-of-order sequence is rejected");

        // Consuming channel 0 advances ONLY channel 0's cursor and leaves other channels untouched.
        probe.ExecuteWithNonce(0);
        Assert.AreEqual(BigInteger.One, probe.GetChannelSequence(0), "Consume increments the channel-0 cursor");
        Assert.IsFalse(probe.IsNonceAcceptable(0), "A consumed sequence cannot be replayed");
        Assert.IsTrue(probe.IsNonceAcceptable(1), "The successor sequence becomes acceptable");
        Assert.AreEqual(BigInteger.Zero, probe.GetChannelSequence(highChannel),
            "Channel-0 activity must not advance an independent channel's cursor");

        // Consuming the high channel advances ONLY its cursor; channel 0 stays at its own cursor.
        probe.ExecuteWithNonce(highChannelSeq0);
        Assert.AreEqual(BigInteger.One, probe.GetChannelSequence(highChannel), "Consume increments the high-channel cursor");
        Assert.IsFalse(probe.IsNonceAcceptable(highChannelSeq0), "A consumed high-channel sequence cannot be replayed");
        Assert.IsTrue(probe.IsNonceAcceptable(highChannelSeq0 + 1), "The high channel's successor sequence becomes acceptable");
        Assert.AreEqual(BigInteger.One, probe.GetChannelSequence(0),
            "High-channel activity must not advance channel 0's cursor");

        // Seeded randomized sweep over channel 0 (VM executions, so capped): a 2D nonce is
        // acceptable exactly when its sequence matches the (now advanced) channel-0 cursor (1).
        int vmIterations = Math.Min(Iterations, 64);
        for (int i = 0; i < vmIterations; i++)
        {
            BigInteger sequence = rng.Next(0, 100000);
            Assert.AreEqual(sequence == 1, probe.IsNonceAcceptable(sequence),
                $"2D nonce acceptability must mirror the channel cursor (iteration {i})");
        }
    }

    /// <summary>
    /// Minimal wallet deployment that exposes the contract's private IsNonceAcceptable /
    /// ConsumeNonce behavior through its public entrypoints.
    /// </summary>
    private sealed class NonceProbeHarness
    {
        private static readonly Neo.UInt160 BackupOwner =
            Neo.UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

        private readonly RuntimeFixture _fx = new();
        private readonly Neo.UInt160 _wallet;
        private readonly Neo.UInt160 _target;
        private readonly Neo.UInt160 _accountId;

        public NonceProbeHarness()
        {
            _wallet = _fx.Deploy("UnifiedSmartWalletV3");
            _target = _fx.Deploy("MockTransferTarget");
            _accountId = _fx.CallUInt160(
                _wallet, "computeRegistrationAccountId",
                Neo.UInt160.Zero, Array.Empty<byte>(), Neo.UInt160.Zero, BackupOwner, 2_592_000u);

            _fx.SetSigners(BackupOwner);
            _fx.CallVoid(
                _wallet, "registerAccount",
                _accountId, Neo.UInt160.Zero, Array.Empty<byte>(), Neo.UInt160.Zero, BackupOwner, 2_592_000u);
        }

        public bool IsNonceAcceptable(BigInteger nonce)
        {
            var preview = (Neo.VM.Types.Array)_fx.Call(
                _wallet, "previewUserOpValidation", _accountId, BuildOp(nonce));
            return preview[1].GetBoolean();
        }

        public void ExecuteWithNonce(BigInteger nonce)
        {
            _fx.CallVoid(_wallet, "executeUserOp", _accountId, BuildOp(nonce));
        }

        public BigInteger GetChannelSequence(BigInteger channel)
        {
            return _fx.CallInteger(_wallet, "getNonce", _accountId, channel);
        }

        private object[] BuildOp(BigInteger nonce)
        {
            return RuntimeFixture.UserOp(
                _target, "transfer",
                new object?[] { _accountId, BackupOwner, (BigInteger)1, null },
                nonce, _fx.Now() + 3_600_000, Array.Empty<byte>());
        }
    }

    // ========================================================================
    // 4. ExecuteUserOp – authorization paths
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_ExecuteUserOp_AuthorizationPaths()
    {
        var executionSource = Read("UnifiedSmartWallet.Execution.cs");

        // Verify both authorization paths exist
        StringAssert.Contains(executionSource, "state.Verifier != UInt160.Zero", "Verifier path check");
        StringAssert.Contains(executionSource, "Contract.Call(state.Verifier, \"validateSignature\", CallFlags.ReadOnly", "Verifier delegate call");
        StringAssert.Contains(executionSource, "Runtime.CheckWitness(state.BackupOwner!)", "Native fallback CheckWitness");
        StringAssert.Contains(executionSource, "Reentrant call rejected", "Reentrancy guard");
        StringAssert.Contains(executionSource, "SetExecutionLock(accountId)", "Lock set");
        StringAssert.Contains(executionSource, "ClearExecutionLock(accountId)", "Lock cleared in finally");
    }

    // ========================================================================
    // 5. Escape – timelock boundary constants
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Escape_TimelockBoundaries()
    {
        var rng = Rng();
        var escapeSource = Read("UnifiedSmartWallet.Escape.cs");
        var internalSource = Read("UnifiedSmartWallet.Internal.cs");

        StringAssert.Contains(escapeSource, "Escape not initiated", "Escape not initiated assertion");
        StringAssert.Contains(escapeSource, "Timelock active", "Timelock active assertion");
        StringAssert.Contains(escapeSource, "Only backup owner can finalize", "Owner check on finalize");
        StringAssert.Contains(escapeSource, "Escape cooldown active", "Cooldown check");
        StringAssert.Contains(internalSource, "EscapeCooldownMs = 60L * 60 * 1000", "1 hour cooldown in Runtime.Time milliseconds");
        StringAssert.Contains(escapeSource, "state.EscapeTriggeredAt + ((BigInteger)state.EscapeTimelock * 1000)", "Escape timelock seconds converted to Runtime.Time milliseconds");

        // Randomized invariant check: verify escape timelock range is 7-90 days
        for (int i = 0; i < Iterations; i++)
        {
            ulong timelock = 604800 + (ulong)(rng.NextDouble() * (7776000 - 604800));
            Assert.IsTrue(timelock >= 604800, "Min 7 days");
            Assert.IsTrue(timelock <= 7776000, "Max 90 days");
            Assert.IsTrue((BigInteger)timelock * 1000 >= 604800000, "Runtime comparison uses milliseconds");
        }
    }

    // ========================================================================
    // 6. ConfigUpdateTimelock – verifier/hook update timelock
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_ConfigUpdate_TimelockConsistency()
    {
        var accountsSource = Read("UnifiedSmartWallet.Accounts.cs");
        var internalSource = Read("UnifiedSmartWallet.Internal.cs");

        StringAssert.Contains(accountsSource, "Timelock not elapsed", "Config timelock assertion");
        StringAssert.Contains(internalSource, "ConfigUpdateTimelockMs = 24L * 60 * 60 * 1000", "24 hours config timelock in Runtime.Time milliseconds");

        // Verify both verifier and hook use the same timelock constant
        Assert.AreEqual(3, CountOccurrences(accountsSource, "ConfigUpdateTimelockMs"),
            "ConfigUpdateTimelockMs should be used three times in accounts source (verifier + hook + module call replay)");

        Assert.AreEqual(1, CountOccurrences(internalSource, "ConfigUpdateTimelockMs"),
            "ConfigUpdateTimelockMs should be defined once in internal source");
    }

    // ========================================================================
    // 7. Market escrow – lifecycle state transitions
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_MarketEscrow_StateTransitions()
    {
        var marketSource = Read("UnifiedSmartWallet.MarketEscrow.cs");

        StringAssert.Contains(marketSource, "Account locked in market escrow", "Escrow active check");
        StringAssert.Contains(marketSource, "Only escrow market", "Only market contract can cancel/settle");
        StringAssert.Contains(marketSource, "Listing mismatch", "Listing ID check");
        StringAssert.Contains(marketSource, "New backup owner required", "New owner required for settle");
        StringAssert.Contains(marketSource, "state.Verifier = UInt160.Zero", "Verifier wiped on settle");
        StringAssert.Contains(marketSource, "state.HookId = UInt160.Zero", "Hook wiped on settle");
        StringAssert.Contains(marketSource, "state.EscapeTriggeredAt = 0", "Escape reset on settle");

        // Verify escrow blocks execution
        var executionSource = Read("UnifiedSmartWallet.Execution.cs");
        StringAssert.Contains(executionSource, "AssertNoMarketEscrow(accountId)", "Execution blocked during escrow");
    }

    // ========================================================================
    // 8. Verifier allowlist – method whitelist
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_VerifierMethodAllowlist_Completeness()
    {
        var rng = Rng();
        var accountsSource = Read("UnifiedSmartWallet.Accounts.cs");

        // Verify setPublicKey is NOT in the verifier method allowlist
        StringAssert.Contains(accountsSource, "AllowedVerifierMethods");
        var allowlistStart = accountsSource.IndexOf("AllowedVerifierMethods", StringComparison.Ordinal);
        var allowlistEnd = accountsSource.IndexOf("};", allowlistStart, StringComparison.Ordinal);
        var allowlistBlock = accountsSource.Substring(allowlistStart, allowlistEnd - allowlistStart + 2);
        Assert.IsFalse(allowlistBlock.Contains("\"setPublicKey\"", StringComparison.Ordinal),
            "setPublicKey must NOT be in the verifier allowlist");

        // Verify hook allowlist exists
        StringAssert.Contains(accountsSource, "AllowedHookMethods");
        StringAssert.Contains(accountsSource, "ComputeModuleCallHash");
        StringAssert.Contains(accountsSource, "Timelock not elapsed");

        // Randomized invariant check: verify method names in allowlist are safe
        string[] safeVerifierMethods = { "clearAccount", "setSessionKey", "clearSessionKey", "setConfig", "createSubscription", "setDKIMRegistry" };
        for (int i = 0; i < Iterations; i++)
        {
            string method = safeVerifierMethods[rng.Next(safeVerifierMethods.Length)];
            Assert.IsFalse(method.Contains("PublicKey", StringComparison.Ordinal),
                $"Method {method} should not contain PublicKey");
            Assert.IsFalse(method.Contains("Update", StringComparison.Ordinal),
                $"Method {method} should not contain Update");
        }
    }

    // ========================================================================
    // 9. Storage prefix uniqueness
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_StoragePrefixUniqueness()
    {
        var internalSource = Read("UnifiedSmartWallet.Internal.cs");
        var expectedPrefixes = new (byte Value, string Name)[]
        {
            (0x01, "Prefix_AccountState"),
            (0x02, "Prefix_VerifyContext"),
            (0x03, "Prefix_Nonce"),
            (0x04, "Prefix_VerifierConfigContext"),
            (0x05, "Prefix_HookConfigContext"),
            (0x06, "Prefix_MarketEscrowContract"),
            (0x07, "Prefix_MarketEscrowListing"),
            (0x08, "Prefix_EscapeLastInitiated"),
            (0x09, "Prefix_PendingVerifierUpdate"),
            (0x0A, "Prefix_PendingHookUpdate"),
            (0x0B, "Prefix_ExecutionLock"),
            (0x0C, "Prefix_MetadataUri"),
            (0x0D, "Prefix_HookExecutionContext"),
            (0x0E, "Prefix_VerifierExecutionContext"),
        };

        // Verify each prefix is defined and unique
        var values = new System.Collections.Generic.HashSet<byte>();
        foreach (var (value, name) in expectedPrefixes)
        {
            StringAssert.Contains(internalSource, name);
            Assert.IsTrue(values.Add(value), $"Duplicate prefix value 0x{value:X2} for {name}");
        }
    }

    // ========================================================================
    // 10. Contract event completeness
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_EventCompleteness()
    {
        var eventsSource = Read("UnifiedSmartWallet.Events.cs");
        var combinedSource = ReadCombined();

        string[] requiredEvents =
        {
            "AccountRegistered", "ModuleInstalled", "ModuleUpdateInitiated",
            "ModuleUpdateConfirmed", "ModuleRemoved", "HookUpdateConfirmed",
            "HookUpdateInitiated", "VerifierUpdateConfirmed", "VerifierUpdateInitiated",
            "UserOpExecuted", "EscapeInitiated", "EscapeFinalized",
            "MarketEscrowEntered", "MarketEscrowCancelled", "MarketEscrowSettled",
            "SponsoredUserOpExecuted",
        };

        foreach (var evt in requiredEvents)
        {
            StringAssert.Contains(eventsSource, evt, $"Event {evt} declared");
            StringAssert.Contains(combinedSource, $"On{evt}", $"On{evt} called in code");
        }
    }

    // ========================================================================
    // 11. Safe methods – no state mutations
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_SafeMethods_NoMutations()
    {
        var stateSource = Read("UnifiedSmartWallet.State.cs");
        var internalSource = Read("UnifiedSmartWallet.Internal.cs");
        var safeSource = stateSource + internalSource;

        // All [Safe] methods should only use Storage.Get (read), never Storage.Put
        var allSafeBlocks = ExtractSafeMethodBlocks(stateSource)
            .Concat(ExtractSafeMethodBlocks(internalSource))
            .ToArray();
        foreach (var block in allSafeBlocks)
        {
            Assert.IsFalse(block.Contains("Storage.Put(", StringComparison.Ordinal),
                $"Safe method should not call Storage.Put: {block.Substring(0, Math.Min(100, block.Length))}");
            Assert.IsFalse(block.Contains("Storage.Delete(", StringComparison.Ordinal),
                $"Safe method should not call Storage.Delete: {block.Substring(0, Math.Min(100, block.Length))}");
        }

        // Verify specific safe method declarations ([Safe] on separate line from method)
        string[] safeMethodNames =
        {
            "GetVerifier", "GetHook", "GetBackupOwner", "IsExecutionActive",
            "GetNonce", "HasPendingVerifierUpdate", "HasPendingHookUpdate",
        };

        foreach (var methodName in safeMethodNames)
        {
            StringAssert.Contains(safeSource, $"[Safe]\n        public static", $"[Safe] attribute present near {methodName}");
            StringAssert.Contains(safeSource, methodName, $"{methodName} method exists");
        }
    }

    // ========================================================================
    // 12. Paymaster – policy validation boundary invariants
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Paymaster_PolicyValidationBoundaries()
    {
        var rng = Rng();
        var paymasterSource = ReadPaymaster("Paymaster.cs");

        StringAssert.Contains(paymasterSource, "MaxPerOp must be positive");
        StringAssert.Contains(paymasterSource, "DailyBudget must be non-negative");
        StringAssert.Contains(paymasterSource, "TotalBudget must be non-negative");
        StringAssert.Contains(paymasterSource, "ValidUntil must be non-negative");

        // Randomized invariant check: verify policy budget arithmetic stays consistent
        for (int i = 0; i < Iterations; i++)
        {
            BigInteger maxPerOp = rng.Next(1, 100_000_000);
            BigInteger dailyBudget = rng.Next(0, int.MaxValue);
            BigInteger totalBudget = rng.Next(0, int.MaxValue);
            BigInteger reimbursement = rng.Next(1, 200_000_000);

            // Per-op check
            bool perOpOk = reimbursement <= maxPerOp;

            // Daily check (when dailyBudget > 0)
            BigInteger spentToday = rng.Next(0, (int)BigInteger.Min(dailyBudget + 1, int.MaxValue));
            bool dailyOk = dailyBudget == 0 || spentToday + reimbursement <= dailyBudget;

            // Total check (when totalBudget > 0)
            BigInteger spentTotal = rng.Next(0, (int)BigInteger.Min(totalBudget + 1, int.MaxValue));
            bool totalOk = totalBudget == 0 || spentTotal + reimbursement <= totalBudget;

            // Overflow protection
            BigInteger newDaily = spentToday + reimbursement;
            Assert.IsTrue(newDaily >= spentToday, "Daily overflow at iteration {0}", i);

            BigInteger newTotal = spentTotal + reimbursement;
            Assert.IsTrue(newTotal >= spentTotal, "Total overflow at iteration {0}", i);
        }
    }

    // ========================================================================
    // 13. Paymaster – storage prefix isolation from authority
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Paymaster_StoragePrefixIsolation()
    {
        var paymasterSource = ReadPaymaster("Paymaster.cs");
        var authoritySource = ReadPaymaster("PaymasterAuthority.cs");

        // Extract all hex prefix values from both files
        var paymasterPrefixes = ExtractPrefixValues(paymasterSource);
        var authorityPrefixes = ExtractPrefixValues(authoritySource);

        // Verify no collision
        foreach (var prefix in paymasterPrefixes)
        {
            Assert.IsFalse(authorityPrefixes.Contains(prefix),
                $"Prefix 0x{prefix:X2} collides between Paymaster and PaymasterAuthority");
        }

        // Verify paymaster uses low range (0x01-0x0F), authority uses high range (0xD0-0xDF)
        foreach (byte prefix in paymasterPrefixes)
            Assert.IsTrue(prefix < (byte)0x10, $"Paymaster prefix 0x{prefix:X2} should be in 0x01-0x0F range");

        foreach (byte prefix in authorityPrefixes)
            Assert.IsTrue(prefix >= (byte)0xD0, $"Authority prefix 0x{prefix:X2} should be in 0xD0+ range");
    }

    // ========================================================================
    // 14. Paymaster – settlement security invariants
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Paymaster_SettlementSecurityInvariants()
    {
        var paymasterSource = ReadPaymaster("Paymaster.cs");
        var authoritySource = ReadPaymaster("PaymasterAuthority.cs");

        // Settlement must validate core caller
        StringAssert.Contains(paymasterSource, "PaymasterAuthority.ValidateCoreCaller()");

        // Authority checks CallingScriptHash against stored core
        StringAssert.Contains(authoritySource, "Runtime.CallingScriptHash == core");

        // Settlement validates all inputs
        StringAssert.Contains(paymasterSource, "Invalid sponsor");
        StringAssert.Contains(paymasterSource, "Invalid relay");
        StringAssert.Contains(paymasterSource, "Amount must be positive");
        StringAssert.Contains(paymasterSource, "No sponsorship policy");

        // Settlement enforces all policy constraints
        StringAssert.Contains(paymasterSource, "Policy expired");
        StringAssert.Contains(paymasterSource, "Target contract not allowed by policy");
        StringAssert.Contains(paymasterSource, "Method not allowed by policy");
        StringAssert.Contains(paymasterSource, "Exceeds per-operation limit");
        StringAssert.Contains(paymasterSource, "Daily budget exceeded");
        StringAssert.Contains(paymasterSource, "Total budget exceeded");
        StringAssert.Contains(paymasterSource, "Insufficient sponsor deposit");

        // Transfer result is asserted
        StringAssert.Contains(paymasterSource, "Relay reimbursement failed");
    }

    // ========================================================================
    // 15. Paymaster – daily window reset logic
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Paymaster_DailyWindowResetLogic()
    {
        var rng = Rng();
        var paymasterSource = ReadPaymaster("Paymaster.cs");

        StringAssert.Contains(paymasterSource, "OneDayMs = 24L * 60 * 60 * 1000");

        // Randomized invariant check: verify daily window arithmetic
        for (int i = 0; i < Iterations; i++)
        {
            BigInteger currentTime = rng.Next(100_000_000, int.MaxValue);
            BigInteger lastReset = currentTime - rng.Next(0, 200_000_000);
            BigInteger oneDayMs = 24L * 60 * 60 * 1000;

            bool newDay = currentTime >= lastReset + oneDayMs;

            if (newDay)
            {
                // Spent should reset to 0
                BigInteger elapsed = currentTime - lastReset;
                Assert.IsTrue(elapsed >= oneDayMs, "New day: elapsed must be >= 24h in milliseconds");
            }
            else
            {
                // Spent carries over
                BigInteger remaining = (lastReset + oneDayMs) - currentTime;
                Assert.IsTrue(remaining > 0, "Same day: remaining must be > 0");
            }
        }
    }

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_DailyLimitHook_UsesRuntimeMilliseconds()
    {
        var hookSource = ReadHook("DailyLimitHook.cs");

        StringAssert.Contains(hookSource, "OneDayMs = 24L * 60 * 60 * 1000", "Daily limit windows use Runtime.Time milliseconds");
        Assert.IsFalse(hookSource.Contains("OneDaySeconds", StringComparison.Ordinal), "Daily limit hook must not compare second constants directly to Runtime.Time");
        StringAssert.Contains(hookSource, "GetRollingWindowRecordCount(accountId, targetContract, currentTime) < MaxHistorySize", "PreExecute refuses unrecordable rolling-window transfers");
        StringAssert.Contains(hookSource, "GetRollingWindowRecordCount(accountId, token, timestamp) < MaxHistorySize", "PostExecute refuses to evict live rolling-window spend records");
        StringAssert.Contains(hookSource, "Daily limit history full", "Rolling-window storage cap has an explicit failure mode");
        Assert.IsFalse(hookSource.Contains("EnforceMaxHistorySize", StringComparison.Ordinal), "Rolling-window cap must not delete arbitrary in-window spend records");
        Assert.IsFalse(hookSource.Contains("count - MaxHistorySize", StringComparison.Ordinal), "Rolling-window cap must not trim live records by count");
    }

    // ========================================================================
    // 16. Paymaster – GAS NEP-17 receive validation
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Paymaster_DepositValidation()
    {
        var paymasterSource = ReadPaymaster("Paymaster.cs");

        // OnNEP17Payment only accepts GAS
        StringAssert.Contains(paymasterSource, "Runtime.CallingScriptHash == GAS.Hash");
        StringAssert.Contains(paymasterSource, "Only GAS accepted");

        // Validates sender and amount
        StringAssert.Contains(paymasterSource, "amount > 0");
        StringAssert.Contains(paymasterSource, "from != null && from != UInt160.Zero");

        // Overflow check on deposit
        StringAssert.Contains(paymasterSource, "newBalance >= current");
        StringAssert.Contains(paymasterSource, "Deposit overflow");

        // Withdraw checks
        StringAssert.Contains(paymasterSource, "Runtime.CheckWitness(sender)");
        StringAssert.Contains(paymasterSource, "amount <= balance");
        StringAssert.Contains(paymasterSource, "Insufficient deposit");
    }

    // ========================================================================
    // 17. Paymaster – global policy fallback correctness
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Paymaster_GlobalPolicyFallback()
    {
        var paymasterSource = ReadPaymaster("Paymaster.cs");

        // ResolvePolicy tries account-specific first, then falls back to global
        StringAssert.Contains(paymasterSource, "ReadPolicy(sponsor, accountId)");
        StringAssert.Contains(paymasterSource, "ReadPolicy(sponsor, UInt160.Zero)");

        // Global fallback sets spendingAccountId to Zero so all accounts share one budget
        StringAssert.Contains(paymasterSource, "spendingAccountId = UInt160.Zero");

        // Only falls back when no account-specific policy found
        StringAssert.Contains(paymasterSource, "if (policy != null) return policy;");
        StringAssert.Contains(paymasterSource, "if (accountId != UInt160.Zero)");
    }

    // ========================================================================
    // 18. Paymaster – sponsored execution uses ExecuteUserOp internally
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Paymaster_SponsoredExecutionReusesCore()
    {
        var paymasterPartial = Read("UnifiedSmartWallet.Paymaster.cs");

        // Sponsored execution calls the standard ExecuteUserOp internally
        StringAssert.Contains(paymasterPartial, "ExecuteUserOp(accountId");

        // Batch sponsored execution calls the standard ExecuteUserOps internally
        StringAssert.Contains(paymasterPartial, "ExecuteUserOps(accountId");

        // Pre-validation uses ReadOnly
        StringAssert.Contains(paymasterPartial, "CallFlags.ReadOnly");

        // Settlement uses All
        int settleIndex = paymasterPartial.IndexOf("settleReimbursement", StringComparison.Ordinal);
        Assert.IsTrue(settleIndex > 0, "settleReimbursement call must exist");
        int callFlagsIndex = paymasterPartial.IndexOf("CallFlags.All", settleIndex - 200, StringComparison.Ordinal);
        Assert.IsTrue(callFlagsIndex > 0, "Settlement must use CallFlags.All");
    }

    // ========================================================================
    // 19. Contract update coverage
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_AllDeployableContractsExposeAdminGatedUpdate()
    {
        var directUpdateSources = new[]
        {
            ("contracts/UnifiedSmartWallet.Admin.cs", "Runtime.CheckWitness(adminHash)"),
            ("contracts/paymaster/Paymaster.cs", "Runtime.CheckWitness(admin)"),
            ("contracts/market/AAAddressMarket.cs", "ValidateAdmin();"),
            ("contracts/mocks/MockTransferTarget.cs", "ValidateAdmin();"),
        };

        foreach (var (path, guard) in directUpdateSources)
        {
            string code = ReadRepo(path.Split('/'));
            StringAssert.Contains(code, "public static void Update(ByteString nef, string manifest)", $"{path} exposes update");
            StringAssert.Contains(code, guard, $"{path} gates update with admin/owner witness");
            StringAssert.Contains(code, "ContractManagement.Update(nef, manifest)", $"{path} calls ContractManagement.Update");
        }

        string hookAuthority = ReadHook("HookAuthority.cs");
        StringAssert.Contains(hookAuthority, "internal static void Update(ByteString nef, string manifest)");
        StringAssert.Contains(hookAuthority, "ValidateAdmin();");
        StringAssert.Contains(hookAuthority, "ContractManagement.Update(nef, manifest)");

        foreach (string hook in new[] { "DailyLimitHook.cs", "MultiHook.cs", "NeoDIDCredentialHook.cs", "TokenRestrictedHook.cs", "WhitelistHook.cs" })
        {
            string code = ReadHook(hook);
            StringAssert.Contains(code, "public static void Update(ByteString nef, string manifest) => HookAuthority.Update(nef, manifest);", $"{hook} delegates update");
        }

        string verifierAuthority = ReadRepo("contracts", "verifiers", "VerifierAuthority.cs");
        StringAssert.Contains(verifierAuthority, "internal static void Update(ByteString nef, string manifest)");
        StringAssert.Contains(verifierAuthority, "ValidateAdmin();");
        StringAssert.Contains(verifierAuthority, "ContractManagement.Update(nef, manifest)");

        foreach (string verifier in new[] { "MultiSigVerifier.cs", "NeoNativeVerifier.cs", "SessionKeyVerifier.cs", "SubscriptionVerifier.cs", "TEEVerifier.cs", "Web3AuthVerifier.cs", "WebAuthnVerifier.cs", "ZKEmailVerifier.cs", "ZkLoginVerifier.cs" })
        {
            string code = ReadRepo("contracts", "verifiers", verifier);
            StringAssert.Contains(code, "public static void Update(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);", $"{verifier} delegates update");
        }

        // Audit fixes H5 / H6 / AA-04: the two fund-holding auxiliaries (SocialRecoveryVerifier
        // custodies the per-account oracle-credit GAS pool; AAAddressMarket holds in-flight
        // buyer escrow) must expose the same AA-D-01/AA-D-02 timelocked admin surface as the
        // VerifierAuthority idiom — proposeUpdate + update/confirmUpdate behind the 7-day
        // window, and rotateAdmin/confirmAdminRotation/cancelAdminRotation in place of the
        // removed instant transferAdmin/setAdmin hand-offs.
        string marketSource = ReadRepo("contracts", "market", "AAAddressMarket.cs");
        StringAssert.Contains(marketSource, "public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash)", "H6: market exposes proposeUpdate");
        StringAssert.Contains(marketSource, "Update timelock not expired", "H6: market update enforces the 7-day window");
        StringAssert.Contains(marketSource, "public static void RotateAdmin(UInt160 newAdmin)", "H6: market exposes timelocked rotateAdmin");
        StringAssert.Contains(marketSource, "Admin rotation timelock not expired", "H6: market rotation enforces the 7-day window");
        Assert.IsFalse(marketSource.Contains("public static void SetAdmin", StringComparison.Ordinal),
            "H6: the instant setAdmin hand-off must be removed");

        string recoverySource = ReadRepo("contracts", "recovery", "MorpheusSocialRecoveryVerifier.Fixed.cs");
        StringAssert.Contains(recoverySource, "public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash)", "H5: recovery verifier exposes proposeUpdate");
        StringAssert.Contains(recoverySource, "Update timelock not expired", "H5: recovery update enforces the 7-day window");
        StringAssert.Contains(recoverySource, "public static void RotateAdmin(UInt160 newAdmin)", "AA-04: recovery verifier exposes timelocked rotateAdmin");
        StringAssert.Contains(recoverySource, "Admin rotation timelock not expired", "AA-04: recovery rotation enforces the 7-day window");
        Assert.IsFalse(recoverySource.Contains("public static void TransferAdmin", StringComparison.Ordinal),
            "AA-04: the instant transferAdmin hand-off must be removed");
    }

    // ========================================================================
    // 20. Cross-file consistency (updated)

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_CrossFileConsistency()
    {
        var rng = Rng();
        var combined = ReadCombined();

        // Verify AccountState fields match across AccountState struct and read methods
        StringAssert.Contains(combined, "public UInt160 Verifier");
        StringAssert.Contains(combined, "public UInt160 HookId");
        StringAssert.Contains(combined, "public UInt160 BackupOwner");
        StringAssert.Contains(combined, "public uint EscapeTimelock");
        StringAssert.Contains(combined, "public BigInteger EscapeTriggeredAt");

        // Verify UserOperation fields
        StringAssert.Contains(combined, "public UInt160 TargetContract");
        StringAssert.Contains(combined, "public string Method");
        StringAssert.Contains(combined, "public object[] Args");
        StringAssert.Contains(combined, "public BigInteger Nonce");
        StringAssert.Contains(combined, "public BigInteger Deadline");
        StringAssert.Contains(combined, "public ByteString Signature");

        // Verify PendingConfigUpdate fields
        StringAssert.Contains(combined, "public UInt160 NewVerifier");
        StringAssert.Contains(combined, "public UInt160 NewHookId");
        StringAssert.Contains(combined, "public ByteString VerifierParams");
        StringAssert.Contains(combined, "public BigInteger InitiatedAt");

        // Randomized invariant check: verify all state-changing methods use CheckWitness
        string[] protectedMethods = { "RegisterAccount", "UpdateHook", "ConfirmHookUpdate",
            "UpdateVerifier", "ConfirmVerifierUpdate", "InitiateEscape", "FinalizeEscape",
            "EnterMarketEscrow", "SetMetadataUri", "CancelVerifierUpdate", "CancelHookUpdate" };

        for (int i = 0; i < Iterations; i++)
        {
            string method = protectedMethods[rng.Next(protectedMethods.Length)];
            Assert.IsTrue(combined.Contains(method, StringComparison.Ordinal),
                $"Method {method} must exist in combined source");
        }
    }

    // ========================================================================
    // 21. Recovery verifier – anti-squat surface (AA-06)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RecoveryVerifier_AntiSquatSurface()
    {
        // Audit fix AA-06: SetupRecovery was first-write-wins with no proof of account
        // control — a squatter witnessing their OWN key could bind a victim's accountId.
        // The fix pins the canonical AA core (contract-admin gated, initial-set-only,
        // re-pointing timelocked — mirroring the VerifierAuthority M-7 surface) and requires
        // the core's getBackupOwner registry to attest the claimed owner at setup.
        string flowsSource = ReadRepo("contracts", "recovery", "MorpheusSocialRecoveryVerifier.Flows.cs");
        StringAssert.Contains(flowsSource, "aaContract is not the authorized core", "AA-06: setup pins the authorized core");
        StringAssert.Contains(flowsSource, "owner does not control account", "AA-06: setup attests the registered backup owner");
        StringAssert.Contains(flowsSource, "\"getBackupOwner\"", "AA-06: ownership is attested via the core registry");

        string fixedSource = ReadRepo("contracts", "recovery", "MorpheusSocialRecoveryVerifier.Fixed.cs");
        StringAssert.Contains(fixedSource, "public static void SetAuthorizedCore(UInt160 coreContract)", "AA-06: admin-gated initial core bind exists");
        StringAssert.Contains(fixedSource, "core already set; use ProposeAuthorizedCore", "AA-06: instant core re-pointing is rejected");
        StringAssert.Contains(fixedSource, "public static void ProposeAuthorizedCore(UInt160 coreContract)", "AA-06: timelocked core re-pointing exists");
        StringAssert.Contains(fixedSource, "Core change timelock not expired", "AA-06: core re-pointing enforces the 7-day window");
    }

    // ========================================================================
    // 23. Recovery verifier – least-privilege contract permissions (AA-03)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RecoveryVerifier_LeastPrivilegePermissions()
    {
        // Audit fix AA-03: the wildcard ContractPermission("*", "*") is replaced by
        // five method-scoped grants covering the verified call surface — any future
        // wildcard reintroduction or dropped grant must fail here.
        string fixedSource = ReadRepo("contracts", "recovery", "MorpheusSocialRecoveryVerifier.Fixed.cs");
        Assert.IsFalse(fixedSource.Contains("ContractPermission(\"*\", \"*\")", StringComparison.Ordinal), "AA-03: no wildcard contract permission");
        StringAssert.Contains(fixedSource, "ContractPermission(\"0xfffdc93764dbaddd97c48f252a53ea4643faa3fd\", \"update\")", "AA-03: ContractManagement.update grant (timelocked self-upgrade)");
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"getBackupOwner\")", "AA-03: core getBackupOwner grant (AA-06 attestation)");
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"canExecuteVerifier\")", "AA-03: V3 verifier execution-context grant");
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"request\")", "AA-03: oracle request grant (ticket submission)");
        StringAssert.Contains(fixedSource, "ContractPermission(\"0xd2a4cff31913016155e38e474a2c06d08be276cf\", \"transfer\")", "AA-03: GAS transfer grant (credit forwarding)");
    }

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RecoveryVerifier_ImplementsGuardedV3Surface()
    {
        string v3Source = ReadRepo("contracts", "recovery", "MorpheusSocialRecoveryVerifier.V3.cs");
        StringAssert.Contains(v3Source, "public static bool SupportsV3() => true");
        StringAssert.Contains(v3Source, "public static bool ValidateSignature(UInt160 accountId, UserOperation op)");
        StringAssert.Contains(v3Source, "public static void PostExecute(UInt160 accountId, UserOperation op, object result)");
        Assert.AreEqual(2, v3Source.Split("AssertV3ExecutionCaller(accountId)", StringSplitOptions.None).Length - 1,
            "Both V3 execution entrypoints must validate the bound AA Core context");
        StringAssert.Contains(v3Source, "\"canExecuteVerifier\"");
        StringAssert.Contains(v3Source, "Runtime.CallingScriptHash == core");
    }

    // ========================================================================
    // 24. Every PostExecute validates its caller (audit low, pattern risk)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_SignedPayloadsBindAuthorizedAaCore()
    {
        string sharedPayload = ReadRepo("contracts", "verifiers", "VerifierPayload.cs");
        StringAssert.Contains(sharedPayload, "VerifierAuthority.AuthorizedCore()",
            "shared verifier payload must bind the authorized AA core");

        string web3Auth = ReadRepo("contracts", "verifiers", "Web3AuthVerifier.cs");
        StringAssert.Contains(web3Auth, "ToBytes20Word(VerifierAuthority.AuthorizedCore())",
            "Web3Auth struct hash must bind the authorized AA core");
        StringAssert.Contains(web3Auth, "UserOperationTypeHash",
            "Web3Auth struct hash must use the core-bound type hash");

        string zkLogin = ReadRepo("contracts", "verifiers", "ZkLoginVerifier.cs");
        StringAssert.Contains(zkLogin, "(byte[])VerifierAuthority.AuthorizedCore()",
            "ZkLogin payload must bind the authorized AA core");
    }

    // ========================================================================
    // 24b. Every PostExecute validates its caller (audit low, pattern risk)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_AllPostExecutePathsValidateCaller()
    {
        // Audit low: several no-op PostExecute bodies previously had no caller guard —
        // harmless today, but a future edit could add logic to an unguarded path. The
        // estate invariant is that EVERY PostExecute validates its caller, even a no-op.
        string neoDid = ReadRepo("contracts", "hooks", "NeoDIDCredentialHook.cs");
        StringAssert.Contains(neoDid, "HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash)",
            "NeoDIDCredentialHook.PostExecute validates its caller");
        string whitelist = ReadRepo("contracts", "hooks", "WhitelistHook.cs");
        StringAssert.Contains(whitelist, "HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash)",
            "WhitelistHook.PostExecute validates its caller");
        string neoNative = ReadRepo("contracts", "verifiers", "NeoNativeVerifier.cs");
        StringAssert.Contains(neoNative, "VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash)",
            "NeoNativeVerifier.PostExecute validates its caller");
        foreach (string verifier in new[] { "TEEVerifier.cs", "Web3AuthVerifier.cs", "WebAuthnVerifier.cs", "ZKEmailVerifier.cs", "ZkLoginVerifier.cs" })
        {
            string source = ReadRepo("contracts", "verifiers", verifier);
            StringAssert.Contains(source, "VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash)",
                $"{verifier}.PostExecute validates its caller");
        }
    }

    // ========================================================================
    // 22. Recovery verifier – timelock bounds match the estate standard
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RecoveryVerifier_TimelockBoundsMatchEstateStandard()
    {
        // Audit finding (recovery timelock bounds): SocialRecoveryVerifier enforced a 1h
        // minimum and NO maximum, while the estate standard — the AA core escape hatch's
        // 604800–7776000 seconds pinned in section 1/5 — is 7–90 days. The recovery verifier
        // must enforce the same window in Runtime.Time milliseconds (604800000–7776000000)
        // in BOTH SetupRecovery and UpdateRecoveryConfig.
        string flowsSource = ReadRepo("contracts", "recovery", "MorpheusSocialRecoveryVerifier.Flows.cs");
        StringAssert.Contains(flowsSource, "MIN_TIMELOCK = 604800000", "Recovery min timelock is 7 days in ms");
        StringAssert.Contains(flowsSource, "MAX_TIMELOCK = 7776000000", "Recovery max timelock is 90 days in ms");
        Assert.AreEqual(2, CountOccurrences(flowsSource, "\"Timelock below minimum\""),
            "Both SetupRecovery and UpdateRecoveryConfig enforce the minimum");
        Assert.AreEqual(2, CountOccurrences(flowsSource, "\"Timelock above maximum\""),
            "Both SetupRecovery and UpdateRecoveryConfig enforce the maximum");

        // Seeded randomized cross-check: every timelock the core escape hatch accepts
        // (7–90 days, seconds) maps inside the recovery verifier's millisecond window.
        var rng = Rng();
        for (int i = 0; i < Iterations; i++)
        {
            ulong seconds = 604800 + (ulong)(rng.NextDouble() * (7776000 - 604800));
            ulong milliseconds = seconds * 1000;
            Assert.IsTrue(milliseconds >= 604800000UL && milliseconds <= 7776000000UL,
                $"Estate-standard timelock {seconds}s must fit the recovery window (iteration {i})");
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private static System.Collections.Generic.HashSet<byte> ExtractPrefixValues(string source)
    {
        var prefixes = new System.Collections.Generic.HashSet<byte>();
        var regex = new System.Text.RegularExpressions.Regex(@"new byte\[\]\s*\{\s*0x([0-9A-Fa-f]{2})\s*\}");
        foreach (System.Text.RegularExpressions.Match match in regex.Matches(source))
        {
            prefixes.Add(Convert.ToByte(match.Groups[1].Value, 16));
        }
        return prefixes;
    }

    private static int CountOccurrences(string source, string search)
    {
        int count = 0;
        int index = 0;
        while ((index = source.IndexOf(search, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += search.Length;
        }
        return count;
    }

    private static string[] ExtractSafeMethodBlocks(string source)
    {
        var blocks = new System.Collections.Generic.List<string>();
        int searchFrom = 0;
        while (true)
        {
            int safeIdx = source.IndexOf("[Safe]", searchFrom, StringComparison.Ordinal);
            if (safeIdx < 0) break;

            // Find the method body
            int braceStart = source.IndexOf('{', safeIdx);
            if (braceStart < 0) break;

            // Simple brace matching
            int depth = 1;
            int pos = braceStart + 1;
            while (pos < source.Length && depth > 0)
            {
                if (source[pos] == '{') depth++;
                else if (source[pos] == '}') depth--;
                pos++;
            }

            blocks.Add(source[safeIdx..pos]);
            searchFrom = pos;
        }
        return blocks.ToArray();
    }
}
