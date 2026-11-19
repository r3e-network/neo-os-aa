using System;
using System.IO;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace SmartAccount.Contracts.Tests;

// ---------------------------------------------------------------------------
// Regression tests for the HIGH-severity DailyLimitHook bypass fix.
//
// Finding: DailyLimitHook only metered the directly-targeted token, so the daily
// limit was bypassable by moving value through an intermediary/router contract or
// via the native NEO/GAS path — the limited token was never the direct call
// target, so it was never counted.
//
// Fix: PreExecute snapshots the balance of EVERY token that has a configured limit
// for the account (iterating the account's configured-limit set, mirroring
// TokenRestrictedHook), and PostExecute meters the realized balance delta of each
// against its limit. This counts value moved by ANY path (transferFrom/withdraw/
// swap, router-intermediated, or native NEO/GAS), and fails closed.
//
// These are source-invariant tests, matching the established validation pattern for
// the hooks in this repository (ContractTests / SourceInvariantTests). They assert
// the structural properties that close the bypass and would fail against the
// pre-fix, direct-target-only implementation. A companion check confirms the fixed
// source still compiles to valid NeoVM bytecode by being exercised through the
// runtime suites that load contracts/bin/public/hooks/DailyLimitHook.nef.
//
// Protocol v4 scopes every key and every callback to one (accountId, moduleId)
// instance, so the helpers below now carry the resolved moduleId; the metering
// invariants themselves are unchanged.
// ---------------------------------------------------------------------------

