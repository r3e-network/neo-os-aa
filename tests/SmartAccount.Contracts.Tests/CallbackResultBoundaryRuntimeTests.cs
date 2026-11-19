using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// The callback isolation boundary clones target results before invoking a hook callback
/// (v4 retired the verifier post-execute callback). NeoVM InteropInterface values (including
/// iterators) are deliberately unsupported and must fault before <c>postCheck</c>, with the
/// enclosing nonce/target writes rolled back.
/// </summary>
[TestClass]
public class CallbackResultBoundaryRuntimeTests
{
    private static readonly UInt160 Owner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    [TestMethod]
    public void InteropIteratorTargetResultFailsClosedBeforeHookPostCheck()
    {
        using P256SessionKey custodyKey = new();
        UInt160 custody = RuntimeFixture.CustodyOf(custodyKey);
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccount");
        UInt160 hook = fixture.Deploy("hooks/WhitelistHook", wallet.ToArray());
        UInt160 target = DeployIteratorTarget(fixture);
        // The hook is installed and allowed to see this target atomically, so its preCheck
        // passes and only the result-cloning boundary can fault the operation.
        UInt160 accountId = fixture.CreateAccount(
            wallet,
            custody,
            RuntimeFixture.Salt("callback-boundary"),
            RuntimeFixture.MinRecoveryTimelockMs,
            (object)fixture.InstallHook(hook, "allowTarget", target));

        object[] op = RuntimeFixture.UserOp(
            target,
            "returnIterator",
            Array.Empty<object?>(),
            fixture.PackedNonce(wallet, accountId, 0),
            fixture.Now() + 3_600_000,
            new byte[] { 0x00 },
            authorityEpoch: fixture.AccountAuthorityEpoch(wallet, accountId),
            configurationNonce: fixture.AccountConfigurationNonce(wallet, accountId));
        op[11] = fixture.SignBuiltIn(wallet, accountId, op, custodyKey);
        fixture.SetSigners(custody);

        TestException exception = Assert.ThrowsExactly<TestException>(() => fixture.CallVoid(
            wallet,
            "executeUserOp",
            accountId,
            op));

        string diagnostic = exception.ToString();
        Assert.IsTrue(
            diagnostic.Contains("serial", StringComparison.OrdinalIgnoreCase)
                || diagnostic.Contains("NotSupported", StringComparison.OrdinalIgnoreCase),
            $"Interop result must fail at serialization boundary: {diagnostic}");
        Assert.AreEqual(
            BigInteger.Zero,
            fixture.CurrentNonceSequence(wallet, accountId, 0),
            "A rejected unsupported result must roll back nonce consumption");
    }

    private static UInt160 DeployIteratorTarget(RuntimeFixture fixture)
    {
        using ScriptBuilder script = new();
        // System.Storage.Find(context, emptyPrefix, FindOptions.None). The stack is
        // arranged in reverse argument order, matching the compiler's Storage.Find lowering.
        script.EmitPush(BigInteger.Zero);
        script.EmitPush(Array.Empty<byte>());
        script.EmitSysCall(ApplicationEngine.System_Storage_GetContext.Hash);
        script.EmitSysCall(ApplicationEngine.System_Storage_Find.Hash);
        script.Emit(OpCode.RET);

        NefFile nef = new()
        {
            Compiler = "Callback result boundary test fixture",
            Source = "",
            Tokens = [],
            Script = script.ToArray()
        };
        nef.CheckSum = NefFile.ComputeChecksum(nef);
        ContractManifest manifest = new()
        {
            Name = "IteratorResultTarget",
            Groups = [],
            SupportedStandards = [],
            Permissions = [],
            Trusts = WildcardContainer<ContractPermissionDescriptor>.Create(),
            Abi = new ContractAbi
            {
                Methods =
                [
                    new ContractMethodDescriptor
                    {
                        Name = "returnIterator",
                        Offset = 0,
                        ReturnType = ContractParameterType.Any,
                        Safe = false,
                        Parameters = []
                    }
                ],
                Events = []
            }
        };
        return fixture.DeployArtifact(nef.ToArray(), manifest.ToJson().ToString());
    }
}
