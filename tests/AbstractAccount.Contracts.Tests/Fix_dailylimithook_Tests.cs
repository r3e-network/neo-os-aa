using System;
using System.IO;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace AbstractAccount.Contracts.Tests;

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
// runtime suites that load contracts/bin/v3/hooks/DailyLimitHook.nef.
// ---------------------------------------------------------------------------

[TestClass]
public class Fix_DailyLimitHook_Tests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static string ReadHook(string fileName) =>
        File.ReadAllText(Path.Combine(RepoRoot, "contracts", "hooks", fileName));

    /// <summary>
    /// PreExecute must snapshot the balance of EVERY configured-limit token by iterating the
    /// account's configured-limit set, not just the directly-targeted token. This is the same
    /// path-agnostic technique TokenRestrictedHook uses.
    /// </summary>
    [TestMethod]
    public void PreExecute_SnapshotsAllConfiguredLimitTokens_NotJustTheDirectTarget()
    {
        string source = ReadHook("DailyLimitHook.cs");

        // PreExecute drives the snapshot over the whole configured-limit set.
        StringAssert.Contains(source, "SnapshotAllLimitedBalances(accountId);",
            "PreExecute must snapshot every configured-limit token before execution");

        // The snapshot iterates the account's configured limits (Prefix_DailyLimit) with
        // RemovePrefix to recover each token hash — the configured set, not the op target.
        StringAssert.Contains(source, "private static void SnapshotAllLimitedBalances(UInt160 accountId)",
            "an all-token snapshot helper must exist");
        StringAssert.Contains(source,
            "Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);",
            "snapshot must iterate the configured-limit set");
        StringAssert.Contains(source, "BigInteger before = TokenBalanceOf(token, AssetAddressOf(accountId));",
            "snapshot records each configured token's pre-execution balance at the address that holds it");
        // The accountId never holds a balance: a virtual AA account keeps its assets at
        // the core's proxy script hash, so metering the id charged nothing against the limit.
        StringAssert.Contains(source, "HookAuthority.AuthorizedCore()",
            "the holding address must be derived from the authorized core, not assumed");
        StringAssert.Contains(source, "Contract.Call(core, \"getProxyScriptHash\", CallFlags.ReadOnly, accountId)",
            "the hook asks the core for the canonical holding address");
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

        StringAssert.Contains(source, "MeterAllLimitedOutflows(accountId, directlyRecorded);",
            "PostExecute must meter the realized outflow of every configured-limit token");
        StringAssert.Contains(source, "private static void MeterAllLimitedOutflows(UInt160 accountId, UInt160 directlyRecorded)",
            "an all-token delta-metering helper must exist");

        // Metering is driven by the configured-limit set and computed from the real balance delta.
        StringAssert.Contains(source, "BigInteger outflow = before - after;",
            "outflow is the realized pre/post balance delta, so indirect/native moves are counted");
        StringAssert.Contains(source, "ExecutionEngine.Assert(newTotal <= config.MaxAmount, \"Daily limit exceeded\");",
            "exceeding the configured limit must revert the whole transaction (fail closed)");

        // The directly-targeted transfer is still accounted exactly once (by declared amount),
        // and excluded from the delta pass to avoid double counting.
        StringAssert.Contains(source, "if (token == directlyRecorded) continue;",
            "the directly-recorded token must be excluded from the delta pass to avoid double counting");
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
            "return (BigInteger)Contract.Call(token, \"balanceOf\", CallFlags.ReadOnly, new object[] { account });",
            "balances are read via the generic NEP-17 balanceOf (NEO/GAS expose this too)");

        // A dedicated transient snapshot prefix keeps the pre-balances separate from the limit
        // config storage and is cleared each op so stale snapshots cannot under-count later.
        StringAssert.Contains(source, "Prefix_BalanceSnapshot",
            "a dedicated transient balance-snapshot storage prefix must exist");
        StringAssert.Contains(source, "Storage.Delete(Storage.CurrentContext, snapKey);",
            "transient snapshots must be cleared after metering");
    }
}