[TestClass]
public class Fix_DailyLimitHook_Tests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static string ReadHook(string fileName) =>
        File.ReadAllText(Path.Combine(RepoRoot, "contracts", "plugins", "hooks", fileName));

    /// <summary>
    /// PreExecute must snapshot the balance of EVERY configured-limit token by iterating the
    /// account's configured-limit set, not just the directly-targeted token. This is the same
    /// path-agnostic technique TokenRestrictedHook uses.
    /// </summary>
    [TestMethod]
    public void PreExecute_SnapshotsAllConfiguredLimitTokens_NotJustTheDirectTarget()
    {
        string source = ReadHook("DailyLimitHook.cs");

        // PreExecute drives the snapshot over the whole configured-limit set of the
        // resolved instance.
        StringAssert.Contains(source, "SnapshotAllLimitedBalances(accountId, moduleId);",
            "PreExecute must snapshot every configured-limit token before execution");

        // The snapshot iterates the instance's configured limits (Prefix_DailyLimit) with
        // RemovePrefix to recover each token hash — the configured set, not the op target.
        StringAssert.Contains(source, "private static void SnapshotAllLimitedBalances(UInt160 accountId, BigInteger moduleId)",
            "an all-token snapshot helper must exist");
        StringAssert.Contains(source, "HookAuthority.InstanceKey(Prefix_DailyLimit, accountId, moduleId),",
            "snapshot must iterate the instance-scoped configured-limit set");
        StringAssert.Contains(source, "FindOptions.KeysOnly | FindOptions.RemovePrefix);",
            "snapshot must recover each configured token hash");
        StringAssert.Contains(source, "BigInteger before = TokenBalanceOf(token, assetAddress);",
            "snapshot records each configured token's pre-execution balance at the address that holds it");
        // The accountId never holds a balance: a virtual SA account keeps its assets at
        // the core's proxy script hash, so metering the id charged nothing against the limit.
        StringAssert.Contains(source, "UInt160 assetAddress = HookAuthority.AssetAddress(accountId);",
            "each callback resolves the canonical holding address once");
        StringAssert.Contains(ReadHook("HookAuthority.cs"),
            "Contract.Call(Core(), \"getProxyScriptHash\", CallFlags.ReadOnly, new object[] { accountId })",
            "the holding address must be derived from the authorized core, never assumed");
        Assert.IsFalse(source.Contains("TokenBalanceOf(token, accountId)", StringComparison.Ordinal),
            "metering must never read the accountId's own balance");

        // The pre-fix code only snapshotted the single directly-targeted token; that helper and
        // its single-target metering counterpart must be gone.
        Assert.IsFalse(source.Contains("SnapshotLimitedTokenBalance(", StringComparison.Ordinal),
            "the direct-target-only snapshot helper must be removed");
        Assert.IsFalse(source.Contains("MeterLimitedTokenOutflow(", StringComparison.Ordinal),
            "the direct-target-only metering helper must be removed");
    }

    /// <summary>
    /// PostExecute must meter the realized balance delta of every configured-limit token and
    /// fail closed when any token's limit would be exceeded, regardless of the call path.
    /// </summary>
    [TestMethod]
    public void PostExecute_MetersBalanceDeltaAcrossAllConfiguredTokens_AndFailsClosed()
    {
        string source = ReadHook("DailyLimitHook.cs");

        StringAssert.Contains(source, "MeterAllLimitedOutflows(accountId, moduleId, directToken, declaredAmount);",
            "PostCheck must meter the realized outflow of every configured-limit token");
        StringAssert.Contains(source, "private static void MeterAllLimitedOutflows(UInt160 accountId, BigInteger moduleId, UInt160 directToken, BigInteger declaredAmount)",
            "an all-token delta-metering helper must exist");

        // Metering is driven by the configured-limit set and computed from the real balance delta.
        StringAssert.Contains(source, "BigInteger outflow = before - after;",
            "outflow is the realized pre/post balance delta, so indirect/native moves are counted");
        StringAssert.Contains(source, "ExecutionEngine.Assert(newTotal <= config.MaxAmount, \"Daily limit exceeded\");",
            "exceeding the configured limit must revert the whole transaction (fail closed)");
        // Snapshots and spend counters are instance-scoped: two limit instances on one
        // account never share a meter (spec §12).
        StringAssert.Contains(source, "TokenKey(Prefix_BalanceSnapshot, accountId, moduleId, token)",
            "snapshots must be keyed by instance");
        StringAssert.Contains(source, "TokenKey(Prefix_SpentToday, accountId, moduleId, token)",
            "spend counters must be keyed by instance");

        // A direct transfer is charged once at the greater of declared value and net outflow.
        StringAssert.Contains(source, "if (token == directToken && declaredAmount > outflow) outflow = declaredAmount;",
            "declared value must not hide a larger actual debit or double-count the same transfer");
        Assert.IsFalse(source.Contains("if (token == directlyRecorded) continue;", StringComparison.Ordinal));

    }

    /// <summary>
    /// The native NEO/GAS path is covered because metering reads balances via the generic NEP-17
    /// balanceOf and is keyed off the configured-limit set — a configured NEO/GAS limit is metered
    /// identically to any other token, so an indirect native move cannot slip past.
    /// </summary>
    [TestMethod]
    public void Metering_UsesGenericNep17BalanceOf_SoNativeAndIntermediaryMovesAreCovered()
    {
        string source = ReadHook("DailyLimitHook.cs");

        StringAssert.Contains(source,
            "object balance = Contract.Call(token, \"balanceOf\", CallFlags.ReadOnly, new object[] { account });",
            "balances are read via the generic NEP-17 balanceOf (NEO/GAS expose this too)");

        // A dedicated transient snapshot prefix keeps the pre-balances separate from the limit
        // config storage and is cleared each op so stale snapshots cannot under-count later.
        StringAssert.Contains(source, "Prefix_BalanceSnapshot",
            "a dedicated transient balance-snapshot storage prefix must exist");
        StringAssert.Contains(source, "Storage.Delete(Storage.CurrentContext, snapKey);",
            "transient snapshots must be cleared after metering");
    }

    [TestMethod]
    public void ConfigurationRejectsInvalidTokensAndBoundsSnapshotWork()
    {
        string daily = ReadHook("DailyLimitHook.cs");
        StringAssert.Contains(daily, "Invalid limited token");
        StringAssert.Contains(daily, "Negative daily limit");
        StringAssert.Contains(daily, "MaxConfiguredTokens = 16");
        StringAssert.Contains(daily, "Too many limited tokens");

        string restricted = ReadHook("TokenRestrictedHook.cs");
        StringAssert.Contains(restricted, "Invalid restricted token");
        StringAssert.Contains(restricted, "MaxRestrictedTokens = 16");
        StringAssert.Contains(restricted, "Too many restricted tokens");
    }
}
