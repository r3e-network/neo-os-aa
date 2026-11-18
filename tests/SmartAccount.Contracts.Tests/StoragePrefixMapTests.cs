using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Source-level invariants pinning the cross-partial storage-prefix allocation of
/// <c>SmartAccount</c> under the v4 module-model protocol (SA-MODULE-PROTOCOL.md §7.1).
///
/// The contract's storage keys are namespaced by a one-byte prefix declared as
/// <c>private static readonly byte[] Prefix_* = new byte[] { 0xNN };</c> across the
/// wallet partial-class files. Two regions exist:
///
///   * LEGACY REGION (0x01-0x29): surviving rows are migration input or inert
///     evidence. Some prefixes are still exercised (legacy-row cleanup deletes,
///     migration decoders) and some are declared-but-unused map pins whose bytes
///     are permanently reserved (RETIRED).
///   * V4 MODULE-MODEL REGION (0x50-0x5E): the authoritative allocation for all
///     new code; 0x5F is reserved and must never be declared.
///
/// These tests:
///   1. Derive each prefix's (byte, key shape) directly from the contract source;
///      a declaration with no recognizable storage usage is classified RETIRED.
///   2. Assert no two declared prefixes (active or retired) share the same byte,
///      so any FUTURE prefix reuse fails the suite.
///   3. Assert the authoritative STORAGE PREFIX MAP doc comment in
///      <c>SmartAccount.cs</c> is complete and accurate against the source.
///   4. Pin the v4 region layout: all of 0x50-0x5E declared in
///      <c>SmartAccount.ModuleProtocol.cs</c>, 0x5F never declared, and the
///      retired-but-undeclared legacy bytes (0x04/0x05/0x1C) permanently reserved.
/// </summary>
[TestClass]
public class StoragePrefixMapTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CoreDir = Path.Combine(RepoRoot, "contracts", "custom");

    /// <summary>Every partial-class file of SmartAccount that may declare storage prefixes.</summary>
    private static readonly string[] WalletPartials =
    {
        "SmartAccount.cs",
        "SmartAccount.Accounts.cs",
        "SmartAccount.Admin.cs",
        "SmartAccount.Escape.cs",
        "SmartAccount.Events.cs",
        "SmartAccount.Execution.cs",
        "SmartAccount.Intents.cs",
        "SmartAccount.Internal.cs",
        "SmartAccount.MarketEscrow.cs",
        "SmartAccount.Message.cs",
        "SmartAccount.Migration.cs",
        "SmartAccount.Models.cs",
        "SmartAccount.ModuleProtocol.cs",
        "SmartAccount.Modules.cs",
        "SmartAccount.Nonce.cs",
        "SmartAccount.Paymaster.cs",
        "SmartAccount.PlatformRegistrar.cs",
        "SmartAccount.State.cs",
        "SmartAccount.VerifyContext.cs",
    };

    private const string ShapeBare = "bare";
    private const string ShapeAccountScoped = "+acctId";

    private static readonly Regex PrefixDeclaration = new(
        @"private static readonly byte\[\]\s+(?<name>Prefix_[A-Za-z0-9_]+)\s*=\s*new byte\[\]\s*\{\s*0x(?<byte>[0-9A-Fa-f]{2})\s*\}",
        RegexOptions.Compiled);

    private sealed record PrefixDecl(string Name, byte Value, string Partial);

    private static string ReadPartial(string fileName) => File.ReadAllText(Path.Combine(CoreDir, fileName));

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
    /// Returns null when the declaration has no recognizable storage usage at all: that is a
    /// RETIRED map pin (byte permanently reserved, never re-allocated).
    /// </summary>
    private static string? DeriveShape(string prefixName, string allSource)
    {
        bool concatenated = Regex.IsMatch(allSource, $@"Helper\.Concat\(\s*{Regex.Escape(prefixName)}\s*[,)]");
        bool bareDirect = Regex.IsMatch(
            allSource,
            $@"Storage\.(Get|Put|Delete|Find)\(\s*Storage\.CurrentContext\s*,\s*{Regex.Escape(prefixName)}\s*[,)]")
            // Expression-bodied bare key builder (e.g. ProtocolInfoKey() => Prefix_ProtocolInfo;)
            || Regex.IsMatch(allSource, $@"=>\s*{Regex.Escape(prefixName)}\s*;");

        if (concatenated && bareDirect)
        {
            Assert.Fail(
                $"{prefixName} is used as both a bare key and an accountId-suffixed key, which is ambiguous " +
                "and unsafe; split it into two distinct prefixes.");
        }

        return concatenated ? ShapeAccountScoped : bareDirect ? ShapeBare : null;
    }

    [TestMethod]
    public void ActivePrefixBytesAreGloballyUnique()
    {
        string allSource = ReadAllPartials();
        List<PrefixDecl> declarations = CollectDeclarations();

        Assert.IsTrue(declarations.Count >= 30,
            $"Expected the full known prefix set to be declared; found only {declarations.Count}.");

        var byByte = new Dictionary<byte, List<string>>();
        foreach (PrefixDecl decl in declarations)
        {
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
                $"Storage prefix byte 0x{value:X2} is claimed by multiple prefixes (active or retired): " +
                $"{string.Join(", ", owners)}. Every byte is allocated at most once, ever.");
        }
    }

    [TestMethod]
    public void StoragePrefixMapDocMatchesSource()
    {
        string mapSource = ReadPartial("SmartAccount.cs");
        StringAssert.Contains(mapSource, "STORAGE PREFIX MAP",
            "SmartAccount.cs must carry the authoritative STORAGE PREFIX MAP doc comment.");

        // Parse the documented table rows: "// 0xNN  Prefix_Name  Owning.cs  shape [(annotation)]".
        var rowRegex = new Regex(
            @"//\s*0x(?<byte>[0-9A-Fa-f]{2})\s+(?<name>Prefix_[A-Za-z0-9_]+)\s+(?<partial>SmartAccount[A-Za-z0-9_.]*\.cs|[A-Za-z0-9_]+\.cs)\s+(?<shape>bare|\+acctId\S*)",
            RegexOptions.Compiled);

        var documented = new List<(byte Value, string Name, string Partial, string Shape, string RowText)>();
        foreach (Match match in rowRegex.Matches(mapSource))
        {
            // The map row may carry an annotation after the shape column (e.g.
            // "+acctId (RETIRED: legacy pending update)"); capture the whole
            // comment line so RETIRED annotations are visible to the checks below.
            int lineEnd = mapSource.IndexOf('\n', match.Index);
            if (lineEnd < 0) lineEnd = mapSource.Length;
            string rowText = mapSource.Substring(match.Index, lineEnd - match.Index);
            documented.Add((
                Convert.ToByte(match.Groups["byte"].Value, 16),
                match.Groups["name"].Value,
                match.Groups["partial"].Value,
                match.Groups["shape"].Value,
                rowText));
        }

        Assert.IsTrue(documented.Count >= 30,
            $"The STORAGE PREFIX MAP documents only {documented.Count} declared prefixes; the source declares more.");

        string allSource = ReadAllPartials();
        List<PrefixDecl> declarations = CollectDeclarations();

        // Index the documented rows by prefix name. Each prefix name appears exactly once in the map.
        var documentedByName = new Dictionary<string, (byte Value, string Partial, string Shape, string RowText)>();
        foreach (var row in documented)
        {
            Assert.IsFalse(documentedByName.ContainsKey(row.Name),
                $"{row.Name} is documented more than once in the STORAGE PREFIX MAP.");
            documentedByName[row.Name] = (row.Value, row.Partial, row.Shape, row.RowText);
        }

        // COMPLETENESS + CORRECTNESS: every declared prefix is documented with the right byte,
        // owning partial, and — for prefixes with a derivable key shape — the right shape family.
        foreach (PrefixDecl decl in declarations)
        {
            Assert.IsTrue(documentedByName.TryGetValue(decl.Name, out var doc),
                $"{decl.Name} (0x{decl.Value:X2}, {decl.Partial}) is declared in source but missing from the " +
                "STORAGE PREFIX MAP in SmartAccount.cs.");

            Assert.AreEqual(decl.Value, doc.Value,
                $"{decl.Name} is declared as 0x{decl.Value:X2} but the map documents 0x{doc.Value:X2}.");

            string declaredOwner = decl.Partial.Replace("SmartAccount.", string.Empty);
            string documentedOwner = doc.Partial.Replace("SmartAccount.", string.Empty);
            Assert.AreEqual(declaredOwner, documentedOwner,
                $"{decl.Name} is declared in {decl.Partial} but the map attributes it to {doc.Partial}.");

            string? actualShape = DeriveShape(decl.Name, allSource);
            if (actualShape == null)
            {
                // Declared-but-unused: a permanently reserved byte. The map row must say so.
                StringAssert.Contains(doc.RowText, "RETIRED",
                    $"{decl.Name} has no recognizable storage usage; it is a retired map pin and the map must " +
                    "annotate its row with RETIRED.");
            }
            else
            {
                // The map may annotate extra suffixes (e.g. "+acctId+moduleId[8 BE]"); the leading
                // family must match the shape derived from actual key construction.
                Assert.IsTrue(doc.Shape.StartsWith(actualShape, StringComparison.Ordinal),
                    $"{decl.Name} has key shape '{actualShape}' in source but the map documents '{doc.Shape}'.");
            }
        }

        // NO STALE ROWS: every documented declared prefix actually exists in source.
        var declaredNames = declarations.Select(decl => decl.Name).ToHashSet();
        foreach (var name in documentedByName.Keys)
        {
            Assert.IsTrue(declaredNames.Contains(name),
                $"The STORAGE PREFIX MAP documents {name}, but no such prefix is declared in source.");
        }
    }

    [TestMethod]
    public void V4ModuleRegionIsCompleteAndReserved()
    {
        string moduleProtocolSource = ReadPartial("SmartAccount.ModuleProtocol.cs");
        string allSource = ReadAllPartials();
        List<PrefixDecl> declarations = CollectDeclarations();

        // The v4 region 0x50-0x5E is declared in ModuleProtocol.cs — the protocol constants
        // file owns the whole module-model state layout (spec §7.1).
        var expectedV4 = new (byte Value, string Name)[]
        {
            (0x50, "Prefix_ProtocolInfo"),
            (0x51, "Prefix_AccountControl"),
            (0x52, "Prefix_ModuleInstance"),
            (0x53, "Prefix_ModuleIndex"),
            (0x54, "Prefix_HookOrder"),
            (0x55, "Prefix_ConfigIntent"),
            (0x56, "Prefix_NonceCursor"),
            (0x57, "Prefix_MessageSubject"),
            (0x58, "Prefix_ApplicationContext"),
            (0x59, "Prefix_CoreRecovery"),
            (0x5A, "Prefix_MigrationState"),
            (0x5B, "Prefix_ThresholdPolicy"),
            (0x5C, "Prefix_NonceNamespace"),
            (0x5D, "Prefix_MarketControlEpoch"),
            (0x5E, "Prefix_ConfigIntentIndex"),
        };

        var declared = declarations.ToDictionary(decl => decl.Value, decl => decl.Name);
        foreach (var (value, name) in expectedV4)
        {
            Assert.IsTrue(declared.TryGetValue(value, out string? actual) && actual == name,
                $"The v4 region byte 0x{value:X2} must be declared as {name} (found " +
                $"{(declared.TryGetValue(value, out var found) ? found : "nothing")}).");
            StringAssert.Contains(moduleProtocolSource, $"{name} = new byte[] {{ 0x{value:X2} }}",
                $"{name} must be declared in SmartAccount.ModuleProtocol.cs.");
        }

        // 0x5F is permanently reserved: never declared anywhere.
        Assert.IsFalse(declarations.Exists(decl => decl.Value == 0x5F),
            "0x5F is the reserved v4-region byte and must never be declared.");

        // Retired-and-undeclared legacy bytes stay permanently reserved: the F-1/F-7 fixes
        // retired verifyScopeTarget (0x1C) and the config-context pointers (0x04/0x05)
        // WITHOUT keeping declarations — reintroducing them must fail here.
        foreach (byte retired in new byte[] { 0x04, 0x05, 0x1C })
        {
            Assert.IsFalse(declarations.Exists(decl => decl.Value == retired),
                $"Retired byte 0x{retired:X2} must never be re-declared.");
        }

        // All v4-region prefixes are actually exercised (none is a bare reserved pin).
        foreach (var (_, name) in expectedV4)
        {
            Assert.IsNotNull(DeriveShape(name, allSource),
                $"{name} is a v4-region prefix and must be used in real storage key construction.");
        }
    }

    [TestMethod]
    public void ActivePrefixMapUsesUniqueMarketEscrowAllocation()
    {
        string marketSource = ReadPartial("SmartAccount.MarketEscrow.cs");

        StringAssert.Contains(marketSource, "globally unique",
            "MarketEscrow.cs must document that its active prefix is globally unique.");
        // Design-phase rule: no pre-renumbering storage row is kept readable. The escrow
        // latch lives at 0x1D alone; a legacy sibling would be dead code, so the partial
        // must neither document nor implement one.
        Assert.IsFalse(marketSource.Contains("legacy 0x13"),
            "MarketEscrow.cs must not carry a legacy 0x13 compatibility read/delete path.");
        Assert.IsFalse(marketSource.Contains("0x13"),
            "MarketEscrow.cs must not touch any prefix other than its declared active ones.");
    }
}
