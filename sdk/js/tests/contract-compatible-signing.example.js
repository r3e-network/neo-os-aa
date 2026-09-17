/**
 * Example: Using the contract-compatible EIP-712 signing flow
 *
 * This demonstrates how to sign a UserOperation that will be verified
 * by the Web3AuthVerifier contract on Neo N3.
 */

const { ethers } = require('ethers');
const {
  sanitizeHex,
  buildContractCompatibleStructHash,
  buildContractCompatibleDomainSeparator,
  buildWeb3AuthSigningPayload,
} = require('../src/metaTx');

async function signUserOperation() {
  // 1. Create an EVM wallet (e.g., from Web3Auth)
  const evmWallet = new ethers.Wallet('YOUR_PRIVATE_KEY');
  console.log('EVM Address:', evmWallet.address);

  // 2. Define your UserOperation parameters.
  // All Hash160 values are big-endian display hex — the SDK performs no
  // client-side byte reversal.
  const userOpParams = {
    chainId: 860833102, // Neo testnet magic
    verifierHash: '0xYOUR_VERIFIER_HASH_40_CHARS',
    accountIdHash: '0xYOUR_ACCOUNT_ID_40_CHARS',
    coreContractHash: '0xYOUR_AA_CORE_HASH_40_CHARS',
    targetContract: '0xYOUR_TARGET_CONTRACT_40_CHARS',
    method: 'transfer',
    argsHash: '0xCOMPUTED_ARGS_HASH_64_CHARS',
    nonce: 0n,
    deadline: BigInt(Date.now() + 3600_000), // 1 hour from now
  };

  // 3. Compute the struct hash (matches contract's BuildMetaTxStructHash)
  const structHash = buildContractCompatibleStructHash(userOpParams);
  console.log('Struct hash:', structHash);

  // 4. Compute the domain separator (matches contract's BuildDomainSeparator)
  const domainSeparator = buildContractCompatibleDomainSeparator(
    userOpParams.chainId,
    userOpParams.verifierHash
  );
  console.log('Domain separator:', domainSeparator);

  // 5. Create the signing payload (0x1901 || domainSeparator || structHash)
  const signingPayload = buildWeb3AuthSigningPayload(userOpParams);
  console.log('Signing payload length:', signingPayload.length, 'bytes (expected: 66)');

  // 6. Sign the raw keccak256 digest of the payload.
  // The contract verifies with CryptoLib.VerifyWithECDsa(payload, ...,
  // secp256k1Keccak256), i.e. keccak256 over the RAW payload with NO
  // EIP-191 prefix — do NOT use ethers.Wallet.signMessage here (it wraps
  // with "\x19Ethereum Signed Message:\n" and the contract will reject it).
  const signingDigest = ethers.keccak256(signingPayload);
  const sig = evmWallet.signingKey.sign(signingDigest);

  // The contract asserts Signature.Length == 64: r (32 bytes) || s (32 bytes),
  // no recovery byte v.
  const signature = sanitizeHex(sig.r) + sanitizeHex(sig.s);
  console.log('Signature (64 bytes r||s):', signature);

  // 7. Create the final UserOperation
  const userOperation = {
    TargetContract: userOpParams.targetContract,
    Method: userOpParams.method,
    Args: [], // Your actual args here
    Nonce: userOpParams.nonce,
    Deadline: userOpParams.deadline,
    Signature: signature,
  };

  console.log('UserOperation:', userOperation);

  // 8. Submit to the contract
  // The contract will reconstruct the struct hash and verify the signature
  // using the stored EVM public key

  return userOperation;
}

// Key Differences from Standard EIP-712
console.log(`
=== Key Differences from Standard EIP-712 ===

1. Raw keccak256 of method string
   - Contract: keccak256(method_utf8_bytes)
   - Standard: keccak256(abiEncode(string))

2. Raw ECDSA over keccak256(payload), no EIP-191 prefix
   - Contract: CryptoLib.VerifyWithECDsa(payload, pubKey, sig, secp256k1Keccak256)
   - Standard wallets: personal_sign/signMessage adds "\\x19Ethereum Signed Message:\\n"
   - Use wallet.signingKey.sign(keccak256(payload)) instead of signMessage

3. 64-byte signature (r||s)
   - Contract: asserts Signature.Length == 64 — strip the recovery byte v
   - Standard: 65-byte signatures include v

4. No client-side byte reversal for Hash160 values
   - Inputs are big-endian display hex; the contract's ToBytes20Word /
     ToAddressWord reverse its internal little-endian UInt160 form to the
     same big-endian bytes, so both sides already agree

5. Big-endian uint256 encoding for nonce/deadline
   - Matches standard EIP-712 word encoding
`);

// Uncomment to run:
// signUserOperation().catch(console.error);

module.exports = { signUserOperation };
