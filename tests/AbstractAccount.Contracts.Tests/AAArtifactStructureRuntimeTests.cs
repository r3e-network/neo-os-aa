using System;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Executable structural checks for the locally compiled AA NEF/manifest pairs.
/// Neo's strict VM decoder validates instructions; ABI checks must match the
/// runtime dispatch key and require actual instruction-boundary entry points.
///
/// These checks are not a compiler certificate or a mechanized refinement proof.
/// Full C# compiler and NeoVM semantics remain outside their scope.
/// </summary>
[TestClass]
public class AAArtifactStructureRuntimeTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledContractsDir =
        Path.Combine(RepoRoot, "contracts", "bin", "v3");

    [TestMethod]
    public void EveryCompiledArtifactHasStrictVmAndAbiEntryPoints()
    {
        string[] nefFiles = Directory.GetFiles(CompiledContractsDir, "*.nef", SearchOption.AllDirectories);
        Assert.IsTrue(nefFiles.Length > 0, "No compiled artifacts were found");

        int methodCount = 0;
        foreach (string nefPath in nefFiles.OrderBy(path => path, StringComparer.Ordinal))
        {
            string manifestPath = Path.ChangeExtension(nefPath, ".manifest.json");
            Assert.IsTrue(File.Exists(manifestPath), $"Missing manifest for {nefPath}");

            methodCount += ValidateArtifact(File.ReadAllBytes(nefPath), File.ReadAllText(manifestPath));
        }

        Assert.IsTrue(methodCount > 0, "The artifact structure check found no ABI methods");
    }

    [TestMethod]
    public void CSharpPublicAbiProjectsToCompiledCoreManifest()
    {
        string nefPath = Path.Combine(CompiledContractsDir, "UnifiedSmartWalletV3.nef");
        string manifestPath = Path.ChangeExtension(nefPath, ".manifest.json");
        ContractManifest manifest = ContractManifest.Parse(File.ReadAllText(manifestPath));
        MethodInfo[] sourceMethods = typeof(AbstractAccount.UnifiedSmartWallet)
            .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Where(method => !method.Name.StartsWith("add_", StringComparison.Ordinal) &&
                !method.Name.StartsWith("remove_", StringComparison.Ordinal))
            .OrderBy(method => method.Name, StringComparer.Ordinal)
            .ThenBy(method => method.GetParameters().Length)
            .ToArray();

        string[] sourceKeys = sourceMethods
            .Select(method => $"{ToAbiName(method.Name)}/{method.GetParameters().Length}")
            .ToArray();
        string[] manifestKeys = manifest.Abi.Methods
            .Select(method => $"{method.Name}/{method.Parameters.Length}")
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToArray();

        string[] expectedManifestKeys = sourceKeys
            .Append("_initialize/0")
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToArray();
        CollectionAssert.AreEqual(
            manifestKeys,
            expectedManifestKeys,
            "The compiled core ABI must contain exactly the public static C# method set plus compiler initialization");

        ContractMethodDescriptor initializer = manifest.Abi.Methods.Single(method =>
            method.Name == "_initialize" && method.Parameters.Length == 0);
        Assert.AreEqual(ContractParameterType.Void, initializer.ReturnType,
            "The generated initializer must not return a value");
        Assert.IsFalse(initializer.Safe,
            "The generated initializer must not be exposed as a safe/read-only method");

        foreach (MethodInfo sourceMethod in sourceMethods)
        {
            string abiName = ToAbiName(sourceMethod.Name);
            ContractMethodDescriptor[] matches = manifest.Abi.Methods
                .Where(method => method.Name == abiName &&
                    method.Parameters.Length == sourceMethod.GetParameters().Length)
                .ToArray();
            Assert.AreEqual(1, matches.Length, $"Missing unique ABI descriptor for {sourceMethod}");
            ContractMethodDescriptor descriptor = matches[0];

            Type[] sourceParameterTypes = sourceMethod.GetParameters()
                .Select(parameter => parameter.ParameterType)
                .ToArray();
            for (int i = 0; i < sourceParameterTypes.Length; i++)
            {
                Assert.AreEqual(
                    ToNeoType(sourceParameterTypes[i]),
                    descriptor.Parameters[i].Type,
                    $"Parameter {i} of {sourceMethod.Name} changed during compilation");
            }

            Assert.AreEqual(
                ToNeoType(sourceMethod.ReturnType),
                descriptor.ReturnType,
                $"Return type of {sourceMethod.Name} changed during compilation");

            bool sourceSafe = sourceMethod.GetCustomAttributes(inherit: false)
                .Any(attribute => attribute.GetType().Name == "SafeAttribute");
            Assert.AreEqual(sourceSafe, descriptor.Safe, $"Safe flag of {sourceMethod.Name} changed during compilation");
        }
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public void SameNameAndArityCannotBeOverloadedByTypes(bool changeParameterType)
    {
        string nefPath = Directory.GetFiles(CompiledContractsDir, "*.nef")[0];
        var manifest = ContractManifest.Parse(File.ReadAllText(Path.ChangeExtension(nefPath, ".manifest.json")));
        var original = manifest.Abi.Methods.First(method => method.Parameters.Length > 0);
        var duplicate = ContractMethodDescriptor.FromJson(original.ToJson());
        if (changeParameterType)
            duplicate.Parameters[0].Type = original.Parameters[0].Type == ContractParameterType.Boolean
                ? ContractParameterType.Integer : ContractParameterType.Boolean;
        else
            duplicate.ReturnType = original.ReturnType == ContractParameterType.Boolean
                ? ContractParameterType.Integer : ContractParameterType.Boolean;
        manifest.Abi.Methods = [.. manifest.Abi.Methods, duplicate];

        Assert.ThrowsExactly<AssertFailedException>(() =>
            ValidateArtifact(File.ReadAllBytes(nefPath), manifest.ToJson().ToString()));
    }

    [TestMethod]
    public void StrictDecoderRejectsEntryPointInsideOperand()
    {
        // The embedded RET byte is data, not an executable entry point.
        Script script = new(new byte[] { (byte)OpCode.PUSHDATA1, 1, (byte)OpCode.RET, (byte)OpCode.RET }, strictMode: true);
        Assert.IsNotNull(script.GetInstruction(3));
        Assert.ThrowsExactly<ArgumentException>(() => script.GetInstruction(2));
    }

    [TestMethod]
    public void StrictDecoderRejectsTruncatedInstruction()
    {
        Assert.ThrowsExactly<BadScriptException>(() =>
            new Script(new byte[] { (byte)OpCode.PUSHDATA1, 2, (byte)OpCode.RET }, strictMode: true));
    }

    [TestMethod]
    public void ArtifactParserRejectsChecksumCorruption()
    {
        string nefPath = Directory.GetFiles(CompiledContractsDir, "*.nef")[0];
        byte[] bytes = File.ReadAllBytes(nefPath);
        bytes[^1] ^= 1;
        Assert.ThrowsExactly<FormatException>(() =>
            ValidateArtifact(bytes, File.ReadAllText(Path.ChangeExtension(nefPath, ".manifest.json"))));
    }

    [TestMethod]
    [DataRow("magic-high-bit")]
    [DataRow("reserved-byte")]
    [DataRow("reserved-word-low")]
    [DataRow("reserved-word-high")]
    [DataRow("script-trailer")]
    public void RecomputedChecksumDoesNotMakeMalformedNefValid(string mutation)
    {
        // Minimal canonical NEF: empty compiler/source/tokens, one RET opcode.
        byte[] body = new byte[75];
        body[0] = (byte)'N';
        body[1] = (byte)'E';
        body[2] = (byte)'F';
        body[3] = (byte)'3';
        body[73] = 1;
        body[74] = (byte)OpCode.RET;
        byte[] WithChecksum(byte[] payload) =>
            [.. payload, .. SHA256.HashData(SHA256.HashData(payload)).Take(4)];
        Assert.AreEqual(1, NefFile.Parse(WithChecksum(body), verify: true).Script.Length);

        switch (mutation)
        {
            case "magic-high-bit":
                for (int index = 0; index < 4; index++) body[index] |= 0x80;
                break;
            case "reserved-byte": body[69] = 1; break;
            case "reserved-word-low": body[71] = 1; break;
            case "reserved-word-high": body[72] = 1; break;
            case "script-trailer": body = [.. body, (byte)OpCode.RET]; break;
            default: throw new ArgumentOutOfRangeException(nameof(mutation));
        }

        // The local provenance parser must reject the same malformed frames;
        // hashing arbitrary bytes must not be treated as a native parse proof.
        Assert.ThrowsExactly<FormatException>(() => NefFile.Parse(WithChecksum(body), verify: true));
    }

    private static int ValidateArtifact(byte[] nefBytes, string manifestJson)
    {
        NefFile nef = NefFile.Parse(nefBytes, verify: true);
        Script script = new(nef.Script, strictMode: true);
        ContractManifest manifest = ContractManifest.Parse(manifestJson);
        var descriptors = manifest.Abi.Methods;
        // Neo dispatches ABI methods by name and arity. Parameter and return
        // types are not part of the dispatch key and must not create an
        // overload that the runtime cannot distinguish.
        var keys = descriptors.Select(method => $"{method.Name}/{method.Parameters.Length}")
            .ToArray();

        Assert.AreEqual(keys.Length, keys.Distinct(StringComparer.Ordinal).Count(),
            "Duplicate typed ABI method");
        foreach (var method in descriptors)
        {
            Assert.IsTrue(method.Offset >= 0 && method.Offset < script.Length,
                $"ABI method {method.Name} has an out-of-range offset");
            Instruction instruction = script.GetInstruction(method.Offset);
            Assert.IsNotNull(instruction,
                $"ABI method {method.Name} does not resolve to a NeoVM instruction");
        }
        return descriptors.Length;
    }

    private static string ToAbiName(string sourceName) =>
        sourceName == "_deploy" || sourceName == "_initialize"
            ? sourceName
            : char.ToLowerInvariant(sourceName[0]) + sourceName[1..];

    private static ContractParameterType ToNeoType(Type type)
    {
        if (type == typeof(void)) return ContractParameterType.Void;
        if (type == typeof(bool)) return ContractParameterType.Boolean;
        if (type == typeof(string)) return ContractParameterType.String;
        if (type == typeof(BigInteger) || type == typeof(uint)) return ContractParameterType.Integer;
        if (type == typeof(UInt160) || type.FullName == "Neo.SmartContract.Framework.UInt160")
            return ContractParameterType.Hash160;
        if (type == typeof(UInt256) || type.FullName == "Neo.SmartContract.Framework.UInt256")
            return ContractParameterType.Hash256;
        if (type == typeof(Neo.SmartContract.Framework.ByteString)) return ContractParameterType.ByteArray;
        if (type.IsArray) return ContractParameterType.Array;
        if (type == typeof(object) || type.Name == "UserOperation") return ContractParameterType.Any;
        Assert.Fail($"Unhandled public ABI type {type.FullName}");
        return ContractParameterType.Any;
    }
}
