using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.SmartContract;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Reads the compiled AA core under <c>contracts/bin/v3</c> and checks which syscall each verifier
/// callback is compiled to. The contract declares <c>System.Contract.CallWithGasLimit</c> itself,
/// so which framework package is restored cannot change what is emitted; this pins the result at
/// the bytecode level, independent of which Neo core the TestEngine runs.
/// </summary>
[TestClass]
public class CompiledCoreSyscallTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledContractsDir = Path.Combine(RepoRoot, "contracts", "bin", "v3");

    private static readonly uint GasBounded =
        PlatformSyscallRequirement.InteropHash(PlatformSyscallRequirement.CallWithGasLimit);

    private static readonly uint Unbounded = PlatformSyscallRequirement.InteropHash("System.Contract.Call");

    /// <summary>
    /// Every SYSCALL in the artifact's script with the last printable string pushed before it. At a
    /// dynamic call that string is the target method name, because the compiler pushes the method
    /// name immediately before the contract hash and the syscall.
    /// </summary>
    private static List<(uint Hash, string Method)> Syscalls(string artifact)
    {
        NefFile nef = NefFile.Parse(File.ReadAllBytes(Path.Combine(CompiledContractsDir, artifact + ".nef")), verify: true);
        Script script = new(nef.Script);
        List<(uint, string)> sites = new();
        string lastString = string.Empty;
        for (int ip = 0; ip < script.Length;)
        {
            Instruction instruction = script.GetInstruction(ip);
            if (instruction.OpCode == OpCode.PUSHDATA1 || instruction.OpCode == OpCode.PUSHDATA2 || instruction.OpCode == OpCode.PUSHDATA4)
            {
                ReadOnlySpan<byte> data = instruction.Operand.Span;
                if (data.Length > 0 && data.Length < 64 && data.ToArray().All(b => b >= 0x20 && b < 0x7f))
                    lastString = Encoding.ASCII.GetString(data);
            }

            if (instruction.OpCode == OpCode.SYSCALL)
                sites.Add((instruction.TokenU32, lastString));
            ip += instruction.Size;
        }

        return sites;
    }

    [TestMethod]
    public void CompiledCoreCallsEachVerifierCallbackThroughTheGasBoundedSyscall()
    {
        List<(uint Hash, string Method)> syscalls = Syscalls("UnifiedSmartWalletV3");

        // validateSignature and postExecute are the two verifier callbacks; each is one bounded call.
        Assert.AreEqual(1, syscalls.Count(s => s.Hash == GasBounded && s.Method == "validateSignature"));
        Assert.AreEqual(1, syscalls.Count(s => s.Hash == GasBounded && s.Method == "postExecute"));

        // The unbounded call must never reach the verifier's signature check.
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
