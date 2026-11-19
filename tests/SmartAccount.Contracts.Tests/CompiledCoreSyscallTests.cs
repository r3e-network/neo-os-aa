using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.VM;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Checks the public and private PLATFORM artifacts, independently of the TestEngine interop table.
/// </summary>
[TestClass]
public class CompiledCoreSyscallTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledContractsDir = Path.Combine(RepoRoot, "contracts", "bin", "public");

    private static uint InteropHash(string name) =>
        BinaryPrimitives.ReadUInt32LittleEndian(SHA256.HashData(Encoding.ASCII.GetBytes(name)));

    private static readonly uint GasBounded = InteropHash("System.Contract.CallWithGasLimit");

    private static readonly uint Unbounded = InteropHash("System.Contract.Call");

    /// <summary>
    /// Every SYSCALL in the artifact's script with the last printable string pushed before it. At a
    /// dynamic call that string is the target method name, because the compiler pushes the method
    /// name immediately before the contract hash and the syscall.
    /// </summary>
    private static List<(uint Hash, string Method, OpCode Flags, int Offset)> Syscalls(string artifact)
    {
        NefFile nef = NefFile.Parse(File.ReadAllBytes(Path.Combine(CompiledContractsDir, artifact + ".nef")), verify: true);
        Script script = new(nef.Script);
        List<(uint, string, OpCode, int)> sites = new();
        string lastString = string.Empty;
        OpCode previous = OpCode.NOP;
        OpCode flags = OpCode.NOP;
        for (int ip = 0; ip < script.Length;)
        {
            Instruction instruction = script.GetInstruction(ip);
            if (instruction.OpCode == OpCode.PUSHDATA1 || instruction.OpCode == OpCode.PUSHDATA2 || instruction.OpCode == OpCode.PUSHDATA4)
            {
                ReadOnlySpan<byte> data = instruction.Operand.Span;
                if (data.Length > 0 && data.Length < 64 && data.ToArray().All(b => b >= 0x20 && b < 0x7f))
                {
                    lastString = Encoding.ASCII.GetString(data);
                    flags = previous;
                }
            }

            if (instruction.OpCode == OpCode.SYSCALL)
                sites.Add((instruction.TokenU32, lastString, flags, ip));
            previous = instruction.OpCode;
            ip += instruction.Size;
        }

        return sites;
    }

    private static (int Start, int End) MethodRange(string artifact, string methodName)
    {
        NefFile nef = NefFile.Parse(File.ReadAllBytes(Path.Combine(CompiledContractsDir, artifact + ".nef")), verify: true);
        ContractManifest manifest = ContractManifest.Parse(
            File.ReadAllText(Path.Combine(CompiledContractsDir, artifact + ".manifest.json")));
        ContractMethodDescriptor method = manifest.Abi.Methods.Single(m => m.Name == methodName);
        int end = manifest.Abi.Methods
            .Where(m => m.Offset > method.Offset)
            .Select(m => m.Offset)
            .DefaultIfEmpty(nef.Script.Length)
            .Min();
        return (method.Offset, end);
    }

    private static List<int> CallTargets(string artifact, string methodName)
    {
        NefFile nef = NefFile.Parse(File.ReadAllBytes(Path.Combine(CompiledContractsDir, artifact + ".nef")), verify: true);
        Script script = new(nef.Script);
        (int start, int end) = MethodRange(artifact, methodName);
        List<int> targets = new();
        for (int ip = start; ip < end;)
        {
            Instruction instruction = script.GetInstruction(ip);
            if (instruction.OpCode == OpCode.CALL_L)
                targets.Add(ip + instruction.Size +
                    BinaryPrimitives.ReadInt32LittleEndian(instruction.Operand.Span));
            ip += instruction.Size;
        }
        return targets;
    }

    /// <summary>
    /// End (first RET) of the helper body that starts at <paramref name="start"/>, or null when the
    /// offset is not an instruction boundary: a CALL_L target can also be a data island (the compiler
    /// jumps over inline buffers), and decoding there would throw.
    /// </summary>
    private static int? TryFirstReturnOffset(string artifact, int start)
    {
        NefFile nef = NefFile.Parse(File.ReadAllBytes(Path.Combine(CompiledContractsDir, artifact + ".nef")), verify: true);
        Script script = new(nef.Script);
        if (start < 0 || start >= script.Length)
            return null;
        try
        {
            for (int ip = start; ip < script.Length;)
            {
                Instruction instruction = script.GetInstruction(ip);
                if (instruction.OpCode == OpCode.RET)
                    return ip;
                ip += instruction.Size;
            }
        }
        catch (BadScriptException)
        {
            // Not a helper: skip the target.
        }

        return null;
    }

    /// <summary>
    /// The CALL_L helpers an ABI method reaches directly, with the SYSCALL sites inside
    /// each helper's address range up to its first RET.
    /// </summary>
    private static (int Target, (uint Hash, string Method, OpCode Flags, int Offset)[] Sites)[] Helpers(
        string artifact, string methodName)
    {
        return CallTargets(artifact, methodName)
            .Distinct()
            .Select(target => (Target: target, End: TryFirstReturnOffset(artifact, target)))
            .Where(helper => helper.End.HasValue)
            .Select(helper => (helper.Target, Sites: Syscalls(artifact)
                .Where(site => site.Offset >= helper.Target && site.Offset <= helper.End!.Value)
                .ToArray()))
            .ToArray();
    }

    [TestMethod]
    public void PublicCoreNeverEmitsTheGasBoundedSyscall()
    {
        var syscalls = Syscalls("SmartAccount");

        Assert.AreEqual(0, syscalls.Count(s => s.Hash == GasBounded),
            "Public builds must never emit CallWithGasLimit");
        Assert.IsTrue(syscalls.Count(s => s.Hash == Unbounded) > 0,
            "The public artifact still needs ordinary contract calls for target execution and public module paths");
    }

    [TestMethod]
    public void MessageSignatureAdaptersUseTheProfileSpecificVerifierCall()
    {
        // v4 folds the ERC-1271 adapter into a fail-closed wrapper
        // (isValidSignature -> try IsValidSignatureCore catch invalid magic) and the
        // single module callback lives in that helper, so the ABI method itself owns
        // no syscall site: the profile split must be proven on the helper.
        var publicRange = MethodRange("SmartAccount", "isValidSignature");
        var publicSites = Syscalls("SmartAccount")
            .Where(site => site.Offset >= publicRange.Start && site.Offset < publicRange.End)
            .ToArray();
        Assert.AreEqual(0, publicSites.Count(site => site.Hash == Unbounded || site.Hash == GasBounded),
            "The public ERC-1271 adapter is a wrapper and must not call a verifier directly");

        var publicHelpers = Helpers("SmartAccount", "isValidSignature")
            .Where(helper => helper.Sites.Any(site => site.Hash == Unbounded))
            .ToArray();
        Assert.AreEqual(1, publicHelpers.Length,
            "The public ERC-1271 verifier helper must be unambiguous");
        Assert.AreEqual(1, publicHelpers[0].Sites.Count(site => site.Hash == Unbounded),
            "The public ERC-1271 helper must issue exactly one ordinary verifier callback");
        Assert.AreEqual(0, publicHelpers[0].Sites.Count(site => site.Hash == GasBounded),
            "The public ERC-1271 helper must not emit CallWithGasLimit");

        const string platformArtifact = "../platform/SmartAccount";
        var platformRange = MethodRange(platformArtifact, "isValidSignature");
        var platformSites = Syscalls(platformArtifact)
            .Where(site => site.Offset >= platformRange.Start && site.Offset < platformRange.End)
            .ToArray();
        Assert.AreEqual(0, platformSites.Count(site =>
                site.Hash == GasBounded || site.Hash == Unbounded),
            "The PLATFORM ERC-1271 adapter must route its verifier call through a helper");

        var platformHelpers = Helpers(platformArtifact, "isValidSignature")
            .Where(helper => helper.Sites.Any(site => site.Hash == GasBounded))
            .ToArray();
        Assert.AreEqual(1, platformHelpers.Length,
            "PLATFORM ERC-1271 has an ambiguous gas-bounded verifier helper");
        var selected = platformHelpers[0];
        Assert.AreEqual(1, selected.Sites.Count(site => site.Hash == GasBounded),
            "The PLATFORM ERC-1271 helper must contain exactly one shared gas-bounded call");
        Assert.AreEqual(0, selected.Sites.Count(site => site.Hash == Unbounded),
            "The PLATFORM ERC-1271 helper must not mix call profiles");
    }

    [TestMethod]
    public void PlatformCoreEmitsTheGasBoundedCallSurface()
    {
        var syscalls = Syscalls("../platform/SmartAccount");
        // v4 funnels every module callback (validation, hooks, completion, lifecycle) and
        // the ERC-1271 verifier through the single CallModuleGasCapped helper, so the
        // artifact has one gas-bounded drain plus nccs' extern-declaration stub. The v3
        // per-path helpers (verifier, leaf and composite-root maintenance) are gone.
        Assert.AreEqual(2, syscalls.Count(s => s.Hash == GasBounded));
    }

    [TestMethod]
    public void NoOtherCompiledContractEmitsTheGasBoundedSyscall()
    {
        string[] nefs = Directory.EnumerateFiles(CompiledContractsDir, "*.nef", SearchOption.AllDirectories).ToArray();
        Assert.IsTrue(nefs.Length >= 24, "the compiled contract set is incomplete: run contracts/compile.sh");

        foreach (string nef in nefs)
        {
            string artifact = Path.GetRelativePath(CompiledContractsDir, nef)[..^".nef".Length];
            if (artifact == "SmartAccount")
                continue;

            Assert.AreEqual(
                0,
                Syscalls(artifact).Count(s => s.Hash == GasBounded),
                $"{artifact} must not depend on the platform syscall");
        }
    }
}
