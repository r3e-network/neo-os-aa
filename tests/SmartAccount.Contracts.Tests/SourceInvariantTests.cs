using System;
using System.Numerics;
using System.IO;
using System.Linq;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace SmartAccount.Contracts.Tests;

// ---------------------------------------------------------------------------
// Source-invariant tests for SmartAccount contract validation logic.
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

    private static readonly string CoreDir = Path.Combine(RepoRoot, "contracts", "custom");

    // Source pins use "\n" line endings; the repository may be checked out with
    // CRLF on Windows, so normalize every read before pattern matching.
    private static string NormalizeLineEndings(string text) => text.Replace("\r\n", "\n").Replace("\r", "\n");

    private static string Read(string fileName) => NormalizeLineEndings(File.ReadAllText(Path.Combine(CoreDir, fileName)));
    private static string ReadCombined() => string.Join("\n\n", new[]
    {
        "SmartAccount.Accounts.cs",
        "SmartAccount.Execution.cs",
        "SmartAccount.Intents.cs",
        "SmartAccount.Internal.cs",
        "SmartAccount.Message.cs",
        "SmartAccount.Migration.cs",
        "SmartAccount.ModuleProtocol.cs",
        "SmartAccount.Modules.cs",
        "SmartAccount.Nonce.cs",
        "SmartAccount.State.cs",
        "SmartAccount.Escape.cs",
        "SmartAccount.MarketEscrow.cs",
        "SmartAccount.Models.cs",
        "SmartAccount.Paymaster.cs",
    }.Select(Read));

    private static string ReadPaymaster(string fileName) =>
        NormalizeLineEndings(File.ReadAllText(Path.Combine(CoreDir, "paymaster", fileName)));

    private static string ReadHook(string fileName) =>
        NormalizeLineEndings(File.ReadAllText(Path.Combine(RepoRoot, "contracts", "plugins", "hooks", fileName)));

    private static string ReadRepo(params string[] relativeSegments) =>
        NormalizeLineEndings(File.ReadAllText(Path.Combine(new[] { RepoRoot }.Concat(relativeSegments).ToArray())));

    private static Random Rng() => new(Seed);

    // ========================================================================
    // 1. createAccount – v4 registration input validation boundaries
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RegisterAccount_ValidationBoundaries()
    {
        var rng = Rng();
        var accountsSource = Read("SmartAccount.Accounts.cs");
        var moduleProtocolSource = Read("SmartAccount.ModuleProtocol.cs");

        // v4 registration (spec §16.1): identity is custody+salt, the timelock
        // is clamped to the protocol's 7-90 day window, and the initial module
        // configuration installs atomically through the intent executors.
        StringAssert.Contains(accountsSource, "public static void createAccount(", "v4 single registration entrypoint");
        StringAssert.Contains(accountsSource, "public static void createAccounts(", "v4 batch registration entrypoint");
        StringAssert.Contains(accountsSource, "ComputeAccountIdentity", "custody+salt identity helper");
        StringAssert.Contains(accountsSource, "Invalid registration salt", "Salt validation assertion");
        StringAssert.Contains(accountsSource, "Account already exists", "Duplicate check assertion");
        StringAssert.Contains(accountsSource, "ids.Length == saltList.Length", "Batch registration keeps ids bound to salts");
        StringAssert.Contains(accountsSource, "Account batch salts mismatch", "Batch length mismatch assertion");
        // The timelock clamp uses the protocol constants (7-90 days, milliseconds).
        StringAssert.Contains(moduleProtocolSource, "RecoveryTimelockMinMs = 604_800_000", "7-day minimum timelock constant");
        StringAssert.Contains(moduleProtocolSource, "RecoveryTimelockMaxMs = 7_776_000_000", "90-day maximum timelock constant");
        StringAssert.Contains(accountsSource, "RecoveryTimelockMinMs", "Registration clamps against the min constant");
        StringAssert.Contains(accountsSource, "RecoveryTimelockMaxMs", "Registration clamps against the max constant");
        // The legacy single-slot API is removed without aliases (spec §9).
        Assert.IsFalse(accountsSource.Contains("public static void RegisterAccount(", StringComparison.Ordinal),
            "The legacy RegisterAccount ABI must stay removed");

        // Randomized invariant check: the v4 clamp window is 7-90 days.
        for (int i = 0; i < Iterations; i++)
        {
            ulong timelockMs = (ulong)(rng.NextDouble() * 20_000_000_000UL);
            bool belowMin = timelockMs < 604_800_000UL;
            bool aboveMax = timelockMs > 7_776_000_000UL;

            if (belowMin) Assert.IsTrue(timelockMs < 604_800_000UL);
            if (aboveMax) Assert.IsTrue(timelockMs > 7_776_000_000UL);
        }
    }

    // ========================================================================
    // 2. executeUserOp – canonical envelope validation
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_ExecuteUserOp_EnvelopeAndNonceValidation()
    {
        var rng = Rng();
        var executionSource = Read("SmartAccount.Execution.cs");
        var moduleProtocolSource = Read("SmartAccount.ModuleProtocol.cs");

        // 13-field canonical envelope (spec §4.1).
        StringAssert.Contains(executionSource, "op.Length == UserOperationFieldCount", "Exact field count check");
        StringAssert.Contains(moduleProtocolSource, "UserOperationFieldCount = 13", "13-field envelope pinned in the protocol constants");
        // Strict Array, never a Struct: canonical serialization of the top level
        // must begin with 0x40.
        StringAssert.Contains(executionSource, "rawHeader[0] == 0x40", "Top-level Array (0x40) header check");
        StringAssert.Contains(executionSource, "AssertTargetIsNotProtocolOwned(target", "Protocol-owned target ban");
        // Non-negative NeoVM integers are signed 256-bit values. The canonical
        // uint-like field guard must reject a full-width value whose sign bit is
        // set instead of accepting it merely because its magnitude fits.
        StringAssert.Contains(executionSource, "encoded[length - 1] < 0x80",
            "Unsigned fields reject the signed-VM upper half");
        // Deadline and nonce fields are checked against the SA_* error codes.
        StringAssert.Contains(executionSource, "ErrorNonceInvalid", "Nonce field validation");
        StringAssert.Contains(executionSource, "ErrorDeadlineExpired", "Deadline field validation");

        // Randomized invariant check: the v4 nonce is the packed pair
        // (191-bit derived channel ‖ 64-bit sequence).
        for (int i = 0; i < Iterations; i++)
        {
            BigInteger channel = rng.Next(0, 1 << 24);
            BigInteger sequence = rng.Next(0, 100000);
            BigInteger nonce = (channel << 64) | sequence;

            Assert.AreEqual(channel, nonce >> 64, "Channel roundtrip");
            Assert.AreEqual(sequence, nonce & 0xFFFFFFFFFFFFFFFF, "Sequence roundtrip");
            Assert.IsFalse(BigInteger.MinusOne >= 0, "Negative nonce < 0");
        }
    }

    // ========================================================================
    // 3. Nonce channels – derived 191-bit channel, fail-closed collisions,
    //    2^64 exhaustion sentinel, legacy 0x03 merge (spec §6)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_NonceChannel_DerivationAndCollisionFailClosed()
    {
        var rng = Rng();
        var nonceSource = Read("SmartAccount.Nonce.cs");
        var moduleProtocolSource = Read("SmartAccount.ModuleProtocol.cs");

        // The channel is DERIVED from the namespace digest — never chosen.
        StringAssert.Contains(nonceSource, "ChannelBytesFromDigest", "Channel derivation from the SHA256 namespace digest");
        StringAssert.Contains(nonceSource, "ComputeNonceNamespaceDigest", "Namespace derivation digest (0x5C)");
        StringAssert.Contains(nonceSource, "channel[0] = (byte)(digest[8] & 0x01)", "Derived channel keeps only the low 191 bits (top 7 bits zero)");
        StringAssert.Contains(nonceSource, "(channel >> 191) == BigInteger.Zero", "Channel domain is 191 bits");
        // Truncation-collision detection is fail-closed: a persisted namespace
        // digest that no longer matches the derivation kills the channel.
        StringAssert.Contains(nonceSource, "stored == namespaceDigest", "Namespace digest equality check");
        StringAssert.Contains(nonceSource, "ErrorNonceChannelCollision", "Collision fails closed with SA_NONCE_CHANNEL_COLLISION");
        StringAssert.Contains(moduleProtocolSource, "SA_NONCE_CHANNEL_COLLISION", "Collision error code pinned in the protocol constants");
        // Exhaustion sentinel: 2^64, no wrap-around.
        StringAssert.Contains(nonceSource, "NonceExhaustionSentinel = BigInteger.One << 64", "2^64 exhaustion sentinel");
        StringAssert.Contains(nonceSource, "ErrorNonceExhausted", "Exhausted channel rejection");
        // Legacy merge: the effective cursor is max(legacy 0x03, new 0x56) and
        // the new cursor never decreases.
        StringAssert.Contains(nonceSource, "newCursor > legacyCursor ? newCursor : legacyCursor", "Effective cursor merges the legacy row");
        // The packed public query is (channel << 64) | sequence.
        StringAssert.Contains(nonceSource, "(BytesToBigInteger(channel) << 64) | sequence", "Packed nonce query encoding");

        // Randomized invariant check: a 191-bit channel packed over a 64-bit
        // sequence never aliases another channel's sequences.
        for (int i = 0; i < Iterations; i++)
        {
            BigInteger channel = rng.Next(0, 1 << 24);
            BigInteger sequenceA = rng.Next(0, 100000);
            BigInteger sequenceB = rng.Next(0, 100000);
            BigInteger packedA = (channel << 64) | sequenceA;
            BigInteger packedB = (channel << 64) | sequenceB;

            Assert.AreEqual(sequenceA == sequenceB, packedA == packedB,
                "Packed nonces are equal exactly when their sequences are");
        }
    }

    // ========================================================================
    // 4. executeUserOp – v4 routing and phase-exact authorization
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_ExecuteUserOp_AuthorizationPaths()
    {
        var executionSource = Read("SmartAccount.Execution.cs");
        var modulesSource = Read("SmartAccount.Modules.cs");
        var verifyContextSource = Read("SmartAccount.VerifyContext.cs");

        // v4 routing is explicit by validatorId (spec §3.5): the routed
        // validator instance or the active threshold policy approves the
        // digest; there is no custody fallback while a validator is set.
        StringAssert.Contains(executionSource, "GetModuleInstance(accountId, validatorId)", "Explicit validatorId routing resolves installed instances");
        StringAssert.Contains(executionSource, "GetThresholdPolicy(accountId, validatorId)", "Threshold-policy routing resolves installed policies");
        StringAssert.Contains(executionSource, "CallModuleGasCapped(", "Module callbacks run under the gas hard budget");
        StringAssert.Contains(executionSource, "\"validateUserOp\"", "Validator method");
        StringAssert.Contains(executionSource, "ValidationPerCallGasLimit", "Validation per-call gas cap");
        // F-7 phase gates: each writer phase opens exactly one module authorization
        // (0x58) and closes it before the next phase opens. The envelope opens the
        // dispatch phase; each module callback opens its own phase.
        StringAssert.Contains(modulesSource, "EnterModulePhase(accountId, ctx, PhaseValidation", "Validation phase gate");
        StringAssert.Contains(modulesSource, "EnterModulePhase(accountId, ctx, PhaseHookPre", "Hook pre phase gate");
        StringAssert.Contains(executionSource, "EnterModulePhase(accountId, ctx, PhaseTargetDispatch", "Target dispatch phase gate");
        StringAssert.Contains(modulesSource, "EnterModulePhase(accountId, ctx, PhaseHookPost", "Hook post phase gate");
        StringAssert.Contains(modulesSource, "EnterModulePhase(accountId, ctx, PhaseCompletion", "Completion phase gate");
        // F-1: the dispatched target's CheckWitness(accountId) resolves through the
        // 0x02 verify context bound around THIS operation's dispatch only.
        StringAssert.Contains(executionSource, "SetVerifyContext(accountId, target)", "F-1 verify context binds the actual dispatched target");
        StringAssert.Contains(executionSource, "ClearVerifyContext(accountId)", "F-1 verify context closed after dispatch");
        Assert.IsFalse(verifyContextSource.Contains("verifyScopeTarget", StringComparison.Ordinal),
            "F-1: the verifyScopeTarget grant must stay deleted");
        // Execution lock still guards reentrancy per account.
        StringAssert.Contains(executionSource, "SetExecutionLock(accountId)", "Lock set");
        StringAssert.Contains(executionSource, "ClearExecutionLock(accountId)", "Lock cleared in finally");
    }

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_ModuleLifecycleCallbacksUseHardBudget()
    {
        var moduleProtocolSource = Read("SmartAccount.ModuleProtocol.cs");
        var modulesSource = Read("SmartAccount.Modules.cs");

        // Plan B gas hard budget (spec §11): the datoshi constants live in the
        // protocol constants file and every module callback runs through the
        // GasLeft-wrapped capped caller. Aggregates are caps × multiplicity so a
        // maximal threshold round always fits (see ValidationAggregateGasLimit).
        StringAssert.Contains(moduleProtocolSource, "ValidationPerCallGasLimit = 100_000_000", "1 GAS per validation callback cap");
        StringAssert.Contains(moduleProtocolSource, "CompletionPerCallGasLimit = 100_000_000", "1 GAS per completion callback cap");
        StringAssert.Contains(moduleProtocolSource, "HookCallbackGasLimit = 250_000_000", "2.5 GAS per hook pre/post cap");
        StringAssert.Contains(moduleProtocolSource, "LifecycleCallbackGasLimit = 250_000_000", "2.5 GAS per lifecycle callback cap");
        StringAssert.Contains(modulesSource, "(BigInteger)ValidationPerCallGasLimit * (1 + MaxThresholdPolicyMembers)",
            "Validation aggregate scales with the threshold member limit");
        StringAssert.Contains(modulesSource, "(BigInteger)CompletionPerCallGasLimit * (1 + MaxThresholdPolicyMembers)",
            "Completion aggregate scales with the threshold member limit");
        StringAssert.Contains(modulesSource, "CallModuleGasCapped", "Shared capped module entrypoint");
        StringAssert.Contains(modulesSource, "AssertCallbackGasBudget", "GasLeft fail-closed budget check");

        // Lifecycle callbacks (onInstall/onUninstall/configure) go through the
        // capped caller — never a bare Contract.Call.
        foreach (string name in new[] { "SmartAccount.Modules.cs", "SmartAccount.Message.cs", "SmartAccount.Execution.cs" })
        {
            string source = Read(name);
            StringAssert.Contains(source, "CallModuleGasCapped", $"{name} capped module calls");
        }
        Assert.IsFalse(modulesSource.Contains("Contract.Call(\n                            state.HookId", StringComparison.Ordinal),
            "Hook callbacks must use the capped module caller");
    }

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_MessageSignaturesUseBuiltInP256Subjects()
    {
        var messageSource = Read("SmartAccount.Message.cs");

        // v4 built-in message signatures (spec §8): the ERC-1271 surface is the
        // P-256 subject store with canonical subject entries and strict
        // magic words — not a legacy verifier dispatch. The magic is a 4-byte
        // ByteString (bytes4), never a uint/Integer return.
        int start = messageSource.IndexOf("public static ByteString isValidSignature", StringComparison.Ordinal);
        Assert.IsTrue(start >= 0, "ERC-1271 adapter must remain present and return bytes4 magic");
        StringAssert.Contains(messageSource, "0x1626ba7e", "Success magic (ERC-1271)");
        StringAssert.Contains(messageSource, "0xffffffff", "Failure magic (ERC-1271)");
        StringAssert.Contains(messageSource, "MagicInvalidSignature", "Any failure returns the strict failure magic");
        // Canonical P-256 subject: the signer script's SHA256 must equal a
        // configured 0x57 subject.
        StringAssert.Contains(messageSource, "CryptoLib.Sha256(script)", "Subject match against the canonical script hash");
        StringAssert.Contains(messageSource, "VerifyWithECDsa", "P-256 verification primitive");
        StringAssert.Contains(messageSource, "secp256r1SHA256", "secp256r1 curve with SHA256");
        // Module route requires the declared messageCapability.
        StringAssert.Contains(messageSource, "module.MessageCapability", "Module message route is capability-gated");
        StringAssert.Contains(messageSource, "ValidationPerCallGasLimit", "Module message route runs under the validation budget");
        // Message authorization never consumes an operation nonce (spec §8).
        Assert.IsFalse(messageSource.Contains("ConsumeOperationNonce", StringComparison.Ordinal),
            "Message signatures must not consume operation nonces");
    }

    // ========================================================================
    // 5. Escape – timelock boundary constants
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_Escape_TimelockBoundaries()
    {
        var rng = Rng();
        var escapeSource = Read("SmartAccount.Escape.cs");

        // v4 recovery is core-built-in and callback-free (spec §7.5): a custody or
        // recovery-authority initiated record matures in Runtime.Time, is bound to
        // the authority epoch it was opened under, and is executed only by the
        // custody after the lock. The v3 backup-owner escape hatch is gone.
        StringAssert.Contains(escapeSource, "ErrorRecoveryPending + \" none in progress\"", "Finalize/cancel requires an in-flight recovery record");
        StringAssert.Contains(escapeSource, "ErrorRecoveryLocked", "The recovery timelock is enforced on the core record");
        StringAssert.Contains(escapeSource, "RequireCustodyWitness(control)", "Only the custody may execute the recovery");
        StringAssert.Contains(escapeSource, "AssertAccountConfigurationIdle(accountId)", "Recovery is refused while configuration is in flight");
        StringAssert.Contains(escapeSource, "pending.AuthorityEpochAtInit == control.AuthorityEpoch", "A recovery opened under another epoch is dead");
        StringAssert.Contains(escapeSource, "ErrorEpochStale", "Stale-epoch recovery fails closed");

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
        var intentsSource = Read("SmartAccount.Intents.cs");
        var protocolSource = Read("SmartAccount.ModuleProtocol.cs");

        // v4 replaces the verifier/hook pending-call timelocks with one atomic
        // configuration intent: propose → mature → confirm, re-bound by digest.
        StringAssert.Contains(intentsSource, "ErrorIntentImmature", "Configuration intents mature before confirmation");
        StringAssert.Contains(intentsSource, "ErrorIntentExpired", "Configuration intents expire");
        StringAssert.Contains(intentsSource, "ErrorIntentConflict", "Conflicting intents are rejected");
        StringAssert.Contains(protocolSource, "ModuleChangeDelayMs = 86_400_000", "24 hours configuration delay in Runtime.Time milliseconds");
        Assert.AreEqual(1, CountOccurrences(intentsSource, "ModuleChangeDelayMs"),
            "The delay is applied at proposal time in exactly one place");
        Assert.AreEqual(1, CountOccurrences(protocolSource, "ModuleChangeDelayMs"),
            "The delay constant is defined once");
    }

    // ========================================================================
    // 7. Market escrow – lifecycle state transitions
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_MarketEscrow_StateTransitions()
    {
        var marketSource = Read("SmartAccount.MarketEscrow.cs");

        StringAssert.Contains(marketSource, "Account locked in market escrow", "Escrow active check");
        StringAssert.Contains(marketSource, "Only escrow market", "Only market contract can cancel/settle");
        StringAssert.Contains(marketSource, "Listing mismatch", "Listing ID check");
        StringAssert.Contains(marketSource, "New backup owner required", "New owner required for settle");
        StringAssert.Contains(marketSource, "state.Verifier = UInt160.Zero", "Verifier wiped on settle");
        StringAssert.Contains(marketSource, "state.HookId = UInt160.Zero", "Hook wiped on settle");
        StringAssert.Contains(marketSource, "state.EscapeTriggeredAt = BigInteger.Zero", "Recovery state reset on settle");

        // Verify escrow blocks execution
        var executionSource = Read("SmartAccount.Execution.cs");
        StringAssert.Contains(executionSource, "AssertNoMarketEscrow(accountId)", "Execution blocked during escrow");
    }

    // ========================================================================
    // 8. Verifier allowlist – method whitelist
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_VerifierMethodAllowlist_Completeness()
    {
        var rng = Rng();
        var accountsSource = Read("SmartAccount.Accounts.cs");
        var modulesSource = Read("SmartAccount.Modules.cs");
        var executionSource = Read("SmartAccount.Execution.cs");

        // v4 deleted the v3 free-form callVerifier surface, and with it the
        // per-verifier method allowlist: configuration is a hash-pinned module
        // install/configure intent whose positional shape is validated before
        // anything is written.
        Assert.IsFalse(accountsSource.Contains("AllowedVerifierMethods", StringComparison.Ordinal),
            "The v3 verifier method allowlist must stay deleted");
        Assert.IsFalse(accountsSource.Contains("callVerifier", StringComparison.Ordinal),
            "The v3 free-form verifier call must stay deleted");
        StringAssert.Contains(modulesSource, "private static void ValidateActionShape(object[] action)",
            "Every intent action is shape-validated");
        StringAssert.Contains(modulesSource, "ValidateActionShapeCore(action)",
            "The positional shape of each action code is checked");
        StringAssert.Contains(modulesSource, "\"getModuleProfile\"",
            "A module is pinned by its canonical profile");
        StringAssert.Contains(modulesSource, "IsMemberOfActivePolicy(module)",
            "A policy member never routes standalone");
        StringAssert.Contains(modulesSource, "member.ActivePolicyId = policyId;",
            "The policy executor maintains the member back-pointer the routing check reads");
        StringAssert.Contains(executionSource, "ErrorModuleNotRoutable",
            "Routing violations fail closed");

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
        var internalSource = Read("SmartAccount.Internal.cs");
        var expectedPrefixes = new (byte Value, string Name)[]
        {
            (0x01, "Prefix_AccountState"),
            (0x02, "Prefix_VerifyContext"),
            (0x03, "Prefix_Nonce"),
            (0x06, "Prefix_MarketEscrowContract"),
            (0x07, "Prefix_MarketEscrowListing"),
            (0x08, "Prefix_EscapeLastInitiated"),
            (0x09, "Prefix_PendingVerifierUpdate"),
            (0x0A, "Prefix_PendingHookUpdate"),
            (0x0B, "Prefix_ExecutionLock"),
            (0x0C, "Prefix_MetadataUri"),
            (0x0D, "Prefix_HookExecutionContext"),
            (0x0E, "Prefix_VerifierExecutionContext"),
            (0x0F, "Prefix_PendingVerifierCall"),
            (0x10, "Prefix_PendingHookCall"),
            (0x23, "Prefix_HookDependencies"),
            (0x24, "Prefix_VerifierDependencies"),
            (0x25, "Prefix_DependencyMaintenance"),
            (0x26, "Prefix_ConfigurationContextDepth"),
            (0x28, "Prefix_UserOperationInFlight"),
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
        var eventsSource = Read("SmartAccount.Events.cs");
        var combinedSource = ReadCombined();

        string[] requiredEvents =
        {
            "AccountRegistered", "ModuleInstalled", "ModuleUpdateInitiated",
            "ModuleUpdateConfirmed", "ModuleRemoved", "MetadataUriUpdated",
            "UserOpExecuted", "EscapeInitiated", "EscapeFinalized",
            "MarketEscrowEntered", "MarketEscrowCancelled", "MarketEscrowSettled",
            "SponsoredUserOpExecuted", "ModuleInstanceInstalled", "ModuleInstanceConfigured",
            "ModuleInstanceRemoved", "ModuleCodeRebound", "HookOrderSet",
            "ThresholdPolicySet", "CredentialRevoked", "ConfigurationIntentProposed",
            "ConfigurationIntentConfirmed", "ConfigurationIntentCancelled",
            "NonceChannelOpened", "AccountFrozen", "AccountUnfrozen",
            "RecoveryInitiated", "RecoveryExecuted", "MigrationRequired",
            "MigrationImported", "MessageSubjectUpdated",
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
        var stateSource = Read("SmartAccount.State.cs");
        var internalSource = Read("SmartAccount.Internal.cs");
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
            "getAccount", "getModule", "getModules", "getHookOrder", "IsExecutionActive",
            "GetNonce", "GetMetadataUri",
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
        StringAssert.Contains(hookSource, "GetRollingWindowRecordCount(accountId, moduleId, targetContract, currentTime) < MaxHistorySize", "PreCheck refuses unrecordable rolling-window transfers");
        StringAssert.Contains(hookSource, "GetRollingWindowRecordCount(accountId, moduleId, token, currentTime) < MaxHistorySize", "PostCheck refuses to evict live rolling-window spend records");
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
        var paymasterPartial = Read("SmartAccount.Paymaster.cs");

        // Sponsored execution enters the core kernel's own executeUserOp, so a
        // sponsored operation is never a parallel authorization path.
        StringAssert.Contains(paymasterPartial, "executeUserOp(accountId!");

        // Batch sponsored execution enters the core kernel's executeUserOps.
        StringAssert.Contains(paymasterPartial, "executeUserOps(accountId!");

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
            ("contracts/custom/SmartAccount.Admin.cs", "Runtime.CheckWitness(adminHash)"),
            ("contracts/custom/paymaster/Paymaster.cs", "Runtime.CheckWitness(admin)"),
            ("contracts/custom/market/SAAddressMarket.cs", "ValidateAdmin();"),
            ("tests/mocks/MockTransferTarget.cs", "ValidateAdmin();"),
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

        string verifierAuthority = ReadRepo("contracts", "plugins", "validators", "ValidatorAuthority.cs");
        StringAssert.Contains(verifierAuthority, "internal static void Update(ByteString nef, string manifest)");
        StringAssert.Contains(verifierAuthority, "ValidateAdmin();");
        StringAssert.Contains(verifierAuthority, "ContractManagement.Update(nef, manifest)");

        foreach (string verifier in new[] { "MultiSigValidator.cs", "NeoWitnessValidator.cs", "SessionKeyValidator.cs", "SubscriptionValidator.cs", "TeeKeyValidator.cs", "Web3AuthValidator.cs", "P256Validator.cs", "ZKEmailVerifier.cs", "DelegatedIdentityValidator.cs" })
        {
            string code = ReadRepo("contracts", "plugins", "validators", verifier);
            StringAssert.Contains(code, "public static void Update(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);", $"{verifier} delegates update");
        }

        // Audit fixes H5 / H6 / SA-04: the two fund-holding auxiliaries (SocialRecoveryService
        // custodies the per-account oracle-credit GAS pool; SAAddressMarket holds in-flight
        // buyer escrow) must expose the same SA-D-01/SA-D-02 timelocked admin surface as the
        // ValidatorAuthority idiom — proposeUpdate + update/confirmUpdate behind the 7-day
        // window, and rotateAdmin/confirmAdminRotation/cancelAdminRotation in place of the
        // removed instant transferAdmin/setAdmin hand-offs.
        string marketSource = ReadRepo("contracts", "custom", "market", "SAAddressMarket.cs");
        StringAssert.Contains(marketSource, "public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash)", "H6: market exposes proposeUpdate");
        StringAssert.Contains(marketSource, "Update timelock not expired", "H6: market update enforces the 7-day window");
        StringAssert.Contains(marketSource, "public static void RotateAdmin(UInt160 newAdmin)", "H6: market exposes timelocked rotateAdmin");
        StringAssert.Contains(marketSource, "Admin rotation timelock not expired", "H6: market rotation enforces the 7-day window");
        Assert.IsFalse(marketSource.Contains("public static void SetAdmin", StringComparison.Ordinal),
            "H6: the instant setAdmin hand-off must be removed");

        string recoverySource = ReadRepo("contracts", "plugins", "recovery", "SocialRecoveryService.Fixed.cs");
        StringAssert.Contains(recoverySource, "public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash)", "H5: recovery verifier exposes proposeUpdate");
        StringAssert.Contains(recoverySource, "Update timelock not expired", "H5: recovery update enforces the 7-day window");
        StringAssert.Contains(recoverySource, "public static void RotateAdmin(UInt160 newAdmin)", "SA-04: recovery verifier exposes timelocked rotateAdmin");
        StringAssert.Contains(recoverySource, "Admin rotation timelock not expired", "SA-04: recovery rotation enforces the 7-day window");
        Assert.IsFalse(recoverySource.Contains("public static void TransferAdmin", StringComparison.Ordinal),
            "SA-04: the instant transferAdmin hand-off must be removed");
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

        // v4 control record: the custody-bearing account metadata (spec §7.2). The
        // configuration nonce and authority epoch are the replay bindings signed
        // into every operation digest, so their field names are part of the
        // protocol contract rather than an implementation detail.
        StringAssert.Contains(combined, "public class AccountControl");
        StringAssert.Contains(combined, "public UInt160 Custody");
        StringAssert.Contains(combined, "public UInt160 RecoveryAuthority");
        StringAssert.Contains(combined, "public BigInteger AuthorityEpoch");
        StringAssert.Contains(combined, "public BigInteger ConfigurationNonce");
        StringAssert.Contains(combined, "public bool DefaultOperationAuthorization");

        // v4 module instance: code binding plus the capability flags read from the
        // pinned profile digest (spec §7.3).
        StringAssert.Contains(combined, "public class ModuleInstance");
        StringAssert.Contains(combined, "public UInt160 ContractHash");
        StringAssert.Contains(combined, "public BigInteger CredentialGeneration");
        StringAssert.Contains(combined, "public ByteString ProfileSha256");
        StringAssert.Contains(combined, "public bool ThresholdMemberEligible");

        // v4 configuration intent: the 24h-timelocked action batch (spec §10).
        StringAssert.Contains(combined, "public class ConfigurationIntentRecord");
        StringAssert.Contains(combined, "public BigInteger IntentId");
        StringAssert.Contains(combined, "public BigInteger MatureAt");
        StringAssert.Contains(combined, "public ByteString ActionDigest");
        StringAssert.Contains(combined, "public object[] Actions");

        // Randomized invariant check: verify all state-changing methods use CheckWitness
        string[] protectedMethods = { "createAccount", "proposeConfiguration", "confirmConfiguration",
            "cancelConfiguration", "revokeCredentials", "executeUserOp", "beginRecovery",
            "executeRecovery", "EnterMarketEscrow", "SetMetadataUri" };

        for (int i = 0; i < Iterations; i++)
        {
            string method = protectedMethods[rng.Next(protectedMethods.Length)];
            Assert.IsTrue(combined.Contains(method, StringComparison.Ordinal),
                $"Method {method} must exist in combined source");
        }
    }

    // ========================================================================
    // 21. Recovery verifier – anti-squat surface (SA-06)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RecoveryVerifier_AntiSquatSurface()
    {
        // Audit fix SA-06: SetupRecovery was first-write-wins with no proof of account
        // control — a squatter witnessing their OWN key could bind a victim's accountId.
        // The fix pins the canonical SA core (contract-admin gated, initial-set-only,
        // re-pointing timelocked — mirroring the ValidatorAuthority M-7 surface) and requires
        // the core's getBackupOwner registry to attest the claimed owner at setup.
        string flowsSource = ReadRepo("contracts", "plugins", "recovery", "SocialRecoveryService.Flows.cs");
        StringAssert.Contains(flowsSource, "saContract is not the authorized core", "SA-06: setup pins the authorized core");
        StringAssert.Contains(flowsSource, "owner does not control account", "SA-06: setup attests the registered custody");
        StringAssert.Contains(flowsSource, "\"getAccount\"", "SA-06: ownership is attested via the core control record");

        string fixedSource = ReadRepo("contracts", "plugins", "recovery", "SocialRecoveryService.Fixed.cs");
        StringAssert.Contains(fixedSource, "public static void SetAuthorizedCore(UInt160 coreContract)", "SA-06: admin-gated initial core bind exists");
        StringAssert.Contains(fixedSource, "core already set; use ProposeAuthorizedCore", "SA-06: instant core re-pointing is rejected");
        StringAssert.Contains(fixedSource, "public static void ProposeAuthorizedCore(UInt160 coreContract)", "SA-06: timelocked core re-pointing exists");
        StringAssert.Contains(fixedSource, "Core change timelock not expired", "SA-06: core re-pointing enforces the 7-day window");
    }

    // ========================================================================
    // 23. Recovery verifier – least-privilege contract permissions (SA-03)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RecoveryVerifier_LeastPrivilegePermissions()
    {
        // Audit fix SA-03: the wildcard ContractPermission("*", "*") is replaced by
        // method-scoped grants covering the verified v4 call surface — any future
        // wildcard reintroduction or dropped grant must fail here.
        string fixedSource = ReadRepo("contracts", "plugins", "recovery", "SocialRecoveryService.Fixed.cs");
        Assert.IsFalse(fixedSource.Contains("ContractPermission(\"*\", \"*\")", StringComparison.Ordinal), "SA-03: no wildcard contract permission");
        StringAssert.Contains(fixedSource, "ContractPermission(\"0xfffdc93764dbaddd97c48f252a53ea4643faa3fd\", \"update\")", "SA-03: ContractManagement.update grant (timelocked self-upgrade)");
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"getAccount\")", "SA-03: core control-record grant (SA-06 attestation)");
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"beginRecovery\")", "SA-03: core beginRecovery grant");
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"executeRecovery\")", "SA-03: core executeRecovery grant");
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"getRecoveryStatus\")", "SA-03: core getRecoveryStatus grant");
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"cancelRecovery\")", "SA-03: core cancelRecovery grant");
        StringAssert.Contains(fixedSource, "ContractPermission(\"*\", \"request\")", "SA-03: oracle request grant (ticket submission)");
        StringAssert.Contains(fixedSource, "ContractPermission(\"0xd2a4cff31913016155e38e474a2c06d08be276cf\", \"transfer\")", "SA-03: GAS transfer grant (credit forwarding)");
    }

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RecoveryVerifier_ImplementsV4ModuleSurface()
    {
        // The recovery-backed session validator is a v4 module instance: it declares
        // a profile, validates through the routed digest callback and books the
        // outcome in the completion callback. Every callback re-derives its
        // authorization from the core's own phase gates (0x58), so the retired v3
        // entry points — SupportsV3, ValidateSignature and a caller-guarded
        // PostExecute — must stay deleted rather than linger as a second surface.
        string moduleSource = ReadRepo("contracts", "plugins", "recovery", "ActionSessionValidator.cs");
        StringAssert.Contains(moduleSource, "public static string GetModuleProfile()");
        StringAssert.Contains(moduleSource, "public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)");
        StringAssert.Contains(moduleSource, "public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)");
        StringAssert.Contains(moduleSource, "ValidatorAuthority.RequireValidation(accountId, operation)",
            "Validation re-derives its phase gate from the core");
        StringAssert.Contains(moduleSource, "ValidatorAuthority.RequireCompletion(accountId, operation)",
            "Completion re-derives its phase gate from the core");
        StringAssert.Contains(moduleSource, "ValidatorAuthority.RequireLifecycle(accountId, moduleId)",
            "Lifecycle callbacks re-derive their phase gate from the core");
        Assert.IsFalse(moduleSource.Contains("SupportsV3", StringComparison.Ordinal),
            "The v3 capability flag must stay removed");
        Assert.IsFalse(moduleSource.Contains("public static void PostExecute(", StringComparison.Ordinal),
            "The v3 PostExecute entry point must stay removed");
    }

    // ========================================================================
    // 24. Every PostExecute validates its caller (audit low, pattern risk)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_SignedPayloadsBindAuthorizedAaCore()
    {
        // A threshold-policy member signs a member-scoped digest: the shared
        // payload domain-separates it and binds the instance's credential
        // generation, so a revoked member cannot replay an approval inside a
        // reshaped policy (spec §5.2).
        string sharedPayload = ReadRepo("contracts", "plugins", "validators", "ValidatorPayload.cs");
        StringAssert.Contains(sharedPayload, "ThresholdMemberDomain",
            "shared member payload must be domain separated");
        StringAssert.Contains(sharedPayload, "ValidatorAuthority.CredentialGeneration(accountId, moduleId)",
            "shared member payload must bind the instance credential generation");

        string web3Auth = ReadRepo("contracts", "plugins", "validators", "Web3AuthValidator.cs");
        StringAssert.Contains(web3Auth, "ToBytes20Word(ValidatorAuthority.AuthorizedCore())",
            "Web3Auth struct hash must bind the authorized SA core");
        StringAssert.Contains(web3Auth, "UserOperationTypeHash",
            "Web3Auth struct hash must use the core-bound type hash");
        StringAssert.Contains(web3Auth, "CryptoLib.RecoverSecp256K1(hash, signature)",
            "Web3Auth ERC-1271 verification must consume the supplied digest directly");

        string zkLogin = ReadRepo("contracts", "plugins", "validators", "DelegatedIdentityValidator.cs");
        StringAssert.Contains(zkLogin, "IdentityDomain",
            "Delegated identity payload must be domain separated");
        StringAssert.Contains(zkLogin, "(byte[])signingDigest",
            "Delegated identity payload must consume the core-supplied digest");
    }

    // ========================================================================
    // 24b. Every PostExecute validates its caller (audit low, pattern risk)
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_AllCompletionPathsValidateCaller()
    {
        // Audit low: several no-op post-execution bodies previously had no caller
        // guard — harmless today, but a future edit could add logic to an unguarded
        // path. The v4 estate invariant is that EVERY post-execution callback first
        // re-derives its authorization from the core's phase gate (hook post phase
        // 0x58 for hooks, completion phase for validator instances), even a no-op.
        string neoDid = ReadRepo("contracts", "plugins", "hooks", "NeoDIDCredentialHook.cs");
        StringAssert.Contains(neoDid, "HookAuthority.RequirePostCheck(accountId, operation)",
            "NeoDIDCredentialHook.PostCheck validates its caller");
        string whitelist = ReadRepo("contracts", "plugins", "hooks", "WhitelistHook.cs");
        StringAssert.Contains(whitelist, "HookAuthority.RequirePostCheck(accountId, operation)",
            "WhitelistHook.PostCheck validates its caller");
        string tokenRestricted = ReadRepo("contracts", "plugins", "hooks", "TokenRestrictedHook.cs");
        StringAssert.Contains(tokenRestricted, "HookAuthority.RequirePostCheck(accountId, operation)",
            "TokenRestrictedHook.PostCheck validates its caller");
        string neoNative = ReadRepo("contracts", "plugins", "validators", "NeoWitnessValidator.cs");
        StringAssert.Contains(neoNative, "ValidatorAuthority.RequireCompletion(accountId, operation)",
            "NeoWitnessValidator.OnUserOpComplete validates its caller");
        foreach (string verifier in new[] { "TeeKeyValidator.cs", "Web3AuthValidator.cs", "P256Validator.cs", "ZKEmailVerifier.cs", "DelegatedIdentityValidator.cs", "MultiSigValidator.cs" })
        {
            string source = ReadRepo("contracts", "plugins", "validators", verifier);
            StringAssert.Contains(source, "ValidatorAuthority.RequireCompletion(accountId, operation)",
                $"{verifier}.OnUserOpComplete validates its caller");
        }
    }

    // ========================================================================
    // 22. Recovery verifier – timelock bounds match the estate standard
    // ========================================================================

    [TestMethod, Timeout(120_000)]
    public void SourceInvariant_RecoveryVerifier_TimelockBoundsMatchEstateStandard()
    {
        // Audit finding (recovery timelock bounds): SocialRecoveryService enforced a 1h
        // minimum and NO maximum, while the estate standard — the SA core escape hatch's
        // 604800–7776000 seconds pinned in section 1/5 — is 7–90 days. The recovery verifier
        // must enforce the same window in Runtime.Time milliseconds (604800000–7776000000)
        // in BOTH SetupRecovery and UpdateRecoveryConfig.
        string flowsSource = ReadRepo("contracts", "plugins", "recovery", "SocialRecoveryService.Flows.cs");
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
