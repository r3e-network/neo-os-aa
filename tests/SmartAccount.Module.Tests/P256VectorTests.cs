using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Native;
using Neo.SmartContract.Testing.Exceptions;
using System.Security.Cryptography;
using System.Text;

namespace SmartAccount.Module.Tests;

/// <summary>
/// P-256 evidence for the message path (SA-SPEC §8/§14, platform-first rule).
///
/// Two independent facts are proven here:
///
///   1. the message path carries no local curve or hash implementation — the
///      deployed NEF declares a method token for the platform's
///      <c>verifyWithECDsa</c> entry on the CryptoLib native contract, and
///      <c>P256.cs</c> contains nothing but shape checks around that call;
///   2. that platform call accepts a genuine signature over the published
///      RFC 6979 §A.2.5 vector and refuses a signature over the digest of the
///      same bytes, which is what "prehashed, no implicit re-hash" means.
///
/// The vector is driven through <c>TestHook.verifyP256</c>, which compiles the
/// production <c>Shared/P256.cs</c> verbatim — so the code under test here is
/// byte-for-byte the code the standard modules deploy.
/// </summary>
[TestClass]
public class P256VectorTests
{
    // RFC 6979 §A.2.5, P-256 with SHA-256, message "sample".
    private const string PublicKeyX = "60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6";
    private const string PublicKeyY = "7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299";
    private const string SignatureR = "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716";
    private const string SignatureS = "F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8";
    private const string SampleDigest = "AF2BDBE1AA9B6EC1E2ADE1D694F41FC71A831D0268E9891562113D8A62ADD1BF";

    private static readonly byte[] Preimage = Encoding.UTF8.GetBytes("sample");

    private static byte[] CompressedPoint()
    {
        // Y is odd, so the compressed form carries the 0x03 prefix.
        byte[] point = new byte[33];
        point[0] = 0x03;
        System.Array.Copy(Convert.FromHexString(PublicKeyX), 0, point, 1, 32);
        return point;
    }

    private static byte[] UncompressedPoint()
    {
        byte[] point = new byte[65];
        point[0] = 0x04;
        System.Array.Copy(Convert.FromHexString(PublicKeyX), 0, point, 1, 32);
        System.Array.Copy(Convert.FromHexString(PublicKeyY), 0, point, 33, 32);
        return point;
    }

    private static byte[] Signature() =>
        Convert.FromHexString(SignatureR + SignatureS);

    // ---- 1. the deployed code calls the platform entry ----

    [TestMethod]
    public void DeployedMessagePath_DeclaresThePlatformCryptoLibEntry()
    {
        NefFile nef = ModuleHarness.ModuleNef("SigningModule");

        MethodToken? p256 = null;
        foreach (MethodToken token in nef.Tokens)
            if (token.Method == "verifyWithECDsa") p256 = token;

        Assert.IsNotNull(p256, "the message path must carry a verifyWithECDsa method token");
        Assert.AreEqual(NativeContract.CryptoLib.Hash, p256!.Hash,
            "the token must target the CryptoLib native contract, not another contract");
        Assert.IsTrue(p256.ParametersCount >= 4, "the token carries message, key, signature and curve");
        Assert.IsTrue(p256.HasReturnValue, "the entry answers with a boolean");
    }

    // ---- 2. the platform path verifies the published vector ----

    [TestMethod]
    public void VerifyP256_AcceptsThePublishedRfc6979Vector()
    {
        // Premise of the vector: the signed digest is SHA-256("sample").
        Assert.AreEqual(SampleDigest, Convert.ToHexString(SHA256.HashData(Preimage)),
            "the pinned vector is the RFC 6979 §A.2.5 sample digest");

        using ModuleHarness harness = new();
        Assert.IsTrue(harness.CallBoolean(harness.TestHook, "verifyP256",
                Preimage, CompressedPoint(), Signature()),
            "the platform CryptoLib path accepts the published P-256 signature");
    }

