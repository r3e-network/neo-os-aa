using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.SmartContract;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Checks the public and private PLATFORM artifacts, independently of the TestEngine interop table.
/// </summary>
[TestClass]
public class CompiledCoreSyscallTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledContractsDir = Path.Combine(RepoRoot, "contracts", "bin", "v3");

    private static uint InteropHash(string name) =>
        BinaryPrimitives.ReadUInt32LittleEndian(SHA256.HashData(Encoding.ASCII.GetBytes(name)));

    private static readonly uint GasBounded = InteropHash("System.Contract.CallWithGasLimit");

    private static readonly uint Unbounded = InteropHash("System.Contract.Call");

    /// <summary>
    /// Every SYSCALL in the artifact's script with the last printable string pushed before it. At a
    /// dynamic call that string is the target method name, because the compiler pushes the method
    /// name immediately before the contract hash and the syscall.
    /// </summary>
    private static List<(uint Hash, string Method, OpCode Flags)> Syscalls(string artifact)
    {
        NefFile nef = NefFile.Parse(File.ReadAllBytes(Path.Combine(CompiledContractsDir, artifact + ".nef")), verify: true);
        Script script = new(nef.Script);
        List<(uint, string, OpCode)> sites = new();
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
                sites.Add((instruction.TokenU32, lastString, flags));
            previous = instruction.OpCode;
            ip += instruction.Size;
        }

        return sites;
    }

    [TestMethod]
    public void PublicCoreUsesOnlyPublishedSyscallsForVerifierCallbacks()
    {
        var syscalls = Syscalls("UnifiedSmartWalletV3");

        Assert.AreEqual(0, syscalls.Count(s => s.Hash == GasBounded),
            "Public builds must never emit CallWithGasLimit");
        Assert.AreEqual(1, syscalls.Count(s => s.Hash == Unbounded && s.Method == "validateSignature"));
        Assert.AreEqual(OpCode.PUSH5, syscalls.Single(s => s.Hash == Unbounded && s.Method == "validateSignature").Flags,
            "Signature validation must be read-only (CallFlags.ReadOnly = 5)");
        Assert.AreEqual(2, syscalls.Count(s => s.Hash == Unbounded && s.Method == "postExecute"),
            "Both the hook and verifier retain their post-execution callback");
        Assert.IsTrue(syscalls.Where(s => s.Hash == Unbounded && s.Method == "postExecute").All(s => s.Flags == OpCode.PUSH15),
            "Post-execution accounting retains CallFlags.All = 15");
    }

    [TestMethod]
    public void PlatformCoreKeepsBothGasBoundedVerifierCallbacks()
    {
        var syscalls = Syscalls("../platform/UnifiedSmartWalletV3");
        // nccs also emits the extern declaration's stub, besides the two inlined callback sites.
        Assert.AreEqual(OpCode.PUSH5, syscalls.Single(s => s.Hash == GasBounded && s.Method == "validateSignature").Flags);
        Assert.AreEqual(OpCode.PUSH15, syscalls.Single(s => s.Hash == GasBounded && s.Method == "postExecute").Flags);
        Assert.AreEqual(0, syscalls.Count(s => s.Hash == Unbounded && s.Method == "validateSignature"));
    }

    [TestMethod]
    public void NoOtherCompiledContractEmitsTheGasBoundedSyscall()
    {
        string[] nefs = Directory.EnumerateFiles(CompiledContractsDir, "*.nef", SearchOption.AllDirectories).ToArray();
        Assert.IsTrue(nefs.Length >= 24, "the compiled contract set is incomplete: run contracts/compile.sh");

        foreach (string nef in nefs)
        {
            string artifact = Path.GetRelativePath(CompiledContractsDir, nef)[..^".nef".Length];
            if (artifact == "UnifiedSmartWalletV3")
                continue;

            Assert.AreEqual(
                0,
                Syscalls(artifact).Count(s => s.Hash == GasBounded),
                $"{artifact} must not depend on the platform syscall");
        }
    }
}
