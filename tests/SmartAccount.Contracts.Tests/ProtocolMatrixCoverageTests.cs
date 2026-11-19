using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Makes README section 3 of <c>tests/fixtures/sa-module-protocol/</c>
/// machine-checked through <c>matrix.json</c>.
///
/// The design report promises that every kernel-matrix row (F-1..F-17, M-1..M-6)
/// points at a passing driver. This suite turns that promise into a build gate:
/// a row may not disappear, may not be listed twice, may not name a test that
/// was renamed or deleted, may not name a fixture that no longer exists, and a
/// <c>partial</c> row must say in its note which part of the invariant this
/// repository cannot pin. The matrix and the README table are checked together
/// so the prose cannot drift away from the machine-checked form.
/// </summary>
[TestClass]
public class ProtocolMatrixCoverageTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string FixtureRoot =
        Path.Combine(RepoRoot, "tests", "fixtures", "sa-module-protocol");

    private static readonly string NativeTestsRoot =
        Path.Combine(RepoRoot, "tests", "SmartAccount.Native.Tests");

    private static readonly string[] ExpectedIds = Enumerable
        .Range(1, 17).Select(i => "F-" + i)
        .Concat(Enumerable.Range(1, 6).Select(i => "M-" + i))
        .ToArray();

    private static readonly string[] KnownStatuses = { "pinned", "partial" };

    private sealed class MatrixRow
    {
        public string Id { get; init; } = "";
        public string Invariant { get; init; } = "";
        public string Status { get; init; } = "";
        public string? Fixture { get; init; }
        public IReadOnlyList<string> Custom { get; init; } = Array.Empty<string>();
        public IReadOnlyList<string> Native { get; init; } = Array.Empty<string>();
        public string Note { get; init; } = "";
    }

    // ---------------------------------------------------------------- helpers

    private static List<MatrixRow> LoadRows()
    {
        string path = Path.Combine(FixtureRoot, "matrix.json");
        Assert.IsTrue(File.Exists(path), $"missing matrix {path}");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement root = document.RootElement;

        List<MatrixRow> rows = new();
        foreach (JsonElement row in root.GetProperty("rows").EnumerateArray())
        {
            rows.Add(new MatrixRow
            {
                Id = row.GetProperty("id").GetString() ?? "",
                Invariant = row.GetProperty("invariant").GetString() ?? "",
                Status = row.GetProperty("status").GetString() ?? "",
                Fixture = row.TryGetProperty("fixture", out JsonElement fixture)
                    && fixture.ValueKind == JsonValueKind.String
                        ? fixture.GetString()
                        : null,
                Custom = ReadStringArray(row, "custom"),
                Native = ReadStringArray(row, "native"),
                Note = row.TryGetProperty("note", out JsonElement note)
                    ? note.GetString() ?? ""
                    : "",
            });
        }

        return rows;
    }

    private static IReadOnlyList<string> ReadStringArray(JsonElement row, string name)
    {
        if (!row.TryGetProperty(name, out JsonElement element)
            || element.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        return element.EnumerateArray()
            .Select(entry => entry.GetString() ?? "")
            .ToArray();
    }

    private static string[] ReadNativeTestSources()
    {
        Assert.IsTrue(Directory.Exists(NativeTestsRoot),
            $"missing native test project {NativeTestsRoot}");
        return Directory.GetFiles(NativeTestsRoot, "*.cs", SearchOption.AllDirectories)
            .Select(path => File.ReadAllText(path))
            .ToArray();
    }

    // ------------------------------------------------------------------ tests

    [TestMethod]
    public void MatrixCoversExactlyTheDocumentedRows()
    {
        List<MatrixRow> rows = LoadRows();

        CollectionAssert.AreEquivalent(
            ExpectedIds,
            rows.Select(row => row.Id).ToArray(),
            "matrix.json must list F-1..F-17 and M-1..M-6 exactly once");
        Assert.AreEqual(ExpectedIds.Length, rows.Count);

        foreach (MatrixRow row in rows)
        {
            Assert.IsFalse(string.IsNullOrWhiteSpace(row.Invariant),
                $"{row.Id}: invariant is empty");
            CollectionAssert.Contains(KnownStatuses, row.Status,
                $"{row.Id}: unknown status '{row.Status}'");
            Assert.AreNotEqual(0, row.Custom.Count,
                $"{row.Id}: a row must name at least one custom driver");
        }
    }

    [TestMethod]
    public void EveryCustomReferenceResolvesToAMarkedTest()
    {
        Assembly assembly = typeof(ProtocolMatrixCoverageTests).Assembly;
        List<string> failures = new();

        foreach (MatrixRow row in LoadRows())
        {
            foreach (string reference in row.Custom)
            {
                int split = reference.LastIndexOf('.');
                if (split <= 0 || split == reference.Length - 1)
                {
                    failures.Add($"{row.Id}: '{reference}' is not a Class.Method reference");
                    continue;
                }

                string typeName = reference.Substring(0, split);
                string methodName = reference.Substring(split + 1);
                Type? type = assembly.GetType(
                    typeof(ProtocolMatrixCoverageTests).Namespace + "." + typeName,
                    throwOnError: false);
                if (type is null)
                {
                    failures.Add($"{row.Id}: '{reference}' names a missing test class");
                    continue;
                }

                MethodInfo? method = type
                    .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
                    .FirstOrDefault(candidate => candidate.Name == methodName);
                if (method is null)
                {
                    failures.Add($"{row.Id}: '{reference}' names a missing test method");
                    continue;
                }

                if (!method.GetCustomAttributes(typeof(TestMethodAttribute), true).Any())
                {
                    failures.Add($"{row.Id}: '{reference}' is not marked [TestMethod]");
                }
            }
        }

        Assert.AreEqual(0, failures.Count,
            "matrix rows must point at running tests:" + Environment.NewLine
            + string.Join(Environment.NewLine, failures));
    }

    [TestMethod]
    public void EveryNativeReferenceResolvesInTheNativeTestSources()
    {
        string[] sources = ReadNativeTestSources();
        List<string> failures = new();

        foreach (MatrixRow row in LoadRows())
        {
            foreach (string reference in row.Native)
            {
                int split = reference.LastIndexOf('.');
                if (split <= 0 || split == reference.Length - 1)
                {
                    failures.Add($"{row.Id}: '{reference}' is not a Class.Method reference");
                    continue;
                }

                string typeName = reference.Substring(0, split);
                string methodName = reference.Substring(split + 1);
                Regex declaresClass = new(@"(?m)^\s*(?:public|internal)\s+(?:sealed\s+|partial\s+)*class\s+"
                    + Regex.Escape(typeName) + @"\b");
                Regex declaresMethod = new(@"public\s+(?:async\s+)?[\w<>\[\]\.]+\s+"
                    + Regex.Escape(methodName) + @"\s*\(");

                bool resolved = sources.Any(source =>
                    declaresClass.IsMatch(source) && declaresMethod.IsMatch(source));
                if (!resolved)
                {
                    failures.Add($"{row.Id}: '{reference}' does not resolve in tests/SmartAccount.Native.Tests");
                }
            }
        }

        Assert.AreEqual(0, failures.Count,
            "native matrix references must resolve:" + Environment.NewLine
            + string.Join(Environment.NewLine, failures));
    }

    [TestMethod]
    public void EveryNamedFixtureExists()
    {
        foreach (MatrixRow row in LoadRows())
        {
            if (string.IsNullOrWhiteSpace(row.Fixture))
            {
                continue;
            }

            string path = Path.Combine(FixtureRoot, row.Fixture!.Replace('/', Path.DirectorySeparatorChar));
            Assert.IsTrue(File.Exists(path), $"{row.Id}: missing fixture {row.Fixture}");
        }
    }

    [TestMethod]
    public void PartialRowsExplainWhatCannotBePinned()
    {
        foreach (MatrixRow row in LoadRows())
        {
            if (row.Status != "partial")
            {
                continue;
            }

            Assert.IsFalse(string.IsNullOrWhiteSpace(row.Note),
                $"{row.Id}: a partial row must name the part this repository cannot pin");
        }
    }

    [TestMethod]
    public void ReadmeSection3AgreesWithTheMatrix()
    {
        string readme = File.ReadAllText(Path.Combine(FixtureRoot, "README.md"));

        StringAssert.Contains(readme, "matrix.json",
            "README section 3 must point at its machine-checked form");

        foreach (string id in ExpectedIds)
        {
            int listed = Regex.Matches(readme, @"\|\s*" + Regex.Escape(id) + @"\s*\|").Count;
            Assert.AreEqual(1, listed,
                $"README section 3 must list {id} exactly once (found {listed})");
        }
    }
}
