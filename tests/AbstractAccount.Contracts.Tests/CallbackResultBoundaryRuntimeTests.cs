using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// The callback isolation boundary serializes target results before invoking a hook/verifier.
/// NeoVM InteropInterface values (including iterators) are deliberately unsupported and must
/// fault before post callbacks, with the enclosing nonce/target writes rolled back.
/// </summary>
[TestClass]
public class CallbackResultBoundaryRuntimeTests
{
    private static readonly UInt160 Owner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private const uint EscapeTimelock = 2_592_000;

    [TestMethod]
    public void InteropIteratorTargetResultFailsClosedBeforeVerifierPostExecute()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("UnifiedSmartWalletV3");
        UInt160 verifier = fixture.Deploy("MockVerifierCore");
        UInt160 target = DeployIteratorTarget(fixture);
        byte[] emptyParams = Array.Empty<byte>();
        UInt160 accountId = fixture.CallUInt160(
            wallet,
            "computeRegistrationAccountId",
            verifier,
            emptyParams,
            UInt160.Zero,
            Owner,
            EscapeTimelock);

        fixture.SetSigners(Owner);
        fixture.CallVoid(
            wallet,
            "registerAccount",
            accountId,
            verifier,
            emptyParams,
            UInt160.Zero,
            Owner,
            EscapeTimelock);

        object[] op = RuntimeFixture.UserOp(
            target,
            "returnIterator",
            Array.Empty<object?>(),
            0,
            fixture.Now() + 3_600_000,
            Array.Empty<byte>());

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
            fixture.CallInteger(wallet, "getNonce", accountId, 0),
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
