using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Source-level invariants pinning the cross-partial storage-prefix allocation of
/// <c>UnifiedSmartWalletV3</c>.
///
/// The contract's storage keys are namespaced by a one-byte prefix declared as
/// <c>private static readonly byte[] Prefix_* = new byte[] { 0xNN };</c> across several partial-class
/// files. The active layout uses a globally unique byte for every prefix. The contract retains
/// separate legacy compatibility constants for the pre-renumbered 0x12/0x13 layout, but those
/// constants are read/delete-only and are not active prefix declarations.
///
/// These tests:
///   1. Derive each prefix's (byte, key shape) directly from the contract source.
///   2. Assert no two active prefixes share the same byte, so any FUTURE prefix reuse fails the suite.
///   3. Assert the authoritative STORAGE PREFIX MAP doc comment in <c>UnifiedSmartWallet.cs</c> is
///      complete and accurate against the source (every declared prefix is documented with the
///      correct owning partial and shape, and nothing extra is documented).
///
/// Legacy compatibility is intentionally outside the active map and is covered by runtime fallback
/// paths in the affected getters and cleanup methods.
/// </summary>
[TestClass]
public class StoragePrefixMapTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string ContractsDir = Path.Combine(RepoRoot, "contracts");

    /// <summary>Every partial-class file of UnifiedSmartWalletV3 that may declare storage prefixes.</summary>
    private static readonly string[] WalletPartials =
    {
        "UnifiedSmartWallet.cs",
        "UnifiedSmartWallet.Accounts.cs",
        "UnifiedSmartWallet.Admin.cs",
        "UnifiedSmartWallet.Escape.cs",
        "UnifiedSmartWallet.Events.cs",
        "UnifiedSmartWallet.Execution.cs",
        "UnifiedSmartWallet.Internal.cs",
        "UnifiedSmartWallet.MarketEscrow.cs",
        "UnifiedSmartWallet.Models.cs",
        "UnifiedSmartWallet.Paymaster.cs",
        "UnifiedSmartWallet.PlatformRegistrar.cs",
        "UnifiedSmartWallet.State.cs",
        "UnifiedSmartWallet.VerifyContext.cs",
    };

    private const string ShapeBare = "bare";
    private const string ShapeAccountScoped = "+acctId";

    private static readonly Regex PrefixDeclaration = new(
        @"private static readonly byte\[\]\s+(?<name>Prefix_[A-Za-z0-9_]+)\s*=\s*new byte\[\]\s*\{\s*0x(?<byte>[0-9A-Fa-f]{2})\s*\}",
        RegexOptions.Compiled);

    private sealed record PrefixDecl(string Name, byte Value, string Partial);

    private static string ReadPartial(string fileName) => File.ReadAllText(Path.Combine(ContractsDir, fileName));

    private static string ReadAllPartials() => string.Join("\n\n", WalletPartials.Select(ReadPartial));

    /// <summary>Parses every <c>Prefix_* = new byte[] { 0xNN }</c> declaration across the wallet partials.</summary>
    private static List<PrefixDecl> CollectDeclarations()
    {
        var declarations = new List<PrefixDecl>();
        foreach (string partial in WalletPartials)
        {
            string source = ReadPartial(partial);
            foreach (Match match in PrefixDeclaration.Matches(source))
            {
                declarations.Add(new PrefixDecl(
                    match.Groups["name"].Value,
                    Convert.ToByte(match.Groups["byte"].Value, 16),
                    partial));
            }
        }
        return declarations;
    }

    /// <summary>
    /// Derives a prefix's key shape from how the contract actually builds its keys: a prefix that is
    /// ever fed through <c>Helper.Concat(Prefix_*, ...)</c> is accountId-scoped; a prefix only ever
    /// handed directly to <c>Storage.Get/Put/Delete/Find(..., Prefix_*)</c> is a bare global key.
    /// </summary>
    private static string DeriveShape(string prefixName, string allSource)
    {
        bool concatenated = Regex.IsMatch(allSource, $@"Helper\.Concat\(\s*{Regex.Escape(prefixName)}\s*[,)]");
        bool bareDirect = Regex.IsMatch(
            allSource,
            $@"Storage\.(Get|Put|Delete|Find)\(\s*Storage\.CurrentContext\s*,\s*{Regex.Escape(prefixName)}\s*[,)]");

        Assert.IsTrue(concatenated || bareDirect,
            $"{prefixName} is declared but never used in a recognizable storage key construction; " +
            "the prefix-map invariant cannot classify its key shape.");
        // A prefix used in both forms would be genuinely ambiguous; the current contract never does this.
        Assert.IsFalse(concatenated && bareDirect,
            $"{prefixName} is used as both a bare key and an accountId-suffixed key, which is ambiguous " +
            "and unsafe; split it into two distinct prefixes.");

        return concatenated ? ShapeAccountScoped : ShapeBare;
    }

    [TestMethod]
    public void ActivePrefixBytesAreGloballyUnique()
    {
        string allSource = ReadAllPartials();
        List<PrefixDecl> declarations = CollectDeclarations();

        Assert.IsTrue(declarations.Count >= 24,
            $"Expected the full known prefix set to be declared; found only {declarations.Count}.");

        var byByte = new Dictionary<byte, List<string>>();
        foreach (PrefixDecl decl in declarations)
        {
            DeriveShape(decl.Name, allSource);
            if (!byByte.TryGetValue(decl.Value, out List<string>? owners))
            {
                owners = new List<string>();
                byByte[decl.Value] = owners;
            }
            owners.Add($"{decl.Name} ({decl.Partial})");
        }

        foreach (var (value, owners) in byByte)
        {
            Assert.AreEqual(1, owners.Count,
                $"Active storage prefix byte 0x{value:X2} is claimed by multiple prefixes: " +
                $"{string.Join(", ", owners)}. Allocate a distinct byte.");
        }
    }

    [TestMethod]
    public void StoragePrefixMapDocMatchesSource()
    {
        string mapSource = ReadPartial("UnifiedSmartWallet.cs");
        StringAssert.Contains(mapSource, "STORAGE PREFIX MAP",
            "UnifiedSmartWallet.cs must carry the authoritative STORAGE PREFIX MAP doc comment.");

        // Parse the documented table rows: "// 0xNN  Prefix_Name  Owning.cs  shape".
        var rowRegex = new Regex(
            @"//\s*0x(?<byte>[0-9A-Fa-f]{2})\s+(?<name>Prefix_[A-Za-z0-9_]+)\s+(?<partial>UnifiedSmartWallet[A-Za-z0-9_.]*\.cs|[A-Za-z0-9_]+\.cs)\s+(?<shape>bare|\+acctId\S*)",
            RegexOptions.Compiled);

        var documented = new List<(byte Value, string Name, string Partial, string Shape)>();
        foreach (Match match in rowRegex.Matches(mapSource))
        {
            documented.Add((
                Convert.ToByte(match.Groups["byte"].Value, 16),
                match.Groups["name"].Value,
                match.Groups["partial"].Value,
                match.Groups["shape"].Value));
        }

        Assert.IsTrue(documented.Count >= 24,
            $"The STORAGE PREFIX MAP documents only {documented.Count} prefixes; the source declares more.");

        string allSource = ReadAllPartials();
        List<PrefixDecl> declarations = CollectDeclarations();

        // Index the documented rows by prefix name. Each prefix name appears exactly once in the map.
        var documentedByName = new Dictionary<string, (byte Value, string Partial, string Shape)>();
        foreach (var row in documented)
        {
            Assert.IsFalse(documentedByName.ContainsKey(row.Name),
                $"{row.Name} is documented more than once in the STORAGE PREFIX MAP.");
            documentedByName[row.Name] = (row.Value, row.Partial, row.Shape);
        }

        // COMPLETENESS + CORRECTNESS: every declared prefix is documented with the right byte,
        // owning partial, and key shape.
        foreach (PrefixDecl decl in declarations)
        {
            Assert.IsTrue(documentedByName.TryGetValue(decl.Name, out var doc),
                $"{decl.Name} (0x{decl.Value:X2}, {decl.Partial}) is declared in source but missing from the " +
                "STORAGE PREFIX MAP in UnifiedSmartWallet.cs.");

            Assert.AreEqual(decl.Value, doc.Value,
                $"{decl.Name} is declared as 0x{decl.Value:X2} but the map documents 0x{doc.Value:X2}.");

            string declaredOwner = decl.Partial.Replace("UnifiedSmartWallet.", string.Empty);
            string documentedOwner = doc.Partial.Replace("UnifiedSmartWallet.", string.Empty);
            Assert.AreEqual(declaredOwner, documentedOwner,
                $"{decl.Name} is declared in {decl.Partial} but the map attributes it to {doc.Partial}.");

            string actualShape = DeriveShape(decl.Name, allSource);
            // The map may annotate extra suffixes (e.g. "+acctId(+channel)"); the leading family must match.
            Assert.IsTrue(doc.Shape.StartsWith(actualShape, StringComparison.Ordinal),
                $"{decl.Name} has key shape '{actualShape}' in source but the map documents '{doc.Shape}'.");
        }

        // NO STALE ROWS: every documented prefix actually exists in source.
        var declaredNames = declarations.Select(decl => decl.Name).ToHashSet();
        foreach (var name in documentedByName.Keys)
        {
            Assert.IsTrue(declaredNames.Contains(name),
                $"The STORAGE PREFIX MAP documents {name}, but no such prefix is declared in source.");
        }
    }

    [TestMethod]
    public void ActivePrefixMapUsesUniqueMarketEscrowAllocation()
    {
        string marketSource = ReadPartial("UnifiedSmartWallet.MarketEscrow.cs");

        StringAssert.Contains(marketSource, "globally unique",
            "MarketEscrow.cs must document that its active prefix is globally unique.");
        StringAssert.Contains(marketSource, "legacy 0x13",
            "MarketEscrow.cs must document the legacy compatibility read/delete path.");
    }
}
