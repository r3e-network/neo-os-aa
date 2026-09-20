using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// The frontend Studio renders contract source to users from a checked-in copy under
/// <c>frontend/src/assets/contracts</c>, loaded by <c>frontend/src/features/studio/contractSources.js</c>.
/// That copy is not generated at build time, so it silently drifted: at one point it still showed
/// the pre-fix <c>Verify</c> fallback that the SEV-0 proxy-witness audit removed. Every mirrored
/// file must be byte-identical to the contract it claims to show, and every file the Studio
/// loader references must exist in the mirror.
/// </summary>
[TestClass]
public class FrontendContractSourceMirrorTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string ContractsDir = Path.Combine(RepoRoot, "contracts");

    private static readonly string MirrorDir = Path.Combine(RepoRoot, "frontend", "src", "assets", "contracts");

    private static readonly string LoaderPath =
        Path.Combine(RepoRoot, "frontend", "src", "features", "studio", "contractSources.js");

    private static readonly Regex LoaderReference = new(
        @"@/assets/contracts/(?<path>[A-Za-z0-9_./-]+\.cs)\?raw",
        RegexOptions.Compiled);

    private static IEnumerable<string> MirroredFiles() =>
        Directory.EnumerateFiles(MirrorDir, "*.cs", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(MirrorDir, path).Replace('\\', '/'))
            .OrderBy(path => path, StringComparer.Ordinal);

    [TestMethod]
    public void EveryMirroredSourceIsByteIdenticalToTheContract()
    {
        string[] mirrored = MirroredFiles().ToArray();
        Assert.IsTrue(mirrored.Length > 0, "The Studio source mirror is empty; the loader would render nothing.");

        List<string> drifted = new();
        foreach (string relative in mirrored)
        {
            string source = Path.Combine(ContractsDir, relative);
            Assert.IsTrue(File.Exists(source),
                $"{relative} is mirrored for the Studio but no such contract exists under contracts/.");
            if (!File.ReadAllBytes(source).AsSpan().SequenceEqual(File.ReadAllBytes(Path.Combine(MirrorDir, relative))))
            {
                drifted.Add(relative);
            }
        }

        Assert.AreEqual(0, drifted.Count,
            "Studio source mirror has drifted from contracts/ for: " + string.Join(", ", drifted) +
            ". Copy the current contract source over frontend/src/assets/contracts/<path>.");
    }

    [TestMethod]
    public void EveryStudioLoaderReferenceExistsInTheMirror()
    {
        string loader = File.ReadAllText(LoaderPath);
        string[] referenced = LoaderReference.Matches(loader)
            .Select(match => match.Groups["path"].Value)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        Assert.IsTrue(referenced.Length > 0, "contractSources.js references no contract sources.");

        HashSet<string> mirrored = MirroredFiles().ToHashSet(StringComparer.Ordinal);
        string[] missing = referenced.Where(path => !mirrored.Contains(path)).ToArray();
        Assert.AreEqual(0, missing.Length,
            "contractSources.js references sources missing from the mirror: " + string.Join(", ", missing));
    }
}
