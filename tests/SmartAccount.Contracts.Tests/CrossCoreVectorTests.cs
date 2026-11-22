using System;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Native;
using Neo.VM;
using VmArray = Neo.VM.Types.Array;
using VmByteString = Neo.VM.Types.ByteString;
using VmInteger = Neo.VM.Types.Integer;
using VmStackItem = Neo.VM.Types.StackItem;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Cross-kernel equality for the module protocol v4 (docs/SA-MODULE-PROTOCOL.md
/// §16). The native kernel pins <c>smartaccount-v4-vectors.json</c> in
/// <c>tests/SmartAccount.Native.Tests</c>; this suite pins the same file from the
/// custom kernel, so one vector set is asserted by both kernels instead of each
/// kernel carrying its own idea of the published bytes.
///
/// The vector file is produced by <c>generate-smartaccount-v4-vectors.py</c>,
/// which derives every value from the specification alone. Two of its claims are
/// kernel independent and are asserted here directly:
/// <list type="bullet">
/// <item>the account identity, because the §16.1 domain binds custody and salt
/// only — the core hash is not an input;</item>
/// <item>the canonical thirteen-field operation bytes, because §4.2 serialises
/// the same field list in both kernels.</item>
/// </list>
/// The operation digest is deliberately <em>not</em> equal across kernels: §4.3
/// mixes the executing core hash into the domain, so each kernel signs its own
/// account address space. The digest is therefore checked by reconstructing it
/// from the vector's canonical bytes and the deployed core's own identity, which
/// proves the custom kernel serialises the operation identically — the digest
/// cannot match unless the bytes it hashes match, field for field.
///
/// The §7 storage layout is the third cross-kernel obligation: the same
/// (prefix, key length) table must hold, otherwise a migrated account's rows are
/// invisible to one kernel and visible to the other.
/// </summary>
[TestClass]
public class CrossCoreVectorTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly JsonElement Vectors = LoadVectors();

    /// <summary>The thirteen-field operation the vector file pins, in its
    /// canonical form: the signature field is blanked before serialisation. The
    /// vector pins authorityEpoch 1 and credentialGeneration 1, the smallest
    /// generation the 1-based §4.1 field admits, so the same bytes are both the
    /// published shape and a registration-valid envelope.</summary>
    private static VmArray CanonicalOperation(
        UInt160 target, byte[] nonceSubkey, BigInteger generation) => new([
            new VmInteger(4), target.ToArray(), "ping", new VmArray(),
            new VmInteger(0), new VmByteString(nonceSubkey), new VmInteger(1_700_000_000_000),
            new VmInteger(0), new VmInteger(generation), new VmInteger(1), new VmInteger(0),
            VmByteString.Empty, new VmArray(),
        ]);

    /// <summary>The same operation as the marshalled <c>object[]</c> the ABI
    /// accepts. The signature must be non-empty on the wire; the kernel blanks it
    /// before hashing, so it never reaches the serialised bytes.</summary>
    private static object[] OperationArguments(
        UInt160 target, byte[] nonceSubkey, BigInteger generation) => [
            4, target.ToArray(), "ping", Array.Empty<object>(),
            (BigInteger)0, nonceSubkey, (BigInteger)1_700_000_000_000,
            (BigInteger)0, generation, (BigInteger)1, (BigInteger)0,
            Enumerable.Repeat((byte)0x11, 64).ToArray(), Array.Empty<object>(),
        ];

    private static JsonElement LoadVectors()
    {
        string path = Path.Combine(RepoRoot, "tests", "SmartAccount.Native.Tests",
            "TestFile", "smartaccount-v4-vectors.json");
        Assert.IsTrue(File.Exists(path), $"missing shared vector file {path}");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.Clone();
    }

    private static string Text(string name) => Vectors.GetProperty(name).GetString()!;

    private static byte[] UInt64Be(BigInteger value) =>
        Enumerable.Range(0, 8).Reverse().Select(i => (byte)(value >> (8 * i))).ToArray();

    /// <summary>§4.3 domain, reproduced from the vector's own canonical bytes and
    /// the deployed core's identity.</summary>
    private static byte[] ExpectedDigest(TestIdentity identity, BigInteger generation, byte[] canonical)
    {
        byte[] domain = Encoding.UTF8.GetBytes("NeoSmartAccount/UserOperation")
            .Concat([(byte)4])
            .Concat(BitConverter.GetBytes(identity.Network))
            .Concat(identity.Core.ToArray())
            .Concat(identity.Account.ToArray())
            .Concat(UInt64Be(0))              // validatorId
            .Concat(UInt64Be(generation))     // credentialGeneration
            .Concat(UInt64Be(1))              // authorityEpoch — pinned by the vector
            .Concat(UInt64Be(0))              // configurationNonce
            .ToArray();
        return SHA256.HashData(domain.Concat(canonical).ToArray());
    }

    private readonly record struct TestIdentity(UInt160 Core, UInt160 Account, uint Network);

    private static TestIdentity CreateVectorAccount(out RuntimeFixture fixture)
    {
        fixture = new RuntimeFixture();
        UInt160 core = fixture.Deploy("SmartAccount");
        UInt160 custody = UInt160.Parse(Text("custody"));
        byte[] salt = Convert.FromHexString(Text("salt"));
        UInt160 account = fixture.CreateAccount(core, custody, salt, RuntimeFixture.MinRecoveryTimelockMs);
        return new TestIdentity(core, account, fixture.Engine.ProtocolSettings.Network);
    }

    [TestMethod]
    public void SharedVectorIdentityIsDerivedByTheCustomKernel()
    {
        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 custody = UInt160.Parse(Text("custody"));
        byte[] salt = Convert.FromHexString(Text("salt"));
        // §16.1 binds custody and salt only, so the custom kernel must reach the
        // account id the independent derivation published.
        UInt160 expected = UInt160.Parse(Text("accountId"));
        Assert.AreEqual(expected, fx.CallUInt160(core, "computeAccountIdentity", custody, salt),
            "custom kernel identity drifted from the shared vector");
        // Registration recomputes the same identity, so a kernel that accepted a
        // different id would have failed here.
        Assert.AreEqual(expected, fx.CreateAccount(core, custody, salt, RuntimeFixture.MinRecoveryTimelockMs),
            "registration accepted an account id the vector does not publish");
    }

    [TestMethod]
    public void CanonicalOperationBytesAreIdenticalInBothKernels()
    {
        TestIdentity identity = CreateVectorAccount(out RuntimeFixture fx);
        UInt160 target = UInt160.Parse(Text("serviceHash"));
        byte[] nonceSubkey = new byte[32];
        string published = Vectors.GetProperty("operation").GetProperty("canonical").GetString()!;

        // (a) The oracle this test uses is the native kernel's serialiser: it must
        // reproduce the published bytes for the published shape. Without this the
        // comparison below could agree with a shared mistake.
        string oracle = Convert.ToHexStringLower(BinarySerializer.Serialize(
            CanonicalOperation(target, nonceSubkey, 1), ExecutionEngineLimits.Default));
        Assert.AreEqual(published, oracle,
            "Neo.VM binary serialisation drifted from the published canonical operation");

        // (b) The published shape is already registration-valid: §4.1 makes the
        // credential generation 1-based and the vector pins 1, so the digest below
        // pins every byte of the vector against the deployed core's own identity.
        const int generation = 1;
        byte[] canonical = BinarySerializer.Serialize(
            CanonicalOperation(target, nonceSubkey, generation), ExecutionEngineLimits.Default);
        byte[] expected = ExpectedDigest(identity, generation, canonical);
        byte[] actual = fx.CallBytes(identity.Core, "getOperationDigest", identity.Account,
            OperationArguments(target, nonceSubkey, generation));
        Assert.AreEqual(Convert.ToHexStringLower(expected), Convert.ToHexStringLower(actual),
            "custom kernel canonical operation bytes or §4.3 domain diverged from the native kernel");
    }

    /// <summary>§7 key table: prefix, total length and account tail. The native
    /// kernel pins the same table in
    /// <c>UT_SmartAccountProtocol.StorageKeysArePrefixedFixedWidthAndDomainSeparated</c>.</summary>
    [TestMethod]
    public void AccountStorageKeysFollowTheSharedPrefixTable()
    {
        TestIdentity identity = CreateVectorAccount(out RuntimeFixture fx);
        // StorageKey.Id is the ContractManagement-assigned id, not the hash.
        VmArray state = (VmArray)fx.Call(NativeContract.ContractManagement.Hash, "getContract", identity.Core);
        Assert.IsTrue(state.Count > 0, "core is not deployed");
        int contractId = (int)state[0].GetInteger();
        var observed = fx.Engine.Storage.Snapshot
            .Find(new StorageKey { Id = contractId })
            .Select(entry => entry.Key.Key.ToArray())
            .Where(key => key.Length >= 1 && key[0] is >= 0x50 and <= 0x5E)
            .ToList();

        Assert.IsFalse(observed.Count == 0, "registration wrote no §7 rows");
        Assert.IsTrue(observed.Any(key => key[0] == 0x51 && key.Length == 21),
            "registration must write the 0x51 account control row");

        // prefix -> (key length, carries account id at [1..21])
        foreach (byte[] key in observed)
        {
            if (key[0] == 0x57 && key.Length == 22)
            {
                Assert.AreEqual((byte)1, key[21], "Only the internal custody-provenance suffix is defined.");
                CollectionAssert.AreEqual(identity.Account.ToArray(), key[1..21]);
                CollectionAssert.AreEqual(new byte[] { 1 }, fx.Engine.Storage.Snapshot[
                    new StorageKey { Id = contractId, Key = key }].Value.ToArray());
                continue;
            }
            int length = key[0] switch
            {
                0x50 => 1,   // protocol info: global, no account
                0x51 => 21,  // account control
                0x52 => 29,  // module instance
                0x53 => 30,  // module index: account, type code, module id
                0x54 => 21,  // hook order
                0x55 => 29,  // configuration intent
                0x56 => 45,  // nonce cursor: account, 24-byte channel
                0x57 => 21,  // message subject
                0x58 => 21,  // application context
                0x59 => 21,  // core recovery
                0x5A => 21,  // migration state
                0x5B => 29,  // threshold policy
                0x5C => 45,  // nonce namespace
                0x5D => 21,  // market control epoch
                0x5E => 21,  // configuration intent index
                _ => throw new AssertFailedException($"prefix {key[0]:X2} outside the §7 table"),
            };
            Assert.AreEqual(length, key.Length,
                $"prefix {key[0]:X2} must be {length} bytes, saw {key.Length}");
            if (key[0] != 0x50)
            {
                Assert.AreEqual(Convert.ToHexStringLower(identity.Account.ToArray()),
                    Convert.ToHexStringLower(key[1..21]),
                    $"prefix {key[0]:X2} must be scoped to the account id");
            }
            if (key[0] == 0x53)
            {
                Assert.IsTrue(key[21] is 1 or 4,
                    $"module index type code must be 1 (validator) or 4 (hook), saw {key[21]}");
            }
        }
    }
}
