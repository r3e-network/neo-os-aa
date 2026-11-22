using System;
using System.Collections.Generic;
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
using Neo.SmartContract.Testing.Exceptions;
using Neo.VM;
using VmArray = Neo.VM.Types.Array;
using VmByteString = Neo.VM.Types.ByteString;
using VmInteger = Neo.VM.Types.Integer;
using VmStackItem = Neo.VM.Types.StackItem;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Consumes <c>tests/fixtures/sa-module-protocol/</c>: the golden vectors are
/// produced by <c>generate-vectors.py</c> from the specification alone, so a
/// value pinned here is never derived by the code under test.
///
/// Every vector carries the git blob sha of the two shared constants files it
/// was generated against (<c>constantsRevision</c>). When a constant changes the
/// vector is regenerated, not edited; a stale pin then fails loudly here instead
/// of silently agreeing with itself.
/// </summary>
[TestClass]
public class ProtocolFixtureTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string FixtureRoot =
        Path.Combine(RepoRoot, "tests", "fixtures", "sa-module-protocol");

    private static readonly string GoldenRoot = Path.Combine(FixtureRoot, "golden-vectors");

    private static readonly string ContractsTestsRoot =
        Path.Combine(RepoRoot, "tests", "SmartAccount.Contracts.Tests");

    // ---------------------------------------------------------------- helpers

    private static JsonElement Load(params string[] relative)
    {
        string path = Path.Combine(new[] { FixtureRoot }.Concat(relative).ToArray());
        Assert.IsTrue(File.Exists(path), $"missing fixture {path}");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.Clone();
    }

    private static JsonElement LoadGolden(string name) =>
        Load("golden-vectors", name + ".json");

    private static string Hex(JsonElement element, string name) =>
        element.GetProperty(name).GetString()!;

    private static byte[] Bytes(JsonElement element, string name) =>
        Convert.FromHexString(Hex(element, name));

    private static byte[] U64Be(BigInteger value) =>
        Enumerable.Range(0, 8).Reverse().Select(i => (byte)(value >> (8 * i))).ToArray();

    private static string Lower(byte[] bytes) => Convert.ToHexStringLower(bytes);

    /// <summary>A UInt160 display string is the big-endian form; the bytes the
    /// kernels concatenate are the reversal.</summary>
    private static byte[] RawFromDisplay(string display) =>
        Convert.FromHexString(display.Replace("0x", "", StringComparison.Ordinal)).Reverse().ToArray();

    /// <summary>The vector's argument list, as the VM stack items it encodes.</summary>
    private static VmArray ArgumentItems(JsonElement args)
    {
        VmArray items = new();
        foreach (JsonElement argument in args.EnumerateArray())
        {
            items.Add(argument.ValueKind == JsonValueKind.String
                ? new VmByteString(Convert.FromHexString(argument.GetString()!))
                : new VmInteger(argument.GetInt64()));
        }
        return items;
    }

    /// <summary>The same argument list as the marshalled <c>object[]</c> the ABI takes.</summary>
    private static object[] ArgumentValues(JsonElement args) =>
        args.EnumerateArray().Select(argument => argument.ValueKind == JsonValueKind.String
            ? (object)Convert.FromHexString(argument.GetString()!)
            : (object)(BigInteger)argument.GetInt64()).ToArray();

    // ------------------------------------------------------------- constants

    /// <summary>The 13-field operation the envelope vector pins, in canonical
    /// (signature-blanked) form.</summary>
    private static VmArray CanonicalOperation(JsonElement operation)
    {
        VmArray hookProofs = new();
        return new VmArray([
            new VmInteger(operation.GetProperty("version").GetInt64()),
            new VmByteString(RawFromDisplay(Hex(operation, "target"))),
            operation.GetProperty("method").GetString()!,
            ArgumentItems(operation.GetProperty("args")),
            new VmInteger(operation.GetProperty("nonce").GetInt64()),
            new VmByteString(Convert.FromHexString(Hex(operation, "nonceSubkey"))),
            new VmInteger(operation.GetProperty("deadline").GetInt64()),
            new VmInteger(operation.GetProperty("validatorId").GetInt64()),
            new VmInteger(operation.GetProperty("credentialGeneration").GetInt64()),
            new VmInteger(operation.GetProperty("authorityEpoch").GetInt64()),
            new VmInteger(operation.GetProperty("configurationNonce").GetInt64()),
            VmByteString.Empty,
            hookProofs,
        ]);
    }

    /// <summary>The same operation as the marshalled <c>object[]</c> the ABI takes.</summary>
    private static object[] OperationArguments(JsonElement operation)
    {
        BigInteger Integer(string name) => operation.GetProperty(name).GetInt64();
        return [
            Integer("version"),
            RawFromDisplay(Hex(operation, "target")),
            operation.GetProperty("method").GetString()!,
            ArgumentValues(operation.GetProperty("args")),
            Integer("nonce"),
            Convert.FromHexString(Hex(operation, "nonceSubkey")),
            Integer("deadline"),
            Integer("validatorId"),
            Integer("credentialGeneration"),
            Integer("authorityEpoch"),
            Integer("configurationNonce"),
            Convert.FromHexString(Hex(operation, "signature")),
            Array.Empty<object>(),
        ];
    }

    private static UInt160 IdentityAccount(RuntimeFixture fx, UInt160 core, JsonElement input,
        out UInt160 custody, out byte[] salt)
    {
        custody = UInt160.Parse(Hex(input, "custody"));
        salt = Bytes(input, "salt");
        return fx.CreateAccount(core, custody, salt, RuntimeFixture.MinRecoveryTimelockMs);
    }

    private static List<byte[]> AccountRows(RuntimeFixture fx, UInt160 core)
    {
        VmArray contract = (VmArray)fx.Call(NativeContract.ContractManagement.Hash, "getContract", core);
        Assert.IsTrue(contract.Count > 0, "core is not deployed");
        int contractId = (int)contract[0].GetInteger();
        return fx.Engine.Storage.Snapshot
            .Find(new StorageKey { Id = contractId })
            .Select(entry => entry.Key.Key.ToArray())
            .ToList();
    }

    // --------------------------------------------------------- operation-envelope

    [TestMethod]
    public void OperationEnvelopeMatchesThePinnedBytesAndDigest()
    {
        JsonElement vector = LoadGolden("operation-envelope");
        JsonElement input = vector.GetProperty("input");
        JsonElement operation = input.GetProperty("operation");
        JsonElement expected = vector.GetProperty("expected");
        JsonElement custom = expected.GetProperty("native");
        JsonElement native = expected.GetProperty("native");

        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 account = IdentityAccount(fx, core, input, out UInt160 custody, out byte[] salt);

        // §16.1 identity is kernel independent: custody + salt, no core hash.
        Assert.AreEqual(Hex(input, "accountId"),
            fx.CallUInt160(core, "computeAccountIdentity", custody, salt).ToString());
        Assert.AreEqual(Hex(input, "accountId"), account.ToString());

        // A digest only means something against a named core on a named chain.
        Assert.AreEqual(Hex(custom, "coreHash"), core.ToString());
        Assert.AreEqual((uint)custom.GetProperty("network").GetInt64(), fx.Engine.ProtocolSettings.Network);

        // §4.2: the canonical unsigned bytes are kernel independent.
        VmArray operationArray = CanonicalOperation(operation);
        byte[] canonical = BinarySerializer.Serialize(operationArray, ExecutionEngineLimits.Default);
        Assert.AreEqual(Hex(expected, "canonicalUnsignedOperationHex"), Lower(canonical),
            "canonical operation bytes drifted from the pinned vector");
        Assert.AreEqual(Hex(expected, "canonicalUnsignedOperationHex"),
            Hex(expected.GetProperty("equality"), "customStdLibSerializeHex"));
        Assert.AreEqual(Hex(expected, "canonicalUnsignedOperationHex"),
            Hex(expected.GetProperty("equality"), "nativeBinarySerializerHex"));

        // §4.3: the custom kernel must hash exactly these bytes under exactly this domain.
        Assert.AreEqual(Hex(custom, "domainHex"), Lower(
            CustomDomain(RawFromDisplay(Hex(custom, "coreHash")),
                RawFromDisplay(Hex(input, "accountId")),
                (uint)custom.GetProperty("network").GetInt64(), operation)));
        Assert.AreEqual(Hex(custom, "digestHex"), Lower(fx.CallBytes(core, "getOperationDigest",
            account, OperationArguments(operation))));

        // The native half of the same vector is asserted by the native suite
        // (UT_SmartAccountEnvelope/UT_SmartAccountProtocol); here it is only
        // reproduced so a wrong pin cannot survive in this file.
        Assert.AreEqual(Hex(native, "domainHex"), Lower(
            CustomDomain(RawFromDisplay(Hex(native, "coreHash")),
                RawFromDisplay(Hex(input, "accountId")),
                (uint)native.GetProperty("network").GetInt64(), operation)));
        Assert.AreEqual(Hex(native, "digestHex"),
            Lower(SHA256.HashData(Convert.FromHexString(Hex(native, "domainHex"))
                .Concat(canonical).ToArray())));
    }

    private static byte[] CustomDomain(byte[] coreRaw, byte[] accountRaw, uint network,
        JsonElement operation)
    {
        BigInteger Integer(string name) => operation.GetProperty(name).GetInt64();
        return Encoding.UTF8.GetBytes("NeoSmartAccount/UserOperation")
            .Concat([(byte)4])
            .Concat(BitConverter.GetBytes(network))
            .Concat(coreRaw)
            .Concat(accountRaw)
            .Concat(U64Be(Integer("validatorId")))
            .Concat(U64Be(Integer("credentialGeneration")))
            .Concat(U64Be(Integer("authorityEpoch")))
            .Concat(U64Be(Integer("configurationNonce")))
            .ToArray();
    }

    /// <summary>F-1/§4.1: a 12- or 14-field envelope is rejected before anything
    /// else reads it.</summary>
    [TestMethod]
    public void OperationFieldCountOtherThanThirteenIsRejected()
    {
        JsonElement vector = LoadGolden("operation-envelope");
        object[] canonical = OperationArguments(vector.GetProperty("input").GetProperty("operation"));
        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 account = IdentityAccount(fx, core, vector.GetProperty("input"),
            out _, out _);

        foreach (object[] mutated in new[]
        {
            canonical[..12],
            canonical.Concat([new object[0]]).ToArray(),
        })
        {
            TestException fault = Assert.ThrowsExactly<TestException>(() =>
                fx.CallBytes(core, "getOperationDigest", account, mutated));
            StringAssert.Contains(fault.Message, "SA_OPERATION_FIELD_COUNT");
        }
    }

    // ------------------------------------------------------------ nonce-channel

    [TestMethod]
    public void NonceChannelMatchesThePinnedDerivation()
    {
        JsonElement vector = LoadGolden("nonce-channel");
        JsonElement input = vector.GetProperty("input");
        JsonElement expected = vector.GetProperty("expected").GetProperty("native");

        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 account = fx.CreateAccount(core,
            UInt160.Parse("0x202122232425262728292a2b2c2d2e2f30313233"),
            Convert.FromHexString("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"),
            RuntimeFixture.MinRecoveryTimelockMs);
        Assert.AreEqual(Hex(input, "accountId"), account.ToString());

        // The kernel's own answer for the channel it derives.
        BigInteger packed = fx.CallInteger(core, "getNonce", account,
            (BigInteger)input.GetProperty("validatorId").GetInt64(), Bytes(input, "nonceSubkey"));
        Assert.AreEqual(expected.GetProperty("packedNonce").GetString(), packed.ToString(),
            "getNonce drifted from the pinned packed nonce");

        // The derivation itself, recomputed from the pinned preimage.
        byte[] preimage = Convert.FromHexString(Hex(expected, "derivationPreimageHex"));
        Assert.AreEqual(Hex(expected, "fullDigestHex"), Lower(SHA256.HashData(preimage)));
        byte[] digest = SHA256.HashData(preimage);
        byte[] channel = [(byte)(digest[8] & 0x7F), .. digest[9..32]];
        Assert.AreEqual(Hex(expected, "channelBytesHex"), Lower(channel),
            "the 191-bit channel is the low bits of the namespace digest");

        // §7.1: the cursor and namespace keys are prefix || accountId || channel.
        byte[] accountRaw = account.ToArray();
        Assert.AreEqual(Hex(expected, "nonceCursorKeyBytes"),
            Lower([0x56, .. accountRaw, .. channel]));
        Assert.AreEqual(Hex(expected, "nonceNamespaceKeyBytes"),
            Lower([0x5C, .. accountRaw, .. channel]));

        // The native kernel derives its own channel for its own core hash; the
        // pinned value is the cross-kernel obligation and is asserted by the
        // native suite. Reproducing it here keeps the pin honest.
        JsonElement native = vector.GetProperty("expected").GetProperty("native");
        byte[] nativeDigest = SHA256.HashData(Convert.FromHexString(Hex(native, "derivationPreimageHex")));
        Assert.AreEqual(Hex(native, "fullDigestHex"), Lower(nativeDigest));
    }

    // ------------------------------------------------------------- storage-keys

    [TestMethod]
    public void StorageKeysFollowTheSharedPrefixTable()
    {
        JsonElement vector = LoadGolden("storage-keys");
        JsonElement expected = vector.GetProperty("expected");
        JsonElement keys = expected.GetProperty("keys");
        JsonElement lengths = expected.GetProperty("lengths");
        JsonElement input = vector.GetProperty("input");
        BigInteger moduleId = input.GetProperty("moduleId").GetInt64();

        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 validator = fx.Deploy("validators/NeoWitnessValidator", (object)core.ToArray());
        UInt160 account = fx.CreateAccount(core,
            UInt160.Parse("0x202122232425262728292a2b2c2d2e2f30313233"),
            Convert.FromHexString("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"),
            RuntimeFixture.MinRecoveryTimelockMs, (object)fx.InstallValidator(validator));
        Assert.AreEqual(Hex(input, "accountId"), account.ToString(),
            "the vector account is custody+salt, independent of the initial actions");
        // The pin names module 1; the kernel must allocate 1 for the first install.
        Assert.AreEqual(moduleId,
            fx.ModuleIds(core, account, RuntimeFixture.ModuleTypeNameValidator)[0]);

        var pinned = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (JsonProperty property in keys.EnumerateObject())
            pinned[property.Name] = property.Value.GetString()!;

        // The 0x57 prefix carries two distinct rows and they must not be
        // conflated: the canonical subject record is 0x57 || accountId (21
        // bytes, pinned in `keys`), while registration also writes the internal
        // custody-provenance marker 0x57 || accountId || 0x01 (22 bytes, pinned
        // in `subjectProvenance`). Widening the canonical row to 22 bytes would
        // redefine the subject store, so the two shapes are asserted separately.
        JsonElement provenance = expected.GetProperty("subjectProvenance");
        string provenanceKeyHex = Hex(provenance, "key");
        int provenanceLength = provenance.GetProperty("length").GetInt32();
        string provenanceSuffix = Hex(provenance, "markerSuffixHex");
        Assert.AreEqual(21 + provenanceSuffix.Length / 2, provenanceLength,
            "the provenance marker is the 21-byte subject key plus its marker byte");

        List<byte[]> rows = AccountRows(fx, core);
        byte[] accountRaw = account.ToArray();
        var observedPrefixes = new HashSet<byte>();
        var observedWidths = new Dictionary<byte, HashSet<int>>();
        bool sawCanonicalSubject = false;
        bool sawProvenance = false;
        foreach (byte[] key in rows)
        {
            string name = $"0x{key[0]:X2}";
            if (!pinned.TryGetValue(name, out string? pinnedKey))
                continue;  // legacy rows (0x01/0x11/...) are outside the 0x50 region
            observedPrefixes.Add(key[0]);
            if (!observedWidths.TryGetValue(key[0], out HashSet<int>? widths))
                observedWidths[key[0]] = widths = [];
            widths.Add(key.Length);

            if (key[0] == 0x57 && key.Length == provenanceLength)
            {
                Assert.AreEqual(provenanceLength, provenanceKeyHex.Length / 2,
                    "0x57 provenance pinned key width drifted");
                Assert.AreEqual(Lower(accountRaw), Lower(key[1..21]),
                    "0x57 provenance marker must be scoped to the raw account id");
                Assert.AreEqual(provenanceSuffix, Lower(key[21..]),
                    "0x57 provenance marker suffix drifted");
                sawProvenance = true;
                continue;
            }

            Assert.AreEqual((int)lengths.GetProperty(name).GetInt64(), key.Length,
                $"{name} must be written with the pinned fixed width");
            // Registrations differ in module id only through the suffix; the
            // pinned key is the general shape, so compare the account-scoped head
            // and the suffix width instead of the exact bytes.
            Assert.AreEqual(Lower(accountRaw), Lower(key[1..21]),
                $"{name} must be scoped to the raw account id");
            Assert.AreEqual(pinnedKey.Length / 2, key.Length,
                $"{name} pinned key width drifted");
            if (key[0] == 0x57) sawCanonicalSubject = true;
        }

        Assert.IsTrue(sawCanonicalSubject,
            "registration must write the canonical 21-byte 0x57 subject record");
        Assert.IsTrue(sawProvenance,
            "registration must write the 22-byte 0x57 custody-provenance marker");
        Assert.AreEqual(21, (int)lengths.GetProperty("0x57").GetInt64(),
            "the canonical subject record width is 21 bytes and must not be widened");
        foreach (KeyValuePair<byte, HashSet<int>> entry in observedWidths)
        {
            if (entry.Key == 0x57) continue;
            Assert.AreEqual(1, entry.Value.Count,
                $"0x{entry.Key:X2} must have exactly one documented width, saw "
                + string.Join(",", entry.Value.OrderBy(w => w)));
        }
        Assert.AreEqual(2, observedWidths[0x57].Count,
            "0x57 must expose exactly the canonical subject row and the provenance marker");

        Assert.IsTrue(observedPrefixes.IsSupersetOf(new byte[] { 0x51, 0x52, 0x53, 0x57 }),
            "registration must write account control, module instance, module index and "
            + "message subject rows; saw " +
            string.Join(",", observedPrefixes.Select(p => $"0x{p:X2}").OrderBy(s => s)));
    }

    // --------------------------------------------------------- message-envelope

    /// <summary>messageDigest := SHA256(UTF8("NeoSmartAccount/Message") || U1(4) ||
    /// U32LE(network) || coreHash || accountId || originalSender ||
    /// U64BE(validatorId) || U64BE(credentialGeneration) || U64BE(authorityEpoch) || hash).</summary>
    private static byte[] MessageDomain(byte[] coreRaw, byte[] accountRaw, byte[] senderRaw,
        uint network, JsonElement input) =>
        Encoding.UTF8.GetBytes("NeoSmartAccount/Message")
            .Concat([(byte)4])
            .Concat(BitConverter.GetBytes(network))
            .Concat(coreRaw)
            .Concat(accountRaw)
            .Concat(senderRaw)
            .Concat(U64Be(input.GetProperty("validatorId").GetInt64()))
            .Concat(U64Be(input.GetProperty("credentialGeneration").GetInt64()))
            .Concat(U64Be(input.GetProperty("authorityEpoch").GetInt64()))
            .ToArray();

    /// <summary>The §8 envelope [version, validatorId, credentialGeneration,
    /// [[script, signature], ...]], with an optional mutated pair list.</summary>
    private static object[] MessageEnvelope(JsonElement input, JsonElement expected,
        object?[]? pairs = null, BigInteger? generation = null)
    {
        object?[] actual = pairs ?? expected.GetProperty("signaturePairs").EnumerateArray()
            .Select(pair => (object?)pair.EnumerateArray()
                .Select(item => (object)Convert.FromHexString(item.GetString()!)).ToArray())
            .ToArray();
        return
        [
            (BigInteger)input.GetProperty("envelopeVersion").GetInt64(),
            (BigInteger)input.GetProperty("validatorId").GetInt64(),
            generation ?? input.GetProperty("credentialGeneration").GetInt64(),
            actual,
        ];
    }

    /// <summary>
    /// One account plus one caller. Both deploys happen before the account is
    /// created because a deploy hash is bound to the transaction sender, and
    /// account creation moves the sender to the custody key.
    /// </summary>
    private static (RuntimeFixture Fx, UInt160 Core, UInt160 Caller, UInt160 Account) MessageFixture()
    {
        JsonElement input = LoadGolden("message-envelope").GetProperty("input");
        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 caller = fx.Deploy("MockVerifierCore");
        UInt160 account = fx.CreateAccount(core, UInt160.Parse(Hex(input, "custody")),
            Bytes(input, "salt"), RuntimeFixture.MinRecoveryTimelockMs);
        return (fx, core, caller, account);
    }

    /// <summary>
    /// F-16 negative half: every rejection row of the message vector returns the
    /// failure magic. ERC-1271 is a magic surface, never a throw surface.
    /// </summary>
    // ---------------------------------------------------------------- migration

    private static readonly byte[] LegacyRowPrefix = [0x01];

    private static readonly byte[] ProtocolInfoKey = [0x50];

    /// <summary>A seeded legacy account: the five-field 0x01 row and nothing else.</summary>
    private sealed class LegacyAccount
    {
        public required RuntimeFixture Fx { get; init; }

        public required UInt160 Core { get; init; }

        public required UInt160 Account { get; init; }

        public required UInt160 BackupOwner { get; init; }

        public required int ContractId { get; init; }

        public byte[] RowKey => LegacyRowPrefix.Concat(Account.GetSpan().ToArray()).ToArray();

        public bool HasLegacyRow =>
            Fx.Engine.Storage.Snapshot.TryGet(
                new StorageKey { Id = ContractId, Key = RowKey }) != null;
    }

    private static int ContractId(RuntimeFixture fx, UInt160 contract)
    {
        VmArray record = (VmArray)fx.Call(NativeContract.ContractManagement.Hash, "getContract", contract);
        Assert.IsTrue(record.Count > 0, "core is not deployed");
        return (int)record[0].GetInteger();
    }

    /// <summary>
    /// Seeds the state the in-place core update leaves behind for one legacy
    /// account (spec §14): the five-field 0x01 row, plus the 0x50 {4, open}
    /// record the update itself writes. Both payloads are produced by the VM's
    /// own <c>StdLib.serialize</c>, so what is pinned is the core's legacy
    /// decoder, not a host-side encoder choice.
    /// </summary>
    private static LegacyAccount LegacyMigrationFixture(JsonElement input, bool migrationModeOpen)
    {
        JsonElement row = input.GetProperty("legacyRow");
        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 backupOwner = UInt160.Parse(Hex(input, "backupOwner"));
        UInt160 account = fx.CallUInt160(core, "computeAccountIdentity",
            backupOwner, Bytes(input, "salt"));
        Assert.AreEqual(Hex(input, "accountId"), account.ToString(),
            "the legacy fixture account is the pinned identity");

        int contractId = ContractId(fx, core);
        byte[] legacyRow = fx.CallBytes(fx.StdLibHash, "serialize", (object)new object?[]
        {
            UInt160.Parse(Hex(row, "verifier")),
            UInt160.Parse(Hex(row, "hookId")),
            backupOwner,
            (BigInteger)row.GetProperty("escapeTimelockSeconds").GetInt64(),
            (BigInteger)row.GetProperty("escapeTriggeredAt").GetInt64(),
        });
        fx.Engine.Storage.Snapshot.Add(
            new StorageKey { Id = contractId, Key = LegacyRowPrefix.Concat(account.GetSpan().ToArray()).ToArray() },
            new StorageItem(legacyRow));

        if (migrationModeOpen)
        {
            JsonElement record = input.GetProperty("protocolRecord");
            byte[] info = fx.CallBytes(fx.StdLibHash, "serialize", (object)new object?[]
            {
                (BigInteger)record[0].GetInt64(),
                record[1].GetBoolean(),
            });
            fx.Engine.Storage.Snapshot.Add(
                new StorageKey { Id = contractId, Key = ProtocolInfoKey }, new StorageItem(info));
        }

        return new LegacyAccount
        {
            Fx = fx,
            Core = core,
            Account = account,
            BackupOwner = backupOwner,
            ContractId = contractId,
        };
    }

    private static VmArray MigrationRecord(LegacyAccount account) =>
        (VmArray)account.Fx.Call(account.Core, "getMigrationState", account.Account);

    private static VmArray AccountRecord(LegacyAccount account) =>
        (VmArray)account.Fx.Call(account.Core, "getAccount", account.Account);

    /// <summary>[ActionMigrateAccount, manifestDigest32, classification]</summary>
    private static object[] MigrateAction(JsonElement input, string classification,
        string digest = "manifestDigest") =>
    [
        new object[]
        {
            RuntimeFixture.ActionMigrateAccount,
            Bytes(input, digest),
            input.GetProperty(classification).GetString()!,
        },
    ];

    private static string HexOf(VmStackItem item) => Lower(item.GetSpan().ToArray());

    private static string TextOf(VmStackItem item) => item.GetString();

    /// <summary>
    /// M-1/M-3/M-4/M-6: the §14 state machine a keeper and an owner drive after
    /// the in-place update — inert while the mode is closed, marked into
    /// MigrationRequired, imported through the 24h migration intent, then
    /// idempotent for the same manifest digest and rejected for a different one.
    /// </summary>
    [TestMethod]
    public void MigrationStateMachineMatchesThePinnedVector()
    {
        JsonElement vector = LoadGolden("migration");
        JsonElement input = vector.GetProperty("input");
        JsonElement expected = vector.GetProperty("expected");
        JsonElement inert = expected.GetProperty("inertBeforeUpdate");
        JsonElement unmarked = expected.GetProperty("unmarked");
        JsonElement marked = expected.GetProperty("marked");
        JsonElement imported = expected.GetProperty("imported");

        // ---- 1. inert before the update opens migration mode ----------------
        LegacyAccount closed = LegacyMigrationFixture(input, migrationModeOpen: false);
        Assert.AreEqual(inert.GetProperty("migrationRequired").GetBoolean(),
            closed.Fx.CallBoolean(closed.Core, "isMigrationRequired", closed.Account),
            "a legacy account is not flagged while migration mode is closed");
        Assert.AreEqual(inert.GetProperty("accountStatus").GetInt64(),
            (long)AccountRecord(closed)[1].GetInteger(),
            "the read-only descriptor already reports MigrationRequired");

        // Execution authorization is the gate that fails closed; the digest
        // query is only the cheapest way to reach it.
        object[] operation = OperationArguments(
            LoadGolden("operation-envelope").GetProperty("input").GetProperty("operation"));
        TestException unmigrated = Assert.ThrowsExactly<TestException>(() =>
            closed.Fx.CallBytes(closed.Core, "getOperationDigest", closed.Account, operation));
        Assert.AreEqual("SA_MIGRATION_REQUIRED", Hex(expected, "executionWhileUnmigratedError"),
            "the fail-closed gate reports the migration code for an unmigrated account");
        StringAssert.Contains(unmigrated.Message, Hex(expected, "executionWhileUnmigratedError"));

        // The keeper mark is the update's per-account step: it needs the mode.
        TestException closedMark = Assert.ThrowsExactly<TestException>(() =>
            closed.Fx.CallVoid(closed.Core, "markMigrationRequired", closed.Account));
        StringAssert.Contains(closedMark.Message, Hex(expected, "markWhileModeClosedError"));

        // ---- 2. open migration mode: required, but not yet marked -----------
        LegacyAccount account = LegacyMigrationFixture(input, migrationModeOpen: true);
        RuntimeFixture fx = account.Fx;
        UInt160 core = account.Core;
        Assert.IsTrue(fx.CallBoolean(core, "isMigrationRequired", account.Account));

        VmArray before = MigrationRecord(account);
        Assert.AreEqual(unmarked.GetProperty("migrationRecordStatus").GetInt64(), (long)before[0].GetInteger());
        Assert.AreEqual(unmarked.GetProperty("legacyModuleCount").GetInt64(), (long)before[3].GetInteger(),
            "the 0x01 verifier pointer is counted as one legacy module");
        Assert.AreEqual(unmarked.GetProperty("accountStatus").GetInt64(),
            (long)AccountRecord(account)[1].GetInteger());

        BigInteger epochBefore = AccountRecord(account)[4].GetInteger();
        BigInteger nonceBefore = AccountRecord(account)[5].GetInteger();

        // ---- 3. permissionless keeper mark ----------------------------------
        fx.CallVoid(core, "markMigrationRequired", account.Account);
        VmArray requiredState = fx.SingleNotificationState(core, Hex(expected.GetProperty("events"), "required"));
        Assert.AreEqual(account.Account, new UInt160(requiredState[0].GetSpan()));
        Assert.AreEqual(marked.GetProperty("legacyModuleCount").GetInt64(), (long)requiredState[1].GetInteger());

        VmArray afterMark = MigrationRecord(account);
        Assert.AreEqual(marked.GetProperty("migrationRecordStatus").GetInt64(), (long)afterMark[0].GetInteger());
        Assert.AreEqual(new string('0', 64), HexOf(afterMark[1]),
            "the mark pins no manifest: the owner states it in the import");
        Assert.AreEqual(string.Empty, TextOf(afterMark[2]));
        Assert.AreEqual(marked.GetProperty("legacyModuleCount").GetInt64(), (long)afterMark[3].GetInteger());
        Assert.AreEqual(marked.GetProperty("legacyScopeInvalidated").GetBoolean(), afterMark[4].GetBoolean(),
            "retirement of the legacy pointers is declared, never implied");
        Assert.AreEqual(marked.GetProperty("accountStatus").GetInt64(),
            (long)AccountRecord(account)[1].GetInteger());

        // A second sweep is a no-op: no second transition, no second event.
        fx.CallVoid(core, "markMigrationRequired", account.Account);
        Assert.AreEqual(0, fx.LastNotifications.Count(
            n => n.EventName == Hex(expected.GetProperty("events"), "required")));
        Assert.AreEqual((long)afterMark[0].GetInteger(), (long)MigrationRecord(account)[0].GetInteger());

        // ---- 4. interrupted migration: proposing imports nothing -------------
        object[] migrate = MigrateAction(input, "classification");
        fx.SetSigners(account.BackupOwner);
        BigInteger intentId = fx.ProposeConfiguration(core, account.Account, account.BackupOwner, migrate);
        Assert.IsTrue(fx.CallBoolean(core, "isMigrationRequired", account.Account),
            "a pending import never widens authorization");
        Assert.AreEqual(marked.GetProperty("migrationRecordStatus").GetInt64(),
            (long)MigrationRecord(account)[0].GetInteger());

        // ---- 5. the owner's 24h import intent --------------------------------
        fx.AdvanceTime(TimeSpan.FromHours(24) + TimeSpan.FromMinutes(1));
        fx.ConfirmConfiguration(core, account.Account, account.BackupOwner, intentId, migrate);
        VmArray migrationEvent = fx.SingleNotificationState(
            core, Hex(expected.GetProperty("events"), "imported"));
        CollectionAssert.AreEqual(Bytes(input, "manifestDigest"), migrationEvent[1].GetSpan().ToArray());
        Assert.AreEqual(input.GetProperty("classification").GetString()!, TextOf(migrationEvent[2]));

        VmArray afterImport = MigrationRecord(account);
        Assert.AreEqual(imported.GetProperty("migrationRecordStatus").GetInt64(), (long)afterImport[0].GetInteger());
        Assert.AreEqual(Hex(input, "manifestDigest"), HexOf(afterImport[1]));
        Assert.AreEqual(input.GetProperty("classification").GetString()!, TextOf(afterImport[2]));
        Assert.AreEqual(imported.GetProperty("legacyModuleCount").GetInt64(), (long)afterImport[3].GetInteger());
        Assert.AreEqual(imported.GetProperty("legacyScopeInvalidated").GetBoolean(), afterImport[4].GetBoolean());
        Assert.IsTrue(afterImport[5].GetInteger() > 0, "the import records when it happened");
        Assert.IsTrue(account.HasLegacyRow, "the 0x01 row stays as evidence after the import");

        VmArray control = AccountRecord(account);
        Assert.AreEqual(imported.GetProperty("accountStatus").GetInt64(), (long)control[1].GetInteger(),
            "the import is the atomic switch to Active");
        Assert.AreEqual(imported.GetProperty("defaultOperationAuthorization").GetBoolean(),
            control[7].GetBoolean(),
            "a no-plugin import keeps its built-in operation route");
        Assert.AreEqual(imported.GetProperty("defaultMessageAuthorization").GetBoolean(),
            control[8].GetBoolean(),
            "a no-plugin import keeps its built-in message route");
        Assert.IsFalse(control[9].GetBoolean(), "no-plugin is not owner-only");
        Assert.IsTrue(control[15].GetBoolean(), "getAccount still reports the legacy row");
        Assert.IsTrue(control[4].GetInteger() >= epochBefore && control[5].GetInteger() >= nonceBefore,
            "M-3: authorityEpoch and configurationNonce never decrease");
        Assert.IsFalse(fx.CallBoolean(core, "isMigrationRequired", account.Account));

        // ---- 6. repeated identical import is a no-op ------------------------
        BigInteger importedAt = afterImport[5].GetInteger();
        fx.ConfigureAfterTimelock(core, account.Account, account.BackupOwner,
            MigrateAction(input, "classification"));
        Assert.AreEqual(importedAt, MigrationRecord(account)[5].GetInteger(),
            "M-6: the same (accountId, manifestDigest) import changes nothing");

        // ---- 7. a different manifest digest is rejected ---------------------
        TestException replay = Assert.ThrowsExactly<TestException>(() =>
            fx.ConfigureAfterTimelock(core, account.Account, account.BackupOwner,
                MigrateAction(input, "classification", "secondManifestDigest")));
        StringAssert.Contains(replay.Message, Hex(expected, "differentDigestReplayError"));
        Assert.AreEqual(Hex(input, "manifestDigest"), HexOf(MigrationRecord(account)[1]),
            "the rejected replay leaves the imported manifest in place");
    }

    /// <summary>The keeper mark is per-account: an unknown id is not a legacy account.</summary>
    [TestMethod]
    public void MarkingAnUnknownAccountReportsAccountNotFound()
    {
        JsonElement input = LoadGolden("migration").GetProperty("input");
        LegacyAccount open = LegacyMigrationFixture(input, migrationModeOpen: true);
        UInt160 unknown = UInt160.Parse("0x00000000000000000000000000000000000000bb");

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            open.Fx.CallVoid(open.Core, "markMigrationRequired", unknown));
        StringAssert.Contains(fault.Message, "SA_ACCOUNT_NOT_FOUND",
            "the sweep never marks an account the core has no legacy row for");
    }

    /// <summary>M-5/§14: an unknown legacy plugin is never guess-migrated.</summary>
    [TestMethod]
    public void UnknownClassificationKeepsTheAccountRequired()
    {
        JsonElement vector = LoadGolden("migration");
        JsonElement input = vector.GetProperty("input");
        JsonElement expected = vector.GetProperty("expected");

        LegacyAccount account = LegacyMigrationFixture(input, migrationModeOpen: true);
        account.Fx.CallVoid(account.Core, "markMigrationRequired", account.Account);

        TestException rejected = Assert.ThrowsExactly<TestException>(() =>
            account.Fx.ConfigureAfterTimelock(account.Core, account.Account, account.BackupOwner,
                MigrateAction(input, "unknownClassification")));
        StringAssert.Contains(rejected.Message, Hex(expected, "unknownClassificationError"));
        Assert.AreEqual(expected.GetProperty("marked").GetProperty("migrationRecordStatus").GetInt64(),
            (long)MigrationRecord(account)[0].GetInteger(),
            "a rejected import leaves the account in MigrationRequired");
        Assert.IsTrue(account.Fx.CallBoolean(account.Core, "isMigrationRequired", account.Account));
    }

    /// <summary>M-5/§14: an owner-only import carries the constraint forward and
    /// still ends on the built-in route.</summary>
    [TestMethod]
    public void OwnerOnlyImportCarriesTheRecoveryConstraintForward()
    {
        JsonElement vector = LoadGolden("migration");
        JsonElement input = vector.GetProperty("input");
        JsonElement expected = vector.GetProperty("expected").GetProperty("ownerOnly");

        LegacyAccount account = LegacyMigrationFixture(input, migrationModeOpen: true);
        account.Fx.CallVoid(account.Core, "markMigrationRequired", account.Account);
        account.Fx.ConfigureAfterTimelock(account.Core, account.Account, account.BackupOwner,
            MigrateAction(input, "ownerOnlyClassification"));

        VmArray control = AccountRecord(account);
        Assert.AreEqual(expected.GetProperty("accountStatus").GetInt64(), (long)control[1].GetInteger());
        Assert.AreEqual(expected.GetProperty("ownerOnlyRecovery").GetBoolean(), control[9].GetBoolean(),
            "owner-only survives the import as a permanent constraint");
        Assert.AreEqual(expected.GetProperty("defaultOperationAuthorization").GetBoolean(),
            control[7].GetBoolean());
        Assert.AreEqual(input.GetProperty("ownerOnlyClassification").GetString()!,
            TextOf(MigrationRecord(account)[2]));
    }

    // --------------------------------------------------------- rejection table

    [TestMethod]
    public void RejectionTableMatchesTheDeclaredCodes()
    {
        JsonElement vector = Load("rejection-regression.json");
        JsonElement rows = vector.GetProperty("rows");

        string constants = File.ReadAllText(
            Path.Combine(RepoRoot, "contracts", "native", "SmartAccount", "SmartAccountModuleProtocol.cs"));
        var declared = new HashSet<string>(StringComparer.Ordinal);
        int cursor = 0;
        while ((cursor = constants.IndexOf("\"SA_", cursor, StringComparison.Ordinal)) >= 0)
        {
            int end = constants.IndexOf('"', cursor + 1);
            declared.Add(constants[(cursor + 1)..end]);
            cursor = end;
        }
        Assert.IsTrue(declared.Count >= 45, $"only {declared.Count} SA_* constants found");

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var sources = Directory.GetFiles(ContractsTestsRoot, "*.cs")
            .ToDictionary(path => Path.GetFileName(path)!, File.ReadAllText, StringComparer.Ordinal);

        foreach (JsonElement row in rows.EnumerateArray())
        {
            string code = row.GetProperty("error").GetString()!;
            Assert.IsTrue(seen.Add(code), $"duplicate row for {code}");
            Assert.IsFalse(string.IsNullOrWhiteSpace(row.GetProperty("input").GetString()),
                $"{code} must describe the failing input");
            string observable = row.GetProperty("observable").GetString()!;
            Assert.IsTrue(observable is "throw" or "magic",
                $"{code}: observable must be 'throw' or 'magic', saw '{observable}'");

            if (code.StartsWith("SA_", StringComparison.Ordinal))
                Assert.IsTrue(declared.Contains(code),
                    $"{code} is in the table but not declared by the shared constants file");
            else
                Assert.IsTrue(code.StartsWith("LEGACY_REPLAY_", StringComparison.Ordinal),
                    $"{code} is neither a declared code nor a legacy replay seed");

            List<string> covering;
            if (code.StartsWith("LEGACY_REPLAY_", StringComparison.Ordinal))
            {
                // A legacy replay seed is named by the fixture it was captured from:
                // the seed predates this table and never spells a code.
                covering = row.GetProperty("seed").EnumerateArray()
                    .Select(item => item.GetString()!)
                    .Where(sources.ContainsKey)
                    .OrderBy(name => name, StringComparer.Ordinal)
                    .ToList();
            }
            else
            {
                covering = sources
                    .Where(pair => pair.Value.Contains($"\"{code}\"", StringComparison.Ordinal))
                    .Select(pair => pair.Key)
                    .OrderBy(name => name, StringComparer.Ordinal)
                    .ToList();
            }
            string status = row.GetProperty("status").GetString()!;
            Assert.AreEqual(covering.Count > 0 ? "covered" : "uncovered", status,
                $"{code}: status must be recomputed from the test sources, not hand-maintained");
            CollectionAssert.AreEqual(covering, row.GetProperty("coveringTestFiles")
                .EnumerateArray().Select(item => item.GetString()!).ToArray(),
                $"{code}: coveringTestFiles drifted from the test sources");
        }

        var missing = declared.Where(code => !seen.Contains(code)).OrderBy(code => code).ToList();
        Assert.AreEqual(0, missing.Count,
            "every declared code needs a row: " + string.Join(", ", missing));
    }
}
