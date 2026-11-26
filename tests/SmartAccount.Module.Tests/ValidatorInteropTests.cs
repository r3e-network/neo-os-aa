using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;
using NeoArray = Neo.VM.Types.Array;

namespace SmartAccount.Module.Tests;

/// <summary>
/// Cryptographic interop of the deployed validator plugins (task 27).
///
/// Every test here deploys the NEF the project ships
/// (<c>contracts/bin/public/validators</c>) and drives it through the core
/// double, so the code under test is the code that runs on chain. The client
/// side is modelled exactly: the §4.3 operation digest
/// <c>D = SHA256(opPreimage)</c>, the §5 threshold member digest
/// <c>D_i = SHA256(memberPreimage)</c> and the delegated identity digest are
/// built here from the published preimages, signed as 64-byte <c>r‖s</c> over
/// that digest with a 33-byte compressed key, and presented in the module's
/// signature DTO.
///
/// The platform's <c>verifyWithECDsa</c> hashes its message argument once, so
/// every module hands it a PREIMAGE. Each path therefore carries two
/// direction-defining negatives: the digest itself (a double hash) must not
/// verify, and a digest of some other operation must not verify either.
/// </summary>
[TestClass]
public class ValidatorInteropTests
{
    private static readonly UInt160 Custody = UInt160.Parse("0x1111111111111111111111111111111111111111");
    private static readonly byte[] Provider = Encoding.UTF8.GetBytes("morpheus.neo");
    private static readonly byte[] MasterNullifier = Enumerable.Range(0, 32).Select(i => (byte)(0x80 + i)).ToArray();

    private ModuleHarness _h = null!;
    private UInt160 _account = UInt160.Zero;

    [TestInitialize]
    public void SetUp()
    {
        _h = new ModuleHarness();
        _account = _h.CreateAccount("validator-interop", Custody);
    }

    [TestCleanup]
    public void TearDown() => _h.Dispose();

    // ---- shared plumbing ----

    private byte[] Digest(object?[] operation) => SHA256.HashData(_h.OperationPreimage(_account, operation));

    private byte[] DigestFor(UInt160 account, object?[] operation) =>
        SHA256.HashData(_h.OperationPreimage(account, operation));

    private byte[] ForeignNetworkDigest(object?[] operation) =>
        SHA256.HashData(_h.OperationPreimage(_account, operation, _h.Engine.ProtocolSettings.Network + 1u));

    private object?[] Operation(UInt160 target, string method, BigInteger validatorId, BigInteger generation,
        BigInteger nonce, byte[] signature = null!, object?[]? args = null) =>
        ModuleHarness.Operation(target, method, args ?? System.Array.Empty<object>(), nonce, validatorId,
            generation, _h.Epoch(_account), _h.ConfigurationNonce(_account), signature ?? System.Array.Empty<byte>());

    private bool Validate(BigInteger moduleId, int phase, byte[] digest, object?[] operation)
    {
        try
        {
            return _h.InvokeBool(_account, moduleId, phase, "validateUserOp", _account, digest, operation);
        }
        catch (Neo.SmartContract.Testing.Exceptions.TestException fault)
        {
            throw new AssertFailedException("validateUserOp faulted instead of answering: " + fault.Message, fault);
        }
    }

    private BigInteger Install(string artifact, params object[] initData) =>
        _h.Install(_account, artifact, 1, initData);

    private static byte[] MemberEntries(params (BigInteger Member, byte[] Signature)[] rows)
    {
        NeoArray entries = new();
        foreach ((BigInteger member, byte[] signature) in rows)
        {
            NeoArray entry = new();
            entry.Add(new Integer(member));
            entry.Add(new ByteString(signature));
            entries.Add(entry);
        }
        return BinarySerializer.Serialize(entries, ExecutionEngineLimits.Default);
    }

