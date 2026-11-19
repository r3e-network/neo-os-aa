# EIP-712 Typed-Data Specification

Canonical reference for the EIP-712-style signing surface the V3 verifiers
hash and check on-chain. The byte-level source of truth is
`contracts/plugins/verifiers/Web3AuthVerifier.cs`; the SDK mirrors it in
`shared/metaTxCore.mjs` (typed-data shape) and `sdk/js/src/metaTx.js`
(byte-exact payload builders). Where the layout intentionally deviates from
strict EIP-712 the deviation is listed in [Deviations](#deviations-from-strict-eip-712).

## Domain separator

Type string:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
```

| Field | Value |
| --- | --- |
| `name` | `"Neo Smart Account"` (the wire constant the deployed verifier hashes; switched from `"Neo N3 Abstract Account"` in the SA protocol-string switch — pre-switch-domain signatures cut off at that switch) |
| `version` | `"1"` |
| `chainId` | the Neo network magic (`Runtime.GetNetwork()`), e.g. `860833102` MainNet |
| `verifyingContract` | the **verifier** contract hash (the contract executing `validateSignature`), 20 bytes |

Encoding (`Web3AuthVerifier.BuildDomainSeparator`):

```
domainSeparator = keccak256(
    EIP712_DOMAIN_TYPE_HASH ||
    keccak256("Neo Smart Account") ||
    keccak256("1") ||
    ToUint256Word(chainId) ||          // 32-byte big-endian word
    ToAddressWord(verifyingContract)   // 12 zero bytes || 20 big-endian bytes
)
```

`EIP712_DOMAIN_TYPE_HASH` is
`keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`
= `8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f`.

## UserOperation struct

Type string (V3):

```
UserOperation(bytes20 accountId,bytes20 coreContract,address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline)
```

`USER_OPERATION_TYPE_HASH` =
`keccak256("UserOperation(bytes20 accountId,bytes20 coreContract,address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline)")`
= `577a3a6bd91683e300e814cd25ff6247ab7ca273ddd0153a99919d72ddf9fa04`.

Field encoding (`Web3AuthVerifier.BuildMetaTxStructHash`):

| Field | Word encoding |
| --- | --- |
| `accountId` | `ToBytes20Word`: the 20-byte hash in **big-endian display order**, **right**-padded with 12 zero bytes |
| `coreContract` | same `ToBytes20Word` of the authorized SA core hash (the verifier's bound core) |
| `targetContract` | `ToAddressWord`: 12 zero bytes then the 20 bytes big-endian (standard `address` padding) |
| `method` | `keccak256(utf8(method))` — identical to the EIP-712 `string` encoding |
| `argsHash` | `keccak256(StdLib.Serialize(op.Args))` computed by the core (`computeArgsHash`); the serialization is the NeoVM binary stack-item format, not EVM ABI |
| `nonce` | `uint256` big-endian 32-byte word |
| `deadline` | `uint256` big-endian 32-byte word (Neo `Runtime.Time` milliseconds) |

```
structHash = keccak256(
    USER_OPERATION_TYPE_HASH ||
    ToBytes20Word(accountId) ||
    ToBytes20Word(coreContract) ||
    ToAddressWord(targetContract) ||
    keccak256(utf8(method)) ||
    argsHash ||
    ToUint256Word(nonce) ||
    ToUint256Word(deadline)
)
```

## Signing payload and signature

```
payload = 0x19 || 0x01 || domainSeparator || structHash   // 66 bytes
digest  = keccak256(payload)
```

- The digest is signed with **secp256k1 ECDSA**; there is **no EIP-191
  personal-message prefix** — the 0x1901 prefix is the only envelope.
- The on-chain signature is the compact 64-byte `r || s` form (no `v`).
  `Web3AuthVerifier.validateSignature` asserts exactly 64 bytes.
- `nonce` and `deadline` must satisfy `0 <= value < 2^255` (the NeoVM signed
  `Integer` domain); the SDK builders reject out-of-domain values.
- The account id is registration-bound: `computeRegistrationAccountId`
  commits to the verifier, its params, the hook, the backup owner and the
  escape timelock, so a signature for one configuration cannot be replayed
  against another.

## Deviations from strict EIP-712

1. `bytes20` is not an EIP-712 atom. The layout treats it as a 32-byte word
   holding the 20 hash bytes big-endian **right**-padded (zeros on the
   right), whereas EIP-712 `address` left-pads. Only `accountId` and
   `coreContract` use it; `targetContract` follows the standard left-padded
   `address` encoding.
2. `argsHash` commits to the NeoVM `StdLib.Serialize` byte form of the
   argument list. Cross-language signers must reproduce that serialization
   exactly or obtain the hash from the core's `computeArgsHash` read.
3. `chainId` carries the Neo **network magic**, not an EVM chain id.

These deviations are deliberate: the payload is produced and verified inside
one chain's VM, and wallet-side signing is served by the byte-exact builders
below rather than by a generic EIP-712 implementation.

## SDK builders

- `buildUserOperationTypedData(options)` — wallet/display-facing typed data
  (domain + types + message) for the layout above.
- `buildUserOperationSigningPayload(options)` — the complete 66-byte
  `0x1901`-enveloped payload ready for a raw secp256k1 signer. The domain
  separator and the struct hash are `ethers.TypedDataEncoder` outputs inside
  that payload: the v4 SDK exposes the payload and its digest, not the two
  intermediate hashes as separate builders.
- `buildUserOperationSigningDigest(options)` — `keccak256` of that payload:
  the 32 bytes a raw secp256k1 signer signs.
- `SmartAccountClient.computeArgsHash(args)` — asks the core for the
  canonical `argsHash` instead of re-implementing the serialization.

A golden-vector test (`sdk/js/tests/flow.unit.test.js`, "EIP-712 typed
data hash matches expected test vector") pins the byte layout end to end.
