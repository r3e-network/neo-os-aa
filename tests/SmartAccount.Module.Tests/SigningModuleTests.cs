using System.Diagnostics;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Cryptography;
using Neo.VM.Types;
using NeoArray = Neo.VM.Types.Array;

namespace SmartAccount.Module.Tests;

/// <summary>
/// SigningModule is the only public message entry (§8): it owns the message
/// domain, the subject roster, the quorum and the credential-generation
/// binding, and it answers every failure with the fixed invalid magic instead
/// of a distinguishable fault. These tests drive the deployed module through
/// the core double and a host P-256 key, so the signature path is exercised
/// with real signatures over the exact 32-byte digest.
/// </summary>
[TestClass]
public class SigningModuleTests
{
    private static readonly UInt160 Custody = UInt160.Parse("0x1111111111111111111111111111111111111111");
    private static readonly UInt160 NewCustody = UInt160.Parse("0x2222222222222222222222222222222222222222");
    private static readonly UInt160 Sender = UInt160.Parse("0x3333333333333333333333333333333333333333");
    private static readonly byte[] MagicValid = { 0x16, 0x26, 0xBA, 0x7E };
    private static readonly byte[] MagicInvalid = { 0xFF, 0xFF, 0xFF, 0xFF };

    private const long SevenDaysMs = 7L * 24 * 60 * 60 * 1000;

    private ModuleHarness _h = null!;
    private UInt160 _account = UInt160.Zero;
    private BigInteger _moduleId;
    private P256Key _key = null!;
    private P256Key _other = null!;
    private byte[] _script = null!;
    private byte[] _subject = null!;

    /// <summary>A fixed 32-byte caller-supplied message hash.</summary>
    private static readonly byte[] Hash = Enumerable.Range(0, 32).Select(i => (byte)(0x40 + i)).ToArray();

    [TestInitialize]
    public void SetUp()
    {
        _h = new ModuleHarness();
        _account = _h.CreateAccount("signing", Custody);
        _moduleId = _h.Install(_account, "SigningModule", 1);
        _key = new P256Key();
        _other = new P256Key();
        _script = _key.CanonicalScript();
        _subject = Crypto.Hash160(_script);
        Configure(new object[] { _subject }, 1);
    }

    [TestCleanup]
    public void TearDown()
    {
        _key.Dispose();
        _other.Dispose();
        _h.Dispose();
    }

    private UInt160 Signing => _h.Contract("SigningModule");

    private UInt160 Recovery => _h.Contract("RecoveryModule");

    private void Configure(object[] subjects, int threshold) =>
        _h.Configure(_account, _moduleId, new object[] { subjects, (BigInteger)threshold });

    private NeoArray Policy() =>
        (NeoArray)_h.Call(Signing, "getMessagePolicy", _account, _moduleId);

    // ---- message plumbing ----

    private byte[] Digest(BigInteger generation, byte[] hash) =>
        _h.MessageDigest(_account, Sender, _moduleId, generation, _h.Epoch(_account), hash);

    private object[] Signed(P256Key key, byte[] digest) =>
        new object[] { key.CanonicalScript(), key.SignDigest(digest) };

    private bool IsValid(BigInteger validatorId, BigInteger generation, byte[] hash, object?[]? pairs) =>
        _h.CallBoolean(Signing, "isValidSignature", _account, Sender, validatorId, generation, hash, pairs!);

    private bool IsValid(P256Key signer) =>
        IsValid(_moduleId, BigInteger.One, Hash, Signed(signer, Digest(BigInteger.One, Hash)));

    private byte[] Magic(BigInteger validatorId, BigInteger generation, byte[] hash, object?[]? pairs) =>
        _h.CallBytes(Signing, "validateMessageSignature", _account, Sender, validatorId, generation, hash, pairs!);

    private static byte[] Mangle(byte[] script, int index, byte value)
    {
        byte[] copy = (byte[])script.Clone();
        copy[index] = value;
        return copy;
    }

    // ---- policy ----