    private static byte[] Concat(params byte[][] parts)
    {
        using MemoryStream stream = new();
        foreach (byte[] part in parts) stream.Write(part, 0, part.Length);
        return stream.ToArray();
    }

    private static byte[] Sha256(byte[] value) => SHA256.HashData(value);

    // ------------------------------------------------------------------
    // Standalone route: D = SHA256(opPreimage)
    // ------------------------------------------------------------------

    [TestMethod]
    public void P256Standalone_VerifiesTheOperationPreimageAndRefusesEveryOtherInput()
    {
        UInt160 p256 = _h.DeployValidator("P256Validator");
        using P256Key key = new();
        BigInteger moduleId = Install("P256Validator", "setPublicKey", key.CompressedPublicKey);

        object?[] operation = Operation(NativeContract.GAS.Hash, "symbol", moduleId, BigInteger.One, 7);
        byte[] digest = Digest(operation);

        // Positive: the client signer signs D with the rostered key.
        byte[] signature = key.SignDigest(digest);
        operation[11] = signature;
        Assert.IsTrue(Validate(moduleId, 1, digest, operation),
            "a 64-byte r‖s signature over D = SHA256(opPreimage) approves");

        // Negative 1: the same key signing SHA256(D) is a double hash; the
        // platform already applied the only SHA-256, so it must not verify.
        operation[11] = key.SignDigest(Sha256(digest));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a double-hashed digest must not approve");

        // Negative 2: a signature over the digest of a different operation is
        // presented against this one. The module re-derives the preimage and
        // compares SHA256(opPreimage) with the digest before looking at keys.
        object?[] other = Operation(NativeContract.GAS.Hash, "symbol", moduleId, BigInteger.One, 8);
        operation[11] = key.SignDigest(Digest(other));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a wrong preimage must not approve");

        // Negative 3: the digest of the same operation under another account.
        operation[11] = key.SignDigest(DigestFor(ModuleHarness.AccountId("someone-else"), operation));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a digest bound to another account must not approve");

        // Negative 4: the digest of the same operation under another network.
        operation[11] = key.SignDigest(ForeignNetworkDigest(operation));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a digest bound to another network must not approve");

        // Negative 5: shape. A 65-byte recoverable signature, a 63-byte one and
        // an uncompressed key are not the platform's shapes.
        operation[11] = Concat(signature, new byte[] { 0x01 });
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "65-byte signature");
        operation[11] = signature[..63];
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "63-byte signature");

        operation[11] = signature;
        Assert.IsTrue(Validate(moduleId, 1, digest, operation), "the genuine signature still approves");

        // Negative 6: a stale digest. The operation now names generation 2, so
        // the generation-1 digest no longer hashes back to any preimage.
        object?[] stale = Operation(NativeContract.GAS.Hash, "symbol", moduleId, (BigInteger)2, 7);
        stale[11] = signature;
        Assert.IsFalse(Validate(moduleId, 1, digest, stale), "a stale generation digest must not approve");
    }

    [TestMethod]
    public void TeeKeyStandalone_VerifiesThePreimageAndBindsTheKeyId()
    {
        _h.DeployValidator("TeeKeyValidator");
        using P256Key key = new();
        BigInteger moduleId = Install("TeeKeyValidator", "setPublicKey", key.CompressedPublicKey);
        byte[] keyId = Sha256(key.CompressedPublicKey);
        CollectionAssert.AreEqual(keyId,
            _h.CallBytes(_h.Contract("TeeKeyValidator"), "getKeyId", _account, moduleId),
            "the client key id is SHA256(compressed key)");

        object?[] operation = Operation(NativeContract.GAS.Hash, "symbol", moduleId, BigInteger.One, 3);
        byte[] digest = Digest(operation);
        byte[] signature = key.SignDigest(digest);

        operation[11] = Concat(keyId, signature);
        Assert.IsTrue(Validate(moduleId, 1, digest, operation), "keyId ‖ r‖s over the operation preimage approves");

        // Double hash on the same DTO.
        operation[11] = Concat(keyId, key.SignDigest(Sha256(digest)));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a double-hashed digest must not approve");

        // A DTO bound to another key's id.
        using P256Key foreign = new();
        operation[11] = Concat(Sha256(foreign.CompressedPublicKey), signature);
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a foreign key id must not approve");

        // Wrong preimage behind a well-formed DTO.
        operation[11] = Concat(keyId, key.SignDigest(Digest(Operation(NativeContract.GAS.Hash, "symbol",
            moduleId, BigInteger.One, 4))));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a wrong preimage must not approve");

        // Stale generation: the operation now names generation 2, so the
        // generation-1 digest has no preimage behind it.
        object?[] stale = Operation(NativeContract.GAS.Hash, "symbol", moduleId, (BigInteger)2, 3);
        stale[11] = Concat(keyId, signature);
        Assert.IsFalse(Validate(moduleId, 1, digest, stale), "a stale generation digest must not approve");

        // The §4.3 domain binds the account and the network, so a genuine key
        // signature over another account's or another network's digest is dead.
        operation[11] = Concat(keyId,
            key.SignDigest(DigestFor(ModuleHarness.AccountId("someone-else"), operation)));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation),
            "a digest bound to another account must not approve");
        operation[11] = Concat(keyId, key.SignDigest(ForeignNetworkDigest(operation)));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation),
            "a digest bound to another network must not approve");

        operation[11] = Concat(keyId, signature);
        Assert.IsTrue(Validate(moduleId, 1, digest, operation), "the genuine DTO still approves");
    }

    [TestMethod]
    public void SessionKeyStandalone_VerifiesTheOperationPreimageAgainstTheGrant()
    {
        _h.DeployValidator("SessionKeyValidator");
        using P256Key key = new();
        UInt160 target = NativeContract.GAS.Hash;
        BigInteger validUntil = _h.Now() + 3600_000;
        BigInteger moduleId = Install("SessionKeyValidator", "setSessionKey", key.CompressedPublicKey, target,
            "ping", validUntil, (BigInteger)0, "interop");

        UInt160 session = _h.Contract("SessionKeyValidator");
        byte[] grantDigest = _h.CallBytes(session, "getGrantDigest", _account, moduleId);
        Assert.HasCount(32, grantDigest);

        object?[] operation = Operation(target, "ping", moduleId, BigInteger.One, 1);
        byte[] digest = Digest(operation);
        byte[] signature = key.SignDigest(digest);

        operation[11] = Concat(grantDigest, signature);
        Assert.IsTrue(Validate(moduleId, 1, digest, operation), "grantDigest ‖ r‖s over the preimage approves");

        operation[11] = Concat(grantDigest, key.SignDigest(Sha256(digest)));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a double-hashed digest must not approve");

        // A signature over the right bytes but a grant digest the instance does
        // not hold is refused before any curve work.
        byte[] otherGrant = (byte[])grantDigest.Clone();
        otherGrant[0] ^= 0x01;
        operation[11] = Concat(otherGrant, signature);
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a foreign grant digest must not approve");

        // Stale generation: the grant was issued under generation 1.
        object?[] stale = Operation(target, "ping", moduleId, (BigInteger)2, 1);
        byte[] staleDigest = Digest(stale);
        stale[11] = Concat(grantDigest, key.SignDigest(staleDigest));
        Assert.IsFalse(Validate(moduleId, 1, staleDigest, stale), "a grant dies with its credential generation");

        // Scope and expiry stay enforced around the signature.
        object?[] offTarget = Operation(UInt160.Parse("0x0909090909090909090909090909090909090909"),
            "ping", moduleId, BigInteger.One, 2);
        byte[] offTargetDigest = Digest(offTarget);
        offTarget[11] = Concat(grantDigest, key.SignDigest(offTargetDigest));
        Assert.IsFalse(Validate(moduleId, 1, offTargetDigest, offTarget), "another target is outside the grant");

        // The domain binds the account and the network: a genuine grant
        // signature over another account's or another network's digest is dead.
        operation[11] = Concat(grantDigest,
            key.SignDigest(DigestFor(ModuleHarness.AccountId("someone-else"), operation)));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation),
            "a digest bound to another account must not approve");
        operation[11] = Concat(grantDigest, key.SignDigest(ForeignNetworkDigest(operation)));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation),
            "a digest bound to another network must not approve");

        operation[11] = Concat(grantDigest, signature);
        Assert.IsTrue(Validate(moduleId, 1, digest, operation), "the genuine grant signature still approves");
    }

    [TestMethod]
    public void DelegatedIdentity_VerifiesTheIdentityPreimageAndBindsTheNullifiers()
    {
        _h.DeployValidator("DelegatedIdentityValidator");
        using P256Key key = new();
        BigInteger moduleId = Install("DelegatedIdentityValidator", "setConfig", key.CompressedPublicKey,
            Provider, MasterNullifier);

        byte[] actionNullifier = Enumerable.Range(0, 32).Select(i => (byte)(0x40 + i)).ToArray();
        object?[] operation = Operation(NativeContract.GAS.Hash, "symbol", moduleId, BigInteger.One, 5);
        byte[] digest = Digest(operation);
        byte[] identityPreimage = ModuleHarness.IdentityPreimage(digest, Provider, MasterNullifier, actionNullifier);
        byte[] identityDigest = Sha256(identityPreimage);

        // The public view answers the exact digest the client must sign.
        CollectionAssert.AreEqual(identityDigest,
            _h.CallBytes(_h.Contract("DelegatedIdentityValidator"), "getSigningDigest", _account, moduleId,
                digest, actionNullifier),
            "getSigningDigest is SHA256(identityPreimage)");

        byte[] proof = Concat(new byte[] { 0x01, (byte)Provider.Length }, Provider, MasterNullifier,
            actionNullifier, key.SignDigest(identityDigest));
        operation[11] = proof;
        Assert.IsTrue(Validate(moduleId, 1, digest, operation), "the identity preimage signature approves");

        // Double hash: SHA256(identityPreimage) hashed again.
        operation[11] = Concat(new byte[] { 0x01, (byte)Provider.Length }, Provider, MasterNullifier,
            actionNullifier, key.SignDigest(Sha256(identityDigest)));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a double-hashed identity digest must not approve");

        // Wrong preimage: the same proof shape over another operation's digest.
        byte[] otherDigest = Digest(Operation(NativeContract.GAS.Hash, "symbol", moduleId, BigInteger.One, 6));
        byte[] otherIdentity = Sha256(ModuleHarness.IdentityPreimage(otherDigest, Provider, MasterNullifier,
            actionNullifier));
        operation[11] = Concat(new byte[] { 0x01, (byte)Provider.Length }, Provider, MasterNullifier,
            actionNullifier, key.SignDigest(otherIdentity));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a wrong preimage must not approve");

        // Action-nullifier binding: the signature commits to the presented
        // nullifier, so the same signature under another action nullifier
        // approves nothing (the nullifier is the signer's per-action choice, not
        // a configured value; the proof binds whichever one it carries).
        byte[] movedNullifier = (byte[])actionNullifier.Clone();
        movedNullifier[31] ^= 0x01;
        operation[11] = Concat(new byte[] { 0x01, (byte)Provider.Length }, Provider, MasterNullifier,
            movedNullifier, key.SignDigest(identityDigest));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation),
            "the signature commits to the presented action nullifier");

        // Presenting a different master nullifier in the proof is refused.
        byte[] otherMaster = (byte[])MasterNullifier.Clone();
        otherMaster[0] ^= 0x01;
        operation[11] = Concat(new byte[] { 0x01, (byte)Provider.Length }, Provider, otherMaster,
            actionNullifier, key.SignDigest(identityDigest));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation), "a foreign master nullifier must not approve");

        // Stale generation: the identity preimage commits to the operation
        // digest, so a proof for generation 1 cannot answer an operation that
        // names generation 2.
        object?[] stale = Operation(NativeContract.GAS.Hash, "symbol", moduleId, (BigInteger)2, 5);
        stale[11] = proof;
        Assert.IsFalse(Validate(moduleId, 1, digest, stale),
            "a stale generation digest must not approve");

        // Wrong account and wrong network: the operation preimage binds both, so
        // a signature over a foreign domain never reaches the identity check.
        byte[] foreignIdentity = Sha256(ModuleHarness.IdentityPreimage(
            DigestFor(ModuleHarness.AccountId("someone-else"), operation), Provider, MasterNullifier,
            actionNullifier));
        operation[11] = Concat(new byte[] { 0x01, (byte)Provider.Length }, Provider, MasterNullifier,
            actionNullifier, key.SignDigest(foreignIdentity));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation),
            "a digest bound to another account must not approve");
        byte[] foreignNetworkIdentity = Sha256(ModuleHarness.IdentityPreimage(ForeignNetworkDigest(operation),
            Provider, MasterNullifier, actionNullifier));
        operation[11] = Concat(new byte[] { 0x01, (byte)Provider.Length }, Provider, MasterNullifier,
            actionNullifier, key.SignDigest(foreignNetworkIdentity));
        Assert.IsFalse(Validate(moduleId, 1, digest, operation),
            "a digest bound to another network must not approve");

        operation[11] = proof;
        Assert.IsTrue(Validate(moduleId, 1, digest, operation), "the genuine proof still approves");
    }

    // ------------------------------------------------------------------
    // Threshold route: D_i = SHA256(memberPreimage)
    // ------------------------------------------------------------------

    [TestMethod]
    public void ThresholdMember_VerifiesTheMemberPreimageAndDiesWithItsGeneration()
    {
        _h.DeployValidator("P256Validator");
        _h.DeployValidator("MultiSigValidator");
        using P256Key adapterKey = new();
        using P256Key first = new();
        using P256Key second = new();

        // A routed validator stands in for the policy adapter; the two members
        // are real MultiSigValidator instances the adapter would name.
        BigInteger adapter = Install("P256Validator", "setPublicKey", adapterKey.CompressedPublicKey);
        BigInteger memberA = Install("MultiSigValidator", "setMemberKey", first.CompressedPublicKey);
        BigInteger memberB = Install("MultiSigValidator", "setMemberKey", second.CompressedPublicKey);

        object?[] operation = Operation(NativeContract.GAS.Hash, "symbol", adapter, BigInteger.One, 9);
        byte[] digest = Digest(operation);

        BigInteger generationA = _h.DescriptorInteger(_account, memberA, 8);
        BigInteger generationB = _h.DescriptorInteger(_account, memberB, 8);
        byte[] preimageA = ModuleHarness.ThresholdMemberPreimage(digest, memberA, generationA);
        byte[] preimageB = ModuleHarness.ThresholdMemberPreimage(digest, memberB, generationB);
        byte[] memberDigestA = Sha256(preimageA);
        byte[] memberDigestB = Sha256(preimageB);

        // The public view answers D_i for the client.
        CollectionAssert.AreEqual(memberDigestA,
            _h.CallBytes(_h.Contract("MultiSigValidator"), "getMemberDigest", _account, memberA, digest),
            "getMemberDigest is SHA256(memberPreimage)");

        byte[] signatureA = first.SignDigest(memberDigestA);
        byte[] signatureB = second.SignDigest(memberDigestB);

        // Positive: each member approves its own entry under phase 8.
        operation[11] = MemberEntries((memberA, signatureA), (memberB, signatureB));
        Assert.IsTrue(Validate(memberA, 8, digest, operation), "member A approves over D_i");
        Assert.IsTrue(Validate(memberB, 8, digest, operation), "member B approves over its own D_i");

        // Double hash: SHA256(D_i) is not D_i.
        operation[11] = MemberEntries((memberA, first.SignDigest(Sha256(memberDigestA))),
            (memberB, signatureB));
        Assert.IsFalse(Validate(memberA, 8, digest, operation), "a double-hashed member digest must not approve");

        // Wrong preimage: the operation digest itself is not the member digest.
        operation[11] = MemberEntries((memberA, first.SignDigest(digest)), (memberB, signatureB));
        Assert.IsFalse(Validate(memberA, 8, digest, operation), "the operation digest is not a member approval");

        // Member binding: A's approval under B's id approves nothing, because
        // D_i carries the member id.
        operation[11] = MemberEntries((memberA, signatureB), (memberB, signatureA));
        Assert.IsFalse(Validate(memberA, 8, digest, operation), "a member entry approves its own member only");

        // Wrong account: the same member signature against another account's
        // digest of the same operation.
        object?[] otherAccount = Operation(NativeContract.GAS.Hash, "symbol", adapter, BigInteger.One, 9);
        byte[] foreign = DigestFor(ModuleHarness.AccountId("someone-else"), otherAccount);
        operation[11] = MemberEntries((memberA, first.SignDigest(
            Sha256(ModuleHarness.ThresholdMemberPreimage(foreign, memberA, generationA)))));
        Assert.IsFalse(Validate(memberA, 8, digest, operation), "a digest of another account must not approve");

        // Wrong network: the digest of the same operation on another chain.
        byte[] networkDigest = ForeignNetworkDigest(operation);
        operation[11] = MemberEntries((memberA, first.SignDigest(
            Sha256(ModuleHarness.ThresholdMemberPreimage(networkDigest, memberA, generationA)))),
            (memberB, signatureB));
        Assert.IsFalse(Validate(memberA, 8, digest, operation),
            "a digest of another network must not approve");

        // Stale generation: revoking the member's credentials re-keys D_i.
        operation[11] = MemberEntries((memberA, signatureA), (memberB, signatureB));
        Assert.IsTrue(Validate(memberA, 8, digest, operation), "the generation-1 signature approves");

        _h.BumpModuleGeneration(_account, memberA);
        Assert.AreEqual(generationA + 1, _h.DescriptorInteger(_account, memberA, 8), "the generation advanced");
        Assert.IsFalse(Validate(memberA, 8, digest, operation),
            "the generation-1 member approval is dead");

        byte[] renewed = first.SignDigest(Sha256(ModuleHarness.ThresholdMemberPreimage(digest, memberA,
            _h.DescriptorInteger(_account, memberA, 8))));
        operation[11] = MemberEntries((memberA, renewed), (memberB, signatureB));
        Assert.IsTrue(Validate(memberA, 8, digest, operation),
            "the client re-derives D_i from the new generation and approves");
    }

    [TestMethod]
    public void ThresholdMember_NeverApprovesAsTheRoutedValidator()
    {
        _h.DeployValidator("MultiSigValidator");
        using P256Key memberKey = new();
        BigInteger member = Install("MultiSigValidator", "setMemberKey", memberKey.CompressedPublicKey);

        // validatorId == moduleId is the standalone route, which a policy member
        // must never answer: one member key cannot stand in for the policy.
        object?[] operation = Operation(NativeContract.GAS.Hash, "symbol", member, BigInteger.One, 11);
        byte[] digest = Digest(operation);
        byte[] memberDigest = Sha256(ModuleHarness.ThresholdMemberPreimage(digest, member, BigInteger.One));

        operation[11] = memberKey.SignDigest(memberDigest);
        Assert.IsFalse(Validate(member, 1, digest, operation), "a member is never its own routed validator");

        operation[11] = memberKey.SignDigest(digest);
        Assert.IsFalse(Validate(member, 1, digest, operation), "not even over the operation digest");
    }
}