    [TestMethod]
    public void VerifyP256_RefusesAnUncompressedKey()
    {
        using ModuleHarness harness = new();

        // The platform's ECPoint primitive is a 33-byte compressed key and
        // nothing else; the same key in 65-byte form is not a shape this path
        // accepts, and the refusal is a plain false rather than a fault.
        Assert.IsFalse(harness.CallBoolean(harness.TestHook, "verifyP256",
                Preimage, UncompressedPoint(), Signature()),
            "only the platform's 33-byte compressed key shape is accepted");
    }

    [TestMethod]
    public void VerifyP256_RefusesASignatureOverTheDigestInsteadOfThePreimage()
    {
        using ModuleHarness harness = new();
        byte[] digest = SHA256.HashData(Preimage);

        // Handing the digest to the platform would hash it a second time; the
        // signature it then checks is over SHA-256(SHA-256("sample")), which
        // nobody signed. This is the negative vector the spec demands.
        Assert.IsFalse(harness.CallBoolean(harness.TestHook, "verifyP256",
                digest, CompressedPoint(), Signature()),
            "a double-hashed message must not verify");
    }

    // ---- 3. malformed input is a plain false ----

    [TestMethod]
    public void VerifyP256_RefusesAKeyThatIsNotTheRosteredOne()
    {
        using ModuleHarness harness = new();

        // Flipping the compression prefix of a compressed key yields the
        // negation of the point, which is still a valid P-256 key. It is simply
        // not the key that signed, so the answer is false — and because the
        // platform can decode it, this case stays a boolean, unlike an
        // undecodable key.
        byte[] negated = (byte[])CompressedPoint().Clone();
        negated[0] = 0x02;

        Assert.IsFalse(harness.CallBoolean(harness.TestHook, "verifyP256",
                Preimage, negated, Signature()),
            "a well-formed key that did not sign is refused");
    }

    [TestMethod]
    public void VerifyP256_AnswersFalseForMalformedInput()
    {
        using ModuleHarness harness = new();
        UInt160 hook = harness.TestHook;
        byte[] point = CompressedPoint();
        byte[] signature = Signature();

        byte[] tamperedSignature = (byte[])signature.Clone();
        tamperedSignature[0] ^= 0x01;

        Assert.IsFalse(harness.CallBoolean(hook, "verifyP256", Preimage, point,
            new byte[63]), "a 63-byte signature");
        Assert.IsFalse(harness.CallBoolean(hook, "verifyP256", Preimage, point,
            new byte[65]), "a 65-byte signature");
        Assert.IsFalse(harness.CallBoolean(hook, "verifyP256", Preimage, point,
            tamperedSignature), "a tampered signature");
        Assert.IsFalse(harness.CallBoolean(hook, "verifyP256", Preimage, new byte[33],
            signature), "an all-zero key is not the 0x02/0x03 key shape");
        Assert.IsFalse(harness.CallBoolean(hook, "verifyP256", Preimage, new byte[31],
            signature), "a 31-byte public key");
        Assert.IsFalse(harness.CallBoolean(hook, "verifyP256", new byte[0], point,
            signature), "an empty preimage");
        Assert.IsFalse(harness.CallBoolean(hook, "verifyP256",
            Encoding.UTF8.GetBytes("samplf"), point, signature), "a different message");
    }

    /// <summary>
    /// Documented platform boundary, not desired behaviour. Neo's
    /// <c>verifyWithECDsa</c> faults when the key cannot be decoded, and a
    /// contract cannot catch a fault raised inside another contract, so no
    /// wrapper can turn this case into a boolean without re-implementing the
    /// curve. The pin exists so the limitation stays visible and testable: if a
    /// future platform release starts answering <c>false</c> instead, this test
    /// fails and the documentation is updated with it.
    /// </summary>
    [TestMethod]
    public void VerifyP256_UndecodableKeyFaultsInsideThePlatform()
    {
        using ModuleHarness harness = new();
        byte[] offCurve = new byte[33];
        offCurve[0] = 0x02;
        for (int i = 1; i < offCurve.Length; i++) offCurve[i] = 0xFF;

        Assert.ThrowsExactly<TestException>(() => harness.CallBoolean(harness.TestHook,
            "verifyP256", Preimage, offCurve, Signature()));
    }
}