    [TestMethod]
    public void Configure_StoresTheRosterThresholdRevisionAndGeneration()
    {
        NeoArray policy = Policy();
        Assert.AreEqual(4, policy.Count, "subjects, threshold, revision, generation");
        Assert.AreEqual(1, ((NeoArray)policy[0]).Count, "one subject");
        Assert.AreEqual(1, (int)policy[1].GetInteger(), "threshold");
        Assert.AreEqual(1, (int)policy[2].GetInteger(), "first revision");
        Assert.AreEqual(1, (int)policy[3].GetInteger(), "the install credential generation");

        Assert.AreEqual(new BigInteger(1), _h.DescriptorInteger(_account, _moduleId, 8),
            "the descriptor still records generation 1");

        Configure(new object[] { _subject }, 1);
        Assert.AreEqual(2, (int)Policy()[2].GetInteger(), "the second write bumps the revision");

        ModuleHarness.AssertFault("SA_MODULE_LIMIT_THRESHOLD", () => Configure(new object[] { _subject }, 0));
        ModuleHarness.AssertFault("SA_MODULE_LIMIT_THRESHOLD", () => Configure(new object[] { _subject }, 2));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Configure(new object[0], 1));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Configure(new object[] { _subject, _subject }, 1));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED",
            () => Configure(new object[] { new byte[19] }, 1));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Configure(new object[]
        {
            (BigInteger)1, (BigInteger)2, (BigInteger)3, (BigInteger)4, (BigInteger)5,
            (BigInteger)6, (BigInteger)7, (BigInteger)8, (BigInteger)9, (BigInteger)10,
            (BigInteger)11, (BigInteger)12, (BigInteger)13, (BigInteger)14, (BigInteger)15,
            (BigInteger)16, (BigInteger)17,
        }, 1));
    }

    [TestMethod]
    public void Configure_IsOnlyReachableThroughTheCoreConfigurationFrame()
    {
        _h.SetSigners(_h.Owner);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Signing, "configure",
            _account, _moduleId, (BigInteger)1, new object[] { new object[] { _subject }, (BigInteger)1 }));
    }

    // ---- the message answer ----

    [TestMethod]
    public void IsValidSignature_AcceptsAGenuinePrehashedP256Signature()
    {
        byte[] digest = Digest(BigInteger.One, Hash);

        Assert.IsTrue(IsValid(_moduleId, BigInteger.One, Hash, Signed(_key, digest)),
            "a rostered subject over the exact digest approves");
        CollectionAssert.AreEqual(MagicValid,
            Magic(_moduleId, BigInteger.One, Hash, Signed(_key, digest)), "ERC-1271 magic");

        // Prehashed means prehashed: a signature over SHA256(digest) is not the
        // signature over digest, and the module must not hash a second time.
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash,
            Signed(_key, SHA256.HashData(digest))), "no implicit re-hash");
        CollectionAssert.AreEqual(MagicInvalid, Magic(_moduleId, BigInteger.One, Hash,
            Signed(_key, SHA256.HashData(digest))), "the invalid magic is the failure channel");
    }

    [TestMethod]
    public void IsValidSignature_RejectsAWrongMessageHash()
    {
        byte[] digest = Digest(BigInteger.One, Hash);
        byte[] otherHash = (byte[])Hash.Clone();
        otherHash[31] ^= 0x01;

        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, otherHash, Signed(_key, digest)),
            "the digest binds the caller-supplied hash");
    }

    [TestMethod]
    public void IsValidSignature_RejectsASubjectOutsideTheRoster()
    {
        byte[] digest = Digest(BigInteger.One, Hash);

        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, Signed(_other, digest)),
            "a signature by a key that is not a subject does not approve");
    }

    [TestMethod]
    public void IsValidSignature_AcceptsA32ByteSubject()
    {
        byte[] hashed = SHA256.HashData(_script);
        Configure(new object[] { hashed }, 1);

        Assert.IsTrue(IsValid(_key), "a SHA-256 subject is accepted as a roster entry");
    }

    [TestMethod]
    public void IsValidSignature_HonoursTheQuorum()
    {
        byte[] otherScript = _other.CanonicalScript();
        Configure(new object[] { _subject, Crypto.Hash160(otherScript) }, 2);

        byte[] digest = Digest(BigInteger.One, Hash);
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, Signed(_key, digest)),
            "one of two subjects is below the quorum");

        object[] both = new object[] { _script, _key.SignDigest(digest), otherScript, _other.SignDigest(digest) };
        Assert.IsTrue(IsValid(_moduleId, BigInteger.One, Hash, both), "two of two meets the quorum");

        // The same canonical script twice would double-count one subject.
        object[] doubled = new object[] { _script, _key.SignDigest(digest), _script, _key.SignDigest(digest) };
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, doubled), "a repeated script is refused");
    }

    [TestMethod]
    public void IsValidSignature_BindsTheCredentialGeneration()
    {
        byte[] digest = Digest(BigInteger.One, Hash);
        object[] pair = Signed(_key, digest);

        Assert.IsFalse(IsValid(_moduleId, (BigInteger)2, Hash, pair),
            "a generation the descriptor does not carry is refused");

        _h.BumpModuleGeneration(_account, _moduleId);
        Assert.AreEqual(new BigInteger(2), _h.DescriptorInteger(_account, _moduleId, 8), "generation 2");

        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, pair),
            "the old generation no longer matches the descriptor");
        byte[] digest2 = Digest((BigInteger)2, Hash);
        Assert.IsFalse(IsValid(_moduleId, (BigInteger)2, Hash, Signed(_key, digest2)),
            "the stored policy is still generation 1");

        Configure(new object[] { _subject }, 1);
        Assert.AreEqual(new BigInteger(2), Policy()[3].GetInteger(), "the policy re-captured generation 2");
        Assert.IsTrue(IsValid(_moduleId, (BigInteger)2, Hash, Signed(_key, digest2)),
            "the reconfigured policy answers for generation 2");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, pair), "generation 1 stays dead");
    }

    [TestMethod]
    public void IsValidSignature_BindsTheAuthorityEpoch()
    {
        object[] pair = Signed(_key, Digest(BigInteger.One, Hash));
        Assert.IsTrue(IsValid(_moduleId, BigInteger.One, Hash, pair));

        _h.SetEpoch(_account, (BigInteger)2);

        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, pair),
            "the same signature no longer answers after the epoch moved");
        Assert.IsTrue(IsValid(_moduleId, BigInteger.One, Hash,
            Signed(_key, Digest(BigInteger.One, Hash))), "the epoch 2 digest is authenticated");
    }

    [TestMethod]
    public void IsValidSignature_RefusesAnAccountThatIsNotActive()
    {
        Assert.IsTrue(IsValid(_key));

        _h.SetStatus(_account, 1);

        Assert.IsFalse(IsValid(_key), "a frozen account has no message answer");
        CollectionAssert.AreEqual(MagicInvalid, Magic(_moduleId, BigInteger.One, Hash,
            Signed(_key, Digest(BigInteger.One, Hash))));
    }

    [TestMethod]
    public void IsValidSignature_RefusesADriftedCodeBinding()
    {
        Assert.IsTrue(IsValid(_key));

        _h.DriftModuleCode(_account, _moduleId);

        Assert.IsFalse(IsValid(_key), "an updated module is not the code the account bound");
    }

    [TestMethod]
    public void IsValidSignature_RefusesAnInstanceWithoutTheMessageCapability()
    {
        // A second instance of the same code, installed without the message
        // capability: the account has a message-capable module, but this seat
        // is not it.
        BigInteger quiet = _h.Install(_account, "SigningModule", 1, null,
            new ModuleHarness.Flags(Isolation: true, Message: false));
        _h.Configure(_account, quiet, new object[] { new object[] { _subject }, (BigInteger)1 });
        byte[] quietDigest = _h.MessageDigest(_account, Sender, quiet, BigInteger.One,
            _h.Epoch(_account), Hash);
        object[] quietPair = Signed(_key, quietDigest);

        Assert.IsFalse(IsValid(quiet, BigInteger.One, Hash, quietPair),
            "no message capability, no message answer");
        Assert.IsTrue(IsValid(_moduleId, BigInteger.One, Hash,
            Signed(_key, Digest(BigInteger.One, Hash))), "the message-capable seat still answers");

        // The only thing withheld was the capability: granting it makes the very
        // same signature answer.
        _h.SetSigners(_h.Owner);
        _h.CallVoid(_h.Core, "setModuleFlags", _account, quiet, true, true, false, false, false, false);
        Assert.IsTrue(IsValid(quiet, BigInteger.One, Hash, quietPair),
            "the same instance answers once the capability is recorded");
    }

    [TestMethod]
    public void IsValidSignature_NeverThrowsForMalformedInput()
    {
        byte[] digest = Digest(BigInteger.One, Hash);
        object[] good = Signed(_key, digest);
        byte[] shortScript = new byte[39];
        System.Array.Copy(_script, shortScript, 39);

        UInt160 zero = UInt160.Zero;
        byte[] shortHash = new byte[31];
        byte[] longHash = new byte[33];

        Assert.IsFalse(_h.CallBoolean(Signing, "isValidSignature", zero, Sender, _moduleId,
            (BigInteger)1, Hash, good), "a zero account");
        Assert.IsFalse(IsValid(BigInteger.Zero, BigInteger.One, Hash, good), "validator id 0");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.Zero, Hash, good), "generation 0");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, shortHash, good), "a 31-byte hash");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, longHash, good), "a 33-byte hash");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, null), "no pairs");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, new object[0]), "empty pairs");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, new object[] { _script }), "odd pairs");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash,
            new object[] { (BigInteger)7, (BigInteger)7 }), "non-byte-string pairs");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash,
            new object[] { shortScript, _key.SignDigest(digest) }), "a 39-byte script");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash,
            new object[] { Mangle(_script, 0, 0x0B), _key.SignDigest(digest) }), "a wrong push opcode");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash,
            new object[] { Mangle(_script, 36, 0x00), _key.SignDigest(digest) }), "a wrong syscall hash");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash,
            new object[] { _script, new byte[63] }), "a 63-byte signature");
    }

    [TestMethod]
    public void IsValidSignature_IsReadOnlyAndTheOnlyPublicMessageEntry()
    {
        Assert.IsTrue(ModuleHarness.ModuleAbiMethodIsSafe("SigningModule", "isValidSignature"),
            "isValidSignature is declared safe");
        Assert.IsTrue(ModuleHarness.ModuleAbiMethodIsSafe("SigningModule", "validateMessageSignature"),
            "validateMessageSignature is declared safe");
        Assert.IsTrue(ModuleHarness.ModuleAbiMethodIsSafe("SigningModule", "getMessagePolicy"),
            "the policy read is declared safe");

        IReadOnlyList<string> abi = ModuleHarness.ModuleAbiMethods("SigningModule");
        CollectionAssert.Contains(abi.ToList(), "isValidSignature");
        CollectionAssert.DoesNotContain(abi.ToList(), "getMessageSubjects",
            "the retired native read is not reintroduced");
        CollectionAssert.DoesNotContain(abi.ToList(), "setRecoveryPolicy",
            "the retired native write is not reintroduced");

        // Reading the answer must not consume an operation nonce or write state.
        BigInteger nonceBefore = _h.ConfigurationNonce(_account);
        string profile = System.Text.Encoding.UTF8.GetString(_h.CallBytes(Signing, "getModuleProfile"));
        Assert.IsTrue(IsValid(_key));
        Assert.IsFalse(IsValid(_other));
        Assert.AreEqual(nonceBefore, _h.ConfigurationNonce(_account), "the answer is read-only");
        StringAssert.Contains(profile, "\"messageCapability\":true");
        StringAssert.Contains(profile, "\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\",\"isValidSignature\"]");
    }

    // ---- instance lifetime ----

    [TestMethod]
    public void IsValidSignature_RefusesARetiredInstance()
    {
        Assert.IsTrue(IsValid(_key));

        _h.SetSigners(_h.Owner);
        _h.CallVoid(_h.Core, "removeModule", _account, _moduleId, new object[0]);

        Assert.IsFalse(IsValid(_key), "the retired instance is no longer installed");

        BigInteger replacement = _h.Install(_account, "SigningModule", 1);
        _h.Configure(_account, replacement, new object[] { new object[] { _subject }, (BigInteger)1 });
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash,
            Signed(_key, Digest(BigInteger.One, Hash))), "the old module id cannot answer");
        byte[] replacementDigest = _h.MessageDigest(_account, Sender, replacement, BigInteger.One,
            _h.Epoch(_account), Hash);
        Assert.IsTrue(IsValid(replacement, BigInteger.One, Hash, Signed(_key, replacementDigest)),
            "the replacement answers under its own id");
    }

    [TestMethod]
    public void IsValidSignature_IsInvalidatedByANativeReset()
    {
        Assert.IsTrue(IsValid(_key));

        // A real recovery: the account names its own custody as recovery
        // authority, begins with the new custodian's consent, waits out the
        // 7 day floor and lands the reset through the native core.
        BigInteger recoveryId = _h.Install(_account, "RecoveryModule", 5);
        _h.Configure(_account, recoveryId,
            new object[] { new object[] { Custody }, (BigInteger)1, (BigInteger)SevenDaysMs });
        _h.SetSigners(Custody, NewCustody);
        Assert.AreEqual(BigInteger.One,
            _h.CallInteger(Recovery, "beginRecovery", _account, NewCustody), "one pending request");
        _h.AdvanceTime(TimeSpan.FromDays(7) + TimeSpan.FromMinutes(1));
        _h.SetSigners(Sender);
        _h.CallVoid(Recovery, "executeRecovery", _account);

        Assert.AreEqual(NewCustody, _h.Custody(_account), "the reset re-landed custody");
        Assert.AreEqual(new BigInteger(2), _h.Epoch(_account), "the authority epoch advanced");
        Assert.IsFalse(IsValid(_key),
            "the reset dropped the instance and moved the epoch, so the old signature is dead");
    }

    // ---- the pairs ABI and the sender binding (§8) ----

    /// <summary>
    /// The client keeps convenience <c>(script, signature)</c> pairs; the call
    /// encodes them flat. This is the exact flattening the shared client applies
    /// before it emits the invocation.
    /// </summary>
    private static object[] Flatten(params (byte[] Script, byte[] Signature)[] pairs)
    {
        object[] flat = new object[pairs.Length * 2];
        for (int i = 0; i < pairs.Length; i++)
        {
            flat[i * 2] = pairs[i].Script;
            flat[i * 2 + 1] = pairs[i].Signature;
        }
        return flat;
    }

    [TestMethod]
    public void IsValidSignature_UsesAFlatPairArrayAndRefusesNestedPairs()
    {
        byte[] digest = Digest(BigInteger.One, Hash);
        object[] flat = Flatten((_script, _key.SignDigest(digest)));
        Assert.IsTrue(IsValid(_moduleId, BigInteger.One, Hash, flat), "client-built flat pairs approve");

        // A convenience pair object that was not flattened is not the ABI: the
        // module reads [script, sig, script, sig, ...].
        object[] nested = new object[] { new object[] { _script, _key.SignDigest(digest) } };
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, nested),
            "a nested pair object is not the message ABI");
    }

    [TestMethod]
    public void IsValidSignature_BindsTheSenderInTheDomain()
    {
        object[] pair = Flatten((_script, _key.SignDigest(Digest(BigInteger.One, Hash))));
        Assert.IsTrue(IsValid(_moduleId, BigInteger.One, Hash, pair));

        // The same signature under a different originalSender: the preimage it
        // was made for names Sender, so it cannot be moved to another sender.
        UInt160 otherSender = UInt160.Parse("0x4444444444444444444444444444444444444444");
        Assert.IsFalse(_h.CallBoolean(Signing, "isValidSignature", _account, otherSender, _moduleId,
            (BigInteger)1, Hash, pair), "the same signature cannot change sender");

        // The digest made for the other sender approves under that sender only.
        byte[] otherDigest = _h.MessageDigest(_account, otherSender, _moduleId, BigInteger.One,
            _h.Epoch(_account), Hash);
        object[] otherPair = Flatten((_script, _key.SignDigest(otherDigest)));
        Assert.IsTrue(_h.CallBoolean(Signing, "isValidSignature", _account, otherSender, _moduleId,
            (BigInteger)1, Hash, otherPair), "the sender-bound digest approves for its own sender");
        Assert.IsFalse(IsValid(_moduleId, BigInteger.One, Hash, otherPair), "and not for Sender");
    }

    [TestMethod]
    public void IsValidSignature_AnswersAReadOnlyQueryFromAnyCaller()
    {
        // The message entry is a read-only query: an offline RPC client is the
        // caller, so no caller identity is part of the answer. Reaching the same
        // question through a different caller (the core double forwards it)
        // returns exactly the same verdict, which is what makes the answer safe
        // to consume off-chain: the binding lives in the signed domain, not in
        // who asked.
        object[] pair = Flatten((_script, _key.SignDigest(Digest(BigInteger.One, Hash))));
        object[] args = new object[] { _account, Sender, _moduleId, (BigInteger)1, Hash, pair };

        bool direct = IsValid(_moduleId, BigInteger.One, Hash, pair);
        _h.SetSigners(_h.Owner);
        Assert.IsTrue(direct);
        Assert.AreEqual(direct, _h.CallBoolean(_h.Core, "forward", Signing, "isValidSignature", args),
            "the answer does not depend on the caller");

        UInt160 strangerSender = UInt160.Parse("0x5555555555555555555555555555555555555555");
        object[] spoofed = new object[] { _account, strangerSender, _moduleId, (BigInteger)1, Hash, pair };
        Assert.IsFalse(_h.CallBoolean(_h.Core, "forward", Signing, "isValidSignature", spoofed),
            "another caller cannot move the approval to a different sender");
    }

    // ---- the shared wallet client's own encoder, against the deployed module ----

    private static string Hex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    /// <summary>
    /// Asks the shared wallet client for the message-verification script and
    /// returns its bytes. The client runs offline; it only encodes the call.
    /// </summary>
    private byte[] ClientScript(UInt160 sender, BigInteger validatorId, BigInteger generation,
        byte[] hash, params (byte[] Script, byte[] Signature)[] pairs)
    {
        string helper = Path.Combine(ModuleHarness.RepositoryRoot,
            "tests", "SmartAccount.Module.Tests", "ClientMessageInvocation.mjs");
        Assert.IsTrue(File.Exists(helper), "the shared-client invocation helper is present");

        using var payload = new MemoryStream();
        using (var writer = new Utf8JsonWriter(payload))
        {
            writer.WriteStartObject();
            writer.WriteString("moduleContractHash", Signing.ToString());
            writer.WriteString("accountId", _account.ToString());
            writer.WriteString("originalSender", sender.ToString());
            writer.WriteNumber("validatorId", (long)validatorId);
            writer.WriteNumber("generation", (long)generation);
            writer.WriteString("hash", Hex(hash));
            writer.WriteStartArray("pairs");
            foreach ((byte[] script, byte[] signature) in pairs)
            {
                writer.WriteStartArray();
                writer.WriteStringValue(Hex(script));
                writer.WriteStringValue(Hex(signature));
                writer.WriteEndArray();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("NODE_BIN") ?? "node")
        {
            WorkingDirectory = ModuleHarness.RepositoryRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add(helper);
        start.ArgumentList.Add(Encoding.UTF8.GetString(payload.ToArray()));
        using Process process = Process.Start(start)!;
        string stdout = process.StandardOutput.ReadToEnd().Trim();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.AreEqual(0, process.ExitCode, "the shared-client invocation helper failed: " + stderr);
        Assert.IsTrue(stdout.Length > 0, "the shared client printed no script");
        return Convert.FromHexString(stdout);
    }

    /// <summary>
    /// The bytes come from <c>shared/nativeSmartAccountClient.mjs</c> and run in
    /// the engine that holds the deployed SigningModule, so the client encoder
    /// and the module verifier are proven on one wire: single and multiple
    /// pairs, a duplicated pair, a malformed canonical script, a moved
    /// originalSender and a stale credential generation.
    /// </summary>
    [TestMethod]
    public void IsValidSignature_ExecutesTheSharedClientsMessageInvocation()
    {
        byte[] signature = _key.SignDigest(Digest(BigInteger.One, Hash));

        Assert.IsTrue(_h.ExecuteScript(ClientScript(Sender, _moduleId, BigInteger.One, Hash,
                (_script, signature))).GetBoolean(),
            "the wallet client's single-pair invocation approves");

        // A duplicated pair would count one subject twice.
        Assert.IsFalse(_h.ExecuteScript(ClientScript(Sender, _moduleId, BigInteger.One, Hash,
                (_script, signature), (_script, signature))).GetBoolean(),
            "a duplicated pair approves nothing");

        // A script outside the canonical 40-byte shape is not a subject.
        Assert.IsFalse(_h.ExecuteScript(ClientScript(Sender, _moduleId, BigInteger.One, Hash,
                (Mangle(_script, 36, 0x00), signature))).GetBoolean(),
            "a malformed script is refused although the signature is genuine");

        // The domain names the sender; the client cannot move it.
        UInt160 otherSender = UInt160.Parse("0x4444444444444444444444444444444444444444");
        Assert.IsFalse(_h.ExecuteScript(ClientScript(otherSender, _moduleId, BigInteger.One, Hash,
                (_script, signature))).GetBoolean(),
            "the same signature cannot be asked for another sender");

        // Two subjects, quorum two: one pair is short, two pairs approve.
        byte[] otherScript = _other.CanonicalScript();
        Configure(new object[] { _subject, Crypto.Hash160(otherScript) }, 2);
        Assert.IsFalse(_h.ExecuteScript(ClientScript(Sender, _moduleId, BigInteger.One, Hash,
                (_script, signature))).GetBoolean(), "one of two is below the quorum");
        Assert.IsTrue(_h.ExecuteScript(ClientScript(Sender, _moduleId, BigInteger.One, Hash,
                (_script, signature), (otherScript, _other.SignDigest(Digest(BigInteger.One, Hash))))).GetBoolean(),
            "two client pairs meet the quorum");

        // Stale counters: the descriptor and the policy both have to move.
        _h.BumpModuleGeneration(_account, _moduleId);
        Assert.IsFalse(_h.ExecuteScript(ClientScript(Sender, _moduleId, BigInteger.One, Hash,
                (_script, signature), (otherScript, _other.SignDigest(Digest(BigInteger.One, Hash))))).GetBoolean(),
            "a stale generation approves nothing");
        Assert.IsFalse(_h.ExecuteScript(ClientScript(Sender, _moduleId, (BigInteger)2, Hash,
                (_script, _key.SignDigest(Digest((BigInteger)2, Hash))),
                (otherScript, _other.SignDigest(Digest((BigInteger)2, Hash))))).GetBoolean(),
            "the stored policy still answers for generation 1");

        Configure(new object[] { _subject, Crypto.Hash160(otherScript) }, 2);
        Assert.IsTrue(_h.ExecuteScript(ClientScript(Sender, _moduleId, (BigInteger)2, Hash,
                (_script, _key.SignDigest(Digest((BigInteger)2, Hash))),
                (otherScript, _other.SignDigest(Digest((BigInteger)2, Hash))))).GetBoolean(),
            "the renewed policy answers the client for generation 2");
    }
}
