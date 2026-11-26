# SigningModule (spec §8, §14)

The only public message-signature entry of a SmartAccount account.

The native core has no `isValidSignature` and publishes no message domain
(spec §8). This module owns both: the message domain, the subject roster, the
quorum, and the generation and epoch binding. It is read-only — it never
writes, never approves an operation and never faults for a caller.

## Surface

| ABI | Returns | Authority |
| --- | --- | --- |
| `isValidSignature(accountId, originalSender, validatorId, generation, hash, pairs)` | `Boolean` | public, read-only (`[Safe]`) |
| `validateMessageSignature(accountId, originalSender, validatorId, generation, hash, pairs)` | `ByteString` 4-byte ERC-1271 magic | public, read-only (`[Safe]`) |
| `getMessagePolicy(accountId, moduleId)` | `Array [subjects[], threshold, revision, generation]`, or empty | read-only |
| `configure(accountId, moduleId, moduleType, configData)` | `Void` | core only, configuration frame only |
| `getModuleProfile()` | `String` profile JSON | read-only |
| `authorizedCore()` | `Hash160` | read-only |
| `setAuthorizedCore(coreContract)` | `Void` | deployer, once |
| `onInstall(accountId, moduleId, moduleType, initData)` | `Void` | core only; `initData` must be `[]` |
| `onUninstall(accountId, moduleId, moduleType, deInitData)` | `Void` | core only |
| `validateUserOp(accountId, operationDigest, operation)` | `Boolean` | core only, read-only; always `false` |
| `onUserOpComplete(accountId, operation, result)` | `Void` | core only |

The module is installed as a validator-type instance (module type 1) whose
profile declares `messageCapability: true` and `instanceIsolation: true`. The
core routes message validation to it by that capability; the routing callback
never approves spending.

## Policy

`configData` is `[subjects[], threshold]`: 1–16 distinct subjects and
`1 ≤ threshold ≤ subjects`. A subject identifies a canonical P-256
verification script by its raw HASH160 (20 bytes, `RIPEMD160(SHA256(script))`)
or its SHA-256 (32 bytes). A compressed public key is not a subject. The write
records the instance's current credential generation and bumps the revision.

## Message verification

`pairs` is a flat array `[canonicalScript0, signature0, canonicalScript1,
signature1, …]`. Every element must be a `ByteString`; every script must be the
40-byte canonical P-256 form (`PUSHDATA1 0x21 ‖ 0x02/0x03 ‖ X32 ‖ SYSCALL
CheckSig`); every signature must be 64 bytes; a repeated script is refused.

The signed bytes are the §8 digest:

```
SHA-256( "NeoSmartAccount/Message" ‖ 0x04 ‖ U32LE(network) ‖ coreHash ‖
         accountId ‖ originalSender ‖ U64BE(validatorId) ‖ U64BE(generation) ‖
         U64BE(epoch) ‖ hash )
```

The module binds the account, the original sender, the validator instance, its
live credential generation and the account's authority epoch, and answers
`true` only when at least `threshold` distinct rostered subjects produced a
valid signature over that digest.

**Exactly one SHA-256 separates the signed bytes from the curve.** Neo's
`verifyWithECDsa` always hashes its message argument once before verifying and
has no raw-digest entry (see [Shared/P256.cs](../Shared/P256.cs)). The module
therefore hands the platform the *preimage* of the §8 digest, so the platform's
own hash step is the §8 hash and no second hash is applied. A signature over
`SHA-256(digest)` is refused — that negative vector is pinned in the tests, as
is the published RFC 6979 §A.2.5 vector for the positive path.

Every failure is a plain `false`: invalid magic, wrong domain, unknown or
inactive account, unbound or replaced validator instance, stale generation or
epoch, malformed script or signature, non-rostered subject, repeated subject,
below quorum. `validateMessageSignature` maps that boolean to `1626ba7e`
(valid) or `ffffffff` (invalid) and never faults, which is the ERC-1271
contract.

## Storage

```
0x01 ‖ accountId ‖ moduleId   → serialized [subjects[], threshold, revision, generation]
```

The prefix is deleted by `onUninstall`. Nothing else is written by this module.

## Notes for integrators

* A verifier calls this contract directly; forwarding the call through another
  contract changes the signed original sender and the answer.
* A registered account without a configured roster has no message policy and
  refuses every signature; there is no implicit custody fallback.
* The core pins no digest of this artifact: the module is bound by its code
  binding and its roster, both checked on every call.
